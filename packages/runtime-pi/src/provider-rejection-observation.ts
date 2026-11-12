import type { FetchFunction } from "@earendil-works/pi-ai";

export interface ProviderRejection {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly shouldRetry: string | null;
  readonly host: string | null;
}

const hostOf = (input: unknown): string | null => {
  try {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
    return href === undefined ? null : new URL(href).host;
  } catch {
    return null;
  }
};

export function observeProviderRejections(
  fetch: FetchFunction,
  onRejected: ((rejection: ProviderRejection) => void) | undefined,
): FetchFunction {
  if (onRejected === undefined) return fetch;
  return async (input, init) => {
    const response = await fetch(input, init);
    if (!response.ok) {
      try {
        onRejected({
          status: response.status,
          retryAfter: response.headers.get("retry-after-ms")
            ? `${response.headers.get("retry-after-ms")}ms`
            : response.headers.get("retry-after"),
          shouldRetry: response.headers.get("x-should-retry"),
          host: hostOf(input),
        });
      } catch {}
    }
    return response;
  };
}
