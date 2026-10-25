---
status: "active"
document_type: "backlog"
record_id: "BL-20261021-004"
record_state: "open"
date: "2026-10-21"
updated: "2026-10-21"
priority: "normal"
item_type: "test-gap"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# Gateway/Worker 重连与恢复：多个控制端共用同一 Worker、一个故障、其余不受影响的测试

## Summary

按 ADR 0063 的“改重试、超时、重连必有多端故障范围测试”：现有重连测试（apps/control-center/test/control-center-client.unit.test.ts、test/integration/execution-worker-process.test.ts）都是单连接。补一个集成测试：两个以上控制中心客户端连着同一个 Agent Service / Worker，其中一个停止响应或断开，断言其余客户端的会话、订阅和审批流不受影响。R2-P2 常驻任务宿主落地时一并补。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
