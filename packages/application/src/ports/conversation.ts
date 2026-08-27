import type {
  AgentId,
  CheckpointJobId,
  MemoryGenerationId,
  MessageId,
  OwnerId,
  ThreadCheckpointJob,
  ThreadId,
} from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";

export interface ThreadMessageRecord {
  readonly id: MessageId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly revision: number;
  readonly sequence: number;
  readonly role: "owner" | "agent" | "system";
  readonly contentRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly committedAt: string;
}

export interface ThreadMessageStorePort {
  append(
    message: Omit<ThreadMessageRecord, "revision">,
    expectedThreadRevision: number,
  ): Promise<ThreadMessageRecord>;
  list(
    threadId: ThreadId,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ThreadMessageRecord[]>;
}

export interface ThreadCheckpointRecord extends ThreadCheckpointJob {
  readonly revision: number;
  readonly summaryRef: PayloadRef | null;
  readonly sourceRefs: readonly string[];
  readonly errorCode: string | null;
}

export interface ThreadCheckpointStatePort {
  read(jobId: CheckpointJobId): Promise<ThreadCheckpointRecord | undefined>;
  findByIdentity(input: {
    readonly threadId: ThreadId;
    readonly sourceWatermark: number;
    readonly policyVersion: string;
  }): Promise<ThreadCheckpointRecord | undefined>;
  create(
    job: ThreadCheckpointJob & { readonly sourceRefs: readonly string[] },
  ): Promise<ThreadCheckpointRecord>;
  save(job: ThreadCheckpointRecord, expectedRevision: number): Promise<ThreadCheckpointRecord>;
  listPending(limit: number): Promise<readonly ThreadCheckpointRecord[]>;
}

export interface MemoryGenerationRecord {
  readonly id: MemoryGenerationId;
  readonly checkpointJobId: CheckpointJobId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly status: "pending" | "running" | "completed" | "failed_terminal";
  readonly modelDescriptorRef: string;
  readonly policyVersion: string;
  readonly outputRef: PayloadRef | null;
}

export type ThreadCheckpointTrigger =
  | "owner_explicit"
  | "controlled_idle"
  | "pre_compaction"
  | "source_threshold";

export interface ThreadCheckpointSourceRef {
  readonly ref: string;
  readonly sequence: number;
  readonly kind: "message" | "run";
  readonly dataClassification: DataClassification;
}

export interface ThreadDistillationWork {
  readonly jobId: CheckpointJobId;
  readonly generationId: MemoryGenerationId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly sourceWatermark: number;
  readonly policyVersion: string;
  readonly modelDescriptorRef: string;
  readonly trigger: ThreadCheckpointTrigger;
  readonly status: "pending" | "running" | "completed" | "retry_wait" | "failed_terminal";
  readonly revision: number;
  readonly attemptCount: number;
  readonly nextRetryAt: string | null;
  readonly claimedBy: string | null;
  readonly claimExpiresAt: string | null;
  readonly sources: readonly ThreadCheckpointSourceRef[];
  readonly requestedAt: string;
  readonly errorCode: string | null;
}

export type ThreadDerivativeKind = "memory" | "experience" | "commitment";

export interface ThreadSummaryRecord {
  readonly id: string;
  readonly generationId: MemoryGenerationId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly contentRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly sourceStartSequence: number;
  readonly sourceEndSequence: number;
  readonly sourceWatermark: number;
  readonly policyVersion: string;
  readonly modelDescriptorRef: string;
  readonly createdAt: string;
}

export interface ThreadDerivativeCandidateRecord {
  readonly id: string;
  readonly generationId: MemoryGenerationId;
  readonly ordinal: number;
  readonly kind: ThreadDerivativeKind;
  readonly contentRef: PayloadRef | null;
  readonly dataClassification: DataClassification;
  readonly status: "candidate" | "awaiting_sensitive_approval";
  readonly sourceRefs: readonly string[];
  readonly policyVersion: string;
  readonly modelDescriptorRef: string;
  readonly createdAt: string;
}

export interface ThreadDistillationOutput {
  readonly work: ThreadDistillationWork;
  readonly summary: ThreadSummaryRecord;
  readonly candidates: readonly ThreadDerivativeCandidateRecord[];
}

export interface ThreadDistillationStatePort {
  request(work: ThreadDistillationWork): Promise<ThreadDistillationWork>;
  read(jobId: CheckpointJobId): Promise<ThreadDistillationWork | undefined>;
  findByIdentity(input: {
    readonly threadId: ThreadId;
    readonly sourceWatermark: number;
    readonly policyVersion: string;
  }): Promise<ThreadDistillationWork | undefined>;
  listReady(now: string, limit: number): Promise<readonly ThreadDistillationWork[]>;
  claim(input: {
    readonly jobId: CheckpointJobId;
    readonly workerId: string;
    readonly claimedAt: string;
    readonly expiresAt: string;
  }): Promise<ThreadDistillationWork | undefined>;
  commit(input: {
    readonly jobId: CheckpointJobId;
    readonly workerId: string;
    readonly summary: ThreadSummaryRecord;
    readonly candidates: readonly ThreadDerivativeCandidateRecord[];
  }): Promise<ThreadDistillationOutput>;
  retry(input: {
    readonly jobId: CheckpointJobId;
    readonly workerId: string;
    readonly errorCode: string;
    readonly nextRetryAt: string | null;
  }): Promise<ThreadDistillationWork>;
  readOutput(generationId: MemoryGenerationId): Promise<ThreadDistillationOutput | undefined>;
  latestSummary(threadId: ThreadId): Promise<ThreadSummaryRecord | undefined>;
}

export interface ThreadDistillationModelCandidate {
  readonly kind: ThreadDerivativeKind;
  readonly text: string;
  readonly dataClassification: DataClassification;
  readonly sourceRefs: readonly string[];
}

export interface ThreadDistillationModelPort {
  distill(input: {
    readonly threadId: ThreadId;
    readonly sourceWatermark: number;
    readonly policyVersion: string;
    readonly modelDescriptorRef: string;
    readonly sources: readonly (ThreadCheckpointSourceRef & { readonly text: string })[];
  }): Promise<{
    readonly summaryText: string;
    readonly summaryClassification: DataClassification;
    readonly candidates: readonly ThreadDistillationModelCandidate[];
  }>;
}
