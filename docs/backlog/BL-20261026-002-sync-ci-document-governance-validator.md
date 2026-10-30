---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-002"
record_state: "open"
date: "2026-10-26"
updated: "2026-10-31"
priority: "low"
item_type: "maintenance"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 把 CI 用的文档校验器副本同步到 skill 当前版本

## Summary

CI 的 static 任务用 tools/document-governance/ 里 2026-09-03 固定的旧版 validate_docs.py（来源提交 70dce9f），而 npm run check:docs 和各线程用的是 tools/document-governance-skill/（agent-skills 提交 fa8a4e6，2026-10-31 由 .claude/skills/document-governance/ 移来，见 ADR 0132），两者的 validate_docs.py、runbook.py、idea_backlog.py 各差约 200 行，例如新版支持连续取代链。目标：在 Mac 上用 scripts/ci/sync-governance.mjs 从 agent-skills 的同一提交重新同步并更新 provenance，让 CI 和本地检查用同一版本。需要能读 agent-skills 仓库的会话（云端 GitHub 当前读不到）。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
