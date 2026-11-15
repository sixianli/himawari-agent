## 结论

说明：本次只读代码，没有运行测试，也没有修改任何文件。以下“已证实”都来自我亲自读到的代码；无法仅靠代码确认的放在“推测/未核实”。

---

### 高 | `apps/agent-service/src/production-proactive.ts:939-950` | `clear_records` 绕过来源登记校验，而且清空的是全部来源的数据

**问题**：作者说法 10 称 `proactive.source.manage` 会拒绝没登记的来源，但 `clear_records` 分支在查登记表之前就返回了。

**证据**：

```ts
// apps/agent-service/src/production-proactive.ts:939
case "proactive.source.manage": {
  if (command.payload.action === "clear_records") {
    const released = await store.clearRecords(scope);
    if (released.length > 0) await seal.release({ ...scope, refs: released });
    return { resultRef: "proactive-cleared", replayed: false };
  }
  const managed = this.#registry.get(command.payload.source);
  if (managed === undefined)
    throw new ApplicationPortError(... "PROACTIVE_SOURCE_NOT_REGISTERED");
```

而网关这一版已经把 `source` 从只允许 `gmail` 放宽成任意合法名字：

```ts
// packages/gateway-contracts/src/contracts-v2.ts:956
const proactiveSourceManageCommandSchema = object({
  ...commandEnvelope("proactive.source.manage"),
  payload: object({
    source: proactiveSourceName,
    action: enumeration(["disconnect", "clear_records"]),
  }),
});
```

`clearRecords` 本身也不按来源过滤，会删掉该 owner/agent 下全部 proactive 记录：

```ts
// packages/persistence-sqlite/src/sqlite-proactive-operations.ts:712
private clearRecords(scope: ProactiveScope): readonly string[] {
  return this.database.transaction(() => {
    const refs = this.collectRefs(scope, null);
    ...
    for (const table of ["source_insights", "proactive_processed_messages",
      "proactive_pushes", "proactive_push_backoff"])
      this.database.prepare(`DELETE FROM ${table} WHERE owner_id = ? AND agent_id = ?`).run(...);
```

所以现在 `{"source":"test_notes","action":"clear_records"}` 能通过网关（名字格式合法），也会被生产端接受，并清空所有 proactive 记录。相对改动前，这是一个新放宽：以前网关只接受 `gmail`。这属于不可撤销操作，且与作者说法 10 不符。

**建议**：在 `clear_records` 分支之前同样执行 `this.#registry.get(command.payload.source)` 并拒绝未登记来源；更彻底的做法是让 `clear_records` 按来源清理，或拆成独立的全局清理命令并明确语义。补一条反向用例：未登记来源 + `clear_records` 必须被拒绝，且库里数据条数不变。

---

### 中 | `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:291-350` | `writeSourceSettings` 并不在同一个数据库事务里写 `limit_change` 和设置

**问题**：作者说法 11 称修改上限时会在同一个数据库事务里写 `limit_change` 决策记录，代码没有这样做。

**证据**：

```ts
// packages/persistence-sqlite/src/sqlite-proactive-operations.ts:291
private writeSourceSettings(input: Input<"writeSourceSettings">): void {
  ...
  for (const key of ["perDay", "perCheck"] as const) {
    if (current[key] === input[key]) continue;
    insertLedgerRow(this.database, { id: `${input.changeId}:${key}`, ... });
  }
  this.database.prepare(
    `INSERT INTO proactive_source_settings (...) VALUES (...)
     ON CONFLICT (...) DO UPDATE SET ...`,
  ).run(...);
}
```

该方法内部没有 `this.database.transaction(...)`；SQLite worker 的默认分支是直接 `durableOperations.execute(...)`，而 `SqliteDurableOperations.execute` 也只是转调，不会自动开事务：

```ts
// packages/persistence-sqlite/src/sqlite-worker.ts:1110
value = durableOperations.execute(request.operation, request.payload);

// packages/persistence-sqlite/src/sqlite-durable-operations.ts:549
execute(operation: string, payload: unknown): unknown {
  if (this.database.inTransaction || !isProcessRecordWrite(operation, payload))
    return this.executeOperation(operation, payload);
  ...
}
```

同文件其他写操作（如 `removeSource`、`record`）都显式用了 `this.database.transaction(...)`，这里没有。

**后果**：如果第一条或第二条 `insertLedgerRow` 成功后进程崩溃、磁盘写失败等，设置表仍是旧值，但决策账本已经有“上限已改”的记录；重试还会再写一次新的 `limit_change`，造成审计记录与实际设置不一致。

**建议**：把整个 `writeSourceSettings` 包进一个事务：`return this.database.transaction(() => { ... })()`。最好补充一个故障注入测试：在 ledger 写入后、settings upsert 前抛错，断言两者都没有提交。

---

### 中 | `packages/application/src/services/proactive-source-runtime.ts:156-177`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:959-965` | 程序写入的“同一编号不重复记”和“每日上限”不是原子操作

**问题**：作者说法 7 的“同一编号不重复记、超过每天上限不记”只在串行调用下成立。`unprocessed`/`processedSince` 检查和 `store.record` 是分开的两次数据库请求，中间没有锁或事务。

**证据**：

```ts
// packages/application/src/services/proactive-source-runtime.ts:156
const fresh = await store.unprocessed({ ...scope, source: entry.source, messageIds: [entry.entryId] });
if (fresh.length === 0) return { kind: "not_recorded", reason: "already_recorded" };
...
const usedToday = await store.processedSince({ ...scope, source: entry.source, since: ... });
if (usedToday >= sourceSettings.perDay) { ... return { kind: "not_recorded", reason: "daily_limit" }; }
...
const recorded = await store.record({ ... });   // :223
```

持久层插入 processed 行时是 `ON CONFLICT DO NOTHING`，但即使没插入，决策、insight、push 仍然会创建：

```ts
// packages/persistence-sqlite/src/sqlite-proactive-operations.ts:959
const insertProcessed = this.database.prepare(
  `INSERT INTO proactive_processed_messages (...) VALUES (...)
   ON CONFLICT (owner_id, agent_id, source, message_id) DO NOTHING`,
);
...
const inserted = insertProcessed.run(...).changes;
```

两个并发调用同一 `entryId` 时，都可能通过前面的 `unprocessed`，第二个调用仍会写入一条新的 decision、更新/插入 insight，并创建一个新的 push。每日上限同理可能被并发越过。

**状态说明**：这两次独立数据库请求的代码路径已读代码证实；“实际会不会并发”取决于调用方。当前生产还没有 `recordEntry` 调用方，所以现网影响暂未发生，但这是给后续“别的程序写入条目”预留的接口。

**建议**：把去重和每日上限检查放进 `store.record` 的同一个事务里，或利用唯一约束判断插入结果，冲突时返回 `already_recorded`；必要时对 `recordEntry` 做单飞/串行化。补一条并发测试。

---

### 低 | `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:298-309`、`packages/persistence-sqlite/src/migrations/0097_proactive_source_registry.sql:20` | `changeId` 允许 128 字符，但决策 id 还会再加后缀，超过表校验上限

**问题**：I-73 那类“清单里的 id 能通过后端校验吗”在这里有一处不一致。

**证据**：

```ts
// sqlite-proactive-operations.ts:298
typeof input.changeId !== "string" ||
input.changeId.length < 1 ||
input.changeId.length > 128
...
id: `${input.changeId}:${key}`,     // :309
```

```sql
-- 0097_proactive_source_registry.sql:20
id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
```

`changeId` 长度 122 到 128 时，拼上 `:perDay` 或 `:perCheck` 后超过 128，`insertLedgerRow` 又没有做友好的 id 校验，最后会以 SQLite CHECK 约束错误的形式冒出来，而不是 `Proactive source settings are invalid`。

**建议**：把 `changeId` 限制到 121 字符以内，或用哈希/随机 id 生成派生 id，并在 `insertLedgerRow` 前显式校验。

---

### 低 | `packages/application/src/services/proactive-source-runtime.ts:56-58` 与 `packages/application/src/services/proactive-mail-check-service.ts:904-911` | 限流用 `dedupKey`，邮件服务和存储用 `messageId`，两者未来可能不是同一个值

**问题**：`limitedSourceReader` 用登记表的 `dedupKey` 查“已处理”，而邮件判断服务和持久层用 `ProactiveMail.messageId`（即 `ProactiveSourceItem.id`）存储和查重。

**证据**：

```ts
// proactive-source-runtime.ts:56
const key = (item: ProactiveSourceItem<Extra>) => definition.dedupKey(item);
const fresh = new Set(
  await store.unprocessed({ ...scope, source, messageIds: fetched.items.map(key) }),
);
```

```ts
// proactive-mail-check-service.ts:904
const fresh = new Set(
  await store.unprocessed({ ...scope, source: reader.source,
    messageIds: fetched.items.map(({ messageId }) => messageId) }),
);
...
const items = fetched.items.filter(({ messageId }) => fresh.has(messageId));
```

`GMAIL_SOURCE.dedupKey` 正好返回 `item.id`，所以现在没有影响。但如果以后登记一个 `dedupKey !== id` 的读取型来源，限流器会按另一套 id 判断“已处理”，导致已处理条目继续占用额度、游标被不必要地停在原地。

**建议**：明确约束“读取型来源的 `dedupKey` 必须等于存储用的 `message_id`”，或者在限流和存储两端统一用 `item.id`，并在 `defineProactiveSources` 里对读取型来源做校验。

---

### 低 | `packages/persistence-sqlite/src/data-export/import.ts:117-129` | 导入的“已登记来源”是调用方传进来的白名单，不是目标实例的登记表

**问题**：作者说法 9 是“拒绝没登记的来源名”，但实现里的“登记”来自 `options.proactiveSources`，默认才是应用的 `PROACTIVE_SOURCE_NAMES`；调用方可以传任意名单。测试自己就利用这一点把 `test_notes` 导入一个默认只有 gmail 的目标库：

```ts
// test/integration/proactive-sources.test.ts:764
await importPortableExport(files, { ...options, proactiveSources: registry.names });
```

而导入写表是直接 INSERT，不经过 `SqliteProactiveOperations.source()` 的登记检查：

```ts
// import.ts:117
const proactiveSources: readonly string[] = options.proactiveSources ?? PROACTIVE_SOURCE_NAMES;
const registered = (value, where) => {
  if (value !== null && value !== undefined && !proactiveSources.includes(value as string))
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.LINE_INVALID, ...);
};
```

默认路径安全，生产 `admin-cli` 也没传这个选项；但 API 契约上“登记表”可以被调用方替换，和运行时登记表可能脱节。

**建议**：生产调用只用目标实例的登记表生成允许列表；如果保留测试覆盖，至少把选项改成测试专用或增加注释/校验，要求传入名单必须与当前 registry 一致。

---

### 低 | 说明与代码不一致的几处（规则/文档一致性）

1. **`proactive.sources.read` 的 `perCheck` 没有 `used` 和 `resetsAt`**
   `apps/agent-service/src/production-proactive.ts:632-643` 只有 `perDay` 带 `used`/`resetsAt`；`perCheck` 只有 limit/default/min/max/onReach。作者说法 11 如果理解为“两个上限都返回今天已用和清零时刻”，与实现不符。

2. **`groupKey` 目前没有任何消费者**
   `packages/application/src/ports/proactive-sources.ts:44` 定义、`:115` 校验，但仓库里搜不到使用点；`latestDeliveryMs`（`:47`）也只在登记和校验中出现，作者已说明最晚送达逻辑未做。

3. **迁移号 0097**
   约束写的是“0097 是占位，合并时改号”，本次仍使用 0097。当前基线最新是 0096，所以它是下一个号；但无法从仓库确认远端是否已有别的 0097，标为未核实。

4. **登记表没有登记“读取器”本身**
   登记项里只有 `intake: "reader"`，真正的读取器绑定在 `ProductionProactive` 的 `runners` 参数里（`apps/agent-service/src/production-proactive.ts:264-280`），不是登记表字段。作者说法 4 也承认读取器由运行器提供；如果任务说明里的“登记读取器”是指登记表直接持有读取器，这两者不一致。

---

## 推测 / 未核实

- **`recordProactiveProgramEntry` 并发重复**：代码上检查和写入确实分离；实际会不会重复取决于调用方是否并发，目前生产还没有调用方。未运行并发测试。
- **Observation port 没有超时**：`proactive-mail-check-service.ts:1796-1815` 在 `store.record` 之后 `await observations.receive(...)`，接收方如果卡住会拖住整次检查。生产当前没有接 observation port，所以现在不影响。
- **未来新增读取型来源时的检查入口仍然绑定 Gmail**：`ProductionProactive.overview()`、`#checkable()`、`packages/calibration`、`sqlite-decision-ledger-operations.ts:692`、`sqlite-observe` 等处仍有 `GMAIL_SOURCE` 硬编码。本 PR 明确“不登记新的真实来源”，所以不是当前 bug；但登记表并不能单独让新来源在总览/校准/检查里生效。
- **golden 对照是否真的由 baseline 提交生成**：`test/fixtures/proactive-gmail-request.golden.json` 是本 PR 新增文件，git 历史里没有旧版本可对比，无法从代码证实“在改动前提交上生成”。可证实的是本 PR 没有改提示词目录和 `proactivePrompt` 的文本，只改类型名。
- **`check-proactive-sources.mjs` 执行结果**：我没有运行测试，未核实 18 条是否实际全绿。脚本本身没有像同类检查那样传 `--project integration/contracts`；按 workspace 的 include 规则推断仍会匹配到对应项目，但未实跑。

---

## 侧重检查

我按“错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档/代码一致性”查了这些路径：

1. **未登记来源写入**：`saveConnection`、`markConnection`、`removeSource`、`unprocessed`、`readInsight`、`rateProcessed`、`markReviewed`、`validateDecision`、`processedSince`、`writeSourceSettings` 都经过 `source()` 或 `this.sources`。**结论：常规写路径有校验；`clear_records` 没有。**
2. **导入未登记来源**：`import.ts:117-129` 在任何写库之前检查 `proactiveSources` 白名单，`assertEmptyTarget` 也在写入前。**结论：默认路径有效；调用方可替换白名单是契约弱点。**
3. **非法程序条目**：`recordProactiveProgramEntry` 拒绝 `know`、`low`、空摘要、空/超长 entryId、非 `written_by_program` 来源。**结论：这些反向输入有程序校验；表本身仍允许 `know`/`low`，与作者说法 12 一致。**
4. **不可撤销操作**：`clear_records` 会删除 insight、processed、push、backoff 和全部 proactive 决策；`removeSource` 会删来源数据。**结论：`clear_records` 未按来源范围校验/过滤，是本轮最重要的风险。**
5. **资源耗尽**：安全上限有 `perDay`/`perCheck`，但 `recordProactiveProgramEntry` 没有限制 `summary`/`reason`/`link` 的长度，会直接 seal 成 JSON；当前没有生产调用方。**结论：潜在低风险。**
6. **提示词/模型请求**：相关 diff 只有类型名替换，没有提示词文本、工具定义或模型调用参数变化。**结论：Gmail 请求未被本 PR 改动；golden 能覆盖一个 Gmail 场景。**
7. **迁移安全**：`0097` 与 `0095` 的表结构差异只有来源名约束和新增 `proactive_source_settings`；迁移契约测试逐行比较 `TABLES` 中所有行，并比较 `sqlite_master` 的表/索引/触发器 SQL，还检查 `foreign_key_check`。**结论：从代码看保数据、保索引/触发器；实际测试未运行。**

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加、每轮变化值是否都在最后一条消息？

**不会改变，至少在 Gmail 这条路径上。** 依据：

- 本 PR 没有改 `packages/prompt-catalog`，`proactivePrompt` 仍是先放固定的 `MAIL_JUDGMENT.text`，再放 memories/summaries/items，最后放当前时间：
  ```ts
  // proactive-mail-check-service.ts:468-495
  return [
    MAIL_JUDGMENT.text,
    ...(summaries.length > 0 ? [...] : []),
    ...(memories.length > 0 ? [...] : []),
    ...(memories.some(({ tentative }) => tentative) ? [MAIL_JUDGMENT_TENTATIVE_NOTE.text] : []),
    MAIL_JUDGMENT_ITEMS_HEADER.text,
    JSON.stringify(items.map(...)),
    renderPrompt(MAIL_JUDGMENT_NOW, { now, timeZone, today }),
  ].join("\n");
  ```
- diff 只把 `ProactiveSourceItem` 类型改成 `ProactiveMail`，`proactivePrompt`、`baseMailView`、`relatedMailView` 的字段拼装逻辑没有语义变化。
- 新增的 `inputs.observations` 只写进决策记录（`store.record`），没有进入模型输入。
- golden 测试 `[iOS-7] sends the model the same Gmail judging request, byte for byte` 用 `{"prompts", "requests"}` 与 fixture 比较；请求里每轮会变的值本来就是 prompt 末尾的 `now`；没有系统提示/工具定义参与这条后台判断。

**但**：golden 只覆盖一个 Gmail 判断场景，且 fixture 的“改动前生成”无法从 git 历史证实；它比较的是 prompt 字符串和模型请求元数据，不是保存到 payload 的原始字节。因为 prompt 字符串就是输入文本，同编码下字符串相等即字节相等；这一点我认可。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**模型请求上没有发现新增的不确定性。** 本 PR 没有动出口遮盖、记忆选择、related 排序或 JSON 键顺序；`mailItem`/`mailOf` 只是字段搬移，`proactivePrompt` 又显式构造 JSON 字段顺序。Gmail 的 `dedupKey` 就是 `id`，没有改变提示词内容。

需要注意的非模型输出：

- `proactive.sources.read` 的 `generatedAt`、`resetsAt` 会随请求时间变化，但这是查询响应，不是模型请求。
- 来源列表按 registry 的插入顺序和 `Map` 迭代顺序生成，目前是确定的。
- `recordProactiveProgramEntry` 的 `limit_change` 记录按 `perDay`、`perCheck` 固定顺序写入。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有自动检查，设计上大部分反向用例是有效的；但我没有运行，不能确认实际全绿。**

- `packages/persistence-sqlite/test/proactive-source-registry-migration.contract.test.ts`：逐行比较所有被重建表的数据，比较 `sqlite_master` 的表/索引/触发器，检查 `foreign_key_check`，并用非法名字触发 CHECK。如果迁移漏了行/索引/触发器或放宽了错误方向，测试会失败。
- `test/integration/proactive-sources.test.ts`：覆盖未登记来源、缺 trust、重名、上限越界、程序条目非法输入、重复编号、导出导入拒绝等。删除对应校验后，这些 `toThrow` / `toEqual(not_recorded)` 会失败。
- `test/integration/proactive-production.test.ts`：覆盖缺 runner 抛 `PROACTIVE_SOURCE_READER_MISSING`、上限越界/未登记来源被拒、关来源不检查、golden 请求。
- `scripts/check-proactive-sources.mjs`：要求 18 个 `[iOS-7]` 测试名都通过；我核对了 18 个测试标题，名称能对上。

**反向覆盖缺口**：

- 没有测试 `{"source":"test_notes","action":"clear_records"}` 被拒绝；现有反向测试只测了 `disconnect`。
- 没有测试 `writeSourceSettings` 在 ledger 写入后失败时与设置写入的原子性。
- 没有测试并发调用 `recordProactiveEntry` 的重复/上限竞争。
- `check-proactive-sources.mjs` 没有像同目录其他检查那样显式指定 `--project`；按 workspace include 规则推断仍会跑对项目，但未实跑验证。

### 4. 每个新产生/修改的值，生产方和使用方的校验都对得上吗？

逐个核对的结果：

| 值 | 生产方 | 使用方 | 结论 |
|---|---|---|---|
| `source` 名字 | `GMAIL_SOURCE` / 未来登记表 | 网关 `proactiveSourceName`、DB CHECK、导入 schema、SQLite `source()` | 目前已证实一致：1–64 字符、`^[a-z][a-z0-9_]{0,63}$`、DB 用 GLOB 等价检查。 |
| 操作名 `proactive.sources.read` / `settings.set` / `switch_off` | `GATEWAY_V2_MESSAGE_TYPES` + `schemasByType` + `PRODUCTION_PROACTIVE_OPERATIONS` | 网关契约、生产 handler、`ci/operations-pending.json`、测试 | 已证实一致。 |
| `perDay` / `perCheck` | 登记表默认值、setting 行 | `proactiveSourceLimitsValid`、DB `per_day/per_check` CHECK、`limitedSourceReader` | 写入端一致；查询端 `perCheck` 没有 `used`/`resetsAt`，与作者说法 11 的宽泛表述不一致。 |
| `changeId` → `decision_ledger.id` | `writeSourceSettings` 允许 1–128 | migration `id` CHECK 1–128 | **不一致**：再加 `:perDay`/`:perCheck` 后可能超 128。 |
| `proactive.source.<source>.<limit>` | `proactiveSourceLimitKey` | `subjectRef`（≤256）、`inputs.limitChange.key`（≤128） | 名字最长 64，拼出来约 89 字符，能通过。 |
| `observations.handedOff/sink` | `ProactiveMailCheckService` | SQLite `validateInputs`、决策 inputs JSON、导出通用 object | 已证实能通过。 |
| `proactive_source_settings` | 迁移 + `writeSourceSettings` | `listSourceSettings`、`readProactiveSourceSettings`、查询/限流 | 已证实读写字段一致；表声明“never exported”，导出代码确实没引用它。 |
| `ProactiveObservation` | `#finish` 观测交接 | 仅 `ProactiveObservationPort`，生产未接 | 没有持久层消费者；`sourceId` 用的是 `threadId` 而不是 item id，测试把这个行为固化了，未来接收方若不接受就是新问题。 |
| `groupKey` / `latestDeliveryMs` | 登记表 | 未找到消费者 | `groupKey` 目前是死字段；`latestDeliveryMs` 作者已说明最晚送达逻辑未做。 |
| 导入白名单 `proactiveSources` | 调用方或默认 `PROACTIVE_SOURCE_NAMES` | `import.ts` 的 `registered()` | 默认安全；调用方传任意名单可绕开目标实例 registry，测试正是这样导入 `test_notes` 的。 |

**结论**：最需要先修的是 `clear_records` 绕过登记校验；其次是 `writeSourceSettings` 的事务与 `changeId` 长度；程序条目的并发去重/每日上限需要在下一次接真实写入方之前解决。
