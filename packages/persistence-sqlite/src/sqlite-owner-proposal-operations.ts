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
const ORIGINS = ["owner_said", "inferred", "external_agent"];
const STATUSES = ["pending", "accepted", "rejected", "expired"];

const FINGERPRINT = /^[0-9a-f]{64}$/u;

const columns = `id AS proposalId, type, summary, effect, origin, thread_id AS threadId,
  source_ref AS sourceRef, source_version AS sourceVersion, version, fingerprint,
  evidence_ref AS evidenceRef, status, proposed_at AS proposedAt, expires_at AS expiresAt,
  decided_at AS decidedAt, proposed_count AS proposedCount, reject_count AS rejectCount,
  last_rejected_at AS lastRejectedAt`;

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
      .get(ownerId, agentId, proposalId) as StoredOwnerProposal | undefined;
    return row ? Object.freeze({ ...row }) : undefined;
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
      if (existing?.status === "pending") {
        this.database
          .prepare(
            `UPDATE owner_proposals SET expires_at = ?, origin = ?, thread_id = ?, summary = ?,
               effect = ?, type = ?, source_ref = ?, source_version = ?,
               version = version + CASE WHEN fingerprint = ? THEN 0 ELSE 1 END, fingerprint = ?,
               evidence_ref = ?, proposed_count = proposed_count + 1
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
               evidence_ref = ?, proposed_count = proposed_count + 1
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
            proposed_at, expires_at, decided_at, proposed_count, reject_count, last_rejected_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'pending', ?, ?, NULL, 1, 0, NULL)`,
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
        .all(input.ownerId, input.agentId, limit) as StoredOwnerProposal[];
      const pendingCount = (
        this.database
          .prepare(
            "SELECT COUNT(*) AS count FROM owner_proposals WHERE owner_id = ? AND agent_id = ? AND status = 'pending'",
          )
          .get(input.ownerId, input.agentId) as { count: number }
      ).count;
      return Object.freeze({
        proposals: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
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
               WHERE owner_id = ? AND agent_id = ? AND status IN ('rejected', 'expired')
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
             AND status IN ('rejected', 'expired')`,
        )
        .run(input.ownerId, input.agentId, proposalId, input.evidenceRef).changes > 0
    );
  }
}
