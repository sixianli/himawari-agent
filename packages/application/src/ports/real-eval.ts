import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type { PayloadRef } from "./common.js";

export const REAL_EVAL_ITEM_KINDS = ["fact", "preference", "time", "abstain"] as const;
export type RealEvalItemKind = (typeof REAL_EVAL_ITEM_KINDS)[number];

export const REAL_EVAL_RETIRE_REASONS = [
  "memory_inactive",
  "memory_tentative",
  "memory_superseded",
  "memory_expired",
  "memory_not_visible",
  "memory_revised",
] as const;
export type RealEvalRetireReason = (typeof REAL_EVAL_RETIRE_REASONS)[number];

export const REAL_EVAL_RUN_OUTCOMES = ["completed", "budget_exceeded", "failed"] as const;
export type RealEvalRunOutcome = (typeof REAL_EVAL_RUN_OUTCOMES)[number];

export const REAL_EVAL_TRIGGERS = ["weekly", "manual"] as const;
export type RealEvalTrigger = (typeof REAL_EVAL_TRIGGERS)[number];

export interface RealEvalScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface RealEvalQuestionRecord {
  readonly id: string;
  readonly memoryId: string;
  readonly memoryRevision: number;
  readonly kind: RealEvalItemKind;
  readonly questionRef: PayloadRef;
  readonly questionModel: string;
  readonly promptSha256: string;
  readonly createdAt: string;
  readonly retiredAt: string | null;
  readonly retiredReason: RealEvalRetireReason | null;
}

export interface RealEvalRunRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: RealEvalRunOutcome;
  readonly trigger: RealEvalTrigger;
  readonly model: string;
  readonly costMicros: number;
  readonly summary: Readonly<Record<string, unknown>>;
}

export interface RealEvalStorePort {
  listQuestions(input: RealEvalScope): Promise<readonly RealEvalQuestionRecord[]>;
  addQuestion(
    input: RealEvalScope & {
      readonly question: Omit<RealEvalQuestionRecord, "retiredAt" | "retiredReason">;
    },
  ): Promise<boolean>;
  retireQuestion(
    input: RealEvalScope & {
      readonly id: string;
      readonly reason: RealEvalRetireReason;
      readonly at: string;
    },
  ): Promise<void>;
  recordRun(input: RealEvalScope & { readonly run: RealEvalRunRecord }): Promise<void>;
  listRuns(
    input: RealEvalScope & { readonly limit: number },
  ): Promise<readonly RealEvalRunRecord[]>;
}
