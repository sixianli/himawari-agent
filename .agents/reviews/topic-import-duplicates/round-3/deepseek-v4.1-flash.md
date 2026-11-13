CLAIM|1|一致|apps/control-center/src/i18n/resources/zh-CN.ts:743|导入记忆时，网页要标出哪些条目主人已经存过|"{f, select, duplicate {已经记着，跳过} classifying {分类中…} unclassified {分类失败，已先保密，默认不导入} sensitive {敏感，默认不导入} similar {可能已经记着，默认不导入} unchecked {没能核对是否重复，默认不导入} other {写代码的经验，默认不导入}}",
CLAIM|2|一致|apps/control-center/src/components/memory-page.tsx:2052|标出来的条目不能勾选|item.duplicate ||
CLAIM|3|一致|apps/control-center/src/components/memory-page.tsx:2023|也不会导入|const chosen = items.filter((item) => item.checked);
CLAIM|4|一致|apps/control-center/src/memory-import.ts:42（4d139c528^）|原先网页用字符串相等或包含来判断|function isDuplicate(key: string, existing: readonly string[]) {
CLAIM|5|一致|apps/control-center/src/memory-import.ts:37（4d139c528^）|去空白|.replace(/\s+/g, "")
CLAIM|6|一致|apps/control-center/src/memory-import.ts:38（4d139c528^）|去开头的“我的”“主人”“用户”一类称呼|.replace(/^(?:我的|我|主人的|主人|用户的|用户)/, "")
CLAIM|7|一致|apps/control-center/src/memory-import.ts:40（4d139c528^）|转小写|.toLowerCase();
CLAIM|8|一致|apps/control-center/src/memory-import.ts:45（4d139c528^）|两条相等|known === key ||
CLAIM|9|一致|apps/control-center/src/memory-import.ts:46（4d139c528^）|其中一条（长度超过 5）包含另一条|(known.length > 5 && key.includes(known)) ||
CLAIM|10|一致|apps/control-center/src/memory-import.ts:42（4d139c528^）|改动前的 `apps/control-center/src/memory-import.ts` 第 42 到 49 行 `isDuplicate`|function isDuplicate(key: string, existing: readonly string[]) {
CLAIM|11|一致|apps/control-center/src/memory-import.ts:46（4d139c528^）|其中 `(known.length > 5 && key.includes(known)) ｜｜ (key.length > 5 && known.includes(key))`|(known.length > 5 && key.includes(known)) ||
CLAIM|12|一致|apps/control-center/src/memory-import.ts:38（4d139c528^）|整理文字的 `normalizeMemoryText` 里有 `.replace(/^(?:我的｜我｜主人的｜主人｜用户的｜用户)/, "")`|.replace(/^(?:我的|我|主人的|主人|用户的|用户)/, "")
CLAIM|13|一致|apps/agent-service/src/production-memory-control.ts:1512|`#importCommit`（第 1512 行起）|async #importCommit(command: Command<"memory.import.commit">) {
CLAIM|14|一致|apps/agent-service/src/production-memory-control.ts:1518|逐条检查内容是否存在|const payload = await this.options.payloads.get(item.contentRef);
CLAIM|15|一致|apps/agent-service/src/production-memory-control.ts:1521|是否可存|this.assertStorable(await this.readText(item.contentRef));
CLAIM|16|一致|apps/agent-service/src/production-memory-control.ts:1515|没有任何与已有记忆比较的步骤|const existing = await this.options.book.listImportBatches({ ...scope, limit: 1000 });
CLAIM|17|一致|apps/agent-service/src/production-memory-control.ts:1533|所以网页漏判的条目会原样存成第二条|id: `memory:import:${batchId}:${ordinal}` as MemoryId,
CLAIM|18|一致|apps/agent-service/src/production-memory-episodes.ts:23|`apps/agent-service/src/production-memory-episodes.ts` 第 23 到 27 行的 `embedWithin(request, slot, operation)`|readonly embedWithin?: <T>(
CLAIM|19|一致|apps/agent-service/src/service-main.ts:1688|向量化要带运行上下文和执行租约|executionLease: request.executionLease,
CLAIM|20|一致|docs/adr/0260-memory-classification-on-the-server.md:51|网页分类导入条目的做法是 ADR 0260：网页把文字存成受保护内容，把引用发给服务端，服务端读出文字再处理|网页把每条文字先按确定性检测的级别存成受保护的内容，再把引用（最多 500 条）发给服务端；服务端读出文字，逐条回答类别
CLAIM|21|一致|scripts/check-egress-redaction.mjs:216|`scripts/check-egress-redaction.mjs` 要求每个对外发文字的文件登记，并调用 `redactForExternalText`|`${relative}: 发往外部服务（${name}）前要先遮敏感值，缺少 ${required}(…) 调用`,
CLAIM|22|一致|.claude/rules/prompt-prefix.md:35|`.claude/rules/prompt-prefix.md` 第 4、6 条|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**
CLAIM|23|一致|packages/application/src/ports/configuration.ts:358|两个数都是配置项，写在服务配置里|readonly importDuplicates?: ImportDuplicateConfiguration;
CLAIM|24|一致|apps/control-center/src/memory.ts:250|网页上没有改它们的界面|const importDuplicates = async (
CLAIM|25|一致|packages/application/src/ports/configuration.ts:312|范围和默认值写在 `packages/application/src/ports/configuration.ts` 的 `IMPORT_DUPLICATE_DEFAULTS` 和 `IMPORT_DUPLICATE_RANGES`|export const IMPORT_DUPLICATE_DEFAULTS: ImportDuplicateTuning = Object.freeze({
CLAIM|26|一致|scripts/check-egress-redaction.mjs:100|`packages/platform-node/src/memory-import-duplicate-decision.ts` 已在出口遮盖检查里登记|["packages/platform-node/src/memory-import-duplicate-decision.ts", ["redactForExternalText"]],
CLAIM|27|一致|apps/control-center/src/memory-import.ts:54|同一批导入里完全相同的两行，仍按“去空白、转小写后相等”去重，这是格式处理，不是判断意思|const key = normalizeMemoryText(line);

未核实：Jev 接口的 3237 输入 token、0.000135954 美元费用、冒烟测试的 100%/100%/100%/88%/100%/48%/15% 等实测数字，以及 Mem0 的第三方做法，均属外部或实测资料；这些不属于仓库代码/文档现状，未在本次核对范围内。
