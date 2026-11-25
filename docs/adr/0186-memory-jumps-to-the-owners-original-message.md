---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-08"
covers: "apps/agent-service/src/production-memory-capture.ts, apps/control-center/src/components/memory-page.tsx, apps/control-center/test/memory-interactions.unit.test.ts, apps/control-center/test/message-focus.unit.test.ts, scripts/operations/memory-source-report.mjs, test/integration/memory-source-browser.test.ts, test/integration/memory-source-report.test.ts, test/integration/production-memory-capture.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0186：记忆详情能跳到来源对话里的那句原话，找不到的显示“来源已不可查”并计数

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [页面和脚本的已知差别](#differences)
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

1. **网关的记忆概览给每条记忆增加 `sourceMessageId`**：服务端按来源对话分组，用 `sourceRefs` 在那个对话里匹配 Andy 说的消息，条件是：消息是 Andy 说的（`role = owner`）、已提交（`message_status = 'committed'`）、对话没有进回收站或删除流程；多条匹配时取序号最小的一条；匹配不到为空。过长（超过 `MEMORY_SOURCE_REF_MAX_LENGTH`，当前 512）的引用不参与匹配。页面和网关按 JavaScript 的 `.length`（UTF-16 单元）计，脚本里的 SQL `length()` 按字符计，含非 BMP 字符（如部分表情）的引用恰好在上限附近时两边可能一个算超长、一个不算；现有的引用都是 ASCII，不受影响。查询是只读的（`memoryBook.findOwnerMessages`），不改已存数据，不加迁移；来源对话 id 下推进 SQL，走 `thread_messages` 已有的按对话索引，不再整表扫描。
2. **记忆详情的“来源对话”改成“跳到原话”**：点击的那一刻先重新读一次记忆概览（读取失败时不跳转，详情保留并显示“来源已不可查”；新快照里没有这条记忆时不跳转，详情随这条记忆一起关闭），来源消息已被清掉或对话已进回收站时，不跳转，立刻改显示“来源已不可查”并更新条数（概览最多会旧 5 分钟，不能让按钮点了没反应）。打开对应对话，滚到那条消息并高亮。跳转请求在对话详情就绪之前一直等着（对话加载多慢都不丢）；如果对话页已经在显示另一个对话超过 10 秒，请求作废，不会在之后误触发。
3. **找不到原话的记忆显示“来源已不可查”**，来源对话已被删除的沿用原有的“来源对话已删除”，整理记忆产生的沿用“整理记忆”，手动添加的沿用“你手动添加”。
4. **提醒工具创建的记忆单独一类“提醒创建，无原话”**（推荐的做法，已采用）：这类记忆的 `sourceRefs` 是合成的 `memory-content:reminder:*`，本来就不对应任何消息，把它们算作“来源已不可查”会虚增数字。判定：有来源对话，匹配不到消息，并且全部引用都以 `memory-content:reminder:` 开头。详情里仍保留“来源对话”入口，打开那次对话（不定位句子）。放弃的另一种做法是只加类别、不留入口：提醒是在那次对话里说出来的，入口有用，没有理由拿掉。
5. **导入的记忆明确写“导入自 Codex / 其他 AI / Himawari 导出文件”，不假装能跳**，计入单独的“没有原话”类。
6. **条数的定义**（记忆页顶部显示，只读脚本 `scripts/operations/memory-source-report.mjs` 用同一套分类）：只数使用中和已归档的记忆；类别互不重叠，依次判断：属于某个导入批次（导入）、手动添加、有来源对话且能匹配到消息（能跳到原话）、有来源对话但引用全是提醒的合成引用（提醒创建）、有来源对话但匹配不到（来源已不可查）、没有来源对话且最早的历史记录标了来源已删（来源对话已删除）、其余（整理记忆产生的）。（2026-11-11 起，[ADR 0225](0225-external-agents-propose-memory-with-in-client-confirmation.md)：在手动添加之后、能跳到原话之前多判断一类「外部 agent 提议、主人确认的」，按记忆编号前缀 `memory:mcp:` 判断。后续：[ADR 0226](0226-external-agents-propose-rules-through-the-rule-proposal-flow.md) 把外部提议的规则类记忆（前缀 `memory:rule:mcp:`）也归为这一类。）

<a id="differences"></a>

## 页面和脚本的已知差别

两者用同一套分类，但数的范围不同，数字可能略有出入：

- 页面只数网关概览里已经加载的记忆：概览里读不出文字的记忆被跳过；使用中的记忆全部列出，已归档和回收站里的记忆受概览的条数上限限制。脚本直接数整个数据库里使用中和已归档的全部记忆。
- 脚本不按所有者和 Agent 过滤。Himawari 的一个数据库只属于一位主人，所以不影响结果；将来一个库放多人时要加。
- 整理记忆（合并、取代）产生的记忆会继承来源对话，所以它们按有无匹配归入“能跳到原话”或“来源已不可查”，不会归入“整理记忆产生的”；这个类别只含没有来源对话的整理记忆。
- 记忆本身的文字读不出时，页面跳过整条记忆。只有最早的一条历史记录读不出文字时，页面跳过这一条历史，“来源对话已删除”和“整理记忆产生的”改看第一条读得出的历史；脚本按数据库里最早的那条历史的“来源已删”标记判断，两边在这种情况下可能不同。
- “来源对话”入口：提醒创建和“来源已不可查”的记忆只要还记着来源对话，详情里都保留这个入口，打开那次对话但不定位句子。来源对话在回收站时，页面无法知道（概览不带对话状态），入口会打开一个读不出内容的对话，和这次改动之前的行为相同，不在本次范围；脚本则会把回收站里的对话上、非提醒合成的来源算作“来源已不可查”，纯提醒合成的来源仍归“提醒创建”。
- 导入批次的来源名只取最近 20 批；更早的批次在详情里显示通用的“导入”，不写“导入自 Codex”。这一点列给 Andy，这次不改。

<a id="options"></a>

## 放弃的做法

- **导入时把原文件的那一行也存下来**：要改来源的存法并加迁移，任务块明确不改来源的存法。
- **在浏览器里用全部消息现算跳转目标**：记忆页拿不到每个对话的消息，算不出“已不可查”的总数。
- **新增一个按事件记录“哪次确认对应哪条消息”的表**：同样要改存法。

<a id="consequences"></a>

## 后果

- 门槛（会自动拦下的测试）：
  - `test/integration/production-memory-capture.test.ts` 的两条 `[P1-1]` 用例（真实 SQLite）：抓取的记忆指向 Andy 的那条消息；对话里的消息被清掉后为空；导入的记忆为空；agent 的消息即使和 Andy 的消息共用同一个内容引用也不命中（共用时认 Andy 的那条）；多条匹配取最早的；超过 200 条引用分批查找；消息未提交、对话在回收站、删除中、已删除时为空。对话状态用真实表的取值直接写入，没有走带权限凭证的“移入回收站”命令。
  - `test/integration/memory-source-report.test.ts`：每条记忆只落入一个类别，对话不对、引用对不上、已进回收站的都不计入“能跳到原话”；消息未提交、对话在回收站或删除中的归入“来源已不可查”；提醒的合成引用混着超长引用仍归提醒，混着真引用则不归提醒。
  - `apps/control-center/test/memory-interactions.unit.test.ts` 的 `[P1-1]` 用例：能跳、已不可查有计数且无跳转、导入写来源批次且无跳转；反向用例是手动添加和整理产生的记忆不计入“已不可查”。
  - `apps/control-center/test/memory-interactions.unit.test.ts` 的点击时核对用例：页面加载后来源消息被清掉，点“跳到原话”不跳转，详情改显示“来源已不可查”，顶部条数更新。
  - 同一个测试文件里还有“新快照里没有这条记忆”的用例：详情关闭、不跳转；`memory-source-report.test.ts` 锁定提醒合成前缀 `memory-content:reminder:` 在页面、脚本、写入端三处一致。
  - `test/integration/production-memory-capture.test.ts` 的超长引用用例：超过上限的引用既不出现在概览的 `sourceRefs`，也不用来查消息；刚好等于上限的引用照常使用；`MEMORY_SOURCE_REF_MAX_LENGTH` 在网关契约里只写一处；脚本保留独立常量 `SOURCE_REF_MAX_LENGTH`，由 `memory-source-report.test.ts` 锁定数值相等。
  - `test/integration/memory-source-browser.test.ts`：真实浏览器里点“跳到原话”后，对应消息被高亮；直接打开对话时没有任何高亮。
  - `apps/control-center/test/message-focus.unit.test.ts`：只在对应对话里滚动并高亮；别的对话、消息不存在时不动；请求等得住慢加载，另一个对话显示超过 10 秒后作废。
- 已知局限：同一条记忆被多次确认时，`sourceRefs` 累积但没存“哪个引用对应哪次”，所以跳到的是最早的那条消息，不一定是最近一次确认的那句；详情里“你说：‘……’”仍是各次的原话文字。
- 数据：生产和 Hermes 上的实际条数要用 `node scripts/operations/memory-source-report.mjs <product.sqlite>` 数出来。本 ADR 写成时没有跑过任何真实库，所以没有写入实测数字；跑过之后把结果追加到本节。

<a id="references"></a>

## 关联文档

- [ADR 0113：记忆历史事件与立场](0113-memory-history-events-and-stance.md)
- [产品愿景](../product-vision.md)

[返回目录](#contents)
