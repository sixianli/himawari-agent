## 审核范围与未能核实

- 已读：`production-mcp-read.ts`、`production-memory-control.ts`、`identity-gateway.ts`、`contracts-v2.ts`、决策账本写入与校验、迁移 0012/0069/0087、数据导出、`daily-review.ts`、`prompt-catalog`、规则文件。
- 未核实：P5-2 方案原文（`/mnt/project-files/p5-2-mcp-write/plan-thread.md`）读不到；`node_modules` 不在，无法确认官方 SDK 在每次请求里如何暴露 `clientCapabilities`；Muse 的真实回调地址、是否真的在所有 token 交换中带 RFC 8707、Claude 应用是否带 RFC 8707，均未实测。

---

## 一、已证实的问题（按严重度）

### 1.【高】把「声明了 elicitation」当成「一定会弹框、一定会重发」，会丢提议

- **问题**：方案第 2、4 节说：声明了 form elicitation 的客户端仍走当场弹框，不进待确认。MCP 规范明确要求服务端不能假设客户端会完成 `inputRequests` 或重试原请求。Claude Code 也明确说 `elicitation/create` 只在交互式终端会话里提供；非交互会话会要求服务端取消请求输入的任务。capability 是「客户端支持」，不是「现在有人在场」。
- **证据**：
  - MCP 2026-07-28 MRTR：「Servers **MUST NOT** assume that clients will fulfill the `inputRequests` or retry the original request.」<https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr>
  - Claude Code 文档：「`elicitation/create` is served only in interactive terminal sessions」；非交互会话「asks the server to cancel a task that requests input」<https://code.claude.com/docs/en/mcp>
  - P5-2 的 `requestState` 只有 10 分钟有效期（方案自述）。用户思考超过 10 分钟、客户端崩溃、网络断开，都会让重发失败。
- **建议**：不要做「elicitation 与待确认互斥」。做成同一条状态机：收到提议先落一条 `awaiting_client`/`pending` 草稿；能弹框就返回 `input_required`，客户端 `accept` 后转正式记忆；显式 `decline` 标拒绝；`cancel`、超时、没有重发则在宽限期后转成主人可见的待确认。这样目标 4 仍成立，但不会因为客户端「声明了 capability 但没人能点」而丢数据。

### 2.【高】「每个客户端最多 N 条 pending，超了拒绝」直接违反目标 1，而且会被 Muse 批量搬运触发

- **问题**：目标 1 是「写的记忆不丢」。方案在 pending 超过 200 条时明确拒绝。Muse 定时任务失败不重放，第一次同步超过 200 条新记忆就会永久丢；而且现有 MCP 入口按 `BearerGate` 每分钟只放 30 次有效请求（ADR 0219 第 55 行），Muse 批量搬运很容易先被 429，再因为「不支持重试」而丢。
- **证据**：
  - 方案第一节「每个客户端最多 N 条 pending（配置项，默认 200），超了明确拒绝」。
  - `docs/adr/0219-read-only-mcp-entry-with-static-token.md:55`：每分钟最多 30 次有效请求、60 次无效请求。
  - 方案自述：Muse 定时任务无响应连接 45 秒判失败不重试。
- **建议**：把「总量硬上限」换成「按认证主体的速率限制 + 全局存储预算」。唯一提议已经被去重，数量应接近「不同记忆条数」，200 太低。达到预算时也必须返回可重试的明确错误并写决策记录，不能对 Muse 这种不重试客户端说「拒绝」。更稳的做法是给 Muse 一个批量提议工具或复用现有批量入口，一次请求存多条，避免 30 次/分钟的限制。

### 3.【高】去重键包含「客户端自报名字」，跨客户端、名字变化、终态重发都会重复

- **问题**：
  - 键 = `sha256(客户端名 + 规范化正文)`。客户端名是自报的，可能带版本号、可能被截断成同一个词，也可能被伪造；同一段文字从 Muse 和 Claude 应用各来一次，会生成两条待确认。
  - 方案只对 `pending` 或 `kept` 去重。主人已经 `rejected` 或 `edited` 后，Muse 下一轮再发原文，会重新建 pending；主人会反复看到已经处理过的条目。
  - 「正文和一条现有正式记忆完全相同时不新建」需要扫全量正式记忆，没有现成的内容摘要索引，且并发下会竞态。
- **证据**：方案第一节；客户端名的取法见 `apps/agent-service/src/production-mcp-read.ts:118-128`（只取 `clientInfo.name`/User-Agent 的一段，默认 `unknown`）。
- **建议**：去重键用 `(owner_id, agent_id, 规范化正文哈希)`，来源作为多值元数据（一条提议可来自多个客户端），而不是把客户端名拼进键。增加 `rejected` 的抑制记录：同一内容被明确拒绝后，除非内容或来源项变化，不再自动重建。规范化算法要版本化并测试固定。

### 4.【高】连接入口的方案自相矛盾，且与现有校验代码不一致

- **问题**：
  - 方案说「Access JWT 取代固定令牌（或两者都接受，待定）」。安全鉴权不能「待定」；而且 Cloudflare Managed OAuth 会替换 Access 应用原来的 `401` 行为，现有 MCP 路由在 401 时自己发 `WWW-Authenticate: Bearer realm="himawari"`，两套挑战混在一起可能破坏 Claude/Cloudflare 的 OAuth 发现。
  - 方案说「Himawari 校验 Access 公钥、aud、主人邮箱」。现有 `CloudflareAccessJwtVerifier` 只校验 issuer、audience、签名、`sub`、`exp`，不读邮箱；邮箱是 Access 策略层保证的，不是这个校验器。
  - 方案的回退「Muse 用 `read_service_tokens_from_header` 单头服务令牌」与方案自己引用的事实矛盾：Cloudflare 的单头值是包含 client id 和 secret 的 JSON；Muse 已说「单头 JSON 不可行」。
  - Cloudflare Managed OAuth 要求客户端支持 RFC 8707；Muse 的回调地址未公布，而 Cloudflare 的 DCR 允许列表需要列出重定向 URI（自定义 scheme 必须精确列出，不能通配）。
- **证据**：
  - Cloudflare Managed OAuth：「An OAuth client that supports RFC 8707」；「Managed OAuth issues **opaque** access tokens … forwards a signed assertion to your origin」；「The MCP server must validate the Access JWT」<https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/>
  - Cloudflare 服务令牌单头：「`Authorization: {"cf-access-client-id": "...", "cf-access-client-secret": "..."}`」<https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>
  - `packages/platform-node/src/identity-gateway.ts:192-215`：只校验 issuer/audience/RS256/sub/exp，不校验邮箱。
  - `apps/agent-service/src/production-mcp-read.ts:359-366`：401 时自己设置 `www-authenticate: Bearer realm="himawari"`。
- **建议**：一个路径只保留一套应用层鉴权。如果用 Managed OAuth，就只校验 Access JWT，返回 401 时不要发与 Cloudflare OAuth 发现冲突的挑战；邮箱只作为 Access 策略的配置项写进运行手册，不要在代码注释里声称已校验。Muse 的回调 URI、RFC 8707、定时任务刷新必须先实测再决定；单头服务令牌回退方案在没有 Muse 实测前删掉，不要作为「退路」。

### 5.【高】新网关操作、快照字段、契约和安装列表没有列全，属于 I-73 类问题

- **问题**：方案只写了「新增 `memory.external.respond`」和「网页新增一组」，但没有说明：
  - 新命令必须加进 `PRODUCTION_MEMORY_OPERATIONS`，否则网关会报未安装。
  - 必须加进 `packages/gateway-contracts` 的命令枚举、schema、fixture，否则 UI 发出的命令过不了校验。
  - 现有 `memory.overview.snapshot.pending` 每项要求 `threadId`（`machineString`）和 `topic`，外部提议没有 thread；不能直接塞进 `pending`，否则要么类型不合法，要么语义错误。需要新增 `externalPending` 字段。
  - `apps/control-center/src/memory.ts` 的 `respond` 只接受单个 `requestId`，需要新的批处理方法和类型。
  - 新配置项、新状态值、新提示词文字都要登记。
- **证据**：
  - `apps/agent-service/src/production-memory-control.ts:49-65` 的 `PRODUCTION_MEMORY_OPERATIONS`。
  - `packages/gateway-contracts/src/contracts-v2.ts:1300-1309`：`pending` 每项 `threadId: machineString`。
  - `packages/gateway-contracts/src/contracts-v2.ts:1387-1394`：`memory.approval.respond` 只接受单个 `requestId`。
  - `apps/control-center/src/memory.ts:145-150`：网页当前只能逐条回应敏感审批。
  - `packages/prompt-catalog/src/tools.ts:225-259`：MCP 工具文字都登记在提示词目录；方案没有给 `propose_memory` 的待确认结果文字登记。
- **建议**：在方案里加一张「值 → 产生处 → 使用处 → 校验」的清单：新命令、`externalPending` 快照字段、`PRODUCTION_MEMORY_OPERATIONS`、`installedGatewayV2Operations`、契约 schema/fixture、UI 类型、提示词目录、配置 schema。并加一条类似 `check:model-ref-contract` 的检查：UI 能发出的每个新 id/命令都要过后端校验。

### 6.【中高】「来自哪个客户端」是自报值，不能当身份、限流键或审计依据

- **问题**：方案用 `clientInfo.name` 做来源展示、去重键和每客户端限额。任何拿到有效令牌的客户端都可以自称 `Muse`。在 Access OAuth 模式下，所有客户端携带的是同一个主人的身份，服务端并不知道真实客户端；在固定令牌模式下更不知道。主人看到「来自 Muse」会误以为是可信归属。
- **证据**：`apps/agent-service/src/production-mcp-read.ts:118-128`；ADR 0219 第 76 行也写明「两者都只是对方自己报的名字」。Cloudflare Managed OAuth 的 token 是用户身份，不是客户端身份；服务令牌「No user identity」<https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/>。
- **建议**：分开存「认证主体」（Access `sub` 或服务令牌 id）和「自称客户端标签」。UI 显示「自称：Muse」，不要写「来自 Muse」。限流和配额按认证主体做，客户端标签仅用于分组展示；去重不要依赖它。

### 7.【中】外部输入的分类和类别没有定义，可能允许外部降低分级或写入 rule 类记忆

- **问题**：方案说每条提议有「分类、数据分级」，又说「先做和网页新建记忆相同的检查（restricted 直接拒）」。但网页新建时分级是 UI 用 `classificationWithIdentifiers(text, "private")` 或用户勾选 sensitive 得出的，`classificationWithIdentifiers` 只会升到 `sensitive`，不会产出 `restricted`。如果服务端改为信任外部客户端传的分级，外部可以把敏感文本标成 `public`；如果服务端自己分类，「restricted 直接拒」这个检查基本触发不了。另外外部提议如果允许 `category: "rule"`，确认后会以 importance 800 进入 owner profile（`owner-profile-service.ts:204-207`），等于外部 agent 可以提出改变 Himawari 行为的规则。
- **证据**：`packages/sensitive-capture/src/identifiers.ts:20-27`；`apps/agent-service/src/production-memory-control.ts:795-843`；`packages/application/src/services/owner-profile-service.ts:204-207`。
- **建议**：分级由服务端用 `classificationWithIdentifiers(text, "private")` 决定，外部只能要求更高分级，不能降低。类别用 `MEMORY_CATEGORY_NAMES` 校验；外部提议默认禁止 `rule`（或要求单独确认并显示「这会改变 Himawari 的规则/档案」）。敏感类别（health/finance 等）仍走主人确认，但 UI 要标出。

### 8.【中】整批确认的事务、部分失败和幂等没有定义

- **问题**：方案说「每条在事务里」，但没有定义：一批里第 3 条失败时前 2 条是否已提交；返回给 UI 的是整体成功还是逐条结果；同一批重复提交时如何避免重复创建；`memory.external.respond` 是否限制一次最多多少 id。现有 `memory.import.commit` 有 1–500 条的限制，新命令没有对应约束。
- **证据**：`packages/gateway-contracts/src/contracts-v2.ts:1368-1381` 的 import 限制；`production-memory-control.ts:891-919` 的逐条创建；`durable-memory-service.ts:121-144` 对同 id 同内容幂等、不同内容抛冲突。
- **建议**：命令 payload 定义成 `items: [{proposalId, resolution, editedText?}]`，限制 1–500；逐条返回 `{proposalId, status, memoryId, errorCode}`；每条用确定性 id 和确定性决策记录 id；同一 proposal 重复提交按当前状态返回已有结果，不重复写账本。

### 9.【中】「不自动过期」+ 无保留策略，会导致数据永久堆积；导出/备份没有覆盖新表

- **问题**：方案以「过期等于静默丢掉主人的数据」为理由不设过期，但没有替代的保留策略：rejected 的正文是否保留、pending 多年后是否还显示、主人如何清理。新表也没有出现在数据导出的表清单里。敏感审批表同样不在导出清单，说明这可能是现有取舍，但方案应明确。
- **证据**：`packages/persistence-sqlite/src/data-export/import.ts:56-65` 的 `EMPTY_TARGET_TABLES` 和 `snapshot.ts` 都是显式枚举表，没有 `memory_approval_requests` 或新表。
- **建议**：不自动删正文，但增加 `stale` 状态和「主人可清理」动作；至少定义 rejected 正文字段的保留期限。明确新表是否进导出/备份；若不进，在 ADR 里写清楚为什么。

### 10.【中】整批保存没有撤销入口

- **问题**：一次「全部保存」可能创建几十上百条正式记忆。现有记忆导入有 `memory.import.commit` + `memory.import.undo` 的批次撤销，而外部提议的确认没有批次 id，也没有撤销。主人误点后只能逐条删。
- **证据**：`production-memory-control.ts:891-944` 的 import batch 与 undo 模式；方案第三节没有提 undo。
- **建议**：每次确认生成一个 `external` 批次，创建的记忆带 `import_batch_id`，复用 `memory.import.undo` 或新增同样的撤销动作。这样「整批确认」是可逆的。注意 `memory_import_batches.source` 当前枚举只有 `codex/assistant/himawari`（`contracts-v2.ts:962`），需要决定用哪个值或扩展枚举。

### 11.【低】提示词目录、工具注解和界面数字定义还不完整

- **问题**：新工具描述、待确认结果文字必须登记 `prompt-catalog`；`propose_memory` 的注解应明确 `readOnlyHint: false`、`idempotentHint: true`（同文本重发不重复）。界面「待确认 N 条」定义为 `status=pending` 的行数，但现有 overview 在正文读不出来时会跳过条目不展示（`production-memory-control.ts:670-672`），这会让数字和可见条目不一致。
- **证据**：`packages/prompt-catalog/src/tools.ts:225-259`；`production-memory-control.ts:667-681`。
- **建议**：登记所有新文字；注解写明；数字定义改成「可见且正文可读的 pending 条数」，或把不可读条目也显示成错误行。

---

## 二、推测 / 需实测（未核实）

### 1.【高，推测】Muse 的 OAuth 回调与 RFC 8707 未必能直接接上 Cloudflare Managed OAuth

- **问题**：方案引述「Muse 回调地址未公布（DCR 时不用填）」。DCR 时用户不填，但客户端仍会提交 `redirect_uris`；Cloudflare 的 `dynamic_client_registration.allowed_uris` 必须允许它。Muse 的回调若是自定义 scheme，Cloudflare 要求精确列出、不能用通配符。如果 Muse 不支持 `https://` 或 localhost 回调，Managed OAuth 可能直接注册失败。
- **依据**：Cloudflare 文档「Native applications may use private-use URI schemes … Custom-scheme URIs must be listed explicitly and match exactly; they cannot contain wildcards」<https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/>。
- **建议**：在 PR B 之前先做一次真实 DCR 实测，拿到 Muse 的 `redirect_uris`；如果无法提前拿到，就把「Managed OAuth 接 Muse」标成未验证，不要把 PR B 写成已完成。

### 2.【中，推测】Claude 应用是否发送 RFC 8707 未逐字确认

- **问题**：Cloudflare Managed OAuth 的硬前提是客户端支持 RFC 8707。Claude 的 connector 文档讲 `resource` 要匹配 MCP URL，但没有逐字说 Claude 应用在授权和 token 请求里都带 `resource`。
- **依据**：Claude connector auth 文档 <https://claude.com/docs/connectors/building/authentication>；MCP 2026-07-28 规范要求客户端 MUST 实现 RFC 8707。
- **建议**：实测一次；如果 Claude 应用不带，Managed OAuth 不可用，需要另找授权服务器。

### 3.【中，推测】服务端是否能在每次请求里拿到声明的能力，未核实

- **问题**：方案依赖「客户端声明了 form elicitation」。现有代码只用了 `CLIENT_INFO_META_KEY` 取名字（`production-mcp-read.ts:118-128`），没有看到读取 `clientCapabilities` 的代码；仓库里没有 `node_modules`，无法确认 SDK 的 `context.mcpReq.envelope` 是否在旧版回退请求里带能力。
- **建议**：在实现前写一个最小测试，分别用 2026-07-28 客户端和 2025-era 客户端各发一次，打印 `envelope`；不要在没确认的情况下把「没声明」当成「不支持」。

### 4.【中，推测】P5-2 的写入函数可能与新的决策记录路径重复写账本

- **问题**：P5-2 可能已经在确认后写 `memory_candidate` 决策记录。方案又说收到时写 `pending_approval`、决定后写 `kept/discarded`。如果 P5-2 的写入函数内部也写一条，最终会出现一条提议对应三条账本记录。
- **建议**：合并前先读 P5-2 的实现，明确账本写入归谁；建议由新的外部提议服务统一写，P5-2 的写入函数只负责建记忆。

### 5.【低，推测】Managed OAuth 与现有 `WWW-Authenticate` 的冲突程度

- **问题**：Cloudflare 文档说 Managed OAuth 会替换 Access 应用原来的 401 行为；如果源站 401 还带自己的 `Bearer realm`，客户端可能被引向错误发现流程。
- **建议**：在接入 Access 的路径上不要返回自定义 `WWW-Authenticate`；用集成测试模拟 Claude 的发现流程。

---

## 三、侧重检查

- **错误路径**：查了 elicitation 的 accept/decline/cancel/不重发、超时、客户端非交互、服务重启、正文 payload 丢失、账本写失败、批量部分失败、重复提交。结论：方案只覆盖了「没声明 elicitation → 存 pending」这一条；其余多数没有定义，第 1、8 条是实质缺口。
- **不合规范/不可信输入**：查了 `clientInfo.name`、`user-agent`、category、dataClassification、正文长度、控制字符、HTML/提示注入。结论：客户端名、分类、长度都没有在方案里定义服务端校验；`classificationWithIdentifiers` 不会产出 `restricted`，方案的「restricted 直接拒」需要重新说明。
- **安全**：查了自报客户端名冒充、固定令牌与 Access JWT 并存、服务令牌无用户身份、跨 owner 的 proposal id、网页 XSS、MCP 401 挑战冲突。结论：第 4、6 条是主要问题；跨 owner 校验必须在 `memory.external.respond` 里显式做。
- **资源耗尽**：查了 65 KB 请求体、每客户端 200 条、30 次/分钟、无过期、批量 id 数量、去重全表扫描。结论：第 2 条会直接丢 Muse 数据；批量 id 没有上限；去重「与现有正式记忆比对」没有索引方案。
- **不可撤销的操作**：查了整批保存、逐条保存、拒绝、编辑后保存。结论：整批保存没有撤销入口，第 10 条；建议复用 import batch/undo。
- **规则/文档/代码一致**：查了 `prompt-prefix.md`、I-73、ADR 0219、ADR 0179、gateway contracts、`PRODUCTION_MEMORY_OPERATIONS`、overview 快照、数据导出。结论：第 5 条是典型的 I-73 类问题；「Access JWT 校验主人邮箱」与 `identity-gateway.ts` 不一致；新提示词没有登记。

---

## 四、如果由我来定，我会怎样改这份方案

1. **保留新表，但把它做成一条状态机，而不是「elicitation 路径」和「pending 路径」二选一。**
   - 字段建议：`id`、`owner_id`、`agent_id`、`content_hash`、`content_ref`、`category`、`classification`、`source_principal`、`self_reported_client`、`source_user_agent`、`source_item_key`、`status`（`awaiting_client` / `pending` / `kept` / `edited` / `rejected` / `stale`）、`received_at`、`decided_at`、`memory_id`、`batch_id`、`decision_id`。
   - 所有 `propose_memory` 调用先写一条 `awaiting_client` 草稿；能弹框就返回 `input_required`；`accept` 转正式记忆，`decline` 标拒绝；`cancel`/超时/没有重发则转 `pending` 给主人。这样既满足目标 4，又满足目标 1。

2. **去重改成内容寻址，不把客户端名拼进键。**
   - 唯一键：`(owner_id, agent_id, content_hash)`，`content_hash = sha256(规范化的原文)`。来源作为多值字段；同一内容从 Muse 和 Claude 来，只生成一条，显示多个来源。
   - `rejected` 也保留抑制记录；`edited` 后重发原文不再重建。规范化的算法版本写进测试。

3. **把「每客户端 200 条硬上限」换成速率限制 + 全局预算。**
   - 按认证主体限速（例如每分钟 20–30 条唯一提议），按全局存储预算预警；不要因为单客户端 pending 多就拒绝。批量场景给 Muse 一个批量提议工具或复用现有批量入口，避免 30 次/分钟。

4. **连接入口分开做决定。**
   - Claude 应用：Managed OAuth；实测 RFC 8707 和回调 URL。
   - Muse：优先实测 Managed OAuth 的回调、RFC 8707、定时任务刷新；如果回调无法预先配置或刷新不可靠，改走「Muse 已有的批量推送通道 + 新的 memory_proposal 条目类型」，不要硬把它塞进 MCP 的 30 次/分钟和单凭据限制。`read_service_tokens_from_header` 单头 JSON 在 Muse 明确说不可行后删掉。
   - 一个路径只保留一套应用层鉴权；邮箱由 Access 策略负责，代码只校验 issuer/aud/sub/exp。

5. **把网关契约一次列全。**
   - 新命令 `memory.external.respond` 进 `PRODUCTION_MEMORY_OPERATIONS`、`contracts-v2.ts`、fixture、`installedGatewayV2Operations`；新快照字段 `externalPending` 进契约和 control-center 类型；`items` 限制 1–500；逐条返回结果。
   - 加一条检查：UI 能发出的每个 proposal id / 命令都必须过后端校验（I-73 的教训）。

6. **确认后可撤销。**
   - 每次确认生成 `external` 批次，创建的记忆带 `import_batch_id`；复用/新增 undo。整批保存前给主人一个摘要确认，避免一键把几十条不可信文本变成正式记忆。

7. **决策记录用确定性 id。**
   - 收到：`memory_candidate` / `pending_approval` / `reasonCode = external_pending` / `subjectRef = proposal id`。
   - 决定：`kept` / `discarded`，reasonCode 分别用 `external_owner_kept` / `external_owner_edited` / `external_owner_rejected`；确定性 id 保证重放不重复。注意 `validateLedgerWrite` 对 `subjectRef` 1–256、`reasonCode` 1–64、`inputs.memoryIds` 的约束（`sqlite-decision-ledger-operations.ts:51-111`）。

8. **文档和测试同步。**
   - 客户端支持表要写「声明了 elicitation 但可能是非交互会话」；测试要覆盖非交互、取消、超时、拒绝、重发、跨客户端去重、批量部分失败、跨 owner、分类降级、提示词目录、契约校验、prompt-prefix。

---

## 五、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会，前提是按上面的方式实现。** 依据 `.claude/rules/prompt-prefix.md` 第 2、4 条：

- 待确认条目存在新表，不进入 `find_memories`、`today_context`、`rule_book`、主动检查、记忆整理、档案块；因此不会出现在模型请求里。
- MCP 的 `propose_memory` 工具定义只给外部客户端，不进 Himawari 自己的工具列表；ADR 0219 也要求「Himawari 自己发给模型的请求一个字节都不变」。
- 确认后的记忆和网页新建记忆一样，通过每轮最后一条用户消息里的检索资料进入；这是末尾追加，不是改请求头。
- 新增的固定提示词只对新对话生效（规则第 6 条）。
- 当前 `daily-review.ts` 是 UI/决策账本的汇总，不是模型请求；「有 N 条待确认」不应写进系统提示。每轮变化的 pending 数、收到时间、客户端名、proposal id 只能出现在最后一条消息或外部工具返回里。

**需要特别禁止**：不要把来源客户端名、收到时间、proposal id 拼进记忆正文；不要因为新增 `externalPending` 快照字段而改模型工具定义。还有一个例外要确认：如果外部提议允许 `category: "rule"`，确认后会进入 owner profile（`owner-profile-service.ts:204-207`），这会改变每轮资料块的内容——仍然是末尾追加，但会改变模型看到的材料；如果不想让外部 agent 影响规则，就在提议入口禁止 `rule` 类。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**待确认内容本身不会进入模型，所以不会直接影响模型字节。** 但方案里有三处会让「同一段文字」得到不同的 id/字节：

- 去重键包含自报客户端名和未定义的「规范化正文」；名字或规范化版本一变，同一文本得到不同 key。如果 key 又用来生成 `memory:mcp:<id>`，同一文本会变成不同记忆 id。
- 如果确认时把来源、收到时间拼进记忆正文，同一段原文会因来源不同而字节不同。
- 主人编辑后保存，字节当然不同，这是有意的。

**建议**：用 `(owner_id, agent_id, sha256(规范化原文))` 做唯一键；来源、时间、客户端名只做元数据，不进入正文；规范化算法版本化并固定测试。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**不够。** 方案只写了「真实 SQLite、官方 SDK 客户端不声明 elicitation」一个正向用例。至少还要有：

- **反向用例**：去掉 pending 分支、把「声明 elicitation」当必然重发、用自报客户端名做限额、允许跨 owner 的 proposal id、允许外部降低分类、去掉账本写入、去掉 batch 上限——这些测试都必须失败。
- **场景**：非交互 Claude Code、用户 decline/cancel/超时、客户端不重发、重复提交、并发提交、Muse 超过 30 次/分钟、pending 超过上限、正文超长/控制字符、空正文、restricted/sensitive、跨客户端同文去重、rejected 后重发、批量部分失败、正文 payload 丢失、账本写失败。
- **契约**：新命令和 `externalPending` 必须过 gateway contracts；UI 发出的 id 必须过后端校验（I-73）。
- **提示词**：`npm run check:prompt-prefix`、`check:prompt-catalog`；确认新 MCP 文字只进外部工具，不进 Himawari 自己的工具列表。
- **入口**：Access JWT 的 issuer/aud/exp 失败、错误 audience、过期 token、服务令牌 vs OAuth 的权限差异。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对后，有几处不能直接接受：

- **proposal id → `memory:mcp:<id>`**：`memory.create` 的 id 最终要过 gateway 的 `machineString`（1–128，字母数字和 `._:-`，`validation.ts:49-59`）。如果 proposal id 用 UUID 或 sha256 hex 都没问题；如果用了带空格、超过 128 字符的 id 就会失败。建议固定用 UUID/hex，长度 ≤ 64。
- **客户端名 → 决策记录 `subjectRef`**：`subjectRef` 只允许 1–256（`sqlite-decision-ledger-operations.ts:61`）。必须复用 `clientNameOf` 的清洗和截断，不能直接用原始 `clientInfo.name`；原始名字可能超过 256 或带控制字符。
- **分类/分级 → `memory_records.classification` 和 `MEMORY_CATEGORY_NAMES`**：必须有服务端白名单；不能信任外部传值。`classificationWithIdentifiers` 不会产生 `restricted`，所以「restricted 直接拒」要么改成「外部声称 restricted 时拒绝」，要么说明为什么不会出现。
- **新命令 → `PRODUCTION_MEMORY_OPERATIONS`、contracts、fixture、installed ops、UI 类型**：缺一个就报「未安装」或校验失败（I-73）。
- **新快照字段 → `memory.overview.snapshot` 契约和 control-center 类型**：现有 `pending` 的 `threadId: machineString` 不适用于外部提议，不能复用。
- **新配置项 N → 启动配置 schema 和文档**：要有默认值、范围校验。
- **决策记录 kind/outcome/reasonCode → `validateLedgerWrite`**：`pending_approval` 已允许；`reasonCode` ≤ 64；`subjectRef` ≤ 256；`memory_candidate` 的 `category` 必须在 `DECISION_CATEGORIES` 里，`confidencePermille` 0–1000，`inferred` 布尔或 null。
- **import batch id / source → `memory_import_batches.source` 枚举**：如果为了撤销而复用 import batch，当前枚举只有 `codex/assistant/himawari`，需要决定用哪个或扩展。
- **新表 → 迁移顺序、DDL 约束、导出/备份**：至少要有 `owner_id`/`agent_id` 外键、status CHECK、content hash 唯一索引、payload ref 外键；导出是否包含要明确。
- **新提示词文字 → `prompt-catalog`**：所有新工具描述、待确认结果文字都要登记，否则 `check:prompt-catalog` 会失败。

### 5. 最大的风险和最容易漏掉的场景

- **最大风险**：把「自报客户端名」当成身份，用它做去重、限额和展示。它既可以被伪造，也会把不同客户端算成不同来源；再叠加「每客户端 200 条硬上限」，会同时造成「Muse 数据丢失」和「冒充 Muse 挤占真实 Muse 的额度」。
- **最容易漏掉的场景**：
  1. Claude Code 在非交互会话、用户取消、超时、进程退出时不重发 elicitation——提议直接消失。
  2. Muse 第一次同步超过 200 条，或超过 30 次/分钟——不重试，直接丢。
  3. 整批确认第 3 条失败时，前 2 条已提交，主人不知道哪些成功。
  4. 新命令/快照字段漏进契约或 `PRODUCTION_MEMORY_OPERATIONS`，功能根本跑不起来（I-73）。
  5. Cloudflare Managed OAuth 的 Muse 回调、RFC 8707、刷新过期没有实测，PR B 上线才发现连不上。
  6. 主人整批保存了外部 agent 写来的 prompt injection 文本，或 `rule` 类记忆进入档案块，之后持续影响 Himawari。
  7. 新表不在导出/备份里，换机器或恢复时待确认记忆全丢。
