import type { PairedDeviceScope } from "./paired-devices.js";
import type {
  WebPushAttempt,
  WebPushAttemptStatus,
  WebPushLocale,
  WebPushOutboxItem,
} from "./web-push.js";

export const APPLE_PUSH_TYPES = ["alert", "widgets", "liveactivity"] as const;
export type ApplePushType = (typeof APPLE_PUSH_TYPES)[number];

export const APPLE_PUSH_ENVIRONMENTS = ["development", "production"] as const;
export type ApplePushEnvironment = (typeof APPLE_PUSH_ENVIRONMENTS)[number];

export const PUSH_CHANNELS = ["web_push", "apns"] as const;
export type PushChannel = (typeof PUSH_CHANNELS)[number];

export const NOTIFICATION_ACTIONS = ["approve", "deny"] as const;
export type NotificationAction = (typeof NOTIFICATION_ACTIONS)[number];

export const APPLE_PUSH_TOKEN_PATTERN = /^(?:[0-9a-f]{2}){1,256}$/u;
export const APPLE_PUSH_TOPIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,231}$/u;
export const APPLE_PUSH_ACTIVITY_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface ApplePushConfiguration {
  readonly teamId: string;
  readonly keyId: string;
  readonly secretRef: string;
  readonly topics: readonly string[];
  readonly environments: readonly ApplePushEnvironment[];
  readonly widgetRefreshMinimumSeconds: number;
  readonly liveActivityUpdateMinimumSeconds: number;
  readonly liveActivityStartAfterSeconds: number;
  readonly liveActivityStaleAfterSeconds: number;
  readonly actionTokenLifetimeSeconds: number;
  readonly requestTimeoutSeconds: number;
  readonly liveActivityRegistrationsPerDevice: number;
}

export const APPLE_PUSH_CONFIGURATION_DEFAULTS = Object.freeze({
  widgetRefreshMinimumSeconds: 900,
  liveActivityUpdateMinimumSeconds: 15,
  liveActivityStartAfterSeconds: 30,
  liveActivityStaleAfterSeconds: 600,
  actionTokenLifetimeSeconds: 86_400,
  requestTimeoutSeconds: 10,
  liveActivityRegistrationsPerDevice: 8,
} as const);

export const APPLE_PUSH_CONFIGURATION_BOUNDS = Object.freeze({
  widgetRefreshMinimumSeconds: { minimum: 1, maximum: 86_400 },
  liveActivityUpdateMinimumSeconds: { minimum: 1, maximum: 3_600 },
  liveActivityStartAfterSeconds: { minimum: 0, maximum: 3_600 },
  liveActivityStaleAfterSeconds: { minimum: 30, maximum: 86_400 },
  actionTokenLifetimeSeconds: { minimum: 60, maximum: 30 * 86_400 },
  requestTimeoutSeconds: { minimum: 1, maximum: 120 },
  liveActivityRegistrationsPerDevice: { minimum: 1, maximum: 64 },
} as const);

export interface ApplePushRegistration extends PairedDeviceScope {
  readonly id: string;
  readonly deviceId: string;
  readonly pushType: ApplePushType;
  readonly activityRef: string;
  readonly token: string;
  readonly environment: ApplePushEnvironment;
  readonly topic: string;
  readonly locale: WebPushLocale;
  readonly status: "active" | "disabled";
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastDeliveredAt: string | null;
}

export interface ApplePushDue {
  readonly item: WebPushOutboxItem;
  readonly registration: ApplePushRegistration;
  readonly attempt: WebPushAttempt | null;
}

export const APPLE_LIVE_ACTIVITY_ATTRIBUTES_TYPE = "RunProgressAttributes";

export const APPLE_LIVE_ACTIVITY_PHASES = [
  "preparing",
  "working",
  "waiting_for_owner",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AppleLiveActivityPhase = (typeof APPLE_LIVE_ACTIVITY_PHASES)[number];

export interface ApplePushActivityRun {
  readonly runId: string;
  readonly threadId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NotificationActionTokenInput {
  readonly tokenHash: string;
  readonly action: NotificationAction;
  readonly ownerPresence: boolean;
  readonly approval: {
    readonly requestId: string;
    readonly revision: number;
    readonly snapshotHash: string;
  } | null;
}

export interface NotificationActionToken extends PairedDeviceScope {
  readonly tokenHash: string;
  readonly deviceId: string;
  readonly sourceKey: string;
  readonly action: NotificationAction;
  readonly ownerPresence: boolean;
  readonly approval: NotificationActionTokenInput["approval"];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
}

export type NotificationActionTokenRejection =
  | "unknown"
  | "expired"
  | "used"
  | "other_device"
  | "device_inactive";

export type NotificationActionTokenResult =
  | { readonly kind: "accepted"; readonly token: NotificationActionToken }
  | { readonly kind: "rejected"; readonly reason: NotificationActionTokenRejection };

export interface ApplePushStorePort {
  saveRegistration(
    input: PairedDeviceScope & {
      readonly id: string;
      readonly deviceId: string;
      readonly pushType: ApplePushType;
      readonly activityRef: string;
      readonly token: string;
      readonly environment: ApplePushEnvironment;
      readonly topic: string;
      readonly locale: WebPushLocale;
      readonly activityLimit: number;
      readonly now: string;
    },
  ): Promise<ApplePushRegistration>;
  removeRegistration(
    input: PairedDeviceScope & {
      readonly deviceId: string;
      readonly pushType: ApplePushType;
      readonly activityRef: string;
    },
  ): Promise<boolean>;
  listRegistrations(
    input: PairedDeviceScope & {
      readonly pushType: ApplePushType;
      readonly activityRef?: string;
      readonly deviceId?: string;
    },
  ): Promise<readonly ApplePushRegistration[]>;
  markRegistration(
    input: PairedDeviceScope & {
      readonly registrationId: string;
      readonly status: ApplePushRegistration["status"];
      readonly failureCode: string | null;
      readonly deliveredAt: string | null;
      readonly now: string;
    },
  ): Promise<void>;
  routeOutbox(input: PairedDeviceScope & { readonly now: string }): Promise<number>;
  listDue(
    input: PairedDeviceScope & { readonly now: string; readonly limit: number },
  ): Promise<readonly ApplePushDue[]>;
  recordAttempt(
    input: PairedDeviceScope & {
      readonly sourceKey: string;
      readonly registrationId: string;
      readonly status: WebPushAttemptStatus;
      readonly attempts: number;
      readonly nextAttemptAt: string | null;
      readonly lastCode: string | null;
      readonly tag: string;
      readonly now: string;
    },
  ): Promise<boolean>;
  issueActionTokens(
    input: PairedDeviceScope & {
      readonly deviceId: string;
      readonly sourceKey: string;
      readonly tokens: readonly NotificationActionTokenInput[];
      readonly now: string;
      readonly expiresAt: string;
    },
  ): Promise<void>;
  readActionToken(input: {
    readonly tokenHash: string;
    readonly deviceId: string;
    readonly now: string;
  }): Promise<NotificationActionTokenResult>;
  consumeActionToken(input: {
    readonly tokenHash: string;
    readonly deviceId: string;
    readonly now: string;
  }): Promise<NotificationActionTokenResult>;
  setCompanion(
    input: PairedDeviceScope & {
      readonly deviceId: string;
      readonly companionOf: string;
    },
  ): Promise<"linked" | "already_linked" | "not_found" | "not_a_watch" | "linked_elsewhere">;
  listActivityRuns(
    input: PairedDeviceScope & {
      readonly createdAfter: string;
      readonly createdBefore: string;
      readonly limit: number;
    },
  ): Promise<readonly ApplePushActivityRun[]>;
  readActivityRuns(
    input: PairedDeviceScope & { readonly runIds: readonly string[] },
  ): Promise<readonly ApplePushActivityRun[]>;
  prune(
    input: PairedDeviceScope & { readonly expiredBefore: string; readonly limit: number },
  ): Promise<number>;
}

export interface ApplePushSendRequest {
  readonly token: string;
  readonly environment: ApplePushEnvironment;
  readonly topic: string;
  readonly pushType: ApplePushType | "background";
  readonly priority: 5 | 10;
  readonly expiresAtSeconds: number;
  readonly collapseId: string | null;
  readonly payload: string;
}

export type ApplePushSendResult =
  | { readonly kind: "sent" }
  | { readonly kind: "gone"; readonly code: string }
  | { readonly kind: "rate_limited"; readonly code: string }
  | { readonly kind: "retry"; readonly code: string }
  | { readonly kind: "rejected"; readonly code: string }
  | { readonly kind: "too_large"; readonly code: string };

export interface ApplePushSenderPort {
  send(request: ApplePushSendRequest): Promise<ApplePushSendResult>;
}
