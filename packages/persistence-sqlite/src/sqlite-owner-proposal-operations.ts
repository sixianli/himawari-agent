import type {
  OwnerProposalOutcome,
  OwnerProposalStorePort,
  StoredOwnerProposal,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof OwnerProposalStorePort> = Parameters<
  OwnerProposalStorePort[TName]
>[0];

const MAX_LISTED = 200;
const PROPOSAL_ID = /^[a-z][a-z0-9-]{0,31}:[0-9a-f]{32}$/u;
const ORIGINS = ["owner_said", "inferred", "external_agent", "external_content"];
const STATUSES = ["pending", "accepted", "rejected", "expired", "superseded", "withdrawn"];
const EXECUTION_STATUSES = [
  "not_started",
  "running",
  "executed_unverified",
  "succeeded",
  "failed",
  "unknown",
  "undone",
];
const EXECUTION_STEPS: readonly (readonly [string, string])[] = [
  ["running", "executed_unverified"],
  ["running", "failed"],
  ["running", "succeeded"],
  ["running", "unknown"],
  ["executed_unverified", "succeeded"],
  ["executed_unverified", "failed"],
  ["executed_unverified", "unknown"],
  ["succeeded", "undone"],
  ["unknown", "succeeded"],
  ["unknown", "failed"],
];

const FINGERPRINT = /^[0-9a-f]{64}$/u;

const columns = `id AS proposalId, type, summary, effect, origin, thread_id AS threadId,
  source_ref AS sourceRef, source_version AS sourceVersion, version, fingerprint,
  evidence_ref AS evidenceRef, status, proposed_at AS proposedAt, expires_at AS expiresAt,
  decided_at AS decidedAt, proposed_count AS proposedCount, reject_count AS rejectCount,
  last_rejected_at AS lastRejectedAt, exec_status AS execStatus, lease_id AS leaseId,
  lease_expires_at AS leaseExpiresAt, attempts, requires_full_read AS requiresFullRead,
  requires_presence AS requiresPresence, executed_at AS executedAt, execution_ref AS executionRef`;

type Row = Omit<StoredOwnerProposal, "requiresFullRead" | "requiresPresence"> & {
  readonly requiresFullRead: number;
  readonly requiresPresence: number;
};

function stored(row: Row): StoredOwnerProposal {
  return Object.freeze({
    ...row,
    requiresFullRead: row.requiresFullRead === 1,
    requiresPresence: row.requiresPresence === 1,
  });
}

function valid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export class SqliteOwnerProposalOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
  }

  execute(operation: string, payload: unknown): unknown {
    switch (operation) {
      case "ownerProposal.propose":
        return this.propose(payload as Input<"propose">);
      case "ownerProposal.read":
        return this.read(payload as Input<"read">);
      case "ownerProposal.listPending":
        return this.listPending(payload as Input<"listPending">);
      case "ownerProposal.decide":
        return this.decide(payload as Input<"decide">);
      case "ownerProposal.claim":
        return this.claim(payload as Input<"claim">);
      case "ownerProposal.moveExecution":
        return this.moveExecution(payload as Input<"moveExecution">);
      case "ownerProposal.listExpiredLeases":
        return this.listExpiredLeases(payload as Input<"listExpiredLeases">);
      case "ownerProposal.settledEvidence":
        return this.settledEvidence(payload as Input<"settledEvidence">);
      case "ownerProposal.clearEvidence":
        return this.clearEvidence(payload as Input<"clearEvidence">);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown owner proposal operation ${operation}`);
    }
  }

  private invalid(message: string): never {
    return this.fail("PORT_INVALID_OPERATION", message);
  }

  private proposalId(value: unknown): string {
    if (typeof value !== "string" || !PROPOSAL_ID.test(value))
      this.invalid("Owner proposal id is invalid");
    return value;
  }

  private expire(ownerId: string, agentId: string, now: string): void {
    this.database
      .prepare(
        `UPDATE owner_proposals SET status = 'expired', decided_at = ?
         WHERE owner_id = ? AND agent_id = ? AND status = 'pending' AND expires_at <= ?`,
      )
      .run(now, ownerId, agentId, now);
  }

  private fetch(
    ownerId: string,
    agentId: string,
    proposalId: string,
  ): StoredOwnerProposal | undefined {
    const row = this.database
      .prepare(
        `SELECT ${columns} FROM owner_proposals WHERE owner_id = ? AND agent_id = ? AND id = ?`,
      )
      .get(ownerId, agentId, proposalId) as Row | undefined;
    return row ? stored(row) : undefined;
  }

  private propose(input: Input<"propose">): OwnerProposalOutcome {
    this.assertDiskHeadroom();
    const proposalId = this.proposalId(input.proposalId);
    if (!valid(input.now) || !valid(input.expiresAt) || input.expiresAt <= input.now)
      this.invalid("Owner proposal time is invalid");
    if (
      !Number.isInteger(input.pendingLimit) ||
      input.pendingLimit < 1 ||
      input.pendingLimit > MAX_LISTED
    )
      this.invalid("Owner proposal limit is invalid");
    if (!ORIGINS.includes(input.origin)) this.invalid("Owner proposal origin is invalid");
    if (typeof input.fingerprint !== "string" || !FINGERPRINT.test(input.fingerprint))
      this.invalid("Owner proposal fingerprint is invalid");
    if (input.sourceRef === null && input.sourceVersion !== null)
      this.invalid("Owner proposal source is invalid");
    return this.database.transaction((): OwnerProposalOutcome => {
      this.expire(input.ownerId, input.agentId, input.now);
      const existing = this.fetch(input.ownerId, input.agentId, proposalId);
      if (existing && existing.execStatus !== "not_started") return "closed";
      if (existing?.status === "pending") {
        this.database
          .prepare(
            `UPDATE owner_proposals SET expires_at = ?, origin = ?, thread_id = ?, summary = ?,
               effect = ?, type = ?, source_ref = ?, source_version = ?,
               version = version + CASE WHEN fingerprint = ? THEN 0 ELSE 1 END, fingerprint = ?,
               evidence_ref = ?, requires_full_read = ?, requires_presence = ?,
               proposed_count = proposed_count + 1
             WHERE owner_id = ? AND agent_id = ? AND id = ?`,
          )
          .run(
            input.expiresAt,
            input.origin,
            input.threadId,
            input.summary,
            input.effect,
            input.type,
            input.sourceRef,
            input.sourceVersion,
            input.fingerprint,
            input.fingerprint,
            input.evidenceRef,
            input.requiresFullRead ? 1 : 0,
            input.requiresPresence ? 1 : 0,
            input.ownerId,
            input.agentId,
            proposalId,
          );
        return "refreshed";
      }
      const pending = (
        this.database
          .prepare(
            "SELECT COUNT(*) AS count FROM owner_proposals WHERE owner_id = ? AND agent_id = ? AND status = 'pending'",
          )
          .get(input.ownerId, input.agentId) as { count: number }
      ).count;
      if (pending >= input.pendingLimit) return "limit_reached";
      if (existing) {
        this.database
          .prepare(
            `UPDATE owner_proposals SET status = 'pending', decided_at = NULL, proposed_at = ?,
               expires_at = ?, origin = ?, thread_id = ?, summary = ?, effect = ?, type = ?,
               source_ref = ?, source_version = ?, version = version + 1, fingerprint = ?,
               evidence_ref = ?, requires_full_read = ?, requires_presence = ?,
               proposed_count = proposed_count + 1
             WHERE owner_id = ? AND agent_id = ? AND id = ?`,
          )
          .run(
            input.now,
            input.expiresAt,
            input.origin,
            input.threadId,
            input.summary,
            input.effect,
            input.type,
            input.sourceRef,
            input.sourceVersion,
            input.fingerprint,
            input.evidenceRef,
            input.requiresFullRead ? 1 : 0,
            input.requiresPresence ? 1 : 0,
            input.ownerId,
            input.agentId,
            proposalId,
          );
        return "reopened";
      }
      this.database
        .prepare(
          `INSERT INTO owner_proposals (
            id, owner_id, agent_id, type, summary, effect, origin, thread_id, source_ref,
            source_version, version, fingerprint, evidence_ref, status,
            proposed_at, expires_at, decided_at, proposed_count, reject_count, last_rejected_at,
            requires_full_read, requires_presence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'pending', ?, ?, NULL, 1, 0, NULL, ?, ?)`,
        )
        .run(
          proposalId,
          input.ownerId,
          input.agentId,
          input.type,
          input.summary,
          input.effect,
          input.origin,
          input.threadId,
          input.sourceRef,
          input.sourceVersion,
          input.fingerprint,
          input.evidenceRef,
          input.now,
          input.expiresAt,
          input.requiresFullRead ? 1 : 0,
          input.requiresPresence ? 1 : 0,
        );
      return "created";
    })();
  }

  private read(input: Input<"read">): StoredOwnerProposal | undefined {
    const proposalId = this.proposalId(input.proposalId);
    if (!valid(input.now)) this.invalid("Owner proposal time is invalid");
    return this.database.transaction(() => {
      this.expire(input.ownerId, input.agentId, input.now);
      return this.fetch(input.ownerId, input.agentId, proposalId);
    })();
  }

  private listPending(input: Input<"listPending">): {
    readonly proposals: readonly StoredOwnerProposal[];
    readonly pendingCount: number;
  } {
    if (!valid(input.now)) this.invalid("Owner proposal time is invalid");
    const limit = Math.min(Math.max(1, Math.trunc(input.limit)), MAX_LISTED);
    return this.database.transaction(() => {
      this.expire(input.ownerId, input.agentId, input.now);
      const rows = this.database
        .prepare(
          `SELECT ${columns} FROM owner_proposals
           WHERE owner_id = ? AND agent_id = ? AND status = 'pending'
           ORDER BY proposed_at, id LIMIT ?`,
        )
        .all(input.ownerId, input.agentId, limit) as Row[];
      const pendingCount = (
        this.database
          .prepare(
            "SELECT COUNT(*) AS count FROM owner_proposals WHERE owner_id = ? AND agent_id = ? AND status = 'pending'",
          )
          .get(input.ownerId, input.agentId) as { count: number }
      ).count;
      return Object.freeze({
        proposals: Object.freeze(rows.map(stored)),
        pendingCount,
      });
    })();
  }

  private decide(input: Input<"decide">): StoredOwnerProposal | undefined {
    this.assertDiskHeadroom();
    const proposalId = this.proposalId(input.proposalId);
    if (!valid(input.now)) this.invalid("Owner proposal time is invalid");
    if (!STATUSES.includes(input.from) || !STATUSES.includes(input.to)) {
      this.invalid("Owner proposal status is invalid");
    }
    const { expected } = input;
    if (
      expected !== undefined &&
      (!Number.isSafeInteger(expected.version) || typeof expected.fingerprint !== "string")
    )
      this.invalid("Owner proposal version is invalid");
    return this.database.transaction(() => {
      this.expire(input.ownerId, input.agentId, input.now);
      const rejected = input.to === "rejected";
      const decidedAt = input.to === "pending" ? null : input.now;
      const result = this.database
        .prepare(
          `UPDATE owner_proposals SET status = ?, decided_at = ?,
             reject_count = reject_count + ?, last_rejected_at = CASE WHEN ? = 1 THEN ? ELSE last_rejected_at END
           WHERE owner_id = ? AND agent_id = ? AND id = ? AND status = ?
             AND (? IS NULL OR (version = ? AND fingerprint = ?))`,
        )
        .run(
          input.to,
          decidedAt,
          rejected ? 1 : 0,
          rejected ? 1 : 0,
          input.now,
          input.ownerId,
          input.agentId,
          proposalId,
          input.from,
          expected?.version ?? null,
          expected?.version ?? null,
          expected?.fingerprint ?? null,
        );
      return result.changes === 0
        ? undefined
        : this.fetch(input.ownerId, input.agentId, proposalId);
    })();
  }

  private claim(input: Input<"claim">): StoredOwnerProposal | undefined {
    this.assertDiskHeadroom();
    const proposalId = this.proposalId(input.proposalId);
    if (!valid(input.now) || !valid(input.leaseExpiresAt) || input.leaseExpiresAt <= input.now)
      this.invalid("Owner proposal time is invalid");
    if (
      typeof input.leaseId !== "string" ||
      input.leaseId.length < 1 ||
      input.leaseId.length > 64 ||
      !Number.isSafeInteger(input.expected?.version) ||
      typeof input.expected?.fingerprint !== "string"
    )
      this.invalid("Owner proposal claim is invalid");
    return this.database.transaction(() => {
      this.expire(input.ownerId, input.agentId, input.now);
      const result = this.database
        .prepare(
          `UPDATE owner_proposals SET status = 'accepted', decided_at = ?, exec_status = 'running',
             lease_id = ?, lease_expires_at = ?, attempts = attempts + 1
           WHERE owner_id = ? AND agent_id = ? AND id = ? AND status = 'pending'
             AND exec_status = 'not_started' AND version = ? AND fingerprint = ?`,
        )
        .run(
          input.now,
          input.leaseId,
          input.leaseExpiresAt,
          input.ownerId,
          input.agentId,
          proposalId,
          input.expected.version,
          input.expected.fingerprint,
        );
      return result.changes === 0
        ? undefined
        : this.fetch(input.ownerId, input.agentId, proposalId);
    })();
  }

  private moveExecution(input: Input<"moveExecution">): StoredOwnerProposal | undefined {
    this.assertDiskHeadroom();
    const proposalId = this.proposalId(input.proposalId);
    if (!valid(input.now)) this.invalid("Owner proposal time is invalid");
    if (
      !EXECUTION_STATUSES.includes(input.from) ||
      !EXECUTION_STATUSES.includes(input.to) ||
      !EXECUTION_STEPS.some(([from, to]) => from === input.from && to === input.to)
    )
      this.invalid("Owner proposal execution step is invalid");
    if (
      input.executionRef !== undefined &&
      input.executionRef !== null &&
      (typeof input.executionRef !== "string" ||
        input.executionRef.length < 1 ||
        input.executionRef.length > 256)
    )
      this.invalid("Owner proposal execution reference is invalid");
    const finished = ["succeeded", "failed", "unknown", "undone"].includes(input.to);
    return this.database.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE owner_proposals SET exec_status = ?,
             execution_ref = CASE WHEN ? = 1 THEN ? ELSE execution_ref END,
             executed_at = CASE WHEN ? IN ('executed_unverified', 'succeeded') AND executed_at IS NULL
               THEN ? ELSE executed_at END,
             lease_id = CASE WHEN ? = 1 THEN NULL ELSE lease_id END,
             lease_expires_at = CASE WHEN ? = 1 THEN NULL ELSE lease_expires_at END
           WHERE owner_id = ? AND agent_id = ? AND id = ? AND exec_status = ?
             AND (? IS NULL OR lease_id = ?)`,
        )
        .run(
          input.to,
          input.executionRef === undefined ? 0 : 1,
          input.executionRef ?? null,
          input.to,
          input.now,
          finished ? 1 : 0,
          finished ? 1 : 0,
          input.ownerId,
          input.agentId,
          proposalId,
          input.from,
          input.leaseId,
          input.leaseId,
        );
      return result.changes === 0
        ? undefined
        : this.fetch(input.ownerId, input.agentId, proposalId);
    })();
  }

  private listExpiredLeases(input: Input<"listExpiredLeases">): readonly StoredOwnerProposal[] {
    if (!valid(input.now)) this.invalid("Owner proposal time is invalid");
    const limit = Math.min(Math.max(1, Math.trunc(input.limit)), MAX_LISTED);
    const rows = this.database
      .prepare(
        `SELECT ${columns} FROM owner_proposals
         WHERE owner_id = ? AND agent_id = ? AND exec_status IN ('running', 'executed_unverified')
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
         ORDER BY lease_expires_at, id LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.now, limit) as Row[];
    return Object.freeze(rows.map(stored));
  }

  private settledEvidence(
    input: Input<"settledEvidence">,
  ): readonly { readonly proposalId: string; readonly evidenceRef: string }[] {
    if (!valid(input.now)) this.invalid("Owner proposal time is invalid");
    const limit = Math.min(Math.max(1, Math.trunc(input.limit)), MAX_LISTED);
    return this.database.transaction(() => {
      this.expire(input.ownerId, input.agentId, input.now);
      return Object.freeze(
        (
          this.database
            .prepare(
              `SELECT id AS proposalId, evidence_ref AS evidenceRef FROM owner_proposals
               WHERE owner_id = ? AND agent_id = ?
                 AND status IN ('rejected', 'expired', 'superseded', 'withdrawn')
                 AND evidence_ref IS NOT NULL
               ORDER BY decided_at, id LIMIT ?`,
            )
            .all(input.ownerId, input.agentId, limit) as {
            proposalId: string;
            evidenceRef: string;
          }[]
        ).map((row) => Object.freeze({ ...row })),
      );
    })();
  }

  private clearEvidence(input: Input<"clearEvidence">): boolean {
    const proposalId = this.proposalId(input.proposalId);
    return (
      this.database
        .prepare(
          `UPDATE owner_proposals SET evidence_ref = NULL
           WHERE owner_id = ? AND agent_id = ? AND id = ? AND evidence_ref = ?
             AND status IN ('rejected', 'expired', 'superseded', 'withdrawn')`,
        )
        .run(input.ownerId, input.agentId, proposalId, input.evidenceRef).changes > 0
    );
  }
}
