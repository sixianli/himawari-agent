### 1. 高 — `seen` 保存的是未截断的服务器字符串，64 条上限只限制条数、不限制字节

- 文件:行：`clients/apple/Sources/HimawariCore/ServerValues.swift:42`、`:45`
- 问题：去重键用完整 `raw` 拼接，`seen` 因而长期保留服务器给的原始长字符串；截断只发生在写日志时。服务器发来超长或不规范的值时，进程可被占住最多 64 条任意长度的字符串，且同一超长值每次出现都要在全局锁内重新哈希一遍。这与“值要截断”的约束不符，也是典型的服务器可控资源消耗。
- 证据（读代码证实）：
  ```swift
  // ServerValues.swift:42
  guard let observer, seen.count < Self.distinctLimit, seen.insert("\(type)\u{0}\(raw)").inserted else { return nil }
  // ServerValues.swift:45
  report?(UnknownServerValue(type: type, raw: String(raw.prefix(64))))
  ```
  客户端普通请求没有响应体大小上限，`URLSessionExchange.send` 直接用 `session.data(for:)` 缓冲整个响应（`HTTPExchange.swift:33-36`），所以字段长度不能假定受契约限制。
- 推测：64 条 × 单字段长度可达数百 MB 的常驻内存；重复值还会让每一次解码都做 O(长度) 的字符串复制和哈希，且发生在锁内，可能拖慢其它解码线程。另有一个两端不一致：两个前 64 字符相同但更长的不同值会被算作两个，却打出两行完全相同的日志。
- 建议：在进锁前先截断或求固定长度摘要，并用同一个值同时做去重键和日志内容，例如 `let key = String(raw.prefix(64))`，`seen.insert(key)`、报告也用 `key`；若要坚持“完整值不同才算不同”，用 SHA-256 之类的定长摘要做键，不要保留原文。哈希和截断都放在锁外。

### 2. 中 — 64 条预算被所有类型共享且永不释放，单一类型就能把诊断能力耗光

- 文件:行：`clients/apple/Sources/HimawariCore/ServerValues.swift:26`、`:29`、`:42`
- 问题：`distinctLimit` 是全局共享的，任一类型（或恶意/出错的服务器）先发 64 个不同的未知值，就会永久占满预算；此后其它 7 个枚举再出现新值也不会报告，正好违背“让开发者发现服务器在发 App 不认识的值”的目标。
- 证据（读代码证实）：
  ```swift
  public static let distinctLimit = 64
  private var seen = Set<String>()
  guard let observer, seen.count < Self.distinctLimit, seen.insert(...).inserted else { return nil }
  ```
  `reset()` 只在测试里调用，生产没有过期或释放机制。
- 推测：这不是崩溃级问题，但会让诊断在长期运行的真实 App 里静默失效。
- 建议：按类型分别计数或给每个类型保留配额；预算用尽时至少打一条“后续未知值不再报告”的日志；或对 `seen` 做过期/轮换。把这一策略写进注释和测试。

### 3. 中 — 新测试没有覆盖 64 条上限，“无观察者时无副作用”这条实际上没有验证

- 文件:行：`clients/apple/Tests/HimawariCoreTests/ServerValueTests.swift:150-160`
- 问题：第二条用例先用 `observe(nil)` 解码 `zz-diag-silent`，然后 `reset()` 清空 `seen`，再装观察者解码同一个值并期待它被报告。中间这一步 `reset()` 恰好把“无观察者时是否错误地记入 `seen`”的证据抹掉了，所以即使实现违反了“没有观察者时不记录”，用例仍会通过。此外没有任何用例覆盖第 65 个不同值不被报告。
- 证据（读代码证实）：
  ```swift
  ServerValueDiagnostics.shared.observe(nil)
  _ = try decode([ThreadStatus].self, #"["zz-diag-silent"]"#)
  ServerValueDiagnostics.shared.reset()
  ServerValueDiagnostics.shared.observe { reports.add($0) }
  ...
  #expect(reports.all.contains { $0.raw == "zz-diag-silent" })
  ```
- 建议：删掉第 154 行的 `reset()`，让用例真正验证“无观察者时没有写入记录，装上观察者后同一个值仍会被报告”；再加一条连续发送 65 个不同未知值的用例，断言只收到 64 条；如果有条件，再覆盖“前 64 字符相同的两个长值”行为。

### 4. 中 — 服务器可控字符串以 `.public` 写入系统日志，未做控制字符清洗，存在日志注入/信息泄露面

- 文件:行：`clients/apple/Sources/HimawariShell/AppModel.swift:49-52`；`clients/apple/Sources/HimawariCore/ServerValues.swift:9`
- 问题：`raw` 只是从 JSON 解出的任意 `String`，代码没有验证它一定是枚举词；以 `.public` 写入统一日志后，恶意或异常服务器可以把换行、控制字符、甚至本不该记录的数据放进 `status`/`role` 字段。作者“不是用户数据”的判断依赖服务器契约，客户端代码并不保证。
- 证据（读代码证实）：
  ```swift
  logger.notice("unknown \(report.type, privacy: .public) from server: \(report.raw, privacy: .public); shown the general way")
  ...
  let raw = try decoder.singleValueContainer().decode(String.self)
  ```
- 推测：可伪造日志行、污染日志查看器；如果服务器错误地把敏感内容塞进枚举字段，会以明文进入 sysdiagnose。
- 建议：`type` 保持 `.public`，值改为 `.private`；或者只记录清洗后的可打印 ASCII（去掉换行/控制字符）并把长度控制在 64 内，同时保留长度或摘要用于排查。

### 5. 低 — Apple-only 的日志挂接没有在 Mac/Xcode 编译过，Linux 的 `swiftc -parse` 无法验证 `canImport(os)` 分支

- 文件:行：`clients/apple/Sources/HimawariShell/AppModel.swift:47-54`；`.agents/instructions/test-and-production-hosts.md:9`；`clients/apple/Package.swift:21-23`
- 问题：`HimawariShell` 在 Linux 上根本不参与构建（`#if os(Linux)` 下界面目标为空），`swiftc -parse` 只做语法解析，不检查 `#if canImport(os)` 里的 `Logger` API、`@Sendable` 捕获和 actor 隔离。也就是说，新增的正式日志路径实际上没有被类型检查过。
- 证据（读代码证实）：`Package.swift:21-23` 在 Linux 下列出空的 `interfaceTargets`，`AppModel.swift` 的 `Logger` 调用位于 `#if canImport(os)` 内。按仓库规则，苹果客户端的构建和单元测试应在 Andy 的 Mac 上用 Xcode 做。
- 推测：我逐行阅读未发现明显编译错误（`Logger` 是 `Sendable`，闭包在锁外调用），但“能否编译”仍未核实。
- 建议：在 Mac/Xcode 上编译一次 `HimawariShell`；如果 Mac 验证仍被推迟，至少把日志适配器做成平台无关的小类型并在 Linux 的 `HimawariCore` 测试里覆盖其格式，而不要只依赖 `swiftc -parse`。

### 6. 低 — 材料说“6 个枚举”、日志说“shown the general way”，都与实际代码不符

- 文件:行：`clients/apple/Sources/HimawariCore/ServerValues.swift:49-79`、`:57-67`
- 问题：代码实际有 8 个 `LenientServerValue` 扩展，不是材料说的 6 个（`DeviceKind`、`ReleaseChannel` 也会从服务器的 `PairedDeviceInfo` 解码，见 `Models.swift:25-33`）。另外日志说退回“通用值”，但 `ThreadStatus` 退回 `.active`、`MessageRole` 退回 `.agent`、`MessageStatus` 退回 `.committed`，都不是通用值。
- 证据（读代码证实）：
  ```swift
  extension ThreadStatus: LenientServerValue { public static var fallback: ThreadStatus { .active } }
  extension MessageRole: LenientServerValue { public static var fallback: MessageRole { .agent } }
  extension MessageStatus: LenientServerValue { public static var fallback: MessageStatus { .committed } }
  ```
  其后还有 `PairedDeviceStatus`、`DeviceKind`、`ReleaseChannel`，加上 `ExecutionRecordKind`、`ExecutionPhase`，共 8 个。
- 建议：把材料改成 8 个；日志文案改成“按退回落值显示”或按类型说明，不要写成统一的“general way”。另外“from server”也会在解码本地 keychain/cache 时触发（`AppModel.swift:68`、`HimawariChat/ThreadCache.swift:15`），文案最好改成“unknown value”而不是断言来源。

### 7. 低 — 观察者只有一个槽，后设置会静默覆盖先设置；`reset()` 也不清观察者

- 文件:行：`clients/apple/Sources/HimawariCore/ServerValues.swift:28-38`；`clients/apple/Sources/HimawariShell/AppModel.swift:50`
- 问题：`observe` 直接覆盖 `observer`。若同一进程里创建多个 `AppModel`（多窗口、预览、扩展）或测试套件各自装观察者，只有最后一个生效，先前的不再收到日志且没有任何提示；`reset()` 名为重置却只清 `seen`，语义容易误用。
- 证据（读代码证实）：
  ```swift
  private var observer: (@Sendable (UnknownServerValue) -> Void)?
  public func observe(_ observer: (@Sendable (UnknownServerValue) -> Void)?) {
      lock.withLock { self.observer = observer }
  }
  public func reset() { lock.withLock { seen.removeAll() } }
  ```
  当前生产入口只有 `RootView` 和 `MacAppDelegate` 各建一个 `AppModel`，所以暂时不会触发。
- 建议：改成多观察者（例如 `[UUID: closure]`）或明确文档说明单槽、后设覆盖；把 `reset()` 改名为 `resetSeen()`，或让它同时清观察者并写清语义。

## 侧重检查

- **服务器不可信输入**：`LenientServerValue.init(from:)` 对 `raw` 不做长度或字符校验就交给诊断；已报告问题 1、4。普通 HTTP 响应体没有客户端大小上限，问题 1 的资源消耗成立。
- **并发与锁**：`seen`、`observer` 的读写都在 `NSLock` 内；观察者在锁外调用，观察者若回调 `observe`/`reset` 不会死锁。`@unchecked Sendable` 在这里有锁兜底，未发现数据竞争。观察者被同步调用在解码线程上，若未来观察者阻塞会拖慢解码，但当前实现只写 `os.Logger`。
- **资源耗尽**：条数有 64 上限，但字节数不受限且从不释放；见问题 1。预算可被单一类型耗尽；见问题 2。
- **不可撤销/破坏性操作**：本次改动只新增本机日志，没有删除、覆盖或写入服务器数据，没有不可撤销操作。
- **规则与文档一致性**：`prompt-prefix` 不适用于本改动；`test-and-production-hosts.md` 要求苹果客户端在 Mac 上用 Xcode 构建/测试，而 `AppModel.swift` 只在 Linux 做了 `-parse`，见问题 5。材料“6 个枚举”与代码的 8 个不一致，见问题 6。
- **本地持久化路径**：`PairingRecord`、`ThreadCache` 也会经过同一个宽松解码器，因此本地缓存中的未知值也会被记成“from server”；见问题 6。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会（读代码证实）。改动只在 `clients/apple` 的三个文件里：核心的宽松枚举解码、`AppModel` 的日志挂接、测试。`ServerValueDiagnostics` 只被 `ServerValues.swift`、`AppModel.swift` 和测试引用，没有任何请求组装代码读取它；苹果客户端也不直接拼模型提示。解出的枚举值本身没有变，仍是原来的 `fallback`。所以发给模型的内容没有新增、删除或重排，仍然只在末尾追加；也没有把每轮会变的值塞进请求开头。规则要求的“只追加”在本改动上等价于未受影响。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会（读代码证实）。没有改 JSON 编码、遮盖或任何序列化；`String(describing:)` 和 `prefix(64)` 只用于本机日志，不参与请求或持久化。唯一的非确定性是**哪些未知值会被日志记录**（并发解码顺序、64 条预算），但这只影响日志，不影响发给模型或存储的字节。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有两条新用例，Linux 上 `swift test` 会执行。去掉 `noteFallback` 的日志调用（保留 API）会让第一条失败；去掉去重会让第一条失败；去掉截断会让第二条失败。**但**：没有测试 64 条上限，去掉上限不会失败；第二条因为中间的 `reset()`，即使“无观察者时也写 `seen`”也不会失败（见问题 3）。另外 `AppModel.swift` 的 `Logger` 路径没有在 Mac 上编译，`swiftc -parse` 不能算自动检查；作者“162 条、三次”的 Linux 结果我未核实。

4. **每个新值、每个使用它的地方都能接受吗？**
   逐个核对（读代码证实）：`UnknownServerValue.type`、`.raw` 只被日志和测试消费，二者都接受任意 `String`；`distinctLimit` 只在类内部比较；`subsystem` 来自 `bundle.bundleIdentifier ?? "himawari"` 传给 `Logger`；`category` 是固定字符串；`PairingRecord`、`ThreadCache` 的格式没有改。没有后端或清单校验会拒绝这些值，因此不存在 I-73 那种“清单 id 过不了后端校验”的另一个端点。**唯一的“两端不一致”是同一个 `raw` 在去重端用完整原文、在报告端用前 64 字符**，见问题 1，需要统一。
