---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-21"
---

# ADR 0060：同一错误第三次出现时停下，加上硬约束

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-14 之前，代理（Claude、Codex、opencode、Grok）犯过的错误靠写进简报、`AGENTS.md` 或 skill 的提醒来避免。同一类错误仍然反复出现：失败现场整目录打包（见 [docs/lessons.md 的“保存失败现场时整目录打包”](../lessons.md#bulky-evidence)）、文件没写好就上传（三次，见[“文件还没写好就上传”](../lessons.md#upload-before-written)）、在一条命令里同步等待长时间任务（先三次，2026-10-18 又三个会话共七次以上，2026-10-19 又三次，见[“代理在一条命令里同步等待”](../lessons.md#long-blocking-wait)）。用户在 2026-10-14 先要求任何失败和犯错都记到合适的地方（G104），随后更正：不是每个错误都记，而是同一错误连续出现三次时必须停下分析根因（G106），并且必须加上测试、门禁或其他方式的硬约束，让 Claude 和其他代理都无法再犯（G107）。

这条规则此前写在 `AGENTS.md` 的 “Repeated Mistakes” 一节和 `docs/lessons.md` 里，没有 ADR。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **触发条件是第三次。** 同一类错误由 Claude 或它指挥的任何代理第三次出现时，暂停当前工作。一次错误不需要单独记录。
2. **先找原因。** 诊断为什么前两次之后的预防没有起作用。只靠记忆的规则已经失败了两次，再写一条提醒不算修好。
3. **必须加硬约束。** 硬约束是代理无法跳过的检查：自动化测试、提交或 CI 门禁（提交或持续集成流水线里自动运行、不过就不放行的检查）、脚本每次使用时的自检、权限配置里的禁止规则、工具调用前后自动执行的钩子或插件、通往远端主机的包装脚本里的拒绝。它对 Claude、opencode、Grok 和其他任何代理一视同仁。
4. **证明它有效。** 在错误的复现场景上演示它失败、把错误去掉后它通过。需要只有用户能做的配置或权限改动时，先准备好、再问用户，这个错误相关的工作在约束落地前保持暂停。
5. **记到对应的位置。** 代理重复犯的错误和它的约束记在 `docs/lessons.md`，已有条目的就在该条目下追加新一次；简报、审查、指挥 opencode 和 Grok 的方法记在 `opencode-orchestration` skill；产品缺陷修掉或开 Backlog（待办条目）；测试、部署、操作方式的改变记进对应的 Runbook（操作手册）、计划或规格；用户对 Claude 工作方式的偏好记进 Claude 的记忆。`docs/lessons.md` 里达到三次的条目要写明硬约束是什么、在哪里运行。
6. **计数跨会话和代理。** 用 `docs/lessons.md`、交接文件、停止文件和提交说明作为历史。会话交接要点名已经发生两次的错误，让下一个会话能认出第三次。
7. **交付报告写明根因和记录位置。** 然后恢复暂停的工作。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：每个错误都记录（G104 最初的表述）

- 好处：不会漏。
- 代价：记录淹没在一次性事件里，没人再读；用户在 G106 更正。

### 方案 B：第三次时记录教训并写更详细的提醒

- 好处：成本低。
- 代价：提醒已经失败了两次；长简报让较弱的模型丢掉边缘规则（见 `opencode-orchestration` skill 的“Preventing rework”一节）。

### 方案 C：第三次时停下、找根因、加代理无法跳过的硬约束（采用）

- 好处：错误在工具层被挡住，与哪个代理、记不记得无关。
- 代价：每次要停下当前工作，并写出能失败、能通过的证明；约束本身要维护，并随工作副本复制。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 正面：2026-10-14 到 10-19 已按此加了多条硬约束，例如包装脚本拒绝管道掩盖退出码（`MASKED_STATUS_REFUSED`）、拒绝 `pgrep -f`、拒绝长等待，证据目录的大文件门禁，以及 opencode 的等待守卫插件；每条都在 `docs/lessons.md` 里有失败和通过的证明（[管道掩盖退出码](../lessons.md#masked-exit-status)、[手写的等待条件](../lessons.md#hand-written-wait)、[同步长等待](../lessons.md#long-blocking-wait)、[整目录打包](../lessons.md#bulky-evidence)）。
- 负面：硬约束会误拦少数无害命令（例如名字匹配禁止规则的 `ls`），简报要事先说明；约束文件多一份副本就多一处要同步。
- 后续：`AGENTS.md` 的 “Repeated Mistakes” 一节改为引用本 ADR；规则再变时写新 ADR 取代本 ADR。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 用户原话：`.agents/tasks/round2-tool-execution/goal.md` 的 G104、G106、G107。
- 教训和各条硬约束：[docs/lessons.md](../lessons.md)。
- 协作分工：[ADR 0058](0058-agent-collaboration-and-review-roles.md)。
