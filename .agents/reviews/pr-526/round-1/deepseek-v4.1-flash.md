### 1. 高：`indexTermLimit` 在分词后按数组前缀截断，长中文记录的双字词会被整段丢掉

文件：`packages/platform-node/src/browser-thread-search.ts:34-40`、`apps/agent-service/src/production-http-composition.ts:1437-1444`

问题：上限是在 `tokenizeDocument` 已经生成全部候选词并逐一 HMAC 之后才 `slice`。文档分词对中文先压入所有单字、再压入所有双字词；查询分词对两字中文只产生双字词，不产生单字。默认上限 2000 时，一条约 2000 个汉字的长记录会先被单字填满 2000 个名额，后面的双字词全部被截掉，查询“预算”这类双字词就完全匹配不到。

证据（读代码证实）：

```ts
if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(segment)) {
  if (document) candidates.push(...characters);
  else if (characters.length === 1) candidates.push(segment);
  for (let index = 0; index < characters.length - 1; index += 1) {
    candidates.push(`${characters[index]}${characters[index + 1]}`);
  }
}
```

```ts
document: async (scope, text) =>
  (
    await searchTokenizer.tokenizeDocument({ ... })
  ).slice(0, perceptionSearchSettings.indexTermLimit),
```

建议：不要对最终数组做前缀截断。应在候选阶段限制，并保证单字/双字词均衡，或按文本长度先截断再分词；至少要让双字词有独立配额。补一条长中文记录的正向用例和“上限内尾部词仍可搜到”的反向用例。另外 `.slice` 在 HMAC 之后执行，只限制存储量，不限制分词和加密的 CPU/内存，资源上限的目标并未达到。

### 2. 高：evidence 名称虽进了索引，但答案覆盖率只按转写文字算，带转写的记录仍搜不到标题/地点名

文件：`apps/agent-service/src/production-http-composition.ts:1374-1379`、`apps/agent-service/src/production-search.ts:330-333`、`packages/platform-node/src/perception-service.ts:524-529`

问题：建立索引时 `indexText` 是“转写文字 + evidence 名称”，但搜索结果返回给 `ProductionSearchControl` 的 `text` 是 `spoken ?? written`。当记录既有转写文字又有可搜索 evidence（例如 `screen.text` 必须有正文、`windowTitle` 又被标成 search）时，索引可能因为 `windowTitle` 命中，但覆盖率检查只拿转写文字算，`windowTitle` 不在转写里时记录会被丢掉，用户仍然搜不到标题。

证据（读代码证实）：

```ts
const spoken = ...;
const written = perceptionSearchEvidenceText(record.type, record.evidence);
const text = spoken ?? (written === "" ? undefined : written);
```

```ts
const line = singleLine(found.text);
const matched = coverage(terms, line);
if (line.length === 0 || matched < minimum || !searchVisible(found.dataClassification))
  continue;
```

索引端则明确包含名称：

```ts
const indexText = [
  record.text ?? "",
  perceptionSearchEvidenceText(record.input.type, record.input.evidence),
].filter((part) => part !== "").join(" ");
```

`screen.text` 的定义是正文 required、`windowTitle` 可搜索（`packages/application/src/ports/perception.ts:177-180`），所以这是现实会触发的路径，不只是理论问题。

建议：覆盖率检查使用与建索引相同的 `indexText`（或在返回值里同时带上转写和 evidence 文本，分别用于匹配和答案），确保索引命中和答案过滤使用同一份文本。补一条“既有正文又有标题，标题不在正文里，按标题能搜到”的用例。

### 3. 中：重建时读文本或分词失败会写空词表并记当前版本，记录从此永久不再重建

文件：`packages/platform-node/src/perception-service.ts:666-681`

问题：`readText` 失败被吞成 `undefined`，`document` 失败被吞成 `[]`，随后仍然用当前 `version` 调 `replaceSearchTerms`。这样该记录不再满足 `listStaleSearchRecords` 的“没有状态或版本不同”，以后的重建不会再处理它，结果是永久的、静默的“搜不到”。作者说法“失败写空词表并记当前版本”与代码一致，但这不是一次失败被隔离，而是把一次失败固化成永久缺索引。

证据（读代码证实）：

```ts
const text =
  record.contentRef === null
    ? ""
    : await index.readText(record.contentRef).catch(() => undefined);
...
const terms =
  indexText === "" ? [] : await index.document(owned, indexText).catch(() => []);
await this.#options.store.replaceSearchTerms({
  ...owned,
  recordId: record.id,
  version: index.version,
  terms,
});
```

另外，`PERCEPTION_TEXT_MAXIMUM` 是 32768 个 UTF-16 单元，但 `canonicalTokens` 对 document 限制归一化后 65536 个字符；某些可被设备提交的兼容字符在 NFKC 后会膨胀并触发分词失败，正好落入这条永久空词表路径。

建议：失败时不要推进版本，保留 stale 状态以便下次重试；至少记录失败原因和可观察诊断。补一条反向用例：分词/解密失败后记录不得被标记为当前版本，修好后下一次重建能恢复。

### 4. 中：自动重建只在进程内跑一次且无总量/时间上限，首次搜索可能长时间阻塞，之后的漏索引不再修复

文件：`packages/platform-node/src/perception-service.ts:628`、`637-652`、`659-684`、`apps/agent-service/src/production-search.ts:324-328`

问题：`#ensureSearchIndex` 每个 owner/agent 只缓存一次 Promise。首次搜索会同步遍历所有 stale 记录，逐条解密、分词、删除并重写索引，没有总条数、总耗时或取消预算；升级后第一次搜索可能被大量历史记录拖住。另一方面，若进程内首次重建完成后，后续 ingest 的分词失败（`perception-service.ts:530-533`）没有写状态，缓存又不会失效，这些记录在本进程内也不会再被重建。

证据（读代码证实）：

```ts
const cached = this.#searchIndexReady.get(key);
if (cached) return cached;
const pending = this.rebuildSearchIndex(scope).then(...);
```

```ts
for (;;) {
  const stale = await this.#options.store.listStaleSearchRecords({ ... });
  if (stale.length === 0) return rebuilt;
  for (const record of stale) {
    ...
    await this.#options.store.replaceSearchTerms({ ... });
  }
}
```

上层搜索还会把整个感知搜索异常吞掉：

```ts
? await this.#options.perception.search({ query: asked, limit: settings.candidateLimit })
    .catch(() => [])
```

建议：给首次重建设总时间/总条数预算，或放到后台预热；ingest 索引失败时使进程内缓存失效或记录待重试状态。补一条用例：首次搜索触发的自动重建确实发生，并在超时/失败时行为可观察。

### 5. 中：新增测试没有覆盖自动重建、索引上限和失败路径，删掉关键代码测试仍会通过

文件：`test/integration/perception-search.test.ts:118-147`、`test/fixtures/device-api-harness.ts:312-325`、`packages/platform-node/test/startup-configuration.unit.test.ts:1113-1133`

问题：现有的“rebuilds records…”用例是手动调用 `rebuildSearchIndex`，不是首次搜索自动重建；第二次 `ask` 的 `not_found` 断言依赖 `#searchIndexReady` 缓存，因此删掉 `search()` 里的 `await this.#ensureSearchIndex(scope)`，这些用例仍然会通过。索引上限只有配置解析测试，测试夹具的 `document` 也没有执行 `.slice`，所以删掉生产组合里的 `.slice` 或把它改错不会被发现。失败路径、软删除后状态、带正文又有标题的记录都没有测试。

证据（读代码证实）：

```ts
expect(await h.perception.rebuildSearchIndex(perceptionScope)).toBe(3);
...
expect(await h.perception.rebuildSearchIndex(perceptionScope)).toBe(0);
```

```ts
document: (scope, text) =>
  searchTokenizer.tokenizeDocument({ ownerId: scope.ownerId, agentId: scope.agentId, text }),
```

建议：增加真实“首次搜索自动重建”的用例（新建服务、预置旧版本记录、第一次 `search` 即恢复）；增加 `indexTermLimit` 在真实 `document` 路径上的正向/反向用例；增加失败后重试、软删除恢复、正文与标题并存的用例。

### 6. 低：软删除只清词表不清索引版本，恢复记录后不会重建

文件：`packages/persistence-sqlite/src/sqlite-perception-operations.ts:722-743`、`696-719`、`packages/application/src/ports/perception.ts:749-754`

问题：把记录状态改成 `deleted` 时只删除 `perception_search_terms`，没有删除 `perception_search_index_state`。`setRecordStatus` 的类型允许 `active` 和 `deleted`，如果以后恢复记录为 `active`，版本仍然等于当前版本，`listStaleSearchRecords` 不会选中它，结果就是“词表空、状态当前、永远不重建”。

证据（读代码证实）：

```ts
if (input.status === "deleted")
  this.database
    .prepare("DELETE FROM perception_search_terms WHERE record_id = ?")
    .run(input.recordId);
```

而版本状态仍在同一事务的 `replaceSearchTerms`/ingest 路径写入，删除路径没有清理。

建议：软删除时同时删除 `perception_search_index_state`，或把该记录状态改成旧版本强制下次重建；补一条“删除后恢复仍能搜到”或“恢复后会被重新索引”的用例。

### 7. 低：索引版本串与数据库 1..128 的校验没有两端保证，规则常量靠手工维护

文件：`apps/agent-service/src/production-http-composition.ts:1434`、`packages/platform-node/src/browser-thread-search.ts:75-77`、`packages/persistence-sqlite/src/migrations/20261114175847_perception_search_index_state.sql:1-4`

问题：数据库要求 `version` 长度 1..128；tokenizer 只校验 `projectionVersion` 自身最长 128 字符，组合代码却再拼接 `:规则:上限`。当前生产值是 `thread-search-v2:` + 24 位十六进制（约 41 字符），拼接后约 72 字符，能通过；但若以后 `projectionVersion` 接近 128 或规则常量变长，写入会直接违反数据库 CHECK，导致 ingest 或重建失败。更实际的问题是 `PERCEPTION_SEARCH_INDEX_RULES` 是手工常量，只在 `production-http-composition.ts:1434` 使用；以后新增一个 `search: true` 字段但忘记改常量，旧记录不会重建。

证据（读代码证实的是拼接和校验位置）：

```ts
version: `${searchTokenizer.projectionVersion}:${PERCEPTION_SEARCH_INDEX_RULES}:${perceptionSearchSettings.indexTermLimit}`,
```

```sql
version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 128)
```

建议：对最终版本串做长度校验或取摘要；把规则版本从 `PERCEPTION_RECORD_TYPES` 中实际 `search` 字段的集合推导出来（或加检查保证常量与字段集合同步），不要只靠人工记得改常量。

**推测（未核实）**

- 第 6 条的实际影响取决于是否存在生产路径把记录从 `deleted` 恢复为 `active`；我只在测试里看到把状态设为 `deleted`，没有找到生产调用方。
- 第 7 条的版本超限目前没有发生；按当前生产组合的值计算是安全的，属于未来改动风险。
- 详细设计文档要求登记每个新出现的值，本次没有看到 `searchVersion`、`indexTermLimit`、`indexRebuildBatch` 的登记；这是否属于本 PR 必须更新，未核实。
- `PERCEPTION_RECORD_TYPES[type]` 在重建时直接下标访问；数据库 `type` 只校验长度、不校验枚举，若数据库里出现未知类型，重建会抛错。当前 ingest 会拒绝未知类型，所以这是防御性问题，未在生产路径证实。

**侧重检查**

- 错误路径：重建的 `readText`/`document` 失败会被吞掉并写成空词表当前版本（第 3 条）；重建整体失败会从 `search()` 抛出，但 `ProductionSearchControl` 又把感知搜索异常吞成空结果，用户只会看到“没找到”，没有可见诊断（第 4 条）。
- 不合规范或不可信输入：evidence 字符串由 `validatePerceptionFields` 校验类型和长度；SQL 全部参数化，没有发现注入点。但 `version`、`searchVersion` 在服务层没有校验，只靠数据库 CHECK；数据库 `type` 也没有枚举约束。
- 安全：索引词是 `search-token:` + HMAC，不含明文；搜索结果仍在 `ProductionSearchControl` 按 `public/private` 过滤后才显示。作者说“解密在分类过滤前只发生在服务器内存”，代码确实如此：`perception.search` 返回记录后先由 `production-http-composition.ts:1374-1379` 解密正文，再由 `production-search.ts:330-333` 过滤分类。重建也会解密所有 active stale 记录，包括 sensitive 记录，但仅在服务器内存中。
- 资源耗尽：第 1 条的 `.slice` 在分词/HMAC 之后，只限制存储；第 4 条的首次重建没有总量和时间上限。`op_ingestRecords` 调用了 `assertDiskHeadroom()`，但新加的 `op_replaceSearchTerms` 没有，重建写索引时没有同样的磁盘空间检查。
- 不可撤销操作：`replaceSearchTerms` 和记录插入都在事务里；失败会回滚，不会留下半套词表。软删除的状态残留见第 6 条。
- 规则、说明文档和代码一致性：作者说法大部分与代码一致；“删除时同一事务清索引（级联）”只对硬删除成立，软删除只清词表；"没有转写文字的记录用名称当答案"成立，但“名称进索引就能搜到”在带转写记录上被覆盖率检查破坏（第 2 条）。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 这次改动只涉及感知搜索索引、SQLite 表、配置解析和 `search.ask` 的网关快照；没有改系统提示、工具定义、历史消息或遮盖规则。`perception_read` 工具路径（`apps/agent-service/src/production-perception-tools.ts:270-409`）仍然按时间读记录，索引没有被放进模型请求。`search.ask` 也没有进入模型请求路径。因此发给模型的内容仍然只在末尾追加，没有新增每轮变化的值；索引版本、上限等值只在服务器侧使用，不进入 prompt。依据与 `prompt-prefix.md:36` 的只追加规则一致。

2. **不会让同一段文字在模型请求里变成不同字节；索引内部的值也是确定的。** 改动没有增加模型可见文本。索引词由 HMAC 按 `ownerId + agentId + projectionVersion + token` 生成，`perceptionSearchEvidenceText` 按静态的 `PERCEPTION_RECORD_TYPES` 字段定义顺序遍历，不依赖数据库 evidence 的键顺序，也不含时间字段；`listStaleSearchRecords` 的排序也是固定的。相同 scope、相同密钥、相同版本下，同一段文字生成的词和顺序稳定。唯一会变的情况是密钥、规则常量或上限被有意修改，那时版本变化并触发重建，这是预期的。

3. **有检查，但关键反向用例不足。** 正向方面，placeName 用例会失败于“evidence 不进索引”或“没有用名称当答案”；手动重建用例覆盖了旧版本记录重建。但删掉 `search()` 里的 `#ensureSearchIndex` 不会让现有测试失败，测试夹具的 `document` 没有执行 `.slice` 所以上限测试没有覆盖真实路径，失败后“空词表当前版本”没有反向用例，软删除恢复和“正文+标题”场景也没有。因此不能认为自动重建、索引上限和错误路径已经有真正的反向保护。

4. **大部分值的两端能对上，但有两个缺口。** `indexTermLimit` 由 `strict-configuration.ts:1546-1547` 限制在 1..100000，使用处是 `production-http-composition.ts:1434/1444`，类型和范围一致；`indexRebuildBatch` 由配置限制 1..1000，使用处 `perception-service.ts:663` 传到 `sqlite-perception-operations.ts:676`，两者范围一致；词表 token 为 `search-token:` 加 64 位十六进制，约 77 字符，能通过 `perception_search_terms.term` 的 16..128 校验；`record_id` 引用 `perception_records.id`，插入前记录已插入，`replaceSearchTerms` 还检查了 owner/agent 和 active；新的 port 方法和 `durable-adapters.ts:1268-1270` 的操作名一致，迁移也能被自动发现。
   缺口一：`searchVersion` 由 `perception-service.ts:538` 产生、由 `sqlite-perception-operations.ts:393-396` 写入，数据库限制 1..128；当前生产值约 72 字符能通过，但组合版本串本身没有服务层校验，属于第 7 条的未来风险。缺口二：软删除只清词表不清 `perception_search_index_state`，恢复为 active 后状态仍是当前版本，不会再重建（第 6 条）。除此之外，没有发现当前值会过不了后端校验的情况；这正是 I-73 要核对的“清单里的 id 能通过后端校验吗”这一类检查。
