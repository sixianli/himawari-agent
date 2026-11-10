## 侧重检查（先查的路径与结论）

我重点核对了几类容易出问题的地方：

- **审批恢复 / 不可撤销的在途操作**：`ThreadPromptBundleService.resolve` 对 `continuationRef` 直接返回 `undefined`（`packages/application/src/services/thread-prompt-bundle-service.ts:184`）；方案又要从 v3 快照里删掉 `systemPrompt`。这会让审批恢复的第一次请求没有冻结提示可复用，是本次最严重的问题之一。
- **旧快照 / 旧数据**：v2 批次快照在 v3 下会抛错（`pi-tool-batch-continuation.ts:123`）；恢复入口把异常记成 `TOOL_RESULT_RECOVERY_FAILED` 后继续抛出（`production-run-dispatcher.ts:335-343`），并不是方案说的“按需要重新开始”。
- **不可信模型输入**：两处 `validateToolArguments` 前面目前只有对象类型强转（`sandboxed-coding-executor.ts:48-55`、`prepare-file-mutation.ts:60-65`）。方案新增的 JSON 值检查如果没有深度/节点上限，模型可以送超深嵌套参数造成递归栈耗尽。
- **规则/文档/代码一致性**：方案说“系统提示继续走已有的 `systemPromptOverride`”，但 Pi 1.5.0 里 `systemPromptOverride` 只对应 `customPrompt`，真正精确替换开头的是 `before_agent_start` 返回的 `systemPrompt`（`forceSystemPrompt`）。按方案字面实施会改变提示内容。
- **遮盖**：出口遮盖图例仍在请求时从当前提示词目录追加（`egress-context.ts:15-21`），不在冻结 bundle 的哈希里；以后改图例会让所有对话的开头变一次。
- **删除代码**：`legacy-pi-history.ts` 并非“只被自己的测试引用”，还被 `index.ts`、生产运维导入脚本和资格证据脚本使用。

---

## 证实的（按严重度）

### 高

**1. 审批恢复会丢失冻结系统提示，且可能改变恢复后的请求开头**

- 方案第 3 条：v3 快照不再存系统提示；审批恢复靠 `SessionManager` + 现有 `systemPromptOverride`。
- 但 `ThreadPromptBundleService.resolve` 在 `request.continuationRef !== undefined` 时直接返回 `undefined`（`packages/application/src/services/thread-prompt-bundle-service.ts:184`）。
- 适配器随后走回退路径：`bundle?.systemPrompt ?? productSystemPrompt(projection.systemInstruction, descriptors.map(...))`（`packages/runtime-pi/src/pi-runtime-adapter.ts:1272-1277`），即用**当前**指令和**当前**工具重新拼提示，而不是原批次冻结的提示。
- 当前批次快照正是唯一保存原系统提示的地方：`PiToolBatchContinuation.systemPrompt`（`pi-tool-batch-continuation.ts:9`），恢复时写回（`:96-97`）。方案删掉它，又没有保存“bundle generation / prompt 哈希 / pin”，恢复时无源可恢复。
- Pi 1.5.0 的 `before_agent_start` 返回 `systemPrompt` 会变成 `forceSystemPrompt`（`agent-session.ts` 的 `emitBeforeAgentStart` 分支，`extensions/runner.ts:1147`）；如果回退拼出的提示与冻结 bundle 不同，恢复的第一次请求开头就和普通轮次不同，违反 [规则 4/6](../../.claude/rules/prompt-prefix.md#rules) 的“只在末尾追加、系统提示按对话冻结”。ADR 0164 也记录过这个已知断点（`docs/adr/0164-move-changing-values-out-of-the-request-head.md:125`）。

**建议**：v3 快照不要存完整系统提示，但要存**冻结 bundle 的 generation/pin 或 prompt+tools 的哈希**；让 `resolve` 对 `continuationRef` 能打开原 run 的 pin/bundle，或把 bundle generation 随 continuation 一起持久化。恢复后必须断言实际发给 provider 的 system 消息逐字节等于该对话的冻结 bundle；不相等就拒绝发送并给出可重试/重建入口。

**2. “把批次 prefix 追加进 SessionManager”会和已有原生历史重复**

- 当前恢复语义是**替换**：`restorePiToolBatch` 把 `session.agent.state.messages = checked.prefix`（`pi-tool-batch-continuation.ts:96`），覆盖掉 `prehydrateSession` 先放进去的历史。
- 方案第 3 条改成“在 prehydrateSession 时把批次的 prefix 追加进 SessionManager”，但 `prehydrateSession` 已经会追加 `projection.nativeHistory.messages` 和 `projection.history`（`pi-runtime-adapter.ts:656-671`）。直接 append 会把同一批消息放两遍，造成重复的 user/assistant/toolResult 和工具调用/结果配对错误。

**建议**：明确 continuation 时 prefix 是**唯一的权威 transcript**。要么在 continuation 时不要追加 product history，要么先做 prefix 与 product history 的前缀/身份比较，只追加缺失的后缀。加一个测试：同一 continuation 恢复后，`SessionManager.buildSessionProjection().messages` 与保存前逐字节一致，且没有重复。

**3. Pi 1.5.0 的 `appendCompaction` 会自动保存一份完整 `SystemMessage`，方案没有处理**

- Pi v1.5.0 `SessionManager.appendCompaction` 现在会：
  - `const systemMessage = getCurrentSystemMessage(this.buildSessionProjection().messages);`
  - 把 `systemMessage` 写进 `CompactionEntry.systemMessage`（`session-manager.ts:1281-1294`）。
- 投影时该条目会生成 `[systemMessage, summary]`（`session-manager.ts:463`），也就是压缩边界会插入一条 mid-history system 消息。
- 方案仍通过 `prehydrateSession` 调 `appendCompaction` 重建压缩（`pi-runtime-adapter.ts:683-689`），每次恢复都会重新计算 `systemMessage` 和新的时间戳。方案只处理了批次快照的“不再存系统提示”，没有处理 Pi 自己在压缩条目里保存的系统提示。
- 如果 `before_agent_start` 的 `forceSystemPrompt` 投影没有覆盖这条路径，提示会重复或跨重启变化；即使覆盖了，也会改变历史大小和恢复语义。

**建议**：改用官方 `SessionManager.inMemory(cwd, options, entries)`（v1.5.0 已确认存在，`:1815`）恢复保存的 `FileEntry[]`，包括原始 compaction entry 及其 `systemMessage`/时间戳，而不是重新 `appendCompaction`。如果必须重建，至少要显式过滤/固定 compaction 的 `systemMessage`，并加“压缩后恢复两次字节一致”的测试。

**4. 旧对话不会自动拿到 Pi 1.5.0 的新工具文字；方案“所有对话开头变一次”不成立**

- `ThreadPromptBundleService` 只在工具名、模型、思考深度、回答语言、分类、工具 schema 变化时换新（`thread-prompt-bundle-service.ts:81-93,194-206`）。
- `toolSchemaChanged` 比较 schema 时排除了 `description/title/examples` 等文本字段（`:42-47,152-157`）。所以方案第 6 条“更新内置工具文字”**不会**让已有对话换 bundle；旧对话仍会看到旧文字。
- 如果 Pi 1.5.0 改了工具参数 schema，才会触发 `tool_schema_changed`；如果只改说明/行为，旧对话继续用旧说明，模型可能按旧说明使用新实现。
- 这与方案第 9 条“升级让所有对话的请求开头变一次”不一致；也和 I-73 的教训一致：不能只改生成端，必须检查每条旧清单/旧 bundle 与新的执行端是否兼容（`docs/incidents-and-gates.md:112`）。

**建议**：给 prompt bundle identity 加一个 Pi/runtime 版本（或强制 `rebuild_requested` 的一次性迁移）；明确决定旧对话是“保留旧 bundle”还是“全部换新”。如果保留旧 bundle，必须证明旧工具声明与新执行端 schema 完全兼容，并接受旧说明继续存在；如果要换新，就按一次性缓存失效处理并提前告知 Andy。

**5. v2 批次快照会让恢复入口抛错，不是“按需要重新开始”**

- v3 校验会拒绝 v2：`if (saved.version !== "pi-tool-batch.v2") throw ...` 当前在 `pi-tool-batch-continuation.ts:123`，升 v3 后等价逻辑会拒绝 v2。
- `production-tool-result-recovery.ts:226` 直接 `inspectPiToolBatch(value["batch"])`，异常会跳出整个候选扫描。
- `production-run-dispatcher.ts:335-343` 捕获后记录 `TOOL_RESULT_RECOVERY_FAILED` 并**重新抛出**，不是把这一批标记为“需要重新开始”。
- 升级时如果有待审批、工具执行中或结果未知的 Run，它们的 continuation 是 v2；Andy 的“不为以前的聊天记录/旧数据做兼容”不等同于可以破坏在途审批和未确认的工具结果。

**建议**：升级前先排空/列出在途审批、未确认工具结果和 continuation；或者保留一个只读 v2 解码路径（至少能读出 `waitingToolCallId`/completed results）。如果坚持不兼容，要让 recovery 对不支持的版本 `continue` 而不是抛穿整个扫描，并把 Run 明确置为“需要重新开始”，给用户可见的错误码。

**6. 规则要求 Andy 批准，但方案没有把“一次性缓存失效”和“context_edit 例外”列进拍板项**

- `prompt-prefix.md` 第 4 条列了封闭的五种例外；第 8 节明确要求“会改变已发内容就停下来出方案，Andy 同意才动工”。
- 方案第 9 条自己承认“升级让所有对话的请求开头变一次”，但第四节只让 Andy 决定 pi-durable 和“告知缓存断一次”，没有请求批准这个例外；第 7 条又把 `context_edit` 归入第 12 条压缩例外，但没有同步修改规则文件的例外清单。
- 依据：`.claude/rules/prompt-prefix.md` 第 4、8、12 条；`docs/incidents-and-gates.md:112`（I-73 的教训是“清单里的 id 能通过后端校验吗”）。

**建议**：把“一次性缓存失效”“context_edit+压缩例外”“旧 bundle 是否重建”都列入要 Andy 拍板的清单；同步更新规则文件和 ADR，而不是只写 ADR。

**7. 删除 `legacy-pi-history.ts` 的前提是错的**

- 它被：
  - `packages/runtime-pi/src/index.ts:32` 导出；
  - `scripts/operations/hermes-native-history-import.mjs:23,146` 通过 `require("@himawari-agent/runtime-pi")` 调用；
  - `test/qualification/evidence/runtime-history/test-import-legacy-history.mjs:6` 等资格脚本引用；
  - `test/integration/legacy-history-validation.test.ts:5-6` 引用。
- 这不是“只被自己的测试引用”。删除会破坏一次性历史导入/资格证据，而且如果某个实例的旧历史还没导入，删除是不可逆的。

**建议**：要么保留该文件和导出，直到所有实例完成导入并在仓库里明确记录；要么把 `index.ts`、运维脚本、资格脚本、测试一起删除，并先确认导入已完成。不要把它当作“没人调用”的清理项。

### 中

**8. 对 `systemPromptOverride` 的描述与 Pi 1.5.0 不符**

- Pi 1.5.0 `createAgentSession` 把 `resourceLoader.getSystemPrompt()` 作为 `customPrompt`（`agent-session.ts:1750-1760`）；`buildSystemPromptSections` 仍会加 Pi 自己的 tools/rules/docs/cwd 段（`system-prompt.ts`）。
- 精确替换整个人口的是 `before_agent_start` handler 返回的 `systemPrompt` → `currentOptions.forceSystemPrompt`（`extensions/runner.ts:1147`、`system-prompt.ts` 的 `buildSystemPromptState`）。
- 方案说“系统提示继续走已有的 systemPromptOverride”，如果实施者据此删掉 `himawari-system-prompt` 扩展，Pi 会把默认 sections 拼进去，`getCurrentSystemPrompt` 与冻结 bundle 不一致，fail closed 或发出错误提示。

**建议**：明确保留 `himawari-system-prompt` 的 `before_agent_start` 返回 `{ systemPrompt }`，`systemPromptOverride` 只是补充；加测试断言实际 provider system 消息等于冻结 bundle。

**9. 工具比较的表示不一致，直接字符串比较会误判**

- `frozenToolText` 包含 `label`、`promptSnippet`、`promptGuidelines`（`pi-runtime-adapter.ts:517-531`）；实际请求工具用 `providerTool`，只有 `name/description/parameters/constrainedSampling`（`:533-544`）。
- Pi 的 `getCurrentTools` 来自 `toToolDeclaration`，也不包含 `label/promptSnippet`（`transcript.ts`）。
- 方案说“getCurrentTools 读出 Pi 给的提示和工具，和冻结 bundle 比对”，但没说用哪一份；若拿 `bundle.tools`/`frozenDefinitions` 比，必然不相等。

**建议**：比较 `providerTool` 后的声明，或使用 Pi 导出的 `toToolDeclaration`/`declarationsEqual`；同时比较 `getCurrentSystemPrompt` 的完整文本和实际请求的 `systemPrompt`。

**10. `normalizeContext` 的 system 消息边界在方案里是含糊的**

- `normalizeContext` 总是把 `systemPrompt` 和 `tools` 折叠成一条**新加的开头 system 消息**（`transcript.ts`：“Fold Context.systemPrompt and Context.tools into a leading system message”）。
- 方案同时说“messages: 去掉 system 后的历史”和“请求中途出现非开头的 system 消息必须判为破坏”。如果只去掉“非开头”的 system，`normalizeContext` 会和残留的开头 system 重复；如果去掉全部 system，又需要确保 Pi 的 `getCurrentSystemPrompt` 检查是在转换前/后正确的上下文里做的。
- 建议明确：要么保留 Pi 的 `forceSystemPrompt` + `normalizeContext({ messages })`，不自己再传 `systemPrompt`；要么完全自己构造 `systemPrompt + tools + messages`，并保证 messages 不含任何 system。加一个“只出现一条开头 system 消息”的断言。

**11. 新增的反向用例按现有 gate 实现不了**

- `findPrefixBreak` 只看 provider raw body 的 messages（`packages/runtime-pi/test/helpers/prompt-prefix.ts:24-47`）。`context_edit` 是 `SessionManager` entry，不会出现在 provider 请求里，无法从 raw body 直接判断“普通轮次出现 context_edit”。
- `findPrefixBreak` 也不会拒绝“在末尾追加一条 system 消息”：它只检查前一条消息是否被改和是否前缀追加。方案想要的“请求中途出现非开头 system 消息必须判为破坏”需要显式加规则，而不是只加一个用例。
- 压缩后的请求本来就会让 messages 变短/改变，现有 helper 会报 break；方案说要把它归入压缩例外，但没有说 gate 如何区分“允许的压缩”和“普通轮次的 context_edit”。

**建议**：在适配器/`SessionManager` 层加测试钩子，记录 `context_edit` 和 `compaction_end` 的顺序；gate 在 `compaction_end` 后只允许一次已登记的 break，并断言该 break 同时有 `context_edit`；在 `findPrefixBreak` 中增加“index > 0 的 system/developer 消息即失败”。不要试图从 raw body 识别 `context_edit`。

**12. 出口遮盖图例没有随对话冻结**

- `withPlaceholderLegend` 每次用当前的 `EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE` 拼到 system prompt（`egress-context.ts:15-21`）。
- bundle 的 `systemPromptSha256` 只覆盖冻结的 `systemPrompt`（`thread-prompt-bundle-service.ts:249-256`），不覆盖图例。以后提示词目录改图例，所有对话开头会悄悄变化，且不触发 bundle 更新。

**建议**：把图例纳入冻结 bundle（或把图例版本作为 identity 的一部分）；加一个“部署前后同一对话字节一致”的 gate。

**13. 版本 pin、测试和安装清单没在方案里列全**

- 硬编码或断言 0.84.2 的地方至少包括：
  - `test/integration/local-pi-link.test.ts:14-31`
  - `test/integration/installable-node-services.test.ts:467-468`
  - `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2261`（`expect(pi.VERSION).toBe("0.84.2")`）
- `pi-coding-agent@1.5.0` 新增依赖 `@earendil-works/pi-codemode`、`@earendil-works/pi-mcp`、`pi-schema` 等（`packages/coding-agent/package.json` v1.5.0）。方案只说“两包改 1.5.0，重锁”，没有说安装清单、artifact manifest、供应链/许可证核对和 `installable-node-services` 的 `externalDependencies` 更新。
- 方案说“测试全过才合”，但这些现有测试会在升版本时失败。

**建议**：做一个“版本 pin 单一来源”的清单，更新所有断言、安装清单、artifact manifest、`test/integration/installable-node-services.test.ts` 和 `local-pi-link` fixture；对新 transitive deps 做一次依赖/许可证/网络访问审查。

**14. `details` 的 undefined 处理只覆盖了一部分生产点**

- 方案第 5 条说“工具结果 details 构造时不放 undefined 字段”，但当前至少还有：
  - `pi-runtime-adapter.ts:2043-2055` 无条件放 `resultRef`、`errorCode`、`externalActionId`，它们可能是 `undefined`；
  - `sandboxed-coding-executor.ts:98` 返回 `details: lastDetails`，可能为 `undefined`；
  - `host-read-only-executor.ts:271` 直接返回 `result.details`。
- `pi-native-history` 对 `toolResult` 只校验 `content/toolCallId/toolName/isError`，不校验 `details`（`pi-native-history.ts:50-54`）；`RuntimeHistoryService.save` 用 `JSON.stringify`（`runtime-history-service.ts:52-54`），会静默丢 `undefined`，恢复后的对象形状和内存中的不同。

**建议**：列全所有 `details` 生产点，统一用一个 `jsonDetails()` 构造器；在 `nativeHistoryMessages`/`RuntimeHistoryService.save` 入口做一次 JSON 值校验（含 undefined/循环/BigInt），并加“保存→加载→再次发送”字节一致的测试。

### 低（但仍建议处理）

**15. `context_edit` “只会出现在溢出恢复”不是 Pi 的不变量**

- Pi 1.5.0 的边界扩展 API 也能产生 `context_edit`：`_applyBoundaryDrafts` 的 `case "context_edit"`（`agent-session.ts:978`）。
- 自动重试路径 `agent-session.ts:3868` 也会调用 `_omitRecoveryAttempt`，只是 Himawari 关掉了 agent retry（`pi-runtime-adapter.ts:1361`）。
- 方案应该把结论限定为“Himawari 不注册会产生 context_edit 的边界扩展”，而不是“Pi 只会……”。否则未来加扩展时，ADR 的例外依据不成立。

**建议**：在 ADR 里写清触发来源，并把 gate 设计成“任何没有对应 compaction 的 context_edit 都失败”，而不是依赖“只会出现”。

**16. PR-2 的 Usage 迁移没有验证 missing vs zero**

- 当前 `safePiUsage` 只校验 `input/output/cacheRead/cacheWrite`（`pi-runtime-adapter.ts:704-727`）；`cache-usage-observation.ts` 还要靠原始 SSE 字段判断“有没有上报缓存”。ADR 0128 记录过 Pi 0.84.2 `parseChunkUsage` 把缺失字段当 0 的问题（`docs/adr/0128-record-cache-usage-of-every-model-request.md:32`）。
- 方案 PR-2 说“能从 Pi Usage 读到的不再自己解析”，但没有说明 1.5.0 的 `Usage.cacheWrite1h`、`reasoning`、`cost.totalFromProvider` 以及“缺失/0”的区分。

**建议**：PR-2 先加一个对照测试：同一份 SSE，分别缺字段、显式 0、显式非 0，要求 `cacheReported`/`totalFromProvider` 的结论和旧解析一致；再决定移除旧解析。

---

## 推测 / 未核实

以下问题需要实测或读更多资料，不能直接下结论：

- **Pi 1.5.0 是否真的改了内置工具的 parameters schema**：未核对 0.84.2 与 1.5.0 的 `read/bash/edit/write` 参数定义。若 schema 变了，`ThreadPromptBundleService` 会重建 bundle；若只改文字，旧 bundle 不会更新（见第 4 条）。需要逐工具 diff。
- **恢复后重建的 prompt 是否一定与冻结 bundle 不同**：如果同一对话的模型、工具名、指令完全没变，回退拼出的 prompt 可能恰好相等；但方案删除保存提示后没有机制保证这一点，尤其跨版本/换工具时。属于确定性风险，不是每次必现。
- **Pi 1.5.0 初始 system 消息是否会持久化进 SessionManager**：未直接读到 `createAgentSession` 之后 system 消息的持久化时序；`AgentSession` 会在 `_prepareRun` 里把 section 消息放进 `messages` 并持久化，但不同路径（approval resume、overflow continue）是否都有对应 system 消息，需要测试。
- **生产升级时是否真的存在 v2 在途快照**：仓库里无法知道当前生产是否有待审批/结果未知的 Run。需要上线前查库确认；如果存在，第 5 条会直接触发。
- **旧存储历史里是否已经有 `role: system`**：0.84.2 的 `AgentState.messages` 是否包含 system 需要核对；如果包含，方案第 4 条的过滤会让旧对话恢复时 `nativeHistoryMessages` 拒绝（`pi-native-history.ts:40-64`），影响面比“一次缓存失效”大。
- **Pi 1.5.0 `transformMessages` 在换模型/换 provider 时丢弃思考块的精确条件**：方案第 10 条把它列为“有利行为”，但没有验证会不会在同一对话的 fallback 模型路径上造成历史字节变化。
- **新 transitive deps 的供应链/许可证/网络访问**：未审计 `pi-codemode`/`pi-mcp`/`pi-schema` 是否引入额外网络、遥测或安装脚本。
- **`getCurrentTools` 与 `frozenToolText` 的精确比较结果**：未运行 1.5.0 实测；从源码看字段不同，但需要测试确认是否真的不相等。

---

## 如果由我来定，我会怎样改这份方案

1. **不要把“升级”和“历史/恢复语义重写”放在一个 PR。** 先做 PR-1a：只升版本、修类型/测试、跑兼容测试，保留现有 `systemPrompt` 快照和恢复路径；确认 1.5.0 的实际 wire format、工具 schema、压缩/重启行为。再做 PR-1b：迁移历史/批次恢复。

2. **恢复路径改为“官方 SessionManager 条目”而不是自己重建：**
   - 用 `SessionManager.inMemory(cwd, options, entries: FileEntry[])` 恢复 product history、compaction entry 和批次 prefix；
   - 不再调 `appendCompaction` 重建；
   - continuation 保存 `promptBundleGeneration`/`promptSha256`，让 `resolve` 能打开原 bundle，而不是删掉 `systemPrompt` 后无源可恢复。

3. **系统提示只保留一条权威路径：**
   - 保留 `before_agent_start` 返回 `systemPrompt`（`forceSystemPrompt`）；
   - 不再用 `systemPromptOverride` 声称“冻结”；
   - 在 provider 请求前后断言实际 system 消息逐字节等于 bundle（包含图例），否则 fail closed。

4. **旧 bundle 要一次性迁移或明确保留：**
   - 在 bundle identity 里加 Pi/runtime 版本，升级时强制 `rebuild_requested`，或者
   - 明确旧 bundle 继续使用旧工具声明，并证明新执行端兼容；
   - 两者都写进 ADR，并在上线前告知 Andy 缓存影响。

5. **v2 在途数据先处理再上线：**
   - 上线前查并排空待审批、结果未知、continuation 未完成的 Run；
   - 如果做不到，给 `inspectPiToolBatch` 加只读 v2 兼容路径；
   - recovery 遇到不支持版本时 `continue` 并标记“需要重新开始”，不要抛穿整个候选扫描。

6. **prompt-prefix gate 改成进程内测试：**
   - 记录 `context_edit`、`compaction_end`、实际 provider `messages`；
   - 只允许 `compaction_end` 后一次已登记的 break，并断言同一请求包含 `context_edit`；
   - 拒绝任何 index > 0 的 system/developer 消息；
   - 增加“审批恢复第一次请求与普通轮次头部逐字节相同”的用例。

7. **把 JSON 值检查做成有界函数**：迭代遍历、最大深度/节点数/字节数，拒绝循环、BigInt、Map、undefined、函数、Symbol；对 `details` 和工具参数都走同一入口，并加恶意嵌套用例。

8. **清理项拆开处理**：`legacy-pi-history.ts` 先保留，或连同 `index.ts`、`scripts/operations/hermes-native-history-import*.mjs`、资格脚本和测试一起删；确认所有实例的旧历史导入已完成后再删。

9. **规则和拍板项补全**：把“一次性缓存失效”“context_edit+压缩例外”“旧 bundle 是否重建”“pi-durable 是否另开评估”一起交给 Andy；同步修改 `.claude/rules/prompt-prefix.md` 和 ADR。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**会，而且方案里有两条不同的变化路径，不能只用“升级让所有对话开头变一次”概括。**

- **升级本身**：Pi 1.5.0 的 prompt/tool 序列化、`normalizeContext`/`collapseSystemMessages`、工具文字都可能改变 wire bytes；这属于一次性全局变化，需要 Andy 按规则第 8 节批准。
- **冻结 bundle 的影响**：`ThreadPromptBundleService` 会复用旧 bundle，旧对话**不一定**换新；如果 Pi 1.5.0 只改说明不改 schema，旧对话会继续用旧文字（`thread-prompt-bundle-service.ts:194-206`）。所以“所有对话开头变一次”既不充分也不准确。
- **审批恢复**：方案删除快照里的 `systemPrompt`，而 `resolve` 对 continuation 返回 `undefined`（`:184`），恢复时会用当前指令/工具重新拼提示，**恢复后的第一个请求开头可能与普通轮次不同**。这直接违反“只在末尾追加、系统提示按对话冻结”的要求。
- **仍在末尾追加的部分**：时间、记忆、运行环境、工具状态目前都放在最后一条 user 消息（`turnPrompt`，`pi-runtime-adapter.ts:600-618`），这部分设计是对的；方案没有把新的每轮变化值放进 system 消息，唯一例外是出口遮盖图例仍从当前目录追加（`egress-context.ts:15-21`），需要冻结。

**结论**：除明确批准的一次性升级失效、规则第 7 条句柄工具例外、第 12 条压缩例外外，请求仍应只在末尾追加；每轮会变的值必须只在最后一条消息里。方案目前不满足，主要因为续跑提示恢复和旧 bundle 复用/换新没有定义。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**有多个风险点，不能只靠“每次确定性追加”保证：**

- **压缩条目**：Pi 1.5.0 `appendCompaction` 自动保存 `systemMessage`，并用新时间戳重建（`session-manager.ts:1281-1294`）；恢复两次可能得到不同的 system 消息内容/时间。即使 provider 不发送 timestamp，内容也可能随当前提示变化。
- **续跑重建提示**：continuation 的 `bundle` 为 `undefined`，提示由当前 `projection.systemInstruction` + descriptors 重新拼（`pi-runtime-adapter.ts:1272-1277`）；这与原批次的冻结提示可能不同。
- **system 消息边界**：`normalizeContext` 总是新加一条开头 system（`transcript.ts`）；如果 `messages` 里还残留开头 system，就会重复；如果去掉全部 system，检查逻辑又必须在正确的转换后上下文里做。方案对“去掉哪些 system”表述不清。
- **工具表示**：`frozenToolText` 与 `getCurrentTools`/`providerTool` 字段不同（`pi-runtime-adapter.ts:517-544`）；如果比较/序列化用错一份，字节会不同。
- **出口遮盖图例**：图例从当前提示词目录追加，不在 bundle 哈希里（`egress-context.ts:15-21`、`thread-prompt-bundle-service.ts:249-256`）；改图例不会触发 bundle 更新，但会改变所有请求开头。
- **JSON 往返**：`RuntimeHistoryService.save` 用 `JSON.stringify`（`runtime-history-service.ts:52-54`），会丢 `undefined`；`details` 的 undefined 字段在内存/存储/恢复之间形状不同（`pi-runtime-adapter.ts:2043-2055`）。
- **模型切换**：Pi 1.5.0 的 `transformMessages` 在换模型/换 provider 时可能丢弃别家思考块；如果 fallback/备选模型路径在同一对话发生，历史字节会变。方案第 10 条把它写成“有利”，但没有说明这是允许的断点还是必须避免。

**结论**：需要把所有输入做成确定性数据（固定顺序、无时间戳、无 undefined、固定工具声明），并在 gate 里对“保存→恢复→再次发送”做字节比较；否则同一段文字可能在不同请求/重启后变成不同字节。

### 3. 改动有没有对应的自动检查，反向用例真的会失败？

**有基础，但方案新增的检查不够，部分按现有实现根本测不到：**

- 现有 `check:prompt-prefix` 会跑 `packages/runtime-pi/test/prompt-prefix.compat.test.ts`，已有反向用例：
  - 改写历史用户消息（`prompt-prefix.compat.test.ts:549-564`）；
  - 把工作目录写回系统提示（`:610-624`）；
  - 系统提示带每轮变化值（`:626-635`）；
  - 关掉冻结（`:700-716`）；
  - 工具/记忆/时间只在最后一条消息（`:566-608`）。
- 但方案要加的两个反向用例按现有 helper 不可靠：
  - `context_edit` 不在 provider raw body 里，`findPrefixBreak` 看不到（`prompt-prefix.ts:24-47`）。
  - `findPrefixBreak` 不拒绝“末尾追加一条 system 消息”；需要显式加“index > 0 的 system/developer 即失败”。
  - 压缩后的请求本来就会被判 break；方案没有实现“允许一次压缩 break”的机制。
- 升级相关的检查也缺：
  - 没有“审批恢复第一次请求 == 普通轮次请求头”的用例；
  - 没有“旧 bundle 与新执行端工具 schema 兼容”的用例；
  - 没有 v2→v3 快照的明确失败/重启用例；
  - `pi-builtin-tool-text.compat.test.ts:18-28` 的 C10 快照如果直接更新成 1.5.0，会失去“Pi 改文字就失败”的提醒作用，必须人工逐条核对 C6。
- 现有硬编码版本测试（`local-pi-link.test.ts:14-31`、`installable-node-services.test.ts:467-468`、`pi-runtime-adapter.compat.test.ts:2261`）会在升级时失败，方案没有列出。

**结论**：有基础 gate，但方案新增的反向用例需要先改 helper/测试钩子；否则“反向用例会失败”无法证明。

### 4. 每个生产/消费的值两端都能接受吗？

逐个核对如下：

- **`pi-tool-batch.v2` → `v3`**：
  - 生产：`capturePiToolBatch`（`pi-tool-batch-continuation.ts:17-31`）。
  - 消费：`restorePiToolBatch`（`:92-120`）、`inspectPiToolBatch`（`:135-148`）、`production-tool-result-recovery.ts:226`。
  - 旧 v2 消费端会抛 `PI_CONTINUATION_VERSION_INVALID`（`:123`），且 recovery 会抛穿整个候选扫描（`production-run-dispatcher.ts:335-343`）。**不通过**，需要 v2 只读兼容或显式重启路径。
- **快照删除 `systemPrompt`**：
  - 生产：`capturePiToolBatch` 当前保存 `session.agent.state.systemPrompt`（`:28`）。
  - 消费：`restorePiToolBatch` 当前写回（`:97`）；方案删除后，审批恢复没有替代来源（`thread-prompt-bundle-service.ts:184`）。**不通过**。
- **`role: system` 过滤**：
  - 生产：适配器 `captureHistory`（`pi-runtime-adapter.ts:1616-1624`）；批次 prefix 也可能带 system（`capturePiToolBatch`）。
  - 消费：`nativeHistoryMessages` 明确拒绝 system（`pi-native-history.ts:40-64`）；`RuntimeHistoryService.save` 不校验角色（`runtime-history-service.ts:45-68`）。
  - 如果只在适配器过滤，其他调用方仍可能写入 system；需要在持久化边界统一校验。**部分通过**。
- **`normalizeContext` / `TranscriptContext`**：
  - 生产：适配器新代码。
  - 消费：`clampMaxTokensToContext` 接受 `TranscriptContext`（Pi 1.5.0 `simple-options.ts`），`openai-completions` 接受 `TranscriptContext`，类型上正确。
  - 但工具对象必须用 `providerTool`/`toToolDeclaration` 的表示；用 `frozenToolText` 会多字段。**需要修正表示**。
- **内置工具文字快照**：
  - 生产：`pi-builtin-tool-text.ts`、`pi-builtin-tool-text.compat.test.ts`。
  - 消费：`check:prompt-catalog`、`promptBundle` 候选、旧 bundle。
  - 更新快照会让 C10 不再因“Pi 文字变化”失败；旧 bundle 不会自动更新。**部分通过，需要明确人工核对和 bundle 迁移**。
- **`details` 字段**：
  - 生产：`pi-runtime-adapter.ts:2043-2055`、`sandboxed-coding-executor.ts:98`、`host-read-only-executor.ts:271`。
  - 消费：`pi-native-history.ts` 的 toolResult 校验只查 content/id/name/isError；`RuntimeHistoryService.save` 用 JSON.stringify。
  - 需要两端统一 JSON 值校验；**部分通过**。
- **`legacy-pi-history` 导出**：
  - 生产：`index.ts:32`。
  - 消费：`scripts/operations/hermes-native-history-import.mjs:23,146`、资格脚本、测试。删除会让消费端拿到 `undefined`。**不通过**。
- **依赖版本 1.5.0**：
  - 生产：`packages/runtime-pi/package.json`、`package-lock.json`。
  - 消费：`test/integration/installable-node-services.test.ts:467-468`、`local-pi-link.test.ts:14-31`、`pi-runtime-adapter.compat.test.ts:2261`、artifact manifest、安装包。
  - 方案没有列全这些消费端。**不通过**。
