# 作者说明（第 2 轮）

第 1 轮的意见和处理见 `.agents/reviews/pr-325/round-1/judgments.md`。本轮提交只含按意见做的修改：

- `ci/operations-removed.json` 和 `scripts/check-operations.mjs`：新增已删除名单检查（已删操作不得回到约定，也不得以 `type: "名字"`、`type === "名字"`、`case "名字"` 出现在后端、前端、脚本、测试里），反向用例在 `test/tooling/operations-check.test.mjs`。
- `packages/integration-github/test/github-integration.unit.test.ts`：残留的 `session.revoke` 改为 `grant.revoke`。
- `packages/persistence-sqlite/test/memory-reminder-cancelled-migration.contract.test.ts`：0085 旧数据迁移测试。
- `apps/agent-service/src/production-memory-control.ts`：已取消的提醒只接受再次取消，其余动作返回 `MEMORY_REMINDER_CANCELLED`；`test/integration/production-memory-capture.test.ts` 加断言。
- `schema-catalog.ts` 描述、ADR 0192 补充页面状态和已删除名单。

请对照代码核对：已删除名单的匹配是否会误报或漏报；已取消提醒的守卫是否挡住了合法路径（例如取消后的整理、导出、治理删除）；迁移测试是否真能证明旧数据保留。
