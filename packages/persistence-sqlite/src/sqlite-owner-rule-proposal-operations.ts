import type {
  OwnerRuleProposalOutcome,
  OwnerRuleProposalStorePort,
  StoredOwnerRuleProposal,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof OwnerRuleProposalStorePort> = Parameters<
  OwnerRuleProposalStorePort[TName]
>[0];

const PROPOSAL_ID = /^rule-proposal:[0-9a-f]{32}$/u;
const MAX_LISTED = 200;

const columns = `id AS proposalId, rule_type AS ruleType, summary, origin, thread_id AS threadId,
  evidence_ref AS evidenceRef, status, proposed_at AS proposedAt, expires_at AS expiresAt,
  decided_at AS decidedAt, proposed_count AS proposedCount, reject_count AS rejectCount,
  last_rejected_at AS lastRejectedAt`;

function valid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export class SqliteOwnerRuleProposalOperations {
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
      case "ownerRuleProposal.propose":
        return this.propose(payload as Input<"propose">);
      case "ownerRuleProposal.read":
        return this.read(payload as Input<"read">);
      case "ownerRuleProposal.listPending":
        return this.listPending(payload as Input<"listPending">);
      case "ownerRuleProposal.decide":
        return this.decide(payload as Input<"decide">);
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown owner rule proposal operation ${operation}`,
        );
    }
  }

  private invalid(message: string): never {
    return this.fail("PORT_INVALID_OPERATION", message);
  }

  private proposalId(value: unknown): string {
    if (typeof value !== "string" || !PROPOSAL_ID.test(value))
      this.invalid("Owner rule proposal id is invalid");
    return value;
  }

  private expire(ownerId: string, agentId: string, now: string): void {
    this.database
      .prepare(
        `UPDATE owner_rule_proposals SET status = 'expired', decided_at = ?
         WHERE owner_id = ? AND agent_id = ? AND status = 'pending' AND expires_at <= ?`,
      )
      .run(now, ownerId, agentId, now);
  }

  private fetch(
    ownerId: string,
    agentId: string,
    proposalId: string,
  ): StoredOwnerRuleProposal | undefined {
    const row = this.database
      .prepare(
        `SELECT ${columns} FROM owner_rule_proposals WHERE owner_id = ? AND agent_id = ? AND id = ?`,
      )
      .get(ownerId, agentId, proposalId) as StoredOwnerRuleProposal | undefined;
    return row ? Object.freeze({ ...row }) : undefined;
  }

  private propose(input: Input<"propose">): OwnerRuleProposalOutcome {
    this.assertDiskHeadroom();
    const proposalId = this.proposalId(input.proposalId);
    if (!valid(input.now) || !valid(input.expiresAt) || input.expiresAt <= input.now)
      this.invalid("Owner rule proposal time is invalid");
    if (!Number.isInteger(input.pendingLimit) || input.pendingLimit < 1)
      this.invalid("Owner rule proposal limit is invalid");
    if (input.origin !== "owner_said" && input.origin !== "inferred")
      this.invalid("Owner rule proposal origin is invalid");
    return this.database.transaction((): OwnerRuleProposalOutcome => {
      this.expire(input.ownerId, input.agentId, input.now);
      const existing = this.fetch(input.ownerId, input.agentId, proposalId);
      if (existing?.status === "pending") {
        this.database
          .prepare(
            `UPDATE owner_rule_proposals SET expires_at = ?, origin = ?, thread_id = ?,
               proposed_count = proposed_count + 1
             WHERE owner_id = ? AND agent_id = ? AND id = ?`,
          )
          .run(
            input.expiresAt,
            input.origin,
            input.threadId,
            input.ownerId,
            input.agentId,
            proposalId,
          );
        return "refreshed";
      }
      const pending = (
        this.database
          .prepare(
            "SELECT COUNT(*) AS count FROM owner_rule_proposals WHERE owner_id = ? AND agent_id = ? AND status = 'pending'",
          )
          .get(input.ownerId, input.agentId) as { count: number }
      ).count;
      if (pending >= input.pendingLimit) return "limit_reached";
      if (existing) {
        this.database
          .prepare(
            `UPDATE owner_rule_proposals SET status = 'pending', decided_at = NULL, proposed_at = ?,
               expires_at = ?, origin = ?, thread_id = ?, summary = ?, rule_type = ?,
               evidence_ref = coalesce(evidence_ref, ?), proposed_count = proposed_count + 1
             WHERE owner_id = ? AND agent_id = ? AND id = ?`,
          )
          .run(
            input.now,
            input.expiresAt,
            input.origin,
            input.threadId,
            input.summary,
            input.ruleType,
            input.evidenceRef,
            input.ownerId,
            input.agentId,
            proposalId,
          );
        return "reopened";
      }
      this.database
        .prepare(
          `INSERT INTO owner_rule_proposals (
            id, owner_id, agent_id, rule_type, summary, origin, thread_id, evidence_ref, status,
            proposed_at, expires_at, decided_at, proposed_count, reject_count, last_rejected_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, 1, 0, NULL)`,
        )
        .run(
          proposalId,
          input.ownerId,
          input.agentId,
          input.ruleType,
          input.summary,
          input.origin,
          input.threadId,
          input.evidenceRef,
          input.now,
          input.expiresAt,
        );
      return "created";
    })();
  }

  private read(input: Input<"read">): StoredOwnerRuleProposal | undefined {
    const proposalId = this.proposalId(input.proposalId);
    if (!valid(input.now)) this.invalid("Owner rule proposal time is invalid");
    return this.database.transaction(() => {
      this.expire(input.ownerId, input.agentId, input.now);
      return this.fetch(input.ownerId, input.agentId, proposalId);
    })();
  }

  private listPending(input: Input<"listPending">): {
    readonly proposals: readonly StoredOwnerRuleProposal[];
    readonly pendingCount: number;
  } {
    if (!valid(input.now)) this.invalid("Owner rule proposal time is invalid");
    const limit = Math.min(Math.max(1, Math.trunc(input.limit)), MAX_LISTED);
    return this.database.transaction(() => {
      this.expire(input.ownerId, input.agentId, input.now);
      const rows = this.database
        .prepare(
          `SELECT ${columns} FROM owner_rule_proposals
           WHERE owner_id = ? AND agent_id = ? AND status = 'pending'
           ORDER BY proposed_at, id LIMIT ?`,
        )
        .all(input.ownerId, input.agentId, limit) as StoredOwnerRuleProposal[];
      const pendingCount = (
        this.database
          .prepare(
            "SELECT COUNT(*) AS count FROM owner_rule_proposals WHERE owner_id = ? AND agent_id = ? AND status = 'pending'",
          )
          .get(input.ownerId, input.agentId) as { count: number }
      ).count;
      return Object.freeze({
        proposals: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
        pendingCount,
      });
    })();
  }

  private decide(input: Input<"decide">): StoredOwnerRuleProposal | undefined {
    this.assertDiskHeadroom();
    const proposalId = this.proposalId(input.proposalId);
    if (!valid(input.now)) this.invalid("Owner rule proposal time is invalid");
    return this.database.transaction(() => {
      this.expire(input.ownerId, input.agentId, input.now);
      const rejected = input.to === "rejected";
      const decidedAt = input.to === "pending" ? null : input.now;
      const result = this.database
        .prepare(
          `UPDATE owner_rule_proposals SET status = ?, decided_at = ?,
             reject_count = reject_count + ?, last_rejected_at = CASE WHEN ? = 1 THEN ? ELSE last_rejected_at END
           WHERE owner_id = ? AND agent_id = ? AND id = ? AND status = ?`,
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
        );
      return result.changes === 0
        ? undefined
        : this.fetch(input.ownerId, input.agentId, proposalId);
    })();
  }
}
