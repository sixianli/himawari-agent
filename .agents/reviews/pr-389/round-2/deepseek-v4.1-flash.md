## 读代码证实的发现

### 1. 中：MCP 入口只校验“凭证有效”，没有把 `sub` 绑定到 Himawari 的 owner

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:268-283`；`apps/agent-service/src/service-main.ts:1789-1803`
- 问题：只要 JWT 能通过 `CloudflareAccessJwtVerifier`（签名、issuer、audience、过期时间），入口就把 `externalSubjectRef` 直接当成 `clientId`，并赋予 `himawari:read`；配置了 `proposals` 时还赋予 `himawari:write`。代码没有拿这个摘要去和已绑定的 owner 身份比对。也就是说，安全性完全依赖 Cloudflare Access 应用策略“只有 Andy 能登录”。
- 证据：
  ```ts
  273: subject = (await this.#options.access.verify(assertion)).externalSubjectRef;
  ...
  282: const scopes = this.#options.write ? [READ_ACCESS, WRITE_ACCESS] : [READ_ACCESS];
  283: return { status, authInfo: { token: "", clientId: subject, scopes } };
  ```
  `service-main` 只构造 verifier，没有任何 owner 绑定比较：
  ```ts
  1789: access: new CloudflareAccessJwtVerifier({
  1790:   issuer: mcpIdentity.issuer,
  1791:   audience: mcpReadConfiguration.audience,
  1792:   jwksUrl: mcpIdentity.jwksUrl,
  ```
- 建议：在 `admit` 成功后增加 `externalSubjectRef` 与 owner 绑定记录的比对（例如 `OwnerIdentityStatePort.readBySubject`），不一致返回 401；或者至少在代码/配置里明确这是“完全信任 Access 应用策略”的单点假设，并在 Access 应用策略变更时把它当成安全边界处理。

### 2. 中：限流在昂贵的 JWT 校验之后才计数，挡不住未认证校验洪泛

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:268-279`；`apps/agent-service/src/bearer-admission.ts:19-27`
- 问题：每个请求先 `await access.verify(assertion)`，再调用 `#windows.admit(...)`。无效请求的 60/分限制只决定“回 401 还是 429”，不会限制签名校验、JWT 解析、未知 `kid` 回退路径的 CPU 消耗；攻击者仍可用大量无效请求驱动远高于 60/分的校验工作。
- 证据：
  ```ts
  273: subject = (await this.#options.access.verify(assertion)).externalSubjectRef;
  ...
  278: const status = this.#windows.admit(subject !== undefined);
  ```
  ```
  19: admit(matches: boolean): BearerAdmission {
  20:   const now = Date.parse(this.clock.now());
  ...
  23:   if (window.length >= (matches ? AUTHORIZED_PER_MINUTE : UNAUTHORIZED_PER_MINUTE))
  24:     return "rate_limited";
  25:   window.push(now);
  ```
- 建议：增加一个在验签之前的粗粒度限流/并发上限（例如按连接来源或全局并发信号量），或对同一来源的校验请求做短窗口预限流；至少要在 ADR 里写清“60/分不保护验签 CPU”。

### 3. 低：JWKS 冷却在“没有有效缓存”或“缓存过期且下载失败”时不生效

- 文件:行：`packages/platform-node/src/identity-gateway.ts:221-234`
- 问题：`withinRefreshCooldown` 只在 `this.cached && expiresAt > now` 成立时才被检查。缓存不存在、缓存已过期，或下载失败导致没有有效缓存时，每个顺序请求都会重新发起一次 `fetchJwks`，`pendingFetch` 只合并同时进行的请求。因此 ADR 所说“距上次下载不到 30 秒就不再下载”在这种状态下不成立；如果 JWKS 端点变慢或失败，无效凭证可以放大出站请求。
- 证据：
  ```ts
  224: if (
  225:   this.cached &&
  226:   this.cached.expiresAt > now &&
  227:   (!forceRefresh || this.withinRefreshCooldown(now))
  228: ) {
  229:   return this.cached.jwks;
  230: }
  231: this.pendingFetch ??= this.fetchJwks(now).finally(() => {
  ```
- 建议：把“最近一次下载尝试”的冷却放到是否命中缓存之前，至少在没有有效缓存时也限制发起频率；冷却期内直接返回可重试的失败，而不是再次下载。

### 4. 低：`proposals` 从配置到写工具出现的端到端路径没有自动检查

- 文件:行：`test/integration/mcp-write.test.ts:225-229`、`320-337`；`test/integration/production-http-composition-process.test.ts:2086`
- 问题：`mcp-write.test.ts` 是直接给 `ProductionMcpRead` 传 `write: { proposals: writer }`，没有经过 `runPolicy.mcpRead.proposals` 的配置解析和 `service-main` 组装；真实进程用例只配置了 `mcpRead.audience`，没有 `proposals: true`。如果 `service-main` 把 `proposals` 接反或漏接，现有测试不会失败。
- 证据：
  ```ts
  227: const mcp = new ProductionMcpRead({
  228:   scope,
  229:   clock,
  230:   access: access.verifier,
  ...
  229: ...(options.readOnly ? {} : { write: { proposals: writer } }),
  ```
  真实进程用例：
  ```ts
  2086: const service = await openInstalledMain({ runPolicy: { mcpRead: { audience: mcpAudience } } });
  ```
- 建议：加一条真实组装/进程测试，分别用 `mcpRead.proposals: true` 和省略 `proposals`，检查 `tools/list` 是否出现 `propose_memory`。

### 5. 低：旧 `secretRef` 的拒绝用例不能单独证明旧键被拒

- 文件:行：`packages/platform-node/test/startup-configuration.unit.test.ts:1522-1531`
- 问题：`{ secretRef: "mcp-read-secret" }` 同时缺少 `audience`，所以即使 `secretRef` 被允许、只是 `audience` 必填，这个用例仍会抛错，测试通过。它没有验证“带 `audience` 的同时带旧 `secretRef` 必须被拒”。
- 证据：
  ```ts
  1522: for (const invalid of [
  1523:   {},
  1524:   { secretRef: "mcp-read-secret" },
  1525:   { audience: "mcp-access-audience", writeSecretRef: "mcp-write-secret" },
  1526:   { audience: "mcp-access-audience", proposals: false },
  ```
- 建议：增加 `{ audience: "...", secretRef: "..." }`，并断言错误字段是 `configuration.runPolicy.mcpRead.secretRef`。

### 6. 低：ADR 说“每分钟最多 60 行”容易与同一个事件的其它来源混淆

- 文件:行：`docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:58`；`apps/agent-service/src/production-mcp-read.ts:263-265`；`apps/agent-service/src/service-main.ts:1855-1860`
- 问题：`mcp-read.failed` 不只由“带了凭证但校验失败”产生，SDK 的 `onerror`、读工具失败、提议失败也都调用同一个 `onFailure`，最终都写 `mcp-read.failed`。所以“每分钟最多 60 行”只对“校验失败的日志”成立，不能理解为整个事件名每分钟最多 60 行。
- 证据：
  ```ts
  263: this.handler = createMcpHandler((context) => this.#server(context), {
  264:   onerror: options.onFailure,
  265: });
  ```
  ```ts
  1858: event: "mcp-read.failed",
  1859: code: stableErrorCode(error),
  ```
- 建议：ADR 改成“由校验失败产生的 `mcp-read.failed` 每分钟最多 60 行”，或把认证失败日志改成独立事件名。

---

## 推测与未核实

- “Cloudflare Access 策略只允许 Andy”——这是仓库外的运营配置，代码里没有体现，未核实。上文第 1 条的风险是否真实取决于这一条。
- Cloudflare、Muse、Claude 连接器的外部行为（Managed OAuth、DCR、`resource` 参数、回调地址等）来自作者引用的外部文档和聊天记录，我无法上网核实。
- ADR 引用的 `node_modules/jose/dist/types/jwks/remote.d.ts` 和 `cooldownDuration` 默认值：当前 sparse checkout 没有 `node_modules`，未核实。
- 作者说“把校验换成有凭证就放行，拒绝用例会失败”“去掉冷却用例会失败”等是手动验证；我没有运行测试，只能从测试逻辑判断它们是合理的。
- `docs/adr/0227-...md` 多处引用 ADR 0228，但仓库里没有 `0228-*` 文件；可能是尚未落地的后续 ADR，属于文档一致性小问题。
- `safeReference` 对 audience 的字符限制是 `^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$`。Cloudflare Access 的 AUD 通常是十六进制，应该能通过；如果生产 AUD 超出这个字符集，会在启动时被拒。仓库里没有真实 AUD 样例，未核实。

---

## 侧重检查

- **绕过路径**：路由只读取 `request.headers["cf-access-jwt-assertion"]`，不再看 `Authorization`。Fastify/Node 会把头名转小写；非字符串值（重复头可能变成数组或合并字符串）被当成没有凭证；空字符串是 falsy，也当成没有凭证；`verify` 抛错被 `catch` 后按无效处理。结论：未发现通过其他请求头、大小写或空值绕过认证的路径。证据 `production-mcp-read.ts:268-283`、`709-719`。
- **校验抛错分支**：`catch` 只把 `rejection` 留给日志，不会把请求放行；状态仍是 `unauthorized`。结论：失败关闭。证据同上。
- **限流**：计数本身正确，有效/无效分窗口；但验签在计数之前，见第 2 条。429 用例确实检查了第 61 次无效请求和“429 不记日志”。证据 `mcp-read.test.ts:570-588`。
- **资源耗尽**：JWKS 有并发合并和 30 秒冷却，能挡住并发未知 `kid` 洪泛；但没有有效缓存/下载失败时冷却不生效，见第 3 条。`BoundedJwksFetcher` 有超时和响应体上限（配置里 `jwksTimeoutMilliseconds`、`jwksMaximumBodyBytes`），这层没有被本次改动削弱。
- **不可撤销操作/写路径**：写工具仍由 `options.write` 存在、modern 连接、`himawari:write` scope 三个条件同时控制；真正写入仍需 elicitation 确认。本次没有新增绕过确认的写路径。证据 `production-mcp-read.ts:346-379`、`383-443`。
- **规则/说明与代码**：`prompt-prefix.md` 要求的模型请求开头没有被这个 PR 改动；ADR 0227 的决定 1、2、4、5、6 与代码基本一致；第 6 条日志描述见第 6 条。ADR 0228 缺失是文档层面的未完成引用。
- **配置解析/启动组装**：`audience` 必填且只能由 `safeReference` 解析；`proposals` 只接受 `true`；没有身份或身份是 `built-in` 时拒绝；`audience` 和 `identity.audience` 相同拒绝；`service-main` 使用同一 `audience` 构造 verifier。三处数值和类型一致。证据 `strict-configuration.ts:1121-1131`、`1460-1472`，`service-main.ts:1779-1803`。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。这个 PR 只改了 MCP 入口的认证、MCP 配置解析、启动组装、MCP 工具上下文和 ADR；没有修改 Himawari 发给模型的系统提示、模型工具定义、历史消息或遮盖逻辑。MCP 的工具清单是发给外部 MCP 客户端的，不是 Himawari 模型的请求头。

发给模型的内容仍由既有逻辑只在末尾追加；每轮变化的值（时间、本轮记忆等）仍走既有的“最后一条消息”路径，本次没有改动该路径。对既有 prompt 组装实现本身我没有逐行重新复核，标注为“本 PR 未触及，未发现回归”。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

没有发现新增的这种来源。

- `externalSubjectRef` 是 `sha256(issuer + "\0" + sub)`，同一主体每次相同。
- `mcpRead.audience` 是配置里的静态字符串。
- `requestState` 的绑定从“令牌种类”改成主体摘要，仍然是确定值。
- `maskForExternalRead` 和出口遮盖没有改动。
- JWKS 的下载时间、冷却时间没有进入任何返回给模型或客户端正文的序列化。
- `today_context` 里本来就有 `now` 字段，这是改动前就存在的每轮变化值，不是本 PR 引入的。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有自动检查，主要覆盖如下：

- `test/integration/mcp-read.test.ts:516-568`：无凭证、旧 `Bearer`、别的密钥签的、audience 不对、过期，全部期望 401 且没有 `WWW-Authenticate`，并检查无效请求记失败、决策台账为空。若把校验改成“有凭证就放行”，这些期望都会失败。
- `test/integration/mcp-read.test.ts:570-588`：60 次无效后 429，429 不记日志，随后有效登录仍可用。若去掉无效限流或把 429 也记日志，这条会失败。
- `packages/platform-node/test/identity-gateway.unit.test.ts:233-270`：并发未知 `kid` 的 JWKS 冷却。若去掉冷却或去掉并发合并，`fetches` 的期望会失败。
- `packages/platform-node/test/startup-configuration.unit.test.ts:1509-1569`：新配置、旧键、`proposals`、身份缺失/内置、audience 相同拒绝。
- `test/integration/production-http-composition-process.test.ts:2084-2113`：真实进程里网页 audience 回 401，MCP audience 能调工具。若启动组装误用网页 audience，会失败。

需要注意的缺口：`proposals` 从配置到写工具没有端到端用例（第 4 条）；旧 `secretRef` 的拒绝用例不够有针对性（第 5 条）；没有测试 30 次/分的有效请求上限；没有测试 JWKS 下载失败时的冷却行为。作者所说的“已手动验证”我没有运行测试，未独立核实。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对如下：

- `runPolicy.mcpRead.audience`：产生于 `parseMcpRead` 的 `safeReference`；使用于 `service-main` 构造 `CloudflareAccessJwtVerifier`，最终传给 jose 的 `audience`；另外与 `configuration.identity.audience` 比较。两端都按非空字符串处理，未发现类型或格式不匹配。唯一的限制是 `safeReference` 的字符集，见上文“未核实”。
- `runPolicy.mcpRead.proposals`：解析层只接受 `true`；使用层 `service-main` 用 truthy 判断构造 `write`；`ProductionMcpRead` 用 `options.write` 决定 scope 和工具注册。值本身能被两端接受；但端到端测试缺口见第 4 条。
- `MCP_ACCESS_ASSERTION_HEADER`：常量是 `cf-access-jwt-assertion`，生产和使用都在 `production-mcp-read.ts`，Fastify 头名大小写不敏感，接受。
- `externalSubjectRef`：产生于 `CloudflareAccessJwtVerifier`，使用于 `AuthInfo.clientId` 和 `requestState` 绑定。类型上是字符串，`requestState` 的拼接不会拒绝它；但它没有和 owner 身份绑定，见第 1 条。
- `AdmissionWindows`：`BearerGate` 和 MCP 入口共用，双方都传 boolean 并接受 `ok/unauthorized/rate_limited`，语义一致。
- 删除的 `mcp-read`、`mcp-write` 密钥用途和 `secretRef`/`writeSecretRef`：仓库内已无代码引用，只在 ADR 0219/0225 的历史正文里保留，和历史说明一致。
- `JWKS_REFRESH_COOLDOWN_MILLISECONDS`：只在验证器内部使用，没有外部序列化或校验。

结论：没有发现“产生端能产生、使用端会拒绝”的字段不一致；主要问题不是类型不匹配，而是 `externalSubjectRef` 在下游缺少 owner 绑定校验（第 1 条）。
