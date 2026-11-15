CLAIM|1|一致|apps/agent-service/src/production-think-runner.ts:142|每想一件事就开一个后台对话|threadId: `thread:think:${key}` as ThreadId,
CLAIM|2|一致|apps/agent-service/src/production-think-actions.ts:64|结论会进提议箱|return proposeTaskRun(
CLAIM|3|一致|apps/agent-service/src/production-think-runner.ts:196|PR 558 已经把它们标成 `threads.origin = 'think'`|origin: "think",
CLAIM|4|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:1437|从所有列表里藏起来|const conditions = ["owner_id = ?", "agent_id = ?", "origin = 'owner'", lifecycle];
CLAIM|5|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:2031|从搜索里藏起来|"current_thread.origin = 'owner'",
CLAIM|6|一致|packages/persistence-sqlite/src/sqlite-web-push-operations.ts:728|从推送里藏起来|WHERE hidden.id = runs.thread_id AND hidden.origin = 'think')
CLAIM|7|一致|packages/persistence-sqlite/src/data-export/chats.ts:117|从导出里藏起来|AND status IN ('open', 'trashed') AND origin = 'owner'
CLAIM|8|一致|packages/persistence-sqlite/src/sqlite-memory-operations.ts:1707|从记忆摘要里藏起来|AND t.origin = 'owner'
CLAIM|9|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:849|主人发起的“永久删除”在服务运行时只把对话改成 `deletion_pending`，并不真删|const target = input.mode === "trash" ? "trashed" : "deletion_pending";
CLAIM|10|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:851|真删数据的 `SqliteGovernedDeletionAdapter.deleteImmediately` 要求服务已停并拿到状态目录锁|"Governed deletion requires stopped services and an exclusive state-root lock",
CLAIM|11|一致|apps/agent-service/src/production-think-runner.ts:196|想一想对话在建对话的同一个事务里记 `origin = 'think'`|origin: "think",
CLAIM|12|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:547|客户端经网关建的对话一律是 `owner`|thread.origin ?? "owner",
CLAIM|13|一致|test/integration/think-runner.test.ts:458|即使编号以 `thread:think:` 开头|expect(origins.find((row) => row.id === lookAlike)?.origin).toBe("owner");
CLAIM|14|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:849|那条路在服务运行时只标 `deletion_pending`，真删要停服务|const target = input.mode === "trash" ? "trashed" : "deletion_pending";
CLAIM|15|一致|packages/application/src/services/product-thread-gateway-adapter.ts:746|客户端可以自己指定这样的编号|threadId: createThreadId(command.payload.threadId),
CLAIM|16|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:962@0d31eb96b5981b48a4624ae0d2d60673ce808f8b|另外补删了原先漏掉的标题载荷 `threads.title_ref`|"SELECT metadata_ref FROM threads WHERE id = ? AND metadata_ref IS NOT NULL",
CLAIM|17|一致|test/integration/think-runner.test.ts:609|回归测试在 `test/integration/think-runner.test.ts`|it("deletes a finished thinking thread and everything it holds once the kept days pass, and nothing else", async () => {
CLAIM|18|一致|test/integration/think-runner.test.ts:712|主人的旧对话、运行中的想一想对话、有生效定时任务的、未到期的都不删|"thread:think:owner-made",
CLAIM|19|一致|test/integration/think-runner.test.ts:756|主人的旧对话、运行中的想一想对话、有生效定时任务的、未到期的都不删|expect(await racing.deleteExpiredThinkThreads(input)).toEqual([]);
CLAIM|20|一致|test/integration/think-runner.test.ts:698|主人的旧对话、运行中的想一想对话、有生效定时任务的、未到期的都不删|expect(await retention.runOnce()).toBe(0);
CLAIM|21|一致|test/integration/think-runner.test.ts:675|主人的旧对话、运行中的想一想对话、有生效定时任务的、未到期的都不删|expect(await retention.runOnce()).toBe(0);

未核实：Andy 2026-11-15 的项目聊天原话不在仓库内；ChatGPT 临时对话保留 30 天的说明属外部网站；“主人很少回头看原文”属主观描述，未作代码核对。
