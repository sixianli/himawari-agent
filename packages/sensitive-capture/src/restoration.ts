import {
  EGRESS_PLACEHOLDER_PATTERN,
  type EgressPlaceholderKind,
  redactForEgress,
} from "./redaction.js";

export type PlaceholderTable = ReadonlyMap<string, string>;

export interface PlaceholderTableOptions {
  readonly trusted?: readonly string[];
  readonly jsonEmbedded?: boolean;
}

function decodedJsonString(value: string): string {
  try {
    const decoded: unknown = JSON.parse(`"${value}"`);
    return typeof decoded === "string" ? decoded : value;
  } catch {
    return value;
  }
}

export function placeholderTable(
  source: string,
  tag: (kind: EgressPlaceholderKind, value: string) => string,
  options: PlaceholderTableOptions = {},
): PlaceholderTable {
  const table = new Map<string, string>();
  redactForEgress(source, {
    known: new Map<string, string>(),
    tag,
    table,
    ...(options.trusted === undefined ? {} : { trusted: options.trusted }),
  });
  if (options.jsonEmbedded !== true) return table;
  return new Map([...table].map(([placeholder, value]) => [placeholder, decodedJsonString(value)]));
}

export function restorePlaceholders(text: string, table: PlaceholderTable): string {
  if (table.size === 0 || !text.includes("#")) return text;
  return text.replace(EGRESS_PLACEHOLDER_PATTERN, (match) => table.get(match) ?? match);
}
