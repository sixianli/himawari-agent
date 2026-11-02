import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";
import type { ProductMemoryRecord } from "./memory-projection.js";

export type MemoryConsolidationAction = "merge" | "supersede" | "archive" | "reflect";

export interface MemoryConsolidationRun {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly day: string;
  readonly triggerRunId: string;
  readonly status: "running" | "completed" | "failed";
  readonly reviewedThrough: string | null;
  readonly modelCalled: boolean;
  readonly changeCount: number;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface MemoryConsolidationChange {
  readonly id: string;
  readonly consolidationId: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly memoryId: MemoryId;
  readonly relatedMemoryId: MemoryId | null;
  readonly action: MemoryConsolidationAction;
  readonly beforeRevision: number | null;
  readonly afterRevision: number;
  readonly beforeStatus: ProductMemoryRecord["status"] | null;
  readonly beforeSupersededBy: MemoryId | null;
  readonly beforeValidTo: string | null;
  readonly createdAt: string;
  readonly undoneAt: string | null;
}

export interface MemoryConsolidationLedgerMemories {
  readonly memoryIds: readonly MemoryId[];
  readonly resultMemoryIds: readonly MemoryId[];
}

export interface MemoryConsolidationStorePort {
  begin(run: MemoryConsolidationRun): Promise<boolean>;
  lastCompleted(ownerId: OwnerId, agentId: AgentId): Promise<MemoryConsolidationRun | undefined>;
  finish(input: {
    readonly id: string;
    readonly status: "completed" | "failed";
    readonly reviewedThrough: string | null;
    readonly modelCalled: boolean;
    readonly errorCode: string | null;
    readonly finishedAt: string;
  }): Promise<void>;
  recordChange(
    change: MemoryConsolidationChange,
    ledgerMemories?: MemoryConsolidationLedgerMemories,
  ): Promise<void>;
  listChanges(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly limit: number;
  }): Promise<readonly MemoryConsolidationChange[]>;
  readChange(id: string): Promise<MemoryConsolidationChange | undefined>;
  markUndone(input: { readonly id: string; readonly undoneAt: string }): Promise<boolean>;
}
