---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0068-deepseek-only-codebuddy-fallback.md"
date: "2026-10-21"
---

# ADR 0061：opencode 的模型清单放进一张可随时改的表，ADR 只记原则

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0059](0059-opencode-model-selection-free-first.md) 把 opencode（本地命令行里的编程代理）允许用的五个模型 ID、尝试顺序、各模型的档位和上下文上限直接写在决定里。用户在 2026-10-21 指出 opencode 的免费模型经常变（上线、限流、下线），每变一次就要改 ADR、`AGENTS.md` 和本地白名单三处，要求把模型使用规则单独抽成一张可随时灵活配置的表。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **模型清单的唯一来源是表 `.agents/opencode-models.toml`。** 每个模型一条，记 ID、额度池（`free` 或 `go`）、新会话的尝试顺序、可用档位（2026-10-21 起改为最低档位 `min_variant`，可用档位实时查询，见 [ADR 0065](0065-live-reasoning-variants.md)）、上下文上限、状态（`active`、`paused`、`withdrawn`）、因上下文换模型时是否跳过、一句事实说明和核实日期。表随仓库提交，改表就是改规则，不需要新 ADR。
2. **白名单从表导出，不手改。** `python3 .agents/opencode-models.py export --all` 从表里 `active` 的模型生成启动脚本 `oc-launch.sh` 认的 `.opencode/allowed-models.txt`（主检出和每个有 `.opencode/` 的工作副本）；`check --all` 核对两者一致；`order` 打印尝试顺序；`show <id>` 打印一个模型的字段。改表后先 `export --all` 再 `check --all`。
3. **ADR 0059 的原则不变，只把具体清单搬到表里。** 仍然：免费模型优先，按表里的顺序换；两个免费模型都 429 时等约 30 秒再各试一次，第二次仍 429 才用 Go 池；模型只在会话开始时定；同一任务失败两次后的 GLM 升级路径；档位按难度选、会话中不换（2026-10-21 补充：可用档位不再记在表里，启动时实时查询；表的 `min_variant` 字段记每个模型允许的最低档位，见 [ADR 0065](0065-live-reasoning-variants.md)）；高峰时段先报东京时间；Go 额度用完只剩免费模型，不开 Extra Usage；Grok 只走用户自己的订阅且暂停中；训练条款按各模型的说明。这些见 [ADR 0059 的决定](0059-opencode-model-selection-free-first.md#decision)，其中第 1 条的五个 ID 和第 2 条的顺序以表为准。
4. **表里只记事实，理由留在 ADR。** 一行说明写“免费限时、可能限流”这类事实；为什么免费优先、为什么要二次确认限流，不写进表。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：清单写在 ADR 和 AGENTS.md 里（ADR 0059 的做法）

- 好处：一处读完所有规则。
- 代价：模型一变就要改三处并走 ADR 取代流程；白名单是手写的，和文档容易不一致。

### 方案 B：只改本地白名单 `.opencode/allowed-models.txt`

- 好处：改动最少。
- 代价：那个文件不进仓库，没有版本记录，也放不下顺序、档位、上下文这些字段。

### 方案 C：仓库里的 TOML 表加导出脚本（采用）

- 好处：一处改、有版本、有注释；白名单由脚本生成，`check` 能发现不一致；启动脚本不用改。
- 代价：多一个脚本和一步导出；忘记导出时白名单会落后于表（`check` 能查出）。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 正面：免费模型变动只改一个文件；`AGENTS.md` 不再写死模型 ID。
- 负面：改表后忘记运行 `export --all` 会让启动脚本仍用旧白名单；目前靠 `check` 和开会话前的习惯，犯第三次再加硬约束（[ADR 0060](0060-hard-constraint-on-third-repeat.md)）。
- 后续：ADR 0059 标为已取代；`AGENTS.md` 改为指向表和脚本。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 表：`.agents/opencode-models.toml`；脚本：`.agents/opencode-models.py`（opencode 按 Claude 的说明编写，Claude 逐行审查）。
- 原则：[ADR 0059](0059-opencode-model-selection-free-first.md)（已取代，原则部分仍适用）。
- 协作分工：[ADR 0058](0058-agent-collaboration-and-review-roles.md)。
