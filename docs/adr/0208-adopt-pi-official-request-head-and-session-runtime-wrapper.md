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
6. 官方注册服务方是进程级共享的，`streamSimple(model, context, options)` 里没有本次运行的 owner、runId、预算许可、暂停状态：`docs/custom-provider.md`。Himawari 已有每次运行一个的 `sessionModelRuntime` 代理（`pi-runtime-adapter.ts`）。
7. 官方没有“不调模型、直接回放已存回答”的写法（D3，见 [ADR 0204](0204-handle-pi-deviations-d2-d3-d5.md)）。
8. 发给模型的内容只追加、系统提示和工具按对话冻结：[prompt-prefix 规则](../../.claude/rules/prompt-prefix.md)第 4、6 条。

<a id="decision"></a>

## 决定

分三步做，每步单独一个 PR：

1. **D6：删掉 `himawari-system-prompt` 扩展。**资源加载器的 `systemPromptOverride` 已给了同一份提示；对话请求的替换函数不读 Pi 的系统开头，只读 Pi 声明的工具名做一致性检查；压缩请求的替换函数（`himawariSummaryContext`）读的是 Pi 传来的第一条 system 消息，那是 Pi 自带的摘要提示（前提 4），与 `before_agent_start` 无关。第 1 步完成：删除前后用 `prompt-prefix.compat.test.ts` 的 26 个多轮用例（含压缩和审批续跑）各抓一遍真实请求体，83 条请求体逐字节相同（`cmp` 无差异）。这是一次性的手工对比，不是提交到仓库的自动检查；因为对话请求本来就不依赖 Pi 的开头，加回这个扩展也不会改变请求字节，所以没有“加回就失败”的反向用例，只加了锁住“Pi 自己加的工作目录行不会漏进请求”的用例。
2. **D1 主体：不再给 `session.agent.streamFunction` 赋值。**替换函数里的全部职责（压缩识别、拒发条件、审批回放、准入、遮盖、用量、取密钥、网关）搬到每次运行的 `sessionModelRuntime` 代理的 `streamSimple` 上；`streamSimple` 同步返回输出流，准入在后台驱动；Pi 默认请求函数（预热、选项整理）留在外层。设置里显式 `cacheWarming: "off"`，等 D7 定了再开。工具一致性检查从只比名字改成比整条声明。
3. **请求开头改用 `context_with_system` 钩子生成**（`normalizeContext({systemPrompt, tools, messages: []})` 的第一条消息，与现在字节一致）；第 2 步的包装层校验开头等于冻结开头，不等就一次请求都不发。

保留的偏离只剩一处：预算准入、出口遮盖、审批回放和“失败就不发”放在每次运行的 `ModelRuntime` 代理上。原因是官方钩子不能失败即拒发（前提 2），官方注册服务方里拿不到本次运行的状态（前提 6）。

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

- 不改变模型已经见过的请求开头：第 1 步有一次性的逐字节对比证据（上面 26 个用例、83 条请求），第 2、3 步合并前同样要做新旧对比，并跑 `npm run check:prompt-prefix`。
- 第 2 步要先核对：`streamSimple` 同步返回在预热和摘要路径下可用；`model !== binding.model` 的对象身份检查在新接缝下仍成立；摘要的凭据解析路径变化后行为不变；代理不被 Pi 做 `instanceof` 检查。
- D4 已由 [ADR 0205](0205-pi-native-provider-auth.md) 合并并删掉了 `sessionModelRuntime` 那个 Proxy；第 2 步要自己重建每次运行专属的模型代理，重建后用 D4 留下的 `packages/runtime-pi/test/fixtures/d4-golden-requests.json` 再逐字节对比一次请求。
- 打开缓存预热（D7）时，预热请求会进包装层，要有标记区分。

<a id="references"></a>

## 关联文档

- [Pi 二次开发规范](../pi-development-guide.md#current-deviations)、[ADR 0198](0198-upgrade-pi-to-1-5-0.md)、[ADR 0203](0203-follow-pi-official-extension-patterns.md)、[ADR 0204](0204-handle-pi-deviations-d2-d3-d5.md)。
