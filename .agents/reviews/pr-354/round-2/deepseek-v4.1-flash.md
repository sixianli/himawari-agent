# PR 354 第 2 轮复核结论

说明：本轮工具已停止调用。下面把「读代码证实」与「推测/未核实」分开。`.agents/reviews/pr-354/round-1/judgments.md` 在当前检出中读不到（`read` 返回 File not found，`git show` 被拒），Pi 1.5.0 的 `node_modules` 源码也不在检出里，因此这两处标「未核实」。

## 读代码证实的问题

### 低 — `packages/runtime-pi/test/tool-batch-state.unit.test.ts:114-134`

**问题：** 新用例的「激活且并行」分支不是直接断言 `parallel === true`，而是依赖 `completedResults` 数量不匹配抛 `PI_CONTINUATION_RESULTS_INVALID`。这能覆盖目标逻辑，但错误码与被测分支不是一一对应，未来 `checkedBatch` 校验改动时可能给出误导性失败。

**证据：**
- `pi-tool-batch-continuation.ts:120-133`：`completedResults.length !== (parallel ? 0 : waitingIndex)` 才抛 `PI_CONTINUATION_RESULTS_INVALID`。
- 测试 `tool-batch-state.unit.test.ts:125-133`：激活分支只写 `expect(() => capturePiToolBatch(active, ...)).toThrow("PI_CONTINUATION_RESULTS_INVALID")`。
- 反过来说，它确实能防住第 1 轮的问题：若实现忽略 `getActiveToolNames`，`inactive` 分支会变成并行并抛错，`:124` 的 `expect(...).toBeUndefined()` 会失败。

**建议：** 保留该用例，另加一条不依赖结果数量的直接断言，例如构造无已完成结果的 assistant 后断言 `capturePiToolBatch(active, ...).parallel === true`，让失败原因更精确。

### 低 — `packages/runtime-pi/src/pi-tool-batch-continuation.ts:75-79`

**问题：** 新实现把「名字是否活动」和「定义是否存在」拆成两次查询；只有在 Pi 的 `agent.state.tools` 与 `_toolDefinitions` 不一致时，才会与旧逻辑不同。生产代码没有中途改工具集，所以当前等价；这是边界风险，不是已发生的缺陷。

**证据：**
- `:75` `const active = new Set(session.getActiveToolNames());`
- `:79` `const tool = active.has(call.name) ? session.getToolDefinition(call.name) : undefined;`
- 旧逻辑是按 `session.agent.state.tools.find(({ name }) => name === call.name)` 直接取活动包装对象。
- 仓库内 grep 未发现 `setActiveToolsByName`，`pi-runtime-adapter.ts:1561` 一次性传入 `tools: descriptors.map(({ name }) => name)`。

**建议：** 在注释或 ADR 前提里明确「活动集合与定义注册表由 Pi 以同一份工具定义维护」；若将来允许运行时增删工具，需要重新评估这里。

## 未核实 / 推测的问题

### 中（未核实）— `packages/runtime-pi/src/pi-tool-batch-continuation.ts:75-79`

**问题：** `getActiveToolNames()` 被无条件调用。若锁定版本 Pi 1.5.0 没有这个方法，所有工具批次保存/恢复都会在运行时抛 `TypeError`，而不是受控的 `PI_CONTINUATION_*` 错误。作者声称已在 `dist/core/agent-session.js:1100` 核实，但当前检出没有 `node_modules/@earendil-works/pi-coding-agent`，无法独立确认。

**证据：**
- `packages/runtime-pi/package.json:11` 锁定 `"@earendil-works/pi-coding-agent": "1.5.0"`。
- 检出为稀疏检出（`git status` 提示 `78% of tracked files present`），`glob **/agent-session.*` 无结果。
- ADR 0204 前提 3 与作者简报都引用第 1100-1101 行，但属于作者自述。

**建议：** 合入前在完整依赖环境跑一次 `packages/runtime-pi/test/pi-tool-batch-continuation.compat.test.ts`（它用真实 Pi），或贴出该源码片段作为证据。类型层面若 `AgentSession` 不含该方法，`tsc` 也会失败，应把 `typecheck` 结果作为门槛。

### 低（未核实）— `.agents/reviews/pr-354/round-1/judgments.md`

**问题：** 无法读取第 1 轮裁决原文，不能确认本轮测试是否完全覆盖了第 1 轮的具体反对意见，只能按作者描述和代码推断。

**建议：** 复核记录应随代码一起可读；否则下一轮无法核对「意见是否真的处理了」。

## 侧重检查

- **错误路径：** `runsInParallel` 在工具名不活动或定义缺失时返回 `false`，随后 `checkedBatch` 对顺序批次要求 `completedResults.length === waitingIndex`。并行批次误判为顺序、或顺序误判为并行，都会抛 `PI_CONTINUATION_RESULTS_INVALID`，属于失败关闭，不会静默跳过结果。未见新的静默错误路径。
- **不合规范/不可信输入：** `call.name` 来自模型。新代码用 `Set.has` 和 `Map` 风格 `getToolDefinition` 查询，没有拼接、原型链或注入风险；旧代码是数组 `find`，安全性相当。
- **安全：** 本改动不涉及凭据、出口遮盖或权限判断，不改变审批语义。
- **资源耗尽：** 每次调用构造一个活动工具名 `Set`，规模等于工具数，可忽略。
- **不可撤销操作：** 本改动只影响批次分类与校验，不直接触发外部副作用；分类错误只会让保存/恢复失败，不会让未完成结果被当成已完成。
- **规则/文档一致性：** ADR 0204 决定第 2 条、前提 3/4、`docs/pi-development-guide.md` 的 D5 行都已同步成「先查 `getActiveToolNames` 再取 `getToolDefinition`」，与代码一致。前提 4「和原来只在活动工具里找完全一致」的成立依赖 Pi 源码中「活动工具包装对象的 `executionMode` 等于定义里的 `executionMode`」，该源码未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   本轮增量（`getActiveToolNames` 判断）不参与请求组装，只影响工具批次的 `parallel` 分类和校验，因此不会改变系统提示、工具定义、历史消息或遮盖结果，发给模型的内容仍然只在末尾追加。`session.messages` 的两处使用来自上一轮（`pi-runtime-adapter.ts:1680`、`:1700`），ADR 说它等于 `agent.state.messages`，但 Pi 源码未核实。兼容测试 `pi-tool-batch-continuation.compat.test.ts:168-171` 断言后一次请求的 transcript 前缀与前一次逐字节相同，可作为该路径的旁证。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。本轮没有改序列化、遮盖、时间字段或列表顺序；`Set` 只用于成员判断，不输出、不排序、不写盘。`PiToolBatchContinuation` 的持久化格式和版本仍为 v3，`parallel` 仍是可选布尔。

3. **有没有对应的自动检查，反向用例会真的失败吗？**
   有。新增用例 `tool-batch-state.unit.test.ts:114-134` 覆盖「注册但未激活的并行工具按顺序处理」；若实现退回只查 `getToolDefinition`，`:124` 会失败；若实现恒返回并行，同样会失败。真实 Pi 的并行/顺序恢复由 `pi-tool-batch-continuation.compat.test.ts:181-310` 覆盖，其中 `restorePiToolBatch(sequential, ...)` 期望 `PI_CONTINUATION_PARALLEL_BATCH_INVALID`。缺口：没有真实 Pi 的「注册但未激活」用例，新用例用的是假会话；也没有单独断言 Pi 1.5.0 暴露 `getActiveToolNames` 的测试（只能靠 compat 运行时暴露）。

4. **改动产生或修改的每个值，使用方都能接受吗？**
   - 新增依赖 `getActiveToolNames`：只被 `runsInParallel` 使用（`:75`），生产调用方是 `pi-runtime-adapter.ts:1536`（保存批次）和 `:1618`（恢复批次），均传入真实 Pi 会话；类型为 `Pick<AgentSession, ...>`，非导出类型。
   - `parallel` 值：产生于 `:62`，被 `checkedBatch`（`:104-146`）、`restorePiToolBatch`（`:163`）和持久化快照使用；语义未变，使用方都能接受。
   - `session.messages`：来自上一轮改动，使用于 `pi-tool-batch-continuation.ts:38`、`pi-runtime-adapter.ts:1680`/`:1700`/`2006`；当前测试假会话已加 getter。
   - `pi-runtime-adapter.compat.test.ts:411-456` 的假会话没有 `getActiveToolNames`/`getToolDefinition`，但该假会话也没有 `sessionManager`，我读到的续跑用例（`:2580`、`:3077`、`:3167`）都用真实 Pi；未逐个核实全部续跑用例是否还有基于假会话的路径，标「未核实」。
   - 持久化格式没有字段变更，不需要迁移。
