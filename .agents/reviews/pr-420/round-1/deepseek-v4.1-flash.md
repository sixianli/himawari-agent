已对比 `44a0e332…fed6ae92`，下面只依据我亲自读到的代码和 `git diff`。我没有运行测试（工具只允许 git 只读命令），所以“测试会不会失败”部分为静态核对。

## 一、读代码证实的问题（按严重度）

### 1.【中】被扣留的提议摘要重复时，校验放过、导入在 INSERT 时才失败

文件：`packages/persistence-sqlite/src/data-export/verify.ts:430-435`，`packages/persistence-sqlite/src/data-export/import.ts:296-300`

代码：

```ts
unique(
  externalProposals.flatMap(({ status, textSha256 }) =>
    status === "superseded" || textSha256 === null ? [] : [textSha256],
  ),
  "其他 agent 提议的正文摘要",
);
```

导入时摘要从封存文件恢复：

```ts
const digest = withheld
  ? sealedText(externalProposalDigestKey(proposal.id))
  : proposal.textSha256;
```

但迁移里索引是：

```sql
CREATE UNIQUE INDEX external_memory_proposals_text_index
  ON external_memory_proposals(owner_id, agent_id, text_sha256)
  WHERE status <> 'superseded';
```

问题：两条非 superseded 的提议如果正文都被扣留，`textSha256` 都是 `null`，校验会完全跳过重复摘要检查；导入从封存文件恢复出相同摘要后，第二条 INSERT 触发 UNIQUE 约束。`dryRun` 也会先通过，真实导入才报数据库错误，而且不是 `DataExportError`。这与 ADR 0246 决定 8“没被替换的提议摘要不重复、任何一项不符整份拒绝”不一致，也是问题 3 所说的“通过校验却在 INSERT 时失败”。

建议：在解析封存摘要之后、进入事务之前，用恢复后的摘要再做一次唯一性检查（排除 superseded），并把摘要十六进制校验也放在同一阶段；补一条“两条扣留正文共用摘要”的反向测试。

### 2.【中】导入产生的“已保存但没有记忆链接”的提议，撤销一批时不会被重新打开

文件：`packages/persistence-sqlite/src/data-export/export.ts:492`、`import.ts:704-708`、`apps/agent-service/src/production-mcp-memory-writer.ts:473-481`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:452-457`

导出会丢掉不存在于导出里的记忆链接：

```ts
memoryId: keepMemoryRef(optionalString(row["memory_id"])),
```

导入会原样保留批次号，但记忆链接可能变成 `null`：

```ts
item.batchId,
keptMemoryLink(item.memoryId),
```

撤销时只重新打开“记忆编号正好是这条提议新建的记忆”的已保存项：

```ts
if (
  member.status === "committed" &&
  member.memoryId === externalProposalMemoryId(member.id, batchId)
) {
  await trash(member.memoryId);
  trashed.push(member.memoryId);
  reopen.push(member.id);
}
```

其他成员在 `reopenBatch(complete: true)` 里只被 `detach`：

```ts
if (wanted.has(member.id) && member.contentRef !== null) {
  reopen.run(...);
} else if (input.complete) detach.run(...);
```

结果：`memoryId = null` 的已保存提议既不会 `trash` 也不会 `reopen`，撤销后只是把 `batch_id` 清空；它仍然是 `committed`，既不显示在待确认里，也不再显示在“最近处理的几批”里。用户点了“撤销这一批”，这一条实际上没有恢复。新增测试 `test/integration/data-export-external-proposals.test.ts:306-333` 正好制造了这种行（`proposal-restricted-link`，`batch-2`，受限记忆不导出），但没有测撤销。后续 `submit` 还会把它当作“已保存”，拒绝同一段文字再次提议，尽管对应的记忆并不存在。

建议：导出/导入把 `memoryId` 置空时，相应地把 `batchId` 也置空（使这一条不进入可撤销批次），或者让 `undoBatch`/`reopenBatch` 安全地重新打开“content 存在、memoryId 为 null”的已保存提议；并补一条“撤销导入批次”的测试。

### 3.【中低】导入没有校验 `receivedAt` / `decidedAt` 的格式，能通过 Schema 和 verify，却在数据库 CHECK 时失败

文件：`packages/persistence-sqlite/src/data-export/schemas.ts:48,186-187`、`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:19-20`、`import.ts:702-703`

Schema 里的时间戳只检查长度：

```ts
const timestamp: JsonSchema = { type: "string", minLength: 20, maxLength: 40 };
```

数据库要求具体格式：

```sql
received_at TEXT NOT NULL CHECK (received_at GLOB '????-??-??T??:??:??.???Z'),
decided_at TEXT CHECK (decided_at IS NULL OR decided_at GLOB '????-??-??T??:??:??.???Z'),
```

`externalProposalProblem` 和 `parsePortable` 都没有补格式检查，导入直接把 `item.receivedAt` / `item.decidedAt` 写入。一个 20 到 40 字符的任意字符串可以通过解析和 `dryRun`，真实导入才在数据库 CHECK 上失败。

建议：在 `verify.ts` 或 `externalProposalProblem` 中加入与 `sqlite-external-memory-proposal-operations.ts:43-46` 相同的 ISO 严格校验（`new Date(value).toISOString() === value`），并补反向测试。

### 4.【低】短文字占位编号没有扫描新增的 external 表，可能生成无法导回的导出文件

文件：`packages/persistence-sqlite/src/data-export/export.ts:133-156,481-500`

`existingPlaceholderMax` 只扫描这些数组：

```ts
const existingPlaceholderMax = (() => {
  let highest = 0;
  const scanned = JSON.stringify([
    snapshot.entities,
    snapshot.aliases,
    snapshot.provenance,
    snapshot.people,
    snapshot.decisions,
    snapshot.signals,
  ]);
```

但新增的 `subjectRef`、`client`、`sourceKey`、`keys`、`unkeyedClients` 都会走 `safeString`，而它们所在的 `snapshot.externalProposals` / `externalProposalKeys` / `externalProposalUnkeyed` 不在扫描列表里。

正常情况下 `safeString` 对同一值给同一编号、不同值给不同编号，不会让同一客户端的两个不同编号变成同一个占位。但导入会保留占位字符串（例如 `external_memory_proposal_keys.source_key` 里已有 `[已扣留:1]`）。之后再导出时，因为扫描不到 external 表，`existingPlaceholderMax` 可能仍是 0；一个新的机密编号会被分配成 `[已扣留:1]`，与已有值撞成相同 `(client, sourceKey)`，违反导入校验里的固定编号唯一性。`buildPortableExport` 本身不调用 `parsePortable`/`verifyIntegrity`，所以会“导出成功但导不回去”。

新增测试里 `data-export.test.ts:793-812` 只覆盖了实体名的占位续号，没有覆盖 external 的客户端名/固定编号。

建议：把 `externalProposals`、`externalProposalKeys`、`externalProposalUnkeyed` 也纳入 `existingPlaceholderMax` 的扫描；最好再在 `buildPortableExport` 返回前跑一次结构校验，或至少补一条 external 短文字的导入再导出/冲突测试。

### 5.【低】一次发送全部失败时，页面会继续显示上一批的成功结果

文件：`apps/control-center/src/components/external-proposals.tsx:115-121,18-37`

```ts
const answer = async (items: readonly ExternalDecision[]) => {
  const batchId = await memory.externalRespond(items);
  if (batchId === null) return;
  setSent({ batchId, count: items.length });
  ...
};
```

如果上一批成功、`sent` 已有值，随后新一批全部失败（例如都被别处处理、后端返回 409），`batchId === null` 直接返回，`sent` 不会被清空。`externalResult(sent, external.batches)` 会继续按旧批次显示“这一批保存了 X 条……”，看起来像新一批成功了。测试没有覆盖“成功后再次失败”。

建议：在 `answer` 开始时先 `setSent(null)`，或在失败分支清掉 `sent`；补一条失败在成功之后的浏览器/单元测试。

### 6.【低】提议正文的分类没有和提议自身的分类做交叉校验

文件：`packages/persistence-sqlite/src/data-export/schemas.ts:61-72,184,191`、`import.ts:150-163`

提议自身的分类只能是：

```ts
classification: enumOf(["private", "sensitive"]),
```

但 `content` 使用 `EXPORTED_TEXT_SCHEMA`，允许：

```ts
const CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"] as const;
```

导入时直接用正文里的分类存 payload：

```ts
dataClassification: text.classification as PayloadRecord["dataClassification"],
```

所以一个手工构造的 v3 文件可以把一条“sensitive”的提议正文标成 `public`/`restricted` 导入。后续 `keep` 保存记忆时仍使用提议自身的分类，因此最终记忆分类不一定被降低；但 payload 的静态分类与提议不一致，属于分类标签校验缺口。影响需要在运行中确认，先标为推测。

建议：在 `externalProposalProblem` 中要求 `content.classification === proposal.classification`（至少要求 `content.classification` 只能是 `private`/`sensitive`）。

## 二、推测与未核实

- 导入没有验证 `textSha256` 是否等于正文的规范化摘要（`import.ts:309-313` 只检查 64 位十六进制）。手工文件可以写入任意摘要，影响后续 `submit` 的去重语义；但这不是数据库约束，ADR 0246 也没明确要求，属于加固建议。
- 目标库“空库”检查只列了 `external_memory_proposals`，没有列 `external_memory_proposal_keys` / `_unkeyed`（`import.ts:78-90`）。正常外键级联下 proposals 为空时它们也应为空；只有跨 owner/agent 的异常数据才可能冲突，影响有限。
- 我没有运行 `check:prompt-prefix`、`check:data-export`、浏览器测试和布局检查，因此“实际测试通过”未核实；下面的测试覆盖结论来自代码和用例名。

## 三、侧重检查

- **不可信输入 / 错误路径**：逐项对照了 `0093_external_memory_proposals.sql` 的 CHECK 与唯一索引。发现时间格式和“扣留摘要重复”两个缺口；`supersededBy`、`memoryId`、`memoryId` 状态搭配、`batchId` 状态搭配、`content` 与 `withheld` 搭配、keys/unkeyed 主键都有对应校验或导入处理。
- **安全**：机密正文和摘要只在 `withheld === true` 时进封存文件；没有正文的已拒绝/已替换行按 ADR 决定 6 摘要留在明文。短文字替换覆盖 `subjectRef`、`client`、`sourceKey`、keys、unkeyed。发现分类交叉校验缺口（低，影响需运行确认）。
- **资源耗尽**：新 `keys` / `unkeyedClients` 数组在 Schema 中没有 `maxItems`，但单行受 `MAXIMUM_LINE_LENGTH = 64 MiB`、目录受 512 MiB/4096 文件限制；属于有界但较宽松，未发现新的无界循环。
- **不可撤销操作**：重点查了“撤销一批”。发现导入产生的 `committed + memoryId=null + batchId!=null` 行无法真正撤销，且会从 UI 消失（问题 2）。
- **规则/文档/代码一致性**：ADR 0246 决定 8 说“没被替换的提议摘要不重复”，代码在摘要为 `null` 时跳过（问题 1）；v2 整份拒绝与 ADR 0233 一致；没有发现别处代码继续写 v2。

## 四、逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本 PR 的 diff 没有改 `packages/prompt-catalog`、`packages/runtime-pi`、模型请求组装、工具定义或历史消息。新增的 `externalProposals` 只出现在 `memory.overview.snapshot`（网关到网页的查询）和网页组件里；我在 `packages/prompt-catalog` 搜索不到 `externalProposals`。所以发给模型的内容仍然只在末尾追加，也没有新增每轮会变的值进入系统提示或工具定义。依据 `.claude/rules/prompt-prefix.md:27-28,33-36`。未核实项：没有运行 `npm run check:prompt-prefix`。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**对模型请求不会。** 本 PR 没有改出口遮盖、历史序列化或请求组装。

**对数据导出，会有一部分“同一数据库、不同次导出”的差异**：`exportedAt` 每次都不同（`export.ts:625`），带口令时封存文件也有随机加密结果；这不是模型请求，和现有导出行为一致。新增 external 数据本身的查询顺序是固定的（`snapshot.ts` 按 `received_at,id`，keys/unkeyed 按固定列排序），正常情况下同库同状态导出字节稳定。但第 4 条的占位编号依赖“库里已有占位”，而新 external 表没有被扫描，跨导入状态时同一段文字可能被编成不同占位，存在跨导出不一致风险。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有：

- 新增 `test/integration/data-export-external-proposals.test.ts`，用真实 SQLite 覆盖往返、机密扣留、受限记忆链接、格式号、引用、摘要、keys 重复、目标库非空。
- 新增 `test/integration/external-proposals-browser.test.ts`，用真实浏览器和网关桩。
- `scripts/check-data-export.mjs` 加入新文件，下限 96。我静态数了六个文件里带 `[P1-6]` 的用例：新文件 12 条、`data-export.test.ts` 新增的 v2 反向 1 条，加上原有数量，96 的下限是对得上的。
- `data-export.test.ts` 增加了 v2 整份拒绝的反向用例；`check-layout-audit.mjs` 增加 `memoryExternal` 场景。

反向用例本身是真的：例如“两条活着的提议同一摘要”会走到 `unique` 并对 `DataExportError` 断言；删掉校验后会变成数据库 UNIQUE 错误而不是 `DataExportError`，测试会失败。但覆盖不全：

- 没有“两条扣留正文共用摘要”的反向用例（问题 1）。
- 没有非法 `receivedAt`/`decidedAt` 的反向用例（问题 3）。
- 没有 external 短文字占位续号/冲突测试（问题 4）。
- 没有“导入后撤销 `memoryId=null` 的批次”测试（问题 2）。
- 没有“成功后再次全部失败”的结果行测试（问题 5）。

### 4. v2 文件整份拒绝是否和 ADR 0233 一致？别处还有没有写 v2？

**一致。** `FORMAT_VERSION` 已改为 `himawari.data-export.v3`（`schemas.ts:3`）；`readManifest` 对 `format !== FORMAT_VERSION` 一律抛 `FORMAT_UNSUPPORTED`，实际错误码是 `DATA_IMPORT_FORMAT_UNSUPPORTED`（`types.ts:72`、`verify.ts:250-258`）。ADR 0233 的先例就是旧版本整份拒绝。

命令行、网页导出、示范数据都走 `buildPortableExport` / `buildDemoPack`，格式都取 `FORMAT_VERSION`：`apps/agent-service/src/production-data-export.ts:127-134`、`apps/admin-cli/src/data-command.ts:232`、`packages/persistence-sqlite/src/data-export/demo-pack.ts:185`。我没有找到仍写 `data-export.v2` 的生产代码；搜索结果里的 v2 只在历史 ADR 和测试用例中。

### 5. 网页：全选、列表刷新、忙碌禁用、撤销后结果行

- **已勾选但已消失的条目不会被一起送出。** `external-proposals.tsx:110-111`：
  ```ts
  const shown = new Set(external.items.map(({ proposalId }) => proposalId));
  const picked = [...chosen].filter((id) => shown.has(id));
  ```
  `decide` 发送的是 `picked`。所以概况刷新后消失的条目会被过滤掉。但这个场景没有直接浏览器测试；现有“别处已处理”测试里条目仍留在列表中，只是后端跳过。
- **忙碌时按钮/输入基本都禁用。** 保存/不要、撤销、全选、单条 checkbox、编辑按钮、TextEditor 都看 `memory.busy`；全选和操作按钮还要求 `ready`。一个小的不一致：`!ready` 时单条 checkbox 和“改一下再保存”仍可操作，但最终提交按钮禁用。
- **撤销一批后结果行：** 同一批会清掉（`external-proposals.tsx:220-222`：`if (ok && sent?.batchId === batch.batchId) setSent(null);`）；而且批次从 `external.batches` 消失后 `externalResult` 会返回 `null`，结果行也会消失。**但**如果这一批里有第 2 条所说的 `memoryId=null` 已保存行，结果行虽然清掉了，实际提议并没有被重新打开，页面却显示撤销成功。

## 五、对作者说法的逐条核对

- “不改表、不改网关协议、不改发给模型的内容”：**成立**；diff 没有迁移、`contracts-v2.ts` 或模型请求代码。
- “另有几条没处理成的算法”：正常部分失败、重放、撤销、概况未刷新时，算术本身成立（`left = 发出条数 − committed − rejected`，失败项仍在待确认里；概况没刷新时批次找不到，只是暂时不显示结果，不会显示错数）。**但**新一批全部失败时会残留上一批的结果行（问题 5）。
- “像机密的正文和摘要都只进封存文件”：正文被扣留时成立；没有正文的已拒绝/已替换行摘要按 ADR 明文导出，所以“都”这个说法不全面，但符合 ADR 决定 6。
- “短文字替换不会让同一客户端两个编号撞唯一性”：正常编号是逐原文分配的，不会；但新 external 表没有加入已有占位编号扫描，存在导入后占位复用的边界（问题 4）。
- “导入校验覆盖表上全部 CHECK 和唯一索引”：**不成立**，至少 `received_at`/`decided_at` 的 GLOB CHECK 和“已扣留摘要”的唯一性没有在校验阶段覆盖（问题 1、3）。
- “v2 整份拒绝和 ADR 0233 一致”：**成立**。
- “已勾选但已消失的条目不会一起送出”：**代码成立**，但没有直接测试。
- “忙碌时按钮都禁用”：保存/不要/撤销/全选/编辑/输入都禁用；仅 `!ready` 时单条 checkbox 和编辑按钮可点。
- “撤销后结果行清掉”：同一批时成立；实际撤销是否重新打开提议另见问题 2。
