---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-26"
implementation: in_progress
covers: "packages/platform-node/src/app-connections.ts, packages/persistence-sqlite/src/sqlite-app-connection-operations.ts, apps/agent-service/src/production-app-tools.ts, apps/agent-service/src/production-runtime-tools.ts, apps/agent-service/src/production-tool-actions.ts, packages/prompt-catalog/src/apps.ts"
verified_at: "b08a65a20cda4f6bc90c2a5946b3e5123b88f032"
---

# ADR 0311：其他应用一律通过远程 MCP 加 OAuth 连接

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
  - [怎样连接](#connect)
  - [Himawari 怎样用](#use)
  - [什么时候先问 Andy](#ask)
- [比较过的方案](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

2026-11-26 Andy 看到 Gmail 连接在做，问：以后还想接更多应用怎么办？调研结论（三条）Andy 同意：接其他应用一律走对方的远程 MCP 服务器加 OAuth 登录，浏览器代办只当后备；付钱用面容 ID 批准、在对方结账页付；暂不接 agent 支付协议。MCP（Model Context Protocol，让模型调用外部工具的公开协议）是 Anthropic、OpenAI、Google 的客户端都支持的接法。

随后 Andy 批准了“通用连接”方案（Claude 文档“通用“连接”方案”），第一批依次是 Gmail、GitHub、iPhone 上的日历、提醒、健康和通讯录；并在决策卡“Himawari 用 GitHub 时，哪些操作要先问你？”上选了“官方标只读的直接用”。

<a id="premises"></a>

## 前提

1. MCP 授权规范要求客户端用 PKCE（S256），授权和换令牌请求都带 `resource` 参数，服务器不公布 `code_challenge_methods_supported` 时客户端拒绝继续（[MCP 授权规范 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)）。
2. 规范原话：客户端“MUST consider tool annotations to be untrusted unless they come from trusted servers”（工具标注例如 `readOnlyHint`，除非来自可信服务器，一律当作不可信）（[MCP 工具规范 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)）。
3. GitHub 官方远程 MCP 服务器默认地址是 `https://api.githubcopilot.com/mcp/`（[remote-server.md](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)）；原话“Dynamic Client Registration is NOT supported by Remote GitHub MCP Server at this time”，所以要先建 GitHub App 拿客户端编号和密钥（[host-integration.md](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)）。
4. 官方 MCP 客户端 SDK `@modelcontextprotocol/client` 2.0.0 自带完整的 OAuth 流程（`auth()`、`OAuthClientProvider`），带 `authProvider` 的传输层会自动换新令牌（`packages/platform-node/package.json` 锁定的版本）。
5. 工具集合尽量不变，设备动作已经用“一个固定工具加 describe”的写法，动作再多也不改工具定义（`.agents/instructions/prompt-prefix.md` 第 7 条）。
6. 有后果的工具走统一权限出口：`OwnerScopeAuthorization.authorize` 冻结意图，没有授权时返回 ASK，主人同意后同一个工具调用重放时放行（`apps/agent-service/src/owner-scope-authorization.ts`）。

<a id="decision"></a>

## 决定

<a id="connect"></a>

### 怎样连接

1. **一个应用就是服务器配置里的一行**：`runPolicy.appConnections` 写名字、显示名、MCP 网址、客户端编号、客户端密钥的引用和 `trustsReadOnlyLabels`；客户端密钥存在密钥库里，用途是 `app-connection-client`。新增应用不改代码。生产上这一行写在 `scripts/delivery-mode/instances/andy-production.json` 的 `configTargets.appConnections`，由上线流程在配置切换时连同密钥引用一起写进生产配置；密钥文件本身由 Andy 放在生产机上，不进仓库。
2. **登录照 MCP 规范做**，全部交给官方 SDK：PKCE、`resource`、令牌过期自动换新。App 用系统授权弹窗打开对方登录页，对方跳回 `/api/connections/v1/callback`（公开地址，靠一次性 state 把关，state 绑定发起的设备、10 分钟过期、只能用一次），服务器再跳回 App。
3. **令牌加密存在服务器上**，表 `app_connections` 只存加密内容的引用和状态（已连接、要重新登录）；换新令牌失败时标成“要重新登录”。断开连接删记录和加密内容，属于收紧，不要面容 ID。

<a id="use"></a>

### Himawari 怎样用

4. **一个固定的 `app_action` 工具**，不按应用加工具：`describe` 列出接着的应用和工具（带上 app 和 tool 时给完整参数），`call` 调用，`run` 运行模型写的代码（Code Mode，见 [ADR 0313](0313-app-code-mode.md)）。工具定义是提示词目录里的固定文字，接多少应用、应用有多少工具都不改它，也不改已经发出的请求开头。
5. 应用返回的内容和应用写的工具说明都是外来内容：调用和列出工具时给这一轮记上外来内容，之后有后果的动作照 [ADR 0285](0285-one-main-thread-subthreads-and-one-inbox.md) 的规则先问。

<a id="ask"></a>

### 什么时候先问 Andy

6. 配置里标了 `trustsReadOnlyLabels` 的官方服务器（GitHub、谷歌）上、工具自己标了只读的，直接用。
7. 其余一律先问：建 issue、推代码、删东西等不是只读的工具，以及没标信任的应用（Andy 自己填网址加的）里的所有工具，包括它自称只读的。确认卡写“应用 · 工具名”和参数摘要。

<a id="options"></a>

## 比较过的方案

- **每个应用手写一套接入**（像 Gmail 那样）：每接一个都要写 OAuth、令牌、工具，接得越多越难维护。不采用；Gmail 因为要在后台盯新邮件，暂时保留内置。
- **把每个应用的工具直接加进模型的工具列表**：模型调用更直接，但接一个应用、应用升级一次，工具定义就变，同一对话的缓存整段失效。不采用。
- **所有应用调用都先问**：最安全，但查个 issue 也要点一次，Andy 否决。
- **完全照工具自称的标注放行**：规范明说标注不可信，Andy 自己加的应用不放行。

<a id="consequences"></a>

## 后果

- 好处：接新应用只加一行配置和一次登录；模型的工具定义一直不变；先问的范围由程序定，不靠模型自觉。
- 代价：每次 `call` 都先列一次工具确认标注，多一次网络往返；GitHub 这类不支持动态登记的应用要 Andy 先在对方后台建一个应用拿客户端编号和密钥。
- 要跟进：iPhone 上的通用连接页、第一批的 iPhone 日历、提醒、健康和通讯录，做完后去掉 `implementation: in_progress`。
