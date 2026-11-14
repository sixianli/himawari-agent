export interface RuleRef {
  readonly ruleId: string;
  readonly revision: number | null;
}

export function ruleRef(ruleId: string, revision: number): string {
  if (ruleId.length > 240) throw new RangeError("Rule id is longer than 240 characters");
  return `${ruleId}@${revision}`;
}

export function parseRuleRef(value: string): RuleRef {
  const at = value.lastIndexOf("@");
  const revision = at > 0 ? value.slice(at + 1) : "";
  if (/^(0|[1-9]\d{0,8})$/u.test(revision))
    return Object.freeze({ ruleId: value.slice(0, at), revision: Number(revision) });
  return Object.freeze({ ruleId: value, revision: null });
}

export interface RuleBookVersion {
  readonly ruleId: string;
  readonly revision: number;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly status: "active" | "needs_review" | "suspended" | "retired";
  readonly sourceMemoryId: string | null;
  readonly changedAt: string | null;
}
