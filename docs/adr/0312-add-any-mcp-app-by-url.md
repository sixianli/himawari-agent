---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-27"
implementation: in_progress
covers: "packages/platform-node/src/app-connections.ts, packages/platform-node/src/device-api-routes.ts, packages/persistence-sqlite/src/sqlite-app-connection-operations.ts, apps/agent-service/src/production-http-composition.ts, clients/apple/Sources/HimawariManage/Connections"
verified_at: "b05988a45"
---

# ADR 0312：在 iPhone 上填网址，接任意远程 MCP 应用

<a id="contents"></a>

## 阅读导航

- [两个问题的回答](#answers)
- [前提](#premises)
- [决定](#decision)
  - [添加](#add)
  - [客户端身份](#client)
  - [什么时候先问](#ask)
- [和大厂不同的地方](#differences)
- [后果](#consequences)

<a id="answers"></a>

## 两个问题的回答

**大厂怎么做。** Claude 和 ChatGPT 都让用户自己填一个远程 MCP 服务器的网址来加应用（Claude 叫“自定义连接器”，ChatGPT 叫“开发者模式”里的“自定义 MCP 服务器”）。填完网址就去对方那里登录。客户端身份（对方登录服务器用来认出“这是哪个程序”的编号）的取法按 MCP 规范的顺序来：用户手填的编号优先；没填时，对方声明支持“客户端元数据文档”（CIMD，客户端把自己的说明放在一个公开网址上，这个网址就当编号用），就用 CIMD；不支持就用动态注册（DCR，RFC 7591，客户端当场向对方注册一个编号）。两家都提醒用户“这是没经过审核的服务”。ChatGPT 认工具自己标的“只读”，其余写操作先问；Claude 让用户按工具选“总是允许”或“先问”。

**这样做是不是根治。** 是。[ADR 0311](0311-connecting-apps-through-remote-mcp.md) 的做法是每接一个应用，就在服务器配置里写一行、在对方后台手工建应用拿编号；接什么由上线配置决定，用户自己加不了。这次改成：用户在 App 里填网址，服务器自动找到对方的登录服务器，自动拿到客户端身份，只有对方三种办法都不支持时才请用户去对方后台建应用、把编号填进来。上线配置里的应用（GitHub）保留，走同一套流程。

<a id="premises"></a>

## 前提

1. MCP 规范给的取身份顺序：“1. Use pre-registered client information … 2. Use Client ID Metadata Documents if the Authorization Server indicates support (via `client_id_metadata_document_supported`) 3. Use Dynamic Client Registration … 4. Prompt the user to enter the client information”；动态注册“is deprecated as of protocol version `2026-07-28`”，新实现应该用 CIMD（[MCP 规范：客户端注册](https://modelcontextprotocol.io/specification/latest/basic/authorization/client-registration)）。
2. CIMD 文档必须放在 https 网址上，`client_id` 必须和文档网址完全一样，必填 `client_id`、`client_name`、`redirect_uris`（同上）。
3. Claude 的规则：“Claude normally selects CIMD only when your authorization server metadata advertises both `"client_id_metadata_document_supported": true` and `"none"` in `token_endpoint_auth_methods_supported`, and otherwise falls back to DCR”（[Claude 文档：Authentication](https://claude.com/docs/connectors/building/authentication)）。
4. Claude 添加连接器时填名字和网址，“OAuth client”可选用 Claude 的公开身份、自动注册或自己的客户端编号和密钥；页面提示“Custom connectors allow connections to unverified services”（[Claude 文档：Remote MCP](https://claude.com/docs/connectors/custom/remote-mcp)）。
5. ChatGPT：“ChatGPT prioritizes CIMD when it is available”，DCR “lets ChatGPT create and reuse a dedicated client_id”（[Apps SDK：Authentication](https://developers.openai.com/apps-sdk/build/auth)）；“We respect the `readOnlyHint` tool annotation… Tools without this hint are treated as write actions”（[ChatGPT 开发者模式](https://developers.openai.com/api/docs/guides/developer-mode)）。
6. 官方 SDK `@modelcontextprotocol/client` 2.0.0 的 `auth()`：提供方的 `clientInformation()` 返回空时，对方声明支持 CIMD 且提供方给了 `clientMetadataUrl` 就用 CIMD，否则调用 `registerClient` 做动态注册，结果交给 `saveClientInformation` 保存；保存时带上登录服务器的 `issuer`，换了登录服务器会丢弃旧身份重新取（`node_modules/@modelcontextprotocol/client/dist/index.mjs` 第 698–731 行）。
7. 设备接口里，用面容 ID 签名的请求带 `authenticated.confirmed`，放宽权限的操作（例如 `actions/policy`）没有它就回 403 `DEVICE_OWNER_PRESENCE_REQUIRED`（`packages/platform-node/src/device-api-routes.ts` 第 1443–1456 行）。
8. ADR 0311 第 7 条（Andy 定）：没标信任的应用，也就是 Andy 自己填网址加的，所有工具一律先问，包括它自称只读的（`docs/adr/0311-connecting-apps-through-remote-mcp.md` 第 71 行）。

<a id="decision"></a>

## 决定

<a id="add"></a>

### 添加

1. iPhone 连接页加“添加应用”：填 MCP 服务器网址；名字可以不填，不填就用对方服务器自报的名字（MCP 握手里的 `serverInfo`），再没有就用网址里的主机名；“高级”里可以填客户端编号和密钥。页面写明“这是没经过审核的服务，只连你信任的”。添加要面容 ID，属于放宽权限。
2. 服务器只接受 https 网址，不接受账号密码写在网址里，也不接受直接写 IP 或 `localhost` 的网址，免得被用来访问服务器自己的内网。
3. 添加时服务器先不带令牌连一次：对方不要求登录就直接算连上；回 401 就记下应用，App 接着打开对方的登录页，和已有的连接流程一样。
4. 用户加的应用存在表 `app_connection_apps`（名字、显示名、网址、添加时间）。删除应用会同时删掉它的令牌和客户端身份，属于收紧，不要面容 ID。

<a id="client"></a>

### 客户端身份

5. 照前提 1 的顺序：上线配置或用户手填的编号；之前取到并保存的身份（同一个登录服务器）；对方声明支持 CIMD、而且接受不带密钥的客户端（`none`）时用 CIMD；否则动态注册；都不行就告诉用户要去对方后台建应用，把编号填进“高级”。
6. Himawari 的 CIMD 文档放在 `<服务器公开地址>/api/connections/v1/client.json`，内容由公开地址和回调地址现算，不写死；`client_id` 就是这个网址。
7. 取到的身份（编号，动态注册给的密钥）加密存在表 `app_connection_clients`，记着是哪个登录服务器给的，下次连接直接用，不重复注册。
8. 上线配置里的应用，客户端编号改成可以不填，不填就照第 5 条自动取。

<a id="ask"></a>

### 什么时候先问

9. 不改 ADR 0311 第 6、7 条：只有上线配置里标了信任的官方服务器上自称只读的工具直接用；用户自己加的应用，所有工具先问。

<a id="differences"></a>

## 和大厂不同的地方

- 只读工具：ChatGPT 认 `readOnlyHint`，用户加的应用也认；Himawari 照 Andy 在 ADR 0311 定的，用户加的应用一律先问。理由是 MCP 规范说工具标注除非来自可信服务器都不可信（ADR 0311 前提 2）。这比大厂严，不是新的取舍。
- 每个工具“总是允许”的开关（Claude 有）这次不做；需要时另开。

<a id="consequences"></a>

## 后果

- 好处：接一个新应用不用改代码、不用上线；支持 CIMD 或动态注册的服务，填网址登录就能用。
- 代价：多两张表、一个公开的 CIMD 网址，Cloudflare 门禁要放行它；不支持 CIMD 和动态注册的服务（例如 GitHub）仍要用户自己去建应用拿编号。
- 要跟进：做完、上线后去掉 `implementation: in_progress`。
