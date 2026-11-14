CLAIM|1|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:1|2026-11-14 统计|# 复核提速分析的数据（2026-11-14）
CLAIM|2|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:7|2026-10-31 起|- 数据源：2026-10-31 起合并或在途的 PR 在 `.agents/reviews/pr-*/` 下的 `usage.jsonl` 和各轮的 `verdicts.jsonl`，按 PR 目录、时间、模型、轮次去重。
CLAIM|3|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:12|178 个 PR、665 轮代码复核|- 统计范围：178 个 PR、665 轮代码复核。
CLAIM|4|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:3|数字和取法在 [2026-11-14-review-speed-data.txt](../assets/review-cost/2026-11-14-review-speed-data.txt)|ADR 0270 背景一节的数字都出自这里。统计脚本是线程的临时脚本，不在仓库里；下面写明取法，换人可以重算。
CLAIM|5|找不到|-|原始数据是 `.agents/reviews/pr-*/usage.jsonl` 和各轮的 `verdicts.jsonl`|-
CLAIM|6|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:13|每个 PR 平均 3.7 轮|- 每个 PR 平均 3.7 轮，中位 3 轮，最多 13 轮。
CLAIM|7|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:13|中位 3 轮|- 每个 PR 平均 3.7 轮，中位 3 轮，最多 13 轮。
CLAIM|8|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:13|最多 13 轮|- 每个 PR 平均 3.7 轮，中位 3 轮，最多 13 轮。
CLAIM|9|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:8|每轮从上一轮结束到这一轮结束|- 轮的时长：从上一轮结束到这一轮结束。
CLAIM|10|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:14|中位 21 分钟|- 每轮时长中位 21 分钟；其中 DeepSeek 一次运行 8 到 12 分钟，开跑前自检约 70 秒。
CLAIM|11|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:14|DeepSeek 一次运行 8 到 12 分钟|- 每轮时长中位 21 分钟；其中 DeepSeek 一次运行 8 到 12 分钟，开跑前自检约 70 秒。
CLAIM|12|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:14|开跑前自检约 70 秒|- 每轮时长中位 21 分钟；其中 DeepSeek 一次运行 8 到 12 分钟，开跑前自检约 70 秒。
CLAIM|13|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:15|增量轮中位 47 步、0.091 美元|- 2026-11-08 起，增量轮（带 `--previous`）中位 47 步、0.091 美元；全量轮（第 1 轮）中位 36 步、0.081 美元。
CLAIM|14|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:15|全量轮中位 36 步、0.081 美元|- 2026-11-08 起，增量轮（带 `--previous`）中位 47 步、0.091 美元；全量轮（第 1 轮）中位 36 步、0.081 美元。
CLAIM|15|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:15|增量轮比全量轮还重|- 2026-11-08 起，增量轮（带 `--previous`）中位 47 步、0.091 美元；全量轮（第 1 轮）中位 36 步、0.081 美元。
CLAIM|16|一致|scripts/model-review/opencode-review.mjs:371@158697387a9ea62634d1b4c3486e4ad19a25234e|增量轮的提示要求查“它产生或修改的值的每个使用端”|复核增量和它直接影响的代码：调用它的地方、它调用的地方、它产生或修改的值的每个使用端。
CLAIM|17|一致|scripts/model-review/opencode-review.mjs:1138|模型每轮是全新的对话，看不到上一轮提过什么|  const session = wrapUp ? sessionOf(first.stdout) : null;
CLAIM|18|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:19|第 2 轮起的 658 轮|- 第 2 轮起共 658 轮。
CLAIM|19|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:20|44% 因为上一轮有中高意见|- 44% 因为上一轮有成立的中高意见。
CLAIM|20|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:21|15% 因为上一轮只剩低意见却用不了 `--accept-low`|- 15% 因为上一轮只剩低意见，却用不了 `--accept-low`。
CLAIM|21|不一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:22|其余是首轮和别的原因|- 其余是首轮之外的别的原因。
CLAIM|22|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:26|能定位到行号的 233 条|- 增量轮里成立的中高意见，能定位到行号的有 233 条，其中 79% 落在上一轮刚改过的行附近。
CLAIM|23|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:26|79% 落在上一轮刚改过的行附近|- 增量轮里成立的中高意见，能定位到行号的有 233 条，其中 79% 落在上一轮刚改过的行附近。
CLAIM|24|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:27|抽查 30 条，约四分之三是正常使用或并发就会碰到的真问题|- 抽查 30 条，约四分之三是正常使用或并发就会碰到的真问题。
CLAIM|25|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:31|同一份 ADR 每次核对模型列出的条数在 21 到 63 条之间波动|- 同一份 ADR 每次核对，模型列出的条数在 21 到 63 条之间波动。
CLAIM|26|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:32|被标“不一致”或“找不到”的条目，线程判为模型看错 64 条|- 被标“不一致”或“找不到”的条目，线程判为模型看错的有 64 条，方案真写错的有 27 条。
CLAIM|27|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:32|方案真写错 27 条|- 被标“不一致”或“找不到”的条目，线程判为模型看错的有 64 条，方案真写错的有 27 条。
CLAIM|28|一致|scripts/model-review/plan-claims.mjs:165@158697387a9ea62634d1b4c3486e4ad19a25234e|只认当前提交里的代码|  const blob = blobAt(repo, head, place.path);
CLAIM|29|一致|scripts/model-review/plan-claims.mjs:165@158697387a9ea62634d1b4c3486e4ad19a25234e|讲“本 PR 删掉的旧代码原来如何”的句子永远核不过|  const blob = blobAt(repo, head, place.path);
CLAIM|30|找不到|-|PR 423 和 481 最后都靠 Andy 说跳过|-
CLAIM|31|找不到|-|用来统计 97 轮里各种原因占多少|-
CLAIM|32|一致|.agents/instructions/model-review.md:67|不读 PR 自己的测试配置，免得 PR 自己放宽口子|认哪些文件写在代码里，不读 PR 自己的测试配置，免得 PR 自己放宽口子
CLAIM|33|一致|scripts/model-review/opencode-review.mjs:1224|文件数和行数上限仍留在代码里|export const LOW_FIX_MAX_FILES = 5;
CLAIM|34|一致|scripts/model-review/opencode-review.mjs:1225|文件数和行数上限仍留在代码里|export const LOW_FIX_MAX_LINES_PER_FILE = 30;
CLAIM|35|一致|scripts/model-review/opencode-review.mjs:2583|PR 自带的 `AGENTS.md` 不得进系统提示|      problems.push(`PROBE_PROJECT_INSTRUCTIONS_LOADED ${request.model}`);
CLAIM|36|一致|scripts/model-review/opencode-review.mjs:2758|副本跑完没被改动这两项检查，每个 PR 都照跑|      const changed = git(["status", "--porcelain", "--untracked-files=all"], copy);
CLAIM|37|一致|docs/assets/review-cost/2026-11-14-review-speed-data.txt:37|实测不带 Magpie 的自检从 22 秒降到 11 秒|- 2026-11-14 在云端容器里实测，不带 Magpie 的自检，没有缓存时 22 秒，命中缓存时 11 秒。
CLAIM|38|一致|.agents/instructions/model-review.md:59|现行规则（`model-review.md` 严重度定义）把“怪输入导致错误结果、丢数据、资源耗尽”算中高|只有故意构造的怪输入才能触发（例如文件名开头带空格、参数里带控制字符），而且触发后是报错拒绝、不会给出错误结果
CLAIM|39|一致|scripts/model-review/plan-claims.mjs:315|合并检查目前只认“整份 ADR 内容摘要一致的一轮”|    const matching = own.filter((record) => record.claimsSha256 === sha);
CLAIM|40|一致|.agents/instructions/model-review.md:45|合并检查验证证据在当前提交里逐字存在|证据在当前提交里仍逐字存在
CLAIM|41|一致|.agents/instructions/model-review.md:48|不验证证据是否真的证明了那句话|验证不了“引的那行真的能证明这句话”
CLAIM|42|一致|docs/adr/0175-cheaper-code-review-rounds.md:92|**降低推理强度或换更快的模型**：[ADR 0175](0175-cheaper-code-review-rounds.md) 已否决，会漏错误路径|降到 `low` 会让复核漏掉错误路径，省下的思考费用不值得。
CLAIM|43|找不到|-|换更快的模型**：[ADR 0175](0175-cheaper-code-review-rounds.md) 已否决，会漏错误路径|-
CLAIM|44|一致|scripts/model-review/review-models.json:3|复核默认只用 DeepSeek V4.1 Flash|  "default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|45|一致|.agents/instructions/model-review.md:53|Andy 指明才加 GLM|Andy 指明要两个模型时加 `--models deepseek-v4.1-flash,glm-5.3-flash`
CLAIM|46|一致|.agents/instructions/model-review.md:71|已有“连续三轮没过停下”|连续三轮没过，第三轮的“会出错”意见可以先改，但改完不再复核，直接停下报告 Andy
CLAIM|47|一致|test/tooling/opencode-review-merge-gate.test.mjs:1267|`test/tooling/opencode-review-merge-gate.test.mjs`（`[low fix]`、`[incremental round]`）|  it("[low fix] accepts a small fix with a test change for a round whose errors are all low", () => {
CLAIM|48|一致|test/tooling/opencode-review-merge-gate.test.mjs:1415|`test/tooling/opencode-review-merge-gate.test.mjs`（`[low fix]`、`[incremental round]`）|  it("[incremental round] carries the previous round's confirmed errors, deterministically and within limits", () => {
CLAIM|49|一致|test/tooling/opencode-review.test.mjs:1370|`test/tooling/opencode-review.test.mjs`（`[self-check cache]`）|  it("[self-check cache] only a pass for the same code, binary, mode and tools counts, and it expires", () => {
CLAIM|50|一致|test/tooling/plan-claims-gate.test.mjs:419|`test/tooling/plan-claims-gate.test.mjs`（旧提交引用、判断沿用）|  it("[claims gate] an old commit cannot stand in for code that head still has, or for a commit outside the PR", () =>
CLAIM|51|一致|test/tooling/plan-claims-gate.test.mjs:438|`test/tooling/plan-claims-gate.test.mjs`（旧提交引用、判断沿用）|  it("[claims gate] a judgment written for the same sentence in an earlier run carries over, but only while its evidence still holds", () =>

未核实：`.agents/reviews/` 被 sparse checkout 排除且 git 读取被规则拦截，PR 423/481 的 `usage.jsonl` 和 97 轮的原始记录都没读到；统计数字只核对了同目录的数据说明文件，未重算原始账本。
