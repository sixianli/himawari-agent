### 1. 中：换设备库时旧通知的清理仍是懒触发，旧卡片和系统通知会留在新设备；此时点“知道了”还会把旧 id 写进新库

文件:行：`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:97-142`、`clients/apple/Sources/HimawariChat/ChatStore.swift:367-368`、`clients/apple/Sources/HimawariShell/AppModel.swift:472-478`

问题：`settle(in:)` 只在 `receive` / `dismiss` 里被调用，而 `ChatStore` 只把两种通知事件转给 `onNotification`。换设备或“重新开始”本身不会调用 `settle`，所以旧卡片和旧系统通知会一直留到新设备收到第一条通知；`startOver` 后如果不再配对，旧系统通知甚至一直不清。更严重的是，切库后旧卡片如果还显示，用户点“知道了”会先 `settle` 切到新库，再 `notices.withdraw(旧 id)`，把旧设备的 id 写进新设备的 `settled-notices.json`，与“旧设备的通知和收走记录不带进新设备”的说法相反。

证据：
```swift
// MenuBarModel.swift:97-99
func receive(_ event: DeviceStreamEvent) {
    rememberSettled()
...
// MenuBarModel.swift:114-116
func dismiss(_ notice: DeviceNotification) {
    rememberSettled()
    notices.withdraw(notice.id)
// MenuBarModel.swift:126-142
private func rememberSettled() { settle(in: app.deviceStore) }
func settle(in store: FileLocalStore?) {
    guard let store, store !== settledStore else { return }
    if hasSettledStore {
        for notice in notices.items { removeNotice?(notice.id) }
        notices = PendingNotifications(rememberingIn: store)
...
// ChatStore.swift:367-368
case .notificationDeliver, .notificationWithdraw:
    onNotification?(event)
```
`guard let store` 也意味着设备库变成 `nil`（`AppModel.forget` 第 478 行 `store = nil`）时无法用它来清理旧状态。

建议：在 `AppModel` 的 store 赋值/清空处发一个回调（或在 `MenuBarModel` 观察 `phase`），拿到新库或变成 `nil` 时立即清旧卡片和系统通知；`dismiss` 里确认 id 仍在当前 `notices.items` 中才写入 settled。测试不要直接调 `settle(in:)` 模拟换库，要走真实的 store 变化入口。

### 2. 低：settled 文件损坏或写失败仍被静默吞掉（上一轮第 4 条未改）

文件:行：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:42`、`clients/apple/Sources/HimawariCore/OwnerPresence.swift:78-81`

问题：本轮增量没有改这两处。损坏的 `settled-notices.json` 被当成空数组，随后 `save()` 覆盖原文件；写失败也直接返回，没有任何日志或重试。换库时新建的 `PendingNotifications(rememberingIn:)` 也会走这条路径。

证据：
```swift
// OwnerPresence.swift:42
let saved = store.read(Self.settledName).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
// OwnerPresence.swift:78-81
private func save() {
    guard let store, let data = try? JSONEncoder().encode(settled) else { return }
    try? store.write(Self.settledName, data)
}
```
建议：至少记录失败；损坏文件先保留/备份，不要直接覆盖；写失败时保留内存状态并重试。补一个写失败/损坏文件的正反用例。

### 3. 低：列表高度变化仍会把用户滚回旧的 `revealedNotice`（上一轮第 5 条未改）

文件:行：`clients/apple/Sources/HimawariMacUI/PanelView.swift:137-138`、`clients/apple/Sources/HimawariMacUI/PanelView.swift:153-155`

问题：本轮只在新库切换时把 `revealedNotice` 清空；滚动的旧逻辑没变。任何导致 `olderListHeight` 变化的原因（新通知、正文换行、窗口缩放）都会重新滚到旧的 `revealedNotice`，即使用户已经自己滚到别处。

证据：
```swift
// PanelView.swift:137-138
.onChange(of: olderListHeight) { scrollToRevealed(proxy) }
.onChange(of: model.revealedNotice, initial: true) { scrollToRevealed(proxy) }
// PanelView.swift:153-155
private func scrollToRevealed(_ proxy: ScrollViewProxy) {
    if let id = model.revealedNotice?.id { proxy.scrollTo(id, anchor: .top) }
}
```
建议：只在 `revealedNotice.serial` 变化时滚动；高度变化不重滚，或用户手动滚动后清掉 `revealedNotice`。

### 4. 低：新增 MacUI 测试的临时设备库不清理，且测试绕过了真实的换库触发点

文件:行：`clients/apple/Tests/HimawariMacUITests/NoticeAndPresenceTests.swift:133-135`、`clients/apple/Tests/HimawariMacUITests/NoticeAndPresenceTests.swift:141-172`

问题：`temporaryStore()` 在临时目录下用随机 UUID 建库，但没有 `defer` 删除；同一文件里其他既有测试（如 `ListeningTests`、`PairingProblemTests`）都用了 `defer { try? FileManager.default.removeItem(at:) }`。另外，第 2 条测试直接调用 `menu.settle(in: fresh)`，没有经过 `AppModel` 换库后真实的通知事件入口，因此测不出上面第 1 条意见里的懒触发问题。

证据：
```swift
// NoticeAndPresenceTests.swift:133-135
private func temporaryStore() throws -> FileLocalStore {
    try FileLocalStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true))
}
```
建议：在测试里加 `defer` 清理；增加一个用例，先让 `AppModel` 的真实 store 变化，再通过 `receive`/`dismiss` 验证旧通知是否已经清掉。

### 5. 低：tooling 门禁绑定了 `standard` 常量，但没有绑定 `PresenceSensor` 实际使用的策略

文件:行：`test/tooling/mac-presence-window.test.ts:29-36`、`clients/apple/Sources/HimawariMacUI/PresenceSensor.swift:15`、`clients/apple/Sources/HimawariMacUI/MenuBarController.swift:28`

问题：上一轮第 3 条的具体复现（把 `standard.minimumInterval` 改回 60）已经会被拦住；但如果只改调用点，例如让 `PresenceSensor` 使用别的 policy，或 `MenuBarController` 显式传入 `PresenceReportPolicy(minimumInterval: 60, ...)`，这个测试仍然通过，因为它只解析 `PresenceReportPolicy.standard` 的字面量。

证据：
```ts
// mac-presence-window.test.ts:30-36
const minimumInterval = declared(
  /static let standard = PresenceReportPolicy\(minimumInterval: (\d+(?:\.\d+)?), keepAliveInterval: \d+(?:\.\d+)?\)\n/u,
);
expect(source).toContain("let tick = max(minimumInterval / 4, 1)");
const check = Math.max(minimumInterval / 4, 1);
const networkAllowance = 10;
expect(minimumInterval + check + networkAllowance).toBeLessThanOrEqual(shortestWindow);
```
```swift
// PresenceSensor.swift:15
init(app: AppModel, policy: PresenceReportPolicy = .standard) {
// MenuBarController.swift:28
presence = PresenceSensor(app: model.app)
```
建议：把 `PresenceSensor` 的实际默认策略也固定到测试里（或从同一处导出唯一来源），并断言生产调用点没有传入另一套间隔。

## 侧重检查

- 错误路径 / 不可信输入：读了 `/presence` 的服务端校验（`device-api-routes.ts:870-891`）——只接受 `lastInputAt` 一个字段、必须是 `ISO_MILLISECONDS`、只有 Mac 能调；客户端 `PresenceReport.lastInput` 仍拒绝负数、NaN、无穷。新增的 `settle` 没有引入新的外部输入解析。通知 id 只用于字典键和 `himawari.notice.<id>` 标识，没有拼路径。未发现新增注入或越权路径。
- 资源耗尽：`settle` 每次换库只遍历当前待显示通知（服务端放置上限 100），没有新的无界分配；但新增测试会遗留临时目录（意见 4）。未发现新的生产资源泄漏。
- 不可撤销操作：换库时会删除旧系统通知并替换内存列表；由于懒触发，旧列表在新设备上仍可被操作，并可能把旧 id 写进新库（意见 1）。没有任何服务端不可撤销操作。
- 规则/说明与代码一致：作者说法“同一次运行里换成另一个设备库时，从新库重建通知列表……”与代码不一致——重建发生在下一次 `receive`/`dismiss`，不是库变化时。作者说法“CI 不跑 Swift”已核对：`.github/workflows` 和 `ci/policy.json` 没有 Swift 任务。作者说法“上报失败也记为已发”与 `PresenceSensor.swift:41-42` 一致。第 1 点里的 DeviceEventStream 退避重连属于增量没改的旧代码，本轮未重读，标“未核实”。

## 上一轮意见核对

- 第 1 条（空闲后恢复最长 15 秒被当成不在）：已改好。`shouldReport` 在输入时间变化时改用 `now - lastReport.lastInputAt >= minimumInterval`（`OwnerPresence.swift:102-104`），保活只按 `sentAt` 算；新增的 `inputRightAfterAKeepAlive...` 和 `onceTheOwnerIsBack...` 用例能覆盖旧逻辑。残留措辞问题：所谓“下一次检查就报”只在距上次报出的输入时间满 15 秒时成立；更短的空闲仍会等到满 15 秒，但服务端 30 秒窗口仍不会被突破。
- 第 2 条（换设备重配对或“重新开始”后旧通知与 settled 仍会进入新设备）：未完全改好，见意见 1。
- 第 3 条（自动检查没有绑定实际的 15 秒上报间隔）：针对“把 standard 改回 60 秒”的复现已改好；仍有调用点未绑定的残余，见意见 5。
- 第 4 条（settled 文件损坏或写失败被静默吞掉）：未改，见意见 2。
- 第 5 条（列表高度变化把用户滚回旧的 `revealedNotice`）：未改，见意见 3。

## 本轮查过的范围

本轮只看了 `ed5595df..b7d7a5b2` 的增量：`OwnerPresence.swift`、`MenuBarModel.swift`、两个 Swift 测试文件、`test/tooling/mac-presence-window.test.ts`。跟读的证据链包括 `ChatStore` 的通知转发、`AppModel` 的 store 建立/清空、`PanelView` 的滚动逻辑、`MenuBarController` 的闭包装配、`PresenceSensor` 的上报循环、`PendingNotifications` 的读写，以及服务端 `/presence` 路由、`DevicePresence`、`MacPlacement` 和 `delivery-timing.ts`。DeviceEventStream 的退避重连、旧通知列表的渐变/宽度等前几轮已复核且本轮未改变的部分没有重读。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。增量只改 Mac 的在场判断、通知列表清理和测试，没有碰系统提示、工具定义、历史消息或遮盖逻辑；发给模型的内容仍然只在末尾追加这一性质没有被这次改动影响。
2. **会不会让同一段文字在不同请求里变成不同的字节？** 不会。增量没有改发给模型的文字或序列化；`lastInputAt` 是发给服务端的 ISO 时间，`settled-notices.json` 是本地文件，都不进入模型请求。
3. **有没有对应的自动检查，反向用例会真的失败吗？** 部分有：`mac-presence-window.test.ts` 现在解析 `standard.minimumInterval`，把它改成 60 时 `60 + 15 + 10 > 30` 会失败；新增的 Swift `shouldReport` 用例在旧逻辑下也会失败。但 Swift 测试不在 CI 运行；MacUI 的 `settle` 测试不在 CI，且直接调 `settle(in:)`，覆盖不到真实换库触发点；临时目录也没有清理。
4. **改动产生或修改的每个值，使用端都能接受吗？** 能。`lastInputAt` 仍是 `MessageSensing.timestamp` 的 UTC 毫秒格式，匹配服务端 `ISO_MILLISECONDS`；服务端 `/presence` 没有 15 秒频率校验，只把值记成最大值，`DevicePresence.recent` 的窗口最小值是 30 秒，新节奏 15 + 3.75 + 10 = 28.75 秒仍在窗口内。`settle(in:)`、`hasSettledStore` 只在 `MenuBarModel` 内部和 `@testable` 测试里使用；`settled-notices.json` 的格式和 `himawari.notice.<id>` 标识都没变。唯一的绑定缺口是测试只校验 `standard`，没有校验 `PresenceSensor` 实际拿到的策略（意见 5）。
