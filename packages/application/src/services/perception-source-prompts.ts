import {
  PERCEPTION_DATA_NOTICE,
  PERCEPTION_EXTRACT_CALENDAR_HEADER,
  PERCEPTION_IMAGE_UNDERSTAND,
  PERCEPTION_NOW_HEADER,
  PERCEPTION_SOURCE_CALENDAR,
  PERCEPTION_SOURCE_ITEMS_HEADER,
  PERCEPTION_SOURCE_LOCATION,
  PERCEPTION_SOURCE_MESSAGE,
  PERCEPTION_SOURCE_SCREEN,
  PERCEPTION_SOURCE_SPEECH,
} from "@himawari-agent/prompt-catalog";

export const PERCEPTION_SOURCE_KINDS = [
  "speech",
  "calendar",
  "location",
  "message",
  "screen",
] as const;
export type PerceptionSourceKind = (typeof PERCEPTION_SOURCE_KINDS)[number];

const SOURCE_INSTRUCTIONS: Readonly<Record<PerceptionSourceKind, string>> = Object.freeze({
  speech: PERCEPTION_SOURCE_SPEECH.text,
  calendar: PERCEPTION_SOURCE_CALENDAR.text,
  location: PERCEPTION_SOURCE_LOCATION.text,
  message: PERCEPTION_SOURCE_MESSAGE.text,
  screen: PERCEPTION_SOURCE_SCREEN.text,
});

const DUE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/u;
const WHAT_MAXIMUM = 60;
const REASON_MAXIMUM = 200;
const DESCRIPTION_MAXIMUM = 80;

export interface PerceptionSourceItem {
  readonly id: string;
  readonly atMs: number;
  readonly line: string;
}

export function buildPerceptionSourceCheckPrompt(input: {
  readonly kind: PerceptionSourceKind;
  readonly items: readonly PerceptionSourceItem[];
  readonly calendar: readonly string[];
  readonly now: string;
}): string {
  return [
    SOURCE_INSTRUCTIONS[input.kind],
    PERCEPTION_DATA_NOTICE.text,
    PERCEPTION_SOURCE_ITEMS_HEADER.text,
    ...[...input.items]
      .sort(
        (left, right) =>
          left.atMs - right.atMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )
      .map(({ line }) => line),
    PERCEPTION_EXTRACT_CALENDAR_HEADER.text,
    ...input.calendar,
    PERCEPTION_NOW_HEADER.text,
    input.now,
  ].join("\n");
}

export type PerceptionSourceVerdict =
  | { readonly id: string; readonly result: "ignore" }
  | {
      readonly id: string;
      readonly result: "remind";
      readonly what: string;
      readonly due: string | null;
      readonly reason: string;
    };

function jsonObject(output: string): Record<string, unknown> | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(output.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function bounded(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || [...trimmed].length > maximum ? null : trimmed;
}

export function parsePerceptionSourceCheck(
  output: string,
  itemIds: readonly string[],
): readonly PerceptionSourceVerdict[] | null {
  const items = jsonObject(output)?.["items"];
  if (!Array.isArray(items)) return null;
  const verdicts = new Map<string, PerceptionSourceVerdict>();
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const { id, result, what, due, reason } = item as Record<string, unknown>;
    if (typeof id !== "string" || !itemIds.includes(id) || verdicts.has(id)) continue;
    if (result === "ignore") {
      verdicts.set(id, { id, result });
      continue;
    }
    const stated = bounded(what, WHAT_MAXIMUM);
    const why = bounded(reason, REASON_MAXIMUM);
    const when = due ?? null;
    if (
      result !== "remind" ||
      stated === null ||
      why === null ||
      (when !== null && (typeof when !== "string" || !DUE_PATTERN.test(when)))
    )
      continue;
    verdicts.set(id, { id, result, what: stated, due: when as string | null, reason: why });
  }
  return itemIds.map((id) => verdicts.get(id) ?? { id, result: "ignore" });
}

export function perceptionImagePrompt(): string {
  return PERCEPTION_IMAGE_UNDERSTAND.text;
}

export function parsePerceptionImage(
  output: string,
): { readonly text: string; readonly description: string } | null {
  const parsed = jsonObject(output);
  if (!parsed || typeof parsed["text"] !== "string") return null;
  const description = bounded(parsed["description"], DESCRIPTION_MAXIMUM);
  return description === null ? null : { text: parsed["text"], description };
}
