CLAIM|1|一致|packages/sensitive-capture/src/redaction.ts:552|`packages/sensitive-capture/src/redaction.ts` 里有 `maskSensitiveTexts`|export function maskSensitiveTexts(inputs: readonly string[]): string[] {
CLAIM|2|一致|packages/sensitive-capture/src/redaction.ts:552|`maskSensitiveTexts` 一次处理一批文本|export function maskSensitiveTexts(inputs: readonly string[]): string[] {
CLAIM|3|一致|packages/sensitive-capture/src/redaction.ts:556-561|对外遮盖时同一个值在整批里得到同一个标签|tag: (kind, identity) => { const key = `${kind}\u0000${identity}`; const existing = tags.get(key); if (existing !== undefined) return existing; const created = sequenceTag(tags.size); tags.set(key, created); return created;
CLAIM|4|不一致|packages/sensitive-capture/src/redaction.ts:567|`maskSensitiveTexts` 输出的占位编号随前面内容变化|redactForEgress(input, options).text.replace(EGRESS_PLACEHOLDER_PATTERN, "[$1]"),
CLAIM|5|不一致|packages/sensitive-capture/test/redaction.unit.test.ts:383|同一段文字放在不同位置会遮成不同的字节|expect(withOthers[1]).toBe(alone[0]);
CLAIM|6|一致|packages/sensitive-capture/src/redaction.ts:542|同一文件导出了 `maskSensitiveText`|export function maskSensitiveText(input: string): string {
CLAIM|7|一致|packages/sensitive-capture/src/redaction.ts:542-543|它只处理单条文本|export function maskSensitiveText(input: string): string { return redactForEgress(input).text;

全部说法均已打开对应文件核对，无未核实部分。
