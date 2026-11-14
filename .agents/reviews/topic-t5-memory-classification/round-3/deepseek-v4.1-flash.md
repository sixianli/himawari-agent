CLAIM|1|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户的意思一律交给模型判断，不用关键词表、正则或写死的词典。|Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典。
CLAIM|2|一致|apps/control-center/src/memory-import.ts:90（b55101ec8^）|网页上“添加记忆”和“导入记忆”原先用 `guessCategory` 这张词表猜类别和是否敏感|const guess = guessCategory(line);
CLAIM|3|一致|apps/control-center/src/memory-import.ts:30（b55101ec8^）|例如见到“药”就归“健康”并标敏感|if (/过敏|药|血压|病|医院|allerg|medic/i.test(text))     return { category: "health", sensitive: true };
CLAIM|4|一致|apps/control-center/src/memory-import.ts:30（b55101ec8^）|“我不吃药”也会被标成健康敏感|if (/过敏|药|血压|病|医院|allerg|medic/i.test(text))
CLAIM|5|一致|apps/control-center/src/memory-import.ts:98（b55101ec8^）|导入时还用一条正则猜一行是不是“规矩”|? RULE.test(line)
CLAIM|6|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|设计线程的整合方案把它列为任务 T5，Andy 同意|设计线程的整合方案（两个低价模型各出方案、互相审核、线程核对代码后整合）把它们拆成任务 T1 到 T6，Andy 同意
CLAIM|7|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|ADR 0249 记了 T1 到 T4，并写明 T5 另记|本 ADR 记 T1 到 T4：共用的判断辅助、待确认规矩的确认裁判、邮件单号抽取、评测防泄露。分类与敏感判断（T5）、搜记忆的时间范围（T6）各有自己的取舍，另记。
CLAIM|8|一致|apps/control-center/src/memory-import.ts:29（b55101ec8^）|网页原先的词表：`apps/control-center/src/memory-import.ts` 的 `guessCategory`|export function guessCategory(text: string): { category: MemoryCategory; sensitive: boolean } {
CLAIM|9|一致|apps/control-center/src/memory-import.ts:24（b55101ec8^）|以及同文件的 `RULE` 正则|const RULE = /不要|别|一律|每次|以后|总是|先.+再|never|always|don't|do not/i;
CLAIM|10|一致|apps/control-center/src/components/memory-page.tsx:2254（b55101ec8^）|添加表单在 `apps/control-center/src/components/memory-page.tsx` 的 `AddForm` 里用 `guessCategory(text).category` 实时填类别|const category = picked ?? guessCategory(text).category;
CLAIM|11|一致|apps/control-center/src/memory.ts:179|记忆的敏感级别在浏览器调用 `protectText` 时就定了|const ref = await client.protectText(text, level);
CLAIM|12|一致|packages/gateway-contracts/src/contracts-v2.ts:1731（b55101ec8^）|`memory.create` 和 `memory.import.commit` 的契约原先没有 topic 字段（`packages/gateway-contracts/src/contracts-v2.ts` 的 `memoryCreateCommandSchema`、`memoryImportItemsSchema`）|contentRef: machineString, category: enumeration(MEMORY_CATEGORY_NAMES), subCategory: nullable(memoryLabelSchema), pinned: booleanValue,
CLAIM|13|一致|apps/agent-service/src/production-memory-control.ts:1034（b55101ec8^）|服务端存敏感记忆时只能按类别推 topic|? { sensitiveTopic: sensitiveTopicFor(input.category) }
CLAIM|14|一致|apps/agent-service/src/production-memory-control.ts:116|`production-memory-control.ts` 的 `sensitiveTopicFor`，健康和财务以外都成了 other|return category === "health" || category === "finance" ? category : "other";
CLAIM|15|一致|apps/agent-service/src/production-memory-control.ts:1178|敏感记忆不能改类别|current.dataClassification === "sensitive" ||
CLAIM|16|一致|apps/agent-service/src/production-memory-control.ts:1182|`production-memory-control.ts` 的 `#setCategory` 抛 `MEMORY_CATEGORY_LOCKED`|throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_CATEGORY_LOCKED");
CLAIM|17|一致|apps/agent-service/src/production-memory-capture.ts:381|对话里自动记下的记忆，敏感级别由模型给|value["classification"] === "sensitive" || value["classification"] === "restricted"
CLAIM|18|一致|apps/agent-service/src/production-memory-capture.ts:377|程序再用 `classificationWithIdentifiers` 取高|const requested = classificationWithIdentifiers(
CLAIM|19|一致|apps/agent-service/src/production-memory-capture.ts:291|`apps/agent-service/src/production-memory-capture.ts` 的 `parseMemoryCandidates`|export function parseMemoryCandidates(input: {
CLAIM|20|一致|packages/prompt-catalog/src/memory.ts:6|“classification”的写法在 `packages/prompt-catalog/src/memory.ts` 的 `MEMORY_FIELD_RULES`|classification:
CLAIM|21|一致|packages/prompt-catalog/src/memory.ts:7|“topic”的写法在 `packages/prompt-catalog/src/memory.ts` 的 `MEMORY_FIELD_RULES`|并在 topic 里填 health、finance、beliefs、intimacy、third_party、location、legal 之一
CLAIM|22|一致|packages/sensitive-capture/src/identifiers.ts:25|证件号、银行卡号、密码、密钥的确定性检测是程序做的安全过滤|(containsRestrictedIdentifier(text) || containsCredential(text))
CLAIM|23|一致|packages/sensitive-capture/src/identifiers.ts:20|`packages/sensitive-capture/src/identifiers.ts` 的 `classificationWithIdentifiers`|export function classificationWithIdentifiers<T extends string>(
CLAIM|24|一致|packages/sensitive-capture/src/identifiers.ts:33|`mentionsSensitiveMaterial`|export function mentionsSensitiveMaterial(text: string): boolean {
CLAIM|25|一致|apps/agent-service/src/production-model-composition.ts:500|网页这一侧的服务进程里，后台模型调用的现成做法是 `proactiveModel`|const proactiveModel = (
CLAIM|26|一致|apps/agent-service/src/production-real-eval.ts:280|加 `createRealEvalModel`|export function createRealEvalModel(options: {
CLAIM|27|一致|apps/agent-service/src/production-model-composition.ts:468|它们经同一条模型传输层发出|transport: new PiModelTransport({
CLAIM|28|一致|packages/runtime-pi/src/pi-model-transport.ts:313|出口遮盖在 `packages/runtime-pi/src/pi-model-transport.ts` 的 `exchange.wrapFetch`|const redactingFetch = exchange.wrapFetch(this.#fetch);
CLAIM|29|一致|packages/persistence-sqlite/src/migrations/0091_decision_prereviews.sql:88|模型用量表 `model_usage_observations` 的 `purpose` 列有 CHECK 约束，只认现有的几个值|purpose TEXT NOT NULL CHECK (     purpose IN (       'chat', 'thread-title', 'memory-capture', 'memory-episode',
CLAIM|30|一致|.claude/rules/prompt-prefix.md:35|请求开头只追加：`.claude/rules/prompt-prefix.md` 第 4、6 条|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**

方案中协调者限定的范围、网页不加新操作、iPhone 端纠正界面和“改表要排队”属于流程或产品安排，仓库里没有可直接核对的代码或文档，未作为代码现状列入上面的 CLAIM；其余列出的说法均已在当前文件或 b55101ec8^ 的历史文件中读到证据。
