---
status: "active"
document_type: "backlog"
record_id: "BL-20261029-003"
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
# 用评测集比较是否给记忆搜索加重排模型

## Summary

ADR 0115 先用相似度门槛止住无关记忆，但需要联想的问题命中率只有 33%。用 npm run eval:memory-retrieval 比较加重排模型（专门给问题和记忆的相关度打分的小模型）前后的命中率、无关带出率、延迟和每轮费用，再决定是否加。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
