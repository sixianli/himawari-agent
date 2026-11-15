import { createHash, randomBytes } from "node:crypto";
import {
  APPLE_PUSH_ACTIVITY_REF_PATTERN,
  APPLE_PUSH_ENVIRONMENTS,
  APPLE_PUSH_TOKEN_PATTERN,
  APPLE_PUSH_TOPIC_PATTERN,
  APPLE_PUSH_TYPES,
  type ApplePushConfiguration,
  type ApplePushEnvironment,
  type ApplePushStorePort,
  type ApplePushType,
  NOTIFICATION_ACTIONS,
  type NotificationActionToken,
  type PairedDevice,
  type PairedDeviceScope,
  WEB_PUSH_LOCALES,
  WEB_PUSH_REACTIONS,
  type WebPushLocale,
  type WebPushReaction,
  type WebPushStorePort,
} from "@himawari-agent/application";

export const DEVICE_PUSH_ERROR_CODES = Object.freeze({
  REQUEST_INVALID: "DEVICE_PUSH_REQUEST_INVALID",
  NOT_CONFIGURED: "DEVICE_PUSH_NOT_CONFIGURED",
  TOPIC_NOT_ALLOWED: "DEVICE_PUSH_TOPIC_NOT_ALLOWED",
  ACTION_INVALID: "NOTIFICATION_ACTION_INVALID",
  ACTION_CONFIRM_REQUIRED: "NOTIFICATION_ACTION_CONFIRM_REQUIRED",
  COMPANION_INVALID: "DEVICE_COMPANION_INVALID",
  COMPANION_LINKED_ELSEWHERE: "DEVICE_COMPANION_LINKED_ELSEWHERE",
} as const);

export type DevicePushErrorCode =
  (typeof DEVICE_PUSH_ERROR_CODES)[keyof typeof DEVICE_PUSH_ERROR_CODES];

export class DevicePushError extends Error {
  readonly code: DevicePushErrorCode;
  readonly statusCode: number;

  constructor(code: DevicePushErrorCode, statusCode: number) {
    super(code);
    this.name = "DevicePushError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const NOTIFICATION_ACTION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const DEVICE_FEEDBACK_MAXIMUM_REACTIONS = 50;
const FEEDBACK_TAG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{22}$/u;

export interface DevicePushRegistrationView {
  readonly id: string;
  readonly pushType: ApplePushType;
  readonly activityRef: string;
  readonly environment: ApplePushEnvironment;
  readonly topic: string;
  readonly status: "active" | "disabled";
}

export interface DevicePushPort {
  register(input: {
    readonly scope: PairedDeviceScope;
    readonly device: PairedDevice;
    readonly body: Record<string, unknown>;
  }): Promise<{ readonly registration: DevicePushRegistrationView | null }>;
  takeAction(input: {
    readonly device: PairedDevice;
    readonly confirmed: boolean;
    readonly body: Record<string, unknown>;
  }): Promise<NotificationActionToken>;
  feedback(input: {
    readonly scope: PairedDeviceScope;
    readonly body: Record<string, unknown>;
  }): Promise<{ readonly recorded: number }>;
  linkCompanion(input: {
    readonly scope: PairedDeviceScope;
    readonly device: PairedDevice;
    readonly body: Record<string, unknown>;
  }): Promise<{ readonly linked: boolean }>;
  streamOpened(deviceId: string): void;
  streamAlive(deviceId: string): void;
  streamClosed(deviceId: string): void;
}

export interface DevicePushServiceOptions {
  readonly store: ApplePushStorePort;
  readonly reactions: Pick<WebPushStorePort, "recordReactions">;
  readonly configuration: () => ApplePushConfiguration | undefined;
  readonly now: () => Date;
  readonly onPresence?: (deviceId: string, visible: boolean, now: string) => void;
  readonly onRegistered?: (deviceId: string, pushType: ApplePushType) => void;
  readonly randomBytes?: (size: number) => Buffer;
}

function invalid(): never {
  throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.REQUEST_INVALID, 400);
}

function onlyKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(body).some((key) => !keys.includes(key))) invalid();
}

export function notificationActionHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class DevicePushService implements DevicePushPort {
  readonly #options: DevicePushServiceOptions;
  readonly #openStreams = new Map<string, number>();

  constructor(options: DevicePushServiceOptions) {
    this.#options = options;
  }

  async register(
    input: Parameters<DevicePushPort["register"]>[0],
  ): Promise<{ readonly registration: DevicePushRegistrationView | null }> {
    const { body, scope, device } = input;
    onlyKeys(body, ["pushType", "activityRef", "token", "environment", "topic", "locale"]);
    const pushType = body["pushType"];
    if (typeof pushType !== "string" || !(APPLE_PUSH_TYPES as readonly string[]).includes(pushType))
      invalid();
    const activityRef = body["activityRef"] ?? "";
    if (
      typeof activityRef !== "string" ||
      (pushType === "liveactivity"
        ? activityRef !== "" && !APPLE_PUSH_ACTIVITY_REF_PATTERN.test(activityRef)
        : activityRef !== "")
    )
      invalid();
    const key = {
      ...scope,
      deviceId: device.id,
      pushType: pushType as ApplePushType,
      activityRef: activityRef as string,
    };
    if (body["token"] === null) {
      onlyKeys(body, ["pushType", "activityRef", "token"]);
      await this.#options.store.removeRegistration(key);
      return { registration: null };
    }
    const configuration = this.#options.configuration();
    if (!configuration) throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.NOT_CONFIGURED, 503);
    const { token, environment, topic, locale } = body;
    if (
      typeof token !== "string" ||
      !APPLE_PUSH_TOKEN_PATTERN.test(token) ||
      typeof environment !== "string" ||
      !(APPLE_PUSH_ENVIRONMENTS as readonly string[]).includes(environment) ||
      typeof topic !== "string" ||
      !APPLE_PUSH_TOPIC_PATTERN.test(topic) ||
      typeof locale !== "string" ||
      !(WEB_PUSH_LOCALES as readonly string[]).includes(locale)
    )
      invalid();
    if (
      !configuration.topics.includes(topic as string) ||
      !configuration.environments.includes(environment as ApplePushEnvironment)
    )
      throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.TOPIC_NOT_ALLOWED, 403);
    const saved = await this.#options.store.saveRegistration({
      ...key,
      id: `apn_${(this.#options.randomBytes ?? randomBytes)(16).toString("base64url")}`,
      token: token as string,
      environment: environment as ApplePushEnvironment,
      topic: topic as string,
      locale: locale as WebPushLocale,
      activityLimit: configuration.liveActivityRegistrationsPerDevice,
      now: this.#options.now().toISOString(),
    });
    this.#options.onRegistered?.(device.id, saved.pushType);
    return {
      registration: {
        id: saved.id,
        pushType: saved.pushType,
        activityRef: saved.activityRef,
        environment: saved.environment,
        topic: saved.topic,
        status: saved.status,
      },
    };
  }

  async takeAction(
    input: Parameters<DevicePushPort["takeAction"]>[0],
  ): Promise<NotificationActionToken> {
    onlyKeys(input.body, ["token"]);
    const token = input.body["token"];
    if (typeof token !== "string" || !NOTIFICATION_ACTION_TOKEN_PATTERN.test(token)) invalid();
    const request = {
      tokenHash: notificationActionHash(token as string),
      deviceId: input.device.id,
      now: this.#options.now().toISOString(),
    };
    const read = await this.#options.store.readActionToken(request);
    if (
      read.kind === "rejected" ||
      read.token.approval === null ||
      !(NOTIFICATION_ACTIONS as readonly string[]).includes(read.token.action)
    )
      throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.ACTION_INVALID, 410);
    if (read.token.action === "approve" && read.token.ownerPresence && !input.confirmed)
      throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.ACTION_CONFIRM_REQUIRED, 403);
    const consumed = await this.#options.store.consumeActionToken(request);
    if (consumed.kind === "rejected")
      throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.ACTION_INVALID, 410);
    return consumed.token;
  }

  async feedback(
    input: Parameters<DevicePushPort["feedback"]>[0],
  ): Promise<{ readonly recorded: number }> {
    onlyKeys(input.body, ["reactions"]);
    const reactions = input.body["reactions"];
    if (
      !Array.isArray(reactions) ||
      reactions.length === 0 ||
      reactions.length > DEVICE_FEEDBACK_MAXIMUM_REACTIONS
    )
      invalid();
    const now = this.#options.now().toISOString();
    const events = (reactions as unknown[]).map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid();
      const event = entry as Record<string, unknown>;
      onlyKeys(event, ["tag", "reaction", "occurredAt"]);
      const { tag, reaction, occurredAt } = event;
      if (
        typeof tag !== "string" ||
        !FEEDBACK_TAG_PATTERN.test(tag) ||
        typeof reaction !== "string" ||
        !(WEB_PUSH_REACTIONS as readonly string[]).includes(reaction) ||
        typeof occurredAt !== "string" ||
        !Number.isFinite(Date.parse(occurredAt)) ||
        new Date(occurredAt).toISOString() !== occurredAt
      )
        invalid();
      return {
        tag: tag as string,
        reaction: reaction as WebPushReaction,
        occurredAt: occurredAt as string,
      };
    });
    return {
      recorded: await this.#options.reactions.recordReactions({
        ...input.scope,
        reactions: events,
        now,
      }),
    };
  }

  async linkCompanion(
    input: Parameters<DevicePushPort["linkCompanion"]>[0],
  ): Promise<{ readonly linked: boolean }> {
    onlyKeys(input.body, ["watchDeviceId"]);
    const watchDeviceId = input.body["watchDeviceId"];
    if (typeof watchDeviceId !== "string" || !DEVICE_ID_PATTERN.test(watchDeviceId)) invalid();
    if (input.device.kind !== "iphone")
      throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.COMPANION_INVALID, 409);
    const result = await this.#options.store.setCompanion({
      ...input.scope,
      deviceId: watchDeviceId as string,
      companionOf: input.device.id,
    });
    if (result === "linked") return { linked: true };
    if (result === "already_linked") return { linked: false };
    if (result === "linked_elsewhere")
      throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.COMPANION_LINKED_ELSEWHERE, 409);
    throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.COMPANION_INVALID, 409);
  }

  streamOpened(deviceId: string): void {
    this.#openStreams.set(deviceId, (this.#openStreams.get(deviceId) ?? 0) + 1);
    this.#presence(deviceId, true);
  }

  streamAlive(deviceId: string): void {
    if (this.#openStreams.has(deviceId)) this.#presence(deviceId, true);
  }

  streamClosed(deviceId: string): void {
    const remaining = (this.#openStreams.get(deviceId) ?? 0) - 1;
    if (remaining > 0) {
      this.#openStreams.set(deviceId, remaining);
      return;
    }
    this.#openStreams.delete(deviceId);
    this.#presence(deviceId, false);
  }

  #presence(deviceId: string, visible: boolean): void {
    this.#options.onPresence?.(deviceId, visible, this.#options.now().toISOString());
  }
}
