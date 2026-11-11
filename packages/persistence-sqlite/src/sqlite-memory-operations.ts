import type {
  DecisionLedgerWrite,
  MemoryCategory,
  MemoryConsolidationWrite,
  MemoryEpisode,
  MemoryEpisodeCandidate,
  MemoryEpisodeDocument,
  MemoryEpisodeSearchResult,
  MemoryEpisodeThreadWatermark,
  MemoryHistoryEvent,
  MemoryHistoryNote,
  MemoryIndexCandidate,
  MemoryIndexDocument,
  MemoryIndexEmbedding,
  MemoryIndexSearchResult,
  MemoryProjectionJob,
  ProductMemoryAttributes,
  ProductMemoryRecord,
  SensitiveMemoryApprovalRequest,
} from "@himawari-agent/application";
import type {
  AgentId,
  MemoryGenerationId,
  MemoryId,
  OwnerId,
  ThreadId,
} from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import { insertLedgerRow, validateLedgerWrite } from "./sqlite-decision-ledger-operations.ts";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";
import { insertConsolidationWrite } from "./sqlite-memory-consolidation-operations.ts";

interface MemoryRow {
  readonly id: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly revision: number;
  readonly status: ProductMemoryRecord["status"];
  readonly contentRef: string;
  readonly classification: ProductMemoryRecord["dataClassification"];
  readonly sourceThreadId: string | null;
  readonly inference: number;
  readonly confidencePermille: number;
  readonly policyVersion: string;
  readonly providerRecordId: string | null;
  readonly lastUsedAt: string | null;
  readonly updatedAt: string;
  readonly category: ProductMemoryAttributes["category"];
  readonly importancePermille: number;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly supersededBy: string | null;
  readonly useCount: number;
  readonly evidenceVerified: number;
  readonly sensitiveTopic: string | null;
  readonly recordedAt: string | null;
  readonly tentative: number;
  readonly subCategory: string | null;
  readonly importBatchId: string | null;
  readonly stance: string | null;
}

interface MemoryHistoryRow {
  readonly id: number;
  readonly memoryId: string;
  readonly kind: MemoryHistoryEvent["kind"];
  readonly contentRef: string;
  readonly stance: string | null;
  readonly quoteRef: string | null;
  readonly sourceThreadId: string | null;
  readonly sourceDeleted: number;
  readonly occurredAt: string;
}

const memoryHistorySelect = `SELECT h.rowid AS id, h.memory_id AS memoryId, h.kind,
  h.content_ref AS contentRef, h.stance, h.quote_ref AS quoteRef,
  h.source_thread_id AS sourceThreadId, h.source_deleted AS sourceDeleted,
  h.occurred_at AS occurredAt
FROM memory_history_events h JOIN memory_records m ON m.id = h.memory_id`;

function memoryHistoryEvent(row: MemoryHistoryRow): MemoryHistoryEvent {
  return Object.freeze({
    id: row.id,
    memoryId: row.memoryId as MemoryId,
    kind: row.kind,
    contentRef: row.contentRef,
    stance: row.stance,
    quoteRef: row.quoteRef,
    sourceThreadId: row.sourceThreadId as ThreadId | null,
    sourceDeleted: row.sourceDeleted === 1,
    occurredAt: row.occurredAt,
  });
}

interface IndexCandidateRow {
  readonly memoryId: string;
  readonly revision: number;
  readonly importancePermille: number;
  readonly confidencePermille: number;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
  readonly signal: number;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly current: number;
}

interface EpisodeRow {
  readonly id: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly day: string;
  readonly source: MemoryEpisode["source"];
  readonly contentRef: string;
  readonly classification: MemoryEpisode["dataClassification"];
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly createdAt: string;
}

const episodeColumns = `e.id AS id, e.owner_id AS ownerId, e.agent_id AS agentId,
  e.thread_id AS threadId, e.day AS day, e.source AS source, e.content_ref AS contentRef,
  e.classification AS classification, e.first_sequence AS firstSequence,
  e.last_sequence AS lastSequence, e.started_at AS startedAt, e.ended_at AS endedAt,
  e.created_at AS createdAt`;

const episodeScope = `e.owner_id = @ownerId AND e.agent_id = @agentId
  AND e.classification IN (SELECT value FROM json_each(@classifications))
  AND (@from IS NULL OR e.ended_at >= @from) AND (@to IS NULL OR e.started_at <= @to)`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type SqliteVectorEngine = "sqlite-vec" | "javascript";

const CATEGORIES = new Set<string>([
  "identity",
  "preference",
  "relationship",
  "goal",
  "project",
  "rule",
  "health",
  "finance",
  "event",
  "other",
] satisfies MemoryCategory[]);
const SENSITIVE_TOPICS = new Set<string>([
  "health",
  "finance",
  "beliefs",
  "intimacy",
  "third_party",
  "location",
  "legal",
  "other",
]);
const DEFAULT_MEMORY_ATTRIBUTES: ProductMemoryAttributes = Object.freeze({
  category: "other",
  importancePermille: 500,
  entities: Object.freeze([]),
  validFrom: null,
  validTo: null,
  supersededBy: null,
  evidenceVerified: false,
});
const MODEL_VISIBLE_CLASSIFICATIONS = new Set(["public", "private", "sensitive"]);
const CLASSIFICATIONS = new Set(["public", "private", "sensitive", "restricted"]);
const MAXIMUM_ENTITIES = 16;
const MAXIMUM_INDEX_TERMS = 512;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function validMemoryTime(value: string | null): boolean {
  if (value === null) return true;
  if (DATE_ONLY.test(value)) return !Number.isNaN(new Date(`${value}T00:00:00.000Z`).valueOf());
  return validIsoTimestamp(value);
}

function normalizedEntity(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase();
}

function ftsQuery(terms: readonly string[]): string | null {
  const unique = [...new Set(terms.map((term) => term.trim()).filter((term) => term.length > 0))];
  if (unique.length === 0) return null;
  return unique
    .slice(0, 64)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function vectorBlob(embedding: MemoryIndexEmbedding): Buffer {
  return Buffer.from(
    embedding.vector.buffer,
    embedding.vector.byteOffset,
    embedding.vector.byteLength,
  );
}

function cosineSimilarity(values: Float32Array, query: Float32Array): number {
  let dot = 0;
  let norm = 0;
  let queryNorm = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    const other = query[index] ?? 0;
    dot += value * other;
    norm += value * value;
    queryNorm += other * other;
  }
  return norm === 0 || queryNorm === 0 ? 0 : dot / Math.sqrt(norm) / Math.sqrt(queryNorm);
}

function blobVector(blob: Uint8Array, dimensions: number): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, dimensions);
}

interface ProjectionJobRow {
  readonly id: string;
  readonly memoryId: string;
  readonly memoryRevision: number;
  readonly generationId: string;
  readonly operation: MemoryProjectionJob["operation"];
  readonly status: MemoryProjectionJob["status"];
  readonly attemptCount: number;
  readonly nextRetryAt: string | null;
  readonly providerRecordId: string | null;
  readonly errorCode: string | null;
  readonly claimedBy: string | null;
  readonly claimExpiresAt: string | null;
}

interface MemoryApprovalRow {
  readonly id: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly generationId: string;
  readonly sourceRef: string;
  readonly sourceClassification: SensitiveMemoryApprovalRequest["sourceClassification"];
  readonly candidateOrdinal: number;
  readonly productMemoryId: string;
  readonly decision: SensitiveMemoryApprovalRequest["decision"];
  readonly existingMemoryId: string | null;
  readonly classification: SensitiveMemoryApprovalRequest["dataClassification"];
  readonly policyVersion: string;
  readonly modelDescriptorRef: string;
  readonly status: SensitiveMemoryApprovalRequest["status"];
  readonly deliveryState: SensitiveMemoryApprovalRequest["deliveryState"];
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly committedAt: string | null;
}

const memorySelect = `SELECT id, owner_id AS ownerId, agent_id AS agentId, revision, status,
  content_ref AS contentRef, classification, source_thread_id AS sourceThreadId,
  inference, confidence_permille AS confidencePermille, policy_version AS policyVersion,
  provider_record_id AS providerRecordId, last_used_at AS lastUsedAt, updated_at AS updatedAt,
  category, importance_permille AS importancePermille, valid_from AS validFrom,
  valid_to AS validTo, superseded_by AS supersededBy, use_count AS useCount,
  evidence_verified AS evidenceVerified, sensitive_topic AS sensitiveTopic,
  recorded_at AS recordedAt, tentative, sub_category AS subCategory,
  import_batch_id AS importBatchId, stance
  FROM memory_records`;

const indexCandidateColumns = `m.id AS memoryId, m.revision AS revision,
  m.importance_permille AS importancePermille, m.confidence_permille AS confidencePermille,
  m.updated_at AS updatedAt, m.last_used_at AS lastUsedAt,
  COALESCE(m.valid_from, m.recorded_at, m.updated_at) AS startsAt, m.valid_to AS endsAt,
  CASE WHEN m.valid_to IS NULL OR m.valid_to > @now THEN 1 ELSE 0 END AS current`;

const indexScope = `m.owner_id = @ownerId AND m.agent_id = @agentId AND m.status = 'active'
  AND i.memory_revision = m.revision
  AND (@includeTentative = 1 OR m.tentative = 0)
  AND (@tentativeOnly = 0 OR m.tentative = 1)
  AND (@includeHistory = 1 OR m.valid_to IS NULL OR m.valid_to > @now)`;

const projectionJobSelect = `SELECT id, memory_id AS memoryId,
  memory_revision AS memoryRevision, generation_id AS generationId, operation, status,
  attempt_count AS attemptCount, next_retry_at AS nextRetryAt,
  provider_record_id AS providerRecordId, error_code AS errorCode,
  claimed_by AS claimedBy, claim_expires_at AS claimExpiresAt
  FROM memory_projection_jobs`;

const memoryApprovalSelect = `SELECT id, owner_id AS ownerId, agent_id AS agentId,
  run_id AS runId, thread_id AS threadId, generation_id AS generationId,
  source_ref AS sourceRef, source_classification AS sourceClassification,
  candidate_ordinal AS candidateOrdinal, product_memory_id AS productMemoryId,
  decision, existing_memory_id AS existingMemoryId, classification,
  policy_version AS policyVersion, model_descriptor_ref AS modelDescriptorRef,
  status, delivery_state AS deliveryState, requested_at AS requestedAt,
  decided_at AS decidedAt, committed_at AS committedAt FROM memory_approval_requests`;

function validIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export class SqliteMemoryOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;
  private readonly vectorEngine: SqliteVectorEngine;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
    vectorEngine: SqliteVectorEngine = "javascript",
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
    this.vectorEngine = vectorEngine;
  }

  execute(operation: string, payload: unknown): unknown {
    switch (operation) {
      case "memory.read":
        return this.read((payload as { memoryId: MemoryId }).memoryId);
      case "memory.readMany":
        return this.readMany(
          payload as { ownerId: OwnerId; agentId: AgentId; memoryIds: readonly MemoryId[] },
        );
      case "memory.searchActive":
        return this.searchActive(
          payload as {
            ownerId: OwnerId;
            agentId: AgentId;
            queryRef: string;
            limit: number;
          },
        );
      case "memory.save":
        return this.save(
          payload as { memory: ProductMemoryRecord; expectedRevision: number | null },
        );
      case "memory.saveWithProjection":
        return this.saveWithProjection(
          payload as {
            memory: ProductMemoryRecord;
            expectedRevision: number | null;
            job: MemoryProjectionJob;
            history?: MemoryHistoryNote;
            ledger?: DecisionLedgerWrite;
            consolidation?: MemoryConsolidationWrite;
          },
        );
      case "memory.listActive":
        return this.listActive(payload as { ownerId: OwnerId; agentId: AgentId });
      case "memory.markUsed":
        return this.markUsed(payload as { memoryIds: readonly MemoryId[]; usedAt: string });
      case "memory.appendHistory":
        return this.appendHistory(
          payload as { memoryId: MemoryId; note: MemoryHistoryNote; occurredAt: string },
        );
      case "memory.listHistory":
        return this.listHistory(
          payload as { ownerId: OwnerId; agentId: AgentId; memoryIds: readonly MemoryId[] },
        );
      case "memory.readHistory":
        return this.readHistory(payload as { ownerId: OwnerId; agentId: AgentId; id: number });
      case "memory.listInactive":
        return this.listInactive(
          payload as { ownerId: OwnerId; agentId: AgentId; trashedAfter: string; limit: number },
        );
      case "memoryJob.propose":
        return this.proposeJob(payload as { job: MemoryProjectionJob; requeueCompleted: boolean });
      case "memoryJob.listPending":
        return this.listPendingJobs(payload as { now: string; limit: number });
      case "memoryJob.claim":
        return this.claimJob(
          payload as {
            jobId: string;
            claimedBy: string;
            claimedAt: string;
            expiresAt: string;
          },
        );
      case "memoryJob.complete":
        return this.completeJob(
          payload as { jobId: string; claimedBy: string; providerRecordId: string | null },
        );
      case "memoryJob.retry":
        return this.retryJob(
          payload as {
            jobId: string;
            claimedBy: string;
            errorCode: string;
            nextRetryAt: string | null;
          },
        );
      case "memoryJob.listByMemory":
        return this.listJobsByMemory((payload as { memoryId: MemoryId }).memoryId);
      case "memoryApproval.create":
        return this.createApproval(
          (payload as { request: SensitiveMemoryApprovalRequest }).request,
        );
      case "memoryApproval.read":
        return this.readApproval((payload as { requestId: string }).requestId);
      case "memoryApproval.resolve":
        return this.resolveApproval(
          payload as {
            requestId: string;
            resolution: "approved" | "edited" | "rejected" | "expired";
            decidedAt: string;
          },
        );
      case "memoryApproval.markCommitted":
        return this.markApprovalCommitted(payload as { requestId: string; committedAt: string });
      case "memoryApproval.listPending":
        return this.listPendingApprovals(
          payload as { ownerId: OwnerId; threadId: ThreadId | null },
        );
      case "memoryIndex.upsert":
        return this.upsertIndex((payload as { document: MemoryIndexDocument }).document);
      case "memoryIndex.delete":
        return this.deleteIndex((payload as { memoryId: MemoryId }).memoryId);
      case "memoryIndex.clearScope":
        return this.clearIndexScope(payload as { ownerId: OwnerId; agentId: AgentId });
      case "memoryIndex.search":
        return this.searchIndex(
          payload as {
            ownerId: OwnerId;
            agentId: AgentId;
            embedding: MemoryIndexEmbedding | null;
            terms: readonly string[];
            queryText: string;
            limit: number;
            minimumSimilarity: number;
            now: string;
            includeHistory?: boolean;
            includeTentative?: boolean;
            tentativeOnly?: boolean;
          },
        );
      case "memoryEpisode.upsert":
        return this.upsertEpisode((payload as { document: MemoryEpisodeDocument }).document);
      case "memoryEpisode.search":
        return this.searchEpisodes(
          payload as {
            ownerId: OwnerId;
            agentId: AgentId;
            embedding: MemoryIndexEmbedding | null;
            terms: readonly string[];
            allowedClassifications: readonly string[];
            from: string | null;
            to: string | null;
            limit: number;
          },
        );
      case "memoryEpisode.listUnembedded":
        return this.listUnembedded(
          payload as {
            ownerId: OwnerId;
            agentId: AgentId;
            model: string;
            dimensions: number;
            after?: { createdAt: string; id: string };
            limit: number;
          },
        );
      case "memoryEpisode.attachEmbedding":
        return this.attachEpisodeEmbedding(
          payload as { episodeId: string; embedding: MemoryIndexEmbedding },
        );
      case "memoryEpisode.listUnsummarized":
        return this.listUnsummarized(
          payload as { ownerId: OwnerId; agentId: AgentId; activeSince?: string; limit: number },
        );
      case "memoryEpisode.listDaySummaries":
        return this.listDaySummaries(
          payload as {
            ownerId: OwnerId;
            agentId: AgentId;
            fromDay: string;
            toDay: string;
            allowedClassifications: readonly string[];
            limit: number;
          },
        );
      case "memoryEpisode.listDaySummariesAfter":
        return this.listDaySummariesAfter(
          payload as {
            ownerId: OwnerId;
            agentId: AgentId;
            after: { createdAt: string; episodeId: string } | null;
            limit: number;
          },
        );
      case "memoryIndex.listUnindexed":
        return this.listUnindexed(
          payload as {
            ownerId: OwnerId;
            agentId: AgentId;
            model: string;
            dimensions: number;
            embeddableClassifications: readonly string[];
            afterMemoryId: MemoryId | null;
            limit: number;
          },
        );
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown Memory operation ${operation}`);
    }
  }

  private sources(memoryId: MemoryId): readonly string[] {
    return this.database
      .prepare(
        `SELECT source_id FROM memory_provenance WHERE memory_id = ?
        ORDER BY source_type, source_id`,
      )
      .pluck()
      .all(memoryId) as string[];
  }

  private memoryFromRow(row: MemoryRow): ProductMemoryRecord {
    return Object.freeze({
      id: row.id as MemoryId,
      ownerId: row.ownerId as OwnerId,
      agentId: row.agentId as AgentId,
      revision: row.revision,
      status: row.status,
      contentRef: row.contentRef,
      dataClassification: row.classification,
      sourceThreadId: row.sourceThreadId as ThreadId | null,
      sourceRefs: this.sources(row.id as MemoryId),
      inference: row.inference === 1,
      confidencePermille: row.confidencePermille,
      policyVersion: row.policyVersion,
      providerRecordId: row.providerRecordId,
      lastUsedAt: row.lastUsedAt,
      updatedAt: row.updatedAt,
      recordedAt: row.recordedAt ?? row.updatedAt,
      attributes: Object.freeze({
        category: row.category,
        importancePermille: row.importancePermille,
        entities: Object.freeze(this.entities(row.id as MemoryId)),
        validFrom: row.validFrom,
        validTo: row.validTo,
        supersededBy: row.supersededBy as MemoryId | null,
        evidenceVerified: row.evidenceVerified === 1,
        ...(row.sensitiveTopic
          ? {
              sensitiveTopic: row.sensitiveTopic as NonNullable<
                ProductMemoryAttributes["sensitiveTopic"]
              >,
            }
          : {}),
        ...(row.tentative === 1 ? { tentative: true } : {}),
        ...(row.subCategory ? { subCategory: row.subCategory } : {}),
        ...(row.importBatchId ? { importBatchId: row.importBatchId } : {}),
        ...(row.stance ? { stance: row.stance } : {}),
      }),
      useCount: row.useCount,
    });
  }

  private entities(memoryId: MemoryId): string[] {
    return this.database
      .prepare("SELECT name FROM memory_entities WHERE memory_id = ? ORDER BY name")
      .pluck()
      .all(memoryId) as string[];
  }

  private jobFromRow(row: ProjectionJobRow): MemoryProjectionJob {
    return Object.freeze({
      id: row.id,
      memoryId: row.memoryId as MemoryId,
      memoryRevision: row.memoryRevision,
      generationId: row.generationId as MemoryGenerationId,
      operation: row.operation,
      status: row.status,
      attemptCount: row.attemptCount,
      nextRetryAt: row.nextRetryAt,
      providerRecordId: row.providerRecordId,
      errorCode: row.errorCode,
      claimedBy: row.claimedBy,
      claimExpiresAt: row.claimExpiresAt,
    });
  }

  private read(memoryId: MemoryId): ProductMemoryRecord | undefined {
    const row = this.database.prepare(`${memorySelect} WHERE id = ?`).get(memoryId) as
      | MemoryRow
      | undefined;
    return row ? this.memoryFromRow(row) : undefined;
  }

  private readMany(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    memoryIds: readonly MemoryId[];
  }): readonly ProductMemoryRecord[] {
    if (input.memoryIds.length === 0) return [];
    if (input.memoryIds.length > 1000) {
      this.fail("PORT_INVALID_OPERATION", "Memory readMany limit exceeds 1000");
    }
    const unique = [...new Set(input.memoryIds)];
    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `${memorySelect} WHERE owner_id = ? AND agent_id = ? AND id IN (${placeholders})
        ORDER BY id`,
      )
      .all(input.ownerId, input.agentId, ...unique) as MemoryRow[];
    return rows.map((row) => this.memoryFromRow(row));
  }

  private searchActive(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    queryRef: string;
    limit: number;
  }): readonly ProductMemoryRecord[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 1000) {
      this.fail("PORT_INVALID_OPERATION", "Memory query limit must be between 0 and 1000");
    }
    const queryPayload = this.database
      .prepare(
        `SELECT 1 FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?
        AND lifecycle_state = 'active'`,
      )
      .get(input.queryRef, input.ownerId, input.agentId);
    if (!queryPayload) this.fail("PORT_NOT_FOUND", `Query Payload ${input.queryRef} not found`);
    const rows = this.database
      .prepare(
        `${memorySelect} WHERE owner_id = ? AND agent_id = ? AND status = 'active'
        ORDER BY COALESCE(last_used_at, updated_at) DESC, id LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.limit) as MemoryRow[];
    return rows.map((row) => this.memoryFromRow(row));
  }

  private assertMemoryShape(memory: ProductMemoryRecord): void {
    const validStatus = [
      "active",
      "archived",
      "trashed",
      "deletion_pending",
      "deleted_verified",
    ].includes(memory.status);
    if (
      !Number.isSafeInteger(memory.revision) ||
      memory.revision < 1 ||
      !Number.isSafeInteger(memory.confidencePermille) ||
      memory.confidencePermille < 0 ||
      memory.confidencePermille > 1000 ||
      !validStatus ||
      memory.contentRef.length === 0 ||
      memory.policyVersion.length === 0 ||
      !validIsoTimestamp(memory.updatedAt) ||
      (memory.lastUsedAt !== null && !validIsoTimestamp(memory.lastUsedAt)) ||
      memory.sourceRefs.length === 0 ||
      memory.sourceRefs.some((source) => source.length === 0)
    ) {
      this.fail("PORT_INVALID_OPERATION", `Memory ${memory.id} has an invalid shape`);
    }
    const attributes = memory.attributes ?? DEFAULT_MEMORY_ATTRIBUTES;
    if (
      !CATEGORIES.has(attributes.category) ||
      !Number.isSafeInteger(attributes.importancePermille) ||
      attributes.importancePermille < 0 ||
      attributes.importancePermille > 1000 ||
      !validMemoryTime(attributes.validFrom) ||
      !validMemoryTime(attributes.validTo) ||
      attributes.supersededBy === memory.id ||
      !(attributes.sensitiveTopic == null || SENSITIVE_TOPICS.has(attributes.sensitiveTopic)) ||
      attributes.entities.length > MAXIMUM_ENTITIES ||
      (attributes.subCategory != null &&
        (attributes.subCategory.trim().length === 0 || [...attributes.subCategory].length > 32)) ||
      (attributes.stance != null &&
        (attributes.stance.trim().length === 0 || [...attributes.stance].length > 16)) ||
      attributes.entities.some((name) => {
        const normalized = normalizedEntity(name);
        return normalized.length === 0 || normalized.length > 64;
      })
    ) {
      this.fail("PORT_INVALID_OPERATION", `Memory ${memory.id} has invalid attributes`);
    }
  }

  private validTransition(
    current: ProductMemoryRecord["status"],
    next: ProductMemoryRecord["status"],
  ): boolean {
    if (current === next) return current === "active" || current === "archived";
    if (current === "active") {
      return ["archived", "trashed", "deletion_pending"].includes(next);
    }
    if (current === "archived")
      return next === "deletion_pending" || next === "active" || next === "trashed";
    if (current === "trashed") return next === "deletion_pending" || next === "active";
    return current === "deletion_pending" && next === "deleted_verified";
  }

  private saveWithProjection(input: {
    memory: ProductMemoryRecord;
    expectedRevision: number | null;
    job: MemoryProjectionJob;
    history?: MemoryHistoryNote;
    ledger?: DecisionLedgerWrite;
    consolidation?: MemoryConsolidationWrite;
  }): ProductMemoryRecord {
    if (
      input.consolidation &&
      (input.consolidation.change.memoryId !== input.memory.id ||
        input.consolidation.change.afterRevision !== input.memory.revision)
    )
      this.fail("PORT_INVALID_OPERATION", "Memory consolidation does not match the saved record");
    if (input.ledger) {
      const problem = validateLedgerWrite(input.ledger);
      if (problem) this.fail("PORT_INVALID_OPERATION", problem);
    }
    if (
      input.job.memoryId !== input.memory.id ||
      input.job.memoryRevision !== input.memory.revision ||
      input.job.operation !== (input.memory.status === "active" ? "upsert" : "delete") ||
      input.memory.status === "deleted_verified" ||
      input.job.providerRecordId !== input.memory.providerRecordId
    ) {
      this.fail("PORT_INVALID_OPERATION", "Memory projection does not match the saved record");
    }
    return this.database
      .transaction(() => {
        const saved = this.save(input);
        this.proposeJob({ job: input.job, requeueCompleted: false });
        if (input.ledger) insertLedgerRow(this.database, input.ledger);
        if (input.consolidation)
          insertConsolidationWrite(this.database, input.consolidation, this.fail);
        return saved;
      })
      .immediate();
  }

  private save(input: {
    memory: ProductMemoryRecord;
    expectedRevision: number | null;
    history?: MemoryHistoryNote;
  }): ProductMemoryRecord {
    this.assertDiskHeadroom();
    this.assertMemoryShape(input.memory);
    const attributes = input.memory.attributes ?? DEFAULT_MEMORY_ATTRIBUTES;
    const transaction = this.database.transaction(() => {
      const current = this.read(input.memory.id);
      const payload = this.database
        .prepare(
          `SELECT classification FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?
          AND lifecycle_state = 'active'`,
        )
        .get(input.memory.contentRef, input.memory.ownerId, input.memory.agentId) as
        | { readonly classification: string }
        | undefined;
      if (!payload) {
        this.fail("PORT_NOT_FOUND", `Memory Payload ${input.memory.contentRef} not found`);
      }
      if (payload.classification !== input.memory.dataClassification) {
        this.fail("PORT_INVALID_OPERATION", "Memory and Payload classifications differ");
      }
      if (input.memory.sourceThreadId) {
        const sourceThread = this.database
          .prepare("SELECT 1 FROM threads WHERE id = ? AND owner_id = ? AND agent_id = ?")
          .get(input.memory.sourceThreadId, input.memory.ownerId, input.memory.agentId);
        if (!sourceThread) this.fail("PORT_NOT_FOUND", "Memory source Thread not found");
      }
      if (!current) {
        if (input.expectedRevision !== null || input.memory.revision !== 1) {
          this.fail("PORT_CONFLICT", `Memory ${input.memory.id} creation revision conflict`);
        }
        this.database
          .prepare(
            `INSERT INTO memory_records (
              id, owner_id, agent_id, revision, status, content_ref, classification,
              source_thread_id, inference, confidence_permille, policy_version,
              provider_record_id, last_used_at, updated_at, category, importance_permille,
              valid_from, valid_to, superseded_by, evidence_verified, sensitive_topic,
              recorded_at, tentative, sub_category, import_batch_id, stance
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.memory.id,
            input.memory.ownerId,
            input.memory.agentId,
            input.memory.revision,
            input.memory.status,
            input.memory.contentRef,
            input.memory.dataClassification,
            input.memory.sourceThreadId,
            input.memory.inference ? 1 : 0,
            input.memory.confidencePermille,
            input.memory.policyVersion,
            input.memory.providerRecordId,
            input.memory.lastUsedAt,
            input.memory.updatedAt,
            attributes.category,
            attributes.importancePermille,
            attributes.validFrom,
            attributes.validTo,
            attributes.supersededBy,
            attributes.evidenceVerified ? 1 : 0,
            attributes.sensitiveTopic ?? null,
            input.memory.updatedAt,
            attributes.tentative === true ? 1 : 0,
            attributes.subCategory ?? null,
            attributes.importBatchId ?? null,
            attributes.stance ?? null,
          );
      } else {
        if (
          input.expectedRevision !== current.revision ||
          input.memory.revision !== current.revision + 1 ||
          input.memory.ownerId !== current.ownerId ||
          input.memory.agentId !== current.agentId ||
          !this.validTransition(current.status, input.memory.status) ||
          (current.status === "deleted_verified" && input.memory.status !== "deleted_verified")
        ) {
          this.fail("PORT_CONFLICT", `Memory ${input.memory.id} revision or lifecycle conflict`);
        }
        this.database
          .prepare(
            `UPDATE memory_records SET revision = ?, status = ?, content_ref = ?,
              classification = ?, source_thread_id = ?, inference = ?, confidence_permille = ?,
              policy_version = ?, provider_record_id = ?, last_used_at = ?, updated_at = ?,
              category = ?, importance_permille = ?, valid_from = ?, valid_to = ?,
              superseded_by = ?, evidence_verified = ?, sensitive_topic = ?, tentative = ?,
              sub_category = ?, stance = ?
            WHERE id = ?`,
          )
          .run(
            input.memory.revision,
            input.memory.status,
            input.memory.contentRef,
            input.memory.dataClassification,
            input.memory.sourceThreadId,
            input.memory.inference ? 1 : 0,
            input.memory.confidencePermille,
            input.memory.policyVersion,
            input.memory.providerRecordId,
            input.memory.lastUsedAt,
            input.memory.updatedAt,
            attributes.category,
            attributes.importancePermille,
            attributes.validFrom,
            attributes.validTo,
            attributes.supersededBy,
            attributes.evidenceVerified ? 1 : 0,
            attributes.sensitiveTopic ?? null,
            attributes.tentative === true ? 1 : 0,
            attributes.subCategory ?? null,
            attributes.stance ?? null,
            input.memory.id,
          );
      }
      const history =
        input.history ??
        (!current
          ? { kind: "created" as const }
          : current.contentRef !== input.memory.contentRef
            ? { kind: "updated" as const }
            : undefined);
      if (history) this.insertHistory(input.memory, history, input.memory.updatedAt);
      this.database.prepare("DELETE FROM memory_entities WHERE memory_id = ?").run(input.memory.id);
      if (MODEL_VISIBLE_CLASSIFICATIONS.has(input.memory.dataClassification)) {
        const insertEntity = this.database.prepare(
          "INSERT INTO memory_entities (memory_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING",
        );
        for (const name of new Set(attributes.entities.map(normalizedEntity)))
          insertEntity.run(input.memory.id, name);
      }
      const insertSource = this.database.prepare(
        `INSERT INTO memory_provenance (memory_id, source_type, source_id, source_deleted)
        VALUES (?, 'reference', ?, 0) ON CONFLICT DO NOTHING`,
      );
      for (const sourceRef of [...new Set(input.memory.sourceRefs)]) {
        insertSource.run(input.memory.id, sourceRef);
      }
      return this.read(input.memory.id) as ProductMemoryRecord;
    });
    return transaction.immediate();
  }

  private insertHistory(
    memory: ProductMemoryRecord,
    note: MemoryHistoryNote,
    occurredAt: string,
  ): void {
    if (!validIsoTimestamp(occurredAt)) this.fail("PORT_INVALID_OPERATION", "Invalid history time");
    if (note.quoteRef) {
      const quote = this.database
        .prepare(
          `SELECT classification FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?
          AND lifecycle_state = 'active'`,
        )
        .get(note.quoteRef, memory.ownerId, memory.agentId) as
        | { readonly classification: string }
        | undefined;
      if (!quote) this.fail("PORT_NOT_FOUND", `Memory quote Payload ${note.quoteRef} not found`);
      if (quote.classification !== memory.dataClassification)
        this.fail("PORT_INVALID_OPERATION", "Memory and quote classifications differ");
    }
    const sourceThreadId =
      note.sourceThreadId === undefined ? memory.sourceThreadId : note.sourceThreadId;
    const sourceExists =
      sourceThreadId !== null &&
      this.database
        .prepare("SELECT 1 FROM threads WHERE id = ? AND owner_id = ? AND agent_id = ?")
        .get(sourceThreadId, memory.ownerId, memory.agentId) !== undefined;
    this.database
      .prepare(
        `INSERT INTO memory_history_events (
          memory_id, kind, content_ref, stance, quote_ref, source_thread_id, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        note.kind,
        memory.contentRef,
        memory.attributes?.stance ?? null,
        note.quoteRef ?? null,
        sourceExists ? sourceThreadId : null,
        occurredAt,
      );
  }

  private appendHistory(input: {
    memoryId: MemoryId;
    note: MemoryHistoryNote;
    occurredAt: string;
  }): void {
    this.assertDiskHeadroom();
    this.database
      .transaction(() => {
        const memory = this.read(input.memoryId);
        if (!memory) this.fail("PORT_NOT_FOUND", `Memory ${input.memoryId} not found`);
        if (memory.status !== "active")
          this.fail("PORT_INVALID_OPERATION", `Memory ${input.memoryId} is not active`);
        this.insertHistory(memory, input.note, input.occurredAt);
      })
      .immediate();
  }

  private listHistory(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    memoryIds: readonly MemoryId[];
  }): readonly MemoryHistoryEvent[] {
    if (input.memoryIds.length === 0) return [];
    if (input.memoryIds.length > 1000) {
      this.fail("PORT_INVALID_OPERATION", "Memory history limit exceeds 1000");
    }
    const unique = [...new Set(input.memoryIds)];
    const rows = this.database
      .prepare(
        `${memoryHistorySelect}
        WHERE m.owner_id = ? AND m.agent_id = ? AND h.memory_id IN (${unique.map(() => "?").join(", ")})
        ORDER BY h.occurred_at, h.rowid`,
      )
      .all(input.ownerId, input.agentId, ...unique) as MemoryHistoryRow[];
    return rows.map(memoryHistoryEvent);
  }

  private readHistory(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    id: number;
  }): MemoryHistoryEvent | undefined {
    if (!Number.isSafeInteger(input.id) || input.id < 1) return undefined;
    const row = this.database
      .prepare(`${memoryHistorySelect} WHERE m.owner_id = ? AND m.agent_id = ? AND h.rowid = ?`)
      .get(input.ownerId, input.agentId, input.id) as MemoryHistoryRow | undefined;
    return row ? memoryHistoryEvent(row) : undefined;
  }

  private listInactive(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    trashedAfter: string;
    limit: number;
  }): readonly ProductMemoryRecord[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000)
      this.fail("PORT_INVALID_OPERATION", "Memory listInactive limit is invalid");
    const rows = this.database
      .prepare(
        `${memorySelect} WHERE owner_id = ? AND agent_id = ?
          AND (status = 'archived' OR (status = 'trashed' AND updated_at > ?))
        ORDER BY updated_at DESC, id LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.trashedAfter, input.limit) as MemoryRow[];
    return rows.map((row) => this.memoryFromRow(row));
  }

  private listActive(input: {
    ownerId: OwnerId;
    agentId: AgentId;
  }): readonly ProductMemoryRecord[] {
    const rows = this.database
      .prepare(
        `${memorySelect} WHERE owner_id = ? AND agent_id = ? AND status = 'active'
        ORDER BY id`,
      )
      .all(input.ownerId, input.agentId) as MemoryRow[];
    return rows.map((row) => this.memoryFromRow(row));
  }

  private markUsed(input: { memoryIds: readonly MemoryId[]; usedAt: string }): void {
    if (!validIsoTimestamp(input.usedAt)) {
      this.fail("PORT_INVALID_OPERATION", "Memory usage timestamp is invalid");
    }
    if (input.memoryIds.length === 0) return;
    this.assertDiskHeadroom();
    const statement = this.database.prepare(
      "UPDATE memory_records SET last_used_at = ?, use_count = use_count + 1 WHERE id = ? AND status = 'active'",
    );
    this.database
      .transaction(() => {
        for (const memoryId of new Set(input.memoryIds)) statement.run(input.usedAt, memoryId);
      })
      .immediate();
  }

  private upsertIndex(document: MemoryIndexDocument): void {
    this.assertDiskHeadroom();
    if (
      !Number.isSafeInteger(document.revision) ||
      document.revision < 1 ||
      !validIsoTimestamp(document.indexedAt) ||
      document.terms.length > MAXIMUM_INDEX_TERMS ||
      document.terms.some((term) => term.length === 0 || term.length > 64) ||
      (document.embedding !== null &&
        (!Number.isSafeInteger(document.embedding.dimensions) ||
          document.embedding.dimensions < 1 ||
          document.embedding.vector.length !== document.embedding.dimensions ||
          document.embedding.model.length === 0 ||
          !document.embedding.vector.every(Number.isFinite)))
    ) {
      this.fail("PORT_INVALID_OPERATION", `Memory index document ${document.memoryId} is invalid`);
    }
    this.database
      .transaction(() => {
        const memory = this.read(document.memoryId);
        if (
          !memory ||
          memory.ownerId !== document.ownerId ||
          memory.agentId !== document.agentId ||
          memory.status !== "active" ||
          memory.revision !== document.revision
        ) {
          this.fail("PORT_CONFLICT", `Memory index targets a stale Memory ${document.memoryId}`);
        }
        this.database
          .prepare("DELETE FROM memory_search_index WHERE memory_id = ?")
          .run(document.memoryId);
        const inserted = this.database
          .prepare(
            `INSERT INTO memory_search_index (
              memory_id, owner_id, agent_id, memory_revision, embedding_model,
              embedding_dimensions, embedding, indexed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            document.memoryId,
            document.ownerId,
            document.agentId,
            document.revision,
            document.embedding?.model ?? null,
            document.embedding?.dimensions ?? null,
            document.embedding ? vectorBlob(document.embedding) : null,
            document.indexedAt,
          );
        if (
          document.terms.length > 0 &&
          MODEL_VISIBLE_CLASSIFICATIONS.has(memory.dataClassification)
        )
          this.database
            .prepare("INSERT INTO memory_search_terms (rowid, terms) VALUES (?, ?)")
            .run(inserted.lastInsertRowid, document.terms.join(" "));
      })
      .immediate();
  }

  private deleteIndex(memoryId: MemoryId): void {
    this.database
      .transaction(() => {
        this.database.prepare("DELETE FROM memory_search_index WHERE memory_id = ?").run(memoryId);
        if (
          this.database
            .prepare("SELECT 1 FROM memory_search_index WHERE memory_id = ?")
            .get(memoryId)
        ) {
          this.fail("PORT_CONFLICT", `Memory index remains after delete ${memoryId}`);
        }
      })
      .immediate();
  }

  private clearIndexScope(input: { ownerId: OwnerId; agentId: AgentId }): void {
    this.database
      .prepare("DELETE FROM memory_search_index WHERE owner_id = ? AND agent_id = ?")
      .run(input.ownerId, input.agentId);
  }

  private indexCandidate(row: IndexCandidateRow): MemoryIndexCandidate {
    return Object.freeze({
      memoryId: row.memoryId as MemoryId,
      revision: row.revision,
      importancePermille: row.importancePermille,
      confidencePermille: row.confidencePermille,
      updatedAt: row.updatedAt,
      lastUsedAt: row.lastUsedAt,
      signal: row.signal,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      current: row.current === 1,
    });
  }

  private searchIndex(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    embedding: MemoryIndexEmbedding | null;
    terms: readonly string[];
    queryText: string;
    limit: number;
    minimumSimilarity: number;
    now: string;
    includeHistory?: boolean;
    includeTentative?: boolean;
    tentativeOnly?: boolean;
  }): MemoryIndexSearchResult {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 200 ||
      !validIsoTimestamp(input.now) ||
      !Number.isFinite(input.minimumSimilarity)
    ) {
      this.fail("PORT_INVALID_OPERATION", "Memory index search input is invalid");
    }
    const scope = {
      ownerId: input.ownerId,
      agentId: input.agentId,
      now: input.now,
      includeHistory: input.includeHistory === true ? 1 : 0,
      includeTentative: input.includeTentative === true || input.tentativeOnly === true ? 1 : 0,
      tentativeOnly: input.tentativeOnly === true ? 1 : 0,
    };
    let vector: MemoryIndexCandidate[] = [];
    let vectorEngine: MemoryIndexSearchResult["vectorEngine"] = "none";
    if (input.embedding) {
      const embedding = input.embedding;
      const vectorScope = {
        ...scope,
        model: embedding.model,
        dimensions: embedding.dimensions,
        limit: input.limit,
      };
      if (this.vectorEngine === "sqlite-vec") {
        vectorEngine = "sqlite-vec";
        vector = (
          this.database
            .prepare(
              `SELECT ${indexCandidateColumns},
                1 - vec_distance_cosine(i.embedding, @query) AS signal
              FROM memory_search_index i JOIN memory_records m ON m.id = i.memory_id
              WHERE ${indexScope} AND i.embedding_model = @model
                AND i.embedding_dimensions = @dimensions
              ORDER BY signal DESC, m.id LIMIT @limit`,
            )
            .all({ ...vectorScope, query: vectorBlob(embedding) }) as IndexCandidateRow[]
        ).map((row) => this.indexCandidate(row));
      } else {
        vectorEngine = "javascript";
        const rows = this.database
          .prepare(
            `SELECT ${indexCandidateColumns}, i.embedding AS embedding
            FROM memory_search_index i JOIN memory_records m ON m.id = i.memory_id
            WHERE ${indexScope} AND i.embedding_model = @model
              AND i.embedding_dimensions = @dimensions`,
          )
          .all(vectorScope) as (Omit<IndexCandidateRow, "signal"> & { embedding: Uint8Array })[];
        vector = rows
          .map(({ embedding: blob, ...row }) =>
            this.indexCandidate({
              ...row,
              signal: cosineSimilarity(blobVector(blob, embedding.dimensions), embedding.vector),
            }),
          )
          .sort(
            (left, right) =>
              right.signal - left.signal || left.memoryId.localeCompare(right.memoryId),
          )
          .slice(0, input.limit);
      }
      vector = vector.filter(({ signal }) => signal >= input.minimumSimilarity);
    }
    const match = ftsQuery(input.terms);
    const lexical = match
      ? (
          this.database
            .prepare(
              `SELECT ${indexCandidateColumns}, -bm25(memory_search_terms) AS signal
              FROM memory_search_terms
              JOIN memory_search_index i ON i.rowid = memory_search_terms.rowid
              JOIN memory_records m ON m.id = i.memory_id
              WHERE memory_search_terms MATCH @match AND ${indexScope}
              ORDER BY bm25(memory_search_terms), m.id LIMIT @limit`,
            )
            .all({ ...scope, match, limit: input.limit }) as IndexCandidateRow[]
        ).map((row) => this.indexCandidate(row))
      : [];
    const queryText = input.queryText.normalize("NFKC").toLowerCase();
    const entity =
      queryText.trim().length === 0
        ? []
        : (
            this.database
              .prepare(
                `SELECT ${indexCandidateColumns}, COUNT(*) AS signal
                FROM memory_entities e
                JOIN memory_records m ON m.id = e.memory_id
                JOIN memory_search_index i ON i.memory_id = m.id
                WHERE instr(@queryText, e.name) > 0 AND ${indexScope}
                GROUP BY m.id ORDER BY signal DESC, m.id LIMIT @limit`,
              )
              .all({ ...scope, queryText, limit: input.limit }) as IndexCandidateRow[]
          ).map((row) => this.indexCandidate(row));
    const similarities = input.embedding
      ? this.candidateSimilarities(
          input.embedding,
          vectorEngine,
          vector,
          [...lexical, ...entity].map(({ memoryId }) => memoryId),
        )
      : new Map<MemoryId, number>();
    const withSimilarity = (candidate: MemoryIndexCandidate) => {
      const similarity = similarities.get(candidate.memoryId);
      return similarity === undefined ? candidate : Object.freeze({ ...candidate, similarity });
    };
    return Object.freeze({
      vector: Object.freeze(vector.map(withSimilarity)),
      lexical: Object.freeze(lexical.map(withSimilarity)),
      entity: Object.freeze(entity.map(withSimilarity)),
      vectorEngine,
    });
  }

  private candidateSimilarities(
    embedding: MemoryIndexEmbedding,
    vectorEngine: MemoryIndexSearchResult["vectorEngine"],
    vector: readonly MemoryIndexCandidate[],
    others: readonly MemoryId[],
  ): Map<MemoryId, number> {
    const similarities = new Map<MemoryId, number>(
      vector.map(({ memoryId, signal }) => [memoryId, signal]),
    );
    const missing = [...new Set(others)].filter((memoryId) => !similarities.has(memoryId)).sort();
    if (missing.length === 0) return similarities;
    const scope = {
      ids: JSON.stringify(missing),
      model: embedding.model,
      dimensions: embedding.dimensions,
    };
    const where = `i.memory_id IN (SELECT value FROM json_each(@ids))
      AND i.embedding_model = @model AND i.embedding_dimensions = @dimensions
      AND i.embedding IS NOT NULL`;
    if (vectorEngine === "sqlite-vec") {
      const rows = this.database
        .prepare(
          `SELECT i.memory_id AS memoryId, 1 - vec_distance_cosine(i.embedding, @query) AS similarity
          FROM memory_search_index i WHERE ${where}`,
        )
        .all({ ...scope, query: vectorBlob(embedding) }) as {
        memoryId: string;
        similarity: number;
      }[];
      for (const row of rows)
        if (Number.isFinite(row.similarity))
          similarities.set(row.memoryId as MemoryId, row.similarity);
      return similarities;
    }
    const rows = this.database
      .prepare(
        `SELECT i.memory_id AS memoryId, i.embedding AS embedding FROM memory_search_index i WHERE ${where}`,
      )
      .all(scope) as { memoryId: string; embedding: Uint8Array }[];
    for (const row of rows) {
      const similarity = cosineSimilarity(
        blobVector(row.embedding, embedding.dimensions),
        embedding.vector,
      );
      if (Number.isFinite(similarity)) similarities.set(row.memoryId as MemoryId, similarity);
    }
    return similarities;
  }

  private upsertEpisode(document: MemoryEpisodeDocument): void {
    this.assertDiskHeadroom();
    if (
      document.id.length === 0 ||
      !DAY.test(document.day) ||
      !["day_summary", "compaction"].includes(document.source) ||
      !CLASSIFICATIONS.has(document.dataClassification) ||
      !Number.isSafeInteger(document.firstSequence) ||
      !Number.isSafeInteger(document.lastSequence) ||
      document.firstSequence < 1 ||
      document.lastSequence < document.firstSequence ||
      !validIsoTimestamp(document.startedAt) ||
      !validIsoTimestamp(document.endedAt) ||
      !validIsoTimestamp(document.createdAt) ||
      document.terms.length > MAXIMUM_INDEX_TERMS ||
      document.terms.some((term) => term.length === 0 || term.length > 64) ||
      (document.embedding !== null &&
        (document.embedding.vector.length !== document.embedding.dimensions ||
          document.embedding.model.length === 0 ||
          !document.embedding.vector.every(Number.isFinite)))
    ) {
      this.fail("PORT_INVALID_OPERATION", `Memory episode ${document.id} is invalid`);
    }
    this.database
      .transaction(() => {
        const payload = this.database
          .prepare(
            `SELECT classification FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?
            AND lifecycle_state = 'active'`,
          )
          .get(document.contentRef, document.ownerId, document.agentId) as
          | { readonly classification: string }
          | undefined;
        if (!payload || payload.classification !== document.dataClassification)
          this.fail("PORT_NOT_FOUND", `Memory episode Payload ${document.contentRef} not found`);
        const thread = this.database
          .prepare("SELECT 1 FROM threads WHERE id = ? AND owner_id = ? AND agent_id = ?")
          .get(document.threadId, document.ownerId, document.agentId);
        if (!thread) this.fail("PORT_NOT_FOUND", "Memory episode Thread not found");
        this.database.prepare("DELETE FROM memory_episodes WHERE id = ?").run(document.id);
        const inserted = this.database
          .prepare(
            `INSERT INTO memory_episodes (
              id, owner_id, agent_id, thread_id, day, source, content_ref, classification,
              first_sequence, last_sequence, started_at, ended_at, created_at,
              embedding_model, embedding_dimensions, embedding
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            document.id,
            document.ownerId,
            document.agentId,
            document.threadId,
            document.day,
            document.source,
            document.contentRef,
            document.dataClassification,
            document.firstSequence,
            document.lastSequence,
            document.startedAt,
            document.endedAt,
            document.createdAt,
            document.embedding?.model ?? null,
            document.embedding?.dimensions ?? null,
            document.embedding ? vectorBlob(document.embedding) : null,
          );
        if (
          document.terms.length > 0 &&
          MODEL_VISIBLE_CLASSIFICATIONS.has(document.dataClassification)
        )
          this.database
            .prepare("INSERT INTO memory_episode_terms (rowid, terms) VALUES (?, ?)")
            .run(inserted.lastInsertRowid, document.terms.join(" "));
      })
      .immediate();
  }

  private episodeFromRow(row: EpisodeRow): MemoryEpisode {
    return Object.freeze({
      id: row.id,
      ownerId: row.ownerId as OwnerId,
      agentId: row.agentId as AgentId,
      threadId: row.threadId as ThreadId,
      day: row.day,
      source: row.source,
      contentRef: row.contentRef,
      dataClassification: row.classification,
      firstSequence: row.firstSequence,
      lastSequence: row.lastSequence,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      createdAt: row.createdAt,
    });
  }

  private searchEpisodes(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    embedding: MemoryIndexEmbedding | null;
    terms: readonly string[];
    allowedClassifications: readonly string[];
    from: string | null;
    to: string | null;
    limit: number;
  }): MemoryEpisodeSearchResult {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 200 ||
      !Array.isArray(input.allowedClassifications) ||
      input.allowedClassifications.some((value) => !CLASSIFICATIONS.has(value)) ||
      (input.from !== null && !validIsoTimestamp(input.from)) ||
      (input.to !== null && !validIsoTimestamp(input.to))
    ) {
      this.fail("PORT_INVALID_OPERATION", "Memory episode search input is invalid");
    }
    const scope = {
      ownerId: input.ownerId,
      agentId: input.agentId,
      classifications: JSON.stringify(input.allowedClassifications),
      from: input.from,
      to: input.to,
      limit: input.limit,
    };
    const candidate = (row: EpisodeRow & { signal: number }): MemoryEpisodeCandidate =>
      Object.freeze({ episode: this.episodeFromRow(row), signal: row.signal });
    let vector: MemoryEpisodeCandidate[] = [];
    if (input.embedding) {
      const embedding = input.embedding;
      const vectorScope = { ...scope, model: embedding.model, dimensions: embedding.dimensions };
      if (this.vectorEngine === "sqlite-vec") {
        vector = (
          this.database
            .prepare(
              `SELECT ${episodeColumns}, 1 - vec_distance_cosine(e.embedding, @query) AS signal
              FROM memory_episodes e
              WHERE ${episodeScope} AND e.embedding_model = @model
                AND e.embedding_dimensions = @dimensions
              ORDER BY signal DESC, e.id LIMIT @limit`,
            )
            .all({ ...vectorScope, query: vectorBlob(embedding) }) as (EpisodeRow & {
            signal: number;
          })[]
        ).map(candidate);
      } else {
        const query = embedding.vector;
        const queryNorm = Math.sqrt(query.reduce((sum, value) => sum + value * value, 0));
        const rows = this.database
          .prepare(
            `SELECT ${episodeColumns}, e.embedding AS embedding FROM memory_episodes e
            WHERE ${episodeScope} AND e.embedding_model = @model
              AND e.embedding_dimensions = @dimensions`,
          )
          .all(vectorScope) as (EpisodeRow & { embedding: Uint8Array })[];
        vector = rows
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
              right.signal - left.signal || left.episode.id.localeCompare(right.episode.id),
          )
          .slice(0, input.limit);
      }
    }
    const match = ftsQuery(input.terms);
    const lexical = match
      ? (
          this.database
            .prepare(
              `SELECT ${episodeColumns}, -bm25(memory_episode_terms) AS signal
              FROM memory_episode_terms
              JOIN memory_episodes e ON e.rowid = memory_episode_terms.rowid
              WHERE memory_episode_terms MATCH @match AND ${episodeScope}
              ORDER BY bm25(memory_episode_terms), e.id LIMIT @limit`,
            )
            .all({ ...scope, match }) as (EpisodeRow & { signal: number })[]
        ).map(candidate)
      : [];
    return Object.freeze({ vector: Object.freeze(vector), lexical: Object.freeze(lexical) });
  }

  private listUnembedded(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    model: string;
    dimensions: number;
    after?: { createdAt: string; id: string };
    limit: number;
  }): readonly MemoryEpisode[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      this.fail("PORT_INVALID_OPERATION", "Memory episode listing limit must be between 1 and 100");
    }
    if (
      input.after !== undefined &&
      (typeof input.after?.createdAt !== "string" || typeof input.after?.id !== "string")
    ) {
      this.fail(
        "PORT_INVALID_OPERATION",
        "Memory episode listing position must name a time and an id",
      );
    }
    return (
      this.database
        .prepare(
          `SELECT ${episodeColumns} FROM memory_episodes e
          JOIN memory_episode_terms t ON t.rowid = e.rowid
          WHERE e.owner_id = @ownerId AND e.agent_id = @agentId
            AND (e.embedding_model IS NULL OR e.embedding_model != @model
              OR e.embedding_dimensions != @dimensions)
            AND (@afterCreatedAt IS NULL OR (e.created_at, e.id) > (@afterCreatedAt, @afterId))
          ORDER BY e.created_at, e.id LIMIT @limit`,
        )
        .all({
          ownerId: input.ownerId,
          agentId: input.agentId,
          model: input.model,
          dimensions: input.dimensions,
          afterCreatedAt: input.after?.createdAt ?? null,
          afterId: input.after?.id ?? null,
          limit: input.limit,
        }) as EpisodeRow[]
    ).map((row) => this.episodeFromRow(row));
  }

  private listDaySummaries(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    fromDay: string;
    toDay: string;
    allowedClassifications: readonly string[];
    limit: number;
  }): readonly MemoryEpisode[] {
    if (
      typeof input.fromDay !== "string" ||
      typeof input.toDay !== "string" ||
      !DAY.test(input.fromDay) ||
      !DAY.test(input.toDay) ||
      input.fromDay > input.toDay ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      !Array.isArray(input.allowedClassifications) ||
      input.allowedClassifications.some((value) => !CLASSIFICATIONS.has(value))
    ) {
      this.fail("PORT_INVALID_OPERATION", "Memory day summary listing input is invalid");
    }
    return (
      this.database
        .prepare(
          `SELECT ${episodeColumns} FROM memory_episodes e
          WHERE e.owner_id = @ownerId AND e.agent_id = @agentId
            AND e.day BETWEEN @fromDay AND @toDay AND e.source = 'day_summary'
            AND e.classification IN (SELECT value FROM json_each(@classifications))
          ORDER BY e.day DESC, e.ended_at DESC, e.id ASC LIMIT @limit`,
        )
        .all({
          ownerId: input.ownerId,
          agentId: input.agentId,
          fromDay: input.fromDay,
          toDay: input.toDay,
          classifications: JSON.stringify(input.allowedClassifications),
          limit: input.limit,
        }) as EpisodeRow[]
    ).map((row) => this.episodeFromRow(row));
  }

  private listDaySummariesAfter(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    after: { createdAt: string; episodeId: string } | null;
    limit: number;
  }): readonly MemoryEpisode[] {
    const after = input.after;
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (after !== null &&
        (typeof after !== "object" ||
          typeof after.createdAt !== "string" ||
          typeof after.episodeId !== "string" ||
          Number.isNaN(Date.parse(after.createdAt))))
    ) {
      this.fail("PORT_INVALID_OPERATION", "Memory day summary position is invalid");
    }
    return (
      this.database
        .prepare(
          `SELECT ${episodeColumns} FROM memory_episodes e
          WHERE e.owner_id = @ownerId AND e.agent_id = @agentId AND e.source = 'day_summary'
            AND (@afterCreatedAt IS NULL OR e.created_at > @afterCreatedAt
              OR (e.created_at = @afterCreatedAt AND e.id > @afterId))
          ORDER BY e.created_at ASC, e.id ASC LIMIT @limit`,
        )
        .all({
          ownerId: input.ownerId,
          agentId: input.agentId,
          afterCreatedAt: after?.createdAt ?? null,
          afterId: after?.episodeId ?? null,
          limit: input.limit,
        }) as EpisodeRow[]
    ).map((row) => this.episodeFromRow(row));
  }

  private attachEpisodeEmbedding(input: {
    episodeId: string;
    embedding: MemoryIndexEmbedding;
  }): void {
    this.assertDiskHeadroom();
    if (
      input.embedding.vector.length !== input.embedding.dimensions ||
      input.embedding.model.length === 0 ||
      !input.embedding.vector.every(Number.isFinite)
    )
      this.fail("PORT_INVALID_OPERATION", "Memory episode embedding is invalid");
    this.database
      .prepare(
        `UPDATE memory_episodes SET embedding_model = ?, embedding_dimensions = ?, embedding = ?
        WHERE id = ?`,
      )
      .run(
        input.embedding.model,
        input.embedding.dimensions,
        vectorBlob(input.embedding),
        input.episodeId,
      );
  }

  private listUnsummarized(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    activeSince?: string;
    limit: number;
  }): readonly MemoryEpisodeThreadWatermark[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      this.fail("PORT_INVALID_OPERATION", "Memory episode listing limit must be between 1 and 100");
    }
    if (
      input.activeSince !== undefined &&
      (typeof input.activeSince !== "string" ||
        !Number.isFinite(Date.parse(input.activeSince)) ||
        new Date(Date.parse(input.activeSince)).toISOString() !== input.activeSince)
    ) {
      this.fail("PORT_INVALID_OPERATION", "Memory episode listing activeSince is invalid");
    }
    return this.database
      .prepare(
        `SELECT t.id AS threadId,
          COALESCE((SELECT max(e.last_sequence) FROM memory_episodes e
            WHERE e.thread_id = t.id AND e.source = 'day_summary'), 0) AS summarizedThrough,
          m.last_sequence AS lastSequence, m.last_committed_at AS lastCommittedAt
        FROM threads t
        JOIN (SELECT thread_id, max(sequence) AS last_sequence,
            max(committed_at) AS last_committed_at
          FROM thread_messages WHERE owner_id = @ownerId AND agent_id = @agentId
          GROUP BY thread_id) m ON m.thread_id = t.id
        WHERE t.owner_id = @ownerId AND t.agent_id = @agentId AND t.status = 'open'
          AND m.last_sequence > summarizedThrough
          AND (@activeSince IS NULL OR m.last_committed_at >= @activeSince)
        ORDER BY m.last_committed_at, t.id LIMIT @limit`,
      )
      .all({
        ownerId: input.ownerId,
        agentId: input.agentId,
        activeSince: input.activeSince ?? null,
        limit: input.limit,
      }) as MemoryEpisodeThreadWatermark[];
  }

  private listUnindexed(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    model: string;
    dimensions: number;
    embeddableClassifications: readonly string[];
    afterMemoryId: MemoryId | null;
    limit: number;
  }): readonly MemoryId[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
      this.fail("PORT_INVALID_OPERATION", "Memory index listing limit must be between 1 and 1000");
    }
    if (
      !Array.isArray(input.embeddableClassifications) ||
      input.embeddableClassifications.some((value) => !CLASSIFICATIONS.has(value))
    ) {
      this.fail("PORT_INVALID_OPERATION", "Memory index classifications are invalid");
    }
    const { embeddableClassifications, ...query } = input;
    return this.database
      .prepare(
        `SELECT m.id FROM memory_records m
        LEFT JOIN memory_search_index i ON i.memory_id = m.id
        WHERE m.owner_id = @ownerId AND m.agent_id = @agentId AND m.status = 'active'
          AND (@afterMemoryId IS NULL OR m.id > @afterMemoryId)
          AND (i.memory_id IS NULL OR i.memory_revision != m.revision
            OR (m.classification IN (SELECT value FROM json_each(@embeddable))
              AND (i.embedding_model IS NULL OR i.embedding_model != @model
                OR i.embedding_dimensions != @dimensions)))
        ORDER BY m.id LIMIT @limit`,
      )
      .pluck()
      .all({ ...query, embeddable: JSON.stringify(embeddableClassifications) }) as MemoryId[];
  }

  private readJob(jobId: string): MemoryProjectionJob | undefined {
    const row = this.database.prepare(`${projectionJobSelect} WHERE id = ?`).get(jobId) as
      | ProjectionJobRow
      | undefined;
    return row ? this.jobFromRow(row) : undefined;
  }

  private proposeJob(input: {
    job: MemoryProjectionJob;
    requeueCompleted: boolean;
  }): MemoryProjectionJob {
    this.assertDiskHeadroom();
    if (
      input.job.status !== "pending" ||
      input.job.attemptCount !== 0 ||
      input.job.claimedBy !== null ||
      input.job.claimExpiresAt !== null
    ) {
      this.fail("PORT_INVALID_OPERATION", "A new Memory projection job must start pending");
    }
    const transaction = this.database.transaction(() => {
      const memory = this.read(input.job.memoryId);
      if (!memory || memory.revision !== input.job.memoryRevision) {
        this.fail("PORT_CONFLICT", "Memory projection job targets a stale product revision");
      }
      const generation = this.database
        .prepare(
          "SELECT owner_id AS ownerId, agent_id AS agentId FROM memory_generations WHERE id = ?",
        )
        .get(input.job.generationId) as
        | { readonly ownerId: string; readonly agentId: string }
        | undefined;
      if (
        !generation ||
        generation.ownerId !== memory.ownerId ||
        generation.agentId !== memory.agentId
      ) {
        this.fail("PORT_INVALID_OPERATION", "Memory projection generation is outside scope");
      }
      const duplicate = this.database
        .prepare(
          `${projectionJobSelect} WHERE memory_id = ? AND memory_revision = ? AND operation = ?`,
        )
        .get(input.job.memoryId, input.job.memoryRevision, input.job.operation) as
        | ProjectionJobRow
        | undefined;
      if (duplicate) {
        if (
          input.requeueCompleted &&
          (duplicate.status === "completed" || duplicate.status === "failed_terminal")
        ) {
          this.database
            .prepare(
              `UPDATE memory_projection_jobs SET status = 'pending', attempt_count = 0,
                next_retry_at = NULL, provider_record_id = ?, error_code = NULL,
                claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL WHERE id = ?`,
            )
            .run(memory.providerRecordId, duplicate.id);
          return this.readJob(duplicate.id) as MemoryProjectionJob;
        }
        return this.jobFromRow(duplicate);
      }
      this.database
        .prepare(
          `INSERT INTO memory_projection_jobs (
            id, memory_id, memory_revision, generation_id, operation, status, attempt_count,
            next_retry_at, provider_record_id, error_code, claimed_by, claimed_at, claim_expires_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, NULL, NULL, NULL, NULL)`,
        )
        .run(
          input.job.id,
          input.job.memoryId,
          input.job.memoryRevision,
          input.job.generationId,
          input.job.operation,
          input.job.providerRecordId,
        );
      return this.readJob(input.job.id) as MemoryProjectionJob;
    });
    return transaction.immediate();
  }

  private listPendingJobs(input: { now: string; limit: number }): readonly MemoryProjectionJob[] {
    if (
      !validIsoTimestamp(input.now) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 0 ||
      input.limit > 1000
    ) {
      this.fail("PORT_INVALID_OPERATION", "Memory projection pending query is invalid");
    }
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE memory_projection_jobs SET status = 'retry_wait', next_retry_at = ?,
            error_code = 'MEMORY_PROJECTION_LEASE_EXPIRED', claimed_by = NULL,
            claimed_at = NULL, claim_expires_at = NULL
          WHERE status = 'claimed' AND claim_expires_at <= ?`,
        )
        .run(input.now, input.now);
      const rows = this.database
        .prepare(
          `${projectionJobSelect} WHERE status = 'pending'
            OR (status = 'retry_wait' AND next_retry_at <= ?)
          ORDER BY memory_id, memory_revision, operation LIMIT ?`,
        )
        .all(input.now, input.limit) as ProjectionJobRow[];
      return rows.map((row) => this.jobFromRow(row));
    });
    return transaction.immediate();
  }

  private claimJob(input: {
    jobId: string;
    claimedBy: string;
    claimedAt: string;
    expiresAt: string;
  }): MemoryProjectionJob | undefined {
    if (
      input.claimedBy.length === 0 ||
      !validIsoTimestamp(input.claimedAt) ||
      !validIsoTimestamp(input.expiresAt) ||
      input.expiresAt <= input.claimedAt
    ) {
      this.fail("PORT_INVALID_OPERATION", "Memory projection claim is invalid");
    }
    this.assertDiskHeadroom();
    return this.database
      .transaction(() => {
        const current = this.readJob(input.jobId);
        if (
          !current ||
          (current.status !== "pending" &&
            !(
              current.status === "retry_wait" &&
              current.nextRetryAt !== null &&
              current.nextRetryAt <= input.claimedAt
            ))
        ) {
          return undefined;
        }
        this.database
          .prepare(
            `UPDATE memory_projection_jobs SET status = 'claimed', attempt_count = attempt_count + 1,
            claimed_by = ?, claimed_at = ?, claim_expires_at = ?, error_code = NULL WHERE id = ?`,
          )
          .run(input.claimedBy, input.claimedAt, input.expiresAt, input.jobId);
        return this.readJob(input.jobId);
      })
      .immediate();
  }

  private completeJob(input: {
    jobId: string;
    claimedBy: string;
    providerRecordId: string | null;
  }): MemoryProjectionJob {
    this.assertDiskHeadroom();
    return this.database
      .transaction(() => {
        const current = this.readJob(input.jobId);
        if (!current) this.fail("PORT_NOT_FOUND", `Memory projection job ${input.jobId} not found`);
        if (current.status !== "claimed" || current.claimedBy !== input.claimedBy) {
          this.fail("PORT_CONFLICT", `Memory projection job ${input.jobId} claim is stale`);
        }
        const memory = this.read(current.memoryId);
        if (!memory) this.fail("PORT_NOT_FOUND", `Memory ${current.memoryId} not found`);
        if (
          current.operation === "upsert" &&
          input.providerRecordId === null &&
          memory.status === "active" &&
          memory.revision === current.memoryRevision
        ) {
          this.fail(
            "PORT_INVALID_OPERATION",
            "Completed upsert requires a provider record identity",
          );
        }
        if (
          current.operation === "upsert" &&
          memory.status === "active" &&
          memory.revision === current.memoryRevision
        ) {
          this.database
            .prepare("UPDATE memory_records SET provider_record_id = ? WHERE id = ?")
            .run(input.providerRecordId, memory.id);
        }
        if (
          current.operation === "delete" &&
          memory.revision === current.memoryRevision &&
          memory.providerRecordId === current.providerRecordId
        ) {
          this.database
            .prepare(
              `UPDATE memory_records SET provider_record_id = NULL,
              status = CASE WHEN status = 'deletion_pending' THEN 'deleted_verified' ELSE status END
            WHERE id = ?`,
            )
            .run(memory.id);
        }
        this.database
          .prepare(
            `UPDATE memory_projection_jobs SET status = 'completed', next_retry_at = NULL,
            provider_record_id = ?, error_code = NULL, claimed_by = NULL,
            claimed_at = NULL, claim_expires_at = NULL WHERE id = ?`,
          )
          .run(input.providerRecordId ?? current.providerRecordId, current.id);
        return this.readJob(current.id) as MemoryProjectionJob;
      })
      .immediate();
  }

  private retryJob(input: {
    jobId: string;
    claimedBy: string;
    errorCode: string;
    nextRetryAt: string | null;
  }): MemoryProjectionJob {
    if (
      input.errorCode.length === 0 ||
      (input.nextRetryAt !== null && !validIsoTimestamp(input.nextRetryAt))
    ) {
      this.fail("PORT_INVALID_OPERATION", "Memory projection retry is invalid");
    }
    this.assertDiskHeadroom();
    const current = this.readJob(input.jobId);
    if (!current) this.fail("PORT_NOT_FOUND", `Memory projection job ${input.jobId} not found`);
    if (current.status !== "claimed" || current.claimedBy !== input.claimedBy) {
      this.fail("PORT_CONFLICT", `Memory projection job ${input.jobId} claim is stale`);
    }
    this.database
      .prepare(
        `UPDATE memory_projection_jobs SET status = ?, next_retry_at = ?, error_code = ?,
          claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL WHERE id = ?`,
      )
      .run(
        input.nextRetryAt === null ? "failed_terminal" : "retry_wait",
        input.nextRetryAt,
        input.errorCode,
        input.jobId,
      );
    return this.readJob(input.jobId) as MemoryProjectionJob;
  }

  private listJobsByMemory(memoryId: MemoryId): readonly MemoryProjectionJob[] {
    const rows = this.database
      .prepare(`${projectionJobSelect} WHERE memory_id = ? ORDER BY memory_revision, operation`)
      .all(memoryId) as ProjectionJobRow[];
    return rows.map((row) => this.jobFromRow(row));
  }

  private approvalFromRow(row: MemoryApprovalRow): SensitiveMemoryApprovalRequest {
    return Object.freeze({
      id: row.id,
      ownerId: row.ownerId as OwnerId,
      agentId: row.agentId as AgentId,
      runId: row.runId as SensitiveMemoryApprovalRequest["runId"],
      threadId: row.threadId as ThreadId,
      generationId: row.generationId as MemoryGenerationId,
      sourceRef: row.sourceRef,
      sourceClassification: row.sourceClassification,
      candidateOrdinal: row.candidateOrdinal,
      productMemoryId: row.productMemoryId as MemoryId,
      decision: row.decision,
      existingMemoryId: row.existingMemoryId as MemoryId | null,
      dataClassification: row.classification,
      policyVersion: row.policyVersion,
      modelDescriptorRef: row.modelDescriptorRef,
      status: row.status,
      deliveryState: row.deliveryState,
      requestedAt: row.requestedAt,
      decidedAt: row.decidedAt,
      committedAt: row.committedAt,
    });
  }

  private readApproval(requestId: string): SensitiveMemoryApprovalRequest | undefined {
    const row = this.database.prepare(`${memoryApprovalSelect} WHERE id = ?`).get(requestId) as
      | MemoryApprovalRow
      | undefined;
    return row ? this.approvalFromRow(row) : undefined;
  }

  private createApproval(request: SensitiveMemoryApprovalRequest): SensitiveMemoryApprovalRequest {
    this.assertDiskHeadroom();
    if (
      request.status !== "pending" ||
      request.decidedAt !== null ||
      request.committedAt !== null ||
      !Number.isSafeInteger(request.candidateOrdinal) ||
      request.candidateOrdinal < 0 ||
      !validIsoTimestamp(request.requestedAt) ||
      request.policyVersion.length === 0 ||
      request.modelDescriptorRef.length === 0
    ) {
      this.fail("PORT_INVALID_OPERATION", "Sensitive Memory approval request is invalid");
    }
    const transaction = this.database.transaction(() => {
      const duplicate = this.database
        .prepare(
          `${memoryApprovalSelect} WHERE generation_id = ? AND source_ref = ?
          AND candidate_ordinal = ?`,
        )
        .get(request.generationId, request.sourceRef, request.candidateOrdinal) as
        | MemoryApprovalRow
        | undefined;
      if (duplicate) {
        const existing = this.approvalFromRow(duplicate);
        const same =
          existing.id === request.id &&
          existing.ownerId === request.ownerId &&
          existing.agentId === request.agentId &&
          existing.runId === request.runId &&
          existing.threadId === request.threadId &&
          existing.productMemoryId === request.productMemoryId &&
          existing.decision === request.decision &&
          existing.existingMemoryId === request.existingMemoryId &&
          existing.dataClassification === request.dataClassification &&
          existing.policyVersion === request.policyVersion &&
          existing.modelDescriptorRef === request.modelDescriptorRef;
        if (!same) {
          this.fail("PORT_CONFLICT", `Sensitive Memory approval ${request.id} conflicts`);
        }
        return existing;
      }
      this.database
        .prepare(
          `INSERT INTO memory_approval_requests (
            id, owner_id, agent_id, run_id, thread_id, generation_id, source_ref,
            source_classification, candidate_ordinal, product_memory_id, decision,
            existing_memory_id, classification, policy_version, model_descriptor_ref,
            status, delivery_state, requested_at, decided_at, committed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)`,
        )
        .run(
          request.id,
          request.ownerId,
          request.agentId,
          request.runId,
          request.threadId,
          request.generationId,
          request.sourceRef,
          request.sourceClassification,
          request.candidateOrdinal,
          request.productMemoryId,
          request.decision,
          request.existingMemoryId,
          request.dataClassification,
          request.policyVersion,
          request.modelDescriptorRef,
          request.deliveryState,
          request.requestedAt,
        );
      return this.readApproval(request.id) as SensitiveMemoryApprovalRequest;
    });
    return transaction.immediate();
  }

  private resolveApproval(input: {
    requestId: string;
    resolution: "approved" | "edited" | "rejected" | "expired";
    decidedAt: string;
  }): SensitiveMemoryApprovalRequest {
    this.assertDiskHeadroom();
    if (!validIsoTimestamp(input.decidedAt)) {
      this.fail("PORT_INVALID_OPERATION", "Sensitive Memory approval decision time is invalid");
    }
    const current = this.readApproval(input.requestId);
    if (!current) {
      this.fail("PORT_NOT_FOUND", `Sensitive Memory approval ${input.requestId} not found`);
    }
    if (current.status !== "pending") {
      if (current.status === input.resolution) return current;
      this.fail(
        "PORT_CONFLICT",
        `Sensitive Memory approval ${input.requestId} is ${current.status}`,
      );
    }
    this.database
      .prepare("UPDATE memory_approval_requests SET status = ?, decided_at = ? WHERE id = ?")
      .run(input.resolution, input.decidedAt, input.requestId);
    return this.readApproval(input.requestId) as SensitiveMemoryApprovalRequest;
  }

  private markApprovalCommitted(input: {
    requestId: string;
    committedAt: string;
  }): SensitiveMemoryApprovalRequest {
    this.assertDiskHeadroom();
    if (!validIsoTimestamp(input.committedAt)) {
      this.fail("PORT_INVALID_OPERATION", "Sensitive Memory commit time is invalid");
    }
    const current = this.readApproval(input.requestId);
    if (!current) {
      this.fail("PORT_NOT_FOUND", `Sensitive Memory approval ${input.requestId} not found`);
    }
    if (current.status === "committed") return current;
    if (current.status !== "approved" && current.status !== "edited") {
      this.fail(
        "PORT_INVALID_OPERATION",
        `Sensitive Memory approval ${input.requestId} cannot commit`,
      );
    }
    this.database
      .prepare(
        "UPDATE memory_approval_requests SET status = 'committed', committed_at = ? WHERE id = ?",
      )
      .run(input.committedAt, input.requestId);
    return this.readApproval(input.requestId) as SensitiveMemoryApprovalRequest;
  }

  private listPendingApprovals(input: {
    ownerId: OwnerId;
    threadId: ThreadId | null;
  }): readonly SensitiveMemoryApprovalRequest[] {
    const rows = (
      input.threadId === null
        ? this.database
            .prepare(
              `${memoryApprovalSelect} WHERE owner_id = ? AND status = 'pending'
              ORDER BY requested_at, candidate_ordinal`,
            )
            .all(input.ownerId)
        : this.database
            .prepare(
              `${memoryApprovalSelect} WHERE owner_id = ? AND thread_id = ? AND status = 'pending'
              ORDER BY requested_at, candidate_ordinal`,
            )
            .all(input.ownerId, input.threadId)
    ) as MemoryApprovalRow[];
    return rows.map((row) => this.approvalFromRow(row));
  }
}
