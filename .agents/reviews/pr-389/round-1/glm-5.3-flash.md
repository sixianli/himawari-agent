# 复核结论（PR 389：MCP 入口改 Cloudflare Access 凭证）

## 按严重度排列的问题

**1.（中）apps/agent-service/src/production-mcp-read.ts:268-277 — 校验发生在限流计数之前，无凭证请求的代价不再被限流封顶**
证据（读代码证实）：
```ts
async admit(assertion: string | undefined): Promise<McpAdmission> {
  let subject: string | undefined;
  if (assertion) {
    try {
      subject = (await this.#options.access.verify(assertion)).externalSubjectRef;
    } catch { subject = undefined; }
  }
  const status = this.#windows.admit(subject !== undefined);
```
`verify` 先跑、`windows.admit` 后跑。旧实现里 `matches` 只是一次 SHA-256 摘要比对（bearer-admission.ts:40-46），无效请求被封顶在 60/分；现在每个请求（包括注定 429 的）都要做完整 JWT 解析 + RSA 验签，而且 identity-gateway.ts:174-183 在 `JWKSNoMatchingKey` 时会强制刷新 JWKS（:219-229 真正发起 fetch）——攻击者伪造随机 `kid` 的 JWT，可以每请求都触发一次源站到 Cloudflare 的 JWKS 网络请求，次数不受 60/分限制（BoundedJwksFetcher 只限制单次超时和体积）。绕过路径本身没有（验签失败都落 401），但拒绝服务的成本模型变了。建议：先做不限流的廉价预判（比如校验前先查 unauthorized 窗口是否已满），或对验签失败结果做短时负缓存。

**2.（低-中）apps/agent-service/src/service-main.ts:1789-1803 — MCP 的 verifier 没有启动就绪检查，验签失败被静默吞掉**
证据（读代码证实）：网页入口的 verifier 在组装时经 `assertIdentityReady = () => verifier.assertReady()`（production-http-composition.ts:835）在启动时拉 JWKS；MCP 的 `new CloudflareAccessJwtVerifier({...})`（service-main.ts:1789）从不调用 `assertReady`，而 `admit` 里 `catch { subject = undefined; }`（production-mcp-read.ts:273-275）把所有验签错误（包括 JWKS 拉取失败、网络错误）吞掉，不写任何诊断日志（`onFailure` 只在工具执行路径用）。结果：JWKS 配错或不可达时，入口注册成功但所有请求 401，没有任何服务端线索。建议：启动时对 MCP verifier 调 `assertReady`，验签异常至少记一条诊断事件。

**3.（低）限流语义变了，作者「限流数值不变」只对了一半**
证据（读代码证实）：常量未变（bearer-admission.ts:4-5，30/60）；但旧实现读、写令牌各有独立的 30/分窗口（旧 `#gate`/`#writeGate`，见 diff 删除段），现在三个客户端共用同一个 `AdmissionWindows` 实例（production-mcp-read.ts:249、257），有效预算 30/分是全体共享的，`propose_memory` 的确认往返（每次 POST 各计一次）也计入同一窗口。数值不变，单位从「每客户端」变成「每实例」。建议：ADR 0227 决定 4 里写明这是共享池。

**4.（低）没有约束 `runPolicy.mcpRead.audience` 不得等于 `configuration.identity.audience`**
证据（读代码证实）：parseMcpRead（strict-configuration.ts:1121-1131）只校验格式，没有相异检查；verifier 的 audience 来自 mcpRead（service-main.ts:1791）。若两者配成一样，MCP 入口会接受为网页 Access 应用签发的凭证。旧代码有对应的纪律（`MCP_WRITE_SECRET_REUSED`，diff 删除段）。两个应用都是 Andy 本人，不算越权，但丢了旧的防呆。建议：解析时加相异检查，或在 ADR 写明为什么不需要。

**5.（低，测试缺口）MCP 路由的 429 分支和多值请求头分支无测试**
证据（读代码证实）：全仓库 `rate_limited|429` 的测试只命中 muse-intake-http.test.ts:353-359（经 BearerGate 间接覆盖了 AdmissionWindows）和 web-push，`test/integration/mcp-read.test.ts`、`mcp-write.test.ts`、composition 单测都没有 429 用例。另外 registerMcpReadRoute:708-709 的 `typeof header === "string"` 分支：同名请求头出现两次时 Fastify 给数组、被当成无凭证 401——行为安全但无测试。这属于沿袭旧缺口（diff 里没有删掉旧限流测试），不是本次引入。

## ADR/文档与代码一致性（读代码证实）

ADR 0227 的决定 1–6 与代码逐条相符：只认 Access 凭证且四种失败都 401（production-mcp-read.ts:268-279、:714-717）；`audience`/`proposals` 配置与启动拒绝（strict-configuration.ts:1457-1464，错误串逐字一致）；scopes 按配置给（production-mcp-read.ts:280）；限流常量与 AdmissionWindows 抽取（bearer-admission.ts，逻辑与旧 BearerGate 逐行等价，BearerGate 仍被 muse-intake 使用，行为保持）；401 无 `WWW-Authenticate`（已删，测试断言 null，mcp-read.test.ts:527）；requestState 密钥仍是进程内 `randomBytes(32)`（:258-260），bind 由「令牌种类」改为 `externalSubjectRef` 摘要（:261）。ADR 里的测试覆盖描述与实际测试一一对应（mcp-read.test.ts:513-540 的裸请求/Bearer 头/外来密钥/错误 audience/过期五个拒绝用例、startup-configuration 的新旧键用例、composition 的 401→200 流程）。ADR 0219/0225 的补充说明与代码一致。

## 侧重检查：一条普通使用流程的覆盖情况

流程：Claude 应用带 `Cf-Access-Jwt-Assertion` POST `/api/mcp/v1` → Cloudflare 边缘（生产改动，不在本仓库）→ Fastify `onRequest`（production-mcp-read.ts:707-718）→ `admit`（验签 + 限流）→ `createMcpHandler` → `#server` 按 scopes 注册工具 → `tools/list` / 工具调用 `#call` → recall/summaries → 决策台账 `#record`。
- 已覆盖（读测试证实）：401 各失败形态、401 无 WWW-Authenticate、外来密钥/错误 audience/过期、读写工具可见性（含 legacy 时代，mcp-write.test.ts:334-339）、真实组装下的 401→200、配置解析与启动拒绝。
- 未覆盖：429 分支、JWKS 拉取失败 → 401 的分支（:270-275 的 catch）、启动就绪检查（根本不存在，见问题 2）、多值请求头分支。

## 必答问题

1. **不会改变模型已见过的请求开头。**（读代码证实）diff 只动了 HTTP 鉴权（bearer-admission、production-mcp-read 的 admit/路由头、service-main 组装、配置解析），没有触碰任何发给模型的内容组装（系统提示、工具定义、历史、遮盖都在别的模块，未改）。MCP 工具清单是发给 MCP 客户端的，不是模型请求的一部分；proposals 开关只改变 MCP 客户端看到的工具。所以「只追加」「每轮变化值在最后一条消息」的约束未被触碰；`npm run check:prompt-prefix` 门槛继续覆盖原路径。
2. **不会产生跨请求字节漂移。**（读代码证实）新增的绑定值 `externalSubjectRef` 是 `sha256(issuer\0sub)`（identity-gateway.ts:210），确定性、与请求上下文无关；verifier 返回的 `authenticatedAt`/`expiresAt` 每次不同，但 `admit` 只取 `externalSubjectRef`（production-mcp-read.ts:272），不外泄到任何再序列化的地方。
3. **有对应自动检查，反向用例会失败。**（代码证实；作者说的「已手动验证」属其声明，我未运行）若校验削弱为「有凭证就放行」，mcp-read.test.ts 的外来密钥（:538）、错误 audience（:540-542）、过期（:543-545）用例会连接成功使 `rejects.toThrow` 失败；完全放行则裸请求 401 用例（:526）失败。缺口是 429 分支与验签抛错分支无反向用例（见问题 1、2、5）。
4. **逐值两端核对通过，一处纪律缺失。**（读代码证实）`audience`：safeReference（strict-configuration.ts:95-101，字符集 `[A-Za-z0-9._/:@-]`，Cloudflare AUD 十六进制标签可通过）→ verifier → jose audience 校验，兼容；`proposals`：只产出 `true` → service-main:1804 布尔门 → scopes/工具注册，一致；`externalSubjectRef`：`sha256:<64hex>` → 仅作 requestState bind 字符串，无需再校验；`cf-access-jwt-assertion` 小写常量与 Fastify 归一化后的请求头键一致，多值头安全回 401；删除的 `MCP_READ/WRITE_SECRET_PURPOSE`、`MCP_READ_SECRET_MINIMUM_LENGTH`、`secretRef`/`writeSecretRef` 全仓库无残留引用；`AdmissionWindows` 抽取被 muse-intake 的 BearerGate 继续消费且行为逐行等价。缺失的是问题 4 所述「两个 audience 不得相同」的旧纪律，建议补上。
