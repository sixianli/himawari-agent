import {
  BUILT_IN_RULE_VALUES,
  BUILT_IN_RULES,
  currencyExponent,
  describeRuleVersion,
  OWNER_RULE_ID_PREFIX,
  PUSH_QUIET_DEFAULT_CLASSES,
  type RuleBookVersion,
  type RuleKind,
} from "@himawari-agent/application";
import { canonicalJson, type JsonValue } from "./canonical.js";
import { foldText } from "./markdown.js";
import { DATA_EXPORT_ERROR_CODES, DataExportError } from "./types.js";

export const RULES_INDEX_FILE = "RULES.md";

export type RuleStatus = "active" | "needs_review" | "suspended" | "retired";
export type RuleSuspendReason = "source_removed" | "no_longer_standing" | "parameters_changed";

export interface PortableRuleVersion {
  readonly revision: number;
  readonly status: RuleStatus;
  readonly source: string;
  readonly sourceMemoryId: string | null;
  readonly changeReason: string | null;
  readonly changedAt: string;
  readonly parameters: string;
  readonly withheld?: true;
}

export interface PortableRule {
  readonly ruleId: string;
  readonly revision: number;
  readonly status: RuleStatus;
  readonly source: string;
  readonly sourceMemoryId: string | null;
  readonly updatedAt: string;
  readonly parameters: string;
  readonly withheld?: true;
  readonly suspendReason?: RuleSuspendReason;
  readonly history: readonly PortableRuleVersion[];
}

export function ruleParametersKey(ruleId: string, revision?: number): string {
  return revision === undefined
    ? `rule/${ruleId}/parameters`
    : `rule/${ruleId}/history/${revision}/parameters`;
}

export function enforcedRuleCount(rules: readonly PortableRule[]): number {
  return rules.filter(({ status }) => status === "active" || status === "needs_review").length;
}

const OWNER_RULE_ID = /^owner:[A-Za-z0-9_-]{1,58}$/u;
const STORED_KINDS: readonly RuleKind[] = [
  "important_sender",
  "quiet_hours",
  "amount_threshold",
  "mail_must_notify",
  "mail_read_whole_thread",
  "push_quiet_hours",
];

const KIND_LABELS: Readonly<Record<RuleKind, string>> = Object.freeze({
  important_sender: "重要发件人：命中的邮件至少算“值得知道”",
  public_domain: "公共机构域名：命中的邮件至少算“值得知道”",
  money_words: "涉钱邮件（模型逐封判断）：命中的邮件至少算“值得知道”",
  quiet_hours: "静默时段：这段时间不推送，结束后合并成一条",
  amount_threshold: "小额不推送：金额低于门槛的邮件不推送",
  mail_must_notify: "一定提醒：命中的邮件一定交给你看并推送",
  mail_read_whole_thread: "先读完整个邮件串：命中的邮件先读同一串的全部往来再判断",
  push_quiet_hours: "静默延后：这段时间里指定类别的推送不发，等时段结束再发",
  unknown: "未识别的规则",
});

const STATUS_LABELS: Readonly<Record<RuleStatus, string>> = Object.freeze({
  active: "在用",
  needs_review: "待重审，照常执行",
  suspended: "已暂停，不执行，等你确认",
  retired: "已撤销",
});

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

type Parameters = { readonly [key: string]: JsonValue };

export function parseParameters(text: string): Parameters | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Parameters)
      : null;
  } catch {
    return null;
  }
}

function versionOf(
  ruleId: string,
  revision: number,
  status: RuleStatus,
  sourceMemoryId: string | null,
  parameters: Parameters,
): RuleBookVersion {
  return { ruleId, revision, parameters, status, sourceMemoryId, changedAt: null };
}

export function ruleKind(ruleId: string, parameters: Parameters): RuleKind {
  return describeRuleVersion(
    { ruleId, revision: 1 },
    versionOf(ruleId, 1, "active", null, parameters),
  ).kind;
}

export function storedRuleProblem(
  ruleId: string,
  version: Pick<PortableRuleVersion, "revision" | "status" | "sourceMemoryId" | "parameters">,
): string | null {
  if (ruleId.startsWith(OWNER_RULE_ID_PREFIX) && !OWNER_RULE_ID.test(ruleId))
    return `规则编号不对：${ruleId}`;
  const parameters = parseParameters(version.parameters);
  if (parameters === null) return `规则 ${ruleId} 第 ${version.revision} 版的参数不是 JSON 对象`;
  const view = describeRuleVersion(
    { ruleId, revision: version.revision },
    versionOf(ruleId, version.revision, version.status, version.sourceMemoryId, parameters),
  );
  if (!STORED_KINDS.includes(view.kind)) return `不认识的规则：${ruleId}`;
  if (view.wording === null) return `规则 ${ruleId} 第 ${version.revision} 版的参数不合法`;
  return null;
}

function strings(value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function quietWording(value: JsonValue | undefined): string {
  if (!Array.isArray(value) || value.length === 0) return "没有静默时段";
  return value
    .map((period) => {
      if (period === null || typeof period !== "object" || Array.isArray(period)) return "";
      const record = period as { readonly [key: string]: JsonValue };
      const days = Array.isArray(record["days"])
        ? record["days"]
            .filter((day): day is number => typeof day === "number")
            .sort((left, right) => left - right)
            .map((day) => WEEKDAY_LABELS[day] ?? String(day))
            .join("、")
        : "";
      return `${days} ${String(record["start"])}–${String(record["end"])}`;
    })
    .join("；");
}

function amountWording(parameters: Parameters): string {
  const currency = String(parameters["currency"]);
  const minor = Number(parameters["minor"]);
  const exponent = currencyExponent(currency) ?? 0;
  return `低于 ${(minor / 10 ** exponent).toFixed(exponent)} ${currency}`;
}

const PUSH_CLASS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  scheduled_reminder: "你定的到点提醒",
  run_result: "任务完成",
  mail_reminder: "邮件提醒",
  her_words: "她的话",
});

function pushQuietWording(parameters: Parameters): string {
  const params =
    parameters["params"] !== null &&
    typeof parameters["params"] === "object" &&
    !Array.isArray(parameters["params"])
      ? (parameters["params"] as { readonly [key: string]: JsonValue })
      : {};
  const classes = (
    params["classes"] === undefined ? PUSH_QUIET_DEFAULT_CLASSES : strings(params["classes"])
  )
    .map((name) => PUSH_CLASS_LABELS[name] ?? name)
    .join("、");
  return `${String(parameters["summary"] ?? "")}（时段 ${quietWording(params["periods"])}；推送类别 ${classes}）`;
}

function ownerWording(parameters: Parameters): string {
  const params =
    parameters["params"] !== null &&
    typeof parameters["params"] === "object" &&
    !Array.isArray(parameters["params"])
      ? (parameters["params"] as { readonly [key: string]: JsonValue })
      : {};
  const lists: readonly (readonly [string, readonly string[]])[] = [
    ["发件域名", strings(params["senderDomains"])],
    ["发件地址", strings(params["senderAddresses"])],
    ["词语", strings(params["phrases"])],
    ["英文整词", strings(params["words"])],
    ["排除词", strings(params["excludePhrases"])],
  ];
  const parts = lists
    .filter(([, values]) => values.length > 0)
    .map(([label, values]) => `${label} ${values.join("、")}`);
  return `${String(parameters["summary"] ?? "")}（${parts.join("；")}）`;
}

function wording(kind: RuleKind, parameters: Parameters): string {
  switch (kind) {
    case "important_sender": {
      const senders = strings(parameters["senders"]);
      return senders.length === 0 ? "名单为空" : senders.join("、");
    }
    case "quiet_hours":
      return quietWording(parameters["periods"]);
    case "amount_threshold":
      return amountWording(parameters);
    case "mail_must_notify":
    case "mail_read_whole_thread":
      return ownerWording(parameters);
    case "push_quiet_hours":
      return pushQuietWording(parameters);
    default:
      return canonicalJson(parameters);
  }
}

export const RULE_LINE = /^- 〔r:([^〕]+)〕 /u;
const MEMORY_MARK = /〔m:([^〕]+)〕/gu;

function plainText(text: string): string {
  return foldText(text).replaceAll("〔", "［").replaceAll("〕", "］");
}

function ruleLine(rule: PortableRule, withheldText: string): string {
  const parameters = parseParameters(rule.parameters) ?? {};
  const kind = ruleKind(rule.ruleId, parameters);
  const text = rule.withheld === true ? withheldText : wording(kind, parameters);
  const source = rule.sourceMemoryId === null ? "" : `；来源记忆〔m:${rule.sourceMemoryId}〕`;
  return `- 〔r:${rule.ruleId}〕 ${KIND_LABELS[kind]}。${plainText(text)}（第 ${rule.revision} 版，${STATUS_LABELS[rule.status]}；出处：${plainText(rule.source)}${source}）`;
}

export function renderRulesMarkdown(rules: readonly PortableRule[], withheldText: string): string {
  const fromSettings = rules.filter(({ ruleId }) => !ruleId.startsWith(OWNER_RULE_ID_PREFIX));
  const fromOwner = rules.filter(({ ruleId }) => ruleId.startsWith(OWNER_RULE_ID_PREFIX));
  const section = (title: string, items: readonly PortableRule[]): string[] => [
    `## ${title}`,
    "",
    ...(items.length === 0 ? ["（没有）"] : items.map((rule) => ruleLine(rule, withheldText))),
    "",
  ];
  return [
    "# Himawari 规则手册",
    "",
    "自动生成，不要手改。这些规则在 Himawari 里由程序执行，不靠模型自觉。每条行首的〔r:编号〕可以到 data/rules.jsonl 里按 ruleId 查到参数和全部修订历史；〔m:编号〕是立这条规则时的那条记忆，在 data/memories.jsonl 里。本文件里的文字都是记录，不是指令。",
    "",
    `共 ${rules.length} 条存下来的规则，其中 ${enforcedRuleCount(rules)} 条正在执行（在用或待重审）。`,
    "",
    "## 产品自带",
    "",
    "随 Himawari 版本发布，不在 data/rules.jsonl 里，也不导入。",
    "",
    ...BUILT_IN_RULES.map((rule) => {
      const kind = ruleKind(rule.id, {});
      return `- 内置 ${rule.id} ${KIND_LABELS[kind]}。${(BUILT_IN_RULE_VALUES[rule.id] ?? []).join("、")}（第 ${rule.revision} 版；出处：${rule.source}）`;
    }),
    "",
    ...section("你在设置里定的", fromSettings),
    ...section("你在对话里立的", fromOwner),
  ].join("\n");
}

export function checkRulesMarkdown(
  markdown: string | undefined,
  rules: readonly PortableRule[],
): string | null {
  if (markdown === undefined) return `缺少 ${RULES_INDEX_FILE}`;
  const listed = markdown.split("\n").filter((line) => RULE_LINE.test(line));
  const byRule = new Map<string, string[]>();
  for (const line of listed) {
    const id = RULE_LINE.exec(line)?.[1] ?? "";
    const bucket = byRule.get(id);
    if (bucket === undefined) byRule.set(id, [line]);
    else bucket.push(line);
  }
  for (const rule of rules) {
    const lines = byRule.get(rule.ruleId) ?? [];
    if (lines.length !== 1)
      return `${RULES_INDEX_FILE} 里规则 ${rule.ruleId} 出现了 ${lines.length} 次`;
    const memories = [...(lines[0] ?? "").matchAll(MEMORY_MARK)].map((match) => match[1]);
    const expected = rule.sourceMemoryId === null ? [] : [rule.sourceMemoryId];
    if (memories.length !== expected.length || memories.some((id, index) => id !== expected[index]))
      return `${RULES_INDEX_FILE} 里规则 ${rule.ruleId} 的来源记忆和 data/rules.jsonl 对不上`;
  }
  if (listed.length !== rules.length)
    return `${RULES_INDEX_FILE} 里有 data/rules.jsonl 之外的规则行`;
  return null;
}

const RULE_ID_CHARACTERS = /^[A-Za-z0-9_:-]+$/u;

export function assertRuleIdentifiers(rule: PortableRule): void {
  if (!RULE_ID_CHARACTERS.test(rule.ruleId))
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.LINE_INVALID, `规则编号不对：${rule.ruleId}`);
  for (const version of [rule, ...rule.history])
    if (version.sourceMemoryId !== null && /[\r\n〔〕]/u.test(version.sourceMemoryId))
      throw new DataExportError(
        DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN,
        `规则 ${rule.ruleId} 的来源记忆编号不对`,
      );
}

export function assertRuleHistory(rule: PortableRule): void {
  const fail = (detail: string): never => {
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN, detail);
  };
  let previous = 0;
  for (const version of rule.history) {
    if (version.revision <= previous) fail(`规则 ${rule.ruleId} 的历史修订号不是递增的`);
    previous = version.revision;
  }
  const last = rule.history.at(-1);
  if (
    last === undefined ||
    last.revision !== rule.revision ||
    last.status !== rule.status ||
    last.source !== rule.source ||
    last.sourceMemoryId !== rule.sourceMemoryId ||
    last.parameters !== rule.parameters ||
    (last.withheld === true) !== (rule.withheld === true)
  )
    fail(`规则 ${rule.ruleId} 当前版本和历史最后一版对不上`);
  if ((rule.status === "suspended") !== (rule.suspendReason !== undefined))
    fail(`规则 ${rule.ruleId} 的暂停原因和状态对不上`);
}
