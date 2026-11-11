## 结论摘要

没有发现“无凭证也能进”的认证绕过；固定 Bearer 令牌、错误签名/audience/过期、非绑定主人、停用绑定都被拒绝。主要问题集中在：限流发生在异步校验和数据库查询之后，不能限制这两步的工作量；异常路径的语义；以及 ADR 对 JWKS 冷却的描述与短缓存配置下的代码不完全一致。

---

## 问题（按严重度从高到低）

### 1. 中｜限流在异步 JWT 校验和主人绑定查询之后，无法限制校验工作本身

**文件:行**：`apps/agent-service/src/production-mcp-read.ts:320-340`、`apps/agent-service/src/bearer-admission.ts:19-27`

**问题**：`admit` 先 `await access.verify(...)`，再 `await owners.readBySubject(...)`，最后才 `this.#windows.admit(...)`。因此：

- 60/分钟只限制“返回 401 的响应”，不限制已经执行的签名校验；
- 一个“签名有效但不是绑定主人”的凭证，每次请求都会先做一次数据库查询，即使无效窗口已经满了也仍会继续查；
- 并发请求可以在窗口填满前全部进入校验，限流值本身不改，但对校验工作的约束失效。

**证据（读代码证实）**：

```ts
// production-mcp-read.ts:325-334
const verified = await this.#options.access.verify(assertion);
const binding = await this.#options.owners.readBySubject(verified.externalSubjectRef);
...
const status = this.#windows.admit(subject !== undefined);
```

```ts
// bearer-admission.ts:19-26
admit(matches: boolean): BearerAdmission {
  const now = Date.parse(this.clock.now());
  const window = matches ? this.authorized : this.unauthorized;
  ...
  if (window.length >= (matches ? AUTHORIZED_PER_MINUTE : UNAUTHORIZED_PER_MINUTE))
    return "rate_limited";
```

**建议**：在校验前加一层便宜的预限流（按来源或断言哈希计数），或者至少把“已经验证通过但主人不匹配”的负向结果提前计入无效窗口；补一条并发反向用例，断言校验/查询次数也被限制，而不只是断言第 61 个响应是 429。

> 影响大小取决于源站是否只被 Cloudflare Access 保护（见“推测与未核实”）。

### 2. 低｜主人绑定存储异常被当成“认证失败”返回 401

**文件:行**：`apps/agent-service/src/production-mcp-read.ts:323-337`

**问题**：`try` 同时包住 JWT 校验和 `readBySubject`。数据库暂时不可用、磁盘错误等基础设施异常会被 `catch`，然后走 `windows.admit(false)`，最终返回 401 并记 `mcp-read.failed`。这会把“服务故障”伪装成“凭证无效”，可能让客户端触发重新登录，并占用无效请求的限流额度。

**证据（读代码证实）**：

```ts
try {
  const verified = await this.#options.access.verify(assertion);
  const binding = await this.#options.owners.readBySubject(verified.externalSubjectRef);
  if (binding?.ownerId === this.#options.scope.ownerId && binding.status === "active")
    subject = verified.externalSubjectRef;
  else rejection = MCP_ACCESS_OWNER_NOT_BOUND;
} catch (error) {
  rejection = error;
}
const status = this.#windows.admit(subject !== undefined);
```

**建议**：区分 `IdentityGatewayError`（凭证问题）和其他异常；后者返回 503/500，不计入凭证无效窗口，并用不同的日志码。至少把 `readBySubject` 的异常从认证失败中分离出来。

### 3. 低｜ADR 对 JWKS 冷却的描述，在“缓存 TTL 小于 30 秒”时与代码不一致

**文件:行**：`docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:71`、`packages/platform-node/src/identity-gateway.ts:140-151`、`packages/platform-node/src/identity-gateway.ts:222-232`

**问题**：ADR 写“遇到不认识的 `kid` 时，距上次尝试下载公钥集不到 30 秒就不再下载”。但代码只有在“缓存仍新鲜”或“上次下载失败且无新鲜缓存”时才应用冷却：

```ts
const fresh = this.cached && this.cached.expiresAt > now ? this.cached.jwks : undefined;
if (fresh && (!forceRefresh || this.withinRefreshCooldown(now))) return fresh;
if (this.pendingFetch) return this.pendingFetch;
if (!fresh && this.lastFetchFailed && this.withinRefreshCooldown(now))
  throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.JWKS_INVALID);
this.pendingFetch = this.fetchJwks(now)...
```

构造器允许 `cacheMilliseconds` 最小为 `1_000`，小于 30 秒冷却。若配置了短 TTL：上次下载成功、缓存已过期、又收到未知 `kid`，即使距上次下载不足 30 秒也会再次下载。默认生产 TTL 是 300 秒，所以默认配置下不会触发；但 ADR 的字面规则和短 TTL 配置不一致。

**证据（读代码证实）**：上述 `getJwks` 分支；构造器第 142-151 行只要求 `cacheMilliseconds >= 1_000`。

**建议**：要么强制 `cacheMilliseconds >= 30_000`，要么把 ADR 改成“冷却只在有未过期缓存或上次下载失败时生效”，并补一个 `cacheMilliseconds < 30_000` 的用例。

---

## 侧重检查

查过的路径和结论：

1. **认证绕过**
   - 缺失、空字符串、非字符串（数组/多值）请求头：`typeof header === "string"` 不成立即按无凭证处理，失败关闭（`production-mcp-read.ts:774-775`）。
   - 大写/小写请求头：常量是小写 `cf-access-jwt-assertion`，Fastify 会将头名规范为小写。
   - 只带旧 `Authorization: Bearer`：路由不再读取该头，测试覆盖为 401（`mcp-read.test.ts:621-631`）。
   - 别的密钥、错误 audience、过期、非绑定主人、停用绑定、绑定属于别的主人：代码与测试都覆盖。
   - 结论：未发现绕过路径。

2. **异步限流**
   - 计数本身是同步更新数组，不存在“异步丢计数”；常说“正确计数”成立。
   - 但计数发生在校验之后，不能限制校验/查询工作量；见问题 1。

3. **JWKS 下载与资源耗尽**
   - 单飞（`pendingFetch`）、冷却、过期缓存绝不使用、下载中已知公钥继续用新鲜缓存，逻辑与新增测试一致。
   - 发现短 TTL 时与 ADR 字面规则不一致；见问题 3。
   - JWT 长度上限 16,384 字符，JWKS 响应有 `maximumBodyBytes`/timeout，未见明显输入放大。

4. **配置与启动组装**
   - `parseMcpRead` 只接受 `audience`、`proposals: true`，拒绝旧 `secretRef`/`writeSecretRef`。
   - 非 Cloudflare 身份、缺少身份、audience 与网页登录相同都会启动失败。
   - `service-main` 使用 `configuration.identity` 的 issuer/jwksUrl 和 `runPolicy.mcpRead.audience`，与配置测试、过程测试一致。
   - 旧密钥用途常量在代码中已无残留引用。

5. **不可撤销操作与写入确认**
   - 未改变 `propose_memory` 的 elicitation 确认流程；写工具仍要求 modern 连接和写 scope。
   - 固定令牌从未上线，删除不涉及生产令牌撤销。

6. **文档一致性**
   - ADR 0227 与代码大部分一致；0219/0225 保留原文并加了被取代说明。
   - 唯一明显不一致是 JWKS 冷却那句，见问题 3。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（针对 Himawari 自己的模型请求）。**

- 本次改动只涉及 MCP 入口认证、配置解析、JWKS 校验和外部 MCP 工具可见性；没有改 `packages/prompt-catalog`、系统提示组装、历史消息、工具定义生成或遮盖逻辑。
- `today_context` 里的 `now` 仍是工具结果的一部分，位于本轮追加的工具结果中（`production-mcp-read.ts:682-700`），不是请求开头；这是改动前就有的行为。
- `requestState` 绑定主体摘要只影响内部状态令牌，不进入模型提示。

需要说明的边界：`proposals` 会改变外部 MCP 客户端从 `tools/list` 看到的工具集合，但这只发生在启动配置变化时，不是每轮变化；且改动前写工具也按令牌条件出现。对 Himawari 自身的模型请求，仍满足“只在末尾追加，会变的值在最后一条消息”。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会（本次改动没有引入这种变化）。**

- 未改遮盖逻辑，`maskForExternalRead` 仍是确定性的。
- 新增的 `audience`、`externalSubjectRef`、写 scope 不序列化进模型内容。
- `externalSubjectRef` 是 `sha256(issuer\0sub)` 的确定值（`identity-gateway.ts:213`），同一 issuer/sub 每次相同。
- 新增的数据库查询和配置读取不改变消息、规则、记忆的排序；未引入无序集合。

### 3. 有没有对应的自动检查？反向用例是否真的会失败？

**有检查；反向用例从代码路径看是有针对性的，但本轮没有运行测试，实际“跑起来会失败”未核实。**

新增/修改的检查包括：

- `test/integration/mcp-read.test.ts:609-694`：无凭证、旧 Bearer、错误签名、错误 audience、过期、非主人、停用绑定、别的主人、60 次后 429。
- `test/integration/mcp-write.test.ts:327-341`：`proposals` 关闭时看不到写工具。
- `packages/platform-node/test/startup-configuration.unit.test.ts:1468-1570`：配置键、`proposals: true`、身份类型、audience 必须不同。
- `packages/platform-node/test/identity-gateway.unit.test.ts:233-367`：JWKS 单飞、30 秒冷却、失败后不重试、过期缓存不使用、强制刷新期间已知公钥可用。
- `test/integration/production-http-composition-process.test.ts:2085-2168`：真实进程、不同 audience、非主人、`proposals` 开关。

反向用例的有效性判断（代码分析）：

- 若把“校验凭证”改成“有头就放行”，错误签名/错误 audience/过期用例会失败。
- 若去掉主人绑定或去掉 `status === "active"` 检查，非主人/停用绑定用例会失败。
- 若去掉 JWKS 冷却，并发未知 `kid` 用例的 `fetches` 断言会失败；若恢复“使用过期缓存”，过期缓存用例会失败。

**测试缺口**：

- 429 用例是顺序发 60 次（`mcp-read.test.ts:688-691`），不能覆盖并发下“校验在计数之前”的问题。
- 没有针对有效窗口 30/分钟在 MCP 入口上的新测试。
- 没有测试“绑定存储抛错时应返回 5xx 而不是 401”。
- 没有 `jwksCacheMilliseconds < 30_000` 的冷却用例。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐项核对结果：

| 值 | 产生处 | 使用处/校验 | 结论 |
|---|---|---|---|
| `runPolicy.mcpRead.audience` | `strict-configuration.ts:1121-1128`，`safeReference` | 类型 `McpReadConfiguration`；`service-main.ts:1791-1794` 传给 verifier；测试 | 两端接受；启动时还要求与 `identity.audience` 不同 |
| `runPolicy.mcpRead.proposals` | 解析器只允许字面量 `true` | `service-main.ts:1806` 决定是否构造写能力；`production-mcp-read.ts:402-407` 决定注册写工具 | 一致；不存在 `false` 的生产者 |
| `cf-access-jwt-assertion` | `MCP_ACCESS_ASSERTION_HEADER`（`production-mcp-read.ts:73`） | 路由 `production-mcp-read.ts:774`；测试用同名字面量 | 头名小写，Fastify 规范化后一致；数组/异常值失败关闭 |
| `externalSubjectRef` | `identity-gateway.ts:212-219`，`sha256(issuer\0sub)` | `production-mcp-read.ts:326` 查绑定；`sqlite-durable-operations.ts:4789-4800` 精确匹配；网页登录绑定同样来自该 verifier | 两端接受；绑定校验同时检查 ownerId 和 status |
| `requestState` 绑定值 | `production-mcp-read.ts:313`，`method + clientId` | `createRequestStateCodec` 内部校验 | 代码层面自洽；SDK 内部实现未读，标“未核实” |
| 删除的 `mcp-read`/`mcp-write` 密钥用途 | `strict-configuration.ts:998-1000` 已删除 | 全仓无代码引用；ADR 0219/0225 保留原文但已注明被 0227 取代 | 一致 |
| `McpWriteAccess.secret` | 删除 | 所有 `ProductionMcpRead` 构造点已更新（`service-main.ts:1787`、`mcp-read.test.ts:285`、`mcp-write.test.ts:231`、composition 单测） | 一致 |

---

## 推测与未核实

- **未运行测试**：本轮只能用只读工具和 git 命令，没有执行 `npm test`/vitest；“反向用例会失败”的判断来自代码路径分析。
- **未核实**：Cloudflare Managed OAuth 实际签发的 `sub` 是否与网页登录 Access 应用相同。ADR 0227 自己列为待 Hermes 实测；若不同，不是安全绕过，而是主人会被 401 挡在门外。
- **未核实**：Cloudflare 是否会在源站 401 上补上 OAuth 发现所需的 `WWW-Authenticate`。ADR 的前提是“交给 Cloudflare”，代码只负责去掉自定义头。
- **推测**：问题 1 的实际可利用性取决于源站是否只接受 Cloudflare Access 放行的流量。如果 Cloudflare 在到达源站前就挡住了未认证请求，影响会小很多；但源站自身的限流仍没有限制“计数前”的校验工作量。
- **未核实**：`@modelcontextprotocol/server` 的 `requestState` 内部实现（当前稀疏检出中没有 `node_modules`）；只能确认调用方把绑定值从令牌种类换成了主体摘要，密钥仍是 `randomBytes(32)`。
