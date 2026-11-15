本轮查过：`49ddccff` 的 11 个文件（`OwnerPresence.swift`、`DesignTokens.swift`、`MacDemoScenes.swift`、`MenuBarModel.swift`、`PanelView.swift`、3 份 `Localizable.strings`、`tokens.json`、2 个测试文件）；为核对上轮两条意见，跟到了 `LocalStore.swift`、`PairingDecisions.swift`、`AppModel.swift`、`MenuBarController.swift`。两次合入 `origin/main` 带进来的其他 PR 代码没有整份重审（未核实）。

### 1. 中：换设备重配对后，旧设备的 settled 和未处理通知仍会进入新设备（上轮第 3 条未改好）

文件：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:41`、`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:106`

问题：作者说上轮第 3 条已修改，但本轮增量没有改这两处。`remember(in:)` 把内存里的 `settled` 无条件追加到从新 store 读出的数组；`rememberSettled` 只要发现 `app.deviceStore` 换成新对象就会调用它。换设备时 `LocalStore.claim` 会清空新设备库，但 `MenuBarModel.notices` 里旧设备的内存状态不会清，旧设备的 settled 和未点掉的通知项都会带进新设备。

证据（读代码证实）：
```swift
// OwnerPresence.swift:42-48
let saved = store.read(Self.settledName).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
var merged = saved.filter { !settled.contains($0) }
merged.append(contentsOf: settled)
settled = Array(merged.suffix(Self.settledLimit))
self.store = store
save()
items.removeAll { settled.contains($0.id) }
```
```swift
// MenuBarModel.swift:106-109
guard let store = app.deviceStore, store !== settledStore else { return }
notices.remember(in: store)
settledStore = store
```
`OwnerPresenceTests.swift:107-121` 的 `noticesSettledBeforeTheStoreWasReadyAreKeptAndTheirRowsLeave` 仍把“把内存 settled 合并进另一个 store”当作正确行为。`git diff e4e63e4..49ddccf -- OwnerPresence.swift` 只显示 `createdDate`/`instant` 的重构，没有任何修复。

推测：新设备面板会继续显示旧设备未处理的通知，旧设备的 settled id 也会占用新设备的 500 个槽位；旧设备的系统通知也没有清空路径。

建议：给 `remember` 带上设备/owner 标识，标识变化时丢弃内存 `settled` 和 `items`；换设备时清空系统通知；把上述测试改成“换设备后旧 settled 不进新库”的反向用例。

### 2. 低：settled 文件读失败或损坏仍被当成空并立即覆盖，写入失败也被吞掉（上轮第 2 条未改好）

文件：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:42`、`:47`、`:78`、`clients/apple/Sources/HimawariCore/LocalStore.swift:30`

问题：这条同样没有修改。`store.read` 失败或 JSON 解码失败都得到 `[]`，随后 `save()` 无条件把空数组写回；`FileLocalStore.read` 用 `try?` 把“文件不存在”和“读失败”混成同一个 nil。`save()` 的写入失败也被 `try?` 吞掉。结果是损坏/读失败一次就会永久丢掉已收走的 id，重启或重发后可能再弹；写入失败时“重启后不再弹”的承诺也静默失效。

证据（读代码证实）：
```swift
// OwnerPresence.swift:42
let saved = store.read(Self.settledName).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
// :47
save()
// :78-80
private func save() {
    guard let store, let data = try? JSONEncoder().encode(settled) else { return }
    try? store.write(Self.settledName, data)
}
```
```swift
// LocalStore.swift:30-31
public func read(_ name: String) -> Data? {
    lock.withLock { try? Data(contentsOf: directory.appendingPathComponent(name)) }
}
```

推测：只有服务器再次发送同一 id 时才会重新弹；按 ADR 0273，服务重启后已放置未过期的通知会退回 iPhone，Mac 重连后是否重发取决于部署，未在本轮核实。

建议：用 `contains` 区分“文件不存在”和“存在但读不出/解码失败”；读失败时保留现有内容并不要覆盖，必要时把坏文件改名备份；`save` 返回错误或至少记录。补一个损坏文件的测试。

### 3. 低：点开被收起的旧通知时，面板不会展开或定位到那条通知（本次面板改动的新回归）

文件：`clients/apple/Sources/HimawariMacUI/MenuBarController.swift:36`、`:345`、`clients/apple/Sources/HimawariMacUI/PanelView.swift:18`

问题：现在面板默认只显示 `latestNotice`，更早的通知收在“还有 N 条通知”后面，`noticesExpanded` 默认 false。但系统通知点击仍然只调用 `openPanel?()`，没有把点击的 `noticeId` 传给面板，也没有展开列表或滚动到对应卡片。用户点开一条旧通知时，面板只显示最新一条，看不到自己刚点的那条。

证据（读代码证实）：
```swift
// MenuBarController.swift:36
notices.openPanel = { [weak self] in self?.showPanel() }
// :345-354
let isNotice = info["noticeId"] is String
...
if isNotice {
    if action == UNNotificationDefaultActionIdentifier { openPanel?() }
    return
}
```
```swift
// PanelView.swift:18-23
if let notice = model.latestNotice {
    card { noticeCard(notice) }
}
if !model.olderNotices.isEmpty {
    olderNotices
}
```
`openPanel` 类型是 `(() -> Void)?`，没有携带 id 的参数。

建议：把 `noticeId` 传给面板，展开 `olderNotices` 并滚动/高亮对应卡片；补一个“点旧通知后面板能看到它”的测试。

### 4. 低：“收到时间”显示的是服务器 `createdAt`，不是本地收到的时间（说明和代码不一致）

文件：`clients/apple/Sources/HimawariMacUI/PanelView.swift:132`、`clients/apple/Sources/HimawariCore/OwnerPresence.swift:9`、`apps/agent-service/src/production-web-push.ts:621`

问题：提交说明和作者说法都是“卡片标出收到时间”，但代码显示的 `notice.createdDate` 来自服务器下发的 `createdAt`。服务端在放置通知时写的是 `createdAt: item.createdAt`，这是通知进入待发表的时间，不是 Mac 实际收到的时刻；被送达时机延后或断线重连后补收的通知，显示的时间会偏早，最多可偏差送达时机的延后时长。

证据（读代码证实）：
```swift
// PanelView.swift:132-136
if let received = notice.createdDate {
    Text(received, format: .dateTime.hour().minute())
```
```swift
// OwnerPresence.swift:9
public let createdAt: String
// :20-24
public var createdDate: Date? { ... fractional.date(from: createdAt) ?? ISO8601DateFormatter().date(from: createdAt) }
```
```ts
// production-web-push.ts:621
createdAt: item.createdAt,
```

推测：如果产品要的是“本地收到时间”，当前实现没有记录该时刻，也没有持久化字段。

建议：在 `PendingNotifications.deliver` 时记录本地 `receivedAt` 并持久化，或者把界面文案改成“发出时间”；若要改语义，补一条延后/重连场景的测试。

## 侧重检查

- 错误路径：settled 读失败、JSON 损坏、写入失败（见意见 2）；`createdAt` 无法解析时 `createdDate` 返回 nil，面板只是不显示时间、排序落到 `distantPast`，这个降级可以接受；presence 上报失败先记 `lastReport`，作者说法与 `PresenceSensor.tick` 一致。
- 不合规范/不可信输入：`title`/`body` 都走 SwiftUI `Text` 渲染；通知 `id` 只作为 `ForEach` 标识和 `himawari.notice.<id>` 的通知标识，没有拼路径或执行命令；服务端 `NOTIFICATION_ID` 是 `^[A-Za-z0-9_-]{1,64}$`，Mac 流的 id 来自 `webPushTopic`（base64url），在这个范围内。`createdAt` 解析失败有降级。
- 安全：本增量没有新增网络请求、密钥或 APNs 登记；Apple 客户端里没有 `registerForRemoteNotifications` 或 `aps-environment`。
- 资源耗尽：`settled` 有 500 上限；`PendingNotifications.items` 本身没有上限，展开列表面板会一次渲染所有旧卡片，但这是既有行为（改动前也渲染全部通知），不算本次新增问题；流里的服务端 hub 队列有 200 条上限。
- 不可撤销操作：“知道了”/收走会把 id 永久写进本地 settled，没有撤销入口；按合约这是有意的，但 id 被复用时会永久静默，当前服务端 source key 含时间/状态，未发现复用。
- 规则和文档一致性：`noticeListMaxHeight` 在 `tokens.json` 和生成的 `DesignTokens.swift` 中一致（260）；三份本地化文件都有 `panel.moreNotices`/`panel.fewerNotices`；demo 场景名和 `mac-ui-review.sh` 的 `sed` 提取规则一致；ADR 0273 描述的“通知事件不写游标、Mac 不调用 `/notifications/settled`”和客户端代码一致。未核实 macOS 实际编译和截图结果。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 本 PR 增量不涉及模型请求组装：没有改系统提示、工具定义、历史或遮盖，新增的是 presence 上报和 SSE 通知的客户端展示。就本增量而言，不涉及“只追加”的判断。两次 merge 带进来的 `packages/prompt-catalog`、`production-think-*` 等改动属于其他 PR，本轮未核实。
2. **会不会让同一段文字在不同请求里变成不同的字节？** 不涉及。新增的 `createdDate`、面板计数和本地时间只用于界面显示，不进入发往模型的内容；通知事件也不写流游标。presence 的 `lastInputAt` 是独立的设备上报值，不参与模型请求。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有部分检查：Linux 的 `receivedTimeReadsBothTimestampShapesAndNothingElse` 会在解析过宽时失败；macOS 的 `onlyTheNewestNoticeIsShownAndTheCountIsTheOtherUndismissedOnes` 和 `theOlderListFoldsBackWhenNothingOlderIsLeft` 会在“最新一条/收起”逻辑错误时失败。但这两个 macOS 测试在 Linux 门禁里不编译、不运行，本环境无法验证 Mac 运行结果；也没有测试覆盖 `dismiss` 的收起分支、点旧通知定位、损坏 settled 文件、换设备重配对。上轮两条低意见没有新增反向用例，且现有 `noticesSettledBeforeTheStoreWasReadyAreKeptAndTheirRowsLeave` 反而把跨设备合并断言成正确行为，真正修复时必须同步改掉它。
4. **每个新值的使用端都能接受吗？** 逐个核对：`DeviceNotification.createdDate` 是可选 `Date`，`instant` 接受并回退 `.distantPast`，`PanelView` 接受 nil（不显示时间）；`DesignTokens.Mac.noticeListMaxHeight` 是 `CGFloat = 260`，`PanelView` 用在 `min(olderListHeight, ...)`，类型和来源（`tokens.json`）一致；`panel.moreNotices` 的 `%d` 由 `L.format` 传入 `Int`，三份语言文件都有，`panel.fewerNotices` 无格式参数；`noticesExpanded` 是 Bool，demo 初始化和视图都接受；`mac-4d-panel-notices-open` 被 `mac-ui-review.sh` 的 `sed` 和截图脚本按“所有 case”自动收集。服务端 `presence` 的 `ISO_MILLISECONDS` 与客户端生成的 `2027-01-15T08:00:00.000Z` 形式一致；Mac 保存的通知 id 如果将来送给 `/notifications/settled`，也满足 `^[A-Za-z0-9_-]{1,64}$`。两端不接受的问题只有意见 3（点击通知没有把 id 交给面板）和意见 4（“收到时间”的语义）。
