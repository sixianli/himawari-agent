import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApplicationPortError, type PortErrorCode } from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
  createTriggerId,
  createTurnId,
} from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RunDispatchScope,
  RunExecutionLeaseId,
} from "../../packages/application/src/ports/run-dispatch.js";
import { SqliteRunDispatchOperations } from "../../packages/persistence-sqlite/src/sqlite-run-dispatch-operations.js";

const OWNER_ID = createOwnerId("owner-run-dispatch");
const AGENT_ID = createAgentId("agent-run-dispatch");
const DEPLOYMENT_ID = createDeploymentId("deployment-run-dispatch");
const AUTHORITY_LEASE_ID = createAuthorityLeaseId("lease-run-dispatch");
const NEXT_AUTHORITY_LEASE_ID = createAuthorityLeaseId("lease-run-dispatch-next");
const THREAD_ID = createThreadId("thread-run-dispatch");
const NOW = "2026-09-04T00:00:00.000Z";
const LATER = "2026-09-04T00:10:00.000Z";
const AUTHORITY = {
  product: { deploymentId: DEPLOYMENT_ID, authorityEpoch: 1, fencingToken: 1 },
  lease: { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
} as const;
const NEXT_AUTHORITY = {
  product: { deploymentId: DEPLOYMENT_ID, authorityEpoch: 2, fencingToken: 2 },
  lease: { leaseId: NEXT_AUTHORITY_LEASE_ID, fencingToken: 2 },
} as const;
const roots: string[] = [];

const failure = (
  code: string,
  message: string,
  details?: Readonly<Record<string, string>>,
): never => {
  throw new ApplicationPortError(code as PortErrorCode, message, details);
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function applyDispatchMigration(database: ReturnType<typeof openQualifiedDatabase>) {
  const applied = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_execution_leases'")
    .get();
  if (applied !== undefined) return;
  database.exec(
    await readFile(
      new URL(
        "../../packages/persistence-sqlite/src/migrations/0021_run_execution_leases.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

function scope(
  consumerId: string,
  authority: {
    readonly product: RunDispatchScope["authority"];
    readonly lease: RunDispatchScope["authorityLease"];
  } = AUTHORITY,
): RunDispatchScope {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    authority: authority.product,
    authorityLease: authority.lease,
    consumerId,
  };
}

function dispatch(
  database: ReturnType<typeof openQualifiedDatabase>,
  value: RunDispatchScope,
): SqliteRunDispatchOperations {
  return new SqliteRunDispatchOperations(database, value, failure);
}

async function fixture(
  options: {
    readonly contextPhase?: "accepted" | "context_formed" | "workers_running" | "runtime_running";
    readonly status?: "accepted" | "building_context" | "running";
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-run-dispatch-"));
  roots.push(root);
  const databasePath = path.join(root, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  await applyDispatchMigration(database);

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
        (id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
         fencing_token, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, 'run-dispatch-test', 1, 1, ?, '2099-12-31T23:59:59.999Z')`,
    )
    .run(AUTHORITY_LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, NOW);
  database
    .prepare(
      `INSERT INTO threads
        (id, owner_id, agent_id, revision, status, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'open', ?, ?)`,
    )
    .run(THREAD_ID, OWNER_ID, AGENT_ID, NOW, NOW);

  const insertPayload = database.prepare(
    `INSERT INTO payloads
      (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
       content_digest, lifecycle_state, created_at, content_type)
     VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'active', ?, 'text/plain')`,
  );
  insertPayload.run("payload-run-dispatch", OWNER_ID, AGENT_ID, "sha256:run-dispatch", NOW);

  const insertRun = database.prepare(
    `INSERT INTO triggers
      (id, owner_id, agent_id, thread_id, idempotency_key, source_type, source_id,
       payload_ref, source_proof_ref, occurred_at)
     VALUES (?, ?, ?, ?, ?, 'user_message', ?, 'payload-run-dispatch', ?, ?)`,
  );
  const insertRunRecord = database.prepare(
    `INSERT INTO runs
      (id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
       status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  );
  const insertTurn = database.prepare(
    `INSERT INTO turns
      (id, owner_id, agent_id, thread_id, session_id, run_id, turn_index, committed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const runId = createRunId("run-dispatch-main");
  const triggerId = createTriggerId("trigger-dispatch-main");
  insertRun.run(
    triggerId,
    OWNER_ID,
    AGENT_ID,
    THREAD_ID,
    "trigger-dispatch-main",
    "main",
    "proof-main",
    NOW,
  );
  insertRunRecord.run(
    runId,
    OWNER_ID,
    AGENT_ID,
    THREAD_ID,
    createSessionId("session-dispatch-main"),
    triggerId,
    options.status ?? (options.contextPhase ? "running" : "accepted"),
    NOW,
    NOW,
  );
  insertTurn.run(
    createTurnId("turn-dispatch-main"),
    OWNER_ID,
    AGENT_ID,
    THREAD_ID,
    createSessionId("session-dispatch-main"),
    runId,
    0,
    NOW,
  );
  if (options.contextPhase) {
    database
      .prepare(
        `INSERT INTO run_coordination_checkpoints
          (run_id, owner_id, agent_id, revision, phase, runtime_event_count, updated_at)
         VALUES (?, ?, ?, 1, ?, 0, ?)`,
      )
      .run(runId, OWNER_ID, AGENT_ID, options.contextPhase, NOW);
  }

  database.close();
  return { databasePath, runId };
}

function leaseId(value: string): RunExecutionLeaseId {
  return value as RunExecutionLeaseId;
}

function addRun(
  database: ReturnType<typeof openQualifiedDatabase>,
  input: {
    readonly runId: string;
    readonly triggerId: string;
    readonly sessionId: string;
    readonly turnIndex: number;
    readonly status: "accepted" | "awaiting_approval" | "completed";
  },
) {
  database
    .prepare(
      `INSERT INTO triggers
        (id, owner_id, agent_id, thread_id, idempotency_key, source_type, source_id,
         payload_ref, source_proof_ref, occurred_at)
       VALUES (?, ?, ?, ?, ?, 'user_message', ?, 'payload-run-dispatch', ?, ?)`,
    )
    .run(
      input.triggerId,
      OWNER_ID,
      AGENT_ID,
      THREAD_ID,
      input.triggerId,
      input.runId,
      `proof:${input.runId}`,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO runs
        (id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
         status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      input.runId,
      OWNER_ID,
      AGENT_ID,
      THREAD_ID,
      input.sessionId,
      input.triggerId,
      input.status,
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO turns
        (id, owner_id, agent_id, thread_id, session_id, run_id, turn_index, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `turn-${input.runId}`,
      OWNER_ID,
      AGENT_ID,
      THREAD_ID,
      input.sessionId,
      input.runId,
      input.turnIndex,
      NOW,
    );
}

describe("SQLite Run dispatch execution leases", () => {
  it("permits one consumer to claim a Run and rejects a concurrent second consumer", async () => {
    const resource = await fixture();
    const firstDatabase = openQualifiedDatabase(resource.databasePath);
    const secondDatabase = openQualifiedDatabase(resource.databasePath);
    try {
      const first = dispatch(firstDatabase, scope("consumer-one"));
      const second = dispatch(secondDatabase, scope("consumer-two"));
      const [firstResult, secondResult] = await Promise.allSettled([
        first.claim({
          runId: resource.runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: 0,
          executionLeaseId: leaseId("execution-lease-one"),
          claimedAt: NOW,
          expiresAt: LATER,
        }),
        second.claim({
          runId: resource.runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: 0,
          executionLeaseId: leaseId("execution-lease-two"),
          claimedAt: NOW,
          expiresAt: LATER,
        }),
      ]);
      expect(firstResult.status === "fulfilled").not.toBe(secondResult.status === "fulfilled");
      const rejected =
        firstResult.status === "rejected"
          ? firstResult.reason
          : secondResult.status === "rejected"
            ? secondResult.reason
            : undefined;
      expect(rejected).toMatchObject({ code: "PORT_CONFLICT" });
    } finally {
      firstDatabase.close();
      secondDatabase.close();
    }
  });

  it("allows a new consumer to reclaim an expired lease with a higher revision", async () => {
    const resource = await fixture();
    const database = openQualifiedDatabase(resource.databasePath);
    try {
      const runDispatch = dispatch(database, scope("consumer-one"));
      const first = await runDispatch.claim({
        runId: resource.runId,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: leaseId("execution-lease-expired-one"),
        claimedAt: NOW,
        expiresAt: "2026-09-04T00:05:00.000Z",
      });
      const reclaimed = await dispatch(database, scope("consumer-two")).claim({
        runId: resource.runId,
        expectedRunRevision: 1,
        expectedLeaseRevision: first.revision,
        executionLeaseId: leaseId("execution-lease-expired-two"),
        claimedAt: LATER,
        expiresAt: "2026-09-04T00:15:00.000Z",
      });
      expect(reclaimed).toMatchObject({
        executionLeaseId: "execution-lease-expired-two",
        revision: 2,
        replayed: false,
      });
      await expect(
        runDispatch.assertHeld({
          runId: resource.runId,
          expectedLeaseRevision: first.revision,
          executionLeaseId: first.executionLeaseId,
          at: "2026-09-04T00:10:01.000Z",
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    } finally {
      database.close();
    }
  });

  it("rejects writes from a released execution lease while retaining its revision fence", async () => {
    const resource = await fixture();
    const database = openQualifiedDatabase(resource.databasePath);
    try {
      const runDispatch = dispatch(database, scope("consumer-one"));
      const claimed = await runDispatch.claim({
        runId: resource.runId,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: leaseId("execution-lease-release"),
        claimedAt: NOW,
        expiresAt: LATER,
      });
      const released = await runDispatch.release({
        runId: resource.runId,
        expectedLeaseRevision: claimed.revision,
        executionLeaseId: claimed.executionLeaseId,
        releasedAt: "2026-09-04T00:05:00.000Z",
      });
      expect(released).toMatchObject({
        revision: 2,
        releasedAt: "2026-09-04T00:05:00.000Z",
      });
      await expect(
        runDispatch.assertHeld({
          runId: resource.runId,
          expectedLeaseRevision: claimed.revision,
          executionLeaseId: claimed.executionLeaseId,
          at: LATER,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    } finally {
      database.close();
    }
  });

  it("provides a synchronous lease guard for a writer's existing transaction", async () => {
    const resource = await fixture();
    const database = openQualifiedDatabase(resource.databasePath);
    try {
      const runDispatch = dispatch(database, scope("consumer-guard"));
      const claimed = await runDispatch.claim({
        runId: resource.runId,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: leaseId("execution-lease-guard"),
        claimedAt: NOW,
        expiresAt: LATER,
      });
      const guardedWrite = database
        .transaction(() => {
          const held = runDispatch.assertHeldInTransaction({
            runId: resource.runId,
            expectedLeaseRevision: claimed.revision,
            executionLeaseId: claimed.executionLeaseId,
            at: NOW,
          });
          database
            .prepare(
              "UPDATE runs SET updated_at = ? WHERE id = ? AND owner_id = ? AND agent_id = ?",
            )
            .run("2026-09-04T00:00:30.000Z", resource.runId, OWNER_ID, AGENT_ID);
          return held;
        })
        .immediate();
      expect(guardedWrite).toMatchObject({
        executionLeaseId: claimed.executionLeaseId,
        revision: claimed.revision,
      });
      expect(
        database.prepare("SELECT updated_at FROM runs WHERE id = ?").pluck().get(resource.runId),
      ).toBe("2026-09-04T00:00:30.000Z");
    } finally {
      database.close();
    }
  });

  it("renews across the original TTL without changing the claim revision", async () => {
    const resource = await fixture();
    const database = openQualifiedDatabase(resource.databasePath);
    const secondDatabase = openQualifiedDatabase(resource.databasePath);
    try {
      const runDispatch = dispatch(database, scope("consumer-renew"));
      const secondDispatch = dispatch(secondDatabase, scope("consumer-renew"));
      const claimed = await runDispatch.claim({
        runId: resource.runId,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: leaseId("execution-lease-renew"),
        claimedAt: NOW,
        expiresAt: "2026-09-04T00:00:01.000Z",
      });
      const renewedAt = "2026-09-04T00:00:00.900Z";
      const [renewed, replayedRenewal] = await Promise.all([
        runDispatch.renew({
          runId: resource.runId,
          expectedLeaseRevision: claimed.revision,
          executionLeaseId: claimed.executionLeaseId,
          renewedAt,
          expiresAt: "2026-09-04T00:00:02.000Z",
        }),
        secondDispatch.renew({
          runId: resource.runId,
          expectedLeaseRevision: claimed.revision,
          executionLeaseId: claimed.executionLeaseId,
          renewedAt,
          expiresAt: "2026-09-04T00:00:02.000Z",
        }),
      ]);
      expect(renewed).toMatchObject({
        executionLeaseId: claimed.executionLeaseId,
        revision: claimed.revision,
        expiresAt: "2026-09-04T00:00:02.000Z",
      });
      expect(replayedRenewal.revision).toBe(claimed.revision);
      expect(replayedRenewal.replayed).toBe(true);
      await expect(
        secondDispatch.renew({
          runId: resource.runId,
          expectedLeaseRevision: claimed.revision,
          executionLeaseId: claimed.executionLeaseId,
          renewedAt: "2026-09-04T00:00:01.000Z",
          expiresAt: "2026-09-04T00:00:01.500Z",
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });

      const guarded = database
        .transaction(() => {
          const held = runDispatch.assertHeldInTransaction({
            runId: resource.runId,
            expectedLeaseRevision: claimed.revision,
            executionLeaseId: claimed.executionLeaseId,
            at: "2026-09-04T00:00:01.500Z",
          });
          database
            .prepare("UPDATE runs SET updated_at = ? WHERE id = ?")
            .run("2026-09-04T00:00:01.500Z", resource.runId);
          return held;
        })
        .immediate();
      expect(guarded).toMatchObject({ revision: claimed.revision });
    } finally {
      database.close();
      secondDatabase.close();
    }
  });

  it("replays a response-lost claim by execution identity without creating another lease", async () => {
    const resource = await fixture();
    const database = openQualifiedDatabase(resource.databasePath);
    try {
      const runDispatch = dispatch(database, scope("consumer-one"));
      const first = await runDispatch.claim({
        runId: resource.runId,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: leaseId("execution-lease-replay"),
        claimedAt: NOW,
        expiresAt: LATER,
      });
      await expect(
        runDispatch.renew({
          runId: resource.runId,
          expectedLeaseRevision: first.revision,
          executionLeaseId: first.executionLeaseId,
          renewedAt: "2026-09-04T00:01:00.000Z",
          expiresAt: "2026-09-04T00:20:00.000Z",
        }),
      ).resolves.toMatchObject({
        executionLeaseId: first.executionLeaseId,
        revision: first.revision,
        replayed: false,
      });
      const replay = await dispatch(database, scope("consumer-one")).claim({
        runId: resource.runId,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: first.executionLeaseId,
        claimedAt: NOW,
        expiresAt: LATER,
      });
      expect(replay).toMatchObject({
        executionLeaseId: first.executionLeaseId,
        revision: first.revision,
        expiresAt: "2026-09-04T00:20:00.000Z",
        replayed: true,
      });
      await expect(
        runDispatch.claim({
          runId: resource.runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: 0,
          executionLeaseId: first.executionLeaseId,
          claimedAt: NOW,
          expiresAt: "2026-09-04T00:11:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      expect(database.prepare("SELECT COUNT(*) FROM run_execution_leases").pluck().get()).toBe(1);
      await expect(
        dispatch(database, scope("consumer-two")).claim({
          runId: resource.runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: 0,
          executionLeaseId: first.executionLeaseId,
          claimedAt: NOW,
          expiresAt: LATER,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      const foreign = dispatch(database, scope("consumer-two"));
      await expect(
        foreign.renew({
          runId: resource.runId,
          expectedLeaseRevision: first.revision,
          executionLeaseId: first.executionLeaseId,
          renewedAt: NOW,
          expiresAt: LATER,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      await expect(
        foreign.release({
          runId: resource.runId,
          expectedLeaseRevision: first.revision,
          executionLeaseId: first.executionLeaseId,
          releasedAt: "2026-09-04T00:01:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      await expect(
        foreign.assertHeld({
          runId: resource.runId,
          expectedLeaseRevision: first.revision,
          executionLeaseId: first.executionLeaseId,
          at: NOW,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    } finally {
      database.close();
    }
  });

  it("lets canonical Owner cancellation invalidate an active execution lease atomically", async () => {
    const resource = await fixture();
    const database = openQualifiedDatabase(resource.databasePath);
    try {
      const runDispatch = dispatch(database, scope("consumer-cancel"));
      const claimed = await runDispatch.claim({
        runId: resource.runId,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: leaseId("execution-lease-cancel"),
        claimedAt: NOW,
        expiresAt: LATER,
      });
      const cancelledAt = "2026-09-04T00:01:00.000Z";
      const invalidated = database
        .transaction(() => {
          const lease = runDispatch.invalidateForOwnerCancellationInTransaction({
            runId: resource.runId,
            at: cancelledAt,
          });
          const result = database
            .prepare(
              `UPDATE runs SET status = 'cancelled', revision = revision + 1, updated_at = ?
               WHERE id = ? AND owner_id = ? AND agent_id = ? AND revision = 1
                 AND status NOT IN ('completed', 'failed', 'cancelled')`,
            )
            .run(cancelledAt, resource.runId, OWNER_ID, AGENT_ID);
          return { lease, changes: result.changes };
        })
        .immediate();
      expect(invalidated).toMatchObject({
        lease: {
          executionLeaseId: claimed.executionLeaseId,
          revision: 2,
          releasedAt: cancelledAt,
        },
        changes: 1,
      });
      expect(
        database.prepare("SELECT status, revision FROM runs WHERE id = ?").get(resource.runId),
      ).toEqual({ status: "cancelled", revision: 2 });
      await expect(
        runDispatch.assertHeld({
          runId: resource.runId,
          expectedLeaseRevision: claimed.revision,
          executionLeaseId: claimed.executionLeaseId,
          at: "2026-09-04T00:02:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      await expect(
        runDispatch.claim({
          runId: resource.runId,
          expectedRunRevision: 2,
          expectedLeaseRevision: 2,
          executionLeaseId: leaseId("execution-lease-after-cancel"),
          claimedAt: "2026-09-04T00:02:00.000Z",
          expiresAt: LATER,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    } finally {
      database.close();
    }
  });

  it("fails closed when the bound product authority is stale", async () => {
    const resource = await fixture();
    const database = openQualifiedDatabase(resource.databasePath);
    try {
      database.prepare("UPDATE deployments SET fencing_token = 2 WHERE id = ?").run(DEPLOYMENT_ID);
      const runDispatch = dispatch(database, scope("consumer-stale"));
      await expect(runDispatch.listClaimable({ now: NOW, limit: 10 })).rejects.toMatchObject({
        code: "PORT_NOT_AUTHORITATIVE",
      });
    } finally {
      database.close();
    }
  });

  it("does not let a new authority or consumer operate an old execution lease", async () => {
    const resource = await fixture();
    const database = openQualifiedDatabase(resource.databasePath);
    try {
      const oldDispatch = dispatch(database, scope("consumer-old"));
      const claimed = await oldDispatch.claim({
        runId: resource.runId,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: leaseId("execution-lease-old-authority"),
        claimedAt: NOW,
        expiresAt: LATER,
      });
      database
        .prepare("UPDATE deployments SET authority_epoch = 2, fencing_token = 2 WHERE id = ?")
        .run(DEPLOYMENT_ID);
      database
        .prepare("UPDATE authority_leases SET released_at = ? WHERE id = ?")
        .run("2026-09-04T00:01:00.000Z", AUTHORITY_LEASE_ID);
      database
        .prepare(
          `INSERT INTO authority_leases (
             id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
             fencing_token, acquired_at, expires_at
           ) VALUES (?, ?, ?, ?, 'run-dispatch-next', 2, 2, ?, '2099-12-31T23:59:59.999Z')`,
        )
        .run(
          NEXT_AUTHORITY_LEASE_ID,
          OWNER_ID,
          AGENT_ID,
          DEPLOYMENT_ID,
          "2026-09-04T00:01:00.000Z",
        );
      const newDispatch = dispatch(database, scope("consumer-new", NEXT_AUTHORITY));
      await expect(
        newDispatch.assertHeld({
          runId: resource.runId,
          expectedLeaseRevision: claimed.revision,
          executionLeaseId: claimed.executionLeaseId,
          at: "2026-09-04T00:02:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
      await expect(
        newDispatch.renew({
          runId: resource.runId,
          expectedLeaseRevision: claimed.revision,
          executionLeaseId: claimed.executionLeaseId,
          renewedAt: "2026-09-04T00:02:00.000Z",
          expiresAt: "2026-09-04T00:20:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
      await expect(
        newDispatch.release({
          runId: resource.runId,
          expectedLeaseRevision: claimed.revision,
          executionLeaseId: claimed.executionLeaseId,
          releasedAt: "2026-09-04T00:02:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    } finally {
      database.close();
    }
  });

  it("uses turn order for same-Thread execution without treating approval as a blocker", async () => {
    const resource = await fixture();
    const database = openQualifiedDatabase(resource.databasePath);
    try {
      addRun(database, {
        runId: "run-dispatch-later",
        triggerId: "trigger-dispatch-later",
        sessionId: "session-dispatch-later",
        turnIndex: 1,
        status: "accepted",
      });
      const runDispatch = dispatch(database, scope("consumer-order"));
      await expect(runDispatch.listClaimable({ now: NOW, limit: 10 })).resolves.toEqual([
        expect.objectContaining({ runId: resource.runId }),
      ]);
      database
        .prepare("UPDATE runs SET status = 'completed', revision = 2 WHERE id = ?")
        .run(resource.runId);
      await expect(runDispatch.listClaimable({ now: NOW, limit: 10 })).resolves.toEqual([
        expect.objectContaining({ runId: "run-dispatch-later" }),
      ]);
    } finally {
      database.close();
    }

    const approvalResource = await fixture();
    const approvalDatabase = openQualifiedDatabase(approvalResource.databasePath);
    try {
      approvalDatabase
        .prepare("UPDATE runs SET status = 'awaiting_approval', revision = 2 WHERE id = ?")
        .run(approvalResource.runId);
      addRun(approvalDatabase, {
        runId: "run-dispatch-later",
        triggerId: "trigger-dispatch-later",
        sessionId: "session-dispatch-later",
        turnIndex: 1,
        status: "accepted",
      });
      const runDispatch = dispatch(approvalDatabase, scope("consumer-approval"));
      await expect(runDispatch.listClaimable({ now: NOW, limit: 10 })).resolves.toEqual([
        expect.objectContaining({ runId: "run-dispatch-later" }),
      ]);
    } finally {
      approvalDatabase.close();
    }
  });

  it("separates persisted context recovery from runtime-running reconciliation", async () => {
    const accepted = await fixture({ contextPhase: "accepted", status: "accepted" });
    const formed = await fixture({ contextPhase: "context_formed" });
    const running = await fixture({ contextPhase: "runtime_running" });
    const acceptedDatabase = openQualifiedDatabase(accepted.databasePath);
    const formedDatabase = openQualifiedDatabase(formed.databasePath);
    const runningDatabase = openQualifiedDatabase(running.databasePath);
    try {
      const acceptedDispatch = dispatch(acceptedDatabase, scope("consumer-accepted"));
      const formedDispatch = dispatch(formedDatabase, scope("consumer-formed"));
      const runningDispatch = dispatch(runningDatabase, scope("consumer-running"));
      await expect(acceptedDispatch.listClaimable({ now: NOW, limit: 10 })).resolves.toEqual([
        expect.objectContaining({
          runId: accepted.runId,
          action: "start",
          checkpointPhase: "accepted",
        }),
      ]);
      await expect(formedDispatch.listClaimable({ now: NOW, limit: 10 })).resolves.toEqual([
        expect.objectContaining({
          runId: formed.runId,
          action: "resume",
          checkpointPhase: "context_formed",
        }),
      ]);
      await expect(runningDispatch.listClaimable({ now: NOW, limit: 10 })).resolves.toEqual([]);
      await expect(
        runningDispatch.listReconciliationRequired({ now: NOW, limit: 10 }),
      ).resolves.toEqual([
        expect.objectContaining({
          runId: running.runId,
          action: "reconcile",
          checkpointPhase: "runtime_running",
        }),
      ]);
    } finally {
      acceptedDatabase.close();
      formedDatabase.close();
      runningDatabase.close();
    }
  });

  it("does not re-dispatch ambiguous workers or checkpointless running Runs", async () => {
    const workers = await fixture({ contextPhase: "workers_running" });
    const checkpointless = await fixture({ status: "running" });
    const workersDatabase = openQualifiedDatabase(workers.databasePath);
    const checkpointlessDatabase = openQualifiedDatabase(checkpointless.databasePath);
    try {
      const workersDispatch = dispatch(workersDatabase, scope("consumer-workers"));
      const checkpointlessDispatch = dispatch(
        checkpointlessDatabase,
        scope("consumer-checkpointless"),
      );
      await expect(workersDispatch.listClaimable({ now: NOW, limit: 10 })).resolves.toEqual([]);
      await expect(
        workersDispatch.listReconciliationRequired({ now: NOW, limit: 10 }),
      ).resolves.toEqual([
        expect.objectContaining({
          runId: workers.runId,
          action: "reconcile",
          checkpointPhase: "workers_running",
        }),
      ]);
      await expect(checkpointlessDispatch.listClaimable({ now: NOW, limit: 10 })).resolves.toEqual(
        [],
      );
      await expect(
        checkpointlessDispatch.listReconciliationRequired({ now: NOW, limit: 10 }),
      ).resolves.toEqual([
        expect.objectContaining({
          runId: checkpointless.runId,
          action: "reconcile",
          checkpointPhase: null,
        }),
      ]);
    } finally {
      workersDatabase.close();
      checkpointlessDatabase.close();
    }
  });
});
