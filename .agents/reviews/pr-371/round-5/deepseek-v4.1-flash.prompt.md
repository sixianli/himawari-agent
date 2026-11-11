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
仓库就是当前目录，已检出 e9e6688f3e10160398f999ffc11cc8cda3fb8533。
对比基准是 980322bc5a658b89be4964b70c02ea1300e51b31，先运行 git diff 980322bc5a658b89be4964b70c02ea1300e51b31..e9e6688f3e10160398f999ffc11cc8cda3fb8533 看改动。
上一轮复核到 0d022b62395a8a1bebc4b84c756ac95589187497，先看 git diff 0d022b62395a8a1bebc4b84c756ac95589187497..e9e6688f3e10160398f999ffc11cc8cda3fb8533 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# P4-6 每周记忆体检：第 5 轮代码复核材料

第 4 轮的意见和判断在 `.agents/reviews/pr-371/round-4/judgments.md`。本轮只看第 4 轮之后的改动：提交 `bebbb117`（第 4 轮修改），以及合并最新 main 的提交 `e9e6688f` 里本分支自己的冲突处理。

`bebbb117` 的改动：
- `packages/application/src/services/memory-checkup.ts`：矛盾对里的两条不再因其他原因单独进清单；`act` 时矛盾对的新条已不是待确认就以 `MEMORY_CHECKUP_STALE` 拒绝。
- `packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts` 和端口：`listHeldPairs` 加 `openOnly`，只读 `undone_at IS NULL` 的 hold，按 `created_at DESC, id DESC`；不传时保持原来的 `ORDER BY id`。`apps/agent-service/src/service-main.ts` 的体检用 `openOnly: true`。
- `packages/application/src/services/daily-review.ts`：只有本周体检清单里已有的矛盾对，它的 `hold`（以及同一对记忆的整理决策记录）不进“整理记忆”组；清单失败或没排进清单时照常显示。
- 迁移 0090 加 `CHECK (kept_memory_id IS NULL OR action = 'merge')`。
- ADR 0218 文字。

`e9e6688f` 的冲突处理：main 在 `apps/control-center/src/memory-source.ts` 新增了 `EXTERNAL_RULE_MEMORY_PREFIX`（`memory:rule:mcp:`）；本分支已把 `memorySourceState` 搬到 `packages/gateway-contracts/src/memory-source.ts`，所以把这个前缀和判断一起搬过去，控制台文件改为转出；`test/integration/memory-source-report.test.ts` 改从 gateway-contracts 读这个前缀。

请重点看：`daily-review.ts` 按记忆 id 过滤整理决策记录，会不会把不是矛盾对的整理记录也误藏；`openOnly` 的排序和 `pickMemoryCheckup` 的取对顺序是否一致；STALE 判断会不会拒绝本来合法的操作（例如合并时留下新条）。
