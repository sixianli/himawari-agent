## 结论（按严重度从高到低）

### 一、读代码证实的问题

**1. 严重度：高 — 待确认正文按「码点」限 2000，但快照契约按 UTF-16 长度限 2000，可让整个记忆页打不开**
- 文件：`apps/agent-service/src/production-mcp-read.ts:769`、`packages/gateway-contracts/src/contracts-v2.ts:1411`、`packages/gateway-contracts/src/validation.ts:95`、`apps/agent-service/src/production-memory-control.ts:407`
- 问题：入库前用 `[...text].length` 按 Unicode 码点校验；`memory.overview.snapshot` 的 `externalProposals.items[].text` 用 `boundedString(2000)`，其实现是 `input.length > maximum`，按 UTF-16 码元计数。约 1001 个 emoji/扩展汉字就能同时通过 MCP 校验、却在快照序列化或控制台解析时失败。
- 证据：
  - `production-mcp-read.ts:769`：`[...text].length > EXTERNAL_PROPOSAL_TEXT_MAXIMUM`
  - `contracts-v2.ts:1411`：`text: boundedString(2000),`
  - `validation.ts:95`：`input.length > maximum ||`
  - `production-memory-control.ts:407`：`text,`
- 后果：外部 agent 写入这样一条 pending 后，`memory.overview.snapshot` 无法通过契约校验（控制台 `gateway-client.ts:269` 会 `gatewayV2MessageSchema.parse`），主人打不开记忆页，也就无法确认/拒绝这条或任何其他待确认项。
- 建议：统一长度口径（都用码点或都用 UTF-8 字节），并在 `ProductionMemoryControl` 组装快照前对超限文本做明确的截断/拒绝策略；补一条含 astral 字符的反向用例。

**2. 严重度：高 — `idempotencyKey` 允许 128 字符，但被直接当批次号拼进决策记录 id，超过 128 位会写失败**
- 文件：`apps/agent-service/src/production-memory-control.ts:1058`、`apps/agent-service/src/production-mcp-memory-writer.ts:109-116`、`packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:18`、`packages/gateway-contracts/src/contracts-v2.ts:170`、`packages/gateway-contracts/src/validation.ts:53`
- 问题：网页确认把命令的 `idempotencyKey` 直接当 `batchId`，再拼成 `ledger:mcp-proposal:<proposalId>:<batchId>:<decision>`。固定前缀+UUID+decision 已占约 66 字符，`batchId` 超过约 62 字符时决策记录 id 超过 128，违反 `decision_ledger.id` 的 CHECK。
- 证据：
  - `production-memory-control.ts:1058`：`await writer.respond(command.payload.items, command.idempotencyKey);`
  - `production-mcp-memory-writer.ts:116`：`` `ledger:mcp-proposal:${proposalId}:${batchId}:${decision}` ``
  - `0089_consolidation_hold.sql:18`：`id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),`
  - `contracts-v2.ts:170`：`idempotencyKey: machineString`；`validation.ts:53`：`input.length > 128`
- 后果：`keep` 在 `applyProposal` 事务内写决策记录失败，整条保存回滚；`decline` 则是先 `decide` 成功、后写决策记录失败，会出现「提议已 rejected 但命令报错/部分失败」的不一致。若同批其他条目成功，失败还会被吞掉（见第 6 条）。这正是 I-73 所说「清单里的 id 能通过后端校验吗」的同类问题。
- 建议：不要直接用外部 `idempotencyKey` 做内部主键后缀；对 `batchId` 做短哈希（如 `sha256(batchId).slice(0,16)`）或把决策记录 id 放宽并同步迁移/校验。同理检查 `memory:mcp:<proposalId>:<batchId>` 的 MemoryId 128 位上限（见第 3 条）。

**3. 严重度：中 — 网页路径之外，保存时没有和已有 active 记忆按正文去重，与 ADR 0228 决定 5 不符**
- 文件：`apps/agent-service/src/production-mcp-memory-writer.ts:214-284`、`apps/agent-service/src/production-mcp-memory-writer.ts:390-393`、`docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:85`
- 问题：ADR 说「保存前对比现有记忆：已有记忆的规范化正文和这条完全相同，就不再新建」，但只在 `respond`（网页确认）里通过 `#activeDigests()` 做；MCP 客户端确认框同意的 `keep()` 完全没有查已有记忆，直接建 `memory:mcp:<proposalId>`。同样的正文如果已作为普通记忆存在，客户端内确认会新建一条重复记忆。
- 证据：
  - ADR：`docs/adr/0228-...md:85`「保存前对比现有记忆……就不再新建」
  - `respond` 有：`const same = existing.get(proposalTextDigest(text));`
  - `keep()` 从 `const proposal = await this.#pending(...)` 到创建记忆，全程没有 `#activeDigests()` 或正文比对。
- 后果：同一事实可能重复入库，违反作者「保存时正文和已有 active 记忆相同，只挂到那条记忆」的说法。
- 建议：把「按正文找现有 active 记忆」下沉到 `keep()`，或让两条保存路径共用同一个 `save-or-link` 函数；补客户端确认命中已有记忆的用例。

**4. 严重度：中 — 同一批内多条改成相同正文时，去重表只算一次，仍会建出重复记忆**
- 文件：`apps/agent-service/src/production-mcp-memory-writer.ts:370-393`
- 问题：`existing ??= await this.#activeDigests()` 只在批内第一次 keep 前计算一次，之后不再更新。若两条不同提议都通过 `editedText` 改成同一段正文，第一条新建记忆后，第二条仍看不到第一条，继续新建。
- 证据：`existing ??= await this.#activeDigests();` 在循环内只初始化一次；`keep()` 建完记忆后没有把新正文写回 `existing`。
- 建议：每次成功新建或挂接后，把 `proposalTextDigest(text) -> memoryId` 写回 `existing`；补同批两条 editedText 相同的用例。

**5. 严重度：中 — `keep()` 忽略 `proposals.decide()` 的返回值，和 `submit()` 的 sourceKey 替换并发时会「记忆已建、提议却不是 committed」**
- 文件：`apps/agent-service/src/production-mcp-memory-writer.ts:275-283`、`apps/agent-service/src/production-mcp-memory-writer.ts:148-188`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:146-152`
- 问题：`keep()` 建完记忆后调用 `decide`，但没有检查是否 `changes === 1`；而 `submit()` 的「同 source_key 替换 pending」不在 `#oneAtATime` 锁内，只按 `status='pending'` 做条件更新。并发交错时，`submit` 可先把旧 pending 标成 `superseded`，`keep` 仍把记忆中创建出来，随后 `decide` 因 status 不再是 pending 而更新 0 行；`keep` 照样返回 memoryId。
- 证据：
  - `keep()`：`await this.#options.proposals.decide({...}); return memoryId;`，未使用返回的 boolean。
  - `submit` 的替换：`UPDATE ... SET status = 'superseded' ... WHERE ... AND status = 'pending'`，且 `submit` 不在 `#oneAtATime` 中。
- 后果：记忆和提议状态不一致；旧提议显示被替换，但它的正文已经保存成记忆；之后新 pending 再被确认还会再建一条。
- 建议：`keep()` 检查 `decide` 返回值，失败时回滚/回收刚建记忆（或改为先条件占位再建记忆）；`submit` 的 sourceKey 替换也按同一把提议锁或改用事务内的 compare-and-set 结果。

**6. 严重度：中 — `respond` 的部分失败完全不返回给调用方，网页可能看到「成功」但实际有条目没处理**
- 文件：`apps/agent-service/src/production-memory-control.ts:1054-1059`、`apps/agent-service/src/production-mcp-memory-writer.ts:401-407`
- 问题：writer 返回 `{decided, failed}`，只有「全部失败」才抛第一条错误；控制层直接丢弃返回值，命令结果始终 `replayed:false`。部分失败（例如某条 editedText 含机器密钥、某条 decide 竞争失败）对网页不可见。
- 证据：
  - `production-memory-control.ts:1058`：`await writer.respond(...)`，返回值未使用。
  - `production-mcp-memory-writer.ts:406`：`if (decided === 0 && firstError !== undefined) throw firstError;`
- 建议：把 `{decided, failed, failures[]}` 放进命令结果（或 resultRef 指向的 payload），至少让网页知道哪些提议没处理；契约层补对应返回结构。

**7. 严重度：中 — 拒绝正文 30 天清理对「清理后再次被提议」的场景失效，会留下永不清理的 payload**
- 文件：`apps/agent-service/src/production-mcp-memory-writer.ts:160-162`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:108-112`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:279-296`
- 问题：`submit()` 先按正文摘要 `#storeText` 写 payload，再查提议表。拒绝正文 30 天后 `content_ref` 被清空、payload 已删；之后同一正文再来，`known` 为空，于是重新写入一个新 payload，但提议表里仍返回那条 `rejected` 旧行（`status <> 'superseded'`），新 payload 不会被任何行引用，也永远不会被 `dropRejectedText` 选中（它只选 `content_ref IS NOT NULL` 的 rejected 行）。
- 证据：
  - `production-mcp-memory-writer.ts:160-161`：先 `payloads.get`，没有就 `#storeText`，然后才 `proposals.submit`。
  - `sqlite-external-memory-proposal-operations.ts:112`：`if (existing) return { proposal: record(existing), ... }`，不会把新 contentRef 回填。
  - `sqlite-external-memory-proposal-operations.ts:282-283`：只选 `status='rejected' AND content_ref IS NOT NULL`。
- 后果：实际保存了被拒绝正文（尽管模型读不到），违反「拒绝的正文 30 天后删除」，且是无界存储泄漏。
- 建议：先查提议表再决定是否 `#storeText`；若命中已拒绝且 `content_ref` 为空，不要写 payload（或写入后立即清理）；补「拒绝 30 天后再提议同一正文」的用例检查 payload 数量。

**8. 严重度：中 — 同一正文先以普通分类提交、再以 health/finance 提交时，分级不会调高**
- 文件：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:108-112`、`apps/agent-service/src/production-mcp-memory-writer.ts:172-173`
- 问题：去重只按正文摘要，命中已有行时直接返回旧行，忽略本次算出的更高分级和分类。若某段健康/财务正文第一次被错误标成 `other`，之后即使以 `health` 再提，返回的仍是旧行的 `private`/`other`；确认时 `keep()` 又用 `proposal.category` 重新计算，得到 `private`。
- 证据：`if (existing) return { proposal: record(existing), ... }`；writer 里 `dataClassification: known?.dataClassification === "sensitive" ? "sensitive" : dataClassification` 只在写入路径生效，命中 existing 时不生效。
- 后果：本应 sensitive 的正文可能按 private 保存，削弱敏感记忆保护。方向是「只会调低」，与 ADR 0228 前提 6「分级函数只会调高」的意图相悖。
- 建议：命中 existing 时，如果新计算的分级高于旧行，应升级该行的 `classification`（并同步 payload 分级），或至少拒绝/要求按新分类重建；补反向用例。

**9. 严重度：低/中 — 撤销不是原子的，失败路径会留下「记忆已进回收站、提议仍 committed」**
- 文件：`apps/agent-service/src/production-memory-control.ts:1062-1080`
- 问题：`#externalUndo` 先逐条 `memory.trash()`，再 `writer.reopenBatch(batchId)`。中途任何一条 trash 抛错，前面的记忆已进回收站，后面的还没处理，提议表也未回到 pending。
- 证据：`for (const { memoryId } of members) { ... await this.options.memory.trash(...) }` 之后才 `await writer.reopenBatch(batchId);`
- 建议：把「查批次、trash、reopen」放进一个可回滚的协调流程，或至少记录已处理进度并让重试可补齐；对外明确报告部分完成。

**10. 严重度：低 — 每次 `revision()` 轮询都解密最多 100 条待确认正文，纯属浪费且放大故障面**
- 文件：`apps/agent-service/src/production-memory-control.ts:380`、`apps/agent-service/src/production-memory-control.ts:399-402`、`apps/agent-service/src/production-mcp-memory-writer.ts:350-358`
- 问题：`revision()` 只需要待确认数量和 id，却调用 `#externalProposals()` → `listPending(100)`，而 `listPending` 会为每条 `readText` 解密。轮询频繁时持续做无用的解密；任何一条 payload 损坏/缺失都会让 revision 整体失败。
- 建议：revision 使用不带正文的轻量查询（只 `id/receivedAt`），或让 store 直接返回不读 payload 的列表。

**11. 严重度：低 — `superseded` 提议的正文永不清理**
- 文件：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:146-152`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:279-283`
- 问题：source_key 替换只把旧 pending 改成 superseded，保留 `content_ref`；`dropRejectedText` 只清理 rejected。长期使用同一个 key 的 agent 会留下无界的加密正文。
- 建议：确认只需要 `text_sha256` 挡重复的话，可在 superseded 时清掉 `content_ref` 并删除无引用 payload；若产品上需要保留历史，明确保留期。

### 二、推测 / 未核实

- **外键 RESTRICT/SET NULL 对既有删除流程的影响（未核实）**：`content_ref REFERENCES payloads(ref) ON DELETE RESTRICT`、`memory_id ... ON DELETE SET NULL`、`superseded_by ... ON DELETE SET NULL`。我确认 `sqlite-governed-deletion.ts:1119` 会遍历所有引用 `payloads` 的表来判断能否删 payload，因此 pending 正文不会被误删；但「删除 Owner/Agent 时 proposals 级联删除与 payload 删除的先后顺序」我没有完整跑通，无法确认不会因 RESTRICT 卡住。建议作者用真实删除流程跑一遍 Owner/Agent/记忆删除的集成测试。
- **`contentRef` 长度**：`memory-content:mcp:<proposalId>:<batchId>` 没有显式上限，payloads.ref 也没有长度 CHECK；我未找到上游统一限制，推测可随 batchId 变长，但危害不如第 2 条直接。
- **历史数据兼容**：`decided()` 不再回退查决策记录和 `memory:mcp:<proposalId>`，`submit()` 也只查提议表。迁移 0093 没有回填旧提议。我推测上线前已由 ADR 0225 保存/拒绝的内容，在再次提议时不会得到 `already_saved`/`declined`，而会重新进入 pending；客户端内确认还可能重复建记忆。是否构成问题取决于上线时是否已有生产数据。

## 侧重检查

- **错误路径**：检查了 `keep`/`decline`/`respond`/`undo`。发现 `keep` 忽略 `decide` 返回值（第 5 条）、`decline` 先落状态后写决策记录（第 2 条）、`undo` 非原子（第 9 条）、`respond` 部分失败被吞（第 6 条）。
- **不合规范/不可信输入**：外部 agent 可控制 `text`、`category`、`key`、客户端名和 MCP 工具参数。`key` 有 200 上限、`client` 有 64 上限、`subjectRef` 是 64 位 sha256、`text_sha256` 是 64 位 hex，和 DB/契约基本一致。**但**正文长度口径不一致可造成记忆页 DoS（第 1 条）；`idempotencyKey` 长度未和内部 ledger id 对齐（第 2 条）。`sourceKey` 未做机器密钥扫描且明文存 DB，属于低风险设计选择。
- **安全**：机器密钥在单条和批量入口都做了扫描，编辑后的正文在 `keep` 里也重新扫描；待确认正文不写入 memory_records/search index，`find_memories`/`today_context` 测试也覆盖了。发现的分级只降不升（第 8 条）是安全相关的实质问题。
- **资源耗尽**：待确认不设上限且 pending 不过期是产品决定；但 revision 轮询重复解密 100 条（第 10 条）、拒绝后再提议产生孤儿 payload（第 7 条）、superseded 正文永不清理（第 11 条）会放大存储和 CPU。
- **不可撤销操作**：仅「拒绝正文 30 天后物理删除 payload」不可撤销，属设计；`undo` 只是进回收站。主要问题是原子性（第 9 条）。
- **规则/文档与代码一致性**：
  - ADR 0228 决定 5（已有同文只挂接）与 `keep()` 不符（第 3 条）。
  - ADR 0228 的「已保存回 already_saved」只对迁移后的提议表成立，历史记忆未覆盖（第二节推测）。
  - ADR 0228 关于批量、回执字节稳定、pending 不自动过期、拒绝 30 天清理、undo 语义，主体与代码一致。
  - ADR 0225/0226 的修订文字与新的 pending 行为一致；`mcp.propose-memory-not-ready` 已从目录移除，新提示词已登记。
  - 案例文档「34 条通过 / 反向 1、7、1 条失败」我无法运行测试，未核实。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。这个改动没有动 Himawari 自己发给模型的系统提示、工具定义、历史消息或遮盖结果；新增/修改的提示词（`MCP_TOOL_PROPOSE_MEMORY`、`mcp.propose-memories`、pending/secret 回执）只用于对外 MCP 客户端，调用点是 `apps/agent-service/src/production-mcp-read.ts`。待确认正文只进 `external_memory_proposals` 和独立 payload，既不进 `memory_records`/检索索引，也不进 `memory.overview.snapshot` 之外的模型读路径；`find_memories`、`today_context` 的测试也验证了确认前读不到。因此仍然是「只在末尾追加」的语义没有被破坏；每轮会变的 `proposalId`/`receivedAt` 只出现在 MCP 工具结果，不在模型请求前缀里。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
正文本身不会：`normalizeProposalText` 是确定性的（NFC、不可见字符换空格、压缩空格、trim），摘要也基于它；pending 回执只有固定的正文模板 + `proposalId` + `receivedAt`，同一条提议重发时这两个值不变，所以字节相同。需要注意两点：其一，同一正文命中已有提议时返回旧行，导致**分类/分级元数据**可能因第一次提交的 category 不同而不同（第 8 条），但正文字节不变；其二，`#activeDigests` 依赖当前 active 记忆集合，同一提议在不同时间确认可能挂到不同 memoryId，但这不是正文文本的字节变化。集合顺序方面，`listPending`/`listBatch`/`listBatches` 都带确定排序，未见无序集合导致文本变化。

**3. 有没有对应的自动检查，反向用例真的会失败？**
主路径有较完整集成测试（`test/integration/mcp-write.test.ts` 新增 pending、批量、网页保存/编辑/拒绝、undo、去重、30 天清理、模型不可见等），迁移契约测试也更新了 0093。但**我没有运行测试**（本次工具只能读文件和 git），作者「34 条通过、反向改坏会失败 1/7/1 条」无法核实。更重要的是以下场景没有看到反向用例：超长 astral 字符导致 overview 失败、超长 `idempotencyKey` 导致 ledger id 超限、同一批 editedText 收敛、客户端内确认命中已有 active 记忆、`respond` 部分失败的返回、拒绝正文清理后再次提议产生孤儿 payload。契约层也没有 `memory.external.respond` 的 0/501 条、重复 proposalId、reject 带 editedText 的负向测试（只在 fixture 里出现正向样例）。

**4. 每个值的使用端都能接受吗？**
逐项核对如下：
- `proposalId`：UUID，1–128，MCP/网关 `machineString`、提议表 CHECK 都可接受；但见 `batchId` 拼出的 memory id 长度问题。
- `batchId`：`machineString` 1–128、提议表 CHECK 1–128 都能接受；但拼进 `decision_ledger.id` 后上限只有 128，实际可用约 62，**使用端不接受**（第 2 条）。
- `memoryId`：`memory:mcp:<proposalId>:<batchId>` 在本 PR 中以 `as MemoryId` 强转，绕过了 `identifiers.ts:39` 的 1–128 正则；长 batchId 会生成超过 128 的 id。当前被 ledger 先失败掩盖，但属于潜在不一致。
- `contentRef`：`memory-content:mcp-proposal:<hash>` 正常；`memory-content:mcp:<proposalId>[:batchId]` 未发现统一长度上限，未核实是否有下游限制。
- `client`：`clientNameOf` 的 `/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}/` 与 DB 1–64、契约 `boundedString(64)` 一致。
- `subjectRef`：`sha256` 64 位，DB 1–128 可接受。
- `sourceKey`：MCP JSON Schema 200、代码按码点 200、SQLite `length` 200，三者一致。
- `text_sha256`：小写 hex 64，DB CHECK 64 位一致。
- `category`/`classification`/`status`：写入值都在迁移 CHECK 和快照枚举内。
- `receivedAt`/`decidedAt`：`toISOString()` 带 3 位毫秒，匹配 DB GLOB 和契约 `timestamp`。
- 快照 `items[].text`：**使用端不接受**码点 2000 的输入（第 1 条），是本次最明确的「生产端能过、消费端过不了」。
- 批量条数：MCP 1–50、网页 1–500、内部 list 上限 1000，均一致。
