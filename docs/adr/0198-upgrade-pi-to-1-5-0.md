---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amended_by: "docs/adr/0245-retry-rate-limited-model-requests-at-the-request-layer.md"
date: "2026-11-09"
---

# ADR 0198：Pi 从 0.84.2 升到 1.5.0，历史恢复改走 Pi 官方的 SessionManager

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

Himawari 的模型调用、Agent 循环（模型一步步调用工具的那套流程）和内置工具都来自 Pi（`@earendil-works/pi-ai` 和 `@earendil-works/pi-coding-agent` 两个包，官方仓库 <https://github.com/earendil-works/pi>）。此前固定在 0.84.2，待办 BL-20261002-004 要求升到最新版。Andy 2026-11-09 要求：升到最新版，并且 Pi 已经有的功能就用 Pi 的，不再自己写；Pi 满足不了审批、出口遮盖、只追加的模型请求和数据自持的地方保留自己的。

方案按 [模型复核规则](../../.agents/instructions/model-review.md) 由两个模型各自出方案、再审线程方案，整合后的方案和对照表在线程交给 Andy，Andy 2026-11-09 回复“三条都同意开工”，三条是：老对话的缓存可能断一次；上线时停在审批上的旧工具批次作废；pi-durable 这次不换，另开评估。复核记录在 `.agents/reviews/topic-pi-upgrade/`。

<a id="premises"></a>

## 前提

1. Pi 1.5.0 的模型调用接口只收 `TranscriptContext`，系统提示和工具放在 `role: "system"` 的消息里：`packages/ai/src/types.ts`（v1.5.0）“The prompt and tool declarations are carried by the transcript's system messages. Only `normalizeContext()` produces this type”。
2. 生成它的唯一入口是 `normalizeContext`：`packages/ai/src/utils/transcript.ts`（v1.5.0）“Fold `Context.systemPrompt` and `Context.tools` into a leading system message. This is the only entry point that produces a TranscriptContext”。
3. 恢复外部历史的官方做法：`packages/coding-agent/docs/sdk.md`（v1.5.0）“Restore external history by constructing the session with a manager containing those entries. Assigning `session.agent.state.messages` does not replace persisted context.”；对应接口 `SessionManager.inMemory(cwd, options, entries)`（`packages/coding-agent/src/core/session-manager.ts`，“Create an in-memory session (no file persistence), optionally from entries held outside the filesystem.”）。
4. 1.5.0 里 `systemPrompt` 只能读：`packages/agent/src/agent.ts` 的 `get systemPrompt()`，返回 `getCurrentSystemPrompt(messages)`。
5. Pi 只在两处追加 `context_edit`（把失败的那次回答从模型上下文里拿掉）：自动重试（`agent-session.ts` 里 `_omitRecoveryAttempt(message)`，注释“Keep the failed attempt in raw history while durably omitting it from model projection.”），以及上下文溢出或截断恢复，后者紧接着压缩（同一文件，“Persistently omit the selected final attempt before post-run recovery compaction.”）。Himawari 一直关着 Pi 的自动重试：`packages/runtime-pi/src/pi-runtime-adapter.ts` 设置 `retry: { enabled: false, maxRetries: 0 }`。
6. pi-durable 是实验性的：`packages/durable/README.md`（v1.5.0）“**Experimental.** The API changes without notice between releases.”
7. 同类开源项目 OpenClaw 在 2026.5.22 把 Pi 的 Agent 运行时收回自己维护，并关掉 Pi 内置重试：`CHANGELOG/2026.5.22.md` 第 29 行“internalize the former Pi agent runtime into OpenClaw”、第 255 行“disable the embedded pi-coding-agent runtime auto-retry so OpenClaw's own retry and failover loop does not replay failed tool calls through a nested SDK retry”。
8. 发给模型的内容只能往后追加，系统提示和工具按对话冻结：[.claude/rules/prompt-prefix.md](../../.claude/rules/prompt-prefix.md) 第 4、6 条。

<a id="decision"></a>

## 决定

1. **两个包固定为 1.5.0。**锁文件重新生成；只有 `packages/runtime-pi` 导入 Pi 的规则不变。
2. **请求开头仍由 Himawari 决定，表达方式换成 Pi 的。**自定义的 `streamFunction` 收到 Pi 的 `TranscriptContext` 后，去掉 Pi 自己加的全部 system 消息，用冻结的系统提示、冻结的工具加上本轮执行句柄带来的工具，交给 `normalizeContext` 生成请求（前提 1、2）。出口遮盖的图例照旧追加在系统提示末尾。Pi 当前能执行的工具名必须和我们声明的工具名一致，不一致就不发这次请求（`PI_REQUEST_TOOLS_DIVERGED`（D1 第 3 步起改名 `PI_REQUEST_HEAD_DIVERGED`，见 [ADR 0208](0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md#step-3-record)））。
3. **工具批次恢复改走 SessionManager。**审批挂起时，快照升到 `pi-tool-batch.v3`：存 Pi 会话里挂起那次回答之前的全部会话条目（不是消息列表），加上冻结的系统提示、那次回答和已完成的工具结果。续跑时用 `SessionManager.inMemory(cwd, { id }, entries)` 建会话（前提 3），这份条目是续跑时唯一的历史来源，不再按对话历史重建一遍；冻结的系统提示和当前的不一致就拒绝续跑（`PI_CONTINUATION_SYSTEM_PROMPT_CHANGED`）。不再给 `agent.state.messages`、`agent.state.systemPrompt` 赋值（前提 3、4）。
4. **旧快照不兼容。**v2 快照续跑时报 `PI_CONTINUATION_VERSION_INVALID`；生产的工具结果恢复扫描遇到 v2 快照时跳过它，不让整个扫描出错（Andy 同意的第 2 条）。
5. **存历史时去掉 system 消息。**Pi 1.5.0 的消息列表里带 system 消息，Himawari 的历史不存它们，原有的“历史里不许有 system 角色”的检查保留。
6. **工具参数先过 JSON 检查。**直接执行 Pi 内置工具的两处（沙箱里的执行器、文件改动预演）先检查参数是普通 JSON 值（拒绝 undefined、BigInt、Map、循环引用，深度和节点数有上限），再交给 Pi 的参数校验。
7. **`context_edit` 归入压缩。**Himawari 关着 Pi 的自动重试，所以它只会和压缩一起出现（前提 5），按 prompt-prefix 规则第 12 条的压缩例外处理。`check:prompt-prefix` 加一条用例（这一句已被 [ADR 0245](0245-retry-rate-limited-model-requests-at-the-request-layer.md) 修订：Pi 的自动重试仍关着，但请求层现在会对 429/503 重发同一份请求，用例改为检查重发的字节相同）：模型持续返回 503 时，请求层只重发字节完全相同的请求（最多 2 次），历史里没有 `context_edit`，下一轮请求仍以第一轮请求开头。实施时手动把设置改成打开 Pi 自动重试，这条用例失败；适配器没有可以从外面打开重试的入口，所以这一步没有提交成自动用例。再加一条检查：请求中间出现 system 或 developer 角色的消息，判为破坏（有反向用例）；以及一条用例：冻结的工具名和 Pi 能执行的工具名不一致时，一次请求都不发（`PI_REQUEST_TOOLS_DIVERGED`）。
8. **内置工具文字跟随 Pi 1.5.0。**Himawari 替换掉的那几段原文（ADR 0166）在 1.5.0 里没变；bash 工具 `command` 参数的说明从 “Bash command to execute” 变成 “Shell command to execute”，按 Pi 的新文字。已有对话冻结的工具文字不变。
9. **保留 `legacy-pi-history.ts`。**它仍被运维导入脚本和资格证据使用。

<a id="industry"></a>

## 业界怎么做

- Pi 官方 SDK 文档要求外部历史通过 SessionManager 的条目恢复，给内部状态赋值无效（前提 3）。本决定第 3 条照此做。
- OpenClaw 把 Agent 运行时收回自己维护，并关掉 Pi 内置重试以免重放失败的工具调用（前提 7）。Himawari 走的是另一条路：继续用 Pi 的 Agent 循环，只在请求开头、审批和重试这几处保留自己的做法。

<a id="options"></a>

## 放弃的做法

- **让 Pi 自己组装请求开头**（`before_agent_start` 返回系统提示，由 Pi 的 `forceSystemPrompt` 投影）。Pi 每轮会按自己的规则重算提示的分节，工具变化也由 Pi 记录；开头是否和上一轮逐字节相同不再由 Himawari 控制，违反前提 8。
- **快照只存消息、续跑时逐条 `appendMessage`。**压缩摘要等消息不能用 `appendMessage` 写回（`session-manager.ts`：“Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly”），恢复出来的会话会和挂起时不同。
- **换成 pi-durable 做持久运行和审批。**它是实验性的（前提 6），换了等于重写运行核心；Andy 同意另开评估。
- **把 Pi 版本写进冻结 bundle 的身份，让老对话换新一次。**这要加一种换新原因，需要改表结构；而实测同一份内容在 0.84.2 和 1.5.0 下发出的请求逐字节相同（见[后果](#consequences)），工具参数结构变了时已有的换新条件会处理，所以不需要。

<a id="consequences"></a>

## 后果

- **老对话的缓存不会断。**用同一份系统提示、工具和历史（含思考内容、工具调用和工具结果），分别用 0.84.2 和 1.5.0 的 openai-completions 生成请求体，关思考和 `high` 两种情况下都逐字节相同。Andy 同意的第 1 条（缓存断一次）实际不会发生。
- **上线时停在审批上的工具批次失效。**它们是 v2 快照，续跑会失败，需要主人重新发起。
- **Pi 1.5.0 会自动缩小图片。**解不开的图片会被换成一句“[Image omitted: could not be resized below the inline image size limit.]”，测试改用真实的 1 像素 PNG。
- **CI 的安全扫描例外要重做。**`ci/security-exceptions.json` 里登记的是 0.84.2 安装包里的示例密钥文件，换版本后这些登记对不上；CI 的 security 作业目前不阻断合并，重做需要 Andy 在 GitHub 上批准新的例外。
- **已知缺口不变。**压缩请求仍不沿用原对话开头（prompt-prefix 规则第 13 条），已记为待办 BL-20261109-8w6ct3。

<a id="references"></a>

## 关联文档

- [ADR 0165：按对话冻结请求开头](0165-freeze-the-request-head-per-conversation.md)
- [ADR 0166：提示词措辞第一批](0166-prompt-wording-batch-1-system-and-tools.md)
- [模型请求的 KV 缓存规范](../kv-cache-guide.md)

[↑ 回到阅读导航](#contents)
