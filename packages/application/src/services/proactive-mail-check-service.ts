import type { RunId } from "@himawari-agent/domain";
import {
  MAIL_JUDGMENT,
  MAIL_JUDGMENT_ITEMS_HEADER,
  MAIL_JUDGMENT_MEMORIES_HEADER,
  MAIL_JUDGMENT_TENTATIVE_NOTE,
  MAIL_JUDGMENT_NOW,
  MAIL_REFERENCE_EXTRACTION,
  MAIL_JUDGMENT_RECENT_SUMMARIES_HEADER,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import type { ModelInvocationRequest, ModelPort } from "../ports/intelligence.js";
import type {
  ProactiveCheckInputs,
  ProactiveConfidence,
  ProactiveCounts,
  ProactiveDecision,
  ProactiveBackoffSettings,
  ProactiveBackoffWrite,
  ProactiveInsightWrite,
  ProactiveMemoryHit,
  ProactiveMemoryRecall,
  ProactiveMemoryRecallStatus,
  ProactiveModelPayload,
  ProactivePriority,
  ProactiveProcessedMessage,
  ProactiveRecentSummaries,
  ProactiveRelatedLimits,
  ProactiveRelatedReadStatus,
  ProactiveRelatedStats,
  ProactiveResult,
  ProactiveScope,
  ProactiveSealPort,
  ProactiveSettings,
  ProactiveSourceItem,
  ProactiveSourceReader,
  ProactiveStorePort,
  ProactiveSummaryReadStatus,
  ProactiveVerdict,
  ProactiveWholeThread,
} from "../ports/proactive-checks.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import type { DataClassification } from "../ports/common.js";
import { highestClassification } from "./model-visibility.js";
import {
  type EgressRedactionSighting,
  findSensitiveValues,
  locateMaskedValues,
  maskSensitiveText,
} from "@himawari-agent/sensitive-capture";
import { parseMailReferences } from "./proactive-references.js";
import { mailBodyWindow, plainModelText, windowMailBody } from "./proactive-mail-body.js";
import {
  applyFloor,
  floorHitIds,
  floorHitRefs,
  mustNotifyHitIds,
  wholeThreadHitIds,
  senderDomain,
  keepOffReminderPage,
  quietEnd,
  quietHitRefs,
  startOfZonedDay,
  suppressPushHits,
} from "./proactive-rules.js";
import {
  type MailAmount,
  type MoneyState,
  parseMailAmount,
  parseMailMoney,
} from "../rules/amount.js";
import { assertRuleExamples, type RuleRecord, ruleBookFor } from "../rules/rule-book.js";
import { enforceableOwnerRule } from "../rules/rule-types.js";
import type { OwnerRuleStorePort } from "../ports/owner-rules.js";

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
    readonly dataClassification: DataClassification;
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
  readonly recentSummaries?: ProactiveRecentSummaries;
  readonly summaryLimits?: Partial<ProactiveSummaryLimits>;
  readonly bodyLimits?: Partial<ProactiveBodyLimits>;
  readonly relatedLimits?: Partial<ProactiveRelatedServiceLimits>;
  readonly onMasked?: (sightings: readonly EgressRedactionSighting[]) => void;
  readonly backoff?: Partial<ProactiveBackoffSettings>;
  readonly ownerRules?: readonly RuleRecord[];
  readonly ownerRuleStore?: Pick<OwnerRuleStorePort, "list">;
}

export const DEFAULT_PROACTIVE_BACKOFF: ProactiveBackoffSettings = Object.freeze({
  threshold: 3,
  ignoreAfterMs: 24 * 3_600_000,
  gapMs: 24 * 3_600_000,
});

export function proactivePushClass(fromAddress: string): string | null {
  if (!fromAddress.includes("@")) return null;
  const domain = senderDomain(fromAddress);
  return domain.length === 0 ? null : `due:${domain}`.slice(0, 128);
}

interface BackoffOutcome {
  readonly insights: readonly ProactiveCheckInsight[];
  readonly writes: readonly ProactiveBackoffWrite[];
  readonly steppedUp: boolean;
  readonly suppressed: number;
}

export interface ProactiveBodyLimits {
  readonly perMail: number;
  readonly perBatch: number;
}

export const DEFAULT_PROACTIVE_BODY_LIMITS: ProactiveBodyLimits = Object.freeze({
  perMail: 16_000,
  perBatch: 64_000,
});

export interface ProactiveRelatedServiceLimits extends ProactiveRelatedLimits {
  readonly charactersPerRelated: number;
  readonly charactersPerMail: number;
  readonly wholeThreadCharactersPerMail: number;
}

export const DEFAULT_PROACTIVE_RELATED_LIMITS: ProactiveRelatedServiceLimits = Object.freeze({
  perMail: 6,
  requestsPerCheck: 300,
  charactersPerRelated: 2_000,
  charactersPerMail: 12_000,
  wholeThreadPerMail: 50,
  wholeThreadCharactersPerMail: 60_000,
});

interface RelatedView {
  readonly mails: readonly ProactiveSourceItem[];
  readonly json: readonly Record<string, unknown>[];
  readonly unavailable: boolean;
  readonly wholeThreadComplete?: boolean;
}

const RECALL_BODY_CHARACTERS = 300;
const MAX_ATTACHMENTS_SHOWN = 10;

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

export interface ProactiveSummaryLimits {
  readonly days: number;
  readonly perCheck: number;
  readonly characters: number;
  readonly catchUpPerCheck: number;
}

export const DEFAULT_PROACTIVE_SUMMARY_LIMITS: ProactiveSummaryLimits = Object.freeze({
  days: 2,
  perCheck: 8,
  characters: 4_000,
  catchUpPerCheck: 3,
});

interface PromptSummary {
  readonly id: string;
  readonly day: string;
  readonly text: string;
  readonly dataClassification: DataClassification;
}

interface ModelCall {
  readonly output: string;
  readonly completed: boolean;
  readonly truncated: boolean;
  readonly failure: string | null;
  readonly costMicros: number;
}

interface PromptMemory {
  readonly mailId: string;
  readonly id: string;
  readonly text: string;
  readonly tentative?: true;
  readonly dataClassification: DataClassification;
}

interface Judgement {
  readonly result: ProactiveResult;
  readonly confidence: ProactiveConfidence;
  readonly todo: string;
  readonly reason: string;
  readonly dueAt: string | null;
  readonly priority: ProactivePriority | null;
  readonly usedMemoryIds: readonly string[];
  readonly amount: MailAmount;
  readonly money: MoneyState;
}

type Stop = "capped" | "capped_daily" | "failed" | null;

const DEFAULT_BATCH_SIZE = 8;

interface CheckTrace {
  readonly payloads: ProactiveModelPayload[];
  readonly sealed: string[];
  readonly sourceIds: Set<string>;
  readonly memoryIds: Set<string>;
  readonly usedMemoryIds: Set<string>;
  readonly tentativeMemoryIds: Set<string>;
  readonly memoryByMail: Map<string, string[]>;
  memoryRecall: ProactiveMemoryRecallStatus;
  readonly relatedByMail: Map<string, string[]>;
  readonly relatedFailedSteps: Set<string>;
  readonly relatedSent: Set<string>;
  relatedRead: ProactiveRelatedReadStatus;
  relatedStats: ProactiveRelatedStats;
  readonly summaryIds: Set<string>;
  readonly summaryDays: Set<string>;
  summaryCharacters: number;
  summaryRead: ProactiveSummaryReadStatus;
  summaryGenerated: number;
  recorded: boolean;
}

interface JudgeOutcome {
  readonly judgements: ReadonlyMap<string, Judgement> | undefined;
  readonly costMicros: number;
  readonly failure: string | null;
  readonly dataClassification?: DataClassification;
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

function instant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

interface ProactiveMailView {
  readonly json: Record<string, unknown>;
  readonly size: number;
}

const mailViews = new WeakMap<ProactiveSourceItem, Map<number, ProactiveMailView>>();

function sentBodyValues(body: string, limit: number): readonly EgressRedactionSighting[] {
  const located = locateMaskedValues(body);
  if (located === null) return findSensitiveValues(windowMailBody(body, limit).text);
  const starts = [0];
  for (const point of located.text) starts.push((starts.at(-1) ?? 0) + point.length);
  const pointAt = (unit: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= unit) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const length = starts.length - 1;
  const window = mailBodyWindow(length, limit);
  return located.spans
    .filter(
      ({ start, end }) =>
        window === null || pointAt(start) < window.head || pointAt(end) > length - window.tail,
    )
    .map(({ sighting }) => sighting);
}

function masked(value: string): string {
  return maskSensitiveText(value);
}

function relatedMailView(
  mails: readonly ProactiveSourceItem[],
  unavailable: boolean,
  limits: ProactiveRelatedServiceLimits,
  wholeThread?: ProactiveWholeThread,
): RelatedView {
  const chosen: { mail: ProactiveSourceItem; json: Record<string, unknown> }[] = [];
  let total = 0;
  const newestFirst = [...mails].sort(
    (left, right) =>
      right.receivedAt.localeCompare(left.receivedAt) ||
      right.messageId.localeCompare(left.messageId),
  );
  const shown = wholeThread ? newestFirst : newestFirst.slice(0, limits.perMail);
  const characterLimit = wholeThread
    ? limits.wholeThreadCharactersPerMail
    : limits.charactersPerMail;
  for (const mail of shown) {
    const windowed =
      mail.body === null
        ? undefined
        : windowMailBody(masked(mail.body), limits.charactersPerRelated);
    const json: Record<string, unknown> = {
      id: mail.messageId,
      from: masked(mail.from),
      subject: masked(mail.subject),
      ...(mail.sentByOwner ? { sentByOwner: true } : {}),
      ...(windowed
        ? { body: windowed.text }
        : {
            snippet: Array.from(masked(mail.snippet))
              .slice(0, limits.charactersPerRelated)
              .join(""),
          }),
      ...(windowed?.truncated || mail.bodyTruncated ? { bodyTruncated: true } : {}),
      ...(windowed === undefined && mail.bodyUnavailable ? { bodyUnavailable: true } : {}),
      receivedAt: mail.receivedAt,
    };
    const size = JSON.stringify(json).length;
    if (chosen.length > 0 && total + size > characterLimit) break;
    total += size;
    chosen.push({ mail, json });
  }
  chosen.reverse();
  const included = new Set(chosen.map(({ mail }) => mail.messageId));
  return Object.freeze({
    mails: chosen.map(({ mail }) => mail),
    json: chosen.map(({ json }) => json),
    unavailable,
    ...(wholeThread
      ? {
          wholeThreadComplete:
            wholeThread.complete && wholeThread.messageIds.every((id) => included.has(id)),
        }
      : {}),
  });
}

export function proactiveMailView(
  item: ProactiveSourceItem,
  bodyLimit: number,
  related?: RelatedView,
): ProactiveMailView {
  const base = baseMailView(item, bodyLimit);
  if (related === undefined || (related.json.length === 0 && !related.unavailable)) return base;
  const json: Record<string, unknown> = {
    ...base.json,
    ...(related.json.length > 0 ? { related: related.json } : {}),
    ...(related.unavailable ? { relatedUnavailable: true } : {}),
  };
  return Object.freeze({ json, size: JSON.stringify(json).length });
}

function baseMailView(item: ProactiveSourceItem, bodyLimit: number): ProactiveMailView {
  const byLimit = mailViews.get(item) ?? new Map<number, ProactiveMailView>();
  const cached = byLimit.get(bodyLimit);
  if (cached) return cached;
  const windowed = item.body === null ? undefined : windowMailBody(masked(item.body), bodyLimit);
  const json: Record<string, unknown> = {
    id: item.messageId,
    from: masked(item.from),
    subject: masked(item.subject),
    ...(item.sentByOwner ? { sentByOwner: true } : {}),
    ...(windowed ? { body: windowed.text } : { snippet: masked(item.snippet) }),
    ...(windowed?.truncated || item.bodyTruncated ? { bodyTruncated: true } : {}),
    ...(windowed === undefined && item.bodyUnavailable ? { bodyUnavailable: true } : {}),
    ...(item.attachments.length > 0
      ? {
          attachments: item.attachments.slice(0, MAX_ATTACHMENTS_SHOWN).map((attachment) => ({
            filename: masked(attachment.filename),
            mimeType: attachment.mimeType,
            size: attachment.size,
          })),
        }
      : {}),
    receivedAt: item.receivedAt,
  };
  const view = Object.freeze({ json, size: JSON.stringify(json).length });
  byLimit.set(bodyLimit, view);
  mailViews.set(item, byLimit);
  return view;
}

export function mailReferencePrompt(
  items: readonly ProactiveSourceItem[],
  bodyLimit: number,
): string {
  return [
    MAIL_REFERENCE_EXTRACTION.text,
    JSON.stringify(
      items.map((item) => {
        const { id, subject, body, snippet } = proactiveMailView(item, bodyLimit).json;
        return { id, subject, ...(body === undefined ? { snippet } : { body }) };
      }),
    ),
  ].join("\n");
}

const REFERENCE_SHARE_DENOMINATOR = 10;

export function proactivePrompt(
  items: readonly ProactiveSourceItem[],
  now: string,
  timeZone: string,
  memories: readonly PromptMemory[] = [],
  bodyLimit: number = DEFAULT_PROACTIVE_BODY_LIMITS.perMail,
  related: ReadonlyMap<string, RelatedView> = new Map(),
  summaries: readonly PromptSummary[] = [],
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
    ...(summaries.length > 0
      ? [
          MAIL_JUDGMENT_RECENT_SUMMARIES_HEADER.text,
          JSON.stringify(summaries.map(({ day, text }) => ({ day, text }))),
        ]
      : []),
    ...(memories.length > 0
      ? [
          MAIL_JUDGMENT_MEMORIES_HEADER.text,
          JSON.stringify(
            memories.map(({ mailId, id, text, tentative }) => ({
              mailId,
              id,
              text,
              ...(tentative ? { tentative } : {}),
            })),
          ),
        ]
      : []),
    ...(memories.some(({ tentative }) => tentative) ? [MAIL_JUDGMENT_TENTATIVE_NOTE.text] : []),
    MAIL_JUDGMENT_ITEMS_HEADER.text,
    JSON.stringify(
      items.map((item) => proactiveMailView(item, bodyLimit, related.get(item.messageId)).json),
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

function bodyReadInFull(item: ProactiveSourceItem): boolean {
  return item.body !== null && !item.bodyTruncated;
}

export function parseJudgements(
  output: string,
  items: readonly ProactiveSourceItem[],
  bodyComplete: (item: ProactiveSourceItem) => boolean = bodyReadInFull,
): ReadonlyMap<string, Judgement> | undefined {
  const entries = completeEntries(output);
  if (entries === undefined) return undefined;
  const byId = new Map(items.map((item) => [item.messageId, item]));
  const judgements = new Map<string, Judgement>();
  for (const entry of entries) {
    const id = entry["id"];
    const result = entry["result"];
    const confidence = entry["confidence"];
    if (
      typeof id !== "string" ||
      !byId.has(id) ||
      judgements.has(id) ||
      !["act", "know", "check", "ignore"].includes(result as string) ||
      !["sure", "unsure"].includes(confidence as string)
    )
      continue;
    const item = byId.get(id);
    if (item === undefined) continue;
    const priority =
      typeof entry["priority"] === "string" ? entry["priority"].trim().toLowerCase() : null;
    const used = entry["usedMemoryIds"];
    judgements.set(id, {
      usedMemoryIds: Array.isArray(used)
        ? used.filter((value): value is string => typeof value === "string").slice(0, 16)
        : [],
      result: result as ProactiveResult,
      confidence: confidence as ProactiveConfidence,
      todo: plainModelText(typeof entry["todo"] === "string" ? entry["todo"] : "", 200),
      reason: plainModelText(typeof entry["reason"] === "string" ? entry["reason"] : "", 200),
      dueAt: instant(entry["dueAt"]),
      money: parseMailMoney(entry["money"]),
      amount: parseMailAmount(
        ["act", "know", "check"].includes(result as string) ? entry["amount"] : undefined,
        bodyComplete(item),
      ),
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
    for (const rule of options.ownerRules ?? []) assertRuleExamples(rule);
    this.#options = options;
  }

  #reportMasked(
    batch: readonly ProactiveSourceItem[],
    bodyLimit: number,
    related: ReadonlyMap<string, RelatedView>,
  ): void {
    const onMasked = this.#options.onMasked;
    if (onMasked === undefined) return;
    try {
      const sightings = batch.flatMap((item) =>
        [
          item.from,
          item.subject,
          ...item.attachments.slice(0, MAX_ATTACHMENTS_SHOWN).map(({ filename }) => filename),
          ...(item.body === null ? [item.snippet] : []),
        ]
          .flatMap((text) => findSensitiveValues(text))
          .concat(item.body === null ? [] : sentBodyValues(item.body, bodyLimit))
          .concat(
            (related.get(item.messageId)?.mails ?? []).flatMap((mail) =>
              [mail.from, mail.subject, ...(mail.body === null ? [mail.snippet] : [])]
                .flatMap((text) => findSensitiveValues(text))
                .concat(
                  mail.body === null
                    ? []
                    : sentBodyValues(mail.body, this.#relatedLimits().charactersPerRelated),
                ),
            ),
          ),
      );
      if (sightings.length > 0) onMasked(sightings);
    } catch {
      return;
    }
  }

  #relatedLimits(): ProactiveRelatedServiceLimits {
    return {
      ...DEFAULT_PROACTIVE_RELATED_LIMITS,
      ...this.#options.relatedLimits,
    };
  }

  async #storedOwnerRules(): Promise<readonly RuleRecord[]> {
    const store = this.#options.ownerRuleStore;
    if (!store) return [];
    const rules: RuleRecord[] = [];
    for (const row of await store.list({ ...this.#options.scope, includeRetired: false })) {
      const rule = enforceableOwnerRule(row);
      if (rule) rules.push(rule);
    }
    return rules;
  }

  async #references(
    candidates: readonly ProactiveSourceItem[],
    deadlineAt: string,
    signal: AbortSignal,
    trace: CheckTrace,
    budget: { readonly spentToday: number; readonly reserveMicros: number; costMicros: number },
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const references = new Map<string, readonly string[]>();
    const perMail = { ...DEFAULT_PROACTIVE_BODY_LIMITS, ...this.#options.bodyLimits }.perMail;
    const size = this.#options.batchSize ?? DEFAULT_BATCH_SIZE;
    const allowance = Math.floor(
      this.#options.limits.dailyCostMicros / REFERENCE_SHARE_DENOMINATOR,
    );
    let planned = 0;
    for (let start = 0; start < candidates.length; start += size) {
      if (signal.aborted) break;
      const batch = candidates.slice(start, start + size);
      const prompt = mailReferencePrompt(batch, perMail);
      const estimate = this.#options.limits.estimateCostMicros(prompt);
      if (planned + estimate > allowance) break;
      planned += estimate;
      if (
        budget.spentToday + budget.costMicros + budget.reserveMicros + estimate >
        this.#options.limits.dailyCostMicros
      )
        break;
      try {
        const call = await this.#invoke(prompt, "private", deadlineAt, signal, trace);
        budget.costMicros += call.costMicros;
        if (call.failure !== null || !call.completed) continue;
        for (const [id, found] of parseMailReferences(call.output, batch))
          references.set(id, found);
      } catch {}
    }
    return references;
  }

  async #related(
    token: string,
    allCandidates: readonly ProactiveSourceItem[],
    wholeThread: ReadonlySet<string>,
    signal: AbortSignal,
    trace: CheckTrace,
    references: ReadonlyMap<string, readonly string[]> = new Map(),
  ): Promise<ReadonlyMap<string, RelatedView>> {
    const { reader, clock } = this.#options;
    const views = new Map<string, RelatedView>();
    const limits = this.#relatedLimits();
    const candidates =
      limits.perMail < 1
        ? allCandidates.filter(({ messageId }) => wholeThread.has(messageId))
        : allCandidates;
    if (reader.related === undefined || candidates.length === 0) return views;
    const startedMs = Date.parse(clock.now());
    let requests = 0;
    let fetched: Awaited<ReturnType<NonNullable<typeof reader.related>>> | undefined;
    try {
      fetched = await reader.related({
        token,
        items: candidates,
        limits,
        ...(wholeThread.size > 0 ? { wholeThread } : {}),
        references,
        signal,
      });
      requests = fetched.requests;
    } catch {
      fetched = undefined;
    }
    const readFailure = signal.aborted ? "timeout" : "read";
    let failedMails = 0;
    for (const item of candidates) {
      const failure = fetched === undefined ? readFailure : fetched.failed.get(item.messageId);
      if (failure !== undefined) {
        failedMails += 1;
        const step = failure
          .toLowerCase()
          .replace(/[^a-z0-9_]+/gu, "_")
          .slice(0, 64);
        if (trace.relatedFailedSteps.size < 16)
          trace.relatedFailedSteps.add(step === "" ? "read" : step);
      }
      const view = relatedMailView(
        fetched?.byMail.get(item.messageId) ?? [],
        failure !== undefined,
        limits,
        wholeThread.has(item.messageId)
          ? (fetched?.wholeThread?.get(item.messageId) ?? { messageIds: [], complete: false })
          : undefined,
      );
      views.set(item.messageId, view);
    }
    trace.relatedRead =
      failedMails === 0 ? "ok" : failedMails >= candidates.length ? "failed" : "partial";
    trace.relatedStats = {
      ...trace.relatedStats,
      requests,
      durationMs: Math.max(0, Date.parse(clock.now()) - startedMs),
    };
    return views;
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
      tentativeMemoryIds: new Set(),
      memoryByMail: new Map(),
      memoryRecall: "off",
      relatedByMail: new Map(),
      relatedFailedSteps: new Set(),
      relatedSent: new Set(),
      relatedRead: "off",
      relatedStats: { requests: 0, messages: 0, characters: 0, durationMs: 0 },
      summaryIds: new Set(),
      summaryDays: new Set(),
      summaryCharacters: 0,
      summaryRead: "off",
      summaryGenerated: 0,
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
        rules: [],
        floorHits: {},
        ruleHits: {},
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
    const candidates: ProactiveSourceItem[] = [];
    for (const item of items) {
      if (item.categories.includes("spam")) processed.push(this.#skip(item, "category"));
      else candidates.push(item);
    }
    const spentToday = await store.costSince({
      ...scope,
      since: startOfZonedDay(startedAt, this.#options.timeZone),
    });
    const judged = new Map<string, Judgement>();
    const judgedClassification = new Map<string, DataClassification>();
    let costMicros = 0;
    const rules = [
      ...ruleBookFor(settings),
      ...(this.#options.ownerRules ?? []),
      ...(await this.#storedOwnerRules()),
    ];
    const wholeThreadHits = new Map<string, readonly string[]>();
    for (const item of candidates) {
      if (item.sentByOwner) continue;
      const hits = wholeThreadHitIds(item, rules);
      if (hits.length > 0) wholeThreadHits.set(item.messageId, hits);
    }
    const referenceSignal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.floor(this.#options.limits.perCheckMs / 6)),
    ]);
    const referenceReserveMicros =
      candidates.length === 0
        ? 0
        : this.#options.limits.estimateCostMicros(
            proactivePrompt(
              this.#fitBatch(
                candidates,
                this.#options.batchSize ?? DEFAULT_BATCH_SIZE,
                { ...DEFAULT_PROACTIVE_BODY_LIMITS, ...this.#options.bodyLimits },
                new Map<string, RelatedView>(),
              ),
              startedAt,
              this.#options.timeZone,
              [],
              { ...DEFAULT_PROACTIVE_BODY_LIMITS, ...this.#options.bodyLimits }.perMail,
              new Map<string, RelatedView>(),
              this.#summariesOff()
                ? []
                : [
                    {
                      id: "reserve",
                      day: startedAt.slice(0, 10),
                      text: "。".repeat(
                        Math.max(
                          0,
                          { ...DEFAULT_PROACTIVE_SUMMARY_LIMITS, ...this.#options.summaryLimits }
                            .characters,
                        ),
                      ),
                      dataClassification: "private",
                    },
                  ],
            ),
          );
    const referenceBudget = {
      spentToday,
      reserveMicros: referenceReserveMicros,
      costMicros: 0,
    };
    const references =
      spentToday >= this.#options.limits.dailyCostMicros ||
      this.#options.reader.related === undefined ||
      this.#relatedLimits().perMail < 1
        ? new Map<string, readonly string[]>()
        : await this.#references(candidates, deadlineAt, referenceSignal, trace, referenceBudget);
    costMicros += referenceBudget.costMicros;
    const relatedSignal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.floor(this.#options.limits.perCheckMs / 2)),
    ]);
    const relatedViews =
      spentToday >= this.#options.limits.dailyCostMicros
        ? new Map<string, RelatedView>()
        : await this.#related(
            token,
            candidates,
            new Set(wholeThreadHits.keys()),
            relatedSignal,
            trace,
            references,
          );
    const bodyLimits = { ...DEFAULT_PROACTIVE_BODY_LIMITS, ...this.#options.bodyLimits };
    let batchSize = this.#options.batchSize ?? DEFAULT_BATCH_SIZE;
    const recalled = await this.#recall(candidates, deadlineAt, controller.signal, trace);
    costMicros += recalled.costMicros;
    const summaryLimits = { ...DEFAULT_PROACTIVE_SUMMARY_LIMITS, ...this.#options.summaryLimits };
    const firstBatch = this.#fitBatch(candidates, batchSize, bodyLimits, relatedViews);
    const judgmentReserveMicros =
      candidates.length === 0
        ? 0
        : this.#options.limits.estimateCostMicros(
            proactivePrompt(
              firstBatch,
              startedAt,
              this.#options.timeZone,
              this.#batchMemories(firstBatch, recalled.hits),
              bodyLimits.perMail,
              relatedViews,
              this.#summariesOff()
                ? []
                : [
                    {
                      id: "reserve",
                      day: startedAt.slice(0, 10),
                      text: "。".repeat(Math.max(0, summaryLimits.characters)),
                      dataClassification: "private",
                    },
                  ],
            ),
          );
    const summaryBudget = {
      spentToday: spentToday + referenceBudget.costMicros + recalled.costMicros,
      reserveMicros: judgmentReserveMicros,
      costMicros: 0,
    };
    const summaries =
      candidates.length === 0 || spentToday >= this.#options.limits.dailyCostMicros
        ? []
        : await this.#summaries(deadlineAt, controller.signal, trace, summaryBudget);
    costMicros += summaryBudget.costMicros;
    let stop: Stop = null;
    const queue = [...candidates];
    let failure: string | null = null;
    while (queue.length > 0 && stop === null) {
      const batch = this.#fitBatch(queue, batchSize, bodyLimits, relatedViews);
      const promptMemories = this.#batchMemories(batch, recalled.hits);
      const prompt = proactivePrompt(
        batch,
        startedAt,
        this.#options.timeZone,
        promptMemories,
        bodyLimits.perMail,
        relatedViews,
        summaries,
      );
      const estimate = this.#options.limits.estimateCostMicros(prompt);
      if (spentToday + costMicros + estimate > this.#options.limits.dailyCostMicros) {
        stop = "capped_daily";
        break;
      }
      if (this.#options.clock.now() >= deadlineAt) {
        stop = "capped";
        break;
      }
      this.#reportMasked(batch, bodyLimits.perMail, relatedViews);
      const outcome: JudgeOutcome = await this.#judge(
        batch,
        prompt,
        deadlineAt,
        controller.signal,
        trace,
        promptMemories,
        relatedViews,
        summaries,
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
      for (const [id, judgement] of outcome.judgements) {
        judged.set(id, judgement);
        judgedClassification.set(id, outcome.dataClassification ?? "private");
      }
      queue.splice(0, batch.length);
    }
    const insights: ProactiveCheckInsight[] = [];
    const counts: { -readonly [Key in keyof ProactiveCounts]: number } = {
      ...EMPTY_COUNTS,
      fetched: items.length,
      skipped: processed.length,
    };
    const floorHits: Record<string, readonly string[]> = {};
    const ruleHits: Record<string, readonly string[]> = {};
    const settled = new Map<string, { readonly result: ProactiveResult; readonly sure: boolean }>();
    for (const item of candidates) {
      const judgement = judged.get(item.messageId);
      const floorIds = item.sentByOwner
        ? []
        : floorHitIds(item, rules, judgement?.money ?? "unknown");
      const floor = floorIds.length > 0;
      if (floor) floorHits[item.messageId] = floorIds;
      if (!judgement) {
        const ruled =
          stop === "capped_daily" && !item.sentByOwner
            ? [...(wholeThreadHits.get(item.messageId) ?? []), ...mustNotifyHitIds(item, rules)]
            : [];
        if (ruled.length > 0) {
          ruleHits[item.messageId] = [...new Set(ruled)].sort().slice(0, 16);
        }
        if (stop === "capped_daily" && (floor || ruled.length > 0)) {
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
            pushClass: null,
            dataClassification: "private",
          });
          counts.check += 1;
        }
        continue;
      }
      counts.judged += 1;
      const threadRules = wholeThreadHits.get(item.messageId) ?? [];
      const threadUnread =
        threadRules.length > 0 &&
        relatedViews.get(item.messageId)?.wholeThreadComplete !== true &&
        judgement.result !== "act";
      const notifyRules = item.sentByOwner ? [] : mustNotifyHitIds(item, rules);
      const mustNotify = notifyRules.length > 0;
      const forced = threadUnread || (mustNotify && judgement.result !== "act");
      const floored = applyFloor(judgement.result, judgement.confidence, floor);
      const lowered = keepOffReminderPage(
        floored.result,
        judgement.priority,
        floor,
        judgement.confidence,
      );
      const final = forced
        ? { result: "check" as const, raised: judgement.result !== "check" }
        : {
            result: lowered.result,
            raised: lowered.demoted ? floor : floored.raised,
          };
      const enforced = [...(threadUnread ? threadRules : []), ...notifyRules];
      if (enforced.length > 0) {
        ruleHits[item.messageId] = [...new Set(enforced)].sort().slice(0, 16);
      }
      if (final.raised) counts.floorRaised += 1;
      counts[final.result] += 1;
      settled.set(item.messageId, {
        result: judgement.result,
        sure: judgement.confidence === "sure",
      });
      if (final.result === "ignore") {
        processed.push({
          ...this.#base(item),
          outcome: "ignore",
          skipReason: null,
          headerRef: await this.#seal(trace, {
            from: masked(item.from),
            subject: masked(item.subject),
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
      const dueSoon =
        final.result === "act" &&
        priority === "high" &&
        dueAt !== null &&
        Date.parse(dueAt) - Date.parse(startedAt) <= PUSH_WINDOW_MS &&
        Date.parse(startedAt) - Date.parse(dueAt) <= OVERDUE_PUSH_MS;
      const wantsPush =
        mustNotify || dueSoon || (final.result === "check" && (floor || threadUnread));
      const suppressing =
        wantsPush && !floor && !threadUnread && !mustNotify
          ? suppressPushHits(item, judgement.amount, rules)
          : [];
      if (suppressing.length > 0) ruleHits[item.messageId] = suppressing;
      const push = wantsPush && suppressing.length === 0;
      insights.push({
        item,
        result: final.result,
        floorRaised: final.raised,
        floorHit: floor || threadUnread || mustNotify,
        summary: final.result === "check" ? judgement.reason : judgement.todo,
        reason: judgement.reason,
        basis: "model",
        dueAt,
        priority,
        push,
        pushClass:
          push && dueSoon && !floor && !mustNotify ? proactivePushClass(item.fromAddress) : null,
        dataClassification: judgedClassification.get(item.messageId) ?? "private",
      });
    }
    const gated = await this.#gateBackoff(insights, startedAt);
    counts.pushed = gated.insights.filter(({ push }) => push).length;
    const leftover = candidates.some(
      (item) => !processed.some(({ messageId }) => messageId === item.messageId),
    );
    const verdict: ProactiveVerdict =
      counts.pushed > 0
        ? quietEnd(startedAt, rules, settings.quietHours, this.#options.timeZone)
          ? "deferred"
          : "pushed"
        : (stop ?? "silent");
    return this.#finish(trace, {
      startedAt,
      verdict,
      reasonCode: this.#reason(verdict, stop, failure, items.length, counts, gated),
      counts,
      processed,
      insights: gated.insights,
      backoff: gated.writes,
      replied: this.#repliedThreads(items, candidates, settled),
      costMicros,
      cursor: leftover ? null : fetched.cursor,
      quietHours: settings.quietHours,
      rules,
      floorHits,
      ruleHits,
    });
  }

  #fitBatch(
    queue: readonly ProactiveSourceItem[],
    batchSize: number,
    bodyLimits: ProactiveBodyLimits,
    related: ReadonlyMap<string, RelatedView>,
  ): readonly ProactiveSourceItem[] {
    const batch: ProactiveSourceItem[] = [];
    let size = 0;
    for (const item of queue.slice(0, batchSize)) {
      const next = proactiveMailView(item, bodyLimits.perMail, related.get(item.messageId)).size;
      if (batch.length > 0 && size + next > bodyLimits.perBatch) break;
      batch.push(item);
      size += next;
    }
    return batch;
  }

  #repliedThreads(
    items: readonly ProactiveSourceItem[],
    candidates: readonly ProactiveSourceItem[],
    settled: ReadonlyMap<string, { readonly result: ProactiveResult; readonly sure: boolean }>,
  ): readonly { readonly threadId: string; readonly receivedAt: string }[] {
    const latestOwn = new Map<string, ProactiveSourceItem>();
    for (const item of items) {
      if (!item.sentByOwner || item.categories.includes("spam")) continue;
      const previous = latestOwn.get(item.threadId);
      if (
        !previous ||
        item.receivedAt > previous.receivedAt ||
        (item.receivedAt === previous.receivedAt && item.messageId > previous.messageId)
      )
        latestOwn.set(item.threadId, item);
    }
    return [...latestOwn.entries()]
      .filter(([threadId, own]) => {
        const verdict = settled.get(own.messageId);
        if (verdict?.result !== "ignore" || !verdict.sure) return false;
        return !candidates.some(
          (item) => item.threadId === threadId && item.receivedAt > own.receivedAt,
        );
      })
      .map(([threadId, own]) => ({ threadId, receivedAt: own.receivedAt }));
  }

  #reason(
    verdict: ProactiveVerdict,
    stop: Stop,
    failure: string | null,
    fetched: number,
    counts: ProactiveCounts,
    backoff?: BackoffOutcome,
  ) {
    if (stop === "capped_daily") return "DAILY_LIMIT";
    if (stop === "capped") return "CHECK_LIMIT";
    if (stop === "failed") return failure ?? "MODEL_OUTPUT_INVALID";
    if (counts.pushed === 0 && backoff?.steppedUp) return "PUSH_BACKED_OFF";
    if (counts.pushed === 0 && backoff && backoff.suppressed > 0) return "PUSH_SUPPRESSED";
    if (verdict === "deferred") return "QUIET_HOURS";
    if (verdict === "pushed") return "URGENT";
    if (fetched === 0) return "NO_NEW_MAIL";
    if (counts.floorRaised > 0) return "FLOOR_RAISED";
    return "NOTHING_URGENT";
  }

  async #gateBackoff(
    insights: readonly ProactiveCheckInsight[],
    startedAt: string,
  ): Promise<BackoffOutcome> {
    const settings: ProactiveBackoffSettings = {
      ...DEFAULT_PROACTIVE_BACKOFF,
      ...this.#options.backoff,
    };
    const classKeys = [
      ...new Set(
        insights.flatMap(({ push, pushClass }) => (push && pushClass !== null ? [pushClass] : [])),
      ),
    ].sort();
    if (settings.threshold <= 0 || classKeys.length === 0)
      return { insights, writes: [], steppedUp: false, suppressed: 0 };
    const previews = await this.#options.store.previewBackoff({
      ...this.#options.scope,
      classKeys,
      settings,
      now: startedAt,
    });
    const byClass = new Map(previews.map((preview) => [preview.classKey, preview]));
    let suppressed = 0;
    const gated = insights.map((insight) => {
      const preview = insight.pushClass === null ? undefined : byClass.get(insight.pushClass);
      if (!insight.push || preview?.action !== "suppress") return insight;
      suppressed += 1;
      return { ...insight, push: false };
    });
    const writes = previews
      .filter(({ stage, steppedUp }) => steppedUp || stage > 0)
      .map(
        (preview): ProactiveBackoffWrite => ({
          classKey: preview.classKey,
          stage: preview.stage,
          sinceAt: preview.sinceAt,
          lastPushAt: preview.lastPushAt,
          stageChangedAt: preview.stageChangedAt,
          ignoredCount: preview.ignoredCount,
          steppedUp: preview.steppedUp,
          base: preview.base,
        }),
      );
    return {
      insights: gated,
      writes,
      steppedUp: previews.some(({ steppedUp }) => steppedUp),
      suppressed,
    };
  }

  #base(item: ProactiveSourceItem) {
    return {
      source: item.source,
      messageId: item.messageId,
      threadId: item.threadId,
      receivedAt: item.receivedAt,
    };
  }

  #skip(item: ProactiveSourceItem, reason: ProactiveCheckProcessed["skipReason"]) {
    return {
      ...this.#base(item),
      outcome: "skipped" as const,
      skipReason: reason,
      headerRef: null,
    };
  }

  async #seal(
    trace: CheckTrace,
    value: Record<string, string | boolean>,
    dataClassification: DataClassification = "private",
  ): Promise<string> {
    const ref = await this.#options.seal.seal({
      ...this.#options.scope,
      dataClassification,
      text: JSON.stringify(value),
      at: this.#options.clock.now(),
    });
    trace.sealed.push(ref);
    return ref;
  }

  async #invoke(
    prompt: string,
    dataClassification: DataClassification,
    deadlineAt: string,
    signal: AbortSignal,
    trace: CheckTrace,
    beforeInvoke: () => void = () => undefined,
  ): Promise<ModelCall> {
    const { model } = this.#options;
    const invocationId = this.#options.ids.next("proactive-model");
    const authority = await model.prepare({ invocationId, prompt, deadlineAt, dataClassification });
    trace.payloads.push({ ref: authority.inputRef, role: "model_input" });
    beforeInvoke();
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
        dataClassification,
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
    return { output, completed, truncated, failure, costMicros };
  }

  async #judge(
    batch: readonly ProactiveSourceItem[],
    prompt: string,
    deadlineAt: string,
    signal: AbortSignal,
    trace: CheckTrace,
    promptMemories: readonly PromptMemory[],
    related: ReadonlyMap<string, RelatedView>,
    summaries: readonly PromptSummary[],
  ): Promise<JudgeOutcome> {
    const dataClassification = highestClassification("private", [
      ...promptMemories.map((memory) => memory.dataClassification),
      ...summaries.map((summary) => summary.dataClassification),
    ]);
    const call = await this.#invoke(prompt, dataClassification, deadlineAt, signal, trace, () => {
      for (const { messageId } of batch) {
        trace.sourceIds.add(messageId);
        const view = related.get(messageId);
        if (view === undefined || view.mails.length === 0 || trace.relatedSent.has(messageId))
          continue;
        trace.relatedSent.add(messageId);
        trace.relatedByMail.set(
          messageId,
          view.mails.map((mail) => mail.messageId),
        );
        trace.relatedStats = {
          ...trace.relatedStats,
          messages: trace.relatedStats.messages + view.mails.length,
          characters:
            trace.relatedStats.characters +
            view.json.reduce<number>((sum, entry) => sum + JSON.stringify(entry).length, 0),
        };
      }
      for (const memory of promptMemories) {
        trace.memoryIds.add(memory.id);
        if (memory.tentative) trace.tentativeMemoryIds.add(memory.id);
        const list = trace.memoryByMail.get(memory.mailId) ?? [];
        if (!list.includes(memory.id)) list.push(memory.id);
        trace.memoryByMail.set(memory.mailId, list);
      }
      for (const summary of summaries) {
        if (trace.summaryIds.has(summary.id)) continue;
        trace.summaryIds.add(summary.id);
        trace.summaryDays.add(summary.day);
        trace.summaryCharacters += summary.text.length;
      }
    });
    const { output, completed, truncated, failure, costMicros } = call;
    if (failure) return { judgements: undefined, costMicros, failure };
    if (!completed) return { judgements: undefined, costMicros, failure: "MODEL_NOT_COMPLETED" };
    const perMail = { ...DEFAULT_PROACTIVE_BODY_LIMITS, ...this.#options.bodyLimits }.perMail;
    const judgements = parseJudgements(output, batch, (item) => {
      const json = proactiveMailView(item, perMail).json;
      return (
        json["bodyTruncated"] !== true && json["bodyUnavailable"] !== true && item.body !== null
      );
    });
    if (judgements) {
      const injected = new Set(promptMemories.map(({ id }) => id));
      for (const { usedMemoryIds } of judgements.values())
        for (const id of usedMemoryIds) if (injected.has(id)) trace.usedMemoryIds.add(id);
      return { judgements, costMicros, failure: null, dataClassification };
    }
    return {
      judgements: undefined,
      costMicros,
      failure: truncated ? "MODEL_OUTPUT_TRUNCATED" : "MODEL_OUTPUT_INVALID",
    };
  }

  #summariesOff(): boolean {
    const limits = { ...DEFAULT_PROACTIVE_SUMMARY_LIMITS, ...this.#options.summaryLimits };
    return (
      this.#options.recentSummaries === undefined ||
      limits.days < 1 ||
      limits.perCheck < 1 ||
      limits.characters < 1
    );
  }

  async #summaries(
    deadlineAt: string,
    signal: AbortSignal,
    trace: CheckTrace,
    budget: { readonly spentToday: number; readonly reserveMicros: number; costMicros: number },
  ): Promise<readonly PromptSummary[]> {
    const source = this.#options.recentSummaries;
    if (source === undefined) return [];
    const limits = { ...DEFAULT_PROACTIVE_SUMMARY_LIMITS, ...this.#options.summaryLimits };
    if (limits.days < 1 || limits.perCheck < 1 || limits.characters < 1) return [];
    if (limits.catchUpPerCheck > 0) {
      try {
        const catchUpMs = Math.floor(this.#options.limits.perCheckMs / 4);
        const catchUpSignal = AbortSignal.any([signal, AbortSignal.timeout(catchUpMs)]);
        const catchUpDeadlineAt = new Date(
          Math.min(Date.parse(deadlineAt), Date.parse(this.#options.clock.now()) + catchUpMs),
        ).toISOString();
        const caught = await source.catchUp({
          days: limits.days,
          limit: limits.catchUpPerCheck,
          deadlineAt: catchUpDeadlineAt,
          signal: catchUpSignal,
          generate: async (prompt, dataClassification) => {
            if (
              budget.spentToday +
                budget.costMicros +
                budget.reserveMicros +
                this.#options.limits.estimateCostMicros(prompt) >
              this.#options.limits.dailyCostMicros
            )
              throw new Error("PROACTIVE_SUMMARY_DAILY_CAP");
            const call = await this.#invoke(
              prompt,
              dataClassification,
              catchUpDeadlineAt,
              catchUpSignal,
              trace,
            );
            budget.costMicros += call.costMicros;
            if (call.failure) throw new Error(call.failure);
            if (!call.completed || call.truncated) throw new Error("PROACTIVE_SUMMARY_INCOMPLETE");
            return call.output;
          },
        });
        trace.summaryGenerated += caught.generated;
        budget.costMicros += Math.max(0, caught.costMicros);
        if (caught.failed) trace.summaryRead = "partial";
      } catch {
        trace.summaryRead = "partial";
      }
    }
    try {
      const found = await source.recent({ days: limits.days, limit: limits.perCheck });
      const chosen: PromptSummary[] = [];
      let characters = 0;
      for (const summary of found.summaries) {
        if (chosen.length >= limits.perCheck) break;
        if (characters + summary.text.length > limits.characters) break;
        characters += summary.text.length;
        chosen.push(
          Object.freeze({
            id: summary.id,
            day: summary.day,
            text: summary.text,
            dataClassification: summary.dataClassification,
          }),
        );
      }
      if (trace.summaryRead !== "partial") trace.summaryRead = found.partial ? "partial" : "ok";
      return chosen.reverse();
    } catch {
      trace.summaryRead = "failed";
      return [];
    }
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
      query: [
        ...(item.sentByOwner ? [] : [masked(item.from)]),
        masked(item.subject),
        Array.from(masked(item.body ?? item.snippet))
          .slice(0, RECALL_BODY_CHARACTERS)
          .join(""),
      ]
        .join("\n")
        .slice(0, limits.queryCharacters),
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
          ...(hit.tentative ? { tentative: true as const } : {}),
          dataClassification: hit.dataClassification,
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
      rules: [],
      floorHits: {},
      ruleHits: {},
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
      readonly replied: readonly { readonly threadId: string; readonly receivedAt: string }[];
      readonly costMicros: number;
      readonly cursor: string | null;
      readonly quietHours: ProactiveSettings["quietHours"];
      readonly rules: readonly RuleRecord[];
      readonly floorHits: Readonly<Record<string, readonly string[]>>;
      readonly ruleHits: Readonly<Record<string, readonly string[]>>;
      readonly backoff?: readonly ProactiveBackoffWrite[];
    },
  ): Promise<ProactiveDecision> {
    const { store, scope, ids, clock } = this.#options;
    const pushing = input.insights.some(({ push }) => push);
    let push: { id: string; readyAt: string } | null = null;
    let quietRefs: readonly string[] = [];
    if (pushing) {
      const quiet = quietEnd(
        input.startedAt,
        input.rules,
        input.quietHours,
        this.#options.timeZone,
      );
      if (quiet) quietRefs = quietHitRefs(input.startedAt, input.rules, this.#options.timeZone);
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
        contentRef: await this.#seal(
          trace,
          {
            summary: insight.summary,
            reason: insight.reason,
            basis: insight.basis,
            floorHit: insight.floorHit,
            from: masked(insight.item.from),
            subject: masked(insight.item.subject),
            link: insight.item.link,
          },
          insight.dataClassification,
        ),
        dueAt: insight.dueAt,
        priority: insight.priority,
        push: insight.push,
        pushClass: insight.push ? insight.pushClass : null,
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
      ruleIds: [
        ...new Set([
          ...floorHitRefs(input.floorHits, input.rules),
          ...Object.values(input.ruleHits).flat(),
          ...quietRefs,
        ]),
      ].sort(),
      sourceIds: [...trace.sourceIds],
      floorHits: input.floorHits,
      ruleHits: input.ruleHits,
      memoryInjected: trace.memoryIds.size > 0,
      memoryIds: [...trace.memoryIds],
      usedMemoryIds: [...trace.usedMemoryIds],
      tentativeMemoryIds: [...trace.tentativeMemoryIds],
      memoryByMail: Object.fromEntries(trace.memoryByMail),
      memoryRecall: trace.memoryRecall,
      relatedByMail: Object.fromEntries(trace.relatedByMail),
      relatedRead: trace.relatedRead,
      relatedStats: trace.relatedStats,
      relatedFailedSteps: [...trace.relatedFailedSteps].sort(),
      ...(this.#options.recentSummaries === undefined
        ? {}
        : {
            summaryInjected: trace.summaryIds.size > 0,
            summaryIds: [...trace.summaryIds],
            summaryDays: [...trace.summaryDays].sort(),
            summaryCharacters: trace.summaryCharacters,
            summaryRead: trace.summaryRead,
            summaryGenerated: trace.summaryGenerated,
          }),
    });
    const result = await store.record({
      ...scope,
      decision,
      inputs,
      modelPayloads: trace.payloads,
      processed: input.processed,
      insights: writes,
      repliedThreads: input.replied,
      push,
      backoff: input.backoff ?? [],
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
> & { readonly receivedAt: string };

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
  readonly pushClass: string | null;
  readonly dataClassification: DataClassification;
}
