**本轮范围**

- 只看增量 `09c4329..1a1eb67`：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts`、`test/integration/sqlite-governed-deletion.test.ts`，并跟到 `trashObject`、`deleteImmediately`、`#deleteOpen`、`purgeExpiredTrash`、`retryIncompleteThreadDeletions` 的调用链。
- 使用端查了 `apps/admin-cli/src/index.ts:663-695`、`apps/agent-service/src/production-think-retention.ts:59-79`、`packages/persistence-sqlite/src/sqlite-thread-operations.ts` 的线程创建/删除状态，以及 `threads.status` 的 schema 取值。
- `.agents` 评审记录在本次 sparse checkout 中不可读（工具拒绝 records-path），未读；未运行测试，结论来自静态代码。

**上一轮意见核对**

- 意见 1（重建线程被 `purge-expired` 删掉）：无活动任务的简单路径已修好。`purgeExpiredTrash` 现在对 thread 先查 `status != 'trashed'`，命中就抛 `CONFLICT` 并 `continue`；旧代码会直接调用 `deleteImmediately` 删掉重建线程，新用例 `:813` 在旧代码上会失败。但修复不完整，见下面第 1、3 条。
- 意见 3（旧删除遗留的待删加密文件无人清理）：没有修好，反而在新路径上更明确，见第 2 条。
- 作者说“用同一幂等键重建的新对话”与代码不一致，见第 4 条。

**侧重检查**

- 错误路径：`purgeExpiredTrash` 对 thread 的 `stillEligible` 检查发生在活动任务检查之后，活动任务会先抛错，`live` 仍为 `false`，导致整个 purge 失败；见第 3 条。
- 不可逆操作：跳过重建线程后旧墓碑仍保留过期 `purge_deadline_at`，重建线程再进回收站会继承过期时间，可能立即永久删除、且无法 restore；见第 1 条。
- 不可信输入：`objectId` 仍在进入删除前过 `safeIdentity`，本轮没有新增未校验的输入。
- 资源耗尽：旧删除的 `pendingPayloadFiles` 在重建线程再进回收站时被清空，旧加密文件失去唯一记录；见第 2 条。被跳过的旧墓碑也会被每次 purge 重新扫描并开启写事务。
- 规则/文档一致：ADR 0277 和架构文档说“同编号对话还在就跳过”，代码只在 `status != 'trashed'` 且没有活动任务时做到；文档说普通删除进入 7 天 Trash，但重建线程的 Trash 可能继承旧截止时间。

### 1. 中 — 被跳过的重建线程再进回收站会继承旧墓碑的过期时间，可能立即被永久删除且无法恢复

`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:345`、`:783-804`、`:402-407`；`test/integration/sqlite-governed-deletion.test.ts:20`、`:257`、`:823-833`

问题：`purgeExpiredTrash` 发现对话还在且不是 `trashed` 时直接 `continue`，不更新也不清除旧墓碑。之后用户把这个重建对话移入回收站时，`trashObject` 仍复用旧墓碑的截止时间：

```ts
purgeDeadlineAt: previous?.purgeDeadlineAt ?? deadline,
```

旧墓碑若是永久删除留下的，`purgeDeadlineAt` 在 `#deleteOpen` 里是当时的 `now`（`:638`），通常已经过去。于是重建线程刚进回收站就已经“过期”：`restoreObject` 会直接拒绝：

```ts
if (Date.parse(current.purgeDeadlineAt) <= Date.parse(now)) {
  throw new GovernedDeletionError(
    GOVERNED_DELETION_ERROR_CODES.CONFLICT,
    `${input.objectType} Trash retention has expired`,
```

随后的 `purgeExpiredTrash` 也会立即把它永久删除，而不是保留 7 天。新用例在 `:823` 移入回收站、`:831` 立即 purge，但没有断言新的 `purgeDeadlineAt`，且 fixture 的 `now: () => T0`、`T8` 比 T0 和 T0+7 天都晚，所以继承旧截止和重新给 7 天都会被这个用例放过。

建议：跳过 live 线程时同时处理旧墓碑：删除或重置 `purge_deadline_at`；更稳妥的是只在 `previous.lifecycle === 'trashed'` 时继承截止时间和关联字段，否则按新 Trash 重新计算。测试需要可推进的时钟，断言重建线程进回收站后 `purgeDeadlineAt = 进回收站时间 + 7 天`，且下一毫秒 purge 返回空、restore 成功。

### 2. 低 — 旧删除遗留的待删加密文件在被跳过、随后重新进回收站时丢掉记录，长期无人清理

`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:348`、`:355`；`test/integration/sqlite-governed-deletion.test.ts:805-833`

问题：第一次删除在 payload 文件阶段失败时，旧墓碑的 `pendingPayloadFiles` 是唯一记得那个加密文件的地方。重建线程再进回收站时，`trashObject` 无条件把它清空并覆盖墓碑：

```ts
pendingPayloadFiles: Object.freeze([]),
...
this.#upsertTombstone(database, next, "pending", null);
```

之后 `#deleteOpen` 的 `previous.pendingPayloadFiles` 为空，而重建线程里已经没有被删掉的旧消息/旧 payload 行，`#deleteCore` 再也收集不到那个文件路径。文件本身还在：`#deletePayloadFiles` 在 `:1427` 先触发 fault，随后才遍历文件，所以故障注入时文件没被删。新用例也没有检查 `resource.payloadFile` 或墓碑里的文件清单，无法挡住这个回归。

建议：`trashObject` 遇到同 id 的旧未完成删除时不要无条件清空 `pendingPayloadFiles`/`targets`；先尝试清完旧文件，或把清单保留到新墓碑/独立的重试记录。新增测试断言最终 purge 后 `resource.payloadFile` 不存在，或旧文件清单被清空。

### 3. 低 — 重建线程仍有活动任务时不会被跳过，`delete.purge-expired` 会整条失败

`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:623-629`、`:699-702`、`:801-804`

问题：`#deleteOpen` 先检查活动任务，再进入事务调用 `stillEligible`：

```ts
if (activeTaskIds.length > 0) {
  throw new GovernedDeletionError(
    GOVERNED_DELETION_ERROR_CODES.CONFLICT,
    "Active tasks must be resolved before permanent Thread deletion",
...
const prepared = database.transaction(() => {
  stillEligible?.(database);
```

如果重建线程是 `open` 且绑定了活动任务，`#deleteOpen` 会在 `stillEligible` 之前抛 `CONFLICT`，此时 `live` 仍是 `false`，`purgeExpiredTrash` 的 catch 会重新抛出，导致整个 `delete.purge-expired` 失败、后面的过期项也不处理，而不是按作者说的“对话还在就跳过”。新用例先暂停了 `task-delete`，也没有在重建线程上创建新的活动任务，所以没覆盖这个反向场景。

建议：把 live/eligible 检查放到 `#deleteOpen` 最前面（活动任务检查之前），或在 `purgeExpiredTrash` 里用同一把锁先在同一事务内查对话状态；catch 也应按错误码/上下文判断，不要依赖 `live` 变量。补一个“重建线程 + 活动任务”的用例，断言 purge 返回空而不是抛错。

### 4. 低 — 作者说“用同一幂等键重建”，但 `thread.create` 的同一幂等键重放会直接报找不到

`packages/persistence-sqlite/src/sqlite-thread-operations.ts:554-564`；`packages/application/src/ports/threads.ts:30-36`

问题：作者和测试描述的重建场景是“用同一幂等键重建的新对话”，但 `thread.create` 的重放路径会先找到旧 receipt，再读线程；线程已被永久删除时直接失败：

```ts
const replay = this.replay(... "thread.create" ...);
if (replay) {
  const thread = this.read(input.thread.ownerId, input.thread.agentId, replay.threadId);
  if (!thread) this.fail("PORT_NOT_FOUND", "Replayed Thread no longer exists");
```

实际能重建同 id 线程的路径是调用方用新的幂等键、复用同一个 `thread.id`（`ThreadCreateInput.thread` 是调用方给出的完整 `ProductThread`），或者像测试那样直接写库。测试用直接 `INSERT` 绕过了这层语义，不能证明“同一幂等键重建”真的成立。

建议：修正 brief/ADR 的措辞；如果确实需要同一幂等键重建，则要改重放逻辑并补真实 repository 路径的测试；否则测试应通过新的幂等键和同一 thread id 走 `create`，或用产品层命令构造重建。

**读代码证实的**

- `purgeExpiredTrash` 的 skip 分支不写墓碑；`trashObject` 会复用 `previous.purgeDeadlineAt`、`previous.associatedTaskIds` 和 `previous.priorProductStatus`。
- `trashObject` 会清空 `pendingPayloadFiles` 并覆盖旧墓碑；旧密码文件在 payload fault 时不会被删。
- `#deleteOpen` 的活动任务检查在 `stillEligible` 之前；`purgeExpiredTrash` 只在 `live === true` 时吞错。
- 新用例在旧代码上确实会失败：旧代码会删除重建线程，`:813` 的 `[]` 和 `:814` 的线程数 1 不成立。
- `deleteImmediately` 的调用路径仍是 `safeIdentity -> #deleteLocked -> #deleteOpen`，没有绕过校验；其他对象类型在 purge 中的行为不变。

**推测/未核实**

- 真实客户端是否会在永久删除后复用同一个 thread id 重建，未核实；代码允许调用方自带 id，但实际 UI/API 的 id 生成方式没查。
- 生产是否定期运行 `delete.purge-expired`、以及管理员实际使用频率，未核实。
- 未运行测试，测试是否在完整环境中通过未核实；`.agents` 评审记录未读。
- 多 owner/agent 共用同一数据库时的墓碑隔离未核实在本轮范围之外；本轮没有把它当作增量问题。

**必答问题**

1. **不涉及。** 增量只改离线 SQLite 删除适配器和测试，不构造系统提示、工具定义、历史消息或遮盖结果；没有改变任何发给模型的内容。`.agents/instructions/prompt-prefix.md` 在本次 sparse checkout 中不存在，未读，但增量文件范围足以判断它与请求前缀无关。
2. **不涉及模型请求的字节。** 删除墓碑的 `record_json` 里有 `updatedAt` 和由 `Set` 去重的数组（`#upsertTombstone`、`unique`），但这些只写 `deletion_tombstones`，不进入模型请求。没有发现增量改变“同一段文字在不同请求里的字节”。
3. **有自动检查，但反向覆盖不全。** `test/integration/sqlite-governed-deletion.test.ts:783` 新增用例，旧代码会在 `:813/:814` 失败，能挡住“重建线程被 purge 直接删掉”的主路径。没覆盖：重建线程有活动任务时错误地整条失败（第 3 条）；重建线程再进回收站后 7 天期限是否重置（第 1 条）；旧 `pendingPayloadFiles` 里的加密文件是否最终删除（第 2 条）。第 1 条的现有测试因为时钟固定为 T0、`T8` 晚于两种截止时间，实际上无法区分“继承旧截止”和“重新给 7 天”。
4. **没有新增导出的函数、配置键、字段或序列化格式。** `#deleteLocked`、`#threadStillGone` 都是私有方法。`purgeExpiredTrash` 的调用端只有 `apps/admin-cli/src/index.ts:687`（把 `reports.length` 当 `purgedCount`）和测试；返回类型没变，跳过的 live 线程不出现在 reports 里，符合 `purgedCount` 的语义。`deleteImmediately` 的调用端（`apps/admin-cli/src/index.ts:741` 及其他测试）仍走同一 `safeIdentity -> #deleteLocked -> #deleteOpen`，行为不变。`retryIncompleteThreadDeletions` 继续在 `:560-565` 吞掉 `CONFLICT`，`#threadStillGone` 重构保持原来的“线程行还在就跳过”谓词。未发现两端校验不一致的新值。
