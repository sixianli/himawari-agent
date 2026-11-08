# 复核结论

## 按严重度排列

### 1. 中：第二次检索并不是“只取待确认”，待确认会被正式记忆挤出候选窗口

**文件:行** `apps/agent-service/src/production-memory-recall.ts:175-188`（配合 `packages/memory-engine/src/hybrid-memory-provider.ts:155-169`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:242`）

**问题**：作者/ADR 说第二次检索“带 `includeTentative` 只取待确认的”，但该开关的语义是“待确认 + 正式都取”，代码只是事后再过滤。第二次检索和正式检索用同样的分数排序、同样的 `limit * 3` 截断，因此当同一查询命中的正式记忆超过 `limit × 3` 条时，待确认记忆可能根本进不了这 30 条，于是“补在后”的待确认一条都拿不到——功能静默失效。

**证据**：
- `production-memory-recall.ts:175`、`:186`：两次检索都传 `limit: input.limit * 3`。
- `hybrid-memory-provider.ts:165`：`...(input.includeTentative === true ? { includeTentative: true } : {})`。
- `sqlite-memory-operations.ts:242`：`AND (@includeTentative = 1 OR m.tentative = 0)`——传 true 等于不过滤，正式+待确认全部返回。
- `hybrid-memory-provider.ts:167-169`：`fuseCandidates(result, { ... limit: input.limit ... })`，这里的 `input.limit` 就是请求的 `3 × limit`，即第二次检索也只保留融合后的前 `3×limit` 条。
- `production-memory-recall.ts:207-217`：`render()` 在拿到候选后才按 `tentative` 属性过滤。

**建议**：在索引查询层增加真正的 `tentativeOnly` 过滤（`m.tentative = 1`），或用一次查询同时取回带 tentative 标记的候选后在应用层分区；至少不要用“包含全部”的 `includeTentative` 结果冒充“只取待确认”。

### 2. 中：limit ≥ 2 时每次检索都多一次同文本向量化，且与是否有待确认无关

**文件:行** `apps/agent-service/src/production-memory-recall.ts:168-191`

**问题**：只有 `tentativeLimit === 0`（即 `limit = 1`）才跳过第二次检索；`limit ≥ 2` 时无论库里有没有待确认记忆，都会对同一句话再发一次 embedding 请求。这是固定的双倍向量化费用/配额/延迟，而不是“有待确认才多花”。作者在 ADR 里承认了这次成本，但实现并没有做到“没有待确认就不付”。

**证据**：
- `production-memory-recall.ts:179-190`：`tentativeLimit === 0 ? Promise.resolve([]) : this.#options.embedWithin(... provider.search({ ... includeTentative: true }))`，条件只看 `limit`，不看是否存在待确认。
- `hybrid-memory-provider.ts:143`：每次 `search()` 都 `await embedder.embed(...)`。
- `packages/memory-engine/src/embedding.ts:168-185`：`GatewayEmbedder.embed()` 没有任何缓存/单飞，每次调用都会走一次 HTTP。
- `hybrid-memory-provider.ts:149-151`：embedding 失败被吞掉并继续用词法结果，因此第二次 embedding 若撞上服务商配额/并发限制，会**静默降级**，不会报错。

**已核实的边界**：两次 `embedWithin` 的 slot 不同（`memory-recall` 与 `memory-recall-tentative`，见 `service-main.ts:1265` 再拼 `toolCallId`），因此不会命中同一条 admission 身份冲突/replay，逻辑键层面是安全的；重复计费来自两次真实的外呼，不是同一身份被重复结算。

**建议**：复用同一次 embedding 做两次索引查询（把向量下传），或改成一次 `includeTentative` 查询 + 应用层确定性分区；若要保留两次查询，至少让第二次查询使用真正的 tentative-only 过滤，避免既重复计费又取不全。

### 3. 低-中：ADR 说法与代码不一致（“只取待确认”“不挤掉正式记忆”）

**文件:行** `docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:56`；`apps/agent-service/src/production-memory-recall.ts:238`

**问题**：
- ADR 写“一次带 `includeTentative` 只取待确认的”，与上面第 1 条不符（实际取全部再过滤）。
- ADR/提交说明写“待确认记忆既不会挤掉……正式记忆”，但 `confirmed` 名额是 `input.limit - tentativeMemories.length`；有 2 条待确认时，`limit = 4` 只返回 2 条正式记忆，即使库里有 10 条正式命中。严格说待确认确实占掉了正式记忆的名额。

**证据**：
- `production-memory-recall.ts:234-240`：`const tentativeMemories = await render(tentativeHits, "tentative", tentativeLimit);` → `render(hits, "confirmed", input.limit - tentativeMemories.length)`。
- ADR 第 56 行原文：“一次带 `includeTentative` 只取待确认的……待确认记忆既不会挤掉也不会改变正式记忆的名次”。

**建议**：把 ADR 改成“第二次检索包含待确认并在应用层只留待确认”，并明确“待确认占用请求条数的一半名额，因此正式记忆返回条数会减少”；如果产品要求真的是“不挤掉”，应改为正式最多 `limit` 条 + 待确认额外最多 `floor(limit/2)` 条，而不是从正式名额里扣。

### 4. 低：反向用例没有覆盖本轮修复的关键点

**文件:行** `apps/agent-service/test/production-memory-recall.unit.test.ts:132-142,161-221`

**问题**：现有反向用例能覆盖“待确认排在正式之后”“最多一半”“超分类不返回”，但**不能**发现本轮真正要修的回归：把正式检索改回 `includeTentative: true`，或 `limit = 1` 仍然发第二次检索，所有测试仍会通过。因为测试只断言输出顺序，且 `render()` 本来就会按 `tentative` 属性过滤，正式检索带不带待确认在测试数据量下输出相同。

**证据**：
- `:132-142` fake 根据 `request.includeTentative` 返回数据，`:168` 只断言最终文本顺序，`:217` 只断言最终列表。
- 没有任何断言检查第一次 `search` 调用的 `includeTentative` 为 `undefined/false`。
- `:218-220` 只断言 `limit = 1` 时没有 `tentativeNote`，没有断言第二次 `search`/slot 没被调用。
- 可复现：把 `:171-177` 正式检索加回 `includeTentative: true`，上面三个 `[PA-2]` 用例仍然全过。

**建议**：增加对 `f.search.mock.calls` 的断言：第一次调用不含 `includeTentative`，第二次含 `includeTentative: true`；`limit = 1` 时 `search` 只被调用一次、`slots` 不含 `memory-recall-tentative`。

---

## 侧重检查（错误路径、不可信输入、安全、资源、不可撤销操作、文档一致）

**已读代码证实：**
- **新增 slot 的下游校验**：`memory-recall-tentative` → `service-main.ts:1265` 拼成 `${slot}:${toolCallId}` → `production-run-memory.ts:320-336` 作为 `embeddingSlot` → `sqlite-model-invocation-operations.ts:275` 仅要求 `logical_slot` 非空（迁移 `0023...sql:5` 是 `CHECK (length(trim(logical_slot)) > 0)`，无长度上限），`invocation_id` 用 hash 生成。新 slot 能通过校验，且与 `memory-recall`、`memory-recall-episodes` 不冲突。
- **重复 id**：第二次检索会同时返回正式记忆，`[...hits, ...tentativeHits]` 会有重复 id；但 `sqlite-memory-operations.ts:542` 用 `new Set(...)` 去重，且 `:539-540` 的 1000 条上限对最多 60 条输入无影响。安全。
- **不可信输入**：没有新增外部输入面；`limit` 仍是 1..10 的整数、`query` ≤ 500，`render` 只按记录属性过滤。未发现注入或越权路径。
- **不可撤销操作**：本次改动只有只读检索，没有写库或外部副作用。
- **prompt catalog**：新增 `tool-result.recall-tentative` 已导出（`src/index.ts:1`）并登记进 manifest；`prompt-catalog.unit.test.ts:187-193` 会校验“缺行/哈希过期/未知行”。manifest 里的哈希本身我无法计算，**未核实**；若哈希不对，该测试会失败。

**推测（未在真实环境验证）：**
- 第二次 embedding 与第一次并行，会瞬时把服务商的 embedding 并发/配额翻倍；遇到配额或并发限制时，`hybrid-memory-provider.ts:149-151` 会吞掉失败、退回词法检索，用户只会看到“结果变差”而不会看到错误。
- 大记忆库下第 1 条的“待确认被挤出候选窗口”会更常见，但需要真实数据量验证。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。系统提示、工具定义（`memoryRecallDescriptor`）本次未改；新增的是 `tool-result` 层的一条固定说明，只作为记忆检索这个工具的结果内容，在工具调用后追加，属于规则允许的“追加消息/工具结果”（`.claude/rules/prompt-prefix.md:27-35`）。历史里已经存下的旧工具结果不会被重写；`tentative`/`tentativeNote` 只出现在新产生的工具结果里。每轮会变的检索结果仍在当轮追加的工具结果中，而不是回到系统提示或工具定义。需要说明：它严格说不是“最后一条用户消息”，但工具结果是规则第 4 条明确允许只追加的历史消息类型。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
本次没有引入新的不确定性来源。`tentative` 来自记录属性，`tentativeNote` 是固定文本；记忆顺序由 `fuseCandidates` 决定，且同分时用 `memoryId.localeCompare` 兜底（`packages/memory-engine/src/fusion.ts:113`），JSON 键插入顺序固定；两次并行检索由 `Promise.all` 按数组顺序返回，不会互相改变字节。唯一随请求变化的仍是原有的 `current`（依赖 `now`）和融合里的 recency/timeWindow，不是本次新增。没有依赖前后文的遮盖或无序集合。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有，但不完整。机制上 `prompt-catalog.unit.test.ts` 会自动校验 manifest；`production-memory-recall.unit.test.ts` 的分类、配额、排序反向用例在对应逻辑被删掉时确实会失败。但本轮的关键修复（正式检索不带 `includeTentative`、`limit = 1` 不发起第二次检索）**没有反向用例覆盖**；把代码改回错误实现，现有测试仍会全过（见问题 4）。manifest 哈希本身我无法离线核算，标**未核实**。

**4. 新值的使用方都能接受吗？**
逐项核对：
- `slot = "memory-recall-tentative"`：使用方是 `embedWithin` → admission 的 `logicalSlot`；下游只要求非空，且会拼上 `toolCallId` 保证同一工具调用内唯一；与既有 slot 不冲突，可接受（`service-main.ts:1265`、`production-run-memory.ts:333`、`sqlite-model-invocation-operations.ts:275`）。
- `includeTentative: true`：`MemoryProviderProjectionPort.search` 与 `SqliteMemoryOperations.searchIndex` 都支持（`memory-projection.ts:201`、`sqlite-memory-operations.ts:1063`），可接受。
- `tentative: true` 字段：只进入 `JSON.stringify(value)` 的工具结果，没有其他解析/校验消费者（grep 只命中本文件和测试），可接受。
- `tentativeNote` / `tool-result.recall-tentative`：注册在 `background.ts:94-101` 与 manifest:431-435，`usedBy` 指向真实使用文件；只有工具结果消费，可接受。
- 双份 `productMemoryId`：`readMany` 会去重（`sqlite-memory-operations.ts:542`），可接受。
- `tentativeLimit` 算术：`floor(limit/2)`，`limit ∈ [1,10]`，非负且不会超过 `limit`，可接受。

结论：未发现会直接抛错的新标识或序列化格式问题；主要风险是问题 1 的功能静默失效和问题 2 的重复外呼成本。
