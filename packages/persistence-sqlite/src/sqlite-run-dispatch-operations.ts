import type { RunExecutionLease, RunReconciliationPort } from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
  createRunExecutionLeaseId,
  createRunId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import type Database from "better-sqlite3";

type Failure = (code: string, message: string, details?: Readonly<Record<string, string>>) => never;

interface DispatchScope {
  readonly ownerId: string;
  readonly agentId: string;
  readonly authority: ProductAuthorityFence;
  readonly authorityLease: {
    readonly leaseId: string;
    readonly fencingToken: number;
  };
  readonly consumerId: string;
}

interface RunRow {
  readonly id: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly triggerId: string;
  readonly threadId: string | null;
  readonly revision: number;
  readonly status: string;
  readonly checkpointPhase: string | null;
  readonly leaseRevision: number;
  readonly turnIndex: number | null;
}

interface LeaseRow {
  readonly ownerId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly revision: number;
  readonly authorityLeaseId: string;
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly consumerId: string;
  readonly executionLeaseId: string;
  readonly claimedAt: string;
  readonly initialExpiresAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
}

const RUN_DISPATCHABLE_STATUSES = [
  "accepted",
  "building_context",
  "running",
  "awaiting_approval",
] as const;
const RESUMABLE_CHECKPOINT_PHASES = [
  "context_formed",
  "runtime_settled",
  "awaiting_approval",
] as const;
const RECONCILIATION_CHECKPOINT_PHASES = [
  "workers_running",
  "runtime_running",
  "reconciling_external_result",
] as const;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("SQLite Run dispatch row must be an object");
  }
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a nonempty string`);
  }
  return value;
}

function machineText(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) {
    throw new TypeError(`${field} must be a machine identifier`);
  }
  return result;
}

function safeInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${field} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function instant(value: unknown, field: string): string {
  const result = text(value, field);
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${field} must be an ISO time`);
  return result;
}

function assertTimeOrder(earlier: string, later: string, field: string): void {
  if (!isAfter(later, earlier)) {
    throw new TypeError(`${field} must be after its start time`);
  }
}

function isAfter(value: string, boundary: string): boolean {
  const parsedValue = Date.parse(value);
  const parsedBoundary = Date.parse(boundary);
  return (
    Number.isFinite(parsedValue) && Number.isFinite(parsedBoundary) && parsedValue > parsedBoundary
  );
}

function isAtOrAfter(value: string, boundary: string): boolean {
  const parsedValue = Date.parse(value);
  const parsedBoundary = Date.parse(boundary);
  return (
    Number.isFinite(parsedValue) && Number.isFinite(parsedBoundary) && parsedValue >= parsedBoundary
  );
}

function numberValue(row: Record<string, unknown>, key: string): number {
  return safeInteger(row[key], key);
}

function optionalTextValue(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : text(value, key);
}

export class SqliteRunDispatchOperations {
  private readonly database: Database.Database;
  private readonly scope: DispatchScope;
  private readonly fail: Failure;

  constructor(database: Database.Database, scope: DispatchScope, fail: Failure) {
    this.database = database;
    this.scope = {
      ownerId: createOwnerId(scope.ownerId),
      agentId: createAgentId(scope.agentId),
      authority: {
        deploymentId: createDeploymentId(scope.authority.deploymentId),
        authorityEpoch: safeInteger(scope.authority.authorityEpoch, "authorityEpoch", 1),
        fencingToken: safeInteger(scope.authority.fencingToken, "fencingToken", 1),
      },
      authorityLease: {
        leaseId: createAuthorityLeaseId(scope.authorityLease.leaseId),
        fencingToken: safeInteger(scope.authorityLease.fencingToken, "lease.fencingToken", 1),
      },
      consumerId: machineText(scope.consumerId, "consumerId"),
    };
    this.fail = fail;
  }

  execute(operation: string, input: unknown): unknown {
    try {
      const value = record(input);
      switch (operation) {
        case "runDispatch.listClaimable":
          return this.listClaimableSync(value as { readonly now: string; readonly limit: number });
        case "runDispatch.listReconciliationRequired":
          return this.listReconciliationRequiredSync(
            value as {
              readonly now: string;
              readonly limit: number;
            },
          );
        case "runDispatch.quarantine":
          return this.quarantineSync(value as Parameters<RunReconciliationPort["quarantine"]>[0]);
        case "runDispatch.claim":
          return this.claimSync(value as Parameters<SqliteRunDispatchOperations["claim"]>[0]);
        case "runDispatch.renew":
          return this.renewSync(value as Parameters<SqliteRunDispatchOperations["renew"]>[0]);
        case "runDispatch.release":
          return this.releaseSync(value as Parameters<SqliteRunDispatchOperations["release"]>[0]);
        case "runDispatch.assertHeld":
          return this.assertHeldSync(
            value as Parameters<SqliteRunDispatchOperations["assertHeld"]>[0],
          );
        default:
          return this.fail("PORT_INVALID_OPERATION", "Unknown Run dispatch operation");
      }
    } catch (error) {
      if (error instanceof TypeError) return this.fail("PORT_INVALID_OPERATION", error.message);
      throw error;
    }
  }

  async listClaimable(input: { readonly now: string; readonly limit: number }) {
    return this.listClaimableSync(input);
  }

  private listClaimableSync(input: { readonly now: string; readonly limit: number }) {
    const now = instant(input.now, "now");
    const limit = safeInteger(input.limit, "limit", 1);
    this.assertCurrentAuthority(now);
    const rows = this.database
      .prepare(
        `SELECT r.id, r.owner_id, r.agent_id, r.session_id, r.trigger_id, r.thread_id,
          r.revision, r.status, c.phase AS checkpoint_phase,
          COALESCE(l.revision, 0) AS lease_revision,
          current_turn.turn_index
         FROM runs r
         LEFT JOIN run_coordination_checkpoints c
           ON c.run_id = r.id AND c.owner_id = r.owner_id AND c.agent_id = r.agent_id
         LEFT JOIN run_execution_leases l
           ON l.run_id = r.id AND l.owner_id = r.owner_id AND l.agent_id = r.agent_id
         LEFT JOIN (
           SELECT owner_id, agent_id, run_id, thread_id, MIN(turn_index) AS turn_index
           FROM turns
           GROUP BY owner_id, agent_id, run_id, thread_id
         ) current_turn
           ON current_turn.run_id = r.id AND current_turn.owner_id = r.owner_id
             AND current_turn.agent_id = r.agent_id
         WHERE r.owner_id = ? AND r.agent_id = ?
           AND r.status IN ('accepted', 'building_context', 'running', 'awaiting_approval')
           AND (
             (r.status = 'accepted' AND (c.phase IS NULL OR c.phase = 'accepted'))
             OR c.phase IN ('context_formed', 'runtime_settled')
             OR (c.phase = 'awaiting_approval' AND EXISTS (
               SELECT 1 FROM approval_requests approval
               WHERE approval.id = json_extract(c.suspension_json, '$.approval.approvalRequestId')
                 AND approval.owner_id = r.owner_id AND approval.agent_id = r.agent_id AND approval.run_id = r.id
                 AND approval.semantic_snapshot_hash = json_extract(c.suspension_json, '$.approval.semanticSnapshotHash')
                 AND (approval.status <> 'pending' OR MIN(json_extract(c.suspension_json, '$.approval.expiresAt'), COALESCE(json_extract(c.suspension_json, '$.executionDeadlineAt'), json_extract(c.suspension_json, '$.approval.expiresAt'))) <= ?)
             ))
           )
           AND (l.run_id IS NULL OR l.released_at IS NOT NULL OR l.expires_at <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM model_budget_accounts budget
             WHERE budget.owner_id = r.owner_id
               AND budget.agent_id = r.agent_id
               AND budget.run_id = r.id
               AND budget.status = 'reconcile_required'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM turns earlier_turn
             JOIN runs earlier_run ON earlier_run.id = earlier_turn.run_id
               AND earlier_run.owner_id = earlier_turn.owner_id
               AND earlier_run.agent_id = earlier_turn.agent_id
             WHERE current_turn.thread_id IS NOT NULL
               AND earlier_turn.thread_id = current_turn.thread_id
               AND earlier_turn.turn_index < current_turn.turn_index
               AND earlier_run.status IN (
                 'accepted', 'building_context', 'running', 'reconciling_external_result'
               )
           )
         ORDER BY r.created_at, r.id
         LIMIT ?`,
      )
      .all(this.scope.ownerId, this.scope.agentId, now, now, limit);
    return rows.map((row) => this.candidate(record(row), false));
  }

  async listReconciliationRequired(input: { readonly now: string; readonly limit: number }) {
    return this.listReconciliationRequiredSync(input);
  }

  private listReconciliationRequiredSync(input: { readonly now: string; readonly limit: number }) {
    const now = instant(input.now, "now");
    const limit = safeInteger(input.limit, "limit", 1);
    this.assertCurrentAuthority(now);
    const rows = this.database
      .prepare(
        `SELECT r.id, r.owner_id, r.agent_id, r.session_id, r.trigger_id, r.thread_id,
          r.revision, r.status, c.phase AS checkpoint_phase,
          COALESCE(l.revision, 0) AS lease_revision,
          current_turn.turn_index
         FROM runs r
         LEFT JOIN run_coordination_checkpoints c
           ON c.run_id = r.id AND c.owner_id = r.owner_id AND c.agent_id = r.agent_id
         LEFT JOIN run_execution_leases l
           ON l.run_id = r.id AND l.owner_id = r.owner_id AND l.agent_id = r.agent_id
         LEFT JOIN (
           SELECT owner_id, agent_id, run_id, thread_id, MIN(turn_index) AS turn_index
           FROM turns
           GROUP BY owner_id, agent_id, run_id, thread_id
         ) current_turn
           ON current_turn.run_id = r.id AND current_turn.owner_id = r.owner_id
             AND current_turn.agent_id = r.agent_id
         WHERE r.owner_id = ? AND r.agent_id = ?
           AND r.status IN ('accepted', 'building_context', 'running', 'reconciling_external_result')
           AND NOT (r.status = 'reconciling_external_result'
             AND COALESCE(c.phase, '') = 'reconciling_external_result')
           AND (
             c.phase IN ('workers_running', 'runtime_running', 'reconciling_external_result')
             OR (c.phase IS NULL AND r.status IN ('building_context', 'running'))
             OR EXISTS (
               SELECT 1 FROM model_budget_accounts budget
               WHERE budget.owner_id = r.owner_id
                 AND budget.agent_id = r.agent_id
                 AND budget.run_id = r.id
                 AND budget.status = 'reconcile_required'
             )
           )
           AND (l.run_id IS NULL OR l.released_at IS NOT NULL OR l.expires_at <= ?)
         ORDER BY r.created_at, r.id
         LIMIT ?`,
      )
      .all(this.scope.ownerId, this.scope.agentId, now, limit);
    return rows.map((row) => this.candidate(record(row), true));
  }

  async quarantine(input: Parameters<RunReconciliationPort["quarantine"]>[0]): Promise<void> {
    this.quarantineSync(input);
  }

  private quarantineSync(input: Parameters<RunReconciliationPort["quarantine"]>[0]): void {
    const runId = createRunId(input.runId);
    const at = instant(input.at, "at");
    const revision = safeInteger(input.expectedRunRevision, "expectedRunRevision", 1);
    const leaseRevision = safeInteger(input.expectedLeaseRevision, "expectedLeaseRevision");
    const reasonCode = machineText(input.reasonCode, "reasonCode");
    this.database
      .transaction(() => {
        this.assertCurrentAuthority(at);
        const run = this.readRun(runId);
        if (!run) return this.fail("PORT_NOT_AUTHORITATIVE", "Run is outside the bound scope");
        if (run.revision !== revision || run.leaseRevision !== leaseRevision)
          return this.fail("PORT_CONFLICT", "Run changed before reconciliation", { runId });
        // Never reopen a completed or Owner-cancelled Run.
        if (["completed", "failed", "cancelled"].includes(run.status)) return;
        if (
          !["accepted", "building_context", "running", "reconciling_external_result"].includes(
            run.status,
          )
        )
          return this.fail("PORT_CONFLICT", "Run is not eligible for reconciliation", { runId });
        const lease = this.readLease(runId);
        if (lease && lease.releasedAt === null && isAfter(lease.expiresAt, at)) {
          this.assertLeaseScope(lease, true);
          if (lease.executionLeaseId !== input.executionLeaseId)
            return this.fail("PORT_CONFLICT", "Cannot interrupt another live execution", { runId });
        }
        if (lease && lease.releasedAt === null) {
          this.database
            .prepare(`UPDATE run_execution_leases SET revision = revision + 1, released_at = ?
          WHERE run_id = ? AND owner_id = ? AND agent_id = ?`)
            .run(at, runId, this.scope.ownerId, this.scope.agentId);
        }
        if (
          run.status === "reconciling_external_result" &&
          run.checkpointPhase === "reconciling_external_result"
        )
          return;
        this.database
          .prepare(`UPDATE runs SET status = 'reconciling_external_result',
        revision = revision + 1, updated_at = ? WHERE id = ? AND owner_id = ? AND agent_id = ?`)
          .run(at, runId, this.scope.ownerId, this.scope.agentId);
        // Preserve every context, observed output and Worker result reference.
        this.database
          .prepare(`INSERT INTO run_coordination_checkpoints
        (run_id, owner_id, agent_id, revision, phase, runtime_event_count, diagnostic_code, updated_at)
        VALUES (?, ?, ?, 1, 'reconciling_external_result', 0, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET revision = revision + 1,
        phase = 'reconciling_external_result', diagnostic_code = excluded.diagnostic_code,
        updated_at = excluded.updated_at`)
          .run(runId, this.scope.ownerId, this.scope.agentId, reasonCode, at);
      })
      .immediate();
  }

  async claim(input: {
    readonly runId: string;
    readonly expectedRunRevision: number;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: string;
    readonly claimedAt: string;
    readonly expiresAt: string;
  }) {
    return this.claimSync(input);
  }

  private claimSync(input: {
    readonly runId: string;
    readonly expectedRunRevision: number;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: string;
    readonly claimedAt: string;
    readonly expiresAt: string;
  }) {
    const runId = createRunId(machineText(input.runId, "runId"));
    const expectedRunRevision = safeInteger(input.expectedRunRevision, "expectedRunRevision");
    const expectedLeaseRevision = safeInteger(input.expectedLeaseRevision, "expectedLeaseRevision");
    const executionLeaseId = machineText(input.executionLeaseId, "executionLeaseId");
    const claimedAt = instant(input.claimedAt, "claimedAt");
    const expiresAt = instant(input.expiresAt, "expiresAt");
    assertTimeOrder(claimedAt, expiresAt, "expiresAt");

    const claim = this.database.transaction(() => {
      this.assertCurrentAuthority(claimedAt);
      const run = this.readRun(runId);
      if (!run)
        return this.fail("PORT_NOT_AUTHORITATIVE", "Run is outside the bound scope", { runId });
      const current = this.readLease(runId);
      if (current) {
        if (current.releasedAt === null && isAfter(current.expiresAt, claimedAt)) {
          this.assertLeaseScope(current, true);
        }
        if (current.executionLeaseId === executionLeaseId && current.releasedAt !== null) {
          return this.fail("PORT_CONFLICT", "Execution lease identity has already ended", {
            runId,
          });
        }
        if (
          current.executionLeaseId === executionLeaseId &&
          current.revision === expectedLeaseRevision + 1 &&
          current.releasedAt === null &&
          isAfter(current.expiresAt, claimedAt) &&
          current.claimedAt === claimedAt &&
          current.initialExpiresAt === expiresAt
        ) {
          return { ...this.toLease(current), replayed: true as const };
        }
        if (current.revision !== expectedLeaseRevision) {
          return this.fail("PORT_CONFLICT", "Run execution lease revision conflict", { runId });
        }
        if (current.releasedAt === null && isAfter(current.expiresAt, claimedAt)) {
          return this.fail("PORT_CONFLICT", "Run is already claimed by another consumer", {
            runId,
          });
        }
      } else if (expectedLeaseRevision !== 0) {
        return this.fail("PORT_CONFLICT", "Run execution lease revision conflict", { runId });
      }
      this.assertRunBudgetDispatchable(runId);
      const existingIdentity = this.readLeaseByExecutionId(executionLeaseId);
      if (
        existingIdentity &&
        (existingIdentity.ownerId !== this.scope.ownerId ||
          existingIdentity.agentId !== this.scope.agentId ||
          existingIdentity.runId !== runId)
      ) {
        return this.fail("PORT_CONFLICT", "Execution lease identity is already in use", { runId });
      }
      if (run.revision !== expectedRunRevision) {
        return this.fail("PORT_CONFLICT", "Run revision conflict", { runId });
      }
      this.assertDispatchable(run, claimedAt);
      const revision = expectedLeaseRevision + 1;
      this.database
        .prepare(
          `INSERT INTO run_execution_leases (
             owner_id, agent_id, run_id, revision, authority_lease_id, deployment_id,
             authority_epoch, fencing_token, consumer_id, execution_lease_id,
             claimed_at, initial_expires_at, expires_at, released_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(owner_id, agent_id, run_id) DO UPDATE SET
             revision = excluded.revision,
             authority_lease_id = excluded.authority_lease_id,
             deployment_id = excluded.deployment_id,
             authority_epoch = excluded.authority_epoch,
             fencing_token = excluded.fencing_token,
             consumer_id = excluded.consumer_id,
             execution_lease_id = excluded.execution_lease_id,
             claimed_at = excluded.claimed_at,
             initial_expires_at = excluded.initial_expires_at,
             expires_at = excluded.expires_at,
             released_at = NULL`,
        )
        .run(
          this.scope.ownerId,
          this.scope.agentId,
          runId,
          revision,
          this.scope.authorityLease.leaseId,
          this.scope.authority.deploymentId,
          this.scope.authority.authorityEpoch,
          this.scope.authority.fencingToken,
          this.scope.consumerId,
          executionLeaseId,
          claimedAt,
          expiresAt,
          expiresAt,
        );
      const created = this.readLease(runId);
      if (!created)
        return this.fail("PORT_INVALID_OPERATION", "Claimed lease could not be read", { runId });
      return { ...this.toLease(created), replayed: false as const };
    });
    return claim.immediate();
  }

  async renew(input: {
    readonly runId: string;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: string;
    readonly renewedAt: string;
    readonly expiresAt: string;
  }) {
    return this.renewSync(input);
  }

  private renewSync(input: {
    readonly runId: string;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: string;
    readonly renewedAt: string;
    readonly expiresAt: string;
  }) {
    const runId = createRunId(machineText(input.runId, "runId"));
    const expectedLeaseRevision = safeInteger(input.expectedLeaseRevision, "expectedLeaseRevision");
    const executionLeaseId = machineText(input.executionLeaseId, "executionLeaseId");
    const renewedAt = instant(input.renewedAt, "renewedAt");
    const expiresAt = instant(input.expiresAt, "expiresAt");
    assertTimeOrder(renewedAt, expiresAt, "expiresAt");
    const renew = this.database.transaction(() => {
      this.assertCurrentAuthority(renewedAt);
      const current = this.readLease(runId);
      if (
        !current ||
        current.executionLeaseId !== executionLeaseId ||
        current.revision !== expectedLeaseRevision ||
        current.releasedAt !== null ||
        !isAfter(current.expiresAt, renewedAt)
      ) {
        return this.fail("PORT_CONFLICT", "Run execution lease is not renewable", { runId });
      }
      if (!isAtOrAfter(renewedAt, current.claimedAt)) {
        return this.fail("PORT_CONFLICT", "Run execution lease renewal time precedes its claim", {
          runId,
        });
      }
      if (!isAtOrAfter(expiresAt, current.expiresAt)) {
        return this.fail("PORT_CONFLICT", "Run execution lease expiry cannot move backwards", {
          runId,
        });
      }
      this.assertLeaseScope(current, true);
      const replayed = expiresAt === current.expiresAt;
      if (!replayed) {
        this.database
          .prepare(
            `UPDATE run_execution_leases
             SET expires_at = ?
             WHERE owner_id = ? AND agent_id = ? AND run_id = ?
               AND revision = ? AND execution_lease_id = ? AND released_at IS NULL`,
          )
          .run(
            expiresAt,
            this.scope.ownerId,
            this.scope.agentId,
            runId,
            expectedLeaseRevision,
            executionLeaseId,
          );
      }
      const renewed = this.readLease(runId);
      if (!renewed)
        return this.fail("PORT_INVALID_OPERATION", "Renewed lease could not be read", { runId });
      return { ...this.toLease(renewed), replayed };
    });
    return renew.immediate();
  }

  async release(input: {
    readonly runId: string;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: string;
    readonly releasedAt: string;
  }) {
    return this.releaseSync(input);
  }

  private releaseSync(input: {
    readonly runId: string;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: string;
    readonly releasedAt: string;
  }) {
    const runId = createRunId(machineText(input.runId, "runId"));
    const expectedLeaseRevision = safeInteger(input.expectedLeaseRevision, "expectedLeaseRevision");
    const executionLeaseId = machineText(input.executionLeaseId, "executionLeaseId");
    const releasedAt = instant(input.releasedAt, "releasedAt");
    const release = this.database.transaction(() => {
      this.assertCurrentAuthority(releasedAt);
      const current = this.readLease(runId);
      if (!current || current.executionLeaseId !== executionLeaseId) {
        return this.fail("PORT_CONFLICT", "Run execution lease is not releasable", { runId });
      }
      this.assertLeaseScope(current, true);
      if (
        current.revision !== expectedLeaseRevision ||
        current.releasedAt !== null ||
        !isAfter(current.expiresAt, releasedAt)
      ) {
        return this.fail("PORT_CONFLICT", "Run execution lease is not releasable", { runId });
      }
      const revision = expectedLeaseRevision + 1;
      this.database
        .prepare(
          `UPDATE run_execution_leases
           SET revision = ?, released_at = ?
           WHERE owner_id = ? AND agent_id = ? AND run_id = ?
             AND revision = ? AND execution_lease_id = ? AND released_at IS NULL`,
        )
        .run(
          revision,
          releasedAt,
          this.scope.ownerId,
          this.scope.agentId,
          runId,
          expectedLeaseRevision,
          executionLeaseId,
        );
      const released = this.readLease(runId);
      if (!released)
        return this.fail("PORT_INVALID_OPERATION", "Released lease could not be read", { runId });
      return { ...this.toLease(released), replayed: false as const };
    });
    return release.immediate();
  }

  /**
   * Assert an execution lease while the caller's synchronous SQLite
   * transaction is open.  This method intentionally does not start a nested
   * transaction and must be called before the caller's guarded write.
   */
  assertHeldInTransaction(input: {
    readonly runId: string;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: string;
    readonly at: string;
  }) {
    if (!this.database.inTransaction) {
      return this.fail(
        "PORT_INVALID_OPERATION",
        "Execution lease assertion requires an active SQLite transaction",
      );
    }
    const runId = createRunId(machineText(input.runId, "runId"));
    const expectedLeaseRevision = safeInteger(input.expectedLeaseRevision, "expectedLeaseRevision");
    const executionLeaseId = machineText(input.executionLeaseId, "executionLeaseId");
    const at = instant(input.at, "at");
    return this.assertHeldParsed({ runId, expectedLeaseRevision, executionLeaseId, at });
  }

  async assertHeld(input: {
    readonly runId: string;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: string;
    readonly at: string;
  }) {
    return this.assertHeldSync(input);
  }

  private assertHeldSync(input: {
    readonly runId: string;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: string;
    readonly at: string;
  }) {
    const runId = createRunId(machineText(input.runId, "runId"));
    const expectedLeaseRevision = safeInteger(input.expectedLeaseRevision, "expectedLeaseRevision");
    const executionLeaseId = machineText(input.executionLeaseId, "executionLeaseId");
    const at = instant(input.at, "at");
    const assertHeld = this.database.transaction(() =>
      this.assertHeldParsed({ runId, expectedLeaseRevision, executionLeaseId, at }),
    );
    return assertHeld();
  }

  /**
   * Invalidate the current execution lease as part of the canonical Owner
   * cancellation transaction.  This method never mutates `runs.status`; the
   * Run lifecycle writer remains the sole owner of that state transition.
   */
  invalidateForOwnerCancellationInTransaction(input: {
    readonly runId: string;
    readonly at: string;
  }) {
    if (!this.database.inTransaction) {
      return this.fail(
        "PORT_INVALID_OPERATION",
        "Owner cancellation lease invalidation requires an active SQLite transaction",
      );
    }
    const runId = createRunId(machineText(input.runId, "runId"));
    const at = instant(input.at, "at");
    this.assertCurrentAuthority(at);
    const run = this.readRun(runId);
    if (!run)
      return this.fail("PORT_NOT_AUTHORITATIVE", "Run is outside the bound scope", { runId });
    const current = this.readLease(runId);
    if (!current || current.releasedAt !== null) return null;
    this.database
      .prepare(
        `UPDATE run_execution_leases
         SET revision = ?, released_at = ?
         WHERE owner_id = ? AND agent_id = ? AND run_id = ?
           AND revision = ? AND released_at IS NULL`,
      )
      .run(
        current.revision + 1,
        at,
        this.scope.ownerId,
        this.scope.agentId,
        runId,
        current.revision,
      );
    const invalidated = this.readLease(runId);
    if (!invalidated) {
      return this.fail(
        "PORT_INVALID_OPERATION",
        "Owner cancellation lease invalidation could not be read",
        { runId },
      );
    }
    return this.toLease(invalidated);
  }

  private assertHeldParsed(input: {
    readonly runId: ReturnType<typeof createRunId>;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: string;
    readonly at: string;
  }) {
    this.assertCurrentAuthority(input.at);
    const current = this.readLease(input.runId);
    if (
      !current ||
      current.executionLeaseId !== input.executionLeaseId ||
      current.revision !== input.expectedLeaseRevision ||
      current.releasedAt !== null ||
      !isAfter(current.expiresAt, input.at)
    ) {
      return this.fail("PORT_CONFLICT", "Run execution lease is not held", {
        runId: input.runId,
      });
    }
    this.assertLeaseScope(current, true);
    const run = this.readRun(input.runId);
    if (!run)
      return this.fail("PORT_NOT_AUTHORITATIVE", "Run is outside the bound scope", {
        runId: input.runId,
      });
    return this.toLease(current);
  }

  private candidate(row: Record<string, unknown>, reconciliation: boolean) {
    const checkpointPhase = optionalTextValue(row, "checkpoint_phase");
    const runStatus = text(row["status"], "status");
    const action =
      reconciliation || checkpointPhase === null || checkpointPhase === "accepted"
        ? reconciliation
          ? "reconcile"
          : "start"
        : "resume";
    return {
      ownerId: createOwnerId(text(row["owner_id"], "owner_id")),
      agentId: createAgentId(text(row["agent_id"], "agent_id")),
      runId: createRunId(text(row["id"], "id")),
      sessionId: text(row["session_id"], "session_id"),
      triggerId: text(row["trigger_id"], "trigger_id"),
      threadId: row["thread_id"] === null ? null : text(row["thread_id"], "thread_id"),
      runRevision: numberValue(row, "revision"),
      runStatus,
      checkpointPhase,
      leaseRevision: numberValue(row, "lease_revision"),
      action,
    } as const;
  }

  private readRun(runId: string): RunRow | undefined {
    const value = this.database
      .prepare(
        `SELECT r.id, r.owner_id, r.agent_id, r.session_id, r.trigger_id, r.thread_id,
          r.revision, r.status, c.phase AS checkpoint_phase,
          COALESCE(l.revision, 0) AS lease_revision, current_turn.turn_index
         FROM runs r
         LEFT JOIN run_coordination_checkpoints c
           ON c.run_id = r.id AND c.owner_id = r.owner_id AND c.agent_id = r.agent_id
         LEFT JOIN run_execution_leases l
           ON l.run_id = r.id AND l.owner_id = r.owner_id AND l.agent_id = r.agent_id
         LEFT JOIN (
           SELECT owner_id, agent_id, run_id, thread_id, MIN(turn_index) AS turn_index
           FROM turns
           GROUP BY owner_id, agent_id, run_id, thread_id
         ) current_turn
           ON current_turn.run_id = r.id AND current_turn.owner_id = r.owner_id
             AND current_turn.agent_id = r.agent_id
         WHERE r.id = ? AND r.owner_id = ? AND r.agent_id = ?`,
      )
      .get(runId, this.scope.ownerId, this.scope.agentId);
    if (value === undefined) return undefined;
    const row = record(value);
    return {
      id: text(row["id"], "id"),
      ownerId: text(row["owner_id"], "owner_id"),
      agentId: text(row["agent_id"], "agent_id"),
      sessionId: text(row["session_id"], "session_id"),
      triggerId: text(row["trigger_id"], "trigger_id"),
      threadId: row["thread_id"] === null ? null : text(row["thread_id"], "thread_id"),
      revision: numberValue(row, "revision"),
      status: text(row["status"], "status"),
      checkpointPhase: optionalTextValue(row, "checkpoint_phase"),
      leaseRevision: numberValue(row, "lease_revision"),
      turnIndex: row["turn_index"] === null ? null : numberValue(row, "turn_index"),
    };
  }

  private assertRunBudgetDispatchable(runId: string): void {
    const row = this.database
      .prepare(
        `SELECT 1 FROM model_budget_accounts
         WHERE owner_id = ? AND agent_id = ? AND run_id = ?
           AND status = 'reconcile_required' LIMIT 1`,
      )
      .get(this.scope.ownerId, this.scope.agentId, runId);
    if (row !== undefined) {
      this.fail("PORT_CONFLICT", "Run model budget requires reconciliation", { runId });
    }
  }

  private readLease(runId: string): LeaseRow | undefined {
    const value = this.database
      .prepare(
        `SELECT owner_id, agent_id, run_id, revision, authority_lease_id, deployment_id,
          authority_epoch, fencing_token, consumer_id, execution_lease_id,
          claimed_at, initial_expires_at, expires_at, released_at
         FROM run_execution_leases
         WHERE owner_id = ? AND agent_id = ? AND run_id = ?`,
      )
      .get(this.scope.ownerId, this.scope.agentId, runId);
    if (value === undefined) return undefined;
    return this.parseLease(value);
  }

  private readLeaseByExecutionId(executionLeaseId: string): LeaseRow | undefined {
    const value = this.database
      .prepare(
        `SELECT owner_id, agent_id, run_id, revision, authority_lease_id, deployment_id,
          authority_epoch, fencing_token, consumer_id, execution_lease_id,
          claimed_at, initial_expires_at, expires_at, released_at
         FROM run_execution_leases
         WHERE execution_lease_id = ?`,
      )
      .get(executionLeaseId);
    if (value === undefined) return undefined;
    return this.parseLease(value);
  }

  private parseLease(value: unknown): LeaseRow {
    const row = record(value);
    return {
      ownerId: text(row["owner_id"], "owner_id"),
      agentId: text(row["agent_id"], "agent_id"),
      runId: text(row["run_id"], "run_id"),
      revision: numberValue(row, "revision"),
      authorityLeaseId: text(row["authority_lease_id"], "authority_lease_id"),
      deploymentId: text(row["deployment_id"], "deployment_id"),
      authorityEpoch: safeInteger(row["authority_epoch"], "authority_epoch", 1),
      fencingToken: safeInteger(row["fencing_token"], "fencing_token", 1),
      consumerId: text(row["consumer_id"], "consumer_id"),
      executionLeaseId: text(row["execution_lease_id"], "execution_lease_id"),
      claimedAt: text(row["claimed_at"], "claimed_at"),
      initialExpiresAt: text(row["initial_expires_at"], "initial_expires_at"),
      expiresAt: text(row["expires_at"], "expires_at"),
      releasedAt: optionalTextValue(row, "released_at"),
    };
  }

  private toLease(row: LeaseRow): RunExecutionLease {
    return {
      ownerId: createOwnerId(row.ownerId),
      agentId: createAgentId(row.agentId),
      runId: createRunId(row.runId),
      authorityLeaseId: createAuthorityLeaseId(row.authorityLeaseId),
      deploymentId: createDeploymentId(row.deploymentId),
      authorityEpoch: row.authorityEpoch,
      fencingToken: row.fencingToken,
      consumerId: row.consumerId,
      executionLeaseId: createRunExecutionLeaseId(row.executionLeaseId),
      revision: row.revision,
      claimedAt: row.claimedAt,
      expiresAt: row.expiresAt,
      releasedAt: row.releasedAt,
    } as const;
  }

  private assertDispatchable(run: RunRow, now: string): void {
    if (run.checkpointPhase === "awaiting_approval") {
      const ready = this.database
        .prepare(`SELECT 1 FROM run_coordination_checkpoints c
        JOIN approval_requests a ON a.id = json_extract(c.suspension_json, '$.approval.approvalRequestId')
        AND a.owner_id = c.owner_id AND a.agent_id = c.agent_id AND a.run_id = c.run_id
        AND a.semantic_snapshot_hash = json_extract(c.suspension_json, '$.approval.semanticSnapshotHash')
        WHERE c.run_id = ? AND c.owner_id = ? AND c.agent_id = ?
        AND (a.status <> 'pending' OR MIN(json_extract(c.suspension_json, '$.approval.expiresAt'), COALESCE(json_extract(c.suspension_json, '$.executionDeadlineAt'), json_extract(c.suspension_json, '$.approval.expiresAt'))) <= ?)`)
        .get(run.id, this.scope.ownerId, this.scope.agentId, now);
      if (!ready) this.fail("PORT_CONFLICT", "Run approval is still pending", { runId: run.id });
    }
    if (
      !RUN_DISPATCHABLE_STATUSES.includes(run.status as (typeof RUN_DISPATCHABLE_STATUSES)[number])
    ) {
      this.fail("PORT_CONFLICT", "Run is not execution-eligible", { runId: run.id });
    }
    if (
      RECONCILIATION_CHECKPOINT_PHASES.includes(
        run.checkpointPhase as (typeof RECONCILIATION_CHECKPOINT_PHASES)[number],
      )
    ) {
      this.fail("PORT_CONFLICT", "Run requires external-result reconciliation", {
        runId: run.id,
      });
    }
    if (
      run.checkpointPhase !== null &&
      !RESUMABLE_CHECKPOINT_PHASES.includes(
        run.checkpointPhase as (typeof RESUMABLE_CHECKPOINT_PHASES)[number],
      ) &&
      run.checkpointPhase !== "accepted"
    ) {
      this.fail("PORT_CONFLICT", "Run checkpoint is not claimable", { runId: run.id });
    }
    if (run.checkpointPhase === null && run.status !== "accepted") {
      this.fail("PORT_CONFLICT", "Run lacks a durable dispatch checkpoint", {
        runId: run.id,
      });
    }
    if (
      run.threadId !== null &&
      run.turnIndex !== null &&
      this.database
        .prepare(
          `SELECT 1
           FROM turns earlier_turn
           JOIN runs earlier_run ON earlier_run.id = earlier_turn.run_id
             AND earlier_run.owner_id = earlier_turn.owner_id
             AND earlier_run.agent_id = earlier_turn.agent_id
           WHERE earlier_turn.owner_id = ? AND earlier_turn.agent_id = ?
             AND earlier_turn.thread_id = ? AND earlier_turn.turn_index < ?
             AND earlier_run.status IN (
               'accepted', 'building_context', 'running', 'reconciling_external_result'
             )
           LIMIT 1`,
        )
        .get(this.scope.ownerId, this.scope.agentId, run.threadId, run.turnIndex)
    ) {
      this.fail("PORT_CONFLICT", "An earlier Run in this Thread is still executing", {
        runId: run.id,
      });
    }
  }

  private assertLeaseScope(row: LeaseRow, includeConsumer: boolean): void {
    if (
      row.authorityLeaseId !== this.scope.authorityLease.leaseId ||
      row.deploymentId !== this.scope.authority.deploymentId ||
      row.authorityEpoch !== this.scope.authority.authorityEpoch ||
      row.fencingToken !== this.scope.authority.fencingToken ||
      row.fencingToken !== this.scope.authorityLease.fencingToken
    ) {
      this.fail("PORT_NOT_AUTHORITATIVE", "Execution lease authority is stale", {
        runId: row.runId,
      });
    }
    if (includeConsumer && row.consumerId !== this.scope.consumerId) {
      this.fail("PORT_CONFLICT", "Execution lease belongs to another consumer", {
        runId: row.runId,
      });
    }
  }

  private assertCurrentAuthority(now: string): void {
    const rowValue = this.database
      .prepare(
        `SELECT l.id, l.owner_id, l.agent_id, l.deployment_id, l.authority_epoch,
          l.fencing_token, l.expires_at, l.released_at,
          d.status, d.authority_epoch AS deployment_epoch,
          d.fencing_token AS deployment_fencing_token
         FROM authority_leases l
         JOIN deployments d ON d.id = l.deployment_id
           AND d.owner_id = l.owner_id AND d.agent_id = l.agent_id
         WHERE l.id = ? AND l.owner_id = ? AND l.agent_id = ?`,
      )
      .get(this.scope.authorityLease.leaseId, this.scope.ownerId, this.scope.agentId);
    if (rowValue === undefined) {
      this.fail("PORT_NOT_AUTHORITATIVE", "Authority lease is outside the bound scope");
    }
    const row = record(rowValue);
    const currentEpoch = numberValue(row, "authority_epoch");
    const currentToken = numberValue(row, "fencing_token");
    const deploymentEpoch = numberValue(row, "deployment_epoch");
    const deploymentToken = numberValue(row, "deployment_fencing_token");
    if (
      row["status"] !== "active" ||
      row["released_at"] !== null ||
      !isAfter(text(row["expires_at"], "expires_at"), now) ||
      text(row["deployment_id"], "deployment_id") !== this.scope.authority.deploymentId ||
      currentEpoch !== this.scope.authority.authorityEpoch ||
      currentEpoch !== deploymentEpoch ||
      currentToken !== this.scope.authority.fencingToken ||
      currentToken !== this.scope.authorityLease.fencingToken ||
      deploymentToken !== this.scope.authority.fencingToken
    ) {
      this.fail("PORT_NOT_AUTHORITATIVE", "Authority fence is stale or expired", {
        deploymentId: this.scope.authority.deploymentId,
      });
    }
  }
}
