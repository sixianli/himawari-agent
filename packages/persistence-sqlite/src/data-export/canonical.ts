import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => sorted(item as JsonValue));
  if (value !== null && typeof value === "object") {
    const source = value as { readonly [key: string]: JsonValue };
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) out[key] = sorted(item);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function jsonLines(rows: readonly JsonValue[]): string {
  return rows.map((row) => `${canonicalJson(row)}\n`).join("");
}
