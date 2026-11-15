# PR 535 第 1 轮作者说明

问题：“主动提议下一步”的第 2 步“想一想”（方案：`.agents/plan-drafts/think-step-plan.md` v2，Andy 已同意）。这个 PR 只做入口表、来源登记和关口，不调任何模型。后面的 PR 才让后台运行读入口里的条目。

改动：
- 迁移 `packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql`：`think_inbox`（来源种类/编号/版本唯一，状态用长度限制的文本，不用 CHECK IN）和 `think_inbox_declined`（按天和原因的被挡次数）。
- `packages/application/src/ports/think-inbox.ts`：`ThinkInboxStorePort`。
- `packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts`：enqueue（先查重复，再查排队上限，再查每日上限，都在一个事务里）、claimNext、finish、recoverStalled、expireQueued、usage、settledSummaries、clearSummary；接线在 `sqlite-durable-operations.ts`、`durable-adapters.ts`、`product-state-repository.ts`，`schema-catalog.ts` 加两条。
- `apps/agent-service/src/production-think-inbox.ts`：`ThinkSourceRegistry`（未登记的种类拒收）、`ProductionThinkInbox.submit/maintain/usage`；摘要放加密载荷，条目结束就删。
- 配置 `runPolicy.thinkInbox`（`strict-configuration.ts` + `configuration.ts`）。
- 测试 `test/integration/think-inbox.test.ts`（真 SQLite），配置测试，文档 `docs/architecture-v0.1.md`。

约束：不调模型；不改系统提示和工具；不写代码注释；临时队列，不进数据导出；没有调用方接入 `ProductionThinkInbox`（下一个 PR 接运行，再下一个接来源）。

作者的说法（请核对，不要照信）：
1. 同来源同版本只收一次：重复提交返回已有条目，不新增行、不计入每日上限、不新建摘要载荷。
2. 队列满或当天满额时，刚写的摘要载荷会被删掉（只在这次新写的情况下删，重复提交不删已有的）。
3. “当天”按配置时区算，不按 UTC。
4. 卡住恢复：`thinking` 且更新时间早于阈值的，重试次数用尽就标 `failed`（原因 `stalled`），否则放回 `queued`；`finish` 只接受 `thinking` 的条目。
5. 所有读写都带主人和 agent 范围。

请重点核对：
1. `submit` 里先写载荷再入队，两步之间崩溃或并发（两个相同提交同时进来）会不会留下没有条目的载荷、或者把别人刚写的载荷删掉。
2. `enqueue` 里每日上限用 `day` 列统计所有状态（含已过期、已失败）：这样算“当天接收数”对不对，会不会有输入让上限被绕过或误挡。
3. `usage` 的 `queued` 与 `enqueue` 里判断队列满用的计数口径不同（前者只算 `queued`，后者算 `queued`+`thinking`），是否会让界面或后续运行误判。
4. `settledSummaries` / `clearSummary` 与载荷删除的顺序，失败时会不会泄漏摘要载荷或误清指针。
5. 配置越界、未登记来源、空摘要等反向输入是否都拒绝而不是写库。
