import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import {
  ApplicationPortError,
  claimFromRunExecutionLease,
  type PortErrorCode,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createIdempotencyKey,
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
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RunDispatchScope,
  RunExecutionLeaseId,
} from "../../packages/application/src/ports/run-dispatch.js";
import { SqliteRunDispatchOperations } from "../../packages/persistence-sqlite/src/sqlite-run-dispatch-operations.js";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

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
    readonly migrationLimit?: number;
    readonly contextPhase?: "accepted" | "context_formed" | "workers_running" | "runtime_running";
    readonly status?: "accepted" | "building_context" | "running";
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-run-dispatch-"));
  roots.push(root);
  const databasePath = path.join(root, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, (await loadBundledMigrations()).slice(0, options.migrationLimit));
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

describe.each(["worker", "direct"] as const)("SQLite component contracts (%s)", (execution) => {
  useSqliteContractExecution(execution);

  describe("SQLite Run dispatch execution leases", () => {
    it("migrates existing checkpoints and Worker results without dropping their foreign-key data", async () => {
      const resource = await fixture({
        migrationLimit: 25,
        contextPhase: "runtime_running",
        status: "running",
      });
      const database = openQualifiedDatabase(resource.databasePath);
      try {
        database
          .prepare(`INSERT INTO run_coordination_worker_results
        (run_id, owner_id, agent_id, worker_run_id, result_ref) VALUES (?, ?, ?, 'existing-worker', 'payload-run-dispatch')`)
          .run(resource.runId, OWNER_ID, AGENT_ID);
        const snapshotPath = `${resource.databasePath}.before-hitl`;
        await database.backup(snapshotPath);
        const result = applyMigrations(database, await loadBundledMigrations(), {
          snapshot: {
            host: hostname(),
            sourceDatabasePath: resource.databasePath,
            snapshotPath,
            schemaSequence: 25,
            digest: createHash("sha256")
              .update(await readFile(snapshotPath))
              .digest("hex"),
            verifiedAt: NOW,
          },
        });
        expect(result.appliedSequences).toEqual([26, 27, 28, 29, 30, 31, 32]);
        expect(
          database
            .prepare(
              "SELECT phase, suspension_json FROM run_coordination_checkpoints WHERE run_id = ?",
            )
            .get(resource.runId),
        ).toEqual({ phase: "runtime_running", suspension_json: null });
        expect(
          database
            .prepare(
              "SELECT worker_run_id, result_ref FROM run_coordination_worker_results WHERE run_id = ?",
            )
            .all(resource.runId),
        ).toEqual([{ worker_run_id: "existing-worker", result_ref: "payload-run-dispatch" }]);
        expect(database.pragma("foreign_key_check")).toEqual([]);
      } finally {
        database.close();
      }
    });
    it.each(["approved", "denied", "expired", "deadline", "cancelled"] as const)(
      "reopens a durable suspension and claims only after %s",
      async (decision) => {
        const resource = await fixture();
        const db = openQualifiedDatabase(resource.databasePath);
        db.prepare(`INSERT INTO approval_requests
      (id, owner_id, agent_id, run_id, revision, status, risk, intent_ref, semantic_snapshot_hash, requested_at)
      VALUES ('approval-suspension', ?, ?, ?, 1, 'pending', 'high', 'payload-run-dispatch', 'frozen-action', ?)`).run(
          OWNER_ID,
          AGENT_ID,
          resource.runId,
          NOW,
        );
        db.close();
        const open = () =>
          SqliteProductStateRepository.open({
            stateRoot: path.dirname(resource.databasePath),
            databasePath: resource.databasePath,
            minimumFreeBytes: 0,
            now: () => NOW,
          });
        let repository = await open();
        const dispatchPort = (consumer: string) =>
          repository.runDispatch(OWNER_ID, AGENT_ID, AUTHORITY.product, AUTHORITY.lease, consumer);
        try {
          const first = dispatchPort("first");
          const claim = await first.claim({
            runId: resource.runId,
            expectedRunRevision: 1,
            expectedLeaseRevision: 0,
            executionLeaseId: leaseId("before-suspension"),
            claimedAt: NOW,
            expiresAt: LATER,
          });
          const checkpoints = repository.runCheckpointStore(OWNER_ID, AGENT_ID, AUTHORITY.product);
          const checkpoint = {
            phase: "awaiting_approval" as const,
            contextRef: "payload-run-dispatch",
            workerResults: {},
            runtimeEventCount: 3,
            lastTraceEventId: null,
            terminalStatus: null,
            output: null,
            diagnosticCode: null,
            suspension: {
              version: "runtime-suspension.v1" as const,
              continuationRef: "payload-run-dispatch",
              ...(decision === "deadline" ? { executionDeadlineAt: NOW } : {}),
              approval: {
                approvalRequestId: "approval-suspension",
                semanticSnapshotHash: "frozen-action",
                expiresAt: LATER,
              },
            },
          };
          await expect(
            checkpoints.compareAndSet({
              runId: resource.runId,
              expectedRevision: null,
              executionLease: claimFromRunExecutionLease(claim),
              checkpoint: {
                ...checkpoint,
                suspension: {
                  ...checkpoint.suspension,
                  approval: { ...checkpoint.suspension.approval, semanticSnapshotHash: "changed" },
                },
              },
            }),
          ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
          await checkpoints.compareAndSet({
            runId: resource.runId,
            expectedRevision: null,
            executionLease: claimFromRunExecutionLease(claim),
            checkpoint,
          });
          const released = await first.release({
            runId: resource.runId,
            expectedLeaseRevision: claim.revision,
            executionLeaseId: claim.executionLeaseId,
            releasedAt: NOW,
          });
          await repository.close();
          const changed = openQualifiedDatabase(resource.databasePath);
          changed
            .prepare("UPDATE runs SET status = 'awaiting_approval', revision = 2 WHERE id = ?")
            .run(resource.runId);
          changed.close();
          repository = await open();
          expect(
            (
              await repository
                .runCheckpointStore(OWNER_ID, AGENT_ID, AUTHORITY.product)
                .read(resource.runId)
            )?.checkpoint,
          ).toEqual(checkpoint);
          const second = dispatchPort("second");
          if (decision !== "deadline")
            expect(await second.listClaimable({ now: NOW, limit: 10 })).toEqual([]);
          const currentLease = released;
          if (decision !== "deadline")
            await expect(
              second.claim({
                runId: resource.runId,
                expectedRunRevision: 2,
                expectedLeaseRevision: currentLease?.revision ?? 0,
                executionLeaseId: leaseId("premature-resume"),
                claimedAt: NOW,
                expiresAt: LATER,
              }),
            ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
          if (decision === "cancelled") {
            await repository.runLifecycle(OWNER_ID, AGENT_ID, AUTHORITY.product).cancelRun({
              ownerId: OWNER_ID,
              agentId: AGENT_ID,
              runId: resource.runId,
              expectedRevision: 2,
              authority: AUTHORITY.lease,
              idempotencyKey: createIdempotencyKey("cancel-suspension"),
              commandFingerprint: "cancel-suspension",
              payloadRef: "payload-run-dispatch",
            });
            const lateApproval = openQualifiedDatabase(resource.databasePath);
            lateApproval
              .prepare(
                "UPDATE approval_requests SET status = 'approved', revision = 2 WHERE id = 'approval-suspension'",
              )
              .run();
            lateApproval.close();
            await repository.close();
            repository = await open();
            expect(
              (
                await repository
                  .runCheckpointStore(OWNER_ID, AGENT_ID, AUTHORITY.product)
                  .read(resource.runId)
              )?.checkpoint,
            ).toMatchObject({ phase: "cancelled", terminalStatus: "cancelled" });
            expect(
              await dispatchPort("late-approval").listClaimable({ now: NOW, limit: 10 }),
            ).toEqual([]);
            return;
          }
          if (decision === "approved" || decision === "denied") {
            const approvalDb = openQualifiedDatabase(resource.databasePath);
            approvalDb
              .prepare(
                "UPDATE approval_requests SET status = ?, revision = 2 WHERE id = 'approval-suspension'",
              )
              .run(decision);
            approvalDb.close();
          }
          const now = decision === "expired" ? LATER : NOW;
          const candidates = await second.listClaimable({ now, limit: 10 });
          expect(candidates).toEqual([
            expect.objectContaining({
              runId: resource.runId,
              action: "resume",
              checkpointPhase: "awaiting_approval",
            }),
          ]);
          const fresh = await second.claim({
            runId: resource.runId,
            expectedRunRevision: 2,
            expectedLeaseRevision: currentLease?.revision ?? 0,
            executionLeaseId: leaseId("approved-resume"),
            claimedAt: now,
            expiresAt: "2026-09-04T01:00:00.000Z",
          });
          expect(fresh.executionLeaseId).not.toBe(claim.executionLeaseId);
          expect(await dispatchPort("competitor").listClaimable({ now, limit: 10 })).toEqual([]);
        } finally {
          await repository.close();
        }
      },
    );
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
        database
          .prepare("UPDATE deployments SET fencing_token = 2 WHERE id = ?")
          .run(DEPLOYMENT_ID);
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

    it("blocks a Run with a reconcile-required budget until its late result settles", async () => {
      const resource = await fixture();
      const repository = await SqliteProductStateRepository.open({
        stateRoot: path.dirname(resource.databasePath),
        databasePath: resource.databasePath,
        minimumFreeBytes: 0,
        now: () => NOW,
      });
      try {
        const runDispatch = repository.runDispatch(
          OWNER_ID,
          AGENT_ID,
          AUTHORITY.product,
          { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
          "budget-reconcile-consumer",
        );
        const claimed = await runDispatch.claim({
          runId: resource.runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: 0,
          executionLeaseId: leaseId("execution-budget-reconcile"),
          claimedAt: NOW,
          expiresAt: "2026-09-04T00:05:00.000Z",
        });
        const budget = repository.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY.product, {
          leaseId: AUTHORITY_LEASE_ID,
          fencingToken: 1,
        });
        const parent = {
          kind: "run" as const,
          runId: resource.runId,
          executionLease: claimFromRunExecutionLease(claimed),
        };
        const limits = {
          accountCostMicros: 1_000,
          globalCostMicros: 10_000,
          perClassificationCostMicros: {
            public: 10_000,
            private: 10_000,
            sensitive: 10_000,
            restricted: 10_000,
          },
        } as const;
        const reserved = await budget.reserve({
          parent,
          operationKey: "budget-reconcile-call",
          modelRef: "approved-model-v1",
          dataClassification: "private",
          estimatedCostMicros: 10,
          limits,
          reservedAt: NOW,
        });
        await budget.markStarted({
          parent,
          operationKey: reserved.allocation.operationKey,
          startedAt: NOW,
        });
        await budget.markUnknown({
          parent: { kind: "run", runId: resource.runId },
          operationKey: reserved.allocation.operationKey,
          observedAt: "2026-09-04T00:00:01.000Z",
          reasonCode: "provider_unresolved",
        });
      } finally {
        await repository.close();
      }

      const database = openQualifiedDatabase(resource.databasePath);
      try {
        const guarded = dispatch(database, scope("budget-reconcile-consumer"));
        expect(await guarded.listClaimable({ now: LATER, limit: 10 })).toEqual([]);
        await expect(
          guarded.claim({
            runId: resource.runId,
            expectedRunRevision: 1,
            expectedLeaseRevision: 1,
            executionLeaseId: leaseId("execution-budget-reconcile-retry"),
            claimedAt: LATER,
            expiresAt: "2026-09-04T00:20:00.000Z",
          }),
        ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      } finally {
        database.close();
      }

      const reopened = await SqliteProductStateRepository.open({
        stateRoot: path.dirname(resource.databasePath),
        databasePath: resource.databasePath,
        minimumFreeBytes: 0,
        now: () => LATER,
      });
      try {
        const budget = reopened.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY.product, {
          leaseId: AUTHORITY_LEASE_ID,
          fencingToken: 1,
        });
        await budget.settle({
          parent: { kind: "run", runId: resource.runId },
          operationKey: "budget-reconcile-call",
          actualCostMicros: 7,
          settledAt: LATER,
        });
      } finally {
        await reopened.close();
      }

      const settledDatabase = openQualifiedDatabase(resource.databasePath);
      try {
        const guarded = dispatch(settledDatabase, scope("budget-reconcile-consumer"));
        await expect(guarded.listClaimable({ now: LATER, limit: 10 })).resolves.toEqual([
          expect.objectContaining({ runId: resource.runId }),
        ]);
        await expect(
          guarded.claim({
            runId: resource.runId,
            expectedRunRevision: 1,
            expectedLeaseRevision: 1,
            executionLeaseId: leaseId("execution-budget-reconcile-reclaimed"),
            claimedAt: LATER,
            expiresAt: "2026-09-04T00:20:00.000Z",
          }),
        ).resolves.toMatchObject({ replayed: false, revision: 2 });
      } finally {
        settledDatabase.close();
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
        await expect(
          checkpointlessDispatch.listClaimable({ now: NOW, limit: 10 }),
        ).resolves.toEqual([]);
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

  describe("durable Run reconciliation", () => {
    it("preserves evidence, stops redispatch and survives reopening", async () => {
      const resource = await fixture({ contextPhase: "runtime_running" });
      const db = openQualifiedDatabase(resource.databasePath);
      try {
        db.prepare(
          "UPDATE run_coordination_checkpoints SET context_ref = 'payload-run-dispatch', runtime_event_count = 7",
        ).run();
        const recovery = dispatch(db, scope("recovery"));
        await recovery.quarantine({
          runId: resource.runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: 0,
          reasonCode: "RUNTIME_ATTEMPT_INTERRUPTED",
          at: LATER,
        });
      } finally {
        db.close();
      }
      const reopened = openQualifiedDatabase(resource.databasePath);
      try {
        const recovery = dispatch(reopened, scope("recovery-next"));
        expect(
          reopened.prepare("SELECT status, revision FROM runs WHERE id = ?").get(resource.runId),
        ).toEqual({ status: "reconciling_external_result", revision: 2 });
        expect(
          reopened
            .prepare(
              "SELECT phase, context_ref, runtime_event_count, diagnostic_code FROM run_coordination_checkpoints WHERE run_id = ?",
            )
            .get(resource.runId),
        ).toEqual({
          phase: "reconciling_external_result",
          context_ref: "payload-run-dispatch",
          runtime_event_count: 7,
          diagnostic_code: "RUNTIME_ATTEMPT_INTERRUPTED",
        });
        await expect(recovery.listClaimable({ now: LATER, limit: 1 })).resolves.toEqual([]);
        await expect(
          recovery.listReconciliationRequired({ now: LATER, limit: 1 }),
        ).resolves.toEqual([]);
        await recovery.quarantine({
          runId: resource.runId,
          expectedRunRevision: 2,
          expectedLeaseRevision: 0,
          reasonCode: "LATER_SCAN",
          at: LATER,
        });
        expect(
          reopened.prepare("SELECT revision FROM runs WHERE id = ?").get(resource.runId),
        ).toEqual({ revision: 2 });
      } finally {
        reopened.close();
      }
    });

    it("rejects a competing live lease and atomically fences its own interrupted execution", async () => {
      const resource = await fixture();
      const db = openQualifiedDatabase(resource.databasePath);
      try {
        const owner = dispatch(db, scope("original"));
        const lease = await owner.claim({
          runId: resource.runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: 0,
          executionLeaseId: leaseId("execution-recovery"),
          claimedAt: NOW,
          expiresAt: LATER,
        });
        const input = {
          runId: resource.runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: lease.revision,
          reasonCode: "RUN_EXECUTION_DEADLINE_EXCEEDED",
          at: NOW,
        };
        await expect(dispatch(db, scope("competing")).quarantine(input)).rejects.toBeInstanceOf(
          ApplicationPortError,
        );
        await expect(owner.quarantine(input)).rejects.toMatchObject({ code: "PORT_CONFLICT" });
        await owner.quarantine({ ...input, executionLeaseId: lease.executionLeaseId });
        await expect(
          owner.assertHeld({
            runId: resource.runId,
            expectedLeaseRevision: lease.revision,
            executionLeaseId: lease.executionLeaseId,
            at: NOW,
          }),
        ).rejects.toBeInstanceOf(ApplicationPortError);
        expect(
          db
            .prepare("SELECT phase FROM run_coordination_checkpoints WHERE run_id = ?")
            .get(resource.runId),
        ).toEqual({ phase: "reconciling_external_result" });
      } finally {
        db.close();
      }
    });

    it("lets a new consumer quarantine an expired lease and reach later candidates", async () => {
      const resource = await fixture();
      const db = openQualifiedDatabase(resource.databasePath);
      try {
        const original = dispatch(db, scope("original"));
        const lease = await original.claim({
          runId: resource.runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: 0,
          executionLeaseId: leaseId("execution-expired"),
          claimedAt: NOW,
          expiresAt: LATER,
        });
        db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(resource.runId);
        const recovery = dispatch(db, scope("after-restart"));
        await recovery.quarantine({
          runId: resource.runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: lease.revision,
          reasonCode: "INTERRUPTED",
          at: LATER,
        });
        addRun(db, {
          runId: "run-later",
          triggerId: "trigger-later",
          sessionId: "session-later",
          turnIndex: 1,
          status: "accepted",
        });
        db.prepare("UPDATE runs SET status = 'running' WHERE id = 'run-later'").run();
        await expect(
          recovery.listReconciliationRequired({ now: LATER, limit: 1 }),
        ).resolves.toEqual([expect.objectContaining({ runId: "run-later" })]);
        await expect(
          original.renew({
            runId: resource.runId,
            expectedLeaseRevision: lease.revision,
            executionLeaseId: lease.executionLeaseId,
            renewedAt: LATER,
            expiresAt: "2026-09-04T00:20:00.000Z",
          }),
        ).rejects.toBeInstanceOf(ApplicationPortError);
      } finally {
        db.close();
      }
    });

    it("rejects stale revisions and revoked authority", async () => {
      const resource = await fixture({ contextPhase: "workers_running" });
      const db = openQualifiedDatabase(resource.databasePath);
      try {
        const recovery = dispatch(db, scope("recovery"));
        const input = {
          runId: resource.runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: 0,
          reasonCode: "INTERRUPTED",
          at: LATER,
        };
        await expect(
          recovery.quarantine({ ...input, expectedRunRevision: 2 }),
        ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
        await expect(
          recovery.quarantine({ ...input, expectedLeaseRevision: 1 }),
        ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
        db.prepare("UPDATE authority_leases SET expires_at = ?").run(NOW);
        await expect(recovery.quarantine(input)).rejects.toMatchObject({
          code: "PORT_NOT_AUTHORITATIVE",
        });
        expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(resource.runId)).toEqual({
          status: "running",
        });
      } finally {
        db.close();
      }
    });

    it("rolls back Run and lease changes when checkpoint persistence fails", async () => {
      const resource = await fixture();
      const db = openQualifiedDatabase(resource.databasePath);
      try {
        const recovery = dispatch(db, scope("recovery"));
        const lease = await recovery.claim({
          runId: resource.runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: 0,
          executionLeaseId: leaseId("execution-rollback"),
          claimedAt: NOW,
          expiresAt: LATER,
        });
        db.exec(
          "CREATE TRIGGER fail_recovery BEFORE INSERT ON run_coordination_checkpoints BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
        );
        await expect(
          recovery.quarantine({
            runId: resource.runId,
            expectedRunRevision: 1,
            expectedLeaseRevision: lease.revision,
            executionLeaseId: lease.executionLeaseId,
            reasonCode: "INTERRUPTED",
            at: NOW,
          }),
        ).rejects.toThrow("injected failure");
        expect(
          db.prepare("SELECT status, revision FROM runs WHERE id = ?").get(resource.runId),
        ).toEqual({ status: "accepted", revision: 1 });
        await expect(
          recovery.assertHeld({
            runId: resource.runId,
            expectedLeaseRevision: lease.revision,
            executionLeaseId: lease.executionLeaseId,
            at: NOW,
          }),
        ).resolves.toBeDefined();
      } finally {
        db.close();
      }
    });

    it("preserves Owner cancellation and terminal checkpoints", async () => {
      const resource = await fixture({ contextPhase: "runtime_running" });
      const db = openQualifiedDatabase(resource.databasePath);
      try {
        db.prepare("UPDATE runs SET status = 'cancelled'").run();
        db.prepare(
          "UPDATE run_coordination_checkpoints SET phase = 'cancelled', terminal_status = 'cancelled'",
        ).run();
        await dispatch(db, scope("recovery")).quarantine({
          runId: resource.runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: 0,
          reasonCode: "INTERRUPTED",
          at: LATER,
        });
        expect(
          db.prepare("SELECT status, revision FROM runs WHERE id = ?").get(resource.runId),
        ).toEqual({ status: "cancelled", revision: 1 });
        expect(
          db
            .prepare("SELECT phase FROM run_coordination_checkpoints WHERE run_id = ?")
            .get(resource.runId),
        ).toEqual({ phase: "cancelled" });
      } finally {
        db.close();
      }
    });
  });
});
