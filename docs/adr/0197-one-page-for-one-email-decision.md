---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-09"
covers: "apps/control-center/test/weekly-report.unit.test.ts, test/integration/decision-email-browser.test.ts, test/integration/decision-email.test.ts, test/tooling/prod-read.test.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0197：在控制中心用一页展示一封邮件的决策、依据链、本周校准数字和 Muse 对照

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P1-5（Andy 2026-10-31 写，2026-11-09 同意整合后的方案）。Andy 要在面试里用一个画面同时展示三项护城河资产：可导出的决策数据、带出处的规则、带来源可回滚的记忆。依赖的 P1-3（[ADR 0195](0195-show-the-whole-chain-of-one-decision-record.md)，完整依据链和抽屉）和 P0-9（Muse 条目按邮件配对、周报逐封比较）都已在 main。

Andy 的三个决定：合成一页（真的做成新页面，不是把现有页面并排）；这是长期留在产品里的功能，不是只为演示；给周报的差距案例加上通向邮件决策的入口。演示用的真实决策从生产机只读取得。

产品愿景的取舍依据：用户主权优先：Andy 能从一封邮件一路点到它背后的每条记录；边界与可逆性：整页只读，不改任何数据，不改发给模型的内容，所以不触及请求开头的只追加规则。

<a id="decision"></a>

## 决定

1. **新增只读查询 `decision.email.read`**：入参是 Gmail 邮件编号，返回这封邮件的判断（结果、跳过原因、评价、处理时间）、它用到的规则编号和记忆编号、关联邮件数、与它配对的 Muse 条目（最多 20 条，标题和正文只在没有被扣留时返回）和逐封比较结果。比较用词和周报的统计共用同一个函数 `mailComparisonBucket`，所以页面上的结论和周报的数字不会各说各话。
2. **没有记录就明说**：邮件没有 Himawari 的决策记录时比较结果是 `noHimawariRecord`；有记录但没有配对的 Muse 条目时是 `noMuseEntry`；老记录没存规则、记忆字段时这些字段是 `null`，界面显示“无记录”。
3. **周报的差距案例带上邮件编号**，并在每一行加“看这封邮件”按钮；老的已封存导出快照不要求这个字段。
4. **控制中心新页面**：提醒检查的“周报”页里点案例进入，一页内左边是这封邮件的判断和完整依据链（复用抽屉里的同一个组件，本封邮件用到的规则和记忆高亮），右边是那一周的校准数字（和周报同一份数据）、Muse 条目和对照结论；电脑两栏，手机一栏。依据链里，记忆可点到来源对话，推断记忆可展开它依据的记忆；规则只显示编号、来源和依据文档，评价只显示结论和时间，这两环这一版不能点开。
5. **页面状态不放进路由**：Gmail 邮件编号最长 256 个字符，超过路由参数的 128 字符上限，所以页面用内部状态，不用网址参数。
6. **只读生产查询**：`prod-read.sh gmail-decisions` 列出最近 100 条 Gmail 决策记录的元数据，不含邮件和记忆正文，供 Andy 挑演示用的那条。

<a id="options"></a>

## 放弃的做法

- **把现有的抽屉、周报、Muse 对照三块并排放在同一个路由里**：Andy 要的是合成一页，并排只是拼图。
- **只做演示页，演示完删掉**：Andy 明确要长期留在产品里。
- **把邮件编号放进网址**：超过路由参数长度上限，要改路由层，范围过大。
- **给任意邮件跳转 Gmail 原文**：邮件正文不进控制中心，这一版不做。

<a id="consequences"></a>

## 后果

- 门槛：
  - `test/integration/decision-email.test.ts`：邮件到决策的解析、比较用词、跳过和老记录字段为空、[negative] 不存在的邮件和他人的邮件、扣留的 Muse 正文不返回、契约与存储对邮件编号的规则一致（256 通过、257 拒绝）。
  - `apps/control-center/test/weekly-report.unit.test.ts` 的 `[P1-5]` 用例。
  - `test/integration/decision-email-browser.test.ts`：真实浏览器的正向、老记录显示“无记录”、没有判断的邮件显示无依据链并说明不能比较、手机宽度单列且不横向滚动。
  - `npm run check:operations`：新操作有后端实现、前端调用和测试。
  - `test/tooling/prod-read.test.mjs`：`gmail-decisions` 只读、只返回元数据。
- 入口只在周报的差距案例行；每日复盘和审计列表里的条目没有邮件编号，暂无入口。
- 不加迁移，不改发给模型的任何内容。

<a id="references"></a>

## 关联文档

- [ADR 0195](0195-show-the-whole-chain-of-one-decision-record.md)
- [产品愿景](../product-vision.md)
