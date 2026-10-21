---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-21"
---

# ADR 0059：opencode 模型选择：免费模型优先，确认限流后才用 Go 额度

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

opencode（本地命令行里的编程代理，见 [ADR 0058](0058-agent-collaboration-and-review-roles.md)）每次会话要选一个模型。opencode 的模型分两类：免费提供的限时模型（`opencode/*-free`，不占额度，但可能被限流，上下文约 200K token，token 是模型计费和上下文的计量单位），和 Go 套餐的模型（`opencode-go/*`，所有 Go 模型共用一个 5 小时、每周、每月三层限额的额度池）。其余 `opencode/*` 模型按次付费。此外用户还有自己的 Grok 订阅，2026-10-14 起 Grok 批次经 Claude Code 的 `grok-build` 插件运行（G97），2026-10-15 起因额度将尽暂停使用（G112）。

用户在 2026-10-15 给出了完整的模型选择规则原文（G114），同一天又要求按难度选推理档位（G115）；之后加入免费的 GLM 模型（G120，2026-10-16）、要求“再次确认限流”后才切到 Go 模型（G141，2026-10-17）、把两次确认之间的等待从 2 分钟缩到 30 秒（G143，2026-10-18）。目的只有一个：少花额度。这些规则此前只在 `goal.md` 原话和 `AGENTS.md` 里，本 ADR 把现行规则记成一份。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **只允许五个模型 ID。** `opencode/deepseek-v4.1-flash-free`、`opencode/glm-5.3-flash-free`、`opencode-go/deepseek-v4.1-flash`、`opencode-go/glm-5.3-flash`、`opencode-go/glm-5.3`。其他 `opencode/*` 模型按次付费，禁止；`opencode-go/deepseek-v4-pro` 禁止。Grok 模型只能走用户自己的订阅，经 `grok-build` 插件运行（G97），opencode 转售的 Grok（`opencode-go/grok-*`、`opencode/grok-*`）禁止（G94）；Grok 暂停到用户恢复为止（G112），恢复前先读 `opencode-orchestration` skill 的 `references/grok.md`。
2. **新会话从免费模型开始。** 顺序是 `opencode/deepseek-v4.1-flash-free`，然后 `opencode/glm-5.3-flash-free`，最后 `opencode-go/deepseek-v4.1-flash`。只在免费模型被限流（HTTP 429、`FreeUsageLimitError`）、下线或任务需要超过约 200K token 的上下文时才往后换；因上下文换时跳过免费 GLM。
3. **换到 Go 模型前再确认一次。** 两个免费模型在启动时都返回 429，等约 30 秒再各试一次；只有第二次仍都 429 才换到 `opencode-go/deepseek-v4.1-flash`。之前会话里看到的 429 不算（G141、G143）。
4. **模型只在会话开始时定。** 续跑的会话沿用原模型；只有原模型出错或额度用尽时才在下一个模型上开新会话。同一任务在 DeepSeek V4.1 Flash 上失败两次后，先在 `opencode/glm-5.3-flash-free` 上试一次；它被限流或不可用时用 `opencode-go/glm-5.3-flash`；仍失败，或任务属于复杂设计或架构工作，才用 `opencode-go/glm-5.3`（每次请求约为 GLM 5.3 Flash 的 30 倍），只限这一个任务，完成后回到默认模型。
5. **推理档位按难度选。** `#high` 用于原因不明或可能跨层的缺陷、涉及授权、沙箱、存储、进程间协议的产品代码、间歇性失败、先出方案的批次、已在 `#low` 失败过一次的任务；`#low` 用于简报已写明改法的机械编辑、跑现有验证脚本、文档、清理、小的测试修补。没有 `#medium`。会话中不换档位（G115）。
6. **DeepSeek 高峰时段先报时间。** 开新会话前查东京时间；工作日 10:00–12:59 和 15:00–18:59 是 DeepSeek 高峰，Go 模型费用翻倍，大而不急的工作先问用户要不要等到非高峰。每个新会话报一行：模型 ID、档位、东京时间、原因。
7. **Go 额度用完只剩免费模型；都不行就停下告诉用户。** 不开 Extra Usage（Go 套餐额度用完后按量付费的开关），不买额度。
8. **工具把这条规则变成硬拦截。** 未提交的 `.opencode/allowed-models.txt` 列出五个 ID，启动脚本 `oc-launch.sh` 对不在清单里的模型拒绝启动（`MODEL_NOT_ALLOWED`），按整行比较，所以付费的 `opencode/deepseek-v4.1-flash` 不会被免费的 `…-free` 顺带放行。
9. **训练条款。** 免费的 DeepSeek 模型可能用请求内容训练；用户同意本项目的请求可用于训练（G115），已在 opencode 控制台打开。`opencode/glm-5.3-flash-free` 按 opencode 的说明不保留、不用于训练（G120）。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：固定用 `opencode-go/deepseek-v4.1-flash#high`（G77、G83，2026-10-12 到 10-15）

- 好处：稳定，不用处理限流。
- 代价：每个会话都消耗 Go 共享额度，高峰时段翻倍。

### 方案 B：按速度和质量在 DeepSeek 和 Grok 之间分配（G96，2026-10-14）

- 好处：Grok 批次能并行。
- 代价：Grok 订阅额度很快见底，2026-10-15 暂停。

### 方案 C：免费优先，确认限流后才用 Go，按难度选档位（采用）

- 好处：大部分会话不花额度；限流时自动有退路。
- 代价：启动前多一次探测；免费模型上下文小，大任务要换模型。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 正面：额度消耗由规则而不是临场判断决定；硬拦截保证不会误用付费模型。
- 负面：免费模型被限流时启动要多等约 30 秒；GLM 免费模型的档位效果尚未验证（2026-10-16 的探测没有看出差别）。
- 后续：可用模型、顺序或等待时间再变时写新 ADR 取代本 ADR，并同步 `.opencode/allowed-models.txt`。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 用户原话：`.agents/tasks/round2-tool-execution/goal.md` 的 G77、G83、G94、G96、G112、G114、G115、G120、G141、G143。
- 协作分工：[ADR 0058](0058-agent-collaboration-and-review-roles.md)。
- 启动脚本和白名单检查：`opencode-orchestration` skill 的 `scripts/oc-launch.sh`。
