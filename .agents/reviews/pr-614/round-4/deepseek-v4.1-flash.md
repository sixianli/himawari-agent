## 复核范围

- 本轮增量 `git diff 2535568c3..02a8b1875`。对本次 PR 的生产代码路径（`apps/agent-service`、`packages/memory-engine`、`packages/persistence-sqlite`、`packages/application`、`test/integration/conversation-turns.test.ts`）运行 `git diff` 均无输出；增量里唯一的代码改动是复核工具 `scripts/model-review/plan-claims.mjs` 及其测试，其余是 main 合并带来的品牌素材/文档和复核记录。
- 因此上轮两条意见所在的代码在增量中**完全没变**，作者“已修改”的说法与代码不符。
- 我另外核对了作者说法 1–5、ADR 0286 新加的行号引用，以及新值（id、day、时间、terms、embedding、分类、端口方法、事件名、迁移）的产生端与使用端。

---

### 1、中、上一轮意见 1 仍未修复：一个永久读不出的轮仍会阻塞该线程之后所有轮

文件:行: `packages/memory-engine/src/conversation-turns.ts:164-193`、`packages/memory-engine/src/conversation-turns.ts:232`

问题: `indexDue` 的 `try/catch` 包住的是“整个线程的读取 + 所有轮”，不是单轮。任一轮在严格读取正文时抛错，该线程本轮立即中止；由于水位是用已写入行的 `max(last_sequence)` 反推，失败轮永远不会写行，下一次又从同一个位置重读，于是失败轮之后的轮永远到不了。

证据:
```ts
164:    for (const watermark of behind) {
166:      try {
167:        const { messages, reachedEnd } = await this.#readTurns(...);
174:        for (const turn of reachedEnd ? turns : turns.slice(0, -1)) {
181:          await this.#index(...);
190:      } catch (error) {
191:        this.#options.onIndexFailure?.(error);
192:      }
```
```ts
232:    const lines = await this.#lines(ownerId, agentId, turn.messages, true);
```
```ts
159:      const behind = await this.#options.store.listBehind({...});
...
323:          AND m.last_sequence > COALESCE(i.indexed_through, 0)
```
`catch` 让该线程本轮 0 写入，`listBehind` 依据 `conversation_turns` 的 `max(last_sequence)` 判断进度，失败轮不写就永远“还差它”。增量 `git diff 2535568..02a8b187 -- packages/memory-engine/src/conversation-turns.ts` 为空，作者并未改这里。

建议: 把失败处理下沉到单轮（`try { await this.#index(turn) } catch { report }` 后继续读后续轮），并引入与 `conversation_turns` 行无关的每线程扫描游标（或给失败轮记 `failed/retry_at` 状态），使后续轮能推进而失败轮仍可重试。仅在 `indexDue` 内 `continue` 不够：后续轮写行后 `indexed_through` 会越过失败轮，失败轮将永不重试，必须显式保存待重试状态。

### 2、低、上一轮意见 2 仍未修复：补向量队列无游标，队头足够多的永久失败轮会饿死后面的健康轮

文件:行: `packages/persistence-sqlite/src/sqlite-conversation-turn-operations.ts:344-355`、`packages/memory-engine/src/conversation-turns.ts:266-293`、`apps/agent-service/src/service-main.ts:1982-2011`

问题: `listUnembedded` 每次按 `indexed_at, id` 取固定队头，没有游标；补向量失败时不写 `embedding_model`、也不更新任何“已尝试”字段，下一轮还是同一批队头。若队头有 ≥ limit 个永久失败轮，后面的健康轮永远轮不到。两处调用方又在 `embedded === 0` 时直接 `break`，不会绕过队头继续扫描。

证据:
```ts
// listUnembedded，无游标
347:          `SELECT ... FROM conversation_turns c
352:            AND (c.embedding_model IS NULL OR c.embedding_model != @model
353:              OR c.embedding_dimensions != @dimensions)
354:            ORDER BY c.indexed_at, c.id LIMIT @limit`,
```
```ts
// 失败轮 continue，不留任何尝试记录
290:      } catch (error) {
291:        this.#options.onIndexFailure?.(error);
292:      }
```
```ts
// 追赶循环：0 条即退出，无法越过队头
1990:              if (embedded === 0) break;
...
2010:            if (embedded === 0) break;
```
作者说“已修改”，但增量没有触碰上述文件；`backfillEmbeddings` 的这个缺陷与旧版一致。

建议: 给补向量队列加游标/分页（例如按 `(indexed_at,id)` 或新增 `embedding_attempted_at`），每轮从上次位置继续；对永久失败设退避与上限，失败也不占住队头。这样无需一次扫描全部数据也能让后面健康轮拿到名额。

---

**侧重检查**

- 错误路径：确认单轮读取失败、补向量失败两条路径如上，均会被 `onFailure` 记录，但都导致永久阻塞/饥饿；这正是上轮两条意见。
- 不可信/不合规范输入：`upsert` 校验了 `day`、序列、分类、ISO 时间、terms 无空白、embedding 形状；`search` 校验了 limit、分类子集、from/to、terms 与 embedding；`attachEmbedding` 校验了 turnId/lastSequence/embedding。`indexableTerms` 输出的词不含空白，能过 `upsert` 的 `/\s/` 校验；`localDay` 的 en-CA 输出是 `YYYY-MM-DD`，能过 `DAY`。`validTime` 要求严格等于 `toISOString()`，生产 `clock.now()` 与测试时间戳满足；但我未逐一核实所有 `thread_messages.committed_at` 写入方（未核实），若有非 `toISOString` 的时间戳，会触发与意见 1 相同的永久阻塞。
- 安全/密级：`search` 把 `allowedClassifications` 再过滤为 model-visible，restricted 不会进入检索；FTS terms 经过 `maskForIndex`；“嵌入只送 `embeddableClassifications` 包含的密级”在 `#embed` 有明确判断。`readText` 用 owner/agent 解保护。未发现新增越权读。
- 删除/级联：迁移里 `thread_id ... REFERENCES threads(id) ON DELETE CASCADE`，`conversation_turns` 删除触发器删 FTS 行；`migration-engine.ts` 与 `sqlite-worker.ts` 都设了 `foreign_keys = ON`，`MINIMUM_SQLITE_VERSION = 3.51.3` 支持 `contentless_delete`。作者说法 1 成立。
- 资源耗尽：`#embed` 截 2000 字符；`search` limit 上限 500；`listBehind`/`listUnembedded` limit 上限 100；terms 512；未发现新增无界循环（`catchUp` 0 即退出）。`#readTurns` 会读到下一轮主人话为止，单个超长轮仍可能读很多条消息，属既有行为。
- 规则/文档/代码一致：ADR 0286 新加的“第 36 行/第 42 行”引用与 `.agents/instructions/prompt-prefix.md` 第 36、42 行原文一致；该 ADR 关于“本 PR 不改发给模型内容”与代码一致。
- 增量唯一代码改动（`plan-claims.mjs` 全角竖线回退）只影响复核脚本，带正反用例，未发现新错。

**必答问题**

1. **不会改变模型已见过的请求开头。** 本次增量没有任何系统提示、工具定义、历史消息或遮盖逻辑的改动；索引只读 `thread_messages` 载荷并发独立的嵌入调用，未改写 `RuntimeRequest`。仍满足“只在末尾追加、每轮变化值在最后一条消息”的既有约束；本项与本次增量无关。依据 `prompt-prefix.md:27-28,36`。
2. **不会让同一段文字在模型请求里变成不同字节。** 本 PR/增量不组装或修改模型请求。索引内部确实有随时间变化的值（`indexedAt: now()`）和依赖时区的 `day`，但只写入数据库，不进入模型请求；检索排序（RRF 同分按 id、SQL 按 bm25/信号再 id）是确定的。
3. **自动检查：增量改动有；上轮两条问题的反向用例缺失。** `plan-claims` 的改动有正例和反例（测试第 214 行附近）。但意见 1 的测试（`conversation-turns.test.ts:610`）只覆盖“读不出后恢复”，没有“永久读不出、后面还有轮”的反例；意见 2 的测试（第 673 行）只覆盖回收站对话不占名额，没有“队头永久失败、后面健康轮”的反例。读代码可推断这两个反例当前会失败（未运行测试，仅静态判断）。
4. **新值的两端检查基本对得上。** `id = turn:${threadId}:${first.sequence}` 在 `upsert`（字符串非空）、`attachEmbedding`、检索合并键、测试中使用，无格式依赖；`day` 满足 `DAY` 正则；时间满足 `validTime`（但未核实所有 `committed_at` 写入方）；`terms` 无空白、`embedding` 长度/维度经 `validEmbedding` 与 DB CHECK；分类经 `CLASSIFICATIONS` 与 `MODEL_VISIBLE`；新端口 `conversationTurns()` 在 `sqlite-durable-operations` 有 `conversationTurn.` 前缀分派，`service-main` 与单测 mock 均接受；新事件 `conversation-turn.failed` 在 `service-main.ts:1846-1852` 产生、单测第 1182 行检查；新选项 `turns` 在 `production-run-composition` 的 Pick 与 `service-main.ts:3251` 传入、`ProductionMemoryEpisodes` 可选接受。迁移的外键级联与 FTS 触发器、SQLite 版本支持均一致。
