实际 PR 提交是 `e5fc12149`，父提交正是 `7de6674`，改动只有 `clients/apple` 下 6 个文件；`ac71c6a9` 只是把 main（PR 576/585）合了进来。以下按 `git diff 7de6674..e5fc12149` 复核本 PR，合并进来的 main 改动只用于确认没有碰提示词组装。

### 1. 中：推送登记只在 `scenePhase` 变为 active 时触发，冷启动和刚配对完成时不会登记
文件:行：`clients/apple/Sources/HimawariShell/AppModel.swift:466-493`、`AppModel.swift:373-407`、`Sources/HimawariShell/RootView.swift:58-60`

问题：`registerForPush()` 只有 `becameActive()` 一个调用点，而 `becameActive()` 只由 `scenePhase` 的 `.onChange` 触发。`restore()` 冷启动时走 `activate()`，配对完成也走 `activate()`，这两条路径都不调用 `registerForPush()`。

读代码证实：
```swift
// RootView.swift:58-60
.onChange(of: scenePhase) { _, phase in
    if phase == .active { model.becameActive() }
}
// AppModel.swift:475-481
guard phase == .active else { return }
chat?.reconnect()
...
registerForPush()
// AppModel.swift:400-404（activate 在冷启动/配对后执行）
phase = .active
chat.start()
actions.deviceActionsChanged()
Task { await refreshConfiguration() }
deliverWaitingHandovers()
```

推测：SwiftUI 首次出现时 `scenePhase` 往往已经是 `.active`，`.onChange` 不会为初值回调；若如此，已配对用户冷启动不会登记，刚配对完成的用户也要等下次退到后台再回前台才会登记。这点需要真机确认，但“只有 scenePhase 变化才登记”是代码事实。

建议：在 `activate()` 成功进入 `.active` 后也调用一次 `registerForPush()`（`PushTokenSync` 已有去重，不会重复发），或把登记挂到“已配对且 active”的状态变化上，而不是只挂场景切换。

### 2. 中：APNs 环境由 `#if DEBUG` 产生，和实际签名里的 `aps-environment` 可能不是同一个值
文件:行：`clients/apple/Sources/HimawariShell/AppModel.swift:80-91`、`Sources/HimawariCore/Notifications/PushRegistration.swift:49-51`、`App/iOS/Himawari.entitlements:5-6`、`clients/apple/README.md:43`

问题：令牌所属的 APNs 环境由签名时的 `aps-environment` 决定，但请求里的 `environment` 由编译配置决定。两个产生处没有互相校验，这是 I-73 那类“同一个值只在一端认”的结构。

读代码证实：
```swift
// AppModel.swift:80-91
#if DEBUG
let debugBuild = true
#else
let debugBuild = false
#endif
...
environment: PushRegistrationValues.environment(debugBuild: debugBuild),
// PushRegistration.swift:49-51
public static func environment(debugBuild: Bool) -> String {
    debugBuild ? "development" : "production"
}
// Himawari.entitlements:5-6
<key>aps-environment</key>
<string>development</string>
```

推测：标准流程（Xcode 直接运行 = Debug + 开发签名；Archive = Release + 发布签名）通常一致，README 说“发布签名时 Xcode 会把权限里的 `aps-environment` 换成 production”也依赖这条外部行为，本仓库里没有验证。若用 Release 配置配开发描述文件在真机运行，或 Debug 配分发描述文件，代码会登记到和令牌相反的环境；服务端按登记环境发 APNs，会得到 `BadDeviceToken` 并把登记停用，表现就是“设置完还是收不到推送”。另外 `project.pbxproj` 没有任何 `SystemCapabilities`，换成付费账号时是否只需改 entitlements、还是要额外在 Xcode 里启用 Push Notifications 能力，本机无编译器，未核实。

建议：运行时从已签名 entitlements 读取 `aps-environment`（如 `SecTaskCopyValueForEntitlement`），让请求里的 environment 和令牌环境必然同源；或者至少用一个与签名绑定的构建设置，并加一条 Mac 上的构建/真机验收，而不是只靠 `#if DEBUG`。

### 3. 中：新加的 Swift 测试不在任何自动门槛里，403 分支和反向路径没有用例
文件:行：`package.json:27`、`.github/workflows/*.yml`、`clients/apple/Tests/HimawariCoreTests/PushRegistrationTests.swift:109-115`、`Sources/HimawariCore/Notifications/PushRegistration.swift:28`

问题：`npm run check` 的各步里没有 Swift 测试；`.github/workflows` 里 grep `swift|xcode|macos|apple|Himawari` 没有任何匹配。提交说明也写明本机无 Swift 编译器。新增的 11 个测试不会被仓库的自动检查执行。而作者特别声称的“403 不算错误”没有对应用例，只有 503 的用例。

读代码证实：
```swift
// PushRegistration.swift:28
} catch let DeviceAPIError.server(status, _, _, _) where status == 503 || status == 403 {
// PushRegistrationTests.swift:109-115
@Test func aServerThatIsNotConfiguredForPushIsNotAnError() async throws {
    let exchange = RecordingExchange([HTTPExchangeResponse(status: 503, ...)])
    ...
    #expect(!ok)
}
```
测试里没有 403 用例，也没有“400/401 仍应抛错”的反向用例，也没有验证 `AppModel` 生命周期会调用 `registerForPush`、或 entitlements 与 environment 一致。

建议：在 Mac 上跑一次 `swift test` 并把证据写进提交/PR；补 403、400、401 的用例；如果短期无法把 Swift 测试接进 CI，至少把这次登记做成真机验收项。反向用例必须能证明“去掉 403 捕获或改错 environment 时会失败”，现在没有这种证明。

### 4. 中/低：`PushTokenSync` 的 `flush()` 可被重入，同一令牌可能并发发多次；`deviceGone()` 与在途请求竞态会让重新配对后不再登记
文件:行：`clients/apple/Sources/HimawariCore/Notifications/PushRegistration.swift:89-104`、`clients/apple/Sources/HimawariShell/AppModel.swift:517`

问题：`flush()` 在 `await transport.registerPush` 期间让出 actor，另一个 `deviceReady()`/`tokenArrived()` 可以再次进入，两次都看到 `sent == nil`，于是同一令牌并发 POST。更严重的是 `deviceGone()` 把 `sent` 置空后，先前在途的 `flush()` 返回成功仍会把 `sent` 设回旧请求；重新配对成功后 `deviceReady()` 看到 `request == sent` 就跳过，新的设备记录不会登记。

读代码证实：
```swift
// PushRegistration.swift:89-104
public func deviceGone() {
    ready = false
    sent = nil
}
private func flush() async {
    guard ready, let token else { return }
    let request = ...
    guard request != sent else { return }
    if (try? await transport.registerPush(request)) == true { sent = request }
}
```
`AppModel.swift:517` 还是异步触发，不等待完成：
```swift
Task { [pushSync] in await pushSync.deviceGone() }
```

推测：实际触发需要“前台切换很快”或“移除发生在请求在途时”，概率不高，但测试 `aRemovedDeviceSendsNothingAndRegistersAgainWhenPairedAgain` 用的是立即返回的假 transport，覆盖不到这个时序。

建议：给 `flush()` 加在途标记或 generation 计数；请求返回后只在“generation 未变且 ready 仍为 true”时写 `sent`；`deviceGone()` 递增 generation 并清在途状态；最好让忘记设备时等待 `deviceGone()` 完成。

### 5. 低：“同一令牌只发一次”只在同一个进程内成立，每次冷启动都会重发
文件:行：`clients/apple/Sources/HimawariCore/Notifications/PushRegistration.swift:69-70`、`PushRegistration.swift:102-103`

问题：`sent` 只存在内存里，App 被系统杀掉再启动后 `sent` 为空，同一个令牌会再 POST 一次。作者的说法没有限定“同一次运行”。

读代码证实：
```swift
private var sent: PushRegistrationRequest?
...
guard request != sent else { return }
if (try? await transport.registerPush(request)) == true { sent = request }
```

建议：服务端本来就是按 `(device, pushType, activityRef)` upsert，重复不会造成错误；如果确实要求“同一令牌只发一次”，需要把最后成功发送的请求持久化，否则应把说法改成“同一次运行内只发一次”。

### 6. 低：`topic` 固定为 Bundle Identifier，但服务端必须把这个值列进配置；改了 Bundle Identifier 后会永久静默 403
文件:行：`clients/apple/Sources/HimawariShell/AppModel.swift:89`、`packages/platform-node/src/device-push.ts:158-162`、`Sources/HimawariCore/Notifications/PushRegistration.swift:28-30`、`clients/apple/README.md:43`

问题：README 前面明确允许免费签名用户修改 Bundle Identifier，后面又说换成付费账号后“自动生效，不用改任何代码”。但服务端要求 `configuration.topics` 包含上报的 topic，否则 403；客户端把 403 当“不算错误”且不记录，于是改了 Bundle Identifier 的部署会每次回前台都静默重试，永远不会登记。

读代码证实：
```ts
// device-push.ts:158-162
if (
  !configuration.topics.includes(topic as string) ||
  !configuration.environments.includes(environment as ApplePushEnvironment)
)
  throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.TOPIC_NOT_ALLOWED, 403);
```
```swift
// AppModel.swift:89
topic: bundle.bundleIdentifier ?? "",
// PushRegistration.swift:28
} catch let DeviceAPIError.server(status, _, _, _) where status == 503 || status == 403 {
    return false
}
```

建议：在 README 里写明服务端的 `runPolicy.applePush.topics` 必须包含实际部署的 Bundle Identifier（改过 Bundle Identifier 时要同步），或者让客户端在 403 `TOPIC_NOT_ALLOWED` 时留下可诊断的状态；至少不要把它和“服务器未配置推送”完全混在一起静默。

### 7. 低：失败路径几乎全静默，真机登记失败时没有可诊断线索
文件:行：`clients/apple/Sources/HimawariShell/AppDelegate.swift:16`、`Sources/HimawariCore/Notifications/PushRegistration.swift:103`

问题：`didFailToRegisterForRemoteNotificationsWithError` 是空实现；`flush()` 用 `try?` 吞掉所有非 503/403 的错误（包括 400、401、签名错误、网络错误）。这个 PR 的目标正是修“真机推送无效”，但失败时没有日志、没有状态、没有计数。

读代码证实：
```swift
// AppDelegate.swift:16
public func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}
// PushRegistration.swift:103
if (try? await transport.registerPush(request)) == true { sent = request }
```

建议：加只记录错误类别/HTTP 状态/错误码、不记录令牌的 `os_log`（免费签名拿不到令牌可以继续静默）；这样真机验收时能区分“无权限”“环境不符”“topic 不允许”“服务器未配置”。

### 8. 低：免费签名也会弹通知权限，README 的“静默”表述不准确
文件:行：`clients/apple/Sources/HimawariShell/AppModel.swift:484-491`、`clients/apple/README.md:43`

问题：`requestAuthorization` 和 `registerForRemoteNotifications` 不检查当前签名有没有 `aps-environment`。免费签名用户也会看到通知权限弹窗，但永远拿不到推送令牌；作者说“拿不到令牌就静默”，实际只有令牌失败是静默，权限弹窗不是。

读代码证实：
```swift
// AppModel.swift:487-491
Task {
    _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    UIApplication.shared.registerForRemoteNotifications()
    await sync.deviceReady()
}
```

推测：如果本地通知（PR 553 的收走通知、听写、闹钟）本来就需要通知权限，这个弹窗未必是错的；但 README 应把“免费签名只是没有锁屏推送”和“仍会申请通知权限”说清楚。

建议：要么在免费签名/无 `aps-environment` 时跳过远端登记但仍允许本地通知权限，要么修改 README 的“静默”措辞；至少不要让人以为免费签名完全不会出现通知相关弹窗。

## 侧重检查

- 错误路径：503/403 被转成 `false` 并在下次 `deviceReady` 重试（`PushRegistration.swift:28-30`、`102-103`）；其他状态码被 `try?` 吞掉，没有重试上限或退避，每个前台都会再试。`didFailToRegister...` 为空（`AppDelegate.swift:16`）。以上已读代码证实。
- 不合规范/不可信输入：设备令牌先经 `tokenText` 限制为空/≤256 字节并转小写十六进制（`PushRegistration.swift:37-40`），服务端再次用 `APPLE_PUSH_TOKEN_PATTERN`（最多 256 对十六进制，即 512 字符）校验；`topic` 用服务端的 `APPLE_PUSH_TOPIC_PATTERN` 和配置白名单校验；`locale` 只产生 `zh-CN`/`en`/`ja`，服务端用 `WEB_PUSH_LOCALES` 校验。以上两端一致。
- 安全：登记走已签名设备接口，服务端按 `ownerId/agentId/deviceId` 作用域保存；客户端没有把令牌写日志；服务端测试也断言动作令牌不以明文入库。未发现新增越权或明文泄露路径。令牌在设备 API 请求体里经 HTTPS 传输，未发现额外暴露。
- 资源耗尽：令牌长度有上限；服务端有 JSON 键白名单和令牌格式限制。客户端每次前台会创建新 `Task`，且第 4 条的重入会让同一令牌产生多余请求；没有客户端节流/退避。属于低风险，但“每次前台都重试”在配置永久错误（403 topic 不允许、400）时会长期产生无效请求。
- 不可撤销操作：登记是服务端 upsert，APNs 报令牌失效时服务端停用；客户端 `deviceGone()` 只清本地 `sent`，不删服务端登记，也没有修复不掉的破坏性操作。
- 规则/文档一致性：`aps-environment` 只出现在 `Himawari.entitlements`，`Himawari.keychain-only.entitlements` 确实没有；这一点与 README 一致。不一致或未核实的是：README 说发布构建由 Xcode 把 `aps-environment` 换成 production，但代码用 `#if DEBUG`；README 说换付费账号后自动生效，但服务端 `topics` 必须包含实际 Bundle Identifier；README 说免费签名“静默”，但代码仍会申请通知权限；`project.pbxproj` 没有 Push 能力的 `SystemCapabilities` 记录，切付费账号是否还要手动启用能力未核实。
- 已读代码证实的结论：客户端请求体 5 个键和服务端白名单完全对应；路径 `push/register` 经 `DeviceHTTPClient.prefix` 拼成 `/api/device/v1/push/register`，服务端路由存在；token 长度边界（256 字节 ↔ 256 对十六进制）两端一致；`pushType: "alert"` 在 `APPLE_PUSH_TYPES` 中，服务端也会用 alert 登记发提醒、静默清数据等推送。
- 推测/未核实：SwiftUI 冷启动是否触发 `scenePhase` 的 `.onChange`；Xcode 在 Release/分发签名时是否必然把 entitlements 的 `aps-environment` 改成 production；切付费账号时是否必须在 Xcode 手动启用 Push Notifications 能力；本机无 Swift 编译器，Swift 测试和 `@MainActor` 访问是否实际编译通过未验证。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本 PR 只改 `clients/apple` 的推送登记、entitlements、README 和 Swift 测试，没有碰系统提示、工具定义、历史消息或出口遮盖。发给模型的内容仍然只在末尾追加，没有新增每轮变化的值。依据：`git diff 7de6674..e5fc12149` 只涉及 `clients/apple`；`PushRegistration.swift` 只调用 `POST push/register`，不进入模型请求组装。

2. **同一段文字会不会在不同请求里变成不同字节？** 对模型内容不会。推送请求里的值都是确定性的：令牌是同一 `Data` 的固定小写十六进制，`pushType`、`environment`、`topic` 在同一个构建/会话内固定，`locale` 只在用户系统语言变化时才变化，没有时间字段、没有无序集合。`JSONEncoder` 不保证键顺序，但这不是模型输入，服务端按名称读字段，不依赖顺序。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有测试文件，但没有进入自动门槛：`npm run check` 不含 Swift，`.github/workflows` 也没有 Swift/Xcode 步骤，提交说明也写明本机没有编译器。已有测试覆盖令牌转换、locale、environment、去重、503、路由和请求体；但 403 分支没有用例（只测了 503），400/401 等反向路径没有用例，也没有验证真实生命周期会调用 `registerForPush`、entitlements 与 environment 一致。因此“反向用例会失败”目前没有证据，只能算未验证。

4. **每个新值/修改值，产生处和使用处都能接受吗？** 逐个核对如下：
   - `pushType = "alert"`：产生于 `PushRegistration.swift:11`；服务端 `DEVICE_PUSH_TYPES` 白名单包含 `alert`（`apple-push.ts:9`），`device-push.ts:121-124` 校验通过；服务端用 alert 登记发提醒和静默清数据。两端接受。
   - `token`：产生于 `tokenText`（`PushRegistration.swift:37-40`），小写十六进制、非空、≤256 字节；服务端 `APPLE_PUSH_TOKEN_PATTERN` 允许 1–256 对十六进制（`apple-push.ts:21`），SQLite 保存处也重复校验（`sqlite-apple-push-operations.ts:174`）。边界完全对上。
   - `environment`：产生于 `environment(debugBuild:)`（`PushRegistration.swift:49-51`），只产生 `development`/`production`；服务端 `APPLE_PUSH_ENVIRONMENTS` 接受，SQLite 接受。但环境来源是 `#if DEBUG`，不是签名里的 `aps-environment`，这是本 PR 最需要核实的值（见第 2 条）。
   - `topic`：产生于 `bundle.bundleIdentifier`（`AppModel.swift:89`）；服务端格式校验接受，但 `configuration.topics` 白名单必须包含它（`device-push.ts:158-162`）。默认 `win.siyi.himawari` 应该没问题；README 允许改 Bundle Identifier，改完后若服务端配置没同步，403 会永久静默。
   - `locale`：产生于 `locale(preferred:)`（`PushRegistration.swift:42-47`），只产生 `zh-CN`/`en`/`ja`；服务端 `WEB_PUSH_LOCALES` 和 SQLite 都接受。`zh-Hant` 会映射成 `zh-CN`，符合作者“zh-CN”的说法，但繁体用户会收到简体通知，这是产品取舍，不是校验问题。
   - `aps-environment`：产生于 `Himawari.entitlements:5-6`；使用处是签名/APNs。免费签名文件确实没有它，符合约束；但 Release 的值依赖 Xcode 改写成 production，本仓库没有检查。
   - `PushBridge.sync`：产生于 `AppModel.init`（`AppModel.swift:94`），使用于 `AppDelegate.swift:11-14`；没有两端校验，但类型和生命周期上可用。若创建多个 `AppModel`，后创建的会覆盖前一个，生产路径只有一个 `AppModel`，风险低。
   - `sent`、`maxTokenBytes`：只在 `PushTokenSync` 内部产生和使用，没有外部校验；`maxTokenBytes` 与服务端边界一致。

   结论：`pushType`、`token`、`locale`、默认 `topic` 两端一致；“environment 的来源”和“改过的 Bundle Identifier 是否能进服务端 topics”是两个没有被检查覆盖的薄弱点，正是 I-73 提醒的“只看改动、不问清单里的值能不能通过另一端校验”。
