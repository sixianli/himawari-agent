## 结论摘要

第 3 轮增量（`6a62b98..73abc8b`）没有发现会破坏现网数据的高、中严重度问题。核心逻辑与作者说法基本一致：导出/导入只在数据备份路径上，没有进入模型请求；新增的两条反向测试从代码看确实能在回退对应改动后失败（未实际运行）。发现的问题主要是低严重度的边界行为、两端校验不对称和测试覆盖缺口。

---

## 发现（读代码证实，按严重度排列）

### 低 | `packages/persistence-sqlite/src/data-export/import.ts:307-315`

**问题**：有正文、但封存文件里缺少摘要时，提议被静默跳过，而不是“整份拒绝”，与 ADR 0253 决定 6 的措辞不完全一致。

**证据**：

```ts
307:    if (digest === null || (proposal.content !== null && text === null)) {
308:      proposalsWithout += 1;
309:      continue;
310:    }
311:    if (!/^[0-9a-f]{64}$/.test(digest) || (text !== null && proposalTextDigest(text) !== digest))
312:      throw new DataExportError(
313:        DATA_EXPORT_ERROR_CODES.SEAL_MISMATCH,
314:        `其他 agent 的提议 ${proposal.id} 的正文摘要不对`,
315:      );
```

扣留提议的 `digest` 来自 `sealedText(externalProposalDigestKey(id))`（第 300-302 行）；如果密封文件有原文、没有摘要键，`digest === null` 会先走第 307 行的跳过分支。ADR 0253 第 58 行写的是“有正文的提议（被扣留的用封存文件里的原文）……不一致就整份拒绝”。

**建议**：在给了口令、且 `content !== null`、`text !== null` 但摘要缺失时抛 `SEAL_MISMATCH`；或者把 ADR 改成明确“缺摘要视为无原文、跳过并报告 `externalProposalsWithoutOriginal`”。

---

### 低 | `packages/persistence-sqlite/src/data-export/import.ts:311`、`schemas.ts:182`、`apps/agent-service/src/production-mcp-memory-writer.ts:211`

**问题**：导入重算摘要固定使用当前的 `proposalTextDigest`，完全忽略导出文件里的 `normalization` 字段。ADR 决定 6 说“按提议的规范化方式重算摘要”。现在生产只写 `mcp-text:v1`，所以当前数据安全；但一旦规范化算法升级，旧备份会被整份拒绝，且没有按版本选择算法的入口。

**证据**：

```ts
// import.ts:311
if (!/^[0-9a-f]{64}$/.test(digest) || (text !== null && proposalTextDigest(text) !== digest))
```

```ts
// schemas.ts:182
normalization: text(1, 64),
```

```ts
// production-mcp-memory-writer.ts:211
normalization: EXTERNAL_PROPOSAL_NORMALIZATION,
```

测试种子甚至写的是 `'nfc-space-v1'`（`test/integration/data-export-external-proposals.test.ts:74`），但导入仍按当前算法重算并通过，说明该字段目前只是被搬运，没有参与校验。

**建议**：二选一——明确要求 `normalization === "mcp-text:v1"`，未知值整份拒绝；或按 `normalization` 选择摘要算法，并为 `mcp-text:v1` 加反向测试。

---

### 低 | `packages/persistence-sqlite/src/data-export/export.ts:540,549` 与 `import.ts:311`

**问题**：导出端不校验库里 `text_sha256` 与正文是否一致，导入端却会校验。只要库里有一行不一致，系统能导出备份，却无法再导入这份备份。当前生产的唯一写入路径是一致的，因此现网数据不会触发，但这是一处两端校验不对称。

**证据**：

```ts
// export.ts:540
const digest = str(row["text_sha256"]);
// export.ts:549
textSha256: withheld ? null : digest,
```

写入端的不变量：

```ts
// production-mcp-memory-writer.ts:175
const text = normalizeProposalText(input.text);
// production-mcp-memory-writer.ts:192
const textSha256 = proposalTextDigest(text);
// production-mcp-memory-writer.ts:200
await this.#storeText(contentRef, text, dataClassification);
```

**建议**：导出时对非扣留、有正文的提议做一次 `proposalTextDigest(content.text) === text_sha256` 校验，不一致时明确报错或标记；至少让导出失败早于“生成无法恢复的备份”。

---

### 低（测试覆盖缺口） | `test/integration/data-export-external-proposals.test.ts:716-721`、`:502-534`

**问题**：

1. 新增的摘要不符反向测试只覆盖了非扣留正文（`proposal-pending`）；被扣留提议走“封存原文 + 封存摘要”的分支没有对应的反向用例。
2. 第 3 轮把 `seeded()` 里的 `proposal-rejected` 批次号删掉后，已没有测试覆盖“有正文的已拒绝提议在导出/导入时保留批次号”这一正向行为；现有正向测试只覆盖了 `proposal-committed`。

**证据**：

```ts
// 新增反向用例只改 proposal-pending
editLine(files, "proposal-pending", (line) => ({ ...line, textSha256: "0".repeat(64) }))
```

```ts
// seeded() 中被拒绝的提议已无 batchId
await seedProposal(source, {
  id: "proposal-rejected",
  text: null,
  status: "rejected",
});
```

**建议**：补一条直接篡改 `SEALED_FILE.originals` 中 `externalProposal/<id>/content` 的反向用例；再补一条“有正文的 rejected + batchId”往返保留的用例。

---

## 推测 / 未核实

### 低（安全边界，需先确认威胁模型） | `import.ts:311`、`sqlite-external-memory-proposal-operations.ts:149-155`

`content === null` 的提议导入时仍可携带任意 64 位十六进制摘要，而 `submit` 用 `text_sha256` 做去重/阻止再次提议：

```ts
149:    const seen =
150:      this.database
151:        .prepare(
152:          `SELECT 1 FROM external_memory_proposals
153:          WHERE owner_id = ? AND agent_id = ? AND text_sha256 = ? AND status <> 'superseded'`,
154:        )
```

若允许导入不可信文件，一份被篡改的备份可以为任意文字植入“已拒绝”墓碑，使未来同文提议被直接当作 `declined`。新增校验只覆盖“有正文”的提议，所以没有关闭这条路径。它是既有行为，不是本轮引入；如果导入文件按可信备份对待，可以不改，但建议在 ADR 或格式说明里明确这一点。

### 未核实 | `docs/adr/0253-external-proposals-follow-restricted-deletion-and-expiry.md:29`

ADR 背景引用 `.agents/reviews/pr-420/round-1/judgments.md` 的 glm-4 和 `.agents/reviews/pr-420/round-5/judgments.md` 的 ds5-5 到 ds5-7。当前是稀疏检出（`git status` 显示 67% tracked files present），这些记录文件不在工作区，`git show` 访问 records 路径也被拒绝，无法核实引用是否准确、是否确为四条。其余行号引用已核实。

---

## 侧重检查

- **错误路径**：摘要不符在写入事务之前抛出（`import.ts:311` 在 `proposalPlans.push` 和最终 `.immediate()` 事务之前）；缺失密封摘要走跳过并计数；导入目标非空在 `assertEmptyTarget` 提前拒绝。没有发现“抛错后写了一半”的问题。
- **不可信/不合规范输入**：`textSha256` 有 `^[0-9a-f]{64}$` 校验；正文长度受 schema 限制（`EXPORTED_TEXT_SCHEMA` 1,000,000 字符）；`externalProposalProblem` 校验状态、时间和链接；`normalization` 未参与校验是上文低严重度问题。
- **安全**：新增摘要校验能阻止“有正文但摘要不对”的导入；受限记忆过滤、删除路径本轮复查未发现新的明文泄漏。无正文提议的摘要仍可伪造，见推测节。
- **资源耗尽**：新增的 `proposalTextDigest(text)` 是线性 SHA-256，输入受 schema 长度限制；未新增无界集合或循环。
- **不可撤销操作**：导入目标必须为空，且实际写入在单个事务里；导出只读。治理删除匹配摘要的行为与 ADR 一致。
- **规则/文档与代码一致性**：ADR 前提 5 的 `sqlite-external-memory-proposal-operations.ts:457`（`detach.run`）和 `:492`（`UPDATE ... content_ref = NULL` 的改动前形态）已核对；0093 迁移第 23、57、65 行引用正确；决定 5、6 与主要代码一致，决定 6 的“整份拒绝”和“规范化方式”有上文两处措辞/边界差异。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本次改动只在数据导出/导入、ADR 和测试里；没有改 `packages/prompt-catalog`、工具定义、会话历史、模型请求组装或遮盖逻辑。发给模型的内容仍然只在末尾追加，每轮变化的值仍然只能在最后一条用户消息里；依据 `.claude/rules/prompt-prefix.md` 第 32-36 行第 4、5 条和该文件第八节。导出文件不是模型输入。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会（就模型请求而言）。** 本次改动不进入请求路径，也不新增时间字段、无序集合或依赖上下文的遮盖。新增的 `proposalTextDigest` 是确定的 SHA-256，对同一归一化文本每次结果相同。导出文件的确定性不属于模型 KV 缓存范围；本次未审计整个导出序列化器，只确认改动处没有引入非确定性。

### 3. 有没有自动检查，反向用例是否真的会失败？

**有，但我没有运行测试，结论来自代码推演。**

- 新增反向用例：`data-export-external-proposals.test.ts:502-534`（没有正文的 rejected 在导出和导入都去掉批次号）、`:716-721`（正文和摘要不符抛 `SEAL_MISMATCH`）。
- 去掉 `export.ts` 的 `content === null` 条件，第 518 行 `expect(line(files).batchId).toBeNull()` 会失败；只去掉 `import.ts` 的条件，第 526-533 行的数据库断言会失败。
- 去掉 `import.ts` 的摘要重算，被篡改的 `proposal-pending` 不会触发 `SEAL_MISMATCH`，会走到插入，测试的 `expect((failure as DataExportError).code).toBe(...)` 会失败。
- 覆盖缺口见上文“低（测试覆盖缺口）”：扣留正文的摘要不符分支、有正文的拒绝提议保留批次号都没有反向/正向覆盖。

### 4. 每个改动值，生产端和使用端是否都能接受？

**基本可以，逐项如下：**

- `batchId`（导出置空、导入置空）：导出 `export.ts:556-559`、导入 `import.ts:765-768`。schema 允许 `null`（`schemas.ts:188`），迁移 0093 第 21 行允许 `NULL`、第 28 行只限制非空值必须在 committed/rejected；`listBatches` 用 `batch_id IS NOT NULL` 排除（`sqlite-external-memory-proposal-operations.ts:390-394`），`listBatch`/`undoBatch` 也按具体 id 查询；网页通过 `listBatches` 读取，空批次本来就不展示。两端接受。
- `textSha256`：生产端 `import.ts:311/318` 现在会校验并写入；导出端 `export.ts:540/549` 写库值。消费端包括唯一索引（迁移 0093 第 31-33 行）、`submit` 去重（operations.ts:149-155）、受限删除按摘要匹配（`sqlite-governed-deletion.ts:900-902`）和导出端受限过滤（`export.ts:121-126`）。有正文的提议两端一致；无正文提议的摘要仍可任意指定，见“推测”节。
- `omitted.reason`：新文案在 manifest schema 的 `reason: text(1, 512)` 范围内（`schemas.ts:515-521`），没有代码按精确字符串匹配，测试用的是 `includes`（如 `data-export-external-proposals.test.ts:402`）。
- `normalization`：本次未修改其产生方式，仍由 `production-mcp-memory-writer.ts:211` 写为 `mcp-text:v1`，schema 允许 1-64 字符；但导入不校验它，见上文低严重度发现。
