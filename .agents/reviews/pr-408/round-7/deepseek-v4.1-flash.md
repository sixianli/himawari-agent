# PR 408（78d440c）复核结论

说明：本轮只读了代码与用例，没有运行测试；凡是标「未核实」的，是我没有读到的部分。下面按严重度从高到低排列。

## 中

### 1. 待确认 1000 条上限只统计 `pending`，同一个 key 反复换正文可绕开上限，长期堆积 `superseded` 正文
- 文件:行：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:153-165`、`:199-221`、`:471-499`
- 问题：上限查询只数 `status = 'pending'`；但同一 `(client, source_key)` 每次换新正文都会把旧行改成 `superseded`，pending 数量不涨。旧行要等 `decided_at` 超过 30 天、并且下一次 `submit`/`listPending` 触发清理时才删正文。因此一个客户端可以持续「换 key 正文」，pending 永远不超 1000，却制造任意多条 superseded 行和 payload。
- 证据（我读到的）：
  - `sqlite-external-memory-proposal-operations.ts:157-161`：`SELECT COUNT(*) ... WHERE owner_id = ? AND agent_id = ? AND status = 'pending'`。
  - 同文件 `:201-203`：`UPDATE external_memory_proposals SET status = 'superseded', decided_at = ?, superseded_by = ?`。
  - 同文件 `:478-479`：清理只取 `status IN ('rejected', 'superseded') ... AND decided_at < ?`。
- 建议：上限改成一个「未过期且未提交」的总量（pending + 未满 30 天的 rejected/superseded），或对 key 替换单独限流；替换时同步进入清理队列，避免 30 天内无限增长。这个漏洞是新增上限与旧 key 替换逻辑叠加出来的。

## 中低

### 2. `undoBatch` 先逐条 `trash`，再单独开事务重开提议；中途失败会留下「记忆已进回收站、提议仍是 committed」
- 文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:474-491`、`apps/agent-service/src/production-memory-control.ts:1073-1077`
- 问题：撤销不是原子的。循环里每调用一次 `trash` 都可能抛错（例如 `#generationFor` 失败、回收站写失败），此时前面几条记忆已经进回收站，而后面的 `reopenBatch` 还没执行，这些提议仍指向回收站里的记忆，状态仍是已保存。
- 证据：
  - `production-mcp-memory-writer.ts:480-483`：`await trash(member.memoryId); trashed.push(member.memoryId); reopen.push(member.id);`
  - `:486-491`：循环结束后才调用 `this.#options.proposals.reopenBatch({...})`。
  - `production-memory-control.ts:1073-1077`：`trash` 回调里 `await this.options.memory.trash(...)`。
- 建议：让「移入回收站 + 重开提议」共用一个事务，或至少记录已 trash 的 id，失败后做补偿（把已 trash 的记忆恢复并重开）再抛出。回收站本身可逆，所以危害可控，但状态会短暂不一致。

### 3. 写入器先存 payload 再调用存储层；除了 `PENDING_FULL`，其它 submit 失败会留下没人引用的 payload
- 文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:202-218`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:130-165`
- 问题：`#storeText(contentRef, ...)` 在 `proposals.submit` 之前执行。存储层只在「待确认满」这一条分支里 `dropPayload`；如果 `submit` 因磁盘余量检查、字段校验、SQLite 错误等其它原因抛出，刚写的 payload 没有回滚，成为孤儿。
- 证据：
  - `production-mcp-memory-writer.ts:202-203`：`await this.#storeText(contentRef, text, dataClassification);` 紧接 `const submitted = await this.#options.proposals.submit({`。
  - `sqlite-external-memory-proposal-operations.ts:131`：`this.assertDiskHeadroom();` 位于 submit 最前面，可能在 payload 已写入后抛错。
  - 同文件 `:163-164`：只有满额分支有 `this.dropPayload(input.contentRef, input)`。
- 建议：在写入器里包 try/catch，submit 失败且 `contentRef` 无人引用时删掉本次 payload；或把存正文挪进存储层事务。

## 低

### 4. 彻底删除记忆时把提议改成 `rejected`，但没有清 `batch_id`，批次统计和撤销语义会偏差
- 文件:行：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:899-907`
- 问题：`UPDATE ... SET status = 'rejected', memory_id = NULL, content_ref = NULL WHERE id = ?` 保留了 `batch_id`。之后 `listBatches` 会把这条算进该批次的 `rejected` 计数（主人并没有拒绝过），`undoBatch` 也会把这条当成「这批拒绝的条目」进入重开流程，直到下一次撤销才被 detach。
- 证据：
  - `sqlite-governed-deletion.ts:899-902`：`UPDATE external_memory_proposals SET status = 'rejected', memory_id = NULL, content_ref = NULL WHERE id = ?`。
  - `sqlite-external-memory-proposal-operations.ts:385-390`：`SUM(status = 'committed') ... SUM(status = 'rejected') ... GROUP BY batch_id`。
  - `production-mcp-memory-writer.ts:475`：`if (member.status === "rejected") reopen.push(member.id);`。
- 建议：删除时同时 `batch_id = NULL`（与 ADR「离开这个批次」一致），或在批次统计里排除因删除而 rejected 的条目。

### 5. 网页 `respond` 对 `editedText` 的整批预校验和 ADR 的「逐条处理、失败不回滚已成功」不完全一致
- 文件:行：`apps/agent-service/src/production-memory-control.ts:1061-1067`、`:232-235`
- 问题：`assertStorable` 只检查 `text.trim().length !== 0`。只要有一条 `editedText` 为空，整个命令在进入 `writer.respond` 前就抛 `MEMORY_TEXT_REFUSED`，已经能成功的其它条目也不会处理；而机器密钥、超 2000 字却是在 `keep()` 里逐条失败。同类错误落在不同层，行为不一致。
- 证据：
  - `production-memory-control.ts:1063-1064`：`for (const { editedText } of command.payload.items) if (editedText !== null) this.assertStorable(editedText);`
  - `:233-234`：`if (text.trim().length === 0) throw ... "MEMORY_TEXT_REFUSED"`。
  - `production-mcp-memory-writer.ts:278-281`：`keep` 里另行校验长度和 `proposalHasMachineSecret`。
- 建议：把空正文也交给 `writer.respond` 的逐条路径，或明确在 ADR/网关契约里写「空 editedText 整批拒绝」，两者选一。安全上不构成问题（密钥依然会在 `keep` 被拒）。

### 6. `ProductionMcpMemoryWriter.reopenBatch` 在 round 7 之后只剩测试在用，且语义与 `undoBatch` 不同
- 文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:453-463`、`test/integration/mcp-write.test.ts:1588`
- 问题：它把 `trashed: []` 传下去，并把全部成员放进 `reopen`；在新的 `reopenBatch` 逻辑下，会把「挂到已有记忆的 committed 成员」也强制重开（或 detach），与网页 undo 的语义不同。生产入口 `production-memory-control.ts` 已改用 `undoBatch`，这个方法实际是测试专用，容易误用。
- 证据：
  - `production-mcp-memory-writer.ts:456-461`：`return this.#options.proposals.reopenBatch({ ...this.#scope(), batchId, reopen: members.map(({ id }) => id), trashed: [], });`
  - `production-memory-control.ts:1073`：`const reopened = await writer.undoBatch(batchId, ...)`。
- 建议：删除该方法，或改名为测试辅助并注明只用于测试；不要以生产 API 的形式保留。

## 侧重检查

查过并给出结论的路径：

- **错误路径**：`submit` 的非 `PENDING_FULL` 失败会泄漏 payload（见第 3 条，已证实）；`undoBatch` 部分 `trash` 后失败会状态不一致（见第 2 条，已证实）；`respond` 全部失败时抛 `MCP_PROPOSAL_ALREADY_DECIDED`（`production-mcp-memory-writer.ts:539-541`，已证实）；`undo` 找不到批次回 `MEMORY_EXTERNAL_BATCH_NOT_FOUND`（`production-memory-control.ts:1078-1080`，已证实）。
- **不可信输入**：写入器与存储层都校验长度、分类、分级；写入器用 UTF-16 `length`，存储层用码点 `within()`，存储层对 `client` 比写入器更宽松，但写入器更严，不会放行坏值（已证实）。`subjectRef` 超长会改存 `sha256:<64>`（71 字），能通过 `0158...` 迁移的 1–128 约束（已证实）。机器密钥在写入器对正文和 key 都扫（`production-mcp-memory-writer.ts:182-191`），网页 `editedText` 在 `keep()` 也会扫（`:280-281`，已证实）。
- **安全/越权**：所有 `read/listPending/listBatch/decide/reopenBatch/dropDiscardedText` 的 SQL 都带 `owner_id`/`agent_id`；`undoBatch` 的 `trashed` 由写入器按提议编号和批次号算出，网页不能直接传记忆 id（已证实）。
- **资源耗尽**：1000 条上限可被 key 替换绕过（见第 1 条，已证实）；`assertDiskHeadroom` 在 `submit/decide/reopenBatch` 有、`dropDiscardedText` 没有（`sqlite-external-memory-proposal-operations.ts:131/341/402` 与 `:471`，已证实，但清理是减少磁盘，影响小）。
- **不可撤销操作**：undo 用的是 `trash`（回收站），不是彻底删除；彻底删除走 `sqlite-governed-deletion.ts`，payload 用 `#payloadReferenced` 兜底，不会删掉仍被其它行引用的 payload（`:1116-1133`、`:1137-1166`，已证实）。这一点作者第 6 轮的担心在代码里是有保护的。
- **规则/文档与代码一致性**：ADR 0228 的待确认上限、key 表、unkeyed 表、撤销 followers 行为与代码基本一致；不一致的是第 4 条的 `batch_id` 和 ADR 里「一批条目全在别处决定过时撤销报冲突」的表述——代码里 `undoBatch` 只有 `listBatch` 为空才返回 `undefined`（`production-mcp-memory-writer.ts:470-471`），非空批次一定会成功，见下面「推测」。

## 读代码证实的 vs 推测

**读代码证实的**：第 1–6 条；`undo` 使用回收站而非硬删；`#payloadReferenced` 会阻止删掉仍被引用的 payload；`pending/full` 的错误映射；存储层与写入器的长度/分级校验；所有查询都按 owner/agent 过滤；`prompt-catalog` 本轮只改 `mcp.*` 提示词。

**推测（未核实/需确认）**：
- ADR 0228 撤销段落「一批条目全在别处决定过时报冲突」是否也约束 `memory.external.undo`。代码里只有 `respond` 在全部失败时报冲突；`undo` 只要 `listBatch` 非空就成功。需要作者确认这是文档歧义还是漏实现。
- `listActive` 的返回顺序若不稳定，`#activeDigests` 在同文本多记忆时可能选到不同的既有记忆（只影响挂靠目标，不影响发给模型的字节）。未读 `listActive` 实现。
- 多进程/多实例同时打开同一个 SQLite 时，待确认上限「事务外检查」是否还有并发窗口。写入器单实例串行，单进程内没有窗口；多进程未核实。
- `prompt-manifest.json` 里新增/修改的 sha256 是否与实际文字匹配，我没有运行校验脚本，未核实。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
不会（就我读到的代码）。没有改动 Himawari 自己组装请求的系统提示、工具定义、历史或遮盖逻辑；`prompt-catalog` 本轮只改 `mcp.propose-*` 这些对外 MCP 客户端的工具说明和 tool-result，`usedBy` 都是 `production-mcp-read.ts`（`packages/prompt-catalog/src/tools.ts`）。待确认正文只落在独立表 `external_memory_proposals` 和加密 payload 里，`find_memories`/`today_context`/检索索引都读不到；用例 `test/integration/mcp-write.test.ts:1541-1565` 也断言了这一点。发给模型的内容仍是「末尾追加」：单条回执里的 `receivedAt`（`MCP_PROPOSE_MEMORY_PENDING`）是随 tool result 追加在末尾的，不在系统提示或工具定义里。ADR 0228 决定 8 也写明「Himawari 自己发给模型的请求一个字节都不变」。注意：外部 MCP 客户端自己的工具定义会因文字变化而变化，但那不是 Himawari 发给模型的请求。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会（就新增的持久化和序列化而言）。`proposalTextDigest` 是纯 SHA-256；`contentRef` 由 `owner+agent+分级+摘要` 决定；`externalProposalBatchId` 由幂等键的 SHA-256 前 32 位决定；`listPending` 用 `ORDER BY received_at, rowid`，`listBatches` 用 `ORDER BY MAX(decided_at) DESC, batch_id`，顺序固定。回执里的 `receivedAt`、`proposalId` 是第一次写入后就固定的值，同一提议重发字节相同（ADR 也这样要求）。未发现依赖前后文的遮盖或带当前时间的字段进入模型请求；`pendingSummary` 不参与请求组装。唯一未核实的是 `listActive` 顺序对挂靠目标的影响（见「推测」），它不影响模型请求字节。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
有，且我读到的反向用例确实设计成「删掉保护就会失败」：
- 待确认上限与 payload 清理：`mcp-write.test.ts:1937-1970`，断言单条回 `FULL`、批量那条 `full`，且 `payloads` 总数不变；去掉上限检查会返回 pending 并多出 payload，用例失败。
- unkeyed 保护：`:1927-1935`，断言两个客户端的正文都留在待确认（2 条）；去掉 unkeyed 条件会变成 1 条，失败。
- 撤销 followers：`:1883-1908`，断言三方的提议都回到待确认、两个批次都清空；去掉 followers 重开会少于 3 条，失败。
- 「撤销后旧 key 改指别处不再替换」：`:1910-1925`，断言被撤销的原文仍在待确认；若退回按 `source_key` 列找会被替换，失败。
- 彻底删除提议正文：`test/integration/sqlite-governed-deletion.test.ts:557-591`，断言 payload 删除、提议变 `rejected` 且 `content_ref/memory_id` 为空。
- 契约/形状：`packages/gateway-contracts/test/gateway-v2.contract.test.ts` 覆盖 reject 带 editedText、同批重复 proposalId、0 条、501 条；`gateway-v2.fixture.ts` 补了 snapshot 的 `externalProposals`。
- 缺口：没有反向用例覆盖「共享 payload 时彻底删除只删没人引用的那份」「`submit` 非满额失败时 payload 不残留」「`undo` 部分 trash 失败后的状态」。这三处正是我上面第 2、3 条指出的地方。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**
逐个核对过：
- `batchId` = `batch-` + 32 位十六进制（38 字）：用于 `batch_id`（migration 允许 1–128）、记忆 id `memory:mcp:<proposalId>:<batchId>`、payload ref、决策记录 id。决策记录表 id 上限 128（`0069_decision_ledger.sql:2`），最坏 `ledger:mcp-proposal:` + 40 + `:` + 38 + `:` + 10/11 = 约 111，能过；`memory_records.id` 和 `payloads.ref` 没有长度 CHECK（`0001_initial_product_schema.sql:57-58/393-394`），也能接受。
- 提议编号上限 40：写入器 `production-mcp-memory-writer.ts:186-187` 和存储层 `sqlite-external-memory-proposal-operations.ts:48/136-137` 一致；migration 虽允许 128，但两端都按 40 收。
- `subjectRef` 超长改存 `sha256:<64>`：71 字，能通过 migration 的 1–128 校验。
- 新表 `external_memory_proposal_keys`：主键 `(owner, agent, client, source_key)` 与 `claim` 的查询/upsert 完全对应；`client` 已加入主键，能实现「按客户端分开」。
- 新表 `external_memory_proposal_unkeyed`：主键 `(proposal_id, client)` 与 `hold` 的 `ON CONFLICT (proposal_id, client) DO NOTHING`、`retire` 的 `client <> ?` 对应；有 `ON DELETE CASCADE`，并已登记进 `schema-catalog.ts`。
- `reopenBatch` 新增 `trashed`：端口 `external-memory-proposals.ts:88-94`、唯一实现 `sqlite-durable-adapters.ts:1002`、写入器两处调用都更新了；`trashed: []` 的旧调用只在测试里。
- `memory.overview.snapshot` 新增 `externalProposals`：契约 `contracts-v2.ts:1403-1426`、生产生产者 `production-memory-control.ts:406-430/868-879`、两个 control-center 测试夹具都补齐了；没有发现漏掉的生产生产者。
- 批量结果状态 `full`：只在 `production-mcp-read.ts:842-845` 产生，工具说明 `MCP_TOOL_PROPOSE_MEMORIES` 已列出；`MCP_PROPOSE_MEMORY_FULL` 已加入 `prompt-catalog/src/tools.ts` 与 `prompt-manifest.json`（哈希值未核实）。
- 决策记录新增 `pending`/`superseded`：`decision-ledger.ts:66-69` 定义、`production-mcp-memory-writer.ts:230-235/619-625` 写入、`daily-review.ts:293-297/361-362` 排除，两端接受。
