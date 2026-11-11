# PR 389 复核结论

## 一、读代码证实的问题（按严重度）

### 1. 【中】限流在 JWT 校验和主人查询之后才执行，挡不住未认证请求造成的资源消耗

- 位置：`apps/agent-service/src/production-mcp-read.ts:320-339`
- 证据：

```ts
325:        const verified = await this.#options.access.verify(assertion);
326:        const binding = await this.#options.owners.readBySubject(verified.externalSubjectRef);
...
334:    const status = this.#windows.admit(subject !== undefined);
```

- 问题：带任意 `cf-access-jwt-assertion` 的请求都会先做 RSA 验签；如果 token 的 `kid` 不在缓存里，还可能触发一次 JWKS 下载（受 30 秒冷却限制）。这些工作全部完成后才进入 60/分钟无效窗口。也就是说，60/分钟的限制只限制“返回 401 的数量”，不限制验签、JWKS 等待和（验签通过后的）数据库读取。攻击者可以并发发送大量伪造 token，绕过限流对 CPU/DB 的保护。
- 另外：即使已经超过无效额度，每个无效请求仍会完整走一遍验签后才拿到 429。
- 建议：在验签前加一层粗粒度准入（按来源 IP 的令牌桶、全局并发信号量，或“先按请求头存在性计一次廉价额度，验签成功后再退回/调整”），保证未认证洪泛在进入密码学和数据库路径前被截断。保留现有 60/分钟日志上限即可。
- 说明：这不是认证绕过，是可用性/资源耗尽问题。

### 2. 【低】JWKS 冷却期内会返回已经过期的缓存

- 位置：`packages/platform-node/src/identity-gateway.ts:221-232`
- 证据：

```ts
223:    if (this.pendingFetch) return this.pendingFetch;
224:    if (this.withinRefreshCooldown(now)) {
225:      if (this.cached) return this.cached.jwks;
226:      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.JWKS_INVALID);
227:    }
228:    if (!forceRefresh && this.cached && this.cached.expiresAt > now) return this.cached.jwks;
```

- 问题：冷却分支只判断 `this.cached` 是否存在，不判断 `expiresAt > now`。一次刷新失败后，即使缓存已经过期，接下来 30 秒内仍会用过期公钥验签。若 Cloudflare 因密钥泄露撤销了旧 key，旧 key 还能多被接受最多约 30 秒。基线代码在缓存过期且刷新失败时是失败关闭的，这是相对基线的安全弱化。
- 附带影响：配置允许 `jwksCacheMilliseconds` 最小 1000（`strict-configuration.ts:731-736`），但实际刷新间隔被拉长到 `max(cacheMilliseconds, 30s)`；ADR 0227 只写了“有缓存就用缓存”，没有写明“过期缓存也用”。
- 建议：冷却分支里加 `this.cached.expiresAt > now` 才返回缓存，否则抛 `JWKS_INVALID` 失败关闭；如果确实要容忍过期缓存，应在 ADR 里明确写出“最多容忍 30 秒的过期公钥”，并说明密钥撤销窗口。

### 3. 【低】`pendingFetch` 会让本可用缓存的合法请求等待一次可能失败的刷新

- 位置：`packages/platform-node/src/identity-gateway.ts:223`
- 证据：

```ts
223:    if (this.pendingFetch) return this.pendingFetch;
```

- 问题：攻击者只需构造一个 `kid` 不存在的 JWT（jose 在选 key 阶段就抛 `JWKSNoMatchingKey`，不需要签名正确）就能触发一次强制刷新。刷新进行期间，`pendingFetch` 放在缓存检查之前，所有合法请求（即使当前缓存仍有效）都要等这次网络请求；如果这次刷新失败，它们也会一起返回 401。基线代码中，缓存有效时合法请求会直接返回缓存，不会受并发刷新影响。
- 建议：在 `forceRefresh === false` 且缓存仍有效时先返回缓存，再考虑 `pendingFetch`；或在 `pendingFetch` 失败时回退到仍然有效的缓存。这样既保留冷却，又不把合法请求绑在攻击者触发的刷新上。

### 4. 【低】主人绑定的 `status` / `ownerId` 分支没有对应的反向测试

- 位置：`apps/agent-service/src/production-mcp-read.ts:327`，`test/integration/mcp-read.test.ts:601-655`
- 证据：

```ts
327:        if (binding?.ownerId === this.#options.scope.ownerId && binding.status === "active")
```

```ts
628:      await f.access.sign({ subject: "someone-else-in-the-access-team" }),
...
654:    expect(f.failures[3]).toEqual({ code: "MCP_ACCESS_OWNER_NOT_BOUND" });
```

- 问题：现有拒绝用例只覆盖“这个 subject 在库里没有绑定”。如果有人把判断改成“只要 `readBySubject` 返回记录就放行”，现有测试仍然全部通过；`binding.status === "active"` 和 `ownerId` 相等这两个条件没有被独立验证。`readBySubject` 在 `service-main.ts:1790` 用的不是 scoped 包装，所以 `ownerId` 比较是有意义的；`status` 也可能是 `disabled`（`packages/persistence-sqlite/src/built-in-identity-recovery.ts:26`）。
- 建议：补一条用 SQL 或恢复流程造出 `status = 'disabled'` 的绑定，断言 401 且不写决策台账；再补一条绑定属于其他 owner 的用例（或至少直接测试 scoped `ownerId` 不匹配的分支）。

## 二、推测 / 未核实

- **跨 Access 应用的 `sub` 是否相同，未核实。** 主人绑定和 MCP 校验都用 `sha256(issuer + "\0" + sub)`（`identity-gateway.ts:212`），网页登录用的是网页应用的 audience，MCP 用的是另一个应用。代码层面两端都调用同一个 `CloudflareAccessJwtVerifier`，只有 audience 不同，因此摘要一致的前提是 Cloudflare 对同一邮箱在不同应用下给出相同 `sub`。ADR 0227:113 已把这个列为 Hermes 待实测项；如果不同，Andy 本人也会被 401 挡住。这不是安全漏洞，但会导致功能不可用。
- **Cloudflare 是否会在源站 401 上补齐授权服务器发现头，未核实。** 代码只是删掉了自定义 `WWW-Authenticate`，是否能达到 Claude 连接器的发现效果取决于 Cloudflare 侧行为，无法离线验证。
- **测试未实际运行。** 本次只能读代码；作者声称的反向验证（改弱校验后用例失败）没有在本环境重跑。下面对“反向用例会不会失败”的判断是基于测试代码的静态检查。
- **稀疏检出。** 当前工作区只有 73% 的文件，无法用 `git grep` 枚举全仓库所有外部消费者；不过本 PR 改动文件内的导入/调用点都已核对，`git diff` 内没有遗留的旧 secret 用法。

## 三、侧重检查

- **认证绕过路径**：只读取 `request.headers["cf-access-jwt-assertion"]`（`production-mcp-read.ts:774`）。Node/Fastify 会统一小写头名，`Cf-Access-Jwt-Assertion` 可以正常命中；空值、数组值（重复头）都会变成 `undefined`，走 401；不再读取 `Authorization`。验签/主人查询抛错被 `catch` 成 `rejection`，`subject` 不赋值，返回 401。未发现绕过路径。
- **不可信输入**：JWT 长度上限 16384（`identity-gateway.ts:171`），算法固定 RS256，issuer/audience/exp 由 jose 校验；`payload.sub` 必须为非空字符串。MCP body 上限仍是 65536。JWKS 抓取由 `BoundedJwksFetcher` 限制 URL、超时和响应体。
- **主人校验**：`ownerId` 相等且 `status === "active"` 才放行，失败关闭；缺口见问题 4。
- **限流**：计数本身在 `await` 之后同步完成，没有并发竞态；60 次无效后 429、429 不记日志、有效窗口独立，均与测试相符。但限流位置在昂贵校验之后，见问题 1。
- **公钥刷新**：同刻只发一次、失败也冷却，测试覆盖到位；过期缓存和失败刷新阻塞合法请求见问题 2、3。
- **不可撤销操作**：本 PR 未新增；`propose_memory` 仍走原有 elicitation 确认流程，未改动。
- **文档与代码一致**：ADR 0227 的决定 1、2、3、4、6 与代码基本一致；ADR 0219/0225 已加“被 0227 取代”的说明。作者说明中的“限流数值不变”按单个窗口成立，但读写合并成一份 30/分钟（ADR 已写明）。未发现新增代码注释。

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。本 PR 自己的 diff（`e4ab2cd..4d09f51`）只改认证、配置、测试和 ADR，没有改 `packages/prompt-catalog`、`packages/runtime-pi`、系统提示、工具定义、历史消息或遮盖逻辑。发给模型的内容仍然只在末尾追加；每次请求变化的 JWT 在 HTTP 头里，`requestState` 在工具结果/后续请求里，不在系统提示或工具定义中。
注意：`927abf..4d09` 的增量里混入了 main 上其他 PR 的提示词改动（例如 `__prompt_golden__/memory.consolidation.txt`），但那些不在 `e4ab2..4d09`（本 PR）的 diff 里，不属于 PR 389。
`.claude/rules/prompt-prefix.md` 在本次稀疏检出中不存在，未能直接引用原文，只能依据 diff 和仓库内 ADR 0149 等文档判断。

### 2. 同一段文字会不会在不同请求里变成不同字节？

不会由本 PR 引入。`externalSubjectRef` 对同一 issuer + `sub` 是确定性的，只用作 `clientId` 和 `requestState` 的绑定值，不进入模型正文；`MCP_ACCESS_OWNER_NOT_BOUND` 是常量；没有新的时间字段、无序集合或依赖前后文的遮盖。
唯一的边界情况是：如果 Cloudflare 在不同 Access 应用下给出不同的 `sub`，同一主人在网页登录和 MCP 入口会得到不同的摘要，导致 `requestState` 不能跨入口复用；这属于第二节的未实测项，不是同一请求内字节不稳定的问题。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

有：
- `test/integration/mcp-read.test.ts`：无凭证、旧 Bearer、外键签名、错 audience、过期、非绑定主人、401 不带 `WWW-Authenticate`、60 次后 429 且 429 不记日志。
- `test/integration/mcp-write.test.ts`：`readOnly` 时不出现 `propose_memory`，打开后出现。
- `packages/platform-node/test/identity-gateway.unit.test.ts`：未知 kid 并发只下载一次、失败下载后 30 秒冷却。
- `packages/platform-node/test/startup-configuration.unit.test.ts`：只接受 `audience` / `proposals: true`，拒绝旧键、内置身份和相同 audience。
- `production-http-composition.unit.test.ts` 和 `production-http-composition-process.test.ts`：真实组装/真实进程的 audience 隔离和工具列表开关。

按代码静态检查：把验签改成“有凭证就放行”、去掉主人核对、重新加回 `WWW-Authenticate`、去掉冷却，现有用例都会失败。反向覆盖的缺口是：没有 disabled/其他 owner 的绑定用例（问题 4），没有过期缓存仍被使用的用例（问题 2），也没有针对“限流在验签之后”的用例（问题 1）。本次未实际运行这些测试。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对如下：

- **`runPolicy.mcpRead.audience`**：产生于 `parseMcpRead`（`strict-configuration.ts:1121-1128`，经 `safeReference` 校验），消费于 `service-main.ts:1793` 传入 `CloudflareAccessJwtVerifier` 的 `audience`；验证器在 `jwtVerify({ audience })` 中按字符串精确匹配，测试用同一字符串签发。两端一致。Cloudflare 的 AUD 通常是 64 位十六进制，`safeReference` 的正则能接受。
- **`runPolicy.mcpRead.proposals`**：解析器只接受 `true`，`service-main.ts:1806` 用它决定是否构造 `write.proposals`；工具注册再根据 `this.#options.write?.proposals` 判断。两端一致。
- **`cf-access-jwt-assertion`**：常量 `MCP_ACCESS_ASSERTION_HEADER` 产生，路由按同名键读取；测试硬编码同一字符串。一致。
- **`externalSubjectRef`**：由 `CloudflareAccessJwtVerifier` 生成 `sha256(issuer + "\0" + sub)`，网页登录的 `bindFirstOwner` 和 MCP 的 `readBySubject` 消费同一个值。两端代码一致；唯一未核实的是 Cloudflare 跨应用的 `sub` 是否相同（见第二节）。这是本 PR 最典型的“两端值能否对上”风险。
- **`MCP_ACCESS_OWNER_NOT_BOUND`**：产生为带 `code` 的常量对象，经 `stableErrorCode` 记录到 `mcp-read.failed`，测试断言该 code。两端一致。
- **删除的 `secretRef` / `writeSecretRef` / `mcp-read` / `mcp-write` 用途**：全仓库当前可见代码和 diff 中没有残留引用；旧配置会因为 `rejectUnknown` 在启动时失败，属于有意的 fail-closed。ADR 已说明 P5-1 未上线。
- **合并后的限流窗口**：`AdmissionWindows` 同时被 MCP 和 `BearerGate` 使用，Muse/Gap 行为不变；MCP 从“读写各 30/分钟”变为“全入口共用 30/分钟”，ADR 0227 已明确写出，作者说明的“数值不变”应按单窗口理解。
