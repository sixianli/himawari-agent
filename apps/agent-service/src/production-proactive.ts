import { randomBytes } from "node:crypto";
import {
  ApplicationPortError,
  type ClockPort,
  type DailyReview,
  type DailyReviewMemoryText,
  type DataClassification,
  type DecisionLedgerPort,
  GMAIL_SOURCE,
  type IdGeneratorPort,
  limitedSourceReader,
  listDailyReviewSubjects,
  type MailInboxPort,
  type MemoryCheckupService,
  OwnerRuleReplay,
  type OwnerRuleReplayResult,
  type OwnerRuleStorePort,
  PORT_ERROR_CODES,
  PROACTIVE_SOURCE_LIMIT_ON_REACH,
  PROACTIVE_SOURCES,
  type PrereviewRunResult,
  type ProactiveConfiguration,
  type ProactiveDecision,
  ProactiveMailCheckService,
  type ProactiveMailReader,
  type ProactiveModelInvoker,
  type ProactiveOverview,
  type ProactiveProgramEntry,
  type ProactiveProgramEntryOutcome,
  type ProactiveRating,
  type ProactiveScope,
  type ProactiveSealPort,
  type ProactiveSource,
  type ProactiveSourceLimitHit,
  type ProactiveSourceRegistry,
  type ProactiveSourceRunner,
  type ProactiveStorePort,
  parseReviewKey,
  proactiveSourceLimitsValid,
  ReviewPrereviewService,
  type ReviewPrereviewStorePort,
  type RuleRecord,
  type RuleReviewReport,
  type RuleReviewService,
  readDailyReview,
  readProactiveOverview,
  readProactiveSourceSettings,
  recordProactiveProgramEntry,
  startOfNextZonedDay,
  startOfZonedDay,
  type WebPushFeedback,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import type { GoogleOAuth } from "@himawari-agent/platform-node";
import type { ProactivePushSource } from "./production-web-push.js";

export const PRODUCTION_PROACTIVE_OPERATIONS = Object.freeze([
  "proactive.overview.read",
  "proactive.settings.set",
  "proactive.pause",
  "proactive.insight.respond",
  "proactive.decision.rate",
  "proactive.audit.respond",
  "proactive.review.read",
  "proactive.review.rate",
  "proactive.review.checkup",
  "proactive.source.manage",
  "proactive.sources.read",
  "proactive.source.settings.set",
  "proactive.source.switch_off",
] as const);

export const PROACTIVE_GOOGLE_START_PATH = "/api/proactive/v1/google/start";
export const PROACTIVE_GOOGLE_CALLBACK_PATH = "/api/proactive/v1/google/callback";
export const PROACTIVE_MAX_OUTPUT_TOKENS = 4096;
export const PREREVIEW_MAX_OUTPUT_TOKENS = 1024;
export const RULE_REVIEW_MAX_OUTPUT_TOKENS = 2048;

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 20;

export function proactiveRedirectUri(publicOrigin: string): string {
  return `${publicOrigin}${PROACTIVE_GOOGLE_CALLBACK_PATH}`;
}

export function proactiveCostEstimator(
  cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  },
  maxOutputTokens: number,
): (prompt: string) => number {
  return (prompt) =>
    Math.ceil(
      prompt.length * Math.max(cost.input, cost.cacheRead, cost.cacheWrite) +
        maxOutputTokens * cost.output,
    );
}

function clean(text: string, limit: number): string {
  let clipped = "";
  for (const character of text.replace(/\p{Cc}+/gu, " ").trim()) {
    if (clipped.length + character.length > limit) break;
    clipped += character;
  }
  return clipped;
}

function normalizeSender(sender: string): string {
  return sender.trim().toLowerCase();
}

export function createProactivePushSource(options: {
  readonly scope: ProactiveScope;
  readonly store: ProactiveStorePort;
  readonly seal: ProactiveSealPort;
}): ProactivePushSource {
  const { scope, store, seal } = options;
  return Object.freeze<ProactivePushSource>({
    listReady: (now) => store.listReadyPushes({ ...scope, now, limit: 20 }),
    async markEnqueued(pushId, now) {
      await store.markPushEnqueued({ ...scope, pushId, now });
    },
    async content(pushId) {
      const push = await store.readPush({ ...scope, pushId });
      if (!push) return undefined;
      const open = (await store.readInsights({ ...scope, insightIds: push.insightIds }))
        .filter(({ status }) => status === "open")
        .sort((left, right) =>
          left.result !== right.result
            ? left.result === "act"
              ? -1
              : 1
            : (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999"),
        );
      const first = open[0];
      if (!first) return undefined;
      let content: Partial<Record<"summary" | "subject" | "from", unknown>> = {};
      try {
        content = JSON.parse((await seal.open({ ...scope, ref: first.contentRef })) ?? "{}");
      } catch {
        content = {};
      }
      const pick = (value: unknown) => (typeof value === "string" ? clean(value, 200) : "");
      const text = pick(content.summary) || pick(content.subject) || pick(content.from);
      if (!text) return undefined;
      return {
        insightId: first.id,
        result: first.result,
        text,
        dueAt: first.dueAt,
        more: open.length - 1,
      };
    },
  });
}

export interface ProductionProactiveOptions {
  readonly scope: ProactiveScope;
  readonly configuration: ProactiveConfiguration;
  readonly timeZone: string;
  readonly store: ProactiveStorePort;
  readonly ownerRules?: Pick<OwnerRuleStorePort, "list">;
  readonly seal: ProactiveSealPort;
  readonly oauth: GoogleOAuth;
  readonly reader: ProactiveMailReader;
  readonly registry?: ProactiveSourceRegistry<ProactiveSource>;
  readonly runners?: readonly ProactiveSourceRunner[];
  readonly onLimit?: (hit: ProactiveSourceLimitHit) => void;
  readonly readAccount: (accessToken: string) => Promise<string>;
  readonly model: ProactiveModelInvoker;
  readonly ledger: Pick<DecisionLedgerPort, "listReviewPool" | "rateMany">;
  readonly readMemoryText: (ref: string) => Promise<string | undefined>;
  readonly readMemory?: (memoryId: string) => Promise<DailyReviewMemoryText | undefined>;
  readonly readMemoryClassification?: (ref: string) => Promise<DataClassification | undefined>;
  readonly prereview?: {
    readonly store: ReviewPrereviewStorePort;
    readonly model: ProactiveModelInvoker;
    readonly digest: (text: string) => string;
    readonly estimateCostMicros: (prompt: string) => number;
  };
  readonly onPrereview?: (result: PrereviewRunResult) => void;
  readonly ruleReview?: Pick<RuleReviewService, "run">;
  readonly onRuleReview?: (reports: readonly RuleReviewReport[]) => void;
  readonly checkup?: Pick<MemoryCheckupService, "week" | "act" | "undo">;
  readonly estimateCostMicros: (prompt: string) => number;
  readonly feedback: (sentFrom: string) => Promise<readonly WebPushFeedback[]>;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly onDecision?: (decision: ProactiveDecision) => void;
  readonly onFailure: (error: unknown) => void;
}

export type ProactiveAuthorizationOutcome = "connected" | "denied" | "failed";

export interface ProactiveAppAuthorizationStart {
  readonly kind: "browser";
  readonly authorizationUrl: string;
}

export const PROACTIVE_APP_CALLBACK_HOST = "gmail-authorization";
export const GMAIL_CONNECTION_TITLE = "Gmail";

interface PendingAuthorization {
  readonly owner: string;
  readonly expiresAt: number;
  readonly app?: {
    readonly callbackScheme: string;
    reply?: { readonly code: string | null; readonly error: string | null };
  };
}

export class ProductionProactive {
  readonly #options: ProductionProactiveOptions;
  readonly #registry: ProactiveSourceRegistry<ProactiveSource>;
  readonly #runners: readonly ProactiveSourceRunner[];
  readonly #mail: ProactiveMailCheckService;
  #inbox: MailInboxPort | undefined;
  readonly #prereview: ReviewPrereviewService | undefined;
  readonly #states = new Map<string, PendingAuthorization>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(options: ProductionProactiveOptions) {
    this.#options = options;
    this.#registry = options.registry ?? PROACTIVE_SOURCES;
    const mail = new ProactiveMailCheckService({
      scope: options.scope,
      store: options.store,
      seal: options.seal,
      reader: limitedSourceReader({
        reader: options.reader,
        scope: options.scope,
        store: options.store,
        clock: options.clock,
        timeZone: options.timeZone,
        ...(options.onLimit ? { onLimit: options.onLimit } : {}),
      }),
      inbox: {
        submit: (input) =>
          this.#inbox ? this.#inbox.submit(input) : Promise.resolve({ accepted: false }),
      },
      perCheckMs: options.configuration.perCheckMs,
      ...(options.ownerRules ? { ownerRuleStore: options.ownerRules } : {}),
      clock: options.clock,
      ids: options.ids,
    });
    this.#mail = mail;
    const bound = new Map<string, ProactiveSourceRunner>(
      [{ source: GMAIL_SOURCE.name, run: () => mail.run() }, ...(options.runners ?? [])].map(
        (runner) => [runner.source, runner],
      ),
    );
    this.#runners = this.#registry.definitions
      .filter(({ intake }) => intake === "reader")
      .map(({ name }) => {
        const runner = bound.get(name);
        if (runner === undefined) throw new Error(`PROACTIVE_SOURCE_READER_MISSING ${name}`);
        return runner;
      });
    const prereview = options.prereview;
    this.#prereview = prereview
      ? new ReviewPrereviewService({
          scope: options.scope,
          store: prereview.store,
          model: prereview.model,
          settings: options.configuration.reviewPrereview,
          timeZone: options.timeZone,
          clock: options.clock,
          digest: prereview.digest,
          estimateCostMicros: prereview.estimateCostMicros,
          subjects: async () => listDailyReviewSubjects(await this.#reviewSources()),
        })
      : undefined;
  }

  attachInbox(inbox: MailInboxPort): void {
    this.#inbox = inbox;
  }

  readMailThread(threadId: string, signal: AbortSignal) {
    return this.#mail.readThread(threadId, signal);
  }

  async #reviewSources() {
    const options = this.#options;
    return {
      scope: options.scope,
      ledger: options.ledger,
      overview: await this.overview(),
      readMemoryText: options.readMemoryText,
      ...(options.readMemory ? { readMemory: options.readMemory } : {}),
      ...(options.readMemoryClassification
        ? { readMemoryClassification: options.readMemoryClassification }
        : {}),
      timeZone: options.timeZone,
      now: options.clock.now(),
    };
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#options.configuration.intervalMs);
    this.#timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  tick(): Promise<void> {
    this.#running ??= this.#reviewRulesThenRunSources()
      .catch(this.#options.onFailure)
      .then(async () => {
        await this.prereview();
      })
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  async #reviewRulesThenRunSources(): Promise<void> {
    await this.reviewRules();
    await this.#runSources();
  }

  async #runSources(): Promise<void> {
    const { scope, store } = this.#options;
    const off = new Set(
      (await store.listSourceSettings(scope))
        .filter(({ enabled }) => !enabled)
        .map(({ source }) => source),
    );
    for (const runner of this.#runners) {
      if (off.has(runner.source)) continue;
      try {
        const decision = await runner.run();
        if (decision) this.#options.onDecision?.(decision);
      } catch (error) {
        this.#options.onFailure(error);
      }
    }
  }

  recordEntry(entry: ProactiveProgramEntry): Promise<ProactiveProgramEntryOutcome> {
    const { scope, store, seal, clock, ids, timeZone, onLimit } = this.#options;
    return recordProactiveProgramEntry(
      {
        scope,
        store,
        seal,
        clock,
        ids,
        timeZone,
        registry: this.#registry,
        ...(onLimit ? { onLimit } : {}),
      },
      entry,
    );
  }

  async reviewRules(): Promise<readonly RuleReviewReport[]> {
    if (!this.#options.ruleReview) return [];
    try {
      const reports = await this.#options.ruleReview.run();
      if (reports.length > 0) this.#options.onRuleReview?.(reports);
      return reports;
    } catch (error) {
      this.#options.onFailure(error);
      return [];
    }
  }

  async prereview(): Promise<PrereviewRunResult | undefined> {
    if (!this.#prereview) return undefined;
    try {
      const result = await this.#prereview.run();
      this.#options.onPrereview?.(result);
      return result;
    } catch (error) {
      this.#options.onFailure(error);
      return undefined;
    }
  }

  async replayRule(rule: RuleRecord): Promise<OwnerRuleReplayResult> {
    return new OwnerRuleReplay({
      scope: this.#options.scope,
      store: this.#options.store,
      seal: this.#options.seal,
      readModelInput: (ref) => this.#options.model.readOutput(ref),
      clock: this.#options.clock,
      days: this.#options.configuration.ruleReplayDays,
      mailsPerOutcome: this.#options.configuration.ruleReplayMailsPerOutcome,
    }).replay(rule);
  }

  async readDecisionModelIo(
    decisionId: string,
  ): Promise<readonly { readonly role: "model_input" | "model_output"; readonly text: string }[]> {
    const payloads = await this.#options.store.readDecisionPayloads({
      ...this.#options.scope,
      decisionId,
    });
    const entries: { role: "model_input" | "model_output"; text: string }[] = [];
    for (const { ref, role } of payloads)
      entries.push({ role, text: await this.#options.model.readOutput(ref) });
    return entries;
  }

  beginAuthorization(owner: string): string {
    return this.#issueState({ owner });
  }

  beginAppAuthorization(input: {
    readonly deviceId: string;
    readonly callbackScheme: string;
  }): ProactiveAppAuthorizationStart {
    return {
      kind: "browser",
      authorizationUrl: this.#issueState({
        owner: input.deviceId,
        app: { callbackScheme: input.callbackScheme },
      }),
    };
  }

  appCallback(input: {
    readonly state: string | null;
    readonly code: string | null;
    readonly error: string | null;
  }): string | undefined {
    const pending = input.state ? this.#states.get(input.state) : undefined;
    if (!input.state || !pending?.app) return undefined;
    if (pending.app.reply === undefined && pending.expiresAt > this.#now())
      pending.app.reply = { code: input.code, error: input.error };
    return `${pending.app.callbackScheme}://${PROACTIVE_APP_CALLBACK_HOST}?${new URLSearchParams({ state: input.state })}`;
  }

  async completeAppAuthorization(input: {
    readonly deviceId: string;
    readonly state: string;
  }): Promise<ProactiveAuthorizationOutcome> {
    const pending = this.#states.get(input.state);
    if (!pending?.app || pending.owner !== input.deviceId) return "failed";
    this.#states.delete(input.state);
    const reply = pending.app.reply;
    if (!reply || pending.expiresAt <= this.#now()) return "failed";
    if (reply.error) return reply.error === "access_denied" ? "denied" : "failed";
    if (!reply.code) return "failed";
    return this.#connect(reply.code);
  }

  async completeAuthorization(input: {
    readonly owner: string;
    readonly state: string | null;
    readonly code: string | null;
    readonly error: string | null;
  }): Promise<ProactiveAuthorizationOutcome> {
    const pending = input.state ? this.#states.get(input.state) : undefined;
    if (pending?.app) return "failed";
    if (input.state) this.#states.delete(input.state);
    if (!pending || pending.owner !== input.owner || pending.expiresAt <= this.#now())
      return "failed";
    if (input.error) return input.error === "access_denied" ? "denied" : "failed";
    if (!input.code) return "failed";
    return this.#connect(input.code);
  }

  #now(): number {
    return Date.parse(this.#options.clock.now());
  }

  #issueState(pending: Omit<PendingAuthorization, "expiresAt">): string {
    const now = this.#now();
    for (const [state, entry] of this.#states)
      if (entry.expiresAt <= now) this.#states.delete(state);
    while (this.#states.size >= MAX_PENDING_STATES) {
      const oldest = this.#states.keys().next().value;
      if (oldest === undefined) break;
      this.#states.delete(oldest);
    }
    const state = randomBytes(24).toString("base64url");
    this.#states.set(state, { ...pending, expiresAt: now + STATE_TTL_MS });
    return this.#options.oauth.authorizationUrl(state);
  }

  async #connect(code: string): Promise<ProactiveAuthorizationOutcome> {
    const { scope, store, seal, oauth } = this.#options;
    try {
      const granted = await oauth.exchange(code);
      const account = await this.#options.readAccount(granted.accessToken);
      const now = this.#options.clock.now();
      const existing = await store.readConnection({ ...scope, source: GMAIL_SOURCE.name });
      const sameAccount =
        existing !== undefined &&
        (await seal.open({ ...scope, ref: existing.accountRef })) === account;
      const released = await store.saveConnection({
        ...scope,
        connection: {
          source: GMAIL_SOURCE.name,
          accountRef: await seal.seal({ ...scope, text: account, at: now }),
          tokenRef: await seal.seal({ ...scope, text: granted.refreshToken, at: now }),
          cursor: sameAccount ? existing.cursor : null,
          status: "connected",
          connectedAt: sameAccount ? existing.connectedAt : now,
          updatedAt: now,
        },
      });
      if (released.length > 0) await seal.release({ ...scope, refs: released });
      if (!existing) {
        const settings = await store.readSettings(scope);
        await store.writeSettings({ ...scope, ...settings, enabled: true, now });
      }
      void this.tick();
      return "connected";
    } catch (error) {
      this.#options.onFailure(error);
      return "failed";
    }
  }

  async connection(): Promise<{
    readonly name: string;
    readonly title: string;
    readonly status: "disconnected" | "connected" | "needs_reconnect";
    readonly account: string | null;
    readonly connectedAt: string | null;
  }> {
    const { scope, store, seal } = this.#options;
    const connection = await store.readConnection({ ...scope, source: GMAIL_SOURCE.name });
    const account = connection
      ? ((await seal.open({ ...scope, ref: connection.accountRef })) ?? null)
      : null;
    return {
      name: GMAIL_SOURCE.name,
      title: GMAIL_CONNECTION_TITLE,
      status: connection?.status ?? "disconnected",
      account,
      connectedAt: connection?.connectedAt ?? null,
    };
  }

  async overview(): Promise<ProactiveOverview> {
    return readProactiveOverview({
      scope: this.#options.scope,
      source: GMAIL_SOURCE.name,
      store: this.#options.store,
      seal: this.#options.seal,
      timeZone: this.#options.timeZone,
      dailyCostMicros: this.#options.configuration.dailyCostMicros,
      now: this.#options.clock.now(),
      feedback: this.#options.feedback,
    });
  }

  async review(options: { readonly strict?: boolean } = {}): Promise<DailyReview> {
    const week = this.#options.checkup?.week();
    const checkup = !week
      ? []
      : options.strict
        ? await week
        : await week.catch((error: unknown) => {
            this.#options.onFailure(error);
            return [];
          });
    const prereview = this.#prereview;
    return readDailyReview({
      ...(await this.#reviewSources()),
      ...(prereview
        ? {
            hideByModel: (candidates) =>
              options.strict
                ? prereview.hiddenByModel(candidates)
                : prereview.hiddenByModel(candidates).catch((error: unknown) => {
                    this.#options.onFailure(error);
                    return new Set<string>();
                  }),
          }
        : {}),
      budgetSeconds: this.#options.configuration.reviewBudgetSeconds,
      secondsPerItem: this.#options.configuration.reviewSecondsPerItem,
      silentShare: this.#options.configuration.reviewSilentSharePermille,
      checkup,
    });
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type === "proactive.review.read") {
      const review = await this.review();
      const item = (entry: DailyReview["items"][number]) => ({
        ...entry,
        text: clean(entry.text, 200),
        checkup: entry.checkup
          ? { ...entry.checkup, relatedText: clean(entry.checkup.relatedText, 200) }
          : null,
      });
      return {
        ...query,
        kind: "snapshot",
        type: "proactive.review.snapshot",
        actor: { actorType: "system", actorId: "agent-service" },
        payload: {
          day: review.day,
          capacity: review.capacity,
          sampled: review.sampled,
          notSampled: review.notSampled,
          hiddenByModel: review.hiddenByModel,
          items: review.items.map(item),
          folded: { total: review.folded.total, items: review.folded.items.map(item) },
          memoryUnusedDays: this.#options.configuration.reviewMemoryUnusedDays,
          generatedAt: this.#options.clock.now(),
        },
      };
    }
    if (query.type === "proactive.sources.read") {
      const { scope, store, clock, timeZone } = this.#options;
      const since = startOfZonedDay(clock.now(), timeZone);
      const resetsAt = startOfNextZonedDay(clock.now(), timeZone);
      const settings = new Map(
        (await store.listSourceSettings(scope)).map((entry) => [entry.source, entry]),
      );
      const sources = [];
      for (const definition of this.#registry.definitions) {
        const entry = settings.get(definition.name);
        if (entry === undefined) continue;
        const usedToday = await store.processedSince({ ...scope, source: definition.name, since });
        sources.push({
          source: definition.name,
          intake: definition.intake,
          trust: definition.trust,
          enabled: entry.enabled,
          perDay: {
            limit: entry.perDay,
            ...definition.safetyLimits.perDay,
            used: usedToday,
            resetsAt,
            onReach: PROACTIVE_SOURCE_LIMIT_ON_REACH.perDay,
          },
          perCheck: {
            limit: entry.perCheck,
            ...definition.safetyLimits.perCheck,
            onReach: PROACTIVE_SOURCE_LIMIT_ON_REACH.perCheck,
          },
          dailyLimitReached: usedToday >= entry.perDay,
          updatedAt: entry.updatedAt,
        });
      }
      return {
        ...query,
        kind: "snapshot",
        type: "proactive.sources.snapshot",
        actor: { actorType: "system", actorId: "agent-service" },
        payload: { sources, generatedAt: clock.now() },
      };
    }
    if (query.type !== "proactive.overview.read")
      throw new Error("PROACTIVE_OPERATION_NOT_INSTALLED");
    const overview = await this.overview();
    return {
      ...query,
      kind: "snapshot",
      type: "proactive.overview.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        source: overview.source,
        connection: {
          status: overview.connection.status,
          account: overview.connection.account
            ? clean(overview.connection.account, 320) || null
            : null,
          connectedAt: overview.connection.connectedAt,
        },
        enabled: overview.enabled,
        quietHours: overview.quietHours.map((period) => ({
          days: [...period.days],
          start: period.start,
          end: period.end,
        })),
        importantSenders: [...overview.importantSenders],
        dailyLimitReached: overview.dailyLimitReached,
        insights: overview.insights.map((insight) => ({
          id: insight.id,
          result: insight.result,
          floorRaised: insight.floorRaised,
          summary: clean(insight.summary, 500),
          reason: clean(insight.reason, 500),
          basis: insight.basis,
          from: clean(insight.from, 320),
          subject: clean(insight.subject, 500),
          link: clean(insight.link, 512),
          dueAt: insight.dueAt,
          priority: insight.priority,
          status: insight.status,
          pushed: insight.pushed,
          pushReaction: insight.pushReaction,
          rating: insight.rating,
          updatedAt: insight.updatedAt,
        })),
        audit: {
          active: overview.audit.active,
          since: overview.audit.since,
          items: overview.audit.items.map((item) => ({
            messageId: item.messageId,
            from: clean(item.from, 320),
            subject: clean(item.subject, 500),
            link: clean(item.link, 512),
            rating: item.rating,
          })),
          pending: overview.audit.pending,
        },
        decisions: overview.decisions.map((decision) => ({
          id: decision.id,
          checkedAt: decision.checkedAt,
          verdict: decision.verdict,
          reasonCode: decision.reasonCode,
          counts: { ...decision.counts },
          opened: decision.opened,
          rating: decision.rating,
        })),
        metrics: { ...overview.metrics },
        generatedAt: this.#options.clock.now(),
      },
    };
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    const { scope, store, seal } = this.#options;
    if (
      command.actor.actorType !== "owner" ||
      command.scope.ownerId !== scope.ownerId ||
      command.scope.agentId !== scope.agentId
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "PROACTIVE_OWNER_REQUIRED",
      );
    const now = this.#options.clock.now();
    const missing = () =>
      new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "PROACTIVE_RECORD_NOT_FOUND");
    switch (command.type) {
      case "proactive.settings.set": {
        await store.writeSettings({
          ...scope,
          enabled: command.payload.enabled,
          quietHours: command.payload.quietHours.map((period) => ({
            days: [...new Set(period.days)].sort(),
            start: period.start,
            end: period.end,
          })),
          importantSenders: [...new Set(command.payload.importantSenders.map(normalizeSender))],
          now,
        });
        return { resultRef: "proactive-settings", replayed: false };
      }
      case "proactive.pause": {
        await store.setEnabled({ ...scope, enabled: false, now });
        return { resultRef: "proactive-settings", replayed: false };
      }
      case "proactive.insight.respond": {
        const { insightId, action, rating } = command.payload;
        if (action === "rate" && rating === null)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "PROACTIVE_RATING_REQUIRED",
          );
        const updated = await store.updateInsight({
          ...scope,
          insightId,
          ...(action === "rate"
            ? { rating }
            : { status: action === "done" ? "done" : action === "mute" ? "muted" : "open" }),
          now,
        });
        if (!updated) throw missing();
        return { resultRef: insightId, replayed: false };
      }
      case "proactive.decision.rate": {
        const rated = await store.rateDecision({
          ...scope,
          decisionId: command.payload.decisionId,
          rating: command.payload.rating,
          now,
        });
        if (!rated) throw missing();
        return { resultRef: command.payload.decisionId, replayed: false };
      }
      case "proactive.audit.respond": {
        const { action, messageIds, rating } = command.payload;
        if (action === "review") {
          const reviewed = await store.markReviewed({
            ...scope,
            source: GMAIL_SOURCE.name,
            messageIds,
            now,
          });
          return { resultRef: `proactive-reviewed:${reviewed}`, replayed: false };
        }
        let rated = 0;
        for (const messageId of messageIds)
          if (
            await store.rateProcessed({
              ...scope,
              source: GMAIL_SOURCE.name,
              messageId,
              rating,
              now,
            })
          )
            rated += 1;
        if (rated === 0) throw missing();
        return { resultRef: `proactive-rated:${rated}`, replayed: false };
      }
      case "proactive.review.rate": {
        const ledgerRatings: { decisionId: string; rating: ProactiveRating | null }[] = [];
        const mailRatings: { messageId: string; rating: ProactiveRating | null }[] = [];
        for (const { key, rating } of command.payload.ratings) {
          const parsed = parseReviewKey(key);
          if (
            !parsed ||
            parsed.source === "checkup" ||
            (parsed.source === "mail" && rating === "unneeded")
          )
            throw new ApplicationPortError(
              PORT_ERROR_CODES.INVALID_OPERATION,
              "PROACTIVE_REVIEW_KEY_INVALID",
            );
          if (parsed.source === "ledger") ledgerRatings.push({ decisionId: parsed.id, rating });
          else mailRatings.push({ messageId: parsed.id, rating });
        }
        if (ledgerRatings.length > 0)
          await this.#options.ledger
            .rateMany({ ...scope, ratings: ledgerRatings, now })
            .catch((error: unknown) => {
              if (error instanceof ApplicationPortError) throw missing();
              throw error;
            });
        for (const { messageId, rating } of mailRatings) {
          const found = await store.rateProcessed({
            ...scope,
            source: GMAIL_SOURCE.name,
            messageId,
            rating: rating === "useful" ? null : rating,
            now,
          });
          if (!found) throw missing();
          if (rating !== null)
            await store.markReviewed({
              ...scope,
              source: GMAIL_SOURCE.name,
              messageIds: [messageId],
              now,
            });
        }
        return {
          resultRef: `proactive-review-rated:${ledgerRatings.length + mailRatings.length}`,
          replayed: false,
        };
      }
      case "proactive.review.checkup": {
        const checkup = this.#options.checkup;
        if (!checkup) throw new Error("PROACTIVE_OPERATION_NOT_INSTALLED");
        const { key, action, keep } = command.payload;
        const parsed = parseReviewKey(key);
        if (parsed?.source !== "checkup")
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "PROACTIVE_REVIEW_KEY_INVALID",
          );
        if (action === "undo") {
          await checkup.undo(parsed.id);
          return { resultRef: key, replayed: false };
        }
        const shown = (await this.review({ strict: true })).items.some((item) => item.key === key);
        if (!shown)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "PROACTIVE_REVIEW_BUDGET_USED",
          );
        await checkup.act({
          id: parsed.id,
          action,
          keep: keep as Parameters<MemoryCheckupService["act"]>[0]["keep"],
        });
        return { resultRef: key, replayed: false };
      }
      case "proactive.source.settings.set": {
        const { source, enabled, perDay, perCheck } = command.payload;
        const definition = this.#registry.get(source);
        if (definition === undefined || !proactiveSourceLimitsValid(definition, command.payload))
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "PROACTIVE_SOURCE_SETTINGS_INVALID",
          );
        await store.writeSourceSettings({
          ...scope,
          source: definition.name,
          enabled,
          perDay,
          perCheck,
          changeId: this.#options.ids.next("limit-change"),
          now,
        });
        return { resultRef: `proactive-source-settings:${definition.name}`, replayed: false };
      }
      case "proactive.source.switch_off": {
        const definition = this.#registry.get(command.payload.source);
        if (definition === undefined)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "PROACTIVE_SOURCE_NOT_REGISTERED",
          );
        const current = await readProactiveSourceSettings(store, scope, definition.name);
        if (current === undefined)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "PROACTIVE_SOURCE_NOT_REGISTERED",
          );
        await store.writeSourceSettings({
          ...scope,
          source: definition.name,
          enabled: false,
          perDay: current.perDay,
          perCheck: current.perCheck,
          changeId: this.#options.ids.next("limit-change"),
          now,
        });
        return { resultRef: `proactive-source-off:${definition.name}`, replayed: false };
      }
      case "proactive.source.manage": {
        const managed = this.#registry.get(command.payload.source);
        if (managed === undefined)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "PROACTIVE_SOURCE_NOT_REGISTERED",
          );
        if (command.payload.action === "clear_records") {
          const released = await store.clearRecords({ ...scope, source: managed.name });
          if (released.length > 0) await seal.release({ ...scope, refs: released });
          return { resultRef: "proactive-cleared", replayed: false };
        }
        const connection = await store.readConnection({ ...scope, source: managed.name });
        if (connection && managed.name === GMAIL_SOURCE.name) {
          const token = await seal.open({ ...scope, ref: connection.tokenRef });
          if (token) await this.#options.oauth.revoke(token).catch(() => false);
        }
        const released = await store.removeSource({ ...scope, source: managed.name });
        if (released.length > 0) await seal.release({ ...scope, refs: released });
        return { resultRef: "proactive-disconnected", replayed: false };
      }
      default:
        throw new Error("PROACTIVE_OPERATION_NOT_INSTALLED");
    }
  }
}
