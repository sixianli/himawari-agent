## 本轮查过的范围

增量 `145deffdd5cc231ae1215d05b8ac93e95fe51932..d05e718890d3f171742ed685b6411dce3745be6b` 涉及客户端：`HomeFeed.swift`、`MenuBarFeed.swift`、`DeviceHomeSource.swift`、`HomeFeedModel.swift`、`AppModel.swift`、`TodayPage.swift`、`RootView.swift`、`Package.swift`、本地化、设计令牌、测试与夹具。对照读了服务端的 `device-api-routes.ts`（`GET /home`、`POST /home/act`）、`production-home.ts`、`production-home-binding.ts`、`home-feed.ts`，以及 `prompt-prefix.md`、`incidents-and-gates.md` 中 I-73、`check-design.mjs`。未整份重读与本增量无关的旧代码；Mac 编译和真机 Face ID 未核实。

## 上一轮意见核对

- 1 未完全改好：`binding` 和 `requestId` 都加上了，但 `requestId` 仍可能被后端拒绝；`binding == nil` 的动作仍会被画成按钮且必定失败。见本轮 1、2。
- 2 改好：服务端 `GET /home` 确实返回裸 `result.payload`，客户端改为裸 payload 解码一致。但新增反向用例本身防不住回退，见本轮 6。
- 3 核心改好：`incompleteSources` 非空时确实不再丢掉设备动作卡；但触发条件过宽，见本轮 4。
- 6 部分改好：`source.act` 和 `undo` 失败现在有提示；审批路径仍无提示，`failed` 仍只写不读，真机也不会有 `undo`，见本轮 3、7、8。
- 7 部分改好：四个间距值进了 `tokens.json`，但 `check-design` 规则没有变，仍证明不了“没有写死数字”，见本轮 9。

## 意见

### 1 中高 `requestId` 可能以 `-` 或 `_` 开头，被后端 `MACHINE_STRING` 拒绝，设备动作会间歇性 400

文件：`clients/apple/Sources/HimawariShell/Today/DeviceHomeSource.swift:21`、`clients/apple/Sources/HimawariCore/DeviceAPI.swift:28-29`、`clients/apple/Sources/HimawariCore/Hashing.swift:27-30`、`packages/platform-node/src/device-api-routes.ts:152,1412-1413`

问题：`requestId` 用 `OutgoingMessage.newId()`，生成的是 base64url 字符串，首字符可能是 `-` 或 `_`；服务端却要求首字符是字母或数字。首字符为这两个字符时（约 2/64 ≈ 3%），`/home/act` 在进入业务校验前就 400。重试会换新 id，所以不是永久失败，但核心动作入口会随机报“没做成”。

证据（读代码证实）：

```swift
// DeviceHomeSource.swift:21
let requestId = requestIds[key] ?? OutgoingMessage.newId()
// DeviceAPI.swift:28-29
public static func newId() -> String {
    RandomToken.base64URL(byteCount: 16)
}
// Hashing.swift:27-30
base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
```

```ts
// device-api-routes.ts:152
const MACHINE_STRING = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// :1412-1413
typeof requestId !== "string" ||
!MACHINE_STRING.test(requestId) ||
```

建议：生成后端可接受格式的请求编号，例如固定前缀 `home-` 接 UUID，或把 base64url 首字符替换成字母；并加一条断言生成值匹配 `MACHINE_STRING` 的测试。`MenuBarModel.swift` 里同样的 `actionRequestIds[key] ?? OutgoingMessage.newId()` 也有同一问题，建议一起修。

### 2 中 `binding == nil` 的动作仍被显示成按钮，但 `/home/act` 必定 400

文件：`apps/agent-service/src/production-home.ts:151,327`、`apps/agent-service/src/production-home-binding.ts:28-30`、`packages/platform-node/src/device-api-routes.ts:1417-1418`、`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:98-101`、`clients/apple/Sources/HimawariShell/Today/TodayPage.swift:144-160`

问题：服务端在“动作没有对应命令”或“绑定串太长”时给 `binding: null`。当前 `connection`（Gmail 需要重新连接）的 `reconnect` 就是 `action(locale, "reconnect", "positive")`，没有 command，因此 `binding` 为 null。客户端只要求 `choice` 非空就画确认按钮；用户点“重新连接”后，请求体里的 `binding` 被省略或为 null，服务端要求 `typeof binding === "string"`，直接 400。这个条目因此永远不可能成功，且没有别的打开路径（`open` 只处理审批或 threadId）。

证据（读代码证实）：

```ts
// production-home.ts:151
binding: options.command ? encodeHomeBinding(options.command) : null,
// :327
actions: [action(locale, "reconnect", "positive")],
// device-api-routes.ts:1417-1418
if (typeof binding !== "string")
  throw new DeviceGatewayError(DEVICE_GATEWAY_ERROR_CODES.HOME_ACTION_INVALID, 400);
```

建议：客户端只把 `binding != nil` 的动作放进 `HomeChoice`/可点按钮；对没有绑定的动作（如 `reconnect`）走专门的打开路径或明确禁用。并用服务端真实的 connection 夹具补一条“binding 为 null 时不发 `/home/act`”的测试。

### 3 中 审批动作失败仍然没有任何用户提示，作者“动作失败有提示”不成立

文件：`clients/apple/Sources/HimawariShell/Today/HomeFeedModel.swift:85-91`、`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionsModel.swift:124-133`、`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionViews.swift:144-157`

问题：本轮只在 `source.act` 失败的 `catch` 里加 toast。审批条目走 `approvals.respond` 时，失败只把 `DeviceActionsModel.problem` 置为“没发出去”，而 `TodayPage` 和 `TodayDeviceActionsCard` 都没有渲染 `model.problem`（只在 `ApprovalsView`/`DeviceAbilitiesSection` 里渲染）。因此在“今天”页点同意/不同意失败时，条目留着、没有任何提示，和作者的说法不符。

证据（读代码证实）：

```swift
// HomeFeedModel.swift:85-91：审批分支没有 toast/failed
if let approvals, let approval = approval(for: item, in: approvals) {
    busy.insert(item.key)
    defer { busy.remove(item.key) }
    await approvals.respond(approval, approved: action.polarity == .positive)
    if !approvals.pending.contains(where: { $0.id == approval.id }) { settled.insert(item.key) }
    await refresh()
    return
}
```

```swift
// DeviceActionsModel.swift:130-133
} catch {
    if approved && approval.recentAuthenticationRequired { Haptics.shared.report(.faceIDFailed) }
    problem = DeviceActionsText.notSent
}
```

建议：在审批分支根据 `respond` 的结果设置 toast，或在 `TodayDeviceActionsCard`/`TodayPage` 渲染 `actions.problem`；测试要覆盖“审批响应失败时用户看得到提示”。

### 4 中 任意来源不完整都会显示设备动作卡并回退角标，会导致审批重复和角标少算

文件：`clients/apple/Sources/HimawariShell/Today/TodayPage.swift:116`、`clients/apple/Sources/HimawariCore/HomeFeed.swift:272-273`、`clients/apple/Sources/HimawariShell/RootView.swift:166-167`、`packages/application/src/services/home-feed.ts:259,337-339`

问题：`incompleteSources` 不只包含 `approvals`，还包括 `mail`、`reminders`、`runs`、`done`、`upcoming` 等。现在只要它不是空，就同时做两件事：显示设备动作卡、角标回退到 `actions.waitingCount`。当只有 `upcoming` 读取失败、审批来源正常时，首页审批条目会同时出现在首页列表和设备动作卡里（重复）；角标也会从首页待办数（可能有很多邮件/提醒）退到设备审批数（可能为 0）。这不是上一轮“审批来源失败”的精确修复。

证据（读代码证实）：

```swift
// TodayPage.swift:116
if let actions, hasDeviceActions, feed.snapshot?.incompleteSources.isEmpty == false {
```

```swift
// HomeFeed.swift:272-275
static func badge(_ snapshot: HomeFeedSnapshot, settled: Set<String>) -> Int? {
    guard snapshot.incompleteSources.isEmpty else { return nil }
    ...
}
```

```ts
// home-feed.ts:337-339
if (result.incomplete) incomplete.push("upcoming");
...
incomplete.push("upcoming");
```

建议：只在 `incompleteSources` 包含 `"approvals"` 时显示设备动作卡/改用设备审批数；其他来源不完整时保留首页角标。若要显示设备卡，需去重（例如排除首页已有 `approvalId` 的待审批项）。

### 5 低 `DeviceHomeSource` 丢弃服务端动作结果，真机上没有成功提示和撤销入口

文件：`clients/apple/Sources/HimawariShell/Today/DeviceHomeSource.swift:34`、`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:103,108`、`clients/apple/Sources/HimawariShell/Today/HomeFeedModel.swift:99-101,110-124`

问题：`DeviceHomeSource.act` 永远返回 `HomeActOutcome(message: nil, undo: nil)`，底层 `api.act` 也把响应体丢掉（`_ = try await http.send`）。因此真机上动作成功后不会显示服务端结果，`HomeFeedModel.undo` 的撤销入口永远没有 `undo` 可执行；本轮新增的“撤销失败提示”在真机路径上不可达。作者说“动作或撤销失败显示提示”，撤销部分实际只存在于 Demo/未来接口。

证据（读代码证实）：

```swift
// DeviceHomeSource.swift:34
return HomeActOutcome(message: nil, undo: nil)
```

```swift
// MenuBarFeed.swift:103,108
_ = try await http.send(DeviceRequest(method: "POST", path: "home/act", body: body))
...
_ = try await http.send(DeviceRequest(...))
```

建议：要么明确把撤销列为未实现并删掉不可达提示，要么解析 `/home/act` 响应中的结果/撤销并填入 `HomeActOutcome`，同时补对应测试。

### 6 低 新的反向用例在实现退回“信封解码”时不会失败

文件：`clients/apple/Tests/HimawariCoreTests/HomeFeedTests.swift:59-61`、`clients/apple/Sources/HimawariCore/HomeFeed.swift:218-225,237-245`

问题：`rejectsAGatewayEnvelope...` 里的 `payload` 只有 `items/awaitingCount/revision/generatedAt`，缺少 `awaitingTruncated`、`incompleteSources`、`upcoming`。即使把实现退回成 `Envelope { type, payload: HomeFeedSnapshot }`，这个 payload 也会因为缺字段抛 `keyNotFound`，用例仍然通过——它没有真正锁住“只收裸 payload”。另外生产路径 `DeviceAPI.homeFeed` 用的是 `DeviceAPI.decode`，根本不经过 `HomeFeedSnapshot.decode`，这个用例连生产解码器也没覆盖。

证据（读代码证实）：

```swift
// HomeFeedTests.swift:59-61
let data = Data(#"{"type":"home.snapshot","payload":{"items":[],"awaitingCount":0,"revision":"r","generatedAt":"x"}}"#.utf8)
#expect(throws: (any Error).self) { try HomeFeedSnapshot.decode(data) }
```

```swift
// HomeFeed.swift:245
return try decode(HomeFeedSnapshot.self, data)
```

建议：反向用例使用一个字段完整、能单独通过 `HomeFeedSnapshot` 解码的 payload，再包一层 `{"type":"home.snapshot","payload":...}`，断言必须抛错；同时给 `DeviceAPI.homeFeed` 用假 HTTP exchange 加落地测试。

### 7 低 `failed` 仍只写不读，首页读取失败对用户不可见

文件：`clients/apple/Sources/HimawariShell/Today/HomeFeedModel.swift:35,61-70,104,120`

问题：本轮新增提示仍只覆盖动作/撤销，`refresh()` 失败只置 `failed = true`；全仓库没有读取 `failed` 的地方。真机上首页读取失败时，旧快照保持、或者页面空白，用户看不到“读取失败”，也没有重试提示。

证据（读代码证实）：

```swift
public private(set) var failed = false
...
} catch {
    failed = true
}
```

建议：删除这个状态，或在 `TodayPage` 显示可重试的错误行；读取失败时不要把旧快照当成最新数据。

### 8 低 `forget`/重新配对时不清空首页快照，旧服务器内容会留在内存里

文件：`clients/apple/Sources/HimawariShell/AppModel.swift:33,73,233-243,436-448`

问题：`home` 现在是持有真实 `DeviceHomeSource` 的长期对象，但 `emptyStore()` 只清 `chat` 和 `actions`，`forget()` 也没有清 `home.snapshot`/`settled`。换服务器或重新配对后，`MainTabsView` 仍是同一个 `model.home`，在新一次 `refresh()` 成功前会继续渲染旧服务器的首页条目。

证据（读代码证实）：`emptyStore()` 只做 `chat?.stop(); chat = nil; actions = nil; ...`；`forget()` 中没有 `home` 相关语句。

推测：旧内容在重新配对后是否真的可见，取决于新服务器刷新耗时和失败情况，未在真机上验证；但快照确实不会被清除。

建议：给 `HomeFeedModel` 加 `reset()`，在 `emptyStore()`/`forget()` 中调用，清空 `snapshot`、`settled`、`toast`、`busy` 和请求编号缓存。

### 9 低 `check-design` 仍匹配不到 `spacing:`/`padding` 字面量，不能证明“界面不写死数字”

文件：`clients/apple/scripts/check-design.mjs:68-71`、`clients/apple/Sources/HimawariShell/Today/TodayPage.swift:105,263,371`

问题：本轮把四个硬编码间距换成了 `DesignTokens.Home.*`，但没有改检查规则。`number-literal` 只匹配 `size: 12`、`.cornerRadius(8)` 这类写法，不匹配 `VStack(spacing: 10)`、`.padding(.vertical, 14)`。现在 `TodayPage` 里仍有 `spacing: 0`（0 通常无害），但未来再加 `spacing: 10` 或 `padding(..., 14)` 时 `check-design` 不会报错。因此“check-design 通过”仍不能证明作者想证明的规则。

证据（读代码证实）：

```js
// check-design.mjs:68-71
pattern:
  /\b(?:size|cornerRadius|width|height|minWidth|minHeight|maxWidth|maxHeight|idealWidth|idealHeight|lineSpacing|fontSize|radius)\s*:\s*-?\d|\.(?:lineSpacing|cornerRadius|opacity|kerning|tracking)\(\s*-?\d/u,
```

建议：把这轮修的四个值作为“已核对清单”接受，但不要用 `check-design` 通过来论证规则；若要作为门槛，扩展规则覆盖 `spacing`、`padding`、`offset` 等数字字面量并加反向夹具。

## 侧重检查

- 错误路径：查了 `/home/act` 的 400/409/5xx/网络错误、Face ID `declined`、`refresh` 失败、`undo` 失败。发现请求编号格式（1）、`binding == nil`（2）、审批失败静默（3）、`failed` 只写不读（7）、撤销不可达（5）。
- 不合规范/不可信输入：服务端动作可能带 `binding: null`，客户端没有区分可执行/不可执行动作（2）；`requestId` 生成端与后端校验规则不一致（1）；服务端文本只经 `Text` 显示，没有拼接或执行，未发现注入路径。
- 安全与不可撤销操作：`forget` 后旧首页快照未清（8，后果为推测）；审批按钮仍受 `DeviceActionsModel` 的 Face ID/confirm 路径保护；`binding` 原样回传、客户端不解释，未发现越权构造；没有把服务器文本写进系统提示或日志。
- 资源耗尽：`requestIds` 按“条目+动作+绑定”保存，正常失败会清理 4xx，长期只有 5xx/网络失败会保留，量受首页条目数限制；服务端 replay 表有 256 上限。没有发现新增无界循环；但客户端 `refresh()` 没有节流，频繁切页/下拉会重复触发 `home.read`，属轻微负载风险。
- 规则/文档一致性：`prompt-prefix.md` 不受影响；`check-design.mjs` 规则与作者“通过即不写死数字”的说法不一致（9）；作者原始说法“HomeFeedModel 的 source 是 nil”已被代码推翻（`AppModel.swift:73` 现在总是接 `DeviceHomeSource`），第 2 轮补充说法与代码一致；Linux `swift test` 的 293 个用例不包含新增的 `HimawariShellTests`（`Package.swift` 的 `#if os(Linux)` 把 interface targets 置空）。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 增量只改客户端模型、视图、本地化、设计令牌和设备 HTTP 请求；没有改系统提示、工具定义、历史消息、遮盖或任何 prompt 组装。发给模型的内容仍只在末尾追加；本轮新增的每轮变化值（`requestId`、presence reason、界面时间）都不在模型提示里。依据 `prompt-prefix.md` 第 2、4 条。未核实：客户端调用 `home.read` 是否会在特定部署配置下触发服务端其他模型调用；即使触发，也没有改请求开头结构。

2. **不涉及模型请求的字节确定性。** 客户端新增的随机 `requestId`、设备签名 nonce、`generatedAt`/`revision` 都在设备 HTTP 层或服务端响应里，不是模型提示；同一段模型文字没有因这次改动被重新编码或依赖前后文遮盖。设备请求体的 JSON 键顺序由 `JSONEncoder` 决定，理论上不保证稳定，但服务端不按字节比较该请求体，也不影响模型缓存。

3. **有自动检查，但覆盖不足，且反向用例有无效之处。** `HomeFeedTests` 覆盖了 fixture 解码和 `binding` 保留；`rejectsAGatewayEnvelope...` 因 payload 不完整，退回信封解码时仍会抛错，不能证明“只收裸 payload”（6）。`HomeFeedModelTests` 覆盖了成功/失败/declined 三种 `respond` 结果，但只在非 Linux 的 `HimawariShellTests` 里；`swift test` 293 个通过不包含它们。没有测试覆盖 `DeviceHomeSource` 的 `requestId` 格式、`binding == nil` 的 reconnect、审批失败提示、重复设备卡、撤销路径；`FakeSource.read` 总是返回空快照，`aFailedActionKeepsTheItem...` 只断言 `settled`，没有断言条目仍在。

4. **逐个使用端核对结果：**
   - `HomeFeedAction.binding`：服务端产生 `string | null`（`production-home.ts:151`），客户端存成 `String?`，`DeviceAPI.act` 原样放进请求体；后端只接受 `string`（`device-api-routes.ts:1417`）。正常动作可以，`reconnect` 等无 command 的动作不行（2）。
   - `requestId`：客户端产生 base64url，后端要求 `MACHINE_STRING`，首字符可能不合法（1）。
   - `HomeActOutcome(message:nil, undo:nil)`：`HomeFeedModel` 能接受 nil，但成功提示/撤销永远不会出现（5）。
   - `DeviceAPI.homeFeed` 的 `GET home` + `locale`：服务端只允许 `zh-CN/en/ja`，客户端枚举一致；可用。
   - `HomeFeedSnapshot.decode` 裸 payload：和服务端 `result.payload` 一致；但生产走 `DeviceAPI.decode`，这个静态方法主要被测试使用（6）。
   - `today.actionFailed` / `today.presenceReason`：三种语言都加了，`L.text` 使用端能找到；可用。
   - `DesignTokens.Home.linkRowGap/linkRowTextGap/linkRowPaddingY/upcomingGap`：`tokens.json` 与生成的 Swift 文件一致，`TodayPage` 已引用；`tokens.css` 不包含 Home 组，未受影响。
   - `RootView.todayBadge` 的 `?? actions?.waitingCount`：类型上可用，但语义上受 `incompleteSources` 过宽影响（4）。
   - `HimawariShellTests` 测试目标：只影响测试，无生产使用端。
   - `HomeFeedModel.failed` / `available`：没有读取端，属于死状态（7）。
