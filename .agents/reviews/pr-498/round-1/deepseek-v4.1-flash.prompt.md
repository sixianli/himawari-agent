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
输出格式：按严重度从高到低排列，每条意见单独一个以「### 」开头的三级标题（标题里写序号、严重度和一句话问题），下面写：文件:行、问题、证据（引用你亲自读到的那几行代码）、建议；意见以外的内容不要用三级标题。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 5d869276feb662aac02fb7c2e4d9ac32795491cc。
对比基准是 6cbf37b0b2aeb368f6077cab178c041279b66a0e，先运行 git diff 6cbf37b0b2aeb368f6077cab178c041279b66a0e..5d869276feb662aac02fb7c2e4d9ac32795491cc 看改动。
作者的说法（可能有错，请核对）：
# 复核材料：决策记录的种类和结果改用参照表

## 这个 PR 做了什么

`decision_ledger` 的 `kind` 原来靠一条写死所有种类和结果值的 CHECK 约束，每加一个种类或结果就要重建这张表和 7 张依赖它的表（0095 就是这样重建的）。这个 PR 新增迁移 `packages/persistence-sqlite/src/migrations/20261114110331_decision_ledger_reference_tables.sql`（含 `.meta.json`）：

- 新表 `decision_ledger_kinds(kind)`、`decision_ledger_outcomes(kind, outcome)`，种子来自 `packages/application/src/ports/decision-ledger.ts` 的 `DECISION_KINDS`、`DECISION_OUTCOMES`。
- `decision_ledger` 重建一次（复制 0095 的重建流程，8 个依赖表一起重建并回填）：`kind` 引用种类表，`FOREIGN KEY (kind, outcome)` 引用结果表；outcome 为 NULL（proactive 行）时外键不检查。
- SQLite 外键默认每个连接关闭，所以加触发器 `decision_ledger_known_kind_insert/update` 兜底检查，并加两个触发器禁止删除正被使用的种类或结果。
- `schema-catalog.ts` 加两条；新契约测试 `decision-ledger-reference-tables.contract.test.ts`；`memory-capture-backlog-migration`、`rule-memory-review` 两份旧测试按新结构调整（排除新触发器、错误信息改为触发器的错误码）。

## 约束

- 生产库不能丢数据：重建前后每张表的行必须一致，`foreign_key_check` 必须为空。
- 代码里 `sqlite-decision-ledger-operations.ts` 仍在写入前校验种类和结果，不改。
- 不写代码注释；不为假想需求加兼容层。

## 已核对的事实

- `persistence-sqlite` 全部 139 条测试、lint、typecheck、`check:migration-conflicts`（base=95 added=1）、`check:audit-schema-range` 通过。
- 重建段是 0095 前 330 行原样复制，只改了 `decision_ledger` 的 `kind` 和结果约束。

## 侧重检查

- 重建段与 0095 相比是否漏表、漏列、漏触发器、漏回填。
- 触发器是否漏掉某种写入路径（UPDATE 只改 outcome、outcome 为 NULL、外键关闭时）。
- 这个改动会不会改变模型已经见过的请求开头：不涉及发给模型的内容。
