# PR 455 第 3 轮：对第 2 轮意见的修改

问题、目标和约束同第 1 轮（`.agents/reviews/pr-455/briefs/43de0dc71882-code-review.md`）。前两轮的逐条判断在 `.agents/reviews/pr-455/round-1/judgments.md` 和 `.agents/reviews/pr-455/round-2/judgments.md`。第 2 轮没有中、高的意见，但 4 条低意见的修改动了 8 个文件，超过“小改动不再复核”的 5 个文件上限，所以再复核一轮。

这一轮的增量里还有一次合并：把 PR 451 的分支（`origin/claude/project-thread-fzn28h`，本 PR 叠在它上面）的 7 个新提交合了进来。那些提交属于 PR 451，已经在那边复核过，不用复核；只看合并后本 PR 自己的代码和它们是否对得上。

## 作者的说法（请核对，不要直接采信）

1. 提议入口的调用放在 `Promise.resolve().then(...)` 里，同步抛错、异步拒绝、一直不答复，都不影响这次检查（`packages/application/src/services/proactive-mail-check-service.ts`）。
2. `PROACTIVE_ITEMS_PER_CHECK_MAXIMUM = 500`（`packages/application/src/ports/proactive-sources.ts`）同时是登记表里每次检查上限的最大值上界和存储层 `MAX_INPUT_IDS`；登记时每次检查上限的最大值超过它就拒绝。
3. `recordProactiveProgramEntry` 要求 `dueAt`、`deliverAt` 是 null 或标准 ISO 时间（`Date.parse` 后 `toISOString` 等于原值），否则返回 `entry_invalid`（`packages/application/src/services/proactive-source-runtime.ts`）。
4. `record` 的 `onlyIfNew` 只带 `source` 和 `since`，每天上限由存储层在同一个事务里读当前设置（`packages/persistence-sqlite/src/sqlite-proactive-operations.ts`）。“今天”的起点仍由调用方按主人的时区算。
5. PR 451 的分支给 `decision_ledger` 的 proposal 结果值加了 `told`（`0095_perception_records.sql`）。本 PR 的 `0097_proactive_source_registry.sql` 重建这张表，已经补上 `told`；迁移契约测试 `changes nothing in the rebuilt tables except the source name constraints` 会在两边定义不一致时失败。请核对 0097 重建的每张表和合并后它前面的迁移留下的定义，除了来源名的约束以外逐字段一致。
