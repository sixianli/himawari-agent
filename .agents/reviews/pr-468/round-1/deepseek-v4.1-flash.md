## 结论

改动的核心方向（遇到不认识的服务端枚举值时退回通用值）成立，但没有覆盖“未知 kind + 已知 phase”“未知设备状态被写进钥匙串”“测试没有跑在自动检查里”这几条关键路径。下面按严重度列，先写读代码证实的，再写推测/未核实。

## 发现（读代码证实）

### 1. 严重度：中 — 未知 `PairedDeviceStatus` 被当成 `.pending` 持久化，配对流会误以为“等待确认”

**文件:行**
- `clients/apple/Sources/HimawariCore/ServerValues.swift:34-35`
- `clients/apple/Sources/HimawariShell/AppModel.swift:52-58, 75-78, 164-172, 228-241`

**问题**
服务器给一个不认识的状态时，`PairedDeviceStatus` 退回 `.pending`。`AppModel` 把这个值当作真实状态写进钥匙串，并在配对响应和恢复时进入“等待主人在服务器确认”的轮询；配置请求成功后，`waitForConfirmation` 直接把记录改成 `.active` 并激活。服务器的新状态可能因此被伪装成 `pending`，甚至最终被本地标成 `active`；若新状态其实是 `revoked` 的变体，客户端还会继续保留凭据并轮询。

**证据**
```swift
// ServerValues.swift:34-35
extension PairedDeviceStatus: LenientServerValue {
    public static var fallback: PairedDeviceStatus { .pending }
}
```
```swift
// AppModel.swift:164-172
let record = PairingRecord(origin: invitation.origin, deviceId: device.id, access: invitation.access, status: device.status, pairingNumber: number)
try save(record)
use(record)
if device.status == .active {
    Haptics.shared.report(.pairingSucceeded)
    activate()
} else {
    phase = .waitingForConfirmation(number: number)
    waitForConfirmation()
}
```
```swift
// AppModel.swift:75-78
switch record.status {
case .pending:
    phase = .waitingForConfirmation(number: record.pairingNumber)
    waitForConfirmation()
```
```swift
// AppModel.swift:228-241
configuration = try await api.configuration()
try? save(record.map { var updated = $0; updated.status = .active; return updated })
Haptics.shared.report(.pairingSucceeded)
activate()
return
} catch let error as DeviceAPIError where error.isRevoked {
    forget(problem: .removed)
```
`record` 的读写正是钥匙串里的 JSON 编解码（`AppModel.swift:52-58`）。测试只断言了 `!= .active`：
```swift
// ServerValueTests.swift:59-61
@Test func aPairingWithANewDeviceStatusIsNotTakenAsConnected() throws {
    #expect(try decode(PairedDeviceStatus.self, #""suspended""#) != .active)
}
```
这个断言在退回 `.revoked` 时也会通过，而 `.revoked` 会走 `forget`，删掉钥匙和本地数据。

**建议**
不要把 fallback 当作真实状态写回持久化记录。至少给 `PairedDeviceStatus` 增加显式 `.unrecognized`（或保存原始字符串），让 `AppModel` 对未知状态走“无法确认/需要重新配对”的明确错误路径；测试应断言精确 fallback、钥匙串往返和 `AppModel` 的恢复分支。

### 2. 严重度：中 — 未知 `kind` + 已知 `phase` 仍会显示成进行中；未知 phase 非当前步骤时也可能继续转圈

**文件:行**
- `clients/apple/Sources/HimawariCore/Execution.swift:127-128, 154-164`
- `clients/apple/Sources/HimawariChat/ProcessRowView.swift:50-56`
- `clients/apple/Tests/HimawariCoreTests/ServerValueTests.swift:42-57`

**问题**
`ProcessStep` 只保留 `phase`，没有保留“这个 step 的 kind 是未知的”。因此：
- 未知 `kind`、但 `phase` 是 `.completed` 或 `.started` 时，`make` 仍返回 `.working`，视图只在 `phase == .unrecognized` 时不转圈，未知 `kind` 会继续 shimmer；
- 未知 `kind`、但 `phase == .waiting` 时，仍会被当成“等主人点头”的审批；
- 未知 `kind`、但 `phase == .failed` 时，会被当成失败；
- 未知 `phase` 如果出现在 `kind == .status` 的记录上，该记录不会被 `steps` 收录，`current` 会是上一条已知步骤，视图看不到 `.unrecognized`，仍可能让上一条步骤 shimmer。

现有测试同时把 `kind` 和 `phase` 都设成未知，且 `runStatus` 是 `completed`，没有覆盖最可能的“服务器新增一个 kind，但复用现有 phase”以及运行中的分支。

**证据**
```swift
// Execution.swift:127-128
icon: last.kind == .unrecognized ? .puzzle : ProcessIcon.chosen(last.activityIcon),
phase: last.phase,
```
```swift
// Execution.swift:159-164
guard let current = steps.last else { return .thinking }
let setback = steps.dropLast().last.flatMap { $0.phase == .failed || $0.phase == .unavailable ? $0 : nil }
if current.phase == .failed || current.phase == .unavailable {
    return .working(current: current, setback: nil)
}
return .working(current: current, setback: setback)
```
```swift
// ProcessRowView.swift:50-56
if current.phase == .failed || current.phase == .unavailable {
    ProcessLineLabel(icon: .alertCircle, text: current.title, tint: .hmMuted, shimmering: false)
} else if current.phase == .unrecognized {
    ProcessLineLabel(icon: .puzzle, text: current.title, tint: .hmMuted, shimmering: false)
} else {
    ProcessLineLabel(icon: Self.icon(current.icon), text: current.title, tint: .hmMuted, shimmering: true)
}
```
```swift
// ServerValueTests.swift:42-56
let json = #"[{"id":"r1","sequence":1,"itemId":"a","kind":"handoff","phase":"paused",...,"occurredAt":"2026-11-13T00:00:00Z"}]"#
...
guard case let .finished(finished, _) = ProcessLine.make(records: records, runStatus: "completed") else {
```
这里 `handoff` 和 `paused` 都未知，`paused` 退回 `.unrecognized`，所以没有测到“未知 kind + 已知 phase”。

**建议**
给 `ProcessStep` 增加类似 `kindIsUnknown` 的显示标志，视图和 `make` 用它决定不 shimmer、不自动当作审批；补测试：
- `kind` 未知 + `phase == .completed` + `runStatus == "running"`；
- `kind` 未知 + `phase == .waiting`；
- 已知 `kind` + 未知 `phase` + `runStatus == "running"`；
- 未知 `phase` 出现在 `kind == .status` 上时，上一条步骤不应继续显示为进行中。

### 3. 严重度：中 — 没有自动检查覆盖 UI 和 AppModel 路径，核心 Swift 测试也不在 CI

**文件:行**
- `.github/workflows/ci.yml:30-324`（作业只有 `policy/static/build/browser/coverage/security/required`，没有 Swift/Apple 作业）
- `clients/apple/Package.swift:21-24`
- `clients/apple/Sources/HimawariChat/ProcessRowView.swift:50-56, 132-133`

**问题**
改动的核心解码测试只在 `HimawariCoreTests`，没有接入仓库的自动检查；UI target 在 Linux 被完全排除，作者也只做了 `swiftc -parse`。`-parse` 只解析语法，不做类型检查，也没有覆盖视图分支、`AppModel` 的钥匙串往返还回、未知设备状态的恢复行为。因此这次最容易出错的两条路径（视图显示和配对恢复）没有自动反向用例。

**证据**
```swift
// Package.swift:21-24
#if os(Linux)
let interfaceTargets: [Target] = []
let interfaceProducts: [Product] = []
#else
```
`HimawariChat` 只在非 Linux 构建。`ProcessRowView` 的新分支没有任何测试引用。

**建议**
至少把 `HimawariCoreTests` 纳入可重复的检查命令；把不依赖 SwiftUI 的状态判断（`ProcessLine.make`、`AppModel` 的状态机）放到可测的 core 或 view-model 层；在 Mac 上跑一次 Xcode 测试并把命令写进文档或脚本。视图分支可通过 view-model 的布尔值测试覆盖，不必依赖 UI 测试。

### 4. 严重度：低 — `MessageRole` 退回 `.system` 会影响会话列表摘要和过程行位置

**文件:行**
- `clients/apple/Sources/HimawariCore/ServerValues.swift:26-27`
- `clients/apple/Sources/HimawariChat/ChatStore.swift:155-158, 220-233`
- `clients/apple/Sources/HimawariChat/ChatView.swift:165-186`

**问题**
未知角色被当成 `.system`，不是中性的“未知”：`lastMessageText` 会跳过所有 `.system`，未知角色的最后一条消息不会出现在会话列表摘要；`transcript` 只有 `role == .agent` 才把 run 的过程行插在消息前，未知角色会被排到末尾；界面还会用 system 的 caption 样式显示。若服务器以后新增一种 assistant/tool 角色，会出现摘要缺失、过程行位置错误。

**证据**
```swift
// ChatStore.swift:155-158
guard let last = details[threadId]?.messages.last(where: { $0.role != .system }) else { return nil }
return texts[last.contentRef]
```
```swift
// ChatStore.swift:225-230
if message.role == .agent, let runId = message.runId, !shown.contains(runId), ... {
    shown.insert(runId)
    items.append(.process(runId: runId))
}
items.append(.message(message))
```
```swift
// ChatView.swift:181-185
case .system:
    Text(text ?? "")
        .hmType(DesignTokens.TypeScale.caption)
        .foregroundStyle(Color.hmMuted)
```

**建议**
增加显式的未知角色，或把“是否参与摘要/是否是 agent 消息”从角色枚举中独立出来；不要用 `.system` 承担“未知”的语义。

### 5. 严重度：低 — “新种类/新状态通用显示”的覆盖范围不完整

**文件:行**
- `clients/apple/Sources/HimawariCore/Models.swift:3-14, 22-30`
- `clients/apple/Sources/HimawariCore/Models.swift:98-102`
- `clients/apple/Sources/HimawariCore/Execution.swift:97, 147-153`
- `clients/apple/Sources/HimawariChat/ChatStore.swift:202, 232`

**问题**
`DeviceKind` 和 `ReleaseChannel` 仍是严格的 `String` 枚举，服务器新增设备种类或发布渠道时，`PairedDeviceInfo` 仍会整条解码失败，配对会失败。另一个相关缺口是 `ThreadRunSummary.status` 虽然是 `String`，但终态集合只认 `completed/failed/cancelled`；服务器新增终态时，客户端会继续显示过程行/流式回答，甚至一直转圈。作者的说法是“几个状态值”，但产品原则的覆盖面其实更大。

**证据**
```swift
// Models.swift:3-14
public enum DeviceKind: String, Codable, Sendable { case iphone; case watch; case mac }
public enum ReleaseChannel: String, Codable, Sendable, CaseIterable { ... }
```
```swift
// Models.swift:98-102
public struct ThreadRunSummary: Codable, Sendable, Equatable {
    public let runId: String
    public let revision: Int
    public let status: String
}
```
```swift
// Execution.swift:97
public static let terminalRunStatuses: Set<String> = ["completed", "failed", "cancelled"]
```

**建议**
明确这次改动的范围；对不参与客户端决策的字段（如设备种类、发布渠道）做宽松解码或增加未知 case；对 run status 要么让服务器提供明确的终态标志，要么定义未知状态下的保守显示，并补测试。

### 6. 严重度：低 — 未知值被静默替换，没有任何诊断

**文件:行**
- `clients/apple/Sources/HimawariCore/ServerValues.swift:7-12`

**问题**
`Self(rawValue: raw) ?? Self.fallback` 会把未知值完全吞掉，不记录日志、计数或诊断。服务端和客户端契约漂移时，客户端看起来“正常”，实际已经丢失了信息；排查时无法区分是服务器加了新值、客户端映射错了，还是服务器发了脏数据。非字符串类型仍会抛错（这是好的），但未知字符串不会。

**证据**
```swift
self = Self(rawValue: raw) ?? Self.fallback
```

**建议**
在 DEBUG 或诊断日志里记录“哪个枚举、收到什么原始值、退回到什么”（这些枚举名不是敏感信息），或至少计数上报；不要影响用户界面。

## 推测与未核实

- **iOS 上协议扩展是否真的取代编译器合成的 `init(from:)`：未核实。** 作者说 Linux `swift test` 通过，说明在 Linux 工具链上扩展实现生效；同一 Swift 语言规则通常也适用于 iOS，但我没有在 iOS/Xcode 工具链上验证。`swiftc -parse` 不做类型检查，不能证明这一点。若要彻底消除重载选择风险，可以让这些类型只通过 `LenientServerValue` 声明 `Codable`，或在每个 enum 内直接实现 `init(from:)`。
- **作者说“Linux `swift test` 103 条全过”：未复现。** 受工具限制不能运行 `swift test`。
- **服务器未知状态的实际语义：未核实。** 当前服务器契约只有已知值（`thread-contracts-v3.ts:591-592` 的 kind 只有 message/tool/status，`contracts-v2.ts:513` 的设备状态只有 pending/active/revoked），未知值只是为将来做的防御。
- **UI 分支的实际运行结果：未核实。** `ProcessRowView` 所在 target 在 Linux 不编译，作者只做了 `-parse`。

## 侧重检查

- **错误路径/不合规范输入**：非字符串值（数字、null、对象）仍会抛错，`ServerValueTests.swift:26-28` 覆盖了这一反向用例，这是好的。未知字符串则静默退回，没有诊断。
- **安全/授权**：服务端契约写明只有 `active` 设备能通过验签（设计文档 `2026-11-11-apple-device-body-design.md:734`），所以客户端把未知设备状态退回 `.pending` 不会直接绕过服务端授权。但它会让客户端保留凭据、继续轮询，并可能在配置成功后本地标成 `active`；这是本地状态误表示，不是服务端鉴权漏洞。
- **不可撤销操作**：当前的 `.pending` fallback 不会触发删除；但如果有人把 fallback 改成 `.revoked`，`AppModel` 会走 `forget`，删除钥匙和本地数据，而现有测试 `!= .active` 不会拦住这种改动。
- **资源耗尽**：解码路径没有新增无界循环或额外大分配；`executionRecords` 的页数上限仍是 100。唯一会被这次 fallback 拉长的是 `AppModel.waitForConfirmation` 的轮询循环（指数退避到 10 秒），未知状态被当成 pending 时会继续轮询。
- **规则/文档一致性**：`prompt-prefix` 规则不适用于这个改动（客户端不组装模型请求）。设计文档第 17 节要求“每个新出现的值写明产生处、使用处、两端校验、自动检查”，这次新增的 `.unrecognized` 与六个 fallback 没有对应的清单检查；服务端契约也不接受 `unrecognized`（`thread-contracts-v3.ts:591-592`），目前没有出站路径所以不会发出去，但将来复用 `ExecutionRecord` 编码时会撞上。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 改动只涉及 iOS 客户端的解码和过程显示；`clients/apple` 里没有系统提示、工具定义、历史消息或出口遮盖的组装代码。`DeviceAPI.send` 只把用户消息等字段 POST 给设备接口（`DeviceAPI.swift:182-188`）。因此本改动没有在模型请求里追加、重排或改写任何内容，也没有引入每轮会变化的值。发给模型的内容仍然只在末尾追加，每轮会变的值仍在最后一条消息里；这次改动与那套服务端组装逻辑没有交集。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**对模型请求：不会。** fallback 只由该字段的原始字符串决定，不依赖前后文、时间、路径或集合遍历顺序，是确定性的纯函数。

**对本地序列化：会，且是有损的。** 未知值被替换成 fallback 后再写回本地缓存/钥匙串（`ChatStore.swift` 的 `ThreadCache` 保存、`AppModel.swift:56-58` 的钥匙串保存），所以同一服务器字符串在本地存成的是 `active`、`pending`、`system` 等，而不是原值；不同的未知值会合并成同一个字节。这不会影响发给模型的字节，但属于持久化往返的信息丢失，尤其 `PairedDeviceStatus` 会改变后续行为。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**部分有，反向覆盖不完整。**

- 有效：`ServerValueTests.swift:10-17` 如果撤掉 `LenientServerValue` 扩展，未知值会抛错，测试会失败；`26-28` 的反向用例能防止“所有错误都退回”；`42-56` 如果撤掉 `ProcessLine.steps` 对 `.unrecognized` 的收录，`steps.count == 1` 会失败。
- 不足：`42-56` 只测 `runStatus == "completed"`，没有测运行中、未知 kind + 已知 phase、未知 kind + `.waiting`；`59-60` 的配对用例只断言 `!= .active`，换成 `.revoked` 也会通过；没有 `AppModel`/钥匙串往返测试；`ProcessRowView` 的新分支没有测试，而且 Linux 不编译 UI，`swiftc -parse` 不做类型检查。
- 这些测试没有接入仓库 CI：`.github/workflows/ci.yml` 没有 Swift/Apple 作业，作者说的 103 条通过未在此环境复现。

### 4. 每个产生或修改的值，使用它的地方都能接受吗？

- **`LenientServerValue` / `fallback`**：定义在 `ServerValues.swift:3-12`，被六个枚举和测试使用，没有发现其它消费方；接口本身可接受。
- **`ExecutionRecordKind.unrecognized`**：由解码产生；使用处是 `Execution.swift:103`（收录为 step）、`:127`（图标 `.puzzle`）、`:155`（等待时按 `itemId` 找 step），均已更新。没有发现出站编码路径；服务端 kind 契约不接受 `unrecognized`（`thread-contracts-v3.ts:591`），将来若把 `ExecutionRecord` 发回服务器会不兼容。
- **`ExecutionPhase.unrecognized`**：由解码产生；使用处是 `Execution.swift:154-164`、`ProcessRowView.swift:50-56`、`:132-133`。它不会被当成 `.waiting` 或 `.failed`，但仍会以 `.working` 形式返回；视图只在“当前步骤的 phase 是 unrecognized”时不转圈，未知 phase 落在非 step 记录上时仍可能让上一条步骤 shimmer。部分可接受，见发现 2。
- **`ThreadStatus.active`**：由解码产生；当前只在 `ThreadSummary`、缓存和测试中使用，没有发现基于 thread status 的 UI 或请求分支（`ChatListView` 不过滤状态）。可以使用，但把未知状态折叠成 `active` 是有损的，语义上不够中性。
- **`MessageRole.system`**：由解码产生；使用处是 `ChatView.MessageRow` 的 `.system` 分支、`ChatStore.lastMessageText` 的 `role != .system` 过滤、`ChatStore.transcript` 的 `role == .agent` 判断。不能完全接受：未知角色的消息会被排除在列表摘要之外，过程行也可能排错位置。
- **`MessageStatus.committed`**：由解码产生；消费方只有 `ChatView.swift:110` 的 `message.status == .failed`。可以使用，但未知状态会被显示成已提交，可能误表示终态。
- **`PairedDeviceStatus.pending`**：由解码产生；消费方是 `AppModel.swift:75-78`、`:164-172`、`:228-241`，并会被写进钥匙串（`:52-58`）。不能接受，见发现 1。
- **新 raw value `unrecognized` 及 fallback 值的序列化**：目前只出现在本地内存/缓存/钥匙串，没有发现发给服务器的路径；但服务端契约不接受这些值，若以后复用编码需要重新核对两端。
