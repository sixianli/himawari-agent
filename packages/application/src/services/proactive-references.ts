import type { ProactiveSourceItem } from "../ports/proactive-checks.js";

export const MAXIMUM_REFERENCES_PER_MAIL = 3;

const REFERENCE_SHAPE = /^(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{7,39}$/u;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/u;

function mailText(item: Pick<ProactiveSourceItem, "subject" | "body" | "snippet">): string {
  return `${item.subject}\n${item.body ?? item.snippet}`.toUpperCase();
}

function appearsAsWholeToken(haystack: string, reference: string): boolean {
  let from = haystack.indexOf(reference);
  while (from >= 0) {
    const before = haystack[from - 1] ?? "";
    const after = haystack[from + reference.length] ?? "";
    const afterNext = haystack[from + reference.length + 1] ?? "";
    const longerAfter = /[A-Z0-9]/u.test(after) || (after === "-" && /[A-Z0-9]/u.test(afterNext));
    if (!/[A-Z0-9-]/u.test(before) && !longerAfter) return true;
    from = haystack.indexOf(reference, from + 1);
  }
  return false;
}

export function validMailReferences(
  proposed: unknown,
  item: Pick<ProactiveSourceItem, "subject" | "body" | "snippet">,
): readonly string[] {
  if (!Array.isArray(proposed)) return [];
  const haystack = mailText(item);
  const accepted: string[] = [];
  for (const value of proposed) {
    if (typeof value !== "string") continue;
    const reference = value.trim().replace(/-+$/u, "").toUpperCase();
    if (!REFERENCE_SHAPE.test(reference) || DATE_SHAPE.test(reference)) continue;
    if (!appearsAsWholeToken(haystack, reference)) continue;
    if (!accepted.includes(reference)) accepted.push(reference);
    if (accepted.length >= MAXIMUM_REFERENCES_PER_MAIL) break;
  }
  return accepted;
}

export function parseMailReferences(
  output: string,
  items: readonly ProactiveSourceItem[],
): ReadonlyMap<string, readonly string[]> {
  const trimmed = output
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("MAIL_REFERENCES_INVALID");
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
  const list =
    typeof parsed === "object" && parsed !== null ? (parsed as { items?: unknown }).items : null;
  if (!Array.isArray(list)) throw new Error("MAIL_REFERENCES_INVALID");
  const byId = new Map(items.map((item) => [item.messageId, item]));
  const result = new Map<string, readonly string[]>();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, references } = entry as { id?: unknown; references?: unknown };
    const item = typeof id === "string" ? byId.get(id) : undefined;
    if (item === undefined || result.has(item.messageId)) continue;
    const valid = validMailReferences(references, item);
    if (valid.length > 0) result.set(item.messageId, valid);
  }
  return result;
}
