# PR 408 第 2 轮复核结论

说明：本次只用 read/grep/glob 和 git diff/log/show 阅读，未运行测试（工具限制）。下面「证据」均为我亲自读到的代码；凡标注「推测」的是从代码向外推的后果，未实测。

## 读代码证实的问题（按严重度）

### 高：撤销（undo）不在写入器队列里，和保存交错时会让「记忆已保存」与「提议回到待确认」同时成立

文件：`apps/agent-service/src/production-memory-control.ts:1070-1089`、`apps/agent-service/src/production-mcp-memory-writer.ts:401-403`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:282-302`

问题：`submit/keep/decline` 都走 `#serially`，但 `reopenBatch` 和网页撤销对 `memory.trash` 的调用完全在队列外。撤销先 `listBatch` 取快照，再逐条 `trash`，最后 `reopenBatch`；`reopenBatch` 没有状态条件，只要 `batch_id` 匹配且 `content_ref` 非空就无条件改回 `pending`。若某条提议在「取快照」和 `reopenBatch` 之间被并发的 `respond/keep` 保存，`reopenBatch` 仍会把它改回 pending，但它的新记忆不在快照里、不会进回收站，结果就是记忆 active + 提议 pending，之后再次确认会按新批次再建一条。

证据：
```ts
// production-memory-control.ts:1073-1087
const members = await writer.listBatch(batchId);
...
for (const { memoryId } of members) { ... await this.options.memory.trash(...) }
await writer.reopenBatch(batchId);
```
```ts
// sqlite-external-memory-proposal-operations.ts:294-299
const reopen = this.database.prepare(
  `UPDATE external_memory_proposals SET status = 'pending', decided_at = NULL,
    batch_id = NULL, memory_id = NULL
  WHERE id = ? AND owner_id = ? AND agent_id = ?`,
);
```
建议：把 undo 也放进写入器的串行队列；`reopenBatch` 增加 `status IN ('committed','rejected')` 且「确认该行记忆已被成功移入回收站」的条件；trash 与 reopen 做成一个可重试的整体，失败时不要留下半状态。

### 高：MCP 同意/拒绝和网页同时决定时，会报错或报出与事实相反的结论

文件：`apps/agent-service/src/production-mcp-read.ts:892-913`、`apps/agent-service/src/production-mcp-memory-writer.ts:239-243, 342-351`

问题：`#proposeMemory` 先读 `decided/read`，再调用 `keep/decline`，中间没有和网页共享的锁。写入器虽然串行，但只保证「落库」串行，不保证「读取结论 + 落库」是一个整体：
- 网页 `keep` 先完成，MCP 随后 `decline`：`decline` 在 `proposal.status !== "pending"` 时返回 `false`，但 MCP 代码忽略返回值，仍然回 `MCP_PROPOSE_MEMORY_DECLINED` —— 事实是刚被保存了。
- 网页 `decline` 先完成，MCP 随后 `keep`：`keep` 在状态非 pending 时抛 `MCP_PROPOSAL_ALREADY_DECIDED`，外层 catch 统一回 `MCP_PROPOSE_MEMORY_FAILED`，而不是「主人拒绝了」。

证据：
```ts
// production-mcp-read.ts:908-913
if (outcome === "accepted") {
  await proposals.keep(proposalId, { batchId: null, started });
  return proposalReply(MCP_PROPOSE_MEMORY_SAVED.text, false);
}
await proposals.decline(proposalId, { batchId: null, started });
return proposalReply(MCP_PROPOSE_MEMORY_DECLINED.text, false);
```
```ts
// production-mcp-memory-writer.ts:241-243
if (proposal.status === "committed" && proposal.memoryId) return proposal.memoryId;
if (proposal.status !== "pending")
  throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MCP_PROPOSAL_ALREADY_DECIDED");
```
建议：让 `keep/decline` 返回决策结果（kept / declined / superseded / already-decided + memoryId），MCP 端在拿到结果后按实际状态回复，不要忽略 `decline` 的布尔返回值。

### 中：`respond` 在队列外计算「已有记忆摘要」，跨批次并发确认同一段文字仍会各建一条

文件：`apps/agent-service/src/production-mcp-memory-writer.ts:414, 434-443, 454-467`

问题：`#activeDigests()` 在 `respond` 里、进入 `keep` 的串行区之前就算好了，整批共用。两个不同批次（不同 idempotencyKey）如果并发保存到相同正文，各自都看不到对方刚创建的记忆，于是各建一条。ADR 说「所有提交和决定…一次只处理一个」，但这里只串行了落库，没串行「计算去重集合」。同批次内没问题（`keep` 成功后 `digests.set`）。

证据：
```ts
// production-mcp-memory-writer.ts:430-443
existing ??= await this.#activeDigests();
await this.keep(item.proposalId, {...}, existing);
```
建议：把 `#activeDigests` 的构建放进 `#serially` 内部（每批在队列内懒加载），或给「规范化正文摘要」建立可校验的唯一约束。

### 中：同一正文以更高分级重发时，提议行被调成 sensitive，但待确认 payload 仍是 private

文件：`apps/agent-service/src/production-mcp-memory-writer.ts:171-188, 527-537`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:112-140`

问题：`#submit` 只在 `payloads.get(contentRef)` 不存在时调用 `#storeText`；contentRef 由「owner+agent+正文摘要」决定，正文相同就命中旧 payload，于是新分级只写进表行（`UPDATE ... classification='sensitive'`），没有重新加密/更新 payload。结果：行说 sensitive，payload 仍 private。`keep()` 里用的是另一个 ref（`memory-content:mcp:<proposalId>...`），所以最终记忆是 sensitive，但待确认这条正文在库里的分级和行不一致。第 2 轮新增的测试只检查了行和最终记忆，没有检查 pending payload。

证据：
```ts
// writer.ts:171-188
const known = await this.#options.payloads.get(contentRef);
if (!known) await this.#storeText(contentRef, text, dataClassification);
...
dataClassification: known?.dataClassification === "sensitive" ? "sensitive" : dataClassification,
```
```ts
// sqlite...ts:123-139
if (known.status === "pending" && known.dataClassification === "private" &&
    input.dataClassification === "sensitive") {
  this.database.prepare(`UPDATE external_memory_proposals SET classification = 'sensitive' ...`)
  ...
}
```
建议：提高分级时同步重写 payload 的分级（重新 protect 并替换），或在 contentRef 里带上分级；至少加一条断言 payload 分级不低于行分级的测试。

### 中：去重会把新提议挂到 tentative 或「已被更新版本取代」的 active 记忆上

文件：`apps/agent-service/src/production-mcp-memory-writer.ts:249-254, 454-467`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:989-999`、`packages/application/src/services/owner-profile-service.ts:107-111`

问题：`#activeDigests` 直接遍历 `state.listActive()`，只跳过非 text/plain，不排除 `attributes.tentative === true` 或 `attributes.supersededBy !== null` 的记录。`listActive` 只按 `status='active' ORDER BY id` 取，因此同一正常化正文有多条 active 记录时，固定会命中 id 最小的那条，哪怕它是 tentative 或已被取代的旧版本。随后 `#commit` 只把提议标为 committed 并指向该记忆，没有 `confirm()` 或 `revise()`。

后果（推测）：主人确认一条外部提议，可能只是把提议挂到一个仍是 tentative 或已过时的记忆上；`owner-profile-service` 明确排除这类记录（`if (attributes.supersededBy !== null || attributes.tentative === true) return false`），所以「已保存」可能并未进入档案/当前记忆。

建议：去重时只考虑 `tentative !== true && supersededBy === null` 的 active 记忆；若命中的是 tentative，应调用确认（把它变为已确认）而不是直接标提议 committed。

### 中低：读待确认列表时的清理会删 payload，和提交插入存在竞态

文件：`apps/agent-service/src/production-mcp-memory-writer.ts:379-391`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:312-340`、`apps/agent-service/src/production-mcp-memory-writer.ts:163-173`

问题：`listPending()`（网页 overview 的读路径）会调用 `dropDiscardedText()` 删 payload；而 `#submit` 是「先保证 payload 在，再插入提议行」。当一个旧 superseded 行超过 30 天、外部 agent 又重新提交同一段文字时，`#storeText` 会因为旧 payload 还在而跳过写入；若网页清理恰好在 `proposals.submit` 插入前把旧 payload 删掉，插入就会因 `content_ref` 外键失败（`ON DELETE RESTRICT`），这次提议随机报错。`listPending` 是读路径却会写库，这点本身也和「读列表」语义不符。

证据：
```ts
// writer.ts:383
await this.dropExpiredDiscardedText();
// sqlite...ts:335-337
for (const row of rows) clear.run(row.id);
for (const contentRef of new Set(rows.map((row) => row.contentRef)))
  if (!used.get(contentRef)) drop.run(contentRef, ...);
```
建议：清理只在写入器串行队列内做（不要从 `listPending` 触发）；或在 `submit` 的同一事务内重新检查引用后再删；删除也尽量走 `PayloadStorePort.delete`。

### 中低：`respond` 的部分失败被静默吞掉，网页调用方拿不到失败明细

文件：`apps/agent-service/src/production-mcp-memory-writer.ts:405-452`、`apps/agent-service/src/production-memory-control.ts:1061-1068`

问题：`respond` 返回 `{decided, failed}`，但 `#externalRespond` 直接丢弃；只有「`decided === 0 && firstError`」才抛错。若某条提议已被别处决定，代码只是 `failed += 1`（`firstError` 仍为 undefined）；若整批都是这种条目，接口返回成功，网页无法知道哪些没处理。若部分失败，也只看到成功。

证据：
```ts
// writer.ts:425-428
if (proposal.status !== "pending") { failed += 1; continue; }
...
// writer.ts:450-451
if (decided === 0 && firstError !== undefined) throw firstError;
return { decided, failed };
```
```ts
// memory-control.ts:1065-1067
const batchId = externalProposalBatchId(command.idempotencyKey);
await writer.respond(command.payload.items, batchId);
return { resultRef: batchId, replayed: false };
```
建议：把 `failed`/逐条结果作为结果返回（或至少在 `failed > 0` 时抛出带条目的冲突错误），让网页能提示「哪几条没成功」。

### 低：`decline` 先落库后写决策记录，记录失败时提议已永久变成 rejected

文件：`apps/agent-service/src/production-mcp-memory-writer.ts:342-366`、`test/integration/mcp-write.test.ts:891-898`

问题：`decide(... rejected ...)` 先执行，之后才 `#appendOnce(declined)`。若决策记录写失败（现有 `failDecline` 用例模拟的就是这里），工具回失败，但提议已经是 rejected，之后同样正文都会回「拒绝过」。测试只断言「报错」，没有断言提议仍为 pending，因此不覆盖这个状态不一致。

证据：
```ts
const decided = await this.#options.proposals.decide({... status: "rejected" ...});
if (decided)
  await this.#appendOnce(this.#ledgerWrite(proposal, input.batchId, "declined", ...));
return decided;
```
建议：先写决策记录再改状态（或失败时补偿回 pending）；测试补一条「记录失败后提议仍为 pending」。

### 低：`propose_memories` 同一批里同 key 的新正文替换旧正文时，结果里旧条仍报 `pending`

文件：`apps/agent-service/src/production-mcp-memory-writer.ts:806-831, 142-184`

问题：逐条提交时先把第一条结果 push 成 `pending`，后面同 key 的条目再把它 superseded。最终响应里第一条仍是 `pending`，但实际已不是待确认。没有「superseded」状态可用，外部 agent 可能汇报一条不存在的待确认。

证据：
```ts
if (typeof parsed === "string") { results.push(...); continue; }
const { proposal } = await proposals.submit({...});
results.push({ index, status: proposal.status === "committed" ? "already_saved" : ... "pending", ...});
```
建议：利用 `submit` 返回的 `superseded` 回填/改写前面条目的状态，或在该工具结果里明确说明「同一 key 后出现的条目生效」。

### 低：资源与容量没有上限

文件：`apps/agent-service/src/production-mcp-memory-writer.ts:104-106`、`apps/agent-service/src/production-mcp-read.ts:102, 513-549`

问题：`propose_memories` 每次 1–50 条，admission 允许每分钟 30 次（`AUTHORIZED_PER_MINUTE = 30`），pending 永不过期，也没有每个 owner/agent 的待确认总数上限；每条 pending 还额外存一份加密 payload。`keep()` 每次都会全量解密所有 active 记忆做去重（`#activeDigests`），并且占着全局串行队列（`#serially`），记忆量大时会阻塞所有 MCP 提交。没有死锁（串行区内不回调公共串行方法），但有队头阻塞和全量解密。

建议：给 pending 总数/每分钟新增设上限并分页；把去重摘要缓存在可见位置；把 `#activeDigests` 移出关键区或按需映射。

### 低：ADR 0228 与代码/契约的小出入

- `docs/adr/0228...md:76` 只说「正文里有机器密钥…直接拒绝」，而 `:74` 和代码（`production-mcp-read.ts:777-781`）还包括 `key`。建议统一为「正文或 key」。
- `docs/adr/0228...md:74` 说 `invalid` 逐条报告「正文为空…分类不对」；但工具 schema 的 `text.minLength: 1` 和 `category.enum` 会在 SDK 层直接拒绝整个调用（`production-mcp-read.ts:482-486`），真正逐条只覆盖「规范化后为空/超长」和 secret。建议改文档或去掉 schema 的 minLength/enum 改为 handler 内逐条判断。
- `docs/adr/0228...md:85,126` 说「所有提交和决定…一次只处理一个」，但 undo 和读路径清理不在队列里（见前两条）。
- 数据导出：`packages/persistence-sqlite/src/data-export/snapshot.ts:69-72` 统计的是**全部状态**的提议行，而 `packages/persistence-sqlite/src/data-export/export.ts:537-540` 的文字是「待确认、已拒绝、被替换的提议」。committed 行的记忆会作为普通记忆导出，数量被多算了。建议统计时排除 committed，或改文案。

### 低（推测）：表里允许的 proposal id 长度和派生 id 的上限不匹配

文件：`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:2`（id 允许 1–128）、`apps/agent-service/src/production-mcp-memory-writer.ts:108-122`、`packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:18`（decision_ledger.id 上限 128）

`ledgerId` 形如 `ledger:mcp-proposal:<proposalId>:<batchId>:<decision>`，当前生产 proposalId 是 `randomUUID()`（36 字）所以最长约 106，安全；但表结构本身允许 128 字 id，若未来有别的写入者用长 id，派生出的 ledger id 会超过 128 并违反 CHECK。当前生产路径不可达，故列为「推测」的潜在问题。建议在 `submit` 处对 id 长度设更小上限，或对 id 也做摘要。

### 测试缺口（读代码确认，未运行）

已看到覆盖：gateway 契约（500 条上限、重复 id、reject 带 editedText）、migration 版本、待确认不进 `find_memories/today_context/索引`、30 天清理、分级调高、同批同文只建一条、`ALREADY_SAVED/DECLINED`、key 扫密钥、batch id 哈希。缺口：

- `test/integration/mcp-write.test.ts:891-898` 只断言 `failDecline` 报错，未断言提议仍是 pending（对应上面「低：decline 顺序」）。
- 没有 undo 与 respond 并发、两个不同批次并发同文确认、`MCP_PROPOSAL_MEMORY_REMOVED` / `MCP_PROPOSAL_CONTENT_CHANGED` 的用例。
- 没有断言分级调高后 pending payload 的分级（对应上面「中：payload 分级」）。
- 没有覆盖 `propose_memories` 同批同 key 前一条被后一条 superseded 后返回状态的用例。
- 工程案例里「33/34 条通过、反向验证会失败 1/7/1 条」的说法本轮无法运行验证，标「未核实」。

## 侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 文档一致）

- 不可信输入：MCP 入参在 `#readProposalArgs` 做了正文长度（UTF-16 码元）、分类白名单、key 长度（码点）、机器密钥扫描；`propose_memories` 还有 1–50 条限制（`production-mcp-read.ts:102, 767-782`）。网页 `memory.external.respond` 的 1–500、重复 id、reject 带 editedText 由 gateway schema 拒绝（`contracts-v2.ts:1532-1557`）。未发现 SQL 注入（全部参数化），批号和 proposalId 均受 `machineString` 约束。
- 作用域隔离：所有 SQL 都带 `owner_id/agent_id`（`sqlite-external-memory-proposal-operations.ts` 全部查询），`ProductionMemoryControl` 入口 `assertOwner`。
- 模型可读路径：pending 只进 `payloads`，不写 `memory_records` / 搜索索引；`find_memories/today_context` 不读该表。测试也覆盖了索引计数 0。本轮没有改 egress 遮盖逻辑。
- 不可撤销/危险操作：`memory.external.undo` 会 trash 记忆且不是原子操作（见高 1）；`memory.trash` 本身有 7 天回收期，撤销后需重新确认时用新批次号（已按预期）。
- 删除/外键：新表 `content_ref` 的 `ON DELETE RESTRICT` 会被现有动态 `PRAGMA foreign_key_list(payloads)` 引用检查识别（`sqlite-durable-operations.ts:3830-3855`、`sqlite-governed-deletion.ts:1119+`），不会挡现有记忆删除流程；但 `dropDiscardedText` 直接 `DELETE FROM payloads` 绕过了 `PayloadStorePort.delete`，目前生产 protector 只产生 inline payload，若将来改为 `ciphertext_file` 会留下密文文件（推测）。
- 文档/规则一致性：`ci/operations-pending.json` 已登记两个新命令，`prompt-manifest.json` 新增/更新项与代码引用一致，`SUPPORTED_SCHEMA_MAX` 已到 93；ADR 0225/0228 的「Himawari 自己发给模型的请求不变」与本次改动一致（新增提示词只在 `production-mcp-read.ts` 使用，见下）。小出入见「低：ADR 0228 与代码/契约的小出入」。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会改变 Himawari 自己发给模型的请求。依据代码：本轮所有新提示词常量（`MCP_TOOL_PROPOSE_MEMORY`、`MCP_TOOL_PROPOSE_MEMORIES`、`MCP_PROPOSE_MEMORY_PENDING/SECRET`、`MCP_PROPOSE_MEMORIES_RESULT`）只被 `apps/agent-service/src/production-mcp-read.ts` 使用；没有新增/修改系统提示、历史消息或遮盖逻辑（`maskForExternalRead` 未改）。`prompt-manifest.json` 的其余改动只是 JSON 排版，不改变提示词正文。唯一与「工具定义」有关的变化是发给**外部 MCP 客户端**的工具描述和新增工具：那是外部 agent 的模型看到的工具清单，部署后其会话开头会变一次（这是本功能的本意），但不是同一会话内每轮变化。会变的值（`proposalId`、`receivedAt`、`decidedAt`）只出现在工具回执/DB/账本里，不在系统提示或工具定义中；回执属于追加在末尾的工具结果。结论：仍然只追加，Himawari 模型请求前缀不变。

**2. 同一段文字会不会在不同请求里变成不同字节？**

正文身份是确定的：`normalizeProposalText` → `proposalTextDigest`（NFC、替换不可见字符、折叠空格、trim）→ `contentRef = memory-content:mcp-proposal:sha256(owner\0agent\0digest)`，不依赖前后文、不带时间（`production-mcp-memory-writer.ts:79-85, 164-172`）。`receivedAt`/`proposalId`/`decidedAt` 是元数据，不参与正文身份。唯一的字节差异来自加密本身：同一明文若被重新 `protect()`（例如拒绝清理后又提交）会得到不同 nonce/密文，但这是密文而不是模型看到的文字，且 `contentRef/digest` 不变；未发现依赖前后文的遮盖、无序集合或时间字段进入正文/提示词。去重命中的记忆由 `listActive ... ORDER BY id` 决定，顺序是确定的（`sqlite-memory-operations.ts:995-997`）。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**

有：gateway 契约测试新增 4 条拒绝用例，migration 契约测试升到 93，`mcp-write.test.ts` 覆盖待确认不可读、30 天清理、同文去重、分级调高、batch id 哈希、key 密钥等，`check-egress-redaction` 登记了新文件。但本轮无法运行测试，所以「反向用例真的会失败」未核实。已读代码能确认覆盖不足的地方：undo/respond 并发、不同批次并发同文、`MCP_PROPOSAL_MEMORY_REMOVED`/`MCP_PROPOSAL_CONTENT_CHANGED`、pending payload 分级、`decline` 记录失败后的状态，均无对应断言（详见「测试缺口」）。工程案例里「去改某处会使 N 条失败」的说法本轮未复现，标未核实。

**4. 新产生的每个值，使用它的地方都能接受吗？**

已逐项核对：
- `batchId = batch-<32 hex>`（38 字）：通过 `machineString`（≤128，字符集允许 `-`），DB `batch_id` ≤128，ledger id 约 106 ≤128，`memory:mcp:<uuid>:<batch>` 约 86 ≤128，`memory-content:mcp:<uuid>:<batch>` 约 94，无问题。
- `proposalId` 生产为 `randomUUID()`（36 字）：过 `machineString`、DB id ≤128。潜在问题：表结构允许 128，若换成更长 id，派生 ledger id 会超 128（当前不可达，见「低（推测）」）。
- `subjectRef`：生产是 `sha256:`+64 的登录主体摘要（71 字），≤128；超长/空时 writer 再做 `sha256:` 摘要，DB 1–128 可接受。
- `client`：`clientNameOf` 正则截到 64 且只允许安全字符，DB 1–64、overview `boundedString(64)` 均可接受。
- `category`：`MEMORY_EXTERNAL_CATEGORY_NAMES` 排除 rule，与 DB CHECK、overview enumeration 一致。
- `text`：服务端按 UTF-16 `.length` ≤2000，overview 用 `boundedString(2000)`（同样按 `.length`），一致。
- `memory.external.respond/undo`：已加入 `GATEWAY_V2_MESSAGE_TYPES`、schema、`PRODUCTION_MEMORY_OPERATIONS`、`ci/operations-pending.json`，两端都能识别。
- 数据导出：`snapshot.externalProposals` 与 `export.ts` 的 omitted 项都存在，但计数口径多算了 committed（见「低」）。
- 提示词清单：新增/删除项与 `tools.ts` 的导出/引用一致；哈希值本身未运行校验。

总体：没有发现会导致当前生产路径直接失败的「id 过不了后端校验」问题；最需要修的是 undo 的串行/原子性、MCP 与网页并发时的结论回报、以及 payload 分级与去重命中 tentative/superseded 记忆这两处。
