export interface ThinkRunAnswer {
  readonly action: string;
  readonly reason: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

const ACTION = /^[a-z][a-z0-9_.-]{0,63}$/u;
const MAXIMUM_REASON_LENGTH = 500;
const MAXIMUM_ANSWER_LENGTH = 16_384;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseThinkRunAnswer(raw: unknown): ThinkRunAnswer | undefined {
  if (typeof raw !== "string" || raw.length > MAXIMUM_ANSWER_LENGTH) return undefined;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  const outside = `${raw.slice(0, start)}${raw.slice(end + 1)}`
    .replace(/```(?:json)?/gu, "")
    .trim();
  if (outside.length > 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { action, reason, ...fields } = parsed;
  if (typeof action !== "string" || !ACTION.test(action)) return undefined;
  if (typeof reason !== "string") return undefined;
  const trimmed = reason.trim();
  if (trimmed.length === 0 || [...trimmed].length > MAXIMUM_REASON_LENGTH) return undefined;
  return Object.freeze({ action, reason: trimmed, fields: Object.freeze({ ...fields }) });
}
