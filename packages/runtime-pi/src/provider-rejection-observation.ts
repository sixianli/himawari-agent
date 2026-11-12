import type { FetchFunction } from "@earendil-works/pi-ai";

export interface ProviderRejection {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly shouldRetry: string | null;
  readonly host: string | null;
}

const HEADER_LIMIT = 128;

const headerText = (value: string | null): string | null =>
  value === null ? null : value.slice(0, HEADER_LIMIT);

const hostOf = (input: unknown): string | null => {
  try {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : typeof (input as { url?: unknown } | null)?.url === "string"
            ? (input as { url: string }).url
            : undefined;
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
          retryAfter: headerText(
            response.headers.get("retry-after-ms")
              ? `${response.headers.get("retry-after-ms")}ms`
              : response.headers.get("retry-after"),
          ),
          shouldRetry: headerText(response.headers.get("x-should-retry")),
          host: hostOf(input),
        });
      } catch {}
    }
    return response;
  };
}
