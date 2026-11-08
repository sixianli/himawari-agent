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

function jsonStringContent(value: string): string {
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') return value.slice(0, index);
  }
  return value;
}

function decodedJsonString(value: string): string {
  const content = jsonStringContent(value);
  try {
    const decoded: unknown = JSON.parse(`"${content}"`);
    return typeof decoded === "string" ? decoded : content;
  } catch {
    return content;
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
