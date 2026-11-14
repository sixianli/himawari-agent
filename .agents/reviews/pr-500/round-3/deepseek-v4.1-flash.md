这一轮查过：增量 `9e70b055..f3e9b298`（代码只有 `clients/apple/Tests/HimawariCoreTests/PairingProblemCoverageTests.swift` 的 14 行，其余是复核记录），并回看它直接影响的 `PairingView.swift`；也核对了全量 `e4459751..f3e9b298` 中的 `ServerValues.swift`、`AppModel.swift`、`PairingView.swift`、`ServerValueTests.swift`、`PairingProblemCoverageTests.swift`，以及 `Package.swift`、`Strings.swift`、三份 `Localizable.strings`、`PairingRecord.swift`、`Models.swift`、`Execution.swift`、入口 `RootView.swift` / `MacAppDelegate.swift`、规则 `prompt-prefix.md` 和 I-73。未核实：实际运行 `swift test`、Mac 编译、作者所说的测试条数；工具限制不能运行非 git 命令。

### 1. 中：未知服务器值原样以 `.public` 写入系统日志，且“64 个字符”不是字节上限

文件: `clients/apple/Sources/HimawariShell/AppModel.swift:50-52`、`clients/apple/Sources/HimawariCore/ServerValues.swift:41-44`

问题：`raw` 是从服务器 JSON 解出的任意字符串，不是经过校验的枚举值；代码把它以 `.public` 写进统一日志，只按 Swift `Character` 截 64 个，没有去掉换行/控制字符，也没有按 UTF-8 字节限长。作者“不是用户数据”的说法没有被代码保证。

证据（读代码证实）：

```swift
logger.notice("unknown \(report.type, privacy: .public) from server: \(report.raw, privacy: .public); shown as its fallback value")
```

```swift
let raw = String(fullRaw.prefix(Self.rawLimit))
```

推测：如果服务器把用户内容塞进这些字段，或发送带换行、控制字符的字符串，内容会进入系统日志并可能伪造日志行；一个由大量组合字符组成的 `Character` 可以远超 64 字节，所以日志长度和去重键大小并没有真正的字节上限。系统日志的访问面有限，这不是远程代码执行级别的问题。

建议：记录前去掉 `\n`、`\r` 和控制字符，按 UTF-8 字节截断（例如 256 字节），并明确选择 `.public` 只用于类型、值默认 `.private` 或只在 Debug 公开；同时把“值可能含用户数据”的取舍写进说明。

### 2. 低：增量测试没有真正守住 `startOverWarning` 的接线和 `%d`

文件: `clients/apple/Tests/HimawariCoreTests/PairingProblemCoverageTests.swift:30-42`、`clients/apple/Sources/HimawariShell/PairingView.swift:25,255-261`

问题：新增测试只检查路由那一行含 `.stateUnknown`，以及三份翻译文件里有这些键。若把 `PairingView` 第 25 行改回旧的 `L.text("pairing.startOver.confirm")`，或删掉 `startOverWarning`，测试仍然通过，因为三个 `pairing.startOver.*` 键还在。测试也没有检查 `confirmUnsent` 的值是否仍含 `%d`。

证据（读代码证实）：

```swift
let route = try #require(view.range(of: "case let .unpaired(problem?) where problem == .keysUnreadable"))
let routeLine = view[route.lowerBound...].prefix { $0 != "\n" }
#expect(routeLine.contains("problem == .stateUnknown"), ...)
...
for key in ["pairing.problem.stateUnknown", ..., "pairing.startOver.confirmUnsent", ...] {
    #expect(strings.contains("\"\(key)\" ="), ...)
}
```

而实际使用处是：

```swift
.confirmationDialog(startOverWarning, isPresented: $confirmingStartOver, titleVisibility: .visible)
```

建议：至少断言源码里 `confirmationDialog(startOverWarning` 仍存在，并断言三份 `confirmUnsent` 都含 `%d`；更稳妥的是把 `PairingProblem` 到本地化键的映射移到 `HimawariCore`，用真正的 Swift 单测覆盖，而不是 grep 源文件。

### 3. 低：Apple 专属代码没有编译证据，源码文本测试也无法替代编译

文件: `clients/apple/Tests/HimawariCoreTests/PairingProblemCoverageTests.swift:30-34`、`clients/apple/Package.swift:21-23`、`clients/apple/Sources/HimawariShell/AppModel.swift:47-54`

问题：Linux 上 `interfaceTargets` 为空，`HimawariShell` 根本不编译；新测试只是读源码文本，格式一换就可能误报（例如路由条件换行），也完全不能发现 `AppModel.swift` 里 `Logger` 写法的类型错误。作者自述 `AppModel.swift` 只做了 `swiftc -parse`，没有在 Mac 上编译。

证据（读代码证实）：

```swift
#if os(Linux)
let interfaceTargets: [Target] = []
```

测试侧：

```swift
let route = try #require(view.range(of: "case let .unpaired(problem?) where problem == .keysUnreadable"))
```

推测：这次改动涉及的 `Logger` / `os` 代码很可能能编译，但“很可能”不是证据；仓库此前已经发生过合并把 `PairingView` 的 switch 弄成非穷尽、Linux 完全没发现的情况。

建议：在 Mac 上至少跑一次 `swift build`/Xcode 编译并留下结果；CI 若有 Mac runner，加 Apple 目标的编译门。测试上把纯逻辑（问题类型到键）移入 Linux 可编译的 `HimawariCore`，或改为结构化检查/生成清单，减少对源码字面格式的依赖。

### 4. 低：进程级一次性 64 个上限、截断后再去重，会让“每个不同值报一次”不成立

文件: `clients/apple/Sources/HimawariCore/ServerValues.swift:26-27,41-47`、`clients/apple/Tests/HimawariCoreTests/ServerValueTests.swift:163-180`

问题：`seen` 是全局集合，累计满 64 个 `(type, raw)` 后，后续所有未知值永远不再记录；如果服务器早期发来 64 个未知值，后续真正需要发现的新值会被静默吞掉。另一方面，先截断到 64 个字符再去重，两个仅在后半段不同的长值会被当成同一个值，只报一次。

证据（读代码证实）：

```swift
guard let observer, seen.count < Self.distinctLimit, seen.insert("\(type)\u{0}\(raw)").inserted else { return nil }
```

测试也固化了这个行为：

```swift
let head = "zz-diag-same-" + String(repeating: "y", count: ServerValueDiagnostics.rawLimit)
_ = try decode([ThreadStatus].self, "[\"\(head)a\",\"\(head)b\"]")
#expect(reports.all.filter { $0.raw.hasPrefix("zz-diag-same-") }.count == 1)
```

建议：这是有意的取舍，但应在说明里写清“只保证进程生命周期前 64 个不同前缀”；若要更准确，可按类型分配上限、在去重键里加入完整值的哈希，或在观察者安装/重新配对时重置预算。

### 5. 低：作者材料与代码有多处不一致

文件: `clients/apple/Sources/HimawariCore/ServerValues.swift:51-81`、`clients/apple/Sources/HimawariShell/PairingView.swift:25,46,255-261`、`git diff --stat e4459751..f3e9b298`

问题：材料里的几处说法与代码/提交不符，容易误导复核范围。

证据（读代码证实）：

- 材料说“6 个从服务器读的 String 枚举”，但 `ServerValues.swift` 有 8 个 `LenientServerValue` conformance：`ExecutionRecordKind`、`ExecutionPhase`、`ThreadStatus`、`MessageRole`、`MessageStatus`、`PairedDeviceStatus`、`DeviceKind`、`ReleaseChannel`（51-81 行）。
- 材料说“不改任何界面”，但全量 diff 里 `PairingView.swift` 有 13 行改动：`stateUnknown` 路由、`startOverWarning`、`key` 新分支。即使这是恢复合并丢失的内容，相对基准确实改了界面。
- “新增两条用例”与最终代码不符：`ServerValueTests` 新增了 4 条诊断用例，另有 1 条覆盖测试；提交信息里的通过数也出现了 162、163、165 三种。
- 材料说退回“一个通用值”，但 `ThreadStatus` 退回 `.active`、`MessageRole` 退回 `.agent`、`MessageStatus` 退回 `.committed`，这些是正常值，不是 `unrecognized` 一类的通用值。

建议：更正 PR 说明；把“恢复合并中丢失的 UI”单独列为一项并补充 Mac 编译/界面证据；按类型写清 fallback，避免读者以为未知状态都会显示成“未知”。

**侧重检查**

- 错误路径与并发：`noteFallback` 在锁内判断并取出观察者，锁外调用；`observe`/`reset` 也走同一把锁。读代码未发现死锁或对 `seen`/`observer` 的数据竞争。已看到一个语义边界：若 `noteFallback` 已取出非空观察者、随后另一个线程 `observe(nil)`，回调仍可能执行一次；生产只安装不卸载，测试串行执行，当前不构成实际问题。观察者是“最后设置者生效”，不累积、不持有 `AppModel`，只持有 `Logger`，没有明显泄漏。
- 不合规范/不可信输入：未知值来自服务器 JSON，属于未校验输入；公开日志和按 `Character` 截断是实际风险，见意见 1。日志类型名来自 `String(describing: Self.self)`，当前与测试写死的 `"ThreadStatus"`/`"MessageRole"` 一致。
- 安全：没有新增网络请求、密钥处理或持久化；主要安全面是统一日志里的服务器可控文本。
- 资源耗尽：`seen` 最多 64 个键，键由类型名加最多 64 个 `Character` 组成，数量有界；但单个 `Character` 可能很大，字节数没有硬上限。每个未知值仍会取一次全局锁，量级不大。
- 不可撤销操作：`model.startOver()` 的删除路径没有被这次增量改动；`PairingView` 只是恢复了未发送消息提示的确认文案，没有新增不可撤销动作。
- 规则与文档一致性：`prompt-prefix.md` 的“已发内容只追加”没有被触碰；按 I-73 核对了 `stateUnknown` 键的生成端（`PairingView.key`）和使用端（`problemPage`/`detail`）、`startOverWarning` 的 `Int?` 到三份本地化文案，键都存在，三份 `confirmUnsent` 都含 `%d`，`L.format` 接受 `Int`。不一致之处见意见 5。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。依据 [发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)：这次 diff 只改 Apple 客户端的本地解码诊断和配对界面，不组装系统提示、工具定义、历史或遮盖；`ServerValueDiagnostics` 的 `type`/`raw` 只进本地日志，不进入任何请求；`PairingView` 的 `unsentMessages` 只影响本地确认框。客户端发给服务器的消息内容没有被改动，因此请求仍然只在末尾追加，每轮会变的值也不在系统提示/工具定义里。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会。请求内容没有变化；解码后的 fallback 值仍和基准一样，日志不影响请求。就日志本身而言，给定 `raw` 的截断结果是确定的，但并发下日志顺序、以及第 64 个名额由哪些值占据会不确定；这不进入模型请求，不影响字节级缓存。

3. **有没有自动检查，反向用例会不会真的失败？** 诊断逻辑有测试：已知值不报、重复值只报一次、长值截断、无观察者不产生记录、长前缀只算一次、最多 64 个；按静态阅读，去掉去重、截断、上限、观察者判断时对应用例会失败。UI 侧新增测试在删除 `stateUnknown` 路由或某个翻译键时会失败；但把 `startOverWarning` 从确认框拿掉、或去掉 `%d`，它不会失败。更关键的是 Linux 不编译 `HimawariShell`/`AppModel`，作者也没有提供 Mac 编译结果，所以 Apple 侧没有真正的编译自动检查。以上未实际运行。

4. **每个产生/修改的值，使用端都能接受吗？** 逐项核对：`UnknownServerValue.type/raw` 只用于日志和测试，没有后端校验，使用端接受任意字符串；`stateUnknown` 经 `PairingView.key` 生成 `pairing.problem.stateUnknown` 与 `.title`，三份 `Localizable.strings` 都有（41-42 行）；`startOverWarning` 把 `unsentMessages: Int?` 交给 `L.format`，三份 `confirmUnsent` 都有 `%d`（45-47 行），`L.format` 位于 `Strings.swift:8-10`，接受 `Int` 这类 `CVarArg`；Logger 的 subsystem/category 只被 `Logger` 使用，没有其他清单校验。没有发现某个键只在产生端存在、使用端缺失的情况。唯一需要额外注意的是：`raw` 是未校验的服务器字符串，日志端不做清洗，见意见 1。
