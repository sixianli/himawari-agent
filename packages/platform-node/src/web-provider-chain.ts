import {
  type WebFetchProvider,
  type WebFetchResult,
  WebProviderError,
  type WebProviderFailureCode,
  type WebProviderId,
  type WebSearchCandidate,
  type WebSearchProvider,
} from "@himawari-agent/application";
import { DeepSeekWebProvider } from "./deepseek-web-provider.js";
import { ExaPublicSearchAdapter, type WebProviderDispatcher } from "./exa-public-search.js";
import { webProviderFailure } from "./web-provider-failure.js";

const chainBudgetMs = 45000;
const minimumAttemptMs = 5000;

export interface WebProviderSecrets {
  readonly deepseek?: string;
}

export type WebProvider = WebSearchProvider & WebFetchProvider;

export function createWebProvider(
  id: WebProviderId,
  secrets: WebProviderSecrets,
  dispatcher: WebProviderDispatcher,
): WebProvider {
  if (id === "exa-public") return new ExaPublicSearchAdapter({ dispatcher });
  if (!secrets.deepseek) throw new WebProviderError("UNAVAILABLE", "WEB_PROVIDER_SECRET_MISSING");
  return new DeepSeekWebProvider({ credential: secrets.deepseek, dispatcher });
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
  readonly query: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
  readonly create: (id: WebProviderId) => WebProvider;
}) {
  return runWebProviderChain<readonly WebSearchCandidate[]>({
    providers: input.providers,
    create: input.create,
    attempt: (provider, signal) =>
      provider.search({ query: input.query, limit: input.limit, signal }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export function fetchWithProviders(input: {
  readonly providers: readonly WebProviderId[];
  readonly url: string;
  readonly offset: number;
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
  readonly create: (id: WebProviderId) => WebProvider;
}) {
  return runWebProviderChain<WebFetchResult>({
    providers: input.providers,
    create: input.create,
    attempt: (provider, signal) =>
      provider.fetch({
        url: input.url,
        offset: input.offset,
        maximumBytes: input.maximumBytes,
        signal,
      }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
