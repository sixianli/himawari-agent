---
status: active
document_type: adr
decision_status: accepted
supersedes: "docs/adr/0058-agent-collaboration-and-review-roles.md"
superseded_by: ""
date: "2026-10-21"
---

# ADR 0062：复杂模块由 Claude 写，重复性编码交给 opencode，其余分工不变

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0058](0058-agent-collaboration-and-review-roles.md) 记录了 2026-10-18 的分工（G147）：opencode（本地命令行里的编程代理）写全部代码，Claude 只做统筹、审查和拍板。2026-10-21 用户重新划分（G148，原话记在 `.agents/tasks/round2-tool-execution/goal.md`）：只有重复性高、写法人人皆知的简单编码才交给 opencode；复杂模块的设计、抽象层、协议层这类需要架构功夫的代码，尽量由 Claude 自己写。用户把 opencode 定位为“干脏活、苦活”的角色，能力远不及 Claude 的模型。这恢复了 ADR 0058 比较过的方案 B 的核心，但给出了比 G116 更明确的划分标准。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **按代码的性质分工。** 交给 opencode 的：重复性高、程序员都知道怎么写的代码，例如按已定设计补测试、机械改动、脚本、夹具、跑验证并收集证据。由 Claude 写的：复杂模块的设计与实现、抽象层、协议层、跨进程契约、授权和沙箱等需要深入架构判断的代码。拿不准归哪类时，Claude 决定并在简报或提交说明里写明理由。
2. **互审规则不变。** 两边写的代码只能由对方审查，自审不算（G142）：Claude 写的代码由 opencode 逐行审并跑同样的测试层，opencode 写的由 Claude 逐行审。文档和简报仍走文档校验流程。
3. **其余分工照 ADR 0058。** Claude 仍负责规划、写简报、派活、比较方案、拍板、验证安排、提交、推送、记录；定方案前先问 opencode 的独立方案；用户只在两边定不下来时参与；目标、计划、完成状态用 `long-task-planning` 管理；opencode 遵守项目全部规则；生产步骤不委派。见 [ADR 0058 的决定](0058-agent-collaboration-and-review-roles.md#decision)第 3–8 条。
4. **模型选择照 [ADR 0061](0061-opencode-model-table.md)。**

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：opencode 写全部代码（ADR 0058，G147）

- 好处：Claude 的额度全部用在审查和决策上。
- 代价：复杂模块交给较弱的模型，返工和审查成本高；用户在 G148 认为它只适合脏活苦活。

### 方案 B：按代码性质分工，复杂的 Claude 写，重复的 opencode 写（采用）

- 好处：架构关键的代码由更强的模型写；重复性工作仍省 Claude 的额度；互审让两种代码都经另一个模型的眼睛。
- 代价：Claude 的额度消耗回升；每个任务要先判断归哪类，判断写进简报或提交说明。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 正面：复杂改动的质量和返工次数可望改善；opencode 的简报可以写得更具体，因为交给它的都是写法明确的工作。
- 负面：Claude 的 token 用量上升，用户因额度叫停的风险回来；需要靠分类把 Claude 的编码限制在真正复杂的部分。
- 后续：`AGENTS.md` 的分工条改为引用本 ADR；ADR 0058 标为已取代，其第 3–8 条仍通过本 ADR 第 3 条生效。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 用户原话：`.agents/tasks/round2-tool-execution/goal.md` 的 G148（本决定）、G147、G142、G116。
- 被取代的分工：[ADR 0058](0058-agent-collaboration-and-review-roles.md)。
- 模型选择：[ADR 0061](0061-opencode-model-table.md)。
