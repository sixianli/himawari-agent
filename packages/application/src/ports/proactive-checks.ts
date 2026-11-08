import type { AgentId, OwnerId } from "@himawari-agent/domain";

export type ProactiveSource = "gmail";
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
  readonly importantSenders: readonly string[];
  readonly updatedAt: string | null;
}

export interface ProactiveSourceItem {
  readonly source: ProactiveSource;
  readonly messageId: string;
  readonly threadId: string;
  readonly from: string;
  readonly fromAddress: string;
  readonly subject: string;
  readonly snippet: string;
  readonly link: string;
  readonly receivedAt: string;
  readonly categories: readonly string[];
  readonly sentByOwner: boolean;
  readonly body: string | null;
  readonly bodyTruncated: boolean;
  readonly bodyUnavailable: boolean;
  readonly attachments: readonly ProactiveMailAttachment[];
}

export interface ProactiveMailAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
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

export interface ProactiveCheckInputs {
  readonly ruleIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly floorHits: Readonly<Record<string, readonly string[]>>;
  readonly memoryInjected: boolean;
  readonly memoryIds: readonly string[];
  readonly usedMemoryIds: readonly string[];
  readonly tentativeMemoryIds?: readonly string[];
  readonly memoryByMail: Readonly<Record<string, readonly string[]>>;
  readonly memoryRecall: ProactiveMemoryRecallStatus;
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
}

export interface ProactiveRecordResult {
  readonly insightIds: readonly string[];
  readonly releasedRefs: readonly string[];
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
  clearRecords(input: ProactiveScope): Promise<readonly string[]>;
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
}

export interface ProactiveSealPort {
  seal(input: ProactiveScope & { readonly text: string; readonly at: string }): Promise<string>;
  open(input: ProactiveScope & { readonly ref: string }): Promise<string | undefined>;
  release(input: ProactiveScope & { readonly refs: readonly string[] }): Promise<void>;
}

export type ProactiveFetchResult =
  | {
      readonly kind: "items";
      readonly items: readonly ProactiveSourceItem[];
      readonly cursor: string | null;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "failed"; readonly step: string };

export interface ProactiveSourceReader {
  readonly source: ProactiveSource;
  fetch(input: {
    readonly token: string;
    readonly cursor: string | null;
    readonly since: string;
    readonly signal: AbortSignal;
    readonly unseen: (messageIds: readonly string[]) => Promise<readonly string[]>;
  }): Promise<ProactiveFetchResult>;
}
