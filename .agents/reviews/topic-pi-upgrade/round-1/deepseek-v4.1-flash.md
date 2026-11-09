## 结论摘要

- 升级本身不难，真正危险的是：1.5.0 把系统提示和工具定义搬进了 transcript 的 `SystemMessage`，而 Himawari 只走 `openai-completions`，该 API 默认 `supportsMidConvoSystemMessages: false`，Pi 会把中途 system 消息折叠回开头。若直接使用 Pi 的 section/tool 变更机制，会在对话中途改写请求头，违反只追加规则。
- 因此方案的核心不是“尽量用 Pi 的新系统消息”，而是：**继续由 Himawari 的 prompt bundle 冻结头，Pi 只负责传输；把 Pi 的 `SessionManager` 作为唯一运行时历史来源；不做会改写历史的 section 差分。**
- 建议拆成 4 个 PR：①升级基线（含 SessionManager 与续跑快照）②请求头冻结与遮盖图例 ③JSON 值边界与 I-73 核对 ④Pi 优先清理与对照表落地。
- 对照表结论：模型接入、工具定义、压缩、SessionManager、工具参数校验已经是/应该换成 Pi；权限审批、出口遮盖、沙箱、预算准入、模型路由、产品持久化必须保留；`pi-durable`、`pi-mcp`、`pi-telemetry`、`chord` 本次不换，列“以后再评估”。

---

## 一、方案依赖的前提

| # | 前提 | 来源与原话 |
|---|---|---|
| P1 | 当前锁的是 0.84.2 | `packages/runtime-pi/package.json:10-11`：`"@earendil-works/pi-ai": "0.84.2"`、`"@earendil-works/pi-coding-agent": "0.84.2"` |
| P2 | 只有 runtime-pi 能导入 Pi | `.agents/instructions/pi-and-workspace.md:26`：“只能在 `packages/runtime-pi` 中导入 `@earendil-works/pi-*` 包” |
| P3 | 已发内容只能追加，系统提示和工具按对话冻结 | `.claude/rules/prompt-prefix.md:35`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”；`:41`：“系统提示和工具按对话冻结” |
| P4 | 字节必须确定，遮盖必须确定 | `.claude/rules/prompt-prefix.md:51`：“同样的内容，每次都要序列化成同样的字节。”；`:52`：“遮盖敏感信息必须是确定的。” |
| P5 | 1.5.0 的 provider 层只收到 `TranscriptContext` | Pi 1.5.0 `packages/ai/src/types.ts`：`export type TranscriptContext = { messages: Message[]; ... }`；`packages/ai/README.md` “System Messages”：“everything below them ... receives the resulting `TranscriptContext`, which only has `messages`.” |
| P6 | 中途 system 消息可改提示/工具，但不支持的模型会折叠到开头 | Pi 1.5.0 `packages/ai/README.md` “System Messages”：“The transcript can also carry system messages later in the conversation to change the prompt or the tool set without rewriting the history”；“Every other model receives `collapseSystemMessages(transcript)`” |
| P7 | `openai-completions` 默认不支持中途 system 消息 | `packages/ai/src/api/openai-completions.ts:1671`：`supportsMidConvoSystemMessages: false` |
| P8 | SessionManager 是最终上下文的唯一权威；不能再靠赋值 `agent.state.messages` 恢复 | Pi 1.5.0 `packages/coding-agent/docs/sdk.md`：“`SessionManager` is authoritative for finalized model context. Restore external history by constructing the session with a manager containing those entries. Assigning `session.agent.state.messages` does not replace persisted context.” |
| P9 | `session.systemPrompt` 在 1.5.0 是只读的 | 同上：“`session.systemPrompt` is read-only and returns the current effective system prompt...” |
| P10 | `before_agent_start` 仍可用返回 `{ systemPrompt }` 强制本回合完整提示 | Pi 1.5.0 `packages/coding-agent/src/core/extensions/types.ts`：`BeforeAgentStartEventResult { systemPrompt?: string }`；`runner.js` 中 `currentOptions.forceSystemPrompt = result.systemPrompt` |
| P11 | `appendCompaction` 现在会自动捕获边界处的 systemMessage | Pi 1.5.0 `packages/coding-agent/src/core/session-manager.ts`：`const systemMessage = getCurrentSystemMessage(this.buildSessionProjection().messages)`，并写入 `CompactionEntry.systemMessage` |
| P12 | `SessionManager.inMemory` 可直接从外部 entries 构造 | 同上：`static inMemory(cwd = process.cwd(), options?: NewSessionOptions, entries?: FileEntry[])` |
| P13 | Pi 没有内置权限系统 | Pi 1.5.0 `README.md` “Permissions & Containerization”：“Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access.” |
| P14 | `pi-durable` 仍是实验性 API | `packages/durable/README.md` 开头：“**Experimental.** The API changes without notice between releases.” |
| P15 | Pi 压缩仍把整段对话序列化成一条新消息，并禁用缓存写入 | `packages/coding-agent/docs/compaction.md`：“Summarization requests disable prompt-cache writes because these one-off prompts are unlikely to be reused.” |
| P16 | I-73 的教训是“只看 diff，不核对清单值能否通过所有消费者” | `docs/incidents-and-gates.md:112`：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」” |
| P17 | 当前适配器依赖 `requested.tools` 和可写 `systemPrompt` | `packages/runtime-pi/src/pi-runtime-adapter.ts:1570`：`Array.isArray(requested.tools)`；`packages/runtime-pi/src/pi-tool-batch-continuation.ts:97`：`session.agent.state.systemPrompt = checked.systemPrompt;` |
| P18 | 当前历史预填是 SessionManager + appendMessage | `packages/runtime-pi/src/pi-runtime-adapter.ts:655-690` |
| P19 | 当前续跑快照保存原始 prefix/assistant/systemPrompt | `packages/runtime-pi/src/pi-tool-batch-continuation.ts:6-15`、`:80-88` |
| P20 | 当前 native history 明确拒绝 `role:"system"` | `packages/runtime-pi/src/pi-native-history.ts:41-64`；测试 `test/pi-native-history.compat.test.ts:42-49` 把 system 角色作为“elevated-role”反向用例 |
| P21 | 当前 prompt-prefix 门槛要求至少 8 条 `[I-66]` 测试通过 | `scripts/check-prompt-prefix.mjs:8-10`、`:43-47` |
| P22 | 当前内置工具文字测试钉死 0.84.2 原文 | `test/pi-builtin-tool-text.compat.test.ts:18-28`、`:69-71` |
| P23 | 当前 `ToolCall.arguments`/`ToolResultMessage.details` 在 1.5.0 限定 JSON 值 | Pi 1.5.0 `packages/ai/src/types.ts`：`arguments: JsonObject`；`ToolResultMessage<TDetails = JsonValue>` |
| P24 | 当前试升已确认 48/405 失败，主要是 `PI_RUNTIME_ERROR`、续跑失败、内置 bash 文案变化 | 材料“试升结果”段（未在本轮重新运行，作为给定事实） |

---

## 二、方案本身

### PR-1：升级基线（版本、类型、SessionManager、续跑）

**目标**：只做“能编译、测试全过、行为尽量不变”的迁移；把 1.5.0 的请求头一次性变化记录到 ADR。

1. **版本与锁文件**
   - `packages/runtime-pi/package.json` 两个 Pi 包改 `1.5.0`，`npm install`，确认只剩一份 `pi-ai`（材料已确认 1.5.0 不再嵌套）。
   - 保持精确版本；不改 `ci/toolchain-lock.json` 的 Node 版本（已 >=22.22.3）。
   - 新增 ADR：“Pi 1.5.0 升级会让所有旧对话的请求头变一次；Andy 2026-11-09 已同意不为旧聊天记录做兼容；新对话从冻结的 bundle 重新开始。”

2. **`TranscriptContext` 迁移**
   - `pi-runtime-adapter.ts` 的 `PiStreamFunction`、`admitPiStream` 参数从 `Context` 改为 `TranscriptContext`。
   - `clampMaxTokensToContext(model, context, desired)` 直接传新的 `TranscriptContext`。
   - 删除 `requested.tools` 分支：1.5.0 的 `streamFunction` 不再有 `tools` 字段；工具由 session 的 active tools 和 system 消息里的 `toolsAdded` 承载。
   - `backgroundModelContext` 仍返回 `Context`，因为 `ModelRuntime.stream()` 公共入口仍接受 `Context`（Pi 的 `normalizeContext()` 会折叠）。

3. **工具集合冻结的落点**
   - 当前 `requestTools`（`bundle.tools` + handle tools）在 1.5.0 不存在了。改为在 `createAgentSession({ tools })` 时只激活：
     - `bundle.tools` 解析出的冻结工具名；
     - `handleDescriptors` 的工具名。
   - `customTools` 仍注册全部 descriptors（保证 handle 工具可执行），但未在 `tools` 里的不声明给模型。
   - 不再把 `descriptors.map(name)` 全量传给 `tools`，否则新出现的非 handle 工具会改变头部工具定义。
   - `productSystemPrompt` 继续只用 `frozenDefinitions` 生成 tool snippets/guidelines；handle 工具不进入冻结提示。

4. **续跑快照 v3**
   - 把 `PiToolBatchContinuation` 从“原始 messages 数组 + systemPrompt”改为：
     - `version: "pi-tool-batch.v3"`
     - `prefixEntries: FileEntry[]`（来自 `session.sessionManager.getBranch()` 中最后一条 assistant 之前的条目，含 session header 或由 adapter 补一个固定 id 的 header）
     - `assistant`、`completedResults`、`waitingToolCallId`、`completedStreamOrdinal`、`parallel`
   - `capturePiToolBatch` 从 `session.sessionManager` 取条目，而不是只取 `agent.state.messages`；不再保存 `systemPrompt`（系统提示由冻结 bundle 和 Pi 的强制投影提供）。
   - `restorePiToolBatch` 不再赋值 `session.agent.state.messages` / `systemPrompt`。改为：
     - 校验快照；
     - 返回 `prefixEntries` 和 `takeReplay()`；
     - adapter 在 `createAgentSession` 之前用 `SessionManager.inMemory(cwd, { id: piSessionId }, [header, ...prefixEntries])` 构造 manager；
     - 仍用 `takeReplay()` 把保存的 assistant 作为合成流回放，避免重新请求模型。
   - **保留 v2 读取兼容**：旧待审批的 continuation 仍是 v2。`restorePiToolBatch` 遇到 v2 时，把原始 `prefix` 消息逐条 `appendMessage` 到一个新的 `SessionManager.inMemory`，再走同样的 replay。这样不会让部署时挂起的审批失效。
   - `inspectPiToolBatch` 输出字段保持不变（`completedStreamOrdinal`、`completedToolCallIds`、`waitingToolCallId`、`toolName`、`arguments`），因为 `apps/agent-service/src/production-tool-result-recovery.ts:226` 依赖这些字段。

5. **历史捕获去掉 system 消息**
   - 在 `session.subscribe` 的 `captureHistory` 之前，过滤 `role === "system"` 的消息。
   - 理由：1.5.0 的 `agent.state.messages` 会包含 Pi 的 leading system message、section patch、compaction `systemMessage`。产品历史不应该持久化提示词快照；下一次运行时由冻结 bundle + `before_agent_start` 重新投影。这样 `pi-native-history` 继续拒绝 system 角色，保留现有的“elevated-role”安全反向用例。
   - `compactionSummary` 仍保留；`nativeHistoryMessages` 已支持。

6. **内置工具文字**
   - 更新 `pi-builtin-tool-text.compat.test.ts` 的 `PI_ORIGINAL_TEXT` 到 1.5.0 原文；bash 的 command 描述按材料改为 “Shell command to execute”。
   - 重新检查 `contradictions()`：如果 1.5.0 的 bash 原文不再有 “no default timeout” 等矛盾，就删掉对应反向期望，而不是为了过测试保留旧断言。
   - `himawariBuiltinToolText` 仍替换 read/bash 的文案；这是产品政策，不是重复实现。

7. **退出条件**
   - `tsc` 全绿；`packages/runtime-pi` 405 条测试全过；`npm run check:prompt-prefix` 通过；`check:pi-compat` 通过。

### PR-2：请求头冻结与出口遮盖图例

**目标**：保证 1.5.0 的 system message 机制不会在对话中途改写请求头。

1. **把出口遮盖图例放进冻结 bundle**
   - 当前 `withPlaceholderLegend` 在每次请求时把图例拼到 `Context.systemPrompt`（`egress-context.ts:15-21`）。1.5.0 里 `context.systemPrompt` 不存在，且请求头由 Pi 的 `SystemMessage` 生成。
   - 改为在 `bundle` 解析前把 `EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE` 拼进 `candidate.systemPrompt`，由 `ThreadPromptBundleService` 存储和冻结。这样：
     - 旧对话升级后只变一次头；
     - 以后改图例文字不会改旧对话；
     - 新对话从第一轮就带图例。
   - 后台调用继续用 `backgroundModelContext`（`EGRESS_PLACEHOLDER_LEGEND`），不经过 bundle。
   - `withPlaceholderLegend` 对聊天路径可以删除或改为恒等函数；保留一个断言测试，确认请求里的 leading system message 以图例结尾。

2. **不使用 `SystemMessage.sections` 作为冻结机制**
   - Pi 的 `sections` 是 `Record<string, string|null>`，README 明确警告“Avoid integer-like names; JSON objects reorder those”。
   - Himawari 的冻结提示继续用单个 `content` 字符串，不用 sections；工具变化只用冻结工具 + handle 工具的有序数组。
   - `before_agent_start` 继续返回完整 `systemPrompt`，触发 Pi 的 `forceSystemPrompt` 投影；不要让 `_preparePromptAndToolLoadout` 的 section diff 成为头部的来源。

3. **处理 1.5.0 的自动 overflow recovery**
   - Pi 1.5.0 在 overflow/length 恢复时会追加 `context_edit` omission，并可能压缩。这会改写历史。
   - 方案：在 ADR 中把它归入“成批压缩/恢复”的例外，和现有压缩同一类；不要把它用于普通轮次。若不能接受，需关闭该恢复路径或在 `session_before_compact` 中接管；这是需要人拍板的取舍（见下）。
   - 在 `check:prompt-prefix` 中增加反向用例：普通轮次不得出现 `context_edit`；只有 overflow 恢复允许。

4. **更新 `[I-66]` 测试**
   - 现有的“改 systemInstruction 不改头”“改工具不换新”“反向：不冻结就失败”保留。
   - 新增：
     - 1.5.0 真实路径下，`before_agent_start` 返回的完整提示被 Pi 投影为 leading system message；第二轮改 `systemInstruction`，头字节不变。
     - 反向：去掉 `before_agent_start` 的强制提示，或让 `_preparePromptAndToolLoadout` 的 section 变化进入头部，`findConversationBreak` 必须报失败。
     - 反向：在对话中途插入一条带当前时间的 `SystemMessage`，在 `openai-completions` 折叠路径下必须导致头变化（证明 gate 能抓到）。
     - 反向：handle 工具出现/消失是允许的例外，但冻结工具和系统提示的字节仍不变。

### PR-3：JSON 值边界与 I-73 式逐一核对

**目标**：1.5.0 把 `ToolCall.arguments`、`ToolResultMessage.details` 限定为 JSON 值；不能靠 `as Record<string, unknown>` 蒙混。

1. **新增边界函数**
   - 在 runtime-pi 内新增 `toJsonObject(value: unknown): JsonObject`：
     - 只接受普通对象；
     - 递归检查 `null | boolean | finite number | string | array | plain object`；
     - 拒绝 `undefined`、`bigint`、`function`、`symbol`、`NaN`、`Infinity`、`Map`、`Set`、`Date`、class 实例；
     - 返回深拷贝，键顺序按输入固定（若需要跨轮稳定，再按 key 排序）。
   - `prepare-file-mutation.ts:64`、`sandboxed-coding-executor.ts:54` 改为 `arguments: toJsonObject(input.parameters)`，不再强转。
   - `safeArguments` 也走同一函数；非 JSON 参数返回 `{}` 或抛 `RUNTIME_TOOL_ARGUMENTS_INVALID`，由调用方决定 fail closed。

2. **审计 `details` 生产者**
   - `pi-runtime-adapter.ts:2043-2055` 的 `details`：`executionTiming`、`productOutcome`、`dispatchState`、`productRunId`、`resultRef`、`errorCode`、`externalActionId`。
   - 逐个确认没有 `undefined` 字段被保留；`JSON.stringify` 会丢掉 undefined，但如果同一对象在不同轮次字段存在性不同，字节会变。建议在构造时就省略 `undefined`，不要依赖序列化。
   - `previousFileConflict` 读取 `details.productRunId/productOutcome/errorCode`；`pi-tool-progress-guard` 读取 `details.errorCode`。这些字段必须始终是 JSON 值，不能是 `undefined` 之外的类实例。

3. **I-73 式核对**
   - 新增一个“续跑快照契约”测试：`capturePiToolBatch` 产物 → `inspectPiToolBatch` → `restorePiToolBatch` → `production-tool-result-recovery` 的字段检查，全部接受 v2/v3；未知版本必须拒绝。
   - 新增一个“图例进 bundle”契约测试：`candidate.systemPrompt` 含图例 → `ThreadPromptBundleService.#create` 存 `systemPromptSha256` → `#open` 校验通过 → `adapter` 收到的 `bundle.systemPrompt` 含图例。
   - 新增一个“工具参数 JSON”测试：`undefined`、`BigInt`、`Map` 参数在边界被拒绝，而不是被 `JSON.stringify` 静默变成 `{}` 或 `null`。

### PR-4：Pi 优先清理与对照表落地

**目标**：把“换成 Pi / 保留 / 以后再评估”写进仓库文档并删掉真正重复的代码。

- 删除/收薄：
  - `pi-native-history` 保留为“不可信历史的校验边界”，不再承担“第二种 transcript 表示”。
  - `legacy-pi-history` 保留为一次性迁移工具，设定下线条件（所有 legacy run 覆盖完 + 一个发布周期）。
  - `egress-context` 的聊天图例逻辑删除；只保留后台调用。
  - 如果 `model-output-budget` 只是 Pi `truncateHead/truncateTail` 的薄封装，保留；它不是重复协议。
- 不删除：
  - `configured-model-binding`（产品 secrets、Magpie/Vercel 路由、准入成本）。
  - `governed-*`、`sandboxed-coding-executor`、`host-read-only-executor`（权限、审批、沙箱）。
  - `pi-tool-progress-guard`（Pi 文档未见等价能力；未核实全源码）。
  - `cache-usage-observation`、`gateway-observation`（Pi 的 `usage` 不告诉你 provider 是否真的报告了 cache，也不提供 Magpie 的计费头）。
- 对照表写进 `docs/`（建议新 ADR 或 `docs/pi-first-matrix.md`），每行带“换成 Pi / 保留 / 以后再评估”和理由。

---

## 三、Pi-first 对照表

| Himawari 自有块 | Pi 1.5.0 对应 | 决定 | 理由 / 差别 |
|---|---|---|---|
| 模型接入、provider 注册、流式 | `pi-ai` `ModelRuntime`、`createProvider`、`StreamFunction` | **换成 Pi / 已用** | 已经是 Pi 的协议；`configured-model-binding.ts` 只保留产品 descriptor、secret 解析、Magpie/Vercel 路由和准入成本。 |
| 工具定义、参数校验 | `pi-ai` `Tool`、`validateToolArguments`、`pi-schema` | **换成 Pi / 已用** | 1.5.0 不再导出 TypeBox；继续用 Pi 的 JSON Schema + `validateToolArguments`，不再自写校验器。 |
| 会话历史、分支、压缩 | `pi-coding-agent` `SessionManager`、`AgentSession`、compaction | **换成 Pi / 已用** | 1.5.0 明确 SessionManager 是唯一权威；`prehydrate` 和续跑都改为 manager entries。 |
| 系统提示冻结、prompt bundle | Pi 1.5.0 `SystemMessage.sections` / `before_agent_start` | **保留 Himawari** | Pi 默认对 `openai-completions` 折叠中途 system 消息到开头；section 变化会改头。Himawari 的 bundle 冻结是硬规则。Pi 只作为传输/投影。 |
| 出口遮盖、占位符还原 | 无对应 | **保留** | Pi 没有 redaction/restore。`egress-context` 的图例进冻结 bundle；`ModelEgress` 保留。 |
| 权限、审批、挂起恢复 | Pi `tool_call` hook 只能 block；无内置权限系统 | **保留** | Pi README 明确没有权限系统；审批状态、挂起、恢复、审计是产品职责。用 Pi hook 做执行期拦截，状态仍归 Himawari。 |
| 工具批次续跑 | Pi `SessionManager` + `agent.continue()` + `agent_before_settle` | **保留薄层 + 换成 Pi 的存储** | Pi 没有“审批暂停”概念；快照 v3 用 `SessionManager` entries，replay 仍由 Himawari 控制。 |
| 历史预填、legacy 迁移、native history 校验 | Pi `Message`/`SessionManager`/`convertToLlm` | **换成 Pi 的表示 + 保留校验** | 运行时表示全部用 Pi 类型；`pi-native-history` 只保留不可信边界校验；legacy 迁移是一次性工具。 |
| 压缩 | Pi compaction | **换成 Pi / 已用** | 已用 Pi compaction；规则 13 的“压缩请求沿用原系统提示”仍是已知差距，1.5.0 的 `CompactionEntry.systemMessage` 可作为后续改进，但本次不改。 |
| 重试、失败切换 | Pi auto-retry（已关闭） | **保留 Himawari** | 已设 `retry: { enabled: false }`；OpenClaw 也关闭 Pi 内置重试，避免嵌套 SDK 重放失败工具调用。 |
| 工具死循环检测 | 未见等价能力 | **保留** | `pi-tool-progress-guard` 是产品策略（文件冲突、重复结果）；Pi 文档未给出等价物。未核实 Pi 全源码，故不当成“已有”。 |
| 内置 read/bash/edit/write/grep/find/ls | Pi built-in tool definitions | **换成 Pi / 已用** | 执行和 schema 用 Pi；只替换产品不允许的文案（`himawariBuiltinToolText`）。 |
| bwrap 沙箱、出口代理、主机守护 | 无对应；Gondolin 是独立仓库 | **保留** | Pi 不做 sandbox；`runtime-sandbox` 是硬规则的一部分。 |
| MCP 客户端 | `pi-mcp`、`createMcpExtension` | **以后再评估** | Pi 有独立 MCP 客户端，但当前 MCP 在 `platform-node`，受“只有 runtime-pi 能导入 Pi”限制。要换需单独提出边界调整，并验证 capability runtime 的授权模型。 |
| 会话/检查点/后台任务/提醒持久化 | `pi-durable`（SQLite/JSONL、resume、sleep/wake、task graph、compaction、usage） | **以后再评估，本次保留** | `pi-durable` 是 Experimental，API 不承诺稳定；且没有 Himawari 的审批暂停、数据分级、审计语义。可作为后续独立试点替换部分任务图/睡眠，不是本次升级。 |
| 模型路由、备选、预算准入 | `ModelRuntime` + 产品路由 | **保留 Himawari** | Pi 提供模型运行时和 provider 路由原语，但不提供产品级的预算、准入、备选顺序、成本观察。 |
| 遥测/指标 | `pi-telemetry` 契约，无 exporter | **以后再评估** | 可采纳契约类型，但当前 `runtime-observability` 已满足产品观测；不要为了“用 Pi”引入一个空契约层。 |
| 终端 UI | `pi-tui` | **不适用** | Himawari 有自己的控制中心；不重复实现 TUI。 |
| 插件宿主/RPC | `chord` | **以后再评估** | 当前没有同类需求；引入成本大于收益。 |
| codemode | `pi-codemode`（QuickJS，只能调注入工具） | **保留 Himawari 沙箱** | codemode 不能替代 bwrap 的文件/网络边界；它是工具编排沙箱，不是执行环境沙箱。 |
| JSON Schema 校验 | `pi-schema` | **换成 Pi** | 1.5.0 工具参数已用 pi-schema；如产品侧还有独立 JSON Schema 校验，优先用 pi-schema，不自己写。 |
| 远端执行 | `pi-env` | **不适用** | 当前主机守护/SSH 不是 Pi 的 env 模型；不换。 |

---

## 四、考虑过但不选的做法及原因

1. **直接用 Pi 1.5.0 的 `SystemMessage.sections` + `toolsAdded/toolsRemoved` 做提示和工具的增量更新**
   - 不选：`openai-completions` 默认 `supportsMidConvoSystemMessages: false`，Pi 会把中途 system 消息折叠到 leading system message。工具或 section 一变，头就变。Himawari 的硬规则是冻结，不是“增量尽量少变”。
   - 例外：如果将来只加支持 true 的 provider（如 Anthropic/Responses），可以重新评估；但当前 `configured-model-binding.ts:214` 只允许 `openai-completions`。

2. **把 `session.agent.state.messages` 继续当作恢复入口**
   - 不选：0.87 起它不再是未来请求历史。试升中的 `pi-tool-batch-continuation` 失败就是这个原因。必须用 `SessionManager`。

3. **把系统提示和 compaction `systemMessage` 持久化进产品历史**
   - 不选：会引入旧提示词快照，和当前冻结 bundle 冲突；也会让 `pi-native-history` 必须接受 system 角色，削弱现有安全边界。改为捕获时过滤 system 消息，提示始终由冻结 bundle 重建。

4. **把出口遮盖图例继续在每次请求时拼到 `context.systemPrompt`**
   - 不选：1.5.0 没有 `context.systemPrompt`；而且在请求时拼接会让图例文字变化影响旧对话头。放进冻结 bundle 一次解决。

5. **改用 `pi-durable` 直接替换 application 的检查点/后台任务/提醒**
   - 不选（本次）：Experimental、API 不稳定；没有审批暂停语义；迁移会牵动 SQLite schema、数据分级、审计、预算。列为后续独立评估。

6. **把 MCP 客户端换成 `pi-mcp`**
   - 不选（本次）：受导入边界限制；MCP 当前服务 `platform-node` 的 capability runtime，换包需要改边界并重做授权/审批接线。

7. **保留 0.84.2 的嵌套 pi-ai 或做双版本兼容**
   - 不选：1.5.0 已只剩一份；双版本会让类型和运行时行为分叉，违背精确锁定。

---

## 五、风险与反例

| 风险 | 反例 | 缓解 |
|---|---|---|
| Pi 的 section/tool 更新改写头 | 对话中途加一个非 handle 工具，Pi 生成 system patch；`openai-completions` 折叠后 leading system message 多了该工具 | 只用冻结 bundle 的工具集；handle 工具是唯一允许的追加；gate 反向用例必须检查“非 handle 工具变化导致头变化”会失败 |
| 历史里持久化 system 消息 | 旧 bundle 的 system prompt 被 replay，和新 bundle 冲突；`pi-native-history` 拒绝 system 导致下一轮 `PI_HISTORY_MESSAGE_INVALID` | 捕获时过滤 system；测试“capture 后 history 不含 system”；保留 elevated-role 反向用例 |
| 续跑 v2 在 0.87 后失效 | 部署时挂起的审批恢复后，`agent.state.messages` 赋值不改变 SessionManager，模型看到不同前缀，可能重复调用工具 | v3 用 entries；保留 v2 读取兼容；`inspect` 输出不变；反向用例覆盖删除/重排/重复 tool result |
| 非 JSON 工具值 | `details` 里 `undefined` 字段在不同轮次出现/消失，`JSON.stringify` 字节不同；或 `BigInt` 直接抛错 | `toJsonObject` 边界；生产/消费两端测试；字段构造时省略 undefined |
| 工具顺序不稳定 | `listAuthorized` 返回顺序变化，handle 工具追加顺序变化，工具定义数组字节变化 | 冻结 bundle 存 JSON 数组；handle 工具按固定 key 排序；gate 检查工具数组逐字节 |
| 图例变化改旧对话头 | 以后改 `CHAT_EGRESS_LEGEND_WITH_RESTORE` 文案，旧对话每次请求重新拼图例 | 图例进 bundle；改文案只影响新对话 |
| overflow recovery 改写历史 | Pi 自动 `context_edit` omission 删除失败尝试，违反只追加 | 在 ADR 中归入压缩/恢复例外；gate 区分普通轮次和 overflow；或关闭该恢复 |
| 内置工具文案漂移 | 1.5.0 bash 描述改成 “Shell command to execute”，`pi-builtin-tool-text` 漂移测试失败 | 更新预期到 1.5.0；重新评估 `contradictions()`，不保留过时断言 |
| 只测类型不测消费者 | v3 快照 `inspect` 字段变了，`production-tool-result-recovery` 读不到 `waitingToolCallId` | I-73 式测试：生产者 → 每个消费者逐字段校验 |

---

## 六、需要人拍板的取舍

1. **是否接受升级时所有旧对话请求头变一次**：Andy 2026-11-09 已说不用为旧聊天记录做兼容，但 ADR 要明确记录。建议接受，并只此一次。
2. **续跑 v2 是否保留读取兼容**：建议保留一个发布周期，避免部署时挂起的审批失效；一个周期后删除 v2 分支。
3. **出口图例放 bundle 还是请求时注入**：建议放 bundle（旧对话只变一次，之后稳定）；代价是 prompt bundle 的 `systemPromptSha256` 变一次。
4. **overflow recovery 的 `context_edit` omission 是否算“压缩类例外”**：建议算，并在 ADR 写明；如果不接受，需要关闭 Pi 的自动 overflow recovery 或改用自定义 `session_before_compact`。
5. **是否允许改“只有 runtime-pi 能导入 Pi”以采用 `pi-mcp`**：建议另开提案，不夹在本次升级。
6. **`pi-durable` 是否做试点**：建议本次不做；后续单独评估其任务图/睡眠/恢复能否替换 application 的一部分。
7. **`legacy-pi-history` 的下线时间**：需要业务确认历史数据覆盖范围。

---

## 七、已证实与推测分开

**已由代码或一手来源证实：**
- 1.5.0 的 `TranscriptContext`、`SystemMessage`、`ToolCall.arguments: JsonObject`、`ToolResultMessage.details` 限定 JSON（Pi `types.ts`）。
- `openai-completions` 默认 `supportsMidConvoSystemMessages: false`（`openai-completions.ts:1671`）。
- SessionManager 是最终上下文权威，`agent.state.messages` 不再替换未来历史（Pi `sdk.md`）。
- `session.systemPrompt` 只读（Pi `sdk.md`）；`before_agent_start` 仍可返回 `{ systemPrompt }` 并触发 `forceSystemPrompt`（Pi `runner.js`）。
- `appendCompaction` 自动捕获 `systemMessage`；`SessionManager.inMemory(cwd, options, entries)` 存在（Pi `session-manager.ts`）。
- Pi 没有内置权限系统（Pi `README.md`）。
- `pi-durable` 是 Experimental（`packages/durable/README.md`）。
- Himawari 当前依赖 `requested.tools`、可写 `systemPrompt`、native history 拒绝 system（Himawari 源码与测试）。
- prompt-prefix gate 要求 8 条 `[I-66]` 通过，并有反向用例（`check-prompt-prefix.mjs`、`prompt-prefix.compat.test.ts`）。

**推测或未核实：**
- Pi 1.5.0 是否在所有代码路径上都有工具死循环检测：未核实；README/SDK 文档未见等价能力，故暂时保留 Himawari 的 guard。
- Magpie/Vercel AI Gateway 是否支持中途 system 消息：未核实；按默认“不支持”处理，不设 `supportsMidConvoSystemMessages: true`。
- `before_agent_start` 强制提示 + `_preparePromptAndToolLoadout` 是否会在某些路径额外生成 system patch：源码显示会被 forced projection 替换，但需 gate 实测确认。
- `executionTiming` 等 `details` 字段是否全为 JSON 值：未逐字段核实，需 PR-3 的边界函数和类型审计确认。
- 所有 `listAuthorized` 工具顺序是否稳定：未核实 SQL/Map 顺序，需排序或由 bundle 冻结。
- `appendCompaction` 自动 `systemMessage` 对请求字节的实际影响：源码分析认为 provider 只用 content/tools，timestamp 不参与序列化；需测试确认。

---

## 八、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加？每轮会变的值是不是都在最后一条消息里？

**会变一次，然后应保持只追加。**

- **升级本身**：1.5.0 把 `Context` 折叠成 `TranscriptContext`，系统提示和工具改由 `SystemMessage` 承载；`appendCompaction` 还会生成 `systemMessage` 快照。对旧对话，第一次升级后的请求头会变一次。依据：Pi `types.ts`、`ai/README.md` “System Messages”、`session-manager.ts`。这符合 `.claude/rules/prompt-prefix.md:35` 的例外精神（升级可让所有对话的请求开头变一次），但必须写进 ADR。
- **升级后同一对话内**：只要按本方案实施，发给模型的内容仍然只在末尾追加：
  - 系统提示：由冻结的 prompt bundle 提供，`before_agent_start` 每轮返回同一段完整文本；`forceSystemPrompt` 只是把同一段文本投影到 leading system message。
  - 工具定义：冻结工具来自 `bundle.tools`，顺序固定；handle 工具是规则 7 允许的“出现/消失那轮头变化”的例外；不再把新出现的非 handle 工具加入 active tools。
  - 历史消息：`prehydrateSession` 和 `SessionManager` 只追加；不赋值 `agent.state.messages`，不用 `context_edit` 改普通历史。
  - 遮盖结果：图例进冻结 bundle；遮盖规则集按对话冻结（`bundle.redactionRuleset`），不在中途切换。
- **每轮会变的值**：当前 `turnPrompt`（`pi-runtime-adapter.ts:600-618`）把时间、记忆/资料块、运行环境放在最后一条 user message；`runtime-environment-block.ts:123-133` 在压缩后环境变化时追加 custom message。升级后不要把这些值放进 `SystemMessage.sections`，也不要让 Pi 的 section diff 把它们带到头部。
- **关键依据**：`.claude/rules/prompt-prefix.md:35`（只追加）、`:41`（冻结）、`:44`（工具集合尽量不变，handle 工具例外）、`:84`（头会变就停下来出方案）。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**设计上不会；但有三处必须主动防。**

- **会用 Pi `SystemMessage.sections`**：会。Pi README 明确说 sections 是 JSON 对象，整数样式的 key 会被重排。Himawari 方案不使用 sections，冻结提示用单个 `content` 字符串。
- **工具数组顺序**：会。`toolsAdded`/`toolsRemoved` 和工具定义数组必须按固定顺序（冻结 bundle 的 JSON 顺序 + handle 工具按稳定 key 排序）。不能依赖 `listAuthorized` 的数据库/Map 返回顺序。
- **JSON 参数/详情**：会。1.5.0 要求 `ToolCall.arguments`、`ToolResultMessage.details` 是 JSON 值；`undefined` 字段会被 `JSON.stringify` 丢弃，导致同一逻辑对象在不同轮次字节不同；`BigInt`/`Map` 会抛错或序列化成意外值。用 `toJsonObject` 在边界规范化和拒绝。
- **时间字段**：请求里的时间只应出现在最后一条 user message（`turnPrompt`）。`SystemMessage.timestamp` 不参与 provider 序列化（OpenAI completions 的 `convertMessages` 只用 content/tools），但不要把时间写进 system content。
- **遮盖**：现有遮盖是确定的，规则集冻结；图例进 bundle 后不会因请求时拼接而变化。依据：`.claude/rules/prompt-prefix.md:51-52`、`:54`。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，但需要补三类。**

现有：
- `npm run check:prompt-prefix` 运行 `[I-66]` 测试，要求至少 8 条通过；`scripts/check-prompt-prefix.mjs:8-10`、`:43-47`。
- `prompt-prefix.compat.test.ts` 已有反向用例：改写历史用户消息、系统提示带每轮变化的值、关闭冻结、切换遮盖规则集、删除/重排/缩短历史。它们通过 `findConversationBreak`/`findPrefixBreak` 断言失败。
- `pi-tool-batch-continuation.compat.test.ts` 已有反向用例：删除/重复 completed result、改 toolCallId、改 toolName、把 details 改成 `result_unknown`，都必须抛 `PI_CONTINUATION_RESULTS_INVALID`。
- `pi-native-history.compat.test.ts` 已有 `role:"system"` 作为 elevated-role 反向用例。
- `pi-builtin-tool-text.compat.test.ts` 有 Pi 原文漂移反向用例。

需要补：
1. **1.5.0 真实路径**：`before_agent_start` 强制完整提示 + `SessionManager` 预填下，改 `systemInstruction`/工具集，头字节不变；反向：去掉强制提示或让 section 变化进入头部，gate 必须失败。
2. **续跑 v3**：删除/重排/重复 prefix entry、注入 system message、改 assistant、改 completed result，`restorePiToolBatch` 必须失败；v2 旧快照仍能恢复。
3. **SystemMessage/历史边界**：捕获后 history 不含 system；如果人为把 system 消息放进 native history，必须被拒绝。
4. **JSON 边界**：`undefined`/`BigInt`/`Map` 参数被拒；反向：直接 `as Record<string, unknown>` 会让测试通过但运行期序列化失败，这个反向用例要能抓住。

**反向用例是否真的会失败**：现有反向用例是“修改数据后调用检查函数并期望失败”，只要我们在 PR 中不删掉它们、并更新到 1.5.0 真实路径，它们会真的失败（不是只断言成功）。PR-2 必须把 `check:prompt-prefix` 的 `REQUIRED` 数量维持或提高，不能通过删测试过门槛。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对如下：

| 值 | 产生处 | 使用处 | 两端是否接受 |
|---|---|---|---|
| `pi-tool-batch.v3` 快照 | `capturePiToolBatch` | `restorePiToolBatch`、`inspectPiToolBatch`、`production-tool-result-recovery.ts:226`、`RuntimeContinuationService.save/load` | `restore` 需同时接受 v2/v3；`inspect` 输出字段保持不变；`RuntimeContinuationService` 把 value 当不透明 JSON，接受。 |
| `prefixEntries`（SessionManager FileEntry） | `capturePiToolBatch` | `SessionManager.inMemory(cwd, {id}, entries)`、`inspect` | 必须是合法 FileEntry；header id 要过 `assertValidSessionId`；`inspect` 不向产品暴露 entry 结构。 |
| `SystemMessage.sections/toolsAdded/toolsRemoved` | Pi 1.5.0（若使用） | `openai-completions` 的 `convertMessages`/`collapseSystemMessages` | 本方案不使用 sections；工具数组必须稳定排序。 |
| `ToolCall.arguments` | 模型输出、`projectedMessage`、`safeArguments` | Pi 的 `validateToolArguments`、`pi-tool-batch-continuation.inspect`、`production-tool-result-recovery`（等待工具的参数） | 必须是 `JsonObject`；`toJsonObject` 在边界保证。 |
| `ToolResultMessage.details` | `createTool`（`:2043-2055`）、Pi 内置工具 | `previousFileConflict`（`productRunId/productOutcome/errorCode`）、`pi-tool-progress-guard`（`errorCode`）、`captureHistory`（JSON） | 必须省略 `undefined`，所有字段是 JSON 值；禁止 `Map/Set/Date/BigInt`。 |
| `redactionRuleset` | `ThreadPromptBundleService.#rulesetFor` | `admitPiStream` → `egress.exchange` | 整数，跨包接受；不要在对话中途变。 |
| `bundle.systemPrompt`（含图例） | `productSystemPrompt` + `EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE` | `ThreadPromptBundleService.#create/#open` 的 `systemPromptSha256`、`before_agent_start`、Pi `SystemMessage.content` | 都是字符串；`#open` 校验 sha256；测试需覆盖“含图例的候选能存能读”。 |
| `piSessionId` | `prehydrateSession` 的 sha256 | `SessionManager.inMemory(cwd, { id })`、`assertValidSessionId` | 十六进制，合法；不要包含每轮变化的值。 |
| `modelRef` / `servedModel` | 产品模型清单、`x-magpie-model` | `configured-model-binding.resolve`、`servedModelFromHeaders`、I-73 的 `modelRefString` | 本次不改；升级不应改变斜杠/冒号规则。跑 `check:model-ref-contract`。 |
| `builtin command/timeout` 文案 | `pi-builtin-tool-text.ts` + prompt catalog | 模型工具定义、`pi-builtin-tool-text.compat.test.ts` | 1.5.0 改文案后必须同步测试和 catalog；否则测试失败或模型看到旧文案。 |

---

## 九、参考资料

- Pi v1.5.0 README：https://github.com/earendil-works/pi/blob/v1.5.0/README.md
- Pi v1.5.0 `packages/ai/README.md`：https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/README.md
- Pi v1.5.0 `packages/ai/src/types.ts`：https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/types.ts
- Pi v1.5.0 `packages/ai/src/api/openai-completions.ts`：https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/api/openai-completions.ts
- Pi v1.5.0 `packages/coding-agent/docs/sdk.md`：https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/sdk.md
- Pi v1.5.0 `packages/coding-agent/docs/compaction.md`：https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/compaction.md
- Pi v1.5.0 `packages/coding-agent/src/core/session-manager.ts`：https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/session-manager.ts
- Pi v1.5.0 `packages/coding-agent/src/core/agent-session.ts`：https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/agent-session.ts
- Pi v1.5.0 `packages/agent/src/agent.ts`：https://github.com/earendil-works/pi/blob/v1.5.0/packages/agent/src/agent.ts
- Pi v1.5.0 `packages/durable/README.md`：https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/README.md
- OpenClaw 真实集成：https://github.com/OpenClaw/OpenClaw （材料引用 `CHANGELOG/2026.5.22.md:29`、`:255`）
- Himawari 规则：`.claude/rules/prompt-prefix.md`
- Himawari 事故：`docs/incidents-and-gates.md:112`
- Himawari 导入边界：`.agents/instructions/pi-and-workspace.md:26`
