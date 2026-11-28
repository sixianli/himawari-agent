import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ApplePushEnvironment,
  ApplePushSendResult,
  WebPushLocale,
} from "@himawari-agent/application";
import { readActiveAlertRegistrations } from "@himawari-agent/persistence-sqlite";
import {
  APPLE_PUSH_SECRET_PURPOSE,
  createApplePushSender,
  JsonFileConfigurationPort,
  readRestrictedPrivateKeyPem,
} from "@himawari-agent/platform-node";

export const SERVER_OUTAGE_PUSH_KIND = "server_outage";
const COLLAPSE_ID = "server-outage";
const LIFETIME_SECONDS = 24 * 3_600;
const EVENT_FILE_MAXIMUM_BYTES = 1_024;
const FAILED_CHECKS_MAXIMUM = 1_000_000;

export const SERVER_OUTAGE_TEXT = {
  "zh-CN": {
    downTitle: "Himawari 服务器没有响应",
    downBody: (failedChecks: number) =>
      `健康检查已连续 ${failedChecks} 次没有通过，恢复后会再通知你`,
    upTitle: "Himawari 服务器已恢复",
    upBody: (minutes: number) => `从第一次检查失败到恢复，约 ${minutes} 分钟`,
  },
  en: {
    downTitle: "Himawari's server is not responding",
    downBody: (failedChecks: number) =>
      `${failedChecks} health checks in a row have failed. You'll hear again when it recovers.`,
    upTitle: "Himawari's server is back",
    upBody: (minutes: number) => `About ${minutes} min from the first failed check to recovery`,
  },
  ja: {
    downTitle: "Himawari のサーバーが応答していません",
    downBody: (failedChecks: number) =>
      `ヘルスチェックが ${failedChecks} 回続けて失敗しました。復旧したらまたお知らせします`,
    upTitle: "Himawari のサーバーが復旧しました",
    upBody: (minutes: number) => `最初の失敗から復旧まで約 ${minutes} 分`,
  },
} as const satisfies Record<WebPushLocale, unknown>;

export interface ServerOutageEvent {
  readonly state: "down" | "up";
  readonly failedChecks: number;
  readonly since: string;
  readonly at: string;
}

function isoTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function parseServerOutageEvent(text: string): ServerOutageEvent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("PUSH_OUTAGE_EVENT_INVALID");
  }
  const event = value as Record<string, unknown> | null;
  if (
    !event ||
    typeof event !== "object" ||
    event["schemaVersion"] !== 1 ||
    (event["state"] !== "down" && event["state"] !== "up") ||
    !Number.isInteger(event["failedChecks"]) ||
    (event["failedChecks"] as number) < 1 ||
    (event["failedChecks"] as number) > FAILED_CHECKS_MAXIMUM ||
    !isoTime(event["since"]) ||
    !isoTime(event["at"]) ||
    Date.parse(event["since"]) > Date.parse(event["at"])
  )
    throw new Error("PUSH_OUTAGE_EVENT_INVALID");
  return Object.freeze({
    state: event["state"],
    failedChecks: event["failedChecks"] as number,
    since: event["since"],
    at: event["at"],
  });
}

export function serverOutagePayload(event: ServerOutageEvent, locale: WebPushLocale): string {
  const text = SERVER_OUTAGE_TEXT[locale];
  const minutes = Math.max(
    1,
    Math.round((Date.parse(event.at) - Date.parse(event.since)) / 60_000),
  );
  return JSON.stringify({
    aps: {
      alert:
        event.state === "down"
          ? { title: text.downTitle, body: text.downBody(event.failedChecks) }
          : { title: text.upTitle, body: text.upBody(minutes) },
      sound: "default",
      "thread-id": SERVER_OUTAGE_PUSH_KIND,
      "interruption-level": event.state === "down" ? "time-sensitive" : "active",
      category: "himawari.plain",
    },
    himawari: {
      v: 1,
      tag: COLLAPSE_ID,
      kind: SERVER_OUTAGE_PUSH_KIND,
      state: event.state,
      navigate: "/",
      actions: [],
    },
  });
}

function absoluteOption(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = index >= 0 ? arguments_[index + 1] : undefined;
  if (!value || !path.isAbsolute(value)) throw new Error("PUSH_ARGUMENT_INVALID");
  return value;
}

export async function runOutagePush(
  arguments_: readonly string[],
  options: { readonly origins?: Readonly<Record<ApplePushEnvironment, string>> } = {},
): Promise<unknown> {
  if (arguments_.length !== 8 || arguments_[1] !== "outage")
    throw new Error("PUSH_ARGUMENT_INVALID");
  const configurationPath = absoluteOption(arguments_, "--config");
  const secretDirectory = absoluteOption(arguments_, "--secret-dir");
  const eventFile = absoluteOption(arguments_, "--event-file");
  const raw = await readFile(eventFile);
  if (raw.byteLength > EVENT_FILE_MAXIMUM_BYTES) throw new Error("PUSH_OUTAGE_EVENT_INVALID");
  const event = parseServerOutageEvent(raw.toString("utf8"));
  const configuration = await new JsonFileConfigurationPort(configurationPath).load();
  const applePush = configuration.runPolicy?.applePush;
  const secret = applePush
    ? configuration.secretReferences.find(
        ({ ref, purpose }) => ref === applePush.secretRef && purpose === APPLE_PUSH_SECRET_PURPOSE,
      )
    : undefined;
  const result = (fields: Record<string, unknown>) =>
    Object.freeze({
      outputSchemaVersion: 1,
      command: "push.outage",
      state: event.state,
      ...fields,
    });
  if (!applePush || !secret) return result({ skipped: "APPLE_PUSH_NOT_CONFIGURED" });
  const registrations = readActiveAlertRegistrations(
    path.join(configuration.stateRoot, "data", "product.sqlite"),
    { ownerId: configuration.ownerId, agentId: configuration.agentId },
  ).filter(
    (registration) =>
      applePush.topics.includes(registration.topic) &&
      applePush.environments.includes(registration.environment),
  );
  if (registrations.length === 0) return result({ registrations: 0, sent: 0, failures: [] });
  const sender = createApplePushSender({
    teamId: applePush.teamId,
    keyId: applePush.keyId,
    signingKey: await readRestrictedPrivateKeyPem(secretDirectory, secret.ref, secret.version),
    requestTimeoutSeconds: applePush.requestTimeoutSeconds,
    ...(options.origins ? { origins: options.origins } : {}),
  });
  const outcomes: ApplePushSendResult[] = [];
  try {
    const expiresAtSeconds = Math.floor(Date.parse(event.at) / 1_000) + LIFETIME_SECONDS;
    for (const registration of registrations)
      outcomes.push(
        await sender.send({
          token: registration.token,
          environment: registration.environment,
          topic: registration.topic,
          pushType: "alert",
          priority: 10,
          expiresAtSeconds,
          collapseId: COLLAPSE_ID,
          payload: serverOutagePayload(event, registration.locale),
        }),
      );
  } finally {
    sender.close();
  }
  const sent = outcomes.filter((outcome) => outcome.kind === "sent").length;
  const failures = outcomes.flatMap((outcome) => (outcome.kind === "sent" ? [] : [outcome.code]));
  if (
    sent === 0 &&
    outcomes.some((outcome) => outcome.kind === "retry" || outcome.kind === "rate_limited")
  )
    throw new Error("PUSH_OUTAGE_RETRY");
  return result({ registrations: registrations.length, sent, failures });
}
