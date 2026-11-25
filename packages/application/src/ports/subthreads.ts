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
  readonly createdAt: string;
  readonly updatedAt: string;
}

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
}
