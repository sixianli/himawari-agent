# PR 389 第 4 轮逐条判断

- **ds-1**（deepseek-v4.1-flash）「限流在异步 JWT 校验和主人绑定查询之后，无法限制校验工作本身」：不成立，第 1–3 轮已判过，没有新证据。新提到的数据库查询只在签名有效时发生，签名有效的凭证只能由 Cloudflare Access 签发；生产走 Cloudflare Tunnel、不开对外端口（docs/adr/0082-mobile-pwa-push-before-native-app.md 第 52 行），没登录 Access 的人送不进凭证。
- **ds-2**（deepseek-v4.1-flash）「主人绑定存储异常被当成“认证失败”返回 401」：成立，低（触发后是拒绝，不放行）。已改：读绑定出错时回 503，记 onFailure，不计入无效窗口。新用例 answers 503, not 401, when the owner binding cannot be read…（连发 61 次都是 503，没有变成 429）；换回上一版 production-mcp-read.ts 后失败（expected 401 to be 503，已实际运行）。
- **ds-3**（deepseek-v4.1-flash）「ADR 对 JWKS 冷却的描述，在“缓存 TTL 小于 30 秒”时与代码不一致」：成立，低（文字不准）。ADR 0227 决定 4 已写明冷却只在缓存未过期时生效，短缓存照常重新下载，生产默认 300 秒。
