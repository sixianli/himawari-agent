import { createHash } from "node:crypto";
import type {
  ApprovalRequest,
  MemoryReminder,
  MemoryReminderStorePort,
  ProductMemoryRecord,
  ProductMemoryStatePort,
  RuntimeRequest,
  WebPushDue,
  WebPushLocale,
  WebPushOutboxItem,
  WebPushSenderPort,
  WebPushSendResult,
  WebPushStorePort,
} from "@himawari-agent/application";

const DEFAULT_INTERVAL_MS = 10_000;
const PRESENCE_WINDOW_MS = 45_000;
const REMINDER_WINDOW_MS = 6 * 3_600_000;
const PROACTIVE_WINDOW_MS = 24 * 3_600_000;
const MUSE_CHANNEL_WINDOW_MS = 12 * 3_600_000;
const RUN_WINDOW_MS = 24 * 3_600_000;
const PRUNE_AFTER_MS = 7 * 24 * 3_600_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
const MAX_PAYLOAD_BYTES = 3_072;
const SEND_BATCH = 50;
const FINISHED_RUN_BATCH = 100;

export const WEB_PUSH_TEXT = {
  "zh-CN": {
    reminder: "Himawari 提醒",
    privateReminder: "你有一条私密提醒",
    approval: "等你审批",
    risk: { low: "低风险", medium: "中风险", high: "高风险", critical: "极高风险" },
    completed: "已完成",
    failed: "没有完成",
    unconfirmed: "命令结果没确认，本轮已结束",
    untitled: "新对话",
    test: "通知已开启",
    testBody: "Himawari 会在这里提醒你。",
    mailAct: "邮件里有件事要你处理",
    mailCheck: "有封邮件可能重要，请看原信",
    mailMore: (count: number) => `还有 ${count} 件`,
    museDown: "Muse 通道中断",
    museDownBody:
      "Muse 通道 3 小时没有数据，可能是定时任务的预授权失效或令牌过期，去 Muse 的 Upcoming 看一眼",
  },
  en: {
    reminder: "Himawari reminder",
    privateReminder: "You have a private reminder",
    approval: "Waiting for your approval",
    risk: { low: "Low risk", medium: "Medium risk", high: "High risk", critical: "Critical risk" },
    completed: "Done",
    failed: "Didn't finish",
    unconfirmed: "A command's result is unconfirmed; the Run ended",
    untitled: "New chat",
    test: "Notifications are on",
    testBody: "Himawari will remind you here.",
    mailAct: "An email needs you to act",
    mailCheck: "An email may be important. Please read it",
    mailMore: (count: number) => `${count} more`,
    museDown: "Muse channel is down",
    museDownBody:
      "No data from Muse for 3 hours. The scheduled task's pre-approval may have expired or the token may be out of date. Check Upcoming in Muse",
  },
  ja: {
    reminder: "Himawari リマインダー",
    privateReminder: "非公開のリマインダーがあります",
    approval: "承認待ち",
    risk: { low: "低リスク", medium: "中リスク", high: "高リスク", critical: "最高リスク" },
    completed: "完了しました",
    failed: "完了できませんでした",
    unconfirmed: "コマンドの結果を確認できず、ターンを終了しました",
    untitled: "新しいチャット",
    test: "通知がオンになりました",
    testBody: "Himawari からのお知らせがここに届きます。",
    mailAct: "メールに対応が必要な件があります",
    mailCheck: "重要かもしれないメールがあります。原文をご確認ください",
    mailMore: (count: number) => `ほか ${count} 件`,
    museDown: "Muse の連携が止まっています",
    museDownBody:
      "Muse から 3 時間データが届いていません。定期タスクの事前承認が切れたか、トークンの期限切れの可能性があります。Muse の Upcoming を確認してください",
  },
} as const satisfies Record<WebPushLocale, unknown>;

type RiskLevel = keyof (typeof WEB_PUSH_TEXT)["en"]["risk"];

export class WebPushPresence {
  readonly #seen = new Map<string, number>();

  beat(clientId: string, visible: boolean, now: string): void {
    if (visible) this.#seen.set(clientId, Date.parse(now));
    else this.#seen.delete(clientId);
  }

  anyVisible(now: string): boolean {
    const at = Date.parse(now);
    for (const [clientId, seen] of this.#seen) {
      if (at - seen <= PRESENCE_WINDOW_MS) return true;
      this.#seen.delete(clientId);
    }
    return false;
  }
}

export interface WebPushNotification {
  readonly title: string;
  readonly body: string;
  readonly navigate: string;
  readonly lang: WebPushLocale;
  readonly tag: string;
  readonly badge: number;
}

export function webPushTopic(sourceKey: string): string {
  return createHash("sha256").update(sourceKey).digest().subarray(0, 24).toString("base64url");
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

export function webPushPayload(notification: WebPushNotification): string {
  const build = (body: string) =>
    JSON.stringify({
      web_push: 8030,
      notification: {
        title: notification.title,
        body,
        navigate: notification.navigate,
        lang: notification.lang,
        tag: notification.tag,
        ...(notification.badge > 0 ? { app_badge: String(notification.badge) } : {}),
      },
    });
  const full = build(notification.body);
  const overflow = Buffer.byteLength(full, "utf8") - MAX_PAYLOAD_BYTES;
  if (overflow <= 0) return full;
  return build(
    clip(
      notification.body,
      Math.max(0, Buffer.byteLength(notification.body, "utf8") - overflow - 8),
    ),
  );
}

export type PushContent =
  | { readonly expired: true }
  | {
      readonly expired: false;
      readonly build: (locale: WebPushLocale) => Omit<WebPushNotification, "badge" | "tag">;
    };

export interface PushCompanionChannel {
  deliver(input: {
    readonly now: string;
    readonly approvals: readonly ApprovalRequest[];
    readonly badge: () => Promise<number | undefined>;
    readonly kinds: readonly WebPushOutboxItem["kind"][];
    readonly accountLocale: WebPushLocale | null;
    readonly visible: boolean;
    readonly content: (item: WebPushOutboxItem) => Promise<PushContent>;
  }): Promise<void>;
  maintain(input: {
    readonly now: string;
    readonly approvals: readonly ApprovalRequest[];
    readonly reminders: readonly MemoryReminder[];
    readonly accountLocale: WebPushLocale | null;
    readonly visible: boolean;
  }): Promise<void>;
}

export interface ProductionWebPushOptions {
  readonly companion?: PushCompanionChannel;
  readonly ownerId: RuntimeRequest["ownerId"];
  readonly agentId: RuntimeRequest["agentId"];
  readonly store: WebPushStorePort;
  readonly sender: WebPushSenderPort;
  readonly presence: WebPushPresence;
  readonly reminders: Pick<MemoryReminderStorePort, "listDue" | "read">;
  readonly memories: Pick<ProductMemoryStatePort, "readMany">;
  readonly readMemoryText: (memory: ProductMemoryRecord) => Promise<string | undefined>;
  readonly listApprovals: () => Promise<readonly ApprovalRequest[]>;
  readonly awaitingCount: () => Promise<number | undefined>;
  readonly proactive?: ProactivePushSource;
  readonly museChannel?: MuseChannelPushSource;
  readonly readLocale?: () => Promise<WebPushLocale | null>;
  readonly runThread: (runId: string) => Promise<string | null>;
  readonly threadTitle: (threadId: string) => Promise<{ readonly title: string | null } | null>;
  readonly publicOrigin: string;
  readonly timeZone?: string;
  readonly now: () => string;
  readonly intervalMs?: number;
  readonly onDelivery?: (outcome: { readonly kind: string; readonly code?: string }) => void;
  readonly onFailure: (error: unknown) => void;
}

export interface MuseChannelPushSource {
  listActive(now: string): Promise<readonly { readonly outageStartedAt: string }[]>;
}

export interface ProactivePushSource {
  listReady(now: string): Promise<readonly { readonly id: string; readonly readyAt: string }[]>;
  markEnqueued(pushId: string, now: string): Promise<void>;
  content(pushId: string): Promise<
    | {
        readonly insightId: string;
        readonly result: "act" | "know" | "check";
        readonly text: string;
        readonly dueAt: string | null;
        readonly more: number;
      }
    | undefined
  >;
}

type Content = PushContent;

export class ProductionWebPush {
  readonly #options: ProductionWebPushOptions;
  readonly #runThreads = new Map<string, string | null>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(options: ProductionWebPushOptions) {
    this.#options = options;
  }

  get publicKey(): string {
    return this.#options.sender.publicKey;
  }

  #resumed = false;

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(
      () => void this.tick(),
      this.#options.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    this.#timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  tick(): Promise<void> {
    this.#running ??= this.#run()
      .catch(this.#options.onFailure)
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  async sendTest(subscriptionId: string): Promise<WebPushSendResult> {
    const { store, ownerId, agentId } = this.#options;
    const subscription = (await store.listSubscriptions({ ownerId, agentId })).find(
      ({ id }) => id === subscriptionId,
    );
    if (!subscription) return { kind: "gone", code: "WEB_PUSH_SUBSCRIPTION_NOT_FOUND" };
    const locale = (await this.#options.readLocale?.()) ?? subscription.locale;
    const text = WEB_PUSH_TEXT[locale];
    const sourceKey = `test:${subscription.id}:${this.#options.now()}`;
    const result = await this.#options.sender.send({
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      payload: webPushPayload({
        title: text.test,
        body: text.testBody,
        navigate: `${this.#options.publicOrigin}/`,
        lang: locale,
        tag: webPushTopic(sourceKey),
        badge: 0,
      }),
      ttlSeconds: 300,
      urgency: "high",
      topic: webPushTopic(sourceKey),
    });
    await this.#applySubscriptionOutcome(subscription.id, result);
    return result;
  }

  async #resumePaused(now: string): Promise<void> {
    const { store, ownerId, agentId } = this.#options;
    for (const subscription of await store.listSubscriptions({ ownerId, agentId }))
      if (subscription.state === "paused")
        await store.markSubscription({
          ownerId,
          agentId,
          subscriptionId: subscription.id,
          state: "active",
          failureCode: null,
          deliveredAt: null,
          now,
        });
  }

  async #run(): Promise<void> {
    const now = this.#options.now();
    if (!this.#resumed) {
      await this.#resumePaused(now);
      this.#resumed = true;
    }
    const approvals = (await this.#options.listApprovals()).filter(
      (approval) =>
        approval.status === "pending" && Date.parse(approval.expiresAt) > Date.parse(now),
    );
    const reminders = (
      await this.#options.reminders.listDue({
        ownerId: this.#options.ownerId,
        agentId: this.#options.agentId,
        now,
        limit: 50,
      })
    ).filter(({ remindAt }) => Date.parse(now) - Date.parse(remindAt) <= REMINDER_WINDOW_MS);
    await this.#collect(now, approvals, reminders);
    await this.#deliver(now, approvals);
    await this.#options.companion?.maintain({
      now,
      approvals,
      reminders,
      accountLocale: (await this.#options.readLocale?.()) ?? null,
      visible: this.#options.presence.anyVisible(now),
    });
    await this.#options.store.prune({
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      expiredBefore: new Date(Date.parse(now) - PRUNE_AFTER_MS).toISOString(),
      limit: 200,
    });
  }

  async #collect(
    now: string,
    approvals: readonly ApprovalRequest[],
    reminders: readonly MemoryReminder[],
  ): Promise<void> {
    const { ownerId, agentId, store } = this.#options;
    const scope = { ownerId, agentId };
    const items: WebPushOutboxItem[] = [];
    for (const reminder of reminders)
      items.push({
        ...scope,
        sourceKey: `reminder:${reminder.id}:${reminder.remindAt}`,
        kind: "reminder",
        sourceRef: reminder.id,
        threadId: null,
        createdAt: now,
        expiresAt: new Date(Date.parse(reminder.remindAt) + REMINDER_WINDOW_MS).toISOString(),
      });
    for (const approval of approvals)
      items.push({
        ...scope,
        sourceKey: `approval:${approval.id}`,
        kind: "approval",
        sourceRef: approval.id,
        threadId: await this.#runThread(approval.runId),
        createdAt: now,
        expiresAt: approval.expiresAt,
      });
    const cursor = await store.readCursor({ ...scope, source: "finished-runs" });
    const runs = cursor
      ? await store.listFinishedRuns({ ...scope, afterCursor: cursor, limit: FINISHED_RUN_BATCH })
      : [];
    for (const run of runs)
      if (Date.parse(now) - Date.parse(run.finishedAt) < RUN_WINDOW_MS)
        items.push({
          ...scope,
          sourceKey: `run:${run.runId}:${run.status}${run.resultUnconfirmed ? ":unconfirmed" : ""}`,
          kind: "run",
          sourceRef: run.runId,
          threadId: run.threadId,
          createdAt: now,
          expiresAt: new Date(Date.parse(run.finishedAt) + RUN_WINDOW_MS).toISOString(),
        });
    const proactive = (await this.#options.proactive?.listReady(now)) ?? [];
    for (const push of proactive)
      items.push({
        ...scope,
        sourceKey: `proactive:${push.id}`,
        kind: "reminder",
        sourceRef: push.id,
        threadId: null,
        createdAt: now,
        expiresAt: new Date(Date.parse(push.readyAt) + PROACTIVE_WINDOW_MS).toISOString(),
      });
    const museOutages = (await this.#options.museChannel?.listActive(now)) ?? [];
    for (const outage of museOutages)
      items.push({
        ...scope,
        sourceKey: `muse-channel:${outage.outageStartedAt}`,
        kind: "reminder",
        sourceRef: outage.outageStartedAt,
        threadId: null,
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + MUSE_CHANNEL_WINDOW_MS).toISOString(),
      });
    const next = cursor ? runs.at(-1)?.cursor : now;
    if (items.length === 0 && !next) return;
    await store.enqueue({
      ...scope,
      items,
      cursor: next ? { source: "finished-runs", value: next } : null,
      now,
    });
    for (const push of proactive) await this.#options.proactive?.markEnqueued(push.id, now);
  }

  async #runThread(runId: string): Promise<string | null> {
    if (!this.#runThreads.has(runId))
      this.#runThreads.set(runId, await this.#options.runThread(runId));
    return this.#runThreads.get(runId) ?? null;
  }

  async #awaiting(): Promise<number | undefined> {
    try {
      return await this.#options.awaitingCount();
    } catch (error) {
      this.#options.onFailure(error);
      return undefined;
    }
  }

  async #deliver(now: string, approvals: readonly ApprovalRequest[]): Promise<void> {
    const { ownerId, agentId, store } = this.#options;
    const kinds = await store.readKinds({ ownerId, agentId });
    const accountLocale = (await this.#options.readLocale?.()) ?? null;
    const visible = this.#options.presence.anyVisible(now);
    const contents = new Map<string, Content>();
    const contentOf = async (item: WebPushOutboxItem): Promise<Content> => {
      const cached = contents.get(item.sourceKey);
      if (cached) return cached;
      const built = await this.#content(item, approvals, now);
      contents.set(item.sourceKey, built);
      return built;
    };
    let counted: Promise<number | undefined> | undefined;
    const awaiting = () => {
      counted ??= this.#awaiting();
      return counted;
    };
    await this.#options.companion
      ?.deliver({
        now,
        approvals,
        badge: awaiting,
        kinds,
        accountLocale,
        visible,
        content: contentOf,
      })
      .catch(this.#options.onFailure);
    const due = await store.listDue({ ownerId, agentId, now, limit: SEND_BATCH });
    for (const entry of due) {
      const { item } = entry;
      if (Date.parse(now) >= Date.parse(item.expiresAt)) {
        await this.#record(entry, now, "expired", null);
        continue;
      }
      if (!kinds.includes(item.kind)) {
        await this.#record(entry, now, "suppressed", "WEB_PUSH_KIND_OFF");
        continue;
      }
      const content = await contentOf(item);
      if (content.expired) {
        await this.#record(entry, now, "expired", null);
        continue;
      }
      if (visible) {
        await this.#record(entry, now, "suppressed", null);
        continue;
      }
      await this.#send(
        entry,
        now,
        content,
        (await awaiting()) ?? 0,
        accountLocale ?? entry.subscription.locale,
      );
    }
  }

  async #content(
    item: WebPushOutboxItem,
    approvals: readonly ApprovalRequest[],
    now: string,
  ): Promise<Content> {
    const origin = this.#options.publicOrigin;
    const threadUrl = (threadId: string | null) =>
      threadId ? `${origin}/threads/${encodeURIComponent(threadId)}` : `${origin}/`;
    if (item.kind === "reminder" && item.sourceKey.startsWith("muse-channel:")) {
      const active = await this.#options.museChannel?.listActive(now);
      if (!active?.some(({ outageStartedAt }) => outageStartedAt === item.sourceRef))
        return { expired: true };
      return {
        expired: false,
        build: (locale) => ({
          title: WEB_PUSH_TEXT[locale].museDown,
          body: WEB_PUSH_TEXT[locale].museDownBody,
          navigate: `${origin}/`,
          lang: locale,
        }),
      };
    }
    if (item.kind === "reminder" && item.sourceKey.startsWith("proactive:")) {
      const mail = await this.#options.proactive?.content(item.sourceRef);
      if (!mail) return { expired: true };
      return {
        expired: false,
        build: (locale) => {
          const text = WEB_PUSH_TEXT[locale];
          const lines = [
            mail.dueAt ? `${mail.text}\n${this.#formatTime(mail.dueAt, locale)}` : mail.text,
            ...(mail.more > 0 ? [text.mailMore(mail.more)] : []),
          ];
          return {
            title: mail.result === "check" ? text.mailCheck : text.mailAct,
            body: lines.join("\n"),
            navigate: `${origin}/?reminder=${encodeURIComponent(mail.insightId)}`,
            lang: locale,
          };
        },
      };
    }
    if (item.kind === "reminder") {
      const reminder = await this.#options.reminders.read(item.sourceRef);
      if (
        !reminder ||
        reminder.status !== "scheduled" ||
        !item.sourceKey.endsWith(`:${reminder.remindAt}`)
      )
        return { expired: true };
      const [memory] = await this.#options.memories.readMany({
        ownerId: this.#options.ownerId,
        agentId: this.#options.agentId,
        memoryIds: [reminder.memoryId],
      });
      if (!memory || memory.status !== "active") return { expired: true };
      const hidden =
        memory.dataClassification === "sensitive" || memory.dataClassification === "restricted";
      const text = hidden
        ? undefined
        : (await this.#options.readMemoryText(memory))?.replace(/\s+/gu, " ").trim();
      if (!hidden && !text) return { expired: true };
      return {
        expired: false,
        build: (locale) => ({
          title: WEB_PUSH_TEXT[locale].reminder,
          body: hidden
            ? WEB_PUSH_TEXT[locale].privateReminder
            : `${text}\n${this.#formatTime(reminder.dueAt, locale)}`,
          navigate: `${origin}/memory`,
          lang: locale,
        }),
      };
    }
    if (item.kind === "approval") {
      const approval = approvals.find(({ id }) => id === item.sourceRef);
      if (!approval || Date.parse(approval.expiresAt) <= Date.parse(now)) return { expired: true };
      const title = await this.#title(item.threadId);
      if (title === undefined) return { expired: true };
      const risk =
        "finalRisk" in approval ? (approval as { finalRisk: RiskLevel }).finalRisk : undefined;
      return {
        expired: false,
        build: (locale) => ({
          title: risk
            ? `${WEB_PUSH_TEXT[locale].approval} · ${WEB_PUSH_TEXT[locale].risk[risk]}`
            : WEB_PUSH_TEXT[locale].approval,
          body: title ?? WEB_PUSH_TEXT[locale].untitled,
          navigate: threadUrl(item.threadId),
          lang: locale,
        }),
      };
    }
    const title = await this.#title(item.threadId);
    if (title === undefined) return { expired: true };
    const unconfirmed = item.sourceKey.endsWith(":failed:unconfirmed");
    const failed = unconfirmed || item.sourceKey.endsWith(":failed");
    return {
      expired: false,
      build: (locale) => ({
        title: unconfirmed
          ? WEB_PUSH_TEXT[locale].unconfirmed
          : failed
            ? WEB_PUSH_TEXT[locale].failed
            : WEB_PUSH_TEXT[locale].completed,
        body: title ?? WEB_PUSH_TEXT[locale].untitled,
        navigate: threadUrl(item.threadId),
        lang: locale,
      }),
    };
  }

  async #title(threadId: string | null): Promise<string | null | undefined> {
    if (!threadId) return null;
    const thread = await this.#options.threadTitle(threadId);
    return thread ? thread.title : undefined;
  }

  #formatTime(at: string, locale: WebPushLocale): string {
    return new Intl.DateTimeFormat(locale, {
      timeZone: this.#options.timeZone ?? "UTC",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(at));
  }

  async #send(
    entry: WebPushDue,
    now: string,
    content: Extract<Content, { expired: false }>,
    badge: number,
    locale: WebPushLocale,
  ): Promise<void> {
    const { item, subscription, attempt } = entry;
    const topic = webPushTopic(item.sourceKey);
    let result: WebPushSendResult;
    try {
      result = await this.#options.sender.send({
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        payload: webPushPayload({ ...content.build(locale), tag: topic, badge }),
        ttlSeconds: Math.max(1, Math.floor((Date.parse(item.expiresAt) - Date.parse(now)) / 1_000)),
        urgency: item.kind === "run" ? "normal" : "high",
        topic,
      });
    } catch (error) {
      this.#options.onFailure(error);
      result = { kind: "retry", code: "WEB_PUSH_NETWORK" };
    }
    const attempts = (attempt?.attempts ?? 0) + 1;
    this.#options.onDelivery?.({
      kind: result.kind,
      ...("code" in result ? { code: result.code } : {}),
    });
    if (result.kind === "sent") await this.#record(entry, now, "sent", null, attempts);
    else if (result.kind === "gone" || result.kind === "rejected" || result.kind === "too_large")
      await this.#record(
        entry,
        now,
        result.kind === "gone" ? "gone" : "failed",
        result.code,
        attempts,
      );
    else if (result.kind === "rate_limited")
      await this.#record(entry, now, "pending", result.code, attempts, {
        delayMs: Math.min(3_600, Math.max(1, result.retryAfterSeconds ?? 60)) * 1_000,
      });
    else if (attempts > RETRY_DELAYS_MS.length)
      await this.#record(entry, now, "failed", result.code, attempts);
    else
      await this.#record(entry, now, "pending", result.code, attempts, {
        delayMs: RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[0],
      });
    await this.#applySubscriptionOutcome(subscription.id, result);
  }

  async #applySubscriptionOutcome(subscriptionId: string, result: WebPushSendResult) {
    const { store, ownerId, agentId } = this.#options;
    const now = this.#options.now();
    if (result.kind === "gone")
      await store.removeSubscription({ ownerId, agentId, subscriptionId });
    else if (result.kind === "sent")
      await store.markSubscription({
        ownerId,
        agentId,
        subscriptionId,
        state: "active",
        failureCode: null,
        deliveredAt: now,
        now,
      });
    else if (result.kind === "rejected")
      await store.markSubscription({
        ownerId,
        agentId,
        subscriptionId,
        state: "paused",
        failureCode: result.code,
        deliveredAt: null,
        now,
      });
  }

  async #record(
    entry: WebPushDue,
    now: string,
    status: "pending" | "sent" | "suppressed" | "expired" | "gone" | "failed",
    code: string | null,
    attempts = entry.attempt?.attempts ?? 0,
    retry?: { readonly delayMs: number },
  ): Promise<void> {
    await this.#options.store.recordAttempt({
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      sourceKey: entry.item.sourceKey,
      subscriptionId: entry.subscription.id,
      status,
      attempts,
      nextAttemptAt: retry ? new Date(Date.parse(now) + retry.delayMs).toISOString() : null,
      lastCode: code,
      tag: webPushTopic(entry.item.sourceKey),
      now,
    });
  }
}
