CLAIM|1|一致|apps/agent-service/src/production-think-runner.ts:194|“想一想”（[ADR 0274](0274-new-things-go-through-one-think-entrance.md)）每想一件事就开一个后台对话（下文叫“想一想对话”）|      threadId: id.threadId,
CLAIM|2|一致|apps/agent-service/src/production-think-actions.ts:64|结论会进提议箱|      return proposeTaskRun(
CLAIM|3|一致|apps/agent-service/src/production-think-runner.ts:196|PR 558 已经把它们标成 `threads.origin = 'think'`|      origin: "think",
CLAIM|4|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:1437|从所有列表里藏起来|    const conditions = ["owner_id = ?", "agent_id = ?", "origin = 'owner'", lifecycle];
CLAIM|5|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:2031|从搜索里藏起来|      "current_thread.origin = 'owner'",
CLAIM|6|一致|packages/persistence-sqlite/src/sqlite-web-push-operations.ts:728|从推送里藏起来|               WHERE hidden.id = runs.thread_id AND hidden.origin = 'think')
CLAIM|7|一致|packages/persistence-sqlite/src/data-export/chats.ts:117|从导出里藏起来|          AND status IN ('open', 'trashed') AND origin = 'owner'
CLAIM|8|一致|packages/persistence-sqlite/src/sqlite-memory-operations.ts:1707|从记忆摘要里藏起来|          AND t.origin = 'owner'
CLAIM|9|不一致|apps/agent-service/src/production-think-retention.ts:68|这些对话一直留着|      const reports = await this.#options.deletion.deleteExpiredThinkThreads({
CLAIM|10|不一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:708|数据库和加密文件会越积越多|    const afterPayload = await this.#deletePayloadFiles(prepared);
CLAIM|11|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:849|主人发起的“永久删除”在服务运行时只把对话改成 `deletion_pending`，并不真删|      const target = input.mode === "trash" ? "trashed" : "deletion_pending";
CLAIM|12|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:792|真删数据的 `SqliteGovernedDeletionAdapter.deleteImmediately` 要求服务已停并拿到状态目录锁|        "Governed deletion requires stopped services and an exclusive state-root lock",
CLAIM|13|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:553|想一想对话在建对话的同一个事务里|    const transaction = this.database.transaction(() => {
CLAIM|14|一致|apps/agent-service/src/production-think-runner.ts:196|记 `origin = 'think'`|      origin: "think",
CLAIM|15|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:547|客户端经网关建的对话一律是 `owner`|        thread.origin ?? "owner",
CLAIM|16|一致|test/integration/think-runner.test.ts:458|即使编号以 `thread:think:` 开头|    expect(origins.find((row) => row.id === lookAlike)?.origin).toBe("owner");
CLAIM|17|一致|packages/application/src/ports/configuration.ts:434|是想一想的第 11 个可改设置|  { key: "threadRetentionDays", unit: "days", minimum: 1, maximum: 90, defaultValue: 7 },
CLAIM|18|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:849|让清理走主人删除的网关命令：那条路在服务运行时只标 `deletion_pending`，真删要停服务|      const target = input.mode === "trash" ? "trashed" : "deletion_pending";
CLAIM|19|一致|packages/application/src/services/product-thread-gateway-adapter.ts:746|凭编号前缀 `thread:think:` 判断是不是想一想对话：客户端可以自己指定这样的编号|          threadId: createThreadId(command.payload.threadId),
CLAIM|20|不一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:909|和停服务时的永久删除共用同一套删除步骤（对话、消息、运行、载荷行、加密文件、标题载荷，并留删除记录）|DELETE FROM triggers WHERE id IN (${placeholders(triggerIds)})

Andy 的项目聊天原话和 ChatGPT 临时对话的 30 天政策是外部信息，未核对；决定与后果中描述本次新增行为的部分按题目要求未作为现状逐条列出。其余已按当前提交 b1cb5d5a95dcb89f8b29f9179ba8ce808f2c453b 核对。
