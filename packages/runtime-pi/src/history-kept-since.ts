function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summary(message: unknown): boolean {
  return (
    record(message) &&
    (message["role"] === "compactionSummary" || message["role"] === "branchSummary")
  );
}

function instant(message: unknown): string | undefined {
  if (!record(message)) return undefined;
  const timestamp = message["timestamp"];
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

export function historyKeptSince(messages: readonly unknown[]): string | null {
  const last = messages.findLastIndex(summary);
  if (last < 0) return null;
  for (const message of messages.slice(last + 1)) {
    const at = instant(message);
    if (at) return at;
  }
  return instant(messages[last]) ?? null;
}
