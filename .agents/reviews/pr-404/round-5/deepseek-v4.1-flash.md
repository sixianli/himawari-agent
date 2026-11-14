## 复核范围

复核了 `git diff 12ce0d0a..9e8b9918 -- apps packages test`，并重点看了 `git diff 644486e6e..9e8b9918` 的增量。只读代码，没有改文件，也没有运行测试；凡是没读到的标「未核实」。

结论：**未发现高严重度问题**；中低严重度问题集中在跨界面状态同步、两个端点的校验不一致，以及重放/资源上限。

---

## 读代码证实的问题

### [中] 从账户设备页吊销内部浏览器设备行，不会同步吊销 `paired_devices`
- 文件：`packages/platform-node/src/built-in-identity-routes.ts:150-175`、`packages/persistence-sqlite/src/sqlite-durable-operations.ts:5008-5032`、`packages/persistence-sqlite/src/sqlite-paired-device-operations.ts:272-299`
- 问题：确认设备时会插入一行 `devices`（浏览器设备）。`/api/identity/v1/devices` 会把它列出来，用户在账户设备页可以吊销它。但该吊销只更新 `devices` 和 `product_sessions`，没有更新 `paired_devices`。结果是：设备已经不能验签（内部会话被吊销），但“设备”设置页仍显示 `active`，`paired_devices.status` 也没有变成 `revoked`，两边状态分叉。
- 证据：
  - `built-in-identity-routes.ts:150-160`
    ```ts
    const devices = await options.state.listDevices(createOwnerId(auth.ownerId), false);
    return { devices: devices.map(({ id, label, lastSeenAt }) => ({ id, label, lastSeenAt, current: id === auth.deviceId })) };
    ```
  - `sqlite-durable-operations.ts:5020-5031`
    ```sql
    UPDATE devices SET revision = revision + 1, status = 'revoked', last_seen_at = ? WHERE id = ? ...
    UPDATE product_sessions SET revision = revision + 1, status = 'revoked', revoked_at = ? WHERE device_id = ? AND status = 'active'
    ```
  - 反向的 `sqlite-paired-device-operations.ts:272-299` 才会更新 `paired_devices`。
- 建议：要么在 `/api/identity/v1/devices` 中隐藏这种内部行，要么让 `revokeProductDevice` 同时吊销对应的 `paired_devices` 行并递增修订号；补一条“账户设备页吊销后，设备设置页也显示 revoked”的集成测试。

### [中] access 启动校验与网关合约不一致：没有拒绝控制字符
- 文件：`apps/agent-service/src/production-http-composition.ts:478-480`、`packages/gateway-contracts/src/contracts-v2.ts:574-575`、`packages/gateway-contracts/src/validation.ts:89-102`
- 问题：启动时只检查 `value.length === 0 || value.length > 256`，但网关合约的 `accessText = boundedString(256)` 还会拒绝 `< 0x20` 和 `0x7f` 的控制字符。一个带换行等控制字符的 secret 能通过启动，却会在消费 `device.list.snapshot` 的客户端合约校验时失败。这正是 I-73 所说的“只在一端认”。
- 证据：
  ```ts
  for (const value of [clientId, clientSecret])
    if (value.length === 0 || value.length > DEVICE_ACCESS_TEXT_MAX_LENGTH)
      compositionError(...SECRET_MATERIAL_INVALID);
  ```
  ```ts
  type check: [...input].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })
  ```
- 建议：直接用 `deviceAccessSchema` 或同一套 `boundedString` 逻辑校验 access 值；补一个含 `"\n"` 的反向用例。

### [低] `device.pairing.start` 重发不是幂等的：`resultRef` 和有效期都会变
- 文件：`apps/agent-service/src/production-device-control.ts:136-141`、`packages/platform-node/src/paired-device-service.ts:129-146`、`packages/persistence-sqlite/src/sqlite-paired-device-operations.ts:88-101`
- 问题：同一个 `pairingCode` 重发时，`startPairingWithCode` 会以当前时间重新插入，`expiresAt` 重新计算，`resultRef: device-pairing:${expiresAt}` 随之变化，并且总是 `replayed:false`。作者说法 21「重试返回的 resultRef 和第一次相同」只对 `#change` 的 confirm/rename/revoke 成立，对 `device.pairing.start` 不成立。
- 证据：
  ```ts
  const expiresAt = new Date(now.getTime() + PAIRING_CODE_LIFETIME_MILLISECONDS).toISOString();
  await this.#options.store.createPairingCode({ ... codeHash, now: now.toISOString(), expiresAt });
  return Object.freeze({ code, expiresAt });
  ```
  `createPairingCode` 中先 `DELETE ... used_at IS NOT NULL ...` 再插入。
- 建议：对同一个 code 保留首次 `expiresAt` 并返回同一结果，或明确把幂等承诺限定为三个管理命令。

### [低] 已用配对码在设备吊销后重放仍返回 200/replayed
- 文件：`packages/persistence-sqlite/src/sqlite-paired-device-operations.ts:125-131`
- 问题：`usedAt !== null` 分支只比较两把公钥，没有检查设备状态。设备被吊销后，用原配对码和原公钥重放仍会得到 `{kind:"replayed", device: revokedDevice}`，HTTP 200。设备仍是 revoked，不会因此获得权限，但客户端会误以为配对成功。
- 证据：
  ```ts
  if (code.usedAt !== null) {
    const redeemed = code.deviceId ? this.readDevice(code.deviceId) : undefined;
    return redeemed &&
      redeemed.devicePublicKey === input.device.devicePublicKey &&
      redeemed.confirmPublicKey === input.device.confirmPublicKey
      ? { kind: "replayed", device: redeemed }
      : { kind: "code_used" };
  }
  ```
- 建议：设备 `status === "revoked"` 时返回 `code_used`/410/403，并补反向测试。

### [低] 硬上限键清单在三处重复，没有一致性守卫
- 文件：`packages/application/src/ports/device-limits.ts:1-12`、`packages/gateway-contracts/src/contracts-v2.ts:510-521`、`apps/control-center/src/components/device-settings.tsx:11-22`
- 问题：三份 `DEVICE_*_LIMIT_KEYS` 目前内容一致，但没有测试或生成器保证它们一致。将来只改一处时，`device.list.snapshot` 合约会拒绝新增键，或控制中心 `limitLabels[limit.key]` 变成 `undefined`。这是典型的 I-73 风险。
- 建议：由一份清单生成另外两份，或加一个单元测试断言三份数组完全相等。

### [低] 设计要求 nonce 满时“同时记一条告警”，代码只返回 429
- 文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:585`、`packages/platform-node/src/paired-device-service.ts:298-300`
- 问题：设计写的是「拒绝这台设备的新请求，直到旧的过期；同时记一条告警」，但 `NONCE_STORE_FULL` 分支只有抛错，没有日志或告警。
- 建议：在返回 429 的同时写一条稳定错误码的告警日志（不要带 nonce 原值）。

### [低] 文档与代码措辞不一致
- 文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:631`、`packages/persistence-sqlite/src/schema-catalog.ts:783`、`packages/persistence-sqlite/src/sqlite-paired-device-operations.ts:91-92`
- 问题：
  - 设计文档「不导出：设备公钥以外的任何凭据类数据」容易被读成“公钥可以导出”，但代码和作者说法都是公钥也不导出。
  - `schema-catalog` 说配对码「kept after use so a retried pairing request gets the same device」，但 `createPairingCode` 会删除所有 `used_at IS NOT NULL` 的行；同一 owner 启动新配对后，旧码的重试会变成 `code_invalid` 而不是 `replayed`。
- 建议：把公钥是否导出写清楚；把“启动新配对会清掉旧的已用码”写进说明，或把删除范围收窄并保留可重试窗口。

---

## 推测 / 未核实

### [低/推测] 设备事件流没有每设备并发上限
- 文件：`packages/platform-node/src/device-api-routes.ts:622-640`、`packages/platform-node/src/paired-device-service.ts:289-297`
- 问题：`device.nonce.retained` 默认 10000，一台持有有效密钥的设备可以开大量 SSE 连接；每个连接最长 `connectionMaxSeconds`（默认 3600 秒），并且会按心跳轮询数据库。代码里没有看到每设备或全局流数量上限。是否被 Fastify/OS 的连接上限兜住未核实。
- 建议：给每设备/每 owner 加并发流上限或速率限制，并补资源耗尽测试。

### 未核实
- 没有运行测试，无法证明“去掉守卫后必失败”的变异测试效果。
- 没有实际观察模型请求字节；设备消息路径的 prompt 渲染和分类合并没有逐字节验证。
- `dataClassification: "private"` 硬编码是否会改变已有敏感会话的提示分类、从而触发提示头换新，没有读完上下文形成逻辑。
- 设计文档中「九个配置键」与代码十个键的差异，作者已承认是文档问题；未再展开。

---

## 侧重检查

我按额外侧重检查了这些路径：

- **错误路径**：错误配对码（404/409/410）、畸形配对体（400）、过期/已用码、未知设备、签名缺失/损坏、时钟偏差、改正文/查询/主机、未知路径、pending/revoked/owner inactive、nonce 重放/存满、正文超限、管理路由多余字段、无效 `after`、未知 thread/run。大多有测试；发现“已用码在吊销后重放 200”和“pairing.start 重发 resultRef 变化”。
- **不合规范/不可信输入**：JSON 类型与大小、SPKI 格式与 P-256 规范化、nonce/deviceId 正则、RFC 9421 组件与参数、查询/路径白名单、payload ref 去重与上限、管理路由字段白名单。发现 access 值未按合约拒绝控制字符。
- **安全**：验签覆盖方法/主机/路径/查询/正文摘要/正文类型；先验签后写 nonce；密钥规范化为 DER SPKI；同一把设备/确认密钥被拒；access 不进普通配置、测试断言不进日志/数据库；设备 internal session 不带 `recentAuthenticationEvidence`；吊销后请求、内部会话、事件流失效。未发现越权路径。
- **资源耗尽**：正文上限、nonce 每设备上限、SSE 最长寿命都有；但没看到每设备并发流上限。
- **不可撤销操作**：吊销（有 `expectedRevision`，无 un-revoke）、配对码替换（旧码被删）、导入不恢复设备。发现账户设备页吊销与设备页状态不同步。
- **规则/文档一致性**：检查了 prompt-prefix 规则、I-73、设计文档、schema-catalog。发现公钥导出措辞和已用配对码保留说明不一致；九个/十个配置键差异已知。

---

## 作者说法逐条核对

| 说法 | 结论 |
|---|---|
| 1. 白名单外 `/api/device/v1/` 返回 404 `DEVICE_PATH_NOT_ALLOWED` | ✅ 代码有 `onRequest` 正则白名单 + `device.all("/")`/`device.all("/*")` 兜底；测试覆盖。 |
| 2. 重放/改查询/改正文/换主机/时间差过大拒绝，验签在任何写库前 | ✅ `verifyDeviceRequest` 先校验，`recordNonce` 在之后；测试覆盖。`/pair` 本身无签名，是设计如此。 |
| 3. 同 messageId 重复只进对话一次 | ✅ `stableSuffix(deviceId,messageId)` 生成稳定 idempotency key；测试覆盖同 thread 重发和改正文 409。 |
| 4. internal session id/authRef 不出现在响应；设备会话过不了本人审批 | ✅ 响应不含；`authentication` 不设 `recentAuthenticationEvidence`，`RecentAuthenticationGuard` 会以 `evidence_missing` 拒绝。 |
| 5. 吊销后请求、内部会话、已开流失效 | ✅ `revokeDevice` 更新 paired_devices/product_sessions/devices，流在 revalidate 时断开；测试覆盖。**但账户设备页反向吊销不更新 paired_devices（见问题 1）。** |
| 6. 导出不含公钥、配对码哈希、nonce | ✅ 导出字段不含；反向测试遍历所有导出文件断言不出现。 |
| 7. 事件流只发列出的对话事件，其余发 `device.scanned` 带 cursor | ✅ `include` 过滤 + `device.scanned`；测试覆盖 `thread.pin` 被跳过且 cursor 不丢。 |
| 8. 新增 threads/payloads/execution-stream 路由 | ✅ 路由存在且都走签名/设备状态检查。 |
| 9. 配对数字公式与 971525 向量 | ✅ 公式一致，测试断言 `971525`。 |
| 10. access 只从成对 secretReferences 读，不进配置/日志；单个或重复声明启动被拒 | ✅ 成对检查在 `parseProductConfiguration`；测试覆盖单声明/重复声明。**但启动长度校验漏了控制字符（见问题 2）。** |
| 11. 两把公钥规范化 DER SPKI，同一把（不同写法）拒绝 | ✅ `canonicalSpki` + 原始/规范化两次相等检查；测试覆盖。 |
| 12. 同一主人只有一个有效配对码；internal session `recent_authenticated_at` 为 1970 | ✅ 启动新码会删除该 owner 的旧码；插入 epoch；测试覆盖。**已用码会被新配对删除，影响重试语义（见文档问题）。** |
| 13. 设备正文上限可配到 16 MiB；管理路由拒绝多余字段 | ✅ 路由 bodyLimit 用最大常量、preParsing 用配置；测试覆盖 chunked 超限和管理字段白名单。 |
| 20. 重试只认修订号正好 +1，且状态/名字匹配 | ✅ 代码字面满足。**边界情况**：如果 +1 是另一个操作（如 confirm/rename）造成，而目标状态/名字恰好已满足，也会返回 `replayed:true`；结果等价，但不是严格“本次命令已执行”。 |
| 21. 重试返回的 resultRef 和第一次相同 | ⚠️ 对 `#change` 的 confirm/rename/revoke 成立；`device.pairing.start` 重发会生成新 `expiresAt`，resultRef 不同；且若中间有别的修订变化，`#change` 会抛冲突而不是重放。 |
| 22. 设备名规则在合约、REST 配对、REST 改名、网关改名四处同一函数 | ✅ 四处最终都走 `normalizeDeviceName`/`deviceNameSchema`。`sqlite-paired-device-operations.renameDevice` 另有一份较弱的 trim/长度检查，但不是绕过路径。 |

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**从代码路径看不会。** 设备消息走现有 `thread.message.submit`，只是追加一条 owner 消息；`occurredAt`、`messageId`、`sessionId` 等都在新命令/新消息里，不在系统提示或工具定义里。`POST /threads` 只新建对话，`answerLocale` 在创建时确定，没有设备侧 `set_answer_locale` 路径。没有代码去改已有历史或冻结的提示头。

但有两个保留：
- 没有设备路径的 prompt-prefix/KV 缓存测试；现有 `check:prompt-prefix` 是否覆盖这条新路由未核实，我也没有运行。
- 设备消息硬编码 `dataClassification: "private"`；它是否会把已有敏感会话的分类拉低并触发提示头换新，我没有读完上下文形成逻辑，标「未核实」。如果会拉低，就违反规则第 6 条（分类变低会换新）的代价，需要另行确认。

### 2. 同一段文字会不会在不同请求里变成不同字节？
**从代码看没有新增这种路径。**
- 设备文本走同一 `protectText` 和出口遮盖，没有依赖后文的遮盖逻辑。
- 同 messageId 重发会命中同一 idempotency key，不会产生第二条消息。
- 设备列表按 `paired_at, id` 排序，上限列表用固定键顺序，配对数字只依赖两把公钥。
- `now()` 出现在协议层 `messageId`、`generatedAt`、`lastSeenAt`、`occurredAt` 等位置，不是系统提示/工具定义，或位于最后追加的消息里。

保留：没有实际抓取模型请求字节验证；设备路径没有专门的确定性测试。

### 3. 有没有对应的自动检查，反向用例真的会失败？
有自动检查：
- `test/integration/device-api.test.ts`：配对、pending/active、重放、改查询/正文/主机、时间差、白名单、吊销、事件过滤、threads/messages/payloads、内部 session 泄漏、name 隐藏字符、正文上限。
- `test/integration/device-request-signature.test.ts`：RFC 9421 验签、确认密钥、P-256。
- `apps/agent-service/test/production-http-composition.unit.test.ts`：`#change` 重试、access 长度、网关五个操作。
- `packages/platform-node/test/startup-configuration.unit.test.ts`：access 成对/单声明/重复声明。
- `test/integration/data-export.test.ts`：设备导出字段和凭据不导出。
- `test/integration/device-settings-browser.test.ts`：设备设置页。

反向用例大多是有效的：例如 access 空/257 会 reject、隐藏字符改名返回 400、`otherName.statusCode` 不为 200、`revokedStale` 不为 200。但我**没有运行测试**，无法证明“去掉守卫后一定失败”的变异效果。

测试缺口：
- access 值含控制字符的反向用例没有。
- 账户设备页吊销内部行后，设备设置页状态的用例没有。
- 已用配对码在设备吊销后重放的用例没有。
- `device.pairing.start` 重发 resultRef 稳定性的用例没有。
- 硬上限键三处一致性的检查没有。
- SSE 并发上限没有测试。

### 4. 每个新值/改动值的产生端和使用端都接受吗？
逐项核对如下：

| 值 | 产生端 | 使用/校验端 | 结论 |
|---|---|---|---|
| `deviceId` | `dev_` + 16 字节 base64url（22 字符） | 网关 `deviceIdSchema`、REST `deviceAction`、迁移 `length=26/substr=dev_`、导出 schema | 接受；迁移只校验长度/前缀，但生成值合法 |
| 配对码 | 16 字节 base64url（22 字符，末位 `A/Q/g/w`） | `startPairingWithCode`、网关 `devicePairingCodeSchema`、`pair` 的 22 字符正则、`code_hash` 64 hex | 接受；`pair` 未校验末位，但只用于 hash 查找 |
| 配对数字 | `SHA-256("himawari-pairing-v1"‖两把 DER 公钥)` 前 4 字节 % 1e6，补零 6 位 | 网关 `^[0-9]{6}$`、控制中心显示 | 接受，测试向量 971525 |
| `resultRef` | `device:${id}:${revision}` / `device-pairing:${expiresAt}` | 网关命令结果（`machineString` 允许 `._:-`）、控制中心不解析 | 接受；`pairing.start` 重发会变化 |
| `replayed` | `#change` | 网关命令结果；测试断言 | 接受 |
| access `clientId/clientSecret` | `secretReferences` 解析 | 启动长度校验 + 网关 `boundedString(256)` | **长度接受，但控制字符不接受（问题 2）** |
| 硬上限键 | application `DEVICE_HARD_LIMIT_KEYS` | 网关 `DEVICE_LIMIT_KEYS`、控制中心 `DEVICE_LIMIT_KEYS` | 当前一致；无一致性守卫（问题 5） |
| 设备名 | `normalizeDeviceName` | SQLite `length 1..64`、导出 `text(1,256)`、网关 `deviceNameSchema` | 接受；隐藏字符只在合约层，DB 较弱但服务层已拦 |
| `webDeviceId/webSessionId` | `device:`/`session:` + 32 hex | `devices.id`/`product_sessions.id`、身份路由 | 接受；但账户设备页反向吊销不同步（问题 1） |
| `nonce` | 验签器 16–64 字符 | `device_request_nonces` 长度 16–64、`recordNonce` | 接受 |
| 导出设备字段 | export.ts 的 id/kind/name/releaseChannel/status/时间 | `PAIRED_DEVICE_SCHEMA` | 接受；导入不恢复设备 |
| 迁移号 `0094` | migration-engine | 迁移文件列表 | 接受，没有重复序号 |
| `installedDeviceApi` | `http-gateway-server.ts:1008` | `apps/control-center/src/app.tsx` 设置页门禁、`gateway-client.ts` 解析 | 接受 |
| `installedGatewayV2Operations` 五个 `device.*` | `production-http-composition.ts` routeOptions | 控制中心 inventory、单测断言 | 接受 |

总体：没有发现“产生端接受、消费端必然拒绝”的硬错误；最接近的是 access 控制字符（问题 2）和硬上限键三处重复（问题 5）。
