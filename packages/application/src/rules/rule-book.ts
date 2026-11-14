import type { DataClassification } from "../ports/common.js";
import { currencyExponent, type MailAmount, MISSING_AMOUNT, type MoneyState } from "./amount.js";
import { type RuleGate, ruleFields } from "./field-catalog.js";
import { compileRuleExpression, type RuleFacts } from "./rule-expression.js";

export type RuleOutcome =
  | "raise_floor"
  | "suppress_push"
  | "require_notify"
  | "require_whole_thread"
  | "defer_to_quiet_hours"
  | "allow_preauthorized"
  | "ask_owner"
  | "refuse";
export type RuleOrigin = "built_in" | "owner_setting";
export type RuleStatus = "active" | "needs_review" | "suspended" | "retired";

export function ruleIsEnforced(status: RuleStatus): boolean {
  return status === "active" || status === "needs_review";
}

export interface RuleExample {
  readonly facts: RuleFacts;
  readonly hit: boolean;
}

export interface RuleSharedParameters {
  readonly classification: Exclude<DataClassification, "restricted">;
  readonly values: Readonly<Record<string, unknown>>;
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
  readonly sharedParameters?: RuleSharedParameters;
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
  content = text,
  money: MoneyState = "unknown",
) {
  return {
    sender_address: address,
    sender_domain: domain,
    text,
    content_folded: foldText(content),
    text_words: words,
    content_words: [...new Set(foldText(content).match(/[a-z0-9_]+/gu) ?? [])],
    money_state: money,
    amount_state: amount.state,
    amount_minor: amount.state === "known" ? amount.minor : 0,
    amount_currency: amount.state === "missing" ? "" : amount.currency,
  };
}

export function foldText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function foldCase(word: string): string {
  return word.replaceAll("\u017f", "s").replaceAll("\u212a", "k").toLowerCase();
}

export function mailItemFacts(
  item: {
    readonly fromAddress: string;
    readonly subject: string;
    readonly snippet: string;
    readonly body?: string | null;
  },
  amount: MailAmount = MISSING_AMOUNT,
  money: MoneyState = "unknown",
): RuleFacts {
  const address = item.fromAddress.toLowerCase();
  const text = `${item.subject}\n${item.snippet}`;
  return senderFacts(
    address,
    address.slice(address.lastIndexOf("@") + 1),
    text,
    (text.match(/[a-z0-9_]+/giu) ?? []).map(foldCase),
    amount,
    `${item.subject}\n${item.body ?? item.snippet}`,
    money,
  );
}

export const BUILT_IN_RULE_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [RULE_IDS.publicDomain]: PUBLIC_DOMAIN_SUFFIXES,
});

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
    revision: 2,
    gate: "mail_item",
    expression: 'money_state == "yes"',
    outcome: "raise_floor",
    origin: "built_in",
    source: "ADR 0106 第 4 条；ADR 0209；ADR 0248",
    status: "active",
    examples: Object.freeze([
      Object.freeze({
        facts: mailItemFacts(
          { fromAddress: "a@b.com", subject: "Your Invoice is ready", snippet: "" },
          MISSING_AMOUNT,
          "yes",
        ),
        hit: true,
      }),
      Object.freeze({
        facts: mailItemFacts(
          { fromAddress: "a@b.com", subject: "クレジットの引落のお知らせ", snippet: "" },
          MISSING_AMOUNT,
          "yes",
        ),
        hit: true,
      }),
      Object.freeze({
        facts: mailItemFacts(
          { fromAddress: "a@b.com", subject: "billingual newsletter", snippet: "" },
          MISSING_AMOUNT,
          "no",
        ),
        hit: false,
      }),
      Object.freeze({
        facts: mailItemFacts(
          { fromAddress: "a@b.com", subject: "Lunch on Friday", snippet: "see you" },
          MISSING_AMOUNT,
          "no",
        ),
        hit: false,
      }),
      Object.freeze({
        facts: mailItemFacts(
          { fromAddress: "a@b.com", subject: "本月账单", snippet: "" },
          MISSING_AMOUNT,
          "unknown",
        ),
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
    examples: importantSenderExamples(senders),
    sharedParameters: Object.freeze({
      classification: "private",
      values: Object.freeze({ importantSenders: senders }),
    }),
  });
}

const EXAMPLE_PER_ENTRY = 3;
const MISS_DOMAIN = "himawari-rule-example.invalid";

function senderListed(entries: readonly string[], address: string): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return entries.some((entry) =>
    entry.includes("@") ? entry === address : domain === entry || domain.endsWith(`.${entry}`),
  );
}

function importantSenderExamples(senders: readonly string[]): readonly RuleExample[] {
  const entries = [
    ...new Set(
      senders
        .filter((entry) => !/\p{Surrogate}/u.test(entry))
        .map((entry) => entry.trim().toLowerCase().replace(/^@/u, ""))
        .filter((entry) => entry.length > 0),
    ),
  ];
  const addresses = new Set<string>();
  for (const entry of entries.slice(0, EXAMPLE_PER_ENTRY)) {
    if (entry.includes("@")) addresses.add(entry);
    else {
      addresses.add(`someone@${entry}`);
      addresses.add(`someone@mail.${entry}`);
    }
  }
  addresses.add(`someone@${MISS_DOMAIN}`);
  return Object.freeze(
    [...addresses].map((address) =>
      Object.freeze({
        facts: mailItemFacts({ fromAddress: address, subject: "x", snippet: "" }),
        hit: senderListed(entries, address),
      }),
    ),
  );
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
    examples: quietHoursExamples(periods),
    sharedParameters: Object.freeze({
      classification: "private",
      values: Object.freeze({ quietHours: periods }),
    }),
  });
}

const MINUTES_PER_DAY = 24 * 60;

function inQuietPeriod(period: QuietPeriod, weekday: number, minutes: number): boolean {
  const start = clockMinutes(period.start);
  const stop = clockMinutes(period.end);
  if (start === stop) return false;
  if (start < stop) return period.days.includes(weekday) && minutes >= start && minutes < stop;
  return (
    (period.days.includes(weekday) && minutes >= start) ||
    (period.days.includes((weekday + 6) % 7) && minutes < stop)
  );
}

function quietHoursExamples(periods: readonly QuietPeriod[]): readonly RuleExample[] {
  const moments = new Map<string, { readonly weekday: number; readonly minutes: number }>();
  const add = (weekday: number, minutes: number) => {
    const day = (weekday + Math.floor(minutes / MINUTES_PER_DAY) + 7) % 7;
    const minute = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    moments.set(`${day}:${minute}`, { weekday: day, minutes: minute });
  };
  for (const period of periods.slice(0, 8)) {
    const day = period.days[0];
    if (day === undefined) continue;
    const start = clockMinutes(period.start);
    const stop = clockMinutes(period.end);
    const end = stop > start ? stop : stop + MINUTES_PER_DAY;
    add(day, start);
    add(day, start - 1);
    add(day, end - 1);
    add(day, end);
  }
  if (moments.size === 0) add(0, 12 * 60);
  return Object.freeze(
    [...moments.values()].map(({ weekday, minutes }) =>
      Object.freeze({
        facts: {
          local_minutes: minutes,
          local_weekday: weekday,
          local_previous_weekday: (weekday + 6) % 7,
        },
        hit: periods.some((period) => inQuietPeriod(period, weekday, minutes)),
      }),
    ),
  );
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
  if (
    !Number.isSafeInteger(parameters.minor) ||
    parameters.minor < 0 ||
    parameters.minor >= Number.MAX_SAFE_INTEGER
  )
    throw new Error("金额门槛必须是不小于 0、小于安全整数上限的整数");
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
  mail_item: Object.freeze([
    "raise_floor",
    "suppress_push",
    "require_notify",
    "require_whole_thread",
  ] as const),
  mail_delivery: Object.freeze(["defer_to_quiet_hours"] as const),
  action: Object.freeze(["allow_preauthorized", "ask_owner", "refuse"] as const),
});

const AMOUNT_FIELD_NAMES: readonly string[] = ruleFields("mail_item")
  .map(({ name }) => name)
  .filter((name) => name.startsWith("amount_"));
const AMOUNT_FIELD = new RegExp(`\\b(?:${AMOUNT_FIELD_NAMES.join("|")})\\b`, "u");
const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/gu;

export function usesAmountFields(rule: Pick<RuleRecord, "expression">): boolean {
  return AMOUNT_FIELD.test(rule.expression.replace(STRING_LITERAL, '""'));
}

export function assertRuleShape(rule: RuleRecord): void {
  if (!GATE_OUTCOMES[rule.gate].includes(rule.outcome))
    throw new Error(`规则 ${rule.id} 的结果 ${rule.outcome} 不能用在闸门 ${rule.gate} 上`);
}

export interface RuleExampleRun {
  readonly total: number;
  readonly failedAt: number | null;
}

export function runRuleExamples(rule: RuleRecord): RuleExampleRun {
  assertRuleShape(rule);
  const compiled = compileRuleExpression(rule.gate, rule.expression);
  const failed = rule.examples.findIndex(
    (example) => compiled.evaluate(example.facts) !== example.hit,
  );
  return Object.freeze({ total: rule.examples.length, failedAt: failed < 0 ? null : failed + 1 });
}

export function assertRuleExamples(rule: RuleRecord): void {
  const run = runRuleExamples(rule);
  if (run.failedAt !== null)
    throw new Error(
      `规则 ${rule.id} 的例子不符：${JSON.stringify(rule.examples[run.failedAt - 1]?.facts)}`,
    );
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
