---
status: "active"
document_type: "backlog"
record_id: "BL-20261027-012"
record_state: "done"
date: "2026-10-27"
updated: "2026-10-27"
priority: "normal"
item_type: "feature"
source_idea: ""
review_after: ""
promoted_to: ""
result: "2026-10-27 按 Andy 要求在 PR #63 实现：轮次答完后挂着、命令跑完由系统另起一轮汇报，见 ADR 0097。"
reason: ""
supersedes: ""
superseded_by: ""
---
# 后台命令跨过本轮回答继续运行，结束后另起一轮通知

## Summary

ADR 0097 的后台命令只活在一轮回答里：模型答完时这一轮等命令结束再补答，本轮结束、停止或等审批时命令都会被停掉。Claude Code 交互模式和 Pi 社区扩展 omp-unified-exec 的做法是命令跨轮继续跑，结束时由系统唤醒 Agent 另起一轮。Himawari 要做到这一点需要：沙箱资源不再随 resources.stopRun 在每轮结束时回收、执行句柄和目录授权的期限不再以本轮截止时间为上限、由系统而不是用户消息发起一轮新的回答、对话归档或删除时清理。改动面大，先记下，等 Andy 决定优先级。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
