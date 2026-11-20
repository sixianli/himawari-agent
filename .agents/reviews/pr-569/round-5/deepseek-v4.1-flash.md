本轮对照 `git diff 1a1eb67..6329267` 只看到 `packages/persistence-sqlite/src/sqlite-governed-deletion.ts`（13 行）和 `test/integration/sqlite-governed-deletion.test.ts`（+70 行），其余是复核记录。我读了增量两处代码、它们所在的 `trashObject`/`#deleteOpen`/`restoreObject`/`purgeExpiredTrash`/`#deletePayloadFiles`/`#threadPayloadRefs` 全貌，并顺线核对了 `#storedRecord`、`#upsertTombstone`、`pendingPayloadFiles`/`payloadFileCount`/`purgeDeadlineAt` 的使用端、`ContentAddressedCiphertextStore`、`ci/policy.json` 的 integration 收集范围，以及 [prompt-prefix.md](.agents/instructions/prompt-prefix.md)、[I-73](docs/incidents-and-gates.md#incidents) 和 ADR 0277。测试没有运行（工具限制只允许读和 git 查询），反向用例结论是按代码推出来的。

### 1. 低 — 恢复回收站中的“重建对话”会丢掉刚保留下来的旧待删密文记录，孤儿文件从此无人清理
文件:行：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:341-350`、`:436-438`、`:1427-1461`
问题：第 4 轮意见 2 只修好了“重建后再进回收站、再等到期清除”这一条路径。若旧删除在 payload 目标失败（`pendingPayloadFiles` 非空）、对话被重建、主人再把它移入回收站、随后又点恢复，`restoreObject` 会直接删掉整条 tombstone，把 `pendingPayloadFiles` 一并丢掉；恢复后的对话再次删除时已没有旧记录可继承，旧密文永久留在 `data/payload-ciphertext` 下。
证据：`const pendingPayloadFiles = Object.freeze([...(previous?.pendingPayloadFiles ?? [])]);` 把旧文件带进 `trashed` 记录；但恢复事务里只有 `database.prepare("DELETE FROM deletion_tombstones WHERE id = ?").run(current.deletionId);`，没有删除这些文件；`#deletePayloadFiles` 只从记录里的 `pendingPayloadFiles` 取文件。我又搜过整个仓库，`pendingPayloadFiles` 只被这个适配器消费，`ContentAddressedCiphertextStore.inspect` 只报告 orphans，没有自动清理作业。
建议：恢复前先处理 `current.pendingPayloadFiles`（这些文件属于旧的那次删除，对应 payload 行已不存在，删除它们不会影响恢复出来的对话），或把它们转存到独立的待清理队列；补一条“失败删除→重建→进回收站→恢复”的用例。

### 2. 低 — 已验证删除的记录仍保留待删文件列表，重建后再进回收站会把已删文件当作待删文件上报并重复删除
文件:行：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:1427-1461`、`:738-747`、`:341-350`
问题：`#deletePayloadFiles` 成功后返回的记录仍带着原 `pendingPayloadFiles`，`finalRecord` 也原样保留，所以 `deleted_verified` 的 tombstone 里往往仍有非空文件列表。增量在 `trashObject` 里不区分旧 lifecycle 直接复制这份列表，于是“永久删除成功→重建→进回收站”的新记录会报告 `payloadFileCount > 0`，到期清除时再对早已不存在的文件做一次 `rm`。正常情况下 `rm(..., {force:true})` 无害，但这条新路径把“已验证删除成功”的旧路径重新当成待删文件。
证据：成功分支 `return Object.freeze({ ...record, targets: ... });` 未清空 `pendingPayloadFiles`；`finalRecord` 只是 `{ ...afterArtifacts, lifecycle: verified ? "deleted_verified" : "deletion_pending" }`；进回收站时 `payloadFileCount: pendingPayloadFiles.length`。新用例 `test/integration/sqlite-governed-deletion.test.ts:868-902` 正是“验证删除成功→重建→进回收站”，但只断言了截止时间和恢复，没有断言 `payloadFileCount`。
建议：payload 目标变成 `verified` 时清空 `pendingPayloadFiles` 并把 `payloadFileCount` 置 0；或者只从 `deletion_pending`/`incomplete` 的旧记录继承文件列表。若要保留路径供审计，至少不要把已成功删除的路径算进 `payloadFileCount`。另外在读取 `record_json` 后再次用 `#safePayloadFile` 校验路径，避免直接信任持久化内容。

### 3. 低 — 仍在回收站且有关联活动任务的对话仍会让整批 `delete.purge-expired` 失败（第 4 轮意见 3 只覆盖“已被重建”的对话）
文件:行：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:619-632`、`:786-807`
问题：新增的提前检查只有在 `threads.status != 'trashed'` 时才会抛 `CONFLICT` 并被 purge 跳过。如果对话仍在回收站（`status = 'trashed'`）却又存在 `status = 'active'` 的任务，提前检查放行，随后 620-632 行的活动任务检查抛 `CONFLICT`，此时 `live` 仍是 `false`，`catch` 会重新抛出，整条 purge 仍然失败，而不是跳过这一条。
证据：提前回调的条件是 `SELECT 1 FROM threads WHERE id = ? AND status != 'trashed'`；活动任务检查在它之后，失败时 `live` 没有置位，`catch (error) { if (live) continue; throw error; }`。
建议：把活动任务 `CONFLICT` 也当作单条跳过（或在报告里记一条失败目标），不要让它中断整批；给“仍在回收站 + 活动任务”补一条用例。该状态如何产生我未核实：服务端 `requestDeletion` 只在无活动任务时允许进回收站，我也没有找到能把任务重新绑到回收站对话上的路径，所以现实中可能只能由手工改库或竞态产生。

### 4. 低 — 增量改了“仍在回收站时重复进回收站”的行为，但没有对应的自动用例
文件:行：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:340-354`；`test/integration/sqlite-governed-deletion.test.ts:785-866`、`:868-902`
问题：`stillTrashed` 不只影响“重建后的对话”，也改变了“对仍在回收站的记录再次执行 `trashObject`”的行为：现在会保留原截止时间、`associatedTaskIds` 和 `priorProductStatus`，而旧代码会重算。新增的两个用例覆盖的是旧 lifecycle 为 `deletion_pending`/`deleted_verified` 的路径，没有覆盖“仍为 `trashed` 时再次进回收站”这一分支，也没有覆盖“带着待删文件恢复后是否清理”。
证据：测试里两次 `trashThread("thread-delete")` 之间都夹着一次永久删除或失败删除（`785-866`），另一个用例是验证删除后再重建（`868-902`），没有一个用例在第一次 `trashThread` 后直接再调一次。
建议：补一条“同一对话连续两次进回收站”的用例，断言 `purgeDeadlineAt` 不变、task/Memory 的 `priorProductStatus` 仍能恢复原状态，并补一条“带 `pendingPayloadFiles` 的回收站记录恢复后文件被清理/记录被保留”的用例。

**侧重检查**
- 错误路径：重点看了 `purgeExpiredTrash` 的 `live` 跳过逻辑和 `#deleteOpen` 的提前检查；发现意见 3 的修复只覆盖“已不在回收站”的重建对话（上面第 3 条）。
- 不可信/不合规输入：`safeIdentity` 在入口校验 objectId；但 `#storedRecord` 对 `record_json` 只做 `JSON.parse` 后强转，`pendingPayloadFiles` 的路径读取时不再走 `#safePayloadFile`，增量又把这份持久化列表复制进新的 `trashed` 记录。正常写入都经过 `#safePayloadFile`（`:1368`），所以当前数据可信；但“读取时重新校验”是更稳的防线（第 2 条建议）。
- 安全/隐私与不可撤销操作：永久删除仍会 `rm` 文件；恢复丢记录会让旧密文成为无法追溯的孤儿（第 1 条）。没有发现新的越权删除或路径穿越。
- 资源耗尽：`pendingPayloadFiles` 复制没有重新 `unique`，但上游 `#deleteOpen` 每次都会 `unique` 合并，规模受该对象的 payload 文件数限制；没有新增无界循环。
- 规则/文档一致性：改动不碰提示词、工具定义、历史或遮盖，[prompt-prefix.md](.agents/instructions/prompt-prefix.md) 的要求不涉及；ADR 0277 说“补删前在删除的事务里查一遍这个编号的对话还在不在”，增量保留事务内检查、又加了事务外提前检查，不矛盾；架构文档对 7 天 Trash 的描述也没有被改变。
- 使用端核对：`pendingPayloadFiles` 只被 `#deletePayloadFiles`（`:1431`）和 `#publicReport`（`:1509`，剥离）使用；`payloadFileCount` 只进 `GovernedDeletionReport`/admin-cli JSON；`purgeDeadlineAt` 被 SQL 字符串比较和 `restoreObject` 的 `Date.parse` 使用；`associatedTaskIds`/`priorProductStatus` 被 task/Memory 恢复和报告使用；`stillEligible` 是私有参数，三个调用方（purge/retry/think）与 `#deleteOpen` 的签名一致。没有配置键、清单项或数据库 schema 变化。

**读代码证实的**
- 第 4 轮意见 1 已修好：`stillTrashed` 只在旧记录 lifecycle 为 `trashed` 时继承 `purgeDeadlineAt`/`associatedTaskIds`/`priorProductStatus`，重建对话会拿到新的 7 天截止时间。
- 第 4 轮意见 2 在“再进回收站→到期清除”路径上已修好：旧 `pendingPayloadFiles` 会被带入并在最终 purge 时删除，新用例 `:785-866` 的 `ENOENT` 断言覆盖了这一点。
- 第 4 轮意见 3 在“重建对话 + 活动任务”场景已修好：提前检查在活动任务检查之前执行，回调抛 `CONFLICT` 时 `live=true`，purge 会跳过该条。
- 正常单次进回收站、恢复、到期清除行为不变：`previous` 为空时新截止时间、空待删列表、按当前状态算 `associatedTaskIds`/`priorProductStatus`，与旧代码一致；恢复仍删除 tombstone；purge 对仍在回收站的正常对话仍照常删除。
- `test/integration/sqlite-governed-deletion.test.ts` 被 `ci/policy.json:197-198` 的 integration 项目以 `test/integration/**/*.test.ts` 收集。
- 整个增量不涉及模型请求组装，`pendingPayloadFiles` 等值只进本地删除记录，不进入系统提示、工具定义、历史或遮盖。

**推测/未核实**
- “仍在回收站 + 活动任务”是否能在真实产品路径中产生（第 3 条）：我未核实；服务端 Trash 和 rebind 路径看起来都不允许，可能只能手工改库或竞态。
- 第 2 条里“旧待删路径恰好指向后来导入/恢复的活文件”的破坏性场景是推测：密文按内容寻址，只有完全相同的密文（同一 nonce）才会复用同一路径，概率极低；但导入旧备份确实可能带回同一密文文件。
- 测试未运行，反向用例是否真的失败是按旧代码逐行推断的。

**必答问题**
1. 不涉及，不会改变模型已经见过的请求开头。增量只改离线删除适配器和测试；没有触碰系统提示、工具定义、历史消息、遮盖或任何请求组装代码。发给模型的内容仍然只会在末尾追加、每轮变化的值仍应在最后一条消息里；被 Trash/永久删除的对话本就不进入上下文，重建对话是新对象，不会重写已发请求的历史。
2. 不涉及模型请求。新增/复制的集合只写入本地 `deletion_tombstones.record_json`，不会被序列化进任何模型请求；因此不会让同一段文字在不同模型请求里变成不同字节。顺带一提，这份本地记录的集合没有显式排序保证，但它不进入模型输入，不影响缓存。
3. 有自动检查，但覆盖不完整。新增/修改的用例在 `test/integration/sqlite-governed-deletion.test.ts`，由 integration 项目收集；按旧代码推断：`T7` 截止时间断言会在旧代码失败、`purgeExpiredTrash(T8)` 在重建对话有活动任务时会抛 `CONFLICT` 而不是返回 `[]`、待删文件 `ENOENT` 断言会在旧代码失败，所以这三条反向用例是有效的（本次未实际运行）。缺口是第 4 条说的“仍为 trashed 时重复进回收站”和“带 pending 文件恢复”没有用例，第 3 条那种“回收站 + 活动任务”也没有用例。
4. 直接使用端都能接受，但有两个读取端问题。`pendingPayloadFiles` 的产生端是 `:341`（从旧记录复制）和 `:715`（与 `#deleteCore` 结果 `unique` 合并），使用端只有 `#deletePayloadFiles`（`:1431` 的 `lstat`/`rm`）和 `#publicReport`（`:1509` 剥离）；两端都按绝对路径字符串处理，格式没有变化，但 `:341` 复制时没有重新校验路径（见第 2 条建议）。`payloadFileCount` 只在报告/admin-cli 输出里使用，类型是 number，没有额外校验；`purgeDeadlineAt` 的消费端是 `purgeExpiredTrash` 的 SQL 比较和 `restoreObject:404` 的 `Date.parse`，新的 ISO 字符串都能接受；`associatedTaskIds`/`priorProductStatus` 由恢复逻辑和报告消费，类型未变；`stillEligible` 是私有回调，三个调用方的签名一致。没有配置键、清单项或 schema 变化需要同步。
