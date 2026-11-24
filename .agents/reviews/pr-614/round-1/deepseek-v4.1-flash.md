## 读代码证实的意见

### 1、高、单轮消息超过 200 条时永远索引不完，每次 indexDue 重复索引开头 200 条
文件：`packages/memory-engine/src/conversation-turns.ts:164-188`
问题：读取窗口固定从 `indexedFrom - 1` 开始。若一个轮次本身就有 200 条以上消息，`messages.length === MESSAGES_PER_READ` 使 `complete` 为空，`usable = turns` 只索引窗口内前 200 条，`lastSequence` 写成 200；真实最后一条在 250，`listBehind` 永远认为还落后，下一次又从该轮第一条重新读到 200，永远推进不到 201 以后。
证据：
```ts
const messages = await this.#options.threads.listMessages(
  ..., Math.max(0, watermark.indexedFrom - 1), MESSAGES_PER_READ);
const complete = messages.length < MESSAGES_PER_READ ? turns : turns.slice(0, -1);
const usable = complete.length > 0 ? complete : turns;
...
lastSequence: last.sequence,
```
建议：把“已扫描到哪条消息”与“最后一轮从哪开始”分开记录；单轮填满窗口时从 `indexedThrough` 继续往后读并合并，或先找到下一个 owner 消息再截断。补一条超过 200 条消息的单轮测试。

### 2、中、读取和嵌入失败被静默吞掉并推进水位，非最后一轮永久缺内容且没有日志
文件：`packages/memory-engine/src/conversation-turns.ts:94-97`、`143-146`、`213-227`；`apps/agent-service/src/service-main.ts:1848-1865`
问题：`readText` 的任何异常都变成 `undefined`；`#embed` 的异常只调用可选的 `onEmbeddingFailure`。但 `#index` 仍会用 `lastSequence = last.sequence` upsert，水位照常推进。如果失败发生在非最后一轮，下一次 `indexDue` 从最后一轮的第一条开始读，这一轮再也不会重试；生产构造 `ConversationTurnService` 时没有传 `onEmbeddingFailure`，所以既没有失败日志，也不会走 `ProductionMemoryEpisodes.onFailure`。作者说法 4 的“索引失败只走 onFailure”对这两类失败不成立。
证据：
```ts
const text = await this.#options
  .readText({ ownerId, agentId, ref: message.contentRef })
  .catch(() => undefined);
...
} catch (error) {
  this.#options.onEmbeddingFailure?.(error);
  return null;
}
```
建议：区分“确实没有正文”和“读取失败”；读取失败时不要推进该轮水位或记录待重试；生产里把 `onEmbeddingFailure` 接到诊断日志；补读取失败、嵌入失败的反向测试。

### 3、中、listBehind 统计未提交消息，partial/failed 行会让水位永远落后并每轮重复索引
文件：`packages/persistence-sqlite/src/sqlite-conversation-turn-operations.ts:305-314`；对照 `packages/persistence-sqlite/src/sqlite-thread-operations.ts:1510-1513`；`packages/memory-engine/src/conversation-turns.ts:179`
问题：`listBehind` 的 `m` 子查询统计 `thread_messages` 时没有 `message_status = 'committed'`，而 `listMessages` 只返回 committed。只要存在一条 sequence 更大的 partial/failed 消息，`m.last_sequence` 就永远大于 `indexed_through`；同时最后一轮的 `first.sequence === indexedFrom` 会绕过第 179 行的跳过条件，于是每轮都重新索引、重新嵌入同一轮，浪费额度，并可能占满 `MAXIMUM_TURNS_PER_RUN` 让其他对话排不上。
证据：
```sql
JOIN (SELECT thread_id, max(sequence) AS last_sequence, max(committed_at) AS last_at
  FROM thread_messages WHERE owner_id = @ownerId AND agent_id = @agentId
  GROUP BY thread_id) m
...
AND m.last_sequence > COALESCE(i.indexed_through, 0)
```
建议：子查询加 `AND message_status = 'committed'`；补一条 partial 消息的测试。注：当前稀疏检出里没有找到生产写入 partial 的路径，可达性见“未核实”。

### 4、中、upsert 和 attachEmbedding 没有版本校验，并发时旧结果会覆盖新结果、旧向量会贴到新正文
文件：`packages/persistence-sqlite/src/sqlite-conversation-turn-operations.ts:154-183`、`356-370`；`packages/memory-engine/src/conversation-turns.ts:247-255`
问题：`upsert` 无条件按 id 或 `(thread_id, first_sequence)` 删除再插入，`attachEmbedding` 只按 `turnId` 更新，都没有“期望的 lastSequence / 正文摘要”。两个 run 的 `indexDue` 或启动补向量与 `indexDue` 并发时，较旧的一次 upsert 可以覆盖较新的 `lastSequence`；更糟的是补向量先读到旧正文算出向量，随后新正文被索引，`attachEmbedding` 仍把旧向量贴到新行。之后 `listUnembedded` 因 model/dimensions 已匹配不会再补，旧向量会一直留着。
证据：
```ts
"DELETE FROM conversation_turns WHERE id = ? OR (thread_id = ? AND first_sequence = ?)"
...
`UPDATE conversation_turns SET embedding_model = ?, embedding_dimensions = ?, embedding = ?
 WHERE id = ?`
```
建议：`upsert`/`attachEmbedding` 带上期望的 `lastSequence`（或正文摘要）做条件更新/拒绝过期写；或按 turn 串行化。补并发测试。

### 5、中低、索引被放在运行完成屏障之前，最坏 20 次嵌入会拖慢一轮收尾
文件：`apps/agent-service/src/production-memory-episodes.ts:112-113`、`57-64`；`apps/agent-service/src/production-titled-runtime.ts:60-64`
问题：`#summarize` 先 `await this.#indexTurns(request)`，然后才 `dueSegments`/`summarize`；`start()` 返回的 `admitted` 要等 `onAdmitted`（摘要模型开始）或 `#summarize` 全部结束。`createProductionTitledRuntime` 在 `runtime.completed` 等屏障事件上 `await memoryAdmission`。因此每轮最多 20 次嵌入都在运行完成的关键路径上，和“跑完后顺带索引”的预期不符。
证据：
```ts
async #summarize(request: RuntimeRequest, onAdmitted: () => void): Promise<void> {
  await this.#indexTurns(request);
  await this.#options.service.backfillEmbeddings(...)
```
建议：把 turn 索引放到 `onAdmitted` 之后或摘要准入之后，不阻塞运行完成屏障；补一条收尾时延测试。

### 6、低、search 的查询向量没有过 embeddableClassifications，且返回全文没有字符预算
文件：`packages/memory-engine/src/conversation-turns.ts:290-299`、`301-311`、`320-326`
问题：文档嵌入在 `#embed` 里先检查 `embeddableClassifications`（第 128-134 行），但 `search` 直接 `embedQuery`，只把 `"private"` 交给 `within`；如果准入层不按这个清单拦截，就会把 private 查询发给只允许 public 的嵌入模型。另外每个命中都 `turnLines` 读最多 1000 条消息并原样返回，500 个命中时最坏 50 万次消息读取，且没有字符预算，下一 PR 接工具时容易超出 2% 上下文预算。
证据：
```ts
vector: await (input.within ?? direct)("private", () => embedder.embedQuery(input.query)),
...
const lines = await this.turnLines(turn);
if (lines.length > 0) hits.push(Object.freeze({ turn, lines: Object.freeze(lines), score }));
```
建议：查询嵌入也按 `embeddableClassifications` 先判断；给 search 命中加每条/总字符预算，并限制 query 长度。

### 7、低、日期搜索要求精确 ISO，下一 PR 的“按日期”参数会被后端拒绝
文件：`packages/persistence-sqlite/src/sqlite-conversation-turn-operations.ts:43-46`、`207-209`
问题：`validTime` 要求 `new Date(parsed).toISOString() === value`，即必须是带毫秒和 `Z` 的完整时刻。设计里写的是“按日期找”，下一 PR 的工具若传 `2026-11-21` 或 `2026-11-21T00:00:00Z`，会被 `PORT_INVALID_OPERATION` 拒绝。这是 I-73 那类“工具产出的值过不了后端校验”的提前风险。
证据：
```ts
return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
...
(input.from !== null && !validTime(input.from))
```
建议：在 service 或工具层把日期归一化成当天起止的完整 ISO，或让存储层接受日期格式；补日期参数契约测试。

### 8、低、删除对话的测试没有验证 FTS 行真的被触发器删掉，也没有覆盖几个关键反向路径
文件：`test/integration/conversation-turns.test.ts:317-352`
问题：删除测试只查 `conversation_turns` 和 `search`。`search` 本身会 JOIN `threads` 并排除已删对话，所以即使 `conversation_turns_terms` 触发器失效、FTS 行残留，测试也会通过。作者说法 1 的“触发器删掉 conversation_turn_terms 行”没有自动检查。另外没有覆盖：超过 200 条消息的单轮、读取失败、partial 消息、stop 中途停止、service-main 补向量循环、minimumSimilarity 阈值过滤。
证据：
```ts
connection.prepare("DELETE FROM thread_messages WHERE thread_id = ?").run(TALK);
connection.prepare("DELETE FROM threads WHERE id = ?").run(TALK);
...
expect(resource.turnRows().map(({ threadId }) => threadId)).toEqual([OTHER]);
expect(await resource.search("面试")).toEqual([]);
```
建议：删除后直接断言 `SELECT count(*) FROM conversation_turn_terms WHERE rowid = ...` 为 0；补上述反向用例，尤其去掉触发器、去掉 committed 过滤、去掉 minimumSimilarity 过滤时必须有测试失败。

### 9、低、stop() 后仍可能开始补向量
文件：`apps/agent-service/src/production-memory-episodes.ts:93-101`
问题：`#indexTurns` 先执行 `backfillEmbeddings`，之后才检查 `#stopping`。`stop()` 在 backfill 期间被调用时，backfill 仍会继续；`indexDue` 不会开始。作者说法 4 的“stop() 后不再开始新的索引”只对 `indexDue` 成立，对 backfill 不成立。
证据：
```ts
await turns.backfillEmbeddings({...}).catch(this.#options.onFailure);
if (this.#stopping) return;
await turns.indexDue({...}).catch(this.#options.onFailure);
```
建议：backfill 前也检查 `#stopping`，并给 backfill/indexDue 传 `AbortSignal`。

## 推测与未核实

- 生产是否存在写入 `thread_messages.message_status = 'partial'` 的路径：当前仓库是 54% 稀疏检出，未找到写入方，但 schema 和现有测试明确使用 partial/failed，所以第 3 条的可达性标为“未核实”。
- SQLite 在外键级联删除 `conversation_turns` 时是否会触发 `AFTER DELETE` 触发器：按 SQLite 行为应当会，但我没有运行数据库，标“未核实”；测试也没有覆盖。
- 嵌入请求是否已经在 egress 层被遮盖：`embedding.ts:258` 走 `this.#options.egress.exchange(...)`，所以 `#embed` 送出的原文可能在外发前被统一遮盖；这一点未逐行核实，因此没有把“原文进嵌入模型”列为确定问题。
- 多个 owner run 是否真的会并发执行到 `ProductionMemoryEpisodes`：代码没有显式串行化，第 4 条的竞态是据此推断。

## 侧重检查

- 错误路径：`#line` 吞读取异常、`#embed` 吞嵌入异常、水位仍推进（意见 2）；`listBehind` 未过滤未提交消息（意见 3）；`stop()` 与 backfill（意见 9）。
- 不合规范/不可信输入：FTS 查询词经过 `ftsQuery` 引号转义（安全）；`allowedClassifications` 在存储层校验只允许 public/private/sensitive；`validEmbedding` 校验 model/dimensions/长度，但没有像记忆索引那样检查 `Number.isFinite`（低风险，未单列）；日期必须是完整 ISO（意见 7）。
- 安全：词表走 `indexableTerms` → `maskForIndex`，确实遮盖后再入 FTS；restricted 消息在 `#line` 被排除；think/trashed 在 search/window 被排除；但 `search`/`window` 返回的是未遮盖原文，依赖下一 PR 的 egress 遮盖，本 PR 没有测试这一点（意见 6 相关）。
- 资源耗尽：超过 200 条消息的单轮反复索引（意见 1）；search 最坏 500×1000 条消息读取且无字符预算（意见 6）；启动补向量 `for(;;)` 正常会在 `embedded === 0` 退出，但会一次性跑完所有待补轮次。
- 不可撤销操作：threads 行删除依赖外键级联 + 触发器清理 FTS；回收站恢复只改状态、不重建索引，能恢复搜索；删除路径的 FTS 清理没有直接测试（意见 8）。
- 规则/文档与代码一致性：`schema-catalog.ts` 写 conversation_turn_terms “masked before indexing”，与 `indexableTerms` 一致；ADR 0286/设计说明的“发给模型前遮盖”由 egress 负责，本 PR 没有新增发送路径；作者说法 1、2、3、5 基本与代码一致，说法 4 对读取/嵌入失败不成立。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。这个 PR 只读取 `thread_messages` 和加密载荷，写入新表 `conversation_turns` 和 FTS；没有改系统提示、工具定义、历史消息、遮盖结果，也没有新增模型工具。发给模型的内容仍然是只追加；每轮会变的值没有被塞进更早位置。唯一的行为变化是索引在运行完成屏障前执行，属于时延，不是内容字节变化。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
对模型请求不会，因为本 PR 没有改请求序列化或遮盖路径。索引自身：`terms` 按原文顺序生成、`search` 按固定规则排序、`day` 只依赖时间配置，都是确定的；`indexedAt` 每次重索引会变，但它是索引元数据，不发模型。需要留意的是 `indexableTerms` 对整轮文本做 `maskForIndex`，同一轮变长时旧词的遮盖结果可能变，但索引行是整行替换，不影响模型请求字节；未来工具若对“整页文本”而不是“单条消息”做遮盖，才会产生同一条旧消息在不同页里遮法不同的问题。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有新增 `test/integration/conversation-turns.test.ts` 的 8 条集成测试，覆盖索引、搜索、重索引、补向量、回收站/删除、翻页、生产接线、密级门禁；还有 `service-orchestration.unit.test.ts` 的 mock 补充。但反向覆盖不足：删除测试没有直接断言 FTS 行被清掉，去掉触发器不会失败；没有超过 200 条消息的单轮、读取失败、partial 消息、stop 中途停止、service-main 补向量循环、minimumSimilarity 阈值过滤的测试。因此说法 1 的 FTS 清理、说法 3 的阈值过滤、说法 4 的 stop、说法 5 的循环都没有真正被自动检查守住。我没有运行测试（只能用 git/read），以上按代码阅读判断。

**4. 改动产生或修改的每个值，每个使用方都能接受吗？**
逐个核对后：
- `turn:${threadId}:${first.sequence}`：`attachEmbedding` 只要求字符串，`search` 用作 Map key，能接受；但 `attachEmbedding` 只凭 id 无法识别正文版本，见意见 4。
- `day`：`localDay` 返回 10 位日期，迁移 `length(day)=10`、upsert 正则都能接受。
- `firstSequence`/`lastSequence`：迁移和 upsert 的 `last >= first >= 1` 校验一致；但 `lastSequence` 会被截断（意见 1）和并发覆盖（意见 4）。
- `dataClassification`：`highestClassification` 只会产出 public/private/sensitive/restricted，迁移 CHECK、upsert、`MODEL_VISIBLE` 都能接受。
- `startedAt`/`endedAt`/`indexedAt`：`validTime` 与迁移无格式 CHECK，但要求精确 ISO；现有线程时间戳未逐条核实是否都满足。
- `terms`：`indexableTerms` 已经 `maskForIndex` 且过滤密钥词；upsert 只拒绝含空白字符的项，长度/数量在生成侧有上限，能接受。
- `embedding`：`validEmbedding`、迁移 CHECK、`vectorBlob`、`vec_distance_cosine`/`blobVector` 两端一致；但 `validEmbedding` 未检查 `Number.isFinite`，比记忆索引的校验松。
- `from`/`to`：存储层要求完整 ISO，下一 PR 的日期工具值可能过不了（意见 7）。
- `conversationTurns()` 新方法：只在 `SqliteProductStateRepository` 和 `SqliteDurableAdapters` 上新增，不在 `ProductStateRepositoryPort` 接口里，现有其他实现不受影响；`ProductionMemoryEpisodesOptions.turns` 的类型和 service-main 的 spread 也能接受。
- 迁移/清单：`conversation_turns` 及四个 FTS shadow table 都加进了 `schema-catalog`，与 `migration-engine.contract.test.ts` 的“实际表名等于清单”检查一致；删除描述与迁移的级联/触发器一致。

作者说法逐条核对：1 代码成立但缺 FTS 清理测试；2 代码成立，但受超过 200 条消息和 partial 消息两个边界影响；3 代码成立但缺阈值/RRF 测试；4 对存储/upsert 错误成立，对读取/嵌入失败不成立；5 正常情况下会退出，但缺测试且存在空正文/异常密级下的饥饿边界。
