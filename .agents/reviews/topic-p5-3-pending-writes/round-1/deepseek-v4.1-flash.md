## 结论

我建议：**不要复用 `attributes.tentative`，也不要复用 `memory_approval_requests`**。新增一张独立的「外部记忆提议收件箱」表：外部 agent 的提议先只存进这张表，**在主人确认前不产生 `memory_records` 行**；主人在记忆页顶部批量确认；确认时才复用现有 `#createMemory` / `applyMemoryProposal` 落成正式记忆，编号用 `memory:mcp:<proposalId>`。

这样做的核心原因是：现有 `tentative` 记忆**会**被主动检查和聊天检索当成线索召回，直接复用会违反目标 2。

---

## 一、方案依赖的前提

### 已读代码或一手来源证实的

1. **现有 MCP 入口是只读的，路径 `/api/mcp/v1`，三个只读工具。**
   `apps/agent-service/src/production-mcp-read.ts:32-35`：`MCP_READ_PATH = "/api/mcp/v1"`，`MCP_READ_TOOL_NAMES = ["find_memories", "today_context", "rule_book"]`。
   同一文件 `:143-145` 用 `createMcpHandler`，`:360` 先过 `BearerGate`。

2. **MCP 2026-07-28 明确规定：客户端没声明 elicitation，服务端不得发 elicitation 请求。**
   <https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr> 原话：
   > “Servers **MUST NOT** send an `inputRequests` that the client has not declared support for in its capabilities. For example, if a client does not declare support for `elicitation`, the server **MUST NOT** include any `elicitation/create` requests…”

   所以“不能弹框的客户端”不能靠“发一次 elicitation、失败了再兜底”，必须在发之前判断能力。

3. **现有 `tentative` 不是“完全不参与”，它会进入主动检查和聊天检索。**
   `docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:32` 原话：
   > “它不进主人档案块……默认不进向量检索，但**主动检查和聊天检索工具会把它当线索召回**。”

   代码依据：
   - `apps/agent-service/src/production-memory-recall.ts:190-214`：聊天检索第二次检索 `includeTentative: true`、`tentativeOnly: true`。
   - `apps/agent-service/src/production-proactive-memory.ts:48`：主动检查 `includeTentative: true`。
   - `packages/application/src/services/owner-profile-service.ts:110`：`tentative === true` 不进档案块。
   - `packages/memory-engine/src/consolidation.ts:242`：整理时排除 tentative。

   结论：外部待确认提议**不能**用 `tentative` 实现，否则会改变现有“tentative 可当线索”的语义，且无法满足目标 2“不参与任何回答、主动检查、记忆整理、档案块”。

4. **现有敏感记忆审批表要求 `run_id`、`thread_id`、`generation_id` 都非空。**
   `packages/persistence-sqlite/src/migrations/0012_sensitive_memory_approvals.sql:5-7`：
   > `run_id TEXT NOT NULL ...`、`thread_id TEXT NOT NULL ...`、`generation_id TEXT NOT NULL ...`

   外部 MCP 写请求没有对话 run/thread/generation，硬塞进去要造伪 run/thread，或者大改 `resolveSensitive` 的重抽取流程。不合适。

5. **现有敏感审批只能逐条回应，且 pending 快照没有来源客户端字段。**
   `apps/agent-service/src/production-memory-control.ts:978-1004` 的 `memory.approval.respond` 走 `resolver.resolveSensitive(...)`。
   `packages/gateway-contracts/src/contracts-v2.ts:1300-1309` 的 `pending` 只有 `requestId`、`threadId`、`sourceRef`、`text`、`topic`、`requestedAt`。
   `apps/control-center/src/components/memory-page.tsx:664-665` 是逐条 `MemoryApprovalCard`。

6. **现有 `memory.import.commit` 已证明“批量落库”可行，上限 500 条。**
   `packages/gateway-contracts/src/contracts-v2.ts:1368-1381`：`items` 1 到 500。
   `apps/agent-service/src/production-memory-control.ts:891-919`：先建 import batch，再逐条 `#createMemory`，编号 `memory:import:<batchId>:<ordinal>`。

7. **现有 `#createMemory` 已经能创建正式记忆。**
   `apps/agent-service/src/production-memory-control.ts:795-844` 原话要点：
   > `sourceRefs: [input.contentRef]`、`inference: false`、`confidencePermille: 1000`
   > `attributes: { category, importancePermille, entities: [], validFrom: null, validTo: null, supersededBy: null, evidenceVerified: false, ... }`

   确认后的外部提议可以直接复用这条路径，只需支持额外的 provenance `sourceRefs`。

8. **记忆编号是 1–128 字符的机器标识，允许 `._:-`。**
   `packages/domain/src/identifiers.ts:39`：
   > `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`
   `packages/gateway-contracts/src/validation.ts:49-60` 的 `machineString` 规则相同。
   所以 `memory:mcp:mp:<32位hex>` 约 46 字符，能过两端校验。

9. **决策账本已允许 `memory_candidate` 的 `pending_approval`。**
   `packages/application/src/ports/decision-ledger.ts:44-51`：
   > `memory_candidate: ["kept", "discarded", "pending_approval"]`

10. **但 `DecisionLedgerPort.append` 对非 proactive 记录只落四个输入键。**
    `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:132-138`：只写 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds`。
    `docs/execution/specs/2026-11-09-decision-record-write-convention.md:35` 也写明这一点。
    所以来源客户端、原文、提议状态不能靠 ledger inputs 表达，要放在收件箱表里，ledger 只记 `subjectRef`、`reasonCode` 和 `memoryIds`。

11. **Muse 推送通道已经有成熟的“自然键 + 内容摘要”去重模型。**
    `packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:214-309`：
    - 唯一键 `(owner_id, agent_id, kind, natural_key)`
    - 已存在且 `content_digest` 相同 → duplicate
    - 已存在但摘要不同 → conflict，不覆盖
    这套做法可以照搬到外部记忆提议。

12. **Muse 现有通道是两层认证，ADR 明确拒绝过“只发一个 Authorization 头”。**
    `docs/adr/0162-receive-muse-data-through-a-service-token-and-an-app-secret.md:39`：
    > “边缘层用 Cloudflare Access 的服务令牌……应用层再要求 `Authorization: Bearer <应用密钥>`……任何一层失效，另一层仍挡着。”
    同一文件 `:55`：
    > “**Muse 只发一个 `Authorization` 头（用 `read_service_tokens_from_header`）**：这会占用我们的应用层 Bearer 头，两层认证就合并成一层。”
    同一文件 `:61`：
    > “若 Muse 只能发一个头，需要另开 ADR 重新取舍，不得悄悄放宽认证。”

13. **Cloudflare 支持把服务令牌放进单个请求头。**
    <https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/> 原话：
    > “You can configure a self-hosted Access application to accept a service token in a single HTTP header…”
    > `-H "Authorization: {\"cf-access-client-id\": \"<CLIENT_ID>\", \"cf-access-client-secret\": \"<CLIENT_SECRET>\"}"`

14. **Cloudflare Managed OAuth 要求客户端支持 RFC 8707，源站必须校验 Access JWT。**
    <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/> 原话：
    > “An OAuth client that supports RFC 8707”
    > “The MCP server must validate the Access JWT sent in the `Cf-Access-Jwt-Assertion` header.”
    > “Managed OAuth issues **opaque** access tokens… Cloudflare resolves the token into the user's identity on the backend and forwards a signed assertion to your origin.”

15. **发给模型的内容只能末尾追加，会变的值只能在最后一条消息。**
    `.claude/rules/prompt-prefix.md:27-28`：
    > “固定的在前，会变的在后……每轮都会变的内容只放在最后一条用户消息里。”
    同一文件 `:35`：
    > “已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”
    同一文件 `:51`：
    > “同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序……都要固定。”
    同一文件 `:84`：
    > “这个改动会不会让模型已经见过的请求开头变化？会，就停下来出方案，Andy 同意才动工。”

16. **I-73 的教训：产生值的清单和使用值的校验要逐项核对。**
    `docs/incidents-and-gates.md:112` 原话：
    > “#207 的测试只测清单解析和展示，没有把清单里的引用交给发送消息的校验；双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」”
    这就是本方案必须逐个核对 `proposalId`、`memoryId`、`source`、`editedText`、`status` 等值两端校验的原因。

### 未核实或来自材料转述的

- **P5-2 的具体实现细节**：`propose_memory`、`requestState` HMAC、10 分钟过期、参数摘要、`memory:mcp:<提议编号>`，来自材料；P5-2 尚未合并，当前 main 没有这些代码，无法在仓库中核实。
- **Muse 的官方能力**：自定义连接器只支持 API key / OAuth、不支持多密钥组合、capabilities 为空、不支持 elicitation、定时任务 45 秒失败不重试、OAuth 是否带 RFC 8707、定时任务能否自动续期，来自材料转述，未独立核实。
- **Claude 应用是否支持 elicitation**：材料只说“不支持 Resource subscriptions / Sampling / Advanced or draft capabilities”，没有说 elicitation；未核实。
- **Claude 应用 OAuth 是否发送 RFC 8707 `resource`**：未核实。这是它能否使用 Cloudflare Managed OAuth 的关键。
- **Cloudflare Access JWT 的具体 claim 名称**（服务令牌名、OAuth client id 落在哪个字段）：未核实，需要在真实 Access 环境抓一次 JWT。
- **现有 Muse 推送定时任务能否同时发三个请求头**：ADR 0162 `:61` 明确说未在真实 Muse 上验证。
- **`createMcpHandler` 中读取客户端 capabilities 的确切字段路径**：P5-2 材料未给出；未在 main 核实。

---

## 二、方案本身

### 2.1 数据放在哪里

新增一张表，**不建 `memory_records`**，不改现有表。建议表名：

`external_memory_proposals`

核心列：

| 列 | 含义 |
|---|---|
| `id` | `mp:` + 32 位 hex，确定性；不超过 128 |
| `owner_id`, `agent_id` | 现有作用域 |
| `source` | 服务端从凭据解析出的客户端标签，如配置里的 `muse`、`claude-code`；**不是客户端自称** |
| `reported_client` | MCP `clientInfo` / User-Agent 里的自称，仅展示，最多 64 |
| `natural_key` | 客户端提供的稳定键；没有则由内容摘要生成 |
| `content_digest` | 原文的 SHA-256 hex，64 字符 |
| `text_ref` | 原文加密 payload 引用，复用现有 `payloads` / protector |
| `edited_text_ref` | 主人修改后确认时保存的文本引用，可空；原 `text_ref` 保留 |
| `category` | `MEMORY_CATEGORIES` 之一；外部不许建 `rule` |
| `classification` | `public/private/sensitive`；`restricted` 在入口拒绝 |
| `status` | `pending/committed/rejected/expired/superseded` |
| `received_at` | 服务端收到时间，不用客户端时间 |
| `decided_at`, `committed_at`, `committed_memory_id` | 结果 |
| `expires_at` | 可空；v1 默认 null，不自动过期 |

约束：

- `UNIQUE (owner_id, agent_id, source, natural_key, content_digest)`：同一条提议重发只有一行。
- 部分唯一索引 `(owner_id, agent_id, source, natural_key) WHERE status = 'pending'`：同一来源同一自然键最多一个待确认；新内容进来时先把旧的 pending 标成 `superseded`。
- 索引 `(owner_id, agent_id, status, received_at)`：主人按时间看。
- `id` 确定性地由 `source + natural_key + content_digest` 哈希得出，**不用随机 UUID，不用当前时间**。

为什么不用 `memory_records` + `tentative`：

- 现有 `tentative` 会被聊天检索和主动检查召回，违反目标 2。
- 现有 `memory_records.status` 只有 `active/archived/trashed/deletion_pending/deleted_verified`，没有 “pending approval”；加状态要动很多状态机和界面。
- 新表没有消费方，除非以后有人显式把新表接进检索；风险面最小。

为什么不用 `memory_approval_requests`：

- 它的 `run_id/thread_id/generation_id` 是 NOT NULL，外部提议没有这些。
- 它的 `resolveSensitive` 会重新抽取候选，外部提议没有抽取器、没有 run 源文本。
- 它的 `UNIQUE (generation_id, source_ref, candidate_ordinal)` 也不适合外部自然键。

迁移：当前迁移到 `0087`，这张新表取下一个号。只新增表，不改旧表；仍需按仓库规则排一个改表块。

### 2.2 MCP 工具怎么返回

保留 P5-2 的单条 `propose_memory`，另加批量 `propose_memories`（Muse 定时搬运用）。两个工具都**始终注册**，不要按能力动态增删工具——`.claude/rules/prompt-prefix.md:44` 明确说工具集合尽量稳定。

参数建议：

- `propose_memory`：`text` 1–500 字；`category?`；`naturalKey?`（`[A-Za-z0-9._:-]{1,150}`）。
- `propose_memories`：`items` 1–50 条，每条同上。

处理分支：

1. **客户端声明了 `elicitation.form`**：
   - 走 P5-2 现有 elicitation。
   - `accept`：立即落正式记忆，不进收件箱。
   - `decline` / `cancel`：不落库，记 `discarded`。
   - 如果 elicitation 传输失败，**兜底进收件箱**，不要丢；但这属于异常兜底，不是正常路径。
2. **客户端没有声明 elicitation**：
   - **绝不返回 `InputRequiredResult`**，直接落收件箱，返回普通 tool result。
   - 返回示例（键顺序固定）：

```json
{
  "status": "pending_approval",
  "proposalId": "mp:[已遮盖:registered-test-value]",
  "receivedAt": "2026-11-11T04:00:00.000Z"
}
```

批量返回：

```json
{
  "status": "accepted",
  "items": [
    {
      "status": "pending_approval",
      "proposalId": "mp:....",
      "receivedAt": "2026-11-11T04:00:00.000Z"
    }
  ]
}
```

要点：

- **不要返回“当前待确认总数”**。这个值每次调用都可能变，会让同一提议重试的返回字节不同；也没有必要让外部模型知道。
- **不要把 `duplicate: true/false` 放进返回**。第一次和重试会不同。重复时直接返回第一次存下的同一份 receipt（同一个 `proposalId`、同一个 `receivedAt`）。
- 批量结果按输入顺序排列；不按对象遍历、不按数据库返回顺序。
- 工具说明文字登记进 `packages/prompt-catalog`，固定文字，不写客户端名单、时间、当前数量。

### 2.3 去重规则

`content_digest = sha256(原文 UTF-8)`，`proposalId = "mp:" + sha256(source + "\n" + naturalKey + "\n" + contentDigest).slice(0, 32)`。

- **同 `source`、同 `naturalKey`、同摘要**：返回已有行的 receipt；不再写 ledger。
- **同 `source`、同 `naturalKey`、不同摘要，且旧行还是 pending**：旧行标 `superseded`，ledger 记 `discarded / external_proposal_superseded`，再插入新 pending。这样 Muse 记忆文件更新不会产生两条待确认。
- **同 `source`、同 `naturalKey`、不同摘要，旧行已 committed/rejected**：插入新 pending。旧正式记忆不自动改；这是“新增提议”，不是“更新正式记忆”。
- **没有 `naturalKey`**：用 `content:<digest>` 作为自然键。这样同文重发不重复。
- **owner 已拒绝过同摘要**：返回 `rejected`，不再反复提醒。要重新提议，客户端应换自然键；否则主人拒绝一次就永远静音，这是有意的。

### 2.4 主人在哪里、怎么确认

放在现有「设置 → 记忆」页顶部 `ConfirmSection` 里，新增一个独立小节：

**「外部 agent 的建议」**

每条卡片显示：

- 原文（完整，最多 2000 字符显示，入口限制 500）
- 来源标签（服务端凭据解析出的 `source`）
- 客户端自称（`reported_client`，与来源不同时显示“自称：…”）
- 收到时间（`receivedAt`，服务端时间）
- 分类、数据分级
- 按钮：`确认`、`修改后确认`、`拒绝`

批量：

- 每条前面有复选框；有「全选本页」「批准所选 N 条」「拒绝所选 N 条」。
- 单条修改仍然逐条编辑，不走批量。
- 不把敏感记忆审批、人物合并建议、tentative 猜测混进同一个“全部确认”按钮；它们各自有独立小节，避免误批。

新网关命令：

`memory.external_proposal.respond`

payload：

```json
{
  "items": [
    {
      "proposalId": "mp:...",
      "resolution": "approved",
      "editedText": null
    }
  ]
}
```

约束：

- `items` 1–100。
- `resolution` 枚举 `approved/edited/rejected`。
- `editedText` 最多 500，和现有 `memory.approval.respond` 的 `editedText: nullable(boundedString(500))` 一致（`packages/gateway-contracts/src/contracts-v2.ts:1387-1394`）。
- 命令使用现有 `idempotencyKey`；服务端对每个 proposal 再做一次状态检查，已 committed 直接返回 `committed_memory_id`，保证重复提交不重复建记忆。
- 批处理不要求全有或全无：已经提交的条目保留，失败的条目返回错误，页面刷新后显示剩余 pending。重试靠 `proposalId` 和确定性 memory id 幂等。

数字定义：

- 小节标题的 `N` = `SELECT COUNT(*) FROM external_memory_proposals WHERE owner_id=? AND agent_id=? AND status='pending'`。
- 页面实际显示的卡片数 = 本次快照返回的 `items.length`，最多 100；若 `N > items.length`，显示「共 N 条，显示前 100 条」。
- 复选框上的数字 = 当前选中的卡片数，不包含未显示条目。
- 这满足“每个数字有可验证的定义”。

### 2.5 确认后怎么落库

确认 `/ 修改后确认`：

1. 读 pending 行；若已 committed，直接返回 `committed_memory_id`。
2. 取原文 `text_ref` 或 `edited_text_ref`。
3. 用 `@himawari-agent/sensitive-capture` 的 `classificationWithIdentifiers(text, "private")` 重新分级；如果结果是 `restricted`，拒绝这次确认，保持 pending，让主人改。
4. 用现有 protect/payload 存储文本，ref 可以是 `memory-content:memory:mcp:<proposalId>`。
5. 复用 `#createMemory`，但增加可选的 `sourceRefs`：
   - `id = memory:mcp:<proposalId>`
   - `sourceThreadId = null`
   - `sourceRefs = [contentRef, "mcp:<proposalId>"]`
   - `inference = false`（主人确认过，不是 Himawari 的推断）
   - `confidencePermille = 1000`
   - `policyVersion = "memory-mcp:v1"`
   - `attributes.category = 卡片分类`，`importancePermille = 500`，`evidenceVerified = false`
   - 敏感分类沿用 `sensitiveTopicFor(category)`。
6. 用 `applyProposal(..., generationId, ledger)` 让记忆和 ledger 在同一个 SQLite 事务里落。
7. 更新收件箱行为 `committed`，写 `committed_memory_id`、`committed_at`。

`rule` 分类**不允许**外部提议创建。规则是硬设定，不是记忆（`docs/product-vision.md:59`）；外部 agent 只能提议普通记忆。`category === "rule"` 在入口直接拒绝。

拒绝：

- 行标 `rejected`，写 `decided_at`，ledger `discarded / external_proposal_rejected`。
- 不建记忆。
- 原文保留到清理策略执行。

过期：

- v1 **不自动过期、不自动删除**。现有敏感审批表也没有过期列；外部提议同样不应静默丢。
- P5-2 的 10 分钟只属于 elicitation 的 `requestState`，不适用于收件箱。
- 如果以后要 TTL，单独加 `expires_at` + 每日维护任务：先标 `expired` 并通知，文本再保留 30 天，最后删除 payload；绝不能直接删 pending 文本。
- 收件箱设上限（例如 500 条 pending）。满了返回 `INBOX_FULL`，让 Muse 停止本轮同步并报告主人；不要静默丢弃，也不要自动批准。

### 2.6 决策记录怎么写

全部用 `kind: "memory_candidate"`：

| 时机 | outcome | reasonCode | subjectRef | inputs |
|---|---|---|---|---|
| 入收件箱 | `pending_approval` | `external_proposal_queued` | `proposalId` | `memoryIds: []`, `ruleIds: []` |
| 被同自然键新内容取代 | `discarded` | `external_proposal_superseded` | `proposalId` | `memoryIds: []`, `ruleIds: []` |
| 确认落库 | `kept` | `external_proposal_committed` | `memoryId` | `memoryIds: [memoryId]` |
| 主人拒绝 | `discarded` | `external_proposal_rejected` | `proposalId` | `memoryIds: []`, `ruleIds: []` |
| 过期 | `discarded` | `external_proposal_expired` | `proposalId` | `memoryIds: []`, `ruleIds: []` |

注意：

- ledger id 用确定性哈希，例如 `ledger:` + `sha256("external-proposal:" + proposalId + ":" + outcome + ":" + reasonCode).slice(0,40)`；`insertLedgerRow` 本身有 `ON CONFLICT (id) DO NOTHING`，重试不会重复写。
- pending 阶段 `contentRef: null`，不在 ledger 里放正文引用；确认阶段 `contentRef` 写正式内容 ref。
- 来源客户端、原文、收到时间在收件箱表里；ledger 的 `inputs` 只落四个键，不能硬塞。
- 入收件箱的 proposal 写入和 ledger 写入应在同一个 SQLite 事务里；ledger 失败时整次 tool call 失败，客户端可幂等重试。这样“每条提议都有账”成立。

### 2.7 连接方式

#### Muse

Muse 只能带一个凭据，因此有两条现实路径：

**推荐给 Muse 的定时任务：Cloudflare Access 服务令牌 + 单请求头 + 源站校验 JWT。**

- 在 Cloudflare Access 应用上设置 `read_service_tokens_from_header: "Authorization"`。
- Muse 只发一个头：
  `Authorization: {"cf-access-client-id":"...","cf-access-client-secret":"..."}`
- Cloudflare 认证后，源站收到 `Cf-Access-Jwt-Assertion`；源站必须校验签名、`iss`、`aud`、`exp`，不能盲信。
- 来源标签从服务令牌名/ID 解析，例如 `muse`；不要用 Muse 自称的 `clientInfo` 作为审计来源。
- 这条路径适合无人值守、不会 OAuth 刷新失败。

代价：这等于把 ADR 0162 的“两层认证”在 MCP 写路径上合并成“边缘认证 + 源站 JWT 校验”一层。按 ADR 0162 `:61` 的要求，**必须另开 ADR 由 Andy 拍板，不能悄悄放宽**。若要保留两层独立密钥，Muse 就不能只带一个头，只能走已有推送通道或加中转。

**如果 Muse 的 OAuth 确认支持 RFC 8707，且定时任务能自动续期**：优先 Cloudflare Access Managed OAuth。Cloudflare 文档说 Managed OAuth 面向 “CLI tools, AI agents… silent refresh”；但 Muse 45 秒失败不重试，令牌过期会直接失败，所以必须确认刷新行为。未核实。

**如果 Muse 的定时任务其实能发三个请求头**：不要走 MCP，直接扩展现有 `/api/muse-intake/v1/batch`，保留 ADR 0162 的两层认证和现有 runbook。这是认证上最稳的路径，但就不是 MCP 工具了。ADR 0162 `:61` 明确说这一点未验证。

Muse 批量同步注意：

- 用 `propose_memories`，一次 50 条以内；不要每条一个请求。
- 入站在 45 秒内完成：不调用模型、不算 embedding、不等待人；只做校验、分级、加密、写表。
- 收到 `INBOX_FULL` 或 401 就停止本轮并报告，不要紧循环重试。
- 自然键用 Muse 记忆文件里的稳定键（文件路径 + 标题/锚点 + 内容摘要），不要用每次运行的时间。

#### Claude 应用

Claude 应用只支持 OAuth（DCR/CIMD）或无认证：

- 只能走 Cloudflare Access Managed OAuth + DCR；源站校验 `Cf-Access-Jwt-Assertion`。
- Cloudflare 明确要求客户端支持 RFC 8707。若 Claude 应用不发送 `resource`，Managed OAuth 就不可用。
- **不能因为“它支持无认证”就开放无认证写入口**。无认证写记忆等于任何人都能污染主人的记忆。
- 如果 OAuth 走不通，Claude 应用的写记忆功能应暂不支持，等客户端能力确认或另做方案；不能降级成公开写入口。
- 它的工具超时 240 秒对本方案不是问题：入站立即返回 pending，确认在 Himawari 网页异步完成。

#### Claude Code

- 继续用现有静态 Bearer（`mcpRead.secretRef` / `BearerGate`）连接 `/api/mcp/v1`。
- 它声明了 elicitation，走 P5-2 当场弹框；正常情况不进收件箱。
- 同一个 `proposalId` 也用于 elicitation 分支，避免“先弹框失败、再重试进收件箱”时产生两份。

认证分支建议：

- `Authorization: Bearer <static>` 且匹配 → Claude Code 静态令牌。
- 否则有有效 `Cf-Access-Jwt-Assertion` → Cloudflare OAuth / 服务令牌客户端。
- 两者都没有 → 401。
- 只信任 Cloudflare 设置的 JWT；如果源站可被绕过 Cloudflare 直接访问，必须保证请求不能伪造该头。

---

## 三、考虑过但不选的做法

1. **复用 `attributes.tentative` 存外部待确认。**
   不选。现有主动检查和聊天检索会召回 tentative（`production-memory-recall.ts:190-214`、`production-proactive-memory.ts:48`），直接违反目标 2；要让它不参与，必须改所有读取路径，风险远大于新表。

2. **复用 `memory_approval_requests`。**
   不选。`run_id/thread_id/generation_id` NOT NULL；`resolveSensitive` 依赖 run 源文本重抽取；外部提议没有这些。

3. **用 `memory_records.status = 'archived'` 或新增 `pending` 状态。**
   不选。会进入 `listInactive`、导出、可能进入整理；而且状态机要改。新表天然不被任何模型路径消费。

4. **把待确认内容放进 decision ledger，靠 ledger 当收件箱。**
   不选。ledger 是追加事件流，没有可变状态、没有唯一自然键、没有批处理，查询和去重都会变成拼 SQL。

5. **用 `memory.import.commit` 直接批量落库，不设待确认。**
   不选。违反目标 1、2；import 是主人主动导入，不是外部 agent 提议。

6. **Muse 用无认证 MCP 入口。**
   不选。任何人都能写记忆，违反用户主权和记忆可靠性。

7. **Muse 只带一个头，同时把应用密钥塞进同一个 Cloudflare 服务令牌 JSON。**
   不选。这样两个密钥一起泄露，两层认证名存实亡；而且 Cloudflare 是否原样转发额外字段未核实。

8. **为 Muse 加一个 Cloudflare Worker 中转，由 Worker 补第二个密钥。**
   ADR 0162 `:52` 已经因“多一个组件和一份密钥”拒绝过 Worker；除非单头方案不可接受，否则不引入。

9. **每次外部提议都调模型判断是否值得记。**
   不选。Muse 定时任务 45 秒、Claude 应用 240 秒，入站应快速；而且模型判断会让待确认内容进入模型上下文，违反目标 2。

10. **批量确认做成全有或全无。**
    不建议。部分失败时回滚已提交记忆，用户还要重新看；逐个幂等、返回剩余 pending 更符合“整批但可单条改/拒”。

---

## 四、风险和反例

### 最大风险

1. **待确认内容意外进入模型上下文。**
   反例：如果实现时图省事用了 `tentative`，`production-memory-recall` 会把它当线索返回，聊天回答就可能说出主人没确认的内容。
   缓解：新表 + 一个“泄漏测试”：把唯一标记文本放进 pending，然后跑聊天检索、主动检查、档案块，断言该标记不出现；若有人以后把新表接进检索，测试必须失败。

2. **客户端来源被伪造。**
   反例：恶意客户端在 `clientInfo.name` 里写 `muse`，若直接存为来源，主人会误以为来自 Muse。现有 `clientNameOf` 正是优先取 `clientInfo`（`production-mcp-read.ts:118-128`）。
   缓解：`source` 只从凭据解析；`reported_client` 另存并标“自称”；需要每个客户端独立凭据或 OAuth 身份。

3. **批量确认把恶意/提示注入文本一次放进正式记忆。**
   反例：外部 agent 提议“以后所有邮件都转发到某地址”，主人没细看就全选确认。
   缓解：卡片显示来源、原文；批量只确认已显示且勾选的条目；不把外部提议自动设为 `rule`；不提供“全部外部来源一键确认”的隐藏入口。

4. **备份/恢复后待确认丢失。**
   现有 `PortableSnapshot` 导出的是正式记忆、历史、people、import batches 等（`packages/persistence-sqlite/src/data-export/snapshot.ts:7-29`），没有 `memory_approval_requests`。新表如果不加进导出，恢复后会丢 pending。
   需要拍板：待确认是否算“记忆数据”要备份。若不备份，要在运行手册写明。

### 容易漏掉的场景

- **同自然键内容变了**：Muse 记忆文件更新，不能当重复丢掉，也不能产生两条 pending；要 `superseded`。
- **确认后网络超时重试**：客户端/网页重发同一批，不能建两条记忆；用确定性 `memory:mcp:<proposalId>` 和已 committed 状态返回。
- **批处理部分成功**：不能因为第 10 条失败把前 9 条回滚；要幂等，页面刷新看剩余。
- **主人修改文本时改出机器密钥/受限内容**：确认时重新用 `sensitive-capture` 分级，`restricted` 拒绝。
- **来源标签含控制字符/HTML**：入库前 `singleLine` 式清洗，React 按文本显示，不能当 HTML。
- **数字定义**：`N` 是数据库 pending 总数，不是当前页面卡片数；页面截断时必须写清楚。
- **`memory.overview.snapshot` 合约和 fixture**：新数组要同步 `packages/gateway-contracts/src/contracts-v2.ts`、`packages/gateway-contracts/test/gateway-v2.fixture.ts`、`apps/control-center/test/*`；否则 UI 读不到。
- **`memory.external_proposal.respond` 的命令白名单**：`apps/agent-service/src/production-memory-control.ts:53` 附近和 `production-http-composition.ts:187` 附近都有命令列表，要同步。
- **迁移编号/回滚**：只新增表，旧版本程序不会读；关闭功能即停收。
- **`memory:mcp:<proposalId>` 的后端校验**：domain `createMemoryId`、`machineString`、`memory_records.id`、gateway `resultRef` 四处都要核对；按 I-73，不能只测 UI。
- **`rule` 分类**：外部 agent 不能创建规则；入口拒绝。
- **Muse 45 秒 / Claude 240 秒**：入站不能调用模型或 embedding；只做快速写。
- **`#generationFor(null)`**：`production-memory-control.ts:279-289` 要求至少有一个 latest generation；全新部署没有 generation 时确认会失败。要提前返回明确错误，或先建 generation。
- **OAuth 刷新**：Muse 定时任务无人在场，OAuth access token 过期后必须能静默刷新；否则 45 秒失败不重试会丢这一轮。
- **Claude 应用 RFC 8707**：不发送 `resource` 就过不了 Cloudflare Managed OAuth；不能因此改成无认证写入口。

---

## 五、需要拍板的取舍

1. **新增一张表，还是改现有表/状态机。**
   我建议新增 `external_memory_proposals`，只新增不改旧表；代价是一个迁移块和一套新读写。

2. **Muse 的单凭据认证。**
   是接受“Cloudflare 服务令牌单头 + 源站 JWT 校验”（一层独立应用密钥消失，需要新 ADR），还是不再让 Muse 走 MCP、改走已有推送通道？
   我倾向：Muse 定时任务走单头服务令牌 + JWT 校验；但这必须 Andy 明确同意放宽 ADR 0162 的两层认证。若 Andy 不接受，Muse 本轮不做 MCP 写记忆。

3. **是否给每个客户端独立凭据。**
   要满足“看出来自哪个客户端”，最好每个客户端独立凭据或 OAuth 身份。若所有客户端共用一把静态令牌，来源只能靠自称，不能作审计依据。

4. **显式声明 elicitation 但运行时失败时，兜底进收件箱还是直接报错。**
   我建议兜底进收件箱，避免丢；正常成功仍当场确认，不进收件箱。

5. **待确认是否纳入备份/导出。**
   我建议 v1 与现有敏感审批保持一致：不纳入正式记忆导出，但在运行手册写明；若要纳入，需改 `data-export/snapshot.ts`、`schemas.ts`、`import.ts`、`verify.ts`，是另一份清单。

6. **过期策略。**
   我建议 v1 不自动过期，只允许 `superseded/rejected`，加 pending 上限；若要 TTL，另做带通知的 `expired` 状态，不静默删除。

7. **同自然键内容变化是覆盖旧 pending 还是并列。**
   我建议覆盖旧 pending（标 `superseded`），避免主人看到同一记忆的多个版本；已 committed 的旧正式记忆不自动改。

8. **外部提议是否允许 `rule` 分类。**
   我建议不允许。规则是硬设定，必须由主人明确设置，不能由外部 agent 提议。

---

## 六、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**对 Himawari 自己的模型：不会改变已发出的开头。**

- 不新增 Himawari 运行时的系统提示或工具定义；待确认提议只进新表，不进入 `find_memories`、`recall`、主动检查、档案块、整理。
- 主人确认后，新记忆才可能出现在后续轮次的最后一条用户消息/资料块/工具结果里；这是**追加**，不是改写历史。
- 如果主人在两轮之间确认，下一轮的最后一条消息会多一条记忆；符合 `.claude/rules/prompt-prefix.md:28`“每轮会变的内容只放在最后一条用户消息里”。
- 现有历史不修改、不重排；符合 `:35`。

**对外部客户端的模型：会改变一次它们的工具列表。**

- 新增 `propose_memory` / `propose_memories` 会改变 Claude Code、Muse 等 MCP 客户端的工具定义；工具定义在它们请求的开头，所以它们自己的 KV 缓存可能失效一次。
- 这不是 Himawari 的模型请求，但也是“模型已经见过的请求开头”，必须如实说明。P5-2 本身已经要加写工具，本方案没有额外增加 Himawari 侧的工具。
- 为避免每轮变化，两个写工具**始终注册**，不按客户端能力动态增删（`:44` 的取舍）。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**设计目标是不变。**

- `proposalId` 由 `source + naturalKey + contentDigest` 确定性哈希，不含随机 UUID、不含时间。
- `contentDigest` 是原文的 SHA-256，不含时间。
- 返回里只放 `proposalId`、固定状态的 `status`、第一次写下的 `receivedAt`；重复提交返回同一行，不返回“当前待确认总数”、不返回 `duplicate` 布尔值。
- 批量结果按输入顺序；JSON 键顺序在代码里固定；不使用无序 `Set`/`Map` 直接序列化。
- `source` 来自配置/凭据的稳定标签，不用每次变化的用户显示名。
- 唯一会变的是“状态本身变了”（pending → committed/rejected）；这是语义变化，不是同一段文字被随机改写。重试在状态未变时字节相同。

**遮盖：** 待确认内容不进入模型出口，不涉及出口遮盖；MCP 返回不包含原文，只包含 id/status/time。UI 端按现有记忆页的 owner 权限解密显示。没有“依赖前后文的遮盖”引入字节变化。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

目前**没有**，因为改动尚未实现；P5-2 也未合并到 main，其测试无法在仓库核实。落地时必须先写测试，并在旧代码上确认变红。建议门槛：

- **MCP 能力分支**：用官方 SDK 客户端，分别声明/不声明 `elicitation`。不声明时断言返回普通 tool result，且**没有** `inputRequiredResult`；声明时断言走 elicitation。反向：强制对未声明客户端发 elicitation → 测试必须失败。
- **收件箱隔离**：写入带唯一标记的 pending 文本，跑聊天检索、主动检查、档案块，断言标记不出现；反向：临时把新表接进 `recall` → 测试必须失败。
- **去重**：同一 `source+naturalKey+digest` 连发两次，断言只有一行、返回同一 `proposalId/receivedAt`；反向：去掉唯一约束 → 出现两行，测试失败。
- **同键改内容**：同自然键不同摘要，断言旧 pending 变 `superseded`、只留一个新 pending；反向：直接插两条 pending → 部分唯一索引报错。
- **确认幂等**：同一 proposal 确认两次，断言只有一条 `memory:mcp:<proposalId>`，第二次返回同一 memoryId；反向：用随机 id → 两条记忆，测试失败。
- **批量部分失败**：100 条里第 50 条非法，断言其余 49/50 条状态正确，页面刷新能看到剩余；反向：全有或全无回滚 → 测试不符合预期。
- **值契约（I-73 类）**：把 store 生成的每个 `proposalId`、`memory:mcp:<id>` 交给 `machineString`、`createMemoryId`、gateway `memory.overview`/`memory.external_proposal.respond` 校验；去掉任一放宽 → 测试失败。再用真实 SQLite 插入 `memory_records`，证明 id 不超长、不违反字符规则。
- **来源**：伪造 `clientInfo.name`，断言 `source` 不被污染；反向：用 `clientNameOf` 直接当来源 → 测试失败。
- **认证**：静态 Bearer、Cloudflare JWT、两者都没有；断言无凭据 401、无 elicitation 不弹框、单头服务令牌可用。反向：删掉 JWT 校验 → 伪造 JWT 通过，测试失败。
- **提示前缀**：现成的 `npm run check:prompt-prefix` 应保持通过；如果本改动没有改 Himawari 提示词/工具，它不应出现新变化。若以后把待确认接进模型，必须新增反向用例。
- **导出/备份**：若决定纳入，新增 export→import→verify 往返测试；不纳入则写一条明确的“不支持”断言，防止以后误以为会备份。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？逐个核对两端校验。

按 I-73 的教训，至少核对下面这些：

| 值 | 产生处 | 使用处 | 两端校验 |
|---|---|---|---|
| `proposalId` `mp:<32hex>` | 入站哈希 | MCP 返回、收件箱主键、ledger `subjectRef`、派生 memory id | 生成的 id 必须过 `machineString`（≤128、`[A-Za-z0-9][A-Za-z0-9._:-]*`）；ledger `subjectRef` ≤256；DB `id` 长度约束 |
| `memory:mcp:<proposalId>` | 确认时派生 | `memory_records.id`、gateway `resultRef`、UI memoryId | 必须过 `createMemoryId` 的 `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`；当前长度约 46，安全 |
| `source` | 凭据/配置解析 | 收件箱、UI、审计 | 生成时限制 1–64；DB 只做长度 CHECK，不做客户端名单枚举；UI schema 用 `boundedString(64)` |
| `reported_client` | `clientInfo` / User-Agent | 仅 UI 展示 | 清洗控制字符、截 64；不作为来源/授权 |
| `natural_key` | 客户端或内容摘要 | 去重、唯一索引 | 客户端输入限制 `[A-Za-z0-9._:-]{1,150}`；没有时生成 `content:<64hex>`，长度 72，合法 |
| `content_digest` | 原文 SHA-256 | 去重、幂等 | 固定 64 hex；DB CHECK `length = 64` |
| `text` / `editedText` | MCP 入参、UI 编辑 | payload、正式记忆内容 | 入口 1–500；命令 `editedText` `boundedString(500)`；UI `TextEditor` `maxLength={500}`；确认时再跑 `sensitive-capture` |
| `category` | MCP 入参/UI | 收件箱、正式 memory attributes | 枚举 `MEMORY_CATEGORIES`；DB CHECK；`rule` 在入口拒绝 |
| `classification` | 服务端 `classificationWithIdentifiers` | payload、正式 memory、UI | 只允许 public/private/sensitive；`restricted` 入口拒绝；确认时重算，防止编辑后变受限 |
| `status` | 收件箱状态机 | UI、命令、ledger | DB CHECK `pending/committed/rejected/expired/superseded`；命令 resolution 只接受 `approved/edited/rejected`；ledger outcome 只接受 `pending_approval/kept/discarded` |
| `receivedAt` | 服务端 clock | 收件箱、UI、MCP 返回 | 存 ISO 字符串并做 `validTime`；不接收客户端时间 |
| `ledger.reasonCode` | 服务端固定常量 | `decision_ledger` | ≤64；不能把动态来源/时间拼进去 |
| `ledger.inputs` | 服务端 | `DecisionLedgerPort.append` | 只放 `memoryIds/ruleIds`；`batchId/resultMemoryIds` 可选；不能放来源/文本，否则被 `insertLedgerRow` 丢掉 |
| `command.idempotencyKey` | gateway envelope | 命令幂等 | 现有 `machineString` 校验；不要用超长自然键直接当 idempotencyKey |
| `total` | SQL COUNT | UI 数字 | 定义为 `status='pending'` 的行数；UI schema `integer(0)`；不是 `items.length` |

特别要检查的跨端：

- gateway 合约新增字段后，`packages/gateway-contracts/test/gateway-v2.fixture.ts` 和 `apps/control-center/test/*` 必须同步；否则 UI 读不到或校验失败。
- `memory.overview.snapshot` 的 `pending` 旧字段不能改语义；新数组单独加，避免已有敏感审批页面回归。
- `apps/agent-service/src/production-memory-control.ts:53` 和 `apps/agent-service/src/production-http-composition.ts:187` 附近的命令白名单要加新命令。
- `memory.mcp` 的 memory id 要能通过记忆页、决策依据抽屉、导出/导入各处的 `MemoryId` 校验；不能只在 UI 测试。

---

## 七、对材料五问的直接回答

### 1. 完整方案

见上文第二、三节。概括：

- **数据**：新表 `external_memory_proposals` + 现有加密 payload；不改 `memory_records` 直到确认；一个新增迁移。
- **MCP 返回**：非 elicitation 客户端返回 `pending_approval` receipt；不返回 `InputRequiredResult`；批量按输入顺序返回；重复返回同一 receipt。
- **主人界面**：记忆页顶部独立「外部 agent 的建议」小节；显示来源、自称、服务端收到时间、原文、分类/分级；支持单条改/拒、复选框批量确认/拒绝；新命令 `memory.external_proposal.respond`。
- **确认落库**：复用 `#createMemory`，id `memory:mcp:<proposalId>`，`sourceRefs=[contentRef,"mcp:<proposalId>"]`，正常进入正式记忆、检索、档案；`rule` 不允许。
- **去重**：确定性 `proposalId` + `naturalKey + contentDigest` 唯一；同键新内容覆盖旧 pending；已拒绝同摘要不再反复提醒。
- **过期**：v1 不自动过期；只 `superseded/rejected`；收件箱上限 + 满时拒绝；以后要 TTL 另做带通知的 `expired`。
- **决策记录**：`memory_candidate` 的 `pending_approval` / `kept` / `discarded`，原因码固定，ledger id 确定性。

### 2. Muse 和 Claude 应用怎么连

- **Muse**：优先 Cloudflare Access 服务令牌单头，`read_service_tokens_from_header: Authorization`，源站校验 `Cf-Access-Jwt-Assertion`；来源标签从服务令牌解析。若 Muse 的 OAuth 支持 RFC 8707 且定时任务能静默续期，可用 Managed OAuth。若 Muse 实际能发三个头，则改走现有 `/api/muse-intake/v1/batch`，保留 ADR 0162 两层认证。单头方案需要新 ADR，不能悄悄放宽。
- **Claude 应用**：只能走 Cloudflare Access Managed OAuth（DCR）；源站校验 JWT；要求它支持 RFC 8707。若不支持，不能开放无认证写入口，写记忆功能暂缓。
- **Claude Code**：继续静态 Bearer + elicitation，当场确认；失败兜底进收件箱。

取舍：单头服务令牌让 Muse 无人值守可用，但牺牲应用层第二把独立密钥；OAuth 保留用户身份但依赖刷新；现有推送通道最稳但不是 MCP。

### 3. 业界做法

没有找到“某家 AI 记忆产品对外部 agent 写入采用待审队列”的一手材料；能核实的是通用的 human-in-the-loop / tool approval 模式：

- **MCP 官方 elicitation**：协议级“需要输入”，客户端可接受/拒绝/取消；未声明能力的客户端服务端不得发。
  <https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation>
  原话：`action: "accept"` / `"decline"` / `"cancel"`；“Clients validate responses against the provided schema before returning them to servers.”

- **OpenAI Agents SDK Human-in-the-loop**：暂停工具执行，返回 pending approvals，人批准后恢复。
  <https://openai.github.io/openai-agents-python/human_in_the_loop/>
  原话：“Use the human-in-the-loop (HITL) flow to pause agent execution until a person approves or rejects sensitive tool calls.”
  “When a tool call needs review, the SDK follows the same pattern every time: 1. The run records an approval interruption instead of executing the tool.”

- **LangGraph Interrupts**：在关键动作前暂停，支持 approve/edit/reject，正是“收件箱 + 批量/单条”的成熟开源做法。
  <https://docs.langchain.com/oss/python/langgraph/interrupts>
  原话：“Interrupts allow you to pause graph execution at specific points and wait for external input before continuing.”
  “One of the most common uses of interrupts is to pause before a critical action and ask for approval.”

- **Claude Code permissions**：Anthropic 官方说明工具按风险分级，文件修改、Bash 等需要人工批准；deny/ask/allow 规则由客户端执行。
  <https://code.claude.com/docs/en/permissions>
  原话：“Claude Code uses a tiered permission system to balance power and safety.”
  表中 `File modification` 的 `Approval required` 为 `Yes`。

这说明“外部写入先待审、人再批准”本身是成熟模式；本方案的不同点是把“待审”放在 Himawari 自己的收件箱，而不是要求每个客户端都支持弹框。

### 4. 会不会改变模型已经见过的请求开头

**Himawari 自己的模型不会。** 理由见必答问题 1：不新增 Himawari 系统提示/工具、不把 pending 接进任何模型路径、确认后的记忆只在后续轮次末尾出现。

**外部 MCP 客户端会看到一次工具定义变化。** 新增写工具会在它们的请求开头增加工具定义，可能让它们自己的缓存失效一次；这是 P5-2 加写工具本来就有的代价。本方案不再按能力动态增删工具，避免每轮变化。

### 5. 最大的风险和最容易漏掉的场景

**最大风险**：待确认内容通过某个现有宽查询进入模型上下文，尤其是复用 `tentative` 或把新表误接进 `recall`/主动检查。
**最容易漏掉**：Muse 同自然键内容更新（要 supersede 而不是丢弃/重复）、确认超时重试（确定性 memory id 幂等）、批量部分失败、主人编辑后文本变成 restricted、备份/导出是否包含待确认、以及 I-73 类“UI/清单里的 id 能不能过后端校验”。
