import type {
  MemoryProjectionJob,
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
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

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
  provider_record_id AS providerRecordId, last_used_at AS lastUsedAt, updated_at AS updatedAt
  FROM memory_records`;

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
      case "memory.listActive":
        return this.listActive(payload as { ownerId: OwnerId; agentId: AgentId });
      case "memory.markUsed":
        return this.markUsed(payload as { memoryIds: readonly MemoryId[]; usedAt: string });
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
        return this.listPendingApprovals(payload as { ownerId: OwnerId; threadId: ThreadId });
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
    });
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
  }

  private validTransition(
    current: ProductMemoryRecord["status"],
    next: ProductMemoryRecord["status"],
  ): boolean {
    if (current === next) return current === "active" || current === "archived";
    if (current === "active") {
      return ["archived", "trashed", "deletion_pending"].includes(next);
    }
    if (current === "archived" || current === "trashed") return next === "deletion_pending";
    return current === "deletion_pending" && next === "deleted_verified";
  }

  private save(input: {
    memory: ProductMemoryRecord;
    expectedRevision: number | null;
  }): ProductMemoryRecord {
    this.assertDiskHeadroom();
    this.assertMemoryShape(input.memory);
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
              provider_record_id, last_used_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              policy_version = ?, provider_record_id = ?, last_used_at = ?, updated_at = ?
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
            input.memory.id,
          );
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
      "UPDATE memory_records SET last_used_at = ? WHERE id = ? AND status = 'active'",
    );
    this.database
      .transaction(() => {
        for (const memoryId of new Set(input.memoryIds)) statement.run(input.usedAt, memoryId);
      })
      .immediate();
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
        if (input.requeueCompleted && duplicate.status === "completed") {
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
    threadId: ThreadId;
  }): readonly SensitiveMemoryApprovalRequest[] {
    const rows = this.database
      .prepare(
        `${memoryApprovalSelect} WHERE owner_id = ? AND thread_id = ? AND status = 'pending'
        ORDER BY requested_at, candidate_ordinal`,
      )
      .all(input.ownerId, input.threadId) as MemoryApprovalRow[];
    return rows.map((row) => this.approvalFromRow(row));
  }
}
