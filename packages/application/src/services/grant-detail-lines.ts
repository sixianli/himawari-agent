export interface GrantDetailInput {
  readonly exactResourceRef: string | null;
  readonly resourceIdentities: readonly string[];
  readonly resourcePrefixes: readonly string[];
  readonly recipients: readonly string[];
  readonly uses: number;
  readonly maxUses: number;
  readonly spentCostMicros: number;
  readonly maxTotalCostMicros: number;
  readonly maxCostMicrosPerUse: number;
  readonly affectedTaskCount: number;
}

export interface GrantDetailLines {
  readonly "zh-CN": readonly string[];
  readonly en: readonly string[];
  readonly ja: readonly string[];
}

function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function resourceCount(input: GrantDetailInput): number {
  return new Set([
    ...(input.exactResourceRef === null ? [] : [input.exactResourceRef]),
    ...input.resourceIdentities,
    ...input.resourcePrefixes,
  ]).size;
}

export function grantDetailLines(input: GrantDetailInput): GrantDetailLines {
  const zh: string[] = [];
  const en: string[] = [];
  const ja: string[] = [];
  const resources = resourceCount(input);
  if (resources > 0) {
    zh.push(`范围：${resources} 项`);
    en.push(`Scope: ${resources} item${resources === 1 ? "" : "s"}`);
    ja.push(`範囲：${resources} 件`);
  }
  if (input.recipients.length > 0) {
    const count = input.recipients.length;
    zh.push(`收件对象：${count} 个`);
    en.push(`Recipients: ${count}`);
    ja.push(`宛先：${count} 件`);
  }
  zh.push(`已用 ${input.uses}/${input.maxUses} 次`);
  en.push(`Used ${input.uses} of ${input.maxUses}`);
  ja.push(`${input.uses}/${input.maxUses} 回使用`);
  if (input.maxTotalCostMicros > 0) {
    const spent = dollars(input.spentCostMicros);
    const total = dollars(input.maxTotalCostMicros);
    zh.push(`费用上限 ${total}，已花 ${spent}`);
    en.push(`Cost limit ${total}, spent ${spent}`);
    ja.push(`費用上限 ${total}、使用済み ${spent}`);
  } else if (input.maxCostMicrosPerUse > 0) {
    const each = dollars(input.maxCostMicrosPerUse);
    zh.push(`每次费用上限 ${each}`);
    en.push(`Cost limit per use ${each}`);
    ja.push(`1 回あたりの費用上限 ${each}`);
  }
  if (input.affectedTaskCount > 0) {
    const count = input.affectedTaskCount;
    zh.push(`会影响 ${count} 个任务`);
    en.push(`Affects ${count} task${count === 1 ? "" : "s"}`);
    ja.push(`${count} 件のタスクに影響`);
  }
  return { "zh-CN": zh, en, ja };
}
