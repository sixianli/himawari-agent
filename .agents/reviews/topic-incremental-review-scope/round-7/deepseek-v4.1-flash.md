CLAIM|1|一致|scripts/model-review/opencode-review.mjs:382@500d04290cc276124b4d5e2f17d7a92cfd8b91ff|实施前，增量轮的提示仍要求先看整个 PR 的差异。`scripts/model-review/opencode-review.mjs:382`：“对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。”|    base ? `对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。` : null,
CLAIM|2|一致|scripts/model-review/opencode-review.mjs:387@500d04290cc276124b4d5e2f17d7a92cfd8b91ff|同一份提示第 387 行再要求：“这一轮先看 git diff ${previous}..${head} 的增量”。|这一轮先看 git diff ${previous}..${head} 的增量
CLAIM|3|一致|scripts/model-review/increment.mjs:115|`previous..head` 的差异会把合并进来的 main 算进去|  const all = numstat(repo, previous, head, null);
CLAIM|4|一致|.agents/instructions/model-review.md:74|合并检查判断“PR 自己的改动”用的是另一套口径。|对每个文件，分别取该提交相对它与 `--main-ref` 的合并基线的 `git diff -U0 --binary --no-renames`
CLAIM|5|一致|.agents/instructions/model-review.md:74|`.agents/instructions/model-review.md:74`：“对每个文件，分别取该提交相对它与 `--main-ref` 的合并基线的 `git diff -U0 --binary --no-renames`……只是合入 main 带进来的文件差异不算改动，冲突手工解决、合并时顺手改的内容会让这个文件的比较结果变”。|只是合入 main 带进来的文件差异不算改动，冲突手工解决、合并时顺手改的内容会让这个文件的比较结果变
CLAIM|6|一致|scripts/model-review/opencode-review.mjs:1685|实现是 `scripts/model-review/opencode-review.mjs` 里的 `unreviewedFiles`。|export function unreviewedFiles(repo, from, to, ledgerPath, mainRef) {
CLAIM|7|一致|.agents/instructions/model-review.md:74|只合并 main、PR 自己没改时，合并检查从 2026-11-09 起不再要求重新复核。`.agents/instructions/model-review.md:74`：“Andy 2026-11-09 改：只是合入 main、PR 自己的改动没变，不用再复核”。|Andy 2026-11-09 改：只是合入 main、PR 自己的改动没变，不用再复核
CLAIM|8|一致|scripts/model-review/opencode-review.mjs:3834@500d04290cc276124b4d5e2f17d7a92cfd8b91ff|实施前，发给模型的提示有 100000 字节的上限，写死在代码里。`scripts/model-review/opencode-review.mjs:3834`：`if (Buffer.byteLength(prompt) > 100000) throw new Error("PROMPT_TOO_LARGE");`|    if (Buffer.byteLength(prompt) > 100000) throw new Error("PROMPT_TOO_LARGE");
CLAIM|9|一致|docs/adr/0270-faster-review-rounds.md:54|固定前缀和必答问题不能改。`docs/adr/0270-faster-review-rounds.md` 的决定：“固定前缀和必答问题一字不改”|固定前缀和必答问题一字不改，所以所有轮次的前缀仍然逐字节相同；
CLAIM|10|一致|.agents/instructions/prompt-prefix.md:28|`.agents/instructions/prompt-prefix.md` 要求每轮会变的内容只放在最后一条消息里。|2. **每轮都会变的内容只放在最后一条用户消息里。**
CLAIM|11|一致|docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87|截图今后不进 PR 的分支。`docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87`：截图推到 `refs/review-artifacts/…`，“它也不在任何分支的历史里，所以合并 PR 时不会带进 main”。|它也不在任何分支的历史里，所以合并 PR 时不会带进 main。
CLAIM|12|一致|scripts/model-review/opencode-review.mjs:1791|合并检查本来也认为这时没有要复核的改动。|    outsideFiles = unreviewed(complete.head, head);    for (const file of outsideFiles) problems.push(`unreviewed ${printable(file)}`);
CLAIM|13|一致|scripts/model-review/opencode-review.mjs:4299|实现里次数是配置里的 `shadowFullTotal`|      shadowRunsDone(join(options.repo, REVIEWS_DIR)) < incrementConfig.shadowFullTotal
CLAIM|14|一致|scripts/model-review/opencode-review.mjs:4302|脚本在增量轮后打印 `SHADOW_FULL_SUGGESTED <命令>`|        `SHADOW_FULL_SUGGESTED ${shadowCommand({ pr: options.pr, base: commits.base, head: commits.head, brief: options.brief, gateway: options.gateway, models: options.models, providers: options.providers, approvedUsd: options.approvedUsd })}`,
CLAIM|15|一致|scripts/model-review/opencode-review.mjs:3642|结果写进 `.agents/reviews/pr-<编号>/shadow/`。|      ? join(reviewDir(options.repo, options), SHADOW_DIR)
CLAIM|16|一致|scripts/model-review/review-speed-report.mjs:414|报表分档的档位是同一配置里的 `reportBucketLines`。|    console.log(renderBuckets(bucketStats(rounds, config.reportBucketLines, cut), cut));
CLAIM|17|一致|test/tooling/opencode-review.test.mjs:195|现有测试里断言旧提示文字的用例要改：`test/tooling/opencode-review.test.mjs`|    expect(second).toContain("git diff eee..ccc");
CLAIM|18|一致|test/tooling/review-round-tools.test.mjs:235|现有测试里断言旧提示文字的用例要改：`test/tooling/review-round-tools.test.mjs`|    expect(prompt).toContain(`这一轮先看 git diff ${base}..${head} 的增量`);
CLAIM|19|一致|test/tooling/opencode-review-merge-gate.test.mjs:1501|现有测试里断言旧提示文字的用例要改：`test/tooling/opencode-review-merge-gate.test.mjs`|    expect(later).toContain("只做三件事");

背景一节的统计数字（59 个 PR、各中位数、PR 521 调用次数等）以及增量为空、退回、抽样全量复核等运行时效果，我没有从账本逐条重算或实际运行；这些部分未核实。
