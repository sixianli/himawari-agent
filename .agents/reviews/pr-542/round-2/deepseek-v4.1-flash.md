**本轮查过的范围**

对比 `a1de5cdfe..f64040e2` 的增量：`CapabilitiesPage.swift`、`SettingsStore.swift`、`SettingsStoreTests.swift`；顺带读了同一 PR 在 `9fa3f97e..f64040e2` 的其余改动（`SettingsModels.swift`、`SettingsParts.swift`、`ManageStrings.swift`、`ManageDemo.swift`、`DemoScenes.swift`），并跟着调用链读到 `DeviceTransport.swift`、`ManageGateway.swift`、`DeviceSignature.swift`、`DeviceAPIClient.swift`、`SecureEnclaveKeys.swift`、`HTTPExchange.swift`、服务端契约 `contracts-v2.ts`、ADR 0254、`ci/operations-pending.json` 与 `scripts/check-operations.mjs`。上一轮复核记录文件在稀疏检出里没有，`git show` 也被规则拒绝，因此只能按你给的 5 条摘要核对。**未核实**：Mac 上实际编译和 `swift test` 结果、真机上面容取消/认证失败抛出的具体错误类型、`npm run check:operations` 的实际执行结果（以下按脚本逻辑判断）。

### 1. 中 — `capability.reactivate` 已有 iPhone 调用方，却仍留在待补清单，`check:operations` 会报红

文件:行：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:84`；`ci/operations-pending.json:4`；`scripts/check-operations.mjs:424-433`

问题：这个 PR 在非 Demo、非 Generated 的 Swift 文件里发送了 `capability.reactivate`，`check:operations` 现在会把“调用方”判为已有；后端实现和测试也已存在，于是该操作变成“已齐全”，但清单仍把它列在 `operations`（理由仍是“手机上的按钮由 iOS 第 11 批任务做”），检查会按 `OPERATION_PENDING_BUT_COMPLETE` 报错。这正是 I-73 说的“清单项要核对使用端”。这条不是本增量新加的调用（调用方在 a1de 之前已有），但上一轮没报，本轮核对清单时仍未修。

证据：
```swift
// SettingsStore.swift:82-84
_ = try await gateway.command(
    .v2,
    "capability.reactivate",
```
```json
// ci/operations-pending.json:4
"capability.reactivate": "调用方是 iPhone 端：……手机上的按钮由 iOS 第 11 批任务做（ADR 0254）。",
```
```js
// scripts/check-operations.mjs:424-433
if (!frontendTexts.some((text) => frontendSends(text, name))) missing.push("调用方");
...
if (missing.length === 0 && reason !== undefined)
  errors.push(`OPERATION_PENDING_BUT_COMPLETE ${name} 已齐全，...从 operations 移除`);
```
`SWIFT_ROOT = "clients/apple/Sources"`，排除项只有 `/Generated/`、`/Demo`、`Demo.swift`，`SettingsStore.swift` 会被扫到。

建议：从 `ci/operations-pending.json` 的 `operations` 里删除 `capability.reactivate`（它已在 `PRODUCTION_CAPABILITY_REACTIVATION_OPERATIONS` 中，不属于 `notInstalled`），并跑一次 `npm run check:operations`。

### 2. 低 — 在途保护在命令返回时就释放，成功后的重新加载尚未完成，仍可能用旧 revision 重发并闪出失败

文件:行：`clients/apple/Sources/HimawariManage/Settings/CapabilitiesPage.swift:63-72`；`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:80-81`

问题：`beginReactivation` 挡住了命令执行期间的连点，但 `endReactivation` 在 `Task` 结束时立即执行；`reactivate` 内部的 `defer { Task { await reloadCapabilities() } }` 只是另起一个任务，并没有等它完成。命令成功返回后、重载把该行移到“在用”之前，`reactivating` 已不含这个 ref，界面仍显示为停用行；这时再点一次开关，会拿旧的 `item.revision` 再发 `capability.reactivate`，服务端按 revision 冲突拒绝，页面写入“没能重新启用”。上一轮第 3 条只算基本改好，没有完全消除“成功后还可能显示失败”的窗口。

证据：
```swift
// CapabilitiesPage.swift:63-71
guard isOn, store.beginReactivation(item.capabilityRef) else { return }
store.noteReactivationFailure(nil, for: item.capabilityRef)
Task {
    defer { store.endReactivation(item.capabilityRef) }
    do {
        try await store.reactivate(item, reason: M.confirmReactivateCapability(item.displayName))
```
```swift
// SettingsStore.swift:80-82
public func reactivate(...) async throws {
    defer { Task { await reloadCapabilities() } }
```
证实：释放时机早于重载完成。推测：只有在重载窗口内发生第二次点击时才会触发；第一次重载通常会把该行移走，所以影响有限。

建议：让重新加载完成后再释放保护，例如把 `reactivate` 改成 `await reloadCapabilities()` 后再返回（失败路径也重载），或在页面 `Task` 里先 `await store.reloadCapabilities()`，再 `endReactivation`；也可以让 `endReactivation` 只在该 ref 已不在 `capabilitiesDisabled` 时释放。

### 3. 低 — 失败文案只在 `reloadCapabilities` 清理，`load()` 刷新路径不清理，旧失败可能在以后重新停用时冒出来

文件:行：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:41-60`、`112-119`；`clients/apple/Sources/HimawariManage/SettingsRootView.swift:121`

问题：上一轮第 4 条要求 reload 时清理失败文案，`reloadCapabilities` 已经按 `disabledRefs` 过滤；但 `load()` 也是刷新入口（根设置页的 `.refreshable` 调用 `store.load()`），它重新赋值三个列表却不裁剪 `reactivationFailure`。如果某个能力之前失败留下文案，之后被别处重新启用，用户下拉刷新后文案仍在字典里但看不见；以后再次停用它时，`disable()` 触发的 `reloadCapabilities` 会因该 ref 又变成 disabled 而保留旧文案，显示一条与本次停用无关的“没能重新启用”。

证据：
```swift
// SettingsStore.swift:112-118
public func reloadCapabilities() async {
    ...
    let disabledRefs = Set(capabilitiesDisabled.map(\.capabilityRef))
    reactivationFailure = reactivationFailure.filter { disabledRefs.contains($0.key) }
```
```swift
// SettingsStore.swift:45-51（load 里没有对应的 filter）
let all = try await capabilities
waitingCapabilities = all.filter { ... }
capabilitiesInUse = all.filter { ... }
capabilitiesDisabled = all.filter { ... }
```
```swift
// SettingsRootView.swift:121
.refreshable { await store.load() }
```
证实：两条刷新路径的处理不一致。推测：需要“别处重新启用→本机刷新→本机再次停用”的序列才会看到旧文案。

建议：抽一个共同的“写入三个列表并裁剪失败字典”的方法，`load()` 和 `reloadCapabilities()` 都调用；或在 `noteReactivationFailure` 之外，统一在每次设置列表时清理。

### 4. 低 — 第 1 轮第 5 条只补到谓词和 Store 方法，页面接线与真正的面容取消路径没有反向测试

文件:行：`clients/apple/Tests/HimawariManageTests/SettingsStoreTests.swift:160-186`；`clients/apple/Sources/HimawariManage/Settings/CapabilitiesPage.swift:34,63-72`

问题：新测试覆盖了 `isDeclined` 的谓词、`begin/endReactivation` 和 reload 清理，这些都是好的；但没有测试页面接线：如果删掉 `warning: disabled ? ... : nil` 的 `disabled` 判断，或删掉 `guard ... beginReactivation`，现有测试仍然全过。也没有反向用例证明“面容取消不显示文案、断网显示文案”这一整条路径。上一轮第 5 条只算部分改好。

证据：
```swift
// SettingsStoreTests.swift:169-176
func testOnlyOneReactivationPerCapabilityRunsAtATime() {
    ...
    XCTAssertTrue(settings.beginReactivation("cap-old"))
    XCTAssertFalse(settings.beginReactivation("cap-old"))
```
```swift
// CapabilitiesPage.swift:34
warning: disabled ? store.reactivationFailure[item.capabilityRef] : nil,
```
证实：测试只调用 Store 方法/谓词，没有构造页面或 Binding。推测：页面行为的变化目前只能靠编译和人工看，回归时不会被测试挡住。

建议：把“错误→是否静默/是否显示文案”和“是否允许开始”抽成可测的纯函数或小类型，页面只做绑定；至少补一个反向用例，验证非停用行不呈现失败文案、同一 ref 在途时第二次开始被拒。

### 5. 低 — 作者说法与代码不一致：`Invalidation` 没有 `lifecycle`，`isDeclined` 的排除项也多了 `URLError`/`HTTPExchangeError`

文件:行：`clients/apple/Sources/HimawariManage/Settings/SettingsModels.swift:14-19`；`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:107-110`

问题：作者说 `CapabilitySummary` 新增的 `lastInvalidation` 包含 `lifecycle`、`cancelledScheduledJobs`、`occurredAt`，但客户端结构体只解码后两个；服务端多出的 `lifecycle` 被 `Decodable` 忽略，当前不影响行为，但“说法包含 lifecycle”不成立。作者又说“面容取消 = 不是网关、设备接口、密钥、解码错误的任何错误”，而代码为了避免把断网吞成取消，额外把 `URLError`、`HTTPExchangeError` 也算失败，所以按字面读作者的说法已经和代码不一致（这个改动本身是对的）。

证据：
```swift
// SettingsModels.swift:16-19
public struct Invalidation: Decodable, Sendable, Hashable {
    public let cancelledScheduledJobs: Int
    public let occurredAt: String
}
```
```swift
// SettingsStore.swift:107-109
public static func isDeclined(_ error: Error) -> Bool {
    !(error is ManageGatewayError || error is DeviceAPIError || error is DeviceKeyError || error is DecodingError
        || error is URLError || error is HTTPExchangeError)
```
证实：代码与作者描述不一致。推测：没有直接运行时后果；如果以后有人按描述去读 `invalidation.lifecycle`，会拿不到值。

建议：改正说明（说明 `lifecycle` 故意不参与客户端判定、取消集合还包含传输错误）；如果确实需要校验 `lifecycle == "disabled"`，再补字段和测试。

**侧重检查（错误路径、不可信输入、安全、资源、不可逆、文档一致）**

- 认证/传输错误分类：查了 `SecureEnclaveKeySigner.sign`、`DeviceSignature.headers`、`SignedDeviceTransport.post`、`ManageGateway.send`、`DeviceHTTPClient.perform`、`URLSessionExchange.send`。证实 `URLError`、`HTTPExchangeError`、`DeviceAPIError`、`ManageGatewayError`、`DecodingError`、`DeviceKeyError` 都会落到“失败”；其他错误（含 `CancellationError`）静默。**推测**：生物识别被锁定或认证失败若抛出非 `DeviceKeyError`，也会被当成“面容取消”静默；真机实际错误类型未核实。
- 在途保护：命令执行期间有效；重载前的窗口仍有重复发送可能（意见 2）。
- 不信任输入：`lastInvalidation.cancelledScheduledJobs` 是强解码 `Int`，`occurredAt` 是强解码 `String`；服务端契约要求三字段齐全，生产写入路径（`sqlite-durable-operations.ts:2762-2768`）也总会写全，所以目前没有发现会触发整页解码失败的合法响应；但客户端没有对单条 invalidation 的局部降级，服务端若漏字段会导致整个能力页加载失败（当前无证据表明存在这种数据）。
- 不可逆操作：`capability.reactivate` 在 `ClientCapabilities.swift:176` 归 `.change`，`ManageGateway.command` 会先取 challenge 再带 confirm 签名，确实过面容；服务端契约和集成测试使用的 `reasonCode` 同为 `owner_reactivated`，`recentAuthenticationRef` 由网关替换为占位 `device`，两端可接受。
- 资源：`reactivating` 只按键增删，未发现无界增长；没有新增队列/文件/后台循环。
- 文档一致：ADR 0254 的载荷字段与客户端一致；`ci/operations-pending.json` 不一致（意见 1）；`architecture-v0.1.md` 说 `lastInvalidation` 有三字段、客户端只解码两字段（意见 5，非运行时问题）。
- Demo：`ManageDemoScreen`/`DemoScene` 两处枚举和 switch 都补齐，未发现漏 case；固定的是绝对时刻，但“今天/具体时间”仍按设备时区渲染，跨时区截图文字会不同（**推测/界面问题，不影响请求**）。

**必答问题**

1. 不改变。本次增量只改 iOS 设置页、Store 和测试；整个 PR 也没有改服务端 prompt 组装、系统提示、工具定义、历史消息或遮盖结果。唯一的出站调用是既有的设备网关命令 `capability.reactivate`，不是发给模型的内容，因此“是否只在末尾追加、每轮变的值是否都在最后一条消息”不涉及。服务端 `capability.reactivate` 实现本身（PR 437）对后续请求工具清单的影响未在本轮核实，但它不属于本 PR 的改动。

2. 不改变模型请求的字节。新增文字、日期格式和失败文案都只在本机界面显示；`occurredAt` 用当前时区格式化，同一时刻在不同设备会显示不同文字，但这些值不会进入任何模型请求。演示数据固定了 `occurredAt` 的绝对时刻，但“今天/具体时间”仍随时区变化，仅影响截图。

3. 有自动检查，但不全。新测试覆盖了 `isDeclined(URLError/HTTPExchangeError)`、`begin/endReactivation`、reload 清理和 `capability.reactivate` 载荷；去掉对应修复后这些断言会失败（读断言即可确认）。缺口有两处：页面接线没有反向用例（意见 4）；`npm run check:operations` 会因为清单没移出而失败（意见 1）。作者说的“swift test 全过”未核实。

4. 逐项核对结果：
   - `lastInvalidation`：服务端契约要求 `lifecycle`、`cancelledScheduledJobs`、`occurredAt`；客户端只要求后两个，多余字段被忽略，能接受。作者说包含 `lifecycle` 与代码不符（意见 5）。
   - `M.disabledAt` / `M.cancelledJobs`：只在 `CapabilitiesPage.swift:30,32` 使用，返回 `String?` 的 `flatMap` 用法正确；`occurredAt` 解析失败时只是不显示时间，不会崩。
   - `reactivationFailure`：产生用 `item.capabilityRef`（`CapabilitiesPage.swift:64,71`），读取用同一个 ref（`:34`），过滤用 `capabilitiesDisabled` 的 ref（`SettingsStore.swift:117-118`），两端一致；但 `load()` 路径不裁剪（意见 3）。
   - `beginReactivation` / `endReactivation`：只有 `CapabilitiesPage` 和测试使用，页面用法与实现一致；释放时机有残留窗口（意见 2）。
   - `reactivate` 载荷：`capabilityRef`、`expectedRevision`、`reasonCode`、`recentAuthenticationRef` 与 `reactivateCapabilityCommandSchema` 完全对应；测试 `production-capability-reactivation.test.ts` 也用 `owner_reactivated`，可接受。
   - `CapabilitySummary` 新字段：是可选字段，新增后没有发现其他 memberwise 初始化调用点；`Hashable` 变化不影响 `Identifiable` 的 `id`。
   - 清单项：`capability.reactivate` 仍留在 `ci/operations-pending.json`，而 `check:operations` 已经能从 Swift 调用方、后端契约测试中判为齐全，会报 `OPERATION_PENDING_BUT_COMPLETE`（意见 1，本轮 q4 的主要失败点）。
   - Demo 场景：两个枚举和两处 switch 都同步，未发现使用端不接受的情况。
