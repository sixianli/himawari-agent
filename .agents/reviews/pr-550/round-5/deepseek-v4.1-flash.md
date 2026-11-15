本轮只按增量 `49ddccf..0862143` 复核，并沿证据追到未改动的旧代码（`OwnerPresence.swift`、`AppModel.swift`、`PairingDecisions.swift`、`PanelView.swift`）。作者说法与代码基本一致，但“三条上一轮意见都已改好”不成立：增量只改了第 3 条的一半，第 1、2 条代码未动、仍可复现。

### 1. 中：换设备重配对后，旧设备的 settled 和未处理通知仍会进入新设备（上轮第 1 条未改好）
文件:行：`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:110`、`clients/apple/Sources/HimawariCore/OwnerPresence.swift:41`、`clients/apple/Sources/HimawariShell/AppModel.swift:365`、`clients/apple/Sources/HimawariCore/PairingDecisions.swift:63`

问题：重配对时 `AppModel.activate()` 会新建一个 `FileLocalStore` 并用 `claim(for:)` 清盘，但 `MenuBarModel` 不会被重建，内存里的 `PendingNotifications` 仍保留旧设备的 settled 和未处理条目。下一次收到事件时 `rememberSettled()` 发现 store 身份变了，就把内存里的旧 settled 合并写进新设备的文件；未 settled 的旧通知则继续留在 `items` 里显示。

证据（已读代码）：
```swift
// MenuBarModel.swift:110-113
private func rememberSettled() {
    guard let store = app.deviceStore, store !== settledStore else { return }
    notices.remember(in: store)
    settledStore = store
}
// OwnerPresence.swift:42-48
let saved = store.read(Self.settledName).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
var merged = saved.filter { !settled.contains($0) }
merged.append(contentsOf: settled)          // 旧 settled 被写回新 store
...
items.removeAll { settled.contains($0.id) } // 只去掉旧的已 settled，旧未处理仍留着
// AppModel.swift:365-367
let store = try FileLocalStore.applicationSupport(named: "himawari-device")
try store.claim(for: record.deviceId)       // PairingDecisions.swift:70: try removeAll()
self.store = store
```
`MacAppDelegate.swift:25-26` 只在启动时创建一次 `MenuBarModel`/`MenuBarController`，重配对不会换新。

建议：把 notices 的所有权与“设备/owner”绑定。重配对或 `deviceStore` 身份变化时，先清空内存 `notices`（或重新从新 store 读取），再调用 `remember`；不要让内存里的旧 settled 参与合并。补一个“换 owner 后旧 settled/旧未处理不出现”的测试。

### 2. 低：settled 文件读失败或损坏仍被当成空并立即覆盖，写入失败也被吞掉（上轮第 2 条未改好）
文件:行：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:42`、`clients/apple/Sources/HimawariCore/OwnerPresence.swift:78`、`clients/apple/Sources/HimawariCore/LocalStore.swift:30`

问题：`read` 用 `try?` 把 IO 错误吞成 `nil`；`remember` 又把 `nil` 和“解码失败”都归成 `[]`，随后无条件 `save()` 覆盖文件。写入也用 `try?` 吞错。结果是损坏/暂时读不到时，持久化的 settled 被当成空的覆盖掉，重启后已点掉的通知会再次弹出；写失败时内存与磁盘静默分叉。

证据（已读代码）：
```swift
// OwnerPresence.swift:42
let saved = store.read(Self.settledName).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
// OwnerPresence.swift:78-81
private func save() {
    guard let store, let data = try? JSONEncoder().encode(settled) else { return }
    try? store.write(Self.settledName, data)
}
// LocalStore.swift:30-32
public func read(_ name: String) -> Data? {
    lock.withLock { try? Data(contentsOf: directory.appendingPathComponent(name)) }
}
```
建议：区分“文件不存在”和“读失败/解码失败”。损坏时不要覆盖，保留原文件并报错/记录；写入失败不要静默，让调用端知道。补损坏文件与写入失败的测试。

### 3. 低：`reveal` 只展开列表、不滚动定位，列表超过 260pt 时被点的旧通知仍可能看不到（上轮第 3 条只改好一半）
文件:行：`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:83`、`clients/apple/Sources/HimawariMacUI/PanelView.swift:117`、`clients/apple/Sources/HimawariDesign/Generated/DesignTokens.swift:205`、`clients/apple/Tests/HimawariMacUITests/NoticeAndPresenceTests.swift:98`

问题：增量把 `noticeId` 传到面板并展开了“还有 N 条通知”，但没有把被点的那条滚进可视区。旧通知按时间倒序排在可滚动列表里，容器最高 260pt；旧通知较多时，被点的条目仍可能在列表下方看不见。上轮意见是“不展开**或定位**”，这次只解决了展开。

证据（已读代码）：
```swift
// MenuBarModel.swift:83-85
func reveal(_ id: String) {
    if olderNotices.contains(where: { $0.id == id }) { noticesExpanded = true }
}
// PanelView.swift:117-127
if model.noticesExpanded {
    ScrollView {
        VStack { ForEach(model.olderNotices) { notice in card { noticeCard(notice) } } }
        ...
    }
    .frame(height: min(olderListHeight, DesignTokens.Mac.noticeListMaxHeight)) // 260pt
}
// NoticeAndPresenceTests.swift:98-109 只断言 noticesExpanded，不断言被点条目可见/已滚动
```
建议：用 `ScrollViewReader` + `scrollTo(id, anchor:)`（或记录待定位 id，在展开后滚动并短暂高亮）。补一个“列表超过最大高度时被点条目仍可见”的测试。

**侧重检查**

- 错误路径（已读代码）：tapping 的通知 id 不在 `olderNotices`、已被 withdraw、是最新一条时，`reveal` 都是安全 no-op；`showPanel()` 在已展开时也安全返回。未发现崩溃路径。
- 不可信输入/安全（已读代码）：`noticeId` 来自本 App 自己写入的 `userInfo`；`reveal` 只做字符串相等比较，不拼路径、不进查询，无注入面。服务端给的 `id/title/body` 只用于通知标识、相等比较和 `Text` 展示。真正的安全问题是第 1 条：换设备后旧设备通知会串到新设备。
- 资源耗尽（已读 + 推测）：`PendingNotifications.items` 没有条数上限，只有 settled 限 500；本次 `reveal` 会自动展开并渲染全部 older 卡片，长期不点“知道了”时可能较重。这是 49ddcc 起就有的行为，本增量只是更容易触发，未列为独立意见。
- 不可撤销操作（已读代码）：本增量没有删除/发送类操作；“知道了”仅本地移除并落 settled，系统通知用 `himawari.notice.<id>` 精确移除，未新增不可撤销动作。
- 规则/文档一致性（已读代码）：增量未加代码注释，符合约束；作者说“点通知打开面板”属实，但“定位”未实现（第 3 条）；“重启后重发不再弹”只在 settled 文件可读时成立（第 2 条）。提交信息也自述 Swift 测试未跑。

**必答问题**

1. 不涉及。本轮增量只改 `HimawariMacUI` 的本地通知/面板（`MenuBarController.swift`、`MenuBarModel.swift` 及 macOS 测试），没有触及系统提示、工具定义、历史消息或遮盖；因此发给模型的内容仍只在末尾追加、每轮变化值仍与请求开头无关，请求开头不受影响。未重新核验 prompt-prefix 全链路（与本增量无关）。
2. 不涉及。`reveal` 只改本地 `noticesExpanded` 布尔值，不产生或改动任何发给模型的文字/序列化字节；没有依赖前后文的遮盖、时间字段或无序集合进入请求。
3. 有新增检查，但覆盖不足。`NoticeAndPresenceTests.swift:98-109` 会验 `reveal` 的展开行为，去掉展开逻辑会失败；但它不测 `ResultNotices.didReceive → openPanel → reveal` 的接线（把控制器里的 `model.reveal(id)` 删掉测试仍绿），也不测滚动定位。第 1、2 条没有对应自动检查（现有测试只覆盖正常文件读写和正常重启）。另外新测试在 `HimawariMacUITests`，只在 macOS 编译；仓库 `.github/workflows` 里没找到 macOS 运行器，提交信息也说“待 Mac 跑”，所以自动检查实际未在 CI 执行。
4. 增量产生的值逐个核对过：`MenuBarModel.reveal(String)` 只在 `MenuBarController.swift:37` 和测试 `NoticeAndPresenceTests.swift:102/104/106` 使用；`ResultNotices.openPanel` 从 `() -> Void` 改为 `(String) -> Void`，赋值点在 `MenuBarController.swift:36`、调用点在 `:356`，全仓库别无他用；`noticeId` 由 `show()` 写入 `userInfo`（`:325`），由 `didReceive` 以 `as? String` 读回（`:351`），两端类型一致；通知标识 `himawari.notice.<id>` 在 `show`/`withdraw` 两处一致。就增量本身而言两端都能接受。但第 1 条说明 settled 这个值的“产生处/使用处”跨了设备生命周期，增量没有核对这一点。

本轮查过的范围：`49ddccf..0862143` 全部 8 个文件（3 个 Apple 代码 + 复核记录），并沿线索读了 `MenuBarModel.swift`、`MenuBarController.swift`、`PanelView.swift`、`OwnerPresence.swift`、`LocalStore.swift`、`AppModel.swift`、`PairingDecisions.swift`、`PresenceSensor.swift`、`DeviceEvents.swift`、`ChatStore.swift` 改动段、`NoticeAndPresenceTests.swift`、`OwnerPresenceTests.swift` 及 `DesignTokens.swift` 的 260pt 常量；用 grep 核对了 `openPanel`/`reveal`/`noticeId` 的全部使用点和 CI 工作流。未重新通读与增量无关的服务器端和提示词代码。
