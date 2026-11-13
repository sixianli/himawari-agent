CLAIM|1|一致|.agents/instructions/model-review.md:4|合并前的代码复核用 `scripts/model-review/opencode-review.mjs`|一律用 `node scripts/model-review/opencode-review.mjs` 跑（见[怎么跑](#how-to-run)）。
CLAIM|2|一致|scripts/model-review/opencode-review.mjs:52|经 OpenCode（一个能让模型读代码、调用工具的命令行程序）复核|export const OPENCODE_VERSION = "1.19.5";
CLAIM|3|一致|.agents/instructions/model-review.md:4|请 DeepSeek V4.1 Flash 复核|默认只用 `opencode-go/deepseek-v4.1-flash` 一个模型，推理强度设为高；
CLAIM|4|一致|scripts/model-review/opencode-review.mjs:356|复核是只读的|你能用的工具：read、grep、glob${OFFLINE_MODES.includes(mode) ? "" : "、websearch、webfetch"}，以及 ${GIT_READ_COMMANDS.join("、")} 这几条 git 命令。不能修改任何文件，不能运行别的命令。${text.network}
CLAIM|5|一致|.agents/instructions/model-review.md:52|线程再逐条判断|2. 分类由线程做，不由模型做。线程对每一条意见逐条核对，每条都写下判断和依据（文件:行或实际运行结果），先判断它成不成立，再把成立的意见分成两类：
CLAIM|6|一致|.agents/instructions/model-review.md:62|线程再修改|3. 按中、高严重度的“会出错”意见，或第 5 步里 Andy 采纳的意见，做了修改，就对这些修改再复核一轮（传 `--previous <上一轮复核的提交>`，模型只复核增量和增量直接影响的代码），一直到线程核对后没有中、高严重度的“会出错”意见为止，第 4 步的停止条件除外。
CLAIM|7|一致|.agents/instructions/model-review.md:62|修改后再复核|3. 按中、高严重度的“会出错”意见，或第 5 步里 Andy 采纳的意见，做了修改，就对这些修改再复核一轮（传 `--previous <上一轮复核的提交>`，模型只复核增量和增量直接影响的代码），一直到线程核对后没有中、高严重度的“会出错”意见为止，第 4 步的停止条件除外。
CLAIM|8|一致|docs/assets/review-cost/2026-11-13-data.txt:9|2026-11-13 统计 180 个 PR 的复核记录|- PR 数：180 个 PR 的复核记录。
CLAIM|9|一致|docs/assets/review-cost/2026-11-13-data.txt:18|2026-11-13 统计 4 个 PR 线程的用量|抽查 4 个 PR 线程的会话记录，按 API 价折算：
CLAIM|10|一致|docs/assets/review-cost/2026-11-13-data.txt:7|数字和取法见 `docs/assets/review-cost/2026-11-13-data.txt`|取法：main 和各远程分支上 `.agents/reviews/pr-*/` 的 `usage.jsonl` 和 `verdicts.jsonl`，按 PR 目录、时间、模型、轮次去重。
CLAIM|11|一致|docs/assets/review-cost/2026-11-13-data.txt:20|钱的大头在 Claude 线程这边|- 4 个 PR 的整个线程 39–86 美元；同一批 PR 的 DeepSeek 复核 0.39–1.44 美元。
CLAIM|12|一致|docs/assets/review-cost/2026-11-13-data.txt:20|4 个 PR 的整个线程按 API 价折算 39–86 美元|- 4 个 PR 的整个线程 39–86 美元；同一批 PR 的 DeepSeek 复核 0.39–1.44 美元。
CLAIM|13|一致|docs/assets/review-cost/2026-11-13-data.txt:20|同一批 PR 的 DeepSeek 复核 0.4–1.4 美元|- 4 个 PR 的整个线程 39–86 美元；同一批 PR 的 DeepSeek 复核 0.39–1.44 美元。
CLAIM|14|一致|docs/assets/review-cost/2026-11-13-data.txt:21|线程上下文常有 15 万到 30 万 token|- 线程上下文常有 15 万到 30 万 token，每调一次工具都按缓存价重读整段上下文。
CLAIM|15|一致|docs/assets/review-cost/2026-11-13-data.txt:21|每调一次工具都按缓存价重读整段上下文|- 线程上下文常有 15 万到 30 万 token，每调一次工具都按缓存价重读整段上下文。
CLAIM|16|一致|docs/assets/review-cost/2026-11-13-data.txt:22|一轮复核要读答案、逐条打开代码核对、提交、跑检查|- 一轮复核约 25–40 次调用：读答案、逐条打开代码核对、写 `verdicts.jsonl` 和 `judgments.md`、提交、跑检查、更新进度。
CLAIM|17|一致|.agents/instructions/model-review.md:59|手写 `verdicts.jsonl`（逐字抄模型原话）和 `judgments.md`|- 逐条判断除了写进给人看的 `round-<n>/judgments.md`，还要一条一行写进 `round-<n>/verdicts.jsonl`（脚本读它）：`id`、`model`（完整模型名）、`quote`（模型原话，必须能在这一轮的 `<模型>.md` 里逐字找到）、`valid`（成立与否）、`class`（`error` 是“会出错”，`better` 是“可以更好”）；
CLAIM|18|一致|docs/assets/review-cost/2026-11-13-data.txt:22|约 25–40 次调用|- 一轮复核约 25–40 次调用：读答案、逐条打开代码核对、写 `verdicts.jsonl` 和 `judgments.md`、提交、跑检查、更新进度。
CLAIM|19|找不到|-|线程常整份读 `.agents/instructions/model-review.md`、`docs/incidents-and-gates.md`、`docs/lessons.md`|-
CLAIM|20|一致|docs/assets/review-cost/2026-11-13-data.txt:26|`.agents/instructions/model-review.md` 约 8 万字节|- `.agents/instructions/model-review.md` 约 8 万字节。
CLAIM|21|一致|docs/assets/review-cost/2026-11-13-data.txt:27|`docs/incidents-and-gates.md` 约 18 万字节|- `docs/incidents-and-gates.md` 约 18 万字节。
CLAIM|22|一致|docs/assets/review-cost/2026-11-13-data.txt:28|`docs/lessons.md` 约 15 万字节|- `docs/lessons.md` 约 15 万字节。
CLAIM|23|一致|docs/assets/review-cost/2026-11-13-data.txt:21|读进来以后每次调用都要重付|- 线程上下文常有 15 万到 30 万 token，每调一次工具都按缓存价重读整段上下文。
CLAIM|24|一致|docs/assets/review-cost/2026-11-13-data.txt:13|2026-11-11 起，增量轮（带 `--previous`）中位 53 步|- 步数（DeepSeek V4.1 Flash 代码复核，2026-11-11 起）：带 `--previous` 的增量轮 312 轮，中位 53 步、中位费用 0.102 美元；第 1 轮 122 轮，中位 57 步、中位费用 0.101 美元。
CLAIM|25|一致|docs/assets/review-cost/2026-11-13-data.txt:13|第 1 轮中位 57 步|- 步数（DeepSeek V4.1 Flash 代码复核，2026-11-11 起）：带 `--previous` 的增量轮 312 轮，中位 53 步、中位费用 0.102 美元；第 1 轮 122 轮，中位 57 步、中位费用 0.101 美元。
CLAIM|26|不一致|scripts/model-review/opencode-review.mjs:371（改动前，ccec8bd0f^）|提示原话是“这一轮先看 git diff 的增量，但可以读任何文件”|? `上一轮复核到 ${previous}，先看 git diff ${previous}..${head} 的增量，但可以读任何文件。`
CLAIM|27|一致|docs/assets/review-cost/2026-11-13-data.txt:14|步数说明模型每轮基本把整个 PR 重查一遍|- 改动前增量轮的提示原话：“这一轮先看 git diff 的增量，但可以读任何文件”。增量轮的步数和费用与第 1 轮几乎一样，说明模型每轮基本把整个 PR 重查一遍。
CLAIM|28|一致|docs/assets/review-cost/2026-11-13-data.txt:11|各轮成立的中高意见：第 1 轮 460 条、第 2 轮 195、第 3 轮 107、第 4 轮 57、第 5 轮 34、6 轮以上 51|- 各轮成立的中高意见：第 1 轮 460 条、第 2 轮 195、第 3 轮 107、第 4 轮 57、第 5 轮 34、6 轮以上 51。
CLAIM|29|找不到|-|第 3 轮以后的回报明显变少|-
CLAIM|30|一致|docs/adr/0175-cheaper-code-review-rounds.md:68|按 ADR 0175 第 5 条，低严重度意见要修改、补测试后用 `--accept-low` 记进账本，每轮都这样|5. **低严重度的修改用 `--accept-low` 记进账本，不再复核。** 线程把逐条判断写进机器能读的 `round-<n>/verdicts.jsonl`，修改和补的测试提交后运行 `--assert-reviewed --accept-low <轮次>`。
CLAIM|31|找不到|-|图表和逐项解释见线程文档“复核省 token 和提速：数据与结论”|-
CLAIM|32|一致|docs/adr/0175-cheaper-code-review-rounds.md:12|ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮|# ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮
CLAIM|33|一致|docs/adr/0259-review-models-default-to-deepseek.md:11|ADR 0259：方案审核和代码复核默认只用 DeepSeek|# ADR 0259：方案审核和代码复核默认只用 DeepSeek，默认模型写在配置里
CLAIM|34|一致|.agents/instructions/model-review.md:2|和 OpenCode 协作|# 和 OpenCode 协作：方案讨论和代码复核
CLAIM|35|一致|.agents/instructions/model-review-card.md:2|代码复核流程卡|# 代码复核流程卡

没能核对的部分：Andy 的原话、业界引用、线程文档“复核省 token 和提速：数据与结论”以及各线程的实际会话记录（包括是否整份读大文件）都不在仓库里；三个大文件的字节数只核对了数据文件的记载，没有独立统计。背景描述的是改动前基线（当前提交已包含 ADR 0263 的实现，所以按当前代码看旧提示和手写步骤已被脚本替换）；其中“提示原话”一句即使按改动前的实际提示也不是逐字原话。
