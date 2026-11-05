import type { RunId } from "@himawari-agent/domain";
import {
  MAIL_JUDGMENT,
  MAIL_JUDGMENT_ITEMS_HEADER,
  MAIL_JUDGMENT_MEMORIES_HEADER,
  MAIL_JUDGMENT_NOW,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import type { ModelInvocationRequest, ModelPort } from "../ports/intelligence.js";
import type {
  ProactiveCheckInputs,
  ProactiveConfidence,
  ProactiveCounts,
  ProactiveDecision,
  ProactiveInsightWrite,
  ProactiveMemoryHit,
  ProactiveMemoryRecall,
  ProactiveMemoryRecallStatus,
  ProactiveModelPayload,
  ProactivePriority,
  ProactiveProcessedMessage,
  ProactiveResult,
  ProactiveScope,
  ProactiveSealPort,
  ProactiveSettings,
  ProactiveSourceItem,
  ProactiveSourceReader,
  ProactiveStorePort,
  ProactiveVerdict,
} from "../ports/proactive-checks.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import {
  applyFloor,
  floorHitIds,
  keepOffReminderPage,
  quietUntil,
  startOfZonedDay,
} from "./proactive-rules.js";

const LOOKBACK_MS = 3 * 24 * 3_600_000;
const PUSH_WINDOW_MS = 48 * 3_600_000;
const OVERDUE_PUSH_MS = 24 * 3_600_000;
const MAX_OUTPUT_BYTES = 65_536;

export interface ProactiveModelAuthority {
  readonly runId: RunId;
  readonly inputRef: string;
  readonly allowedDisclosureRef: string;
  readonly secretHandleRefs: readonly string[];
  release(): Promise<void>;
}

export interface ProactiveModelInvoker {
  readonly model: ModelPort;
  readonly modelRef: string;
  prepare(input: {
    readonly invocationId: string;
    readonly prompt: string;
    readonly deadlineAt: string;
  }): Promise<ProactiveModelAuthority>;
  readOutput(payloadRef: string): Promise<string>;
  release(payloadRefs: readonly string[]): Promise<void>;
}

export interface ProactiveLimits {
  readonly perCheckMs: number;
  readonly dailyCostMicros: number;
  estimateCostMicros(prompt: string): number;
}

export interface ProactiveMailCheckOptions {
  readonly scope: ProactiveScope;
  readonly store: ProactiveStorePort;
  readonly seal: ProactiveSealPort;
  readonly reader: ProactiveSourceReader;
  readonly model: ProactiveModelInvoker;
  readonly limits: ProactiveLimits;
  readonly timeZone: string;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly batchSize?: number;
  readonly outputTokenLimit?: number;
  readonly memory?: ProactiveMemoryRecall;
  readonly memoryLimits?: Partial<ProactiveMemoryLimits>;
}

export interface ProactiveMemoryLimits {
  readonly perMail: number;
  readonly perBatch: number;
  readonly charactersPerMemory: number;
  readonly searchesPerCheck: number;
  readonly queryCharacters: number;
}

export const DEFAULT_PROACTIVE_MEMORY_LIMITS: ProactiveMemoryLimits = Object.freeze({
  perMail: 3,
  perBatch: 12,
  charactersPerMemory: 200,
  searchesPerCheck: 40,
  queryCharacters: 500,
});

interface PromptMemory {
  readonly mailId: string;
  readonly id: string;
  readonly text: string;
}

interface Judgement {
  readonly result: ProactiveResult;
  readonly confidence: ProactiveConfidence;
  readonly todo: string;
  readonly reason: string;
  readonly dueAt: string | null;
  readonly priority: ProactivePriority | null;
  readonly usedMemoryIds: readonly string[];
}

type Stop = "capped" | "capped_daily" | "failed" | null;

const DEFAULT_BATCH_SIZE = 8;

interface CheckTrace {
  readonly payloads: ProactiveModelPayload[];
  readonly sealed: string[];
  readonly sourceIds: Set<string>;
  readonly memoryIds: Set<string>;
  readonly usedMemoryIds: Set<string>;
  readonly memoryByMail: Map<string, string[]>;
  memoryRecall: ProactiveMemoryRecallStatus;
  recorded: boolean;
}

interface JudgeOutcome {
  readonly judgements: ReadonlyMap<string, Judgement> | undefined;
  readonly costMicros: number;
  readonly failure: string | null;
}

function failureCode(prefix: string, detail: string): string {
  return `${prefix}_${detail.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}`.slice(0, 64);
}

const EMPTY_COUNTS: ProactiveCounts = Object.freeze({
  fetched: 0,
  skipped: 0,
  judged: 0,
  act: 0,
  know: 0,
  check: 0,
  ignore: 0,
  floorRaised: 0,
  pushed: 0,
});

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, limit) : "";
}

function instant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function proactivePrompt(
  items: readonly ProactiveSourceItem[],
  now: string,
  timeZone: string,
  memories: readonly PromptMemory[] = [],
): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).format(new Date(now));
  return [
    MAIL_JUDGMENT.text,
    ...(memories.length > 0 ? [MAIL_JUDGMENT_MEMORIES_HEADER.text, JSON.stringify(memories)] : []),
    MAIL_JUDGMENT_ITEMS_HEADER.text,
    JSON.stringify(
      items.map((item) => ({
        id: item.messageId,
        from: item.from,
        subject: item.subject,
        snippet: item.snippet,
        receivedAt: item.receivedAt,
      })),
    ),
    renderPrompt(MAIL_JUDGMENT_NOW, { now, timeZone, today }),
  ].join("\n");
}

function completeEntries(output: string): readonly Record<string, unknown>[] | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const list = (JSON.parse(output.slice(start, end + 1)) as { items?: unknown }).items;
    if (Array.isArray(list))
      return list.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      );
  } catch {
    return salvagedEntries(output);
  }
  return undefined;
}

function salvagedEntries(output: string): readonly Record<string, unknown>[] | undefined {
  const marker = output.search(/"items"\s*:\s*\[/u);
  if (marker < 0) return undefined;
  const entries: Record<string, unknown>[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;
  for (let index = output.indexOf("[", marker) + 1; index < output.length; index += 1) {
    const char = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        try {
          const entry = JSON.parse(output.slice(objectStart, index + 1)) as unknown;
          if (typeof entry === "object" && entry !== null && !Array.isArray(entry))
            entries.push(entry as Record<string, unknown>);
        } catch {
          return entries;
        }
        objectStart = -1;
      }
    }
  }
  return entries;
}

export function parseJudgements(
  output: string,
  items: readonly ProactiveSourceItem[],
): ReadonlyMap<string, Judgement> | undefined {
  const entries = completeEntries(output);
  if (entries === undefined) return undefined;
  const wanted = new Set(items.map(({ messageId }) => messageId));
  const judgements = new Map<string, Judgement>();
  for (const entry of entries) {
    const id = entry["id"];
    const result = entry["result"];
    const confidence = entry["confidence"];
    if (
      typeof id !== "string" ||
      !wanted.has(id) ||
      judgements.has(id) ||
      !["act", "know", "check", "ignore"].includes(result as string) ||
      !["sure", "unsure"].includes(confidence as string)
    )
      continue;
    const priority =
      typeof entry["priority"] === "string" ? entry["priority"].trim().toLowerCase() : null;
    const used = entry["usedMemoryIds"];
    judgements.set(id, {
      usedMemoryIds: Array.isArray(used)
        ? used.filter((value): value is string => typeof value === "string").slice(0, 16)
        : [],
      result: result as ProactiveResult,
      confidence: confidence as ProactiveConfidence,
      todo: text(entry["todo"], 200),
      reason: text(entry["reason"], 200),
      dueAt: instant(entry["dueAt"]),
      priority: ["high", "medium", "low"].includes(priority as string)
        ? (priority as ProactivePriority)
        : null,
    });
  }
  return judgements.size > 0 ? judgements : undefined;
}

export class ProactiveMailCheckService {
  readonly #options: ProactiveMailCheckOptions;

  constructor(options: ProactiveMailCheckOptions) {
    this.#options = options;
  }

  async run(): Promise<ProactiveDecision | undefined> {
    const { store, scope, reader } = this.#options;
    const settings = await store.readSettings(scope);
    if (!settings.enabled) return undefined;
    const connection = await store.readConnection({ ...scope, source: reader.source });
    if (!connection || connection.status !== "connected") return undefined;
    const startedAt = this.#options.clock.now();
    const deadlineAt = new Date(
      Date.parse(startedAt) + this.#options.limits.perCheckMs,
    ).toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.limits.perCheckMs);
    try {
      return await this.#check(settings, connection.tokenRef, startedAt, deadlineAt, controller);
    } finally {
      clearTimeout(timer);
    }
  }

  async #check(
    settings: ProactiveSettings,
    tokenRef: string,
    startedAt: string,
    deadlineAt: string,
    controller: AbortController,
  ): Promise<ProactiveDecision> {
    const trace: CheckTrace = {
      payloads: [],
      sealed: [],
      sourceIds: new Set(),
      memoryIds: new Set(),
      usedMemoryIds: new Set(),
      memoryByMail: new Map(),
      memoryRecall: "off",
      recorded: false,
    };
    try {
      return await this.#checkTraced(settings, tokenRef, startedAt, deadlineAt, controller, trace);
    } catch (error) {
      if (!trace.recorded) {
        if (trace.payloads.length > 0)
          await this.#options.model
            .release(trace.payloads.map(({ ref }) => ref))
            .catch(() => undefined);
        if (trace.sealed.length > 0)
          await this.#options.seal
            .release({ ...this.#options.scope, refs: trace.sealed })
            .catch(() => undefined);
      }
      throw error;
    }
  }

  async #checkTraced(
    settings: ProactiveSettings,
    tokenRef: string,
    startedAt: string,
    deadlineAt: string,
    controller: AbortController,
    trace: CheckTrace,
  ): Promise<ProactiveDecision> {
    const { store, scope, reader, seal } = this.#options;
    const token = await seal.open({ ...scope, ref: tokenRef });
    if (!token) return this.#needsOwner(trace, startedAt, "SOURCE_TOKEN_MISSING");
    const fetched = await reader
      .fetch({
        token,
        cursor: (await store.readConnection({ ...scope, source: reader.source }))?.cursor ?? null,
        since: new Date(Date.parse(startedAt) - LOOKBACK_MS).toISOString(),
        signal: controller.signal,
        unseen: (messageIds) => store.unprocessed({ ...scope, source: reader.source, messageIds }),
      })
      .catch(() => ({
        kind: "failed" as const,
        step: controller.signal.aborted ? "timeout" : "read",
      }));
    if (fetched.kind === "unauthorized")
      return this.#needsOwner(trace, startedAt, "SOURCE_UNAUTHORIZED");
    if (fetched.kind === "failed")
      return this.#finish(trace, {
        startedAt,
        verdict: "failed",
        reasonCode: `READ_${fetched.step.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}`.slice(0, 64),
        counts: EMPTY_COUNTS,
        processed: [],
        insights: [],
        replied: [],
        costMicros: 0,
        cursor: null,
        quietHours: [],
        floorHits: {},
      });
    const fresh = new Set(
      await store.unprocessed({
        ...scope,
        source: reader.source,
        messageIds: fetched.items.map(({ messageId }) => messageId),
      }),
    );
    const items = fetched.items.filter(({ messageId }) => fresh.has(messageId));
    const processed: ProactiveCheckProcessed[] = [];
    const replied: string[] = [];
    const candidates: ProactiveSourceItem[] = [];
    for (const item of items) {
      if (item.sentByOwner) {
        replied.push(item.threadId);
        processed.push(this.#skip(item, "own_mail"));
      } else if (item.categories.includes("spam")) processed.push(this.#skip(item, "category"));
      else candidates.push(item);
    }
    const spentToday = await store.costSince({
      ...scope,
      since: startOfZonedDay(startedAt, this.#options.timeZone),
    });
    const judged = new Map<string, Judgement>();
    let costMicros = 0;
    const recalled = await this.#recall(candidates, deadlineAt, controller.signal, trace);
    costMicros += recalled.costMicros;
    let stop: Stop = null;
    const queue = [...candidates];
    let batchSize = this.#options.batchSize ?? DEFAULT_BATCH_SIZE;
    let failure: string | null = null;
    while (queue.length > 0 && stop === null) {
      const batch = queue.slice(0, batchSize);
      const promptMemories = this.#batchMemories(batch, recalled.hits);
      const prompt = proactivePrompt(batch, startedAt, this.#options.timeZone, promptMemories);
      const estimate = this.#options.limits.estimateCostMicros(prompt);
      if (spentToday + costMicros + estimate > this.#options.limits.dailyCostMicros) {
        stop = "capped_daily";
        break;
      }
      if (this.#options.clock.now() >= deadlineAt) {
        stop = "capped";
        break;
      }
      const outcome: JudgeOutcome = await this.#judge(
        batch,
        prompt,
        deadlineAt,
        controller.signal,
        trace,
        promptMemories,
      ).catch(() => ({
        judgements: undefined,
        costMicros: 0,
        failure: "MODEL_CALL_ERROR",
      }));
      costMicros += outcome.costMicros;
      if (!outcome.judgements) {
        if (controller.signal.aborted) {
          stop = "capped";
          break;
        }
        const shrinkable =
          batch.length > 1 &&
          (outcome.failure === "MODEL_OUTPUT_TRUNCATED" ||
            outcome.failure === "MODEL_OUTPUT_INVALID");
        if (shrinkable) {
          batchSize = Math.ceil(batch.length / 2);
          continue;
        }
        stop = "failed";
        failure = outcome.failure ?? "MODEL_OUTPUT_INVALID";
        break;
      }
      for (const [id, judgement] of outcome.judgements) judged.set(id, judgement);
      queue.splice(0, batch.length);
    }
    const insights: ProactiveCheckInsight[] = [];
    const counts: { -readonly [Key in keyof ProactiveCounts]: number } = {
      ...EMPTY_COUNTS,
      fetched: items.length,
      skipped: processed.length,
    };
    const floorHits: Record<string, readonly string[]> = {};
    for (const item of candidates) {
      const floorIds = floorHitIds(item, settings.importantSenders);
      const floor = floorIds.length > 0;
      if (floor) floorHits[item.messageId] = floorIds;
      const judgement = judged.get(item.messageId);
      if (!judgement) {
        if (stop === "capped_daily" && floor) {
          processed.push({
            ...this.#base(item),
            outcome: "check",
            skipReason: null,
            headerRef: null,
          });
          insights.push({
            item,
            result: "check",
            floorRaised: false,
            floorHit: true,
            summary: "",
            reason: "",
            basis: "daily_limit",
            dueAt: null,
            priority: null,
            push: true,
          });
          counts.check += 1;
        }
        continue;
      }
      counts.judged += 1;
      const floored = applyFloor(judgement.result, judgement.confidence, floor);
      const lowered = keepOffReminderPage(
        floored.result,
        judgement.priority,
        floor,
        judgement.confidence,
      );
      const final = {
        result: lowered.result,
        raised: lowered.demoted ? floor : floored.raised,
      };
      if (final.raised) counts.floorRaised += 1;
      counts[final.result] += 1;
      if (final.result === "ignore") {
        processed.push({
          ...this.#base(item),
          outcome: "ignore",
          skipReason: null,
          headerRef: await this.#seal(trace, {
            from: item.from,
            subject: item.subject,
            link: item.link,
          }),
        });
        continue;
      }
      processed.push({
        ...this.#base(item),
        outcome: final.result,
        skipReason: null,
        headerRef: null,
      });
      const dueAt = final.result === "act" ? judgement.dueAt : null;
      const priority = final.result === "act" ? (judgement.priority ?? "medium") : null;
      insights.push({
        item,
        result: final.result,
        floorRaised: final.raised,
        floorHit: floor,
        summary: final.result === "check" ? judgement.reason : judgement.todo,
        reason: judgement.reason,
        basis: "model",
        dueAt,
        priority,
        push:
          (final.result === "act" &&
            priority === "high" &&
            dueAt !== null &&
            Date.parse(dueAt) - Date.parse(startedAt) <= PUSH_WINDOW_MS &&
            Date.parse(startedAt) - Date.parse(dueAt) <= OVERDUE_PUSH_MS) ||
          (final.result === "check" && floor),
      });
    }
    counts.pushed = insights.filter(({ push }) => push).length;
    const leftover = candidates.some(
      (item) => !processed.some(({ messageId }) => messageId === item.messageId),
    );
    const verdict: ProactiveVerdict =
      counts.pushed > 0
        ? quietUntil(startedAt, settings.quietHours, this.#options.timeZone)
          ? "deferred"
          : "pushed"
        : (stop ?? "silent");
    return this.#finish(trace, {
      startedAt,
      verdict,
      reasonCode: this.#reason(verdict, stop, failure, items.length, counts),
      counts,
      processed,
      insights,
      replied: [...new Set(replied)].filter((threadId) => {
        const latestOwn = items
          .filter((item) => item.sentByOwner && item.threadId === threadId)
          .reduce((latest, item) => (item.receivedAt > latest ? item.receivedAt : latest), "");
        return !candidates.some(
          (item) => item.threadId === threadId && item.receivedAt > latestOwn,
        );
      }),
      costMicros,
      cursor: leftover ? null : fetched.cursor,
      quietHours: settings.quietHours,
      floorHits,
    });
  }

  #reason(
    verdict: ProactiveVerdict,
    stop: Stop,
    failure: string | null,
    fetched: number,
    counts: ProactiveCounts,
  ) {
    if (stop === "capped_daily") return "DAILY_LIMIT";
    if (stop === "capped") return "CHECK_LIMIT";
    if (stop === "failed") return failure ?? "MODEL_OUTPUT_INVALID";
    if (verdict === "deferred") return "QUIET_HOURS";
    if (verdict === "pushed") return "URGENT";
    if (fetched === 0) return "NO_NEW_MAIL";
    if (counts.floorRaised > 0) return "FLOOR_RAISED";
    return "NOTHING_URGENT";
  }

  #base(item: ProactiveSourceItem) {
    return { source: item.source, messageId: item.messageId, threadId: item.threadId };
  }

  #skip(item: ProactiveSourceItem, reason: ProactiveCheckProcessed["skipReason"]) {
    return {
      ...this.#base(item),
      outcome: "skipped" as const,
      skipReason: reason,
      headerRef: null,
    };
  }

  async #seal(trace: CheckTrace, value: Record<string, string | boolean>): Promise<string> {
    const ref = await this.#options.seal.seal({
      ...this.#options.scope,
      text: JSON.stringify(value),
      at: this.#options.clock.now(),
    });
    trace.sealed.push(ref);
    return ref;
  }

  async #judge(
    batch: readonly ProactiveSourceItem[],
    prompt: string,
    deadlineAt: string,
    signal: AbortSignal,
    trace: CheckTrace,
    promptMemories: readonly PromptMemory[],
  ): Promise<JudgeOutcome> {
    const { model } = this.#options;
    const invocationId = this.#options.ids.next("proactive-model");
    const authority = await model.prepare({ invocationId, prompt, deadlineAt });
    trace.payloads.push({ ref: authority.inputRef, role: "model_input" });
    for (const { messageId } of batch) trace.sourceIds.add(messageId);
    for (const memory of promptMemories) {
      trace.memoryIds.add(memory.id);
      const list = trace.memoryByMail.get(memory.mailId) ?? [];
      if (!list.includes(memory.id)) list.push(memory.id);
      trace.memoryByMail.set(memory.mailId, list);
    }
    let output = "";
    let completed = false;
    let truncated = false;
    let failure: string | null = null;
    let costMicros = 0;
    try {
      const request: ModelInvocationRequest = {
        signal,
        invocationId,
        runId: authority.runId,
        modelRef: model.modelRef,
        inputRef: authority.inputRef,
        dataClassification: "private",
        allowedDisclosureRef: authority.allowedDisclosureRef,
        secretHandleRefs: [...authority.secretHandleRefs],
        correlationId: invocationId as ModelInvocationRequest["correlationId"],
      };
      for await (const event of model.model.invoke(request)) {
        if (event.invocationId !== invocationId) break;
        if (event.type === "model.failed") {
          failure = failureCode("MODEL_FAILED", event.errorCode);
          break;
        }
        if (event.type === "model.output") {
          trace.payloads.push({ ref: event.payloadRef, role: "model_output" });
          output += await model.readOutput(event.payloadRef);
          if (new TextEncoder().encode(output).byteLength > MAX_OUTPUT_BYTES) break;
        }
        if (event.type === "model.completed") {
          costMicros = Number.isSafeInteger(event.costMicros) ? Math.max(0, event.costMicros) : 0;
          const limit = this.#options.outputTokenLimit;
          truncated = limit !== undefined && event.outputTokens >= limit;
          completed = true;
          break;
        }
      }
    } finally {
      await authority.release();
    }
    if (failure) return { judgements: undefined, costMicros, failure };
    if (!completed) return { judgements: undefined, costMicros, failure: "MODEL_NOT_COMPLETED" };
    const judgements = parseJudgements(output, batch);
    if (judgements) {
      const injected = new Set(promptMemories.map(({ id }) => id));
      for (const { usedMemoryIds } of judgements.values())
        for (const id of usedMemoryIds) if (injected.has(id)) trace.usedMemoryIds.add(id);
      return { judgements, costMicros, failure: null };
    }
    return {
      judgements: undefined,
      costMicros,
      failure: truncated ? "MODEL_OUTPUT_TRUNCATED" : "MODEL_OUTPUT_INVALID",
    };
  }

  async #recall(
    candidates: readonly ProactiveSourceItem[],
    deadlineAt: string,
    signal: AbortSignal,
    trace: CheckTrace,
  ): Promise<{
    readonly hits: ReadonlyMap<string, readonly ProactiveMemoryHit[]>;
    readonly costMicros: number;
  }> {
    const recall = this.#options.memory;
    const empty = { hits: new Map<string, readonly ProactiveMemoryHit[]>(), costMicros: 0 };
    if (!recall || candidates.length === 0) return empty;
    const limits = { ...DEFAULT_PROACTIVE_MEMORY_LIMITS, ...this.#options.memoryLimits };
    const queries = candidates.slice(0, limits.searchesPerCheck).map((item) => ({
      messageId: item.messageId,
      query: `${item.from}\n${item.subject}\n${item.snippet}`.slice(0, limits.queryCharacters),
    }));
    try {
      const result = await recall.recall({ queries, deadlineAt, signal });
      trace.memoryRecall =
        result.failedQueries === 0 && queries.length === candidates.length
          ? "ok"
          : result.failedQueries >= queries.length
            ? "failed"
            : "partial";
      return { hits: result.hits, costMicros: Math.max(0, result.costMicros) };
    } catch {
      trace.memoryRecall = "failed";
      return empty;
    }
  }

  #batchMemories(
    batch: readonly ProactiveSourceItem[],
    hits: ReadonlyMap<string, readonly ProactiveMemoryHit[]>,
  ): readonly PromptMemory[] {
    const limits = { ...DEFAULT_PROACTIVE_MEMORY_LIMITS, ...this.#options.memoryLimits };
    const ranked = batch
      .flatMap(({ messageId }) =>
        [...(hits.get(messageId) ?? [])]
          .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
          .slice(0, limits.perMail)
          .map((hit) => ({ hit, mailId: messageId })),
      )
      .sort((left, right) => right.hit.score - left.hit.score)
      .slice(0, limits.perBatch);
    const chosen = new Set(ranked.map(({ hit, mailId }) => `${mailId}\u0000${hit.id}`));
    return batch.flatMap(({ messageId }) =>
      (hits.get(messageId) ?? [])
        .filter((hit) => chosen.has(`${messageId}\u0000${hit.id}`))
        .map((hit) => ({
          mailId: messageId,
          id: hit.id,
          text: hit.text.replace(/\s+/gu, " ").trim().slice(0, limits.charactersPerMemory),
        })),
    );
  }

  async #needsOwner(
    trace: CheckTrace,
    startedAt: string,
    reasonCode: string,
  ): Promise<ProactiveDecision> {
    await this.#options.store.markConnection({
      ...this.#options.scope,
      source: this.#options.reader.source,
      status: "needs_reconnect",
      cursor: null,
      now: startedAt,
    });
    return this.#finish(trace, {
      startedAt,
      verdict: "needs_owner",
      reasonCode,
      counts: EMPTY_COUNTS,
      processed: [],
      insights: [],
      replied: [],
      costMicros: 0,
      cursor: null,
      quietHours: [],
      floorHits: {},
    });
  }

  async #finish(
    trace: CheckTrace,
    input: {
      readonly startedAt: string;
      readonly verdict: ProactiveVerdict;
      readonly reasonCode: string;
      readonly counts: ProactiveCounts;
      readonly processed: readonly ProactiveCheckProcessed[];
      readonly insights: readonly ProactiveCheckInsight[];
      readonly replied: readonly string[];
      readonly costMicros: number;
      readonly cursor: string | null;
      readonly quietHours: ProactiveSettings["quietHours"];
      readonly floorHits: Readonly<Record<string, readonly string[]>>;
    },
  ): Promise<ProactiveDecision> {
    const { store, scope, ids, clock } = this.#options;
    const pushing = input.insights.some(({ push }) => push);
    let push: { id: string; readyAt: string } | null = null;
    if (pushing) {
      const quiet = quietUntil(input.startedAt, input.quietHours, this.#options.timeZone);
      const readyAt = quiet ?? input.startedAt;
      const pending = quiet ? await store.pendingPush({ ...scope, readyAt }) : undefined;
      push = { id: pending?.id ?? ids.next("proactive-push"), readyAt };
    }
    const writes: ProactiveInsightWrite[] = [];
    for (const insight of input.insights)
      writes.push({
        id: ids.next("source-insight"),
        threadId: insight.item.threadId,
        lastMessageId: insight.item.messageId,
        result: insight.result as ProactiveInsightWrite["result"],
        floorRaised: insight.floorRaised,
        contentRef: await this.#seal(trace, {
          summary: insight.summary,
          reason: insight.reason,
          basis: insight.basis,
          floorHit: insight.floorHit,
          from: insight.item.from,
          subject: insight.item.subject,
          link: insight.item.link,
        }),
        dueAt: insight.dueAt,
        priority: insight.priority,
        push: insight.push,
      });
    const finishedAt = clock.now();
    const decision: ProactiveDecision = Object.freeze({
      id: ids.next("proactive-decision"),
      scenario: this.#options.reader.source,
      checkedAt: input.startedAt,
      counts: Object.freeze({ ...input.counts }),
      verdict: input.verdict,
      reasonCode: input.reasonCode,
      pushSourceKey: push ? `proactive:${push.id}` : null,
      costMicros: input.costMicros,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(input.startedAt)),
      ownerRating: null,
      ratedAt: null,
    });
    const inputs: ProactiveCheckInputs = Object.freeze({
      ruleIds: [...new Set(Object.values(input.floorHits).flat())].sort(),
      sourceIds: [...trace.sourceIds],
      floorHits: input.floorHits,
      memoryInjected: trace.memoryIds.size > 0,
      memoryIds: [...trace.memoryIds],
      usedMemoryIds: [...trace.usedMemoryIds],
      memoryByMail: Object.fromEntries(trace.memoryByMail),
      memoryRecall: trace.memoryRecall,
    });
    const result = await store.record({
      ...scope,
      decision,
      inputs,
      modelPayloads: trace.payloads,
      processed: input.processed,
      insights: writes,
      repliedThreadIds: input.replied,
      push,
      cursor: input.cursor,
    });
    trace.recorded = true;
    if (result.releasedRefs.length > 0)
      await this.#options.seal.release({ ...scope, refs: result.releasedRefs });
    return decision;
  }
}

type ProactiveCheckProcessed = Omit<
  ProactiveProcessedMessage,
  "reviewedAt" | "ownerRating" | "decisionId" | "processedAt"
>;

interface ProactiveCheckInsight {
  readonly item: ProactiveSourceItem;
  readonly result: ProactiveResult;
  readonly floorRaised: boolean;
  readonly floorHit: boolean;
  readonly summary: string;
  readonly reason: string;
  readonly basis: "model" | "daily_limit";
  readonly dueAt: string | null;
  readonly priority: ProactivePriority | null;
  readonly push: boolean;
}
