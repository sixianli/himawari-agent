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
  loadBundledMigrations,
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

  async function fixture(
    answer: { status: string; text?: string },
    options: {
      readonly entry?: StoredThinkEntry;
      readonly archiveConflicts?: number;
    } = {},
  ) {
    const entry = options.entry ?? ENTRY;
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
    const service = new ThreadCommandService({
      repository: real,
      clock,
      authority: () => AUTHORITY,
    });
    let conflicts = options.archiveConflicts ?? 0;
    const proposalsAtArchive: number[] = [];
    const commands = {
      create: service.create.bind(service),
      admitOwnerMessage: service.admitOwnerMessage.bind(service),
      setLifecycle: async (input: Parameters<ThreadCommandService["setLifecycle"]>[0]) => {
        proposalsAtArchive.push((await box.list()).proposals.length);
        if (conflicts > 0) {
          conflicts -= 1;
          throw new Error("PORT_CONFLICT");
        }
        return service.setLifecycle(input);
      },
    } as unknown as ThreadCommandService;
    registerTaskProposalHandler({
      box,
      configuration,
      commands: service,
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
    const cancelled: string[] = [];
    const failures: string[] = [];
    const runner = new ThreadThinkRunner({
      configuration,
      commands,
      threads,
      payloads,
      protector,
      clock,
      actions: thinkActions({ box, timeZone: "Asia/Tokyo" }),
      describeSource: (kind) => (kind === "email" ? "新邮件" : undefined),
      cancelRun: async ({ runId }) => {
        cancelled.push(runId);
      },
      onFailure: (event) => failures.push(event),
      pollMs: 1,
    });
    const think = (signal: AbortSignal = new AbortController().signal) =>
      runner.think({
        entry,
        summary: "房东请在 11 月 20 日前回复是否续租",
        signal,
      });
    const stored = async () => {
      const db = openQualifiedDatabase(file);
      try {
        return db
          .prepare(
            "SELECT origin, source_ref AS sourceRef, source_version AS sourceVersion FROM owner_proposals",
          )
          .all() as { origin: string; sourceRef: string | null; sourceVersion: string | null }[];
      } finally {
        db.close();
      }
    };
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
    return {
      think,
      list,
      prompts,
      thread,
      run,
      cancelled,
      failures,
      stored,
      proposalsAtArchive,
      repository,
      service,
      payloads,
      protector,
      file,
    };
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

  it("cancels the run and still archives the thread when the wait runs out", async () => {
    const { think, thread, cancelled } = await fixture({ status: "running" });
    await expect(think(AbortSignal.timeout(20))).rejects.toBeDefined();
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.startsWith("run:think:")).toBe(true);
    expect(await thread()).toEqual([{ archived: 1 }]);
  });

  it("does not cancel a run that finished on its own", async () => {
    const { think, cancelled } = await fixture({ status: "failed" });
    expect(await think()).toEqual({ outcome: "skipped", reasonCode: "run_failed" });
    expect(cancelled).toEqual([]);
  });

  it("retries archiving after a revision conflict and reports when it keeps failing", async () => {
    const once = await fixture({ status: "failed" }, { archiveConflicts: 1 });
    await once.think();
    expect(await once.thread()).toEqual([{ archived: 1 }]);
    expect(once.failures).toEqual([]);
    const always = await fixture({ status: "failed" }, { archiveConflicts: 10 });
    expect(await always.think()).toEqual({ outcome: "skipped", reasonCode: "run_failed" });
    expect(await always.thread()).toEqual([{ archived: 0 }]);
    expect(always.failures).toEqual(["think.archive_failed"]);
  });

  it("does not propose again when an entry is retried after its thread was archived", async () => {
    const { think, list } = await fixture({
      status: "completed",
      text: JSON.stringify({
        action: "task.run",
        reason: "房东要求回复续租",
        text: "回复房东续租",
      }),
    });
    expect(await think()).toEqual({ outcome: "proposed", reasonCode: "proposal_written" });
    const before = await list();
    expect(await think()).toEqual({ outcome: "skipped", reasonCode: "run_already_finished" });
    expect(await list()).toEqual(before);
  });

  it("writes the proposal before archiving, so a crash after archiving cannot lose it", async () => {
    const { think, list, proposalsAtArchive } = await fixture({
      status: "completed",
      text: JSON.stringify({
        action: "task.run",
        reason: "房东要求回复续租",
        text: "回复房东续租",
      }),
    });
    expect(await think()).toEqual({ outcome: "proposed", reasonCode: "proposal_written" });
    expect(proposalsAtArchive).toEqual([1]);
    expect(await list()).toHaveLength(1);
  });

  it("keeps the proposal source within the export limits for the longest accepted source", async () => {
    const { think, stored } = await fixture(
      {
        status: "completed",
        text: JSON.stringify({ action: "task.run", reason: "看看这页", text: "读一下这页再说" }),
      },
      {
        entry: {
          ...ENTRY,
          id: "think-entry-long",
          sourceKind: "k".repeat(64),
          sourceRef: "r".repeat(256),
          sourceVersion: "v".repeat(256),
          externalContent: false,
        } as StoredThinkEntry,
      },
    );
    expect(await think()).toEqual({ outcome: "proposed", reasonCode: "proposal_written" });
    const [row] = await stored();
    expect(row?.origin).toBe("external_content");
    expect(row?.sourceRef?.length).toBeLessThanOrEqual(256);
    expect(row?.sourceVersion?.length).toBeLessThanOrEqual(128);
  });

  it("keeps the thinking thread out of every list, feed and summary while a look-alike owner thread stays", async () => {
    const { think, repository, service, payloads, protector, file } = await fixture({
      status: "completed",
      text: JSON.stringify({ action: "none", reason: "只是通知" }),
    });
    expect(await think()).toEqual({ outcome: "skipped", reasonCode: "nothing_to_propose" });
    const lookAlike = "thread:think:client-chosen" as never;
    await payloads.put(
      await protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref: "owner-look-alike-text",
        contentType: "text/plain",
        dataClassification: "private",
        plaintext: new TextEncoder().encode("帮我看看明天的安排"),
        createdAt: START,
      }),
    );
    const created = await service.create({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: lookAlike,
      idempotencyKey: "owner-look-alike",
      resultRef: "owner-look-alike-text" as never,
    });
    await service.admitOwnerMessage({
      triggerSource: "external_event",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: lookAlike,
      expectedThreadRevision: created.thread.revision,
      sessionId: "session-look-alike" as never,
      idempotencyKey: "owner-look-alike-message",
      contentRef: "owner-look-alike-text" as never,
      sourceProofRef: "proof-look-alike",
      dataClassification: "private",
      resultRef: "owner-look-alike-text" as never,
    });
    const db = openQualifiedDatabase(file);
    const origins = db.prepare("SELECT id, origin FROM threads ORDER BY id").all() as {
      id: string;
      origin: string;
    }[];
    db.close();
    const thinkId = origins.find((row) => row.origin === "think")?.id;
    expect(thinkId?.startsWith("thread:think:")).toBe(true);
    expect(origins.find((row) => row.id === lookAlike)?.origin).toBe("owner");
    const threads = repository.threadRepository();
    const listed = await threads.list({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      statuses: ["active", "archived"],
      pinnedOnly: false,
      afterThreadId: null,
      limit: 50,
    } as never);
    expect(listed.map((item) => item.id)).toEqual([lookAlike]);
    expect((await threads.read(OWNER_ID, AGENT_ID, thinkId as never))?.origin).toBe("think");
    const events = await threads.listGatewayEvents(OWNER_ID, AGENT_ID, null, 100);
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((event) => event.threadId))).toEqual(new Set([lookAlike]));
    const sources = await repository
      .threadSearchProjectionSource()
      .pending({ ownerId: OWNER_ID, agentId: AGENT_ID, projectionVersion: "v-test", limit: 50 });
    expect(new Set(sources.map((source) => source.threadId))).toEqual(new Set([lookAlike]));
    const indexed = openQualifiedDatabase(file);
    const indexMessages = indexed.prepare(
      `INSERT INTO thread_search_projection
        (owner_id, agent_id, thread_id, message_id, sequence, classification, token_ref,
          projection_version)
        SELECT owner_id, agent_id, thread_id, id, sequence, classification, 'token-shared',
          'v-test'
        FROM thread_messages`,
    );
    expect(indexMessages.run().changes).toBeGreaterThanOrEqual(2);
    indexed.close();
    const found = await threads.search({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      tokenRefs: ["token-shared"],
      projectionVersion: "v-test",
      statuses: ["active", "archived"],
      jobStatuses: [],
      updatedAfter: null,
      updatedBefore: null,
      afterThreadId: null,
      limit: 50,
    });
    expect(found.map((item) => item.id)).toEqual([lookAlike]);
    const unattended = await repository
      .runLifecycle(OWNER_ID, AGENT_ID, AUTHORITY)
      .listUnattendedRuns?.({ failedSince: START, limit: 50 });
    expect(unattended?.map((item) => item.threadId)).toEqual([lookAlike]);
    const activity = await repository.applePush().listActivityRuns({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      createdAfter: "2000-01-01T00:00:00.000Z",
      createdBefore: "2100-01-01T00:00:00.000Z",
      limit: 50,
    });
    expect(activity.map((item) => item.threadId)).toEqual([lookAlike]);
    const episodes = await repository
      .memoryEpisodes()
      .listUnsummarized({ ownerId: OWNER_ID, agentId: AGENT_ID, limit: 50 });
    expect(episodes.map((item) => item.threadId)).toEqual([lookAlike]);
    const finish = openQualifiedDatabase(file);
    finish.prepare("UPDATE runs SET status = 'completed'").run();
    finish.close();
    const finished = await repository.webPush().listFinishedRuns({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      afterCursor: "2000-01-01T00:00:00.000Z",
      limit: 50,
    });
    expect(finished.map((item) => item.threadId)).toEqual([lookAlike]);
  });

  it("marks thinking threads made before the origin column as think, and leaves client look-alikes as owner", async () => {
    const { think, service, payloads, protector, file } = await fixture({
      status: "completed",
      text: JSON.stringify({ action: "none", reason: "只是通知" }),
    });
    expect(await think()).toEqual({ outcome: "skipped", reasonCode: "nothing_to_propose" });
    await payloads.put(
      await protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref: "owner-forged-text",
        contentType: "text/plain",
        dataClassification: "private",
        plaintext: new TextEncoder().encode("帮我看看明天的安排"),
        createdAt: START,
      }),
    );
    const forged = "thread:think:client-forged" as never;
    await service.create({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: forged,
      idempotencyKey: "think-thread:not-a-think-entry",
      resultRef: "owner-forged-text" as never,
    });
    const migration = (await loadBundledMigrations()).find((item) =>
      item.name.includes("thread_origin"),
    );
    expect(migration).toBeDefined();
    const db = openQualifiedDatabase(file);
    try {
      db.prepare(
        `INSERT INTO think_inbox
          (id, owner_id, agent_id, source_kind, source_ref, source_version, external_content,
            status, day, created_at, updated_at)
          VALUES (?, ?, ?, 'email', 'mail-1', '1', 1, 'done', '2026-11-14', ?, ?)`,
      ).run(ENTRY.id, OWNER_ID, AGENT_ID, START, START);
      db.exec("ALTER TABLE threads DROP COLUMN origin");
      db.exec(migration?.sql ?? "");
      const origins = db.prepare("SELECT id, origin FROM threads ORDER BY id").all() as {
        id: string;
        origin: string;
      }[];
      expect(origins.map((row) => row.origin).toSorted()).toEqual(["owner", "think"]);
      expect(origins.find((row) => row.id === forged)?.origin).toBe("owner");
      expect(origins.find((row) => row.origin === "think")?.id.startsWith("thread:think:")).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });

  it("replays a thinking thread created before origin was recorded instead of conflicting", async () => {
    const { service, payloads, protector } = await fixture({
      status: "completed",
      text: JSON.stringify({ action: "none", reason: "只是通知" }),
    });
    await payloads.put(
      await protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref: "think-task:before-upgrade",
        contentType: "text/plain",
        dataClassification: "private",
        plaintext: new TextEncoder().encode("想一想"),
        createdAt: START,
      }),
    );
    const request = {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: "thread:think:before-upgrade" as never,
      idempotencyKey: "think-thread:before-upgrade",
      resultRef: "think-task:before-upgrade" as never,
    };
    const before = await service.create(request);
    const after = await service.create({ ...request, origin: "think" });
    expect(after.thread.id).toBe(before.thread.id);
  });
});
