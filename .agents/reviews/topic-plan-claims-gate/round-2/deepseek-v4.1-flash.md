CLAIM|1|一致|packages/sensitive-capture/src/redaction.ts:552|`packages/sensitive-capture/src/redaction.ts` 里的 `maskSensitiveTexts` 一次处理一批文本|export function maskSensitiveTexts(inputs: readonly string[]): string[] {
CLAIM|2|一致|packages/sensitive-capture/src/redaction.ts:553|对外遮盖时同一个值在整批里得到同一个标签|  const tags = new Map<string, string>();  const options: EgressRedactionOptions = {    known: new Map<string, string>(),    tag: (kind, identity) => {      const key = `${kind}\u0000${identity}`;      const existing = tags.get(key);      if (existing !== undefined) return existing;      const created = sequenceTag(tags.size);      tags.set(key, created);      return created;    },
CLAIM|3|一致|packages/sensitive-capture/src/redaction.ts:567|`maskSensitiveTexts` 输出前把占位编号去掉|    redactForEgress(input, options).text.replace(EGRESS_PLACEHOLDER_PATTERN, "[$1]"),
CLAIM|4|一致|packages/sensitive-capture/src/redaction.ts:567|所以同一段文字放在不同位置遮成相同的字节|    redactForEgress(input, options).text.replace(EGRESS_PLACEHOLDER_PATTERN, "[$1]"),
CLAIM|5|一致|packages/sensitive-capture/src/redaction.ts:542|同一文件导出了 `maskSensitiveText`|export function maskSensitiveText(input: string): string {
CLAIM|6|一致|packages/sensitive-capture/src/redaction.ts:542|它只处理单条文本|export function maskSensitiveText(input: string): string {  return redactForEgress(input).text;}

所有列出的说法都已直接读取对应代码核对，没有未能核对的部分。
