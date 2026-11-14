import { randomUUID } from "node:crypto";
import type {
  CorrectionAgreementCounts,
  DecisionLedgerWrite,
  MemoryReviewItem,
  MemoryReviewStorePort,
  RuleReviewCandidate,
  RuleReviewListItem,
  RuleReviewOwnerStorePort,
  RuleReviewStorePort,
} from "@himawari-agent/application";
import { RULE_REVIEW_MAX_ATTEMPTS } from "@himawari-agent/application/rule-review";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import { insertLedgerRow } from "./sqlite-decision-ledger-operations.ts";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";
import {
  derivedMemories,
  MEMORY_BASIS_CHAIN_MAX_DEPTH,
} from "./sqlite-memory-consolidation-operations.ts";

type RuleInput<TName extends keyof RuleReviewStorePort> = Parameters<RuleReviewStorePort[TName]>[0];
type OwnerInput<TName extends keyof RuleReviewOwnerStorePort> = Parameters<
  RuleReviewOwnerStorePort[TName]
>[0];
type MemoryInput<TName extends keyof MemoryReviewStorePort> = Parameters<
  MemoryReviewStorePort[TName]
>[0];

const OWNER_RULE_PREFIX = "owner:";
const OWNER_RULE_ID = /^owner:[A-Za-z0-9_-]{1,58}$/u;
const MEMORY_ID = /^[\x21-\x7e]{1,128}$/u;
const MAX_LIMIT = 200;
const MAX_SUGGESTION = 16_384;
const SUSPEND_REASONS = new Set(["source_removed", "no_longer_standing", "parameters_changed"]);
const FAILURE_REASONS = new Set([
  "model_failed",
  "answer_invalid",
  "content_blocked",
  "source_unreadable",
]);
const OWNER_ACTIONS = new Set(["adopt", "confirm_suspended", "restore"]);
const RESOLUTIONS = new Set(["owner_edited", "owner_dismissed"]);
export const COUNTED_RULE_REASON = "from_suspended";
export const COUNTED_MEMORY_REASON = "system_flagged";

interface RuleRow {
  ruleId: string;
  revision: number;
  status: "needs_review" | "suspended";
  parameters: string;
  sourceMemoryId: string | null;
  reviewAttempts: number;
  reviewFailure: string | null;
  suspendReason: string | null;
  suggestion: string | null;
  reviewAfter: string | null;
  updatedAt: string;
}

const ruleColumns = `rule_id AS ruleId, revision, status, parameters,
  source_memory_id AS sourceMemoryId, review_attempts AS reviewAttempts,
  review_failure AS reviewFailure, suspend_reason AS suspendReason, suggestion,
  review_after AS reviewAfter, updated_at AS updatedAt`;

function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function ledgerId(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}

export class SqliteCorrectionReviewOperations {
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
      case "ruleReview.listDue":
        return this.listDue(payload as RuleInput<"listDue">);
      case "ruleReview.resolve":
        return this.resolve(payload as RuleInput<"resolve">);
      case "ruleReview.recordFailure":
        return this.recordFailure(payload as RuleInput<"recordFailure">);
      case "ruleReview.listOpen":
        return this.listOpenRules(payload as OwnerInput<"listOpen">);
      case "ruleReview.act":
        return this.act(payload as OwnerInput<"act">);
      case "memoryReview.expand":
        return this.expand(payload as MemoryInput<"expand">);
      case "memoryReview.listOpen":
        return this.listOpenMemories(payload as MemoryInput<"listOpen">);
      case "memoryReview.resolve":
        return this.resolveMemory(payload as MemoryInput<"resolve">);
      case "memoryReview.reportMissed":
        return this.reportMissed(payload as MemoryInput<"reportMissed">);
      case "memoryReview.agreement":
        return this.agreement(payload as MemoryInput<"agreement">);
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown correction review operation ${operation}`,
        );
    }
  }

  private invalid(message: string): never {
    return this.fail("PORT_INVALID_OPERATION", message);
  }

  private limit(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_LIMIT)
      this.invalid("Correction review limit is invalid");
    return value as number;
  }

  private ruleId(value: unknown): string {
    if (typeof value !== "string" || !OWNER_RULE_ID.test(value))
      this.invalid("Owner rule id is invalid");
    return value;
  }

  private memoryId(value: unknown): string {
    if (typeof value !== "string" || !MEMORY_ID.test(value)) this.invalid("Memory id is invalid");
    return value;
  }

  private time(value: unknown): string {
    if (!validTime(value)) this.invalid("Correction review time is invalid");
    return value;
  }

  private revision(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1)
      this.invalid("Owner rule revision is invalid");
    return value as number;
  }

  private ledger(
    input: { ownerId: OwnerId; agentId: AgentId },
    write: Omit<
      DecisionLedgerWrite,
      "ownerId" | "agentId" | "reasonRef" | "contentRef" | "costMicros" | "durationMs"
    >,
  ): void {
    insertLedgerRow(this.database, {
      ...write,
      ownerId: input.ownerId,
      agentId: input.agentId,
      reasonRef: null,
      contentRef: null,
      costMicros: 0,
      durationMs: 0,
    });
  }

  private history(input: { ownerId: string; agentId: string; ruleId: string }, reason: string) {
    this.database
      .prepare(
        `INSERT INTO rule_book_history (
          owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id,
          change_reason, changed_at
        ) SELECT owner_id, agent_id, rule_id, revision, parameters, status, source,
          source_memory_id, ?, updated_at
        FROM rule_book_rules WHERE owner_id = ? AND agent_id = ? AND rule_id = ?`,
      )
      .run(reason, input.ownerId, input.agentId, input.ruleId);
  }

  private listDue(input: RuleInput<"listDue">): readonly RuleReviewCandidate[] {
    const now = this.time(input.now);
    const rows = this.database
      .prepare(
        `SELECT ${ruleColumns} FROM rule_book_rules
         WHERE owner_id = ? AND agent_id = ? AND substr(rule_id, 1, ${OWNER_RULE_PREFIX.length}) = ?
           AND status IN ('needs_review', 'suspended') AND source_memory_id IS NOT NULL
           AND review_after IS NOT NULL AND review_after <= ? AND review_attempts < ?
         ORDER BY review_after, rule_id LIMIT ?`,
      )
      .all(
        input.ownerId,
        input.agentId,
        OWNER_RULE_PREFIX,
        now,
        RULE_REVIEW_MAX_ATTEMPTS,
        this.limit(input.limit),
      ) as RuleRow[];
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          ruleId: row.ruleId,
          revision: row.revision,
          status: row.status,
          parameters: JSON.parse(row.parameters) as unknown,
          sourceMemoryId: row.sourceMemoryId as string,
          reviewAttempts: row.reviewAttempts,
        }),
      ),
    );
  }

  private resolve(input: RuleInput<"resolve">): boolean {
    this.assertDiskHeadroom();
    const ruleId = this.ruleId(input.ruleId);
    const now = this.time(input.now);
    const expected = this.revision(input.expectedRevision);
    const sourceMemoryId = this.memoryId(input.sourceMemoryId);
    const sourceRevision = input.sourceRevision;
    if (
      sourceRevision !== null &&
      (!Number.isSafeInteger(sourceRevision) || (sourceRevision as number) < 0)
    )
      this.invalid("Source memory revision is invalid");
    const resolution = input.resolution;
    let status: "active" | "suspended";
    let reason: string | null = null;
    let suggestion: string | null = null;
    if (resolution?.outcome === "cleared") status = "active";
    else if (resolution?.outcome === "suspended" && SUSPEND_REASONS.has(resolution.reason)) {
      status = "suspended";
      reason = resolution.reason;
      if (resolution.suggestion !== null) {
        if (resolution.reason !== "parameters_changed")
          this.invalid("Only a changed rule carries a suggestion");
        suggestion = JSON.stringify(resolution.suggestion);
        if (suggestion.length > MAX_SUGGESTION) this.invalid("Rule suggestion is too large");
      }
    } else return this.invalid("Rule review resolution is invalid");
    return this.database.transaction((): boolean => {
      const changed = this.database
        .prepare(
          `UPDATE rule_book_rules SET status = ?, suspend_reason = ?, suggestion = ?,
             review_after = NULL, review_attempts = 0, review_failure = NULL,
             reviewed_source_revision = ?, revision = revision + 1, updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND rule_id = ? AND revision = ?
             AND source_memory_id = ? AND status IN ('needs_review', 'suspended')`,
        )
        .run(
          status,
          reason,
          suggestion,
          sourceRevision,
          now,
          input.ownerId,
          input.agentId,
          ruleId,
          expected,
          sourceMemoryId,
        );
      if (changed.changes === 0) return false;
      this.history({ ...input, ruleId }, `rule_review_${resolution.outcome}`);
      this.ledger(input, {
        id: ledgerId("rule-review"),
        kind: "rule_review",
        decidedAt: now,
        outcome: resolution.outcome,
        reasonCode: reason ?? "meaning_unchanged",
        subjectRef: ruleId,
        inputs: {
          memoryIds: [sourceMemoryId],
          ruleIds: [ruleId],
          batchId: null,
          resultMemoryIds: [],
        },
      });
      return true;
    })();
  }

  private recordFailure(input: RuleInput<"recordFailure">): boolean {
    this.assertDiskHeadroom();
    const ruleId = this.ruleId(input.ruleId);
    const now = this.time(input.now);
    const retryAfter = this.time(input.retryAfter);
    const expected = this.revision(input.expectedRevision);
    if (!FAILURE_REASONS.has(input.reason)) this.invalid("Rule review failure is invalid");
    return this.database.transaction((): boolean => {
      const row = this.database
        .prepare(
          `UPDATE rule_book_rules SET review_attempts = review_attempts + 1, review_failure = ?,
             review_after = ?
           WHERE owner_id = ? AND agent_id = ? AND rule_id = ? AND revision = ?
             AND status IN ('needs_review', 'suspended') AND review_after IS NOT NULL
           RETURNING review_attempts AS attempts, source_memory_id AS sourceMemoryId`,
        )
        .get(input.reason, retryAfter, input.ownerId, input.agentId, ruleId, expected) as
        | { attempts: number; sourceMemoryId: string | null }
        | undefined;
      if (!row) return false;
      if (row.attempts === RULE_REVIEW_MAX_ATTEMPTS)
        this.ledger(input, {
          id: ledgerId("rule-review"),
          kind: "rule_review",
          decidedAt: now,
          outcome: "recheck_failed",
          reasonCode: input.reason,
          subjectRef: ruleId,
          inputs: {
            memoryIds: row.sourceMemoryId ? [row.sourceMemoryId] : [],
            ruleIds: [ruleId],
            batchId: null,
            resultMemoryIds: [],
          },
        });
      return true;
    })();
  }

  private listOpenRules(input: OwnerInput<"listOpen">): readonly RuleReviewListItem[] {
    const rows = this.database
      .prepare(
        `SELECT ${ruleColumns} FROM rule_book_rules
         WHERE owner_id = ? AND agent_id = ? AND substr(rule_id, 1, ${OWNER_RULE_PREFIX.length}) = ?
           AND status IN ('needs_review', 'suspended')
         ORDER BY updated_at DESC, rule_id LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, OWNER_RULE_PREFIX, this.limit(input.limit)) as RuleRow[];
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          ruleId: row.ruleId,
          revision: row.revision,
          status: row.status,
          parameters: JSON.parse(row.parameters) as unknown,
          sourceMemoryId: row.sourceMemoryId,
          suspendReason: row.suspendReason as RuleReviewListItem["suspendReason"],
          suggestion: row.suggestion
            ? (JSON.parse(row.suggestion) as RuleReviewListItem["suggestion"])
            : null,
          reviewAttempts: row.reviewAttempts,
          reviewFailure: row.reviewFailure as RuleReviewListItem["reviewFailure"],
          rechecking:
            row.reviewAfter !== null &&
            row.sourceMemoryId !== null &&
            row.reviewAttempts < RULE_REVIEW_MAX_ATTEMPTS,
          updatedAt: row.updatedAt,
        }),
      ),
    );
  }

  private act(input: OwnerInput<"act">): boolean {
    this.assertDiskHeadroom();
    const ruleId = this.ruleId(input.ruleId);
    const now = this.time(input.now);
    const expected = this.revision(input.expectedRevision);
    if (!OWNER_ACTIONS.has(input.action)) this.invalid("Rule review action is invalid");
    return this.database.transaction((): boolean => {
      const current = this.database
        .prepare(
          `SELECT ${ruleColumns} FROM rule_book_rules
           WHERE owner_id = ? AND agent_id = ? AND rule_id = ? AND revision = ?
             AND status IN ('needs_review', 'suspended')`,
        )
        .get(input.ownerId, input.agentId, ruleId, expected) as RuleRow | undefined;
      if (!current) return false;
      let status: "active" | "retired";
      let parameters = current.parameters;
      let outcome: "owner_adopted" | "owner_confirmed" | "owner_restored";
      if (input.action === "adopt") {
        if (current.status !== "suspended" || current.suggestion === null) return false;
        status = "active";
        parameters = current.suggestion;
        outcome = "owner_adopted";
      } else if (input.action === "confirm_suspended") {
        if (current.status !== "suspended") return false;
        status = "retired";
        outcome = "owner_confirmed";
      } else {
        status = "active";
        outcome = "owner_restored";
      }
      this.database
        .prepare(
          `UPDATE rule_book_rules SET status = ?, parameters = ?, suspend_reason = NULL,
             suggestion = NULL, review_after = NULL, review_attempts = 0, review_failure = NULL,
             revision = revision + 1, updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND rule_id = ? AND revision = ?`,
        )
        .run(status, parameters, now, input.ownerId, input.agentId, ruleId, expected);
      this.history({ ...input, ruleId }, outcome);
      this.ledger(input, {
        id: ledgerId("rule-review"),
        kind: "rule_review",
        decidedAt: now,
        outcome,
        reasonCode: current.status === "suspended" ? COUNTED_RULE_REASON : "from_needs_review",
        subjectRef: ruleId,
        inputs: {
          memoryIds: current.sourceMemoryId ? [current.sourceMemoryId] : [],
          ruleIds: [ruleId],
          batchId: null,
          resultMemoryIds: [],
        },
      });
      return true;
    })();
  }

  private expand(input: MemoryInput<"expand">): number {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    const limit = this.limit(input.limit);
    return this.database.transaction((): number => {
      const roots = this.database
        .prepare(
          `SELECT memory_id AS memoryId, upstream_memory_id AS upstreamMemoryId, reason, depth,
             flagged_at AS flaggedAt
           FROM memory_review_items
           WHERE owner_id = ? AND agent_id = ? AND expanded = 0
           ORDER BY flagged_at, memory_id, upstream_memory_id LIMIT ?`,
        )
        .all(input.ownerId, input.agentId, limit) as {
        memoryId: string;
        upstreamMemoryId: string;
        reason: string;
        depth: number;
        flaggedAt: string;
      }[];
      const upsert = this.database.prepare(
        `INSERT INTO memory_review_items (
           owner_id, agent_id, memory_id, upstream_memory_id, via_memory_id, reason, depth,
           expanded, status, flagged_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'open', ?)
         ON CONFLICT (owner_id, agent_id, memory_id, upstream_memory_id) DO UPDATE SET
           via_memory_id = excluded.via_memory_id, reason = excluded.reason,
           depth = excluded.depth, expanded = 1, truncated = 0, status = 'open',
           resolution = NULL, resolved_at = NULL, flagged_at = excluded.flagged_at
         WHERE memory_review_items.flagged_at < excluded.flagged_at
           OR (memory_review_items.status = 'open' AND excluded.depth < memory_review_items.depth)`,
      );
      const finish = this.database.prepare(
        `UPDATE memory_review_items SET expanded = 1, truncated = ?
         WHERE owner_id = ? AND agent_id = ? AND memory_id = ? AND upstream_memory_id = ?`,
      );
      for (const root of roots) {
        const remaining = Math.max(0, MEMORY_BASIS_CHAIN_MAX_DEPTH - root.depth);
        const tree = derivedMemories(
          this.database,
          { ownerId: input.ownerId, agentId: input.agentId, memoryId: root.memoryId },
          remaining,
        );
        const flagged: string[] = [root.memoryId];
        for (const node of tree.nodes) {
          if (node.memoryId === root.upstreamMemoryId) continue;
          upsert.run(
            input.ownerId,
            input.agentId,
            node.memoryId,
            root.upstreamMemoryId,
            node.via,
            root.reason,
            root.depth + node.depth,
            root.flaggedAt,
          );
          flagged.push(node.memoryId);
        }
        finish.run(
          tree.truncated ? 1 : 0,
          input.ownerId,
          input.agentId,
          root.memoryId,
          root.upstreamMemoryId,
        );
        this.ledger(input, {
          id: ledgerId("memory-review"),
          kind: "memory_review",
          decidedAt: now,
          outcome: "flagged",
          reasonCode: tree.truncated ? `${root.reason}_truncated`.slice(0, 64) : root.reason,
          subjectRef: root.upstreamMemoryId,
          inputs: {
            memoryIds: [root.upstreamMemoryId],
            ruleIds: [],
            batchId: null,
            resultMemoryIds: flagged,
          },
        });
      }
      return roots.length;
    })();
  }

  private listOpenMemories(input: MemoryInput<"listOpen">): readonly MemoryReviewItem[] {
    const rows = this.database
      .prepare(
        `SELECT memory_id AS memoryId, upstream_memory_id AS upstreamMemoryId,
           via_memory_id AS viaMemoryId, reason, depth, truncated, flagged_at AS flaggedAt
         FROM memory_review_items
         WHERE owner_id = ? AND agent_id = ? AND status = 'open'
         ORDER BY flagged_at DESC, memory_id, upstream_memory_id LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, this.limit(input.limit)) as (Omit<
      MemoryReviewItem,
      "truncated"
    > & { truncated: number })[];
    return Object.freeze(
      rows.map((row) => Object.freeze({ ...row, truncated: row.truncated === 1 })),
    );
  }

  private resolveMemory(input: MemoryInput<"resolve">): number {
    this.assertDiskHeadroom();
    const memoryId = this.memoryId(input.memoryId);
    const now = this.time(input.now);
    if (!RESOLUTIONS.has(input.resolution)) this.invalid("Memory review resolution is invalid");
    return this.database.transaction((): number => {
      const rows = this.database
        .prepare(
          `UPDATE memory_review_items SET status = 'resolved', resolution = ?, resolved_at = ?
           WHERE owner_id = ? AND agent_id = ? AND memory_id = ? AND status = 'open'
           RETURNING upstream_memory_id AS upstreamMemoryId, reason`,
        )
        .all(input.resolution, now, input.ownerId, input.agentId, memoryId) as {
        upstreamMemoryId: string;
        reason: string;
      }[];
      if (rows.length === 0) return 0;
      const counted = rows.some(({ reason }) => reason !== "owner_reported");
      this.ledger(input, {
        id: ledgerId("memory-review"),
        kind: "memory_review",
        decidedAt: now,
        outcome: input.resolution,
        reasonCode: counted ? COUNTED_MEMORY_REASON : "owner_reported",
        subjectRef: memoryId,
        inputs: {
          memoryIds: [...new Set(rows.map(({ upstreamMemoryId }) => upstreamMemoryId))].sort(),
          ruleIds: [],
          batchId: null,
          resultMemoryIds: [memoryId],
        },
      });
      return rows.length;
    })();
  }

  private reportMissed(input: MemoryInput<"reportMissed">): boolean {
    this.assertDiskHeadroom();
    const memoryId = this.memoryId(input.memoryId);
    const upstreamMemoryId = this.memoryId(input.upstreamMemoryId);
    const now = this.time(input.now);
    if (memoryId === upstreamMemoryId) this.invalid("A memory cannot be its own upstream");
    return this.database.transaction((): boolean => {
      const known = this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM memory_records
           WHERE owner_id = ? AND agent_id = ? AND id IN (?, ?)`,
        )
        .get(input.ownerId, input.agentId, memoryId, upstreamMemoryId) as { count: number };
      if (known.count !== 2) return this.fail("PORT_NOT_FOUND", "Memory not found");
      const existing = this.database
        .prepare(
          `SELECT reason FROM memory_review_items
           WHERE owner_id = ? AND agent_id = ? AND memory_id = ? AND upstream_memory_id = ?`,
        )
        .get(input.ownerId, input.agentId, memoryId, upstreamMemoryId) as
        | { reason: string }
        | undefined;
      if (existing) return false;
      this.database
        .prepare(
          `INSERT INTO memory_review_items (
             owner_id, agent_id, memory_id, upstream_memory_id, via_memory_id, reason, depth,
             expanded, status, flagged_at
           ) VALUES (?, ?, ?, ?, NULL, 'owner_reported', 1, 1, 'open', ?)`,
        )
        .run(input.ownerId, input.agentId, memoryId, upstreamMemoryId, now);
      this.ledger(input, {
        id: ledgerId("memory-review"),
        kind: "memory_review",
        decidedAt: now,
        outcome: "owner_reported_missed",
        reasonCode: "owner_reported",
        subjectRef: memoryId,
        inputs: {
          memoryIds: [upstreamMemoryId],
          ruleIds: [],
          batchId: null,
          resultMemoryIds: [memoryId],
        },
      });
      return true;
    })();
  }

  private agreement(input: MemoryInput<"agreement">): CorrectionAgreementCounts {
    const counts = this.database
      .prepare(
        `SELECT
           COUNT(*) FILTER (WHERE (kind = 'rule_review' AND reason_code = ?)
             OR (kind = 'memory_review' AND reason_code = ?
               AND outcome IN ('owner_edited', 'owner_dismissed'))) AS handled,
           COUNT(*) FILTER (WHERE (kind = 'rule_review' AND reason_code = ?
               AND outcome IN ('owner_adopted', 'owner_confirmed'))
             OR (kind = 'memory_review' AND reason_code = ? AND outcome = 'owner_edited')) AS agreed,
           COUNT(*) FILTER (WHERE kind = 'memory_review' AND outcome = 'owner_reported_missed') AS missed
         FROM decision_ledger
         WHERE owner_id = ? AND agent_id = ? AND kind IN ('rule_review', 'memory_review')
           AND outcome LIKE 'owner\\_%' ESCAPE '\\'`,
      )
      .get(
        COUNTED_RULE_REASON,
        COUNTED_MEMORY_REASON,
        COUNTED_RULE_REASON,
        COUNTED_MEMORY_REASON,
        input.ownerId,
        input.agentId,
      ) as { handled: number; agreed: number; missed: number };
    const open = this.database
      .prepare(
        `SELECT
           (SELECT COUNT(DISTINCT memory_id) FROM memory_review_items
             WHERE owner_id = ? AND agent_id = ? AND status = 'open') AS openMemories,
           (SELECT COUNT(*) FROM rule_book_rules
             WHERE owner_id = ? AND agent_id = ? AND status IN ('needs_review', 'suspended')
               AND substr(rule_id, 1, ${OWNER_RULE_PREFIX.length}) = ?) AS openRules`,
      )
      .get(input.ownerId, input.agentId, input.ownerId, input.agentId, OWNER_RULE_PREFIX) as {
      openMemories: number;
      openRules: number;
    };
    return Object.freeze({ ...counts, ...open });
  }
}
