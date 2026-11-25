import type { OwnerRuleScope } from "./owner-rules.js";

export type SubthreadStatus = "open" | "returned" | "stopped";

export const THREAD_TASK_STATUSES = Object.freeze([
  "pending",
  "in_progress",
  "completed",
  "deleted",
] as const);

export type ThreadTaskStatus = (typeof THREAD_TASK_STATUSES)[number];

export interface SubthreadRecord {
  readonly threadId: string;
  readonly parentThreadId: string;
  readonly matter: string;
  readonly openKey: string;
  readonly openedByRunId: string;
  readonly briefRef: string;
  readonly resultRef: string | null;
  readonly classification: string;
  readonly status: SubthreadStatus;
  readonly stuckAt: string | null;
  readonly progressRef: string | null;
  readonly progressAt: string | null;
  readonly askedAt: string | null;
  readonly budgetMicros: number | null;
  readonly budgetHitAt: string | null;
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SubthreadExchangeRecord {
  readonly id: string;
  readonly threadId: string;
  readonly direction: string;
  readonly kind: string;
  readonly textRef: string;
  readonly createdAt: string;
}

export type ResultGoneReason = "stopped" | "returned" | "stuck";

export interface ResultEntryRecord {
  readonly writerThreadId: string;
  readonly name: string;
  readonly version: number;
  readonly summaryRef: string;
  readonly bodyRef: string;
  readonly classification: string;
  readonly externalContent: boolean;
  readonly createdAt: string;
}

export interface ResultNoticeRecord {
  readonly id: string;
  readonly receiverThreadId: string;
  readonly kind: "ready" | "gone" | "changed";
  readonly writerThreadId: string;
  readonly name: string;
  readonly version: number | null;
  readonly reason: ResultGoneReason | null;
  readonly externalContent: boolean;
  readonly createdAt: string;
}

export type ResultRecordOutcome =
  | { readonly outcome: "recorded"; readonly entry: ResultEntryRecord }
  | { readonly outcome: "closed" }
  | { readonly outcome: "too_many_names" }
  | { readonly outcome: "too_many_versions" };

export type ResultWaitOutcome =
  | { readonly outcome: "available"; readonly version: number }
  | { readonly outcome: "gone"; readonly reason: ResultGoneReason }
  | { readonly outcome: "waiting" }
  | { readonly outcome: "other_matter" }
  | { readonly outcome: "cycle" };

export interface ThreadTaskRecord {
  readonly threadId: string;
  readonly number: number;
  readonly status: ThreadTaskStatus;
  readonly blockedBy: readonly number[];
  readonly assigneeThreadId: string | null;
  readonly contentRef: string;
  readonly classification: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThreadTaskChangeRecord {
  readonly threadId: string;
  readonly number: number;
  readonly revision: number;
  readonly runId: string | null;
  readonly contentRef: string;
  readonly classification: string;
  readonly changedAt: string;
}

export interface ThreadTaskWrite {
  readonly status: ThreadTaskStatus;
  readonly blockedBy: readonly number[];
  readonly assigneeThreadId: string | null;
  readonly contentRef: string;
  readonly classification: string;
}

export type ThreadTaskChangeOutcome =
  | { readonly outcome: "changed"; readonly task: ThreadTaskRecord }
  | { readonly outcome: "missing" }
  | { readonly outcome: "stale"; readonly task: ThreadTaskRecord }
  | { readonly outcome: "cycle" }
  | { readonly outcome: "unknown_dependency" };

export interface SubthreadStorePort {
  open(
    input: OwnerRuleScope & {
      readonly threadId: string;
      readonly parentThreadId: string;
      readonly matter: string;
      readonly title?: string;
      readonly openKey: string;
      readonly openedByRunId: string;
      readonly briefRef: string;
      readonly classification: string;
      readonly now: string;
    },
  ): Promise<{ readonly subthread: SubthreadRecord; readonly created: boolean }>;
  read(input: OwnerRuleScope & { readonly threadId: string }): Promise<SubthreadRecord | undefined>;
  readByOpenKey(
    input: OwnerRuleScope & { readonly openKey: string },
  ): Promise<SubthreadRecord | undefined>;
  list(
    input: OwnerRuleScope & { readonly parentThreadId: string },
  ): Promise<readonly SubthreadRecord[]>;
  settle(
    input: OwnerRuleScope & {
      readonly threadId: string;
      readonly to: "returned" | "stopped";
      readonly resultRef: string | null;
      readonly now: string;
    },
  ): Promise<SubthreadRecord | undefined>;
  createTask(
    input: OwnerRuleScope & {
      readonly threadId: string;
      readonly task: ThreadTaskWrite;
      readonly runId: string | null;
      readonly now: string;
    },
  ): Promise<ThreadTaskChangeOutcome>;
  updateTask(
    input: OwnerRuleScope & {
      readonly threadId: string;
      readonly number: number;
      readonly expectedRevision: number;
      readonly task: ThreadTaskWrite;
      readonly blocks: readonly number[];
      readonly runId: string | null;
      readonly now: string;
    },
  ): Promise<ThreadTaskChangeOutcome>;
  listTasks(
    input: OwnerRuleScope & { readonly threadId: string },
  ): Promise<readonly ThreadTaskRecord[]>;
  listTaskChanges(
    input: OwnerRuleScope & { readonly threadId: string; readonly limit: number },
  ): Promise<readonly ThreadTaskChangeRecord[]>;
  noteActivity(
    input: OwnerRuleScope & {
      readonly threadId: string;
      readonly progressRef?: string;
      readonly asked?: boolean;
      readonly budgetMicros?: number;
      readonly budgetHit?: boolean;
      readonly now: string;
    },
  ): Promise<SubthreadRecord | undefined>;
  listWaiting(
    input: OwnerRuleScope & { readonly parentThreadId: string },
  ): Promise<readonly string[]>;
  listQueued(
    input: OwnerRuleScope & { readonly parentThreadId: string },
  ): Promise<readonly string[]>;
  spentMicros(input: OwnerRuleScope & { readonly threadId: string }): Promise<number>;
  recordExchange(
    input: OwnerRuleScope & {
      readonly id: string;
      readonly threadId: string;
      readonly direction: string;
      readonly kind: string;
      readonly textRef: string;
      readonly now: string;
    },
  ): Promise<void>;
  listExchanges(
    input: OwnerRuleScope & { readonly threadId: string; readonly limit: number },
  ): Promise<readonly SubthreadExchangeRecord[]>;
  markStuck(
    input: OwnerRuleScope & {
      readonly threadId: string;
      readonly stuck: boolean;
      readonly now: string;
    },
  ): Promise<SubthreadRecord | undefined>;
  recordResult(
    input: OwnerRuleScope & {
      readonly writerThreadId: string;
      readonly name: string;
      readonly summaryRef: string;
      readonly bodyRef: string;
      readonly classification: string;
      readonly externalContent: boolean;
      readonly maxNames: number;
      readonly maxVersions: number;
      readonly now: string;
    },
  ): Promise<ResultRecordOutcome>;
  listResults(
    input: OwnerRuleScope & {
      readonly parentThreadId: string;
      readonly matter: string;
      readonly writerThreadId: string | null;
    },
  ): Promise<readonly ResultEntryRecord[]>;
  readResult(
    input: OwnerRuleScope & {
      readonly readerThreadId: string;
      readonly writerThreadId: string;
      readonly name: string;
      readonly now: string;
    },
  ): Promise<ResultEntryRecord | undefined>;
  waitResult(
    input: OwnerRuleScope & {
      readonly waitId: string;
      readonly waiterThreadId: string;
      readonly writerThreadId: string;
      readonly name: string;
      readonly now: string;
    },
  ): Promise<ResultWaitOutcome>;
  listResultNotices(
    input: OwnerRuleScope & { readonly limit: number },
  ): Promise<readonly ResultNoticeRecord[]>;
  deleteResultNotice(input: OwnerRuleScope & { readonly id: string }): Promise<void>;
}
