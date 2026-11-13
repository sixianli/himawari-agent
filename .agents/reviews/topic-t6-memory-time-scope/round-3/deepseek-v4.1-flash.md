CLAIM|1|一致|packages/memory-engine/src/time-scope.ts:243（7f60e2c6c^）|问题里的“上周三”“去年”“以前”原先由 `parseTimeScope`（一组正则）换算成时间范围|    return range(shiftDays(today, weeks * 7 + weekday - today.weekday), 1, timeZone);
CLAIM|2|一致|packages/memory-engine/src/time-scope.ts:264（7f60e2c6c^）|问题里的“上周三”“去年”“以前”原先由 `parseTimeScope`（一组正则）换算成时间范围|  take(/去年/u, () => yearRange(today.year - 1, timeZone));
CLAIM|3|不一致|packages/memory-engine/src/time-scope.ts:277（7f60e2c6c^）|问题里的“上周三”“去年”“以前”原先由 `parseTimeScope`（一组正则）换算成时间范围|    from: resolved ? new Date(resolved[0]).toISOString() : null,
CLAIM|4|一致|apps/agent-service/src/production-memory-recall.ts:161（7f60e2c6c^）|模型在 recall 工具里填了 from、to 时用模型的|    const from = input.from ?? input.to;
CLAIM|5|一致|apps/agent-service/src/production-memory-recall.ts:182（7f60e2c6c^）|没填时用正则兜底|          from: parsed?.from ?? null,
CLAIM|6|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|设计线程的整合方案把它列为任务 T6（[ADR 0249](0249-the-model-judges-meaning-where-word-lists-guessed-it.md) 写明 T6 另记）|分类与敏感判断（T5）、搜记忆的时间范围（T6）各有自己的取舍，另记。
CLAIM|7|一致|apps/agent-service/test/production-memory-recall.unit.test.ts:397|`apps/agent-service/test/production-memory-recall.unit.test.ts` 的用例“[T6] reads the time window only from what the model filled, never from the words of the query”|it("[T6] reads the time window only from what the model filled, never from the words of the query", async () => {
CLAIM|8|一致|apps/agent-service/test/production-memory-recall.unit.test.ts:399|查询“我以前用什么手机，昨天说过的”时|  await f.service.recallWithClassification(call({ query: "我以前用什么手机，昨天说过的" }));
CLAIM|9|一致|apps/agent-service/test/production-memory-recall.unit.test.ts:401|检索范围是 `{ includeHistory: false, from: null, to: null }`|    expect.objectContaining({ scope: { includeHistory: false, from: null, to: null } }),
CLAIM|10|一致|packages/prompt-catalog/src/tools.ts:36（7f60e2c6c^）|`packages/prompt-catalog/src/tools.ts` 的 `TOOL_RECALL` 在本 ADR 之前就有“问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）”|问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）
CLAIM|11|一致|apps/agent-service/src/production-mcp-read.ts:501-502（7f60e2c6c^）|对外 MCP 工具 `find_memories` 在本 ADR 之前已有 from、to（`apps/agent-service/src/production-mcp-read.ts` 第 501 行起的参数定义）|          from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
CLAIM|12|一致|.claude/rules/prompt-prefix.md:43|改提示词文字只对新对话生效：`.claude/rules/prompt-prefix.md` 第 43 行“改了提示词文字，**只对新对话生效**”|    - 改了提示词文字，**只对新对话生效**。要让老对话也用上，必须手动换新。
CLAIM|13|一致|.claude/rules/prompt-prefix.md:53|老对话里冻结的旧文字从此按外来内容检查（同文件第 53 行）|以后改了提示词文字，老对话里冻结的旧文字不再在清单里，按外来内容检查；
CLAIM|14|一致|packages/prompt-catalog/src/tools.ts:36（7f60e2c6c^）|旧 recall 说明里没有会被认成敏感信息的数字|  text: "查主人的长期记忆和以前的对话摘要。主人问到以前说过的事、某天或某段时间发生过什么、以前的情况（换手机前、搬家前）时使用。query 写要找的内容；问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）；问以前的情况时 includeHistory 填 true。返回的记忆带有效期，已失效的标为历史；对话摘要按日期给出。只查主人自己的记忆，不会联网。",
CLAIM|15|一致|test/fixtures/memory-evaluation/dataset.json:2064|时间相关的题是 temporal 15 题|      "ability": "temporal",
CLAIM|16|一致|test/fixtures/memory-evaluation/dataset.json:2274|时间相关的题是 history 10 题|      "ability": "history",
CLAIM|17|一致|test/fixtures/memory-evaluation/dataset.json:2354|时间相关的题是 time_window 12 题|      "ability": "time_window",
CLAIM|18|一致|test/fixtures/memory-evaluation/dataset.json:2450|时间相关的题是 episode 8 题|      "ability": "episode",
CLAIM|19|一致|test/integration/memory-evaluation.test.ts:634|第二阶段关口在 `test/integration/memory-evaluation.test.ts` 的“answers history, time-window and past-conversation questions”用例|  it("answers history, time-window and past-conversation questions that phase one could not", async () => {
CLAIM|20|一致|apps/agent-service/src/production-memory-recall.ts:165（7f60e2c6c^）|填了日期时一并看历史（沿用原来的做法，某段时间里当时有效、现在已失效的记忆也要找得到）|          includeHistory: true,
CLAIM|21|一致|evals/memory-time-scope/result.json:10-17|45 道时间类题每题两遍|      "calls": 90,
CLAIM|22|一致|evals/memory-time-scope/result.json:20|模型回答记在 `evals/memory-time-scope/result.json`|  "outcomes": [
CLAIM|23|一致|evals/memory-time-scope/result.json:10|（90 次调用）|      "calls": 90,
CLAIM|24|一致|evals/memory-time-scope/result.json:4|约 0.01 美元|  "spentUsd": 0.009947256,
CLAIM|25|一致|evals/memory-time-scope/retrieval-comparison.json:80|检索对比记在 `evals/memory-time-scope/retrieval-comparison.json`（`qwen4096/*` 四组）|    "qwen4096/regex": {
CLAIM|26|一致|test/fixtures/memory-evaluation/embeddings-4096.json:1|检索用评测集自带的 4096 维真实向量|{"model":"alibaba/qwen3-embedding-8b","dimensions":4096,"encoding":"float16-base64","vectors":{
CLAIM|27|一致|evals/memory-time-scope/retrieval-comparison.json:5|数字是前 5 条召回率（括号里是“问现在时旧记忆没排到前面”的比例，即 staleFree）|  "metric": "recallAt5 and staleFree over the top 5, per ability",
CLAIM|28|一致|evals/memory-time-scope/retrieval-comparison.json:82|正则 ｜ 1.00（1.00） ｜ 1.00 ｜ 1.00 ｜ 1.00|        "recallAt5": 1,
CLAIM|29|一致|evals/memory-time-scope/retrieval-comparison.json:104|不给时间范围 ｜ 1.00（1.00） ｜ 0.00 ｜ 0.00 ｜ 1.00|        "recallAt5": 0,
CLAIM|30|一致|evals/memory-time-scope/retrieval-comparison.json:119|模型 ｜ 1.00（0.91） ｜ 0.90–1.00 ｜ 1.00 ｜ 0.875–1.00|        "staleFree": 0.9091
CLAIM|31|一致|evals/memory-time-scope/result.json:16-17|两遍填得完全相同的题 30/45|      "sameAcrossRuns": 30,
CLAIM|32|一致|evals/memory-time-scope/result.json:25|实测里模型对 45 个时间类问题全部调了 recall|      "called": true,

未核对：Andy 的日期与同意、OpenCode Go 套餐等过程或第三方信息，设计线程“原本不打算改这段文字”的原始说法，以及业界做法和对实测结果的解释性评价（如“正则满分是因为照题写”、模型表现评价）。这些要么不属于仓库代码或文档现状，要么没有可读到的仓库证据。
