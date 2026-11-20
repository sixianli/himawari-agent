CLAIM|1|一致|docs/architecture-v0.1.md:437|“想一想”（[ADR 0274](0274-new-things-go-through-one-think-entrance.md)）每想一件事就开一个后台对话（下文叫“想一想对话”）。|每取一条，先问 Jev，值得才开一次后台运行：`production-think-runner.ts` 新开一个对话 `thread:think:<编号>`
CLAIM|2|一致|apps/agent-service/src/production-think-runner.ts:266|结论会进提议箱|const result = await action.propose(parsed.fields, { entry, reason: parsed.reason, threadId });
CLAIM|3|一致|apps/agent-service/src/production-think-runner.ts:196|PR 558 已经把它们标成 `threads.origin = 'think'`|origin: "think",
CLAIM|4|一致|test/integration/think-runner.test.ts:468|并从所有列表、搜索、推送、导出和记忆摘要里藏起来。|expect(listed.map((item) => item.id)).toEqual([lookAlike]);
CLAIM|5|一致|test/integration/think-runner.test.ts:500|并从所有列表、搜索、推送、导出和记忆摘要里藏起来。|expect(found.map((item) => item.id)).toEqual([lookAlike]);
CLAIM|6|一致|docs/architecture-v0.1.md:437|并从所有列表、搜索、推送、导出和记忆摘要里藏起来。|不进首页“没人看着的运行”、网页推送、Apple 推送和灵动岛
CLAIM|7|一致|test/integration/chat-export.test.ts:193|并从所有列表、搜索、推送、导出和记忆摘要里藏起来。|expect(text).not.toContain("外部内容的摘要");
CLAIM|8|一致|test/integration/think-runner.test.ts:516|并从所有列表、搜索、推送、导出和记忆摘要里藏起来。|expect(episodes.map((item) => item.threadId)).toEqual([lookAlike]);
CLAIM|9|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:849|主人发起的“永久删除”在服务运行时只把对话改成 `deletion_pending`，并不真删|const target = input.mode === "trash" ? "trashed" : "deletion_pending";
CLAIM|10|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:811|真删数据的 `SqliteGovernedDeletionAdapter.deleteImmediately` 要求服务已停并拿到状态目录锁|"Governed deletion requires stopped services and an exclusive state-root lock",
CLAIM|11|一致|docs/architecture-v0.1.md:437|想一想对话在建对话的同一个事务里记 `origin = 'think'`|建对话时在同一个事务里把 `threads.origin` 记成 `think`
CLAIM|12|一致|docs/architecture-v0.1.md:437|客户端经网关建的对话一律是 `owner`，即使编号以 `thread:think:` 开头|（主人和客户端建的对话一律是 `owner`，客户端自己挑一个 `thread:think:` 开头的编号也还是 `owner`）
CLAIM|13|一致|packages/application/src/ports/configuration.ts:434|新设置项 `threadRetentionDays`（想一想记录保留天数），1 到 90，默认 7|{ key: "threadRetentionDays", unit: "days", minimum: 1, maximum: 90, defaultValue: 7 },
CLAIM|14|一致|packages/application/src/ports/configuration.ts:434|是想一想的第 11 个可改设置，写在 `packages/application/src/ports/configuration.ts` 的 `THINK_SETTING_DEFINITIONS`|{ key: "threadRetentionDays", unit: "days", minimum: 1, maximum: 90, defaultValue: 7 },
CLAIM|15|一致|apps/agent-service/src/production-think-retention.ts:60|每次清理都现读，改了天数，已有对话也按新天数算|const days = await this.retentionDays();
CLAIM|16|一致|apps/agent-service/src/production-think-retention.ts:106|`apps/agent-service/src/production-think-retention.ts` 的 `ThinkThreadRetention` 在服务启动后先清一次|tick();
CLAIM|17|一致|apps/agent-service/src/production-think-retention.ts:6|之后每小时清一次|const INTERVAL_MS = 3_600_000;
CLAIM|18|一致|apps/agent-service/src/production-http-composition.ts:1844|不管想一想有没有开|thinkRetention.start();
CLAIM|19|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:588|只删同时满足这些条件的对话：`origin = 'think'`|WHERE t.owner_id = ? AND t.agent_id = ? AND t.origin = 'think' AND t.status = 'open'
CLAIM|20|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:593|没有还没结束的运行|AND r.status NOT IN ('completed', 'failed', 'cancelled'))
CLAIM|21|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:595|没有生效中的定时任务|AND j.status = 'active')
CLAIM|22|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:590|已归档且归档满保留天数|AND ((t.archived_at IS NOT NULL AND t.archived_at <= ?)
CLAIM|23|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:591|或者一直没归档、最后更新满保留天数加一天|OR (t.archived_at IS NULL AND t.updated_at <= ?))
CLAIM|24|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:501|选出之后、真删之前，在删除的事务里按同样的条件再查一遍，不满足就跳过|if (this.#expiredThinkThreadIds(current, input, objectId).length === 0) {
CLAIM|25|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:474|删除用 `SqliteGovernedDeletionAdapter.deleteExpiredThinkThreads`|async deleteExpiredThinkThreads(input: {
CLAIM|26|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:465|和停服务时的永久删除共用同一套删除步骤|return await this.#deleteOpen(database, input.objectType, objectId);
CLAIM|27|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:722|删除记录也照样留|this.#upsertTombstone(database, next, "incomplete", null);
CLAIM|28|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:962@08f181e5496275a5f75936598b7e510a8d21ee16|另外补删了原先漏掉的标题载荷 `threads.title_ref`|"SELECT metadata_ref FROM threads WHERE id = ? AND metadata_ref IS NOT NULL",
CLAIM|29|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:491|它不拿状态目录锁，另开一个数据库连接|const database = this.#database();
CLAIM|30|一致|apps/agent-service/src/production-think-retention.ts:64|上一轮没删完的（例如加密文件删除失败），下一轮先补完|const retried = await this.#options.deletion.retryIncompleteThreadDeletions({ limit: BATCH });
CLAIM|31|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:552|补删前在删除的事务里查一遍这个编号的对话还在不在，还在就跳过|if (current.prepare("SELECT 1 FROM threads WHERE id = ?").get(objectId)) {
CLAIM|32|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:541|补删只收尾对话行已经删掉、删除记录还停在“未完成”的删除|AND d.status = 'incomplete' AND d.purge_deadline_at <= ?
CLAIM|33|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:542|补删只收尾对话行已经删掉、删除记录还停在“未完成”的删除|AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = d.object_id)
CLAIM|34|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:540|包括主人永久删除后没删完的加密文件|WHERE d.owner_id = ? AND d.agent_id = ? AND d.object_type = 'thread'
CLAIM|35|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:588|主人和客户端建的、还在的对话一律不碰|WHERE t.owner_id = ? AND t.agent_id = ? AND t.origin = 'think' AND t.status = 'open'
CLAIM|36|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:474|服务运行时多了一条真删数据的路径|async deleteExpiredThinkThreads(input: {
CLAIM|37|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:588|它只认 `origin = 'think'`，不接受客户端传来的任何字段|WHERE t.owner_id = ? AND t.agent_id = ? AND t.origin = 'think' AND t.status = 'open'
CLAIM|38|一致|apps/agent-service/src/production-think-retention.ts:63|想一想对话最多留“保留天数加一天”再加一小时左右|const activeBefore = new Date(now - (days + 1) * DAY_MS).toISOString();
CLAIM|39|一致|apps/agent-service/src/production-think-retention.ts:60|改小天数后，下一轮清理就会删掉已到期的|const days = await this.retentionDays();
CLAIM|40|一致|test/integration/think-runner.test.ts:609|回归测试在 `test/integration/think-runner.test.ts`|it("deletes a finished thinking thread and everything it holds once the kept days pass, and nothing else", async () => {
CLAIM|41|一致|test/integration/think-runner.test.ts:712|主人的旧对话不删|"thread:think:owner-made",
CLAIM|42|一致|test/integration/think-runner.test.ts:757|运行中的想一想对话不删|expect(sql("SELECT id FROM threads WHERE id = ?", thinkId)).toHaveLength(1);
CLAIM|43|一致|test/integration/think-runner.test.ts:698|有生效定时任务的不删|expect(await retention.runOnce()).toBe(0);
CLAIM|44|一致|test/integration/think-runner.test.ts:702|未到期的不删|expect(await retention.runOnce()).toBe(0);
CLAIM|45|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:849|让清理走主人删除的网关命令：那条路在服务运行时只标 `deletion_pending`，真删要停服务|const target = input.mode === "trash" ? "trashed" : "deletion_pending";
CLAIM|46|一致|packages/application/src/services/product-thread-gateway-adapter.ts:746|凭编号前缀 `thread:think:` 判断是不是想一想对话：客户端可以自己指定这样的编号|threadId: createThreadId(command.payload.threadId),

未能核对的部分：Andy 2026-11-15 的项目聊天原话（cmsg_01EE1hey9cboYNfwFnBv5dgrDs6moWVTLBrHyMTxWzj99b）、ChatGPT“临时对话”保留 30 天的外部政策，以及“主人很少回头看原文”“被删后无法找回、提议本身不受影响”这类产品判断。
