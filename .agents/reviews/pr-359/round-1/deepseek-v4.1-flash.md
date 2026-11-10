## 总体判断

正常聊天请求的组装代码没有被这次改动触碰：`himawariRequestContext` / `himawariSummaryContext` / `turnPrompt` 都没改，冻结系统提示和工具的逻辑仍在原处。就“请求只在末尾追加”而言，代码路径看起来保持不变。但我没有找到能证明新接缝本身（代理挂载、deferred 流、预热、signal 传递）都有自动检查的证据；另外发现几处与文档不一致、以及在开启缓存预热后会变成安全问题的时序变化。以下按严重度列出。

---

## 发现

### 1. 中（当前未触发，开启预热后是高危）：预热路径拿不到新的 egress fetch/密钥，或会吃掉审批续跑的一次性回放

- 位置：`packages/runtime-pi/src/pi-runtime-adapter.ts:1073-1096`、`:1583`；`docs/pi-development-guide.md:328`；`docs/adr/0208-...md:80`、`:93`
- 问题：旧实现里，自定义 `streamFunction` 先把出口遮盖 `fetch` 和密钥放进 options，再调用 Pi 默认 `streamFn`；默认 `streamFn` 启动缓存预热时保存的 options 因而带有这些字段。新实现中，Pi 默认 `streamFn` 先“整理请求选项、启动预热”，然后才调用 `modelRuntime.streamSimple`，而 `admitPiStream` 是在代理内部才加遮盖和密钥：

  ```ts
  // pi-runtime-adapter.ts:1083-1084
  const cacheFields = observeCacheFields(exchange.wrapFetch(options?.fetch ?? globalThis.fetch));
  withoutAmbientApiKey.fetch = cacheFields.fetch;
  // :1096
  const secret = binding.resolveSecret ? await binding.resolveSecret() : undefined;
  ```

  这意味着打开 `promptCache` 后：
  - 若预热不经过代理：它使用的是默认 streamFn 保存的 options，**没有 Himawari 的出口遮盖 fetch，也没有 `admitPiStream` 现取的密钥**；可能直接失败，也可能用环境里的默认认证发出未经出口遮盖的请求。
  - 若预热经过代理：它会进入 `govern`，并且在 `:1583` 先执行 `restored?.takeReplay()`。审批续跑的回放是一次性的（`pi-tool-batch-continuation.ts:177-184`），被预热吃掉后，真正的主请求会改发一次真实模型请求，可能让模型重新生成不同的工具调用，破坏“不重新进入已过期的执行”的保证。

  另外，`docs/pi-development-guide.md:328` 仍写“预热沿用那次请求的选项……其中有 Himawari 传入的出口遮盖 `fetch` 和密钥，所以不会绕开遮盖”。按新时序这句话不再成立。`docs/adr/0208...md:80` 说“预热请求会进包装层”，`:93` 说“预热器重放的是 Pi 自己的开头”，两句话也需要澄清。
- 证据：上面的 `1083-1096`；`1583`；`pi-tool-batch-continuation.ts:177-184`；ADR 前提 5（`:42`）“Pi 默认的请求函数先整理请求选项、会话请求前启动缓存预热，再调 `modelRuntime.streamSimple`”。
- 建议：在开启 D7 之前，把出口遮盖和密钥准备放到 Pi 默认 `streamFn` 之前，或为预热单独准备可重复使用的遮盖 `fetch` 和密钥；给 `takeReplay()` 加“仅主对话请求”条件（用请求类型标记，而不是只靠 `compacting`）；同步修正上述文档。

> 说明：预热器到底调用低层 `streamSimple` 还是代理的 `streamSimple`，仓库里没有 Pi 的 `dist`，无法独立核实。两条分支都有风险，因此以“中”记录。

### 2. 中：只重写了 `streamSimple`，其余 `ModelRuntime` 成员原样转发，绕过面仍在

- 位置：`packages/runtime-pi/src/pi-runtime-adapter.ts:840-846`；`packages/runtime-pi/src/pi-model-transport.ts:359`；`docs/pi-development-guide.md:248`
- 问题：代理只拦截 `streamSimple`，其他方法一律 `bind(runtime)` 转发到共享 runtime：

  ```ts
  const value = Reflect.get(runtime, property, runtime);
  return typeof value === "function" ? value.bind(runtime) : value;
  ```

  因此会话内任何走 `runtime.stream(...)` / `runtime.complete(...)` 的辅助调用都会跳过准入、预算和出口遮盖。`pi-model-transport.ts:359` 就是一条真实的直连共享 runtime 的路径（它是独立后台调用，自己有出口遮盖，但不是这条会话包装层的准入）。同时，`bind(runtime)` 还意味着被转发方法内部若调用 `this.streamSimple(...)`，也不会命中代理的重写。
- 证据：`840-846`；`pi-model-transport.ts:359` `const stream = binding.modelRuntime.stream(binding.model, context, {`；指南 `:248` 明确警告“不得直接调 `ctx.modelRegistry.complete`，因为那样会跳过 Himawari 的准入、预算和出口遮盖”。
- 建议：列出 Pi 可能使用的 `ModelRuntime` 入口并逐一决定“治理、拒绝或明确允许”；至少给 `stream` / `complete` 加保护，并加一条测试证明它们不会静默绕过。

### 3. 中低：`deferredPiStream` 把未知异常吞成通用错误，丢失失败原因和 `onModelStreamFailed`

- 位置：`packages/runtime-pi/src/pi-runtime-adapter.ts:812-827`
- 问题：`start()` 或 `govern` 在进入 `admitPiStream` 之前的异常（例如 `await this.#historyWrites.get(...)` 拒绝、上下文处理代码抛错）都会被 `catch {}` 吞掉，只产生一条 `"Model request failed"` 错误事件，不会调用 `onModelStreamFailed`，也不会留下稳定错误码之外的诊断。旧实现中这些异常会作为 Promise 拒绝交给 Pi/上层，至少原因还在。并且外层 IIFE 没有 `.catch`，如果 `catch` 里 `output.push` 再抛，会产生未处理的 Promise 拒绝。作为对照，`egress-context.ts:97-106` 对同类 IIFE 加了 `.catch(() => undefined)`。
- 证据：

  ```ts
  void (async () => {
    try {
      for await (const event of await start()) output.push(event);
    } catch {
      output.push(piErrorEvent(model, "Model request failed"));
    } finally {
      output.end();
    }
  })();
  ```
- 建议：捕获后记录稳定错误码/调用 `onModelStreamFailed`（不要泄露原文），并给 IIFE 补 `.catch`；补一条“`start()` 拒绝时流仍以错误事件结束”的单测。

### 4. 中低：新接缝的专项自动检查不足，测试是“适配”而不是“新增”

- 位置：`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:200-246`、`:892-929`；`packages/runtime-pi/test/model-accounting.unit.test.ts:170-200`；`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2860-2887`；`packages/runtime-pi/test/prompt-prefix.compat.test.ts:408-1052`
- 问题：现有真实 Pi 测试确实覆盖了压缩（`[COMPACT-1]`，`:851-893`）、审批续跑（`:2541`、`:3246`）和黄金请求（`:2860-2887`），这些会穿过新路径。但测试里的假会话改成直接调用 `governed.streamSimple(...)`：

  ```ts
  // compat.test.ts:211-228
  const governed = rawOptions["modelRuntime"] as { streamSimple: ... };
  ...
  const response = governed.streamSimple(streamModel, { messages: [] }, streamOptions);
  ```

  它不再模拟 Pi 默认 `streamFn` 的选项整理、预热和 signal 传递；`892-929` 的“已中止”用例也是把 `{ signal }` 直接塞进 `governed.streamSimple`。因此没有反向用例能证明：`options.signal` 从 Pi 默认 streamFn 传到 `target.streamSimple`、`start()` 拒绝时一定终止、走 `stream`/`complete` 的调用被治理/拒绝、代理函数身份被 Pi 依赖时不坏。现有反向用例只覆盖前缀检查器和黄金请求的敏感性。
- 证据：上面三段测试代码；`check:prompt-prefix` 只跑 `[I-66]`（`scripts/check-prompt-prefix.mjs:8-27`），不覆盖新接缝本身。
- 建议：补最小单测/集成用例：真实 Pi 取消时 signal 到达 provider；`start()` 拒绝的终止性；`runtime.stream`/`complete` 的治理行为；以及“去掉代理后这些用例必须失败”的反向断言。

### 5. 低：文档与代码/彼此不一致

- `docs/adr/0208-...md:54` 的决定第 2 条写“工具一致性检查从只比名字改成比整条声明”，但代码仍只比名字：

  ```ts
  // pi-runtime-adapter.ts:646-648
  const declared = new Set(tools.map(({ name }) => name));
  if (piTools.length !== declared.size || piTools.some(({ name }) => !declared.has(name)))
    return undefined;
  ```

- 同一行还写“设置里显式 `cacheWarming: "off"`”，但代码是 `cacheWarming: "streaming"`（`:1435`），指南和 ADR 0206 也说应锁定 `streaming`。
- `docs/architecture-v0.1.md:454` 仍写“真正的准入在被替换的原 `streamFunction` 外层执行”，本 PR 已经删掉替换的 `streamFunction`。
- `docs/adr/0208...md:80` 与 `:93` 对预热是否进入包装层的描述互相矛盾。
- 建议：本 PR 同时更新这些文档，或明确标成“第 3 步/D7 未完成”。

### 6. 低（推测）：每次 `get` 返回新函数，Pi 若做函数身份比较会受影响

- 位置：`packages/runtime-pi/src/pi-runtime-adapter.ts:840-846`
- 问题：`streamSimple` 每次访问都生成新的箭头函数；其他方法每次访问都 `bind` 出新函数。作者自己在 ADR 记录 `:90` 提到 Pi 的 `_getSummarizationRequestAuth` 做身份比较。若 Pi 比较函数相等、把函数当 `WeakMap` 键或缓存引用，行为可能与旧实现不同。
- 证据：`842-846`；ADR `:90`。
- 建议：把 `streamSimple` 的实现固定为代理创建时的一个函数；必要时缓存 `bind` 结果；若无法确认，至少用真实 Pi 的摘要/压缩测试锁住凭据路径。Pi 的 `dist` 不在仓库，**未核实**。

### 7. 低（推测）：扩展的 `ctx.modelRegistry.streamSimple` 可能传入 `Context`，被工具一致性检查拒绝

- 位置：`packages/runtime-pi/src/pi-runtime-adapter.ts:639-654`；`docs/pi-development-guide.md:246`
- 问题：扩展 API 文档建议 `ctx.modelRegistry.streamSimple(model, context, options)`，扩展传入的 `context` 是带 `systemPrompt` 的 `Context`，不一定是 `TranscriptContext`。代理现在一律进入 `himawariRequestContext`，它从 `requested.messages` 取当前工具；普通 `Context` 没有工具消息，若冻结工具非空，`piTools.length (0) !== declared.size` 就会返回 undefined，最终 `PI_REQUEST_TOOLS_DIVERGED`。
- 证据：`:644-648`；指南 `:246`。
- 建议：若允许扩展调用模型，在代理里区分 `TranscriptContext` 与 `Context`，或显式拒绝并记录原因，而不是伪装成“工具不一致”。当前仓库没有此类扩展（`noExtensions: true`，只有授权的 `additionalExtensionPaths`），是否真的走到这条路径**未核实**。

---

## 侧重检查

- **错误路径**：`admitPiStream` 的准入失败、预算失败、密钥失败、已中止都返回 `failedPiStream` 错误事件；`relayAdmittedPiStream` 在流无终止事件、结算失败时也会补错误事件并 `end()`。`deferredPiStream` 在正常/失败/中止路径都会在 `finally` 里 `end()`，因此我没有找到会永久悬挂的路径（前提是 `createAssistantMessageEventStream` 的迭代在 `done`/`error` 后自行结束，这一点由现有测试模式间接支持）。风险在“非准入类的未知异常”被统一吞掉（发现 3），以及 `start()` 拒绝分支没有专项测试（发现 4）。
- **不合规范/不可信输入**：`himawariRequestContext` 仍只按工具**名字**比对（发现 5）；`Context` 与 `TranscriptContext` 的入口差异可能把合法扩展调用误判为工具分叉（发现 7）；错误消息被 `loggableModelFailure` 收敛为 `provider_message_withheld` 或稳定状态码，未发现新的秘密泄露路径。
- **安全**：未发现新的密钥打印或错误回显；但缓存预热时序变化意味着未来开启预热时可能失去出口遮盖/密钥，甚至绕过拒发（发现 1），这是本次改动最需要提前处理的点。会话内 `runtime.stream`/`complete` 仍是绕过面（发现 2）。
- **资源耗尽**：`deferredPiStream` 多了一层无背压的缓冲；如果消费者提前停止而底层流不结束，`output` 会继续堆积。旧代码的 `relayAdmittedPiStream` 也有类似性质，但新代码多了一层拷贝。当前没有发现新增的无界数组或 listener 泄漏。
- **不可撤销操作**：`takeReplay()` 是一次性操作，现在被放在更通用的 `streamSimple` 代理里；任何额外调用者（预热、扩展、未来辅助请求）都可能先消耗它（发现 1）。审批续跑本身的工具幂等/恢复逻辑没有改动。
- **规则/文档一致性**：发现 1、5、6 涉及规则、ADR、指南、架构文档与代码的不一致；“只追加”规则（`.claude/rules/prompt-prefix.md` 第 2、4、10、11 条）在正常聊天路径上未见违反。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

正常聊天路径：不会看到改变请求开头的代码。`himawariRequestContext`（`:639-654`）仍用冻结的 `systemPrompt` 和 `requestTools`，只把 Pi 的 system 消息去掉；`himawariSummaryContext`（`:656-665`）保持原样；每轮变化的值仍由 `turnPrompt`（`:610-628`）放在最后一条用户消息里。发给模型的内容仍然只在末尾追加，每轮会变的值仍在最后一条消息里。压缩/摘要请求本来就是 Pi 自己的一份 system 提示（规则第 12/13 条的例外），本次没有改变其组装方式。证据是真实 Pi 的 `d4-golden-requests`（`pi-runtime-adapter.compat.test.ts:2860-2887`）和 `prompt-prefix.compat.test.ts` 的多轮用例，但我**没有实际运行测试**，作者声称的 442 条/27 条通过**未核实**。需要保留的例外是缓存预热：如果开启，预热路径的输入/出口遮盖会发生上面发现 1 的变化。

**2. 会不会让同一段文字在不同请求里变成不同字节？**

没有发现本次改动引入前后文相关的遮盖、时间字段或无序集合。遮盖仍在 `admitPiStream` 里通过同一个 `exchange` 完成，`turnPrompt` 的时间/资料仍固定放在最后一条消息；`piErrorEvent` 的 `Date.now()` 只出现在错误事件，不进请求体。需要注意的是，`streamOrdinal` 的 `++streamOrdinal` 现在在代理的异步 `govern` 里执行（`:1599`）；正常对话是串行请求，顺序不变，但如果未来预热/辅助调用与主请求并发，`streamOrdinal` / `logicalSlot` / 用量归属的顺序可能不再严格等于调用顺序。这只影响标识/账目，不影响提示词字节。另一个未确认点是 Pi 默认 `streamFn` 的选项包装顺序：旧实现是 Himawari 的 `fetch`/`onPayload` 包在里层，新实现变成外层，理论上可能改变请求字节；黄金请求测试覆盖了 magpie 和 vercel-ai-gateway 两个场景，但我没有运行，因此不能对所有模型/推理设置下结论。

**3. 有没有对应的自动检查，反向用例真的会失败？**

有覆盖，但不完整。现有的真实 Pi 测试覆盖了压缩摘要（`[COMPACT-1]`）、审批续跑回放、准入失败、用量结算、黄金请求和 `check:prompt-prefix` 的多轮前缀/反向用例。问题在于本次改动只是把三个测试文件的假会话改成读取代理的 `streamSimple`，没有新增针对新接缝的测试：`start()` 拒绝的终止性、`options.signal` 经过 Pi 默认 streamFn 是否仍到达 provider、走 `runtime.stream`/`complete` 是否被治理、代理函数身份是否被 Pi 依赖，都没有反向用例。现有反向用例只证明前缀检查器本身有效、黄金请求对模型字段敏感；去掉代理或去掉 deferred 的终止逻辑时，不一定有一条用例会准确失败。作者给出的“442 条通过”我无法在本环境复现（仓库没有 `node_modules`），**未核实**。

**4. 改动产生/修改的每个值，使用它的地方都能接受吗？**

逐个核对如下：

- `governedRuntime`（Proxy）→ `createAgentSession({ modelRuntime })`（`:1610-1614`）。Pi 需要的方法都能通过代理委托；但 `instanceof`/函数身份/内部 `this.streamSimple` 这几类依赖，仓库里没有 Pi 源码，**未核实**；作者说 `dist` 里没有 `instanceof`，也只是作者说法。
- `deferredPiStream` 的返回值 → Pi 默认 streamFn / agent 循环 / 预热 `.result()`。返回的是真正的 `AssistantMessageEventStream`，`done`/`error`/`end` 语义与旧 `relayAdmittedPiStream` 一致；现有准入测试通过它读取终止事件。
- 新错误字符串 `"Model request failed"` → `modelFailureCode`（`:425-434`）归为 `PI_MODEL_ERROR`，`loggableModelFailure`（`:436-446`）会转成 `provider_message_withheld`，两端都能接受，且不会原样泄露。
- `streamOrdinal` → `logicalSlot`、usage `ordinal`、tool checkpoint key（`:1549`、`:1599`、`:1040-1053`）。串行对话下仍一致；并发预热/辅助调用下顺序可能变化，属于需要未来 D7 处理的边界。
- `restored.takeReplay()` → 任意进入代理的 `streamSimple` 都会先消费它（`:1583`）。主对话/审批续跑路径与旧实现一致；但新的挂载点扩大了可能调用者，预热/扩展若进入代理会先消耗回放。
- 文档里的清单项/链接：`docs/pi-development-guide.md:348` 的 D1 行指向 `#step-2-record`，锚点存在（`docs/adr/0208...md:82`），链接有效；`d4-golden-requests.json` 的序列化格式没有改。
- 配置键：本次没有新增配置键；但 `cacheWarming` 的文档值（ADR 0208 决定写 `off`）与代码值（`:1435` `"streaming"`）不一致，使用方 `SettingsManager` 接受的是代码里的值，文档需要更新。

---

## 未核实

- 本环境没有 `node_modules` 和 Pi 的 `dist`，无法读取 `@earendil-works/pi-coding-agent@1.5.0` 的 `sdk.js`、`agent-session.js`、`cache-warmer.js`，因此作者关于 `_getSummarizationRequestAuth`、`instanceof`、预热调用入口的说法未独立核对。
- 无法运行 `npm test` / `check:prompt-prefix`；测试通过数来自作者说法。
- 压缩/分支摘要之外的 Pi 辅助调用（扩展、标题、内部 `complete`）是否真的经过代理，取决于 Pi 的装配方式，未核实。
