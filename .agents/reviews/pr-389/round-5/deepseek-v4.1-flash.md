## 结论提要

没有发现明确的认证绕过或高危漏洞。改动主体（Cloudflare Access 校验、主人绑定、配置解析）与 ADR 0227 基本一致。主要问题集中在：限流放在昂贵校验之后（含 503 分支完全绕过计数），以及几处自动检查缺口和文档表述过强。

---

## 一、读代码证实的问题（按严重度）

### 1. 中：限流在 JWT 校验和主人绑定读取之后才计数，429 挡不住昂贵工作；503 分支完全不计数

文件：`apps/agent-service/src/production-mcp-read.ts:357-375`、`:364-369`、`apps/agent-service/src/bearer-admission.ts:4-5,19-27`

问题：
- `admit` 先做 JWT 校验（RS256 验签），再做主人绑定数据库查询，最后才调用 `AdmissionWindows.admit`。因此超过 60/分后返回 429 之前，每个请求仍已完成一次验签；伪造 JWT 可以持续消耗 CPU，限流并不能减少这部分工作。
- 更明显的资源问题是：如果 Access 策略配宽，一个“合法登录但不是主人”的用户每个请求都会执行一次 `readBySubject` 数据库读取，**即使第 61 次以后已经是 429，绑定读取仍然先发生**，所以 60/分限制不能限制 DB 读取次数。
- 绑定读取抛错时直接 `return { status: "unavailable" }`，在计数之前返回；数据库持续故障时 503 和 `mcp-read.failed` 日志都没有上限。

证据（亲自读到）：
```ts
// production-mcp-read.ts:357-375
try {
  verified = (await this.#options.access.verify(assertion)).externalSubjectRef;
} catch (error) {
  rejection = error;
}
if (verified !== undefined) {
  let binding: ...
  try {
    binding = await this.#options.owners.readBySubject(verified);
  } catch (error) {
    this.#options.onFailure(error);
    return { status: "unavailable" };   // 在 windows.admit 之前返回
  }
  ...
}
const status = this.#windows.admit(subject !== undefined);
```
```ts
// bearer-admission.ts:4-5
export const AUTHORIZED_PER_MINUTE = 30;
export const UNAUTHORIZED_PER_MINUTE = 60;
```

建议：
- 在验签之前先做一个粗粒度的总量窗口（按来源或全局），使 429 能真正限制验签次数。
- 把“读主人绑定”的错误路径也纳入独立的粗粒度计数，或对 503 日志做采样/限速。
- 如果确实要保持“先校验才知道有效/无效”，至少给验签和绑定读取加并发上限或总请求上限。

---

### 2. 低：JWKS 获取/校验失败被折叠成“凭证无效”，MCP 返回 401 而不是 503

文件：`packages/platform-node/src/identity-gateway.ts:175-186,222-233`、`apps/agent-service/src/production-mcp-read.ts:357-360`

问题：`getJwks` 在“缓存已过期且上次下载失败、仍在 30 秒冷却内”时抛 `JWKS_INVALID`，但 `verifyForIdentityLookup` 除了 `JWKSNoMatchingKey` 外一律转成 `ASSERTION_INVALID`。MCP 入口随后把它当作无效凭证，回 401 并计入无效窗口。Cloudflare 的 JWKS 临时不可用时，客户端会误以为需要重新登录，而不是看到服务暂时不可用。

证据：
```ts
// identity-gateway.ts:175-180
try {
  return await this.verifyWithCurrentKeys(token, observedAt, false);
} catch (error) {
  if (!(error instanceof errors.JWKSNoMatchingKey)) {
    throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.ASSERTION_INVALID);
  }
```
```ts
// identity-gateway.ts:227-228
if (!fresh && this.lastFetchFailed && this.withinRefreshCooldown(now))
  throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.JWKS_INVALID);
```

注：这是既有映射行为，不是本 PR 新引入；但第 4 轮已经专门为“绑定读取失败”区分了 503，这里仍不一致。

建议：给 JWKS 不可用定义独立错误码，MCP 入口映射为 503，且不计入无效登录窗口。

---

### 3. 低：`propose_rule` 的启动组装没有端到端自动检查

文件：`test/integration/production-http-composition-process.test.ts:2153-2170`、`test/integration/mcp-write.test.ts:298-303`、`docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:122`

问题：ADR 说 `propose_rule` 跟 `propose_memory` 同进同出，“由 mcp-write.test.ts 覆盖”。但 `mcp-write.test.ts` 是手工构造 `ProductionMcpRead`，直接传入：
```ts
...(options.readOnly ? {} : { write: { proposals: writer, rules: ruleProposals } }),
```
它不经过 `service-main` 的配置组装。真实进程测试只断言 `propose_memory`：
```ts
// production-http-composition-process.test.ts:2165
expect(names.includes("propose_memory")).toBe(proposals);
```
如果以后 `service-main` 在 `proposals: true` 时只创建了 `proposals`、漏掉 `rules`，现有测试不会失败。

建议：在真实进程测试中同时断言 `propose_rule`：`proposals` 关闭时不存在，开启时存在；或在同一断言里检查 `["propose_memory","propose_rule"]` 两个名字。

---

### 4. 低：有效请求的 30/分限流没有 MCP 层自动检查

文件：`test/integration/mcp-read.test.ts:693-712`、`apps/agent-service/src/bearer-admission.ts:4-5`

问题：现有 MCP 测试只验证“60 次无效凭证后 429”，没有验证“30 次有效请求后 429”。`AdmissionWindows` 的有效分支只通过 Muse 入口的 `BearerGate` 间接覆盖；如果 `ProductionMcpRead` 把有效/无效参数接错（例如永远传 `true` 或使用独立窗口），现有测试无法发现。

证据：
```ts
// mcp-read.test.ts:706-708
for (let attempt = 0; attempt < 60; attempt += 1) expect((await post()).status).toBe(401);
const limited = await post();
expect(limited.status).toBe(429);
```

建议：补一条 31 次有效请求的用例，并判断第 31 次为 429；再加一条反向用例，证明有效窗口与无效窗口互不占用。

---

### 5. 低/文档：ADR 0227 对拒绝用例覆盖的陈述过强

文件：`docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:118`、`test/integration/mcp-read.test.ts:667-675`

问题：ADR 写“每一种都检查 401 不带 `WWW-Authenticate` 头”。实际上“绑定已停用”“绑定属于别的主人”两条 `it.each` 只断言连接失败，没有检查 HTTP 状态或响应头：
```ts
it.each([
  ["a disabled binding", { status: "disabled" as const }],
  ["a binding for another owner", { ownerId: "owner-someone-else" }],
])("rejects the bound subject when it has %s", async (_label, binding) => {
  const f = await setup({ binding });
  await expect(f.connect("modern")).rejects.toThrow();
  expect(f.failures).toEqual([{ code: "MCP_ACCESS_OWNER_NOT_BOUND" }]);
  expect(await f.ledger()).toEqual([]);
});
```
代码本身确实不设置该头，所以行为是对的；问题只是文档对测试覆盖的描述不准确。

建议：在这两条用例里加原始 HTTP 请求断言（401 且 `www-authenticate` 为 null），或把 ADR 改成“raw fetch 的拒绝用例检查了响应头”。

---

### 6. 低/文档：ADR 0219 的后果与测试段仍描述已删除的固定令牌配置

文件：`docs/adr/0219-read-only-mcp-entry-with-static-token.md:127-129`，对照 `:60`

问题：第 60 行已加“由 ADR 0227 取代”的说明，但第 127、129 行仍写“只凭令牌就能调通”“`runPolicy.mcpRead` 只接受一把用途是 `mcp-read` 的密钥”。这符合仓库“原文保留不改”的写法，但对只读 ADR 后果段的读者可能造成误导（会以为旧配置仍然有效）。

建议：在这两条历史描述旁也加一行指向 ADR 0227 的说明，或明确标记“历史原文”。

---

## 二、推测 / 未核实

- **未核实**：Cloudflare 边缘是否会在源站 401 且没有自定义 `WWW-Authenticate` 时补上自己的发现头。代码只保证源站不添加该头；Edge 行为无法离线验证。
- **未核实**：Cloudflare Access 的 `sub` 是否真如 ADR 假设“同一账号按邮箱定、跨 Access 应用相同”。如果不同，`externalSubjectRef` 对不上，所有 MCP 请求都会 401（fail closed）。ADR 已把它列为 Hermes 实测项。
- **未核实**：作者/ADR 声称的反向验证“已手动运行”“换回旧代码用例会失败”。本环境不能运行测试，只读代码判断这些反向用例在逻辑上确实能抓住削弱校验的改动。
- **推测**：限流放在验签之后造成的 CPU 压力是否会被 Cloudflare 边缘速率限制缓解，取决于生产边缘配置；代码本身没有这一层保护。

---

## 三、侧重检查

**认证绕过路径**
- 只读取小写常量 `cf-access-jwt-assertion`；`request.headers` 的键在 Fastify/Node 下是小写，大小写不构成绕过。
- 空字符串、非字符串（如重复头部被解析成数组）都按“无凭证”处理，回 401，不会放行。
- `Authorization: Bearer` 不再被读取；测试覆盖旧 Bearer 被拒。
- 验签抛错、audience 不符、过期、签名不对都进入 `subject === undefined`，回 401。
- 只有“验签成功 + `readBySubject` 返回 active + ownerId 匹配本实例”才会设置 `subject`；没有跳过主人核对的路径。
- JWT 校验强制 RS256、issuer、audience、exp、非空 `sub`；JWKS 校验拒绝私钥字段、限制 key 数量。

**错误路径**
- 绑定读取失败：503，不写决策台账，但绕过限流计数（见问题 1）。
- JWKS 不可用：被折叠成 401（见问题 2）。
- 内部工具错误：仍写同名 `mcp-read.failed`，ADR 已说明不占 60/分额度。

**不合规范/不可信输入**
- 超长 token 在 verifier 内被 16,384 长度上限拒绝。
- 配置侧 `audience` 经 `safeReference` 校验；`proposals` 只接受 `true`；旧 `secretRef`/`writeSecretRef` 被拒绝。
- `mcpRead.audience` 与 `identity.audience` 相同会被启动拒绝，避免网页登录凭证调 MCP。

**资源耗尽**
- JWKS 下载有 30 秒冷却、并发合并、失败冷却；已读代码确认逻辑成立。
- 新增问题：验签/绑定读取发生在限流之前，429 不能减少昂贵工作；503 分支完全不计数。
- `AdmissionWindows` 数组按 30/60 上限增长，不会无限累积。

**不可撤销操作**
- 本次认证失败路径不写决策台账、不写记忆、不写规则。
- 删除固定令牌属于配置迁移；ADR 说明 P5-1 固定令牌未上线，不需要撤销旧令牌。本次改动本身没有新增不可撤销写入。

**规则/文档与代码一致性**
- ADR 0227 的决定 1、2、3、4、5、6 与代码基本一致。
- 不一致之处：ADR 0227 对测试覆盖的描述过强（问题 5）；ADR 0219 历史段仍描述旧配置（问题 6）。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。PR 389 改动的是对外 MCP 入口的认证、配置、启动组装和测试，没有修改提示词组装、`packages/prompt-catalog` 的文字、历史存储、遮盖逻辑或 Himawari 自己模型的工具定义。因此发给 Himawari 模型的内容仍然只在末尾追加；每轮会变的 `today_context.now` 本来就在工具结果里，不在请求开头。

需要注意的边界：对外部客户端（Claude/Muse）来说，打开 `runPolicy.mcpRead.proposals` 会让它们看到 `propose_memory`/`propose_rule`，这是工具集合的一次性变化，不是每轮变化；它也不属于 Himawari 自己模型的请求前缀。现有 `[PR-B]` 的 append-only 用例仍在 `production-http-composition-process.test.ts:2172-2179`，本次没有改动它。

### 2. 同一段文字会不会在不同请求里变成不同字节？

不会由本次改动引入。新增的 `externalSubjectRef` 是 `sha256(issuer + "\0" + sub)`，对固定 issuer/sub 是确定值；`AdmissionWindows` 只影响是否放行，不进入提示词；`requestState` 的随机密钥和 proposalId 不进入模型请求前缀；本次没有新增时间字段、无序集合或依赖前后文的遮盖。`rule_book` 的排序逻辑未被本 PR 修改。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

核心认证有自动检查：
- `mcp-read.test.ts:611-712`：无凭证、旧 Bearer、外键签名、错误 audience、过期、非主人、停用绑定、别的 owner、503、60 次无效后 429。
- `identity-gateway.unit.test.ts`：JWKS 冷却、下载失败冷却、过期缓存不用、下载中已知 key 照常校验。
- `startup-configuration.unit.test.ts:1468-1570`：新配置、旧 `secretRef`/`writeSecretRef` 被拒、缺少身份/内置身份被拒、audience 相同被拒。
- 真实进程测试：网页 audience 被拒、非主人被拒、MCP audience 主人通过、`proposals` 控制写工具。

反向用例逻辑上确实能失败：如果去掉 owner 核对，“停用绑定/别的 owner”会失败；如果忽略 audience，“错误 audience”会失败；如果忽略过期，“过期”会失败；如果签名校验被削弱为“有凭证就放行”，外键签名但 subject 正确的 token 会因绑定匹配而放行，对应用例会失败；如果把绑定错误改回 401，新增 503 用例会失败。

缺口：
- 没有测试 `propose_rule` 经过真实 `service-main` 配置组装后的出现/消失（问题 3）。
- 没有测试 MCP 有效请求 30/分上限（问题 4）。
- “停用绑定/别的 owner”两条没有断言 401 和没有 `WWW-Authenticate`（问题 5）。
- 没有空字符串头、重复头、数组头的专门用例；代码逻辑上是 fail closed，但未被用例锁住。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

逐个核对结果：

- `mcpRead.audience`：由 `parseMcpRead` 通过 `safeReference` 产生；用于启动时的 `CloudflareAccessJwtVerifier` audience、与 `identity.audience` 的比较、以及进程测试。两端都接受，且测试覆盖了“网页 audience 被拒”。
- `mcpRead.proposals`：解析只接受 `true`；`service-main` 用它决定是否创建 `write`，进而注册 `propose_memory`/`propose_rule`。类型和运行时一致；缺口是启动组装没有端到端测试（问题 3）。
- `identity.kind`：解析为 `"built-in"` 或 Cloudflare（允许缺省 kind）；`service-main` 用 `kind !== "built-in"` 选择 MCP 身份，启动检查用 `kind === "built-in"` 拒绝。两端一致。
- `externalSubjectRef`：MCP 侧由 `CloudflareAccessJwtVerifier` 产生，网页登录绑定也用同一个类、同一个 issuer 公式产生；MCP 用 `readBySubject` 查同一张绑定表。两端校验一致。跨 Access 应用的 `sub` 是否相同属于未核实的外部假设。
- `cf-access-jwt-assertion`：常量与 Fastify 小写头部键一致；测试用同一名字。
- `AdmissionWindows` 的 `ok/unauthorized/rate_limited` 与新增的 `unavailable`：`McpAdmission` 类型和路由状态映射一致（401/429/503）。
- `authInfo.scopes`：`admit` 按 `options.write` 产生 read/write；`#server` 按 `WRITE_ACCESS` 注册写工具。两端一致。
- `authInfo.clientId`：从令牌种类改为 `externalSubjectRef`；`requestState` 的 `bind` 使用它。类型为字符串，能用；随机签名密钥仍是进程级随机，未变。
- `MCP_ACCESS_OWNER_NOT_BOUND`：普通对象，`stableErrorCode` 的正则 `^[A-Z][A-Z0-9_]{0,127}$` 能接受该字符串；日志不会带出凭证内容。
- 被删除的 `MCP_READ_SECRET_PURPOSE`/`MCP_WRITE_SECRET_PURPOSE`：代码中已无使用方；旧 `secretRef`/`writeSecretRef` 会被配置解析拒绝。仅 ADR 0219 的历史段仍提到旧配置（问题 6）。
