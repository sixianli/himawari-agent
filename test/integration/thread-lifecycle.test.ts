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
  createThreadId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { ScopedThreadSearchTokenizer, ThreadSearchProjector } from "@himawari-agent/platform-node";
import { ManualClock } from "@himawari-agent/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

describe.each(["worker", "direct"] as const)("thread-lifecycle through %s", (execution) => {
  useSqliteContractExecution(execution);

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
    it("does not combine pre-completion messages with post-completion run state", async () => {
      const paths = await seedState();
      const clock = new ManualClock("2026-08-28T00:00:00.000Z");
      const repository = await SqliteProductStateRepository.open({
        ...paths,
        minimumFreeBytes: 0,
        now: () => clock.now(),
      });
      try {
        const threads = repository.threadRepository();
        const command = new ThreadCommandService({
          repository: threads,
          clock,
          authority: () => authority,
        });
        const created = await command.create({
          ownerId,
          agentId,
          idempotencyKey: "snapshot-create",
          answerLocale: "zh-CN",
          resultRef: "payload-result-create",
        });
        const admitted = await command.admitOwnerMessage({
          ownerId,
          agentId,
          threadId: created.thread.id,
          expectedThreadRevision: 1,
          sessionId,
          idempotencyKey: "snapshot-admit",
          contentRef: "payload-owner-message",
          sourceProofRef: "proof:local-owner-session",
          dataClassification: "private",
          resultRef: "payload-result-admit",
        });
        if (!admitted.message.turnId || !admitted.message.runId)
          throw new Error("Admission lacks run identity");
        const completion = {
          ownerId,
          agentId,
          threadId: created.thread.id,
          expectedThreadRevision: 2,
          turnId: admitted.message.turnId,
          runId: admitted.message.runId,
          idempotencyKey: "snapshot-complete",
          contentRef: "payload-agent-message",
          dataClassification: "private" as const,
          resultRef: "payload-result-commit",
        };
        // Deterministically insert a real committed answer between the old
        // separate message and run reads. No sleeps or synthetic completion state.
        const raced = new ThreadQueryService({
          ...threads,
          listMessages: async (...args) => {
            const messages = await threads.listMessages(...args);
            await command.commitAssistantMessage(completion);
            return messages;
          },
        });
        const snapshot = await raced.detail(ownerId, agentId, created.thread.id);
        const completed = snapshot.runs.some((run) => run.status === "completed");
        expect(snapshot.messages.some((message) => message.role === "agent")).toBe(completed);
        expect(snapshot.thread.messageWatermark).toBe(snapshot.messages.length);
        await command.commitAssistantMessage(completion);
        const final = await new ThreadQueryService(threads).detail(
          ownerId,
          agentId,
          created.thread.id,
        );
        expect(final).toMatchObject({
          thread: { messageWatermark: 2 },
          runs: [{ status: "completed" }],
          messages: [{ role: "owner" }, { role: "agent", contentRef: "payload-agent-message" }],
        });
        const page = await new ThreadQueryService(threads).detail(
          ownerId,
          agentId,
          created.thread.id,
          1,
          1,
        );
        expect(page.messages).toHaveLength(1);
        expect(page.messages[0]?.role).toBe("agent");
        await expect(
          new ThreadQueryService(threads).detail(
            createOwnerId("other-owner"),
            agentId,
            created.thread.id,
          ),
        ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
      } finally {
        await repository.close();
      }
    });

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
      expect(
        await threadRepository.listMessages(ownerId, agentId, forked.thread.id, 0, 10),
      ).toEqual([]);

      await repository.close();
      repository = await SqliteProductStateRepository.open({
        ...paths,
        minimumFreeBytes: 0,
        now: () => clock.now(),
      });
      threadRepository = repository.threadRepository();
      const restartedQuery = new ThreadQueryService(threadRepository);
      await expect(
        restartedQuery.detail(ownerId, agentId, created.thread.id),
      ).resolves.toMatchObject({
        thread: { revision: 8, answerLocale: "ja", titleSource: "owner", messageWatermark: 2 },
        messages: [{ sequence: 1 }, { sequence: 2 }],
      });
      await expect(
        restartedQuery.detail(ownerId, agentId, forked.thread.id),
      ).resolves.toMatchObject({
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

    it("paginates equal-timestamp lifecycle and search results without omission", async () => {
      const paths = await seedState();
      const clock = new ManualClock("2026-08-28T00:00:00.000Z");
      const repository = await SqliteProductStateRepository.open({
        ...paths,
        minimumFreeBytes: 0,
        now: () => clock.now(),
      });
      try {
        const threads = repository.threadRepository();
        const commands = new ThreadCommandService({
          repository: threads,
          clock,
          authority: () => authority,
        });
        const threadIds = Array.from({ length: 6 }, (_, index) =>
          createThreadId(`thread-pagination-${index.toString().padStart(2, "0")}`),
        );
        for (const [index, threadId] of threadIds.entries()) {
          await commands.create({
            ownerId,
            agentId,
            threadId,
            idempotencyKey: `thread-pagination-create-${index}`,
            resultRef: "payload-result-create",
          });
          const admitted = await commands.admitOwnerMessage({
            ownerId,
            agentId,
            threadId,
            expectedThreadRevision: 1,
            sessionId,
            idempotencyKey: `thread-pagination-admit-${index}`,
            contentRef: "payload-owner-message",
            sourceProofRef: `proof:thread-pagination-${index}`,
            dataClassification: "private",
            resultRef: "payload-result-admit",
          });
          if (!admitted.message.turnId || !admitted.message.runId) {
            throw new Error("Thread pagination fixture requires Turn and Run identities");
          }
          const committed = await commands.commitAssistantMessage({
            ownerId,
            agentId,
            threadId,
            expectedThreadRevision: admitted.thread.revision,
            turnId: admitted.message.turnId,
            runId: admitted.message.runId,
            idempotencyKey: `thread-pagination-commit-${index}`,
            contentRef: "payload-agent-message",
            dataClassification: "private",
            resultRef: "payload-result-commit",
          });
          await threads.projectSearch({
            ownerId,
            agentId,
            threadId,
            messageId: committed.message.id,
            sequence: committed.message.sequence,
            dataClassification: "private",
            tokenRefs: ["search-token:pagination"],
            projectionVersion: "projection-pagination-v1",
          });
        }
        for (const [pinOrder, threadId] of [threadIds[4], threadIds[1]].entries()) {
          if (!threadId) throw new Error("Thread pagination pin fixture is incomplete");
          await commands.pin({
            ownerId,
            agentId,
            threadId,
            expectedRevision: 3,
            pinOrder,
            idempotencyKey: `thread-pagination-pin-${pinOrder}`,
            resultRef: "payload-result-pin",
          });
        }
        const archivedId = threadIds[3];
        if (!archivedId) throw new Error("Thread pagination archive fixture is incomplete");
        await commands.setLifecycle({
          ownerId,
          agentId,
          threadId: archivedId,
          expectedRevision: 3,
          status: "archived",
          idempotencyKey: "thread-pagination-archive",
          resultRef: "payload-result-archive",
        });

        const query = new ThreadQueryService(threads);
        const listedIds = [];
        let listCursor = null;
        do {
          const page = await query.list({
            ownerId,
            agentId,
            statuses: ["active", "archived"],
            afterThreadId: listCursor,
            limit: 2,
          });
          listedIds.push(...page.map(({ id }) => id));
          listCursor = page.length === 2 ? (page.at(-1)?.id ?? null) : null;
        } while (listCursor !== null);
        expect(listedIds).toEqual([
          threadIds[4],
          threadIds[1],
          threadIds[0],
          threadIds[2],
          threadIds[3],
          threadIds[5],
        ]);

        const searchedIds = [];
        let searchCursor = null;
        do {
          const page = await query.search({
            ownerId,
            agentId,
            tokenRefs: ["search-token:pagination"],
            projectionVersion: "projection-pagination-v1",
            statuses: ["active", "archived"],
            afterThreadId: searchCursor,
            limit: 2,
          });
          searchedIds.push(...page.map(({ id }) => id));
          searchCursor = page.length === 2 ? (page.at(-1)?.id ?? null) : null;
        } while (searchCursor !== null);
        expect(searchedIds).toEqual(threadIds);
        await expect(
          query.list({
            ownerId,
            agentId,
            afterThreadId: createThreadId("thread-pagination-missing"),
            limit: 2,
          }),
        ).rejects.toThrow(/cursor.*unavailable/i);
      } finally {
        await repository.close();
      }
    });
  });

  it("rebuilds scoped search from canonical titles and messages and reuses durable projections", async () => {
    const paths = await seedState();
    const db = openQualifiedDatabase(paths.databasePath);
    db.prepare("UPDATE payloads SET content_type='text/plain'").run();
    db.close();
    const clock = new ManualClock("2026-08-28T00:00:00.000Z");
    let repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    const command = new ThreadCommandService({
      repository: repository.threadRepository(),
      clock,
      authority: () => authority,
    });
    const created = await command.create({
      ownerId,
      agentId,
      idempotencyKey: "search-create",
      resultRef: "payload-result-create",
    });
    const admitted = await command.admitOwnerMessage({
      ownerId,
      agentId,
      threadId: created.thread.id,
      expectedThreadRevision: 1,
      sessionId,
      idempotencyKey: "search-admit",
      contentRef: "payload-owner-message",
      sourceProofRef: "test",
      dataClassification: "private",
      resultRef: "payload-result-admit",
    });
    await command.rename({
      ownerId,
      agentId,
      threadId: created.thread.id,
      expectedRevision: 2,
      titleRef: "payload-owner-title",
      source: "owner",
      idempotencyKey: "search-title",
      resultRef: "payload-result-rename",
    });
    const tokenizer = new ScopedThreadSearchTokenizer({
      keys: { resolve: async () => new Uint8Array(32).fill(17) },
      projectionVersion: "search-live-v2",
    });
    const read = vi.fn(async ({ payloadRef }: { payloadRef: string }) => ({
      content:
        payloadRef === "payload-owner-title" ? "海风计划" : "项目是海风花园，计划明天整理资料。",
      dataClassification: "private" as const,
      contentType: "text/plain" as const,
    }));
    const input = {
      authentication: {
        subjectId: ownerId,
        ownerId,
        deviceId: "test",
        authenticatedAt: clock.now(),
        authenticationRef: "test",
      },
      agentId,
    };
    const projector = () =>
      new ThreadSearchProjector({
        sources: repository.threadSearchProjectionSource(),
        threads: repository.threadRepository(),
        tokenizer,
        reader: { read },
      });
    try {
      expect(
        await repository.threadSearchProjectionSource().pending({
          ownerId: createOwnerId("other-owner"),
          agentId,
          projectionVersion: tokenizer.projectionVersion,
          limit: 64,
        }),
      ).toEqual([]);
      await projector().synchronize(input);
      expect(read).toHaveBeenCalledTimes(2);
      const query = async (text: string) =>
        new ThreadQueryService(repository.threadRepository()).search({
          ownerId,
          agentId,
          tokenRefs: await tokenizer.tokenize({ ownerId, agentId, text }),
          projectionVersion: tokenizer.projectionVersion,
          limit: 10,
        });
      expect((await query("海风计划")).map((t) => t.id)).toEqual([created.thread.id]);
      expect((await query("海风花园")).map((t) => t.id)).toEqual([created.thread.id]);
      await repository.close();
      repository = await SqliteProductStateRepository.open({
        ...paths,
        minimumFreeBytes: 0,
        now: () => clock.now(),
      });
      await projector().synchronize(input);
      expect(read).toHaveBeenCalledTimes(2);
      const currentThread = await repository
        .threadRepository()
        .read(ownerId, agentId, created.thread.id);
      if (!currentThread) throw new Error("TEST_THREAD_MISSING");
      const revision = currentThread.revision;
      await new ThreadCommandService({
        repository: repository.threadRepository(),
        clock,
        authority: () => authority,
      }).rename({
        ownerId,
        agentId,
        threadId: created.thread.id,
        expectedRevision: revision,
        titleRef: "payload-auto-title",
        source: "owner",
        idempotencyKey: "search-title-new",
        resultRef: "payload-result-auto-title",
      });
      expect(await query("海风计划")).toEqual([]);
      await projector().synchronize(input);
      expect(read).toHaveBeenCalledTimes(3);
      expect(
        await repository
          .threadSearchProjectionSource()
          .pending({ ownerId, agentId, projectionVersion: tokenizer.projectionVersion, limit: 64 }),
      ).toEqual([]);
      expect(admitted.message.status).toBe("committed");
    } finally {
      await repository.close();
    }
  });
});
