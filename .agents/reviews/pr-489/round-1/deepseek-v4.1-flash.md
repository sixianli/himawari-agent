## 侧重检查

- **错误路径**：读了 `HomeFeedModel.refresh`、`decide`、`undo` 三条路径（`HomeFeedModel.swift:61-121`）。读失败、动作失败、撤销失败都只把 `failed` 置真，界面没有任何地方读它，用户看不到失败，也无法恢复；撤销失败时条目仍留在 `settled` 里继续被隐藏（见意见 6）。审批失败时 `pending` 不删、不 settle，这部分逻辑是对的。
- **不合规范/不可信输入**：`HomeFeedSnapshot.decode` 只校验外层 `type`（`HomeFeed.swift:235-243`），字段本身依赖 `JSONDecoder`；未知 `kind`/`source` 有字符串兜底。服务器契约里的数组和文本有上限（`home-feed.ts:36-44`、`324-327`），客户端没有额外的上限检查，但也没有递归或明显的大分配。真正的硬伤是服务器动作的 `binding` 被丢掉（见意见 1）。
- **安全/不可逆**：核对了审批编号：服务器 `target.id = approval.id`（`production-home.ts:602-607`），`PendingApproval.id = approvalRequestId`（`Approvals.swift:41,55`），`HomeFeedModel.approval(for:in:)` 按 id 匹配（`HomeFeedModel.swift:78-80`），这一条两端能对上。`ownerPresence` 动作会打开审批详情而不是直接执行（`TodayPage.swift:173-176`）。非审批动作单点即执行，且新协议没有稳定的请求编号，重试可能重复执行（见意见 1）。
- **资源耗尽**：服务器端限制等待条目 200、其他 30、接下来 20；客户端 `settled` 最多随条目数增长；向日葵种子固定 230 个，没有额外循环放大。
- **规则/文档一致**：本改动不涉及提示词目录、运行适配器或请求组装，`prompt-prefix` 规则不需要触发。但作者“服务器接口未接”的说法与代码不符，`GET /api/device/v1/home` 已经存在并有集成测试；`check-design 通过` 也不能证明“界面不写死数字”（见意见 2、7）。

## 意见

### 1 高 `HomeFeedAction` 丢掉服务器下发的 `binding`，`HomeFeedSource.act` 也没有请求编号，真实 home/act 无法通过校验且不幂等

文件:行：`clients/apple/Sources/HimawariCore/HomeFeed.swift:22-43`；`clients/apple/Sources/HimawariShell/Today/HomeFeedModel.swift:16-18,93-98`；服务器 `apps/agent-service/src/production-home.ts:843-855`、`packages/platform-node/src/device-api-routes.ts:1405-1423`。

问题：新类型 `HomeFeedAction` 只有 `action/label/labelBasis/polarity/ownerPresence/reviewLabel`，没有 `binding`；新协议 `func act(_ item:action:revision:)` 也没有 `requestId`。服务器 `/home/act` 要求 `binding` 是字符串，并要求它等于本次首页条目对应动作的绑定串；请求编号还用于重放去重。

证据（读代码证实）：
- 服务器动作产生处：`binding: options.command ? encodeHomeBinding(options.command) : null`（`production-home.ts:151`）。
- 服务器解析动作：`const command = decodeHomeBinding(input.binding); ... if (chosen.binding !== input.binding) return { ok: false, reason: "binding_stale" };`（`production-home.ts:848-855`）。
- 设备路由：`if (typeof binding !== "string") throw ...`（`device-api-routes.ts:1417-1418`），并用 `requestId` 做重放键（`:1419-1422`）。
- 现有 Mac 实现已经完整带上了这两个值：`HomeAction.binding`（`MenuBarFeed.swift:8`）、`Body(key:action:binding:requestId:)`（`:90-101`），并在 `MenuBarModel.swift:124-130` 为同一动作复用请求编号。
- iOS 新类型和协议里没有这两个字段。

推测/结论：非审批动作（提醒、记忆请求、规则、外部提议等）一旦按现有服务器接口实现 `HomeFeedSource.act`，就必须在客户端重新找到 `binding` 才能发出请求；但新类型已经把它丢掉，无法从 `HomeFeedItem` 构造请求，直接发会得到 `HOME_ACTION_INVALID`/400。审批条目走 `DeviceActionsModel.respond` 的路径不受这个字段影响，但“其他走 HomeFeedSource.act”这条目标目前实现不了。没有稳定请求编号还会让超时重试重复执行不可撤销动作。

建议：给 `HomeFeedAction` 补 `binding: String?`，并让 `HomeFeedSource.act` 接收或自行生成稳定的 `requestId`（按 `key + action + binding` 复用，和 Mac 一致）；补一条用真实 `/home` 返回的动作构造请求、交给 `/home/act` 校验的测试。

### 2 中 `HomeFeedSnapshot.decode` 要网关信封，但现有设备 `/home` 返回裸 payload，接上现有接口会解码失败

文件:行：`clients/apple/Sources/HimawariCore/HomeFeed.swift:235-243`；对照 `clients/apple/Sources/HimawariCore/MenuBarFeed.swift:79-82`、`packages/platform-node/src/device-api-routes.ts:1372-1399`。

问题：新解码器要求 `{"type":"home.snapshot","payload":{...}}`，而现有 iOS 能用的设备接口 `GET /home?locale=...` 直接返回 `payload`。作者说“服务器接口和设备网关未接”，但设备接口在代码里已经存在并测试过。

证据（读代码证实）：
- `HomeFeed.swift:236-241`：`struct Envelope { let type: String; let payload: HomeFeedSnapshot }`，并 `guard envelope.type == "home.snapshot"`。
- `device-api-routes.ts:1398-1399`：`return options.sendJson(reply, 200, result.payload);`，即直接把 payload 写回。
- `MenuBarFeed.swift:79-81`：Mac 的 `home(locale:)` 直接 `decode(HomeSnapshot.self, data)`，没有信封。
- `test/integration/device-home.test.ts:194-197`：测试也是 `const body = response.json() as HomeBody; body.items...`，证明 `/home` 是裸 payload。
- 测试夹具 `HimawariCoreTests/Fixtures/home-snapshot.json` 却是带 `type`/`payload` 的信封，所以单测能过，但没有覆盖真实设备接口的形状。

推测/结论：如果将来 `HomeFeedSource.read` 接现有 `DeviceAPI.home(locale:)`，`HomeFeedSnapshot.decode` 每次都会抛 `keyNotFound`/类型错误，`refresh` 只把 `failed` 置真，页面继续回退到设备动作卡，首页永远出不来。如果本意是走网关 `home.read`，则应明确写出并在测试里用网关形状；作者的“服务器接口未接”与现有路由矛盾。

建议：二选一并在类型上写清楚：要么让解码器接受裸 payload（和设备接口一致），要么新增一个明确的网关传输层并让 `read` 用它；测试夹具应至少覆盖真实 `/home` 的响应形状。

### 3 中 只要存在 home 快照，`TodayPage` 就不再渲染设备动作卡；审批来源读取失败时待审批设备动作会从页面上消失

文件:行：`clients/apple/Sources/HimawariShell/Today/TodayPage.swift:91-133`；`clients/apple/Sources/HimawariShell/RootView.swift:166-168`。

问题：设备动作卡只在 `feed.layout == nil` 的 `else if` 分支出现。只要服务器返回了任何快照（包括空快照或 `incompleteSources` 非空），第一条分支就接管，不再显示 `TodayDeviceActionsCard`。

证据（读代码证实）：
- `TodayPage.swift:91`：`if let layout = feed.layout { ... }`，这个分支里只有 lead、rows、upcoming、监听卡，没有设备动作卡。
- `TodayPage.swift:122-131`：设备动作卡只在 `} else if listening != nil || hasDeviceActions {` 里。
- `RootView.swift:167`：角标在 `feed.available` 时只看 `feed.layout?.badge`，而 `HomeLayout.badge` 在 `incompleteSources` 非空时返回 `nil`（`HomeFeed.swift:265-269`），此时即使 `actions.waitingCount > 0` 也不显示角标。

推测/结论：服务器的 `approvals` 来源读失败或条目被合约校验过滤时，`incompleteSources` 会包含 `approvals`，快照仍存在但审批条目不在 `items` 里。此时页面既没有审批卡，也没有角标，用户会漏掉待审批的设备动作。现有 `source == nil` 的生产状态暂时不会触发，但接上首页读之后就会。

建议：在第一条分支里也渲染“未出现在 layout 中的待审批设备动作”（至少 `actions.pending` 非空时），或把设备动作卡作为独立区域始终保留；角标不要把 `actions.waitingCount` 完全丢弃。

### 4 中 `HomeChoice` 在正、负动作都存在时静默丢弃中性动作，服务器提醒的 `snooze` 永远无法从今天页触发

文件:行：`clients/apple/Sources/HimawariCore/HomeFeed.swift:169-189`；`apps/agent-service/src/production-home.ts:367-377`；`clients/apple/Tests/HimawariCoreTests/HomeFeedTests.swift:105-113`。

问题：服务器的提醒条目有三个动作：`dismiss`（positive）、`snooze`（neutral）、`cancel`（negative）。`HomeChoice` 只保留一个 positive 和一个 negative，neutral 仅在完全没有 positive 时才使用。今天页因此只显示两个按钮，`snooze` 被无声丢掉。

证据（读代码证实）：
- 服务器：`action(locale, "dismiss", "positive", ...)`、`action(locale, "snooze", "neutral", ...)`、`action(locale, "cancel", "negative", ...)`（`production-home.ts:367-376`）。
- 客户端：`if let positive { confirm = positive; decline = negative ?? neutral }`（`HomeFeed.swift:177-179`），中性动作在正负都存在时被忽略。
- 测试本身锁定了这个行为：`[snooze, done, dismiss]` 期望 `decline == dismiss`（`HomeFeedTests.swift:109`），没有断言 `snooze` 还能被触发。

推测/结论：如果设计上今天页只允许两个按钮，需要在文档里写明并接受 `snooze` 不可用；否则这是功能缺失，而且用户无法“稍后再提醒”。

建议：`HomeChoice` 保留第三个动作或提供“更多动作”入口；至少加一条测试证明服务器给三个动作时不会静默丢失。

### 5 中 `HomeFeedModel` 的 `decide`/`undo`、审批分流和失败路径没有自动检查，反向用例覆盖不到最危险的新值

文件:行：`clients/apple/Sources/HimawariShell/Today/HomeFeedModel.swift:83-121`；`clients/apple/Tests/HimawariCoreTests/HomeFeedTests.swift:45-113`。

问题：新增测试只覆盖 `HomeFeedSnapshot.decode`、`HomeLayout`、`HomeChoice`、`UpcomingDay` 和 `HomeLocale`；没有任何测试引用 `HomeFeedModel`、`decide`/`undo`、`canAct`，也没有测试真实 `/home` 响应形状或 `binding`/`requestId`。

证据（读代码证实）：
- `HomeFeedTests.swift` 的用例集中在 `layout`/`choice`/解码；全仓库搜索 `HomeFeedModel` 只在源码和 Demo 中出现，测试目录没有。
- `HomeFeedModel.swift:83-121` 同时包含审批分流、源动作、`settled`、`toast`、`failed` 多条状态转换，没有一条被断言。
- 现有反向用例（`rejectsAnotherMessageType`、`noBadgeWhenASourceCouldNotBeRead`、`anItemWithoutButtonsNeverBecomesTheLead`）是有效的，但它们只覆盖纯函数，覆盖不到意见 1、2、6 的失败面。

推测/结论：`swift test 293 个通过`不能说明这些路径正确；意见 1 的 `binding` 缺失因为没有代码使用它，测试也不会失败。需要补反向用例，否则正是 I-73 说的“只在一端认”。

建议：加一个假 `HomeFeedSource` 的模型测试，断言：审批条目走 `approvals.respond`、非审批走 `source.act`、动作失败不 settle、撤销成功恢复、撤销失败恢复/报错、`busy` 防重入；再加一个用真实 `/home` payload（裸 payload）的解码测试和一条缺 `binding` 时请求无法通过后端校验的契约测试。

### 6 中 `failed` 只写不读，动作/撤销失败对用户不可见，撤销失败后条目还会继续被隐藏

文件:行：`clients/apple/Sources/HimawariShell/Today/HomeFeedModel.swift:35,61-70,102-104,108-121`；`clients/apple/Sources/HimawariShell/Today/TodayPage.swift`（全文没有引用 `feed.failed`）。

问题：读失败、动作失败、撤销失败都只设置 `failed = true`，没有 toast、错误行或重试入口；`undo` 失败不会把 `settled` 里的 key 移除，也不会提示用户，条目继续从今天页消失。

证据（读代码证实）：
- `HomeFeedModel.swift:35` 声明 `public private(set) var failed = false`。
- `:68-69` 读失败 `failed = true`；`:102-104` 动作失败 `failed = true`；`:117-119` 撤销失败 `failed = true`。
- `TodayPage` 没有读取 `feed.failed` 的代码，也没有失败视图。
- `undo` 的 `settled.remove` 只在成功分支（`:115-116`），`catch` 分支不会恢复。

推测/结论：网络失败或服务器拒绝时，用户会以为动作已完成（条目消失），或者以为撤销成功；实际状态未知。这是错误路径上最容易被忽略的一类问题。

建议：在 `TodayPage` 显示失败状态/重试；撤销失败时把 key 从 `settled` 移除并保留条目，或明确告诉用户“没撤销成功”。

### 7 低 `TodayPage` 仍有硬编码布局数字，`check-design` 的规则匹配不到，因此“界面不写死颜色和数字（check-design 通过）”不能被这次检查证明

文件:行：`clients/apple/Sources/HimawariShell/Today/TodayPage.swift:312,315,331,361`；`clients/apple/scripts/check-design.mjs:56-71`。

问题：`HomeLinkRow` 用 `spacing: 12`、`spacing: 2`、`padding(.vertical, 14)`；`UpcomingCard` 用 `spacing: 10`。`HomeToastView.seconds = 6` 也是硬编码。`check-design` 的 `number-literal` 只匹配 `size:`、`width:`、`height:`、`cornerRadius:`、`fontSize:` 等标签，不匹配 `spacing:` 和 `padding`，所以检查通过不代表满足约束。

证据（读代码证实）：
- `TodayPage.swift:312` `HStack(alignment: .top, spacing: 12)`
- `TodayPage.swift:315` `VStack(alignment: .leading, spacing: 2)`
- `TodayPage.swift:331` `.padding(.vertical, 14)`
- `TodayPage.swift:361` `VStack(alignment: .leading, spacing: 10)`
- `check-design.mjs:68-71` 的正则只覆盖 `size|cornerRadius|width|height|...` 这些名字。

推测/结论：作者说“check-design 通过”属实，但该检查没有覆盖这些数字，属于检查盲区。

建议：把间距/内边距纳入 `DesignTokens.Home`（例如 `rowGapSmall`、`rowVerticalPadding`、`listSectionGap`），或扩展 `check-design` 对 `spacing`/`padding` 的匹配。

### 8 低 新增的若干值没有消费者或没有实际用途，容易让后续接线误以为已经接好

文件:行：`clients/apple/Sources/HimawariDesign/Generated/DesignTokens.swift:105-133`；`clients/apple/Sources/HimawariCore/HomeFeed.swift:218-221`；`clients/apple/Sources/HimawariShell/Today/HomeFeedModel.swift:16-18,93-98`。

问题：`DesignTokens.Home.rowIconBox`、`whyChevron` 在源码中没有使用；`HomeFeedSnapshot.awaitingTruncated` 被解码但没有消费者；`HomeFeedSource.act` 的 `revision` 参数目前只是透传，服务器 `/home/act` 并不接受它。它们都不影响当前编译，但会让“新值清单”看起来比实际接好的多。

证据（读代码证实）：搜索 `DesignTokens.Home.rowIconBox`/`whyChevron` 无使用处；`awaitingTruncated` 只在 `HomeFeed.swift:220,227,229` 出现；`revision` 在 `HomeFeedModel.swift:97,115` 被传给 source，但没有实现消费。

建议：删掉未用的 token，或在使用处落位；把 `revision` 的用途（乐观并发、缓存键还是根本不用）写清楚，避免以后实现时误用。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这次 diff 只改 `clients/apple`、设计 token、文档和测试夹具，没有改系统提示、工具定义、历史消息、遮盖逻辑、提示词目录或运行适配器；也没有任何新增的模型请求。因此发给模型的内容仍然只在末尾追加，没有任何“每轮会变的值”被放进请求头。依据 `prompt-prefix.md` 第 4、6 条。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会（本次改动范围内）。没有模型请求序列化；客户端内部 `HomeLayout` 用 `firstIndex` + `remove` 保留服务器顺序（`HomeFeed.swift:254-260`），`HomeChoice` 按服务器数组顺序取第一个匹配项（`:173-186`），`CornerFlower` 使用固定种子（`CornerFlower.swift:75-96`），没有用 `Set` 的遍历顺序生成网络字节。将来实现 `HomeFeedSource` 时如果把 `Set`/字典直接序列化，需要另查。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有部分：`HomeFeedTests` 覆盖了顺序、lead、badge、`incompleteSources`、`choice`、`upcoming`、`locale` 和错误消息类型；`CornerFlowerTests` 覆盖花瓣和种子；`check-design` 和 `swift test` 是已有入口。反向用例中 `rejectsAnotherMessageType`、`noBadgeWhenASourceCouldNotBeRead`、`anItemWithoutButtonsNeverBecomesTheLead` 是有效的。但 `HomeFeedModel` 的状态机、审批分流、失败/撤销路径没有测试；真实 `/home` 裸 payload 和 `binding`/`requestId` 也没有反向用例。因此这些最危险的新路径目前不会因为缺失而失败。

4. **每个值两端都能接受吗？** 逐项看：
   - `HomeFeedAction.binding`：服务器产生（`production-home.ts:151`），`/home/act` 使用并严格要求（`device-api-routes.ts:1417-1423`、`production-home.ts:843-855`）；新客户端丢弃，**不能接受**（见意见 1）。
   - `requestId`：服务器要求字符串并用于重放去重（`device-api-routes.ts:1412-1422`）；新协议没有，**不能接受**（见意见 1）。
   - 审批编号：服务器 `target.id = approval.id`（`production-home.ts:607`），客户端 `PendingApproval.id = approvalRequestId`（`Approvals.swift:41,55`），`HomeFeedModel` 按 id 匹配（`:78-80`），**能对上**。
   - `home.snapshot` 外形：网关查询产生带信封的快照（`production-home.ts:865-895`），但设备 `/home` 去掉信封（`device-api-routes.ts:1398-1399`），新解码器只认信封，**与现有设备接口不一致**（见意见 2）。
   - `revision`：服务器产生（`home-feed.ts:350-353`），客户端透传给 `source.act`，但 `/home/act` 不接收，当前**没有实际消费者**。
   - `awaitingTruncated`、`incompleteSources`、`upcoming`、`repeat`、`dueAt`：服务器产生且客户端能解码；`incompleteSources` 用于 badge，`upcoming` 用于显示，`repeat` 目前未使用但类型兼容。
   - 设计 token：`tokens.json` 的 `home` 键经 `make-design-tokens.mjs` 生成到 `DesignTokens.Home`，生成文件与键名对应；但有 `rowIconBox`/`whyChevron` 未使用（见意见 8）。
   - 本地化键：`TodayPage` 使用的 `today.*` 键在中/日/英三份 `Localizable.strings` 都有；删除的 `placeholder.notConnected` 已无引用。
   - `check-design`：生成 token 一致性可检查，但 `spacing`/`padding` 数字不在规则内，所以不能证明“界面不写死数字”（见意见 7）。
