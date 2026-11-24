import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ApplicationPortError,
  ProductThreadGatewayAdapter,
  type RecentAuthenticationGuardPort,
  ThreadCommandService,
  ThreadDeletionCoordinationService,
  ThreadForkService,
  ThreadQueryService,
} from "@himawari-agent/application";
import {
  createAgentId,
  createDeploymentId,
  createDeviceId,
  createOwnerId,
  createSessionId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import { threadGatewayMessageSchema } from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteGovernedDeletionAdapter,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { DeterministicPayloadProtector, ManualClock } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionMainThread } from "../../apps/agent-service/src/production-main-thread.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

describe.each(["worker", "direct"] as const)("main conversation through %s", (execution) => {
  useSqliteContractExecution(execution);

  const ownerId = createOwnerId("owner-main-thread");
  const agentId = createAgentId("agent-main-thread");
  const deploymentId = createDeploymentId("deployment-main-thread");
  const sessionId = createSessionId("session-main-thread");
  const deviceId = createDeviceId("device-main-thread");
  const authority: ProductAuthorityFence = { deploymentId, authorityEpoch: 3, fencingToken: 4 };
  const recentAuthentication: RecentAuthenticationGuardPort = {
    async assertRecentAuthentication({ authentication }) {
      return {
        source: "provider_step_up",
        externalSubjectRef: "fixture:owner",
        ownerId,
        deviceId,
        authenticationRef: authentication.authenticationRef,
        authenticatedAt: authentication.authenticatedAt,
        expiresAt: "2026-11-25T01:00:00.000Z",
      };
    },
  };
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-main-thread-"));
    roots.push(stateRoot);
    await mkdir(path.join(stateRoot, "data"), { recursive: true, mode: 0o700 });
    const databasePath = path.join(stateRoot, "data", "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(ownerId);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(agentId, ownerId);
    database
      .prepare(
        `INSERT INTO deployments (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
         VALUES (?, ?, ?, 0, 'active', ?, ?)`,
      )
      .run(deploymentId, ownerId, agentId, authority.authorityEpoch, authority.fencingToken);
    const insertPayload = database.prepare(
      `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
         content_digest, lifecycle_state, created_at)
       VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'active', '2026-11-24T00:00:00.000Z')`,
    );
    for (const ref of [
      "payload-main",
      "payload-old",
      "payload-other",
      "payload-said",
      "payload-said-result",
      "payload-note",
      "payload-note-result",
      "payload-archive",
      "payload-trash",
    ])
      insertPayload.run(ref, ownerId, agentId, `sha256:${ref}`);
    database.close();
    const clock = new ManualClock("2026-11-24T01:00:00.000Z");
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      databasePath,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    const threads = repository.threadRepository();
    const commands = new ThreadCommandService({
      repository: threads,
      clock,
      authority: () => authority,
    });
    const deletion = new SqliteGovernedDeletionAdapter({
      stateRoot,
      databasePath,
      ownerId,
      agentId,
      now: () => clock.now(),
    });
    return { stateRoot, databasePath, clock, repository, threads, commands, deletion };
  }

  it("answers the main conversation query with the same conversation every time", async () => {
    const { threads, commands, clock, repository } = await fixture();
    const mainThread = new ProductionMainThread({
      ownerId,
      agentId,
      threads,
      commands,
      payloads: repository.payloadStore(ownerId, agentId),
      protector: new DeterministicPayloadProtector(),
      clock,
    });
    const gateway = new ProductThreadGatewayAdapter({
      repository: threads,
      checkpoints: repository.threadDistillationState(),
      commands,
      queries: new ThreadQueryService(threads),
      forks: new ThreadForkService({ repository: threads, clock, authority: () => authority }),
      deletion: new ThreadDeletionCoordinationService({
        repository: threads,
        clock,
        authority: () => authority,
      }),
      mainThread,
      clock,
      waitForEvents: async () => Promise.resolve(),
    });
    const parsed = threadGatewayMessageSchema.parse({
      schemaVersion: "gateway.thread.v3",
      kind: "query",
      type: "thread.main",
      messageId: "message:thread.main",
      correlationId: "correlation-main-thread",
      causationId: null,
      scope: { ownerId, agentId },
      authority,
      actor: { actorType: "owner", actorId: ownerId },
      payload: {},
    });
    if (parsed.kind !== "query") throw new Error("expected query");
    const authentication = {
      subjectId: ownerId,
      ownerId,
      deviceId,
      authenticatedAt: "2026-11-24T01:00:00.000Z",
      authenticationRef: "session-main-thread",
    };
    const [first, concurrent] = await Promise.all([
      gateway.query({ authentication, query: parsed }),
      gateway.query({ authentication, query: parsed }),
    ]);
    expect(first).toMatchObject({
      type: "thread.main_snapshot",
      payload: { thread: { status: "active" } },
    });
    const mainId = (first as { payload: { thread: { threadId: string } } }).payload.thread.threadId;
    expect(concurrent).toMatchObject({ payload: { thread: { threadId: mainId } } });
    expect(await threads.readMain(ownerId, agentId)).toBe(mainId);
    const again = await gateway.query({ authentication, query: parsed });
    expect(again).toMatchObject({ payload: { thread: { threadId: mainId } } });
    expect(
      (
        await threads.list({
          ownerId,
          agentId,
          statuses: ["active"],
          pinnedOnly: false,
          afterThreadId: null,
          limit: 10,
        })
      ).length,
    ).toBe(1);
  });

  it("claims one main conversation per agent and keeps the first claim", async () => {
    const { threads, commands, clock } = await fixture();
    expect(await threads.readMain(ownerId, agentId)).toBeUndefined();
    const main = await commands.create({
      ownerId,
      agentId,
      idempotencyKey: "create-main",
      resultRef: "payload-main",
    });
    const other = await commands.create({
      ownerId,
      agentId,
      idempotencyKey: "create-other",
      resultRef: "payload-other",
    });
    const claimedAt = clock.now();
    expect(await threads.claimMain({ ownerId, agentId, threadId: main.thread.id, claimedAt })).toBe(
      main.thread.id,
    );
    expect(
      await threads.claimMain({ ownerId, agentId, threadId: other.thread.id, claimedAt }),
    ).toBe(main.thread.id);
    expect(await threads.readMain(ownerId, agentId)).toBe(main.thread.id);
  });

  it("refuses to archive, trash or delete the main conversation", async () => {
    const { threads, commands, clock } = await fixture();
    const main = await commands.create({
      ownerId,
      agentId,
      idempotencyKey: "create-main",
      resultRef: "payload-main",
    });
    await threads.claimMain({ ownerId, agentId, threadId: main.thread.id, claimedAt: clock.now() });
    await expect(
      commands.setLifecycle({
        ownerId,
        agentId,
        threadId: main.thread.id,
        expectedRevision: main.thread.revision,
        status: "archived",
        idempotencyKey: "archive-main",
        resultRef: "payload-archive",
      }),
    ).rejects.toMatchObject({
      code: "PORT_CONFLICT",
      details: { reasonCode: "THREAD_MAIN_PROTECTED" },
    });
    const coordinator = new ThreadDeletionCoordinationService({
      repository: threads,
      clock,
      authority: () => authority,
      recentAuthentication,
    });
    await expect(
      coordinator.trash({
        ownerId,
        agentId,
        threadId: main.thread.id,
        expectedThreadRevision: main.thread.revision,
        reasonCode: "owner_requested",
        idempotencyKey: "trash-main",
        resultRef: "payload-trash",
      }),
    ).rejects.toBeInstanceOf(ApplicationPortError);
    expect((await threads.read(ownerId, agentId, main.thread.id))?.status).toBe("active");
  });

  it("keeps internal messages out of the owner's view but in the model's context", async () => {
    const { threads, commands } = await fixture();
    const main = await commands.create({
      ownerId,
      agentId,
      idempotencyKey: "create-main",
      resultRef: "payload-main",
    });
    const said = await commands.admitOwnerMessage({
      ownerId,
      agentId,
      threadId: main.thread.id,
      expectedThreadRevision: main.thread.revision,
      sessionId,
      idempotencyKey: "owner-said",
      contentRef: "payload-said",
      sourceProofRef: "proof:owner",
      dataClassification: "private",
      resultRef: "payload-said-result",
    });
    const note = await commands.admitOwnerMessage({
      ownerId,
      agentId,
      threadId: main.thread.id,
      expectedThreadRevision: said.thread.revision,
      sessionId,
      idempotencyKey: "internal-note",
      contentRef: "payload-note",
      sourceProofRef: "proof:inbox",
      dataClassification: "private",
      resultRef: "payload-note-result",
      internal: true,
    });
    expect(note.message.internal).toBe(true);
    const detail = await threads.readDetailSnapshot({
      ownerId,
      agentId,
      threadId: main.thread.id,
      afterSequence: 0,
      limit: 50,
    });
    expect(detail?.messages.map((message) => message.contentRef)).toEqual(["payload-said"]);
    expect(
      (await threads.listMessages(ownerId, agentId, main.thread.id, 0, 50)).map(
        (message) => message.contentRef,
      ),
    ).toEqual(["payload-said"]);
    const runId = note.message.runId;
    if (!runId) throw new Error("internal note did not start a run");
    const context = await threads.readContextSnapshot({
      ownerId,
      agentId,
      threadId: main.thread.id,
      runId,
      afterSequence: 0,
      limit: 50,
    });
    expect(context?.messages.map((message) => message.contentRef)).toEqual(["payload-said"]);
    expect(context?.messages.some((message) => message.internal === true)).toBe(false);
  });

  it("[PR631-4][PR631-5] leaves internal messages out of search and the memory index watermarks", async () => {
    const { commands, repository, databasePath } = await fixture();
    const main = await commands.create({
      ownerId,
      agentId,
      idempotencyKey: "create-main",
      resultRef: "payload-main",
    });
    const said = await commands.admitOwnerMessage({
      ownerId,
      agentId,
      threadId: main.thread.id,
      expectedThreadRevision: main.thread.revision,
      sessionId,
      idempotencyKey: "owner-said",
      contentRef: "payload-said",
      sourceProofRef: "proof:owner",
      dataClassification: "private",
      resultRef: "payload-said-result",
    });
    const note = await commands.admitOwnerMessage({
      ownerId,
      agentId,
      threadId: main.thread.id,
      expectedThreadRevision: said.thread.revision,
      sessionId,
      idempotencyKey: "internal-note",
      contentRef: "payload-note",
      sourceProofRef: "proof:inbox",
      dataClassification: "private",
      resultRef: "payload-note-result",
      internal: true,
    });
    const database = openQualifiedDatabase(databasePath);
    database
      .prepare("UPDATE payloads SET content_type = 'text/plain' WHERE ref IN (?, ?)")
      .run("payload-said", "payload-note");
    database.close();
    const pending = await repository
      .threadSearchProjectionSource()
      .pending({ ownerId, agentId, projectionVersion: "v-test", limit: 50 });
    expect(
      pending.filter((source) => source.kind === "message").map((source) => source.messageId),
    ).toEqual([said.message.id]);
    expect(note.message.sequence).toBeGreaterThan(said.message.sequence);
    expect(
      (await repository.conversationTurns().listBehind({ ownerId, agentId, limit: 10 })).map(
        (watermark) => [watermark.threadId, watermark.lastSequence],
      ),
    ).toEqual([[main.thread.id, said.message.sequence]]);
    expect(
      (await repository.memoryEpisodes().listUnsummarized({ ownerId, agentId, limit: 10 })).map(
        (watermark) => [watermark.threadId, watermark.lastSequence],
      ),
    ).toEqual([[main.thread.id, said.message.sequence]]);
  });

  it("deletes conversations from before the main conversation and keeps the main one", async () => {
    const { threads, commands, clock, databasePath, deletion } = await fixture();
    const old = await commands.create({
      ownerId,
      agentId,
      idempotencyKey: "create-old",
      resultRef: "payload-old",
    });
    const database = openQualifiedDatabase(databasePath);
    database.prepare("UPDATE threads SET origin = 'legacy' WHERE id = ?").run(old.thread.id);
    database.close();
    const main = await commands.create({
      ownerId,
      agentId,
      idempotencyKey: "create-main",
      resultRef: "payload-main",
    });
    await threads.claimMain({ ownerId, agentId, threadId: main.thread.id, claimedAt: clock.now() });

    const reports = await deletion.deleteLegacyThreads({ limit: 50 });
    expect(reports.map((report) => [report.objectId, report.lifecycle])).toEqual([
      [old.thread.id, "deleted_verified"],
    ]);
    expect(await threads.read(ownerId, agentId, old.thread.id)).toBeUndefined();
    expect((await threads.read(ownerId, agentId, main.thread.id))?.status).toBe("active");
    expect(await deletion.deleteLegacyThreads({ limit: 50 })).toEqual([]);
  });
});
