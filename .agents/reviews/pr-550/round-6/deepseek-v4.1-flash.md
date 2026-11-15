复核范围：增量只有 `673b5ba33`（reveal 滚动）和 `79c625848`（第 5 轮记录），代码只改了 `MenuBarModel.swift`、`PanelView.swift`、`NoticeAndPresenceTests.swift`。另对照了 `OwnerPresence.swift`、`LocalStore.swift`、`AppModel.swift`、`MenuBarController.swift`、`PresenceSensor.swift`、`DeviceEvents.swift` 和 `prompt-prefix.md`。第 5 轮原始记录在本次 sparse checkout 中不存在，`git show` 对 records 路径也被仓库拒绝，因此未读到原文，只按材料摘要核对。未运行测试。

## 上一轮意见核对结果

- 上轮第 3 条（reveal 只展开、不滚动）：主路径已改好，模型状态和 `scrollTo` 已接上；但引入新副作用，见意见 3，且没有能验证滚动的自动检查，见意见 4。
- 上轮第 1 条（换设备重配对后旧设备 settled 和未处理通知仍进入新设备）：未改好，见意见 1。
- 上轮第 2 条（settled 读失败/损坏被当成空并覆盖、写失败被吞）：未改好，见意见 2。
- 材料说“作者已修改”这三条，但 `086214..673b` 没有改 `OwnerPresence.swift`、`AppModel.swift`、`LocalStore.swift`；这个说法与增量不符。

### 1. 中：换设备重配对或“重新开始”后，旧设备的未处理通知和 settled 仍会进入新设备

文件:行：`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:43`、`96-100`、`125-129`；`clients/apple/Sources/HimawariCore/OwnerPresence.swift:41-48`；`clients/apple/Sources/HimawariCore/PairingDecisions.swift:63-71`；`clients/apple/Sources/HimawariShell/AppModel.swift:268-274`、`365-367`

问题：`MenuBarModel` 在应用生命周期内只创建一次，重新配对时既不重置内存里的 `notices.items`，也不丢弃旧设备的 `settled`。新设备 store 的 `claim` 虽然会 `removeAll()`，下一次 `rememberSettled()` 又把旧设备内存里的 settled 合并写回新设备库，等于绕过清库。

证据（读代码证实）：

```swift
// MenuBarModel.swift:43
private(set) var notices = PendingNotifications()

// MenuBarModel.swift:125-129
private func rememberSettled() {
    guard let store = app.deviceStore, store !== settledStore else { return }
    notices.remember(in: store)
    settledStore = store
}
```

```swift
// OwnerPresence.swift:41-48
public mutating func remember(in store: LocalStore) {
    let saved = store.read(Self.settledName).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
    var merged = saved.filter { !settled.contains($0) }
    merged.append(contentsOf: settled)
    ...
    items.removeAll { settled.contains($0.id) }
}
```

```swift
// PairingDecisions.swift:63-71
public func claim(for owner: String) throws {
    ...
    try removeAll()
    try write(Self.ownerName, mark)
}
```

`AppModel.emptyStore()` 只 `retire()` 旧 store，没有通知 `MenuBarModel` 清理；`activate()` 再创建新 store。之后第一条通知事件就会走上面的合并逻辑。

推测（未在真机验证）：结果是重配对后旧设备的通知标题/正文还留在面板里，“重新开始”也没有真正清掉这些内容；旧 settled id 还会写进新设备的 `settled-notices.json`，如果新设备出现相同 id 会被静默压掉。这既是错误行为，也是隐私/清库语义不一致。

建议：把“设备身份”显式传给 `MenuBarModel`（例如 `AppModel` 暴露当前 owner/deviceId 或配对代次），存库变化且设备身份变化时重建 `PendingNotifications(rememberingIn: store)` 并清空 `items`；`emptyStore()`/重新配对时也要主动清空面板内存状态。只有首次从 nil 挂到当前设备 store 时才允许合并内存 settled。

### 2. 低：settled 文件读失败或损坏仍被当成空并立即覆盖，写入失败仍被吞掉

文件:行：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:41-49`、`78-80`；`clients/apple/Sources/HimawariCore/LocalStore.swift:30-32`、`42-55`

问题：`store.read(...)` 读失败和 JSON 解码失败都被 `?? []` 归为“没有已 settled 的通知”，随后立刻 `save()`。一次瞬时读错误即使文件本身完好，也会被写成 `[]`，永久丢掉最多 500 个 id；`write` 抛出的错误又被 `try?` 吞掉，界面表现为已 settled，重启后又会重新弹。

证据（读代码证实）：

```swift
// OwnerPresence.swift:42
let saved = store.read(Self.settledName).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
// OwnerPresence.swift:47
save()
// OwnerPresence.swift:78-80
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

建议：区分“文件不存在”和“存在但读/解码失败”；后者不要覆盖，保留内存中的 settled 并让调用方知道失败。`save` 应返回或抛出失败，至少不要把写失败当成已持久化。

### 3. 低：增量新增的“列表高度一变就滚动”会把用户从手动位置拉回旧的 revealedNotice

文件:行：`clients/apple/Sources/HimawariMacUI/PanelView.swift:128-137`；`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:85-88`、`105`、`117`、`121-123`

问题：`revealedNotice` 在完成一次滚动后不会消费掉；而 `olderListHeight` 每次变化都会再次 `scrollToRevealed`。用户点开旧通知后自己滚到别处，只要又有新通知到达（旧列表多一张卡）或有 `withdraw` 移除一张卡，列表高度变化就会把视图拽回之前那条。

证据（读代码证实）：

```swift
// PanelView.swift:129-130
.onChange(of: olderListHeight) { scrollToRevealed(proxy) }
.onChange(of: model.revealedNotice, initial: true) { scrollToRevealed(proxy) }

// PanelView.swift:135-137
private func scrollToRevealed(_ proxy: ScrollViewProxy) {
    if let id = model.revealedNotice?.id { proxy.scrollTo(id, anchor: .top) }
}
```

`revealedNotice` 只在 `toggleOlderNotices`、撤销/ dismissing 同一条时清空（`MenuBarModel.swift:85-88,105,117,121-123`）；滚完不会清。

推测（未在 macOS 上运行验证 UI）：上述触发条件由代码可以确定，实际视觉表现是列表被拉回旧目标。

此外，若 revealed 的那条因为最新一条被“知道了”而变成 `latestNotice`，它已不在 `olderNotices`/`ForEach` 里，`scrollTo` 会指向不存在的 id（SwiftUI 通常是 no-op），但 `revealedNotice` 仍留着，后续高度变化还会再触发。建议把 reveal 做成一次性消费（滚动后清空，或单独的 `pendingReveal`），并且只在目标仍在 `olderNotices` 时保留。

### 4. 低：滚动修复没有能验证滚动的自动检查，删掉滚动代码测试仍会通过

文件:行：`clients/apple/Tests/HimawariMacUITests/NoticeAndPresenceTests.swift:113-131`；`clients/apple/Sources/HimawariMacUI/PanelView.swift:135-137`

问题：新测试名字是“列表滚到被点的那条”，但只调用 `menu.reveal(...)` 并断言 `menu.revealedNotice`/`olderNotices`，完全没有实例化 `PanelView`，也没有检查 `scrollToRevealed`。把两个 `onChange` 或 `scrollToRevealed` 整个删掉，这个测试仍然通过，所以它对“滚动”这个修复没有反向保护。

证据（读代码证实）：测试只断言模型值，例如：

```swift
menu.reveal("n-1")
#expect(menu.revealedNotice?.id == "n-1")
...
#expect(menu.revealedNotice == NoticeReveal(id: "n-3", serial: 2))
```

建议：加能触达视图的检查（例如现有 `mac-ui-review` 场景构造超过 260pt 的旧列表并截图/断言可见项），或把“该滚到哪个 id”抽成可测的纯函数并补反向用例；同时明确删掉滚动实现时用例必须失败。旧问题 1、2 也没有对应测试（`OwnerPresenceTests.swift` 没有损坏文件、写失败、换设备重配的用例）。

## 侧重检查

- 错误路径：settled 读/解码失败被当空并覆盖、写失败被吞（意见 2）；presence 上报失败先记 `lastReport` 再发（`PresenceSensor.swift:41-42`），这是作者说明里“避免反复 404”的有意行为，未见新问题。
- 不可信输入：`DeviceNotification` 的 id/title/body/createdAt 来自流；`createdAt` 解析失败返回 nil、卡片仍显示标题正文（`OwnerPresence.swift:20-24`、`PanelView.swift:141`）；id 只在通过 `olderNotices` 校验后作为 SwiftUI `.id`/`scrollTo` 目标，未发现注入或崩溃路径。
- 安全与隐私：重配对/“重新开始”会把旧设备通知正文和 settled 带到新设备（意见 1）；系统通知标识 `himawari.notice.<id>` 与结果通知 id 分开（`MenuBarController.swift:319`、`341`）；未发现 `registerForRemoteNotifications` 等苹果推送登记。
- 资源耗尽：旧列表用非惰性的 `VStack`/`ForEach`（`PanelView.swift:119-125`），`PendingNotifications.items` 也没有上限（`OwnerPresence.swift:31`、`52-64`），大量通知时内存/渲染成本无界；这是前几轮已有代码，本次增量没有改变，仅记录未作为新意见。
- 不可撤销操作：`dismiss`/`withdraw` 会写 settled 且失败不告知（意见 2），用户会误以为已永久拿掉。
- 规则与文档一致性：增量没有加代码注释，符合约束；但作者“三条都已修改”与 diff 不符，测试名也夸大了实际覆盖范围。

## 作者说法核对

- “第 1 点由现有 DeviceEventStream 满足（已有退避重连）”：属实，`DeviceEvents.swift:180-183` 是 `0.5 * 2^failures`，上限 30 秒。
- “PresenceSensor 每 minimumInterval/4 秒读一次，临近保活期限提前醒，失败也记为已发”：与代码一致（`PresenceSensor.swift:20-43`、`OwnerPresence.swift:99-113`）。
- “settled 只留最近 500 条”：上限属实（`settledLimit = 500`），但读写健壮性见意见 2。
- “系统通知标识 `himawari.notice.<id>`，和结果通知分开；点通知打开面板”：属实（`MenuBarController.swift:319-333`、`355-357`、`36-39`）。
- “上一轮三条都已修改”：与代码不符，只改了 reveal 滚动；第 1、2 条相关文件在增量中没有任何变化。

## 必答问题

1. 不会。本次增量只改 macOS 面板和测试，没有构造或修改发给模型的内容；系统提示、工具定义、历史消息、遮盖结果都不涉及，因此不存在往开头插入或改写已发内容的问题（依据 `prompt-prefix.md` 第 2、4 节）。增量之外的基础差异里有提示词目录等改动，但属于其他改动，本次未重读，标“未核实”。
2. 不会。增量产生的新值只有内存 UI 状态 `NoticeReveal(id, serial)` 和本地显示的 `createdAt`；它们不进入模型请求，也不参与遮盖或 JSON 序列化。没有依赖前后文的字节变化，没有无序集合进入请求。
3. 不充分。新增测试只覆盖 `MenuBarModel` 的 `revealedNotice` 状态，不覆盖 `PanelView.scrollToRevealed`，反向改动不会让用例失败（意见 4）；第 1、2 条旧问题没有测试。因此“修复已被自动检查证明”不成立。
4. 增量产生/修改的值逐个核对：
   - `NoticeReveal(id, serial)`：产生在 `MenuBarModel.swift:93`，`id` 先经 `olderNotices.contains` 校验（`:91`）；使用端是 `PanelView.swift:130` 的 `onChange` 和 `:136` 的 `scrollTo`，以及测试。`onChange` 接受 `Equatable`，`scrollTo` 接受 `Hashable` 且目标来自 `ForEach` 的 `.id(notice.id)`（`:123`）。两端类型都能接受；但列表在 reveal 与滚动之间可能变化，目标可能已不在 `olderNotices`，此时只是 no-op，不会崩溃，语义不保证（意见 3）。
   - `revealedNotice`：`private(set)`，只被 `PanelView` 和本文件/测试使用，没有导出、配置键或持久化格式。
   - `forgetReveal`、`scrollToRevealed`：均为私有，使用端只有本文件。
   - 没有新增导出函数、配置键、字段或序列化格式，因此不存在外部使用端接受不了的增量值。
