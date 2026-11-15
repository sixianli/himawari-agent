本轮只复核增量 `3eafc66..ed5595`：共 11 个文件，其中代码/测试/令牌 6 个（`OwnerPresence.swift`、`DesignTokens.swift`、`PanelView.swift`、`OwnerPresenceTests.swift`、`tokens.json`、`mac-presence-window.test.ts`），其余是 review 记录与 usage。下面先给意见，再给侧重检查和必答问题。

### 1. 中：第 7 轮第 2 条只改好一半，空闲后恢复操作仍有最长 15 秒被当成不在
**文件:行**：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:100-106`、`clients/apple/Sources/HimawariMacUI/PresenceSensor.swift:36-42`（本轮未改，但新间隔改变了它的实际行为）、`packages/platform-node/src/device-notification-hub.ts:113-118`、`apps/agent-service/src/mac-placement.ts:42-45`

**问题**：最小上报间隔从 60 秒降到 15 秒，确实缩短了误判窗口，但没有消除“服务端保存的 `lastInputAt` 是旧值、客户端却被 15 秒节流挡住”的路径。保活（keepalive）会重发**没有变化的旧 `lastInputAt`**，却把 `lastReport.sentAt` 刷新到当前时间；主人紧接着恢复操作时，新输入要等 15 秒后才允许上报，这段期间服务端仍拿旧的 `lastInputAt` 做“最近有主人操作”判断。

**读代码证实**：
```swift
// OwnerPresence.swift:102-106
let elapsed = now.timeIntervalSince(lastReport.sentAt)
if elapsed < minimumInterval { return false }
if PresenceReport.wholeSeconds(lastInputAt) != lastReport.lastInputAt { return true }
return streamConnected && elapsed >= keepAliveInterval
```
```swift
// PresenceSensor.swift:40-42
guard policy.shouldReport(...) else { return }
lastReport = PresenceReport(lastInputAt: lastInputAt, sentAt: now)
try? await app.api.reportPresence(lastInputAt: lastInputAt)
```
服务端放置通知时看的是存储的 `lastInputAt`：
```ts
// device-notification-hub.ts:113-115
recent(nowMs, windowMs) {
  return [...this.#lastInput].filter(([, at]) => nowMs - at <= windowMs)
```
```ts
// mac-placement.ts:42-45
const devices = presence
  .recent(this.#options.nowMilliseconds(), this.#options.windowMilliseconds())
  .filter((deviceId) => hub.connected(deviceId))
```
**推测**：流连着且主人空闲超过 240 秒时，keepalive 在 K 时刻重发旧 `lastInputAt`；若主人在 K 后 15 秒内恢复输入，下一次上报要等到 K+15，期间服务端看到的仍是旧值，通知会被放到 iPhone。具体复现概率取决于恢复操作落在 keepalive 后的哪个位置，我未实际运行验证。

**建议**：在 `shouldReport` 里，对“时间变了”的输入增加旁路：如果 `now - lastReport.lastInputAt >= shortestServerWindow`，直接允许上报；或者把 keepalive 与变更上报的计时分开，不让 keepalive 刷新变更节流的时钟。并补一条“先有旧报告/保活，再恢复输入”的用例；现有新用例只覆盖从 `lastReport == nil` 开始持续输入，见第 3 条。

### 2. 中：第 7 轮第 1 条未改好，换设备重配对或“重新开始”后旧通知与 settled 仍会进入新设备
**文件:行**：`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:43,96-111,125-129`、`clients/apple/Sources/HimawariShell/AppModel.swift:260-278,365-367`、`clients/apple/Sources/HimawariCore/OwnerPresence.swift:29,41-49`

**问题**：增量完全没有改这条路径。`MenuBarModel` 在整个应用生命周期内只创建一次，`notices` 是长期内存状态；`receive` 不按设备过滤；`rememberSettled` 把内存中的旧 `settled` 合并进“当前设备库”，而 `startOver` 只 `retire()` 旧 store，不清理 `notices`，也不清理已经弹出的系统通知。新设备激活时会创建新的 `FileLocalStore` 实例，下一次 `rememberSettled` 会把旧设备的 settled id 写进新设备的 `settled-notices.json`。

**读代码证实**：
```swift
// MenuBarModel.swift:43
private(set) var notices = PendingNotifications()
// MenuBarModel.swift:125-129
guard let store = app.deviceStore, store !== settledStore else { return }
notices.remember(in: store)
settledStore = store
```
```swift
// AppModel.swift:260-278
public func startOver() {
    guard emptyStore() else { ... }
    cancelPairing()
}
private func emptyStore() -> Bool {
    chat?.stop()
    chat = nil
    actions = nil
    try (store ?? FileLocalStore.applicationSupport(named: "himawari-device")).retire()
    return true
}
```
```swift
// OwnerPresence.swift:29,41-49
public static let settledName = "settled-notices.json"
...
var merged = saved.filter { !settled.contains($0) }
merged.append(contentsOf: settled)
settled = Array(merged.suffix(Self.settledLimit))
...
save()
items.removeAll { settled.contains($0.id) }
```
新设备激活时 `AppModel.swift:365-367` 会新建 `FileLocalStore`，因此 `store !== settledStore` 成立。

**建议**：在 `startOver`、设备撤销、设备切换时清空 `MenuBarModel.notices`、移除 `ResultNotices` 已弹出的通知，并删除或按 `deviceId` 命名 `settled-notices.json`；增加一个“旧设备 settled/未处理通知 → 换新设备库”的测试。不能只清文件，因为内存里的 `notices.items` 和系统通知中心里的通知也会继续存在。

### 3. 中：自动检查没有绑定实际的 15 秒上报间隔，CI 里改回 60 秒仍会通过
**文件:行**：`test/tooling/mac-presence-window.test.ts:15-19`、`clients/apple/Sources/HimawariCore/OwnerPresence.swift:92-93`、`clients/apple/Tests/HimawariCoreTests/OwnerPresenceTests.swift:181-195`

**问题**：作者说“`test/tooling/mac-presence-window.test.ts` 把两端绑在一起”，但该测试只读取并比较 `shortestServerWindow` 这个**生产代码没有使用**的常量，完全没有读取实际生效的 `minimumInterval: 15`。真正检查行为的 Swift 用例 `whileTheOwnerKeepsTyping...` 不在 CI 里执行：我读了 `.github/workflows/ci.yml`、`scripts/ci/run.mjs`、`scripts/ci/build.mjs`，CI 的 build/tests/tooling 只跑 Node/Vitest，没有 `swift test`/`swift build`；`ci/policy.json` 的 build 成员也只有 `linux-x64`。因此只把 `minimumInterval` 改回 60 秒，CI 仍然全绿。这个测试的正则还会把 `= 30 * 2` 读成 30。

**读代码证实**：
```ts
// mac-presence-window.test.ts:16-18
const declared = /static let shortestServerWindow: TimeInterval = (\d+)\b/u.exec(source)?.[1];
expect(declared).toBeDefined();
expect(Number(declared)).toBe(DELIVERY_TIMING_RANGES.macPresenceSeconds[0]);
```
```swift
// OwnerPresence.swift:92-93
public static let shortestServerWindow: TimeInterval = 30
public static let standard = PresenceReportPolicy(minimumInterval: 15, keepAliveInterval: 240)
```
`shortestServerWindow` 的唯一使用端是测试；生产路径走的是 `minimumInterval`。

**推测**：可能存在仓库外的 macOS 流水线；但仓库内我没有找到，因此不能按“已有 CI 覆盖”来理解这条修复。

**建议**：让 `standard` 直接从 `shortestServerWindow` 推导（例如 `minimumInterval: shortestServerWindow / 2`），或者让 tooling 测试解析 `standard = PresenceReportPolicy(minimumInterval: ...)` 并断言它与服务端最小值的关系；同时在 Linux 上跑 `swift test --filter PresenceReportPolicyTests`（`Package.swift` 在 Linux 只编 `HimawariCore`，这个用例是 Foundation-only，可以跑）。另外，正则最好只接受纯字面量，避免 `30 * 2` 这类假通过。

### 4. 低：第 7 轮第 3 条未改好，settled 文件损坏或写失败仍被静默吞掉
**文件:行**：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:41-49,78-81`、`clients/apple/Sources/HimawariCore/LocalStore.swift:30-32`

**问题**：增量只改了 presence policy，没有碰这段。读取失败、文件不存在、JSON 损坏都得到 `nil`，被当成空数组；随后 `remember` 立即 `save()`，会把损坏内容覆盖掉。写入失败仍然 `try?` 吞掉。

**读代码证实**：
```swift
// OwnerPresence.swift:42
let saved = store.read(Self.settledName).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
...
save()
```
```swift
// OwnerPresence.swift:78-81
private func save() {
    guard let store, let data = try? JSONEncoder().encode(settled) else { return }
    try? store.write(Self.settledName, data)
}
```
```swift
// LocalStore.swift:30-32
public func read(_ name: String) -> Data? {
    lock.withLock { try? Data(contentsOf: directory.appendingPathComponent(name)) }
}
```
现有测试只覆盖“正常保存后重启”，没有覆盖损坏 JSON、读取失败或写入抛错。

**建议**：区分“文件不存在”和“读取/解码失败”；损坏时不要立即覆盖，至少先备份并保留旧内容；写入失败要能让调用方知道或重试。补一个损坏文件和写失败的负向测试。

### 5. 低：第 7 轮第 4 条未改好，列表高度变化仍会把用户滚回旧的 `revealedNotice`
**文件:行**：`clients/apple/Sources/HimawariMacUI/PanelView.swift:137,143-155`

**问题**：这次新增的是底部渐隐（`olderListAtBottom` + mask），没有改滚动逻辑。列表高度一变仍然调用 `scrollToRevealed(proxy)`；只要 `model.revealedNotice` 还保留着旧值，用户手动滚到别处后，内容高度变化会把他拉回旧的 reveal 位置。`olderListAtBottom` 只用于决定是否显示渐变，没有参与滚动判断。

**读代码证实**：
```swift
// PanelView.swift:137
.onChange(of: olderListHeight) { scrollToRevealed(proxy) }
```
```swift
// PanelView.swift:153-155
private func scrollToRevealed(_ proxy: ScrollViewProxy) {
    if let id = model.revealedNotice?.id { proxy.scrollTo(id, anchor: .top) }
}
```
```swift
// PanelView.swift:146
if !olderListAtBottom {
    LinearGradient(...)
}
```
**建议**：只在“用户明确要求 reveal”或“本来就在底部”时滚动；高度变化时不要滚动，或者把滚动限定在 `revealedNotice` 变化时。这个 UI 行为没有自动检查，补不了 UI 测试的话至少把滚动决策抽成可测的函数。

### 6. 低：材料中的“最多每 60 秒一次”与客户端的 15 秒最小间隔矛盾
**文件:行**：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:93`、`packages/platform-node/src/device-api-routes.ts:870-891`

**问题**：本次材料把合约写成“只在时间变了才报，最多每 60 秒一次”，但客户端现在输入变化时最快每 15 秒上报一次。当前服务端 presence 路由没有频率限制，所以功能上不会立刻失败；但这是明确的文档/合约与代码不一致。如果以后按“最多 60 秒一次”在服务端加限流，Mac 的在场上报会被拒绝。

**读代码证实**：
```swift
// OwnerPresence.swift:93
public static let standard = PresenceReportPolicy(minimumInterval: 15, keepAliveInterval: 240)
```
`device-api-routes.ts:870-891` 只做 Mac 校验、ISO 毫秒校验、未来时间夹取和 `record`，没有 `minimumInterval`/频率校验。仓库里的 `docs/execution/specs/2026-11-11-apple-device-body-design.md:767` 也没有写“60 秒上限”，只写了时间格式、范围和在场上报。

**建议**：二选一——更新合约文本为“输入变化时最快 15 秒一次”，或服务端加限流并把客户端一起调整。不要让合约和代码各自说一套。

## 侧重检查

我按错误路径、不可信输入、安全、资源耗尽、不可撤销操作、规则/文档一致性过了一遍增量：

- **在场输入与校验（读代码证实）**：客户端 `PresenceReport.lastInput` 拒绝负数、NaN、无穷大（`OwnerPresence.swift:129-132`）；服务端只允许 Mac（`device-api-routes.ts:872`），要求 ISO 毫秒并拒绝多余字段（`:878-883`），把未来时间夹到服务器当前时间（`:887-890`）。没有发现增量新增的注入或伪造入口。未改的旧行为是：已配对的 Mac 可以持续声称“现在有输入”，这不是本轮新增。
- **错误路径（读代码证实）**：上报失败仍被 `try?` 吞掉并提前记为已发（`PresenceSensor.swift:41-42`），服务端不可用时不会立刻重试；settled 读取/写入失败也仍被吞掉（第 4 条）。`startOver` 的 `retire()` 会不可撤销地删除本地目录；因为通知状态没清，旧 settled 会再次写进新设备库（第 2 条）。
- **资源（读代码证实）**：`minimumInterval=15` 使 `secondsUntilNextCheck` 的 tick 变成 3.75 秒（`OwnerPresence.swift:109`），持续输入时最多 4 次/分钟上报，是原来的 4 倍；服务端没有 presence 限流。不是无界增长，但电池/服务端负载的代价需要和“60 秒一次”的合约一起决定。
- **安全（读代码证实）**：通知 id 仍由服务端 `NOTIFICATION_ID` 校验（`device-api-routes.ts:76,903-904`）；系统通知标识前缀 `himawari.notice.` 与结果通知的 `identifier: id` 分开（`MenuBarController.swift:319,341`）；新 tooling 测试只读仓库内的 Swift 源文件，不接收外部输入。未发现新增安全问题。
- **规则/文档一致性（读代码证实）**：本次增量不碰提示词、工具定义、历史或遮盖；`check:apple-design` 会重新生成并逐字节比较 `DesignTokens.swift`，新增的 `noticeListFade` 两边一致（`tokens.json:267`、`DesignTokens.swift:205`）。不一致的是第 3 条的“两端绑定”说法和第 6 条的 60 秒合约。
- **未核实**：我未运行测试、未编译 macOS、未实际运行 UI；工作区没有第 7 轮的完整 review 文件（`.agents/reviews` 不在检出内容里），本轮第 7 轮意见以材料摘要为准。

## 作者说法核对

- 正确：`DeviceEventStream` 的退避重连（`DeviceEvents.swift:180-183`）；事件转发链 `ChatStore.onNotification`（`ChatStore.swift:367-368`）→ `AppModel.onDeviceNotification`（`AppModel.swift:169-170,384`）→ `MenuBarModel.receive`（`MenuBarController.swift:42`）。
- 正确：`minimumInterval` 已改为 15（`OwnerPresence.swift:93`）；tick 为 `minimumInterval/4`（`:109`）；失败也记为已发（`PresenceSensor.swift:41-42`）；settled 只留 500 条（`OwnerPresence.swift:28,71`）；系统通知标识为 `himawari.notice.<id>`（`MenuBarController.swift:319`）；面板有“知道了”按钮（`PanelView.swift:174-175`）。
- 不准确：`test/tooling/mac-presence-window.test.ts` 只绑定了 `shortestServerWindow`，没有绑定真正生效的 `minimumInterval`；CI 也不跑 Swift 行为测试（第 3 条）。
- 不准确：“配合服务端 `macPresenceSeconds` 最低 30 秒”默认了上一次报告的 `lastInputAt` 是新鲜的；keepalive 会重发旧的 `lastInputAt`，仍有 15 秒窗口（第 1 条）。
- 与代码不一致：材料中的“最多每 60 秒一次”与 15 秒实现矛盾（第 6 条）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 本轮增量不涉及。没有改系统提示、工具定义、历史消息或遮盖；presence 的 `lastInputAt` 是发给设备 API 的字段，不进入模型请求。因此“发给模型的内容只在末尾追加、每轮变化的值只放最后一条消息”这条规则在本轮没有被破坏；本轮与提示词前缀无关。依据规则 `.agents/instructions/prompt-prefix.md:27-29,36`。

2. **同一段文字会不会在不同请求里变成不同字节？** 本轮不涉及模型可见文本。presence 请求里的 `lastInputAt` 本来就会随时间变化，但它是显式的 API 字段，不是模型请求、也不是遮盖结果；`PendingNotifications.deliver` 的排序使用 `(createdAt, id)`（`OwnerPresence.swift:60-63`），是确定的；settled 文件是本地数组，不进入模型。若将来把 presence 数据放进模型请求，它必须只出现在最后一条消息里。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 部分有，但不够。`mac-presence-window.test.ts` 只能发现服务端范围与 `shortestServerWindow` 常量不一致；它不检查实际 `minimumInterval`，CI 也不执行 Swift 行为测试，所以把 `minimumInterval` 改回 60 秒 CI 仍会通过。Swift 用例 `whileTheOwnerKeepsTyping...` 能发现“持续输入时超过 30 秒”的回归，但没覆盖空闲后恢复输入的场景，现有 keepalive 触发的 15 秒窗口不会让它失败。第 4、5 条（settled 损坏/写失败、列表滚动）没有对应自动检查。

4. **每个产生或修改的值，使用端都能接受吗？**
   - `minimumInterval=15`：使用端是 `shouldReport`/`secondsUntilNextCheck` 和测试；服务端 presence 路由目前没有频率限制，能接受，但与材料的 60 秒合约冲突（第 6 条）。
   - `shortestServerWindow=30`：只被测试使用，和服务端 `DELIVERY_TIMING_RANGES.macPresenceSeconds[0]` 一致；生产代码不用它，属于“测试专用常量”，不能单独承担客户端 15 秒的约束。
   - `noticeListFade=24`：`tokens.json` 生成 `DesignTokens.swift` 的 `CGFloat`，`PanelView` 用在 `.frame(height:)`，类型和值都匹配；`check:apple-design` 会重新生成比对。
   - `lastInputAt` 序列化：客户端 `MessageSensing.timestamp` 输出毫秒 ISO，服务端 `ISO_MILLISECONDS` 接受；现有测试 `OwnerPresenceTests.swift:219-229` 也锁定了格式。
   - 通知 id/settled id：本轮没有修改产生端和校验端，服务端仍是 `[A-Za-z0-9_-]{1,64}`；未发现新的两端不匹配。

## 本轮查过的范围

- `git diff 3eafc66..ed5595` 的 stat 与代码/测试/令牌差异；确认增量只碰上面 6 个代码/测试/令牌文件。
- `OwnerPresence.swift`、`PresenceSensor.swift`、`PanelView.swift`、`MenuBarModel.swift`、`AppModel.swift`（`startOver`/`activate`）、`LocalStore.swift`、`DeviceEvents.swift`、`MenuBarController.swift`。
- 服务端 `device-notification-hub.ts`、`device-api-routes.ts` 的 presence 路由、`mac-placement.ts`、`delivery-timing.ts`。
- `test/tooling/mac-presence-window.test.ts`、`OwnerPresenceTests.swift`、`device-notifications.test.ts`、`ci/policy.json`、`.github/workflows/ci.yml`、`scripts/ci/run.mjs`、`scripts/ci/build.mjs`、`scripts/ci/test-scope.mjs`、`clients/apple/Package.swift`、`tokens.json`、`DesignTokens.swift`、`check-design.mjs`、`make-design-tokens.mjs`、`prompt-prefix.md`。
- 未查：第 7 轮完整 review 原文（工作区没有）；未运行任何测试或编译。
