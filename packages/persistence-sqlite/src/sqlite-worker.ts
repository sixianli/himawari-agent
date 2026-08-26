import { createHash } from "node:crypto";
import { statfsSync, statSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import type {
  AuthorityLeaseRecord,
  CommandResultLookup,
  CommandResultRecord,
  CommitStateAndEventsInput,
  CommitStateAndEventsResult,
  JsonObject,
  ReliableEventRecord,
  StateRecord,
} from "@himawari-agent/application";
import type {
  AgentAuthorityLease,
  AgentId,
  AuthorityLeaseId,
  DeploymentAuthorityState,
  DeploymentId,
  ProductAuthorityFence,
} from "@himawari-agent/domain";
import BetterSqlite3 from "better-sqlite3";
import { SqliteDurableOperations } from "./sqlite-durable-operations.ts";
import type { SqliteWorkerConfiguration } from "./sqlite-execution-context.js";

interface WorkerRequest {
  readonly id: number;
  readonly operation: string;
  readonly payload: unknown;
}

interface StateRow {
  readonly key: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly revision: number;
  readonly valueJson: string;
}

interface EventRow {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly payloadRef: string;
  readonly occurredAt: string;
  readonly publishedAt: string | null;
}

interface CommandResultRow {
  readonly ownerId: string;
  readonly agentId: string;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly commandFingerprint: string;
  readonly resultRef: string;
  readonly stateKey: string;
  readonly stateRevision: number;
  readonly committedAt: string;
}

interface AuthorityRow {
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly leaseFencingToken: number;
  readonly deploymentFencingToken: number;
  readonly status: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
}

interface DeploymentRow {
  readonly id: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly revision: number;
  readonly status: DeploymentAuthorityState["status"];
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly transferId: string | null;
}

interface LeaseRow {
  readonly id: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly holderId: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
}

const configuration = workerData as SqliteWorkerConfiguration;
const channel = parentPort;
if (!channel) throw new Error("SQLite execution worker requires a parent port");

const database = new BetterSqlite3(configuration.databasePath);
database.pragma("foreign_keys = ON");
database.pragma("journal_mode = WAL");
database.pragma("synchronous = FULL");
database.pragma(`busy_timeout = ${configuration.busyTimeoutMs}`);
database.pragma("wal_autocheckpoint = 1000");
if (configuration.qualification?.maximumPageCount !== undefined) {
  database.pragma(`max_page_count = ${configuration.qualification.maximumPageCount}`);
}

let lastTransactionDurationMs = 0;

function applicationFailure(
  code: string,
  message: string,
  details: Readonly<Record<string, string>> = {},
): never {
  throw Object.freeze({ kind: "application", code, message, details });
}

function assertCurrentSchema(): void {
  const currentSequence = Number(
    database
      .prepare("SELECT value FROM schema_metadata WHERE key = 'current_sequence'")
      .pluck()
      .get(),
  );
  const minimumWriterSequence = Number(
    database
      .prepare("SELECT value FROM schema_metadata WHERE key = 'minimum_writer_sequence'")
      .pluck()
      .get(),
  );
  if (
    currentSequence !== configuration.writerSequence ||
    minimumWriterSequence > configuration.writerSequence
  ) {
    throw new Error(
      `Writer sequence ${configuration.writerSequence} cannot open schema ${currentSequence}/${minimumWriterSequence}`,
    );
  }
}

assertCurrentSchema();

function stateFromRow(row: StateRow | undefined): StateRecord | undefined {
  if (!row) return undefined;
  return {
    key: row.key,
    revision: row.revision,
    value: JSON.parse(row.valueJson) as JsonObject,
  };
}

function eventFromRow(row: EventRow): ReliableEventRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey as ReliableEventRecord["idempotencyKey"],
    topic: row.topic,
    payloadRef: row.payloadRef,
    occurredAt: row.occurredAt,
    publishedAt: row.publishedAt,
  };
}

function commandResultFromRow(row: CommandResultRow): CommandResultRecord {
  return {
    ownerId: row.ownerId as CommandResultRecord["ownerId"],
    agentId: row.agentId as CommandResultRecord["agentId"],
    idempotencyKey: row.idempotencyKey as CommandResultRecord["idempotencyKey"],
    commandType: row.commandType,
    commandFingerprint: row.commandFingerprint,
    resultRef: row.resultRef,
    stateKey: row.stateKey,
    stateRevision: row.stateRevision,
    committedAt: row.committedAt,
  };
}

function deploymentFromRow(row: DeploymentRow): DeploymentAuthorityState {
  return {
    id: row.id as DeploymentAuthorityState["id"],
    ownerId: row.ownerId as DeploymentAuthorityState["ownerId"],
    agentId: row.agentId as DeploymentAuthorityState["agentId"],
    revision: row.revision,
    status: row.status,
    authorityEpoch: row.authorityEpoch,
    fencingToken: row.fencingToken,
    transferId: row.transferId as DeploymentAuthorityState["transferId"],
  };
}

function leaseFromRow(row: LeaseRow): AuthorityLeaseRecord {
  return {
    lease: {
      id: row.id as AgentAuthorityLease["id"],
      ownerId: row.ownerId as AgentAuthorityLease["ownerId"],
      agentId: row.agentId as AgentAuthorityLease["agentId"],
      holderId: row.holderId as AgentAuthorityLease["holderId"],
    },
    fencingToken: row.fencingToken,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
  };
}

const deploymentSelect = `SELECT id, owner_id AS ownerId, agent_id AS agentId, revision,
  status, authority_epoch AS authorityEpoch, fencing_token AS fencingToken,
  transfer_id AS transferId FROM deployments`;

function readDeployment(deploymentId: DeploymentId): DeploymentAuthorityState | undefined {
  const row = database.prepare(`${deploymentSelect} WHERE id = ?`).get(deploymentId) as
    | DeploymentRow
    | undefined;
  return row ? deploymentFromRow(row) : undefined;
}

function validDeploymentTransition(
  current: DeploymentAuthorityState,
  next: DeploymentAuthorityState,
): boolean {
  if (current.status === "inactive_ready" && next.status === "active") {
    return (
      next.authorityEpoch > current.authorityEpoch &&
      next.fencingToken > 0 &&
      next.transferId === current.transferId
    );
  }
  if (current.status === "active" && next.status === "retired_pending_transfer") {
    return (
      next.authorityEpoch === current.authorityEpoch &&
      next.fencingToken === current.fencingToken &&
      next.transferId === current.transferId
    );
  }
  if (current.status === "retired_pending_transfer" && next.status === "retired") {
    return (
      next.authorityEpoch === current.authorityEpoch &&
      next.fencingToken === current.fencingToken &&
      next.transferId === current.transferId
    );
  }
  return false;
}

function saveDeployment(
  deployment: DeploymentAuthorityState,
  expectedRevision: number,
): DeploymentAuthorityState {
  assertDiskHeadroom();
  const transaction = database.transaction(() => {
    const current = readDeployment(deployment.id);
    if (!current) {
      if (
        expectedRevision !== 0 ||
        deployment.revision !== 0 ||
        deployment.status !== "inactive_ready" ||
        deployment.fencingToken !== 0
      ) {
        applicationFailure("PORT_CONFLICT", "A new deployment must start inactive at revision 0", {
          deploymentId: deployment.id,
          expectedRevision: String(expectedRevision),
        });
      }
      database
        .prepare(
          `INSERT INTO deployments (
            id, owner_id, agent_id, revision, status, authority_epoch, fencing_token, transfer_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deployment.id,
          deployment.ownerId,
          deployment.agentId,
          deployment.revision,
          deployment.status,
          deployment.authorityEpoch,
          deployment.fencingToken,
          deployment.transferId,
        );
      return deployment;
    }
    if (
      current.revision !== expectedRevision ||
      deployment.revision !== expectedRevision + 1 ||
      current.ownerId !== deployment.ownerId ||
      current.agentId !== deployment.agentId ||
      !validDeploymentTransition(current, deployment)
    ) {
      applicationFailure("PORT_CONFLICT", "Deployment revision or lifecycle transition conflicts", {
        deploymentId: deployment.id,
        currentRevision: String(current.revision),
        expectedRevision: String(expectedRevision),
        currentStatus: current.status,
        nextStatus: deployment.status,
      });
    }
    database
      .prepare(
        `UPDATE deployments SET revision = ?, status = ?, authority_epoch = ?,
          fencing_token = ?, transfer_id = ? WHERE id = ?`,
      )
      .run(
        deployment.revision,
        deployment.status,
        deployment.authorityEpoch,
        deployment.fencingToken,
        deployment.transferId,
        deployment.id,
      );
    return deployment;
  });
  return transaction.immediate();
}

function assertCurrentDeployment(fence: ProductAuthorityFence): DeploymentAuthorityState {
  const deployment = readDeployment(fence.deploymentId);
  if (
    !deployment ||
    deployment.status !== "active" ||
    deployment.authorityEpoch !== fence.authorityEpoch ||
    deployment.fencingToken !== fence.fencingToken
  ) {
    applicationFailure("PORT_NOT_AUTHORITATIVE", "Deployment authority fence is stale", {
      deploymentId: fence.deploymentId,
      authorityEpoch: String(fence.authorityEpoch),
      fencingToken: String(fence.fencingToken),
    });
  }
  return deployment;
}

const leaseSelect = `SELECT id, owner_id AS ownerId, agent_id AS agentId,
  holder_id AS holderId, fencing_token AS fencingToken, acquired_at AS acquiredAt,
  expires_at AS expiresAt, released_at AS releasedAt FROM authority_leases`;

function currentLease(agentId: AgentId, now: string): AuthorityLeaseRecord | undefined {
  const row = database
    .prepare(
      `${leaseSelect} WHERE agent_id = ? AND released_at IS NULL AND expires_at > ?
      ORDER BY fencing_token DESC LIMIT 1`,
    )
    .get(agentId, now) as LeaseRow | undefined;
  return row ? leaseFromRow(row) : undefined;
}

function assertLeaseDuration(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    applicationFailure("PORT_INVALID_OPERATION", "Authority lease duration must be positive", {
      durationMs: String(durationMs),
    });
  }
}

function expiresAt(now: string, durationMs: number): string {
  return new Date(new Date(now).valueOf() + durationMs).toISOString();
}

function claimLease(
  lease: AgentAuthorityLease,
  durationMs: number,
  now: string,
): AuthorityLeaseRecord {
  assertLeaseDuration(durationMs);
  assertDiskHeadroom();
  const transaction = database.transaction(() => {
    const current = currentLease(lease.agentId, now);
    if (current) {
      if (
        current.lease.id === lease.id &&
        current.lease.holderId === lease.holderId &&
        current.lease.ownerId === lease.ownerId
      )
        return current;
      applicationFailure("PORT_CONFLICT", `Agent ${lease.agentId} already has a live lease`, {
        agentId: lease.agentId,
        currentLeaseId: current.lease.id,
      });
    }
    const deployment = database
      .prepare(`${deploymentSelect} WHERE owner_id = ? AND agent_id = ? AND status = 'active'`)
      .get(lease.ownerId, lease.agentId) as DeploymentRow | undefined;
    if (!deployment) {
      applicationFailure("PORT_NOT_AUTHORITATIVE", "No active deployment can claim authority", {
        agentId: lease.agentId,
      });
    }
    const previousToken = Number(
      database
        .prepare("SELECT COALESCE(MAX(fencing_token), 0) FROM authority_leases WHERE agent_id = ?")
        .pluck()
        .get(lease.agentId),
    );
    const fencingToken = previousToken + 1;
    database
      .prepare(
        `UPDATE deployments SET fencing_token = ?,
          revision = revision + CASE WHEN fencing_token = ? THEN 0 ELSE 1 END
        WHERE id = ?`,
      )
      .run(fencingToken, fencingToken, deployment.id);
    const acquiredAt = now;
    const leaseExpiresAt = expiresAt(now, durationMs);
    database
      .prepare(
        `INSERT INTO authority_leases (
          id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
          fencing_token, acquired_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lease.id,
        lease.ownerId,
        lease.agentId,
        deployment.id,
        lease.holderId,
        deployment.authorityEpoch,
        fencingToken,
        acquiredAt,
        leaseExpiresAt,
      );
    return { lease, fencingToken, acquiredAt, expiresAt: leaseExpiresAt };
  });
  return transaction.immediate();
}

function renewLease(
  leaseId: AuthorityLeaseId,
  durationMs: number,
  now: string,
): AuthorityLeaseRecord {
  assertLeaseDuration(durationMs);
  const row = database.prepare(`${leaseSelect} WHERE id = ?`).get(leaseId) as LeaseRow | undefined;
  if (!row || row.releasedAt !== null || row.expiresAt <= now) {
    applicationFailure("PORT_NOT_FOUND", `Authority lease ${leaseId} is not live`, { leaseId });
  }
  const leaseExpiresAt = expiresAt(now, durationMs);
  database
    .prepare("UPDATE authority_leases SET expires_at = ? WHERE id = ?")
    .run(leaseExpiresAt, leaseId);
  return leaseFromRow({ ...row, expiresAt: leaseExpiresAt });
}

function releaseLease(leaseId: AuthorityLeaseId, now: string): void {
  const row = database.prepare(`${leaseSelect} WHERE id = ?`).get(leaseId) as LeaseRow | undefined;
  if (!row || row.releasedAt !== null) {
    applicationFailure("PORT_NOT_FOUND", `Authority lease ${leaseId} not found`, { leaseId });
  }
  database.prepare("UPDATE authority_leases SET released_at = ? WHERE id = ?").run(now, leaseId);
}

function readState(key: string): StateRecord | undefined {
  return stateFromRow(
    database
      .prepare(
        "SELECT key, owner_id AS ownerId, agent_id AS agentId, revision, value_json AS valueJson FROM product_state_records WHERE key = ?",
      )
      .get(key) as StateRow | undefined,
  );
}

function findCommandResult(lookup: CommandResultLookup): CommandResultRecord | undefined {
  const row = database
    .prepare(
      `SELECT owner_id AS ownerId, agent_id AS agentId, idempotency_key AS idempotencyKey,
        command_type AS commandType, command_fingerprint AS commandFingerprint,
        result_ref AS resultRef, state_key AS stateKey, state_revision AS stateRevision,
        committed_at AS committedAt
      FROM command_results
      WHERE owner_id = ? AND agent_id = ? AND idempotency_key = ?`,
    )
    .get(lookup.ownerId, lookup.agentId, lookup.idempotencyKey) as CommandResultRow | undefined;
  return row ? commandResultFromRow(row) : undefined;
}

function eventsForCommand(lookup: CommandResultLookup): readonly ReliableEventRecord[] {
  return (
    database
      .prepare(
        `SELECT id, idempotency_key AS idempotencyKey, topic, payload_ref AS payloadRef,
          occurred_at AS occurredAt, published_at AS publishedAt
        FROM reliable_events
        WHERE owner_id = ? AND agent_id = ? AND idempotency_key = ?
        ORDER BY occurred_at, id`,
      )
      .all(lookup.ownerId, lookup.agentId, lookup.idempotencyKey) as EventRow[]
  ).map(eventFromRow);
}

function findCommandCommit(
  lookup: CommandResultLookup,
  replayed = false,
): CommitStateAndEventsResult | undefined {
  const commandResult = findCommandResult(lookup);
  if (!commandResult) return undefined;
  const state = readState(commandResult.stateKey);
  if (!state || state.revision < commandResult.stateRevision) {
    throw new Error(`Committed state ${commandResult.stateKey} is missing or behind its result`);
  }
  return {
    state,
    events: eventsForCommand(lookup),
    commandResult,
    replayed,
  };
}

function replayExisting(input: CommitStateAndEventsInput): CommitStateAndEventsResult | undefined {
  const existing = findCommandCommit(input.command, true);
  if (!existing) return undefined;
  if (
    existing.commandResult.commandType === input.command.commandType &&
    existing.commandResult.commandFingerprint === input.command.commandFingerprint
  ) {
    return existing;
  }
  applicationFailure(
    "PORT_CONFLICT",
    `Idempotency key ${input.command.idempotencyKey} was already used by another command`,
    { idempotencyKey: input.command.idempotencyKey },
  );
}

function assertDiskHeadroom(): void {
  const filesystem = statfsSync(path.dirname(configuration.databasePath));
  const freeBytes = filesystem.bavail * filesystem.bsize;
  if (freeBytes < configuration.minimumFreeBytes) {
    applicationFailure("PORT_CONFLICT", "SQLite writes are restricted by disk headroom", {
      reason: "disk_headroom",
      freeBytes: String(freeBytes),
      minimumFreeBytes: String(configuration.minimumFreeBytes),
    });
  }
}

const durableOperations = new SqliteDurableOperations(
  database,
  applicationFailure,
  assertDiskHeadroom,
);
const startupRecovery = durableOperations.recoverStartup(configuration.startupNow);

function currentAuthority(input: CommitStateAndEventsInput, now: string): AuthorityRow {
  const row = database
    .prepare(
      `SELECT authority_leases.deployment_id AS deploymentId,
        authority_leases.authority_epoch AS authorityEpoch,
        authority_leases.fencing_token AS leaseFencingToken,
        deployments.fencing_token AS deploymentFencingToken,
        deployments.status,
        authority_leases.expires_at AS expiresAt,
        authority_leases.released_at AS releasedAt
      FROM authority_leases
      JOIN deployments ON deployments.id = authority_leases.deployment_id
      WHERE authority_leases.id = ?
        AND authority_leases.owner_id = ?
        AND authority_leases.agent_id = ?
        AND deployments.owner_id = authority_leases.owner_id
        AND deployments.agent_id = authority_leases.agent_id`,
    )
    .get(input.command.authority.leaseId, input.command.ownerId, input.command.agentId) as
    | AuthorityRow
    | undefined;
  if (
    !row ||
    row.status !== "active" ||
    row.releasedAt !== null ||
    row.expiresAt <= now ||
    row.leaseFencingToken !== input.command.authority.fencingToken ||
    row.deploymentFencingToken !== input.command.authority.fencingToken
  ) {
    applicationFailure(
      "PORT_NOT_AUTHORITATIVE",
      `Command does not hold the current authority fence for Agent ${input.command.agentId}`,
      {
        agentId: input.command.agentId,
        leaseId: input.command.authority.leaseId,
        fencingToken: String(input.command.authority.fencingToken),
      },
    );
  }
  const deploymentEpoch = database
    .prepare("SELECT authority_epoch FROM deployments WHERE id = ?")
    .pluck()
    .get(row.deploymentId) as number;
  if (deploymentEpoch !== row.authorityEpoch) {
    applicationFailure("PORT_NOT_AUTHORITATIVE", "Authority epoch does not match deployment", {
      agentId: input.command.agentId,
      leaseId: input.command.authority.leaseId,
    });
  }
  return row;
}

function maybeHoldBeforeCommit(): void {
  const duration = configuration.qualification?.holdBeforeCommitMs ?? 0;
  if (duration <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(duration, 2000));
}

function maybeCrash(
  checkpoint: NonNullable<SqliteWorkerConfiguration["qualification"]>["crashAt"],
): void {
  if (configuration.qualification?.crashAt === checkpoint) process.exit(86);
}

function commitStateAndEvents(
  input: CommitStateAndEventsInput,
  now: string,
): CommitStateAndEventsResult {
  const replay = replayExisting(input);
  if (replay) return replay;
  assertDiskHeadroom();
  maybeHoldBeforeCommit();
  const startedAt = performance.now();
  const transaction = database.transaction(() => {
    const concurrentReplay = replayExisting(input);
    if (concurrentReplay) return concurrentReplay;
    const authority = currentAuthority(input, now);
    const currentRow = database
      .prepare(
        "SELECT key, owner_id AS ownerId, agent_id AS agentId, revision, value_json AS valueJson FROM product_state_records WHERE key = ?",
      )
      .get(input.state.key) as StateRow | undefined;
    const currentRevision = currentRow?.revision ?? null;
    if (
      currentRevision !== input.state.expectedRevision ||
      (currentRow &&
        (currentRow.ownerId !== input.command.ownerId ||
          currentRow.agentId !== input.command.agentId))
    ) {
      applicationFailure("PORT_CONFLICT", `State revision conflict for ${input.state.key}`, {
        key: input.state.key,
        expectedRevision: String(input.state.expectedRevision),
        currentRevision: String(currentRevision),
      });
    }
    const eventIds = new Set<string>();
    for (const event of input.events) {
      if (event.idempotencyKey !== input.command.idempotencyKey) {
        applicationFailure(
          "PORT_INVALID_OPERATION",
          "Reliable events in a product-state commit must share the command idempotency key",
          { eventId: event.id },
        );
      }
      if (eventIds.has(event.id)) {
        applicationFailure("PORT_CONFLICT", `Reliable event ${event.id} is duplicated`, {
          eventId: event.id,
        });
      }
      eventIds.add(event.id);
      if (database.prepare("SELECT 1 FROM reliable_events WHERE id = ?").pluck().get(event.id)) {
        applicationFailure("PORT_CONFLICT", `Reliable event ${event.id} already exists`, {
          eventId: event.id,
        });
      }
    }

    const nextRevision = (currentRow?.revision ?? 0) + 1;
    database
      .prepare(
        `INSERT INTO product_state_records (key, owner_id, agent_id, revision, value_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET revision = excluded.revision,
          value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(
        input.state.key,
        input.command.ownerId,
        input.command.agentId,
        nextRevision,
        JSON.stringify(input.state.value),
        input.committedAt,
      );
    maybeCrash("after_state");

    database
      .prepare(
        `INSERT INTO command_results (
          id, owner_id, agent_id, idempotency_key, command_type, command_fingerprint,
          deployment_id, authority_epoch, fencing_token, result_ref, state_key,
          state_revision, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `command-result:${createHash("sha256")
          .update(
            JSON.stringify([
              input.command.ownerId,
              input.command.agentId,
              input.command.idempotencyKey,
            ]),
          )
          .digest("hex")}`,
        input.command.ownerId,
        input.command.agentId,
        input.command.idempotencyKey,
        input.command.commandType,
        input.command.commandFingerprint,
        authority.deploymentId,
        authority.authorityEpoch,
        authority.leaseFencingToken,
        input.resultRef,
        input.state.key,
        nextRevision,
        input.committedAt,
      );
    maybeCrash("after_result");

    const insertEvent = database.prepare(
      `INSERT INTO reliable_events (
        id, owner_id, agent_id, idempotency_key, topic, payload_ref,
        publication_state, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    for (const event of input.events) {
      insertEvent.run(
        event.id,
        input.command.ownerId,
        input.command.agentId,
        event.idempotencyKey,
        event.topic,
        event.payloadRef,
        event.occurredAt,
      );
    }
    maybeCrash("after_event");

    const committed = findCommandCommit(input.command);
    if (!committed) throw new Error("The committed state could not be reconstructed");
    return committed;
  });

  const result = transaction.immediate();
  lastTransactionDurationMs = performance.now() - startedAt;
  maybeCrash("after_commit");
  return result;
}

function listPending(limit: number): readonly ReliableEventRecord[] {
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
    applicationFailure("PORT_INVALID_OPERATION", "Pending event limit must be between 0 and 1000");
  }
  return (
    database
      .prepare(
        `SELECT id, idempotency_key AS idempotencyKey, topic, payload_ref AS payloadRef,
          occurred_at AS occurredAt, published_at AS publishedAt
        FROM reliable_events
        WHERE published_at IS NULL
        ORDER BY occurred_at, id
        LIMIT ?`,
      )
      .all(limit) as EventRow[]
  ).map(eventFromRow);
}

function markPublished(eventId: string, publishedAt: string): ReliableEventRecord {
  const existing = database
    .prepare(
      `SELECT id, idempotency_key AS idempotencyKey, topic, payload_ref AS payloadRef,
        occurred_at AS occurredAt, published_at AS publishedAt
      FROM reliable_events WHERE id = ?`,
    )
    .get(eventId) as EventRow | undefined;
  if (!existing) applicationFailure("PORT_NOT_FOUND", `Event ${eventId} not found`, { eventId });
  if (existing.publishedAt !== null) return eventFromRow(existing);
  database
    .prepare(
      "UPDATE reliable_events SET publication_state = 'published', published_at = ? WHERE id = ?",
    )
    .run(publishedAt, eventId);
  return eventFromRow({ ...existing, publishedAt });
}

function operationalStatus() {
  const filesystem = statfsSync(path.dirname(configuration.databasePath));
  let walBytes = 0;
  try {
    walBytes = statSync(`${configuration.databasePath}-wal`).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    freeBytes: filesystem.bavail * filesystem.bsize,
    walBytes,
    busyTimeoutMs: database.pragma("busy_timeout", { simple: true }) as number,
    lastTransactionDurationMs,
  };
}

function checkpoint(mode: "passive" | "truncate") {
  const pragma = mode === "truncate" ? "wal_checkpoint(TRUNCATE)" : "wal_checkpoint(PASSIVE)";
  return (database.pragma(pragma) as Array<{ busy: number; log: number; checkpointed: number }>)[0];
}

function failureResponse(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    "code" in error &&
    "message" in error
  ) {
    return error;
  }
  const sqliteCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "SQLITE_WORKER_ERROR";
  if (sqliteCode === "SQLITE_BUSY" || sqliteCode === "SQLITE_FULL") {
    return {
      kind: "application",
      code: "PORT_CONFLICT",
      message: sqliteCode === "SQLITE_BUSY" ? "SQLite writer remained busy" : "SQLite is full",
      details: { sqliteCode },
    };
  }
  return {
    kind: "persistence",
    code: sqliteCode,
    message: error instanceof Error ? error.message : "SQLite worker operation failed",
    details: {},
  };
}

channel.on("message", (request: WorkerRequest) => {
  try {
    let value: unknown;
    switch (request.operation) {
      case "ready":
        value = { writerSequence: configuration.writerSequence, startupRecovery };
        break;
      case "read":
        value = readState((request.payload as { key: string }).key);
        break;
      case "listPending":
        value = listPending((request.payload as { limit: number }).limit);
        break;
      case "markPublished": {
        const payload = request.payload as { eventId: string; publishedAt: string };
        value = markPublished(payload.eventId, payload.publishedAt);
        break;
      }
      case "findCommandResult":
        value = findCommandResult(request.payload as CommandResultLookup);
        break;
      case "findCommandCommit":
        value = findCommandCommit(request.payload as CommandResultLookup);
        break;
      case "commit": {
        const payload = request.payload as { input: CommitStateAndEventsInput; now: string };
        value = commitStateAndEvents(payload.input, payload.now);
        break;
      }
      case "authority.claim": {
        const payload = request.payload as {
          lease: AgentAuthorityLease;
          durationMs: number;
          now: string;
        };
        value = claimLease(payload.lease, payload.durationMs, payload.now);
        break;
      }
      case "authority.current": {
        const payload = request.payload as { agentId: AgentId; now: string };
        value = currentLease(payload.agentId, payload.now);
        break;
      }
      case "authority.renew": {
        const payload = request.payload as {
          leaseId: AuthorityLeaseId;
          durationMs: number;
          now: string;
        };
        value = renewLease(payload.leaseId, payload.durationMs, payload.now);
        break;
      }
      case "authority.release": {
        const payload = request.payload as { leaseId: AuthorityLeaseId; now: string };
        value = releaseLease(payload.leaseId, payload.now);
        break;
      }
      case "deployment.read":
        value = readDeployment((request.payload as { deploymentId: DeploymentId }).deploymentId);
        break;
      case "deployment.save": {
        const payload = request.payload as {
          deployment: DeploymentAuthorityState;
          expectedRevision: number;
        };
        value = saveDeployment(payload.deployment, payload.expectedRevision);
        break;
      }
      case "deployment.assertCurrent":
        value = assertCurrentDeployment(
          (request.payload as { fence: ProductAuthorityFence }).fence,
        );
        break;
      case "status":
        value = operationalStatus();
        break;
      case "checkpoint":
        value = checkpoint((request.payload as { mode: "passive" | "truncate" }).mode);
        break;
      case "close":
        database.close();
        value = null;
        break;
      default:
        value = durableOperations.execute(request.operation, request.payload);
        break;
    }
    channel.postMessage({ id: request.id, ok: true, value });
    if (request.operation === "close") channel.close();
  } catch (error) {
    channel.postMessage({ id: request.id, ok: false, error: failureResponse(error) });
  }
});
