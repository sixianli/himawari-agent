---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-001"
record_state: "open"
date: "2026-10-26"
updated: "2026-10-26"
priority: "normal"
item_type: "maintenance"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 复核并重新封存快速模式下落后的 7 处 Runbook 封存

## Summary

2026-10-26 严格校验在 6 个 Runbook 上报 contract_sha256 与当前代码不符（authority-transfer、backup-restore、hermes-control-center-upgrade、sandbox-reservation-administrative-disposition、test-host-operations、workspace-lifecycle-audit），install-start-stop Runbook 还依据已删除的 packages/memory-mem0/src/index.ts。快速模式下 npm run check:docs 放行这两类错误（ADR 0080）。目标：逐个对照当前代码复核步骤，改正说错的内容，install-start-stop 去掉 Mem0 依据，然后用 runbook.py seal --confirm-reconciled --apply 重新封存，使严格校验在完整模式下 0 错误。切回完整模式时必须完成；线程要照其中某个 Runbook 操作前，先完成那一个。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
