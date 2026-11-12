## 发现（按严重度从高到低）

### 中 — `device.request.body_bytes` 没有在请求体读取阶段生效，`/pair` 可绕过配置上限

**文件：** `packages/platform-node/src/device-api-routes.ts:236-238`、`:251-253`、`:259-261`、`:294-296`；`packages/application/src/ports/device-limits.ts:33-41`

**问题：** 设备插件把每个路由的 `bodyLimit` 固定成硬上限 16 MiB，而配置值 `device.request.body_bytes` 只在 `onRequest` 里按 `content-length` 预检，或在 `signed()` 里解析完请求体之后才检查。HTTP/1.1 的 chunked 请求可以没有 `Content-Length`；`/pair` 又完全不调用 `signed()`，所以它既不按配置上限预检，也不在 `json()` 之后检查实际长度。

**证据：**

```ts
// device-api-routes.ts:236-238
device.addHook("onRoute", (route) => {
  route.bodyLimit = DEVICE_HARD_LIMITS["device.request.body_bytes"].maximum;
});

// device-api-routes.ts:251-253
const limit = options.configuration().limits["device.request.body_bytes"];
const declared = Number(header(request, "content-length") ?? "0");
if (Number.isFinite(declared) && declared > limit) options.rejectBody(413);

// device-api-routes.ts:259-261（只有走 authenticate/signed 的路由才执行）
const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
if (body.length > options.configuration().limits["device.request.body_bytes"])
  options.rejectBody(413);

// device-api-routes.ts:294-296（/pair 没有 signed 检查）
device.post("/pair", async (request, reply) => {
  const paired = await options.devices.pair(json(request));
```

`device.request.body_bytes` 默认 1 MiB，硬上限 16 MiB（`device-limits.ts:36-38`）。实际效果是：未认证的 `/pair` 在没有 `Content-Length` 时可以迫使服务端最多缓冲 16 MiB；签名路由也要先缓冲到 16 MiB 才在 `signed()` 里返回 413。

**建议：** 不要把 `route.bodyLimit` 写成硬上限；改为在启动时按配置生成路由上限，或在自定义 content-type parser 的流式读取阶段按 `device.request.body_bytes` 截断。`/pair` 也必须走同一层长度检查，并且补一条反向测试：无 `Content-Length`、chunked 的 `/pair` 请求超过配置上限时必须 413。

---

### 中 — 数据导出没有 `lastSeenAt`，与作者说法不一致

**文件：** `packages/persistence-sqlite/src/data-export/snapshot.ts:106-110`、`packages/persistence-sqlite/src/data-export/export.ts:297-306`、`packages/persistence-sqlite/src/data-export/schemas.ts:153-166`；测试 `test/integration/data-export.test.ts:878-889`

**问题：** 作者说导出设备“编号、名字、种类、状态、发布渠道、配对和最后在线时间”，但快照查询、导出行、导出 schema 和测试的精确对象里都没有 `lastSeenAt`。这不是“导出格式两端校验不一致”，而是两端都校验了一个缺字段的格式，因此现有反向测试不会失败。

**证据：**

```ts
// snapshot.ts:106-110
const pairedDevices = all(
  `SELECT id, kind, name, release_channel, status, paired_at, confirmed_at, revoked_at
  FROM paired_devices WHERE owner_id = @ownerId AND agent_id = @agentId
  ORDER BY paired_at, id`,
);

// export.ts:297-306
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

// schemas.ts:153-163（没有 lastSeenAt）
export const PAIRED_DEVICE_SCHEMA: JsonSchema = objectOf(
  {
    id: ...,
    kind: ...,
    name: ...,
    releaseChannel: ...,
    status: ...,
    pairedAt: timestamp,
    confirmedAt: nullable(timestamp),
    revokedAt: nullable(timestamp),
  },
  [],
  ...
);
```

**建议：** 如果需求确实是导出“最后在线时间”，在 SQL 加 `last_seen_at`，导出行加 `lastSeenAt: optionalString(row["last_seen_at"])`，schema 加 `lastSeenAt: nullable(timestamp)`，并把 `data-export.test.ts:878-889` 的精确对象更新成包含该字段；否则应修正作者说法和需求文档。

---

### 低 — “同一主人只有一个有效配对码”实际是 `owner + agent` 维度

**文件：** `packages/persistence-sqlite/src/sqlite-paired-device-operations.ts:87-92`

**问题：** 作者说“同一主人同时只有一个有效配对码”，但删除旧码的条件是 `owner_id = ? AND agent_id = ?`。如果同一个主人名下有多个 agent，不同 agent 可以同时各有一个有效配对码。

**证据：**

```ts
// sqlite-paired-device-operations.ts:87-92
DELETE FROM device_pairing_codes
  WHERE expires_at <= ? OR used_at IS NOT NULL OR (owner_id = ? AND agent_id = ?)
```

**建议：** 单 agent 的第 1 批里这等价于“同一主人只有一个”；如果要支持多 agent，明确按 owner 还是 owner+agent 限定，并让文档、接口和测试一致。当前至少应修改作者说法或在设计里写清作用域。

---

### 低 — 文档、计划与代码仍有不一致

**文件：** `docs/execution/specs/2026-11-11-apple-device-body-design.md:630-631`、`:706`；`docs/execution/plans/2026-11-11-apple-device-body-plan.md:72`；代码 `packages/application/src/ports/device-limits.ts:1-13`

**问题：**

- 设计文档 `:706` 仍写“硬上限的九个配置键”，代码实际是十个（`device.prefetch.cache.entries` 和 `device.prefetch.cache.bytes` 分成两项）。作者已说明这是已报告的文档问题。
- 计划 `:72` 说迁移新建 `devices` 表，实际迁移新建的是 `paired_devices`；同一行还提到 `test/integration/device-connection.test.ts`，当前不存在该文件。
- 设计 `:631` 的“不导出：设备公钥以外的任何凭据类数据”按字面可读成“设备公钥可以导出”，而作者约束和代码都是“公钥不导出”；建议澄清措辞。
- 设计 `:210-229` 的设备接口表没有列出本次新增的 `POST threads`、`GET threads/{id}/execution-stream`、`POST payloads/text`。如果这是实现补充，应在设计里补一条，否则后续客户端会按旧表实现。

**建议：** 这些不阻塞代码合并，但需要设计线程一次性修正，尤其是导出字段和新增路由，否则下一批客户端会按旧文档实现。

---

### 低 — 自动化检查有几个明显缺口

**文件：** `test/integration/device-api.test.ts:885-902`、`apps/agent-service/src/production-http-composition.ts:743-760`、`test/integration/data-export.test.ts:878-889`

**问题：**

- 请求体上限测试用的是 Fastify inject 生成的带 `Content-Length` 请求，没有覆盖 chunked/无长度；`/pair` 的配置上限也没有测试。
- 设备访问密钥“只从 `secretReferences` 成对读取”的生产接线没有被端到端测试覆盖：`startup-configuration.unit.test.ts` 只测配置解析，`device-api.test.ts` 的 `harness({ pairingAccess })` 直接注入值。删掉 `production-http-composition.ts` 里从 `secretReferences` 解析并传给 `buildHttpGatewayServer` 的代码，现有测试很可能仍全绿。
- 事件流“不丢不重”测试只等到第一帧出现，没有真正模拟断线重连和重复帧；标题与实际断言不完全匹配。
- 数据导出测试精确断言了不含 `lastSeenAt` 的对象，因此不会发现需求里漏掉的字段。

**建议：** 至少补 `/pair` 超限、无 `Content-Length` 超限、生产 composition 的 `pairingAccess` 接线、设备事件流重连/去重，以及 `lastSeenAt` 导出。测试是否真的会失败，本次没有运行测试（工具限制），以上结论来自读测试代码。

---

### 低（推测）— `/payloads/text` 没有总响应大小上限

**文件：** `packages/platform-node/src/device-api-routes.ts:454-484`、`packages/platform-node/src/browser-text-payload-reader.ts:11-52`

**问题：** 单次最多 100 个 ref，但每个 ref 的内容只受“单项”限制：文本 64 KiB，图片 1.5 MB（`IMAGE_PLAINTEXT_BYTES = 1_500_000`）。如果把 100 个图片 ref 放进一次请求，响应可能达到约 150 MB，且全部先构建在内存里的 `items` 对象中。这不属于请求体上限，已签名设备可以反复触发。

**证据：**

```ts
// device-api-routes.ts:467-483
if ((refs as string[]).length > DEVICE_PAYLOAD_TEXT_MAXIMUM_REFS) options.rejectBody(413);
...
for (const payloadRef of refs as string[]) {
  const payload = await readPayload({ authentication, payloadRef });
  items[payloadRef] = { text: payload.content, ... };
}
```

**建议：** 增加单次响应的总字节/总字符上限，或对图片和文本分别限制总大小。这里标记为推测，因为是否真的能拿到 100 个大图片 ref 取决于设备可访问的 payload 集合；但资源上限应由服务端强制，而不是靠 ref 数量间接限制。

---

### 低（推测）— `/payloads/text` 不检查 ref 是否属于设备可见的对话

**文件：** `packages/platform-node/src/device-api-routes.ts:454-484`、`packages/platform-node/src/browser-text-payload-reader.ts:26-41`

**问题：** 路由只按 `ownerId + agentId` 取 payload，没有检查该 ref 是否来自设备可以读取的对话。任何属于该主人/agent 的 text 或 image payload ref 都能读。设备本来就有主人身份，所以这不一定是越权；但如果设备 API 的边界应当是“只能看对话里出现过的内容”，那么这是一个缺口。

**证据：**

```ts
// browser-text-payload-reader.ts:35-41
const ownerId = createOwnerId(input.authentication.ownerId);
const agentId = createAgentId(input.agentId);
const payload = await this.#options.payloads(ownerId, agentId).get(input.payloadRef);
```

**建议：** 明确设备 API 的 payload 读取范围。若只允许读对话内容，应把 ref 与设备可访问的 thread/message 绑定检查；若允许读整个 owner/agent 的 payload，应在设计和测试里写明，并考虑聚合大小限制。

---

## 侧重检查

我重点查了以下路径：

- **错误路径和不可信输入**
  - 签名缺失、格式错误、参数错误、时间差、摘要不匹配、主机不匹配、未知密钥、签名无效：`device-request-signature.ts:211-303` 逐项检查；先校验 host、时间、摘要，再查密钥和验签。
  - 重放：`recordNonce` 在签名验证之后写库，重复 nonce 返回 401，满了返回 429（`sqlite-paired-device-operations.ts:270-294`）。
  - 路径白名单：`device-api-routes.ts:243-254` 使用 `DEVICE_ROUTE_PATTERNS`；`device.all("/")` 和 `device.all("/*")` 兜底（`:291-292`）。
  - 配对码错误/过期/已用/被替换：`paired-device-service.ts:180-189`、`sqlite-paired-device-operations.ts:103-143`。
  - 配对请求字段白名单、名字长度、公钥格式、相同公钥：`paired-device-service.ts:130-167`。
  - 管理路由多余字段：`device-api-routes.ts:603-625`；`emptyBody`/`deviceAction` 已覆盖。
  - payloads/text 的 ref 格式、重复、数量、不存在返回 null：`device-api-routes.ts:454-484`。

- **安全**
  - 主机名由签名里的 `@authority` 和 `publicOrigin.host` 校验（`device-request-signature.ts:217-218`）。
  - 查询参数、正文、内容类型和摘要都在签名覆盖范围内（`device-request-signature.ts:154-195`）。
  - 设备未确认、已吊销、主人停用、内部会话失效都有拒绝路径（`paired-device-service.ts:224-288`）。
  - 内部会话的 `recent_authenticated_at` 设为 1970，且认证上下文不带近期认证证据（`sqlite-paired-device-operations.ts:210`；`paired-device-service.ts:277-288`）。
  - 设备访问密钥成对校验：`strict-configuration.ts:1650-1660`；生产 composition 从 `secretReferences` 解析（`production-http-composition.ts:743-760`）。
  - 导出凭据排除：公钥、配对码哈希、nonce 都不在导出行里；反向测试存在。

- **资源耗尽**
  - 发现请求体上限只在解析后/按 `Content-Length` 检查，`/pair` 可绕过配置上限；见上面第一条。
  - `/payloads/text` 单项上限存在，但无总响应大小上限；见上面推测条目。
  - 非ce 表按设备计数、过期删除；未发现无界增长写入路径，但过期行只在下一次请求时清理。

- **不可撤销操作**
  - `revoke` 受 CSRF 和 `expectedRevision` 保护，但 UI 的“移除”是单击即时执行，没有额外确认步骤（`device-settings.tsx:176-178`、`:295`）。现有账户设备页的吊销也是单击模式（`account-login.tsx:290-292`），所以这不是本次新增的独有问题，但操作不可逆，建议至少加确认或可恢复提示。

- **规则、说明和代码一致性**
  - 已确认设计文档“九个配置键”与实际十个不符，作者已说明。
  - 计划仍写 `devices` 表和 `device-connection.test.ts`，与当前代码不符。
  - 设计导出段落没有明确列出 `lastSeenAt`，且“设备公钥以外”的措辞容易误解。
  - 设计设备接口表没有列出本次新增的三条路由。
  - 本次没有运行 `npm run check` 或任何测试，测试“会通过/会失败”的判断均来自读代码。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**结论：没有发现会改变已有对话请求开头的代码。**

- `git diff` 没有改动提示词目录、Pi 适配器、上下文组装或出口遮盖相关文件；改动集中在设备路由、配置、持久化和数据导出。
- 设备消息走的是现有 `thread.message.submit` 路径：`device-api-routes.ts:517-550` 构造命令后调用 `threadGateway.request`，没有另写一套提示词组装。
- 新建对话走现有 `thread.create`：`device-api-routes.ts:387-400`；只影响新对话的系统提示/语言冻结，不会改写已有对话的历史。
- 每条消息的 `occurredAt`、`messageId`、`contentRef` 等生成于追加时（`device-api-routes.ts:506-544`），不是写进系统提示或工具定义；历史仍然只在尾部追加。
- 事件流的 `device.scanned`、配对号、导出数据都不进入模型请求。

**未核实：** 没有运行端到端模型请求字节比对，也没有新增设备消息专用的 prompt-prefix 用例。严格说，这个改动不需要改提示词路径；如果复核要求“设备入口也有前缀稳定性的直接证据”，应补一条“设备消息 → 第二轮请求以前一轮请求开头”的集成测试。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**对模型请求：没有发现新增的非确定性。**

- 设备消息正文仍走现有的 `protectText`/出口遮盖；同一段文字在模型侧应是解密后的原文，具体提示词组装路径本次没有改动。
- `devicePairingNumber` 只由两把公钥决定，确定性；`stableSuffix` 由 `deviceId + messageId` 决定，确定性。
- `occurredAt`、`now()` 等时间值只用于新追加的消息/事件字段；同一条消息重放时由网关返回第一次结果，不会改写历史。
- 事件过滤只把未展示事件替换成 `device.scanned`，不影响模型。

**数据导出侧：** `safeString` 的 `[已扣留:n]` 编号依赖扫描顺序（`export.ts:145-154`）。同一份快照下顺序固定，但不同快照里同一设备名可能得到不同编号；这是现有导出机制，不是本次新增的模型问题。新增的设备名现在也参与这个机制。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，且覆盖面比上一轮明显更全，但有关键缺口：

- **签名/重放/改查询/改正文/换主机/时间差**：`test/integration/device-api.test.ts:245-290`、`test/integration/device-request-signature.test.ts:92-124` 都有反向断言；去掉对应检查时会失败。
- **路径白名单**：`device-api.test.ts:284-296` 断言 `/api/device/v1`、`/web-session`、`/rules` 返回 404 `DEVICE_PATH_NOT_ALLOWED`。
- **配对码过期/已用/替换/格式错误**：`device-api.test.ts:168-235`。
- **待确认、吊销、主人停用、近期认证**：`device-api.test.ts:337-380` 等。
- **nonce 存满、请求体超限**：`device-api.test.ts:382-411`、`:454-475`。
- **公钥规范化、同一把公钥拒绝**：`device-api.test.ts:820-850`。
- **配对号只在 pending 出现**：`device-api.test.ts:790-812`；测试向量 `971525` 在 `:770-785`，但本次没有运行，无法独立验证该向量。
- **事件过滤和游标**：`device-api.test.ts:558-610` 检查被过滤的 `thread.pin` 变成 `device.scanned` 且后续 cursor 仍在。
- **导出凭据不出现、导入不恢复设备、额外公钥被拒**：`data-export.test.ts:897-925`。
- **secretReferences 成对**：`startup-configuration.unit.test.ts:1870-1901`。

**缺口：**

- `/pair` 和 chunked 请求没有按 `device.request.body_bytes` 失败的反向用例。
- 生产 `pairingAccess` 从 `secretReferences` 到二维码的接线没有端到端用例；当前测试直接注入 `pairingAccess`，删掉生产接线不会红。
- 事件流“不丢不重”测试没有真正模拟断线重连和重复帧。
- 导出测试把“不含 `lastSeenAt`”写成了期望值，需求漏字段时不会失败。

### 4. 每个新增/修改的值，产生它的地方和使用它的地方都能接受吗？

我逐项核对了主要新增值：

| 值 | 产生方 | 使用方/校验方 | 结论 |
| --- | --- | --- | --- |
| `device.id` (`dev_` + 22 base64url) | `paired-device-service.ts:172` | 迁移 CHECK 长度 26/前缀 `dev_`、管理路由正则、导出 schema、签名 `keyid` 正则 | 一致 |
| `thread-device-<32 hex>` | `device-api-routes.ts:391` | 网关 `machineString`、设备路由路径正则、DB `threads.id` | 一致 |
| `webDeviceId` (`device:<32 hex>`) | `paired-device-service.ts:202` | `devices.id`、`product_sessions.device_id`、吊销查询 | 一致 |
| `webSessionId` (`session:<32 hex>`) | `paired-device-service.ts:203` | `product_sessions.id`、`createSessionId`、认证上下文、吊销查询 | 一致 |
| `authentication_ref` (`sha256:<64 hex>`) | `paired-device-service.ts:204` | SQLite 正则、唯一索引、`activeSession` | 一致 |
| nonce（16-64） | 客户端签名参数 | 签名解析正则、`device_request_nonces` CHECK、`recordNonce` | 一致 |
| pairing code（22 base64url） | `paired-device-service.ts:117` | 配对请求正则、SHA-256 哈希、DB 长度 64 | 一致 |
| pairing number（6 位） | `devicePairingNumber` | 网页显示、测试向量 | 代码两端一致；测试向量未运行核实 |
| 十个硬上限键 | `DEVICE_HARD_LIMIT_KEYS` | strict config、设备路由、控制中心 `DEVICE_LIMIT_KEYS` | 当前十个键一致，但控制中心是手写副本，没有自动检查防止以后漂移 |
| `pairedDevices` manifest 项 | `export.ts` / `schemas.ts` / `types.ts` | `verify.ts`、`import.ts`、`demo-pack.ts`、`check-data-export.mjs` | 计数和文件路径两端一致；但导出行本身缺 `lastSeenAt`，两端校验的是同一个不完整格式 |
| `pairedDevices.*` 操作前缀 | `durable-adapters.ts` | `sqlite-durable-operations.ts`、`sqlite-paired-device-operations.ts` | 一致 |

**结论：** 主要标识和配置键的两端校验基本一致；明确的问题是导出字段 `lastSeenAt` 缺失，以及配对码唯一性实际按 `owner + agent` 而不是作者说的“同一主人”。控制中心的上限键只是硬编码副本，未来新增键时容易重演 I-73 那类“清单项过不了另一端校验”的问题，建议让 UI 从共享常量生成或加一致性检查。

---

## 总体结论

没有发现高严重度问题。最值得先修的是：**设备请求体上限没有在读取阶段真正生效（尤其 `/pair`）**，以及**数据导出漏了作者承诺的 `lastSeenAt`**。其次是配对码作用域和文档/测试缺口。改为建议后，应补上 chunked/无内容长度、`/pair` 超限、生产 `secretReferences` 接线和 `lastSeenAt` 导出的反向用例。
