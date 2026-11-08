---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-08"
---

# ADR 0185：记忆详情能跳到来源对话里的那句原话，找不到的显示“来源已不可查”并计数

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P1-1（Andy 2026-11-08 写；同日选定导入方案 A 并同意变更清单）。目标是让每条记忆都说得清来源：记忆页点开一条记忆，能从它的来源对话直接跳到 Andy 说的那句话。依据产品愿景里“记忆可靠性”优先于“主动性与效率”：来源要能追溯，追溯不到要如实说。

动手前对着代码核对的现状（main 01873f5）：

- 记忆详情里的“来源对话”只打开对话，不定位句子（`apps/control-center/src/components/memory-page.tsx`）。
- 自动抓取的记忆，`sourceRefs` 里已存有触发抓取的那条 Andy 消息的内容引用（`apps/agent-service/src/production-memory-capture.ts` 的 `sourceRef: source.payloadRef`）；对话里的每条消息有同一个 `contentRef`。所以不改来源的存法，就能把记忆对回消息。
- 导入的记忆（`memory.import.commit`）只存记忆文字和一个来源名（codex、assistant、himawari），没有来源对话，没有原句，也没有文件名和行号。导入的那一行字本身就是记忆，不存在另一句“原话”可以跳。

<a id="decision"></a>

## 决定

1. **网关的记忆概览给每条记忆增加 `sourceMessageId`**：服务端在这条记忆的来源对话里，用 `sourceRefs` 匹配 Andy 说的消息（只匹配 `role = owner`），多条匹配时取序号最小的一条；匹配不到为空。查询是只读的（`memoryBook.findOwnerMessages`），不改已存数据，不加迁移。
2. **记忆详情的“来源对话”改成“跳到原话”**：打开对应对话，滚到那条消息并高亮。
3. **找不到原话的记忆显示“来源已不可查”**，来源对话已被删除的沿用原有的“来源对话已删除”，整理记忆产生的沿用“整理记忆”，手动添加的沿用“你手动添加”。
4. **导入的记忆明确写“导入自 Codex / 其他 AI / Himawari 导出文件”，不假装能跳**，计入单独的“没有原话”类。
5. **条数的定义**（记忆页顶部显示，也由只读脚本 `scripts/operations/memory-source-report.mjs` 按同一定义数出）：只数使用中和已归档的记忆；
   - “来源已不可查”：有来源对话，但它的 `sourceRefs` 在那个对话里匹配不到 Andy 的任何消息；
   - “导入的，没有原话”：属于某个导入批次；
   - 其余各类（能跳到原话、手动添加、来源对话已删除、整理记忆产生）互不重叠，合计等于总数。

<a id="options"></a>

## 放弃的做法

- **导入时把原文件的那一行也存下来**：要改来源的存法并加迁移，任务块明确不改来源的存法。
- **在浏览器里用全部消息现算跳转目标**：记忆页拿不到每个对话的消息，算不出“已不可查”的总数。
- **新增一个按事件记录“哪次确认对应哪条消息”的表**：同样要改存法。

<a id="consequences"></a>

## 后果

- 门槛（会自动拦下的测试）：
  - `test/integration/production-memory-capture.test.ts` 的 `[P1-1]` 用例（真实 SQLite）：抓取的记忆指向 Andy 的那条消息；对话里的消息被清掉后为空；导入的记忆为空。
  - `test/integration/memory-source-report.test.ts`：每条记忆只落入一个类别，对话不对、引用对不上、已进回收站的都不计入“能跳到原话”。
  - `apps/control-center/test/memory-interactions.unit.test.ts` 的 `[P1-1]` 用例：能跳、已不可查有计数且无跳转、导入写来源批次且无跳转；反向用例是手动添加和整理产生的记忆不计入“已不可查”。
  - `apps/control-center/test/message-focus.unit.test.ts`：只在对应对话里滚动并高亮；别的对话、消息不存在时不动。
- 已知局限：同一条记忆被多次确认时，`sourceRefs` 累积但没存“哪个引用对应哪次”，所以跳到的是最早的那条消息，不一定是最近一次确认的那句；详情里“你说：‘……’”仍是各次的原话文字。
- 数据：生产和 Hermes 上的实际条数要用 `node scripts/operations/memory-source-report.mjs <product.sqlite>` 数出来。本 ADR 写成时没有跑过任何真实库，所以没有写入实测数字；跑过之后把结果追加到本节。

<a id="references"></a>

## 关联文档

- [ADR 0113：记忆历史事件与立场](0113-memory-history-events-and-stance.md)
- [产品愿景](../product-vision.md)

[返回目录](#contents)
