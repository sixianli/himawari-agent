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
2. **每行一个决策类型 `kind`：** `proactive`、`memory_candidate`、`consolidation`、`context_truncation`、`retrieval_degrade`、`external_read`（2026-11-11 起另有 `rule_review`，见 [ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md)）。表上的约束保证每个类型只能写自己的结果值，例如记忆候选只能是 `kept`、`discarded`、`pending_approval`，Gmail 行必须有 `verdict` 且不能有 `outcome`。
3. **每行带：** 结果 `outcome`、短代码 `reason_code`、对象 `subject_ref`、输入 `inputs`（JSON，只放记忆编号 `memoryIds` 和规则编号 `ruleIds`，不放正文；Gmail 检查的 `memoryIds` 只含实际放进提示词的记忆，见 [ADR 0158](0158-bring-related-memories-into-gmail-checks.md)）、理由正文的加密引用 `reason_ref`、候选正文的加密引用 `content_ref`、成本 `cost_micros`、耗时 `duration_ms`、评价 `owner_rating` 和评价时间。评价沿用 `useful`（有用）、`unneeded`（不需要）、`missed`（漏了）三个值，可清除。
4. **`inputs` 的含义：** 这条决策涉及的记忆。记忆候选和整理写被决策的记忆；上下文截断写被截掉的记忆；检索降级和外部读取没有对应记忆时为空。规则编号目前只用于被规则丢弃的候选（写丢弃原因），规则手册落地后再接。
5. **写入和记忆变更在同一个数据库事务里：**
   - 候选被保留时，账本行随 `saveWithProjection`（记忆记录、投影任务、历史三者的同一个事务）一起写入；账本行写失败，记忆也不会保存。
   - 整理的每条变更，账本行随改记忆的那一次 `saveWithProjection` 在同一个事务里写入（[ADR 0194](0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md) 把原来的 `recordChange` 并了进来；原先整理对记忆本身的修改是事务之前的单独一步）。
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
12. **记忆候选的记录点（P0-3，Andy 2026-11-01 批准）：** 保留、待审批、丢弃三种结果都写账本，并填上述三列。丢弃共有六种原因：含机密（`candidate_secret_excluded`）、受限（`restricted_excluded`）、临时内容（`transient_ignored`）、置信度低于门槛（`confidence_below_threshold`）、审批被拒或过期（`approval_rejected`、`approval_expired`），以及原话校验不过（`evidence_unverified`）。“推测被压”不另设原因：推测类置信度上限为 700，低于自动保存的 850，落在 `confidence_below_threshold`，用 `inferred = 1` 区分。原话校验不过的候选在抽取阶段就被丢掉，不会进入记忆服务的候选列表；抽取阶段把它们连同候选内容一并交给记忆服务，由记忆服务写账本，正文同样加密存引用，含机密或受限的不存正文。门槛数值（850、700）不变，也没有任何丢弃的候选写进记忆库。（2026-11-08 起部分修订，见 [ADR 0179](0179-keep-low-confidence-memory-candidates-as-tentative.md)：满足条件的低分新建候选改存为待确认记忆，账本记 `kept` + `kept_tentative`，其余仍记 `confidence_below_threshold`。）（[ADR 0183](0183-mask-only-when-data-leaves-and-keep-the-original-inside.md) 起不再有“含机密”这一种丢弃原因，其余五种不变；本条正文里“含机密或受限的不存正文”一句，现在只剩“受限”的候选不存正文。）（2026-11-11 起，P4-7：对待确认记忆的 `unchanged`、`update`、`merge` 候选改由「待确认记忆转正」门槛判断，过了记 `kept` + `tentative_confirmed`，没过记 `discarded` + `confirm_below_threshold`。至此 `memory_candidate` 现行的丢弃原因是 `restricted_excluded`、`transient_ignored`、`confidence_below_threshold`、`confirm_below_threshold`、`approval_rejected`、`approval_expired`、`evidence_unverified` 七种（`candidate_secret_excluded` 已由 ADR 0183 停用）。账本分类记的是那条记忆转正后的分类（`unchanged` 取原有分类）；门槛登记在 `packages/calibration/src/thresholds.ts`，默认值仍是 850，所以记忆的去留和以前一样，只是原因码不同。）（2026-11-11 起，P5-2：外部 agent 经 MCP 提议的记忆，主人确认保存记 `kept` + `mcp_proposal_kept`，拒绝记 `discarded` + `mcp_proposal_declined`，所以丢弃原因多了这一种；自动记忆校准排除这两种原因码，见 [ADR 0225](0225-external-agents-propose-memory-with-in-client-confirmation.md)。）
13. **每日整理的记录点（P0-4，Andy 2026-11-01 批准）：** 合并、取代旧说法、归档、推断新特点四类动作各写一行，沿用第 5 条的同一事务。`inputs` 新增两个可选字段，不需要新迁移：`batchId`（所属整理批次，即 `memory-consolidation:<agent>:<日期>`）和 `resultMemoryIds`（动作之后产生或留下的记忆）；`memoryIds` 仍是动作之前涉及的记忆。合并和取代写 [被处理的旧记忆, 保留的新记忆]，结果是保留的那条；归档写被归档的那条，结果为空；推断写全部依据记忆（原先只记第一条），结果是新生成的推断记忆。主人撤销一条整理时，对应账本行在同一个事务里被评为 `unneeded`；撤销被拒绝时不改评价。不改整理策略。旧行读出时这两个字段为空。

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
- 已由 [ADR 0194](0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md) 消除：整理对记忆的修改（合并、作废、归档、推断）和账本行、变更行、依据行在同一个事务里写；原先崩溃时可能有记忆变更而无账本行。
- 候选被判为“未变化”（只是确认已有记忆）时，账本行在记忆历史追加之后单独写，不在同一个事务里。
- “外部 agent 读取”这一类已定义并可写入，但代码里没有外部程序读取记忆的入口，现在没有写入点。
- 账本没有评价界面：Gmail 的评价界面不变，其他类型的评价目前只有接口。
- 成本目前只有 Gmail 检查有值，其他类型为 0。

[返回目录](#contents)

<a id="references"></a>

## 关联文档

- [产品愿景 v2.2](../product-vision.md)、[ADR 0134](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0134-adopt-product-vision-v2-2.md)
- [ADR 0106：主动闭环第一刀（只读 Gmail）](0106-proactive-loop-v1-gmail-read-only.md)（其中的 `proactive_decisions` 现为 `decision_ledger`）
- [ADR 0140](0140-settle-early-only-without-recoverable-result.md)（本 PR 的基准）

[返回目录](#contents)
