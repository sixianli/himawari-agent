# 复核结论

## 一、读代码证实的问题（按严重度从高到低）

### 1. 严重 — DEBUG 示例数据在另一个文件里写 ChatStore 的 `private(set)` 属性，macOS 上 HimawariChat 编不过

**文件：行** `clients/apple/Sources/HimawariChat/DemoChat.swift:26-32`

**问题** `ChatStore.demo` 在 DemoChat.swift 里给 `store.threads/texts/details/queued/streaming/connection/executions` 赋值，但这些属性在 ChatStore.swift 里是 `public private(set)`。Swift 的 `private(set)` 只允许在声明所在文件（及其同文件扩展）里写，跨文件扩展不能写。因此 macOS/Xcode 编译 HimawariChat 时会报 “setter is inaccessible”，连带 HimawariShell 和 App 都无法构建。

**证据**
- `ChatStore.swift:26-33`：
  ```
  public private(set) var threads: [ThreadSummary] = []
  public private(set) var texts: [String: String] = [:]
  public private(set) var details: [String: ThreadDetail] = [:]
  public private(set) var queued: [OutboxItem] = []
  public private(set) var streaming: [String: StreamingReply] = [:]
  public private(set) var connection: ChatConnection = .offline
  public private(set) var executions: [String: [ExecutionRecord]] = [:]
  ```
- `DemoChat.swift:26-32` 逐个赋值，例如：
  ```
  store.threads = state.threads
  store.texts = state.texts
  ...
  ```
- `Package.swift:21-23` 明确 Linux 下不构建界面目标：
  ```
  #if os(Linux)
  let interfaceTargets: [Target] = []
  ```
  所以作者所说的 “Linux swift test 80 条全过” 完全覆盖不到这段代码；而 `swiftc -parse` 不查访问控制，还会因 `#if DEBUG` 默认未定义而直接跳过 DemoChat.swift。

**建议** 在 ChatStore.swift 内加一个 `#if DEBUG` 的预置数据初始化器，或把 setter 改成 `internal(set)`，或把 demo 工厂放进 ChatStore.swift 同文件。并加一道 Mac 上的 `swift build`/`xcodebuild` 门槛，不能只用 `swiftc -parse`。

---

### 2. 中高 — `executionRecords` 把“没有投影记录但还有下一页”当成错误，会拒绝合法的服务端分页

**文件：行** `clients/apple/Sources/HimawariCore/DeviceAPI.swift:115`

**问题** 新代码要求每页记录非空：
```
guard next > after, !page.records.isEmpty else { throw DeviceAPIError.invalidResponse }
```
但服务端的 `nextSequence` 是按“本页原始事件数是否等于 limit”算的，而投影会丢掉一批事件类型。因此完全可能出现 `records == []` 且 `nextSequence != nil` 的合法页。客户端会抛错，`ChatStore.loadExecution` 的 catch 只处理 revoked，其他错误被静默吞掉，过程记录从此不再更新。

**证据**
- 服务端投影过滤事件，`packages/application/src/services/thread-execution-projection.ts:166-172`：
  ```
  if (
    !event.eventType.startsWith("runtime.") &&
    !["memory.query", "memory.candidates", "memory.selection", "context.formed"].includes(
      event.eventType,
    )
  )
    continue;
  ```
- `nextSequence` 只看原始事件数，同文件 `:510`：
  ```
  nextSequence: events.length === input.limit ? (events.at(-1)?.sequence ?? null) : null,
  ```
- 非 runtime 事件确实会写进同一次运行的 trace：`run-coordinator.ts:900-922` 把 `worker.progress`/`worker.completed`/`worker.failed` 等用 `traceScope(input)` 记录，且 `worker.progress` 的预算默认可达 100（`apps/agent-service/src/service-main.ts:1551`）甚至 256。一个 limit 较小、又连续产生进度事件的页，就可能全是会被投影过滤掉的事件。
- 客户端静默处理：`ChatStore.swift:225-229`
  ```
  do {
      executions[runId] = try await api.executionRecords(...)
  } catch {
      await handle(error)
  }
  ```
  `handle(_ error:)` 只对 `isRevoked` 有动作。
- 新增测试 `DeviceAPITests.swift:180-185` 把这个行为固化成“空页必须失败”，反向用例通过，但断言的是错误的服务端契约。

**建议** 只保留 `next > after` 作为前进校验；空记录但 next 前进时继续翻页，不要抛错。补一条测试：一页 `records=[]`、`nextSequence` 前进，下一页面有记录，最终应拼接成功。

---

### 3. 中 — `ui-review.sh` 没有 iOS runtime 时会静默退出，不会打印设计好的错误信息

**文件：行** `clients/apple/scripts/ui-review.sh:43-44`

**问题** 脚本在 `set -euo pipefail` 下做：
```
runtime="$(xcrun simctl list runtimes available | grep -E '^iOS ' | tail -1 | sed ...)"
[ -n "$runtime" ] || { echo "UI_REVIEW_FAILED no iOS simulator runtime installed" >&2; exit 1; }
```
没有 iOS runtime 时 `grep` 返回 1，`pipefail` 让整条管线返回 1，命令替换赋值失败，`set -e` 会立即退出；下面那行专门的 `UI_REVIEW_FAILED no iOS simulator runtime installed` 根本执行不到。用户只会看到无输出的失败，不符合“模拟器不存在时给出明白的错误”。

另外 `:36` 只检查 `command -v xcrun`，不检查 `xcodebuild` 或 `xcode-select -p`。只装了 Command Line Tools 的 Mac 上 `xcrun` 存在，之后会在 `xcodebuild` 处以 shell 报错失败，而不是脚本预期的 “needs Xcode”。

**证据**
- `ui-review.sh:2` `set -euo pipefail`
- `ui-review.sh:43-44` 上述两行
- `ui-review.sh:36` `command -v xcrun >/dev/null || { echo "UI_REVIEW_FAILED needs Xcode on a Mac" ...; }`

**建议**
```
if ! runtime="$(... | grep -E '^iOS ' | tail -1 | sed ...)"; then
  echo "UI_REVIEW_FAILED no iOS simulator runtime installed" >&2
  exit 1
fi
```
并显式 `xcodebuild -version` 或检查 `xcode-select -p`，在失败时打印同一类明确错误。

---

### 4. 中 — 快照阈值会让真实回归蒙混过关；动效场景在 `--check` 中完全不比对

**文件：行** `clients/apple/scripts/compare-snapshots.swift:33-34, 71-72`、`clients/apple/scripts/ui-review.sh:77-78`

**问题**
```
let channelTolerance = 16
let allowedChangedShare = 0.002
...
let share = Double(changed) / Double(expected.width * expected.height)
if share > allowedChangedShare { ... }
```
- 单通道差 ≤16/255（约 6%）在整屏任意像素都不算变化，因此把某个颜色 token 从 #FFFFFF 改成 #F0F0F0 之类的真实设计回归可整屏通过。
- 0.2% 的像素预算在 1170×2532 上约 5924 像素。一个 44×44 的图标被移动/隐藏只有约 0.065%，也会通过。
- `--check` 对 `motion-*` 直接 `continue`，微光、切页签、面板弹出、滚动四个动效没有任何自动比对，只有录屏供人看。

**证据** 上面引用的常量与判断；`ui-review.sh:77-78`：
```
motion-*)
  [ "$mode" = "check" ] && continue
```

**建议** 静态图用更严的单像素阈值（例如 2–4/255）或分区域/连通区域判断；对动效至少做抽帧比对或另设门槛；如果 0.2% 是有意的，请在门槛说明里写清“小于该比例的局部回归不会拦”，不要把它当作覆盖全部界面的自动验收。

---

### 5. 低到中 — `--approve` 的破坏性和不完整性，以及录屏输出没有被忽略

**文件：行** `clients/apple/scripts/ui-review.sh:27-33, 61-67`、`clients/apple/ui-review/.gitignore:1-2`

**问题**
- `--approve` 直接 `rm -f "$snapshots"/*.png`，再把 `--out` 里的 PNG 全部复制进去；不核对数量、场景名，也不确认这些图是不是当前场景集。如果之前一次 record 中途失败，只生成了部分 PNG，`--approve` 会把这些子集当作完整基线；之后 `--check` 只遍历 approved 里的文件（`compare-snapshots.swift:48`），缺失的场景完全不会被发现。
- record 模式默认写入 `ui-review/latest/`，但 `ui-review/.gitignore` 只忽略 `DerivedData/` 和 `*.mov`，`latest/*.png`、`*.mp4` 都会变成未跟踪文件，容易被误提交。

**证据**
- `ui-review.sh:28-32`
- `compare-snapshots.swift:48` `for name in approved {`
- `ui-review/.gitignore:1-2` 只有 `DerivedData/`、`*.mov`
- `ui-review.sh:6` `out="$root/ui-review/latest"`

**建议** `--approve` 前校验 PNG 名集合等于“非 motion 场景 × {light,dark}”；把 `ui-review/latest/` 和 `*.mp4` 加入 `.gitignore`；或明确 latest 不提交。

---

### 6. 低 — README 说示例时钟固定，但 `answering()` 使用 `Date()`

**文件：行** `clients/apple/Sources/HimawariChat/DemoChat.swift:194`；README「截图对照原型」节

**问题** README 写“示例数据的时钟固定在 2026-11-12 15:00，截静态图时关掉动效，所以每次截出来一样”，但 `DemoChatFixtures.answering()` 里：
```
let start = Date().addingTimeInterval(-6)
```
当前 `.working` 行只显示标题，不显示耗时，所以短期截图大概率仍一致；但这是与文档不一致的非确定值，将来一旦界面显示“已用 N 秒”或按时间排序，静态快照就会漂移。

**证据** `DemoChat.swift:194` 上述行；`DemoChatFixtures.now` 固定值在 `:40-46`。

**建议** 用固定的 `todayAt(...)` 或 `now` 派生 `start`，并把所有示例时间统一从固定时钟算。

---

### 7. 低 — `deviceName` 的“去控制字符”只去掉 C0 和 DEL，未去 C1/双向控制符

**文件：行** `clients/apple/Sources/HimawariCore/Pairing.swift:94-102`、测试 `DeviceAPITests.swift:195-206`

**问题** 过滤条件是：
```
raw.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7f }
```
它保留 U+0080–U+009F（C1 控制字符）、U+202E（RTL override）、U+200B 等格式字符。作者说“去控制字符”，说法比代码宽。若 PR 404 的 `boundedString` 确实只拒绝 `<0x20` 和 `0x7f`，那客户端结果是能通过服务端校验的，这一点需要服务端分支确认（未核实）；但“去控制字符”本身不成立。

另外测试函数名为 `deviceNameIsTrimmedToTheServerLimitInCharacters`，实际断言的是 `.utf16.count`，名字与语义不一致。

**证据** `Pairing.swift:95`、`DeviceAPITests.swift:195-206` 的 `utf16` 断言。

**建议** 如确实要与服务端完全对齐，把服务端拒绝的字符集原样抄成一处常量并在客户端过滤；如要“去控制字符”，用 `CharacterSet.controlCharacters` 等并考虑双向控制符。改测试名以反映 UTF-16 单位。

---

### 8. 低 — `becameActive` 的“回到前台再试”漏掉一种状态

**文件：行** `clients/apple/Sources/HimawariShell/AppModel.swift:285-289`

**问题**
```
if phase == .unpaired(.keysUnavailable), keychain.presence(Self.recordAccount) != .absent {
    restore()
    return
}
```
当 phase 是 keysUnavailable 是因为 `.device/.confirm` 读不到、而配对记录本身恰好 `.absent` 时，条件为假，前台回来不会重试。这违反了“读不到就回到前台再试”的说法。用户仍可通过 keysUnavailable 页面的“重新扫描”恢复（`PairingView.swift:49-52`），所以不是永久卡死，但自动恢复漏了一档。

**证据** `AppModel.swift:60-69` 的 restore 逻辑与 `:285-289` 的判断。

**建议** keysUnavailable 状态下直接调用 `restore()` 即可：如果确实什么都没有，restore 自己会 forget；不需要用记录是否 absent 当前置条件。

---

### 9. 低 — keysUnavailable 的界面文案不是“钥匙读不到”，且 storage 失败也复用了这个状态

**文件：行** `clients/apple/Sources/HimawariShell/AppModel.swift:245-247`、`Sources/HimawariShell/Resources/zh-Hans.lproj/Localizable.strings:15,33`

**问题** 作者说“读不到时显示‘钥匙读不到’”，实际文案是：
```
"pairing.problem.keys" = "没有密钥就配不了对。重启手机后再扫一次";
"pairing.problem.keys.title" = "这台 iPhone 建不了密钥";
```
这更像“没有/建不了密钥”，而不是“暂时读不到”。另外 `activate()` 里 FileLocalStore 创建失败也映射到 `.unpaired(.keysUnavailable)`，会把存储失败显示成密钥问题（该映射在改动前已存在，不是本次引入，但本次让 keysUnavailable 承担了新的语义）。

**证据** 上述两处代码与字符串。

**建议** 为“密钥暂时读不到”和“本机存储失败”分别加文案/状态，或至少把 keysUnavailable 的文案改成能覆盖“暂时读不到”的说法。

---

### 10. 低 — status 类型的 waiting 在没有工具步骤时会显示成“思考中”

**文件：行** `clients/apple/Sources/HimawariCore/Execution.swift:152-156`

**问题**
```
if let latest = sorted.last, latest.phase == .waiting,
   let step = latest.kind == .tool ? steps.first(where: { $0.id == latest.itemId }) : steps.last {
    return .waiting(...)
}
guard let current = steps.last else { return .thinking }
```
当最新记录是 `kind == .status`、`phase == .waiting`，但 `steps` 为空（还没有任何工具记录）时，`steps.last` 为 nil，条件失败，落到 `.thinking`。这正是“等你点头”应该出现的场景之一，却会显示成思考中，也不会触发 waiting 的触感。现有测试只覆盖了有前置工具步骤的情况。

**建议** status waiting 且没有工具步骤时，用最新记录构造一个等待项（title 取记录 name/text 或本地文案），或显式按 `run.status == "awaiting_approval"` 处理。

---

## 二、推测 / 未核实的问题

- **（推测，中）等待状态只看“绝对最后一条记录是 waiting”可能与服务端事件顺序打架。** 服务端投影会为 `runtime.authorization_review.*` 生成 `phase: "updated"` 的记录（`thread-execution-projection.ts:185-199`），而 `thread-execution-state.ts:183-199` 自己的判断也把 review 记录和 suspended 做顺序比较。如果 review 记录或其它 status 记录落在 `runtime.suspended` 之后，客户端就会因为最后一条不是 waiting 而隐藏“等你点头”，尽管 `run.status` 仍是 `awaiting_approval`。客户端手里有 `ThreadRunSummary.status`，但当前 `ProcessLine.make` 没有用它。需要确认服务端实际事件顺序；未核实。
- **（未核实）PR 404 的 `boundedString` 是否真的只拒绝 `<0x20` 和 `0x7f`，以及服务端是否按 UTF-16 `length` 截断/拒绝。** 当前仓库里没有 PR 404 分支，只有作者转述。
- **（未核实）设备端 `execution` 接口的默认 `limit`。** 客户端没有发送 `limit`；gateway schema 要求 `limit` 为 1–1000（`thread-contracts-v3.ts:608-615`），设备层如何补默认值不在当前仓库可见。这决定第 2 条“整页都是被过滤事件”的概率，但即使概率低，服务端契约上仍允许这种页。
- **（未核实）Mac 上实际 `swift test` / `xcodebuild` 结果。** 本次只能用 git 命令和读文件，无法运行测试；作者的 “Linux 80 条全过” 不能覆盖界面目标，而第 1 条已证明界面目标存在明确的编译错误。
- **（推测，低）`@Entry public var` 在未标 `public` 的 extension 中的跨模块可见性。** Swift 通常允许 `extension EnvironmentValues { public var ... }` 导出到其他模块，我倾向认为没问题；但没有在 Mac 上编译验证，标为未核实。

---

## 三、侧重检查

我重点查了错误路径、不规范/不可信输入、安全、资源耗尽、不可撤销操作，以及文档/代码一致性：

- **错误路径**
  - `executionRecords` 的空记录页路径 → 第 2 条，确认会抛 `invalidResponse` 且被静默吞掉。
  - `fullThread` 的空页/不前进/页数上限：守卫逻辑与测试 `DeviceAPITests.swift:134-149` 相符，未发现死循环；`next > after` 加页数上限是有效的前进保护。
  - `texts` 整批延后返回部分：`DeviceAPI.swift:156-159` 的 `deferred.count == batch.count` 能终止循环；服务器每次只解决一部分时，pending 会随已解决项减少，未发现新的无限循环。
  - `flush`：`ChatStore.swift:276-293` 每轮都 `await outbox.flush`，`flushAgain` 只可能由并发调用置位；未发现空转。`deferred` 为真时直接返回并 `scheduleRetry`，不会与 retry task 互相取消成环。唯一的延迟是“deferred 为真时即使 flushAgain 为真也先返回”，这与旧行为一致，不是新问题。
  - 钥匙串读不到：不会永久卡死（keysUnavailable 页有“重新扫描”），但自动重试漏一档（第 8 条），且文案不准确（第 9 条）。
- **不合规范 / 不可信输入**
  - `deviceName`：UTF-16 边界、按字形不拆、C0/DEL 过滤都符合测试；但 C1、双向控制符、零宽字符未处理（第 7 条）。
  - `PairingInvitation.parse` 的 https/无用户信息/无 query/fragment 校验是已有的，本次未改。
- **安全**
  - 示例数据只在 `#if DEBUG` 文件里；Xcode Debug 配置确实定义了 `SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG`（`project.pbxproj:164`），Release 不会包含 DemoChat/DemoScenes。`CameraStandIn`（`HimawariDesign/ScannerFrame.swift`）没有包 `#if DEBUG`，会进 Release，但只是一个黑色视图，不泄露示例数据。
  - 在 demo 场景下 `HimawariRootView` 仍然 `@State private var model = AppModel()` 并执行 `restore()`，启动真实模型的副作用（keychain/存储/网络）仍在后台运行；不影响截图内容，但属于不干净的示例模式，低风险。
  - 未发现新增密钥、token、日志泄露。
- **资源耗尽**
  - `executionRecords` 最多 100 页，`fullThread` 最多 100 页，`texts` 的逐批请求受 refs 数量限制；均为有界。
  - `compare-snapshots.swift` 逐张加载整图字节，单张约十几 MB，循环内释放；未见异常放大。
- **不可撤销操作**
  - `ui-review.sh --approve` 会先 `rm -f` 已存快照（第 5 条），错误路径下可能破坏基线；没有确认或备份。
  - `AppModel.forget` 会删钥匙和配对记录，但本次 restore 已改成“读不到不删”，方向正确；只有三样都确认存在才进入使用，缺任何一样才 forget。
- **文档 / 代码一致性**
  - README v2/tokens、计划文档 v2 与 tokens 源一致；tokens.json 的本次改动只是数组换行格式，生成的 `DesignTokens.swift` 没有变，`check-design` 的 `tokens-stale` 不会因此失败（我看了 diff）。
  - README 的“时钟固定”与 `answering()` 的 `Date()` 不一致（第 6 条）。
  - README/作者说“需要 Xcode”，脚本只检查 `xcrun`（第 3 条）。
  - 作者说 keysUnavailable 显示“钥匙读不到”，实际文案是“没有密钥/建不了密钥”（第 9 条）。
  - `.xcscheme` 的 `BlueprintIdentifier = D3DC968DCAF7E04C4C4E67A5` 与 `project.pbxproj:65` 的 target 一致，scheme 名 `Himawari` 与 bundle id `win.siyi.himawari` 能对上；这一项未发现问题。

---

## 四、逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本次差异只涉及 `clients/apple/**`（iPhone 客户端）、`docs/**`、`test/tooling/**` 和复核记录，没有任何服务端组装提示词的代码、系统提示、工具定义、历史消息或遮盖逻辑被修改。客户端发给服务器的新值只有配对请求里的设备名、普通的 `messages` 文本、`payloads/text` 的 ref 列表和 execution 的 `after` 游标；这些都不进入模型请求的“开头”，也不改变已有的模型消息。

规则依据（`.claude/rules/prompt-prefix.md:27-29,35`）要求“固定的在前、会变的在后”“已发内容只能在末尾追加”“存历史存实际发出的那条”。本次没有触碰这些路径，所以“只在末尾追加、每轮会变的值都在最后一条消息里”的约束不受影响。

**未核实**：PR 404 服务端分支的内部实现不在当前仓库；但按当前仓库的 diff，客户端改动不可能改变服务端拼接出来的提示词字节。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会（就模型请求而言）。**
- `texts` 的 ref 在 `ChatStore.loadTexts` 里先 `Set` 再 `.sorted()`（`ChatStore.swift:350`），请求顺序确定；`DeviceAPI.texts` 内部保持传入顺序并分批。
- `PairingRequestLimits.deviceName` 是纯函数，不依赖时间或上下文。
- `executionRecords` 的结果按 sequence 排序，虽然 sequence 相同的记录顺序不是稳定排序，但这些是 UI 过程记录，不进入模型请求。
- 唯一的非确定值是 demo 的 `Date()`（`DemoChat.swift:194`），它既不发给服务器也不进入模型；当前界面也没有把该值显示出来。

因此不存在“同一段提示词因前后文遮盖、时间字段或无序集合而字节漂移”的新风险。**未核实** 服务端 PR 404 是否另有时间字段；但客户端改动本身不传这些。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，但覆盖不全。**

已加的检查：
- `DeviceAPITests.swift`：`texts` 部分返回、`fullThread` 空页/不前进/页数上限、`executionRecords` 跟随/不前进/空页/页数上限、`deviceName` 的 UTF-16/字形/控制字符。
- `ProcessLineTests.swift`：最新记录 waiting、status waiting、较新记录结束等待、failed。
- `test/tooling/apple-design-check.test.mjs`：新增 `Color(white:)`、`NSColor.systemRed`、`.opacity(0.5)`、`.kerning(0.4)`、`idealWidth` 等反向用例。

这些反向用例在旧实现上确实会失败：
- 旧的 `deviceName` 按 Unicode scalar 截断，40 个 🌻 会得到 40 个 scalar（80 个 UTF-16 单元），`emoji.utf16.count == 64` 失败。
- 旧的 `texts` 在整批 deferred 时抛 `invalidResponse`，新的“保留已到部分”测试会失败。
- 旧的 `ProcessLine` 只要历史里有 waiting 就显示等待，`aNewerRecordEndsTheWait` 会失败。
- 旧的 `check-design` 正则漏掉 `Color(white:)`、`NSColor.systemRed`、`.opacity(0.5)` 等，新用例会失败。

**缺口（这也是我标为问题的原因）：**
- 没有 Mac 上的完整 `swift build`/`xcodebuild` 门槛，导致第 1 条这种界面目标的编译错误完全不会被发现；`swiftc -parse` 不查访问控制，甚至默认不解析 `#if DEBUG` 文件。
- `KeychainPresence`、`AppModel.restore`、`becameActive` 没有测试；钥匙串相关代码在 Linux 上也不编译。
- `ChatStore.flush` 循环没有测试（ChatStore 在界面目标里，Linux 不构建）。
- `ui-review.sh` 和 `compare-snapshots.swift` 没有测试；阈值、`--approve` 数量校验、缺失 runtime 的错误路径都没有自动检查。
- `executionRecordsRejectAnEmptyPageThatStillPointsFurther` 是“反向用例”，但它把错误的契约固化了：服务端可以合法返回空记录页（见第 2 条）。
- `motion-*` 场景在 `--check` 中直接跳过，动效没有自动检查。
- `ui-review.sh` 没有被接进 `npm run check`，只靠人工执行。

### 4. 改动产生或修改的每个值，每一处使用它的地方都能接受吗？

逐项核对结果：

- **`KeychainPresence`**：产生方是 `KeychainValueStore.presence(_:)`（`KeychainValueStore.swift:12-20`）和 `SecureEnclaveKeyStore.presence(_:)`（`SecureEnclaveKeys.swift:43-52`），使用方是 `AppModel.restore`（`.unreadable` 检查、`.present` 全满足）和 `becameActive`（`!= .absent`）。三态都能被接受；但 `becameActive` 的 `!= .absent` 漏掉“记录 absent + 钥匙 unreadable”这一档（第 8 条）。
- **`PairingRequestLimits.deviceNameUTF16Units`**：只被 `deviceName` 使用，旧名 `deviceNameCharacters` 已无引用；客户端上限与作者转述的服务端 UTF-16 `length` 方向一致，但服务端 PR 404 的具体校验未核实。
- **`ProcessLine.failed`**：`Execution.swift:148` 产生，`ProcessRowView.swift:29,33,63` 的显示和触感都处理了；仓库内没有其它 `switch ProcessLine` 遗漏（grep 只找到 ProcessRowView 和测试）。这是公开枚举的新 case，外部消费者需要同步，但仓库内已覆盖。
- **`DeviceAPI.pageLimit`**：产生于 `DeviceAPI.swift:105`，用于 `executionRecords` 和 `fullThread` 的循环及测试；两端都按 100 使用。
- **`DemoScene` 的 rawValue**：产生于 `DemoScenes.swift` 的 case，使用于 `DemoScene.requested`（启动参数）和 `ui-review.sh:39` 的 `sed` 提取。`sed` 要求 `case <名> = "<raw>"` 的精确格式，当前所有 case 都满足；以后新增带关联值或不同格式的 case 会静默漏掉，建议加一条自检。
- **`@Entry` 环境键**：`stillFrames`（HimawariDesign/Sunflower.swift）、`listClock`/`processStepsOpenAfter`/`transcriptScrollsToTopAfter`（HimawariChat/ProcessRowView.swift）、`tabsCycleEvery`（HimawariShell/RootView.swift）。生产方和消费方名字一致；DemoScenes 设置了全部五个，ChatListView/ChatView/ProcessRowView/Sunflower/MainTabs 都读取对应的键。跨模块可见性我倾向没问题，但未在 Mac 编译验证（未核实）。
- **`tokens.json`**：本次只把数组改成单行并加换行，`Generated/DesignTokens.swift` 没有变化，所以 `check-design` 的 `tokens-stale` 不会失败；v2 路径在 README、计划文档、`TOKENS_SOURCE` 里一致。
- **Xcode scheme**：`BlueprintIdentifier` 与工程 target 一致，`BuildableName`/`BlueprintName` 与 `Himawari.app` 一致；未发现清单项与后端/工程校验不一致。
- **`ui-review` 输出清单**：`--approve` 的输入只检查“至少有一个 PNG”，没有核对场景清单；使用方 `compare-snapshots` 只遍历 approved，因此 approve 不完整或新增场景未 approve 时会出现“清单项缺失但检查通过”（第 5 条）。

---

## 五、对作者说法的核对

- “flush 改成循环，每轮发完、排重试、刷新列表后再看 flushAgain” — **代码一致**（`ChatStore.swift:276-293`）。
- “钥匙串分成有/没有/读不到，读不到不清数据，回前台再试，确实没有才 forget” — **大体一致**，但“回前台再试”漏掉 record absent + keys unreadable（第 8 条），界面文案也不是“钥匙读不到”（第 9 条）。
- “executionRecords 每页必须前进且非空” — **实现一致，但“非空”要求与服务端投影契约不一致**（第 2 条），这是本次最需要改的行为问题之一。
- “texts 整批延后时返回已取到的部分” — **一致**（`DeviceAPI.swift:158`）。
- “ProcessLine 新增 failed；等你点头只在最新记录是 waiting 时显示；status waiting 用最后一个工具步骤” — **与代码一致**，但 status waiting 且没有工具步骤时会变成 thinking（第 10 条），并且“最新记录”可能被合法的高序号 review/status 记录干扰（推测，见第二节）。
- “deviceName 按 UTF-16 截 64、按字形不拆、去控制字符，对齐 PR 404” — **UTF-16 和字形不拆一致**；“去控制字符”只覆盖 C0/DEL（第 7 条），服务端 PR 404 的具体校验未核实。
- “check-design 补上真实写法” — **一致**，新正则能覆盖新增用例，且不会误报 token 代码。
- “示例场景不进 Release” — **文件层面的 `#if DEBUG` 正确**，Xcode Debug 定义了 `DEBUG`；但 `CameraStandIn` 会进 Release，且 demo 模式下真实 `AppModel` 仍会初始化，属于低风险的不干净点。
- “Linux swift test 80 条全过” — **无法在本环境验证**；而且 Linux 不构建 HimawariChat/HimawariShell，不能证明界面目标可编译，第 1 条已给出反例。

**总体结论：不建议合并。** 至少先修第 1 条（编译失败）和第 2 条（合法的空记录页会中断过程记录），再补 Mac 构建门槛；第 3、4 条关系到“脚本报错是否明白”和“快照门槛是否真能拦回归”，建议同批处理。
