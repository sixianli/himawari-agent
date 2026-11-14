import { HOME_URGENCY } from "@himawari-agent/prompt-catalog";
import { maskSensitiveText } from "@himawari-agent/sensitive-capture";
import type { DataClassification } from "../ports/common.js";
import type { HomeUrgencyConfiguration } from "../ports/configuration.js";
import {
  HOME_URGENCY_ITEMS_PER_READ,
  HOME_URGENCY_LABEL_STORE_MAX,
  HOME_URGENCY_SCORE_MAX,
  type HomeUrgencyAttempt,
  type HomeUrgencyFailure,
  type HomeUrgencyItemRef,
  type HomeUrgencyRecord,
  type HomeUrgencyStorePort,
} from "../ports/home-urgency.js";
import type { ModelInvocationRequest } from "../ports/intelligence.js";
import type { ProactiveScope, ProactiveSealPort } from "../ports/proactive-checks.js";
import type { ClockPort } from "../ports/system.js";
import type { ProactiveModelInvoker } from "./proactive-mail-check-service.js";
import { startOfZonedDay } from "./proactive-rules.js";

const MAX_OUTPUT_BYTES = 16_384;
const HOUR_MS = 3_600_000;
export const HOME_URGENCY_SENTENCE_STORE_MAX = 400;

export const DEFAULT_HOME_URGENCY: HomeUrgencyConfiguration = Object.freeze({
  enabled: true,
  dailyLimit: 1_000,
  dailyCostMicros: 1_000_000,
  perCall: 20,
  referenceLimit: 30,
  requestTimeoutMs: 30_000,
  checkIntervalSeconds: 60,
  retryAfterHours: 24,
  affirmLabelMax: Object.freeze({ "zh-CN": 6, ja: 8, en: 16 }),
});

export type HomeUrgencyFact =
  | string
  | number
  | boolean
  | null
  | readonly HomeUrgencyFact[]
  | { readonly [key: string]: HomeUrgencyFact };

export interface HomeUrgencyCandidate {
  readonly key: string;
  readonly kind: string;
  readonly deadline: string | null;
  readonly dataClassification: DataClassification;
  readonly digestBasis: string;
  readonly facts: { readonly [key: string]: HomeUrgencyFact };
  readonly approvalRequestId?: string;
}

export interface HomeUrgencyReplyItem {
  readonly score: number;
  readonly sentence: string | null;
  readonly affirm: string | null;
}

export interface HomeApprovalCopy {
  readonly sentence: string | null;
  readonly affirmLabel: string | null;
}

export interface HomeUrgencyRunResult {
  readonly attempted: number;
  readonly recorded: number;
  readonly failures: readonly string[];
  readonly stoppedBy: "done" | "nothing_new" | "daily_limit" | "daily_cost" | "disabled";
}

export interface HomeUrgencyOptions {
  readonly scope: ProactiveScope;
  readonly store: HomeUrgencyStorePort;
  readonly seal: ProactiveSealPort;
  readonly model: ProactiveModelInvoker;
  readonly modelAllows: (classification: DataClassification) => boolean;
  readonly settings: HomeUrgencyConfiguration;
  readonly timeZone: string;
  readonly clock: ClockPort;
  readonly digest: (text: string) => string;
  readonly estimateCostMicros: (prompt: string) => number;
  readonly candidates: () => Promise<readonly HomeUrgencyCandidate[]>;
  readonly locale: () => Promise<string>;
}

const CLASSIFICATION_ORDER: readonly DataClassification[] = [
  "public",
  "private",
  "sensitive",
  "restricted",
];

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function graphemes(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
}

function maskFact(fact: HomeUrgencyFact): HomeUrgencyFact {
  if (typeof fact === "string") return maskSensitiveText(fact);
  if (fact === null || typeof fact !== "object") return fact;
  if (Array.isArray(fact)) return fact.map(maskFact);
  const record = fact as { readonly [key: string]: HomeUrgencyFact };
  return Object.fromEntries(
    Object.keys(record)
      .sort(compare)
      .map((key) => [key, maskFact(record[key] as HomeUrgencyFact)]),
  );
}

export function homeUrgencyPromptId(digest: (text: string) => string): string {
  return `${HOME_URGENCY.id}@${digest(HOME_URGENCY.text).slice(0, 12)}`;
}

export function homeAffirmLabelMax(
  limits: Readonly<Record<string, number>>,
  locale: string,
): number | undefined {
  const limit = limits[locale];
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

const UNSAFE_LINE_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

export function acceptsHomeAffirmLabel(input: {
  readonly label: string | null;
  readonly locale: string;
  readonly limits: Readonly<Record<string, number>>;
  readonly negativeLabel: string;
}): boolean {
  const limit = homeAffirmLabelMax(input.limits, input.locale);
  if (input.label === null || limit === undefined) return false;
  const label = input.label.trim();
  if (
    label.length === 0 ||
    label !== input.label ||
    UNSAFE_LINE_CHARACTERS.test(label) ||
    label.replace(/\p{Cf}/gu, "").trim().length === 0
  )
    return false;
  if (graphemes(label) > limit) return false;
  return (
    label.toLocaleLowerCase(input.locale) !==
    input.negativeLabel.trim().toLocaleLowerCase(input.locale)
  );
}

async function inBatches<T>(
  refs: readonly HomeUrgencyItemRef[],
  read: (items: readonly HomeUrgencyItemRef[]) => Promise<readonly T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < refs.length; start += HOME_URGENCY_ITEMS_PER_READ)
    rows.push(...(await read(refs.slice(start, start + HOME_URGENCY_ITEMS_PER_READ))));
  return rows;
}

export interface HomeUrgencyPromptItem {
  readonly candidate: HomeUrgencyCandidate;
  readonly disclosed: boolean;
}

function shown(item: HomeUrgencyPromptItem): { readonly [key: string]: HomeUrgencyFact } {
  return {
    kind: item.candidate.kind,
    deadline: item.candidate.deadline,
    ...(item.disclosed ? { facts: maskFact(item.candidate.facts) } : {}),
  };
}

export function homeUrgencyPrompt(input: {
  readonly reference: readonly (HomeUrgencyPromptItem & { readonly score: number })[];
  readonly fresh: readonly HomeUrgencyPromptItem[];
  readonly now: string;
  readonly timeZone: string;
  readonly locale: string;
  readonly affirmMax: number | null;
}): string {
  return [
    HOME_URGENCY.text,
    "参照：",
    JSON.stringify(input.reference.map((item) => ({ score: item.score, ...shown(item) }))),
    "新条目：",
    JSON.stringify(
      input.fresh.map((item, index) => ({
        n: index + 1,
        ...shown(item),
        ...(item.disclosed && item.candidate.approvalRequestId !== undefined ? { copy: true } : {}),
      })),
    ),
    JSON.stringify({
      now: input.now,
      timeZone: input.timeZone,
      language: input.locale,
      affirmMax: input.affirmMax,
    }),
  ].join("\n");
}

function line(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > max || UNSAFE_LINE_CHARACTERS.test(text)) return null;
  return text;
}

export function parseHomeUrgency(
  output: string,
  count: number,
): ReadonlyMap<number, HomeUrgencyReplyItem> {
  const replies = new Map<number, HomeUrgencyReplyItem>();
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return replies;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return replies;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return replies;
  const items = (parsed as Record<string, unknown>)["items"];
  if (!Array.isArray(items)) return replies;
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const n = entry["n"];
    const score = entry["score"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > count) continue;
    if (replies.has(n)) continue;
    if (
      typeof score !== "number" ||
      !Number.isInteger(score) ||
      score < 0 ||
      score > HOME_URGENCY_SCORE_MAX
    )
      continue;
    replies.set(n, {
      score,
      sentence: line(entry["sentence"], HOME_URGENCY_SENTENCE_STORE_MAX),
      affirm: line(entry["affirm"], HOME_URGENCY_LABEL_STORE_MAX),
    });
  }
  return replies;
}

const FAILURE_CODE =
  /^(MODEL|URGENCY|PORT|SQLITE|PROACTIVE)_[A-Z0-9_]{1,80}(:[A-Z0-9_.-]{1,40})?$/u;

function failureCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  const message = error instanceof Error ? error.message : "";
  if (typeof code === "string" && FAILURE_CODE.test(code)) return code;
  return FAILURE_CODE.test(message) ? message : "unknown";
}

interface Keyed {
  readonly candidate: HomeUrgencyCandidate;
  readonly ref: HomeUrgencyItemRef;
}

function refKey(ref: HomeUrgencyItemRef): string {
  return `${ref.itemKey}\u0000${ref.textDigest}`;
}

export class HomeUrgencyService {
  readonly #options: HomeUrgencyOptions;
  readonly #storeFailedAt = new Map<string, number>();
  #running: Promise<HomeUrgencyRunResult> | undefined;

  constructor(options: HomeUrgencyOptions) {
    this.#options = options;
  }

  get promptId(): string {
    return homeUrgencyPromptId(this.#options.digest);
  }

  ref(candidate: Pick<HomeUrgencyCandidate, "key" | "digestBasis">): HomeUrgencyItemRef {
    return { itemKey: candidate.key, textDigest: this.#options.digest(candidate.digestBasis) };
  }

  async scores(
    candidates: readonly Pick<HomeUrgencyCandidate, "key" | "digestBasis">[],
  ): Promise<ReadonlyMap<string, number>> {
    const refs = candidates.map((candidate) => this.ref(candidate));
    const rows = await inBatches(refs, (items) =>
      this.#options.store.listScores({ ...this.#options.scope, items }),
    );
    return new Map(rows.map((row) => [row.itemKey, row.score]));
  }

  async approvalCopy(input: {
    readonly itemKey: string;
    readonly approvalRequestId: string;
    readonly semanticSnapshotHash: string;
    readonly locale: string;
    readonly negativeLabel: string;
  }): Promise<HomeApprovalCopy> {
    const { scope, store, seal, settings } = this.#options;
    const [row] = await store.listScores({
      ...scope,
      items: [this.ref({ key: input.itemKey, digestBasis: input.semanticSnapshotHash })],
    });
    if (
      row === undefined ||
      row.approvalRequestId !== input.approvalRequestId ||
      row.copyLocale !== input.locale
    )
      return { sentence: null, affirmLabel: null };
    const sentence =
      row.sentenceRef === null
        ? undefined
        : await seal.open({ ...scope, ref: row.sentenceRef }).catch(() => undefined);
    return {
      sentence: line(sentence, HOME_URGENCY_SENTENCE_STORE_MAX),
      affirmLabel: acceptsHomeAffirmLabel({
        label: row.affirmLabel,
        locale: input.locale,
        limits: settings.affirmLabelMax,
        negativeLabel: input.negativeLabel,
      })
        ? row.affirmLabel
        : null,
    };
  }

  async settled(): Promise<void> {
    await this.#running?.catch(() => undefined);
  }

  run(): Promise<HomeUrgencyRunResult> {
    this.#running ??= this.#run().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #run(): Promise<HomeUrgencyRunResult> {
    const { scope, store, settings, clock } = this.#options;
    const none = { attempted: 0, recorded: 0, failures: [] };
    if (!settings.enabled) return { ...none, stoppedBy: "disabled" };
    const now = clock.now();
    const nowMs = Date.parse(now);
    const backoffMs = settings.retryAfterHours * HOUR_MS;
    for (const [key, at] of this.#storeFailedAt)
      if (nowMs - at >= backoffMs) this.#storeFailedAt.delete(key);
    const seen = new Set<string>();
    const open: Keyed[] = [];
    for (const candidate of await this.#options.candidates()) {
      if (candidate.dataClassification === "restricted" || seen.has(candidate.key)) continue;
      seen.add(candidate.key);
      open.push({ candidate, ref: this.ref(candidate) });
    }
    open.sort((left, right) => compare(left.candidate.key, right.candidate.key));
    const refs = open.map(({ ref }) => ref);
    const scored = new Map(
      (await inBatches(refs, (items) => store.listScores({ ...scope, items }))).map((row) => [
        refKey(row),
        row.score,
      ]),
    );
    const since = new Date(nowMs - backoffMs).toISOString();
    const failedRecently = new Set(
      (await inBatches(refs, (items) => store.listRecentFailures({ ...scope, items, since }))).map(
        refKey,
      ),
    );
    const fresh = open
      .filter(
        ({ ref }) =>
          !scored.has(refKey(ref)) &&
          !failedRecently.has(refKey(ref)) &&
          !this.#storeFailedAt.has(refKey(ref)),
      )
      .slice(0, settings.perCall);
    if (fresh.length === 0) return { ...none, stoppedBy: "nothing_new" };
    const spent = await store.countSince({
      ...scope,
      since: startOfZonedDay(now, this.#options.timeZone),
    });
    if (spent.calls >= settings.dailyLimit) return { ...none, stoppedBy: "daily_limit" };
    const disclose = ({ candidate }: Keyed): HomeUrgencyPromptItem => ({
      candidate,
      disclosed: this.#options.modelAllows(candidate.dataClassification),
    });
    const reference = open
      .filter(({ ref }) => scored.has(refKey(ref)))
      .slice(0, settings.referenceLimit)
      .map((item) => ({ ...disclose(item), score: scored.get(refKey(item.ref)) as number }));
    const items = fresh.map(disclose);
    const locale = await this.#options.locale();
    const prompt = homeUrgencyPrompt({
      reference,
      fresh: items,
      now,
      timeZone: this.#options.timeZone,
      locale,
      affirmMax: homeAffirmLabelMax(settings.affirmLabelMax, locale) ?? null,
    });
    if (spent.costMicros + this.#options.estimateCostMicros(prompt) > settings.dailyCostMicros)
      return { ...none, stoppedBy: "daily_cost" };
    const dataClassification = [...reference, ...items]
      .filter(({ disclosed }) => disclosed)
      .reduce<DataClassification>(
        (highest, { candidate }) =>
          CLASSIFICATION_ORDER.indexOf(candidate.dataClassification) >
          CLASSIFICATION_ORDER.indexOf(highest)
            ? candidate.dataClassification
            : highest,
        "private",
      );
    const startedAt = Date.parse(clock.now());
    const invocationId = `home-urgency:${this.#options
      .digest(fresh.map(({ ref }) => refKey(ref)).join("\n"))
      .slice(0, 16)}:${startedAt}`;
    const result = await this.#invoke(invocationId, startedAt, prompt, dataClassification).catch(
      (error: unknown) => ({
        output: undefined,
        failure: `URGENCY_FAILED:${failureCode(error)}`,
        costMicros: 0,
        durationMs: Math.max(0, Date.parse(clock.now()) - startedAt),
      }),
    );
    const replies =
      result.output === undefined
        ? new Map<number, HomeUrgencyReplyItem>()
        : parseHomeUrgency(result.output, fresh.length);
    const createdAt = clock.now();
    const attempt = ({ candidate, ref }: Keyed, index: number): HomeUrgencyAttempt => ({
      ...ref,
      id: `${invocationId}:${index + 1}`,
      invocationId,
      approvalRequestId: candidate.approvalRequestId ?? null,
      modelRef: this.#options.model.modelRef,
      promptId: this.promptId,
      dataClassification: candidate.dataClassification as HomeUrgencyAttempt["dataClassification"],
      costMicros: result.costMicros,
      durationMs: result.durationMs,
      createdAt,
    });
    const records: HomeUrgencyRecord[] = [];
    const failures: HomeUrgencyFailure[] = [];
    const sealed: string[] = [];
    try {
      for (const [index, item] of fresh.entries()) {
        const reply = replies.get(index + 1);
        if (reply === undefined) {
          failures.push({
            ...attempt(item, index),
            failureCode: (result.output === undefined
              ? result.failure
              : "URGENCY_ITEM_INVALID"
            ).slice(0, 128),
          });
          continue;
        }
        const wantsCopy =
          items[index]?.disclosed === true && item.candidate.approvalRequestId !== undefined;
        const sentence = wantsCopy ? reply.sentence : null;
        const affirmLabel = wantsCopy ? reply.affirm : null;
        let sentenceRef: string | null = null;
        if (sentence !== null) {
          sentenceRef = await this.#options.seal.seal({
            ...scope,
            text: sentence,
            at: createdAt,
            dataClassification: item.candidate.dataClassification,
          });
          sealed.push(sentenceRef);
        }
        records.push({
          ...attempt(item, index),
          score: reply.score,
          sentenceRef,
          affirmLabel,
          copyLocale: sentenceRef !== null || affirmLabel !== null ? locale : null,
        });
      }
      await store.recordCall({ ...scope, records, failures });
    } catch (error) {
      await this.#options.seal.release({ ...scope, refs: sealed }).catch(() => undefined);
      for (const { ref } of fresh) this.#storeFailedAt.set(refKey(ref), nowMs);
      return {
        attempted: fresh.length,
        recorded: 0,
        failures: [`URGENCY_STORE_FAILED:${failureCode(error)}`],
        stoppedBy: "done",
      };
    }
    return {
      attempted: fresh.length,
      recorded: records.length,
      failures: failures.map(({ failureCode: code }) => code),
      stoppedBy: "done",
    };
  }

  async #invoke(
    invocationId: string,
    startedAt: number,
    prompt: string,
    dataClassification: DataClassification,
  ): Promise<{
    readonly output: string | undefined;
    readonly failure: string;
    readonly costMicros: number;
    readonly durationMs: number;
  }> {
    const { model, clock, settings } = this.#options;
    const authority = await model.prepare({
      invocationId,
      prompt,
      deadlineAt: new Date(startedAt + settings.requestTimeoutMs).toISOString(),
      dataClassification,
    });
    const outputs: string[] = [];
    let output = "";
    let failure = "MODEL_NOT_COMPLETED";
    let costMicros = 0;
    let completed = false;
    try {
      const request: ModelInvocationRequest = {
        signal: AbortSignal.timeout(settings.requestTimeoutMs),
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
          failure = `MODEL_FAILED:${event.errorCode}`;
          break;
        }
        if (event.type === "model.output") {
          outputs.push(event.payloadRef);
          output += await model.readOutput(event.payloadRef);
          if (new TextEncoder().encode(output).byteLength > MAX_OUTPUT_BYTES) {
            failure = "MODEL_OUTPUT_TOO_LARGE";
            break;
          }
        }
        if (event.type === "model.completed") {
          costMicros = Number.isSafeInteger(event.costMicros) ? Math.max(0, event.costMicros) : 0;
          completed = true;
          break;
        }
      }
    } finally {
      await authority.release().catch(() => undefined);
      await model.release([authority.inputRef, ...outputs]).catch(() => undefined);
    }
    const durationMs = Math.max(0, Date.parse(clock.now()) - startedAt);
    return { output: completed ? output : undefined, failure, costMicros, durationMs };
  }
}
