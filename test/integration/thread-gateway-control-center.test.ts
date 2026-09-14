import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentThreadGatewayService,
  type GatewayAuthenticationContext,
  ProductThreadGatewayAdapter,
  ThreadCommandService,
  ThreadDeletionCoordinationService,
  ThreadForkService,
  ThreadQueryService,
} from "@himawari-agent/application";
import {
  createAgentId,
  createDeploymentId,
  createOwnerId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import {
  type ThreadGatewayCommand,
  type ThreadGatewayQuery,
  type ThreadGatewaySubscription,
  threadGatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { ManualClock } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";

const ownerId = createOwnerId("owner-thread-gateway");
const agentId = createAgentId("agent-thread-gateway");
const deploymentId = createDeploymentId("deployment-thread-gateway");
const authority: ProductAuthorityFence = {
  deploymentId,
  authorityEpoch: 2,
  fencingToken: 4,
};
const authentication: GatewayAuthenticationContext = {
  subjectId: ownerId,
  ownerId,
  deviceId: "device-thread-gateway",
  authenticatedAt: "2026-08-28T00:00:00.000Z",
  authenticationRef: "session-thread-gateway",
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function seedState() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-thread-gateway-"));
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
  const insertPayload = database.prepare(
    `INSERT INTO payloads (
      ref, owner_id, agent_id, classification, storage_kind, ciphertext,
      content_digest, lifecycle_state, created_at, content_type
    ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'active', ?, 'text/plain')`,
  );
  for (const payloadRef of ["payload:create", "payload:pin", "payload:pin-stale"]) {
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

function envelope(kind: "command" | "query" | "subscription", type: string) {
  return {
    schemaVersion: "gateway.thread.v3" as const,
    kind,
    type,
    messageId: `message:${type}`,
    correlationId: "correlation-thread-gateway",
    causationId: null,
    scope: { ownerId, agentId },
    authority,
    actor: { actorType: "owner" as const, actorId: ownerId },
  };
}

function command(type: "thread.create" | "thread.pin", payload: unknown): ThreadGatewayCommand {
  const parsed = threadGatewayMessageSchema.parse({
    ...envelope("command", type),
    idempotencyKey: `idempotency:${type}`,
    payload,
  });
  if (parsed.kind !== "command") throw new Error("expected command");
  return parsed;
}

function query(type: "thread.list" | "thread.detail", payload: unknown): ThreadGatewayQuery {
  const parsed = threadGatewayMessageSchema.parse({ ...envelope("query", type), payload });
  if (parsed.kind !== "query") throw new Error("expected query");
  return parsed;
}

function subscription(afterCursor: string | null): ThreadGatewaySubscription {
  const parsed = threadGatewayMessageSchema.parse({
    ...envelope("subscription", "thread.events"),
    payload: { afterCursor },
  });
  if (parsed.kind !== "subscription") throw new Error("expected subscription");
  return parsed;
}

function adapter(repository: SqliteProductStateRepository, clock: ManualClock) {
  const threads = repository.threadRepository();
  const commands = new ThreadCommandService({
    repository: threads,
    clock,
    authority: () => authority,
  });
  return new ProductThreadGatewayAdapter({
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
    clock,
    waitForEvents: async () => Promise.resolve(),
  });
}

describe("Thread Gateway control-center adapter", () => {
  it("returns strict snapshots, explicit conflicts, and restart-durable cursor events", async () => {
    const paths = await seedState();
    const clock = new ManualClock("2026-08-28T00:00:00.000Z");
    let repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    let gateway = adapter(repository, clock);
    const created = await gateway.execute({
      authentication,
      command: command("thread.create", {
        threadId: "thread-gateway-01",
        answerLocale: "zh-CN",
        resultRef: "payload:create",
      }),
    });
    expect(created).toMatchObject({
      type: "thread.command_result",
      payload: { threadRevision: 1, replayed: false },
    });
    const replayed = await gateway.execute({
      authentication,
      command: command("thread.create", {
        threadId: "thread-gateway-01",
        answerLocale: "zh-CN",
        resultRef: "payload:create",
      }),
    });
    expect(replayed).toMatchObject({ payload: { replayed: true } });
    clock.advance(1000);
    const pinned = await gateway.execute({
      authentication,
      command: command("thread.pin", {
        threadId: "thread-gateway-01",
        expectedRevision: 1,
        pinOrder: 0,
        resultRef: "payload:pin",
      }),
    });
    expect(pinned).toMatchObject({ payload: { threadRevision: 2 } });
    const conflict = await gateway.execute({
      authentication,
      command: threadGatewayMessageSchema.parse({
        ...envelope("command", "thread.pin"),
        messageId: "message:thread.pin.stale",
        idempotencyKey: "idempotency:thread.pin.stale",
        payload: {
          threadId: "thread-gateway-01",
          expectedRevision: 1,
          pinOrder: null,
          resultRef: "payload:pin-stale",
        },
      }) as ThreadGatewayCommand,
    });
    expect(conflict).toMatchObject({
      type: "thread.conflict",
      payload: { reasonCode: "PORT_CONFLICT", latest: { revision: 2, pinOrder: 0 } },
    });
    await expect(
      gateway.query({
        authentication,
        query: query("thread.list", {
          statuses: ["active"],
          pinnedOnly: false,
          afterCursor: null,
          limit: 10,
        }),
      }),
    ).resolves.toMatchObject({
      type: "thread.collection_snapshot",
      payload: { threads: [{ threadId: "thread-gateway-01", revision: 2 }] },
    });
    await expect(
      gateway.query({
        authentication,
        query: query("thread.detail", {
          threadId: "thread-gateway-01",
          afterSequence: 0,
          limit: 10,
        }),
      }),
    ).resolves.toMatchObject({
      type: "thread.detail_snapshot",
      payload: { thread: { revision: 2 }, messages: [], runs: [] },
    });

    const firstStream = gateway.subscribe({ authentication, subscription: subscription(null) });
    const iterator = firstStream[Symbol.asyncIterator]();
    const first = await iterator.next();
    const second = await iterator.next();
    expect([first.value?.payload.cursor, second.value?.payload.cursor]).toEqual([
      "thread-cursor:1",
      "thread-cursor:2",
    ]);
    await iterator.return?.();

    await repository.close();
    repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    gateway = adapter(repository, clock);
    const restarted = gateway.subscribe({
      authentication,
      subscription: subscription("thread-cursor:1"),
    });
    const restartedIterator = restarted[Symbol.asyncIterator]();
    expect((await restartedIterator.next()).value?.payload.cursor).toBe("thread-cursor:2");
    await restartedIterator.return?.();
    await repository.close();
  });

  it("recovers one authoritative Thread state and cursor stream across two authorized devices", async () => {
    const paths = await seedState();
    const clock = new ManualClock("2026-08-28T00:00:00.000Z");
    const repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    try {
      const product = adapter(repository, clock);
      const allowedDevices = new Set(["device-thread-a", "device-thread-b"]);
      const gateway = new AgentThreadGatewayService({
        access: {
          async authorize({ authentication: context }) {
            const allowed = allowedDevices.has(context.deviceId);
            return {
              allowed,
              reasonCode: allowed ? "OWNER_DEVICE_AUTHORIZED" : "DEVICE_NOT_AUTHORIZED",
            };
          },
        },
        controlPlane: product,
        reads: product,
      });
      const deviceA = { ...authentication, deviceId: "device-thread-a" };
      const deviceB = {
        ...authentication,
        deviceId: "device-thread-b",
        authenticationRef: "session-thread-gateway-b",
      };
      const unauthorizedDevice = {
        ...authentication,
        deviceId: "device-thread-c",
        authenticationRef: "session-thread-gateway-c",
      };

      await expect(
        gateway.request(
          deviceA,
          command("thread.create", {
            threadId: "thread-gateway-01",
            answerLocale: "zh-CN",
            resultRef: "payload:create",
          }),
        ),
      ).resolves.toMatchObject({ payload: { threadRevision: 1 } });
      await expect(
        gateway.request(
          deviceB,
          command("thread.pin", {
            threadId: "thread-gateway-01",
            expectedRevision: 1,
            pinOrder: 0,
            resultRef: "payload:pin",
          }),
        ),
      ).resolves.toMatchObject({ payload: { threadRevision: 2 } });

      const listQuery = query("thread.list", {
        statuses: ["active"],
        pinnedOnly: false,
        afterCursor: null,
        limit: 10,
      });
      const [snapshotA, snapshotB] = await Promise.all([
        gateway.request(deviceA, listQuery),
        gateway.request(deviceB, listQuery),
      ]);
      expect(snapshotA).toEqual(snapshotB);
      expect(snapshotA).toMatchObject({
        payload: { threads: [{ threadId: "thread-gateway-01", revision: 2, pinOrder: 0 }] },
      });
      await expect(gateway.request(unauthorizedDevice, listQuery)).rejects.toThrow(
        /device is not authorized/i,
      );

      async function firstTwoCursors(context: GatewayAuthenticationContext) {
        const iterator = gateway.subscribe(context, subscription(null))[Symbol.asyncIterator]();
        try {
          return [
            (await iterator.next()).value?.payload.cursor,
            (await iterator.next()).value?.payload.cursor,
          ];
        } finally {
          await iterator.return?.();
        }
      }
      const [cursorsA, cursorsB] = await Promise.all([
        firstTwoCursors(deviceA),
        firstTwoCursors(deviceB),
      ]);
      expect(cursorsA).toEqual(["thread-cursor:1", "thread-cursor:2"]);
      expect(cursorsB).toEqual(cursorsA);
    } finally {
      await repository.close();
    }
  });
});

it("rejects uninstalled model selection and cancellation outside the selected Thread", async () => {
  const paths = await seedState();
  const clock = new ManualClock("2026-08-28T00:00:00.000Z");
  const repository = await SqliteProductStateRepository.open({
    ...paths,
    minimumFreeBytes: 0,
    now: () => clock.now(),
  });
  try {
    const gateway = adapter(repository, clock);
    await gateway.execute({
      authentication,
      command: command("thread.create", {
        threadId: "thread-selection",
        answerLocale: "zh-CN",
        resultRef: "payload:create",
      }),
    });
    const configured = threadGatewayMessageSchema.parse({
      ...envelope("command", "thread.message.submit_configured"),
      idempotencyKey: "selection:not-installed",
      payload: {
        threadId: "thread-selection",
        expectedRevision: 1,
        messageId: "message:selected",
        turnId: "turn:selected",
        runId: "run:selected",
        sessionId: "session-thread-gateway",
        contentRef: "payload:create",
        sourceProofRef: "browser:fixture",
        dataClassification: "private",
        occurredAt: clock.now(),
        resultRef: "payload:pin",
        modelRef: "model:not-configured",
        thinkingLevel: "high",
      },
    }) as ThreadGatewayCommand;
    await expect(gateway.execute({ authentication, command: configured })).rejects.toThrow(
      "MODEL_SELECTION_NOT_INSTALLED",
    );
    const cancel = threadGatewayMessageSchema.parse({
      ...envelope("command", "thread.run.cancel"),
      idempotencyKey: "cancel:wrong-run",
      payload: {
        threadId: "thread-selection",
        runId: "run:another-thread",
        expectedRunRevision: 1,
        resultRef: "payload:pin",
      },
    }) as ThreadGatewayCommand;
    await expect(gateway.execute({ authentication, command: cancel })).rejects.toThrow(
      "THREAD_RUN_NOT_FOUND",
    );
    const snapshot = await gateway.query({
      authentication,
      query: query("thread.detail", {
        threadId: "thread-selection",
        afterSequence: 0,
        limit: 10,
      }),
    });
    expect(snapshot).toMatchObject({
      payload: { thread: { revision: 1 }, messages: [], runs: [] },
    });
  } finally {
    await repository.close();
  }
});

describe("Thread Gateway lifecycle and empty projections", () => {
  it("keeps rename, locale and archive changes visible through authoritative snapshots", async () => {
    const paths = await seedState();
    const clock = new ManualClock("2026-08-28T00:00:00.000Z");
    const repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    try {
      const gateway = adapter(repository, clock);
      let sequence = 0;
      const send = (type: ThreadGatewayCommand["type"], payload: unknown) => {
        const id = `lifecycle-${++sequence}`;
        const value = threadGatewayMessageSchema.parse({
          ...envelope("command", type),
          messageId: id,
          idempotencyKey: id,
          payload,
        });
        if (value.kind !== "command") throw new Error("Expected command");
        return gateway.execute({ authentication, command: value });
      };
      const read = (type: ThreadGatewayQuery["type"], payload: unknown) => {
        const value = threadGatewayMessageSchema.parse({ ...envelope("query", type), payload });
        if (value.kind !== "query") throw new Error("Expected query");
        return gateway.query({ authentication, query: value });
      };
      const threadId = "thread-lifecycle";
      await send("thread.create", { threadId, answerLocale: "zh-CN", resultRef: "payload:create" });
      await send("thread.rename", {
        threadId,
        expectedRevision: 1,
        titleRef: "payload:pin",
        titleSource: "owner",
        resultRef: "payload:pin",
      });
      await send("thread.set_answer_locale", {
        threadId,
        expectedRevision: 2,
        answerLocale: "ja",
        resultRef: "payload:pin",
      });
      expect(await read("thread.detail", { threadId, afterSequence: 0, limit: 10 })).toMatchObject({
        payload: {
          thread: {
            revision: 3,
            titleRef: "payload:pin",
            titleSource: "owner",
            answerLocale: "ja",
          },
        },
      });
      await send("thread.archive", {
        threadId,
        expectedRevision: 3,
        reasonCode: "owner_requested",
        resultRef: "payload:pin",
      });
      expect(
        await read("thread.list", {
          statuses: ["active"],
          pinnedOnly: false,
          afterCursor: null,
          limit: 1,
        }),
      ).toMatchObject({ payload: { threads: [], nextCursor: null } });
      expect(
        await read("thread.list", {
          statuses: ["archived"],
          pinnedOnly: false,
          afterCursor: null,
          limit: 1,
        }),
      ).toMatchObject({
        payload: { threads: [{ threadId, status: "archived" }], nextCursor: threadId },
      });
      expect(
        await read("thread.list", {
          statuses: ["archived"],
          pinnedOnly: false,
          afterCursor: threadId,
          limit: 1,
        }),
      ).toMatchObject({ payload: { threads: [], nextCursor: null } });
      await send("thread.restore", {
        threadId,
        expectedRevision: 4,
        reasonCode: "owner_requested",
        resultRef: "payload:pin",
      });
      expect(await read("thread.lineage", { threadId })).toMatchObject({
        payload: {
          threadId,
          sourceThreadId: null,
          sourceTurnId: null,
          sourceWatermark: null,
          summaryRefs: [],
          policyRefs: [],
          sourceContentAvailable: false,
          forkedAt: null,
        },
      });
      expect(await read("thread.checkpoint", { threadId, sourceWatermark: null })).toMatchObject({
        payload: {
          threadId,
          jobId: null,
          generationId: null,
          sourceWatermark: null,
          policyVersion: null,
          modelDescriptorRef: null,
          trigger: null,
          summaryRef: null,
          status: null,
          revision: null,
          attemptCount: null,
          nextRetryAt: null,
          errorCode: null,
        },
      });
      expect(
        await read("thread.search", {
          queryRef: "query-no-match",
          tokenRefs: ["token-no-match"],
          projectionVersion: "projection-v1",
          statuses: ["active"],
          jobStatuses: [],
          updatedAfter: null,
          updatedBefore: null,
          afterCursor: null,
          limit: 1,
        }),
      ).toMatchObject({ payload: { threads: [], nextCursor: null, degraded: false } });
      await expect(
        read("thread.execution", { threadId, runId: "missing-run", afterSequence: 0, limit: 10 }),
      ).rejects.toThrow("THREAD_EXECUTION_NOT_INSTALLED");
      await expect(
        send("thread.run.cancel", {
          threadId,
          runId: "missing-run",
          expectedRunRevision: 1,
          resultRef: "payload:pin",
        }),
      ).rejects.toThrow("THREAD_RUN_NOT_FOUND");
      const controller = new AbortController();
      controller.abort();
      const iterator = gateway
        .subscribe({ authentication, subscription: subscription(null), signal: controller.signal })
        [Symbol.asyncIterator]();
      expect(await iterator.next()).toMatchObject({ done: true });
      // Read persisted state through a fresh repository, independently of command acknowledgements.
      await repository.close();
      const reopened = await SqliteProductStateRepository.open({
        ...paths,
        minimumFreeBytes: 0,
        now: () => clock.now(),
      });
      try {
        expect(
          await adapter(reopened, clock).query({
            authentication,
            query: query("thread.detail", { threadId, afterSequence: 0, limit: 10 }),
          }),
        ).toMatchObject({
          payload: {
            thread: { revision: 5, status: "active", answerLocale: "ja", titleSource: "owner" },
          },
        });
      } finally {
        await reopened.close();
      }
    } finally {
      await repository.close();
    }
  });
});
