本轮查过的范围：增量 `c0a4d81..948f09a` 的全部源码/测试差异；并跟读了增量值的使用端：`perception.ts` 端口与类型、`sqlite-perception-operations.ts`、`durable-adapters.ts`、`migration-engine.ts` 与迁移目录、`schema-catalog.ts`、`strict-configuration.ts`、`production-http-composition.ts`、`production-search.ts`、`device-api-harness.ts`、`perception-search.test.ts`、`browser-thread-search.ts`。未整份重读与增量无关的旧代码。

### 1. 中：`readText` 返回 `undefined`（而不是抛错）时仍会写当前版本，上一轮第 3 条只修了“抛错”这一半
文件: packages/platform-node/src/perception-service.ts:670

问题：重建时 `contentRef !== null` 但 `readText` 返回 `undefined`，代码把它当成“没有转写文字”继续走完并 `replaceSearchTerms` 写入当前版本。之后 `listStaleSearchRecords` 认为它已是最新，记录从此不再重建，转写文字永久不在索引里。这正是上一轮第 3 条描述的症状，只是换成了“返回 undefined”这条错误路径。

证据（读代码证实）：
```ts
const text =
  record.contentRef === null ? undefined : await index.readText(record.contentRef);
const indexText = [text ?? "", perceptionSearchEvidenceText(record.type, record.evidence)]
  .filter((part) => part !== "")
  .join(" ");
const terms = indexText === "" ? [] : await index.document(owned, indexText);
await this.#options.store.replaceSearchTerms({ ... owned, recordId: record.id, version: index.version, terms });
```
而生产 `readPerceptionText` 在 payload 缺失或 `contentType !== "text/plain"` 时返回 `undefined`（production-http-composition.ts:1408-1413），并不抛错。感知记录只要 `contentRef !== null`，内容就是 text/plain，因此这里返回 `undefined` 表示读取失败，而不是“无文本”。

建议：把 `record.contentRef !== null && text === undefined` 视为失败（例如抛错进入现有 `catch`，或直接 `failed.push(record.id)` 并跳过 `replaceSearchTerms`）。补一条注入返回 `undefined` 的 `readText` 的反向用例。

### 2. 中：答案修补和失败重试都没有能真正回退的测试
文件: test/integration/perception-search.test.ts:31

问题：测试里的 `control()` 自己复制了一份生产答案映射（第 46-47 行也改成 `join(" · ")`），`ask()` 全部走这份副本；仓库里没有任何测试调用 `createProductionHttpComposition` 的 `searchControl.perception.search`。因此把 production-http-composition.ts:1379-1380 改回 `spoken ?? written`，所有测试仍然通过。上一轮第 3 条的失败处理同样没有被测到：新用例（第 170-190 行）只是直接调用 `listStaleSearchRecords({ excludeRecordIds })`，没有让 `rebuildSearchIndex` 遇到一次抛错，所以把 service 里的 `try/catch` 去掉、恢复“写空词表并记版本”，测试也不会失败。

证据（读代码证实）：
```ts
// test/integration/perception-search.test.ts:46-47
const text = [spoken ?? "", written].filter((part) => part !== "").join(" · ") || undefined;
// 第 151-168 行的新用例只调用本文件的 control()
const found = await ask(h, "Quarterly Roadmap");
// 第 170-190 行只验证 store 的 exclude，不触发 service 的失败分支
```
`production-http-composition.unit.test.ts` 里只出现 `perception.status.read` 等操作名，没有 `search.ask`/perception 搜索映射。

建议：让集成测试直接从 `createProductionHttpComposition` 取搜索控制（或把映射抽成可单独测试的纯函数并直接测它）；再加一条让 `readText` 或 `document` 对某条记录抛错、断言该记录仍 stale 且其余记录已重建的用例。

### 3. 中：作者的说法与代码相反——“失败写空词表并记当前版本”已经不是现在的行为
文件: packages/platform-node/src/perception-service.ts:683

问题：作者说法写“重建时分词或读文本失败的记录写空词表并记当前版本”，但增量代码恰恰相反：失败时只把 id 放进 `failed`，不调用 `replaceSearchTerms`，因此不写词表、不记版本，靠 `excludeRecordIds` 跳过并在以后重试。这条说法描述的是上一轮的旧行为，会误导复核与后续维护。

证据（读代码证实）：
```ts
} catch {
  failed.push(record.id);
}
```
`replaceSearchTerms` 只在 try 的成功路径调用（第 676-681 行）。

建议：把说法改成“失败时不落任何状态，记录保持 stale，本次跳过、以后重试”，并同步到 PR 说明/文档。

### 4. 低：软删除只清词表，不清索引版本状态；记录若被恢复为 active 会永久搜不到
文件: packages/persistence-sqlite/src/sqlite-perception-operations.ts:738

问题：`setRecordStatus` 删除时只 `DELETE FROM perception_search_terms`，保留 `perception_search_index_state` 里当前版本。端口允许 `status: "active" | "deleted"`；一旦有调用把已删除记录恢复为 active，`listStaleSearchRecords` 因为版本相同不会重建，词表却已被删空，该记录永远搜不到。

证据（读代码证实）：
```ts
if (input.status === "deleted")
  this.database.prepare("DELETE FROM perception_search_terms WHERE record_id = ?").run(input.recordId);
```
状态表只在记录行真正删除时靠 `ON DELETE CASCADE` 清理（迁移第 2 行）。

推测：当前生产代码只把状态设为 `deleted`（grep 到 `setRecordStatus` 的生产调用只有删除路径），所以暂时无法触发；但端口本身允许恢复。

建议：删除时在同一事务删除 `perception_search_index_state` 行，或把“词表为空”也纳入 stale 条件，保证恢复后能重建。

### 5. 低：失败列表无上限、每轮重扫全表，首搜还可能一次重建整库，可能放大延迟/资源
文件: packages/platform-node/src/perception-service.ts:659

问题：`failed` 随失败记录单调增长，每轮 `listStaleSearchRecords` 都把它整串 JSON 化并重新扫描该 owner/agent 的全部 active 记录，最坏约 `O(N²/rebuildBatch)`；`#ensureSearchIndex` 成功后缓存 promise，本次进程内失败的记录不会因后续搜索再次尝试（只能等重启或显式 `rebuildSearchIndex`）。另外 `for (;;)` 不设总预算，首次搜索会把所有 stale 记录（包括大量无文本、ingest 时未写 state 的低价值记录）一次性重建完，可能长时间占住请求。

证据（读代码证实）：
```ts
const failed: string[] = [];
for (;;) {
  const stale = await this.#options.store.listStaleSearchRecords({ ...excludeRecordIds: failed });
  ...
  } catch { failed.push(record.id); }
```
```ts
const pending = this.rebuildSearchIndex(scope).then(() => undefined, (error) => { this.#searchIndexReady.delete(key); throw error; });
```
另：`replaceSearchTerms` 的布尔返回值被忽略（`await` 后不检查），若它在记录仍 active 时返回 false，同一批会反复被列出（推测，需异常条件才触发）。

建议：为单次调用设置失败/重建上限并在返回时报告被跳过的数量；`replaceSearchTerms` 返回 false 时也加入 `failed` 或中止，避免潜在重列。

**侧重检查**

- 错误路径（读代码证实）：`readText`/`document`/`replaceSearchTerms` 抛错会被 `catch` 跳过且不写状态；`listStaleSearchRecords` 抛错会清掉 `#searchIndexReady` 缓存、让搜索失败（下次重试）。`readText` 返回 `undefined` 未被当作失败（见意见 1）。失败没有日志/诊断输出，运维无法知道哪些记录一直没索引（推测影响可观测性）。
- 不可信输入：`excludeRecordIds` 用绑定参数 `json_each(@excluded)`，无 SQL 注入；其值来自数据库记录 id，不是设备输入；`version` 也走绑定参数。`op_listStaleSearchRecords` 只校验 `limit`，不校验 `excludeRecordIds` 长度/元素，但该端口不经设备 API 暴露（读代码证实）。
- 安全：索引词是 `search-token:<HMAC-SHA256>` 摘要，不存明文（browser-thread-search.ts:58-68）；新表版本串含的是 `searchKey` 的 24 位十六进制哈希，不是密钥本身。敏感记录的文本在 `searchVisible` 过滤前就被解密（production-http-composition.ts:1374-1391 + production-search.ts:331-333），不会展示但会短暂进入内存；作者“解密在分类过滤前、只在服务器内存”的说法属实，可考虑先按 `dataClassification` 过滤再解密。硬删除有 `ON DELETE CASCADE`，且 `foreign_keys=ON`（migration-engine.ts:1215）。
- 资源耗尽：`indexTermLimit`/`indexRebuildBatch` 有严格上下界（1..100000 / 1..1000，SQL 端 limit 也 ≤1000），两端一致；但重建总量无预算（见意见 5）。
- 规则/文档一致性：`docs/kv-cache-guide.md:57` 明确感知内容只作为 `perception_read` 工具结果追加、不进入请求开头，与本次改动方向一致；作者关于“失败写空词表”的说法与代码不一致（意见 3）。新表与新配置键在文档中没有列举，未发现必须同步的配置文档。
- 迁移与清单：新迁移文件时间戳 `20261114175847` 晚于现有最新的 `20261114170228`，名称符合 `^[a-z][a-z0-9_]*$`，会被自动发现；`schema-catalog.ts` 已加同名条目，表清单契约测试会比较实际表与清单（读代码证实）。

**必答问题**

1. 不改变模型已见过的请求开头。本增量只改感知搜索索引与 `search.ask` 的答案文本，属于 gateway 查询结果，不是系统提示/工具定义/历史消息；`docs/kv-cache-guide.md:57` 也写明感知内容只作为 `perception_read` 的工具结果追加在末尾。未发现任何往请求前缀写内容的新代码（该路径未核实到模型侧拼装，但搜索路径本身未改拼装）。
2. 不会。索引词由确定性的 `perceptionSearchEvidenceText`（按 `PERCEPTION_RECORD_TYPES` 固定字段顺序）+ HMAC 分词生成；版本串由稳定的 `csrfKey` 推导，只含规则名与配置上限，不含时间；答案拼接顺序固定（转写在前、evidence 在后）。没有依赖前后文的遮盖、时间字段或无序集合进入索引/版本。响应里的 `generatedAt` 是原有每请求时钟字段，不属于索引也不进请求前缀。
3. 有检查但覆盖不完整：新增“带转写的记录用窗口标题可搜到”和“excludeRecordIds 生效”两条用例；前者若索引不含 evidence 会失败，后者若 SQL 不应用排除会失败。但生产答案映射被测试副本遮蔽、失败重试的 service 分支没有用例，反向回退它们不会让测试失败（意见 2）；`readText` 返回 `undefined` 的残留场景也无用例（意见 1）。
4. 逐个核对：`excludeRecordIds`（service/test 产生 → durable-adapters 分发 → SQL `json_each`）两端类型一致，id 来自数据库；`searchVersion`/`version` 串（composition 产生 ~71 字符、测试 32 字符 → 状态表 `CHECK length 1..128` 与等值比较）均可接受；`indexTermLimit`/`indexRebuildBatch`（strict-config 校验、默认值齐全 → composition 使用 → SQL limit ≤1000 与配置上限 1000 一致）可接受；新迁移/清单/级联一致。唯一“使用端不能接受”的语义问题是 `readText` 返回 `undefined` 被当作成功（意见 1），以及软删除后状态行残留（意见 4）。
