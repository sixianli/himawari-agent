## 上一轮意见核对

- 1（并发 `PORT_DUPLICATE`）：已修。`put` 失败后会再 `get`，若已有载荷则当作别人写的继续入队（`production-think-inbox.ts:154-170`）；新增并发测试。仍有残留竞态，见意见 1。
- 2（失败分支误删别人载荷）：已修。新增 `wrote` 标记和 `summaryReferenced`，只删“本次新写且无行引用”的载荷（`production-think-inbox.ts:153-197`）。仍有跨事务竞态，见意见 1。
- 3（结束后重提交又写无引用载荷）：净效果已修（写入后立即删除），但没有消除“先写再发现重复”的行为，见意见 3。
- 5（id/ref 不含主人/agent）：已修。`entryKey` 现在把 `ownerId/agentId` 纳入哈希（`production-think-inbox.ts:73-77`），id 38 字符、ref 46 字符，均满足 128/256 限制和 `payloads.ref` 全局主键。
- 6（运行时输入校验）：已修。非字符串字段和非布尔 `externalContent` 返回 `THINK_INPUT_INVALID`（`production-think-inbox.ts:128-135`）。`submit(null)` 仍会抛 `TypeError`（推测，未测试）。
- 9（文档说“结束就删”）：架构文档已改成 `maintain` 分批清扫；但仍有措辞问题，见意见 4。

## 侧重检查

- 错误路径：查了 `put` 重复、`enqueue` 失败、`maintain` 删除失败三条路径。`enqueue` 抛异常时没有清理本次载荷（意见 2）；`summaryReferenced` 失败被当作“有引用”、删除失败被忽略，方向是“宁可泄漏不误删”，安全。
- 不合规范/不可信输入：空摘要、未登记来源、超长 ref/version、错误类型都被拒；配置越界在 `parseThinkInbox` 的值域校验里（抽查 `strict-configuration.ts:1383-1400`）。但 `submit(null/undefined)` 仍会抛，且如果绕过配置层直接构造 `limits.queueLimit=0`，`enqueue` 的 `limit()` 会在载荷已写之后抛错（推测）。
- 安全/越权：所有 SQL 都带 `owner_id + agent_id`；`payloads` 在构造时按 scope 绑定；id/ref 含 scope，未发现跨主人冲突。
- 资源耗尽：队列/每日上限存在；新增的“先加密写载荷、再入队”在队列满或重复时也会做一次加密/写盘/删除，是一个小的写入放大面（意见 3）。
- 不可撤销操作：`payloads.delete` 是硬删除，靠 `ON DELETE SET NULL` 保证引用完整性；并发下仍可能清空别人刚插入行的摘要（意见 1）。
- 文档/规则一致性：见意见 3、4。
- 范围：本轮只读 `f8022df..1de821c` 增量涉及的 `production-think-inbox.ts`、`think-inbox.ts` 端口、`sqlite-think-inbox-operations.ts`、`durable-adapters.ts`、架构文档、测试，并跟到迁移、`payloads` 表、`putPayload`/`deletePayload`、配置解析和导出排除。

## 意见

### 1. 【中】同 key 的“失败清理”和另一条入队之间没有互斥，可能让已接受的条目丢掉摘要，或让入队抛外键错误

文件：`apps/agent-service/src/production-think-inbox.ts:154-197`、`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:124-181`、`packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:9`

问题：`#discardUnreferenced` 的“查引用 → 删载荷”和 `enqueue` 的“查重 → 插入行”不在同一个事务或锁里。两个同 key 提交交错时可能是这样：

1. A 写载荷 P，`enqueue` 返回 `queue_full`/`daily_limit`（未插入行）；
2. B 开始时 P 已存在（或 `put` 撞重复），所以 `wrote=false`；
3. 这两次 `enqueue` 之间若有 worker `claimNext`/`finish` 腾出队列空位，或跨过本地午夜，B 的 `enqueue` 会插入一行 `summary_ref=P`；
4. A 随后删 P。

若 B 先插入，外键 `ON DELETE SET NULL` 会把 B 的 `summary_ref` 置空，B 仍返回 `accepted`，但摘要没了；若 A 先删，B 的 INSERT 会因 `summary_ref NOT NULL REFERENCES payloads(ref)` 失败，`submit` 抛出系统错误而不是返回 `THINK_QUEUE_FULL`。

证据：

```ts
// production-think-inbox.ts:184-197
if (outcome.outcome === "queued") return { accepted: true, entryId: id, duplicate: false };
if (wrote) await this.#discardUnreferenced(summaryRef);
...
const referenced = await this.#options.store
  .summaryReferenced({ ...this.#options.scope, summaryRef })
  .catch(() => true);
if (!referenced) await this.#options.payloads.delete(summaryRef as never).catch(() => false);
```

```sql
-- 20261115004401_think_inbox.sql:9
summary_ref TEXT REFERENCES payloads(ref) ON DELETE SET NULL,
```

推测：上述交错时序是推演，未实际运行；单进程下等待 `summaryReferenced`/`delete` 的异步间隙足以让另一条提交进入 `enqueue`。PR 目前没有 worker 调用 `claimNext`/`finish`，接线后条件才成立。

建议：对同一个 `summaryRef` 串行化整个 `submit`（服务有单一 authority lease，进程内 keyed mutex 就够），或把“写载荷 + 入队 + 清理”放进同一持锁区间；更简单的方向是失败时完全不删，改由按年龄清扫“没有行引用的 `think-summary:%` 载荷”。

### 2. 【中/低】`put` 成功但 `enqueue` 抛异常或进程崩溃时，会留下永远没人清扫的孤立摘要载荷

文件：`apps/agent-service/src/production-think-inbox.ts:153-183`、`apps/agent-service/src/production-think-inbox.ts:218-231`

问题：载荷写入和入队是两步，中间没有 `try/finally`。`enqueue` 会调用 `assertDiskHeadroom()`，也可能因本地日期/时区计算、数据库错误抛异常；进程在这两步之间崩溃同样如此。此时载荷没有对应的 `think_inbox` 行，`maintain` 的 `settledSummaries` 只从 `think_inbox` 里找已结束且 `summary_ref IS NOT NULL` 的行，永远看不到它。

证据：

```ts
// 写载荷
await this.#options.payloads.put(...);
wrote = true;
...
// 入队，未包 try/finally
const outcome = await this.#options.store.enqueue({ ... });
```

```ts
// maintain 只清扫表里有指针的已结束行
const settled = await this.#options.store.settledSummaries({ ... });
for (const { id, summaryRef } of settled) {
  const gone = await this.#options.payloads.delete(summaryRef as never)...
```

读代码证实：上述控制流确实会留下无行引用的载荷。`git grep` 没有找到通用的 `think-summary` 净扫器（未穷尽整个仓库，但导出、治理删除之外未见）。

建议：给 `enqueue` 包 `try/catch`，失败且本次新写时走 `#discardUnreferenced`；再加一个按年龄的孤儿清扫，处理崩溃窗口。

### 3. 【低】作者说法“重复提交不新建摘要载荷”不成立：载荷被清扫后再提交会重新加密写一份、再删掉

文件：`apps/agent-service/src/production-think-inbox.ts:153-186`、`test/integration/think-inbox.test.ts:187-206`

问题：代码在知道是否重复之前就写载荷。正常重复（载荷还在）不会写；但条目已结束、`maintain` 已删载荷后，同一来源版本再提交时 `get` 返回空，代码会 `protect + put` 一份新载荷，`enqueue` 返回 `duplicate`，然后 `#discardUnreferenced` 再把它删掉。队列满/每日满额的提交也都会先加密写盘一次。

证据：

```ts
if (!(await this.#options.payloads.get(summaryRef as never))) {
  await this.#options.payloads.put(await this.#options.protector.protect({ ... }));
  wrote = true;
}
...
if (wrote) await this.#discardUnreferenced(summaryRef);
if (outcome.outcome === "duplicate") return { accepted: true, ... duplicate: true };
```

影响：最终状态正确（测试断言 0 份载荷），但“重复提交不新建载荷”的说法与代码不符，且每个被拒/重复提交都产生一次加密和一次数据库写；外部来源可制造大量不同 ref 的重复提交。

建议：先查询是否已有同 key 的条目，重复就直接返回，不再写载荷；或至少修正作者说明/文档。若要保留当前顺序，明确写成“重复提交可能临时写一份再删”。

### 4. 【低】文档说删载荷后“表里只留指针”，实际 `clearSummary` 把指针置成 NULL

文件：`docs/architecture-v0.1.md:436`、`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:343-353`、`apps/agent-service/src/production-think-inbox.ts:222-231`

问题：架构文档写“由 `maintain` 清扫时……删载荷，表里只留指针”。实际 `maintain` 删除载荷成功后会调用 `clearSummary`，把 `summary_ref` 设为 NULL；负载删掉后，表里连指针也不留。另 `schema-catalog.ts:725` 仍写“cleared once the entry settles”，没有说明是 `maintain` 每批 50 条清扫。

证据：

```ts
// maintain
if (gone)
  await this.#options.store.clearSummary({ ...this.#options.scope, id, summaryRef }).catch(...);
```

```sql
UPDATE think_inbox SET summary_ref = NULL
WHERE owner_id = ? AND agent_id = ? AND id = ? AND summary_ref = ?
  AND status IN (..., 'expired')
```

建议：把文档改成“删载荷后把 `summary_ref` 置空，行本身保留用于去重”，并同步 `schema-catalog` 的“由 `maintain` 分批清理”说明。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 这个 PR 不调模型，增量没有改系统提示、工具定义、历史消息或遮盖结果；发给模型的内容没有任何新增，也不存在“每轮会变的值”。题述“只在末尾追加”的规则在本轮不涉及。依据：增量文件不含提示/工具/消息构造。

2. **不会让同一段文字在不同请求里变成不同字节。** 增量没有改任何发给模型的文本。`entryKey` 只由 `ownerId/agentId/sourceKind/sourceRef/sourceVersion` 决定，不含时间、不依赖前后文、没有无序集合；摘要载荷的密文字节每次保护都随机，但那是存储层，不是模型输入。

3. **有自动检查，反向用例在旧代码上会失败。** 新测试覆盖：并发同 key（旧代码会在 `put` 抛 `PORT_DUPLICATE`）、条目结束后重提交不留载荷（旧代码会留 1 份）、队列满只保留已排队那份、错误类型输入（旧代码会接受或抛 `TypeError`）、`usage.thinking`（旧字段缺失）。覆盖缺口：没有测“崩溃/入队抛异常后的孤儿载荷”，也没有测意见 1 的“队列腾位 + 失败清理”交错；没有一条测试显式断言重复提交不消耗每日上限。受工具限制未执行测试，以上按代码路径判断。

4. **增量产生/修改的值逐个核对过：**
   - `ThinkInboxStorePort.summaryReferenced`：产生端 `production-think-inbox.ts:193-197` 传 `{ownerId,agentId,summaryRef}`；使用端 `durable-adapters.ts:1064` 路由到 `thinkInbox.summaryReferenced`，`sqlite-think-inbox-operations.ts:67-68` 分发，`332-340` 用 `text(summaryRef, 256)` 校验并按主人/agent 过滤。实际 ref 为 `think-summary:` + 32 hex = 46 字符，能通过；与 `payloads.ref` 全局主键也兼容，因为哈希已含 scope。
   - `ThinkInboxUsage.thinking`：SQL 在 `sqlite-think-inbox-operations.ts:267-274` 产生，端口在 `think-inbox.ts:35` 声明；除测试外没有别的使用端，界面/后续运行尚未接，`usage` 返回额外的 `thinking` 不会破坏现有调用方。
   - `entryKey`/id/ref 加入 scope：只被 `production-think-inbox.ts:145-152` 使用；id 38 字符 ≤ 128，ref 46 字符 ≤ 256，配合迁移里的 CHECK 和 `UNIQUE(owner_id, agent_id, source_kind, source_ref, source_version)` 一致。
   - 配置键 `runPolicy.thinkInbox`、迁移、导出：不在本次增量内，只做了抽查；导出代码没有引用 `think_inbox`，临时队列未进入数据导出。
   - 文档两处与代码不完全一致，见意见 3、4。
