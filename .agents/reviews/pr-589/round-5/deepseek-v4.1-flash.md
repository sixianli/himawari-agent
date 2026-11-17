本轮查过的范围：PR 589 在 `dc4bcf9..1f9517b` 里的直接增量（`7f3b8cf64` 的提示词与清单、`dc5d78a06` 的 ADR 0281、`9ea4dfd4b` 的复核记录），以及证据指到的旧代码：`production-mcp-read.ts`、`production-mcp-memory-writer.ts`、`sqlite-external-memory-proposal-operations.ts`、`mcp-write.test.ts`、ADR 0242。分支合并带来的 PR 596/main 改动，我只核对到“没有改 direct-save 的 writer/read”，其余未按 PR 589 审查。

上一轮意见核对：第 1 条已改好（`prompt-manifest.json` 已更新，反向 stale 用例仍在）；第 5 条已改好（不再写死“四个”）；第 2、3、4 条仍未改好，见下面第 1、2、3 条。

### 1（中高）敏感内容仍可被外部 agent 自报分类绕过，工具说明改成照实描述但没有修代码

文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:94-101`、`:280-294`；`packages/gateway-contracts/src/contracts-v2.ts:2014`；`packages/prompt-catalog/src/tools.ts:370`；`docs/adr/0281-memory-from-outside-agents-saves-directly-when-the-owner-turns-it-on.md:74`

问题：作者说“敏感内容仍待确认”，但代码判敏感依赖外部 agent 自己填的 `category`。健康、财务内容被标成 `other` 时，`proposalClassification` 返回 `private`，`keepDirect` 随即直接保存。

证据（读代码证实）：
```ts
export function proposalClassification(text, category) {
  return (MEMORY_SENSITIVE_CATEGORY_NAMES as readonly string[]).includes(category)
    ? "sensitive"
    : classificationWithIdentifiers(text, "private");
}
```
```ts
if (proposal.status === "pending" && proposal.dataClassification !== "private")
  return "pending";
```
`MEMORY_SENSITIVE_CATEGORY_NAMES = ["health", "finance"]`。因此 `category: "other"`、正文“主人有高血压，每天吃降压药”不会命中证件号/银行卡号，分类是 `private`，会走直接保存。新增的工具说明也明确写成“你把分类选成健康或财务的内容……先放进待确认”，等于把保护条件交给外部 agent；ADR 第 74 行也承认这个缺口。现有反向用例只测了 `category: "health"`（`test/integration/mcp-write.test.ts:2314-2321`），没有测“健康内容 + 其他分类”。

推测：实际触发取决于外部 agent 是否误标或恶意标；ADR 记录 Andy 2026-11-15 已选择“先接受缺口再合并”。但若验收条件是“敏感内容仍待确认”，按内容语义判断，本条未达成。

建议：要么在定级层做内容判断（不只看自报分类），要么把验收条件、工具说明和 ADR 都改成“只有自报为健康/财务或命中确定性标识时才待确认”，并明确这是已知缺口；同时补一条“健康正文 + other 分类”的用例，把当前行为钉住。

### 2（低）ADR 说直接存不占待确认/暂存上限，但提交端先计入再保存

文件:行：`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:158-172`；`apps/agent-service/src/production-mcp-memory-writer.ts:208`、`:280-294`；`docs/adr/0281-memory-from-outside-agents-saves-directly-when-the-owner-turns-it-on.md:75`

问题：ADR 第 75 行写“直接存的条目不占待确认和暂存的条数上限，只受每分钟调用次数和每次 50 条的限制”，但直接存路径仍然是先 `proposals.submit` 再 `keepDirect`，而 `submit` 在插入前就统计 pending/held 并在达到上限时抛 `EXTERNAL_MEMORY_PROPOSAL_PENDING_FULL`。

证据（读代码证实）：
```ts
const held = this.database.prepare(
  `SELECT SUM(status = 'pending') AS pending, COUNT(*) AS held
   FROM external_memory_proposals
   WHERE owner_id = ? AND agent_id = ? AND status <> 'committed' AND content_ref IS NOT NULL`,
).get(...) as { pending: number | null; held: number };
if (!seen && ((held.pending ?? 0) >= EXTERNAL_PROPOSAL_PENDING_MAXIMUM ||
  held.held >= EXTERNAL_PROPOSAL_HELD_TEXT_MAXIMUM)) { ... this.fail("PORT_CONFLICT", "EXTERNAL_MEMORY_PROPOSAL_PENDING_FULL"); }
```
`ProductionMcpMemoryWriter.#submit` 在 `:208` 调 `proposals.submit`，`keepDirect` 在 `:289` 才调用 `#keep`。所以待确认接近 1000 条或 30 天内保留正文接近 5000 条时，直接存仍会返回 `full`/`mcp.propose-memory-full`。

推测：正常流量下很少碰到上限，所以上轮定为低；但 ADR 的绝对表述会让运维误以为直接存不受这两个上限影响。

建议：改 ADR 为“提交瞬间仍计入，保存后不再计入；接近上限时直接存也会返回 full”，或让 direct 提交显式绕过 pending/held 上限（需要另设计插入路径，不能只改文档）。

### 3（低）“去重不进批次”的测试仍没有覆盖到 keepDirect 的去重分支

文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:325-327`；`test/integration/mcp-write.test.ts:2373-2386`；`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:230-276`

问题：上一轮说“回退该行测试仍会通过”，本轮增量没有改 direct 用例，现状仍然如此。`[direct] keeps proposals waiting while the memory book is not ready, and an all-duplicate batch has nothing to undo` 里第二次发送同一段 `PARK`，在 `submit` 阶段就命中了已 committed 的外部提议，返回 `already_saved`，根本不会进入 `keepDirect` 的 `same` 分支。

证据（读代码证实）：
```ts
if (same) {
  await this.#commit(proposal, same, input.direct ? { ...input, batchId: null } : input);
  return same;
}
```
```ts
await batch(muse, [{ text: PARK }]);
await batch(muse, [{ text: PARK }]);
expect((await web.overview()).externalProposals.batches).toHaveLength(1);
```
`submit` 对同 `text_sha256` 且 `status <> 'superseded'` 的已存在记录直接返回（`:151-157`、`:230-276`），所以第二次批量在 `#proposeMemories` 里就是 `already_saved`，不会调用 `keepDirect`。把 `:326` 改回 `#commit(proposal, same, input)`，这条用例仍会通过。

推测：这就是上一轮“回退该行仍通过”的原因；当前没有用例能防止该修复被回退。

建议：构造一个“活跃记忆存在但没有对应 committed 外部提议”的场景（例如先由主人侧建一条同文记忆，再用新的 `key`/来源推同一段文字），让提议保持 pending 后进入 `keepDirect` 的 `same` 分支，断言没有新增 `batch-direct-` 批次，并确认回退 `:326` 会让用例失败。

### 4（低）ADR 0281 把“全局配置之下再收窄”错记成 ADR 0242 决定 3

文件:行：`docs/adr/0281-memory-from-outside-agents-saves-directly-when-the-owner-turns-it-on.md:65`；`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:85`、`:94`

问题：这是本轮增量新改的句子，引用错了决定编号。ADR 0242 决定 3 是 `find_memories` 加参数；全局配置 `runPolicy.mcpRead.proposals` 与接入设置“只能在全局之内再收窄”的说明在决定 1 的条目里，并引向 ADR 0227 决定 3。

证据（读文档证实）：
- ADR 0281:65：`ADR 0242 决定 3 的方向是全局配置管写工具出不出现、接入上的设置在它之内再收窄`
- ADR 0242:85（决定 1 的条目）：`全局配置 runPolicy.mcpRead.proposals 仍然决定写工具出不出现；接入上的设置只能在它之内再收窄`
- ADR 0242:94（决定 3）：`**find_memories 加两个可选参数。**`

推测：不影响运行，但会误导后续按决定号查依据的人。

建议：把“决定 3”改成“决定 1 里关于 ADR 0227 决定 3 的说明”，或直接写“ADR 0242 决定 1 / ADR 0227 决定 3”。

### 5（低）工具说明和 ADR 只写证件号、银行卡号，漏掉代码同样会判敏感的密码和验证码

文件:行：`packages/prompt-catalog/src/tools.ts:370`；`docs/adr/0281-memory-from-outside-agents-saves-directly-when-the-owner-turns-it-on.md:74-75`；`packages/sensitive-capture/src/identifiers.ts:10-28`；`packages/sensitive-capture/test/identifiers.unit.test.ts:81-90`

问题：本轮把工具说明改成“正文里含证件号、银行卡号的内容”才待确认，但 `proposalClassification` 调用的 `classificationWithIdentifiers` 还会因密码、密钥、验证码升为 `sensitive`。带密码或验证码的正文不一定被 `proposalHasMachineSecret` 拒绝，于是会留在待确认，和工具说明不一致。

证据（读代码证实）：
```ts
const CREDENTIAL_KINDS = new Set(["machine-secret", "password", "verification-code"]);
...
return (classification === "private" || classification === "public") &&
  (containsRestrictedIdentifier(text) || containsCredential(text))
  ? "sensitive" : classification;
```
测试也明确写了：
```ts
expect(classificationWithIdentifiers("Wi-Fi 密码 abc12345", "private")).toBe("sensitive");
expect(classificationWithIdentifiers("482910 是验证码", "public")).toBe("sensitive");
```
工具说明却只列“证件号、银行卡号”。`prompt-manifest.json:390` 的说明同样是“只写健康、财务和正文里的证件号、银行卡号”。

推测：这是“说明少写了保护范围”，实际行为更保守（密码/验证码会待确认而不是直接存），因此安全风险低；但外部 agent 可能据此误判回执。

建议：把工具说明和 ADR 改成“证件号、银行卡号、密码、验证码等凭据”，或明确写“以服务端定级为准，确定性检测还会覆盖密码、验证码”。

**侧重检查**

- 错误路径：`keepDirect` 未就绪返回待确认、敏感返回待确认、已决定返回 settled、批量逐条失败回 pending；未发现新增崩溃路径。
- 不合规范/不可信输入：`category` 只接受九种，正文有长度和机器密钥检查，`sourceKey` 有长度和机器密钥检查；但 `category` 本身是外部自报，见第 1 条。
- 安全：`propose_rule` 未走直接存，测试 `:2388-2394` 仍验证规则不自动生效；敏感绕过见第 1 条；机器密钥仍拒收。
- 资源耗尽：直接存仍受 pending/held 上限影响，见第 2 条；每分钟调用次数和每次 50 条限制仍在。
- 不可撤销操作：直接存按 `batch-direct-` 批次可整批撤销；规则不直接存；敏感内容待确认，未发现新增不可撤销路径。
- 规则/文档一致性：发现第 4、5 条；上一轮第 5 条已修好。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 对 Himawari 自己发给模型的请求：不会。`MCP_TOOL_PROPOSE_MEMORY` 只在 `apps/agent-service/src/production-mcp-read.ts:830` 注册给外部 MCP 客户端，ADR 0281 明确这些文字只发给外部客户端。对外部 agent 的模型：工具定义文字变了，但它是固定前缀、没有时间/随机值，同一版本内每轮不变；按“只追加”规则，Himawari 自身仍是固定前缀在前、每轮变化值在最后一条消息。
2. **同一段文字会不会在不同请求里变成不同字节？** 本轮增量只改了固定提示词文字、清单项和 ADR，不引入依赖前后文的遮盖、时间字段或无序集合。直接存的 `batch-direct-` 编号每次调用随机，但这是既有行为，且不出现在模型提示词里；同一段文字的重复提议会被去重。本增量没有发现新的字节不确定问题。
3. **有没有对应的自动检查，反向用例会不会失败？** 有：`apps/agent-service/test/prompt-catalog.unit.test.ts:300-319` 会重算 `sha256` 并检查清单，`:370-387` 的反向用例会在清单未更新时失败；上一轮第 1、5 条因此已改好。但没有覆盖第 1 条的“健康内容 + other 分类”、第 2 条的 pending 上限、第 3 条的 `keepDirect` 去重分支；第 3 条按现有用例回退修复行仍会通过。
4. **改动产生或修改的每个值，使用端能不能接受？** 本轮新增/修改的值只有：`MCP_TOOL_PROPOSE_MEMORY.text` 的新文字（用于 `production-mcp-read.ts:830` 的工具描述，接受任意字符串）、`prompt-manifest.json` 的 `mcp.propose-memory` 行（`sha256`/`changedIn`/`reason`，由 `prompt-catalog.unit.test.ts:184-190,318` 校验非空和摘要）。两端都不限制具体文字，结构上可接受；`sha256` 的精确值我无法在只允许 git/read/grep 的条件下重算，标为未核实。增量没有新增配置键、字段或序列化格式；旧的 `keptDirect`、`batch-direct-`、`pushPolicy` 值本轮未被修改，未重新审计其全部使用端。
