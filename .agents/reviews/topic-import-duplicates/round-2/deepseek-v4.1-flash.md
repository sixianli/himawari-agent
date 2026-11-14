CLAIM|1|一致|apps/control-center/src/memory-import.ts:148|导入记忆时，网页要标出哪些条目主人已经存过|const duplicate = verdict === "same";
CLAIM|2|一致|apps/control-center/src/components/memory-page.tsx:2052|标出来的条目不能勾选|item.duplicate ||
CLAIM|3|一致|apps/control-center/src/components/memory-page.tsx:2023|标出来的条目不会导入|const chosen = items.filter((item) => item.checked);
CLAIM|4|一致|apps/control-center/src/memory-import.ts:45-47（4d139c528^）|原先网页用字符串相等或包含来判断|known === key ||
CLAIM|5|一致|apps/control-center/src/memory-import.ts:37-40（4d139c528^）|整理成同样的字（去空白、去开头的“我的”“主人”“用户”一类称呼、转小写）|.replace(/\s+/g, "")
CLAIM|6|一致|apps/control-center/src/memory-import.ts:45-47（4d139c528^）|两条相等，或者其中一条（长度超过 5）包含另一条，就算重复|(known.length > 5 && key.includes(known)) ||
CLAIM|7|一致|apps/control-center/src/memory-import.ts:42（4d139c528^）|原先的判重在网页|function isDuplicate(key: string, existing: readonly string[]) {
CLAIM|8|一致|apps/control-center/src/memory-import.ts:42-49（4d139c528^）|改动前的 memory-import.ts 第 42 到 49 行是 isDuplicate|function isDuplicate(key: string, existing: readonly string[]) {
CLAIM|9|一致|apps/control-center/src/memory-import.ts:46（4d139c528^）|其中包含 (known.length > 5 && key.includes(known))|(known.length > 5 && key.includes(known)) ||
CLAIM|10|一致|apps/control-center/src/memory-import.ts:47（4d139c528^）|其中包含 (key.length > 5 && known.includes(key))|(key.length > 5 && known.includes(key)),
CLAIM|11|一致|apps/control-center/src/memory-import.ts:38（4d139c528^）|normalizeMemoryText 里有 .replace(/^(?:我的|我|主人的|主人|用户的|用户)/, "")|.replace(/^(?:我的|我|主人的|主人|用户的|用户)/, "")
CLAIM|12|一致|apps/agent-service/src/production-memory-control.ts:1512|服务端提交导入时 #importCommit 从第 1512 行起|async #importCommit(command: Command<"memory.import.commit">) {
CLAIM|13|一致|apps/agent-service/src/production-memory-control.ts:1518|逐条检查内容是否存在|const payload = await this.options.payloads.get(item.contentRef);
CLAIM|14|一致|apps/agent-service/src/production-memory-control.ts:1521|逐条检查是否可存|this.assertStorable(await this.readText(item.contentRef));
CLAIM|15|一致|apps/agent-service/src/production-memory-control.ts:1512-1542|没有任何与已有记忆比较的步骤|async #importCommit(command: Command<"memory.import.commit">) {
CLAIM|16|一致|apps/agent-service/src/production-memory-episodes.ts:23-27|production-memory-episodes.ts 第 23 到 27 行是 embedWithin(request, slot, operation)|readonly embedWithin?: <T>(
CLAIM|17|一致|apps/agent-service/src/service-main.ts:1688|向量化要带运行上下文和执行租约|executionLease: request.executionLease,
CLAIM|18|一致|apps/agent-service/src/production-memory-control.ts:1338|导入是网页发来的一次性查询，没有这个上下文|const refs = query.payload.contentRefs;
CLAIM|19|一致|docs/adr/0260-memory-classification-on-the-server.md:51|网页分类导入条目的做法是网页把文字存成受保护内容，把引用发给服务端，服务端读出文字再处理|网页把每条文字先按确定性检测的级别存成受保护的内容，再把引用（最多 500 条）发给服务端；服务端读出文字，逐条回答类别、
CLAIM|20|一致|scripts/check-egress-redaction.mjs:97-110|scripts/check-egress-redaction.mjs 要求每个对外发文字的文件登记，并调用 redactForExternalText|["packages/platform-node/src/memory-import-duplicate-decision.ts", ["redactForExternalText"]],
CLAIM|21|一致|.claude/rules/prompt-prefix.md:35|发给模型的对话请求只追加：第 4 条|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**
CLAIM|22|一致|.claude/rules/prompt-prefix.md:41|发给模型的对话请求只追加：第 6 条|6. **系统提示和工具按对话冻结**
CLAIM|23|一致|packages/prompt-catalog/src/memory.ts:115|MEMORY_IMPORT_DUPLICATE_QUESTION 写明两条表达的事实一样才算，用词不同也算；只是话题相关，或者其中一条多了另一条没有的新信息，都不算|“同一件事”指两条表达的事实一样，哪怕用词不同，例如“对乳制品不耐受”和“喝不了牛奶”；只是话题相关，或者其中一条多了另一条没有的新信息，都不算同一件事。
CLAIM|24|一致|packages/application/src/ports/configuration.ts:313|所选条目的概率达到 70% 判 same，这个门槛是配置项，默认 700‰|yesAtLeastPermille: 700,
CLAIM|25|一致|packages/application/src/ports/configuration.ts:314|高于 30% 但不到 70% 判 unsure，这个门槛是配置项，默认 300‰|noAtMostPermille: 300,
CLAIM|26|一致|packages/application/src/ports/configuration.ts:312|默认值写在 IMPORT_DUPLICATE_DEFAULTS|export const IMPORT_DUPLICATE_DEFAULTS: ImportDuplicateTuning = Object.freeze({
CLAIM|27|一致|packages/application/src/ports/configuration.ts:323|范围写在 IMPORT_DUPLICATE_RANGES|export const IMPORT_DUPLICATE_RANGES: Readonly<
CLAIM|28|找不到|-|两个数主人能看到、能改|-
CLAIM|29|一致|apps/control-center/src/i18n/resources/zh-CN.ts:743|same 标“已经记着，跳过”、unsure 标“可能已经记着，默认不导入”、skipped 标“没能核对是否重复，默认不导入”|"{f, select, duplicate {已经记着，跳过} classifying {分类中…} unclassified {分类失败，已先保密，默认不导入} sensitive {敏感，默认不导入} similar {可能已经记着，默认不导入} unchecked {没能核对是否重复，默认不导入} other {写代码的经验，默认不导入}}",
CLAIM|30|一致|apps/control-center/src/components/memory-page.tsx:2051-2055|same 条目不能勾选，unsure 条目主人可以自己勾|item.duplicate ||
CLAIM|31|一致|apps/agent-service/src/production-memory-import-duplicates.ts:124-126|网络、额度、响应格式、模型拒答，任何一环失败，对应条目判 skipped|for (const index of job.group) incomplete.add(index);
CLAIM|32|一致|apps/agent-service/src/production-memory-import-duplicates.ts:90|确定性检测命中的条目（证件号、卡号、密码等）不发给模型，也判 skipped|if (!deterministicallySensitive(text)) asked.push(index);
CLAIM|33|一致|apps/agent-service/src/production-memory-import-duplicates.ts:129-131|一次查询最多发 150 个请求，超过的条目判 skipped|const allowed = jobs.slice(0, this.#settings.maximumRequests);
CLAIM|34|一致|packages/application/src/ports/configuration.ts:320|每个请求 15 秒超时|requestTimeoutMs: 15_000,
CLAIM|35|一致|apps/agent-service/src/production-memory-control.ts:1366|服务端取已有记忆时排除敏感和受限|if (record.dataClassification === "sensitive" || record.dataClassification === "restricted")
CLAIM|36|一致|apps/agent-service/src/production-memory-control.ts:1363|已有记忆最近改过的在前|b.updatedAt.localeCompare(a.updatedAt),
CLAIM|37|一致|apps/agent-service/src/production-memory-import-duplicates.ts:93|已有记忆最多 1000 条|.slice(0, this.#settings.maximumExistingMemories)
CLAIM|38|一致|apps/agent-service/src/production-memory-import-duplicates.ts:94|已有记忆换成 m0、m1 这样的临时编号|.map(({ memoryId, text }, position) => ({ key: `m${position}`, memoryId, text }));
CLAIM|39|一致|packages/application/src/ports/configuration.ts:315|已有记忆每 200 条分一批|existingPerRequest: 200,
CLAIM|40|一致|packages/application/src/ports/configuration.ts:316|或 30000 个字符分一批|existingCharactersPerRequest: 30_000,
CLAIM|41|一致|packages/application/src/ports/configuration.ts:317|导入条目每 20 个一组|candidatesPerRequest: 20,
CLAIM|42|一致|apps/agent-service/src/production-memory-import-duplicates.ts:121|同一个条目取各批里概率最高的答案|if (!current || answer.probabilityPermille > current.probabilityPermille)
CLAIM|43|一致|apps/agent-service/src/production-memory-import-duplicates.ts:31|每个导入条目的选项是已有记忆的编号|...input.existing.map(({ key }) => ({ value: key })),
CLAIM|44|一致|apps/agent-service/src/production-memory-import-duplicates.ts:32|选项加 none|{ value: IMPORT_DUPLICATE_NONE },
CLAIM|45|一致|packages/application/src/ports/configuration.ts:306-309|runPolicy.importDuplicates 写模型名、密钥引用和每百万输入 token 的价格|readonly inputMicrosPerMillionTokens: number;
CLAIM|46|一致|packages/platform-node/src/strict-configuration.ts:1776|密钥引用必须指向一条用途是 model-auth 的密钥|"model-auth",
CLAIM|47|一致|apps/agent-service/src/production-memory-control.ts:1347|配置里没有这一项时，这个查询返回全部 skipped|verdict: results?.[index]?.verdict ?? "skipped",
CLAIM|48|一致|apps/control-center/src/memory.ts:253|没配置时网页全部默认不导入、标没能核对，不会回到词表|if (!operations.includes("memory.import.duplicates.read")) return texts.map(() => "skipped");
CLAIM|49|一致|packages/platform-node/src/memory-import-duplicate-decision.ts:45|请求体里的文字先过 redactForExternalText|text: redactForExternalText(text, options).text,
CLAIM|50|一致|packages/platform-node/src/memory-import-duplicate-decision.ts:64|模型走 zeroDataRetention: true|providerOptions: { gateway: { zeroDataRetention: true } },
CLAIM|51|一致|scripts/check-egress-redaction.mjs:86|packages/platform-node/src/memory-import-duplicate-decision.ts 已在出口遮盖检查里登记|"packages/platform-node/src/memory-import-duplicate-decision.ts",
CLAIM|52|一致|apps/control-center/src/memory-import.ts:38|同一批导入里完全相同的两行，仍按“去空白、转小写后相等”去重|text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
CLAIM|53|一致|apps/agent-service/src/production-memory-control.ts:1366|已有的敏感记忆不参与比较|if (record.dataClassification === "sensitive" || record.dataClassification === "restricted")
CLAIM|54|一致|apps/agent-service/src/production-memory-control.ts:1363|已有记忆超过 1000 条时，最早改动的那些不参与比较|b.updatedAt.localeCompare(a.updatedAt),
CLAIM|55|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|判断两句话是不是同一件事一律交给模型（ADR 0249）|理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典
CLAIM|56|一致|docs/incidents-and-gates.md:133|这一处是清查词表时发现的遗漏（起因记在 [I-100](../incidents-and-gates.md#incidents)）|I-100 | 2026-11-13 | Andy 问“怎么现在还有用词表判断的”

未核对的部分：Jev 的外部接口、实测概率/费用等属于第三方服务或实验数据，未在仓库内核对；配置项“主人能看到、能改”未找到对应界面或编辑入口。方案中删除 docs 词表行、上线时新增生产配置等未来动作未按现状口径计入。
