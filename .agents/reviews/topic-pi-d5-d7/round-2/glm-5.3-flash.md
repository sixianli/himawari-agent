`.agents/reviews/topic-pi-d5-d7/` 不存在（材料里引用的 briefs 和 round-1 无法核对，标记为未核实）。先读核心代码。
现在核对 Pi 1.5.0 的实际实现。先看依赖版本和 node_modules 里的 dist。
node_modules 未安装，Pi 的 dist 本地读不到。先读项目内文档（偏离表、ADR、指南），再尝试网络核对 Pi。
再读几个关键文件：运行环境说明的消息结构、模型绑定（promptCache）、prompt-prefix 检查与相关测试。
本地能核对的已核对。尝试从官方仓库核对 Pi 的 `sendCustomMessage` 行为与 `cacheWarming` 默认值。
GitHub 仓库可访问，搜到了关键 issue（`sendCustomMessage` 与 `agent.continue()` 的状态不同步问题）。再核对仓库内测试覆盖与 Pi 源码关键分支。
再核对 Pi 官方源码/文档中 `sendCustomMessage` 的分支与运行结束后的续跑行为。
官方 sdk.md 已确认「agent_end 后排队的工作仍可能自动续跑」。再确认 `sendCustomMessage` 在会话空闲、不带 `triggerTurn` 时的分支。
完整文件已保存，检索关键分支。
核对历史回放对 custom 消息的处理（确认新写入的 custom 消息能在下一轮正确回放给模型）。
# 审核结论

先说核对方式：读了适配器全文、偏离表（docs/pi-development-guide.md）、ADR 0204、prompt-prefix 规则、prompt-prefix 兼容测试和 adapter 兼容测试的相关用例；Pi 侧无法在本地核对（node_modules 未安装），改用 GitHub 上 `earendil-works/pi` 的 main 分支源码（`agent-session.ts`）和官方 issues 核对，均已附出处。材料引用的 `.agents/reviews/topic-pi-d5-d7/`（briefs、round-1 两模型方案）在仓库里不存在，**未核实**。以下按严重度排列。

---

## 证实的（有代码或一手出处）

### 1.【高】D5 第 1 条的分支判断依赖 `session.isStreaming`，而审批续跑路径上这个值是失真的；照计划改会把消息插进正在运行的历史中间

- `pi-runtime-adapter.ts:1387` 用 `if (active.isStreaming)` 选分支；而审批续跑是 `if (restored) await session.agent.continue();`（`pi-runtime-adapter.ts:1785`）——直接启动底层 Agent，不经过 `_startRun`。
- Pi main 源码：`get isStreaming() { return this._isAgentRunActive; }`，`_isAgentRunActive` 只在 `_startRun` 里置位（`packages/coding-agent/src/core/agent-session.ts` 第 1544、1944 行）。官方 issue 证实失真：https://github.com/earendil-works/pi/issues/8401 原话 "session.agent.continue() starts the core Agent directly without going through AgentSession._runAgentPrompt(), which leaves the two activity states out of sync: `agent.state.isStreaming === true; session.isStreaming === false`"。
- 失真时计划的新写法走“空闲”分支：`_appendCustomMessage`（main 第 2493–2508 行）在**运行中途**往 `sessionManager` 追加并 `_refreshFinalizedContext()`（第 2505 行把 `agent.state.messages` 整个换掉）。若当时并行工具批次还有结果没落（`parallelToolsInFlight`，adapter:1570），custom 消息会落在 tool_calls 与 toolResult 之间。官方 issue 记录了同类机制的后果：https://github.com/earendil-works/pi/issues/8210 —— "Custom messages serialize to `user` role … every subsequent request contains `assistant(tool_calls) → user → tool`; strict OpenAI-compatible providers reject it with a 400 and the session is permanently wedged"，且 #8166 报告的正是 **DeepSeek**（本项目主力模型）。
- 现状代码在这一分支用 `agent.steer`，在底层 Agent 真在跑时是正确入队——计划反而引入回归。

**建议**：动手前用真实 Pi 1.5.0 写一条「审批续跑 + 工具循环卡住」的测试，先测出 1.5.0 里 `agent.continue()` 运行期间 `session.isStreaming` 的实际值；若失真，非运行中分支保留 `agent.steer`（或把分支判据改掉），并把该用例转成常驻测试。计划的 dist 行号引用（1862–1900）我只在 main 上核对到等价行为，1.5.0 是否已含 #8209 的修复**未核实**。

### 2.【高】D5 第 4 条删 `#continueForSteeredNotices`：Pi 的自动续跑有覆盖不到的窗口，删了消息会永久丢失

- Pi 确实在 `_startRun` 里自动续跑排队消息（main 第 1968–1979 行 `while (!abort) { if (await this._handlePostAgentRun()) { … await this.agent.continue(); … } }`，第 2084 行 `return !this._agentRunAbortRequested && this.agent.hasQueuedMessages()`），计划的前提本身对。
- 但这个 drain 只在 `_startRun` 的循环里做。在最后一次 `hasQueuedMessages` 检查之后、`_emitAgentSettled` 清 `_isAgentRunActive` 之前入队的消息，Pi 不会再跑；官方文档也承认这个窗口：sdk.md 原话 "`agent_end` marks the end of one low-level agent run, but automatic recovery or queued work can still follow. Use `agent_settled` when the host needs to know that Pi will not continue automatically."（https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md）
- Himawari 这边：后台通知回调只在 `session.isStreaming` 时投递并返回 `true`（已投递）（adapter:1656-1661）；会话每轮 `session.dispose()`（adapter:1817）。正好落在窗口里的通知会被 steer 入队、回调已报成功、循环被删后就没人消费——消息丢失且外部以为已送达。现有 `#continueForSteeredNotices`（adapter:1232-1241）正是兜这个底。

**建议**：删除的判据测试必须包含「settle 窗口入队」的用例，不只测 happy path；测不出就保留循环。另注意 `canContinue` 的六个 false 状态（挂起、未知工具、失败、中止、循环卡住、取消）下 Pi 是否仍自动续跑，计划说要逐一核对——应落成六条用例，不是口头核对。

### 3.【中】abort 的取舍不一致，且计划里写的理由不成立

- 第 2、5 条把 catch 里的 `session.agent.abort()` 改 `session.abort()`，第 1 条却保留 `agent.abort()`，理由是“它在工具结果回调里，属于运行中”。这不成立：这几处 catch 都是 fire-and-forget（`void pending.catch(...)`、`.catch(...)`），`session.abort()` 只是“置标志 + `agent.abort()` + `await waitForIdle()`”（main 第 2601–2611 行），不 await 就不会被自己等死。ADR 0204 说的“工具在运行中不能等会话空闲”针对的是工具 `execute` 里**直接调用**的三处（adapter:1575、1596、1608），计划正确保留了它们。
- 真正的差别计划没写：`session.abort()` 置 `_agentRunAbortRequested`（main 第 2603 行），`_handlePostAgentRun` 见到它直接返回 false（第 2052–2054 行），**抑制 abort 之后 Pi 自动续跑排队消息**；单用 `agent.abort()` 时若队列里还有消息，Pi 可能再 `agent.continue()` 多发一次请求。

**建议**：三个 catch（adapter:1390、1659、1691）统一改 `session.abort()`；ADR 0206 里写真实理由（抑制 abort 后自动续跑 + 等待落盘），删掉“属于运行中”这句错误理由。

### 4.【中】测试覆盖缺口（侧重检查结论，见下节）

- 压缩补发的现有用例是假会话 + monkey-patch：`pi-runtime-adapter.compat.test.ts:1664` `agent.steer = (message) => steered.push(message)`。改成 `session.sendCustomMessage` 后此桩不再被调用，用例必须重写；计划只说“用真实 Pi 测试锁住”，应写明替换旧用例，避免出现覆盖真空。
- 第 1 条的**非运行中分支**目前没有任何测试（现有循环用例全走运行中分支，断言 helper 在 compat.test.ts:288-306 只查最后一条请求）。
- 第 5 条的历史保存失败→中止路径（adapter:1691）没找到直接用例；compat.test.ts:3694 的 "storage-failed" 用的是 checkpoint save，不是 `captureHistory`。**未核实**是否有间接覆盖。
- D7 的新测试应加一条读回断言（`settingsManager` 读回 `cacheWarming === "streaming"`），防键名拼错被静默吞掉；`providerModelConfig`（configured-model-binding.ts:258-284）确认不写 `promptCache`，与官方 "Leave them unset to disable cache warming"（docs/models.md，见 guide:243 引用）一致——“不会出现预热请求”的前提成立。

### 5.【低】文档/规则一致性

- `cacheWarming` 键名与 1.5.0 默认值 `"streaming"`、1.5.1 改 `"idle"`：项目内两处独立文档一致（pi-development-guide.md:330、ADR 0203:39 引 `docs/settings.md` 第 21 行），main 源码也从 settings-manager 导入 `CacheWarmingMode`。本地无法装包直接验证 1.5.0 dist，**未核实**到字节级；typecheck 会兜底键名错误。
- “已定”部分第 1 条的判断正确：`sendCustomMessage(triggerTurn:true)` 在空闲时走 `_startRun({messageType:"custom",…})`（main 第 2486 行），custom 消息成为起始消息，模型会看到——“官方没有不加新消息接着跑的会话层写法”与 #8401/#8026 的现状一致。
- 偏离表更新时注意：改完后 D5 剩余偏离只有审批续跑的 `agent.continue()`（adapter:1785）和工具内直接 abort（adapter:1575、1596、1608），偏离表 D5 行的位置描述要同步改，别留着已删除的 `hasQueuedMessages()`。

## 推测（依据较强但未在 1.5.0 上验证）

- 问题 1 里 `session.isStreaming` 失真在 **1.5.0** 上同样存在：#8401 于 2026-08 提出，main 的 `isStreaming` 实现仍是 `_isAgentRunActive`，但我没能拉取 1.5.0 的 dist 逐行确认（无法 npm pack）。这正是必须先写真实 Pi 测试的原因。
- settle 窗口丢失通知在实际生产里出现频率未知（窗口很窄），但一旦出现是不可恢复的丢失，且监控上无信号。

---

## 侧重检查

走的流程：主人发一条消息 → `run()` → `produce()` → projection/prompt bundle 冻结 → `prehydrateSession`（native history/custom/compaction 回放）→ `session.prompt(turn)` → 工具循环（`tool_result` 扩展回调里 loop guard → `appendLoopStopped`；后台通知 `subscribeBackground`）→ `waitForIdle` → `#continueForSteeredNotices` → `captureHistory` → `runtime.completed` → `dispose()`。

无测试覆盖的代码路径：① `appendLoopStopped` 非运行中分支；② `captureHistory` 失败 → abort（1691）；③ `canContinue=false` 时排队消息随 dispose 丢失（现状如此，计划不改变但也没记录）；④ settle 窗口入队的后台通知。文档与代码一致性总体良好，唯一硬伤是问题 3 里 ADR 0204 理由被计划错误引用为“属于运行中”。

---

## 必答问题

1. **会不会改变模型已见过的请求开头？** 各处都是末尾追加一条 custom 消息，不改系统提示、工具定义和已有历史；每轮会变的值（timestamp）由 Pi 在插入时生成一次（main agent-session.ts:2471 `timestamp: Date.now()`）并随消息固定，全部变化都在最后一条消息里。既有断言已锁住这一点（compat.test.ts:288-306：最后一条请求的最后一条消息是循环提示，systemPrompt/tools 与首请求逐字节相同）。**例外**：问题 1 的失真分支若发生，消息会插进运行中历史的中间（并行工具结果之间）——不改已发字节，但改变下一次请求里消息的位置，且触发服务方 400。所以“只追加”的判断原则上成立，第 1 条在审批续跑路径上需先测再改；`check:prompt-prefix` 现有用例不覆盖审批续跑 + 循环卡住的组合，应补进 `prompt-prefix.compat.test.ts`。
2. **同一段文字会不会变成不同字节？** 不会。custom 消息的 timestamp 一次生成后随历史固定；`details` 为固定结构（`taskRef`、`{}`）；环境说明文字来自 projection，`previousRuntimeEnvironment` 的查找顺序确定（runtime-environment-block.ts:83-112）；遮盖走冻结 bundle 的规则集，与本次改动无关。
3. **有没有自动检查、反向用例会不会失败？** 既有 `npm run check:prompt-prefix`（[I-66] 套件含改写历史、系统提示带变化值、关冻结、中间 system 消息等反向用例）+ adapter 兼容测试的 loop/BG-2/压缩用例。缺口见问题 4：非运行中分支、六种 canContinue 状态、settle 窗口、历史失败路径均无用例；压缩用例必须重写（1664 的桩会失效）。反向用例应套用现有 `[I-66]` 模式逐条确认失败。
4. **每个值的两端核对**：`himawari.tool-loop.stopped`、`himawari.runtime-environment`、`himawari.background.command` 三种 custom 消息的生产端 shape `{customType, content, display, details}`（adapter:407-423、runtime-environment-block.ts:114-121）与 `sendCustomMessage` 的入参 `Pick<CustomMessage,"customType"|"content"|"display"|"details">`（main 第 2460–2462 行）完全匹配；消费端 `appendCustomMessageEntry`、`nativeHistoryMessages` 接受 `role:"custom"`（pi-native-history.ts:55-57，要求 timestamp 为有限数字——满足）、请求里转成 user 角色（compat.test.ts:305 断言）。两端核对通过。`session.abort()` 生产端已有先例（adapter:1228 `cancel()`），Pi 侧语义明确。`cacheWarming:"streaming"` 键名两处文档一致、typecheck 兜底、模型无 `promptCache` 故不发预热请求。唯一没核对到两端的是**删除** `#continueForSteeredNotices` 后排队消息的去向（问题 2）。

## 如果由我来定

1. **第 1 条**：先写真实 Pi 1.5.0 用例测「审批续跑 + 循环卡住」与 `isStreaming` 在 `agent.continue()` 期间的值，再决定是否换成 `sendCustomMessage`；只换真正空闲的分支，测出失真就保留 `agent.steer` 并记入偏离表。
2. **第 2、5 条照改，第 1 条的 catch（1390）一并改 `session.abort()`**，ADR 0206 写真实理由（抑制 abort 后自动续跑、等待落盘），保留工具 `execute` 内三处直接 abort。
3. **第 3 条照改**，用真实 Pi 用例替换 compat.test.ts:1615-1677 的假会话用例。
4. **第 4 条默认保留循环**；删除的判据测试必须覆盖 settle 窗口入队和六种 canContinue 状态。
5. **D7 照做**，测试加 settings 读回断言与“注册表无 promptCache”断言。
6. 文档照计划更新，偏离表 D5 行同步剩余偏离清单，删掉已被推翻的理由表述。
