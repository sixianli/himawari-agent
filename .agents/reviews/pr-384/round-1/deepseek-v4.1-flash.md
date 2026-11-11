## 读代码证实的

### [高] 确认或撤销 hold 后，同一对记忆会在下一次整理中再次出现，可能再次 hold，甚至自动作废旧条

**文件：** `packages/memory-engine/src/consolidation.ts:253-260`、`packages/memory-engine/src/consolidation.ts:292-311`、`packages/memory-engine/src/consolidation.ts:369-388`、`packages/application/src/services/durable-memory-service.ts:316-325`

**问题：** `hold` 只把新条设成 `tentative: true`。待确认期间它会被排除，所以不会重复整理；但用户点“确认”后，`confirm()` 会把 `tentative` 改回 false，同时把 `revision` 加 1、`updatedAt` 改成确认时间。下一次整理时，这条记忆满足 `memory.updatedAt > last.reviewedThrough`，会再次作为 fresh 进入分组；旧条没有被修改，仍会作为同分类/子分类的邻居加入。代码里没有“这对记忆已经处理过”的检查。模型如果再次判 `replace` 且置信度过阈值，就会自动作废旧条，违背用户“确认后两条都留”的选择；如果再次判 `conflict`，则会把用户刚确认的记忆重新设成待确认。撤销 hold 后也是同样情况。

**证据：**
```ts
// consolidation.ts:253-260
const fresh = reviewable
  .filter(
    (memory) =>
      (!last?.reviewedThrough || memory.updatedAt > last.reviewedThrough) &&
      ownChanges.get(memory.id) !== memory.revision,
  )
```
```ts
// durable-memory-service.ts:316-325
return this.saveWithProjection(
  nextRecord(
    current,
    { attributes: { ...current.attributes, tentative: false } },
    this.options.now(),
  ),
  current.revision,
  "upsert",
  generationId,
);
```
```ts
// consolidation.ts:292-311
const sameTopic = reviewable
  .filter(
    (other) =>
      other.id !== memory.id &&
      other.attributes?.category === category &&
      other.attributes?.subCategory === subCategory &&
      !paired.has([memory.id, other.id].sort().join("\n")),
  )
```
```ts
// consolidation.ts:369-388
if (
  decision.action === "replace" &&
  newer === keep &&
  statedAt(older.memory) < statedAt(newer.memory) &&
  newer.memory.confidencePermille >=
    autoCommitThreshold(newer.memory.attributes?.category ?? null, this.#options.gates)
) {
  const change = await this.#supersede(id, older.memory, newer.memory);
  ...
}
const change = await this.#revise(id, "hold", newer.memory, older.memory.id, {
  attributes: { tentative: true },
});
```
新增测试只检查确认后旧条“当下”仍是 active，没有在下一次整理中重跑这一对：
```ts
// test/integration/memory-consolidation.test.ts:786-792
await resource.memory.confirm(milk.id, GENERATION_ID);
expect((await resource.read("milk-new"))?.attributes?.tentative).not.toBe(true);
expect(await resource.read("milk-old")).toMatchObject({ status: "active" });
expect((await resource.read("milk-old"))?.attributes?.supersededBy).toBeNull();
...
await expect(resource.consolidation.undo(milkHold?.id ?? "")).rejects.toThrow(
  "MEMORY_CHANGED_AFTER_CONSOLIDATION",
);
```

**建议：** 增加“记忆对”级别的幂等/抑制机制。例如在建立分组时跳过已经有未撤销 `hold` 的同一对；或在 `replace` 自动作废前检查该对是否已有用户确认过的 hold，若有则不再自动 supersede。补一条测试：`hold → confirm → 再跑一次整理`，断言旧条不会被作废、新条不会重新变 tentative；`hold → undo → 再跑一次` 也应有明确行为。

---

### [中] 确认 hold 后，时间线仍显示“撤销”按钮，点击必然失败

**文件：** `apps/control-center/src/components/memory-page.tsx:1770-1780`、`apps/control-center/src/components/memory-page.tsx:1842-1853`、`packages/memory-engine/src/consolidation.ts:430-435`

**问题：** `hold` 被加进 `confirm: item.action === "reflect" || item.action === "hold"`，用户可以在待确认区确认。但确认只改 `tentative`，不会把对应的 hold 整理改动标记为已撤销/已处理。时间线仍把这条 hold 当成未撤销，继续显示“撤销”按钮；用户点击后 `undo()` 发现 `memory.revision !== change.afterRevision`，抛出 `MEMORY_CHANGED_AFTER_CONSOLIDATION`。新增的整合测试甚至明确断言确认后 undo 会失败，说明这是预期结果，但 UI 没有隐藏或禁用这个按钮。

**证据：**
```tsx
// memory-page.tsx:1779-1780
undo: () => void memory.undoTidy(item),
confirm: item.action === "reflect" || item.action === "hold",
```
```tsx
// memory-page.tsx:1842-1853
{event.undone ? (
  <small>{message("memory.undone")}</small>
) : event.undo ? (
  <ActionButton variant="quiet" disabled={memory.busy} onClick={event.undo}>
    {message("memory.undo")}
  </ActionButton>
) : null}
{event.confirm && pending.has(event.text) ? (
  <ActionButton variant="quiet" onClick={onConfirm}>
    {message("memory.page.goConfirm")}
  </ActionButton>
) : null}
```
```ts
// consolidation.ts:430-435
const memory = await this.#options.state.read(change.memoryId);
if (!memory || memory.revision !== change.afterRevision)
  throw new ApplicationPortError(
    PORT_ERROR_CODES.CONFLICT,
    "MEMORY_CHANGED_AFTER_CONSOLIDATION",
  );
```

**建议：** 确认后把 hold 改动标记为已处理（或让 overview 对 `tentative === false` 的 hold 不再显示 undo），或者至少在 UI 上隐藏/禁用撤销按钮。给控制中心补一条 hold 确认后的时间线用例。

---

### [低] 迁移测试只覆盖了部分被重建的表，未验证另外五张依赖表的数据、外键、索引和触发器

**文件：** `packages/persistence-sqlite/test/consolidation-hold-migration.contract.test.ts:22-27`

**问题：** 迁移重建了 `decision_ledger` 及六张依赖表，另外还重建了 `memory_consolidation_changes`、`memory_consolidation_change_basis`。测试的 `TABLES` 只包含五张，未包含 `source_insights`、`proactive_processed_messages`、`decision_ledger_payloads`、`proactive_push_backoff`、`muse_reference_entries`。因此这五张表的数据丢失、外键定义变化、索引/触发器遗漏不会被测试发现。约束明确要求已有数据不得丢失、外键/触发器/索引原样保留。

**证据：**
```ts
// consolidation-hold-migration.contract.test.ts:22-27
const TABLES = [
  "decision_ledger",
  "decision_signals",
  "memory_consolidation_runs",
  "memory_consolidation_changes",
  "memory_consolidation_change_basis",
] as const;
```
我逐行对比过 0088 和 0089：除 `hold` 和新增的 consolidation 表重建外，其余建表、索引、触发器、INSERT/SELECT 列完全一致，当前 SQL 本身没有发现遗漏。

**建议：** 把全部被重建的表加入 `TABLES`，至少比较每张表的行数据、`sqlite_master` 中的索引/触发器 SQL，并对关键外键做删除级联测试。

---

### [低] 文档和测试辅助类型里仍有四处枚举未提到 hold

**文件：** `packages/persistence-sqlite/src/schema-catalog.ts:646-649`、`packages/persistence-sqlite/src/data-export/schemas.ts:184`、`test/integration/decision-ledger.test.ts:897`

**问题：** 生产校验点都加了 `hold`，但两处说明文字仍只写 merge/supersede/archive/reflect；一处集成测试的辅助 union 仍是四值。不会导致运行失败，但和“所有枚举都加 hold”的说法不完全一致，也会让后续维护者误以为 hold 不属于整理改动。

**证据：**
```ts
// schema-catalog.ts:648
"every Memory a tidy-up change was made from, in order: both Memories of a merge or supersede, all basis Memories of an inferred one",
```
```ts
// data-export/schemas.ts:184
"一次整理（把相近的记忆合并、取代、归档），带每次改动和依据的记忆编号。",
```
```ts
// test/integration/decision-ledger.test.ts:897
action: "merge" | "supersede" | "archive" | "reflect",
```

**建议：** 把说明文字补上 `hold`/“待确认”，测试辅助 union 也加上 `hold`。

---

## 推测

- 第 1 条中“会再次 hold 或自动作废旧条”的后半句取决于模型下一次的输出；代码能证实的是同一对会被重新提交给模型，模型判 `replace` 且置信度够高时就会自动作废。因为输入记忆内容完全没变，模型再次给出同一判断的可能性不低。
- 如果历史数据里 `recorded_at` 为 NULL，`sqlite-memory-operations.ts:530` 会回退到 `updatedAt`，此时 hold/confirm 改变 `updatedAt` 会改变提示词里显示的日期，也可能改变新旧判断。当前 0053 迁移已把 `recorded_at` 回填，生产数据应非空；这一点没有在真实旧库上核实。
- 我没有运行测试，也没有计算 prompt 清单里的 SHA-256，只是读了源码、迁移和测试代码。

---

## 侧重检查

- **错误路径：** 查了 hold 的创建、确认、撤销、重复整理、迁移失败路径。发现确认后重复整理问题（第 1 条）和确认后撤销按钮问题（第 2 条）。迁移失败时整段整理会标记 failed；单条 hold 的保存、账本、改动在同一事务内，未发现新的部分写入。
- **不合规范/不可信输入：** 模型输出的 `action` 只接受 `duplicate/replace/conflict`，`keep/drop` 必须属于本组且至少一个是 fresh；新增的 `replace` 没有绕开这些校验。置信度、分类来自存储记忆，不直接取模型输出；未发现新的注入入口。hold 的破坏性比原来的 conflict 自动作废更小。
- **安全：** `tentative: true` 会让记忆不进主人档案、默认不进检索，而不是删除；hold 账本只记 ID，不记正文。旧条保持 active，用户确认后两条都在。未发现新的秘密泄露路径。
- **资源耗尽：** hold 不增加模型调用次数，整理仍受 `MAXIMUM_FRESH`、`MAXIMUM_NEIGHBOURS` 限制；每日复盘容量由 `selectDailyReview` 统一裁剪，新增的 30 条 hold → 10 条的测试验证了这一点。迁移会临时复制多张表，但沿用了 0088 的既有做法。
- **不可撤销操作：** 自动 supersede 仍可通过 restore 恢复；hold 可 undo 或 confirm；迁移是不可逆的建表重建，但当前实现是先复制再删除，数据拷贝完整。确认后 undo 失败是 ADR 明确规定的，但 UI 没跟上（第 2 条）。
- **规则、说明文档与代码一致性：** prompt-prefix 规则要求后台调用固定内容在前、变化数据在后；本次只改后台整理提示词，没有改对话系统提示/工具/历史，符合规则。ADR 0220、rulebook H-17、迁移和代码主体一致；残留的是上面列的 schema 说明文字和测试 union。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及后台 `memory.consolidation` 的固定提示词和返回格式；对话系统提示、工具定义、历史消息都没有动。整理提示仍是固定指令在前、本次分组/记忆数据在后，新增的 `replace` 说明属于固定文本，每轮变化的分组和日期仍在数据段。依据 prompt-prefix 规则第 4、15 条，后台调用只影响之后的新整理调用。
   **结论：发给模型的内容仍只在末尾追加，每轮会变的值仍在数据部分/最后一条消息里。**

2. **会不会让同一段文字在不同请求里变成不同字节？** 没有发现本次改动新引入的确定性变化。`hold` 不改记忆正文；比较日期用 `validFrom ?? recordedAt ?? updatedAt`，生产记录创建时写入 `recorded_at`，更新时保留，所以正文和日期通常稳定。排序、分组仍按既有逻辑。唯一的理论风险是历史行 `recorded_at` 为 NULL 时回退到可变的 `updatedAt`，这可能导致同一段文字日期变化，但这不是本次改动新增的，也没有在真实旧库上核实。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有新增检查：P3-8 集成测试覆盖“replace 高置信度自动作废”“conflict 进 hold”“replace 但置信度不足进 hold”“replace 但 keep 标成旧条进 hold”；迁移测试覆盖 hold 被接受、未知 action 被 CHECK 拒绝、数据/信号保留；每日复盘测试覆盖 30 条 hold 只显示 10 条。反向用例是真实的：把 action 改成未知值会失败，hold 不合法时持久化会失败。
   **缺口：** 没有“确认后再整理”和“撤销后再整理”的用例（对应第 1 条）；迁移测试没覆盖另外五张依赖表（第 3 条）；没有控制中心 hold 确认/撤销的 UI 用例（第 2 条）；没有 data-export 导入导出的 hold 往返用例。

4. **每个新值的使用处都能接受吗？** 生产路径基本都接受：`hold` 同时加入 `MemoryConsolidationAction`、`DECISION_OUTCOMES.consolidation`、SQLite `ACTIONS`、`memory_consolidation_changes.action` CHECK、`decision_ledger` outcome CHECK、data-export `CONSOLIDATION_SCHEMA`、网关契约的三处 action 枚举和三种语言的 i18n。`consolidation_hold` 原因码长度和账本校验通过；`autoCommitThreshold` 从 application 包导出并被 consolidation 使用；`replace` 只在提示词和解析器中使用，解析器已接受。
   **未发现生产校验两端不一致。** 残留是说明文字和测试辅助 union 没加 hold（第 4 条），不影响运行。
