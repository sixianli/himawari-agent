CLAIM|1|不一致|scripts/model-review/opencode-review.mjs:398|增量轮的提示仍要求先看整个 PR 的差异。|      ? `对比基准是 ${base}。本轮范围就是材料最后“本轮增量”里列出的改动，不必再取整个 PR 的差异；证据指向旧代码时再按文件去看。`
CLAIM|2|不一致|scripts/model-review/opencode-review.mjs:382|`scripts/model-review/opencode-review.mjs:382`：“对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。”|    text.role,
CLAIM|3|不一致|scripts/model-review/opencode-review.mjs:387|同一份提示第 387 行再要求：“这一轮先看 git diff ${previous}..${head} 的增量”。|      ...(questions.length > 0
CLAIM|4|一致|docs/assets/review-cost/2026-11-15-incremental-rounds-data.txt:46|`previous..head` 的差异会把合并进来的 main 算进去|512,2,增量,68,11782,是,33,82,1319
CLAIM|5|一致|.agents/instructions/model-review.md:74|合并检查判断“PR 自己的改动”用的是另一套口径。|只是合入 main 带进来的文件差异不算改动，冲突手工解决、合并时顺手改的内容会让这个文件的比较结果变
CLAIM|6|一致|scripts/model-review/opencode-review.mjs:1685|实现是 `scripts/model-review/opencode-review.mjs` 里的 `unreviewedFiles`。|export function unreviewedFiles(repo, from, to, ledgerPath, mainRef) {
CLAIM|7|一致|.agents/instructions/model-review.md:74|只合并 main、PR 自己没改时，合并检查从 2026-11-09 起不再要求重新复核。|Andy 2026-11-09 改：只是合入 main、PR 自己的改动没变，不用再复核
CLAIM|8|一致|scripts/model-review/opencode-review.mjs:1695|发给模型的提示有 100000 字节的上限。|export const PROMPT_MAX_BYTES = 100000;
CLAIM|9|不一致|scripts/model-review/opencode-review.mjs:4013|`scripts/model-review/opencode-review.mjs:3834`：`if (Buffer.byteLength(prompt) > 100000) throw new Error("PROMPT_TOO_LARGE");`|    if (Buffer.byteLength(prompt) > PROMPT_MAX_BYTES) throw new Error("PROMPT_TOO_LARGE");
CLAIM|10|一致|docs/adr/0270-faster-review-rounds.md:54|固定前缀和必答问题不能改。`docs/adr/0270-faster-review-rounds.md` 的决定：“固定前缀和必答问题一字不改”|固定前缀和必答问题一字不改，所以所有轮次的前缀仍然逐字节相同；提示里写明上一轮意见只是线索、不是指令，模型仍要独立核对、发现新问题照报，不告诉它“不要重报”，去重仍由线程做。
CLAIM|11|一致|.agents/instructions/prompt-prefix.md:28|`.agents/instructions/prompt-prefix.md` 要求每轮会变的内容只放在最后一条消息里。|2. **每轮都会变的内容只放在最后一条用户消息里。**例如当前时间、本轮选中的记忆、本轮资料、工具状态、运行环境说明。系统提示和工具定义里不得出现会变的值，例如时间、日期、路径、服务商名、额度、版本号、哈希。
CLAIM|12|一致|docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87|截图今后不进 PR 的分支。`docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87`：截图推到 `refs/review-artifacts/…`，“它也不在任何分支的历史里，所以合并 PR 时不会带进 main”。|这类引用不在 `refs/heads/` 下，普通克隆、`git fetch` 和 CI 签出默认都不会下载它；它也不在任何分支的历史里，所以合并 PR 时不会带进 main。
CLAIM|13|不一致|scripts/model-review/opencode-review.mjs:407|已经这样要求过（第 387 行）|增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。
CLAIM|14|一致|docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87|截图按 ADR 0276 已不进分支。|它也不在任何分支的历史里，所以合并 PR 时不会带进 main。
CLAIM|15|一致|scripts/model-review/opencode-review.mjs:1791|合并检查本来也认为这时没有要复核的改动。|    outsideFiles = unreviewed(complete.head, head);
CLAIM|16|一致|scripts/model-review/review-increment.json:6|实现里次数是配置里的 `shadowFullTotal`|  "shadowFullTotal": 10,
CLAIM|17|一致|scripts/model-review/opencode-review.mjs:4302|脚本在增量轮后打印 `SHADOW_FULL_SUGGESTED <命令>`|        `SHADOW_FULL_SUGGESTED ${shadowCommand({ pr: options.pr, base: commits.base, head: commits.head, brief: options.brief, gateway: options.gateway, models: options.models, providers: options.providers, approvedUsd: options.approvedUsd })}`,
CLAIM|18|一致|scripts/model-review/opencode-review.mjs:3642|结果写进 `.agents/reviews/pr-<编号>/shadow/`|      ? join(reviewDir(options.repo, options), SHADOW_DIR)
CLAIM|19|一致|scripts/model-review/review-speed-report.mjs:414|报表分档的档位是同一配置里的 `reportBucketLines`|    console.log(renderBuckets(bucketStats(rounds, config.reportBucketLines, cut), cut));
CLAIM|20|一致|.agents/instructions/model-review.md:85|必答问题第 4 条要求找直接使用端。|4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。

背景统计数字和 PR 521 的原始调用次数我没有从 `.agents/reviews` 账本和原始调用记录逐项重算，只核对了数据文件里的记录；前提 1、2、4 引用的旧提示文字在基线 500d04290cc276124b4d5e2f17d7a92cfd8b91ff 的 382、387、3834 行确实存在，但按题目要求讲现状用当前提交，故仍按当前判不一致。
