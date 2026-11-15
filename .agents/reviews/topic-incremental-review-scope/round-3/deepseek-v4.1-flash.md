CLAIM|1|一致|scripts/model-review/opencode-review.mjs:382|增量轮的提示仍要求先看整个 PR 的差异。|base ? `对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。` : null,
CLAIM|2|一致|scripts/model-review/opencode-review.mjs:382|`scripts/model-review/opencode-review.mjs:382`：“对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。”|对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。
CLAIM|3|一致|scripts/model-review/opencode-review.mjs:387|同一份提示第 387 行再要求：“这一轮先看 git diff ${previous}..${head} 的增量”。|这一轮先看 git diff ${previous}..${head} 的增量
CLAIM|4|一致|scripts/model-review/opencode-review.mjs:387|`previous..head` 的差异会把合并进来的 main 算进去；|这一轮先看 git diff ${previous}..${head} 的增量
CLAIM|5|一致|.agents/instructions/model-review.md:74|合并检查判断“PR 自己的改动”用的是另一套口径。|对每个文件，分别取该提交相对它与 `--main-ref` 的合并基线的 `git diff -U0 --binary --no-renames`
CLAIM|6|一致|.agents/instructions/model-review.md:74|`.agents/instructions/model-review.md:74`：“对每个文件，分别取该提交相对它与 `--main-ref` 的合并基线的 `git diff -U0 --binary --no-renames`……|对每个文件，分别取该提交相对它与 `--main-ref` 的合并基线的 `git diff -U0 --binary --no-renames`
CLAIM|7|一致|.agents/instructions/model-review.md:74|……只是合入 main 带进来的文件差异不算改动，冲突手工解决、合并时顺手改的内容会让这个文件的比较结果变”。|只是合入 main 带进来的文件差异不算改动，冲突手工解决、合并时顺手改的内容会让这个文件的比较结果变
CLAIM|8|一致|scripts/model-review/opencode-review.mjs:1642|实现是 `scripts/model-review/opencode-review.mjs` 里的 `unreviewedFiles`。|export function unreviewedFiles(repo, from, to, ledgerPath, mainRef) {
CLAIM|9|一致|.agents/instructions/model-review.md:74|只合并 main、PR 自己没改时，合并检查从 2026-11-09 起不再要求重新复核。|Andy 2026-11-09 改：只是合入 main、PR 自己的改动没变，不用再复核
CLAIM|10|一致|.agents/instructions/model-review.md:74|`.agents/instructions/model-review.md:74`：“Andy 2026-11-09 改：只是合入 main、PR 自己的改动没变，不用再复核”。|Andy 2026-11-09 改：只是合入 main、PR 自己的改动没变，不用再复核
CLAIM|11|一致|scripts/model-review/opencode-review.mjs:3834|发给模型的提示有 100000 字节的上限。|if (Buffer.byteLength(prompt) > 100000) throw new Error("PROMPT_TOO_LARGE");
CLAIM|12|一致|scripts/model-review/opencode-review.mjs:3834|`scripts/model-review/opencode-review.mjs:3834`：`if (Buffer.byteLength(prompt) > 100000) throw new Error("PROMPT_TOO_LARGE");`|if (Buffer.byteLength(prompt) > 100000) throw new Error("PROMPT_TOO_LARGE");
CLAIM|13|一致|docs/adr/0270-faster-review-rounds.md:54|固定前缀和必答问题不能改。|固定前缀和必答问题一字不改
CLAIM|14|一致|docs/adr/0270-faster-review-rounds.md:54|`docs/adr/0270-faster-review-rounds.md` 的决定：“固定前缀和必答问题一字不改”；|固定前缀和必答问题一字不改
CLAIM|15|一致|.agents/instructions/prompt-prefix.md:28|`.agents/instructions/prompt-prefix.md` 要求每轮会变的内容只放在最后一条消息里。|每轮都会变的内容只放在最后一条用户消息里。
CLAIM|16|一致|docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87|截图今后不进 PR 的分支。|它也不在任何分支的历史里，所以合并 PR 时不会带进 main
CLAIM|17|一致|docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87|`docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87`：截图推到 `refs/review-artifacts/…`，“它也不在任何分支的历史里，所以合并 PR 时不会带进 main”。|它也不在任何分支的历史里，所以合并 PR 时不会带进 main
CLAIM|18|找不到|-|数据取自 main 上的复核账本（`.agents/reviews/pr-*/usage.jsonl`）和 git 历史。|-
CLAIM|19|找不到|-|一个 PR 从第一轮到通过的总时间几乎由轮数决定：11-15 以来 59 个 PR 里，1 轮的中位 9 分钟，2 轮 25 分钟，3 轮 49 分钟，4 轮以上 102 分钟。|-
CLAIM|20|找不到|-|每多一轮，就多一次约 10 分钟的模型运行，再加约 4 分钟的判断和修改。|-
CLAIM|21|找不到|-|复核轮数最多的 10 个 PR（488、497、464、512、481、569、473、531、485、491）共 73 轮，其中 61 轮是增量轮：|-
CLAIM|22|找不到|-|全量轮：改动行数中位 1586，步数中位 42，一次运行中位 582 秒。|-
CLAIM|23|找不到|-|增量轮：PR 自己这一轮改动的行数中位 75，步数中位 39，一次运行中位 581 秒。|-
CLAIM|24|找不到|-|只改了 30 行以内的 15 个增量轮，仍要 37 步、75 次工具调用。|-
CLAIM|25|找不到|-|16 个增量轮混进了合并 main，`previous..head` 中位 4106 行，其中 PR 自己的只有 41 行。这些轮次 46 步、645 秒，没混进 main 的是 39 步、556 秒。|-
CLAIM|26|找不到|-|第 2 轮起的 63 轮里，27 轮的上一轮已经没有中高问题。|-
CLAIM|27|找不到|-|起因是 PR 自己又改了几行代码、一句文档或截图，每次都要再花一整轮。|-
CLAIM|28|找不到|-|PR 521 的 5 轮原始调用记录显示，每轮都重取整个 PR 的差异，并分段反复读没改过的大文件：|-
CLAIM|29|找不到|-|第 5 轮只改了 1 行过滤和 1 句文档，调用 67 次，读同一个 4000 多行的文件 19 次。|-
CLAIM|30|找不到|-|别的 PR 的原始调用记录只存在各线程容器的临时目录里，已经没有了。|-
CLAIM|31|一致|.agents/instructions/model-review.md:74|合并检查本来也认为这时没有要复核的改动。|只是合入 main、PR 自己的改动没变，不用再复核
CLAIM|32|一致|scripts/model-review/opencode-review.mjs:2120|解析账本的 `parseUsage`|export function parseUsage(text, path) {
CLAIM|33|一致|scripts/model-review/delegate.mjs:283|委托核对 `delegate.mjs`|earlier = parseUsage(before, "before");
CLAIM|34|一致|scripts/model-review/review-speed-report.mjs:78|报表 `review-speed-report.mjs`|const records = readJsonLines(join(reviewsDir, entry, "usage.jsonl")).filter(
CLAIM|35|一致|scripts/model-review/opencode-review.mjs:3335|`--report`|"--report",
CLAIM|36|一致|docs/incidents-and-gates.md:112|（教训见 I-73）|双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」
CLAIM|37|一致|scripts/model-review/opencode-review.mjs:387|已经这样要求过（第 387 行）|增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读
CLAIM|38|找不到|-|30 行的增量轮仍要 37 步。|-
CLAIM|39|一致|.agents/instructions/model-review.md:74|而合并检查把这部分算作 PR 自己的改动。|冲突手工解决、合并时顺手改的内容会让这个文件的比较结果变
CLAIM|40|找不到|-|11-15 以来 150 轮里只有 3 轮被截断。|-
CLAIM|41|一致|docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87|截图按 ADR 0276 已不进分支。|它也不在任何分支的历史里，所以合并 PR 时不会带进 main
CLAIM|42|一致|test/tooling/opencode-review.test.mjs:194|现有测试里断言旧提示文字的用例要改：`test/tooling/opencode-review.test.mjs`|expect(first).toContain("git diff bbb..aaa");
CLAIM|43|一致|test/tooling/review-round-tools.test.mjs:235|`test/tooling/review-round-tools.test.mjs`|expect(prompt).toContain(`这一轮先看 git diff ${base}..${head} 的增量`);
CLAIM|44|一致|test/tooling/opencode-review-merge-gate.test.mjs:1501|`test/tooling/opencode-review-merge-gate.test.mjs`|expect(later).toContain("只做三件事");
CLAIM|45|一致|.agents/instructions/model-review.md:51|`.agents/instructions/model-review.md` 的代码复核一节|## 合并之前：代码复核
CLAIM|46|一致|.agents/instructions/model-review-card.md:2|和流程卡同步更新|# 代码复核流程卡

背景里基于复核账本的统计（59 个 PR、各轮中位数、PR 521 原始调用记录等）未能核对：`.agents/reviews` 不在当前 sparse checkout 中，`git show` 读取也被 `REVIEW_GIT_REFUSED` 拒绝；业界外部网页按规则未核对。
