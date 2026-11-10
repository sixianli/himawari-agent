# 方案材料：Pi 偏离 D5（插消息部分）和 D7（缓存预热）改成官方写法

只给问题、目标、约束和已核对的事实，请各自读代码、查资料出方案。

## 问题一：D5 插消息、接着跑

`packages/runtime-pi/src/pi-runtime-adapter.ts` 绕过 Pi 的会话对象，直接调用底层 Agent：
- 工具循环被判定卡住时插入“工具循环已停止”提示（`appendLoopStopped`）：运行中用 `session.sendCustomMessage(..., { deliverAs: "steer" })`，不在运行中时用 `active.agent.steer({...})`。
- 后台命令完成通知（`subscribeBackground` 回调）：运行中用 `session.sendCustomMessage(..., { deliverAs: "steer" })`，不在运行中返回 false。
- 压缩结束且 `willRetry` 时补发运行环境说明：`session.agent.steer({ role: "custom", ...environment })`。
- 一轮结束后 `#continueForSteeredNotices`：`while (canContinue() && session.agent.hasQueuedMessages()) { await session.agent.continue(); await session.waitForIdle(); }`。
- 审批续跑时 `if (restored) await session.agent.continue();`。
- 工具内部的 `agent.abort()`（`session.abort()` 会等会话空闲，工具里等不到）。

官方写法：`@earendil-works/pi-coding-agent` 的 `docs/extensions.md`（`pi.sendMessage`，deliverAs steer / followUp / nextTurn，triggerTurn）、`docs/sdk.md`（`session.sendCustomMessage`、`session.steer`、`session.followUp`、`session.abort`）。锁定版本 1.5.0 在 `node_modules/@earendil-works/pi-coding-agent`，`dist/core/agent-session.js` 第 1862–1900 行是 `sendCustomMessage` 的实现（运行中 / triggerTurn / 不在运行中三种分支），底层队列在 `node_modules/@earendil-works/pi-agent-core/dist/agent.js`、`agent-loop.js`。最新 1.5.1。

## 问题二：D7 缓存预热

Andy 2026-11-10 定：缓存预热要保留，不能因为 Himawari 统计不到用量就关掉。要求照官方写法接上 Himawari 的预算控制和用量记录。

已核对的事实：
- Pi 只给模型配置里写了 `promptCache`（缓存寿命秒数）的模型预热（`docs/models.md` 第 106 行）；`cacheWarming` 1.5.0 默认 `"streaming"`、1.5.1 默认 `"idle"`（空闲时最多续 30 分钟，`docs/settings.md` 第 21 行）。Himawari 现在没有任何模型写 `promptCache`，所以从不预热。
- 每次预热前 Pi 发 `cache_warming_decision` 事件，扩展可回 `{ action: "warm" }` 或 `{ action: "stop" }`（`docs/extensions.md` 1.5.1 第 912–929 行）。
- 预热时 Pi 用 `this.models.streamSimple(run.model, run.context, { ...run.options, maxTokens: 1, maxRetries: 0 })` 重放上一次请求（1.5.0 `dist/core/cache-warmer.js` 约第 238 行），`run.options` 是 `dist/core/sdk.js` 第 199、269 行存下的那次请求的选项（`...options`）。成功后 `sessionManager.appendUsage("cache_warm", ...)` 并发 `entry_appended` 事件。
- Himawari 替换了 `session.agent.streamFunction`（偏离 D1，另有线程出方案），请求经 `admitPiStream`：准入和预算许可（`permit`）、出口遮盖 `egress.exchange(...).wrapFetch(...)`、Vercel 网关路径的 `observeGatewayFetch`（只允许发一次，再发报 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`，`packages/runtime-pi/src/gateway-observation.ts`）、从主机取密钥、记用量。然后调 Pi 原来的请求函数，所以预热重放会带着这次的 fetch 和密钥，但不经过准入、预算和用量记录。
- Himawari 每次运行（处理一条用户消息）新建 Pi 会话，跑完 `session.dispose()`，会话关了预热就停（`dist/core/agent-session.js` 第 1038–1040 行）。
- 用量表：`packages/application/src/ports/model-usage.ts`（`ModelUsageSource` 只有 `"model-port" | "agent-stream"`，必填 `invocationId`、`purpose`、`source`），持久化 `packages/persistence-sqlite/src/sqlite-model-usage-operations.ts`，迁移 `packages/persistence-sqlite/src/migrations/0068_model_usage_observations.sql` 有 `CHECK`。下一个可用迁移号 0086。`entry_appended` 现在在 `KNOWN_IGNORED_EVENTS` 里被忽略。
- DeepSeek 的缓存自动开启，不用之后“usually within a few hours to a few days”才清掉（https://api-docs.deepseek.com/guides/kv_cache ）。Anthropic、OpenAI 一类缓存默认约 5 分钟。生产经 Magpie 调模型，主力是 DeepSeek，也用 Andy 已付费套餐里的 token。

## 约束

- 发给模型的内容只追加，已经发出的不改（`.claude/rules/prompt-prefix.md`）；`npm run check:prompt-prefix` 必须过。
- 花钱的请求必须过 Himawari 的预算控制（`.claude/rules/owner-standing-rules.md` 的“钱和模型”）。
- 只有 `packages/runtime-pi` 能导入 Pi 包；规范 `docs/pi-development-guide.md`：官方有写法就照官方写。
- 不写代码注释。改表结构要连续迁移号。
- 测试用真实入口，修 bug 先复现；新增行为要有反向用例。

## 要的输出

两个问题各自：推荐做法（具体到文件和接口）、为什么、放弃了什么、风险和要加的测试（含反向用例）、会不会改变模型已经见过的请求开头。D7 另外回答：空闲预热（两次运行之间）值不值得做、怎么做，以及哪些模型该写 `promptCache`。
