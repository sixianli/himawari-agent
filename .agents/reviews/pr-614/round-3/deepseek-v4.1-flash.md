## 本轮范围

查过 `git diff f8da845..2535568` 的全部增量（`packages/memory-engine/src/conversation-turns.ts:213-218` 一行、测试 import 重排、新用例 `test/integration/conversation-turns.test.ts:567-608`），并回看支撑结论的旧代码：`indexDue`/`#readTurns`/`#index` 全文、`listBehind`/`listUnembedded`/`upsert` SQL、迁移与 FTS 触发器、`ProductionMemoryEpisodes`、`service-main` 接线、`episodes.ts` 的补向量游标范式。未重读与增量无关的其余 PR 文件；测试未实际运行（工具受限），涉及“会不会失败”的结论是逐行推演。round-1/round-2 的复核记录文件被工具拒绝读取，未核实其原文。

## 上一轮意见核对

- 意见 1（长轮后面还有主人轮时后续轮永远建不了索引、并反复嵌入长轮）：**已改好**。旧条件 `messages.slice(1).some(owner)` 会在第二页遇到下一个 owner 就停（`reachedEnd=false`，`turns.slice(0,-1)` 只剩 resume 轮），于是每次只重索引同一个长轮；新条件 `filter(owner).length >= 2` 要求看到 resume 轮之后的第二个 owner，才能确认“下一个轮已结束”并把它写进去。新用例按旧代码推演只会得到 `[[1,251]]`，会失败，是有效回归保护。
- 意见 2、3：**增量没有碰到，仍未修复**，见下面意见 1、2。

## 作者说法核对

- 说法 1 成立：`migrations/20261124132117_conversation_turns.sql:6` `thread_id ... REFERENCES threads(id) ON DELETE CASCADE`，`:31-35` 的 `AFTER DELETE` 触发器删 FTS 行。
- 说法 2 成立：`sqlite-conversation-turn-operations.ts:156-167` 先查“已有行 last_sequence 更大就跳过”，否则按 `id` 或 `(thread_id, first_sequence)` 删除再插入；`conversation-turns.ts:242` id 固定为 `turn:${threadId}:${first.sequence}`，能覆盖不重复。含 restricted 的轮仍会写行（`#index` 用 `restricted` 分类、空 terms），`listBehind` 用 `max(last_sequence)` 作水位，能推进。
- 说法 3 成立：`conversation-turns.ts:354` 过滤 `signal >= minimumSimilarity`，`:355-360` 对词/向量两路做 RRF。
- 说法 4 成立：`production-memory-episodes.ts:93-109` 两处都 `.catch(this.#options.onFailure)`；`:101` 在 backfill 后检查 `#stopping` 再决定是否 `indexDue`。
- 说法 5 部分成立：`service-main.ts:1982-1991`、`:1994-2004` 的 `for(;;)` 在 `embedded === 0` 时退出，不会死循环；但“没有可补的轮才退出”不准确——队头有若干永久失败轮时 `embedded` 也会是 0，健康轮仍在后面却提前退出（即意见 2）。

## 意见

### 1、中、上一轮意见 2 未修复：一个永久读不出的轮仍会阻塞该线程之后所有轮

- 文件:行：`packages/memory-engine/src/conversation-turns.ts:164-192`、`:232`、`:97`
- 问题：`#index` 对整轮使用 `strict=true` 读正文，任一消息读取抛错会让 `#index` 抛出；而 `try/catch` 包住的是整个线程的 watermark 循环（`#readTurns` + 内层 for），所以该轮之后的所有轮在同一线程里都不会被索引，水位也不前进。只要这条消息永久不可读（payload 损坏、解密失败），该线程后面的内容永远缺索引。
- 证据：
  ```ts
  try {
    const { messages, reachedEnd } = await this.#readTurns(...);
    const turns = groupTurns(messages);
    for (const turn of reachedEnd ? turns : turns.slice(0, -1)) {
      ...
      await this.#index(...);
      indexed += 1;
    }
  } catch (error) {
    this.#options.onIndexFailure?.(error);
  }
  ```
  ```ts
  const lines = await this.#lines(ownerId, agentId, turn.messages, true);
  ```
  现有测试甚至把这个阻塞行为写成了期望：`test/integration/conversation-turns.test.ts:613-616` 让 TALK 第 1 轮不可读，断言 TALK 第 2 轮也没进（`turnRows()` 只有 `OTHER`），之后清掉不可读才补上。说明只覆盖了“暂时读不出”，没覆盖“永久读不出 + 后续轮”。
- 建议：把失败粒度降到“轮”。读取抛错时不要放弃整线程；为该轮记录失败/重试游标（或用单独字段/表记 attempted 水位），让 `listBehind` 能越过它继续索引后续轮，同时保留对该轮的有限重试，避免永久坏数据把整段对话吞掉。

### 2、中、上一轮意见 3 未修复：补向量队列无游标，队头足够多的永久失败轮会饿死后面的健康轮

- 文件:行：`packages/persistence-sqlite/src/sqlite-conversation-turn-operations.ts:344-355`、`packages/memory-engine/src/conversation-turns.ts:266-293`、`apps/agent-service/src/service-main.ts:1982-1991`、`apps/agent-service/src/production-memory-episodes.ts:10,93-100`
- 问题：`listUnembedded` 固定 `ORDER BY indexed_at, id LIMIT @limit`，没有 keyset 游标；`backfillEmbeddings` 只在页内逐条 `try/catch` 后继续，失败的轮不会被写回、也永远不会被排除。生产每轮 `ProductionMemoryEpisodes` 用 `limit=20`，本机追赶用 `limit=100`；一旦队头累积到 `>= limit` 个永久读不出/嵌不出的轮，每次取到的都是同一批失败项，`embedded` 为 0，后面健康轮永远补不上向量。
- 证据：
  ```sql
  AND (c.embedding_model IS NULL OR c.embedding_model != @model
    OR c.embedding_dimensions != @dimensions)
  ORDER BY c.indexed_at, c.id LIMIT @limit
  ```
  对照已有的 episode 补向量实现已经用了游标，可作范式：
  ```ts
  after = { createdAt: episode.createdAt, id: episode.id };
  ```
  ```sql
  AND (@afterCreatedAt IS NULL OR (e.created_at, e.id) > (@afterCreatedAt, @afterId))
  ORDER BY e.created_at, e.id LIMIT @limit
  ```
- 建议：给 `ConversationTurnStorePort.listUnembedded` 加 `after`（`indexed_at,id`）游标并在 `backfillEmbeddings` 中逐页推进（像 `episodes.ts:368-385` 那样），或记录每轮针对当前 model/dimensions 的失败次数/下次重试时间并把它排除出“待补”集合。至少要让同一轮失败后不占住队头。

### 3、低、新的 `>=2` 规则可能让 `#readTurns` 把整段尾部读进内存，且没有上限/中止检查

- 文件:行：`packages/memory-engine/src/conversation-turns.ts:205-219`（`>=2` 在 `:216`），调用处 `:167` 未传 `signal`
- 问题：旧条件在 resume 轮之后看到第一个 owner 就停；新条件要等第二个 owner。若 resume 轮之后只有一个很长的、仍在增长的 owner 轮（没有第三个 owner），`#readTurns` 会一路读到线程末尾才返回 `reachedEnd=true`。`for(;;)` 没有页数/消息数上限，也不检查 `input.signal`，期间 `messages.push(...page)` 持续增长，且每次迭代 `messages.slice(1)` 复制整个已读数组（近似 O(n²)）。这只是把“资源上限”从约一页放大到整个尾段，是否达到风险取决于 agent 消息量（这部分是推测）。
- 建议：给 `#readTurns` 传入 `signal` 并在循环内检查；加上页数/消息数上限（超限就按“未到末尾”返回并下次续读）；避免每页 `slice(1)` 复制，改为维护 owner 计数。

### 4、低、`indexDue` 在 `limit=1` 时仍只重索引 resume 轮，永不推进

- 文件:行：`packages/memory-engine/src/conversation-turns.ts:165,174-188`
- 问题：循环先处理 resume 轮（`first.sequence === indexedFrom`，不会被 skip），`indexed += 1` 后下一次迭代顶部 `indexed >= input.limit` 直接 break，新轮永远轮不到。生产固定用 20（`MAXIMUM_TURNS_PER_RUN`），当前不会触发，但这是 `indexDue` 公开契约上的活锁隐患，与本次修复想解决的“后面轮建不了索引”同类。
- 建议：把重索引 resume 轮不计入 `limit`，或先推进到 `indexedThrough+1` 再计新轮数量；至少在接口上校验 `limit >= 2`。

## 侧重检查

- 错误路径/不可信输入：`readText` 抛错（strict）→ 整线程中止（意见 1）；`#embed` 抛错被吞为 `null`，轮仍写入但无向量（下次补）→ 不会阻塞索引水位，但会进入无游标补向量队列（意见 2）；`contentType !== "text/plain"` 或缺失 payload 返回 `undefined` 只是丢该消息，不抛错；`signal` 只在轮循环检查，`#readTurns` 内不检查（意见 3）。
- 资源耗尽：`#readTurns` 无页数上限、无 signal、`messages.slice(1)` 逐页复制（意见 3）；`#turnLines` 用 `Math.min(1000, last-first+1)`（`conversation-turns.ts:307`）取正文，**超过 1000 条消息的超长轮**在搜索结果/补向量用的 `turnLines` 会被静默截断到前 1000 条（这是旧代码，非增量引入，但与本次“长轮”主题相关，未来“打开原文”工具需留意）。
- 不可撤销/破坏性操作：`upsert` 是 delete+insert 且依赖 `last_sequence` 的 newer 守卫，迁移只新增表和触发器，无破坏性变更；删除 `threads` 走外键级联 + 触发器清 FTS，符合作者说法。
- 规则/文档与代码一致性：本次增量只改“读取窗口”，不涉及发给模型的前缀/工具定义/历史消息/遮盖，`prompt-prefix` 规则不受影响；ADR 0286、设计说明中“每轮索引、只存元数据+向量、正文从加密载荷读、只搜 owner/open”与代码一致。
- 未核实：未实际执行测试；未读取 round-1/round-2 复核记录原文（工具拒绝）；未逐条重读与增量无关的其余 PR 文件。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。本次增量（`conversation-turns.ts` 一行 + 测试）只影响索引哪些轮、写哪些 `conversation_turns` 行，不触碰系统提示、工具定义、历史消息、遮盖结果，也没有向模型发送任何内容；因此谈不上“只在末尾追加”被破坏。依据 `prompt-prefix.md` 的规则，本增量没有新增任何发给模型的片段。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会（针对模型请求）。增量不改变任何模型可见文本的字节；索引侧 `indexed_at = now()` 会随时间变化，但只落在本地索引表，不进模型请求，也不是新增的上下文相关遮盖。
3. **有没有自动检查，反向用例真会失败？** 部分有。意见 1 有真实反向用例：`test/integration/conversation-turns.test.ts:567-608`；按旧 `.some` 代码推演第二页就停，只会得到 `[[1,251]]`，与期望三行不符，会失败（未实际运行）。意见 2、3 **没有**能捕获的反向用例；`test/...:610-618` 反而把“永久阻塞”当成期望。意见 4（limit=1）、意见 3 的提前停止分支、>1000 条截断也没有用例。
4. **增量产生或修改的每个值，使用端都能接受吗？** 增量没有新增或修改任何标识、字段、配置键、清单项、序列化格式；它只是把既有 `conversation_turns` 行（同一 `id`/schema/范围格式）写得更多更远。我用 `grep` 找过使用端：`indexDue` 只在 `production-memory-episodes.ts:103` 和测试里；`backfillEmbeddings` 在 `service-main.ts:1984`、`production-memory-episodes.ts:94`；`turnRows`/`search` 在测试。范围值本身能通过 `upsert` 的校验（`first_sequence>=1`、`last>=first`、合法 day/time/classification）。但使用端有一处不能接受：无游标的 `listUnembedded` 无法越过队头永久失败项（意见 2）；`turnLines` 对 >1000 条轮会截断（侧重检查）。其余约定（删除级联、FTS 触发器、newer 守卫）与作者说法一致。
