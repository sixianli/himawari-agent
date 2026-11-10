---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-10"
---

# ADR 0206：Pi 偏离 D5 插消息改照官方，D7 缓存预热先锁住设置

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

[ADR 0204](0204-handle-pi-deviations-d2-d3-d5.md) 把 D5（绕过 Pi 会话直接用底层 Agent）里“往运行中插消息、接着跑”的部分和 D7（缓存预热没接预算和用量）留给方案。方案经两个模型各自出方案、再互审（记录在 `.agents/reviews/topic-pi-d5-d7/`），Andy 2026-11-10 回“要互审，然后同意 按方案动工”。协调者同日定：审批续跑处的 `session.agent.continue()` 保留；生产里没有 5 分钟缓存的模型，D7 这次只锁住设置。

<a id="premises"></a>

## 前提

Pi 的出处都是锁定版本 `@earendil-works/pi-coding-agent@1.5.0` 包里的文件。

1. `session.sendCustomMessage` 在会话运行中把消息交给底层队列：`dist/core/agent-session.js` 第 1875–1880 行，`else if (this.isStreaming && options?.triggerTurn !== false) { … this.agent.steer(appMessage); }`。所以运行中用它和直接调 `agent.steer` 是同一个队列、同一个时机。
2. 会话不在运行中、也没有 `triggerTurn` 时，`sendCustomMessage` 直接把消息写进会话历史：同一文件第 1897–1898 行 `else { this._appendCustomMessage(appMessage); }`。
3. `session.isStreaming` 只在会话自己开的一轮里为真：第 1081–1083 行 `get isStreaming() { return this._isAgentRunActive; }`，`_isAgentRunActive` 只在 `_startRun` 里置真（第 1442 行）。审批续跑用的 `session.agent.continue()` 不经过 `_startRun`，所以续跑的那一轮里 `isStreaming` 为假，但底层 Agent 正在跑。
4. 会话开的一轮会自己跑完排队的消息：`_startRun` 第 1467–1479 行在 `agent.prompt` 之后循环，`_handlePostAgentRun()` 返回 `this.agent.hasQueuedMessages()`（第 1582 行）时 `await this.agent.continue()`；没有 `agent_before_settle` 处理函数时 `_runBeforeSettleBoundary()` 再查一次 `this.agent.hasQueuedMessages()`（第 1586 行）。循环退出后 `_emitAgentSettled()` 一开头就把 `_isAgentRunActive` 置假（第 696–698 行），中间没有可以插进新消息的等待点。
5. Pi 的自动压缩只在会话开的一轮里发生：`_checkCompaction` 只由 `_prepareRun`（第 1503 行）和 `_handlePostAgentRun`（第 1577 行）调用。所以压缩后补发运行环境说明时，会话一定在运行中。
6. `session.abort()` 先标记“本轮要中止”再中止底层 Agent，然后等会话空闲：第 1989–2000 行。
7. 只给写了缓存寿命的模型预热：`docs/models.md` 第 112 行“A model without a lifetime for the active tier is not eligible for cache warming.”；`cacheWarming` 1.5.0 默认 `"streaming"`（`dist/core/settings-defaults.d.ts` 第 59 行），1.5.1 默认改为 `"idle"`（1.5.1 `docs/settings.md` 第 21 行）。
8. 生产主力模型是 DeepSeek，它的缓存“usually within a few hours to a few days”才清掉（https://api-docs.deepseek.com/guides/kv_cache ），不需要预热；生产没有 5 分钟缓存的模型（[ADR 0117](0117-magpie-routes-models-through-owned-subscriptions.md)、[ADR 0111](0111-no-expensive-models-anywhere.md)）。
9. Himawari 交给 Pi 的模型配置由 `packages/runtime-pi/src/configured-model-binding.ts` 的 `providerModelConfig` 逐项列出，没有 `promptCache`。

<a id="decision"></a>

## 决定

1. **压缩后补发运行环境说明改用 `session.sendCustomMessage(environment, { deliverAs: "steer" })`。**依据前提 1、5，时机不变。
2. **会话开的一轮里的“工具循环已停止”提示，失败时改用 `session.abort()`；后台命令通知失败、存历史失败时同样改用 `session.abort()`。**这几处都不在工具里等待，可以等会话空闲（前提 6）。
3. **删掉一轮结束后的补跑循环 `#continueForSteeredNotices`。**依据前提 4，会话开的一轮自己会跑完排队消息；审批续跑那一轮里后台通知因 `isStreaming` 为假被拒收、留给下一轮（现有行为），排队的只可能是“工具循环已停止”提示，而那时本来就不续跑。新增真实 Pi 用例 `[D5-NOTICE]`：后台结果在模型最后一次回答结束时（`agent_end`）才到，下一次请求仍看得到它。
4. **审批续跑保留 `session.agent.continue()`，续跑那一轮里的“工具循环已停止”提示保留 `agent.steer`。**官方会话接口没有“不加新消息、接着跑”的写法，改成 `sendCustomMessage(..., { triggerTurn: true })` 要往对话里多塞一条合成消息，模型会看到它。续跑那一轮里 `isStreaming` 为假（前提 3），用 `sendCustomMessage` 会直接写进会话历史（前提 2），可能插在工具调用和它的结果之间，所以这一处跟着续跑一起保留。工具内部的 `agent.abort()` 按 ADR 0204 保留。
5. **D7 这次只锁住设置。**`SettingsManager.inMemory` 显式写 `cacheWarming: "streaming"`，升到 1.5.1 时不被新默认值 `"idle"` 带走；新增用例 `[D7]` 锁住：Himawari 注册给 Pi 的模型都没有 `promptCache`，即使模型描述里带了这一项也不会传过去，所以不会出现没过预算的预热请求（前提 7、9）。空闲预热在“每次运行新建会话、跑完关掉”下跑不起来，不做。
6. **整套预热等加了短缓存模型再做**：用隐藏扩展接 `cache_warming_decision` 走准入和预算、预热重放每次新建出口遮盖、`cache_warm` 用量记进用量表（新用途 `cache-warm`，迁移重建用量表的 `CHECK`）。做之前先出方案；新增模型时上面的 `[D7]` 用例会提醒这一步。

<a id="industry"></a>

## 业界怎么做

- Pi 官方的插消息写法是扩展里的 `pi.sendMessage(message, { deliverAs })`（`docs/extensions.md` 第 1625–1642 行），会话层对应 `session.sendCustomMessage`；嵌入文档 `docs/sdk.md` 第 66–70 行只讲会话的 `steer()`、`followUp()`、`abort()`，没有会话层的 `continue`。本决定第 1–3 条照这个方向。
- 缓存预热按缓存寿命决定：官方只给写了寿命的模型预热（前提 7）。DeepSeek 一类自动、长时间缓存的服务方不需要预热（前提 8），所以这次不给任何模型写寿命。

<a id="options"></a>

## 放弃的做法

- **“工具循环已停止”在不在运行中时用 `nextTurn` 或 `triggerTurn`。**`nextTurn` 会把它排到用户下一条消息后面；`triggerTurn` 会多发一次请求，而循环卡住时本来就不该接着跑。不在运行中的那一支只出现在审批续跑那一轮，所以和续跑一起保留（决定第 4 条）。
- **审批续跑改成 `sendCustomMessage(..., { triggerTurn: true })`。**模型会多看到一条合成消息，改变发给模型的内容。
- **这次就做整套预热。**生产没有短缓存模型，整套机制一次都不会跑，却要改用量表结构。

<a id="consequences"></a>

## 后果

- D5 剩下的偏离只有三处：审批续跑的 `agent.continue()`、续跑那一轮里的 `agent.steer`、工具内部的 `agent.abort()`，都已写明理由并由 Andy 批准保留。
- D7 不再是“没设”：设置已锁定，模型不预热有用例锁住。加短缓存模型之前必须先做决定第 6 条。
- 这些改动只换了插入消息的接口，插入的位置和时机不变，所以不改变模型已经见过的请求开头；`npm run check:prompt-prefix` 照常通过。

<a id="references"></a>

## 关联文档

- [Pi 二次开发规范](../pi-development-guide.md#current-deviations)
- [ADR 0204：Pi 偏离 D2、D3 保留，D5 读历史改照官方](0204-handle-pi-deviations-d2-d3-d5.md)
- [ADR 0203：在 Pi 上加功能先照官方写法](0203-follow-pi-official-extension-patterns.md)

[↑ 回到阅读导航](#contents)
