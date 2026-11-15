## 本轮查过的范围

- 增量：`git diff b7d7a5b2fbcebafb2e5ebb1d64aa94d38b82cf50..d5896db49d2397a282dcdabeb8ec31efc229ece3`，代码只涉及 `MenuBarModel.swift`、`AppModel.swift`、`NoticeAndPresenceTests.swift`、`test/tooling/mac-presence-window.test.ts`。
- 连带读到的旧代码：`OwnerPresence.swift`、`PresenceSensor.swift`、`PanelView.swift`、`MenuBarController.swift`、`LocalStore.swift`、服务端 `device-api-routes.ts` / `device-notification-hub.ts` / `mac-placement.ts` / `production-web-push.ts`。
- 未运行任何测试或编译，以下通过/失败判断均来自读代码；未重审本 PR 增量以外的全部内容。

## 上一轮意见核对

1. **第 1 条已改好**：`AppModel.store` 增加 `didSet`，`MenuBarModel.followDeviceStore()` 注册 `onDeviceStoreChange`，换库/清空时同步调用 `deviceStoreChanged`，先 `removeNotice` 再重建，`dismiss` 也加了“仍在当前列表”的 guard。读代码确认。
2. **第 2 条未改好**：增量没有碰 `OwnerPresence.swift`，损坏和解码失败仍被 `try?`/`?? []` 吞掉，写失败仍被 `try?` 吞掉。见意见 1。
3. **第 3 条未改好**：增量没有碰 `PanelView.swift`，高度变化仍会滚回旧 `revealedNotice`。见意见 2。
4. **第 4 条部分改好**：临时目录已用 `defer` 清理；换库测试仍通过 DEBUG-only 的 `useDemoDeviceStore` 直接改 store，只覆盖了 `didSet`，没有走真实的 `activate()`/`forget()`。见意见 3。
5. **第 5 条基本改好**：新 tooling 用例确实断言了 `standard` 唯一构造、`PresenceSensor` 默认 `.standard`、唯一构造点不传策略；但仍有一个文本匹配/构造位置上的缺口。见意见 4。

### 1. 低：settled 文件损坏或写失败仍被静默吞掉

- 文件：`clients/apple/Sources/HimawariCore/OwnerPresence.swift:42`、`:78-80`
- 问题：损坏的 `settled-notices.json` 被当成空列表，下一次保存会直接覆盖成 `[]`；“知道了/收走”写盘失败也没有任何日志或状态，重启后可能再次弹出。
- 证据：

```swift
let saved = store.read(Self.settledName).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
```

```swift
private func save() {
    guard let store, let data = try? JSONEncoder().encode(settled) else { return }
    try? store.write(Self.settledName, data)
}
```

- 建议：区分“文件不存在”和“读取/解码失败”，失败时记录诊断并保留原文件；写失败至少上报到现有诊断或设置页。补反向用例：写入损坏 JSON、只读设备库，断言不会静默当成空文件且不会误覆盖。

### 2. 低：列表高度变化仍会把用户滚回旧的 `revealedNotice`

- 文件：`clients/apple/Sources/HimawariMacUI/PanelView.swift:137`、`:153-155`
- 问题：只要较早列表高度变化（新通知、正文换行、字体/布局变化），就再次滚动到 `model.revealedNotice`。用户已经手动滚走后，会因为任意高度变化被拉回旧位置。增量只在换设备库时把 `revealedNotice` 清空（`MenuBarModel.swift:141`），没有修这条通用路径。
- 证据：

```swift
.onChange(of: olderListHeight) { scrollToRevealed(proxy) }
.onChange(of: model.revealedNotice, initial: true) { scrollToRevealed(proxy) }
```

```swift
private func scrollToRevealed(_ proxy: ScrollViewProxy) {
    if let id = model.revealedNotice?.id { proxy.scrollTo(id, anchor: .top) }
}
```

- 建议：不要在 `olderListHeight` 变化时滚动；只在新一次 `reveal`（例如 `NoticeReveal.serial` 变化）时滚。用户手动滚动后清掉 `revealedNotice`，或记录“只自动滚一次”。补高度变化+手动滚动的反向测试。

### 3. 低：换库测试仍绕过真实的 `activate()` / `forget()` 顺序

- 文件：`clients/apple/Tests/HimawariMacUITests/NoticeAndPresenceTests.swift:177-180`、`:197-216`；`clients/apple/Sources/HimawariShell/AppModel.swift:196-198`
- 问题：测试现在通过 `useDemoDeviceStore` 直接改 `store`，确实走到了 `didSet` 回调，但没有覆盖生产路径里的顺序：`activate()` 先 `claim` 再设 store，`forget()` 先 `emptyStore()`/停聊天再设 nil。若以后有人改变这些顺序，现有测试不会失败。临时设备库清理已修好。
- 证据：

```swift
menu.app.useDemoDeviceStore(old)
...
menu.app.useDemoDeviceStore(fresh)
```

```swift
public func useDemoDeviceStore(_ store: FileLocalStore?) {
    self.store = store
}
```

- 建议：把 `activate`/`forget` 中“设置 store”和“清通知”的共享顺序抽成可测函数，或直接通过真实 `activate()`/`forget()` 做换库测试；至少补一个用例确认旧聊天已停后再清卡片。读代码看当前生产顺序本身是对的，所以这是覆盖缺口，不是已证实的线上错误。

### 4. 低：presence 门禁没有绑定构造位置，且文本正则可被正常写法绕开

- 文件：`test/tooling/mac-presence-window.test.ts:47-56`
- 问题：`policiesBuilt` 只记录文件名，`sensorsBuilt` 只记录参数文本。它能发现“另传一套策略”，但发现不了“唯一的 `PresenceSensor` 构造点从生产代码搬到 demo”，也匹配不到 `PresenceReportPolicy.init(minimumInterval:` 或 `(` 后换行/空格这类正常写法。
- 证据：

```ts
const policiesBuilt = swiftFiles.flatMap(({ name, text }) =>
  [...text.matchAll(/PresenceReportPolicy\(minimumInterval:/gu)].map(() => name),
);
expect(policiesBuilt).toEqual([path.join("HimawariCore", "OwnerPresence.swift")]);
...
const sensorsBuilt = swiftFiles.flatMap(({ text }) =>
  [...text.matchAll(/PresenceSensor\(([^)]*)\)/gu)].map((match) => match[1]),
);
expect(sensorsBuilt).toEqual(["app: model.app"]);
```

- 建议：给 sensor 匹配也保留文件名，并断言构造点在 `HimawariMacUI/MenuBarController.swift`；策略正则允许空白/`.init`，或直接解析构造表达式。补一条“把 sensor 搬到 demo”会失败的反向测试。

## 侧重检查

- **错误路径/不可信输入**：核对了通知 id 的产生端与使用端。服务端 `NOTIFICATION_ID` 是 `^[A-Za-z0-9_-]{1,64}$`，Mac 收到的 id 来自 `webPushTopic()`（sha256 前 24 字节的 base64url，32 字符），能通过该规则；客户端目前只把 id 写入本地 `settled-notices.json` 和 `himawari.notice.<id>`，没有调用 `/notifications/settled`。因此本地 `settledLimit = 500` 大于服务端 `SETTLED_MAXIMUM_IDS = 200` 目前不构成跨端失败；以后若接上该接口需要重新核对。
- **presence 输入**：服务端 `ISO_MILLISECONDS` 校验 `lastInputAt`，未来时间会被 `Math.min(reported, serverTime)` 夹到服务端当前时间，不会因客户端时钟略快直接 400；这部分旧代码与作者说法一致。
- **安全/资源**：settled 列表有 500 上限，服务端通知队列有 200 上限；临时设备库现在会清理；没有新增密钥、网络出口或外部输入解析。
- **不可撤销操作**：唯一持久化动作仍是写 settled 文件；失败静默问题见意见 1。
- **规则/文档一致性**：本轮增量不进入提示词或模型请求组装；`prompt-prefix.md` 的只追加规则不受影响。CI 中没有 Swift 构建（`ci.yml` 未出现 swift/xcode/macos），MacUI 测试确实只在本地 macOS 跑；tooling 用例在 `ci/policy.json:232-233` 的 tooling include 范围内。
- **未核实**：没有实际运行 Swift 测试、tooling 测试或 macOS 编译；没有逐页对照规划文档 `/mnt/project-files/plans/push-followup-proposal.md`。

## 推测（未证实/当前路径下不可达）

- 换库后若旧设备流仍有一条迟到的 `notification.withdraw` 到达，`MenuBarModel.receive` 会直接调用 `notices.withdraw(id)`，把旧 id 写进新库；`receive` 没有库代次检查。读代码看生产路径是 `forget()` 先 `chat.stop()` 再把 store 设 nil，`activate()` 只在未激活状态调用，所以当前不可达；若以后允许热换库，需要补代次/来源校验。
- `AppModel.onDeviceStoreChange` 是单消费者回调，当前只有一个 `MenuBarModel`；若同一 `AppModel` 被两个模型共享，后创建的会覆盖前一个的监听。当前代码没有这种用法。
- 第一次绑定 store 时 `remember(in:)` 会从 `notices.items` 删除已 settled 的项，但不会调用 `removeNotice` 撤销可能已显示的系统通知；当前生产路径在第一次绑定前不会显示通知，所以未触发。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 本轮增量不涉及。改动只在 Mac 客户端通知状态、AppModel 的 store 回调和测试；没有改系统提示、工具定义、历史消息或遮盖结果，也没有改模型请求组装代码。发给模型的内容仍只在末尾追加，本轮没有把新的每轮变化值放进请求头。完整 PR 增量以外的部分本轮未重审。
2. **同一段文字会不会在不同请求里变成不同字节？** 本轮增量不涉及模型请求序列化。新的 `onDeviceStoreChange`、`useDemoDeviceStore` 和测试辅助都不进入提示词；settled 文件的 JSON 是本地状态，不是模型输入。没有新增时间字段、无序集合或依赖前后文的遮盖。
3. **有没有对应的自动检查，反向用例会失败吗？** 第 1 条有 MacUI 测试覆盖换库、清空、首次绑定和旧卡片 dismiss；删掉清理逻辑或 guard 后这些用例会失败，但 Swift 测试不在 CI 跑。第 5 条有 tooling 测试并会在 CI tooling 项目执行；新增第二个策略或让 sensor 传策略会失败。第 2 条的 settled 损坏/写失败没有测试；第 3 条的高度变化滚动没有测试；第 4 条的测试仍走 DEBUG setter，未覆盖 `activate/forget` 顺序。以上均未实际运行。
4. **新增/修改的每个值，使用端都能接受吗？** 逐个核对过：`AppModel.onDeviceStoreChange` 的生产端是 `store.didSet`，使用端是 `MenuBarModel.followDeviceStore`，类型都是 `FileLocalStore?`；`useDemoDeviceStore` 仅 DEBUG 测试使用；`hasBoundStore`/`deviceStoreChanged` 仅类内使用；`PendingNotifications.rememberingIn`/`settledName` 使用端读取 `[String]`，与写入一致；`PresenceReportPolicy.standard` 的唯一构造在 `OwnerPresence.swift`，`PresenceSensor` 默认 `.standard`，生产构造在 `MenuBarController.swift`，测试读取的服务端最短窗口 30 秒与客户端 15 秒间隔 + 3.75 秒检查 + 10 秒余量一致。未发现增量新增值在直接使用端被拒绝；`settledLimit = 500` 与服务端 200 的差异目前不跨端，因为客户端没有调用 settled 接口。
