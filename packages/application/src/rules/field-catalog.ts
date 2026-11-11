export type RuleFieldType = "int" | "string" | "list<string>";

export interface RuleFieldDefinition {
  readonly name: string;
  readonly type: RuleFieldType;
  readonly description: string;
}

export const RULE_GATES = ["mail_item", "mail_delivery", "push_delivery"] as const;
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
    push_delivery: Object.freeze([
      Object.freeze({
        name: "push_class",
        type: "string",
        description:
          "这条推送属于哪一类：scheduled_reminder 是主人自己定的到点提醒，run_result 是任务完成或失败，mail_reminder 是邮件主动提醒；审批和 Muse 告警由程序直接放行，不会交给规则",
      }),
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
  });

export function ruleFields(gate: RuleGate): readonly RuleFieldDefinition[] {
  return RULE_FIELD_CATALOG[gate];
}
