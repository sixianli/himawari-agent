CLAIM|1|一致|.agents/instructions/model-review.md:98|合并前的代码复核用 `scripts/model-review/opencode-review.mjs` 经 OpenCode|用 `node scripts/model-review/opencode-review.mjs` 跑，不要自己拼 `opencode run` 命令。
CLAIM|2|一致|scripts/model-review/review-models.json:3|请 DeepSeek V4.1 Flash 复核|  "default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|3|一致|.agents/instructions/model-review.md:100|复核是只读的|模型自己读代码：只开读文件、按内容搜索、按文件名找文件，以及 `git diff`、`git log`、`git show`、`git blame`、`git status`；改文件、别的命令、派子代理、仓库外的路径全部禁止。
CLAIM|4|一致|.agents/instructions/model-review.md:52|线程再逐条判断|分类由线程做，不由模型做。线程对每一条意见逐条核对，每条都写下判断和依据（文件:行或实际运行结果），先判断它成不成立，再把成立的意见分成两类：
CLAIM|5|一致|.agents/instructions/model-review.md:62|线程修改、再复核|按中、高严重度的“会出错”意见，或第 5 步里 Andy 采纳的意见，做了修改，就对这些修改再复核一轮（传 `--previous <上一轮复核的提交>`，模型只复核增量和增量直接影响的代码），一直到线程核对后没有中、高严重度的“会出错”意见为止，第 4 步的停止条件除外。
CLAIM|6|一致|docs/assets/review-cost/2026-11-13-data.txt:9|统计 180 个 PR 的复核记录|- PR 数：180 个 PR 的复核记录。
CLAIM|7|一致|docs/assets/review-cost/2026-11-13-data.txt:19|统计 4 个 PR 线程的用量|抽查 4 个 PR 线程的会话记录，按 API 价折算：
CLAIM|8|一致|docs/assets/review-cost/2026-11-13-data.txt:3|数字和取法见 `docs/assets/review-cost/2026-11-13-data.txt`|ADR 0263 背景一节的数字都出自这里。图表和逐项解释在线程文档“复核省 token 和提速：数据与结论”。
CLAIM|9|一致|docs/assets/review-cost/2026-11-13-data.txt:21|4 个 PR 的整个线程按 API 价折算 39–86 美元|4 个 PR 的整个线程 39–86 美元；同一批 PR 的 DeepSeek 复核 0.39–1.44 美元。
CLAIM|10|一致|docs/assets/review-cost/2026-11-13-data.txt:21|同一批 PR 的 DeepSeek 复核 0.4–1.4 美元|同一批 PR 的 DeepSeek 复核 0.39–1.44 美元。
CLAIM|11|一致|docs/assets/review-cost/2026-11-13-data.txt:22|线程上下文常有 15 万到 30 万 token|线程上下文常有 15 万到 30 万 token，每调一次工具都按缓存价重读整段上下文。
CLAIM|12|一致|docs/assets/review-cost/2026-11-13-data.txt:22|每调一次工具都按缓存价重读整段上下文|线程上下文常有 15 万到 30 万 token，每调一次工具都按缓存价重读整段上下文。
CLAIM|13|一致|docs/assets/review-cost/2026-11-13-data.txt:23|一轮复核约 25–40 次调用|一轮复核约 25–40 次调用：读答案、逐条打开代码核对、写 `verdicts.jsonl` 和 `judgments.md`、提交、跑检查、更新进度。
CLAIM|14|一致|docs/assets/review-cost/2026-11-13-data.txt:23|一轮复核要读答案、逐条打开代码、写 `verdicts.jsonl` 和 `judgments.md`、提交、跑检查|一轮复核约 25–40 次调用：读答案、逐条打开代码核对、写 `verdicts.jsonl` 和 `judgments.md`、提交、跑检查、更新进度。
CLAIM|15|一致|.agents/instructions/model-review.md:59|`verdicts.jsonl` 逐字抄模型原话|`quote`（模型原话，必须能在这一轮的 `<模型>.md` 里逐字找到）
CLAIM|16|一致|docs/assets/review-cost/2026-11-13-data.txt:30|线程常整份读 `.agents/instructions/model-review.md`（约 8 万字节）|- `.agents/instructions/model-review.md` 约 8 万字节。
CLAIM|17|一致|docs/assets/review-cost/2026-11-13-data.txt:31|`docs/incidents-and-gates.md` 约 18 万|- `docs/incidents-and-gates.md` 约 18 万字节。
CLAIM|18|一致|docs/assets/review-cost/2026-11-13-data.txt:32|`docs/lessons.md` 约 15 万|- `docs/lessons.md` 约 15 万字节。
CLAIM|19|一致|docs/assets/review-cost/2026-11-13-data.txt:14|2026-11-11 起增量轮中位 53 步|2026-11-11 起）：带 `--previous` 的增量轮 312 轮，中位 53 步、中位费用 0.102 美元
CLAIM|20|一致|docs/assets/review-cost/2026-11-13-data.txt:14|第 1 轮中位 57 步|第 1 轮 122 轮，中位 57 步、中位费用 0.101 美元。
CLAIM|21|一致|scripts/model-review/opencode-review.mjs:368（ccec8bd0f^）|增量轮提示原话是“上一轮复核到 ${previous}，先看 git diff ${previous}..${head} 的增量，但可以读任何文件。”|`上一轮复核到 ${previous}，先看 git diff ${previous}..${head} 的增量，但可以读任何文件。`
CLAIM|22|一致|docs/assets/review-cost/2026-11-13-data.txt:11|第 1 轮成立的中高意见 460 条|第 1 轮 460 条
CLAIM|23|一致|docs/assets/review-cost/2026-11-13-data.txt:11|第 2 轮成立的中高意见 195 条|第 2 轮 195
CLAIM|24|一致|docs/assets/review-cost/2026-11-13-data.txt:11|第 3 轮成立的中高意见 107 条|第 3 轮 107
CLAIM|25|一致|docs/assets/review-cost/2026-11-13-data.txt:11|第 4 轮成立的中高意见 57 条|第 4 轮 57
CLAIM|26|一致|docs/assets/review-cost/2026-11-13-data.txt:11|第 5 轮成立的中高意见 34 条|第 5 轮 34
CLAIM|27|一致|docs/assets/review-cost/2026-11-13-data.txt:11|6 轮以上成立的中高意见 51 条|6 轮以上 51
CLAIM|28|一致|docs/assets/review-cost/2026-11-13-data.txt:12|第 3 轮以后回报明显变少|第 3 轮起每一轮成立的中高意见都不到第 1 轮（460 条）的四分之一，回报明显变少。
CLAIM|29|一致|docs/adr/0175-cheaper-code-review-rounds.md:68|按 ADR 0175 第 5 条，低严重度意见要修改、补测试后用 `--accept-low` 记进账本|低严重度的修改用 `--accept-low` 记进账本，不再复核。** 线程把逐条判断写进机器能读的 `round-<n>/verdicts.jsonl`，修改和补的测试提交后运行 `--assert-reviewed --accept-low <轮次>`。
CLAIM|30|一致|docs/adr/0175-cheaper-code-review-rounds.md:68|低严重度意见每轮都这样|低严重度的修改用 `--accept-low` 记进账本，不再复核。
CLAIM|31|找不到|-|图表和逐项解释见线程文档“复核省 token 和提速：数据与结论”|-
CLAIM|32|一致|docs/assets/review-cost/2026-11-13-data.txt:22|主线程照旧复核时每次调用仍要重读 15 万以上 token 的上下文|线程上下文常有 15 万到 30 万 token，每调一次工具都按缓存价重读整段上下文。
CLAIM|33|一致|scripts/model-review/opencode-review.mjs:285|必答问题不变|export function reviewQuestions(markdown) {
CLAIM|34|一致|scripts/model-review/opencode-review.mjs:1509|合并检查不变：最后一轮复核的就是当前代码，复核链本来就接得上|else if (!isAncestor(complete.head, head)) problems.push(`not-ancestor ${complete.head}`);
CLAIM|35|一致|docs/adr/0175-cheaper-code-review-rounds.md:12|ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮|# ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮
CLAIM|36|一致|docs/adr/0259-review-models-default-to-deepseek.md:11|ADR 0259：方案审核和代码复核默认只用 DeepSeek|# ADR 0259：方案审核和代码复核默认只用 DeepSeek，默认模型写在配置里
CLAIM|37|一致|.agents/instructions/model-review.md:2|关联文档“和 OpenCode 协作”指向 `.agents/instructions/model-review.md`|# 和 OpenCode 协作：方案讨论和代码复核

线程文档“复核省 token 和提速：数据与结论”不在仓库内，未能核对；三份大文件的字节数只按仓库里的数据文件核对，未独立测量实际字节。增量轮旧提示按 `ccec8bd0f^` 的旧版本核对，当前 HEAD 已换成新提示。
