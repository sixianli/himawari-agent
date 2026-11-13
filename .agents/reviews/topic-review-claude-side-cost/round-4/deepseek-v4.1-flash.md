CLAIM|1|一致|.agents/instructions/model-review.md:98|合并前的代码复核用 `scripts/model-review/opencode-review.mjs`|用 `node scripts/model-review/opencode-review.mjs` 跑，不要自己拼 `opencode run` 命令。
CLAIM|2|一致|scripts/model-review/opencode-review.mjs:485|经 OpenCode（一个能让模型读代码、调用工具的命令行程序）|  if (!installed["node_modules/opencode-ai"]) problems.push("node_modules/opencode-ai missing");
CLAIM|3|一致|scripts/model-review/review-models.json:3|请 DeepSeek V4.1 Flash|  "default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|4|一致|.agents/instructions/model-review.md:100|只读复核|模型自己读代码：只开读文件、按内容搜索、按文件名找文件，以及 `git diff`、`git log`、`git show`、`git blame`、`git status`；改文件、别的命令、派子代理、仓库外的路径全部禁止。
CLAIM|5|一致|.agents/instructions/model-review.md:52|线程再逐条判断|2. 分类由线程做，不由模型做。线程对每一条意见逐条核对，每条都写下判断和依据（文件:行或实际运行结果），先判断它成不成立，再把成立的意见分成两类：
CLAIM|6|一致|.agents/instructions/model-review.md:62|修改、再复核|3. 按中、高严重度的“会出错”意见，或第 5 步里 Andy 采纳的意见，做了修改，就对这些修改再复核一轮
CLAIM|7|一致|.agents/reviews/topic-review-claude-side-cost/data.md:1|2026-11-13 统计|# 复核花费分析的数据（2026-11-13）
CLAIM|8|一致|.agents/reviews/topic-review-claude-side-cost/data.md:9|180 个 PR 的复核记录|- PR 数：180 个 PR 的复核记录。
CLAIM|9|一致|.agents/reviews/topic-review-claude-side-cost/data.md:18|4 个 PR 线程的用量|抽查 4 个 PR 线程的会话记录，按 API 价折算：
CLAIM|10|一致|.agents/reviews/topic-review-claude-side-cost/data.md:7|数字和取法见 [`.agents/reviews/topic-review-claude-side-cost/data.md`](../../.agents/reviews/topic-review-claude-side-cost/data.md)|取法：main 和各远程分支上 `.agents/reviews/pr-*/` 的 `usage.jsonl` 和 `verdicts.jsonl`，按 PR 目录、时间、模型、轮次去重。
CLAIM|11|一致|.agents/reviews/topic-review-claude-side-cost/data.md:20|4 个 PR 的整个线程按 API 价折算 39–86 美元|- 4 个 PR 的整个线程 39–86 美元；同一批 PR 的 DeepSeek 复核 0.39–1.44 美元。
CLAIM|12|一致|.agents/reviews/topic-review-claude-side-cost/data.md:20|同一批 PR 的 DeepSeek 复核 0.4–1.4 美元|- 4 个 PR 的整个线程 39–86 美元；同一批 PR 的 DeepSeek 复核 0.39–1.44 美元。
CLAIM|13|一致|.agents/reviews/topic-review-claude-side-cost/data.md:21|线程上下文常有 15 万到 30 万 token|- 线程上下文常有 15 万到 30 万 token，每调一次工具都按缓存价重读整段上下文。
CLAIM|14|一致|.agents/reviews/topic-review-claude-side-cost/data.md:21|每调一次工具都按缓存价重读整段上下文|- 线程上下文常有 15 万到 30 万 token，每调一次工具都按缓存价重读整段上下文。
CLAIM|15|一致|.agents/reviews/topic-review-claude-side-cost/data.md:22|一轮复核要读答案、逐条打开代码、手写 `verdicts.jsonl`（逐字抄模型原话）和 `judgments.md`、提交、跑检查|- 一轮复核约 25–40 次调用：读答案、逐条打开代码核对、写 `verdicts.jsonl` 和 `judgments.md`、提交、跑检查、更新进度。
CLAIM|16|一致|.agents/instructions/model-review.md:59|`verdicts.jsonl`（逐字抄模型原话）|`quote`（模型原话，必须能在这一轮的 `<模型>.md` 里逐字找到）
CLAIM|17|一致|.agents/reviews/topic-review-claude-side-cost/data.md:22|约 25–40 次调用|- 一轮复核约 25–40 次调用：读答案、逐条打开代码核对、写 `verdicts.jsonl` 和 `judgments.md`、提交、跑检查、更新进度。
CLAIM|18|一致|.agents/reviews/topic-review-claude-side-cost/data.md:26|线程常整份读 `.agents/instructions/model-review.md`（约 8 万字节）|- `.agents/instructions/model-review.md` 约 8 万字节。
CLAIM|19|一致|.agents/reviews/topic-review-claude-side-cost/data.md:27|`docs/incidents-and-gates.md`（约 18 万）|- `docs/incidents-and-gates.md` 约 18 万字节。
CLAIM|20|一致|.agents/reviews/topic-review-claude-side-cost/data.md:28|`docs/lessons.md`（约 15 万）|- `docs/lessons.md` 约 15 万字节。
CLAIM|21|一致|.agents/reviews/topic-review-claude-side-cost/data.md:21|读进来以后每次调用都要重付|- 线程上下文常有 15 万到 30 万 token，每调一次工具都按缓存价重读整段上下文。
CLAIM|22|一致|.agents/reviews/topic-review-claude-side-cost/data.md:13|2026-11-11 起，增量轮（带 `--previous`）中位 53 步|- 步数（DeepSeek V4.1 Flash 代码复核，2026-11-11 起）：带 `--previous` 的增量轮 312 轮，中位 53 步、中位费用 0.102 美元；第 1 轮 122 轮，中位 57 步、中位费用 0.101 美元。
CLAIM|23|一致|.agents/reviews/topic-review-claude-side-cost/data.md:13|第 1 轮的 57 步|- 步数（DeepSeek V4.1 Flash 代码复核，2026-11-11 起）：带 `--previous` 的增量轮 312 轮，中位 53 步、中位费用 0.102 美元；第 1 轮 122 轮，中位 57 步、中位费用 0.101 美元。
CLAIM|24|不一致|scripts/model-review/opencode-review.mjs:371|提示原话是“这一轮先看 git diff 的增量，但可以读任何文件”|? `上一轮复核到 ${previous}，这一轮先看 git diff ${previous}..${head} 的增量，复核增量和它直接影响的代码：调用它的地方、它调用的地方、它产生或修改的值的每个使用端。
CLAIM|25|一致|.agents/reviews/topic-review-claude-side-cost/data.md:14|步数说明模型每轮基本把整个 PR 重查一遍|- 改动前增量轮的提示原话：“这一轮先看 git diff 的增量，但可以读任何文件”。增量轮的步数和费用与第 1 轮几乎一样，说明模型每轮基本把整个 PR 重查一遍。
CLAIM|26|一致|.agents/reviews/topic-review-claude-side-cost/data.md:11|第 1 轮 460 条|- 各轮成立的中高意见：第 1 轮 460 条、第 2 轮 195、第 3 轮 107、第 4 轮 57、第 5 轮 34、6 轮以上 51。
CLAIM|27|一致|.agents/reviews/topic-review-claude-side-cost/data.md:11|第 2 轮 195|- 各轮成立的中高意见：第 1 轮 460 条、第 2 轮 195、第 3 轮 107、第 4 轮 57、第 5 轮 34、6 轮以上 51。
CLAIM|28|一致|.agents/reviews/topic-review-claude-side-cost/data.md:11|第 3 轮 107|- 各轮成立的中高意见：第 1 轮 460 条、第 2 轮 195、第 3 轮 107、第 4 轮 57、第 5 轮 34、6 轮以上 51。
CLAIM|29|一致|.agents/reviews/topic-review-claude-side-cost/data.md:11|第 4 轮 57|- 各轮成立的中高意见：第 1 轮 460 条、第 2 轮 195、第 3 轮 107、第 4 轮 57、第 5 轮 34、6 轮以上 51。
CLAIM|30|一致|.agents/reviews/topic-review-claude-side-cost/data.md:11|第 5 轮 34|- 各轮成立的中高意见：第 1 轮 460 条、第 2 轮 195、第 3 轮 107、第 4 轮 57、第 5 轮 34、6 轮以上 51。
CLAIM|31|一致|.agents/reviews/topic-review-claude-side-cost/data.md:11|6 轮以上 51|- 各轮成立的中高意见：第 1 轮 460 条、第 2 轮 195、第 3 轮 107、第 4 轮 57、第 5 轮 34、6 轮以上 51。
CLAIM|32|一致|docs/adr/0175-cheaper-code-review-rounds.md:68|按 ADR 0175 第 5 条，低严重度意见要修改、补测试后用 `--accept-low` 记进账本，每轮都这样|5. **低严重度的修改用 `--accept-low` 记进账本，不再复核。** 线程把逐条判断写进机器能读的 `round-<n>/verdicts.jsonl`，修改和补的测试提交后运行 `--assert-reviewed --accept-low <轮次>`。
CLAIM|33|一致|scripts/model-review/opencode-review.mjs:1793|第 1、2 轮照旧按 ADR 0175 修低意见|  else if (low.length > 0 && round < LOW_DEFER_FROM_ROUND)
CLAIM|34|一致|scripts/model-review/opencode-review.mjs:1511|合并检查不变：最后一轮复核的就是当前代码，复核链本来就接得上|    outsideFiles = unreviewed(complete.head, head);

未核实：线程文档“复核省 token 和提速：数据与结论”不在仓库内；`.agents/reviews` 未在工作区检出，data.md 等记录是从提交 d9609ae 的对象里读取的；三个大文件的实际字节数按 data.md 的记载核对，没有独立测量。
