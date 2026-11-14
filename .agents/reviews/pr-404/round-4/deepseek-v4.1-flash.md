## 复核结论（按严重度）

### 中

**1. 网关实际安装了设备管理五个操作，但配置接口没有把它们列出来**
- 文件/行：`apps/agent-service/src/production-http-composition.ts:703`、`apps/agent-service/src/production-approval-gateway.ts:279`、`apps/agent-service/test/production-http-composition.unit.test.ts:356`
- 问题：`AgentGatewayV2Service` 的 `installedOperations` 已包含 `PRODUCTION_DEVICE_OPERATIONS`，但 `/api/control-center/v1/config` 返回的 `installedGatewayV2Operations` 只列到 `server.status.read`，没有 `device.list.read` 和四个设备命令。凡是按这个字段判断“该部署是否支持某操作”的客户端都会认为设备网关操作未安装；现有测试还把这份遗漏的清单写成了期望值。
- 证据：
  - `apps/agent-service/src/production-approval-gateway.ts:279`：`...(options.deviceControl ? PRODUCTION_DEVICE_OPERATIONS : []),`
  - `apps/agent-service/src/production-http-composition.ts:703-714`：清单里只有 approval/copy/memory/push/proactive/muse/observation/owner.preferences/sensitive/server.status，没有 device。
  - 测试 `production-http-composition.unit.test.ts:356-373` 的期望数组同样没有五个 `device.*`。
- 建议：在 `installedGatewayV2Operations` 中加入 `...(deviceControl ? PRODUCTION_DEVICE_OPERATIONS : [])`，并同步修改该测试的期望数组。这正是 I-73 那类“值在一端产生、另一端没接上”的问题。

**2. 五个设备命令绕过了命令回执/幂等机制，`idempotency-key` 实际不生效**
- 文件/行：`apps/agent-service/src/production-approval-gateway.ts:248`、`packages/application/src/services/governance-gateway-adapter.ts:77`、`:594`
- 问题：HTTP 层要求 `/api/gateway/v2/commands` 携带与消息一致的 `idempotency-key`，但 `GovernanceGatewayV2ControlPlane` 只对 `GOVERNANCE_COMMAND_TYPES` 做回执和重放；`device.*` 不在这个集合里，直接 `delegate.execute` 到 `ProductionDeviceControl`，`ProductionDeviceControl` 也从不读取 `idempotencyKey`。结果是：
  - `device.pairing.confirm`、`device.rename` 成功后重试同一个 key，会因为 `expectedRevision` 已变而返回 409，而不是返回第一次结果；
  - `device.pairing.start` 重试会重新创建配对码/延长过期时间，而不是重放首次结果；
  - 客户端网络重试可能看到“失败”，但服务端状态已经改变。
- 证据：
  - `governance-gateway-adapter.ts:595`：`if (!isGovernanceCommand(input.command)) return this.#dependencies.delegate.execute(input);`
  - `governance-gateway-adapter.ts:77-85` 的 `GOVERNANCE_COMMAND_TYPES` 只有 approval/grant/capability，没有 `device.*`。
  - `production-approval-gateway.ts:248-249`：设备命令被直接转给 `options.deviceControl.execute(authentication, command)`。
- 建议：把设备命令纳入回执/幂等路径，或在 `ProductionDeviceControl` 内按 `command.idempotencyKey` + 语义指纹实现重放；补一个“同一 idempotency-key 重试 confirm/rename/pairing.start”的测试。

### 低

**3. 设备名隐藏字符过滤漏掉了 U+061C 等方向/格式控制字符，和作者说法 18 不完全一致**
- 文件/行：`packages/gateway-contracts/src/contracts-v2.ts:548`
- 问题：作者说设备名会拒绝控制字符、方向控制字符和零宽字符，但 `isHiddenNameCharacter` 只覆盖 C0/C1、U+200B–200F、U+202A–202E、U+2060–2064、U+2066–2069、U+FEFF。U+061C（ARABIC LETTER MARK，属于双向控制字符）不在其中；U+2028/U+2029（行/段分隔符）、U+180E 等也不会被拒绝。名称里可放不可见的方向控制字符，存在 UI 文本重排/冒充风险。
- 证据：
  - `contracts-v2.ts:549-556`：`code < 0x20 || ... (code >= 0x202a && code <= 0x202e) || ...`
  - 测试 `test/integration/device-api.test.ts:1049-1061` 只覆盖了 U+200B、U+202E、U+0007、空白和超长。
- 建议：用 Unicode 属性转义覆盖 `\p{Cc}`、`\p{Cf}`、`\p{Zl}`、`\p{Zp}`，或补齐 U+061C、U+2028/2029、U+180E 等范围；同时在剪除首尾空白后检查。并补相应反向用例。

**4. 作者说法 17“access 只出现在 device.list.snapshot”被代码否定：REST 配对接口也把 access 放进 pairingUri**
- 文件/行：`packages/platform-node/src/device-api-routes.ts:694`
- 问题：REST `/api/devices/v1/pairing-codes` 返回的 `pairingUri` 里显式嵌入 `access`。这是符合作者说法 10 的设计（二维码需要此凭据），但与说法 17“只出现在 device.list.snapshot 里”矛盾。新增泄漏测试只扫描命令响应、回调、stdout/stderr、数据库，并且没有用配置了 access 的场景调用这个 REST 接口，所以测试不能证明该说法。
- 证据：
  - `device-api-routes.ts:699-702`：`access: pairingAccessFields(options.pairingAccess)`
  - `test/integration/device-api.test.ts:902-918` 明确断言 access 会出现在 pairing code 里。
- 建议：把说法 17 改成“只出现在 `device.list.snapshot` 和配对二维码所在的两个 owner-only 响应里”，或明确限定“网关响应”；同时让泄漏测试覆盖所有合法的暴露面，而不是只覆盖命令响应。

**5. 推测：access 的秘密值长度没有按合约上限校验**
- 文件/行：`packages/gateway-contracts/src/contracts-v2.ts:584`、`apps/agent-service/src/production-http-composition.ts:458`
- 问题：合约把 `clientId`、`clientSecret` 限制为 `boundedString(256)`，但 `resolveDevicePairingAccess` 直接返回 provider secret 的任意字符串，启动时不检查长度。若实际 secret 超过 256 字符，`device.list.snapshot` 将不符合合约；由于服务端输出没有做合约校验，客户端严格解析时会失败。
- 证据：`const accessText = boundedString(256);`；`resolveDevicePairingAccess` 只做 `find` 和 `resolve`，没有长度校验。
- 建议：启动时校验两个 access 值长度不超过合约上限（并补一个边界测试）。这一条是推测，未核实真实 provider secret 长度。

**6. 文档与实现不一致：配对码“用掉或过期就删”没有照做；硬上限“九个键”实际是十个**
- 文件/行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:165`、`:706`；`packages/persistence-sqlite/src/sqlite-paired-device-operations.ts:125`、`:153`
- 问题：
  - 设计说配对码“用掉或过期就删那一行”，实现会保留已用行以支持“同 key 重试返回同一设备”（`schema-catalog` 也明确写了保留），两者不一致。功能上可解释，但文档应更新。
  - 设计写“硬上限的九个配置键”，代码 `DEVICE_HARD_LIMIT_KEYS` 实际是十个；作者已承认这是文档问题。
- 证据：
  - `sqlite-paired-device-operations.ts:125-131` 对已用码返回 `replayed` 而不是删除；`:153-155` 只写 `used_at`，不删行。
  - `docs/.../design.md:706`：“硬上限的九个配置键”。
- 建议：修正设计文档；若保留已用配对码，明确其保留时间和用途。

## 侧重检查

我按额外侧重检查了以下路径：

- **错误路径**：非法配对码、非法 kind/releaseChannel、重复字段、未知路径、pending/revoked/inactive owner、签名缺失/格式错、时钟偏差、nonce 重放、nonce 存满、正文超限、payload ref 过多、未知 thread/run。相关代码与测试在 `device-api-routes.ts`、`paired-device-service.ts`、`device-request-signature.ts`、`test/integration/device-api.test.ts` 中；错误码和 HTTP 状态基本成对。
- **不可信输入**：`/pair` 只接受对象和固定字段；JSON 路由检查 `application/json`；公钥要求 P-256 DER SPKI 并重新规范化；配对码要求 22 位规范 base64url；设备名有长度和隐藏字符检查（但有上面的 U+061C 缺口）；payload refs 有格式、去重和 100 条上限。
- **安全**：签名覆盖 method/authority/path/query/body digest/content-type；验签在写库（`recordNonce`）之前；重放、改查询、改正文、换主机名、时钟偏差都有用例；吊销检查同时覆盖设备、内部会话和事件流心跳。设备内部会话的 `recent_authenticated_at` 为 1970，且测试确认过不了近期认证。
- **资源耗尽**：nonce 上限、正文上限、100 个 payload ref、payload 响应大小限制都有实现；发现 `payloads/text` 的响应大小检查是 `responseBytes > 0 && ...`，第一项不受 4 MiB 限制（见 `device-api-routes.ts:519`）。当前 `BrowserTextPayloadReader` 单项最大 1.5 MB，所以暂不可触发；若将来替换读取端口，这个上限会失守。
- **不可撤销操作**：吊销会把 `paired_devices`、内部 `product_sessions`、浏览器 `devices` 行一起置为 revoked，并删除 nonce；事件流在下一次心跳断开。设备管理命令没有近期认证要求，但 Web 管理路由同样没有，属于设计现状而非本轮断言。
- **文档/实现一致性**：除上面第 4–6 条外，迁移编号 0093→0094、`SUPPORTED_SCHEMA_MAX=94`、数据导出新增 `paired-devices.jsonl` 并明确不导出公钥/配对码/随机值，均与作者说明一致。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
没有发现设备相关改动改变系统提示、工具定义、历史消息或遮盖结果。设备消息走的是现有 `thread.message.submit`，只向对话末尾追加一条用户消息；`occurredAt`、查询用 `messageId` 等会变的值属于请求元数据或新追加的消息，不在系统提示/工具定义/历史开头。
但本轮合并进来的 main 自带的 `prompt-catalog`/工具变更我未逐项核对，按题目说明不算本轮范围。测试未执行，以上是静态代码结论。

**2. 同一段文字会不会在不同请求里变成不同字节？**
模型可见路径未发现这种情况。设备消息的 `contentRef`、`messageId`、`turnId`、`runId` 由 `stableSuffix(deviceId, messageId)` 决定；线程消息的语义指纹只取 `threadId/messageId/contentRef` 等，不包含会变的 `occurredAt`（`thread-command-service.ts:232-238`），所以同一 messageId 的重试不会因为时间不同而变成另一条消息。设备 API 响应里的 `generatedAt`、查询 messageId 确实每次不同，但它们不是模型请求内容。设备列表顺序由 `ORDER BY paired_at DESC, id` 固定，limits 也按固定清单顺序输出。

**3. 有没有对应的自动检查，反向用例会失败吗？**
有：
- `test/integration/device-api.test.ts` 覆盖重放、改正文、改查询、换主机、时钟偏差、路径白名单、吊销、nonce 存满、正文上限、消息去重、事件过滤、断线续传、payload 批量读取、隐藏字符等。
- `test/integration/device-request-signature.test.ts`、`test/integration/data-export.test.ts`、`test/integration/device-settings-browser.test.ts` 覆盖签名、导出和网页设置。
- `packages/gateway-contracts/test/device-gateway.contract.test.ts` 覆盖配对码规范、设备 id、负修订、名称、多余字段、limits 和 snapshot。
- 新增的 `production-http-composition.unit.test.ts` 覆盖网关设备管理全流程和 access 泄漏扫描。

但这些反向用例有两个明显缺口：一是没有“同一 idempotency-key 重试设备命令”的测试，因而第 2 条问题不会被发现；二是隐藏字符只测了少量样本，U+061C 等不会被测出；access 泄漏测试也没有覆盖 REST pairing-codes。并且我**没有运行测试**（工具限制），所以“去掉守卫是否真的失败”只能确认断言存在，不能确认真实执行结果。

**4. 每个新产生的值，每个使用它的地方都能接受吗？**
逐个核对后：
- `DEVICE_LIMIT_KEYS` / `DEVICE_HARD_LIMIT_KEYS` / 控制中心的同一清单：10 个键一致；设计文档写“九个”是文档错误。
- `dev_` + 22 位 base64url：服务端生成、合约 `deviceIdSchema`、数据库 `length=26 AND substr(id,1,4)='dev_'` 一致。
- 配对码：合约和服务端都要求 22 位规范 base64url（最后一位 `[AQgw]`），存储 SHA-256；一致。
- kind / releaseChannel / status：application 常量、合约枚举、数据库 CHECK、导出 schema 一致。
- 设备名：合约、REST pair/rename、网关 rename 用同一个 `normalizeDeviceName`；数据库限制 1–64；长度和首尾空白一致，但隐藏字符过滤有缺口。
- 配对核对数字：6 位十进制，合约和 UI 都按 6 位接受，测试向量 971525 通过。
- `readOpenPairingCode.expiresAt`：SQLite 返回 ISO 字符串，服务层和合约 timestamp 均可接受。
- 设备五个操作：`installedOperations` 接受了，但 `installedGatewayV2Operations` 没有接受，导致配置接口与实际安装不一致（第 1 条）。
- access 的 secret：`device.list.snapshot` 和 REST `pairingUri` 都接受；合约的 256 字符上限在启动时未校验（推测风险，第 5 条）。
- `payloads/text` 的 4 MiB 响应上限：第一项不受限制；当前单项最大 1.5 MB，暂不可触发。
