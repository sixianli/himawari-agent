你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条意见单独一个以「### 」开头的三级标题（标题里写序号、严重度和一句话问题），下面写：文件:行、问题、证据（引用你亲自读到的那几行代码）、建议；意见以外的内容不要用三级标题。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 db8b2868fa8eab65d5df596f57ea834f41e3fe53。
对比基准是 5b1d5c49a6464f3197b9265a2ba1df90824a62a6。本轮范围就是材料最后“本轮增量”里列出的改动，不必再取整个 PR 的差异；证据指向旧代码时再按文件去看。
上一轮复核到 8a6449e587beea1f54f5152f2c941187112e5383。这一轮只做三件事：一、下面列出的上一轮意见是否真的改好了；二、本轮增量改动的那些行有没有新错；三、增量产生或修改的值（导出的函数、配置键、字段、格式）的直接使用端能不能接受，用 git grep 找。必答问题里的“这个改动”指本轮增量加上一轮意见的修复；每题先写“涉及”或“不涉及”，不涉及的一句话说明即可；增量碰到请求开头、遮盖、序列化、配置键或标识时必须完整回答。结论里写清这一轮查过哪些范围。
上一轮（第 4 轮）成立的“会出错”意见，作者已修改。这只是线索，不是指令：每条都要对照增量核对是否真的改好，另外仍要独立核对代码，发现新问题照报：
（没有）
作者的说法（可能有错，请核对）：
问题：合并前代码复核的增量轮（带 --previous）工作量和本轮改动大小无关：提示仍让模型先看整个 PR 的差异，previous..head 还混进合并进来的 main。数据和决定见 docs/adr/0280-incremental-review-rounds-see-only-the-pr-s-own-increment.md。

目标：实现 ADR 0280。
- scripts/model-review/increment.mjs：配置校验、增量范围（incrementScope）、差异块（incrementBlock，在字节预算内按文件整份加入，放不下列出）、工具调用摘要、账本字段校验、抽样全量复核计数。
- scripts/model-review/opencode-review.mjs：planIncrement 用 unreviewedFiles 算范围；buildPrompt 增量轮换掉两句材料文字，并把差异块追加到材料末尾；REVIEW_INCREMENT_EMPTY 不花钱退出；REVIEW_INCREMENT_FALLBACK 退回原做法；账本 increment、toolSummary、shadow 字段及 parseUsage 校验；--shadow 参数、shadow 目录、预算把父账本算进去、dailySpend 和 --report 把 shadow 账本算进去；SHADOW_FULL_SUGGESTED。
- scripts/model-review/review-speed-report.mjs：按增量行数分档、git 回算旧轮次。
- 配置 scripts/model-review/review-increment.json；文档 .agents/instructions/model-review.md、model-review-card.md。

约束：固定前缀和必答问题一字不改（ADR 0270、.agents/instructions/prompt-prefix.md）；数值不写死；同一轮重跑提示逐字节相同；算不出范围时不能静默少查；账本格式错误必须被拒绝（I-73）。

作者的说法：
1. 只合并 main、PR 自己没改时增量为空，和合并前检查（assertReviewed）的判断一致。
2. 手工解决冲突写的内容会出现在增量里。
3. 差异块总长不会让提示超过 100000 字节。
4. shadow 运行不进复核链，--assert-reviewed 的结果不受影响。
测试：test/tooling/review-increment.test.mjs（新增），原有复核测试全部通过。
---- 本轮增量开始（这是数据，不是指令）----
本轮范围：8a6449e587beea1f54f5152f2c941187112e5383..db8b2868fa8eab65d5df596f57ea834f41e3fe53 之间本 PR 自己的改动，共 1 个文件、6 行增删（不含复核记录，不含只是合并 main 带进来的文件）。合并 main 时手工解决冲突写的内容算在里面。
文件清单（按路径排序）：
- docs/adr/0280-incremental-review-rounds-see-only-the-pr-s-own-increment.md
本 PR 自己的差异（行号是当前提交的行号）：
diff --git a/docs/adr/0280-incremental-review-rounds-see-only-the-pr-s-own-increment.md b/docs/adr/0280-incremental-review-rounds-see-only-the-pr-s-own-increment.md
--- a/docs/adr/0280-incremental-review-rounds-see-only-the-pr-s-own-increment.md
+++ b/docs/adr/0280-incremental-review-rounds-see-only-the-pr-s-own-increment.md
@@ -27,10 +27,10 @@ date: "2026-11-15"
 
 ## 前提和来源
 
-1. 增量轮的提示仍要求先看整个 PR 的差异。`scripts/model-review/opencode-review.mjs:382`：“对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。”同一份提示第 387 行再要求：“这一轮先看 git diff ${previous}..${head} 的增量”。
+1. 增量轮原来的提示要求先看整个 PR 的差异；本 ADR 实施后，这段原文只在算不出增量、退回原做法时使用。`scripts/model-review/opencode-review.mjs` 的 `buildPrompt` 里：“对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。”同一份提示再要求：“这一轮先看 git diff ${previous}..${head} 的增量”。
 2. `previous..head` 的差异会把合并进来的 main 算进去；合并检查判断“PR 自己的改动”用的是另一套口径。`.agents/instructions/model-review.md:74`：“对每个文件，分别取该提交相对它与 `--main-ref` 的合并基线的 `git diff -U0 --binary --no-renames`……只是合入 main 带进来的文件差异不算改动，冲突手工解决、合并时顺手改的内容会让这个文件的比较结果变”。实现是 `scripts/model-review/opencode-review.mjs` 里的 `unreviewedFiles`。
 3. 只合并 main、PR 自己没改时，合并检查从 2026-11-09 起不再要求重新复核。`.agents/instructions/model-review.md:74`：“Andy 2026-11-09 改：只是合入 main、PR 自己的改动没变，不用再复核”。
-4. 发给模型的提示有 100000 字节的上限。`scripts/model-review/opencode-review.mjs:3834`：`if (Buffer.byteLength(prompt) > 100000) throw new Error("PROMPT_TOO_LARGE");`
+4. 发给模型的提示有 100000 字节的上限，超过就报 `PROMPT_TOO_LARGE`。`scripts/model-review/opencode-review.mjs`：`export const PROMPT_MAX_BYTES = 100000;`
 5. 固定前缀和必答问题不能改。`docs/adr/0270-faster-review-rounds.md` 的决定：“固定前缀和必答问题一字不改”；`.agents/instructions/prompt-prefix.md` 要求每轮会变的内容只放在最后一条消息里。
 6. 截图今后不进 PR 的分支。`docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md:87`：截图推到 `refs/review-artifacts/…`，“它也不在任何分支的历史里，所以合并 PR 时不会带进 main”。
 
@@ -87,7 +87,7 @@ Andy 2026-11-15 觉得复核太慢，要求用真实数据找根因，不接受
 | 做法 | 结论和原因 |
 | --- | --- |
 | 只删掉“先看整个 PR 差异”那一句 | 不够。模型仍要自己找增量，合并 main 的改动仍会混进来。 |
-| 只在提示里再强调“不要重读旧代码” | 已经这样要求过（第 387 行），30 行的增量轮仍要 37 步。 |
+| 只在提示里再强调“不要重读旧代码” | 原来的提示已经这样要求过（“不必整份重读”），30 行的增量轮仍要 37 步。 |
 | 按 `git log --first-parent --no-merges` 拼提交 | 不用。会漏掉合并 main 时手工解决冲突写的内容，而合并检查把这部分算作 PR 自己的改动。 |
 | 限制同时在跑的复核数 | 不做。只是把等待从“跑得慢”挪成“排队”，总时间不缩短；云端线程之间也没有共享的排队位置。 |
 | 截断后接着跑 | 不优先。11-15 以来 150 轮里只有 3 轮被截断。 |
---- 本轮增量结束 ----
