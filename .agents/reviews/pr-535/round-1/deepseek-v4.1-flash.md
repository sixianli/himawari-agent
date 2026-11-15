我先查看当前的改动和相关文件。
## 侧重检查

- **错误路径**：`put` 重复时会抛出 `PORT_DUPLICATE`；失败分支的 `delete` 异常被吞掉（`.catch(() => false)`）；`maintain` 把 `delete` 返回的 `false` 当成成功；`clearSummary` 失败被吞掉。见下文第 1、2、3 条。
- **不可信输入**：未校验 `sourceRef`、`sourceVersion`、`summary` 的运行时类型；`externalContent` 只认布尔 `true`，其他真值会被静默当成 `false`；`enqueue` 只校验 `day` 的形状。见第 6 条。
- **安全**：摘要确实走加密载荷，分级用 `classificationWithIdentifiers`，外部内容标记来自登记表且只能升级，方向正确；但载荷引用与条目编号不含主人/agent 范围，见第 5 条。
- **资源耗尽**：已结束条目的摘要载荷在“清除后再提交”的路径上会变成永久孤儿；`think_inbox` 行本身从不删除；`settledSummaries` 固定 50 条，删除一直失败时会饿死后面的条目。见第 3、9 条。
- **不可撤销操作**：`maintain` 先删载荷再清指针，删除成功后 FK 已把指针置空，顺序本身没有泄漏；但第 2 条的失败分支删除可能误删别的提交刚建立引用、已被接受的载荷。
- **规则/文档一致性**：`docs/architecture-v0.1.md:436` 的“条目一结束就删载荷”与实际的批量清扫、重提漏删不完全一致；`runPolicy.thinkInbox` 只解析未接入运行；迁移的 `status`/`reason_code` 约束比文档声明的状态集合松。见第 7、8、9 条。

## 意见

### 1. 【高】两个相同的提交并发进来时，第二个会在写载荷时抛 PORT_DUPLICATE，而不是返回已有条目
文件：`apps/agent-service/src/production-think-inbox.ts:133-148`、`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1827-1833`

问题：`submit` 先 `get` 再 `put`，载荷 ref 由 `(kind, ref, version)` 确定性算出；两个相同提交都读到 `undefined` 时，第二个 `put` 会撞上全局的重复检查并抛错，调用方拿到异常而不是 `{accepted:true, duplicate:true}`。

证据（已核实）：
```ts
const key = entryKey(input.sourceKind, input.sourceRef, input.sourceVersion);
const summaryRef = `think-summary:${key}`;
const known = await this.#options.payloads.get(summaryRef as never);
if (!known) {
  await this.#options.payloads.put(await this.#options.protector.protect({...}));
}
```
```ts
if (this.database.prepare("SELECT 1 FROM payloads WHERE ref = ?").get(input.payload.ref)) {
  this.fail("PORT_DUPLICATE", `Payload ${input.payload.ref} already exists`, ...);
}
```
推测（未实际运行）：SQLite 写操作在 worker 内串行，两个 `submit` 的 `get` 可以都发生在先、`put` 后到者必然看到已有 ref，因此这是可达的并发失败，不依赖极端时序。作者说法 1“重复提交返回已有条目”只在载荷已存在时成立。

建议：把载荷写入做成幂等/与入队同事务（例如 `INSERT ... ON CONFLICT DO NOTHING` 或把 `PORT_DUPLICATE` 当作“已存在”继续入队）；不要用“读不到再写”做去重。补一个两个 `submit` 同时进入的测试。

### 2. 【高】失败分支删除的是“这次开始时还没有的载荷”，不是“这次新建的载荷”，可能删掉另一个成功提交刚建立引用的摘要
文件：`apps/agent-service/src/production-think-inbox.ts:136-164`、`packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:12`

问题：`!known` 只说明本提交开始读的时候载荷不存在，不能证明它现在没有被任何条目引用。删除发生在 `enqueue` 返回之后的异步边界上，另一个相同键的成功提交可能已经引用这个载荷。

证据（已核实）：
```ts
if (!known) await this.#options.payloads.delete(summaryRef as never).catch(() => false);
```
```sql
summary_ref TEXT REFERENCES payloads(ref) ON DELETE SET NULL,
```
推测（未实际运行）：可达场景是 A 写载荷后 `enqueue` 得到 `queue_full`，B 读到 `known=true`，队列腾出空位或跨过本地日后 B 的 `enqueue` 成功，随后 A 的删除执行；FK 把 B 条目的 `summary_ref` 置空，B 却已被告知 `accepted:true`。作者说法 2“只在这次新写的情况下删”在语义上不成立。

建议：删除前用“没有条目引用该 ref”做条件（例如 `DELETE ... WHERE NOT EXISTS (SELECT 1 FROM think_inbox WHERE summary_ref = ?)`），或让 `enqueue` 在同一事务里决定是否新建载荷并返回该事实，失败回滚时不产生载荷。

### 3. 【中】条目结束后摘要被清掉，再提交同一来源版本会重新写一份没有任何行引用的载荷
文件：`apps/agent-service/src/production-think-inbox.ts:136-148, 162-164`、`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:130, 298-327`

问题：`maintain` 把已结束条目的 `summary_ref` 清成 `NULL` 后，来源再次扫描到同一条目时会 `get` 不到载荷、重新 `put`；随后 `enqueue` 返回 `duplicate`，`submit` 直接返回，不会删除刚写的载荷。`settledSummaries` 只找 `summary_ref IS NOT NULL` 的行，这份孤儿永远不会被清扫。

证据（已核实）：
```ts
if (outcome.outcome === "duplicate") return { accepted: true, entryId: id, duplicate: true };
```
```sql
SELECT id, summary_ref AS summaryRef FROM think_inbox
WHERE owner_id = ? AND agent_id = ? AND summary_ref IS NOT NULL
  AND status IN (...)
```
```sql
UPDATE think_inbox SET summary_ref = NULL
```
推测：邮件/记忆这类来源本来就会反复扫描同一批项目，因此每次“已处理过”的条目都可能留下一个永久加密载荷；这同时违反作者说法 1 的“不新建摘要载荷”。

建议：先查重复再决定是否写载荷；或者 `duplicate` 分支在“本次新写”时删掉刚写的载荷。补一个“条目结束后再提交同版本，载荷数量不增加”的测试。

### 4. 【中】`usage().queued` 只算 `queued`，入队上限算 `queued + thinking`，界面/后续运行可能误判还有空位
文件：`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:131-138, 251-262`

问题：同一份容量在两个地方口径不同。显示“排队 19/20”时，只要有一条在 `thinking`，实际提交就会被 `THINK_QUEUE_FULL` 拒绝。

证据（已核实）：
```sql
-- enqueue
WHERE owner_id = ? AND agent_id = ? AND status IN ('queued', 'thinking')
```
```sql
-- usage
WHERE owner_id = ? AND agent_id = ? AND status = 'queued'
```
建议：两处使用同一谓词；若要区分“可以立刻领取”的数量，就在 `ThinkInboxUsage` 里同时暴露 `queued` 和 `thinking` 并写清含义。补一个“领取一条后 usage 与入队判断一致”的测试。

### 5. 【中/低】条目 id 和摘要载荷 ref 不含主人/agent，全局主键和全局 ref 检查会让跨主人/agent 的相同来源版本冲突
文件：`apps/agent-service/src/production-think-inbox.ts:69-73, 133-135`、`packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:1-2`、`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1827-1833`

问题：`id` 和 `summaryRef` 只由 `(kind, ref, version)` 决定，而 `think_inbox.id` 是全局 `PRIMARY KEY`，`payloads.ref` 也是全局主键，`putPayload` 的存在性检查还只看 ref、不看 owner/agent。同一数据库里出现第二个主人或 agent 时，同样的来源版本会先撞载荷重复，或撞条目主键。

证据（已核实）：
```ts
function entryKey(kind: string, ref: string, version: string): string {
  return createHash("sha256").update(JSON.stringify([kind, ref, version]))...
}
```
```sql
id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
```
推测：如果产品保证“一个数据库只有一个主人/agent”，目前没有实际影响；但作者说法 5“所有读写都带主人和 agent 范围”对标识本身不成立。仓库里 `owners`/`agents` 是复数表，且 `owner_proposals` 等也有类似的不含范围的 id，属于既有约定，需要显式确认而不是默认可安全。

建议：把 `ownerId/agentId` 纳入 `entryKey`，或把表主键改成 `(owner_id, agent_id, id)` 并同步改载荷 ref；至少在文档和测试里明确“单主人单 agent 数据库”的假设，并加跨主人同来源版本的用例。

### 6. 【低】`submit` 的运行时输入校验不完整：非字符串会抛 TypeError，非布尔 `externalContent` 会被静默降级为 `false`
文件：`apps/agent-service/src/production-think-inbox.ts:126-131, 155`、`packages/application/src/ports/think-inbox.ts:3-9`

问题：`sourceRef`/`sourceVersion`/`summary` 直接访问 `.length` 或 `.replace`，`undefined`/数字会抛异常而非返回结构化拒绝；`input.externalContent === true` 使 `1`、`"true"` 等真值被当成 `false`，如果未来调用方把这些字段来自 JSON，可能漏标外部内容。

证据（已核实）：
```ts
if (input.sourceRef.length < 1 || input.sourceRef.length > 256) ...
if (input.sourceVersion.length > 256) ...
const summary = clip(input.summary, this.limits.summaryCharacters);
```
```ts
externalContent: input.externalContent === true || source.externalContent,
```
建议：对三个字符串字段做 `typeof` 校验并返回 `THINK_*_INVALID`；`externalContent` 非布尔时拒绝（或按“宁可标成外部内容”处理），并补反向用例。与之对应，`enqueue` 对 `day` 只做 `\d{4}-\d{2}-\d{2}` 形状校验，直接调用者可用任意日期绕过每日上限，建议同时校验 `day` 与 `now` 在配置时区下一致，或把 `day` 的生成收进存储层。

### 7. 【低】`runPolicy.thinkInbox` 只被解析，没有任何生产代码把它交给 `ProductionThinkInbox`
文件：`packages/platform-node/src/strict-configuration.ts:1383-1401, 1856-1858`、`apps/agent-service/src/production-think-inbox.ts:101-111`

问题：配置越界会在启动时报错，但合法值目前没有消费者；`ProductionThinkInbox` 除测试外没有任何构造点。

证据（已核实）：`strict-configuration.ts` 新增 `parseThinkInbox` 并挂到 `runPolicy`；全仓库检索 `ProductionThinkInbox` 只在 `test/integration/think-inbox.test.ts` 构造。作者已说明“下一个 PR 接运行”，所以这不是本 PR 的功能缺口，但意味着文档里“这些值都是 `runPolicy.thinkInbox` 的可选配置”目前没有运行时证据。

建议：在接线 PR 里加一条从解析后的配置到 `inbox.limits` 的装配测试；在那之前把这几个键标成“预留、尚未生效”，避免运维以为改了配置就会生效。

### 8. 【低】迁移只限制 `status`/`reason_code` 的长度，比文档声明的状态集合和 `StoredThinkEntry` 联合类型更松
文件：`packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:13`、`packages/application/src/ports/think-inbox.ts:3-9`、`packages/persistence-sqlite/src/schema-catalog.ts:723-728`

问题：数据库可以接受任意 1–32 字符的状态；`stored()` 直接把它断言成联合类型。未来代码拼错状态或手工 SQL 写入后，条目既不会被 `claimNext` 领取，也不会被 `settledSummaries` 清扫，界面 `byStatus` 还会出现未知状态。

证据（已核实）：
```sql
status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 32),
```
```ts
export type ThinkInboxStatus = "queued" | "thinking" | "proposed" | "skipped" | "failed" | "expired";
```
作者明确说“不用 CHECK IN”是刻意选择；这里只指出代价，不是安全漏洞。

建议：状态是封闭枚举，用 `CHECK (status IN (...))` 成本很低；如坚持文本，至少在读取时校验未知状态并报错，别让未知状态静默沉积。

### 9. 【低】文档说“条目一结束就删载荷”“临时队列”，实际是 `maintain` 每批 50 条清扫，且 `think_inbox` 行从不删除
文件：`docs/architecture-v0.1.md:436`、`apps/agent-service/src/production-think-inbox.ts:186-199`、`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:298-327`

问题：文档读起来像结束即删、队列本身会消失；代码里删除只在调用 `maintain` 时发生、每次最多 50 条，而 `think_inbox`/`think_inbox_declined` 没有任何保留期或删除路径。保留行是跨重启去重所需，但与“临时队列”的表述冲突；再叠加第 3 条的孤儿载荷，“结束即删”并不成立。

证据（已核实）：
```ts
const settled = await this.#options.store.settledSummaries({ ...this.#options.scope, limit: SWEEP_BATCH });
for (const { id, summaryRef } of settled) { ... delete ... clearSummary ... }
```
```ts
const SWEEP_BATCH = 50;
```
文档原文：“条目一结束就删载荷，表里只留指针”“这是临时队列，不进数据导出”。

建议：文档改成“`maintain` 清扫时删除摘要，条目行保留用于去重”；如果长期不希望表无限增长，补一个明确的保留/归档策略（并说明删除后去重语义如何保持）。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本改动没有触碰系统提示、工具定义、历史消息、遮盖或任何请求组装代码；`ProductionThinkInbox` 目前除测试外没有生产构造点，也不会调用模型。因此“发给模型的内容只在末尾追加、每轮变化的值都在最后一条消息里”这一点不受影响。将来把摘要接入“想一想”的后台调用时，应继续把来源内容放在固定指令之后、末尾，不要把可变的摘要放进系统提示。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会影响模型请求（本 PR 没有模型请求）。就存储而言，摘要明文经过 `clip()` 的空白归一化后是确定的，`id`/`summaryRef` 由 `(kind, ref, version)` 的 JSON 确定算出；但载荷的 `createdAt: now` 和生产 protector 的随机 DEK/nonce 会让同一明文的密文不同——这是加密载荷的既有性质，不是提示前缀问题。查询的 `ORDER BY updated_at, id` 也是确定的，没有依赖无序集合。

**3. 有没有对应自动检查，反向用例真的会失败？**
有基础测试：配置越界（`startup-configuration.unit.test.ts:1941-1968`）、未登记来源、空摘要、基本重复、队列满、每日上限、本地日、`finish` 只接受 `thinking`、卡住恢复/过期、主人隔离。现有反向用例确实会失败（越界 `toThrow`、未登记/空摘要精确断言）。但**作者说法 1 和 2 没有被测试保护**：没有并发相同提交、没有断言重复提交不新增载荷、没有断言队列满/每日上限时新写载荷被删且已有载荷不被删、没有“结束后重提”的清理用例、没有 `summaryCharacters` 截断用例；因此第 1、2、3 条的问题现有测试都发现不了。

**4. 每个产生/使用的值，两端都能接受吗？**
逐项核对：
- `id`：`submit` 产生（`think:`+32 位 hex，共 38 字符），`enqueue` 校验 1–128，DB 主键 128，消费方 `fetch/claim/finish/clearSummary` 都按 id 查询，长度和格式互相接受。问题只在跨主人/agent 冲突（第 5 条），以及 `duplicate` 时返回的是本次算出的 id 而不是 `outcome.entry.id`（当前唯一调用方下二者相同，属潜在问题）。
- `summaryRef`：产生为 `think-summary:`+32 位 hex（46 字符），`enqueue` 校验 1–256，DB FK 指向 `payloads(ref)`，消费方 `get/put/delete/settledSummaries/clearSummary` 都接受；但 `put` 要求在 `enqueue` 之前载荷已存在，当前顺序满足，跨主人 ref 冲突见第 5 条。
- `day`：`localDay()` 产生规范 `YYYY-MM-DD`，`enqueue` 用正则、DB 用 GLOB，`usage` 用同一正则，两端接受；但存储层不核对 `day` 与 `now` 的时区关系，直接调用者可绕过每日上限。
- `queueLimit`/`dailyLimit`：配置或默认值由 `submit` 产生，`enqueue` 校验 1–100000，配置范围更窄（1–1000、1–10000），兼容。
- `stalledBefore`/`createdBefore`：`maintain` 用 ISO 字符串产生，存储层 `valid()` 要求 `toISOString()` 往返一致，DB 的 GLOB 也接受。
- `maxAttempts`/`attempts`：`maxAttempts` 经 `limit()` 校验，`attempts` 由 DB 自增且 `>=0`，`recoverStalled` 的 `>=`/`<` 两端一致。
- `externalContent`：`submit` 产生布尔，`enqueue` 校验布尔，DB 存 0/1，`stored()` 还原布尔，一致；但 `submit` 对非布尔输入静默当 false（第 6 条）。
- `status`/`reasonCode`：产生方是存储层的固定字面量加调用方传入的 `finish` 原因，消费方是 `SETTLED`、`usage.byStatus` 和 `declined` 按 `reason_code` 统计；DB 只限制长度（第 8 条），`finish` 允许的 `to` 与 `StoredThinkEntry` 联合类型兼容。
- `schema-catalog.ts` 的两条清单项：被 `migration-engine.contract.test.ts:75-80` 用来要求足迹表集合与迁移建表完全一致，也被 `schema-contract.contract.test.ts:24-34` 检查字段形状；新表已加入，没有漏项。迁移文件会被 `loadBundledMigrations` 自动发现，测试用 `LATEST_MIGRATION_SEQUENCE` 自适应，清单项能通过这两处校验。
- `runPolicy.thinkInbox`：解析器产生并被 allowlist 接受，但当前没有运行时消费者（第 7 条），所以“配置键能通过校验”成立，“配置值能生效”未核实。
- `think_inbox_declined`：`decline()` 按 `(owner, agent, day, reason)` 写，`usage` 按同样四列读，主键和长度约束一致，两端接受。

**未核实**：多主人/多 agent 共享一个数据库是否是产品允许的部署形态；`maintain` 在真实调度下的调用频率；`payloads` 的 `ciphertext_file` 存储方式下被直接 `delete` 时文件是否另有回收路径（本 PR 的摘要载荷在生产 protector 下是 inline，未发现直接问题）。
