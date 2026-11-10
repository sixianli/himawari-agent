# 方案：Pi 偏离 D5（插消息）与 D7（缓存预热）

**说明：本任务已达到最大步数上限，工具已停用。以下结论基于已完成的核实工作写出。**

已完成的核实：本仓库的适配器、用量端口、持久化迁移、开发规范、ADR、prompt-prefix 规则已逐行读过；Pi 官方一手来源已从 GitHub `v1.5.1` 标签逐字核对（`agent-session.ts`、`cache-warmer.ts`、`sdk.ts`、`docs/sdk.md`、`docs/models.md`、`docs/settings.md`、`docs/extensions.md`、`pi-agent-core` 1.5.1 构建产物、`pi-ai` 的 `cache-warming.ts`）。**未完成**：锁定版本 1.5.0 的 dist 逐行核对（本检出没有 node_modules，工具被禁）、生产 Magpie 模型清单的具体内容，下文标「未核实」。

---

## 一、方案依赖的前提

### 读来源证实的（一手，均已逐字核对）

1. **Pi 1.5.1 会话层插消息接口**：`packages/coding-agent/src/core/agent-session.ts` 第 2447–2508 行 `sendCustomMessage`，四个分支（原话注释）：
   - `"Streaming: queues message, processed when loop pulls from queue"`（运行中且未给 `triggerTurn:false` → `agent.steer` / `agent.followUp`）；
   - `"Not streaming + triggerTurn: appends to state/session, starts new turn"`（`await this._startRun({ messageType: "custom", message: appMessage })`，第 2486 行）；
   - `"Streaming + triggerTurn false: appended to state/session once the current turn ends"`（`_pendingCustomMessages`，第 2514 行起 `_flushPendingCustomMessages` 在 `turn_end` 时补入）；
   - `"Not streaming + no trigger: appends to state/session, no turn"`。
   出处：https://raw.githubusercontent.com/earendil-works/pi/v1.5.1/packages/coding-agent/src/core/agent-session.ts
2. **文档语义**：`docs/extensions.md` `pi.sendMessage` 一节（第 1627–1649 行）：`"steer"` `"Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call"`；`triggerTurn: true` `"If agent is idle, trigger an LLM response immediately"`。`docs/sdk.md` Prompting 一节：`"A steering message enters after the current assistant turn and its tool calls"`、`"abort() stops the active operation and waits for the session to become idle"`。
3. **会话自己会“接着跑"**：`agent-session.ts` 第 1969–1987 行，`session.prompt()` 内部 `while (!this._agentRunAbortRequested) { if (await this._handlePostAgentRun()) { … await this.agent.continue(); continue; } … await this.agent.continue(); }`——排队消息和边界续跑由会话自己循环消化，`prompt()` 全部完成后才返回；`_handlePostAgentRun` 第 2084 行 `"return !this._agentRunAbortRequested && this.agent.hasQueuedMessages()"`。`agent_start` 前 `_startRun` 第 1943–1950 行同步置 `_isAgentRunActive = true`（`isStreaming` 即此标志，第 1544–1546 行）。
4. **底层队列**（`@earendil-works/pi-agent-core@1.5.1` `dist/agent.js`，https://cdn.jsdelivr.net/npm/@earendil-works/pi-agent-core@1.5.1/dist/agent.js ）：`steer(message)` 只入队；`continue()` 在最后一条是 assistant 时 `"drains steering queue … await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true })"`——即排队消息成为新 run 的起始消息；`hasQueuedMessages()` 查两个队列；`abort()` 只是 abort controller。
5. **缓存预热官方机制**（1.5.1 源码，https://raw.githubusercontent.com/earendil-works/pi/v1.5.1/packages/coding-agent/src/core/cache-warmer.ts 、…/src/core/sdk.ts 、https://raw.githubusercontent.com/earendil-works/pi/v1.5.1/packages/ai/src/cache-warming.ts ）：`sdk.ts` 的 `streamFn` 在每次请求时 `cacheWarmer.start({ model, context, options: requestOptions }, …)`，`buildRequestOptions` 是 `...options` 原样展开——即预热重放带着上次请求的全部选项（含 Himawari 传入的遮盖 `fetch` 和密钥）；重放选项 `getCacheWarmingRequestOptions = { ...options, maxTokens: 1, disableContinuation: true, maxRetries: 0, signal }`；成功后 `sessionManager.appendUsage("cache_warm", provider, model, usage, …)` 并经 `onWarmed` 发 `entry_appended` 事件（`agent-session.ts` 构造器里 `this._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry })`）；决策事件 `cache_warming_decision` 带 `warmCost/missCost/continuationProbability/action`，`"Return { action: "warm" } or { action: "stop" } to override; the last handler that returns an action wins"`、`"stop" ends warming until the next real request`；扩展决策失败 `"Extension failures fall back to pi's own decision"`；预热门槛 `CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05`（`"A refresh is sent only when it is expected to save at least this many dollars"`）；TTL 来自 `model.promptCache?.[retention]`，没写就不预热（`docs/models.md`：`"A model without a lifetime for the active tier is not eligible for cache warming"`）；`docs/settings.md`：`cacheWarming` 1.5.1 默认 `"idle"`，`"with `idle`, for up to 30 minutes between runs. Global setting only"`，`"Refresh usage counts toward session totals but does not enter model context"`。
6. **会话关闭预热就停**：`agent-session.ts` 第 1493–1496 行 `dispose()` 里 `this._cacheWarmer.onWarmed = undefined; this._cacheWarmer.cancel()`。
7. **Himawari 现状**（仓库）：`packages/runtime-pi/src/pi-runtime-adapter.ts` 第 1383–1397 行（`appendLoopStopped` 非 streaming 分支 `active.agent.steer({role:"custom",…})`）、第 1653–1662 行（后台通知 `session.isStreaming` 门 + `sendCustomMessage steer`，失败 `session.agent.abort()`）、第 1694–1706 行（压缩 `willRetry` 补环境 `session.agent.steer({ role:"custom", …environment, timestamp: Date.now() })`）、第 1232–1241 行（`#continueForSteeredNotices` 用 `agent.hasQueuedMessages/continue`）、第 1788 行（审批续跑 `session.agent.continue()`）、第 1575/1596/1608/1659/1691 行（工具内部与 catch 里的 `agent.abort()`）；`KNOWN_IGNORED_EVENTS` 含 `entry_appended`（第 219–233 行）；用量表 `ModelUsageSource = "model-port" | "agent-stream"`（`packages/application/src/ports/model-usage.ts` 第 16 行）、迁移 `0068_model_usage_observations.sql` 第 6–12 行 `CHECK` 枚举；下一个迁移号 0086（0085 已占用）；`model_usage_observations` 主键 `(owner_id, agent_id, run_id, invocation_id)`；准入 `ModelInvocationSource = "model-port" | "agent-stream" | "embedding"`（`packages/application/src/ports/model-invocation.ts` 第 6 行），`sqlite-model-usage-operations.ts` 第 20–36 行 `valid()` 双保险校验；Vercel 网关单发观察 `gateway-observation.ts` 第 150–152 行二次发送抛 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`；`configured-model-binding.ts` 第 258–284 行 `providerModelConfig` 组装 Pi 模型配置、第 183–239 行 `validateDescriptor`；运行环境消息形状 `runtime-environment-block.ts` 第 114–121 行 `runtimeEnvironmentMessage` 返回 `{ customType: "himawari.runtime-environment", content, display:false, details:{} }`——与 `sendCustomMessage` 入参完全同形；规范要求照官方（`docs/pi-development-guide.md` 第 26–31、277–291 行）、ADR 0204 第 49 行定 D5 插消息先出方案、工具内 `agent.abort()` 暂留；`prompt-prefix.md` 第 35 行只追加规则、第 74 行 `npm run check:prompt-prefix` 门槛；I-73（`docs/incidents-and-gates.md` 第 112 行）教训：产生值的一端必须核对接收端校验。

### 推测 / 未核实

- **1.5.0（锁定版）dist 行号**（sendCustomMessage 1862–1900、dispose 1038–1040、cache-warmer.js 238、sdk.js 199/269）：本检出无 node_modules，未能逐行核对；材料断言其行为与上述 1.5.1 源码一致，动手前按规范「怎样查官方写法」diff 1.5.0/1.5.1。
- `ProviderModelConfig` 在 1.5.0 是否已接受 `promptCache` 字段（1.5.1 类型里有，`getPromptCacheTtlMs` 读它）——**未核实**。
- 生产 Magpie 模型清单现有哪些非 DeepSeek 模型（`apps/agent-service/src/production-magpie-models.ts`，清单动态生成，我只见到类型组装层）——**未核实**；生产是否真的存在短 TTL 模型取决于这份清单。
- 预热重放复用上次请求的 egress exchange（同一 `wrapFetch` 第二次调用）是否被出口层记账容忍——**未核实**，用测试锁（见下）。
- Pi 溢出恢复（compaction `willRetry`）的重试 run 是否排空 steering 队列——`_prepareRetry` 路径未逐行读——**未核实**，按「恢复 run 的 steering 轮询会取到」设计并用现有 willRetry 测试锁住。

---

## 二、问题一：D5 插消息、接着跑——推荐做法

### 做法（全部在 `packages/runtime-pi/src/pi-runtime-adapter.ts`，不改 Pi）

1. **`appendLoopStopped`（第 1383–1397 行）**：删掉 `active.agent.steer` 的 else 分支，统一为
   `void active.sendCustomMessage(toolLoopStoppedMessage(), { deliverAs: "steer", triggerTurn: true })`，catch 里改 `void active.abort().catch(() => undefined)`。同时在调用点加产出侧守卫：`suspended`、`unknownTool`、`failed`、`aborted`、`this.#cancelledRuns.has(runId)` 任一为真时不再发送（这些标志都在 produce 闭包里，取法与 `#continueForSteeredNotices` 的 `canContinue` 相同）。运行中该调用与现状完全一致（`agent.steer`）；不在运行中时官方语义即「立刻用这条消息开一个新 run」——替代现在「入队 + 手工 `agent.continue()`」的组合，且 `before_agent_start` 会照常拿到冻结的系统提示（`himawari-system-prompt` 扩展每轮返回同一份字节）。
2. **后台命令通知（第 1653–1662 行）**：保留 `session.isStreaming` 门（不在运行中返回 false 是产品行为，不动）；运行中改为 `void session.sendCustomMessage(backgroundCommandMessage(notice), { deliverAs: "steer", triggerTurn: true }).catch(() => void session.abort().catch(() => undefined))`——`triggerTurn` 只在非流式时有意义，流式时无副作用；`.catch` 里的 `session.agent.abort()` 换成官方 `session.abort()`（会话外可以等空闲）。
3. **压缩 `willRetry` 补环境（第 1694–1706 行）**：改为 `void session.sendCustomMessage(environment, { deliverAs: "steer" })`。`environment` 已是 `{customType, content, display, details}` 形状（`runtimeEnvironmentMessage`），不必再包 `{ role: "custom", …, timestamp }`——`sendCustomMessage` 自己打 `timestamp: Date.now()`。溢出恢复运行期间 `isStreaming` 为真（`_isAgentRunActive` 覆盖 post-run 阶段），走 `agent.steer` 分支，与现状同一队列、同一送达点。
4. **`#continueForSteeredNotices`（第 1232–1241 行）**：整个删掉。依据前提 3：`session.prompt()` 自己的 post-run 循环会消化所有排队消息和边界续跑，`await session.prompt(...)` + `await session.waitForIdle()` 之后队列已空；settle 期到达的消息由 `sendCustomMessage` 的 `_deferredSettledActions` / `_pendingCustomMessages` 官方兜底。原来这个循环存在是因为「非 streaming 入队后没人 continue」——第 1 条改成 `triggerTurn: true` 后不再需要。
5. **审批续跑 `session.agent.continue()`（第 1788 行）**：保留。1.5.1 `docs/sdk.md` 没有会话层 `continue`（已查原文），且这是 D3 已批准机制的一部分（ADR 0204 第 49 行）；在偏离表 D5 里注明这一条单独申请保留。
6. **工具内部 `agent.abort()`（第 1575/1596/1608 行）**：保留——`session.abort()` 等空闲，工具里等不到自己（ADR 0204 第 3 条已批）。但第 1659、1691 行两个**不在工具内**的 catch（后台通知失败、存历史失败）改为 `session.abort()`，它们能等。

### 为什么

- 四处绕过会话的调用各自要自己拼「什么时候入队、什么时候续跑」，而官方 `sendCustomMessage(message, { deliverAs, triggerTurn })` 在四个分支里统一了这两件事（前提 1）；队列排空、边界续跑、settle 兜底全是会话自己的循环（前提 3），手工 while 循环是对官方行为的重复实现，Pi 升级时会先漂移。
- 语义逐点对齐：运行中 steer = 「下一轮模型请求前追加」；空闲 triggerTurn = 「追加并立刻开一轮」，两者都只在请求末尾追加消息，不改开头。

### 放弃的做法

- **`session.steer()` / `followUp()`（用户消息接口）**：这三个通知是 custom 消息（`display:false`、带 customType），会话级 `steer()` 只收文本、走 input/命令扩展链，还会把它当用户消息去清 `_steeringMessages` 队列——形状和语义都不对，放弃。
- **`agent_before_settle` 返回 `continue:true` 代替手工循环**：它是「每轮结束前补一步」的官方钩子，但触发点是每个 run 的边界，而工具循环停止/后台通知的时机在 run 中途；用它会把插入点推迟到 settle，改变「下一轮请求就能看到通知」的时序，放弃。
- **用 `deliverAs: "nextTurn"` 修压缩补发**：`_pendingNextTurnMessages` 只被 `_prepareRun` 消费（第 2030 行），溢出恢复走 `agent.continue()` 不经过 `_prepareRun`，消息会滞留到下一次用户输入——行为改变，放弃（未核实到能证明相反的源码，风险写在下面）。

### 风险和要加的测试

- **风险 1**：`appendLoopStopped` 非流式分支以前「入队不续跑」，现在会真的开一轮花钱的请求。守卫（suspended/failed/cancelled）必须先于发送判断。测试：工具循环停止且运行已失败时，不产生任何模型请求（反向用例：把守卫删掉，用例必须失败——断言 admission 次数为 0）。
- **风险 2**：压缩补发的送达点若因恢复 run 不排 steering 队列而漂移（前提未核实项），环境说明会迟一轮才进上下文。现有 `packages/runtime-pi/test/runtime-environment-block.unit.test.ts` 和 `pi-runtime-adapter.compat.test.ts` 的 willRetry 用例继续锁「为真补一条、为假不补」，另加断言：补发后紧接的第一次请求里包含环境说明原文（反向：改用 `deliverAs:"nextTurn"` 时该断言失败）。
- **风险 3**：删掉 `#continueForSteeredNotices` 后，若某通知在 `prompt()` 的循环放弃续跑之后才入队，可能漏跑一轮。测试：流式期间 steer 一条后台通知、紧接着让 run 结束，断言该通知已被下一次请求消费且运行收尾时队列空（反向：把 `deliverAs` 改成 `"followUp"` 且消息在 settle 后到达，断言能发现未消费——用 `session.agent.hasQueuedMessages()` 只作测试断言，不进生产代码）。
- **门槛**：`npm run check:prompt-prefix` 必须过——改动只动「何时追加」，不动任何已发出字节；`prompt-prefix.compat.test.ts` 的逐字节前缀比对即回归检查。

### 会不会改变模型已经见过的请求开头

**不会。** 每处通知仍是「追加一条 custom 消息」，追加位置是请求末尾（steer 分支在下一轮模型请求前、triggerTurn 分支作为新 run 的起始消息，都在既有历史之后）；系统提示由冻结的 `before_agent_start` 返回，字节不变；工具定义不变；历史不变。每轮会变的只有消息自身内容（固定提示词目录文本 + 当前通知），全部在最后一条消息里。

---

## 三、问题二：D7 缓存预热——推荐做法

### 做法

1. **显式设置**（`pi-runtime-adapter.ts` 第 1405–1412 行 `SettingsManager.inMemory`）：加 `cacheWarming: "streaming"`。理由：会话按 run 新建/销毁（produce 的 `finally` 里 `session.dispose()`），`dispose()` 即 `cacheWarmer.cancel()`（前提 6），`"idle"` 模式在两次运行之间根本活不到触发；显式写死还挡住 1.5.1 把默认值改成 `"idle"` 的升级漂移。
2. **模型声明**（`packages/runtime-pi/src/configured-model-binding.ts`）：`ConfiguredPiModelDescriptor` 加可选 `promptCache?: { short: number; long?: number }`；`providerModelConfig` 透传；`validateDescriptor` 加一条：`provider === "vercel-ai-gateway"` 且写了 `promptCache` → 抛 `TypeError`（网关单发观察使重放必失败，见前提 7 与 `gateway-observation.ts:150`）。生产清单（`production-magpie-models.ts` 一侧，**未核实具体清单**）只给短 TTL 模型标。
3. **预算与用量**（`pi-runtime-adapter.ts` 新增一个隐藏内联扩展 `himawari-cache-warming-budget`，挂在现有 `extensionFactories` 里；准入/用量依赖都在 produce 闭包内可用）：
   - `pi.on("cache_warming_decision", async (event, ctx) => {...})`：用 `this.#dependencies.admission` 走 `gate.begin({ modelRef, provider, model, …, source: "agent-stream", ordinal, estimatedCostMicros: 预热估价, pricing })` 拿 permit——准入失败或 `disposition !== "fresh"` 就 `return { action: "stop" }`（官方语义：停止到下一次真实请求为止，不重试风暴）。预估成本用事件里的 `warmCost`（美元 → 微秒）与描述符定价。
   - 成功 begin 后立刻 `permit.markStarted()`，挂一个「超时未见到用量条目就 `markUnknown("transport_unresolved")`」的定时器（对齐 chat 流的 fail-closed 语义）。
   - **接用量**：`entry_appended` 从 `KNOWN_IGNORED_EVENTS` 拿出，`mapEvent` 加处理分支——只认 `costType === "cache_warm"` 的 usage 条目（Pi 的 `UsageEntry` 精确形状**未核实**，实现时对照锁定版类型），用它结算 `permit.settle(usage)` 并写用量表：`source: "cache-warm"`、`purpose: "cache-warm"`、`invocationId: admission.identity.invocationId`、其余字段同 chat 路径；其它 `entry_appended`（边界草稿、虚拟模型状态条目）照旧忽略——不拿出来会报未知事件，全处理会误伤 chat 期间的边界条目。
   - `catch`：决策处理器抛错时 Pi 回退到自己的判断（前提 5 原话），所以处理器内部吞掉准入异常、返回 `{ action: "stop" }`，不允许放行没过预算的预热。
4. **持久化**（`packages/persistence-sqlite`）：
   - 新迁移 `0086_model_usage_cache_warm.sql`：重建 `model_usage_observations`，`source CHECK` 加 `'cache-warm'`、`purpose CHECK` 加 `'cache-warm'`，旧行原样搬回（SQLite 改 CHECK 只能重建表）。
   - `packages/application/src/ports/model-usage.ts`：`ModelUsageSource` 与 `MODEL_USAGE_PURPOSES` 各加 `"cache-warm"`；`modelUsagePurpose()` 解析同步。`lowCacheHitRate` 只看 `purpose === "chat"`，不受影响（预热不参与命中率监控，避免拉低指标）。
   - `sqlite-model-usage-operations.ts` 的 `valid()` 同步放宽，两端口径一致（I-73 的教训：两端都要改）。
5. **准入 source 不新增**：预热 permit 复用 `"agent-stream"`，与 chat 的区分靠 `logicalSlot`（如复用 `logicalSlotFor(request, ordinal)` 加后缀）和用量行的 `source`。否则要同时改 `ModelInvocationSource`、准入服务 `SOURCES`（`model-invocation-admission-service.ts:24`）和 0023/0024/0025/0049/0083 五个迁移的 CHECK——代价不成比例。这个取舍交 Andy 确认。

### 为什么

- Pi 的经济学门槛（预期节省 ≥ $0.05）和 30 分钟封顶是官方策略，保留它、只把「放不放行」接到 Himawari 预算上（决策事件就是官方留给宿主的口子，前提 5 原话），满足「预热要保留、但不能绕过预算控制」（`.claude/rules/owner-standing-rules.md`「钱和模型」+ 材料里 Andy 2026-11-10 的决定）。
- 重放带的是上次请求的选项（前提 5）：遮盖 `fetch` 和密钥都在——出口遮盖不被绕开；网关模型则因单发观察必然失败，所以从声明层禁止网关模型预热，把「必失败的重放」变成「根本不发生」。

### 放弃的做法

- **给预热单独造一条能重复用的 `fetch`**（材料倾向的方案）：`cacheWarmer.start` 在 Pi 的 `streamFn` 里捕获我们传给 `original()` 的同一份 options（前提 5），Himawari 没有 hook 能给重放单独换 fetch；要换就得改 Pi 或继续加大 D1 的偏离。改为：接受同一 `exchange.wrapFetch` 复用（遮盖规则确定、前缀规则第 11 条保证同段文字遮出同样字节），并用测试证明可复用；网关模型直接禁声明。
- **`cacheWarming: "off"` 一刀切**：违反 Andy 的明确决定，放弃。
- **自己实现预热调度、Pi 设 off**：偏离官方调度/经济学/重放安全性（`isCacheWarmingReplayable` 还挡 Anthropic thinking 预算陷阱），维护成本高，放弃。

### 风险和要加的测试

- 预热条目发出但 permit 超时未结算 → `markUnknown`：测试伪造决策返回 warm 后 Pi 不发请求（如 `refreshDeadlineMissed`），断言账本出现 unknown 记录而非静默丢失（反向：去掉超时定时器，用例失败）。
- 同一 exchange 二次复用：用例「真实请求 + 预热重放连续两次都过遮盖、都带密钥、第二次响应可读」（反向：若出口层拒绝二次调用，该用例失败，届时再出方案换 fetch——这是**未核实**项的风险出口）。
- 网关模型声明 `promptCache` → 绑定层抛错（反向用例：去掉 validateDescriptor 那条，绑定测试失败）。
- 迁移 0086：旧库数据行数与内容不变、新枚举可写入、旧枚举照常（反向：手工插入 `source='cache-warm'` 于未迁移库必须失败）。
- 决策事件准入拒绝 → 返回 stop：断言该次预热 0 请求、0 账本记录。
- DeepSeek：无 `promptCache` → 决策事件从不触发（断言 0 次决策调用），`check:prompt-prefix` 照常通过。

### 会不会改变模型已经见过的请求开头

**不会。** 预热重放的 context 就是上次真实请求的 context（同一 `transcript` 对象被捕获，前提 5），`maxTokens: 1`，不写任何新内容进历史（前提 5：usage 不进模型上下文）；对真实请求序列是「原样重放」，只追加不存在，更没有开头改写。`entry_appended` 只进会话存储，不进请求。

### D7 附加一：空闲预热（两次运行之间）值不值得做

**现在不做，`streaming` 已够，理由：**
1. 架构不支持：每 run 新建会话、跑完 `dispose()`，`dispose` 即 `cacheWarmer.cancel()`（前提 6）；要启用 idle 得把会话或 warmer 常驻到两次运行之间，牵动 D1/D2/D3 的整条恢复链，是大改动，收益不成比例。
2. 主力 DeepSeek 缓存自动开启、不用后「usually within a few hours to a few days」才清（https://api-docs.deepseek.com/guides/kv_cache ），根本不需要预热，预热它反而每次 TTL 花钱。
3. 两次运行之间主人何时再发话未知，Pi 的 idle 概率常数 0.15（前提 5）本就是保守估计；chat 场景省下的钱有限。

**将来怎么做**（若迁到常驻会话或短 TTL 模型成为主力）：Pi 的 `idle` 模式天然支持（最多续 30 分钟、$0.05 经济门槛、`cache_warming_decision` 仍可按预算拦截），预算/用量按本方案第三节的扩展模式原样接上即可，无需新机制。

### D7 附加二：哪些模型写 `promptCache`

- **DeepSeek 系一律不写**（同上，缓存自管且数小时不失效）。
- **短 TTL 模型（Anthropic 类默认约 5 分钟，参考 https://platform.claude.com/docs/en/build-with-claude/prompt-caching ）写 `{ short: 300 }` 级别的保守值**（`docs/models.md` 原话 `"Choose the conservative end of any published range"`）。
- **经 vercel-ai-gateway 的模型一律不写**（单发观察限制）。
- 生产清单里现在实际有哪些短 TTL 模型——**未核实**（清单动态来自 Magpie）；做法是把 `promptCache` 做成清单项的可选显式字段，谁该写由 Andy 在清单里逐个标注，未标注就不预热。

---

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？** 两个改动都不会。D5：所有通知仍只在末尾追加一条 custom 消息（运行中→下一轮请求前；空闲 triggerTurn→新 run 的第一条，均在既有历史之后），系统提示、工具定义、历史、遮盖结果全部原样；每轮会变的值只在最后一条消息里。D7：预热是上一次请求的逐字节重放（context、options 原样，maxTokens=1），不产生新前缀、不写历史。`npm run check:prompt-prefix` 逐字节前缀比对继续作为回归门槛。

**2. 会不会让同一段文字在不同请求里变成不同字节？** D5 不会：通知文本全部来自提示词目录固定文字，消息顺序是 FIFO 队列（前提 4），时间戳只在最后一条消息里。D7 不会：重放用同一份已遮盖 context 与同一遮盖规则（同一 exchange，密钥不变），同段文字遮出同样字节——这正是要在「连续两次都遮盖、都带密钥」测试里锁住的点。

**3. 有没有对应的自动检查，反向用例会失败吗？** 有。既有门槛：`npm run check:prompt-prefix`（含 4 条反向用例）、`runtime-environment-block.unit.test.ts` / `pi-runtime-adapter.compat.test.ts`（willRetry 补发，反向已存在）。新增：D5 的守卫用例、通知消费用例、压缩补发送达点断言；D7 的迁移用例、准入拒绝用例、permit 超时用例、网关禁声明用例、二次复用用例——每条都写了「去掉对应实现时用例必须失败」的反向断言（上文各节）。1.5.0 锁定版 dist 行为的核对本身也应落成升级守门用例（按规范第六节第 4 条）。

**4. 每个产生/修改的值，使用端都能接受吗？** 逐个核过（I-73 口径）：
- D5 不新增值：`himawari.tool-loop.stopped` / `himawari.background.command` / `himawari.runtime-environment` 三个 customType 产生端（适配器）与消费端（Pi 会话存储、`previousRuntimeEnvironment` 匹配器 `runtime-environment-block.ts:97`）完全不变，只是产生方式从 `agent.steer` 换成 `sendCustomMessage`——Pi 端入档与模型消息形状经前提 1 核实一致（`customType/content/display/details` 同形）。审批续跑的 `agent.continue()` 保留为已批偏离并登记。
- D7 新增值逐端核对：`promptCache`（清单端产生 → descriptor 校验端 → Pi `getPromptCacheTtlMs` 消费；Pi 端消费语义已核实，清单端内容**未核实**，由 Andy 标注）；`cacheWarming: "streaming"`（Pi settings 合法枚举，前提 5）；准入 `source` 复用 `"agent-stream"`（合法枚举，前提 7 中 `model-invocation.ts:6`），不触身份表迁移；用量行新 `source/purpose = "cache-warm"`（产生端适配器 → `modelUsagePurpose()` 解析 → sqlite `valid()` → 迁移 0086 的 CHECK，四处一次改齐，单一重建迁移、连续迁移号 0086）；`invocationId` 来自准入 identity（非空、PK 唯一，0068 主键约束兼容）；`entry_appended` 事件消费分支只认 `cache_warm` 条目、其余照旧忽略（否则 chat 期间的边界草稿条目会误触发结算——这一点在实现时对照锁定版 `UsageEntry` 类型再核，**未核实**部分已标出）。

**需要人拍板的取舍**：① 预热 permit 的准入 `source` 复用 `"agent-stream"` 还是新增 `"cache-warm"`（后者要动五个迁移）；② `#continueForSteeredNotices` 整个删除依赖 `prompt()` 内建循环（前提 3），若 Andy 想保守，可保留一层 `waitForIdle` 兜底而不带 `continue`；③ 审批续跑的 `agent.continue()` 是否作为 D5 的永久豁免登记进偏离表 ADR；④ 生产清单里哪些模型标 `promptCache`（以及若出口层不允许多余复用，是否接受为预热单独造 fetch 的后续方案）。
