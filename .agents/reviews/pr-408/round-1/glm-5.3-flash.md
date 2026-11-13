# 复核报告：PR 408（P5-3 外部记忆先存「待确认」）

## 发现（按严重度从高到低）

**1. 中｜apps/agent-service/src/production-mcp-memory-writer.ts:160-161（配合 packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:106-112、275-301）｜已被清掉正文的「已拒绝」提议，重新提同样的话会把明文正文重新写回磁盘，成为永远无人清理的孤儿 payload。**
证据：`submit` 先查 payload 再决定是否写入：`const known = await this.#options.payloads.get(contentRef); if (!known) await this.#storeText(contentRef, text, dataClassification);`，然后才去提议表查重。被 30 天清理过的拒绝行 `content_ref` 为 NULL（`dropRejectedText` 在 289-300 行把 `content_ref` 置 NULL 并删 payload），查重命中的是「已拒绝」行、直接返回 `created:false`，不会把新写的 payload 再挂回任何一行。结果：一条 `memory-content:mcp-proposal:<sha>` 的加密明文重新落盘，且不属于任何提议行，`dropRejectedText` 只遍历 `content_ref IS NOT NULL` 的拒绝行，永远清不到它。这和「拒绝的正文 30 天后删除，只留摘要继续挡」的说法相悖：摘要确实继续挡，但明文会在第 31 天之后因一次重发而复活。测试（mcp-write.test.ts 尾部「drops the text … keeps blocking」）只断言拒绝回执，没断言重发后 payload 仍不存在。读代码证实。
建议：把 `#storeText` 挪到查重确认 `created === true`（或命中行是 pending）之后再做；或 `dropRejectedText` 同时清理 `ref LIKE 'memory-content:mcp-proposal:%'` 且无任何提议行引用的 payload。

**2. 中｜apps/agent-service/src/production-memory-control.ts:380-395、399-422（配合 production-mcp-memory-writer.ts:335-347）｜每次计算修订串（revision）都会解密最多 100 条待确认正文，并在读路径里顺带做写清理。**
证据：`revision()` 调 `this.#externalProposals()`；后者 `await writer.listPending(EXTERNAL_PROPOSALS_SHOWN)`；`listPending` 每项 `readText`（取 payload + 解密），且开头 `await this.dropExpiredRejectedText()`（一次写操作）。修订串是给网页轮询用的廉价变更检测，现在每轮轮询最多 100 次解密 + 一次清理写。调用频率未核实（推测：网页轮询常规路径）。功能正确，代价是每轮轮询的延迟和 CPU。
建议：修订串只取 `total` 和 id 列表（不加正文），正文留给真正的 overview 查询；清理挪到提交路径或定时任务。

**3. 低｜apps/agent-service/src/production-memory-control.ts:1062-1081；packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:253-273｜撤销没有整体事务，且撤销后整个批次从批次列表里消失。**
证据：`#externalUndo` 先 `listBatch`，再逐条 `memory.trash`（await 循环），最后 `reopenBatch`；中途某条 trash 抛错时，前面的记忆已进回收站、后面的没动、提议仍是 committed 指向旧记忆，状态半完成。另外 `reopenBatch` 把 `batch_id` 置 NULL，`listBatches` 按 `batch_id IS NOT NULL` 分组，撤销后的批次直接从「最近 10 个确认批次」里消失，而不是标成「已撤销」——ADR 0228 决定 4 只说 items/batches 的内容，没写撤销后批次去哪。读代码证实（无事务、消失）；「中途 trash 抛错」的具体触发场景是推测。
建议：撤销放进一个事务（或先 reopen 再逐条 trash 并容忍重复）；给批次加 undone 标记。

**4. 低｜packages/application/src/services/daily-review.ts:262-266、293-296、355-366；apps/agent-service/src/production-mcp-memory-writer.ts:461-487｜新写入的 `pending_approval`（mcp_proposal_pending）和 `superseded`（mcp_proposal_superseded）账本行会进每日回顾池，与「每日回顾改动放下一个 PR」的说法不完全一致。**
证据：`ledgerActed` 对 `memory_candidate` 只要 `outcome !== "discarded"` 就算已行动 → pending 行 `acted: true`；`OWNER_DECIDED_DISCARDS` 只排除 `approval_rejected` 和 `mcp_proposal_declined`，superseded 的 discarded 行不被排除。这些行的 `subjectRef` 是 `mcp-client:<client>` 或记忆号，`readMemory` 读不到 → 文本为空、`textHidden: true`，等于回顾池里多出一批无文本行，还占 `DAILY_REVIEW_POOL_LIMIT` 名额。calibration 侧没问题（packages/calibration/src/index.ts:647、663 用 `mcp_proposal_%` 通配排除）。是「有意与 approval_requested 同型」还是遗漏，无法从代码判断——推测偏遗漏。
建议：要么把 `mcp_proposal_pending`/`mcp_proposal_superseded` 也加进排除或单独分组，要么在 ADR 0228 里写明回顾池这一变化已在本 PR 生效。

**5. 低｜apps/agent-service/src/production-mcp-memory-writer.ts:227-273｜撤销批次后若用同一个批次号再次 respond，`keep` 发现同号记忆已存在（在回收站里）就跳过建记忆、把提议标回 committed，记忆不被恢复。**
证据：`if (!(await this.#options.state.read(memoryId)))` 才走创建；存在就直接 `decide` 成 committed，`memoryId` 指向那条 trashed 记忆。是否真的会发生取决于网关是否按 `idempotencyKey` 重放旧结果（memory.external.respond 的幂等键就是批次号）——网关重放行为未核实，推测风险低但存在。
建议：`state.read` 命中时检查 `status === "active" || "archived"`，否则视为不存在重建。

**6. 低｜apps/agent-service/src/production-memory-control.ts:1054-1060｜`respond` 逐条的成败计数在控制层被丢弃。**
证据：`await writer.respond(...)` 的返回 `{decided, failed}` 没有进入命令结果，网页只能拿到 `resultRef`，部分失败只能靠下一轮快照里剩余的 pending 数量反推，看不到哪条失败、为何失败。功能可用（快照能显示没确认完的），但和作者说的「respond 部分失败时的返回」相比，调用方拿到的信息比写入器实际算出来的少。读代码证实。
建议：把 `{decided, failed}` 放进 resultRef 同级的返回，或至少在诊断日志里落一条。

**7. 低｜apps/agent-service/src/production-mcp-read.ts:761-779｜`key`（sourceKey）不做机器密钥扫描，且明文入库。**
证据：`#readProposalArgs` 只对 `text` 调 `proposalHasMachineSecret`；`sourceKey` 只做归一化和长度校验，直接写进 `source_key` 列（非加密列）。正文拒绝密钥、key 却能携带，标准不一致。读代码证实；实际被滥用是推测。
建议：对 `sourceKey` 跑同一扫描，或声明 key 只允许机器格式。

**8. 低｜packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:4（CHECK length(subject_ref) BETWEEN 1 AND 128）与 apps/agent-service/src/production-mcp-read.ts:476、858-864｜`subject_ref` 直接存 Access 凭证主体，代码端不校验长度，超 128 字符会让整次提议以通用 FAILED 收场。**
证据：`const subjectRef = context.authInfo?.clientId ?? "";` 原样传给 `submit`；store 的 `submit` 只校验 digest/时间/contentRef，不校验 id/subjectRef/client，越界时是原始 SQLite CHECK 错误而不是端口错误。`client` 列有 `clientNameOf` 的正则截断保护（64 字符），`subjectRef` 没有。是否会出现超长主体是推测（通常 Access 主体是邮箱，较短）。
建议：在 writer 或 read 层对 `subjectRef` 做与 client 同样的截断/校验。

**9. 低｜apps/agent-service/src/production-mcp-memory-writer.ts:176-187｜提议已存但「pending」账本行可能永久缺失。**
证据：`#appendOnce(ledgerWrite(..., "pending", ...))` 只在 `submitted.created` 为 true 时执行；若第一次 append 失败（调用方收到 FAILED），重发走查重 `created:false`，不会再补账本行。审计链不完整。读代码证实。
建议：`created:false` 且状态为 pending 且账本无记录时补写。

**10. 信息｜docs/engineering-casebook.md:5748（案例 89「结果数据」）｜「反向验证：……分别让 1、7、1 条用例失败（2026-11-11 本线程实跑）」的数字无法核实**（我不能运行测试）。`mcp-write.test.ts` 的用例存在且合理，但反向验证是否实跑过未核实。其余文档（ADR 0225/0226 的取代标注、ADR 0228、schema-catalog 条目、导出 omitted 文案）与代码逐条核对一致；ADR 0228 决定 8「Himawari 自己发给模型的请求一个字节都不变」与代码一致（见必答问题 1）。

## 侧重检查

走的普通流程：Muse（不能弹框）→ `propose_memories` 批量提交 → `external_memory_proposals` pending + 加密 payload → 主人打开记忆页（`memory.overview.read` 的 `externalProposals`）→ `memory.external.respond` 保存/改字/拒绝 → `applyProposal` 建记忆 `memory:mcp:<id>:<batch>` → `find_memories` 能查到 → `memory.external.undo` 移回收站、提议回 pending。结论：

- 覆盖良好：批量提交、去重、替换（source_key）、密钥拒收、待确认不可被模型读（`memory_records` 无引用、`memory_search_index` 空、find_memories/today_context 查不到）、保存/改字/拒绝/撤销/重确认、与已有记忆同文挂靠、30 天清理后仍挡重发——`test/integration/mcp-write.test.ts` 全有。
- 无测试覆盖的路径：① 两条新命令走 HTTP 网关到 `ProductionMemoryControl` 的端到端（集成测试直接构造命令对象；e2e fixture 只加了空的 `externalProposals` 字段，网页界面在下一个 PR）；② 网页确认与 MCP 确认框同意**同时**对同一提议操作（作者自己列的并发场景，靠同一 writer 实例的按编号排队 + store 层 `status='pending'` 条件更新兜底，读代码判断安全，但无用例）；③ `submit`/`listPending` 内嵌的自动清理（测试只直接调 `dropExpiredRejectedText`）；④ 撤销涉及 archived 记忆的分支；⑤ 发现 1、4、5 的场景；⑥ 新表 CHECK 约束的反向写入用例。

## 必答问题

1. **会不会改变模型已经见过的请求开头？——不会。** 读代码证实：`external_memory_proposals` 的读者只有 MCP 写入器、记忆控制、导出计数（全仓 grep），不进 `memory_records`、不进检索索引，测试断言 `find_memories`/`today_context` 查不到；提示词目录改动全部是 `mcp.*` 条目，`usedBy` 只有 `production-mcp-read.ts`，发给外部 MCP 客户端、不进 Himawari 发给模型的请求；`memory.overview.snapshot` 是网页快照。发给模型的内容：无追加项、无历史改动、遮盖路径未动；待确认正文在主人确认前不存在于任何模型可读存储。每轮会变的值（receivedAt、批次号）只进 MCP 回执和网页快照，不进模型请求。符合「只追加」规则。（附带说明：对外客户端的 MCP 工具列表变了（新增 `propose_memories`、改了 `propose_memory` 描述），影响的是外部客户端自己对其模型的请求，不在本规则管辖内，ADR 0228 决定 8 已声明。）
2. **同一段文字会不会在不同请求里变成不同字节？——不会。** 读代码证实：摘要 = NFC + 固定归一化 + SHA-256，确定；pending 回执对同一条提议字节恒定（测试断言两次重发文本相同）；所有新列表排序固定（`ORDER BY received_at, rowid`、`ORDER BY MAX(decided_at) DESC, batch_id`）；新增时间值（receivedAt/decidedAt）不进模型请求。唯一非确定点：`#activeDigests` 先到先得的挂靠选择依赖 `listActive` 返回顺序（排序稳定性未核实），但它只影响挂到哪条同文记忆，不影响任何发给模型的字节。
3. **有没有对应的自动检查、反向用例会不会失败？——部分有。** 读代码证实：迁移序列契约测试更新到 93；提示词清单有自动校验（apps/agent-service/test/prompt-catalog.unit.test.ts:185-193），反向用例存在（STALE/MISSING/UNKNOWN 会失败，378-386 行）；网关契约夹具覆盖新命令和快照字段（仅正向）；「待确认进不了模型路径」的断言本身具备反向失败能力。缺口（读代码证实）：新表 CHECK 约束无反向用例；`memory.external.respond` 契约的三条反向（reject 带 editedText、超 500 项、重复 proposalId，contracts-v2.ts 的 parse 会抛）未见专门断言；作者声称的反向验证实跑数字未核实。
4. **每个新值的两端校验都核对了吗？——核对过的都一致，两处例外。** 逐值：`text_sha256`（64 位十六进制 ↔ CHECK length=64）✓；`contentRef`（payloads 外键 RESTRICT；唯一删除方有 `used` 引用检查，其他 payload 删除点均不触及 `memory-content:mcp*` 前缀，逐个 grep 核对）✓；`memoryId` 前缀 `memory:mcp:` 的全部消费方（memory-source.ts:28、memory-source-report.mjs:23、undo 的 startsWith+endsWith）都用前缀匹配，带批次后缀不误伤 ✓；`batchId`（machineString 1-128 安全字符 ↔ CHECK 1..128）✓；`source_key`（200 码点 ↔ CHECK length≤200，SQLite length 对文本也按字符）✓；新原因码被 calibration 的 `mcp_proposal_%` 通配排除 ✓；快照新字段唯一生产者已同步、夹具已更新 ✓；导出计数与表一致 ✓。例外：`subject_ref`（发现 8，代码端不校验长度）；`id`（store 不校验，越界时是原始 SQLite 错误而非端口错误，低）。

**未核实清单**：未运行任何测试或 `npm run check`；网关对 `memory.external.respond` 幂等键的重放行为（影响发现 5 的实际可触发性）；`memory_records.id` 的长度上限（批次后缀拼进去是否越界，推测够用）；`listActive` 排序稳定性；案例书里反向验证的实跑数字；生产环境 Access 主体长度分布。
