**本轮核对范围**：`git diff 26d4dc43..09c43290` 的增量（提交 `7025b0165`、`0c19fbd45`、`4afeba28c`、`09c432909`），重点读了 `packages/persistence-sqlite/src/sqlite-governed-deletion.ts`、`test/integration/think-runner.test.ts`、`docs/adr/0277-the-system-deletes-expired-think-threads.md`、`docs/architecture-v0.1.md`，并跟到使用端 `apps/agent-service/src/production-think-retention.ts`、`production-http-composition.ts`、`apps/admin-cli/src/index.ts`、`#deleteCore`/`#threadPayloadRefs` 和 `threads` 表结构。评测文件目录是稀疏检出，`.agents/reviews` 记录读不到；未运行测试，结论按代码推演。

**上一轮意见核对**
- 意见 1：已改好。`retryIncompleteThreadDeletions` 现在把“线程还在就冲突”的检查放进了 `#deleteOpen` 的 `.transaction(...).immediate()`（`sqlite-governed-deletion.ts:551-559`、`:700-725`），发现同编号对话还在时事务回滚、跳过，tombstone 保持 `incomplete`。新增用例确实模拟了“查询之后、删除事务之前重建”的时序，断言线程还在、tombstone 仍是 `incomplete`（`think-runner.test.ts:791-797`）。
- 意见 2：已按文档修好。ADR 0277 第 48-49 行和架构文档第 437 行都写明补删会收尾“主人永久删除后没删完的加密文件”，并把“一律不碰”限定为“还在的对话”，与代码一致。

### 1. 中 — 被重建的线程虽然躲过补删，仍可能被管理员的 `delete.purge-expired` 当成过期删除目标永久删掉
文件：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:551-559`、`:749-781`、`:456-472`、`:879-931`；`apps/admin-cli/src/index.ts:671-687`

问题：增量新增的“重建就跳过”只在补删路径生效。跳过之后留下 `status='incomplete'` 的 tombstone；旧的 `purgeExpiredTrash` 仍会把所有 `pending/incomplete` tombstone 交给 `deleteImmediately`，而 `deleteImmediately` 走 `#deleteOpen` 时不传 `stillEligible`，会直接删掉同编号的线程行。

证据（读代码证实）：
```ts
// retryIncompleteThreadDeletions：发现重建就跳过，tombstone 留在 incomplete
if (current.prepare("SELECT 1 FROM threads WHERE id = ?").get(objectId)) {
  throw new GovernedDeletionError(GOVERNED_DELETION_ERROR_CODES.CONFLICT, ...);
}
...
if (error.code === GOVERNED_DELETION_ERROR_CODES.CONFLICT) continue;
```
```ts
// purgeExpiredTrash
WHERE status IN ('pending', 'incomplete') AND purge_deadline_at <= ?
...
reports.push(await this.deleteImmediately(entry));
```
```ts
// deleteImmediately 没有重查线程是否存在
return await this.#deleteOpen(database, input.objectType, objectId);
...
database.prepare("DELETE FROM threads WHERE id = ?").run(objectId);
```
`delete.purge-expired` 需要确认串，但 `asOf` 由操作者给，通常是当前时间，而这类 tombstone 的 `purge_deadline_at` 是当初删除/补删失败的时间，所以会被选中。

推测部分：这需要管理员在服务停止后执行 `delete.purge-expired`；不是自动路径，所以定为中而不是高。但后果是不可撤销地删掉一个仍存在的、可能是主人新建的对话（以及它的消息和运行）。

建议：让 `purgeExpiredTrash` 对线程 tombstone 也做存在性/来源检查，例如线程行存在且状态不是 `trashed` 时跳过（或对 `lifecycle='deletion_pending'` 的 tombstone 复用同一个 `stillEligible`）；只保留“确实在回收站里”的线程被批量清除。并加一条用例：补删因重建跳过之后，`purgeExpiredTrash` 不得删掉重建的线程。

### 2. 低 — 新回归用例把“重建”绑在 `#now()` 的调用次数上，实现稍变就可能变成空转仍通过
文件：`test/integration/think-runner.test.ts:775-797`；`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:544`、`:616`

问题：用例靠 `clockReads === 2` 在第二次读时钟时插入重建的线程。当前第一次 `#now()` 在补删的初始 SELECT，第二次在 `#deleteOpen` 开头，刚好落在事务检查之前。但以后只要在初始 SELECT 之前多一次 `#now()`，插入就会发生在 SELECT 之前，初始查询因 `NOT EXISTS (SELECT 1 FROM threads ...)` 直接排除该 tombstone，补删返回空、线程和 `incomplete` tombstone 都还在，用例仍然通过，却没有再测到事务内复查。

证据：
```ts
let clockReads = 0;
now: () => {
  clockReads += 1;
  if (clockReads === 2)
    sql(`INSERT INTO threads (...) VALUES (...)` ...);
  return now;
},
...
expect(await recreating.retryIncompleteThreadDeletions({ limit: 50 })).toEqual([]);
expect(sql("SELECT id FROM threads WHERE id = ?", thinkId)).toHaveLength(1);
```
这属于测试健壮性问题，不是当前产品行为错误；去掉 `stillEligible` 时该用例现在确实会失败（删除重建行后返回非空报告，断言失败）。

建议：把重建注入点改成不依赖内部读时钟次数，例如增加一个测试专用回调/钩子，或在用例里记录“注入确实发生”的布尔值并断言；至少注明这条用例与调用顺序耦合。

### 3. 低 — 跳过重建线程后，旧删除留下的待删加密文件可能长期无人清理
文件：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:551-559`、`:1391`、`:348`；`docs/adr/0277-the-system-deletes-expired-think-threads.md:48`

问题：旧删除失败时，payload 行已在核心事务里删掉，但 `pendingPayloadFiles` 只记录在 tombstone 里，真正删文件在 `#deletePayloadFiles`。补删因“线程还在”跳过后，这些文件不会被处理；如果同编号的对话一直存在（例如是主人新建的对话），这些旧的加密文件就成了永久孤儿。ADR 只写“还在就跳过”，没写这个代价。我未找到自动清扫孤儿载荷文件的路径，`ciphertext-file-store.inspect` 只报告 `orphans`，不删除。

证据：
```ts
for (const file of record.pendingPayloadFiles) { ... await rm(file, { force: true }); }
```
```ts
// trashObject 用新记录覆盖 tombstone 时清空旧待删文件
pendingPayloadFiles: Object.freeze([]),
```
读代码证实前一点；后一点说明若之后管理员把重建线程放进回收站，旧的待删文件列表还会被覆盖掉。严重度低，因为只在“旧删除失败 + 同编号重建”这种窄场景出现。

建议：在 ADR 里写明这个取舍，或增加一个安全条件（确认新线程不引用这些旧 ref 后）清理旧文件。至少不要让文档读起来像旧删除一定会在下一轮补完。

**侧重检查**
- 错误路径：CONFLICT 只在事务内、写 tombstone 之前抛出；抛错会导致事务回滚，旧 `incomplete` tombstone 不被改写。非 CONFLICT 错误照常向上抛，数据库在 `finally` 关闭。已核对 `#deleteOpen` 的三个调用方均已适配。
- 不可信输入 / 安全：补删的线程编号来自数据库，仍经过 `safeIdentity`；`limit` 校验 1..500，SQL 全部参数绑定；新增检查使用同一条连接和 `BEGIN IMMEDIATE`，并发写入不能插到检查和删除之间。管理员批量清除路径的缺口见意见 1。
- 资源耗尽：每轮补删最多 50 条，新删除最多 20×50=1000 条；没有无界循环。旧孤儿文件的长期占用见意见 3。
- 规则/文档/代码一致性：ADR 0277 和架构文档关于“补删包含主人永久删除残留、还在的对话跳过、事务内复查”的描述与代码一致；`threads.title_ref` 已加入 `#threadPayloadRefs`（`:1106-1110`），并由 `think-runner.test.ts:690、705` 覆盖；作者说“加了对应测试”“ADR 背景改成不讲历史的说法”均属实。
- 未核实：未运行测试；未重读与本次增量无关的 `scripts/delivery-mode`、想一想设置等前几轮代码。

**必答问题**

1. **请求开头**：不涉及。增量只删已结束、已归档的 `origin='think'` 对话并清理删除记录，不碰提示词组装、系统提示、工具定义、历史消息或遮盖。新产生的 `now()` 只写进 tombstone 的时间字段，不发给模型；被删线程的 prompt bundle 只属于该隐藏线程。发给模型的内容仍只在末尾追加，没有把每轮变化的值加进头部。
2. **相同文字变不同字节**：不涉及。增量没有改模型的序列化、JSON 键顺序、集合顺序或遮盖规则；tombstone 的 `status`、时间只是存储值。
3. **自动检查**：有。`test/integration/think-runner.test.ts` 新增了“查询后被重建、补删要跳过”的用例，去掉事务内检查时该用例会因返回非空报告和线程被删而失败；另有一条既有的“选中后变成忙碌”用例覆盖 `deleteExpiredThinkThreads` 的事务内复查。弱点是新用例依赖 `#now()` 调用次数（见意见 2）。
4. **值的直接使用端**：`retryIncompleteThreadDeletions` 的签名和返回类型未变，直接使用端 `ThinkThreadRetention`（`production-think-retention.ts:18-20、64-65`）和 `production-http-composition.ts:1287-1288` 都能接受；跳过冲突时返回空报告，调用方按 `lifecycle` 统计 `incomplete`，不会误报失败。新增的 `incomplete` tombstone 状态还有 `purgeExpiredTrash` 这个直接使用端没有应用同样的校验，见意见 1；`threads.title_ref` 的产生端（`#threadPayloadRefs`）与消费端（`#deleteUnreferencedPayloadRows`/`#deletePayloadFiles`）及测试一致。
