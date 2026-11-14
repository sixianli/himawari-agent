CLAIM|1|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|Andy 在 2026-11-12 定的原则是：理解用户的意思一律交给模型判断，不用关键词表、正则或写死的词典。|Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典。
CLAIM|2|一致|packages/memory-engine/src/time-scope.ts:20|搜记忆时，问题里的“上周三”“去年”“以前”原先由 parseTimeScope（一组正则）换算成时间范围。|/以前|之前|原来|过去|曾经|当初|当时|那时|那会|从前|早先|以往|上一个|上一部|上一台|前一个|旧的|老的|换.{0,6}之前|before|used to|previous/iu;
CLAIM|3|一致|apps/agent-service/src/production-memory-recall.ts:159|问题里的“上周三”“去年”“以前”原先由 parseTimeScope 换算成时间范围。|const parsed = parseTimeScope(input.query, now, timeZone);
CLAIM|4|一致|apps/agent-service/src/production-memory-recall.ts:163|模型在 recall 工具里填了 from、to 时用模型的|const scope: MemoryTimeScope = explicit；from: from ? startOfDay(from, timeZone) : null,
CLAIM|5|一致|apps/agent-service/src/production-memory-recall.ts:181|没填时用正则兜底。|includeHistory: input.includeHistory || parsed?.includeHistory === true,；from: parsed?.from ?? null,；to: parsed?.to ?? null,
CLAIM|6|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|设计线程的整合方案把它列为任务 T6|设计线程的整合方案（两个低价模型各出方案、互相审核、线程核对代码后整合）把它们拆成任务 T1 到 T6
CLAIM|7|找不到|-|要求先实测再删|-
CLAIM|8|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|ADR 0249 写明 T6 另记。|分类与敏感判断（T5）、搜记忆的时间范围（T6）各有自己的取舍，另记。
CLAIM|9|一致|apps/agent-service/src/production-memory-recall.ts:159|改动前 apps/agent-service/src/production-memory-recall.ts 第 159 行 const parsed = parseTimeScope(input.query, now, timeZone);|const parsed = parseTimeScope(input.query, now, timeZone);
CLAIM|10|一致|apps/agent-service/src/production-memory-recall.ts:181|（工具没填日期时兜底）|includeHistory: input.includeHistory || parsed?.includeHistory === true,
CLAIM|11|一致|packages/memory-engine/src/hybrid-memory-provider.ts:166|改动前 packages/memory-engine/src/hybrid-memory-provider.ts 第 166 行 const scope = input.scope ?? parseTimeScope(...)|const scope = input.scope ?? parseTimeScope(input.query, now, this.#options.timeZone);
CLAIM|12|一致|packages/memory-engine/src/hybrid-memory-provider.ts:166|（调用方没给范围时兜底|const scope = input.scope ?? parseTimeScope(input.query, now, this.#options.timeZone);
CLAIM|13|一致|apps/agent-service/src/production-run-memory.ts:450|每轮自动召回也走这里）|const found = await options.memory.search({
CLAIM|14|一致|packages/prompt-catalog/src/tools.ts:36|recall 工具早已让模型填日期|问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）；问以前的情况时 includeHistory 填 true。
CLAIM|15|一致|packages/prompt-catalog/src/tools.ts:36|packages/prompt-catalog/src/tools.ts 的 TOOL_RECALL 原话“问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）；问以前的情况时 includeHistory 填 true”。|问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）；问以前的情况时 includeHistory 填 true。
CLAIM|16|一致|apps/agent-service/src/production-mcp-read.ts:501|对外 MCP 工具 find_memories 已有 from、to|from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },；to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
CLAIM|17|一致|apps/agent-service/src/production-mcp-read.ts:503|没有 includeHistory|from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },；to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },；limit: { type: "integer", minimum: 1, maximum: 10 },
CLAIM|18|一致|apps/agent-service/src/production-mcp-read.ts:501|apps/agent-service/src/production-mcp-read.ts 第 501 行起的参数定义。|from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
CLAIM|19|一致|.claude/rules/prompt-prefix.md:43|改提示词文字只对新对话生效：.claude/rules/prompt-prefix.md 第 43 行“改了提示词文字，**只对新对话生效**”。|- 改了提示词文字，**只对新对话生效**。要让老对话也用上，必须手动换新。
CLAIM|20|一致|.claude/rules/prompt-prefix.md:53|老对话里冻结的旧文字从此按外来内容检查（同文件第 53 行）|所以遮法还取决于这份清单：以后改了提示词文字，老对话里冻结的旧文字不再在清单里，按外来内容检查；旧文字里如果有会被认成敏感信息的数字，那个对话的请求开头会变一次。
CLAIM|21|一致|packages/prompt-catalog/src/tools.ts:36|旧 recall 说明里没有会被认成敏感信息的数字。|查主人的长期记忆和以前的对话摘要。主人问到以前说过的事、某天或某段时间发生过什么、以前的情况（换手机前、搬家前）时使用。query 写要找的内容；问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）；问以前的情况时 includeHistory 填 true。返回的记忆带有效期，已失效的标为历史；对话摘要按日期给出。只查主人自己的记忆，不会联网。
CLAIM|22|一致|test/fixtures/memory-evaluation/dataset.json:2064|时间相关的题是 temporal 15 题|"ability": "temporal",
CLAIM|23|一致|test/fixtures/memory-evaluation/dataset.json:2274|history 10 题|"ability": "history",
CLAIM|24|一致|test/fixtures/memory-evaluation/dataset.json:2354|time_window 12 题|"ability": "time_window",
CLAIM|25|一致|test/fixtures/memory-evaluation/dataset.json:2450|episode 8 题|"ability": "episode",
CLAIM|26|一致|test/integration/memory-evaluation.test.ts:633|第二阶段关口在 test/integration/memory-evaluation.test.ts 的“answers history, time-window and past-conversation questions”用例。|it("answers history, time-window and past-conversation questions that phase one could not", async () => {
CLAIM|27|一致|scripts/evals/memory-time-scope-live.eval.ts:16|每题两遍|const RUNS = Number(process.env["EVAL_RUNS"] ?? "2");
CLAIM|28|找不到|evals/memory-time-scope/result.json:4|两次实测共 180 次调用|"spentUsd": 0.009947256,；"usage": {；"deepseek-v4.1-flash": {；"prompt": 161500,；"cached": 154752,；"completion": 14118,；"calls": 90
CLAIM|29|找不到|evals/memory-time-scope/result.json:4|0.021 美元|"spentUsd": 0.009947256,
CLAIM|30|一致|test/fixtures/memory-evaluation/embeddings-4096.json:1|检索用评测集自带的 4096 维真实向量|"model":"alibaba/qwen3-embedding-8b","dimensions":4096,"encoding":"float16-base64"
CLAIM|31|一致|test/integration/memory-evaluation.test.ts:41|数字是前 5 条召回率|const TOP_K = 5;
CLAIM|32|一致|evals/memory-time-scope/result.json:25|实测里模型对 45 个时间类问题全部调了 recall。|"called": true,
CLAIM|33|一致|test/fixtures/memory-evaluation/model-time-scopes.json:2|评测记录的是某一天某个模型的回答|"model": "deepseek-v4.1-flash",；"now": "2026-10-25T12:00:00.000Z",

带“改动前/原先/早已/没有 includeHistory”的条目按父提交 8e59634ca 的代码核对。实测的 180 次调用、0.021 美元和召回率表格在已提交记录里找不到完整依据（result.json 只显示一次 90 次调用、0.009947256 美元），“要求先实测再删”也未在仓库中找到整合方案原文；外部网站和第三方产品的说法按要求未核对。
