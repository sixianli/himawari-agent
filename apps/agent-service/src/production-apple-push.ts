import { createHash, randomBytes } from "node:crypto";
import {
  APPLE_LIVE_ACTIVITY_ATTRIBUTES_TYPE,
  type AppleLiveActivityPhase,
  type ApplePushActivityRun,
  type ApplePushConfiguration,
  type ApplePushDue,
  type ApplePushRegistration,
  type ApplePushSenderPort,
  type ApplePushSendResult,
  type ApplePushStorePort,
  type ApprovalRequest,
  type MemoryReminder,
  type NotificationAction,
  type NotificationActionTokenInput,
  type PairedDeviceScope,
  type WebPushLocale,
  type WebPushOutboxItem,
} from "@himawari-agent/application";
import { notificationActionHash } from "@himawari-agent/platform-node";
import {
  type PushCompanionChannel,
  type PushContent,
  webPushTopic,
} from "./production-web-push.js";

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
const RATE_LIMIT_DELAY_MS = 60_000;
const SEND_BATCH = 50;
const PAYLOAD_BYTES = 4_096;
const WIDGET_EXPIRY_SECONDS = 3_600;
const ACTIVITY_BATCH = 20;
const ACTIVITY_READ_BATCH = 500;
const TOKEN_PRUNE_AFTER_MS = 7 * 24 * 3_600_000;
const TERMINAL_PHASES: ReadonlySet<AppleLiveActivityPhase> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const APPLE_PUSH_TEXT = {
  "zh-CN": {
    approve: "同意",
    deny: "不同意",
    approveInApp: "看内容再定",
    progress: "Himawari 正在处理",
    untitled: "新对话",
  },
  en: {
    approve: "Approve",
    deny: "Decline",
    approveInApp: "Review to approve",
    progress: "Himawari is working",
    untitled: "New chat",
  },
  ja: {
    approve: "承認",
    deny: "承認しない",
    approveInApp: "内容を見て決める",
    progress: "Himawari が処理しています",
    untitled: "新しいチャット",
  },
} as const satisfies Record<WebPushLocale, unknown>;

export interface ApplePushAction {
  readonly action: NotificationAction;
  readonly label: string;
  readonly labelBasis: "catalog" | "model";
  readonly polarity: "positive" | "negative";
  readonly token: string;
  readonly ownerPresence: boolean;
}

function clip(text: string, bytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= bytes) return text;
  let result = "";
  for (const character of text) {
    if (Buffer.byteLength(`${result}${character}…`, "utf8") > bytes) break;
    result += character;
  }
  return `${result}…`;
}

export function applePushAlertPayload(input: {
  readonly title: string;
  readonly body: string;
  readonly navigate: string;
  readonly tag: string;
  readonly kind: WebPushOutboxItem["kind"];
  readonly badge?: number | undefined;
  readonly actions: readonly ApplePushAction[];
}): string {
  const build = (title: string, body: string) =>
    JSON.stringify({
      aps: {
        alert: { title, body },
        sound: "default",
        ...(input.badge === undefined ? {} : { badge: input.badge }),
        "thread-id": input.kind,
        "mutable-content": 1,
        "interruption-level": input.kind === "approval" ? "time-sensitive" : "active",
        category: input.actions.length > 0 ? "himawari.actions" : "himawari.plain",
      },
      himawari: {
        v: 1,
        tag: input.tag,
        kind: input.kind,
        navigate: input.navigate,
        actions: input.actions,
      },
    });
  const excess = (title: string, body: string) =>
    Buffer.byteLength(build(title, body), "utf8") - PAYLOAD_BYTES;
  const shorten = (text: string, overflow: number) =>
    clip(text, Math.max(0, Buffer.byteLength(text, "utf8") - overflow - 8));
  const bodyOverflow = excess(input.title, input.body);
  if (bodyOverflow <= 0) return build(input.title, input.body);
  const body = shorten(input.body, bodyOverflow);
  const titleOverflow = excess(input.title, body);
  if (titleOverflow <= 0) return build(input.title, body);
  return build(shorten(input.title, titleOverflow), body);
}

export function liveActivityPhase(status: string): AppleLiveActivityPhase {
  if (status === "completed" || status === "failed" || status === "cancelled") return status;
  if (status === "awaiting_approval") return "waiting_for_owner";
  if (status === "accepted" || status === "building_context") return "preparing";
  return "working";
}

export interface ProductionApplePushOptions extends PairedDeviceScope {
  readonly store: ApplePushStorePort;
  readonly sender: ApplePushSenderPort;
  readonly configuration: () => ApplePushConfiguration;
  readonly threadTitle: (threadId: string) => Promise<{ readonly title: string | null } | null>;
  readonly publicOrigin: string;
  readonly now: () => string;
  readonly randomBytes?: (size: number) => Buffer;
  readonly approvalCopy?: (input: {
    readonly approvalRequestId: string;
    readonly semanticSnapshotHash: string;
    readonly locale: WebPushLocale;
  }) => Promise<{ readonly sentence: string | null; readonly affirmLabel: string | null }>;
  readonly onDelivery?: (outcome: {
    readonly pushType: string;
    readonly kind: string;
    readonly code?: string;
  }) => void;
  readonly onFailure: (error: unknown) => void;
}

export class ProductionApplePush implements PushCompanionChannel {
  readonly #options: ProductionApplePushOptions;
  readonly #startedAt: string;
  readonly #widgetSentAt = new Map<string, number>();
  readonly #widgetDirty = new Set<string>();
  readonly #activityStarts = new Map<
    string,
    { readonly attempts: number; readonly notBefore: number }
  >();
  readonly #activitySent = new Map<string, { readonly phase: string; readonly at: number }>();
  readonly #activityRetries = new Map<
    string,
    { readonly phase: string; readonly attempts: number; readonly notBefore: number }
  >();
  #widgetsDirtyForAll = true;
  #homeDigest: string | undefined;

  constructor(options: ProductionApplePushOptions) {
    this.#options = options;
    this.#startedAt = options.now();
  }

  #scope(): PairedDeviceScope {
    return { ownerId: this.#options.ownerId, agentId: this.#options.agentId };
  }

  #configured(registration: ApplePushRegistration): boolean {
    const configuration = this.#options.configuration();
    return (
      configuration.topics.includes(registration.topic) &&
      configuration.environments.includes(registration.environment)
    );
  }

  requestWidgetRefresh(): void {
    this.#widgetsDirtyForAll = true;
  }

  async prepareWipe(deviceId: string): Promise<() => Promise<void>> {
    const registrations = (
      await this.#options.store.listRegistrations({
        ...this.#scope(),
        pushType: "alert",
        deviceId,
      })
    ).filter((registration) => this.#configured(registration));
    return async () => {
      const now = this.#options.now();
      for (const registration of registrations)
        await this.#transmit("background", "wipe", {
          token: registration.token,
          environment: registration.environment,
          topic: registration.topic,
          pushType: "background",
          priority: 5,
          expiresAtSeconds: Math.floor(Date.parse(now) / 1_000) + 30 * 86_400,
          collapseId: null,
          payload: JSON.stringify({
            aps: { "content-available": 1 },
            himawari: { v: 1, command: "wipe_local_data", deviceId },
          }),
        });
    };
  }

  async #transmit(
    pushType: string,
    kind: string,
    request: Parameters<ApplePushSenderPort["send"]>[0],
  ): Promise<ApplePushSendResult> {
    let result: ApplePushSendResult;
    try {
      result = await this.#options.sender.send(request);
    } catch (error) {
      this.#options.onFailure(error);
      result = { kind: "retry", code: "APNS_NETWORK" };
    }
    this.#options.onDelivery?.({
      pushType,
      kind: `${kind}.${result.kind}`,
      ...("code" in result ? { code: result.code } : {}),
    });
    return result;
  }

  async #applyRegistrationOutcome(
    registration: ApplePushRegistration,
    result: ApplePushSendResult,
    now: string,
  ): Promise<void> {
    if (result.kind === "sent")
      await this.#options.store.markRegistration({
        ...this.#scope(),
        registrationId: registration.id,
        status: "active",
        failureCode: null,
        deliveredAt: now,
        now,
      });
    else if (result.kind === "gone")
      await this.#options.store.markRegistration({
        ...this.#scope(),
        registrationId: registration.id,
        status: "disabled",
        failureCode: result.code,
        deliveredAt: null,
        now,
      });
  }

  async deliver(input: Parameters<PushCompanionChannel["deliver"]>[0]): Promise<void> {
    const { store } = this.#options;
    const { now } = input;
    await store.routeOutbox({ ...this.#scope(), now });
    const due = await store.listDue({ ...this.#scope(), now, limit: SEND_BATCH });
    for (const entry of due) {
      const { item } = entry;
      if (Date.parse(now) >= Date.parse(item.expiresAt)) {
        await this.#record(entry, now, "expired", null);
        continue;
      }
      if (!input.kinds.includes(item.kind)) {
        await this.#record(entry, now, "suppressed", "PUSH_KIND_OFF");
        continue;
      }
      const content = await input.content(item);
      if (content.expired) {
        await this.#record(entry, now, "expired", null);
        continue;
      }
      if (await input.deferred(item)) continue;
      if (input.visible) {
        await this.#record(entry, now, "suppressed", null);
        continue;
      }
      if (!this.#configured(entry.registration)) {
        await this.#record(entry, now, "failed", "APNS_TOPIC_NOT_CONFIGURED", 1);
        continue;
      }
      await this.#sendAlert(
        entry,
        now,
        content,
        await input.badge(),
        input.accountLocale ?? entry.registration.locale,
        input.approvals,
      );
    }
    await store.routeOutbox({ ...this.#scope(), now });
    await store.prune({
      ...this.#scope(),
      expiredBefore: new Date(Date.parse(now) - TOKEN_PRUNE_AFTER_MS).toISOString(),
      limit: 200,
    });
  }

  async #approvalCopy(
    approval: ApprovalRequest,
    locale: WebPushLocale,
  ): Promise<{ readonly sentence: string | null; readonly affirmLabel: string | null } | null> {
    const read = this.#options.approvalCopy;
    if (!read) return null;
    try {
      return await read({
        approvalRequestId: approval.id,
        semanticSnapshotHash: approval.semanticSnapshotHash,
        locale,
      });
    } catch (error) {
      this.#options.onFailure(error);
      return null;
    }
  }

  async #actions(
    entry: ApplePushDue,
    now: string,
    locale: WebPushLocale,
    approval: ApprovalRequest | undefined,
    affirmLabel: string | null,
  ): Promise<readonly ApplePushAction[]> {
    if (entry.item.kind !== "approval" || !approval) return [];
    const ownerPresence =
      (approval as ApprovalRequest & { recentAuthenticationRequired?: boolean })
        .recentAuthenticationRequired === true;
    const text = APPLE_PUSH_TEXT[locale];
    const random = this.#options.randomBytes ?? randomBytes;
    const bound = {
      requestId: approval.id,
      revision: approval.revision,
      snapshotHash: approval.semanticSnapshotHash,
    };
    const actions: ApplePushAction[] = [
      {
        action: "approve",
        label: ownerPresence ? text.approveInApp : (affirmLabel ?? text.approve),
        labelBasis: !ownerPresence && affirmLabel !== null ? "model" : "catalog",
        polarity: "positive",
        token: random(32).toString("base64url"),
        ownerPresence,
      },
      {
        action: "deny",
        label: text.deny,
        labelBasis: "catalog",
        polarity: "negative",
        token: random(32).toString("base64url"),
        ownerPresence: false,
      },
    ];
    const lifetime = this.#options.configuration().actionTokenLifetimeSeconds * 1_000;
    await this.#options.store.issueActionTokens({
      ...this.#scope(),
      deviceId: entry.registration.deviceId,
      sourceKey: entry.item.sourceKey,
      tokens: actions.map(
        ({ action, token, ownerPresence: presence }): NotificationActionTokenInput => ({
          tokenHash: notificationActionHash(token),
          action,
          ownerPresence: presence,
          approval: bound,
        }),
      ),
      now,
      expiresAt: new Date(
        Math.min(Date.parse(approval.expiresAt), Date.parse(now) + lifetime),
      ).toISOString(),
    });
    return actions;
  }

  async #sendAlert(
    entry: ApplePushDue,
    now: string,
    content: Extract<PushContent, { expired: false }>,
    badge: number | undefined,
    locale: WebPushLocale,
    approvals: readonly ApprovalRequest[],
  ): Promise<void> {
    const { item, registration, attempt } = entry;
    const tag = webPushTopic(item.sourceKey);
    const built = content.build(locale);
    const approval =
      item.kind === "approval" ? approvals.find(({ id }) => id === item.sourceRef) : undefined;
    const copy =
      approval &&
      (approval as ApprovalRequest & { recentAuthenticationRequired?: boolean })
        .recentAuthenticationRequired !== true
        ? await this.#approvalCopy(approval, locale)
        : null;
    const result = await this.#transmit("alert", item.kind, {
      token: registration.token,
      environment: registration.environment,
      topic: registration.topic,
      pushType: "alert",
      priority: item.kind === "run" ? 5 : 10,
      expiresAtSeconds: Math.floor(Date.parse(item.expiresAt) / 1_000),
      collapseId: tag,
      payload: applePushAlertPayload({
        title: built.title,
        body: copy?.sentence ?? built.body,
        navigate: built.navigate.startsWith(this.#options.publicOrigin)
          ? built.navigate.slice(this.#options.publicOrigin.length) || "/"
          : "/",
        tag,
        kind: item.kind,
        badge,
        actions: await this.#actions(entry, now, locale, approval, copy?.affirmLabel ?? null),
      }),
    });
    const attempts = (attempt?.attempts ?? 0) + 1;
    if (result.kind === "sent") await this.#record(entry, now, "sent", null, attempts);
    else if (result.kind === "gone") await this.#record(entry, now, "gone", result.code, attempts);
    else if (result.kind === "rejected" || result.kind === "too_large")
      await this.#record(entry, now, "failed", result.code, attempts);
    else if (attempts > RETRY_DELAYS_MS.length)
      await this.#record(entry, now, "failed", result.code, attempts);
    else
      await this.#record(entry, now, "pending", result.code, attempts, {
        delayMs:
          result.kind === "rate_limited"
            ? RATE_LIMIT_DELAY_MS
            : (RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[0]),
      });
    await this.#applyRegistrationOutcome(registration, result, now);
  }

  async #record(
    entry: ApplePushDue,
    now: string,
    status: "pending" | "sent" | "suppressed" | "expired" | "gone" | "failed",
    code: string | null,
    attempts = entry.attempt?.attempts ?? 0,
    retry?: { readonly delayMs: number },
  ): Promise<void> {
    await this.#options.store.recordAttempt({
      ...this.#scope(),
      sourceKey: entry.item.sourceKey,
      registrationId: entry.registration.id,
      status,
      attempts,
      nextAttemptAt: retry ? new Date(Date.parse(now) + retry.delayMs).toISOString() : null,
      lastCode: code,
      tag: webPushTopic(entry.item.sourceKey),
      now,
    });
  }

  async maintain(input: Parameters<PushCompanionChannel["maintain"]>[0]): Promise<void> {
    const digest = homeDigest(input.approvals, input.reminders);
    if (digest !== this.#homeDigest) {
      this.#homeDigest = digest;
      this.#widgetsDirtyForAll = true;
    }
    await this.#refreshWidgets(input.now);
    await this.#updateActivities(input.now, input.accountLocale, input.visible);
  }

  async #refreshWidgets(now: string): Promise<void> {
    if (!this.#widgetsDirtyForAll && this.#widgetDirty.size === 0) return;
    const registrations = await this.#options.store.listRegistrations({
      ...this.#scope(),
      pushType: "widgets",
    });
    if (this.#widgetsDirtyForAll) {
      for (const { deviceId } of registrations) this.#widgetDirty.add(deviceId);
      this.#widgetsDirtyForAll = false;
    }
    const at = Date.parse(now);
    const minimum = this.#options.configuration().widgetRefreshMinimumSeconds * 1_000;
    for (const deviceId of [...this.#widgetDirty]) {
      const registration = registrations.find((candidate) => candidate.deviceId === deviceId);
      if (!registration || !this.#configured(registration)) {
        this.#widgetDirty.delete(deviceId);
        continue;
      }
      const last = this.#widgetSentAt.get(deviceId);
      if (last !== undefined && at - last < minimum) continue;
      this.#widgetDirty.delete(deviceId);
      this.#widgetSentAt.set(deviceId, at);
      const result = await this.#transmit("widgets", "refresh", {
        token: registration.token,
        environment: registration.environment,
        topic: registration.topic,
        pushType: "widgets",
        priority: 5,
        expiresAtSeconds: Math.floor(at / 1_000) + WIDGET_EXPIRY_SECONDS,
        collapseId: null,
        payload: JSON.stringify({ aps: { "content-changed": true } }),
      });
      await this.#applyRegistrationOutcome(registration, result, now);
    }
  }

  async #title(threadId: string, locale: WebPushLocale): Promise<string> {
    return (await this.#options.threadTitle(threadId))?.title ?? APPLE_PUSH_TEXT[locale].untitled;
  }

  async #updateActivities(
    now: string,
    accountLocale: WebPushLocale | null,
    visible: boolean,
  ): Promise<void> {
    const { store } = this.#options;
    const registrations = await store.listRegistrations({
      ...this.#scope(),
      pushType: "liveactivity",
    });
    const registered = new Set(registrations.map(({ id }) => id));
    for (const sent of [this.#activitySent, this.#activityRetries])
      for (const id of sent.keys()) if (!registered.has(id)) sent.delete(id);
    if (registrations.length === 0) {
      this.#activityStarts.clear();
      return;
    }
    const configuration = this.#options.configuration();
    const at = Date.parse(now);
    const seconds = Math.floor(at / 1_000);
    const starters = registrations.filter(({ activityRef }) => activityRef === "");
    const running = registrations.filter(({ activityRef }) => activityRef !== "");
    if (starters.length === 0) this.#activityStarts.clear();
    if (starters.length > 0 && (!visible || this.#activityStarts.size > 0)) {
      const runs = await store.listActivityRuns({
        ...this.#scope(),
        createdAfter: this.#startedAt,
        createdBefore: new Date(
          at - configuration.liveActivityStartAfterSeconds * 1_000,
        ).toISOString(),
        limit: ACTIVITY_BATCH,
      });
      const devices = new Set(starters.map(({ deviceId }) => deviceId));
      const remembered = [...this.#activityStarts.keys()].slice(0, ACTIVITY_READ_BATCH);
      const unfinished = new Set(
        (
          await store.readActivityRuns({
            ...this.#scope(),
            runIds: [...new Set(remembered.map((key) => key.slice(key.indexOf("\n") + 1)))],
          })
        )
          .filter(({ status }) => !TERMINAL_PHASES.has(liveActivityPhase(status)))
          .map(({ runId }) => runId),
      );
      for (const key of remembered) {
        const separator = key.indexOf("\n");
        if (!unfinished.has(key.slice(separator + 1)) || !devices.has(key.slice(0, separator)))
          this.#activityStarts.delete(key);
      }
      for (const run of visible ? [] : runs)
        for (const registration of starters) {
          const key = `${registration.deviceId}\n${run.runId}`;
          const started = this.#activityStarts.get(key);
          if (
            (started !== undefined && at < started.notBefore) ||
            running.some(
              (candidate) =>
                candidate.deviceId === registration.deviceId && candidate.activityRef === run.runId,
            ) ||
            !this.#configured(registration)
          )
            continue;
          const locale = accountLocale ?? registration.locale;
          const title = await this.#title(run.threadId, locale);
          const result = await this.#transmit("liveactivity", "start", {
            token: registration.token,
            environment: registration.environment,
            topic: registration.topic,
            pushType: "liveactivity",
            priority: 10,
            expiresAtSeconds: seconds + configuration.liveActivityStaleAfterSeconds,
            collapseId: null,
            payload: JSON.stringify({
              aps: {
                timestamp: seconds,
                event: "start",
                "content-state": activityState(run),
                "stale-date": seconds + configuration.liveActivityStaleAfterSeconds,
                "attributes-type": APPLE_LIVE_ACTIVITY_ATTRIBUTES_TYPE,
                attributes: { runId: run.runId, threadId: run.threadId, title },
                alert: { title: APPLE_PUSH_TEXT[locale].progress, body: title },
              },
            }),
          });
          const attempts = (started?.attempts ?? 0) + 1;
          this.#activityStarts.set(key, {
            attempts,
            notBefore:
              (result.kind === "rate_limited" || result.kind === "retry") &&
              attempts <= RETRY_DELAYS_MS.length
                ? at + (RETRY_DELAYS_MS[attempts - 1] ?? RATE_LIMIT_DELAY_MS)
                : Number.POSITIVE_INFINITY,
          });
          await this.#applyRegistrationOutcome(registration, result, now);
        }
    }
    if (running.length === 0) return;
    const runs = new Map(
      (
        await store.readActivityRuns({
          ...this.#scope(),
          runIds: running.map(({ activityRef }) => activityRef),
        })
      ).map((run) => [run.runId, run]),
    );
    const minimum = configuration.liveActivityUpdateMinimumSeconds * 1_000;
    for (const registration of running) {
      const run = runs.get(registration.activityRef);
      const phase: AppleLiveActivityPhase = run ? liveActivityPhase(run.status) : "cancelled";
      const terminal = TERMINAL_PHASES.has(phase);
      const sent = this.#activitySent.get(registration.id);
      if (sent?.phase === phase) continue;
      if (!terminal && sent && at - sent.at < minimum) continue;
      if (!this.#configured(registration)) continue;
      const retried = this.#activityRetries.get(registration.id);
      const earlier = retried?.phase === phase ? retried : undefined;
      if (earlier && at < earlier.notBefore) continue;
      const result = await this.#transmit("liveactivity", terminal ? "end" : "update", {
        token: registration.token,
        environment: registration.environment,
        topic: registration.topic,
        pushType: "liveactivity",
        priority: terminal || phase === "waiting_for_owner" ? 10 : 5,
        expiresAtSeconds: seconds + configuration.liveActivityStaleAfterSeconds,
        collapseId: null,
        payload: JSON.stringify({
          aps: {
            timestamp: seconds,
            event: terminal ? "end" : "update",
            "content-state": {
              phase,
              updatedAt: run?.updatedAt ?? now,
            },
            ...(terminal
              ? {}
              : { "stale-date": seconds + configuration.liveActivityStaleAfterSeconds }),
          },
        }),
      });
      const attempts = (earlier?.attempts ?? 0) + 1;
      if (
        (result.kind === "retry" || result.kind === "rate_limited") &&
        attempts <= RETRY_DELAYS_MS.length
      ) {
        this.#activityRetries.set(registration.id, {
          phase,
          attempts,
          notBefore: at + (RETRY_DELAYS_MS[attempts - 1] ?? RATE_LIMIT_DELAY_MS),
        });
        continue;
      }
      this.#activityRetries.delete(registration.id);
      this.#activitySent.set(registration.id, { phase, at });
      if (terminal || result.kind === "gone") {
        this.#activitySent.delete(registration.id);
        await store.removeRegistration({
          ...this.#scope(),
          deviceId: registration.deviceId,
          pushType: "liveactivity",
          activityRef: registration.activityRef,
        });
      }
    }
  }
}

function activityState(run: ApplePushActivityRun) {
  return { phase: liveActivityPhase(run.status), updatedAt: run.updatedAt };
}

export function homeDigest(
  approvals: readonly ApprovalRequest[],
  reminders: readonly MemoryReminder[],
): string {
  const next = [...reminders].sort(
    (left, right) => left.remindAt.localeCompare(right.remindAt) || left.id.localeCompare(right.id),
  )[0];
  return createHash("sha256")
    .update(
      JSON.stringify([
        approvals.map(({ id, revision }) => `${id}:${revision}`).sort(),
        next ? [next.id, next.remindAt] : null,
      ]),
    )
    .digest("hex");
}
