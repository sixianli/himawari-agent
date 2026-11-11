# PR 389 第 1 轮逐条判断

- **ds-1**（deepseek-v4.1-flash）「限流在昂贵的 JWT 校验之后执行，未认证请求可以先消耗校验/JWKS 拉取资源」：成立，中高。identity-gateway.ts 遇到 JWKSNoMatchingKey 时无条件强制下载公钥集，伪造 kid 每次都能触发。已修：CloudflareAccessJwtVerifier 加 30 秒下载冷却和同时只发一次下载（同 jose createRemoteJWKSet 的 cooldownDuration 默认值）。新用例：50 个并发的未知 kid 请求，30 秒内只下载一次；去掉冷却后用例失败（已实际运行）。校验仍在限流之前，因为要先知道算有效还是无效；RS256 验签本身开销很小。
- **ds-2**（deepseek-v4.1-flash）「启动组装没有端到端自动检查」：成立，中高（I-73 那类缺测试）。已在 production-http-composition-process.test.ts 加 [P5-3] 用例：真实安装的服务进程，网页登录 audience 的凭证回 401，MCP audience 的凭证能调工具。把 service-main 改成用 mcpIdentity.audience 后用例失败（expected 200 to be 401，已实际运行）。
- **ds-3**（deepseek-v4.1-flash）「ADR 0227 对测试覆盖的描述比实际测试更强」：成立，低。已补：三种带凭证的 401 各自断言没有 WWW-Authenticate；startup 测试加完全没有身份配置的用例；旧用例名 [P5-1] … bearer token 改名；ADR 测试一节改准。
- **ds-4**（deepseek-v4.1-flash）「所有校验失败都被静默吞掉，JWKS 网络故障和恶意凭证在日志上不可区分」：成立，低。已改：带了凭证但校验失败、且没被限流挡下的，调 onFailure（服务日志 mcp-read.failed，只有错误码）；被限流的不记，每分钟最多 60 行。区分错误种类要改校验器的错误码，没有做：公钥地址不可达已由网页登录的就绪检查报出。
- **ds-5**（deepseek-v4.1-flash）「若未来 verifier 返回空字符串会被放行」：不成立。唯一实现 CloudflareAccessJwtVerifier 返回 `sha256:` 加 64 位十六进制（identity-gateway.ts 的 sha256 函数），且 sub 为空时先抛错；没有可达输入返回空串。模型自己也写了「不是当前可利用问题」。
- **ds-6**（deepseek-v4.1-flash）「无效请求桶是全局共享的」：不成立。有效凭证计入另一份额度，不受无效请求影响；新用例 answers 429 after 60 rejected assertions … 在无效额度打满后，用有效凭证连接照常能列出工具（已实际运行）。没有凭证时的 401 由 Cloudflare 边缘发出，不经源站。
- **gl-1**（glm-5.3-flash）「校验发生在限流计数之前，无凭证请求的代价不再被限流封顶」：同 ds-1，已修。
- **gl-2**（glm-5.3-flash）「MCP 的 verifier 没有启动就绪检查，验签失败被静默吞掉」：部分成立，低。就绪检查部分不成立：配了 mcpRead 就必须是 Cloudflare 身份配置，网页登录的校验器用同一个 jwksUrl 在 production-http-composition.ts:835 做 assertReady。日志部分同 ds-4，已改。模型给「低-中」，判低的理由：触发后只是少日志，不给出错误结果。
- **gl-3**（glm-5.3-flash）「限流语义变了，作者「限流数值不变」只对了一半」：成立，低（文档与事实不符）。ADR 0227 决定 4 已写明全入口共用一份 30 次，包括确认来回。
- **gl-4**（glm-5.3-flash）「没有约束 `runPolicy.mcpRead.audience` 不得等于 `configuration.identity.audience`」：成立，低。已在 strict-configuration.ts 加相异检查（must differ from configuration.identity.audience），startup 测试加用例；ADR 决定 2 已写明。
- **gl-5**（glm-5.3-flash）「MCP 路由的 429 分支和多值请求头分支无测试」：可以更好。多值请求头按 typeof 判断，非字符串一律当没有凭证回 401，行为安全。429 用例本轮因 ds-4 的日志改动另外补上（要证明 429 不记日志），已提交。
