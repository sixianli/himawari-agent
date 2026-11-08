import {
  EGRESS_PLACEHOLDER_PATTERN,
  type EgressPlaceholderKind,
  redactForEgress,
} from "./redaction.js";

export type PlaceholderTable = ReadonlyMap<string, string>;

export function placeholderTable(
  source: string,
  tag: (kind: EgressPlaceholderKind, value: string) => string,
): PlaceholderTable {
  const table = new Map<string, string>();
  redactForEgress(source, { known: new Map<string, string>(), tag, table });
  return table;
}

export function restorePlaceholders(text: string, table: PlaceholderTable): string {
  if (table.size === 0 || !text.includes("#")) return text;
  return text.replace(EGRESS_PLACEHOLDER_PATTERN, (match) => table.get(match) ?? match);
}
