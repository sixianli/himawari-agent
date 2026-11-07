import type {
  ProactivePriority,
  ProactiveScope,
  ProactiveSource,
  ProactiveSourceItem,
} from "./proactive-checks.js";

export const PROACTIVE_REPLAY_STATUSES = ["running", "finished", "failed", "interrupted"] as const;

export const PROACTIVE_REPLAY_OUTCOMES = [
  "act",
  "know",
  "check",
  "ignore",
  "skipped",
  "failed",
] as const;

export const PROACTIVE_REPLAY_MAIL_LIMIT = 2000;
export const PROACTIVE_REPLAY_BUDGET_LIMIT_MICROS = 5_000_000;
export const PROACTIVE_REPLAY_PAGE_LIMIT = 200;

export type ProactiveReplayStatus = (typeof PROACTIVE_REPLAY_STATUSES)[number];
export type ProactiveReplayOutcome = (typeof PROACTIVE_REPLAY_OUTCOMES)[number];

export interface ProactiveReplayRun {
  readonly id: string;
  readonly source: ProactiveSource;
  readonly rangeFrom: string;
  readonly rangeTo: string;
  readonly mailLimit: number;
  readonly budgetMicros: number;
  readonly status: ProactiveReplayStatus;
  readonly reasonCode: string | null;
  readonly listed: number;
  readonly judged: number;
  readonly costMicros: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface ProactiveReplayResult {
  readonly messageId: string;
  readonly threadId: string;
  readonly receivedAt: string;
  readonly sentByOwner: boolean;
  readonly outcome: ProactiveReplayOutcome;
  readonly reasonCode: string | null;
  readonly floorHit: boolean;
  readonly floorRaised: boolean;
  readonly push: boolean;
  readonly priority: ProactivePriority | null;
  readonly dueAt: string | null;
  readonly contentRef: string | null;
  readonly costMicros: number;
  readonly judgedAt: string;
}

export interface ProactiveReplayStorePort {
  startRun(
    input: ProactiveScope & {
      readonly id: string;
      readonly source: ProactiveSource;
      readonly rangeFrom: string;
      readonly rangeTo: string;
      readonly mailLimit: number;
      readonly budgetMicros: number;
      readonly now: string;
    },
  ): Promise<boolean>;
  markListed(
    input: ProactiveScope & { readonly runId: string; readonly listed: number },
  ): Promise<void>;
  recordResult(
    input: ProactiveScope & { readonly runId: string; readonly result: ProactiveReplayResult },
  ): Promise<boolean>;
  finishRun(
    input: ProactiveScope & {
      readonly runId: string;
      readonly status: Exclude<ProactiveReplayStatus, "running">;
      readonly reasonCode: string;
      readonly now: string;
    },
  ): Promise<void>;
  interruptRunning(input: ProactiveScope & { readonly now: string }): Promise<number>;
  readRun(
    input: ProactiveScope & { readonly runId: string },
  ): Promise<ProactiveReplayRun | undefined>;
  listResults(
    input: ProactiveScope & {
      readonly runId: string;
      readonly afterMessageId: string | null;
      readonly limit: number;
    },
  ): Promise<readonly ProactiveReplayResult[]>;
  deleteRun(input: ProactiveScope & { readonly runId: string }): Promise<readonly string[]>;
}

export const PROACTIVE_HISTORY_READ_CHUNK = 10;

export type ProactiveHistoryFailure =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "failed"; readonly step: string };

export interface ProactiveHistoryReader {
  readonly source: ProactiveSource;
  list(input: {
    readonly token: string;
    readonly from: string;
    readonly to: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly kind: "ids"; readonly ids: readonly string[] } | ProactiveHistoryFailure>;
  read(input: {
    readonly token: string;
    readonly messageIds: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly kind: "items"; readonly items: readonly ProactiveSourceItem[] }
    | ProactiveHistoryFailure
  >;
}
