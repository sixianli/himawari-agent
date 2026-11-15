## 结论范围

这一轮我只复核增量，也就是 4d12029b..26d4dc43 之间的改动，重点是 PR 自己的提交 8db852d2（删除重查、补删、诊断回调）和 b1cb5d5a（ADR 0277、文档、测试）：

- `packages/persistence-sqlite/src/sqlite-governed-deletion.ts`
- `apps/agent-service/src/production-think-retention.ts`
- `apps/agent-service/src/production-http-composition.ts`
- `test/integration/think-runner.test.ts`
- `docs/adr/0277-the-system-deletes-expired-think-threads.md`、`docs/architecture-v0.1.md` 的相关段落
- 同时对照了 `0001_initial_product_schema.sql` 里 `deletion_tombstones`、`threads`、`runs`、`scheduled_jobs` 的定义，以及线程创建/删除路径（`sqlite-thread-operations.ts`、`thread-command-service.ts`）。

合并提交 f70183345 没有改动上述删除/保留相关文件（已用 `git diff f70183345^1..f70183345 -- <这些文件>` 确认无输出），因此增量里其他文件属于 main，不是本 PR 的改动，我没有重读。**我没有实际运行测试**，反向用例的结论是按代码推断的。逐项判定上一轮 1、2、6：第 1 条的到期重查已真正放进 `IMMEDIATE` 事务；第 2 条的载荷残留已能靠补删继续处理；第 6 条的诊断回调已不会把错误带进 `stop()`。下面只列这一轮发现的问题。

### 1. 中 — 补删只在批量查询时确认“线程行已不存在”，删除事务里不再复查，同编号的新对话可能被当成旧删除补完而永久删掉

文件:行：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:537-551`、`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:681-706`、`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:862-865`、`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:906-912`

问题：`retryIncompleteThreadDeletions` 先在自动提交的 SELECT 里挑出“线程行已不存在”的未完成删除记录，然后在之后的循环里逐条调用 `#deleteOpen`。但 `#deleteOpen` 的删除事务没有像 `deleteExpiredThinkThreads` 那样传入 `stillEligible` 复查；而 `#deleteCore` 只要 `previous !== undefined`（补删时恒为真）就会删除**当前存在的同名线程**。如果在这批 SELECT 与某一条 `#deleteOpen` 之间，有写入把同一 `id` 的线程重新建出来，补删会把它当作旧删除的重试，连同新的消息、运行（包括未结束的运行）和载荷一起永久删除，且不再检查 `origin`、未结束运行和定时任务。

读代码证实的证据：

```
537  const incomplete = this.#values(
538    database,
539    `SELECT d.object_id FROM deletion_tombstones d
540    WHERE d.owner_id = ? AND d.agent_id = ? AND d.object_type = 'thread'
541      AND d.status = 'incomplete' AND d.purge_deadline_at <= ?
542      AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = d.object_id)
543    ORDER BY d.requested_at, d.id LIMIT ?`,
...
547  for (const threadId of incomplete)
548    reports.push(
549      await this.#deleteOpen(database, "thread", safeIdentity(threadId, "thread ID")),
550    );
```

```
685  const core = this.#deleteCore(database, input.objectType, objectId, previous !== undefined);
```

```
862  .prepare("SELECT id FROM threads WHERE id = ? AND owner_id = ? AND agent_id = ?")
...
864  if (!thread && !retry) this.#failNotFound(objectType, objectId);
865  if (thread) {
...
906  database.prepare("DELETE FROM runs WHERE thread_id = ?").run(objectId);
912  database.prepare("DELETE FROM threads WHERE id = ?").run(objectId);
```

对照：同一提交给 `deleteExpiredThinkThreads` 加了事务内复查：

```
500  await this.#deleteOpen(database, "thread", objectId, (current) => {
501    if (this.#expiredThinkThreadIds(current, input, objectId).length === 0) {
...     throw new GovernedDeletionError(CONFLICT, "Think thread is no longer eligible ...")
```

线程创建路径不查 `deletion_tombstones`（`sqlite-thread-operations.ts:522-548` 直接 `INSERT INTO threads`），且删除时会清掉 `command_results`，所以客户端复用同一 `threadId`（含同一幂等键）在删除后重新建对话是允许的。

推测：触发需要“未完成的线程删除记录 + 线程行已不存在 + 在这轮补删的某一条之前重建了同一 id 的对话”。窗口很窄，但后果是不可撤销地把一个可能正在运行的对话整份删掉；数量多时，前一条的载荷文件 I/O 会拉长这个窗口。且补删处理的是所有线程删除记录，不只想一想，所以主人对话也在这个范围内。

建议：在补删的每一条事务里加与 `deleteExpiredThinkThreads` 同构的复查（例如 `NOT EXISTS (SELECT 1 FROM threads WHERE id = ?)`），线程行重新出现就跳过；并用一个独立的哨兵错误，避免和别的 `CONFLICT` 混在一起。补一条测试：批量选完之后、删之前把同一 id 的线程插回去，断言它存活。

### 2. 低 — 补删不区分来源，会补完非想一想线程的未完成删除，与 ADR/架构“只对想一想对话成立”的字面表述不一致

文件:行：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:539-544`、`docs/adr/0277-the-system-deletes-expired-think-threads.md:49`、`docs/architecture-v0.1.md:437`

问题：补删的查询只按 `object_type = 'thread'`、`status = 'incomplete'`、线程行不存在来挑，没有任何“这条删除来自想一想保留清理”的标记，也不可能有（线程行已删，查不到 `origin`）。因此它也会补完离线时主人永久删除失败留下的未完成记录。ADR 和架构写的是“只对系统自己建的想一想对话成立，主人和客户端建的对话一律不碰”，字面上与实现不符。

读代码证实：查询条件见上（无 origin/think 过滤）。文档原文：

```
ADR 0277:49 这是“永久删除要主人确认”的一个例外，只对系统自己建的想一想对话成立。……主人和客户端建的对话一律不碰……
architecture:437 ……只对系统自己建的想一想对话成立，主人和客户端建的对话一律不碰。
```

推测：实际危害有限——能进入补删的记录，线程行已经被删掉，说明之前的永久删除（主人授权或系统清理）已经完成到“删行”这一步，补删只是收尾删加密文件，不是在未授权地新删主人对话。但这是一条文档没有覆盖的、会删主人对话载荷文件的路径。

建议：要么在删除记录里存一个“由想一想保留清理发起”的标记并在补删时校验，要么把 ADR/架构改成“补删会补完任何线程行已不存在的未完成线程删除（含离线主人删除的收尾）”，并把这条路径归属到更中性的维护组件。

### 3. 低 — 补删没有逐条错误隔离，一条记录抛错会让整轮清理失败并跳过本轮的主删除循环

文件:行：`apps/agent-service/src/production-think-retention.ts:59-80`、`apps/agent-service/src/production-think-retention.ts:90-115`、`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:546-551`

问题：`runOnce` 先 `await retryIncompleteThreadDeletions(...)`，没有任何 try/catch；`retryIncompleteThreadDeletions` 的循环也没有逐条 catch。只要其中一条 `#deleteOpen` 抛出非预期错误，整个 `runOnce` 失败，后面的 `deleteExpiredThinkThreads` 本轮完全不会执行；`tick` 只写一条 `think.retention_failed`，下一轮要等一小时。相比之下，`deleteExpiredThinkThreads` 至少对 `CONFLICT` 逐条 `continue`。

读代码证实的证据：

```
64  const retried = await this.#options.deletion.retryIncompleteThreadDeletions({ limit: BATCH });
...
68  const reports = await this.#options.deletion.deleteExpiredThinkThreads({...});
```

```
547  for (const threadId of incomplete)
548    reports.push(
549      await this.#deleteOpen(database, "thread", safeIdentity(threadId, "thread ID")),
550    );
```

推测：可触发的非预期错误包括：老版本留下的 `record_json IS NULL` 的 `thread` 删除记录（`#storedRecord` 返回 `undefined`，`retry` 变成 false，线程行又不存在，`#deleteCore` 在 `:864` 抛 `NOT_FOUND`）、数据库忙超时、`record_json` 形状不合法等。是否已有这种遗留数据我未核实。

建议：补删循环里对每条记录单独 try/catch，失败计入 `think.retention_incomplete` 诊断并继续，不要让一条坏记录挡住整轮主删除；测试里加一条“某条补删抛错时其余补删和主删除照常进行”。

### 4. 低 — `runOnce` 的返回值仍把载荷删除失败（`deletion_pending`）计为“已删”

文件:行：`apps/agent-service/src/production-think-retention.ts:73-79`、`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:714-727`

问题：载荷文件删除失败的删除会返回 `lifecycle: "deletion_pending"`，但 `runOnce` 用 `deleted += reports.length` 把它算进“已删”；现在虽然同时会发 `think.retention_incomplete` 诊断，返回值本身仍把未完成当成功。上一轮第 2 条里“这次清理会被当成已删除”的后半句只被诊断部分补上。

读代码证实：

```
73  deleted += reports.length;
74  incomplete += reports.filter((report) => report.lifecycle !== "deleted_verified").length;
...
719  lifecycle: verified ? "deleted_verified" : "deletion_pending",
```

`runOnce` 的返回值目前没有生产调用方使用（`start()` 忽略它），所以影响只是语义/未来误用。

建议：`deleted` 只统计 `deleted_verified`，把 `deletion_pending` 单独计数（诊断里已有），或在接口上改名成“处理条数”。

## 侧重检查

- **错误路径与不可信输入**：补删的 `limit` 有 1..500 校验；SELECT 按 `owner_id/agent_id` 限域；`object_id` 走 `safeIdentity`（线程 id 本身由 `createThreadId` 限制为 ≤128 字符，能过 256 的校验）。但补删循环没有逐条错误隔离（意见 3）。
- **并发**：`deleteExpiredThinkThreads` 的复查确实在 `database.transaction(...).immediate()` 内（`:681-706`），能阻止“选中后新起运行/新挂 active 定时任务”的穿插，上一轮第 1 条已改好。补删没有等价的事务内复查（意见 1）。
- **不可撤销操作/安全**：补删会 `rm` 载荷文件并删线程行；路径来自删除记录里的 `pendingPayloadFiles`，这些是首次删除时 `#safePayloadFile` 解析过的受管绝对路径，补删不再重跑校验，依赖数据库记录可信。没有新的客户端输入进入补删。主要风险是意见 1 的误删。
- **资源耗尽**：补删每次最多 50 条、逐条串行、`busy_timeout=5000`；没有无界循环。坏记录会每小时重复并让整轮失败（意见 3）。
- **规则/文档一致性**：ADR 0277 位于 `docs/adr/0277-...`，架构里的 `[ADR 0277](adr/0277-...)` 链接可解析；ADR 第 3、4 条与 `deleteExpiredThinkThreads` 的重查、补删代码基本一致；但“只对想一想对话成立”与补删实际范围不一致（意见 2）。
- **上一轮意见对应**：第 1 条已改好（事务内复查运行/定时任务）；第 2 条的“残留文件可补删”已改好，“被当成已删除”的返回值语义仍有残留（意见 4）；第 6 条已改好（`#diagnose` 同时用于 `runOnce` 和 `tick` 的 catch，`stop()` 不会收到拒绝）。
- **未核实**：没有执行任何测试；没有查线上/历史数据库里是否真有 `record_json IS NULL` 的 `thread` 删除记录；没有重读合并进来的 main 文件（送达时机等）——它们不属于本 PR。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不涉及。这次改的是服务端到期删除、删除记录补删、诊断和文档，没有碰系统提示、工具定义、历史消息、遮盖或请求组装；没有任何发给模型的内容被改动，因此也就不存在“只在末尾追加、每轮变化值都在最后一条消息里”的问题。
2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及。改动不产生模型输入；新增的 `think.retention_incomplete`/`think.retention_failed` 诊断只写服务日志（`writeServiceDiagnostic` 会加日志时间戳，但不进模型请求）。
3. **有没有对应的自动检查，反向用例会不会真的失败？** 有新增测试：`test/integration/think-runner.test.ts` 覆盖了“选中后变成 busy 的想一想对话不删”（`:743-758`）、“载荷删除失败后下一轮补删成功”（`:760-798`）、“清理和诊断都抛错时 `stop()` 仍正常”（`:800-816`），以及标题载荷删除、active 定时任务挡住、未归档多等一天（`:679-704`）。按代码推断：去掉事务内复查会让 `:756` 期望删除 0 变成删 1 而失败；去掉补删会让 `:792-797` 的 `verified`/空诊断断言失败；去掉 `#diagnose` 的 catch 会让 `:815` 失败。**但我没有实际运行测试**。缺口：没有测试“补删过程中同 id 线程被重建”（因为实现没有这道复查）、没有测试“补删不碰线程行仍在的记录”、没有测试“补删某条抛错时其余继续”。
4. **改动产生或修改的每个值，使用端都能接受吗？** 逐个核对：新方法 `retryIncompleteThreadDeletions` 的直接使用端只有 `production-http-composition.ts:1287-1288` 和 `think-runner.test.ts`，两处都传 `{ limit }`，实现校验 1..500；`ThinkRetentionReport.lifecycle` 用 `string`，生产实现返回的 `GovernedDeletionReport["lifecycle"]` 是含 `"deleted_verified"` 的联合类型，赋值为 `string` 兼容，保留代码也用同一个字面量比较；诊断 `think.retention_incomplete` 带 `count: String(incomplete)`，`service-main.ts:3377-3378` 的 `writeServiceDiagnostic` 接受 `Record<string, string>`；补删 SQL 用到的 `requested_at`、`id`、`object_id`、`object_type`、`status`、`purge_deadline_at`、`owner_id`、`agent_id` 都在 `deletion_tombstones` 表里且非空；没有新增配置键、迁移或序列化格式。唯一语义问题是 `runOnce` 返回值把 `deletion_pending` 计入“已删”（意见 4），但它目前没有生产使用端。
