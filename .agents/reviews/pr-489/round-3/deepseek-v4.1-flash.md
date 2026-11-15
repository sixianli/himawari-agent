本轮范围：先看 `git diff d05e718..239ecdc` 的增量（14 个文件，业务改动集中在 8 个 Swift 文件），再对照读了 `HomeFeed.swift`、`HomeFeedModel.swift`、`DeviceHomeSource.swift`、`AppModel.swift` 的 forget/emptyStore 路径、`RootView.swift`、`TodayPage.swift`、`MenuBarModel.swift`，以及服务端 `device-api-routes.ts` 的 `/home/act` 校验、`production-home.ts` 的动作构造和 `resolveAction`、`contracts-v2.ts` 的 HOME Schema、测试和 `Package.swift`。没有整份重读增量未触碰的旧代码。

上一轮意见核对结论：请求编号前缀、无 binding 动作不画按钮、信封反向用例、审批失败提示、换服务器清空快照都已落实到代码；但角标回退、reset 的并发边界和测试覆盖仍有缺口，见下。

### 1 中 角标回退条件与 `HomeLayout.badge` 的抑制条件不一致，来源不全时角标会消失或少算

**文件:行：** `clients/apple/Sources/HimawariShell/RootView.swift:166-169`、`clients/apple/Sources/HimawariCore/HomeFeed.swift:278-283`、`clients/apple/Sources/HimawariShell/Today/HomeFeedModel.swift:57-59`

**问题：** 新的回退只在 `incompleteSources` 含 `approvals` 时使用 `actions.waitingCount`；但 `HomeLayout.badge` 仍对**任意**不完整来源返回 `nil`。结果是：审批来源完整、其他来源（mail/rules/reminders）不完整时，角标直接消失，旧代码至少会显示待审批数；审批来源不完整时，又只显示审批数，漏掉其他来源已知的待办。两处判断标准不一致。

**证据（读代码证实）：**

```swift
// RootView.swift:166
private var todayBadge: Int? {
    guard feed.available else { return actions?.waitingCount }
    return feed.approvalsIncomplete ? actions?.waitingCount : feed.layout?.badge
}

// HomeFeed.swift:278
static func badge(_ snapshot: HomeFeedSnapshot, settled: Set<String>) -> Int? {
    guard snapshot.incompleteSources.isEmpty else { return nil }
    let settledAwaiting = snapshot.items.filter { $0.awaitsOwner && settled.contains($0.key) }.count
    let count = max(0, snapshot.awaitingCount - settledAwaiting)
    return count > 0 ? count : nil
}
```

改前是 `feed.layout?.badge ?? actions?.waitingCount`，所以 `["mail"]` 不完整时会回退到待审批数；改后变成 `nil`。

**建议：** 把角标计算集中在一处。若希望尽量显示可信数字，可在 `approvals` 不完整时用 `actions.waitingCount` 加上快照里非审批的 `awaitsOwner` 条目（按 key 去重）；若决定任何来源不完整都不显示，就删掉只针对 `approvals` 的特殊回退，避免两套语义。至少要同步修改 `HomeLayout.badge` 的抑制条件或明确写出取舍。

### 2 低 `reset()` 无法阻止在途的 `act`/`refresh` 把旧服务器快照写回，也未清 `DeviceHomeSource` 的请求编号缓存

**文件:行：** `clients/apple/Sources/HimawariShell/Today/HomeFeedModel.swift:61-67`、同文件 `73-82`、`95-124`、`clients/apple/Sources/HimawariShell/AppModel.swift:233-244`、`437-441`、`clients/apple/Sources/HimawariShell/Today/DeviceHomeSource.swift:8,21-22`

**问题：** `reset()` 清掉了当前状态，但没有代次/取消机制。已有的在途 `source.read` 或 `source.act` 之后的 `refresh()` 仍可能在 `reset()` 之后执行 `snapshot = next`，把旧服务器内容重新写回内存；`DeviceHomeSource.requestIds` 也不随换服务器清空。

**证据（读代码证实）：**

```swift
public func reset() {
    snapshot = nil
    settled = []
    busy = []
    toast = nil
    failed = false
}

public func refresh() async {
    guard let source else { return }
    do {
        let next = try await source.read(locale: locale)
        snapshot = next          // 没有代次判断
        ...
```

`AppModel.emptyStore()` 已经调用 `home.reset()`（`AppModel.swift:237`），但 `HomeFeedModel` 没有任何代次字段，`DeviceHomeSource` 的 `requestIds` 也没有清理入口。

**推测：** 实际触发需要一次在途请求（例如用户点动作后立刻在设置里移除设备，TodayPage 的 `Task { await feed.decide(...) }` 不取消），概率低；UI 在未配对状态不会展示旧内容，所以更偏内存/隐私问题而非当前可见错误。

**建议：** 给 `HomeFeedModel` 加代次计数，`reset()` 自增；`refresh()`/`decide()` 拿到结果后若代次已变则丢弃。给 `HomeFeedSource` 增加 `reset()`（或让 `DeviceHomeSource` 在换凭据时清 `requestIds`），由 `HomeFeedModel.reset()` 调用。

### 3 低 `choice` 逐条过滤 binding，若服务端给出“正向无 binding、负向有 binding”，负向动作会被当成主按钮

**文件:行：** `clients/apple/Sources/HimawariCore/HomeFeed.swift:166-168`、同文件 `175-190`；服务端契约 `apps/agent-service/src/production-home.ts:151,327`

**问题：** `choice` 是先把每个动作单独过滤，再交给 `HomeChoice` 选 positive/negative/neutral。若正向动作没有 binding、负向动作有 binding，过滤后只剩负向动作；`HomeChoice` 在没有 positive/neutral 时会把负向动作赋给 `confirm`，界面主按钮就变成了“不同意/拒绝”这类负向动作，可能造成误操作。

**证据（读代码证实）：**

```swift
public var choice: HomeChoice? {
    HomeChoice(actions.filter { $0.binding != nil || approvalId != nil })
}
...
} else if let negative {
    confirm = negative
    decline = nil
}
```

服务端允许单个动作的 `binding` 为空：

```ts
binding: options.command ? encodeHomeBinding(options.command) : null,
...
actions: [action(locale, "reconnect", "positive")],
```

当前生产服务端只有 `reconnect` 一个无 binding 动作，且它是唯一动作（过滤后为 nil，不会变成主按钮），所以**当前不会触发**；混合绑定属于契约允许但现状未出现的输入，后面的判断是推测。

**建议：** 先按完整动作集合算出 `confirm`/`decline`，再检查这两个动作是否可用：审批条目走审批路由可不需要 binding；非审批条目要求 `confirm`（以及存在的 `decline`）的 `binding != nil`，否则整个 `choice` 返回 `nil`。不要在过滤后重新做极性选择。

### 4 低 新增的审批失败提示、reset、角标回退和 TodayPage 卡片条件没有自动检查；requestId 反向用例依赖概率

**文件:行：** `clients/apple/Tests/HimawariCoreTests/HomeFeedTests.swift:59-95`、`clients/apple/Tests/HimawariShellTests/HomeFeedModelTests.swift:56-85`、`clients/apple/Package.swift` 的 `#if os(Linux)` 分支

**问题：** 这一轮新增的 `approvalsIncomplete`、`reset()`、审批 respond 失败提示、`TodayPage` 的卡片条件都没有测试。`HomeFeedModelTests` 只覆盖了非审批来源的成功/失败/取消和 source 为 nil 的情况。`requestId` 用例跑 2000 次随机值，去掉前缀后几乎必然失败，但不是确定性的反向用例。

**证据（读代码证实）：**

```swift
// HomeFeedModelTests 现有用例只到：
@Test func aFailedActionKeepsTheItemAndTellsTheOwner()
@Test func decliningOwnerPresenceIsNotAFailure()
@Test func anItemWithoutASourceCannotBeActedOn()
```

```swift
@Test func homeRequestIdsStartWithALetterOrDigitAndStayInsideTheServerCharacterSet() {
    for _ in 0 ..< 2000 {
        let id = HomeRequestId.make()
        ...
```

`Package.swift` 里 `#if os(Linux)` 把 `HimawariShellTests` 整体排除，Linux 上的 293 个测试覆盖不到这些新逻辑。

**建议：** 把“是否显示失败提示”“角标应显示多少”“reset 后是否丢弃旧结果”抽成纯函数，在 `HimawariCoreTests` 里做确定性测试；`HomeRequestId` 直接断言 `hasPrefix("home-")`，再断言字符合法。另外补一条 `reset()` 后模拟在途 `read` 返回旧快照的测试。

**侧重检查**

- **错误路径：** 读了 `DeviceActionsModel.respond` 的失败分支：`problem = notSent`，`pending` 保留；`HomeFeedModel.decide` 在 `pending` 仍含审批且 `problem != nil` 时给 toast，逻辑成立。`.changed` 会设置 `problem` 并可能被 `refresh()` 重新加入 pending，也会提示，符合“没成功”。`OwnerPresenceError.declined` 被吞掉且不 settled，符合“本人取消不算失败”。`DeviceHomeSource` 对 4xx 清 requestId、对 5xx/网络错误保留，利于幂等重试。
- **不合规范/不可信输入：** 服务端 snapshot 的 `binding` 可为 null（reconnect），现在非审批条目不会把无 binding 动作放进 `choice`；但混合绑定场景见意见 3。`incompleteSources` 的 `"approvals"` 与服务端 `HOME_SOURCE_NAMES` 完全一致。`HomeFeedSnapshot.decode` 只解码裸 payload，和 `/home` 返回 `result.payload` 一致。
- **安全/不可逆：** 客户端只回传服务端给的 `binding` 和 `action`，服务端 `resolveAction` 会重新核对 `item`、`action`、`binding`，客户端不能伪造未提供的动作；审批的 approved/denied 由 `polarity` 决定，混合 binding 导致的极性翻面是潜在误操作点（意见 3）。未发现新增日志泄露密钥。
- **资源耗尽：** `DeviceHomeSource.requestIds` 在 5xx/网络错误时保留，且 `reset()` 不清；键的数量受条目×动作数限制，未发现无界增长循环，风险低但建议随 reset 清理。
- **规则/文档一致性：** 本增量没有触碰系统提示、工具定义、历史消息或遮盖代码，`prompt-prefix` 规则不适用；作者说“不改请求开头”与代码一致。作者说“iPhone 与 Mac 菜单栏共用 HomeRequestId”与代码一致（`MenuBarModel.swift:125`、`DeviceHomeSource.swift:21`）。
- **未核实：** 未运行 `swift test`，无法验证“293 个通过”；Mac 编译和截图未核实；仓库工作区里 `.agents/reviews/pr-489/round-2/*` 未实际存在，无法读取上一轮原始记录（内容来自本次材料）。

**必答问题**

1. **不涉及。** 增量只改 Apple 客户端和评审记录，没有任何组装或修改模型请求的代码；系统提示、工具定义、历史消息、遮盖结果都没有变化。增量为 0 个新的“每轮会变的值”进入模型请求，`HomeRequestId` 只用于设备 HTTP 幂等编号，不发给模型。依据的“只追加”规则没有被触碰。

2. **不涉及。** 新出现的随机值是 `HomeRequestId.make()`（`home-` 前缀 + 随机 token），每次动作/重试可能不同，但它只用于 `/home/act` 的 idempotency，不进入任何模型输入；其余改动没有上下文相关遮盖、时间字段或无序集合参与模型序列化。

3. **部分有检查。** 信封反向用例已修好：有效 payload 必须解码成功、套信封必须失败，退回信封解码会让第一条断言失败（`HomeFeedTests.swift:59-65`）。无 binding 动作的用例在退回过滤前实现时会失败（`HomeFeedTests.swift:67-72`）。但审批失败提示、`reset()`、角标回退和 TodayPage 卡片条件没有自动检查；`requestId` 用例是 2000 次随机抽样，不是确定性反向用例。Linux 上 `swift test` 只跑 `HimawariCoreTests`，`HimawariShellTests` 被 `#if os(Linux)` 排除，因此“293 个通过”不能证明 Shell 层新行为被覆盖（未核实实际运行结果）。

4. **逐个核对结果：** `HomeRequestId` 的产生端是 `HomeFeed.swift:242-246`，使用端是 `DeviceHomeSource.swift:21` 和 `MenuBarModel.swift:125`，两端都用 `home-` 前缀 + base64URL（字符集 `A-Za-z0-9-_`），长度 27，能通过服务端 `device-api-routes.ts:152` 的 `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u` 和 128 上限，**可以接受**。`binding` 产生于服务端 `production-home.ts:132-153`，使用于 `HomeFeed.choice`、`DeviceHomeSource.act` 和 `/home/act`；服务端要求 `typeof binding === "string"` 并核对动作是否被提供，非审批无 binding 动作已被过滤，**当前可接受**，但混合绑定有意见 3 的极性风险。`incompleteSources` 的 `"approvals"` 与服务端 `HOME_SOURCE_NAMES`（`contracts-v2.ts:871-881`）一致，**可以接受**。`reset()` 的使用端是 `AppModel.emptyStore()`，覆盖 forget/startOver/removed，**覆盖了正常换服务器路径**，但在途请求和 source 缓存未覆盖（意见 2）。裸 payload 解码格式与 `device-api-routes.ts:1399` 返回 `result.payload` 一致，**可以接受**。`todayBadge` 的 `Int?` 使用端 `FloatingTab` 可以接受，但语义有意见 1 的问题。
