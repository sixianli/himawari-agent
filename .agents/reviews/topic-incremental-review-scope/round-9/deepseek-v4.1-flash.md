CLAIM|1|一致|scripts/model-review/opencode-review.mjs:382@80a6fc760db0963aede7a370a3896e1f354ef41c|增量轮原来的提示要求先看整个 PR 的差异|base ? `对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。` : null,
CLAIM|2|一致|scripts/model-review/opencode-review.mjs:403|`scripts/model-review/opencode-review.mjs` 的 `buildPrompt` 里：“对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。”|base && !scoped ? `对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。` : null,
CLAIM|3|一致|scripts/model-review/opencode-review.mjs:414|同一份提示再要求：“这一轮先看 git diff ${previous}..${head} 的增量”|上一轮复核到 ${previous}，这一轮先看 git diff ${previous}..${head} 的增量，只做三件事
CLAIM|4|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:18|`previous..head` 的差异会把合并进来的 main 算进去|488,3,增量,463,2200,是,70,102,
CLAIM|5|一致|scripts/model-review/opencode-review.mjs:1671|合并检查判断“PR 自己的改动”用的是另一套口径|const base = gitStatus(["merge-base", mainRef, commit], repo);
CLAIM|6|一致|scripts/model-review/opencode-review.mjs:1708|实现是 `scripts/model-review/opencode-review.mjs` 里的 `unreviewedFiles`|export function unreviewedFiles(repo, from, to, ledgerPath, mainRef) {
CLAIM|7|一致|.agents/instructions/model-review.md:74|`.agents/instructions/model-review.md:74`：“对每个文件，分别取该提交相对它与 `--main-ref` 的合并基线的 `git diff -U0 --binary --no-renames`……”|对每个文件，分别取该提交相对它与 `--main-ref` 的合并基线的 `git diff -U0 --binary --no-renames`
CLAIM|8|一致|.agents/instructions/model-review.md:74|`.agents/instructions/model-review.md:74`：“……只是合入 main 带进来的文件差异不算改动，冲突手工解决、合并时顺手改的内容会让这个文件的比较结果变”|只是合入 main 带进来的文件差异不算改动，冲突手工解决、合并时顺手改的内容会让这个文件的比较结果变
CLAIM|9|一致|.agents/instructions/model-review.md:74|只合并 main、PR 自己没改时，合并检查从 2026-11-09 起不再要求重新复核|Andy 2026-11-09 改：只是合入 main、PR 自己的改动没变，不用再复核
CLAIM|10|一致|scripts/model-review/opencode-review.mjs:1718|发给模型的提示有 100000 字节的上限|export const PROMPT_MAX_BYTES = 100000;
CLAIM|11|一致|scripts/model-review/opencode-review.mjs:1764|超过就报 `PROMPT_TOO_LARGE`|if (Buffer.byteLength(prompt) > PROMPT_MAX_BYTES) return "PROMPT_TOO_LARGE";
CLAIM|12|一致|docs/adr/0270-faster-review-rounds.md:54|固定前缀和必答问题不能改|固定前缀和必答问题一字不改，所以所有轮次的前缀仍然逐字节相同
CLAIM|13|一致|.agents/instructions/prompt-prefix.md:28|`.agents/instructions/prompt-prefix.md` 要求每轮会变的内容只放在最后一条消息里|2. **每轮都会变的内容只放在最后一条用户消息里。**
CLAIM|14|一致|docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87|截图今后不进 PR 的分支|它也不在任何分支的历史里，所以合并 PR 时不会带进 main。
CLAIM|15|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:3|数据取自 main 上的复核账本（`.agents/reviews/pr-*/usage.jsonl`）和 git 历史|数据源：main 上 .agents/reviews/pr-*/usage.jsonl（2026-11-13 起、mode 为 code-review、outcome 为 ok 的记录）、各轮 verdicts.jsonl 和 git 历史。
CLAIM|16|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:3|数字、取法和逐轮明细在 [2026-11-15-incremental-rounds-data.txt]|ADR 0280 背景一节的数字都出自这里。
CLAIM|17|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:102|一个 PR 从第一轮到通过的总时间几乎由轮数决定：11-15 以来 59 个 PR 里，1 轮的中位 9 分钟，2 轮 25 分钟，3 轮 49 分钟，4 轮以上 102 分钟|一个 PR 从第一轮到通过的总时间几乎由轮数决定：1 轮的中位 9 分钟（12 个），2 轮 25 分钟（22 个），3 轮 49 分钟（15 个），4 轮以上 102 分钟（10 个）。
CLAIM|18|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:103|每多一轮，就多一次约 10 分钟的模型运行，再加约 4 分钟的判断和修改|两轮之间（上一轮结束到下一轮开跑）的间隔中位 4.2 分钟；每多一轮，就多一次约 10 分钟的模型运行，再加约 4 分钟的判断和修改。
CLAIM|19|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:91|复核轮数最多的 10 个 PR（488、497、464、512、481、569、473、531、485、491）账本里有成功记录的共 72 轮，其中 61 轮是增量轮|复核轮数最多的 10 个 PR（488、497、464、512、481、569、473、531、485、491）账本里有成功记录的共 72 轮（上表），其中 61 轮是增量轮、11 轮是全量轮
CLAIM|20|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:92|全量轮：改动行数中位 1586，步数中位 42，一次运行中位 582 秒|全量轮：改动行数中位 1586，步数中位 42，一次运行中位 582 秒。
CLAIM|21|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:93|增量轮：PR 自己这一轮改动的行数中位 75，步数中位 39，一次运行中位 581 秒|增量轮：PR 自己这一轮改动的行数中位 75，步数中位 39，一次运行中位 581 秒。
CLAIM|22|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:94|只改了 30 行以内的 15 个增量轮，仍要 37 步、75 次工具调用|只改了 30 行以内的 15 个增量轮，仍要 37 步、75 次工具调用。
CLAIM|23|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:95|16 个增量轮混进了合并 main，`previous..head` 中位 4106 行，其中 PR 自己的只有 41 行|16 个增量轮混进了合并 main，previous..head 中位 4106 行，其中 PR 自己的只有 41 行。
CLAIM|24|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:95|这些轮次 46 步、645 秒，没混进 main 的是 39 步、556 秒|这些轮次 46 步、645 秒，没混进 main 的是 39 步、556 秒。
CLAIM|25|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:96|第 2 轮起的 63 轮里，27 轮的上一轮已经没有中高问题|第 2 轮起的 63 轮里，27 轮的上一轮已经没有中高问题；30 轮的上一轮有中高问题；6 轮缺判断记录。
CLAIM|26|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:97|逐个看过的其中 3 轮（PR 512 第 6、8 轮，PR 569 第 6 轮）起因都是 PR 自己又改了几行代码或一句文档|逐个看了上一轮没有中高问题、又混进 main 且自己改动很少的几轮（PR 512 第 6、8 轮，PR 569 第 6 轮）：都有 PR 自己的小改动（修 1 处手表报错匹配、改 1 行小组件样式、改 ADR 里 1 句话），不是只合并了 main。
CLAIM|27|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:109|PR 521 的 5 轮原始调用记录显示，每轮都重取整个 PR 的差异，并分段反复读没改过的大文件|每轮都重取整个 PR 的差异（git diff <基准>..<当前>），并分段反复读没改过的大文件 scripts/model-review/opencode-review.mjs。
CLAIM|28|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:110|第 5 轮只改了 1 行过滤和 1 句文档，调用 67 次，读同一个 4000 多行的文件 19 次|第 5 轮只改了 1 行过滤和 1 句文档，调用 67 次，读同一个 4000 多行的文件 19 次。
CLAIM|29|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:108|别的 PR 的原始调用记录只存在各线程容器的临时目录里，已经没有了|别的 PR 的原始调用记录只存在各线程容器的临时目录里，已经没有了。
CLAIM|30|一致|scripts/model-review/opencode-review.mjs:387@80a6fc760db0963aede7a370a3896e1f354ef41c|原来的提示已经这样要求过（“不必整份重读”）|增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。
CLAIM|31|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:94|30 行的增量轮仍要 37 步|只改了 30 行以内的 15 个增量轮，仍要 37 步、75 次工具调用。
CLAIM|32|一致|.agents/instructions/model-review.md:74|合并检查把这部分算作 PR 自己的改动|只是合入 main 带进来的文件差异不算改动，冲突手工解决、合并时顺手改的内容会让这个文件的比较结果变
CLAIM|33|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:104|11-15 以来 150 轮里只有 3 轮被截断|11-15 以来 150 轮里只有 3 轮被截断（usage.jsonl 的 wrapUp 为 time）。
CLAIM|34|一致|docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87|截图按 ADR 0276 已不进分支|它也不在任何分支的历史里，所以合并 PR 时不会带进 main。
CLAIM|35|一致|scripts/model-review/review-increment.json:6|实现里次数是配置里的 `shadowFullTotal`|"shadowFullTotal": 10,
CLAIM|36|一致|scripts/model-review/opencode-review.mjs:4344|脚本在增量轮后打印 `SHADOW_FULL_SUGGESTED <命令>`|`SHADOW_FULL_SUGGESTED ${shadowCommand({ pr: options.pr, base: commits.base, head: commits.head, brief: options.prBrief ?? options.brief, gateway: options.gateway, models: options.models, providers: options.providers, approvedUsd: options.approvedUsd })}`,
CLAIM|37|一致|scripts/model-review/opencode-review.mjs:3671|结果写进 `.agents/reviews/pr-<编号>/shadow/`|? join(reviewDir(options.repo, options), SHADOW_DIR)
CLAIM|38|一致|scripts/model-review/review-increment.json:7|报表分档的档位是同一配置里的 `reportBucketLines`|"reportBucketLines": [30, 100, 300, 1000]
CLAIM|39|一致|scripts/model-review/opencode-review.mjs:171|在每个 PR 1 美元的额度内|"code-review": 1,
CLAIM|40|一致|test/tooling/opencode-review.test.mjs:194|现有测试里断言旧提示文字的用例要改：`test/tooling/opencode-review.test.mjs`|expect(first).toContain("git diff bbb..aaa");
CLAIM|41|一致|test/tooling/review-round-tools.test.mjs:235|现有测试里断言旧提示文字的用例要改：`test/tooling/review-round-tools.test.mjs`|expect(prompt).toContain(`这一轮先看 git diff ${base}..${head} 的增量`);
CLAIM|42|一致|test/tooling/opencode-review-merge-gate.test.mjs:1501|现有测试里断言旧提示文字的用例要改：`test/tooling/opencode-review-merge-gate.test.mjs`|expect(later).toContain("只做三件事");
CLAIM|43|一致|.agents/instructions/model-review.md:85|必答问题第 4 条要求找直接使用端|4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？
CLAIM|44|一致|scripts/model-review/opencode-review.mjs:387@80a6fc760db0963aede7a370a3896e1f354ef41c|证据指向旧代码时要跟下去|增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。
CLAIM|45|一致|scripts/model-review/opencode-review.mjs:411|增量轮提示已经写了“只做三件事”（ADR 0270）|这一轮只做三件事
CLAIM|46|一致|scripts/model-review/opencode-review.mjs:323|固定任务要求“每一条都要对照代码核对”|系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；
CLAIM|47|一致|scripts/model-review/opencode-review.mjs:387@80a6fc760db0963aede7a370a3896e1f354ef41c|范围说明写着“用 git grep 找”|三、增量产生或修改的值（导出的函数、配置键、字段、格式）的直接使用端能不能接受，用 git grep 找。
CLAIM|48|一致|scripts/model-review/opencode-review.mjs:123|`git grep` 却不在放行名单里|export const GIT_READ_COMMANDS = ["git diff", "git log", "git show", "git blame", "git status"];
CLAIM|49|找不到|-|PR 584 自己的增量轮仍然慢：增量 289、53、24、6 行，步数 40、37、39、27|-|
CLAIM|50|找不到|-|逐步读 PR 496、521、584 增量轮的原始调用记录|-|
CLAIM|51|找不到|-|模型 70% 到 90% 的读文件不在改动处上下 40 行以内|-|
CLAIM|52|找不到|-|把差异放进提示前后都一样|-|
CLAIM|53|找不到|-|紧跟着是整个 PR 的材料文件|-|
CLAIM|54|找不到|-|每轮用同一份（PR 496、502、521 各轮材料文件的哈希相同）|-|
CLAIM|55|找不到|-|里面是覆盖全 PR 的作者说法|-|
CLAIM|56|找不到|-|PR 584 第 4 轮（增量 24 行）第 19 到 36 步、第 5 轮（只改 ADR 6 行）第 7 到 27 步都在逐条核对整个 PR 的说法|-|
CLAIM|57|找不到|-|模型于是反复换写法（管道、`&&`、`cd`、`cat`）|-|
CLAIM|58|找不到|-|PR 584 每轮 4 到 9 次、PR 496 每轮 15 到 22 次工具报错|-|

未核实：`.agents/reviews/` 的账本和原始调用记录读不到，PR 584、496、502、521 的逐轮材料、哈希、步数和工具报错次数都没有独立来源，涉及这些记录的条目判为「找不到」。数据汇总只与 `docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt` 里的同文件数字对照，没有从账本重新计算。
