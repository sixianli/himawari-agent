---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-13"
covers: ""
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0053：授权工作目录内的操作默认不需要批准（参照 Codex Auto 模式）

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-13 第三次生产部署后，用户在控制中心（Himawari 的网页聊天界面）真实聊天，要求“列出文件并打开其中一个”。生产配置只开放了读文件工具，而且授权目录内的每一次读取都要用户手动批准：一轮里 7 次读取共等了用户 2 分 28 秒。证据见运行记录 `run:9a2d2c24-e4fa-4069-baae-f73058f3845d`。

Claude 对照了两个主流编码 Agent 的官方文档：

- Claude Code 的权限文档写明：只读工具（读文件、Grep 搜索）在工作目录内不需要批准；改文件、执行命令需要批准，内置的一组只读命令除外。[Claude Code 权限文档](https://code.claude.com/docs/en/permissions)
- Codex 的默认 `Auto` 模式（预设为 `workspace-write` 加 `on-request`，也就是“可写工作目录、按需询问”）在工作目录内读文件、改文件、执行命令都不需要批准；只有改工作目录外的文件，或者执行需要联网的命令时才询问。[Codex 审批与安全文档](https://learn.chatgpt.com/docs/agent-approvals-security)

用户的决定（长任务目标 G88，原话）：“按照 Codex 的这个来，我这个 Agent（也就是 Himawari 这个 Agent）是要做成个人的一个全能 Agent。如果给这么多限制，怎么全能？”

<a id="decision"></a>

## 决定

Himawari 的默认授权策略参照 Codex `Auto` 模式：

1. **授权工作目录内**：读文件、列目录、找文件、搜索、写文件、编辑文件、在沙箱里执行不联网的命令，默认判定为 `ALLOW`（允许），不需要逐次批准。授权工作目录指用户通过目录授权（例如 `directory:himawari-prod-workspace-20261012`）交给 Agent 的目录。
2. **仍然询问（`ASK`）的操作**：写入或修改授权工作目录以外的位置；执行需要联网的命令；以及原有设计中独立检查的高风险动作和数据披露，例如 GitHub 推送、发送消息、读取秘密。
3. **不变的部分**：授权判断仍由确定性组件完成，模型不能批准自己，见 [ADR 0004](0004-deterministic-authorization.md)。命令仍在任务级隔离环境中执行，见 [ADR 0031](0031-isolated-tool-execution.md)；联网仍按 [ADR 0026](0026-job-scoped-network-egress.md) 按任务限定。审批、恢复和结果核查规则沿用 [ADR 0023](0023-durable-hitl-execution.md)。

本决定改变的是“哪些动作默认允许”这条策略，不改变授权组件、审批状态机和沙箱边界本身。

<a id="options"></a>

## 比较过的方案

| 方案 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- |
| 维持现状：每次工具调用都询问 | 每一步都有人看过 | 用户要不停点批准，一轮简单任务就要等几分钟，做不成“个人全能 Agent” | 不采用 |
| 参照 Claude Code：只读免批准，写文件和执行命令仍询问 | 读得快，修改仍有人把关 | 改文件、跑命令仍要频繁批准 | 不采用（用户选择更宽的方案） |
| 参照 Codex `Auto`：工作目录内读、写、执行都免批准，越界写入和联网才询问 | 与主流默认一致，用户体验接近全能助手；越界和联网仍有边界 | 工作目录内的误操作不再有人逐次把关，要依靠沙箱、授权目录范围和事后可审计记录 | 采用 |

<a id="consequences"></a>

## 后果

- 好处：用户在授权目录里交给 Himawari 的任务可以连续完成，不再被逐次批准打断。
- 代价：授权目录内的写入和命令不再逐次确认。用户交给 Himawari 的目录应当是愿意让它直接修改的目录；需要保护的内容不要放进授权目录，或者另行授权只读目录。
- 后续工作：
  - 生产配置开放 `write`、`edit`、`bash` 等工具，并让授权目录的授权覆盖这些操作，见长任务条目 R2-T1、R2-T2。
  - 更新授权与审批相关的规格和架构文档，写清默认允许和仍需询问的动作清单。
  - 控制中心显示“本轮自动执行了哪些操作”，保证事后可查。

<a id="references"></a>

## 关联文档

- [ADR 0004：将授权判断置于模型之外](0004-deterministic-authorization.md)
- [ADR 0023：通用人工审批与持久执行恢复](0023-durable-hitl-execution.md)
- [ADR 0026：按任务限定的联网](0026-job-scoped-network-egress.md)
- [ADR 0031：分离控制平面与任务级隔离工具执行环境](0031-isolated-tool-execution.md)
- [ADR 0054：只读文件工具在主进程执行，命令和写入复用任务沙箱](0054-readonly-tools-in-host-and-reused-task-sandbox.md)
