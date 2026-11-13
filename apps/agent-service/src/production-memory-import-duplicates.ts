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
  | "dailyMaximumRequests"
  | "requestTimeoutMs"
>;

export interface ImportDuplicateExistingScan {
  readonly complete: boolean;
}

const MAXIMUM_CANDIDATE_CHARACTERS = 2000;

export function importDuplicateFailureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/u.test(error.message)) return error.message;
  return error instanceof Error ? error.name.slice(0, 64) : "UNKNOWN";
}

export class ProductionImportDuplicateChecker {
  readonly #decision: ImportDuplicateDecisionPort;
  readonly #settings: ImportDuplicateSettings;
  readonly #onFailure: (error: unknown) => void;
  readonly #now: () => string;
  #day = "";
  #requestsToday = 0;

  get existingLimit(): number {
    return this.#settings.maximumExistingMemories;
  }

  constructor(options: {
    readonly now?: () => string;
    readonly decision: ImportDuplicateDecisionPort;
    readonly settings: ImportDuplicateSettings;
    readonly onFailure: (error: unknown) => void;
  }) {
    this.#decision = options.decision;
    this.#settings = options.settings;
    this.#onFailure = options.onFailure;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  #reserve(requests: number): number {
    const today = this.#now().slice(0, 10);
    if (today !== this.#day) {
      this.#day = today;
      this.#requestsToday = 0;
    }
    const granted = Math.max(
      0,
      Math.min(requests, this.#settings.dailyMaximumRequests - this.#requestsToday),
    );
    this.#requestsToday += granted;
    if (granted < requests) this.#onFailure(new Error("IMPORT_DUPLICATE_DAILY_LIMIT"));
    return granted;
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
    scan: ImportDuplicateExistingScan = { complete: true },
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
      if (existing.length === 0 && scan.complete)
        for (const index of asked) results[index] = { verdict: "different", memoryId: null };
      return results;
    }
    const memoryIdOf = new Map(known.map(({ key, memoryId }) => [key, memoryId] as const));
    const chunks = this.#chunks(known.map(({ key, text }) => ({ key, text })));
    const groups: number[][] = [];
    for (let start = 0; start < asked.length; start += this.#settings.candidatesPerRequest)
      groups.push(asked.slice(start, start + this.#settings.candidatesPerRequest));
    const jobs = chunks.flatMap((chunk) => groups.map((group) => ({ group, chunk })));
    const best = new Map<number, ImportDuplicateAnswer>();
    const incomplete = new Set<number>();
    const run = async (job: (typeof jobs)[number]) => {
      try {
        const answers = await this.#decision.decide({
          existing: job.chunk,
          candidates: job.group.map((index) => ({
            text: [...(candidates[index] ?? "")].slice(0, MAXIMUM_CANDIDATE_CHARACTERS).join(""),
          })),
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
    const granted = this.#reserve(Math.min(jobs.length, this.#settings.maximumRequests));
    const allowed = jobs.slice(0, granted);
    for (const job of jobs.slice(granted)) for (const index of job.group) incomplete.add(index);
    const first = allowed[0];
    if (first) await run(first);
    const rest = allowed.slice(1);
    for (let start = 0; start < rest.length; start += CONCURRENT_REQUESTS)
      await Promise.all(rest.slice(start, start + CONCURRENT_REQUESTS).map(run));
    for (const index of asked) {
      const answer = best.get(index);
      const verdict = importDuplicateVerdict(answer, this.#settings);
      if (verdict === "same" || verdict === "unsure")
        results[index] = {
          verdict,
          memoryId: answer?.matchKey ? (memoryIdOf.get(answer.matchKey) ?? null) : null,
        };
      else if (verdict === "different" && !incomplete.has(index) && scan.complete)
        results[index] = { verdict: "different", memoryId: null };
    }
    return results;
  }
}

export function productionImportDuplicateChecker(
  configuration: ProductConfiguration,
  secretSource: HostProviderSecretSource,
  onFailure: (error: unknown) => void,
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly baseUrl?: string;
    readonly now?: () => string;
  } = {},
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
    now: options.now ?? (() => new Date().toISOString()),
  });
}
