import { randomBytes } from "node:crypto";
import {
  ApplicationPortError,
  type ClockPort,
  type DailyReview,
  type DecisionLedgerPort,
  type IdGeneratorPort,
  PORT_ERROR_CODES,
  type ProactiveConfiguration,
  type ProactiveDecision,
  ProactiveMailCheckService,
  type ProactiveMailCheckOptions,
  type ProactiveMemoryRecall,
  type ProactiveModelInvoker,
  type ProactiveOverview,
  type ProactiveRating,
  type ProactiveScope,
  type ProactiveSealPort,
  type ProactiveSourceReader,
  type ProactiveStorePort,
  parseReviewKey,
  type DailyReviewMemoryText,
  readDailyReview,
  readProactiveOverview,
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
  "proactive.insight.respond",
  "proactive.decision.rate",
  "proactive.audit.respond",
  "proactive.review.read",
  "proactive.review.rate",
  "proactive.source.manage",
] as const);

export const PROACTIVE_GOOGLE_START_PATH = "/api/proactive/v1/google/start";
export const PROACTIVE_GOOGLE_CALLBACK_PATH = "/api/proactive/v1/google/callback";
export const PROACTIVE_MAX_OUTPUT_TOKENS = 4096;

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
  return [...text.replace(/\p{Cc}+/gu, " ").trim()].slice(0, limit).join("");
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
  readonly seal: ProactiveSealPort;
  readonly oauth: GoogleOAuth;
  readonly reader: ProactiveSourceReader;
  readonly readAccount: (accessToken: string) => Promise<string>;
  readonly model: ProactiveModelInvoker;
  readonly memory?: ProactiveMemoryRecall;
  readonly ledger: Pick<DecisionLedgerPort, "listReviewPool" | "rateMany">;
  readonly readMemoryText: (ref: string) => Promise<string | undefined>;
  readonly readMemory?: (memoryId: string) => Promise<DailyReviewMemoryText | undefined>;
  readonly estimateCostMicros: (prompt: string) => number;
  readonly feedback: (sentFrom: string) => Promise<readonly WebPushFeedback[]>;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly onDecision?: (decision: ProactiveDecision) => void;
  readonly onFailure: (error: unknown) => void;
  readonly onMasked?: ProactiveMailCheckOptions["onMasked"];
}

export type ProactiveAuthorizationOutcome = "connected" | "denied" | "failed";

export class ProductionProactive {
  readonly #options: ProductionProactiveOptions;
  readonly #service: ProactiveMailCheckService;
  readonly #states = new Map<string, { readonly owner: string; readonly expiresAt: number }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(options: ProductionProactiveOptions) {
    this.#options = options;
    this.#service = new ProactiveMailCheckService({
      scope: options.scope,
      store: options.store,
      seal: options.seal,
      reader: options.reader,
      model: options.model,
      ...(options.memory ? { memory: options.memory } : {}),
      limits: {
        perCheckMs: options.configuration.perCheckMs,
        dailyCostMicros: options.configuration.dailyCostMicros,
        estimateCostMicros: options.estimateCostMicros,
      },
      timeZone: options.timeZone,
      clock: options.clock,
      ids: options.ids,
      outputTokenLimit: PROACTIVE_MAX_OUTPUT_TOKENS,
      bodyLimits: {
        perMail: options.configuration.bodyCharactersPerMail,
        perBatch: options.configuration.bodyCharactersPerBatch,
      },
      relatedLimits: {
        perMail: options.configuration.relatedMailsPerMail,
        requestsPerCheck: options.configuration.relatedRequestsPerCheck,
        charactersPerRelated: options.configuration.relatedCharactersPerRelatedMail,
        charactersPerMail: options.configuration.relatedCharactersPerMail,
      },
      ...(options.onMasked ? { onMasked: options.onMasked } : {}),
    });
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
    this.#running ??= this.#service
      .run()
      .then((decision) => {
        if (decision) this.#options.onDecision?.(decision);
      })
      .catch(this.#options.onFailure)
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
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
    const now = Date.parse(this.#options.clock.now());
    for (const [state, entry] of this.#states)
      if (entry.expiresAt <= now) this.#states.delete(state);
    while (this.#states.size >= MAX_PENDING_STATES) {
      const oldest = this.#states.keys().next().value;
      if (oldest === undefined) break;
      this.#states.delete(oldest);
    }
    const state = randomBytes(24).toString("base64url");
    this.#states.set(state, { owner, expiresAt: now + STATE_TTL_MS });
    return this.#options.oauth.authorizationUrl(state);
  }

  async completeAuthorization(input: {
    readonly owner: string;
    readonly state: string | null;
    readonly code: string | null;
    readonly error: string | null;
  }): Promise<ProactiveAuthorizationOutcome> {
    const pending = input.state ? this.#states.get(input.state) : undefined;
    if (input.state) this.#states.delete(input.state);
    if (
      !pending ||
      pending.owner !== input.owner ||
      pending.expiresAt <= Date.parse(this.#options.clock.now())
    )
      return "failed";
    if (input.error) return input.error === "access_denied" ? "denied" : "failed";
    if (!input.code) return "failed";
    const { scope, store, seal, oauth } = this.#options;
    try {
      const granted = await oauth.exchange(input.code);
      const account = await this.#options.readAccount(granted.accessToken);
      const now = this.#options.clock.now();
      const existing = await store.readConnection({ ...scope, source: "gmail" });
      const sameAccount =
        existing !== undefined &&
        (await seal.open({ ...scope, ref: existing.accountRef })) === account;
      const released = await store.saveConnection({
        ...scope,
        connection: {
          source: "gmail",
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

  async overview(): Promise<ProactiveOverview> {
    return readProactiveOverview({
      scope: this.#options.scope,
      source: "gmail",
      store: this.#options.store,
      seal: this.#options.seal,
      timeZone: this.#options.timeZone,
      dailyCostMicros: this.#options.configuration.dailyCostMicros,
      now: this.#options.clock.now(),
      feedback: this.#options.feedback,
    });
  }

  async review(): Promise<DailyReview> {
    return readDailyReview({
      scope: this.#options.scope,
      ledger: this.#options.ledger,
      overview: await this.overview(),
      readMemoryText: this.#options.readMemoryText,
      ...(this.#options.readMemory ? { readMemory: this.#options.readMemory } : {}),
      timeZone: this.#options.timeZone,
      now: this.#options.clock.now(),
      budgetSeconds: this.#options.configuration.reviewBudgetSeconds,
      secondsPerItem: this.#options.configuration.reviewSecondsPerItem,
      silentShare: this.#options.configuration.reviewSilentSharePermille,
    });
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type === "proactive.review.read") {
      const review = await this.review();
      const item = (entry: DailyReview["items"][number]) => ({
        ...entry,
        text: clean(entry.text, 200),
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
          items: review.items.map(item),
          folded: { total: review.folded.total, items: review.folded.items.map(item) },
          generatedAt: this.#options.clock.now(),
        },
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
          const reviewed = await store.markReviewed({ ...scope, source: "gmail", messageIds, now });
          return { resultRef: `proactive-reviewed:${reviewed}`, replayed: false };
        }
        let rated = 0;
        for (const messageId of messageIds)
          if (await store.rateProcessed({ ...scope, source: "gmail", messageId, rating, now }))
            rated += 1;
        if (rated === 0) throw missing();
        return { resultRef: `proactive-rated:${rated}`, replayed: false };
      }
      case "proactive.review.rate": {
        const ledgerRatings: { decisionId: string; rating: ProactiveRating | null }[] = [];
        const mailRatings: { messageId: string; rating: ProactiveRating | null }[] = [];
        for (const { key, rating } of command.payload.ratings) {
          const parsed = parseReviewKey(key);
          if (!parsed || (parsed.source === "mail" && rating === "unneeded"))
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
            source: "gmail",
            messageId,
            rating: rating === "useful" ? null : rating,
            now,
          });
          if (!found) throw missing();
          if (rating !== null)
            await store.markReviewed({ ...scope, source: "gmail", messageIds: [messageId], now });
        }
        return {
          resultRef: `proactive-review-rated:${ledgerRatings.length + mailRatings.length}`,
          replayed: false,
        };
      }
      case "proactive.source.manage": {
        if (command.payload.action === "clear_records") {
          const released = await store.clearRecords(scope);
          if (released.length > 0) await seal.release({ ...scope, refs: released });
          return { resultRef: "proactive-cleared", replayed: false };
        }
        const connection = await store.readConnection({ ...scope, source: "gmail" });
        if (connection) {
          const token = await seal.open({ ...scope, ref: connection.tokenRef });
          if (token) await this.#options.oauth.revoke(token).catch(() => false);
        }
        const released = await store.removeSource({ ...scope, source: "gmail" });
        if (released.length > 0) await seal.release({ ...scope, refs: released });
        return { resultRef: "proactive-disconnected", replayed: false };
      }
      default:
        throw new Error("PROACTIVE_OPERATION_NOT_INSTALLED");
    }
  }
}
