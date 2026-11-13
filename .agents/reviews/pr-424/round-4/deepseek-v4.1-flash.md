## 结论

这批增量（a97ab3b13..00eaebf3d）是 iOS 客户端、截图脚本和文档的修改，没有改服务端的提示词、工具定义、历史或出口遮盖代码。按必答问题：请求开头不受影响（Q1、Q2 都是“否”）；自动检查在 Core 层基本到位，但新的 `keysUnreadable`/`restore` 路径和 `ui-review.sh` 没有自动检查（Q3）；新值的使用端大体都能接受，但 `keysUnreadable` 的修复带出了一个 `keysUnavailable` 回归（Q4）。

---

## 读代码证实的问题

### 1. 中：`becameActive` 不再重试 `.keysUnavailable`，会把已配对用户卡在只能重新扫码的页面

**文件:行**：`clients/apple/Sources/HimawariShell/AppModel.swift:289-293`

**问题**：本次把回前台恢复的条件从 `.keysUnavailable` 改成了 `.keysUnreadable`，但没有保留前者。`activate()` 在本地存储创建失败时仍会设置 `.keysUnavailable`：

```swift
// AppModel.swift:249-251
        } catch {
            phase = .unpaired(.keysUnavailable)
        }
```

旧的判断是（diff 中可读到）：

```swift
        if phase == .unpaired(.keysUnavailable), keychain.presence(Self.recordAccount) != .absent {
            restore()
            return
        }
```

新代码只剩：

```swift
// AppModel.swift:289-293
    public func becameActive() {
        if phase == .unpaired(.keysUnreadable) {
            restore()
            return
        }
```

而 `.keysUnavailable` 页面只给“重新扫码”，没有“再试一次”：

```swift
// PairingView.swift:54-57
        case let .unpaired(problem?) where problem != .removed:
            problemPage(icon: .alertCircleLarge, tint: .hmDanger, problem: problem) {
                scanButton(L.text("pairing.rescan"))
            }
```

因此一次临时的 Application Support/磁盘失败后，用户回前台不会自动恢复，密钥和配对记录其实都在，却被迫重新拿二维码配对。

**建议**：保留两个分支，例如同时判断 `.keysUnreadable` 和“`.keysUnavailable` 且配对记录不是不存在”；更好的是把“本地存储创建失败”和“密钥不可用”拆成两个不同的 `PairingProblem`，避免文案和恢复策略混淆。

### 2. 中：`restore()` 把“读不出/解不开配对记录”当成“没配对”，会删除密钥和本地聊天缓存；新增的自动重试和手动重试让这条路径更常被走到

**文件:行**：`clients/apple/Sources/HimawariShell/AppModel.swift:52-54、60-69、299-315`

**证据**：

```swift
// AppModel.swift:52-54
    private var record: PairingRecord? {
        keychain.read(Self.recordAccount).flatMap { try? JSONDecoder().decode(PairingRecord.self, from: $0) }
    }
```

```swift
// AppModel.swift:60-69
        let presence = [keychain.presence(Self.recordAccount), keys.presence(.device), keys.presence(.confirm)]
        if presence.contains(.unreadable) {
            phase = .unpaired(.keysUnreadable)
            return
        }
        guard let record, presence.allSatisfy({ $0 == .present }) else {
            forget(problem: nil)
            return
        }
```

`forget()` 会删本地存储、两把密钥和配对记录：

```swift
// AppModel.swift:306-314
        try? store?.removeAll()
        ...
        try? keys.delete(.device)
        try? keys.delete(.confirm)
        try? save(nil)
```

“presence 为 present 但随后 `read`/`JSONDecoder` 失败”的触发概率我没有在设备上核实（**推测**），但代码行为是证实的：任何解码失败都会落入 `forget`，并且本次新增的 `retryReadingKeys()`（`AppModel.swift:193-195`）和回前台自动 `restore()` 都会反复进入这里。对“钥匙串暂时读不到”这种场景，静默清掉配对和聊天缓存是不可逆的数据损失。

**建议**：区分 `.absent` 和“不可读/损坏”；只有三者都确认 `.absent` 时才 `forget`。损坏的记录应报一个可恢复/可重试的 `PairingProblem`，不要删密钥。至少补一条测试：presence 为 present、`read` 返回 nil 或解码失败时不得删除密钥和本地缓存。

### 3. 低：`hiddenScalars` 不是完整的“不可见/方向控制字符”集合

**文件:行**：`clients/apple/Sources/HimawariCore/Pairing.swift:93-96`

**证据**：

```swift
    static let hiddenScalars = Set<UInt32>(Array(0x00...0x1F) + Array(0x7F...0x9F) + Array(0x200B...0x200F) + Array(0x202A...0x202E) + Array(0x2066...0x2069) + [0xFEFF])
```

已覆盖 C0/C1、U+200B..200F、U+202A..202E、U+2066..2069 和 BOM，但漏了同样是格式/方向控制的 U+061C（ARABIC LETTER MARK）、U+180E、U+2060、U+2028/2029 以及 tag 字符 U+E0000–E007F。设备名会发到服务器并可能显示在别处，denylist 漏项仍是潜在的显示欺骗面（可利用性 **推测**；服务端是否另行规范化 **未核实**，PR 404 的服务端代码不在本检出内）。

**建议**：改用“删除 Unicode general category 为 `Cf`（格式字符）”或同等更完整的判定，并补上 U+061C、U+2060、U+2028/2029 的测试；如果服务端也会校验/规范化，应在客户端和服务端保持同一规则。

### 4. 低：等待项的触发条件比作者描述宽，没有限定 `kind == .status`

**文件:行**：`clients/apple/Sources/HimawariCore/Execution.swift:152-155`

**证据**：

```swift
        if let latest = sorted.last, latest.phase == .waiting {
            let step = (latest.kind == .tool ? steps.first(where: { $0.id == latest.itemId }) : steps.last)
                ?? ProcessStep(id: latest.itemId, title: Self.present(latest.activity) ?? "", icon: ProcessIcon.chosen(latest.activityIcon), phase: .waiting, startedAt: latest.occurredAt, endedAt: latest.occurredAt)
            return .waiting(ProcessStep(id: step.id, title: step.title, icon: step.icon, phase: .waiting, startedAt: step.startedAt, endedAt: latest.occurredAt))
        }
```

作者说“最新记录是 `kind=status` 的 waiting”，但代码对任何 `phase == .waiting` 的记录都生效。当前服务端只有 `runtime.suspended` 会产生 waiting，且投影的 `base` 默认 `kind: "status"`（`packages/application/src/services/thread-execution-projection.ts:173-184、471-483`），所以目前没有可见差异；但这依赖服务端一个未在客户端表达的隐式约束，将来若 message 记录出现 waiting 会被误显示为“等你点头”。

**建议**：把条件收紧为 `latest.kind == .status`，或在测试里明确覆盖 `kind == .message` + waiting 不应进入等待项。

### 5. 低：空页继续翻页有上限，但可能每次 `executionChanged` 都打满 100 次请求

**文件:行**：`clients/apple/Sources/HimawariCore/DeviceAPI.swift:107-119`

**证据**：

```swift
        for _ in 0..<Self.pageLimit {
            let page = try await execution(threadId: threadId, runId: runId, afterSequence: after)
            ...
            guard let next = page.nextSequence else { return records.sorted { $0.sequence < $1.sequence } }
            guard next > after else { throw DeviceAPIError.invalidResponse }
            after = next
        }
        throw DeviceAPIError.invalidResponse
```

作者关心的“空页翻页上限是否仍有效”：**是**，仍是 `pageLimit`（100），且有 `executionRecordsGiveUpAfterThePageLimit` 反向测试。但服务器 `nextSequence` 按原始事件数算（`thread-execution-projection.ts:508-511`），因此合法地出现大量被过滤事件时会打满 100 次串行请求；若超过 100 页，`loadExecution` 永远抛错，界面退回 `.thinking`，并且每次执行变化事件都会重试这 100 次。资源上是有界的，但会带来延迟和请求放大。

**建议**：可加“连续空页”上限，或在达到上限时返回已拿到的记录而不是丢弃为 `invalidResponse`；同时补一条“大量过滤事件”的测试。

### 6. 低：`ui-review.sh` 的新分支逻辑正确，但没有自动检查来证明反向用例真的会失败

**文件:行**：`clients/apple/scripts/ui-review.sh:27-46、54、58、121-123`

**证据**：

```bash
command -v xcrun >/dev/null && xcodebuild -version >/dev/null 2>&1 || { echo "UI_REVIEW_FAILED needs Xcode on a Mac (xcodebuild -version failed)" >&2; exit 1; }
...
if ! runtime="$(xcrun simctl list runtimes available | grep -E '^iOS ' | tail -1 | sed -E 's/.* - (com\.apple\.CoreSimulator\.SimRuntime\.[^ ]+).*/\1/')" || [ -z "$runtime" ]; then
  echo "UI_REVIEW_FAILED no iOS simulator runtime installed; add one in Xcode > Settings > Components" >&2
```

在 `set -euo pipefail` 下，这两条确实会在 xcrun/xcodebuild 不可用、或没有 iOS runtime 时给出 `UI_REVIEW_FAILED`；`missing_in` 的 `return "$gaps"` 和 `|| { ...; exit 1; }` 也能正确阻断。但没有发现任何测试/shell stub 覆盖这些分支，所以“没装 Xcode/没有 runtime/缺场景时真的失败”目前只是读代码判断。另有一个**既有**的小风险：第 57 行 `xcrun simctl list devicetypes | grep -q ...` 在 `pipefail` 下遇到 grep 提前退出可能触发 SIGPIPE（输出不大时通常不会）。

**建议**：给脚本加一个用假 `xcrun/xcodebuild` 的 tooling 测试，至少覆盖：无 xcrun、无 runtime、`--approve` 缺一个浅色/深色场景、`--check` 快照缺场景。第 57 行可改成先把输出收进变量再 grep，避免 SIGPIPE。

---

## 推测的问题（未核实/依赖设计意图）

- **停止行没有“警告”触感**：`ProcessRowView.swift:23-37` 的 `reportHaptic` 没有 `.stopped` 作为目标的分支，`.stopped` 会落到 `default` 什么也不做。作者说“触感仍用警告”，如果这句话也适用于“停了”这一行，则没有实现；如果停止由主人主动触发、不需要 Himawari 触感，则不算问题。设计线程的意图我未核实。
- **`ui-review.sh --check` 的临时目录泄漏**：`shots="$(mktemp -d)"` 后没有清理（既有行为），长期反复跑会在 /tmp 留下目录；不是本次引入，但新流程会让它更常跑。
- **`case .unpaired(.keysUnreadable)` 的编译**：该写法依赖“非可选 enum case pattern 匹配 Optional”的 Swift 行为；Swift 6.2 下大概率合法，但本环境无法运行 `swiftc` 类型检查。作者也说明界面目标只跑了 `swiftc -parse`，而 `-parse` **不做类型检查**，所以访问控制、Swift 6 并发和这个可选模式都还没有编译证据。

---

## 侧重检查

- **错误路径/不可信输入**：
  - `PairingRequestLimits.deviceName` 对 C0/C1/常见零宽和方向符/BOM 的过滤是确定性的，新增测试覆盖了 U+202E、U+0085、U+200B、U+FEFF；完整格式字符集合有漏项（见问题 3）。
  - `PairingInvitation.parse` 本次未改，仍限制 https、无 user/password/query/fragment、code 长度；未受影响。
- **安全**：`keysUnreadable` 不会进入 `forget`，这一条设计是对的；但配对记录解码失败会走 `forget` 删除密钥（见问题 2）。`hiddenScalars` 本身是 denylist，安全性依赖枚举完整度。
- **资源耗尽**：`executionRecords` 的 100 页上限仍有效（有测试）；大量过滤事件会造成请求放大和始终失败（见问题 5）。`ui-review.sh --check` 的 `mktemp -d` 不清理（既有）。
- **不可撤销操作**：`forget()` 删除本地 store、两把密钥和配对记录是本次新增重试路径最容易碰到的不可逆操作。`ui-review.sh --approve` 会先 `rm -f` 已批准快照再复制，若复制中途失败旧快照已丢（既有；新增的 `missing_in` 减少了源目录缺失造成的误删）。
- **规则/文档一致性**：`clients/apple/README.md:104` 与 `compare-snapshots.swift:33-34` 的 3/255、0.05% 一致；README 的“约 1500 像素”按 1170×2532 计算约 1481，正确；`latest/`、`*.mp4` 的 gitignore 与脚本输出路径一致；`docs/execution/{plans,specs}/2026-11-11-apple-device-body*` 没有残留旧阈值 16/255 或 0.2%。
- **跨端值核对（I-73 式）**：当前 `packages/gateway-contracts/src/thread-contracts-v3.ts:587-606` 的 `threadExecutionRecordSchema` 没有 `activity`/`activityIcon`；客户端把它们声明为可选，缺失时可解码，等待项标题会退化为空并显示“等你点头”，符合本次意图（activity 在 PR 427，未合入本检出）。`kind` 的 message/tool/status 和 `phase` 的 started/updated/completed/failed/waiting/stopped/unavailable 两端一致。`nextSequence` 服务端为 nullable integer(1) 且按原始事件数推进，客户端要求严格递增，两端可接受。`keysUnreadable` 只在本地 `AppPhase` 使用，不涉及持久化或服务端枚举。
- **UI 编译**：本环境不能编译 HimawariShell；`swiftc -parse` 只验证语法。`public internal(set)` 本身合法，`ChatStore.demo` 与 `ChatStore` 同模块且扩展继承 @MainActor，理论上成立，但需 Mac 上真正类型检查。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。对比范围内没有修改 `packages/`、`apps/` 的提示词、工具定义、历史、出口遮盖或压缩代码；改动都在 iOS 客户端、截图脚本、文档和复核记录。客户端拿到的是设备网关的执行记录和配对数据，不参与模型请求组装。因此“只在末尾追加”“每轮会变的值只在最后一条消息”这两个约束都不受本改动影响（依据 `.claude/rules/prompt-prefix.md#append-only`、`#rules`）。`answering()` 固定时钟只影响演示截图，不是模型内容。
2. **会不会让同一段文字在不同请求里变成不同的字节？** 不会。没有模型请求生成路径被改；`deviceName` 是纯函数，输出确定；`executionRecords` 只做序列号排序和按 id 去重；`ui-review.sh` 的场景列表来自源码顺序并固定为浅色/深色两轮。演示数据 `now` 改为固定值，反而让截图更确定。
3. **有没有对应的自动检查，反向用例是否真的会失败？**
   - 有：`executionRecordsKeepPagingPastAPageWhoseEventsWereAllFilteredOut`（旧代码会抛 `invalidResponse`，新代码通过）、`executionRecordsRejectAPageThatDoesNotMoveForward`（若删掉 `next > after` 守卫，夹具会被耗尽，测试失败）、`executionRecordsGiveUpAfterThePageLimit`、`deviceNameFitsTheServerLimitInUTF16UnitsWithoutHiddenCharacters`（旧过滤会保留 U+202E/U+0085/U+200B/U+FEFF，测试失败）、`aRunSuspendedBeforeAnyStepStillWaits`（旧代码返回 `.thinking`，测试失败）。
   - 没有：`keysUnreadable`/`retryReadingKeys`/`becameActive` 的状态转换没有测试（HimawariShell 在 Linux 不编译，也没有 Shell 测试目标）；`ui-review.sh` 的新错误分支没有测试；`process.failed/stopped/waiting` 的视图文案没有 UI 测试；三语 key 完整性没有自动检查（`check:apple-design` 只查颜色/尺寸/token）。因此“反向用例真的会失败”只对 Core 层成立，对本次新增的错误恢复路径和 shell 脚本不成立。
   - `swiftc -parse` 不做类型检查，所以界面目标的访问控制、并发和可选模式匹配仍缺真正的编译验证。
4. **每个新值的使用端都能接受吗？**
   - `PairingProblem.keysUnreadable`：产生于 `AppModel.restore()`；`PairingView` 的 switch 和 `key()` 都已加 case；三语 `pairing.problem.keysUnreadable(.title)` 都在；不 Codable、不持久化，没有其他消费点。可接受。
   - 三个 `process.*` key：`ProcessRowView` 使用，三语都在；缺少 key 时会显示原始 key（`L.text` 的 fallback），但没有完整性门槛。
   - `hiddenScalars`：只被 `deviceName` 使用，类型和测试成立；覆盖不完整，见问题 3。
   - `ChatStore` 七个 `internal(set)`：唯一新增写入方是 `DemoChat.demo`（同模块 DEBUG），读取方未变；会让 release 构建中同模块任意代码都能改这些状态，属于封装放宽而非功能错误。
   - `nextSequence` 空页语义：产生端 `thread-execution-projection.ts:508-511`，消费端 `DeviceAPI.swift:114-116` 要求严格递增；契约 `thread-contracts-v3.ts:617-625` 允许 nullable integer，两个端可接受。
   - `compare-snapshots` 阈值、`latest/`/`*.mp4`、`DemoChatFixtures.now`、`still` 场景清单：分别与 README、脚本输出路径、`DemoSceneView` 的 `listClock` 和 `DemoScenes.swift` 一致。
   - `activity`/`activityIcon`：客户端按可选解码，当前服务端契约没有这两个字段（PR 427 未合入），缺失时安全退化；等 PR 427 加字段时需保证服务端契约允许这两个字段（本检出内未核实 PR 427 的具体 schema）。

**作者说法核对**：`ChatStore` 七个属性、`executionRecords` 空页继续翻、`keysUnreadable` 重试与回前台 restore、三语文案、`ui-review.sh` 三个门、`compare-snapshots` 阈值、`.gitignore`、`answering()` 固定时钟，都与代码一致。两处需要修正表述：`ProcessLine` 的条件并未限定 `kind == .status`；`deviceName` 只去掉了列出的码位，不等于“所有零宽/方向控制符”。另外，`becameActive()` 把旧的 `.keysUnavailable` 恢复分支删掉了，这是作者说法里没有提到、但代码里确实存在的回归。
