import { MEMORY_PERCEPTION_COMMIT_GATE, thresholdFor } from "@himawari-agent/calibration";
import type { MemoryGenerationId, MemoryId } from "@himawari-agent/domain";
import {
  PERCEPTION_DATA_NOTICE,
  PERCEPTION_EXTRACT,
  PERCEPTION_EXTRACT_CALENDAR_HEADER,
  PERCEPTION_EXTRACT_CONTINUED_NOTE,
  PERCEPTION_EXTRACT_OPEN_TODOS_HEADER,
  PERCEPTION_EXTRACT_RECORDS_HEADER,
  PERCEPTION_NOW_HEADER,
} from "@himawari-agent/prompt-catalog";
import { type EgressPlaceholderKind, redactForEgress } from "@himawari-agent/sensitive-capture";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { DataClassification, PayloadRef } from "../ports/common.js";
import type { DecisionLedgerWrite } from "../ports/decision-ledger.js";
import {
  DEFAULT_MEMORY_ATTRIBUTES,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemorySourceType,
  type ProductMemoryProposal,
  type ProductMemoryRecord,
} from "../ports/memory-projection.js";
import type {
  PerceptionConfiguration,
  PerceptionEpisode,
  PerceptionRecord,
  PerceptionRecordType,
  PerceptionScope,
  PerceptionSettings,
  PerceptionStorePort,
} from "../ports/perception.js";
import { USAGE_LIMITS } from "../ports/usage-limits.js";
import { highestClassification, isModelVisible } from "./model-visibility.js";
import { ownerDayBounds, ownerLocalDay } from "./owner-day.js";
import { zonedParts } from "./proactive-rules.js";

export type EgressPlaceholderTag = (kind: EgressPlaceholderKind, value: string) => string;

export const PERCEPTION_EXTRACT_POLICY_VERSION = "perception-extract:v1";
export const PERCEPTION_COST_LIMIT_KEY = "perception.model_cost.daily";
export const PERCEPTION_ABOUT = ["owner", "contact", "unknown"] as const;
export type PerceptionAbout = (typeof PERCEPTION_ABOUT)[number];

export const PERCEPTION_REASON_CODES = Object.freeze({
  committed: "perception_committed",
  belowThreshold: "perception_below_threshold",
  keptTentative: "perception_kept_tentative",
  sensitiveTentative: "perception_sensitive_tentative",
  quoteUnverified: "perception_quote_unverified",
  textMasked: "perception_text_masked",
  restricted: "perception_restricted",
  proposed: "perception_proposed",
  doneProposed: "perception_done_proposed",
});

const DAY_MS = 86_400_000;
const TEXT_MAXIMUM = 500;
const QUOTE_MAXIMUM = 2000;

function digest(value: string, length = 40): string {
  return bytesToHex(sha256(utf8ToBytes(value))).slice(0, length);
}

function localMinute(atMs: number, timeZone: string): string {
  const parts = zonedParts(new Date(atMs).toISOString(), timeZone);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${ownerLocalDay(atMs, timeZone)}T${two(parts.hour)}:${two(parts.minute)}`;
}

function sortedObject(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

export interface PerceptionExtractionSource {
  readonly record: PerceptionRecord;
  readonly text: string | null;
}

export interface PerceptionExtractionChunk {
  readonly prompt: string;
  readonly dataClassification: DataClassification;
  readonly sources: readonly (PerceptionExtractionSource & { readonly masked: string | null })[];
}

export interface PerceptionOpenTodo {
  readonly id: string;
  readonly text: string;
  readonly due: string;
}

export function perceptionCalendarTable(input: {
  readonly fromMs: number;
  readonly days: number;
  readonly timeZone: string;
}): readonly string[] {
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: input.timeZone, weekday: "short" });
  const lines: string[] = [];
  let previous = "";
  for (let at = input.fromMs; lines.length < input.days; at += DAY_MS / 2) {
    const day = ownerLocalDay(at, input.timeZone);
    if (day === previous) continue;
    previous = day;
    lines.push(`${day} ${weekday.format(new Date(at))}`);
  }
  return lines;
}

export function buildPerceptionExtractionChunks(input: {
  readonly sources: readonly PerceptionExtractionSource[];
  readonly maximumCharacters: number;
  readonly timeZone: string;
  readonly now: string;
  readonly calendarDays: number;
  readonly openTodos: readonly PerceptionOpenTodo[];
  readonly tag: (kind: EgressPlaceholderKind, value: string) => string;
  readonly placeholders: Map<string, string>;
}): readonly PerceptionExtractionChunk[] {
  const ordered = [...input.sources].sort(
    (left, right) =>
      left.record.occurredAtMs - right.record.occurredAtMs ||
      (left.record.id < right.record.id ? -1 : left.record.id > right.record.id ? 1 : 0),
  );
  const known = new Map<string, string>();
  const lines = ordered.map((source) => {
    const masked =
      source.text === null
        ? null
        : redactForEgress(source.text, { tag: input.tag, known, table: input.placeholders }).text;
    const { record } = source;
    return {
      source: { ...source, masked },
      line: JSON.stringify({
        id: record.id,
        type: record.type,
        at: localMinute(record.occurredAtMs, input.timeZone),
        origin: record.origin,
        ...(record.speakerKind === null ? {} : { speaker: record.speakerKind }),
        ...(masked === null ? {} : { text: masked }),
        evidence: sortedObject(record.evidence),
      }),
    };
  });
  const groups: (typeof lines)[] = [];
  let size = 0;
  for (const entry of lines) {
    const length = [...entry.line].length;
    const current = groups.at(-1);
    if (!current || size + length > input.maximumCharacters) {
      groups.push([entry]);
      size = length;
    } else {
      current.push(entry);
      size += length;
    }
  }
  const nowMs = Date.parse(input.now);
  const firstMs = ordered[0]?.record.occurredAtMs ?? nowMs;
  const tail = [
    ...(input.openTodos.length === 0
      ? []
      : [
          PERCEPTION_EXTRACT_OPEN_TODOS_HEADER.text,
          ...[...input.openTodos]
            .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
            .map((todo) => JSON.stringify({ id: todo.id, text: todo.text, due: todo.due })),
        ]),
    PERCEPTION_EXTRACT_CALENDAR_HEADER.text,
    ...perceptionCalendarTable({
      fromMs: Math.min(firstMs, nowMs),
      days: input.calendarDays + Math.ceil(Math.max(0, nowMs - firstMs) / DAY_MS),
      timeZone: input.timeZone,
    }),
    PERCEPTION_NOW_HEADER.text,
    localMinute(nowMs, input.timeZone),
  ];
  return groups.map((group, index) => ({
    prompt: [
      PERCEPTION_EXTRACT.text,
      PERCEPTION_DATA_NOTICE.text,
      ...(index === 0 ? [] : [PERCEPTION_EXTRACT_CONTINUED_NOTE.text]),
      PERCEPTION_EXTRACT_RECORDS_HEADER.text,
      ...group.map(({ line }) => line),
      ...tail,
    ].join("\n"),
    dataClassification: highestClassification(
      "private",
      group.map(({ source }) => source.record.dataClassification),
    ),
    sources: group.map(({ source }) => source),
  }));
}

export interface PerceptionCandidate {
  readonly text: string;
  readonly category: MemoryCategory;
  readonly confidence: number;
  readonly about: PerceptionAbout;
  readonly quote: string;
  readonly recordIds: readonly string[];
}

export interface PerceptionProposal {
  readonly what: string;
  readonly quote: string;
  readonly recordIds: readonly string[];
}

export interface PerceptionDoneHint {
  readonly id: string;
  readonly quote: string;
  readonly recordIds: readonly string[];
}

export interface ParsedPerceptionExtraction {
  readonly candidates: readonly PerceptionCandidate[];
  readonly proposals: readonly PerceptionProposal[];
  readonly doneHints: readonly PerceptionDoneHint[];
  readonly dropped: number;
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || [...trimmed].length > maximum ? null : trimmed;
}

function idList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;
  if (value.some((id) => typeof id !== "string" || id.length === 0)) return null;
  return [...new Set(value as string[])].sort();
}

function list(value: unknown): readonly Record<string, unknown>[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

export function parsePerceptionExtraction(
  output: string,
  maximumCandidates: number,
): ParsedPerceptionExtraction | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const rawCandidates = list(root["candidates"]);
  const rawProposals = list(root["proposals"]);
  const rawHints = list(root["doneHints"]);
  if (rawCandidates === null || rawProposals === null || rawHints === null) return null;
  let dropped = 0;
  const keep = <T>(
    items: readonly Record<string, unknown>[],
    read: (item: Record<string, unknown>) => T | null,
  ) => {
    const kept: T[] = [];
    for (const item of items) {
      const value = kept.length < maximumCandidates ? read(item) : null;
      if (value === null) dropped += 1;
      else kept.push(value);
    }
    return kept;
  };
  const candidates = keep(rawCandidates, (item): PerceptionCandidate | null => {
    const text = boundedText(item["text"], TEXT_MAXIMUM);
    const quote = boundedText(item["quote"], QUOTE_MAXIMUM);
    const recordIds = idList(item["recordIds"]);
    const { category, confidence, about } = item;
    if (
      text === null ||
      quote === null ||
      recordIds === null ||
      !(MEMORY_CATEGORIES as readonly unknown[]).includes(category) ||
      !Number.isSafeInteger(confidence) ||
      (confidence as number) < 0 ||
      (confidence as number) > 1000 ||
      !(PERCEPTION_ABOUT as readonly unknown[]).includes(about)
    )
      return null;
    return {
      text,
      quote,
      recordIds,
      category: category as MemoryCategory,
      confidence: confidence as number,
      about: about as PerceptionAbout,
    };
  });
  const proposals = keep(rawProposals, (item): PerceptionProposal | null => {
    const what = boundedText(item["what"], TEXT_MAXIMUM);
    const quote = boundedText(item["quote"], QUOTE_MAXIMUM);
    const recordIds = idList(item["recordIds"]);
    return what === null || quote === null || recordIds === null
      ? null
      : { what, quote, recordIds };
  });
  const doneHints = keep(rawHints, (item): PerceptionDoneHint | null => {
    const id = boundedText(item["id"], 256);
    const quote = boundedText(item["quote"], QUOTE_MAXIMUM);
    const recordIds = idList(item["recordIds"]);
    return id === null || quote === null || recordIds === null ? null : { id, quote, recordIds };
  });
  return { candidates, proposals, doneHints, dropped };
}

export function quotedSource(
  chunk: PerceptionExtractionChunk,
  quote: string,
  recordIds: readonly string[],
): PerceptionExtractionChunk["sources"][number] | null {
  for (const source of chunk.sources)
    if (
      recordIds.includes(source.record.id) &&
      source.masked !== null &&
      source.text !== null &&
      source.masked.includes(quote) &&
      source.text.includes(quote)
    )
      return source;
  return null;
}

export const PERCEPTION_PROPOSAL_SOURCE_KINDS = ["perception_episode"] as const;
export type PerceptionProposalSourceKind = (typeof PERCEPTION_PROPOSAL_SOURCE_KINDS)[number];

export const PERCEPTION_PROPOSAL_TRUST = ["owner", "external"] as const;
export type PerceptionProposalTrust = (typeof PERCEPTION_PROPOSAL_TRUST)[number];

export const COMMAND_UTTERANCE_BATCH = 1000;

export function commandUtteranceBatches(utteranceIds: readonly string[]): string[][] {
  const distinct = [...new Set(utteranceIds)].sort();
  const batches: string[][] = [];
  for (let start = 0; start < distinct.length; start += COMMAND_UTTERANCE_BATCH)
    batches.push(distinct.slice(start, start + COMMAND_UTTERANCE_BATCH));
  return batches;
}

export interface PerceptionProposalSource {
  readonly recordType: PerceptionRecord["type"];
  readonly origin: PerceptionRecord["origin"];
  readonly captureSource: PerceptionRecord["captureSource"];
  readonly occurredAtDevice: string;
  readonly speakerKind: PerceptionRecord["speakerKind"];
  readonly speakerRef: string | null;
}

function chunkTrust(chunk: PerceptionExtractionChunk): PerceptionProposalTrust {
  return chunk.sources.every(({ record }) => record.origin === "owner_spoken")
    ? "owner"
    : "external";
}

function proposalSource(record: PerceptionRecord): PerceptionProposalSource {
  return {
    recordType: record.type,
    origin: record.origin,
    captureSource: record.captureSource,
    occurredAtDevice: record.occurredAtDevice,
    speakerKind: record.speakerKind,
    speakerRef: record.speakerRef,
  };
}

export interface VerifiedPerceptionProposal {
  readonly id: string;
  readonly sourceKind: PerceptionProposalSourceKind;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly kind: "next_step" | "todo_done";
  readonly what: string | null;
  readonly todoId: string | null;
  readonly quote: string | null;
  readonly quotedRecordId: string | null;
  readonly trust: PerceptionProposalTrust;
  readonly source: PerceptionProposalSource | null;
  readonly observedAt: string;
  readonly recordIds: readonly string[];
  readonly action: {
    readonly capabilityRef: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  } | null;
}

export interface PerceptionProposalPort {
  receive(proposals: readonly VerifiedPerceptionProposal[]): Promise<void>;
}

export interface PerceptionExtractionModel {
  estimateMicros(prompt: string, maxOutputTokens: number): number;
  generate(input: {
    readonly invocationId: string;
    readonly prompt: string;
    readonly maxOutputTokens: number;
    readonly dataClassification: DataClassification;
  }): Promise<{ readonly output: string; readonly costMicros: number }>;
}

export interface PerceptionExtractionOptions {
  readonly scope: PerceptionScope;
  readonly store: Pick<
    PerceptionStorePort,
    | "listEpisodesToExtract"
    | "readEpisode"
    | "beginExtraction"
    | "settleExtraction"
    | "commandUtterances"
    | "listMirror"
    | "readSettings"
    | "reserveUsage"
  >;
  readonly model: PerceptionExtractionModel;
  readonly readText: (contentRef: string) => Promise<string | undefined>;
  readonly tag: () => Promise<(kind: EgressPlaceholderKind, value: string) => string>;
  readonly memory: {
    applyProposal(
      proposal: ProductMemoryProposal,
      generationId: MemoryGenerationId,
      ledger?: DecisionLedgerWrite,
    ): Promise<ProductMemoryRecord>;
  };
  readonly memories: { read(id: MemoryId): Promise<ProductMemoryRecord | undefined> };
  readonly generation: () => Promise<MemoryGenerationId | undefined>;
  readonly storeText: (input: {
    readonly key: string;
    readonly text: string;
    readonly dataClassification: DataClassification;
    readonly createdAt: string;
  }) => Promise<PayloadRef>;
  readonly openTodos: () => Promise<readonly PerceptionOpenTodo[]>;
  readonly proposals?: PerceptionProposalPort;
  readonly onEpisode?: (input: {
    readonly episode: PerceptionEpisode;
    readonly types: readonly PerceptionRecordType[];
  }) => Promise<void>;
  readonly configuration: () => PerceptionConfiguration;
  readonly maximumCharacters: () => number;
  readonly timeZone: () => string;
  readonly now: () => string;
  readonly invocationId: (key: string) => string;
}

export interface PerceptionExtractionReport {
  readonly episodes: number;
  readonly done: number;
  readonly retry: number;
  readonly waitingBudget: number;
  readonly failed: number;
  readonly memories: number;
  readonly tentative: number;
  readonly proposals: number;
  readonly discarded: number;
  readonly costMicros: number;
}

interface Tally {
  memories: number;
  tentative: number;
  proposals: number;
  discarded: number;
}

class BudgetReached extends Error {}

export class PerceptionExtractionService {
  readonly #options: PerceptionExtractionOptions;

  constructor(options: PerceptionExtractionOptions) {
    this.#options = options;
  }

  async runOnce(): Promise<PerceptionExtractionReport> {
    const { scope, store } = this.#options;
    const configuration = this.#options.configuration();
    const now = this.#options.now();
    const episodes = await store.listEpisodesToExtract({
      ...scope,
      endedBeforeMs: Date.parse(now) - configuration.episodeSilenceSeconds * 1000,
      now,
      maximumAttempts: configuration.extractMaximumAttempts,
      limit: configuration.extractBatchEpisodes,
    });
    const report = {
      episodes: episodes.length,
      done: 0,
      retry: 0,
      waitingBudget: 0,
      failed: 0,
      memories: 0,
      tentative: 0,
      proposals: 0,
      discarded: 0,
      costMicros: 0,
    };
    for (const episode of episodes) {
      const outcome = await this.#episode(episode, configuration);
      if (outcome === null) continue;
      report[
        outcome.status === "waiting_budget"
          ? "waitingBudget"
          : (outcome.status as "done" | "retry" | "failed")
      ] += 1;
      report.costMicros += outcome.costMicros;
      for (const key of ["memories", "tentative", "proposals", "discarded"] as const)
        report[key] += outcome.tally[key];
      if (outcome.status === "waiting_budget") break;
    }
    return report;
  }

  async #sources(episode: PerceptionEpisode): Promise<PerceptionExtractionSource[]> {
    const { scope, store } = this.#options;
    const records: PerceptionRecord[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await store.readEpisode({
        ...scope,
        episodeId: episode.id,
        cursor,
        limit: 500,
      });
      if (!page) break;
      records.push(...page.records);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    const utterances = records.flatMap((record) =>
      typeof record.evidence["utteranceId"] === "string" ? [record.evidence["utteranceId"]] : [],
    );
    const commands = new Set<string>();
    for (const utteranceIds of commandUtteranceBatches(utterances))
      for (const id of await store.commandUtterances({ ...scope, utteranceIds })) commands.add(id);
    const sources: PerceptionExtractionSource[] = [];
    for (const record of records) {
      if (!isModelVisible(record.dataClassification)) continue;
      const utterance = record.evidence["utteranceId"];
      if (typeof utterance === "string" && commands.has(utterance)) continue;
      const text =
        record.contentRef === null ? undefined : await this.#options.readText(record.contentRef);
      sources.push({ record, text: text ?? null });
    }
    return sources;
  }

  #limit(settings: PerceptionSettings): number | null {
    return (
      settings.limitOverrides[PERCEPTION_COST_LIMIT_KEY] ??
      USAGE_LIMITS[PERCEPTION_COST_LIMIT_KEY].defaultLimit
    );
  }

  async #episode(episode: PerceptionEpisode, configuration: PerceptionConfiguration) {
    const { scope, store } = this.#options;
    const startedAt = this.#options.now();
    const begun = await store.beginExtraction({
      ...scope,
      episodeId: episode.id,
      recordCount: episode.recordCount,
      leaseUntil: new Date(
        Date.parse(startedAt) + 2 * configuration.extractRequestTimeoutSeconds * 1000,
      ).toISOString(),
      now: startedAt,
    });
    if (!begun) return null;
    const tally: Tally = { memories: 0, tentative: 0, proposals: 0, discarded: 0 };
    const decisions: DecisionLedgerWrite[] = [];
    let costMicros = 0;
    const settle = async (
      status: "done" | "retry" | "waiting_budget" | "failed",
      errorCode: string | null,
      nextAttemptAt: string | null,
    ) => {
      await store.settleExtraction({
        ...scope,
        episodeId: episode.id,
        status,
        nextAttemptAt,
        errorCode,
        costMicros,
        now: this.#options.now(),
        decisions,
      });
      return { status, costMicros, tally };
    };
    try {
      const sources = await this.#sources(episode);
      if (sources.length > 0)
        await this.#options.onEpisode?.({
          episode,
          types: [...new Set(sources.map(({ record }) => record.type))],
        });
      if (sources.every(({ text }) => text === null)) return await settle("done", null, null);
      const timeZone = this.#options.timeZone();
      const placeholders = new Map<string, string>();
      const openTodos = await this.#options.openTodos();
      const chunks = buildPerceptionExtractionChunks({
        sources,
        maximumCharacters: this.#options.maximumCharacters(),
        timeZone,
        now: startedAt,
        calendarDays: configuration.extractCalendarDays,
        openTodos,
        tag: await this.#options.tag(),
        placeholders,
      });
      const bounds = ownerDayBounds(startedAt, timeZone);
      const settings = await store.readSettings(scope);
      for (const [index, chunk] of chunks.entries()) {
        const estimate = this.#options.model.estimateMicros(
          chunk.prompt,
          configuration.extractMaximumOutputTokens,
        );
        if (
          !(await store.reserveUsage({
            ...scope,
            key: PERCEPTION_COST_LIMIT_KEY,
            periodStart: bounds.start,
            amount: estimate,
            limit: this.#limit(settings),
          }))
        )
          throw new BudgetReached();
        const call = await this.#options.model.generate({
          invocationId: this.#options.invocationId(
            `${episode.id}:${begun.recordCount}:${begun.attempts}:${index}`,
          ),
          prompt: chunk.prompt,
          maxOutputTokens: configuration.extractMaximumOutputTokens,
          dataClassification: chunk.dataClassification,
        });
        costMicros += call.costMicros;
        const parsed = parsePerceptionExtraction(
          call.output,
          configuration.extractMaximumCandidates,
        );
        if (parsed === null) throw new Error("PERCEPTION_EXTRACT_OUTPUT_INVALID");
        tally.discarded += parsed.dropped;
        const masked = (value: string) =>
          [...placeholders.keys()].some((placeholder) => value.includes(placeholder));
        for (const candidate of parsed.candidates)
          await this.#candidate(episode, chunk, candidate, masked, decisions, tally);
        const verified = [
          ...parsed.proposals.map((proposal) =>
            this.#proposal(episode, chunk, proposal, masked, decisions, tally),
          ),
          ...parsed.doneHints.map((hint) =>
            this.#doneHint(episode, chunk, hint, openTodos, decisions, tally),
          ),
        ].filter((proposal): proposal is VerifiedPerceptionProposal => proposal !== null);
        if (verified.length > 0) await this.#options.proposals?.receive(verified);
      }
      return await settle("done", null, null);
    } catch (error) {
      if (error instanceof BudgetReached)
        return settle(
          "waiting_budget",
          "PERCEPTION_MODEL_BUDGET_REACHED",
          ownerDayBounds(startedAt, this.#options.timeZone()).end,
        );
      const code = (error instanceof Error ? error.message : "PERCEPTION_EXTRACT_FAILED")
        .replace(/[^A-Za-z0-9_.:-]/gu, "_")
        .slice(0, 120);
      const exhausted = begun.attempts >= configuration.extractMaximumAttempts;
      return settle(
        exhausted ? "failed" : "retry",
        code.length > 0 ? code : "PERCEPTION_EXTRACT_FAILED",
        exhausted
          ? null
          : new Date(
              Date.parse(this.#options.now()) + configuration.extractRetrySeconds * 1000,
            ).toISOString(),
      );
    }
  }

  #ledger(
    key: string,
    outcome: "kept" | "discarded" | "proposed" | "not_proposed",
    reasonCode: string,
    detail: {
      readonly subjectRef: string;
      readonly contentRef?: string | null;
      readonly memoryIds?: readonly string[];
      readonly category?: MemoryCategory | null;
      readonly confidence?: number | null;
    },
  ): DecisionLedgerWrite {
    const proposal = outcome === "proposed" || outcome === "not_proposed";
    return {
      id: `ledger:${digest(`perception:${key}:${outcome}:${reasonCode}`)}`,
      ...this.#options.scope,
      kind: proposal ? "proposal" : "memory_candidate",
      decidedAt: this.#options.now(),
      outcome,
      reasonCode,
      subjectRef: detail.subjectRef,
      inputs: { memoryIds: [...(detail.memoryIds ?? [])], ruleIds: [] },
      reasonRef: null,
      contentRef: detail.contentRef ?? null,
      costMicros: 0,
      durationMs: 0,
      ...(proposal
        ? {}
        : {
            category: detail.category ?? null,
            confidencePermille: detail.confidence ?? null,
            inferred: false,
          }),
    };
  }

  async #contactName(source: PerceptionExtractionSource): Promise<string | null> {
    const { record } = source;
    if (record.speakerKind !== "contact" || record.speakerRef === null) return null;
    const contacts = await this.#options.store.listMirror({
      ...this.#options.scope,
      kind: "contact",
      includeDeleted: false,
    });
    const name = contacts.find(({ externalId }) => externalId === record.speakerRef)?.data?.[
      "name"
    ];
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
  }

  async #candidate(
    episode: PerceptionEpisode,
    chunk: PerceptionExtractionChunk,
    candidate: PerceptionCandidate,
    masked: (value: string) => boolean,
    decisions: DecisionLedgerWrite[],
    tally: Tally,
  ): Promise<void> {
    const { scope } = this.#options;
    const cited = chunk.sources.filter(({ record }) => candidate.recordIds.includes(record.id));
    const sourceIds = cited.map(({ record }) => record.id).sort();
    const key = digest(`${episode.id}\n${candidate.quote}\n${sourceIds.join("\n")}`, 32);
    const memoryId = `memory:perception:${key}` as MemoryId;
    const discard = (reasonCode: string) => {
      tally.discarded += 1;
      decisions.push(
        this.#ledger(key, "discarded", reasonCode, {
          subjectRef: episode.id,
          category: candidate.category,
          confidence: candidate.confidence,
        }),
      );
    };
    const quoted = quotedSource(chunk, candidate.quote, candidate.recordIds);
    if (quoted === null) return discard(PERCEPTION_REASON_CODES.quoteUnverified);
    if (masked(candidate.text)) return discard(PERCEPTION_REASON_CODES.textMasked);
    const dataClassification = highestClassification(
      "private",
      cited.map(({ record }) => record.dataClassification),
    );
    if (!isModelVisible(dataClassification)) return discard(PERCEPTION_REASON_CODES.restricted);
    if (await this.#options.memories.read(memoryId)) return;
    const generation = await this.#options.generation();
    if (!generation) throw new Error("PERCEPTION_MEMORY_NOT_READY");
    const ownerSpoken = quoted.record.origin === "owner_spoken";
    const passes =
      candidate.confidence >= thresholdFor(MEMORY_PERCEPTION_COMMIT_GATE, candidate.category);
    const reasonCode =
      !ownerSpoken || candidate.about === "unknown"
        ? PERCEPTION_REASON_CODES.keptTentative
        : passes
          ? PERCEPTION_REASON_CODES.committed
          : PERCEPTION_REASON_CODES.belowThreshold;
    const formal = reasonCode === PERCEPTION_REASON_CODES.committed;
    const contact =
      formal && candidate.about === "contact" ? await this.#contactName(quoted) : null;
    const createdAt = this.#options.now();
    const contentRef = await this.#options.storeText({
      key: `perception:${key}`,
      text: candidate.text,
      dataClassification,
      createdAt,
    });
    const quoteRef = await this.#options.storeText({
      key: `perception:${key}:quote`,
      text: candidate.quote,
      dataClassification,
      createdAt,
    });
    const sourceTypes: Record<string, MemorySourceType> = Object.fromEntries(
      sourceIds.map((id) => [id, "perception"]),
    );
    await this.#options.memory.applyProposal(
      {
        decision: "create",
        memory: {
          id: memoryId,
          ...scope,
          contentRef,
          dataClassification,
          sourceThreadId: null,
          sourceRefs: sourceIds,
          sourceTypes,
          inference: false,
          confidencePermille: candidate.confidence,
          policyVersion: PERCEPTION_EXTRACT_POLICY_VERSION,
          attributes: {
            ...DEFAULT_MEMORY_ATTRIBUTES,
            category: candidate.category,
            entities: contact === null ? [] : [contact],
            ...(formal ? {} : { tentative: true }),
          },
        },
        quoteRef,
      },
      generation,
      this.#ledger(key, "kept", reasonCode, {
        subjectRef: memoryId,
        contentRef,
        memoryIds: [memoryId],
        category: candidate.category,
        confidence: candidate.confidence,
      }),
    );
    tally[formal ? "memories" : "tentative"] += 1;
  }

  #proposal(
    episode: PerceptionEpisode,
    chunk: PerceptionExtractionChunk,
    proposal: PerceptionProposal,
    masked: (value: string) => boolean,
    decisions: DecisionLedgerWrite[],
    tally: Tally,
  ): VerifiedPerceptionProposal | null {
    const recordIds = chunk.sources
      .map(({ record }) => record.id)
      .filter((id) => proposal.recordIds.includes(id))
      .sort();
    const key = digest(`${episode.id}\nproposal\n${proposal.quote}\n${recordIds.join("\n")}`, 32);
    const quoted = quotedSource(chunk, proposal.quote, proposal.recordIds);
    if (quoted === null || masked(proposal.what)) {
      tally.discarded += 1;
      decisions.push(
        this.#ledger(
          key,
          "not_proposed",
          quoted === null
            ? PERCEPTION_REASON_CODES.quoteUnverified
            : PERCEPTION_REASON_CODES.textMasked,
          { subjectRef: episode.id },
        ),
      );
      return null;
    }
    tally.proposals += 1;
    decisions.push(
      this.#ledger(key, "proposed", PERCEPTION_REASON_CODES.proposed, {
        subjectRef: episode.id,
      }),
    );
    return {
      id: `proposal:${key}`,
      sourceKind: "perception_episode",
      sourceId: episode.id,
      sourceVersion: String(episode.recordCount),
      kind: "next_step",
      what: proposal.what,
      todoId: null,
      quote: proposal.quote,
      quotedRecordId: quoted.record.id,
      trust: chunkTrust(chunk),
      source: proposalSource(quoted.record),
      observedAt: new Date(quoted.record.occurredAtMs).toISOString(),
      recordIds,
      action: null,
    };
  }

  #doneHint(
    episode: PerceptionEpisode,
    chunk: PerceptionExtractionChunk,
    hint: PerceptionDoneHint,
    openTodos: readonly PerceptionOpenTodo[],
    decisions: DecisionLedgerWrite[],
    tally: Tally,
  ): VerifiedPerceptionProposal | null {
    const key = digest(`${episode.id}\ndone\n${hint.id}`, 32);
    const quoted = quotedSource(chunk, hint.quote, hint.recordIds);
    if (quoted === null || !openTodos.some(({ id }) => id === hint.id)) {
      tally.discarded += 1;
      decisions.push(
        this.#ledger(key, "not_proposed", PERCEPTION_REASON_CODES.quoteUnverified, {
          subjectRef: episode.id,
        }),
      );
      return null;
    }
    tally.proposals += 1;
    decisions.push(
      this.#ledger(key, "proposed", PERCEPTION_REASON_CODES.doneProposed, {
        subjectRef: episode.id,
      }),
    );
    return {
      id: `proposal:${key}`,
      sourceKind: "perception_episode",
      sourceId: episode.id,
      sourceVersion: String(episode.recordCount),
      kind: "todo_done",
      what: null,
      todoId: hint.id,
      quote: hint.quote,
      quotedRecordId: quoted.record.id,
      trust: chunkTrust(chunk),
      source: proposalSource(quoted.record),
      observedAt: new Date(quoted.record.occurredAtMs).toISOString(),
      recordIds: [quoted.record.id],
      action: null,
    };
  }
}
