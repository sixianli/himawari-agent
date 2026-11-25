---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-09"
covers: "apps/control-center/test/proactive-interactions.unit.test.ts, test/integration/decision-chain-browser.test.ts, test/integration/decision-chain.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0195：给一条决策记录读出完整的依据链，并在控制中心用抽屉显示

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P1-3（Andy 2026-10-31 写，2026-11-09 同意整合后的方案）。Andy 要求：给定一条决策记录（表 `decision_ledger` 的一行），能返回并显示完整的链：判断结果、命中的规则和规则出处、用到的记忆（原话、来源、现状、被谁取代）、推断记忆是从哪几条记忆推出来的（复用 [ADR 0194](0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md) 的 `readBasisChain`）、Andy 的评价。链上任何一环没有记录，界面显示“无记录”，不留空白。

动手前核对的现状：决策记录已经保存了规则编号、命中记忆、记忆召回状态、关联邮件读取状态等输入（`DecisionInputs`），记忆、变更记录和依据行也已存在，所以不需要新增表或迁移，也不重新计算任何东西。

产品愿景的取舍依据：用户主权优先于其他原则：Andy 必须能看到每个判断的依据；记忆可靠性次之：模型也看不到的那档记忆（数据分级里的受限档，`reviewMemoryVisible` 判为不可见）的内容仍然隐藏；敏感档随 [ADR 0193](0193-memory-is-visible-to-the-model.md) 已对模型可见，这里照常显示。

<a id="decision"></a>

## 决定

1. **新增只读查询 `decision.chain.read`**：入参是决策记录编号，返回判断、各节状态（`recorded`、`none`、`not_recorded`、`not_applicable`）、规则、邮件计数和记忆列表。名下没有这条记录时返回“未找到”，不返回空链。
2. **只读已存的记录**：不重算、不改发给模型的任何内容，不加迁移。判断前的原文（`decision_ledger_payloads`）这一版不显示，避免把未遮盖的内容带到界面。
3. **记忆显示现在的内容**：每条记忆给出 `changedSinceDecision`（决策之后改过），界面标注“显示的是现在的内容”。受限记忆（和 `reviewMemoryVisible` 的规则一致）的正文类字段（记忆正文、原话、取代它的记忆的正文、推断依据节点的正文）都不返回；记忆编号、来源对话和消息编号这类标识符仍然返回，因为它们不是正文。
4. **规则出处登记在 `DECISION_RULE_CATALOG`**：编号、来源（你设定的 / 内置）和依据文档；未登记的编号显示“未登记的规则”，不猜。
5. **体量上限**：记忆最多 100 条，推断依据节点合计最多 200 个，超出时标明被截断；排序固定，同一条记录每次返回相同。
6. **控制中心**：提醒检查记录每一行有“依据”按钮，点开侧边抽屉，抽屉里只显示这条链。记录已被清除时关闭抽屉并提示。
7. **写入约定**：新增决策记录的写入方必须按 [决策记录写入约定](../execution/specs/2026-11-09-decision-record-write-convention.md) 填写输入字段。

<a id="options"></a>

## 放弃的做法

- **读取时重新跑一遍规则和召回**：结果可能和当时不同，也违背“不重算”。
- **把判断前的原文一起显示**：原文是遮盖前的内容，隐私风险大，这一版不做。
- **做一个通用的内部信息面板**：Andy 要求抽屉只显示这条链。

<a id="consequences"></a>

## 后果

- 门槛：
  - `test/integration/decision-chain.test.ts`：Gmail 记录的完整链、缺项显示无记录、受限记忆隐藏、他人记录和不存在的记录被拒、截断上限。
  - packages/application/test/decision-rule-catalog.unit.test.ts：规则登记表。
  - `apps/control-center/test/proactive-interactions.unit.test.ts` 的 `[P1-3]` 用例和 `test/integration/decision-chain-browser.test.ts`（真实浏览器，含正向、缺项、记录已清除、手机宽度）。
  - `npm run check:operations`：新操作有后端实现、前端调用和测试。
- 老记录缺的字段显示“无记录”，不回填。

<a id="references"></a>

## 关联文档

- [决策记录写入约定](../execution/specs/2026-11-09-decision-record-write-convention.md)
- [ADR 0194](0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md)
- [产品愿景](../product-vision.md)
