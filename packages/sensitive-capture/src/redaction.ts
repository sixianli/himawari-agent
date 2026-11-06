import { MACHINE_SECRET_RULE_IDS, redactMachineSecrets } from "./machine-secrets.js";

export const EGRESS_REDACTION_KINDS = Object.freeze([
  "machine-secret",
  "password",
  "verification-code",
  "bank-card",
  "identity-number",
] as const);

export type EgressRedactionKind = (typeof EGRESS_REDACTION_KINDS)[number];

export interface EgressRedactionFinding {
  readonly kind: EgressRedactionKind;
  readonly count: number;
}

export interface EgressRedaction {
  readonly text: string;
  readonly findings: readonly EgressRedactionFinding[];
}

export type EgressPlaceholderKind =
  | "password"
  | "verification-code"
  | "bank-card"
  | "identity-number";

export const EGRESS_REDACTION_RULE_IDS = Object.freeze([
  ...MACHINE_SECRET_RULE_IDS,
  "password-keyword",
  "cn-identity-number",
  "iban",
  "bank-card",
  "jp-my-number",
  "verification-code-keyword",
  "named-earlier",
] as const);

export type EgressRedactionRuleId = (typeof EGRESS_REDACTION_RULE_IDS)[number];

export interface EgressRedactionSighting {
  readonly kind: EgressRedactionKind;
  readonly ruleId: EgressRedactionRuleId;
  readonly value: string;
}

export interface EgressRedactionOptions {
  readonly tag?: (kind: EgressPlaceholderKind, value: string) => string;
  readonly known?: Map<string, string>;
  readonly table?: Map<string, string>;
  readonly observe?: (sighting: EgressRedactionSighting) => void;
  readonly trusted?: readonly string[];
}

export const EGRESS_PLACEHOLDER_PATTERN = /\[(密码|验证码|证件号|银行卡 尾号\d{4})#([a-z]{8})\]/gu;

const KNOWN_VALUE_MINIMUM_LENGTH = 6;

const MACHINE_SECRET_MARKER = "[MACHINE_SECRET_REDACTED]";
const MACHINE_SECRET_PLACEHOLDER = "[密钥]";

const PASSWORD_ASSIGNMENT =
  /((?:密码|密碼|口令|PIN\s?码|PIN\s?碼|安全码|安全碼|授权码|授權碼|パスワード|暗証番号|비밀번호|암호|비번|password|passwd|pwd)\s*(?:[:：=＝]|是|为|為|は)\s*)(?!\[)([^\s,，;；\uFFFF]+)/giu;

const VERIFICATION_CODE_KEYWORD =
  /(?:验证码|驗證碼|校验码|認証コード|確認コード|認証番号|ワンタイム|verification code|security code|login code|one[- ]time (?:pass)?(?:code|word)|passcode|\bOTP\b)/iu;
const CODE_WINDOW = 40;
const DIGIT_RUN = /(?<![\d])\d{4,8}(?![\d])/gu;

const CARD_CANDIDATE = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/gu;

const CN_ID_NUMBER =
  /(?<![\d])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dXx])/gu;
const JP_MY_NUMBER_KEYWORD = /(?:マイナンバー|個人番号|my\s*number)/iu;
const JP_MY_NUMBER = /(?<![\d])\d{12}(?![\d])/gu;
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/gu;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function plausibleCardNetwork(digits: string): boolean {
  const length = digits.length;
  const two = Number(digits.slice(0, 2));
  const four = Number(digits.slice(0, 4));
  const three = Number(digits.slice(0, 3));
  if (digits[0] === "4") return length === 13 || length === 16 || length === 19;
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return length === 16;
  if (two === 34 || two === 37) return length === 15;
  if (two === 62) return length >= 16 && length <= 19;
  if (digits.startsWith("6011") || two === 65 || (three >= 644 && three <= 649))
    return length >= 16 && length <= 19;
  if (two === 35) return length >= 16 && length <= 19;
  if (two === 36 || two === 38 || (three >= 300 && three <= 305))
    return length >= 14 && length <= 19;
  if (two === 50 || two === 56 || two === 57 || two === 58 || two === 60 || two === 63) {
    return length >= 16 && length <= 19;
  }
  return false;
}

function cnIdChecksumValid(value: string): boolean {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = "10X98765432";
  let sum = 0;
  for (let index = 0; index < 17; index += 1)
    sum += (value.charCodeAt(index) - 48) * (weights[index] ?? 0);
  return checks[sum % 11] === value[17]?.toUpperCase();
}

function myNumberChecksumValid(value: string): boolean {
  let sum = 0;
  for (let n = 1; n <= 11; n += 1) {
    const digit = value.charCodeAt(11 - n) - 48;
    sum += digit * (n <= 6 ? n + 1 : n - 5);
  }
  const remainder = sum % 11;
  const check = remainder <= 1 ? 0 : 11 - remainder;
  return check === value.charCodeAt(11) - 48;
}

function ibanValid(value: string): boolean {
  const compact = value.replace(/ /gu, "");
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const expanded = /[A-Z]/u.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of expanded) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

function tally(counts: Map<EgressRedactionKind, number>, kind: EgressRedactionKind): void {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}

function isFormattedNumberNeighbour(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const after = text[end];
  const joiner = /[-/:.,]/u;
  const digit = /\d/u;
  if (before !== undefined && joiner.test(before) && digit.test(text[start - 2] ?? "")) return true;
  if (after !== undefined && joiner.test(after) && digit.test(text[end + 1] ?? "")) return true;
  return false;
}

function looksLikeCalendarYear(text: string, start: number, end: number): boolean {
  return (
    end - start === 4 &&
    /^(?:19|20)\d{2}$/u.test(text.slice(start, end)) &&
    /[年/-]/u.test(text[end] ?? "")
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const TRUSTED_FILLER = "\uFFFF";

function trustedSpans(
  input: string,
  trusted: readonly string[],
): readonly (readonly [number, number])[] {
  if (trusted.length === 0 || input.includes(TRUSTED_FILLER)) return [];
  const found: (readonly [number, number])[] = [];
  for (const value of trusted) {
    if (value.length === 0) continue;
    for (
      let position = input.indexOf(value);
      position >= 0;
      position = input.indexOf(value, position + 1)
    )
      found.push([position, position + value.length]);
  }
  found.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const spans: (readonly [number, number])[] = [];
  let cursor = 0;
  for (const span of found) {
    if (span[0] < cursor) continue;
    spans.push(span);
    cursor = span[1];
  }
  return spans;
}

export function redactForEgress(
  input: string,
  options: EgressRedactionOptions = {},
): EgressRedaction {
  const spans = trustedSpans(input, options.trusted ?? []);
  if (spans.length === 0) return redactUntrusted(input, options);
  let view = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    view += input.slice(cursor, start) + TRUSTED_FILLER.repeat(end - start);
    cursor = end;
  }
  view += input.slice(cursor);
  const masked = redactUntrusted(view, options);
  let text = "";
  let read = 0;
  for (const [start, end] of spans) {
    const at = masked.text.indexOf(TRUSTED_FILLER, read);
    const length = end - start;
    if (at < 0 || masked.text.slice(at, at + length) !== TRUSTED_FILLER.repeat(length))
      throw new EgressRedactionError();
    text += masked.text.slice(read, at) + input.slice(start, end);
    read = at + length;
  }
  text += masked.text.slice(read);
  if (text.includes(TRUSTED_FILLER)) throw new EgressRedactionError();
  return Object.freeze({ text, findings: masked.findings });
}

function redactUntrusted(input: string, options: EgressRedactionOptions): EgressRedaction {
  const counts = new Map<EgressRedactionKind, number>();
  const { tag, known, table, observe } = options;
  let text = input;
  const see = (kind: EgressRedactionKind, ruleId: EgressRedactionRuleId, value: string): void => {
    if (observe === undefined) return;
    try {
      observe(Object.freeze({ kind, ruleId, value }));
    } catch {
      return;
    }
  };

  const mask = (
    kind: EgressPlaceholderKind,
    label: string,
    original: string,
    identity: string,
    rememberValue: boolean,
  ): string => {
    const placeholder = tag === undefined ? `[${label}]` : `[${label}#${tag(kind, identity)}]`;
    if (tag !== undefined) {
      if (table !== undefined && !table.has(placeholder)) table.set(placeholder, original);
      if (
        rememberValue &&
        known !== undefined &&
        original.length >= KNOWN_VALUE_MINIMUM_LENGTH &&
        !known.has(original)
      )
        known.set(original, placeholder);
    }
    return placeholder;
  };

  const machineMarkers = text.split(MACHINE_SECRET_MARKER).length - 1;
  text = redactMachineSecrets(text, (ruleId, value) => see("machine-secret", ruleId, value));
  const afterMachine = text.split(MACHINE_SECRET_MARKER).length - 1;
  for (let index = machineMarkers; index < afterMachine; index += 1)
    tally(counts, "machine-secret");
  text = text.split(MACHINE_SECRET_MARKER).join(MACHINE_SECRET_PLACEHOLDER);

  text = text.replace(PASSWORD_ASSIGNMENT, (_match, lead: string, value: string) => {
    if (value === MACHINE_SECRET_PLACEHOLDER || value.startsWith("[")) return `${lead}${value}`;
    tally(counts, "password");
    see("password", "password-keyword", value);
    return `${lead}${mask("password", "密码", value, value, true)}`;
  });

  text = text.replace(CN_ID_NUMBER, (match) => {
    if (!cnIdChecksumValid(match)) return match;
    tally(counts, "identity-number");
    see("identity-number", "cn-identity-number", match.toUpperCase());
    return mask("identity-number", "证件号", match, match.toUpperCase(), false);
  });

  text = text.replace(IBAN_CANDIDATE, (match) => {
    if (!ibanValid(match)) return match;
    tally(counts, "identity-number");
    see("identity-number", "iban", match.replace(/ /gu, ""));
    return mask("identity-number", "证件号", match, match.replace(/ /gu, ""), false);
  });

  text = text.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/gu, "");
    if (digits.length < 13 || digits.length > 19) return match;
    if (!plausibleCardNetwork(digits) || !luhnValid(digits)) return match;
    tally(counts, "bank-card");
    see("bank-card", "bank-card", digits);
    return mask("bank-card", `银行卡 尾号${digits.slice(-4)}`, match, digits, false);
  });

  text = text.replace(JP_MY_NUMBER, (match, offset: number, whole: string) => {
    const window = whole.slice(
      Math.max(0, offset - CODE_WINDOW),
      offset + match.length + CODE_WINDOW,
    );
    if (!JP_MY_NUMBER_KEYWORD.test(window) || !myNumberChecksumValid(match)) return match;
    tally(counts, "identity-number");
    see("identity-number", "jp-my-number", match);
    return mask("identity-number", "证件号", match, match, false);
  });

  text = text.replace(DIGIT_RUN, (match, offset: number, whole: string) => {
    const end = offset + match.length;
    const window = whole.slice(Math.max(0, offset - CODE_WINDOW), end + CODE_WINDOW);
    if (!VERIFICATION_CODE_KEYWORD.test(window)) return match;
    if (whole.slice(Math.max(0, offset - 2), offset) === "尾号") return match;
    if (isFormattedNumberNeighbour(whole, offset, end)) return match;
    if (looksLikeCalendarYear(whole, offset, end)) return match;
    tally(counts, "verification-code");
    see("verification-code", "verification-code-keyword", match);
    return mask("verification-code", "验证码", match, match, true);
  });

  if (known !== undefined && known.size > 0) {
    for (const [value, placeholder] of known) {
      if (!text.includes(value)) continue;
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegExp(value)}(?![\\p{L}\\p{N}_])`,
        "gu",
      );
      const kind = placeholder.startsWith("[验证码") ? "verification-code" : "password";
      text = text.replace(pattern, () => {
        tally(counts, kind);
        see(kind, "named-earlier", value);
        return placeholder;
      });
    }
  }

  const findings = EGRESS_REDACTION_KINDS.flatMap((kind) => {
    const count = counts.get(kind);
    return count === undefined ? [] : [Object.freeze({ kind, count })];
  });
  return Object.freeze({ text, findings: Object.freeze(findings) });
}

const CREDENTIAL_KINDS: ReadonlySet<EgressRedactionKind> = new Set([
  "password",
  "verification-code",
]);

const CREDENTIAL_PLACEHOLDER_KINDS: Readonly<Record<string, EgressRedactionKind>> = {
  密码: "password",
  验证码: "verification-code",
};

export function credentialFindings(input: string): readonly EgressRedactionFinding[] {
  const counts = new Map<EgressRedactionKind, number>();
  for (const { kind, count } of redactForEgress(input).findings)
    if (CREDENTIAL_KINDS.has(kind)) counts.set(kind, (counts.get(kind) ?? 0) + count);
  for (const match of input.matchAll(EGRESS_PLACEHOLDER_PATTERN)) {
    const kind = CREDENTIAL_PLACEHOLDER_KINDS[match[1] ?? ""];
    if (kind !== undefined) tally(counts, kind);
  }
  const masked = input.split(MACHINE_SECRET_PLACEHOLDER).length - 1;
  if (masked > 0) counts.set("machine-secret", masked);
  return EGRESS_REDACTION_KINDS.flatMap((kind) => {
    const count = counts.get(kind);
    return count === undefined ? [] : [{ kind, count }];
  });
}

export function findSensitiveValues(input: string): readonly EgressRedactionSighting[] {
  const found: EgressRedactionSighting[] = [];
  redactForEgress(input, { observe: (sighting) => found.push(sighting) });
  return Object.freeze(found);
}

export interface MaskedValueSpan {
  readonly start: number;
  readonly end: number;
  readonly sighting: EgressRedactionSighting;
}

const LOCATED_PLACEHOLDER = /\[(?:密码|验证码|证件号|银行卡 尾号\d{4})#([a-z]{8})\]|\[密钥\]/gu;

function spanTag(index: number): string {
  let out = "";
  let rest = index;
  for (let digit = 0; digit < 8; digit += 1) {
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }
  return out;
}

function machinePositions(
  input: string,
  sightings: readonly EgressRedactionSighting[],
): readonly EgressRedactionSighting[] | null {
  const placed: { position: number; sighting: EgressRedactionSighting }[] = [];
  const next = new Map<string, number>();
  const sighted = new Map<string, number>();
  for (const sighting of sightings) {
    if (sighting.value.length === 0) return null;
    const position = input.indexOf(sighting.value, next.get(sighting.value) ?? 0);
    if (position < 0) return null;
    next.set(sighting.value, position + sighting.value.length);
    sighted.set(sighting.value, (sighted.get(sighting.value) ?? 0) + 1);
    placed.push({ position, sighting });
  }
  for (const [value, count] of sighted) if (occurrences(input, value) !== count) return null;
  placed.sort((left, right) => left.position - right.position);
  for (let index = 1; index < placed.length; index += 1) {
    const previous = placed[index - 1];
    const current = placed[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.position + previous.sighting.value.length > current.position
    )
      return null;
  }
  return placed.map(({ sighting }) => sighting);
}

function occurrences(input: string, value: string): number {
  let count = 0;
  for (
    let position = input.indexOf(value);
    position >= 0;
    position = input.indexOf(value, position + value.length)
  )
    count += 1;
  return count;
}

export function locateMaskedValues(
  input: string,
): { readonly text: string; readonly spans: readonly MaskedValueSpan[] } | null {
  const machine: EgressRedactionSighting[] = [];
  const tagged = new Map<string, EgressRedactionSighting>();
  let pending: EgressRedactionSighting | undefined;
  let counter = 0;
  const marked = redactForEgress(input, {
    observe: (sighting) => {
      if (sighting.kind === "machine-secret") machine.push(sighting);
      else pending = sighting;
    },
    tag: () => {
      const id = spanTag(counter);
      counter += 1;
      if (pending !== undefined) tagged.set(id, pending);
      pending = undefined;
      return id;
    },
  }).text;
  const ordered = machinePositions(input, machine);
  if (ordered === null) return null;
  const spans: MaskedValueSpan[] = [];
  let text = "";
  let last = 0;
  let machineIndex = 0;
  for (const match of marked.matchAll(LOCATED_PLACEHOLDER)) {
    const index = match.index ?? 0;
    text += marked.slice(last, index);
    const id = match[1];
    const bare = id === undefined ? match[0] : match[0].replace(`#${id}`, "");
    const start = text.length;
    text += bare;
    last = index + match[0].length;
    const sighting = id === undefined ? ordered[machineIndex++] : tagged.get(id);
    if (sighting === undefined) return null;
    spans.push(Object.freeze({ start, end: text.length, sighting }));
  }
  text += marked.slice(last);
  if (machineIndex !== ordered.length || text !== redactForEgress(input).text) return null;
  return Object.freeze({ text, spans: Object.freeze(spans) });
}

export function maskSensitiveText(input: string): string {
  return redactForEgress(input).text;
}

export class EgressRedactionError extends Error {
  readonly code = "EGRESS_REDACTION_INCOMPLETE" as const;
  constructor() {
    super("Outbound text still contained sensitive material after redaction");
    this.name = "EgressRedactionError";
  }
}
