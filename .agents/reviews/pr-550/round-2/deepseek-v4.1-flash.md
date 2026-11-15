**审查范围**

本轮按增量 `ae8bbedb..ec3af701` 核对，并回看整份 PR `11e75672..ec3af701` 是否触及模型请求。读了 `DeviceEvents.swift`、`OwnerPresence.swift`、`PresenceSensor.swift`、`MenuBarModel.swift`、`MenuBarController.swift`、`LocalStore.swift`、两份测试、`UserNotifications` 相关代码，以及服务端设备流游标实现（`device-api-routes.ts`、`http-gateway-server.ts`）。本环境只允许 git 读命令，未运行编译和测试，构建/测试结果标为未核实。

**意见（按严重度从高到低）**

### 1. 中：`settled` 只存在进程内存，重启后已点掉或已收走的通知仍会随重放再弹

文件:行：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:23,29,45`；`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:38,86-89`；`clients/apple/Sources/HimawariCore/DeviceEvents.swift:144`；`clients/apple/Sources/HimawariCore/LocalStore.swift:101-116`

问题：上一轮第 2 条只修了“进程存活期间”的情况。作者新加的 `settled` 是 `PendingNotifications` 的内存字段，`MenuBarModel.notices` 也只在内存；应用重启后 `settled` 清空，而通知事件按合约不带 id 行、客户端明确不推进游标，因此服务器为补上离线通知很可能从旧游标重放 `notification.deliver`。已被“知道了”或在上一进程收走的通知会重新出现在面板，甚至重新弹系统通知。

读代码证实：
```swift
private var settled: Set<String> = []
...
guard !settled.contains(notification.id) else { return false }
...
settled.insert(id)
```
```swift
private(set) var notices = PendingNotifications()
...
func dismiss(_ notice: DeviceNotification) {
    notices.withdraw(notice.id)
    removeNotice?(notice.id)
}
```
```swift
if let id = event.id, !id.isEmpty, !DeviceEventDecoder.notificationEvents.contains(event.event) { self.cursors?.save(id) }
```
`StoredCursor` 只持久化游标，仓库里没有任何地方持久化 `settled`（grep 仅命中 `OwnerPresence.swift` 和测试）。

推测/未核实：服务端尚未实现通知事件，重放语义未核实；但“通知不带 id 行、不推进游标”的合约一旦落实，重启后重放就是补离线通知的自然做法。

建议：把已结算的 id 和/或面板状态持久化到与游标同一个 `LocalStore`，带 TTL 或容量上限；或者为通知引入单独的、可持久化的确认游标。补一条“重启后重放已 dismiss 的通知不再弹”的测试。仅在 `withdraw` 时写一个内存集合，不能覆盖这个场景。

### 2. 中（推测）：系统空闲时间为 0 仍被当成“刚刚有操作”，上一轮第 3 条的 0 分支没有改

文件:行：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:97-100`；`clients/apple/Tests/HimawariCoreTests/OwnerPresenceTests.swift:131`

问题：新的 `lastInput` 只拒绝非有限值和负数，`0` 仍然映射为 `now`。如果 `CGEventSource.secondsSinceLastEventType` 在“没有可用读数/没有权限/没有事件”时返回 0，而 0 被当成“刚刚操作”，`PresenceSensor` 会每 60 秒上报一个新的 `lastInputAt=now`，服务器会一直认为主人在 Mac 前，提醒只发 Mac、不再发别处，正好破坏本 PR 的目标。

读代码证实：
```swift
guard secondsSinceInput.isFinite, secondsSinceInput >= 0 else { return nil }
return wholeSeconds(now.addingTimeInterval(-secondsSinceInput))
```
测试还把 0 固化为合法输入：
```swift
#expect(PresenceReport.lastInput(secondsSinceInput: 0, now: start) == start)
```

推测/未核实：0 到底表示“事件刚刚发生”还是“没有读数”，需要 Apple 文档或真机确认；若 0 只可能是刚发生的输入，本条不成立。上一轮把 0 和负数并列，当前代码只改了负数、NaN、无穷大。

建议：把“没有读数”和“0 秒空闲”区分开（例如先判断事件源/权限是否可用，或确认 0 的语义后再决定是否保留 `>= 0`），并为“0 表示无数据”补测试或明确记录不成立的理由。

### 3. 低：`settled` 无上限增长，未知或伪造的 withdraw id 也会被永久记住

文件:行：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:23,44-45`

问题：`withdraw` 在找不到对应通知时也会执行 `settled.insert(id)`，且集合从不清理。应用常驻数周、服务器频繁重放或发送大量不同 id 的 `notification.withdraw` 时，内存会持续增长；一个从未投递过的 id 也会被永久拉黑。

读代码证实：
```swift
private var settled: Set<String> = []
...
public mutating func withdraw(_ id: String) -> DeviceNotification? {
    settled.insert(id)
    guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
    return items.remove(at: index)
}
```
未知 id 也会插入，测试 `aNoticeDismissedOrWithdrawnIsNotShownAgainWhenRedelivered` 的 `pending.withdraw("early")` 正是这个路径。

建议：给 `settled` 设上限（例如保留最近 N 条或按时间过期），持久化时同样限界；如果确定 id 全局唯一，也应至少限制集合大小，避免流内容决定内存占用。

### 4. 低：作者说明“每 minimumInterval/4 秒读一次空闲时间”与代码不一致

文件:行：`clients/apple/Sources/HimawariMacUI/PresenceSensor.swift:26`；`clients/apple/Sources/HimawariCore/OwnerPresence.swift:76-81`

问题：代码在临近保活时会提前唤醒，间隔可以小于 `minimumInterval/4`（标准配置下 15 秒）。测试明确断言 232 秒处返回 8 秒。行为本身是为修“4 分钟保活可能超过 4 分钟”，但作者说明仍写成固定 15 秒，说明与代码不一致。

读代码证实：
```swift
try? await Task.sleep(for: .seconds(policy.secondsUntilNextCheck(now: Date(), lastReport: lastReport)))
```
```swift
let tick = max(minimumInterval / 4, 1)
...
return untilKeepAlive > 0 ? min(tick, untilKeepAlive) : tick
```
测试：`#expect(policy.secondsUntilNextCheck(now: start.addingTimeInterval(232), lastReport: sent) == 8)`。

建议：把说明改为“正常情况下每 `minimumInterval/4` 秒检查一次，临近保活期限会提前到期限点”，避免后续复核者据此误判实现。

**上一轮 6 条“会出错”意见逐条核对**

- 第 2 条（中高，重发再弹）：进程内已用 `settled` 修好；重启后仍会再弹，见意见 1，属于未完全修好。
- 第 1 条（低，坏通知事件写游标）：已修。`DeviceEvents.swift:144` 改为按 `event.event` 判断，新增的 `n-bad` 测试行在旧代码下会把 `n-bad` 存成游标、`cursor.load()` 得 `"n-bad"`，反向用例会失败。遗留风险：`notificationEvents` 是客户端硬编码集合，将来服务端新增通知事件名时必须同步，否则同类问题会回来。
- 第 3 条（低，负数/0 空闲时间）：负数、NaN、无穷大已修；0 仍未改，见意见 2。
- 第 4 条（低，保活超过 4 分钟）：已修。`secondsUntilNextCheck` 会让检查和保活期限对齐，测试覆盖 232 秒返回 8、240 秒返回 15；但只有纯函数单测，没有覆盖 `PresenceSensor` 真实循环，调度抖动仍可能让实际间隔略超 4 分钟（无法完全避免）。
- 第 6 条（低，测试自建假 `CursorStore`）：已修。测试改用生产实现 `StoredCursor(store: MemoryLocalStore())`（`LocalStore.swift:74,101`），被删掉的 `MemoryCursor` 不再存在；`RecordingExchange` 是原有的传输替身，不在本次增量范围。
- 第 7 条（低，`createdAt` 字符串排序）：已修。`PendingNotifications.instant` 解析 ISO 8601 后按 `(Date, id)` 排序，测试覆盖无小数秒的 `05:35:00Z` 与 `.500Z` 的先后；解析失败落到 `.distantPast`，确定性但会排到最后，属可接受降级。

**侧重检查**

- 错误路径：`notification.deliver` 缺字段时 `decode` 返回 nil，不再推进游标；`withdraw` 缺 id 时返回 nil；坏 `createdAt` 解析为 `.distantPast` 不崩溃；负数/NaN/无穷大空闲时间返回 nil，传感器跳过本轮。以上读代码证实。
- 不可信输入：SSE 事件名和 JSON 字段全部来自服务器；`id` 只用于系统通知标识和本地集合，不拼接命令；`title/body` 直接交给系统通知，无 HTML/命令注入面。本轮未发现新的解析崩溃路径。
- 安全：未发现把设备密钥、令牌写日志或写进通知内容的代码；通知标识使用 `himawari.notice.<id>`，结果通知用原始 id，二者前缀分开。
- 资源耗尽：`settled` 无界（意见 3）；`items` 仍只由未 withdraw 的通知数量决定（旧代码已有）。`instant` 每次排序都新建 `ISO8601DateFormatter`，待处理通知很少时可忽略，若服务端能灌入大量通知会放大 CPU，但这是旧排序路径的延续。
- 不可撤销操作：本地 dismiss 会永久写 `settled`（进程内），系统通知用 `removeDeliveredNotifications` 删除；没有发现可恢复性要求。持久化方案应注意不要无限写入磁盘。
- 规则/文档一致性：通知不带 id、坏通知不写游标的规则与代码一致；`prompt-prefix.md` 与本次改动无关；作者关于“每 15 秒读一次”的说明与代码不一致（意见 4）。

**必答问题**

1. 这个改动会不会改变模型已经见过的请求开头？不涉及。整份 PR 只改 Apple 客户端的事件流、在场上报和本地通知，`ChatStore` 只是把 `notification.*` 事件转发给 `AppModel`/`MenuBarModel`，没有系统提示、工具定义、历史消息、遮盖或序列化格式的改动。发给模型的内容是否“只在末尾追加”在本 PR 中没有被触碰，未发现相关变化。

2. 会不会让同一段文字在不同请求里变成不同字节？不涉及模型请求。就本改动自身：在场上报体只有一个 `lastInputAt` 字符串，用固定 UTC 毫秒格式；通知排序改为解析 `Date` 后加 id 确定性排序；`settled` 和 `notificationEvents` 只做集合成员判断，不参与序列化。没有发现依赖前后文或无序集合的字节变化。

3. 有没有对应的自动检查，反向用例是否真会失败？有。坏通知游标用例（`n-bad` 行）在旧代码会失败；`settled` 的去重/不再弹用例在旧代码会失败；无小数秒排序用例在旧字符串排序下会失败；负数和 NaN/无穷大空闲时间用例在旧 `max(0,·)` 下会失败。保活用例只能验证新的纯函数，不能算旧行为的红绿用例，也没有覆盖 `PresenceSensor` 实际调度；跨重启 `settled` 持久化没有测试。编译和实际测试未运行，未核实。

4. 增量产生或修改的每个值，使用端都能接受吗？逐个核对：
   - `DeviceEventDecoder.notificationEvents`：只被 `DeviceEventStream.consume` 使用，`Set<String>` 成员判断类型匹配；仓库内无其他引用。
   - 删除的 `DeviceStreamEvent.isNotification`：全仓库 grep 无剩余引用。
   - `PendingNotifications.settled`：`private`，只被 `deliver`/`withdraw` 使用，无外部使用端。
   - `PendingNotifications.instant`：`internal`，只被 `deliver` 使用，测试通过 `@testable` 也不直接调用。
   - `deliver` 的 Bool 语义：`MenuBarModel.receive` 用返回值决定是否 `showNotice`，与新的“已结算不再弹”一致；demo 初始化忽略返回值，无影响。
   - `withdraw` 新增的副作用：`MenuBarModel.receive` 和 `MenuBarModel.dismiss` 都接受该副作用，测试覆盖。
   - `PresenceReport.lastInput` 从 `Date` 改为 `Date?`：唯一生产调用端 `PresenceSensor.tick` 已加 `let lastInputAt = ...` 与 `guard`，测试全部更新，仓库内无其他调用。
   - `PresenceReportPolicy.secondsUntilNextCheck`：唯一生产调用端 `PresenceSensor.swift:26` 接受 `TimeInterval`，无其他调用。
   - `createdAt` 的 ISO 8601 解析：与现有 `DeviceAPI.timestamp`/`MessageSensing.timestamp` 相同的“小数秒优先、无小数秒回退”写法，消费端 `PendingNotifications` 与面板排序接受 `Date`。
   未发现产生端与使用端校验不一致的新值。
