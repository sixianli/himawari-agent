本次 `d5ef8994..b4db24ac` 的 diff 混有两类内容：PR 503 的 iOS 第 11 批，以及从 main 合入的 PR 455 回退（删除 proactive source registry 等）。下面以 PR 503 为主；涉及回退的风险单列并标注未核实。

### 1. 高 本事页停用能力时没有发送 recentAuthenticationRef，服务端必然拒绝
文件:行
`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:55-66`、`clients/apple/Sources/HimawariManage/Gateway/ManageGateway.swift:98-104`、`packages/gateway-contracts/src/contracts-v2.ts:2683-2691`、`packages/platform-node/src/device-gateway.ts:125-138`、`packages/gateway-contracts/src/validation.ts:181-185`

问题
`capability.disable` 的 payload 只发了 `capabilityRef`、`expectedRevision`、`reasonCode`，没有 `recentAuthenticationRef`。客户端的 `withPlaceholders` 只替换“已经存在”的键，不会补键；服务端 `withServerFilledReferences` 也只在键存在时才填值；而契约的 `object` 要求每个字段都必须出现。因此该请求会在契约校验时报 `missing required field`，即使侥幸通过也会因 `recentAuthenticationRef` 为空被 `RECENT_AUTH_REQUIRED` 拒绝。本事页的“停用”开关实际上无法成功。

证据
- `SettingsStore.swift:57-65` 的 payload 只有三项，没有 `recentAuthenticationRef`。
- `ManageGateway.swift:100-103`：`for key in ClientCapabilities.serverFilledReferences where fields[key] != nil { fields[key] = ... }`，键不存在就跳过。
- `contracts-v2.ts:2685-2690`：`payload: object({ capabilityRef, expectedRevision, reasonCode, recentAuthenticationRef: nullable(machineString) })`。
- `validation.ts:181-182`：`if (!Object.hasOwn(record, key)) fail(... "missing required field")`。
- `SettingsStoreTests.swift:108-120` 只用假传输并只断言三个字段，所以去掉 `recentAuthenticationRef` 这个测试仍然通过。

读代码证实：这是当前代码路径。
推测：服务端可能返回 500/400 或 `RECENT_AUTH_REQUIRED`，取决于契约错误在路由层的包装，但不会成功停用。

建议
在 `SettingsStore.disable` 中加入 `recentAuthenticationRef: .string(ClientCapabilities.referencePlaceholder)`，或让 `withPlaceholders` 对所有服务端填充键统一补 `device`。同时增加一条让 Swift 组装出的请求真正经过 `CLIENT_GATEWAY_SCHEMAS` 的测试；现有假传输测试无法发现这类缺字段问题（见意见 6）。

### 2. 中 真实传输层丢弃服务端 reasonCode，“退出其他浏览器”的忙状态永远不会被识别
文件:行
`clients/apple/Sources/HimawariManage/Gateway/DeviceTransport.swift:48-51`、`clients/apple/Sources/HimawariCore/DeviceAPIClient.swift:20-31,226-238`、`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:92-108`

问题
`SettingsStore.signOutOthers` 用 `.rejected(409, _, "LOGIN_DEVICES_STILL_CHANGING")` 识别服务端的忙状态，但真实的 `SignedDeviceTransport` 在收到 `DeviceAPIError.server` 时只构造了 `["error": ["code": ...]]`，把 `reasonCode` 丢了。`DeviceAPIClient` 的错误体也根本没有解码 `reasonCode`。结果生产路径上 409 只会被当成普通失败，`AccountPages` 显示“没办成，再试一次”，而不是“有别的设备正在登录或退出，过一会儿再试”。测试用的是直接返回 `reasonCode` 的 `ConflictTransport`，没有覆盖真实 `SignedDeviceTransport`。

证据
- `DeviceTransport.swift:49-50`：`let failure = ["error": ["code": code ?? ""]]`，没有 `reasonCode`。
- `DeviceAPIClient.swift:226-238`：`ErrorBody.Inner` 只有 `code`、`serverTime`、`pairingCodeTtlSeconds`；`DeviceAPIError` 也没有 `reasonCode`。
- `SettingsStoreTests.swift:265-279` 的 `ConflictTransport` 直接返回 `{"code":"PORT_CONFLICT","reasonCode":"LOGIN_DEVICES_STILL_CHANGING"}`，绕过了真实传输层。

读代码证实：真实生产路径确实拿不到 reasonCode。
建议
在 `DeviceAPIError.server`、`ErrorBody` 和 `SignedDeviceTransport` 中保留并转发 `reasonCode`，并加一条经过真实 `SignedDeviceTransport` 的 409 用例。

### 3. 中 “收紧”类操作没有一次性挑战值，也没有过面容，与材料里的约束不一致
文件:行
`clients/apple/Sources/HimawariManage/Gateway/ManageGateway.swift:64-67`、`packages/platform-node/src/device-gateway.ts:154-155`、`packages/platform-node/test/device-gateway.unit.test.ts:60-62`

问题
材料写的是“改和收紧要带一次性挑战值并过面容”，但客户端的 `command` 把 `.read, .routine, .tighten` 放在同一分支，直接 `nonce: nil, confirm: nil`；服务端 `dispatchDeviceGatewayRequest` 也只在 `tier === "change"` 时要求 `confirmed`。因此能力表里所有 `tighten` 操作（例如 `proactive.pause`、`muse.intake.set` 的暂停、`memory.settings.set` 的暂停、拒绝外部记忆）都不会取挑战值、不会过面容。当前本事页只调用 `capability.disable`（change），所以这条不是立刻可见的功能失败，但通用执行器已经把“收紧”的口子留开了。

证据
- `ManageGateway.swift:64-66`：`case .read, .routine, .tighten: return try await send(... nonce: nil, confirm: nil)`。
- `device-gateway.ts:154-155`：`if (input.request.tier === "change" && !input.confirmed ...) throw ... CONFIRM_REQUIRED`。
- `device-gateway.unit.test.ts:55-62` 用 `proactive.pause`、`confirmed: false` 仍期望成功，说明服务端测试也按“tighten 不需要确认”写。

读代码证实：代码行为如此。
推测/需确认：如果材料里的“改和收紧”是最终规则，这就是一个安全边界缺口；如果服务端能力表是有意把“纯收紧”定义为不需要面容，则材料需要改成“改要面容，收紧不要”，并明确哪些操作属于收紧。

建议
先确认规则归属：要么把 `.tighten` 也走挑战值和确认签名，要么更新材料并补一条明确的“收紧不需要面容”的规则说明；同时给通用执行器加覆盖每个 tier 的测试，避免以后接新操作时默认落在错误分支。

### 4. 中 记忆改写把正文按 private 上传，丢了原记忆的数据分级
文件:行
`clients/apple/Sources/HimawariManage/Memory/MemoryStore.swift:46-61`、`clients/apple/Sources/HimawariManage/Gateway/ManageGateway.swift:80-90`、`clients/apple/Sources/HimawariManage/Memory/MemoryModels.swift:18-30`、`packages/gateway-contracts/src/contracts-v2.ts:2029-2050`、`apps/control-center/src/memory.ts:356-362`、`packages/persistence-sqlite/src/data-export/export.ts:154-159`

问题
iOS 的 `correct` 调用 `gateway.uploadText(text)`，而 `uploadText` 的 `dataClassification` 默认是 `"private"`。Swift 的 `MemoryItem` 没有解码 `dataClassification`，所以客户端没有保留原记忆的分级。网页端 `correct` 明确传的是 `item.dataClassification`。服务端记忆记录本身在 `DurableMemoryService.correct` 里只替换 `contentRef` 等字段，不重置记录上的 `dataClassification`，但新正文 payload 的 classification 已经变成 private；导出时 `exportedText` 用的正是 payload 的分类。

证据
- `MemoryStore.swift:47`：`let contentRef = try await gateway.uploadText(text)`，没有分类参数。
- `ManageGateway.swift:80`：`uploadText(_ content: String, dataClassification: String = "private")`。
- `MemoryModels.swift:18-30` 的 `MemoryItem` 没有 `dataClassification` 字段，而 `contracts-v2.ts:2034` 的 snapshot 是有的。
- `apps/control-center/src/memory.ts:361`：`contentRef: await client.protectText(text, item.dataClassification)`。
- `data-export/export.ts:157-159`：导出正文的 `classification` 取自 `payload.dataClassification`。

读代码证实：iOS 上传的正文分类固定为 private，网页端不是。
推测/未核实：内存记录仍保留原来的 sensitive 分级，模型检索也可能仍按记录分级过滤；但导出正文的分级、以及任何按 payload 分类决定可见性的读取方会看到错误的分类。是否造成实际越权需要继续核对所有读取 contentRef 的地方。

建议
让 `MemoryItem` 解码 `dataClassification`，`MemoryStore.correct` 把它传给 `uploadText`；更稳妥的是服务端在 `memory.mutate` 的 correct 分支沿用当前记忆的分级，不信任客户端传来的 payload 分类。补一条“修改 sensitive 记忆后正文 payload 仍为 sensitive”的测试。

### 5. 中（前提未核实）diff 删除了一条已存在的迁移文件，可能让已应用该迁移的数据库拒绝启动
文件:行
删除的 `packages/persistence-sqlite/src/migrations/20261114172143_proactive_source_registry.sql`、`packages/persistence-sqlite/src/schema-catalog.ts:999` 附近删除 `proactive_source_settings`；`packages/persistence-sqlite/src/migration-engine.ts:981-987`

问题
本次 diff 范围内（来自 main 的 PR 455 回退）删除了 `20261114172143_proactive_source_registry.sql` 和 schema catalog 里的 `proactive_source_settings`。迁移引擎对“数据库里已应用、但当前定义里找不到”的迁移会抛 `UNKNOWN_APPLIED_MIGRATION`。如果任何开发、测试或生产数据库已经应用过这条迁移，升级到这个提交后会直接启动失败。

证据
- `migration-engine.ts:981-987`：`const definition = definitions.get(record.id); if (!definition) throw ... UNKNOWN_APPLIED_MIGRATION`。
- diff 里该迁移文件和对应 `proactive_source_settings` 目录项都被删除。

读代码证实：删除迁移文件会被迁移引擎视为未知的已应用迁移。
未核实：该迁移是否已在任何环境应用；如果只是未上线的 PR 回退，删除可能是安全的。

建议
确认 PR 455 的这条迁移从未在任何长期数据库上应用；如果已经应用，改用一条新的正向迁移回退，不要直接删除历史迁移文件。

### 6. 低 新的 Swift 调用方检查只看字面量，也没有让 Swift 请求真正过网关契约
文件:行
`scripts/check-operations.mjs:80-90,323-329`、`test/tooling/operations-check.test.mjs:113-140`

问题
`frontendSends` 的规则是：只要 Swift 源文件里出现 `"operation.name"` 字面量，且前面不是 `message(` 或 `messageId:`，就算有调用方。它识别不了“这个字面量只是出现在 switch、注释外的数组或错误提示里”的假调用。新增测试只验证了 `Generated/` 和 `ManageDemo.swift` 被排除，没有验证“非发送位置的字面量不应算调用方”。更关键的是，`check:operations` 只证明有调用方，不证明请求 payload 能通过网关契约，所以意见 1 的缺字段不会被它拦住。

证据
- `check-operations.mjs:86-88`：`if (!...message... && !messageId...) return true;`，任何其他出现都算调用。
- `check-operations.mjs:323-329`：把 Swift 源文件加入 frontend 文本。
- `test/tooling/operations-check.test.mjs:113-140`：只有生成文件和 Demo 文件的反向用例。

读代码证实：检查逻辑如此。
推测：未来可能在非发送位置留下字面量而误判“已接上”，也可能出现调用方存在但 payload 不合契约的漏检。

建议
增加一个测试入口，把 Swift 侧构造的代表性请求（至少每个 change 操作）序列化后交给 `CLIENT_GATEWAY_SCHEMAS[v2].schema.parse`；反向用例应覆盖“缺 `recentAuthenticationRef` 必须失败”。如果保持字面量扫描，至少再加“只出现字面量但不是 `gateway.read/command` 参数”的反向用例。

### 7. 低 设计文档和操作账本说明已与代码不一致
文件:行
`docs/execution/specs/2026-11-11-apple-device-body-design.md:232`、`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:132,156,163,168`、`ci/operations-pending.json:21`、`scripts/check-operations.mjs:323-329`

问题
设计文档仍写着“设备接口里没有‘改规则’‘删记忆’‘导出数据’，这些只在嵌入的网页里做，走网页会话”；但能力表已经把 `memory.create`、`memory.mutate`、`data.export.start`、`capability.disable` 等登记为手机可用的 v2 命令，PR 503 也直接通过设备网关调用它们。另一方面 `ci/operations-pending.json:21` 还写着“检查只扫网页和脚本，所以留在名单里直到检查也扫 clients/apple”，但本次已经让检查扫描 Swift。

证据
- 设计文档第 232 行原文。
- `ClientCapabilities.swift:132`（`memory.create`）、`:156`（`data.export.start`）、`:163`（`memory.mutate`）、`:168`（`capability.disable`）。
- `operations-pending.json:21` 的 proactive.pause 理由与 `check-operations.mjs:323-329` 矛盾。

读代码证实：文档/账本说明与当前代码不一致。
建议
更新设备接口范围和待办理由；如果设备网关允许这些操作是有意扩大范围，在设计文档里明确“原生管理页 + 设备签名 + change 级面容”这一新边界。

### 8. 低 作者说所有数值取自 DesignTokens/Layout，但 MemoryRootView 仍有硬编码
文件:行
`clients/apple/Sources/HimawariManage/MemoryRootView.swift:46,52,62,191,222`

问题
新页面主体仍在用裸数字：`VStack(spacing: 20)`、`.padding(.top, 14)`、`.padding(.top, 10)`、分组间距 `24`、行内间距 `4`。这与“所有数值取自 HimawariDesign 的 DesignTokens 和 Layout”不符，也给设计线程后续统一调整留下漏网点。

证据
- `MemoryRootView.swift:46`：`VStack(alignment: .leading, spacing: 20)`。
- `:52`：`.padding(.top, 14)`。
- `:62`：`.padding(.top, 10)`。
- `:191`：`VStack(alignment: .leading, spacing: 24)`。
- `:222`：`VStack(alignment: .leading, spacing: 4)`。

读代码证实。
建议
把这些值移进 `ManageLayout`（已有 `ManageLayout` 命名空间），再引用。

### 9. 低 配对链接把 ServiceAccessToken（clientSecret）放进二维码和分享链接
文件:行
`clients/apple/Sources/HimawariCore/Pairing.swift:31-42`、`clients/apple/Sources/HimawariManage/Settings/PairingSession.swift:52`、`clients/apple/Sources/HimawariManage/Settings/DevicePages.swift:232-235`

问题
`PairingInvitation.link` 把 `ServiceAccessToken`（含 `clientId`/`clientSecret`）编码进 base64url 链接，页面同时提供二维码和 `ShareLink`。服务令牌是过 Cloudflare 的共享凭据，设计文档说泄露时要在 Cloudflare 换一把。把长期凭据放进可转发的分享链接，等于把“扫码配对”扩展成“拿到链接的人也能拿到服务令牌”。

证据
- `Pairing.swift:33-41`：`Outgoing` 包含 `let access: ServiceAccessToken?`，并编码进链接。
- `PairingSession.swift:52`：`PairingInvitation(origin: ..., code: code, access: pairing.access ?? identity.access)`。
- `DevicePages.swift:232`：`ShareLink(item: link)`。

读代码证实：链接确实包含 access token。
推测：这是否可接受取决于产品是否把该服务令牌当作可分享的配对引导凭据；如果不是，任何转发都能扩大凭据暴露面。
建议
改用一次性、短有效期、绑定本次配对码的引导凭据；分享链接不应携带长期服务令牌。

### 10. 低 文件列表分页没有在途保护，末行重复出现可能重复请求/重复追加
文件:行
`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:113-137`、`clients/apple/Sources/HimawariManage/Settings/AccountPages.swift:121-123`

问题
`loadFiles(origin, more: true)` 没有记录“正在加载下一页”的状态，也没有在请求前把 cursor 占住。最后一行每次 `onAppear` 都会触发一次分页请求；如果快速重复出现（滚动、布局变化），两个请求可能用同一个 `before` cursor 返回同一页，`shelf.files += ...` 就会追加重复条目，SwiftUI 还可能报重复 id。

证据
- `SettingsStore.swift:113-137`：`var shelf = more ? shelf(origin) : FileShelf()`，成功后 `shelf.files += page.files...`，没有 in-flight 标志。
- `AccountPages.swift:121-123`：`onAppear { if index == shelf.files.count - 1 { Task { await store.loadFiles(origin, more: true) } } }`。

读代码证实：没有在途保护。
推测：需要快速滚动或布局重复触发才会明显；现有测试只顺序调用。
建议
增加 `loadingMore` 标志，并在请求前按 origin 去重；或改用显式“加载更多”按钮/游标快照。

## 侧重检查

- **错误路径**：检查了 `ManageGateway.send`、`SignedDeviceTransport`、`DataExportSession`（404/取消/失败）、`PairingSession`（过期/拒绝/确认）、`SettingsStore.load`（部分失败）、`DeviceName.accepted` 与服务端 `deviceNameSchema`、`MemoryItem` 解码与服务端 snapshot。结论：`capability.disable` 缺字段是确定的失败路径；`reasonCode` 在真实传输层确定丢失；其余字段核对基本一致。
- **不合规范/不可信输入**：客户端把服务端返回的 `capabilityRef` 直接用于 `capability.detail`，两端都是 machine string；设备名、配对码、配对数字、设备 id 的格式与服务端 schema 基本一致；QR 渲染失败有 fallback。未发现把服务端文本拼进命令类型或路径的注入点。
- **安全**：设备吊销、删除记忆、停用能力均登记为 change；但停用能力因缺 `recentAuthenticationRef` 实际不可用；记忆改写丢失原分类；配对链接含服务令牌；收紧类操作不过面容（见意见 3）。没有代码注释、没有把密钥写日志。
- **资源耗尽**：`PairingSession.watch` 每 2 秒轮询到服务端给的 `expiresAt`；`DataExportSession.follow` 每 1 秒轮询到页面关闭或终态；`loadCapabilities` 是 N+1 顺序读取；文件分页有重复触发风险。未发现本地无界循环，但导出轮询没有次数上限，服务端长期 `running` 时会持续轮询（低风险）。
- **不可撤销的操作**：`device.revoke`、`memory.mutate delete`、`capability.disable`、`data.export.start` 都走 change 级挑战（除非意见 1 的停用失败）；`data.export.cancel` 是 routine，按能力表不过面容。删除/吊销后的 UI 回退路径已检查，`removedThisDevice` 会清本地状态。
- **规则文件、说明文档与代码一致**：确认新 Swift 文件没有注释；确认能力表有 `check:client-parity`；发现设计文档第 232 行、`operations-pending.json:21` 与代码不一致；发现作者“所有数值取自 DesignTokens/Layout”与 `MemoryRootView` 的硬编码不一致。
- **未核实**：`swift test 169`、iOS/Mac 实际编译、设计线程 18 张截图验收，我无法运行测试或看图确认。diff 里新增的 `19/20` 系列截图是 9 个场景×2，另有 `08-settings` 两张；“18 张”可能只指 19/20 系列。PR 455 回退的迁移是否已在任何环境应用，也未核实。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**
按本次读到的代码，不会。PR 503 的 Swift 改动只调用管理用的 `/api/device/v1/gateway` 等设备接口，不组装模型请求；服务端改动里与 prompt 相关的 diff 只是 `ProactiveMail` 到 `ProactiveSourceItem` 的类型改名，没有改系统提示、工具定义、历史顺序或遮盖规则。因此模型请求仍是“工具定义 → 系统提示 → 历史 → 最后一条用户消息”，没有新增会变的值进入请求开头。依据是 [prompt-prefix.md 的“只追加”规则](../../.agents/instructions/prompt-prefix.md#rules)。未核实的是：我没有逐行重读整个 152 个文件的 diff 中与提示词无关的构建代码，但 prompt 目录、prompt 组装器和 golden 测试在本 diff 里没有实质性顺序变化。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**
对模型请求：没有发现。iOS 侧随机生成的 idempotency key、挑战值、当前时间只出现在设备管理请求和 UI 里，不是模型可见内容；`M.relative` 的正则只用于中文 UI 排版。服务端回退把来源固定成 `"gmail"`，没有引入集合遍历顺序或随时间变化的 prompt 字段。对设备管理请求：同一段用户操作每次会生成不同的 `messageId`/`idempotencyKey`，这是预期行为，不影响模型缓存。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
有部分检查，但不够：
- 能力表有 `check:client-parity`，Swift 与 TS 的能力表同步有测试；
- `check:operations` 新增了 Swift 调用方扫描，并有“生成文件/Demo 不算调用方”的反向用例；
- iOS 新增了 `SettingsStoreTests`、`ManageGatewayTests`、`DataExportSessionTests` 等。
但关键反向用例不会失败：把 `capability.disable` 的 `recentAuthenticationRef` 去掉，`SettingsStoreTests.testTurningACapabilityOffAsksForFaceIDWithItsRevision` 仍然通过，因为它只断言三个字段；`SignedDeviceTransport` 丢 `reasonCode` 没有测试；记忆改写后的分类没有测试；Swift 请求没有经过 `CLIENT_GATEWAY_SCHEMAS`。所以意见 1 这类错误能穿过现有测试。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**
逐项核对的结果：
- `capability.disable`：`capabilityRef`（详情返回，machineString）、`expectedRevision`（详情返回，integer(1)）、`reasonCode: "owner_disabled"`（machineString）都能过；**`recentAuthenticationRef` 缺失，服务端 `object` 要求必须出现，失败**。
- `device.rename`/`device.revoke`/`device.pairing.confirm`：`deviceId`、`expectedRevision`、`name` 的格式与服务端 `deviceIdSchema`、`integer(0)`、`deviceNameSchema` 一致。
- `login.device.revoke`/`login.devices.revoke_others`：`deviceId` 和 `recentAuthenticationRef` 都在 payload 中，且 `recentAuthenticationRef` 会被 `withPlaceholders` 换成 `"device"`，服务端确认后可填真实引用。
- `data.export.start/cancel/status.read`：`resultRef`、`exportId`、`downloadPath`、`expiresAt` 与服务端 schema 一致；但导出入口被 `exportDownloadAvailable = false` 关掉，下载路由未设备签名。
- `memory.mutate`：`memoryId`、`action`、`expectedRevision`、`contentRef`、`historyId` 与服务端 schema 一致；但 `contentRef` 对应 payload 的 `dataClassification` 被固定为 private，见意见 4。
- `memory.rule.respond`：`target`、`action`（`undo`/`reconfirm`）在服务端 `OWNER_RULE_ACTIONS` 内。
- `capability.list`/`capability.detail`、`memory.overview.read`、`memory.rules.read`、`device.list.read`、`login.devices.read`、`files.list.read`、`server.status.read`：客户端解码字段与服务端 snapshot 字段基本一致，多余字段由 Decodable 忽略。
- 操作账本：13 项移出与新增 Swift 调用大体对应；`proactive.pause`、`search.ask.read` 仍在 pending，但理由已过时（见意见 7）。
