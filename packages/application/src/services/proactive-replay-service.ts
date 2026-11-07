import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import type {
  ProactiveCheckRecord,
  ProactiveConnection,
  ProactiveDecision,
  ProactiveScope,
  ProactiveSealPort,
  ProactiveSettings,
  ProactiveSourceItem,
  ProactiveStorePort,
} from "../ports/proactive-checks.js";
import {
  PROACTIVE_HISTORY_READ_CHUNK,
  PROACTIVE_REPLAY_BUDGET_LIMIT_MICROS,
  PROACTIVE_REPLAY_MAIL_LIMIT,
  type ProactiveHistoryReader,
  type ProactiveReplayResult,
  type ProactiveReplayStorePort,
} from "../ports/proactive-replays.js";
import {
  type ProactiveBodyLimits,
  ProactiveMailCheckService,
  type ProactiveModelInvoker,
} from "./proactive-mail-check-service.js";

export const PROACTIVE_REPLAY_ERROR_CODES = Object.freeze({
  INVALID: "PROACTIVE_REPLAY_INVALID",
  NOT_CONNECTED: "PROACTIVE_REPLAY_NOT_CONNECTED",
  ALREADY_RUNNING: "PROACTIVE_REPLAY_ALREADY_RUNNING",
  STOPPING: "PROACTIVE_REPLAY_STOPPING",
} as const);

const CONSECUTIVE_FAILURE_LIMIT = 3;

export interface ProactiveReplayOptions {
  readonly scope: ProactiveScope;
  readonly store: Pick<ProactiveStorePort, "readSettings" | "readConnection">;
  readonly replays: ProactiveReplayStorePort;
  readonly seal: ProactiveSealPort;
  readonly history: ProactiveHistoryReader;
  readonly model: ProactiveModelInvoker;
  readonly perCheckMs: number;
  readonly estimateCostMicros: (prompt: string) => number;
  readonly timeZone: string;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly outputTokenLimit?: number;
  readonly bodyLimits?: Partial<ProactiveBodyLimits>;
}

export interface ProactiveReplayRequest {
  readonly from: string;
  readonly to: string;
  readonly mailLimit: number;
  readonly budgetMicros: number;
}

interface Captured {
  record: ProactiveCheckRecord | undefined;
}

function instant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isolatedStore(
  settings: ProactiveSettings,
  connection: ProactiveConnection,
  spent: () => number,
  captured: Captured,
): ProactiveStorePort {
  const refuse = () => Promise.reject(new Error("PROACTIVE_REPLAY_STORE_REFUSED"));
  return Object.freeze<ProactiveStorePort>({
    readSettings: async () => ({ ...settings, enabled: true }),
    readConnection: async () => ({ ...connection, cursor: null }),
    unprocessed: async ({ messageIds }) => messageIds,
    costSince: async () => spent(),
    pendingPush: async () => undefined,
    markConnection: async () => undefined,
    record: async (input) => {
      captured.record = input;
      return { insightIds: input.insights.map(({ id }) => id), releasedRefs: [] };
    },
    writeSettings: refuse,
    saveConnection: refuse,
    removeSource: refuse,
    clearRecords: refuse,
    readDecisionPayloads: refuse,
    readInsight: refuse,
    listInsights: refuse,
    listDecisions: refuse,
    listProcessed: refuse,
    reviewedCount: refuse,
    updateInsight: refuse,
    rateDecision: refuse,
    rateProcessed: refuse,
    markReviewed: refuse,
    listReadyPushes: refuse,
    markPushEnqueued: refuse,
    readPush: refuse,
    readInsights: refuse,
  });
}

export class ProactiveReplayService {
  readonly #options: ProactiveReplayOptions;
  #cancelled = false;
  #active: Promise<void> | undefined;

  constructor(options: ProactiveReplayOptions) {
    this.#options = options;
  }

  async interruptStale(): Promise<number> {
    return this.#options.replays.interruptRunning({
      ...this.#options.scope,
      now: this.#options.clock.now(),
    });
  }

  async cancel(): Promise<void> {
    this.#cancelled = true;
    await this.#active;
  }

  async deleteRun(runId: string): Promise<void> {
    const refs = await this.#options.replays.deleteRun({ ...this.#options.scope, runId });
    if (refs.length > 0) await this.#options.seal.release({ ...this.#options.scope, refs });
  }

  readRun(runId: string) {
    return this.#options.replays.readRun({ ...this.#options.scope, runId });
  }

  async start(
    request: ProactiveReplayRequest,
  ): Promise<{ readonly runId: string; readonly done: Promise<void> }> {
    const { scope, store, replays, history, clock, ids } = this.#options;
    if (this.#cancelled)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        PROACTIVE_REPLAY_ERROR_CODES.STOPPING,
      );
    if (
      !instant(request.from) ||
      !instant(request.to) ||
      Date.parse(request.from) >= Date.parse(request.to) ||
      Date.parse(request.to) > Date.parse(clock.now()) ||
      !Number.isSafeInteger(request.mailLimit) ||
      request.mailLimit < 1 ||
      request.mailLimit > PROACTIVE_REPLAY_MAIL_LIMIT ||
      !Number.isSafeInteger(request.budgetMicros) ||
      request.budgetMicros < 1 ||
      request.budgetMicros > PROACTIVE_REPLAY_BUDGET_LIMIT_MICROS
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        PROACTIVE_REPLAY_ERROR_CODES.INVALID,
      );
    const connection = await store.readConnection({ ...scope, source: history.source });
    if (!connection || connection.status !== "connected")
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        PROACTIVE_REPLAY_ERROR_CODES.NOT_CONNECTED,
      );
    const runId = ids.next("proactive-replay");
    const started = await replays.startRun({
      ...scope,
      id: runId,
      source: history.source,
      rangeFrom: request.from,
      rangeTo: request.to,
      mailLimit: request.mailLimit,
      budgetMicros: request.budgetMicros,
      now: clock.now(),
    });
    if (!started)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        PROACTIVE_REPLAY_ERROR_CODES.ALREADY_RUNNING,
      );
    const done = this.#execute(runId, connection, request).catch(async () => {
      await replays
        .finishRun({
          ...scope,
          runId,
          status: "failed",
          reasonCode: "REPLAY_ERROR",
          now: clock.now(),
        })
        .catch(() => undefined);
    });
    this.#active = done;
    return { runId, done };
  }

  async #execute(
    runId: string,
    connection: ProactiveConnection,
    request: ProactiveReplayRequest,
  ): Promise<void> {
    const { scope, store, replays, seal, history, clock } = this.#options;
    const finish = (status: "finished" | "failed" | "interrupted", reasonCode: string) =>
      replays.finishRun({ ...scope, runId, status, reasonCode, now: clock.now() });
    const token = await seal.open({ ...scope, ref: connection.tokenRef });
    if (!token) return finish("failed", "SOURCE_TOKEN_MISSING");
    const signal = AbortSignal.timeout(this.#options.perCheckMs);
    const listed = await history
      .list({ token, from: request.from, to: request.to, limit: request.mailLimit, signal })
      .catch(() => ({ kind: "failed" as const, step: "list" }));
    if (listed.kind === "unauthorized") return finish("failed", "SOURCE_UNAUTHORIZED");
    if (listed.kind === "failed") return finish("failed", this.#readCode(listed.step));
    const messageIds = [...new Set(listed.ids)].slice(0, request.mailLimit);
    await replays.markListed({ ...scope, runId, listed: messageIds.length });
    const settings = await store.readSettings(scope);
    let spent = 0;
    let failures = 0;
    for (let start = 0; start < messageIds.length; start += PROACTIVE_HISTORY_READ_CHUNK) {
      const read = await history
        .read({
          token,
          messageIds: messageIds.slice(start, start + PROACTIVE_HISTORY_READ_CHUNK),
          signal: AbortSignal.timeout(this.#options.perCheckMs),
        })
        .catch(() => ({ kind: "failed" as const, step: "message" }));
      if (read.kind === "unauthorized") return finish("failed", "SOURCE_UNAUTHORIZED");
      if (read.kind === "failed") return finish("failed", this.#readCode(read.step));
      const inRange = read.items.filter(
        ({ receivedAt }) =>
          Date.parse(receivedAt) >= Date.parse(request.from) &&
          Date.parse(receivedAt) < Date.parse(request.to),
      );
      for (const item of inRange) {
        if (this.#cancelled) return finish("interrupted", "SERVICE_STOPPING");
        const captured: Captured = { record: undefined };
        const decision = await this.#judge(
          item,
          settings,
          connection,
          request,
          () => spent,
          captured,
        );
        const record = captured.record;
        if (record && record.modelPayloads.length > 0)
          await this.#options.model
            .release(record.modelPayloads.map(({ ref }) => ref))
            .catch(() => undefined);
        if (decision.verdict === "needs_owner") {
          await this.#releaseSealed(record);
          return finish("failed", decision.reasonCode);
        }
        if (decision.verdict === "capped_daily") {
          await this.#releaseSealed(record);
          return finish("finished", "BUDGET_REACHED");
        }
        spent += decision.costMicros;
        const result = this.#result(item, decision, record);
        const stored = await replays
          .recordResult({ ...scope, runId, result })
          .catch(async (error: unknown) => {
            await this.#releaseSealed(record);
            throw error;
          });
        if (!stored) {
          await this.#releaseSealed(record);
          return;
        }
        if (result.outcome === "failed") failures += 1;
        else if (result.outcome !== "skipped") failures = 0;
        if (failures >= CONSECUTIVE_FAILURE_LIMIT) return finish("failed", "REPEATED_FAILURES");
      }
    }
    return finish("finished", "COMPLETED");
  }

  #judge(
    item: ProactiveSourceItem,
    settings: ProactiveSettings,
    connection: ProactiveConnection,
    request: ProactiveReplayRequest,
    spent: () => number,
    captured: Captured,
  ): Promise<ProactiveDecision> {
    const options = this.#options;
    const service = new ProactiveMailCheckService({
      scope: options.scope,
      store: isolatedStore(settings, connection, spent, captured),
      seal: options.seal,
      reader: Object.freeze({
        source: item.source,
        fetch: async () => ({ kind: "items" as const, items: [item], cursor: null }),
      }),
      model: options.model,
      limits: {
        perCheckMs: options.perCheckMs,
        dailyCostMicros: request.budgetMicros,
        estimateCostMicros: options.estimateCostMicros,
      },
      timeZone: options.timeZone,
      clock: options.clock,
      ids: options.ids,
      asOf: item.receivedAt,
      ...(options.outputTokenLimit === undefined
        ? {}
        : { outputTokenLimit: options.outputTokenLimit }),
      ...(options.bodyLimits ? { bodyLimits: options.bodyLimits } : {}),
    });
    return service.run().then((decision) => {
      if (!decision) throw new Error("PROACTIVE_REPLAY_NOT_RUN");
      return decision;
    });
  }

  async #releaseSealed(record: ProactiveCheckRecord | undefined): Promise<void> {
    if (!record) return;
    const refs = [
      ...record.insights.map(({ contentRef }) => contentRef),
      ...record.processed.flatMap(({ headerRef }) => (headerRef ? [headerRef] : [])),
    ];
    if (refs.length > 0)
      await this.#options.seal.release({ ...this.#options.scope, refs }).catch(() => undefined);
  }

  #result(
    item: ProactiveSourceItem,
    decision: ProactiveDecision,
    record: ProactiveCheckRecord | undefined,
  ): ProactiveReplayResult {
    const processed = record?.processed.find(({ messageId }) => messageId === item.messageId);
    const insight = record?.insights.find(({ lastMessageId }) => lastMessageId === item.messageId);
    const floorHit = (record?.inputs.floorHits[item.messageId]?.length ?? 0) > 0;
    const base = {
      messageId: item.messageId,
      threadId: item.threadId,
      receivedAt: item.receivedAt,
      sentByOwner: item.sentByOwner,
      floorHit,
      costMicros: decision.costMicros,
      judgedAt: this.#options.clock.now(),
    };
    if (!processed)
      return {
        ...base,
        outcome: "failed",
        reasonCode: decision.reasonCode,
        floorRaised: false,
        push: false,
        priority: null,
        dueAt: null,
        contentRef: null,
      };
    return {
      ...base,
      outcome: processed.outcome,
      reasonCode: processed.outcome === "skipped" ? (processed.skipReason ?? null) : null,
      floorRaised: insight?.floorRaised ?? false,
      push: insight?.push ?? false,
      priority: insight?.priority ?? null,
      dueAt: insight?.dueAt ?? null,
      contentRef: insight?.contentRef ?? processed.headerRef ?? null,
    };
  }

  #readCode(step: string): string {
    return `READ_${step.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}`.slice(0, 64);
  }
}
