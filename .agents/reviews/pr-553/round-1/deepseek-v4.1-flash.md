### 1. 高 · iPhone 端没有 APNs 注册和推送权限，新增的静默处理与前台核对在真机上不会被触发
文件: `clients/apple/Sources/HimawariShell/AppDelegate.swift:5-20`、`clients/apple/App/iOS/Info.plist:85-89`、`clients/apple/App/iOS/Himawari.entitlements:4-15`

问题: 这个 PR 假定 iPhone 已经能收到带 `notificationId` 的推送，但客户端没有任何 APNs 注册代码，也没有调用服务器的 `POST push/register`。这样系统不会给这个 App 发设备令牌，服务器无法登记 alert 令牌，`didReceiveRemoteNotification` 不会被调用，前台核对时也几乎没有 Himawari 的已送达通知。

证据（读代码证实）:
- `AppDelegate.swift:5-20` 只实现了收通知的方法：
  ```swift
  5: public final class HimawariAppDelegate: NSObject, UIApplicationDelegate {
  6:     public func application(
  ...
  11:         guard let id = SilentWithdrawPush.notificationId(in: userInfo) else {
  ...
  17:             await NotificationSettler(center: SystemDeliveredNotifications()).withdraw(notificationId: id)
  ```
  没有 `registerForRemoteNotifications()`，也没有 `didRegisterForRemoteNotificationsWithDeviceToken` 或 `didFailToRegisterForRemoteNotificationsWithError`。
- 在 `clients/apple` 内检索不到 `registerForRemoteNotifications`；检索 `push/register` 只命中服务器代码和文档，没有 Swift 调用方。服务器侧确实有路由：`packages/platform-node/src/device-api-routes.ts:95` 和 `packages/platform-node/src/device-push.ts:117-184`。
- `Info.plist:85-89` 只加了后台模式：
  ```xml
  85: <key>UIBackgroundModes</key>
  86: <array>
  87:         <string>audio</string>
  88:         <string>remote-notification</string>
  89: </array>
  ```
- `Himawari.entitlements` 只有 HomeKit、App Group 和钥匙串组，没有 `aps-environment`；工程文件里也检索不到 Push Notifications capability 或 `aps-environment`。

推测/未核实: 真机上签名时 Xcode 是否会由别处自动注入 `aps-environment` 未核实；但仓库里的 entitlements 和工程设置没有。作者说“iOS、Mac 构建已验过”指的是编译，不能证明推送可达。

建议: 在客户端加入 `registerForRemoteNotifications()`，实现令牌回调并按服务器 `push/register` 的字段登记；同时在 entitlements/工程里加入 Push Notifications 能力。若注册由另一个未合并 PR 负责，本 PR 应注明依赖，不能在“iPhone 已能收到通知”的前提下验收。

### 2. 中 · 设备动作“请打开 App”推送没有顶层 `notificationId`，新型核对永远忽略它
文件: `apps/agent-service/src/production-apple-push.ts:137-160`、`apps/agent-service/src/production-apple-push.ts:256-289`、`clients/apple/Sources/HimawariCore/Notifications/NotificationSettling.swift:100`

问题: 普通 alert 推送的载荷有顶层 `notificationId`，但设备动作的 `applePushOpenRequestPayload` 没有；客户端只读顶层 `notificationId`，所以这类可见推送永远不会被核对或移除。服务器 `settled` 也只查 web push outbox，而 `requestOpen` 没有把这类通知入队，因此即使客户端拿到 ID，服务端也认不得。

证据（读代码证实）:
```ts
// production-apple-push.ts:116，普通 alert 有顶层 notificationId
116:       notificationId: input.tag,

// production-apple-push.ts:137-160，设备动作 alert 只有 himawari.tag
152:     himawari: {
153:       v: 1,
154:       tag: input.tag,
155:       kind: "device_action",
```
`requestOpen` 在 `production-apple-push.ts:272-286` 以 `pushType: "alert"` 发送这个载荷。`NotificationSettling.swift:100` 只读：
```swift
100: notificationId: notification.request.content.userInfo[SilentWithdrawPush.idKey] as? String
```
而 `production-web-push.ts:631-648` 的 `settled` 只遍历 `store.listRecent` 里的 web push outbox 项。

推测/未核实: 这类通知是否属于本 PR 的“事情已定掉”范围需要产品确认；如果属于，现状不成立。ADR 0273 第 147 行和设计文档第 766 行写的是“iPhone 的推送载荷顶层带 `notificationId`”，与这个 producer 不一致。

建议: 若要覆盖设备动作通知，给 `applePushOpenRequestPayload` 加顶层 `notificationId`，并让服务器 `settled` 能在动作办结或过期后确认这个 ID；否则在文档和验收里明确排除这类通知。

### 3. 中 · “只信服务器回复里自己问过的标识”的反向用例是空转，删掉交集仍会通过
文件: `clients/apple/Tests/HimawariCoreTests/NotificationSettlingTests.swift:32-35`、`clients/apple/Tests/HimawariCoreTests/NotificationSettlingTests.swift:65-73`；对应实现 `NotificationSettling.swift:78`

问题: 这个测试没有真正构造“服务器回复了一个客户端没问过的标识”的情况。`FakeSettlement` 只会返回请求参数里的 ID，所以测试无法覆盖 `Set(settled).intersection(chunk)` 这个保护；删掉第 78 行的交集，测试仍然通过。

证据（读代码证实）:
```swift
32:     func settledNotifications(ids: [String]) async throws -> [String] {
33:         lock.withLock { asked.append(ids) }
34:         if failing { throw URLError(.notConnectedToInternet) }
35:         return ids.filter { settled.contains($0) }
```
```swift
66:         let center = FakeNotificationCenter(shown([("r1", "asked")]))
67:         let source = FakeSettlement(settled: ["asked", "stranger"])
68:         _ = await NotificationSettler(center: center, source: source).reconcile()
69:         #expect(center.remaining == [])
```
第一部分里 `"asked"` 确实被问了，有没有交集都会删 `r1`；第二部分 `"stranger"` 不在请求 ID 里，`FakeSettlement` 会返回空数组，与交集无关。

建议: 让假 source 返回固定数组，不按请求过滤；再构造一个“已送达但不会出现在请求里”的 ID（例如客户端判为不合法的 `"has space"`，或尚未轮到下一批的合法 ID），让假服务器返回它，断言通知不被移除。这样删掉交集时测试会失败。

### 4. 中低 · 多批核对遇到一次失败会保留前面批次已移除的通知，和“失败时不动任何通知”的表述不完全一致
文件: `clients/apple/Sources/HimawariCore/Notifications/NotificationSettling.swift:74-84`、测试 `clients/apple/Tests/HimawariCoreTests/NotificationSettlingTests.swift:76-81`

问题: 每一批先 `remove` 再进入下一批。第二批失败时直接 `return removed`，第一批已经移除了；测试只覆盖单批失败，因此看不出这个行为。若“请求失败时不动任何通知”是指整次核对要么全不动，代码不满足；若指单批失败不影响其他批，当前又会在失败后停止后续批次。

证据（读代码证实）:
```swift
74:         while start < ids.count {
75:             let chunk = Array(ids[start ..< min(start + Self.maxIdsPerCheck, ids.count)])
76:             start += Self.maxIdsPerCheck
77:             guard let settled = try? await source.settledNotifications(ids: chunk) else { return removed }
78:             let settledSet = Set(settled).intersection(chunk)
79:             let requests = delivered.filter { $0.notificationId.map(settledSet.contains) == true }.map(\.requestIdentifier)
80:             guard !requests.isEmpty else { continue }
81:             await center.remove(requestIdentifiers: requests)
82:             removed += requests.count
83:         }
```
测试只放了 `[("r1", "n1")]` 一条，失败时永远只有一批。

建议: 明确语义：若要求整次核对原子化，先收集所有批次的确认结果再统一移除；若按批独立，失败后应继续处理后面的批次，并在测试里加“首批成功、次批失败”的用例。

### 5. 低 · 静默推送的 `notificationId` 没按同一套标识规则校验，且移除不可撤销
文件: `clients/apple/Sources/HimawariCore/Notifications/NotificationSettling.swift:34-39`、`clients/apple/Sources/HimawariCore/Notifications/NotificationSettling.swift:60-64`、`clients/apple/Sources/HimawariShell/AppDelegate.swift:11-18`

问题: 前台核对只接受字母数字下划线连字符、最长 64 的 ID；静默推送路径只检查非空，任何字符串都会直接用于匹配并删除已送达通知。删除通知不可撤销，若服务器以后发来过期或乱序的撤回推送，可能删掉同 ID 的新通知。当前服务器还不发这种静默推送，所以实际风险低。

证据（读代码证实）:
```swift
34:     public static func notificationId(in userInfo: [AnyHashable: Any]) -> String? {
35:         guard let aps = userInfo["aps"] as? [AnyHashable: Any], aps["alert"] == nil else { return nil }
36:         guard let flag = aps["content-available"] as? Int, flag == 1 else { return nil }
37:         guard let id = userInfo[idKey] as? String, !id.isEmpty else { return nil }
38:         return id
39:     }
```
```swift
60:     public func withdraw(notificationId: String) async {
61:         let matching = await center.delivered().filter { $0.notificationId == notificationId }.map(\.requestIdentifier)
...
63:         await center.remove(requestIdentifiers: matching)
```
`withdraw` 没有复用 `isCheckable`，也没有版本或时间字段。

建议: 至少复用 `NotificationSettler.isCheckable`；如果以后启用服务器静默撤回，考虑增加事件时间或版本，避免旧推送删除新通知。`finish(.newData)` 在什么都没删时也可以改成 `.noData`。

**侧重检查**

- 错误路径：`settledNotifications` 抛错、404、非 2xx、JSON 解析失败都会被 `try?` 吞掉并停止当前核对，不会误删；但多批失败时的部分移除见意见 4。
- 不合规范或不可信的输入：前台 ID 在发请求前用 `isCheckable` 过滤，服务器端又用 `NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,64}$/` 校验；主 alert 的 `webPushTopic` 是 base64url，32 字符，能通过。静默推送 ID 未校验，见意见 5。
- 不可信服务器回复：客户端用 `Set(settled).intersection(chunk)` 限定只处理本批问过的 ID，方向正确；但测试不能证明这个保护，见意见 3。
- 安全：请求走已签名的 `DeviceRequest`，ID 只放在 JSON body，不会被拼进 URL 路径或请求头；未发现日志或错误信息泄露密钥。
- 资源耗尽：每批最多 200 个、每个最多 64 字节，单次请求有界；循环上限受已送达通知数限制，系统本身也会限制通知数量。但总量没上限，若一次有几千条会逐批发很多请求。
- 不可撤销操作：前台删除只在服务器确认后执行；静默推送删除没有二次确认，见意见 5。
- 文件、文档和代码一致性：ADR 0273 和设计文档要求 iPhone 推送顶层带 `notificationId`，普通 alert 符合，设备动作 alert 不符合，见意见 2；文档假设 iPhone 能收推送，但仓库里没有 APNs 注册，见意见 1；“服务器这版没做撤回的静默推送”与服务器代码一致，未发现服务器发送静默撤回。
- 未核实：冷启动或首次配对激活走 `AppModel.activate()`，它没有调用 `removeSettledNotifications`，只有 `becameActive()` 调用；如果 SwiftUI 冷启动不产生 `scenePhase` 的 change，旧通知要等下一次前后台切换才核对。这一点需要在真机确认。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。本次 diff 只改 iOS 通知相关文件（`App/iOS`、`HimawariCore/Notifications`、`HimawariShell/AppDelegate.swift`、`AppModel.swift`），没有改系统提示、工具定义、历史消息、遮盖或压缩代码。新增的是发往 `/notifications/settled` 的 HTTP 请求，不进入模型请求；发给模型的内容仍然只在末尾追加，每轮会变的值没有进入请求开头。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会影响模型文本。客户端不生成或改写通知 ID，只转发服务器用确定性 `sha256 + base64url` 生成的 `webPushTopic`；没有时间字段或依赖前后文的遮盖。核对请求里的 `ids` 顺序依赖系统返回已送达通知的顺序，可能因设备状态不同而变化，但这是通知 HTTP 请求，不是模型输入，也不参与提示缓存。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有 `NotificationSettlingTests`，覆盖撤回、前台核对、失败不删、200 一批、非法 ID 过滤、静默推送解析和请求体。但这些 Swift 测试不在 `npm run check` 或仓库 CI 里，提交说明也写的是 `Layer-0-tests: none`，只在 Mac 上手动跑，我没有运行。反向用例中“非法 ID 不发请求”和“请求失败不删通知”去掉对应守卫会失败；但“服务器返回未问过的 ID”这条不会失败，见意见 3；多批失败、AppDelegate 注册、冷启动也没有覆盖。服务器端的 malformed request 反向用例在 base 的 `test/integration/device-notifications.test.ts:140-158`，不是本 PR 新增。

4. **每个值两端都能接受吗？** 主路径可以：`notificationId` 由 `production-web-push.ts:142-144` 的 `webPushTopic` 生成，普通 alert 在 `production-apple-push.ts:116` 放入顶层，客户端在 `NotificationSettling.swift:100` 读取；服务器 `NOTIFICATION_ID` 接受 base64url，客户端 `isCheckable` 也接受；请求体 `{ids}` 最多 200 个、每个最长 64，和服务端的 `SETTLED_MAXIMUM_IDS = 200`、`NOTIFICATION_ID` 一致；响应 `{settledIds}` 客户端按 `[String]` 解码，并用交集限制只处理问过的 ID。不满足两端的地方是：设备动作 alert 没有顶层 `notificationId`（意见 2）；静默推送 ID 没有按同一格式校验（意见 5）；客户端整套通知核对依赖 APNs 注册，而仓库里没有（意见 1）。另外，服务端 `settled` 只看最近 48 小时、最多 500 条（`production-web-push.ts:30`、`:275`、`:636-637`），更早的已送达通知即使已办结也不会被确认，客户端不会收走；这是服务端现有范围，本改动没有处理。
