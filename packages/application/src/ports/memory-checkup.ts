import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";

export type MemoryCheckupReason = "conflict" | "unused" | "low_confidence" | "source_unavailable";
export type MemoryCheckupAction = "confirm" | "delete" | "merge";

export interface MemoryCheckupBefore {
  readonly tentative: boolean;
  readonly status?: "active" | "archived";
  readonly dropMemoryId?: MemoryId;
  readonly dropStatus?: "active" | "archived";
  readonly dropSupersededBy?: MemoryId | null;
  readonly dropValidTo?: string | null;
  readonly keepTentative?: boolean;
}

export interface MemoryCheckupItem {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly weekStart: string;
  readonly memoryId: MemoryId;
  readonly relatedMemoryId: MemoryId | null;
  readonly reason: MemoryCheckupReason;
  readonly action: MemoryCheckupAction | null;
  readonly keptMemoryId: MemoryId | null;
  readonly before: MemoryCheckupBefore | null;
  readonly handledAt: string | null;
  readonly undoneAt: string | null;
  readonly createdAt: string;
}

export interface MemoryCheckupScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface MemoryCheckupStorePort {
  listWeek(
    input: MemoryCheckupScope & { readonly weekStart: string },
  ): Promise<readonly MemoryCheckupItem[]>;
  createWeek(
    input: MemoryCheckupScope & {
      readonly weekStart: string;
      readonly items: readonly Pick<
        MemoryCheckupItem,
        "id" | "memoryId" | "relatedMemoryId" | "reason"
      >[];
      readonly createdAt: string;
    },
  ): Promise<boolean>;
  read(input: MemoryCheckupScope & { readonly id: string }): Promise<MemoryCheckupItem | undefined>;
  recordAction(
    input: MemoryCheckupScope & {
      readonly id: string;
      readonly action: MemoryCheckupAction;
      readonly keptMemoryId: MemoryId | null;
      readonly before: MemoryCheckupBefore;
      readonly handledAt: string;
    },
  ): Promise<boolean>;
  recordUndo(
    input: MemoryCheckupScope & { readonly id: string; readonly undoneAt: string },
  ): Promise<boolean>;
  listConfirmedSince(
    input: MemoryCheckupScope & { readonly since: string },
  ): Promise<readonly MemoryId[]>;
}
