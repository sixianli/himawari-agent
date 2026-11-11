import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type { RuleStatus } from "../rules/rule-book.js";

export interface OwnerRuleScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface StoredOwnerRule {
  readonly ruleId: string;
  readonly revision: number;
  readonly status: RuleStatus;
  readonly source: string;
  readonly sourceMemoryId: string | null;
  readonly parameters: unknown;
  readonly updatedAt: string;
}

export type OwnerRuleWriteOutcome = "created" | "replayed";

export interface OwnerRuleStorePort {
  list(
    input: OwnerRuleScope & { readonly includeRetired: boolean },
  ): Promise<readonly StoredOwnerRule[]>;
  read(input: OwnerRuleScope & { readonly ruleId: string }): Promise<StoredOwnerRule | undefined>;
  create(
    input: OwnerRuleScope & {
      readonly ruleId: string;
      readonly parameters: Readonly<Record<string, unknown>>;
      readonly source: string;
      readonly sourceMemoryId: string;
      readonly now: string;
    },
  ): Promise<OwnerRuleWriteOutcome>;
  setStatus(
    input: OwnerRuleScope & {
      readonly ruleId: string;
      readonly status: "active" | "retired";
      readonly expectedRevision: number;
      readonly reason: "owner_undo" | "owner_confirmed";
      readonly now: string;
    },
  ): Promise<StoredOwnerRule | undefined>;
}
