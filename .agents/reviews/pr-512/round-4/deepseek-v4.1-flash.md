## 意见

### 1. 中低：Mac 菜单栏对“只有无绑定串动作”的卡片会变成没有任何按钮、也没有出口的卡片，并继续挡住后面待办

文件:行：`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:29`、`clients/apple/Sources/HimawariMacUI/PanelView.swift:20-22,81-91`、`apps/agent-service/src/production-home.ts:309-330,151`

问题：上一轮的 400 确实修好了（过滤掉 `binding == nil` 的动作），但服务器真实产生的 `connection:gmail` 待办只有一条动作，且它的 `binding` 就是 `nil`。过滤后 `shownActions` 为空，Mac 面板仍把它当作 `mostPressing` 显示，只是没有任何按钮，也没有手表那样的“在 iPhone 上看”；这张卡片排在前面时，后面的待办不会被显示。新增测试只覆盖了“另有一条绑定串动作”的情况，没有覆盖服务器真实形状。

证据（读代码证实）：

```swift
// MenuBarFeed.swift:29
public var shownActions: [HomeAction] { Array(actions.filter { $0.binding != nil }.prefix(Self.shownActionLimit)) }
```

```swift
// MenuBarFeed.swift:37-39
public var mostPressing: HomeItem? {
    items.first { $0.awaitsOwner && $0.sentence?.isEmpty == false }
}
```

```swift
// PanelView.swift:20-22, 81
if let item = model.mostPressing {
    card { awaiting(item) }
}
...
if !item.shownActions.isEmpty {
```

```ts
// production-home.ts:309-330
if (connection.status === "needs_reconnect" && since)
  items.push({
    ...
    actions: [action(locale, "reconnect", "positive")],
    ...
  });
// production-home.ts:151
binding: options.command ? encodeHomeBinding(options.command) : null,
```

```swift
// MacInputTests.swift:256-260：测试里还有一条 binding: "b1" 的“知道了”，所以过滤后仍剩一个按钮
let item = HomeItem(... actions: [
    HomeAction(action: "reconnect", label: "重连", polarity: "positive", ownerPresence: false, binding: nil),
    HomeAction(action: "dismiss", label: "知道了", polarity: "neutral", ownerPresence: false, binding: "b1"),
])
#expect(item.shownActions.map(\.label) == ["知道了"])
```

推测：`connection` 待办不一定总排第一（取决于 `orderHomeItems` 的排序），但当它是唯一或最靠前的待办时，用户会看到一张无法操作、也不说明该去哪里的卡片。未在本机运行 Mac 界面验证实际排序和视觉效果。

建议：不要只过滤。Mac 端在 `shownActions.isEmpty && item.awaitsOwner` 时给出一个明确的出口（例如“在 iPhone/网页上处理”的说明或按钮），或让 `mostPressing` 跳过没有任何可执行动作的项；并补一条测试，使用服务器真实的“单条 reconnect、binding 为 null”形状，而不是带绑定串的 dismiss。

### 2. 低：`offerable` 用 URL 原样相等判断“同一服务器”，同一 origin 带不带尾斜杠会被判成不同服务器

文件:行：`clients/apple/Sources/HimawariCore/WatchGlance.swift:248-251`、`clients/apple/Sources/HimawariCore/Pairing.swift:40,84`、`clients/apple/Sources/HimawariCore/DeviceAPIClient.swift:196-208`

问题：`PairingInvitation.parse` 同时接受 `https://host` 和 `https://host/` 两种 origin（`path.isEmpty || path == "/"`），而 `offerable` 直接用 `URL ==` 比较。若这台 iPhone 配对时记录的 origin 带尾斜杠，而新手表链接不带（或反过来），明明是同一服务器，却不会出现“给这块 Apple Watch 用吗”。这与 README 第 170 行“链接指向的服务器和这台 iPhone 配对的服务器相同”的承诺不一致，失败方式是静默不提示。

证据（读代码证实）：

```swift
// WatchGlance.swift:248-251
public static func offerable(_ link: String, pairedOrigin: URL?) -> Bool {
    guard let pairedOrigin, let invitation = try? PairingInvitation.parse(link) else { return false }
    return invitation.origin == pairedOrigin
}
```

```swift
// Pairing.swift:84
origin.path.isEmpty || origin.path == "/",
// Pairing.swift:40：生成链接时只去掉一个尾斜杠
let origin = origin.absoluteString.hasSuffix("/") ? String(origin.absoluteString.dropLast()) : origin.absoluteString
```

```swift
// DeviceAPIClient.swift:196-208：同一模块里已有“去掉全部尾斜杠”和“host 转小写”的归一化做法
while text.hasSuffix("/") { text.removeLast() }
...
let host = (origin.host ?? "").lowercased()
```

新增的反例测试只覆盖了完全不同 origin、nil 和非法链接，没有覆盖同一服务器的两种合法写法：

```swift
// WatchGlanceTests.swift:154-160
#expect(WatchPairingRelay.offerable(link, pairedOrigin: origin))
#expect(!WatchPairingRelay.offerable(link, pairedOrigin: try #require(URL(string: "https://other.example.test"))))
#expect(!WatchPairingRelay.offerable(link, pairedOrigin: nil))
#expect(!WatchPairingRelay.offerable("himawari-pair:nonsense", pairedOrigin: origin))
```

推测（未在本机跑 Swift 验证）：Foundation 的 `URL ==` 不把 `https://h` 和 `https://h/` 视为相等；若实际会归一化，则此条不成立。显式默认端口（`:443`）与省略端口也可能出现同类不一致。

建议：像 `DeviceAPIClient.authority` 那样比较归一化后的 origin（scheme + 小写 host + 显式端口，忽略 path 和尾斜杠），或在 `PairingInvitation` 里提供一个统一的 canonical origin；补两条测试：电话 origin 来自带 `/` 的链接、手表链接不带 `/`，以及反向组合。

### 3. 低：作者说“main 上服务器还没有 GET home / POST home/act”，与当前代码不符

文件:行：`packages/platform-node/src/device-api-routes.ts:82-83,1195,1225`、`apps/agent-service/src/production-http-composition.ts:1617`

问题：这不是运行时错误，而是 PR 说明与代码不一致。当前提交里服务器端入口和 `resolveAction` 都已存在；按这条说明去判断“客户端只是先按 Mac 形状写、服务器稍后接”会误判完成度。

证据（读代码证实）：

```ts
// device-api-routes.ts:82-83
{ method: "GET", path: "home", signed: true },
{ method: "POST", path: "home/act", signed: true },
// device-api-routes.ts:1195 / 1225
device.get("/home", ...)
device.post("/home/act", ...)
// production-http-composition.ts:1617
home: { resolveAction: (input) => home.resolveAction(input) },
```

建议：把 PR 说明改成“服务器入口已存在，本轮按同一形状接入并核对了字段”，或明确写“生产环境尚未部署/尚未开启”，不要写成 main 上还没有入口。

## 上一轮意见核对

- 意见 1（Mac 菜单栏发无绑定串动作）：**已修好 400 这一半**。`MenuBarFeed.swift:29` 过滤了 `binding == nil`；服务器 `device-api-routes.ts:1240-1241` 确实要求 `binding` 是字符串，因此过滤方向正确。新增测试在修复前会失败（旧行为会得到 `["重连","知道了"]`）。但留下上面第 1 条的空按钮卡片问题。
- 意见 3（README 说连不上时显示“暂时连不上”）：**已改好文档**。`README.md:170` 现在写“继续显示上一次成功读到的卡片；没有旧卡片可显示才写暂时连不上”；代码 `WatchModel.swift:273-289` 失败时只置 `homeFailed = true`、不清 `home`，`WatchViews.swift:123-127` 先显示 `card`，两者一致。没有自动测试守住“失败时保留 home”，后续改动可能悄悄让文档再次失真。

## 侧重检查

- **不可信输入（配对链接）**：`PairingInvitation.parse` 校验 scheme、版本、host、user/password、query、fragment、path 和 22 位 code；`offerable` 只做本地 origin 比较，不发送数据。发现第 2 条的尾斜杠归一化缺口。链接解码是线性的，没有发现新增的无界循环或资源耗尽路径。
- **未配对/已配对/手表不在线**：`AppModel.handlePairingLink` 在 active 时只在同源且 `watchRelay.canOffer` 时弹确认框；未配对时走 `pair(scanned:)`。本轮改动不改变这些分支；读取 `PhoneWatchRelay.swift:14-23` 确认 `canOffer` 要求 session activated、isPaired、isWatchAppInstalled。未发现新错误。
- **危险或不可撤销操作**：手表仍要求显式点按才 `POST home/act`；`ownerPresence` 动作在 `WatchCard` 里变成 `.handOff`，手表上不会直接执行；`acting` 有在途保护。本轮没有新增自动执行路径。Mac 的 `OwnerPresenceSigner` 来自合并的 main，不属本轮 PR 512 增量，未重读。
- **资源耗尽**：新增值没有进入服务器请求体；`shownActions` 是对最多几条动作的线性过滤；`offerable` 对任意打开 URL 做 base64+JSON 解析，和旧的 `link(in:)` 同等，未发现新增放大点。
- **安全边界**：`offerable` 只验证“同一 origin”，不验证配对码是否属于同一账号；这是既有设计（未配对手机配对也只看 origin），本轮没有加重，且仍需用户确认。未发现本轮新增越权路径。
- **规则/文档/代码一致**：README 的旧卡片说明已与代码一致；Mac“不画无绑定串按钮”已实现；作者关于服务器入口的说法不一致（第 3 条）。本改动不涉及 `prompt-prefix`、系统提示、工具定义或遮盖。

## 作者说法核对

- “逻辑在 `WatchGlance.swift`（17 条 Linux 测试）”：核对 `WatchGlanceTests.swift` 共 17 个 `@Test`（含本轮新增 `aLinkIsOfferedToTheWatchOnlyForTheServerThePhoneIsPairedTo`），数目一致。未运行 `swift test`，不核验“183 条通过”的运行时结果。
- “手表界面在 `Sources/HimawariWatchUI/`，仅 watchOS 编译”：5 个源文件都以 `#if os(watchOS)` 或 `#if os(watchOS) && DEBUG` 开头，一致。
- “入口 `App/Watch/`、小组件 `App/WatchWidgets/`、Xcode 工程手写加两个目标和嵌入”：本轮增量没有改这些文件；**未核实**（本轮没有重读 pbxproj 和小组件源码）。
- “iPhone 转交配对：`PhoneWatchRelay.swift`、`AppModel.handlePairingLink`、`RootView` 的 `.onOpenURL` 和确认框”：代码一致（`AppModel.swift:125-147`、`RootView.swift:47-57`、`PhoneWatchRelay.swift:14-23`）。
- “客户端按 Mac 菜单栏已在用的同一接口形状写”：一致。`MenuBarFeed.swift:89-97` 的 `home`/`watchHome` 都走 `GET home?locale=`；`WatchHome` 解码的 `items/source/incompleteSources/upcoming/revision` 与 `home-feed.ts:117-125,344-355` 对齐；`home/act` 的 `key/action/binding/requestId` 与 `device-api-routes.ts:1229-1241` 对齐。
- “main 上服务器还没有 `GET home` / `POST home/act`”：**不一致**，见第 3 条。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。PR 512 的本轮增量只改 Apple 客户端的配对提示、菜单栏动作过滤和静态设计令牌 CSS；没有改服务器系统提示、工具定义、历史消息或遮盖。手表“说一句”走新对话，只把用户文本/附件发给服务器，也不改写既有对话历史。合并 main 带入的 prompt-catalog 等改动属于其它 PR，本轮没有把它们当作 PR 512 的改动重审。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及。`offerable` 只做本地比较、不序列化；`shownActions` 只影响 UI 且保持服务器给的顺序；CSS 是静态生成。没有新增时间字段、前后文相关遮盖或无序集合进入请求。既有 `WatchReminderPlan` 先按 `(due, reminderId)` 排序再去重，`WatchCard.ordered` 用稳定的 offset 兜底，未发现新的不确定性。
3. **有没有自动检查，反向用例会不会真的失败？**
   - 第 1 条 Mac 过滤：有 `MacInputTests.swift:255-261`；修复前旧逻辑返回 `["重连","知道了"]`，会失败；但它没有覆盖“唯一动作就是无绑定串”的真实服务器形状。
   - 第 3 条 README：只有文档改动，没有测试；“失败时保留旧 home”这个行为本身也没有测试。
   - 新增 `offerable`：有反例（不同 origin、nil、非法链接），若实现退化成“只要已配对就 true”或接受非法链接会失败；但没有覆盖同一 origin 的尾斜杠/端口写法。
   - CSS：`check:apple-design`（`package.json:35`）会逐字节比较 `tokens.json` 生成结果与 `tokens.css`（`check-design.mjs:116-120`）；本次已重新生成，`tokens.json:143-150` 与新增 CSS 值一致。
4. **改动产生/修改的值，使用端都能接受吗？**
   - `WatchPairingRelay.offerable`：产生于 `WatchGlance.swift`，唯一运行时使用端是 `AppModel.handlePairingLink`；输入来自 `PairingInvitation.parse` 和 `PairingRecord.origin`（`AppModel.swift:219`）。两端对 origin 的写法没有统一归一化，见第 2 条；没有其它使用端。
   - `HomeItem.shownActions`：产生于 `MenuBarFeed.swift:29`，唯一运行时使用端是 `PanelView.swift:81-91`（测试另用）。服务器 `home/act` 拒绝非字符串 `binding`（`device-api-routes.ts:1240-1241`），所以过滤本身正确；但空列表的消费端没有兜底，见第 1 条。没有发现其它包使用该属性。
   - 新增 CSS 变量 `--type-watch-*`：产生于 `make-design-tokens.mjs` 对 `tokens.type` 的排序生成，消费于 `tokens.css`；`check-design.mjs` 校验最新性，未发现格式不被接受。Safari 面板目前不引用这些变量，但不会造成错误。
   - 本轮没有新增配置键、标识或服务器序列化格式。

## 本轮查过的范围

- 基线 `e3922d4d8` → `6669ec41d`。PR 512 自身增量是 `8e6c6b3ff`（Mac 过滤 + README）、`9349182c0`（`offerable` + 测试）、`6669ec41d`（重新生成 Safari CSS）；`8ff61e88d` 是合并 main，带入其它 PR 的改动不属本轮 PR 512 范围，未整份重读。
- 实际读过的关键文件：`WatchGlance.swift`、`WatchGlanceTests.swift`、`Pairing.swift`、`PairingRecord.swift`、`PairingTests.swift`、`DeviceAPIClient.swift`、`AppModel.swift`、`RootView.swift`、`PhoneWatchRelay.swift`、`MenuBarFeed.swift`、`PanelView.swift`、`MenuBarModel.swift`、`MacInputTests.swift`、`WatchModel.swift`、`WatchViews.swift`、`clients/apple/README.md`、`tokens.json`、`make-design-tokens.mjs`、`check-design.mjs`、`device-api-routes.ts`、`production-home.ts`、`home-feed.ts`、`production-http-composition.ts`、`prompt-prefix.md`。
- 为了核对两端校验，跟进了合并 main 后的服务器 `home`/`home/act` 和 `HomeFeed` 形状；没有重读整个 WatchUI、WatchWidgets 和 pbxproj。
- **未核实/未运行**：`swift test`、`xcodebuild`、`npm run check:apple-design`（本环境不能运行这些命令）；作者“183 条 Swift 测试通过”和 Xcode 目标/嵌入结构未验证。
