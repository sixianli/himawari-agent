# PR 389 第 3 轮逐条判断

- **ds-1**（deepseek-v4.1-flash）「限流在 JWT 校验和主人查询之后才执行，挡不住未认证请求造成的资源消耗」：不成立，第 1 轮 ds-1/gl-1、第 2 轮 ds-2 已判过。新提到的「主人查询」只在验签通过后才发生，伪造凭证过不了验签，碰不到数据库（production-mcp-read.ts admit：readBySubject 在 verify 之后）。生产走 Cloudflare Tunnel、不开对外端口（docs/adr/0082-mobile-pwa-push-before-native-app.md 第 52 行），没登录 Access 的人送不进凭证。
- **ds-2**（deepseek-v4.1-flash）「JWKS 冷却期内会返回已经过期的缓存」：成立，按中高处理。模型给低，判高的理由：触发后是放行而不是报错拒绝，不符合低档定义，且涉及安全。已改：过期缓存一律不用；只有上次下载失败且没有未过期缓存时，30 秒内直接失败。新用例 never verifies with an expired JWKS cache after a failed refresh；换回上一版写法失败（已实际运行）。
- **ds-3**（deepseek-v4.1-flash）「`pendingFetch` 会让本可用缓存的合法请求等待一次可能失败的刷新」：成立，低（触发后是拒绝；要先过 Cloudflare Access）。已改：先看未过期缓存，再看进行中的下载。新用例 keeps verifying known keys from a fresh cache while a forced refresh is still downloading；换回上一版写法失败（超时，已实际运行）。
- **ds-4**（deepseek-v4.1-flash）「主人绑定的 `status` / `ownerId` 分支没有对应的反向测试」：成立，低。已补两条：绑定停用、绑定属于别的主人，都回 401 并记 MCP_ACCESS_OWNER_NOT_BOUND；把核对改成只要有记录就放行后两条都失败（已实际运行）。

第 3 轮仍有一条中高（ds-2），按复核规则连续三轮没过：已改，未复核，停下报告 Andy。
