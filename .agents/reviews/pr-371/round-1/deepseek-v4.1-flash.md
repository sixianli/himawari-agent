## 读代码后确认的问题

### 1. 高｜`packages/application/src/services/memory-checkup.ts:230-274`
**问题：动作先改记忆，再写体检记录；中间失败会留下“记忆已改、清单未记录”的状态，且无法用撤销恢复。**

证据：
```ts
if (input.action === "confirm") {
  if (tentative) await this.#options.memory.confirm(...);
  ...
} else if (input.action === "delete") {
  await this.#options.memory.trash(...);          // 238
  ...
} else {
  await this.#options.memory.revise({             // 246-252
    memoryId: drop.id, status: "archived",
    attributes: { supersededBy: keep.id, validTo: now }, ...
  });
  if (keepTentative) await this.#options.memory.confirm(...);
  ...
}
const recorded = await this.#options.store.recordAction({ ... }); // 266
if (!recorded) refuse("conflict", "MEMORY_CHECKUP_ALREADY_HANDLED"); // 274
```
`recordAction` 是最后一步且没有补偿逻辑。只要它抛错或返回 `false`，前面的 `trash`/`revise`/`confirm` 已经落库，但 `memory_checkup_items` 仍是未处理，`before_state` 也没写，用户没有可用的撤销依据。删除后 `_live()` 会因记忆已不是 active 而拒绝重试；合并后 drop 已 archived，再次合并会 stale。

**触发方式：** 数据库写 `memory_checkup_items` 失败；或两个请求都先读到 `item.action === null`。并发是否会发生取决于网关命令是否串行执行（这部分我未逐行核实 `AgentGatewayV2Service`），但只要命令可交错，两个不同 `keep` 的 merge 可以分别归档两条记忆，只有一个 request 能成功 `recordAction`，另一条归档就无撤销记录。

**建议：** 先原子占用清单行（例如 `UPDATE ... SET action=..., before_state=..., handled_at=... WHERE id=? AND action IS NULL`），成功后再改记忆；记忆改动失败时再条件回滚占用。或把记忆写入与清单写入放进同一个事务/补偿日志。

---

### 2. 高｜`packages/application/src/services/memory-checkup.ts:283-330`
**问题：撤销同样是“先恢复记忆、再清空记录”，失败后可能永久卡在已处理状态。**

证据：
```ts
await memory.recover(current.id, await generationFor(current.id)); // 297
...
await memory.revise({ memoryId: drop.id, status: before.dropStatus ?? "active", ... }); // 305-314
if (before.keepTentative) {
  const keep = await this.#live(keepId);
  await memory.revise({ memoryId: keep.id, attributes: { tentative: true }, ... }); // 315-323
}
const undone = await this.#options.store.recordUndo({ ... }); // 325
if (!undone) refuse("conflict", "MEMORY_CHECKUP_NOT_HANDLED"); // 330
```
如果 `recordUndo` 失败，记忆已经恢复，但 `action` 仍非空。用户重试时：
- 删除撤销：`current?.status !== "trashed"` 会变成 `MEMORY_CHECKUP_STALE`；
- 合并撤销：drop 已不再是 `archived`/`supersededBy` 也不再等于 keep，直接 stale。

结果就是这套记录既不能再撤销，也不能重新处理。

**建议：** 先原子地把清单行标成“撤销中/已撤销”，再恢复记忆；恢复失败时回滚清单行。合并撤销中的 drop 恢复和 keep 的 tentative 恢复也要作为一个整体处理。

---

### 3. 中｜`packages/application/src/services/memory-checkup.ts:283-304`
**问题：撤销没有校验“记忆在这之后是否被别处改过”，只校验一个很弱的状态。**

证据：
```ts
if (item.action === "delete") {
  const current = await state.read(item.memoryId);
  if (current?.status !== "trashed") refuse("invalid", "MEMORY_CHECKUP_STALE"); // 295-297
  await memory.recover(current.id, ...);
}
```
确认撤销也只检查 `current.attributes?.tentative !== true`（286 行），合并撤销只检查 drop 的 `status === "archived"` 和 `supersededBy === keepId`（303 行）。`before_state` 里没有保存记忆的 revision 或动作后的 revision。

**触发方式：** 体检里删除某条记忆后，用户在记忆页把它恢复、再删除一次；此时体检撤销仍看到 `status === "trashed"`，会把第二次删除也恢复。确认撤销同理：如果用户之后又在别处确认了该记忆，体检撤销仍会把它改回 tentative。

**建议：** 在 `before_state` 中保存动作后的 `revision`（必要时也保存动作后的关键属性），撤销时要求当前 revision 与记录一致，否则返回 stale，而不是强行还原。

---

### 4. 中｜`packages/application/src/services/daily-review.ts:96-98`、`367-375`；`apps/control-center/src/components/proactive-reminders.tsx:486-489`
**问题：作者说“撤销总是允许”，但页面在跨天后实际上看不到昨天处理过的体检条目，因此无法从页面撤销。**

证据：
```ts
const eligible = input.pool.filter(
  (item) => !item.done || (item.doneAt !== null && item.doneAt >= dayStart),
);
```
体检条目的 `done`/`doneAt` 来自：
```ts
group: "memory_checkup",
done: entry.action !== null,
doneAt: entry.handledAt,
```
页面只渲染 `review.items`：
```ts
const list = review ? (folded ? review.folded.items : review.items) : [];
```
周清单里周一处理的条目，周二 `doneAt` 小于周二 `dayStart`，不会进入 `items`；它也不属于 `folded`（`folded` 只收 `other` 组）。命令层 `undo` 不查预算，确实总是允许，但普通用户没有可用入口。ADR 里“撤销后这一条回到未处理，可以重新选”在同一周内也不完全成立。

**建议：** 体检条目不要沿用“昨天已处理就排除”的通用抽样规则；在本周清单内应显式返回已处理但未撤销的体检条目，或在体检区提供本周处理记录/撤销入口。

---

### 5. 低｜`apps/agent-service/src/production-proactive.ts:311-317`、`560-565`
**问题：`week()` 的异常被吞掉，随后被误报成“预算已用完”。**

证据：
```ts
const checkup = this.#options.checkup
  ? await this.#options.checkup.week().catch((error: unknown) => {
      this.#options.onFailure(error);
      return [];
    })
  : [];
```
以及：
```ts
const shown = (await this.review()).items.some((item) => item.key === key);
if (!shown)
  throw new ApplicationPortError(
    PORT_ERROR_CODES.INVALID_OPERATION,
    "PROACTIVE_REVIEW_BUDGET_USED",
  );
```
只要清单读取/生成失败，`review()` 返回空体检列表，`act` 就报 `PROACTIVE_REVIEW_BUDGET_USED`，把数据库/服务错误伪装成配额错误，难以排查。表不存在是已知状态，但错误被吞掉这条机制本身仍值得修。

**建议：** 在 `act` 路径区分“体检服务不可用”和“预算用完”；`week()` 失败时向上抛出专门的错误，`proactive.review.read` 再决定是否降级展示。

---

### 6. 低｜`packages/application/src/services/memory-checkup.ts:96-108` vs `apps/agent-service/src/production-memory-control.ts:429`
**问题：服务端体检给 `memorySourceState` 的输入和记忆页不完全一样，来源判定可能不一致。**

证据：体检传的是原始 refs 和空 history：
```ts
sourceMessageId: input.sourceMessageIds.get(record.id) ?? null,
sourceRefs: record.sourceRefs,
history: [],
```
记忆页传给同一函数的是过滤后的 refs：
```ts
sourceRefs: memory.sourceRefs.filter((ref) => ref.length <= MEMORY_SOURCE_REF_MAX_LENGTH),
```
当某条记忆的 `sourceRefs` 里同时有提醒 ref 和超长非提醒 ref 时，记忆页可能判成 `reminder`，体检却可能判成 `unavailable`，造成同一条记忆在“记忆页”和“记忆体检”里来源结论不同。`history: []` 也会让 `deleted`/`tidy` 的区分丢失（不过这不直接影响 `unavailable`）。

**建议：** 复用与记忆页完全相同的“视图构造”函数，或至少使用相同的 ref 过滤规则，并把真实 history 传进来。

---

### 7. 低｜`packages/application/src/services/memory-checkup.ts:172-201`
**问题：本周没有任何候选时不落任何“本周已生成”标记，每次读/每次动作都会重新扫描全部 active 记忆和来源消息。**

证据：
```ts
const existing = await store.listWeek({ ...scope, weekStart });
if (existing.length > 0) return existing;
const records = await this.#options.state.listActive(...);
...
if (picked.length === 0) return [];
```
只要所有记忆都“最近用过且置信度够高”，`picked` 为空，就不调用 `createWeek`；下一次 `proactive.review.read` 或 `act` 又会执行一遍 `listActive` 和 `findSourceMessageIds`。数据量大时这是可避免的重复开销。

**建议：** 为空周也持久化一个“本周已生成、0 条”的标记，或单独缓存本周生成结果。

---

## 推测 / 未核实

- **并发命令是否真的会交错**：取决于 `AgentGatewayV2Service` 是否按 owner 串行执行命令；我没有逐行读网关调度层。`MemoryCheckupService` 自身没有行级占用，这一点是确定的。
- **预算能否被“撤销旧条目再处理”绕过**：如果周清单按生成时的 capacity 固定，正常配置下最多只有 capacity 条，单日很难超过；只有周中把 capacity 调小时理论上有空间。未构造完整复现。
- **布局检查**：`check:layout` 是否能接受“冲突对两行文字 + 三个按钮”的实际高度，我没有运行测试，未核实。
- **模型请求组装**：本次没有逐行读记忆召回注入和 prompt 组装代码；“不改变模型请求字节”的结论是基于本次 diff 未触及这些文件。
- **迁移/表不存在**：按材料要求未把表不存在本身当作问题。

## 侧重检查

- **认证与 scope**：`ProductionProactive.execute` 先校验 actor 是 owner 且 scope 匹配（`production-proactive.ts:437-445`）；`MemoryCheckupService#item` 用带 owner/agent 的 `store.read`；`keep` 必须等于该 pair 的两条之一（`memory-checkup.ts:241-245`）。这部分正确。
- **不可信输入**：命令合约用 `machineString`、`enumeration` 校验 key/action/keep，并强制“只有 merge 能带 keep”（`contracts-v2.ts` 新 schema）。`checkup:` + `memory-checkup:<uuid>` 约 59 字符，落在 `machineString` 1-128 和允许字符集内；记忆 id 也已在内存页合约中使用 `machineString`。这部分通过。
- **错误路径**：发现动作/撤销的写入顺序问题（问题 1、2），以及把错误伪装成预算错误（问题 5）。
- **不可撤销操作**：发现跨天 UI 不可撤销（问题 4），以及异常/并发下可能永久卡住（问题 2）。
- **资源耗尽**：发现空周不落标记导致反复全量扫描（问题 7）；SQL 都是 prepared statement，未发现注入问题。
- **规则/文档一致性**：ADR 0218 与代码大体一致；不一致主要是“撤销总是允许”在页面上受当天抽样限制，以及 `memorySourceState` 的输入不完全等同于记忆页。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（就本次 diff 能确认的范围）。** 本次改动没有触及系统提示、工具定义、历史消息或出口遮盖的组装代码；新增内容写入 SQLite、控制中心 snapshot 和网页 UI。`proactive.review.checkup` 只读写记忆与体检表，不进入对话请求。

需要说明的间接影响：确认/删除/合并会改变记忆状态，从而可能改变未来某一轮的“召回记忆”内容；按 `.claude/rules/prompt-prefix.md#rules` 第 2 条，这类每轮变化的内容应只出现在最后一条用户消息里。我没有逐行核实召回块的实际注入位置，标记为未核实；就本 PR 的改动文件看，它没有把新值塞进请求开头。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会（针对模型请求内容）。** 新 snapshot 里的 `generatedAt`、`memoryUnusedDays`、体检条目都只进控制中心，不进模型请求。`before_state` 的 JSON 由固定对象字面量 `JSON.stringify` 产生，键序在该代码版本内固定；SQL 侧 `listWeek` 用 `ORDER BY rowid`，其他查询有 `ORDER BY`。体检选择确实依赖当前时间和数据库内容，但这些不参与模型请求字节。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

**有部分检查，但关键反向用例不在本提交里。**

- 已提交：`apps/control-center/test/proactive-interactions.unit.test.ts:676-744` 的 `[P4-6]` 覆盖体检行渲染、merge 命令、undo 命令和“这一页都没问题”排除体检条目。
- 已提交：`packages/gateway-contracts/test/gateway-v2.fixture.ts` 增加了 `proactive.review.checkup` 命令和带 `checkup` 的 review snapshot fixture；合约 fixture 测试至少会覆盖新消息形状。
- 未提交/未核实：作者提到的 `test/integration/memory-checkup.test.ts`、SQLite 迁移 contract test 都不在当前提交里；因此“第 4 条被预算拒绝”“merge 不带 keep 被合约拒绝”“并发/失败路径”“跨天撤销”这些反向行为没有可运行的证据，不能确认它们会失败。
- 测试夹具本身的小缺口：`apps/control-center/test/proactive-interactions.unit.test.ts:38-49` 的 `installedGatewayV2Operations` 没有加入 `proactive.review.checkup`；由于控制中心发送命令时不按该清单拦截，测试仍能通过，但这也意味着测试不会发现“服务端没声明这个操作”的清单遗漏。

### 4. 新产生/修改的每个值，两端校验都能接受吗？

逐个核对结果：

- **`memory_checkup_items.id` / `checkup:<id>` key**：生产 `ids.next("memory-checkup")` 生成 `memory-checkup:<uuid>`，约 51 字符；key 约 59 字符；符合 `machineString` 的 1-128 长度和 `^[A-Za-z0-9][A-Za-z0-9._:-]*$`。**通过。**
- **`memoryId` / `relatedMemoryId` / `keptMemoryId`**：体检 snapshot 合约用 `machineString`；记忆页合约的 `memoryId` 也是 `machineString`，现有 `memory:owner:<...>`、`memory:<uuid>` 形式都能通过。**通过。**
- **`reason`**：取值 `conflict` / `unused` / `low_confidence` / `source_unavailable`，在 `memory-checkup.ts`、`contracts-v2.ts`、`sqlite-memory-checkup-operations.ts` 三处重复定义，当前一致；没有单一来源，未来容易漂移。
- **`action`**：`confirm` / `delete` / `merge` 在 ports、contract、SQLite 校验中一致；`undo` 只存在于命令合约，不写库，符合设计。
- **`weekStart` / `createdAt` / `handledAt` / `undoneAt`**：`checkupWeekStart` 和 `now()` 都产生 `toISOString()` 形式；SQLite `valid()` 要求 `new Date(v).toISOString() === v`，能通过。**通过。**
- **`reviewMemoryUnusedDays`**：`strict-configuration.ts` 产生范围 7-3650、默认 90；`ProactiveConfiguration` 带该字段；snapshot 合约是 `integer(1)`；服务端实际传入配置值，范围满足。**通过。**
- **`before_state` JSON**：由 `MemoryCheckupService` 产生、由同一服务反序列化；没有对外合约，也没有在 SQLite 层校验结构。当前写入的是固定字段对象，**通过**，但存储层没有防御性校验。
- **操作清单项 `proactive.review.checkup`**：已加入 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、`PRODUCTION_PROACTIVE_OPERATIONS` 和 e2e fixture 的 installed operations；控制中心 unit test 的清单未加，但该命令发送不受它拦截。**运行时通过，测试覆盖有缺口。**

总体：值层面没有发现会导致 id/枚举被后端拒绝的硬错误；主要风险集中在动作/撤销的原子性、撤销的失效检测，以及跨天 UI 入口。
