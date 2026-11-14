import type { OwnerRuleStorePort, StoredOwnerRule } from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof OwnerRuleStorePort> = Parameters<OwnerRuleStorePort[TName]>[0];

const OWNER_RULE_PREFIX = "owner:";
const OWNER_RULE_ID = /^owner:[A-Za-z0-9_-]{1,58}$/u;
const MEMORY_ID = /^[\x21-\x7e]{1,128}$/u;
const MAX_PARAMETERS = 16_384;
const MAX_LISTED = 200;

const columns = `rule_id AS ruleId, revision, status, source, source_memory_id AS sourceMemoryId,
  parameters, updated_at AS updatedAt`;

interface Row {
  ruleId: string;
  revision: number;
  status: StoredOwnerRule["status"];
  source: string;
  sourceMemoryId: string | null;
  parameters: string;
  updatedAt: string;
}

function valid(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function fromRow(row: Row): StoredOwnerRule {
  return Object.freeze({
    ruleId: row.ruleId,
    revision: row.revision,
    status: row.status,
    source: row.source,
    sourceMemoryId: row.sourceMemoryId,
    parameters: JSON.parse(row.parameters) as unknown,
    updatedAt: row.updatedAt,
  });
}

export class SqliteOwnerRuleOperations {
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
      case "ownerRule.list":
        return this.list(payload as Input<"list">);
      case "ownerRule.read":
        return this.read(payload as Input<"read">);
      case "ownerRule.create":
        return this.create(payload as Input<"create">);
      case "ownerRule.setStatus":
        return this.setStatus(payload as Input<"setStatus">);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown owner rule operation ${operation}`);
    }
  }

  private invalid(message: string): never {
    return this.fail("PORT_INVALID_OPERATION", message);
  }

  private ruleId(value: unknown): string {
    if (typeof value !== "string" || !OWNER_RULE_ID.test(value))
      this.invalid("Owner rule id is invalid");
    return value;
  }

  private list(input: Input<"list">): readonly StoredOwnerRule[] {
    const rows = this.database
      .prepare(
        `SELECT ${columns} FROM rule_book_rules
         WHERE owner_id = ? AND agent_id = ? AND substr(rule_id, 1, ${OWNER_RULE_PREFIX.length}) = ?
           AND (? = 1 OR status <> 'retired')
         ORDER BY updated_at DESC, rule_id LIMIT ${MAX_LISTED}`,
      )
      .all(input.ownerId, input.agentId, OWNER_RULE_PREFIX, input.includeRetired ? 1 : 0) as Row[];
    return Object.freeze(rows.map(fromRow));
  }

  private read(input: Input<"read">): StoredOwnerRule | undefined {
    const row = this.database
      .prepare(
        `SELECT ${columns} FROM rule_book_rules WHERE owner_id = ? AND agent_id = ? AND rule_id = ?`,
      )
      .get(input.ownerId, input.agentId, this.ruleId(input.ruleId)) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  private history(ownerId: string, agentId: string, ruleId: string, reason: string | null): void {
    this.database
      .prepare(
        `INSERT INTO rule_book_history (
          owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id,
          change_reason, changed_at
        ) SELECT owner_id, agent_id, rule_id, revision, parameters, status, source,
          source_memory_id, ?, updated_at
        FROM rule_book_rules WHERE owner_id = ? AND agent_id = ? AND rule_id = ?`,
      )
      .run(reason, ownerId, agentId, ruleId);
  }

  private create(input: Input<"create">): "created" | "replayed" {
    this.assertDiskHeadroom();
    const ruleId = this.ruleId(input.ruleId);
    if (!valid(input.now)) this.invalid("Owner rule time is invalid");
    if (typeof input.sourceMemoryId !== "string" || !MEMORY_ID.test(input.sourceMemoryId))
      this.invalid("Owner rule memory id is invalid");
    if (typeof input.source !== "string" || input.source.length < 1 || input.source.length > 256)
      this.invalid("Owner rule source is invalid");
    if (
      typeof input.parameters !== "object" ||
      input.parameters === null ||
      Array.isArray(input.parameters)
    )
      this.invalid("Owner rule parameters are invalid");
    const parameters = JSON.stringify(input.parameters);
    if (parameters.length > MAX_PARAMETERS) this.invalid("Owner rule parameters are too large");
    return this.database.transaction((): "created" | "replayed" => {
      const existing = this.database
        .prepare(
          "SELECT parameters, source_memory_id AS sourceMemoryId FROM rule_book_rules WHERE owner_id = ? AND agent_id = ? AND rule_id = ?",
        )
        .get(input.ownerId, input.agentId, ruleId) as
        | { parameters: string; sourceMemoryId: string | null }
        | undefined;
      if (existing) {
        if (existing.parameters !== parameters || existing.sourceMemoryId !== input.sourceMemoryId)
          this.fail("PORT_CONFLICT", "Owner rule id already holds a different rule");
        return "replayed";
      }
      this.database
        .prepare(
          `INSERT INTO rule_book_rules (
            owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id,
            updated_at
          ) VALUES (?, ?, ?, 1, ?, 'active', ?, ?, ?)`,
        )
        .run(
          input.ownerId,
          input.agentId,
          ruleId,
          parameters,
          input.source,
          input.sourceMemoryId,
          input.now,
        );
      this.history(input.ownerId, input.agentId, ruleId, "owner_sentence");
      return "created";
    })();
  }

  private setStatus(input: Input<"setStatus">): StoredOwnerRule | undefined {
    this.assertDiskHeadroom();
    const ruleId = this.ruleId(input.ruleId);
    if (!valid(input.now)) this.invalid("Owner rule time is invalid");
    if (input.status !== "active" && input.status !== "retired")
      this.invalid("Owner rule status is invalid");
    if (input.reason !== "owner_undo" && input.reason !== "owner_confirmed")
      this.invalid("Owner rule change reason is invalid");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      this.invalid("Owner rule revision is invalid");
    return this.database.transaction((): StoredOwnerRule | undefined => {
      const changed = this.database
        .prepare(
          `UPDATE rule_book_rules SET status = ?, revision = revision + 1, updated_at = ?,
             review_after = NULL, review_attempts = 0, review_failure = NULL,
             suspend_reason = NULL, suggestion = NULL
           WHERE owner_id = ? AND agent_id = ? AND rule_id = ? AND revision = ? AND status != ?`,
        )
        .run(
          input.status,
          input.now,
          input.ownerId,
          input.agentId,
          ruleId,
          input.expectedRevision,
          input.status,
        );
      if (changed.changes === 0) return undefined;
      this.history(input.ownerId, input.agentId, ruleId, input.reason);
      return this.read({ ownerId: input.ownerId, agentId: input.agentId, ruleId });
    })();
  }
}
