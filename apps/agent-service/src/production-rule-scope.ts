import { type RuleScopeVerdict, zonedTime } from "@himawari-agent/application";

export const RULE_SCOPE_DEFAULT_MAX_DAYS = 366;
export const RULE_SCOPE_AGREEMENT_MS = 3_600_000;
export const RULE_SCOPE_CONTEXT_CHARACTERS = 2_000;

export type RuleScope =
  | { readonly kind: "standing" }
  | { readonly kind: "until"; readonly expiresAt: string };

export interface RuleScopeVerifierInput {
  readonly quote: string;
  readonly context: string;
  readonly now: string;
  readonly timeZone: string;
}

export interface RuleScopeVerifier {
  verify(input: RuleScopeVerifierInput): Promise<RuleScopeVerdict | undefined>;
}

export type ScopeOutcome =
  | { readonly kind: "activate"; readonly expiresAt: string | null }
  | { readonly kind: "propose"; readonly expiresAt: string | null }
  | { readonly kind: "ask"; readonly reason: "this_item" | "unclear" | "mismatch" };

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

export function localToInstant(local: string, timeZone: string): string | undefined {
  const match = LOCAL_TIME.exec(local);
  if (!match) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (hour > 23 || minute > 59 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1) return undefined;
  try {
    return zonedTime({ year, month, day }, hour * 60 + minute, timeZone);
  } catch {
    return undefined;
  }
}

export function withinScopeLimit(expiresAt: string, now: string, maxDays: number): boolean {
  const time = Date.parse(expiresAt);
  const start = Date.parse(now);
  return Number.isFinite(time) && time > start && time <= start + maxDays * 86_400_000;
}

export function parseRuleScope(
  raw: unknown,
  input: { readonly now: string; readonly timeZone: string; readonly maxDays: number },
): RuleScope | undefined {
  if (raw === undefined || raw === null) return { kind: "standing" };
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record["kind"] === "standing")
    return Object.keys(record).every((key) => key === "kind") ? { kind: "standing" } : undefined;
  if (record["kind"] !== "until" || typeof record["until"] !== "string") return undefined;
  if (Object.keys(record).some((key) => key !== "kind" && key !== "until")) return undefined;
  const expiresAt = localToInstant(record["until"], input.timeZone);
  if (!expiresAt || !withinScopeLimit(expiresAt, input.now, input.maxDays)) return undefined;
  return { kind: "until", expiresAt };
}

export function reconcileScope(input: {
  readonly main: RuleScope;
  readonly inferred: boolean;
  readonly ownerSaid: boolean;
  readonly verifier: RuleScopeVerifier | undefined;
  readonly verdict: RuleScopeVerdict | undefined;
  readonly now: string;
  readonly maxDays: number;
}): ScopeOutcome {
  const mainExpiry = input.main.kind === "until" ? input.main.expiresAt : null;
  if (input.inferred || !input.ownerSaid) return { kind: "propose", expiresAt: mainExpiry };
  if (!input.verifier) return { kind: "activate", expiresAt: mainExpiry };
  const { verdict } = input;
  if (!verdict) return { kind: "propose", expiresAt: mainExpiry };
  if (verdict.scope === "this_item") return { kind: "ask", reason: "this_item" };
  if (verdict.scope === "unclear") return { kind: "ask", reason: "unclear" };
  if (verdict.scope === "standing")
    return input.main.kind === "standing"
      ? { kind: "activate", expiresAt: null }
      : { kind: "ask", reason: "mismatch" };
  if (input.main.kind !== "until") return { kind: "ask", reason: "mismatch" };
  if (verdict.until === null) return { kind: "activate", expiresAt: mainExpiry };
  if (!withinScopeLimit(verdict.until, input.now, input.maxDays))
    return { kind: "propose", expiresAt: mainExpiry };
  const gap = Math.abs(Date.parse(verdict.until) - Date.parse(input.main.expiresAt));
  if (gap > RULE_SCOPE_AGREEMENT_MS) return { kind: "ask", reason: "mismatch" };
  return {
    kind: "activate",
    expiresAt: new Date(
      Math.min(Date.parse(verdict.until), Date.parse(input.main.expiresAt)),
    ).toISOString(),
  };
}

export function scopeContext(text: string, quote: string): string {
  const characters = Array.from(text);
  const limit = RULE_SCOPE_CONTEXT_CHARACTERS;
  if (characters.length <= limit * 2) return text;
  const index = text.indexOf(quote);
  const center = index < 0 ? 0 : Array.from(text.slice(0, index)).length;
  const start = Math.max(0, center - limit);
  return characters.slice(start, center + Array.from(quote).length + limit).join("");
}

export function describeExpiry(expiresAt: string | null, timeZone: string): string {
  if (expiresAt === null) return "长期";
  const text = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(expiresAt));
  return `到 ${text} 为止`;
}
