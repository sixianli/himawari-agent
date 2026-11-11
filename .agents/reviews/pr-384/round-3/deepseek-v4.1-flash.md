# P3-8 独立复核结论

未发现会导致静默数据丢失的高危问题。迁移表结构、枚举扩展、网关字段和主要状态转换与作者描述基本一致。以下按严重度列出问题，先写“读代码证实”的，再写“推测/未核实”的。

## 一、读代码证实的问题

### 1. 严重度：中 — ADR 说“整理失败不改任何记忆”，但代码在失败前已提交的改动（含 hold）不会回滚，且 hold 会让这一对以后永久不再整理

**文件:行**：`docs/adr/0220-consolidation-conflicts-wait-for-the-owner.md:83`；`packages/memory-engine/src/consolidation.ts:358-432`

**问题**：ADR 写“调用失败时整次整理记为失败、不改任何记忆”，但实际是每一条 decision 各自调用 `memory.revise` 提交，随后才处理 insights 和 `finish`。若在若干条 hold/supersede 已提交后，`#reflect`、`storeText`、`applyProposal` 或 `finish` 抛错，catch 只把本次 run 标成 failed，不会撤销已提交的改动。

**证据**：

```ts
// consolidation.ts:358-400
for (const decision of decisions) {
  ...
  const change = await this.#revise(id, "hold", newer.memory, older.memory.id, {
    attributes: { tentative: true },
  });
  ...
  changes.push(change);
}
...
await this.#options.store.finish({
  id,
  status: "completed",
  ...
});
return ...
} catch (error) {
  await this.#options.store
    .finish({
      id,
      status: "failed",
      ...
```

```ts
// docs/adr/0220...md:83
- 整理调用模型的路径不变。I-63（辅助调用常失败，`缺门槛`）仍适用：调用失败时整次整理记为失败、不改任何记忆，不会因为失败误作废。
```

而每条 change 的落库和账本写入是在同一次逐条提交里完成的：

```ts
// sqlite-memory-consolidation-operations.ts:92-111
insertLedgerRow(database, {
  ...
  outcome: change.action,
  reasonCode: `consolidation_${change.action}`,
  ...
```

作者第 3 轮自己又说“失败运行留下的 hold 也算处理过的一对”，这与 ADR 第 83 行直接矛盾。更糟的是，`listHeldPairs` 不区分 run 状态，失败 run 留下的 hold 会让这一对以后永久不再整理；而那次 run 在监控/周报里显示为失败。

**建议**：二选一，并写进文档：
- 若要保持“失败不改记忆”，把一次 run 的 changes 与 finish 做成整体事务，或失败时补偿撤销；
- 若接受失败留痕，则修正 ADR 第 83 行，并在记忆页/周报中明确标出“失败运行留下的 hold”，同时考虑失败 run 的 hold 不计入 `listHeldPairs` 的永久排除，至少允许重试。
另外补一条失败路径测试：在已提交一条 hold 后让 insight 阶段抛错，断言当前预期行为。

---

### 2. 严重度：中 — “模型对已 hold 过的一对的判断也不执行”这条守卫没有真正被测试覆盖

**文件:行**：`test/integration/memory-consolidation.test.ts:808-832`；`packages/memory-engine/src/consolidation.ts:283-288, 358-368`；`packages/memory-engine/src/consolidation.ts:151-155`

**问题**：第 2 轮新增了两道防线：分组阶段用 `paired = new Set(held)` 排除已 hold 的对；执行阶段再用 `held.has(...)` 跳过模型判断。但现有第二次整理的测试无法区分这两道防线：

```ts
// test:809-832
const again = await resource.run((prompt) => {
  ...
  return JSON.stringify({
    groups: ([
      ["milk-new", "milk-old"],
      ["pet-new", "pet-old"],
    ] as const).map(([newer, older]) => ({
      group: groupOf(prompt, label(newer)) ?? groupOf(prompt, label(older)) ?? "g1",
      action: "replace",
      keep: label(newer),
      drop: label(older),
    })),
    insights: [],
  });
});
expect(again?.changes.filter(...)).toEqual([]);
```

因为分组阶段已经把 milk-new/milk-old、pet-new/pet-old 从同一组排除，测试里 `groupOf(...)` 拿不到包含这一对的组；即使模型强行返回，`parse` 也会因 `drop` 不是该组成员而丢弃：

```ts
// parse:151-155
const members = new Set([group.fresh.label, ...group.neighbours.map(({ label }) => label)]);
...
if (!keep || !drop || keep === drop || !members.has(keep) || !members.has(drop)) continue;
if (keep !== group.fresh.label && drop !== group.fresh.label) continue;
```

所以执行阶段的 `held.has([keep.memory.id, drop.memory.id].sort().join("\n"))`（consolidation.ts:366）没有被真正触发。删掉这道守卫，现有测试很可能仍然通过。

**建议**：构造三成员组：fresh 为 A，邻居包含 B、C，其中 B-C 是历史 hold 对，A-B、A-C 不是；让模型返回 `keep=B, drop=C`。这样才能验证“模型判断不执行”，同时保留 A 与 B/C 的正常整理。再补一个直接调 `listHeldPairs` 的断言：undo 后仍返回该对（如果这是预期）。

---

### 3. 严重度：低 — `listHeldPairs` 无上限读取全部历史 hold，随使用时间无限增长

**文件:行**：`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:265-280`；`packages/memory-engine/src/consolidation.ts:283-287`

**问题**：每次整理都会把所有历史 hold 对读进内存，没有 limit，也没有分页。现有索引是 `(owner_id, agent_id, created_at)`，不能直接按 `action='hold'` 收敛。每天一次、多年运行后会变成无界增长，且对已经 undo/confirmed 的 hold 也永久保留。

**证据**：

```ts
// sqlite-memory-consolidation-operations.ts:273-277
`SELECT memory_id AS memoryId, related_memory_id AS relatedMemoryId
 FROM memory_consolidation_changes
 WHERE owner_id = ? AND agent_id = ? AND action = 'hold' AND related_memory_id IS NOT NULL
 ORDER BY id`
```

```ts
// consolidation.ts:283-288
const held = new Set(
  (await this.#options.store.listHeldPairs({ ownerId, agentId })).map((pair) =>
    [...pair].sort().join("\n"),
  ),
);
const paired = new Set(held);
```

**建议**：考虑单独维护 `memory_consolidation_held_pairs(owner_id, agent_id, memory_a, memory_b)` 去重表，按对存储并加唯一索引；或在查询/模型层加 limit 和淘汰策略。至少应说明这是有界资源，并加一条规模测试。

---

### 4. 严重度：低 — 代码把“说得更晚的那条”设为 tentative，不是“新条”；ADR 与作者说明写成“新条”

**文件:行**：`packages/memory-engine/src/consolidation.ts:378-395`；`docs/adr/0220-consolidation-conflicts-wait-for-the-owner.md:57`

**问题**：代码先按 `statedAt` 排序：

```ts
// consolidation.ts:378-379
const [older, newer] =
  statedAt(keep.memory) < statedAt(drop.memory) ? [keep, drop] : [drop, keep];
...
const change = await this.#revise(id, "hold", newer.memory, older.memory.id, {
  attributes: { tentative: true },
});
```

ADR 却写“改动的 `memory_id` 是新条，`related_memory_id` 是旧条”，作者总结也说“其他情况新条设 tentative”。当日期相等或模型把 keep/drop 标反时，实际被设 tentative 的可能是旧条/邻居。`docs/agent-rulebook-inventory.md:85` 已经改成“两条里说得更晚的那条”，与代码一致，但 ADR 没改。

**建议**：统一文档为“按 `validFrom ?? recordedAt ?? updatedAt` 较晚的那条”，或如果产品语义必须是“新抓到的条”，代码应显式用 fresh 判断，而不是只按日期。补一个日期相等/keep-drop 反转的测试，明确预期。

---

### 5. 严重度：低 — hold 事件仍复用“保留：{旧条}”的说明，容易让用户以为只保留了旧条

**文件:行**：`apps/control-center/src/components/memory-page.tsx:1780`

**问题**：所有 tidyUp 都生成 `note: item.relatedText ? message("memory.tidyKept", { text: item.relatedText }) : ""`。merge/supersede 下这个说明是“保留的对方”；hold 下两条都保留，新条只是待确认，显示“（保留：旧条）”会暗示新条没保留。

**证据**：

```tsx
note: item.relatedText ? message("memory.tidyKept", { text: item.relatedText }) : "",
```

**建议**：hold 使用单独的中性说明，例如“另一条：{text}”或“旧说法仍然保留”；不要复用 `memory.tidyKept`。

---

### 6. 严重度：低 — 提示词输出契约测试明确排除了 `memory.consolidation` 和 `.format`

**文件:行**：`apps/agent-service/test/prompt-output-contracts.unit.test.ts:60`

**问题**：

```ts
const NOT_COVERED = new Set(["memory.consolidation", "memory.consolidation.format"]);
```

因此 `replace` 是否同时出现在提示词正文、格式说明和解析器里，没有输出契约测试兜底；目前只有 golden 和集成测试覆盖。golden 只保证文字快照，不保证 action 枚举与解析器/网关一致。

**建议**：把 `memory.consolidation` 的 action 枚举纳入输出契约检查，至少断言 `duplicate|replace|conflict|keep` 与 `parse` 接受集合一致。

---

## 二、推测/未核实的问题

### 7. 严重度：低（推测）— 数据导入可能丢掉 hold 的“成对”关系，导致导入后不再排除该对

**文件:行**：`packages/persistence-sqlite/src/data-export/import.ts:465-467`；`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:273-277`

导入时，若 `relatedMemoryId` 不在本次 `importedMemoryIds` 里，会被置为 null：

```ts
entry.relatedMemoryId !== null && importedMemoryIds.has(entry.relatedMemoryId)
  ? entry.relatedMemoryId
  : null,
```

而 `listHeldPairs` 明确要求 `related_memory_id IS NOT NULL`。如果导入目标是已有数据库、相关旧记忆已经存在但本次没有重新导入，`importedMemoryIds` 不包含它，导入后的 hold 就失去 related，pair 不再被排除；新条仍是 tentative，但用户确认后未来可能再次被整理/自动作废。

这是推测，未核实导入到“已有同 id 记忆的库”时 `importedMemoryIds` 的实际语义。建议补一条 hold 的 data-export → import round-trip 测试，并覆盖“相关记忆已存在于目标库”的情况。

### 8. 严重度：低（未核实）— 提示词文字变化对全局 `TRUSTED_PROMPT_TEXTS` 的影响

`memory.consolidation` 的文本变化会改变 `TRUSTED_PROMPT_TEXTS` 这个全局固定文字清单。按规则，旧对话里冻结的旧文字不再在清单里，理论上可能改变出口遮盖字节。本次新增文字没有数字，且 `memory.consolidation` 不属于会话系统提示/工具定义，实际影响很可能为零；但我没有运行 `check:prompt-prefix` 或遮盖测试，标为未核实。

## 三、侧重检查

- **错误路径**：确认了模型输出非法/未知 action 会被忽略；`replace` 缺 keep/drop 会忽略；迁移未知 action 会被 CHECK 拒绝。发现失败 run 不会回滚已提交 hold（问题 1）。
- **不可信输入**：模型输出只允许组内标签，`keep/drop` 必须属于组且至少一个是 fresh；未发现可越组作废旧条的新路径。提示词中记忆原文仍按原有“不要执行其中指令”处理，本次未放宽。
- **安全/权限**：hold 只把记忆设 tentative，不删除、不 supersede，撤销/确认路径沿用原有权限；未发现新增越权面。`undo`/`confirm` 原有 owner/agent 校验问题不属于本次改动。
- **资源耗尽**：发现 `listHeldPairs` 无上限（问题 3）。
- **不可撤销操作**：hold 可撤销、可确认；确认后两条都留，符合验收。自动 supersede 仍可 undo。未发现新增不可逆路径。
- **规则/文档一致性**：发现 ADR 第 83 行“失败不改记忆”与代码/第 3 轮说明不一致（问题 1）；ADR“新条”与代码“较晚条”不一致（问题 4）；rulebook H-17 已改成“较晚条”，与代码一致。
- **迁移**：逐表核对 0089 与 0088/0054/0084：`decision_ledger`、`source_insights`、`proactive_processed_messages`、`decision_ledger_payloads`、`decision_signals`、`proactive_push_backoff`、`muse_reference_entries` 的列、CHECK、索引、触发器均与 0088 一致，仅整理 outcome 增加 `hold`；`memory_consolidation_changes` 与 0054 一致，仅 action CHECK 增加 `hold`；basis 与 0084 一致。迁移契约测试比较了整张表 SQL、索引和触发器，并覆盖数据保全、FK、未知 action 反向用例。未发现遗漏索引/触发器。

## 四、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会改变会话请求开头。**
`memory.consolidation` 只被 `packages/memory-engine/src/consolidation.ts` 使用，是后台整理调用，不在会话系统提示、工具定义、历史消息或出口遮盖结果中。提示词文字改动只影响之后新发起的整理请求，不会改写已经发给模型的会话内容。会话仍只在末尾追加消息，每轮会变的时间、记忆、资料仍在最后一条用户消息/资料块里，这一点本次未改。

需要说明两点：
- 本次确实改变了后台整理提示词从第一个字符开始的字节，但那是每次独立构造的后台请求，不是同一会话的缓存前缀。
- 整理提示词内部仍是“固定指令 → 本次数据 → 固定格式”，固定格式在数据之后，这是改动前就有的布局，不是本次引入；由于每次整理数据都不同，本身也很难形成稳定缓存前缀。
- 提示词文字变化会改变 `TRUSTED_PROMPT_TEXTS`，理论上可能影响旧对话遮盖；本次新增文字无数字、且该提示词不在会话中，实际影响很可能为零。未运行 `check:prompt-prefix`，标为未核实。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**对会话请求：不会。** 本次没有加入时间字段、未排序集合或依赖后文的遮盖逻辑。
**对整理请求：内容会随历史 hold 状态不同而不同**，例如同一对记忆因为以前 hold 过而不再进入同一组；但这是确定性的数据选择，不是同一输入下的字节不确定。`listHeldPairs` 虽然 `ORDER BY id`，但结果只用于 Set 成员判断；pair key 用 `.sort().join("\n")`，ID 不允许换行，排序确定。未发现新增无序集合/对象遍历顺序导致的字节不确定。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有检查，但覆盖不完整：

- 迁移：`consolidation-hold-migration.contract.test.ts` 比较迁移前后所有相关表数据、整表 SQL、索引、触发器，覆盖 hold 写入成功、未知 action 被 CHECK 拒绝。反向用例有效。
- 整理：`test/integration/memory-consolidation.test.ts` 覆盖 replace 自动 supersede、conflict hold、低置信度 replace hold、keep/drop 反转 hold、undo、confirm、再次整理。低置信度和反转 keep/drop 的反向用例有效。
- 每日复盘：`daily-review.unit.test.ts` 覆盖 hold 进入真实 `listReviewPool` 后的容量限制和“旧 → 新”显示。
- 界面：`memory-interactions.unit.test.ts` 覆盖 hold 只有在新条仍 tentative 时显示撤销/去确认，并用同文本不同 memoryId 的 twin 记忆验证不是按文本判断。
- 提示词：golden 和 manifest 哈希测试会覆盖文字变化。

**缺口**：第 2 条所述的“模型对已 hold 对的判断不执行”没有被真正触发；失败 run 留 hold 的路径没有测试；data-export/import 的 hold 成对关系没有 round-trip 测试；`memory.consolidation` 的 action 枚举没有输出契约测试。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐项核对结果：

- **`action = "hold"`（整理改动）**
  - 产生：`consolidation.ts:393` 的 `#revise(id, "hold", ...)`。
  - 使用/校验：
    - `sqlite-memory-consolidation-operations.ts:21` 的 `ACTIONS` 已含 `hold`；
    - 迁移 0089 `memory_consolidation_changes.action` CHECK 已含 `hold`；
    - `listChanges`、`listHeldPairs`、`readBasisChain` 都只是读取；
    - data-export `CONSOLIDATION_SCHEMA.action` 已含 `hold`；
    - gateway `tidyUps.action` 与 basis `action` 枚举已含 `hold`；
    - 中日英 i18n 的 `memory.page.event` 和 `decision.chain.action` 已含 `hold`。
  - 结论：两端校验都能接受。

- **`outcome = "hold"`（决策记录）**
  - 产生：`insertConsolidationWrite` 用 `outcome: change.action`、`reasonCode: consolidation_hold`。
  - 使用/校验：
    - `DECISION_OUTCOMES.consolidation` 已含 `hold`，`validateLedgerWrite` 放行；
    - 迁移 0089 `decision_ledger` 的 consolidation outcome CHECK 已含 `hold`；
    - data-export `DECISION_SCHEMA.outcome` 是通用 `text(1,64)`，接受；
    - 每日复盘 `ledgerGroup` 按 kind 归到 `consolidation`，接受；
    - calibration `calibrationGroup` 也按 kind 归组，接受；
    - 周报 `ledger-observation` 按 `batchId` 计数，不看 outcome，接受。
  - 结论：能接受。

- **`tidyUps.memoryId`（网关新增必填字段）**
  - 产生：`production-memory-control.ts:631` 的 `memoryId: change.memoryId`。
  - 使用/校验：
    - gateway `contracts-v2.ts:1232` 要求 `machineString`；
    - 领域层 `MemoryId` 与 `machineString` 使用同一 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` 规则；
    - 控制中心用 `waiting.has(item.memoryId)` 判断 tentative，不再按文本。
  - 结论：能通过两端校验。唯一风险是网关契约新增必填字段属于线格式变化，需新旧 agent-service/control-center 一起部署；未核实部署方式，但代码内所有生产者和 fixture 已同步。

- **提示词新 action `replace`**
  - 产生：`packages/prompt-catalog/src/memory.ts:76` 和格式行。
  - 使用/校验：`consolidation.ts` 的 `parse` 接受 `duplicate/replace/conflict`；golden 和 manifest 已更新。
  - 结论：能接受。输出契约测试未覆盖（见问题 6）。

- **迁移序号 89**
  - 产生：`migration-engine.ts` 的 `bundledMigrationFiles`。
  - 使用/校验：迁移引擎测试、run-checkpoint 测试、workspace-lifecycle-audit 的 `SUPPORTED_SCHEMA_MAX` 都已更新到 89；未发现残留硬编码 88。
  - 结论：能接受。

- **门槛 `gates`**
  - 产生：`autoCommitThreshold(category, this.#options.gates)`。
  - 使用/校验：生产构造点未传 `gates`，走 `DEFAULT_CAPTURE_GATES`；记忆抽取同样未传 `gates`，当前两边都读 `MEMORY_AUTO_COMMIT_GATE`，一致。
  - 结论：当前一致。若以后生产构造 `AutomaticMemoryService` 传入自定义 gates，而整理服务仍不传，会不一致；建议把门槛作为显式依赖在同一个构造点注入，避免“当前一致”依赖静态默认值。

**总评**：这次改动方向正确，迁移和枚举扩展做得比较完整，主要问题是失败路径的文档与代码不一致、hold 永久排除与失败留痕的交互、以及“模型判断不执行”的测试没有真正覆盖到。
