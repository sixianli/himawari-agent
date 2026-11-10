# 线程的方案：Pi 偏离 D5（插消息部分）和 D7（缓存预热）改成官方写法

问题、约束和已核对的事实同 `.agents/reviews/topic-pi-d5-d7/briefs/plan-1.md`；两个模型各自的方案在 `.agents/reviews/topic-pi-d5-d7/round-1/`。下面是线程整合后的方案，以及 Andy 和协调者已经定下的部分。请找漏掉的场景、判断错的地方、和 Pi 官方写法或业界做法不一致的地方。

## 已定的部分

- 审批续跑处的 `if (restored) await session.agent.continue();` 保留：官方会话接口没有“不加新消息、接着跑”的写法，改成 `sendCustomMessage(..., { triggerTurn: true })` 要往对话里多塞一条合成消息，模型会看到它。理由写进 ADR 0206 和偏离表。
- 工具内部的 `agent.abort()` 保留：工具在运行中，`session.abort()` 会等会话空闲，等不到（ADR 0204）。
- D7 只做最小一步：生产没有 5 分钟缓存的模型（ADR 0117、0111：主力 DeepSeek，缓存存几小时到几天），整套预热（预算闸、遮盖重放、用量迁移 0086）等加了这类模型再做。

## D5：`packages/runtime-pi/src/pi-runtime-adapter.ts` 每一处

1. 工具循环停止提示 `appendLoopStopped` 不在运行中那一支：`active.agent.steer({role:"custom", ...})` 改成 `active.sendCustomMessage(toolLoopStoppedMessage(), { deliverAs: "steer" })`。1.5.0 `dist/core/agent-session.js` 第 1862–1900 行：不在运行中且没有 `triggerTurn` 时直接加进历史、不开新一轮。不用 `nextTurn`（会排到用户下一条消息后面），不用 `triggerTurn`（多花一次钱，循环卡住时不该接着跑）。运行中那一支已经是 `sendCustomMessage(steer)`，失败时 `.catch(() => active.agent.abort())` 保持（它在工具结果回调里，属于运行中）。
2. 后台命令完成通知：已是 `sendCustomMessage(steer)`；失败时 `session.agent.abort()` 改 `session.abort()`。
3. 压缩结束且 `willRetry` 时补发运行环境说明：`session.agent.steer({ role: "custom", ...environment, timestamp })` 改成 `session.sendCustomMessage(environment, { deliverAs: "steer" })`。用真实 Pi 测试锁住“补发后紧接的那次请求的最后一条消息是这条说明”。
4. 一轮结束后的 `#continueForSteeredNotices`（`while (canContinue() && session.agent.hasQueuedMessages()) { await session.agent.continue(); await session.waitForIdle(); }`）：如果真实 Pi 测试证明 Pi 在 `_startRun` 里会把排队消息跑完（`_handlePostAgentRun` 返回 `agent.hasQueuedMessages()` 就 `agent.continue()`），整个删掉；测试不过就保留并写进偏离表。注意它有 `canContinue` 条件（挂起、未知工具、失败、中止、工具循环卡住、取消时不续跑），删掉后这些情况下 Pi 是否仍会续跑要逐一核对。
5. 存历史失败时 `void pending.catch(() => session.agent.abort())` 改 `session.abort()`。

## D7：最小一步

1. `SettingsManager.inMemory` 里显式写 `cacheWarming: "streaming"`：1.5.0 默认就是它，行为不变；升 1.5.1 时不被新默认 `"idle"` 带走。空闲预热在“每次运行新建会话、跑完 dispose”下跑不起来。
2. 加测试：Himawari 交给 Pi 的模型注册表里没有任何模型带 `promptCache`（配置也写不进去），所以不会出现没过预算的预热请求。新增模型时这条测试会提醒先做整套。

## 文档

- ADR 0206：D5 插消息改官方写法、审批续跑保留、D7 最小一步及以后整套的条件；更新 `docs/pi-development-guide.md` 偏离表 D5、D7 行。

## 会不会改变模型已经见过的请求开头

线程判断不会：每处都只是“往对话末尾追加一条消息”，插入时机按 Pi 的同一个队列；`npm run check:prompt-prefix` 必过。请核对这一判断，尤其第 1 条（不在运行中时直接加进历史）和第 4 条（删补跑循环）是否改变下一次请求里消息的位置或有无。
