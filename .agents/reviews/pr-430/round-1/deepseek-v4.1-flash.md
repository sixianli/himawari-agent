## 结论

未发现会破坏正常路径的高严重度缺陷。改动与作者描述基本一致；主要问题是**“正文已清的旧拒绝条目移出批次”只覆盖本次同时清正文的行**，对已有的 `content_ref IS NULL + batch_id 非空` 行无效，而这条状态可以通过数据导入进入库中。另有几处反向用例覆盖缺口，以及一个基于摘要删除的信任边界问题。

---

## 问题（按严重度）

### 1. 中：已清正文的旧拒绝条目不会被清掉 batch_id，仍会出现在批次里

【读代码证实】

- `packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:483-500`

```sql
SELECT id, content_ref AS contentRef FROM external_memory_proposals
WHERE owner_id = ? AND agent_id = ? AND status IN ('rejected','superseded')
  AND content_ref IS NOT NULL AND decided_at < ?
...
const clear = this.database.prepare(
  "UPDATE external_memory_proposals SET content_ref = NULL, batch_id = NULL WHERE id = ?",
);
...
for (const row of rows) clear.run(row.id);
```

只处理 `content_ref IS NOT NULL` 的行。对于已经处于 `content_ref IS NULL, batch_id IS NOT NULL` 的拒绝条目，永远不会进入 `rows`，因此它的 `batch_id` 不会被清掉。

这条状态不是纯理论：

- `packages/persistence-sqlite/src/data-export/import.ts:764-770` 在导入时按 `item.batchId` 直接写入，不管 `content` 是否为 `null`。
- `packages/persistence-sqlite/src/data-export/verify.ts:120-133` 允许“拒绝且无正文”以及“拒绝且属于一批”。
- `packages/persistence-sqlite/src/data-export/export.ts:556-559` 导出拒绝条目时原样保留 `batchId`。

因此，导入一份旧版本导出的文件（或恢复一份旧备份）就能重新造出“正文已清但批次号还在”的行。此后：

- `listBatches` 仍会列出这一批；
- `undoBatch` 仍会看到它（`contentRef === null`，最终 `reopenBatch` 只是 detach，返回 `[]` 而不是 `undefined`）；
- 如果同批还有可恢复条目，这个不可恢复的拒绝条目仍会被计入“不要 Y 条”。

这与 ADR 0253 决定 4 的“整批都没有可恢复的条目时，这一批不再列出”不一致。作者“P5-3 尚未上线，生产库里没有旧行”的假设无法从代码核实，而且导入路径本身可以产生这种行。

建议：增加一条只清批次号的更新，例如：

```sql
UPDATE external_memory_proposals
SET batch_id = NULL
WHERE owner_id = ? AND agent_id = ? AND status = 'rejected'
  AND batch_id IS NOT NULL AND content_ref IS NULL AND decided_at < ?
```

或在导入/校验阶段拒绝或规范化“拒绝 + 无正文 + 有批次号”的组合。并补一条“导入旧导出后过期批次不再列出”的反向测试。

### 2. 低：受限记忆删除测试没有覆盖 keys 级联和 superseded_by 置空

【读代码证实】

- `test/integration/sqlite-governed-deletion.test.ts:646-671` 只插入了 `external_memory_proposal_unkeyed`，删完后只断言 unkeyed 剩下 `proposal-other`。
- 没有插入 `external_memory_proposal_keys` 行，也没有让任何提议的 `superseded_by` 指向被删除的提议。
- ADR 0253 前提 2 明确依赖 `migrations/0093_external_memory_proposals.sql:57` 的 keys `ON DELETE CASCADE` 和 `:23` 的 `superseded_by ... ON DELETE SET NULL`（unkeyed 在 `:65`）。

所以作者声称的三个级联/置空行为里，只有 unkeyed 被自动验证。虽然我读 schema 确认这三个外键定义都存在，且删除连接确实打开了 `foreign_keys = ON`（`sqlite-governed-deletion.ts:662`），但测试缺两块。

建议补上 keys 行和 `superseded_by` 指向被删提议的用例，分别断言 keys 被级联删除、幸存提议的 `superseded_by` 变为 `NULL`。

### 3. 低：原话反向测试没有检查密封文件

【读代码证实】

- 新增测试 `test/integration/data-export-external-proposals.test.ts:396-398`：

```ts
for (const [path, bytes] of files)
  if (path !== SEALED_FILE) expect(decoder.decode(bytes)).not.toContain("主人原话");
```

只检查非密封文件。相邻的旧反向测试 `:358-362` 会额外 `unsealJson` 后检查 `JSON.stringify(sealed)`。

当前实现确实在生成 `originals`/密封文件之前就过滤掉了受限提议（`export.ts:128` 在 `proposalLines` 之前），所以现在没有泄漏。但测试没有真正证明“封存文件里也没有”，未来若有人把过滤挪到 `originals` 之后，这条测试不会失败。

建议像相邻测试一样检查密封文件内容。

### 4. 低（推测）：按摘要删除信任导入数据里的 `text_sha256`

【读代码证实 + 推测影响】

- `packages/persistence-sqlite/src/sqlite-governed-deletion.ts:899-902` 按 `text_sha256` 匹配并删除提议：
  ```sql
  WHERE owner_id = @ownerId AND agent_id = @agentId AND text_sha256 IN (
    SELECT text_sha256 FROM external_memory_proposals
    WHERE owner_id = @ownerId AND agent_id = @agentId AND memory_id = @memoryId)
  ```
- 导入路径 `data-export/import.ts:297-320` 直接采用导出文件里的 `textSha256`，没有用正文重新计算；`verify.ts` 只校验格式。

影响是推测性的：如果导入一份被构造过的导出文件，把某个无关提议的 `textSha256` 写成受限记忆关联提议的摘要，那么删除受限记忆时，这条无关提议会被一并删除，连同它的正文 payload。导入是主人发起的操作，所以危害有限，但这是“不可撤销删除”依赖外部输入的摘要值。

建议：导入时用正文重新计算摘要并核对，或在删除时对候选提议解密正文再比较（后者正是 ADR 放弃的同步/异步权衡，可只用于导入时校验）。

### 5. 残余风险（ADR 已明确接受，不作为缺陷）

受限记忆删除后，**与记忆正文或原话同文、但没有保存进这条记忆的提议**不会被删除，下一次导出会导出它们。ADR 0253 的“放弃的做法”里已明确接受这一点。如果“删除后不能留下能试出原文的痕迹”是硬目标，这个残余风险需要另行处理；当前代码与 ADR 的决定一致。

---

## 推测与未核实

- 未实际运行测试、类型检查或 `npm run check`（工具限制只允许 git 只读命令）。因此“去掉源码改动后 4 条测试失败”是按代码路径推演，不是实测结果。
- “P5-3 尚未上线，生产库里没有旧行”无法从仓库核实。代码层面能确认的是：旧行不会被新逻辑修复，且导入可以造出旧行。
- 我没有追踪完整的模型请求组装代码；只能确认本 diff 触及的文件都在持久化、数据导出、删除和提议存储层，不在提示词/工具/历史组装路径。

---

## 侧重检查

- **错误路径**：受限删除在事务内先删提议再删记忆，`foreign_keys = ON`；失败会整体回滚。删除文件在事务提交后执行，失败走 incomplete/retry；重试时记忆已不存在但提议已在首次事务中删除，未发现新的半删除路径。
- **不合规范/不可信输入**：关注了导入的提议数据（问题 1、4）。`externalProposalProblem` 允许“拒绝 + 无正文 + 有批次号”，导致过期清理无法覆盖；导入不重算摘要。
- **安全/泄漏**：检查了受限记忆正文、历史版本、原话、提议正文、keys/unkeyed、替换链接、密封文件。实现过滤顺序正确；测试对密封文件的覆盖不足。删除后非关联同文提议仍可导出，ADR 已接受。
- **资源耗尽**：受限删除对每个匹配提议逐条 DELETE，并逐条收集 payload；这是既有模式，未见新的无界循环或重复解密。大量同摘要提议时工作量为线性，尚未发现更严重问题。
- **不可撤销操作**：删除提议和 payload 是永久操作；没有针对提议 ID 的 tombstone，但决策账本不保存提议正文，删掉的是专用表数据。主要风险是问题 1（不可恢复批次仍显示）和问题 4（摘要信任导致误删）。
- **文档/代码一致性**：ADR 0253 的决定 1-4 与代码基本一致；决定 4 在“旧行/导入行”这一路径上没有被完全实现。ADR 前提 2 的三个外键定义与迁移文件一致，但测试只覆盖 unkeyed。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。这个 diff 没有改系统提示、工具定义、历史消息、遮盖或请求组装代码；改动集中在 `data-export`、`sqlite-governed-deletion`、提议存储和测试。删除记忆/提议会改变**后续**请求可选的上下文数据，但本 PR 没有改“只在末尾追加、每轮变化值在最后一条消息”的机制。就本 diff 而言，没有发现对已发送前缀的改写或重排。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

本次改动不在模型请求路径上，因此不影响模型看到的文字字节。导出结果里新增/变化的值（过滤后的提议集合、占位编号、`batchId = NULL`、受限时 `supersededBy = NULL`）都由数据库行和固定 `ORDER BY` 决定；同一快照下结果是确定的。占位编号会随导出集合变化而变化，但这是数据变化导致的预期变化，不是“同一请求里依赖前后文的遮盖”或带时间的字段。快照中新增的 quote ref 也只用于集合和摘要比较，不引入时间或无序集合。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有检查：`data-export-external-proposals` 两条新增反向用例、`sqlite-governed-deletion` 一条新增用例、`mcp-write` 一条既有用例的断言调整。

按代码推演：

- 原话用例在没有 `snapshot.ts` 的 quote 分支时，提议不会被排除，会失败；
- 占位编号用例在没有把过滤挪到扫描之前时，`[已扣留:9]` 会把最大编号抬到 9，期望的 `[已扣留:1]` 会失败；
- 受限删除用例在旧代码下会改成 rejected 而不是 DELETE，剩余提议断言会失败；
- mcp-write 用例在旧代码下 `listBatches` 不会为空、`undoBatch` 返回 `[]` 而非 `undefined`，会失败。

所以这 4 条按代码路径会失败。但覆盖不完整：keys 级联、`superseded_by` 置空、以及“导入旧导出后过期批次仍列出”的兼容场景没有自动检查。以上均为静态推演，未实际运行。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

逐个核对如下：

- **被物理删除的提议行**：`external_memory_proposal_keys`、`external_memory_proposal_unkeyed` 级联删除；`superseded_by` 置空。我核对了全部迁移，引用 `external_memory_proposals` 的外键只在 `0093`，且删除连接确实开启 `foreign_keys`。导出/导入允许 `supersededBy = null`（`verify.ts:126` 只在非空时要求 superseded；`import.ts:768-770` 对不存在的目标置空）。决策账本没有指向提议正文的外键。可接受。
- **`batch_id = NULL`**：`listBatches`、`listBatch`、`reopenBatch`、导出（`nullable`）、导入、网页的批次数和撤销按钮都能接受 null。问题在于旧行/导入行不会走到这个值，见问题 1。
- **`restrictedMemoryTexts` 新增 quote_ref 行**：消费者只有 `export.ts:92` 的 `restrictedRefs` 和 `:116-119` 的摘要集合，二者都只读 `content_ref` 列；`snapshot.payloads` 的 refs 收集也包含它，所以 quote payload 会被读取。列名通过 UNION 仍为 `content_ref`，消费端可接受。
- **过滤后的 `externalProposalKeys`/`externalProposalUnkeyed`**：只用于占位编号扫描；后续 `proposalKeys`/`proposalUnkeyed` 仍按导出的提议 ID 查找，排除的提议不会被引用。可接受。
- **占位编号变化**：仍满足 `[已扣留:N]` 的格式和长度限制，导出/导入 schema 接受。可接受。
- **幸存 superseded 提议的 `supersededBy = NULL`**：schema、导出、导入、校验均允许。可接受。

综上，除问题 1 的旧数据/导入路径外，改动产生或修改的值在现有使用点都能被接受。
