工具调用已停止（达到步数上限），以下结论仅依据本轮已读到的代码；`.claude/rules/prompt-prefix.md` 在稀疏检出中不存在，未核实其原文。

# 一、读代码证实的问题（按严重度从高到低）

## 1. 中：撤销/外部删除后，已有记忆摘要缓存仍把提议挂到已进回收站的记忆上
- 文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:478-506`、`255-260`、`322-331`、`413-428`
- 问题：摘要缓存只用 `#created` 计数判断是否重算，撤销批次（`undoBatch`）或别的路径把记忆移进回收站时不改 `#created`，缓存里的“正文 → memoryId”仍然有效。`respond` 不是一个整段排队，而是逐条调用排队的 `keep`；撤销可以在同一批两条 `keep` 之间插入，后一条 `keep` 就会命中已被回收站里的记忆并把它标成 committed。
- 证据：
  - `#digests` 只比较新建计数：`if (cache?.digests && cache.created === this.#created) return cache.digests;`
  - `keep` 直接使用缓存结果：`const same = digests.get(proposalTextDigest(text)); ... await this.#commit(proposal, same, input);`
  - `#commit` 没有再确认目标记忆仍是 active：`await this.#appendOnce(...); await this.#decideCommitted(proposal, memoryId, input);`
  - `undoBatch` 内只有 `trash` 和 `reopenBatch`，没有让摘要缓存失效。
- 建议：把整个 `respond` 放进串行队列（内部用不再排队的 keep/decline）；或在 `undoBatch`/回收站动作时递增一个“记忆状态代号”，`#digests` 同时比较该代号；或 `#commit` 前重读目标记忆，非 active 就重算摘要。

## 2. 中低：`respond` 的部分失败被吞掉，网页只看到“成功”
- 文件:行：`apps/agent-service/src/production-memory-control.ts:1061-1067`、`apps/agent-service/src/production-mcp-memory-writer.ts:443-475`
- 问题：`respond` 返回 `{decided, failed}`，但控制层完全丢弃 `failed`；而且“提议已被替换/已在别的批次决定”等状态只是 `failed += 1` 而不抛错，全部这类条目也会让命令返回成功。网页下一次刷新才能发现这些条目还在待确认。
- 证据：
  - 控制层：`await writer.respond(command.payload.items, batchId); return { resultRef: batchId, replayed: false };`
  - writer：`if (proposal.status !== "pending") { failed += 1; continue; }`，最后只有 `if (decided === 0 && firstError !== undefined) throw firstError;`。
- 建议：至少把 failed 数或失败提议编号放进返回；或在有失败时返回可识别的部分失败结果，便于下一个 PR 的页面显示。

## 3. 中低：同一个 `key` 的新正文若已作为别的待确认行存在，旧 `key` 行不会被替换
- 文件:行：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:113-143` 与 `144-186`
- 问题：`submit` 先按正文摘要找已有行（排除 superseded），命中就直接返回，完全不处理 `source_key` 替换，也不更新这一行的 `source_key`。因此“旧 pending A（key=K）→ 新正文 B（key=K），而 B 早已是另一条无 key 的 pending”时，A 不会被标 superseded，B 的 `source_key` 仍是 NULL，后续同一 key 的新正文也无法替换 B。
- 证据：
  - 先查正文摘要：`WHERE ... AND text_sha256 = ? AND status <> 'superseded'`，命中即 `return { proposal: known, created: false, superseded: [] };`
  - 只有未命中时才计算：`const replaced = input.sourceKey === null ? [] : (... WHERE source_key = ? AND status = 'pending' ...)`。
- 这与 ADR 0228 第 67 行“同一个编号带来不同的正文时，旧的待确认那条标为 superseded”不一致，也与作者“同一个 source_key 的新正文替换旧 pending”的说法不一致。建议命中正文已有行时同时执行同 key 的 supersede，并决定是否更新该行的 `source_key`。

## 4. 低到中：待确认列表解密与“调高分级时删除旧 payload”存在竞态，可能让记忆页整页读取失败
- 文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:387-399`、`229-238`；`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:122-142`
- 问题：`listPending` 先选出若干 pending 行，再逐条 `readText(contentRef)`。若同时有一次同正文、更高分级的 `submit`，它会把这行的 `content_ref` 改指敏感那份并删除旧的、已无人引用的 payload；列表随后读旧 ref 就会 `MCP_PROPOSAL_TEXT_MISSING`，`memory.overview.snapshot` 整页失败。
- 证据：
  - `readText`：`if (!payload) throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MCP_PROPOSAL_TEXT_MISSING");`
  - 调高分支：`UPDATE external_memory_proposals SET classification = 'sensitive', content_ref = ? ...`，随后 `if (... && !this.contentInUse(unused)) this.dropPayload(unused, input);`
- 建议：列表读取也放进串行队列，或列表读不到正文时降级为空串/标记损坏而不是让整个 overview 失败；或调高时延迟删除旧 payload。

## 5. 低：`propose_memories` 的 `replaced` 不只代表“同一次调用里被后面同 key 条目替换”
- 文件:行：`apps/agent-service/src/production-mcp-read.ts:844-850`
- 问题：提交循环结束后，对每条 pending 结果重新 `read`，只要是 `superseded` 就改成 `replaced`。并发另一次调用的同 key 替换也会被算进本次的 `replaced`，与工具说明“被同一次调用里后面同一个 key 的条目替换了”不完全一致。
- 证据：`if (result["status"] === "pending" && ... (await proposals.read(...))?.status === "superseded") result["status"] = "replaced";`
- 建议：在 submit 返回结果里带上“本次被替换”的明确信息，或接受这个措辞并修改工具说明。

## 6. 低：批量工具说明写“invalid 包括分类不对”，实际分类不对会整次调用被 schema 拒绝
- 文件:行：`packages/prompt-catalog/src/tools.ts:312`、`apps/agent-service/src/production-mcp-read.ts:486-538`
- 问题：`item.category` 是 `enum: [...EXTERNAL_PROPOSAL_CATEGORIES]`，JSON schema 校验失败是整次工具调用失败，不会产生某条 `invalid`。
- 证据：工具说明含“invalid 是正文为空、超过 2000 字或分类不对”；注册的 inputSchema 用 `enum`。
- 建议：把工具说明改成“分类不对会整次调用被拒”，与 ADR 0228 第 74 行的描述一致。

## 7. 低（当前入口不可达）：64 字提议编号与决策记录 128 字上限的组合溢出
- 文件:行：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:48`、`apps/agent-service/src/production-mcp-memory-writer.ts:114-122`、`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:2`
- 问题：`PROPOSAL_ID_MAXIMUM = 64`；`ledgerId` 为 `ledger:mcp-proposal:<id>:<batchId>:<decision>`。按 64 字 id、38 字 batch、`declined` 计算约 132 字，超过 `decision_ledger.id` 的 1–128 限制。当前 MCP 只生成 36 字 UUID，所以生产不可达；但直接调用 `writer.submit` 的测试/未来入口可能触发“提议已 rejected 但决策记录写失败”的不一致。
- 证据：`const PROPOSAL_ID_MAXIMUM = 64;`；`ledger:mcp-proposal:${proposalId}:${batchId}:${decision}`；`id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128)`。
- 建议：把提议编号上限压到 40 左右，或对 ledger id 做固定长度摘要，并在存储层同时校验生成后的 ledger id。

## 8. 低：说明文档与代码/其它 ADR 不一致
- 文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:183-186`、`docs/adr/0228-...md:61,66`、`docs/adr/0226-...md`（本轮 diff 的同一长句）
- 问题：
  - ADR 0228 第 61 行说 `subject_ref` 是“Access 凭证主体的摘要”，代码在 1–128 字时直接存原始 `subjectRef`，只在超长时哈希。
  - ADR 0228 第 66 行说待确认 payload 是“作用域和摘要的哈希”，代码实际还包含 `dataClassification`（第 65 行有提到分级，但第 66 行没更新）。
  - ADR 0226 同一段仍写“ADR 0228，还没做”，而 0225 已改为“已做”。
- 证据：writer 的 `subjectRef: ... ? input.subjectRef : sha256:...`；contentRef 哈希输入含 `${scope.ownerId}\u0000${scope.agentId}\u0000${dataClassification}\u0000${textSha256}`。
- 建议：统一文档措辞，或按文档改为始终存摘要。

## 9. 低：关闭/清理之外，提交建议表无保留策略
- 文件:行：`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:1-50`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:320-348`
- 问题：拒绝/被替换只清正文，行永久保留；committed 行永久保留。个人产品可接受，但没有上限/归档策略，表会随长期使用单调增长。
- 建议：在 ADR 或后续 PR 明确 committed/rejected 行的保留期限（最少保留摘要用于去重）。

# 二、推测与未核实

- 上述第 1、4 条是并发窗口分析，未用测试复现；无法运行测试（工具被限制）。
- 第 7 条目前只能通过直接调用 `writer.submit` 触发；MCP 入口用 `randomUUID()`，生产不可达。
- `.claude/rules/prompt-prefix.md` 不在检出中；`check:prompt-prefix`、`vitest` 是否实际通过未核实。
- 作者提到的 round-1/round-2 复核判断文件在本次副本里不存在，未核实其内容。

# 三、侧重检查

- **错误路径**：`respond` 全失败抛第一条错误、部分失败静默成功（第 2 条）；`keep` 遇到回收站同号记忆抛 `MCP_PROPOSAL_MEMORY_REMOVED`（未见测试）；overview 解密失败会让整页失败（第 4 条）。
- **不合规范/不可信输入**：文本长度按 UTF-16 码元在 `#readProposalArgs`/`keep` 与契约 `boundedString(2000)` 两端一致；`key` 用码点计数与 SQLite `length()` 一致；`client` 被限制到 64；`subjectRef` 超长转摘要；`batchId`/`proposalId` 过 `machineString`；SQL 全为参数化。未发现注入类问题。
- **安全**：待确认正文只进 `payloads`（`memory-content:mcp-proposal:`），未被记忆表/索引引用；测试 `mcp-write.test.ts:1531-1555` 断言 `memory_records`、`memory_search_index`、`find_memories`、`today_context` 均无正文；`scanMachineSecrets` 覆盖正文与 key（writer 与 mcp-read 两条路径）；编辑正文在 `keep` 再次扫描。`subject_ref` 原文存储与 ADR 措辞不一致（第 8 条）。
- **资源耗尽**：`propose_memories` 每条都触发一次过期正文清理；`respond` 每批首次 `#activeDigests` 解密全部 active 记忆；overview 每次解密最多 100 条；批量上限 50 / 500 有界。未见无界循环。
- **不可撤销操作**：撤销用 `trash`（可恢复），未见新增不可逆删除；`dropDiscardedText` 只删已无人引用的 rejected/superseded payload，删除前有 `contentInUse` 检查。
- **规则文件/文档/代码一致性**：ADR 0228 与代码整体一致，但第 8 条列出三处措辞/事实不一致；工具说明第 6 条不一致。

# 四、必答问题逐条回答

## 1. 是否改变模型已见过的请求开头？是否仍然只在末尾追加、每轮会变的值都在最后一条消息里？
**对 Himawari 自己发给模型的内容：没有改变。** 本改动未触及请求开头/系统提示/工具定义/历史消息/遮盖拼装；新表只被 MCP 写工具、网页 overview、导出计数和 `dropExpiredDiscardedText` 读写，没有任何模型读路径引用它（测试也直接断言 `memory_records` 与 `memory_search_index` 为空）。`daily-review.ts` 只是新增跳过 `mcp_proposal_pending`/`mcp_proposal_superseded`，不会改写已发内容。每轮会变的值（待确认正文、receivedAt、batchId）只出现在 MCP 回执/网页快照/表里，没有进入模型最后一条消息。
需要说明：`packages/prompt-catalog/src/tools.ts` 改的是**外部客户端**的 MCP 工具说明（`mcp.propose-memories` 增加 `replaced`，并新增两个工具），会让 Muse/Claude Code 自己的工具清单变一次；这不是 Himawari 模型的请求开头，作者说法“Himawari 自己发给模型的请求一个字节都不变”与代码一致。
依据规则原文未能读到（文件不存在），此处按 `docs/kv-cache-guide.md` 与事故案例 82 的“只追加”口径判断。

## 2. 同一段文字会不会在不同请求里变成不同字节？
**对模型请求没有影响。** 待确认回执使用首次写入的 `proposal.id` 与 `receivedAt`，重发返回同一行原值（`proposal.receivedAt` 不重算），字节稳定；正文摘要用 `NFC + 去不可见格式 + 合空格 + trim`，确定性。网页 revision 里的时间戳不是模型请求。
一个不影响模型字节、但影响状态一致性的非确定性：`#activeDigests` 遍历 `listActive`，若存在两段完全相同正文的活跃记忆，命中的 memoryId 可能随返回顺序变化；这属于第 1 条同类风险，不是模型字节问题。

## 3. 有没有对应的自动检查，反向用例是否真的会失败？
已确认存在：
- `test/integration/mcp-write.test.ts`：待确认、取消/unseen、批量、同 key 替换、网页保存/编辑/拒绝/撤销、同正文挂已有记忆、30 天清正文、分级调高、并发决定、客户名等（`1347-1718`）。
- 契约反向用例：`packages/gateway-contracts/test/gateway-v2.contract.test.ts:195-228` 覆盖 reject 带 editedText、同一批重复 proposalId、0 条、501 条必须被拒；`gateway-v2.fixture.ts:763-770` 覆盖正向。
- 迁移序列/目录：`packages/persistence-sqlite/test/migration-engine.contract.test.ts` 更新到 93，并比对 schema catalog。
- 操作清单：`scripts/check-operations.mjs` + `ci/operations-pending.json` 覆盖“后端已实现但前端还没调用”。
- 出口遮盖登记：`scripts/check-egress-redaction.mjs` 登记 writer 的 `scanMachineSecrets`。

未覆盖/未核实的反向路径：
- 缓存过期后撤销与再次确认的交错（第 1 条）；
- `MCP_PROPOSAL_MEMORY_REMOVED`；
- `respond` 部分失败；
- 迁移 CHECK 的非法状态组合（如 committed 且 content_ref 为空）；
- `source_key` 命中已有正文时不替换（第 3 条）；
- 工具说明“分类不对产生 invalid”（第 6 条）。

因工具被限制，无法实际运行测试，**“反向用例真的会失败”未核实**；只能确认用例存在。

## 4. 每个新产生/修改的值，两端是否都能接受？
逐个核对结果：
- `external_memory_proposals.id`：MCP 产生 36 字 UUID，表允许 1–128，代码限制 64；读取端（undo/respond）用 `machineString` 1–128；一致。潜在决策记录 id 溢出见第 7 条（当前不可达）。
- `subject_ref`：产生端 1–128 原样、否则 `sha256:`；表 1–128；一致（但与 ADR“摘要”措辞不一致，第 8 条）。
- `client`：`clientNameOf` 正则最多 64 字，表 1–64、overview `boundedString(64)`；一致。
- `source_key`：schema/代码最多 200，SQLite `length()` 也按字符计；一致。语义替换缺口见第 3 条。
- `text_sha256`/`content_ref`：64 位十六进制、payload 先写后插；表 CHECK 与使用端一致；分级调高时行改指敏感 payload，旧的无引用才删，未发现“删仍被引用正文”（`contentInUse` + 通用 `#payloadReferenced` 都已覆盖新表）。
- `category`：表 CHECK 的 9 个值与 `EXTERNAL_PROPOSAL_CATEGORIES`、`MEMORY_EXTERNAL_CATEGORY_NAMES`（10 减 rule）一致。
- `classification`：代码只写 private/sensitive；表 CHECK 一致。
- `status`：代码只写 pending/committed/rejected/superseded；表 CHECK 与 `CHECK` 组合（`pending` ⇔ `decided_at IS NULL`、`memory_id` 仅 committed、`content_ref` 可空仅 rejected/superseded、`superseded_by` 仅 superseded、`batch_id` 仅 committed/rejected）与写入路径一致；`reopenBatch` 同一次 UPDATE 清 `decided_at`/`batch_id`/`memory_id`，不会违反。
- `batch_id`：产生 `batch-` + 32 hex（38 字），表 1–128、`machineString` 接受；`resultRef` 与 `memory.external.undo` 都接受。
- `memory_id`：`memory:mcp:<proposalId>[:batchId]`，`memory_records.id` 无长度限制；撤销的后缀判断同时要求 `memory:mcp:` 前缀与 `:<batchId>` 后缀，未见误伤其它记忆。
- `ledger id`：正常 UUID 下不超过 128；64 字提议编号 + 批次会超过（第 7 条）。
- `overview.externalProposals`：`total/items/batches` 均由真实控制层产生；text 已规范化且 ≤2000，符合 `boundedString(2000)`；`client`、`category`、`classification`、`timestamp`、`machineString` 均匹配。
- 导出计数：`status <> 'committed'`，与 `export.ts` 的“待确认、已拒绝、被替换”描述一致。
- `ci/operations-pending.json` 两项与 `check-operations.mjs` 的“缺调用方”判定兼容；`memory.external.respond/undo` 已进 `PRODUCTION_MEMORY_OPERATIONS` 与契约。
- 工具说明/ADR：`replaced` 语义、`invalid` 含分类两条不一致（第 5、6 条）。

**结论：没有发现“高”严重度的数据丢失或模型泄漏问题；最值得在第 3 轮之后继续修的是第 1 条（撤销/回收站导致的摘要缓存陈旧，会把新提议标成 committed 却指向回收站里的记忆）和第 2 条（部分失败静默成功）。** 若只能改一处，优先让 `undoBatch`/回收站动作使摘要缓存失效或在 `#commit` 前重读目标记忆状态。
