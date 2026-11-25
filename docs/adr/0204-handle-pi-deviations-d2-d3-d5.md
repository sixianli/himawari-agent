---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-10"
covers: "AGENTS.md, packages/runtime-pi/src/pi-runtime-adapter.ts, packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts, packages/runtime-pi/test/pi-tool-batch-continuation.compat.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0204：Pi 偏离 D2、D3 保留，D5 读历史改照官方

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

[ADR 0203](0203-follow-pi-official-extension-patterns.md) 把 2026-11-10 核查出的 7 处偏离 Pi 官方写法的地方登记在 [Pi 二次开发规范](../pi-development-guide.md#current-deviations) 的偏离表里，状态都是“待 Andy 定”。核查线程给 Andy 的建议是：“D2、D3 批准保留；D5、D6、D7 改回官方写法；D1、D4 先开方案线程”。Andy 2026-11-10 回“按建议”。

动手读代码后发现两处和建议的前提不同：D6（系统提示设两次）的第二次就在 D1 替换的请求函数里，没法离开 D1 单独改（后来查清压缩路径后推翻，D6 已单独删除，见 [ADR 0208](0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md)）；D5（绕过会话直接用底层 Agent）里，“往运行中插消息、接着跑”的几处决定了后台命令通知、工具循环停止提示、压缩后补发的运行环境说明在什么时候进入发给模型的内容，换写法会改变插入时机，属于大改动，要先出方案。这两点已在核查线程里告诉 Andy。

<a id="premises"></a>

## 前提

1. Andy 的决定：2026-11-10 在项目聊天回“按建议”（协调者转来的原话，消息 cmsg_01EE1hey9cboYNfwFnBv5dgrC4TWZsm9XuDW8zjstfcGon）；建议原文见上一节。
2. 官方的会话接口里，`session.messages` 就是底层 Agent 的消息列表：`@earendil-works/pi-coding-agent@1.5.0` 的 `dist/core/agent-session.js` 第 1248–1250 行 `get messages() { return this.agent.state.messages; }`。
3. 官方的会话接口能列出活动工具、按名字取工具定义：同一文件第 1100–1101 行 `getActiveToolNames() { return this.agent.state.tools.map((t) => t.name); }`，第 1123–1125 行 `getToolDefinition(name) { return this._toolDefinitions.get(name)?.definition; }`（注册表，含没激活的工具）；交给底层 Agent 的工具沿用定义里的执行方式：`dist/core/tools/tool-definition-wrapper.js` 第 11 行 `executionMode: definition.executionMode`。
4. Himawari 建会话时把全部工具名交给 Pi，没有中途关掉某个工具：`packages/runtime-pi/src/pi-runtime-adapter.ts` 里 `createAgentSession` 的 `tools: descriptors.map(({ name }) => name)`，仓库里没有调用 `setActiveToolsByName`。即使这样，代码仍先查工具在不在 `getActiveToolNames()` 里再取定义，和原来只在活动工具里找完全一致。
5. 审批写在工具 `execute` 里、存快照后结束运行（D2），以及审批后在新会话里回放那次回答（D3），已有用真实锁定版本 Pi 跑的测试：`packages/runtime-pi/test/pi-tool-batch-continuation.compat.test.ts` 的 “restores a multi-tool batch in a new session without another first model request” 和 “[NL-1] runs a read-only batch concurrently and restores it without frozen results”。测试里的工具在 `execute` 中调用 `capturePiToolBatch` 再抛出 `PRODUCT_SUSPENDED`，然后用 `piToolBatchSessionManager` 新建会话续跑；这两条锁的是续跑协议。适配器自己的审批路径（`createTool` 里调 `tools.preflight`、等审批时挂起再续跑）由 `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts` 的 “suspends and resumes a generic side-effect tool” 锁住。
6. D2、D3 的理由：[ADR 0023](0023-durable-hitl-execution.md) 要求审批能等几个小时、服务重启后还能接着跑；规范 [`tool_call` 一节](../pi-development-guide.md#pattern-tool-call) 写明官方拦截“只能当场决定或当场等”。

<a id="decision"></a>

## 决定

1. **D2、D3 批准保留。**理由见前提 6；在 Pi 行为变化时会失败的测试见前提 5。升级 Pi 时这两条测试必须先过。
2. **D5 读历史和工具的部分改成官方写法。**`pi-runtime-adapter.ts` 里读 `session.agent.state.messages` 的三处改成 `session.messages`；`pi-tool-batch-continuation.ts` 读消息改成 `session.messages`，判断工具能否并行改成先查 `session.getActiveToolNames()`、再看 `session.getToolDefinition(name)?.executionMode`。依据前提 2、3、4，行为不变。
3. **D5 插消息、接着跑的部分先出方案。**`agent.steer`、`agent.continue()`、`agent.hasQueuedMessages()` 换成 `session.sendCustomMessage` 一类官方写法的方案，和 D7（缓存预热接预算和用量）合成一份，按 [和 OpenCode 协作](../../AGENTS.md#working-with-opencode) 的步骤出方案交 Andy，同意后再改代码。工具内部的 `agent.abort()` 暂时保留：工具在运行中不能等会话空闲，`session.abort()` 会等。
4. **D6 并入 D1 的方案。**当时两者改的是同一处，分开定会互相矛盾；后来查清压缩路径后推翻，D6 已按 [ADR 0208](0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md) 第 1 步单独删除。
5. 偏离表的状态列按上面更新。

<a id="industry"></a>

## 业界怎么做

- Pi 官方嵌入文档要求经会话对象读写历史：`docs/sdk.md` 第 40 行“`SessionManager` is authoritative for finalized model context … Assigning `session.agent.state.messages` does not replace persisted context.”本决定第 2 条照这个方向，读也改走会话。
- 等人工批准要能跨重启，官方 `examples/extensions/permission-gate.ts` 的拦截只在进程里当场等，Pi 自己的 `pi-durable` 仍标为实验性（[ADR 0198](0198-upgrade-pi-to-1-5-0.md#decision)），所以 D2、D3 按 [ADR 0203](0203-follow-pi-official-extension-patterns.md#decision) 第 2 条属于“官方没有好写法”的情况。

<a id="options"></a>

## 放弃的做法

- **D5 一次全部换成 `session.sendCustomMessage`。**`sendCustomMessage` 在不在运行中、带不带 `triggerTurn` 时行为不同（1.5.0 `dist/core/agent-session.js` 第 1862–1900 行），会改变消息插进对话的时机，进而改变发给模型的内容，不能不出方案就改。
- **D6 单独先改。**去掉请求函数里那次替换就是在改 D1；去掉 `before_agent_start` 会改变 Pi 会话里记下的系统提示，它被哪些路径用到（例如压缩）要和 D1 一起查清，本 ADR 没有查。后续：2026-11-10 已查清，D6 单独删除，见 [ADR 0208](0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md#decision)。

<a id="consequences"></a>

## 后果

- D2、D3 不再是“待定”的偏离；新代码可以照它们的写法做审批续跑，但仍要走 ADR 0023 的流程。
- D5 剩下的部分、D7、D1 仍不得照抄；D6 已按 [ADR 0208](0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md) 删除；D4 已由 [ADR 0205](0205-pi-native-provider-auth.md) 关闭，现在可以照它的写法做。
- 读历史改走 `session.messages` 后，测试里的假会话也要有 `messages`（和 `getActiveToolNames`、`getToolDefinition`），已同步改；另加一条用例锁住“注册了但没激活的工具不算可并行”。

<a id="references"></a>

## 关联文档

- [Pi 二次开发规范](../pi-development-guide.md#current-deviations)
- [ADR 0203：在 Pi 上加功能先照官方写法](0203-follow-pi-official-extension-patterns.md)
- [ADR 0023：通用人工审批与持久执行恢复](0023-durable-hitl-execution.md)
- [ADR 0198：Pi 升到 1.5.0](0198-upgrade-pi-to-1-5-0.md)

[↑ 回到阅读导航](#contents)
