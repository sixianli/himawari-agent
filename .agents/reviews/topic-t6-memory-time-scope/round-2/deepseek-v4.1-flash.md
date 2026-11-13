CLAIM|1|一致|packages/memory-engine/src/time-scope.ts:240,264（8e59634ca）|问题里的“上周三”“去年”“以前”原先由 `parseTimeScope`（一组正则）换算成时间范围|take(/(上上|上|这|本|下)\s*(?:个)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/u, (m) => {\ntake(/去年/u, () => yearRange(today.year - 1, timeZone));
CLAIM|2|一致|apps/agent-service/src/production-memory-recall.ts:159,181（8e59634ca）|模型在 recall 工具里填了 from、to 时用模型的，没填时用正则兜底|const parsed = parseTimeScope(input.query, now, timeZone);\nincludeHistory: input.includeHistory || parsed?.includeHistory === true,
CLAIM|3|找不到|-|设计线程的整合方案把它列为任务 T6|-|
CLAIM|4|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|ADR 0249 写明 T6 另记|分类与敏感判断（T5）、搜记忆的时间范围（T6）各有自己的取舍，另记。
CLAIM|5|找不到|-|正则的两处生产调用|-|
CLAIM|6|一致|apps/agent-service/src/production-memory-recall.ts:159（8e59634ca）|改动前 `apps/agent-service/src/production-memory-recall.ts` 第 159 行 `const parsed = parseTimeScope(input.query, now, timeZone);`（工具没填日期时兜底）|const parsed = parseTimeScope(input.query, now, timeZone);
CLAIM|7|一致|packages/memory-engine/src/hybrid-memory-provider.ts:166（8e59634ca）|`packages/memory-engine/src/hybrid-memory-provider.ts` 第 166 行 `const scope = input.scope ?? parseTimeScope(...)`（调用方没给范围时兜底）|const scope = input.scope ?? parseTimeScope(input.query, now, this.#options.timeZone);
CLAIM|8|一致|apps/agent-service/src/production-run-memory.ts:450；packages/application/src/services/durable-memory-service.ts:423|每轮自动召回也走这里|const found = await options.memory.search({\nconst providerHits = await this.options.provider.search({
CLAIM|9|一致|apps/agent-service/src/production-memory-recall.ts:37-39（8e59634ca）|recall 工具早已让模型填日期|from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },\nto: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },\nincludeHistory: { type: "boolean" },
CLAIM|10|一致|packages/prompt-catalog/src/tools.ts:36（8e59634ca）|`TOOL_RECALL` 原话“问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）；问以前的情况时 includeHistory 填 true”|text: "查主人的长期记忆和以前的对话摘要。主人问到以前说过的事、某天或某段时间发生过什么、以前的情况（换手机前、搬家前）时使用。query 写要找的内容；问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）；问以前的情况时 includeHistory 填 true。返回的记忆带有效期，已失效的标为历史；对话摘要按日期给出。只查主人自己的记忆，不会联网。",
CLAIM|11|一致|apps/agent-service/src/production-mcp-read.ts:501-502（8e59634ca）|对外 MCP 工具 `find_memories` 已有 from、to|from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },\nto: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
CLAIM|12|一致|apps/agent-service/src/production-mcp-read.ts:500-503（8e59634ca）|没有 includeHistory：`apps/agent-service/src/production-mcp-read.ts` 第 501 行起的参数定义|query: { type: "string", minLength: 1, maxLength: 500 },\nfrom: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },\nto: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },\nlimit: { type: "integer", minimum: 1, maximum: 10 },
CLAIM|13|一致|.claude/rules/prompt-prefix.md:43|改提示词文字只对新对话生效|改了提示词文字，**只对新对话生效**。要让老对话也用上，必须手动换新。
CLAIM|14|一致|.claude/rules/prompt-prefix.md:53|老对话里冻结的旧文字从此按外来内容检查（同文件第 53 行）|以后改了提示词文字，老对话里冻结的旧文字不再在清单里，按外来内容检查；
CLAIM|15|一致|packages/prompt-catalog/src/tools.ts:36（8e59634ca）|旧 recall 说明里没有会被认成敏感信息的数字|text: "查主人的长期记忆和以前的对话摘要。主人问到以前说过的事、某天或某段时间发生过什么、以前的情况（换手机前、搬家前）时使用。query 写要找的内容；问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）；问以前的情况时 includeHistory 填 true。返回的记忆带有效期，已失效的标为历史；对话摘要按日期给出。只查主人自己的记忆，不会联网。",
CLAIM|16|一致|test/fixtures/memory-evaluation/dataset.json:2-3|检索评测集：`test/fixtures/memory-evaluation/dataset.json`|"version": 2,\n"now": "2026-10-25T12:00:00.000Z",
CLAIM|17|一致|test/fixtures/memory-evaluation/dataset.json:2064-2162|时间相关的题是 temporal 15 题|"ability": "temporal",
CLAIM|18|一致|test/fixtures/memory-evaluation/dataset.json:2273-2351|history 10 题|"ability": "history",
CLAIM|19|一致|test/fixtures/memory-evaluation/dataset.json:2353-2443|time_window 12 题|"ability": "time_window",
CLAIM|20|一致|test/fixtures/memory-evaluation/dataset.json:2450-2506|episode 8 题|"ability": "episode",
CLAIM|21|一致|test/integration/memory-evaluation.test.ts:634|第二阶段关口在 `test/integration/memory-evaluation.test.ts` 的“answers history, time-window and past-conversation questions”用例|it("answers history, time-window and past-conversation questions that phase one could not", async () => {
CLAIM|22|一致|evals/memory-time-scope/result.json:6|模型：`deepseek-v4.1-flash`|"deepseek-v4.1-flash": {
CLAIM|23|一致|evals/memory-time-scope/result.json:10,17|45 道时间类题每题两遍|"calls": 90\n"total": 45
CLAIM|24|一致|evals/memory-time-scope/result.json:20|模型回答记在 `evals/memory-time-scope/result.json`|"outcomes": [
CLAIM|25|一致|evals/memory-time-scope/result.json:10|90 次调用|"calls": 90
CLAIM|26|一致|evals/memory-time-scope/result.json:4|约 0.01 美元|"spentUsd": 0.009947256,
CLAIM|27|找不到|-|补说明之前另跑过一次，记录被这次覆盖，过程写在 PR 467 的说明里|-|
CLAIM|28|一致|test/fixtures/memory-evaluation/embeddings-4096.json:1|检索用评测集自带的 4096 维真实向量|{"model":"alibaba/qwen3-embedding-8b","dimensions":4096,"encoding":"float16-base64","vectors":{
CLAIM|29|一致|test/integration/memory-evaluation.test.ts:41|数字是前 5 条召回率|const TOP_K = 5;
CLAIM|30|一致|test/integration/memory-evaluation.test.ts:232|括号里是“问现在时旧记忆没排到前面”的比例|? Number(stale > rank(question.relevant) || !Number.isFinite(stale))
CLAIM|31|找不到|-|正则 ｜ 1.00（1.00） ｜ 1.00 ｜ 1.00 ｜ 1.00|-|
CLAIM|32|找不到|-|不给时间范围 ｜ 1.00（1.00） ｜ 0.00 ｜ 0.00 ｜ 1.00|-|
CLAIM|33|找不到|-|模型 ｜ 1.00（0.91） ｜ 0.90–1.00 ｜ 1.00 ｜ 0.875–1.00|-|
CLAIM|34|一致|evals/memory-time-scope/result.json:16-17|两遍填得完全相同的题 30/45|"sameAcrossRuns": 30,\n"total": 45
CLAIM|35|一致|evals/memory-time-scope/result.json:4|补这一句花费不到 1 分钱|"spentUsd": 0.009947256,
CLAIM|36|一致|evals/memory-time-scope/result.json:25|实测里模型对 45 个时间类问题全部调了 recall|"called": true,
CLAIM|37|一致|evals/memory-time-scope/result.json:686-688|“问以前”偶尔漏填 includeHistory|"questionId": "q208",\n"called": true,\n"scope": {},
CLAIM|38|一致|packages/persistence-sqlite/src/sqlite-memory-operations.ts:281|旧记忆不会出现|AND (@includeHistory = 1 OR m.valid_to IS NULL OR m.valid_to > @now)`;
CLAIM|39|一致|evals/memory-time-scope/result.json:102-105|“问现在”偶尔多填|"questionId": "q109",\n"scope": {\n"includeHistory": true\n},
CLAIM|40|一致|apps/agent-service/src/production-memory-recall.ts:259；packages/prompt-catalog/src/background.ts:109|已失效的旧记忆会带“历史”标记一起返回|current: validTo === null || validTo > now,\ncurrent 为 false 的记忆是以前的情况，回答时说明时间。
CLAIM|41|一致|.claude/rules/prompt-prefix.md:43|老对话冻结的是旧的 recall 说明，要新对话才用上补的那一句|改了提示词文字，**只对新对话生效**。要让老对话也用上，必须手动换新。
CLAIM|42|一致|apps/agent-service/src/production-run-memory.ts:450；packages/memory-engine/src/hybrid-memory-provider.ts:183|每轮自动召回不再按时间过滤|const found = await options.memory.search({\nscope: input.scope ?? null,

未核实：PR 467 的说明、补说明前被覆盖的那次记录、实测检索召回率表格的具体数值（仓库内没有检索报告，result.json 只有模型填参、调用次数和费用），以及正则是否确实只有两处生产调用。另：前提 1 至 3 和背景里标“改动前/已有/没有”的说法按父提交 8e59634ca 核对；当前 5d44ce 已实施这些改动（parseTimeScope 已删、find_memories 已有 includeHistory）。
