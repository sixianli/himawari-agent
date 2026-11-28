import {
  EGRESS_REDACTION_KINDS,
  type EgressPlaceholderKind,
  type EgressRedaction,
  type EgressRedactionFinding,
  type EgressRedactionKind,
  redactForEgress,
} from "./redaction.js";

export interface ExternalRedactionOptions {
  readonly tag?: (kind: EgressPlaceholderKind, value: string) => string;
  readonly known?: Map<string, string>;
  readonly ruleset?: number;
}

const KNOWN_VALUE_MINIMUM_LENGTH = 6;

const SENSITIVE_URL_PARAMETERS: ReadonlySet<string> = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "privatetoken",
  "sessiontoken",
  "securitytoken",
  "key",
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "pwd",
  "signature",
  "sig",
  "credential",
  "credentials",
  "authorization",
  "auth",
]);

const SENSITIVE_URL_PARAMETER_PREFIXES = Object.freeze(["xamz", "xgoog"]);

function parameterName(name: string): string {
  return decoded(name.replace(/\+/gu, " "))
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

export function isSensitiveUrlParameter(name: string): boolean {
  const normalized = parameterName(name);
  return (
    SENSITIVE_URL_PARAMETERS.has(normalized) ||
    SENSITIVE_URL_PARAMETER_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

export function sequentialPlaceholderTag(): (kind: EgressPlaceholderKind, value: string) => string {
  const ids = new Map<string, number>();
  return (kind, value) => {
    const identity = `${kind}\u0000${value}`;
    const index = ids.get(identity) ?? ids.size;
    ids.set(identity, index);
    let out = "";
    let rest = index;
    for (let digit = 0; digit < 8; digit += 1) {
      out = String.fromCharCode(97 + (rest % 26)) + out;
      rest = Math.floor(rest / 26);
    }
    return out;
  };
}

export function redactForExternalText(
  input: string,
  options: ExternalRedactionOptions = {},
): EgressRedaction {
  return redactForEgress(input, {
    known: options.known ?? new Map<string, string>(),
    tag: options.tag ?? sequentialPlaceholderTag(),
    ...(options.ruleset === undefined ? {} : { ruleset: options.ruleset }),
  });
}

const URL_AUTHORITY = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/iu;

function withoutUserInfo(input: string): { readonly text: string; readonly removed: boolean } {
  const match = URL_AUTHORITY.exec(input);
  if (match === null) return { text: input, removed: false };
  const authority = match[2] ?? "";
  const at = authority.lastIndexOf("@");
  if (at < 0) return { text: input, removed: false };
  const scheme = match[1] ?? "";
  return {
    text: scheme + authority.slice(at + 1) + input.slice(scheme.length + authority.length),
    removed: true,
  };
}

const PLACEHOLDER = /\[(?:密码|密钥|验证码|证件号|银行卡 尾号\d{4})(?:#[a-z]{8})?\]/gu;
const WHOLE_PLACEHOLDER = new RegExp(`^${PLACEHOLDER.source}$`, "u");
const ENCODED_PLACEHOLDER = /%5B(?:%[0-9A-F]{2}|[a-z0-9]){0,160}?%5D/giu;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodedPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER, (placeholder) => encodeURIComponent(placeholder));
}

function isPlaceholder(value: string): boolean {
  return WHOLE_PLACEHOLDER.test(decoded(value));
}

function maskParameterPairs(
  segment: string,
  tag: (kind: EgressPlaceholderKind, value: string) => string,
  known: Map<string, string>,
): { readonly text: string; readonly masked: number } {
  let masked = 0;
  const pairs = segment.split("&").map((pair) => {
    const equals = pair.indexOf("=");
    if (equals < 0) return pair;
    const value = pair.slice(equals + 1);
    if (
      value.length === 0 ||
      isPlaceholder(value) ||
      !isSensitiveUrlParameter(pair.slice(0, equals))
    )
      return pair;
    masked += 1;
    const plain = decoded(value);
    const placeholder = `[密码#${tag("password", plain)}]`;
    for (const original of new Set([value, plain]))
      if (original.length >= KNOWN_VALUE_MINIMUM_LENGTH && !known.has(original))
        known.set(original, placeholder);
    return `${pair.slice(0, equals + 1)}${encodeURIComponent(placeholder)}`;
  });
  return { text: pairs.join("&"), masked };
}

function withoutSensitiveParameters(
  input: string,
  tag: (kind: EgressPlaceholderKind, value: string) => string,
  known: Map<string, string>,
): { readonly text: string; readonly masked: number } {
  const hash = input.indexOf("#");
  const beforeFragment = hash < 0 ? input : input.slice(0, hash);
  const fragment = hash < 0 ? "" : input.slice(hash);
  let masked = 0;
  let head = beforeFragment;
  const query = beforeFragment.indexOf("?");
  if (query >= 0) {
    const result = maskParameterPairs(beforeFragment.slice(query + 1), tag, known);
    head = beforeFragment.slice(0, query + 1) + result.text;
    masked += result.masked;
  }
  let tail = fragment;
  if (hash >= 0) {
    const fragmentQuery = fragment.indexOf("?");
    const start = fragmentQuery >= 0 ? fragmentQuery + 1 : 1;
    const result = maskParameterPairs(fragment.slice(start), tag, known);
    tail = fragment.slice(0, start) + result.text;
    masked += result.masked;
  }
  return { text: head + tail, masked };
}

function redactOutsidePlaceholders(
  text: string,
  options: ExternalRedactionOptions,
): { readonly text: string; readonly findings: readonly EgressRedactionFinding[] } {
  let out = "";
  let last = 0;
  let findings: readonly EgressRedactionFinding[] = [];
  const redactSegment = (segment: string) => {
    const result = redactForExternalText(segment, options);
    for (const finding of result.findings)
      findings = withFinding(findings, finding.kind, finding.count);
    out += encodedPlaceholders(result.text);
  };
  for (const match of text.matchAll(ENCODED_PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (!isPlaceholder(match[0])) continue;
    redactSegment(text.slice(last, index));
    out += match[0];
    last = index + match[0].length;
  }
  redactSegment(text.slice(last));
  return { text: out, findings };
}

function withFinding(
  findings: readonly EgressRedactionFinding[],
  kind: EgressRedactionKind,
  count: number,
): readonly EgressRedactionFinding[] {
  if (count === 0) return findings;
  const counts = new Map(findings.map((finding) => [finding.kind, finding.count]));
  counts.set(kind, (counts.get(kind) ?? 0) + count);
  return Object.freeze(
    EGRESS_REDACTION_KINDS.flatMap((entry) => {
      const value = counts.get(entry);
      return value === undefined ? [] : [Object.freeze({ kind: entry, count: value })];
    }),
  );
}

export function redactForExternalUrl(
  input: string,
  options: ExternalRedactionOptions = {},
): EgressRedaction {
  const known = options.known ?? new Map<string, string>();
  const tag = options.tag ?? sequentialPlaceholderTag();
  const shared = { tag, known };
  const userInfo = withoutUserInfo(encodedPlaceholders(input));
  const parameters = withoutSensitiveParameters(userInfo.text, tag, known);
  const rest = redactOutsidePlaceholders(parameters.text, shared);
  return Object.freeze({
    text: rest.text,
    findings: withFinding(
      rest.findings,
      "password",
      parameters.masked + (userInfo.removed ? 1 : 0),
    ),
  });
}
