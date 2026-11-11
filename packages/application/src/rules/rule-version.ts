import {
  type AmountThresholdParameters,
  amountThresholdRule,
  BUILT_IN_RULE_VALUES,
  BUILT_IN_RULES,
  importantSenderRule,
  type QuietPeriod,
  quietHoursRule,
  RULE_IDS,
  type RuleOrigin,
  type RuleRecord,
  type RuleStatus,
  runRuleExamples,
} from "./rule-book.js";
import type { RuleBookVersion, RuleRef } from "./rule-ref.js";
import { OWNER_RULE_ID_PREFIX, ownerRuleRecord } from "./rule-types.js";

export const RULE_KINDS = [
  "important_sender",
  "public_domain",
  "money_words",
  "quiet_hours",
  "amount_threshold",
  "mail_must_notify",
  "mail_read_whole_thread",
  "push_quiet_hours",
  "unknown",
] as const;

const OWNER_RULE_KINDS: readonly RuleKind[] = [
  "mail_must_notify",
  "mail_read_whole_thread",
  "push_quiet_hours",
];

export type RuleKind = (typeof RULE_KINDS)[number];

const KIND_BY_ID: Readonly<Record<string, RuleKind>> = Object.freeze({
  [RULE_IDS.importantSender]: "important_sender",
  [RULE_IDS.publicDomain]: "public_domain",
  [RULE_IDS.moneyWords]: "money_words",
  [RULE_IDS.quietHours]: "quiet_hours",
  [RULE_IDS.amountThreshold]: "amount_threshold",
});

export function ruleKindOf(ruleId: string): RuleKind {
  return Object.hasOwn(KIND_BY_ID, ruleId) ? (KIND_BY_ID[ruleId] ?? "unknown") : "unknown";
}

export type RuleTestState = "passed" | "failed" | "none" | "unavailable";

export interface RuleTestStatus {
  readonly state: RuleTestState;
  readonly total: number;
  readonly failedAt: number | null;
}

export interface RuleWording {
  readonly values: readonly string[];
  readonly quietHours: readonly QuietPeriod[];
  readonly amount: AmountThresholdParameters | null;
}

export interface RuleVersionView {
  readonly ruleId: string;
  readonly revision: number | null;
  readonly current: boolean;
  readonly kind: RuleKind;
  readonly origin: RuleOrigin | null;
  readonly source: string | null;
  readonly status: RuleStatus | null;
  readonly changedAt: string | null;
  readonly sourceMemoryId: string | null;
  readonly wording: RuleWording | null;
  readonly tests: RuleTestStatus;
}

const UNAVAILABLE: RuleTestStatus = Object.freeze({
  state: "unavailable",
  total: 0,
  failedAt: null,
});

function stringList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function quietPeriods(value: unknown): readonly QuietPeriod[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const periods: QuietPeriod[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return undefined;
    const { days, start, end } = item as Record<string, unknown>;
    if (
      !Array.isArray(days) ||
      !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) ||
      typeof start !== "string" ||
      typeof end !== "string"
    )
      return undefined;
    periods.push(Object.freeze({ days: Object.freeze([...days]), start, end }));
  }
  return Object.freeze(periods);
}

function amountParameters(value: Readonly<Record<string, unknown>>) {
  const { currency, minor } = value;
  return typeof currency === "string" && typeof minor === "number"
    ? Object.freeze({ currency, minor })
    : undefined;
}

function rebuild(
  kind: RuleKind,
  revision: number,
  stored: RuleBookVersion | undefined,
): { readonly rule: RuleRecord; readonly wording: RuleWording } | undefined {
  const empty = { values: [], quietHours: [], amount: null };
  if (kind === "public_domain" || kind === "money_words") {
    const rule = BUILT_IN_RULES.find(
      (candidate) =>
        candidate.id === (kind === "public_domain" ? RULE_IDS.publicDomain : RULE_IDS.moneyWords),
    );
    if (!rule || rule.revision !== revision) return undefined;
    return { rule, wording: { ...empty, values: BUILT_IN_RULE_VALUES[rule.id] ?? [] } };
  }
  if (!stored) return undefined;
  if (OWNER_RULE_KINDS.includes(kind)) {
    try {
      const rule = ownerRuleRecord({
        ruleId: stored.ruleId,
        revision,
        status: stored.status,
        source: "ADR 0213；主人在对话里说的一句话",
        parameters: stored.parameters,
      });
      const summary = stored.parameters["summary"];
      const params = stored.parameters["params"];
      const periods =
        kind === "push_quiet_hours" && typeof params === "object" && params !== null
          ? quietPeriods((params as Record<string, unknown>)["periods"])
          : undefined;
      return {
        rule,
        wording: {
          ...empty,
          values: typeof summary === "string" ? [summary] : [],
          quietHours: periods ?? [],
        },
      };
    } catch {
      return undefined;
    }
  }
  if (kind === "important_sender") {
    const senders = stringList(stored.parameters["senders"]);
    if (!senders) return undefined;
    return {
      rule: importantSenderRule(senders, revision),
      wording: { ...empty, values: senders },
    };
  }
  if (kind === "quiet_hours") {
    const periods = quietPeriods(stored.parameters["periods"]);
    if (!periods) return undefined;
    return {
      rule: quietHoursRule(periods, revision),
      wording: { ...empty, quietHours: periods },
    };
  }
  if (kind === "amount_threshold") {
    const amount = amountParameters(stored.parameters);
    if (!amount) return undefined;
    try {
      return {
        rule: amountThresholdRule(amount, revision, "amount"),
        wording: { ...empty, amount },
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function testStatus(rule: RuleRecord): RuleTestStatus {
  try {
    const run = runRuleExamples(rule);
    if (run.total === 0) return Object.freeze({ state: "none", total: 0, failedAt: null });
    return Object.freeze({
      state: run.failedAt === null ? "passed" : "failed",
      total: run.total,
      failedAt: run.failedAt,
    });
  } catch {
    return UNAVAILABLE;
  }
}

function ownerRuleKind(ruleId: string, stored: RuleBookVersion | undefined): RuleKind | undefined {
  if (!ruleId.startsWith(OWNER_RULE_ID_PREFIX)) return undefined;
  const type = stored?.parameters["type"];
  return OWNER_RULE_KINDS.find((kind) => kind === type) ?? "unknown";
}

export function describeRuleVersion(
  ref: RuleRef,
  stored: RuleBookVersion | undefined,
): RuleVersionView {
  const kind = ownerRuleKind(ref.ruleId, stored) ?? ruleKindOf(ref.ruleId);
  const builtIn = kind === "public_domain" || kind === "money_words";
  const revision = ref.revision ?? stored?.revision ?? (builtIn ? 1 : null);
  const rebuilt = revision === null ? undefined : rebuild(kind, revision, stored);
  return Object.freeze({
    ruleId: ref.ruleId,
    revision,
    current: ref.revision === null && rebuilt !== undefined,
    kind,
    origin: rebuilt?.rule.origin ?? null,
    source: rebuilt?.rule.source ?? null,
    status: builtIn && rebuilt ? "active" : (stored?.status ?? null),
    changedAt: stored?.changedAt ?? null,
    sourceMemoryId: stored?.sourceMemoryId ?? null,
    wording: rebuilt?.wording ?? null,
    tests: rebuilt ? testStatus(rebuilt.rule) : UNAVAILABLE,
  });
}
