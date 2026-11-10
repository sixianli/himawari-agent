## 结论（先给判断）

推荐**混合方案**，不要“完全保留 streamFunction”，也不要“完全改成官方钩子”：

- **请求开头**改用 Pi 官方 `context_with_system`：它明确“owns the prompt and tool declarations for the request”，正好承担“冻结系统提示 + 冻结工具 + 丢掉 Pi 自己加的 system 消息”。
- **准入、预算、出口遮盖、回复还原、审批回放、暂停/未知/循环保护、压缩摘要识别**不能放在官方扩展钩子里，因为钩子抛错会被 Pi 吞掉、请求照发；把这些职责移到**每个会话注入的 `ModelRuntime` 包装层**，而不是继续替换 `session.agent.streamFunction`。
- **删除 `himawari-system-prompt` 的 `before_agent_start`**。它会在 `context_with_system` 之后再次投影系统提示，把钩子刚写好的开头覆盖掉；而且审批续跑不触发它。
- **保留 `himawari-provider-observer`**。
- 压缩仍走 Pi 自带摘要；识别和摘要上下文处理留在模型调用层，因为 Pi 的 `compact()` 直接调 `agent.streamFunction`，**不经过** `context_with_system`。

这不是“零偏离”，但把偏离缩小到一个 SDK 明确可注入的边界（`modelRuntime`），并且每个职责都有失败关闭点。

---

## 一、方案依赖的前提

1. **Pi 的请求钩子顺序是 `context` → `context_with_system` → provider 钩子，后者能看到最终请求。**
   来源：[pi-coding-agent@1.5.1 docs/extensions.md](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.1/docs/extensions.md)
   原话：“1. `context` (can modify conversation messages) 2. `context_with_system` (can modify the full transcript) 3. `before_provider_headers` … 4. `before_provider_request` …”

2. **`context_with_system` 的返回值就是实际发给服务方的消息，且第 0 条必须是 system。**
   来源同上。
   原话：“The returned messages are sent as they are: this hook owns the prompt and tool declarations for the request.”；规则：“keep a system message at index 0 … Pi reports an error if a handler drops it.”

3. **`before_agent_start` 返回的 `systemPrompt` 会在 `context_with_system` 之后再次投影，能覆盖刚构造好的开头。**
   来源同上。
   原话：“a `systemPrompt` forced from `before_agent_start` is still projected onto the request afterwards.”

4. **扩展钩子抛错不会阻止请求；Pi 记录错误后用未改内容继续。**
   来源：[pi-coding-agent@1.5.0 dist/core/extensions/runner.js](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.0/dist/core/extensions/runner.js)
   `emitContext` 的 `context_with_system` 分支：
   `catch (err) { … this.emitError({…}); }`，随后 `currentMessages = handlerResult?.messages ?? currentMessages;`，最后 `return currentMessages;`。
   `emitBeforeProviderRequest` 同样 catch 后 `return currentPayload;`。

5. **Pi 的压缩摘要直接调用 `agent.streamFunction`，不经过 agent loop 的 `transformContext`。**
   来源：[pi-coding-agent@1.5.0 dist/core/agent-session.js](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.0/dist/core/agent-session.js)
   原话/代码：`return compact(…, this.agent.streamFunction, …);`
   来源：[dist/core/compaction/compaction.js](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.0/dist/core/compaction/compaction.js)
   `buildSummarizationContext`：`normalizeContext({ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [...] })`。

6. **默认 `streamFn` 会先启动缓存预热，再调 `modelRuntime.streamSimple`；而 `CacheWarmer` 对 `streamSimple` 的返回值直接 `.result()`，没有先 `await`。**
   来源：[pi-coding-agent@1.5.0 dist/core/sdk.js](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.0/dist/core/sdk.js)
   代码：`if (options?.sessionId === sessionManager.getSessionId()) { cacheWarmer.start(...) } return modelRuntime.streamSimple(model, context, requestOptions);`
   来源：[dist/core/cache-warmer.js](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.0/dist/core/cache-warmer.js)
   代码：`const message = await this.models.streamSimple(run.model, run.context, {...}).result();`
   **所以模型调用层包装后的 `streamSimple` 必须同步返回 `AssistantMessageEventStream`，不能返回 Promise。**

7. **`ModelRuntime` 是 Pi SDK 明确允许宿主替换的边界。**
   来源：[pi-coding-agent@1.5.1 docs/sdk.md](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.1/docs/sdk.md)
   原话：“Each boundary can be supplied explicitly: `modelRuntime`, `model`, `thinkingLevel`, and `scopedModels` control model access and selection.”

8. **官方 `registerProvider` 能做服务方委托，但它是进程级注册，拿不到“本次 Run 的 owner/runId/secret/permit”。**
   来源：[pi-coding-agent@1.5.1 docs/custom-provider.md](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.1/docs/custom-provider.md)
   原话：“Prefer a complete provider for new integrations…”；“Registering only `baseUrl` or `headers` for an existing provider preserves its built-in models.”
   Himawari 自己的实现里，`ModelRuntime` 是进程内共享的，见 `packages/runtime-pi/src/configured-model-binding.ts:367-394`。
   因此 provider 的 `streamSimple` 只能看到 `model/context/options`，不能可靠区分并发 Run；压缩请求的 `options.sessionId` 还是 `undefined`（`agent-session.js` 的 `compact(..., undefined)`），更无法按 Run 查准入。

9. **官方没有“不调模型、直接合成一条 assistant 回答”的钩子。**
   来源：[pi-coding-agent@1.5.1 docs/extensions.md](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.1/docs/extensions.md)
   `turn_end` 的允许草案类型原话：“Allowed draft entry types are `custom`, `custom_message`, `context_edit`, and `compaction`.”
   因此审批续跑的 `takeReplay()` 必须留在模型调用边界。

10. **请求开头必须逐字节只追加；系统提示和工具按对话冻结；每轮变化的值只能在最后一条消息。**
    来源：`.claude/rules/prompt-prefix.md:27-29`、`:35`、`:41-44`、`:51-54`。
    原话示例：“每轮都会变的内容只放在最后一条用户消息里”；“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”；“系统提示和工具按对话冻结”；“同样的内容，每次都要序列化成同样的字节”。

11. **当前模型配置没有 `promptCache`，所以实际上从不预热。**
    来源：`packages/runtime-pi/src/configured-model-binding.ts:258-284`，`providerModelConfig` 没有 `promptCache` 字段；`SettingsManager.inMemory` 也没有 `cacheWarming`（`pi-runtime-adapter.ts:1405-1412`）。
    **这与材料里“替换 streamFunction 会绕过缓存预热”不完全一致**：当前包装器仍调用 `originalStreamFunction`，而原函数内含 `cacheWarmer.start`；读 1.5.0 源码和当前代码看，替换本身没有绕过预热，真正原因是模型没填 `promptCache`。这一点标为“读代码证实”，不是推测。

12. **新增的错误码/字段必须两头核对，不能只看改动本身。**
    来源：`docs/incidents-and-gates.md:112`（I-73）。
    原话要点：“#207 的测试只测清单解析和展示，没有把清单里的引用交给发送消息的校验；双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」。”

---

## 二、方案本身：每项职责放在哪里

### 1. 聊天请求开头：官方 `context_with_system`

在 `resourceLoader` 的 `extensionFactories` 里新增一个隐藏扩展，例如 `himawari-request-head`：

```ts
pi.on("context_with_system", () => {
  const head = createInitialSystemMessage(
    `${systemPrompt}\n\n${EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE}`,
    requestTools ?? getCurrentTools(event.messages).map(providerTool),
  );
  return { messages: [head, ...event.messages.filter((m) => m.role !== "system")] };
});
```

要点：

- `createInitialSystemMessage` 就是 `normalizeContext` 内部用的同一个函数。
  来源：[pi-ai@1.5.0 dist/utils/transcript.js](https://unpkg.com/@earendil-works/pi-ai@1.5.0/dist/utils/transcript.js)。
  它生成 `{ role: "system", content, toolsAdded, timestamp: 0 }`，正好复现当前 `normalizeContext(withPlaceholderLegend(context))` 的字节。
- 不能用 `Date.now()`；system 头的时间戳固定为 `0`。
- 工具顺序直接使用冻结的 `requestTools` 数组，不排序、不经过 `Set`、不重新 JSON.stringify。
- 只删 system，不改、不重排、不删除任何 user/assistant/toolResult/custom 消息。

### 2. 删除 `himawari-system-prompt` 的 `before_agent_start`

原因：

- 它在 `context_with_system` 之后被 Pi 再投影一次，会把刚构造好的头替换成 `systemPrompt`，**丢掉遮盖图例**；如果 `current.toolsAdded` 也来自错误来源，还会改工具。
- `before_agent_start` 在审批续跑 `agent.continue()` 时不触发，本来就需要另一个点兜底；现在 `context_with_system` 每个请求都触发，不再需要它。
- `systemPromptOverride` 保留，用于让 Pi 会话内部的规范提示接近 Himawari 的提示，减少 `getContextUsage()` 和压缩阈值估算偏差；但最终请求头由 `context_with_system` 决定。

### 3. 准入、遮盖、回放、暂停/未知/循环保护：`ModelRuntime` 包装层

把 `sessionModelRuntime(binding)` 从“只为 `hasConfiguredAuth` 做 Proxy”升级为“同时包装 `streamSimple`”：

```ts
function sessionModelRuntime(binding, state): ModelRuntime {
  return new Proxy(binding.modelRuntime, {
    get(target, property) {
      if (property === "hasConfiguredAuth") { ... }
      if (property === "streamSimple") {
        return (model, context, options) =>
          governedStreamSimple(target, model, context, options, state);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
```

`governedStreamSimple` 的职责与现在 `admitPiStream` 相同，但入口从 `agent.streamFunction` 移到 `streamSimple`：

1. **同步返回输出流**：先 `const output = createAssistantMessageEventStream()`，再 `void (async () => { ... })()` 做准入和网络调用，把事件 push 进 `output`。这是为了满足 `CacheWarmer` 的 `.streamSimple(...).result()`（前提 6）。
2. `await historyWrites`，保持“历史没写完不发请求”。
3. `restored.takeReplay()`：直接回放已存回答，不调模型、不拿 permit。
4. **聊天请求校验**：
   - `getCurrentSystemMessage(context.messages)` 必须等于 `{ content: systemPrompt + "\n\n" + legend, toolsAdded: requestTools }`；
   - `getCurrentTools(context.messages)` 的工具名/声明必须等于允许集合；
   - `session.agent.state.tools` 的可执行工具名也必须等于允许集合。
   任一不满足，返回错误流 `PI_REQUEST_HEAD_DIVERGED`（或继续沿用 `PI_REQUEST_TOOLS_DIVERGED`），**绝不调用 `target.streamSimple`**。这是对 `context_with_system` 抛错/未注册/被覆盖的失败关闭点。
5. **压缩请求**：`compacting` 为真时，校验摘要上下文没有工具，把遮盖图例追加到 leading system 消息末尾；然后同样走准入、遮盖、用量记录。
6. `suspended`、`unknownTool`、`toolProgress.blocked`：返回失败流，不调模型。
7. 预算：`admission.begin`、`markStarted`、`settle`、失败 `markUnknown`，逻辑原样保留。
8. 出口遮盖：每次调用创建 `egress.exchange`，用 `exchange.wrapFetch` 包 `options.fetch ?? globalThis.fetch`；回复用 `restoreModelStream` 还原。
9. 网关：`observeGatewayFetch`、`gatewayPayload`、`onPayload` 包装原样。
10. 密钥：每次调用 `binding.resolveSecret()`，以 `apiKey` 传给底层；`maxRetries: 0`；删除环境里的 `apiKey` 后再传入自己的密钥。
11. 底层调用是 `target.streamSimple(model, context, options)`，**不是复制一份服务方实现**，所以 Pi 的消息转换、工具处理、用量计算、取消语义都保留。

### 4. 压缩请求识别

保留 `session.subscribe` 的 `compaction_start` / `compaction_end` 设 `compacting`，或者改用官方 `session_before_compact` / `session_compact` / `session_compact_failed`。两种都能工作；推荐保持现有 `compaction_start/end`，因为它是公开事件，改动面最小。关键点是：**不再由 `streamFunction` 识别，识别结果只给 `streamSimple` 包装层用**。

### 5. 观察钩子

`himawari-provider-observer` 的 `before_provider_request` / `after_provider_response` 原样保留。默认 `streamFn` 仍然会调 `modelRuntime.streamSimple`，所以 `onPayload`、`onResponse`、`onProviderStreamEvent` 链路不变。

---

## 三、考虑过但不选的做法

1. **完全保留 `session.agent.streamFunction = ...`。**
   不选：Andy 的要求是官方有写法就用；请求头已经能用 `context_with_system`，继续包整个函数会让升级 Pi 时一直对齐私有属性，而且 `before_agent_start` 和它重复。

2. **完全官方：`context_with_system` + `registerProvider` 包装服务方 + `session_before_compact` 自出摘要。**
   不选，原因是一手来源和代码都卡住：
   - provider 是进程级注册，`streamSimple` 没有 Run 上下文；压缩请求甚至没有 `sessionId`（前提 8）。
   - `before_provider_request`、`context_with_system` 抛错不阻止请求（前提 4），无法满足“没 permit 不得发”。
   - 官方没有回放已存 assistant 回答的钩子（前提 9）。
   - 自出摘要要自己复现 Pi 的摘要提示、`<conversation>` 序列化、usage 和文件操作，代价大，且属于 prompt-prefix 规则第 13 条的另一项设计。

3. **保留 `before_agent_start` 作为兜底，同时加 `context_with_system`。**
   不选：Pi 的强制提示投影在 `context_with_system` 之后运行，会覆盖开头（前提 3）。若把它的返回值改成 `systemPrompt + legend` 也能凑合，但会形成两个真相来源，并且审批续跑仍然只有 `context_with_system` 生效，反而更难推理。

4. **用 `session_before_compact` 完全接管压缩。**
   不选（这次）：虽然它是官方钩子，但会改变压缩请求的提示、用量记录和失败语义；当前压缩已经经过准入和遮盖，且 `[COMPACT-1]` 有测试。把“压缩请求复用对话开头”作为单独 ADR 处理更稳。

5. **每个会话新建独立 `ModelRuntime` 并注册自己的 provider。**
   不选：能拿到 Run 闭包，但每次 Run 创建 runtime、凭据和模型目录，成本与升级面都比包装共享 runtime 大；且后台调用与共享 provider 的模型路由会分叉。

---

## 四、风险和反例

1. **`context_with_system` 是 fail-open 的。**
   如果钩子没注册、抛错、被后续 `before_agent_start` 覆盖，Pi 会继续发 Pi 自己的开头。方案的防线是 `streamSimple` 包装层重新校验完整 system 头和工具声明；**如果这道校验写漏，就会把错误开头发出去**。必须有反向用例：让钩子抛错，断言 `server.bodies.length === 0`。

2. **`streamSimple` 返回 Promise 会打断缓存预热。**
   `CacheWarmer` 不 `await` 返回值，直接 `.result()`（前提 6）。包装层必须同步返回流；admission 在后台驱动输出流。实施时要单独测 `promptCache` 打开后的预热路径，否则会在 D7 打开预热时才暴露。

3. **预热请求可能被当成聊天请求。**
   如果将来设置 `promptCache`，`CacheWarmer` 会通过同一个 `ModelRuntime` 代理调用 `streamSimple`。当前没开预热，所以不会触发；D7 开启前必须给预热调用一个可识别标记，否则会多拿 permit、推进 `streamOrdinal`、写错 `purpose`。

4. **压缩识别失败会变成“压缩失败”，不是“发错请求”。**
   如果 `compacting` 没置上，摘要上下文会被当成聊天请求，校验不通过，包装层返回错误流，一次 HTTP 都不发。这是安全方向，但会导致压缩失败；`[COMPACT-1]` 要能在 Pi 改事件名时失败。

5. **删掉 `before_agent_start` 会改变 Pi 会话内部记录的 system 消息和 `session.systemPrompt`。**
   已 grep 当前 `packages/runtime-pi`，没有代码读取 `session.systemPrompt`；历史捕获和 continuation 校验都过滤 system。但这是“读代码证实”的范围，升级 Pi 后要重查。

6. **Pi 升级可能在 `context_with_system` 之后再插入 system 补丁。**
   当前 `_installAgentForcedPromptProjection` 就会这样做；我们删除 `before_agent_start` 后消失。将来若 Pi 新增类似投影，包装层会检测到开头不一致并拒绝发送，属于“安全但需要升级适配”，测试要锁住。

7. **工具声明只比名字不够。**
   当前代码只比工具名；新方案应同时对 `toolsAdded` 用 `declarationsEqual` 比较声明，避免同名但参数结构变了还发出去。

---

## 五、需要人拍板的取舍

1. **是否接受“把治理放到 `ModelRuntime` 包装层”作为新的、但更小的偏离。**
   这是本方案唯一不能完全官方化的地方；官方钩子没有失败关闭能力，`registerProvider` 没有 Run 上下文。若不接受，只能继续保留 `streamFunction` 替换。

2. **是否删除 `before_agent_start` 的 `himawari-system-prompt`。**
   推荐删。保留它就必须让它返回与 `context_with_system` 完全相同的头（含遮盖图例），否则会覆盖。

3. **新增错误码还是复用 `PI_REQUEST_TOOLS_DIVERGED`。**
   推荐新增 `PI_REQUEST_HEAD_DIVERGED`，语义清楚；但要同步改 `loggableModelFailure`、`modelFailureCode` 测试、文档和 I-73 式的 producer/consumer 核对。

4. **缓存预热什么时候处理。**
   推荐本方案只保证“不破坏预热结构”，D7 另案处理预热识别、预算和用量；不要在打开 `promptCache` 前上线。

5. **压缩是否顺带改成复用对话开头。**
   推荐本次不做。Pi 默认摘要本来就换系统提示，prompt-prefix 规则第 13 条已登记为已知差距，应单独出方案。

---

## 六、读代码/来源证实 vs 推测

**证实：**

- `context_with_system` 拥有请求开头，且第 0 条必须是 system（Pi 文档）。
- `before_agent_start` 的强制提示在 `context_with_system` 之后投影（Pi 文档）。
- 钩子抛错不会阻止请求（runner.js）。
- 压缩摘要直接走 `agent.streamFunction`，不经过 `context`/`context_with_system`（agent-session.js、compaction.js）。
- `CacheWarmer` 对 `streamSimple` 不 `await`（cache-warmer.js）。
- 当前代码确实替换了 `session.agent.streamFunction`（`pi-runtime-adapter.ts:1617-1651`）。
- 当前 `sessionModelRuntime` 已经是 Proxy（`pi-runtime-adapter.ts:639-650`）。
- 当前模型配置没有 `promptCache`（`configured-model-binding.ts:258-284`）。
- 当前包装器调用 `originalStreamFunction`，因此按 1.5.0 源码看**没有**绕过 `cacheWarmer.start`；材料这一条与代码不一致。

**推测/未核实：**

- 新方案在所有服务方序列化器下都与旧实现逐字节相同。理论上 `createInitialSystemMessage` 与 `normalizeContext` 同源，但没有实际跑字节对比。
- 服务方是否序列化 system 消息的 `timestamp` 字段。当前用 `0`，即使序列化也固定；但仍需用回环测试确认。
- 将来 Pi 是否会在 `context_with_system` 后新增其他 system 投影。
- 分支摘要、bug report 等其他 `streamFunction` 调用路径在产品中是否会出现。当前代码未使用，但未逐一排查生产入口。
- `ModelRuntime` Proxy 在所有 Pi 内部调用点都只按属性访问、不做 `instanceof` 检查。当前测试能过，但未审全部 Pi 源码。

---

## 七、逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

**按上述实现，不会改变已发内容的开头；仍然只在末尾追加。**

- **系统提示和工具**：新头由 `createInitialSystemMessage(systemPrompt + "\n\n" + 图例, requestTools)` 生成，和当前 `normalizeContext(withPlaceholderLegend(context))` 是同一个构造函数、同一份冻结文本、同一个工具数组顺序、时间戳同为 `0`。
  依据：`pi-ai@1.5.0 dist/utils/transcript.js` 的 `createInitialSystemMessage` / `normalizeContext`。
- **历史消息**：只执行 `event.messages.filter((m) => m.role !== "system")`，不改写、不重排、不删除任何非 system 消息。和当前 `requested.messages.filter(...)` 等价。
- **遮盖结果**：出口遮盖仍在 `fetch` 层做，输入、规则、历史前缀和规则集不变；回复仍用 `restoreModelStream` 还原。图例文字和追加位置不变。
- **每轮会变的值**：时间、记忆、资料、运行环境仍由 `turnPrompt()` 放在最后一条 user 消息的 `<himawari-context>` 里（`pi-runtime-adapter.ts:610-628`），没有进入系统提示或工具定义。

**但有一个必须验证的迁移点**：旧对话部署后的第一次请求，应当和旧实现发出去的最后一个请求逐字节一致。当前只能从源码判断 `createInitialSystemMessage` 等价；没有实际字节对照，标为“未核实”。需要新增一条“旧包装器 vs 新钩子生成同一请求体”的测试。

**压缩请求**仍使用 Pi 自己的摘要系统提示，不属于对话前缀；本方案不改变它。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会新增不确定性；但实现时必须遵守几条硬要求。**

- `context_with_system` 生成的头不能带 `Date.now()`；`createInitialSystemMessage` 使用 `timestamp: 0`。
- 工具顺序直接使用冻结的 `requestTools` 数组；不能排序、不能用 `Set` 遍历、不能重新 `JSON.stringify` 一个键顺序不稳定的对象。`providerTool` 当前固定字段顺序，见 `pi-runtime-adapter.ts:543-554`。
- 遮盖仍是确定的：出口 `exchange` 只依赖当前消息、前面的历史和固定规则集，不依赖后面未发送的消息（`.claude/rules/prompt-prefix.md:51-54`）。
- 唯一残留的不确定值是 Pi 自己摘要请求里的 `timestamp: Date.now()`（`compaction.js` 的 `buildSummarizationContext`）。这是既有行为，不在对话前缀里，本方案不新增也不改变它。
- 新增的错误码由固定条件触发，不由时间/随机数决定。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有，但要补三类。**

现有：

- `npm run check:prompt-prefix` 跑 `packages/runtime-pi/test/prompt-prefix.compat.test.ts`，逐字节比较相邻请求开头，并且有反向用例：改写历史、系统提示带每轮变化值、不冻结、请求中间出现 system 消息。
  依据：`.claude/rules/prompt-prefix.md:74`。
- `[ADR-0198] sends nothing when the frozen tool names differ…` 已验证工具名不一致时 0 请求（`prompt-prefix.compat.test.ts:826-839`）。
- `[COMPACT-1]` 验证压缩请求没有 tools、系统提示是 Pi 的摘要提示，并经过准入/用量（同文件 `:841-883`）。
- 审批续跑测试验证第一次续跑不调模型（`pi-tool-batch-continuation.compat.test.ts:20`）。

需要新增，且每条都必须“先红后绿”：

1. **头被覆盖/缺失时 0 请求**：注册一个会抛错或返回错误头的 `context_with_system` 变体，断言 `server.bodies.length === 0` 且出现 `PI_REQUEST_HEAD_DIVERGED`。如果包装层校验被删掉，这条会看到请求体，因而失败。
2. **`before_agent_start` 不能再覆盖头**：故意让 `before_agent_start` 返回不同提示，断言 0 请求或运行时失败。若实现仍保留旧的强制投影，就会发出旧提示，测试失败。
3. **错误码消费者**：断言 `PI_REQUEST_HEAD_DIVERGED` 经过 `loggableModelFailure` 原样进入 `model.stream_failed` 日志，而不是被降成 `provider_message_withheld`；不更新 allowlist 时这条失败。

“反向用例是否真的会失败”：现有 `findConversationBreak` 反向用例在断点故意制造时断言 `toMatchObject({where:...})`，检查器漏报就会得到 `null` 并失败，设计上是真的反向；但我这次没有运行测试，**实际红绿结果未核实**。

### 4. 每个新值/修改值，使用它的地方都能接受吗？

逐项核对：

| 产生/修改的值 | 产生处 | 使用处 | 两端核对 |
|---|---|---|---|
| leading `SystemMessage.content`（string） | `context_with_system` | provider 序列化、`getCurrentSystemMessage`、token 估算、`check:prompt-prefix` | `SystemMessage.content` 允许 `string \| TextContent[]`（`pi-ai types.d.ts`），string 合法 |
| `toolsAdded: Tool[]` | `context_with_system`，来自冻结 bundle 的 `requestTools` | `getCurrentTools`、provider 工具声明、包装层校验、Pi 工具执行 | `Tool` 结构与 `providerTool` 输出一致；包装层必须按声明比较，不只比名字 |
| `PI_REQUEST_HEAD_DIVERGED` | `streamSimple` 包装层 | `loggableModelFailure` 白名单、`modelFailureCode` 兜底、`runtime.failed`、`onModelStreamFailed` 日志、测试 | 若不加白名单，日志会变成 `provider_message_withheld`；若不加测试，消费者漏改不会被发现 |
| `compacting` | `compaction_start/end` 或 `session_before_compact/session_compact*` | `streamSimple` 包装层 | 事件名/字段一变，包装层会把摘要当聊天并拒绝；`[COMPACT-1]` 会失败 |
| `requestTools` 名称集合 | bundle / descriptors | `context_with_system` 的 `toolsAdded`、包装层的可执行工具校验、Pi 工具执行 | 两处必须用同一数组；handle 工具出现/消失时两边同步 |
| `streamSimple` 返回类型 | 包装层 | `AgentSession`（会 `await`，接受 Promise）、`compact`（会 `await`）、`CacheWarmer`（**不 await，直接 `.result()`**） | 必须同步返回 `AssistantMessageEventStream`；返回 Promise 会让预热路径崩 |
| `streamOrdinal` / `logicalSlot` | 包装层每次模型调用 | `admission.begin`、logical slot、continuation checkpoint | 预热调用若走同一包装层，必须排除，否则会推进聊天 ordinal |
| `sessionModelRuntime` 的 `hasConfiguredAuth` 行为 | `pi-runtime-adapter.ts:639-650` | `createAgentSession` 恢复模型、auth 判断 | 保持原样；新增 `streamSimple` 不能改变 `hasConfiguredAuth` 语义 |
| 删除的扩展名 `himawari-system-prompt` | 旧 `extensionFactories` | 仅在 `pi-runtime-adapter.ts:1466` 定义，grep 无其他消费者 | 删除不破坏外部引用；文档 D6 要同步更新 |
| `before_agent_start` 删除后的 `session.systemPrompt` | Pi 内部 | 当前 runtime-pi 代码未读取；历史捕获过滤 system | 需在 Pi 升级时重查；I-73 式核对要求把“内部状态消费者”也列出来 |

**I-73 教训的落实**：新增 `PI_REQUEST_HEAD_DIVERGED` 时，不能只改产生错误码的地方，还要同时改：

- `loggableModelFailure` 白名单（否则日志丢失原因）；
- `modelFailureCode` 的分类（目前会落到 `PI_MODEL_ERROR`，可以接受，但要在测试里明确）；
- `pi-runtime-adapter.compat.test.ts` 的错误映射表；
- `prompt-prefix.compat.test.ts` 的“零请求”断言；
- 新 ADR / Pi 开发规范里的偏离表。

---

## 八、建议改哪些文件

- `packages/runtime-pi/src/pi-runtime-adapter.ts`
  - 新增 `context_with_system` 工厂；
  - 删除 `himawari-system-prompt` 工厂；
  - 扩展 `sessionModelRuntime`，包装 `streamSimple`；
  - 把 `admitPiStream` 重构为“同步返回流 + 异步准入驱动”；
  - 新增聊天头校验和 `PI_REQUEST_HEAD_DIVERGED`。
- `packages/runtime-pi/src/egress-context.ts`
  - 增加对 transcript leading system 消息追加图例的纯函数，供摘要路径使用。
- `packages/runtime-pi/test/prompt-prefix.compat.test.ts`
  - 新增旧头等价、钩子抛错零请求、`before_agent_start` 覆盖零请求、错误码路径。
- `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts`
  - 错误码映射、审批续跑、压缩准入/遮盖、删除 `before_agent_start` 后的提示一致性。
- `packages/runtime-pi/test/pi-tool-batch-continuation.compat.test.ts`
  - 确认回放仍不产生 HTTP。
- `docs/pi-development-guide.md`（D1、D6）、`docs/architecture-v0.1.md:454`、`docs/adr/0198-upgrade-pi-to-1-5-0.md:50`
  - 把“替换 streamFunction”改成“context_with_system + ModelRuntime 包装”，并登记新的偏离和不足。
- 新 ADR
  - 记录为什么 `registerProvider`/`before_provider_request` 不能满足失败关闭和按 Run 取证，以及缓存预热的后续约束。
