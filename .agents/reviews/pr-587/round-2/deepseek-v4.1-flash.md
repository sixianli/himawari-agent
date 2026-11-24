## 查过的范围

本轮只核 PR 587 自己的提交：`e5fc1214`（功能）和 `857b0750`（第 1 轮修复，和复核记录同一提交）。逐行读了：

- `clients/apple/Sources/HimawariCore/Notifications/PushRegistration.swift`
- `clients/apple/Sources/HimawariShell/AppModel.swift`（push 相关：83-99、390-427、485-536）
- `clients/apple/Sources/HimawariShell/AppDelegate.swift`
- `clients/apple/App/iOS/Himawari.entitlements`、`Himawari.keychain-only.entitlements`、`project.pbxproj` 里的 entitlements 设置
- `clients/apple/README.md:44`
- `clients/apple/Tests/HimawariCoreTests/PushRegistrationTests.swift`
- `clients/apple/Sources/HimawariShell/RootView.swift` 的 `scenePhase`
- 服务端：`packages/platform-node/src/device-push.ts` 的 `register`、`device-api-routes.ts:1347`、`packages/application/src/ports/apple-push.ts`、`web-push.ts`、`sqlite-apple-push-operations.ts` 的 `saveRegistration`

也确认了 `857b0750..4c342279` 对这些 push 文件没有 diff，main 合并没有改动它们。`ac71c6a9..4c342279` 里夹带的 main 内容（HomeFeed、MCP 记忆同步、`prompt-catalog` 等）不是 PR 587，不在本轮结论内。

## 总体结论

上一轮四条意见：第 1 条真改好了；第 4 条只改了 `deviceGone()` 的一半，`flush()` 重入仍在；第 2、6 条只补了文档，代码行为没变。未发现高严重度新问题，但有一处“同一令牌只发一次”的并发不变量仍未成立。

## 意见（按严重度）

### 1. 中低：`flush()` 仍可重入，同一令牌会并发登记多次，上一轮第 4 条只修了一半

文件:行：`clients/apple/Sources/HimawariCore/Notifications/PushRegistration.swift:96-107`、`clients/apple/Sources/HimawariShell/AppModel.swift:423,485-511`、`clients/apple/Tests/HimawariCoreTests/PushRegistrationTests.swift:91-101,163-173`

问题：`generation` 只在 `deviceGone()` 里加一，挡的是“设备移除时还有在途请求”。但 `flush()` 本身没有“正在发送”的标记：两个 `deviceReady()` 或 `tokenArrived()` 可以都在第一个 `await transport.registerPush` 挂起时通过 `request != sent`，于是同一 `request` 并发 POST 两次；另外旧令牌的请求晚于新令牌返回时，两者 `generation` 相同，旧响应会把 `sent` 覆盖成旧请求，下一次又会重发新令牌。这违反作者“同一令牌只发一次”的说法。

证据：

```swift
// PushRegistration.swift:104-107
guard request != sent else { return }
let started = generation
let accepted = (try? await transport.registerPush(request)) == true
if accepted, started == generation { sent = request }
```

```swift
// AppModel.swift:503-510：每次回前台、冷启动/配对完成都会再起一个 Task
private func registerForPush() {
    #if os(iOS)
    let sync = pushSync
    Task {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        UIApplication.shared.registerForRemoteNotifications()
        await sync.deviceReady()
    }
    #endif
}
```

`activate()` 现在也会调用 `registerForPush()`（423 行），冷启动时它和 `RootView.swift:58-59` 的 `becameActive()` 可能各调一次 `deviceReady()`，正好制造重叠窗口。新测试 `aRequestStillInFlightWhenTheDeviceIsRemoved...` 只覆盖 `deviceGone()` 竞态；`theSameTokenIsOnlySentOnce...` 用的 `FakePushTransport` 是同步返回，测不到重入。

建议：给 `flush()` 增加“在途请求”状态，例如 `private var inFlight: PushRegistrationRequest?`，进入发送前同时检查 `sent` 和 `inFlight`，发送结束清除；或者给每次 `flush()` 自己的序号，只有“最后一次发起且同代”的响应才写 `sent`。补一条“两个 `deviceReady()` 重叠时只发一次”的反向测试。

### 2. 低：环境值仍可能与签名权限、服务器白名单不一致，403 仍永久静默；文档只补了一半

文件:行：`clients/apple/Sources/HimawariShell/AppModel.swift:83-92`、`PushRegistration.swift:28-29`、`packages/platform-node/src/device-push.ts:147-162`、`clients/apple/README.md:44`

问题：上一轮第 2 条说环境可能和签名里的 `aps-environment` 不一致。增量只改了 README，代码仍是 `#if DEBUG` 决定，没有和 entitlements 共享同一个来源。服务器还会检查 `configuration.environments` 是否包含该环境（不包含同样回 403 `TOPIC_NOT_ALLOWED`），而 README 只提醒了 topic 清单，没有提醒 environment 清单。403 在客户端被当成“不算错误”，于是配置错了也只在每次回前台静默重试，没有任何日志或提示。

证据：

```swift
// AppModel.swift:83-92
#if DEBUG
let debugBuild = true
#else
let debugBuild = false
#endif
pushSync = PushTokenSync(... environment: PushRegistrationValues.environment(debugBuild: debugBuild) ...)
```

```swift
// PushRegistration.swift:28-29
} catch let DeviceAPIError.server(status, _, _, _) where status == 503 || status == 403 {
    return false
}
```

```ts
// device-push.ts:158-162
if (
  !configuration.topics.includes(topic as string) ||
  !configuration.environments.includes(environment as ApplePushEnvironment)
)
  throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.TOPIC_NOT_ALLOWED, 403);
```

README 新增的只有：

> 登记的环境按构建配置决定，所以不要用 Release 配置配开发签名装到真机上……登记时带的 topic 就是 Bundle Identifier，服务器配置里的推送 topic 清单必须包含它……

建议：在工程里定义一个按配置取值（Debug=`development`、Release=`production`）的构建设置，比如 `APS_ENVIRONMENT`，同时用于 entitlements 的 `$(APS_ENVIRONMENT)` 和传给 Swift 的 Info.plist 值，这样代码和签名不靠 Xcode 自动改写；README 补上服务器 `environments` 白名单；至少在 403 时写一行诊断日志，别让永久失败完全静默。

### 3. 低：新增测试没有守住本次修复的主路径，重入和 `activate()` 触发都没有反向用例

文件:行：`clients/apple/Tests/HimawariCoreTests/PushRegistrationTests.swift:91-101,146-173`、`AppModel.swift:423`

问题：`generation` 那条测试是真正的反向用例（去掉 generation 会得到 `callCount == 1` 而失败），但：

- 403/400 两条测试只固定了 `registerPush` 原有的行为，改动前后都会通过，不算这次增量的反向检查；
- 上一轮第 1 条的修复（`activate()` 里调用 `registerForPush()`）没有任何自动检查；
- 重入导致的重复发送没有测试，现有“同一令牌只发一次”的测试用同步 transport，测不到并发。

证据：`FakePushTransport.registerPush` 直接在当前调用里 `sent.append` 并返回（13-18 行），不会挂起；只有 `SuspendingPushTransport` 能暴露并发，但它只被用在 `deviceGone()` 那条测试里。

建议：加一条两个 `deviceReady()` 交叠、期望只发一次的测试；给 AppModel 的 push 触发加一个可注入的薄协议，或至少在 `activate()` 路径上补一个能在 Mac 上跑的单元测试。

## 上一轮意见逐条核对

1. **已改好**：`activate()` 现在调用 `registerForPush()`（`AppModel.swift:423`），而 `phase = .active` 只有 `activate()` 一个入口（418 行）；冷启动 `restore() -> activate()`、配对完成 `submit()/waitForConfirmation() -> activate()` 都覆盖到了。上一轮说的“冷启动和刚配对完成不登记”确实修好了。
2. **只补了文档，代码未改**：仍是 `#if DEBUG` 产生 environment，README 加了“不要用 Release 配置配开发签名”的警告，但行为没变；见意见 2。
3. **上述第 4 条只改了一半**：`deviceGone()` 与在途请求的竞态被 `generation` 修好了（新测试也能反向验证），但 `flush()` 重入没修；见意见 1。
4. **只补了文档，代码未改**：README 加了 topic 清单必须包含 Bundle Identifier 的提醒，但客户端仍然把 403 当“不算错误”静默重试，服务器 `environments` 白名单也没在文档里提；见意见 2。

## 作者说法与代码不一致的地方

- “同一令牌只发一次，令牌变了再发”：串行调用下成立，并发重入下不成立，见意见 1。
- “设备被移除后清空”：`deviceGone()` 只清 `ready`/`sent` 并递增 `generation`，没有清 `token`（`PushRegistration.swift:90-94`）。保留 token 对重新配对有益，但如果“清空”指令牌，则说法不准确。
- “通知权限在回前台时申请”：代码在冷启动/配对完成的 `activate()` 里也会申请（`AppModel.swift:423`），不只是回前台；这正是上一轮第 1 条的修复，不矛盾，但和字面说法略有出入。

## 推测或未核实

- README 说“发布签名时 Xcode 会把权限里的 `aps-environment` 换成 `production`”，以及付费账号只加 entitlements 就能自动生效：这是 Xcode 和 Apple 签名工具的行为，仓库里没有对应构建设置，本机也没有 Mac/编译器，**未核实**。
- 生产服务器 `runPolicy.applePush.topics` / `environments` 的实际值：仓库里只有测试用的 `win.siyi.himawari`（`startup-configuration.unit.test.ts:1638` 等），生产配置**未核实**；如果实际清单不含 iPhone Bundle Identifier 或 `development`，注册会一直 403 并静默。
- PR 没有在 `project.pbxproj` 里加 Push Notifications 的 `SystemCapabilities` 项；只加了 entitlements 键。自动签名是否足够、是否要求 App ID 事先启用推送，**未核实**。

## 侧重检查

- **错误路径**：403/503 被转换成 `false`，不会当错误抛出，下一次 `deviceReady()` 重试；400/401 等仍抛 `DeviceAPIError`。测过 `DeviceAPIClient.check`（241-245 行）确实对非 2xx 抛错。结论：403 的永久配置错误会静默重试，见意见 2。
- **不可信/不合规输入**：APNs 令牌由系统给，但客户端仍限制非空、≤256 字节并转小写十六进制（`PushRegistration.swift:37-40`）；服务器用 `^(?:[0-9a-f]{2}){1,256}$` 再校验。topic 来自 Bundle Identifier，服务器用 `^[A-Za-z0-9][A-Za-z0-9.-]{0,231}$` 校验；locale 只可能输出 `zh-CN`/`en`/`ja`，服务器 `WEB_PUSH_LOCALES` 正好是这三个。结论：两端一致。
- **安全**：令牌走已签名的 HTTPS 设备请求；代码没有打印令牌或密钥；令牌本身不是秘密。没有新增文件、命令执行或权限提升路径。
- **资源耗尽**：没有无界循环或大缓冲；令牌上限 256 字节。唯一的重复网络请求是意见 1 的并发重入，每个前台事件最多多一两次，服务器端 `saveRegistration` 是 `ON CONFLICT` 幂等更新，不会产生多行。
- **不可撤销操作**：客户端没有新增删除/覆盖类操作；设备移除由服务端吊销/擦除流程处理，客户端 `deviceGone()` 只停止同步。服务端登记是 upsert，不是破坏性操作。
- **规则/文档/代码一致**：README 的免费签名用 `.keychain-only`、`HIMAWARI_ENTITLEMENTS_SUFFIX` 与 `project.pbxproj:783,808` 一致；免费权限文件确实没有 `aps-environment`。文档没覆盖服务器 `environments` 白名单；Xcode 自动改写权限的说法未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。PR 587 只改了 6 个文件（entitlements、README、`PushRegistration.swift`、`AppDelegate.swift`、`AppModel.swift`、测试），没有系统提示、工具定义、历史消息或遮盖代码；push 登记是独立的 HTTP POST，不进入模型请求。发给模型的内容仍然只在末尾追加，每轮会变的值也不在这条链路上。`ac71c6a9..4c342279` 里夹带的 `prompt-catalog` 等 main 合并内容不属于 PR 587，未纳入本结论。
2. **会不会让同一段文字在不同请求里变成不同字节？** 模型文本不涉及。push 请求里 token、environment、topic、locale 都由稳定的输入决定（locale 取 `Locale.preferredLanguages`，用户改系统语言时会变，但那是新的 push 登记，不是模型文本）；没有时间字段、随机值或无序集合进入模型内容。`saveRegistration` 的随机 `id` 只在服务端生成。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有 `PushRegistrationTests.swift`，但本机没有 Swift 编译器，**未实际运行**。`deviceGone()` 那条是真正的反向用例（去掉 `generation` 后第二次 `deviceReady()` 会因 `sent` 已写而不再发送，`callCount` 会是 1）；403/400 两条只固定旧行为，不算本次增量的反向检查；`activate()` 触发、环境/签名一致性、服务器 topic/environment 配置都没有自动检查；重入没有反向用例（见意见 1、3）。
4. **每个新值的使用端都能接受吗？** 逐项核对过：
   - `PushRegistrationRequest` 的 `pushType=alert`、token、environment、topic、locale：服务端 `register` 的 `onlyKeys` 接受这五个键且不要求 `activityRef`（alert 时 `activityRef` 默认空串合法）；`APPLE_PUSH_TOKEN_PATTERN`、`APPLE_PUSH_ENVIRONMENTS`、`APPLE_PUSH_TOPIC_PATTERN`、`WEB_PUSH_LOCALES` 都接受客户端可能产生的值；`sqlite-apple-push-operations.ts:170-186` 又逐项校验一次，服务的 `apn_` + 22 位 base64url id 也匹配。
   - `aps-environment=development`：由 Apple 签名使用；服务端只在登记时接收 `environment` 字符串，两者必须一致。生产配置和 Xcode 改写行为**未核实**。
   - `topic=Bundle Identifier`：服务端要求它出现在 `configuration.topics` 里；仓库里只有测试值 `win.siyi.himawari`，生产配置**未核实**。
   - `generation`：只在 `PushTokenSync` 内部使用，没有外部使用端。
   - `PushBridge.sync` / `registerForPush()`：类型和使用端匹配，`AppDelegate` 已通过 `@UIApplicationDelegateAdaptor` 接上。
   - entitlements 配置键：`HIMAWARI_ENTITLEMENTS_SUFFIX` 在 `project.pbxproj` 里确实同时作用于 iOS App 的权限文件，和 README 一致。
