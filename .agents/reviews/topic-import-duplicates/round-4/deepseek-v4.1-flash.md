CLAIM|1|一致|apps/control-center/src/i18n/resources/zh-CN.ts:743|导入记忆时，网页要标出哪些条目主人已经存过|"{f, select, duplicate {已经记着，跳过} classifying {分类中…} unclassified {分类失败，已先保密，默认不导入} sensitive {敏感，默认不导入} similar {可能已经记着，默认不导入} unchecked {没能核对是否重复，默认不导入} other {写代码的经验，默认不导入}}",
CLAIM|2|一致|apps/control-center/src/components/memory-page.tsx:2064|标出来的条目不能勾选|item.duplicate ||
CLAIM|3|一致|apps/control-center/src/components/memory-page.tsx:2035|标出来的条目也不会导入|const chosen = items.filter((item) => item.checked);
CLAIM|4|一致|apps/control-center/src/memory-import.ts:45（4d139c528^）|原先网页用字符串相等或包含来判断|known === key ||
CLAIM|5|一致|apps/control-center/src/memory-import.ts:37（4d139c528^）|去空白|.replace(/\s+/g, "")
CLAIM|6|一致|apps/control-center/src/memory-import.ts:38（4d139c528^）|去开头的“我的”“主人”“用户”一类称呼|.replace(/^(?:我的|我|主人的|主人|用户的|用户)/, "")
CLAIM|7|一致|apps/control-center/src/memory-import.ts:40（4d139c528^）|转小写|.toLowerCase();
CLAIM|8|一致|apps/control-center/src/memory-import.ts:45（4d139c528^）|两条相等|known === key ||
CLAIM|9|一致|apps/control-center/src/memory-import.ts:46（4d139c528^）|其中一条（长度超过 5）包含另一条，就算重复|(known.length > 5 && key.includes(known)) ||
CLAIM|10|一致|apps/control-center/src/memory-import.ts:47（4d139c528^）|或者其中一条（长度超过 5）包含另一条|(key.length > 5 && known.includes(key)),
CLAIM|11|一致|apps/control-center/src/memory-import.ts:42（4d139c528^）|原先的判重在网页|function isDuplicate(key: string, existing: readonly string[]) {
CLAIM|12|一致|apps/control-center/src/memory-import.ts:42（4d139c528^）|改动前的 `apps/control-center/src/memory-import.ts` 第 42 到 49 行 `isDuplicate`|function isDuplicate(key: string, existing: readonly string[]) {
CLAIM|13|一致|apps/control-center/src/memory-import.ts:46（4d139c528^）|其中 `(known.length > 5 && key.includes(known))`|(known.length > 5 && key.includes(known)) ||
CLAIM|14|一致|apps/control-center/src/memory-import.ts:47（4d139c528^）|`(key.length > 5 && known.includes(key))`|(key.length > 5 && known.includes(key)),
CLAIM|15|一致|apps/control-center/src/memory-import.ts:38（4d139c528^）|整理文字的 `normalizeMemoryText` 里有 `.replace(/^(?:我的|我|主人的|主人|用户的|用户)/, "")`|.replace(/^(?:我的|我|主人的|主人|用户的|用户)/, "")
CLAIM|16|一致|apps/agent-service/src/production-memory-control.ts:1548|服务端提交导入时不判重|async #importCommit(command: Command<"memory.import.commit">) {
CLAIM|17|不一致|apps/agent-service/src/production-memory-control.ts:1548|`#importCommit`（第 1512 行起）|async #importCommit(command: Command<"memory.import.commit">) {
CLAIM|18|一致|apps/agent-service/src/production-memory-control.ts:1554|逐条检查内容是否存在|const payload = await this.options.payloads.get(item.contentRef);
CLAIM|19|一致|apps/agent-service/src/production-memory-control.ts:1557|是否可存|this.assertStorable(await this.readText(item.contentRef));
CLAIM|20|一致|apps/agent-service/src/production-memory-control.ts:1551|没有任何与已有记忆比较的步骤|const existing = await this.options.book.listImportBatches({ ...scope, limit: 1000 });
CLAIM|21|一致|apps/agent-service/src/production-memory-episodes.ts:23|`apps/agent-service/src/production-memory-episodes.ts` 第 23 到 27 行的 `embedWithin(request, slot, operation)`|readonly embedWithin?: <T>(
CLAIM|22|一致|apps/agent-service/src/service-main.ts:1688|向量化要带运行上下文和执行租约|executionLease: request.executionLease,
CLAIM|23|一致|apps/control-center/src/memory.ts:260|导入是网页发来的一次性查询，没有这个上下文|queryMessage(configuration, "memory.import.duplicates.read", { contentRefs }),
CLAIM|24|一致|docs/adr/0260-memory-classification-on-the-server.md:51|网页把文字存成受保护内容，把引用发给服务端，服务端读出文字再处理|1. **新增查询 `memory.classify.read`。**网页把每条文字先按确定性检测的级别存成受保护的内容，再把引用（最多 500 条）发给服务端；服务端读出文字，逐条回答类别、`private` 或 `sensitive`、敏感时的 topic，以及是否判断失败。
CLAIM|25|一致|scripts/check-egress-redaction.mjs:221|`scripts/check-egress-redaction.mjs` 要求每个对外发文字的文件登记，并调用 `redactForExternalText`|`${relative}: 出现了没有登记的外部出口（${name}），发出前要遮敏感值，并登记到 scripts/check-egress-redaction.mjs`,
CLAIM|26|一致|.claude/rules/prompt-prefix.md:35|`.claude/rules/prompt-prefix.md` 第 4 条|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**
CLAIM|27|一致|.claude/rules/prompt-prefix.md:41|`.claude/rules/prompt-prefix.md` 第 6 条|6. **系统提示和工具按对话冻结**（[ADR 0165](../../docs/adr/0165-freeze-the-request-head-per-conversation.md)）。
CLAIM|28|一致|scripts/check-egress-redaction.mjs:100|`packages/platform-node/src/memory-import-duplicate-decision.ts` 已在出口遮盖检查里登记|["packages/platform-node/src/memory-import-duplicate-decision.ts", ["redactForExternalText"]],
CLAIM|29|一致|apps/control-center/src/memory-import.ts:55|同一批导入里完全相同的两行去重|if (seen.has(key)) return;
CLAIM|30|一致|apps/control-center/src/memory-import.ts:38|仍按“去空白、转小写后相等”去重|text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
CLAIM|31|一致|docs/adr/0115-memory-search-relevance-threshold-and-retrieval-eval.md:42|现有向量检索的召回门槛也是为对话取记忆调的|1. **记忆搜索必须有相关度门槛。** 向量这一路只留相似度不低于门槛的记忆。

Jev 的接口、返回格式、冒烟测试的概率与费用，以及 Mem0 的第三方说明，因不能上网没有核实；方案“决定”部分除明确说“已登记”的出口登记和“仍按”保留的同批去重外，其余新增或修改行为按题目要求未作为现状核对。
