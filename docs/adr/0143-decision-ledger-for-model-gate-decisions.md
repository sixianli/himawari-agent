---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-31"
---

# ADR 0143：把只记 Gmail 检查的决策记录扩成全系统决策账本

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[产品愿景 v2.2](../product-vision.md)把“决策账本”列为四样护城河之一。现状是：要紧的判断（主动开口还是沉默、一条记忆候选留还是丢、每日整理时合并还是作废）全由模型拍板，除了 Gmail 主动检查，没有任何记录，也没有人打分。

Gmail 主动检查的记录在表 `proactive_decisions`（迁移 0062）。它把 `scenario` 限定为 `gmail`，把 `verdict` 限定为 Gmail 的 7 个值，所以放不进别的决策。SQLite 不能修改已有的 CHECK 约束。

[返回目录](#contents)

<a id="decision"></a>

## 决定

1. **扩展现有记录，不建第二套。** 迁移 0069 把 `proactive_decisions` 重建成 `decision_ledger`：旧列全部保留、取值不变，Gmail 旧行原样拷入并标成 `kind = 'proactive'`。引用它的两张表（`source_insights`、`proactive_processed_messages`）先暂存、重建后重新装回，外键改指向 `decision_ledger`，数据不丢。直接删旧表会触发级联删除，所以没有这样做。
2. **每行一个决策类型 `kind`：** `proactive`、`memory_candidate`、`consolidation`、`context_truncation`、`retrieval_degrade`、`external_read`。表上的约束保证每个类型只能写自己的结果值，例如记忆候选只能是 `kept`、`discarded`、`pending_approval`，Gmail 行必须有 `verdict` 且不能有 `outcome`。
3. **每行带：** 结果 `outcome`、短代码 `reason_code`、对象 `subject_ref`、输入 `inputs`（JSON，只放记忆编号 `memoryIds` 和规则编号 `ruleIds`，不放正文）、理由正文的加密引用 `reason_ref`、候选正文的加密引用 `content_ref`、成本 `cost_micros`、耗时 `duration_ms`、评价 `owner_rating` 和评价时间。评价沿用 `useful`（有用）、`unneeded`（不需要）、`missed`（漏了）三个值，可清除。
4. **`inputs` 的含义：** 这条决策涉及的记忆。记忆候选和整理写被决策的记忆；上下文截断写被截掉的记忆；检索降级和外部读取没有对应记忆时为空。规则编号目前只用于被规则丢弃的候选（写丢弃原因），规则手册落地后再接。
5. **写入和记忆变更在同一个数据库事务里：**
   - 候选被保留时，账本行随 `saveWithProjection`（记忆记录、投影任务、历史三者的同一个事务）一起写入；账本行写失败，记忆也不会保存。
   - 整理的每条变更，账本行随 `recordChange` 在同一个事务里写入。整理对记忆本身的修改发生在这一步之前、是单独的一步，这一点没有改变（见[后果](#consequences)）。
   - 候选被丢弃或进入待审批时没有记忆变更，账本行单独写入。
6. **正文只存加密引用。** 被丢弃的候选（低置信度、临时内容）的正文用已有的加密存储方式存成引用；含机密或受限的候选不存正文，`content_ref` 为空。
7. **上下文截断和检索降级只在真正发生时写**，不是每轮都写。写失败不影响对话本身。
8. **Muse 对照条目单独一张小表 `muse_reference_entries`，不放进账本。** 它是 Andy 手工记的外部事实，没有 Himawari 的输入、成本和理由；放进账本会让大半列对它为空。它有两种形状，由列 `muse_reminded`（0 或 1）区分：
   - `muse_reminded = 1`（Muse 提醒了）：时机对不对、内容对不对（各 0 或 1）必填；内容的加密引用必填，只有来自自动录入通道的条目（`intake_item_key` 非空，其中含机密的内容没有正文引用）可以为空。
   - `muse_reminded = 0`（Muse 没提醒、Himawari 提醒了）：时机、内容、内容引用必须为空，必须带“同一天 Himawari 对应的决策编号”。表约束只保证前三项为空；对应决策编号必填由写入接口检查，因为清除 Gmail 记录会把这一列置空（`ON DELETE SET NULL`），表约束会让清除失败。
   - 其余列：备注的加密引用；可空的对应决策编号，并排比较时用它连接两张表；可空的 `intake_item_key`（形如 `proactive:<提交编号>` 或 `scheduled:<运行编号>`，不加外键），同一 owner 和 agent 下非空的键唯一，用来防止自动录入通道重复写入同一条。
9. **清除 Gmail 记录只清 `kind = 'proactive'` 的行**，不能误删别的决策。
10. 新增读写接口 `DecisionLedgerPort`（写入、按类型和时间读取、评价、记录和读取 Muse 条目）。
11. **账本行加三个只属于记忆候选的可空列（Andy 2026-11-01 批准）：** `category`（候选的记忆分类，限定在 `MEMORY_CATEGORIES` 的 10 个值）、`confidence_permille`（抽取置信度，整数 0 到 1000）、`inferred`（是否推测，0 或 1）。表约束要求非 `memory_candidate` 的行这三列必须为空。这样“该留”这类后续动作可以按原分类存成记忆，也能按置信度和推测与否统计被丢弃的候选。

[返回目录](#contents)

<a id="options"></a>

## 放弃的做法

- **另建一张全系统账本，Gmail 表保持不动：** 变成两套记录，违反“扩展现有记录”。
- **保留表名 `proactive_decisions`：** 名字和内容不符；引用的两张表本来就要重建，改名的额外代价很小。
- **Muse 条目放进同一张表并用专用列：** 见决定第 8 条。
- **所有决策都在应用层先写记忆再写账本（两步）：** 中间失败会留下没有记录的记忆变更，违反“写入与记忆变更同一事务”。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 门槛：
  - `packages/persistence-sqlite/test/decision-ledger-migration.contract.test.ts`：旧版本数据迁移后逐列一致、外键仍有效，结果值不属于该类型时写入失败（反向）。
  - `test/integration/decision-ledger.test.ts`：每类写入并读回、三值评价和清除、非法评价被拒、候选和记忆同事务回滚、整理变更被拒时没有账本行、清除 Gmail 记录不误删、检索降级只在降级时写。
  - `test/integration/automatic-memory-golden.test.ts`、`test/integration/memory-consolidation.test.ts`、`test/integration/context-formation.test.ts`：每条审计结果、每条整理变更都有账本行；没有被截断时没有行。
- 整理对记忆的修改（合并、作废、归档、推断）经由 `DurableMemoryService` 单独完成，之后才写 `recordChange`；这两步不在同一个事务里，崩溃时可能有记忆变更而无账本行。要消除它需要把账本行并进每一种整理写入，留给后续。
- 候选被判为“未变化”（只是确认已有记忆）时，账本行在记忆历史追加之后单独写，不在同一个事务里。
- “外部 agent 读取”这一类已定义并可写入，但代码里没有外部程序读取记忆的入口，现在没有写入点。
- 账本没有评价界面：Gmail 的评价界面不变，其他类型的评价目前只有接口。
- 成本目前只有 Gmail 检查有值，其他类型为 0。

[返回目录](#contents)

<a id="references"></a>

## 关联文档

- [产品愿景 v2.2](../product-vision.md)、[ADR 0134](0134-adopt-product-vision-v2-2.md)
- [ADR 0106：主动闭环第一刀（只读 Gmail）](0106-proactive-loop-v1-gmail-read-only.md)（其中的 `proactive_decisions` 现为 `decision_ledger`）
- [ADR 0140](0140-settle-early-only-without-recoverable-result.md)（本 PR 的基准）

[返回目录](#contents)
