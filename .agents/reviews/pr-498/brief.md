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
