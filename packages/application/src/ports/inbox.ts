import type { OwnerRuleScope } from "./owner-rules.js";

export type InboxStatus = "queued" | "running" | "done" | "failed";

export interface StoredInboxEvent {
  readonly id: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly externalContent: boolean;
  readonly fromOwner: boolean;
  readonly priority: number;
  readonly threadId: string | null;
  readonly summaryRef: string | null;
  readonly status: InboxStatus;
  readonly outcome: string | null;
  readonly reasonCode: string | null;
  readonly runId: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InboxConversation {
  readonly threadId: string | null;
  readonly fromOwner: boolean;
}

export type InboxEnqueueOutcome =
  | { readonly outcome: "queued"; readonly entry: StoredInboxEvent }
  | { readonly outcome: "duplicate"; readonly entry: StoredInboxEvent };

export interface InboxUsage {
  readonly queued: number;
  readonly running: number;
  readonly byStatus: Readonly<Record<string, number>>;
}

export interface InboxSettingsRecord {
  readonly revision: number;
  readonly overrides: Readonly<Record<string, number>>;
  readonly updatedAt: string | null;
}

export interface InboxStorePort {
  enqueue(
    input: OwnerRuleScope & {
      readonly id: string;
      readonly sourceKind: string;
      readonly sourceRef: string;
      readonly sourceVersion: string;
      readonly externalContent: boolean;
      readonly fromOwner: boolean;
      readonly priority: number;
      readonly threadId: string | null;
      readonly summaryRef: string;
      readonly now: string;
    },
  ): Promise<InboxEnqueueOutcome>;
  claimBatch(
    input: OwnerRuleScope & {
      readonly now: string;
      readonly limit: number;
      readonly skip?: readonly InboxConversation[];
    },
  ): Promise<readonly StoredInboxEvent[]>;
  finish(
    input: OwnerRuleScope & {
      readonly ids: readonly string[];
      readonly to: "done" | "failed";
      readonly outcome: string | null;
      readonly reasonCode: string;
      readonly runId: string | null;
      readonly now: string;
    },
  ): Promise<number>;
  release(
    input: OwnerRuleScope & {
      readonly ids: readonly string[];
      readonly countAttempt: boolean;
      readonly now: string;
    },
  ): Promise<number>;
  recoverStalled(
    input: OwnerRuleScope & {
      readonly stalledBefore: string;
      readonly maxAttempts: number;
      readonly now: string;
    },
  ): Promise<number>;
  usage(input: OwnerRuleScope): Promise<InboxUsage>;
  settledSummaries(
    input: OwnerRuleScope & { readonly limit: number },
  ): Promise<readonly { readonly id: string; readonly summaryRef: string }[]>;
  summaryReferenced(input: OwnerRuleScope & { readonly summaryRef: string }): Promise<boolean>;
  clearSummary(
    input: OwnerRuleScope & { readonly id: string; readonly summaryRef: string },
  ): Promise<boolean>;
  readSettings(input: OwnerRuleScope): Promise<InboxSettingsRecord>;
  changeSettings(
    input: OwnerRuleScope & {
      readonly expectedRevision: number;
      readonly overrides: Readonly<Record<string, number>>;
      readonly now: string;
    },
  ): Promise<InboxSettingsRecord>;
  recordUrgency(
    input: OwnerRuleScope & {
      readonly messageId: string;
      readonly urgency: MessageUrgency;
      readonly now: string;
    },
  ): Promise<void>;
  readUrgency(
    input: OwnerRuleScope & { readonly messageIds: readonly string[] },
  ): Promise<Readonly<Record<string, MessageUrgency>>>;
}

export const MESSAGE_URGENCIES = ["low", "normal", "high"] as const;
export type MessageUrgency = (typeof MESSAGE_URGENCIES)[number];

export function isMessageUrgency(value: unknown): value is MessageUrgency {
  return typeof value === "string" && (MESSAGE_URGENCIES as readonly string[]).includes(value);
}
