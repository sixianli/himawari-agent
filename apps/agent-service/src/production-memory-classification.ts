import type { DataClassification, SensitiveMemoryTopic } from "@himawari-agent/application";
import { MEMORY_CATEGORY_NAMES } from "@himawari-agent/gateway-contracts";
import { MEMORY_CLASSIFICATION } from "@himawari-agent/prompt-catalog";
import { containsCredential } from "@himawari-agent/sensitive-capture";
import { judgeWithModel } from "./auxiliary-judgment.js";

export type MemoryClassificationCategory = (typeof MEMORY_CATEGORY_NAMES)[number];

export interface MemoryClassification {
  readonly category: MemoryClassificationCategory;
  readonly classification: "private" | "sensitive";
  readonly topic: SensitiveMemoryTopic | null;
  readonly failed: boolean;
}

export interface MemoryClassificationModel {
  estimateMicros(prompt: string, maxOutputTokens: number): number;
  generate(input: {
    readonly invocationId: string;
    readonly prompt: string;
    readonly maxOutputTokens: number;
    readonly dataClassification: DataClassification;
  }): Promise<{ readonly output: string; readonly costMicros: number }>;
}

export interface MemoryClassifierOptions {
  readonly model: MemoryClassificationModel;
  readonly dailyLimitMicros: number;
  readonly batchCharacters: number;
  readonly outputTokensPerItem: number;
  readonly timeZone: string;
  readonly now: () => string;
  readonly newId: () => string;
  readonly onFailure: (error: unknown) => void;
}

const CATEGORIES: ReadonlySet<string> = new Set(MEMORY_CATEGORY_NAMES);
const OUTPUT_TOKENS_BASE = 200;
export const MEMORY_CLASSIFICATION_BATCH_CHARACTERS = 6000;
export const MEMORY_CLASSIFICATION_OUTPUT_TOKENS_PER_ITEM = 60;

export function memoryClassificationFailureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/u.test(error.message)) return error.message;
  return error instanceof Error ? error.name.slice(0, 64) : "UNKNOWN";
}

export const UNCLASSIFIED: MemoryClassification = Object.freeze({
  category: "other",
  classification: "private",
  topic: null,
  failed: true,
});

export const CREDENTIAL_TEXT: MemoryClassification = Object.freeze({
  category: "other",
  classification: "private",
  topic: null,
  failed: false,
});

export function looksLikeCredential(text: string): boolean {
  return containsCredential(text);
}

export function memoryClassificationPrompt(
  items: readonly { readonly id: string; readonly text: string }[],
): string {
  return [MEMORY_CLASSIFICATION.text, JSON.stringify({ items })].join("\n");
}

function jsonObject(output: string): unknown {
  const trimmed = output
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("MEMORY_CLASSIFICATION_RESPONSE_INVALID");
  return JSON.parse(trimmed.slice(start, end + 1));
}

export function parseMemoryClassifications(
  output: string,
  ids: readonly string[],
): ReadonlyMap<string, MemoryClassification> {
  const parsed = jsonObject(output);
  const entries =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(entries)) throw new Error("MEMORY_CLASSIFICATION_RESPONSE_INVALID");
  const wanted = new Set(ids);
  const results = new Map<string, MemoryClassification>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as Record<string, unknown>;
    const id = value["id"];
    if (typeof id !== "string" || !wanted.has(id) || results.has(id)) continue;
    const category = (
      typeof value["category"] === "string" && CATEGORIES.has(value["category"])
        ? value["category"]
        : "other"
    ) as MemoryClassificationCategory;
    results.set(id, { category, classification: "private", topic: null, failed: false });
  }
  return results;
}

export class ProductionMemoryClassifier {
  readonly #options: MemoryClassifierOptions;
  #day = "";
  #spentMicros = 0;

  constructor(options: MemoryClassifierOptions) {
    this.#options = options;
  }

  #today(): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.#options.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(this.#options.now()));
  }

  #reserve(estimateMicros: number): boolean {
    const today = this.#today();
    if (today !== this.#day) {
      this.#day = today;
      this.#spentMicros = 0;
    }
    if (this.#spentMicros + estimateMicros > this.#options.dailyLimitMicros) return false;
    this.#spentMicros += estimateMicros;
    return true;
  }

  #settle(estimateMicros: number, costMicros: number) {
    if (this.#day === this.#today())
      this.#spentMicros = Math.max(0, this.#spentMicros - estimateMicros + costMicros);
  }

  #batches(
    items: readonly { readonly id: string; readonly text: string }[],
  ): (readonly { readonly id: string; readonly text: string }[])[] {
    const batches: { readonly id: string; readonly text: string }[][] = [];
    let current: { readonly id: string; readonly text: string }[] = [];
    let size = 0;
    for (const item of items) {
      const length = [...item.text].length;
      if (current.length > 0 && size + length > this.#options.batchCharacters) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(item);
      size += length;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  async #ask(
    batch: readonly { readonly id: string; readonly text: string }[],
    invocationId: string,
    attempt: number,
  ): Promise<string> {
    const prompt = memoryClassificationPrompt(batch);
    const maxOutputTokens = OUTPUT_TOKENS_BASE + batch.length * this.#options.outputTokensPerItem;
    const estimate = this.#options.model.estimateMicros(prompt, maxOutputTokens);
    if (!this.#reserve(estimate)) throw new Error("MEMORY_CLASSIFICATION_DAILY_LIMIT");
    let cost = estimate;
    try {
      const result = await this.#options.model.generate({
        invocationId: `${invocationId}:${attempt}`,
        prompt,
        maxOutputTokens,
        dataClassification: "private",
      });
      cost = result.costMicros;
      return result.output;
    } finally {
      this.#settle(estimate, cost);
    }
  }

  async classify(texts: readonly string[]): Promise<readonly MemoryClassification[]> {
    const results: MemoryClassification[] = texts.map(() => UNCLASSIFIED);
    const pending: { readonly id: string; readonly text: string }[] = [];
    for (const [index, text] of texts.entries()) {
      if (looksLikeCredential(text)) results[index] = CREDENTIAL_TEXT;
      else pending.push({ id: String(index), text });
    }
    const invocation = this.#options.newId();
    for (const [batchIndex, batch] of this.#batches(pending).entries()) {
      const ids = batch.map(({ id }) => id);
      try {
        const verdicts = await judgeWithModel({
          ask: (attempt) => this.#ask(batch, `${invocation}:${batchIndex}`, attempt),
          parse: (output) => parseMemoryClassifications(output, ids),
        });
        for (const id of ids) {
          const verdict = verdicts.get(id);
          if (verdict) results[Number(id)] = verdict;
        }
      } catch (error) {
        this.#options.onFailure(error);
      }
    }
    return results;
  }
}
