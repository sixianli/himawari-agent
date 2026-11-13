import type { AgentId, OwnerId, RunId, ThreadId } from "@himawari-agent/domain";

export const MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS = 3;

export interface MemoryCaptureBacklogEntry {
  readonly generationId: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly sourceRunId: RunId;
  readonly attempts: number;
  readonly lastErrorCode: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryCaptureBacklogPort {
  enqueue(entry: Omit<MemoryCaptureBacklogEntry, "attempts" | "updatedAt">): Promise<void>;
  oldest(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly excludeGenerationId: string;
  }): Promise<MemoryCaptureBacklogEntry | undefined>;
  recordAttempt(input: {
    readonly generationId: string;
    readonly errorCode: string;
    readonly updatedAt: string;
  }): Promise<number>;
  has(generationId: string): Promise<boolean>;
  remove(generationId: string): Promise<void>;
}
