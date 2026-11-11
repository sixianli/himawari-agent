# 复核报告：PR「记忆改过后不再显示注定失败的撤销按钮」(678bf3a)

先说核对结果：作者的说法与代码基本一致（问题真实、做法如描述、无迁移、无模型请求改动），以下按严重度列出发现。

---

## 发现（按严重度从高到低）

### 1.（中低）`undoable` 的生产端没有任何自动化检查——I-73 的教训在此重演

- **文件**：apps/agent-service/src/production-memory-control.ts:679
- **问题**：`undoable` 的取值在测试里只被“消费端”和“引擎端”覆盖，唯独“生产端”没有：
  - 网页测试用的是手写 mock 数据（apps/control-center/test/memory-interactions.unit.test.ts:1274 起，`undoable: false` 是测试自己编的）；
  - 集成测试只测引擎（test/integration/memory-consolidation.test.ts:657-666 直接调 `isConsolidationUndoable` 和 `consolidation.undo`），**从未读取过 overview 里的 tidyUps**（该文件 grep `tidyUps|overview\.read` 无结果）；
  - agent-service 自己的测试也没有任何用例发 `memory.overview.read`（apps/agent-service/test 下 grep 无结果），更没有像 production-observation.ts:307/400 那样把产出的 snapshot 过一遍 `gatewayV2MessageSchema.parse`。
- **证据**：`undoable: isConsolidationUndoable(change, touched.get(change.memoryId))`（production-memory-control.ts:679）。如果这行写错（比如取成 `relatedMemoryId`、或漏传 `touched`），现有测试一条都不会失败。这正是 I-73（docs/incidents-and-gates.md:112）点名的问题：“双模型复核只看了 diff，没问清单里的 id 能通过后端校验吗”。
- **建议**：在 test/integration/memory-consolidation.test.ts（或 production-memory-capture.test.ts）加一段：整理 → 读 overview → 断言 `tidyUps[].undoable === true` → 改记忆（confirm）→ 再读 → 断言 `false`，并让产出的 snapshot 过 `gatewayV2MessageSchema.parse`。

### 2.（低）`undoable: true` 并不保证撤销成功，按钮仍可能失败

- **文件**：packages/memory-engine/src/consolidation.ts:449-451
- **证据**：undo 在 `isConsolidationUndoable` 通过之后还要 `generationFor(memory.id)`，取不到就抛 `NOT_FOUND "Memory generation not found"`；而生产注入的 `generationFor` 是 `(await consolidationJobs.listByMemory(memoryId)).at(-1)?.generationId`（apps/agent-service/src/service-main.ts:1489-1490），可能为 undefined。另外概览快照和点击之间有竞争窗口，用户改了记忆后 `undoable` 已过期，点击仍报 MEMORY_CHANGED_AFTER_CONSOLIDATION。
- **影响**：小；前一类是存量问题（改造前按钮也可能这样失败），后一类 UI 无法根治，但锁定文案单向承诺“不能撤销”，没有承诺“能撤销”的一侧。可不改，建议知悉即可。

### 3.（低，属仓库既有模式）合约严格校验使任何版本错配都会整页失效

- **文件**：packages/gateway-contracts/src/validation.ts:174-180
- **证据**：`object()` 对未知字段报 `unknown field`、缺失字段报 `missing required field`，双向都拒。因此旧 agent-service + 新 control-center（缺字段）和旧 control-center + 新 agent-service（多字段）都会让整个 `memory.overview.snapshot` 解析失败，进而 memory.ts:100-101 `setFailed(true)`——**整页记忆功能失效，而不只是这个按钮**。控制中心是网页端，浏览器缓存的旧版页面配上新后端即触发后者。
- **说明**：同仓 b840662 已用同样方式加过字段，属既定取舍；但值得留意 control-center 与 agent-service 必须（近乎）同时上线，兼容 fixture（gateway-v2.fixture.ts:1089-1105 的 `compatibilityMessages`）在这里帮不上忙。

### 4.（信息）作者对问题陈述有一处小的不准确

- 作者说“每条未撤销的整理改动都显示撤销按钮”。读基准代码（memory-page.tsx 旧 1787-1789 行：`item.action === "hold" && !waiting.has(...) ? {} : { undo }`）可见：`hold` 且已不再待确认的条目在旧版就**没有**撤销按钮。准确说法是“每条非 hold 的未撤销条目、以及仍待确认的 hold 条目”才显示。不影响结论。

### 做得好的点（读代码证实）

- `isConsolidationUndoable`（consolidation.ts:36-43）与 undo 判断（:444）共用同一谓词，显示与能力不会分叉；undefined 记忆与修订不匹配都归为不可撤销，与 undo 的报错分支（:443-448）一一对应。
- 合约 fixture 补了 `undoable: true` 并参与 round-trip 测试（gateway-v2.contract.test.ts:34-46）；由于 fixture 带上了该字段，若有人从 schema 里删掉它，round-trip 会报 unknown field 反向失败。
- UI 测试 [P3-8-undo] 同时覆盖：不可撤销无按钮+原因文案、可撤销有按钮、已撤销条目不显示原因文案（memory-interactions.unit.test.ts:1267-1323），用基准代码跑会失败（旧逻辑会给 tidy-edited 渲染撤销按钮），是真反向用例。
- i18n 三语言 + message-ids 有完整性门槛（i18n-runtime.unit.test.ts:63-69），新增 `memory.undoLocked` 三处都补齐。
- hold 条目在等待确认时逻辑保持原行为（revision 未变则 `undoable` 为 true，仍走原撤销）；等待中但记忆被改过时从“显示注定失败的撤销”变为锁定，与后端行为一致。

---

## 侧重检查：一条普通流程从入口到结束

流程：打开记忆页 → `useMemory` 发 `memory.overview.read`（apps/control-center/src/memory.ts:91-96）→ control-center 网关客户端 schema 校验（gateway-client.ts:269）→ agent-service in-process-gateway.ts:35 校验请求 → `ProductionMemoryControl.query` 组装 tidyUps 含 `undoable`（production-memory-control.ts:667-681）→ TimelineTab 计算 locked/undo（memory-page.tsx:1788-1792）→ 渲染按钮或原因（:1853-1861）→ 点击撤销 → `memory.tidy.undo`（memory.ts:201）→ `ProductionMemoryControl.execute`（production-memory-control.ts:1157-1172，含 changeId 归属校验 :1165-1169）→ `MemoryConsolidationService.undo`（consolidation.ts:437-471）。

- **有覆盖**：引擎 undo 与谓词（集成）、UI 渲染（单测，mock 数据）、合约 schema（fixture round-trip）、i18n。
- **无覆盖**：① tidyUps 组装这段（发现 1）；② `memory.tidy.undo` 命令经 `ProductionMemoryControl.execute` 的整段（test/ 与 apps/agent-service/test 下 grep `tidy\.undo` 均无结果，存量缺口，非本 PR 引入）；③ 产出 snapshot 过合约校验（发现 1）。
- **文档一致性**：docs/ 无任何提到 tidyUps/undoable/该行为的条目（grep 无结果），无需更新；prompt-prefix 规则未触及。

**未核实**：作者称“27 个测试文件全过、typecheck、lint 通过”——本次环境不允许运行命令，仅能确认上述测试存在且逻辑上会拦截对应回归。

---

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。改动文件全部是记忆概览的 UI 数据链路（agent-service 的 `memory.overview.read` 查询、gateway 合约、control-center 网页）和记忆引擎的 undo 判断；grep 证实 `memory.overview.read`/tidyUps 只被 control-center 消费，从未进入提示组装、工具定义、历史或遮盖。发给模型的内容未被触碰，追加性不受影响。
2. **同一段文字会不会在不同请求里变成不同字节？** 该改动不产生进入模型请求的内容，不存在此问题。`undoable` 确实随数据库状态在两次请求间变化，但它只发给浏览器（UI 数据），且序列化键序由 schema 形状固定（validation.ts:178-183），字节确定。
3. **有没有对应的自动检查、反向用例会不会失败？** 有三层：引擎集成测试（断言谓词翻转 + 存量的 undo 拒绝用例）、UI 单测（对基准代码会失败）、合约 fixture round-trip（删字段会反向失败）。缺口在**生产端取值**（发现 1）和 `memory.tidy.undo` 命令路径（存量）。
4. **每个产生/使用的值两端都能接受吗？** `undoable`：产生于 production-memory-control.ts:679（boolean），合约校验 contracts-v2.ts:1243（booleanValue，必须存在、无多余字段），消费于 memory-page.tsx:1788（经 gateway-client 解析后必为 boolean）。两端一致。`isConsolidationUndoable` 由 memory-engine index.ts:8 导出，undo 与概览共用，单一事实来源。遗留：`undoable: true` 不排除 generation 缺失导致的撤销失败（发现 2）。
