## 结论摘要

核心写入路径的方向是对的：`insertConsolidationWrite` 确实放进了 `saveWithProjection` 的同一个 `transaction().immediate()`（`packages/persistence-sqlite/src/sqlite-memory-operations.ts:672-681`），`recordChange` 已无残留调用，迁移、清单、schema 版本和网关契约基本配套。

但代码里有几处与“完整依据链 / 可追溯”目标相冲突或在错误路径上不完整，下面按严重度列出。

## 侧重检查

- **错误路径**：`#revise` 的 `ApplicationPortError` 分支在“回调未执行”时会跳过（`consolidation.ts:496-513`）；`#reflect` 没有对应分支，异常会向上抛并导致整轮整理失败。事务回滚路径成立。
- **不合规范/不可信输入**：网关对 `memoryId`、`changeId`、`decisionRecordId`、时间戳都有契约校验；SQL 全部参数化；`readBasisChain` 按 `ownerId/agentId` 过滤改动，跨 owner 查询只返回空节点。但 `insertConsolidationWrite` 不校验依据记忆的归属。
- **安全**：未发现 SQL 注入或跨 owner 内容泄露；`readBasisChain` 对不存在/他人记忆返回裸叶子节点，不泄露内容。
- **资源耗尽**：200 节点上限在网关层，持久层会先把整棵树读完、构造完。见问题 2。
- **不可撤销操作**：记忆硬删除会级联删掉依据行，依据链会静默变短。见问题 1。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 与本次改动无冲突；ADR 0191 在 reflect 回填措辞上与迁移 SQL 不完全一致。见问题 5。

## 问题（读代码证实，按严重度）

### 1. 中：记忆被硬删除后，依据链静默变短，`complete` 仍可能为真

- 文件：`packages/persistence-sqlite/src/migrations/0084_memory_consolidation_basis.sql:3`、`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:885`、`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:295-314`、`apps/agent-service/src/production-memory-control.ts:295-310`
- 问题：依据行以 `ON DELETE CASCADE` 挂在 `memory_records` 上；治理删除会真的 `DELETE FROM memory_records`。于是某个依据记忆被删后，依赖它的推断记忆仍存在，但它的依据行已消失，读取接口返回的 `basis` 变空，`truncated` 仍为 `false`，网关的 `complete` 也只按节点数判断。
- 证据：
  - `memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE`
  - `database.prepare("DELETE FROM memory_records WHERE id = ?").run(objectId);`
  - `readBasisChain` 在查不到依据行时直接返回空 `basis: Object.freeze([]), truncated: false`。
- 建议：借用项目已有的 `memory_provenance.source_deleted` 模式（`sqlite-governed-deletion.ts:762`）：依据行保留 tombstone/标记，或在读取时用决策记录里的 `inputs.memoryIds` 做完整性对账并标 `truncated`/不完整。至少不能让“已删来源”和“本来就没有来源”无法区分。

### 2. 中：200 节点上限没有在持久层生效，先构造整棵链再截断

- 文件：`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:273-317`、`apps/agent-service/src/production-memory-control.ts:288-312`
- 问题：`readBasisChain` 递归 `walk` 并 `parents.map(...)` 物化整棵树（每层最多 200 条依据，深度上限 8），网关拿到完整 `root` 后才在 `#basisChain` 里按 200 截断。对大库或宽链，服务端会先做大量查询和对象分配，客户端的 200 上限挡不住这次开销。
- 证据：
  - `basis: Object.freeze(truncated ? [] : parents.map((id) => walk(id, depth + 1))),`
  - `const root = await this.options.consolidation.store.readBasisChain({...});`
  - `if (nodes.length >= BASIS_NODES_SHOWN) { complete = false; break; }`
- 建议：把节点预算下推到持久层（迭代式遍历，达到上限即停并返回 `complete:false`），或至少加总节点数上限；同时保留 `seen` 防环。

### 3. 中：反向用例只覆盖 `revise`，没有覆盖 `applyProposal`/reflect 的事务回滚

- 文件：`test/integration/decision-ledger.test.ts:829-869`、`docs/adr/0191-record-the-whole-basis-chain-of-a-memory-tidy-up.md:57`
- 问题：新 `[P1-2]` 用例的失败断言只走 `memory.revise`（`archive(["memory-b","memory-missing"])`）；reflect 只测了成功路径，没有测“依据行写不进去时，新建的 insight、变更行、依据行、决策记录都不落盘”。ADR 第 57 行声称依据行写不存在记忆时“记忆保持原版本、没有变更行、没有决策记录”，但实际覆盖的是 revise，不是 applyProposal。
- 证据：
  - 失败路径：`await expect(archive(["memory-b", "memory-missing"])).rejects.toThrow();`
  - reflect 路径紧接其后只有成功调用：`await memory.applyProposal(proposal("memory-insight", "payload-4"), ... (saved) => ({ ... }))`
- 建议：增加 `applyProposal` create + 不存在依据 id 的失败用例，断言 memory 记录不存在、`readChange`/`readBasis` 为空、决策记录为空（worker/direct 各跑一遍）。这正好覆盖本 PR 的核心目标之一。

### 4. 低：`complete` 不反映深度截断的 `truncated`

- 文件：`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:306-314`、`apps/agent-service/src/production-memory-control.ts:295-310`
- 问题：持久层在深度 8 会设置节点级 `truncated:true` 并停止展开，但网关只在节点数达到 200 时把顶层 `complete` 设为 `false`。因此可能出现“某个节点 `truncated:true`，但 `payload.complete:true`”，只看 `complete` 的客户端会以为链完整。
- 证据：`const truncated = depth >= MEMORY_BASIS_CHAIN_MAX_DEPTH && parents.length > 0;` 与 `complete` 只在 `nodes.length >= BASIS_NODES_SHOWN` 时变假。
- 建议：`complete` 改为同时考虑任一节点 `truncated`，或在契约/文档中明确 `complete` 只表示节点数未超限。

### 5. 低：ADR/作者说法与迁移 SQL 在 reflect 回填上不一致

- 文件：`docs/adr/0191-record-the-whole-basis-chain-of-a-memory-tidy-up.md:39`、`packages/persistence-sqlite/src/migrations/0084_memory_consolidation_basis.sql:41-47`
- 问题：ADR 和作者说法是“找不到决策记录的老行退回用变更表的 `memory_id` 和 `related_memory_id`”。实际对 `action='reflect'` 只有最后一支回退，只插入 `related_memory_id`（第一条基础记忆），不会插入 `memory_id`；非 reflect 才用两列。对老 reflect 行，这条链可能只有一条来源，而不是 ADR 描述的“两列/全部”。
- 证据：
  - ADR：`找不到决策记录的老行退回用变更表的 memory_id 和 related_memory_id`
  - SQL：`WHERE c.action = 'reflect' AND c.related_memory_id IS NOT NULL AND NOT EXISTS (...)`
- 建议：改文档为“非 reflect 退回两列；reflect 退回 related_memory_id（第一条基础记忆）”，并说明老 reflect 数据无法恢复全部依据。

### 6. 低：跨端口写入的校验不完整（依据记忆归属、ledger 列表长度/一致性）

- 文件：`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:40-45,83-102`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:653-658`
- 问题：`insertConsolidationWrite` 只校验 action、`undoneAt`、依据数量 1-200 和 run 状态；不校验每个 `basisMemoryId` 是否属于 `change.ownerId/agentId`，也不校验 `ledgerMemories.memoryIds` 的长度/去重/与 `basisMemoryIds` 是否一致。`saveWithProjection` 也只校验 `change.memoryId`、`change.afterRevision`。正常引擎调用是安全的，但这是端口边界，后续调用方很容易传错。
- 证据：`const basis = [...new Set(basisMemoryIds)]; if (basis.length === 0 || basis.length > 200) fail(...)`，随后直接插入；ledger 侧直接 `[...new Set(ledgerMemories.memoryIds)]` 写入。
- 建议：在写事务前校验每个依据 id 在 `memory_records` 中属于同一 owner/agent；校验 ledger 列表长度 ≤200，或直接由 `basisMemoryIds` 派生 ledger，避免两份列表漂移。

## 推测/需确认

- **合并/作废的“结果记忆”查不到那次整理的依据**：`#revise` 把变更挂在被改/被作废的那条上（`consolidation.ts:474`），依据表里另一条是 `relatedMemoryId`。因此对合并后保留的那条、作废后新的那条调用 `readBasisChain`，不会沿这次整理找到依据。若“给一条整理产生的记忆返回完整依据链”包含合并/作废的结果记忆，则目标未达成；若只指 reflect 新推断记忆，则现状符合。需要确认需求口径。依据：`readBasisChain` 只按 `WHERE ... memory_id = ?` 查变更（`sqlite-memory-consolidation-operations.ts:282`）。
- **`ledgerId` 是计算值，不保证账本行仍存在**：`readBasisChain` 返回 `consolidationLedgerId(change.id)`（`...:300,310`），而 ADR 明确说决策记录可能被清除/评价。若客户端把 `decisionRecordId` 当作可查询的账本行，可能与实际不符。建议读取时确认账本行是否存在，或在契约中说明它是派生 id。
- **`changeId` 长度与网关 `machineString` 的边界**：`consolidationId` 是 `memory-consolidation:${agentId}:${day}`（`consolidation.ts:194-196`），`changeId` 再拼 `:cN`（`...:598-600`）；而 `agentId` 域允许最多 128 字符（`packages/domain/src/identifiers.ts:39`），`machineString` 也限 128（`packages/gateway-contracts/src/validation.ts:49-54`）。极端长 agent id 下，`memory.basis.snapshot` 的 `changeId`、以及已有的 `memory.overview.snapshot.tidyUps`/`memory.tidy.undo` 会超过 128 而无法通过契约。正常短 id 没问题；这是既有风险，但本次新增快照又增加了一个消费点，测试只用了短 id（`gateway-v2.fixture.ts:376-390`）。建议生成时校验长度或把内部 id 与对外 id 分离。
- **reflect 的内容 payload 不在事务内**：`storeText` 在 `applyProposal` 之前写 payload（`service-main.ts:1473-1487`），事务回滚只覆盖 memory/change/basis/ledger，可能留下孤立 payload。这是既有结构，不是本次引入，但“要么都写要么都不写”若包含内容 payload，则不成立。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（读代码证实的范围内）。** 本次 diff 没有改 `packages/prompt-catalog`、工具定义、历史消息组装或遮盖逻辑。整理相关改动发生在模型输出之后：`input.generate(...)` 返回并解析后才调用 `#revise`/`#reflect`（`consolidation.ts:338-365`），新增的只是数据库写入和读取接口。未新增模型调用。新增的 `memory.basis.read/snapshot` 也不参与提示词组装。因此发给模型的内容仍然只在末尾追加，每轮会变的值仍应在最后一条消息里。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会影响模型请求。** `changeId`（含每轮序号）、`createdAt`、依据数组只写入数据库或通过新查询返回；没有进入系统提示、工具定义、历史或遮盖。依据顺序来自 `basis` 数组和 `ORDER BY position`，是确定的；`readBasisChain` 用 `created_at DESC, id DESC` 排序也是确定的（同一毫秒同一记忆多次变更时，`c9`/`c10` 的字典序会让顺序看起来反直觉，但该场景当前不会发生）。
需要注意：如果将来有人把 `memory.basis.snapshot` 注入提示词，`changedAt`/最新变更等会随时变化，那会违反确定性规则；本次没有这样做。

### 3. 有没有对应自动检查，反向用例真的会失败？

有测试，但覆盖不完整。未运行测试（本次只能用读取/搜索/git，未执行 vitest），以下是静态判断：

- 存在：`test/integration/decision-ledger.test.ts` 的 `[P1-2]`、`test/integration/memory-consolidation.test.ts`、`memory-consolidation-basis-migration.contract.test.ts`、`production-memory-basis.unit.test.ts`。
- 事务反向用例：`archive(["memory-b","memory-missing"])` 会让依据行的外键失败；如果实现没有事务或吞掉错误，`memory-b` 会变成 `revision:2/archived`，测试的 `rejects.toThrow()` 和 `status: active, revision: 1` 断言都会失败。按代码推断这个反向用例是有效的。
- 缺口：reflect/`applyProposal` 没有失败反向用例；迁移的第四支路（老 reflect 无决策记录）没有测试；深度截断/环检测没有测试；`complete` 与 `truncated` 的组合没有测试。

### 4. 每个产生/修改的值，两端都能接受吗？

逐项核对结果：

- **`changeId`**：产生于 `consolidation.ts:598-600`；消费者包括 `memory_consolidation_changes.id`、`consolidationLedgerId`、`memory.basis.snapshot.changeId`（`machineString`）、`memory.tidy.undo`、`memory.overview.snapshot.tidyUps`。正常情况下一致；极端长 `agentId` 下可能超过 `machineString` 的 128 上限（见“推测/需确认”）。
- **`action`**：引擎四值、迁移 CHECK、网关枚举三处一致（`merge/supersede/archive/reflect`）。
- **`changedAt`**：来自 `createdAt`，网关用 `timestamp` 校验；引擎 `now()` 与现有 overview 的 `generatedAt` 使用同一时钟格式，一致。
- **`basisMemoryIds`**：来自 `MemoryId`，网关用 `machineString`；二者都是 1-128 字符机器串，正常数据一致。
- **`decisionRecordId`**：写端和读端都用 `consolidationLedgerId(change.id)`（47 字符），一致；但账本行可能被清除，见上。
- **迁移清单/版本**：`bundledMigrationFiles` 加了 0084，`LATEST_MIGRATION_SEQUENCE` 自动派生，`SUPPORTED_SCHEMA_MAX` 改为 84，`schemaCatalog` 加了新表，相关测试计数改为 84，一致。
- **网关操作清单**：`GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、`gateway-v2.fixture.ts`、`PRODUCTION_MEMORY_OPERATIONS` 都加了 `memory.basis.read`；快照测试能通过契约。控制端当前没有调用该查询的界面，因此不存在控制端消费未同步的问题。
- **端口移除**：`recordChange` 已无调用方；`durable-adapters.ts` 已改为 `readBasis`/`readBasisChain`；未发现遗漏实现。

**未核实**：没有实际运行测试；没有核对所有历史生产数据的 `createdAt` 格式；没有验证真实生产 `agentId` 的最大长度。
