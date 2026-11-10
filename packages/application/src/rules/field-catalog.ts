export type RuleFieldType = "int" | "string" | "list<string>";

export interface RuleFieldDefinition {
  readonly name: string;
  readonly type: RuleFieldType;
  readonly description: string;
}

export const RULE_GATES = ["mail_item", "mail_delivery"] as const;
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
        name: "text_words",
        type: "list<string>",
        description: "text 里每一段连续的英文字母、数字、下划线，转成小写",
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
  });

export function ruleFields(gate: RuleGate): readonly RuleFieldDefinition[] {
  return RULE_FIELD_CATALOG[gate];
}
