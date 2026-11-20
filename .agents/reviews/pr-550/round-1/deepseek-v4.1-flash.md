### 1. 中：无法解码的 `notification.*` 事件仍会把 id 存成游标，通知可能丢

- 文件:行：`clients/apple/Sources/HimawariCore/DeviceEvents.swift:151-152`
- 问题：是否跳过游标保存，取决于“解码结果是不是通知”，而不是事件名。只要通知载荷解码失败，`decoded` 为 `nil`，`isNotification` 就被当成 `false`，带 id 的通知事件仍会推进游标。这直接违反合约“通知事件即使收到 id 行也不存成游标”。
- 证据：
```swift
let decoded = DeviceEventDecoder.decode(event)
if let id = event.id, !id.isEmpty, !(decoded?.isNotification ?? false) { self.cursors?.save(id) }
```
- 建议：按 `event.event` 判断，例如 `event.event == "notification.deliver" || event.event == "notification.withdraw"`，不要依赖解码成功；在 `OwnerPresenceTests` 里加一条“格式坏掉的 notification.deliver 带 id 行”用例，断言 `cursor.saved` 不增加。当前代码在这条用例下会失败。
- 分类：读代码证实。

### 2. 中：“同一事件重发不会再弹”只在通知还留在内存时成立；点过“知道了”或收到 withdraw 后重发会再弹

- 文件:行：`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:86-89`、`clients/apple/Sources/HimawariCore/OwnerPresence.swift:27-35`、`38-42`
- 问题：`deliver` 只有在同一 id 的条目仍留在 `items` 里、且内容完全相同才返回 `false`。用户点“知道了”或收到 withdraw 后条目被删除，之后再收到同一个 `notification.deliver` 会重新 `append`、返回 `true`，`showNotice` 会再弹一次。提交说明写“同一事件重发不会再弹”，这句话在这种情况下不成立；代码也没有记录“已忽略/已收走”的 id。
- 证据：
```swift
func dismiss(_ notice: DeviceNotification) {
    notices.withdraw(notice.id)
    removeNotice?(notice.id)
}
```
```swift
public mutating func deliver(_ notification: DeviceNotification) -> Bool {
    if let index = items.firstIndex(where: { $0.id == notification.id }) {
        guard items[index] != notification else { return false }
        items[index] = notification
    } else {
        items.append(notification)
    }
```
- 建议：保留一份本次会话的 dismissed/withdrawn id 集合（或持久化），重发同 id 时不再展示；如果要跨重启也成立，需要和服务器确认通知是否重放，并决定是否持久化。补一条 `deliver → dismiss → deliver` 的测试。
- 分类：读代码证实代码行为；服务器是否重发未核实，但提交说明已把“同一事件重发”当作应处理的场景。

### 3. 中（推测）：负数或 0 的系统空闲时间会被当成“刚刚有操作”

- 文件:行：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:78-80`、`clients/apple/Sources/HimawariMacUI/PresenceSensor.swift:46-48`
- 问题：`max(0, secondsSinceInput)` 会把负数空闲时间截成 0，而 0 又被解释成“输入就在刚才”。如果 `CGEventSource.secondsSinceLastEventType` 在无权限、读取失败或“从未有事件”时返回 0/-1，Mac 会被错误上报成“主人正在操作”，服务器可能把提醒只发给 Mac。
- 证据：
```swift
public static func lastInput(secondsSinceInput: TimeInterval, now: Date) -> Date {
    wholeSeconds(now.addingTimeInterval(-max(0, secondsSinceInput)))
}
```
```swift
static func secondsSinceInput() -> TimeInterval? {
    guard let anyInput = CGEventType(rawValue: ~0) else { return nil }
    return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
}
```
- 建议：负数当作未知并跳过上报；0 是否代表“刚刚输入”需要在 macOS 真机核实。补边界测试，至少覆盖负数和 0。
- 分类：代码路径读代码证实；`CGEventSource` 的错误返回值行为未核实，属于推测。

### 4. 低：4 分钟保活实际可能超过 4 分钟

- 文件:行：`clients/apple/Sources/HimawariMacUI/PresenceSensor.swift:20-27`、`clients/apple/Sources/HimawariCore/OwnerPresence.swift:56-62`
- 问题：策略只在每 15 秒一次的 tick 里检查 `elapsed >= keepAliveInterval`，而循环周期是“上一次 tick 的执行时间 + 15 秒”。保活到期时可能刚好错过 tick，下一次 tick 才发送；如果 `reportPresence` 本身耗时，间隔会再拉长。因此“流连着时每 4 分钟至少补报一次”在实现上不是严格保证。
- 证据：
```swift
await tick()
try? await Task.sleep(for: .seconds(max(policy.minimumInterval / 4, 1)))
```
```swift
return streamConnected && elapsed >= keepAliveInterval
```
- 建议：按 `lastReport.sentAt + keepAliveInterval` 计算下一次到期时间，到期前用更短的 sleep；或者给保活留出明确的容差并写进契约。补一条调度测试，而不是只测 `shouldReport` 在恰好 240 秒时返回 true。
- 分类：读代码证实。影响取决于服务器对 4 分钟窗口的容差，服务器端未写。

### 5. 低：通知列表和标题/正文没有上限，坏服务器或重发可耗尽内存和面板

- 文件:行：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:27-35`、`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:38`、`clients/apple/Sources/HimawariMacUI/PanelView.swift:17-19`
- 问题：`PendingNotifications.items` 无数量上限，`title`/`body` 无长度上限；每来一个不同 id 就加一条系统通知并渲染一张卡片。服务器若重复生成新 id、或发送超长文字，内存、面板和通知中心都会被持续占用。
- 证据：
```swift
} else {
    items.append(notification)
}
items.sort { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
```
```swift
ForEach(model.shownNotices) { notice in
    card { noticeCard(notice) }
}
```
- 建议：在客户端设数量上限和文字长度上限，超过时丢弃或截断并记录；同时在服务器合约里规定上限。补反向测试。
- 分类：读代码证实没有上限；触发需要服务器异常或恶意输入。

### 6. 低：新测试自建了假的 `CursorStore`，与“测试不许假替身”不一致

- 文件:行：`clients/apple/Tests/HimawariCoreTests/OwnerPresenceTests.swift:8-19`、`47-56`
- 问题：作者的材料里写“测试不许假替身”，但新测试新增了 `MemoryCursor` 这个假的 `CursorStore`；仓库里已有真实的 `MemoryLocalStore` 和 `StoredCursor`，可以直接用来验证游标是否被保存。
- 证据：
```swift
private final class MemoryCursor: CursorStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    private(set) var saved: [String?] = []
```
```swift
let cursor = MemoryCursor()
let stream = DeviceEventStream(http: http, cursors: cursor, heartbeat: { 30 })
```
- 建议：用 `MemoryLocalStore` + `StoredCursor`，通过 `load()` 断言游标；如果必须观察每次保存，再考虑在真实 store 外包一层记录，而不是自己写一个假 CursorStore。`RecordingExchange` 是既有测试设施，不在此条意见范围内。
- 分类：读代码证实，属于约束/规则一致性。

### 7. 低：`createdAt` 用字符串排序，格式一旦有偏差，“最新在前”就会排错

- 文件:行：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:34`
- 问题：`createdAt` 是 `String`，直接按字典序比较。只有服务器严格使用同一种 ISO 8601 UTC 毫秒格式时，字典序才等同于时间顺序；`"2026-11-15T05:35:00Z"` 和 `"2026-11-15T05:35:00.500Z"` 会因为 `'Z'` 和 `'.'` 的字符顺序排错。客户端没有解析或校验这个字段。
- 证据：
```swift
items.sort { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
```
- 建议：解码成 `Date`（带 ISO8601 formatter 和失败回退），或统一规范化后再排序；补一条混合格式的测试。
- 分类：代码行为读代码证实；实际影响取决于服务器格式，服务器端未写。

## 作者说法核对

- “DeviceEventStream 已有退避重连”：代码里确有 `DeviceEventStream.backoff` 和重连循环（`DeviceEvents.swift:119-142`、`185-188`），这一点成立。不过本次除了转发事件，还改了通知事件的游标规则，不只是“事件转发”。
- “PresenceSensor 每 minimumInterval/4 秒读一次空闲时间”：成立，标准策略下是 15 秒（`PresenceSensor.swift:26`）。
- “上报失败也记为已发”：代码在 `await reportPresence` 之前先写 `lastReport`（`PresenceSensor.swift:42-43`），行为成立；但没有自动测试证明失败路径，且失败原因被 `try?` 完全吞掉。
- “系统通知标识 `himawari.notice.<id>`，和结果通知分开”：成立。新通知用前缀（`MenuBarController.swift:316`），结果通知仍用原始 id（`MenuBarController.swift:338`），两者不会因为前缀自动冲突。
- “点通知打开面板”：成立，`didReceive` 对带 `noticeId` 的通知在默认动作时调用 `openPanel`（`MenuBarController.swift:348-354`）。
- “通知事件即使带 id 行也不当游标”：只对能解码的通知成立；解码失败时仍会保存（见意见 1）。
- “同一事件重发不会再弹”：不成立，见意见 2。
- “流连着时每 4 分钟至少补报一次”：策略在 240 秒时返回 true，但实际调度可能超过 240 秒，见意见 4。
- “测试不许假替身”：新增的 `MemoryCursor` 是假的 `CursorStore`，见意见 6。
- “服务器端还没写”：与仓库一致，因此 `homeKey`、`lastInputAt`、`serverTime`、通知重放语义都无法在仓库内完成两端核对，见必答问题 4。

## 侧重检查

我优先检查了错误路径、不可信输入、安全、资源耗尽、不可撤销操作，以及规则/文档与代码的一致性：

- 错误路径：通知载荷解码失败仍推进游标（意见 1）；presence 上报失败被 `try?` 吞掉；通知被 dismiss 后重发会复活（意见 2）；空闲时间读取失败可能被当成刚刚操作（意见 3，推测）。
- 不可信输入：`id`、`kind`、`title`、`body`、`homeKey`、`createdAt` 都没有长度/格式校验；通知数量没有上限（意见 5）；`createdAt` 字符串排序依赖格式（意见 7）。
- 安全/privacy：没有登记苹果推送，仓库里也没有 APNs 代码；presence 只发时间，不发按键和 App。系统通知内容来自已认证的服务器，未发现注入路径。没有不可撤销的破坏性操作。
- 资源耗尽：15 秒一次的后台 tick、每条通知一张卡片和一个系统通知、`homeKey` 非空时每条通知触发一次 `refresh()`，都没有合并或上限。
- 生命周期：`PresenceSensor` 在未配对时仍每 15 秒唤醒一次，只是 tick 提前返回；`AppModel.emptyStore()` 只停止 chat，没有清 `MenuBarModel.notices` 或 `PresenceSensor.lastReport`，重新配对可能保留旧通知，并让新服务器最多 4 分钟收不到首次 presence。此条我没有作为上面的阻断意见。
- 规则文件：prompt-prefix 没有被触碰；I-73 要求的“产生处和使用处两端校验”在服务器端未写的情况下无法完成，`homeKey` 和 `lastInputAt` 是主要缺口。
- 未核实：服务器 presence 的校验、服务器是否重放通知、`CGEventSource` 在无权限/失败时的返回值、真实 macOS 通知中心行为、以及提交说明里“macOS 上的 NoticeAndPresenceTests 待 Mac 跑”。复核环境不能运行测试，以上“会失败”的判断是从代码路径和断言严格程度读出来的。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 改动全在 Apple 客户端的设备流、菜单栏 UI 和 presence 上报：`ChatStore` 只把通知事件交给 UI（`ChatStore.swift:361-362`），`DeviceEvents` 只解码流事件（`DeviceEvents.swift:45-49`），`OwnerPresence` 只发 HTTP（`OwnerPresence.swift:84-88`）。没有碰提示词目录、工具定义、历史写入、上下文组装或遮盖。发给模型的内容仍然只在末尾追加；本次新增的会变值（`lastInputAt`）没有进入模型请求。若将来服务器把 presence 放进提示，必须按 `prompt-prefix` 规则放在最后一条用户消息，不能放系统提示或工具定义。服务器端未写，无法核实它是否会这样做。

2. **不会让同一段模型请求文字变成不同字节。** 本次没有改模型请求的序列化、遮盖或工具集合。客户端新增的序列化只有 presence 的 HTTP body（时间字段，不是模型输入）和面板通知排序；通知排序用 `(createdAt, id)` 全序，结果是确定的，没有依赖 `Set` 遍历顺序或前后文遮盖。唯一相关风险是 `createdAt` 的字符串排序依赖服务器格式（意见 7），但它影响本地显示顺序，不影响模型请求字节。

3. **有自动检查，但覆盖不完整，反向用例并非全都存在。** 已有检查包括：通知事件解码、合法通知不移动游标、`PendingNotifications` 的去重/替换/withdraw、presence 策略、presence 的 HTTP 路径和 body。`notificationEventsReachTheStreamWithoutMovingTheCursor` 断言 `cursor.saved == ["cursor-7"]`，去掉游标排除逻辑会失败，所以这条反向用例是真的（提交说明也声称验证过）。缺口是：① 没有“格式坏掉但带 id 行的 notification”用例，当前代码会失败（意见 1）；② 没有 `deliver → dismiss → deliver` 用例，当前会再弹（意见 2）；③ 没有 `PresenceSensor` 实际发送、失败后仍记为已发、4 分钟调度的集成测试；④ 没有系统通知标识、`openPanel`、系统通知实际移除的测试；⑤ `NoticeAndPresenceTests` 只在 macOS 编译/运行，提交说明明确写“待 Mac 跑”，我无法运行，不能确认它真的通过。复核环境不允许运行测试，以上失败判断来自代码和断言，不是实际运行结果。

4. **逐值核对：本地值多数能接受，跨服务器值尚未完成两端校验。** 详见下表；服务器端未写，标“未核实”的不能在仓库内证明。

| 值 | 产生处 | 使用处 | 两端校验/结论 |
| --- | --- | --- | --- |
| `notification.deliver` / `notification.withdraw` 事件名 | 服务器 | `DeviceEventDecoder` | 名字精确匹配；合法载荷能解，坏载荷会走意见 1 的游标错误 |
| `DeviceNotification.id` | 服务器 | `PendingNotifications`、面板 `ForEach`、系统通知标识、withdraw 查找 | 客户端只当非空 String 使用，没有长度/空值校验；空 id 会把多条通知折叠成一条。服务器生成规则未实现，未核实 |
| `kind` | 服务器（`reminder`/`run_result`/`mail_reminder`） | 客户端只存不用 | 客户端接受任意 String，未知 kind 也会照常显示；若未来客户端按 kind 分支，需要不认识的值有明确处理 |
| `title` / `body` | 服务器 | 系统通知、面板文字 | 无长度上限，见意见 5；内容只做本地显示，不做 HTML 解析 |
| `homeKey` | 服务器 | `MenuBarModel.shownNotices` 与 `HomeItem.key` 比较（`MenuBarModel.swift:68-69`） | 两端都是 String，但仓库里只有客户端这一端；服务器必须用和 home feed 相同的 key 命名空间，否则“不重复显示卡片”会失效。没有共享常量或契约测试，未核实 |
| `createdAt` | 服务器 | 通知排序 | 只做字符串排序，未解析/校验；只有严格 ISO 8601 UTC 毫秒才等价于时间顺序，见意见 7 |
| `lastInputAt` | Mac 客户端（`PresenceReport.wholeSeconds` + `MessageSensing.timestamp`） | `POST /api/device/v1/presence` | 客户端测试验证路径和 `"2027-01-15T08:00:00.000Z"`；服务器尚未实现，是否拒绝未来时间/过旧时间/格式未核实 |
| `serverTime` | 服务器响应 | 客户端 `reportPresence` 丢弃不用 | 契约里有这个字段，但仓库里没有使用处；如果它本意是让客户端校正时钟，目前缺实现，未核实 |
| `himawari.notice.<id>` | 客户端 | `UNNotificationRequest` 和 `removeDelivered/Pending` | 生成和移除用同一个 `noticeIdentifier`，能配对；结果通知用原始 id，二者不冲突，除非结果 id 本身以 `himawari.notice.` 开头（未发现这种来源） |
| `panel.noticeDismiss` | 本地化文件 | `PanelView` 的按钮 | 英/日/简中三份都有，`L.text` 能取到 |
| `minimumInterval` / `keepAliveInterval` | 客户端策略 | `PresenceSensor` 和测试 | 策略本身有测试；实际调度没有测试，且可能超过 4 分钟（意见 4） |
