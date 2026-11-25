---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amended_by: "docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md"
date: "2026-11-11"
covers: "apps/agent-service/src/production-mcp-read.ts, apps/agent-service/test/production-http-composition.unit.test.ts, packages/platform-node/src/identity-gateway.ts, packages/platform-node/src/strict-configuration.ts, packages/platform-node/test/identity-gateway.unit.test.ts, packages/platform-node/test/startup-configuration.unit.test.ts, test/integration/mcp-read.test.ts, test/integration/mcp-write.test.ts, test/integration/production-http-composition-process.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0227：对外 MCP 入口改为校验 Cloudflare Access 登录凭证，去掉固定令牌（部分取代 ADR 0219 决定 1、ADR 0225 决定 1）

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0219](0219-read-only-mcp-entry-with-static-token.md) 给外部 agent 开了对外的 MCP 入口 `/api/mcp/v1`。MCP（Model Context Protocol）是让 AI 客户端调用外部工具的开放协议。这个入口用一把固定令牌认证：客户端在 `Authorization: Bearer` 请求头里带上它。[ADR 0225](0225-external-agents-propose-memory-with-in-client-confirmation.md) 又加了第二把写令牌。

任务 P5-3 要让 Andy 平时用的三个客户端都能连上这个入口：Muse、Claude Code、Claude 应用（claude.ai 网页、桌面、手机）。固定令牌连不上其中两个：

- Claude 应用的自定义连接器只认 OAuth 登录或不认证。OAuth 是一种标准的授权协议：客户端打开浏览器让人登录一次，之后自己拿令牌、自己续期。
- Muse 一个连接只能放一个凭据。按 ADR 0219，上线时还要在 Cloudflare 上加一层服务令牌，那需要两个请求头，Muse 带不了。

Andy 2026-11-11 在任务 P5-3 的线程里同意的做法是：三个客户端都用 Cloudflare 的 OAuth 登录连进来，Claude Code 也一样，去掉 P5-1 的固定令牌。方案原文在 `/mnt/project-files/p5-3-pending-writes/integrated-plan.md` 第三节第 7 小节和第五节第 1 项。

本 ADR 只管认证。「不能弹确认框的客户端写进来的记忆先存成待确认」由 ADR 0228 另行决定，那一部分要改表。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. Cloudflare Access 的 Managed OAuth 能让 Access 充当一个标准的 OAuth 2.0 授权服务器，支持动态客户端登记（DCR，客户端第一次连接时自己向服务器登记，人不用手工填客户端编号）。源站收到的是 Access 签名的凭证，必须自己校验。来源 <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/>：要求 “An OAuth client that supports RFC 8707”；对 MCP 服务器要求 “validate the Access JWT sent in the `Cf-Access-Jwt-Assertion` header”。
2. Claude 应用的自定义连接器只支持 OAuth 或无认证，固定令牌请求头还在内测。来源 <https://claude.com/docs/connectors/building/authentication.md>：static_headers 一行写着 “Beta, for a limited set of organizations”。
3. Muse 的连接支持 OAuth，在授权、换令牌、刷新三步都带 RFC 8707 的 `resource` 参数，首选动态登记，定时任务里令牌过期会自己续期；一个连接只能放一个凭据。来源是 Andy 2026-11-11 在 P5-3 线程转来的 Muse 原话：“resource 参数：带，而且三处都带”“DCR：支持，而且明确是首选路径”“access token 过期时自己刷新”“一个连接只存一个凭据”。
4. Himawari 已经有一个 Cloudflare Access 凭证校验器，网页登录在用。它校验签名（RS256）、issuer、audience、`sub` 和过期时间，不校验邮箱。来源 `packages/platform-node/src/identity-gateway.ts` 的 `CloudflareAccessJwtVerifier`，`jwtVerify(token, createLocalJWKSet(jwks), { algorithms: ["RS256"], issuer: this.options.issuer, audience: this.options.audience, … })`。
5. 生产入口已经只有一道 Cloudflare Access 门（2026-10-26 Andy 定），网页登录用 `configuration.identity` 里的 Cloudflare Access 配置。来源 `packages/platform-node/src/strict-configuration.ts` 的 `parseIdentityConfiguration`：issuer、audience、jwksUrl 都在 `configuration.identity` 里。
6. 原来 401 响应会带 `www-authenticate: Bearer realm="himawari"`。来源 `apps/agent-service/src/production-mcp-read.ts` 的 `registerMcpReadRoute`（本 ADR 之前的版本）。Claude 的连接器靠 401 和 `WWW-Authenticate` 头发现授权服务器，来源 <https://claude.com/docs/connectors/building/authentication.md>：“A `401` is required to start sign-in”。源站自带的挑战头会盖掉 Cloudflare 给的发现信息。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **`/api/mcp/v1` 只认 Cloudflare Access 凭证。** 请求头 `Cf-Access-Jwt-Assertion` 里的凭证用现成的 `CloudflareAccessJwtVerifier` 校验：issuer 和公钥地址沿用 `configuration.identity`，audience 用这个入口自己那个 Access 应用的值。凭证通过校验后，还要核对凭证主体就是 Himawari 已绑定的主人：用凭证主体的摘要（`externalSubjectRef`）查网页登录时绑定的主人记录，记录属于本实例的主人且状态是 active 才放行。没有凭证、签名不对、audience 不对、过期、不是绑定的主人，都回 401，不写决策台账。读主人绑定记录时数据库出错，回 503，记 `mcp-read.failed`，不算一次无效登录，计入有效请求的 30 次额度（超过就回 429，日志也就停了）。带了凭证却没通过的，服务日志记一行 `mcp-read.failed`（只有错误码，不含凭证内容；不是主人时错误码是 `MCP_ACCESS_OWNER_NOT_BOUND`）；被限流挡下的不记，所以由校验失败产生的这类日志每分钟最多 60 行（工具出错等别的原因也写同名日志，不在这 60 行里）。固定令牌（`Authorization: Bearer`）不再被接受。
   - 取代 ADR 0219 决定 1 里「固定令牌认证」的部分，以及 ADR 0225 决定 1「写操作用单独的令牌」、ADR 0226 决定 1 里「只给写令牌」的部分。
   - 理由：三个客户端里有两个连不上固定令牌（前提 2、3）。一个入口只保留一套认证，也和「生产入口只一道 Cloudflare 门」一致（前提 5）。
2. **配置改成 `runPolicy.mcpRead: { audience, proposals? }`。**
   - `audience` 是这个入口的 Access 应用的 audience 值，必填。
   - `proposals: true` 打开写工具 `propose_memory` 和 `propose_rule`（ADR 0226），不写就只有只读工具。
   - 去掉 `secretRef`、`writeSecretRef` 和密钥用途 `mcp-read`、`mcp-write`。
   - 配了 `mcpRead`，但 `configuration.identity` 不是 Cloudflare Access 的，启动时拒绝（`requires configuration.identity to use Cloudflare Access`）。
   - `audience` 和网页登录的 `configuration.identity.audience` 相同时，启动拒绝（`must differ from configuration.identity.audience`）。两个入口各用一个 Access 应用，网页登录的凭证不能拿来调 MCP。
3. **读写权限按配置给，不再按令牌分。** 凭证有效就给 `himawari:read`；配置打开了 `proposals` 时再给 `himawari:write`。
   - 能登录这个 Access 应用的只有 Andy 本人，由 Access 策略保证；源站另外核对凭证主体是绑定的主人（决定 1），所以 Access 策略哪天配宽了，别人登录进来也读不到记忆。Cloudflare 的凭证说明写 `sub` 是 “The ID of the user. This value is unique to an email address per account.”（<https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/>），即同一账号里按邮箱定，不按应用定，所以网页登录绑定的主体和 MCP 凭证的主体应是同一个摘要。这一点页面没有明说「跨应用相同」，要在 Hermes 上实测确认（列在后果一节）。
   - 每次写入仍要 Andy 确认：在客户端里弹框确认（ADR 0225），或者到 Himawari 里确认（ADR 0228）。所以不用再给每个客户端发一把单独的写令牌。
   - 2026-11-12 起：[ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 决定 1 在本条之上加了一层：`proposals` 这个全局开关仍然决定写工具出不出现；每个接入另有自己的设置（能不能推、推来的要不要先问、能读到哪一级），只能在全局开关之内再收窄。接入密钥是身份和统计用的，不是旧的写令牌。对应的编码任务合并之前，代码仍按本条。本条原文保留不改。
4. **限流数值不变，但改成全入口共用一份。** 有效请求每分钟 30 次，无效请求每分钟 60 次，计数逻辑抽成 `AdmissionWindows`，和 `BearerGate` 共用。原来读、写两把令牌各有一份 30 次的额度；现在所有客户端共用同一份 30 次，`propose_memory` 确认来回的每次请求也算在里面。
   - 凭证校验在限流计数之前做（要先知道算有效还是无效）。为了不让伪造的凭证借此反复触发公钥下载，`CloudflareAccessJwtVerifier` 遇到不认识的公钥编号（`kid`）时，只要缓存还没过期，距上次尝试下载公钥集不到 30 秒就不再下载，继续用缓存（缓存有效期配得比 30 秒短、缓存已过期时，照常重新下载；生产用默认的 300 秒）；上次下载失败、手里又没有未过期的缓存时，30 秒内直接按校验失败处理，不再下载；同一时刻只发一次下载，下载进行中，缓存里认识的公钥照常校验，不用等它。过期的缓存一律不用。这和 jose 库（本项目校验 JWT 用的开源库）自带的远程公钥集的做法一样（`cooldownDuration` 默认 30000 毫秒，见 `node_modules/jose/dist/types/jwks/remote.d.ts`）。网页登录用的是同一个类，一起受益；代价是 Cloudflare 换公钥后，最多晚 30 秒认新公钥。
5. **401 不再带自定义 `WWW-Authenticate` 头。** 授权服务器的发现交给 Cloudflare（前提 6）。
6. **`requestState` 的签名密钥不变。** 它本来就是进程启动时随机生成的，不从令牌派生（ADR 0225 决定 2）。原来绑定的「令牌种类」改为凭证主体的摘要（`externalSubjectRef`）。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- MCP 规范给远程服务器定的认证方式就是 OAuth，服务器充当资源服务器，校验授权服务器发的令牌。来源 <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>。
- Claude 的连接器文档要求远程 MCP 服务器用 OAuth（DCR 或 CIMD），固定令牌只是内测（前提 2）。
- Cloudflare 自己给 MCP 服务器的推荐，就是 Access 当授权服务器，源站校验 `Cf-Access-Jwt-Assertion`（前提 1）。

我们的做法和这三家一致，没有自己实现 OAuth 服务器。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **保留固定令牌，同时也接受 Access 凭证。** 两套认证并存，令牌泄露时的影响面不变，而且 401 的挑战头没法同时满足两边。Andy 2026-11-11 选了只留一套。
- **Muse 用 Cloudflare 单请求头服务令牌（read_service_tokens_from_header）。** 这个头的值要同时放客户端编号和密钥，Muse 会把它当成两个密钥拒绝（前提 3）。
- **这条路径不经过 Cloudflare 认证，只靠 Himawari 自己的令牌。** 少了一层门，而且仍然接不上 Claude 应用。
- **Himawari 自己实现 OAuth 授权服务器。** 工作量大，安全面也大；Cloudflare 已经能做。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- **上线时 Andy 要在 Cloudflare 里做的事**（生产改动，要他同意）：
  - 给 `/api/mcp/v1` 建一个 Access 应用，类型选 MCP server，打开 Managed OAuth。
  - 策略只放 Andy 本人。
  - 允许的回调地址加上：`https://claude.ai/api/mcp/auth_callback`（Claude 应用）、`http://localhost`（Claude Code，端口不固定）、Muse 登记时实际给出的地址（实测时取得）。
  - 把这个应用的 audience 值写进生产配置的 `runPolicy.mcpRead.audience`。
- **还没实测的四件事**，等 Hermes（测试机）上搭好后在真客户端里验证：
  - Muse 动态登记时给的回调地址，Cloudflare 能不能放行。
  - Claude 应用登录时带不带 `resource` 参数。
  - Claude Code 能不能连上 Cloudflare Managed OAuth。
  - MCP 那个 Access 应用发的凭证里的 `sub`，和网页登录那个应用的是否相同（决定 3）。不同的话，主人核对会把 Andy 也挡在外面，回 401。
- **客户端第一次连接要在浏览器里登录一次。** 之后客户端自己续期。Andy 撤销授权后，客户端要重新登录。
- **来源只能靠客户端自称。** 所有客户端都以 Andy 本人登录，凭证主体相同，所以「这条提议来自哪个客户端」仍然只能靠客户端自报的名字。ADR 0228 在界面上把它标成「自称」。
  - 2026-11-12 起：这一条由 [ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 决定 1 改掉：每个接入由 Andy 在网页上建，带密钥的专属网址定身份，自报的名字只当附注。对应的编码任务合并之前，代码仍按本条。本条原文保留不改。
- **P5-1 的固定令牌没有上线过**，所以不用迁移生产配置或撤销旧令牌。
- **测试：**
  - `test/integration/mcp-read.test.ts`、`test/integration/mcp-write.test.ts` 用真实的 `CloudflareAccessJwtVerifier`，用测试密钥签发的凭证连接。拒绝用例覆盖：没有凭证、只带旧的 Bearer 令牌、别的密钥签的、audience 不对、过期、不是绑定的主人（另有两条：绑定已停用、绑定属于别的主人，只检查连接被拒并记 `MCP_ACCESS_OWNER_NOT_BOUND`）；直接发请求的那几种检查 401 不带 `WWW-Authenticate` 头，带了凭证的那几种各记一次失败。把校验换成「有凭证就放行」，或者去掉主人核对，拒绝用例会失败（已手动验证）。另有限流用例：60 次无效凭证之后回 429，429 不记日志，有效登录照常可用；30 次有效请求之后回 429，此时无效凭证仍回 401。
  - `packages/platform-node/test/identity-gateway.unit.test.ts` 检查公钥下载冷却：50 个并发请求带不认识的 `kid`，30 秒内只下载一次，满 30 秒后再下载一次；下载失败后 30 秒内的 20 次校验不再下载，满 30 秒后再试并成功；缓存过期又下载失败时不用过期缓存；强制下载进行中，认识的公钥照常校验。换回改动前的写法，这几条用例会失败（已手动验证）。
  - `packages/platform-node/test/startup-configuration.unit.test.ts` 检查新配置：只接受 `audience` 和 `proposals: true`；旧的 `secretRef`、`writeSecretRef` 被拒；完全没有身份配置、或身份配置是内置登录时启动拒绝；`audience` 和网页登录的相同时启动拒绝。
  - `apps/agent-service/test/production-http-composition.unit.test.ts` 在真实组装里走一遍：不带凭证回 401，带凭证能调工具。
  - `test/integration/production-http-composition-process.test.ts` 用安装好的真实服务进程，从配置文件一路走到 `/api/mcp/v1`：网页登录 audience 的凭证回 401，不是绑定主人的凭证回 401，MCP 自己 audience 的主人凭证能调工具；配置不写 `proposals` 时工具列表里没有 `propose_memory`，写 `proposals: true` 时有，`propose_rule` 也一样。把启动组装改成用网页登录的 audience，或者不论配置都打开写工具，对应用例会失败（已手动验证）。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0219：对外只读 MCP 入口，静态令牌鉴权](0219-read-only-mcp-entry-with-static-token.md)
- [ADR 0225：外部 agent 提议新记忆，主人在客户端确认后才保存](0225-external-agents-propose-memory-with-in-client-confirmation.md)
- [ADR 0226：外部 agent 提议新规则，主人在客户端确认后按规则提议流程生效](0226-external-agents-propose-rules-through-the-rule-proposal-flow.md)
- [ADR 0162：用服务令牌和应用密钥接收 Muse 数据](0162-receive-muse-data-through-a-service-token-and-an-app-secret.md)

[返回阅读导航](#contents)
