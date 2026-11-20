CLAIM|1|一致|.agents/instructions/model-review.md:98|合并前的代码复核用 `scripts/model-review/opencode-review.mjs`|用 `node scripts/model-review/opencode-review.mjs` 跑，不要自己拼 `opencode run` 命令。它做这些事（Andy 2026-11-03 定）：
CLAIM|2|一致|.agents/instructions/model-review.md:109|经 OpenCode|第一次运行会联网安装 `opencode-ai@1.19.5` 到 `~/.cache/himawari-opencode-1.19.5-<锁文件摘要前 12 位>`，之后复用；也可以用 `HIMAWARI_OPENCODE_BIN` 指定已装好的程序（这时不做下面的核对）。
CLAIM|3|一致|scripts/model-review/review-models.json:3|请 DeepSeek V4.1 Flash|"default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|4|一致|.agents/instructions/model-review.md:100|只读复核|- 模型自己读代码：只开读文件、按内容搜索、按文件名找文件，以及 `git diff`、`git log`、`git show`、`git blame`、`git status`；改文件、别的命令、派子代理、仓库外的路径全部禁止。
CLAIM|5|一致|.agents/instructions/model-review.md:52|线程（Claude Code 的一段对话）再逐条判断|2. 分类由线程做，不由模型做。
CLAIM|6|一致|.agents/instructions/model-review.md:62|再修改、再复核|3. 按中、高严重度的“会出错”意见，或第 5 步里 Andy 采纳的意见，做了修改，就对这些修改再复核一轮（传 `--previous <上一轮复核的提交>`，模型只复核增量和增量直接影响的代码），一直到线程核对后没有中、高严重度的“会出错”意见为止，第 4 步的停止条件除外。
CLAIM|7|找不到|-|2026-11-13 统计 180 个 PR 的复核记录|-
CLAIM|8|找不到|-|统计 4 个 PR 线程的用量|-
CLAIM|9|找不到|-|4 个 PR 的整个线程按 API 价折算 39–86 美元|-
CLAIM|10|找不到|-|同一批 PR 的 DeepSeek 复核 0.4–1.4 美元|-
CLAIM|11|找不到|-|线程上下文常有 15 万到 30 万 token|-
CLAIM|12|一致|.agents/instructions/model-review.md:59|手写 `verdicts.jsonl`（逐字抄模型原话）和 `judgments.md`|逐条判断除了写进给人看的 `round-<n>/judgments.md`，还要一条一行写进 `round-<n>/verdicts.jsonl`（脚本读它）：
CLAIM|13|找不到|-|约 25–40 次调用|-
CLAIM|14|一致|.agents/instructions/model-review-card.md:4|`.agents/instructions/model-review.md`（约 8 万字节）|这一页是合并前代码复核的常用路径。完整规则在[和 OpenCode 协作](model-review.md)（约 8 万字节），平时不通读，遇到下面没写到的情况或报错时，按链接只读对应那一节。
CLAIM|15|一致|docs/incidents-and-gates.md:8|`docs/incidents-and-gates.md`（约 18 万）|# 事故与门槛清单
CLAIM|16|一致|docs/lessons.md:9|`docs/lessons.md`（约 15 万）|# 编码代理反复犯的错误
CLAIM|17|找不到|-|增量轮（带 `--previous`）中位 53 步，和第 1 轮的 57 步差不多|-
CLAIM|18|一致|scripts/model-review/opencode-review.mjs:368|提示原话是“先看 git diff 的增量，但可以读任何文件”|      ? `上一轮复核到 ${previous}，先看 git diff ${previous}..${head} 的增量，但可以读任何文件。`
CLAIM|19|找不到|-|模型每轮都把整个 PR 重查一遍|-
CLAIM|20|找不到|-|各轮成立的中高意见：第 1 轮 460 条、第 2 轮 195、第 3 轮 107、第 4 轮 57、第 5 轮 34、6 轮以上 51|-
CLAIM|21|找不到|-|第 3 轮以后的回报明显变少|-
CLAIM|22|一致|docs/adr/0175-cheaper-code-review-rounds.md:68|按 [ADR 0175](0175-cheaper-code-review-rounds.md) 第 5 条，低严重度意见要修改、补测试后用 `--accept-low` 记进账本，每轮都这样|5. **低严重度的修改用 `--accept-low` 记进账本，不再复核。** 线程把逐条判断写进机器能读的 `round-<n>/verdicts.jsonl`，修改和补的测试提交后运行 `--assert-reviewed --accept-low <轮次>`。
CLAIM|23|找不到|-|数据和图表见线程文档“复核省 token 和提速：数据与结论”|-
CLAIM|24|一致|.agents/instructions/model-review.md:142|带 `--previous` 的轮次|  --base <分叉点提交> --head <PR 最新提交> [--previous <上一轮复核的提交>] \
CLAIM|25|一致|.agents/instructions/model-review.md:72|收尾时自己再跑一次 `--assert-reviewed`|把复核记录目录提交后，运行 `node scripts/model-review/opencode-review.mjs --assert-reviewed --pr <编号>`。它不花钱，不带 `--accept-unreviewed` 时只读；它从当前提交里读账本，按轮次顺序把复核串成一条链。
CLAIM|26|一致|.agents/instructions/model-review.md:75|`--report` 新增一节“低严重度未修（第 3 轮起只列不修）”|7. PR 描述和给 Andy 的复核汇报，复核部分照贴 `node scripts/model-review/opencode-review.mjs --report --pr <编号> --stop <原因>` 的输出，不手写。
CLAIM|27|一致|.agents/instructions/model-review.md:4|起始轮次写在 `scripts/model-review/review-models.json`|能用哪些、默认跑哪些、谁替补谁，都写在 `scripts/model-review/review-models.json`（`allowed`、`default`、`substitutes`），脚本启动时读它并校验（默认和替补都必须在能用的清单里，否则以 `REVIEW_MODELS_CONFIG_INVALID` 停下）；
CLAIM|28|一致|.agents/instructions/model-review.md:72|合并检查不变：最后一轮复核的就是当前代码，复核链本来就接得上|它要求链上最后一点的提交是当前提交的祖先、两者之间 PR 自己的改动没变
CLAIM|29|一致|docs/adr/0175-cheaper-code-review-rounds.md:68|第 1、2 轮照旧按 ADR 0175 修低意见|5. **低严重度的修改用 `--accept-low` 记进账本，不再复核。** 线程把逐条判断写进机器能读的 `round-<n>/verdicts.jsonl`，修改和补的测试提交后运行 `--assert-reviewed --accept-low <轮次>`。
CLAIM|30|找不到|-|主线程照旧复核，只靠脚本减少调用：每次调用仍要重读 15 万以上 token 的上下文|-

复核记录目录 `.agents/reviews/topic-review-claude-side-cost/` 不在稀疏检出中、git 替身也拒绝读取，所以 180 个 PR、4 个线程、费用、步数、意见数和线程文档都未能核对；三个大文件的字节数是按读到的内容粗估，改动前的提示语按父提交 `ccec8bd^` 的第 368 行核对。
