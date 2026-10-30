import type { FetchFunction } from "@earendil-works/pi-ai";

export interface CacheFieldObservation {
  readonly fetch: FetchFunction;
  readonly reported: () => Promise<boolean>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function usageReportsCache(usage: unknown): boolean {
  const fields = record(usage);
  if (fields === undefined) return false;
  return (
    count(record(fields["prompt_tokens_details"])?.["cached_tokens"]) ||
    count(fields["prompt_cache_hit_tokens"]) ||
    count(fields["cache_read_input_tokens"])
  );
}

function frameReportsCache(data: Record<string, unknown>): boolean {
  if (usageReportsCache(data["usage"])) return true;
  const choices = data["choices"];
  return (
    Array.isArray(choices) && choices.some((choice) => usageReportsCache(record(choice)?.["usage"]))
  );
}

async function responseReportsCache(response: Response): Promise<boolean> {
  if (response.body === null) return false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reported = false;
  const observeLine = (line: string): void => {
    if (reported || !line.startsWith("data:") || !line.includes("usage")) return;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") return;
    try {
      const data = record(JSON.parse(payload));
      if (data !== undefined && frameReportsCache(data)) reported = true;
    } catch {
      return;
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) observeLine(line);
      if (chunk.done) break;
    }
    if (buffer.length > 0) observeLine(buffer);
    return reported;
  } finally {
    reader.releaseLock();
  }
}

export function observeCacheFields(fetch: FetchFunction): CacheFieldObservation {
  const observations: Promise<boolean>[] = [];
  return {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (response.ok && response.body !== null)
        observations.push(responseReportsCache(response.clone()).catch(() => false));
      return response;
    },
    reported: async () => (await Promise.all(observations)).some(Boolean),
  };
}
