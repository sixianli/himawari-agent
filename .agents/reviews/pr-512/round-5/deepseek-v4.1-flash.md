本轮查过的范围：`6669ec41..e345851` 的增量只涉及 `clients/apple/Sources/HimawariCore/MenuBarFeed.swift`、`WatchGlance.swift`、`Tests/HimawariCoreTests/MacInputTests.swift`、`WatchGlanceTests.swift` 四个代码/测试文件（其余是复核记录）。我对照了上一轮两条意见、`mostPressing`/`sameServer` 的全部直接使用端、`WatchGlanceTests` 的现有用例、README 相关说明，以及当前检出里已经存在的服务器 `home`/`home/act` 入口和返回形状。测试没有运行（本轮只能用 git/read/grep），下面凡是“测试会红/会绿”都是按代码推断。

上一轮意见核对：

- 第 1 条已改好：`mostPressing` 现在要求 `!$0.shownActions.isEmpty`，`shownActions` 只保留 `binding != nil` 的动作，因此只有无绑定串动作的条目不会再作为菜单栏卡片出现，也不会再挡住后面的待办。
- 第 2 条功能上已改好：`offerable` 改走 `sameServer`，按 scheme/host/port 归一化比较，尾斜杠、大小写、显式默认端口都不再判成不同服务器。测试接线还有一个缺口，见下面第 2 条意见。

**侧重检查**

- 不可信输入：配对链接仍先经 `PairingInvitation.parse`，它强制 `https`、非空 host、无 user/password/query/fragment、path 为空或 `/`、code 匹配固定模式（`Pairing.swift:76-86`）；`sameServer` 只读取 `scheme`/`host`/`port`，没有强制解包，也没有新增崩溃路径。结论：没有发现新的输入校验问题。
- 错误路径：`offerable` 在 `pairedOrigin` 为 nil 或链接解析失败时仍返回 `false`（`WatchGlance.swift:249`），行为不变。
- 资源耗尽：`sameServer` 每次只拼两个短字符串，无循环、无外部资源；不新增风险。
- 不可撤销操作：增量没有新增这类操作；配对转交的入口仍只由 iPhone 的 `handlePairingLink` 控制。
- 规则/文档一致性：README 只写“Mac 菜单栏同样不为没有绑定串的动作画按钮”（`clients/apple/README.md:170`），没写整张卡片会消失；这和第 1 条意见有关。
- 服务器端：当前检出已经有 `GET /api/device/v1/home` 和 `POST /api/device/v1/home/act`（`packages/platform-node/src/device-api-routes.ts:1195,1225`），返回字段与客户端的 `HomeSnapshot`/`WatchHome` 解码器相容；`home/act` 要求 `binding` 必须是字符串（同文件 1240-1241），而两个客户端调用端都只传已过滤的绑定动作（`PanelView.swift:81-83`、`WatchGlance.swift:150`、`WatchModel.swift:306`），所以本轮修复反而堵住了唯一可能发送 `binding: null` 的入口。

### 1. 低：只剩“没有绑定串动作”的待办时，菜单栏卡片消失但红点仍显示有件数，这件待办在 Mac 上不可见也没有出口

- 文件:行：`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:37-39`、`clients/apple/Sources/HimawariMacUI/PanelView.swift:20-22`、`clients/apple/Sources/HimawariMacUI/MenuBarController.swift:78`
- 问题：修复选择了“整张卡跳过”，而不是“卡片保留但只显示句子/提示去 iPhone”。如果服务器只返回这类待办（README:170 明确说会有“需要重新连接的账号”这种只有无绑定串动作的情况），Mac 面板里没有任何待办卡，状态栏红点却仍按 `awaitingCount` 显示件数；这件待办在 Mac 上既看不到句子，也没有任何出口。手表对同一情况是显示“在 iPhone 上看”的 handoff，Mac 没有对应处理。
- 证据（读代码证实）：
  - `MenuBarFeed.swift:38`：`items.first { $0.awaitsOwner && $0.sentence?.isEmpty == false && !$0.shownActions.isEmpty }`
  - `MenuBarFeed.swift:29`：`shownActions` 只保留 `binding != nil` 的动作
  - `PanelView.swift:20`：`if let item = model.mostPressing { card { awaiting(item) } }`
  - `PanelView.swift:81`：`if !item.shownActions.isEmpty { ... }`（没有可点动作时本来就不画按钮）
  - `MenuBarController.swift:78`：`updateBadge(model.awaitingCount)`
  - `WatchGlance.swift:150-155`：`if shown.isEmpty || shown.contains(where: \.ownerPresence) { choice = .handOff }`
  - `WatchViews.swift:199-206`：`.handOff` 分支显示 `onIPhone` 按钮
- 推测：如果产品意图就是“这种事项只在 iPhone 上处理、Mac 完全不提示”，现状可以接受；但 README 只承诺“不画按钮”，没有说“卡片消失”，红点与空面板也不一致。建议二选一：保留句子并加一个非按钮的“在 iPhone 上看”提示，或让红点只统计可在这台设备上处理的件数/在面板里给空状态说明；并补一条“唯一待办只有无绑定串动作”的测试锁定期望。

### 2. 低：服务器归一化只测了内部 `sameServer`，没有测 `offerable` 的接线，改回直接比较也不会红

- 文件:行：`clients/apple/Tests/HimawariCoreTests/WatchGlanceTests.swift:163-171`、`clients/apple/Sources/HimawariCore/WatchGlance.swift:248-251`、现有用例 `WatchGlanceTests.swift:154-161`
- 问题：上一轮的问题是公开行为 `offerable` 用 `invitation.origin == pairedOrigin` 比较；这次新测试直接调用新内部函数 `sameServer`。如果有人把 `offerable` 改回直接比较（或漏掉对 `sameServer` 的调用），所有测试仍会通过，因为现有的 `offerable` 用例是从同一条链接里解析出 `origin` 再传回去，两条 URL 本来就相等。也就是说，这个测试不是针对“公开行为”的红转绿用例。
- 证据（读代码证实）：
  - `WatchGlance.swift:250`：`return sameServer(invitation.origin, pairedOrigin)`
  - `WatchGlanceTests.swift:167-171`：只断言 `WatchPairingRelay.sameServer(...)`
  - `WatchGlanceTests.swift:156-157`：`let origin = try PairingInvitation.parse(link).origin`，然后 `offerable(link, pairedOrigin: origin)`——没有尾斜杠、大小写或默认端口差异
- 建议：把反例放回 `offerable`：例如链接 origin 为 `https://himawari.example.test`，`pairedOrigin` 为 `https://HIMAWARI.EXAMPLE.TEST:443/` 时必须为真；`https://himawari.example.test:8443/` 时必须为假。这样才会在旧实现上失败，并锁住接线；现有 `sameServer` 测试可以保留。

**必答问题**

1. 不涉及。增量只改 Apple 客户端的菜单栏条目选择和配对链接判断，没有碰系统提示、工具定义、历史消息、遮盖或任何模型请求组装；因此不存在“请求开头变化”或“会变的值不在最后一条消息”的问题（对照 `prompt-prefix.md` 第 4、10 条）。
2. 不涉及。`sameServer` 是对两个 `URL` 的纯函数，只返回 `Bool`，不依赖前后文、时间或集合遍历顺序；增量没有新的序列化格式或覆盖层。
3. 部分覆盖。第 1 条意见有对应的新测试，按旧谓词（无 `shownActions` 条件）推断第一条无绑定串条目会被选中，断言 `approval:2` 会失败；第 2 条意见的测试只覆盖 `sameServer`，没有覆盖 `offerable` 的真实调用路径，接线回退不会红；第 1 条意见里的“唯一待办无绑定串”也没有测试。测试本身未运行，只做了代码级核对。
4. 逐个核对过：`mostPressing` 仍是 `HomeItem?`，使用端 `MenuBarModel.swift:60` 原样转发，`PanelView.swift:20-22` 接受可选值；`sameServer` 是 internal `(URL, URL) -> Bool`，只有 `offerable`（`WatchGlance.swift:250`）和测试使用，两端签名一致；没有新增标识、配置键、清单项或序列化字段。服务器端 `home.read` 返回的 `key/kind/awaitsOwner/sentence/source/deadline/actions/awaitingCount/incompleteSources/upcoming/revision` 与客户端解码器相容，`home/act` 的 `binding: string` 校验也与客户端只传绑定动作一致。未发现生产端与使用端的校验不一致。

**作者说法核对**

- “17 条 Linux 测试”与当前检出不符：`WatchGlanceTests.swift` 现在有 18 个 `@Test`（本轮新增了 `theSameServerWrittenTwoWaysIsStillTheSameServer`）；如果作者指的是本轮修改前，17 条是准确的，但描述已过期。
- “main 上服务器还没有 `GET home` / `POST home/act` 设备入口（另一线程在做）”与当前检出不符：`packages/platform-node/src/device-api-routes.ts:1195,1225` 已经有这两个路由，`apps/agent-service/src/production-home.ts:865-894` 已有返回形状，`test/integration/device-home.test.ts` 也已有覆盖。`git log 9dd41fe..e345851 -- packages/platform-node/src/device-api-routes.ts` 中没有新增这两个路由的提交 `8b9c64225`，说明它不是本轮增量带进来的，基准版本里就已经存在。可能是描述写完后另一线程合入了 main，但这句话需要更新。
- 手表界面、`HimawariWatchUI`、小组件、`App/Himawari.xcodeproj/project.pbxproj` 不在本轮增量内，未重新核实；前几轮已覆盖的部分本轮未整份重读。
