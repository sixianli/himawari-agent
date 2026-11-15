import type { AgentId, OwnerId } from "@himawari-agent/domain";

export const WEB_PUSH_LOCALES = ["zh-CN", "en", "ja"] as const;
export type WebPushLocale = (typeof WEB_PUSH_LOCALES)[number];
export type WebPushKind = "reminder" | "approval" | "run";
export type WebPushAttemptStatus =
  | "pending"
  | "sent"
  | "suppressed"
  | "expired"
  | "gone"
  | "failed";

export interface WebPushScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface WebPushSubscription extends WebPushScope {
  readonly id: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly locale: WebPushLocale;
  readonly deviceLabel: string;
  readonly state: "active" | "paused";
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastDeliveredAt: string | null;
}

export interface WebPushOutboxItem extends WebPushScope {
  readonly sourceKey: string;
  readonly kind: WebPushKind;
  readonly sourceRef: string;
  readonly threadId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly deferUntil?: string | null;
  readonly deferredByTiming?: boolean;
}

export interface WebPushAttempt {
  readonly sourceKey: string;
  readonly subscriptionId: string;
  readonly status: WebPushAttemptStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastCode: string | null;
  readonly updatedAt: string;
}

export const WEB_PUSH_REACTIONS = ["opened", "dismissed"] as const;
export type WebPushReaction = (typeof WEB_PUSH_REACTIONS)[number];

export interface WebPushReactionEvent {
  readonly tag: string;
  readonly reaction: WebPushReaction;
  readonly occurredAt: string;
}

export interface WebPushFeedback {
  readonly sourceKey: string;
  readonly tag: string;
  readonly kind: WebPushKind;
  readonly sourceRef: string;
  readonly threadId: string | null;
  readonly channel: "web_push";
  readonly firstSentAt: string;
  readonly devices: number;
  readonly openedAt: string | null;
  readonly dismissedAt: string | null;
}

export interface WebPushDue {
  readonly item: WebPushOutboxItem;
  readonly subscription: WebPushSubscription;
  readonly attempt: WebPushAttempt | null;
}

export interface WebPushFinishedRun {
  readonly runId: string;
  readonly threadId: string;
  readonly status: "completed" | "failed";
  readonly resultUnconfirmed: boolean;
  readonly finishedAt: string;
  readonly cursor: string;
}

export interface WebPushStorePort {
  saveSubscription(
    input: WebPushScope & {
      readonly id: string;
      readonly endpoint: string;
      readonly p256dh: string;
      readonly auth: string;
      readonly locale: WebPushLocale;
      readonly deviceLabel: string;
      readonly now: string;
    },
  ): Promise<WebPushSubscription>;
  readKinds(input: WebPushScope): Promise<readonly WebPushKind[]>;
  setKind(
    input: WebPushScope & {
      readonly kind: WebPushKind;
      readonly enabled: boolean;
      readonly now: string;
    },
  ): Promise<readonly WebPushKind[]>;
  writeKinds(
    input: WebPushScope & { readonly kinds: readonly WebPushKind[]; readonly now: string },
  ): Promise<readonly WebPushKind[]>;
  removeSubscription(input: WebPushScope & { readonly subscriptionId: string }): Promise<boolean>;
  listSubscriptions(input: WebPushScope): Promise<readonly WebPushSubscription[]>;
  markSubscription(
    input: WebPushScope & {
      readonly subscriptionId: string;
      readonly state: WebPushSubscription["state"];
      readonly failureCode: string | null;
      readonly deliveredAt: string | null;
      readonly now: string;
    },
  ): Promise<void>;
  readCursor(input: WebPushScope & { readonly source: "finished-runs" }): Promise<string | null>;
  enqueue(
    input: WebPushScope & {
      readonly items: readonly WebPushOutboxItem[];
      readonly cursor: { readonly source: "finished-runs"; readonly value: string } | null;
      readonly now: string;
    },
  ): Promise<number>;
  listDue(
    input: WebPushScope & { readonly now: string; readonly limit: number },
  ): Promise<readonly WebPushDue[]>;
  listRecent(
    input: WebPushScope & { readonly since: string; readonly limit: number },
  ): Promise<readonly WebPushOutboxItem[]>;
  deferItem(
    input: WebPushScope & {
      readonly sourceKey: string;
      readonly deferUntil: string;
      readonly expiresAt: string;
      readonly ruleRefs: readonly string[];
      readonly now: string;
    },
  ): Promise<boolean>;
  recordDeliveryTiming(
    input: WebPushScope & {
      readonly sourceKey: string;
      readonly outcome: "delivered" | "deferred" | "deadline_reached";
      readonly reasonCode: string;
      readonly deferUntil: string | null;
      readonly expiresAt: string | null;
      readonly costMicros: number;
      readonly now: string;
    },
  ): Promise<boolean>;
  recordAttempt(
    input: WebPushScope & {
      readonly sourceKey: string;
      readonly subscriptionId: string;
      readonly status: WebPushAttemptStatus;
      readonly attempts: number;
      readonly nextAttemptAt: string | null;
      readonly lastCode: string | null;
      readonly tag: string;
      readonly now: string;
    },
  ): Promise<boolean>;
  recordReactions(
    input: WebPushScope & {
      readonly reactions: readonly WebPushReactionEvent[];
      readonly now: string;
    },
  ): Promise<number>;
  listFeedback(
    input: WebPushScope & { readonly sentFrom: string; readonly limit: number },
  ): Promise<readonly WebPushFeedback[]>;
  listFinishedRuns(
    input: WebPushScope & { readonly afterCursor: string; readonly limit: number },
  ): Promise<readonly WebPushFinishedRun[]>;
  prune(
    input: WebPushScope & { readonly expiredBefore: string; readonly limit: number },
  ): Promise<number>;
}

export interface WebPushSendRequest {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly payload: string;
  readonly ttlSeconds: number;
  readonly urgency: "normal" | "high";
  readonly topic: string;
}

export type WebPushSendResult =
  | { readonly kind: "sent" }
  | { readonly kind: "gone"; readonly code: string }
  | {
      readonly kind: "rate_limited";
      readonly code: string;
      readonly retryAfterSeconds: number | null;
    }
  | { readonly kind: "retry"; readonly code: string }
  | { readonly kind: "rejected"; readonly code: string }
  | { readonly kind: "too_large"; readonly code: string };

export interface WebPushSenderPort {
  readonly publicKey: string;
  send(request: WebPushSendRequest): Promise<WebPushSendResult>;
}
