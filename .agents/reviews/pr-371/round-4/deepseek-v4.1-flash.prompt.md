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
仓库就是当前目录，已检出 0d022b62395a8a1bebc4b84c756ac95589187497。
对比基准是 f9eef17a811a6dd4472ff873f7625cb0e0aa42ac，先运行 git diff f9eef17a811a6dd4472ff873f7625cb0e0aa42ac..0d022b62395a8a1bebc4b84c756ac95589187497 看改动。
上一轮复核到 af0f1163ca2c81a1afea2a9309e0df94011ef20b，先看 git diff af0f1163ca2c81a1afea2a9309e0df94011ef20b..0d022b62395a8a1bebc4b84c756ac95589187497 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# P4-6 每周记忆体检：第 4 轮代码复核材料

第 3 轮的意见和判断在 `.agents/reviews/pr-371/round-3/judgments.md`；第 3 轮之后的提交 `bad16b5e`（每天打分的文字按 UTF-16 长度截断、退回失败给 `MEMORY_CHECKUP_RESTORE_FAILED`）还没复核过，本轮一起看（Andy 选了“等加表时一起复核”）。

本轮新增（在合并 main 的提交里一起做的，请用 `git diff <previous> HEAD` 并排除 main 自带的改动）：

- 数据表：`packages/persistence-sqlite/src/migrations/0090_memory_checkup.sql`、`migration-engine.ts` 登记、`schema-catalog.ts` 条目、各迁移测试的序号上限、`scripts/operations/workspace-lifecycle-audit.mjs` 的 `SUPPORTED_SCHEMA_MAX`。
- 测试：`packages/persistence-sqlite/test/memory-checkup-migration.contract.test.ts`、`test/integration/memory-checkup.test.ts`（真 SQLite，worker 和 direct 两种执行方式，22 条全过）。
- 矛盾对接上 P3-8：`apps/agent-service/src/service-main.ts` 的 `pairs` 读 `memoryConsolidation().listHeldPairs`（`memory_id` 是新条、`related_memory_id` 是旧条，见 `packages/memory-engine/src/consolidation.ts` 的 hold 分支）；`pickMemoryCheckup` 只收新条仍是待确认、两条都使用中的对（P3-8 撤销 hold 时会把新条转正，所以撤销过的也被排除）。
- `packages/application/src/services/daily-review.ts`：传了体检列表时，`hold` 整理决策记录不再进“整理记忆”组。
- 合并 main 带来的调整：`memorySourceState` 搬到 gateway-contracts 时加上 main 新增的“外部提议”一类；低置信门槛从固定 850 改成按类别的 `autoCommitThreshold`（main 把自动存入门槛改成按类别了）。
- ADR 0218 同步。

请重点看：迁移的 CHECK 和外键是否和 `sqlite-memory-checkup-operations.ts` 的写法一致（尤其 `recordAction` 清空 `undone_at`、`recordUndo` 清空其余列）；hold 对接入后同一对会不会在页面上出现两次；被 hold 的新条被体检“删除”或“合并”后，P3-8 撤销 hold 会不会出错。
