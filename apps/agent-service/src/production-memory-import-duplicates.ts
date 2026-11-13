import type { ProductConfiguration } from "@himawari-agent/application";
import {
  type ImportDuplicateAnswer,
  type ImportDuplicateConfiguration,
  type ImportDuplicateDecisionPort,
  type ImportDuplicateVerdict,
  importDuplicateVerdict,
} from "@himawari-agent/application";
import {
  type HostProviderSecretSource,
  MemoryImportDuplicateDecision,
} from "@himawari-agent/platform-node";
import { deterministicallySensitive } from "./production-memory-classification.js";
import { resolveConfiguredSecretRequirement } from "./production-model-composition.js";

export interface ImportDuplicateExisting {
  readonly memoryId: string;
  readonly text: string;
}

export interface ImportDuplicateResult {
  readonly verdict: ImportDuplicateVerdict;
  readonly memoryId: string | null;
}

const SKIPPED: ImportDuplicateResult = Object.freeze({ verdict: "skipped", memoryId: null });
const CONCURRENT_REQUESTS = 4;

export type ImportDuplicateSettings = Pick<
  ImportDuplicateConfiguration,
  | "yesAtLeastPermille"
  | "noAtMostPermille"
  | "existingPerRequest"
  | "existingCharactersPerRequest"
  | "candidatesPerRequest"
  | "maximumExistingMemories"
  | "maximumRequests"
  | "requestTimeoutMs"
>;

export function importDuplicateFailureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/u.test(error.message)) return error.message;
  return error instanceof Error ? error.name.slice(0, 64) : "UNKNOWN";
}

export class ProductionImportDuplicateChecker {
  readonly #decision: ImportDuplicateDecisionPort;
  readonly #settings: ImportDuplicateSettings;
  readonly #onFailure: (error: unknown) => void;

  constructor(options: {
    readonly decision: ImportDuplicateDecisionPort;
    readonly settings: ImportDuplicateSettings;
    readonly onFailure: (error: unknown) => void;
  }) {
    this.#decision = options.decision;
    this.#settings = options.settings;
    this.#onFailure = options.onFailure;
  }

  #chunks(existing: readonly { readonly key: string; readonly text: string }[]) {
    const chunks: { readonly key: string; readonly text: string }[][] = [];
    let current: { readonly key: string; readonly text: string }[] = [];
    let size = 0;
    for (const item of existing) {
      const length = [...item.text].length;
      if (
        current.length > 0 &&
        (current.length >= this.#settings.existingPerRequest ||
          size + length > this.#settings.existingCharactersPerRequest)
      ) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(item);
      size += length;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  async check(
    candidates: readonly string[],
    existing: readonly ImportDuplicateExisting[],
  ): Promise<readonly ImportDuplicateResult[]> {
    const results: ImportDuplicateResult[] = candidates.map(() => SKIPPED);
    const asked: number[] = [];
    for (const [index, text] of candidates.entries())
      if (!deterministicallySensitive(text)) asked.push(index);
    const known = existing
      .filter(({ text }) => !deterministicallySensitive(text))
      .slice(0, this.#settings.maximumExistingMemories)
      .map(({ memoryId, text }, position) => ({ key: `m${position}`, memoryId, text }));
    if (known.length === 0) {
      for (const index of asked) results[index] = { verdict: "different", memoryId: null };
      return results;
    }
    const memoryIdOf = new Map(known.map(({ key, memoryId }) => [key, memoryId] as const));
    const chunks = this.#chunks(known.map(({ key, text }) => ({ key, text })));
    const groups: number[][] = [];
    for (let start = 0; start < asked.length; start += this.#settings.candidatesPerRequest)
      groups.push(asked.slice(start, start + this.#settings.candidatesPerRequest));
    const jobs = groups.flatMap((group) => chunks.map((chunk) => ({ group, chunk })));
    const best = new Map<number, ImportDuplicateAnswer>();
    const incomplete = new Set<number>();
    const run = async (job: (typeof jobs)[number]) => {
      try {
        const answers = await this.#decision.decide({
          existing: job.chunk,
          candidates: job.group.map((index) => ({ text: candidates[index] ?? "" })),
          signal: AbortSignal.timeout(this.#settings.requestTimeoutMs),
        });
        for (const [position, index] of job.group.entries()) {
          const answer = answers[position];
          if (answer === undefined) {
            incomplete.add(index);
            continue;
          }
          const current = best.get(index);
          if (!current || answer.probabilityPermille > current.probabilityPermille)
            best.set(index, answer);
        }
      } catch (error) {
        for (const index of job.group) incomplete.add(index);
        this.#onFailure(error);
      }
    };
    const allowed = jobs.slice(0, this.#settings.maximumRequests);
    for (const job of jobs.slice(this.#settings.maximumRequests))
      for (const index of job.group) incomplete.add(index);
    for (let start = 0; start < allowed.length; start += CONCURRENT_REQUESTS)
      await Promise.all(allowed.slice(start, start + CONCURRENT_REQUESTS).map(run));
    for (const index of asked) {
      const answer = best.get(index);
      const verdict = importDuplicateVerdict(answer, this.#settings);
      if (verdict === "same" || verdict === "unsure")
        results[index] = {
          verdict,
          memoryId: answer?.matchKey ? (memoryIdOf.get(answer.matchKey) ?? null) : null,
        };
      else if (!incomplete.has(index)) results[index] = { verdict: "different", memoryId: null };
    }
    return results;
  }
}

export function productionImportDuplicateChecker(
  configuration: ProductConfiguration,
  secretSource: HostProviderSecretSource,
  onFailure: (error: unknown) => void,
  options: { readonly fetch?: typeof globalThis.fetch; readonly baseUrl?: string } = {},
): ProductionImportDuplicateChecker | undefined {
  const route = configuration.runPolicy?.importDuplicates;
  if (!route) return undefined;
  const secret = resolveConfiguredSecretRequirement(configuration, route.secretRef);
  if (!secret) throw new Error("IMPORT_DUPLICATE_SECRET_REQUIRED");
  if (!secretSource.productionSuitable)
    throw new TypeError("IMPORT_DUPLICATE_UNSAFE_SECRET_SOURCE");
  let apiKey: Promise<string> | undefined;
  return new ProductionImportDuplicateChecker({
    decision: new MemoryImportDuplicateDecision({
      model: route.model,
      apiKey: () => {
        apiKey ??= secretSource.resolve(secret.secretRef, secret.secretVersion).then(
          (value) => {
            if (value.trim().length === 0) throw new Error("IMPORT_DUPLICATE_SECRET_EMPTY");
            return value;
          },
          (error: unknown) => {
            apiKey = undefined;
            throw error;
          },
        );
        return apiKey;
      },
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    }),
    settings: route,
    onFailure,
  });
}
