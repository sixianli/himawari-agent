const transientCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

/** Classification only: callers must prove read-only semantics, cap attempts,
 * retain the original deadline and recheck authority before another send. */
export function readonlyNetworkRetryDelay(
  response: Pick<Response, "status" | "headers"> | undefined,
  error?: unknown,
): number | null {
  if (response) {
    if (![408, 429, 502, 503, 504].includes(response.status)) return null;
    const header = response.headers.get("retry-after");
    if (header !== null) {
      const milliseconds = /^\d+$/.test(header)
        ? Number(header) * 1000
        : Date.parse(header) - Date.now();
      // An invalid server delay must not silently become an aggressive retry.
      if (!Number.isFinite(milliseconds)) return null;
      return Math.max(250, milliseconds);
    }
    return 250;
  }
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if ("code" in current && typeof current.code === "string" && transientCodes.has(current.code))
      return 250;
    current = current.cause;
  }
  return null;
}
