## 结论摘要

**读代码证实的问题（按严重度）**

1. **高：新增的回归用例与本轮存储层实现相反，按代码执行必然失败，说明本轮“命中已有待确认行”的新行为没有被通过的测试覆盖。**

   - 文件：`test/integration/mcp-write.test.ts:1738-1743`
   - 问题：用例期望 `COFFEE`（带 key）和后来同正文（带同 key）的 `X` 同时留在待确认，且 `COFFEE` 的 key 变成 `null`；但存储层在命中已有 `X` 时，会把同一 key 的其他待确认行标成 `superseded`。
   - 证据：
     ```ts
     await f.propose(muse, { text: COFFEE, key: "muse:memory/drink" });
     await f.propose(muse, { text: "主人每天喝两杯咖啡" });
     await f.propose(muse, { text: "主人每天喝两杯咖啡", key: "muse:memory/drink" });
     const waiting = await f.pending();
     expect(waiting.map(({ sourceKey }) => sourceKey)).toEqual([null, "muse:memory/drink"]);
     expect(waiting).toHaveLength(2);
     ```
     ```ts
     // sqlite-external-memory-proposal-operations.ts:120-143,146-179
     const replaced = input.sourceKey === null ? [] : (... WHERE source_key = ? AND status = 'pending'
       AND text_sha256 <> ? ...).map(({ id }) => id);
     ...
     if (known.status === "pending") {
       supersede(known.id);           // 把同一 key 的 COFFEE 标成 superseded
       if (known.sourceKey === null && input.sourceKey !== null) /* 给 X 补上 key */
     }
     ...
     superseded: known.status === "pending" ? replaced : [],
     ```
     `listPending` 只返回 `status = 'pending'`（同文件 `:227-229`），所以实际只剩下 `X`，`waiting.map(sourceKey)` 是 `["muse:memory/drink"]`，长度 1。
   - 建议：先确定语义。若采用代码现有的“同 key 旧行标为被替换”，把用例改成期望 1 条、`sourceKey === "muse:memory/drink"`，并补一条断言确认 `COFFEE` 行是 `superseded`、`supersededBy === X.id`；若要采用用例表达的“把 key 移给已有正文”，则存储层需要清掉旧行的 key 而不是 supersede，并同步改 ADR 0228 决定 2 的说明。无论哪种，当前状态是**用例会失败**。

2. **中：`memory.external.respond` 部分失败被静默吞掉，命令仍返回成功，调用方看不到哪些条目没处理。**

   - 文件：`apps/agent-service/src/production-memory-control.ts:1061-1067`
   - 证据：
     ```ts
     await writer.respond(command.payload.items, batchId);
     return { resultRef: batchId, replayed: false };
     ```
     `writer.respond` 明确返回 `{ decided, failed }`（`production-mcp-memory-writer.ts:448-494`），且只在“全部失败”时才抛第一条错误：
     ```ts
     if (decided === 0 && firstError !== undefined) throw firstError;
     return { decided, failed };
     ```
     控制层直接丢弃 `failed`，网关契约的 `memory.external.respond` 响应也没有失败计数。结果是网页端会显示“成功”，但部分条目可能因 `MCP_PROPOSAL_TEXT_MISSING`、`MCP_PROPOSAL_MEMORY_REMOVED`、`MCP_PROPOSAL_ALREADY_DECIDED` 等留在待确认或未保存。
   - 建议：要么把 `decided/failed` 放进命令结果/快照，要么在 `failed > 0` 时抛出可区分的部分失败错误；至少在 `memory.overview.snapshot` 里让前端能识别未处理条目。ADR 0228 只写了“全部失败回第一条错误”，没有说明成功返回里如何报告部分失败。

3. **中：分级调高只改 `classification`，不改 `category`；保存后的记忆分类和 `sensitiveTopic` 仍是旧分类。**

   - 文件：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:160-170`；`apps/agent-service/src/production-mcp-memory-writer.ts:290-317`
   - 证据：
     ```ts
     const raised = known.status === "pending" &&
       known.dataClassification === "private" && input.dataClassification === "sensitive";
     if (raised)
       UPDATE external_memory_proposals SET classification = 'sensitive', content_ref = ? ...
     ```
     `keep` 之后用行里的旧 `category` 写记忆：
     ```ts
     attributes: {
       category: proposal.category,
       ...
       ...(dataClassification === "sensitive"
         ? { sensitiveTopic: sensitiveTopicFor(proposal.category) }
         : {}),
     }
     ```
     例如先用 `category: "other"` 提“每晚吃降压药”再以 `category: "health"` 重提：行变成 sensitive，但 category 仍是 `other`，`sensitiveTopic` 变成 `other` 而不是 `health`。这与 ADR 0228:65 举的“第一次其他、第二次健康”的例子直接相关。
   - 建议：调高时同步更新 `category`（至少保留导致敏感的那个分类），或单独存“调高来源分类”，`keep` 用更具体的分类计算 `sensitiveTopic`。

4. **低：错误路径会留下无人引用的加密 payload。**

   - 文件：`apps/agent-service/src/production-mcp-memory-writer.ts:183-199`、`:293-324`
   - 证据：`submit` 先 `await this.#storeText(contentRef, text, dataClassification)`，之后才 `proposals.submit(...)`；`keep` 也先 `#storeText`，再 `applyProposal`。若随后 DB/加密/记忆写入抛错，payload 已经落库且没有任何提议/记忆引用它，`dropDiscardedText` 不会清（它只处理 rejected/superseded 且 `content_ref IS NOT NULL` 的行）。同样，`propose_memories` 中某条 `submit` 抛错会中止整批，前面已写 payload 的条目也可能留下孤立对象。
   - 建议：把 payload 写入放到同一事务内，或在 `submit/keep` 失败时用确定的 `contentRef` 回收（注意不要删掉已被其他行引用的同一 ref）。

5. **低：跨 key、同正文的替换存在把某个客户端最新正文挤掉的边缘情况。**

   - 文件：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:144-179`
   - 证据：命中已有行时只“补空 key”，不更新已有非空 key：
     ```ts
     if (known.sourceKey === null && input.sourceKey !== null) UPDATE ... source_key = ? ...
     ```
     场景：`A(text=T2, key=K1)` 已待确认；`K2` 客户端提交同正文 `T2/key=K2`，命中 A，A 仍挂 K1，K2 的旧行被 supersede；随后 K1 提交新正文 `T3/key=K1`，`replaced` 会包含 A（key=K1、正文 T2），A 被 supersede。此时 K2 刚提交的 T2 从待确认消失。
   - 建议：明确“同正文不同 key”是合并到已有行还是保留 key 语义；若合并，至少让 A 同时可被两个 key 命中（或记录 key 别名），避免另一个 key 的后续更新误删它。

6. **低：摘要缓存只随写入器自己的 `#memoryChanges` 失效，跨路径写入和“建了记忆但决定失败”的窗口会造成缓存陈旧。**

   - 文件：`apps/agent-service/src/production-mcp-memory-writer.ts:263-269`、`:294-329`、`:496-503`
   - 证据：
     ```ts
     if (!stored) this.#memoryChanges += 1;
     digests.set(proposalTextDigest(text), memoryId);
     if (digestCache) digestCache.memoryChanges = this.#memoryChanges;
     ```
     计数器在 `applyProposal` 和 `#decideCommitted` 之后才加。若 `applyProposal` 成功、`#appendOnce`/`#decideCommitted` 抛错，同一 `respond` 后续条目仍复用不含新记忆的缓存，可能为同样正文再建一条；另外 `memory.create`/`memory.import` 等不走这个写入器，respond 进行中并发新增同正文记忆不会被发现。
   - 建议：`applyProposal` 成功后立即更新缓存（而不是等决定成功）；或对 `respond` 内相同正文直接用数据库/状态重新校验，不依赖计数器。

7. **低：`propose_memories` 标了 `idempotentHint: true`，但重发带 key 的批量会新增 superseded 行、新的 proposalId 和决策记录。**

   - 文件：`apps/agent-service/src/production-mcp-read.ts:541-545`；`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:120-143,182-206`
   - 证据：`idempotentHint: true`；重发 `[A/key K, B/key K]` 时，A/B 的旧行已是 superseded、被 `existing` 查询排除，于是会重新 insert 新 A、新 B 再互相 supersede，最终待确认集合相同，但 proposalId、`receivedAt`、批量结果字节都变了，还多出 superseded 行和对应 ledger。工具说明“同样的内容只会存一条，可以放心重发”在“待确认集合”层面成立，但强幂等不成立。
   - 建议：要么把 annotation 改成非幂等，要么对同 key 且正文集合相同的重复调用复用已有行/返回稳定结果。

8. **低：端口层不校验正文长度、机器密钥和 `sourceKey` 长度，坏输入会以 SQLite 约束错误而非 `PORT_INVALID_OPERATION` 冒出。**

   - 文件：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:103-112`；`apps/agent-service/src/production-mcp-memory-writer.ts:167-199`
   - 证据：存储层只校验 `textSha256`、`receivedAt`、`contentRef !== null`、`id` 长度；作者说的 2000 字、机器密钥检查都在 `production-mcp-read.ts:773-787` 和 `keep` 里。当前生产入口会先校验，所以不是现网漏洞，但端口本身不设防，未来新增调用方容易绕过。
   - 建议：把同样的正文长度/密钥/`sourceKey` 校验下沉到写入器或端口，保持单一真相。

**推测 / 未核实**

- **`propose_memories` 的“分类不对、超过 50 条整次被拒”**：代码在 `#readProposalArgs` 里对分类返回逐条 `"invalid"`，而 `#proposeMemories` 的 schema 有 `enum`/`maxItems`。实际是否整次拒绝取决于 MCP SDK 是否在进入 handler 前校验 schema；我未核实 SDK 行为。若不校验，工具说明与实现不一致。
- **`memory.external.undo` 的幂等性**：`control.ts:1078-1081` 在 `listBatch` 为空时抛 `MEMORY_EXTERNAL_BATCH_NOT_FOUND`；撤销成功后 `batch_id` 被清空，因此同一批再撤销（不同 idempotency key，或崩溃后重放未命中缓存）会报“批次不存在”。上游是否按 idempotencyKey 直接回放，我未核实。
- **ADR/文档与代码的措辞**：ADR 0228:67 说“新正文已经在待确认里时，旧的同样标为被替换”，与代码一致，但与新增用例冲突；ADR 0228:74/工具说明对“分类不对整次拒绝”与代码的逐条 `invalid` 存在潜在不一致（同上，取决于 SDK）。

## 侧重检查

- **机器密钥/不可信输入**：正文和 `key` 都在 `production-mcp-read.ts:773-787` 扫描；网页确认改字走 `keep` 的 `proposalHasMachineSecret`（`production-mcp-memory-writer.ts:261-262`）。`assertStorable` 只检查非空（`production-memory-control.ts:232-235`），长度和密钥最终由 `keep` 兜住；契约 `boundedString(2000)` 使用 UTF-16 `.length`，与 `keep` 一致。
- **待确认正文的模型可见性**：数据库读取 `external_memory_proposals` 的代码只有写入器、记忆控制、导出计数和迁移/目录；`find_memories`、`today_context`、记忆索引、档案都只读 `memory_records`/索引。`memory.overview.snapshot` 只被控制中心网页读取，不是模型组装路径。未发现泄漏路径。
- **迁移 CHECK 与代码状态组合**：`pending/committed/rejected/superseded`、`decided_at`、`batch_id`、`memory_id`、`content_ref`、`superseded_by` 的写入都满足 `0093_external_memory_proposals.sql:21-29` 的 CHECK；`reopenBatch` 同时把 `status/decided_at/batch_id/memory_id` 改回 pending/NULL，不违反约束。
- **外键与删除流程**：待确认 payload 的 ref 前缀 `memory-content:mcp-proposal:` 与记忆 payload 的 `memory-content:mcp:` 不会碰撞（提案编号上限 40，长度和字符都对不上），因此 `content_ref REFERENCES payloads(ref) ON DELETE RESTRICT` 不会挡住现有记忆/ payload 删除；`memory_id` 的 `ON DELETE SET NULL` 也允许记忆被删除。`dropDiscardedText` 先清 `content_ref` 再删 payload，说明作者已考虑 RESTRICT。
- **撤销误伤**：`undoBatch` 同时检查 `memory:mcp:` 前缀和 `:${batchId}` 后缀，且只遍历 `listBatch` 里的行；批量号的固定形状使其不会命中别批或客户端确认产生的 `memory:mcp:<uuid>`。未发现误伤。
- **资源耗尽**：待确认按设计不过期，且没有每作用域待确认条数上限；`listPending` 上限 1000、网页显示 100 只影响读取，不阻止长期积累。每个新正文都会存一份加密 payload；结合上面的错误路径孤立 payload，长期可被写权限客户端持续放大。建议至少加待确认条数/字节上限或在概览里明确告警。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 对 **Himawari 自己发给模型的请求**：不会。没有模型组装代码读 `external_memory_proposals`；“系统提示、工具定义、历史、遮盖结果”都不涉及这张表。新增/修改的 `mcp.propose-memory*` 提示词只在 `production-mcp-read.ts`（外部 MCP 服务端）使用。
   - 对 **外部 agent 自己的模型请求**：会变一次。新增了 `propose_memories` 工具并改了 `propose_memory` 描述，外部客户端的工具列表/定义变了，属于一次性前缀变化；这不是 Himawari 的模型缓存。
   - **是否只在末尾追加、每轮变化的值是否在最后一条消息里**：待确认回执、`proposalId`、`receivedAt`、`decidedAt` 都只出现在 MCP 工具结果或网页快照，不在系统提示/工具定义里；对 Himawari 模型而言仍是“固定在前、变化在尾部”。结论：符合规则，除外部客户端自身的工具集合变化外。

2. **同一段文字会不会在不同请求里变成不同字节？**
   - 模型可见内容：不会。正文先 `NFC` + 去不可见字符 + 折叠空格（`normalizeProposalText`），摘要、payload ref、批次号都确定性；同一提议重发按正文摘要命中同一行，回执 `id/receivedAt` 不变。列表顺序有 `ORDER BY received_at, rowid` / `ORDER BY MAX(decided_at) DESC, batch_id`。
   - 但发现一处强确定性缺口：`propose_memories` 重发带 key 的批量会重新 insert 新的 superseded 行，导致 `proposalId`、`receivedAt`、结果字节变化（见上文问题 7）。加密 payload 的密文每次可能不同，但不进入模型请求。

3. **有没有自动检查，反向用例会不会真的失败？**
   - 有：迁移契约测试、`gateway-v2.contract.test.ts` 的 0/501/重复编号/拒绝带改字负例、`mcp-write.test.ts` 的批量去重、撤销、30 天清理、分级调高、模型不可见等用例。
   - 没运行（本轮只能用只读工具），但从代码对照可以确认：`mcp-write.test.ts:1738-1743` 的新用例与 `sqlite-external-memory-proposal-operations.ts:146-179` 的实现相反，**会失败**。因此本轮“命中已有待确认行时把同 key 其他行标为 replaced”这一行为没有被一个通过的用例覆盖。另有未覆盖项：respond 部分失败、跨路径摘要缓存陈旧、错误路径孤立 payload、撤销重试幂等。

4. **每个值的生产者和消费者是否都匹配？**
   - 已核对：`proposalId`（36/≤40，DB 允许 1–128）、`batchId`（`batch-` + 32 hex = 38，DB ≤128；ledger id 最长约 110）、`memoryId`（`memory:mcp:` + proposalId + `:batchId`，约 90）、记忆 payload ref（约 98）、待确认 payload ref（约 92）、`subjectRef`（1–128 或 `sha256:`+64）、`client`（正则 ≤64）、`textSha256`（64 hex）、`category`（契约去 rule 后与 DB 九类一致）、`dataClassification`（private/sensitive）、`status`（四种一致）、ISO 时间格式一致。`memory_records`/`payloads` 没有额外长度约束，长度也不冲突。
   - 不一致/缺口：直接调用 `writer.submit`/存储层时不校验正文长度、机器密钥和 `sourceKey`（见问题 8）；分级调高时 `category`/`sensitiveTopic` 消费端仍拿旧值（见问题 3）。
