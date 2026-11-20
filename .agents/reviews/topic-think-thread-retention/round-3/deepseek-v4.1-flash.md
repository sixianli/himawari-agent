CLAIM|1|一致|docs/architecture-v0.1.md:437|“想一想”每想一件事就开一个后台对话（下文叫“想一想对话”）。|每取一条，先问 Jev，值得才开一次后台运行：`production-think-runner.ts` 新开一个对话 `thread:think:<编号>`
CLAIM|2|一致|docs/architecture-v0.1.md:437|这些对话是 Himawari 自己琢磨用的。|每取一条，先问 Jev，值得才开一次后台运行：`production-think-runner.ts` 新开一个对话 `thread:think:<编号>`
CLAIM|3|一致|apps/agent-service/src/production-think-runner.ts:231|结论会进提议箱。|return await this.#propose(parsed, entry, id.threadId);
CLAIM|4|一致|packages/persistence-sqlite/src/migrations/20261115045512_thread_origin.sql:3|PR 558 已经把它们标成 `threads.origin = 'think'`。|UPDATE threads SET origin = 'think'
CLAIM|5|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:1437|并从所有列表里藏起来。|const conditions = ["owner_id = ?", "agent_id = ?", "origin = 'owner'", lifecycle];
CLAIM|6|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:2031|并从搜索里藏起来。|"current_thread.origin = 'owner'",
CLAIM|7|一致|packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:657|并从推送里藏起来。|WHERE hidden.id = runs.thread_id AND hidden.origin = 'think')
CLAIM|8|一致|packages/persistence-sqlite/src/data-export/chats.ts:117|并从导出里藏起来。|AND status IN ('open', 'trashed') AND origin = 'owner'
CLAIM|9|一致|packages/persistence-sqlite/src/sqlite-memory-operations.ts:1707|并从记忆摘要里藏起来。|AND t.origin = 'owner'
CLAIM|10|找不到|-|在这个决定之前，没有任何程序删这些对话。|-
CLAIM|11|找不到|-|它们会一直留在数据库和加密文件里。|-
CLAIM|12|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:849|主人发起的“永久删除”在服务运行时只把对话改成 `deletion_pending`，并不真删。|const target = input.mode === "trash" ? "trashed" : "deletion_pending";
CLAIM|13|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:849|`packages/persistence-sqlite/src/sqlite-thread-operations.ts` 里的原文是 `const target = input.mode === "trash" ? "trashed" : "deletion_pending";`。|const target = input.mode === "trash" ? "trashed" : "deletion_pending";
CLAIM|14|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:461|真删数据的 `SqliteGovernedDeletionAdapter.deleteImmediately` 要求服务已停并拿到状态目录锁。|const lock = await this.#lock();
CLAIM|15|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:792|`packages/persistence-sqlite/src/sqlite-governed-deletion.ts` 里的原文是 “Governed deletion requires stopped services and an exclusive state-root lock”。|"Governed deletion requires stopped services and an exclusive state-root lock",
CLAIM|16|一致|apps/agent-service/src/production-think-runner.ts:196|想一想对话记 `origin = 'think'`。|origin: "think",
CLAIM|17|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:553|想一想对话在建对话的同一个事务里记 `origin = 'think'`。|const transaction = this.database.transaction(() => {
CLAIM|18|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:547|客户端经网关建的对话一律是 `owner`。|thread.origin ?? "owner",
CLAIM|19|一致|docs/architecture-v0.1.md:437|即使编号以 `thread:think:` 开头也还是 `owner`。|（主人和客户端建的对话一律是 `owner`，客户端自己挑一个 `thread:think:` 开头的编号也还是 `owner`）
CLAIM|20|一致|docs/architecture-v0.1.md:437|见 `docs/architecture-v0.1.md` 里“想一想”的运行那一段。|**“想一想”的运行（2026-11-15，ADR 0274）**
CLAIM|21|一致|packages/application/src/ports/configuration.ts:434|新设置项 `threadRetentionDays`，1 到 90，默认 7。|{ key: "threadRetentionDays", unit: "days", minimum: 1, maximum: 90, defaultValue: 7 },
CLAIM|22|一致|packages/application/src/ports/configuration.ts:434|`threadRetentionDays` 是想一想的第 11 个可改设置。|{ key: "threadRetentionDays", unit: "days", minimum: 1, maximum: 90, defaultValue: 7 },
CLAIM|23|一致|apps/agent-service/src/production-think-retention.ts:60|每次清理都现读，改了天数，已有对话也按新天数算。|const days = await this.retentionDays();
CLAIM|24|一致|apps/agent-service/src/production-think-retention.ts:34|`apps/agent-service/src/production-think-retention.ts` 的 `ThinkThreadRetention`。|export class ThinkThreadRetention {
CLAIM|25|一致|apps/agent-service/src/production-think-retention.ts:106|在服务启动后先清一次。|tick();
CLAIM|26|一致|apps/agent-service/src/production-think-retention.ts:107|之后每小时清一次。|this.#timer = setInterval(tick, this.#options.intervalMs ?? INTERVAL_MS);
CLAIM|27|一致|apps/agent-service/src/production-http-composition.ts:1844|不管想一想有没有开。|thinkRetention.start();
CLAIM|28|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:569|只删 `origin = 'think'` 的对话。|WHERE t.owner_id = ? AND t.agent_id = ? AND t.origin = 'think' AND t.status = 'open'
CLAIM|29|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:574|没有还没结束的运行。|AND r.status NOT IN ('completed', 'failed', 'cancelled'))
CLAIM|30|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:576|没有生效中的定时任务。|AND j.status = 'active')
CLAIM|31|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:571|已归档且归档满保留天数。|AND ((t.archived_at IS NOT NULL AND t.archived_at <= ?)
CLAIM|32|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:572|一直没归档、最后更新满保留天数加一天。|OR (t.archived_at IS NULL AND t.updated_at <= ?))
CLAIM|33|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:501|选出之后、真删之前，在删除的事务里按同样的条件再查一遍，不满足就跳过。|if (this.#expiredThinkThreadIds(current, input, objectId).length === 0) {
CLAIM|34|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:474|删除用 `SqliteGovernedDeletionAdapter.deleteExpiredThinkThreads`。|async deleteExpiredThinkThreads(input: {
CLAIM|35|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:465|和停服务时的永久删除共用同一套删除步骤。|return await this.#deleteOpen(database, input.objectType, objectId);
CLAIM|36|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:684|删除记录也照样留。|this.#upsertTombstone(database, base, "incomplete", null);
CLAIM|37|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:962@08f181e5496275a5f75936598b7e510a8d21ee16|另外补删了原先漏掉的标题载荷 `threads.title_ref`。|"SELECT metadata_ref FROM threads WHERE id = ? AND metadata_ref IS NOT NULL",
CLAIM|38|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:491|它不拿状态目录锁，另开一个数据库连接。|const database = this.#database();
CLAIM|39|一致|apps/agent-service/src/production-think-retention.ts:64|上一轮没删完的（例如加密文件删除失败），下一轮先补完。|const retried = await this.#options.deletion.retryIncompleteThreadDeletions({ limit: BATCH });
CLAIM|40|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:849|让清理走主人删除的网关命令：那条路在服务运行时只标 `deletion_pending`，真删要停服务。|const target = input.mode === "trash" ? "trashed" : "deletion_pending";
CLAIM|41|一致|test/integration/think-runner.test.ts:418|客户端可以自己指定 `thread:think:` 这样的编号。|const lookAlike = "thread:think:client-chosen" as never;
CLAIM|42|一致|apps/agent-service/src/production-http-composition.ts:1844|服务运行时多了一条真删数据的路径。|thinkRetention.start();
CLAIM|43|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:569|它只认 `origin = 'think'`，不接受客户端传来的任何字段。|WHERE t.owner_id = ? AND t.agent_id = ? AND t.origin = 'think' AND t.status = 'open'
CLAIM|44|一致|test/integration/think-runner.test.ts:609|回归测试在 `test/integration/think-runner.test.ts`。|it("deletes a finished thinking thread and everything it holds once the kept days pass, and nothing else", async () => {
CLAIM|45|一致|test/integration/think-runner.test.ts:711|主人的旧对话不删。|expect(sql("SELECT id FROM threads").map((row) => row["id"])).toEqual([
CLAIM|46|一致|test/integration/think-runner.test.ts:756|运行中的想一想对话不删。|expect(await racing.deleteExpiredThinkThreads(input)).toEqual([]);
CLAIM|47|一致|test/integration/think-runner.test.ts:693|有生效定时任务的不删。|VALUES ('job:think-hold', ?, ?, ?, 0, 'active', 'auth:test', 'owner-old-text')
CLAIM|48|一致|test/integration/think-runner.test.ts:702|未到期的不删。|expect(await retention.runOnce()).toBe(0);

未核实：第 10、11 条无法穷尽证明基线里没有任何其他删除路径（只能确认基线没有 `production-think-retention.ts`，也没有 `deleteExpiredThinkThreads`）；项目聊天里的 Andy 原话不在仓库中，未核对。
