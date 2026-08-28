import type {
  ThreadDerivativeCandidateRecord,
  ThreadDistillationOutput,
  ThreadDistillationWork,
  ThreadSummaryRecord,
} from "@himawari-agent/application";
import type {
  AgentId,
  CheckpointJobId,
  MemoryGenerationId,
  OwnerId,
  ThreadId,
} from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

interface WorkRow {
  readonly jobId: string;
  readonly generationId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly sourceWatermark: number;
  readonly policyVersion: string;
  readonly modelDescriptorRef: string;
  readonly trigger: ThreadDistillationWork["trigger"];
  readonly summaryRef: string | null;
  readonly summaryClassification: ThreadDistillationWork["summaryClassification"];
  readonly status: ThreadDistillationWork["status"];
  readonly revision: number;
  readonly attemptCount: number;
  readonly nextRetryAt: string | null;
  readonly claimedBy: string | null;
  readonly claimExpiresAt: string | null;
  readonly requestedAt: string;
  readonly errorCode: string | null;
}

interface SourceRow {
  readonly ref: string;
  readonly sequence: number;
  readonly kind: ThreadDistillationWork["sources"][number]["kind"];
  readonly classification: ThreadDistillationWork["sources"][number]["dataClassification"];
}

interface SummaryRow {
  readonly id: string;
  readonly generationId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly contentRef: string;
  readonly classification: ThreadSummaryRecord["dataClassification"];
  readonly sourceStartSequence: number;
  readonly sourceEndSequence: number;
  readonly sourceWatermark: number;
  readonly policyVersion: string;
  readonly modelDescriptorRef: string;
  readonly createdAt: string;
}

interface CandidateRow {
  readonly id: string;
  readonly generationId: string;
  readonly ordinal: number;
  readonly kind: ThreadDerivativeCandidateRecord["kind"];
  readonly contentRef: string | null;
  readonly classification: ThreadDerivativeCandidateRecord["dataClassification"];
  readonly status: ThreadDerivativeCandidateRecord["status"];
  readonly policyVersion: string;
  readonly modelDescriptorRef: string;
  readonly createdAt: string;
}

const workSelect = `SELECT checkpoint.id AS jobId, checkpoint.generation_id AS generationId,
  checkpoint.owner_id AS ownerId, checkpoint.agent_id AS agentId,
  checkpoint.thread_id AS threadId, checkpoint.source_watermark AS sourceWatermark,
  checkpoint.policy_version AS policyVersion,
  generation.model_descriptor_ref AS modelDescriptorRef,
  checkpoint.trigger_kind AS trigger, checkpoint.summary_ref AS summaryRef,
  summary_payload.classification AS summaryClassification,
  checkpoint.status, checkpoint.revision,
  checkpoint.attempt_count AS attemptCount, checkpoint.next_retry_at AS nextRetryAt,
  checkpoint.claimed_by AS claimedBy, checkpoint.claim_expires_at AS claimExpiresAt,
  checkpoint.requested_at AS requestedAt, checkpoint.error_code AS errorCode
  FROM thread_checkpoint_jobs checkpoint
  JOIN memory_generations generation ON generation.id = checkpoint.generation_id
  LEFT JOIN payloads summary_payload ON summary_payload.ref = checkpoint.summary_ref`;

const summarySelect = `SELECT id, generation_id AS generationId, owner_id AS ownerId,
  agent_id AS agentId, thread_id AS threadId, content_ref AS contentRef,
  classification, source_start_sequence AS sourceStartSequence,
  source_end_sequence AS sourceEndSequence, source_watermark AS sourceWatermark,
  policy_version AS policyVersion, model_descriptor_ref AS modelDescriptorRef,
  created_at AS createdAt FROM thread_summaries`;

const candidateSelect = `SELECT id, generation_id AS generationId, ordinal, kind,
  content_ref AS contentRef, classification, status, policy_version AS policyVersion,
  model_descriptor_ref AS modelDescriptorRef, created_at AS createdAt
  FROM thread_derivative_candidates`;

function validIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function sameSources(
  left: ThreadDistillationWork["sources"],
  right: ThreadDistillationWork["sources"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class SqliteCheckpointOperations {
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
      case "threadDistillation.request":
        return this.request((payload as { work: ThreadDistillationWork }).work);
      case "threadDistillation.read":
        return this.read((payload as { jobId: CheckpointJobId }).jobId);
      case "threadDistillation.findByIdentity":
        return this.findByIdentity(payload as Parameters<typeof this.findByIdentity>[0]);
      case "threadDistillation.listReady":
        return this.listReady(payload as { now: string; limit: number });
      case "threadDistillation.claim":
        return this.claim(payload as Parameters<typeof this.claim>[0]);
      case "threadDistillation.commit":
        return this.commit(payload as Parameters<typeof this.commit>[0]);
      case "threadDistillation.retry":
        return this.retry(payload as Parameters<typeof this.retry>[0]);
      case "threadDistillation.readOutput":
        return this.readOutput((payload as { generationId: MemoryGenerationId }).generationId);
      case "threadDistillation.latestSummary":
        return this.latestSummary((payload as { threadId: ThreadId }).threadId);
      case "threadDistillation.latestCheckpoint":
        return this.latestCheckpoint(payload as Parameters<typeof this.latestCheckpoint>[0]);
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown Thread distillation operation ${operation}`,
        );
    }
  }

  private sources(jobId: CheckpointJobId): ThreadDistillationWork["sources"] {
    const rows = this.database
      .prepare(
        `SELECT source_ref AS ref, source_sequence AS sequence, source_kind AS kind,
          classification FROM thread_checkpoint_sources
          WHERE checkpoint_job_id = ? ORDER BY source_sequence, source_kind, source_ref`,
      )
      .all(jobId) as SourceRow[];
    return rows.map((row) => ({
      ref: row.ref,
      sequence: row.sequence,
      kind: row.kind,
      dataClassification: row.classification,
    }));
  }

  private workFromRow(row: WorkRow): ThreadDistillationWork {
    return Object.freeze({
      jobId: row.jobId as CheckpointJobId,
      generationId: row.generationId as MemoryGenerationId,
      ownerId: row.ownerId as OwnerId,
      agentId: row.agentId as AgentId,
      threadId: row.threadId as ThreadId,
      sourceWatermark: row.sourceWatermark,
      policyVersion: row.policyVersion,
      modelDescriptorRef: row.modelDescriptorRef,
      trigger: row.trigger,
      summaryRef: row.summaryRef,
      summaryClassification: row.summaryClassification,
      status: row.status,
      revision: row.revision,
      attemptCount: row.attemptCount,
      nextRetryAt: row.nextRetryAt,
      claimedBy: row.claimedBy,
      claimExpiresAt: row.claimExpiresAt,
      sources: this.sources(row.jobId as CheckpointJobId),
      requestedAt: row.requestedAt,
      errorCode: row.errorCode,
    });
  }

  private read(jobId: CheckpointJobId): ThreadDistillationWork | undefined {
    const row = this.database.prepare(`${workSelect} WHERE checkpoint.id = ?`).get(jobId) as
      | WorkRow
      | undefined;
    return row ? this.workFromRow(row) : undefined;
  }

  private findByIdentity(input: {
    readonly threadId: ThreadId;
    readonly sourceWatermark: number;
    readonly policyVersion: string;
  }): ThreadDistillationWork | undefined {
    const row = this.database
      .prepare(
        `${workSelect} WHERE checkpoint.thread_id = ? AND checkpoint.source_watermark = ?
          AND checkpoint.policy_version = ?`,
      )
      .get(input.threadId, input.sourceWatermark, input.policyVersion) as WorkRow | undefined;
    return row ? this.workFromRow(row) : undefined;
  }

  private latestCheckpoint(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly sourceWatermark: number | null;
  }): ThreadDistillationWork | undefined {
    const row = this.database
      .prepare(
        `${workSelect} WHERE checkpoint.owner_id = ? AND checkpoint.agent_id = ?
          AND checkpoint.thread_id = ?
          AND (? IS NULL OR checkpoint.source_watermark = ?)
          ORDER BY checkpoint.source_watermark DESC, checkpoint.requested_at DESC,
            checkpoint.id DESC LIMIT 1`,
      )
      .get(
        input.ownerId,
        input.agentId,
        input.threadId,
        input.sourceWatermark,
        input.sourceWatermark,
      ) as WorkRow | undefined;
    return row ? this.workFromRow(row) : undefined;
  }

  private request(work: ThreadDistillationWork): ThreadDistillationWork {
    const sourceSequences = work.sources.map(({ sequence }) => sequence);
    const uniqueRefs = new Set(work.sources.map(({ ref }) => ref));
    const uniqueCoordinates = new Set(
      work.sources.map(({ sequence, kind }) => `${sequence}:${kind}`),
    );
    if (
      work.status !== "pending" ||
      work.revision !== 1 ||
      work.attemptCount !== 0 ||
      work.nextRetryAt !== null ||
      work.claimedBy !== null ||
      work.claimExpiresAt !== null ||
      work.errorCode !== null ||
      (work.trigger === "pre_compaction") !==
        (work.summaryRef !== null && work.summaryClassification !== null) ||
      (work.trigger !== "pre_compaction" &&
        (work.summaryRef !== null || work.summaryClassification !== null)) ||
      work.policyVersion.trim().length === 0 ||
      work.modelDescriptorRef.trim().length === 0 ||
      !validIsoTimestamp(work.requestedAt) ||
      work.sources.length === 0 ||
      uniqueRefs.size !== work.sources.length ||
      uniqueCoordinates.size !== work.sources.length ||
      sourceSequences.some(
        (sequence, index) =>
          !Number.isSafeInteger(sequence) ||
          sequence < 1 ||
          sequence > work.sourceWatermark ||
          (index > 0 && sequence < (sourceSequences[index - 1] ?? 0)),
      )
    ) {
      this.fail("PORT_INVALID_OPERATION", "Thread distillation request is invalid");
    }
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const existing = this.findByIdentity({
        threadId: work.threadId,
        sourceWatermark: work.sourceWatermark,
        policyVersion: work.policyVersion,
      });
      if (existing) {
        if (
          existing.jobId !== work.jobId ||
          existing.generationId !== work.generationId ||
          existing.ownerId !== work.ownerId ||
          existing.agentId !== work.agentId ||
          existing.modelDescriptorRef !== work.modelDescriptorRef ||
          existing.summaryRef !== work.summaryRef ||
          existing.summaryClassification !== work.summaryClassification ||
          !sameSources(existing.sources, work.sources)
        ) {
          this.fail("PORT_CONFLICT", "Thread distillation identity conflicts with existing work");
        }
        return existing;
      }
      if (this.read(work.jobId)) {
        this.fail("PORT_CONFLICT", "Thread distillation stable identity collided");
      }
      const thread = this.database
        .prepare("SELECT owner_id AS ownerId, agent_id AS agentId FROM threads WHERE id = ?")
        .get(work.threadId) as { ownerId: string; agentId: string } | undefined;
      if (!thread) this.fail("PORT_NOT_FOUND", `Thread ${work.threadId} not found`);
      if (thread.ownerId !== work.ownerId || thread.agentId !== work.agentId) {
        this.fail("PORT_INVALID_OPERATION", "Thread distillation scope does not match Thread");
      }
      if (work.summaryRef !== null) {
        const summaryPayload = this.database
          .prepare(
            `SELECT classification FROM payloads
              WHERE ref = ? AND owner_id = ? AND agent_id = ?`,
          )
          .get(work.summaryRef, work.ownerId, work.agentId) as
          | { readonly classification: ThreadDistillationWork["summaryClassification"] }
          | undefined;
        if (!summaryPayload) {
          this.fail("PORT_NOT_FOUND", "Prepared Pi summary Payload is missing or outside scope");
        }
        if (summaryPayload.classification !== work.summaryClassification) {
          this.fail("PORT_INVALID_OPERATION", "Prepared Pi summary classification differs");
        }
      }
      this.database
        .prepare(
          `INSERT INTO thread_checkpoint_jobs (
            id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
            policy_version, status, attempt_count, summary_ref, requested_at, error_code,
            trigger_kind, next_retry_at, claimed_by, claimed_at, claim_expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, ?, NULL, NULL, NULL, NULL)`,
        )
        .run(
          work.jobId,
          work.generationId,
          work.ownerId,
          work.agentId,
          work.threadId,
          work.revision,
          work.sourceWatermark,
          work.policyVersion,
          work.summaryRef,
          work.requestedAt,
          work.trigger,
        );
      this.database
        .prepare(
          `INSERT INTO memory_generations (
            id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
            model_descriptor_ref, policy_version, output_ref
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
        )
        .run(
          work.generationId,
          work.jobId,
          work.ownerId,
          work.agentId,
          work.threadId,
          work.modelDescriptorRef,
          work.policyVersion,
        );
      const insertSource = this.database.prepare(
        `INSERT INTO thread_checkpoint_sources (
          checkpoint_job_id, source_ref, source_sequence, source_kind, classification
        ) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const source of work.sources) {
        insertSource.run(
          work.jobId,
          source.ref,
          source.sequence,
          source.kind,
          source.dataClassification,
        );
      }
      return this.read(work.jobId) as ThreadDistillationWork;
    });
    return transaction.immediate();
  }

  private listReady(input: {
    readonly now: string;
    readonly limit: number;
  }): readonly ThreadDistillationWork[] {
    if (
      !validIsoTimestamp(input.now) ||
      !Number.isInteger(input.limit) ||
      input.limit < 0 ||
      input.limit > 1000
    ) {
      this.fail("PORT_INVALID_OPERATION", "Thread distillation ready query is invalid");
    }
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE thread_checkpoint_jobs SET status = 'retry_wait', next_retry_at = ?,
            claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL,
            error_code = 'WORK_LEASE_EXPIRED', revision = revision + 1
          WHERE status = 'running' AND claim_expires_at <= ?`,
        )
        .run(input.now, input.now);
      this.database
        .prepare(
          `UPDATE memory_generations SET status = 'pending' WHERE checkpoint_job_id IN (
            SELECT id FROM thread_checkpoint_jobs
            WHERE status = 'retry_wait' AND error_code = 'WORK_LEASE_EXPIRED'
              AND next_retry_at = ?
          )`,
        )
        .run(input.now);
      const rows = this.database
        .prepare(
          `${workSelect} WHERE checkpoint.status = 'pending'
            OR (checkpoint.status = 'retry_wait' AND checkpoint.next_retry_at <= ?)
          ORDER BY checkpoint.requested_at, checkpoint.id LIMIT ?`,
        )
        .all(input.now, input.limit) as WorkRow[];
      return rows.map((row) => this.workFromRow(row));
    });
    return transaction.immediate();
  }

  private claim(input: {
    readonly jobId: CheckpointJobId;
    readonly workerId: string;
    readonly claimedAt: string;
    readonly expiresAt: string;
  }): ThreadDistillationWork | undefined {
    if (
      input.workerId.length === 0 ||
      !validIsoTimestamp(input.claimedAt) ||
      !validIsoTimestamp(input.expiresAt) ||
      input.expiresAt <= input.claimedAt
    ) {
      this.fail("PORT_INVALID_OPERATION", "Thread distillation claim is invalid");
    }
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const current = this.read(input.jobId);
      if (!current) return undefined;
      if (
        current.status !== "pending" &&
        !(
          current.status === "retry_wait" &&
          current.nextRetryAt !== null &&
          current.nextRetryAt <= input.claimedAt
        )
      ) {
        return undefined;
      }
      this.database
        .prepare(
          `UPDATE thread_checkpoint_jobs SET status = 'running', revision = revision + 1,
            attempt_count = attempt_count + 1, next_retry_at = NULL, claimed_by = ?,
            claimed_at = ?, claim_expires_at = ?, error_code = NULL WHERE id = ?`,
        )
        .run(input.workerId, input.claimedAt, input.expiresAt, input.jobId);
      this.database
        .prepare("UPDATE memory_generations SET status = 'running' WHERE checkpoint_job_id = ?")
        .run(input.jobId);
      return this.read(input.jobId);
    });
    return transaction.immediate();
  }

  private summaryFromRow(row: SummaryRow): ThreadSummaryRecord {
    return Object.freeze({
      id: row.id,
      generationId: row.generationId as MemoryGenerationId,
      ownerId: row.ownerId as OwnerId,
      agentId: row.agentId as AgentId,
      threadId: row.threadId as ThreadId,
      contentRef: row.contentRef,
      dataClassification: row.classification,
      sourceStartSequence: row.sourceStartSequence,
      sourceEndSequence: row.sourceEndSequence,
      sourceWatermark: row.sourceWatermark,
      policyVersion: row.policyVersion,
      modelDescriptorRef: row.modelDescriptorRef,
      createdAt: row.createdAt,
    });
  }

  private candidateFromRow(row: CandidateRow): ThreadDerivativeCandidateRecord {
    const sourceRefs = this.database
      .prepare(
        "SELECT source_ref FROM thread_derivative_provenance WHERE candidate_id = ? ORDER BY source_ref",
      )
      .pluck()
      .all(row.id) as string[];
    return Object.freeze({
      id: row.id,
      generationId: row.generationId as MemoryGenerationId,
      ordinal: row.ordinal,
      kind: row.kind,
      contentRef: row.contentRef,
      dataClassification: row.classification,
      status: row.status,
      sourceRefs,
      policyVersion: row.policyVersion,
      modelDescriptorRef: row.modelDescriptorRef,
      createdAt: row.createdAt,
    });
  }

  private readOutput(generationId: MemoryGenerationId): ThreadDistillationOutput | undefined {
    const generation = this.database
      .prepare("SELECT checkpoint_job_id AS jobId, status FROM memory_generations WHERE id = ?")
      .get(generationId) as { jobId: string; status: string } | undefined;
    if (!generation || generation.status !== "completed") return undefined;
    const work = this.read(generation.jobId as CheckpointJobId);
    const summaryRow = this.database
      .prepare(`${summarySelect} WHERE generation_id = ?`)
      .get(generationId) as SummaryRow | undefined;
    if (!work || work.status !== "completed" || !summaryRow) {
      this.fail("PORT_CONFLICT", "Completed Thread distillation output is incomplete");
    }
    const candidateRows = this.database
      .prepare(`${candidateSelect} WHERE generation_id = ? ORDER BY ordinal`)
      .all(generationId) as CandidateRow[];
    return Object.freeze({
      work,
      summary: this.summaryFromRow(summaryRow),
      candidates: candidateRows.map((row) => this.candidateFromRow(row)),
    });
  }

  private commit(input: {
    readonly jobId: CheckpointJobId;
    readonly workerId: string;
    readonly summary: ThreadSummaryRecord;
    readonly candidates: readonly ThreadDerivativeCandidateRecord[];
  }): ThreadDistillationOutput {
    const existing = this.readOutput(input.summary.generationId);
    if (existing) return existing;
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const replay = this.readOutput(input.summary.generationId);
      if (replay) return replay;
      const work = this.read(input.jobId);
      if (!work) this.fail("PORT_NOT_FOUND", `Thread checkpoint ${input.jobId} not found`);
      if (work.status !== "running" || work.claimedBy !== input.workerId) {
        this.fail("PORT_CONFLICT", `Thread checkpoint ${input.jobId} claim is stale`);
      }
      const sourceSequences = work.sources.map(({ sequence }) => sequence);
      const allowedSources = new Set(work.sources.map(({ ref }) => ref));
      const ordinals = new Set(input.candidates.map(({ ordinal }) => ordinal));
      if (
        input.summary.generationId !== work.generationId ||
        input.summary.ownerId !== work.ownerId ||
        input.summary.agentId !== work.agentId ||
        input.summary.threadId !== work.threadId ||
        input.summary.sourceStartSequence !== Math.min(...sourceSequences) ||
        input.summary.sourceEndSequence !== Math.max(...sourceSequences) ||
        input.summary.sourceWatermark !== work.sourceWatermark ||
        input.summary.policyVersion !== work.policyVersion ||
        input.summary.modelDescriptorRef !== work.modelDescriptorRef ||
        !validIsoTimestamp(input.summary.createdAt) ||
        ordinals.size !== input.candidates.length ||
        input.candidates.some(
          (candidate) =>
            candidate.generationId !== work.generationId ||
            candidate.policyVersion !== work.policyVersion ||
            candidate.modelDescriptorRef !== work.modelDescriptorRef ||
            !Number.isInteger(candidate.ordinal) ||
            candidate.ordinal < 0 ||
            !validIsoTimestamp(candidate.createdAt) ||
            candidate.sourceRefs.length === 0 ||
            candidate.sourceRefs.some((ref) => !allowedSources.has(ref)) ||
            (candidate.status === "candidate" && candidate.contentRef === null) ||
            (candidate.status === "awaiting_sensitive_approval" && candidate.contentRef !== null),
        )
      ) {
        this.fail("PORT_INVALID_OPERATION", "Thread distillation output is invalid");
      }
      const payloads = [
        input.summary.contentRef,
        ...input.candidates.flatMap(({ contentRef }) => (contentRef === null ? [] : [contentRef])),
      ];
      const placeholders = payloads.map(() => "?").join(", ");
      const payloadRows = this.database
        .prepare(
          `SELECT ref, classification FROM payloads WHERE owner_id = ? AND agent_id = ?
            AND ref IN (${placeholders})`,
        )
        .all(work.ownerId, work.agentId, ...payloads) as {
        readonly ref: string;
        readonly classification: string;
      }[];
      const classificationByRef = new Map(
        payloadRows.map(({ ref, classification }) => [ref, classification]),
      );
      if (classificationByRef.size !== new Set(payloads).size) {
        this.fail(
          "PORT_NOT_FOUND",
          "Thread distillation output Payload is missing or outside scope",
        );
      }
      if (
        classificationByRef.get(input.summary.contentRef) !== input.summary.dataClassification ||
        input.candidates.some(
          ({ contentRef, dataClassification }) =>
            contentRef !== null && classificationByRef.get(contentRef) !== dataClassification,
        )
      ) {
        this.fail("PORT_INVALID_OPERATION", "Thread distillation Payload classification differs");
      }
      this.database
        .prepare(
          `INSERT INTO thread_summaries (
            id, generation_id, owner_id, agent_id, thread_id, content_ref, classification,
            source_start_sequence, source_end_sequence, source_watermark, policy_version,
            model_descriptor_ref, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.summary.id,
          input.summary.generationId,
          input.summary.ownerId,
          input.summary.agentId,
          input.summary.threadId,
          input.summary.contentRef,
          input.summary.dataClassification,
          input.summary.sourceStartSequence,
          input.summary.sourceEndSequence,
          input.summary.sourceWatermark,
          input.summary.policyVersion,
          input.summary.modelDescriptorRef,
          input.summary.createdAt,
        );
      const insertCandidate = this.database.prepare(
        `INSERT INTO thread_derivative_candidates (
          id, generation_id, ordinal, kind, content_ref, classification, status,
          policy_version, model_descriptor_ref, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertProvenance = this.database.prepare(
        "INSERT INTO thread_derivative_provenance (candidate_id, source_ref) VALUES (?, ?)",
      );
      for (const candidate of input.candidates) {
        insertCandidate.run(
          candidate.id,
          candidate.generationId,
          candidate.ordinal,
          candidate.kind,
          candidate.contentRef,
          candidate.dataClassification,
          candidate.status,
          candidate.policyVersion,
          candidate.modelDescriptorRef,
          candidate.createdAt,
        );
        for (const sourceRef of [...new Set(candidate.sourceRefs)].sort()) {
          insertProvenance.run(candidate.id, sourceRef);
        }
      }
      this.database
        .prepare(
          `UPDATE thread_checkpoint_jobs SET status = 'completed', revision = revision + 1,
            summary_ref = ?, next_retry_at = NULL, claimed_by = NULL, claimed_at = NULL,
            claim_expires_at = NULL, error_code = NULL WHERE id = ?`,
        )
        .run(input.summary.contentRef, input.jobId);
      this.database
        .prepare("UPDATE memory_generations SET status = 'completed', output_ref = ? WHERE id = ?")
        .run(input.summary.contentRef, work.generationId);
      return this.readOutput(work.generationId) as ThreadDistillationOutput;
    });
    return transaction.immediate();
  }

  private retry(input: {
    readonly jobId: CheckpointJobId;
    readonly workerId: string;
    readonly errorCode: string;
    readonly nextRetryAt: string | null;
  }): ThreadDistillationWork {
    if (
      input.workerId.length === 0 ||
      input.errorCode.length === 0 ||
      (input.nextRetryAt !== null && !validIsoTimestamp(input.nextRetryAt))
    ) {
      this.fail("PORT_INVALID_OPERATION", "Thread distillation retry is invalid");
    }
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const current = this.read(input.jobId);
      if (!current) this.fail("PORT_NOT_FOUND", `Thread checkpoint ${input.jobId} not found`);
      if (current.status !== "running" || current.claimedBy !== input.workerId) {
        this.fail("PORT_CONFLICT", `Thread checkpoint ${input.jobId} claim is stale`);
      }
      const status = input.nextRetryAt === null ? "failed_terminal" : "retry_wait";
      this.database
        .prepare(
          `UPDATE thread_checkpoint_jobs SET status = ?, revision = revision + 1,
            next_retry_at = ?, claimed_by = NULL, claimed_at = NULL,
            claim_expires_at = NULL, error_code = ? WHERE id = ?`,
        )
        .run(status, input.nextRetryAt, input.errorCode, input.jobId);
      this.database
        .prepare("UPDATE memory_generations SET status = ? WHERE checkpoint_job_id = ?")
        .run(input.nextRetryAt === null ? "failed_terminal" : "pending", input.jobId);
      return this.read(input.jobId) as ThreadDistillationWork;
    });
    return transaction.immediate();
  }

  private latestSummary(threadId: ThreadId): ThreadSummaryRecord | undefined {
    const row = this.database
      .prepare(
        `${summarySelect} WHERE thread_id = ?
          ORDER BY source_watermark DESC, created_at DESC, id DESC LIMIT 1`,
      )
      .get(threadId) as SummaryRow | undefined;
    return row ? this.summaryFromRow(row) : undefined;
  }
}
