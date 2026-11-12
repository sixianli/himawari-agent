export const RULE_SCOPE_VERDICTS = ["standing", "until", "this_item", "unclear"] as const;
export type RuleScopeVerdictKind = (typeof RULE_SCOPE_VERDICTS)[number];

export interface RuleScopeVerdict {
  readonly scope: RuleScopeVerdictKind;
  readonly until: string | null;
  readonly evidence: string | null;
}

const MAX_EVIDENCE = 200;

function unfenced(output: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/u.exec(output);
  return (fenced?.[1] ?? output).trim();
}

export function parseRuleScopeVerdict(output: string, quote: string): RuleScopeVerdict | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced(output));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const scope = record["scope"];
  if (!(RULE_SCOPE_VERDICTS as readonly unknown[]).includes(scope)) return undefined;
  const until = record["until"] ?? null;
  const evidence = record["evidence"] ?? null;
  let instant: string | null = null;
  if (until !== null) {
    if (typeof until !== "string" || !Number.isFinite(Date.parse(until))) return undefined;
    if (!/(Z|[+-]\d{2}:\d{2})$/u.test(until)) return undefined;
    instant = new Date(until).toISOString();
  }
  if (evidence !== null) {
    if (
      typeof evidence !== "string" ||
      evidence.trim().length === 0 ||
      evidence.length > MAX_EVIDENCE ||
      !quote.includes(evidence)
    )
      return undefined;
  }
  return Object.freeze({
    scope: scope as RuleScopeVerdictKind,
    until: instant,
    evidence,
  });
}
