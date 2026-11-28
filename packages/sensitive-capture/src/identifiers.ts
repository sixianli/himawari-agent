import { redactForEgress } from "./redaction.js";

const RESTRICTED_IDENTIFIER =
  /(?<![0-9])(?:[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]|[0-9]{16,19})(?![0-9])/u;

export function containsRestrictedIdentifier(text: string): boolean {
  return RESTRICTED_IDENTIFIER.test(text.replace(/[\s-]/gu, ""));
}

const CREDENTIAL_KINDS: ReadonlySet<string> = new Set([
  "machine-secret",
  "password",
  "verification-code",
]);

export function containsCredential(text: string): boolean {
  return redactForEgress(text).findings.some(({ kind }) => CREDENTIAL_KINDS.has(kind));
}

const SENSITIVE_QUERY_PARAMETER = /token|key|secret|password|signature|credential/i;
const SENSITIVE_FIELD_NAME = /authorization|cookie|token|api.?key|secret|password|credential/i;

export function isSensitiveQueryParameter(name: string): boolean {
  return SENSITIVE_QUERY_PARAMETER.test(name);
}

export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_FIELD_NAME.test(name);
}

const SENSITIVE_TRACE_KEYS = new Set([
  "apikey",
  "key",
  "token",
  "accesstoken",
  "refreshtoken",
  "password",
  "secret",
  "secretvalue",
  "clientsecret",
  "credential",
  "credentials",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "privatekey",
  "signature",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveTraceKey(key: string): boolean {
  return SENSITIVE_TRACE_KEYS.has(normalizedKey(key));
}
