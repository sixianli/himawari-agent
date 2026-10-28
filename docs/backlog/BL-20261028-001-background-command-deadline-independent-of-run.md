---
status: "active"
document_type: "backlog"
record_id: "BL-20261028-001"
record_state: "open"
date: "2026-10-28"
updated: "2026-10-28"
priority: "normal"
item_type: "improvement"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 后台命令的期限不再受本轮截止时间 runMs 约束

## Summary

ADR 0098 的后台命令期限取 30 分钟和本轮截止时间（从这一轮开始算 runMs）中较小的一个，执行句柄有效期也取本轮截止时间。为了让命令真能跑满 30 分钟，上线时把 runMs 放宽到 35 分钟，代价是普通轮次卡住时也要 35 分钟才会被判超时（用户仍可以随时点停止）。要做的是：轮次挂起时为后台命令单独续期执行句柄和截止时间（需改 production-coding-workflow 的句柄有效期、run-execution-input-service 冻结的截止时间和到期结算），再把 runMs 改回 5 分钟。涉及执行许可，改前要单独设计并评审。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
