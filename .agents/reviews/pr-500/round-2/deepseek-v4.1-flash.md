本轮复核范围：增量 `696679ff..9e70b055`（`180b8caa` 恢复未知状态页、`9e70b055` 截断/去重/文案），以及直接受影响的 `ServerValues.swift`、`AppModel.swift` 日志路径、`ServerValueTests`、`PairingProblem`/`PairingView`、三份 `Localizable.strings`、`Package.swift` 的 Linux/Apple 分层、`prompt-prefix.md` 与 I-73。旧代码只沿调用链跟读，未整份重读；`.agents/reviews` 在稀疏检出中被排除，未读上一轮结论。无法运行编译器，Mac 编译状态均为「未核实」。

总的说：**没有发现会改变模型请求、或造成锁数据竞争/死锁的阻断问题**。下面按严重度列出意见。

### 1. [中] 材料称“不改任何界面”、覆盖“6 个枚举”，增量却改了界面，代码里是 8 个枚举
文件:行：`clients/apple/Sources/HimawariShell/PairingView.swift:25,46,255-261`；`clients/apple/Sources/HimawariCore/ServerValues.swift:51-81`

问题：材料把本 PR 描述成只加日志、不动界面，但增量里的 `180b8caa` 恢复/新增了 `stateUnknown` 页面和“开始重来”未发送计数文案；材料也完全没提这个提交和新增的 `PairingProblemCoverageTests`。另外材料说 PR 468 覆盖“6 个”枚举，实际 `ServerValues.swift` 有 8 个 `LenientServerValue` 实现（含 `DeviceKind`、`ReleaseChannel`），测试也逐个测了 8 个。

证据（读代码证实）：`PairingView.swift:46` 有 `case let .unpaired(problem?) where problem == .keysUnreadable || problem == .storageUnavailable || problem == .stateUnknown:`，`255-261` 有 `case let count?: L.format("pairing.startOver.confirmUnsent", count)` 等新文案；`ServerValues.swift:51-81` 从 `ExecutionRecordKind` 到 `ReleaseChannel` 共 8 个 extension。材料还写“162 条”，而本次提交说明写的是 `swift test on Linux (165 passed)`。

建议：在材料里补上 `180b8caa` 的界面改动、对应测试和 Mac 验证情况；把枚举数改成 8，测试数以当前 HEAD 为准。若界面改动不属于 PR 500，应拆出或明确注明来源。补充一句：我对比了 `a33757cae` 的 `PairingView.swift`，恢复的内容与其一致（仅 `.hmCover`/`.fullScreenCover` 不同），所以这段本身不是新风险，问题是材料失真。

### 2. [中] `PairingProblemCoverageTests` 只守 `key`，恢复的页面路由和本地化键没有被守住
文件:行：`clients/apple/Tests/HimawariCoreTests/PairingProblemCoverageTests.swift:16-27`；`clients/apple/Sources/HimawariShell/PairingView.swift:46-53,62-65`

问题：测试只验证 `PairingView.key` 对每个 `PairingProblem` 有 `case`，但这次真正要恢复的是 `content` 里的 `.stateUnknown` 路由。如果 `:46` 的路由再次丢失而 `key` 还在，`stateUnknown` 会落进 `:62` 的 `problem != .removed` 通用分支，页面变成“重新扫描”，测试仍然通过。本地化键 `pairing.problem.stateUnknown` / `.title` 缺失时，测试也不会失败，界面会显示原始 key。

证据（读代码证实）：
```swift
let keyBody = view[keyStart.upperBound...].prefix(1200)
for name in cases {
    #expect(keyBody.contains("case .\(name)"), "PairingView.key has no case for .\(name)")
}
```
而 `PairingView.swift:62-65` 是：
```swift
case let .unpaired(problem?) where problem != .removed:
    problemPage(...) { scanButton(L.text("pairing.rescan")) }
```
`stateUnknown` 被 `:46` 接住时才会显示重试/重新配对，否则就落到这里。

建议：把“`PairingProblem` → 页面类型”的选择抽成 `HimawariCore` 里的纯函数，在 Linux 上直接测行为；至少让测试同时断言 `:46` 的条件包含 `.stateUnknown`，并校验三份 `Localizable.strings` 里 `pairing.problem.stateUnknown`、`pairing.problem.stateUnknown.title`、`pairing.startOver.confirm*` 都存在。合并前仍应在 Mac 上做一次完整构建，`-parse` 不覆盖类型检查和 SwiftUI 重载选择。

### 3. [低] 服务器给的未知值作为不可信输入被 `.public` 原样写入日志，没有去掉控制字符/换行
文件:行：`clients/apple/Sources/HimawariCore/ServerValues.swift:42-47`；`clients/apple/Sources/HimawariShell/AppModel.swift:51`

问题：未知值来自服务器，理论上可以是任意字符串；代码只按字符数截断，没有清洗控制字符或换行，随后用 `.public` 写进统一日志。即使它通常不是用户数据，也可能把换行/控制字符带进诊断日志，造成日志伪造或干扰。项目里对不可信的沙箱错误文本已有“去掉控制字符和换行”的先例（`docs/execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md:330`）。

证据（读代码证实）：
```swift
let raw = String(fullRaw.prefix(Self.rawLimit))
...
report?(UnknownServerValue(type: type, raw: raw))
```
```swift
logger.notice("unknown \(report.type, privacy: .public) from server: \(report.raw, privacy: .public); shown as its fallback value")
```
「OSLog 是否转义换行」是推测，未在本环境验证。

建议：在截断前先过滤换行/控制字符（并用过滤后的值做去重键），保留 64 字符上限；如果无法证明这些值一定不敏感，改成 `.private` 或只记录哈希/长度。

### 4. [低] 64 个去重上限是全局的，用满后进程内永久静默，也没有“已停止记录”的提示
文件:行：`clients/apple/Sources/HimawariCore/ServerValues.swift:26,44`

问题：目标是让开发者发现服务器在发新值；但上限跨全部 8 个类型共享。一旦某个类型先出现 64 个不同未知值，其他类型以后的新值也不会再被记录，而且日志里没有任何“已达上限、后续被抑制”的信号。这符合“数量要有上限”的约束，但与“能发现新值”的目标有张力。

证据（读代码证实）：
```swift
public static let distinctLimit = 64
...
guard let observer, seen.count < Self.distinctLimit, seen.insert(...).inserted else { return nil }
```
“开发者会因此漏掉后续值”是推测。

建议：改成按类型各自计数，或在第一次达到上限时额外写一条 `server-values suppressed after 64 distinct values` 的 notice；至少保留已报告总数，便于判断是否有值被吞掉。

### 5. [低] 每次 SwiftUI body 求值都同步读取并解码 outbox 文件来生成“开始重来”的提示
文件:行：`clients/apple/Sources/HimawariShell/PairingView.swift:25,255-260`；`clients/apple/Sources/HimawariShell/AppModel.swift:206-209`；`clients/apple/Sources/HimawariCore/Outbox.swift:37-40`

问题：`.confirmationDialog(startOverWarning, ...)` 的标题在每次 body 求值时都会计算，`startOverWarning` 又同步调用 `model.unsentMessages`，后者在主线程读取并 `JSONDecoder` 解码整个 `outbox.json`，即使对话框没弹出。outbox 很大时可能卡住配对页。

证据（读代码证实）：
```swift
.confirmationDialog(startOverWarning, isPresented: $confirmingStartOver, titleVisibility: .visible)
...
private var startOverWarning: String {
    switch model.unsentMessages { ... }
}
```
```swift
guard let local = try? store ?? FileLocalStore.applicationSupport(named: "himawari-device") else { return nil }
return Outbox.unsentCount(in: local)
```
```swift
guard let data = store.read(name), let items = try? JSONDecoder().decode([OutboxItem].self, from: data) else { return nil }
```
“实际卡顿程度”是推测。

建议：在用户点“开始重来”时再计算并缓存未发送数，或复用已经加载的 `Outbox` 状态，不要在每个 body 里读文件。

## 侧重检查

- **错误路径**：`decode(String.self)` 失败会直接抛出，走不到 `noteFallback`，仍保持原有“非字符串值整条解码失败”的行为（`ServerValues.swift:9`；测试 `ServerValueTests.swift:28-30`）。未发现问题。
- **无观察者路径**：`guard let observer` 在 `seen.insert` 之前短路，所以没有观察者时不会污染去重集；修改后的 `aLongValueIsCutAndWithoutAnObserverNothingHappens` 现在确实能验证这一点。未发现问题。
- **锁与死锁**：`seen` 和 `observer` 都在 `NSLock` 内读写，`report?` 在锁外调用，没有嵌套加锁，`logger.notice` 也不会回调诊断，未发现死锁/数据竞争。存在一个良性时序：线程读到旧 observer 后、调用前另一个线程 `observe(nil)`，本次仍可能投递；生产只在启动时设置且从不清除，测试串行执行，实际不受影响（这是推理，不是实测）。
- **不可信输入/安全**：长度有 `rawLimit`，数量有 `distinctLimit`，但控制字符/换行未清洗且用 `.public`，见意见 3。服务器值的类型（状态、角色、设备种类等）通常不是用户正文，但没有代码强制保证。
- **资源耗尽**：`seen` 最多 64 项，每项 key 约“类型名 + 64 字符”，有界；但去重前对每个未知值都做一次 `prefix(64)` 复制，达到上限后仍然执行，属于小开销。没有新增无界持久化。
- **不可撤销操作**：`startOver()` 仍只由 `PairingView.swift:25-27` 的确认对话框触发；新增提示会区分“有 N 条未发送”“未知”和“没有”，比原来更安全。未发现新的不可撤销入口。
- **规则/文档一致性**：`prompt-prefix.md` 约束的请求组装路径完全没被触碰；材料与代码不一致见意见 1；Mac 完整构建未做，属于未核实。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本改动只在 Apple 客户端解码服务器响应时增加本地日志和截断，`Self(rawValue:)` 失败后的回退值仍是原来的 `Self.fallback`，没有触达系统提示、工具定义、历史消息或遮盖结果；diff 里也没有请求组装相关文件。因此“只在末尾追加、每轮变化值放最后一条消息”的约束在这里不适用，因为根本没有改请求内容。依据：[prompt-prefix.md 第 4、10 条](../../.agents/instructions/prompt-prefix.md#rules)。

2. **不会让同一段文字在不同请求里变成不同字节。** 诊断的去重集合只做插入和计数，不遍历、不序列化进任何请求；日志输出顺序可能因解码线程不同而不同，但日志不是模型输入，也没有遮盖或历史写入路径被改。对模型请求字节而言仍是确定的、未变的。

3. **有自动检查，但覆盖不完整。** `ServerValueTests` 的 `longValuesSharingTheirFirstCharactersCountOnce` 是真正的反向用例：旧实现按完整值去重、按截断值报告，会报两条，改后只报一条；`atMostTheDistinctLimitOfValuesIsReported` 守 64 上限，但它在改前改后都通过，属于边界覆盖而非反向用例；修改后的 `aLongValueIsCutAndWithoutAnObserverNothingHappens` 现在能反向验证“无观察者时不记录”。`PairingProblemCoverageTests` 只守 `key`，不守页面路由和本地化键（见意见 2），所以原来的页面丢失若以“key 还在、路由丢了”的形式复发，测试不会失败。另：作者只对 `AppModel.swift`/`PairingView.swift` 做了 `swiftc -parse`，Mac 类型检查未核实。

4. **逐个核对了产生处和使用处，没有发现 I-73 式的两端不一致。** `rawLimit`（`ServerValues.swift:27`）只在 `:42` 和测试 `:168` 使用，两边都按 Swift `Character` 数理解；截断后的 `raw` 用于去重键 `:44`、`UnknownServerValue` `:47`、日志 `AppModel.swift:51` 和测试断言，均接受。`PairingProblem.stateUnknown` 由 `AppModel.swift:298` 产生，`PairingView.swift:46`、`AppModel.swift:231/248/372` 和 `PairingView.swift:273` 使用；`key` 生成的 `pairing.problem.stateUnknown`、`.title` 以及 `pairing.startOver.confirm`、`.confirmUnsent`、`.confirmUnknown` 在 `en`、`ja`、`zh-Hans` 三份字符串里都存在。`unsentMessages` 返回 `Int?`，`startOverWarning` 的 `0?`、`count?`、`nil` 三个分支都处理了。唯一需要改的是日志端对不可信值缺少清洗（意见 3），这不是“两端校验不一致”，而是使用端没有按不可信输入处理。
