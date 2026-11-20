---
status: active
document_type: adr
decision_status: accepted
supersedes: "docs/adr/0059-opencode-model-selection-free-first.md, docs/adr/0061-opencode-model-table.md"
superseded_by: ""
amended_by: "docs/adr/0175-cheaper-code-review-rounds.md"
date: "2026-10-23"
---

# ADR 0068：代理只用 DeepSeek V4.1，opencode 的免费 DeepSeek 用不了时改用 CodeBuddy 的 DeepSeek

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0061](0061-opencode-model-table.md) 规定 opencode（本地命令行里的编程代理）的模型按表 `.agents/opencode-models.toml` 的顺序换：免费的 DeepSeek、GLM、MiMo 依次试，都被限流后才用 Go 套餐（opencode 的付费共享额度）。2026-10-22 用户补充（G165）：免费模型都用不了时，把任务交给 CodeBuddy（腾讯 WorkBuddy 背后的命令行编程代理，用 `codebuddy-orchestration` skill 调度）。

2026-10-23 用户改了这条规则（G169，原话记在 `.agents/tasks/round2-tool-execution/goal.md`）：更希望用 DeepSeek V4.1，因为它比较强；opencode 的免费 DeepSeek 用不了时，改用 CodeBuddy 的 DeepSeek V4.1。当天核实：本机 CodeBuddy 2.173.0 的 `codebuddy --help` 列出 `deepseek-v4.1-flash`，`codebuddy-orchestration` skill 记录它在 `/model` 菜单里的额度倍率是 `x0.00`，自检和实际运行报告的 `total_cost_usd` 都是 0。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **派给代理的编码、审核和独立方案只用 DeepSeek V4.1 Flash。** 先用 opencode 的 `opencode/deepseek-v4.1-flash-free`，档位不低于表里的 `min_variant`。
2. **opencode 的免费 DeepSeek 用不了时改用 CodeBuddy 的 `deepseek-v4.1-flash`。** “用不了”指：返回 HTTP 429（请求过多被拒），约 30 秒后再试一次仍是 429；或者模型被撤下、服务端不提供它。换过去的任务照 `codebuddy-orchestration` skill 做（独立工作副本、结构化报告、Claude 自己复核验收）。两条 DeepSeek 路线都用不了时，停下告诉用户；不开 Extra Usage，不买额度。
3. **opencode 的 GLM、MiMo 和 Go 套餐模型不再用于新会话。** 在表里把它们的 `status` 改为 `paused`，导出的白名单 `.opencode/allowed-models.txt` 里只剩免费 DeepSeek，启动脚本 `oc-launch.sh` 对其他模型报 `MODEL_NOT_ALLOWED` 拒绝启动。要恢复某个模型，需要用户另行决定，然后改表并导出。
4. **同一任务在 DeepSeek 上失败两次后，不再升级到 GLM。** 改由 Claude 收回自己做，或者把任务拆小重写简报后再派一次；拿不准时问用户。
5. **[ADR 0061](0061-opencode-model-table.md) 其余部分不变。** 表仍是模型清单的唯一来源；白名单仍由 `python3 .agents/opencode-models.py export --all` 生成，`check --all` 核对；档位在会话开始时按难度选、会话中不换；开新会话前报一行模型 ID、档位、东京时间和原因；生产步骤从不委派。见 [ADR 0061 的决定](0061-opencode-model-table.md#decision)第 1、2、4 条。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：保持 ADR 0061 的顺序，免费模型全不可用才交 CodeBuddy（G165 的做法）

- 好处：opencode 一侧的工具（实时旁听、纠偏、停止文件检查）用得更久。
- 代价：DeepSeek 被限流时会落到 GLM、MiMo 这些用户认为较弱的模型上。

### 方案 B：只用 DeepSeek，opencode 的免费 DeepSeek 用不了就换 CodeBuddy 的 DeepSeek（采用，G169）

- 好处：始终用用户认为最强的模型；两条路线都是免费的。
- 代价：CodeBuddy 没有 opencode 那套实时旁听和纠偏工具，Claude 只能按它的结构化报告和差异复核；代码会发到腾讯的模型服务（用户已同意交给 CodeBuddy）。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 正面：模型强弱不再随限流变化；规则由白名单硬拦截，不靠记忆。
- 负面：CodeBuddy 的 `deepseek-v4.1-flash` 免费期据一篇社区帖子到 2026-11-01，未经官方确认；到期或开始计费时要回来找用户决定。
- 后续：ADR 0061 标为已取代；`.agents/instructions/delegated-coding-agents.md` 和 [代理工具 Runbook](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/runbooks/agent-tooling-runbook.md) 改为指向本 ADR。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 被取代：[ADR 0061](0061-opencode-model-table.md)（表和导出脚本部分仍适用）和它之前取代的 [ADR 0059](0059-opencode-model-selection-free-first.md)。文档校验不接受连续取代链（被取代的 ADR 只能指向有效的 ADR），所以 0059 直接改指本 ADR，0061 的 `supersedes` 字段清空；0061 取代 0059 的经过见 0061 的背景一节。
- 表：`.agents/opencode-models.toml`；脚本：`.agents/opencode-models.py`。
- 协作分工：[ADR 0062](0062-claude-writes-complex-code-opencode-routine.md)。
