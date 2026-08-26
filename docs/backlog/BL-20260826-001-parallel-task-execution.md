---
status: "active"
document_type: "backlog"
record_id: "BL-20260826-001"
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
# 支持多个独立任务异步并行执行

## Summary

让同一个主 Agent 能同时接纳和推进多个相互独立的顶层任务，而不是要求前一个任务完成后才能开始下一个任务。不同任务应具有隔离的 Thread、Run、状态、取消、预算和结果交付边界；同一逻辑任务的重复触发仍应默认合并，只有明确证明安全时才允许并行。

## Origin

- 2026-08-26 由所有者直接提出：Agent 应能异步、并行处理多个任务，不再强制不同任务依次串行执行。
- 产品已有的后台任务与并发原则：[SOURCE: docs/prd-v0.2.md#后台任务计划与恢复]
- Agent、Thread 与 Run 的隔离决策：[SOURCE: docs/adr/0013-agent-thread-run-memory-model.md]

## Notes

- 本条针对相互独立的顶层任务；主 Agent 在单个 Run 内委派内部 Worker 是相关但不同的能力。
- 延续现有约束：同一逻辑任务的重复触发默认合并，并发必须有全局与分类上限，并为前台交互预留容量。
