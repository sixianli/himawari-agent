import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type StoredThinkEntry,
  ThreadCommandService,
  type ThreadRepositoryPort,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import {
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionProposalBox } from "../../apps/agent-service/src/production-proposals.ts";
import { registerTaskProposalHandler } from "../../apps/agent-service/src/production-task-proposals.ts";
import { thinkActions } from "../../apps/agent-service/src/production-think-actions.ts";
import {
  isThinkRunSource,
  THINK_MESSAGE_PREFIX,
  ThreadThinkRunner,
} from "../../apps/agent-service/src/production-think-runner.ts";
import { copyMigratedDatabase } from "../fixtures/sqlite-migrated-template.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-think-runner");
const AGENT_ID = createAgentId("agent-think-runner");
const DEPLOYMENT_ID = createDeploymentId("deployment-think-runner");
const AUTHORITY: ProductAuthorityFence = {
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: 1,
  fencingToken: 1,
};
const START = "2026-11-14T00:00:00.000Z";

const ENTRY = {
  id: "think-entry-1",
  sourceKind: "email",
  sourceRef: "mail-1",
  sourceVersion: "1",
  externalContent: true,
} as unknown as StoredThinkEntry;

describe("think runner", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture(answer: { status: string; text?: string }) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-think-runner-"));
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
        VALUES (?, ?, ?, ?, 'holder-think-runner', 1, 1, ?, '2026-11-15T00:00:00.000Z')`,
      )
      .run(createAuthorityLeaseId("lease-think-runner"), OWNER_ID, AGENT_ID, DEPLOYMENT_ID, START);
    database.close();
    const clock = { now: () => START };
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      databasePath: file,
      minimumFreeBytes: 0,
      now: clock.now,
    });
    closers.push(() => repository.close());
    const adapters = createReferenceAdapterSet();
    const protector = adapters.payloadProtector;
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const configuration = { ownerId: OWNER_ID, agentId: AGENT_ID };
    const box = new ProductionProposalBox({
      configuration,
      store: repository.ownerProposals(),
      payloads,
      protector,
      clock,
    });
    const real = repository.threadRepository();
    const commands = new ThreadCommandService({
      repository: real,
      clock,
      authority: () => AUTHORITY,
    });
    registerTaskProposalHandler({
      box,
      configuration,
      commands,
      threads: real,
      payloads,
      protector,
      clock,
      timeZone: "Asia/Tokyo",
    });
    const answerRef = "think-test-answer";
    if (answer.text !== undefined)
      await payloads.put(
        await protector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref: answerRef,
          contentType: "text/plain",
          dataClassification: "private",
          plaintext: new TextEncoder().encode(answer.text),
          createdAt: START,
        }),
      );
    const prompts: string[] = [];
    const sources = repository.runExecutionSource(OWNER_ID, AGENT_ID);
    const seenSources: Awaited<ReturnType<typeof sources.read>>[] = [];
    const threads: Pick<ThreadRepositoryPort, "readDetailSnapshot"> = {
      readDetailSnapshot: async (query) => {
        const snapshot = await real.readDetailSnapshot(query);
        if (!snapshot) return snapshot;
        const owner = snapshot.messages.find((item) => item.role === "owner");
        const runId = owner?.runId;
        if (!runId) return snapshot;
        if (prompts.length === 0) {
          seenSources.push(await sources.read(runId));
          const payload = await payloads.get(owner.contentRef as never);
          if (payload)
            prompts.push(new TextDecoder().decode(await protector.unprotect({ payload })));
        }
        return {
          ...snapshot,
          runs: snapshot.runs.map((run) =>
            run.runId === runId ? { ...run, status: answer.status as never } : run,
          ),
          messages: [
            ...snapshot.messages,
            ...(answer.text === undefined
              ? []
              : [
                  {
                    ...owner,
                    role: "agent",
                    status: "committed",
                    contentRef: answerRef,
                  } as never,
                ]),
          ],
        };
      },
    };
    const runner = new ThreadThinkRunner({
      configuration,
      commands,
      threads,
      payloads,
      protector,
      clock,
      actions: thinkActions({ box, timeZone: "Asia/Tokyo" }),
      describeSource: (kind) => (kind === "email" ? "新邮件" : undefined),
      pollMs: 1,
    });
    const think = () =>
      runner.think({
        entry: ENTRY,
        summary: "房东请在 11 月 20 日前回复是否续租",
        signal: new AbortController().signal,
      });
    const list = async () => (await box.list()).proposals;
    const thread = async () => {
      const db = openQualifiedDatabase(file);
      try {
        return db.prepare("SELECT archived_at IS NOT NULL AS archived FROM threads").all() as {
          archived: number;
        }[];
      } finally {
        db.close();
      }
    };
    const run = async () => {
      const db = openQualifiedDatabase(file);
      try {
        const row = db.prepare("SELECT id FROM runs").get() as { id: string } | undefined;
        return {
          during: seenSources[0],
          after: row ? await sources.read(row.id as never) : undefined,
        };
      } finally {
        db.close();
      }
    };
    return { think, list, prompts, thread, run };
  }

  it("starts a run marked as think, then turns the answer into a waiting proposal and archives the thread", async () => {
    const { think, list, prompts, thread, run } = await fixture({
      status: "completed",
      text: JSON.stringify({
        action: "task.run",
        reason: "房东要求回复续租",
        text: "回复房东续租",
      }),
    });
    expect(await think()).toEqual({ outcome: "proposed", reasonCode: "proposal_written" });
    const proposals = await list();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: "task.run",
      origin: "external_content",
      summary: "交给我去办：回复房东续租",
    });
    expect(prompts[0]).toContain("新邮件");
    expect(prompts[0]).toContain("房东请在 11 月 20 日前回复是否续租");
    expect(prompts[0]).toContain("task.run");
    expect(await thread()).toEqual([{ archived: 1 }]);
    const { during, after } = await run();
    expect(during?.sourceType).toBe("external_event");
    expect(during?.sourceId.startsWith(THINK_MESSAGE_PREFIX)).toBe(true);
    expect(isThinkRunSource(during)).toBe(true);
    expect(after).toBeUndefined();
  });

  it("writes nothing when the model decides there is nothing to do", async () => {
    const { think, list } = await fixture({
      status: "completed",
      text: JSON.stringify({ action: "none", reason: "只是通知，不用处理" }),
    });
    expect(await think()).toEqual({ outcome: "skipped", reasonCode: "nothing_to_propose" });
    expect(await list()).toEqual([]);
  });

  it("refuses an action it did not offer and fields outside the action's list", async () => {
    const unknown = await fixture({
      status: "completed",
      text: JSON.stringify({ action: "email.send", reason: "回复房东" }),
    });
    expect(await unknown.think()).toEqual({ outcome: "skipped", reasonCode: "action_unknown" });
    expect(await unknown.list()).toEqual([]);
    const extra = await fixture({
      status: "completed",
      text: JSON.stringify({ action: "task.run", reason: "回复", text: "回复", to: "x" }),
    });
    expect(await extra.think()).toMatchObject({ outcome: "skipped" });
    expect(await extra.list()).toEqual([]);
  });

  it("writes nothing when the run fails or the answer is not the agreed JSON", async () => {
    const failed = await fixture({ status: "failed" });
    expect(await failed.think()).toEqual({ outcome: "skipped", reasonCode: "run_failed" });
    expect(await failed.thread()).toEqual([{ archived: 1 }]);
    const prose = await fixture({ status: "completed", text: "我觉得应该回复房东。" });
    expect(await prose.think()).toEqual({ outcome: "skipped", reasonCode: "answer_invalid" });
    expect(await prose.list()).toEqual([]);
  });
});
