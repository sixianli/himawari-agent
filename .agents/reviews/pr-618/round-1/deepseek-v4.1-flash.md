## 复核结论

### 1. 高：压缩后，保留段里已经清理过的工具结果会恢复原文，清理状态没有任何持久化
- 文件:行：`packages/runtime-pi/src/tool-result-clearing.ts:85-93`；`packages/runtime-pi/src/pi-runtime-adapter.ts:1569-1573`；`packages/runtime-pi/test/tool-result-clearing.unit.test.ts:85-96`
- 问题：清理结果每次请求都从原始 `event.messages` 重算，不保存“已清过哪些”。遇到 `compactionSummary` 时把 `measured` 和 `sinceMeasured` 清空；保留段里旧消息的 `timestamp` 都早于 summary，`fresh` 为 false，其 usage 被忽略。于是压缩后的第一次请求没有可用的 `measured`，`evaluate()` 在 `:74` 直接返回，之前已换成占位的工具结果会原样发回原文。之后用量再超过清理线时又会被清一次，前缀再次变化。
- 证据：
  ```ts
  if (message.role === "compactionSummary") {
    compactedAt = timestampOf(message) ?? compactedAt;
    measured = undefined;
    sinceMeasured = 0;
    continue;
  }
  ```
  ```ts
  const fresh = compactedAt === undefined || (stamp !== undefined && stamp > compactedAt);
  ```
  单测 `does not trust token counts measured before a compaction` 正是断言这种情形下清理数为 0：
  ```ts
  clearedToolResultIds([summary, ...kept.map((m) => ({ ...m, timestamp: 0 }))], settings).size
  ).toBe(0);
  ```
  清理后没有写任何记录（材料也写明“不另存记录”），而设计规格 `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:327` 要求“清理……和压缩一样记一条记录”。缺少这条记录，无法在压缩后把“已清”状态带过边界。
- 建议：把已清理的 `toolCallId` 集合持久化（或按 spec 记录一次清理事件），压缩后对保留段继续套用；至少把保留段中已发过的占位视为不可逆，重新达到清理线时不得先恢复原文。补一条“压缩前已清、压缩后保留段仍为占位”的回归用例。若坚持不存记录，应修改 spec 并明确“压缩后保留段允许恢复原文”的代价。

### 2. 中：`preflight` 放行 `runtime_context`，但 `ProductionRuntimeTools.execute` 对同一行没有执行分支，两端校验不一致（I-73）
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:986-993`、`:1353-1357`；`apps/agent-service/src/production-tool-actions.ts:327-346`
- 问题：`tool_result_recall` 行登记为 `executor: "runtime_context"`，`preflight` 因为它等于 `RUNTIME_CONTEXT_EXECUTOR` 而放行；但真正走 `RuntimeToolPort.execute` 时，`#builtinExecutor(row)` 只认 `"owner_scoped"`，对 `runtime_context` 返回 `undefined`，随后 `reject()`。当前只有 `pi-runtime-adapter.ts:2252-2268` 在 `preflight` 后直接返回结果、绕开 `tools.execute`，所以正常路径没炸；任何其他按 `RuntimeToolPort` 契约“先 preflight、再 execute”的调用方（恢复、重放、后续新调用方）都会拿到“已批准但执行端拒绝”。
- 证据：
  ```ts
  (row.executor === RUNTIME_CONTEXT_EXECUTOR || this.#builtinExecutor(row) !== undefined)
  ```
  ```ts
  const row = this.#builtinRow(invocation);
  if (row) {
    const run = this.#builtinExecutor(row);
    if (!run) reject();
    return run(invocation, this.#ownerScopeGate(invocation, row, signal));
  }
  ```
- 建议：要么在 agent-service 的 `execute` 里为 `runtime_context` 明确拒绝并让 `preflight` 也拒绝（把“只能在运行层执行”写进契约），要么给该 executor 加显式处理；并加一条“preflight 放行 ⇒ execute 不会因缺 executor 抛错”的测试。

### 3. 中：`tool_result_recall` 自己的结果也会被清理，清理后的占位编号永远取不回
- 文件:行：`packages/runtime-pi/src/tool-result-clearing.ts:24-30`、`:75-81`、`:108-120`、`:152-157`；`packages/runtime-pi/src/pi-runtime-adapter.ts:1513-1519`
- 问题：`isToolResult` 接受所有 `toolResult`，`keepToolNames` 来自描述符的 `contextRetention: "keep"`，而 `tool_result_recall` 描述符没有这个字段，所以 recall 的结果也会在变老后换成占位。占位里写的是该 recall 调用自己的 `toolCallId`；但 `recallToolResult` 明确排除 `toolName === "tool_result_recall"` 的结果。结果就是占位写着一个永远查不到的编号，模型据此取回会得到“当前对话里没有……重新执行那次工具”，可能重复执行有代价或不可逆的原工具。
- 证据：
  ```ts
  ...(message as Partial<ToolResultMessage>).toolCallId === "string" && ...
  ```
  ```ts
  (result) => !cleared.has(result.id) && !settings.keepToolNames.has(result.name)
  ```
  ```ts
  message.toolCallId === id &&
  message.toolName !== TOOL_RESULT_RECALL_TOOL_NAME,
  ```
- 建议：要么让 recall 结果永不清（给 `RuntimeToolResultRecallDescriptor` 增加并传递 `contextRetention: "keep"`，或按工具名排除 `TOOL_RESULT_RECALL_TOOL_NAME`），要么允许按 recall 结果的编号继续取回同一段原文，或让占位指向原始工具结果的编号。补一条“recall 结果老化后的占位仍可取回”的反向/正向用例。

### 4. 中：ADR 0285 的“不清清单”在生产侧没有生产者，`contextRetention: "keep"` 只在测试里用过
- 文件:行：`packages/application/src/ports/intelligence.ts:443-446`；`packages/runtime-pi/src/pi-runtime-adapter.ts:1513-1519`；`apps/agent-service/src/production-memory-recall.ts:28-47`；ADRs `docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md` 第 8 条
- 问题（读代码证实 + 未核实）：清理算法只尊重描述符上的 `contextRetention: "keep"`，但全仓库只有 `prompt-prefix.compat.test.ts` 的 `PageTools` 设置它；生产描述符（包括 `memoryRecallDescriptor`）都没有设置。ADR 要求“计划、子线程结果、同意卡片、记忆快照不清”，当前仓库里这些工具尚未全部实现，无法确认将来会带 `keep`；至少现在没有任何代码或测试守住这条约束。只要将来新增同类工具时忘记加字段，它们就会被当普通工具结果清掉。
- 建议：把“不清”从可选字段变成明确契约：为 `tool-result-recall` 等类型定义默认保留，或在登记表层面标记 `contextRetention`，并在生产描述符测试里逐项断言。补一条用真实 `ProductionRuntimeTools.listAuthorized` 返回的“保留工具”验证 `keepToolNames` 的用例。

### 5. 中：自动检查没有覆盖材料点名的高风险路径，“追加后判断不变”的用例也不足以支撑作者的强断言
- 文件:行：`packages/runtime-pi/test/tool-result-clearing.unit.test.ts:71-83`；`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1516-1588`；`scripts/check-prompt-prefix.mjs:10-21`
- 问题：
  - `gives the same answer for an earlier request after more messages are appended` 追加的是 `assistant(60_000)`、`assistant(61_000)` 和单个 `call-5`，没有覆盖“追加后的新批次达到 5000 token、把前缀里原本保留的结果也清掉”的情形。作者“对同一段历史前缀，后面追加消息后，已清/未清判断不变”的说法在一般情形下不成立（新的成批清理本来就会改前缀，这是第 14 条的例外，但字面断言过强）。
  - 没有测试覆盖：没有 usage 的回答、出错/中止的回答、并行工具调用、续跑/审批恢复、压缩后的保留段；也没有测试验证 `ProductionRuntimeTools.preflight` 对 `runtime_context` 放行（compat 测试的 `PageTools.preflight` 永远返回 allowed，删掉 `production-runtime-tools.ts:989` 的特判不会让任何测试失败）。
- 证据：`findConversationBreak` 只在测试的后半段比较；单元测试的“同一前缀”用例只加低于清理线的结果：
  ```ts
  assistant(60_000),
  result("call-5", 4_000),
  assistant(61_000),
  user("再看看"),
  ```
- 建议：至少补四类反向/回归用例：无 usage 或错误回答后的重放；并行一批工具结果；带 `continuationRef` 的续跑；压缩后保留段的占位稳定性。再补一条直接调用 `ProductionRuntimeTools.preflight` 的用例，删掉 `runtime_context` 特判时必须失败。

### 6. 低：`context` 钩子没有 try/catch，清理抛错会让整次模型请求失败
- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:1569-1573`（对比 `:1555-1560` 的压缩钩子）
- 问题：`session_before_compact` 包了 `try/catch`，失败时退回 `undefined`；清理钩子直接调用 `clearToolResults`。`contentTokens` 假设每个内容块的 `text` 是字符串（`:51-57`），而 `isToolResult` 只校验 `content` 是数组不校验块结构；遇到异常消息（旧历史、Provider 非规范内容）时可能抛错，导致用户这一轮直接失败，而不是退回“不清理”。
- 建议：与压缩钩子一致，捕获异常并返回 `undefined`，同时把异常记录下来，不要阻断请求。

### 7. 低：规则文档、提示词元数据与实现不一致
- 文件:行：`.agents/instructions/prompt-prefix.md:36`；`packages/prompt-catalog/src/runtime.ts:296-303`；`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:327`
- 问题：
  - `prompt-prefix.md` 写“例外只有五种”，加入第 14 条后实际列了六种（6、7、12、14、ADR 0178、ADR 0193）。
  - `TOOL_RESULT_RECALL` 的 `usedBy` 写的是 `packages/runtime-pi/src/tool-result-clearing.ts`，实际使用点是 `pi-runtime-adapter.ts:2136`；`tool-result-clearing.ts` 只用了占位和 not-found 两条。
  - spec 要求“清理……记一条记录”，实现故意不记录，二者没有同步修改。
- 建议：改正“五种”为“六种”；修正 `usedBy`；要么补清理记录，要么修改 spec 明确记录需求取消，并在 ADR/kv-cache-guide 里写明为什么“重放”可以替代记录。

## 侧重检查

- **错误路径**：`recallToolResult` 对空串、非字符串、未知编号都返回固定 not-found（`tool-result-clearing.ts:148-163`），不会抛错；但 `context` 钩子整体没有兜底，见意见 6。
- **不合规范/不可信输入**：`toolCallId` 会 `trim()` 且只做精确匹配；schema 写了 `maxLength: 256`，但运行层没有强制，超长字符串只增加查找成本，不产生读取越权。recall 读取的是 `#activeSessions.get(request.runId)`（`pi-runtime-adapter.ts:2254`），按 runId 隔离，session 由当前 owner/agent/thread 的 projection 建出，未发现能读其他运行或其他对话的路径。
- **安全**：`tool_result_recall` 在 adapter 内执行，但先经过 `tools.preflight`（`pi-runtime-adapter.ts:2237-2268`）。它绕过 `ProductionRuntimeTools.execute`，因此不会重新走 `#markExternalContent`；不过 `ContextExternalContent.mark` 写的是 thread scope，`read(runId)` 同时读 thread 和 run（`context-external-content.ts:161-190`），原始工具执行时已经给该 thread 留下外来内容标记，所以“取回旧的外来结果”不会绕过已有的“读过外来内容”判断（读代码结论，未跑端到端）。
- **资源耗尽**：recall 可以把大块原文重新作为工具结果追加；清理保留最近 3 次、到压缩线再压缩，规模有界。`structuredClone` 会复制整段原文；清理每次请求对全部非工具消息重新 `JSON.stringify`，是 O(历史长度) 的 CPU 开销，没有无界状态。
- **不可撤销操作**：recall 和清理都是只读；清理只改发给模型的那份，历史原文仍在（材料说法，代码中 `captureHistory` 取 `session.messages`，见 `pi-runtime-adapter.ts:1855-1857`），没有发现新增不可撤销副作用。
- **未核实**：没有运行测试（工具限制），所以 `prompt-manifest.json` 的 sha256 是否正确、`npm run check:prompt-prefix` 是否通过、Pi 的 `context` 与 `context_with_system` 先后顺序、以及压缩摘要路径的真实字节一致性，均未实测；如果 `context` 钩子拿到的消息里带 system/tool 定义，`sinceMeasured` 会被放大，会进一步放大意见 1 的偏差。

## 必答问题

**1. 发给模型的内容是否仍然只在末尾追加？**
正常轮次是：工具定义和系统提示来自冻结 bundle，历史按原顺序，每轮会变的时间/状态仍放在最后一条用户消息；新增的 `tool_result_recall` 是固定文字，不引入每轮变化。改动带来的两个例外是：第 14 条允许的旧工具结果替换占位（这是设计中的例外），以及“新增工具导致老对话冻结工具集合换新一次”（规则第 6 条允许；如果按 ADR 0285 第 1 步先删除老对话则不会发生）。但意见 1 指出的“压缩后保留段恢复原文”不属于清晰允许的追加，也不属于当前清理动作本身，是额外的前缀变化。

**2. 同一段文字会不会在不同请求里变成不同字节？**
对同一份历史列表，占位文本只由 `toolName` 和 `toolCallId` 决定，输出按消息顺序套用，`Set` 只做成员判断，没有时间字段或不稳定排序；没有发现新的序列化不确定性。清理决策本身依赖历史总长度，这是设计允许的；但压缩后因为 `measured` 归零，之前已清的保留段会恢复原文、之后又可能重新清掉，这是实际存在的不稳定，见意见 1。另外“追加新批次达到 5000 token”会合法地新清前缀内容，作者“判断不变”的绝对说法不成立，但属于第 14 条例外。

**3. 有没有对应的自动检查，反向用例真的会失败？**
有：`tool-result-clearing.unit.test.ts` 和 `prompt-prefix.compat.test.ts` 的 `[CLEAR-1]` 到 `[CLEAR-5]`，`scripts/check-prompt-prefix.mjs` 把 `REQUIRED` 提到 17 并点名这些用例。CLEAR-3（不到 5000 不清）、CLEAR-4（声明保留的工具不清）以及单测里的 `REVERSE: never clears a tool that asks to keep its results` / `REVERSE: does not clear when ... less than the minimum`，如果删掉对应逻辑会失败；`does not trust token counts measured before a compaction` 也会在去掉 summary 重置时失败。缺口是：没有一条测试会让“删掉 preflight 的 `runtime_context` 特判”失败；没有覆盖无 usage/中止/并行/续跑/压缩保留段；也未能实际运行确认哈希与整套检查。

**4. 新值两端是否都被接受？**
- `definition: "tool-result-recall"`：加入 `RuntimeToolDescriptor` 联合类型（`intelligence.ts:409-416`），只有 `pi-runtime-adapter.ts:2132` 的 `toolDefinition` 和 `:2252` 的执行分支识别它，其他对 `definition` 的显式分支都不涉及它；类型上接受。
- `name: "tool_result_recall"`：`ToolActionRegistry.forTool` 能按精确名字找到新行（`production-tool-actions.ts:327-346`），`readOnlyRow` 也接受（family builtin、READ、sideEffect none）；`offer` 与测试的 `EVERY_TOOL_NAMES` 已更新。
- `capabilityRef: "context.tool_result_recall"`：登记表按 capability 唯一键能查到，`#builtinRow`/`preflight` 走 `forCapability`；`#exposed` 存的是执行句柄而不是 capabilityRef，所以 preflight 只检查 `has(runId)`，能通过。没有数据库约束读这个值（该工具不落 `capability_invocations`）。
- `executor: "runtime_context"`：preflight 接受，但 agent-service 的 `execute` 没有对应执行器，见意见 2；这是两端不一致的点。
- `contextRetention: "keep"`：类型和 adapter 过滤接受，但生产端没有生产者，见意见 4。
- 三个新提示词 id 已登记在 `prompt-manifest.json`；`TOOL_RESULT_RECALL` 的 `usedBy` 与实际引用不一致，见意见 7。sha256 是否正确未核实。
