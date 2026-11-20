## 复核范围

- 已先跑 `git diff 3633e576..f7522c41` 看整体，再跑 `git diff 1f9517bf..f7522c41` 看增量。
- 增量 `1f9517bf..f7522c41` 只改了 `docs/adr/0281-*.md` 和 `.agents/reviews/...` 复核记录，**没有任何 `src/` 或 `test/` 改动**（`git diff --name-only` 可证）。所以第 5 轮涉及代码/测试的意见不可能在这一增量里被修好。
- 逐条核对了第 5 轮 5 条意见；又跟到 `production-mcp-memory-writer.ts`、`production-mcp-read.ts`、`production-mcp-connections-control.ts`、`memory-source.ts`、`contracts-v2.ts`、`sqlite-external-memory-proposal-operations.ts`、`tools.ts`、`prompt-manifest.json`、`mcp-write.test.ts` 等直接使用端。

## 上一轮意见核对

- **第 1 条（敏感内容可自报分类绕过）：未修好。** 增量没有改代码；`keepDirect` 仍只看提交时算出的 `dataClassification`。
- **第 2 条（直接存是否占上限）：已按文档修好。** ADR:75 现在写“提交的瞬间仍计入……保存后不再计入”，与 `sqlite-external-memory-proposal-operations.ts:158-172` 的 `status <> 'committed'` 条件一致。
- **第 3 条（keepDirect 去重分支无测试）：未修好。** 增量没有新增测试。
- **第 4 条（ADR 0242 决定编号）：已修好。** ADR:65 改成了“决定 1”；`0242` 第 85 行确实在决定 1 之下。
- **第 5 条（漏写密码、验证码）：只修好了 ADR 一半。** ADR:74-75 已补“密码、验证码等凭据”，但 `tools.ts:370` 和 `prompt-manifest.json:390` 仍只写“健康、财务、证件号、银行卡号”。

## 意见

### 1（中高）直接存仍只信外部 agent 自报的类别，健康/财务内容可标成 other 绕过敏感判断

**文件:行**
- `apps/agent-service/src/production-mcp-memory-writer.ts:94-100`、`:280-293`
- `packages/sensitive-capture/src/identifiers.ts:20-27`
- `test/integration/mcp-write.test.ts:2311-2327`

**问题**
ADR 决定 3 写“敏感内容留在待确认”，但直接存实际只检查提交时算出的 `dataClassification`。分类函数只在“类别是 health/finance”或“正文命中证件号/银行卡号/凭据”时才升级为 sensitive。外部 agent 把健康、财务内容标成 `category: "other"`、正文又不含证件号/密码时，会按 private 直接入库，不经过主人确认。增量只改 ADR，代码未变；第 5 轮这条仍未修好。

**证据（读代码证实）**
```ts
// production-mcp-memory-writer.ts:286-288
const proposal = await this.#pending(proposalId);
if (proposal.status === "pending" && proposal.dataClassification !== "private")
  return "pending";
```
```ts
// production-mcp-memory-writer.ts:94-100
return (MEMORY_SENSITIVE_CATEGORY_NAMES as readonly string[]).includes(category)
  ? "sensitive"
  : classificationWithIdentifiers(text, "private");
```
```ts
// sensitive-capture/src/identifiers.ts:24-27
return (classification === "private" || classification === "public") &&
  (containsRestrictedIdentifier(text) || containsCredential(text))
  ? "sensitive"
  : classification;
```
现有反向用例只覆盖“类别就是 health”：
```ts
// mcp-write.test.ts:2314-2321
const sensitive = await f.propose(claude, {
  text: "主人有高血压，每天吃降压药",
  category: "health",
});
...
expect(await f.pending()).toHaveLength(1);
```
没有“健康正文 + category: other”的用例。

**建议**
如果保留当前分类口径，至少把 ADR 决定 3 和工具说明改成“只对自报类别和正文特征命中的敏感内容留在待确认”，并补一条反向用例固定这一行为；如果要真正兜住，直接在 `keepDirect` 前用更宽的敏感判断（例如健康/财务关键词、模型分类或独立分类器）再拦一次，命中即留待确认。补一条 `[direct]` 用例：健康内容标成 `other` 时必须仍进待确认。

### 2（低）工具说明和 manifest 仍只写证件号、银行卡号，和 ADR/代码里的密码、验证码不一致

**文件:行**
- `packages/prompt-catalog/src/tools.ts:363-370`
- `packages/prompt-catalog/prompt-manifest.json:387-391`
- `docs/adr/0281-...md:74-75`
- `packages/sensitive-capture/src/identifiers.ts:10-17`

**问题**
增量后 ADR 已写“有密码、验证码等凭据，才升敏感”，代码也确实把 `password`、`verification-code` 纳入敏感判断；但 `propose_memory` 的工具说明仍只告诉外部 agent“健康或财务分类、正文含证件号/银行卡号”会被留在待确认，manifest 的 reason 甚至明确写“只写健康、财务和正文里的证件号、银行卡号”。外部 agent 读到的说明与实际保护范围不一致。

**证据（读代码证实）**
```ts
// tools.ts:370
text: "……你把分类选成健康或财务的内容，或正文里含证件号、银行卡号的内容，即使设了直接存也先放进「待确认」。……"
```
```json
// prompt-manifest.json:390
"reason": "工具说明里敏感分类改成与代码一致，只写健康、财务和正文里的证件号、银行卡号"
```
```ts
// identifiers.ts:10-14
const CREDENTIAL_KINDS: ReadonlySet<string> = new Set([
  "machine-secret",
  "password",
  "verification-code",
]);
```

**建议**
在 `propose_memory`/`propose_memories` 的工具说明中补一句“正文里像密码、验证码等凭据也会留在待确认”，并同步更新 manifest reason；或者如果不想公开检测规则，就写“其他被判定为敏感的内容也会留在待确认”。同时补一条 `[direct]` 反向用例：带密码/验证码的正文必须待确认。

### 3（低）keepDirect 的“已有同文记忆”去重分支仍没有自动测试

**文件:行**
- `test/integration/mcp-write.test.ts:2373-2386`
- `test/integration/mcp-write.test.ts:1614-1654`
- `apps/agent-service/src/production-mcp-memory-writer.ts:311-328`

**问题**
第 5 轮指出的测试缺口仍在。现有的“全重复批次没有可撤销内容”用例是连续两次 `batch(PARK)`：第二次 `submit` 命中已 committed 的提议，结果直接是 `already_saved`，根本不会进入 `keepDirect` 的 `same` 分支。真正需要覆盖的是：提议仍是 pending，但正文和某条已有 active 记忆相同，`#keep` 走到 `same`，以 `batchId: null` 提交到已有记忆并返回 `existing`。

**证据（读代码证实）**
```ts
// mcp-write.test.ts:2383-2385
await batch(muse, [{ text: PARK }]);
await batch(muse, [{ text: PARK }]);
expect((await web.overview()).externalProposals.batches).toHaveLength(1);
```
```ts
// production-mcp-memory-writer.ts:325-328
if (same) {
  await this.#commit(proposal, same, input.direct ? { ...input, batchId: null } : input);
  return same;
}
```
非直接存的同文去重用例在 `mcp-write.test.ts:1614-1654`，但它走的是 `writer.respond(... decision: "keep")`，不是 `keepDirect`。

**建议**
补一个 `[direct]` 用例：先保存一条同文记忆（owner 或 ask 确认均可），再让直接存接入提议同一段文字；断言返回 `already_saved`、没有新建记忆、提议 `status: committed` 且 `batchId: null`、没有新批次；再对该接入的任意批次执行 undo，确认不会把这条已有记忆移进回收站。

### 4（低）ADR 背景仍说“在 Himawari 里点过才保存”，和 ask 客户端的确认框路径不符

**文件:行**
- `docs/adr/0281-...md:28`
- `apps/agent-service/src/production-mcp-read.ts:1362-1368`、`:1448-1467`

**问题**
增量把这句话改成“在接入设为‘先问我’时一律先存进‘待确认’，主人在 Himawari 里点过才保存”。但代码在接入为 ask、客户端支持 elicitation 时，会通过 `#askConfirmation` 向外部客户端发确认框，主人在客户端点同意后即保存，并不一定在 Himawari 里点过。这是旧行为，但本次增量修改了这句话，仍留下与代码不一致的断言。

**证据（读代码证实）**
```ts
// production-mcp-read.ts:1362-1368
if (!elicitationSupported(context.mcpReq.envelope) || !(await proposals.ready()))
  return this.#pendingReply(proposal);
return await this.#askConfirmation(
  { tool: "propose_memory", proposalId: proposal.id, argsHash, client },
  { text, category, client },
  context,
);
```
```ts
// production-mcp-read.ts:1458-1467
return inputRequired({
  inputRequests: {
    [MCP_PROPOSAL_CONFIRM_KEY]: inputRequired.elicit({
      message: renderPrompt(MCP_PROPOSE_MEMORY_CONFIRM, { ... }),
      requestedSchema: { type: "object", properties: {} },
    }),
  },
  ...
});
```

**建议**
把 ADR 背景改成“客户端能弹确认框时在主人在客户端确认后保存；不能弹或没回答时留在待确认”，或者按 ADR 0242 决定 9 的方向真正去掉客户端确认、统一到 Himawari。若保持代码现状，不要再用“在 Himawari 里点过才保存”概括所有 ask 接入。

### 5（低）直接存记忆在详情页被标成“手动添加时的默认值”

**文件:行**
- `apps/control-center/src/components/memory-page.tsx:584-590`
- `apps/control-center/src/i18n/resources/zh-CN.ts:955-956`（en/ja 同）

**问题**
加入 `external_direct` 后，重要度文案把 `external_direct` 和 `owner`、`external` 一起归到 `by: "owner"`，显示成“手动添加时的默认值”。直接存的记忆是外部 agent 送来、未经主人确认保存的，不是主人手动添加；ADR 决定 5 还特别要求“没经过主人点头的内容不冒充点过头”。这条是旧代码在加入新来源时扩展出来的显示问题，不是本次增量引入，但属于新值的直接使用端不一致。

**证据（读代码证实）**
```tsx
// memory-page.tsx:586-589
by:
  origin === "owner" || origin === "external" || origin === "external_direct"
    ? "owner"
    : "model",
```
```ts
// zh-CN.ts:955-956
"memory.page.importanceValue":
  "{value} / 1000 · {by, select, owner {手动添加时的默认值} other {记下时由模型打分}}",
```

**建议**
为外部来源单独加一个文案分支，例如“外部 agent 直接存时的默认值”或“外部 agent 提议时的默认值”，不要让 `external_direct` 落入“手动添加”。

## 读代码证实的

- 增量只改 ADR 和复核记录，没有改任何生产代码或测试。
- `keepDirect` 只有“非 private 就留待确认”这一道分类门槛；`proposalClassification` 只认 health/finance 类别和证件号/银行卡号/凭据。
- 直接存通过 `submit` → `keepDirect` → `#keep` 复用待确认写路径；敏感条目留在 pending；批次号格式为 `batch-direct-` + 24 位十六进制。
- `pushPolicy` 在 `contracts-v2.ts:1287/1353/1382/1392` 和 `sqlite-mcp-connection-operations.ts:151/221` 都被限定为 `ask`/`direct`。
- `mcp_proposal_kept_direct` 长度 24，小于账本 `reasonCode` 的 64 字符上限；校准 SQL 用 `LIKE 'mcp_proposal_%'` 排除，`keptDirect` 仍会被排除。
- `external_direct` 已加入 `MemorySourceState`，控制中心 i18n 和 `memory-checkup` 都只关心 `unavailable`/`import`，不会误判。
- `batch-direct-` 批次号 37 字符，`memory.external.undo` 的 `machineString` 和 `mcp_connections`/`external_memory_proposals` 的 batch_id 长度限制都能接受。
- `saved` 只是 `propose_memories` 工具结果里的状态，没有内部解析器依赖它。
- [direct] 正向用例存在，且覆盖：不弹确认框、立即保存、同次调用共用一个批次、敏感（健康类别）留待确认、ask 仍进待确认、规则不自动生效、可整批撤销、未就绪留待确认、整批只扫描一次 active 记忆。

## 推测 / 未核实

- “Himawari 自己发给模型的请求一个字节都不变”：我确认修改的 `MCP_TOOL_PROPOSE_MEMORY`、`MCP_TOOL_PROPOSE_MEMORIES`、`MCP_PROPOSE_MEMORY_SAVED_DIRECT` 只被 `production-mcp-read.ts` 使用，不进入 Himawari 自己的系统提示。但没有运行 `npm run check:prompt-prefix` 做字节级验证；另外改提示词目录会改变 `TRUSTED_PROMPT_TEXTS`，理论上会影响旧对话出口遮盖，只是这些外部 MCP 文案正常不会出现在 Himawari 自己的历史里。
- prompt-manifest 的 sha256 是否正确，我没有运行 `prompt-catalog` 测试，也未自行计算哈希；标为未核实。
- 直接存后不再计入待确认上限，长期只受每分钟调用、每批 50 条和磁盘余量限制；被攻陷的直接接入理论上可以持续写入。我没有发现额外的总量上限或未处理的耗尽路径，但这是设计取舍，未做压力测试。
- 测试是否会真的执行（CI 选择、环境变量跳过等）未核实。

## 侧重检查

- **安全 / 不可信输入**：`#readProposalArgs` 校验正文长度、类别枚举、key 长度和机器密钥；`submit` 再次校验；直接存复用同一条路径。机器密钥仍会被拒收，密码/验证码会被判敏感后留在待确认。发现的主要安全缺口是第 1 条：自报类别可绕过敏感判断。
- **错误路径**：待确认满时 `propose_memory` 返回 `MCP_PROPOSE_MEMORY_FULL`，`propose_memories` 单条返回 `full`；未就绪回待确认；已决定回 `already_saved`/`declined_before`/`replaced`；单条保存异常记 `onFailure` 且结果保持 `pending`。未发现直接存独有的未处理异常路径。
- **资源耗尽**：提交时仍受 pending 1000 条、暂存 5000 条和磁盘余量限制；保存后不再计入；每批最多 50 条，另有每分钟调用限制。直接存绕开了“待确认堆积”这一总量刹车，ADR:75 已如实写明，这是产品取舍，不是隐藏行为。
- **不可撤销操作**：直接存可整批撤销，撤销会把该批新建记忆移进回收站并把提议恢复 pending；敏感内容不直接存；规则仍不自动生效。没有发现“不可撤销且无提示”的新路径。
- **规则 / 文档 / 代码一致**：ADR 第 2、4 条已改好；第 5 条 ADR 已补凭据但工具说明/manifest 没补；ADR 背景仍有“在 Himawari 里点过才保存”的旧断言；详情页重要度文案仍把直接存记忆说成“手动添加时的默认值”。
- **值的使用端**：`pushPolicy`、`keptDirect`、`external_direct`、`batch-direct-` 批次号、`saved` 状态、`MCP_PROPOSE_MEMORY_SAVED_DIRECT` 都逐项查了直接使用端，未发现校验不接受的问题；唯一发现的是第 5 条的 UI 文案语义不匹配。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   对 Himawari 自己模型的系统提示、内部工具定义、历史消息：不涉及。增量只改 ADR；PR 改的 MCP 工具说明和回执只被 `production-mcp-read.ts` 用于外部 agent，`usedBy` 也写明只有这一个使用端。直接存新增的是记忆内容，后续可能被选进每轮上下文尾部，但这本来就是“只在末尾追加”的路径，不改变请求前缀。
   注意：改 `prompt-catalog` 文本会改变全局 `TRUSTED_PROMPT_TEXTS`，理论上可能影响旧对话的出口遮盖；我没有发现这些外部 MCP 文案会进入 Himawari 自己的历史，标为“推测/未做字节级验证”。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   没有发现新的每轮变化值。工具说明是固定文字；`saved`/`keptDirect` 是确定值；`batch-direct-` 批次号虽随机，但只在保存时生成一次，之后作为记忆编号稳定存在，不会每轮改写正文；列表顺序也未改。没有时间字段或依赖前后文的遮盖逻辑被这次增量改动。跨部署时 `TRUSTED_PROMPT_TEXTS` 会变一次，这是提示词目录变更的通用风险，不是本增量的运行期不确定性。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有 `[direct]` 用例，且“健康类别留待确认”“ask 仍进待确认”“规则不自动生效”这些反向断言如果代码改坏会失败。缺口是：
   - 没有“健康正文标成 other 仍必须待确认”的反向用例，所以第 1 条的行为没有被测试守住；
   - 没有 `keepDirect` 的“已有同文记忆”去重分支用例，第 3 条仍未覆盖；
   - 没有直接存模式下密码/验证码留待确认的用例，第 5 条的代码与说明不一致也没有测试守。
   prompt-manifest 有哈希检查（`apps/agent-service/test/prompt-catalog.unit.test.ts`），但本轮未运行，哈希正确性标为未核实。

4. **改动产生或修改的每个值，使用端能接受吗？**
   增量本身只产生文档文字，没有新的运行时值。对 PR 引入的值逐个查了直接使用端：
   - `pushPolicy: "direct"`：`contracts-v2` 枚举、SQLite `oneOf`、控制中心草稿和设置页都接受；
   - `keptDirect`/`mcp_proposal_kept_direct`：账本 `reasonCode` 上限 64，长度 24；校准 SQL 用前缀排除，仍会排除；
   - `external_direct`：`MemorySourceState` 联合类型、i18n、`memorySourceCounts` 和 `memory-checkup` 都能接受；
   - `batch-direct-` + 24 位十六进制：37 字符，`machineString`、undo 命令、批次表长度限制都能接受；
   - `saved` 状态：只出现在外部工具结果，没有内部协议解析依赖；
   - `MCP_PROPOSE_MEMORY_SAVED_DIRECT`：只被 `production-mcp-read.ts` 使用，prompt-manifest 有对应条目。
   未发现“产生端通过、使用端拒绝”的硬错误；只发现详情页重要度文案把 `external_direct` 误标为“手动添加时的默认值”（第 5 条意见）。
