## 结论摘要

改动主体与作者说明大体一致：待确认正文确实没有进入任何模型可读路径；网页/客户端确认和撤销走同一个写入器队列；迁移的 CHECK 与代码写入的状态组合基本吻合；新增的网关契约和测试也覆盖了主要正常路径。但我读代码确认了 **撤销批次会让“保存时挂到已有记忆”的条目状态和记忆实际状态不一致**，以及 **替换逻辑仍用 `source_key` 列做候选，撤销后可能悄悄丢掉主人的待确认正文**。另外，待确认提议没有任何数量/容量上限，存在资源耗尽风险。

---

## 读代码证实的问题

### 1. 高：撤销批次会删掉记忆，却把挂到这条记忆上的其它提议留在「已保存」

文件：`apps/agent-service/src/production-mcp-memory-writer.ts:288`、`:464`，`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:393`

问题：`keep` 发现已有 active 记忆正文相同时，会把提议标为 committed 并指向那条记忆：

```ts
// production-mcp-memory-writer.ts:288
if (same) {
  await this.#commit(proposal, same, input);
  return same;
}
```

这些条目的 `memory_id` 是「另一条提议」的记忆编号，不等于自己算出的 `externalProposalMemoryId(member.id, batchId)`。撤销时：

```ts
// production-mcp-memory-writer.ts:466
else if (
  member.status === "committed" &&
  member.memoryId === externalProposalMemoryId(member.id, batchId)
) {
  await trash(member.memoryId);
  reopen.push(member.id);
}
```

只有编号精确匹配的条目会触发 trash；其余 committed 条目在存储层只被 `detach`：

```ts
// sqlite-external-memory-proposal-operations.ts:394
if (wanted.has(member.id) && member.contentRef !== null) { ...reopen... }
else if (member.status === "committed")
  detach.run(member.id, input.ownerId, input.agentId);
```

可达场景（测试 `mcp-write.test.ts:1652` 已经构造出这种状态，只是没有撤销）：
- 同一批 `P1`、`P2` 都被改成同一正文，`P1` 新建记忆 `M`，`P2` 挂到 `M`；
- 撤销这一批：`M` 被移进回收站、`P1` 回到待确认；
- `P2` 仍为 committed，`memory_id` 指向已进回收站的 `M`。
更一般地，另一批的提议也可能挂到本批新建的 `M` 上，撤销本批同样只 trash `M`，不处理别的批次的引用。

后果：记忆页上「已保存」的提议找不到 active 记忆；如果随后清空回收站，`sqlite-governed-deletion.ts:890` 会把 `P2` 改为 rejected 并清掉正文，主人从未确认的编辑内容也会随正文清理一起消失。

建议：撤销时按「被 trash 的 memoryId」反查所有提议并逐一调和，而不是只按批次内自己的编号判断；至少要把 `memory_id` 指向将被 trash 的记忆的 committed 条目一并重新打开。补一条「同批两条改成同一正文后再撤销」和「跨批挂接后撤销源批次」的测试。

---

### 2. 中高：替换候选仍使用 `source_key` 列，撤销后会被旧列值误标为「被替换」

文件：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:163`、`:186`、`:383`

证据：

```sql
-- :166
SELECT id FROM external_memory_proposals
WHERE owner_id = ? AND agent_id = ? AND status = 'pending' AND id <> ?
  AND (id = ? OR (client = ? AND source_key = ?))
```

```sql
-- :186
UPDATE ... SET status = 'superseded' ...
WHERE id = ... AND status = 'pending'
  AND NOT EXISTS (SELECT 1 FROM external_memory_proposal_keys WHERE proposal_id = ?)
```

`reopenBatch` 只改 `status / decided_at / batch_id / memory_id`，不清 `source_key`：

```sql
-- :384
UPDATE external_memory_proposals SET status = 'pending', decided_at = NULL,
  batch_id = NULL, memory_id = NULL
WHERE id = ? AND owner_id = ? AND agent_id = ?
```

可达场景：
1. 客户端 A 用 key `K` 提交 `T1` → `P1`（`source_key=K`，key 表 `K→P1`）；
2. 主人保存 `P1`；
3. A 用同一 `K` 提交 `T2` → `P2`，key 表 `K→P2`，`P1` 仍是 committed、`source_key` 仍为 `K`；
4. 主人撤销保存 `P1` 的那一批 → `P1` 回到 pending，但 key 表仍 `K→P2`；
5. A 用 `K` 提交 `T3` → 候选查询同时命中 `P1`（`source_key=K`）和 `P2`；
6. 两条都没有 key 再指着，于是 **`P1`（主人刚撤销、正在等确认的正文）被标成 superseded**。

这正是第 5/6 轮作者说明里「key 表和 `source_key` 列两套说法」会不一致的地方：第 3 步 key 已经改指，`source_key` 列却保留旧值；撤销又把旧值所在行重新变成 pending。结果是主人的待确认正文无声消失。

建议：替换候选只信 key 表当前指向（`previous` 或 `id=previous`），不要再用 `source_key` 列捞兄弟行；或者 key 改指时同步清空旧行的 `source_key`，并在 `reopenBatch` 时按 key 表重建关联。补一条「撤销 + key 已改指 + 再来新正文」的测试。

---

### 3. 中：待确认提议没有数量或容量上限，已登录的写客户端可以持续耗尽磁盘

文件：`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:1`，`apps/agent-service/src/production-mcp-memory-writer.ts:159`，`apps/agent-service/src/bearer-admission.ts:4`

证据：
- 迁移里 `pending` 没有任何过期或配额字段，正文以 payload 形式长期保留；
- `dropDiscardedText` 只清理 `rejected`/`superseded`：

```ts
// sqlite-external-memory-proposal-operations.ts:425
WHERE ... AND status IN ('rejected', 'superseded')
  AND content_ref IS NOT NULL AND decided_at < ?
```

- `submit` 对 pending 数量、总字节数没有上限；
- 限流只有每分钟 30 次授权请求：

```ts
// bearer-admission.ts:4
export const AUTHORIZED_PER_MINUTE = 30;
```

而 `propose_memories` 一次可写 50 条、每条最多 2000 个 UTF-16 码元。一个持有写权限的客户端（或被攻破的客户端）可以每分钟写入约 1500 条 4KB 级加密正文，且永不自动清理。`assertDiskHeadroom()` 最终会让所有产品写入一起失败，等于把「恶意填满待确认」升级成全服务写入不可用。

建议：给 pending 加按作用域的数量/总字节配额（超限拒绝并提示等主人确认），或对长期 pending 做告警/人工清理入口；至少记录待确认总字节数。

---

### 4. 中：没有 key 的客户端提交的待确认正文，可能被另一个客户端的 key 更新挤掉

文件：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:146`、`:163`，`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:31`

证据：
- 正文去重是全局的（唯一索引只按 `owner, agent, text_sha256`）：

```sql
CREATE UNIQUE INDEX external_memory_proposals_text_index
  ON external_memory_proposals(owner_id, agent_id, text_sha256)
  WHERE status <> 'superseded';
```

- 无 key 的提交直接返回、不登记引用：

```ts
// :146
if (input.sourceKey === null) return [];
```

- key 更新时按 `previous` 和 `source_key` 找候选，然后只要「没有 key 指着」就 supersede。

场景：Muse 不带 key 提交 `T` → 行 `P`（pending）；Claude 用 key `K` 提交同一 `T`，key 表 `K→P`；随后 Claude 用 `K` 提交 `T2`，`P` 没有其它 key 指着，被 supersede。Muse 的 `T` 从未被主人决定，却从待确认列表消失。这与 ADR 0228 里「一个客户端更新自己的内容，不能把另一个客户端还在用的那条挤掉」的理由不一致——key 表只记录带 key 的引用，无法保护无 key 的提交。

建议：要么在共享行上记录按客户端/提交来源的引用计数，要么只在「该行最后一次提交来自同一个客户端且该客户端的 key 仍可能指向它」时允许替换；至少接受这是设计限制并在 ADR 里写明。

---

### 5. 低：正文已被 30 天清理的 rejected 条目会永远占着批次，重复撤销会“成功但什么也没做”

文件：`apps/agent-service/src/production-mcp-memory-writer.ts:465`，`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:393`

证据：
- 写入器把批次内所有 rejected 条目都交给存储层：

```ts
if (member.status === "rejected") reopen.push(member.id);
```

- 存储层只有 `contentRef !== null` 才重新打开；`contentRef === null` 且不是 committed 的 rejected 行两者都不做：

```ts
if (wanted.has(member.id) && member.contentRef !== null) { ...reopen... }
else if (member.status === "committed")
  detach.run(...);
```

于是这类行的 `batch_id` 永远不会被清空，`listBatches` 永远返回这个批次；`#externalUndo` 只判断 `reopened === undefined`，所以重复撤销会返回成功、实际没有任何变化。

建议：对 `wanted` 但无法重新打开的 rejected 行也清空 `batch_id`（或在返回结果里告知“未恢复任何条目”），并补一条「拒绝正文过期后再撤销」的测试。

---

### 6. 低：先写 payload 再校验/插入提议，插入失败会留下永远没人清理的加密正文

文件：`apps/agent-service/src/production-mcp-memory-writer.ts:192`、`:198`，`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:128`

证据：

```ts
// writer:192
const contentRef = `${EXTERNAL_PROPOSAL_PENDING_CONTENT_PREFIX}...`;
await this.#storeText(contentRef, text, dataClassification);
const submitted = await this.#options.proposals.submit({ ... id: input.proposalId ... });
```

存储层随后才校验提议编号长度：

```ts
// operations:128
input.id.length < 1 ||
input.id.length > PROPOSAL_ID_MAXIMUM ||
```

如果 `proposals.submit` 因为编号超长、磁盘余量检查、数据库约束等原因失败，payload 已经写进 `payloads`，但没有提议行引用它；`dropDiscardedText` 只扫提议行，永远不会清掉这份孤儿正文。MCP 入口目前用 `randomUUID()`（36 字）不会触发，但写入器是公开服务，测试也直接传自定义编号。

建议：先做完所有可校验的输入检查（包括 `proposalId`），或 `submit` 失败时回滚/删除刚落下的 payload。

---

## 推测/未核实的问题

以下不是直接由现有调用路径触发，但属于清晰可读的薄弱点：

1. **低（推测）：同一批重试时 `editedText` 变了可能保存旧正文。** `#storeText` 对已存在 payload 只比较分级，不比较正文：

   ```ts
   // production-mcp-memory-writer.ts:628
   if (existing.dataClassification !== dataClassification)
     throw ...MCP_PROPOSAL_CONTENT_CHANGED;
   return;
   ```

   记忆正文引用是 `memory-content:mcp:<提议编号>:<批次号>`，不含正文摘要。若第一次写入 payload 后 `applyProposal` 失败，随后用同一批次号、不同 `editedText` 重试，会复用旧 payload。正常前端每次确认用新幂等键，所以实际触发概率低。

2. **低（推测）：任何一条待确认 payload 丢失会让整个记忆页概览查询失败。** `listPending` 用 `Promise.all(readText)`，`readText` 在 payload 不存在时抛 `MCP_PROPOSAL_TEXT_MISSING`：

   ```ts
   // production-mcp-memory-writer.ts:429
   items: await Promise.all(
     items.map(async (item) => ({ ...item, text: await this.readText(item) })),
   ),
   ```

   一条坏数据就会让 `memory.overview.snapshot` 整体失败，建议逐条容错或跳过并记录诊断。

3. **低（推测）：敏感提议可能挂到 `public` 分级的已有记忆。** 判断只排除了 `private`：

   ```ts
   // production-mcp-memory-writer.ts:283
   (existing.dataClassification !== "private" ||
     (proposal.dataClassification === "private" && ...))
   ```

   `memory_records.classification` 允许 `public`。当前常规记忆写入路径基本都会把分类抬到至少 `private`，所以不一定发生；但静态看，敏感提议挂到 public 记忆与 ADR「敏感不挂到较低分级」的精神不一致。建议改成按分级排序比较，而不是只特判 `private`。

4. **低（未核实）：`propose_memories` 的分类非法是否真的由 MCP SDK 在处理器前整次拒绝，测试没有直接覆盖。** 代码里的处理器对“分类不在九种”只会逐条返回 `invalid`；若 SDK 某天不校验 enum，实际行为会与工具说明/ADR 的“整次调用被拒”不一致。

---

## 侧重检查

我重点查了错误路径、不可信输入、安全、资源耗尽、不可撤销操作和文档一致性：

- **不可信输入**：MCP 入口的 `text/category/key` 校验、密钥扫描、`subjectRef` 过长转摘要、`client` 长度、存储层二次校验都读了；整体与 ADR 0228 决定 2/3 一致。发现 `proposalId` 只在存储层校验且校验发生在 payload 写入之后（问题 6）。
- **安全/越权**：所有读、决定、撤销都按 `ownerId/agentId` 作用域查；撤销按 `proposalId + batchId` 精确计算记忆编号，不按后缀猜，未发现可越权 trash 任意记忆的路径；`payload` 直接删除会被 `#payloadReferenced` 以 FK 扫描挡住。
- **payload 删除**：`contentInUse` / `dropDiscardedText` 的 `used` 检查会保留仍被其它提议引用的正文；「同一正文重新进入待确认时旧被替换条目过期」有测试覆盖；未发现删除仍被引用的 payload。
- **不可撤销/删除**：`sqlite-governed-deletion` 把提议改 rejected、清 `content_ref`、把正文加入待删列表，再检查引用后删 payload；在 `deleteCore` 事务里完成，未发现外键 RESTRICT/SET NULL 会挡住删除流程。但撤销和删除/普通 trash 之间没有共同锁，理论上仍可能交错（问题 1 的一部分）。
- **资源耗尽**：见问题 3。
- **规则/文档一致性**：ADR 0228 的「取消/未看到留 pending」「拒绝 30 天清正文」「key 按客户端分开」「撤销只删本批新建记忆」「敏感不挂 private」等描述与代码基本对应。文档说撤销后挂到已有记忆的条目“仍算已保存，因为那条已有记忆没有被撤销”，但代码没有排除“那条记忆其实正是本批另一条新建记忆”的情况（问题 1）。另外迁移允许 `id` 最长 128，而存储层上限 40，两处约束不一致（虽然代码更严，不会写成超长值，但决策记录编号预算依赖 40，见必答问题 4）。

---

## 必答问题

### 1. 改动会不会改变模型已经见过的请求开头？

**不会。** 我对照了 `.claude/rules/prompt-prefix.md` 和本次改动：
- 新增/修改的 `propose_memory`、`propose_memories`、pending/secret/result 文字只注册在对外 MCP server（`production-mcp-read.ts`），没有进入 Himawari 自己发给模型的系统提示、工具定义、历史或最后一条用户消息；
- `memory.overview.snapshot`、`memory.external.respond/undo` 都只服务网页；
- 每日回顾只是跳过 pending/superseded 决策记录，没有把待确认正文加入模型请求；
- 模型可见内容仍只在末尾追加，没有把每轮变化的值放进请求开头。

唯一需要留意的耦合是：新提示词文字会通过 `prompt-catalog` 自动进入 `TRUSTED_PROMPT_TEXTS`，而 `model-egress` 用它判断哪些文字属于 Himawari 自己的固定文字。理论上新增固定片段会改变“碰巧包含该片段的模型消息”的遮盖结果；但这些新片段只用于外部 MCP，不出现在现有对话里，我没有发现实际字节变化。建议仍以 `npm run check:prompt-prefix` 为准（本次未运行）。

### 2. 同一段文字在不同请求里会不会变成不同字节？

**对模型请求：不会。** 没有新字段进入模型请求。

对新增的存储/对外回复：
- 待确认回执只用提议编号和数据库里的 `receivedAt`；同一提议重复读取字节相同；
- 批次号是幂等键的 SHA-256 前 32 位，确定性；
- 待确认正文引用是 `(owner, agent, 分级, 正文摘要)` 的哈希，给定正文和分级确定性；
- 批量结果按输入顺序输出，待确认列表按 `received_at, rowid` 排序。

需要知道的两个非纯函数点（不影响模型字节）：
- 同一段正文从 private 被调高为 sensitive 时，payload 引用会换一份，这是 ADR 明确设计；
- `#activeDigests` 遇到多条正文相同的 active 记忆时取 `listActive` 顺序里的第一条，可能影响挂接到哪条记忆，但不影响发给模型的文字。

### 3. 有没有对应自动检查？反向用例真的会失败吗？

有，但本次工具受限没有运行测试，以下是从代码/测试内容核对到的：

- `packages/gateway-contracts/test/gateway-v2.contract.test.ts`：拒绝 `reject` 携带 `editedText`、同批重复 `proposalId`、0 条、>500 条。
- `test/integration/mcp-write.test.ts`：待确认不可见、回执固定、去重、50/51 条、key 替换、replaced 状态、敏感不挂 private、撤销、30 天清理、客户端确认框与网页决定交错、key 按客户端分开、全部在别处决定时报冲突。
- `test/integration/sqlite-governed-deletion.test.ts`：彻底删除记忆时提议改 rejected、清正文、payload 删除。
- 迁移契约测试已把当前序列改为 93；`check-egress-redaction` 已登记 `scanMachineSecrets` 的新调用点是 KEEP。

反向用例方面，按代码推断以下新测试在缺少对应修复时会失败：key 按客户端分开、敏感不挂 private、全部在别处决定时抛 `MCP_PROPOSAL_ALREADY_DECIDED`、彻底删除后提议变 rejected 且 payload 被删、撤销后挂到已有记忆的条目保持 committed 且离开批次。但这些只是读代码推断，未实际执行。

**覆盖缺口**：没有「同批两条改成同一正文后再撤销」「撤销 + key 已改指 + 再来新正文」「拒绝正文过期后重复撤销」「跨批挂接后撤销源批次」的测试；`propose_memories` 分类非法整次拒绝依赖 SDK 校验，也没有直接测试。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

逐项核对了产生端和使用端：

- **提议编号**：MCP 用 `randomUUID()`（36），存储层上限 40，迁移允许 128。用它拼出的记忆编号、`ledger:mcp-proposal:<id>:<batch>:<decision>` 最长约 110 字，低于决策记录 128 的上限。两端都接受；但迁移 128 与存储 40 不一致，属次要文档/约束不一致。
- **批次号**：`batch-` + 32 位十六进制 = 38 字，满足 `batch_id` 的 1–128 和决策记录编号预算；`memory.external.undo` 只是把用户给的 batchId 当 SQL 参数，不落库。
- **`source_key`**：写入器按码点限 200，存储层再按码点限 200，迁移 CHECK 也限 200，key 表主键包含 `client`；两端的长度校验一致。但运行期语义不一致，见问题 2/4。
- **`client`**：MCP 入口正则产生 1–64 位 ASCII，写入器和存储层都限 64，迁移 CHECK 也是 1–64；一致。
- **`subjectRef`**：写入器把不在 1–128 范围内的值换成 `sha256:<64hex>`，存储层/迁移都接受 1–128；一致。
- **待确认 `contentRef`**：前缀 + SHA-256，长度约 92，作为 payload 主键和提议外键；一致。
- **保存后的 `contentRef`/记忆编号**：`memory-content:mcp:<提议编号>[:<批次号>]`、`memory:mcp:<提议编号>[:<批次号>]`；记忆表、payload 表、来源识别（按 `memory:mcp:` 前缀）都能接受；撤销用精确字符串比对，不会误伤同后缀记忆。
- **`text_sha256`**：写入器生成 64 位十六进制，存储层正则和迁移 `length=64` 都接受；唯一索引使用同一字段。
- **`category`**：写入器、存储层、迁移 CHECK、网关契约、overview schema 都是同样的九种（不含 `rule`）；一致。
- **`dataClassification`**：写入器、存储层、迁移、overview schema 都只接受 `private/sensitive`；一致。
- **状态**：`pending/committed/rejected/superseded` 在 port、迁移、代码分支、overview/listBatches 中都对应；`pending` 必须有 `content_ref` 且 `decided_at` 为空，`rejected/superseded` 可空 `content_ref`，代码写入组合都满足迁移 CHECK。
- **决策记录**：`pending`/`kept`/`declined`/`superseded` 的原因码在 `decision-ledger.ts` 定义，`outcome` 落在 `memory_candidate` 允许集合内；编号长度见上。
- **`externalProposals` 序列化**：`ProductionMemoryControl` 产出的 `{total, items, batches}` 与 `contracts-v2.ts` 的 schema、控制中心测试 fixture、e2e fixture 都已同步；字段类型和枚举一致。
- **数据导出清单**：`externalProposals` 计数排除 committed，导出 omits 文案说明“已确认保存的会作为普通记忆导出”；与今天的导出实现一致。

结论：正常路径两端都能接受；不一致点集中在 `source_key` 的运行期语义、提议编号的两套上限，以及撤销/删除交错时的记忆—提议一致性。
