import type {
  ExternalMemoryProposalBatch,
  ExternalMemoryProposalRecord,
  ExternalMemoryProposalScope,
  ExternalMemoryProposalSubmission,
  ExternalMemoryProposalSubmitResult,
} from "@himawari-agent/application";
import type { MemoryId } from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Scope = ExternalMemoryProposalScope;

interface Row {
  readonly id: string;
  readonly ownerId: ExternalMemoryProposalRecord["ownerId"];
  readonly agentId: ExternalMemoryProposalRecord["agentId"];
  readonly subjectRef: string;
  readonly client: string;
  readonly sourceKey: string | null;
  readonly textSha256: string;
  readonly normalization: string;
  readonly contentRef: string | null;
  readonly category: ExternalMemoryProposalRecord["category"];
  readonly dataClassification: ExternalMemoryProposalRecord["dataClassification"];
  readonly status: ExternalMemoryProposalRecord["status"];
  readonly receivedAt: string;
  readonly decidedAt: string | null;
  readonly batchId: string | null;
  readonly memoryId: MemoryId | null;
  readonly supersededBy: string | null;
}

const select = `SELECT id, owner_id AS ownerId, agent_id AS agentId, subject_ref AS subjectRef,
  client, source_key AS sourceKey, text_sha256 AS textSha256, normalization,
  content_ref AS contentRef, category, classification AS dataClassification, status,
  received_at AS receivedAt, decided_at AS decidedAt, batch_id AS batchId,
  memory_id AS memoryId, superseded_by AS supersededBy
  FROM external_memory_proposals`;

const DIGEST = /^[0-9a-f]{64}$/u;

function valid(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function record(row: Row): ExternalMemoryProposalRecord {
  return Object.freeze({ ...row });
}

export class SqliteExternalMemoryProposalOperations {
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
      case "externalMemoryProposal.submit":
        return this.submit(payload as ExternalMemoryProposalSubmission);
      case "externalMemoryProposal.read":
        return this.read(payload as Scope & { id: string });
      case "externalMemoryProposal.listPending":
        return this.listPending(payload as Scope & { limit: number });
      case "externalMemoryProposal.decide":
        return this.decide(
          payload as Scope & {
            id: string;
            status: "committed" | "rejected";
            decidedAt: string;
            batchId: string | null;
            memoryId: MemoryId | null;
          },
        );
      case "externalMemoryProposal.listBatch":
        return this.listBatch(payload as Scope & { batchId: string });
      case "externalMemoryProposal.listBatches":
        return this.listBatches(payload as Scope & { limit: number });
      case "externalMemoryProposal.reopenBatch":
        return this.reopenBatch(payload as Scope & { batchId: string });
      case "externalMemoryProposal.dropRejectedText":
        return this.dropRejectedText(payload as Scope & { decidedBefore: string });
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown external Memory proposal operation ${operation}`,
        );
    }
  }

  private submit(input: ExternalMemoryProposalSubmission): ExternalMemoryProposalSubmitResult {
    this.assertDiskHeadroom();
    if (!DIGEST.test(input.textSha256) || !valid(input.receivedAt) || input.contentRef === null)
      this.fail("PORT_INVALID_OPERATION", "External Memory proposal is invalid");
    return this.database.transaction((): ExternalMemoryProposalSubmitResult => {
      const existing = this.database
        .prepare(
          `${select} WHERE owner_id = ? AND agent_id = ? AND text_sha256 = ?
            AND status <> 'superseded'`,
        )
        .get(input.ownerId, input.agentId, input.textSha256) as Row | undefined;
      if (existing) return { proposal: record(existing), created: false, superseded: [] };
      const replaced =
        input.sourceKey === null
          ? []
          : (
              this.database
                .prepare(
                  `SELECT id FROM external_memory_proposals
                  WHERE owner_id = ? AND agent_id = ? AND source_key = ? AND status = 'pending'
                  ORDER BY received_at, id`,
                )
                .all(input.ownerId, input.agentId, input.sourceKey) as { id: string }[]
            ).map(({ id }) => id);
      this.database
        .prepare(
          `INSERT INTO external_memory_proposals (
            id, owner_id, agent_id, subject_ref, client, source_key, text_sha256, normalization,
            content_ref, category, classification, status, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          input.id,
          input.ownerId,
          input.agentId,
          input.subjectRef,
          input.client,
          input.sourceKey,
          input.textSha256,
          input.normalization,
          input.contentRef,
          input.category,
          input.dataClassification,
          input.receivedAt,
        );
      const supersede = this.database.prepare(
        `UPDATE external_memory_proposals SET status = 'superseded', decided_at = ?,
          superseded_by = ?
        WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'pending'`,
      );
      for (const id of replaced)
        supersede.run(input.receivedAt, input.id, id, input.ownerId, input.agentId);
      const created = this.read({ ownerId: input.ownerId, agentId: input.agentId, id: input.id });
      if (!created) return this.fail("PORT_NOT_FOUND", "External Memory proposal not found");
      return { proposal: created, created: true, superseded: replaced };
    })();
  }

  private read(input: Scope & { id: string }): ExternalMemoryProposalRecord | undefined {
    const row = this.database
      .prepare(`${select} WHERE id = ? AND owner_id = ? AND agent_id = ?`)
      .get(input.id, input.ownerId, input.agentId) as Row | undefined;
    return row ? record(row) : undefined;
  }

  private listPending(input: Scope & { limit: number }): {
    items: readonly ExternalMemoryProposalRecord[];
    total: number;
  } {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)
      this.fail("PORT_INVALID_OPERATION", "External Memory proposal limit is invalid");
    return this.database.transaction(() => ({
      items: (
        this.database
          .prepare(
            `${select} WHERE owner_id = ? AND agent_id = ? AND status = 'pending'
            ORDER BY received_at, rowid LIMIT ?`,
          )
          .all(input.ownerId, input.agentId, input.limit) as Row[]
      ).map(record),
      total: this.database
        .prepare(
          `SELECT COUNT(*) FROM external_memory_proposals
          WHERE owner_id = ? AND agent_id = ? AND status = 'pending'`,
        )
        .pluck()
        .get(input.ownerId, input.agentId) as number,
    }))();
  }

  private decide(
    input: Scope & {
      id: string;
      status: "committed" | "rejected";
      decidedAt: string;
      batchId: string | null;
      memoryId: MemoryId | null;
    },
  ): boolean {
    this.assertDiskHeadroom();
    if (
      !valid(input.decidedAt) ||
      !(["committed", "rejected"] as readonly string[]).includes(input.status) ||
      (input.status === "rejected" && input.memoryId !== null)
    )
      this.fail("PORT_INVALID_OPERATION", "External Memory proposal decision is invalid");
    return (
      this.database
        .prepare(
          `UPDATE external_memory_proposals SET status = ?, decided_at = ?, batch_id = ?,
            memory_id = ?
          WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'pending'`,
        )
        .run(
          input.status,
          input.decidedAt,
          input.batchId,
          input.memoryId,
          input.id,
          input.ownerId,
          input.agentId,
        ).changes === 1
    );
  }

  private listBatch(input: Scope & { batchId: string }): readonly ExternalMemoryProposalRecord[] {
    return (
      this.database
        .prepare(
          `${select} WHERE owner_id = ? AND agent_id = ? AND batch_id = ?
          ORDER BY received_at, id`,
        )
        .all(input.ownerId, input.agentId, input.batchId) as Row[]
    ).map(record);
  }

  private listBatches(input: Scope & { limit: number }): readonly ExternalMemoryProposalBatch[] {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)
      this.fail("PORT_INVALID_OPERATION", "External Memory proposal limit is invalid");
    return (
      this.database
        .prepare(
          `SELECT batch_id AS batchId, MAX(decided_at) AS decidedAt,
            SUM(status = 'committed') AS committed, SUM(status = 'rejected') AS rejected
          FROM external_memory_proposals
          WHERE owner_id = ? AND agent_id = ? AND batch_id IS NOT NULL
          GROUP BY batch_id ORDER BY MAX(decided_at) DESC, batch_id LIMIT ?`,
        )
        .all(input.ownerId, input.agentId, input.limit) as ExternalMemoryProposalBatch[]
    ).map((batch) => Object.freeze({ ...batch }));
  }

  private reopenBatch(input: Scope & { batchId: string }): readonly string[] {
    this.assertDiskHeadroom();
    return this.database.transaction(() => {
      const ids = (
        this.database
          .prepare(
            `SELECT id FROM external_memory_proposals
            WHERE owner_id = ? AND agent_id = ? AND batch_id = ? AND content_ref IS NOT NULL
            ORDER BY received_at, id`,
          )
          .all(input.ownerId, input.agentId, input.batchId) as { id: string }[]
      ).map(({ id }) => id);
      const reopen = this.database.prepare(
        `UPDATE external_memory_proposals SET status = 'pending', decided_at = NULL,
          batch_id = NULL, memory_id = NULL
        WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      );
      for (const id of ids) reopen.run(id, input.ownerId, input.agentId);
      return ids;
    })();
  }

  private dropRejectedText(input: Scope & { decidedBefore: string }): number {
    if (!valid(input.decidedBefore))
      this.fail("PORT_INVALID_OPERATION", "External Memory proposal time is invalid");
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT id, content_ref AS contentRef FROM external_memory_proposals
          WHERE owner_id = ? AND agent_id = ? AND status = 'rejected'
            AND content_ref IS NOT NULL AND decided_at < ?`,
        )
        .all(input.ownerId, input.agentId, input.decidedBefore) as {
        id: string;
        contentRef: string;
      }[];
      const clear = this.database.prepare(
        "UPDATE external_memory_proposals SET content_ref = NULL WHERE id = ?",
      );
      const used = this.database.prepare(
        "SELECT 1 FROM external_memory_proposals WHERE content_ref = ? LIMIT 1",
      );
      const drop = this.database.prepare(
        "DELETE FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?",
      );
      for (const row of rows) clear.run(row.id);
      for (const contentRef of new Set(rows.map((row) => row.contentRef)))
        if (!used.get(contentRef)) drop.run(contentRef, input.ownerId, input.agentId);
      return rows.length;
    })();
  }
}
