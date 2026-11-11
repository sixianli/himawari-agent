# 复核报告（PR 366 / P2-2，941dc49）

## 读代码证实的结论

### 1. 【中】控制中心“每日回看”列表会把 rule_review 显示成“外部程序读取记忆”

- **文件**：apps/control-center/src/components/proactive-reminders.tsx:324-343
- **证据**：`reviewTag` 的三元链最后一个分支是 `item.kind === "retrieval_degrade" ? "dailyReview.tag.degrade" : "dailyReview.tag.externalRead"`——没有 `rule_review` 分支，它是兜底值。而本次改动把 `rule_review` 加进了契约的回看类型列表（contracts-v2.ts:537），后端 `listReviewPool` 的 SQL 不过滤 kind（sqlite-decision-ledger-operations.ts:361-367：`WHERE owner_id = ? AND agent_id = ? AND checked_at >= ? …`），`ledgerGroup` 对非 proactive/memory_candidate/consolidation 的种类一律返回 `"other"`（daily-review.ts:209）。三者的合成结果：rule_review 决策记录一定会出现在“每日回看”的折叠列表里，且标签显示为 i18n 的 `dailyReview.tag.externalRead`（“外部程序读取记忆”）。ADR 0211:58 声称“三语界面同步加上这个类型”——只加了 `decision.chain.kind` 和 `weekly.check.rowsMissing` 两处，漏了 `dailyReview.tag.*` 这一组。没有任何测试覆盖这个组件的 rule_review 分支。
- **建议**：在 `reviewTag` 加 `rule_review` 分支并新增三语 `dailyReview.tag.ruleReview` 文案；补一条 control-center 单测。

### 2. 【低】ADR 与代码不一致：“设置页重新保存就回到 active”只在参数真的变化时成立

- **文件**：packages/persistence-sqlite/src/sqlite-proactive-operations.ts:341；docs/adr/0211-…md:51
- **证据**：ADR 0211 决定 2 写“主人在设置页重新保存这条规则，就回到 `active`，来源编号保留”。但 `writeRule` 开头是 `if (current && current.parameters === parameters) return;`——主人打开设置页原样点保存（senders 一个没改）时直接返回，规则仍停留在 `needs_review`。集成测试（test/integration/rule-memory-review.test.ts 最后一例）也只测了“参数变了”（加了 tax.example）的路径。
- **建议**：要么把“owner 显式保存”视为重审通过（即使参数相同也写新修订、回 active），要么把 ADR 0211:51 的措辞改成“重新保存并改动参数”。

### 3. 【低】决策记录类型枚举的文档没跟上；触发器绕过了写入约定文档

- **文件**：docs/execution/specs/2026-11-09-decision-record-write-convention.md:26；docs/adr/0143-decision-ledger-for-model-gate-decisions.md:37
- **证据**：两份文档的 kind 枚举都停在 `external_read`，没有 `rule_review`。另外约定文档要求“其他种类经 `DecisionLedgerPort.append`（`insertLedgerRow`）”写入，而迁移里的触发器直接 `INSERT INTO decision_ledger`（0087 第 336-352 行）。好消息是触发器写齐了约定要求的四个 inputs 键（`memoryIds/ruleIds/batchId/resultMemoryIds`，batchId 为 null、resultMemoryIds 为空数组），与约定第 35 行的默认值行为一致。
- **建议**：更新两份文档的枚举，并在写入约定里补一段“触发器写入也必须保持这四个键”。

### 4. 【低】迁移 0087 的数据保真测试只覆盖了七张表中的一部分

- **文件**：packages/persistence-sqlite/test/rule-memory-review.contract.test.ts:30-90
- **证据**：契约测试在迁移前 seed 了 `decision_ledger`（1 行）、`decision_signals`（1 行）、`proactive_push_backoff`（1 行）和规则手册两表，并断言迁移后原样保留、`foreign_key_check` 为空、两个不可变触发器仍生效。但 `source_insights`、`proactive_processed_messages`、`decision_ledger_payloads`、`muse_reference_entries` 四张子表没有 seed 数据，灌回逻辑（0087 第 112-113、135-136、148-149、228-229 行的 INSERT…SELECT）没有数据级断言；重建后的索引（`decision_ledger_time_index` 等 9 个）也没有存在性断言。我逐列比对过 0069/0070/0073/0076/0080/0081 与 0087 的定义：六张子表的列、CHECK、UNIQUE、索引、触发器全部一致，`DROP` 顺序子表先于父表——**读代码证实迁移本身是对的**，缺的只是回归保护。
- **建议**：给四张未覆盖的子表各 seed 一行并断言保留；用 `sqlite_master` 断言索引/触发器清单。

### 5. 【低·备注】硬 DELETE memory_records 不触发（当前语义可接受，记录在案）

- **文件**：packages/persistence-sqlite/src/sqlite-governed-deletion.ts:885
- **证据**：触发器是 `AFTER UPDATE`（0087 第 301 行），治理删除最终走 `DELETE FROM memory_records WHERE id = ?`。能到达硬删除的行必然先经过 `trashed`/`deletion_pending`/`deleted_verified` 之一的 UPDATE（这三种都在触发列表里，见 0001_initial_product_schema.sql:398 的状态枚举），所以规则已被标过；唯一例外是“owner 重存回 active 之后又硬删除”——规则保持 active 且 `source_memory_id` 悬空。这与 ADR“owner 重存=重审通过”的语义一致，可接受，但第 4 步落地时应处理悬空链接。

## 作者说法核对

- 说法 1（source_memory_id 可空、两表都加）：✓ 与 0087 一致。
- 说法 2（needs_review 仍执行）：✓，但运行时真正保证执行的是 SQL 的 `status IN ('active','needs_review')`（sqlite-proactive-operations.ts:232-233）；`ruleBookFor` 构造的 RuleRecord 硬编码 `status: "active"`（rule-book.ts:211、249），所以 `ruleIsEnforced` 在当前生产路径上不会被 needs_review 触到，它是给第 4 步留的口子。说法成立，但“ruleIsEnforced 是唯一来源”（ADR 0211:90）目前只在单测里为真。
- 说法 3（同一事务触发器）：✓。
- 说法 4（重建六张子表保数据/索引/触发器/外键）：✓（逐一定义比对，见上第 4 条；测试覆盖不全）。
- “所有按类型枚举的地方都覆盖”：✗——漏了 `proactive-reminders.tsx` 的 `reviewTag` 和 `dailyReview.tag.*` 文案（问题 1）。
- 已知不做项（M-3 预算、规则手册不导出）：与 schema-catalog.ts:799-803 的 `metadata_only` 和 ADR 0209 一致 ✓。
- “typecheck/lint/check 都通过”：未核实（我无法运行命令）。

## 侧重检查（普通使用流程走查）

流程：主人在 Gmail 里纠正“退款邮件要看整个串”→（第 4 步后）规则类记忆被 `correct` 改 content_ref → `memory_rule_needs_review` 触发器（0087:301-361）→ `rule_book_rules` 标 needs_review、`rule_book_history` 追加修订、`decision_ledger` 写 rule_review 行 → 控制中心：设置页 `readSettings`（仍执行）、“每日回看”列表、决策链抽屉、校准报告。
路径覆盖情况：触发器→存储层有契约+集成测试（含 6 组反向用例）✓；设置页路径有集成测试 ✓；**“每日回看”列表的 rule_review 展示无任何覆盖**（问题 1 即在此暴露）；决策链抽屉与校准的枚举已加但无 rule_review 的端到端断言（仅契约枚举放行）；规则手册不进导出/规则页 UI，与 ADR 一致。

## 必答问题

1. **不会改变模型见过的请求开头。** diff 没有触碰任何提示词、系统提示、工具定义、历史消息或遮盖路径；改动的全部落在持久层（迁移/触发器）、主动推送门槛（RuleJudge 只用于邮件推送的 raise_floor/defer 决策，不进模型输入）、契约校验和界面。没有任何“每轮会变的值”被引入 prompt；该规则本身要求的“只在末尾追加”无从被破坏。`check:prompt-prefix` 是否真的通过未核实，但 diff 中不存在 prompt 路径文件。
2. **不会让同一段文字在不同请求里变成不同字节。** 所有新值都不进模型输入；库内新值中唯一非确定性的是 `decision_ledger.id` 的 `randomblob(12)`（0087:338），它只做主键，不发给模型。触发器写入的其余值（`change_reason`、`updated_at`、`inputs` 的 `json_object` 固定键序）对同一输入完全确定；无依赖前后文的遮盖、无无序集合。
3. **有自动检查，反向用例结构上会失败。** 契约测试对 CHECK 约束的反向插入（`rule_review`+`kept`、`memory_candidate`+`needs_review`、unknown kind 均断言抛错，decision-ledger-migration.contract.test.ts:161-163）、RuleJudge 对 retired 不命中（rule-registry.unit.test.ts:186）、集成测试对“重申同文/改无关记忆/改非规则记忆”断言零行零决策（rule-memory-review.test.ts 最后两例）。反向用例依赖真实的 SQLite 约束和触发器行为，必然失败；但我未实际运行（未核实运行结果）。测试缺口见问题 4。
4. **逐值核对（产生端→消费端）：**
   - `source_memory_id`（产生：迁移置 NULL/触发器复制/writeRule 保留；消费：触发器 EXISTS、部分索引 0087:262-263）：长度 1-128 与 memory id 兼容，两端校验一致 ✓。
   - `needs_review`（产生：触发器/表 CHECK；消费：readSettings IN 子句 ✓、`ruleIsEnforced` ✓、schema-catalog 描述 ✓）：无遗漏读者 ✓。
   - `rule_review`（产生：触发器/DECISION_KINDS；消费：SQLite CHECK ✓、DECISION_OUTCOMES ✓、calibration 四处 ✓、contracts-v2 三处 ✓、data-export schema ✓、i18n decision.chain 与 weekly.check ✓）：**漏 UI `reviewTag`**（问题 1）。
   - `change_reason` 四个值：仅触发器写、契约测试读，长度约束 1-64 满足 ✓。
   - `SUPPORTED_SCHEMA_MAX = 87`（workspace-lifecycle-audit.mjs:5）：I-46 门槛 `check:audit-schema-range` 存在且比对迁移目录最大编号 ✓。
