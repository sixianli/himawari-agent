CLAIM|1|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:1|2026-11-14 统计|# 复核提速分析的数据（2026-11-14）
CLAIM|2|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:7|2026-10-31 起|- 数据源：2026-10-31 起合并或在途的 PR 在 `.agents/reviews/pr-*/` 下的 `usage.jsonl` 和各轮的 `verdicts.jsonl`，按 PR 目录、时间、模型、轮次去重。
CLAIM|3|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:12|178 个 PR|- 统计范围：178 个 PR、665 轮代码复核。
CLAIM|4|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:12|665 轮代码复核|- 统计范围：178 个 PR、665 轮代码复核。
CLAIM|5|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:13|每个 PR 平均 3.7 轮|- 每个 PR 平均 3.7 轮，中位 3 轮，最多 13 轮。
CLAIM|6|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:13|中位 3 轮|- 每个 PR 平均 3.7 轮，中位 3 轮，最多 13 轮。
CLAIM|7|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:13|最多 13 轮|- 每个 PR 平均 3.7 轮，中位 3 轮，最多 13 轮。
CLAIM|8|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:8|每轮从上一轮结束到这一轮结束|- 轮的时长：从上一轮结束到这一轮结束。
CLAIM|9|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:14|中位 21 分钟|- 每轮时长中位 21 分钟；其中 DeepSeek 一次运行 8 到 12 分钟，开跑前自检约 70 秒。
CLAIM|10|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:14|DeepSeek 一次运行 8 到 12 分钟|- 每轮时长中位 21 分钟；其中 DeepSeek 一次运行 8 到 12 分钟，开跑前自检约 70 秒。
CLAIM|11|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:14|开跑前自检约 70 秒|- 每轮时长中位 21 分钟；其中 DeepSeek 一次运行 8 到 12 分钟，开跑前自检约 70 秒。
CLAIM|12|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:15|11-08 起，增量轮中位 47 步|- 2026-11-08 起，增量轮（带 `--previous`）中位 47 步、0.091 美元；全量轮（第 1 轮）中位 36 步、0.081 美元。
CLAIM|13|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:15|增量轮 0.091 美元|- 2026-11-08 起，增量轮（带 `--previous`）中位 47 步、0.091 美元；全量轮（第 1 轮）中位 36 步、0.081 美元。
CLAIM|14|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:15|全量轮中位 36 步|- 2026-11-08 起，增量轮（带 `--previous`）中位 47 步、0.091 美元；全量轮（第 1 轮）中位 36 步、0.081 美元。
CLAIM|15|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:15|全量轮 0.081 美元|- 2026-11-08 起，增量轮（带 `--previous`）中位 47 步、0.091 美元；全量轮（第 1 轮）中位 36 步、0.081 美元。
CLAIM|16|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:15|增量轮比全量轮还重|- 2026-11-08 起，增量轮（带 `--previous`）中位 47 步、0.091 美元；全量轮（第 1 轮）中位 36 步、0.081 美元。
CLAIM|17|一致|scripts/model-review/opencode-review.mjs:371@158697387a9ea62634d1b4c3486e4ad19a25234e|原因是增量轮的提示要求查“它产生或修改的值的每个使用端”|      ? `上一轮复核到 ${previous}，这一轮先看 git diff ${previous}..${head} 的增量，复核增量和它直接影响的代码：调用它的地方、它调用的地方、它产生或修改的值的每个使用端。增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。结论里写清这一轮查过哪些范围。`
CLAIM|18|一致|test/tooling/opencode-review-merge-gate.test.mjs:90|模型每轮是全新的对话|          'if (process.argv.includes("--session")) process.exit(0);',
CLAIM|19|一致|scripts/model-review/opencode-review.mjs:371@158697387a9ea62634d1b4c3486e4ad19a25234e|看不到上一轮提过什么|      ? `上一轮复核到 ${previous}，这一轮先看 git diff ${previous}..${head} 的增量，复核增量和它直接影响的代码：调用它的地方、它调用的地方、它产生或修改的值的每个使用端。增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。结论里写清这一轮查过哪些范围。`
CLAIM|20|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:19|第 2 轮起的 658 轮|- 第 2 轮起共 658 轮。
CLAIM|21|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:20|44% 因为上一轮有中高意见|- 44% 因为上一轮有成立的中高意见。
CLAIM|22|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:21|15% 因为上一轮只剩低意见却用不了 `--accept-low`|- 15% 因为上一轮只剩低意见，却用不了 `--accept-low`。
CLAIM|23|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:22|其余是首轮之外的别的原因|- 其余是首轮之外的别的原因。
CLAIM|24|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:26|能定位到行号的 233 条|- 增量轮里成立的中高意见，能定位到行号的有 233 条，其中 79% 落在上一轮刚改过的行附近。
CLAIM|25|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:26|79% 落在上一轮刚改过的行附近|- 增量轮里成立的中高意见，能定位到行号的有 233 条，其中 79% 落在上一轮刚改过的行附近。
CLAIM|26|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:27|抽查 30 条|- 抽查 30 条，约四分之三是正常使用或并发就会碰到的真问题。
CLAIM|27|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:27|约四分之三是正常使用或并发就会碰到的真问题|- 抽查 30 条，约四分之三是正常使用或并发就会碰到的真问题。
CLAIM|28|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:31|同一份 ADR 每次核对模型列出的条数在 21 到 63 条之间波动|- 同一份 ADR 每次核对，模型列出的条数在 21 到 63 条之间波动。
CLAIM|29|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:32|线程判为模型看错 64 条|- 被标“不一致”或“找不到”的条目，线程判为模型看错的有 64 条，方案真写错的有 27 条。
CLAIM|30|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:32|方案真写错 27 条|- 被标“不一致”或“找不到”的条目，线程判为模型看错的有 64 条，方案真写错的有 27 条。
CLAIM|31|一致|scripts/model-review/plan-claims.mjs:165@158697387a9ea62634d1b4c3486e4ad19a25234e|只认当前提交里的代码|  const blob = blobAt(repo, head, place.path);
CLAIM|32|一致|scripts/model-review/plan-claims.mjs:165@158697387a9ea62634d1b4c3486e4ad19a25234e|讲“本 PR 删掉的旧代码原来如何”的句子永远核不过|  const blob = blobAt(repo, head, place.path);
CLAIM|33|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:33|例子见数据文件|- 因为只认当前提交里的代码，讲“本 PR 删掉的旧代码原来如何”的句子永远核不过。靠 Andy 说跳过才合并的有 PR 423（`.agents/reviews/pr-423/usage.jsonl` 里 2026-11-12 的 `override` 记录）和 PR 481（`.agents/reviews/pr-481/usage.jsonl` 里 2026-11-13 的两条 `override` 记录）。
CLAIM|34|一致|test/tooling/opencode-review-merge-gate.test.mjs:1491|固定前缀和必答问题一字不改，所以所有轮次的前缀仍然逐字节相同|    expect(later.slice(0, fixedEnd)).toBe(first.slice(0, fixedEnd));
CLAIM|35|一致|scripts/model-review/opencode-review.mjs:1224|文件数上限仍留在代码里|export const LOW_FIX_MAX_FILES = 5;
CLAIM|36|一致|scripts/model-review/opencode-review.mjs:1225|行数上限仍留在代码里|export const LOW_FIX_MAX_LINES_PER_FILE = 30;
CLAIM|37|一致|scripts/model-review/opencode-review.mjs:2583|PR 自带的 `AGENTS.md` 不得进系统提示|        problems.push(`PROBE_PROJECT_INSTRUCTIONS_LOADED ${request.model}`);
CLAIM|38|一致|scripts/model-review/opencode-review.mjs:2758|副本跑完没被改动|      const changed = git(["status", "--porcelain", "--untracked-files=all"], copy);
CLAIM|39|一致|scripts/model-review/opencode-review.mjs:3697|`--self-check-only` 永远跑全套|      Boolean(cacheKey) && !options.selfCheckOnly && selfCheckCacheHit({ key: cacheKey });
CLAIM|40|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:37|实测不带 Magpie 的自检从 22 秒降到 11 秒|- 2026-11-14 在云端容器里实测，不带 Magpie 的自检，没有缓存时 22 秒，命中缓存时 11 秒。
CLAIM|41|一致|.agents/instructions/model-review.md:59|现行规则（`model-review.md` 严重度定义）把“怪输入导致错误结果、丢数据、资源耗尽”算中高|      - 低：只有故意构造的怪输入才能触发（例如文件名开头带空格、参数里带控制字符），而且触发后是报错拒绝、不会给出错误结果；或者文字漏写、写得不准，但不会误导人做错事。
CLAIM|42|一致|scripts/model-review/plan-claims.mjs:315|合并检查目前只认“整份 ADR 内容摘要一致的一轮”|    const matching = own.filter((record) => record.claimsSha256 === sha);
CLAIM|43|一致|docs/adr/0175-cheaper-code-review-rounds.md:92|ADR 0175 已否决，会漏错误路径|- **调低推理强度。** 不采用：这两个模型在 opencode 1.19.5 上只有 `low`、`high`、`max` 三档，没有中档；降到 `low` 会让复核漏掉错误路径，省下的思考费用不值得。
CLAIM|44|一致|scripts/model-review/review-models.json:3|复核默认只用 DeepSeek V4.1 Flash|  "default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|45|一致|.agents/instructions/model-review.md:4|Andy 指明才加 GLM|默认只用 `opencode-go/deepseek-v4.1-flash` 一个模型，推理强度设为高；方案讨论、核对代码说法和代码复核的每一轮都是这样（Andy 2026-11-12 定，原话“除非我特别指明，否则现在默认只让 DeepSeek 去审”，[ADR 0259](../../docs/adr/0259-review-models-default-to-deepseek.md)）。Andy 特别指明时才加上 `opencode-go/glm-5.3-flash`：传 `--models deepseek-v4.1-flash,glm-5.3-flash`。
CLAIM|46|一致|.agents/instructions/model-review.md:71|已有“连续三轮没过停下”|   - 连续三轮没过，第三轮的“会出错”意见可以先改，但改完不再复核，直接停下报告 Andy
CLAIM|47|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:27|抽查约四分之三是真问题|- 抽查 30 条，约四分之三是正常使用或并发就会碰到的真问题。
CLAIM|48|一致|scripts/model-review/opencode-review.mjs:2583|这项检查每个 PR 照跑|        problems.push(`PROBE_PROJECT_INSTRUCTIONS_LOADED ${request.model}`);
CLAIM|49|一致|scripts/model-review/plan-claims.mjs:391|合并检查验证证据在当前提交里逐字存在，不验证证据是否真的证明了那句话|            !collapse(evidenceBlob.toString("utf8")).includes(collapse(verdict.evidence))
CLAIM|50|一致|test/tooling/opencode-review-merge-gate.test.mjs:1267|`test/tooling/opencode-review-merge-gate.test.mjs`（`[low fix]`）|  it("[low fix] accepts a small fix with a test change for a round whose errors are all low", () => {
CLAIM|51|一致|test/tooling/opencode-review-merge-gate.test.mjs:1415|`test/tooling/opencode-review-merge-gate.test.mjs`（`[incremental round]`）|  it("[incremental round] carries the previous round's confirmed errors, deterministically and within limits", () => {
CLAIM|52|一致|test/tooling/opencode-review.test.mjs:1370|`test/tooling/opencode-review.test.mjs`（`[self-check cache]`）|  it("[self-check cache] only a pass for the same code, binary, mode and tools counts, and it expires", () => {
CLAIM|53|一致|test/tooling/plan-claims-gate.test.mjs:405|`test/tooling/plan-claims-gate.test.mjs`（旧提交引用）|  it("[claims gate] code the PR removed can be cited at the PR's base commit, only when head no longer has it", () =>
CLAIM|54|一致|test/tooling/plan-claims-gate.test.mjs:438|`test/tooling/plan-claims-gate.test.mjs`（判断沿用）|  it("[claims gate] a judgment written for the same sentence in an earlier run carries over, but only while its evidence still holds", () =>
CLAIM|55|一致|test/tooling/opencode-review-merge-gate.test.mjs:1590|各带反向用例|  it("[low fix] refuses medium or high errors, missing tests, oversized fixes and unproven quotes", () => {
CLAIM|56|一致|test/tooling/opencode-review.test.mjs:1384|各带反向用例|      expect(selfCheckCacheHit({ key, now: 1000 + SELF_CHECK_CACHE_MAX_AGE_MS, env })).toBe(false);
CLAIM|57|一致|test/tooling/plan-claims-gate.test.mjs:419|各带反向用例|  it("[claims gate] an old commit cannot stand in for code that head still has, or for a commit outside the PR", () =>

未核实：`.agents/reviews/pr-423` 和 `pr-481` 的 override 记录在当前稀疏检出中不存在，只能核对数据文件的转述；外部链接未按规则核对。背景里讲改动前行为的几句（旧增量提示、只认当前提交）按基线提交核对，当前 HEAD 已改掉。
