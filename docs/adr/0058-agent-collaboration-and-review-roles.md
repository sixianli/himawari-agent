---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-21"
---

# ADR 0058：Claude 统筹、opencode 编码、双向互审的协作分工

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

这份 ADR（架构决策记录，说明一个长期决定是什么、为什么）记录开发时几个 AI 代理的分工：Claude Code（下文简称 Claude，用户直接对话的代理）和 opencode（本地命令行里的编程代理，按简报写代码、跑测试）。2026-10-11 之前编码和测试交给 Codex（此前使用的另一个编程代理）；2026-10-11 用户要求 Claude 自己做、不再交给 Codex（G71）；2026-10-12 起换给 opencode（G77），并要求把协作方法沉淀成一个 skill（可复用的操作指引，G78、G79），2026-10-02 起用 `long-task-planning` skill 管理目标、计划和完成状态（G12），2026-10-05 起 Claude 可以独立维护计划文件（G40）。之后用户又陆续调整了分工：机械性的脚本由 Claude 自己运行（G81）；Claude 一度也写协议层和核心模块（G116），2026-10-18 收回，Claude 不再写任何代码（G147）；两边写的代码只能由对方审查（G142）；方案拿不定时先让多个模型各出方案（G140）；用户尽量不参与技术决定（G117）。

这些决定只记在长任务目标文件 `.agents/tasks/round2-tool-execution/goal.md` 的原话里和 `AGENTS.md` 的叙述里，没有一份正式文档说明现行分工和理由。2026-10-21 盘点 147 条原话时发现这个缺口（盘点结果在本地交接文件 `.ci-output/handoff/2026-10-21-goal-decision-inventory.md`，该目录不随仓库提交），本 ADR 补上。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **opencode 写全部代码。** 产品代码、测试、脚本（包括未提交的操作包工具和生产入口脚本）都由 opencode 写和改。Claude 不写代码（G147，收回 G116 给 Claude 的编码许可）。
2. **Claude 只做统筹。** Claude 负责规划、写简报、派活、逐行审查 opencode 的改动、比较方案并拍板、运行或安排验证、提交、推送、记录。机械性的脚本（诊断、冻结包步骤）由 Claude 自己运行；只有真正高危、需要授权的操作才交给用户（G81）。
3. **双向互审，自审不算。** opencode 的每一行改动由 Claude 审；Claude 写的代码、测试和脚本（含未提交的操作包工具和生产入口脚本）由 opencode 审。作者对自己产出的审查不算数（G142）。文档和简报不在 G142 的范围内，走文档校验流程；Claude 可以额外请 opencode 审查自己写的文档（本 ADR 就是这样审的），但这不是强制要求。长任务的审查记录里 `--by` 写审查方，不写作者。
4. **定方案前先问独立方案。** 设计或修法定稿前，Claude 先让 opencode 里的 DeepSeek V4.1 Flash 独立给一份方案，对比后在计划或提交说明里写明采用了哪些想法和原因（G116 的这一部分保留）。拿不定时让多个模型各出方案再定（G140）；只问免费模型，两个免费模型都被限流时只问 `opencode-go/deepseek-v4.1-flash` 一家，不另开 Go 的 GLM 会话（见 [ADR 0059](0059-opencode-model-selection-free-first.md)）。
5. **用户只在两边都定不下来时参与。** Claude 和 opencode 之间先定；定不下来才带着选项和推荐找用户。本来就需要用户授权的事（生产部署和冻结包、新下载、减少证据、sudo 改动）攒在一起问一次（G117）。
6. **目标、计划、完成状态用 `long-task-planning` 管理。** 用户在 G12 指定这个 skill，在 G40 授权 Claude 独立维护 `plan.md` 和 `items.json`。按该 skill 的约定：目标是用户原话、只追加（`goal.md` 开头写明）；计划只写打算；做没做完只看 `longtask.py status` 从证据算出的结果。
7. **opencode 遵守和 Codex 相同的项目规则。** 测试只在 Hermes 或云服务器的 `himawari-ci` 账号上跑，不碰生产，不读密钥，提交推送规则不变。生产步骤不委派。
8. **协作方法写在 skill 里并持续改进。** 操作步骤（简报模板、启动、监视、停止文件、审查清单）在 `opencode-orchestration` skill 里维护，本 ADR 只记分工和理由。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：Claude 自己编码（G71，2026-10-11 到 10-12）

- 好处：少一次交接，审查和编码在一个头脑里。
- 代价：Claude 的 token（模型计费和上下文的计量单位）额度是瓶颈：2026-10-04 用户因每周额度将尽把工作交给 Codex 独立完成（G39），2026-10-19 又因额度叫停过一次；一个代理同时写和审，自审容易漏。

### 方案 B：Claude 写核心模块，opencode 写其余（G116，2026-10-16 到 10-18）

- 好处：复杂的协议层由更强的模型写。
- 代价：Claude 的额度仍然消耗在编码上；两种作者的代码混在一个改动里，审查要先按作者拆开。用户在 G147 收回。

### 方案 C：opencode 写全部代码，Claude 只统筹、审查、拍板（采用）

- 好处：Claude 的额度用在审查和决策上；互审让每行代码都经过另一个模型的眼睛；用户只需对少数授权点表态。
- 代价：简报要写得足够具体，否则返工；审查工作量大，Claude 必须逐行读而不是转述 opencode 的报告。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 正面：用户的目标“尽量少参与、当甩手掌柜”（G117）有了明确的边界；每个改动都有两个模型看过。
- 负面：opencode 的模型比 Claude 弱，简报里漏掉的规则会被忽略，所以违反两次的规则要变成工具里的硬拦截（见 [ADR 0060](0060-hard-constraint-on-third-repeat.md)）。
- 后续：`AGENTS.md` 的 “Delegated Coding Agents” 一节改为引用本 ADR 和 [ADR 0059](0059-opencode-model-selection-free-first.md)，不再叙述决定的演变；分工再变时写新 ADR 取代本 ADR。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 用户原话：`.agents/tasks/round2-tool-execution/goal.md` 的 G12、G40、G71、G77、G78、G79、G81、G116、G117、G140、G142、G147。
- 模型选择规则：[ADR 0059](0059-opencode-model-selection-free-first.md)。
- 重复错误的硬约束：[ADR 0060](0060-hard-constraint-on-third-repeat.md)。
- 测试位置和分层：[ADR 0057](0057-batch-layers-one-two-for-small-defects.md)。
- 协作步骤：`opencode-orchestration` skill（`~/.claude/skills/opencode-orchestration/SKILL.md`，源码在兄弟仓库 `agent-skills`）。
