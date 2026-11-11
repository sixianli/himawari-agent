## 侧重检查

我按错误路径、不可信输入、安全、资源耗尽、不可撤销操作、规则/文档一致性逐项看了这些地方：

- **错误路径**：无令牌 401（`production-mcp-read.ts:148-150`）、读取/记录失败时的工具错误（`:224-235`）、`applyProposal` 冲突、payload 保护失败、记忆 generation 缺失（`production-memory-control.ts:279-290, 807-808`）、旧客户端、缺 `inputResponse`、decline/cancel、过期/篡改 state、空正文、非法分类、记忆已删除后重放。
- **不可信输入**：`text`、`category`、客户端名（`clientNameOf`，`:118-128`）、`requestState`、`argsHash`、`inputResponses`；MCP 明确要求服务器校验所有工具输入、做访问控制、限流（[MCP Tools Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)），elicitation 要求把请求绑定到客户端和用户（[MCP Elicitation Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)）。
- **安全**：只读令牌是否被静默升级为写令牌、持令牌者自批、跨客户端重放、确认框伪造、错误信息/正文外泄、敏感正文在表单中明文展示。
- **资源耗尽**：写入没有配额，只有 `BearerGate` 的 30 次/分钟（`bearer-admission.ts:4-5`）；每条写入会新增 payload、memory、projection job 和嵌入费用。
- **不可撤销**：新建记忆本身可删；但删除后重放、ledger 作为唯一 tombstone 的保留期是风险点。
- **规则/文档一致性**：ADR 0219 明说写操作不在该步（`docs/adr/0219-read-only-mcp-entry-with-static-token.md:111`）；现有测试断言只有三个只读工具（`test/integration/mcp-read.test.ts:225-233`）；`memory:mcp:` 不在记忆来源识别里（`apps/control-center/src/memory-source.ts:20-29`）。

---

## 证实的发现（按严重度）

### 1. 高：写能力没有独立开关或独立凭据，静默扩大只读端点的权限

**问题**：方案明确“不新增配置开关：配了 `runPolicy.mcpRead` 就有这个工具”。ADR 0219 把该入口定义为只读、单令牌、撤销时所有客户端一起停（`docs/adr/0219-read-only-mcp-entry-with-static-token.md:53-59`），并写明“写操作和确认框……不在这一步里做”（`:111`）。现在已有的只读令牌会在升级后直接获得写入持久记忆的能力，而方案自己也承认“持令牌的客户端可以自己回 accept”。

**证据**：
- 方案第 1 条：“不新增配置开关：配了 runPolicy.mcpRead 就有这个工具”。
- `docs/adr/0219-read-only-mcp-entry-with-static-token.md:111`：“写操作和确认框（2026-07-28 版的多轮请求，结果标为「需要输入」）不在这一步里做。”
- MCP 规范允许工具集合随授权变化：“The set MAY vary by the authorization presented on the request”，并要求“Implement proper access controls”“Rate limit tool invocations”（<https://modelcontextprotocol.io/specification/2026-07-28/server/tools>）。

**建议**：新增 `runPolicy.mcpWrite`（或 `mcpRead.allowWrite`）和独立的 `mcp-write` secret purpose/令牌；默认关闭；只有写入凭据才暴露 `propose_memory`。这样现有只读客户端的工具列表和信任边界都不变，也符合“工具集合可按授权变化”的规范。若坚持复用同一令牌，至少要有显式 `allowWrite: true` 且写进新 ADR，不能“配了读就有写”。

---

### 2. 高：SDK 配置位置写错，HMAC 校验和 legacyShim 可能根本没生效

**问题**：方案说“`createMcpHandler` 的 `requestState.verify`”和“`createMcpHandler` 设 `inputRequired.legacyShim: false`”。但 `inputRequired` 和 `requestState` 是 **`ServerOptions`**，要作为 `new McpServer(options, serverOptions)` 的第二个参数；`createMcpHandler` 的选项只有 `legacy`、`maxRequestBodySize`、`onerror`、`responseMode` 等。按方案写法，`requestState.verify` 不会注册，`ctx.mcpReq.requestState()` 会返回**原始、可被客户端伪造的 wire 字符串**；`legacyShim:false` 也不会生效。

**证据**：
- `createMcpHandler` 选项列表：<https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/createMcpHandler.html>（`CreateMcpHandlerOptions` 只有 `bus`、`keepAliveMs`、`legacy`、`maxRequestBodySize`、`maxSubscriptions`、`onerror`、`responseMode`）。
- `requestStateCodec` 文档：“Pass this directly as `ServerOptions.requestState.verify`”：<https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/requestStateCodec.html>。
- `input-required` 文档：“Set `ServerOptions.inputRequired.legacyShim: false`”：<https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required.html>。
- 现有代码只传了一个参数：`production-mcp-read.ts:153` `new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })`。

**建议**：在进程级创建一次 codec，然后：

```ts
new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    requestState: { verify: codec.verify },
    inputRequired: { legacyShim: false },
  },
)
```

不要在每个请求的 factory 里用随机 key 重新建 codec；方案从令牌派生 key 的方向是对的，但 key 必须至少 32 字节，并建议用 HKDF/HMAC 做域分隔。还要校验 `ctx.mcpReq.requestState()` 返回的是对象且字段完整，不能直接信任 wire 字符串。

---

### 3. 高/中：`restricted` 判定是死代码，反向用例无法真正失败

**问题**：方案用 `classificationWithIdentifiers(text, "private")` 算分级，然后“restricted 直接拒”。但该函数的返回类型是 `T | "sensitive"`，当 `T="private"` 时**永远不可能返回 `restricted`**。所以 restricted 分支不可达，方案里的“restricted 内容”测试要么失败，要么根本走不到该分支。

**证据**：`packages/sensitive-capture/src/identifiers.ts:20-28`：

```ts
export function classificationWithIdentifiers<T extends string>(
  text: string,
  classification: T,
): T | "sensitive" {
  return (classification === "private" || classification === "public") &&
    (containsRestrictedIdentifier(text) || containsCredential(text))
    ? "sensitive"
    : classification;
}
```

**建议**：先定政策再写代码：
- 如果要拒绝身份证/银行卡等“受限标识”，直接调用 `containsRestrictedIdentifier(text)`（它已去掉空格和连字符）并拒绝；
- 如果沿用现有自动记忆行为（把受限标识记成 `sensitive` 并加密保存），就删掉“restricted 直接拒”和对应测试，明确写“标识类内容按 sensitive 保存”；
- 无论哪种，测试必须构造能让该分支失败的输入，而不是用 `classificationWithIdentifiers(text,"private")` 断言它返回 restricted。

---

### 4. 中：`idempotentHint: true` 与真实行为不符

**问题**：同一个参数调用两次 `propose_memory` 会生成两个 `proposalId`、两条记忆；只有**同一个 requestState 的重试**才幂等。客户端可能因为 `idempotentHint:true` 在超时后直接重试，造成重复记忆。

**证据**：MCP schema 对 `idempotentHint` 的定义：“If true, calling the tool repeatedly with the same arguments will have no additional effect on its environment.”（<https://modelcontextprotocol.io/specification/2026-07-28/schema>）。方案的 `proposalId` 是每次第一轮随机生成，两次独立调用不会命中同一 id。

**建议**：改为 `idempotentHint: false`。如果确实需要客户端级别的幂等，增加一个显式的 `idempotencyKey` 参数（或要求客户端重发同一个 `requestState`），并从该 key 派生 `proposalId`；不要用正文哈希代替。

---

### 5. 中：把决策记录同时当幂等账本和状态存储，存在语义和可靠性缺口

**问题**：方案第 4、5 条依赖 ledger 的 kept/discarded 记录判断“已决定”。但：

- `applyProposal` 在发现同 id、同内容时**直接返回已有记录，不会写 ledger**（`packages/application/src/services/durable-memory-service.ts:122-143`）。所以“kept 和记忆同事务”只在**首次 create** 成立；如果 ledger 缺失但 memory 已存在，重试会返回成功却没有 kept 记录。
- `insertLedgerRow` 是 `ON CONFLICT (id) DO NOTHING`（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:113-121`），同 id 不同内容会被静默丢弃；用它当提案唯一状态时，冲突不可见。
- discarded 是单独 `append`，写失败没有失败关闭策略；如果用户已拒绝但记录没写成，旧 state 带 `accept` 重放仍可能保存（虽然持令牌者可重新发起，安全影响有限，但审计不变量破了）。
- 记忆被硬删除时行会被 `DELETE FROM memory_records` 清掉（`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:885`）；ledger 是唯一防复活记录，一旦 ledger 被保留策略清理，旧 state 就能重建。
- 外部提案会被算进校准：`calibrationGroup` 把所有 `memory_candidate` 的 `kept/discarded` 分到 `memory_kept/memory_skipped`（`packages/calibration/src/index.ts:266-269`），SQL 也不按 reasonCode 过滤（`:633-643`）。这会污染自动记忆阈值的校准数据。daily-review 对 `approval_rejected` 的跳过是生效的（`daily-review.ts:268`），但 kept 会出现在每日回顾里。

**建议**：加一张专门的提案表（`owner_id, agent_id, proposal_id` 唯一，记录 `kept/discarded`、`memory_id`、`decided_at`），kept 与 memory 在同一事务写入；discarded 单独事务且失败必须返回错误、不能告诉客户端“已拒绝”。如果坚持“不改表”，至少：
- 读 ledger 之外也检查 memory 记录（含 trashed/deleted）状态；
- 对 ledger 写失败一律 fail closed；
- 在 calibration SQL 中排除 `reason_code = 'mcp_proposal_kept'`（以及对应 discarded）的记录，或引入新的 decision kind（需要迁移）；
- 测试必须做**硬删除 + 清 payload** 后重放，否则 `applyProposal` 会因为已有 trashed 记录直接返回，测试会“因为错误的原因通过”。

---

### 6. 中：写入口没有配额，资源耗尽面比读入口大

**问题**：只读入口的每次调用有嵌入费用但有限流；写入口每条会新增 payload、memory、projection job，可能触发嵌入/索引费用，而且没有每日/每主人上限。30 次/分钟约等于 4.3 万条/天，正文上限 2000 字。

**证据**：`bearer-admission.ts:4-5` 只有 `AUTHORIZED_PER_MINUTE = 30`；`production-mcp-read.ts:33` bodyLimit 65536；没有看到记忆写入配额。`sqlite-memory-operations.ts:695-704` 的 `saveWithProjection` 会新增 job。

**建议**：在**发确认框之前**检查每主人/每日写入条数和总字节配额，超限直接拒绝并不弹框；写入限流与读取分开计数；至少给 MCP 写入一个独立上限，复用自动记忆的预算/配额机制。

---

### 7. 中：elicitation 没有绑定客户端身份，确认框里的客户端名可伪造

**问题**：方案在第一轮显示“哪个客户端提议”，来源是 `clientNameOf(context.mcpReq.envelope, userAgent)`（`production-mcp-read.ts:118-128`），这是客户端自报的。MCP 规范要求 elicitation 绑定到客户端和用户身份，并明确“Servers MUST NOT rely on client-provided user identification without server verification”。同时 `requestState` 只绑定 `tool` 和 `argsHash`，没有绑定客户端/principal；在单令牌多客户端场景下，一个客户端可以重放另一个客户端的 state。

**证据**：
- Elicitation 规范：“Servers MUST bind elicitation requests to the client and user identity”“Servers MUST NOT rely on client-provided user identification without server verification, as this can be forged.”（<https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation>）。
- `createRequestStateCodec` 支持 `bind`：“Use this to bind state to the authenticated principal and/or the originating method”（<https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/requestStateCodec.html>）。

**建议**：用 `bind: ctx => method + principal`（principal 可来自路由层传入的 `authInfo.clientId`，或令牌摘要），并把第一轮的客户端身份放进签名 payload；确认框把客户端名标成“对方自称”，不要当作权威身份。未来多令牌时，这也能天然隔离每个客户端的 state。

---

### 8. 中/低：规范化只去 C0 控制字符，bidi/零宽字符仍可进入确认框

**问题**：方案只说“去控制字符、trim”。现有 `singleLine` 只处理 `<0x20` 和 `0x7f`（`production-memory-control.ts:102-110`），而 `daily-review.ts:186-195` 的 `clipTo` 还会去掉 U+202A–202E、U+2066–2069。U+202A–E 是 Cf 不是 Cc，如果不处理，确认框显示的内容可能被 bidi 重排或零宽字符伪装，和最终存的内容视觉不一致。另外应在规范化后重新检查长度和空值（全控制字符/全空白可能变空）。

**建议**：定义唯一的 `normalizeProposalText`，至少：去 C0/C1、U+202A–E、U+2066–69、trim，考虑 Unicode NFC；确认、摘要、存储、`argsHash` 都用它；规范化后再校验 1–2000 和 `assertStorable`；加“全控制字符”“bidi 伪装”“规范化后超长”的反向用例。

---

### 9. 低：`memory:mcp:` 在来源识别/报表里会被当成“整理”

**问题**：`memorySourceState` 只识别 `memory:owner:`、import、thread/reminder，其余无 `sourceThreadId` 的记忆返回 `"tidy"`（`apps/control-center/src/memory-source.ts:20-29`）；`scripts/operations/memory-source-report.mjs:18-22` 也只单独识别 owner。MCP 新建记忆会显示成“整理”，不是“外部提议”。

**建议**：新增 `mcp` 来源（或至少归到 owner），同步改报表 CASE 和 UI 类型；否则用户无法区分外部 agent 写入的记忆。

---

### 10. 低：现有测试/常量/清单没有纳入改动

**问题**：现有 `mcp-read.test.ts:225-233` 断言工具恰好是 `MCP_READ_TOOL_NAMES` 的三个且全部 `readOnlyHint === true`。新增第四个写工具后这个测试必然失败；方案只提了新建 `mcp-write.test.ts`，没提更新它。`MCP_READ_TOOL_NAMES` 也不应把写工具放进去，否则常量名和只读语义不一致。

**建议**：拆成 `MCP_READ_TOOL_NAMES` 与 `MCP_WRITE_TOOL_NAMES`；更新现有 listTools 断言；同步 `packages/prompt-catalog/prompt-manifest.json` 和 golden 测试。

---

### 11. 低：prompt catalog 只应登记静态片段

**问题**：方案说“确认框文字……都登记”。确认框里包含客户端名、分类、正文等动态值；如果把整段含动态值的文字登记成 `fixedPrompt`，会破坏“固定文字”与“外来内容”的区分，也可能影响出口遮盖的固定文字清单（`prompt-prefix.md:53`）。

**建议**：只登记静态模板片段（工具说明、结果文案、字段标签），动态值在运行时拼接；新固定文字避免包含像秘密的数字/值。

---

### 12. 低：新工具的错误/返回文本没有明确走外发遮盖

**问题**：只读工具走 `#call`，会 `maskForExternalRead`（`production-mcp-read.ts:221`）；写工具“不走只读 register 包装”，如果没有明确约定，成功/失败文本可能直接回给外部 agent。正文本来就是该客户端给的，但错误信息可能带内部 ID/详情。

**建议**：写工具也复用 `#call` 的错误收敛方式：只回固定文案，详细错误走 `onFailure`；任何要回给客户端的正文/存储内容先过 `maskForExternalRead`；日志不要记录正文。

---

## 推测/未核实

- **交互式 Claude Code 是否已支持 2026-07-28 的 form elicitation/MRTR**：未核实。验收方案依赖这一点；如果它仍走 2025 era，新工具会直接返回“需要新版客户端”，整个验收无法完成。建议在实现前先用 `ctx.era` 或实际连接确认。
- **`createRequestStateCodec` 是否支持注入时钟**：文档只列了 `key`、`ttlSeconds`、`bind`，没有时钟注入。过期测试需要把 `ttlSeconds` 设小（测试专用）或用等待；方案应写明，别假设可以伪造时间。
- **控制中心/i18n 是否已为 `mcp_proposal_kept` 准备文案**：未核实。若直接显示 reasonCode，会暴露原始英文代码。
- **记忆硬删除后 payload 的最终保留策略**：未核实。若 payload 也被清理，ledger 是唯一 tombstone；保留期必须写进 ADR。

---

## 如果由我来定，我会怎样改这份方案

1. **保持只读入口原样，新增写入口**：`runPolicy.mcpWrite`（独立 secret purpose `mcp-write`）或显式 `allowWrite`；默认关闭。只有写凭据才注册 `propose_memory`；只读令牌的工具列表、缓存和权限完全不变。
2. **按 era 和授权注册工具**：`createMcpHandler` 的 factory 用 `ctx.era`，`modern` 才注册写工具；`legacy` 保持三个只读工具。这样旧客户端不会看到一个永远失败的工具，也不会改变它们的工具列表。`inputRequired.legacyShim:false` 作为兜底，但放在 `ServerOptions`。
3. **正确配置 SDK**：进程级 codec（HKDF 域分隔、至少 32 字节），`ServerOptions.requestState.verify = codec.verify`，`ServerOptions.inputRequired.legacyShim = false`；用 `bind` 绑定 method + principal；codec payload 只放 `tool`、`proposalId`、`argsHash`，不放正文。
4. **随机 proposalId**：UUIDv4/128 位随机；不要用正文哈希。正文哈希会让客户端能探测“这条记忆是否已存在”，也会让相同文字的不同提案互相碰撞。
5. **提案状态独立存储**：新增 `mcp_memory_proposals` 表（`owner_id, agent_id, proposal_id` 唯一，`state kept/discarded`、`memory_id`、`decided_at`）；kept 与 memory 同事务；discarded 单独事务，失败返回错误、不宣称已拒绝。ledger 只做审计，不做唯一幂等来源。如果坚持不改表，就把“memory 记录检查 + ledger 记录 + fail closed + 硬删除测试”写清楚，并排除校准污染。
6. **语义分开**：`decline` → `approval_rejected`；`cancel` → 不写 rejected（或新 reason `approval_cancelled`），允许客户端重新发起；`accept` 但未勾选 → `approval_rejected`。
7. **规范化统一**：一个函数负责确认、摘要、存储、hash；处理 bidi/零宽/控制字符，trim 后重新校验长度和空值。
8. **配额和限流**：写入按主人/日限制条数和总字节，超限在弹框前拒绝；写和读分开限流。
9. **测试补齐**：更新 `mcp-read.test.ts`；新增 `mcp-write.test.ts` 覆盖正向、拒绝/取消/不勾、篡改/过期、换参数、无 elicitation、真实 2025 客户端不走 shim、restricted/敏感、空/超长/控制字符、非法分类、同 state 并发重放、discarded 写失败、硬删除后重放、配额、客户端名伪造。
10. **文档**：新增 ADR 取代/补充 ADR 0219 的“不做写操作”，写明独立写凭据、信任模型（持令牌者可自批）、配额、ledger/提案状态、校准排除、来源标记。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**Himawari 自己发给模型的请求：不会。** 这次改动只加外部 MCP 服务端的工具和文字，不碰系统提示、工具定义、历史消息或遮盖结果；方案第 7 条“Himawari 自己发给模型的请求不变”是正确的。

**外部 agent 的模型请求：会变一次，但只应追加。** `propose_memory` 的工具定义属于外部 agent 请求的开头；从三个工具变成四个，会改变一次外部 agent 的 tool list/前缀。若按我建议的“只有写凭据/modern era 才注册”，只读客户端和旧客户端的工具列表完全不变，只有启用了写能力的客户端变一次。动态值（客户端名、分类、正文）只出现在 elicitation 的 message/tool result 里，属于本次工具调用末尾，不进系统提示或工具定义。工具注册顺序固定（三个只读在前，写工具在后），`tools/list` 顺序确定，符合 MCP 的 deterministic order 要求。**前提**：不要按“记忆是否就绪”“分类”等每轮变化的值动态增删工具；否则就会每轮改请求开头，违反 `prompt-prefix.md` 的第 1、2、6 条。

### 2. 同一段文字会不会在不同请求里变成不同字节？

- **对 Himawari 自己的模型请求：不会**，因为新文字/新工具不进入它的系统提示、工具或历史。
- **对 MCP 自身：`requestState` 和 `memoryId` 会随每次新提案不同**（随机 proposalId、codec 的 `exp`），这是有意的；但它们不进入任何模型提示，所以不违反 KV 缓存规则。`argsHash` 必须用**规范化后的参数 + 固定键顺序**（排序键、`category` 默认值先补齐、`text` 先规范化），否则同一组参数可能算出不同 hash。
- **工具顺序、ledger 的 `memoryIds` 数组**都要固定；方案目前只用单元素数组，没问题。
- 如果未来把 `requestState` 或 `proposalId` 注入模型上下文，就会引入不确定字节，不能这么做。

### 3. 有没有对应的自动检查，反向用例真的会失败？

**有测试框架，但有明显缺口：**

- `mcp-read.test.ts:225-233` 会在新增工具后失败，方案没有说要更新；这其实是好事，但必须处理。
- “restricted 内容”用例**不会真正失败**：如第 3 条，`classificationWithIdentifiers(text,"private")` 永远不会返回 restricted。
- “老版本客户端（断言没有任何服务端→客户端请求）”如果只是让 handler 提前返回，**不能证明 `legacyShim:false` 生效**；需要构造一次 legacy 请求让 handler 真的返回 `inputRequired`，断言得到 `-32603` 且没有 server→client 请求，或直接断言 `ServerOptions` 配置。
- “记忆删除后重放旧 state 不复活”可能**因为 `applyProposal` 看到 trashed 记录直接返回**而通过，不是因为 ledger 检查；必须做硬删除（`DELETE FROM memory_records` + 清 payload）再重放。
- 缺少：同 state 并发重放、discarded ledger 写失败、规范化后为空/超长、bidi/零宽、非法分类、配额、客户端名伪造、外部提案是否污染校准、`memory:mcp:` 来源显示。
- 过期测试需要 `ttlSeconds` 可注入或设小，文档没有时钟注入。

### 4. 每个新值/字段的使用方都能接受吗？

逐个核对如下：

- **`proposalId`**：进 memoryId、contentRef、ledger id、requestState。长度要满足：ledger id ≤128（`sqlite-decision-ledger-operations.ts:59`）、memoryId/sourceRef ≤256。UUIDv4 没问题。**contentRef 建议用独立前缀**（如 `memory-content:mcp:<proposalId>`），不要和 memoryId 同名，避免 payload/memory 两套命名空间混淆。
- **`memoryId = memory:mcp:<proposalId>`**：通过 `assertMemoryShape` 的非空检查（`sqlite-memory-operations.ts:606-652`）；但 `memory-source.ts:20-29` 不识别，会显示成 tidy。
- **`contentRef`**：`save` 会检查 payload 存在且 classification 与 memory 一致（`sqlite-memory-operations.ts:717-730`），必须先 protect 再 applyProposal。
- **`category`**：要同时通过 `MEMORY_CATEGORIES`（`packages/application/src/ports/memory-projection.ts:13-24`）和 ledger 的 `DECISION_CATEGORIES`（`sqlite-decision-ledger-operations.ts:100-101`）；`rule` 在工具 schema 和第一轮校验都要排除。
- **`reasonCode=mcp_proposal_kept` / `approval_rejected`**：ledger 只校验长度 ≤64，能通过；`approval_rejected` 会被 daily-review 跳过（`daily-review.ts:268`）；但 calibration 会把两者都算进 `memory_kept/memory_skipped`（`calibration/src/index.ts:266-269`、`:633-643`），需要显式排除或改用新 kind。
- **`subjectRef=<memoryId>`（kept）**：daily-review 会当记忆 id 读（`daily-review.ts:224-227`），长度 ≤256 通过；但记忆被硬删除后读不到，会显示 hidden，可接受。
- **`subjectRef=mcp-client:<客户端名>`（discarded）**：长度 ≤256；客户端名来自 `clientNameOf` 的正则，最多 64 字符；但它是自报的，不能当权威身份，且 daily-review 已跳过这类记录。
- **`inputs.memoryIds=[memoryId]`**：`idList` 要求唯一、每项 1–256（`sqlite-decision-ledger-operations.ts:42-48`），通过；但 `insertLedgerRow` 只持久化 4 个键（`:132-138`），方案没有依赖其他键，正确。
- **`policyVersion` / `inference` / `confidencePermille` / `importancePermille`**：方案没写。`policyVersion` 必须非空；需要定义一个 MCP 专用版本；`inference` 建议 false（主人确认），`confidencePermille` 1000，importance 沿用 500；如果要带 `category` 到 ledger，记得 `memory_candidate` 才允许这三列（`sqlite-decision-ledger-operations.ts:93-109`）。
- **`dataClassification`**：payload 和 memory 必须一致（`sqlite-memory-operations.ts:728-730`）；`restricted` 分支目前不可达，需要按第 3 条修正。
- **`clientName`**：会被写进 `subjectRef` 和确认框；自报、可伪造；不要当安全身份。
- **`requestState` payload**：codec 是签名不是加密，客户端可 base64 解码，不要放正文/秘密；payload 里的 `v:1` 与 codec 自己的 `v1` 重复，可去掉。key 至少 32 字节。
- **`legacyShim` / `requestState`**：配置在 `ServerOptions`，不是 `createMcpHandler`；这是最容易在实现时“看起来写了但没生效”的一处。
- **`MCP_READ_TOOL_NAMES` / prompt manifest / 现有 listTools 测试**：都需要同步改；不要把写工具塞进只读常量。

**结论**：方案方向可行，但必须先修三件事再动手：**独立写凭据/开关**、**SDK 配置位置**、**restricted 判定与测试**。其余是配额、状态存储、elicitation 绑定和来源/校准一致性的加固。
