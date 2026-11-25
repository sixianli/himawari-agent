---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-26"
covers: "apps/agent-service/test/production-coding-workflow.unit.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0077：工作目录操作按实际作用定风险，不再一律标高风险

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-24 的真实使用复盘（第 10 项）发现：`approval_requests` 里每条记录都是 `HIGH`，并在几十毫秒内被工作区策略自动批准，连 `ls`、`read` 也是 `HIGH`。原因是编码工具的意图固定写了 `suggestedRisk: "HIGH"`，并带一条 `external_model_disclosure` 事实，把风险下限设成 `HIGH`（“工作区内容会发给外部模型”）。自动放行本身是 [ADR 0053](0053-workspace-auto-approval-like-codex.md) 的决定，没有问题；问题是风险分级失去区分度，审批记录和需要人工确认的卡片上显示的风险都不准。

2026-10-26 Andy 在决策卡上选了“保留自动，改准风险标签”。

<a id="decision"></a>

## 决定

- 编码工具意图的模型建议风险取该操作类别的基线（`ACTION_KIND_RISK_BASELINE`），最终风险由 `computeActionRisk` 按同一规则算出，不再手写。
- `external_model_disclosure` 事实保留，作为记录，但风险下限改为 `LOW`：本轮模型本来就持有主人的私有上下文，把工作区内容交给它不额外提高风险。
- `web_search`、`web_fetch` 另加 `external_provider_disclosure` 事实，风险下限 `MEDIUM`：查询内容会离开模型边界，发给搜索服务商。
- 文件读取流程（`production-file-read-workflow.ts`）的披露步骤同样按 `LOW` 计。
- 结果：`read`、`ls`、`find`、`grep` 为 `LOW`；`write`、`edit`、`move_directory`、保存副本为 `MEDIUM`；`bash` 为 `HIGH`；联网搜索和读网页为 `MEDIUM`；删除仍按基线为 `HIGH`，不可恢复删除为 `CRITICAL`。
- 自动放行范围不变：哪些操作自动通过仍完全由 ADR 0053 的工作区策略决定，风险等级不参与那条判断。
- 输入框下的提示改为写明哪些操作会先问主人：删除文件、联网命令、工作目录外的操作。

<a id="options"></a>

## 比较过的方案

- **只读自动、写和命令逐次确认**：更保守，但每轮要多次点确认，和 ADR 0053 以及“速度优先”冲突，Andy 未选。
- **全部逐次确认**（`runPolicy.coding.approval: "ask"`）：只改配置，最慢，Andy 未选。
- **维持现状**：记录继续全部是 `HIGH`，等于没有分级，Andy 未选。

<a id="consequences"></a>

## 后果

- 新的风险等级只影响意图快照和审批记录里显示的风险。长期 Grant 与安全读取规则仍要求 `disclosure: "none"`，编码工具的意图都是 `named_recipients`，所以不会因为变成 `LOW` 而被这些规则放行。自动审核仍只排除 `CRITICAL`。
- 上线时仍在等待人工确认、或已批准未执行的旧意图，其快照哈希与新算出的意图不同，会按“上下文已变化”失败，需要重试一次。
- 测试：`apps/agent-service/test/production-coding-workflow.unit.test.ts` 新增按工具核对最终风险并通过意图校验的用例。

<a id="references"></a>

## 关联文档

- [ADR 0053：工作区内自动批准，参照 Codex Auto](0053-workspace-auto-approval-like-codex.md)
- [ADR 0004：确定性授权](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0004-deterministic-authorization.md)
