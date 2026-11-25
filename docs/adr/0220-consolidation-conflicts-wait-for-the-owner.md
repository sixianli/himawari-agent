---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md"
date: "2026-11-11"
covers: "packages/calibration/src/thresholds.ts, packages/memory-engine/src/consolidation.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0220：整理记忆判到冲突时，默认让新条进「待确认」，只有明确取代且新条置信度够高才自动作废旧条

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

「整理记忆」（每天自动跑一次，`MemoryConsolidationService`，`packages/memory-engine/src/consolidation.ts`）是每天自动跑一次的记忆整理：把最近新增或修改的记忆和相近的旧记忆编成一组交给模型，模型判断这组是重复、冲突还是保留。原来模型只要判 `conflict`，代码就把旧条作废（记一条 `supersede` 整理改动，旧条的 `supersededBy` 指向新条）。提示词里的 `conflict` 写的是「同一件事前后说法不一样，较新的说法取代旧的」，把两种情况混在了一起：

- 取代：例如「以前住足立区」和「现在住北区」，旧说法确实不再成立；
- 情境差异：例如「平时喝明治的牛奶」和「出差时喝便利店的牛奶」，两条在不同场合各自成立。

后一种也被作废，Himawari 就会丢掉「平时喝明治」这条仍然正确的记忆。

对标：Mem0 的论文第 2.1 节写明，模型在 ADD/UPDATE/DELETE/NOOP 四种操作里选，「DELETE for removal of memories contradicted by new information」，图版本 Mem0g 改为「marking them as invalid rather than physically removing them」（[arXiv:2504.19413](https://arxiv.org/html/2504.19413)）。两种做法都是判矛盾就让旧条失效，不区分取代和情境差异，和本项目原来的做法相同。ChatGPT 怎样处理记忆冲突没有找到一手说明，未核实。

记忆本来就有「待确认」标记（`attributes.tentative`，见 [ADR 0179](0179-keep-low-confidence-memory-candidates-as-tentative.md#context)）：带这个标记的记忆不进主人档案块，默认不进向量检索，等主人在记忆页点「确认」才转正。

<a id="owner-decisions"></a>

## Andy 的原话

任务块 P3-8（2026-10-31 写成，2026-11-11 交给线程）：「整理检测到冲突时默认进待确认而非自动作废；仅两条明确对立且新条置信度达阈值时自动作废。两个例子：「以前住足立区 / 现在住北区」是取代不是冲突，自动作废旧条；「平时喝明治的牛奶 / 出差时喝便利店的」是情境差异，进待确认。」

2026-11-11 Andy 在决策卡「确认待确认的新记忆后，旧的那条怎么处理？」上选了「两条都留」，随后对变更清单回复「同意」。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

依据的原则：愿景原则 2「边界与可逆性」和原则 3「记忆可靠性」优先于原则 4「主动性与效率」。拿不准的时候不替主人删记忆。

1. **提示词把冲突拆成两种。** `memory.consolidation` 加 `replace`（同一件事，新说法明确取代旧说法，旧说法已经不成立），`conflict` 改为「说法不一样，但可能在不同场合各自成立，或拿不准是不是取代」。两个例子写进提示词。返回格式 `memory.consolidation.format` 的 action 加 `replace`。
2. **只有一种情况自动作废旧条：** 模型判 `replace`，模型标的 keep 是两条里说得更晚的那条（按 `validFrom`，没有就按记下时间），并且这条的置信度不低于自动存入门槛。这时和原来一样记 `supersede`。
3. **其他情况都让新条进「待确认」。** 包括判 `conflict`、判 `replace` 但新条置信度不够、判 `replace` 但 keep 标成了较早的那条。说得更晚的那条加上 `tentative: true`，较早那条不动、照常生效。整理改动和决策记录都记成新动作 `hold`：改动的 `memory_id` 是新条，`related_memory_id` 是旧条；决策记录 `outcome` 为 `hold`、原因码 `consolidation_hold`，`memoryIds` 为 [新条, 旧条]，`resultMemoryIds` 为 [新条]，所以每天打分里显示成「旧 → 新」。这条记录和其他整理记录一样进每天打分的整理组，受同一个每日容量限制。
4. **主人确认后两条都留。** 主人在记忆页对新条点「确认」，只是把它的 `tentative` 改回 false，不作废旧条（Andy 2026-11-11 选定）。如果其实是取代，主人在记忆页删旧条。
5. **撤销 `hold`** 把新条的 `tentative` 改回 false。主人改过这条记忆（包括点了确认）之后不能再撤销，和其他整理改动一样。记忆页的变化记录里，「撤销」按钮由后端给每条整理改动算出的 `undoable` 决定：记忆自整理后没被改过（修订号仍等于整理记下的 `afterRevision`）才显示；被改过（包括点了确认）的不显示按钮，改显示「这条记忆之后又改过，不能撤销」。另外 `hold` 的新条已不在待确认时（例如主人改回了 `tentative`），界面也不给按钮。
6. **处理过的一对不再整理。** 一对记忆只要有过 `hold`（不论后来是确认、撤销还是还在等），以后的整理就不再把它们当作一对交给模型判断：配邻居时这一对互相跳过；它们仍可能一起作为另一条新记忆的邻居出现在同一组，但模型的判断只有涉及那条新记忆时才执行，所以对这一对给出的判断不会执行。否则主人确认或撤销后新条的修改时间变了，第二天又会被拿去整理，可能再次进待确认，甚至被自动作废旧条，推翻主人的选择。持久层用 `listHeldPairs` 读出所有 `hold` 过的一对。
7. **门槛和自动存入共用一份登记。** 第 2 条的「自动存入门槛」就是门槛登记表 `packages/calibration/src/thresholds.ts` 里的 `MEMORY_AUTO_COMMIT_GATE`（默认 850，可按分类覆盖），按新条的分类取值（`autoCommitThreshold`）。整理记忆和记忆抽取读同一份登记，校准周报给出的建议值改的也是它，代码里不再出现第二个 850。（变更清单原先写的是另加一个 `config.json` 设置；合并 main 时发现 P4-7 已把这个门槛登记进门槛登记表，于是改为复用它，不另开一个入口。）
8. **表结构。** `memory_consolidation_changes.action` 和 `decision_ledger` 里整理类 `outcome` 的取值各加 `hold`，用新迁移重建这两张表。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **只靠置信度区分，不改提示词：** 正式记忆的置信度都不低于 850（自动存入要不低于 850，手动记住是 1000），置信度这道闸几乎挡不住什么，牛奶的例子仍会被作废。放弃。
- **确认就等于取代旧条：** 进待确认的多半正是情境差异，确认「出差喝便利店的」就会作废「平时喝明治」，正是这项改动要防的。Andy 选了两条都留。
- **不改记忆状态，只记一条「待处理的取代」：** 需要另做一套待处理清单和确认入口，而记忆已有的「待确认」标记已经被档案块、检索和提醒排除，记忆页也已有确认入口。放弃。
- **本方案：** 提示词区分两种，代码再加置信度和时间先后两道检查，拿不准时复用待确认标记。

<a id="consequences"></a>

## 后果

- 正面：情境差异不再被吞；每个待确认都有决策记录，可在每天打分里评价，也可撤销。
- 负面：模型拿不准的真取代，要主人多点一次（确认新条再删旧条）。新条待确认期间不进主人档案块，聊天里每轮自动带上的档案暂时看不到这条新说法。
- 已有提醒的记忆被改成待确认后，提醒行保留但暂停：到期和即将到期的提醒查询都排除待确认记忆（`sqlite-memory-reminder-operations.ts` 的 `tentative = 0`），所以主人确认或撤销这次 `hold` 之前它不会响，之后恢复。这是有意的：两条说法不一（例如交报告是周四还是周五）时不知道哪条对，较早那条的提醒照常响，较新那条等主人确认。（[ADR 0179](0179-keep-low-confidence-memory-candidates-as-tentative.md#decision) 只规定了新存的待确认记忆不登记提醒。）
- 置信度这道闸短期基本不起作用（原因见上节第一条），实际起作用的是模型判 `replace` 还是 `conflict`。以后如果正式记忆里出现低置信度的条目，它才会起作用。
- 整理调用模型的路径不变。I-63（辅助调用常失败，`缺门槛`）仍适用：调用模型失败时整次整理记为失败、不改任何记忆，不会因为失败误作废。模型已经回答、逐条执行判断时，每一条（合并、取代、`hold`）各自提交；后面的步骤（归纳、记完成）出错时，整次记为失败，但已提交的改动保留，和本 ADR 之前的合并、取代一样。已提交的 `hold` 照样生效（新条待确认、变化记录可见、可确认或撤销），所以也算处理过的一对（决定 6）。
- 提示词改动只影响整理记忆这类后台调用，不改任何对话已发出的请求开头。

<a id="references"></a>

## 关联文档

- [ADR 0179：低分记忆候选存成待确认](0179-keep-low-confidence-memory-candidates-as-tentative.md)
- [ADR 0143：决策记录](0143-decision-ledger-for-model-gate-decisions.md)

[↑ 返回阅读导航](#contents)
