# PR 444 第 2 轮复核结论

## 一、读代码证实的问题（按严重度）

### 1. 高：同摘要并发上传时，被上限拒绝的一方会删掉已成功一方的媒体文件

**文件:行**：`packages/platform-node/src/perception-service.ts:989-1034`、`872-877`

**问题**：媒体最终文件名只由摘要决定（`final = media/<sha256>`），上传先 `rename` 到位再写行；写行被上限拒绝时无条件 `rm(final)`。两个并发上传同一摘要（同一认证会话，未实现“每台设备同时进行的上传数”上限，正是本 PR 列出的已知延后项）时：

- A 被上限拒绝，`recordMedia` 返回 `stored:false, duplicate:false`
- B 已把同一内容 rename 到同一个 `final`，并成功插入行
- A 执行 `rm(final)`，删掉 B 的行所指向的文件

结果是 `perception_media_items` 有行、磁盘没有文件，且设备已收到 B 的 `stored:true` 并删除本地副本，属于不可逆的原始媒体丢失。`#placing` 是 `Set` 而非引用计数：A 的 `finally` 会把摘要从集合中删掉，即使 B 仍在 rename 与写行之间，并发的 `#sweepMedia` 也可能在 B 写行前删掉该文件。

**证据**：

```ts
// perception-service.ts:989-992
const final = path.join(this.#media(), grant.sha256);
const image = grant.mediaKind === "image" || grant.mediaKind === "screen";
this.#placing.add(grant.sha256);
const stored = await rename(upload.file, final)
...
// perception-service.ts:1033-1034
.finally(() => this.#placing.delete(grant.sha256));
if (!stored.stored && !stored.duplicate) await rm(final, { force: true });
```

```ts
// perception-service.ts:873-877
const names = (await readdir(this.#media())).filter((name) => /^[0-9a-f]{64}$/u.test(name));
const known = new Set(await this.#options.store.knownMediaDigests({ digests: names }));
for (const name of names)
  if (!known.has(name) && !this.#placing.has(name))
    await rm(path.join(this.#media(), name), { force: true });
```

**建议**：不要用摘要作为并发上传共享的最终路径。每次上传先落到唯一临时名，写行成功后才发布；或按摘要做引用计数/互斥锁，拒绝时只删自己创建的临时文件。若保留现有顺序，至少在删除前原子确认“该摘要在本进程内没有其他在途上传、且没有行”。不要把 `Set` 当作在途计数。

---

### 2. 中：判重查询按 owner/agent 收窄，但主键仍是全局的；跨 scope 同值会从“重复”变成主键冲突

**文件:行**：`packages/persistence-sqlite/src/sqlite-perception-operations.ts:213-223`、`886-925`；`packages/persistence-sqlite/src/migrations/0095_perception_records.sql:367-368`、`489-500`

**问题**：本轮把 `knownRecordIds` 和 `recordMedia` 的判重查询加上了 `owner_id/agent_id`，但：

- `perception_records.id` 仍是全局 `PRIMARY KEY`
- `perception_media_items.id`（`media:<sha256>`）仍是全局 `PRIMARY KEY`，且只按摘要构造

因此，不同 owner/agent 若同库共用（测试 `perception-records.test.ts:43-50` 明确用 `owner-someone-else` 验证查询按 scope 隔离），查询会认为“不存在”，随后 INSERT 会在全局主键上冲突，抛 SQLite 约束错误（500），而不是返回 duplicate。对媒体而言，同摘要跨 scope 比同记录 id 跨 scope 现实得多。

这正是 I-73 的模式：新测试只验证了查询端，没有验证“查完之后写进去能不能通过后端校验”。

**证据**：

```ts
// sqlite-perception-operations.ts:218-219
`SELECT id FROM perception_records
  WHERE owner_id = ? AND agent_id = ? AND id IN (SELECT value FROM json_each(?))`,
```

```ts
// sqlite-perception-operations.ts:889-892
"SELECT 1 FROM perception_media_items WHERE id = ? AND owner_id = ? AND agent_id = ?",
```

```sql
-- 0095:368 / 0095:490
id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 27 AND 75 AND substr(id, 1, 11) = 'perception:'),
...
id TEXT PRIMARY KEY CHECK (length(id) = 70 AND substr(id, 1, 6) = 'media:'),
```

**建议**：二选一并做成两端一致：要么主键/唯一约束改成 `(owner_id, agent_id, id)`（媒体则 `(owner_id, agent_id, sha256)`，`id` 相应调整）；要么保持全局判重并明确“一个数据库只有一条 scope”。按 I-73 增加“查询 + 写入”两端的用例，而不是只测 `knownRecordIds` 返回空。

---

### 3. 中：`releaseContent` 放在 `finally`，失败路径和并发同记录请求会互相破坏；准备阶段失败还会漏掉释放

**文件:行**：`packages/platform-node/src/perception-service.ts:498-510`、`857-869`；`apps/agent-service/src/production-http-composition.ts:532-534`；`packages/persistence-sqlite/src/migrations/0095_perception_records.sql:383`

**问题**：

1. 作者说是“入库后调用”，代码实际是 `try { ingest } finally { release }`。入库抛错、事务回滚时也会删掉本轮刚创建的 payload。
2. payload ref 是 `payload:http:sha256(authenticationRef \0 idempotencyKey)`，idempotencyKey 是 `perception-content:<record.id 摘要>`。同一认证会话下，同一记录的两个并发请求共享同一个 payload ref。一个请求失败/被拒并在另一个提交前执行 `releaseContent`，会删掉共享 payload；另一个随后插入 `content_ref` 时违反 `ON DELETE RESTRICT` 外键（或留下悬空引用），本应成功的一请求变成 500。
3. 准备循环中如果第 N 条记录的 `protectText` 抛错（如同一 id 换了正文触发 CONFLICT、会话失效、payload 存储失败），前 N-1 条已经创建的 payload 完全没有机会释放，永久残留（`releaseContent` 尚未调用）。

**证据**：

```ts
// perception-service.ts:862-869
try {
  return await this.#options.store.ingestRecords(input);
} finally {
  await this.#options.store.releaseContent({
    ...scope,
    refs: prepared.flatMap(({ contentRef }) => (contentRef === null ? [] : [contentRef])),
  });
}
```

```ts
// production-http-composition.ts:532-534
const payloadRef = `payload:http:${sha256(
  `${input.authentication.authenticationRef}\u0000${input.idempotencyKey}`,
)}`;
```

**建议**：把“创建 payload + 写记录 + 释放未被引用的 payload”放进同一个存储操作/事务边界，避免跨请求的删除窗口；准备阶段也用 `try/finally` 收集并释放已创建的引用；释放失败不要吞掉或覆盖原始错误（记录日志后保留原错误）。补失败路径和并发同记录的反向用例。

---

### 4. 中低：到期清理没有独立定时触发，导出说明的“最多保留到配置的天数”在空闲时可能不成立

**文件:行**：`packages/platform-node/src/perception-service.ts:579-585`、`535`、`739`、`1035`；`packages/persistence-sqlite/src/data-export/export.ts:659`

**问题**：`prune` 只由 `#afterWrite` 在 ingest、track、媒体上传之后调用，且有 `pruneIntervalSeconds` 节流；仓库内没有看到周期性调度（`apps` 中未搜到其他 `perception.prune` 调用）。如果主人停止使用、不再上传，超过 `mediaRetentionDays` 的媒体行和文件就不会被删，记录/轨迹/凭据的到期清理同样停摆。但本轮把导出说明改成了“最多保留到配置的天数就删”，这句话在无活动时不成立。

**证据**：

```ts
// perception-service.ts:579-585
const pruned = this.#prunedAt.get(scopeKey);
if (pruned !== undefined && now.getTime() - pruned < configuration.pruneIntervalSeconds * 1000)
  return;
this.#prunedAt.set(scopeKey, now.getTime());
await this.prune(scope);
```

```ts
// export.ts:659
"上传凭据是凭据，不导出；原始材料只是等待处理的临时文件，最多保留到配置的天数（runPolicy.perception.mediaRetentionDays）就删，..."
```

**建议**：增加服务端定时 prune（按 scope 或全局启动时跑一次），或者把文案改成“有清理活动时最多保留……”并明确不保证空闲期。补“无后续活动、超过保留期后重启/定时”用例。

---

### 5. 低：`device.request.body_bytes` 被新用作单行上限，但配置下限和文档语义都不匹配

**文件:行**：`packages/application/src/ports/device-limits.ts:33-40`；`packages/platform-node/src/perception-service.ts:883`、`897`、`921`；`packages/application/src/ports/perception.ts:40`

**问题**：

- `device.request.body_bytes` 配置最小值是 1024 字节，而一条感知记录正文上限是 32K 字符（UTF-8 最多约 128KB）。合法配置若取小值，所有带文字的感知上传都会被 413，功能整体不可用；配置校验没有跨字段检查。
- 设计文档（`docs/execution/specs/2026-11-11-apple-device-body-design.md:577`）写明该键是“上传接口以外，单个请求的正文”，代码现在把它用在上传的单行上限上，语义发生偏移。
- `pending.length > lineCap` 用的是 UTF-16 字符数，`take` 里用的是 `Buffer.byteLength`；已经完整的行仍按字节拒绝，所以不会放过超限行，但未完成行可能先缓冲到约 4 倍上限字节数才被拒。

**证据**：

```ts
// device-limits.ts:33-40
"device.request.body_bytes": { ..., defaultValue: 1_048_576, minimum: 1024, maximum: 16_777_216, ... }
```

```ts
// perception-service.ts:883 / 897 / 921
const lineCap = limits["device.request.body_bytes"];
...
if (Buffer.byteLength(line) > lineCap) tooLong();
...
if (pending.length > lineCap) tooLong();
```

**建议**：为上传单行设独立配置键（如 `device.upload.line_bytes`），或在严格配置里校验 `body_bytes` 不低于“最大记录行”的安全下界；`pending` 也改用字节计数。同步修正设计文档的语义。

---

### 6. 低：媒体“先到位再写行”的非上限错误路径会留下孤儿文件

**文件:行**：`packages/platform-node/src/perception-service.ts:992-1034`

**问题**：`rename` 成功后，若 `recordMedia` 抛错（磁盘余量不足、`PORT_CONFLICT`、SQLite 约束/IO 错误），异常会跳过 `if (!stored.stored && !stored.duplicate) await rm(final, ...)`，而 `.finally` 只把摘要移出 `#placing`。文件留在 media 目录且没有任何行指向，只能等下一次 prune/sweep；结合问题 4，可能长期存在。作者只处理了“被上限拒绝”，没有处理其他错误。

**证据**：`const stored = await rename(...).then(() => recordMedia(...)).finally(() => this.#placing.delete(...));` 之后才做 `rm`；异常从 `.then` 直接向上传播，`stored` 不会被赋值。

**建议**：`rename` 之后用 `try/catch` 覆盖所有“未写入成功”的路径，确认该文件不是已有行/其他在途上传后再删除；或把发布动作放在写行成功之后。补数据库抛错路径的用例（检查 media 目录为空）。

---

### 7. 低：consolidation-hold 契约测试把两种新类别从两边都抹掉，无法发现 0095 漏加类别

**文件:行**：`packages/persistence-sqlite/test/consolidation-hold-migration.contract.test.ts:52-62`

**问题**：新增的两条 `.replace(...)` 把 `limit_change`、`delivery_timing` 从迁移前后的建表语句里都删掉。若 0095 因故没有加入这两种类别，迁移后的 SQL 会与本应存在的旧 SQL 相同，测试仍然通过。这是把“预期新增”当噪声删掉，而不是验证新增确实发生。

**证据**：

```ts
.replace(", 'limit_change', 'delivery_timing'", "")
.replace(
  " OR (kind = 'limit_change' AND outcome = 'changed') OR (kind = 'delivery_timing' AND outcome IN ( 'delivered', 'deferred', 'deadline_reached', 'shown_in_app' ))",
  "",
)
```

**建议**：保留结构对比的同时，单独断言迁移后 `decision_ledger` 的 CHECK 接受 `limit_change` 和 `delivery_timing`（可按类别各插一行并期望成功），这才是 I-73 要求的“两端都核对”。

---

### 8. 低：文档/表结构目录与实际行为不一致

**文件:行**：`docs/execution/specs/2026-11-11-apple-device-body-design.md:603-611`、`577`；`packages/persistence-sqlite/src/schema-catalog.ts:841-847`；`packages/persistence-sqlite/src/data-export/export.ts:659`

**问题**：

- 设计文档的保留期表仍写“原声：转完即删”“图片、屏幕画面：理解完即删”，而代码现在统一按 `mediaRetentionDays`（默认 7 天）删除，且不区分是否已处理。
- `schema-catalog.ts` 的 `perception_media_items` 条目仍只写“随设备/Owner/Agent 删除级联”，没有写 7 天到期清理；表结构目录是数据生命周期的主要说明来源之一。
- 设计文档写 `device.request.body_bytes` 只管“上传接口以外”的正文，代码现在把它用在上传单行。

**证据**：

```ts
// schema-catalog.ts:842-846
"one row per raw audio, image or screen file received for server processing; ..."
"cascade with the device, Owner or Agent deletion",
```

**建议**：在本 PR 或紧随的文档提交里更新设计文档和 `schema-catalog.ts`，写明 `mediaRetentionDays` 的默认/范围、到期删除行为（含未处理媒体）以及 `body_bytes` 的新用途；若新设计已取代旧文档，标明确切的 ADR/设计线程链接。

---

### 9. 低：媒体身份只有摘要，先到者的 kind/device/milliseconds 会覆盖后到者

**文件:行**：`packages/persistence-sqlite/src/sqlite-perception-operations.ts:887-925`；`packages/platform-node/src/perception-service.ts:998-1004`

**问题**：行 id 是 `media:<sha256>`，判重只看 `(owner, agent, id)`。同一份字节先以 `audio` 上传、再以 `image`/`screen` 上传时，第二次会返回 `duplicate:true`，不插入也不计 `perception.images.daily`，后续处理仍按第一次的 kind/duration 走。是否可接受取决于是否把“同摘要即同一媒体”作为硬约定；当前文档没有写这一点。

**建议**：明确媒体身份是“摘要”还是“(摘要, kind)”；若 kind 影响处理与限额，应把 kind 纳入唯一键或拒绝 kind 不一致的重复上传，并补用例。

---

## 二、推测（未由代码完全证实）

1. **跨 scope 共用数据库的实际可达性**：`docs/backlog/BL-20261026-003-...` 提到 ADR 0234 改为“每人一个数据库文件”。若生产确实一库一 scope，问题 2 是潜在设计缺陷而非现网可触发；但新增的 `owner-someone-else` 测试和端口作用域说明又暗示多 scope 是目标，建议明确。未读 ADR 0234 全文，标为未核实。
2. **外键是否实际启用**：问题 3 中并发删除共享 payload 后，插入 `content_ref` 是报 FK 错误还是留下悬空引用，取决于 `openQualifiedDatabase` 是否开启 `PRAGMA foreign_keys`，未核实。
3. **仓库外定时任务**：问题 4 只确认仓库内没有周期性 `perception.prune`；若部署层另有 cron/任务调用公开的 `prune`，则空闲期清理成立，未核实。
4. **`ci/operations-pending.json` 的调用方批次说法**（iPhone 第 5 批、无网页调用方）无法从代码核实，标未核实。
5. **反向用例是否真的失败**：以下判断来自读代码，未实际运行测试。

---

## 三、侧重检查

- **错误路径**
  - 准备循环中途抛错漏释放 payload：证实（问题 3）。
  - `rename` 成功后 `recordMedia` 抛错留下孤儿文件：证实（问题 6）。
  - `releaseContent` 在 `finally` 中可能覆盖原始错误：证实代码结构；影响未实测。
  - 预留冲突（`PORT_CONFLICT`）在事务内抛出，`limit_usage` 会回滚；未发现部分扣费。
  - 单行超限返回 413 使用 `UPLOAD_EXPANDED_TOO_LARGE` 错误码，与“单行超 body_bytes”语义不完全对应，但测试已按该码断言，属于可接受的既定约定。
- **不合规范/不可信输入**
  - `grant.sha256` 经数据库 CHECK（64 位小写 hex）与上传后实际摘要比对，媒体最终文件名不能路径穿越；`#sweepMedia` 只处理 64 位 hex 文件名，`rm` 安全。
  - 记录 id、正文长度、occurredAt、evidence、speaker 等由 `#parseRecord` 校验；`localDay` 由服务端按 timezone 计算，不信任设备。
  - 单行/整份解压上限仍受 `device.upload.expanded_bytes` 约束；未发现可把整份文件无限读入内存的路径，但见问题 5 的进制混用。
- **安全**
  - 媒体按摘要全局共享路径，存在跨 scope 覆盖/删除风险（问题 1、2）。
  - 过期凭据重放返回已存结果但不校验本次上传字节、不落盘；与作者“有意保留”的说法一致，未发现新增写入或内容泄露（结果只有 counts/reached 等）。
  - payload ref 由认证引用 + idempotency key 决定，不同会话不会共享同一 payload；同一会话的并发同记录会共享，见问题 3。
  - 媒体文件由 `createWriteStream(..., mode: 0o600)` 创建，权限合理。
- **资源耗尽**
  - 解压总量有 500MB 上限、单行有上限、记录批次数有上限。
  - `#sweepMedia` 每次 prune 把 media 目录全部文件名作为 JSON 数组查询 `perception_media_items`，而该表没有 `sha256` 索引（`0095:502-503` 只有 status 索引），文件多时是全表扫描；目前只算性能问题。
  - `readdir` 结果和 `knownMediaDigests` 结果都在内存中，数量极大时会有压力，但受保留期和磁盘约束。
- **不可撤销操作**
  - `rm(final)`、`DELETE FROM payloads` 都是不可撤销的；问题 1、3 的并发窗口会导致误删，已重点列出。
  - `prune` 删除媒体行/文件前没有主人可见记录，属于作者已声明的下一 PR 范围，本轮不计为新问题。
- **规则文件、说明文档与代码一致性**
  - 本 PR 未改 `.claude/rules/prompt-prefix.md`、未改 prompt catalog、未新增模型调用；Q1/Q2 不受影响。
  - 设计文档与 `schema-catalog.ts` 对媒体保留期的描述落后于代码（问题 8）。
  - 本轮新增的配置键 `mediaRetentionDays` 在 `strict-configuration.ts:1366-1388` 会随默认键集合自动校验（1..90，拒绝未知键），配置接线一致。

---

## 四、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 本次增量没有改动系统提示、工具定义、历史装载、出口遮盖或 prompt catalog；新增的感知记录、媒体、用量、清理都只在服务端存储与设备接口内流转，尚未有模型调用读取它们（设计文档 §15 计划的“感知内容作为本轮末尾追加的工具结果”在本 PR 没有实现）。因此“发给模型的内容只在末尾追加、每轮变化值在最后一条消息”这一既有约束没有被本次改动触碰。

依据 `.claude/rules/prompt-prefix.md` 第 4、5、6 条，本改动不产生新的历史改写或系统提示变化。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**模型请求层面不会。** 新增的 `mediaRetentionDays`、`mediaBefore`、`prune` 返回的 `media` 计数、`ci/operations-pending.json` 文案、导出说明文案都不进入模型请求；导出说明是静态字符串。`#sweepMedia` 使用 `readdir` 顺序只决定删除顺序，不参与任何模型可看到的序列化。没有新增依赖前后文的遮盖逻辑。

（数据导出文件的顺序/字节确定性属于导出契约，不在本次增量的模型请求范围；本次导出只改了静态说明文字。）

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，但覆盖不均：

**有反向价值、读代码判断会失败的**：
- 被每日上限挡下的文字不再残留：`test/integration/usage-limits.test.ts:285-312`，计数 `payloads`/`texts` 都应为 1；去掉 `releaseContent` 会变 3。
- 图片/屏幕计入 `perception.images.daily`：`usage-limits.test.ts:249-283`；去掉 image 预留，第三张会 `stored:true`，断言失败。
- 媒体到期与无行文件清理：`test/integration/device-upload.test.ts:183-221`；去掉 `#sweepMedia` 或 media 删除，`media` 计数/目录断言失败。
- 单行超过 `device.request.body_bytes` 返回 413：`device-upload.test.ts:163-181`；去掉行检查会先走 `record_shape` 400，状态码/错误码断言失败。
- 零点切段：`test/integration/perception-records.test.ts:140-176`；不改 `local_day` 条件，两条会并成一段，昨天/今天数量断言失败。
- `knownRecordIds` 的 owner 隔离：`perception-records.test.ts:38-50`；去掉 owner 条件返回非空，断言失败。

**没有真正反向覆盖的**：
- `recordMedia` 的 owner 隔离（与问题 2 相关）：没有“另一个 owner 同摘要上传会怎样”的写入端用例。
- `assignEpisode` 回填 UPDATE 的 `local_day` 条件（非 anchor/乱序到达/回填）没有用例；零点测试只用了两条 anchor（speech），没有覆盖回填路径。
- 媒体并发同摘要、`recordMedia` 抛错、准备循环中途失败都没有用例。
- consolidation-hold 测试的规范化反而抹掉了新类别，不能反向证明 0095 确实加上了它们（问题 7）。
- 未实际运行测试；“会失败”是读断言和实现后的判断。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐项核对：

- **`mediaRetentionDays`（默认 7，范围 1..90）**：产生于 `PERCEPTION_CONFIGURATION_DEFAULTS/RANGES`（`perception.ts:353,367,383`）；`strict-configuration.ts:1366-1388` 按默认键集合自动解析和校验；消费方只有 `perception-service.ts:604-606` 的 `mediaBefore` 计算。两端一致。
- **`mediaBefore` ISO 字符串**：由 `new Date(...).toISOString()` 产生；数据库 `received_at` 也是 `toISOString()` 写入，格式相同，`this.time()` 会校验格式；比较一致。
- **`perception.images.daily`**：键已在 `usage-limits.ts` 定义；产生于媒体分支（image/screen 各 1）；消费于 `recordMedia` 的预留、`#afterWrite` 警告和 `usage()` 展示。两端一致；重复上传不重复计数，符合去重语义。
- **`local_day`**：由服务端 `ownerLocalDay(occurredAtMs, timeZone)` 产生，episode 候选查询、非 anchor 的 inside 查询、回填 UPDATE 都按它过滤；`prune`/`countDay` 也用它。逻辑一致，回填路径缺少测试。
- **`releaseContent` / `knownMediaDigests` 操作名**：`durable-adapters.ts:1167-1168` 的 `"perception.releaseContent"` / `"perception.knownMediaDigests"` 经 `execute()` 的 `operation.slice("perception.".length)` 映射到 `op_releaseContent` / `op_knownMediaDigests`，名字两端一致；`releaseContent` 注册为 write，`knownMediaDigests` 为 read，语义正确。
- **`prune` 新增返回字段 `media`**：端口、实现、服务均已更新；现有调用方只读 `trackPoints` 等字段，额外字段不破坏调用方。
- **`media:<sha256>` 标识**：产生于 `perception-service.ts:998`，写入端用全局主键，判重端却按 owner/agent，且 kind/device 不参与身份。两端不一致（问题 2、9）。
- **`perception:<id>` 记录标识**：判重按 owner/agent，主键全局；跨 scope 时“查询说没有、写入却冲突”（问题 2）。
- **`device.request.body_bytes` 作为单行上限**：产生端允许最小 1024 字节，消费端需要容纳 32K 字符的正文行；语义上该键原本定义给“上传接口以外”的请求。两端不一致（问题 5）。
- **`ci/operations-pending.json` 文案**：只是文本清单项；仓库内未见校验其调用方批次说法，未核实。
- **consolidation-hold 测试的序列化/建表比较**：规范化把两种新类别从两端删除，弱化了契约检查（问题 7）。

---

## 五、总体意见

不建议以当前形态合并。问题 1 是会造成原始媒体不可逆丢失的并发缺陷；问题 2、3 是 I-73 类“两端校验只做了一半”的问题，且会在失败/并发路径上放大；问题 4—8 至少应在合并前修正文档或补检查。最小合并前修复建议：

1. 媒体文件发布改为唯一临时名 + 写行成功后再发布，或按摘要加锁/引用计数；拒绝时绝不删共享最终文件。
2. `releaseContent` 与 `ingestRecords` 放进同一事务边界，准备阶段失败也释放已建引用；补失败/并发用例。
3. 统一“判重 scope”和“主键/唯一约束”两端；按 I-73 增加写入端用例。
4. 明确并落实到期清理的触发方式（定时或启动时），同步更新设计文档和 `schema-catalog.ts`。
5. 为上传单行设独立上限或校验 `body_bytes` 下限，修正 `pending` 的字符/字节单位。
