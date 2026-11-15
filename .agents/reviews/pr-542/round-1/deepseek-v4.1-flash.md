结论：这是一个纯 iOS 展示与示例数据的改动。核心功能能走通，但错误路径的“取消/失败”边界偏宽，且界面层缺少反向检查。下面按严重度列出。

### 1. 中 — 断网/传输错误会被当成“面容取消”吞掉，界面不会报“没能重新启用”
文件: `clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:98`、`clients/apple/Sources/HimawariManage/Gateway/DeviceTransport.swift:55`、`clients/apple/Sources/HimawariCore/HTTPExchange.swift:34`

问题: `isDeclined` 用类型黑名单判断取消；`URLError`、`HTTPExchangeError` 不在黑名单里，因此会被当作面容取消，不写失败文案。断网是真实失败，用户只会看到开关弹回。

证据（读代码证实）:
```swift
public static func isDeclined(_ error: Error) -> Bool {
    !(error is ManageGatewayError || error is DeviceAPIError || error is DeviceKeyError || error is DecodingError)
}
```
```swift
} catch let DeviceAPIError.server(status, code, _, reason) {
```
```swift
let (data, response) = try await session.data(for: request)
```
`SignedDeviceTransport.post` 只接管 `DeviceAPIError.server`，`URLSession` 的 `URLError` 会原样抛出，落到 `isDeclined == true`。

推测: 按你给的“不是网关、设备接口、密钥、解码错误的任何错误都算取消”的字面定义，这符合定义；但把断网也算取消是否本意，规格没有写清。

建议: 只把明确的取消（`LAError.userCancel/systemCancel`、`CancellationError`）算取消；至少把 `URLError`、`HTTPExchangeError` 归为失败。补一条断网反向用例。

### 2. 中 — “面容取消不报错”依赖取消错误没被包成 `DeviceKeyError`，代码里存在会误报失败的路径
文件: `clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:20`、`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:98`

问题: `sign()` 里 `store.load` 的 `catch` 会把任何非 `DeviceKeyError` 包成 `DeviceKeyError.keyUnreadable(role)`；而 `isDeclined` 对该类型返回 `false`。如果面容取消发生在密钥加载/初始化阶段，用户取消就会显示“没能重新启用”。

证据（读代码证实）:
```swift
do {
    key = try store.load(role, context: role == .confirm ? context : nil)
} catch let error as DeviceKeyError {
    throw error
} catch {
    throw DeviceKeyError.keyUnreadable(role)
}
```
```swift
!(error is ManageGatewayError || error is DeviceAPIError || error is DeviceKeyError || error is DecodingError)
```

推测: CryptoKit 一般在 `key.signature(for:)` 阶段弹面容，那时不经过上面的 `catch`，取消会被当前黑名单吞掉；但这一步没有在真机核实。

建议: 在签名层显式识别并映射用户取消，或用测试注入真实取消错误，覆盖 `load` 和 `signature` 两个阶段。

### 3. 中 — 重新启用没有在途保护，连点会重复发送命令，成功后还可能显示失败
文件: `clients/apple/Sources/HimawariManage/Settings/CapabilitiesPage.swift:59`、`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:79`

问题: 开关的 `get` 永远是 `false`，没有 pending/disabled 状态，每次 `set(true)` 都新开一个 `Task`。两个请求携带同一个 `expectedRevision` 但不同幂等键；第一个成功后第二个会因版本过期返回 409，第二个 `catch` 会写“没能重新启用”，此时 `reload` 已把能力移到“在用”。

证据（读代码证实）:
```swift
Binding(
    get: { false },
    set: { isOn in
        guard isOn else { return }
        store.noteReactivationFailure(nil, for: item.capabilityRef)
        Task {
            do {
                try await store.reactivate(item, reason: M.confirmReactivateCapability(item.displayName))
            } catch where SettingsStore.isDeclined(error) {
            } catch {
                store.noteReactivationFailure(M.reactivateFailed, for: item.capabilityRef)
            }
        }
    }
)
```
```swift
defer { Task { await reloadCapabilities() } }
...
"expectedRevision": .number(Double(capability.revision)),
```
推测: 用户是否能在开关弹回前再次点击取决于 SwiftUI 渲染时机，但代码没有任何阻止重复触发的机制。

建议: 按 `capabilityRef` 记录 in-flight，任务期间禁用开关；成功后清掉该 ref 的失败状态。

### 4. 低 — 失败文案不只在“停用了”行显示，也不在 reload 时清理
文件: `clients/apple/Sources/HimawariManage/Settings/CapabilitiesPage.swift:34`、`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:102`

问题: `warning` 被传给所有分区（等待、在用、停用），`reloadCapabilities` 只替换三个数组，不清理 `reactivationFailure`。能力被另一台设备重新启用后，旧失败会显示在“在用”行。

证据（读代码证实）:
```swift
warning: store.reactivationFailure[item.capabilityRef],
```
```swift
public func reloadCapabilities() async {
    guard let all = try? await loadCapabilities() else { return }
    waitingCapabilities = all.filter { ... }
    capabilitiesInUse = all.filter { ... }
    capabilitiesDisabled = all.filter { ... }
}
```
建议: 只在 `disabled` 分区传 `warning`；reload 后删除不在 `capabilitiesDisabled` 里的 ref。

### 5. 低 — 关键错误路径没有自动检查，现有反向用例只覆盖谓词
文件: `clients/apple/Tests/HimawariManageTests/SettingsStoreTests.swift:143`、`clients/apple/Sources/HimawariManage/Settings/CapabilitiesPage.swift:59`

问题: 新测试只验证成功命令载荷和 `lastInvalidation` 解码；没有测试 `catch where` 的先后、失败时写 warning、取消时不写，也没有 `DecodingError`、`DeviceAPIError`、`URLError` 的 `isDeclined` 用例，`M.disabledAt`/`cancelledJobs` 也没有测试。把 `catch where` 改成普通 `catch`，或删掉 `warning` 的渲染，现有测试仍会全过。

证据（读代码证实）:
```swift
XCTAssertFalse(SettingsStore.isDeclined(ManageGatewayError.rejected(status: 403, code: "PORT_NOT_AUTHORITATIVE")))
XCTAssertFalse(SettingsStore.isDeclined(DeviceKeyError.keyUnreadable(.confirm)))
XCTAssertTrue(SettingsStore.isDeclined(CancellationError()))
```
`testTurningADisabledCapabilityBackOn...` 只到 `reactivate` 的载荷断言为止，没有失败/取消分支。

建议: 增加失败 transport 与取消 transport 的用例，覆盖 warning 的写入/清除；补 `URLError`、`DecodingError` 反向用例，以及 `disabledAt` 的 now/时区/计数 0 用例。

### 6. 低 — 缺少“取消了 0 个”和“历史数据没有 lastInvalidation”时的显示
文件: `clients/apple/Sources/HimawariManage/ManageStrings.swift:75`、`clients/apple/Sources/HimawariManage/Settings/SettingsModels.swift:14`、`packages/application/src/services/governance-gateway-adapter.ts:496`、`packages/persistence-sqlite/src/sqlite-durable-operations.ts:2762`

问题: `cancelledJobs` 在 `count == 0` 时返回 `nil`，整行不显示取消数量；PR 437 之前已停用的记录没有 `lastInvalidation`，客户端 `detail`/`note` 都是 `nil`，整行没有停用时间。要求是“每行显示停用时间和取消了几个定时任务”。

证据（读代码证实）:
```swift
static func cancelledJobs(_ count: Int) -> String? {
    guard count > 0 else { return nil }
    return text("取消了 \(count) 个定时任务，不会自动恢复", ...)
}
```
```swift
lastInvalidation: record.lastInvalidation ?? null,
```
```ts
lastInvalidation:
  lifecycle === "disabled"
    ? { lifecycle, cancelledScheduledJobs: jobs.length, occurredAt: input.revokedAt }
    : (input.record.lastInvalidation ?? null),
```
推测: 生产上是否已有这类旧记录未查生产库核实；代码没有回填或兜底。

建议: 明确 0 的文案（如“没有取消定时任务”），并为缺失 `lastInvalidation` 显示“停用时间不明/暂无记录”，或提供回填。

### 7. 低 — 作者两条说法与代码不一致
文件: `clients/apple/Sources/HimawariManage/Settings/SettingsModels.swift:14`、`clients/apple/Sources/HimawariManage/Gateway/ManageGateway.swift:166`

问题: 作者说 `lastInvalidation` 新增 `lifecycle`、`cancelledScheduledJobs`、`occurredAt`，但 Swift 模型只有后两个；作者说“失败原因代码到不了 HTTP 客户端”，但 `SignedDeviceTransport` 会把 `DeviceAPIError.server` 的 `code`/`reason` 编成响应体，`ManageGateway` 再解成 `ManageGatewayError.rejected(status:code:reason:)`。

证据（读代码证实）:
```swift
public struct Invalidation: Decodable, Sendable, Hashable {
    public let cancelledScheduledJobs: Int
    public let occurredAt: String
}
```
```swift
if let reason { detail["reasonCode"] = reason }
...
throw ManageGatewayError.rejected(
    status: response.status,
    code: detail?.code.nonEmpty,
    reason: detail?.reasonCode?.nonEmpty
)
```
建议: 修正说法，或按实际需要把 `lifecycle` 建模；若要区分失败原因，可利用已有的 `code`/`reason`，不要只靠错误类型黑名单。

### 8. 低（推测，待确认）— 示例固定时间与固定 now 在 JST 不是同一天，截图文字会随时区变化
文件: `clients/apple/Sources/HimawariManage/ManageDemo.swift:99`、`clients/apple/Sources/HimawariManage/ManageDemo.swift:176`、`clients/apple/Sources/HimawariManage/ManageStrings.swift:70`

问题: `frozenNow = 1794000000` 是 `2026-11-06T21:20Z`，即 JST `2026-11-07 06:20`；`occurredAt = "2026-11-06T15:10:00+09:00"` 是 JST `11-06 15:10`。两者在 JST 不同日，演示会显示日期而非“今天”；在 UTC 下同一天，会显示“今天”。固定截图结果依赖运行时区。

证据（读代码证实）:
```swift
static let frozenNow = Date(timeIntervalSince1970: 1_794_000_000)
...
let at = "2026-11-06T15:10:00+09:00"
```
```swift
let day = Calendar.current.isDate(date, inSameDayAs: now) ? text("今天", ja: "今日", en: "Today") : pairedDay(date)
```
推测: 截图实际运行机时区和基线未核实；如果基线不在 JST，文案可能不同。

建议: 让 `occurredAt` 相对 `frozenNow` 生成（同一时区同一天），或在演示里固定 `Calendar`/`TimeZone` 并断言文案。

### 9. 低（待确认）— 未安装 `capability.reactivate` 的部署仍显示开关，失败写成“没能重新启用”，与架构文档不一致
文件: `clients/apple/Sources/HimawariManage/Settings/CapabilitiesPage.swift:35`、`apps/agent-service/src/production-approval-gateway.ts:368`、`docs/architecture-v0.1.md:576`

问题: 停用行总是显示 `turnOn` 开关；服务端只在配置了核验入口时才安装 `capability.reactivate`。未安装时返回 501，客户端走普通失败路径，显示“没能重新启用”，没有“当前部署未启用此功能”。

证据（读代码证实）:
```swift
switchState: switchable ? turnOff(item) : (disabled ? turnOn(item) : nil),
```
```ts
const capabilityReactivationAvailable = options.capabilityReactivation !== undefined;
...
...(capabilityReactivationAvailable ? PRODUCTION_CAPABILITY_REACTIVATION_OPERATIONS : []),
```
文档原文：“其他页面显示‘当前部署未启用此功能’并停止查询”。

推测: 目标部署是否已装配核验入口未核实；该文档段落针对控制中心，是否适用于 App 也需确认。

建议: 若 App 也应遵守该文档，读取服务端可用操作，或在 501/`PORT_OPERATION_NOT_INSTALLED` 时显示“当前部署未启用此功能”；否则在 App 规格里写明例外。

## 侧重检查

- **错误路径**：检查了 `isDeclined`、`SignedDeviceTransport`、`HTTPExchange`、`SecureEnclaveKeys`、`CapabilitiesPage.turnOn`、`SettingsStore.reactivate/reloadCapabilities`。结论：网络/传输错误会被当取消；面容取消的识别依赖错误类型未被包成 `DeviceKeyError`；重复点击无保护；reload 失败会静默。
- **不可信输入**：`occurredAt` 经 `Timestamp.parse`，解析失败返回 `nil`；`cancelledScheduledJobs` 走 `Int`；`displayName` 只进 SwiftUI `Text`；`capabilityRef` 原样回传，服务端按引用查找。没有发现注入或越界路径。
- **安全与不可撤销**：`capability.reactivate` 是 `.change` 档，走挑战和面容；服务端再核对最近认证、scope 和 `expectedRevision`；命令带幂等键。重新启用不恢复句柄和定时任务，`lastInvalidation` 保留，和 ADR 0254 一致。未发现 secret 泄漏或不可撤销副作用。
- **资源耗尽**：本 diff 没有新增无界循环；`loadCapabilities` 的分页是既有逻辑。没有做完整的资源审计。
- **规则/文档一致性**：`prompt-prefix.md` 不适用于本改动（不组装模型请求）；ADR 0254 的主要行为一致；架构文档第 576 行的“未安装操作”提示与 App 行为不一致（见第 9 条）；作者两条说法与代码不一致（见第 7 条）。
- **未核实**：本环境不能运行 Swift 编译/`swift test`，作者“Mac 上编译并全过”未核实；面容取消在真机上的具体抛出阶段未核实；生产是否装配 reactivation verifier 未核实；生产是否存在无 `lastInvalidation` 的旧停用记录未核实；截图基线时区未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这个 diff 只改 iOS 设置页展示、示例数据和 Swift 测试；没有触碰系统提示、工具定义、历史消息、遮盖或对话组装。模型请求开头仍然只追加，没有新增进入请求的每轮变化值。新时间值只在 `M.disabledAt` 里渲染到界面，不进入模型请求。依据：`prompt-prefix.md` 第 4、10 条。

2. **会不会让同一段文字在不同请求里变成不同的字节？** 不会。界面文本不序列化进模型请求；`capability.reactivate` 载荷字段固定，`JSONEncoder` 使用 `.sortedKeys`，没有集合乱序或遮盖依赖。`occurredAt` 只用于显示。唯一随时间/时区变化的是界面日期文本，和模型请求无关。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有部分。`testTurningADisabledCapabilityBackOn...` 会验证 `lastInvalidation` 解码和 `capability.reactivate` 的 `expectedRevision`/`reasonCode`；`testOnlyANonServerNonKeyFailureCountsAsDeclined` 对谓词有效，反转 `isDeclined` 会让它失败。但没有覆盖 `catch where` 的接线、warning 的写入/清除、失败与取消的 UI 路径，也没有 `URLError`、`DecodingError`、`DeviceAPIError` 的反向用例；`M.disabledAt`/`cancelledJobs` 没有测试。把 `catch where` 改成普通 `catch` 或删掉 warning 渲染，测试仍会通过。Mac 上 `swift test` 是否全过，本环境未核实。

4. **每个产生或修改的值，两端都能接受吗？**
   - `capabilityRef`、`expectedRevision`、`reasonCode`、`recentAuthenticationRef`：契约要求 `machineString`、`integer(1)`、`machineString`、可空 `machineString`；服务端校验引用、版本和最近认证，`owner_reactivated` 能通过 `machineString`，没有找到原因码枚举限制。两端可接受。
   - `lastInvalidation`：服务端契约要求 `lifecycle`、`cancelledScheduledJobs`、`occurredAt`；客户端模型只声明后两个，未知的 `lifecycle` 被忽略，解码不会失败，但作者“新增 lifecycle”的说法不成立。`occurredAt` 解析有保护，`cancelledScheduledJobs` 是 `Int`。
   - `reactivationFailure` 的键：写入和读取都用同一个 `capabilityRef`，一致。
   - 新增的 `warning` 参数：有默认值 `nil`，现有 `SettingsRow` 调用点不受影响。
   - 新增的示例场景 id：`ManageDemoScreen` 和 `DemoScene` 两边逐字一致；没有找到外部清单或截图脚本要求特定 id，但没有自动检查保证两边永远同步。
   - 旧停用记录没有 `lastInvalidation`：客户端能接受 `nil`，但“每行显示停用时间和取消数量”对这类数据不成立。
   - 未安装 `capability.reactivate` 的部署：客户端会收到 501，当前只能显示通用失败，和架构文档的“当前部署未启用此功能”不一致。
