我先读仓库关键文件和规则，再对照 Pi 1.5.0 源码，最后给出方案。
现在去读 Pi 1.5.0 的一手源码和文档。
类型定义已到手。继续读 README 的 System Messages 段和 coding-agent 的 SDK 文档。
现在核对 Himawari 侧的受影响点与检查用例。
再核对 Pi 1.5.0 的 AgentState 结构和 openai-completions 的默认 compat。
我已读够材料，下面给出方案。凡标注「材料」「文件：行」的来自本仓库或已抓取的 Pi 1.5.0 源码/文档；标注「推测」的是未逐行核实的部分。

---

# Himawari 升级 Pi 0.84.2 → 1.5.0 方案

## 一、方案依赖的前提（已证实的）

| # | 前提 | 来源与原话 |
|---|------|-----------|
| P1 | 1.5.0 的 `StreamFunction` 收到的是 `TranscriptContext`，只有 `messages`；系统提示和工具住在 transcript 的 system 消息里，`normalizeContext()` 在公共入口把 `Context.systemPrompt/tools` 折进开头一条 system 消息 | pi-ai v1.5.0 `packages/ai/src/types.ts`："`TranscriptContext = { messages: Message[]; readonly [transcriptContextBrand]: true }`"、"`normalizeContext()` folds them into one"；README "System Messages"："`context.systemPrompt` and `context.tools` do not exist at that layer"（https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/README.md） |
| P2 | 1.5.0 的 `AgentState.systemPrompt` 变成只读 getter（`getCurrentSystemPrompt(messages)`）；`state.tools`、`state.messages` 仍是可写 setter（赋值会拷贝顶层数组） | pi v1.5.0 `packages/agent/src/agent.ts`："`get systemPrompt() { return getCurrentSystemPrompt(messages); }`"、"`set messages(nextMessages)…`" |
| P3 | `openai-completions` 默认 `supportsMidConvoSystemMessages: false`，中途 system 消息会被 `resolveTranscript` 折叠回开头一条；折叠是确定性的（按消息重放） | pi v1.5.0 `packages/ai/src/api/openai-completions.ts:1671`（`supportsMidConvoSystemMessages: false`）；README："Every other model receives `collapseSystemMessages(transcript)`: the replayed prompt and current tools as the leading system message, with later system messages dropped" |
| P4 | SessionManager 是会话语境的权威；“给 `session.agent.state.messages` 赋值不再替换未来请求的历史”；恢复外部历史要用含这些条目的 manager 构造会话 | pi-coding-agent 0.87.0 CHANGELOG 及 v1.5.0 `packages/coding-agent/docs/sdk.md`："Restore external history by constructing the session with a manager containing those entries. Assigning `session.agent.state.messages` does not replace persisted context." |
| P5 | Pi 的压缩请求“禁用提示缓存写入”，且把对话序列化成一条消息总结——规则 13 的已知差距（压缩请求不沿用原对话开头）在 1.5.0 依旧存在 | pi v1.5.0 `packages/coding-agent/docs/compaction.md`："Summarization requests disable prompt-cache writes because these one-off prompts are unlikely to be reused." |
| P6 | Himawari 现状：适配器在 `streamFunction` 包装里读 `requested.tools`、写 `systemPrompt`/`tools`（pi-runtime-adapter.ts:1569-1572）；批次恢复直接写 `state.systemPrompt`/`state.messages`（pi-tool-batch-continuation.ts:96-97）；遮盖图例改写 `context.systemPrompt`（egress-context.ts:15-21）；冻结提示/工具由 prompt bundle + `systemPromptOverride` + 内联扩展 `himawari-system-prompt` 落实（pi-runtime-adapter.ts:1366-1424） | 本仓库文件：行 |
| P7 | 挡板已存在且带反向用例：`npm run check:prompt-prefix`（package.json:54，`scripts/check-prompt-prefix.mjs`），反向用例在 `packages/runtime-pi/test/prompt-prefix.compat.test.ts:549,610,626,690,700,788`（改写用户消息、系统提示带每轮变的值、不冻结、删/重排/缩短历史）；内置工具文字漂移由 `pi-builtin-tool-text.compat.test.ts:106,123`（C6/C10 REVERSE）把住 | 本仓库文件：行 |
| P8 | 试升（只改版本号）tsc 8 处错、runtime-pi 48/405 条测试失败，集中在上述 P6 的三处写法和内置工具描述文字 | 本次材料“试升结果” |
| P9 | Himawari 代码里没有用到 `shouldStopAfterTurn`、`telemetryContext`、TypeBox（全仓 grep 无匹配）→ 这三项破坏性改动对 Himawari 零影响 | 本仓库 grep 结果 |
| P10 | 只允许 `packages/runtime-pi` 导入 Pi 包（`.agents/instructions/pi-and-workspace.md`）；Node 锁 22.22.3 ≥ 1.5.0 要求的 22.19 | 本次材料、`ci/toolchain-lock.json`（材料给出，未逐行核实） |

---

## 二、方案

### 2.1 升级拆分（4 个 PR，可独立合并且每步测试全过）

**PR-1：pi-ai 层适配（TranscriptContext）**
- `pi-runtime-adapter.ts:1569` 的 streamFunction 包装：不再读 `requested.tools`。改为：入参即 `TranscriptContext`；用 `getCurrentSystemPrompt(transcript.messages)` / `getCurrentTools(transcript.messages)`（pi-ai 导出，见 P1）读出当前提示与工具，**校验**它们等于冻结 bundle 的值（不等则 fail-closed，返回 `failedPiStream`），然后构造要发给 `originalStreamFunction` 的 transcript：开头 system 消息 = 冻结提示 + 遮盖图例（P6 的 `withPlaceholderLegend` 改为作用于开头 system 消息的 content，egress-context.ts:15-21 同步改），`toolsAdded` = 冻结工具 + 本轮 handle 工具。这一层只做“校验 + 确定性重写”，不再引入第二个真相来源。
- `clampMaxTokensToContext(model, context, …)`（pi-runtime-adapter.ts:930）：入参换成 TranscriptContext，语义不变。
- `prepare-file-mutation.ts:64`、`sandboxed-coding-executor.ts:54`：补 `JsonObject`/JSON 值类型约束（0.86.0 起 `ToolCall.arguments`、`details` 限定 JSON 值）。`details` 里 Himawari 现在放的 `productRunId/productOutcome/errorCode/executionTiming/resultRef/externalActionId` 都是 JSON 值，预判可直接过；「推测：`resultRef` 为 null 时仍在 JSON 值范围内，无阻塞」。
- `egress-context.ts` 的 `backgroundModelContext` 保留 `Context` 形态（公共入口仍收 `Context`，P1）。

**PR-2：pi-tool-batch-continuation 改为 transcript 级恢复**
- 删除 `state.systemPrompt` 写入（只读，P2）。批次快照改为存 transcript 形态：`prefix + assistant + completedResults` 外加**开头 system 消息**（由捕获时的 `getCurrentSystemMessage` 取得）。恢复时一次性赋 `state.messages = [systemMessage, ...prefix]`（P2 允许，赋值拷贝顶层数组），`takeReplay()` 不变。
- 版本号从 `pi-tool-batch.v2` 升到 `v3`；`validateSavedBatch` 同时接受校验 v3、拒绝 v2 之外随意值——按 I-73 的教训，**产生端（capturePiToolBatch）和使用端（validateSavedBatch、inspectPiToolBatch、application 的 continuations 存取）两端一起改、一起测**，反向用例：拿 v2 存量喂 v3 校验必须报 `PI_CONTINUATION_VERSION_INVALID`。
- 恢复后仍走 `session.agent.continue()`；「推测：同 run 内恢复不涉及 SessionManager 持久层替换（P4 针对的是跨会话恢复历史），但要在 PR 里加一条测试：恢复期间 `captureHistory` 落库的内容与恢复前逐字节一致」。

**PR-3：挡板与快照更新**
- `prompt-prefix.compat.test.ts` 等 19 条 `PI_RUNTIME_ERROR` 用例随新写法修复；反向用例（P7）**原样保留**，并新增两条：①中途出现非开头的 system 消息必须被判为破坏；②handle 工具增减的那一轮，messages 部分逐字节不变、只有 tools 参数变。
- 内置工具描述漂移（“Shell command to execute”）：由 C6/C10 反向用例暴露后**人工拍板**（见 2.3），拍板后更新 `pi-builtin-tool-text.ts` 快照并在 ADR 里记录“请求开头变一次”。

**PR-4：版本号 + ADR + 文档**
- 两包版本号改 1.5.0、`package-lock.json` 重锁（精确锁定）；确认安装后只剩一份 pi-ai（材料：0.84.2 时有嵌套副本）。
- 新 ADR：升级导致所有对话请求开头一次性变化（工具文字、参数 schema 序列化、可能的折叠行为），Andy 2026-11-09 已同意不为旧聊天记录做兼容；同时记录 P5（压缩缓存差距在 1.5.0 仍在，见对照表第 12 行）。
- 更新 `.agents/instructions/pi-and-workspace.md` 与 kv-cache-guide 里引用旧行为的段落（规则 61 行“Pi 现在的压缩…”措辞核对后改写）。

### 2.2 对照表：Himawari 自有功能 vs Pi 1.5.0

| # | Himawari 自有 | Pi 1.5.0 对应 | 结论 | 理由 |
|---|---|---|---|---|
| 1 | 会话创建、历史预填 `prehydrateSession`、投影→Pi 消息 | `SessionManager.inMemory(cwd,{id},entries)` + `createAgentSession`（sdk.md） | **换成 Pi**（PR-2 顺手改） | 0.87.0 起 manager 支持 `entries` 直传，`appendMessage` 逐条拼可简化；恢复语义回到官方推荐路径 |
| 2 | streamFunction 包装（准入、遮盖、预算、重放） | 无（Pi 只留 `StreamFn` 扩展点） | **保留** | 这就是 Himawari 主权的接入点 |
| 3 | 系统提示/工具冻结（prompt bundle + `systemPromptOverride`） | 1.5.0 的 system 消息/`sections`/`toolsAdded` 机制 | **保留我们的机制，落点换成 Pi 的 transcript 形态** | 冻结判断（何时换新）是产品规则（规则 6），Pi 只提供“怎么表达”，不提供“何时变” |
| 4 | 出口遮盖/还原（egress-context、egress exchange） | 无 | **保留** | Pi README 明说无权限/遮盖体系 |
| 5 | 工具审批挂起/恢复（pi-tool-batch-continuation、suspend/checkpoint） | pi-durable 的任务 sleep/wake | **保留**；pi-durable 以后再评估 | pi-durable README 开头 "Experimental. The API changes without notice between releases."，且数据自持要求自有 SQLite；审批-恢复与 Himawari 授权链耦合 |
| 6 | Pi 自带 compaction | Pi compaction（compaction.md） | **继续用 Pi 的** | 已在用（settings `compaction.enabled: true`，pi-runtime-adapter.ts:1360）；缓存差距见第 12 行 |
| 7 | 压缩请求缓存差距（规则 13：压缩不沿用原开头） | 1.5.0 仍"disable prompt-cache writes"（P5） | **以后再评估** | 可用扩展 `session_before_compact` 自定义总结请求使其沿用冻结提示（compaction.md 有扩展钩子和示例），但收益要先算总费用（规则 12），另出方案 |
| 8 | 工具死循环检测 pi-tool-progress-guard | 无 | **保留** | Pi 无此功能 |
| 9 | 模型绑定/动态清单（configured-model-binding，只走 openai-completions，经 Magpie/Vercel Gateway） | pi-ai provider 体系、`createProvider`、动态 catalog | **保留** | 绑定含准入定价、secret、fail-closed 校验（I-73 教训）；Pi 的 provider 体系可作底层（现在就是 `ModelRuntime.create`），不替换 |
| 10 | Pi 自带重试 | Pi auto-retry | **保留关闭**（`retry.enabled:false`，pi-runtime-adapter.ts:1361） | application 层有自己的重试/备选路由；嵌套重试会重放失败工具调用（OpenClaw 同款问题，材料 2026.5.22 :255） |
| 11 | governed-coding-tools / governed-host-operations / host-read-only-executor | Pi 内置 bash/read/edit 等工具本体 | **保留包装、工具本体用 Pi** | 现状即“用 Pi 的工具 schema + 自己的执行端”，这正是主人的要求；已满足 |
| 12 | runtime-sandbox（bwrap + 出口代理） | gondolin（Alpine 沙箱） | **以后再评估** | 换沙箱是主机/部署层大改，bwrap 已满足硬规则；gondolin 单独仓库、独立评估 |
| 13 | platform-node 的 MCP 客户端（官方 `@modelcontextprotocol/client`） | pi-mcp | **以后再评估** | 功能等价处 Pi 无明显增益；换用需改“只有 runtime-pi 能导入 Pi”的规则（约束要求单独提出），收益不抵成本 |
| 14 | persistence-sqlite | pi-durable（SQLite/JSONL、resume） | **保留** | 同第 5 条：experimental + 数据自持 + 自有迁移体系 |
| 15 | cache-usage-observation / gateway-observation | pi-telemetry（契约、无导出器） | **以后再评估** | 契约可以以后对齐；Himawari 需要的是自家门槛指标（`cache.follow_up_low_hit`），Pi 无导出器，接了也要自己写 |
| 16 | sandboxed-coding-executor 里的模型代码执行 | pi-codemode（QuickJS 跑模型 JS，只能调注入工具） | **保留** | codemode 是“模型写 JS 沙箱执行”，与 Himawari “审批过的命令经 bwrap+出口代理”不是同一威胁模型；不满足用户主权硬规则 |
| 17 | TypeBox/pi-schema | pi-ai 1.5.0 用 pi-schema | **无自有代码，顺带用 Pi 的** | P9：Himawari 未用 TypeBox，参数本就是 JSON Schema，pi-schema 直接接受（README Tools 节） |
| 18 | pi-tui / chord / 插件宿主 | — | **不用** | Himawari 有自己的 UI 与进程编排，无对应需求 |
| 19 | legacy-pi-history / pi-native-history | Pi session format | **保留**（PR-1 适配） | 它们就是迁移/桥接层，升级后按新 session format 校验一遍 |

### 2.3 考虑过但不选的做法

1. **像 OpenClaw 那样把 Pi 运行时内化、删包依赖**——不选。OpenClaw 是在自身规模下为掌控运行时做的（材料 CHANGELOG/2026.5.22.md:29）；Himawari 现在的痛点是版本适配而非运行时失控，且 Pi 1.5.0 的官方 SDK 路径（SessionManager canonical、transcript system 消息）恰好与 Himawari 的冻结/追加规则同向。内化意味着放弃上游修复，代价最大。
2. **在旧写法上做 shim（比如继续往 `Context.systemPrompt` 塞值、把 TranscriptContext 当 any 绕过）**——不选。1.5.0 的类型层就是为防这个（`transcriptContextBrand`，"a raw `Context` cannot reach provider code by accident"，P1）；绕过等于把缓存正确性押在未类型化的路径上，I-73 的教训是“双端校验缺失”而非“类型碍事”。
3. **用 Pi 的 mid-convo system 消息表达 handle 工具增减**——不选。`supportsMidConvoSystemMessages:false` 时会折叠回开头（P3），折叠结果与“直接把 tools 放进开头 system 消息”等价，但多一层重放逻辑；保持“toolsAdded 进开头消息、openai-completions 提到顶层 tools 参数”更直、且与 ADR 0165 已记账的代价一致。
4. **升级顺带换 MCP 客户端/沙箱/持久化**——不选。一次 PR 只付一次回归代价；换这三样各自是独立取舍（对照表 12/13/14）。

### 2.4 风险与反例

- **反例 1（缓存静默失效）**：若 PR-1 里新 streamFunction 不校验、直接把收到的 transcript 透传，Pi 侧任何将来对折叠/重放的改动都会悄悄改变请求开头。对策：fail-closed 校验（方案 2.1 PR-1）+ PR-3 反向用例 ①。
- **反例 2（继续器两端口径不一，I-73 重演）**：`pi-tool-batch.v3` 只改了 capture 端、忘改 `inspectPiToolBatch` 或 application 侧存取 → 生产恢复失败。对策：双端同 PR、反向用例（v2 输入必须被拒）、`check:prompt-prefix` 全量跑。
- **反例 3（遮盖图例错位）**：`withPlaceholderLegend` 若仍写 `context.systemPrompt`（该字段在新 transcript 上不存在）会静默丢图例 → 敏感信息还原失败。对策：PR-1 中该函数改为作用于开头 system 消息，`pi-model-transport.unit.test.ts` 已有 [W-31] REVERSE（:564）兜底。
- **风险**：上线时若有挂起的审批批次（continuation 为 v2），升级后无法恢复。拍板项：上线前清空挂起批次或按“旧聊天记录不兼容”一并放弃（见 2.5）。

### 2.5 需要人拍板的取舍

1. **内置工具描述文字**：跟随 Pi 1.5.0 新文字（更新快照 + 老对话换新一次）还是保持旧文字（快照钉死）。推荐前者：快照本来就该贴着上游。
2. **上线时挂起的 v2 continuation**：放弃（随“不为旧记录兼容”）还是写一次性迁移。推荐放弃，写进同一个 ADR。
3. **对照表 7（压缩请求沿用冻结开头）** 是否列入下一步 backlog：收益=压缩请求本身命中缓存，代价=实现+验证，按规则 12 用总输入费用数据决定。
4. **对照表 13/14/15（pi-mcp、pi-durable、pi-telemetry、gondolin）** 维持“以后再评估”的优先级顺序是否认可。

### 2.6 「已证实」与「推测」分开

**读代码/来源证实的**：P1–P9 全部；对照表中各 Pi 模块的存在性与定位（README Packages 表、pi-durable/gondolin 措辞来自官方仓库）；Himawari 各文件的现状（文件：行）；`shouldStopAfterTurn`/`telemetryContext`/TypeBox 无使用。

**推测（未逐行核实）**：`details` 现有字段全部满足 JSON 值约束（PR-1 中由 tsc 兜底）；同 run 内恢复不触碰 SessionManager 持久层（PR-2 加测试验证）；`ci/toolchain-lock.json` 的 22.22.3 数值与 `systemPromptOverride`/`before_agent_start` 返回 `{systemPrompt}` 在 1.5.0 仍被接受（材料给出、试升未报错，PR-1 以 tsc+测试确认）；Pi 1.5.0 对 `convertToLlm` 中 custom→user 消息的转换字节与 0.84.2 一致（由 PR-3 的逐字节比挡板兜住，不依赖推测）。

---

## 三、必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？**
会，但只有一次，且是全局的：升级让所有对话的请求开头变一次（内置工具描述文字、参数 schema 的序列化、Pi 折叠行为）。这是版本升级固有代价，主人 11-09 已同意不为旧聊天记录兼容，写进 ADR（PR-4）。升级之后的稳态：**是，仍然只追加**——系统提示和冻结工具在对话首请求定型（prompt bundle 按 `identity` 哈希复用，pi-runtime-adapter.ts:1289-1300），后续每轮只追加用户消息/工具结果/后台通知；每轮会变的值（时间、记忆块、运行环境块、本轮资料）都在最后一条消息里（turnPrompt，pi-runtime-adapter.ts:600-619）。handle 工具的增减只改顶层 tools 参数，messages 字节不变（1.5.0 下 tools 从开头 system 消息的 `toolsAdded` 提取、`supportsMidConvoSystemMessages:false` 时送顶层，P3），与 ADR 0165 已记账的代价一致。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
设计目标是不引入新的不确定性，逐项核对：遮盖仍是“只取决于自己和前面的内容”（规则 11 机制未动，PR-1 不改遮盖算法）；工具列表顺序来自冻结 bundle 的 JSON 字符串，`JSON.parse` 保序；Pi 1.5.0 的折叠/重放是确定性函数（P3“replaying every system message in order yields the current prompt and tools”）；新引入的值只有 `pi-tool-batch.v3` 的 transcript 快照（structuredClone，键序固定）和开头 system 消息的构造（纯字符串拼接）。已知且已有豁免的两处不变：点名遮盖的同请求后文遮法（规则 11 例外）、压缩后遮法可能变（规则 12）。**未核实项**：Pi 1.5.0 序列化工具结果/思考块的具体字节变化——由 `check:prompt-prefix` 的逐字节比对在 CI 里证实，不靠人眼。

**3. 有没有对应的自动检查？反向用例会真的失败吗？**
有。`npm run check:prompt-prefix`（package.json:54）是 `npm run check` 的一步，用真实适配器和真实遮盖跑多轮对话并逐字节比前缀，反向用例就在挡板同一个测试文件里（prompt-prefix.compat.test.ts:549 改写用户消息、:610 系统提示写回 workspace、:626 系统提示带每轮变的值、:690/:700 不冻结、:788 删/重排/缩短历史）——这些用例构造的就是违规形态，检查器必须报失败才叫通过；工具文字漂移另有 C6/C10 REVERSE（pi-builtin-tool-text.compat.test.ts:106,123）。**反向用例确实会失败的实证**：试升分支上同一批测试 48 条失败（19 条 `PI_RUNTIME_ERROR`），main 上全过——挡板对这次升级的破坏是真实可检的，这正是把修复拆成 PR-1/2/3、每步跑全量挡板的原因。PR-3 还要按 2.4 补两条新反向用例。

**4. 改动产生/修改的每个值，两端都核对了吗？**
逐个列：
- **`@earendil-works/pi-ai` / `pi-coding-agent` 1.5.0**：产生于 package.json:10-11，使用处仅 runtime-pi 内部（P10 边界规则），Node 版本约束 22.19 ≤ 22.22.3 满足。
- **`pi-tool-batch.v2 → v3`**：产生端 `capturePiToolBatch`，使用端 `validateSavedBatch`、`inspectPiToolBatch`、application 的 continuations 存取、persistence-sqlite 落库——双端同 PR 修改，反向用例拒绝旧版本（I-73 的教训：不能只看改动本身）。
- **`TranscriptContext` 重写后的开头 system 消息**：产生端 streamFunction 包装，使用端是 Pi 的 `resolveTranscript`/`convertMessages`（P1、P3）——校验方式是 fail-closed 比对冻结 bundle + 挡板逐字节比。
- **`himawariBuiltinToolText` 快照更新**：产生端 pi-builtin-tool-text.ts，使用端 `toolDefinition`（pi-runtime-adapter.ts:1877）和 prompt bundle 的 `identity` 哈希——文字变了哈希就变，老对话的 bundle 失配会走既有的换新判定（规则 6），换新条件由 `thread-prompt-bundles.test.ts` 覆盖（规则 74 行）。这条需要 2.5 第 1 项拍板。
- **`identity` 哈希（`pi-session.v1`）**：产生于 prehydrateSession:644，使用于 continuation 绑定校验:1313——本次升级不改其输入成分的语义，若 PR-2 改动传入字段需同步核对两端，方案里已把它列为 PR-2 的检查项。
- **未引入新配置键/清单项**：升级不改 `modelRef`、`redactionRuleset`、权限码等对外值，I-73 类型的“清单 id 过不了后端校验”风险点在本次改动中不存在新增面。
