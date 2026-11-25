---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amended_by: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md"
date: "2026-11-11"
covers: "packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0211：硬规则记着它来自哪条规则类记忆，记忆一变就标“待重审”

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P2-2 要求：每条硬偏好对应一条规则类记忆，记忆保存规则的身份、出处和历史，程序负责执行；规则类记忆被改、被取代或删除时，对应的硬偏好标“待重审”并留一条决策记录。原文还写了“对应关系存在记忆这边”。

[ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md) 已经把硬规则放进规则手册：每条规则有固定 id、修订号、出处和只追加的历史。再让记忆那边存一份“我对应哪条规则”，就会有两处历史。Andy 在 2026-11-11 同意把对应关系放在规则手册这边（“同意对应关系放规则那边”“按你的推荐来”）。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 规则是硬性设定，记忆保存出处：`docs/product-vision.md`，原则 3 写“纠正应传播到受其影响的推断与行为”。
2. 规则手册自带出处、修订号和只追加的历史：[ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md) 决定 2，“每条有固定 id、修订号、表达式、结果、出处、状态”。
3. 记忆服务的所有写入最终落在 `memory_records` 一张表上，而且写入口不止一个：`sqlite-memory-operations.ts` 的 `save`、`sqlite-governed-deletion.ts`（移入回收站、删除）、`sqlite-memory-maintenance.ts`（撤销整理）。
4. 决策记录表只允许固定的几种类型，每种类型有固定的结果值：`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql` 的 `kind` 和 `outcome` 检查。
5. SQLite 不能直接改表里的检查约束，改法是新建表、复制、删除旧表、改名：<https://www.sqlite.org/lang_altertable.html>（“Making Other Kinds Of Table Schema Changes”）。迁移引擎在事务里执行，事务里不能关外键，所以删除被别的表引用的父表之前，要先把子表复制出来、删掉，再重建，0069 就是这么做的。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **对应关系放在规则手册这边。**`rule_book_rules` 和 `rule_book_history` 各加一个可空字段 `source_memory_id`，指向那条规则类记忆的编号。记忆表不加任何字段。现在没有任何硬规则从记忆变来（内置规则写在代码里，重要发件人和静默时段来自设置页），所以这个字段现在全是空的；它由第 4 步“一句话变规则”填写。
2. **新增状态 `needs_review`（待重审）。**待重审的规则**照常执行**：裁判（`RuleJudge`）和设置读取都把它当作有效规则。理由：规则靠主人的话立起来，记忆被改动时还不知道主人是改了主意还是只是改了措辞，规则停掉等于主人的要求悄悄失效，违背“硬偏好必定执行”；执行继续，同时让主人看到“这条规则来源变了”。主人在设置页改动这条规则的值，就回到 `active`，来源编号保留；原样重存同样的值不算重审，因为设置页一次保存整套设置（开关、静默时段、重要发件人），改别的项也会把这条规则一并重存，不能把它当成主人看过。明确的“重新确认”按钮由第 4 步做。
3. **由数据库触发器在同一个事务里标记。**`memory_records` 上的 `memory_rule_needs_review` 触发器，在下面几种情况之一发生时，把所有 `source_memory_id` 指向这条记忆、状态为 `active` 的规则改成 `needs_review`，修订号加 1，写一行历史（带 `source_memory_id` 和 `change_reason`），并写一条决策记录：
   - 内容引用变了（`memory_edited`，覆盖修正、更新、合并）；
   - 被取代（`memory_superseded`）；
   - 状态离开有效：归档、移入回收站、待删除、已删除（`memory_removed`）；
   - 分类不再是“规则”（`memory_reclassified`）。
   记忆被永久删除（直接删行，不经过“待删除”状态，例如治理删除对没有向量记录的记忆）时，另一个删除触发器做同样的事（`memory_removed`），并且只在所属的 Agent 和主人还在时才动作，所以删除 Agent 或主人时的级联删除不受影响。被删掉的那一行没有“删除时间”这一栏（它的 `updated_at` 是上一次修改的时间），所以删除触发器记的时间取数据库当前时间；修改触发器取记忆这次写入的 `updated_at`。两者都是标记发生的那一刻。同样的文字再次确认、只改重要度、改的是别的记忆、记忆从回收站恢复，都不触发；已经是 `needs_review` 的规则不会重复触发，删除也一样。决策记录的“依据”抽屉把这类记录的规则列在“待重审的规则”下，不显示命中邮件数。用触发器而不是在服务层挂钩，是因为写入口不止一个（前提 3），触发器在同一个事务里，改记忆和标待重审不可能只成功一半。
4. **新增决策记录类型 `rule_review`，结果值只有 `needs_review`。**输入里记着记忆编号和规则编号；主人可以像评价其他决策一样评价它（做对了 / 不该做）。类型加进决策记录表的检查约束，要重建这张表，所以迁移 0087 按 0069 的做法把六张引用它的子表先复制出来、删掉、重建、再灌回。契约、校准、导出模式和三语界面同步加上这个类型。
5. **规则是否生效不受重要度和字数预算影响，已经成立。**硬规则不经过档案块：邮件检查直接读规则手册。受预算影响的是规则类记忆那条给模型看的文字（清单 M-3）。这是软偏好的路径，本 ADR 不改它；要不要给规则类记忆文字单独的预算，要先读按对话冻结的实现（[ADR 0165](0165-freeze-the-request-head-per-conversation.md)）再另行决定。
6. **不改发给模型的任何内容。**所以“老对话要手动换新才用新的注入方式”这一条在本 ADR 里没有可测的差别，留给改注入方式的那一步。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- 这一步只给规则手册的每个版本加一个指回来源的字段，沿用 ADR 0209 已经调研过的结构，没有另做业界调研。
- 重建被引用的表的做法，依据 SQLite 官方文档（前提 5）和仓库里迁移 0069 的先例。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **对应关系存在记忆表。**会有两份历史，且执行路径要反查记忆表，记忆表出问题就会连累规则。已放弃，Andy 同意放规则手册这边。
- **在 `DurableMemoryService` 里挂钩。**治理删除和撤销整理绕过这个服务直接改表，会漏。
- **待重审就停掉规则。**会让主人的要求悄悄失效。
- **借用现有决策类型（如“整理记忆”）。**界面会把它显示成整理记忆，名不副实；Andy 在 2026-11-11 选了新增类型。
- **只写规则历史、不写决策记录。**不满足任务块“留一条决策记录”。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 迁移 0087：重建 `rule_book_rules`、`rule_book_history`（加 `source_memory_id`、状态加 `needs_review`、历史加 `change_reason`，历史的只追加触发器重建）；重建 `decision_ledger` 和它的六张子表（`source_insights`、`proactive_processed_messages`、`decision_ledger_payloads`、`decision_signals`、`proactive_push_backoff`、`muse_reference_entries`），数据原样灌回；新增触发器。迁移不可逆，回退程序要从迁移前的快照恢复数据库。
- “哪些状态要执行”有两处：裁判里的 `ruleIsEnforced`，和读设置的 SQL（`status IN ('active', 'needs_review')`）。持久层的 worker 是不经构建直接跑的 Node 进程，不能从应用层包里导入值，所以没法共用一个常量；一致性靠集成测试保证（待重审的规则读设置时仍然返回）。
- 规则手册不在数据导出范围内（[ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md) 的后果已写明，留给第 5 步）；决策记录导出的类型枚举已加上 `rule_review`。
- 第 4 步写入规则时要填 `source_memory_id`；到那时还要补：待重审的规则在规则页上的标记和“重新确认”按钮（现在只有改值才能让规则回到生效）。
- 发给模型的内容、系统提示和工具定义都没有变，`npm run check:prompt-prefix` 不受影响。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0163](0163-owner-preferences-as-data-run-by-tested-rule-types.md)：主人的偏好是数据，由测过的规则类型执行。
- [ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md)：规则手册、裁判和迁移 0086。
- [ADR 0143](0143-decision-ledger-for-model-gate-decisions.md)：决策记录。
- [ADR 0165](0165-freeze-the-request-head-per-conversation.md)：系统提示和工具按对话冻结。
- [Agent 规则清单](../agent-rulebook-inventory.md)：M-1 到 M-3 是规则类记忆的现状。
- [ADR 0233](0233-rule-book-joins-the-data-export.md)：规则手册进入数据导出（后续）。
- [ADR 0232](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md)：来源记忆恢复也触发待重审，待重审的规则由模型自动核对，对不上就暂停（后续）。

[返回阅读导航](#contents)
