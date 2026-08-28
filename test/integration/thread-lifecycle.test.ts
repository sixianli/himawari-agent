import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ThreadCommandService,
  ThreadForkService,
  ThreadQueryService,
} from "@himawari-agent/application";
import {
  createAgentId,
  createDeploymentId,
  createOwnerId,
  createSessionId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import {
  SqliteProductStateRepository,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { ManualClock } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";

const ownerId = createOwnerId("owner-thread-lifecycle");
const agentId = createAgentId("agent-thread-lifecycle");
const deploymentId = createDeploymentId("deployment-thread-lifecycle");
const sessionId = createSessionId("session-thread-lifecycle");
const authority: ProductAuthorityFence = {
  deploymentId,
  authorityEpoch: 3,
  fencingToken: 7,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function seedState() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-thread-lifecycle-"));
  temporaryDirectories.push(stateRoot);
  const databasePath = path.join(stateRoot, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(ownerId);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(agentId, ownerId);
  database
    .prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES (?, ?, ?, 0, 'active', ?, ?)`,
    )
    .run(deploymentId, ownerId, agentId, authority.authorityEpoch, authority.fencingToken);
  const payloads = [
    "payload-result-create",
    "payload-owner-message",
    "payload-result-admit",
    "payload-agent-message",
    "payload-result-commit",
    "payload-owner-title",
    "payload-auto-title",
    "payload-result-rename",
    "payload-result-auto-title",
    "payload-result-pin",
    "payload-result-locale",
    "payload-result-archive",
    "payload-result-restore",
    "payload-summary",
    "payload-result-fork",
    "payload-result-stale",
  ];
  const insertPayload = database.prepare(
    `INSERT INTO payloads (
      ref, owner_id, agent_id, classification, storage_kind, ciphertext,
      content_digest, lifecycle_state, created_at
    ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'active', ?)`,
  );
  for (const payloadRef of payloads) {
    insertPayload.run(
      payloadRef,
      ownerId,
      agentId,
      `sha256:${payloadRef}`,
      "2026-08-28T00:00:00.000Z",
    );
  }
  database.close();
  return { stateRoot, databasePath };
}

describe("Thread product lifecycle", () => {
  it("persists atomic message, search, lifecycle, Fork, and restart semantics", async () => {
    const paths = await seedState();
    const clock = new ManualClock("2026-08-28T00:00:00.000Z");
    let repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    let threadRepository = repository.threadRepository();
    const command = new ThreadCommandService({
      repository: threadRepository,
      clock,
      authority: () => authority,
    });

    const created = await command.create({
      ownerId,
      agentId,
      idempotencyKey: "thread-create-01",
      answerLocale: "zh-CN",
      resultRef: "payload-result-create",
    });
    clock.advance(1000);
    const createReplay = await command.create({
      ownerId,
      agentId,
      idempotencyKey: "thread-create-01",
      answerLocale: "zh-CN",
      resultRef: "payload-result-create",
    });
    expect(createReplay).toEqual(created);

    const admitted = await command.admitOwnerMessage({
      ownerId,
      agentId,
      threadId: created.thread.id,
      expectedThreadRevision: 1,
      sessionId,
      idempotencyKey: "thread-admit-01",
      contentRef: "payload-owner-message",
      sourceProofRef: "proof:local-owner-session",
      dataClassification: "private",
      resultRef: "payload-result-admit",
    });
    expect(admitted).toMatchObject({
      thread: { revision: 2, messageWatermark: 1 },
      message: { sequence: 1, role: "owner", status: "committed" },
    });
    const admittedTurnId = admitted.message.turnId;
    const admittedRunId = admitted.message.runId;
    if (!admittedTurnId || !admittedRunId) {
      throw new Error("Owner message admission must create stable Turn and Run identities");
    }
    await expect(
      command.admitOwnerMessage({
        ownerId,
        agentId,
        threadId: created.thread.id,
        expectedThreadRevision: 1,
        sessionId,
        idempotencyKey: "thread-admit-01",
        contentRef: "payload-owner-message",
        sourceProofRef: "proof:local-owner-session",
        dataClassification: "private",
        resultRef: "payload-result-admit",
      }),
    ).resolves.toEqual(admitted);

    clock.advance(1000);
    const committed = await command.commitAssistantMessage({
      ownerId,
      agentId,
      threadId: created.thread.id,
      expectedThreadRevision: 2,
      turnId: admittedTurnId,
      runId: admittedRunId,
      idempotencyKey: "thread-commit-01",
      contentRef: "payload-agent-message",
      dataClassification: "private",
      resultRef: "payload-result-commit",
    });
    expect(committed).toMatchObject({
      thread: { revision: 3, messageWatermark: 2 },
      message: { sequence: 2, role: "agent", status: "committed" },
    });

    await threadRepository.projectSearch({
      ownerId,
      agentId,
      threadId: created.thread.id,
      messageId: committed.message.id,
      sequence: 2,
      dataClassification: "private",
      tokenRefs: ["search-token:himawari", "search-token:thread"],
      projectionVersion: "projection-v1",
    });
    await expect(
      threadRepository.projectSearch({
        ownerId,
        agentId,
        threadId: created.thread.id,
        messageId: committed.message.id,
        sequence: 2,
        dataClassification: "public",
        tokenRefs: ["search-token:downgrade"],
        projectionVersion: "projection-v1",
      }),
    ).rejects.toThrow(/classification/);
    const query = new ThreadQueryService(threadRepository);
    await expect(
      query.search({
        ownerId,
        agentId,
        tokenRefs: ["search-token:himawari", "search-token:thread"],
        projectionVersion: "projection-v1",
        limit: 10,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: created.thread.id })]);

    clock.advance(1000);
    const renamed = await command.rename({
      ownerId,
      agentId,
      threadId: created.thread.id,
      expectedRevision: 3,
      titleRef: "payload-owner-title",
      source: "owner",
      idempotencyKey: "thread-rename-01",
      resultRef: "payload-result-rename",
    });
    await threadRepository.projectTitleSearch({
      ownerId,
      agentId,
      threadId: created.thread.id,
      titleRevision: renamed.thread.titleRevision,
      dataClassification: "private",
      tokenRefs: ["search-token:owner-title"],
      projectionVersion: "projection-v1",
    });
    await expect(
      query.search({
        ownerId,
        agentId,
        tokenRefs: ["search-token:owner-title"],
        projectionVersion: "projection-v1",
        updatedAfter: "2026-08-27T23:59:59.000Z",
        updatedBefore: "2026-08-29T00:00:00.000Z",
        limit: 10,
      }),
    ).resolves.toEqual([expect.objectContaining({ titleSource: "owner" })]);
    clock.advance(1000);
    await expect(
      command.rename({
        ownerId,
        agentId,
        threadId: created.thread.id,
        expectedRevision: 4,
        titleRef: "payload-auto-title",
        source: "automatic",
        idempotencyKey: "thread-auto-title-late",
        resultRef: "payload-result-auto-title",
      }),
    ).rejects.toThrow(/Automatic title/);
    await expect(
      command.rename({
        ownerId,
        agentId,
        threadId: created.thread.id,
        expectedRevision: 3,
        titleRef: "payload-owner-title",
        source: "owner",
        idempotencyKey: "thread-rename-01",
        resultRef: "payload-result-rename",
      }),
    ).resolves.toEqual(renamed);
    await expect(
      command.pin({
        ownerId,
        agentId,
        threadId: created.thread.id,
        expectedRevision: 3,
        pinOrder: 0,
        idempotencyKey: "thread-pin-stale",
        resultRef: "payload-result-pin",
      }),
    ).rejects.toThrow(/revision conflict/);

    const pinned = await command.pin({
      ownerId,
      agentId,
      threadId: created.thread.id,
      expectedRevision: 4,
      pinOrder: 0,
      idempotencyKey: "thread-pin-01",
      resultRef: "payload-result-pin",
    });
    const localized = await command.setAnswerLocale({
      ownerId,
      agentId,
      threadId: created.thread.id,
      expectedRevision: pinned.thread.revision,
      answerLocale: "ja",
      idempotencyKey: "thread-locale-01",
      resultRef: "payload-result-locale",
    });
    const archived = await command.setLifecycle({
      ownerId,
      agentId,
      threadId: created.thread.id,
      expectedRevision: localized.thread.revision,
      status: "archived",
      idempotencyKey: "thread-archive-01",
      resultRef: "payload-result-archive",
    });
    expect(await query.list({ ownerId, agentId, statuses: ["active"], limit: 10 })).toEqual([]);
    const restored = await command.setLifecycle({
      ownerId,
      agentId,
      threadId: created.thread.id,
      expectedRevision: archived.thread.revision,
      status: "active",
      idempotencyKey: "thread-restore-01",
      resultRef: "payload-result-restore",
    });
    expect(restored.thread).toMatchObject({ status: "active", answerLocale: "ja", pinOrder: 0 });

    const fork = new ThreadForkService({
      repository: threadRepository,
      clock,
      authority: () => authority,
    });
    const forkInput = {
      ownerId,
      agentId,
      sourceThreadId: created.thread.id,
      sourceTurnId: admittedTurnId,
      sourceWatermark: 2,
      summaryRefs: ["payload-summary"],
      policyRefs: ["policy:answer-locale:ja"],
      idempotencyKey: "thread-fork-01",
      resultRef: "payload-result-fork",
    } as const;
    const forked = await fork.fork(forkInput);
    await expect(fork.fork(forkInput)).resolves.toEqual(forked);
    expect(forked.thread).toMatchObject({
      revision: 1,
      messageWatermark: 0,
      lineage: {
        sourceThreadId: created.thread.id,
        sourceTurnId: admitted.message.turnId,
        sourceWatermark: 2,
      },
    });
    expect(await threadRepository.listMessages(ownerId, agentId, forked.thread.id, 0, 10)).toEqual(
      [],
    );

    await repository.close();
    repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    threadRepository = repository.threadRepository();
    const restartedQuery = new ThreadQueryService(threadRepository);
    await expect(restartedQuery.detail(ownerId, agentId, created.thread.id)).resolves.toMatchObject(
      {
        thread: { revision: 8, answerLocale: "ja", titleSource: "owner", messageWatermark: 2 },
        messages: [{ sequence: 1 }, { sequence: 2 }],
      },
    );
    await expect(restartedQuery.detail(ownerId, agentId, forked.thread.id)).resolves.toMatchObject({
      thread: { lineage: { sourceThreadId: created.thread.id, sourceWatermark: 2 } },
      messages: [],
    });

    const staleCommand = new ThreadCommandService({
      repository: threadRepository,
      clock,
      authority: () => ({ ...authority, fencingToken: authority.fencingToken - 1 }),
    });
    await expect(
      staleCommand.create({
        ownerId,
        agentId,
        idempotencyKey: "thread-create-stale",
        resultRef: "payload-result-stale",
      }),
    ).rejects.toThrow(/stale/);
    await repository.close();

    const database = openQualifiedDatabase(paths.databasePath);
    expect(
      database
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM triggers) AS triggers,
            (SELECT COUNT(*) FROM runs) AS runs,
            (SELECT COUNT(*) FROM turns) AS turns,
            (SELECT COUNT(*) FROM thread_messages) AS messages,
            (SELECT COUNT(*) FROM thread_command_receipts) AS receipts,
            (SELECT COUNT(*) FROM reliable_events WHERE topic = 'thread.changed') AS events`,
        )
        .get(),
    ).toEqual({ triggers: 1, runs: 1, turns: 1, messages: 2, receipts: 9, events: 9 });
    database
      .prepare(
        `INSERT INTO scheduled_jobs (
          id, owner_id, agent_id, thread_id, revision, status,
          authorization_ref, definition_ref, next_occurrence_at
        ) VALUES ('job-thread-lifecycle', ?, ?, ?, 1, 'active',
          'grant-thread-lifecycle', 'payload-owner-message', NULL)`,
      )
      .run(ownerId, agentId, created.thread.id);
    database.close();

    repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    await expect(
      new ThreadQueryService(repository.threadRepository()).search({
        ownerId,
        agentId,
        tokenRefs: ["search-token:owner-title"],
        projectionVersion: "projection-v1",
        jobStatuses: ["active"],
        limit: 10,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: created.thread.id })]);
    await repository.close();

    const deletionDatabase = openQualifiedDatabase(paths.databasePath);
    deletionDatabase.prepare("DELETE FROM threads WHERE id = ?").run(created.thread.id);
    deletionDatabase.close();
    repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    await expect(
      new ThreadQueryService(repository.threadRepository()).detail(
        ownerId,
        agentId,
        forked.thread.id,
      ),
    ).resolves.toMatchObject({
      thread: {
        lineage: {
          sourceThreadId: created.thread.id,
          sourceWatermark: 2,
          sourceContentAvailable: false,
          summaryRefs: [],
        },
      },
      messages: [],
    });
    await expect(
      new ThreadForkService({
        repository: repository.threadRepository(),
        clock,
        authority: () => authority,
      }).fork(forkInput),
    ).resolves.toMatchObject({
      receipt: forked.receipt,
      thread: { id: forked.thread.id, lineage: { sourceContentAvailable: false } },
    });
    await repository.close();
  });
});
