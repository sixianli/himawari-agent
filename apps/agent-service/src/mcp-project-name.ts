const INVISIBLE_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
const WHITESPACE = /\s/u;
const AT_FOLLOWED_BY_COLON = /^[^\s/:]+:/u;

export type McpSyncTextRefusal = "empty" | "too_long" | "hidden_character" | "credential_in_name";

export type McpSyncNameCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: McpSyncTextRefusal };

function parsedParts(judged: string): {
  readonly login: string;
  readonly secret: string;
  readonly host: string;
  readonly search: string;
  readonly hash: string;
} | null {
  try {
    const url = new URL(judged.startsWith("//") ? `https:${judged}` : judged);
    return {
      login: url.username,
      secret: url.password,
      host: url.hostname,
      search: url.search,
      hash: url.hash,
    };
  } catch {
    return null;
  }
}

export function projectNameHasCredential(name: string): boolean {
  const judged = name.replaceAll("\\", "/");
  const parts = parsedParts(judged);
  if (parts !== null) {
    if (parts.login !== "" || parts.secret !== "") return true;
    if (parts.host !== "" && (parts.search !== "" || parts.hash !== "")) return true;
  }
  if (
    (judged.includes("://") || judged.startsWith("//")) &&
    (judged.includes("@") || judged.includes("?") || judged.includes("#"))
  )
    return true;
  const at = judged.indexOf("@");
  if (at > 0) {
    const before = judged.slice(0, at);
    if (!WHITESPACE.test(before) && !before.includes("/")) {
      if (before.includes(":")) return true;
      if (AT_FOLLOWED_BY_COLON.test(judged.slice(at + 1))) return true;
    }
  }
  return false;
}

export function checkSyncText(
  raw: unknown,
  maximum: number,
  options: { readonly trim: boolean },
): McpSyncNameCheck {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  const normalized = options.trim ? raw.normalize("NFC").trim() : raw.normalize("NFC");
  if (normalized.length === 0) return { ok: false, reason: "empty" };
  if ([...normalized].length > maximum) return { ok: false, reason: "too_long" };
  if (INVISIBLE_CHARACTER.test(normalized)) return { ok: false, reason: "hidden_character" };
  return { ok: true, value: normalized };
}

export function checkProjectName(
  raw: unknown,
  maximum: number,
): McpSyncNameCheck | { readonly ok: true; readonly value: null } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw === "string" && raw.normalize("NFC").trim().length === 0)
    return { ok: true, value: null };
  const checked = checkSyncText(raw, maximum, { trim: true });
  if (!checked.ok) return checked;
  if (projectNameHasCredential(checked.value)) return { ok: false, reason: "credential_in_name" };
  return checked;
}

export function checkStableId(raw: unknown, maximum: number): McpSyncNameCheck {
  return checkSyncText(raw, maximum, { trim: false });
}
