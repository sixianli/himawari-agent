import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";

export interface MemoryReminderSchedule {
  readonly dueAt: string;
  readonly remindAt: string;
  readonly repeat: "none" | "yearly";
}

export interface MemoryReminder extends MemoryReminderSchedule {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly memoryId: MemoryId;
  readonly status: "scheduled" | "dismissed" | "cancelled";
  readonly dismissedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryReminderStorePort {
  schedule(reminder: MemoryReminder): Promise<void>;
  listDue(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly MemoryReminder[]>;
  countDue(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly now: string;
  }): Promise<number>;
  listUpcoming(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly from: string;
    readonly to: string;
    readonly limit: number;
    readonly remindAfter?: string;
  }): Promise<readonly MemoryReminder[]>;
  read(id: string): Promise<MemoryReminder | undefined>;
  update(input: {
    readonly id: string;
    readonly expectedUpdatedAt: string;
    readonly status: MemoryReminder["status"];
    readonly dueAt: string;
    readonly remindAt: string;
    readonly dismissedAt: string | null;
    readonly updatedAt: string;
  }): Promise<boolean>;
}
