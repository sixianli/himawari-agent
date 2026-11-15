import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
} from "@himawari-agent/domain";
import { gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import {
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { ThinkWorthDecision } from "@himawari-agent/platform-node";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionThinkInbox } from "../../apps/agent-service/src/production-think-inbox.ts";
import {
  ProductionThinkControl,
  ProductionThinkSettings,
} from "../../apps/agent-service/src/production-think-settings.ts";
import {
  ProductionThinkWorker,
  type ThinkRunner,
} from "../../apps/agent-service/src/production-think-worker.ts";
import { copyMigratedDatabase } from "../fixtures/sqlite-migrated-template.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-think-settings");
const AGENT_ID = createAgentId("agent-think-settings");
const DEPLOYMENT_ID = createDeploymentId("deployment-think-settings");
const START = "2026-11-14T00:00:00.000Z";

describe("think settings", () => {
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

  async function fixture(configured: Record<string, unknown> = {}) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-think-settings-"));
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
        VALUES (?, ?, ?, ?, 'holder-think-settings', 1, 1, ?, '2026-11-15T00:00:00.000Z')`,
      )
      .run(
        createAuthorityLeaseId("lease-think-settings"),
        OWNER_ID,
        AGENT_ID,
        DEPLOYMENT_ID,
        START,
      );
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
    const settings = new ProductionThinkSettings({
      scope,
      store,
      configuration: configured as never,
      clock: { now: () => clock.value },
    });
    const control = new ProductionThinkControl({
      settings,
      scope,
      clock: { now: () => clock.value },
    });
    const inbox = new ProductionThinkInbox({
      overrides: () => settings.overrides(),
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
        overrides: () => settings.overrides(),
        ...extra,
      });
    return { inbox, settings, control, runs, runner, worker, clock };
  }

  const mail = (ref: string) => ({
    sourceKind: "email",
    sourceRef: ref,
    sourceVersion: "1",
    summary: `邮件 ${ref}：房东请在 11 月 20 日前回复是否续租`,
  });
  const head = {
    schemaVersion: "gateway.v2",
    kind: "query",
    type: "think.settings.read",
    messageId: "message-read",
    correlationId: "correlation-read",
    causationId: null,
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
    authority: { deploymentId: DEPLOYMENT_ID, authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "owner", actorId: OWNER_ID },
    payload: {},
  };
  const change = (expectedRevision: number, key: string, value: number | null) =>
    ({
      ...head,
      kind: "command",
      type: "think.settings.change",
      messageId: `message-${key}-${value}`,
      payload: { expectedRevision, key, value },
    }) as never;
  const failure = async (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: { message?: string }) => error.message,
    );

  it("shows every limit with its value, default and range, in a fixed order", async () => {
    const { control } = await fixture({ queueLimit: 5, worth: { yesAtLeastPermille: 800 } });
    const snapshot = (await control.query(head as never)) as unknown as {
      type: string;
      payload: {
        revision: number;
        enabled: boolean;
        items: { key: string; value: number; defaultValue: number; overridden: boolean }[];
      };
    };
    expect(snapshot.type).toBe("think.settings.snapshot");
    expect(() => gatewayV2MessageSchema.parse(JSON.parse(JSON.stringify(snapshot)))).not.toThrow();
    expect(snapshot.payload.revision).toBe(0);
    expect(snapshot.payload.enabled).toBe(true);
    expect(snapshot.payload.items.map((item) => item.key)).toEqual([
      "yesAtLeastPermille",
      "noAtMostPermille",
      "queueLimit",
      "dailyLimit",
      "expiresAfterHours",
      "stalledAfterMinutes",
      "maxAttempts",
      "summaryCharacters",
      "idleSeconds",
      "runTimeoutMinutes",
      "threadRetentionDays",
    ]);
    expect(snapshot.payload.items[10]).toMatchObject({
      value: 7,
      minimum: 1,
      maximum: 90,
      unit: "days",
      kind: "duration",
      storageUnit: "d",
      unitLabel: { "zh-CN": "天", en: "days", ja: "日" },
    });
    expect(snapshot.payload.items[0]).toMatchObject({ kind: "ratio", storageUnit: "permille" });
    expect(snapshot.payload.items[2]).toMatchObject({ kind: "count", storageUnit: "count" });
    expect(snapshot.payload.items[6]).toMatchObject({ kind: "count", storageUnit: "count" });
    expect(snapshot.payload.items[0]).toMatchObject({
      value: 800,
      defaultValue: 800,
      minimum: 501,
      maximum: 1000,
      unit: "permille",
      overridden: false,
    });
    expect(snapshot.payload.items[2]).toMatchObject({ value: 5, defaultValue: 5 });
    for (const item of snapshot.payload.items as unknown as {
      label: Record<string, string>;
      description: Record<string, string>;
      unitLabel: Record<string, string>;
    }[])
      for (const text of [item.label, item.description, item.unitLabel])
        expect(Object.keys(text).sort()).toEqual(["en", "ja", "zh-CN"]);
    expect(snapshot.payload.items[2]).toMatchObject({
      label: { "zh-CN": "排队上限", en: "Queue limit", ja: "待ち行列の上限" },
      unitLabel: { "zh-CN": "件", en: "items", ja: "件" },
    });
    expect(snapshot.payload.items[6]).toMatchObject({
      key: "maxAttempts",
      unit: "times",
      label: { "zh-CN": "最多尝试次数", en: "Maximum attempts", ja: "最大試行回数" },
      unitLabel: { "zh-CN": "次", en: "times", ja: "回" },
    });
    expect(snapshot.payload.items[3]).toMatchObject({ value: 50, defaultValue: 50 });
    const off = await fixture();
    const plain = (await off.control.query(head as never)) as unknown as {
      payload: { enabled: boolean };
    };
    expect(plain.payload.enabled).toBe(false);
  });

  it("saves a change, refuses stale, out-of-range, unknown and crossed values, and resets to default", async () => {
    const { control, settings } = await fixture();
    expect(await control.execute(change(0, "queueLimit", 7))).toEqual({
      resultRef: "think-settings:1",
      replayed: false,
    });
    expect((await settings.read()).items[2]).toMatchObject({ value: 7, overridden: true });
    expect(await failure(control.execute(change(0, "queueLimit", 8)))).toBe(
      "THINK_SETTINGS_CHANGED",
    );
    expect(await failure(control.execute(change(1, "queueLimit", 1001)))).toBe(
      "THINK_SETTING_OUT_OF_RANGE",
    );
    expect(await failure(control.execute(change(1, "queueLimit", 0)))).toBe(
      "THINK_SETTING_OUT_OF_RANGE",
    );
    expect(await failure(control.execute(change(1, "secretRef", 1)))).toBe("THINK_SETTING_UNKNOWN");
    await control.execute(change(1, "noAtMostPermille", 499));
    expect(await failure(control.execute(change(2, "yesAtLeastPermille", 501)))).toBeUndefined();
    expect(await failure(control.execute(change(3, "noAtMostPermille", 499)))).toBeUndefined();
    expect(await failure(control.execute(change(4, "noAtMostPermille", 300)))).toBeUndefined();
    expect(await failure(control.execute(change(5, "yesAtLeastPermille", 501)))).toBeUndefined();
    expect(await failure(control.execute(change(6, "queueLimit", null)))).toBeUndefined();
    const after = await settings.read();
    expect(after.revision).toBe(7);
    expect(after.items[2]).toMatchObject({ value: 20, overridden: false });
    expect(after.items[0]).toMatchObject({ value: 501, overridden: true });
  });

  it("keeps an unsure band between the thresholds through their ranges alone", async () => {
    const { control } = await fixture();
    await control.execute(change(0, "yesAtLeastPermille", 600));
    expect(await failure(control.execute(change(1, "noAtMostPermille", 499)))).toBeUndefined();
    const crossed = await fixture({ worth: { noAtMostPermille: 450 } });
    expect(await failure(crossed.control.execute(change(0, "yesAtLeastPermille", 450)))).toBe(
      "THINK_SETTING_OUT_OF_RANGE",
    );
    expect(await failure(crossed.control.execute(change(0, "yesAtLeastPermille", 501)))).toBe(
      undefined,
    );
    const tight = await fixture({ worth: { noAtMostPermille: 499 } });
    expect(await failure(tight.control.execute(change(0, "noAtMostPermille", 499)))).toBe(
      undefined,
    );
  });

  it("refuses a change from anyone but the owner", async () => {
    const { control } = await fixture();
    const outsider = {
      ...(change(0, "queueLimit", 7) as object),
      actor: { actorType: "client", actorId: "x" },
    };
    expect(await failure(control.execute(outsider as never))).toBe("THINK_OWNER_REQUIRED");
  });

  it("uses a changed queue limit on the next submit without a restart", async () => {
    const { control, inbox } = await fixture();
    await control.execute(change(0, "queueLimit", 1));
    expect(await inbox.submit(mail("a"))).toMatchObject({ accepted: true });
    expect(await inbox.submit(mail("b"))).toEqual({ accepted: false, reason: "THINK_QUEUE_FULL" });
  });

  it("uses a changed threshold on the next judgment: 93% is no longer enough at 95%", async () => {
    const { control, inbox, runs, runner, worker } = await fixture();
    const stub = await jev(() => ({ status: 200, worth: 0.93 }));
    await inbox.submit(mail("a"));
    await control.execute(change(0, "yesAtLeastPermille", 950));
    expect(await worker(stub.baseUrl, runner()).runOnce()).toMatchObject({
      outcome: "skipped",
      reasonCode: "worth_unsure",
    });
    expect(runs).toEqual([]);
  });

  it("lets only one of two changes made at the same revision through", async () => {
    const { control, settings } = await fixture();
    const results = await Promise.all([
      failure(control.execute(change(0, "queueLimit", 7))),
      failure(control.execute(change(0, "dailyLimit", 9))),
    ]);
    expect(results.toSorted()).toEqual(["THINK_SETTINGS_CHANGED", undefined].toSorted());
    const after = await settings.read();
    expect(after.revision).toBe(1);
    expect(after.items.filter((item) => item.overridden)).toHaveLength(1);
  });

  it("falls back to the configured limits when saved changes cannot be read", async () => {
    const { control, inbox } = await fixture();
    await control.execute(change(0, "queueLimit", 5));
    const broken = new ProductionThinkInbox({
      overrides: async () => {
        throw new Error("SQLITE_BUSY");
      },
      limits: { queueLimit: 1 },
    } as never);
    expect((await broken.currentLimits()).queueLimit).toBe(1);
    expect((await inbox.currentLimits()).queueLimit).toBe(5);
  });
});
