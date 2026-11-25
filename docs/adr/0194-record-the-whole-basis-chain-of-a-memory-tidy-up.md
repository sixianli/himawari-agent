---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-09"
covers: "apps/agent-service/test/production-memory-basis.unit.test.ts, packages/memory-engine/src/consolidation.ts, packages/persistence-sqlite/test/memory-consolidation-basis-migration.contract.test.ts, test/integration/decision-ledger.test.ts, test/integration/memory-consolidation.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0194：记忆整理的每次改动记全依据，并和改记忆写进同一个事务

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P1-2（Andy 2026-10-31 写，2026-11-08 按 main 重核，2026-11-09 同意变更清单）。Andy 要求 Himawari 的每一次主动开口或沉默都能追溯：用了哪条记忆、这条记忆是从哪几条推出来的。每天自动跑一次的记忆整理（合并重复、作废冲突、归档闲置、从几条记忆推出一条新结论）是这条链上最容易断的一环。

动手前对着代码核对的现状（main 6cb8405b）：

- 整理变更表 `memory_consolidation_changes`（迁移 0054）只有一个 `related_memory_id` 列。推断（reflect）时它只记基础记忆里的第一条（`packages/memory-engine/src/consolidation.ts`），而决策记录（[ADR 0143](0143-decision-ledger-for-model-gate-decisions.md)）的 `inputs.memoryIds` 已记全。
- 改记忆和记变更是两次独立的写：引擎先调 `DurableMemoryService.revise`，再调 `recordChange`。中间失败会留下没有变更记录、也没有决策记录的改动。`saveWithProjection` 本来就能在一个事务里存记忆、排索引任务、写决策记录，整理没有用它。

产品愿景的取舍依据：记忆可靠性优先于主动性与效率，所以依据链和改动不可分开落盘。

<a id="decision"></a>

## 决定

1. **迁移 0084 新建 `memory_consolidation_change_basis`**：每行是某次整理改动的一条依据记忆（改动编号、顺序、记忆编号），改动或记忆被删时随之级联删除，按记忆编号建索引，供以后“改一条记忆，由它推出的记忆跟着重审”反查。合并和作废记两条（被改的那条和取代它的那条），归档记一条，推断记全部基础记忆。迁移时按决策记录里同一次整理的 `inputs.memoryIds` 回填老数据。找不到决策记录的老行：合并、作废、归档退回用变更表的 `memory_id` 和 `related_memory_id`；老的推断行只退回 `related_memory_id`（当时只记了第一条基础记忆），其余基础记忆无法恢复。
2. **改记忆、变更行、依据行、决策记录在同一个事务里写**：`saveWithProjection` 新增可选的整理参数，`DurableMemoryService.revise` 和 `applyProposal` 把它传下去；原来的 `recordChange` 删除。变更编号、前后版本在存记忆之前由引擎算好，存记忆后的版本号由回调拿到。事务里任何一步失败，记忆和决策记录都不变。
3. **读取接口**：存储端口新增 `readBasis(changeId)` 和 `readBasisChain`（给一条记忆（合并、作废、归档是被改的那一条；推断是新推出的那一条），沿它最近一次未撤销的整理改动，一层层往依据里走，直到不是整理产生的源头；有深度上限、节点数上限和环检测，只读自己名下的记录；返回的 `decisionRecordId` 是由改动编号算出的编号，决策记录被清除后它指向的那一行可能已不存在）。网关新增查询 `memory.basis.read` 和快照 `memory.basis.snapshot`，快照是扁平的节点列表（记忆、整理改动编号和动作、决策记录编号、它的依据记忆编号），节点数上限 200；节点数超限或任一节点因深度、节点数被截断时 `complete` 为假。依据记忆被治理删除时，它的依据行随之级联删除，依据链会少一个节点，读取方看不出少的是已删除的来源（可以更好，未做）。
4. 引擎遇到 `ApplicationPortError` 时，只有记忆本身已经变了（版本冲突、状态不允许）才跳过这条；记忆没变、却在整理事务内写失败（例如依据行写不进去）时继续向上抛，让这次整理失败，不静默漏记。

<a id="options"></a>

## 放弃的做法

- **把依据 id 列表塞进变更表的一个 JSON 列**：不能按记忆反查，也没有外键保证记忆被删时同步清理。
- **读取时从决策记录现算依据**：决策记录会被 Andy 清除或评价，不能当事实来源；两张表也可能因为 I-63 一类的失败而不一致。
- **只把写决策记录并进原来的事务，改记忆仍是另一步**：改记忆才是最需要保证不丢记录的那一步。

<a id="consequences"></a>

## 后果

- 门槛（会自动拦下的测试）：
  - `test/integration/decision-ledger.test.ts` 的 `[P1-2]` 用例（worker 和 direct 两种执行方式各跑一遍）：依据行里写入不存在的记忆时，记忆保持原版本、没有变更行、没有决策记录；成功时三者齐全；一层推断加一层合并的完整链能读出。去掉事务（吞掉依据写入的错误）时这条用例失败。
  - `test/integration/memory-consolidation.test.ts`：合并、作废、归档、推断四类动作各自能列出全部依据，推断的依据链与决策记录里的记忆编号一致。
  - `packages/persistence-sqlite/test/memory-consolidation-basis-migration.contract.test.ts`：老数据回填，包括退回到变更表列的情况。
  - `apps/agent-service/test/production-memory-basis.unit.test.ts`：读取接口按名下范围读、扁平化、超限标记、未安装时拒绝，快照通过网关契约。
- 与 I-63（整理和标题的模型调用经常失败）无关：本次只改整理拿到模型结果之后的写入，不增加或改动任何发给模型的请求。
- 没有做的：网页上还没有展示依据链的界面；“改一条记忆，推出的记忆跟着重审”（纠正传播）是以后的事，本次只提供它要走的链。
- 撤销整理改动后，读取接口以最近一次未撤销的改动为这条记忆的整理记录，依据取这条记忆全部未撤销改动的依据并集。
- 推断记忆的正文 payload 在事务之外先写（既有结构），事务回滚时可能留下没有引用的 payload；“要么都写要么都不写”只覆盖记忆、变更、依据和决策记录。
- 决策记录里的记忆编号由依据列表直接派生，不再单独传一份；依据记忆必须属于同一个 Owner 和 Agent。

<a id="references"></a>

## 关联文档

- [ADR 0143：决策记录](0143-decision-ledger-for-model-gate-decisions.md)
- [产品愿景](../product-vision.md)
- [ADR 0196：停掉闲置归档](0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md)：背景里列的“归档闲置”自 2026-11-09 起不再发生，旧的闲置归档记录仍按本决定可以追溯。

[返回目录](#contents)
