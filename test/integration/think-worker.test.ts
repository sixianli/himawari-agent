import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
} from "@himawari-agent/domain";
import {
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ThinkWorthDecision } from "@himawari-agent/platform-node";
import { ProductionThinkInbox } from "../../apps/agent-service/src/production-think-inbox.ts";
import {
  ProductionThinkWorker,
  type ThinkRunner,
} from "../../apps/agent-service/src/production-think-worker.ts";
import { copyMigratedDatabase } from "../fixtures/sqlite-migrated-template.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-think-worker");
const AGENT_ID = createAgentId("agent-think-worker");
const DEPLOYMENT_ID = createDeploymentId("deployment-think-worker");
const START = "2026-11-14T00:00:00.000Z";

describe("think worker", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  let server: Server | undefined;
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function jev(worth: () => { status: number; worth?: number }) {
    const seen: Record<string, unknown>[] = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        const result = worth();
        response.writeHead(result.status, { "content-type": "application/json" });
        const probability = result.worth ?? 0;
        response.end(
          JSON.stringify({
            model: "typesafe-ai/jev",
            answers: [
              {
                type: "choice",
                name: "think_worth",
                choice: probability >= 0.5 ? "worth" : "not_worth",
                confidence: Math.max(probability, 1 - probability),
                probabilities: [
                  { value: "worth", probability },
                  { value: "not_worth", probability: 1 - probability },
                ],
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return { seen, baseUrl: `http://127.0.0.1:${(server?.address() as AddressInfo).port}/v1` };
  }

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-think-worker-"));
    directories.push(stateRoot);
    await mkdir(path.join(stateRoot, "data"));
    const file = path.join(stateRoot, "data", "product.sqlite");
    await copyMigratedDatabase(file);
    const database = openQualifiedDatabase(file);
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database
      .prepare(
        `INSERT INTO deployments
        (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
        VALUES (?, ?, ?, 0, 'active', 1, 1)`,
      )
      .run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID);
    database
      .prepare(
        `INSERT INTO authority_leases
        (id, owner_id, agent_id, deployment_id, holder_id, authority_epoch, fencing_token,
          acquired_at, expires_at)
        VALUES (?, ?, ?, ?, 'holder-think-worker', 1, 1, ?, '2026-11-15T00:00:00.000Z')`,
      )
      .run(createAuthorityLeaseId("lease-think-worker"), OWNER_ID, AGENT_ID, DEPLOYMENT_ID, START);
    database.close();
    const clock = { value: START };
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      databasePath: file,
      minimumFreeBytes: 0,
      now: () => clock.value,
    });
    closers.push(() => repository.close());
    const adapters = createReferenceAdapterSet();
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
    const store = repository.thinkInbox();
    const inbox = new ProductionThinkInbox({
      scope,
      store,
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => clock.value },
      timeZone: "Asia/Tokyo",
    });
    inbox.sources.register({ kind: "email", describe: "新邮件", externalContent: true });
    const runs: { summary: string; external: boolean }[] = [];
    const runner = (impl?: ThinkRunner["think"]): ThinkRunner => ({
      think:
        impl ??
        (async ({ entry, summary }) => {
          runs.push({ summary, external: entry.externalContent });
          return { outcome: "proposed", reasonCode: "proposal_written" };
        }),
    });
    const worker = (baseUrl: string, think: ThinkRunner, runTimeoutMs = 5000, extra = {}) =>
      new ProductionThinkWorker({
        scope,
        inbox,
        store,
        payloads,
        protector: adapters.payloadProtector,
        clock: { now: () => clock.value },
        worth: {
          port: new ThinkWorthDecision({
            model: "typesafe-ai/jev",
            apiKey: async () => "key",
            baseUrl,
          }),
        },
        runner: think,
        runTimeoutMs,
        ...extra,
      });
    return { inbox, store, payloads, runs, runner, worker, usage: () => inbox.usage() };
  }

  const mail = (ref: string) => ({
    sourceKind: "email",
    sourceRef: ref,
    sourceVersion: "1",
    summary: `邮件 ${ref}：房东请在 11 月 20 日前回复是否续租`,
  });

  it("hands a worth-thinking entry to the runner with its summary and outside-content flag, then records the result", async () => {
    const { inbox, runs, runner, worker, usage } = await fixture();
    const stub = await jev(() => ({ status: 200, worth: 0.93 }));
    await inbox.submit(mail("a"));
    const step = await worker(stub.baseUrl, runner()).runOnce();
    expect(step).toMatchObject({
      status: "done",
      outcome: "proposed",
      reasonCode: "proposal_written",
    });
    expect(runs).toEqual([{ summary: mail("a").summary, external: true }]);
    expect((await usage()).byStatus).toEqual({ proposed: 1 });
    expect(JSON.stringify(stub.seen[0])).toContain("zeroDataRetention");
  });

  it("does not start a run when the judgment says no or is unsure", async () => {
    const { inbox, runs, runner, worker, usage } = await fixture();
    let worth = 0.1;
    const stub = await jev(() => ({ status: 200, worth }));
    await inbox.submit(mail("a"));
    await inbox.submit(mail("b"));
    const run = worker(stub.baseUrl, runner());
    expect(await run.runOnce()).toMatchObject({ outcome: "skipped", reasonCode: "worth_no" });
    worth = 0.5;
    expect(await run.runOnce()).toMatchObject({ outcome: "skipped", reasonCode: "worth_unsure" });
    expect(runs).toEqual([]);
    expect((await usage()).byStatus).toEqual({ skipped: 2 });
  });

  it("fails closed when the judgment service is down: no run, entry marked failed", async () => {
    const { inbox, runs, runner, worker, usage } = await fixture();
    const stub = await jev(() => ({ status: 503 }));
    await inbox.submit(mail("a"));
    expect(await worker(stub.baseUrl, runner()).runOnce()).toMatchObject({
      outcome: "failed",
      reasonCode: "worth_unavailable",
    });
    expect(runs).toEqual([]);
    expect((await usage()).byStatus).toEqual({ failed: 1 });
  });

  it("marks the entry failed when the runner throws, and stays idle when nothing is queued", async () => {
    const { inbox, runner, worker } = await fixture();
    const stub = await jev(() => ({ status: 200, worth: 0.95 }));
    const run = worker(
      stub.baseUrl,
      runner(async () => {
        throw new Error("boom");
      }),
    );
    expect(await run.runOnce()).toEqual({ status: "idle" });
    await inbox.submit(mail("a"));
    expect(await run.runOnce()).toMatchObject({ outcome: "failed", reasonCode: "think_failed" });
    expect(await run.runOnce()).toEqual({ status: "idle" });
  });

  it("still times the runner out when the caller passes a long-lived signal", async () => {
    const { inbox, runner, worker } = await fixture();
    const stub = await jev(() => ({ status: 200, worth: 0.95 }));
    let runnerSignal: AbortSignal | undefined;
    const run = worker(
      stub.baseUrl,
      runner(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            runnerSignal = signal;
            signal.addEventListener("abort", () => reject(new Error("timed out")));
          }),
      ),
      50,
    );
    await inbox.submit(mail("a"));
    const longLived = new AbortController();
    expect(await run.runOnce(longLived.signal)).toMatchObject({
      outcome: "failed",
      reasonCode: "think_failed",
    });
    expect(runnerSignal?.aborted).toBe(true);
    expect(longLived.signal.aborted).toBe(false);
  });

  it("leaves the entry in thinking for recovery when the caller cancels", async () => {
    const { inbox, runner, worker, usage } = await fixture();
    const stub = await jev(() => ({ status: 200, worth: 0.95 }));
    const controller = new AbortController();
    const run = worker(
      stub.baseUrl,
      runner(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("cancelled")));
            controller.abort();
          }),
      ),
    );
    await inbox.submit(mail("a"));
    expect(await run.runOnce(controller.signal)).toMatchObject({ status: "aborted" });
    expect((await usage()).byStatus).toEqual({ thinking: 1 });
  });

  it("does not claim an entry when the caller has already cancelled", async () => {
    const { inbox, runner, worker, usage } = await fixture();
    const stub = await jev(() => ({ status: 200, worth: 0.95 }));
    await inbox.submit(mail("a"));
    const step = await worker(stub.baseUrl, runner()).runOnce(AbortSignal.abort());
    expect(step).toEqual({ status: "aborted" });
    expect((await usage()).byStatus).toEqual({ queued: 1 });
  });

  it("reports an unsettled entry and survives a throwing failure observer", async () => {
    const { inbox, store, runner, worker, usage } = await fixture();
    const stub = await jev(() => ({ status: 200, worth: 0.95 }));
    await inbox.submit(mail("a"));
    const finish = () => Promise.reject(new Error("disk"));
    const step = await worker(stub.baseUrl, runner(), 5000, {
      store: { ...store, claimNext: store.claimNext.bind(store), finish },
      onFailure: () => {
        throw new Error("observer");
      },
    }).runOnce();
    expect(step).toMatchObject({ status: "unsettled" });
    expect((await usage()).byStatus).toEqual({ thinking: 1 });
  });

  it("shortens an over-long runner reason code instead of failing the settled run", async () => {
    const { inbox, runner, worker, usage } = await fixture();
    const stub = await jev(() => ({ status: 200, worth: 0.95 }));
    const run = worker(
      stub.baseUrl,
      runner(async () => ({ outcome: "skipped", reasonCode: "x".repeat(100) })),
    );
    await inbox.submit(mail("a"));
    expect(await run.runOnce()).toMatchObject({ outcome: "skipped" });
    expect((await usage()).byStatus).toEqual({ skipped: 1 });
  });
});
