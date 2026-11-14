下面是核对结果。我先看了 `44a0e3..f98785f` 与 `fed6ae9..f98785f` 的改动，再对照了导出/导入/校验、表结构、生产写入与删除路径、网页和测试。

## 作者说法核对（先说结论）

- “不改表、不改网关协议、不改发给模型的内容”：属实。增量里没有 migration；`contracts-v2.ts` 只是把常量提出来，值仍是 2000；改动文件里没有提示词/请求组装代码。
- “测试 17 条、6 条，下限 101”：数量属实（`data-export-external-proposals.test.ts` 7 个独立 `it` + 10 个 `it.each` 用例；浏览器 6 个 `it`；`scripts/check-data-export.mjs` 为 101）。未运行测试。
- “记忆链接被置空时批次号一起置空，只在导出/导入自己丢掉链接时发生”：作为代码描述属实；但正因如此，库里本来就已经是 `memory_id IS NULL` 的已保存行不会被处理，见问题 2。

## 读代码证实的问题

### 1. 中：受限记忆的正文会通过关联提议的 `content` 明文导出

- 文件:行：`packages/persistence-sqlite/src/data-export/snapshot.ts:71-78`、`export.ts:476-478`、`snapshot.ts:52-60`；测试 `test/integration/data-export-external-proposals.test.ts:310-321`。
- 问题：记忆导出排除了 `restricted`，但提议导出查询没有看关联记忆的分级，也不看提议状态，所有提议的正文都会按 payload 自己的 `private/sensitive` 分级输出。于是“受限记忆的同一段文字”会以提议正文形式进入明文导出。
- 证据：
  - `snapshot.ts:56-60`：记忆查询是 `... AND classification != 'restricted'`。
  - `snapshot.ts:71-78`：提议查询没有 `classification` 或链接过滤。
  - `export.ts:476-478`：`const content = contentRef === null ? null : requiredText(...)`，有正文就导出。
  - 测试自己就构造了这个场景：`seedMemory(... id: "memory-restricted", text: "受限的记忆", classification: "restricted")`，随后 `seedProposal(... text: "受限的记忆", status: "committed", memoryId: "memory-restricted")`，但只断言了链接和批次被清空，没有断言正文不进明文。
  - ADR 0200:53：“不导出……restricted 记忆”。
- 建议：导出提议时解析 `memory_id`；若目标记忆因 `restricted` 未导出，对该提议正文强制 `withheld`（原文进密封文件），或按 ADR 明确丢弃/遮盖；补一条“受限正文不出现在明文文件里”的反向用例，并同步改 ADR 0246 决定 7。生产路径存在：`keep()` 会把与现有 active 记忆摘要相同的提议直接提交到该记忆（`production-mcp-memory-writer.ts:287-301`、`308-323`），摘要表不排除 restricted。

### 2. 中：库里已经是 `memory_id = NULL` 的已保存提议不会清 `batch_id`，与 ADR 0246 决定 7 不一致

- 文件:行：`packages/persistence-sqlite/src/data-export/export.ts:484-499`、`import.ts:714`；对照 `docs/adr/0246-external-proposals-join-the-data-export-and-web.md:61`。
- 问题：代码只在“原本 `memory_id` 非空、但这次导出/导入把它丢掉”时清批次号。若数据库里该行本来就是 `memory_id IS NULL`（例如外键 `ON DELETE SET NULL` 留下的已保存行），`batch_id` 会原样保留，导出/导入都不拒绝，网页“最近几批”仍把它算作一批里“保存”的一条，但它没有记忆可撤销。
- 证据：
  - `export.ts:498-499`：`batchId: storedMemoryId !== null && memoryId === null ? null : optionalString(row["batch_id"])`。
  - `import.ts:714`：`item.memoryId !== null && keptMemoryLink(item.memoryId) === null ? null : item.batchId`。
  - `0093_external_memory_proposals.sql:22-28`：`memory_id ... ON DELETE SET NULL`，且 CHECK 允许 `status='committed'` 与 `memory_id IS NULL`、`batch_id` 非空同时存在。
  - ADR 0246:61 写的是“指向的记忆没导出（例如已删除或分级为受限）……`memoryId` 和 `batchId` 一起置空”。
  - 当前生产删除路径 `sqlite-governed-deletion.ts:899-903` 会把提议改成 `rejected` 并清 `memory_id/content_ref/batch_id`，所以正常删除走不到该分支；但测试里确有直接 `DELETE FROM memory_records` 的路径（`test/integration/mcp-write.test.ts:892`），外键会留下这种行。
- 影响：这种行导出/导入后仍为“已保存、有批次号、没记忆”，`listBatches` 的 `SUM(status='committed')` 会把它计入；如果同批其他已保存行被清空批次，网页显示的该批保存/不要条数就与原批不一致。
- 建议：把两端条件改成“`status === 'committed' && memoryId === null` 就清 `batchId`”（拒绝的行仍可保留批次），并补一条 `committed + memory_id NULL + batch_id` 的导出导入测试。

### 3. 低：摘要去重的“被替换提议豁免”没有正向用例，反向用例删掉豁免也会通过

- 文件:行：`test/integration/data-export-external-proposals.test.ts:363-398`、`432-523`；实现 `packages/persistence-sqlite/src/data-export/import.ts:321-330`、`verify.ts:439-444`。
- 问题：合法的“一条被替换、一条待确认，正文相同”应当允许（DB 唯一索引只覆盖 `status <> 'superseded'`，代码也跳过了 superseded）。但现有反向用例把 `proposal-secret-copy` 从 `superseded` 改成 `rejected` 再断言失败；即使删除 `if (proposal.status === "superseded") continue`，这个用例仍会失败，所以没有真正覆盖豁免逻辑。
- 建议：增加一个不改文件、直接导入“superseded + pending 同摘要”的成功用例；再加一个 `committed + memory_id NULL + batch_id` 的用例覆盖问题 2。

## 推测 / 未核实

- 低：导入只检查 `textSha256` 是 64 位十六进制（`import.ts:309`、`verify.ts:135`），没有重算 `sha256(normalize(正文))` 与摘要比对。一个带正确清单哈希、但摘要与正文不一致的导出会被接受，影响后续按摘要去重/`seen` 判断。不是“校验通过却 INSERT 失败”，也不是本轮引入（提议导入来自 fed6ae9）；是否需要把导出文件当不可信输入，取决于威胁模型。
- 未运行 `npm run check:data-export`、浏览器测试和打包，因此“101 条是否实际通过”“打包产物字节”未核实；只核对了测试数量、代码路径和依赖关系。
- 生产是否实际存在 `restricted` 的记忆行，取决于其他功能；没有继续追所有写入路径。

## 侧重检查

- 错误路径 / 不可信输入：导入先验清单哈希、逐行 Schema、ID/摘要/固定编号唯一性、`memoryId`/`supersededBy` 引用、密封文件条数；新加的时间格式、正文分级、摘要二次查重都在事务外完成，失败不写库。逐条对照了 `0093` 的 CHECK/唯一索引，没有发现“能过校验但在 INSERT 时失败”的新输入（见必答 5）。
- 安全：机密正文摘要进密封文件、明文 `textSha256` 为 null；短文字占位编号扫描范围已覆盖提议、固定编号、不带编号客户端和规则。发现受限正文经提议泄漏（问题 1）。
- 资源耗尽：单行有上限；生产表有 pending/held 上限；但导出会导出所有提议及其正文，committed 行不占生产 held 上限，导出体积会随已保存提议数增长。未发现新的越界/无界单文件读取问题。
- 不可撤销操作：导入要求目标表为空、整个写入在一个事务里、失败在事务前抛出，且有 dry-run；网页清空上一批结果只是显示状态，可重新操作。
- 规则/文档一致：ADR 0246 决定 7 与代码在“已删除即 `memory_id` 已为空”的路径上不一致（问题 2）；ADR 0200 “不导出 restricted 记忆”与提议正文导出不一致（问题 1）。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。本次改动只涉及数据导出/导入、网页组件和 `gateway-contracts` 常量；没有改系统提示、工具定义、历史消息、遮盖或请求组装代码。`grep externalProposal` 在 `packages` 中只命中数据库、导出和网关概况，不进任何模型请求（ADR 0246:89 也这么写）。因此发给模型的内容仍是只在末尾追加，每轮变化的值没有新增到请求头。依据 `.claude/rules/prompt-prefix.md#append-only`。未运行 `check:prompt-prefix`。

2. **会不会让同一段文字在不同请求里变成不同字节？** 对模型请求没有影响，因为不参与请求组装。对导出文件：提议查询有 `ORDER BY received_at, id`，固定编号/不带编号客户端也有固定排序；提议行里的时间是库里存的值，不是导出的 `now()`；占位编号在同一库状态下是确定的。占位编号会随库内已有占位集合变化，但这是“同一数据库的导出一致性”，不是请求头问题。

3. **有没有自动检查，反向用例是否真的会失败？** 有：`data-export-external-proposals.test.ts` 17 条、浏览器 6 条、`check-data-export.mjs` 下限 101。新增的时间格式、分级不一致、明文摘要与扣留正文并存、固定编号重复、密封摘要重复（dry-run 和真实导入）都能从代码路径确认会抛 `LINE_INVALID`，且断言目标库仍为空。缺口是问题 3：`superseded` 豁免和“已 NULL 记忆 + 批次”没有正向/边界用例。未实际运行。

4. **新值/新字段的两端是否都接得住？**
   - `EXTERNAL_PROPOSAL_TEXT_MAXIMUM`：产生于 `contracts-v2.ts:1532`，用于同一文件 `1537`、`production-mcp-memory-writer.ts:184/281`（并在 `24` 行转出）、`production-mcp-read.ts:83/817`、`mcp-write.test.ts:55/817/821`、网页 `external-proposals.tsx:59`。所有地方都接受 2000；后端 `text.length` 与 HTML `maxLength`、`boundedString` 都按 UTF-16 长度，一致。控制台本来就已从 `@himawari-agent/gateway-contracts` 导入 `MEMORY_CATEGORY_NAMES` 等值，依赖图不会因此多出新的 Node-only 模块；打包字节未核实。
   - `externalProposals` 计数：`types.ts`、`schemas.ts`、`export.ts`、`import.ts`、`verify.ts`、`demo-pack.ts`、测试都同步了；demo pack 也写入了新的空数据文件。
   - 数据文件名、schema 文件、密封 key：产生与使用都在 `schemas.ts`/`export.ts`/`import.ts`，key 前缀与记忆/规则不冲突。
   - `batchId`/`memoryId`：两端逻辑对“导出/导入自己丢链接”一致；对“库里已为 NULL”两端都不处理，见问题 2。

5. **有没有引入新的“能通过校验却在 INSERT 时失败”的输入？** 没有找到。逐项比对了 `0093` 的 CHECK：ID/字段长度、时间 GLOB、`pending ↔ decided_at`、`memory_id` 只能属于 committed、正文/摘要扣留关系、`supersededBy`、`batch_id` 状态限制、正文分级枚举，以及三个唯一约束；新校验要么与 DB 相同，要么更严。`textSha256` 的 NOT NULL 也由“扣留必须从密封文件取到摘要、否则跳过”保证。唯一没校验的是摘要与正文是否对应，但那不会导致 INSERT 失败。
