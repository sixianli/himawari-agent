本轮查过：`git diff 8560ea6..d9da84e` 的增量（只有 `test/integration/perception-search.test.ts` 新增 18 行，以及评审产物）、增量断言经过的索引写入/删除/查询路径，以及该功能新增值 `SEARCH_BASIS_KINDS`、`recordId`、`searchRecords`、`searchTerms`、`searchIndex` 的直接使用端。

### 1. 高 — 感知文本的索引词没有数量上限，单批最多 500 条 32KiB 文本可在入库准入前生成数千万个 HMAC 词并跨 worker 复制
文件: `packages/platform-node/src/browser-thread-search.ts:11,30-43`、`packages/platform-node/src/perception-service.ts:519-527,531`、`packages/application/src/ports/perception.ts:39`、`packages/application/src/ports/device-limits.ts:57-63`、`packages/persistence-sqlite/src/sqlite-perception-operations.ts:268-331`
问题: document 分支把每个汉字都作为一元词、并追加所有相邻二元词，没有上限；`MAXIMUM_TOKENS = 64` 只约束查询分支。单条 32KiB 连续汉字可产生约 65,535 个词，默认一批 500 条就是约 3,270 万个 HMAC 词，且 `prepared` 会把所有数组同时留在内存中并随 `store.ingestRecords` 跨 worker 结构化复制。更糟的是词条生成发生在 `store.ingestRecords` 的配额/准入判断之前，已达到每日上限的请求仍会全额计算。
证据:
```ts
// browser-thread-search.ts:34-42
if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(segment)) {
  if (document) candidates.push(...characters);
  else if (characters.length === 1) candidates.push(segment);
  for (let index = 0; index < characters.length - 1; index += 1)
    candidates.push(`${characters[index]}${characters[index + 1]}`);
}
if (document) candidates.push("\0document-indexed");
// 第 44 行只对 !document 检查 unique.length > MAXIMUM_TOKENS
```
```ts
// perception-service.ts:519-531
const searchTerms = ... await this.#options.searchIndex.document(scope, record.text)...
prepared.push({ ...record.input, contentRef, ...(searchTerms ? { searchTerms } : {}) });
...
await this.#options.store.ingestRecords({ ...records: prepared... });
```
```ts
// device-limits.ts:57-63
"device.perception.batch_records": { defaultValue: 500, maximum: 10_000, ... }
// perception.ts:39
export const PERCEPTION_TEXT_MAXIMUM = 32 * 1024;
```
建议: 给 document 词数设硬上限（例如 2,048/4,096），超出部分截断或跳过；只对一段有界前缀建索引；把词条生成移到 store 完成准入/配额判断之后；用一条 prepared statement 或批量插入；补一条“最大文本 × 最大批次”的资源边界测试，并断言每记录索引行数有上界。这是 8560 功能提交的写入路径，不是 d9da 测试新增；因为 d9da 新增的 `indexRows > 0` 断言必须穿过该路径，所以本轮一并核查。

### 2. 中 — 敏感感知记录在分类过滤前就被解密并做字面覆盖率计算
文件: `apps/agent-service/src/production-http-composition.ts:1347-1363`、`apps/agent-service/src/production-search.ts:329-333`、`packages/application/src/ports/perception.ts:168-177`
问题: `message.text` 是 `required` 文本且分类为 `sensitive`，它会被正常建索引并进入候选。生产组装层对每个候选都先 `readPerceptionText` 解密全文；`ProductionSearchControl` 也是先 `singleLine`、`coverage`，最后才检查 `searchVisible`。因此敏感短信/iMessage 明文会在“不会被显示”的承诺下仍被解密、归一化并参与匹配。当前代码没有把明文返回给客户端，但这属于不必要的敏感数据暴露面，也放大了资源消耗。
证据:
```ts
// production-http-composition.ts:1349-1362
const text = record.contentRef === null ? undefined
  : await readPerceptionText(record.contentRef).catch(() => undefined);
return text === undefined ? [] : [{ ..., dataClassification: record.dataClassification, text }];
```
```ts
// production-search.ts:330-333
const line = singleLine(found.text);
const matched = coverage(terms, line);
if (line.length === 0 || matched < minimum || !searchVisible(found.dataClassification)) continue;
```
```ts
// perception.ts:168-176
"message.text": recordType("reading", "required", {...}, { dataClassification: "sensitive" }),
```
建议: 让 `perception.search` 接口接受 `allowedClassifications`（与 episodes 一致），在 SQL `WHERE data_classification IN (...)` 阶段就排除敏感/受限记录，再做解密和覆盖率检查；补一条敏感感知记录既不出现在 basis、也不被解密的测试（可通过注入 readText 计数验证）。

### 3. 低 — 索引写入失败被静默吞掉，记录照常入库但永远搜不到
文件: `packages/platform-node/src/perception-service.ts:519-527`、`packages/persistence-sqlite/src/sqlite-perception-operations.ts:388-391`、`packages/persistence-sqlite/src/migrations/20261114170228_perception_search_terms.sql:1-5`
问题: `searchIndex.document` 抛错被 `.catch(() => undefined)` 吞掉；`INSERT OR IGNORE` 会忽略主键冲突以及 `CHECK (length(term) BETWEEN 16 AND 128)` 失败。密钥缺失、tokenizer 格式变化或词长越界时，感知记录仍然正常入库，但没有任何索引行，也没有诊断或计数，查询只是安静地少结果。
证据:
```ts
// perception-service.ts:520-522
record.text === null || known.has(record.input.id) || !this.#options.searchIndex
  ? undefined
  : await this.#options.searchIndex.document(scope, record.text).catch(() => undefined);
```
```ts
// sqlite-perception-operations.ts:388-391
const addTerm = this.database.prepare(
  "INSERT OR IGNORE INTO perception_search_terms (record_id, term) VALUES (?, ?)",
);
for (const term of record.searchTerms ?? []) addTerm.run(record.id, term);
```
```sql
-- 迁移第 3 行
term TEXT NOT NULL CHECK (length(term) BETWEEN 16 AND 128),
```
建议: 对服务端生成的词条改用普通 `INSERT` 或先显式校验长度/数量；索引失败至少上报诊断和计数，必要时让写入失败；补一条“tokenizer 抛错/词长越界时行为可观察”的测试。

### 4. 低（前提成立时中，推测部分已标注） — 索引词绑定密钥和 projectionVersion，但表里不存版本，密钥轮换后旧记录会失配且没有重建入口
文件: `apps/agent-service/src/production-http-composition.ts:1097-1100`、`packages/platform-node/src/browser-thread-search.ts:49-68,106-118`、`packages/persistence-sqlite/src/migrations/20261114170228_perception_search_terms.sql:1-5`
问题: 读代码证实 HMAC 输入包含 `projectionVersion`，生产版本又由 `csrfKey` 派生；迁移只有 `record_id, term`，没有版本列。推测：一旦 csrfKey/版本轮换，新查询词与新写入词使用新摘要，而旧行仍是旧摘要，旧感知记录会静默从搜索中消失；作者只说“不回填旧数据”，没有为已索引数据提供重建路径。
证据:
```ts
// production-http-composition.ts:1097-1100
const searchKey = createHmac("sha256", csrfKey).update("himawari.search.key.v2").digest();
const searchTokenizer = new ScopedThreadSearchTokenizer({
  keys: { resolve: async () => searchKey },
  projectionVersion: `thread-search-v2:${createHash("sha256").update(searchKey).digest("hex").slice(0, 24)}`,
});
```
```ts
// browser-thread-search.ts:58-68
return createHmac("sha256", key).update(context)...update(projectionVersion)...update(value).digest("hex");
```
建议: 存 `projection_version` 并在查询时按当前版本过滤/重建，或给感知索引使用不随 csrfKey 轮换的独立稳定密钥；补版本不匹配后的重建路径和测试。若生产上 csrfKey 从不轮换，则本条不触发，属于预防性意见。

## 侧重检查

- 错误路径：`production-search.ts:324-328` 把 `perception.search` 的任何异常吞成空数组；查询 tokenizer 超过 64 个唯一词会抛 `THREAD_SEARCH_QUERY_INVALID`（`browser-thread-search.ts:44-45`），结果就是感知搜索静默消失。`op_searchRecords` 对 `limit` 1..200、`terms` 1..64 有校验（`sqlite-perception-operations.ts:645-648`）；`contentRef === null`、payload 缺失、非 `text/plain`、UTF-8 解码失败都会跳过，不会崩。
- 不可信输入：设备文本上限 32KiB、批次默认 500/最大 10,000；SQL 全部参数化并通过 `json_each` 传词，owner/agent 条件在 SQL 内；`status = 'active'` 过滤存在。未发现注入或跨 owner 读取。
- 安全/隐私：词条是带密钥 HMAC，不含明文；`recordId` 来自服务端记录，不是客户端原样透传。敏感数据在过滤前解密的问题见意见 2。
- 资源耗尽：见意见 1；这是本轮最严重的可用性问题。
- 不可撤销操作：删除记录与删除索引行在同一事务（`sqlite-perception-operations.ts:668-688`）；保留期 `DELETE FROM perception_records` 依赖外键级联（`sqlite-perception-operations.ts:1040`），`openQualifiedDatabase` 强制 `foreign_keys = ON`（`migration-engine.ts:1213-1242`）。未发现生产路径把已删除记录恢复为 active；若通过 port 恢复，索引词不会重建（低风险，未发现调用者）。
- 规则/文档一致性：迁移、`schema-catalog.ts:856-862`、`PerceptionStorePort`、契约与 fixture 一致；迁移是只加表/索引。稀疏检出中没有找到描述 `search.ask` 基准类型的文档，`.agents/instructions/prompt-prefix.md` 也不可读，相关原文规则未核实。

**上一轮意见核对**：给出的成立“会出错”意见为空，没有可逐条验证的修复项。d9da 增量实际补上了“删除后 `perception_search_terms` 必须为 0”的断言，核对代码后确认该断言会真正走过 `op_setRecordStatus` 的删除分支。

## 必答问题

1. **不会改变模型已经见过的请求开头；本次改动不涉及模型调用。** 增量只有测试；完整功能里 `search.ask.read` 是网关查询，直接读存储文本并返回快照，没有改系统提示、工具定义、历史消息或遮盖结果。发给模型的内容仍只在末尾追加（本次 diff 未触碰 prompt/tool/history 构造代码；`prompt-prefix.md` 在稀疏检出中不可读，原文规则未逐条核对）。每轮会变的值是快照里的 `label`/`generatedAt`，不在模型请求里。

2. **对模型请求不涉及。** 索引侧在同一 owner/agent、同一密钥和 `projectionVersion` 下是确定性 HMAC：`normalize("NFKC")` + 小写 + `Set` 去重，同一文本字节相同；查询排序也固定。需要注意两点：`BASIS_LABELS` 使用请求时刻 `now` 计算年份/日期（`production-search.ts:28-41,370-373`），同一记录在不同日期返回的 label 字节会不同，但这是客户端快照而非模型请求；`projectionVersion` 参与 HMAC，密钥轮换会让同一文本产生不同摘要（意见 4，推测轮换会发生）。增量没有新增这类值。

3. **有对应自动检查，反向用例在逻辑上会失败。** `test/integration/perception-search.test.ts:87` 断言索引行 > 0：若索引没写入，失败；`:94` 断言无关查询为空；`:100` 断言删除后索引行为 0：如果删掉 `DELETE FROM perception_search_terms`，即使查询还能靠 `status = 'active'` 得到 not_found，这一条也会失败；`:101` 断言删除后查询为空。未运行测试（工具限制），以上由代码路径推理。覆盖缺口：没有敏感感知记录不显示/不解密的测试，没有保留期级联删除索引的测试，没有索引写入失败、长文本/大批次资源上限、密钥版本失配的测试。

4. **增量本身没有产生生产值**：只新增了测试辅助函数 `indexRows`，直接读取 `perception_search_terms`，没有新增导出或配置键。对功能值逐个核对了使用端：`searchTerms?` 仅被 `sqlite-perception-operations.ts:388-391` 消费，其余实现无强制要求；`PerceptionStorePort.searchRecords` 已在 `durable-adapters.ts:1245` 接上，worker 通过 `sqlite-durable-operations.ts:692` 按 `perception.` 前缀动态分派，`op_searchRecords` 存在且只有这一处实现；`searchIndex` 仅生产组装和测试 harness 构造，`PerceptionService` 内部消费，属可选；`SEARCH_BASIS_KINDS` 增加 `perception` 且 `recordId` 在契约中为 `nullable(machineString)`，`ProductionSearchControl` 对 memory/conversation 补 `recordId: null`、对感知记录写真实 id，fixture 已同步；感知 id 形如 `perception:[A-Za-z0-9_-]{16,64}`，长度 26–74、字符集在 `machineString` 的 `[A-Za-z0-9._:-]` 内，能通过校验；token 形如 `search-token:` + 64 hex = 77 字符，落在迁移 `CHECK 16..128` 内；`candidateLimit` 配置范围 `[1,200]`（`strict-configuration.ts:1474-1478`）与 SQL 的 1..200 一致。仓库外客户端是否接受新的 `perception` 基准类型未核实。
