---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md"
date: "2026-11-10"
---

# ADR 0210：大窗口模型的压缩触发点封顶在 20 万 token

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

压缩是把较早的历史总结成一段摘要，好让对话继续。Pi（Himawari 用的模型运行库）默认在“用掉的上下文超过窗口减 16384”时触发压缩。DeepSeek V4.1 Flash 的窗口是 100 万 token，这意味着要等到约 98 万才压缩：每一轮都要把近百万 token 当输入，缓存没命中时一轮就是约 0.15 美元，命中也有延迟和注意力衰减的代价。这是 [ADR 0207](0207-compaction-request-reuses-conversation-head.md) 那份方案里的第三步。

<a id="premises"></a>

## 前提

1. Pi 1.5.0 官方支持按模型设压缩预留：`compaction.modelOverrides["provider/modelId"].reserveTokens`，触发条件是 `contextTokens > contextWindow - reserveTokens`，手动压缩、自动压缩、溢出恢复都用解析后的值：`node_modules/@earendil-works/pi-coding-agent/docs/compaction.md` 的 “Per-model overrides” 一节（“For a model with a 1M context window, this override triggers compaction above 600K tokens”）。
2. 触发判断的源码：`chunk-44DLKSKE.js` 里 `shouldCompact`（“contextTokens>contextWindow-settings.reserveTokens”）。
3. 模型窗口目前来自静态配置：生产配置模板 `scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json` 里每个生成模型写 `contextWindow`（DeepSeek 为 1000000），经 `apps/agent-service/src/production-model-composition.ts` 的 `contextWindow: descriptor.contextWindow` 传给 Pi。`apps/agent-service/src/production-magpie-models.ts` 读了 Magpie 清单的 `context_window`，但只在主模型走 Magpie 时才用，且不覆盖主模型的窗口。
4. 本项目把压缩触发点定为 20 万 token 的依据是 Andy 在第三步方案里批准的默认值（2026-11-10，经协调者转达：“默认 ~200K”）。

<a id="decision"></a>

## 决定

1. 照 Pi 官方写法，用 `compaction.modelOverrides`，不自己写触发逻辑（[Pi 二次开发规范](../pi-development-guide.md)）。`packages/runtime-pi/src/compaction-prefix.ts` 的 `compactionModelOverrides(model)` 按当前绑定的模型算出 `reserveTokens = 窗口 - 200000`，键是 `provider/id`，在创建会话的 `SettingsManager` 时传入。
2. Pi 默认触发点（窗口减 16384）已经不高于 20 万的模型不设覆盖，沿用默认，也就是窗口不超过 216384 的模型不动，避免窗口刚过 20 万时反而把触发点推迟；窗口读不到或不是正整数时同样不设覆盖。窗口取自模型绑定里的 `contextWindow`（当前是静态配置，见前提 3），不在这个函数里写死。
3. 20 万是常量 `COMPACTION_TRIGGER_CAP_TOKENS`，改它就是改默认值；要让用户自己调，另出方案。
4. 测试：`prompt-prefix.compat.test.ts` 的 `[COMPACT-4]`（属于 `npm run check:prompt-prefix`），用 Pi 自己的 `SettingsManager` 解析，验证 100 万窗口在 20 万触发、同一窗口的别的模型不受影响、小窗口保持默认；反向用例是小窗口、窗口为 0、以及 200001 到 216384 的边界窗口，覆盖都为空。`runtime-event-contract.unit.test.ts` 的 `[COMPACT-4]` 经适配器创建会话，验证传给 Pi 会话的设置对带斜杠的真实模型编号（`vercel-ai-gateway/deepseek/deepseek-v4.1-flash`）解析出 20 万触发点；撤掉适配器里那一行接线，该用例失败。

<a id="options"></a>

## 放弃的做法

- 自己在 `session_before_compact` 里判断并取消压缩：Pi 官方已有按模型设置，自己写是偏离。
- 对所有模型统一设 20 万：小窗口模型会因此永远触发或预留为负。

<a id="consequences"></a>

## 后果

- 这个改动只影响“什么时候压缩”，正常轮次仍然只在末尾追加。压缩事件提前了：历史替换、整段缓存失效和原始上下文被摘要取代都会更早、更频繁发生；上线后，已经超过 20 万的老对话会在下一轮就触发一次压缩（规则第 4、12 条允许的成批压缩例外）。压缩本身仍是一次性整段失效，但每次总结的输入更小。
- 窗口随模型清单动态更新、以及窗口与服务方实际不一致时告警，目前没有做；Andy 方案里的这一项另开一步。
- 压缩质量和总输入费用是否更好还没实测；付费评测等 Andy 同意后再做。
