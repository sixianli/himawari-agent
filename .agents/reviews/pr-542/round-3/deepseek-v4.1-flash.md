## 复核范围

本轮只对照增量 `f64040e29d31768eddefd31c613ee41d59aaf9ed..34d5b3f5ec909ce4cd570a1c5ed3da102c7d8df2` 做了三件事：核对上一轮 3 条意见、检查增量行、追踪增量值的直接使用端。增量实际只改了 `ci/operations-pending.json`、`SettingsStore.swift`、`SettingsStoreTests.swift`（另有复核记录文件）。为核对使用端和错误路径，追读了 `CapabilitiesPage.swift`、`SettingsModels.swift`、`ManageStrings.swift`、`SettingsParts.swift`、`ManageDemo.swift`、`check-operations.mjs` 及其测试、生产网关契约与适配器、`SecureEnclaveKeys.swift`、`DeviceTransport.swift`、`ManageGateway.swift`、`AppModel.swift`、ADR 0254/0192。未运行 Swift 编译和测试，相关结果标为未核实。

### 1. 低 — 面容取消的分类只有 `CancellationError` 用例，真实 `LAError` 路径未核实，且取消失败若从加载阶段抛出会被归为密钥错误

文件：`clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:20-33`、`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:113-116`、`clients/apple/Sources/HimawariManage/Settings/CapabilitiesPage.swift:67-72`、`clients/apple/Tests/HimawariManageTests/SettingsStoreTests.swift:160-167`

问题：`isDeclined` 的判定是“不在网关、设备接口、密钥、解码错误里的任何错误都算取消”。真正的 Face ID 取消在 `SecureEnclaveKeySigner.sign` 里触发；如果取消异常从 `store.load(...)` 的初始化阶段抛出，会被下面的 catch-all 包装成 `DeviceKeyError.keyUnreadable(.confirm)`，而 `isDeclined` 明确把 `DeviceKeyError` 归为失败，于是会在停用行下显示“没能重新启用”。如果取消发生在 `key.signature(for:)`，异常会绕过这个 catch，落到 `isDeclined` 的兜底并正确归为取消。现有测试只覆盖了 `CancellationError`，没有覆盖真实的 `LAError.userCancel`。

证据：

```swift
// SecureEnclaveKeys.swift:26-32
do {
    key = try store.load(role, context: role == .confirm ? context : nil)
} catch let error as DeviceKeyError {
    throw error
} catch {
    throw DeviceKeyError.keyUnreadable(role)
}
return try key.signature(for: message).rawRepresentation
```

```swift
// SettingsStore.swift:113-116
public static func isDeclined(_ error: Error) -> Bool {
    !(error is ManageGatewayError || error is DeviceAPIError || error is DeviceKeyError || error is DecodingError
        || error is URLError || error is HTTPExchangeError)
}
```

```swift
// SettingsStoreTests.swift:162,166
XCTAssertFalse(SettingsStore.isDeclined(DeviceKeyError.keyUnreadable(.confirm)))
XCTAssertTrue(SettingsStore.isDeclined(CancellationError()))
```

性质：代码路径已读实；CryptoKit 的认证提示究竟在 `init` 还是 `signature(for:)` 触发，未在真机核实，标为未核实。按 Secure Enclave 的常见语义，提示更可能落在 `signature(for:)`，因此现有实现大概率是对的；但测试没有证明这一点。

建议：补一条用 `NSError(domain: LAErrorDomain, code: LAError.userCancel.rawValue)`（或等价封装）验证 `isDeclined` 的用例；如果真机确认取消从 `store.load` 抛出，应在 `SecureEnclaveKeySigner` 中识别 `LAError.userCancel/userFallback/appCancel/systemCancel` 并抛专门的取消错误，而不是依赖 `DeviceKeyError` 分类。

### 2. 低 — 失败文案在重载完成之后才写入，可能留下“孤儿”文案，并在以后重新停用时冒出来

文件：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:77-85`、`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:101-103`、`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:123-129`、`clients/apple/Sources/HimawariManage/Settings/CapabilitiesPage.swift:69-72`

问题：失败路径先执行 `reloadCapabilities()`，过滤掉“当前不在停用列表里的失败文案”，然后才把本次失败写回 `reactivationFailure[ref]`。如果命令实际上已在服务端生效，但客户端因为超时、响应丢失或解码失败而抛错，重载会看到该能力已变成“在用”，随后调用方仍会为这个 ref 写入“没能重新启用”。这条文案当时不显示；但之后用户再次停用这个能力时，`applyCapabilities` 只检查“是否当前停用”，会保留这条旧文案，于是新停用的行下面会出现旧的“没能重新启用”。

证据：

```swift
// SettingsStore.swift:77-85
do {
    try await sendReactivation(capability, reason: reason)
} catch {
    await reloadCapabilities()
    throw error
}
await reloadCapabilities()
```

```swift
// CapabilitiesPage.swift:69-72
} catch where SettingsStore.isDeclined(error) {
} catch {
    store.noteReactivationFailure(M.reactivateFailed, for: item.capabilityRef)
}
```

```swift
// SettingsStore.swift:127-128
let disabledRefs = Set(capabilitiesDisabled.map(\.capabilityRef))
reactivationFailure = reactivationFailure.filter { disabledRefs.contains($0.key) }
```

性质：重载后写入、写入后不再过滤的代码顺序是读代码证实的；“服务端已生效但客户端报错”的触发条件属于推测，但网络超时和响应解码失败都是现实路径。

建议：让 `noteReactivationFailure` 在写入非 nil 文案前检查该 ref 是否仍在 `capabilitiesDisabled` 中，或在写入后再执行一次同样的过滤；也可以把失败文案与当前停用记录的 `occurredAt`/`revision` 绑定，重新停用后自然失效。

### 3. 低 — ADR 0254 仍说 `capability.reactivate` 登记在待补清单，和删除后的清单不一致

文件：`docs/adr/0254-capability-reactivation-is-one-atomic-command.md:69`、`ci/operations-pending.json:3-41`

问题：ADR 第 9 条写“这个命令在 `ci/operations-pending.json` 里登记为暂时没有网页调用方”，但本轮已经把这条从清单里删除。代码部分是对的：`SettingsStore.swift:90` 是调用方，服务端实现和测试都在，`check-operations.mjs:420-434` 会要求“已齐全但仍在名单里”的操作移出，且 `test/tooling/operations-check.test.mjs:151-157` 有反向用例。遗留的是文档没有同步。

证据：

```text
// docs/adr/0254-capability-reactivation-is-one-atomic-command.md:69
...这个命令在 `ci/operations-pending.json` 里登记为暂时没有网页调用方。
```

当前 `ci/operations-pending.json` 的 `operations` 段已经没有 `capability.reactivate`。

性质：读代码和文档证实。

建议：更新 ADR 第 9 条，改成“iPhone 调用方已实现，待补清单已移出”；如果 ADR 被视为历史记录，则在该条后加一条后续说明。顺带一提，ADR 0192 第 5 条写名单 23 项，当前实际是 37 项，这不是本轮引入的，但同样属于文档漂移。

### 4. 低 — 在途保护要等重载完成这一点没有直接自动检查，删掉 `await reloadCapabilities()` 现有测试仍会全过

文件：`clients/apple/Tests/HimawariManageTests/SettingsStoreTests.swift:143-176`、`clients/apple/Sources/HimawariManage/Settings/CapabilitiesPage.swift:65-73`

问题：上一轮第 2 条的核心修复是“成功后的重载完成前不释放 `reactivating`”。当前测试只验证了 `beginReactivation`/`endReactivation` 的集合语义，`testTurningADisabledCapabilityBackOnAsksForFaceIDAndReadsTheDisableDetail` 也只检查发送过命令和载荷，没有挂起重载、检查在途保护是否仍被占用。因此如果有人把 `reactivate` 里的 `await reloadCapabilities()` 改回后台 `Task`，这些测试仍然会通过。

证据：

```swift
// SettingsStoreTests.swift:169-176
func testOnlyOneReactivationPerCapabilityRunsAtATime() {
    let settings = store(ScriptedTransport(answer: Self.answer))
    XCTAssertTrue(settings.beginReactivation("cap-old"))
    XCTAssertFalse(settings.beginReactivation("cap-old"))
    XCTAssertTrue(settings.beginReactivation("cap-other"))
    settings.endReactivation("cap-old")
    XCTAssertTrue(settings.beginReactivation("cap-old"))
}
```

```swift
// CapabilitiesPage.swift:66-68
defer { store.endReactivation(item.capabilityRef) }
do {
    try await store.reactivate(item, reason: M.confirmReactivateCapability(item.displayName))
}
```

性质：读代码证实；缺少的是回归测试，不是当前行为错误。

建议：加一个可阻塞的传输层：让 `capability.list` 或 `capability.detail` 挂起，调用 `reactivate` 期间断言 `beginReactivation(ref)` 仍为 false，放行后再断言命令和重载的发送顺序。

### 5. 低 — 作者说 `lastInvalidation` 含 `lifecycle`，但 Swift 模型只解出两个字段

文件：`clients/apple/Sources/HimawariManage/Settings/SettingsModels.swift:14-19`、`packages/gateway-contracts/src/contracts-v2.ts:3305-3311`

问题：服务端快照的 `lastInvalidation` 确实有 `lifecycle`、`cancelledScheduledJobs`、`occurredAt` 三个字段，但 Swift 的 `Invalidation` 只声明了后两个。`JSONDecoder` 会忽略多余的 `lifecycle`，所以当前解码和显示不会出错；但目前代码无法区分 `lastInvalidation` 的来源/类型，作者“CapabilitySummary 新增 lastInvalidation（lifecycle、cancelledScheduledJobs、occurredAt）”的说法和模型不一致。

证据：

```swift
// SettingsModels.swift:16-19
public struct Invalidation: Decodable, Sendable, Hashable {
    public let cancelledScheduledJobs: Int
    public let occurredAt: String
}
```

```ts
// contracts-v2.ts:3305-3311
lastInvalidation: nullable(
  object({
    lifecycle: enumeration(["disabled"]),
    cancelledScheduledJobs: integer(0),
    occurredAt: timestamp,
  }),
),
```

性质：读代码证实；功能影响为无，属于模型与说法不一致。

建议：要么在 Swift 模型补上 `public let lifecycle: String`（并在需要时用它参与显示判断），要么修正作者的说法，明确“Swift 只解出用于显示的这两个字段”。

## 侧重检查

- **错误路径**：检查了命令失败、Face ID 取消、网络超时/响应丢失、解码失败、409 过期 revision、重载失败。重载失败时 `reloadCapabilities` 会静默返回，在途保护随后释放，界面保留旧列表；这是有意的降级，但成功命令遇到重载失败时用户看不到成功反馈，只能等下次刷新，属于可接受的残余风险。Face ID 取消的运行时异常类型标为未核实，见意见 1。
- **不合规范或不可信输入**：`occurredAt` 由 `Timestamp.parse` 解析，失败时 `disabledAt` 返回 nil，不会崩溃；`cancelledScheduledJobs` 为负或 0 时 `cancelledJobs` 直接不显示；`displayName` 只拼进本地确认文案；`capabilityRef` 只作为字典键和命令载荷，服务端会校验 scope、revision 和最近认证。未发现崩溃或注入问题。
- **安全**：`capability.reactivate` 在客户端能力表里是 `.change` 档，走挑战值 + 确认密钥 + 服务端最近认证校验；`reasonCode` 固定为 `owner_reactivated`，服务端契约只要求 `machineString`，测试也覆盖了这个值。没有新增日志或密钥泄露路径。清单删除只影响检查脚本，不改变后端授权。
- **资源耗尽**：每次重新启用会触发一次 `capability.list` + 每个能力一次 `capability.detail` 的串行重载；规模受能力数量限制，没有新增无界循环。`reactivating` 只按能力 ref 单飞，不允许同一能力并发重试，但不同能力可以同时触发多条重载，属于可接受的有限并发。
- **不可撤销操作**：重新启用只把状态改回在用，不恢复执行句柄和已取消的定时任务；文案“取消了 N 个定时任务，不会自动恢复”与 ADR 0254 一致。失败文案和演示数据不会改变服务端状态。
- **规则文件/说明文档一致性**：ADR 0254 第 9 条已过时，见意见 3；ADR 0192 的名单数量也是旧值。代码没有注释，界面使用了 `Color.hmDanger`、`DesignTokens.TypeScale.caption` 等既有设计项，符合“无注释、走 DesignTokens”的约束。

## 结论

上一轮 3 条意见的核对结果：

1. **已改好**：`capability.reactivate` 已从 `ci/operations-pending.json` 移除；`check-operations.mjs` 会因为“已齐全但仍在名单里”报红，现有反向测试覆盖了这一点；Swift 调用方在 `SettingsStore.swift:90`，且扫描范围包含这个文件。
2. **已改好（行为层面）**：`reactivate` 在成功和失败路径都先等待 `reloadCapabilities`，视图的 `defer { endReactivation }` 因此会在重载之后执行。缺少直接回归测试，见意见 4。
3. **已改好**：`applyCapabilities` 现在同时被 `load()` 和 `reloadCapabilities()` 调用，`testLoadAlsoDropsFailureNotesForCapabilitiesThatAreNoLongerDisabled` 会在修复前失败，反向用例真实有效。

本轮增量没有发现高严重度新错；需要处理的是 5 条低严重度问题，其中意见 1 还带一个未核实的真机风险，意见 2 是本轮“先重载再写文案”顺序带来的边缘问题。

作者说法核对：`lastInvalidation` 的字段说法与 Swift 模型不一致（意见 5）；“停用时间用当前时区、今天与否以传入 now 为准”与代码一致；`frozenNow` 确实作为演示时钟传入；“最近一次提交把开关行改成顶部对齐并固定示例停用时间”不准确，git log 显示最新提交是 `34d5b3f5e`（重载/清理/移出清单），顶部对齐和示例时间固定是更早的 `53ed4ed67`；“Mac 已编译并跑过 swift test”无法在本次环境核实，标为未核实。

## 必答问题

1. **不涉及**。这次改动只发生在 iOS 客户端的设置页和能力状态存储，调用的是设备接口的 `capability.reactivate` 和 `capability.list/detail`，不构造、不修改系统提示、工具定义、历史消息或遮盖结果；没有内容发给模型，因此“只在末尾追加”的规则不被触发。
2. **不涉及**。没有模型请求字节被改变。`disabledAt` 依赖当前时区和 `Date()`，`confirmReactivateCapability` 依赖当前界面语言，但都只用于本地展示和本地 Face ID 确认文案；`reasonCode`、`expectedRevision`、`capabilityRef` 是固定字段，没有把无序集合或带时间的字段序列化进模型请求。
3. **部分有，且不完整**。清单移除有 `operations-check.test.mjs` 的反向用例；`load()` 清理失败文案有新增测试，去掉修复会失败。但“在途保护等到重载完成”没有直接测试（意见 4）；“面容取消”只用 `CancellationError` 测过，真实 `LAError` 路径未覆盖（意见 1）。
4. **逐项核对过**：
   - 清单项删除：产生端是 `ci/operations-pending.json`，使用端是 `check-operations.mjs` 的 `pending[name]`/`Object.hasOwn`，缺键是合法状态；Swift 调用方、后端实现和测试都能被检查脚本识别，删除正确。
   - `reactivate`：只被 `CapabilitiesPage.swift:68` 和测试 `SettingsStoreTests.swift:150` 调用，两端都接受 `async throws`；内部 `sendReactivation` 和 `applyCapabilities` 是私有实现，没有外部使用端。
   - `reactivationFailure`：产生端在 `SettingsStore.swift:102` 和 `ManageDemo.swift:126`，使用端是 `CapabilitiesPage.swift:34` 的 `warning: String?` 和测试；类型接受。但存在“写入时该 ref 已不在停用列表”的孤儿风险（意见 2）。
   - `reactivating`：只在 `beginReactivation`/`endReactivation` 和视图守卫里使用，集合元素是 `String`，两端一致；`@ObservationIgnored` 不影响界面刷新，因为界面没有读取它。
   - `lastInvalidation`：服务端产出 `cancelledScheduledJobs: integer(0)`、`occurredAt: timestamp` 和 `lifecycle: "disabled"`；Swift 使用端读取前两个，`Int` 和 `String` 都能接受，额外的 `lifecycle` 被解码器忽略；但模型没有声明 `lifecycle`，与作者说法不一致（意见 5）。
   - `owner_reactivated`：产生端是 `SettingsStore.swift:75`，服务端契约把 `reasonCode` 定为 `machineString`，生产测试也使用同一个值，两端一致。
