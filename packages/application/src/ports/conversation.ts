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
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly modelDescriptorRef: string;
  readonly policyVersion: string;
  readonly outputRef: PayloadRef | null;
}
