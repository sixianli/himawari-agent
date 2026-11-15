CLAIM|1|一致|docs/adr/0274-new-things-go-through-one-think-entrance.md:11|“想一想”（ADR 0274）|# ADR 0274：新知道的事都走同一个“想一想”入口，先问值不值得，再带工具想
CLAIM|2|一致|apps/agent-service/src/production-think-runner.ts:142|每想一件事就开一个后台对话（下文叫“想一想对话”）|threadId: `thread:think:${key}` as ThreadId,
CLAIM|3|一致|apps/agent-service/src/production-think-runner.ts:272|结论会进提议箱|return { outcome: "proposed", reasonCode: "proposal_written" };
CLAIM|4|一致|apps/agent-service/src/production-think-runner.ts:196|PR 558 已经把它们标成 `threads.origin = 'think'`|origin: "think",
CLAIM|5|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:1437|从所有列表里藏起来|const conditions = ["owner_id = ?", "agent_id = ?", "origin = 'owner'", lifecycle];
CLAIM|6|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:2031|从搜索里藏起来|"current_thread.origin = 'owner'",
CLAIM|7|一致|packages/persistence-sqlite/src/sqlite-web-push-operations.ts:728|从推送里藏起来|WHERE hidden.id = runs.thread_id AND hidden.origin = 'think')
CLAIM|8|一致|packages/persistence-sqlite/src/data-export/chats.ts:117|从导出里藏起来|AND status IN ('open', 'trashed') AND origin = 'owner'
CLAIM|9|一致|packages/persistence-sqlite/src/sqlite-memory-operations.ts:1707|从记忆摘要里藏起来|AND t.origin = 'owner'
CLAIM|10|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:849|主人发起的“永久删除”在服务运行时只把对话改成 `deletion_pending`，并不真删|const target = input.mode === "trash" ? "trashed" : "deletion_pending";
CLAIM|11|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:851|真删数据的 `SqliteGovernedDeletionAdapter.deleteImmediately` 要求服务已停并拿到状态目录锁|"Governed deletion requires stopped services and an exclusive state-root lock",
CLAIM|12|一致|docs/architecture-v0.1.md:437|想一想对话在建对话的同一个事务里记 `origin = 'think'`|建对话时在同一个事务里把 `threads.origin` 记成 `think`
CLAIM|13|一致|docs/architecture-v0.1.md:437|客户端经网关建的对话一律是 `owner`，即使编号以 `thread:think:` 开头|（主人和客户端建的对话一律是 `owner`，客户端自己挑一个 `thread:think:` 开头的编号也还是 `owner`）
CLAIM|14|一致|docs/architecture-v0.1.md:437|见 `docs/architecture-v0.1.md` 里“想一想”的运行那一段|**“想一想”的运行（2026-11-15，ADR 0274）**
CLAIM|15|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:849|让清理走主人删除的网关命令：那条路在服务运行时只标 `deletion_pending`|const target = input.mode === "trash" ? "trashed" : "deletion_pending";
CLAIM|16|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:851|真删要停服务|"Governed deletion requires stopped services and an exclusive state-root lock",
CLAIM|17|一致|packages/application/src/services/product-thread-gateway-adapter.ts:746|客户端可以自己指定这样的编号|threadId: createThreadId(command.payload.threadId),
CLAIM|18|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:1148|删除步骤也会删对话的标题载荷 `threads.title_ref`|"SELECT title_ref FROM threads WHERE id = ? AND title_ref IS NOT NULL",
CLAIM|19|一致|test/integration/think-runner.test.ts:609|回归测试在 `test/integration/think-runner.test.ts`|it("deletes a finished thinking thread and everything it holds once the kept days pass, and nothing else", async () => {
CLAIM|20|一致|test/integration/think-runner.test.ts:712|主人的旧对话不删|"thread:think:owner-made",
CLAIM|21|一致|test/integration/think-runner.test.ts:672|运行中的想一想对话不删|expect(await retention.runOnce()).toBe(0);
CLAIM|22|一致|test/integration/think-runner.test.ts:698|有生效定时任务的不删|expect(await retention.runOnce()).toBe(0);
CLAIM|23|一致|test/integration/think-runner.test.ts:702|未到期的不删|expect(await retention.runOnce()).toBe(0);

Andy 的项目聊天原话（cmsg_01EE1hey9cboYNfwFnBv5dgrDs6moWVTLBrHyMTxWzj99b）和 ChatGPT“临时对话”保留 30 天的外部说法属于聊天／外部资料，未核对；决定部分多数是方案要新增或修改的行为，除明确陈述现有删除步骤会删 `threads.title_ref` 的那一句外，未按现状逐条核对。
