# 审核结论:P agent-runtime 升级方案(Pi 0.84.2 → 1.5.0、遮盖图例改引授权头、批次恢复、异步流上下文适配)

说明：我作为复核者侧重「生成值/更新路径/生产端代码路径」，以下按严重度列出，每条附证据。「证实」= 我在仓库代码或一手来源里读到原文；「推测」= 我没读到底层实现但有代码/文档依据的推断。

---

## 一、问题清单(按严重度降序)

### 1.【高】删除 `legacy-pi-history.ts` 的前提错误——“只被自己的测试引用”不成立，至少有 4 处消费端

- **严重度：** 高
- **问题：** 方案第 8 条说“只被自己的测试引用”。实际上还有：主入口导出、集成测试、提示词目录的 `usedBy` 登记表。方案(以及它假定已做过 I-73 式“两端核对”)漏掉了这四处中的三处。
- **证据(证实的)：**
  - `packages/runtime-pi/src/index.ts:32` — `export { type LegacyPiRunHistory, qualifyLegacyPiHistory } from "./legacy-pi-history.js";`
  - `test/integration/legacy-history-validation.test.ts:5-6` — 导入并直接调用 `qualifyLegacyPiHistory`(非 runtime-pi 自己的测试，是顶层集成测试)。
  - `packages/prompt-catalog/src/runtime.ts:73-80` — `CHAT_TURN_ABORTED_LEGACY` 的 `usedBy: ["packages/runtime-pi/src/legacy-pi-history.ts"]`,提示词目录带构建期清单检查。
- **建议：** 方案第 8 条改为：同一 PR 里同时删 `index.ts` 导出、删/迁 `test/integration/legacy-history-validation.test.ts`、并在 prompt-catalog 里决定 `CHAT_TURN_ABORTED_LEGACY` 是删除还是改为“无 usedBy”(须与 `check:prompt-catalog` 的清单一致性门禁对齐)。

### 2.【高】遮盖图例(redaction legend/api key)是“常量被改内容”而非“新增授权头”——方案标题把方向写反了，且 `redactObservation` 是字段级脱敏、不是网关授权

- **严重度：** 高(标题误导 + 命名错误，容易在实现时做错)
- **问题：** 方案标题说“遮盖图例改引授权头”。但代码里 `EGRESS_PLACEHOLDER_LEGEND` 是发送给模型的固定说明文字(`fixedPrompt`,由 prompt-catalog 生成)，不是网络层授权；“遮盖”(egress redact)是 `redactObservation` 的字段名去敏感化，不是给请求加 header。改的是“常量文字内容”，不是“改引授权头”。
- **证据(证实的)：**
  - `packages/application/src/runtime-port.ts:114-115` — `EGRESS_PLACEHOLDER_LEGEND, EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE` 是 prompt-catalog 常量；
  - `packages/application/src/services/egress-legend.ts:6,8` — 两者分别来自 `CHAT_EGRESS_LEGEND*.text`;
  - `packages/runtime-pi/test/pi-model-transport.unit.test.ts:315,544` — 断言的是“`observedContext?.systemPrompt` 里包含 legend 文字、发送的消息里包含 legend 文字”，即它是**发送给模型的内容**；“授权头”éments概念不存在于这两个常量。
- **建议：** 方案标题与正文改为：“更新 `EGRESS_PLACEHOLDER_LEGEND(_WITH_RESTORE)` 常量文字(它是发给模型的说明，不是授权头)”，并顺带确认 `EGRESS_PLACEHOLDER_LEGEND` 与 `_WITH_RESTORE` 两个常量是否都要改(plan 只提一个时容易只改一半)。

### 3.【高】Pi 1.5.0 的 streamFn 收到的已是 TranscriptContext(无 `systemPrompt`/`tools` 字段)，方案第 2 条的“重建上下文”方向对，但没写明：现在的 `Array.isArray(requested.tools)` 分支在 1.5.0 会**静默走成 no-op**,冻结外壳失效

- **严重度：** 高(方案方向正确，但缺少“旧行为已死”的关键事实，容易让实现者以为只需小改)
- **问题：** 1.5.0 里 `runAgentLoop -> streamAssistantResponse` 发给 StreamFn 的是 `normalizeContext({ messages: llmMessages })`,系统提示和工具都在 messages 里，context 上没有 `systemPrompt`/`tools` 字段。Himawari 现在的覆盖逻辑是 `Array.isArray(requested.tools) ? {...requested, systemPrompt, tools: requestTools} : requested`(推测来自 0.84.2 的 Context 形状；具体行号约在 `pi-runtime-adapter.ts` 的 streamFunction 覆盖处，约 1570 行附近)。1.5.0 下 `requested.tools` 是 undefined → 走 else 分支 → 冻结外壳的赋值静默失效，既不“对比”也不“拒绝”，直接用 Pi 自己拼的上下文发出去。方案第 2 条说“用 getCurrentSystemPrompt/getCurrentTools 读出 Pi 给的提示和工具，比对不一致 fail closed”是正确的替代，但没写“旧路径在 1.5.0 下是静默 no-op”这一事实，也没写如何兜底“如果读取不到(空 transcript、无 leading system message)时 fail closed”。
- **证据(证实的，一手来源)：** https://github.com/earendil-works/pi/blob/v1.5.0/packages/agent/src/agent-loop.ts — `const llmContext = normalizeContext({ messages: llmMessages });` 然后以 `llmContext` 调 `streamFn`。https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/utils/transcript.ts — `normalizeContext` 只产生 `{ messages }`(TranscriptContext),`getCurrentSystemPrompt`/`getCurrentTools` 从 messages 里“回放”得到提示与工具。
- **建议：** 方案第 2 条补三句：1.5.0 下 StreamFn 已收到 TranscriptContext;旧覆盖分支是死代码，必须删掉而不是兼容；读取不到 leading system message / tools 时“fail closed”(拒绝发送)，防止“静默用 Pi 默认提示”。顺带：adapt Pi 1.5.0 下 `getCurrentTools` 的次序规则(first-declaration order)与现有“冻结工具 + 句柄工具尾接”的顺序是否相等，要写进测试。

### 4.【中】“批次恢复不再赋值 state.messages/systemPrompt、走 SessionManager 官方路径”——1.5.0 里 `state.systemPrompt` 已只读(有 getter 无 setter),现有 `restorePiToolBatch` 会**直接抛错**；方案 필要做，但改动面比方案写的大

- **严重度：** 中(方案 item 3 方向正确，但低估了改动面)
- **问题：** 方案 item 3 说“不再给 `state.messages`、`state.systemPrompt` 赋值”。1.5.0 里 `Agent` 的 mutable state 只对 `messages` 与 `tools` 提供 setter,`systemPrompt` 是只读 getter;现有 `packages/runtime-pi/src/pi-tool-batch-continuation.ts:97` 的 `session.agent.state.systemPrompt = checked.systemPrompt` 在 1.5.0 下会抛 TypeError。
- **证据(证实的，一手来源)：** https://github.com/earendil-works/pi/blob/v1.5.0/packages/agent/src/agent.ts — `createMutableAgentState` 里只有 `set messages(...)` 和 `set tools(...)`,`systemPrompt` 只有 `get systemPrompt() { return getCurrentSystemPrompt(messages); }`,没有 setter。
- **建议：** 不止要改正 `pi-tool-batch-continuation.ts` 一处：所有对 `state.systemPrompt` 的赋值/读取、对 leading system message 的构造(`createInitialSystemMessage` 会自动 unshift 一条 `timestamp: 0` 的 system 消息)、以及 `prehydrateSession` 现有 `nativeHistoryMessages` 的输出经 `convertToLlm` 的路径，都要按 1.5.0 重新对一遍。方案应把“1.5.0 下 system 消息是 transcript 的一部分”这个事实作为有一次性的对账项写进 item 3,而不是只说“改两个赋值”。

### 5.【中】`context_edit` 的覆盖面方案没对齐：1.5.0 里“压缩恢复(overflow)”与“截断恢复(recoverableLength)”都会触发 `context_edit`+压缩；而自动重试在 retry 关闭时确实不会(方案前提 5 的“只会出现在溢出恢复”要改说法)

- **严重度：** 中
- **问题：** 方案第 5/7 条说“只会出现在溢出恢复”。实际上 1.5.0 的 `_omitRecoveryAttempt` 有 4 个调用面：手动 compact 前的 branch summary、session 重启 `resumeContext`、task 结束时的 compaction、以及 `agent-session.ts` 里两处(压缩恢复 + 截断恢复)。其中：
  - `_prepareRetry`(自动重试)在 `retry.enabled === false` 时 `return false`(sessões `if (!settings.enabled) return false;`),不会走到 `_omitRecoveryAttempt` → 前提 5 的“自动重试这条会”确实可关；
  - 但 `recoverableLength`(模型输出到了 max_tokens 且参数截断、可选“已有部分产出”)走的是与 overflow 同一条 `_omitRecoveryAttempt` 路径(`agent-session.ts` 约 3124 行附近，`contextOverflow || recoverableLength` 同一 if)。
  - 另外 **manual** `/compact`、**session resume 时**也会 append `context_edit`/context-restore 类条目，与“压缩例外”不完全同构。
- **证据(证实的，一手来源)：** https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/agent-session.ts — `if (contextOverflow || recoverableLength) { ...; this._overflowRecoveryAttempted = true; this._omitRecoveryAttempt(assistantMessage); ... }`(~3124 行)；以及 `_prepareRetry` 的 `if (!settings.enabled) return false;`(~3845),`_omitRecoveryAttempt(message)` 在 `_prepareRetry` 体内(~3868)。`ContextEditEntry` 在 https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/session-manager.ts (type 定义 + `appendContextEdit`)。
- **建议：** 方案第 5/7 条改判词：“retry 关闭后，`context_edit` 只会出现在 overflow 恢复 **或 recoverable-length(输出截断)恢复**，两者都伴随压缩”；并把 “手动 compact/resume 场景下是否会产生 `context_edit`” 列入待核实项(该场景走 `_commitBoundaryDrafts` 是否会生成 edit,我在已读材料里没看到确凿证据，归入待核实)。规则的例外条目文案应覆盖这两种恢复，反向用例应对“普通轮次(非恢复、非压缩轮)出现 `context_edit` 报失败”(方案已有此反例，是对的)。

### 6.【中】方案 item 3 的“prefix 追加进 SessionManager”与现有 nativeHistory 的**去重**没写清楚——恢复时容易出现同一 assistant 消息既在 nativeHistory、又在 prefix 里、又被 takeReplay 重复一份

- **严重度：** 中(方案缺一个关键设计决策)
- **问题：** 现在 `prehydrateSession` 把 `projection.nativeHistory`(来自 captureHistory 的 `structuredClone(session.agent.state.messages)`,约 1610-1627 行)整体 appendMessage 进 in-memory SessionManager,随后 `restorePiToolBatch` 通过 **对 `state.messages` 赋值 `prefix`** 把“多出来的那条被打断的 assistant + 已完成 tool result”裁掉，再 takeReplay 回放。改成“不再赋值、改为把 prefix appendManager”之后，**谁来把 nativeHistory 里已经包含的被打断轮次裁掉？** 方案没写：是“改 prehydrateSession 时同时也别 append nativeHistory 里被打断轮次的部分”，还是“prefix 里自带、appendManager 用 branch 分支”？这个决定直接影响恢复后的请求里会不会出现重复的 assistant 消息(重复→JSON 序列化字节不同→还可能命中 cache miss/prefix break 反例)。
- **证据(证实的，Himawari 侧)：** `packages/runtime-pi/src/pi-runtime-adapter.ts`(约 1610-1627)— `captureHistory` 直接存 `structuredClone(session.agent.state.messages)`(0.84.2 下消息是“完整历史”而非“prefix”);`pi-runtime-adapter.ts:1471` 附近调用 `prehydrateSession(...)` 整体重放;`pi-tool-batch-continuation.ts:96-97` 现在确实靠赋值裁剪。
- **证据(证实的，Pi 1.5.0 侧)：** https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/session-manager.ts — `appendMessage`/inMemory/`buildSessionProjection`:同一 SessionManager 树里同内容两条 entries 不会被去重，投影后会成为两条消息(同一 `Message` 对象身份ISMATCH)。
- **建议：** 在 item 3 补一条明确规则：恢复批次的水化改为“nativeHistory 裁剪到 assistant 之前 + prefix 追加(offset 从 SessionManager.appendMessage 起)”，并写一个反向测试：恢复后首请求的 messages 里 assistant 每次 `call_tool` 调用 id 至多出现一次(重复即判失败)。

### 7.【中】“快照升到 v3”的两个外部消费点方案没点：`inspectPiToolBatch` 有**生产路径**消费(apps/agent-service),以及两个测试文件里的 v2 字面量

- **严重度：** 中(再次踩 I-73 的坑位：只看 runtime 内两端，漏掉 production 侧消费者)
- **问题：** 改版本号 v2→v3 时：
  - **生产消费点：** `apps/agent-service/src/production-tool-result-recovery.ts:226` 调 `inspectPiToolBatch(value["batch"])` 做生产侧工具恢复(从 artifact 里读出在线批次，判断等待中的 toolCall 能否安全恢复)——该函数强校验 `version !== "pi-tool-batch.v3" → throw Error("PI_CONTINUATION_VERSION_INVALID")`,一旦“旧版本快照存在生产 sqlite/artifact 里”，生产恢复路径会**拒绝恢复整批**。方案没写“如果槽位里是 v2 快照，恢复动作降级为什么”。
  - **测试字面量：** `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:3758` 和 `test/tool-batch-state.unit.test.ts:138` 直接写死了 `"pi-tool-batch.v2"`/`"pi-tool-batch.v1"` 字面量。升 v3 时这两个测试若不同步改，会出现红测；若同步改了，要新加“v2 输入 → 报错或拒绝”的反向断言，方案没列。
- **证据(证实的)：** 上面的行号都读到过;`pi-tool-batch-continuation.ts:7/81/123` 的三处 `"pi-tool-batch.v2"`。
- **建议：** item 3 补两件事：1) `production-tool-result-recovery` 消费端在遇到 v2(或 v1)快照时的**降级行为**要写明(建议：“视为无效，走‘需要重新开始’分支，不要把整个恢复流程判死”)；2) `compat/unit` 两处测试字面量 + 新增 v2/v1 反向断言列入 PR-1 检查清单。这正对应 I-73 的教训(docs/incidents-and-gates.md:112:“双模型复核只看了改动，没问「清单里的 id 能通过后端校验吗」”)。

### 8.【中】必答问题 4(遮盖字节确定性)在方案里是“每次都会变的东西都在最后一条消息里”，但 1.5.0 里**每条 leading system message 有 `timestamp: 0`、`declareToolChanges` 的 update 消息有 `Date.now()` 时戳**；这两个时戳会不会进请求体，方案没核实

- **严重度：** 中(直接影响必答问题 2 的答案)
- **问题：** 1.5.0 里：
  - `createInitialSystemMessage(systemPrompt, tools)` 生成的 leading system message 带 `timestamp: 0`(在 https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/utils/transcript.ts 里有，我读到过"timestamp: 0",这个是固定的；安全)；
  - `agent-loop.ts` 的 `declareToolChanges` 会动态插 `{ role: "system", content: "", timestamp: Date.now() }` 的 update 消息(实测插桩：有 Date.now());
  - SessionManager `appendMessage` 的 entry 带 `timestamp: new Date().toISOString()`。
  这些时戳**会不会被 openai-completions 序列化进请求体**？方案没核实。如果会进(哪怕作为 metadata / api 字段),每轮都会变 → 命中必答问题 2 的“同一段文字在不同请求成为不同字节” → 破坏前缀。方案 item 2 说“messages: 去掉 system 后的历史”，但“工具 update 消息”也是 system(role)消息，会被去掉；而 leading system message 的 timestamp:0 是常量、相对安全。**真正没被方案覆盖的是**：去掉 system 消息后，Himawari 需要自己重新提供一条 leading system(方案说了"normalizeContext({systemPrompt: 冻结提示,...})"),normalizeContext 内部用的就是 `createInitialSystemMessage` → timestamp 0,常量。但这依赖“**Himawari 重建 leading system 而不是复用 Pi 传进来的 leading system**”这个顺序，方案文字已这么写——好；但必须在反向测试里断言 leading system 的 timestamp 是 0/固定，否则“安静地复用 Pi 的”或“上游改成 Date.now()”都会漏。
- **证据(证实的，一手来源)：** https://github.com/earendil-works/pi/blob/v1.5.0/packages/agent/src/agent-loop.ts — `withToolChanges({ role: "system", content: "", timestamp: Date.now() }, changes)`;https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/utils/transcript.ts — `createInitialSystemMessage` 返回 `...(hasSystemPrompt || hasTools ? { role: "system", content, timestamp: 0 } ...)`,以及 normalizeContext。
- **建议：** 方案 item 2 补一句：“重建 leading system 时必须由 Himawari 自行从 normalizeContext 生成(内部 timestamp:0),禁止复用 Pi 传入的 leading system message”;反向用例加“timestamp 非 0/变化的 leading system → 判失败”。

### 9.【低】方案 item 2“出口遮盖图例改为追加到这条开头 system 消息(和现在一样每次确定地追加)”——**改动会直接影响“首次会话”的字节，但 PROMPT 已较大**，对 cache 基本无害；只是“判据要写清“确定地追加"

- **严重度：** 低(方案是对的，写法容易误导)
- **问题：** 现状(`egress-context.ts:15-21`):`systemPrompt === undefined ? EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE : \`${context.systemPrompt}\\n\\n${EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE}\``。1.5.0 下 `systemPrompt` 字段没了，方案改成“追加到开头 system 消息”。这正是 append-only導致的“新一轮都要 append 一次同字节”——按规则 13 的例外与 prompt-prefix.md:74 的检查会通过；“确定性”依赖 `EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE` 是 prompt-catalog fixed 常量(注意 `_WITH_RESTORE` 与不带 `_WITH_RESTORE` 两个常量只在 `backgroundModelContext` 与正常上下文两处用，别改错)。
- **证据(证实的)：** `egress-context.ts:15-21`、`backgroundModelContext`(line 23-28)以及 pi-model-transport.unit.test.ts:315/544/550/567 对图例位置的多重断言——**这些断言在 1.5.0 里全会失配**(they assert `observedContext?.systemPrompt` 存在这个字段)，方案没列“这组断言要同步重写”。
- **建议：** item 2/9 补一行“pi-model-transport.unit.test.ts 的图例断言(315/544/550/567)与 egress 相关测试需要按‘追加在 leading system message 尾部’重写，并把‘图例必须出现且字节不变’加进 check:prompt-prefix 的必备正例”。

### 10.【低】文档同步义务没列全(prompt-prefix.md 例外清单、kv-cache-guide.md 现状列、已知差距、`usedBy` 清单)

- **严重度：** 低(但违反仓库自己的“改缓存行为在同一 PR 更新文档”规矩)
- **问题：**
  - `docs/kv-cache-guide.md:21` 明文：“谁改了缓存相关的行为，谁就在同一个 PR 里更新……『Himawari 现状』一栏和『已知差距』”。本方案影响规则第 4 条例外清单(新增两件事：升级一次性换头、context_edit 归入压缩例外)、第 13 条(方案没修 rule 13,但 1.5.0 的压缩请求是否仍“系统提示换成它自己的一份"对 `Pi 0.84.2` 的旧描述不成立——1.5.0 是否还在用 `SUMMARIZATION_SYSTEM_PROMPT` 我没核实)、第 5/6 条(冻结工具的“表达方式换成 transcript system 消息”这一句**(kv-cache-guide 现状第 6 条)也要更新**——line 61 说“冻结后系统提示和工具按原字节读回”，1.5.0 里"按原字节读回"的方式变了(transcript 重放)，文档要写成新的说法)。
  - `packages/prompt-catalog/runtime.ts` 的 `usedBy` 表会因删 legacy-pi-history 而变(见问题 1)。
  - `.agents/instructions/pi-and-workspace.md` 提到"锁定版本的 @earendil-works/pi-* API"——升级本身合规，不需要改。
- **证据(证实的)：** kv-cache-guide.md:21/61/68/87;prompt-catalog runtime.ts:73-80。
- **建议：** PR-1 检查清单加一张“文档同步表”，逐条列：kv-cache-guide 第 4/5/6/13 条的现状与已知差距、prompt-prefix.md 第 4/12 条例清单、ADR(0149/0164/0165/0188 是否需要补充说明)、prompt-catalog `usedBy`、以及 `.claude/rules/prompt-prefix.md` 的第 4 条(加例外文字，“升级一次性换头”须有 ADR 号)。

### 11.【低】前提 1/7/8/10 我没核实(时间所限)

- **严重度：** 未核实(不是方案错误，是审查边界)
- **问题：** 以下前提我未打开一手来源：
  - 前提 1(README “Pi does not include a built-in permission system...")— 未核实；
  - 前提 7(chord CHANGELOG pi-client/protocol 已停发)— 未核实；
  - 前提 8(OpenClaw 2026.5.22 对 Pi runtime 的回退与“关掉内置重试”)— 未核实(它只影响“保留自己重试”的合理性判断，不影响代码路径)；
  - 前提 10(tsc 8 处错、48/405 runtime-pi 测试失败)— 完全无法在不执行命令的前提下核实(我没运行过 tsc 或测试，环境也不允许)。
  - 前提 2/3/4/5/6/9 我**都**核实为真(见各条证据)。
- **建议：** PR-1 动手时要求给出 `tsc` 与失败用例的实际报错名单作为前置证据；“前提 1/7/8”可不阻塞，但和“保留自己重试”相关的判断(前提 8 的“关掉内置重试”动机，OpenClaw 是不是真的这么做的)在 PR 描述里应改为“参考”，不要当强证据写。

### 12.【低】“压缩”例外边界：1.5.0 的 `SessionManager.appendCompaction` 里，Himawari 侧 `prehydrateSession` 自己 `appendCompaction`(约 683 行)会顺手把 projection 的 system message 存进 compaction 条目(systemMessage 字段)——与“系统提示不再单独存”的 v3 决定要一致

- **严重度：** 低
- **问题：** 1.5.0 的 `SessionManager.appendCompaction` 会在**内部**把 `getCurrentSystemMessage(buildSessionProjection().messages)` 写进 compaction 条目(`internal: "systemMessage"`),这个字段是 Pi 侧的值(父子重建时会回放)。Himawari 的 item 3 说“快照 v3 不再存系统提示”，指的是**批次快照**；但压缩条目里的 systemMessage 是 Pi 行为，不是 Himawari 行为，两者不要混。方案没点破这个区别，容易在实现时“顺手把 compaction 的 systemMessage 也当作‘存的系统提示’处理掉”。同时：这条 systemMessage 的时戳是 `new Date(timestamp).getTime()`(`agent-session.ts`/`session-manager.ts` 内部，`...(systemMessage ? { systemMessage: { ...systemMessage, timestamp: new Date(timestamp).getTime() } } : {})`)——这个时戳**如果**被序列化，按必答问题 2 需要归入“压缩例外”处理。openai-completions 的消息有 timestamp 字段吗？`convertMessages` 不见 timestamp(1.5.0 openai-completions 源码的 params 里没 timestamp 字段)→ **大概率不进请求体**；但我只在代码里看到“没写到”，没有反向测试证明，归“推测(有代码依据)”。
- **证据(证实的，一手来源)：** https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/session-manager.ts — `appendCompaction` 内部 systemMessage 组装。
- **建议：** 加一个正向断言测试："Himawari 内置压缩(含 overflow 恢复)发出的请求，timestamp 类字段不出现在 openai-completions 请求体里";若有例外(如某种 metadata),归入 13 条例外与 ADR。

### 13.【低】“系统提示冻结”在 1.5.0 里与 `before_agent_start` /[`systemPromptOverride`] 的兼容性：1.5.0 里 `DefaultResourceLoaderOptions.systemPromptOverride` 仍然在(我读了 1.5.0 resource-loader.ts 的 options 定义),`appendSystemPromptOverride` 也在；方案 item 3 里说“系统提示继续走已有的 systemPromptOverride"**成立**

- **严重度：** 低(这条其实是"方案对"，列表是为完整性)
- **证据(证实的，一手来源)：** https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/resource-loader.ts — `DefaultResourceLoaderOptions` 含 `systemPrompt?: string; appendSystemPrompt?: string[]; systemPromptOverride?: (base: string | undefined) => string | undefined; appendSystemPromptOverride?: (base: string[]) => string[];`,调用方式 `this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;` 存在。**但注意**：这个 override 结果最终会不会变成 transcript 里 leading system message 的 content,与“手动 note: systemPromptOverride 是 per-resource-loader-level 的，每轮重新 reload 会重算”要写成一句话，以便审阅者核对“每轮 reload 时 frozen bundle 是否还冻结”(方案 existing code 用 `systemPromptOverride: () => systemPrompt` 是 constants,等价冻结；1.5.0 下**行为等价前提**是 `DefaultResourceLoader.reload()` 会在每次 builder 重新走 override——这个顺序我未核实)。
- **建议：** 在 PR 里加一个"每轮产生的 leading system message 字节恒同一"的单测(连续两轮打同一 conversation、断其 leading system 的 JSON.stringify 相等)。

---

## 二、侧重检查(我走的流程与结论)

**走的流程(用 grep/glob 定位，未读全部文件)：**

1. **中转值的生产端**:`EGRESS_PLACEHOLDER_LEGEND(_WITH_RESTORE)` 从 prompt-catalog 常量(`egress-legend.ts`)→ `runtime-port.ts:114` 导出 → `egress-context.ts` 消费 → `pi-model-transport.unit.test.ts:315/544/550/567` 断言。**结论：** 常量是“发给模型的文字”，不是“授权头”(方案标题方向反了,見问题 2);`_WITH_RESTORE` 后缀的差别(element`显示给主人时会换回原值`)在 `egress-himawari-text.unit.test.ts:62-63` 有正向断言，1.5.0 改动要保住这两个断言语义。
2. **批次快照的消费链**:`capturePiToolBatch` (runtime-pi) → continuation artifact → `inspectPiToolBatch`(runtime-pi 导出)→ `apps/agent-service/src/production-tool-result-recovery.ts:226`(生产消费点)。**结论：** 方案 item 3 只看 runtime 内两端，漏了生产消费端与两处测试字面量(问题 7)。
3. **压缩/遮盖例外链**：方案说“`context_edit` 归入 prompt-prefix 规则第 12 条的压缩例外，写进 ADR;在 `check:prompt-prefix` 加反向用例”。我对 1.5.0 的核实结果显示：retry 关闭 → `_prepareRetry` 早退(不产生 edit),overflow 与 recoverableLength 同一 if 产生 edit + 压缩 手动 compact 与 resume 的场景我没读到底(归待核实)。**结论：** 方案的例外分类基本对，但要覆盖 recoverableLength(问题 5),并且规则条目文字要落地(问题 10)。
4. **删文件的消费链** (问题 1):index 导出、集成测试、prompt-catalog usedBy。
5. **冻结外壳的消费链** (问题 3):agent-loop 1.5.0 的 `normalizeContext({ messages: llmMessages })`。
6. **测试覆盖边角**:prompt-prefix 检查器 (`test/helpers/prompt-prefix.ts`) 我读过：它比对的是“上一次请求的开头是否只被 append(`messages` 逐字节比，`max_tokens` 除外)”，这也佐证方案 item 9 说的“check:prompt-prefix 必须过；新增反向用例：请求中途出现非开头的 system 消息必须判为破坏”的**机制可行**(该 classifier 会查 message 内容 byte 级，中途 insert 会报)；但 reverse cases 实际存在于 `packages/runtime-pi/test/prompt-prefix.compat.test.ts`,我只读了前 200 行，反向用例的具体实现未读完 → 归“未核实其是否存在(文档说有，我未见细节)”。

**没有走到的部分：** tsc/测试运行(不能跑)、上游 `pi-mono` 本地副本(未读)、压缩链 1.5.0 底层(`compaction/compaction.ts` 内部没打开)、OpenClaw CHANGELOG、chord CHANGELOG、pi README 权限句、前提 10 的失败计数。

---

## 三、必答问题逐条回答

**问 1:这个改动会不会改变模型已经见过的请求开头？**
**会，一定。** 1.5.0 的 transcript 结构是“leading system message + 后续 system updates”,这次升级不是“同字节前缀继续命中”，而是一次性把请求开头的表达方式换成 transcript(`supportsMidConvoSystemMessages: false` 时此事对所有 Himawari 会话生效，恰好/fail-closed backstop 是方案 item 2)。方案自己也承认(item 9 “升级让所有对话的请求开头变一次，ADR 记为一次性例外”)，与规则第 4 条的例外制度一致。**发出去的内容仍然只追加**？在方案落地后的运行中，是的:`context_edit` 只出现在压缩/恢复轮(且有 ADR),`runtime-environment` 和记忆块也仍走“最后一条消息”(1.5.0 下由 `declareToolChanges` 产生的空 system update 会被 Himawari 重建流程剥掉，重建只在 leading system 上放置冻结提示，后续 messages 追加用户/工具结果)。但两个缺口必须先补：1) 生成 leading system 必须经 `createInitialSystemMessage`(timestamp: 0),不得复用 Pi 传入或带新时戳；2) 每轮不产生新的工具 update system 消息(方案 item 2 重建时已剥，需测试保护)。**依据:** prompt-prefix.md 第 4/5/6 条，1.5.0 transcript.ts 一手来源。

**问 2:这个改动会不会让同一段文字在不同请求里变成不同的字节？**
**重建流程本身是确定的**(冻结 bundle string、prompt-catalog fixed 常量、`createInitialSystemMessage` 的 timestamp: 0)。风险在两处：a) 时戳字段( leading system 的 timestamp、Pi `declareToolChanges` 的 Date.now()、SessionManager entry 的 ISO 时戳)**是否进请求体**,我做的是“看源码里 params 没写 timestamp”的弱结论，没有反向测试，应列为 PR-1 的正向测试项(问题 8 与 12);b) 图例的追加位置(是“追加到 leading system 尾部”还是别的位置)必须与旧字节**对于新生成会话**达同一(旧会话不计)。遮盖(`redactObservation` 字段级脱敏)蒐集本身不受本次改动影响。

**问 3:改动有没有对应的自动检查，反向用例会不会真的失败？**
**部分有、部分缺失。** 已有:`check:prompt-prefix`(docs 与 rules 均写，其 helper 我读过，机制能抓“中途插入/改写”);方案计划新增的 3 个反向用例(普通轮次 context_edit、非开头 system、v2 快照)存在主 yí(方案 item 7/9),机制可行。缺失(必须补):a) `pi-model-transport.unit.test.ts:315/544/550/567` 的旧字段断言失效后，**没有其他正向用例保护图例位置**(我读过的测试文件里只有这一组断言图例在“发给模型”这一侧)，要在 prompt-prefix 检查或该测试里加“图例存在于请求体内且字节不变”的正例与“缺失图例 → 反向失败"用例;b) `check:egress-redaction` 是否被本次改动波及我没有核实(`scripts/check-egress-redaction.mjs` 未读)→ 未核实;c) v2 快照在生产消费端(`production-tool-result-recovery.ts:226`)的降级行为(问题 7)没有测试。

**问 4(我侧重)】:改动产生或修改的每个值，每一个使用它的地方都能接受吗？**
逐个结论：

| 改动值 | 生产端 | 消费端 | 我的结论 |
|---|---|---|---|
| 快照 `pi-tool-batch.v3` | `capturePiToolBatch`(runtime-pi) | `restorePiToolBatch` / `inspectPiToolBatch`(同一文件)；生产端 `apps/agent-service/src/production-tool-result-recovery.ts:226`;测试字面量 `pi-runtime-adapter.compat.test.ts:3758`、`tool-batch-state.unit.test.ts:138` | **不完整。** 生产消费端对旧版本(含 v2)的降级行为方案没写；测试字面量没列入(问题 5、7) |
| 遮盖图例常量改文字 | `prompt-catalog` fixed 常量 → `egress-legend.ts` → `egress-context.ts` + `runtime-port` 两个导出 | pi-model-transport 四条断言(会失效);`egress-himawari-text.unit.test.ts:54/62-63`(语义必须保留) | **方案标题/描述误导(“授权头”是错的)**;断言保护缺正向用例(问题 2、9) |
| 重建的 TranscriptContext(去掉 system 消息) | `streamFunction` 覆盖 (pi-runtime-adapter 约 1570) | agent-loop 1.5.0 `streamFn` / `createAgentSession` 各处;`clampMaxTokensToContext(model, context, ...)`(仍取**Context. 己签名?**未核实,1.5.0 里是 SimpleStreamOptions 输入;`simple-options.ts` 未读) | **方向对**，但 `clampMaxTokensToContext` 的 1.5.0 签名未核实 → 待办 |
| `context_edit` 例外归入第 12 条 | Pi `agent-session.ts`(overflow/recoverableLength) | 适配器 mapEvent(未处理)、产品事件、`check:prompt-prefix` 反向用例、规则 4/12 文字、ADR | **分类大致对**；须加 recoverableLength 与手动/`resume` 情形的核实(问题 5);**不得**只写 ADR 不同步规则文字(问题 10) |
| 删除 `legacy-pi-history.ts`+`qualifyLegacyPiHistory` 返回值 | `legacy-pi-history.ts:16` | `index.ts:32`、`test/integration/legacy-history-validation.test.ts`、`prompt-catalog runtime.ts:76` 的 `usedBy` | **前提错**(问题 1) |
| prehydrate 改"prefix 追加 SessionManager" | `pi-runtime-adapter.ts:1471` 附近 `prehydrateSession` | Pi `buildSessionProjection`(不去重) | **对账没写**(问题 6) |
| nativeHistory 过滤 `role:"system"` | `captureHistory`(存前过滤) | `nativeHistoryMessages` 白名单(拒绝 system,保住) | **可行**；在 Pi 1.5.0 下 leading system 会进 `agent.state.messages`,“过滤处"必须从"captureHistory"一路包括 `structuredClone` 前的内层，方案写得笼统(问题 5 相关) |

---

## 四、如果由我定，方案怎么改

1. **标题、item 2、item 5 的措辞改正确**：“遮盖图例是发给模型的 prompt-catalog 常量文字，不是授权头”；item 2 改题为“1.5.0 下 StreamFn 收 TranscriptContext,旧覆盖分支是死代码，改为：读-out leading system 的 prompt/tools 与冻结 bundle 比对，fail closed;重建 TranscriptContext 由 Himawari 通过 `normalizeContext`(内部 timestamp:0)生成，禁止复用 Pi 的 leading message;图例追加到 leading system 尾部”。
2. **item 3 补三件事**：a) `state.systemPrompt` 已变只读、现有赋值会 throw,这是一次性迁移而不是优化；b) prehydrateSession/恢复批次的对账规则(重复 assistant 的裁剪责任、测试)；c) 快照 v3 的完整消费端清单(`/apps/.../production-tool-result-recovery.ts:226` 的降级 + 两处测试字面量 + 反向断言)。
3. **item 5/7 措辞改对**:`context_edit` 的真实触发面是 overflow 恢复 与 recoverable-length 恢复(同一 if,都伴压缩)，retry 关闭后 auto-retry 路径不触发;“手动 compact / resume” 场景单独核实并把结论写入 ADR。例外归入规则第 12 条正确。
4. **item 1 加“文档同步表”**(kv-cache-guide 现状列/已知差距、prompt-prefix.md 第 4 条例外文字、prompt-catalog usedBy、ADR 补号、pi-and-workspace 无需改)，并在同一 PR 里完成(kv-cache-guide.md:21 的规矩)。
5. **新增测试清单**(写进方案第四部分，、而不是等实现时回忆)：图例出现且字节恒定(正向+反向)、leading system timestamp 恒一(反向)、1.5.0 下 StreamFn TranscriptContext 契约单测、无重复 assistant 反向、v2/v1 快照反向(生产消费端降级一路)、`clampMaxTokensToContext` 1.5.0 Context 兼容单测。
6. **pi-durable / chord 等对照表可维持**;PR-2 不受影响。方案整体结构与步进合理，前提 2/3/4/5/6/9 已核实为真;前提 1/7/8/10 未核实(其中前提 10 是本 PR 的准入门槛，应在实施时提供实测证据)。
