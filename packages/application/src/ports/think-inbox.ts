import type { OwnerRuleScope } from "./owner-rules.js";

export type ThinkInboxStatus =
  | "queued"
  | "thinking"
  | "proposed"
  | "skipped"
  | "failed"
  | "expired";

export interface StoredThinkEntry {
  readonly id: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly externalContent: boolean;
  readonly summaryRef: string | null;
  readonly status: ThinkInboxStatus;
  readonly reasonCode: string | null;
  readonly attempts: number;
  readonly day: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ThinkEnqueueOutcome =
  | { readonly outcome: "queued"; readonly entry: StoredThinkEntry }
  | { readonly outcome: "duplicate"; readonly entry: StoredThinkEntry }
  | { readonly outcome: "queue_full" }
  | { readonly outcome: "daily_limit" };

export interface ThinkInboxUsage {
  readonly day: string;
  readonly queued: number;
  readonly thinking: number;
  readonly acceptedToday: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly declinedToday: Readonly<Record<string, number>>;
}

export interface ThinkInboxStorePort {
  enqueue(
    input: OwnerRuleScope & {
      readonly id: string;
      readonly sourceKind: string;
      readonly sourceRef: string;
      readonly sourceVersion: string;
      readonly externalContent: boolean;
      readonly summaryRef: string;
      readonly day: string;
      readonly now: string;
      readonly queueLimit: number;
      readonly dailyLimit: number;
    },
  ): Promise<ThinkEnqueueOutcome>;
  claimNext(
    input: OwnerRuleScope & { readonly now: string },
  ): Promise<StoredThinkEntry | undefined>;
  finish(
    input: OwnerRuleScope & {
      readonly id: string;
      readonly to: "proposed" | "skipped" | "failed";
      readonly reasonCode: string;
      readonly now: string;
    },
  ): Promise<StoredThinkEntry | undefined>;
  recoverStalled(
    input: OwnerRuleScope & {
      readonly stalledBefore: string;
      readonly maxAttempts: number;
      readonly now: string;
    },
  ): Promise<number>;
  expireQueued(
    input: OwnerRuleScope & { readonly createdBefore: string; readonly now: string },
  ): Promise<number>;
  usage(input: OwnerRuleScope & { readonly day: string }): Promise<ThinkInboxUsage>;
  settledSummaries(
    input: OwnerRuleScope & { readonly limit: number },
  ): Promise<readonly { readonly id: string; readonly summaryRef: string }[]>;
  summaryReferenced(input: OwnerRuleScope & { readonly summaryRef: string }): Promise<boolean>;
  clearSummary(
    input: OwnerRuleScope & { readonly id: string; readonly summaryRef: string },
  ): Promise<boolean>;
}
