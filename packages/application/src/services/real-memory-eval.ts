import {
  type CalibrationDecisionRow,
  type CalibrationGroup,
  type Proportion,
  proportion,
  summarizeDecisions,
} from "@himawari-agent/calibration";
import {
  REAL_EVAL_ANSWER,
  REAL_EVAL_JUDGE,
  REAL_EVAL_LEAK_JUDGE,
  REAL_EVAL_QUESTION,
} from "@himawari-agent/prompt-catalog";
import { placeholderTable } from "@himawari-agent/sensitive-capture";
import type { ProductMemoryRecord } from "../ports/memory-projection.js";
import type { RealEvalItemKind, RealEvalRetireReason } from "../ports/real-eval.js";
import { isModelVisible } from "./model-visibility.js";

export const REAL_EVAL_QUESTION_KINDS = ["fact", "preference", "time"] as const;
export type RealEvalQuestionKind = (typeof REAL_EVAL_QUESTION_KINDS)[number];

export const REAL_EVAL_VERDICTS = ["correct", "wrong", "abstained"] as const;
export type RealEvalVerdict = (typeof REAL_EVAL_VERDICTS)[number];

export const QUESTION_MAX_CHARACTERS = 120;
export const QUESTION_MIN_CHARACTERS = 4;
export const LEAK_NGRAM = 6;
export const FAST_PATH_MIN_CHARACTERS = 8;

export function eligibleForQuestions(
  record: ProductMemoryRecord,
  asOf: string,
): RealEvalRetireReason | null {
  if (record.status !== "active") return "memory_inactive";
  if (record.attributes?.tentative === true) return "memory_tentative";
  if (record.attributes?.supersededBy) return "memory_superseded";
  const validTo = record.attributes?.validTo ?? null;
  if (validTo !== null && Date.parse(validTo) <= Date.parse(asOf)) return "memory_expired";
  const validFrom = record.attributes?.validFrom ?? null;
  if (validFrom !== null && Date.parse(validFrom) > Date.parse(asOf)) return "memory_expired";
  if (!isModelVisible(record.dataClassification)) return "memory_not_visible";
  return null;
}

export interface BankedQuestionSource {
  readonly memoryId: string;
  readonly memoryRevision: number;
}

export function retireReason(
  question: BankedQuestionSource,
  current: ProductMemoryRecord | undefined,
  asOf: string,
): RealEvalRetireReason | null {
  if (!current) return "memory_inactive";
  const reason = eligibleForQuestions(current, asOf);
  if (reason) return reason;
  return current.revision === question.memoryRevision ? null : "memory_revised";
}

export function pickNewMemories(
  records: readonly ProductMemoryRecord[],
  banked: ReadonlySet<string>,
  asOf: string,
  limit: number,
): ProductMemoryRecord[] {
  return records
    .filter((record) => !banked.has(record.id) && eligibleForQuestions(record, asOf) === null)
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .slice(0, Math.max(0, limit));
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function ngrams(value: string, size: number): Set<string> {
  const chars = [...normalize(value)];
  const grams = new Set<string>();
  for (let index = 0; index + size <= chars.length; index += 1)
    grams.add(chars.slice(index, index + size).join(""));
  return grams;
}

function numbers(value: string): Set<string> {
  return new Set(value.normalize("NFKC").match(/\d{2,}/gu) ?? []);
}

export function leaksAnswer(question: string, sources: readonly string[]): boolean {
  const asked = ngrams(question, LEAK_NGRAM);
  const askedNumbers = numbers(question);
  return sources.some((source) => {
    for (const gram of ngrams(source, LEAK_NGRAM)) if (asked.has(gram)) return true;
    for (const value of numbers(source)) if (askedNumbers.has(value)) return true;
    return false;
  });
}

export function leakJudgePrompt(input: {
  readonly question: string;
  readonly memory: string;
  readonly quote: string;
}): string {
  return [
    REAL_EVAL_LEAK_JUDGE.text,
    JSON.stringify({ question: input.question, memory: input.memory, quote: input.quote }),
  ].join("\n");
}

export function parseLeakVerdict(output: string): boolean | null {
  const parsed = jsonObject(output);
  const leaks = parsed?.["leaks"];
  return typeof leaks === "boolean" ? leaks : null;
}

export function hasSensitiveValue(value: string): boolean {
  return placeholderTable(value, (kind) => `#${kind}#`).size > 0;
}

export function questionPrompt(input: { readonly memory: string; readonly quote: string }): string {
  return [
    REAL_EVAL_QUESTION.text,
    JSON.stringify({ memory: input.memory, quote: input.quote }),
  ].join("\n");
}

export interface GeneratedQuestion {
  readonly question: string;
  readonly kind: RealEvalQuestionKind;
  readonly abstainQuestion: string | null;
}

export type QuestionRejection =
  | "response_invalid"
  | "declined"
  | "question_invalid"
  | "kind_invalid"
  | "leak"
  | "sensitive";

function jsonObject(output: string): Record<string, unknown> | null {
  const trimmed = output
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function questionText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < QUESTION_MIN_CHARACTERS || length > QUESTION_MAX_CHARACTERS) return null;
  if (/[\r\n{}<>`]/u.test(trimmed)) return null;
  return trimmed;
}

export function parseGeneratedQuestion(
  output: string,
  sources: { readonly memory: string; readonly quote: string },
): GeneratedQuestion | { readonly rejected: QuestionRejection } {
  const parsed = jsonObject(output);
  if (!parsed) return { rejected: "response_invalid" };
  if (parsed["question"] === null) return { rejected: "declined" };
  const question = questionText(parsed["question"]);
  if (question === null) return { rejected: "question_invalid" };
  const kind = parsed["kind"];
  if (typeof kind !== "string" || !(REAL_EVAL_QUESTION_KINDS as readonly string[]).includes(kind))
    return { rejected: "kind_invalid" };
  const texts = [sources.memory, sources.quote];
  if (leaksAnswer(question, texts)) return { rejected: "leak" };
  if (hasSensitiveValue(question)) return { rejected: "sensitive" };
  const abstain = questionText(parsed["abstainQuestion"]);
  const abstainQuestion =
    abstain !== null &&
    abstain !== question &&
    !leaksAnswer(abstain, texts) &&
    !hasSensitiveValue(abstain)
      ? abstain
      : null;
  return { question, kind: kind as RealEvalQuestionKind, abstainQuestion };
}

export function answerPrompt(input: {
  readonly profile: readonly string[];
  readonly memories: readonly string[];
  readonly question: string;
  readonly now: string;
}): string {
  return [
    REAL_EVAL_ANSWER.text,
    JSON.stringify({
      profile: input.profile,
      memories: input.memories,
      question: input.question,
      now: input.now,
    }),
  ].join("\n");
}

export function judgePrompt(input: {
  readonly question: string;
  readonly quote: string;
  readonly memory: string;
  readonly response: string;
  readonly abstain: boolean;
}): string {
  return [
    REAL_EVAL_JUDGE.text,
    JSON.stringify({
      question: input.question,
      reference: { quote: input.quote, memory: input.memory },
      response: input.response,
      abstain: input.abstain,
    }),
  ].join("\n");
}

export function parseJudgeVerdict(output: string): RealEvalVerdict | null {
  const verdict = jsonObject(output)?.["verdict"];
  return typeof verdict === "string" && (REAL_EVAL_VERDICTS as readonly string[]).includes(verdict)
    ? (verdict as RealEvalVerdict)
    : null;
}

export function fastPathVerdict(input: {
  readonly response: string;
  readonly quote: string;
  readonly abstain: boolean;
}): RealEvalVerdict | null {
  if (input.abstain) return null;
  const quote = normalize(input.quote);
  if ([...quote].length < FAST_PATH_MIN_CHARACTERS) return null;
  return normalize(input.response).includes(quote) ? "correct" : null;
}

export interface ScoredItem {
  readonly panel: "fixed" | "fresh";
  readonly kind: RealEvalItemKind;
  readonly verdict: RealEvalVerdict;
  readonly retrievedReference: boolean | null;
}

export interface RealEvalScores {
  readonly fixed: Proportion;
  readonly fresh: Proportion;
  readonly abstain: Proportion;
  readonly retrieval: Proportion;
}

export function scoreItems(items: readonly ScoredItem[]): RealEvalScores {
  const share = (selected: readonly ScoredItem[]) =>
    proportion(selected.filter(({ verdict }) => verdict === "correct").length, selected.length);
  const recall = items.filter(({ kind }) => kind !== "abstain");
  const retrieved = recall.filter(({ retrievedReference }) => retrievedReference !== null);
  return {
    fixed: share(recall.filter(({ panel }) => panel === "fixed")),
    fresh: share(recall.filter(({ panel }) => panel === "fresh")),
    abstain: share(items.filter(({ kind }) => kind === "abstain")),
    retrieval: proportion(
      retrieved.filter(({ retrievedReference }) => retrievedReference === true).length,
      retrieved.length,
    ),
  };
}

export class RealEvalBudgetExceededError extends Error {
  readonly code = "REAL_EVAL_BUDGET_EXCEEDED" as const;
  constructor() {
    super("Real memory evaluation reached its spending cap");
    this.name = "RealEvalBudgetExceededError";
  }
}

export class RealEvalBudget {
  readonly #limitMicros: number;
  #spentMicros = 0;

  constructor(limitMicros: number) {
    if (!Number.isSafeInteger(limitMicros) || limitMicros <= 0)
      throw new Error("REAL_EVAL_BUDGET_INVALID");
    this.#limitMicros = limitMicros;
  }

  get spentMicros(): number {
    return this.#spentMicros;
  }

  reserve(estimateMicros: number): void {
    if (this.#spentMicros + Math.max(0, estimateMicros) > this.#limitMicros)
      throw new RealEvalBudgetExceededError();
  }

  absorb(micros: number): void {
    this.#spentMicros += Math.max(0, micros);
  }

  ensureRemaining(): void {
    if (this.#spentMicros >= this.#limitMicros) throw new RealEvalBudgetExceededError();
  }

  record(actualMicros: number): void {
    this.#spentMicros += Math.max(0, actualMicros);
    if (this.#spentMicros > this.#limitMicros) throw new RealEvalBudgetExceededError();
  }
}

export const DECISION_EVAL_GROUPS = [
  "proactive_pushed",
  "proactive_silent",
  "memory_kept",
  "memory_skipped",
  "consolidation",
] as const satisfies readonly CalibrationGroup[];

export interface DecisionEvalGroup {
  readonly group: (typeof DECISION_EVAL_GROUPS)[number];
  readonly total: number;
  readonly rated: number;
  readonly correct: number;
  readonly accuracy: Proportion;
}

export function summarizeDecisionEval(
  rows: readonly CalibrationDecisionRow[],
): readonly DecisionEvalGroup[] {
  const summaries = new Map(summarizeDecisions(rows).map((summary) => [summary.group, summary]));
  return DECISION_EVAL_GROUPS.map((group) => {
    const summary = summaries.get(group);
    const rated = summary?.rated ?? 0;
    const correct = summary?.useful ?? 0;
    return {
      group,
      total: summary?.total ?? 0,
      rated,
      correct,
      accuracy: proportion(correct, rated),
    };
  });
}
