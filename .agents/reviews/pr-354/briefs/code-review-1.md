# PR 354 第 1 轮代码复核

改动（相对 main e2561a04）：
- packages/runtime-pi/src/pi-runtime-adapter.ts：三处 `session.agent.state.messages` 改成 `session.messages`（历史捕获、压缩后运行环境说明、文件冲突检查）。
- packages/runtime-pi/src/pi-tool-batch-continuation.ts：`BatchSession` 改成 `Pick<AgentSession, "sessionManager" | "messages" | "getToolDefinition">`；读消息用 `session.messages`；`runsInParallel` 用 `session.getToolDefinition(call.name)` 代替在 `agent.state.tools` 里找。
- 三个测试文件的假会话同步加 `messages`、`getToolDefinition`。
- docs/adr/0204-handle-pi-deviations-d2-d3-d5.md 新增；docs/pi-development-guide.md 偏离表状态更新。

依据（锁定版本在 node_modules/@earendil-works/pi-coding-agent，1.5.0）：dist/core/agent-session.js 第 1248 行 `get messages()` 返回 `this.agent.state.messages`；第 1123 行 `getToolDefinition`；dist/core/tools/tool-definition-wrapper.js 第 11 行 `executionMode: definition.executionMode`。

请重点核对：
1. 行为是否真的不变，尤其 `getToolDefinition` 和原来在活动工具里查找，在 Himawari 的用法下是否等价（未激活但已注册的工具、内置工具、隐藏工具）。
2. ADR 0204 里每条前提和代码、Pi 源码是否一致；D2、D3 引用的测试是否真的覆盖“审批写在 execute 里”和“续跑回放”。
3. 偏离表状态改动是否和 ADR 一致。
