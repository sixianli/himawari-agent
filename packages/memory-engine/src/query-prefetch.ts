import type { Embedder } from "./embedding.js";

export interface QueryPrefetchLimits {
  readonly ttlMs: number;
  readonly entriesPerDevice: number;
  readonly bytesPerDevice: number;
}

export const QUERY_PREFETCH_LIMIT_DEFAULTS: QueryPrefetchLimits = Object.freeze({
  ttlMs: 60_000,
  entriesPerDevice: 20,
  bytesPerDevice: 204_800,
});

interface Prepared {
  readonly utteranceId: string;
  readonly text: string;
  readonly query: string;
  readonly vector: Float32Array;
  readonly bytes: number;
  readonly at: number;
}

interface Ready {
  readonly deviceId: string;
  readonly finalText: string;
  readonly query: string;
  readonly vector: Float32Array | null;
  readonly at: number;
}

export interface SpokenQuery {
  readonly query: string;
  readonly vector: Float32Array | null;
}

export type QueryPrefetchOutcome =
  | { readonly used: true; readonly similarity: number }
  | {
      readonly used: false;
      readonly reason: "nothing_prepared" | "expired" | "different_words";
      readonly similarity: number | null;
    };

export function normalizeSpokenText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function spokenQueryText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function textSimilarityPermille(left: string, right: string): number {
  const a = [...normalizeSpokenText(left)];
  const b = [...normalizeSpokenText(right)];
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1000;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1)
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return Math.floor((1000 * (longest - (previous[b.length] as number))) / longest);
}

export class QueryPrefetch {
  readonly #limits: () => QueryPrefetchLimits;
  readonly #now: () => number;
  readonly #prepared = new Map<string, Map<string, Prepared>>();
  readonly #ready: Ready[] = [];

  constructor(options: { readonly limits: () => QueryPrefetchLimits; readonly now: () => number }) {
    this.#limits = options.limits;
    this.#now = options.now;
  }

  async prepare(
    input: { readonly deviceId: string; readonly utteranceId: string; readonly text: string },
    embedQuery: (query: string) => Promise<Float32Array>,
  ): Promise<boolean> {
    const query = spokenQueryText(input.text);
    if (query.length === 0) return false;
    const vector = await embedQuery(query);
    const limits = this.#limits();
    const at = this.#now();
    this.#sweep(at, limits);
    const device = this.#prepared.get(input.deviceId) ?? new Map<string, Prepared>();
    this.#prepared.set(input.deviceId, device);
    device.delete(input.utteranceId);
    const bytes =
      Buffer.byteLength(input.text, "utf8") + Buffer.byteLength(query, "utf8") + vector.byteLength;
    if (bytes > limits.bytesPerDevice) return false;
    device.set(input.utteranceId, {
      utteranceId: input.utteranceId,
      text: input.text,
      query,
      vector,
      bytes,
      at,
    });
    let total = 0;
    for (const entry of device.values()) total += entry.bytes;
    for (const [key, entry] of device) {
      if (device.size <= limits.entriesPerDevice && total <= limits.bytesPerDevice) break;
      device.delete(key);
      total -= entry.bytes;
    }
    return true;
  }

  settle(input: {
    readonly deviceId: string;
    readonly utteranceId: string;
    readonly finalText: string;
  }): QueryPrefetchOutcome {
    const limits = this.#limits();
    const at = this.#now();
    const device = this.#prepared.get(input.deviceId);
    const prepared = device?.get(input.utteranceId);
    device?.delete(input.utteranceId);
    this.#sweep(at, limits);
    const query = spokenQueryText(input.finalText);
    const outcome: QueryPrefetchOutcome = !prepared
      ? { used: false, reason: "nothing_prepared", similarity: null }
      : at - prepared.at > limits.ttlMs
        ? { used: false, reason: "expired", similarity: null }
        : prepared.query === query
          ? { used: true, similarity: textSimilarityPermille(prepared.text, input.finalText) }
          : {
              used: false,
              reason: "different_words",
              similarity: textSimilarityPermille(prepared.text, input.finalText),
            };
    if (query.length === 0) return outcome;
    const index = this.#ready.findIndex(({ deviceId }) => deviceId === input.deviceId);
    if (index >= 0) this.#ready.splice(index, 1);
    this.#ready.push({
      deviceId: input.deviceId,
      finalText: input.finalText,
      query,
      vector: outcome.used && prepared ? prepared.vector : null,
      at,
    });
    return outcome;
  }

  claim(text: string): SpokenQuery | null {
    const at = this.#now();
    this.#sweep(at, this.#limits());
    const index = this.#ready.findIndex(({ finalText }) => finalText === text);
    if (index < 0) return null;
    const [ready] = this.#ready.splice(index, 1);
    return ready ? { query: ready.query, vector: ready.vector } : null;
  }

  preparedCount(deviceId: string): number {
    return this.#prepared.get(deviceId)?.size ?? 0;
  }

  #sweep(at: number, limits: QueryPrefetchLimits): void {
    for (const [deviceId, device] of this.#prepared) {
      for (const [key, entry] of device) if (at - entry.at > limits.ttlMs) device.delete(key);
      if (device.size === 0) this.#prepared.delete(deviceId);
    }
    for (let index = this.#ready.length - 1; index >= 0; index -= 1)
      if (at - (this.#ready[index] as Ready).at > limits.ttlMs) this.#ready.splice(index, 1);
  }
}

export function prefetchingEmbedder(inner: Embedder, prefetch: QueryPrefetch): Embedder {
  return {
    get model() {
      return inner.model;
    },
    get dimensions() {
      return inner.dimensions;
    },
    embedQuery: async (text) => {
      const spoken = prefetch.claim(text);
      if (!spoken) return inner.embedQuery(text);
      return spoken.vector ?? inner.embedQuery(spoken.query);
    },
    embedDocument: (text) => inner.embedDocument(text),
  };
}

export interface SharedQueryLimits {
  readonly ttlMs: number;
  readonly entries: number;
}

export interface SharedQueryEmbedders {
  readonly leader: Embedder;
  readonly follower: Embedder;
}

interface SharedQuery {
  readonly vector: Promise<Float32Array>;
  readonly at: number;
  failed: boolean;
}

export function sharedQueryEmbedders(
  inner: Embedder,
  options: { readonly limits: () => SharedQueryLimits; readonly now: () => number },
): SharedQueryEmbedders {
  const recent = new Map<string, SharedQuery>();
  const forget = () => {
    const { ttlMs, entries } = options.limits();
    const oldest = options.now() - ttlMs;
    for (const [text, entry] of recent)
      if (entry.at < oldest || recent.size > Math.max(0, entries)) recent.delete(text);
  };
  const embed = (text: string, reuseFailure: boolean) => {
    forget();
    const known = recent.get(text);
    if (known && (reuseFailure || !known.failed)) return known.vector;
    const entry: SharedQuery = { vector: inner.embedQuery(text), at: options.now(), failed: false };
    recent.set(text, entry);
    entry.vector.catch(() => {
      entry.failed = true;
    });
    forget();
    return entry.vector;
  };
  const view = (reuseFailure: boolean): Embedder => ({
    get model() {
      return inner.model;
    },
    get dimensions() {
      return inner.dimensions;
    },
    embedQuery: (text) => embed(text, reuseFailure),
    embedDocument: (text) => inner.embedDocument(text),
  });
  return Object.freeze({ leader: view(false), follower: view(true) });
}
