## 侧重检查

- **错误路径**：索引生成失败被 `catch(() => undefined)` 吞掉，记录仍会写入；删除索引行的事务路径存在，但写入失败后没有重试或补建。见 `packages/platform-node/src/perception-service.ts:519-522`。
- **不可信输入**：设备提交的 `searchTerms` 不在 `RECORD_KEYS` 里，会被 `#parseRecord` 拒绝；查询词走参数化 SQL，未发现注入风险；`terms` 数量在存储层限制为 1..64，`limit` 限制为 1..200。但设备可控的文本长度和批大小会在配额检查之前放大索引写入量。
- **安全/隐私**：索引只写 `search-token:` 加 HMAC-SHA256 十六进制摘要，不含明文；查询按 owner/agent 过滤；响应层用 `searchVisible` 排除 sensitive/restricted。敏感记录仍会被 SQL 取出并解密后再丢弃，属于防御纵深/性能问题，不是本次响应泄露。
- **资源耗尽**：写入侧和查询侧都没有针对单条记录、单批次的索引工作量上限，详见意见 1。
- **不可撤销操作 / 可恢复性**：软删除会在同一事务删索引行，保留期删除依赖外键级联；但没有索引版本、重建或补偿机制，详见意见 2。
- **规则、文档和代码一致性**：`prompt-prefix` 规则不受影响；新表已列入 `schema-catalog`，迁移是自动发现的 timestamped 迁移，数据导出未包含该表，和“never exported”一致；测试说明和实际覆盖有差异，详见意见 3。

## 意见（读代码证实）

### 1. 高：索引写入没有上限，而且发生在配额检查之前，设备可用长文本耗尽 CPU/磁盘

**文件:行**：`packages/platform-node/src/perception-service.ts:509-527`、`packages/persistence-sqlite/src/sqlite-perception-operations.ts:303-318`、`:388-391`、`packages/platform-node/src/browser-thread-search.ts:34-44`、`packages/application/src/ports/device-limits.ts:57-60`、`packages/application/src/ports/perception.ts:39`

**问题**：`PERCEPTION_TEXT_MAXIMUM` 是 32 KiB 字符，单批默认最多 500 条记录；索引在调用 `store.ingestRecords` 之前逐条做分词和 HMAC，而记录/音频配额是在存储层之后才检查。`tokenizeDocument` 对中文文档会生成每个单字和每个二元组，文档侧没有 `MAXIMUM_TOKENS` 上限（该限制只对 query 生效）。每条 32 KiB 中文文本可产生约 6 万个唯一词，500 条就是约 3000 万次 HMAC 和逐行 `INSERT`；即使单次请求只带 1 MiB 正文，也可产生约 200 万行索引。请求即使最终被日配额拒绝，分词和 HMAC 也已经做完了。

**证据（亲自读到）**：

```ts
// packages/platform-node/src/perception-service.ts:519-527
const searchTerms =
  record.text === null || known.has(record.input.id) || !this.#options.searchIndex
    ? undefined
    : await this.#options.searchIndex.document(scope, record.text).catch(() => undefined);
prepared.push({ ...record.input, contentRef, ...(searchTerms ? { searchTerms } : {}) });
```

```ts
// packages/persistence-sqlite/src/sqlite-perception-operations.ts:303-318
if (record.audioMilliseconds > audioRoom) { ... continue; }
if (recordRoom === 0) { ... continue; }
```

```ts
// packages/persistence-sqlite/src/sqlite-perception-operations.ts:388-391
const addTerm = this.database.prepare(
  "INSERT OR IGNORE INTO perception_search_terms (record_id, term) VALUES (?, ?)",
);
for (const term of record.searchTerms ?? []) addTerm.run(record.id, term);
```

```ts
// packages/platform-node/src/browser-thread-search.ts:34-44
if (/\p{Script=Han}|.../.test(segment)) {
  if (document) candidates.push(...characters);
  ...
  for (...) candidates.push(`${characters[index]}${characters[index + 1]}`);
}
if ((!document && unique.length > MAXIMUM_TOKENS) || unique.length === 0) throw ...
```

查询侧也存在放大：`ProductionSearchControl` 最多对 `candidateLimit`（配置上限 200）条记录逐条解密，并用没有上限的 `queryTerms` 对最长 32 KiB 文本做覆盖率扫描（`apps/agent-service/src/production-search.ts:324-333`、`:152-158`、`packages/memory-engine/src/segmentation.ts:118-125`）。这是 Node 单线程路径，可能长时间占用事件循环。

**建议**：在分词之前检查记录/音频配额；给单条记录的索引字符数或唯一词数设硬上限，给单批次总词数设上限；超限时记录明确的降级状态而不是静默继续；考虑用有界后台队列补建索引；查询侧限制 `queryTerms` 数量，并在 SQL 层先按 `data_classification` 过滤。补一条最大长度中文文本 + 最大批次的资源边界测试。

### 2. 中：索引没有版本或重建路径，写入失败和密钥轮换会永久留下“搜不到”的记录

**文件:行**：`packages/platform-node/src/perception-service.ts:519-522`、`packages/persistence-sqlite/src/migrations/20261114170228_perception_search_terms.sql:1-8`、`apps/agent-service/src/production-http-composition.ts:1097-1100`、`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1868-1876`

**问题**：`searchIndex.document(...).catch(() => undefined)` 会把分词/HMAC 失败静默降级为“没有 searchTerms”；记录照样入库，之后同一个 id 再进来会被 `known.has(...)` 判为重复，永远不会补索引。迁移只有 `record_id` 和 `term` 两列，没有 projection version、索引状态或重建标记。`searchKey`/`projectionVersion` 来自可带 version 的 secret；即使更换密钥或改派生常量，已有记录的旧摘要也不会再匹配，且没有后台重建路径。对话搜索的投影表是按 `projection_version` 判断并重建的，感知索引没有对应机制。

**证据（亲自读到）**：

```ts
// packages/platform-node/src/perception-service.ts:520-522
record.text === null || known.has(record.input.id) || !this.#options.searchIndex
  ? undefined
  : await this.#options.searchIndex.document(scope, record.text).catch(() => undefined);
```

```sql
-- 20261114170228_perception_search_terms.sql:1-8
CREATE TABLE perception_search_terms (
  record_id TEXT NOT NULL REFERENCES perception_records(id) ON DELETE CASCADE,
  term TEXT NOT NULL CHECK (length(term) BETWEEN 16 AND 128),
  PRIMARY KEY (record_id, term)
) STRICT;
```

```ts
// apps/agent-service/src/production-http-composition.ts:1097-1100
const searchKey = createHmac("sha256", csrfKey).update("himawari.search.key.v2").digest();
const searchTokenizer = new ScopedThreadSearchTokenizer({
  keys: { resolve: async () => searchKey },
  projectionVersion: `thread-search-v2:${createHash("sha256").update(searchKey).digest("hex").slice(0, 24)}`,
});
```

```ts
// sqlite-thread-operations.ts:1876
AND NOT EXISTS (SELECT 1 FROM thread_search_projection s WHERE s.thread_id=m.thread_id AND s.message_id=m.id AND s.projection_version=?)
```

**建议**：给索引行或“记录→索引版本”增加 `projection_version`/状态，提供和 `ThreadSearchProjector` 类似的有界后台补建任务；写入失败时记录诊断或把记录标为“待索引”，不要在无日志的情况下当作成功；密钥/版本变化时自动重建（或至少明确报错而不是静默返回空结果）。对于明确不回填旧数据的需求，也建议提供一次性可选重建入口。

### 3. 中：删除测试没有真正验证索引行被删除，去掉新加的 DELETE 后测试仍会通过

**文件:行**：`test/integration/perception-search.test.ts:79-83`、`packages/persistence-sqlite/src/sqlite-perception-operations.ts:656`、`:682-685`、`apps/agent-service/src/production-search.ts:332`

**问题**：测试在 `setRecordStatus(..., "deleted")` 后断言查询为 `not_found`。但 `op_searchRecords` 的 WHERE 已经包含 `status = 'active'`，所以即使删掉 `DELETE FROM perception_search_terms WHERE record_id = ?`，记录仍会因状态过滤而查不到。这个“反向用例”实际上不会失败，不能证明“删除时同一事务删索引行”，也没有覆盖保留期 `DELETE FROM perception_records` 的外键级联。另一个缺口是没有测试 sensitive 记录不会出现在答案/basis 中；测试还自己复制了一份 `perception.search` 接线，而不是使用生产组合里的 `perception` 选项。

**证据（亲自读到）**：

```ts
// test/integration/perception-search.test.ts:79-83
const deleted = await h.repository
  .perception()
  .setRecordStatus({ ...perceptionScope, recordId: spoken.id, status: "deleted" });
expect(deleted).toBe(true);
expect(await ask(h, "我对什么过敏")).toMatchObject({ state: "not_found", basis: [] });
```

```ts
// sqlite-perception-operations.ts:656
WHERE owner_id = @ownerId AND agent_id = @agentId AND status = 'active'
```

```ts
// sqlite-perception-operations.ts:682-685
if (input.status === "deleted")
  this.database
    .prepare("DELETE FROM perception_search_terms WHERE record_id = ?")
    .run(input.recordId);
```

**建议**：在删除后直接查 `SELECT COUNT(*) FROM perception_search_terms WHERE record_id = ?` 并断言为 0；再加一条通过 `prune` 删除 `perception_records` 后索引行被级联删除的用例。补一条 sensitive/restricted 记录不会出现在 `answer`、`basis` 的用例。最好让集成测试走生产组合的真实 `perception` 接线，或至少把生产映射逻辑抽出来复用，避免测试和生产各写一份。

### 4. 低：代码只索引 `record.text`，`evidence` 里的可读文字不会被搜索；作者“给感知记录建索引”的说法比实现宽

**文件:行**：`packages/platform-node/src/perception-service.ts:519-522`、`packages/application/src/ports/perception.ts:117-159`、`apps/agent-service/src/production-http-composition.ts:1349-1352`

**问题**：只有 `record.text !== null` 的记录会生成 `contentRef` 和搜索词。`PERCEPTION_RECORD_TYPES` 里 `text: "none"` 的类型把可读文字放在 `evidence`（例如 `location.visit` 的 `placeName`、`context.now_playing` 的 `title/artist`、`context.app` 的 `appName`、`home.state` 的 `value`），这些记录没有任何 `text`，因此不会被索引，`readPerceptionText` 也不会被调用（`contentRef` 为 null）。如果产品目标是“感知记录都能按字面搜到”，这一部分没有实现；如果目标只是“有 text 字段的记录”，则应在 PR 描述里写清。

**证据（亲自读到）**：

```ts
// packages/platform-node/src/perception-service.ts:520
record.text === null || known.has(record.input.id) || !this.#options.searchIndex
```

```ts
// packages/application/src/ports/perception.ts:117-128
"location.visit": recordType("location", "none", {
  ...
  placeName: optionalText(128),
}),
```

```ts
// apps/agent-service/src/production-http-composition.ts:1350-1352
const text =
  record.contentRef === null
    ? undefined
    : await readPerceptionText(record.contentRef).catch(() => undefined);
```

**建议**：明确搜索范围。若只索引 `text`，修改目标/说明中的措辞；若需要搜 `placeName`、歌曲名、应用名等，按记录类型把对应 `evidence` 字段拼成索引文本和覆盖率检查文本，并补相应测试。

## 推测 / 未核实

- 生产是否真的会轮换 `identity.csrf.keySecretRef` 的版本、从而改变 `searchKey`/projectionVersion，未在生产配置中核实；代码路径存在。
- 仓库内没有找到使用 `recordId` 或 `basis.kind === "perception"` 的客户端消费方（只有 Gateway 合约、fixture 和测试），外部 Apple/网页客户端能否接受新增的必填 `recordId` 字段未核实。
- 意见 4 中“evidence 字段是否应该可搜索”属于产品范围判断，代码只能确认当前未索引。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本次改动没有触碰系统提示、工具定义、历史消息、出口遮盖或 model runtime；新增的是 `search.ask.read` 网关查询路径、SQLite 索引和 UI 返回文字（`SEARCH_TEXT` 也只在搜索响应里使用）。搜索结果不写回对话历史，也不进入模型上下文，因此发给模型的内容仍然只在末尾追加；每轮会变的 `generatedAt` 只出现在搜索 snapshot 中，不在模型请求里。

2. **同一段文字会不会在不同请求里变成不同字节？** 索引摘要不会。新表里的 term 是 `ScopedThreadSearchTokenizer` 对“规范化 token + ownerId + agentId + projectionVersion”的 HMAC-SHA256，十六进制摘要固定 64 字符；同一段文本在相同 scope 和相同密钥/版本下每次得到相同字节，不依赖前后文。集合通过 `Set` 去重且顺序由文本决定，查询结果排序也有 `occurred_at_ms` 和 `id` 兜底。例外是：密钥或 `projectionVersion` 变化会让旧摘要不再匹配（见意见 2）；搜索响应中的 `generatedAt` 和跨年时的 `basis.label` 会随时间变化，但它们不是模型内容，也不是索引键。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有 `test/integration/perception-search.test.ts`，覆盖“能搜到”“无关查询为空”“删除后查不到”。但“删除后查不到”不是索引删除的反向用例：查询本身按 `status = 'active'` 过滤，去掉新增的 `DELETE FROM perception_search_terms` 后该测试仍会通过。保留期级联、sensitive 过滤、索引写入失败、密钥轮换/重建都没有自动检查；本次也没有新增类似 `check:*` 的门槛。

4. **每个新增值的生产者和使用者两端校验是否一致？** 读代码核对如下：
   - `searchTerms`：生产者在 `PerceptionService.ingest`，消费者是 `insertRecord`；tokenizer 生成 `search-token:` + 64 位十六进制，共 77 字符，满足 `CHECK (length(term) BETWEEN 16 AND 128)`。
   - `searchRecords` 的 `limit`：配置侧 `candidateLimit` 允许 1..200（`strict-configuration.ts:1478`），存储侧也校验 1..200（`sqlite-perception-operations.ts:645`）。
   - `terms` 数量：tokenizer 查询侧上限 64（`browser-thread-search.ts:11,44`），存储侧上限 64（`sqlite-perception-operations.ts:647`）。
   - `recordId`：来源是 `perception_records.id`，格式 `perception:` 加 16..64 个 `[A-Za-z0-9_-]`，总长最长 75；Gateway 的 `machineString` 允许 `[A-Za-z0-9._:-]` 且最长 128（`validation.ts:49-60`），因此能通过合约校验。`recordId: null` 也已补到 memory/conversation 的 basis。
   - `basis.kind: "perception"`：已加入 `SEARCH_BASIS_KINDS` 和 Gateway 枚举，生产者和合约一致；仓库内没有其它 switch/消费者，外部客户端未核实。
   - 表/迁移/清单：新表在迁移和 `schemaCatalog` 都存在，migration-engine 的合约测试会比较实际表名和 catalog（`migration-engine.contract.test.ts:80`）；数据导出未包含该表，和 schema catalog 的“never exported”一致。
   - `searchIndex` 选项：生产组合和测试 harness 都接线了，未发现漏接。
