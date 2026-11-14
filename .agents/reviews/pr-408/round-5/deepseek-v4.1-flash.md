# PR 408 复核结论（e36981ac 相对 075dd4a6，重点看 c2482267..e36981ac）

## 发现的问题（按严重度从高到低）

### 1. 中：命中「已保存 / 已拒绝」的正文时，固定编号没有改指，同一 key 的旧待确认也不会被替换

- 文件：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:185-187`
- 问题：`claim()` 只在已有行是 `pending` 时调用。当同一个 key 最新带来的正文正好命中一条 **committed / rejected** 行时，key 表不更新，也不把同一 key 下旧的 pending 标记为 `superseded`。
- 证据（亲自读到）：

```ts
if (existing) {
  const known = record(existing);
  const replaced = known.status === "pending" ? claim(known.id) : [];
```

  而 ADR 0228 写的是「每个固定编号指向它最近一次带来的正文」（`docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:68`），且第 67 行说「同一个编号带来不同的正文时，旧的待确认那条标为 superseded」。
  具体后果：key `K` → 待确认 `B`；客户端用 `K` 又发来正文 `T`，而 `T` 早已被保存为 `A`。代码返回「已保存过」，但 `K` 仍指向旧的 `B`，`B` 仍留在待确认列表里；主人之后可以把已经过时的 `B` 保存下来。拒绝路径同理。
- 建议：`const replaced = claim(known.id)` 无条件执行（`sourceKey === null` 时 `claim` 本来就直接返回 `[]`），让 key 指向这一行、并让同一 key 下没人再指着的旧 pending 被替换；补一条反向测试（命中已保存/已拒绝时旧 pending 必须变 `superseded`，key 表必须指向新的行）。

### 2. 中：committed 提议的待确认正文永不清理，记忆被彻底删除后这段文字也删不掉

- 文件：`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:10,22,26`；`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:393-395`
- 问题：`content_ref` 是 `ON DELETE RESTRICT`，`memory_id` 是 `ON DELETE SET NULL`；`dropDiscardedText` 只清理 `rejected` / `superseded`。提议保存成记忆时，提议自己的 `content_ref` 仍是提交时那份 `memory-content:mcp-proposal:...`（`keep` 新建记忆用的是另一个 `memory-content:mcp:<提议>:<批次>`，没有回写 `content_ref`）。因此 committed 行的正文引用永久保留。
- 证据（亲自读到）：

```sql
content_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
...
memory_id TEXT REFERENCES memory_records(id) ON DELETE SET NULL,
```

```ts
WHERE owner_id = ? AND agent_id = ? AND status IN ('rejected', 'superseded')
  AND content_ref IS NOT NULL AND decided_at < ?
```

  记忆被 governed deletion 彻底删除时，删除器只收集 `memory_records.content_ref` 等引用；提议的 `content_ref` 不在删除清单里，且 `#payloadReferenced` 会看到提议仍引用它（`sqlite-governed-deletion.ts:1110`、`1119-1135`），直接删 payload 也会被 `CONFLICT` 拒绝（`sqlite-governed-deletion.ts:898-904`）。结果：记忆删了，外部 agent 送来的原文仍以加密副本留在库里，且没有任何 API 能清掉。
- 建议：把 `status = 'committed' AND memory_id IS NULL`（记忆已被硬删）纳入过期清理；或在永久删除记忆时同步处理对应提议（清 `content_ref` 或标 `superseded`）。至少要在 ADR/导出说明里写明「已保存提议的原文不随记忆删除」。

### 3. 中：撤销批次会把「挂到已有记忆」的提议重新打开，可能出现「记忆还在、同样正文却被拒绝过」

- 文件：`apps/agent-service/src/production-mcp-memory-writer.ts:448-455`、`apps/agent-service/src/production-memory-control.ts:1073-1077`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:351-370`
- 问题：`keep()` 命中已有 active 记忆时，`memoryId` 是那条已有记忆的 id（`production-mcp-memory-writer.ts:275-283,345-354`）。`undoBatch` 只 trash `memory:pcm:` 开头且以 `:<batchId>` 结尾的 id，于是挂到已有记忆的提议不会被 trash，但 `reopenBatch` 仍会把它改成 pending。
- 证据（亲自读到）：

```ts
for (const { memoryId } of members)
  if (
    memoryId?.startsWith(EXTERNAL_PROPOSAL_MEMORY_PREFIX) &&
    memoryId.endsWith(`:${batchId}`)
  )
    await trash(memoryId);
...
return this.#options.proposals.reopenBatch({ ...this.#scope(), batchId });
```

  后果：同一条正文既在 active 记忆里，又出现在待确认列表；主人若把它拒绝，已有记忆仍在，但以后同样的正文再提会命中 rejected 行，回「主人没有同意」。这与「已保存」事实矛盾。
- 建议：撤销时只重新打开本批**确实新建并已移入回收站**的提议；挂到已有记忆的提议保持 committed（或单独标记），并补测试。

### 4. 中低：固定编号的作用域不含客户端，两个客户端用同一个 key 会互相覆盖

- 文件：`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:52-57`、`sqlite-external-memory-proposal-operations.ts:145-160`
- 问题：key 表主键是 `(owner_id, agent_id, source_key)`，`claim` 也只按 owner/agent/source_key 查找，不区分 `client`。Muse 和 Claude Code 都用 `memory/coffee` 这类普通 key 时，后提交的会把对方仍需要的待确认正文标成 `superseded`。
- 证据（亲自读到）：

```sql
CREATE TABLE external_memory_proposal_keys (
  owner_id TEXT NOT NULL ...,
  agent_id TEXT NOT NULL ...,
  source_key TEXT NOT NULL ...,
  proposal_id TEXT NOT NULL ...,
  PRIMARY KEY (owner_id, agent_id, source_key)
)
```

  ADR 0228:68 的依据是「一个客户端更新自己的内容，不能把另一个客户端还在用的那条挤掉」，但只有「不同 key 指向同一提议」被保护，同一 key 的跨客户端冲突没有保护。
- 建议：把 `client` 纳入 key 标识（或要求 key 由服务端加上客户端前缀），并在 ADR 里明确 key 是全局还是每客户端命名空间。

### 5. 低中：`respond` 全部条目都因「已在别的批次决定」被跳过时，仍返回成功

- 文件：`apps/agent-service/src/production-mcp-memory-writer.ts:472-504`、`apps/agent-service/src/production-memory-control.ts:1061-1067`
- 问题：`proposal.batchId === batchId` 计入 `decided`；`status !== 'pending'` 且批次不同只把 `failed++`，不设置 `firstError`。最后 `decided === 0 && firstError === undefined` 时直接返回 `{decided:0, failed:N}`；`#externalRespond` 完全忽略返回值，仍返回成功。
- 证据（亲自读到）：

```ts
if (proposal.status !== "pending") {
  failed += 1;
  continue;
}
...
if (decided === 0 && firstError !== undefined) throw firstError;
return { decided, failed };
```

```ts
await writer.respond(command.payload.items, batchId);
return { resultRef: batchId, replayed: false };
```

  与 ADR「全部失败时回第一条的错误」不一致：主人点「保存所选」，实际一条都没保存，网页却当成功。
- 建议：`decided === 0 && failed > 0` 时也返回可识别的失败（或把 `{decided, failed}` 放进命令结果，调用方据此报错）。

### 6. 低：`decide` 允许 `committed` 且 `memoryId = null` 的组合

- 文件：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:299-304`、迁移 `0093:25`
- 问题：只拒绝「rejected 带 memoryId」，没有要求「committed 必须带 memoryId」；数据库 CHECK `memory_id IS NULL OR status = 'committed'` 也不禁止 committed + NULL。写入器目前总是传 memoryId，但端口层可被直接调用。
- 证据（亲自读到）：

```ts
if (
  !valid(input.decidedAt) ||
  !(["committed", "rejected"] as readonly string[]).includes(input.status) ||
  (input.status === "rejected" && input.memoryId !== null)
)
```

- 建议：加 `input.status === "committed" && input.memoryId === null` 的拒绝，并在迁移 CHECK 里补 `(status = 'committed') = (memory_id IS NOT NULL)`（或等价约束）。

### 7. 低：写入器先存 payload，再做存储层校验，坏输入会留下无人引用的加密 payload

- 文件：`apps/agent-service/src/production-mcp-memory-writer.ts:194-195`；`sqlite-external-memory-proposal-operations.ts:124-137`
- 问题：`#storeText(contentRef, ...)` 在 `proposals.submit(...)` 之前执行；写入器只校验正文/密钥/key，`category`、`client`、`normalization` 等由存储层在 submit 里校验。直接调用写入器传入非法 `category`/`client` 时，存储层抛 `PORT_INVALID_OPERATION`，但 payload 已经落库且没有清理。
- 证据（亲自读到）：

```ts
await this.#storeText(contentRef, text, dataClassification);
const submitted = await this.#options.proposals.submit({ ... });
```

- 建议：在写入器里把存储层会校验的字段先校验一遍，或在 submit 失败时删除本次新建的 payload（需区分「本来已存在」）。

### 8. 低：`undoBatch` 用 id 后缀判断归属，属于脆弱匹配

- 文件：`apps/agent-service/src/production-mcp-memory-writer.ts:448-453`
- 问题：`startsWith("memory:mcp:") && endsWith(":" + batchId)` 只是字符串启发式。客户端确认框保存的记忆 id 是 `memory:mcp:<proposalId>`，若 proposalId 以 `:<batchId>` 结尾就会被误认成本批次的记忆。当前 proposalId 是服务端 `randomUUID()`，不可控，所以风险低；但这是隐式约定。
- 建议：用提议表里的 `batchId` + 精确的 `externalProposalMemoryId(proposal.id, batchId)` 生成 id 再比较，不要用后缀匹配。

### 9. 低：把「敏感」提议挂到已有的非敏感记忆时，不提升记忆分级

- 文件：`apps/agent-service/src/production-mcp-memory-writer.ts:274-283`
- 问题：`same` 只检查目标记忆是否 active，不比较 `dataClassification`；随后直接 `#commit(proposal, same, input)`。若正文相同但既有记忆是 `private`，而这次提议按 health/finance 被判为 `sensitive`，确认后记忆仍是 private，不符合 ADR 0228「原来是敏感的不会变低」（第 87 行附近）的精神。
- 证据（亲自读到）：

```ts
const same =
  linked && (await this.#options.state.read(linked as MemoryId))?.status === "active"
    ? linked
    : undefined;
if (same) {
  await this.#commit(proposal, same, input);
  return same;
}
```

- 建议：命中已有记忆时比较分级，必要时先 `revise` 提升到 sensitive；或拒绝挂接并新建。

## 读代码证实 vs 推测

已读代码证实：

- 第 1、2、3、5、6、7、8、9 条的代码路径与引用行。
- 迁移 CHECK 与代码写入的状态组合一致：`decide` 写 committed/rejected、`reopenBatch` 写 pending、`claim` 写 superseded，均为合法组合；`dropDiscardedText` 把 rejected/superseded 的 `content_ref` 置 NULL 也满足 `content_ref IS NOT NULL OR status IN ('rejected','superseded')`。
- 待确认正文只写入 `payloads`，不写 `memory_records`/索引；`find_memories`/`today_context` 只读记忆与索引，未发现读提议表的路径。
- governed deletion 遇到提议的 `content_ref` 不会因 RESTRICT 抛错，而是通过 `#payloadReferenced` 跳过删除（所以「挡住删除流程」不成立，但「删不掉」成立，见第 2 条）。

推测/需确认：

- 第 4 条是否构成实际问题，取决于产品是否规定 key 必须带客户端前缀；代码和 ADR 都没有强制。
- 第 2 条最终影响取决于产品是否把「提议原文」视为独立于记忆的保留数据；ADR 未说明。
- 第 3 条的 UI 影响取决于下一个 PR 的撤销入口是否允许撤销含「挂到已有记忆」的批次。
- casebook 里的「34 条通过 / 反向改坏分别失败 1、7、1 条」未核实（本次不能运行测试）。

## 侧重检查（错误路径、不合规范输入、安全、资源耗尽、不可撤销操作、文档一致性）

- 错误路径：`submit` 的校验顺序有「先落 payload 后校验」缺口（第 7 条）；`respond` 全部跳过时静默成功（第 5 条）；`undoBatch` 中途 trash 失败会留下「部分记忆已进回收站、提议仍未 reopen」的半完成状态，但重试可收敛（未单列）。
- 不合规范/不可信输入：正文和 key 都做了 NFC、不可见字符替换、折叠空白、trim、长度和机器密钥检查；MCP 入口与写入器双重校验；`subjectRef` 超长会退化为 SHA-256；`client` 受正则限制到 64。存储层在 round 5 补了 `subjectRef/client/normalization/source_key/分类/分级` 校验，方向正确。不足：`subjectRef` 只校验长度，不校验控制字符（不展示，风险低）；`key` 的跨客户端命名空间未隔离（第 4 条）。
- 安全：待确认正文不进任何模型可读路径，已核对写路径和读取路径；编辑正文也会做机器密钥扫描。未发现把 pending 正文写进决策记录或导出的路径；导出只计数。
- 资源耗尽：待确认永不过期，每次最多 50 条、每条最多 2000 字，理论上可由有写权限的客户端持续堆积行和 payload；只有 MCP 入口的限流，没有待确认总数上限。属于 ADR 已知取舍，但建议至少监控/限流。
- 不可撤销操作：`superseded` 无法从界面恢复，只保留正文 30 天；跨客户端 key 冲突会让一个客户端的待确认被另一个客户端替换（第 4 条）。`undo` 只移入回收站，仍可恢复，风险可控。
- 文档一致性：ADR 0228 的 key 表语义与代码在「命中已保存/已拒绝时 key 不改指」处不一致（第 1 条）；工具说明「同一个 key 带来新内容时，还没确认的旧内容会被替换」在同一路径下也不成立。ADR 0225/0228 的分级、批次号、去重、30 天清理、决策记录过滤整体与代码一致。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会（针对 Himawari 自己发给模型的请求）。本次改动只在：

- MCP 外部工具说明/结果文字（`packages/prompt-catalog/src/tools.ts`，`usedBy` 是 `production-mcp-read.ts`，只发给外部客户端）；
- 网页 `memory.overview.snapshot`、每日回顾过滤、数据导出计数、迁移/存储；
- 没有改动 Himawari 的系统提示组装、工具定义组装、历史保存或出口遮盖代码。

因此 Himawari 发给模型的内容仍然「只在末尾追加」，本轮新增的 `receivedAt`/`proposalId` 只出现在 MCP 工具回执或网页数据里，不进入 Himawari 的系统提示/工具定义/历史。需要说明：对**外部 MCP 客户端自己的模型**，`propose_memory` 的描述改了、新增了 `propose_memories`，这些客户端的工具定义会变一次；但这是外部客户端的缓存，且文字是静态的、没有每轮变化的值。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

没有发现影响模型请求字节的新不确定性：

- 正文有确定的规范化（NFC → 不可见字符替换为空格 → 折叠空格 → trim），摘要和 `memory-content:mcp-proposal:<作用域、分级、摘要>` 都是确定函数，不含时间。
- 批次号是幂等键的 SHA-256 前 32 位，确定。
- 列表都有确定排序：`listPending` 按 `received_at, rowid`；`listBatches` 按 `MAX(decided_at) DESC, batch_id`；替换候选按 `received_at, id`。
- `receivedAt`/`decidedAt` 是时间字段，但只作为数据/回执；同一条提议重发返回原行的 `receivedAt`，回执字节相同。

一个非模型字节层面的小不确定性：`#activeDigests` 遇到多条 active 记忆正文相同的时候，保留 `listActive` 返回顺序里的第一条，理论上挂接目标可能随数据库返回顺序变化；这不影响发给模型的字节，但会影响「挂到哪条记忆」。另有既有时间字段 `today_context.now`、`generatedAt`，不属于本改动。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，且覆盖面不错：

- `test/integration/mcp-write.test.ts` 覆盖：不支持确认框、取消、unseen、拒绝后再提、批量 50/51、同 key 替换、跨 key 保留、待确认不进记忆/索引、30 天清理、敏感升级、网页保存/改字/拒绝/撤销、和已有记忆合并、客户端确认与网页决定竞态、回收站同号记忆、写作者自身长度/密钥校验。
- 新增第 1760 行的跨 key 用例：去掉 key 表、回到只按 `source_key` 列的旧逻辑时必然失败（旧逻辑会在第一个 key 换正文时把仍被第二个 key 指着的行标 superseded），是有效的反向用例。
- 新增第 1784 行的写作者校验用例：去掉写入器的长度/密钥检查会失败。

缺口（反向用例不会失败的地方）：

- round 5 新增的**存储层**字段校验（`subjectRef/client/normalization/source_key/分类/分级`）没有直接测试；删掉这些校验，现有测试不会失败。
- 没有测试「同一个 key 带来的正文命中已保存/已拒绝行时，旧 pending 必须被替换、key 必须改指」——也就是第 1 条的问题。
- 没有测试「一批里所有条目都已在别的批次决定」时 `respond` 的返回（第 5 条）。
- 没有测试第 2 条的「记忆硬删除后 committed 提议的 payload 清理」。
- casebook 里「34 条通过、反向改坏 1/7/1 条失败」本次无法运行验证，标「未核实」。

### 4. 每个新值/字段的两端校验是否都能接受？

已逐个核对（生产端 → 使用端）：

- `proposalId`：生产端 `randomUUID()` 36 字；存储层限 40；DB `1..128`；记忆 id `memory:mcp:<id>[:<batch>]` ≤ 90；决策记录 id ≤ 110；`machineString` 允许 `-`。两端都接受。注意数据库上限 128 比代码 40 宽，代码更严，安全。
- `batchId`：`batch-` + 32 hex = 38；DB `1..128`；`machineString` 1..128；记忆 id/决策记录 id 都远小于 128。通过。
- `sourceKey`：MCP schema `maxLength: 200`（码点）、写入器 `[...key].length ≤ 200`（码点）、存储 `within(...,200)`、DB `length(source_key) BETWEEN 1 AND 200`（码点）、key 表同样 200。通过。
- `subjectRef`：写入器按 UTF-16 长度 1..128 保留，否则存 `sha256:<64>`（71 字）；存储 `within(...,128)`；DB 1..128。非 ASCII 只会更早触发哈希，不会出现存储层拒绝。
- `client`：`clientNameOf` 正则最多 64、ASCII；存储 1..64；DB 1..64；网页契约 `boundedString(64)`。通过。
- `text`：写入器 `text.length ≤ 2000`（UTF-16）；网页契约 `boundedString(2000)` 同样按 UTF-16；摘要/内容引用确定。通过。
- `category`：写入器 9 类（无 `rule`）、存储 `CATEGORIES`、DB CHECK、网页枚举 `MEMORY_EXTERNAL_CATEGORY_NAMES`（`MEMORY_CATEGORY_NAMES` 去掉 `rule`）一致。
- `dataClassification`：`private/sensitive`，写入器、存储、DB、网页枚举一致。
- `contentRef`：`memory-content:mcp-proposal:<64 hex>` 约 91 字、`memory-content:mcp:<40>:<38>` 约 98 字；`payloads.ref` 无长度约束，记忆 `content_ref` 引用也接受。
- `memoryId`：`memory:mcp:<proposalId>[:batchId]` ≤ 90；`memoryString` 1..128 接受；决策记录 `subject_ref` ≤ 256 接受。
- `decisionLedger` 的 `reasonCode`：`mcp_proposal_pending/superseded` 等 ≤ 23 字，DB CHECK 1..64 通过；`id` ≤ 110 字，DB 1..128 通过。
- 时间：`receivedAt/decidedAt` 由 `clock.now()` 产生，`valid()` 要求与 `toISOString()` 完全一致；网页 `timestamp` 同样要求 canonical UTC 毫秒，一致。
- `superseded_by`/`memory_id` 外键：`ON DELETE SET NULL`，与 DB CHECK 兼容。
- 不一致/缺口：`decide` 允许 committed + `memoryId = null`（第 6 条）；key 表主键少 `client`（第 4 条）；committed 提议的 `content_ref` 没有清理路径（第 2 条）。这些不是「两端校验长度不一致」，而是语义/生命周期上的两端不匹配，建议按上面对应条目修。
