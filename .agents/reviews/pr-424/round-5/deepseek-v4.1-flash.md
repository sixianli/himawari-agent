## 结论

改动的核心方向没问题：`storageUnavailable`、`restore()` 不误清数据、403 `DEVICE_REVOKED`、`streamConnections` 解码、等待消息不算审批，都能在代码里找到对应实现。但有两处“说法和代码不一致”：`streamConnections` 的限制并没有真正持续生效；403 撤销在发消息、读文本等路径上不会立即把 App 切到已移除。

## 读代码证实的问题

### 1. 高：`streamConnections` 只在 `watch()` 入口检查一次，配置晚到或掉线启动会一直多开一条执行流

**文件:行**：`clients/apple/Sources/HimawariChat/ChatStore.swift:104-109`、`clients/apple/Sources/HimawariShell/AppModel.swift:249-265`、`clients/apple/Sources/HimawariChat/ChatView.swift:61-64`

**问题**：`watch()` 只在被调用时看当前 `streamConnections`。App 启动时先 `chat.start()`，再异步拉配置；用户打开对话时 `ChatView` 也会调 `watch()`。如果此时配置还没到（或离线启动），`streamConnections` 是 `nil`，执行流会照开。之后配置到达并设为 1，代码只改属性，不取消已经开着的 `watched.stream`。结果是：只要用户停留在该对话里，主事件流 + 执行流两条连接会一直存在，服务器限制为 1 时也关不掉；服务端若拒绝/断开，`DeviceEventStream` 还会重连重试。

**证据**：
```swift
// ChatStore.swift:102-108
public var streamConnections: Int?
...
public func watch(_ threadId: String) {
    guard !frozen else { return }
    if let streamConnections, streamConnections < 2 { return }
    if watched?.threadId == threadId { return }
    unwatch()
```
```swift
// AppModel.swift:249-252, 262-265
self.chat = chat
phase = .active
chat.start()
Task { await refreshConfiguration() }
...
let configuration = try await api.configuration()
...
chat?.streamConnections = configuration.streamConnections
```
```swift
// ChatView.swift:61-64
.task(id: threadId) {
    if let threadId {
        store.watch(threadId)
        await store.load(threadId)
```

**建议**：不要只暴露存储属性。让 `streamConnections` 的 setter 调一个 `reconcileWatch()`：值 < 2 时 `unwatch()`；值恢复到 ≥ 2 且当前正打开某对话时重新 `watch`。或者在 `ChatStore` 初始化时直接传入当前配置，并在 `ChatView` 观察配置变化重新计算。另加一条覆盖“先 watch、后收到 1”的测试。

### 2. 中：403 `DEVICE_REVOKED` 在发消息、读文本、建新对话路径不会触发“已移除”

**文件:行**：`clients/apple/Sources/HimawariCore/Outbox.swift:118-123`、`clients/apple/Sources/HimawariChat/ChatStore.swift:352-359`、`clients/apple/Sources/HimawariChat/ChatView.swift:151-160`

**问题**：事件流和直接 API 错误会走 `onSessionInvalid`，但 outbox 把 403 当成“这一条消息被拒绝”，只把消息标成 failed；`loadTexts` 用 `try?` 把错误吞掉；新对话创建失败只弹“创建失败”。因此被撤销的设备在用户停留在界面上时可能继续显示原本的对话，消息反复失败，而不是马上进入 `removed`。虽然主事件流下一次重连/前台刷新配置最终可能发现，但延迟不可控。

**证据**：
```swift
// Outbox.swift:118-123
} catch let error as DeviceAPIError {
    if case let .server(status, code, _) = error, (400..<500).contains(status), status != 408, status != 429 {
        result = .rejected(messageId: message.messageId, code: code)
    } else {
        result = .retryLater
    }
```
```swift
// ChatStore.swift:357
guard let resolved = try? await api.texts(for: missing) else { return }
```
```swift
// ChatView.swift:154-160
let created = try await store.newThread(requestId: createRequestId)
...
} catch {
    createFailed = true
}
```
对比：`DeviceEvents.swift:115-117` 明确对 `isRevoked` 发了 `.sessionInvalid`。

**建议**：把 403 `DEVICE_REVOKED` 统一收口到 `ChatStore` 的错误处理：outbox 发送前/失败后识别 `error.isRevoked` 并调用 `onSessionInvalid()`；`loadTexts` 失败不要静默吞掉；`newThread` 的 `catch` 也识别 `isRevoked`。最好在 `DeviceAPI` 或 `ChatStore` 层做一次统一转换，避免每个调用点各写一遍。

### 3. 中：“清掉，重新配对”是不可撤销操作，但 `forget()` 的删除是静默 best-effort，存储打不开时可能没清掉

**文件:行**：`clients/apple/Sources/HimawariShell/PairingView.swift:46`、`clients/apple/Sources/HimawariShell/AppModel.swift:305-321`、`clients/apple/Sources/HimawariCore/LocalStore.swift:45-49`

**问题**：`storageUnavailable` 页面新增的“清掉，重新配对”直接调 `cancelPairing()`，没有二次确认。`forget()` 删除聊天缓存用的是 `try? store?.removeAll()`；而进入 `storageUnavailable` 时 `store` 通常还没建起来，兜底 `try? FileLocalStore.applicationSupport(...)` 很可能因为同一个原因再失败。甚至即便 `store` 存在，`removeAll()` 里的 `contentsOfDirectory` 也用 `try?` 吞错，目录读不到时直接返回空数组、什么都不删。于是“清掉”可能只删了钥匙串和配对记录，聊天缓存和 outbox 仍在。后续重新配对成功后，`ChatStore` 会从同一目录重新加载旧缓存；`Outbox` 还会把旧的 `sending` 项改回 `waiting`，主事件流一连接就 `flush()`。

**证据**：
```swift
// AppModel.swift:312-315
try? store?.removeAll()
if store == nil, let fresh = try? FileLocalStore.applicationSupport(named: "himawari-device") {
    try? fresh.removeAll()
}
```
```swift
// LocalStore.swift:47-48
let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
for name in names { try FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
```
```swift
// Outbox.swift:40-44
if let data = store.read(name), let decoded = try? JSONDecoder().decode([OutboxItem].self, from: data) {
    items = decoded.map { item in
        var item = item
        if item.state == .sending { item.state = .waiting }
```
```swift
// ChatStore.swift:316-318
case .connected:
    connection = .online
    await flush()
```
“旧数据确实会被重新加载/重发”是**推断**：前提是目录里确有旧缓存或旧 outbox，且删除失败。删除失败本身是读代码证实的。

**建议**：`forget()` 不要吞掉 `removeAll` 错误；删除失败时不要声称已清掉，至少保留 `keysUnreadable`/新的“清除失败”状态，或明确提示用户。旧 outbox 在配对记录被清掉后应直接丢弃，不能等新服务器连接后 flush。破坏性按钮加确认对话框。

### 4. 中：第 4 轮的两个修复和 `streamConnections` 行为没有自动检查

**文件:行**：`clients/apple/Package.swift:11-18`、`clients/apple/Tests/HimawariCoreTests/PairingProblemTests.swift:5-15`

**问题**：`swift test` 的测试目标只有 `HimawariCoreTests`，没有 `HimawariChat`/`HimawariShell` 测试。`restore()` 的“三项都在但记录解不开不清数据”、`storageUnavailable`、`ChatStore.watch` 的限制、`mayHavePaired(403)` 会删密钥，都没有对应用例。现有新增测试只覆盖了 403 到 `.removed` 的映射、配置解码、设备名、等待消息和 `TodayNumber`。因此这些核心改动的反向用例不是“会失败”，而是根本不存在。

**证据**：
```swift
// Package.swift:11-18
.testTarget(
    name: "HimawariCoreTests",
    dependencies: [
        "HimawariCore",
        .product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux])),
    ],
```
`clients/apple/Tests` 下没有 `HimawariChatTests` 或 `HimawariShellTests`。

**建议**：把“是否应打开执行流”“restore 该不该清数据”“403 是否删密钥”抽成 `HimawariCore` 里可测的纯决策函数，或在 Mac 上增加 Chat/Shell 测试目标。至少加：配置从 nil 变为 1 时已有 watched 流必须关闭；`restore` 在 presence 全 present、record 解码失败时不得调用 `forget`；`mayHavePaired(403 DEVICE_REVOKED) == false`。

### 5. 低：`ui-review.sh --only` 的空值/重复值处理和 `wait_until_calm` 边界

**文件:行**：`clients/apple/scripts/ui-review.sh:40`、`:168`、`:105-110`

**问题 1**：`--only ""` 时 `chosen` 和 `grep -c .` 都是 0，第 40 行的比较 `[ 0 -eq 0 ]` 通过，`scenes` 为空，随后 `launch "${scenes[0]}"` 在 `set -u` 下直接报 `unbound variable` 退出。重复写同一场景（如 `--only a,a`）则 `chosen` 1 个、逗号项 2 个，被误报“场景不存在”。

**问题 2**：`wait_until_calm` 先判断 `calm`、再判断 `waited`、最后才 sleep 并累加。`waited` 到 600 时即使刚变安静也会先退出；另外 `--only motion-shimmer` 这类只有动效场景时，第一个场景就持续动画，可能等满 600 秒再失败。属于“误停/慢停”，不是无限死等。

**证据**：
```bash
# ui-review.sh:40
[ "${#chosen[@]}" -eq "$(printf '%s' "$only" | tr ',' '\n' | grep -c .)" ] || { echo "UI_REVIEW_FAILED --only names a scene that does not exist; scenes: ${scenes[*]}" >&2; exit 1; }
# ui-review.sh:168
launch "${scenes[0]}"
```
```bash
# ui-review.sh:105-110
while [ "$quiet" -lt 3 ]; do
  if calm; then quiet=$((quiet + 1)); else quiet=0; fi
  [ "$waited" -lt "$calm_patience" ] || { ... exit 1; }
  sleep 2
  waited=$((waited + 2))
done
```

**建议**：`--only` 解析后先校验非空、去重，再和场景集合比较；`scenes` 为空时给出明确错误。`wait_until_calm` 把耐心判断放到 sleep/累加之后，或在每次检查前单独判断；对 `motion-*` 首场景不要走 `wait_until_calm`，或给动效场景一个专门的等待条件。

### 6. 低：说明文档、检查脚本和界面常量约束不一致

**文件:行**：`clients/apple/README.md:72`、`test/tooling/apple-design-check.test.mjs:58`、`clients/apple/scripts/check-design.mjs:31-34`、`clients/apple/Sources/HimawariChat/ChatView.swift:24,131`

**问题**：
- README 仍用 `Icon(.sun)` 当示例，但 `IconName.sun` 已被删除。
- `apple-design-check.test.mjs` 仍把 `DesignTokens.TypeScale.answer.lineSpacing` 当作合法写法，但 `TypeToken.lineSpacing` 已删除；这个 JS 字符串不会编译，所以测试继续通过，属于过时夹具。
- 作者说“界面常量只从 tokens 来”，但 `check-design` 的 `number-literal` 规则只匹配 `size/width/height/lineSpacing/...`，不匹配 `padding`、`offset`、`Spacer(minLength:)`。新增的 `94`、`73`、`32`、`20`、`14`、`26`、`12` 等布局数字都没有进 tokens，也不会被拦住。

**证据**：
```swift
// ChatView.swift:24
private static let fadeBelowNav: CGFloat = 32
// ChatView.swift:131
.padding(.top, store.connection != .online ? 94 + bannerHeight : 73)
```
```json
// test/tooling/apple-design-check.test.mjs:58
".lineSpacing(DesignTokens.TypeScale.answer.lineSpacing)",
```
```js
// check-design.mjs:31-34
pattern:
  /\b(?:size|cornerRadius|width|height|minWidth|minHeight|maxWidth|maxHeight|idealWidth|idealHeight|lineSpacing|fontSize|radius)\s*:\s*-?\d|\.(?:lineSpacing|cornerRadius|opacity|kerning|tracking)\(\s*-?\d/u,
```

**建议**：更新 README 的图标示例和 `icons.json` 新对象格式说明；把过时的 `.lineSpacing` 夹具改成当前 token；如果“界面常量只从 tokens 来”是硬约束，就把 `padding`/`offset`/`Spacer` 也纳进 `check-design`，否则在说明里收窄这句话。

## 推测与未核实

- **未核实**：服务器 PR 404 的 `streamConnections` 字段名、取值范围和“总连接数”语义，以及 `activityIcon` 的完整允许列表。本 checkout 里找不到这些服务端代码。作者说图标名和服务器清单一致，我只能证明客户端 `ProcessIcon`/`IconName`/资源文件三者在本地一致，无法证到服务器。
- **未核实**：Mac 上的 Xcode 编译、截图三次、`swift test 86` 全过。我所在环境只能读代码和用 git，不能运行 Swift/Mac 模拟器。
- **代码事实**：当前 HEAD 的 `packages/gateway-contracts/src/contracts-v2.ts:549-558` 仍是旧的硬编码隐藏字符表；PR 404 的 `9e8b9918` 才改成 `\p{Cc}\p{Cf}\p{Zl}\p{Zp}`。客户端新规则比两者都严，理论上都能通过，但“服务器的 deviceNameSchema 就是这样”只对 PR 404 成立，对当前检出的 HEAD 不成立。
- **代码事实**：作者说本轮删掉了 `compare-snapshots.swift` 的黑白像素启动画面判断，但 `git diff 00eaebf..HEAD -- clients/apple/scripts/compare-snapshots.swift` 为空；`00eaebf` 里该文件已经没有 `--launch-screen` 分支。这一项不在本轮净增量里。
- **推断**：`storageUnavailable` 时“清掉”留下的旧缓存/旧 outbox 会在重新配对后被加载或重发，前提是删除失败且目录里确有旧数据；删除失败本身已读代码证实。
- **推断**：`--only motion-*` 可能被 `wait_until_calm` 拖到 600 秒超时，取决于动画在模拟器里的实际 CPU 占用。

## 侧重检查

- **错误路径**：检查了 `storageUnavailable` 的设置、展示、前台重试、`retryReadingKeys()` 和 `cancelPairing()`；没有发现无限重试循环，`becameActive()` 每次前台只重试一次，失败后仍回到可操作页面。问题集中在“清掉”的删除失败不可见（见问题 3）。
- **403 撤销路径**：配置刷新、事件流、ChatStore 直接 API 错误都处理了；outbox、`loadTexts`、`newThread` 没有（见问题 2）。
- **不可信输入**：设备名来自 `UIDevice.current.name`，客户端按 Unicode 类别删除 Cc/Cf/Zl/Zp，并按码点限制到 64，且按 Character 截断，不会拆开组合字符；输出是确定性的。`activityIcon` 是字符串，未知值落到 `.puzzle`，不会崩溃。二维码里的 host 仍走原有 `PairingInvitation.parse`，本轮未改。
- **资源耗尽**：`streamConnections` 的晚到/离线路径会让客户端持续多开一条流（见问题 1）；`ui-review.sh` 的等待有上限，但存在误停/慢停边界。
- **不可撤销操作**：“清掉，重新配对”没有二次确认，且删除错误被忽略（见问题 3）。
- **规则/文档/代码一致**：`.claude/rules/prompt-prefix.md` 和 `.claude/rules/owner-global-instructions.md` 对照过；本轮没有新增代码注释。README、`check-design` 夹具和“界面常量只从 tokens 来”的说法有一致性问题（见问题 6）。
- **模型请求前缀**：本轮没有触摸任何模型请求组装代码（见必答问题 1）。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**本仓库内不会。** 这个改动是 iOS 客户端：UI、配对、配置读取、图标和截图脚本。发给服务器的用户消息结构 `OutgoingMessage` 没有改；新增的服务器可见值只有配对时的设备名、读取 `streamConnections`、以及消费服务器发来的 `activityIcon`。没有发现客户端组装或序列化模型提示词、工具定义、历史消息的代码。按 `prompt-prefix.md` 的规则，本应保证“只在末尾追加、每轮变化的值只在最后一条消息里”，但这条规则约束的是服务端模型请求；本 PR 没有改那条链路。

**未核实**：服务端是否把设备名拼进系统提示。本 checkout 里没有找到这种代码；如果服务端这样做，设备名只在重新配对时变化，不会影响已有对话已经冻结的请求开头。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**没有发现新的这种问题。** 设备名规范化只取决于输入字符串本身，同一输入每次得到同一结果；`TodayNumber`/`TimelineView` 依赖当前时间和时区，但只影响 UI，不进入请求体；`streamConnections` 不是文字；图标生成和 `icons.json` 的遍历顺序是确定的。没有新增依赖后续内容的遮盖、时间字段或无序集合。

**注意**：`ChatListView` 的 `RelativeTime.label(..., now: listClock ?? Date())` 会随时间变化，但这是界面显示，不是发给模型的内容。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

**部分有，关键改动没有：**

- 有：`DeviceAPITests` 的设备名测试（改回保留 ZWJ 或 UTF-16 计数会失败）；`PairingProblemTests` 的 403 映射（删掉映射会失败）；`ProcessLineTests` 的等待消息（删掉 `latest.kind != .message` 会失败）；`TodayNumberTests`（改成 UTC 或忽略时区会失败）；`DeviceConfigurationTests` 的 `streamConnections` 解码（删字段会编译失败/测试失败）。
- 没有：`ChatStore.watch` 的 `streamConnections` 行为、配置晚到、`mayHavePaired(403)` 删密钥、`restore()` 不清数据、`storageUnavailable` 的重试和“清掉”、`ui-review.sh` 的新分支。`Package.swift` 的测试目标只有 `HimawariCoreTests`，Chat/Shell 在 Linux 上不参与测试，Mac 上也没有对应测试目标。因此这些反向用例不是“会失败”，而是不存在。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

逐项核对结果：

- `PairingProblem.storageUnavailable`：`PairingView.key` 已补 `"storage"`，`AppModel` 和 `PairingView` 的 switch 都覆盖；en/ja/zh 三个 `Localizable.strings` 都有 `pairing.problem.storage`、`.title`、`pairing.startOver`。可以用。
- `DEVICE_REVOKED -> .removed`：配对页能落到 `home(removed: true)`，`mayHavePaired` 对 403 返回 false 会删密钥。配对路径可以用；但 outbox/`loadTexts`/`newThread` 不触发 `onSessionInvalid`，见问题 2。
- `deviceNameScalars = 64`：客户端按码点计数，服务器 PR 404 的 `[...trimmed].length` 也是码点，客户端删除的字符集合是服务器 `\p{Cc}\p{Cf}\p{Zl}\p{Zp}` 的超集，理论上能通过。但没有跨包测试，且当前 HEAD 的服务器规则是旧硬编码表（客户端更严，仍能通过）。
- `streamConnections`：`DeviceConfiguration` 用可选 `Int?` 解码，缺字段为 nil；`watch` 用 `< 2` 处理 0/1/负数，大数按允许处理。解码和单次 `watch` 能接受，但晚到配置不能关闭已有流，见问题 1。
- `ProcessIcon`/`IconName` 的新名字：本地 `icons.json`、`Icons.xcassets`、`IconName`、`ProcessIcon` 都一致；`ProcessRowView` 和 `ProcessIcon.chosen` 的兜底是 `.puzzle`，资源存在。服务器清单未核实；旧名字会落到 `.puzzle`，不会崩。
- `shownMarker`/`tabTodayOneDigit`：Swift 里写 `"himawari-demo-scene-shown"` 和 `"tab-today-1-digit"`；`ui-review.sh` 用 sed 从 `DemoScenes.swift` 读同一个 marker，并从同一个 enum 读场景名，两边一致。
- `pairingMark`：`tokens.json` 和 `Generated/DesignTokens.swift` 都是 148，`check-design` 会检查 tokens 是否过期。
- `EdgeFade.solid`：三个调用点都已传新参数（`RootView`、`ChatView` 顶/底）。
- `TypeToken.lineSpacing` 删除：Swift 代码里已无引用；只有 `apple-design-check.test.mjs` 的字符串夹具还是旧写法，不影响编译，但应更新。
- `Info.plist` 新增的 `CFBundleIdentifier`、`CFBundleExecutable`、版本号等：`project.pbxproj` 里 `GENERATE_INFOPLIST_FILE = NO`、`INFOPLIST_FILE = iOS/Info.plist`，并定义了 `PRODUCT_BUNDLE_IDENTIFIER`、`MARKETING_VERSION`、`CURRENT_PROJECT_VERSION`，两端能对上。
