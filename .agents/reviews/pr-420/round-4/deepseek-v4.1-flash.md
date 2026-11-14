# 复核结论（1531e3d 对 b279f7b）

## 发现（按严重度）

### 1. 高（机密性）— 排除集合以“提议的摘要”为准，不以“受限记忆正文”为准，编辑保存时仍会漏
**文件:行**：`packages/persistence-sqlite/src/data-export/snapshot.ts:72-75`；`apps/agent-service/src/production-mcp-memory-writer.ts:280,359,385-386`；`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:22`

**问题**：`restrictedText` 取的是“当前 `memory_id` 指向受限记忆的那些提议”的 `text_sha256`。但保存时如果用户用了 `editedText`，提议行只被改成 `committed` 并写入 `memory_id`，`text_sha256`/`content_ref` 仍是**原始提交文本**。若编辑后的文本与一条已存在的受限记忆同文（`same` 分支会命中该受限记忆），提议摘要 A 与受限记忆正文 B 不同；此后另一条正文为 B 的提议，摘要 B 不在排除集合里，会被正常导出，明文文件里就出现受限记忆的正文。

**证据**：
```ts
// snapshot.ts:72-75
const restrictedText = `text_sha256 IN (SELECT text_sha256 FROM external_memory_proposals
  WHERE owner_id = @ownerId AND agent_id = @agentId AND memory_id IN (
    SELECT id FROM memory_records
    WHERE owner_id = @ownerId AND agent_id = @agentId AND classification = 'restricted'))`;
```
```ts
// production-mcp-memory-writer.ts:280
const text = normalizeProposalText(input.editedText ?? (await this.readText(proposal)));
// :359
await this.#decideCommitted(proposal, memoryId, input);
```
`#decideCommitted` 最终只更新 `status/decided_at/batch_id/memory_id`（`sqlite-external-memory-proposal-operations.ts:356-359`），没有更新 `text_sha256`/`content_ref`。因此 ADR 第 7 条“它的正文就是那条受限记忆的文字”在编辑保存时不成立。

另有一个相关但更依赖数据生命周期的口子：`memory_id` 是 `ON DELETE SET NULL`（迁移 0093 第 22 行）。受限记忆一旦被物理删除、链接被清空，同文提议就不再进入 `restrictedText` 子查询。

**建议**：排除条件应以“受限记忆正文的规范化摘要/正文”为准，而不是只以仍链接着的提议摘要为准；可以把受限记忆正文摘要加入快照，或在导出层把受限记忆正文与提议正文做同一规范化后比较。至少应取并由“链接提议摘要”和“受限记忆正文摘要”两部分组成，并补一条“编辑保存后再提议同文”的反向用例。

---

### 2. 中 — 新反向测试名为“sealed file included”，实际完全跳过封存文件
**文件:行**：`test/integration/data-export-external-proposals.test.ts:330-338`

**问题**：测试标题（第 308 行）和 ADR/代码里的理由都说“明文和封存文件里都没有”，但断言循环显式排除了 `SEALED_FILE`。如果回归把受限正文或摘要写进封存文件，这条测试不会失败。

**证据**：
```ts
for (const [path, bytes] of files)
  if (path !== SEALED_FILE)
    for (const hidden of [
      "受限的记忆正文",
      digest("受限的记忆正文"),
      "proposal-restricted-link",
      "proposal-restricted-copy",
    ])
      expect(decoder.decode(bytes)).not.toContain(hidden);
```
**建议**：用 `PASSPHRASE` 解开封存文件，检查 `originals` 的键和值里没有 `externalProposal/proposal-restricted-*`、受限正文和摘要；或至少检查 `originals` 没有这些键。当前代码看下来不会写入封存文件，但这条保证没有自动检查。

---

### 3. 中 — 被排除提议的编号仍会经 `decision_ledger` 的 `id` 带出
**文件:行**：`apps/agent-service/src/production-mcp-memory-writer.ts:120-128`；`packages/persistence-sqlite/src/data-export/export.ts:347-386`

**问题**：提议的提交、确认、拒绝、替换都会写 `decision_ledger`，而 ledger 的 `id` 直接嵌入提议编号：`ledger:mcp-proposal:<proposalId>:...`。导出会导出全部决策行，`safeString` 只按机密规则遮盖，不会识别提议编号。因此真实运行时，被本轮排除的提议编号仍会出现在 `data/decisions.jsonl`；已保存到受限记忆的提议，其 `subjectRef`/`inputs.memoryIds` 还可能带出受限记忆编号。测试夹具直接 `INSERT` 提议、没有 ledger 行，所以发现不了。

**证据**：
```ts
// production-mcp-memory-writer.ts:120-128
return batchId === null
  ? `ledger:mcp-proposal:${proposalId}:${decision}`
  : `ledger:mcp-proposal:${proposalId}:${batchId}:${decision}`;
```
```ts
// export.ts:347-349
const decisionLines: JsonValue[] = snapshot.decisions.map((row) => {
  const id = str(row["id"]);
  ...
```
```ts
// export.ts:371-372
subjectRef: safeOptional(optionalString(row["subject_ref"])),
inputs: safeJson(JSON.parse(str(row["inputs"])) as JsonValue),
```
**建议**：明确“整条不导出”是否包括对提议编号的引用。若包括，导出时过滤/改写引用了被排除提议的决策行；若不包括，则修正测试和 ADR 的措辞。并补一条用真实写入路径产生 ledger 行、再导出/导入的用例。

---

### 4. 低（推测利用）— 导入不校验 `textSha256` 与正文一致，新规则可被篡改的导出绕过
**文件:行**：`packages/persistence-sqlite/src/data-export/import.ts:298-319`；`packages/persistence-sqlite/src/data-export/snapshot.ts:72-75`

**问题**：导入对 `textSha256` 只做正则校验，不重新对正文计算摘要。新排除规则把 `text_sha256` 当作“这段正文的标识”。一个被重新计算过清单哈希的导出，可以把受限正文放在一个不匹配的 `textSha256` 下导入；之后再次导出时，这条正文不会被识别为受限同文。这是本轮的排除规则新依赖的不变量，而导入端没有守住它。

**证据**：
```ts
// import.ts:298-300
const digest = withheld
  ? sealedText(externalProposalDigestKey(proposal.id))
  : proposal.textSha256;
...
// import.ts:309
if (!/^[0-9a-f]{64}$/.test(digest))
```
**建议**：导入时对非扣留正文重新计算规范化摘要并与 `textSha256` 比对，不一致整份拒绝；或者在格式中把摘要与正文绑定（例如校验 `content` 的摘要）。如果导出文件本来就不在信任边界内，这属于既有缺口；但本轮让摘要承担了保密判断，应当补上。

---

### 5. 低 — `externalProposalKeys`/`Unkeyed` 没有按导出集合过滤
**文件:行**：`packages/persistence-sqlite/src/data-export/snapshot.ts:88-98`；`packages/persistence-sqlite/src/data-export/export.ts:144-146`

**问题**：快照里这两张表仍读取所有提议的键，包括被本轮排除的提议。当前序列化只遍历过滤后的 `externalProposals`，所以不会直接输出这些键；但它们仍参与 `existingPlaceholderMax` 扫描，使占位编号依赖被排除的数据。这不是明文泄漏，但“整条不导出”在快照层没有完全落实，未来若有新消费者直接使用这两个数组就会漏。

**证据**：
```ts
// snapshot.ts:88-98
const externalProposalKeys = all(
  `SELECT proposal_id, client, source_key FROM external_memory_proposal_keys
   WHERE owner_id = @ownerId AND agent_id = @agentId ...`,
);
const externalProposalUnkeyed = all(
  `SELECT unkeyed.proposal_id, unkeyed.client ...
   WHERE proposal.owner_id = @ownerId AND proposal.agent_id = @agentId ...`,
);
```
```ts
// export.ts:144-146
snapshot.externalProposals,
snapshot.externalProposalKeys,
snapshot.externalProposalUnkeyed,
```
**建议**：在 SQL 里对键表也套用同一 `restrictedText` 过滤，或在读取后按导出提议 id 集合过滤，保持快照层与导出层一致。

---

### 6. 低 — 作者说明与本轮实际 diff 不完全一致
**文件:行**：`docs/adr/0246-external-proposals-join-the-data-export-and-web.md` 决定 7；对比 `git diff b279f7b 1531e3d`

**问题**：作者说这一轮只改了 `snapshot.ts`、`export.ts` 和测试，但增量里还修改了 ADR 0246 决定 7 的文字。另外测试标题写了“sealed file included”，代码却跳过封存文件（见发现 2）。

**建议**：在轮次说明里列出 ADR 变更；测试标题和断言保持一致。

---

## 侧重检查

- **SQL 空集/NULL 语义**：`text_sha256` 在迁移 0093 第 8 行是 `TEXT NOT NULL CHECK (length(text_sha256)=64)`，所以子查询不会产生 NULL；子查询为空时 `x IN (空集)` 为 FALSE，`NOT FALSE` 为 TRUE，不会误排除正常提议。若将来有绕过约束的脏数据含 NULL，`NOT (x IN (...NULL...))` 会变成 NULL，反而会静默排除所有不匹配行；目前受表约束保护。
- **错误路径/不可信输入**：导入在 `assertEmptyTarget` 后整事务写入，被排除的提议不会产生半条记录；未发现本轮新引入的“通过校验但 INSERT 失败”的输入。不可信导出下 `textSha256` 与正文不绑定的问题见发现 4。
- **安全**：封存文件当前代码不会写入被排除提议的正文/摘要，但没有测试守着；`decision_ledger` 的编号泄漏见发现 3；编辑保存后的受限正文泄漏见发现 1。
- **资源耗尽**：新 SQL 增加了一层 `IN` 子查询；未见新的无界循环或解密放大，但没有实际执行查询计划，未核实大库上的耗时。
- **不可撤销操作**：导出是只读；导入仍要求空目标并走事务，本轮没有新增不可撤销操作。
- **文档/代码一致性**：ADR 决定 7 的字面“摘要相同”与代码一致；但“正文就是受限记忆的文字”在编辑保存时不成立，`reason` 里的“明文和封存文件里都没有”也缺少封存文件测试。
- **未核实**：未运行任何测试（工具限制）；未逐一追踪所有模型请求组装路径，只按 diff 和 ADR 判断；未实测 `check:data-export` 和 `check:layout`。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本轮改动只在数据导出（`snapshot.ts`/`export.ts`/测试/ADR），没有改系统提示、工具定义、历史消息或出口遮盖的组装路径；ADR 0246 后果也写明“待确认的提议不进任何发给模型的请求，本 ADR 不改模型请求”。发给模型的内容仍按原逻辑只在末尾追加，本轮也没有把新的每轮变化值放进系统提示或工具定义。依据 `.claude/rules/prompt-prefix.md:27-29`、`:35`。未实际运行 `check:prompt-prefix`。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
对模型请求不会：改动不进入请求路径。对导出文件，同一数据库的导出顺序仍由 `received_at, id` 等固定排序决定，没有新增时间字段或依赖前后文的遮盖；排除集合只取决于数据库状态，不取决于导出请求的上下文。没有新增无序集合的序列化。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有：`scripts/check-data-export.mjs` 已把 `data-export-external-proposals.test.ts` 纳入，`REQUIRED` 从 82 提到 103。静态计数是旧文件 84 条 + 新文件 19 条 = 103 条，正好等于下限。若把本轮的排除逻辑去掉，新增反向用例会在 `manifest.counts.externalProposals`、导入后的行数/摘要查询和正文检查处失败，所以核心行为有反向覆盖。
但封存文件被 `if (path !== SEALED_FILE)` 完全跳过（发现 2），所以“封存文件里也没有”不会失败；`decision_ledger` 编号泄漏、编辑保存后的同文提议、`textSha256` 与正文不一致这三种情况也没有反向用例。未运行测试，以上为静态核对。

**4. 每个新值/改动值的使用端都能接受吗？**
- `restrictedProposals`：只在 `export.ts:578-581` 作为 `omitted.count` 使用，清单 schema 允许 `integer(0)`，测试按子串查找，接受。
- 过滤后的 `externalProposals`：被 `export.ts` 用来生成行、`proposalIds`、payload 引用和 `counts.externalProposals`，再经 `verify.ts`/`import.ts` 校验。`supersededBy` 指向被排除提议时导出置空（`export.ts:502`），导入也只在目标提议存在时写入（`import.ts:718-720`），满足数据库 `CHECK` 和唯一索引；未发现新的 INSERT 失败输入。
- `text_sha256`：数据库要求非空 64 字符（迁移 0093:8），导出 schema 允许 null（扣留时），导入对封存摘要做 64 位十六进制校验并写入非空值，接受；但导入不核对正文与摘要的一致性，见发现 4。
- 键表/不带编号客户端：导出只遍历过滤后的提议，序列化端不会输出被排除提议的键；但快照仍读取它们并参与占位编号，见发现 5。
- 新的 `omitted` 文案：测试用 `includes("受限（restricted）记忆的其他 agent 提议")` 能匹配，其他使用端没有按完整字符串比较。
- ADR 决定 7 的文字：与代码字面一致，但“正文就是受限记忆的文字”与编辑保存路径不一致，见发现 1。

**结论**：本轮没有发现“通过校验却在 INSERT 时失败”的新输入；但存在一个仍需处理的受限正文泄漏路径（编辑保存后的同文提议），以及封存文件测试缺口和决策记录编号泄漏。
