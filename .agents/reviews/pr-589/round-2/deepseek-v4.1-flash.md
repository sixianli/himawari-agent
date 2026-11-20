本轮增量范围：`git diff 6f62835..8c523d0` 只改了 `production-mcp-memory-writer.ts`、`production-mcp-read.ts`、浏览器测试和 ADR 0281。我沿这些改动追到 `sqlite-external-memory-proposal-operations.ts`、`memory-source.ts`、`prompt-catalog/tools.ts`、记忆页和 `mcp-write.test.ts` 核对使用端。

### 1（中高）直接存仍可用外部 agent 自己声明的 category 绕过“敏感内容待确认”

文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:94-101`、`:286-287`；`packages/prompt-catalog/src/tools.ts:370`；`docs/adr/0281-memory-from-outside-agents-saves-directly-when-the-owner-turns-it-on.md:74-75`。

问题：敏感判定仍只看外部 agent 自己填的 category，或正文里是否有证件号/银行卡号这类标识。外部 agent 把“主人有高血压，每天吃降压药”标成 `other`，正文又没有号码，就会按 `private` 直接入库。ADR 第 74 行已把这一点写成“已知缺口”，但第 75 行仍宣称“敏感分级一律待确认”能兜住；工具说明第 370 行也对外承诺“健康、财务、证件”即使直接存也先待确认。代码与这两处说明不一致，最初“敏感内容仍待确认”的目标没有达成。

读代码证实：

```ts
return (MEMORY_SENSITIVE_CATEGORY_NAMES as readonly string[]).includes(category)
  ? "sensitive"
  : classificationWithIdentifiers(text, "private");
```

```ts
const proposal = await this.#pending(proposalId);
if (proposal.status === "pending" && proposal.dataClassification !== "private")
  return "pending";
```

现有反向用例只测了 `category: "health"`（`test/integration/mcp-write.test.ts:2125-2126`），没有测“健康内容 + `other`”。

推测：这正是 ADR 第 74 行描述的场景；是否构成实际泄露取决于正文是否含可识别号码。按代码，不含号码就会直接存。

建议：直接存路径要么做内容级敏感检测（模型或规则），要么只允许明确的非敏感类别直接存、健康/财务类正文直接拒绝并留待确认；至少先把工具说明和 ADR 第 75 行改成与第 74 行一致，并明确记录 Andy 是否接受这个缺口。

### 2（中）直接存绕过待确认/暂存配额，提交行和记忆数量没有上限

文件:行：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:156-170`；`apps/agent-service/src/production-mcp-memory-writer.ts:279-292`、`:355-390`。

问题：原有的 1000 条待确认、5000 条暂存上限只统计 `status <> 'committed'` 的行。设成直接存后，条目立即变成 `committed`，不再计入这两个上限；代码里没有新增按连接或按天的直接存配额。一次 `propose_memories` 最多 50 条，按每分钟 30 次调用，理论上一个接入每分钟可写入 1500 条长期记忆，且这些行会一直保留。这是直接存路径带来的资源耗尽面，不是本轮增量新引入，但本轮复核错误/资源路径时必须指出。

读代码证实：

```sql
SELECT SUM(status = 'pending') AS pending, COUNT(*) AS held
FROM external_memory_proposals
WHERE owner_id = ? AND agent_id = ? AND status <> 'committed' AND content_ref IS NOT NULL
```

直接存随后走 `applyProposal(... decision: "create" ...)` 并把 proposal 标成 `committed`。

推测：如果没有更上层的全局记忆总量或磁盘配额，恶意或失控的外部 agent 可以持续膨胀记忆库和 `external_memory_proposals` 表；我只核对了 MCP 路径，未逐层核对所有存储配额，标为未完全核实。

建议：给直接存加每接入/每天的提交或记忆条数上限，或让直接存提交也占用一个独立的配额；至少在 ADR 里写明接受这个风险。

### 3（低）去重命中时仍带批次号，整批撤销对该条目是空操作

文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:288-291`、`:324-326`、`:395-409`、`:513-528`；`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:390-397`；`apps/control-center/src/components/external-proposals.tsx:207-226`。

问题：上一轮的“去重命中却回 saved / 可撤销”只修了回执文字，现在回 `already_saved`，方向正确；但去重提案仍用本次 `batchId` 提交，`listBatches` 会把它算进 `committed`，记忆页会显示这一批“保存了 N 条”并给出“撤销这一批”。撤销时 `undoBatch` 只回收 `memoryId === externalProposalMemoryId(member.id, batchId)` 的记忆；去重条目指向的是旧记忆，不会被删除。若一批只有去重条目，撤销只把该提案从批次里摘掉，旧记忆原样保留，对用户就是一次空操作。

读代码证实：

```ts
const memoryId = await this.#keep(proposalId, { ...input, direct: true }, digestCache);
return memoryId === externalProposalMemoryId(proposalId, input.batchId)
  ? "saved"
  : "existing";
```

```ts
if (
  member.status === "committed" &&
  member.memoryId === externalProposalMemoryId(member.id, batchId)
) {
  await trash(member.memoryId);
```

建议：去重命中时不要把提案绑到本批次（例如 `batchId: null` 或单独标记“未新建记忆”），或在 `listBatches`/记忆页里把这类条目从可撤销计数中排除，避免显示一个撤销不了任何东西的批次。

### 4（低）摘要缓存的修复没有自动检查，回归时测试不会失败

文件:行：`apps/agent-service/src/production-mcp-read.ts:1160-1169`；`apps/agent-service/src/production-mcp-memory-writer.ts:582-590`；`test/integration/mcp-write.test.ts:2139-2172`。

问题：上一轮第 3 条要求给 `propose_memories` 直接存复用网页确认路径的摘要缓存。增量确实在每次 `propose_memories` 调用里建了一个 `digestCache` 并一路传到 `#keep`/`#digests`，代码层面已修好；但测试只断言最终状态，没有统计 `listActive`/解密调用次数，也没有“一批多条时只扫描一次”的断言。这个优化以后被改回去，现有测试不会失败。

读代码证实：`#digests` 用 `cache.memoryChanges === this.#memoryChanges` 复用缓存，逻辑成立；测试没有对应计数器。

建议：在 `setup()` 的状态桩里给 `listActive` 加调用计数，增加一个“同一次直接存多条的 `propose_memories` 只调用一次 `listActive`”的用例。

### 5（低）内存代际尚未建立时，直接存会回“失败”而不是“待确认”

文件:行：`apps/agent-service/src/production-mcp-read.ts:1228-1237`；`apps/agent-service/src/production-mcp-memory-writer.ts:343-350`。

问题：先问路径在弹确认框前检查了 `await proposals.ready()`，未就绪就回待确认；直接存路径没有这个检查，直接调用 `keepDirect`。若还没有内存代际，`#keep` 抛 `MEMORY_GENERATION_MISSING`，最终 `#proposeMemory` 的外层 catch 回 `MCP_PROPOSE_MEMORY_FAILED`（isError），而提案其实已经提交并留在待确认。外部 agent 看到的是失败，不是“等主人确认”。这是既有直接存路径的问题，不是本轮增量新引入，复核错误路径时发现。

读代码证实：

```ts
if (direct) {
  const kept = await this.#keepDirect(proposals, proposal.id, started);
  ...
}
if (!elicitationSupported(context.mcpReq.envelope) || !(await proposals.ready()))
  return this.#pendingReply(proposal);
```

```ts
if (!generation)
  throw new ApplicationPortError(
    PORT_ERROR_CODES.INVALID_OPERATION,
    "MEMORY_GENERATION_MISSING",
  );
```

推测：生产启动后是否总会先建立代际取决于初始化流程；若可能没有，这个分支就会触发。建议直接存前也检查 `ready()`，未就绪按待确认返回。

**上一轮意见核对**

- 1（敏感内容）：未真正修复。代码仍是自报分类，ADR 新加“已知缺口”但第 75 行和工具说明仍宣称敏感一律待确认，见本轮意见 1。
- 2（浏览器测试默认值）：已修复。`test/integration/mcp-connections-browser.test.ts:147` 已断言 `pushPolicy: "direct"`，与设置页默认值和网关接受 `direct` 一致。
- 3（摘要缓存）：代码已修复，但没有回归测试，见本轮意见 4。
- 4（去重命中回 saved）：回执文字已改成 `already_saved`，但批次归属和空撤销仍在，见本轮意见 3，属于部分修复。
- 5（并发 superseded 报 pending）：已修复。`production-mcp-read.ts:1180-1181` 新增 `decided === "superseded" ? "replaced"`；没有专门并发用例，但逻辑与旧有 `replaced` 状态一致。

**侧重检查**

- 不可信输入：正文、category、key 在提交和保存时都有长度/枚举/机器密钥校验；但 category 是可被外部 agent 伪造的敏感分级依据，见意见 1。
- 错误路径：`keepDirect` 只把 `MCP_PROPOSAL_ALREADY_DECIDED` 归为 settled；其他异常（含内存代际缺失）会让结果停在 pending 或直接报失败，见意见 5。若 `applyProposal` 成功但后续 ledger/decide 失败，内存已经可见而结果仍报 pending，这是既有部分提交风险；本轮未作为新错单列。
- 资源耗尽：直接存绕过待确认/暂存配额，见意见 2。
- 不可撤销操作：整批撤销对“创建出来的记忆”基本成立；对去重命中和部分失败重试路径不成立，见意见 3。
- 文档与代码一致：ADR 74 行承认定级缺口，75 行和工具说明仍过度承诺；其余 `keptDirect`、`batch-direct-`、`external_direct` 的说明与代码一致。
- 提示词：本轮增量没有碰任何发给 Himawari 自己模型的内容；MCP 工具说明是给外部客户端的固定定义，见必答问题 1。

**必答问题**

1. **不改变模型已经见过的请求开头。** 本轮增量没有改系统提示、工具定义、历史消息或遮盖结果。`packages/prompt-catalog/src/tools.ts` 的工具说明是给外部 MCP 客户端的，且不随 `pushPolicy` 变化；直接存的回执是追加在这次 MCP 工具调用末尾的结果。Himawari 自己发给模型的请求一个字节都没变，新增的 `pushPolicy` 只在 `authInfo.extra` 内部流转，不进入模型请求。依据的“只在末尾追加”没有被破坏。

2. **没有让同一段文字在模型请求里变成不同字节。** 直接存新增的随机批次号只出现在内部记忆 ID、决策记录 ID 和 MCP 回执/记忆页；同一段文字第二次提交会命中去重，指回同一条记忆，不会因随机批次号生成第二条。没有依赖前后文的遮盖、时间字段或无序集合进入模型请求开头。内部 ID 会因批次随机而不同，但这不是模型可见文本。

3. **有自动检查，但覆盖不完整。** 四条 `[direct]` 用例覆盖：直接存、先问仍待确认、声明为 health 的敏感内容仍待确认、规则不生效、同批替换、跨调用重复内容回 `already_saved`；浏览器测试覆盖新建接入发送 `direct`。反向用例中“先问仍待确认”“规则不生效”确实会让回归失败。缺的是：健康/财务内容伪装成 `other` 的反向用例（按当前代码会直接存，测试会暴露意见 1）、摘要缓存只扫描一次的计数断言（意见 4）、并发 superseded 的专门用例，以及“整批只有去重条目”的撤销用例（意见 3）。

4. **逐个核对本轮产生/修改的值：**
   - `keepDirect` 新增返回值 `"existing"`：使用端 `production-mcp-read.ts:1170-1171` 和 `:1231-1232` 都处理了，接口实现只有 `ProductionMcpMemoryWriter` 一处，能接受。
   - `ExternalProposalDigestCache` 参数：生产端在 `propose_memories` 每次调用创建一次并传入，使用端 `#digests` 能接受；类型从 writer 导出、read 导入，编译层面一致。
   - MCP 结果状态 `already_saved` / `replaced`：`propose_memories` 结果是自由文本 JSON，工具说明已列出这两个状态，没有额外 schema 枚举拦截。
   - `keptDirect` 原因码：决策账本只校验字符串长度 1–64，能接受；`daily-review` 只把 `pending`/`superseded` 当成未保存，`keptDirect` 按已保存处理，行为正确。
   - `external_direct` 记忆来源：`memorySourceState` 通过 `memory:mcp:` 加 `:batch-direct-` 判定；记忆页已把它归到“主人决定”的来源文案，`memory-checkup` 只检查 `unavailable`，不会误判；测试 `mcp-write.test.ts:2101-2109` 断言了该值。
   - `batch-direct-` 批次号：写入端生成 24 位十六进制，`memorySourceState` 和测试正则都按这个格式接受，两端一致。
   - `pushPolicy: "direct"`：网关契约枚举和 SQLite 存储的 `oneOf` 都包含 `direct`，浏览器测试断言创建命令带 `direct`；后端单元测试覆盖了“改成 direct”的路径，但“新建时直接传 direct”只在 UI fixture 里记录，没有走真实网关的创建正向用例，属于测试覆盖缺口，不是校验不一致。
