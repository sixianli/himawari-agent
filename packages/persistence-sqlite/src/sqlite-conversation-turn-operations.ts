import type {
  ConversationSpan,
  ConversationTurn,
  ConversationTurnCandidate,
  ConversationTurnDocument,
  ConversationTurnSearchResult,
  ConversationTurnWatermark,
  MemoryIndexEmbedding,
} from "@himawari-agent/application";
import type { AgentId, OwnerId, ThreadId } from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";
import {
  blobVector,
  ftsQuery,
  type SqliteVectorEngine,
  vectorBlob,
} from "./sqlite-memory-operations.ts";

const CLASSIFICATIONS = new Set(["public", "private", "sensitive", "restricted"]);
const MODEL_VISIBLE = new Set(["public", "private", "sensitive"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

const turnColumns = `c.id AS id, c.owner_id AS ownerId, c.agent_id AS agentId,
  c.thread_id AS threadId, c.day AS day, c.first_sequence AS firstSequence,
  c.last_sequence AS lastSequence, c.classification AS dataClassification,
  c.started_at AS startedAt, c.ended_at AS endedAt, c.indexed_at AS indexedAt`;

const searchScope = `c.owner_id = @ownerId AND c.agent_id = @agentId
  AND c.classification IN (SELECT value FROM json_each(@classifications))
  AND (@from IS NULL OR c.ended_at >= @from) AND (@to IS NULL OR c.started_at <= @to)
  AND (@excludeThreadId IS NULL OR c.thread_id != @excludeThreadId)
  AND EXISTS (SELECT 1 FROM threads t WHERE t.id = c.thread_id AND t.status = 'open'
    AND t.origin = 'owner')`;

type TurnRow = Omit<ConversationTurn, "ownerId" | "agentId" | "threadId"> & {
  readonly ownerId: string;
  readonly agentId: string;
  readonly threadId: string;
};

function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validEmbedding(embedding: MemoryIndexEmbedding | null): boolean {
  return (
    embedding === null ||
    (typeof embedding.model === "string" &&
      embedding.model.length > 0 &&
      Number.isSafeInteger(embedding.dimensions) &&
      embedding.dimensions >= 1 &&
      embedding.dimensions <= 65536 &&
      embedding.vector instanceof Float32Array &&
      embedding.vector.length === embedding.dimensions)
  );
}

function limitWithin(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

export class SqliteConversationTurnOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;
  private readonly vectorEngine: SqliteVectorEngine;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
    vectorEngine: SqliteVectorEngine,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
    this.vectorEngine = vectorEngine;
  }

  execute(operation: string, payload: unknown): unknown {
    switch (operation) {
      case "conversationTurn.upsert":
        return this.upsert((payload as { document: ConversationTurnDocument }).document);
      case "conversationTurn.search":
        return this.search(
          payload as {
            ownerId: OwnerId;
            agentId: AgentId;
            embedding: MemoryIndexEmbedding | null;
            terms: readonly string[];
            allowedClassifications: readonly string[];
            from: string | null;
            to: string | null;
            excludeThreadId: ThreadId | null;
            limit: number;
          },
        );
      case "conversationTurn.listBehind":
        return this.listBehind(payload as { ownerId: OwnerId; agentId: AgentId; limit: number });
      case "conversationTurn.span":
        return this.span(
          payload as {
            ownerId: OwnerId;
            agentId: AgentId;
            allowedClassifications: readonly string[];
          },
        );
      case "conversationTurn.listUnembedded":
        return this.listUnembedded(
          payload as {
            ownerId: OwnerId;
            agentId: AgentId;
            model: string;
            dimensions: number;
            classifications: readonly string[];
            limit: number;
          },
        );
      case "conversationTurn.attachEmbedding":
        return this.attachEmbedding(
          payload as { turnId: string; lastSequence: number; embedding: MemoryIndexEmbedding },
        );
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown operation ${operation}`);
    }
  }

  private fromRow(row: TurnRow): ConversationTurn {
    return Object.freeze({
      ...row,
      ownerId: row.ownerId as OwnerId,
      agentId: row.agentId as AgentId,
      threadId: row.threadId as ThreadId,
    });
  }

  private upsert(document: ConversationTurnDocument): void {
    if (
      typeof document?.id !== "string" ||
      document.id.length === 0 ||
      !DAY.test(document.day) ||
      !Number.isSafeInteger(document.firstSequence) ||
      document.firstSequence < 1 ||
      !Number.isSafeInteger(document.lastSequence) ||
      document.lastSequence < document.firstSequence ||
      !CLASSIFICATIONS.has(document.dataClassification) ||
      !validTime(document.startedAt) ||
      !validTime(document.endedAt) ||
      !validTime(document.indexedAt) ||
      !Array.isArray(document.terms) ||
      document.terms.some((term) => typeof term !== "string" || /\s/u.test(term)) ||
      !validEmbedding(document.embedding)
    )
      this.fail("PORT_INVALID_OPERATION", "Conversation turn is invalid");
    this.assertDiskHeadroom();
    this.database
      .transaction(() => {
        const thread = this.database
          .prepare("SELECT 1 FROM threads WHERE id = ? AND owner_id = ? AND agent_id = ?")
          .get(document.threadId, document.ownerId, document.agentId);
        if (!thread) this.fail("PORT_NOT_FOUND", "Conversation turn Thread not found");
        const newer = this.database
          .prepare(
            `SELECT 1 FROM conversation_turns
            WHERE (id = ? OR (thread_id = ? AND first_sequence = ?)) AND last_sequence > ?`,
          )
          .get(document.id, document.threadId, document.firstSequence, document.lastSequence);
        if (newer) return;
        this.database
          .prepare(
            "DELETE FROM conversation_turns WHERE id = ? OR (thread_id = ? AND first_sequence = ?)",
          )
          .run(document.id, document.threadId, document.firstSequence);
        const inserted = this.database
          .prepare(
            `INSERT INTO conversation_turns (
              id, owner_id, agent_id, thread_id, day, first_sequence, last_sequence,
              classification, started_at, ended_at, indexed_at,
              embedding_model, embedding_dimensions, embedding
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            document.id,
            document.ownerId,
            document.agentId,
            document.threadId,
            document.day,
            document.firstSequence,
            document.lastSequence,
            document.dataClassification,
            document.startedAt,
            document.endedAt,
            document.indexedAt,
            document.embedding?.model ?? null,
            document.embedding?.dimensions ?? null,
            document.embedding ? vectorBlob(document.embedding) : null,
          );
        if (document.terms.length > 0 && MODEL_VISIBLE.has(document.dataClassification))
          this.database
            .prepare("INSERT INTO conversation_turn_terms (rowid, terms) VALUES (?, ?)")
            .run(inserted.lastInsertRowid, document.terms.join(" "));
      })
      .immediate();
  }

  private search(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    embedding: MemoryIndexEmbedding | null;
    terms: readonly string[];
    allowedClassifications: readonly string[];
    from: string | null;
    to: string | null;
    excludeThreadId: ThreadId | null;
    limit: number;
  }): ConversationTurnSearchResult {
    if (
      !limitWithin(input.limit, 500) ||
      !Array.isArray(input.allowedClassifications) ||
      input.allowedClassifications.some((value) => !MODEL_VISIBLE.has(value)) ||
      (input.from !== null && !validTime(input.from)) ||
      (input.to !== null && !validTime(input.to)) ||
      !Array.isArray(input.terms) ||
      !validEmbedding(input.embedding)
    )
      this.fail("PORT_INVALID_OPERATION", "Conversation turn search input is invalid");
    const scope = {
      ownerId: input.ownerId,
      agentId: input.agentId,
      classifications: JSON.stringify(input.allowedClassifications),
      from: input.from,
      to: input.to,
      excludeThreadId: input.excludeThreadId,
      limit: input.limit,
    };
    const candidate = (row: TurnRow & { signal: number }): ConversationTurnCandidate => {
      const { signal, ...turn } = row;
      return Object.freeze({ turn: this.fromRow(turn), signal });
    };
    let vector: ConversationTurnCandidate[] = [];
    const embedding = input.embedding;
    if (embedding) {
      const vectorScope = { ...scope, model: embedding.model, dimensions: embedding.dimensions };
      if (this.vectorEngine === "sqlite-vec") {
        vector = (
          this.database
            .prepare(
              `SELECT ${turnColumns}, 1 - vec_distance_cosine(c.embedding, @query) AS signal
              FROM conversation_turns c
              WHERE ${searchScope} AND c.embedding_model = @model
                AND c.embedding_dimensions = @dimensions
              ORDER BY signal DESC, c.id LIMIT @limit`,
            )
            .all({ ...vectorScope, query: vectorBlob(embedding) }) as (TurnRow & {
            signal: number;
          })[]
        ).map(candidate);
      } else {
        const query = embedding.vector;
        const queryNorm = Math.sqrt(query.reduce((sum, value) => sum + value * value, 0));
        vector = (
          this.database
            .prepare(
              `SELECT ${turnColumns}, c.embedding AS embedding FROM conversation_turns c
              WHERE ${searchScope} AND c.embedding_model = @model
                AND c.embedding_dimensions = @dimensions`,
            )
            .all(vectorScope) as (TurnRow & { embedding: Uint8Array })[]
        )
          .map(({ embedding: blob, ...row }) => {
            const values = blobVector(blob, embedding.dimensions);
            let dot = 0;
            let norm = 0;
            for (let index = 0; index < values.length; index += 1) {
              const value = values[index] ?? 0;
              dot += value * (query[index] ?? 0);
              norm += value * value;
            }
            const signal = norm === 0 || queryNorm === 0 ? 0 : dot / Math.sqrt(norm) / queryNorm;
            return candidate({ ...row, signal });
          })
          .sort(
            (left, right) =>
              right.signal - left.signal || left.turn.id.localeCompare(right.turn.id),
          )
          .slice(0, input.limit);
      }
    }
    const match = ftsQuery(input.terms);
    const lexical = match
      ? (
          this.database
            .prepare(
              `SELECT ${turnColumns}, -bm25(conversation_turn_terms) AS signal
              FROM conversation_turn_terms
              JOIN conversation_turns c ON c.rowid = conversation_turn_terms.rowid
              WHERE conversation_turn_terms MATCH @match AND ${searchScope}
              ORDER BY bm25(conversation_turn_terms), c.id LIMIT @limit`,
            )
            .all({ ...scope, match }) as (TurnRow & { signal: number })[]
        ).map(candidate)
      : [];
    return Object.freeze({ vector: Object.freeze(vector), lexical: Object.freeze(lexical) });
  }

  private listBehind(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    limit: number;
  }): readonly ConversationTurnWatermark[] {
    if (!limitWithin(input.limit, 100))
      this.fail("PORT_INVALID_OPERATION", "Conversation turn listing limit must be 1 to 100");
    return this.database
      .prepare(
        `SELECT t.id AS threadId,
          COALESCE(i.indexed_from, 0) AS indexedFrom,
          COALESCE(i.indexed_through, 0) AS indexedThrough,
          m.last_sequence AS lastSequence
        FROM threads t
        JOIN (SELECT thread_id, max(sequence) AS last_sequence, max(committed_at) AS last_at
          FROM thread_messages WHERE owner_id = @ownerId AND agent_id = @agentId
            AND internal = 0
          GROUP BY thread_id) m ON m.thread_id = t.id
        LEFT JOIN (SELECT thread_id, max(first_sequence) AS indexed_from,
            max(last_sequence) AS indexed_through
          FROM conversation_turns WHERE owner_id = @ownerId AND agent_id = @agentId
          GROUP BY thread_id) i ON i.thread_id = t.id
        WHERE t.owner_id = @ownerId AND t.agent_id = @agentId AND t.status = 'open'
          AND t.origin = 'owner'
          AND m.last_sequence > COALESCE(i.indexed_through, 0)
        ORDER BY m.last_at, t.id LIMIT @limit`,
      )
      .all(input) as ConversationTurnWatermark[];
  }

  private span(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    allowedClassifications: readonly string[];
  }): ConversationSpan | undefined {
    const months = this.database
      .prepare(
        `SELECT substr(day, 1, 7) AS month, count(DISTINCT day) AS days,
          min(day) AS firstDay, max(day) AS lastDay
        FROM conversation_turns
        WHERE owner_id = @ownerId AND agent_id = @agentId
          AND classification IN (SELECT value FROM json_each(@allowed))
        GROUP BY month ORDER BY month`,
      )
      .all({
        ownerId: input.ownerId,
        agentId: input.agentId,
        allowed: JSON.stringify(input.allowedClassifications),
      }) as { month: string; days: number; firstDay: string; lastDay: string }[];
    const [first] = months;
    const last = months.at(-1);
    if (!first || !last) return undefined;
    return Object.freeze({
      firstDay: first.firstDay,
      lastDay: last.lastDay,
      days: months.reduce((sum, { days }) => sum + days, 0),
      months: Object.freeze(months.map(({ month, days }) => Object.freeze({ month, days }))),
    });
  }

  private listUnembedded(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    model: string;
    dimensions: number;
    classifications: readonly string[];
    limit: number;
  }): readonly ConversationTurn[] {
    if (
      !limitWithin(input.limit, 100) ||
      typeof input.model !== "string" ||
      !Array.isArray(input.classifications) ||
      !input.classifications.every((value) => typeof value === "string")
    )
      this.fail("PORT_INVALID_OPERATION", "Conversation turn listing input is invalid");
    return (
      this.database
        .prepare(
          `SELECT ${turnColumns} FROM conversation_turns c
          WHERE c.owner_id = @ownerId AND c.agent_id = @agentId
            AND c.classification IN (SELECT value FROM json_each(@classifications))
            AND EXISTS (SELECT 1 FROM threads t WHERE t.id = c.thread_id AND t.status = 'open'
              AND t.origin = 'owner')
            AND (c.embedding_model IS NULL OR c.embedding_model != @model
              OR c.embedding_dimensions != @dimensions)
          ORDER BY c.indexed_at, c.id LIMIT @limit`,
        )
        .all({
          ownerId: input.ownerId,
          agentId: input.agentId,
          model: input.model,
          dimensions: input.dimensions,
          classifications: JSON.stringify(input.classifications),
          limit: input.limit,
        }) as TurnRow[]
    ).map((row) => this.fromRow(row));
  }

  private attachEmbedding(input: {
    turnId: string;
    lastSequence: number;
    embedding: MemoryIndexEmbedding;
  }): void {
    if (
      typeof input.turnId !== "string" ||
      !Number.isSafeInteger(input.lastSequence) ||
      !input.embedding ||
      !validEmbedding(input.embedding)
    )
      this.fail("PORT_INVALID_OPERATION", "Conversation turn embedding is invalid");
    this.assertDiskHeadroom();
    this.database
      .prepare(
        `UPDATE conversation_turns SET embedding_model = ?, embedding_dimensions = ?, embedding = ?
        WHERE id = ? AND last_sequence = ?`,
      )
      .run(
        input.embedding.model,
        input.embedding.dimensions,
        vectorBlob(input.embedding),
        input.turnId,
        input.lastSequence,
      );
  }
}
