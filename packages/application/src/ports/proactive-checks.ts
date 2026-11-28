import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type { DataClassification } from "./common.js";
import type {
  ProactiveMailExtra,
  ProactiveMailItem,
  ProactiveSource,
  ProactiveSourceItem,
  ProactiveSourceSettings,
} from "./proactive-sources.js";
export type ProactiveResult = "act" | "know" | "check" | "ignore";
export type ProactiveConfidence = "sure" | "unsure";
export type ProactivePriority = "high" | "medium" | "low";
export type ProactiveVerdict =
  | "pushed"
  | "silent"
  | "deferred"
  | "failed"
  | "capped"
  | "capped_daily"
  | "needs_owner";
export type ProactiveInsightStatus = "open" | "replied" | "done" | "muted";
export type ProactiveRating = "useful" | "unneeded" | "missed";
export type ProactiveSkipReason = "category" | "sensitive" | "own_mail";

export interface ProactiveScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface ProactiveQuietPeriod {
  readonly days: readonly number[];
  readonly start: string;
  readonly end: string;
}

export interface ProactiveSettings {
  readonly enabled: boolean;
  readonly quietHours: readonly ProactiveQuietPeriod[];
  readonly quietHoursRevision: number;
  readonly importantSenders: readonly string[];
  readonly importantSendersRevision: number;
  readonly updatedAt: string | null;
}

export interface ProactiveCounts {
  readonly fetched: number;
  readonly skipped: number;
  readonly judged: number;
  readonly act: number;
  readonly know: number;
  readonly check: number;
  readonly ignore: number;
  readonly floorRaised: number;
  readonly pushed: number;
}

export interface ProactiveDecision {
  readonly id: string;
  readonly scenario: ProactiveSource;
  readonly checkedAt: string;
  readonly counts: ProactiveCounts;
  readonly verdict: ProactiveVerdict;
  readonly reasonCode: string;
  readonly pushSourceKey: string | null;
  readonly costMicros: number;
  readonly durationMs: number;
  readonly ownerRating: ProactiveRating | null;
  readonly ratedAt: string | null;
}

export interface ProactiveInsightContent {
  readonly summary: string;
  readonly reason: string;
  readonly basis: "model" | "daily_limit";
  readonly floorHit?: boolean;
  readonly from: string;
  readonly subject: string;
  readonly link: string;
}

export const PROACTIVE_INSIGHT_LIST_MAXIMUM = 500;

export interface ProactiveInsight {
  readonly id: string;
  readonly source: ProactiveSource;
  readonly threadId: string;
  readonly lastMessageId: string;
  readonly result: Exclude<ProactiveResult, "ignore">;
  readonly floorRaised: boolean;
  readonly contentRef: string;
  readonly dueAt: string | null;
  readonly priority: ProactivePriority | null;
  readonly status: ProactiveInsightStatus;
  readonly decisionId: string;
  readonly ownerRating: ProactiveRating | null;
  readonly pushSourceKey: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProactiveProcessedMessage {
  readonly source: ProactiveSource;
  readonly messageId: string;
  readonly threadId: string;
  readonly decisionId: string;
  readonly outcome: ProactiveResult | "skipped";
  readonly skipReason: ProactiveSkipReason | null;
  readonly headerRef: string | null;
  readonly processedAt: string;
  readonly reviewedAt: string | null;
  readonly ownerRating: ProactiveRating | null;
}

export interface ProactiveConnection {
  readonly source: ProactiveSource;
  readonly accountRef: string;
  readonly tokenRef: string;
  readonly cursor: string | null;
  readonly status: "connected" | "needs_reconnect";
  readonly connectedAt: string;
  readonly updatedAt: string;
}

export interface ProactivePush {
  readonly id: string;
  readonly readyAt: string;
  readonly insightIds: readonly string[];
  readonly status: "pending" | "enqueued";
  readonly createdAt: string;
}

export interface ProactiveInsightWrite {
  readonly id: string;
  readonly threadId: string;
  readonly lastMessageId: string;
  readonly result: ProactiveInsight["result"];
  readonly floorRaised: boolean;
  readonly contentRef: string;
  readonly dueAt: string | null;
  readonly priority: ProactivePriority | null;
  readonly push: boolean;
}

export type ProactiveModelPayloadRole = "model_input" | "model_output";

export interface ProactiveModelPayload {
  readonly ref: string;
  readonly role: ProactiveModelPayloadRole;
}

export interface ProactiveMemoryHit {
  readonly id: string;
  readonly text: string;
  readonly score: number;
  readonly tentative?: boolean;
  readonly dataClassification: DataClassification;
}

export interface ProactiveMemoryQuery {
  readonly messageId: string;
  readonly query: string;
}

export interface ProactiveMemoryRecallResult {
  readonly hits: ReadonlyMap<string, readonly ProactiveMemoryHit[]>;
  readonly costMicros: number;
  readonly failedQueries: number;
}

export interface ProactiveMemoryRecall {
  recall(input: {
    readonly queries: readonly ProactiveMemoryQuery[];
    readonly deadlineAt: string;
    readonly signal: AbortSignal;
  }): Promise<ProactiveMemoryRecallResult>;
}

export type ProactiveMemoryRecallStatus = "off" | "ok" | "partial" | "failed";

export interface ProactiveRecentSummary {
  readonly id: string;
  readonly day: string;
  readonly text: string;
  readonly dataClassification: DataClassification;
}

export interface ProactiveRecentSummaries {
  catchUp(input: {
    readonly days: number;
    readonly limit: number;
    readonly deadlineAt: string;
    readonly signal: AbortSignal;
    readonly generate: (prompt: string, dataClassification: DataClassification) => Promise<string>;
  }): Promise<{
    readonly generated: number;
    readonly costMicros: number;
    readonly failed: boolean;
  }>;
  recent(input: {
    readonly days: number;
    readonly limit: number;
  }): Promise<{ readonly summaries: readonly ProactiveRecentSummary[]; readonly partial: boolean }>;
}

export type ProactiveSummaryReadStatus = "off" | "ok" | "partial" | "failed";

export type ProactiveRelatedReadStatus = "off" | "ok" | "partial" | "failed";

export interface ProactiveRelatedStats {
  readonly requests: number;
  readonly messages: number;
  readonly characters: number;
  readonly durationMs: number;
}

export interface ProactiveCheckInputs {
  readonly ruleIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly floorHits: Readonly<Record<string, readonly string[]>>;
  readonly ruleHits?: Readonly<Record<string, readonly string[]>>;
  readonly memoryInjected: boolean;
  readonly memoryIds: readonly string[];
  readonly usedMemoryIds: readonly string[];
  readonly tentativeMemoryIds?: readonly string[];
  readonly memoryByMail: Readonly<Record<string, readonly string[]>>;
  readonly memoryRecall: ProactiveMemoryRecallStatus;
  readonly relatedByMail?: Readonly<Record<string, readonly string[]>>;
  readonly relatedRead?: ProactiveRelatedReadStatus;
  readonly relatedStats?: ProactiveRelatedStats;
  readonly relatedFailedSteps?: readonly string[];
  readonly summaryInjected?: boolean;
  readonly summaryIds?: readonly string[];
  readonly summaryDays?: readonly string[];
  readonly summaryCharacters?: number;
  readonly summaryRead?: ProactiveSummaryReadStatus;
  readonly summaryGenerated?: number;
  readonly observations?: ProactiveObservationHandOff;
}

export interface ProactiveObservationHandOff {
  readonly handedOff: number;
  readonly sink: "not_connected" | "port";
}

export interface ProactiveCheckRecord extends ProactiveScope {
  readonly decision: ProactiveDecision;
  readonly inputs: ProactiveCheckInputs;
  readonly modelPayloads: readonly ProactiveModelPayload[];
  readonly processed: readonly (Omit<
    ProactiveProcessedMessage,
    "reviewedAt" | "ownerRating" | "decisionId" | "processedAt"
  > & { readonly receivedAt: string })[];
  readonly insights: readonly ProactiveInsightWrite[];
  readonly repliedThreads: readonly { readonly threadId: string; readonly receivedAt: string }[];
  readonly push: { readonly id: string; readonly readyAt: string } | null;
  readonly cursor: string | null;
  readonly onlyIfNew?: {
    readonly source: ProactiveSource;
    readonly since: string;
  };
}

export interface ProactiveRecordResult {
  readonly insightIds: readonly string[];
  readonly releasedRefs: readonly string[];
  readonly refused?: "already_recorded" | "daily_limit";
}

export interface ProactiveStorePort {
  readSettings(input: ProactiveScope): Promise<ProactiveSettings>;
  writeSettings(
    input: ProactiveScope & {
      readonly enabled: boolean;
      readonly quietHours: readonly ProactiveQuietPeriod[];
      readonly importantSenders: readonly string[];
      readonly now: string;
    },
  ): Promise<void>;
  setEnabled(
    input: ProactiveScope & { readonly enabled: boolean; readonly now: string },
  ): Promise<void>;
  readConnection(
    input: ProactiveScope & { readonly source: ProactiveSource },
  ): Promise<ProactiveConnection | undefined>;
  saveConnection(
    input: ProactiveScope & { readonly connection: ProactiveConnection },
  ): Promise<readonly string[]>;
  markConnection(
    input: ProactiveScope & {
      readonly source: ProactiveSource;
      readonly status: ProactiveConnection["status"];
      readonly cursor: string | null;
      readonly now: string;
    },
  ): Promise<void>;
  removeSource(
    input: ProactiveScope & { readonly source: ProactiveSource },
  ): Promise<readonly string[]>;
  clearRecords(
    input: ProactiveScope & { readonly source: ProactiveSource },
  ): Promise<readonly string[]>;
  readDecisionPayloads(
    input: ProactiveScope & { readonly decisionId: string },
  ): Promise<readonly ProactiveModelPayload[]>;
  unprocessed(
    input: ProactiveScope & {
      readonly source: ProactiveSource;
      readonly messageIds: readonly string[];
    },
  ): Promise<readonly string[]>;
  readInsight(
    input: ProactiveScope & { readonly source: ProactiveSource; readonly threadId: string },
  ): Promise<ProactiveInsight | undefined>;
  record(input: ProactiveCheckRecord): Promise<ProactiveRecordResult>;
  costSince(input: ProactiveScope & { readonly since: string }): Promise<number>;
  listInsights(
    input: ProactiveScope & { readonly statuses: readonly ProactiveInsightStatus[] },
  ): Promise<readonly ProactiveInsight[]>;
  listDecisions(
    input: ProactiveScope & { readonly since: string; readonly limit: number },
  ): Promise<readonly ProactiveDecision[]>;
  listProcessed(
    input: ProactiveScope & {
      readonly since: string;
      readonly outcome: ProactiveProcessedMessage["outcome"];
      readonly limit: number;
    },
  ): Promise<readonly ProactiveProcessedMessage[]>;
  reviewedCount(input: ProactiveScope): Promise<number>;
  updateInsight(
    input: ProactiveScope & {
      readonly insightId: string;
      readonly status?: ProactiveInsightStatus;
      readonly rating?: ProactiveRating | null;
      readonly now: string;
    },
  ): Promise<boolean>;
  rateDecision(
    input: ProactiveScope & {
      readonly decisionId: string;
      readonly rating: ProactiveRating | null;
      readonly now: string;
    },
  ): Promise<boolean>;
  rateProcessed(
    input: ProactiveScope & {
      readonly source: ProactiveSource;
      readonly messageId: string;
      readonly rating: ProactiveRating | null;
      readonly now: string;
    },
  ): Promise<boolean>;
  markReviewed(
    input: ProactiveScope & {
      readonly source: ProactiveSource;
      readonly messageIds: readonly string[];
      readonly now: string;
    },
  ): Promise<number>;
  pendingPush(
    input: ProactiveScope & { readonly readyAt: string },
  ): Promise<ProactivePush | undefined>;
  listReadyPushes(
    input: ProactiveScope & { readonly now: string; readonly limit: number },
  ): Promise<readonly ProactivePush[]>;
  markPushEnqueued(
    input: ProactiveScope & { readonly pushId: string; readonly now: string },
  ): Promise<boolean>;
  readPush(input: ProactiveScope & { readonly pushId: string }): Promise<ProactivePush | undefined>;
  readInsights(
    input: ProactiveScope & { readonly insightIds: readonly string[] },
  ): Promise<readonly ProactiveInsight[]>;
  listSourceSettings(input: ProactiveScope): Promise<readonly ProactiveSourceSettings[]>;
  writeSourceSettings(
    input: ProactiveScope & {
      readonly source: ProactiveSource;
      readonly enabled: boolean;
      readonly perDay: number;
      readonly perCheck: number;
      readonly changeId: string;
      readonly now: string;
    },
  ): Promise<void>;
  processedSince(
    input: ProactiveScope & { readonly source: ProactiveSource; readonly since: string },
  ): Promise<number>;
}

export interface ProactiveSealPort {
  seal(
    input: ProactiveScope & {
      readonly text: string;
      readonly at: string;
      readonly dataClassification?: DataClassification;
    },
  ): Promise<string>;
  open(input: ProactiveScope & { readonly ref: string }): Promise<string | undefined>;
  classificationOf?(
    input: ProactiveScope & { readonly ref: string },
  ): Promise<DataClassification | undefined>;
  release(input: ProactiveScope & { readonly refs: readonly string[] }): Promise<void>;
}

export class ProactiveSourceUnauthorizedError extends Error {}

export type ProactiveFetchResult<Extra = Readonly<Record<string, unknown>>> =
  | {
      readonly kind: "items";
      readonly items: readonly ProactiveSourceItem<Extra>[];
      readonly cursor: string | null;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "failed"; readonly step: string };

export interface ProactiveSourceReader<Extra = Readonly<Record<string, unknown>>> {
  readonly source: ProactiveSource;
  fetch(input: {
    readonly token: string;
    readonly cursor: string | null;
    readonly since: string;
    readonly signal: AbortSignal;
    readonly unseen: (messageIds: readonly string[]) => Promise<readonly string[]>;
  }): Promise<ProactiveFetchResult<Extra>>;
}

export interface ProactiveMailReader extends ProactiveSourceReader<ProactiveMailExtra> {
  thread?:
    | ((input: {
        readonly token: string;
        readonly threadId: string;
        readonly signal: AbortSignal;
      }) => Promise<readonly ProactiveMailItem[] | undefined>)
    | undefined;
  search?:
    | ((input: {
        readonly token: string;
        readonly query: string;
        readonly limit: number;
        readonly signal: AbortSignal;
      }) => Promise<readonly ProactiveMailItem[]>)
    | undefined;
}

export interface ProactiveSourceRunner {
  readonly source: ProactiveSource;
  run(): Promise<ProactiveDecision | undefined>;
}

export interface ProactiveObservation {
  readonly source: ProactiveSource;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly trust: "owner" | "external";
  readonly provenance: {
    readonly kind: string;
    readonly author: string | null;
    readonly occurredAt: string;
  };
  readonly what: string;
  readonly contentRef: string;
  readonly insightId: string;
  readonly decisionId: string;
  readonly observedAt: string;
}

export interface ProactiveObservationPort {
  receive(observations: readonly ProactiveObservation[]): Promise<void>;
}
