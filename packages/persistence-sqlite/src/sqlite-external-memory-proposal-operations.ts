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

const PROPOSAL_ID_MAXIMUM = 40;

const EXTERNAL_PROPOSAL_PENDING_MAXIMUM = 1000;

const EXTERNAL_PROPOSAL_HELD_TEXT_MAXIMUM = 5000;

const CATEGORIES: ReadonlySet<string> = new Set([
  "identity",
  "preference",
  "relationship",
  "goal",
  "project",
  "health",
  "finance",
  "event",
  "other",
]);

const CLASSIFICATIONS: ReadonlySet<string> = new Set(["private", "sensitive"]);

function within(value: string, maximum: number): boolean {
  const length = [...value].length;
  return length >= 1 && length <= maximum;
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
        return this.reopenBatch(
          payload as Scope & {
            batchId: string;
            reopen: readonly string[];
            trashed: readonly string[];
            complete: boolean;
          },
        );
      case "externalMemoryProposal.dropDiscardedText":
        return this.dropDiscardedText(payload as Scope & { decidedBefore: string });
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown external Memory proposal operation ${operation}`,
        );
    }
  }

  private submit(input: ExternalMemoryProposalSubmission): ExternalMemoryProposalSubmitResult {
    this.assertDiskHeadroom();
    if (
      !DIGEST.test(input.textSha256) ||
      !valid(input.receivedAt) ||
      input.contentRef === null ||
      input.id.length < 1 ||
      input.id.length > PROPOSAL_ID_MAXIMUM ||
      !within(input.subjectRef, 128) ||
      !within(input.client, 64) ||
      !within(input.normalization, 64) ||
      (input.sourceKey !== null && !within(input.sourceKey, 200)) ||
      !CATEGORIES.has(input.category) ||
      !CLASSIFICATIONS.has(input.dataClassification)
    )
      this.fail("PORT_INVALID_OPERATION", "External Memory proposal is invalid");
    const seen =
      this.database
        .prepare(
          `SELECT 1 FROM external_memory_proposals
          WHERE owner_id = ? AND agent_id = ? AND text_sha256 = ? AND status <> 'superseded'`,
        )
        .get(input.ownerId, input.agentId, input.textSha256) !== undefined;
    const held = this.database
      .prepare(
        `SELECT SUM(status = 'pending') AS pending, COUNT(*) AS held
        FROM external_memory_proposals
        WHERE owner_id = ? AND agent_id = ? AND status <> 'committed' AND content_ref IS NOT NULL`,
      )
      .get(input.ownerId, input.agentId) as { pending: number | null; held: number };
    if (
      !seen &&
      ((held.pending ?? 0) >= EXTERNAL_PROPOSAL_PENDING_MAXIMUM ||
        held.held >= EXTERNAL_PROPOSAL_HELD_TEXT_MAXIMUM)
    ) {
      if (!this.contentInUse(input.contentRef)) this.dropPayload(input.contentRef, input);
      this.fail("PORT_CONFLICT", "EXTERNAL_MEMORY_PROPOSAL_PENDING_FULL");
    }
    return this.database.transaction((): ExternalMemoryProposalSubmitResult => {
      const existing = this.database
        .prepare(
          `${select} WHERE owner_id = ? AND agent_id = ? AND text_sha256 = ?
            AND status <> 'superseded'`,
        )
        .get(input.ownerId, input.agentId, input.textSha256) as Row | undefined;
      const hold = (target: string): void => {
        this.database
          .prepare(
            `INSERT INTO external_memory_proposal_unkeyed (proposal_id, client) VALUES (?, ?)
            ON CONFLICT (proposal_id, client) DO NOTHING`,
          )
          .run(target, input.client);
      };
      const claim = (target: string): string[] => {
        if (input.sourceKey === null) return [];
        const previous = this.database
          .prepare(
            `SELECT proposal_id FROM external_memory_proposal_keys
            WHERE owner_id = ? AND agent_id = ? AND client = ? AND source_key = ?`,
          )
          .pluck()
          .get(input.ownerId, input.agentId, input.client, input.sourceKey) as string | undefined;
        this.database
          .prepare(
            `INSERT INTO external_memory_proposal_keys (
              owner_id, agent_id, client, source_key, proposal_id
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (owner_id, agent_id, client, source_key)
            DO UPDATE SET proposal_id = excluded.proposal_id`,
          )
          .run(input.ownerId, input.agentId, input.client, input.sourceKey, target);
        const candidates = previous === undefined ? [] : [previous];
        const retire = this.database.prepare(
          `UPDATE external_memory_proposals SET status = 'superseded', decided_at = ?,
            superseded_by = ?
          WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'pending'
            AND NOT EXISTS (SELECT 1 FROM external_memory_proposal_keys WHERE proposal_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM external_memory_proposal_unkeyed WHERE proposal_id = ? AND client <> ?
            )`,
        );
        return candidates.filter(
          (id) =>
            retire.run(
              input.receivedAt,
              target,
              id,
              input.ownerId,
              input.agentId,
              id,
              id,
              input.client,
            ).changes === 1,
        );
      };
      if (existing) {
        const known = record(existing);
        const replaced = claim(known.id);
        if (known.status === "pending" && input.sourceKey === null) hold(known.id);
        if (known.status === "pending") {
          if (known.sourceKey === null && input.sourceKey !== null && known.client === input.client)
            this.database
              .prepare(
                `UPDATE external_memory_proposals SET source_key = ?
                WHERE id = ? AND owner_id = ? AND agent_id = ?`,
              )
              .run(input.sourceKey, known.id, input.ownerId, input.agentId);
        }
        const keyed =
          known.status === "pending" &&
          known.sourceKey === null &&
          input.sourceKey !== null &&
          known.client === input.client
            ? { ...known, sourceKey: input.sourceKey }
            : known;
        const raised =
          known.status === "pending" &&
          known.dataClassification === "private" &&
          input.dataClassification === "sensitive";
        if (raised)
          this.database
            .prepare(
              `UPDATE external_memory_proposals SET classification = 'sensitive', content_ref = ?,
                category = ?
              WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'pending'`,
            )
            .run(input.contentRef, input.category, known.id, input.ownerId, input.agentId);
        const unused = raised ? known.contentRef : input.contentRef;
        if (unused !== null && known.contentRef !== input.contentRef && !this.contentInUse(unused))
          this.dropPayload(unused, input);
        return {
          proposal: raised
            ? {
                ...keyed,
                dataClassification: "sensitive",
                contentRef: input.contentRef,
                category: input.category,
              }
            : keyed,
          created: false,
          superseded: replaced,
        };
      }
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
      if (input.sourceKey === null) hold(input.id);
      const replaced = claim(input.id);
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
      (input.status === "rejected" && input.memoryId !== null) ||
      (input.status === "committed" && input.memoryId === null)
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

  private reopenBatch(
    input: Scope & {
      batchId: string;
      reopen: readonly string[];
      trashed: readonly string[];
      complete: boolean;
    },
  ): readonly string[] {
    this.assertDiskHeadroom();
    if (!Array.isArray(input.reopen) || !Array.isArray(input.trashed))
      this.fail("PORT_INVALID_OPERATION", "External Memory proposal batch is invalid");
    const wanted = new Set(input.reopen);
    return this.database.transaction(() => {
      const members = this.database
        .prepare(
          `SELECT id, status, content_ref AS contentRef FROM external_memory_proposals
          WHERE owner_id = ? AND agent_id = ? AND batch_id = ?
          ORDER BY received_at, id`,
        )
        .all(input.ownerId, input.agentId, input.batchId) as {
        id: string;
        status: string;
        contentRef: string | null;
      }[];
      const linked = this.database.prepare(
        `SELECT id, status, content_ref AS contentRef FROM external_memory_proposals
        WHERE owner_id = ? AND agent_id = ? AND status = 'committed' AND memory_id = ?
        ORDER BY received_at, id`,
      );
      const followers = input.trashed.flatMap(
        (memoryId) =>
          linked.all(input.ownerId, input.agentId, memoryId) as {
            id: string;
            status: string;
            contentRef: string | null;
          }[],
      );
      const reopen = this.database.prepare(
        `UPDATE external_memory_proposals SET status = 'pending', decided_at = NULL,
          batch_id = NULL, memory_id = NULL
        WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      );
      const detach = this.database.prepare(
        `UPDATE external_memory_proposals SET batch_id = NULL
        WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      );
      const reopened: string[] = [];
      for (const member of followers)
        if (!reopened.includes(member.id) && member.contentRef !== null) {
          reopen.run(member.id, input.ownerId, input.agentId);
          reopened.push(member.id);
        }
      for (const member of members) {
        if (reopened.includes(member.id)) continue;
        if (wanted.has(member.id) && member.contentRef !== null) {
          reopen.run(member.id, input.ownerId, input.agentId);
          reopened.push(member.id);
        } else if (input.complete) detach.run(member.id, input.ownerId, input.agentId);
      }
      return reopened;
    })();
  }

  private dropPayload(contentRef: string, scope: Scope): void {
    this.database
      .prepare("DELETE FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?")
      .run(contentRef, scope.ownerId, scope.agentId);
  }

  private contentInUse(contentRef: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 FROM external_memory_proposals WHERE content_ref = ? LIMIT 1")
        .get(contentRef) !== undefined
    );
  }

  private dropDiscardedText(input: Scope & { decidedBefore: string }): number {
    if (!valid(input.decidedBefore))
      this.fail("PORT_INVALID_OPERATION", "External Memory proposal time is invalid");
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT id, content_ref AS contentRef FROM external_memory_proposals
          WHERE owner_id = ? AND agent_id = ? AND status IN ('rejected', 'superseded')
            AND content_ref IS NOT NULL AND decided_at < ?`,
        )
        .all(input.ownerId, input.agentId, input.decidedBefore) as {
        id: string;
        contentRef: string;
      }[];
      const clear = this.database.prepare(
        "UPDATE external_memory_proposals SET content_ref = NULL, batch_id = NULL WHERE id = ?",
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
