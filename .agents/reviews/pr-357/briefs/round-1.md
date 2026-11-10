# 作者说明：PR 357

## 问题和目标

把 Pi 偏离 D5 里“往运行中插消息、中止”改成 Pi 官方会话写法，D7 缓存预热先锁住设置。方案和互审在 `.agents/reviews/topic-pi-d5-d7/`，决定在 `docs/adr/0206-pi-deviations-d5-insertion-and-d7-cache-warming.md`。

## 改了什么

- `packages/runtime-pi/src/pi-runtime-adapter.ts`：压缩后补发运行环境说明改 `session.sendCustomMessage(environment, { deliverAs: "steer" })`；三处不等待的失败回调里 `agent.abort()` 改 `session.abort()`；`SettingsManager.inMemory` 加 `cacheWarming: "streaming"`。
- 保留：审批续跑 `agent.continue()`、续跑那一轮里 `agent.steer`、`#continueForSteeredNotices`、工具内部 `agent.abort()`。理由见 ADR 0206 决定第 3、4 条。
- 测试：`[D5-NOTICE]`、两条 `[D7]`；压缩补发的假会话用例改为断言 `sendCustomMessage`。
- 文档：ADR 0206、`docs/pi-development-guide.md` 偏离表和设置一节。

## 作者的说法（请核对）

1. Pi 1.5.0 会话运行中 `sendCustomMessage(..., { deliverAs: "steer" })` 等同 `agent.steer`（`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` 第 1875–1880 行），压缩只在会话开的一轮里发生（第 1503、1577 行），所以补发时机不变。
2. `session.abort()` 在三处 `.catch`/`void pending.catch` 回调里不被等待，不会自己等自己；它比 `agent.abort()` 多标记 `_agentRunAbortRequested`，让 Pi 不再自动续跑。
3. 模型注册只经 `configured-model-binding.ts` 的 `providerModelConfig`，不带 `promptCache`，所以不预热。
4. 不改变模型已经见过的请求开头。
