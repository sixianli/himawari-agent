import { formatSize, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";

export type PiResultOutputFitter = (json: string, maxBytes: number) => string | null;

const TAIL_DIRECTIONS = new Set(["bash"]);

type TruncationResult = ReturnType<typeof truncateHead>;

function parseEnvelope(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function truncationMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const metadata = { ...(value as Record<string, unknown>) };
  delete metadata["content"];
  return metadata;
}

function limitNotice(result: TruncationResult): string {
  return `\n\n[${formatSize(result.maxBytes)} limit reached]`;
}

export function fitPiResultOutput(json: string, maxBytes: number): string | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;
  if (Buffer.byteLength(json, "utf-8") <= maxBytes) return json;

  const envelope = parseEnvelope(json);
  if (!envelope || !Array.isArray(envelope["content"])) return null;
  const parts = envelope["content"] as Array<Record<string, unknown>>;
  const tail = TAIL_DIRECTIONS.has(typeof envelope["tool"] === "string" ? envelope["tool"] : "");
  const indexes = parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => part["type"] === "text" && typeof part["text"] === "string")
    .map(({ index }) => index);
  if (indexes.length === 0) return null;

  const texts = indexes.map((index) => parts[index]?.["text"] as string);
  const lengths = texts.map((text) => Buffer.byteLength(text, "utf-8"));
  const upper = Math.max(0, Math.min(...lengths) - 1);

  const render = (budget: number): string => {
    const state: { largest: number; truncation: TruncationResult | null } = {
      largest: -1,
      truncation: null,
    };
    let position = -1;
    const next = parts.map((part) => {
      if (part["type"] !== "text" || typeof part["text"] !== "string") return { ...part };
      position += 1;
      const length = lengths[position] as number;
      const result = tail
        ? truncateTail(texts[position] as string, { maxBytes: budget })
        : truncateHead(texts[position] as string, { maxBytes: budget });
      if (!result.truncated) return { ...part };
      if (length > state.largest) {
        state.largest = length;
        state.truncation = result;
      }
      return { ...part, text: `${result.content}${limitNotice(result)}` };
    });
    const clone: Record<string, unknown> = { ...envelope, content: next };
    if (state.truncation !== null) {
      const details =
        clone["details"] && typeof clone["details"] === "object" && !Array.isArray(clone["details"])
          ? { ...(clone["details"] as Record<string, unknown>) }
          : {};
      details["truncation"] = truncationMetadata(state.truncation);
      clone["details"] = details;
    }
    return JSON.stringify(clone);
  };

  let low = 0;
  let high = upper;
  let best: string | null = null;
  for (let step = 0; step < 32 && low <= high; step += 1) {
    const middle = Math.floor((low + high) / 2);
    const candidate = render(middle);
    if (Buffer.byteLength(candidate, "utf-8") <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export const PI_RESULT_OUTPUT_ENVELOPE_RESERVE = 2048;
