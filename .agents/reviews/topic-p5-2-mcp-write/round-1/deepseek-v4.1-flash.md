## 结论先行

我建议：在现有 `/api/mcp/v1` 上**新增一个写工具 `propose_memory`**，与三个只读工具共用同一个 `BearerGate` 令牌，但写入能力用新配置显式打开。第一轮只返回 `input_required` + 表单 elicitation，**不写任何记忆**；客户端带 `inputResponses` 和签名过的 `requestState` 重发后，服务端校验签发、参数摘要、有效期和客户端能力，再用**由 proposalId 推导出的固定 memoryId/contentRef**落库。`legacyShim` 显式关闭，老客户端或不支持 elicitation 的客户端一律失败关闭，不写库。决策记录复用现有 `memory_candidate` 的 `kept`/`discarded`，不改表，但必须按现有读取端的要求设置 `subjectRef`，否则会踩到 I-73 那类“两端不一致”。

---

## 一、方案依赖的前提

### 协议与 SDK

1. 2026-07-28 版不再支持服务端中途主动请求，必须用 MRTR。
   来源：<https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr>
   原话：“The previous pattern of server-initiated requests is no longer supported.”

2. `requestState` 是攻击者可控输入，必须做完整性保护；需要“最多消费一次”时必须在服务端强制。
   来源同上。原话：“servers MUST treat requestState as an attacker-controlled input … MUST protect its integrity (e.g. HMAC or AEAD)”；“Servers for which a given requestState must be consumed at most once … MUST enforce that invariant server-side.”

3. 客户端没声明能力时，服务端不得发对应 `inputRequests`。
   来源同上。原话：“Servers MUST NOT send an inputRequests that the client has not declared support for in its capabilities.”

4. 重发时客户端把 `inputResponses` 和 `requestState` 放在 `tools/call` 参数里，JSON-RPC id 必须不同。
   来源：<https://modelcontextprotocol.io/specification/2026-07-28/server/tools>
   原话：“When retrying the request with input responses, clients include `inputResponses` and, if provided by the server, `requestState` in the request parameters”；“The JSON-RPC `id` MUST be different between the initial request and the retry.”

5. 官方 SDK 提供 `inputRequired()`、`inputRequired.elicit()`、`acceptedContent()`、`inputResponse()`、`ctx.mcpReq.requestState()`；`createRequestStateCodec` 用 HMAC-SHA256，密钥至少 32 字节，默认 TTL 600 秒，签名但不加密；`legacyShim` 默认开启，设为 `false` 可恢复“老版本连接上直接失败”。
   来源：<https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required.html>、<https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/requestStateCodec.html>
   原话：“createRequestStateCodec returns an HMAC-SHA256 { mint, verify } pair”；“MUST be at least 32 bytes”；“Set ServerOptions.inputRequired.legacyShim: false to fail loudly instead.”；“The codec is signed, not encrypted — the client can base64url-decode the payload. Keep secrets out of it.”

6. `createMcpHandler` 每个 HTTP 请求新建 server，2026-07-28 没有会话状态；跨轮状态只能放 `requestState`。
   来源：<https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/createMcpHandler.html>
   原话：“Creates an HTTP handler that serves the 2026-07-28 protocol revision from a per-request server factory”；“The factory runs once per HTTP request: a fresh instance serves every request, and the handler holds nothing between requests.”

7. Claude Code 在 2026-07-28 连接上声明 form/url elicitation，form 模式显示对话框。
   来源：<https://code.claude.com/docs/en/mcp>
   原话：“Claude Code declares `elicitation: {form: {}, url: {}}` on the following connections… Connections that use protocol revision 2026-07-28”；“Form mode: Claude Code shows a dialog with form fields defined by the server … Fill in the fields and submit.”
   Claude Code 的 v2 runtime 才支持 2026-07-28；v1 runtime 仍是旧协议。来源同上：“The v2 runtime is the same code on MCP TypeScript SDK 2.0, which adds MCP protocol revision 2026-07-28.”

### 仓库现状

8. 只读入口的鉴权、路由、失败处理已经成型，写入应复用同一端点和 `BearerGate`。
   来源：`apps/agent-service/src/production-mcp-read.ts:130-146`、`:342-376`。
   原话/代码：`createMcpHandler((context) => this.#server(...))`；`onRequest` 里 `const gate = mcp.admit(request.headers.authorization);`。

9. 发给模型的内容必须只在末尾追加；每轮变化的值只能放最后一条消息；序列化必须确定；工具集合尽量稳定。
   来源：`.claude/rules/prompt-prefix.md:27-29`、`:35`、`:44`、`:51`。
   原话：“固定的在前，会变的在后”；“每轮都会变的内容只放在最后一条用户消息里”；“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”；“同样的内容，每次都要序列化成同样的字节”；“工具集合尽量不变”。

10. 新提示词文字（包括工具说明）要登记进 `packages/prompt-catalog` 并过检查。
    来源：`packages/prompt-catalog/src/tools.ts:225-259`、`packages/prompt-catalog/prompt-manifest.json:327-346`、根 `package.json` 的 `check:prompt-catalog`。
    原话/代码：`fixedPrompt({ id: "mcp.find-memories", ... })`；manifest 里每个条目有 `sha256`、`changedIn`、`reason`。

11. 网页新建记忆的核心是：先 `protectText` 保护正文，再 `memory.create`，`#create` 用 `memory:owner:${idempotencyKey}` 作为 memory id；`applyProposal` 遇到同 id 同内容直接返回已有记录。
    来源：`apps/control-center/src/memory.ts:188-197`、`apps/agent-service/src/production-memory-control.ts:795-864`、`packages/application/src/services/durable-memory-service.ts:121-144`。
    原话/代码：`id: \`memory:owner:${command.idempotencyKey}\``；`if (sameProposal) { ... return existing; }`。

12. 决策记录有固定 kind/outcome CHECK；`append` 只落 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds` 四个键。
    来源：`packages/application/src/ports/decision-ledger.ts:30-51`、`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:64-72`、`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:113-146`、`docs/execution/specs/2026-11-09-decision-record-write-convention.md:35`。
    原话/代码：`memory_candidate: ["kept", "discarded", "pending_approval"]`；`(kind = 'memory_candidate' AND outcome IN ('kept', 'discarded', 'pending_approval'))`；`ON CONFLICT (id) DO NOTHING`。

13. 现有消费端对 `memory_candidate` 的 `subjectRef` 有隐含要求：kept 时把它当 memory id 用。
    来源：`packages/application/src/services/daily-review.ts:224-226`。
    原话/代码：`if (entry.kind === "memory_candidate" && entry.outcome !== "discarded") { const id = entry.subjectRef ?? entry.inputs.memoryIds[0]; ... }`
    另：`daily-review.ts:238` 定义 `OWNER_DECIDED_DISCARD = "approval_rejected"`，`:268` 会跳过该 reasonCode 的 memory_candidate。

14. I-73 的教训：产生值和消费值必须两端核对，不能只看 diff。
    来源：`docs/incidents-and-gates.md:112`。
    原话：“#207 的测试只测清单解析和展示，没有把清单里的引用交给发送消息的校验；双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」”。

15. 文本分类和正文保护已有现成入口。
    来源：`packages/sensitive-capture/src/identifiers.ts:20-28`、`apps/control-center/src/memory.ts:188-197`。
    原话/代码：`classificationWithIdentifiers(text, "private")` 在含证件号/凭据时返回 `"sensitive"`；网页端 `protectText(text, classification)`。

16. 目前只有一把 MCP 令牌，配置解析只认 `runPolicy.mcpRead.secretRef`。
    来源：`packages/platform-node/src/strict-configuration.ts:1081-1086`、`apps/agent-service/src/service-main.ts:1725-1761`。
    原话/代码：`rejectUnknown(input, ["secretRef"], field)`；`ref === mcpReadConfiguration.secretRef && purpose === MCP_READ_SECRET_PURPOSE`。

---

## 二、哪些是证实的，哪些是推测

**读代码或一手来源证实的：**

- MRTR 的流程、`requestState` 完整性/单次消费/能力声明要求。
- SDK 的 `inputRequired`、`acceptedContent`、`inputResponse`、`createRequestStateCodec`、`legacyShim` 开关。
- Claude Code 在 2026-07-28 上声明 `elicitation: {form: {}, url: {}}` 并显示表单对话框。
- 现有只读入口的代码结构、鉴权、路由和决策记录写法。
- 网页新建记忆的 id 规则、`applyProposal` 的同 id 幂等行为。
- 决策记录的 CHECK、`append` 只落四个键。
- `daily-review` 把 `memory_candidate` kept 的 `subjectRef` 当 memory id。

**未核实或推测：**

- 本检出没有 `node_modules`，我没有直接读到 `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-*.d.mts`；SDK 细节以官方 v2 文档为准。`ctx.era`、`ctx.mcpReq.envelope.clientCapabilities` 的精确 TypeScript 形状未在本仓库类型中核实。
- Claude Code 具体从哪个小版本开始稳定使用 2026-07-28 v2 runtime，文档给了版本区间，但最低可用版本要以验收机 `claude --version` 和 `/mcp` 实际协商结果为准。
- 生产是否单实例、状态签名密钥能否跨实例共享，未核实。
- Claude Code 在“主人点拒绝”后是否会自动重发，未核实；方案按“不自动重发”设计，并把拒绝返回成非 `isError` 的最终结果来降低重试概率。
- `memory_candidate` 记录进入每日回顾/校准后的展示效果，我只核对了代码路径，未跑真实 UI。

---

## 三、方案本身

### 3.1 开关与配置

建议新增一个可选配置块，缺省不启用写工具：

```text
runPolicy.mcpRead.secretRef        // 现有，外部客户端共用的 MCP 令牌
runPolicy.mcpWrite.stateSecretRef  // 新增，服务端专用 HMAC 密钥，>=32 字符
```

- `stateSecretRef` 对应的密钥用途写 `mcp-write-state`，**不发给任何外部客户端**；它只用于签 `requestState`。
- 只有 `mcpWrite` 存在时才注册 `propose_memory`。这样现有只读部署不会因为升级就悄悄多出写能力，外部客户端的工具列表也不会无谓变化。
- 如果配了 `mcpWrite` 却没有 `mcpRead`、没有对应 secret、或 memory 功能不可用，启动失败，错误码例如 `MCP_WRITE_RUNTIME_UNAVAILABLE`，不要静默降级。
- 鉴权仍走 `mcpRead.secretRef`，不新增第二把 MCP 令牌。`stateSecretRef` 不是令牌，是服务端签名密钥。

理由：写权限比读权限高；用显式开关把“升级即获得写能力”变成“主人/部署者明确打开”。这符合“写操作全部走确认，不留后门”。

### 3.2 工具定义

工具名：`propose_memory`，固定排在三个只读工具之后。

```json
{
  "name": "propose_memory",
  "description": "<登记在 prompt-catalog 的固定文字>",
  "inputSchema": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "minLength": 1, "maxLength": 2000 },
      "category": {
        "type": "string",
        "enum": ["identity", "preference", "relationship", "goal", "project",
                 "health", "finance", "event", "other"]
      }
    },
    "required": ["text"],
    "additionalProperties": false
  },
  "annotations": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  }
}
```

要点：

- **不要把 `confirm` 放进工具参数**。确认只能来自 elicitation 的 `inputResponses`，否则模型/客户端可以传 `confirm:true` 绕过确认框。
- `category` 默认 `other`；**先排除 `rule`**，因为规则提议要等另一个任务的“规则提议卡”。如果 Andy 认为 `rule` 只是普通记忆分类、不是规则提议，可以把 `rule` 加回来，但这是一个需要拍板的范围问题。
- 工具说明要写明：“调用后客户端会弹确认框；只有主人确认才写入；拒绝、取消、超时都不写入；不要把未确认说成已保存；同一次提议重发不会重复写入。”
- 工具说明、成功/失败/拒绝/不支持的结果文字都登记进 `packages/prompt-catalog`，例如 `mcp.propose-memory`、`mcp.propose-memory-saved`、`mcp.propose-memory-already-saved`、`mcp.propose-memory-declined`、`mcp.propose-memory-unsupported`、`mcp.propose-memory-failed`，并更新 `prompt-manifest.json` 的哈希和原因。确认框文案是给主人看的 UI 文字，不是发给模型的提示词；是否也登记为新的 `elicitation` 层，建议在 PR 里明确，不要让它变成无人审查的自由文本。

### 3.3 第一轮：只提示，不落库

处理 `propose_memory` 时：

1. 规范化正文：`text.trim()`，用现有 `singleLine` 同款规则去掉控制字符并限制 2000 字符；**确认框显示的文字、计算摘要的文字、最终存储的文字必须是同一份**。空文本直接工具错误，不弹框。
2. 校验 `category` 在允许集合内；不允许 `rule`（若最终决定排除）。
3. 用 `classificationWithIdentifiers(text, "private")` 算分类；如果结果是 `sensitive`，确认框里明确写“这条会按敏感记忆保存”。
4. 检查 memory generation 是否存在（`book.latestGeneration(scope)`）；没有就返回“记忆功能尚未就绪”，不弹框。
5. 生成 `proposalId = randomUUID()`，计算规范参数摘要：
   ```text
   argsHash = sha256(["propose_memory", text, category].join("\0"))
   ```
6. 签名 `requestState`：
   ```text
   { v: 1, tool: "propose_memory", phase: "await_confirm", proposalId, argsHash }
   ```
   用 `createRequestStateCodec` 的 `mint`，TTL 建议 600 秒；`bind` 至少绑定 `ctx.mcpReq.method`（`tools/call`），如果能拿到认证主体再绑定主体。
7. 返回：
   ```text
   inputRequired({
     inputRequests: {
       confirm: inputRequired.elicit({
         message: "请确认是否把下面的内容写入 Himawari 的长期记忆。\n类别：...\n来源：调用方界面" +
                  (sensitive ? "\n注意：这条会按敏感记忆保存。" : "") +
                  "\n\n" + text,
         requestedSchema: {
           type: "object",
           properties: {
             confirm: { type: "boolean", title: "确认写入这条记忆" }
           },
           required: ["confirm"],
           additionalProperties: false
         }
       })
     },
     requestState: await codec.mint(state, ctx)
   })
   ```
   这一轮**不创建 payload、不创建 memory、不写决策记录**。拒绝/取消/超时天然无副作用。

### 3.4 重发：先认提议，再决定是否落库

收到带 `requestState` 的 `tools/call` 时：

1. SDK 的 `requestState.verify` 先跑；签名坏、过期、bind 不匹配都会在进入 handler 前被拒（`-32602`），不写库。
2. handler 读取 `ctx.mcpReq.requestState<WriteState>()`，检查：
   - `tool === "propose_memory"`；
   - `phase === "await_confirm"`；
   - 重新计算当前参数的 `argsHash`，必须和 state 里的相同。不同则返回工具错误“提议内容已变化，请重新发起”，不写库，也不再弹一次旧确认。
3. 先查“这个提议是否已经决定过”：
   - kept 决策 id：`ledger:mcp-write:<proposalId>:kept`；
   - discarded 决策 id：`ledger:mcp-write:<proposalId>:discarded`。
   用 `DecisionLedgerPort.read` 查。kept 存在就返回“已写入过”，discarded 存在就返回“已拒绝过”，都不再写。
4. 读 `inputResponse(ctx.mcpReq.inputResponses, "confirm")`：
   - `missing`：用同一个 `proposalId` 和 `argsHash` 重新 mint 一个 state，再返回一次同样的确认请求；不写库。不要生成新的 proposalId。
   - `elicit` 且 `action === "decline"` 或 `"cancel"`：走拒绝路径，不写记忆。
   - `elicit` 且 `action === "accept"`，但 `content.confirm !== true`：按拒绝处理，不写记忆。
   - `elicit` 且 `action === "accept"` 且 `confirm === true`：走写入路径。
   - 其他 kind 或畸形内容：返回工具错误，不写库。
5. 没有 `requestState` 但带了 `inputResponses`：**一律不写**，按“没有有效提议”处理，要求重新发起确认。不能因为参数里出现“同意”就落库。

### 3.5 写入路径：与网页新建记忆共用一套

不要把网页 `#createMemory` 的 attributes 组装复制一份到 MCP。建议抽出共用的 `OwnerMemoryWriter`（或在 `ProductionMemoryControl` 上开一个公开方法），网页 `#create` 和 MCP 写入都调用它：

```text
memoryId   = `memory:mcp-write:${proposalId}`
contentRef = `memory-content:mcp-write:${proposalId}`
```

写入步骤：

1. 规范化后的 `text` 用 `classificationWithIdentifiers(text, "private")` 分类。
2. `payloads.get(contentRef)`：
   - 不存在：`protector.protect({ ref: contentRef, dataClassification, contentType: "text/plain", plaintext: utf8(text), createdAt: clock.now() })`，再 `payloads.put`；遇到 `DUPLICATE` 就重新 `get` 并比对 digest/分类。
   - 已存在：比对内容 digest 和分类；不同则冲突，不写。
3. `book.latestGeneration(scope)` 取 generation；没有则失败。
4. 组装和网页一致的 proposal：`sourceThreadId: null`、`sourceRefs: [contentRef]`、`inference: false`、`confidencePermille: 1000`、`policyVersion: "memory-mcp-write:v1"`、`attributes` 与网页 `#createMemory` 相同（category、importance、entities、validFrom/validTo、supersededBy、evidenceVerified，sensitive 时加 `sensitiveTopic`）。
5. `memory.applyProposal(proposal, generationId, ledgerWrite)`，把 kept 决策记录作为第三个参数传入，让它和 memory 在同一个 SQLite 事务里落库（`sqlite-memory-operations.ts:668-705` 的 `saveWithProjection` 会调用 `insertLedgerRow`）。
6. 如果 memory 已存在且同内容：返回“已写入过”，不重复写 ledgers；如果 id 已存在但内容不同：冲突错误，不覆盖。

关键点：**memory id 和 contentRef 只由 proposalId 推导，不由时间、随机数或重发次数推导**。同一个 proposalId 的重发永远命中同一个 memory；预检查 + 数据库唯一约束 + `insertLedgerRow ON CONFLICT DO NOTHING` 共同保证“只落一次”。

### 3.6 决策记录

不改 `decision_ledger` 表，复用现有 `memory_candidate`：

**确认写入（kept）：**

```text
id:        ledger:mcp-write:<proposalId>:kept
kind:      memory_candidate
outcome:   kept
reasonCode: mcp_write_kept
subjectRef: <memoryId>          // 必须是 memory id，daily-review.ts:225 会拿它读记忆
inputs:    { memoryIds: [memoryId], ruleIds: [], resultMemoryIds: [memoryId] }
contentRef: <contentRef>
category:   <category>
confidencePermille: 1000
inferred:   false
costMicros: 0
durationMs: ...
decidedAt:  clock.now()
```

**拒绝/取消（discarded）：**

```text
id:        ledger:mcp-write:<proposalId>:discarded
kind:      memory_candidate
outcome:   discarded
reasonCode: approval_rejected   // 复用 daily-review 已有的 OWNER_DECIDED_DISCARD
subjectRef: mcp-client:<client>
inputs:    { memoryIds: [], ruleIds: [] }
contentRef: null
category:   <category>
confidencePermille: null
inferred:   null
costMicros: 0
durationMs: ...
decidedAt:  clock.now()
```

为什么这样写：

- `memory_candidate` 的 `kept`/`discarded` 现成合法，不需要迁移。
- kept 的 `subjectRef` 必须是 memory id。`daily-review.ts:225` 在 kept 时把 `subjectRef` 当 memory id；如果这里写 `mcp-client:Claude`，每日回顾会去读一个不存在的 memory，这是典型的 I-73 两端不一致。
- discarded 用 `reasonCode: "approval_rejected"`，`daily-review.ts:268` 会直接跳过，避免拒绝记录在每日回顾里变成空白条目；`subjectRef` 写客户端名不会影响该路径。
- 用确定性 ledger id 兼作“已决定”标记：kept 记录存在时，即使 memory 后来被删除，也不会被旧 state 重新创建；discarded 记录存在时，旧 state 不会被事后改成同意。
- kept 的 ledger 和 memory 在同一事务里：决策记录写不进去，memory 也不会落库，保持“每次外部写入都有一条记录”。

**注意：** 如果“拒绝则不落库”被解释为“拒绝时连决策记录也不能写”，那么拒绝路径只能写进程日志，不能写 `decision_ledger`。代价是同一 `requestState` 事后被改成同意时无法用持久标记拦截。这一点需要 Andy 拍板。

### 3.7 不支持、老版本、取消、失败

| 情况 | 行为 |
|---|---|
| 现代客户端未声明 form elicitation | 先检查 `_meta.clientCapabilities`，没有就返回固定工具错误“此客户端不支持确认写入，未写入”；即使漏检，SDK 也会以 `-32021` 拒绝，且不写库。 |
| 2025 老版本连接 | handler 先看 `ctx.era === "legacy"`（或等价的协商版本）直接返回“需要 2026-07-28 版客户端，未写入”，**不返回 inputRequired**；同时 `McpServer` 设 `inputRequired: { legacyShim: false }`，万一漏掉分支也会失败关闭，不会改用旧式服务端主动请求。 |
| 主人拒绝 | 返回非 `isError` 的最终结果“已拒绝，没有写入”，避免外部模型把拒绝当失败自动重试；写 discarded 决策记录（若允许）。 |
| 主人取消 / 关闭对话框 | 同拒绝；必要时 reasonCode 仍用 `approval_rejected`，区分只放诊断日志。 |
| 客户端不重发、连接断开 | 第一轮没有写任何东西，天然无副作用；state 过期后重发得到 `-32602`，要重新发起。 |
| state 被篡改/过期 | SDK `-32602`，不写库。 |
| 参数被改但 state 有效 | handler 的 `argsHash` 不匹配，工具错误，不写库，不弹旧确认。 |
| 接受但 `confirm` 不是 true | 按拒绝处理，不写库。 |
| 写入成功后的重发 | 查到 kept 决策记录或已有 memory，返回“已写入过”，不重复落库。 |
| 写入失败（payload/ledger/memory 任一失败） | 返回固定失败文字，不泄露数据库错误；如果 ledger 写失败，事务回滚 memory。 |

---

## 四、考虑过但不选的做法

1. **只靠工具参数做幂等，不用 `requestState`。**
   不选。参数相同的“新调用”和“重发”无法区分，而且无法证明确认发生过。重发必须带签名 state。

2. **在服务端建 pending proposal 表。**
   不选。要新表、迁移、清理和并发状态机；MRTR 的目的就是让服务端无状态。当前用签名 state + 确定性 memory id 已足够。

3. **把完整提议正文放进 `requestState`。**
   不选。正文已经在工具参数里；state 只放 proposalId 和摘要，body 更小，也避免把可能敏感的内容塞进客户端可解码的签名串。

4. **用 MCP 令牌本身当 `requestState` 的 HMAC 密钥。**
   不选。令牌发给所有外部客户端，持有令牌的一方能伪造 state。用服务端专用 `mcp-write-state` 密钥至少能阻止“只有网络访问权、没有签名密钥”的篡改。
   但要明确：这仍然不能证明“人真的点了同意”，因为客户端拿到合法 state 后可以自己回一个 `accept`。

5. **打开 SDK 默认的 `legacyShim`。**
   不选。它会在老连接上改用旧式服务端主动请求，直接违反“不用旧方式”的要求。必须显式关闭，并在 handler 里给老客户端一个明确的失败结果。

6. **在工具参数里加 `confirm: true`。**
   不选。这是后门，模型或客户端可以绕过确认框。

7. **每个重发都重新生成 memory id。**
   不选。会重复落库。id 必须由 proposalId 推导。

8. **用正文哈希做 memory id，按文字去重。**
   不选。主人可能确实想保存两条相同文字但不同来源/时间的记忆；而且新调用应该重新确认，不能因为文字相同就静默合并。

9. **新建 `external_write` 决策 kind。**
   语义最干净，但要改 `decision_ledger` 的 CHECK，属于“改表要排队”。本方案先用现有 `memory_candidate` 避开迁移；如果 Andy 认为 kept 记录里必须保留客户端名、或者不愿让外部写入进入每日回顾，再排期加 `external_write` 迁移。

10. **用 `external_read` 记录写操作。**
    不选。kind 和 outcome 语义都不对，抽屉会显示成“外部读取”。

11. **拒绝时也写一条 memory 记录再删。**
    不选。违反“拒绝则不落库”，也会产生无意义的记忆历史。

12. **在确认框里允许主人编辑正文。**
    第一版不选。编辑后正文和 `argsHash` 不一致，需要重新定义“编辑后的提议”及幂等语义；网页已有编辑能力，外部提议先只做“确认/拒绝”。

---

## 五、风险与反例

1. **MRTR 不能证明“人真的确认了”。**
   服务端只能验证 state 是它签发的、参数没变、TTL 内；它无法验证客户端确实把对话框展示给了主人。持有令牌的恶意客户端可以先调用一次拿到合法 state，然后直接回 `accept`，不弹框。这是协议信任模型决定的，不是 HMAC 能解决的。风险缓解：令牌只发给可信客户端、记录客户端名、以后需要更强保证时用 OAuth/每客户端凭据或客户端签名回执。

2. **只有一把共享令牌。**
   任何拿到令牌的客户端都能提议写入。虽然仍要经过确认流程，但令牌泄露的影响比只读大。建议至少给写入口单独的启用开关和审计日志；更彻底的是以后拆成每客户端令牌。

3. **`memory_candidate` 复用会影响现有消费端。**
   - kept 记录会出现在每日回顾的 `memory_kept` 分组；这可能是好事，也可能被主人视为噪音。
   - kept 的 `reasonCode: mcp_write_kept` 不在校准门槛的 `gatedReasons` 里，`gateSamples` 会把它记成 `notGated`；不会参与阈值样本，但会改变报告里的 notGated 计数。
   - 若 kept 的 `subjectRef` 写成客户端名，会直接踩坏每日回顾；必须写 memory id。
   这是选择“不改表”的代价。

4. **拒绝记录的持久化失败。**
   discarded 的 ledger 写失败时，无法用 ledger 做“已拒绝”标记。当前建议：记录日志并返回失败，提示客户端不要再重试；但旧 state 理论上仍可能被改成同意。若要彻底封死，需要额外的墓碑存储或接受“改表”。

5. **TTL 与人类操作时间。**
   默认 600 秒可能不够主人慢慢看；可以改 900 秒。TTL 越长，旧 state 可被重放的窗口越大。需要拍板。

6. **外部客户端工具列表会变化一次。**
   新增 `propose_memory` 后，Claude Code 等客户端下一次 `tools/list` 会多一个工具，外部 agent 自己的模型请求前缀会变一次。这不是 Himawari 的 prompt cache 能控制的，也无法通过“只在末尾追加”避免；只能保证工具定义固定、顺序固定、不按连接变化。MCP 规范也要求工具集合不能 per-connection 变化。

7. **提示词目录的 trusted 文本集合变大。**
   新增工具说明会进入 `TRUSTED_PROMPT_TEXTS`（`packages/prompt-catalog/src/trusted.ts:10-14`）。现有提示词文字不改，理论上不会改变旧对话的字节；只有当某条旧消息里恰好逐字包含新登记的固定文字时，遮盖结果才可能变一次。这个概率很低，但应在 PR 里说明。

8. **正文可能含敏感信息或终端控制字符。**
   确认框必须显示主人真正要保存的内容，不能遮；但要用 `singleLine` 同款规则去掉控制字符，避免终端注入/换行欺骗。不要把这个正文写进日志或诊断事件。

9. **多实例部署。**
   `requestState` 的 HMAC 密钥必须所有实例共享；每个进程随机生成会导致重发落到另一个实例时全部 `-32602`。

10. **旧 state 在 memory 被删除后重放。**
    如果只查 memory 是否存在，删除后旧 state 可能把记忆“复活”。所以 kept 决策记录要先查，存在就返回“已写入过”，不再创建。

11. **`memory_candidate` 的 kept 记录和 payload 的 FK。**
    kept 的 `contentRef` 指向 payload，`decision_ledger.content_ref` 是 `ON DELETE RESTRICT`；以后删除记忆时要注意 payload 清理顺序。现有 `memory_candidate` 也是同样做法，但外部写入会新增这类引用。

12. **客户端把拒绝当失败自动重试。**
    所以拒绝/取消返回非 `isError` 的最终结果；如果客户端仍自动重试，会重新开始一个新提议并再次弹框，不会重复落库。

---

## 六、需要人拍板的取舍

1. **写工具是否必须显式配置开启？**
   我建议是：新增 `runPolicy.mcpWrite.stateSecretRef`，缺省不注册写工具。若希望“配了 mcpRead 就自动有写”，可以去掉开关，但现有令牌会立即获得写能力。

2. **`requestState` 用服务端专用密钥，还是复用 MCP 令牌派生？**
   我建议专用密钥；它不发给客户端，更符合规范。若不想增加密钥管理，退而用 MCP 令牌派生并在 ADR 里写明“持有令牌者可伪造 state，确认只依赖客户端自觉”。

3. **拒绝时是否写决策记录？**
   我建议写一条 discarded，但不含正文；如果“拒绝则不落库”是严格解释，则只写日志，并接受“旧 state 事后被改成同意”的残余风险。

4. **决策记录复用 `memory_candidate`，还是排期加 `external_write`？**
   我建议本次复用，避免改表；如果要求 kept 记录里明确保留客户端、或不想让外部写入进入每日回顾/校准报告，就排期加新 kind。

5. **`category` 是否允许 `rule`？**
   我建议本次排除，等规则提议卡任务；如果认为“记忆分类为 rule”不等于“规则提议”，可以加回。

6. **确认框是否允许编辑正文？**
   第一版建议不允许；允许编辑会改变 `argsHash` 和“同一次提议”的定义，需要另做设计。

7. **TTL 取 10 分钟还是 15 分钟？**
   我建议 10 分钟；如果主人经常慢慢看，可改 15 分钟。

8. **是否把 memoryId 返回给外部 agent？**
   我建议不返回，只返回“已写入/已拒绝/已写入过”的固定文字；外部 agent 目前没有按 id 修改/删除的工具，返回内部 id 没有用处，反而多一个泄露面。

---

## 七、自动检查与验收

### 7.1 正向测试

- `test/integration/mcp-write.test.ts`，用真实 SQLite、真实 `DurableMemoryService`、官方 SDK 客户端：
  - `tools/list` 列出四个工具，前三个 `readOnlyHint: true`，`propose_memory` 为 false，顺序固定。
  - 现代客户端第一次调用返回 `input_required`，此时 memory 表、payload 表、decision_ledger 都没有新增。
  - 客户端回答 `accept + confirm:true` 后，memory 落库，`find_memories` 能查到，kept 决策记录存在，`subjectRef` 是 memory id。
  - 同一个 `requestState` 再次 accept，memory 仍只有一条，ledger 仍只有一条，返回“已写入过”。
  - `decline`、`cancel`、`accept + confirm:false` 都不产生 memory；discarded 记录按约定存在或不存在。
  - 拒绝后用同一 state 改成 accept，不产生 memory（若采用 discarded 标记）。
- `apps/agent-service/test/production-mcp-write.unit.test.ts`：
  - `argsHash` 对 trim/默认 category 的规范化稳定。
  - 同一 proposal 重发得到同一 memoryId/contentRef。
  - 不同 proposal 即使文字相同，memoryId 不同。
  - 确认框文案包含完整正文和类别。
- `packages/platform-node/test/startup-configuration.unit.test.ts`：
  - 没有 `mcpWrite` 时不注册写工具。
  - `mcpWrite.stateSecretRef` 必须是 `mcp-write-state` 用途，长度 >=32。
  - 配了 `mcpWrite` 但 memory 不可用/没有 `mcpRead` 时启动失败。
- `packages/prompt-catalog` 对应检查：新条目、manifest 哈希、`usedBy`、固定文字检查都通过。
- `test/integration/mcp-read.test.ts` 更新工具数量断言，读工具行为不变。

### 7.2 反向用例（去掉保护后必须失败）

- 去掉 `argsHash` 校验：带旧 state 改正文的重发会落库，测试必须失败。
- 去掉 `requestState.verify`：篡改 state 的重发被接受，测试必须失败。
- 去掉 `legacyShim: false` 或去掉 era 分支：老客户端测试观察到服务端主动请求或发生写入，测试必须失败。
- 去掉 memoryId 的确定性：同一 state 重发产生两条 memory，测试必须失败。
- 去掉 kept 决策记录预检查：memory 删除后旧 state 能复活，测试必须失败。
- 去掉 discarded 标记：拒绝后旧 state 改成 accept 能落库，测试必须失败。
- 把 kept 的 `subjectRef` 改成 `mcp-client:...`：`daily-review` 集成测试会尝试读取不存在的 memory，必须失败。
- 把 memoryId 改成含 `/` 的值：domain `MACHINE_IDENTIFIER_PATTERN` 或持久化契约测试必须失败（I-73）。
- 把 `reasonCode` 写到超过 64 字符：`validateLedgerWrite` 必须失败。
- 去掉 `legacyShim` 能力检查：没有 elicitation 能力的现代客户端应得到友好失败；测试必须失败。
- 在没有 `requestState` 但带 `inputResponses` 时落库：绕过确认测试必须失败。
- 工具说明里放入当前时间/随机值：连续两次 `tools/list` 的字节稳定性测试必须失败。
- 去掉 `inputRequired` 能力声明检查：SDK 应返回 `-32021`，测试必须失败或观察到协议错误。

### 7.3 Claude Code 端到端验收

1. 确认 Claude Code 走 v2 runtime 和 2026-07-28：
   ```bash
   claude --version
   MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto claude
   ```
   具体版本以文档和 `/mcp` 显示为准；v1 runtime 只会走旧协议，写入应失败关闭。
2. 添加服务：
   ```bash
   claude mcp add --transport http himawari https://<host>/api/mcp/v1 \
     --header "Authorization: Bearer <MCP 令牌>"
   ```
   在 `/mcp` 里确认连接、工具数为 4、协议为 2026-07-28。
3. 正向：
   - 对 Claude Code 说“记住：我每周三晚上去游泳”。
   - 应出现表单确认框，显示完整正文和类别；勾选“确认写入这条记忆”并提交。
   - Claude Code 返回“已写入”；Himawari 控制中心的记忆列表出现这条；`find_memories` 能查到；决策记录出现 `memory_candidate/kept`，`subjectRef` 是这条 memory 的 id。
4. 拒绝：
   - 再提议一条，点拒绝；控制中心不应出现新记忆；同一调用不重复弹框、不落库。
5. 重发：
   - 用测试客户端或再次触发同一 `requestState` 的重发；memory 仍只有一条。
6. 老客户端：
   - 用 `MCP_PROTOCOL_NEGOTIATION=legacy` 或 v1 runtime 调用 `propose_memory`；应得到“需要 2026-07-28 版客户端，未写入”，Himawari 端没有新记忆，也不应出现旧式服务端主动请求。

---

## 八、必答问题逐条回答

### 1. 这个改动会不会改变模型已经见过的请求开头？

**对 Himawari 自己的模型请求：不会。**
我没有改系统提示、Himawari 聊天工具定义、历史消息或出口遮盖算法；新增的 `propose_memory` 只注册在外部 MCP server 上，不进入 Himawari 对话的工具集合。写入路径只产生 memory/payload/decision 数据，不参与 Himawari 的请求组装。发给模型的既有内容仍然只在末尾追加；每轮会变的值（本轮时间、记忆、资料）仍按现有规则只放最后一条消息。依据：`.claude/rules/prompt-prefix.md:27-29`、`:35`。

**对调用方外部 agent 自己的模型请求：会变一次。**
`tools/list` 多一个 `propose_memory`，外部客户端下一次把工具定义发给它自己的模型时，前缀会变一次。这不是 Himawari 能控制的缓存；MCP 规范要求工具列表在底层集合不变时保持确定顺序，不能按连接变化。我们可以保证工具顺序固定、说明文字固定、不含时间/随机值，所以只变一次，之后稳定。依据：MCP tools 规范“Servers SHOULD return tools in a deterministic order”；本仓库 `.claude/rules/prompt-prefix.md:44`。

**遮盖结果：现有文字不变，新增固定文字进入 trusted 集合。**
新增 prompt-catalog 条目会增加 `TRUSTED_PROMPT_TEXTS` 的成员（`packages/prompt-catalog/src/trusted.ts:10-14`）。只有当某条旧消息恰好逐字包含这些新固定文字时，旧对话的遮盖结果才可能变一次；正常对话不会。没有修改旧条目，所以不会主动改变已发出的系统提示或历史。

**结论：** “发给模型的内容仍然只在末尾追加、每轮变化的值都在最后一条消息里”对 Himawari 成立；外部 agent 的工具定义是新增能力带来的一次性变化，不是每轮变化，也不是 Himawari 历史前缀变化。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

写入路径本身是确定性的：

- 正文先规范化，确认框显示的文字、计算摘要的文字、存储的文字是同一份。
- 同一个 proposalId 重发，memoryId、contentRef、决策记录 id 都相同；固定数组长度（`memoryIds: [memoryId]` 或 `[]`），没有无序集合。
- 工具定义、工具顺序、工具说明都是固定字节，不含时间、随机值、服务商名、额度、版本号。
- `requestState` 里确实有 proposalId 和过期时间，因此每次 mint 的**不透明串**可能不同；但它不是发给模型的内容，是协议控制字段，且客户端不得解析。签名串里不放正文或秘密。
- 决策记录的 `decidedAt`、`durationMs` 会随实际时间变化，memory 的 `updatedAt`/`recordedAt` 也会变；这些是数据/审计值，不进入 Himawari 的模型请求前缀。现有 `find_memories` 本来就会返回 `updatedAt`/`recordedAt`/`lastUsedAt` 这类随时间变化的值，这是只读入口的既有行为，不是本次写工具引入的；如果要求只读输出也严格确定，需要另开任务处理。

一个例外需要明确：**同一段文字如果作为两次新的提议**（没有同一个 `requestState`），会得到不同的 proposalId 和 memoryId。这不是“同一请求变成不同字节”，而是“两个不同的提议”；如果希望按文字去重，那是产品决策，本方案不做。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，且反向用例要覆盖“去掉保护就变红”：

- `test/integration/mcp-write.test.ts`：正反两向，覆盖 accept/decline/cancel/重发/并发/老客户端/无能力客户端/篡改 state/改参数/expired state。
- `apps/agent-service/test/production-mcp-write.unit.test.ts`：规范化、摘要、确定性 id、确认文案。
- `packages/platform-node/test/startup-configuration.unit.test.ts`：新配置键、用途、长度、缺项启动失败。
- `packages/prompt-catalog` 检查 + manifest：新工具说明和结果文字必须登记。
- `test/integration/mcp-read.test.ts`：原有三个只读工具不回归，工具顺序固定。
- `test/integration/daily-review.test.ts` 或新增用例：kept 的 `subjectRef` 必须是 memory id；discarded 的 `approval_rejected` 被跳过。
- `test/integration/decision-chain.test.ts`：新 decision 记录能被读取端列出，且四个键完整。
- `apps/agent-service/test/production-http-composition.unit.test.ts`：没配写工具时 404/工具不存在；配了时令牌可用，没令牌 401 且不写库。

反向用例必须真的失败，而不是只写注释。例如：把 `argsHash` 校验删掉，改正文重发用例应看到两条 memory；把 `legacyShim` 打开，老客户端用例应观察到服务端主动请求；把 kept 的 `subjectRef` 改成客户端名，daily-review 用例应因读取不到 memory 而失败。上一节“7.2”已逐条列出。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对如下（这是 I-73 的重点）：

| 产生的值 | 产生处 | 使用处/校验 | 结论 |
|---|---|---|---|
| `proposalId` UUID | 写 handler | `requestState` payload、memoryId、contentRef、ledger id | 仅内部使用；不返回外部模型 |
| `memoryId = memory:mcp-write:<uuid>` | 写服务 | domain `MACHINE_IDENTIFIER_PATTERN`（`identifiers.ts:39`，1-128，`A-Za-z0-9._:-`）；`memory_records.id` 主键；`memory.overview`/`find_memories`；decision `inputs.memoryIds`（每项 1-256） | 通过；长度约 54，字符合法 |
| `contentRef = memory-content:mcp-write:<uuid>` | 写服务 | `payloads.ref` 主键/FK；`memory_records.content_ref` FK；`memory_history_events.content_ref` FK；`sourceRefs` | 通过；payload ref 无额外长度限制，长度远小于限制 |
| `ledger id = ledger:mcp-write:<uuid>:kept/discarded` | 写服务 | `decision_ledger.id` 1-128；`insertLedgerRow ON CONFLICT`；`DecisionLedgerPort.read` | 通过；长度约 58-63 |
| `kind = memory_candidate` | 写服务 | `validateLedgerWrite` 的 `DECISION_KINDS`；SQL CHECK；`readReviewPool`；`daily-review`；calibration | 合法；但 daily-review/calibration 会看到它，见风险 3 |
| `outcome = kept/discarded` | 写服务 | `DECISION_OUTCOMES`；SQL CHECK；daily-review | 合法 |
| `reasonCode = mcp_write_kept` | 写服务 | `validateLedgerWrite` 只查长度 1-64；daily-review 按值分组 | 通过；不在校准 `gatedReasons`，会记 `notGated` |
| `reasonCode = approval_rejected` | 写服务 | 同上；`daily-review.ts:268` 明确跳过 | 通过，且避免拒绝记录出现在每日回顾 |
| `subjectRef` kept = memoryId | 写服务 | `validateLedgerWrite` 长度 1-256；`daily-review.ts:225` 当 memory id 读 | **必须这样写**；写客户端名会坏 |
| `subjectRef` discarded = `mcp-client:<client>` | 写服务 | 长度 1-256；`clientNameOf` 正则最多 64；daily-review 对 discarded 不走 memory id 分支 | 通过 |
| `category` | 写服务 | `MEMORY_CATEGORY_NAMES`（`contracts-v2.ts:942-953`）；`memory_records.category` CHECK（`0052_memory_engine.sql:1`）；decision `category` CHECK | 通过；本方案排除 `rule`，是允许集合的子集 |
| `confidencePermille = 1000`、`inferred = false` | 写服务 | `validateLedgerWrite` 0-1000；SQL CHECK；`memory_records.confidence_permille` CHECK；只有 memory_candidate 允许这些字段 | 通过 |
| `inputs.memoryIds` | 写服务 | `idList` 每项 1-256、唯一、最多 200；JSON object | 通过；单条记忆 |
| `contentRef`（decision） | 写服务 | `decision_ledger.content_ref` FK 到 payloads；`ON DELETE RESTRICT` | 通过；但删除记忆时要处理 payload 引用，见风险 11 |
| `costMicros = 0`、`durationMs` | 写服务 | `validateLedgerWrite` 安全整数、0-86400000 | 通过；`durationMs` 实测 |
| `dataClassification` | `classificationWithIdentifiers` | `payloads.classification` CHECK；`memory_records.classification` CHECK；`#createMemory` 拒绝 `restricted` | 通过；从 `private` 出发只会得到 private/sensitive，不会 restricted |
| `policyVersion = memory-mcp-write:v1` | 写服务 | `memory_records.policy_version` 非空；无枚举 CHECK | 通过 |
| `sourceRefs = [contentRef]` | 写服务 | `assertMemoryShape` 要求非空；每项非空 | 通过 |
| 工具名 `propose_memory` | 注册处 | MCP 工具名规则；Claude Code 工具名长度限制；现有测试常量 | 通过；1-128、字符合法 |
| 工具说明/结果文字 | prompt-catalog | `check:prompt-catalog`、manifest 哈希、`usedBy`；`TRUSTED_PROMPT_TEXTS` | 必须登记并更新 manifest |
| 新配置 `runPolicy.mcpWrite.stateSecretRef` | 配置解析 | `parseRunPolicy` 的 `rejectUnknown`、`secretReferences` 用途 `mcp-write-state`、长度 >=32；启动组装 | 必须同时改解析、校验、启动和测试；否则配置会被拒或静默无效 |
| `requestState` 字段 | 写 handler | SDK codec mint/verify；`ctx.mcpReq.requestState`；handler 的 tool/phase/argsHash 校验 | 通过；不要放正文/秘密 |

特别注意两个 I-73 式反例：

- **kept 的 `subjectRef` 不是 memory id。** 现有 `daily-review.ts:225` 会把它当 memory id 去读，导致每日回顾找不到记忆。必须写 memory id。
- **新配置键没同步到解析器和 `secretReferences` 校验。** 会出现“配置写了但启动被拒/静默不注册”的错位。必须按 `parseMcpRead` 的模式同时加 `parseMcpWrite`、`rejectUnknown`、`MCP_WRITE_STATE_SECRET_PURPOSE` 和启动时 `find(...)`。

---

## 九、一句话总结

写工具 `propose_memory` 用 MRTR 表单确认，第一轮零落库；重发用 HMAC 签名 state + 参数摘要 + 确定性 memoryId/contentRef + kept/discarded 决策记录，做到同一个提议只落一次；老客户端和不支持 elicitation 的客户端失败关闭；决策记录复用 `memory_candidate` 以避开改表，但 kept 的 `subjectRef` 必须写成 memory id，否则会破坏每日回顾。
