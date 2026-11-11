import { currencyExponent, type MailAmount, MISSING_AMOUNT } from "./amount.js";
import type { RuleGate } from "./field-catalog.js";
import { compileRuleExpression, type RuleFacts } from "./rule-expression.js";

export type RuleOutcome = "raise_floor" | "suppress_push" | "defer_to_quiet_hours";
export type RuleOrigin = "built_in" | "owner_setting";
export type RuleStatus = "active" | "retired";

export interface RuleExample {
  readonly facts: RuleFacts;
  readonly hit: boolean;
}

export interface RuleRecord {
  readonly id: string;
  readonly revision: number;
  readonly gate: RuleGate;
  readonly expression: string;
  readonly outcome: RuleOutcome;
  readonly origin: RuleOrigin;
  readonly source: string;
  readonly status: RuleStatus;
  readonly examples: readonly RuleExample[];
}

export const RULE_IDS = Object.freeze({
  importantSender: "floor_important_sender",
  publicDomain: "floor_public_domain",
  moneyWords: "floor_money_words",
  quietHours: "quiet_hours",
  amountThreshold: "suppress_small_amount",
} as const);

export type RuleId = (typeof RULE_IDS)[keyof typeof RULE_IDS];

export interface QuietPeriod {
  readonly days: readonly number[];
  readonly start: string;
  readonly end: string;
}

const PUBLIC_DOMAIN_SUFFIXES = Object.freeze(["go.jp", "lg.jp", "ac.jp", "ed.jp"]);

const MONEY_SUBSTRINGS = Object.freeze([
  "收费",
  "扣款",
  "入账",
  "付款",
  "退款",
  "账单",
  "缴费",
  "汇款",
  "转账",
  "还款",
  "发票",
  "請求",
  "引落",
  "引き落とし",
  "振込",
  "振り込み",
  "入金",
  "返金",
  "支払",
  "料金",
  "決済",
  "ご利用代金",
]);

const MONEY_WORDS = Object.freeze([
  "invoice",
  "payment",
  "refund",
  "billing",
  "bill",
  "charge",
  "charged",
  "receipt",
  "statement",
]);

export function celString(value: string): string {
  return JSON.stringify(value);
}

export function celStringList(values: readonly string[]): string {
  return `[${values.map(celString).join(", ")}]`;
}

function senderFacts(
  address: string,
  domain: string,
  text = "",
  words: readonly string[] = [],
  amount: MailAmount = MISSING_AMOUNT,
) {
  return {
    sender_address: address,
    sender_domain: domain,
    text,
    text_words: words,
    amount_state: amount.state,
    amount_minor: amount.state === "known" ? amount.minor : 0,
    amount_currency: amount.state === "missing" ? "" : amount.currency,
  };
}

function foldCase(word: string): string {
  return word.replaceAll("\u017f", "s").replaceAll("\u212a", "k").toLowerCase();
}

export function mailItemFacts(
  item: {
    readonly fromAddress: string;
    readonly subject: string;
    readonly snippet: string;
  },
  amount: MailAmount = MISSING_AMOUNT,
): RuleFacts {
  const address = item.fromAddress.toLowerCase();
  const text = `${item.subject}\n${item.snippet}`;
  return senderFacts(
    address,
    address.slice(address.lastIndexOf("@") + 1),
    text,
    (text.match(/[a-z0-9_]+/giu) ?? []).map(foldCase),
    amount,
  );
}

export const BUILT_IN_RULES: readonly RuleRecord[] = Object.freeze([
  Object.freeze({
    id: RULE_IDS.publicDomain,
    revision: 1,
    gate: "mail_item",
    expression: `${celStringList(PUBLIC_DOMAIN_SUFFIXES)}.exists(suffix, sender_domain == suffix || sender_domain.endsWith("." + suffix))`,
    outcome: "raise_floor",
    origin: "built_in",
    source: "ADR 0106 第 4 条；ADR 0209",
    status: "active",
    examples: Object.freeze([
      Object.freeze({ facts: senderFacts("a@city.tokyo.lg.jp", "city.tokyo.lg.jp"), hit: true }),
      Object.freeze({ facts: senderFacts("a@go.jp", "go.jp"), hit: true }),
      Object.freeze({ facts: senderFacts("a@ago.jp", "ago.jp"), hit: false }),
      Object.freeze({ facts: senderFacts("a@example.com", "example.com"), hit: false }),
    ]),
  }),
  Object.freeze({
    id: RULE_IDS.moneyWords,
    revision: 1,
    gate: "mail_item",
    expression: `${celStringList(MONEY_SUBSTRINGS)}.exists(word, text.contains(word)) || ${celStringList(MONEY_WORDS)}.exists(word, word in text_words)`,
    outcome: "raise_floor",
    origin: "built_in",
    source: "ADR 0106 第 4 条；ADR 0209",
    status: "active",
    examples: Object.freeze([
      Object.freeze({
        facts: mailItemFacts({
          fromAddress: "a@b.com",
          subject: "Your Invoice is ready",
          snippet: "",
        }),
        hit: true,
      }),
      Object.freeze({
        facts: mailItemFacts({
          fromAddress: "a@b.com",
          subject: "クレジットの引落のお知らせ",
          snippet: "",
        }),
        hit: true,
      }),
      Object.freeze({
        facts: mailItemFacts({ fromAddress: "a@b.com", subject: "本月账单", snippet: "" }),
        hit: true,
      }),
      Object.freeze({
        facts: mailItemFacts({
          fromAddress: "a@b.com",
          subject: "billingual newsletter",
          snippet: "",
        }),
        hit: false,
      }),
      Object.freeze({
        facts: mailItemFacts({
          fromAddress: "a@b.com",
          subject: "Lunch on Friday",
          snippet: "see you",
        }),
        hit: false,
      }),
    ]),
  }),
]);

export function importantSenderExpression(senders: readonly string[]): string {
  const entries = [
    ...new Set(
      senders
        .filter((entry) => !/\p{Surrogate}/u.test(entry))
        .map((entry) => entry.trim().toLowerCase().replace(/^@/u, ""))
        .filter((entry) => entry.length > 0),
    ),
  ];
  if (entries.length === 0) return "false";
  const addresses = entries.filter((entry) => entry.includes("@"));
  const domains = entries.filter((entry) => !entry.includes("@"));
  const parts: string[] = [];
  if (addresses.length > 0) parts.push(`sender_address in ${celStringList(addresses)}`);
  if (domains.length > 0)
    parts.push(
      `${celStringList(domains)}.exists(entry, sender_domain == entry || sender_domain.endsWith("." + entry))`,
    );
  return parts.join(" || ");
}

export function importantSenderRule(senders: readonly string[], revision: number): RuleRecord {
  return Object.freeze({
    id: RULE_IDS.importantSender,
    revision,
    gate: "mail_item",
    expression: importantSenderExpression(senders),
    outcome: "raise_floor",
    origin: "owner_setting",
    source: "ADR 0106 第 4 条；主人的设置“重要发件人”",
    status: "active",
    examples: Object.freeze([]),
  });
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function quietPeriodExpression(period: QuietPeriod): string {
  const start = clockMinutes(period.start);
  const stop = clockMinutes(period.end);
  const days = celIntList(period.days);
  if (start === stop) return "false";
  if (start < stop)
    return `local_weekday in ${days} && local_minutes >= ${start} && local_minutes < ${stop}`;
  return `(local_weekday in ${days} && local_minutes >= ${start}) || (local_previous_weekday in ${days} && local_minutes < ${stop})`;
}

function celIntList(values: readonly number[]): string {
  return `[${[...values].sort((left, right) => left - right).join(", ")}]`;
}

export function quietHoursExpression(periods: readonly QuietPeriod[]): string {
  if (periods.length === 0) return "false";
  return periods.map((period) => `(${quietPeriodExpression(period)})`).join(" || ");
}

export function quietHoursRule(periods: readonly QuietPeriod[], revision: number): RuleRecord {
  return Object.freeze({
    id: RULE_IDS.quietHours,
    revision,
    gate: "mail_delivery",
    expression: quietHoursExpression(periods),
    outcome: "defer_to_quiet_hours",
    origin: "owner_setting",
    source: "ADR 0106；主人的设置“静默时段”",
    status: "active",
    examples: Object.freeze([]),
  });
}

export interface AmountThresholdParameters {
  readonly currency: string;
  readonly minor: number;
}

export function amountThresholdExpression(parameters: AmountThresholdParameters): string {
  if (
    !/^[A-Z]{3}$/u.test(parameters.currency) ||
    currencyExponent(parameters.currency) === undefined
  )
    throw new Error("金额门槛的币种不在币种表里");
  if (!Number.isSafeInteger(parameters.minor) || parameters.minor < 0)
    throw new Error("金额门槛必须是不小于 0 的整数");
  return `amount_state == "known" && amount_currency == ${celString(parameters.currency)} && amount_minor < ${parameters.minor}`;
}

export function amountThresholdRule(
  parameters: AmountThresholdParameters,
  revision: number,
  source: string,
): RuleRecord {
  const known = (minor: number, currency = parameters.currency) =>
    mailItemFacts(
      { fromAddress: "a@b.com", subject: "x", snippet: "" },
      { state: "known", minor, currency },
    );
  const other = parameters.currency === "USD" ? "JPY" : "USD";
  const examples: RuleExample[] = [
    { facts: known(Math.max(0, parameters.minor - 1)), hit: parameters.minor > 0 },
    { facts: known(parameters.minor), hit: false },
    { facts: known(parameters.minor + 1), hit: false },
    { facts: known(0, other), hit: false },
    {
      facts: mailItemFacts(
        { fromAddress: "a@b.com", subject: "x", snippet: "" },
        { state: "uncertain", minor: 0, currency: parameters.currency },
      ),
      hit: false,
    },
    { facts: mailItemFacts({ fromAddress: "a@b.com", subject: "x", snippet: "" }), hit: false },
  ];
  return Object.freeze({
    id: RULE_IDS.amountThreshold,
    revision,
    gate: "mail_item",
    expression: amountThresholdExpression(parameters),
    outcome: "suppress_push",
    origin: "owner_setting",
    source,
    status: "active",
    examples: Object.freeze(examples.map((example) => Object.freeze(example))),
  });
}

const GATE_OUTCOMES: Readonly<Record<RuleGate, readonly RuleOutcome[]>> = Object.freeze({
  mail_item: Object.freeze(["raise_floor", "suppress_push"] as const),
  mail_delivery: Object.freeze(["defer_to_quiet_hours"] as const),
});

export function assertRuleShape(rule: RuleRecord): void {
  if (!GATE_OUTCOMES[rule.gate].includes(rule.outcome))
    throw new Error(`规则 ${rule.id} 的结果 ${rule.outcome} 不能用在闸门 ${rule.gate} 上`);
  const bare = rule.expression.replace(/"(?:[^"\\]|\\.)*"/gu, '""');
  if (
    /\bamount_(?:minor|currency)\b/u.test(bare) &&
    !/\bamount_state\s*==\s*"known"/u.test(rule.expression)
  )
    throw new Error(
      `规则 ${rule.id} 用了金额却没有要求 amount_state == "known"，金额读不出来时会误判`,
    );
}

export function assertRuleExamples(rule: RuleRecord): void {
  assertRuleShape(rule);
  const compiled = compileRuleExpression(rule.gate, rule.expression);
  for (const example of rule.examples) {
    if (compiled.evaluate(example.facts) !== example.hit)
      throw new Error(`规则 ${rule.id} 的例子不符：${JSON.stringify(example.facts)}`);
  }
}

export interface OwnerRuleSettings {
  readonly quietHours: readonly QuietPeriod[];
  readonly quietHoursRevision: number;
  readonly importantSenders: readonly string[];
  readonly importantSendersRevision: number;
}

export function ruleBookFor(settings: OwnerRuleSettings): readonly RuleRecord[] {
  const [publicDomain, moneyWords] = BUILT_IN_RULES;
  if (!publicDomain || !moneyWords) throw new Error("内置规则缺失");
  return Object.freeze([
    importantSenderRule(settings.importantSenders, settings.importantSendersRevision),
    publicDomain,
    moneyWords,
    quietHoursRule(settings.quietHours, settings.quietHoursRevision),
  ]);
}
