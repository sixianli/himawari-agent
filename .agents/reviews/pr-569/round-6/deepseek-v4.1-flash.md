## 本轮查过的范围

- 对比了 `d5ae1fec..75c1e02` 和增量 `6329267..75c1e02`。PR 569 自己在增量里只有 `117631f88` 改了 `docs/adr/0277-the-system-deletes-expired-think-threads.md:48` 一句；其余是第 6 轮复核记录和 `04904ecf0` 从 origin/main 带入的 PR 540/564/567/568 等文件。合入 main 的其他 PR 代码不在 PR 569 复核范围，本轮没有重读。
- 读了 ADR 0277、`configuration.ts`、`production-think-retention.ts`、`sqlite-governed-deletion.ts` 的删除/恢复/补删/回收站清理路径、`think-runner.test.ts` 的标题载荷断言、`schema-catalog.ts`、`data-export/chats.ts`、迁移 0015。
- `git log --no-merges 6329267..75c1e02 -- apps/agent-service packages/application/src/ports/configuration.ts packages/persistence-sqlite/src/sqlite-governed-deletion.ts test/integration/sqlite-governed-deletion.test.ts test/integration/think-runner.test.ts` 为空，`git diff 6329267..75c1e02` 对这些文件也为空。**因此三条低意见没有被修改。** 材料开头说“作者已修改”与仓库不符；作者自己写的“不修”才与代码一致。

## 侧重检查

- **错误路径**：`deleteExpiredThinkThreads` 校验日期和 limit（`sqlite-governed-deletion.ts:488-499`），补删校验 limit（`:537-542`），`purgeExpiredTrash` 校验 asOf（`:751-758`）；删除中冲突按跳过处理（`:519-526`）。仍有一个错误路径问题，见意见 3。
- **不可信输入**：thread id 都过 `safeIdentity`（`:506`、`:557`、`:781`）；保留清理只认 `origin = 'think'` 和服务端算出的期限（`:589-597`），不接受客户端字段。
- **安全**：payload 文件路径由 `#safePayloadFile` 拒绝绝对路径、`..` 和反斜杠（`:1405-1424`）；停服务永久删除要求状态目录锁（`:847-854`），保留清理明确不加锁但另开连接（`:500-501`），与该功能只处理系统自建想一想对话的边界一致。
- **资源耗尽 / 不可逆操作**：保留清理每轮最多 20×50=1000 条（`production-think-retention.ts:4-5,67-76`）；想一想删除是真删，恢复只在回收站期限内（`sqlite-governed-deletion.ts:404-409`）。低意见 1、2 造成的是孤儿密文长期留在磁盘。
- **规则/说明与代码一致**：ADR 0277 第 45、46、48、49 行抽查与 `configuration.ts:434`、`production-think-retention.ts:59-79,90-108`、`sqlite-governed-deletion.ts:483-575,786-822` 一致；本轮改动的“删除步骤也会删标题载荷”与 `#threadPayloadRefs` 的 `title_ref` 查询（`:1146-1150`）一致。
- 作者说的“ADR 23 条全部一致”没有逐条复核；相关复核记录在 `.agents/reviews` 下，被 sparse-checkout 排除，读不到（未核实）。

## 意见

### 1. 低 — 恢复回收站里的对话仍会丢掉旧待删密文清单，孤儿文件从此无人清理（上一轮意见 1，未修）

文件: `packages/persistence-sqlite/src/sqlite-governed-deletion.ts:340-341, 436-447`

问题: `restoreObject` 恢复时删除 tombstone，而 `pendingPayloadFiles` 只存在于 tombstone 记录里，恢复返回的对象不会把它写回任何持久化位置。之后同一编号的对话被重建再进回收站时，`trashObject` 只能从 `previous` 取清单，此时为空，之前失败删除留下的密文文件不会再进 `#deletePayloadFiles`。

证据（读代码证实）:

```ts
341: const pendingPayloadFiles = Object.freeze([...(previous?.pendingPayloadFiles ?? [])]);
...
437: database.prepare("DELETE FROM deletion_tombstones WHERE id = ?").run(current.deletionId);
439-447: return Object.freeze({ ...current, lifecycle: "active", targets: ...保留... , updatedAt: now });
```

建议: 恢复时把旧 `pendingPayloadFiles` 转入一个可追踪的待清理位置，或恢复事务里先尝试删除这些文件；补一个“失败删除 → 重建 → 恢复 → 再删除”的用例断言文件最终被清掉。

### 2. 低 — 已验证删除的 tombstone 仍保留已删文件清单，重建后再进回收站会重复上报和重复删除（上一轮意见 2，未修）

文件: `packages/persistence-sqlite/src/sqlite-governed-deletion.ts:715-719, 738-747, 340-341`

问题: 删除成功并转为 `deleted_verified` 后，记录里的 `pendingPayloadFiles` 没有清空。重建同一编号的对话再进回收站时，`trashObject` 无条件从旧 tombstone 复制这份清单，导致 `payloadFileCount` 把已经删掉的文件算进去，purge 时又对这些不存在的文件执行一次 `rm`。

证据（读代码证实）:

```ts
715-719: pendingPayloadFiles: Object.freeze(unique([...base.pendingPayloadFiles, ...core.pendingPayloadFiles])),
         payloadFileCount: unique([...base.pendingPayloadFiles, ...core.pendingPayloadFiles]).length,
738-741: const finalRecord: StoredDeletionRecord = Object.freeze({
           ...afterArtifacts,
           lifecycle: verified ? "deleted_verified" : "deletion_pending",
...
341: const pendingPayloadFiles = Object.freeze([...(previous?.pendingPayloadFiles ?? [])]);
```

建议: 验证完成时清空 `pendingPayloadFiles`；或让 `trashObject` 只从 `lifecycle === "trashed"` 的 tombstone 继承清单。补一条“验证删除 → 重建 → 进回收站”的用例断言清单为空。

### 3. 低 — 回收站里仍关联生效任务的对话会让整批 `delete.purge-expired` 失败（上一轮意见 3，未修）

文件: `packages/persistence-sqlite/src/sqlite-governed-deletion.ts:620-632, 786-807`

问题: `purgeExpiredTrash` 对 thread 的 `stillEligible` 只检查状态是否仍为 `trashed`；如果对话确实还在回收站但关联了生效中的定时任务，`#deleteOpen` 的 active-task 检查会抛 `CONFLICT`，而 catch 只在 `live === true`（即对话已不在回收站）时跳过，于是异常被重新抛出，整批清理中断。

证据（读代码证实）:

```ts
620-632: const activeTaskIds = ... WHERE thread_id = ? AND status = 'active' ...
         if (activeTaskIds.length > 0)
           throw new GovernedDeletionError(CONFLICT,
             "Active tasks must be resolved before permanent Thread deletion", ...);
...
792-800: if (current.prepare("SELECT 1 FROM threads WHERE id = ? AND status != 'trashed'").get(objectId)) {
             live = true;
             throw new GovernedDeletionError(CONFLICT, "Thread is no longer in Trash", ...);
...
804-807: } catch (error) {
           if (live) continue;
           throw error;
         }
```

建议: 把 active-task 冲突也当作可跳过（或在查询阶段排除有关联 active 任务的对话），并补一条“仍在回收站且有关联 active 任务时 purge 跳过而不是抛错”的用例。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本轮增量只改 ADR 一句话，删除/保留代码、配置和测试都没有改动（`git diff 6329267..75c1e02` 对这些文件为空）。删除的是整个 `origin = 'think'`、到期的非活动对话，不修改系统提示、工具定义、历史消息或出口遮盖；没有新增每轮会变的值。发给模型的内容仍然只在末尾追加，会变的值仍应只放在最后一条消息里。本轮没有重新审计整个 PR 的所有 prompt 路径，前几轮已复核过。
2. **不会让同一段文字在不同请求里变成不同字节。** 增量没有改遮盖、序列化、时间字段或集合顺序；删除用的 `now` 只进删除期限/tombstone，不进模型输入。
3. **增量本身没有自动检查。** ADR 这句话的改动不会有测试失败。标题载荷删除有正向断言 `test/integration/think-runner.test.ts:705`（删除后 `payloads` 里没有 `think-title`）；如果从 `#threadPayloadRefs` 去掉 `title_ref`，按断言推断该用例会失败，但本轮没有运行测试。三条低意见都没有对应测试：`9580a90c1` 的用例覆盖了重建对话的新回收站期限和保留待删文件，没有覆盖“恢复丢清单”“验证删除后再进回收站”“仍在回收站的对话带 active task”这三种路径。
4. **增量没有产生或修改新的代码值。** 唯一涉及的是 ADR 对 `threads.title_ref` 的描述：产生处是 `sqlite-governed-deletion.ts:1148` 的 `SELECT title_ref`，删除端是 `#deleteUnreferencedPayloadRows`（`:1353-1371`），迁移 0015 的 `ON DELETE SET NULL` 会让列变 NULL；使用端 `data-export/chats.ts:91-92,352-357` 的 `optionalString`、`sqlite-thread-operations.ts:342` 的可空字段、`schema-catalog.ts:242-244` 的“随 Thread 删除并重建”都能接受 NULL。合入 main 带入的其他配置键（如 `scripts/disk-hygiene/retention.json`、`scripts/repo-hygiene/config.json`）属于其他 PR，本轮未逐个核对（未核实）。

## 推测与未核实

- “反向用例会失败”是根据断言推断的，本轮没有运行任何测试。
- 作者说的“ADR 23 条全部一致”没有逐条复核；复核记录读不到（sparse-checkout 排除了 `.agents/reviews/`）。
- 低意见 3 的可达性没有在正常 API 路径上重新确认：`trashObject` 本身会拒绝有关联 active 任务的对话进入回收站（`:313-319`），该状态可能来自其他写路径、导入或直接改库；`9580a90c1` 的测试也是用直接 SQL 造出来的。但代码层面一旦出现该状态，确实会让整批 purge 抛出。
- 合入 main 的 PR 540/564/567/568 代码没有重新复核。
