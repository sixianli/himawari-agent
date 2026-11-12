import type { RuleGate } from "./field-catalog.js";
import {
  assertRuleExamples,
  celStringList,
  foldText,
  mailItemFacts,
  type RuleExample,
  type RuleOutcome,
  type RuleRecord,
  ruleIsEnforced,
  type RuleStatus,
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

export interface RuleTypeDefinition {
  readonly id: string;
  readonly gate: RuleGate;
  readonly outcome: RuleOutcome;
  readonly tests: string | null;
  parse(value: unknown): MailMatchParameters;
  expression(parameters: MailMatchParameters): string;
  examples(parameters: MailMatchParameters): readonly RuleExample[];
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
    expression: mailMatchExpression,
    examples: mailMatchExamples,
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
  readonly params: MailMatchParameters;
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
    invalid("排除词把所有该命中的邮件都排除了，这条规则不会生效");
  assertRuleExamples(rule);
  return rule;
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
