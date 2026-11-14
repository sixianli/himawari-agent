## 侧重检查

- **未确认的“改”请求**：`dispatchDeviceGatewayRequest` 在写审计和 `forward` 之前先判断 `tier === "change" && !confirmed`，符合作者说法（`packages/platform-node/src/device-gateway.ts:142-146`）。
- **挑战值**：HMAC 绑定 `deviceId`，校验过期时间；一次性靠 `device_request_nonces` 主键；SQLite `INSERT ... ON CONFLICT DO NOTHING` 保证并发只成功一个（`packages/platform-node/src/paired-device-service.ts:281-313`、`:345-373`；`packages/persistence-sqlite/src/sqlite-paired-device-operations.ts:319-336`）。
- **不可信输入**：`BODY_KEYS` 顶层白名单、`SERVER_FILLED_PAYLOAD_KEYS` 只允许 `"device"`、`object()` 拒绝未知字段、`not_on_phone` 在分类阶段直接 403（`packages/platform-node/src/device-gateway.ts:81-127`、`packages/gateway-contracts/src/validation.ts:161-191`）。
- **资源耗尽**：设备路由统一 `bodyLimit` 和 `preParsing` 计数；nonce 表有上限；但每个 tighten/change 会写审计，且 `proactive.pause` 的畸形正文会先记 `accepted` 再因 schema 失败记 `failed`（见下方第 5 条）。
- **不可撤销操作**：`thread.delete_permanently`、`login.device.revoke`、`login.devices.revoke_others`、`data.export.start`、`muse.data.clear`、`sensitive.interceptions.clear`、`workspace.*`/`host.*`/`delegation.*` 的档位与“手机上不做”/“改”基本合理；`memory.external.respond` 的 `reject` 只把待定提案标为拒绝，不删除已有记忆（`production-mcp-memory-writer.ts:387-411`、`:514-517`），算收紧成立。
- **文档/清单一致性**：发现 `proactive.pause` 的 pending 说明与页面表不一致（见第 4 条）；Swift 生成文件缺少 `JSONValue`（见第 2 条）。
- **未核实**：没有实际运行测试或编译 Swift；没有逐行追踪整个 prompt 组装路径；没有逐一核对所有 `GATEWAY_V2_MESSAGE_TYPES` 的下游授权策略，只核对了安装清单和处理分支。

## 意见

### 1. 高：生产装配漏传 `ownerSubject`，确认过的“改”在需要近期验证时会失败

- 文件:行：`apps/agent-service/src/production-http-composition.ts:1207-1218`、`packages/platform-node/src/paired-device-service.ts:388-411`、`packages/platform-node/src/device-gateway.ts:130-136`、`test/fixtures/device-api-harness.ts:297-300`。
- 问题：`PairedDeviceService` 只有在 `ownerSubject` 返回非空 `externalSubjectRef` 时才创建 `recentAuthenticationEvidence`；生产装配没有传 `ownerSubject`，所以确认签名永远不会生成近期验证凭据。`withServerFilledReferences` 随后把 `recentAuthenticationRef` 填成 `null`，导致所有依赖近期验证的“改”命令在真实生产不可用。
- 证据（读代码证实）：
  - `const externalSubjectRef = verified.confirmed ? await this.#options.ownerSubject?.(...) : undefined;`
  - `recentAuthenticationEvidence: Object.freeze({ source: "device_confirmation_key", externalSubjectRef, ... })`
  - 生产构造只有 `store`、`sessions`、`configuration`、`ownerActive`、`now`、`onWarning`，没有 `ownerSubject`。
  - 测试夹具额外补了 `ownerSubject: async (scope) => (await identityState.readByOwner(ownerId))?.externalSubjectRef`。
- 影响（按代码路径推断）：`thread.delete_permanently` 的 `recentAuthenticationRef: machineString` 会因 `null` 直接 400（`packages/gateway-contracts/src/thread-contracts-v3.ts:245`）；`login.device.revoke`、`login.devices.revoke_others`、`proactive.observation.start`、需要近期验证的审批会因 `expectedAuthenticationRef === null` 被 `RecentAuthenticationGuard` 拒绝（`production-login-devices-control.ts:105-107`、`:149-151`；`production-approval-gateway.ts:257-262`；`governance-gateway-adapter.ts:781-786`）。因此作者“确认签名算近期身份验证”的说法在生产的默认装配下不成立。
- 建议：在生产 `PairedDeviceService` 构造中补 `ownerSubject`（从 `identityState.readByOwner` 取 `externalSubjectRef`）；增加一条使用真实生产装配（而不是测试夹具）的集成用例，确认“确认过的永久删除/登录设备撤销”能成功；若确实只允许某些身份配置支持该功能，应在代码和 PR 说明中明确写清。

### 2. 高：生成的 Swift 引用了仓库里不存在的 `JSONValue`，HimawariManage 目标无法编译

- 文件:行：`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:28`、`:32-37`、`:50-57`；`clients/apple/Package.swift:28`；`test/tooling/client-parity.test.ts:214-231`。
- 问题：生成代码使用 `JSONValue`、`payload.keys`、`payload.flags(ignoring:)`，但仓库里没有 `JSONValue` 的定义或扩展；`HimawariManage` 目标会包含这个文件。
- 证据（读代码证实）：`func accepts(_ payload: JSONValue) -> Bool`、`Set(tightenOpenKeys).isSubset(of: payload.keys)`、`let flags = payload.flags(ignoring: tightenOpenKeys)`；全仓搜索 `JSONValue` 只命中这个生成文件，没有声明；`Package.swift` 把 `HimawariManage` 列为 macOS/iOS 目标。
- 影响（推断）：在 Apple 平台构建时会报 “cannot find type 'JSONValue' in scope”。Linux CI 把 `interfaceTargets` 设为空（`Package.swift:21-23`），而 `check:client-parity` 只做字符串比对，不编译 Swift，所以这道检查不会失败。
- 建议：把 `JSONValue` 及 `keys`/`flags` 扩展放到手写支撑文件并由生成文件 import，或在本 PR 一并生成；在 macOS 上增加 `swift build`/Swift 单元测试步骤；如果确实要等客户端 PR 提供该类型，应在 PR 说明里写清“本提交单独合并会破坏 Apple 构建”。

### 3. 中：Swift 的 `requiredTier`/`accepts` 没有行为测试，且 `tightenEveryItem` 的不变量检查有缺口

- 文件:行：`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:28-38`、`:50-58`；`test/tooling/client-parity.test.ts:214-231`；`packages/gateway-contracts/test/client-capabilities.contract.test.ts:48-57`。
- 问题：生成器把 `ClientItemTighten.accepts` 的实现手写进模板，TS 的 `everyItemTightens` 是另一份实现；`check:client-parity` 只比对生成文本，没有执行 Swift 规则。另有一条测试只检查 `entry.tightenPayload`，没有检查 `entry.tightenEveryItem`。
- 证据（读代码证实）：
  - Swift：`guard case .object(let fields) = payload, fields.count == 1, case .array(let items)? = fields[key], !items.isEmpty else { return false }`
  - TS：`if (keys.length !== 1 || keys[0] !== rule.key || !Array.isArray(items) || items.length === 0) return false;`
  - 契约测试：`if (entry.tightenPayload) { expect(entry.kind).toBe("command"); expect(entry.tier).toBe("change"); }`，没有对 `tightenEveryItem` 做同样断言。
- 影响（推断）：如果以后有人只改 TS 的收紧规则，Swift 仍会生成旧逻辑而检查照样通过；如果新增一个 `tightenEveryItem` 条目但 tier/kind 写错，当前测试也不会失败。作者“两边用同一条规则”的保证目前只是文本生成，不是行为一致。
- 建议：增加跨语言测试向量（同一组 payload 同时喂给 TS 和 Swift，断言 tier 相同），或至少给 Swift 补一个针对 `memory.external.respond` 的单元测试；把 `tightenEveryItem` 纳入“只有命令、且基础档是 change”的断言；补一条“修改 `everyItemTightens` 实现但不改生成器时测试必须失败”的反向用例。

### 4. 低：`proactive.pause` 已登记为手机收紧类型，但页面表里没有对应原生页，pending 说明与页面表不一致

- 文件:行：`packages/gateway-contracts/src/client-capabilities.ts:134`、`:370`；`ci/operations-pending.json:28`；`test/tooling/client-parity.test.ts:193-212`。
- 问题：pending 说明写“调用方是 iPhone 原生 App 的设置页”，但 `CLIENT_PAGE_TABLE` 里唯一的 `settings` 页是 `notOnPhone`，也没有任何页面映射到“主动提醒设置”；能力表允许这种“有手机可用类型、无页面归属”的状态，测试不会报错。
- 证据（读代码证实）：`{ webPage: "settings", notOnPhone: WEB_CONTRACT_MISSING }`；`tighten("v2", "proactive.pause")`；页面测试只检查“每个原生页至少对上一种类型”，不检查“每个非 `not_on_phone` 类型至少属于一个原生页”。
- 影响（推断）：客户端 PR 接上调用方后，如果忘了补页面表和生成 Swift，`check:client-parity` 仍然通过；这也让“每个值的使用处”无法从清单上核对。
- 建议：等客户端 PR 落地时补 `ClientPageEntry`（或给 `proactive.pause` 增加“服务器/未来客户端专用”的显式标记）；把页面测试扩展为双向：每个 `tier !== "not_on_phone"` 的类型都必须能追溯到一个原生页或显式的 server-only 说明。

### 5. 低：`proactive.pause` 等永远收紧的命令会先写 `accepted` 审计，再因正文校验失败写 `failed`

- 文件:行：`packages/platform-node/src/device-gateway.ts:148-160`、`packages/gateway-contracts/src/client-capabilities.ts:320-328`、`packages/gateway-contracts/src/contracts-v2.ts:981-983`。
- 问题：`proactive.pause` 没有 `tightenPayload`/`tightenEveryItem`，`requiredClientTier` 对任意 payload 都返回基础档 `tighten`；分类发生在 `schema.parse` 之前，所以携带多余字段的请求会先写一条 `accepted` 审计，再在转发时失败并写 `failed`。
- 证据（读代码证实）：`return entry.tier;`；`await record("accepted");` 在 `try { result = await forward(input); }` 之前；`proactivePauseCommandSchema` 的 `payload: object({})` 会拒绝多余字段。
- 影响（推断）：这不构成越权（最终仍失败），但会让审计账本被畸形请求污染，并增加写放大；nonce 上限能限制单设备速率，不能完全消除。
- 建议：对 `entry.tier === "tighten"` 且没有动态规则的命令，先做一次与最终 schema 等价的轻量正文检查再写 `accepted`；或把 `accepted` 审计改到 schema 校验通过之后、真正调用处理程序之前。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个 diff 没有修改系统提示、工具定义、历史消息或遮盖路径；设备网关只转发控制命令，`thread.message.submit` 和 `thread.message.submit_configured` 都被标成 `not_on_phone`（`client-capabilities.ts:113`、`:229-230`），手机上发消息仍走原来的 `/messages`。新增的 `proactive.pause` 是控制命令，不进入模型上下文。唯一相关的是 `thread.set_answer_locale` 被登记为日常，它按现有 ADR 0165 的规则可能触发一次合法的对话头换新，但这不是本改动偷偷改历史。结论：发给模型的内容仍然只在末尾追加，每轮会变的值没有从最后一条消息挪到别处。**未核实**：没有逐行追踪整个 prompt 组装实现，只确认 diff 未触及相关文件。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会影响模型可见文字。挑战值和审计时间/随机 UUID 只出现在挑战响应和审计表；`withServerFilledReferences` 用当前会话的 `authenticationRef`，在同一会话内稳定；设备文本上传的 `protectText` 幂等键由设备编号加客户端键确定；能力表和生成的 Swift 顺序都由固定数组决定，不依赖无序集合遍历。**未核实**：没有检查 `authenticationRef` 轮换是否会导致同一历史文本在不同会话中产生不同字节，但该值只用于控制字段，不进模型正文。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   部分有：TS 侧 `requiredClientTier` 的收紧规则有完整反向用例（keep、改写、缺键、多键、空数组、非数组、多余顶层键都会落到 `change`），能力表与合约双向一致、`not_on_phone` 不写审计、挑战值跨设备/过期/重放/并发都有集成用例。但有三处反向用例不会失败：
   - Swift 只做文本生成比对，不编译也不执行，`JSONValue` 缺失和 `accepts` 逻辑错误都不会被发现；
   - 生产装配漏 `ownerSubject` 没有被测试覆盖，因为集成夹具额外补了该回调；
   - 契约测试没有对 `tightenEveryItem` 做“必须是命令且基础档为 change”的断言。
   所以第 1、2、3 条意见目前都没有能挡住它们的自动检查。

4. **每个新值/修改值，产生处和使用处两端都能接受吗？**
   - `proactive.pause`：合约、`PRODUCTION_PROACTIVE_OPERATIONS`、能力表、Swift、fixture、operations-pending 都已登记；`ProductionProactive.execute` 有处理分支，安装清单会把它加进 v2 网关，后端校验和调用端一致。**但**没有页面/caller（见第 4 条）。
   - `setEnabled`：端口、SQLite 适配器、`SqliteProactiveOperations` 分支、`ProductionProactive` 使用处都齐全，`ProactiveStorePort` 只有这一份实现，类型检查能覆盖。
   - `device_confirmation_key`：`RecentAuthenticationGuard.validSource` 接受它，但生产端的产生处（`PairedDeviceService` 的 `recentAuthenticationEvidence`）因为没有 `ownerSubject` 永远不会发出这个值，使用端会一直报 `evidence_missing`（见第 1 条）。
   - `authorizationRef`/`recentAuthenticationRef` 占位 `"device"`：服务端分类要求只有 `"device"`，转发时替换；Swift 生成常量与 `SERVER_FILLED_PAYLOAD_KEYS` 一致。两端一致。
   - 审计 `action`/`outcome`：`AuditLedgerPort` 接受 `accepted`/`completed`/`failed`，`device.gateway.*` 没有别的白名单限制，两端一致。
   - `PLAIN_TEXT_MAXIMUM_CHARACTERS`：网页文本入口和设备 `payloads/text/new` 共用同一常量，值仍是 `64 * 1024`，两端一致。
   - Swift `JSONValue`：使用端存在，产生端不存在，直接编译失败（第 2 条）。
   - `risk`/`dataClassification`：由设备在 v2 正文里自报，服务端不按能力档重新推导；目前只进入治理幂等指纹（`governance-gateway-adapter.ts:711-721`），没有发现用于授权判断，因此暂不构成越权，但设备的标签不可信这一点应在客户端接入时明确。
