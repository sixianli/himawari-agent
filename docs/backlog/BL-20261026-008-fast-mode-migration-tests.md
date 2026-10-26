---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-008"
record_state: "open"
date: "2026-10-26"
updated: "2026-10-26"
priority: "normal"
item_type: "process"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 快速模式下加数据库迁移时必跑迁移相关测试

## Summary

快速模式只跑相关测试，加迁移 0056（d849375）和 0057（bfa6162）的提交没跑写死迁移编号的集成测试，main 上 16 个用例因此失败。建议在 .agents/instructions/delivery-mode.md 写明：改 packages/persistence-sqlite/src/migrations/ 时，必须跑所有调用 applyMigrations 或 loadBundledMigrations 的测试文件。

## Origin

- Captured directly.

## Notes

- 2026-10-26：同一次修复把 4 个测试文件里写死的迁移编号改成从迁移清单推算（`sqlite-run-payload-artifacts`、`sqlite-sandbox-execution-v2`、`sqlite-run-dispatch-lease`、`srt-task-environment-release-migration`），这 4 处以后加迁移不用再改。
- 仍写死“最新编号”的还有 `test/integration/sandbox-reservation-administration.test.ts`（`max(sequence)`、`current_sequence`、`minimum_writer_sequence` 等于 57），其中 `minimum_writer_sequence` 不一定总等于最新编号，没有一起改。
- 2026-10-26 统计：调用 `applyMigrations` 或 `loadBundledMigrations` 的测试文件共 50 个，全跑一次的耗时未测量。
- 教训记录见 [lessons：第 0 层漏跑直接相关的测试文件](../lessons.md#layer0-related-tests)。
