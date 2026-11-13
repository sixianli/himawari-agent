你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 18d0756f2d50c64fe8b68530f12b72429a626ffe。
对比基准是 c44b83961254e6b2b46de6ea96ac2531fdcfc91d，先运行 git diff c44b83961254e6b2b46de6ea96ac2531fdcfc91d..18d0756f2d50c64fe8b68530f12b72429a626ffe 看改动。
作者的说法（可能有错，请核对）：
问题：合并前代码复核（scripts/model-review/opencode-review.mjs --mode code-review）可以传 --previous <上一轮复核到的提交>，让模型先看增量。复核账本 .agents/reviews/pr-<编号>/usage.jsonl 记下每轮的 head 和 previous；合并前检查 assertReviewed 用 coveragePoints + walkChain 把各轮串成复核链。用 --accept-low 记过低意见修改后，最后一个已接受点是 low-fix 记录的 head。线程三次把“之后提交账本的那个提交”当作 --previous 传入（PR 436、466、460），这个提交不是已接受点的祖先，walkChain 判 chain-broken，这一轮白花钱，要到合并前检查才发现。

目标：代码复核传了 --previous 时，在花钱之前（装 opencode、建副本、跑模型之前）用本地账本算复核链，--previous 接不上就拒绝并打印该传的提交。

改动：
- 新增导出函数 previousProblem({ records, round, head, previous, isAncestor })：只取本轮之前各轮的记录算 coveragePoints，把本轮当成一个 by:"requested" 的点接在最后跑 walkChain（lowFixCheck 恒返回空，即信任账本里的 low-fix 记录，合并前检查仍会重新核它们）；本轮被接受就放行，否则按原因返回 REVIEW_PREVIOUS_REFUSED（chain-already-broken / no-accepted-round / head-not-after-accepted / chain-broken，并写 use=--previous <提交> 或 use=no-previous）。
- main() 在 roundForRun 之后、opencodeBinary() 之前调用它，拒绝时抛错（退出码 2）。
- 测试：test/tooling/opencode-review-merge-gate.test.mjs 三条 [I-98] 用例；撤掉检查后三条都失败。用三个 PR 分支上的真实账本重放，三次的 --previous 都被拒并给出当时该传的 low-fix head。
- 文档：docs/incidents-and-gates.md 新增 I-98 行，docs/lessons.md 新增一节，.agents/instructions/model-review.md 第 3 步补一句。

约束：不改变合并前检查本身的判定；只对 code-review 模式生效；不能误拒合法的 --previous（例如传已接受点之前的祖先，walkChain 也接受）。重跑已有轮次（--round N）时只用 N 之前各轮的记录判断。

请特别看：判定是否与 walkChain/assertReviewed 完全一致、有没有会误拒合法用法的情况、重跑轮次和替补轮次的边界、错误信息给出的提交是否总是正确。
