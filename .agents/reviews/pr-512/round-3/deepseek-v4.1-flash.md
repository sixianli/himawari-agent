## 本轮范围
本轮只对照了 `git diff 7d4fb9017f11785e536c731ec4a4933accadc018..e3922d4d84c4f1fffc6c064645a9d334acd7b12a` 的增量（README、`MenuBarFeed.swift`、`WatchGlance.swift`、`MenuBarModel.swift`、`WatchModel.swift`、`AppModel.swift`、`WatchGlanceTests.swift`），并顺着新值追到服务端校验和 Mac 端使用处。未运行 `swift test`、未编译 Mac/watchOS 界面、未上真机（工具只允许 git 只读命令）。

## 上轮意见核对
- 上轮 1（origin 未校验）：代码已加 `invitation.origin == record?.origin`，watch 侧确实改好；但没有对应自动测试，见下面第 2 条。
- 上轮 2（请求号可能以 `-`/`_` 开头）：已改为 `"act_" + OutgoingMessage.newId()`，前缀保证首字符是字母；服务端实际用的是 `MACHINE_STRING = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u`，26 字符的生成值能过，已改好。
- 上轮 3（`reconnect` 无绑定串仍显示按钮）：`WatchCard` 已先 `filter { $0.binding != nil }`，watch 侧已改好；但 Mac 端同样的值仍会显示并发送，见第 1 条。
- 上轮 5（README/作者说法不一致）：README 两条主要描述基本对上，但“入口连不上时显示暂时连不上”仍不总成立，见第 3 条；作者说法另有两处不实，见第 4、5 条。

### 1. 中低：Mac 菜单栏仍会把没有绑定串的 reconnect 动作发给服务器，点一次必然 400
文件: `clients/apple/Sources/HimawariCore/MenuBarFeed.swift:29`、`clients/apple/Sources/HimawariMacUI/PanelView.swift:81`、`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:120`、`apps/agent-service/src/production-home.ts:151,327`、`packages/platform-node/src/device-api-routes.ts:1003`

问题：本轮只让 watch 过滤了 `binding == nil` 的动作。Mac 的 `shownActions` 仍是 `Array(actions.prefix(Self.shownActionLimit))`，`PanelView` 直接把它画成按钮；服务端的 connection 项给 `reconnect` 时确实没有绑定串。

证据（读代码证实）：
- `MenuBarFeed.swift:29`：`public var shownActions: [HomeAction] { Array(actions.prefix(Self.shownActionLimit)) }`
- `production-home.ts:327`：`actions: [action(locale, "reconnect", "positive")]`，而 `production-home.ts:151` 是 `binding: options.command ? encodeHomeBinding(options.command) : null`
- `device-api-routes.ts:1014-1015`：`if (typeof binding !== "string") throw new DeviceGatewayError(DEVICE_GATEWAY_ERROR_CODES.HOME_ACTION_INVALID, 400);`
- Mac 发送时 `binding` 为 nil 会缺失或为 null（Swift 合成的 Encodable 省略 nil），两种都会被上面判成非 string，返回 400。

这是旧路径，不是本轮增量引入，但本轮新增的 `newActionRequestId` 与 watch 的过滤只覆盖了 watch，Mac 这个同一值的直接使用端仍不能接受。建议：把“可执行动作”的过滤上移到 `HomeItem.shownActions`（或 Mac 的 `respond` 前），与 watch 共用同一判定；服务端也可对无绑定动作不生成按钮语义。

### 2. 中低：origin 安全校验修好了，但没有任何自动检查，删掉这个条件不会有测试失败
文件: `clients/apple/Sources/HimawariShell/AppModel.swift:124`、`clients/apple/Tests/HimawariCoreTests/WatchGlanceTests.swift:147`

问题：本轮唯一的安全修复所在行没有覆盖测试。现有 watch 测试只测 `WatchPairingRelay.link` 能否解析，不测“链接 origin 与已配对 origin 不同就不转交”。

证据（读代码证实）：
- `AppModel.swift:124`：`if let invitation = try? PairingInvitation.parse(text), invitation.origin == record?.origin, watchRelay.canOffer { watchOffer = text }`
- `WatchGlanceTests.swift:147-151` 的 `onlyAValidPairingLinkIsTakenFromTheIPhone` 只断言合法/非法链接解析，没有 AppModel 的 origin 比较。
- 在 `clients/apple/Tests` 里 grep `handlePairingLink`、`watchOffer`、`origin`，没有找到覆盖这个分支的测试。

建议：把“是否同一服务器”抽成 HimawariCore 的纯函数（例如 `PairingInvitation.isSameServer(as origin: URL)`），加一条“不同 origin 不得转交”的负例；这样 Linux 上的 `swift test` 也能跑到。当前 Linux 不构建 `HimawariShell`，直接测 AppModel 不现实。

### 3. 低：README 说“入口连不上时显示暂时连不上”，但有旧卡片时会继续显示旧卡片
文件: `clients/apple/README.md:138`、`clients/apple/Sources/HimawariWatchUI/WatchModel.swift:273,292`、`clients/apple/Sources/HimawariWatchUI/WatchViews.swift:123`

问题：刷新失败只置 `homeFailed = true`，没有清掉 `home`；`card` 从旧 `home` 计算，所以只要上一次成功刷新留下过卡片，网络断掉后首页仍显示旧卡片，而不是 README 说的“暂时连不上”。

证据（读代码证实）：
- `WatchModel.swift:287-288`：`} catch { homeFailed = true }`，没有 `home = nil`
- `WatchModel.swift:292-295`：`guard let home else { return nil } ... live.first { ... }`
- `WatchViews.swift:123-127`：`if let card = model.card { CardView(...) } else { QuietView(failed: model.homeFailed, ...) }`

建议：要么在首页渲染时让 `homeFailed` 优先于旧卡片，要么在 README 中改成“没有可显示的旧卡片时显示‘暂时连不上’”。我倾向保留旧卡片作为降级显示，但把文档改准确。

### 4. 低：作者说“17 条 Linux 测试”，`WatchGlanceTests` 实际是 16 条
文件: `clients/apple/Tests/HimawariCoreTests/WatchGlanceTests.swift`

问题：作者说法与代码不一致，实际 `@Test` 数量是 16，不是 17。

证据（读代码证实）：`@Test` 出现在第 24、35、46、56、63、70、79、91、103、109、132、140、147、154、176、185 行，共 16 条。本轮新增了其中第 56、63 两条，仍不是 17。

建议：把作者说明改成 16，或补上缺失的那条测试。

### 5. 低：作者说“main 上服务器还没有 GET home / POST home/act”，但对比基准已经包含这两个入口
文件: `packages/platform-node/src/device-api-routes.ts:969,999`、`test/integration/device-home.test.ts:182`

问题：作者的说法与本次对比范围不符。`git diff 9dd41fe..e3922d4 --stat` 完全没有列出 `device-api-routes.ts` 或 `device-home.test.ts`；`git log 9dd41fe -- packages/platform-node/src/device-api-routes.ts` 能看到更早的 `8b9c64225 feat(devices): 设备接口加首页读取和点动作，动作带绑定串`，说明基准提交里已经有这两个入口。

证据（读代码证实）：
- 当前文件 `device-api-routes.ts:969`：`device.get("/home", ...)`；`:999`：`device.post("/home/act", ...)`
- 上述路由不在 `9dd41fe..e3922d4` 的 diff 统计里，且基准的 git log 已包含引入它们的提交。

建议：把 PR 说明改成“服务器端入口已在 main，客户端按同一接口形状接入”，不要再说 main 还没有。

## 侧重检查
- 错误路径：查了 `AppModel.handlePairingLink` 的 active/非 active/解析失败分支；`WatchModel.decide` 的 4xx 清请求号、5xx 保留请求号；`WatchModel.refresh` 的 revoked 与普通失败分支。普通失败留下旧卡片是第 3 条。
- 不合规范/不可信输入：`PairingInvitation.parse` 已限 scheme、host、user/password、query、fragment、path；`newActionRequestId` 对服务端 `MACHINE_STRING` 通过；服务端对 `binding` 做了 string 校验，但 Mac 端仍会把 nil 送进去，见第 1 条。
- 安全：origin 相等校验能阻止跨服务器转交（已改好）；watch 对 `ownerPresence` 动作仍走 handOff，没有借过滤绕过“本人在场”；服务端 `resolveAction` 还校验 `key/action/binding` 对应关系和绑定串是否过期。
- 资源耗尽：新增的只有 500 次随机生成测试；`requestIds` 字典长期增长、通知 64 条上限都是旧行为，本轮未改。
- 不可撤销操作：watch 只展示并发送有绑定串的动作；服务端会拒绝过期/错配绑定，未发现新增的不可撤销入口。
- 文档/规则一致性：README 第 138 行仍有一处与代码不一致（第 3 条）；作者说法有两处不实（第 4、5 条）。

## 必答问题
1. **不会改变模型已见过的请求开头。** 本轮增量没有碰系统提示、工具定义、历史消息或遮盖逻辑；`newActionRequestId()` 只进入 `POST home/act` 的请求体，不是模型上下文。watch 的“说一句”仍走原有的新线程路径，本轮未改。结论：不涉及。
2. **不会让模型看到的同一段文字变成不同字节。** 新请求号是随机生成的，但它是动作幂等号，不进入模型提示；`WatchCard` 过滤后仍用 `ordered` 按（极性排名, 原顺序）稳定排序，没有遍历无序集合。结论：与模型请求字节稳定性不涉及。
3. **有检查，但不完整。** `anActionTheServerGaveNoBindingForIsNeverAWristButton` 的负例是真的会失败：删掉 filter 后该用例会从 `.handOff` 变成 `.decide`。`aGeneratedActionRequestIdAlwaysPassesTheServerPattern` 对“删掉 act_ 前缀”的回归有约 `1-(62/64)^500` 的捕获率，接近必然但不是确定性。origin 修复没有任何测试，反向删掉 `origin == record?.origin` 不会失败，见第 2 条。
4. **逐个使用端核对：** `DeviceAPI.newActionRequestId()` 的两个直接调用端（`MenuBarModel.swift:125`、`WatchModel.swift:302`）都发送到同一个 `POST home/act`，服务端校验是 `MACHINE_STRING`，生成值首字符为 `a`、长度 26、字符集为 base64url，能通过；watch 的 `WatchCard.choice` 只被 `WatchViews` 消费，`decide` 只把过滤后的 `<HomeAction>` 传给 `act`，两端接受。唯一不能接受的是 Mac 的 `shownActions` 仍把 `binding == nil` 的 reconnect 动作交给 `respond`，见第 1 条。`watchOffer` 的使用端是 `RootView` 的确认框和 `sendOfferToWatch`，新 origin 条件只会减少误转交，使用端无格式要求。
