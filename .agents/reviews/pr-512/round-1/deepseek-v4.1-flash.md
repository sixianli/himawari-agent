已按你的要求停止读代码和调用工具。以下是基于已读内容的完整结论。

### 1. 高：手表的主卡片和动作依赖 `GET home` / `POST home/act`，但服务端设备路由里没有这两个入口

- 文件:行：`packages/platform-node/src/device-api-routes.ts:47-61`；`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:94-97`、`:103-112`；`clients/apple/Tests/HimawariCoreTests/WatchGlanceTests.swift:128-148`
- 问题：手表的“等你定的一件事”读 `home`、点按钮写 `home/act`，但服务端 `DEVICE_API_ROUTES` 只有 `config/stream/messages/threads/...`，没有 `home`、`home/act`。`onRequest` 对不在表里的路径直接 `rejectNotAllowed()`，所以这两个请求不会进入业务层。作者说“另一线程在做”属实，但当前提交上手表主功能不可用，测试只对 mock 断言 URL。
- 证据：
  ```
  // device-api-routes.ts:48-60
  { method: "POST", path: "pair", signed: false },
  { method: "GET", path: "config", signed: true },
  ...
  { method: "POST", path: "payloads/text", signed: true },
  ```
  ```
  // MenuBarFeed.swift:94-96
  public func watchHome(locale: String) async throws -> WatchHome {
      let data = try await http.send(DeviceRequest(method: "GET", path: "home", query: [...]
  ```
  ```
  // WatchGlanceTests.swift:129-143
  let exchange = RecordingExchange([
      HTTPExchangeResponse(status: 200, body: Data(snapshot.utf8)),
      HTTPExchangeResponse(status: 200, body: Data("{}".utf8)),
  ])
  ... #expect(read.path == "/api/device/v1/home")
  ```
- 建议：在服务端设备路由落地前，不要把该功能当作可用；新增至少一条走真实路由注册/真实 `DeviceAPI` 的集成测试（而不是任意请求都返回 200 的 mock）。若不能同批落地，应在客户端明确降级并让测试预期失败，避免 mock 绿灯掩盖 404。
- 读代码证实的：路由表没有 `home`/`home/act`，客户端确实发这两个路径，测试确实使用 mock。
- 推测：实际会返回路由拒绝（不是业务 404），但结果同样是主卡片/动作失败。

### 2. 高：iPhone 转交配对时不显示服务器主机，伪造的合法格式链接可把表配到别人的服务器

- 文件:行：`clients/apple/Sources/HimawariShell/RootView.swift:35-42`；`clients/apple/Sources/HimawariShell/AppModel.swift:121-129`；`clients/apple/Sources/HimawariCore/Pairing.swift:52-63`；对照 `clients/apple/Sources/HimawariShell/PairingView.swift:144-150`
- 问题：iPhone 已配对且手表可接管时，`handlePairingLink` 只检查链接能被 `PairingInvitation.parse` 解析，就弹出“给这块 Apple Watch 用吗”，对话框没有显示 `origin`/host；用户点“给手表用”后，手表直接按链接里的服务器主机开始配对。直接配对流程会在 `confirmServer(host)` 里显示主机，转交流程没有这一步。合法格式的链接只需是 https、code 符合格式，任何人都能生成。
- 证据：
  ```
  // RootView.swift:35-42
  .confirmationDialog(
      L.text("watch.offer.title"),
      isPresented: Binding(get: { model.watchOffer != nil }, ...),
      titleVisibility: .visible
  ) {
      Button(L.text("watch.offer.watch")) { model.sendOfferToWatch() }
  ```
  ```
  // PairingView.swift:149-151
  Text(host)
      .font(.system(size: DesignTokens.TypeScale.title1.size, weight: .bold))
  ```
  ```
  // Pairing.swift:52-61
  origin.scheme == "https",
  origin.host?.isEmpty == false,
  ...
  envelope.code.range(of: "^[A-Za-z0-9_-]{22}$", ...) != nil
  ```
- 建议：在确认框的 `message`（或标题）里显示 `PairingInvitation.parse(text)?.origin.host`，至少让用户看到将要把手表接到哪台服务器；更高要求是只接受来自配对页面/扫码器的链接，或让手表也显示 host 而不是只显示 6 位数字。6 位数字不能证明服务器身份，因为攻击者的服务器也能显示同一个数字。
- 读代码证实的：转交对话框没有 host；直接配对流程有 host；链接格式校验不校验主机身份。
- 推测：这是可被网页/其他 App 触发的配对钓鱼路径。

### 3. 高：已配对 iPhone 收到任意 `himawari-pair:` URL 会被踢出 active 状态，取消重配也回不去

- 文件:行：`clients/apple/Sources/HimawariShell/RootView.swift:34`；`clients/apple/Sources/HimawariShell/AppModel.swift:121-129`、`:109-118`、`:147-151`、`:396-408`
- 问题：`.onOpenURL` 全局挂在 `app` 上。已配对时，只有“链接合法且手表可接管”才走 `watchOffer`；其余情况全部落到 `pair(scanned:)`：
  - 链接格式坏：`pair` 捕获解析错误，把 `phase` 设为 `.unpaired(.unreadableCode)`，用户从聊天页被踢到配对页；
  - 链接合法但手表不可接管：进入 `.confirmingServer`，用户选择“取消”后 `declineScannedServer()` 把 `phase` 设为 `.unpaired(nil)`，不会恢复 `.active`；`becameActive()` 也不处理 `.unpaired(nil)`，只能重启 App 恢复。
  如果用户在确认页点了确认，会走新的配对并 `claim` 本地 store；`LocalStore.claim` 对 owner 不同会 `removeAll()`，本地未发消息等会丢失。
- 证据：
  ```
  // AppModel.swift:121-128
  public func handlePairingLink(_ text: String) {
      #if os(iOS)
      if phase == .active, (try? PairingInvitation.parse(text)) != nil, watchRelay.canOffer {
          watchOffer = text
          return
      }
      #endif
      pair(scanned: text)
  }
  ```
  ```
  // AppModel.swift:147-150
  public func declineScannedServer() {
      lastScanned = nil
      keysMadeFor = nil
      phase = .unpaired(nil)
  }
  ```
- 建议：`phase == .active` 时只允许“合法链接 + 手表可接管”的转交；其他链接直接忽略（或提示“这台 iPhone 已配对”），绝不调用 `pair(scanned:)`。若确实允许重新配对，取消时必须恢复 `.active`，并给用户明确的“切换服务器”入口和不可撤销提示。
- 读代码证实的：上述状态转移和取消行为。
- 推测：任意能打开自定义 URL 的网页/App 都能触发这个 UI 中断；确认重配后的本地数据删除由现有 `claim` 逻辑决定。

### 4. 中：watchOS 上所有 Haptics 被策略全部吞掉，`play` 的手表分支是死代码

- 文件:行：`clients/apple/Sources/HimawariDesign/Haptics.swift:57-63`、`:79-87`；`clients/apple/Sources/HimawariCore/Haptics.swift:133-134`；`clients/apple/Sources/HimawariWatchUI/WatchModel.swift:236`、`:297-300`、`:358`
- 问题：`Haptics.report` 把 `hardwareSupportsHaptics` 作为 `systemHapticsEnabled` 传进策略；这个属性在 watchOS 上走 `#else false`。`HapticPolicy.decide` 第一行就 `guard situation.systemHapticsEnabled else { return nil }`，因此 `play` 里新加的 `#elseif os(watchOS)` 永远不会执行。手表上的配对成功、动作成功/失败、长回答完成全都没有触感；作者“手表触感走 Haptics”和 README 的描述与运行结果不一致。
- 证据：
  ```
  // HimawariDesign/Haptics.swift:57-63
  private static var hardwareSupportsHaptics: Bool {
      #if canImport(CoreHaptics) && os(iOS)
      CHHapticEngine.capabilitiesForHardware().supportsHaptics
      #else
      false
      #endif
  }
  ```
  ```
  // HimawariCore/Haptics.swift:133-134
  public mutating func decide(...) -> HapticPattern? {
      guard situation.systemHapticsEnabled else { return nil }
  ```
- 建议：在 watchOS 上让 `hardwareSupportsHaptics` 返回 `true`（或 `report` 单独传入 watch 的能力），再走 `WKInterfaceDevice.play`；补一条 watchOS 分支不可静默为空的检查/测试。若不想让 Haptics 策略管手表，直接在手表路径调用 `WKInterfaceDevice`。
- 读代码证实的：watchOS 路径确实在策略层返回 nil。
- 推测：无（这是确定的控制流）。

### 5. 中：没有服务器句子的待办/审批在手表上完全消失，“在 iPhone 上看”也不会出现

- 文件:行：`apps/agent-service/src/production-home.ts:449-453`；`clients/apple/Sources/HimawariCore/WatchGlance.swift:110-112`、`:140-141`；`clients/apple/Sources/HimawariWatchUI/WatchViews.swift:123-127`；`clients/apple/Tests/HimawariCoreTests/WatchGlanceTests.swift:56-63`
- 问题：手表用 `sentence != nil` 决定一条 `awaitsOwner` 项是否成为腕上卡片。当前 head 的 `approvalSource` 对所有审批都写 `...NO_SENTENCE`（`sentence: null`），因此审批永远不会成为 `pressing`/`WatchCard`，用户看到的是“没有要你定的事”，而不是“在 iPhone 上看”。即使回到 base 的 urgency 逻辑，模型 copy 失败或 urgency 关闭时也是同样的 `NO_SENTENCE`。这和“要本人在场的审批手表上只给‘在 iPhone 上看’”的要求冲突。
- 证据：
  ```
  // production-home.ts:449-453
  items.push({
    key: `approval:${approval.id}`,
    kind: "approval",
    awaitsOwner: true,
    ...NO_SENTENCE,
  ```
  ```
  // WatchGlance.swift:110-112
  public var pressing: WatchItem? {
      items.first { $0.awaitsOwner && $0.sentence != nil }
  }
  ```
  ```
  // WatchGlance.swift:140-141
  public init?(_ item: WatchItem) {
      guard let sentence = item.sentence else { return nil }
  ```
- 建议：对 `awaitsOwner` 且需要本人在场、但没有服务器句子的项，仍生成一个只含“在 iPhone 上看”的卡片（不拼业务句子，只显示本地 UI 文案），或让服务端给审批提供稳定的通用句子。补一条“ownerPresence 项但 sentence 为 null”的测试。
- 读代码证实的：当前 head 的审批没有句子；手表逻辑会跳过无句子项。
- 推测：base 的 urgency 开启且成功时审批有句子；失败路径仍会复现该问题。

### 6. 中：手表的错误恢复按钮和 iPhone 不一致，`keysUnreadable`/`stateUnknown` 点“重试”只是清掉错误页

- 文件:行：`clients/apple/Sources/HimawariWatchUI/WatchModel.swift:106-130`、`:138-144`；`clients/apple/Sources/HimawariWatchUI/WatchViews.swift:51-57`；对照 `clients/apple/Sources/HimawariShell/AppModel.swift:255-290`
- 问题：手表对所有 `PairingProblem` 都显示同一个“再试一次”，调用 `retryPairing()`。但 `retryPairing()` 只在有 `lastLink` 时重新提交；`restore()` 产生的 `.keysUnreadable` 通常没有 `lastLink`，于是只把 `phase` 设成 `.unpaired(nil)`，既不重新读 keychain，也不恢复已配对的记录。`.stateUnknown` 则会把旧链接再提交一次，而不是像 iPhone 那样用 `configuration()` 重新核对。结果是用户点“重试”后问题没有真正重试。
- 证据：
  ```
  // WatchModel.swift:138-143
  public func retryPairing() {
      guard let lastLink else {
          phase = .unpaired(nil)
          return
      }
      submit(lastLink)
  }
  ```
  ```
  // AppModel.swift:255-261
  public func retryReadingKeys() {
      if phase == .unpaired(.stateUnknown) {
          recheckUnknownState()
      } else {
          restore()
      }
  }
  ```
- 建议：让手表也区分 `.keysUnreadable`/`.storageUnavailable`（调用 `restore()`）和 `.stateUnknown`（重新 `configuration()` 核对），只有真正的配对失败才重提交 `lastLink`。增加对应的错误恢复测试。
- 读代码证实的：手表和 iPhone 的恢复路径不同。
- 推测：`keysUnreadable` 可能由临时 keychain 读取失败造成，重启 App 能恢复，但当前按钮不会。

### 7. 中：通知没有动作或深链接，点开后不保证是同一件事的按钮

- 文件:行：`clients/apple/Sources/HimawariWatchUI/WatchModel.swift:387-397`；README 的说法在 `clients/apple/README.md:140`
- 问题：本地通知只设置了 `title`（格式化后的时间）、`body`（提醒文本）、`sound`，没有 `userInfo`、`categoryIdentifier` 或 `UNNotificationCategory`，也没有处理通知点击的参数。因此“点开通知，手表上就是同一件事和它的按钮”没有代码支撑：点开只会启动/打开 App，显示当时 `home` 里最要紧的一件；如果排序变了或该提醒已不是第一件，看到的是别的事，也没有通知上的按钮。
- 证据：
  ```
  // WatchModel.swift:388-397
  let content = UNMutableNotificationContent()
  content.title = reminder.due.formatted(date: .omitted, time: .shortened)
  content.body = reminder.text
  content.sound = .default
  ...
  let request = UNNotificationRequest(
      identifier: Self.reminderPrefix + reminder.reminderId,
      content: content,
      trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)
  )
  ```
- 建议：在 `content.userInfo` 写入 `reminderId`/item key，并在 App 启动时读取并定位到对应卡片；若要“和它的按钮”，需要注册通知类别或动态 action。否则把 README 改成“点开通知打开 Himawari，显示当前最要紧的一件事”。
- 读代码证实的：没有 `userInfo`/类别/动作/点击处理。
- 推测：如果该提醒在刷新后仍是最要紧的 `awaitsOwner` 项，用户会看到同一件；否则不一定。

### 8. 中：“在 iPhone 上看”只是本地改文案，没有把手表上的事项交给 iPhone 的通道

- 文件:行：`clients/apple/Sources/HimawariWatchUI/WatchViews.swift:198-206`；`clients/apple/Sources/HimawariShell/PhoneWatchRelay.swift:1-33`；`clients/apple/Sources/HimawariWatchUI/WatchAppDelegate.swift:54-68`
- 问题：按钮点击只把本地 `handedOff = true`，随后显示“在 iPhone 上打开 Himawari 接着看”。但手表和 iPhone 之间没有传递这条事项的接口：`PhoneWatchRelay` 只有发送配对链接，`PairingRelayReceiver` 只接收并校验配对链接，没有 item key/审批 id 的消息。用户点“在 iPhone 上看”后，iPhone 不会知道是哪一条。
- 证据：
  ```
  // WatchViews.swift:198-206
  case .handOff:
      if handedOff {
          Text(L.text("onIPhone.hint")) ...
      } else {
          Button(L.text("onIPhone")) { handedOff = true }
      }
  ```
- 建议：增加一条 WatchConnectivity 消息（携带 item key / approval id），iPhone 收到后打开对应会话或审批；或者把按钮文案改成明确的“请在 iPhone 上打开 Himawari”，不要暗示已经定位。补一条两端消息键和价值校验的测试。
- 读代码证实的：没有 handoff 通道。
- 推测：无（当前按钮不会触发任何跨设备动作）。

### 9. 低：README 说“点开或扫到都算”，但扫描路径永远不会转交手表

- 文件:行：`clients/apple/Sources/HimawariShell/PairingView.swift:29-35`；`clients/apple/Sources/HimawariShell/RootView.swift:27-31`；`clients/apple/README.md:137`
- 问题：配对扫码器直接调用 `model.pair(scanned:)`，不经过 `handlePairingLink`；而 `PairingView` 只在 `phase != .active` 时显示。也就是说，已配对 iPhone 上根本扫不到码；未配对时扫码只会配这台 iPhone，不会问“给手表用吗”。
- 证据：
  ```
  // PairingView.swift:30-32
  PairingScanner { text in
      scanning = false
      model.pair(scanned: text)
  ```
  ```
  // RootView.swift:27-30
  if model.phase == .active, let chat = model.chat {
      MainTabsView(model: model, chat: chat)
  } else {
      PairingView(model: model)
  }
  ```
- 建议：让扫码回调走 `model.handlePairingLink(text)`，并在已配对时提供扫码入口；或者把 README 改成“只有通过 URL 打开时才转交手表”。
- 读代码证实的：扫描路径绕过转交逻辑。
- 推测：无。

### 10. 低：“件数和 iPhone 红点相同”未证实，Mac 菜单栏并不按 `incompleteSources` 隐藏件数

- 文件:行：`clients/apple/Sources/HimawariCore/WatchGlance.swift:114-116`；`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:59`；`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:32-40`；`clients/apple/README.md:138`
- 问题：手表在 `incompleteSources` 非空时返回 `nil`，隐藏件数。但 Mac 菜单栏的 `awaitingCount` 直接是 `home?.awaitingCount ?? 0`，且 `HomeSnapshot` 根本不解码 `incompleteSources`。如果 iPhone 红点也直接使用 `awaitingCount`，手表就会和它不一致；如果 iPhone 另有规则，仓库里没有证据。
- 证据：
  ```
  // WatchGlance.swift:114-116
  public var countedAwaiting: Int? {
      incompleteSources.isEmpty ? max(0, awaitingCount) : nil
  }
  ```
  ```
  // MenuBarModel.swift:59
  var awaitingCount: Int { home?.awaitingCount ?? 0 }
  ```
- 建议：把“未读全来源时不显示件数”抽成共享规则，Mac/iPhone/手表都消费同一字段；或者把 README 改成“手表自己的规则”。补一条与 iPhone 实际 badge 计算的对照测试。
- 读代码证实的：Mac 不隐藏；`HomeSnapshot` 没有该字段。
- 推测：iPhone 红点实现不在本仓库，无法核实。

### 11. 低：作者说 `WatchGlance.swift` 有 17 条 Linux 测试，实际 `WatchGlanceTests` 是 13 个 `@Test`

- 文件:行：`clients/apple/Tests/HimawariCoreTests/WatchGlanceTests.swift`（`@Test` 在第 24、35、46、56、65、77、83、106、114、121、128、150、159 行）
- 问题：最终文件只有 13 个测试；初始 commit `96c0141e6` 的版本是 11 个，最后一个 commit 加 2 个。作者的说法与代码不一致。核心反向用例是有的（无句子、ownerPresence、incompleteSources、负 limit、文本放不下等），但 `WatchModel`、`PhoneWatchRelay`、`AppModel.handlePairingLink`、Widget、pbxproj、watchOS 编译都没有自动检查；第 1 条的 mock 测试尤其不能发现真实路由缺失。
- 证据：
  ```
  // WatchGlanceTests.swift:24, 35, 46, ...
  @Test func readsTheHomeSnapshot...
  @Test func theCardPutsTheAffirmativeButtonFirst...
  ...
  @Test func complicationStoreReturnsUnknownUntilSomethingWasSaved() {
  ```
- 建议：把测试条数改对；为第 1、2、3、6、8 条补可失败的测试。至少给 `PhoneWatchRelay`/`handlePairingLink` 加一个可在 iOS 或纯逻辑层测试的用例。
- 读代码证实的：13 个 `@Test`。
- 推测：作者可能把其他测试文件的数量合并计算了；`179 passed` 未运行核实。

### 12. 低：`4f93d25..18e25af` 的 diff 不是本 PR 的净改动，包含分叉 main 的无关删除

- 文件:行：`git show --stat 96c0141e6`（3 个文件）、`git show --stat 18e25af`（37 个文件）与 `git diff --stat 4f93d25..18e25af`（114 个文件）
- 问题：base 在 PR 449 那条 main 线上，包含 home urgency/web push 等；手表分支从更早的 main 分出并合并了另一条 main（a2b17e304）。因此 base..head 里出现 `packages/application/src/services/home-urgency.ts`、`test/integration/home-urgency.test.ts`、`packages/prompt-catalog/src/review.ts` 等大量删除，但这些不是三条手表提交引入的。把它们算成 PR 改动会误判“PR 删掉了 home urgency/提示词”。
- 证据：`git show --stat 96c0141e6` 只改 `MenuBarFeed.swift`、`WatchGlance.swift`、`WatchGlanceTests.swift`；`git show --stat 18e25af` 只改 Apple Watch 相关文件；base..head 却有 114 个文件。
- 建议：复核材料改用真正的 merge-base（或把最新 main 合进分支后重新生成 diff）。本回复不把上述删除算作 PR 512 的改动。
- 读代码/提交证实的：提交边界与 diff 文件数不一致。
- 推测：这是基线选择问题，不是作者有意删除。

**侧重检查**

- 错误路径：核对了配对解析失败、`keysUnreadable`、`stateUnknown`、设备 revoked、动作失败、通知授权失败、`texts` 为空等路径。发现第 3、6 条；`PairingProblem.from`、`PairingAttempt.mayHavePaired`、`RestoreDecision` 本身的映射是完整的。
- 不合规范/不可信输入：`PairingInvitation.parse` 校验 https、host、无 user/password/query/fragment、code 22 位；手表 `WatchPairingRelay.link` 又解析一次；服务端 `normalizeDeviceName` 和客户端 `PairingRequestLimits.deviceName` 双重清洗设备名。未发现把服务器文本当 HTML/命令执行；服务器文本只进 SwiftUI `Text` 和通知 body。
- 安全：发现第 2 条（转交不显示 host）和第 3 条（active 状态被 URL 打断/重配）。配对密钥、6 位核对数字、客户端/服务端算法一致（`PairingNumber` 与 `devicePairingNumber`），`kind: watch` 和 `releaseChannel: direct` 服务端都接受（`paired-devices.ts:3`、`:6-11`）。手表的 `WatchItem` 完全丢弃 `dataClassification`，widget 会把最近一句写进 App Group 的 `UserDefaults` 并显示在表盘；这是隐私上的可改进点，是否构成问题取决于首页项分级和对表盘可见性的要求。
- 资源耗尽：提醒计划限制在 64 条并按时间排序；`texts` 每批最多 100；`WatchTextFit` 是线性扫描。`awaitAnswer` 在 `connectionMaxSeconds == 0` 时会一直轮询到用户取消；服务端实际是否会给 0 未核实。`refresh()` 可被 `.task`、scenePhase、后台刷新并发调用，没有 in-flight 去重，旧响应理论上可能覆盖新响应（低风险）。
- 不可撤销：第 3 条的重配确认会走 `LocalStore.claim`，owner 变化时 `removeAll()`；手表动作是一点即发，没有二次确认（设计如此）。
- 规则/文档/代码一致：本地化键 `unpaired.*`、`problem.*`、`talk.*`、`watch.offer.*`、`glance.*` 在三种语言里都存在；设计令牌 `Watch` 和 `watch*` 字号已由生成器输出且 `check-design` 已把 `Sources/HimawariWatchUI` 纳入；App Group 构建键 `HIMAWARI_APP_GROUP` 在手表和 Widget 的 Info.plist/entitlements 里同名。发现第 4、7、8、9、10、11 条的不一致。
- 未核实：Mac 上的 Xcode 编译、pbxproj 结构、Swift 6 严格并发下的 `WKApplicationDelegate`/`ButtonStyle` 隔离、App Group 的 provision、`backgroundTask(.appRefresh("himawari.home"))` 是否需要 `BGTaskSchedulerPermittedIdentifiers`、真实服务端 `home` 响应形状、179 条测试是否通过。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 就本 PR 的三条手表提交而言，不会：它们只新增客户端读取/发送代码，没有改系统提示、工具定义、历史存储或遮盖逻辑。手表发的新用户消息仍走既有 `createThread`/`send`（`DeviceAPI.swift:164-187`），`send` 的 body 只有 `messageId/threadId/expectedRevision/text`，`createdAt` 不进请求；`locale` 是按设备偏好的固定值。因此没有把每轮会变的值挪进请求头。需要说明：base..head diff 里删除 `home.urgency` 提示词不是这三条手表提交做的，而且它是后台调用提示词，不是对话请求开头；如果按真正 merge-base 复核，应把它排除出本 PR。按规则 [prompt-prefix.md#rules](../../.agents/instructions/prompt-prefix.md#rules)，结论仍是“只在末尾追加”。
2. **同一段文字会不会在不同请求里变成不同字节？** 手表自身没有组装/修改模型提示词或遮盖；`WatchReminderPlan` 用 `(due, reminderId)` 稳定排序，`WatchCard.ordered` 用原始 offset 做次序决胜，`WatchComplicationState` 只是本地 JSON，不进入模型请求。`requestId` 是幂等标识，不是提示词内容。未发现本 PR 引入依赖前后文的遮盖、时间字段进入提示词或无序列集合。唯一的大改动（home urgency 删除）来自分叉 main；若它被算进 diff，它删除的是一类后台提示词，不改变已有对话的请求开头字节，但会改变首页排序/审批 copy 的生成，需要另行核实。
3. **有没有对应的自动检查，反向用例真的会失败？** 核心逻辑有 13 个 `@Test`，反向用例是真实的：`anythingThatNeedsTheOwnerPresent...` 会在 ownerPresence 被错误当成可执行动作时失败；`theCountIsHidden...` 会在 incompleteSources 被忽略时失败；`reminders... limit: -1` 会在没有 `max(0, limit)` 时失败；`textFits` 的 width=0、三行文本会在 `fits` 不检查边界时失败；`onlyAValidPairingLink...` 会在接受坏链接时失败。但：
   - 第 1 条的服务端入口只有 mock 测试，所以测试会绿而真实请求会失败；
   - `WatchModel`、`PhoneWatchRelay`、`AppModel.handlePairingLink`、Widget、通知点击、Haptics watch 分支、pbxproj/嵌入都没有自动检查；
   - 第 2、3、4、6、8 条没有任何测试会失败。
   `17 条` 的说法与 13 个 `@Test` 不符；“179 passed”我无法运行核实。
4. **每个新值的使用方都能接受吗？** 逐项核对：
   - `GET home` / `POST home/act`：客户端产生（`MenuBarFeed.swift:94-112`），服务端 `DEVICE_API_ROUTES` 不接受（`device-api-routes.ts:47-61`），这是第 1 条。
   - `key`/`action`/`ownerPresence`/`polarity`：来自合约的 `home.snapshot`，服务端枚举接受。
   - `binding`：客户端测试和 `HomeAction` 有，但合约 action 对象里没有这个字段（`contracts-v2.ts:755-764` 只有 `action/label/labelBasis/polarity/ownerPresence/reviewLabel`）；未来 `home/act` 必须接受或忽略它，当前无法验证。
   - `requestId`：不在当前任何 `home.*` 合约里，`home/act` 路由不存在，无法验证。
   - `kind: watch`：服务端 `PAIRED_DEVICE_KINDS` 包含 `watch`（`packages/application/src/ports/paired-devices.ts:3`）；`releaseChannel: direct` 也在允许列表（`:6-11`）。
   - `pairingNumber`：客户端 `PairingNumber.digits` 与服务端 `devicePairingNumber` 的算法一致。
   - `himawari-pair` scheme：`PairingInvitation.scheme` 与 iOS `CFBundleURLSchemes` 一致。
   - `himawariPairingLink`：发送和接收都用 `WatchPairingRelay.key`，一致；接收端还重新校验链接。
   - `HimawariAppGroup`/`HIMAWARI_APP_GROUP`：手表和 Widget 两端同名，但 provision 未核实。
   - `himawari.home` 后台任务标识：只在 `.backgroundTask` 和 `scheduleNextRefresh` 使用，Info.plist 未声明；是否需要声明未核实。
   - `incompleteSources`：只有手表消费；Mac 不使用、iPhone 不在仓库，无法证明“和 iPhone 红点相同”。
   - 本地化键：`unpaired.*`、`problem.*`、`talk.*`、`watch.offer.*`、`glance.*` 都已找到，无缺失。
   - `reminderId`：合约是 `machineString`，作为通知 identifier 基本安全；手表未再做格式校验。
   - 主要不一致就是第 1、2、3、5、10 条：客户端产生的值要么没有服务端消费者，要么两端对“句子/件数/主机”的假设不同。
