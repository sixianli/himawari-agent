## 侧重检查

我优先检查了错误路径、不可信输入、资源耗尽、不可撤销操作，以及规则/文档与代码的一致性：

- **无凭证 / 空值 / 重复请求头**：`production-mcp-read.ts:708-709` 只取 `request.headers["cf-access-jwt-assertion"]`，不是 `string` 就按无凭证处理；空字符串在 `admit` 的 `if (assertion)` 处直接跳过。重复头若变成数组也会被当作无凭证，失败方向是拒绝，不是放行。
- **旧 `Authorization: Bearer`**：路由已不再读取该头；`test/integration/mcp-read.test.ts:528-537` 有负向用例。
- **校验抛错分支**：`production-mcp-read.ts:271-275` 全部 `catch` 成 `subject = undefined`，最终 401，不会放行；但也不会留下可诊断的错误记录。
- **限流与异步校验**：限流在 `await verify(...)` 之后才执行，见下文高风险项。
- **不可逆操作**：本次改动没有动 `propose_memory` 的 elicitation/确认流程；写工具仍受 `proposals`、modern era、`himawari:write` 三个条件约束。
- **配置与文档一致性**：旧 `secretRef` / `writeSecretRef` 已被拒绝，`proposals` 只接受 `true`，built-in 身份会拒绝；ADR 0227 与代码大体一致，但测试覆盖有两处说过头。
- **未核实**：`@modelcontextprotocol/server` 内部如何把 `authInfo` 传进 `requestState` 的 `bind` 上下文；Cloudflare 边缘是否会剥离伪造的 `Cf-Access-Jwt-Assertion`。这两点没有源码可读，标记为未核实。

---

## 发现的问题（按严重度）

### 高 — 限流在昂贵的 JWT 校验之后执行，未认证请求可以先消耗校验/JWKS 拉取资源

**文件:行**：`apps/agent-service/src/production-mcp-read.ts:268-282`、`packages/platform-node/src/identity-gateway.ts:174-183`、`packages/platform-node/src/identity-gateway.ts:219-225`

**问题**：`admit` 先 `await verify(assertion)`，之后才调用 `AdmissionWindows.admit`。因此“无效请求 60/分”的限流只限制返回结果，不限制验签、解析和 JWKS 网络请求。攻击者可以持续发送结构合法但 `kid` 不存在的 JWT，触发 `JWKSNoMatchingKey` 后的强制刷新；每次刷新都绕过缓存并发出一次网络请求。

**证据**：

```ts
// production-mcp-read.ts:270-277
if (assertion) {
  try {
    subject = (await this.#options.access.verify(assertion)).externalSubjectRef;
  } catch {
    subject = undefined;
  }
}
const status = this.#windows.admit(subject !== undefined);
```

```ts
// identity-gateway.ts:174-183
} catch (error) {
  if (!(error instanceof errors.JWKSNoMatchingKey)) {
    throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.ASSERTION_INVALID);
  }
  try {
    return await this.verifyWithCurrentKeys(token, observedAt, true);
```

```ts
// identity-gateway.ts:219-225
private async getJwks(observedAt: Date, forceRefresh: boolean): Promise<JSONWebKeySet> {
  if (!forceRefresh && this.cached && this.cached.expiresAt > observedAt.valueOf()) {
    return this.cached.jwks;
  }
  const fetched = validateJwks(
    await this.options.jwksFetcher.fetch(new URL(this.options.jwksUrl)),
  );
```

**建议**：把“尝试次数”限流放到验签之前（例如先占一个 pre-auth 槽位，成功后再转入有效桶并回退无效计数），或对验签失败前的请求单独限流；同时给 JWKS 刷新加单飞/最小刷新间隔，避免未知 `kid` 每个请求都强制拉取。还应补一条自动用例：并发大量伪造 `kid` 的请求时，JWKS fetcher 调用次数不得随请求数线性增长。

---

### 中 — 启动组装没有端到端自动检查，I-73 那类“配置值能通过解析，但组装用错字段”不会被发现

**文件:行**：`apps/agent-service/src/service-main.ts:1789-1802`、`apps/agent-service/test/production-http-composition.unit.test.ts:875-903`

**问题**：新增的 HTTP 组合测试是手工 `new ProductionMcpRead({ access: access.verifier, ... })`，没有走 `runAgentService` 的配置解析与组装。也就是说，如果 `service-main` 误把 `configuration.identity.audience` 当作 MCP audience，或把 `mcpRead.audience` 用到别处，现有测试仍会通过。这正是 I-73 说的“只测了清单解析，没有把清单里的 id 交给后端的校验”。

**证据**：

```ts
// production-http-composition.unit.test.ts:875-878
const mcpRead = new ProductionMcpRead({
  scope,
  clock: { now: () => NOW.toISOString() },
  access: access.verifier,
```

```ts
// service-main.ts:1789-1792
access: new CloudflareAccessJwtVerifier({
  issuer: mcpIdentity.issuer,
  audience: mcpReadConfiguration.audience,
  jwksUrl: mcpIdentity.jwksUrl,
```

**建议**：加一条真正从配置到启动的用例：`configuration.identity.audience` 与 `runPolicy.mcpRead.audience` 设成不同值，通过 `httpOptions.jwksFetcher` 提供测试 JWKS，然后用 `audience = mcpRead.audience` 的 JWT 调用 `/api/mcp/v1` 应为 200，用 `audience = identity.audience` 的 JWT 应为 401。这样两端值不一致时测试真的会失败。

---

### 低 — ADR 0227 对测试覆盖的描述比实际测试更强；启动配置测试只覆盖 built-in，未覆盖“完全缺少 identity”

**文件:行**：`docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:115-116`、`test/integration/mcp-read.test.ts:526-545`、`packages/platform-node/test/startup-configuration.unit.test.ts:1533-1548`

**问题**：ADR 写“拒绝用例覆盖……同时检查 401 不带 `WWW-Authenticate` 头”，但实际只有“完全不带凭证”的用例检查了 `www-authenticate` 为 `null`；别的密钥、错误 audience、过期这三类只检查连接失败，没有检查响应头。ADR 还写“没有 Cloudflare Access 身份配置时启动拒绝”，测试实际只覆盖了 `identity.kind === "built-in"`，没有覆盖 `identity` 缺失。

**证据**：

```ts
// mcp-read.test.ts:526-527
expect(bare.status).toBe(401);
expect(bare.headers.get("www-authenticate")).toBeNull();
```

```ts
// startup-configuration.unit.test.ts:1533-1540
raw["runPolicy"] = { ...policy, mcpRead: { audience: "mcp-access-audience" } };
raw["identity"] = {
  kind: "built-in",
  sessionIdleMilliseconds: 86_400_000,
  ...
```

**建议**：要么把 ADR 的措辞改准确，要么补上这些断言；尤其是“缺少 identity”这一条，建议单独加一个测试，因为它是代码里真实存在的分支（`strict-configuration.ts:1460` 的 `!identity`）。

另外，`apps/agent-service/test/production-http-composition.unit.test.ts:860` 的用例名仍写着 “with only its bearer token”，固定令牌已经删除，建议改名，避免后续阅读者误解。

---

### 低 — 所有校验失败都被静默吞掉，JWKS 网络故障和恶意凭证在日志上不可区分

**文件:行**：`apps/agent-service/src/production-mcp-read.ts:271-275`

**问题**：`catch { subject = undefined; }` 把“JWT 签名错误、audience 错误、JWKS 拉取失败、时钟解析异常”等全部折叠成同一个 401，没有任何诊断日志，也没有调用已有的 `onFailure`。这不会造成认证绕过，但会让 JWKS 故障或配置错误看起来像普通未授权。

**证据**：

```ts
try {
  subject = (await this.#options.access.verify(assertion)).externalSubjectRef;
} catch {
  subject = undefined;
}
```

**建议**：至少记录一个不包含凭证内容的诊断事件，区分 `assertion_invalid` 与 `jwks_unavailable` 一类原因；返回给客户端的响应仍然保持 401 不变。

---

## 读代码证实的事实

- 路由只从 `cf-access-jwt-assertion` 取凭证，完全不再读取 `authorization`，见 `production-mcp-read.ts:708-709`。
- 401 响应不再带 `www-authenticate`，见 `production-mcp-read.ts:714-717`。
- 校验异常一律转 401，不会进入有效分支，见 `production-mcp-read.ts:271-279`。
- 限流计数在验签之后才发生，见 `production-mcp-read.ts:277`。
- `externalSubjectRef` 是确定性的 `sha256(issuer + "\0" + sub)`，不含时间，见 `identity-gateway.ts:210` 和 `:100-102`。
- `requestState` 的 HMAC key 仍是构造时 `randomBytes(32)`，见 `production-mcp-read.ts:258-262`；绑定值由原来的 `clientId`（令牌种类）变成现在的凭证主体，仍走 `authInfo.clientId`。
- 配置解析只接受 `audience` 和 `proposals: true`，旧 `secretRef` / `writeSecretRef` 被拒绝，见 `strict-configuration.ts:1121-1130` 与测试 `startup-configuration.unit.test.ts:1522-1532`。
- `mcpRead` 与 built-in identity 组合会在配置解析阶段被拒，见 `strict-configuration.ts:1460-1464`；服务启动时使用 `mcpReadConfiguration.audience` 和 `mcpIdentity.issuer/jwksUrl`，见 `service-main.ts:1789-1802`。
- `MCP_READ_SECRET_PURPOSE` / `MCP_WRITE_SECRET_PURPOSE` 在源码中已无引用；仓库内搜索未发现遗留的生产消费者。
- 新增拒绝用例确实覆盖：无凭证、旧 Bearer、别的密钥签名、错误 audience、过期；把验签削弱成“有凭证就放行”或去掉 audience/expiry 校验时，这些负向用例会失败。见 `test/integration/mcp-read.test.ts:516-545`。

## 推测 / 未核实

- 未知 `kid` 会触发 `JWKSNoMatchingKey` 并强制刷新 JWKS，这是基于 `jose` 的常规行为；我没有读到 `jose` 源码，因此“攻击者每个请求都能稳定触发一次网络拉取”属于高度可能但未在依赖源码中核实。无论触发条件细节如何，“验签在限流之前”这一点是代码证实的。
- 无效请求桶是全局共享的：如果攻击者灌满 60 次/分的无效桶，合法客户端首次 OAuth 发现请求可能拿到 429 而不是 401，从而无法开始登录。这取决于 Cloudflare 是否在边缘拦截未认证请求，未核实。
- `@modelcontextprotocol/server` 是否确实把路由传入的 `authInfo` 填到 `context.http.authInfo`，供 `requestState.bind` 使用；仓库里没有 SDK 源码，未核实。
- Cloudflare 边缘是否会剥离客户端伪造的 `Cf-Access-Jwt-Assertion`；这属于生产环境行为，未核实。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（基于本次改动的范围）。** 改动集中在外部 MCP 入口的认证、配置解析、启动组装和测试，没有触碰内部模型请求的系统提示、历史消息、资料块、遮盖或压缩逻辑。MCP 暴露给外部客户端的工具定义不是 Himawari 发送给自身模型的工具定义。写工具是否出现由部署配置 `proposals` 决定，不是每轮变化；内部模型请求仍然只在末尾追加，每轮变化的值仍应由最后一条消息承载。依据 `.claude/rules/prompt-prefix.md:27-28,35`。若要看的是外部客户端自己的模型缓存，那么配置切换导致工具列表变化会改变它们的请求开头，但这是部署期一次性变化，不是逐请求变化。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**本次改动没有引入新的逐请求字节差异。** 新增的 `externalSubjectRef` 是 `sha256(issuer + sub)` 的确定性值，不含时间；限流窗口、计数器都不会进入模型内容；配置值是启动时固定的。`ProposalState` 里的 `proposalId` 仍是每次新建时随机，但这是既有行为，且只出现在 MCP 的 `requestState`/工具流程里，不进入内部模型请求。没有发现新的“依赖前后文的遮盖”“带时间字段”“无序集合”进入模型内容。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有，且主要负向用例有效，但有明显缺口。**

- `test/integration/mcp-read.test.ts:516-545`：无凭证、旧 Bearer、别的密钥、错误 audience、过期都覆盖；把验签削弱为“有凭证就放行”或去掉 audience/过期校验，这些用例会失败。这一点成立。
- `packages/platform-node/test/startup-configuration.unit.test.ts:1468-1548`：新配置的接受/拒绝覆盖较完整，旧 `secretRef`、`writeSecretRef`、`proposals: false`、非法 audience 都会被拒；如果把这些校验去掉，相应用例会失败。
- **缺口一**：`WWW-Authenticate` 缺失只在“无凭证”用例检查，别的 401 路径没有检查。
- **缺口二**：没有覆盖“`identity` 完全缺失”的启动拒绝，只覆盖了 built-in。
- **缺口三**：没有任何限流/429 的自动用例，`AdmissionWindows` 是这次新抽出来的类，异步 `admit` 的顺序变化没有测试保护。
- **缺口四**：没有从真实配置经 `runAgentService` 组装 verifier 的端到端测试，因此配置值组装错位不会被发现。

### 4. 改动产生或修改的每个值，两端是否都能接受？

逐项核对结果：

| 值 | 产生处 | 使用处 | 结果 |
|---|---|---|---|
| `runPolicy.mcpRead.audience` | `parseMcpRead`，`safeReference` 校验 | `service-main` 传给 `CloudflareAccessJwtVerifier` 的 `audience` | 一致，均为非空字符串；建议补端到端测试证明组装用的就是这个字段 |
| `runPolicy.mcpRead.proposals` | `parseMcpRead` 只接受 `true` | `service-main:1804` 用真值判断是否创建 writer | 一致 |
| `configuration.identity`（Cloudflare） | `parseIdentityConfiguration`，`kind` 可省略 | `service-main` 用 `kind !== "built-in"` 选出 Cloudflare 配置 | 一致 |
| 被删除的 `mcp-read` / `mcp-write` 密钥用途 | 已从常量与配置类型删除 | 源码中无剩余引用 | 一致，无遗留消费者 |
| `externalSubjectRef` | `CloudflareAccessJwtVerifier` 生成 `sha256:...` | `authInfo.clientId`，再进入 `requestState.bind` | 真实 verifier 始终非空；但 `admit` 用 `subject !== undefined` 判断，若未来 verifier 返回空字符串会被放行。属于防御性缺口，不是当前可利用问题 |
| `MCP_ACCESS_ASSERTION_HEADER` | 常量 `cf-access-jwt-assertion` | 路由以小写键读取 Fastify 请求头 | 一致 |
| `AdmissionWindows` | 新抽出的共享限流类 | `BearerGate`、`ProductionMcpRead` | 对 `BearerGate` 行为不变；`ProductionMcpRead` 的调用顺序带来上面的资源耗尽问题 |

总体上没有发现 I-73 式的“清单值过不了后端校验”的硬错配；最需要补的是组装层的端到端验证，以及验签与限流的先后顺序。
