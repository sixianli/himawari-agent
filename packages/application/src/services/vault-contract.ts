import {
  VAULT_FIELDS,
  VAULT_FORMAT,
  VAULT_ITEM_KINDS,
  VAULT_LIMITS,
  type VaultItemKind,
} from "../ports/vault.js";

export const VAULT_PATTERNS = Object.freeze({
  itemId: /^vi_[A-Za-z0-9_-]{22}$/u,
  requestId: /^vr_[A-Za-z0-9_-]{22}$/u,
  nonce: /^[A-Za-z0-9_-]{43}$/u,
  fieldId: /^[a-z][a-z0-9_]{0,31}$/u,
  pageVersion: /^[A-Za-z0-9._:-]{1,128}$/u,
  base64: /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
  runId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u,
});

const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

export function vaultTextHasHiddenCharacter(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return HIDDEN_RANGES.some(([from, to]) => code >= from && code <= to);
  });
}

export function vaultName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const length = [...value].length;
  if (length < 1 || length > VAULT_LIMITS.nameCharacters) return undefined;
  if (value.trim() !== value || vaultTextHasHiddenCharacter(value)) return undefined;
  return value;
}

const ORIGIN =
  /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::([0-9]{1,5}))?\/?$/u;

export function vaultOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 300) return undefined;
  const match = ORIGIN.exec(value.toLowerCase());
  if (!match) return undefined;
  const host = match[1] as string;
  if (host.length > 253) return undefined;
  const portText = match[2];
  if (portText === undefined) return `https://${host}`;
  const port = Number(portText);
  if (port < 1 || port > 65_535 || portText !== String(port)) return undefined;
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

export function vaultKind(value: unknown): VaultItemKind | undefined {
  return typeof value === "string" && (VAULT_ITEM_KINDS as readonly string[]).includes(value)
    ? (value as VaultItemKind)
    : undefined;
}

export function vaultFieldsValid(kind: VaultItemKind, fields: readonly string[]): boolean {
  const allowed: readonly string[] = [
    ...VAULT_FIELDS[kind].required,
    ...VAULT_FIELDS[kind].optional,
  ];
  const unique = new Set(fields);
  return (
    unique.size === fields.length &&
    fields.every((field) => VAULT_PATTERNS.fieldId.test(field) && allowed.includes(field)) &&
    VAULT_FIELDS[kind].required.every((field) => unique.has(field))
  );
}

export function vaultBase64(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
): string | undefined {
  if (typeof value !== "string" || !VAULT_PATTERNS.base64.test(value)) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = (value.length / 4) * 3 - padding;
  return bytes >= minimumBytes && bytes <= maximumBytes ? value : undefined;
}

export function vaultVersion(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 2_147_483_647
    ? value
    : undefined;
}

const encoder = new TextEncoder();

export function vaultFieldAad(itemId: string, fieldId: string, version: number): Uint8Array {
  return encoder.encode(`${VAULT_FORMAT}|field|${itemId}|${fieldId}|${version}`);
}

export function vaultReleaseAad(requestId: string, itemId: string, version: number): Uint8Array {
  return encoder.encode(`${VAULT_FORMAT}|release|${requestId}|${itemId}|${version}`);
}

export const VAULT_RELEASE_INFO = `${VAULT_FORMAT} release`;
