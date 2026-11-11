## 发现（按严重度从高到低）

### 1. 中：给冻结的 `gateway.v2` 快照增加必填字段，会造成新旧前端/后端互不兼容

- **文件:行**：`packages/gateway-contracts/src/contracts-v2.ts:1243`、`packages/gateway-contracts/src/validation.ts:174-180`、`apps/control-center/src/gateway-client.ts:268-271`
- **问题**：`undoable` 是新增的**必填**字段；而契约解析器对未知字段和缺失必填字段都直接失败。新后端 + 已打开的旧网页会因旧前端不认识 `undoable` 而整个 `memory.overview.snapshot` 解析失败；反过来，新前端 + 旧后端会因缺字段失败。仓库里已有“生产服务端升级了、旧前端没更新”的事故先例（`docs/engineering-casebook.md:777-781`），这不是理论风险。
- **证据（已读代码）**：
  - `contracts-v2.ts:1243`：`undoable: booleanValue,`
  - `validation.ts:174-175`：`if (!expectedKeySet.has(key)) fail(... "unknown field");`
  - `validation.ts:180`：`if (!Object.hasOwn(record, key)) fail(... "missing required field");`
  - `gateway-client.ts:268-271`：响应体确实用 `gatewayV2MessageSchema.parse(value)` 严格解析。
- **推测**：如果发布流程保证静态资源与后端同版本切换，并且旧标签页会立即刷新，影响可缩小到部署窗口；否则用户打开记忆页会直接报错，直到刷新拿到新前端。
- **建议**：不要往既有冻结快照加必填字段；用新的快照/查询版本（例如 `memory.overview.read.v2` 或单独的整理撤销能力查询），或至少把“前端资源与后端必须同版本、旧页面必须重载”写进发布门槛并验证。仅把字段改成可选并不能解决旧前端拒绝未知字段的问题。

### 2. 中：真正的服务端组装点没有自动检查

- **文件:行**：`apps/agent-service/src/production-memory-control.ts:679`；`test/integration/memory-consolidation.test.ts:660-663`；`apps/control-center/test/memory-interactions.unit.test.ts:1274-1310`
- **问题**：新增测试分别验证了纯函数和“把 `undoable: false` 塞给前端”，但没有测试 `ProductionMemoryControl.query()` 是否真的把正确记录传给 `isConsolidationUndoable`。如果把 `touched.get(change.memoryId)` 写错成相关记忆、或恒为 `undefined`、或恒为 `true`，现有测试都不会失败。
- **证据（已读代码）**：
  - 生产组装点只有一处：`undoable: isConsolidationUndoable(change, touched.get(change.memoryId)),`
  - 集成测试只测函数：`expect(isConsolidationUndoable(reflect, insight)).toBe(true);`、`expect(isConsolidationUndoable(reflect, await resource.read(reflect.memoryId))).toBe(false);`
  - 网页测试直接喂固定值：`undoable: false` / `undoable: true`。
  - 我在 `apps/agent-service/test/` 中未找到对 `memory.overview.read` 返回的 `tidyUps[].undoable` 的断言；`production-memory-consolidation.unit.test.ts` 全文件 118 行也没有覆盖概览。
- **建议**：增加一条经过 `ProductionMemoryControl` 的集成/契约用例：整理后查询概览断言 `undoable: true`；手动改记忆后再查断言 `undoable: false`，并断言此时点击撤销返回 `MEMORY_CHANGED_AFTER_CONSOLIDATION`。这样反向用例才会真正覆盖线上路径。

### 3. 低：按钮仍可能失败，提示语把失败原因说成唯一的“之后又改过”

- **文件:行**：`packages/memory-engine/src/consolidation.ts:443-451`；`apps/agent-service/src/production-memory-control.ts:679`；`apps/control-center/src/components/memory-page.tsx:1855-1856`
- **问题**：概览里的 `undoable` 是查询时的快照；用户点击时后端会重新读取。除了“之后被改过”，撤销还可能因为 generation 不存在、并发 revision 变化、并发撤销而在点击时失败。界面只显示“这条记忆之后又改过，不能撤销”，这会把其他错误原因也说错。
- **证据（已读代码）**：
  - `undo` 重新读取：`const memory = await this.#options.state.read(change.memoryId);`
  - generation 缺失会抛 `NOT_FOUND`：`if (!generationId) throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Memory generation not found");`
  - 概览在更早的时间点计算 `undoable`，没有点击时复核。
- **推测**：generation 缺失对正常记忆很少见；并发变化是实际可能发生的窄窗口。
- **建议**：保留后端校验是正确的；在撤销失败返回 `MEMORY_CHANGED_AFTER_CONSOLIDATION` 时刷新概览并给出对应提示；若要让提示更准确，可把 `undoable` 改成带原因的枚举而不是布尔值。若只是快照过期，不要把它描述成“曾经被编辑过”。

### 4. 低：ADR 0220 的按钮条件与代码不一致

- **文件:行**：`docs/adr/0220-consolidation-conflicts-wait-for-the-owner.md:59`；`apps/control-center/src/components/memory-page.tsx:1788-1792`
- **问题**：ADR 写“只有新条还在待确认时才给「撤销」按钮”，代码现在的条件实际是“未撤销且当前 revision 仍等于整理后的 revision”；对 `hold` 来说，如果在待确认期间主人改过正文，按钮会被隐藏，而 ADR 的表述会让人以为仍应显示。
- **证据（已读代码）**：
  - ADR 第 59 行：`只有新条还在待确认时才给「撤销」按钮。`
  - 代码：`...(!item.undone && !item.undoable ? { locked: true } : ...)`
- **建议**：更新 ADR 或相关记忆页说明，明确“能否撤销由后端 `afterRevision` 与当前 revision 决定”，并记录新增的 `undoable` 字段和 `memory.undoLocked` 文案。

## 已由代码证实 / 推测分开

**已由代码证实：**
- 新函数和 `undo` 使用同一判断，`undo` 的原有权限/冲突检查没有被放宽。
- 概览组装点只有 `production-memory-control.ts:679` 一处；字段通过 `booleanValue` 校验。
- 新 i18n message id 已加入 `MESSAGE_IDS`，英/日/中三份资源都有对应文案。
- 前端渲染顺序是“已撤销”优先于“锁定”，再才是撤销按钮；已有撤销标签不会被锁定文案覆盖。
- 本次 diff 没有改动提示词目录、系统提示、工具定义、历史消息或出口遮盖相关代码。

**推测 / 未核实：**
- 生产部署是否会让旧标签页立即失效，以及静态资源是否与后端原子更新：未核实。
- 生产环境中 generation 缺失导致撤销失败的概率：未核实。
- 作者声称的“27 个测试全过、typecheck、lint 通过”：本次只允许读文件和 git 命令，**未核实**，未实际运行。

## 侧重检查

- **错误路径**：`undo` 的 revision 冲突、generation 缺失、并发 `markUndone` 路径都读过了；新代码没有放松后端校验，锁定只是 UI 层。残留失败路径见问题 3。
- **不合规范/不可信输入**：`undoable` 是服务端由数据库记录计算出的布尔值，网关 schema 会校验类型；没有新增外部输入入口。
- **安全**：没有新增权限判断或绕过；隐藏按钮不等于绕过后端，后端仍会拒绝不可撤销操作。没有新增敏感文本输出。
- **资源耗尽**：`tidyUps` 上限 `TIDY_UPS_SHOWN = 30`，新增的 `readMany` 最多读取约 60 个 id，远低于 1000 的硬上限，没有新增无界循环。
- **不可撤销操作**：本次没有新增不可撤销写操作；相反是减少注定失败的撤销尝试。
- **规则/文档一致性**：提示词前缀规则不受影响；ADR 0220 的按钮条件描述已过时，见问题 4。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。diff 只涉及 memory-engine 的撤销判断、agent-service 的记忆概览、gateway 快照、网页/i18n/测试；没有改动系统提示、工具定义、历史消息、遮盖或提示词目录。`isConsolidationUndoable` 只被 `consolidation.ts:444` 和 `production-memory-control.ts:679` 使用；`memory.overview.read` 是控制中心读模型，不是发给模型的请求内容。因此仍然是“只在末尾追加”的模型请求路径，每轮变化值仍只在最后一条用户消息里。未运行 `check:prompt-prefix`，结论来自 diff 和调用点阅读。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对发给模型的内容不会。新增的 `undoable` 虽然会随记忆当前 revision 变化，但它只出现在网页用的网关快照中，不参与提示词序列化、遮盖或历史保存，也没有依赖前后文的遮盖逻辑。网关快照本身跨请求会因记忆状态变化而不同，这是预期的 UI 数据变化，不是模型输入字节变化。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有，但不完整。新增的网页单测能验证“不可撤销时不显示按钮并显示原因”，去掉锁定分支会失败；新增的集成测试验证 `isConsolidationUndoable` 在确认后和记忆缺失时为 false；契约 fixture 也补了字段。缺口是：没有任何测试走 `ProductionMemoryControl.query()` 验证线上实际组装出的 `undoable`，因此服务端接错参数不会被发现。反向用例只覆盖了纯函数和前端 fixture，没有覆盖真实概览路径。

4. **改动产生/修改的每个值，每个使用点都能接受吗？**
   - `undoable`：产生于 `production-memory-control.ts:679`，由 `contracts-v2.ts:1243` 校验为布尔值，由 `memory-page.tsx:1788` 读取为 `!item.undoable`；类型和值本身两端都能接受。主要风险是既有的严格契约兼容性，见问题 1。
   - `memory.undoLocked`：产生于 `message-ids.ts:621`，三份资源 `en.ts:686`、`ja.ts:693`、`zh-CN.ts:644` 都有，网页在 `memory-page.tsx:1856` 使用，使用点能接受。
   - `locked`：只在 `memory-page.tsx` 内部产生和消费，类型已加入。
   - `isConsolidationUndoable`：通过 `packages/memory-engine/src/index.ts:8` 的 `export *` 暴露，agent-service 的导入能解析。
   - 没有发现其他生产 `tidyUps` 生产者遗漏；现有空数组 fixture 不受影响。
