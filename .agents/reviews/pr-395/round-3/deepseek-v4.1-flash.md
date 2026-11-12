## 结论

### 高：先写 `undone_revision` 再 `revise`，失败时会把别人的一次写入误判成“已撤销”

- 文件:行：`packages/memory-engine/src/conversation-review.ts:56-61`
- 问题：撤销前先把 `undone_revision` 写成 `memory.revision + 1`，但 `revise` 可能失败（版本冲突、投影失败、进程中断）。失败后这个“预期版本号”留在库里，之后只要这条记忆被任何人推进到恰好 `R+1`，`isReviewChangeUndone` 就只比较版本号，会把它当成已经撤销，直接跳过；整批仍会走到 `markUndone`。
- 证据（亲自读到的代码）：

```ts
// conversation-review.ts:56-61
const expected = memory.revision + 1;
await options.store.markChangeUndone({
  reviewId: review.id,
  memoryId: memory.id,
  undoneRevision: expected,
});
```

```ts
// packages/application/src/ports/memory-conversation-review.ts:89-98
export function isReviewChangeUndone(change, memory): boolean {
  return (
    memory !== undefined &&
    change.undoneRevision !== null &&
    memory.revision === change.undoneRevision   // 只看版本号，不看实际状态
  );
}
```

```ts
// sqlite-memory-conversation-review-operations.ts:282-287
UPDATE ... SET undone_revision = ?
WHERE review_id = ? AND memory_id = ? AND after_revision IS NOT NULL
  AND after_revision < ?
// 不检查记忆当前状态，也不要求之后必须成功 revise
```

具体时间线（读代码可证）：计划时记忆为 `R`（`after_revision = R`）→ 预写 `undone_revision = R+1` → `revise(expectedRevision = R)` 因别人已经把记忆写到 `R+1` 而抛 `PORT_CONFLICT`（`durable-memory-service.ts:339-345`、`sqlite-memory-operations.ts:814-824`）→ 下次撤销看到 `memory.revision === R+1 === undoneRevision`，跳过这条，随后 `markUndone` 成功。结果是：`created` 的新记忆仍是 `active` 没有被归档；`superseded` 的旧记忆仍保持被取代，而批次显示“已撤销”。如果别人那次写入只是编辑旧记忆内容，甚至可能出现新记忆被归档、旧记忆仍指向已归档新记忆的状态。
- 建议：不要提前落最终标记。二选一：
  1. 把“写回记忆”和“标记 `undone_revision`”放进同一个数据库事务（新增端口方法）；
  2. 保留预写，但 `isReviewChangeUndone` 必须同时核对动作对应的实际状态：`created` → `status === "archived"`；`superseded` → `supersededBy`/`validTo` 等于 `before*`；`confirmed` → `tentative === true`，并且版本只能是 `afterRevision` 或 `afterRevision + 1`。状态不符时不得跳过，应当重试或报锁。
  另需补一条反向用例：`revise` 因版本冲突失败、记忆恰好被推进到 `R+1` 后，下一次撤销不得把它当成已改回。ADR 0231 第 82 行“撤销中途失败可以接着做”目前说得过满，也应同步修正。

---

### 中：`applyProposal` 补做 `supersedes` 会取代不该取代的记忆

- 文件:行：`packages/application/src/services/durable-memory-service.ts:136-142`、`:540-554`
- 问题：同一 create 提案已存在且 `status === "active"` 时无条件补做 `supersede`。但“active”不等于“仍是当前有效记忆”：被取代的记忆也保持 `status === "active"`，只是 `attributes.supersededBy` 非空。`supersede()` 只检查被取代方（target），不检查替代方（replacement）是否已经被别人取代。
- 证据（亲自读到的代码）：

```ts
// durable-memory-service.ts:136-142
if (sameProposal) {
  if (existing.status === "active") {
    await this.proposeProjection(existing, "upsert", generationId);
    if (proposal.supersedes)
      await this.supersede(proposal.supersedes, existing, generationId);
  }
  return existing;
}
```

```ts
// durable-memory-service.ts:545-554
const current = await this.options.state.read(memoryId);
if (
  !current ||
  current.id === replacement.id ||
  current.status !== "active" ||
  current.ownerId !== replacement.ownerId ||
  current.agentId !== replacement.agentId ||
  (current.attributes?.supersededBy ?? null) !== null
)
  return;
```

读代码可证的路径：回看第一次尝试已经创建了新记忆并把旧记忆标为取代，但在 `#settle` 记录前中断；主人随后把旧记忆恢复（`supersededBy` 变回 `null`，版本号加 1）。下一次回看开始时 `#settle` 看到旧记忆“没有被取代”，会把待定的 superseded 行丢弃（`production-memory-conversation-review.ts:870-885`）；随后 `#plan`/`#commit` 重新看到旧记忆是 active，`unchanged` 只比较本次运行的两次读取（`:765-771`），于是再次走到 `applyProposal`，把主人刚恢复的旧记忆重新取代。主人的恢复（以及中途对旧记忆内容的编辑）被静默覆盖。ADR 0231 第 77 行“回看期间主人改过的记忆跳过”只覆盖同一次运行内的版本变化，不覆盖跨重试。
另一个代码级缺口：替代方 `existing` 可能自己已经被别人取代（`attributes.supersededBy !== null`），代码仍会用它去取代 target，形成“用一条已失效记忆取代另一条记忆”的链。
- 建议：
  - `supersede()` 增加 `replacement.status === "active"` 且 `(replacement.attributes?.supersededBy ?? null) === null` 的检查；
  - 补做取代时，要求本次回看仍存在对应的待定 superseded 行，且 target 的当前版本仍等于该行记录时的版本；不要只凭“同一条 create 提案存在”就补做；
  - 把 `supersedes` 纳入 `sameProposal` 的同一性比较（或把首次实际采用的 supersedes 记在记忆上），避免同一 create 提案以不同取代目标再次到达时取代另一条记忆。当前 `sameProposal` 比较字段见 `:126-135`，确实没有 `supersedes`。
- 推测部分：正常每轮抽取首次写入不会命中 `sameProposal`，所以副作用主要发生在重试/重放，而不是首次抽取。`contentRef` 由 `generationId:candidateOrdinal` 固定、内容已存在时直接复用（`production-memory-capture.ts:488-490`、`:587-600`），所以重新抽取即使文字不同也可能被判为同一提案；这条路径是否真的发生取决于重试时机，未运行验证。

---

### 低：`#settle` 的新判断没有对应的自动检查/反向用例

- 文件:行：`apps/agent-service/src/production-memory-conversation-review.ts:854-887`；测试：`test/integration/memory-conversation-review.test.ts:538-614`
- 问题：本轮新增的测试覆盖了“撤销改回后中断”“新记忆已存时补做取代”“删记忆时删改动行”，但没有一条覆盖 `createdHere.has(supersededBy)` 的正反两面：被别处取代（`supersededBy` 不在本批 created 行里）时应丢弃 superseded 行；被本批新建记忆取代时应记录。删除触发器测试针对的是更早提交里已有的 trigger，不是 `#settle` 改动。
- 证据（亲自读到的代码）：

```ts
// production-memory-conversation-review.ts:858-860, 873-878
const createdHere = new Set<string>(
  all.filter(({ action }) => action === "created").map(({ memoryId }) => memoryId),
);
...
(change.action === "superseded"
  ? supersededBy !== null && createdHere.has(supersededBy)
  : memory.attributes?.tentative !== true));
```

- 建议：补一条“旧记忆被本批之外的新记忆取代”的用例，断言 superseded 行被丢弃；再补一条“被本批 created 记忆取代”的用例，断言记录 `afterRevision`。去掉 `createdHere` 判断或改成旧条件时，反向用例应当失败。

---

### 低：`revised.revision !== expected` 的更正分支实际不可达，文档描述有误导

- 文件:行：`packages/memory-engine/src/conversation-review.ts:77-82`；`packages/persistence-sqlite/src/sqlite-memory-operations.ts:814-824`；`docs/adr/0231-review-past-conversations-to-fix-memory.md:82`
- 问题：`revise` 要么抛冲突，要么严格写入 `current.revision + 1`（保存层校验 `input.memory.revision !== current.revision + 1` 即失败），而 `current.revision` 又必须等于 `expectedRevision`。因此 `revised.revision` 永远等于 `expected`，`if (revised.revision !== expected)` 分支不可达。ADR 写的“结果不同再更正”会让人误以为这里能兜住异常版本。
- 证据：

```ts
// sqlite-memory-operations.ts:815-823
if (
  input.expectedRevision !== current.revision ||
  input.memory.revision !== current.revision + 1 ||
  ...
) this.fail("PORT_CONFLICT", ...);
```

- 建议：删掉不可达分支，或在注释/ADR 说明它只是防御未来 `revise` 语义变化；真正需要修的是上面的预写标记问题。

---

## 侧重检查

- 错误路径：撤销入口检查 `undoneAt`、`UNDOABLE_REVIEW_STATUSES`、记忆存在与版本（`conversation-review.ts:29-54`），`markChangeUndone` 在 0 行更新时抛 `PORT_CONFLICT`（`sqlite-...operations.ts:287`）。**结论：** 这些保护本身没问题，但高严重度项证明“预写 + 失败”绕过了版本保护。
- 不合规范/不可信输入：模型给出的 `supersedes` 在普通抽取中先按 `input.existingIds` 过滤（`production-memory-capture.ts:321-337`），回看中还要过 `withReplacementRule`（`production-memory-conversation-review.ts:323-347`）；`supersede()` 再校验 owner/agent（`durable-memory-service.ts:550-552`）。**结论：** 不能借 `supersedes` 跨 owner/agent 取代；但同一 owner 下的“已恢复/已被取代”目标没有拦住，见中严重度项。
- 安全：撤销命令在 `production-memory-control.ts:1239-1253` 先按当前 owner/agent 的 `listWithChanges` 校验 review 归属，再调用撤销。**结论：** 没有发现本轮引入的越权路径。
- 资源耗尽：本轮每次撤销多一次 `markChangeUndone` 写；`#settle` 每次读取整批 changes（`:855`），规模受回看批次条数限制。**结论：** 未发现新的无界增长。
- 不可撤销操作：整批撤销可能部分完成；失败后 review 仍可重试。**结论：** 高严重度项会让它在未真正改回时也标记整批完成，属于“不可撤销地误报完成”。
- 规则/说明与代码一致性：ADR 0231 第 82、83 行与代码大体对应，但第 82 行没有提示预写标记在失败后的误判风险；第 83 行“新记忆已保存、取代没做就中断时重试会补做取代”与代码一致。**结论：** 文档需要随高严重度修复更新。
- 数据导出/导入消费者：快照只导出 `after_revision IS NOT NULL` 的行（`data-export/snapshot.ts:128-133`），因此不会导出待定行；`undoneRevision` 的导出 schema 是 `nullable(integer(2))`（最小 2），迁移约束是 `undone_revision > after_revision`（`0091_...sql:36-38`），两者与预写的 `R+1` 一致。**结论：** 序列化/校验两端都能接受，没有发现 I-73 式的 id/字段格式不通。
- 未核实：受工具限制没有运行测试、lint 或 `npm run check:prompt-prefix`；`.agents/reviews/pr-395/round-2/judgments.md` 在当前检出里读不到（二进制/未落盘），只能依据题目转述的第 2 轮意见。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？不会。** 本轮增量只改撤销的数据库标记、`#settle` 的记录判断和 `applyProposal` 的取代补做，没有触碰系统提示、工具定义、历史消息或出口遮盖。发给模型的内容仍然只在末尾追加；每一轮会变的值（记忆选择、后台回看的日期等）仍位于该次请求末尾，测试也断言回看提示以日期结尾（`test/integration/memory-conversation-review.test.ts:421`）。间接地，取代/归档会改变后续请求末尾“现有记忆”的选取，但不会改动已经发送过的前缀字节。未运行提示前缀门槛，属于未核实。

2. **会不会让同一段文字在不同请求里变成不同字节？不会。** 新增的 `createdHere` 只是内存里的 `Set`，只做成员判断，不参与序列化；`undoneRevision` 只存数据库、不发给模型；`supersededBy` 只影响记忆是否被选取，不改变同一段正文的序列化。没有新增时间字段或无序集合输出。`#settle` 读取按 `ORDER BY created_at, memory_id`（`sqlite-...operations.ts:324`），顺序是确定的。

3. **有没有对应的自动检查，反向用例真的会失败？部分有。**
   - “撤销改回后中断”用例（`memory-conversation-review.test.ts:538-570`）：按旧代码，`revise` 成功但尚未写 `undoneRevision`，重试会因版本已是 `R+1` 而抛 `MEMORY_CHANGED_AFTER_REVIEW`，所以该用例在修改前会失败（读代码推断，未实际运行）。
   - “新记忆已存时补做取代”用例（`:572-596`）：旧 `applyProposal` 在 `sameProposal` 分支只投递投影、不执行 `supersedes`，旧代码下 `supersededBy` 仍为 `null`，会失败。
   - `#settle` 的新条件没有测试，也没有反向用例；删除触发器用例（`:598-614`）不验证该条件。
   - 高严重度项“预写后 `revise` 失败、记忆又被推进一格”没有任何测试覆盖。

4. **改动产生/修改的每个值，使用方都能接受吗？**
   - `undone_revision = memory.revision + 1`：产生于 `conversation-review.ts:56`。使用方：`markChangeUndone` 要求 `>= 2` 且 `after_revision < 新值`（`sqlite-...operations.ts:278,284`）；迁移约束要求 `> after_revision`（`0091:36-38`）；`isReviewChangeUndone`/`isReviewChangeUndoable` 比较版本（`memory-conversation-review.ts:89-108`）；UI 的 `undoable`（`production-memory-control.ts:733-737`）；导出 schema `nullable(integer(2))` 与导入 INSERT（`schemas.ts:206`、`import.ts:500-530`）。**校验两端都能接受**（`afterRevision >= 1`，所以 `R+1 >= 2`），问题在语义误判，不在格式。
   - `createdHere` 里的 memory id：产生于 `#settle`，与创建时使用的 id 一致——回看 intent 用 `` `memory:${generationId}:${ordinal}` ``（`production-memory-conversation-review.ts:793`），自动记忆用 `memoryIdFor` 生成同样的 `` `memory:${generation}:${ordinal}` ``（`production-memory-capture.ts:609`，本地 `createMemoryId` 是恒等转换，`:51`）。使用方是 `supersededBy` 成员比较，两端都是同一字符串格式。
   - `afterRevision`（superseded/created/confirmed）：`recordChange` 校验 `>= 1`（`sqlite-...operations.ts:221-224`），导出 `integer(1)`，导入与迁移同样要求 `>= 1`；本轮没有改变其产生方式。
   - `attributes.supersededBy`（新 `applyProposal` 补做路径产生）：使用方包括撤销恢复（`conversation-review.ts:71`）、检索/现有记忆过滤、导出 schema `nullable(text(1,512))`、`supersede()` 的 owner/agent 检查。**格式和归属校验都能通过**；缺陷是缺少“替代方本身已被取代”的检查。
   - 本轮没有新增配置键、清单项或序列化格式。
