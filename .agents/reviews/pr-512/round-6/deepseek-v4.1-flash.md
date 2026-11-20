这一轮的检查范围包括：`e345851..145d964` 中属于 PR 512 的提交（`16a929ed7` 第 5 轮记录、`74af69066` 手表错误匹配、`b3eb2a677` 截图、`6be7bb1d0` / `145d964bb` 两次合并），以及合并后影响到 Apple 客户端、`Package.swift`、pbxproj 和服务端 `home` / `home/act` 的部分。其余大量提交来自 main 上的其他 PR，未逐份重读。

### 1. 低：第 5 轮“红点有件数但卡片消失”的意见这次并没有被修掉
文件:行：`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:37-39`、`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:59-60`、`clients/apple/Sources/HimawariMacUI/MenuBarController.swift:78,92-101`、`clients/apple/Sources/HimawariMacUI/PanelView.swift:20-22`。
问题：`mostPressing` 只看有绑定串的动作，而红点仍用服务器原始的 `awaitingCount`。当所有待办都没有绑定串动作时，`mostPressing` 为 nil，菜单栏面板不画卡片，但红点仍显示件数；Mac 面板里也没有别的入口能看到这件待办。
证据（亲自读到）：
```swift
// MenuBarFeed.swift:37-39
public var mostPressing: HomeItem? {
    items.first { $0.awaitsOwner && $0.sentence?.isEmpty == false && !$0.shownActions.isEmpty }
}
// MenuBarModel.swift:59-60
var awaitingCount: Int { home?.awaitingCount ?? 0 }
var mostPressing: HomeItem? { home?.mostPressing }
// MenuBarController.swift:78, 92-101
updateBadge(model.awaitingCount)
...
if count > 0 {
    button.attributedTitle = NSAttributedString(string: String(count), ...)
// PanelView.swift:20
if let item = model.mostPressing {
```
服务端的 `awaitingCount` 也确实包含这些条目：`packages/application/src/services/home-feed.ts:342` 写着 `const awaitingCount = awaiting.length + unread;`。
并且 `git diff e345851..HEAD -- clients/apple/Sources/HimawariMacUI clients/apple/Sources/HimawariCore/MenuBarFeed.swift` 没有任何输出；这一轮 PR 512 的代码提交只有 `WatchModel.swift` 一行和截图，没有红点/菜单栏相关修改。
建议：不要只靠“从 `mostPressing` 里过滤掉”来解决，应像手表的 `.handOff` 一样保留一张可见的卡片（显示句子并给“在 iPhone 上看”之类出口），或者让面板列出全部待办；若要改件数，必须同时满足“和 iPhone 红点定义相同”的约束。补一条“唯一待办没有绑定串时，红点与卡片一致”的测试。

### 2. 低：唯一代码改动没有自动检查，云端 CI 不会因退回 3 个关联值而失败
文件:行：`clients/apple/Sources/HimawariWatchUI/WatchModel.swift:311`、`clients/apple/Package.swift:21-24,46-50`。
问题：这次代码改动是把 `DeviceAPIError.server` 的模式从 3 个关联值改成 4 个，属于编译期修复；Linux 上的 `swift test` 根本不编译 `HimawariWatchUI`，所以没有自动检查能证明它被修好，反向改回 3 个关联值也不会在 CI 失败。
证据（亲自读到）：
```swift
// Package.swift:21-24
#if os(Linux)
let interfaceTargets: [Target] = []
let interfaceProducts: [Product] = []
let interfaceDependencies: [Package.Dependency] = []
#else
// Package.swift:46-50
    .target(
        name: "HimawariWatchUI",
        dependencies: ["HimawariCore", "HimawariDesign"],
        resources: [.process("Resources")]
    ),
```
`74af69066` 的提交说明也写着 `Layer-0-tests: none`。仓库里只有 `clients/apple/scripts/watch-ui-review.sh:39` 这种在 Mac 上 `xcodebuild ... -scheme HimawariWatch` 的手工构建；`b3eb2a677` 提交了 14 张手表截图，说明至少手工构建过一次，但这不进入云端检查。
建议：在 Mac 上把 `HimawariWatch` scheme 的构建接进质量门禁（哪怕是手动/定期任务），或者把能在 Linux 上测的逻辑继续下沉到 `HimawariCore`；这类模式匹配错误至少应有一条编译级检查兜住。

### 3. 低：作者说法与代码/提交不一致：`home` 端点已在 main，测试也不是 17 条
文件:行：`packages/platform-node/src/device-api-routes.ts:88-89,1372-1405`、`clients/apple/Tests/HimawariCoreTests/WatchGlanceTests.swift`。
问题：作者说“main 上服务器还没有 `GET home` / `POST home/act` 设备入口（另一线程在做）”，但对比基准 `9dd41fe` 的 `device-api-routes.ts` 的 `DEVICE_API_ROUTES` 里已经同时有 `{ method: "GET", path: "home", signed: true }` 和 `{ method: "POST", path: "home/act", signed: true }`，当前 HEAD 还完整实现了两个处理器（`:1372`、`:1402`）。另外作者说 `WatchGlance.swift` 有“17 条 Linux 测试”，当前 `WatchGlanceTests.swift` 实际有 18 个 `@Test`。
证据（亲自读到）：HEAD 的 `DEVICE_API_ROUTES`：
```ts
{ method: "GET", path: "home", signed: true },
{ method: "POST", path: "home/act", signed: true },
```
`git show 9dd41fe:packages/platform-node/src/device-api-routes.ts` 同样包含这两行；引入提交是 `8b9c64225 feat(devices): 设备接口加首页读取和点动作，动作带绑定串`。测试文件有 18 个 `@Test func`（含第 4 轮新增的 `theSameServerWrittenTwoWaysIsStillTheSameServer`）。
建议：更新 PR 描述/README，把“main 没有 home 端点”改为“已在 main（#475）”并引用实际接口；顺手把测试条数改对。这不影响行为，但会让复核者误以为客户端在对接不存在的接口。

**读代码证实的**：上面三条都由当前代码或 `git show` 直接确认。
**推测/未核实**：`b3eb2a677` 的截图来自 `74af69066` 那次 `xcodebuild` 成功构建，这是从截图提交和脚本推断的，构建日志未核实；作者是否在别的分支/提交修了红点但尚未合入本分支，也未核实——本分支 HEAD 里看不到对应修改。

**侧重检查**

- 错误路径：手表的 `decide` 在 4xx 时清掉 `requestIds[identity]`，在 5xx/网络错误时保留以便用同一 requestId 重放；服务端 `home/act` 有 10 分钟、上限 256 的请求编号重放缓存（`device-api-routes.ts:1419-1438`）。没有发现新问题。
- 不可信输入：`WatchHome` 对 `upcoming` 用宽松解码、`revision`/`awaitingCount` 严格解码；配对链接用归一化后的 scheme/host/port 比较（`WatchGlance.swift:247-256`）；`locale` 只允许 `zh-CN/en/ja`。没有发现新问题。
- 安全 / 要本人在场：`WatchCard.init` 只要动作里有 `ownerPresence` 就变成 `.handOff`，`WatchViews.swift:191-199` 只有 `.decide` 才会调用 `model.decide`；手表不会绕开确认签名。没有发现新问题。
- 不可逆操作：手表一键只提交 `ownerPresence == false` 的动作，和现有 Mac/服务端策略一致；没有新增不可逆路径。
- 资源耗尽：客户端 `requestIds` 按「条目+动作+绑定」存，条目数有上限；服务端重放缓存有上限。未发现新增的无限增长。
- 规则/文档一致性：模型请求前缀规则不涉及本 PR 的手表代码；但作者对服务器端点、测试条数、是否编译过的描述与当前仓库不一致（见意见 3）。

**必答问题**

1. **不涉及。** 这次 PR 512 的增量没有组装或修改发给模型的内容；`WatchModel` 只调设备 HTTP 接口（`home`、`home/act`、线程消息等），系统提示、工具定义、历史、遮盖都由服务端既有逻辑决定，本次改动不会改变它们。合并进来的 main 侧 `packages/prompt-catalog` 改动属于其他 PR，本轮未重读（未核实），但不在 PR 512 的代码改动里。
2. **不涉及模型请求字节。** 手表 `home/act` 的 `requestId` 是随机 base64url，每次新建不同，但它是动作幂等键，不是模型输入；重试时会保留同一个 `requestId`，同一动作重发的字节是确定的。没有发现会让同一段模型输入变成不同字节的改动。
3. **没有对应的自动检查。** 见意见 2：Linux `swift test` 不编译 `HimawariWatchUI`，把 4 个关联值改回 3 个，云端 CI 不会失败；红点问题也没有测试断言 badge 与卡片一致（`anItemWhoseOnlyActionHasNoBindingIsNotTheMostPressingCard` 只断言 `mostPressing`），反向用例同样不会失败。唯一的手工验证是 Mac 上的 `watch-ui-review.sh` 构建。
4. **逐个核对结果：**
   - `DeviceAPIError.server` 的定义是 4 个关联值（`clients/apple/Sources/HimawariCore/DeviceAPIClient.swift:21`：`case server(status:code:pairingCodeTtlSeconds:reason:)`）；`WatchModel.swift:311` 的 4 值模式与之一致。用 grep 找到的其余使用处（`Handover.swift`、`MessageSensing.swift`、`Outbox.swift`、`DeviceActionAPI.swift`、`MenuBarModel.swift`、`PairingDecisions.swift` 等）都已经是 4 个值，没有发现遗漏的 3 值匹配。
   - `GET home?locale=`：客户端 `locale` 来自 `AnswerLocale`（`zh-CN`/`en`/`ja`，`Models.swift:168-181`），服务端 `HOME_LOCALES` 也是这三个（`packages/gateway-contracts/src/contracts-v2.ts:882`），两端都接受。
   - `POST home/act`：客户端 body 是 `key/action/binding/requestId`（`MenuBarFeed.swift:113-120`）；服务端只接受这四个键，且要求 `binding` 是 string（`device-api-routes.ts:1405-1418`）；手表/ Mac 的按钮只对 `binding != nil` 的动作生成（`WatchGlance.swift:150`、`MenuBarFeed.swift:29`），不会发 null。`requestId` 是 `"act_" + base64url`，首字符字母、只含 `A-Za-z0-9._:-`，能通过 `MACHINE_STRING`。
   - `home` 响应：服务端返回 `items/awaitingCount/awaitingTruncated/incompleteSources/upcoming/revision/generatedAt`（`production-home.ts:888-893`），客户端 `WatchHome` 解码其中的 `items/awaitingCount/incompleteSources/upcoming/revision`（`WatchGlance.swift:75-108`）；`upcoming` 的 `reminderId/text/dueAt` 与服务端 `production-memory-control.ts:636-639` 一致。
   - 唯一对不上的是 Mac 的“红点件数”和“有没有卡片”这两端，见意见 1；它不在这次增量修改的代码行里，但确实是上一轮遗留、当前 HEAD 仍存在的问题。
