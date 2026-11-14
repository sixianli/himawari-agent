# PR 404 第 2 轮复核结论（截至 102f6248..b376f01 增量）

> 说明：以下只依据我亲自读到的代码与文档。工具已停止，未运行任何测试；凡涉及“反向用例是否真的会失败”，均为静态判断，标注为“未运行”。

## 一、读代码证实的问题（按严重度）

### 1.【中】设备接口文档的“能做什么”白名单与代码不一致，新增了表外路由

- 文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:210-231`、`packages/platform-node/src/device-api-routes.ts:35-46`
- 问题：设计文档明确写“设备能做的就是这张表”，但代码新增了白名单表外的路由。第 2 轮又新增了 `GET threads/{threadId}/runs/{runId}/execution`，文档没有同步。
- 证据：
  - 设计文档第 231 行：“设备能做的就是这张表，不是网页能做的全部。比如设备接口里没有‘改规则’‘删记忆’‘导出数据’”。
  - 代码：
    ```ts
    export const DEVICE_API_ROUTES = Object.freeze([
      { method: "POST", path: "pair", signed: false },
      ...
      { method: "POST", path: "threads", signed: true },
      { method: "GET", path: "threads/{threadId}", signed: true },
      { method: "GET", path: "threads/{threadId}/execution-stream", signed: true },
      { method: "GET", path: "threads/{threadId}/runs/{runId}/execution", signed: true },
      { method: "POST", path: "payloads/text", signed: true },
    ] as const);
    ```
  - 设计文档第 229 行的表只列了 `GET threads`、`GET threads/{id}`，没有 `POST threads`、`execution-stream`、`runs/{runId}/execution`、`payloads/text`。
- 建议：把新增路由写进设计/ADR，并写明它们属于设备白名单及其安全边界（尤其是 `/payloads/text` 能读取主人任意 payload 引用、`runs/{runId}/execution` 能读取运行过程正文）。否则“设备能做的只有这张表”这一安全陈述已经不成立。

### 2.【中】`payloads/text` 的“4 MiB 响应上限”不是真正的响应字节上限

- 文件：`packages/platform-node/src/device-api-routes.ts:511-516`
- 问题：上限按 `payload.content` 的 UTF-8 字节累计，且第一个 payload 无论多大都会被包含；同时没有计算 JSON 转义、键名和 `contentType` 的开销。作者说法 8/第 2 轮说法“一次响应正文总量 4 MiB”与代码不完全一致。
- 证据：
  ```ts
  const bytes = Buffer.byteLength(payload.content, "utf8");
  if (responseBytes > 0 && responseBytes + bytes > DEVICE_PAYLOAD_TEXT_RESPONSE_BYTES) {
    deferred.push(payloadRef);
    continue;
  }
  responseBytes += bytes;
  items[payloadRef] = { text: payload.content, ... };
  ```
  `responseBytes > 0` 意味着第一个 payload 不检查上限；JSON 序列化后的 `\"`、换行等会把 4 MiB 文本放大。
- 建议：按最终 `JSON.stringify` 后的字节数截断，或对单个 payload 也设上限并返回明确的“单条过大”；至少在文档里把“4 MiB”改成“文本内容合计 4 MiB，单条不保证”。

### 3.【低】配对码用掉后并不删除，和设计文档、表结构目录说明不一致

- 文件：`packages/persistence-sqlite/src/sqlite-paired-device-operations.ts:88-92,138-140`、`packages/persistence-sqlite/src/schema-catalog.ts:758-762`、设计文档第 165 行
- 问题：设计文档说“配对码只存哈希，用掉或过期就删那一行”；表结构目录写“removed after it expires or is used”；代码实际只在**下一次创建配对码**时删除过期/已用行，使用后保留 `used_at` 和 `device_id`。
- 证据：
  ```ts
  // createPairingCode
  `DELETE FROM device_pairing_codes
     WHERE expires_at <= ? OR used_at IS NOT NULL OR (owner_id = ? AND agent_id = ?)`
  ```
  ```ts
  // redeemPairingCode
  .prepare("UPDATE device_pairing_codes SET used_at = ?, device_id = ? WHERE code_hash = ?")
  ```
  表结构目录：`"removed after it expires or is used, and with Owner or Agent deletion"`。
- 影响：功能上“只能用一次”仍成立（`used_at` 检查在 `sqlite-paired-device-operations.ts:117-118`），但凭据哈希会多保留一段时间；文档和实现不一致。测试还依赖 `DEVICE_PAIRING_CODE_USED`（`device-api.test.ts:170-171`），如果按文档改成删除，返回值会变成 `DEVICE_PAIRING_CODE_INVALID`。
- 建议：二选一：①用后/过期删除，并把“已用”错误码改成无效；②保留当前行为，修改设计文档和表结构目录描述。

### 4.【低】事件流心跳复查没有核对内部会话的 owner

- 文件：`packages/platform-node/src/paired-device-service.ts:299-308`
- 问题：`authenticate` 在 `:282` 检查了 `session.ownerId !== current.ownerId`，但事件流心跳用的 `stillActive` 只检查 `session?.status === "active"`，没有核对 owner。
- 证据：
  ```ts
  async stillActive(deviceId: string): Promise<boolean> {
    const device = await this.#options.store.readDevice(deviceId);
    if (!device || device.status !== "active" || device.webSessionId === null) return false;
    ...
    const session = await this.#options.sessions.readSession(...);
    return session?.status === "active";
  }
  ```
  对比 `authenticate`：
  ```ts
  if (!session || session.status !== "active" || session.ownerId !== current.ownerId)
    throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED, 403);
  ```
- 影响：只有数据库被写坏或未来多人库接入时才会显现，当前单人路径风险低；但“吊销后流失效”的心跳复查应当和请求认证一样严格。
- 建议：在 `stillActive` 里增加 `session.ownerId === device.ownerId`。

### 5.【低】反泄漏测试覆盖范围小于说法 4 的“任何响应”

- 文件：`test/integration/device-api.test.ts:135-147,474-480`
- 问题：作者说法 4 是“内部会话的编号和 authentication_ref 不出现在任何响应里”，测试只检查了配对、确认、配置、设备列表、消息、对话列表；没有检查 `GET threads/{id}`、`GET runs/.../execution`、`/stream`、`/payloads/text`。
- 证据：
  ```ts
  const everything = [
    paired.response.body,
    JSON.stringify(confirmed.body),
    config.body,
    JSON.stringify(listed.body),
  ].join("\n");
  ...
  for (const body of [first.body, second.body, listed.body])
  ```
- 现状：我从代码看，`presentDevice`（`device-api-routes.ts:175-189`）和网关 `thread.command_result`（`product-thread-gateway-adapter.ts:245-255`）都没有返回内部会话字段，因此目前没有发现实际泄漏；但这不是被自动检查证实的。
- 建议：把反泄漏断言扩展到 `threads/{id}`、`runs/{runId}/execution`、事件流首帧和 `payloads/text` 响应。

### 6.【低】`GET /threads/execution-stream` 与合法 threadId 存在路由歧义

- 文件：`packages/platform-node/src/device-api-routes.ts:425-457`
- 问题：`device.get("/threads/*")` 用 `requestPath(request).endsWith("/execution-stream")` 判断是否为运行事件流。一个合法 threadId 恰好为 `execution-stream` 时，`GET /threads/execution-stream` 会被当成事件流，而不是线程详情。
- 证据：
  ```ts
  const threadId = threadIdOf(request);
  if (requestPath(request).endsWith("/execution-stream")) {
    if (!options.streamExecution) return options.rejectNotAllowed();
    ...
  }
  ```
  白名单里的 `threads/{threadId}` 也允许这个 threadId（`THREAD_ID_SEGMENT`，`:33`）。
- 影响：当前服务器生成的 threadId 是 `thread-device-...` 或 `thread:...`，不会命中；但接口本身允许外部传入该值。属于低概率歧义。
- 建议：按完整路径正则/路由段数判断，不要用后缀判断。

### 7.【低】`runs/{runId}/execution` 一次最多 200 条，记录字段又是 64 KiB 文本，最坏响应很大

- 文件：`packages/platform-node/src/device-api-routes.ts:472-477`、`packages/gateway-contracts/src/thread-contracts-v3.ts:555-607`
- 问题：设备路由请求 `limit: 200`，而 `threadExecutionRecordSchema` 的 `text/input/output` 每个上限 65 536 字符。最坏情况单次响应可达数十 MiB，和刚加的 4 MiB `payloads/text` 限制不一致。
- 证据：
  ```ts
  payload: {
    threadId,
    ...(runId === undefined ? {} : { runId }),
    afterSequence: Number(after),
    limit: 200,
  },
  ```
  ```ts
  const displayText: Schema<string> = {
    parse(value, path = "$") {
      if (typeof value !== "string" || value.length > 65536)
  ```
- 建议：和设备 `payloads/text` 一样按响应字节设上限，或降低 `limit` 并要求分页。

### 8.【低/信息】配对 URI 里的 `clientSecret` 被放进浏览器 DOM 属性

- 文件：`apps/control-center/src/components/device-settings.tsx:260-272`、`packages/platform-node/src/device-api-routes.ts:691-700`
- 问题：`pairingUri` 包含 `access.clientSecret`，页面通过 `data-pairing-uri={pairing.uri}` 把完整 URI 放进 DOM。虽然页面本身是主人已登录页面，QR 也本来就要展示该值，但 DOM 属性让任意同源脚本可直接读取，扩大了暴露面（测试也依赖这个属性）。
- 证据：
  ```tsx
  <svg
    className="device-pairing-code"
    role="img"
    aria-label={message("devices.qrLabel")}
    data-pairing-uri={pairing.uri}
  ```
  ```ts
  pairingUri: `himawari-pair:${Buffer.from(JSON.stringify({
    v: 1, origin: options.publicOrigin.origin, code: pairing.code,
    ...(options.pairingAccess ? { access: pairingAccessFields(options.pairingAccess) } : {}),
  })).toString("base64url")}`
  ```
- 建议：生产 DOM 不要暴露原始 URI；测试用单独的可注入钩子，或只在测试环境开启该属性。

## 二、推测 / 未核实

1. **`POST threads` 的 `answerLocale` 是否是 Apple 客户端会发送的字段，未核实。** 代码要求 `answerLocale` 必须是 `zh-CN`、`en`、`ja` 之一（`device-api-routes.ts:396-402`），作者说法 8 只提了 `requestId`。如果 Swift 客户端只发 `requestId`，所有设备建对话都会 400。
2. **公钥线上格式是否为 DER SPKI，未核实。** 服务端用 `SPKI_PATTERN` + `publicKeyFromSpkiBase64` 读取 DER SPKI（`paired-device-service.ts:157-168`、`device-request-signature.ts:203-208`）。若 Apple 侧发送原始 EC 点（65 字节 0x04 开头），配对会 400。设计文档只说“两把公钥”，没有写线上编码。
3. **`deferred` 字段对第 2 批 Apple 客户端的兼容性，未核实。** 这是新增响应字段，仓库里没有 Swift 客户端；网页不使用该路由。
4. **`payloads/text` 单个超大 payload 是否现实可构造，未核实。** 我确认了“第一个不限”这一逻辑，但未核实当前批次是否存在大于 4 MiB 的可读 payload。
5. **事件流过滤未包含 `thread.pin`、`thread.set_answer_locale` 是否会让设备界面状态过期，未核实。** 代码的 `DEVICE_THREAD_EVENT_TYPES` 这两项都没有（`device-api-routes.ts:59-72`），作者说法 7 的列表也没有，但设备界面是否显示置顶/语言状态未核实。
6. **反向用例是否真的会失败，未运行。** 以下是根据代码的判断：去掉 `preParsing` 后，`device-api.test.ts:993-1005` 的 `/pair` 8000 字节用例会从 413 变成 400，因此会失败；去掉 4 MiB 判断后，`device-api.test.ts:790-817` 的 `included.length * 64000 <= 4 MiB` 会失败；去掉改名同步后，`device-api.test.ts:971-986` 会失败。其余见下方 Q3。

## 三、侧重检查

### 错误路径
- 签名错误、时钟差、主机不符、路径/查询/正文改动：分别返回 `DEVICE_SIGNATURE_*` 401（`device-request-signature.ts:211-303`；测试 `device-request-signature.test.ts:92-124`）。
- 重放：`DEVICE_NONCE_REPLAYED` 401；nonce store 满：`DEVICE_NONCE_STORE_FULL` 429（`paired-device-service.ts:266-278`；测试 `device-api.test.ts:244-255,391-413`）。
- 配对码过期：410 且带 `pairingCodeTtlSeconds: 600`（`paired-device-service.ts:189-192`；测试 `device-api.test.ts:206-209`）。
- 请求体超限：声明长度在 `onRequest` 拒绝，未声明长度由 `preParsing` 流式拒绝（`device-api-routes.ts:248-276`；测试 `device-api.test.ts:991-1005`）。

### 不可信输入
- 配对码固定 22 字符、公钥先正则后 DER 解析/规范化、名称裁剪后 1..64、未知字段全拒（`paired-device-service.ts:140-173`）。
- 设备管理路由字段和 deviceId 格式严格校验（`device-api-routes.ts:656-669`）。
- `/messages`、`/threads`、`/payloads/text` 都拒绝未知字段；payload refs 校验去重且上限 100（`device-api-routes.ts:392-402,486-499,530-548`）。
- `items` 使用普通对象但 `MACHINE_STRING` 首字符不允许 `_`，所以 `__proto__` 这类键会被拒绝；未发现原型污染入口。

### 安全
- 签名覆盖 `@method @authority @path @query`，有正文时再覆盖 `content-digest`、`content-type`；签名通过后才写 nonce/载荷（`device-request-signature.ts:68-69,154-195,241-267`；`paired-device-service.ts:266-284`）。
- 内部会话 `recent_authenticated_at` 固定 1970，近期身份验证测试会拒绝（`sqlite-paired-device-operations.ts:19,196-211`；`device-api.test.ts:343-388`）。
- 吊销会同时吊销 `product_sessions` 和浏览器 `devices` 行，并删除 nonce（`sqlite-paired-device-operations.ts:243-272`）；事件流下一次心跳用 `stillActive` 复查（`device-api-routes.ts:448-450,627-630`）。
- 发现的问题见上文第 4 条（`stillActive` 未查 session owner）。

### 资源耗尽
- 正文硬上限 16 MiB（`device-limits.ts:33-40`），请求时按配置流式截断（`device-api-routes.ts:248-264`）。
- nonce 数量上限可配 100..1,000,000，满了 429（`device-limits.ts:105-112`；`paired-device-service.ts:273-278`）。
- `payloads/text` 的 4 MiB 不是严格上限（问题 2）。
- 执行过程接口单次最多 200 条、字段可到 64 KiB（问题 7）。

### 不可撤销操作
- 吊销没有二次确认：`device-settings.tsx:176-178` 直接 `onClick={onRevoke}`，`:295` 直接 `void act("revoke", device)`。作者说明这是和现有账户设备页一致的设计决定；若接受则无需改，若不接受则应加确认（吊销后设备必须重新配对）。

### 规则/文档一致性
- 设计文档设备接口表与代码不一致（问题 1）。
- 设计文档“配对码用掉或过期就删行”与实现不一致（问题 3）。
- 实施计划第 1 批任务 2 仍写“换网页会话的请求只用设备密钥签的被拒/确认密钥签的通过”，代码没有 `POST web-session`；作者已说明这是旧方案残留，但文档仍不一致。
- 未发现“不写代码注释”之外的新注释违规；新增业务代码我没有读到注释。

## 四、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**没有发现会改变请求开头的代码改动。** 本次 diff 的改动文件不包含 `packages/prompt-catalog`、`context-formation`、`thread-prompt-bundle` 或出口遮盖相关文件；设备路由只是调用现有的 `threadGateway`，新建对话/发消息都是新增数据：

- `device-api-routes.ts:404-421` 把 `thread.create` 交给现有网关；
- `device-api-routes.ts:561-589` 把设备消息作为 `thread.message.submit` 追加，`occurredAt`、`message:*`、`turn:*`、`run:*` 都在**新追加的这条消息/命令**里，不在系统提示或工具定义里；
- 没有任何代码把设备字段写进系统提示、工具定义或历史中间。

因此：静态核对结论是“仍然只在末尾追加，会变的值在最后一条消息”。**但设备路径的完整模型请求字节我没有跑端到端测试，标记未核实。**

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**模型可见文本方面没有发现新问题。** 理由：

- 设备消息正文先经现有 `protectText` 存为 payload（`device-api-routes.ts:550-554`），遮盖逻辑本身没有改。
- 同一 `messageId` 重发时，`stableSuffix(deviceId, messageId)` 固定（`:159-161`），`idempotencyKey`、`contentRef`、`messageId`、`turnId`、`runId` 都固定；网关的语义指纹不含 `occurredAt`（`thread-command-service.ts:232-238`），所以重发不会生成第二条消息，也不会让同一段已存文本变成不同字节。测试 `device-api.test.ts:484-515` 也覆盖了同 messageId 不同 revision 的重放与改正文 409。
- 每个请求新生成的 `occurredAt`、`generatedAt`、`lastSeenAt`、配对 URI 等会变，但它们要么属于新追加消息，要么不是模型输入（导出/管理响应/事件帧）。

**未核实**：端到端比较设备路径实际发给模型的原始字节；但从代码看没有新增“依赖后文遮盖”或“无序集合”的改动。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，覆盖如下（未运行，静态判断）：

- **preParsing 请求体上限**：`device-api.test.ts:991-1005`，无 Content-Length 的 `/pair` 8000 字节应 413；去掉 `preParsing` 会变成 400，会失败。
- **4 MiB deferral**：`device-api.test.ts:790-817`，70 个 64 KB payload；去掉上限后 included 会包含全部 70 个，`included.length * 64000 <= 4 MiB` 失败。
- **`runs/{runId}/execution`**：`device-api.test.ts:738-775` 覆盖正常读取、非法 `after` 400、缺失 run 404、非法路径 404。
- **改名同步浏览器设备行**：`device-api.test.ts:971-986`，去掉 `devices.label` 更新会失败。
- **配对码 TTL 详情**：`device-api.test.ts:206-209` 精确断言 `{ code: "DEVICE_PAIRING_CODE_EXPIRED", pairingCodeTtlSeconds: 600 }`。
- **导出 lastSeenAt**：`data-export.test.ts:878-890`，字段缺失或错误会失败。
- **设备访问密钥成对**：`production-http-composition.unit.test.ts` 的 `resolveDevicePairingAccess` 正反向；`startup-configuration.unit.test.ts` 的单声明/重复声明启动拒绝。
- **单配对码**：`device-api.test.ts:173-190`，用被替换的旧码应 404，能反向验证“同一主人只有一个有效配对码”。
- **签名负向**：`device-request-signature.test.ts:92-178` 覆盖改正文、改查询、换主机、改路径、时钟差、未知设备、错误密钥、缺签名、确认密钥。

**覆盖缺口（低）**：
- 没有测试“单个 payload 超过 4 MiB 时也 deferred”或 JSON 转义放大。
- 没有测试跨线程 `runId` 读取应 404/403（虽然 `thread-execution-projection.ts:145-152` 有校验）。
- 没有测试内部会话 id/authRef 不出现在 `threads/{id}`、`runs/.../execution`、事件流、`payloads/text`。
- 没有直接断言“签名失败时没有写 nonce/设备行”。
- 没有测试 `POST threads` 缺 `answerLocale` 的行为与 Apple 客户端契约是否一致。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

我逐项核对了主要值：

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| `dev_<22 字符>` | `paired-device-service.ts:178` `dev_${randomBytes(16).toString("base64url")}` | 迁移 `0093_paired_devices.sql:2` 要求长度 26/前缀 `dev_`；`device-request-signature.ts:70` `[A-Za-z0-9_-]{16,64}`；`device-api-routes.ts:663` `/^dev_[A-Za-z0-9_-]{22}$/`；导出 schema `schemas.ts:155` 同正则 | 接受，一致 |
| 浏览器设备 id `device:<32 hex>` | `paired-device-service.ts:210` | `devices` 表无格式约束（`0001_initial_product_schema.sql:102-111`）；只作为 `webDeviceId` 使用 | 接受 |
| 内部会话 id `session:<32 hex>` | `paired-device-service.ts:211` | `product_sessions` 表无格式约束；`createSessionId` 接受 machine identifier | 接受 |
| `authentication_ref` `sha256:<64 hex>` | `paired-device-service.ts:212` `sha256Ref` | `sqlite-paired-device-operations.ts:184` 校验 `/^sha256:[0-9a-f]{64}$/`；`product_sessions.authentication_ref` 无进一步格式限制 | 接受 |
| `runId` / `threadId` / `messageId` / `turnId` | `device-api-routes.ts:403,413,579-581`，由固定后缀派生 | 路由段正则 `device-api-routes.ts:33,51`；网关 `machineString`（`thread-contracts-v3.ts:133,144-147`）；执行读取 `thread-execution-projection.ts:145-152` 校验 run 属于 thread | 接受 |
| `pairingCodeTtlSeconds` | `paired-device-service.ts:190-191` | 错误处理 `http-gateway-server.ts:901-903` 原样展开；测试精确断言 | 接受 |
| `lastSeenAt` | `sqlite-paired-device-operations.ts:13-17,300-307`；导出 `export.ts:306` | 导出 schema `schemas.ts:163` 为 nullable timestamp；`verify.ts:111-119`；测试 878-890 | 接受 |
| `deferred: string[]` | `device-api-routes.ts:502,527` | 仓库内只有设备测试消费；网页客户端不调用该路由 | 仓库内接受；Apple 客户端未核实 |
| 设备访问密钥 purpose `device-access-client-id` / `-secret` | `strict-configuration.ts:1469-1472` | 配置校验 `:1652-1660` 要求成对且各最多一次；`resolveDevicePairingAccess` 读取 | 接受；但同一 `ref` 不同 `version` 分别用于两个 purpose 未被拒绝，属低风险配置歧义 |
| `DEVICE_PAYLOAD_TEXT_RESPONSE_BYTES = 4 MiB` | `device-api-routes.ts:57` | 只有 `:512` 和测试使用 | 值本身可接受，但语义不是严格响应上限（问题 2） |
| 事件类型清单 | `device-api-routes.ts:59-72` | `thread-contracts-v3.ts:20-33,83-96` 的命令/事件类型集合 | 匹配；`thread.pin`、`thread.set_answer_locale` 被有意排除，未在作者说法中列出 |
| 十条上限键 | `device-limits.ts:1-12`；UI 重复 `device-settings.tsx:9-20` | `parseDevice` `strict-configuration.ts:1311-1328`；`presentLimits`；UI `limitLabels` 用 `Record` 强制覆盖 | 接受；文档说“九个”已被作者标为待改 |

**结论**：未发现 id 格式两端校验不一致；发现的是文档/说明与代码不一致（问题 1、3）和 `payloads/text` 上限语义问题（问题 2）。`payloads/text` 的 `deferred`、`answerLocale`、公钥线上格式涉及 Apple 客户端，标未核实。

## 五、作者 13 条说法逐条核对（摘要）

1. **匹配**：白名单外路径由 `onRequest` 拒绝，返回 `DEVICE_PATH_NOT_ALLOWED` 404（`device-api-routes.ts:265-272`；测试 `device-api.test.ts:292-303`）。
2. **匹配**：重放、改查询、改正文、换主机名、时钟差均被拒；签名验证在 nonce/载荷写入之前（`device-request-signature.ts:211-303`；`paired-device-service.ts:266-284`）。
3. **匹配**：同 messageId 去重，改正文 409（`device-api.test.ts:438-515`）。
4. **基本匹配，但自动检查覆盖不全**：代码没有返回内部会话 id/authRef，测试只覆盖部分响应（问题 5）。
5. **匹配**：吊销后设备请求 403、内部会话 revoked、事件流下次心跳断（`sqlite-paired-device-operations.ts:243-272`；`device-api.test.ts:307-328,615-...`）。
6. **匹配**：导出查询不含公钥/配对码哈希/nonce，反向测试覆盖所有导出文件（`snapshot.ts:104-107`；`data-export.test.ts:898-927`）。
7. **匹配**：过滤事件发 `device.scanned` 并带 cursor（`http-gateway-server.ts:664-670`；`device-api.test.ts:566-613`）。
8. **匹配但文档缺失**：路由存在且都走 `authenticate`；`payloads/text` 的 `deferred` 是新增语义，且 4 MiB 上限不严格（问题 1、2）。
9. **匹配**：`devicePairingNumber` 实现与 971525 测试向量一致（`device-api-routes.ts:163-173`；`device-api.test.ts:860-869`）。
10. **匹配**：只从 `secretReferences` 的成对 purpose 读；配置拒绝单声明/重复声明；未发现写日志（`strict-configuration.ts:1652-1660`；`production-http-composition.ts:451-465`）。
11. **匹配**：先规范化 DER SPKI 再比较/存储，同一把密钥不同写法也拒绝（`paired-device-service.ts:93-95,157-173`；测试 `device-api.test.ts:908-936`）。
12. **匹配但文档有冲突**：“同一主人单一有效码”成立；`recent_authenticated_at=1970` 成立；但“用掉就删行”与实现不符（问题 3）。
13. **匹配**：请求体上限按 `device.request.body_bytes`，可到 16 MiB，`preParsing` 对无长度请求也生效；管理路由拒绝多余字段（`device-limits.ts:33-40`；`device-api-routes.ts:248-276,656-669`；测试 `device-api.test.ts:938-...` 和 `:991-1005`）。
