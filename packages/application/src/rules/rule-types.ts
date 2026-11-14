import type { RuleGate } from "./field-catalog.js";
import {
  assertRuleExamples,
  celStringList,
  foldText,
  mailItemFacts,
  type QuietPeriod,
  quietHoursExamples,
  quietHoursExpression,
  type RuleExample,
  type RuleOutcome,
  type RuleRecord,
  type RuleStatus,
  ruleIsEnforced,
} from "./rule-book.js";

export const OWNER_RULE_ID_PREFIX = "owner:";
export const OWNER_RULE_LIST_LIMIT = 32;
export const OWNER_RULE_ENTRY_LIMIT = 64;
export const OWNER_RULE_SUMMARY_LIMIT = 200;
export const OWNER_RULE_STORED_LIMIT = 16_384;

export type RuleTypeErrorCode =
  | "RULE_TYPE_UNKNOWN"
  | "RULE_TYPE_UNTESTED"
  | "RULE_PARAMETERS_INVALID"
  | "RULE_ID_INVALID";

export class RuleTypeError extends Error {
  readonly code: RuleTypeErrorCode;

  constructor(code: RuleTypeErrorCode, message: string) {
    super(message);
    this.name = "RuleTypeError";
    this.code = code;
  }
}

export interface MailMatchParameters {
  readonly senderDomains: readonly string[];
  readonly senderAddresses: readonly string[];
  readonly phrases: readonly string[];
  readonly words: readonly string[];
  readonly excludePhrases: readonly string[];
}

export const PUSH_QUIET_CLASSES = ["scheduled_reminder", "run_result", "mail_reminder"] as const;
export type PushQuietClass = (typeof PUSH_QUIET_CLASSES)[number];
export const PUSH_QUIET_DEFAULT_CLASSES: readonly PushQuietClass[] = Object.freeze([
  "mail_reminder",
  "run_result",
]);
const PUSH_QUIET_PERIOD_LIMIT = 8;

export interface PushQuietParameters {
  readonly periods: readonly QuietPeriod[];
  readonly classes: readonly PushQuietClass[];
}

export type RuleParameters = MailMatchParameters | PushQuietParameters;

export interface RuleTypeDefinition {
  readonly id: string;
  readonly gate: RuleGate;
  readonly outcome: RuleOutcome;
  readonly tests: string | null;
  parse(value: unknown): RuleParameters;
  expression(parameters: RuleParameters): string;
  examples(parameters: RuleParameters): readonly RuleExample[];
}

const MATCH_KEYS = [
  "senderDomains",
  "senderAddresses",
  "phrases",
  "words",
  "excludePhrases",
] as const;
const PHRASE_KEYS = new Set(["phrases", "excludePhrases"]);
const PHRASE_MIN = 2;
const DOMAIN =
  /^(?=.{1,64}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;
const ADDRESS = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]+$/u;
const WORD = /^[a-z0-9_]+$/u;

function invalid(message: string): never {
  throw new RuleTypeError("RULE_PARAMETERS_INVALID", message);
}

function entries(value: unknown, key: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > OWNER_RULE_LIST_LIMIT)
    invalid(`${key} 必须是不超过 ${OWNER_RULE_LIST_LIMIT} 项的文字列表`);
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") invalid(`${key} 里只能是文字`);
    if (/[\p{Surrogate}\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry)) invalid(`${key} 里有不可见字符`);
    const folded = foldText(entry.trim());
    const minimum = PHRASE_KEYS.has(key) ? PHRASE_MIN : 1;
    const length = Array.from(folded).length;
    if (length < minimum || length > OWNER_RULE_ENTRY_LIMIT)
      invalid(`${key} 每项 ${minimum} 到 ${OWNER_RULE_ENTRY_LIMIT} 个字`);
    seen.add(folded);
  }
  return Object.freeze([...seen].sort());
}

function parseMailMatch(value: unknown): MailMatchParameters {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid("规则参数必须是对象");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!(MATCH_KEYS as readonly string[]).includes(key)) invalid(`规则参数不认识 ${key}`);
  const senderDomains = entries(record["senderDomains"], "senderDomains").map((entry) =>
    entry.replace(/^@/u, ""),
  );
  const senderAddresses = entries(record["senderAddresses"], "senderAddresses");
  const phrases = entries(record["phrases"], "phrases");
  const words = entries(record["words"], "words");
  const excludePhrases = entries(record["excludePhrases"], "excludePhrases");
  for (const domain of senderDomains) if (!DOMAIN.test(domain)) invalid(`域名不合法：${domain}`);
  for (const address of senderAddresses)
    if (!ADDRESS.test(address)) invalid(`发件地址不合法：${address}`);
  for (const word of words)
    if (!WORD.test(word)) invalid(`英文整词只能是字母、数字、下划线：${word}`);
  if (senderDomains.length + senderAddresses.length + phrases.length + words.length === 0)
    invalid("至少要有一个发件域名、发件地址、词语或英文整词");
  return Object.freeze({
    senderDomains: Object.freeze([...new Set(senderDomains)].sort()),
    senderAddresses,
    phrases,
    words,
    excludePhrases,
  });
}

function mailMatchExpression(parameters: MailMatchParameters): string {
  const parts: string[] = [];
  if (parameters.senderAddresses.length > 0)
    parts.push(`sender_address in ${celStringList(parameters.senderAddresses)}`);
  if (parameters.senderDomains.length > 0)
    parts.push(
      `${celStringList(parameters.senderDomains)}.exists(entry, sender_domain == entry || sender_domain.endsWith("." + entry))`,
    );
  if (parameters.phrases.length > 0)
    parts.push(
      `${celStringList(parameters.phrases)}.exists(phrase, content_folded.contains(phrase))`,
    );
  if (parameters.words.length > 0)
    parts.push(`${celStringList(parameters.words)}.exists(word, word in content_words)`);
  const matched = parts.join(" || ");
  if (parameters.excludePhrases.length === 0) return matched;
  return `(${matched}) && !${celStringList(parameters.excludePhrases)}.exists(phrase, content_folded.contains(phrase))`;
}

const MISS_SENDERS = ["nobody@unmatched.example", "nobody@other.example", "x@y.example"];

function mailMatchExamples(parameters: MailMatchParameters): readonly RuleExample[] {
  const candidates: ReturnType<typeof mailItemFacts>[] = [];
  const candidate = (fromAddress: string, subject: string) =>
    candidates.push(mailItemFacts({ fromAddress, subject, snippet: "" }));
  const [address] = parameters.senderAddresses;
  if (address) candidate(address, "Hello");
  const [domain] = parameters.senderDomains;
  if (domain) candidate(`info@mail.${domain}`, "Hello");
  const [phrase] = parameters.phrases;
  if (phrase) candidate("someone@unmatched.example", phrase);
  const [word] = parameters.words;
  if (word) candidate("someone@unmatched.example", word);
  const examples: RuleExample[] = candidates
    .filter((facts) => matchesFacts(parameters, facts))
    .map((facts) => Object.freeze({ facts, hit: true }));
  const [excluded] = parameters.excludePhrases;
  const [first] = examples;
  if (excluded && first)
    examples.push(
      Object.freeze({
        facts: mailItemFacts({
          fromAddress: String(first.facts["sender_address"]),
          subject: `${String(first.facts["text"]).split("\n", 1)[0]} ${excluded}`,
          snippet: "",
        }),
        hit: false,
      }),
    );
  const miss = MISS_SENDERS.map((sender) =>
    mailItemFacts({ fromAddress: sender, subject: "Lunch on Friday", snippet: "see you" }),
  ).find((facts) => !matchesFacts(parameters, facts));
  if (miss) examples.push(Object.freeze({ facts: miss, hit: false }));
  return Object.freeze(examples);
}

function matchesFacts(
  parameters: MailMatchParameters,
  facts: ReturnType<typeof mailItemFacts>,
): boolean {
  const address = facts["sender_address"] as string;
  const domain = facts["sender_domain"] as string;
  const text = facts["content_folded"] as string;
  const words = facts["content_words"] as readonly string[];
  const matched =
    parameters.senderAddresses.includes(address) ||
    parameters.senderDomains.some((entry) => domain === entry || domain.endsWith(`.${entry}`)) ||
    parameters.phrases.some((entry) => text.includes(entry)) ||
    parameters.words.some((entry) => words.includes(entry));
  return matched && !parameters.excludePhrases.some((entry) => text.includes(entry));
}

function mailMatchType(id: string, outcome: RuleOutcome, tests: string | null): RuleTypeDefinition {
  return Object.freeze({
    id,
    gate: "mail_item" as const,
    outcome,
    tests,
    parse: parseMailMatch,
    expression: (parameters: RuleParameters) =>
      mailMatchExpression(parameters as MailMatchParameters),
    examples: (parameters: RuleParameters) => mailMatchExamples(parameters as MailMatchParameters),
  });
}

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

function parsePushQuiet(value: unknown): PushQuietParameters {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid("规则参数必须是对象");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== "periods" && key !== "classes") invalid(`规则参数不认识 ${key}`);
  const rawPeriods = record["periods"];
  if (
    !Array.isArray(rawPeriods) ||
    rawPeriods.length === 0 ||
    rawPeriods.length > PUSH_QUIET_PERIOD_LIMIT
  )
    invalid(`periods 必须是 1 到 ${PUSH_QUIET_PERIOD_LIMIT} 个静默时段`);
  const periods: QuietPeriod[] = [];
  for (const raw of rawPeriods) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      invalid("静默时段必须是对象");
    const item = raw as Record<string, unknown>;
    for (const key of Object.keys(item))
      if (key !== "days" && key !== "start" && key !== "end") invalid(`静默时段不认识 ${key}`);
    const days = item["days"];
    if (
      !Array.isArray(days) ||
      days.length === 0 ||
      days.length > 7 ||
      !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    )
      invalid("days 必须是 0（星期日）到 6（星期六）的整数列表");
    const start = item["start"];
    const end = item["end"];
    if (
      typeof start !== "string" ||
      !CLOCK.test(start) ||
      typeof end !== "string" ||
      !CLOCK.test(end)
    )
      invalid("start 和 end 必须是 HH:MM（24 小时制）");
    if (start === end) invalid("静默时段的开始和结束不能相同");
    periods.push(
      Object.freeze({
        days: Object.freeze([...new Set(days as number[])].sort((left, right) => left - right)),
        start,
        end,
      }),
    );
  }
  const rawClasses = record["classes"];
  let classes: readonly PushQuietClass[] = PUSH_QUIET_DEFAULT_CLASSES;
  if (rawClasses !== undefined) {
    if (
      !Array.isArray(rawClasses) ||
      rawClasses.length === 0 ||
      rawClasses.length > PUSH_QUIET_CLASSES.length ||
      !rawClasses.every((item) => (PUSH_QUIET_CLASSES as readonly unknown[]).includes(item))
    )
      invalid(`classes 只能从 ${PUSH_QUIET_CLASSES.join("、")} 里选`);
    classes = Object.freeze(
      PUSH_QUIET_CLASSES.filter((candidate) => (rawClasses as unknown[]).includes(candidate)),
    );
  }
  return Object.freeze({
    periods: Object.freeze(
      [...periods].sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1)),
    ),
    classes,
  });
}

function pushQuietExpression(parameters: PushQuietParameters): string {
  return `push_class in ${celStringList(parameters.classes)} && (${quietHoursExpression(parameters.periods)})`;
}

function pushQuietExamples(parameters: PushQuietParameters): readonly RuleExample[] {
  const covered = new Set<string>(parameters.classes);
  const examples: RuleExample[] = [];
  for (const pushClass of [...PUSH_QUIET_CLASSES, "approval", "muse_outage"] as const)
    examples.push(
      ...quietHoursExamples(parameters.periods, { push_class: pushClass }, (extra) =>
        covered.has(String(extra["push_class"])),
      ),
    );
  return Object.freeze(examples);
}

function pushQuietType(id: string, tests: string | null): RuleTypeDefinition {
  return Object.freeze({
    id,
    gate: "push_delivery" as const,
    outcome: "defer_to_quiet_hours" as const,
    tests,
    parse: parsePushQuiet,
    expression: (parameters: RuleParameters) =>
      pushQuietExpression(parameters as PushQuietParameters),
    examples: (parameters: RuleParameters) => pushQuietExamples(parameters as PushQuietParameters),
  });
}

export const RULE_TYPES: readonly RuleTypeDefinition[] = Object.freeze([
  mailMatchType(
    "mail_must_notify",
    "require_notify",
    "packages/application/test/rule-type-mail-must-notify.unit.test.ts",
  ),
  mailMatchType(
    "mail_read_whole_thread",
    "require_whole_thread",
    "packages/application/test/rule-type-mail-read-whole-thread.unit.test.ts",
  ),
  pushQuietType(
    "push_quiet_hours",
    "packages/application/test/rule-type-push-quiet-hours.unit.test.ts",
  ),
]);

export function ruleType(
  id: string,
  registry: readonly RuleTypeDefinition[] = RULE_TYPES,
): RuleTypeDefinition {
  const found = registry.find((candidate) => candidate.id === id);
  if (!found) throw new RuleTypeError("RULE_TYPE_UNKNOWN", `没有这种规则类型：${id}`);
  return found;
}

export function writableRuleType(
  id: string,
  registry: readonly RuleTypeDefinition[] = RULE_TYPES,
): RuleTypeDefinition {
  const found = ruleType(id, registry);
  if (found.tests === null || found.tests.length === 0)
    throw new RuleTypeError("RULE_TYPE_UNTESTED", `规则类型 ${id} 没有测试，不能承载硬规则`);
  return found;
}

export interface OwnerRuleRow {
  readonly ruleId: string;
  readonly revision: number;
  readonly status: RuleStatus;
  readonly source: string;
  readonly parameters: unknown;
}

export interface OwnerRuleParameters {
  readonly type: string;
  readonly params: RuleParameters;
  readonly summary: string;
}

export function validRuleSummary(summary: string): boolean {
  const trimmed = summary.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= OWNER_RULE_SUMMARY_LIMIT &&
    !/[\p{Surrogate}\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed)
  );
}

export function parseOwnerRuleParameters(
  value: unknown,
  registry: readonly RuleTypeDefinition[] = RULE_TYPES,
): OwnerRuleParameters & { readonly definition: RuleTypeDefinition } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid("规则参数必须是对象");
  const record = value as Record<string, unknown>;
  const type = record["type"];
  const summary = record["summary"];
  if (typeof type !== "string") invalid("规则参数缺少类型");
  if (typeof summary !== "string" || !validRuleSummary(summary))
    invalid(`规则说明必须是 1 到 ${OWNER_RULE_SUMMARY_LIMIT} 个字，不能有换行或不可见字符`);
  const definition = ruleType(type, registry);
  const params = definition.parse(record["params"]);
  if (JSON.stringify({ type, params, summary: summary.trim() }).length > OWNER_RULE_STORED_LIMIT)
    invalid("规则参数太长，请减少条目");
  return Object.freeze({ type, params, summary: summary.trim(), definition });
}

export function ownerRuleRecord(
  row: OwnerRuleRow,
  registry: readonly RuleTypeDefinition[] = RULE_TYPES,
): RuleRecord {
  if (!row.ruleId.startsWith(OWNER_RULE_ID_PREFIX) || row.ruleId.length > 64)
    throw new RuleTypeError("RULE_ID_INVALID", `主人规则的编号不对：${row.ruleId}`);
  const parsed = parseOwnerRuleParameters(row.parameters, registry);
  const rule: RuleRecord = Object.freeze({
    id: row.ruleId,
    revision: row.revision,
    gate: parsed.definition.gate,
    expression: parsed.definition.expression(parsed.params),
    outcome: parsed.definition.outcome,
    origin: "owner_setting",
    source: row.source,
    status: row.status,
    examples: parsed.definition.examples(parsed.params),
  });
  if (!rule.examples.some(({ hit }) => hit))
    invalid("这条规则按现在的参数不会命中任何情形，不会生效");
  assertRuleExamples(rule);
  return rule;
}

export function unreadablePushRule(
  row: OwnerRuleRow,
  registry: readonly RuleTypeDefinition[] = RULE_TYPES,
): boolean {
  if (!ruleIsEnforced(row.status) || enforceableOwnerRule(row, registry) !== undefined)
    return false;
  const text = typeof row.parameters === "string" ? row.parameters : JSON.stringify(row.parameters);
  const declared =
    typeof row.parameters === "object" && row.parameters !== null
      ? (row.parameters as Record<string, unknown>)["type"]
      : undefined;
  if (typeof declared === "string" && declared.startsWith("push_")) return true;
  return registry.some(({ id, gate }) => gate === "push_delivery" && (text ?? "").includes(id));
}

export function enforceableOwnerRule(
  row: OwnerRuleRow,
  registry: readonly RuleTypeDefinition[] = RULE_TYPES,
): RuleRecord | undefined {
  if (!ruleIsEnforced(row.status)) return undefined;
  try {
    return ownerRuleRecord(row, registry);
  } catch (error) {
    if (error instanceof RuleTypeError) return undefined;
    throw error;
  }
}
