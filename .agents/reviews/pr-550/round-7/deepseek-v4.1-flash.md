## 查过的范围

- 增量：`git diff 673b5ba..3eafc66` 只有 `clients/apple/Sources/HimawariMacUI/PanelView.swift` 新增一行 `.scrollIndicators(.never)`，其余是第 6 轮复核记录和 `usage.jsonl`；`MenuBarModel`、`OwnerPresence`、`ChatStore`、`AppModel` 在增量里都没变。
- 读了：`PanelView.swift`、`MenuBarModel.swift`、`ChatStore.swift`、`AppModel.swift`、`MacAppDelegate.swift`、`MenuBarController.swift`、`OwnerPresence.swift`、`LocalStore.swift`、`PairingDecisions.swift`、`DeviceEvents.swift`、`PresenceSensor.swift`、`OwnerPresenceTests.swift`、`NoticeAndPresenceTests.swift`、`Package.swift`，并对照了当前 HEAD 已有的服务端 `device-api-routes.ts`、`device-notification-hub.ts`、`mac-placement.ts`、`delivery-timing.ts`、`service-main.ts`。
- 未运行任何测试或 Mac 编译（工具限制）；下文“会失败”是静态推断，已标出。

## 上一轮三条的核对结果

- 第 1 条（换设备/重新开始后旧通知和 settled 进入新设备）：**未改好**。增量没碰这两处代码，当前逻辑仍会把旧内存状态合并进新设备库。
- 第 2 条（settled 读失败/损坏当成空并覆盖，写失败被吞掉）：**未改好**。`remember` 和 `save` 仍是原样。
- 第 3 条（列表高度变化把用户拉回旧 `revealedNotice`）：**未改好**。`onChange(of: olderListHeight)` 仍在；新增的 `.scrollIndicators(.never)` 与滚动位置无关。

## 侧重检查

- 错误路径：settled 文件缺失、不可读、JSON 损坏、写入失败；通知事件格式错误；空闲时间读不到；presence 上报失败；会话被撤销。
- 不可信输入：服务端下发的通知 `id/title/body/homeKey/createdAt`；`id` 只用于本地文件和系统通知标识，没有拼进路径或 shell。
- 安全：presence 只上报最后输入时间；settled 文件只存通知 id，不存标题正文；未发现密钥/隐私泄漏。
- 资源耗尽：服务端通知队列有 200 条上限、Mac placement 有 100 条上限；客户端 `PendingNotifications.items` 没有上限（推测项）。
- 不可撤销操作：点“知道了”或收到 withdraw 会把 id 永久加入 settled（只留最近 500 条），没有撤销；这是需求接受的取舍。
- 规则/文档一致性：没有新增代码注释；Mac 代码都在 `#if os(macOS)`；模型请求前缀规则未被改动。作者“服务器端还没写”的说法与当前 HEAD 不符。

## 读代码证实的问题

### 1. 中：换设备重配对或“重新开始”后，旧设备的未处理通知和 settled 仍会进入新设备（上一轮第 1 条未改好）

文件:行：`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:43,125-129`；`clients/apple/Sources/HimawariCore/OwnerPresence.swift:41-48`；`clients/apple/Sources/HimawariCore/PairingDecisions.swift:63-72`；`clients/apple/Sources/HimawariMacUI/MacAppDelegate.swift:25-26`。

问题：`MenuBarModel` 在应用启动时只建一次，`notices` 和内存里的 `settled` 不会随设备变化清空。换设备后 `app.deviceStore` 变成新库，`rememberSettled()` 检测到 store 变了，就调用 `notices.remember(in: newStore)`；这个函数把旧内存里的 `settled` 合并进新库并立刻写盘，同时只删除已 settled 的旧行，未处理的通知仍留在 `items`。`store.claim(for:)` 只清磁盘，不清 `MenuBarModel` 的内存状态。

证据：

```swift
private(set) var notices = PendingNotifications()   // MenuBarModel.swift:43
...
private func rememberSettled() {
    guard let store = app.deviceStore, store !== settledStore else { return }
    notices.remember(in: store)                     // :125-129
    settledStore = store
}
```

```swift
var merged = saved.filter { !settled.contains($0) }
merged.append(contentsOf: settled)
settled = Array(merged.suffix(Self.settledLimit))
self.store = store
save()
items.removeAll { settled.contains($0.id) }         // OwnerPresence.swift:43-48
```

```swift
let model = MenuBarModel(app: AppModel(kind: .mac), settings: MacSettingsStore())
controller = MenuBarController(model: model)        // MacAppDelegate.swift:25-26，只建一次
```

建议：在 `app.deviceStore` 或设备 id 变化时重置 `notices`、`revealedNotice`、`noticesExpanded`；让 `PendingNotifications` 区分“同一个设备库刚就绪”和“换到另一个设备库”，换库时用新库内容覆盖而不是合并内存旧值；可按 `deviceId` 给 settled 文件分作用域。补一条测试：设备 A 收到并收走通知，切到设备 B 后面板为空，且 B 的 settled 文件不包含 A 的 id。

### 2. 中：服务端 `macPresenceSeconds` 可设到 30 秒，客户端最快 60 秒才上报，Mac 会被误判为不在

文件:行：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:92,99-105`；`packages/application/src/services/delivery-timing.ts:37,54`；`apps/agent-service/src/service-main.ts:736-737`；`apps/agent-service/src/mac-placement.ts:39-50`。

问题：客户端固定 60 秒最小上报间隔、240 秒保活；服务端 `macPresenceSeconds` 允许 30 到 3600 秒。若主人把它设为 30（范围允许），服务端在两次上报之间就会把 Mac 从“最近有输入”里删掉；即使主人一直在打字，客户端也要到 60 秒才报下一次。此时通知会改发 iPhone，与“主人在电脑前只让 Mac 响”的目标相反。

证据：

```swift
public static let standard = PresenceReportPolicy(minimumInterval: 60, keepAliveInterval: 240) // OwnerPresence.swift:92
...
if elapsed < minimumInterval { return false }       // :102
```

```ts
macPresenceSeconds: 300,                             // delivery-timing.ts:37
macPresenceSeconds: [30, 3600],                      // :54
```

```ts
windowMilliseconds: () =>
  (deliveryTimingHolder?.current() ?? DELIVERY_TIMING_DEFAULTS).macPresenceSeconds * 1000, // service-main.ts:736-737
...
presence.recent(now, window).filter(hub.connected).slice(0, 1) // mac-placement.ts:42-45
```

建议：按计划合约把服务端 `macPresenceSeconds` 的下限抬到不低于客户端的最大上报/保活间隔（至少 240 秒），或把服务端窗口下发给客户端并让 `PresenceReportPolicy` 按它调整。补一条集成测试：把 `macPresenceSeconds` 设为允许的下限，客户端按最慢的合法节奏上报时，Mac 仍应被视为在场。

### 3. 低：settled 文件读失败或损坏仍被当成空并立即覆盖，写入失败仍被吞掉（上一轮第 2 条未改好）

文件:行：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:41-48,78-80`。

问题：`store.read(...).flatMap { try? JSONDecoder().decode(...) } ?? []` 把“文件不存在、读不出、JSON 损坏”都当成空；紧接着 `save()` 立即把空数组（或内存里不完整的内容）写回。`save()` 用 `try?` 吞掉编码和写入错误。结果是：一次读失败或文件损坏会丢掉全部已收走的 id，重启后已关闭的通知会再次弹出；写入失败则没有任何提示，重启后同样丢失。

证据：

```swift
let saved = store.read(Self.settledName).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
...
self.store = store
save()                                                // OwnerPresence.swift:42-47
```

```swift
private func save() {
    guard let store, let data = try? JSONEncoder().encode(settled) else { return }
    try? store.write(Self.settledName, data)          // :78-80
}
```

建议：用 `store.contains` 区分“缺失”和“存在但读失败”；读失败/解码失败时不要覆盖原文件，保留内存值并记录错误；`save` 改成可抛出或返回结果，至少记录写失败。补测试：用可失败的 `LocalStore` 覆盖“文件存在但内容损坏”和“write 抛错”两条反向路径。

### 4. 低：列表高度一变就滚动，仍会把用户从手动位置拉回旧的 `revealedNotice`（上一轮第 3 条未改好）

文件:行：`clients/apple/Sources/HimawariMacUI/PanelView.swift:126-131,136-138`；`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:90-94,121-123`。

问题：`revealedNotice` 只在点“收起/展开”、点“知道了”或收到 withdraw 时清空；用户手动滚动不会清空。只要 `olderListHeight` 变化（新通知到达、内容重新排版、卡片增删），`onChange` 就会调用 `scrollToRevealed`，把用户从手动位置拉回上一次点开的旧通知。增量只加了 `.scrollIndicators(.never)`，没有改变这个行为。

证据：

```swift
.onChange(of: olderListHeight) { scrollToRevealed(proxy) }
.onChange(of: model.revealedNotice, initial: true) { scrollToRevealed(proxy) } // PanelView.swift:130-131
...
private func scrollToRevealed(_ proxy: ScrollViewProxy) {
    if let id = model.revealedNotice?.id { proxy.scrollTo(id, anchor: .top) }   // :136-138
}
```

建议：只在 `revealedNotice` 的 serial 变成新值滚动一次，滚动完成后清除“待滚动”标记；用户手动滚动时清掉 `revealedNotice`（可用 `onScrollPhaseChange`/滚动位置监听），或者高度变化时只在目标不可见时才滚。现有测试只检查 `MenuBarModel.revealedNotice`，没有检查实际滚动位置，应补一个能复现“手动滚开后新通知到达”的 UI/行为测试。

### 5. 低：作者说“服务器端还没写”，当前 HEAD 已有 presence/notification 服务端实现

文件:行：`packages/platform-node/src/device-api-routes.ts:870-913`；`packages/platform-node/src/device-notification-hub.ts:1-21`；`test/integration/device-notifications.test.ts:47-110`。

问题：材料里写“合约（推送线程给的计划合约，服务器端还没写）”，但当前 HEAD 已包含 `/presence`、`/notifications/settled`、`notification.deliver/withdraw` 的 hub/frame、Mac placement 和集成测试，提交 `07181db90` 就是“一处只响：服务器部分”。这可能是分支合并造成的时间差，但材料应更新；否则复核会误以为只能按文字合约核对，而实际可以、也应该对照真实服务端。

证据：

```ts
device.post("/presence", async (request, reply) => {
  ...
  if (authenticated.device.kind !== "mac") options.rejectNotAllowed();
  ...
  notifications.presence.record(authenticated.device.id, Math.min(reported, serverTime.getTime()));
  return options.sendJson(reply, 200, { ok: true, serverTime: serverTime.toISOString() });
});
```

```ts
export function deviceNotificationFrame(frame: DeviceNotificationFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}
```

建议：更新 PR 描述/材料，写明服务端实现已在当前树中；后续复核直接以 `device-api-routes.ts` 和 `device-notification-hub.ts` 为准，并保留第 2 条那种两端时间窗的检查。

## 推测（未证实）

- 客户端 presence 用本机 `Date()` 算 `lastInputAt`，服务端只把未来时间截到服务器时间，不校正过去的时间；如果本机时钟明显偏慢，Mac 可能被误判为离开。影响取决于时钟偏差，未实测。
- `PendingNotifications.items` 没有容量上限，而结果类通知服务器不一定发 withdraw；长期不点“知道了”会持续累积。影响是缓慢的内存/列表增长，未做压力测试。
- 隐藏滚动条后，列表是否还能滚只靠底部裁切暗示；若内容只超出一点点，可能不容易发现。属于交互取舍，未在 Mac 上截图确认。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。增量只改 `PanelView` 的滚动条可见性；PR 的 presence 时间和通知内容走设备 API 与本地 UI，不进入系统提示、工具定义、历史消息或遮盖结果。没有新增每轮进入模型请求的值，因此不存在“只在末尾追加”之外的改动。
2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及模型请求。协议侧的值是确定的：`lastInputAt` 用 UTC 毫秒格式，通知按 `createdAt` + id 排序，settled 是 `[String]`，没有无序集合或依赖后文的遮盖。`scrollIndicators(.never)` 不参与序列化。
3. **有没有对应的自动检查，反向用例会真的失败吗？** 增量没有自动检查，`HimawariMacUI` 只能在 macOS 编译，作者也写明待 Mac 编译和截图确认，未核实。上一轮三条：第 1 条没有换设备测试，现有 `noticesSettledBeforeTheStoreWasReadyAreKeptAndTheirRowsLeave` 反而固化了“内存 settled 合并进新 store”的行为；第 2 条没有损坏文件/写失败测试，`MemoryLocalStore.write` 不会抛错，测不到写失败；第 3 条只有 `NoticeAndPresenceTests` 对 `revealedNotice` 状态的断言，没有实际滚动位置测试，因此不会因该 bug 失败。presence 方面有策略测试、非法空闲时间测试和请求体格式测试，若改错时间格式或不去掉非法值，这些测试会失败；但这些测试未在本轮运行。
4. **每个产生/修改的值，使用端都能接受吗？** 增量没有产生新值。逐项核对 PR 的值：
   - `notification.deliver/withdraw` 的字段与当前服务端 `DeviceNotificationDeliver`/`{id}` 一致；服务端 frame 不带 id 行，客户端也不会为通知事件保存游标（`DeviceEvents.swift` 的 `notificationEvents` 判断）。
   - `lastInputAt`：客户端 `MessageSensing.timestamp` 产出 `...sssZ`，服务端 `ISO_MILLISECONDS = /^\d{4}-...\.\d{3}Z$/` 接受；服务端还检查只有 `lastInputAt` 一个键，客户端正是如此。
   - 系统通知标识 `himawari.notice.<id>` 在 `show`/`withdraw` 使用同一函数，`didReceive` 靠 `noticeId` 与结果通知区分；未发现冲突。
   - `settled-notices.json` 只被 `PendingNotifications` 读写，500 条上限存在；但错误路径有问题（第 3 条）。
   - `PresenceReportPolicy.standard` 的 60/240 秒被 `PresenceSensor` 使用；服务端默认窗口 300 秒可接受，但允许 30 秒，两端不一致（第 2 条）。
   - Mac 配对使用 `DeviceKind.mac`，服务端 presence 路由要求 `kind === "mac"`，两端一致。

## 结论

这一轮实际增量 `3eafc66` 只有一行滚动条可见性修改，没有引入新的功能性错误；但它没有修复上一轮第 1、2、3 条中的任何一条，也没有对应自动检查，Mac 编译和截图仍属未核实。除此之外，按 Q4 对照当前 HEAD 的服务端实现，发现 `macPresenceSeconds` 允许值（最小 30 秒）与客户端 60/240 秒策略两端不一致，会让 Mac 在允许配置下被误判为不在；作者“服务器端还没写”的说法也与当前树不符。建议至少修第 1 条（跨设备隔离）和第 2 条（时间窗），第 3、4、5 条可按低严重度记录后决定是否延后。
