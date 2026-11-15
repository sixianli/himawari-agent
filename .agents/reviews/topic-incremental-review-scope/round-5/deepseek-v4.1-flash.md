CLAIM|1|一致|scripts/model-review/opencode-review.mjs:382|增量轮的提示仍要求先看整个 PR 的差异。`scripts/model-review/opencode-review.mjs:382`：“对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。”|base ? `对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。` : null,
CLAIM|2|一致|scripts/model-review/opencode-review.mjs:387|同一份提示第 387 行再要求：“这一轮先看 git diff ${previous}..${head} 的增量”。|? `上一轮复核到 ${previous}，这一轮先看 git diff ${previous}..${head} 的增量，只做三件事：
CLAIM|3|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:95|`previous..head` 的差异会把合并进来的 main 算进去|16 个增量轮混进了合并 main，previous..head 中位 4106 行，其中 PR 自己的只有 41 行。这些轮次 46 步、645 秒，没混进 main 的是 39 步、556 秒。
CLAIM|4|一致|.agents/instructions/model-review.md:74|合并检查判断“PR 自己的改动”用的是另一套口径。`.agents/instructions/model-review.md:74`：“对每个文件，分别取该提交相对它与 `--main-ref` 的合并基线的 `git diff -U0 --binary --no-renames`……|对每个文件，分别取该提交相对它与 `--main-ref` 的合并基线的 `git diff -U0 --binary --no-renames`，去掉 `@@` 和 `index` 行后取 SHA-256 比较
CLAIM|5|一致|.agents/instructions/model-review.md:74|只是合入 main 带进来的文件差异不算改动，冲突手工解决、合并时顺手改的内容会让这个文件的比较结果变|只是合入 main 带进来的文件差异不算改动，冲突手工解决、合并时顺手改的内容会让这个文件的比较结果变，仍报 `unreviewed <文件>`
CLAIM|6|一致|scripts/model-review/opencode-review.mjs:1642|实现是 `scripts/model-review/opencode-review.mjs` 里的 `unreviewedFiles`。|export function unreviewedFiles(repo, from, to, ledgerPath, mainRef) {
CLAIM|7|一致|.agents/instructions/model-review.md:74|只合并 main、PR 自己没改时，合并检查从 2026-11-09 起不再要求重新复核。`.agents/instructions/model-review.md:74`：“Andy 2026-11-09 改：只是合入 main、PR 自己的改动没变，不用再复核”。|Andy 2026-11-09 改：只是合入 main、PR 自己的改动没变，不用再复核
CLAIM|8|一致|scripts/model-review/opencode-review.mjs:3834|发给模型的提示有 100000 字节的上限。`scripts/model-review/opencode-review.mjs:3834`：`if (Buffer.byteLength(prompt) > 100000) throw new Error("PROMPT_TOO_LARGE");`|if (Buffer.byteLength(prompt) > 100000) throw new Error("PROMPT_TOO_LARGE");
CLAIM|9|一致|docs/adr/0270-faster-review-rounds.md:54|固定前缀和必答问题不能改。`docs/adr/0270-faster-review-rounds.md` 的决定：“固定前缀和必答问题一字不改”|固定前缀和必答问题一字不改，所以所有轮次的前缀仍然逐字节相同
CLAIM|10|一致|.agents/instructions/prompt-prefix.md:28|`.agents/instructions/prompt-prefix.md` 要求每轮会变的内容只放在最后一条消息里。|2. **每轮都会变的内容只放在最后一条用户消息里。**
CLAIM|11|一致|docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87|截图今后不进 PR 的分支。`docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87`：截图推到 `refs/review-artifacts/…`|推到 `refs/review-artifacts/pr-<编号>/<批次>`，附 `manifest.json`
CLAIM|12|一致|docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87|“它也不在任何分支的历史里，所以合并 PR 时不会带进 main”。|它也不在任何分支的历史里，所以合并 PR 时不会带进 main。
CLAIM|13|找不到|-|数据取自 main 上的复核账本（`.agents/reviews/pr-*/usage.jsonl`）和 git 历史|-
CLAIM|14|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:1|数字、取法和逐轮明细在 [2026-11-15-incremental-rounds-data.txt](../assets/review-cost/2026-11-15-incremental-rounds-data.txt)。|# 增量轮数据（2026-11-15）
CLAIM|15|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:99|11-15 以来 59 个 PR 里|- 每个 PR 的总时间（11-15 日本时间以来，首轮记了运行时长的 59 个 PR，共 150 轮）
CLAIM|16|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:102|1 轮的中位 9 分钟，2 轮 25 分钟，3 轮 49 分钟，4 轮以上 102 分钟。|- 一个 PR 从第一轮到通过的总时间几乎由轮数决定：1 轮的中位 9 分钟（12 个），2 轮 25 分钟（22 个），3 轮 49 分钟（15 个），4 轮以上 102 分钟（10 个）。
CLAIM|17|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:103|每多一轮，就多一次约 10 分钟的模型运行，再加约 4 分钟的判断和修改。|- 两轮之间（上一轮结束到下一轮开跑）的间隔中位 4.2 分钟；每多一轮，就多一次约 10 分钟的模型运行，再加约 4 分钟的判断和修改。
CLAIM|18|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:91|复核轮数最多的 10 个 PR（488、497、464、512、481、569、473、531、485、491）账本里有成功记录的共 72 轮，其中 61 轮是增量轮|- 复核轮数最多的 10 个 PR（488、497、464、512、481、569、473、531、485、491）账本里有成功记录的共 72 轮（上表），其中 61 轮是增量轮、11 轮是全量轮（PR 488 第 12 轮重新做了全量）；PR 488 第 7 轮账本里没有成功记录，不在表内。
CLAIM|19|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:92|全量轮：改动行数中位 1586，步数中位 42，一次运行中位 582 秒。|- 全量轮：改动行数中位 1586，步数中位 42，一次运行中位 582 秒。
CLAIM|20|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:93|增量轮：PR 自己这一轮改动的行数中位 75，步数中位 39，一次运行中位 581 秒。|- 增量轮：PR 自己这一轮改动的行数中位 75，步数中位 39，一次运行中位 581 秒。
CLAIM|21|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:94|只改了 30 行以内的 15 个增量轮，仍要 37 步、75 次工具调用。|- 只改了 30 行以内的 15 个增量轮，仍要 37 步、75 次工具调用。
CLAIM|22|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:95|16 个增量轮混进了合并 main，`previous..head` 中位 4106 行，其中 PR 自己的只有 41 行。这些轮次 46 步、645 秒，没混进 main 的是 39 步、556 秒。|- 16 个增量轮混进了合并 main，previous..head 中位 4106 行，其中 PR 自己的只有 41 行。这些轮次 46 步、645 秒，没混进 main 的是 39 步、556 秒。
CLAIM|23|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:96|第 2 轮起的 63 轮里，27 轮的上一轮已经没有中高问题。|- 第 2 轮起的 63 轮里，27 轮的上一轮已经没有中高问题；30 轮的上一轮有中高问题；6 轮缺判断记录。
CLAIM|24|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:97|逐个看过的其中 3 轮（PR 512 第 6、8 轮，PR 569 第 6 轮）起因都是 PR 自己又改了几行代码或一句文档，每次都要再花一整轮。|- 逐个看了上一轮没有中高问题、又混进 main 且自己改动很少的几轮（PR 512 第 6、8 轮，PR 569 第 6 轮）：都有 PR 自己的小改动（修 1 处手表报错匹配、改 1 行小组件样式、改 ADR 里 1 句话），不是只合并了 main。
CLAIM|25|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:109|PR 521 的 5 轮原始调用记录显示，每轮都重取整个 PR 的差异，并分段反复读没改过的大文件：|- 每轮都重取整个 PR 的差异（git diff <基准>..<当前>），并分段反复读没改过的大文件 scripts/model-review/opencode-review.mjs。
CLAIM|26|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:110|第 5 轮只改了 1 行过滤和 1 句文档，调用 67 次，读同一个 4000 多行的文件 19 次。|- 各轮工具调用次数：第 1 轮 55、第 2 轮 30、第 3 轮 47、第 4 轮 45、第 5 轮 67；读 opencode-review.mjs 的次数：9、5、9、10、19。第 5 轮只改了 1 行过滤和 1 句文档，调用 67 次，读同一个 4000 多行的文件 19 次。
CLAIM|27|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:108|别的 PR 的原始调用记录只存在各线程容器的临时目录里，已经没有了。|- 来源：这个线程容器里的 /tmp/himawari-review-raw/<仓库>/pr-521/round-N/deepseek-v4.1-flash.jsonl（模型每次调用工具的原始输出）。别的 PR 的原始调用记录只存在各线程容器的临时目录里，已经没有了。
CLAIM|28|一致|scripts/model-review/opencode-review.mjs:387|已经这样要求过（第 387 行）|增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。
CLAIM|29|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:104|11-15 以来 150 轮里只有 3 轮被截断。|- 11-15 以来 150 轮里只有 3 轮被截断（usage.jsonl 的 wrapUp 为 time）。
CLAIM|30|一致|.agents/instructions/model-review.md:74|二进制文件只列路径和大小变化，不读内容，仍算在合并检查要求复核的改动里，合并检查的规则不变。|按原始字节比较，空白、权限位、二进制内容都参与，行号和上下文不参与
CLAIM|31|一致|test/tooling/opencode-review.test.mjs:194|现有测试里断言旧提示文字的用例要改：`test/tooling/opencode-review.test.mjs`|expect(first).toContain("git diff bbb..aaa");
CLAIM|32|一致|test/tooling/review-round-tools.test.mjs:235|现有测试里断言旧提示文字的用例要改：`test/tooling/review-round-tools.test.mjs`|expect(prompt).toContain(`这一轮先看 git diff ${base}..${head} 的增量`);
CLAIM|33|一致|test/tooling/opencode-review-merge-gate.test.mjs:1501|现有测试里断言旧提示文字的用例要改：`test/tooling/opencode-review-merge-gate.test.mjs`|expect(later).toContain("只做三件事");
CLAIM|34|一致|.agents/instructions/model-review.md:51|`.agents/instructions/model-review.md` 的代码复核一节|## 合并之前：代码复核
CLAIM|35|一致|.agents/instructions/model-review-card.md:2|流程卡同步更新|# 代码复核流程卡
CLAIM|36|一致|.agents/instructions/model-review.md:85|必答问题第 4 条要求找直接使用端|4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。
CLAIM|37|一致|.agents/instructions/model-review.md:68|在每个 PR 1 美元的额度内|4. 每多跑一轮之前，在汇报里写明已花的累计费用；这一个 PR 的复核累计费用（已花的加上这一轮预计的）会超过 1 美元时，先问 Andy
CLAIM|38|一致|scripts/model-review/opencode-review.mjs:1690|合并检查本来也认为这时没有要复核的改动。|outsideFiles = unreviewed(complete.head, head); for (const file of outsideFiles) problems.push(`unreviewed ${printable(file)}`);

未核实：`.agents/reviews` 账本不在当前检出中（git 对 records-path 的读取被拒绝），`origin/main` 也不存在，因此无法确认数据是否确实取自该账本。PR 521 等原始调用记录本身也不在仓库里，背景数字只能核对到数据文件这一层，未能独立重算。
