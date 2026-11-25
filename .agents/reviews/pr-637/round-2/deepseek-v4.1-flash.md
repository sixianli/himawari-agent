## 本轮范围与上一轮意见核对

本轮实际读过的增量范围：`f8d1cbe32` 的 21 个文件，以及为了核对使用端而跟下去的 `Package.swift`、`ManageGateway.capability`、`ClientCapabilities`、`ChatView`/`RootView`、`docs/adr/0258`、`docs/execution/specs/2026-11-11-apple-device-body-design.md`、`packages/domain/src/identifiers.ts`、`packages/gateway-contracts/src/validation.ts`。没有整份重读前几轮已复核的旧代码。

- 上一轮 1（NotificationRouter 隔离）：代码上已按说明加了 `nonisolated`，看起来改好了；但只有 `swiftc -parse` 记录，没有类型检查/测试证据，见下面意见 3。
- 上一轮 3（选项去重）：`choiceKey` 是确定性的，`ManageGateway` 也接受调用方传入的 key；但端到端仍被客户端能力表挡住，见意见 1，且关键测试没在 Linux 跑，见意见 2。
- 上一轮 4（坏选项拖垮解码）：`ThreadMessage` 自定义解码对 `options`/`chosenFrom` 用了 `try?`，并有反向测试，改好了。
- 上一轮 5（页面清单/NativePage）：清单、生成文件、契约测试一起改了，仓库里没有残留引用，改好了。
- 上一轮 6（ownerPresence 缺省）：默认改成 `true`，并有反向测试，改好了。
- 上一轮 7（架构文档）：和 `MainThreadLocator`、`RootView` 的实际调用一致，改好了。

## 意见（按严重度）

### 1. 中高：`thread.option.choose` 不在客户端能力表，点选和本轮新增的幂等键在本机就被拒

文件: `clients/apple/Sources/HimawariManage/ThreadOptionChooser.swift:16`、`clients/apple/Sources/HimawariManage/Gateway/ManageGateway.swift:56`、`:135`、`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:210`

问题：本轮把选项点选改成带 `choiceKey` 的幂等键，但 `ManageGateway.command` 在发网络请求前先按能力表查命令；`thread.option.choose` 不在生成的能力表里，所以直接抛 `unknownType`。全仓库也只有 `ThreadOptionChooser.swift` 这一处出现这个名字。结果是：只要服务器或演示数据给出 `options`，界面会显示选项，但点下去永远到不了服务器，本轮新增的幂等键也没有实际作用。作者也承认“服务器命令表没登记前，手机端 ManageGateway 会在本机拒掉”，但这和 PR 描述里“点一下发 `thread.option.choose`”的功能描述并不一致。

证据：

```swift
// ThreadOptionChooser.swift:16
_ = try await gateway.command(
    .threadV3,
    "thread.option.choose",
    payload: [
        "threadId": .string(threadId),
        ...
```

```swift
// ManageGateway.swift:56
let capability = try capability(gateway, type)
guard capability.kind == .command else { throw ManageGatewayError.unknownType(gateway, type) }
```

```swift
// ManageGateway.swift:135
private func capability(_ gateway: ClientGateway, _ type: String) throws -> ClientCapability {
    guard let capability = ClientCapabilities.find(gateway, type) else {
        throw ManageGatewayError.unknownType(gateway, type)
    }
```

```swift
// Generated/ClientCapabilities.swift:210
ClientCapability(gateway: .threadV3, type: "thread.create", ...),
...
ClientCapability(gateway: .threadV3, type: "thread.checkpoint", ...),
// 没有 thread.option.choose
```

建议：要么在服务器合约登记 `thread.option.choose` 后，把它加进 `CLIENT_CAPABILITY_TABLE` 并重新生成 Swift；要么在命令可用之前隐藏/禁用选项 UI，避免出现“能看见但点不动”的交互。再加一条从 `ThreadOptionChooser` 到请求体的测试，能直接把“本机拒绝”暴露出来。

### 2. 中：幂等键的端到端自动检查实际没跑，也没有覆盖 `ThreadOptionChooser`

文件: `clients/apple/Package.swift:21`、`clients/apple/Tests/HimawariManageTests/ManageGatewayTests.swift:58`、`clients/apple/Sources/HimawariManage/ThreadOptionChooser.swift:15`

问题：本轮新增的 `choiceKey` 测试在 `HimawariCore`，Linux 会跑；但真正把 key 放进请求体的 `ManageGateway` 测试属于 `HimawariManageTests`。`Package.swift` 在 Linux 上把 `interfaceTargets` 整体置空，所以这个测试在 Linux 根本不会编译和运行。提交 `1570949fb` 的说明也写明“HimawariManage 的新测试和 RootView 只做了 `swiftc -parse`，要在 Mac 编译和跑”。另外没有任何测试调用 `ThreadOptionChooser.choose`，所以如果以后有人把 `options.choiceKey(...)` 从调用里删掉、或把 `idempotencyKey` 忘在 `ManageCommandOptions` 外，现有测试不会失败。反向用例本身是有效的：`ManageGatewayTests:69` 会断言两次调用使用同一个调用方 key；问题是它没有被执行，且 chooser 到 gateway 这一段没有覆盖。

证据：

```swift
// Package.swift:21
#if os(Linux)
let interfaceTargets: [Target] = []
let interfaceProducts: [Product] = []
let interfaceDependencies: [Package.Dependency] = []
```

```swift
// ManageGatewayTests.swift:58
func testACommandKeepsTheCallersKeySoARetryIsNotRunTwice() async throws {
    let recording = transport()
    for _ in 0..<2 {
        _ = try await gateway(recording).command(
            .v2, "muse.intake.set", payload: ["paused": true],
            options: ManageCommandOptions(confirmReason: "暂停", idempotencyKey: "device-option-abc")
        )
    }
```

建议：把 key 生成/请求体构造抽到平台无关的 target，或在 Linux 上增加一个可运行的测试；同时增加 `ThreadOptionChooser` 级别的测试，注入假 transport 并断言发出的 `idempotencyKey` 和 `payload`。如果只能在 Mac 跑，至少在 CI 里把 Mac 的 `swift test` 作为合并前门槛。

### 3. 中低：NotificationRouter 的隔离修复没有类型检查或行为测试证据

文件: `clients/apple/Sources/HimawariShell/NotificationRouter.swift:39`、`clients/apple/Sources/HimawariListen/ListenSystemSurfaces.swift:82`

问题：本轮用 `nonisolated` 修上一轮的 iOS 编译问题。按代码看，`presentation` 不碰主线程状态，`ListenNotifications` 的几个分类/动作常量也确实是不可变字符串，改动方向正确。但提交 `c32281575` 只做了 `swiftc -parse`，并写明“类型检查要在 Mac 编译确认”；同时仓库里没有测试引用 `presentation`、`mainChatOnScreen` 或 `approvalKind` 的分流逻辑。也就是说，上一轮的编译问题目前只有人工“看起来对”，没有本轮可复现的编译或测试证据；`presentation` 里“审批推送在主对话开着时也照弹、普通推送不弹”的行为也没有反向测试。

证据：

```swift
// NotificationRouter.swift:39
nonisolated static func presentation(category: String, push: HimawariPush?, mainChatOnScreen: Bool) -> UNNotificationPresentationOptions {
    if ListenNotificationRouting.handles(category: category) { return [.banner, .sound] }
    guard let push else { return [.banner, .list, .sound] }
    if push.kind == HimawariPush.approvalKind || !mainChatOnScreen { return [.banner, .list, .sound] }
    return []
}
```

```swift
// ListenSystemSurfaces.swift:82
nonisolated static let pausedCategory = "listen.paused"
...
nonisolated static let itsMeAction = "listen.itsMe"
```

建议：在 Mac 上对这一个提交跑一次真正的 `swift build`/`swift test` 并记录结果；同时给 `presentation` 加一个不依赖 UIKit 的纯逻辑测试（或者至少做一个源码级检查），覆盖审批/普通/主对话开着三种情况。

### 4. 低：ADR 0258 仍写着客户端能力表是旧对应，和本轮代码不一致

文件: `docs/adr/0258-each-apple-device-plays-to-its-strength.md:108`、`packages/gateway-contracts/src/client-capabilities.ts:386`

问题：本轮已经把 `approvals`、`suggestions` 改成 `nativePage: "chat"`，把 `capabilities-adapters`、`improvements` 改成“手机上不做”。但 ADR 0258 仍写着“客户端能力表和由它生成的 Swift 现在还是旧的对应（`approvals` 对 `today.approvals` 等），由 iPhone 照第 4 版改外壳的那个 PR 一起改”。这个“那个 PR”就是本轮，所以这句话现在过期了。其他文档（`docs/execution/specs/2026-11-11-apple-device-body-design.md:315` 等）已经和新代码一致，只有 ADR 这一处没跟上。

证据：

```text
// docs/adr/0258-each-apple-device-plays-to-its-strength.md:108
客户端能力表（packages/gateway-contracts/src/client-capabilities.ts 的 CLIENT_PAGE_TABLE）和由它生成的 Swift 现在还是旧的对应（approvals 对 today.approvals 等），由 iPhone 照第 4 版改外壳的那个 PR 一起改。
```

```ts
// packages/gateway-contracts/src/client-capabilities.ts:388
{ webPage: "approvals", nativePage: "chat" },
...
{ webPage: "suggestions", nativePage: "chat" },
{ webPage: "capabilities-adapters", notOnPhone: NOT_IN_THIS_PHONE_VERSION },
{ webPage: "improvements", notOnPhone: NOT_IN_THIS_PHONE_VERSION },
```

建议：更新 ADR 0258 的这段实现状态说明，或加一条“已由 PR 637 落地”的修订说明，避免读者以为清单仍是旧的。

## 侧重检查

- 不可信输入/推送解析：`HimawariPush` 只接受 `v == 1` 且 `kind` 存在的 `himawari` 字典；缺字段的 action 会被 `compactMap` 丢掉；`ownerPresence` 缺失按 `true` 处理。缺 token 的 action 不会进入发送路径。结论：安全缺省方向正确。
- 错误路径/不可逆动作：`ApprovalPushReply.tap` 只在 `ownerPresence == false` 且 action 存在时发 token；`NotificationRouter.handle` 对发送失败用 `try? ... ?? .openApp`，不会把失败当成已同意。结论：方向安全。
- 选项输入：未知 `state` 走 `.stale`，整组 `isOpen == false`，不可点；`options`/`chosenFrom` 解码失败整块丢弃，不会出现“部分选项可点”的半开状态。结论：符合“宁可不可点”的安全方向。
- 幂等键与两端校验：`choiceKey` 生成 `device-option-` + 64 位十六进制，约 78 字符；客户端 `machineString` 要求 1–128 字符且匹配 `^[A-Za-z0-9][A-Za-z0-9._:-]*$`，`packages/domain/src/identifiers.ts` 的 `MACHINE_IDENTIFIER_PATTERN` 也要求 1–128 和同一字符集，两端都能接受。默认的 `device-` + 32 位 UUID 也在范围内。结论：格式本身没问题，问题只在命令未登记时根本到不了服务器。
- 资源耗尽：本轮没有新增循环、定时器或无限集合；`choiceKey` 只哈希四个标识，标识在服务端受长度限制。未发现新增的资源耗尽路径。
- 文档与代码一致性：架构文档的 `MainThreadLocator` 描述、I-111 的 `TalkAudio` 描述都与代码一致；ADR 0258 有一处过期，见意见 4。
- iOS 并发：按代码阅读 `presentation` 和常量已解除主线程隔离，但未在 Mac 上做类型检查，见意见 3。

## 推测（未证实）

- `choiceKey` 的跨请求稳定性依赖服务器在重读后保持 `threadId`、`messageId`、`setId`、`optionId` 不变。服务器 PR 还没出，这一点未核实；如果服务器每次重读都换 `setId`，去重键会失效。
- `ThreadMessage` 自定义解码器复制了一份字段列表。以后如果新增一个带默认值的可选字段，容易漏解码而静默变成默认值；这是维护风险，不是当前已证实错误。
- `thread.option.choose` 将来在合约里的 tier（是否走确认密钥、是否需要 Face ID）目前无法核实，因为命令还不存在。
- 作者声称的 Mac 编译/测试通过，本轮只能看到 `swiftc -parse` 的提交说明，未核实真实 Mac 结果。

## 必答问题

1. 这个改动会不会改变模型已经见过的请求开头？
不涉及。本轮是 iPhone 客户端解码、网关请求体、页面清单、文档和演示配置的改动，没有改系统提示、工具定义、历史消息或遮盖结果；发给模型的内容没有变化，因此“只在末尾追加、每轮变化值都在最后一条消息”的规则不受影响。

2. 会不会让同一段文字在不同请求里变成不同的字节？
对模型请求：不会，本轮不改模型上下文。对本轮新增的网关请求体：带动作的选项用 `choiceKey`，是确定性的 SHA-256，重试字节稳定；不带动作的选项（包括 `dismiss`）仍走原有的随机 `makeIdentifier`，作者明确说是有意保持“一直能点”，所以同一 dismiss 文本在不同点选里字节会不同，但这不是模型上下文，也不影响前缀缓存。

3. 有没有对应的自动检查，反向用例会不会真的失败？
部分有：`MessageOptionsTests` 覆盖坏 `options`/`chosenFrom` 丢弃、`choiceKey` 稳定性和格式；`ApprovalPushTests` 覆盖缺 `ownerPresence` 时打开 App；`client-capabilities.contract.test.ts` 和 `client-parity.test.ts` 覆盖页面清单与生成文件。反向用例是有效的：去掉 `try?`、把 `ownerPresence` 默认改回 `false`、把 `choiceKey` 改成随机、把 `approvals` 改回 `today.approvals`，对应测试都会失败。缺口是：`ManageGatewayTests` 在 Linux 不编译不运行，`ThreadOptionChooser` 没有测试，`NotificationRouter.presentation` 没有测试，所以本轮最关键的“key 真正进入请求体”和“iOS 隔离修复”没有被自动验证。

4. 本轮产生或修改的每个值，两端都能接受吗？
逐个核对：
- `choiceKey`：约 78 字符，符合客户端 `machineString`（1–128、字符集）和服务端 `createIdempotencyKey`（1–128、同字符集）；但 `thread.option.choose` 不在客户端能力表，使用端 `ManageGateway.capability` 直接拒绝，见意见 1。
- `ManageCommandOptions.idempotencyKey`：可选，缺省回退原来的 `device-...`；现有所有调用方不传也不会变，兼容。
- `NativePage` 删除的四个 case：全仓库已无 Swift 引用，生成文件和契约测试一致。
- `CLIENT_PAGE_TABLE`：`approvals`/`suggestions` -> `chat`，`capabilities-adapters`/`improvements` -> `notOnPhone`，生成器、契约测试、详细设计表都能接受。
- `ownerPresence` 默认值：只被 `ApprovalPushReply.tap` 使用，缺失时返回 `.openApp`，安全。
- `nonisolated` 常量和 `presentation`：使用方都是非隔离的 `ListenNotificationRouting`/`willPresent`，代码层面接受；未做 Mac 类型检查。
- `AppModel.demoConfiguration`：只在 DEBUG 演示里赋值给 `configuration`，JSON 包含 `DeviceConfiguration` 的所有必填字段，解码可用；未发现使用端不兼容。
