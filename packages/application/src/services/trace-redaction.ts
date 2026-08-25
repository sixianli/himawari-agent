import type { JsonValue } from "../ports/common.js";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEYS = new Set([
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

function redactString(value: string, sensitiveLiterals: readonly string[]): string {
  let result = value;
  for (const literal of sensitiveLiterals) {
    if (literal.length > 0) result = result.split(literal).join(REDACTED);
  }

  if (!/^https?:\/\//i.test(result)) return result;

  try {
    const url = new URL(result);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEYS.has(normalizedKey(key))) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    return result;
  }
}

function visit(
  value: unknown,
  sensitiveLiterals: readonly string[],
  active: WeakSet<object>,
): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return redactString(value, sensitiveLiterals);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Trace payload contains a non-finite number");
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`Trace payload contains unsupported ${typeof value}`);
  }

  if (active.has(value)) throw new TypeError("Trace payload contains a cycle");
  active.add(value);

  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) return [...value];
    if (value instanceof Error) {
      return {
        name: redactString(value.name, sensitiveLiterals),
        message: redactString(value.message, sensitiveLiterals),
        ...(value.stack ? { stack: redactString(value.stack, sensitiveLiterals) } : {}),
      };
    }
    if (Array.isArray(value)) {
      return value.map((entry) => visit(entry, sensitiveLiterals, active));
    }

    const result: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = SENSITIVE_KEYS.has(normalizedKey(key))
        ? REDACTED
        : visit(nested, sensitiveLiterals, active);
    }
    return result;
  } finally {
    active.delete(value);
  }
}

export function redactTracePayload(
  value: unknown,
  sensitiveLiterals: readonly string[] = [],
): JsonValue {
  return visit(value, sensitiveLiterals, new WeakSet());
}
