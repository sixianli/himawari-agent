说明：已达到本次任务的工具步数上限，前面不能再读文件；以下是基于已读代码、官方 Pi 1.5.0 源码/文档和仓库规则的完整结论。**未核实**处已单独标注。

# 一、方案依赖的前提

## 共同约束

1. **发给模型的内容只能追加，系统提示和工具按对话冻结。**
   来源：`.claude/rules/prompt-prefix.md:4,6,28-29`。原话：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”；“每轮都会变的内容只放在最后一条用户消息里”；“要告诉模型新情况时，追加一条消息，不改系统提示。”

2. **花钱的请求必须过预算控制。**
   来源：`.claude/rules/owner-standing-rules.md:16-19`。原话：“花钱先问……任何评测、测试、实验或批量模型调用……”；生产模型调用必须按项目预算和路由规则执行。

3. **只有 `packages/runtime-pi` 能导入 Pi；官方有写法就照官方写。**
   来源：`docs/pi-development-guide.md:26-31`。原话：“官方有写法就照官方写”；“只有两种情况允许不照官方写：官方没有能满足需求的写法，或者官方写法有缺陷。”

4. **`npm run check:prompt-prefix` 必须过。**
   来源：`package.json:55`；`scripts/check-prompt-prefix.mjs:8-10,43-47`。原话：要求至少 8 条 `[I-66]` 测试通过。

## D5 相关

5. **`session.sendCustomMessage` 的官方分支就是当前要接的写法。**
   来源：`@earendil-works/pi-coding-agent@1.5.0` 的 `packages/coding-agent/src/core/agent-session.ts:2378-2414`（https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/agent-session.ts#L2378-L2414）。原话/代码：运行中且 `triggerTurn !== false` 时，`deliverAs: "followUp"` 走 `agent.followUp`，否则走 `agent.steer`；不在运行且 `triggerTurn` 为真时启动新运行；不在运行且无 `triggerTurn` 时追加；`deliverAs: "nextTurn"` 进入 `_pendingNextTurnMessages`。

6. **`session.steer` / `session.followUp` 是用户消息的官方入口；自定义消息用 `sendCustomMessage`。**
   来源：`docs/sdk.md`（1.5.0，https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/sdk.md#prompting）。原话：“A steering message enters after the current assistant turn and its tool calls. A follow-up enters after the current run finishes its pending work.”

7. **Pi 自己会在一次运行结束前继续处理排队消息。**
   来源：`agent-session.ts:1894-1938`、`2000-2036`。`_startRun` 在 `agent.prompt` 后循环：`if (await this._handlePostAgentRun()) { await this.agent.continue(); continue; }`；`_handlePostAgentRun` 最后返回 `!this._agentRunAbortRequested && this.agent.hasQueuedMessages()`。所以 Himawari 不需要自己再用 `agent.hasQueuedMessages()` + `agent.continue()` 补跑。

8. **`session.abort()` 会等会话空闲；工具内部不能等。**
   来源：`docs/sdk.md`（1.5.0）原话：“`abort()` stops the active operation and waits for the session to become idle.”；`agent-session.ts:2519-2536`。ADR 0204 已批准工具内部继续用 `agent.abort()`（`docs/adr/0204-handle-pi-deviations-d2-d3-d5.md:49`）。

9. **当前 D5 位置已核实。**
   来源：`packages/runtime-pi/src/pi-runtime-adapter.ts:1232-1241`（`#continueForSteeredNotices`）、`1383-1397`（`appendLoopStopped`）、`1653-1662`（后台通知）、`1694-1706`（压缩后补运行环境）、`1788`（审批续跑 `session.agent.continue()`）。其中后台通知运行中已经用 `session.sendCustomMessage(..., { deliverAs: "steer" })`；工具循环停止运行中也已经用同一官方入口。

## D7 相关

10. **只有模型配置写了 `promptCache`，Pi 才会预热。**
    来源：`docs/models.md`（1.5.0，https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/models.md#prompt-cache-lifetimes）。原话：“Use `promptCache` to declare the provider's best-effort cache lifetime in seconds for the `short` or `long` retention tier”；“A model without a lifetime for the active tier is not eligible for cache warming.”

11. **`cache_warming_decision` 是官方预算闸门。**
    来源：`docs/extensions.md`（1.5.0，https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/extensions.md#cache_warming_decision）。原话：“Return `{ action: "warm" }` or `{ action: "stop" }` to override; the last handler that returns an action wins. `"stop"` ends warming until the next real request.”

12. **Pi 预热直接重放上一次请求，成功后才追加 `cache_warm` 用量条目。**
    来源：`packages/coding-agent/src/core/cache-warmer.ts`（1.5.0，https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/cache-warmer.ts）。代码：`this.models.streamSimple(run.model, run.context, { ...run.options, maxTokens: 1, maxRetries: 0, signal: run.controller.signal }).result()`；成功后 `this.sessionManager.appendUsage("cache_warm", message.provider, message.responseModel ?? message.model, message.usage, ...)`，再 `this.onWarmed?.(entry)`。

13. **预热选项来自真实请求，由 Pi SDK 在 `streamFn` 里保存。**
    来源：`packages/coding-agent/src/core/sdk.ts`（1.5.0，https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/sdk.ts）。代码：`if (options?.sessionId === sessionManager.getSessionId()) cacheWarmer.start({ model, context, options: requestOptions }, ...)`；然后 `return modelRuntime.streamSimple(model, context, requestOptions)`。

14. **Himawari 替换 `session.agent.streamFunction` 后，真实请求仍会调用原来的 SDK stream function。**
    来源：`pi-runtime-adapter.ts:1617-1651`、`1085-1092`。代码先保存 `originalStreamFunction`，在 `admitPiStream` 里再调用 `original(model, transcript, {...withoutAmbientApiKey, apiKey: secret, maxRetries: 0})`。所以预热会启用，但重放使用保存下来的 `run.options.fetch`，绕过 Himawari 的准入、预算和用量记录。

15. **`entry_appended` 现在被忽略。**
    来源：`pi-runtime-adapter.ts:219-233`，`KNOWN_IGNORED_EVENTS` 包含 `"entry_appended"`。

16. **用量表目前不接受 `cache-warm` purpose。**
    来源：`packages/application/src/ports/model-usage.ts:3-16`；`packages/persistence-sqlite/src/sqlite-model-usage-operations.ts:20-35`；`packages/persistence-sqlite/src/migrations/0068_model_usage_observations.sql:6-12,25-26`。原 CHECK：`purpose IN ('chat','thread-title','memory-capture','memory-episode','memory-consolidation','mail-judgment','action-review','other')`；`source IN ('model-port','agent-stream')`。

17. **下一个迁移号是 0086。**
    来源：`packages/persistence-sqlite/src/migration-engine.ts:669-673` 最后一条是 `sequence: 85`、`0085_memory_reminder_cancelled.sql`。

18. **Vercel 网关的 `observeGatewayFetch` 只允许发一次。**
    来源：`packages/runtime-pi/src/gateway-observation.ts:138-168`。原话/代码：第二次调用 `throw new Error("AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN")`。

19. **出口遮盖的 `Exchange` 会累积“已知秘密”，重放同一 Exchange 会改变前面文字的遮法。**
    来源：`packages/application/src/services/model-egress.ts:128-131,165-174`；`packages/sensitive-capture/src/redaction.ts:411-425`。`Exchange` 持有 `#known`；`redactUntrusted` 在文本后面的流程里会把 `known` 中记录的每个值在全文范围内再遮一遍。正常请求中，如果秘密在后一条消息才被点名，前一条消息里的同值不会被遮；用同一个 Exchange 重放整段上下文时，`known` 已包含后来的秘密，前一条消息里的同值会被遮，字节就变了。这违反 `prompt-prefix.md:52` 的确定性要求。

20. **Magpie 动态模型描述符会继承主描述符的所有字段。**
    来源：`apps/agent-service/src/production-magpie-models.ts:113-144`，`descriptorFor` 以 `...primary` 开始。若给主描述符加 `promptCache`，所有动态发现的 Magpie 模型都会错误继承同一个缓存寿命。模型列表解析 `parseMagpieModelList`（同文件 66-111）没有解析缓存寿命字段。

21. **DeepSeek 缓存默认开启，且长期不清。**
    来源：https://api-docs.deepseek.com/guides/kv_cache 原话：“The DeepSeek API Context Caching on Disk Technology is enabled by default for all users”；“Once the cache is no longer in use, it will be automatically cleared, usually within a few hours to a few days.”

22. **Pi 1.5.1 把 `cacheWarming` 默认值从 `"streaming"` 改成 `"idle"`。**
    来源：`docs/adr/0203-follow-pi-official-extension-patterns.md:39`。这是项目 ADR 对 1.5.1 `docs/settings.md` 第 21 行的转述；**本次未直接打开 1.5.1 的该文件，原行未核实**。1.5.0 默认 `"streaming"` 已由 1.5.0 `docs/settings.md` 核实：“`cacheWarming` … Default `"streaming"`”。

---

# 二、D5 推荐方案

## 2.1 做法

### A. 工具循环停止提示 `appendLoopStopped`

文件：`packages/runtime-pi/src/pi-runtime-adapter.ts:1383-1397`。

- 运行中：继续用 `session.sendCustomMessage(toolLoopStoppedMessage(), { deliverAs: "steer" })`（现在已经是官方写法）。
- 不在运行中：把 `active.agent.steer({...})` 改成
  `await session.sendCustomMessage(toolLoopStoppedMessage(), { deliverAs: "nextTurn" })`。
- 发送失败的兜底：不要 `active.agent.abort()`，改成
  `void session.abort().catch(() => undefined)`。`session.abort()` 会立即请求底层中止，再等空闲；因为这里不 `await`，不会在工具内部死等。

`sendCustomMessage` 在运行中构造的 `appMessage` 与当前 `agent.steer` 构造的对象形状相同（`role: "custom"`、`customType`、`content`、`display`、`details`、`timestamp`），插入位置也相同，所以正常路径不改字节。

### B. 后台命令完成通知 `subscribeBackground`

文件：`pi-runtime-adapter.ts:1653-1662`。

- 运行中：保持 `session.sendCustomMessage(backgroundCommandMessage(notice), { deliverAs: "steer" })`。
- 不在运行中：继续保持返回 `false`。
- 发送失败：改成 `void session.abort().catch(() => undefined)`，不再直接调 `session.agent.abort()`。

这一处已经是官方写法，不需要改变消息时机。

### C. 压缩结束且 `willRetry` 时补运行环境

文件：`pi-runtime-adapter.ts:1694-1706`。

把：

```ts
session.agent.steer({ role: "custom", ...environment, timestamp: Date.now() });
```

改成：

```ts
void session.sendCustomMessage(environment, { deliverAs: "steer" })
  .catch(() => void session.abort().catch(() => undefined));
```

`environment` 来自 `runtimeEnvironmentMessage`（`runtime-environment-block.ts:114-121`），形状正好是 `sendCustomMessage` 需要的 `customType/content/display/details`。`sendCustomMessage` 在 streaming 分支里同步调用 `agent.steer`，因此 `void` 不会改变“压缩结束 → 重试请求”之间的排队时机。

### D. 删除 `#continueForSteeredNotices`

文件：`pi-runtime-adapter.ts:1232-1241`、`1805-1814`。

删除 `#continueForSteeredNotices`，只保留 `await session.waitForIdle(); await eventChain;`。理由：Pi 1.5.0 的 `_startRun` 已经会在 `agent.prompt` 后检查 `hasQueuedMessages()` 并 `agent.continue()`（`agent-session.ts:1921-1930`），`_handlePostAgentRun` 也返回排队状态（`:2000-2036`）。Himawari 再手动继续是重复的底层调用。

### E. 审批续跑

文件：`pi-runtime-adapter.ts:1788`。

推荐**暂时保留** `if (restored) await session.agent.continue();`，并把它作为 D5 的残余偏离单独交 Andy 批准。原因：

- 官方会话接口没有“从恢复的工具批次继续，但不添加任何新消息”的方法。
- 可用的官方写法只有 `session.sendCustomMessage(..., { triggerTurn: true })` 或 `session.prompt(...)`，两者都会追加一条模型可见消息，改变恢复后第一次请求的内容；这不只是“末尾追加”的问题，还改变了审批后续跑时模型看到的上下文。
- `session.agent.continue()` 是底层方法，但它是目前唯一不添加消息、只触发下一次模型请求的写法。

如果 Andy 不接受残余偏离，替代方案是追加一条隐藏的 `custom_message`（如 `himawari.approval.resume`）再 `triggerTurn`，代价是模型会看到这条合成消息，并且它会进入历史。我不推荐把它当默认方案。

## 2.2 为什么

- 插消息的官方语义就是 `session.sendCustomMessage`；运行中 steer 是官方定义的同轮插队，压缩后补环境也一样。
- 后台通知已经用了官方入口，没必要改。
- `#continueForSteeredNotices` 的职责已经被 Pi 的 `_startRun`/`_handlePostAgentRun` 覆盖；保留它只会多一层底层调用。
- 审批续跑没有官方“无消息续跑”接口，保留 `agent.continue()` 是有明确理由的残余偏离，而不是偷懒。

## 2.3 考虑过但不选的做法

1. **把审批续跑也改成 `session.sendCustomMessage(..., { triggerTurn: true })`。**
   不选：会追加一条合成消息，改变恢复后模型看到的上下文；审批续跑的目标是接着已有工具结果继续，不是让模型看一条新通知。

2. **把不在运行中的循环停止提示改成 `followUp` + `triggerTurn: true`。**
   不选：会立即启动一次新的付费运行；当前 `agent.steer` 只是排队，不启动运行。`nextTurn` 更接近现有语义。

3. **保留 `#continueForSteeredNotices` 作为保险。**
   不选：官方已经处理排队消息；保留会让代码继续依赖 `agent.hasQueuedMessages()`、`agent.continue()`，扩大 D5。

## 2.4 风险与反例

- **`nextTurn` 的排队位置可能和 `agent.steer` 不同。** 当前 `agent.steer` 在 idle 时把消息放进底层队列；`nextTurn` 进入 `_pendingNextTurnMessages`，下一次 `_prepareRun` 会把它放在新用户消息之后。这个分支从代码路径看很少触发（`appendLoopStopped` 只在 `tool_result` 回调里调用，此时会话通常仍在 streaming），但**未核实是否完全不可达**。测试要锁住“不在运行中时不启动新运行、只排队”。
- **`void session.abort()` 的 Promise 可能长期不 resolve。** 只要不 await 就没有问题；但要确保没有未处理的 rejection。
- **删除 `#continueForSteeredNotices` 后，若 Pi 的排队处理在某个边界漏掉消息，后台通知会延后到下一轮。** 必须加真实 Pi 的测试；如果测试证明 Pi 不处理，再改回官方 `agent_before_settle` 方案，而不是恢复底层 `hasQueuedMessages()`。
- **审批续跑仍是残余偏离。** 这是一个明确的取舍，不是“已经全部官方化”。

## 2.5 要加的测试（含反向）

- `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:1611-1677`：把压缩环境测试的 `agent.steer` spy 改成 `session.sendCustomMessage`，断言 `deliverAs: "steer"`，并断言 `agent.steer` 没有被适配器直接调用。**反向**：若代码改回 `agent.steer`，测试失败。
- 同文件 `3299-3344` 工具循环测试保留，断言最终请求最后一条消息是 `himawari.tool-loop.stopped`，系统提示和工具不变。
- 同文件 `4142-4188` `[BG-2]` 保留；再加一条在 `agent_end` 附近触发后台完成的通知用例，断言 Pi 自己继续了请求、通知出现在最后一条消息。**反向**：若删除 `#continueForSteeredNotices` 后通知丢失，测试失败。
- `pi-tool-batch-continuation.compat.test.ts:156,296` 附近：审批续跑后第一次请求必须与恢复快照前缀一致，且没有新增合成消息。**反向**：若改成 `sendCustomMessage` 追加消息，测试失败。
- 更新 `pi-runtime-adapter.compat.test.ts:411-457` 的假会话，补上 `sendCustomMessage`，否则新写法无法测。

## 2.6 对模型已见请求开头的影响

**不改系统提示、工具定义、历史消息或遮盖结果。** 所有新增内容都通过 `sendCustomMessage` 追加：运行中 steer 在当前 assistant 轮和工具结果之后进入；压缩后环境说明在压缩边界之后、重试请求之前进入（压缩本身是规则允许的例外）；`nextTurn` 只在下次用户消息之后进入。每轮会变的内容仍然只在最后追加的消息里。审批续跑保持不添加消息。

---

# 三、D7 推荐方案

## 3.1 做法

### A. 模型配置新增 `promptCache`

文件：

- `packages/runtime-pi/src/configured-model-binding.ts`：`ConfiguredPiModelDescriptor` 增加可选 `promptCache?: { short?: number; long?: number }`；`freezeDescriptor` 深冻结；`validateDescriptor` 校验正整数（建议 `> 10`，因为 Pi 对 `<= 10_000ms` 直接不预热）；`providerModelConfig` 只在存在时加 `promptCache`。
- `packages/application/src/ports/configuration.ts:39-49`：`ConfiguredCompletionsGenerationModelDescriptor` 增加同一可选字段。
- `packages/platform-node/src/strict-configuration.ts:369-418`：解析并校验 `promptCache`。
- `apps/agent-service/src/production-model-composition.ts:194-242`：`piGenerationDescriptor` 只在配置显式给出时传 `promptCache`。
- `apps/agent-service/src/production-magpie-models.ts:113-144`：**明确不要从 `primary` 继承 `promptCache`**。`descriptorFor` 要么显式删除该字段，要么按模型 id 查一张显式表。
- 配置样例 `scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json` 如需示例再补；不加不影响。

**当前生产不建议给任何 DeepSeek 模型写 `promptCache`**，理由见 3.6。

### B. 显式设置 `cacheWarming: "streaming"`

文件：`pi-runtime-adapter.ts:1405-1412` 的 `SettingsManager.inMemory` 增加：

```ts
cacheWarming: "streaming",
```

1.5.0 默认就是 `"streaming"`，所以不改变现有行为；1.5.1 默认改成 `"idle"` 后，这一行防止升级后行为漂移。Himawari 每次运行结束都 `session.dispose()`，而 Pi 的 `dispose()` 会 `cacheWarmer.cancel()`（`agent-session.ts:1428-1449`），所以 idle 预热本来也活不过一次运行；显式 `streaming` 让语义和生命周期一致。

### C. 用 `cache_warming_decision` 做预算闸门

在 `DefaultResourceLoader` 的 `extensionFactories` 里新增一个隐藏的内联扩展（可以和 `himawari-provider-observer` 并列），注册：

```ts
pi.on("cache_warming_decision", async (event) => {
  if (event.action !== "warm") return { action: "stop" };
  const permit = await beginCacheWarmAdmission(request, binding, ...);
  if (!permit) return { action: "stop" };
  pendingWarmPermits.push(permit);
  return { action: "warm" };
});
```

`beginCacheWarmAdmission` 需要复用 `admitPiStream` 的校验逻辑，但走独立的 `logicalSlot`/`ordinal`：

- `source: "agent-stream"`
- `logicalSlot`: `${logicalSlotFor(request, warmOrdinal)}:cache-warm`（必须和真实请求的 slot 不同）
- `ordinal`: 独立的 `warmOrdinal`，从 1 开始，必须是正整数（`model-invocation-admission-service.ts:496`）
- `estimatedCostMicros`: 必须等于 `binding.admissionCost.estimatedCostMicros`，不能用 Pi 的 `warmCost` 临时算，因为 admission 会校验“估算必须等于注册描述符的估算”（`model-invocation-admission-service.ts:497-505`）
- `pricing`: `binding.admissionCost.pricing`
- `budgetAccount`: 默认 `"run"`

拿到 `fresh` 后调用 `await permit.markStarted()`，再返回 `warm`。如果 gate 不可用、描述符不匹配、预算不允许或 `markStarted` 失败，一律返回 `stop`。这保证预热请求在发出前已经预留预算。

### D. 预热必须用“每次调用都新建 Exchange”的 fetch

这是 D7 最关键的正确性问题。

不要把正常请求的 `exchange.wrapFetch(...)` 或 `observeGatewayFetch(...)` 直接留给 Pi 预热重放。正确做法是给 `original()` 传一个 **可重放的 fetch 包装器**：

- 第一次调用（真实请求）：用当前的 `exchange`，这样 `restoreModelStream` 能还原占位符；同时用 `observeCacheFields` 和（网关时）`observeGatewayFetch` 观察本次响应。
- 后续调用（Pi 预热）：每次新建 `egress.exchange(同一个 context)`，再 `wrapFetch(baseFetch)`；网关时再新建一个 `observeGatewayFetch`。这样：
  - 每次预热的遮盖都从空的 `known` 开始，和原始请求用同一把 key、同一 ruleset，重放出的字节与原始请求一致。
  - 不会复用网关的单次观察器，因此不会触发 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`。
  - 不会把正常请求后来学到的秘密带到预热前面，避免“前面文字被重新遮掉”。

实现上，`admitPiStream` 可以持有一个 `firstCall` 标志：首次 fetch 用真实请求的观察器；之后每次调用走 `fresh exchange + fresh cache observation + fresh gateway observation`，并把每次的 `gateway.result()` / `cacheFields.reported()` 放进一个队列，交给后面的 `entry_appended` 处理。

### E. 用 `entry_appended` 记用量并结算预算

文件：`pi-runtime-adapter.ts` 的 session `subscribe` 回调（`1664-1790`）。

`entry_appended` 可以继续留在 `KNOWN_IGNORED_EVENTS` 里；在 `subscribe` 回调里处理即可，不必加 `mapEvent` 分支：

```ts
if (event.type === "entry_appended" &&
    event.entry.type === "usage" &&
    event.entry.kind === "cache_warm") {
  // 取 pendingWarmPermits 的队首 + 对应 warm 的 gateway/cache observation
  // 1) permit.settle(usage)
  // 2) usage.store.record(...)
}
```

- `inputTokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite`
- `outputTokens = entry.usage.output`
- `cacheReadTokens = entry.usage.cacheRead`
- `cacheWriteTokens = entry.usage.cacheWrite`
- `cacheReported` 用该次预热 fetch 的 `observeCacheFields(...).reported()` 结果，而不是猜。
- `invocationId` 用该次 `gate.begin` 的 `identity.invocationId`，这样预算账本和用量表对得上。
- `purpose` 用新增的 `"cache-warm"`，`source` 用 `"agent-stream"`。
- 网关预热如果拿到了 `gateway.result()` 的 verified billing，就在 `permit.settle` 里传 `reportedCostMicros`；非网关按既有 Magpie 方式让 admission 用 pricing 计算。
- 用量记录失败调用 `usage.onFailure`，不要让用户回答失败；预热本身是 best-effort。

**失败清理**：`cache_warming_decision` 里已经 `markStarted`，但 Pi 可能在决定后因为 deadline/上下文变化而不发、或请求失败不追加 usage 条目。给每个 pending permit 挂一个 `setTimeout`（`providerRequestMs + margin`），到点仍未等到 entry 就 `permit.markUnknown("transport_unresolved")`；session dispose 前也必须清理所有 pending warm，避免预算永久占用。定时器要 `unref()`。

**等待写入**：在 `finally` 里、`session.dispose()` 之前，等待 `warmWrites` 链，确保 `record`/`settle` 完成。否则运行结束进程退出可能丢记录。

### F. 用量表新增 `cache-warm` purpose（迁移 0086）

推荐新增 `purpose: "cache-warm"`，而不是复用 `"other"`。理由：Andy 要看预热花了多少钱，混进 `other` 无法单独统计；`cache-hit-report` 按 purpose 分组也能直接看到。

改动点：

1. `packages/application/src/ports/model-usage.ts:3-14`：`MODEL_USAGE_PURPOSES` 增加 `"cache-warm"`。
2. `packages/persistence-sqlite/src/sqlite-model-usage-operations.ts:20-35`：它已经用 `MODEL_USAGE_PURPOSES` 校验，自动接受；不需要改源码，但测试要覆盖。
3. 新增 `packages/persistence-sqlite/src/migrations/0086_cache_warm_model_usage.sql`：SQLite 不能在现有 CHECK 上加值，必须重建表：
   - 建新表，`purpose IN (..., 'cache-warm')`，其余列、`STRICT`、主键、`cache_reported` CHECK 保持原样；
   - `INSERT INTO new SELECT ... FROM model_usage_observations`；
   - `DROP TABLE model_usage_observations`；
   - `ALTER TABLE new RENAME TO model_usage_observations`；
   - 重建 `model_usage_observations_time_index`。
   放在事务里。
4. `packages/persistence-sqlite/src/migration-engine.ts:669-673` 后增加 `sequence: 86`、`name: "cache_warm_model_usage"`、`changeSet`、`phase: "expand"`、`file: "0086_cache_warm_model_usage.sql"`。
5. `packages/persistence-sqlite/src/schema-catalog.ts:779-784` 的描述从“finished model request”改为包含 cache warm 的说明。
6. `scripts/operations/cache-hit-report.mjs` 不需要改；它按任意 purpose 分组。新增 `cache-warm` 会自然出现在报告里；`lowCacheHitRate` 只对 `purpose === "chat"` 生效，不会误报警。

如果不愿意做表重建，替代方案是复用 `purpose: "other"`、`source: "agent-stream"`，不需要迁移，但会失去“预热费用单独可见”的能力。我不推荐。

### G. 网关预热的取舍

如果要在 Vercel 网关模型上启用 `promptCache`，必须实现 3.1D 的“每次预热新建 gateway observation”，并在 3.1E 用 verified billing 结算预算。做不到时，**不要给网关模型写 `promptCache`**，并在配置校验或测试里锁住，避免运行期出现 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`。

## 3.2 为什么

- 这是官方给出的唯一预算闸门和用量来源：`cache_warming_decision` 控制发不发，`entry_appended` 提供 `cache_warm` 用量条目。
- 预热重放必须逐字节复用原始上下文，所以 egress 必须每次新建；复用 Exchange 会让同一段历史在不同请求里遮成不同字节。
- 网关观察器是单次的，必须每次预热新建，否则第二次请求直接失败。
- 用量表新增 purpose 能让 Andy 看见预热成本，也满足“钱要可控”的长期规则。

## 3.3 考虑过但不选的做法

1. **只加 `promptCache`，不接预算和用量。**
   不选：违反“花钱的请求必须过预算控制”，也无法回答预热花了多少。

2. **完全关闭 `cacheWarming`。**
   不选：Andy 2026-11-10 明确要保留预热；本方案保留机制，只是不给 DeepSeek 写 `promptCache`。

3. **复用正常请求的 `fetch` / `exchange`。**
   不选：会改变前面文字的遮盖字节，预热变成缓存未命中；网关还会第二次请求报错。

4. **用 `entry.id` 当 invocationId，不关联预算 permit。**
   不选：预算账本和用量表会对不上；应该用 admission 的 `identity.invocationId`。

5. **把 `cache-warm` 塞进 `other`，不做迁移。**
   不选：省一次迁移，但失去可观测性；Andy 需要知道预热成本。

## 3.4 风险与反例

- **复用 Exchange 导致字节变化。** 这是最大的反例：正常请求中“密码：X”之前已经出现过 X，正常请求前面不遮；用同一 Exchange 预热时 `known` 已含 X，前面会被遮。字节测试必须能抓住。
- **网关单次观察器。** 如果漏掉“每次新建”，预热第二次调用会抛 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`；测试要能抓住。
- **预算悬挂。** 决定后 Pi 可能没发请求或请求失败，不会产生 usage 条目；必须有超时 `markUnknown` 和 dispose 清理。
- **迁移重建表。** SQLite 重建期间锁表；要用事务、保留旧数据、重建索引，并测从 0085 升级。
- **`promptCache` 进入 descriptor 身份哈希。** `pi-runtime-adapter.ts:1336-1347` 的 `identity` 包含 `binding.descriptor`。如果给一个已有模型新增 `promptCache`，该对话的 continuation 身份会变，挂起中的审批续跑可能报 `RUNTIME_CONTINUATION_BINDING_CHANGED`。建议长期把“不影响请求开头的字段”（如 `promptCache`）从 identity 哈希排除；短期则接受“新增 promptCache 时该模型的挂起审批失效”，并在 ADR 写明。**未核实**现有挂起审批数量。
- **Magpie 动态模型继承。** 如果只在 primary 上加 `promptCache`，`descriptorFor` 会让所有模型都继承，包括 DeepSeek；这会导致错误预热和花钱。必须显式禁止继承。
- **DeepSeek 预热是纯浪费。** 即使配置了 `promptCache`，Pi 也会按 TTL 发 1-token 请求；DeepSeek 本身缓存能存数小时到数天，预热没有收益。

## 3.5 要加的测试（含反向）

1. **配置映射测试**（`configured-model-binding.compat.test.ts`）：
   - 有 `promptCache` 的描述符注册到 Pi 后，`runtime.getModel(...).promptCache` 等于配置值。
   - 没有 `promptCache` 的描述符不出现该字段。
   - **反向**：如果 `descriptorFor` 把 primary 的 `promptCache` 继承给动态 Magpie 模型，测试失败。
   - **反向**：给 DeepSeek 写 `promptCache` 的配置测试应失败（或至少断言当前生产描述符没有该字段）。

2. **真实 Pi 预热测试**（新增或扩展 `pi-runtime-adapter.compat.test.ts`）：
   - 用 loopback HTTP 服务 + 真实 `createAgentSession` + `promptCache: { short: 12 }`，配合 fake timers 推进到预热时刻；断言服务器收到第二次请求，且第二次请求的 `messages`/`system`/`tools` 与第一次逐字节相同，`max_tokens` 为 1。
   - **反向 A**：去掉 `promptCache`，断言没有第二次请求。
   - **反向 B**：复用同一个 Exchange，构造“秘密在后一条消息才点名、前面已出现同值”的上下文，断言第二次请求与第一次逐字节相等；复用时会失败。
   - **反向 C**：网关模型加 `promptCache`，断言第二次预热请求成功而不是抛 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`；如果本阶段不支持网关预热，则断言配置校验拒绝。
   - **反向 D**：admission 对 warm 返回 blocked，断言没有预热请求；若仍发出，测试失败。

3. **预算与用量测试**：
   - admission 记录 `gate.begin` 被调用，且 `source === "agent-stream"`、`estimatedCostMicros === binding.admissionCost.estimatedCostMicros`。
   - warmer 成功后 `usage.store.record` 恰好一次，`purpose === "cache-warm"`、`source === "agent-stream"`、`invocationId` 等于 permit identity、token 数与 `entry.usage` 一致。
   - **反向**：把 `entry_appended` 继续忽略，记录次数为 0，测试失败。
   - **反向**：不调 `permit.settle`，预算测试失败。
   - **反向**：warm 请求失败不产生 entry 时，超时后 `markUnknown` 被调用；不清理则测试失败。

4. **持久化/迁移测试**（扩展 `test/integration/sqlite-model-usage.test.ts`）：
   - `purpose: "cache-warm"` 能写入并读回；无效 purpose 仍被拒绝。
   - 从 0085 数据库升级到 0086，旧行保留，新 CHECK 接受 `cache-warm`。
   - **反向**：不改 0068/0086 的 CHECK，插入 `cache-warm` 报错，测试失败。
   - 运行 `npm run check:audit-schema-range`、迁移契约测试、`schema-contract`。

5. **prompt-prefix 门槛**：
   - `npm run check:prompt-prefix` 必须继续通过。
   - 新增预热测试不能改变真实请求的 `messages`/工具/系统提示；预热请求本身按“相同前缀 + `max_tokens=1`”检查。

## 3.6 空闲预热（两次运行之间）值不值得做

**现在不值得做，建议明确不做，并用 `cacheWarming: "streaming"` 锁住。**

理由：

- Himawari 每次运行新建会话、跑完 `session.dispose()`；Pi 的 `dispose()` 会 `cacheWarmer.cancel()`（`agent-session.ts:1428-1449`）。所以 1.5.1 的 idle 预热在当前生命周期里根本活不过一次运行。
- 要在两次运行之间预热，必须让 Pi 会话/预热器在运行结束后继续活着，或者由 Himawari 自己在后台重放上一次请求。前者会让会话携带旧上下文、旧工具/提示状态；后者等于在 Pi 之外重写预热器，还要解决：
  - 没有活跃运行和执行租约，`ModelInvocationAdmissionService` 的 `assertActive()` 不会通过；
  - 用量表需要 `runId`，不能凭空造一个不属于真实运行的 id；
  - 下次运行的请求开头可能因为提示/工具/记忆变化而和旧请求不同，预热可能白花钱；
  - 需要持久化的预算账户、取消机制、重启恢复。
- DeepSeek 缓存本来就能存数小时到数天，空闲预热对当前主力模型没有收益。

如果以后真的有短 TTL 模型，并且“两次运行间隔 < TTL”的收益足够大，再做也应以**独立方案**做：要么长期保留同一 Pi 会话并复用，要么建立 Himawari 自己的后台预热任务（带独立预算账户、租约、取消和用量记录）。不要为了 idle 预热把当前“一次运行一个会话”的生命周期改掉。

## 3.7 哪些模型该写 `promptCache`

- **当前生产 DeepSeek 系列：不写。** DeepSeek 缓存默认开启、可存数小时到数天；预热没有收益，只会多花钱。
- **只有满足以下全部条件的模型才写：**
  1. 上游明确声明缓存寿命，且我们能从一手文档确认；
  2. TTL 足够短（例如分钟级），短于一次运行内两次请求的间隔，或短于两次运行间隔；
  3. 该模型经过 Himawari 的准入、预算和出口遮盖路径；
  4. 如果不是 Magpie，网关预热还必须支持每次新建 gateway observation。
- 对 Magpie 动态发现的模型，**不要按模型名猜 TTL**。用显式配置或显式映射表逐模型设置；主描述符上的 `promptCache` 不得自动继承给所有动态模型。
- **未核实**：Anthropic/OpenAI 当前具体默认 TTL（材料说约 5 分钟，但本次没有打开两家官方文档确认）；GLM 等其他模型是否有缓存及寿命也未核实。没有核实前一律不写。

## 3.8 对模型已见请求开头的影响

- 正常聊天请求的系统提示、工具、历史、遮盖字节都不变；`promptCache` 只是模型配置，不进入请求体。
- 预热请求是额外请求，不是主对话的一次新回合；它的上下文与上一次真实请求相同，成功后只追加 `usage` 条目，`usage` 条目不进入模型上下文（Pi 文档：刷新用量计入会话总计，但不进入模型上下文）。
- 必须用 3.1D 的 fresh Exchange；否则预热请求的前缀会被重新遮盖，字节和真实请求不同，既违背确定性，也会导致缓存未命中。
- `promptCache` 进入 descriptor 身份哈希的问题见 3.4；它不改变请求开头，但可能让该模型的挂起审批续跑身份失效。

---

# 四、需要人拍板的取舍

1. **D5 审批续跑是否允许保留 `session.agent.continue()`。**
   推荐允许：官方没有“不追加消息的续跑”接口；改成 `sendCustomMessage` 会让模型看到合成消息。若不允许，只能接受合成消息并改历史。

2. **D5 不在运行中时的循环停止提示用 `nextTurn` 还是 `followUp` + `triggerTurn`。**
   推荐 `nextTurn`：不启动新的付费运行，最接近现有 `agent.steer` 排队语义。若 Andy 希望模型立刻看到提示，可以选 `followUp` + `triggerTurn`，但会多一次运行。

3. **D7 是否把 `cache-warm` 作为独立 purpose 并做迁移 0086。**
   推荐做：能单独看见预热成本。若不想动表，可复用 `other`，但失去可观测性。

4. **D7 当前是否给任何模型写 `promptCache`。**
   推荐当前不写（DeepSeek 不需要）；机制保留，等出现短 TTL 模型再按 3.7 逐模型配置。若 Andy 要求“现在必须实际发生预热”，就要接受 DeepSeek 上无收益的预热费用，或引入新的短 TTL 模型。

5. **D7 网关预热是否本期实现。**
   推荐：若本期不实现“每次预热新建 gateway observation”，就不要给网关模型写 `promptCache`，并在配置/测试里锁住。若实现，则按 3.1D/E 做 verified billing。

6. **D7 空闲预热是否本期做。**
   推荐不做，明确写进方案/ADR；如果 Andy 要保留 1.5.1 的 idle 默认，需要先改会话生命周期和预算模型，属于更大改动。

---

# 五、逐条回答必答问题

## 问题 1：会不会改变模型已经见过的请求开头？

### D5

**不会。** 改动只是把插消息从 `agent.steer` 换成官方 `session.sendCustomMessage`，或在运行外改成 `nextTurn`；删除 `#continueForSteeredNotices` 不改变请求内容；审批续跑保持原样。系统提示、工具定义、历史消息、遮盖结果都不改。新增内容都只在末尾追加；会变的值（循环停止提示、后台通知、压缩后环境说明）仍在最后追加的消息里。

### D7

**正常请求不会。** `promptCache` 只是模型配置；预热是额外请求，不改主对话的历史。预热请求必须用 fresh Exchange 重放，才能保证它的前缀和真实请求逐字节相同；复用 Exchange 会改变前面文字的遮盖字节，这是必须避免的反例。用量条目不进入模型上下文。

## 问题 2：会不会让同一段文字在不同请求里变成不同字节？

### D5

**不会引入新的不确定性。** 消息内容仍由现有固定文本和 projection 决定；`sendCustomMessage` 构造的 `customType/content/display/details` 与当前构造相同。不同请求新增的是不同消息，不是同一段历史被改写。

### D7

**正常路径不会，但必须修掉预热重放。** `Exchange.#known` 会累积秘密，复用同一个 Exchange 重放整段上下文时，前面已经出现过的值可能被重新遮掉；这是确定的字节变化。方案要求每次预热新建 `egress.exchange(context)`，同一 key、同一 ruleset、同样的未遮上下文，才会得到和真实请求相同的字节。网关观察器也必须每次新建，避免单次限制。配置字段和列表顺序要固定，`promptCache` 不能依赖 Map/数据库遍历顺序。

## 问题 3：有没有对应的自动检查，反向用例真的会失败？

有。D5 用现有 `pi-runtime-adapter.compat.test.ts` 的压缩环境、工具循环、后台通知、审批续跑测试，并把压缩环境测试从 `agent.steer` 改成 `sendCustomMessage`；反向用例会检查“直接调 agent.steer”或“审批续跑多出合成消息”会失败。D7 用真实 Pi + loopback 服务测预热请求、正文逐字节、预算闸门、用量记录、网关第二次请求、迁移 CHECK；反向用例分别检查“去掉 promptCache 仍预热”“继续忽略 entry_appended”“复用同一 Exchange”“不改 CHECK”“预算 blocked 仍发请求”都会失败。最终门槛是 `npm run check:prompt-prefix`，它要求至少 8 条 `[I-66]` 测试通过。

## 问题 4：改动产生或修改的每个值，每个使用它的地方都能接受吗？

### D5

- `customType`：`himawari.tool-loop.stopped`、`himawari.background.command`、`himawari.runtime-environment` 都沿用现值。使用方：历史捕获、`runtime-environment-block.ts:83-121` 的 `previousRuntimeEnvironment`/`runtimeEnvironmentAfterCompaction`、`TEST` 中的 `saved` 断言。`sendCustomMessage` 接受 `customType/content/display/details`，形状匹配。
- 不新增自定义类型，因此不需要改历史 schema。

### D7

- **`promptCache`**：产生方是配置描述符；使用方是 `providerModelConfig` → Pi 模型 → `getPromptCacheTtlMs`；还要经过 `freezeDescriptor`、`validateDescriptor`、`strict-configuration`、`production-model-composition`、Magpie `descriptorFor`。每一处都要接受可选字段；Magpie 动态模型不能错误继承；`identity` 哈希要明确接受或排除它。
- **`purpose: "cache-warm"`**：产生方是预热用量记录；使用方是 `MODEL_USAGE_PURPOSES`、`SqliteModelUsageOperations.valid`、迁移 0068/0086 的 CHECK、`modelUsagePurpose`、`cache-hit-report` 的分组。`MODEL_USAGE_PURPOSES` 和迁移 CHECK 都要加；`SqliteModelUsageOperations` 用常量校验会自动接受；报告按字符串分组，能接受。`source` 保持 `"agent-stream"`，不用改 `ModelUsageSource` 和 source CHECK。
- **`cacheWarming: "streaming"`**：SettingsManager 1.5.0/1.5.1 都接受；使用方是 Pi `CacheWarmer.getMode()`。1.5.1 默认改变时，显式值能保持行为。
- **`cache_warm` 用量条目的字段**：`entry.provider`、`entry.model`、`entry.usage.input/output/cacheRead/cacheWrite`、`entry.timestamp` 都要满足 `ModelUsageObservation` 的校验：token 非负、`cacheRead <= inputTokens`、`cacheWrite <= inputTokens - cacheRead`、`cacheReported` 与缓存字段一致、`occurredAt` 是规范 ISO。实现时按 3.1E 计算。
- **admission 的 `estimatedCostMicros`/`pricing`/`ordinal`/`logicalSlot`**：必须分别等于已注册描述符的估值、正整数的独立 warm ordinal、与真实请求不同的 slot；否则 `ModelInvocationAdmissionService` 会拒绝。

---

# 六、未核实清单

- Pi 1.5.1 `docs/settings.md` 第 21 行的原文：本次只通过 ADR 0203 和材料转述，**未直接打开 1.5.1 文件核实**。
- Anthropic/OpenAI 的当前默认缓存 TTL 具体数值：材料说约 5 分钟，**未打开两家官方文档核实**。
- GLM 及其他非 DeepSeek/非 Anthropic/非 OpenAI 模型的缓存寿命：**未核实**。
- `appendLoopStopped` 的“不在运行中”分支是否真的不可达：代码路径显示很少触发，**未用运行时验证**。
- 删除 `#continueForSteeredNotices` 后，Pi 在 `agent_end` 边界收到后台通知的实际行为：需要真实 Pi 测试确认；**代码阅读表明 Pi 会处理排队消息，但未运行验证**。
- Magpie 1.5.0 模型列表是否未来会提供缓存寿命字段：当前解析器没有，**未核实上游协议**。
- 现有生产是否有挂起审批会因 `promptCache` 进入 identity 哈希而失效：**未核实数量**。

**总结：** D5 的最小正确改法是“运行中已官方的保持、压缩环境改用 `sendCustomMessage`、运行外改 `nextTurn`、删除重复的 continue 循环、审批续跑作为残余偏离单独批准”。D7 的正确改法是“模型可选 `promptCache` + 显式 `cacheWarming: streaming` + `cache_warming_decision` 预算闸门 + 每次预热 fresh Exchange/fresh gateway observation + `entry_appended` 记 `cache-warm` 用量 + 迁移 0086”；当前 DeepSeek 不应写 `promptCache`，空闲预热本期不做。
