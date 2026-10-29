---
status: "active"
document_type: "backlog"
record_id: "BL-20261029-002"
record_state: "open"
date: "2026-10-29"
updated: "2026-10-29"
priority: "normal"
item_type: "enhancement"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 记忆页里给一条记忆换主题

## Summary

记忆详情里还不能改主题（类别和小类）。改类别要经过 saveWithProjection，可能触发重新生成向量，会花嵌入调用的钱。要做的话，先确认只改类别时能否跳过重新嵌入，再加“换主题”操作和测试。来源：ADR 0112。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
