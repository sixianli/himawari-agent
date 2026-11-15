## 本轮范围

已读 `ec3af70..e4e63e4` 的全部代码增量：`HimawariCore/OwnerPresence.swift`、`HimawariMacUI/MenuBarModel.swift`、`HimawariShell/AppModel.swift`、`HimawariCoreTests/OwnerPresenceTests.swift`；并跟到直接使用端：`LocalStore`/`FileLocalStore`、`PairingDecisions.claim`、`MacAppDelegate`、`MenuBarController`、`PanelView`、`MacDemoScenes`、`NoticeAndPresenceTests`、`ChatStore`、`DeviceEvents`。未运行构建或测试（受工具限制），编译与测试结果未核实。

## 上一轮意见核对

- 第 1 条（`settled` 只在进程内存）：正常流程已修好。`MenuBarModel.receive`/`dismiss` 都先调 `rememberSettled()`（`MenuBarModel.swift:73-98`），`PendingNotifications.save()` 写入 `settled-notices.json`（`OwnerPresence.swift:72-75`），重开时 `init(rememberingIn:)` 读取并抑制重放（`:31-43`）。
- 第 3 条（无上限增长）：已修好。`withdraw` 在超过 `settledLimit` 时 `removeFirst`（`OwnerPresence.swift:63-66`），`remember` 用 `suffix`（`:37-39`），上限 500；测试 `onlyTheLatestSettledIdsAreKept` 覆盖了淘汰。
- 增量没有引入新的高/中严重度错误；下面都是低严重度的残留风险或测试缺口。

## 侧重检查

- 错误路径：`store.read` 把“文件不存在”和“读失败/解码失败”都变成空数组，随后 `save()` 覆盖原文件（见意见 2）；`try? write` 静默吞掉写失败，包括 `retired` 状态。
- 不可信输入：`notification.deliver`/`notification.withdraw` 的 `id` 是服务端任意 `String`，没有长度或格式校验，会原样进入 `settled` 并落盘（见意见 4）。
- 安全：文件名固定，不构成路径穿越；通知正文由服务端原文直接进 `UNMutableNotificationContent`，属于预期设计，未发现注入问题。
- 资源耗尽：`settled` 条数有 500 上限，但单条 id 长度无上限；每条新 withdraw 会重写整个数组，且发生在 `@MainActor` 上。`items` 本身没有上限，但那是增量未触碰的旧代码，不在本轮范围。
- 不可撤销操作：本地“知道了”落盘后不会再弹，属于需求本身；如果误点，没有撤销入口。
- 规则/文档一致性：增量没有新增代码注释，符合约束；仓库内没有需要同步修改的说明文档。作者关于“退避重连”（`DeviceEvents.swift:112-135,177-180`）、“上报失败也记为已发”（`PresenceSensor.swift:40-42`）、“不登记苹果推送”（全仓无 `registerForRemoteNotifications` 等调用）的说法与代码一致。“Linux 只编 HimawariCore”未实际构建，未核实。

## 意见

### 1. 低：持久化接线的反向用例不会失败，删掉 `rememberSettled` 测试仍会通过

文件:行：`MenuBarModel.swift:94-98`；`Tests/HimawariMacUITests/NoticeAndPresenceTests.swift:10-18`；`AppModel.swift:150-155,329-331`

问题：`PendingNotifications` 自身有持久化单测，但没有任何测试覆盖 `MenuBarModel` 真正把 `app.deviceStore` 接进去。UI 测试用的 `AppModel.demo` 是 `AppModel(kind: kind, restoring: false)`，`store` 只在 `activate()` 里赋值，所以 `deviceStore` 始终为 nil，`rememberSettled()` 的 `guard let store = app.deviceStore` 永远走不到。把 `receive`/`dismiss` 里的 `rememberSettled()` 调用删掉，现有测试仍全过，上一轮第 1 条的修复可以无声回归。

证据：

```swift
// MenuBarModel.swift:94-98
private func rememberSettled() {
    guard let store = app.deviceStore, store !== settledStore else { return }
    notices.remember(in: store)
    settledStore = store
}
```

```swift
// NoticeAndPresenceTests.swift:11-17
MenuBarModel(
    demo: AppModel.demo(.active, host: "himawari.example.com", kind: .mac),
    ...
)
```

建议：给 `MenuBarModel` 增加可注入的 `LocalStore`（或让测试构造一个带临时 `FileLocalStore` 的 AppModel），做一个“投递→点知道了→重建模型共享同一 store→重放同一 id 不再弹”的用例；`MemoryLocalStore` 是仓库既有实现，不算假替身。

### 2. 低：settled 文件读失败或损坏时会被当成空并立即覆盖，已收走的通知可能重新弹

文件:行：`OwnerPresence.swift:35-43,72-75`

问题：`read` 在文件不存在、IO 失败时都返回 nil；`try? JSONDecoder().decode` 在内容损坏时也返回 nil，随后统一变成 `[]`，`remember` 又立刻 `save()`。一次临时读失败或文件损坏就会清掉全部“已收走”记录，之后重放的通知会再弹，且没有任何日志。写失败也被 `try?` 静默吞掉。

证据：

```swift
let saved = store.read(Self.settledName).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
...
save()
```

```swift
private func save() {
    guard let store, let data = try? JSONEncoder().encode(settled) else { return }
    try? store.write(Self.settledName, data)
}
```

建议：区分“文件不存在”和“存在但读不出/解不开”。后者不要覆盖，保留原文件（可改名备份）并记录；写失败至少留下可诊断痕迹。

### 3. 低：换设备重配对后，旧设备的 settled 会被写进新设备库

文件:行：`MenuBarModel.swift:94-98`；`OwnerPresence.swift:37-41`；`AppModel.swift:233-242,425-437`；`PairingDecisions.swift:63-72`

问题：`forget` 先 `emptyStore().retire()`（删除文件并把旧 store 标为 retired），但 `MenuBarModel.notices.store` 仍强引用旧 store，`MenuBarModel` 也不会重建；新配对时 `activate()` 建立新的 `FileLocalStore` 实例。下一次通知事件触发 `rememberSettled()`，`store !== settledStore` 成立，`remember` 把旧设备留在内存里的 `settled` 合并进新设备库并落盘。若服务端通知 id 在不同设备间可能重复，新设备的通知会被旧设备的“已收走”误抑制；旧设备未收走的面板项也仍留在 `items` 里。合并与落盘是代码确认的；id 是否跨设备重复取决于服务端，属于推测。

证据：

```swift
var merged = saved.filter { !settled.contains($0) }
merged.append(contentsOf: settled)
...
self.store = store
save()
```

建议：按 `deviceId`/`owner` 区分 settled 文件，或在 store 实例变化时清空旧 `notices`（尤其是旧 `settled` 和旧 `items`），不要把旧设备的已收走 id 迁移到新设备。

### 4. 低：服务端 id 无长度上限，且伪造 withdraw 会挤掉真实的已收走记录

文件:行：`OwnerPresence.swift:62-70`；`DeviceEvents.swift:38-42`

问题：`withdraw` 接受任意 `id`（包括从未投递过的），且单条长度没有限制。500 条的上限只限条数，不限总字节；一个出错或恶意的服务端可以用 500 条超长 id 或大量伪造 withdraw 把真实的已收走 id 挤出去，之后的旧通知重放时会重新弹，同时每次新 id 都同步重写整个 JSON（在 `@MainActor` 上）。资源不会无限增长，但写放大和淘汰真实记录的风险仍在。

证据：

```swift
if !settled.contains(id) {
    settled.append(id)
    if settled.count > Self.settledLimit { settled.removeFirst(settled.count - Self.settledLimit) }
    save()
}
```

建议：给 id 设长度上限（超限丢弃并记录）；把“本地点掉”和“收到 withdraw”分开记录或给不同淘汰优先级；写入可改为合并后异步落盘。

## 必答问题

1. **不涉及。** 增量只改 Apple 客户端的设备流/通知/本地存储和测试，没有触碰任何构造模型请求的代码；发给模型的系统提示、工具定义、历史消息、遮盖结果都没有变化，不存在“请求开头变化”或“每轮变化值位置”的问题。服务端请求构造不在本增量范围，未逐行核对。

2. **不涉及模型请求。** 本地 `settled-notices.json` 现在用 `[String]`（有序数组）序列化，顺序确定，不含时间字段或无序列集合；同一段文本不会因请求上下文变成不同字节。通知 id 原文来自服务端，持久化时不被改写。

3. **部分覆盖。** `aNoticeSettledBeforeARestartIsNotShownAgainAfterIt`、`noticesSettledBeforeTheStoreWasReadyAreKeptAndTheirRowsLeave`、`onlyTheLatestSettledIdsAreKept` 的反向用例确实会失败（去掉持久化/上限就会失败）。但 `MenuBarModel` 到 `app.deviceStore` 的接线没有测试覆盖（意见 1）；损坏/读失败路径也没有测试（意见 2）。

4. **我已逐个核对增量产生或修改的值。** `settledName`（`OwnerPresence.swift:23`）只被 `read`/`write`（`:36,:74`）和测试使用，与同目录已有的 `owner`（`PairingDecisions.swift:61`）、`stream-cursor`（`LocalStore.swift:105`）、`threads-cache.json`（`ThreadCache.swift:12`）、`outbox.json`（`Outbox.swift:37,48`）、`handover-item-*`/`handover-settings`（`Handover.swift:435,496`）不冲突；`settledLimit`（`:22`）只在 `:37-39,:65` 和测试中使用；`AppModel.deviceStore`（`AppModel.swift:138`）只有 `MenuBarModel.swift:95` 一个使用端；`init(demo:...notices:)` 的默认参数与 `MacDemoScenes.swift:93-98` 及测试兼容。通知 id 两端都按任意 `String` 接受（`DeviceEvents.swift:38-42`、`UNNotificationRequest` 标识），类型上兼容，但都没有长度/格式校验（见意见 4）；跨设备迁移问题见意见 3。服务器端尚未实现，无法核对后端对 id 的校验。
