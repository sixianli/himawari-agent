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
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 fed6ae9280f7592d9fbcae9d8bbdacdf51e62f08。
对比基准是 44a0e332b4550b0ef7fdbb663552812d9b21fc97，先运行 git diff 44a0e332b4550b0ef7fdbb663552812d9b21fc97..fed6ae9280f7592d9fbcae9d8bbdacdf51e62f08 看改动。
作者的说法（可能有错，请核对）：
# PR 420 第 1 轮作者说明（P5-3 PR A2）

目标：做完 ADR 0228 留给下一个 PR 的三件事，决定见 `docs/adr/0246-external-proposals-join-the-data-export-and-web.md`。不改表，不改网关协议，不改发给模型的内容。

改动：
- 网页：`apps/control-center/src/components/external-proposals.tsx`（新）、`memory-page.tsx`（记忆页顶部一节、提醒页提示）、`memory-panel.tsx`（TextEditor 加 maxLength）、`memory.ts`（externalRespond 返回批次号、externalUndo、externalReady）、三语文案、`review-v4.css`。
- 数据导出 v3：`packages/persistence-sqlite/src/data-export/{schemas,snapshot,export,verify,import,demo-pack,types}.ts`。
- 测试：`test/integration/external-proposals-browser.test.ts`（真实浏览器 + 测试用网关桩 `test/e2e/fixtures/control-center-browser-server.mjs`）、`test/integration/data-export-external-proposals.test.ts`（真实 SQLite），以及已有测试的格式号更新。
- 门槛：`scripts/check-data-export.mjs` 下限 96，`scripts/check-layout-audit.mjs` 新场景，`ci/operations-pending.json` 移出两项。

请核对：
1. 「另有几条没处理成」的算法：送出条数 − 这一批的保存数 − 不要数。批次条数来自后端 `listBatches`（`apps/agent-service/src/production-mcp-memory-writer.ts`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts`）。重放（同一批已处理过）、部分失败、撤销后再看、概况还没刷新时，显示的数字会不会错。
2. 数据导出：像机密的正文和摘要都只进封存文件；短文字（客户端名、固定编号、subjectRef）按已有短文字规则替换。替换后同一客户端两个不同编号会不会变成同一个占位而违反唯一性，导致导出能做出来但导不回去；导入时跳过的提议被别的提议或固定编号引用会不会让事务失败。
3. 导入的校验是否覆盖了表上全部 CHECK 和唯一索引（`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql`），有没有能通过校验却在 INSERT 时失败的输入。
4. v2 文件整份拒绝是否和 ADR 0233 的先例一致，有没有别处（命令行、网页导出、示范数据）还写着 v2。
5. 网页：全选、勾选后列表刷新（别处处理了几条）时，已勾选但已消失的条目会不会被一起送出；忙碌时按钮是否都禁用；撤销一批后结果行是否清掉。
