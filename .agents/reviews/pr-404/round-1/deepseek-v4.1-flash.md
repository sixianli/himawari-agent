# 复核结论

## 读代码证实的发现（按严重度排列）

### 1. 中高：内部会话被写成“刚刚做过近期验证”，与作者约束相反

- 文件：`packages/persistence-sqlite/src/sqlite-paired-device-operations.ts:193-206`、`packages/platform-node/src/built-in-identity.ts:251-265`
- 问题：确认设备时创建内部 `product_sessions`，把 `first_authenticated_at`、`last_active_at`、`recent_authenticated_at` 全部写成确认时刻 `now`。作者明确说“内部会话不带‘近期身份验证’证据”，但持久层恰恰带了一个新鲜的近期验证时间。
- 证据：

```ts
// sqlite-paired-device-operations.ts:193-206
`INSERT INTO product_sessions
   (id, owner_id, device_id, revision, authentication_ref, status,
    first_authenticated_at, last_active_at, recent_authenticated_at, revoked_at)
 VALUES (?, ?, ?, 0, ?, 'active', ?, ?, ?, NULL)`
...
.run(input.webSessionId, device.ownerId, input.webDeviceId,
     input.webAuthenticationRef, now, now, now);
```

```ts
// built-in-identity.ts:251-260
authenticatedAt: session.recentAuthenticatedAt,
authenticationRef: session.authenticationRef,
...
recentAuthenticationEvidence: {
  source: "built_in_mfa",
  ...
  authenticatedAt: session.recentAuthenticatedAt,
```

- 影响：当前内部会话没有对应的 `built_in_session_credentials`，也没有保存可用的会话令牌，所以暂时不能直接当作网页会话登录；但如果将来引入“按持久化近期验证时间判断”的路径，或内部会话令牌以任何方式泄露，这一行就会把设备会话变成“刚刚验证过”的凭据。`device-api.test.ts:299` 只检查了内存里的 `authentication` 对象没有 `recentAuthenticationEvidence` 属性，没有检查数据库里这一行。
- 建议：内部会话的 `recent_authenticated_at` 应设为一个永远不合格的时间（或给表加可空语义并写 NULL），并补一条反向测试：读取持久化 session，证明它不能产生近期验证证据；不要只测内存对象。

### 2. 中：`device.request.body_bytes` 的实际生效值被 Fastify 全局 bodyLimit 截断

- 文件：`packages/application/src/ports/device-limits.ts:33-39`、`packages/platform-node/src/http-gateway-server.ts:207,812-813`、`packages/platform-node/src/device-api-routes.ts:172-174`
- 问题：设备配置默认允许 1 MiB（最大 16 MiB），但 Fastify 默认 `bodyLimit` 是 256 KiB。设备路由没有设置自己的 `bodyLimit`，所以 256 KiB 到配置上限之间的正文会先被 Fastify 拒绝，设备接口的配置值实际上无法达到。
- 证据：

```ts
// device-limits.ts:33-39
"device.request.body_bytes": {
  key: "device.request.body_bytes",
  unit: "bytes",
  defaultValue: 1_048_576,
  minimum: 1024,
  maximum: 16_777_216,
```

```ts
// http-gateway-server.ts:207,812-813
const DEFAULT_BODY_LIMIT = 256 * 1024;
...
const app = Fastify({
  bodyLimit: options.maximumBodyBytes ?? DEFAULT_BODY_LIMIT,
```

```ts
// device-api-routes.ts:172-174
const limit = options.configuration().limits["device.request.body_bytes"];
const declared = Number(header(request, "content-length") ?? "0");
if (Number.isFinite(declared) && declared > limit) options.rejectBody(413);
```

- 影响：设备看到 `/config` 返回 1 MiB，但实际超过 256 KiB 的请求由 Fastify 抛出 413，全局错误处理映射成 `BODY_INVALID`（`http-gateway-server.ts:926-938`），不是设备契约的 `DEVICE_BODY_TOO_LARGE`。如果生产配置 `configuration.http.maximumBodyBytes` 更小（例如 64 KiB），连 `MESSAGE_TEXT_MAXIMUM = 64 * 1024` 的正文加上 JSON 外壳都装不下。这是典型的“配置端接受、消费端不认”的 I-73 类问题；现有测试把设备上限设成 1024/2KB，正好绕过了这个差异。
- 建议：在设备路由上按 `min(HTTP bodyLimit, device.request.body_bytes)` 设置路由级 `bodyLimit`，或在启动时硬性校验 `http.maximumBodyBytes >= device.request.body_bytes`；并把设备路由上的 Fastify 413 映射为 `DEVICE_BODY_TOO_LARGE`。加一条“设备上限大于 HTTP 全局上限”的反向测试。

### 3. 中：同一把 P-256 公钥可以用不同 base64 编码分别冒充设备密钥和确认密钥

- 文件：`packages/platform-node/src/paired-device-service.ts:147-156`、`packages/platform-node/src/device-request-signature.ts:203-204`、`packages/persistence-sqlite/src/migrations/0093_paired_devices.sql:9-10,22`
- 问题：配对时只比较两个公钥字符串是否完全相同，没有比较解码后的 DER/密钥材料。同一份 SPKI DER 去掉末尾 `=` 再提交，两个字符串不同，`createPublicKey` 解码后却是同一把密钥，能通过路由校验和数据库 `device_public_key <> confirm_public_key` 检查。
- 证据：

```ts
// paired-device-service.ts:147-156
typeof input["devicePublicKey"] !== "string" ||
typeof input["confirmPublicKey"] !== "string" ||
!SPKI_PATTERN.test(input["devicePublicKey"]) ||
!SPKI_PATTERN.test(input["confirmPublicKey"]) ||
input["devicePublicKey"] === input["confirmPublicKey"]
...
publicKeyFromSpkiBase64(input["devicePublicKey"]);
publicKeyFromSpkiBase64(input["confirmPublicKey"]);
```

```ts
// device-request-signature.ts:203-204
export function publicKeyFromSpkiBase64(value: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
```

- 影响：本批没有任何路由强制 `requireConfirm`，所以目前不会直接造成越权；但设计把确认密钥用于“主人在场”的高风险审批，若这个缺口留到后续批次，设备密钥本身就能冒充确认密钥，削弱“两把密钥”的安全边界。
- 建议：解码后比较规范化 DER 字节、JWK thumbprint 或 `KeyObject.export({format:"der", type:"spki"})` 的结果，并统一存规范化 base64；补反向测试：同一把密钥加/不加 base64 padding 必须被拒。

### 4. 中：硬上限键的文档契约与代码不一致：文档九个，代码/界面十个

- 文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:583,706`、`packages/application/src/ports/device-limits.ts:1-12`、`apps/control-center/src/components/device-settings.tsx:8-19`
- 问题：设计文档把抢跑缓存写成一个键 `device.prefetch.cache`，并在新值清单里明确写“硬上限的九个配置键”；代码把同一个概念拆成 `device.prefetch.cache.entries` 和 `device.prefetch.cache.bytes`，总共十个键。界面和 `/config` 都返回十个。按文档配置九个键的人会被 `parseDevice` 的 `rejectUnknown` 拒绝，未来按文档生成 Swift 清单也会和服务器不一致。
- 证据：

```md
<!-- 设计文档:583 -->
| `device.prefetch.cache` | 每台设备的抢跑缓存 | 20 条、合计 200 KB | 丢最旧的 |
<!-- 设计文档:706 -->
| 硬上限的九个配置键 ... | 配置解析只认这九个键名 ...
```

```ts
// device-limits.ts:1-12
export const DEVICE_HARD_LIMIT_KEYS = [
  "device.request.body_bytes",
  ...
  "device.prefetch.cache.entries",
  "device.prefetch.cache.bytes",
  ...
  "device.nonce.retained",
] as const;
```

- 影响：这是 I-73 的同类问题——同一个清单项在产生端和使用端校验不一致。当前批次只展示上限，所以不会马上出错，但正是后续客户端生成和配置升级会踩的坑。
- 建议：由设计线程先定稿，是保留一个 `device.prefetch.cache`，还是承认十个拆分键；同步改设计文档、新值清单、`strict-configuration`、UI 清单和测试。更好的是让 UI/服务端/文档都从同一份常量生成，避免 UI 里再手抄一份 `DEVICE_LIMIT_KEYS`。

### 5. 中低：计划第 1 批要求的“换网页会话 + 确认密钥”没有实现，`requireConfirm` 无人调用

- 文件：`docs/execution/plans/2026-11-11-apple-device-body-plan.md:72,79`、`packages/platform-node/src/device-api-routes.ts:29-35,195-199`、`packages/platform-node/src/paired-device-service.ts:216-229`
- 问题：计划第 1 批明确写要测试“换网页会话的请求只用设备密钥签的被拒，用确认密钥签的通过”，但本 PR 的设备路由只有 `pair/config/stream/messages/threads`，没有 `web-session`；`authenticate` 从不传 `requireConfirm`，确认密钥在整条请求路径上没有被要求过。
- 证据：

```md
<!-- 计划:79 -->
写失败的测试：...换网页会话的请求只用设备密钥签的被拒，用确认密钥签的通过。
```

```ts
// device-api-routes.ts:29-35
export const DEVICE_API_ROUTES = Object.freeze([
  { method: "POST", path: "pair", signed: false },
  { method: "GET", path: "config", signed: true },
  { method: "GET", path: "stream", signed: true },
  { method: "POST", path: "messages", signed: true },
  { method: "GET", path: "threads", signed: true },
] as const);
```

```ts
// device-api-routes.ts:195-199
const authenticate = (request: FastifyRequest) =>
  options.devices.authenticate({
    request: signed(request),
    expectedAuthority: options.publicOrigin.host,
  });
```

- 影响：作者列出的六条说法没有声称实现了 `web-session`，但计划把这条放在第 1 批，代码和计划不一致。确认密钥目前只是“能签但没人要求”，容易让后续审批安全设计误以为这道门已经存在。
- 建议：要么把 `web-session` 和确认密钥校验补进本批，要么明确把计划第 1 批的范围降级并写进 PR/设计；同时给 `requireConfirm` 加至少一条走真实路由的测试，避免死参数。

### 6. 低：设备管理接口不拒绝多余字段，违反设计文档“多出来的字段一律拒绝”

- 文件：`packages/platform-node/src/device-api-routes.ts:378-390`、设计文档 `2026-11-11-apple-device-body-design.md:235`
- 问题：`pair` 和 `/messages` 会检查键集合，但 `confirm/rename/revoke` 共用的 `deviceAction` 只检查 `deviceId` 和 `expectedRevision`，多余键被静默接受；`/list` 和 `/pairing-codes` 的正文也完全忽略。
- 证据：

```ts
// device-api-routes.ts:378-390
const deviceAction = (request: FastifyRequest) => {
  const body = request.body as Record<string, unknown> | undefined;
  if (
    !body || typeof body !== "object" ||
    typeof body["deviceId"] !== "string" ||
    !/^dev_[A-Za-z0-9_-]{22}$/u.test(body["deviceId"]) ||
    !Number.isSafeInteger(body["expectedRevision"]) ||
    (body["expectedRevision"] as number) < 0
  ) options.rejectBody(400);
  return body as { deviceId: string; expectedRevision: number; name?: unknown };
};
```

- 影响：不符合设计约定的固定结构校验；多余字段目前虽不改变行为，但会让客户端把拼错的字段当成生效，后续扩展时也容易出现“字段写错但不报错”。
- 建议：给 `confirm/rename/revoke` 增加精确键集合检查，`list/pairing-codes` 明确拒绝非空或未允许的正文；补“多余字段返回 400”的反向用例。

### 7. 低：导出字段范围比作者说法“只导出名字、种类、状态”更宽

- 文件：`packages/persistence-sqlite/src/data-export/export.ts:297-305`
- 问题：导出实际包含 `id`、`releaseChannel`、`pairedAt`、`confirmedAt`、`revokedAt`；作者约束说的是“只导出设备的名字、种类、状态”。凭据类确实没有导出，但字段范围的说法不准确。
- 证据：

```ts
const pairedDeviceLines: JsonValue[] = snapshot.pairedDevices.map((row) => ({
  id: str(row["id"]),
  kind: str(row["kind"]),
  name: safeString(str(row["name"])),
  releaseChannel: str(row["release_channel"]),
  status: str(row["status"]),
  pairedAt: str(row["paired_at"]),
  confirmedAt: optionalString(row["confirmed_at"]),
  revokedAt: optionalString(row["revoked_at"]),
}));
```

- 影响：不泄露公钥、配对码哈希或随机值，但会导出额外元数据；如果“只导出”是隐私承诺，应改代码或改文档，不能两边各说各的。
- 建议：确认预期字段后统一文档、测试和导出实现；若额外字段确实需要，明确写成“名字、种类、状态、发布渠道和时间戳”。

### 8. 低：`/threads` 响应会带回内部浏览器设备行 id，现有保密断言没覆盖

- 文件：`packages/platform-node/src/device-api-routes.ts:241-242`、`test/integration/device-api.test.ts:115-127`
- 问题：`/threads` 的 `correlationId` 使用 `authentication.deviceId`，设备认证里它来自内部 `product_sessions.deviceId`，也就是确认时创建的浏览器 `devices.id`。响应会原样回显 `correlationId`。测试只对 pair/confirm/config/list 做了“内部 id 不出现”的检查，没有把 `/threads` 和 `/stream` 加入 `everything`。
- 证据：

```ts
// device-api-routes.ts:241-242
messageId: `device-query:${stableSuffix(authentication.deviceId, now().toISOString())}`,
correlationId: `device:${authentication.deviceId}`.slice(0, 128),
```

- 影响：这不是作者 claim 4 说的“内部会话编号或 authentication_ref”（那两个确实没有出现），但内部浏览器设备行 id 会出现在 `/threads` 响应中；同时 `/stream` 的 `correlationId` 又使用配对的设备 id，两个接口语义不一致。
- 建议：统一使用配对设备 id，或明确 webDeviceId 可公开并把 `/threads`、`/stream` 纳入保密测试；不要让“内部 id 不出现”的断言只覆盖部分接口。

## 推测与未核实

- **推测（低）：调高 `signatureToleranceSeconds` 会产生重放窗口。** nonce 的过期时间在写入时按当时的 `2 * tolerance` 计算（`paired-device-service.ts:250-256`），而记录 nonce 时只会删除 `expires_at <= now` 的旧值（`sqlite-paired-device-operations.ts:271-273`）。如果先以 60 秒运行，再把容许值调到 600 秒，之前已经删除的 nonce 对应的请求在 600 秒窗口内可能被重放。需要确认配置变更是否被视为在线操作；若是，应把 nonce 有效期按最大容许值或配置变更时整体失效处理。
- **推测（低）：`stillActive` 的会话校验比 `authenticate` 弱。** `authenticate` 检查 `session.ownerId === current.ownerId`（`paired-device-service.ts:263-267`），但 `stillActive` 只检查 `session?.status === "active"`（`paired-device-service.ts:283-291`），没有核对 session 的 `ownerId`/`deviceId`。正常写库不会产生错配，但作为事件流放行判断，建议和安全入口使用同一组校验。
- **未核实：`GET /api/device/v1/<未知路径>` 是否一定返回 `DEVICE_PATH_NOT_ALLOWED`。** 从路由注册看设备插件的 `/*` 通配路由比全局静态 `/*` 更具体，应该会命中插件并走 onRequest 白名单；但现有测试只用 POST 测了 `/web-session` 和 `/rules`，没有实际请求验证 GET 未知路径，也没有验证精确的 `/api/device/v1`（无尾斜杠）会走到哪里。全局 `app.get("/*")` 对 `/api/` 前缀会返回 `STATIC_NOT_FOUND`（`http-gateway-server.ts:1677-1688`）。
- **未核实：`npm run check` 的 50 步是否全过。** 本次环境只允许读文件和查看 git，不能运行测试；作者声称的全绿未验证。

## 侧重检查

- **错误路径**：`DeviceSignatureError` 统一映射 401（`http-gateway-server.ts:897-904`）；`PairedDeviceError` 映射各自状态码；配对码错误/过期/已用分别是 404/410/409；nonce 重放 401、库满 429；设备 pending/revoked/owner 不活跃 403。读代码没有发现未捕获的正常错误路径。唯一明显的错误约定问题是 Fastify 的正文超限被映射成 `BODY_INVALID`，不是 `DEVICE_BODY_TOO_LARGE`。
- **不合规范/不可信输入**：签名解析要求固定组件顺序、固定参数集合、P-256 曲线、64 字节 IEEE P1363 签名、正文摘要和时间窗口，未发现解析绕过。配对请求严格拒绝多余键；但两个公钥只按字符串比较，存在同一密钥换编码的缺口；设备管理接口不拒绝多余字段。
- **安全**：重放、改正文、改查询、改路径、改 Host、时间差过大、未知设备、未确认设备、已吊销设备、owner 不活跃都在代码路径上被拒；验签在 nonce/touch 写库之前完成。未发现当前批次可直接利用的越权。主要潜伏风险是内部会话 `recent_authenticated_at = now` 和确认密钥可与设备密钥同材。
- **资源耗尽**：nonce 按设备有上限，过期会清理；请求正文有上限但和 Fastify 全局上限不一致；事件流有最长连接时间和心跳；`/pair` 没有速率限制，但配对码是 128 位随机，暴力破解不可行。未看到针对流并发的全局上限（未核实是否在别的层实现）。
- **不可撤销操作**：吊销只改状态并吊销内部会话/浏览器设备行，不删除设备历史；数据导出不恢复设备；没有发现会误删用户数据的新路径。
- **规则/文档一致性**：本 diff 没有改 `packages/prompt-catalog`、工具或提示词，未改模型请求开头；但设计文档的九个上限键与代码十个不一致，计划中的 `web-session`/确认密钥未实现，导出字段范围与作者“只导出名字、种类、状态”的说法不一致。

## 作者六条说法逐条核对

1. **“任何没在允许清单里的 /api/device/v1/ 路径都返回 404 DEVICE_PATH_NOT_ALLOWED，不会落到别的路由。”** 代码上设备插件有 onRequest 白名单和 `all("/*")` 兜底，主要路径成立；但现有反向测试只覆盖两个 POST 路径，GET 未知路径和精确前缀 `/api/device/v1` 未核实。
2. **“重放、改查询、改正文、换主机名、时间差过大都会被拒绝；签名验证在任何写库动作之前。”** 基本成立：摘要、@query、@path、@authority、created、nonce 都覆盖；`authenticate` 先验签，`recordNonce`/`touchDevice` 在其后。不过测试里的“换主机名”改的是签名里的 authority，不是实际 Host 头，`HOST_MISMATCH` 分支本身没有直接测试。
3. **“同一条设备消息（同 messageId）重复发送只进对话一次。”** 成立：`deviceId + messageId` 生成稳定 suffix，payload 和命令幂等键稳定；语义指纹包含 `contentRef/threadId/messageId`，不包含会变的 `occurredAt`，所以时间变化不会破坏重放。测试用两个不同 nonce 发送同一 messageId 并断言复用了第一次结果。
4. **“内部会话的编号和 authentication_ref 不出现在任何响应里，设备会话过不了需要本人在场的审批。”** 前半句在当前设备响应里基本成立（没有发现 sessionId/authenticationRef），但 `/threads` 的 correlationId 会带内部浏览器设备 id；后半句在内存层成立（`authentication` 没有 `recentAuthenticationEvidence`，`RecentAuthenticationGuard` 会拒），但持久层把 `recent_authenticated_at` 写成 now，与“内部会话不带近期身份验证证据”的约束矛盾。因此这条应判为**部分不成立**。
5. **“吊销后设备的请求、内部会话和已开的事件流都失效。”** 成立：`revokeDevice` 同时改 paired device、product_sessions、devices，事件流每次心跳/事件重查 `stillActive`；测试覆盖了请求拒绝、会话 revoked 和开着的流断开。
6. **“导出文件里不出现公钥、配对码哈希、随机值。”** 成立：导出只取名字/种类/状态等字段，不取 public key、pairing code hash、nonce；反向测试覆盖四个凭据字符串。补充：导出实际还包含 id、releaseChannel、时间戳，比作者说的“只导出名字、种类、状态”宽，见发现 7。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次 diff 没有改 `packages/prompt-catalog`、工具定义或系统提示；计划也明确第 1 批“不动发给模型的任何内容”。设备消息通过既有的 `thread.message.submit` 进入对话，是追加一条新的用户消息，不修改系统提示、工具、历史或已有遮盖结果。会变的值（`occurredAt`、当前时间）只出现在新命令/新消息一侧，不在请求开头。依据：`.claude/rules/prompt-prefix.md:27-35`（固定在前、只在末尾追加、已发出内容不得改动）。未运行 `check:prompt-prefix`，这一条是代码阅读结论。

2. **同一段文字会不会在不同请求里变成不同字节？**
   设备消息正文在模型可见层面是稳定的：同一设备、同一 `messageId` 的 suffix 固定，`protectText` 的 idempotency key 固定，内容摘要相同；没有依赖后文的无序集合。导出查询用 `ORDER BY paired_at, id`，顺序固定。会变的随机 nonce、`occurredAt` 和 `lastSeenAt` 不是模型正文的一部分；`occurredAt` 属于新追加的消息，不改变开头。唯一未核实的是底层加密是否随机 nonce（那会让密文字节变化，但不应影响解密后的模型可见文本）。

3. **有没有自动检查，反向用例是否真的会失败？**
   有：签名单元测试、设备 API 集成测试、浏览器测试、导出测试。反向用例大体真实：改正文/查询/时间、重放、未知设备、未确认/吊销、nonce 库满、导出中检索公钥/配对码/随机值，以及导出文件加 public key 后用 `additionalProperties: false` 拒绝。缺口：没有覆盖“设备上限大于 Fastify 全局 bodyLimit”、没有真正改 Host 头、没有 GET 未知路径、没有持久化 `recent_authenticated_at` 的断言、没有“同一公钥不同 base64 编码”的用例、没有管理接口多余字段的用例。`npm run check` 50 步未运行，未核实。

4. **每个新值/字段/配置/清单项，两端都能接受吗？**
   逐个核对结果：
   - `dev_` + 22 字符设备 id：生成处与 DB `length(id)=26`、设备管理正则、导出 schema 一致。
   - 22 字符配对码：服务端正则、QR 解析、SHA-256 64 位哈希存储一致。
   - `device:`/`session:` 内部 id 和 `sha256:` authRef：服务端生成、DB 外键/会话读取、访问策略使用；未导出，未发现响应泄露 sessionId/authRef。但内部会话的 `recent_authenticated_at` 语义不一致（发现 1）。
   - `messageId`、`message:${suffix}`、`turn/run/correlation`：设备路由正则、稳定 suffix、gateway `machineString` 校验一致；测试通过。
   - 硬上限键：`DEVICE_HARD_LIMIT_KEYS`、严格配置、`/config`、UI 都是同样十个；但设计文档仍是九个且使用旧键 `device.prefetch.cache`（发现 4）。
   - `device.request.body_bytes`：配置接受 1 MiB 默认/16 MiB 最大，但 Fastify 默认 256 KiB 先截断（发现 2）。
   - 迁移 0093：迁移引擎、迁移合同测试、schema catalog、workspace audit 的 93 已同步。
   - manifest 新字段 `pairedDevices`：export、demo-pack、import、verify、schema、测试计数都已更新；旧格式导入受既有 migration sequence 检查限制，不是本次新增的兼容问题。
   - 确认密钥唯一性：两端只做字符串比较，没有比较密钥材料（发现 3）。
   - 导出字段：凭据不外泄成立，但实际字段比作者说法多（发现 7）。
