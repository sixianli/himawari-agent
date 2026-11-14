CLAIM|1|一致|apps/control-center/src/components/memory-page.tsx:2090|导入记忆时，网页要标出哪些条目主人已经存过|f: item.duplicate
CLAIM|2|一致|apps/control-center/src/components/memory-page.tsx:2064|标出来的条目不能勾选|item.duplicate ||
CLAIM|3|一致|apps/control-center/src/components/memory-page.tsx:2035|也不会导入|const chosen = items.filter((item) => item.checked);
CLAIM|4|一致|apps/control-center/src/memory-import.ts:45（5d44ce370 改动前）|原先网页用字符串相等或包含来判断|known === key ||
CLAIM|5|一致|apps/control-center/src/memory-import.ts:46（5d44ce370 改动前）|原先网页用字符串相等或包含来判断|(known.length > 5 && key.includes(known)) ||
CLAIM|6|一致|apps/control-center/src/memory-import.ts:47（5d44ce370 改动前）|原先网页用字符串相等或包含来判断|(key.length > 5 && known.includes(key)),
CLAIM|7|一致|apps/control-center/src/memory-import.ts:37（5d44ce370 改动前）|整理成同样的字（去空白）|.replace(/\s+/g, "")
CLAIM|8|一致|apps/control-center/src/memory-import.ts:38（5d44ce370 改动前）|整理成同样的字（去开头的“我的”“主人”“用户”一类称呼）|.replace(/^(?:我的|我|主人的|主人|用户的|用户)/, "")
CLAIM|9|一致|apps/control-center/src/memory-import.ts:40（5d44ce370 改动前）|整理成同样的字（转小写）|.toLowerCase();
CLAIM|10|一致|apps/control-center/src/memory-import.ts:45-47（5d44ce370 改动前）|两条相等，或者其中一条（长度超过 5）包含另一条，就算重复|(known.length > 5 && key.includes(known)) ||
CLAIM|11|一致|apps/control-center/src/memory-import.ts:45-47（5d44ce370 改动前）|换一种说法就漏掉，例如“对乳制品不耐受”和“喝不了牛奶”|known === key ||
CLAIM|12|一致|apps/control-center/src/memory-import.ts:46（5d44ce370 改动前）|字面上碰巧包含却说的是别的事，又会被误当成重复，例如已有“回答一律用简体中文”，导入“回答一律用简体中文，并且先给结论”，后一条多出来的要求就被丢了|(known.length > 5 && key.includes(known)) ||
CLAIM|13|找不到|-|这一处是清查词表时发现的遗漏|-|-
CLAIM|14|一致|docs/incidents-and-gates.md:133|起因记在 I-100|Andy 问“怎么现在还有用词表判断的”
CLAIM|15|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|Andy 2026-11-12 定|Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典。
CLAIM|16|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:63|判断两句话是不是同一件事一律交给模型（ADR 0249）|LongMemEval 一类评测和 Mem0 的记忆更新，都让模型判断“两句话是不是同一件事”，程序负责校验结构和原文出处；OpenAI、Anthropic 的结构化输出指南是“模型给结构化答案，程序校验模式和业务规则”。本 ADR 照这个做法：意思交给模型，逐字核对、格式、白名单、额度仍由程序把关。
CLAIM|17|一致|apps/control-center/src/memory-import.ts:42（5d44ce370 改动前）|原先的判重在网页：改动前的 `apps/control-center/src/memory-import.ts` 第 42 到 49 行 `isDuplicate`|function isDuplicate(key: string, existing: readonly string[]) {
CLAIM|18|一致|apps/control-center/src/memory-import.ts:46（5d44ce370 改动前）|其中 `(known.length > 5 && key.includes(known))`|(known.length > 5 && key.includes(known)) ||
CLAIM|19|一致|apps/control-center/src/memory-import.ts:47（5d44ce370 改动前）|其中 `(key.length > 5 && known.includes(key))`|(key.length > 5 && known.includes(key)),
CLAIM|20|一致|apps/control-center/src/memory-import.ts:38（5d44ce370 改动前）|整理文字的 `normalizeMemoryText` 里有 `.replace(/^(?:我的｜我｜主人的｜主人｜用户的｜用户)/, "")`|.replace(/^(?:我的|我|主人的|主人|用户的|用户)/, "")
CLAIM|21|一致|apps/agent-service/src/production-memory-control.ts:1575|服务端提交导入时不判重|await this.#createMemory({
CLAIM|22|一致|apps/agent-service/src/production-memory-control.ts:1555|`#importCommit`（第 1555 行起）|async #importCommit(command: Command<"memory.import.commit">) {
CLAIM|23|一致|apps/agent-service/src/production-memory-control.ts:1561|逐条检查内容是否存在|const payload = await this.options.payloads.get(item.contentRef);
CLAIM|24|一致|apps/agent-service/src/production-memory-control.ts:1564|是否可存|this.assertStorable(await this.readText(item.contentRef));
CLAIM|25|一致|apps/agent-service/src/production-memory-control.ts:1555-1585|没有任何与已有记忆比较的步骤|await this.#createMemory({
CLAIM|26|一致|apps/agent-service/src/production-memory-control.ts:1575|所以网页漏判的条目会原样存成第二条|await this.#createMemory({
CLAIM|27|一致|apps/agent-service/src/production-memory-control.ts:1338|现成的向量检索不能直接用在网页的导入请求上|query: Extract<GatewayV2Query, { type: "memory.import.duplicates.read" }>,
CLAIM|28|一致|apps/agent-service/src/production-memory-episodes.ts:23|向量化要带运行上下文和执行租约（`apps/agent-service/src/production-memory-episodes.ts` 第 23 到 27 行的 `embedWithin(request, slot, operation)`）|readonly embedWithin?: <T>(
CLAIM|29|一致|apps/agent-service/src/production-memory-episodes.ts:72|向量化要带运行上下文和执行租约（`embedWithin(request, slot, operation)`）|? this.#options.embedWithin(request, `${slot}:${request.runId}`, operation)
CLAIM|30|一致|apps/agent-service/src/production-memory-control.ts:1341|导入是网页发来的一次性查询，没有这个上下文|const refs = query.payload.contentRefs;
CLAIM|31|一致|docs/adr/0260-memory-classification-on-the-server.md:51|网页把文字存成受保护内容|网页把每条文字先按确定性检测的级别存成受保护的内容
CLAIM|32|一致|docs/adr/0260-memory-classification-on-the-server.md:51|把引用发给服务端|再把引用（最多 500 条）发给服务端
CLAIM|33|一致|docs/adr/0260-memory-classification-on-the-server.md:51|服务端读出文字再处理|服务端读出文字，逐条回答类别
CLAIM|34|一致|scripts/check-egress-redaction.mjs:221|`scripts/check-egress-redaction.mjs` 要求每个对外发文字的文件登记|`${relative}: 出现了没有登记的外部出口（${name}），发出前要遮敏感值，并登记到 scripts/check-egress-redaction.mjs`,
CLAIM|35|一致|scripts/check-egress-redaction.mjs:100|并调用 `redactForExternalText`|["packages/platform-node/src/memory-import-duplicate-decision.ts", ["redactForExternalText"]],
CLAIM|36|一致|.claude/rules/prompt-prefix.md:35|发给模型的对话请求只追加：`.claude/rules/prompt-prefix.md` 第 4 条|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**
CLAIM|37|一致|.claude/rules/prompt-prefix.md:41|发给模型的对话请求只追加：`.claude/rules/prompt-prefix.md` 第 6 条|6. **系统提示和工具按对话冻结**
CLAIM|38|一致|apps/control-center/src/memory-import.ts:182|它们本来就默认不导入|checked: !item.duplicate && item.duplicateCheck === "clear" && !sensitive && !item.coding,
CLAIM|39|一致|scripts/check-egress-redaction.mjs:100|`packages/platform-node/src/memory-import-duplicate-decision.ts` 已在出口遮盖检查里登记|["packages/platform-node/src/memory-import-duplicate-decision.ts", ["redactForExternalText"]],
CLAIM|40|一致|apps/control-center/src/memory-import.ts:55|同一批导入里完全相同的两行，仍按“去空白、转小写后相等”去重|if (seen.has(key)) return;
CLAIM|41|一致|apps/control-center/src/memory-import.ts:38|同一批导入里完全相同的两行，仍按“去空白、转小写后相等”去重|text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
CLAIM|42|一致|docs/meaning-word-lists.md:39-59|这两处都不在 `docs/meaning-word-lists.md` 里登记|文件 | 名字 | 类别 | 理由 | 期限
CLAIM|43|一致|apps/agent-service/src/production-memory-composition.ts:139|现有向量检索的召回门槛也是为对话取记忆调的，不是为判同一件事调的|options.configuration.memory.minimumSimilarity ?? profile.chatMinimumSimilarity;

未核对的部分：Jev 的 `/v1/decisions` 接口、冒烟测试的概率和费用属于外部服务，按要求没有核对；ADR 里“2026-11-13 补充”的日期和“还没有做正式评测”的项目状态，也没有在仓库里找到直接证据。其余说法按上述文件或提交 5d44ce370 的改动前版本核对。
