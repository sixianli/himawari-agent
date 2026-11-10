---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
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
3. 模型窗口已经是动态取得的：`apps/agent-service/src/production-magpie-models.ts` 从 Magpie 的模型清单读 `context_window`，传给 `contextWindow`（`packages/runtime-pi/src/configured-model-binding.ts` 的 `descriptor.contextWindow`）。
4. 本项目把压缩触发点定为 20 万 token 的依据是 Andy 在第三步方案里批准的默认值（2026-11-10，经协调者转达：“默认 ~200K”）。

<a id="decision"></a>

## 决定

1. 照 Pi 官方写法，用 `compaction.modelOverrides`，不自己写触发逻辑（[Pi 二次开发规范](../pi-development-guide.md)）。`packages/runtime-pi/src/compaction-prefix.ts` 的 `compactionModelOverrides(model)` 按当前绑定的模型算出 `reserveTokens = 窗口 - 200000`，键是 `provider/id`，在创建会话的 `SettingsManager` 时传入。
2. 窗口不超过 20 万的模型不设覆盖，沿用 Pi 默认的 16384 预留；窗口读不到或不是正整数时也不设覆盖。窗口来自模型清单，不写死。
3. 20 万是常量 `COMPACTION_TRIGGER_CAP_TOKENS`，改它就是改默认值；要让用户自己调，另出方案。
4. 测试：`prompt-prefix.compat.test.ts` 的 `[COMPACT-4]`（属于 `npm run check:prompt-prefix`），用 Pi 自己的 `SettingsManager` 解析，验证 100 万窗口在 20 万触发、同一窗口的别的模型不受影响、小窗口保持默认；反向用例是小窗口和窗口为 0 时覆盖为空。

<a id="options"></a>

## 放弃的做法

- 自己在 `session_before_compact` 里判断并取消压缩：Pi 官方已有按模型设置，自己写是偏离。
- 对所有模型统一设 20 万：小窗口模型会因此永远触发或预留为负。

<a id="consequences"></a>

## 后果

- 这个改动只影响“什么时候压缩”，不改发给模型的任何已发内容，不违反只追加规则；压缩本身仍是一次性整段失效（规则第 12 条），触发更早意味着压缩更频繁但每次总结的输入更小。
- 压缩质量和总输入费用是否更好还没实测；付费评测等 Andy 同意后再做。
