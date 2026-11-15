本轮检查范围：先看了 `9dd41fe..c63d33b8` 的总改动和 `126c5fb..c63d33b8` 的增量；手表相关增量只有 `WatchDemo.swift` 一行 import、`WatchGlanceViews.swift` 一行样式和重生成的截图。随后对照读了 `WatchGlance.swift`、`WatchModel.swift`、`WatchViews.swift`、`WatchGlanceViews.swift`、`WatchGlanceTests.swift`、`PhoneWatchRelay.swift`、`AppModel.swift`、`RootView.swift`、服务端 `home-feed.ts`、`contracts-v2.ts`、`device-api-routes.ts`、`Package.swift`、README 和本地化文件。未运行 `swift test`、`check:prompt-prefix` 或其他命令（本轮只能用只读工具和上述 git 命令）。合并进来的 main 改动只抽查了与新增配置键、能力名对应的使用端，没有整份重读。

作者说法核对：作者说“main 上服务器还没有 `GET home` / `POST home/act` 设备入口”，与 c63d 代码不符（见意见 3）；作者说 `WatchGlance.swift` 有“17 条 Linux 测试”，实际文件里有 18 个 `@Test`（`WatchGlanceTests.swift:24` 到 `:205`）。其余“手表上不打字、由 iPhone 转交配对链接、按钮和句子来自服务器”的说法与代码一致。

### 1. 中：第 7 轮“红点有件数但卡片消失”仍未修好，件数和卡片仍来自两套数据

文件:行
`clients/apple/Sources/HimawariCore/WatchGlance.swift:110-120`、`:183-185`；`clients/apple/Sources/HimawariWatchUI/WatchModel.swift:283-285`、`:294-298`、`:308-310`；`clients/apple/Sources/HimawariWatchUI/WatchViews.swift:123-127`、`:153`；`clients/apple/Tests/HimawariCoreTests/WatchGlanceTests.swift:70-77`、`:79-89`。

问题
本轮增量没有改 `WatchModel`、`WatchGlance` 或相关测试，所谓“已修改”在增量里没有对应代码。现在仍然有三套状态：主屏卡片用 `home.items` 并扣掉本地 `settled`；主屏“没有要你定的事/去 iPhone 看”的判断用未扣 `settled` 的 `home.items`；表盘件数和最近一句直接用 `home.awaitingCount` / `home.pressing`。三者在服务器计数大于返回条目、或主人刚点过一件时会对不上。

证据（读代码证实）
- 卡片扣掉本地已处理项：`let live = home.items.filter { !settled.contains($0.key) }`，`return live.first { $0.awaitsOwner && $0.sentence != nil }...`（`WatchModel.swift:296-297`）。
- 但“等待但无卡”的判断没有扣：`pressing == nil && items.contains(where: \.awaitsOwner)`（`WatchGlance.swift:114-116`）。主屏在无卡时按这个值决定显示“在 iPhone 上打开”还是“没有要你定的事”：
  `Text(L.text(failed ? "offline" : waiting ? "onIPhone.hint" : "quiet"))`（`WatchViews.swift:153`）。
- 主人点按成功后立即 `settled.insert(card.key)`（`WatchModel.swift:310`），随后才 `refresh()`；在这段网络往返里，卡片已被过滤掉，但 `awaitsOwnerWithoutCard` 仍看到旧 `home` 里的 `awaitsOwner` 项而为 false，于是主屏会写“没有要你定的事”，而表盘仍保存 `awaitingCount` 和旧句子：`complication.save(WatchComplicationState(home: next, at: Date()))`（`WatchModel.swift:284`），`awaiting: home.countedAwaiting, latest: home.pressing?.sentence`（`WatchGlance.swift:184`）。
- 服务器计数本来就可能大于返回条目：`const awaitingCount = awaiting.length + unread`（`home-feed.ts:342`），且 `awaitingTruncated` 单独存在（`contracts-v2.ts:1011-1013`）。如果只有 unread 没有可展示条目，`items` 可以为空，但 `countedAwaiting` 大于 0；此时主屏走 `quiet`，表盘却显示“N 件事等你定”。
- 现有测试只覆盖“有 `awaitingCount` 但无卡片”这一半，并且把不一致写成了预期：`#expect(home.pressing == nil)`、`#expect(home.countedAwaiting == 2)`（`WatchGlanceTests.swift:75-76`）；没有覆盖 `settled` 后主屏与表盘一致，也没有覆盖 `items == [] && awaitingCount > 0`。

性质：读代码证实；未在真机/模拟器上复现。

建议
在 `HimawariCore` 里做一份统一的“当前有效首页”派生值，例如同时给出 `liveItems`、`livePressing`、`awaitingCount`、`hasWaiting`，让主屏卡片、主屏提示和表盘状态都从它取值；按规则件数仍取服务器的 `countedAwaiting`（`incompleteSources` 非空时不显示），但当 `count > 0` 而拿不到可展示卡片时，主屏应显示“在 iPhone 上打开/接着看”，不能显示“没有要你定的事”；表盘的 `latest` 至少应来自扣掉 `settled` 的 `livePressing`，或干脆在无卡片时只显示件数。补两条反向测试：`items == [] && awaitingCount > 0` 时不得返回 `nothingWaiting`；点按产生 `settled` 后主屏与表盘不得一空一有。

### 2. 低：中文离线文案已改成“现在连不上”，README 仍写“暂时连不上”

文件:行
`clients/apple/README.md:170`；`clients/apple/Sources/HimawariWatchUI/Resources/zh-Hans.lproj/Localizable.strings:13`。

问题
上一轮指出的说明文档与代码不一致仍在。本轮增量没有改 README，也没有改这个文案。

证据（读代码证实）
README 第 170 行仍写：“没有旧卡片可显示才写‘暂时连不上’”。实际中文文案是：
`"offline" = "现在连不上";`。英文和日文也是“现在”的语义：`"offline" = "Can't connect right now";`、`"offline" = "今はつながりません";`。代码里离线状态确实显示这个键：`Text(L.text(failed ? "offline" : ...))`（`WatchViews.swift:153`）。

性质：读代码证实。

建议
统一成一种说法；如果选择代码的“现在连不上”，把 README 第 170 行改掉即可。README 是规则/界面文案的说明文件，建议顺手在文档检查里加一条手表文案键值或至少让 review 清单覆盖 README 与 `Localizable.strings` 的对照。

### 3. 低：作者说服务器还没有 home 设备入口，实际 c63d 已有，且本轮增量没有新增它

文件:行
`packages/platform-node/src/device-api-routes.ts:89-90`、`:1394`、`:1424`；`packages/gateway-contracts/src/contracts-v2.ts:966-1027`。

问题
作者在 PR 说明里写“main 上服务器还没有 `GET home` / `POST home/act` 设备入口（另一线程在做），客户端按 Mac 菜单栏已在用的同一接口形状写”。这句在本次复核的提交上不成立，会让复核者误以为无法做端到端核对。

证据（读代码证实）
路由表已有：
`{ method: "GET", path: "home", signed: true }`、`{ method: "POST", path: "home/act", signed: true }`。实现也在：
`device.get("/home", ...)` 校验 `locale` 后走 `home.read`；`device.post("/home/act", ...)` 校验 `key/action/binding/requestId` 后调用 `options.home.resolveAction`。`git blame` 显示这两段来自 `8b9c642259`（2026-11-14）；本轮 `126c..c63d` 的 `device-api-routes.ts` 只新增了 `actions/undo`，说明这两个入口在 126c 时已经存在。

性质：读代码证实；只核对了接口形状，没有跑服务端集成测试。

建议
更新 PR 说明。顺带说明：我按 Q4 对照了两端——客户端 `GET home?locale=` 的 `zh-CN/en/ja` 与服务端 `HOME_LOCALES` 一致，`WatchHome` 需要的 `items/awaitingCount/incompleteSources/upcoming/revision` 在 `home.snapshot` 契约里都有，`WatchUpcoming` 的 `dueAt` 也是服务端校验过的 timestamp；`POST home/act` 需要的四个字段和 `MACHINE_STRING` 也与客户端测试一致。也就是说，形状可接受，但服务端允许 `awaitingCount > items`，正好触发意见 1。

## 侧重检查

- 错误路径：`WatchModel.refresh` 在普通错误时置 `homeFailed = true`，主屏在 `model.card == nil` 时才显示离线；已有旧卡片时仍显示旧卡片，符合 README。`forget` 会清空 keychain、`home`、`settled`、`complication` 并通知小组件重画；`isRevoked` 走 `forget(.removed)`。未发现本轮新增错误路径；但“有计数无卡片”正是错误/截断路径上的用户可见矛盾（意见 1）。
- 不可信输入：`WatchHome` 对 `items`、`awaitingCount`、`revision` 严格解码，整份坏数据会让 `refresh` 失败并保留旧卡片；`upcoming` 用 `Lenient` 逐条跳过坏项；`sentence/detail` 会 trim 空白。`WatchPairingRelay.link` 只接受 `PairingInvitation.parse` 能解析的字符串，`offerable` 还要求与手机已配对的 origin 相同；本轮没有改这些路径，未发现新问题。
- 安全/不可撤销操作：手表动作在 `WatchCard` 里过滤掉没有绑定串的动作；有 `ownerPresence` 的动作改为 handOff；`decide` 对同一 `key+action+binding` 在成功或 4xx 前复用同一 `requestId`，服务端 `home/act` 也有按设备+requestId 的重放缓存。服务端新增的 `actions/undo` 只把签名里的 `authenticated.confirmed` 当 `ownerPresent`，而 `undo` 在没有 `ownerPresent` 时返回 `owner_presence_required`；这一点与本轮提交里的反向用例方向一致。未发现可以绕过“本人在场”的手表路径。
- 资源耗尽：提醒按 `systemPendingLimit = 64` 截断并按 `reminderId` 去重，每次重排前删掉带前缀的旧通知；`settled` 每轮与服务器条目求交；`requestIds` 以条目为上限。未发现本轮新增的无界增长。`WatchTextFit.fits` 对整段回答逐字符扫描，回复长度依赖服务端上限，本轮未改。
- 规则文件/说明文档一致性：发现 README 的离线文案与本地化不一致（意见 2）；README 说“件数定义和 iPhone 红点相同”，代码确实用 `countedAwaiting`（`incompleteSources` 非空时隐藏），这一点一致；不一致的是“有件数时主屏却写没有要你定的事”（意见 1）。

## 必答问题

1. 不涉及本 PR 的模型请求开头。PR 512 本轮增量只有手表 UI 的 import/样式和截图，不改系统提示、工具定义、历史消息或遮盖结果，也不向模型发请求。合并进来的 main 里新增的 `think.*` 提示是新的 `last-user-message` 模板，用于新建的想一想对话，没有改写既有对话的请求头；本轮没有逐字节运行 `check:prompt-prefix`，这部分标记为未运行核实。就本次手表改动而言，不存在“改请求开头”的问题。

2. 不涉及。手表端不组装模型请求；本轮改动也没有新的遮盖、时间字段或无序集合进入模型输入。合并进来的后台设置快照有 `generatedAt` 之类的值，但它们是 gateway 响应，不是模型请求字节；未逐项核对不属于 PR 512 的后台提示渲染，标记为未核实。

3. 没有对应的自动检查。样式改动只由 `watch-ui-review.sh` 截图脚本覆盖“截图存在”，不检查第二行颜色/字重；两条上轮意见都没有新增测试。相反，`WatchGlanceTests.swift:70-77` 仍把“countedAwaiting = 2 但没有 pressing”写成通过，因此如果补一条“有件数就必须有卡片或提示”的反向用例，它现在会失败；目前没有这条用例，所以现有测试不会暴露意见 1。README 文案没有自动检查。

4. 本轮 PR 512 增量产生/修改的值只有 `HimawariDesign` 的导入和 `Color.hmMuted` 的使用：`Package.swift:47-49` 里 `HimawariWatchUI` 已依赖 `HimawariDesign`，`hmMuted` 在 `Palette.swift:112` 存在，使用端可接受。合并进来的新值抽查：`delivery_timing.settings.read/change`、`think.settings.read/change` 在 `CLIENT_CAPABILITY_TABLE`、`GATEWAY_V2_MESSAGE_TYPES` 和对应 schema 里都有；`idleSeconds`/`runTimeoutMinutes` 在 `THINK_SETTING_DEFINITIONS`、`parseThinkInbox`、`ThinkLoop`/worker 里都有读写端，未发现名字或范围对不上。真正对不上的是服务端 `home.read` 允许 `awaitingCount` 包含 `unread`、且可大于 `items` 里的待办数（`home-feed.ts:342`、`contracts-v2.ts:1011-1013`），而手表主屏只按 `items` 判断“有没有事要你定”，见意见 1。
