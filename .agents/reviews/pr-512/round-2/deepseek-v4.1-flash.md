本轮已停止读代码和调用工具。以下结论仅基于已读到的代码与 diff。

## 本轮查过的范围
- 看了 `git diff 18e25af..7d4fb9`（本轮增量：修正提交 `3de449f1a` + 合并 `7d4fb9`），并对照 `9dd41fe..7d4fb9` 的手表相关文件。
- 核对了增量新增/修改值的直接使用端：`awaitsOwnerWithoutCard`、`watchOfferHost`、`onIPhone.hint`、`hardwareSupportsHaptics`、`retryPairing` 的新分支。
- 顺着“作者说 main 还没有 `GET home`/`POST home/act`”这条说法，核对了 `device-api-routes.ts`、`production-home.ts`、`MenuBarFeed.swift` 的两端契约。
- 未重读合并 main 带来的、与手表无关的首页打分/感知/用量等服务端代码；未在 Mac/Xcode 上编译 watchOS 目标；未运行 `swift test`；pbxproj 本轮未被增量修改，未复核。

## 意见

### 1. 中高：转交确认框已显示主机，但仍不校验链接 origin，伪造链接仍可把表带到别的服务器
- 文件:行：`clients/apple/Sources/HimawariShell/AppModel.swift:121-136`、`clients/apple/Sources/HimawariShell/PhoneWatchRelay.swift:14-23`、`clients/apple/Sources/HimawariCore/Pairing.swift:52-63`、`clients/apple/Sources/HimawariShell/RootView.swift:35-44`
- 问题：上一轮第 2 条只修好了“显示主机”，没有把转交绑定到这台 iPhone 当前配对的服务器。已配对 iPhone 收到任意合法格式的 `himawari-pair:` 链接，只要接着手表，就会弹框；用户点“给手表用”后，手表会按链接里的 origin 自己配对。攻击者只要发一个指向自己服务器的合法链接，仍可借用户点按把表配到别人的服务器。
- 证据：
  - `AppModel.swift:122-128`：`if phase == .active { ... if (try? PairingInvitation.parse(text)) != nil, watchRelay.canOffer { watchOffer = text } ... return }`，没有任何 origin 与当前 `record.origin` 的比较。
  - `PhoneWatchRelay.swift:20-23`：`func send(_ link: String) { guard canOffer else { return }; WCSession.default.transferUserInfo(WatchPairingRelay.message(link)) }`，只校验“有手表”，不校验链接来源。
  - `Pairing.swift:52-60`：只要求 `origin.scheme == "https"`、host 非空、无 user/password/query/fragment、path 为空或 `/`；任意攻击者域名都满足。
  - `RootView.swift:42-44`：`message: { if let host = model.watchOfferHost { Text(host) } }`，只是展示链接主机。
- 证据性质：代码逻辑已读代码证实；“用户点按并确认后表被带到别的服务器”取决于社会工程步骤，属于推测。
- 建议：转交前比较 `invitation.origin` 的 host/port 与当前配对记录的 origin；不一致时拒绝转交，或进入明确的“换服务器”流程并要求二次确认。仅显示主机不足以消除伪造链接。

### 2. 中：手表生成的 `home/act` 请求号可能以 `-` 或 `_` 开头，约 3% 的动作会被服务端 400 拒绝
- 文件:行：`clients/apple/Sources/HimawariCore/Hashing.swift:14-22`、`clients/apple/Sources/HimawariCore/DeviceAPI.swift:28-30`、`clients/apple/Sources/HimawariWatchUI/WatchModel.swift:298-313`、`packages/platform-node/src/device-api-routes.ts:117,1007-1013`
- 问题：手表用 `OutgoingMessage.newId()` 生成 `requestId`，它是无前缀的 base64url；服务端 `/home/act` 要求 `MACHINE_STRING` 首字符必须是字母或数字。base64url 首字符有 1/32 概率是 `-` 或 `_`，这些请求会被 400 拒绝，手表只报一次失败抽动，用户看到的是“偶尔点了没反应”。
- 证据：
  - `Hashing.swift:15-21`：`Data(bytes).base64URLEncodedString()`，随后 `base64URLEncodedString()` 只替换 `+`→`-`、`/`→`_`、去掉 `=`（第 26-31 行）。
  - `DeviceAPI.swift:28-30`：`newId()` 直接返回 `RandomToken.base64URL(byteCount: 16)`，无 `req_` 前缀。
  - `WatchModel.swift:302`：`let requestId = requestIds[identity] ?? OutgoingMessage.newId()`；`311`：4xx 时清掉 id 并报 `taskFailed`。
  - `device-api-routes.ts:117`：`const MACHINE_STRING = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;`；`1010`：`!MACHINE_STRING.test(requestId)` 直接 400。
- 证据性质：读代码证实。该问题不是本轮增量新写的行，但本轮合并 main 后，手表会直接走这条已有服务端校验；`git blame` 显示路由在基准 `9dd41fe` 已存在（`8b9c64225`）。
- 建议：生成 `requestId` 时加合法前缀（如 `req_`），或改用首字符保证为字母/数字的 id；补一条“随机生成 id 也能通过服务端校验”的测试。Mac 菜单栏也使用 `OutgoingMessage.newId()`，同样会受影响，建议一起修。

### 3. 中：`connection` 项的 `reconnect` 动作绑定串为空，手表仍显示按钮，点击必然 400
- 文件:行：`apps/agent-service/src/production-home.ts:144-152,309-329`、`clients/apple/Sources/HimawariCore/WatchGlance.swift:150-156`、`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:103-111`、`packages/platform-node/src/device-api-routes.ts:1014-1015`
- 问题：需要重连的连接项会生成 `actions: [reconnect]`，该动作没有 command，所以 `binding` 为 `null`。手表的 `WatchCard` 会把它当成可点动作展示；点击后客户端因 `binding` 为 nil 省略该字段，服务端要求 `typeof binding === "string"`，直接返回 400。这个按钮对用户是“永远失败”。
- 证据：
  - `production-home.ts:151`：`binding: options.command ? encodeHomeBinding(options.command) : null`。
  - `production-home.ts:327`：`actions: [action(locale, "reconnect", "positive")]`，没有 `command`。
  - `production-home.ts:309-314`：该 item `awaitsOwner: true` 且有 `sentence: HOME_TEXT[locale].gmailReconnect`，因此会进入手表卡片。
  - `WatchGlance.swift:150-155`：`let shown = Self.ordered(Array(item.actions.prefix(...)))`，只要不是 `ownerPresence` 就 `.decide(shown)`。
  - `MenuBarFeed.swift:107-110`：`let binding: String?`，编码时 nil 会被省略（合成 Encodable 使用 `encodeIfPresent`）。
  - `device-api-routes.ts:1014-1015`：`if (typeof binding !== "string") throw new DeviceGatewayError(HOME_ACTION_INVALID, 400);`
- 证据性质：读代码证实。不是本轮增量行，但与本轮合并进来的 `/home/act` 契约直接相关。
- 建议：服务端不应把 `binding: null` 的动作放进首页，或为 reconnect 提供可解析的动作；客户端也应在 `WatchCard` 里过滤掉没有 binding 的“点动作”，改为“在 iPhone 上看”或隐藏。补一条 home/act 合同测试覆盖 `binding: null`。

### 4. 低：上一轮第 6 条的通知问题没有在代码层修复，只是把 README 改成描述现状
- 文件:行：`clients/apple/Sources/HimawariWatchUI/WatchModel.swift:393-412`、`clients/apple/README.md:140`
- 问题：通知仍然没有动作、深链接或 item 标识；点开通知只会打开 App，然后刷新并显示“当时最要紧的一件”，不保证是被通知的那一件事的按钮。上一轮“点开后不保证是同一件事的按钮”在代码上没有变，只是 README 不再声称会显示同一件。
- 证据：
  - `WatchModel.swift:399-409`：通知内容只设置 `title/body/sound`，`UNNotificationRequest` 没有 `categoryIdentifier`，也没有 `userInfo` 携带 `reminderId` 或首页 `key`。
  - `README.md:140`：已改为“点开通知就打开 Himawari，显示当时最要紧的一件事”。
- 证据性质：读代码证实。
- 建议：如果产品接受这个限制，就在文档里明确“不指向同一件”；否则给通知加 `userInfo`/category，点开时路由到对应提醒或首页条目，找不到再退回最要紧的一件。

### 5. 低：README 与作者说法仍有几处和代码不一致
- 文件:行：`clients/apple/README.md:137-138`、`clients/apple/Sources/HimawariShell/AppModel.swift:121-129`、`clients/apple/Sources/HimawariShell/PhoneWatchRelay.swift:14-18`、`packages/platform-node/src/device-api-routes.ts:969,999`、`clients/apple/Tests/HimawariCoreTests/WatchGlanceTests.swift`
- 问题：
  1. 作者说“main 上服务器还没有 `GET home`/`POST home/act`”，但基准 `9dd41fe` 与当前 HEAD 都已存在这两个入口（`device-api-routes.ts:969,999`，`git blame` 指向 `8b9c64225`）。这条说法不成立，本轮不应再用“服务端还没有入口”作为未验证的理由。
  2. `README.md:137` 说已配对的 iPhone 收到链接时“只会问这一句”，但代码只有在 `watchRelay.canOffer` 为真时才问；没有配对/安装手表时链接被静默忽略，什么提示都没有。
  3. 作者说 WatchGlance 有“17 条 Linux 测试”，实际 `WatchGlanceTests.swift` 里是 14 个 `@Test`（第 24、35、46、56、65、77、89、95、118、126、133、140、162、171 行），未在其它测试文件找到 watch 相关测试。
- 证据性质：读代码/git blame 证实；测试数量按文件内容计数，未运行测试。
- 建议：更新作者说明与 README，改成“入口已存在，但客户端与路由的 requestId/binding 契约尚未完全对齐”；README 明确“没有手表时链接不提示”；测试数量按实际统计写。

## 上一轮意见核对
- 上一轮第 2 条（转交主机）：主机已显示，修好一半；origin 仍未绑定，见本轮第 1 条。
- 上一轮第 3 条（watchOS Haptics 全被吞）：已修。`Haptics.swift:60-61` 在 watchOS 返回 `true`，`Haptics.swift:81-89` 的 watchOS `WKInterfaceDevice.play` 分支现在可达。
- 上一轮第 4 条（无句子待办消失）：已修。`WatchGlance.swift:114-116` 新增 `awaitsOwnerWithoutCard`；`WatchViews.swift:126,153` 和 `WatchDemo.swift:120` 在无卡片且有 `awaitsOwner` 项时显示 `onIPhone.hint`；该键在 en/ja/zh-Hans 手表资源里都存在。
- 上一轮第 5 条（重试只清错误页）：已修。`WatchModel.swift:138-156` 对 `keysUnreadable`/`storageUnavailable` 调 `restore()`，对 `stateUnknown` 有记录时回到等待确认并重新轮询。`storageUnavailable` 在 WatchModel 里没有产生点，这个分支目前不可达，但无害。
- 上一轮第 6 条（通知不保证同一件）：未在代码层修复，只改了 README，见本轮第 4 条。
- 上一轮第 9 条（README 说扫到也算）：已修。`README.md:137` 改成“只有从链接点开才会问；扫码只配这台 iPhone”，与 `PairingView.swift:29-32` 的扫描路径（直接 `model.pair(scanned:)`）一致。

## 侧重检查
- 错误路径：`retryPairing` 的 `keysUnreadable`/`stateUnknown` 恢复逻辑合理；`stateUnknown` 进入 `waitForConfirmation` 后仍可能长时间轮询，但任务可取消，且沿用原有机制。`decide` 的 4xx 处理会静默失败，这放大了本轮第 2、3 条的问题。
- 不合规范/不可信输入：`handlePairingLink` 对任意满足 `PairingInvitation` 的 https origin 都会转交，未与当前服务器比对，是本轮最实际的安全缺口；`PairingInvitation.parse` 本身限制了 scheme、user/password、query/fragment、path，这一层是好的。主机名中的双向控制字符等显示欺骗未核实。
- 安全：显示主机是有效缓解，但不等于阻止伪造链接；手表端只显示 6 位数字，最终仍靠用户在网页确认。
- 资源耗尽：通知仍按 64 条上限、同前缀清理后重排；首页条目由服务端限量；未发现增量引入新的无界集合或循环。
- 不可撤销的操作：手表仍是“一点就定”，`cancel`/`undo`/`reject` 等没有额外确认；这是产品既定取舍，不是本轮增量引入，未展开。
- 规则文件/说明文档与代码一致性：本轮增量没有改系统提示词、工具定义或模型请求组装；文档不一致集中在第 5 条。

## 必答问题
1. **是否改变模型已见过的请求开头？** 不涉及本次手表增量。增量只改手表/iPhone 本地 UI、配对重试、触感和本地 Group 状态；没有改系统提示、工具定义、历史消息或遮盖结果。手表说话走既有 thread/message 接口，客户端不拼模型提示。合并 main 带来的服务端提示构造不属于手表增量，本轮未重读、未核实。发给模型的内容仍由既有服务端逻辑决定；本轮没有证据显示它会从“只在末尾追加”变成别的方式。
2. **同一段文字是否会在不同请求里变成不同字节？** 不会由本次增量引入。`awaitsOwnerWithoutCard` 是响应内容的确定性布尔推导；`watchOfferHost` 只用于显示链接 host；`onIPhone.hint` 是静态本地化文本；没有新增带时间字段、无序集合或依赖前后文的遮盖。手表 `locale` 仍由系统首选语言决定，这是既有行为，且只影响请求的 locale 参数，不改变提示前缀；本轮未改。
3. **有没有对应的自动检查，反向用例会失败吗？** 部分有。`WatchGlanceTests.swift:65-75` 覆盖了 `awaitsOwnerWithoutCard`：有 `awaitsOwner` 无句子应为 true，只有非 `awaitsOwner` 项应为 false，`snapshot`（有可显示卡片）应为 false；如果实现退化成“只判断有没有 `awaitsOwner`”或“只看 `pressing == nil`”，对应断言会失败。`retryPairing` 的新分支、watchOS 触感、`watchOfferHost`/origin 校验、通知点击行为都没有自动测试；watchUI 目标在 Linux 上不编译，`swift test` 也覆盖不到这些路径。本轮第 2、3 条的 requestId/binding 契约也没有反向用例。
4. **每个新值/改动值的使用端都能接受吗？**
   - `awaitsOwnerWithoutCard`：产生于 `WatchGlance.swift:114-116`，用于 `WatchViews.swift:126` 和 `WatchDemo.swift:120`，两端都是 watchOS UI，类型为 Bool，接受。
   - `watchOfferHost`：产生于 `AppModel.swift:133-136`，用于 `RootView.swift:43` 的 `Text`，类型接受；但缺少 origin 与当前服务器的一致性校验（第 1 条）。
   - `onIPhone.hint`：en/ja/zh-Hans 手表资源均有，`L.text` 使用 `Bundle.module`，现有 `quiet`/`offline`/`onIPhone` 同文件同机制，接受。
   - `hardwareSupportsHaptics` 的 watchOS `true`：只被 `report`/`playFile` 使用；watchOS 走 `play` 的 `WKInterfaceDevice` 分支，接受。
   - `PairingProblem.storageUnavailable` 在 `retryPairing` 的 switch 中被使用，但 WatchModel 里没有产生它的地方，属于不可达分支，不影响运行。
   - `requestId` 与 `binding`：产生端（手表/Mac）与服务端 `/home/act` 校验端不完全兼容，见第 2、3 条。
   - README/作者说法：与代码存在第 5 条所列不一致。

**未核实**：watchOS/Xcode 目标能否编译；`swift test 180 条通过`是否属实；pbxproj 结构（本轮增量未改，未重读）；主机名双向字符等显示欺骗是否可构造。
