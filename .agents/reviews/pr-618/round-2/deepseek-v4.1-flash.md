本次复核范围：先看增量 `63a146b9..8d718ef5`（实际只动了 5 个源码/文档文件，另有第 1 轮复核记录），再顺着证据读到 `production-runtime-tools.ts`、`production-tool-actions.ts`、`production-context-recall.ts`、`compaction-prefix.ts`、`pi-runtime-adapter.ts`、`prompt-catalog`、相关测试和 ADR/设计文档。没有重新整份复核增量没碰的旧代码。

**上一轮意见逐条核对**

- 意见 3（取回工具自己的结果也会被清理）：**已改好**。`recallToolResult` 现在会找到 `tool_result_recall` 自己的结果：只要那条不是失败（`isError` 为假）就返回它的内容，失败才回“找不到”（`packages/runtime-pi/src/tool-result-clearing.ts:160`）。新增的单测在旧代码下会失败（旧代码按 `toolName !== RECALL` 排除，返回 `found=false`）。
- 意见 4（`contextRetention: "keep"` 没有生产生产者）：**仍未改好**，见下面意见 1。
- 意见 6（`context` 钩子没有 try/catch）：**只改了一半**。增量让不规范的工具结果内容不再抛错，但钩子本身仍没有兜底，见意见 2。
- 意见 7（文档/元数据与实现不一致）：**部分改好**。`usedBy` 已从 `tool-result-clearing.ts` 改到 `pi-runtime-adapter.ts`，规则第 4 条“五种→六种”和设计文档的相关段已更新；但仍有残留，见意见 5。

增量本身没有发现新的直接代码错误；下面问题主要是上一轮未落实项和增量带出的使用端/文档问题。

### 1. 中高：`contextRetention: "keep"` 仍只有测试在设置，ADR 0285 的“不清清单”在生产侧没有落点（上一轮意见 4 未修好）

文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:1513`；`packages/application/src/ports/intelligence.ts:446`；`docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:42`

问题：`keepToolNames` 是用本轮描述符里 `contextRetention === "keep"` 的项算出来的，但全仓库只有测试 `prompt-prefix.compat.test.ts:1475` 会写这个字段；生产侧 `managedTaskDescriptors`、感知、提醒、规则等描述符都没有写。于是生产里 `keepToolNames` 永远是空集。ADR 0285 第 8 条声称“计划、子线程结果、同意卡片和记忆快照不清”，设计文档也写了“这些工具的描述符写上 `contextRetention: "keep"`”，但没有任何生产者，这个保证在代码里不存在。

证据：
- `pi-runtime-adapter.ts:1513-1520`：`keepToolNames: new Set(descriptors.filter((descriptor) => "contextRetention" in descriptor && descriptor.contextRetention === "keep").map(...))`
- `intelligence.ts:446`：`readonly contextRetention?: "keep";`
- 全仓搜索 `contextRetention` 只有：类型定义、适配器消费、测试 `prompt-prefix.compat.test.ts:1475`（`this.#keepSearch ? { contextRetention: "keep" as const } : {}`）和单测里的假工具名 `plan_update`。生产工具描述符没有任何一处设置它。
- ADR 0285:42：`…能按编号取回；计划、子线程结果、同意卡片和记忆快照不清。`

已证实：生产路径上 `keepToolNames` 恒为空，`contextRetention` 分支只在测试里被跑到。
推测：一旦以后把“子线程结果/计划”做成工具结果但没有同时加 `contextRetention`，它们会被当普通旧结果清掉，只能靠 `tool_result_recall` 找回；且 `keep` 判断依赖“当前这轮描述符”而不是产生结果时的工具声明，工具在下一次运行不再提供时旧结果也会被清。

建议：要么在这一批给已有的“计划/子线程结果/同意卡片”描述符真正加上 `contextRetention: "keep"` 并补一条生产侧测试（从 `ProductionRuntimeTools.listAuthorized` 走一遍，断言某工具结果变老也不清）；要么把 ADR 0285 和设计文档改为“将来做这些工具时再加”，不要让规则文档读起来像已经保证。

### 2. 中低：`context` 钩子仍然没有 try/catch，清理一旦抛错会让整次模型请求失败（上一轮意见 6 只修了一半）

文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:1569`

问题：增量在 `blockTokens` 里处理了 `null` 和非文本块，避免了一类抛错；但 `himawari-tool-result-clearing` 的 `context` 钩子本身没有 try/catch，而同一文件里的压缩钩子有。`messageTokens` 对非 `toolResult` 消息仍会 `JSON.stringify(message)`，任何不可序列化的值（例如循环引用、BigInt）或 `renderPrompt` 出错都会让这次模型请求直接失败，而不是跳过清理。

证据：
- `pi-runtime-adapter.ts:1569-1573`：
  `pi.on("context", (event) => { if (!clearing) return undefined; const messages = clearToolResults(event.messages, clearing); return messages ? { messages } : undefined; });`
- 对照 `pi-runtime-adapter.ts:1555-1560` 的压缩钩子有 `try { compactionPrefix = compactionPrefixMessages(event, clearing); } catch { compactionPrefix = undefined; }`。
- `tool-result-clearing.ts:63-66`：`return approximateTokens(JSON.stringify(message) ?? "");`

已证实：清理钩子没有兜底；增量只覆盖了工具内容块不规范的情况。
推测：真实 Pi 消息是否会出现循环引用/BigInt 未验证；概率低，但一次抛错就是整轮失败，和压缩钩子的容错策略不一致。

建议：像压缩钩子一样把 `clearToolResults` 包在 `try/catch` 里，出错就 `return undefined`（退回不清理），保证清理永远不能阻断模型请求。

### 3. 中低：`runtime_context` 的放行与 agent-service 的 `execute` 契约不一致，且这条路径没有自动检查（I-73/Q3/Q4）

文件:行：`apps/agent-service/src/production-runtime-tools.ts:989`；`apps/agent-service/src/production-runtime-tools.ts:1353`；`packages/runtime-pi/src/pi-runtime-adapter.ts:2252`

问题：新能力 `context.tool_result_recall` 登记为 `executor: "runtime_context"`，preflight 专门放行它；但 `ProductionRuntimeTools.execute` 的内置行要求 `#builtinExecutor(row)` 不为空，而 `#builtinExecutor` 只认 `owner_scoped`，所以如果真的走到 agent-service 的 `execute`，会 `reject()`。实际能跑是因为 Pi 适配器在 `preflight` 之后、调用 `execute` 之前自己拦下了 `definition === "tool-result-recall"`。这条“只由运行层执行”的契约没有被任何测试锁住：agent-service 单测只断言描述符名字和快照，`runtime_context`/`context.tool_result_recall` 在 `apps/agent-service/test` 里搜不到对 preflight 的调用；prompt-prefix 集成测试用的假端口 `preflight` 恒为 `allowed: true`。

证据：
- `production-runtime-tools.ts:986-990`：`allowed: this.#exposed.has(...) && (row.executor === RUNTIME_CONTEXT_EXECUTOR || this.#builtinExecutor(row) !== undefined) && …`
- `production-runtime-tools.ts:681`：`if (row.executor !== "owner_scoped") return undefined;`
- `production-runtime-tools.ts:1353-1357`：`const row = this.#builtinRow(invocation); if (row) { const run = this.#builtinExecutor(row); if (!run) reject(); … }`
- `pi-runtime-adapter.ts:2252-2268` 在 `preflight` 之后直接返回 recall 结果，绕开了 `this.#dependencies.tools.execute`。
- `packages/runtime-pi/test/prompt-prefix.compat.test.ts:178-180`：`async preflight() { return { allowed: true, … }; }`

已证实：生产实现在适配器侧绕行；agent-service 的 preflight 放行没有测试覆盖。
推测：换一个不是 Pi 的运行时实现，或以后有人改成统一走 `execute`，`tool_result_recall` 会先被发出去、执行时却拒绝；此外若有人误删 `row.executor === RUNTIME_CONTEXT_EXECUTOR`，现有测试不会失败。

建议：补一条 agent-service 单测，用真实 `ProductionRuntimeTools` 对 `capabilityRef: "context.tool_result_recall"` 调 `preflight` 断言 allowed，并断言 `execute` 明确拒绝（或在接口上显式声明“运行层独占执行”，让 `execute` 走专门分支而不是靠 `reject`）；再补一条反向用例，删掉放行条件时该测试必须失败。

### 4. 低：新增 `tool_result_recall` 会改变所有已有对话的工具集合，触发一次冻结头重建，材料和 ADR 没写明这次一次性失效

文件:行：`apps/agent-service/src/production-runtime-tools.ts:611`；`packages/runtime-pi/src/pi-runtime-adapter.ts:1397`

问题：`listAuthorized` 只要原来有任意工具，就会追加 `tool_result_recall`；适配器把它算进 `frozenDescriptors`/`toolNames`，而规则第 6 条规定“工具集合变了（工具名…）”就换新一次。因此上线后所有已有对话的下一轮都会重建一次请求开头、整段缓存失效一次。这是规则允许的，但本次材料和 ADR 0285 都没提这次一次性影响。

证据：
- `production-runtime-tools.ts:611-614`：`const offered = this.#registry.offer(descriptors, { readOnly }); return offered.length === 0 ? offered : this.#registry.offer([...offered, toolResultRecallDescriptor()], { readOnly });`
- `pi-runtime-adapter.ts:1397-1405`：`frozenDescriptors = descriptors.filter(...)`，`identity.toolNames: frozenDescriptors.map(({ name }) => name)`。
- `.agents/instructions/prompt-prefix.md:42`：`工具集合变了（工具名，或者去掉说明文字后的参数结构）…才换新一次`。

已证实：代码确实给所有有工具的对话加了新工具，并进入冻结身份。是否被 bundle 服务记录/自动重建由现有机制决定（未读该服务细节，标注未核实）。
建议：在改动说明/ADR 里明确“上线后老对话各重建一次、缓存整段失效一次”，并确认 bundle 服务的记录机制会记下这次 `tool_set_changed`。

### 5. 低：增量后的文档仍与代码不一致（200k 常量、“只用回答记下的用量”）

文件:行：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:124` 和 `:620`；`.agents/instructions/prompt-prefix.md:65`

问题：设计文档仍写 `packages/runtime-pi/src/compaction-prefix.ts:75：export const COMPACTION_TRIGGER_CAP_TOKENS = 200_000;`，以及“压缩现在的触发线是 20 万…改成 15 万前要核对”；代码已经是 `150_000`。另外规则与设计文档都说清理判断“只用每条回答记下的用量”，但代码在最后一次用量之后、以及压缩保留段，用的是 `messageTokens` 的近似估算，不是“只用用量”。

证据：
- `design...md:124`：`packages/runtime-pi/src/compaction-prefix.ts:75：export const COMPACTION_TRIGGER_CAP_TOKENS = 200_000;`
- `design...md:620`：`压缩现在的触发线是 20 万…改成 15 万前要核对…`
- `packages/runtime-pi/src/compaction-prefix.ts:90`：`export const COMPACTION_TRIGGER_CAP_TOKENS = 150_000;`
- `.agents/instructions/prompt-prefix.md:65`：`清了哪些由历史本身逐条重放算出（只用每条回答记下的用量）`
- `tool-result-clearing.ts:88-102`：`sinceMeasured += tokens;`（`tokens = messageTokens(message)`，非用量）

已证实：文档字面与代码不符。
建议：把设计文档里描述“当前值”的两处改成 150k 或删掉；把“只用用量”改成“用上一次回答的用量加上之后新增消息的估算”。

### 6. 低：not-found 提示让模型“重新执行那次工具”，对有副作用的工具可能造成重复且不可撤销的操作

文件:行：`packages/prompt-catalog/src/runtime.ts:314`

问题：`tool_result_recall` 对所有工具结果开放（不只读结果），找不到时提示“需要那次的细节时，重新执行那次工具”。如果被清掉/压缩掉的是一个已完成的写操作结果（发送、删除、支付确认等），模型被鼓励重跑同一次工具，而工具本身是只读的并不能阻止模型随后真的再调用一次有副作用的工具。

证据：
- `runtime.ts:314`：`text(" 的工具结果。它可能已在更早的压缩里被总结掉；需要那次的细节时，重新执行那次工具。")`
- `pi-runtime-adapter.ts:2132-2143` 的 `tool-result-recall` 分支对所有描述符开放；`production-tool-actions.ts:326-345` 的取回行本身是 `READ`，但目标工具可能是写操作。
- 缓解：有副作用的动作仍要过 owner-scope/审批（`production-tool-actions.ts` 里 `owner_scoped` 行），所以不是绕过授权，而是重复动作风险。

已证实：提示文字确实如此。
推测：模型按提示重跑写操作时能否被审批/幂等挡住，取决于具体工具；这段文字本身没有区分读写。
建议：改成“取回的原文找不到时，不要凭记忆重新执行有副作用的工具；需要时先确认当前状态”，或只对只读工具给“可重新执行”的提示。

### 7. 低：清理每轮全量重放原始历史，清理降低发送 token 但不降低本地计算

文件:行：`packages/runtime-pi/src/tool-result-clearing.ts:68`；`packages/runtime-pi/src/pi-runtime-adapter.ts:1571`

问题：每次模型请求都会在 `context` 钩子里对完整历史重放一遍；对被清理的历史结果，会话里存的仍是原文，所以每轮仍要扫描这些大段文本（`contentTokens` 逐块扫描/`JSON.stringify`），清理不会减少这部分 CPU。对话受压缩上限约束，量有界，但仍是每轮 O(历史) 的开销。

证据：
- `pi-runtime-adapter.ts:1571`：`const messages = clearToolResults(event.messages, clearing);`
- `tool-result-clearing.ts:68-106` 的 `clearedToolResultIds` 遍历全部 `messages`，`messageTokens` 对非工具消息做 `JSON.stringify`。
- `tool-result-clearing.ts:59-60` 的 `contentTokens` 逐块累计。

已证实：每轮都重算，且用的是未清理的原始历史。
建议：如果实测有开销，可缓存“历史前缀到已清集合”的不可变结果（按消息数组身份/长度），或跳过已判定为占位的结果；不是阻塞项。

**侧重检查**

- 错误路径：规范化内容块（`null`、缺 `text`）已不再抛错；`context` 钩子仍无兜底（意见 2）；`JSON.stringify`/`renderPrompt` 仍有理论抛错面。`recallToolResult` 对空串、非字符串、超长 id 都走 not-found，不会越界。
- 不可信输入：`toolCallId` 由模型给，最大 256，`trim` 后查历史；只查 `this.#activeSessions.get(request.runId)?.messages`，按 runId 限定，没有按模型参数选 run/thread 的入口，未见跨运行/跨对话读取路径。
- 安全：`capabilityRef`/`executor` 来自描述符而不是模型参数；`runtime_context` 在 agent-service 处只放行 preflight、实际执行在运行层；取回内容走正常出口遮盖（未逐行验证遮盖重放，标注未核实）。
- 资源耗尽：见意见 7；清理本身没有新增外部 I/O 或大分配。
- 不可撤销操作：取回工具本身只读；风险在 not-found 提示鼓励重跑有副作用的工具（意见 6）。
- 规则/说明一致性：ADR 0285 第 8 条的“不清清单”未实现（意见 1）；设计文档 200k 残留（意见 5）；`usedBy`、规则第 4 条“六种”、prompt-prefix 第 14 条已与增量一致。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 常规轮次不会：清理只改发给模型的那一份，发送仍然只在末尾追加，每轮会变的时间/环境值仍只放在最后一条消息。清理发生的那一轮会改一次历史前缀，这是规则第 14 条/ADR 0285 事先留出的例外，之后同一前缀重放出同样字节。**但**新增的 `tool_result_recall` 工具会改变所有已有对话的工具集合，按规则第 6 条会触发一次冻结头“换新”，见意见 4；`keepToolNames` 依赖当前描述符集合，若将来有了 `keep` 工具且各轮描述符不同，清理结果会随工具集合变化（目前生产没有 `keep` 生产者，见意见 1）。

2. **同一段文字会不会在不同请求里变成不同字节？** 清理占位只含 `toolName` 和 `toolCallId`，不含时间；已清集合是存储历史（用量 + 消息文本估算）的确定性函数，Set 只用于 `has`，输出按消息顺序，不依赖数据库/对象遍历顺序。所以同一历史前缀每次重放出同样字节。例外是意见 1 的“当前描述符集合参与 keep 判断”；压缩会重置用量判断，但那本来就是换掉整个开头的例外。

3. **有没有自动检查，反向用例会不会真的失败？** 有：`[CLEAR-1..5]` 进 `check:prompt-prefix`（脚本要求 17 条，`scripts/check-prompt-prefix.mjs:10-21`），`[CLEAR-3]`（不到 5000 不清）、`[CLEAR-4]`（keep 不清）是真正会失败的反向用例。增量新增的单测里，“取回工具自己结果”在旧代码下会失败，“不规范内容不抛错”在旧 `contentTokens` 下会抛错；“REVERSE: an earlier recall that found nothing still counts as not found”在旧代码下也通过，只是回归守卫，不能证明修复。缺口：agent-service 的 `preflight` 对 `runtime_context` 放行没有测试（见意见 3），prompt 清单 sha256 是否正确无法运行核实。

4. **每个产生/修改的值的直接使用端都接受吗？** `definition: "tool-result-recall"` 在联合类型、`toolDefinition`、`createTool`、`toolProgressOutput`（按非 builtin 直接返回内容）、`isHandleTool`（handleRef 为 null）处都接受；`name: "tool_result_recall"` 能命中登记表行、进入 `descriptorsByName` 和工具名快照；`capabilityRef: "context.tool_result_recall"` 与登记表行一致，`preflight` 能按能力查到；`executor: "runtime_context"` 被 preflight 接受，但会被 agent-service 的 `execute` 拒绝（运行层绕开，见意见 3）；`targetType: "conversation-context"` 有 `BUILTIN_PREFLIGHT` 兜底；`resultOrigin: "owner_data"` 在允许清单内。唯一“生产者缺失”的是 `contextRetention`（意见 1）。三个新提示词 id 已登记清单、`usedBy` 已修正；清单摘要未核实。

**未核实**

- 未能运行测试或计算 sha256：清单摘要、测试是否全绿未核实。
- Pi 的 `context` 钩子是否返回副本而非原地改会话、以及出口遮盖是否对追加的取回结果重新遮盖，只按现有测试/文档推断，未逐行追 Pi 内部实现。
- `thread-prompt-bundle-service` 是否会自动记录/重建本次工具集合变化，未读其细节。
