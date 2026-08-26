---
status: "active"
document_type: "backlog"
record_id: "BL-20260826-002"
record_state: "open"
date: "2026-08-26"
updated: "2026-08-26"
priority: "normal"
item_type: "feature"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 支持外部信息事件驱动响应

## Summary

让受信任的外部信息输入能够通过受控、可验证的事件入口主动触发 Agent 形成响应，而无需等待所有者发起新的对话轮次。不同外部来源应统一进入 Trigger 接纳流程，并保留身份验证、授权、幂等去重、并发控制、离线覆盖缺口和完整 Trace。

## Origin

- 2026-08-26 由所有者直接提出：外界信息输入后，应能主动触发 Agent 对该输入作出响应。
- 产品已有的外部事件触发原则：[SOURCE: docs/prd-v0.2.md#后台任务计划与恢复]
- 当前统一 Trigger 接纳边界：[SOURCE: docs/architecture-v0.1.md#unified-trigger-ingestion-and-scheduling]

## Notes

- 外部输入不能绕过正常的身份验证、授权、幂等、预算、并发和 Trace 管线直接执行行动。
- 具体外部来源、事件映射、响应方式和离线语义应在进入正式设计时由对应 Spec 明确。
