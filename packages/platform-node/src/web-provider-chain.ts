import {
  type WebFetchProvider,
  type WebFetchResult,
  type WebProviderFailureCode,
  type WebProviderId,
  WebProviderError,
  type WebSearchCandidate,
  type WebSearchProvider,
} from "@himawari-agent/application";
import { DeepSeekWebProvider } from "./deepseek-web-provider.js";
import { ExaPublicSearchAdapter } from "./exa-public-search.js";

const chainBudgetMs = 45000;
const minimumAttemptMs = 5000;

export interface WebProviderSecrets {
  readonly deepseek?: string;
}

export type WebProvider = WebSearchProvider & WebFetchProvider;

export function createWebProvider(id: WebProviderId, secrets: WebProviderSecrets): WebProvider {
  if (id === "exa-public") return new ExaPublicSearchAdapter();
  if (!secrets.deepseek) throw new WebProviderError("UNAVAILABLE", "WEB_PROVIDER_SECRET_MISSING");
  return new DeepSeekWebProvider({ credential: secrets.deepseek });
}

export function webProviderFailure(error: unknown): WebProviderError {
  if (error instanceof WebProviderError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  const code: WebProviderFailureCode = /RATE_LIMITED$/.test(message)
    ? "RATE_LIMITED"
    : /TIMEOUT$/.test(message) || name === "TimeoutError"
      ? "TIMEOUT"
      : /INPUT_UNSUPPORTED$/.test(message)
        ? "INPUT_UNSUPPORTED"
        : /INPUT_INVALID$|INPUT_LIMIT$/.test(message)
          ? "INPUT_INVALID"
          : /OUTPUT_REDACTED$/.test(message)
            ? "OUTPUT_REDACTED"
            : "UNAVAILABLE";
  return new WebProviderError(code, message || code);
}

export interface WebProviderAttempt {
  readonly provider: WebProviderId;
  readonly code: WebProviderFailureCode;
}

export class WebProviderChainError extends Error {
  readonly attempts: readonly WebProviderAttempt[];
  readonly last: WebProviderError;
  constructor(last: WebProviderError, attempts: readonly WebProviderAttempt[]) {
    super(last.message);
    this.name = "WebProviderChainError";
    this.last = last;
    this.attempts = attempts;
  }
}

export async function runWebProviderChain<T>(input: {
  readonly providers: readonly WebProviderId[];
  readonly create: (id: WebProviderId) => WebProvider;
  readonly attempt: (provider: WebProvider, signal: AbortSignal) => Promise<T>;
  readonly signal?: AbortSignal;
  readonly budgetMs?: number;
  readonly now?: () => number;
}): Promise<{
  readonly provider: WebProviderId;
  readonly result: T;
  readonly attempts: readonly WebProviderAttempt[];
}> {
  if (!input.providers.length)
    throw new WebProviderError("UNAVAILABLE", "WEB_PROVIDER_CHAIN_EMPTY");
  const now = input.now ?? (() => performance.now());
  const deadline = now() + (input.budgetMs ?? chainBudgetMs);
  const attempts: WebProviderAttempt[] = [];
  let last: WebProviderError | undefined;
  for (const id of input.providers) {
    const remaining = deadline - now();
    if (last && remaining < minimumAttemptMs) break;
    input.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(remaining)));
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    try {
      const result = await input.attempt(input.create(id), signal);
      return { provider: id, result, attempts };
    } catch (error) {
      input.signal?.throwIfAborted();
      last = webProviderFailure(error);
      attempts.push({ provider: id, code: last.code });
      if (!last.fallback) break;
    }
  }
  throw new WebProviderChainError(
    last ?? new WebProviderError("UNAVAILABLE", "WEB_PROVIDER_CHAIN_EXHAUSTED"),
    attempts,
  );
}

export function searchWithProviders(input: {
  readonly providers: readonly WebProviderId[];
  readonly secrets: WebProviderSecrets;
  readonly query: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
  readonly create?: (id: WebProviderId) => WebProvider;
}) {
  return runWebProviderChain<readonly WebSearchCandidate[]>({
    providers: input.providers,
    create: input.create ?? ((id) => createWebProvider(id, input.secrets)),
    attempt: (provider, signal) =>
      provider.search({ query: input.query, limit: input.limit, signal }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export function fetchWithProviders(input: {
  readonly providers: readonly WebProviderId[];
  readonly secrets: WebProviderSecrets;
  readonly url: string;
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
  readonly create?: (id: WebProviderId) => WebProvider;
}) {
  return runWebProviderChain<WebFetchResult>({
    providers: input.providers,
    create: input.create ?? ((id) => createWebProvider(id, input.secrets)),
    attempt: (provider, signal) =>
      provider.fetch({ url: input.url, maximumBytes: input.maximumBytes, signal }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
