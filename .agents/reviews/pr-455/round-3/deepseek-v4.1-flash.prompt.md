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
仓库就是当前目录，已检出 4bc381ce51023a671e8ae883048c463f0d29742d。
对比基准是 7232d9cd7073169d86692a39c3819c5843ef2098，先运行 git diff 7232d9cd7073169d86692a39c3819c5843ef2098..4bc381ce51023a671e8ae883048c463f0d29742d 看改动。
上一轮复核到 74c64574808bfa45b2fbeba2796fbc497466eea4，先看 git diff 74c64574808bfa45b2fbeba2796fbc497466eea4..4bc381ce51023a671e8ae883048c463f0d29742d 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 455 第 3 轮：对第 2 轮意见的修改

问题、目标和约束同第 1 轮（`.agents/reviews/pr-455/briefs/43de0dc71882-code-review.md`）。前两轮的逐条判断在 `.agents/reviews/pr-455/round-1/judgments.md` 和 `.agents/reviews/pr-455/round-2/judgments.md`。第 2 轮没有中、高的意见，但 4 条低意见的修改动了 8 个文件，超过“小改动不再复核”的 5 个文件上限，所以再复核一轮。

这一轮的增量里还有一次合并：把 PR 451 的分支（`origin/claude/project-thread-fzn28h`，本 PR 叠在它上面）的 7 个新提交合了进来。那些提交属于 PR 451，已经在那边复核过，不用复核；只看合并后本 PR 自己的代码和它们是否对得上。

## 作者的说法（请核对，不要直接采信）

1. 提议入口的调用放在 `Promise.resolve().then(...)` 里，同步抛错、异步拒绝、一直不答复，都不影响这次检查（`packages/application/src/services/proactive-mail-check-service.ts`）。
2. `PROACTIVE_ITEMS_PER_CHECK_MAXIMUM = 500`（`packages/application/src/ports/proactive-sources.ts`）同时是登记表里每次检查上限的最大值上界和存储层 `MAX_INPUT_IDS`；登记时每次检查上限的最大值超过它就拒绝。
3. `recordProactiveProgramEntry` 要求 `dueAt`、`deliverAt` 是 null 或标准 ISO 时间（`Date.parse` 后 `toISOString` 等于原值），否则返回 `entry_invalid`（`packages/application/src/services/proactive-source-runtime.ts`）。
4. `record` 的 `onlyIfNew` 只带 `source` 和 `since`，每天上限由存储层在同一个事务里读当前设置（`packages/persistence-sqlite/src/sqlite-proactive-operations.ts`）。“今天”的起点仍由调用方按主人的时区算。
5. PR 451 的分支给 `decision_ledger` 的 proposal 结果值加了 `told`（`0095_perception_records.sql`）。本 PR 的 `0097_proactive_source_registry.sql` 重建这张表，已经补上 `told`；迁移契约测试 `changes nothing in the rebuilt tables except the source name constraints` 会在两边定义不一致时失败。请核对 0097 重建的每张表和合并后它前面的迁移留下的定义，除了来源名的约束以外逐字段一致。
