import type { RuleGate } from "./field-catalog.js";
import { compileRuleExpression, type RuleFacts } from "./rule-expression.js";

export type RuleOutcome = "raise_floor" | "defer_to_quiet_hours";
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

function senderFacts(address: string, domain: string, text = "", words: readonly string[] = []) {
  return { sender_address: address, sender_domain: domain, text, text_words: words };
}

function foldCase(word: string): string {
  return word.replaceAll("\u017f", "s").replaceAll("\u212a", "k").toLowerCase();
}

export function mailItemFacts(item: {
  readonly fromAddress: string;
  readonly subject: string;
  readonly snippet: string;
}): RuleFacts {
  const address = item.fromAddress.toLowerCase();
  const text = `${item.subject}\n${item.snippet}`;
  return senderFacts(
    address,
    address.slice(address.lastIndexOf("@") + 1),
    text,
    (text.match(/[a-z0-9_]+/giu) ?? []).map(foldCase),
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

export function assertRuleExamples(rule: RuleRecord): void {
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
