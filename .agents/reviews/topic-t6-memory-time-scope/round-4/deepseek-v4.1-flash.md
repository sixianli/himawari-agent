CLAIM|1|一致|docs/adr/0260-memory-classification-on-the-server.md:28|Andy 在 2026-11-12 定的原则是：理解用户的意思一律交给模型判断，不用关键词表、正则或写死的词典。|Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户的意思一律交给模型判断，不用关键词表、正则或写死的词典。
CLAIM|2|一致|packages/memory-engine/src/time-scope.ts:152（7f60e2c6c^）|搜记忆时，问题里的“上周三”“去年”“以前”原先由 `parseTimeScope`（一组正则）换算成时间范围|export function parseTimeScope(
CLAIM|3|一致|apps/agent-service/src/production-memory-recall.ts:159（7f60e2c6c^）|模型在 recall 工具里填了 from、to 时用模型的，没填时用正则兜底。|const parsed = parseTimeScope(input.query, now, timeZone);
CLAIM|4|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|设计线程的整合方案把它列为任务 T6（[ADR 0249](0249-the-model-judges-meaning-where-word-lists-guessed-it.md) 写明 T6 另记）。|分类与敏感判断（T5）、搜记忆的时间范围（T6）各有自己的取舍，另记。
CLAIM|5|一致|apps/agent-service/test/production-memory-recall.unit.test.ts:397|`apps/agent-service/test/production-memory-recall.unit.test.ts` 的用例“[T6] reads the time window only from what the model filled, never from the words of the query”|it("[T6] reads the time window only from what the model filled, never from the words of the query", async () => {
CLAIM|6|一致|apps/agent-service/test/production-memory-recall.unit.test.ts:399,401|查询“我以前用什么手机，昨天说过的”时检索范围是 `{ includeHistory: false, from: null, to: null }`。|expect.objectContaining({ scope: { includeHistory: false, from: null, to: null } }),
CLAIM|7|一致|packages/prompt-catalog/src/tools.ts:36（7f60e2c6c^）|`packages/prompt-catalog/src/tools.ts` 的 `TOOL_RECALL` 在本 ADR 之前就有“问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）”。|问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）；
CLAIM|8|一致|apps/agent-service/src/production-mcp-read.ts:1508|对外 MCP 工具 `find_memories` 在本 ADR 之前已有 from、to（`apps/agent-service/src/production-mcp-read.ts` 第 1508 行 `name: "find_memories"` 起的参数定义）|name: "find_memories",
CLAIM|9|一致|apps/agent-service/src/production-mcp-read.ts:1514|对外 MCP 工具 `find_memories` 在本 ADR 之前已有 from、to|from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
CLAIM|10|一致|.claude/rules/prompt-prefix.md:43|改提示词文字只对新对话生效：`.claude/rules/prompt-prefix.md` 第 43 行“改了提示词文字，**只对新对话生效**”。|- 改了提示词文字，**只对新对话生效**。要让老对话也用上，必须手动换新。
CLAIM|11|一致|.claude/rules/prompt-prefix.md:53|老对话里冻结的旧文字从此按外来内容检查（同文件第 53 行）|以后改了提示词文字，老对话里冻结的旧文字不再在清单里，按外来内容检查；
CLAIM|12|一致|packages/prompt-catalog/src/tools.ts:36（7f60e2c6c^）|旧 recall 说明里没有会被认成敏感信息的数字。|text: "查主人的长期记忆和以前的对话摘要。主人问到以前说过的事、某天或某段时间发生过什么、以前的情况（换手机前、搬家前）时使用。query 写要找的内容；问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）；问以前的情况时 includeHistory 填 true。返回的记忆带有效期，已失效的标为历史；对话摘要按日期给出。只查主人自己的记忆，不会联网。",
CLAIM|13|一致|test/fixtures/memory-evaluation/dataset.json:2064-2162|时间相关的题是 temporal 15 题|"ability": "temporal",
CLAIM|14|一致|test/fixtures/memory-evaluation/dataset.json:2274-2346|history 10 题|"ability": "history",
CLAIM|15|一致|test/fixtures/memory-evaluation/dataset.json:2354-2442|time_window 12 题|"ability": "time_window",
CLAIM|16|一致|test/fixtures/memory-evaluation/dataset.json:2450-2506|episode 8 题|"ability": "episode",
CLAIM|17|一致|test/integration/memory-evaluation.test.ts:634|第二阶段关口在 `test/integration/memory-evaluation.test.ts` 的“answers history, time-window and past-conversation questions”用例。|it("answers history, time-window and past-conversation questions that phase one could not", async () => {
CLAIM|18|一致|evals/memory-time-scope/result.json:6|模型：`deepseek-v4.1-flash`|"deepseek-v4.1-flash": {
CLAIM|19|一致|scripts/evals/memory-time-scope-live.eval.ts:14|（OpenCode Go 套餐）|const GATEWAY = process.env["EVAL_BASE_URL"] ?? "https://opencode.ai/inference/go/v1";
CLAIM|20|一致|evals/memory-time-scope/result.json:10|45 道时间类题每题两遍。|"calls": 90,
CLAIM|21|一致|evals/memory-time-scope/result.json:10|模型回答记在 `evals/memory-time-scope/result.json`（90 次调用、约 0.01 美元）|"calls": 90,
CLAIM|22|一致|evals/memory-time-scope/result.json:4|约 0.01 美元|"spentUsd": 0.009947256,
CLAIM|23|一致|evals/memory-time-scope/retrieval-comparison.json:80|检索对比记在 `evals/memory-time-scope/retrieval-comparison.json`（`qwen4096/*` 四组）。|"qwen4096/regex": {
CLAIM|24|一致|test/fixtures/memory-evaluation/embeddings-4096.json:1|检索用评测集自带的 4096 维真实向量|"model":"alibaba/qwen3-embedding-8b","dimensions":4096,"encoding":"float16-base64"
CLAIM|25|一致|evals/memory-time-scope/retrieval-comparison.json:5|数字是前 5 条召回率（括号里是“问现在时旧记忆没排到前面”的比例，即 staleFree）。|"metric": "recallAt5 and staleFree over the top 5, per ability",
CLAIM|26|一致|evals/memory-time-scope/retrieval-comparison.json:80-97|｜ 正则 ｜ 1.00（1.00） ｜ 1.00 ｜ 1.00 ｜ 1.00 ｜|"recallAt5": 1,
CLAIM|27|一致|evals/memory-time-scope/retrieval-comparison.json:98-113|｜ 不给时间范围 ｜ 1.00（1.00） ｜ 0.00 ｜ 0.00 ｜ 1.00 ｜|"recallAt5": 0,
CLAIM|28|一致|evals/memory-time-scope/retrieval-comparison.json:116-150|｜ 模型 ｜ 1.00（0.91） ｜ 0.90–1.00 ｜ 1.00 ｜ 0.875–1.00 ｜|"recallAt5": 0.9,
CLAIM|29|一致|evals/memory-time-scope/result.json:16|两遍填得完全相同的题 30/45。|"sameAcrossRuns": 30,
CLAIM|30|一致|evals/memory-time-scope/retrieval-comparison.json:126|模型在“某段时间”上与正则持平|"recallAt5": 1,
CLAIM|31|不一致|evals/memory-time-scope/retrieval-comparison.json:148|模型在“对话摘要”上与正则持平|"recallAt5": 0.875,
CLAIM|32|一致|evals/memory-time-scope/retrieval-comparison.json:140|“问以前”还有小幅回退|"recallAt5": 0.9,
CLAIM|33|一致|evals/memory-time-scope/retrieval-comparison.json:137|“问现在”还有小幅回退|"staleFree": 0.9091,
CLAIM|34|一致|evals/memory-time-scope/retrieval-comparison.json:148|两遍之间也有波动。|"recallAt5": 0.875,
CLAIM|35|一致|evals/memory-time-scope/result.json:25|实测里模型对 45 个时间类问题全部调了 recall。|"called": true,
CLAIM|36|一致|.claude/rules/prompt-prefix.md:43|老对话冻结的是旧的 recall 说明，要新对话才用上补的那一句。|- 改了提示词文字，**只对新对话生效**。要让老对话也用上，必须手动换新。

未核对：Andy 2026-11-13 的口头同意、整合方案原本是否不打算改 recall 说明等外部讨论，以及 LongMemEval、OpenAI 文档内容；决定里新增或修改的描述按题意未作为现状核对。
