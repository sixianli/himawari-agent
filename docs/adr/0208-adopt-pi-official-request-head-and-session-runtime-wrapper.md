---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-10"
---

# ADR 0208：模型请求改靠近 Pi 官方写法（D1、D6）

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[Pi 二次开发规范](../pi-development-guide.md#current-deviations)登记的偏离 D1：`pi-runtime-adapter.ts` 把 Pi 每次请求模型的函数（`session.agent.streamFunction`）整个替换，里面做了冻结请求开头、预算准入、出口遮盖、审批回放和压缩识别。[ADR 0198](0198-upgrade-pi-to-1-5-0.md#options) 只比较了 `before_agent_start` 一条路。D6 是同一件事的另一半：`himawari-system-prompt` 扩展在 `before_agent_start` 里又设了一次系统提示。方案由两个模型（`opencode-go/deepseek-v4.1-flash`、`opencode-go/glm-5.3-flash`）各自独立出方案，线程整合，Andy 2026-11-10 回“同意”，记录在 `.agents/reviews/topic-pi-official-request/`。

[ADR 0204](0204-handle-pi-deviations-d2-d3-d5.md#options) 曾因“没查清 `before_agent_start` 影响哪些路径”放弃单独改 D6；本 ADR 查清后修订那一条：D6 单独先删（见[决定](#decision)第 1 步）。

<a id="premises"></a>

## 前提

下面引用的文件行号取自 `@earendil-works/pi-coding-agent@1.5.1` 的包内文件；锁定的 1.5.0 包用 `npm pack` 取下来逐项核对过：前提 1–5 引用的 `context_with_system` 文档与 `emitContext`、摘要提示和 `streamFunction` 用法、`cacheWarmer.start` 在 1.5.0 里都存在且写法相同（行号可能差几行）。

1. `context_with_system` 钩子拥有请求开头：`@earendil-works/pi-coding-agent@1.5.1` `docs/extensions.md` 第 831 行“The returned messages are sent as they are: this hook owns the prompt and tool declarations for the request.”（1.5.0 同）。
2. 钩子出错不拦请求：`dist/core/extensions/runner.js` 的 `emitContext`，catch 只调用 `emitError`，继续用未改的消息。
3. `before_agent_start` 强制的系统提示在钩子之后还会再投影一次：`docs/extensions.md` 第 844 行“a `systemPrompt` forced from `before_agent_start` is still projected onto the request afterwards.”
4. 压缩和分支摘要用 `this.agent.streamFunction` 发请求，摘要的系统提示是 Pi 自带的 `SUMMARIZATION_SYSTEM_PROMPT`：`dist/core/agent-session.js`、`dist/core/compaction/compaction.js`。所以压缩的系统提示与 `before_agent_start` 无关。
5. Pi 默认的请求函数先整理请求选项、会话请求前启动缓存预热，再调 `modelRuntime.streamSimple`：`dist/core/sdk.js` 261–272 行。缓存预热也直接用 `streamSimple(...).result()`（`dist/core/cache-warmer.js`），所以对 `streamSimple` 的包装必须同步返回流。
6. 官方注册服务方是进程级共享的，`streamSimple(model, context, options)` 里没有本次运行的 owner、runId、预算许可、暂停状态：`docs/custom-provider.md`。Himawari 本来有每次运行一个的 `sessionModelRuntime` 代理，D4（[ADR 0205](0205-pi-native-provider-auth.md)）合并后它已被删除，现在适配器直接用共享的 `binding.modelRuntime`，所以第 2 步要自己重建每次运行专属的模型代理。
7. 官方没有“不调模型、直接回放已存回答”的写法（D3，见 [ADR 0204](0204-handle-pi-deviations-d2-d3-d5.md)）。
8. 发给模型的内容只追加、系统提示和工具按对话冻结：[prompt-prefix 规则](../../.agents/instructions/prompt-prefix.md)第 4、6 条。

<a id="decision"></a>

## 决定

分三步做，每步单独一个 PR：

1. **D6：删掉 `himawari-system-prompt` 扩展。**资源加载器的 `systemPromptOverride` 已给了同一份提示；对话请求的替换函数不读 Pi 的系统开头，只读 Pi 声明的工具名做一致性检查；压缩请求的替换函数（`himawariSummaryContext`）读的是 Pi 传来的第一条 system 消息，那是 Pi 自带的摘要提示（前提 4），与 `before_agent_start` 无关。第 1 步完成：删除前后用 `prompt-prefix.compat.test.ts` 的 26 个多轮用例（含压缩和审批续跑）各抓一遍真实请求体，83 条请求体逐字节相同（`cmp` 无差异）。合入 D4（ADR 0205）之后又在合并后的代码上重做一次（此时多了 1 个用例）：27 个用例 84 条请求体与 `origin/main`（带扩展）逐字节相同。这两次都是一次性的手工对比，不是提交到仓库的自动检查；因为对话请求本来就不依赖 Pi 的开头，加回这个扩展也不会改变请求字节，所以没有“加回就失败”的反向用例，只加了一个普通防线用例：Pi 自己加的工作目录行不会漏进请求（它不是 D6 的反向用例；D6 没有自动反向保护，这一点已接受：加回扩展不会改变请求字节，保护 D6 之外的整条请求开头的是 `check:prompt-prefix`）。
2. **D1 主体：不再给 `session.agent.streamFunction` 赋值。**替换函数里的全部职责（压缩识别、拒发条件、审批回放、准入、遮盖、用量、取密钥、网关）搬到每次运行新建的模型代理（在共享的 `binding.modelRuntime` 外包一层，只覆盖 `streamSimple`）的 `streamSimple` 上；`streamSimple` 同步返回输出流，准入在后台驱动；Pi 默认请求函数（预热、选项整理）留在外层。设置里 `cacheWarming` 按 [ADR 0206](0206-pi-deviations-d5-insertion-and-d7-cache-warming.md) 锁在 `"streaming"`（没有模型配 `promptCache`，预热不会触发），打开预热等 D7 定了再做。工具一致性检查从只比名字改成比整条声明，放在第 3 步一起做，第 2 步仍只比名字。
3. **请求开头改用 `context_with_system` 钩子生成**（`normalizeContext({systemPrompt, tools, messages: []})` 的第一条消息，与现在字节一致）；第 2 步的包装层校验开头等于冻结开头，不等就一次请求都不发。

保留的偏离只剩一处：预算准入、出口遮盖、审批回放和“失败就不发”放在每次运行新建的 `ModelRuntime` 代理上。原因是官方钩子不能失败即拒发（前提 2），官方注册服务方里拿不到本次运行的状态（前提 6）。

<a id="industry"></a>

## 业界怎么做

Pi 官方对“委托内置实现”的写法是在自己的 `streamSimple` 里调内置 API 实现（`examples/extensions/custom-provider-gitlab-duo`）。本决定的包装层在 `ModelRuntime` 代理上做同样的委托，只是挂载点是每次运行的代理而不是进程级服务方。

<a id="options"></a>

## 放弃的做法

- **全部放进官方注册服务方。**服务方拿不到本次运行的状态，硬做要一个全局的“当前运行”登记簿，比闭包更危险。
- **全部放进扩展钩子。**钩子出错请求照发，做不到失败就不发。
- **保留现状并写 ADR 批准。**今天最内层仍调用 Pi 默认函数，替换外层没有绕开什么，但整包替换在 Pi 升级时最脆。

<a id="consequences"></a>

## 后果

- 不改变模型已经见过的请求开头：第 1 步有一次性的逐字节对比证据（上面两次），第 2、3 步合并前同样要做新旧对比，并跑 `npm run check:prompt-prefix`。
- 第 2 步要先核对：`streamSimple` 同步返回在预热和摘要路径下可用；`model !== binding.model` 的对象身份检查在新接缝下仍成立；摘要的凭据解析路径变化后行为不变；代理不被 Pi 做 `instanceof` 检查。
- D4 已由 [ADR 0205](0205-pi-native-provider-auth.md) 合并并删掉了 `sessionModelRuntime` 那个 Proxy；第 2 步要自己重建每次运行专属的模型代理，重建后用 D4 留下的 `packages/runtime-pi/test/fixtures/d4-golden-requests.json` 再逐字节对比一次请求。
- 打开缓存预热（D7）时，预热请求会进包装层，要有标记区分。

<a id="step-2-record"></a>

## 第 2 步实施记录（2026-11-10）

适配器不再给 `session.agent.streamFunction` 赋值，改为在建会话时传入每次运行专属的 `ModelRuntime` 代理（`governedModelRuntime`），只重写 `streamSimple`：准入、遮盖还原、审批续跑回放、识别压缩请求、拒发，原样搬进代理里；其余成员原样转给共享的 `binding.modelRuntime`。核对结果：

- 同步返回：Pi 的默认请求函数（`sdk.js` 的 `streamFn`）和预热都同步使用 `streamSimple` 的返回值，所以代理用 `deferredPiStream` 先返回一条流，再在里面异步走准入；准入失败时流里只有一个错误事件，不抛异常。
- 对象身份：`model !== binding.model` 的检查仍在 `admitPiStream` 里，测试覆盖。
- 摘要的凭据：Pi 在 `agent-session.js` 里把默认请求函数登记为属于传入的 `ModelRuntime`（就是我们的代理），摘要因此不再预先取凭据，凭据和以前一样由 `admitPiStream` 每次请求现取。
- 代理：Pi 的 `dist` 里没有 `instanceof ModelRuntime`；方法用 `bind` 绑回原对象，私有字段不受影响。
- 字节对比：`d4-golden-requests.json` 的黄金请求测试用真实 Pi 会话，改前改后都通过；`npm run check:prompt-prefix` 27 条通过。
- 遗留（D7 打开前必须处理）：Pi 的缓存预热器拿到的就是传入的代理，预热请求会走准入、遮盖和预算，用途记为 chat，也会先消耗审批续跑的一次性回放。生产目前没有模型配 `promptCache`，预热不会触发。打开前要给预热请求加标记，让回放只对主对话请求生效。第 3 步之后预热重放的开头就是冻结的开头。
- 代理只重写 `streamSimple`；`stream`、`complete` 等其他入口仍转给共享的运行时，会话里没有扩展会调它们（`noExtensions`），后台调用 `pi-model-transport.ts` 自带遮盖，这一点和第 2 步之前相同。

<a id="step-3-record"></a>

## 第 3 步实施记录（2026-11-10）

- 请求开头改由隐藏扩展 `himawari-request-head` 的 `context_with_system` 钩子生成：返回 `[createInitialSystemMessage(冻结系统提示, 冻结工具), ...去掉 system 消息的历史]`。Pi 的 `streamAssistantResponse`（`pi-agent-core/dist/agent-loop.js`）先跑这个钩子再 `normalizeContext`，所以请求函数、预热器拿到的都是冻结开头。工具名和 Pi 能执行的工具名不一致时，钩子不替换开头。
- 代理在每次请求里核对：第 0 条是 system 消息，并且和 `createInitialSystemMessage(冻结系统提示, 冻结工具)` 逐字段深比较相等，其后没有 system 消息；不满足就一次请求都不发，失败消息是 `PI_REQUEST_HEAD_DIVERGED`（原 `PI_REQUEST_TOOLS_DIVERGED`；写进日志和历史的是这条消息，`runtime.failed` 的 `errorCode` 仍是 `PI_MODEL_ERROR`）。现在比的是整条开头，包括工具说明和参数，不只是名字；有冻结包时工具取冻结的，没有冻结包时工具取开头自带的，所以此时只核对系统提示。消息列表为空也不再发空请求，一并拒发。钩子出错、没注册或被改，Pi 会放行（出错只记录），所以拒发由代理这一侧保证。
- 反向用例：`pi-runtime-adapter.compat.test.ts` 里开头提示被改、缺开头、开头之后又出现 system 消息，三种都零请求；`prompt-prefix.compat.test.ts` 的 `[D1]` 用例用旧版工具说明的冻结包，要求请求里是冻结的说明；另有 `[D1] sends nothing when Pi never runs the request-head hook`：用例里把钩子从已加载的扩展里摘掉，冻结包用旧版工具说明，要求零请求；手动把钩子改成什么都不返回，`packages/runtime-pi` 的 pi-compat 有 74 条失败。
- 字节：`d4-golden-requests.json` 黄金请求（真实 Pi 会话）通过，`check:prompt-prefix` 28 条通过。
- 到这里 D1 在“开头”一项已回到官方写法；准入、预算、遮盖还原、审批回放、拒发仍在每次运行的 `ModelRuntime` 代理上，这是官方没有对应写法的部分，沿用本 ADR 的批准。

<a id="references"></a>

## 关联文档

- [Pi 二次开发规范](../pi-development-guide.md#current-deviations)、[ADR 0198](0198-upgrade-pi-to-1-5-0.md)、[ADR 0203](0203-follow-pi-official-extension-patterns.md)、[ADR 0204](0204-handle-pi-deviations-d2-d3-d5.md)。
