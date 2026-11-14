export type RuleFieldType = "int" | "string" | "list<string>";

export interface RuleFieldDefinition {
  readonly name: string;
  readonly type: RuleFieldType;
  readonly description: string;
}

export const RULE_GATES = ["mail_item", "mail_delivery", "action"] as const;
export type RuleGate = (typeof RULE_GATES)[number];

export const RULE_FIELD_CATALOG: Readonly<Record<RuleGate, readonly RuleFieldDefinition[]>> =
  Object.freeze({
    mail_item: Object.freeze([
      Object.freeze({
        name: "sender_address",
        type: "string",
        description: "发件地址，全部小写",
      }),
      Object.freeze({
        name: "sender_domain",
        type: "string",
        description: "发件地址 @ 之后的域名，全部小写",
      }),
      Object.freeze({
        name: "text",
        type: "string",
        description: "邮件主题、换行、摘要连起来的原文",
      }),
      Object.freeze({
        name: "content_folded",
        type: "string",
        description:
          "邮件主题、换行、正文（读不到正文时用摘要）连起来，先做 Unicode NFKC 规整（全角半角统一）再转成小写",
      }),
      Object.freeze({
        name: "text_words",
        type: "list<string>",
        description: "text 里每一段连续的英文字母、数字、下划线，转成小写",
      }),
      Object.freeze({
        name: "content_words",
        type: "list<string>",
        description: "content_folded 里每一段连续的英文字母、数字、下划线，去掉重复",
      }),
      Object.freeze({
        name: "money_state",
        type: "string",
        description:
          "模型判断这封邮件是不是涉及主人要付出、被扣、可收回或已入账的具体钱款事项：yes 是，no 不是，unknown 是模型没给出或答案格式不对（这个字段永远存在，判断之前也是 unknown）",
      }),
      Object.freeze({
        name: "amount_state",
        type: "string",
        description:
          "邮件主金额读得怎么样：known 是模型有把握且正文完整，uncertain 是读到了但没把握或正文不全，missing 是没有读到（这个字段永远存在）",
      }),
      Object.freeze({
        name: "amount_minor",
        type: "int",
        description:
          "主金额，按币种最小单位的整数（日元是円，美元和人民币是分，科威特第纳尔是 0.001）；amount_state 不是 known 时没有意义，固定为 0",
      }),
      Object.freeze({
        name: "amount_currency",
        type: "string",
        description: "主金额的三个大写字母币种代码；没有金额时是空字符串",
      }),
    ] as const),
    mail_delivery: Object.freeze([
      Object.freeze({
        name: "local_minutes",
        type: "int",
        description: "这个实例主人所在时区的当地时间，从 0 点起的分钟数（0 到 1439）",
      }),
      Object.freeze({
        name: "local_weekday",
        type: "int",
        description: "主人所在时区当天是星期几（0 是星期日，6 是星期六）",
      }),
      Object.freeze({
        name: "local_previous_weekday",
        type: "int",
        description: "主人所在时区前一天是星期几（0 是星期日，6 是星期六）",
      }),
    ] as const),
    action: Object.freeze([
      Object.freeze({
        name: "action_kind",
        type: "string",
        description: "动作类别，权限引擎 11 类之一的大写名字，例如 READ、CREATE_OR_UPDATE、DELETE",
      }),
      Object.freeze({
        name: "risk",
        type: "string",
        description: "权限引擎算出的风险档位：LOW、MEDIUM、HIGH 或 CRITICAL",
      }),
      Object.freeze({
        name: "reversible",
        type: "int",
        description: "这个动作能不能撤销：1 是能，0 是不能",
      }),
      Object.freeze({
        name: "disclosure",
        type: "string",
        description: "对外披露方式：none、same_owner、named_recipients 或 public",
      }),
      Object.freeze({
        name: "recipient_count",
        type: "int",
        description: "对外收件人的个数；只动主人自己的数据时是 0",
      }),
      Object.freeze({
        name: "run_source",
        type: "string",
        description: "这一轮是谁发起的：user_message、schedule 或 external_event",
      }),
      Object.freeze({
        name: "facts",
        type: "list<string>",
        description: "动作意图里的事实代码，按代码排序，例如 context_external_content",
      }),
    ] as const),
  });

export function ruleFields(gate: RuleGate): readonly RuleFieldDefinition[] {
  return RULE_FIELD_CATALOG[gate];
}
