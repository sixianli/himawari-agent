import type { OwnerRuleParameters } from "../rules/rule-types.js";
import type { OwnerRuleScope } from "./owner-rules.js";

export const RULE_REVIEW_MAX_ATTEMPTS = 3;
export const RULE_REVIEW_RETRY_MS = 3_600_000;
export const RULE_REVIEW_BATCH = 3;

export type RuleReviewSuspendReason =
  | "source_removed"
  | "no_longer_standing"
  | "parameters_changed";

export type RuleReviewFailureReason =
  | "model_failed"
  | "answer_invalid"
  | "content_blocked"
  | "source_unreadable";

export interface RuleReviewCandidate {
  readonly ruleId: string;
  readonly revision: number;
  readonly status: "needs_review" | "suspended";
  readonly parameters: unknown;
  readonly sourceMemoryId: string;
  readonly reviewAttempts: number;
}

export type RuleReviewResolution =
  | { readonly outcome: "cleared" }
  | {
      readonly outcome: "suspended";
      readonly reason: RuleReviewSuspendReason;
      readonly suggestion: OwnerRuleParameters | null;
    };

export interface RuleReviewStorePort {
  listDue(
    input: OwnerRuleScope & { readonly now: string; readonly limit: number },
  ): Promise<readonly RuleReviewCandidate[]>;
  resolve(
    input: OwnerRuleScope & {
      readonly ruleId: string;
      readonly expectedRevision: number;
      readonly sourceMemoryId: string;
      readonly sourceRevision: number | null;
      readonly resolution: RuleReviewResolution;
      readonly now: string;
    },
  ): Promise<boolean>;
  recordFailure(
    input: OwnerRuleScope & {
      readonly ruleId: string;
      readonly expectedRevision: number;
      readonly reason: RuleReviewFailureReason;
      readonly retryAfter: string;
      readonly now: string;
    },
  ): Promise<boolean>;
}

export type RuleReviewOwnerAction = "adopt" | "confirm_suspended" | "restore";

export interface RuleReviewListItem {
  readonly ruleId: string;
  readonly revision: number;
  readonly status: "needs_review" | "suspended";
  readonly parameters: unknown;
  readonly sourceMemoryId: string | null;
  readonly suspendReason: RuleReviewSuspendReason | null;
  readonly suggestion: OwnerRuleParameters | null;
  readonly reviewAttempts: number;
  readonly reviewFailure: RuleReviewFailureReason | null;
  readonly rechecking: boolean;
  readonly updatedAt: string;
}

export interface RuleReviewOwnerStorePort {
  listOpen(
    input: OwnerRuleScope & { readonly limit: number },
  ): Promise<readonly RuleReviewListItem[]>;
  act(
    input: OwnerRuleScope & {
      readonly ruleId: string;
      readonly expectedRevision: number;
      readonly action: RuleReviewOwnerAction;
      readonly now: string;
    },
  ): Promise<boolean>;
}
