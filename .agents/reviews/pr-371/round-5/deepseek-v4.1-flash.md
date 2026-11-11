# PR-371 第 5 轮复核（e9e6688f）

复核范围：`bebbb117` 的功能改动，以及 `e9e6688f` 合并 main 时对 `apps/control-center/src/memory-source.ts` 的冲突处理。`980322..e9e6688` 的改动清单里没有 `packages/prompt-catalog`、模型运行时或提示词组装文件，因此本轮不涉及模型请求开头。

---

## 发现（按严重度）

### 1. 中：`daily-review` 按“任一记忆 id 相交”隐藏 `hold`，会把不在本周清单里的矛盾对也藏掉

**文件**：`packages/application/src/services/daily-review.ts:293-314`

**问题**：作者说“本周体检清单里已有的矛盾对，它的 `hold` 才不进整理记忆组；这一对没排进本周清单时照常显示”。代码不是按“同一对”匹配，而是把本周所有 `conflict` 项的 `memoryId` 和 `relatedMemoryId` 放进一个集合，只要 `hold` 决策记录涉及的任一 id 在集合里就跳过。

**证据**：

```ts
// daily-review.ts:293-297
const checkupMemoryIds = new Set<string>(
  (options.checkup ?? []).flatMap(({ reason, memoryId, relatedMemoryId }) =>
    reason === "conflict" ? [memoryId, ...(relatedMemoryId ? [relatedMemoryId] : [])] : [],
  ),
);

// daily-review.ts:307-314
if (
  entry.kind === "consolidation" &&
  entry.outcome === "hold" &&
  [...entry.inputs.memoryIds, ...entry.inputs.resultMemoryIds].some((id) =>
    checkupMemoryIds.has(id),
  )
)
  continue;
```

**后果**：`hold` 的实际写入是“新条 + 旧条”（`packages/memory-engine/src/consolidation.ts:519` 的 `basisMemoryIds`，以及 `sqlite-memory-consolidation-operations.ts:101-105` 写入的 `memoryIds`）。如果本周清单有 `(a,b)`，而另一条未排进清单的 `hold` 是 `(b,c)`，代码会因为共享 `b` 把 `(b,c)` 也隐藏。`memory-checkup.ts:87-89,145` 又把所有 hold 对的 `b` 从 `unused` / `low_confidence` / `source_unavailable` 队列里排除，因此这条未排进清单的矛盾对在当天的“整理记忆”和体检组里都不会出现。ADR 0218 写的“清单生成失败或这一对没排进本周清单时，`hold` 决策记录照常出现在‘整理记忆’组”与实现不符。多个新条与同一旧条冲突、或同一新条先后与不同旧条 `hold` 时都可能出现。

**建议**：改成按无序对匹配，例如建立 `Set` 存 `${[memoryId, relatedMemoryId].sort().join("|")}`，只在 `hold` 的两个 id 正好等于某个已排进清单的矛盾对时隐藏；或者用 `entry.subjectRef`（新条）加 `entry.inputs.memoryIds.includes(relatedMemoryId)` 精确匹配。补一条“`(a,b)` 在清单、`(b,c)` 不在清单”的用例，确保只有 `(a,b)` 的 `hold` 被隐藏。

---

### 2. 低：迁移 0090 的新 CHECK 在 `action IS NULL` 时不会生效

**文件**：`packages/persistence-sqlite/src/migrations/0090_memory_checkup.sql:18`

**问题**：`CHECK (kept_memory_id IS NULL OR action = 'merge')` 想表达“`kept_memory_id` 只能用于 merge”。但 `action` 允许为 `NULL`：当 `action IS NULL` 且 `kept_memory_id` 非空时，表达式是 `FALSE OR NULL`，结果为 `NULL`。SQLite 的 CHECK 只有在表达式为 0 时才算违反，`NULL` 会通过。

**证据**：

```sql
-- 0090_memory_checkup.sql:9,18
action TEXT CHECK (action IS NULL OR action IN ('confirm', 'delete', 'merge')),
...
CHECK (kept_memory_id IS NULL OR action = 'merge'),
```

反向测试只覆盖了 `action='confirm'`：

```ts
// packages/persistence-sqlite/test/memory-checkup-migration.contract.test.ts:102-111
INSERT ... 'unused', 'confirm', 'm-1', '{"tentative":false}', ...
```

这条会失败，但 `action NULL + kept_memory_id 非空` 不会失败。服务端 `recordUndo` 会清空 `kept_memory_id`（`sqlite-memory-checkup-operations.ts:216-217`），所以目前正常路径不会产生这种行，影响有限；但这条 CHECK 没有完全落实作者声称的不变式。

**建议**：改成不会产生三值逻辑的写法，例如 `CHECK (kept_memory_id IS NULL OR action IS 'merge')`，或 `CHECK (kept_memory_id IS NULL OR (action IS NOT NULL AND action = 'merge'))`；并把迁移测试的反向用例补一条 `action = NULL, kept_memory_id = 'm-1'`。

---

### 3. 低：`openOnly` 的排序和接线没有自动检查，`daily-review` 的“共享 id”也没有反向用例

**文件**：`test/integration/memory-consolidation.test.ts:886-891`、`apps/agent-service/src/service-main.ts:1665-1674`

**问题**：
- `listHeldPairs({ openOnly: true })` 的测试只有一个未撤销对，没有验证 `created_at DESC, id DESC` 在多对时的顺序，也没有验证“`pickMemoryCheckup` 取的正是这个顺序”。
- `service-main` 是否真的传了 `openOnly: true` 没有任何测试覆盖；把 `openOnly: true` 去掉后，现有测试（memory-checkup 集成测试使用直接注入的 `pairs`）不会失败。
- 发现 1 的“共享 id 误藏”没有反向用例。

**证据**：

```ts
// memory-consolidation.test.ts:890-891
expect(await held.listHeldPairs({ ...scope, openOnly: true })).toEqual([
  ["milk-new", "milk-old"],
]);
```

这里只有一个对，无法证明顺序。

**建议**：造两个不同 `created_at` 的 open hold，验证返回“新的在前”；再补一个经 `service-main` 组合或至少断言 `listHeldPairs` 收到 `openOnly: true` 的测试；并为发现 1 增加“共享一个 id、不同对”的 daily-review 用例。

---

### 4. 低（推测）：原地修改 0090 会让跑过 `0d022` 的数据库启动时报 `DIGEST_MISMATCH`

**文件**：`packages/persistence-sqlite/src/migration-engine.ts:838-851`

**问题**：`0090_memory_checkup.sql` 在 `0d022` 已存在，本轮 `bebbb117` 直接改了文件内容。迁移引擎会比对已应用迁移的 digest，不一致时抛 `SQLITE_MIGRATION_DIGEST_MISMATCH` 并拒绝启动。

**证据**：

```ts
// migration-engine.ts:838-844
if (
  definition.name !== record.name ||
  definition.phase !== record.phase ||
  definition.digest !== record.digest
) {
  throw new SqliteMigrationError(
    SQLITE_MIGRATION_ERROR_CODES.DIGEST_MISMATCH,
```

`0090` 目前只在房间分支里，不在 main 上，所以不构成已发布迁移；是否真的影响取决于是否有人已经用 `0d022` 建过库（未核实）。如果存在这种开发/测试库，需要重建，不能原地升级。

**建议**：如果 `0090` 从未离开本分支，保持现状即可，但要在 PR 说明里提醒重建本地库；如果已经有人跑过 `0d022`，应追加新迁移而不是改 0090。

---

## 推测（未运行验证）

- **STALE 检查不是原子的**：`memory-checkup.ts:264-266` 读 `tentative` 后，到 `recordAction` 和 `apply` 之间仍可能有人在记忆页确认新条。若发生在 merge 中，`apply` 的 `memory.confirm(keep.id, ...)` 会因已确认而失败，`#restore` 会按 `before.keepTentative` 把 keep 改回待确认（`memory-checkup.ts:369-376`），等于把别处的确认回退。这是并发窗口，未在本轮改动之外被消除；旧的实现同样存在，只是新的 STALE 检查缩小了窗口。若要彻底避免，需要在 `recordAction` 或记忆写入端用修订号做条件更新，而不是先读后写。
- 测试是否在旧代码上失败是根据 diff 推断的，未实际运行；其中“共享 id 误藏”“openOnly 多对顺序”“action NULL + kept”三项没有对应的失败用例。

---

## 侧重检查

- **不可信输入**：`proactive.review.checkup` 的 `key` 必须解析为 `checkup` 来源；`keep` 被限制为 `item.memoryId` 或 `item.relatedMemoryId`（`memory-checkup.ts:283-284`），不存在跨 owner/agent 读取。`action` 由网关合同限定为 `confirm/delete/merge/undo`，`undo` 走独立路径。未发现新的越权读取。
- **错误路径**：`apply` 失败后先尝试 `#restore`，恢复失败时报 `MEMORY_CHECKUP_RESTORE_FAILED`，与 ADR 0218 更新后的文字一致（`memory-checkup.ts:317-326`）。STALE 使用 `INVALID_OPERATION`，与 `#live` 原有做法一致。
- **不可撤销操作**：merge 仍可撤销，STALE 判断不作用于 `undo`；`recordUndo` 清空 `kept_memory_id`，不会触发发现 2 的 CHECK 问题。
- **资源耗尽**：`listHeldPairs` 仍无 LIMIT，返回全部 open hold；这是既有行为，本轮没有新增无界循环，`paired` 集合规模与 hold 数同阶。
- **文档与代码一致性**：ADR 0218 关于“清单没排进时照常显示”的说法与发现 1 不一致；“P3-8 撤销 hold 要求修订号没变”的已知限制与 `isConsolidationUndoable`（`memory-engine/src/consolidation.ts:36-43`）一致。
- **合并冲突（memory-source）**：`EXTERNAL_RULE_MEMORY_PREFIX` 已进入 `packages/gateway-contracts/src/memory-source.ts:3,27-31`，控制台改为转出（`apps/control-center/src/memory-source.ts:4-9`）；生产写入端 `production-owner-rules.ts:424` 生成 `memory:rule:<key>`，外部规则 key 为 `mcp:<proposalId>`，与 `production-mcp-rule-writer.ts:12` 的前缀一致；`memory-source-report.test.ts:42-50` 现在从 gateway-contracts 读常量，并核对报表 SQL 和写入端常量，两端能对上。控制台 `MemoryItem` 的 `importBatchId/sourceThreadId/sourceMessageId/sourceRefs/history` 字段与 `MemorySourceFacts` 兼容（`contracts-v2.ts:1230-1265`）。未发现据守冲突处理丢失 main 的新前缀判断。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本轮的改动全部在体检/每日打分的读取与展示、SQLite 迁移、`listHeldPairs` 可选参数和网关合同/前端分类函数里；没有改系统提示、工具定义、历史消息或出口遮盖。`readDailyReview` / `MemoryCheckupService` 只被 `production-proactive.ts` 和网页使用，不进入模型提示；合并进来的 `memorySourceState` 只用于控制台来源分类和体检的 `source_unavailable` 分类。`980322..e9e6688` 也没有 `packages/prompt-catalog` 或运行时提示组装文件的改动。因此发给模型的内容仍然只在末尾追加，每轮变化的值仍不在请求开头。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**模型请求层面不会。** 新增的排序 `created_at DESC, id DESC` 是确定性的（`created_at` 相同再用 `id` 比较），`pickMemoryCheckup` 的队列排序按 `id` / 置信度排序，`daily-review` 只是集合成员判断；没有新的遮盖、时间字段或无序集合进入模型输入。每日评分的顺序仍由持久化的周清单和 `hash(seed|day|key)` 决定。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

有检查，但不完整：
- 会失败的反向用例（按 diff 推断）：`lists every held pair as a conflict even when its newer memory is also unsure`、`[negative] refuses to act on a conflict whose newer memory was confirmed...`、`openOnly` 排除已撤销 `hold`、`daily-review` 只在清单包含该对时隐藏 `hold`、迁移 `confirm + kept_memory_id` 反向插入。这些在旧代码上应当失败。
- 缺口：发现 1 的“共享 id”没有用例；`openOnly` 的多对顺序和 `service-main` 的实际接线没有用例；迁移 `action NULL + kept_memory_id` 没有被反向插入覆盖。未实际运行测试，“旧代码会失败”是读代码推断。

### 4. 改动产生/修改的值，每个使用它的地方都能接受吗？

逐项核对：
- **`openOnly`**：`service-main.ts:1665-1674` 产生 → `application/ports/memory-consolidation.ts:69-73` 类型 → `durable-adapters.ts:936` 透传 → `sqlite-memory-consolidation-operations.ts:150-156,273-286` 读取。只有 sqlite 一个实现；不传时保持旧 `ORDER BY id`，`memory-engine/src/consolidation.ts:293` 的 P3-8 调用不带该参数，语义未变。
- **`MEMORY_CHECKUP_STALE`**：`memory-checkup.ts:252,266` 产生，作为 `ApplicationPortError` 的原因码经网关返回；前端 `proactive.ts:153-166` 只记通用失败状态，不会因未知原因码崩溃。
- **本周清单的 `memoryId/relatedMemoryId`**：`createWeek` 写入前校验 reason 和 `related` 关系（`sqlite-memory-checkup-operations.ts:128-136`），`daily-review` 用它建集合；`pickMemoryCheckup` 要求新条 tentative、旧条存在且在 live 集合里。两端能接受，但发现 1 的匹配粒度不对。
- **`kept_memory_id`**：`recordAction` 写入，`recordUndo` 清空，读取端 `before/keptMemoryId` 使用；迁移 CHECK 在 `action` 非空时正确，`action` 为 `NULL` 时存在发现 2 的漏洞。
- **`EXTERNAL_RULE_MEMORY_PREFIX`**：gateway-contracts 定义、控制台转出、报表/测试核对；`production-mcp-rule-writer.ts` 与 `production-owner-rules.ts` 生成的 id 前缀一致。两端一致。
