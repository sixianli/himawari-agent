### 1 中 作者声称的测试依赖并不存在，`PairingView` 的改动没有任何自动检查
- 文件:行：`clients/apple/Tests/HimawariCoreTests/PairingProblemCoverageTests.swift:30-42`；`clients/apple/Sources/HimawariShell/PairingView.swift:12,26,52-55`
- 问题：作者说“PairingProblemCoverageTests 里依赖 `confirmationDialog(startOverWarning` 的断言仍成立”，但代码里没有这样的断言。该测试只检查 `stateUnknown` 的路由和本地化键是否存在，从不引用 `confirmationDialog` 或 `startOverWarning`。因此第 2 项改动没有自动检查，也不存在会失败的反向用例。
- 证据：测试实际内容是
  ```swift
  let route = try #require(view.range(of: "case let .unpaired(problem?) where problem == .keysUnreadable"))
  let routeLine = view[route.lowerBound...].prefix { $0 != "\n" }
  #expect(routeLine.contains("problem == .stateUnknown"), "stateUnknown is not routed to the retry page")

  for language in ["en", "ja", "zh-Hans"] {
      let strings = try source("Sources/HimawariShell/Resources/\(language).lproj/Localizable.strings")
      for key in ["pairing.problem.stateUnknown", ..., "pairing.startOver.confirm", ...] {
          #expect(strings.contains("\"\(key)\" ="), "\(language) is missing \(key)")
      }
  }
  ```
  全文检索 `confirmationDialog` 只有 `PairingView.swift:26` 一处，测试里没有。
- 建议：补一条能真正失败的反向检查。可把纯选择逻辑（`0` / 正数 / `nil`）抽到 `HimawariCore` 后做 Linux 单测，或在现有的源码扫描测试里断言按钮先赋 `startOverWarning` 再置 `confirmingStartOver`；同时更正 PR 材料中对测试覆盖的描述。
- 性质：读代码证实。

### 2 低 警告文案在点击时冻结，确认不可撤销删除前可能已经过期
- 文件:行：`clients/apple/Sources/HimawariShell/PairingView.swift:52-55`；`clients/apple/Sources/HimawariShell/AppModel.swift:211-228`；`clients/apple/Sources/HimawariCore/Outbox.swift:37-41`
- 问题：`startOver` 会 `retire()` 本地存储，属于不可撤销操作；警告里的未发送条数现在只在点击按钮的一瞬间读取。如果点击后、用户确认前 outbox 又有变化（例如后台发送失败又写回），确认框显示的数字可能少于实际会被删除的条数。原实现是计算属性，至少在界面重新求值时有机会刷新；不过这种刷新本来也不保证。
- 证据：
  ```swift
  linkButton(L.text("pairing.startOver")) {
      startOverWarning = Self.startOverWarningText(unsent: model.unsentMessages)
      confirmingStartOver = true
  }
  ```
  ```swift
  public func startOver() {
      guard emptyStore() else { phase = .unpaired(.storageUnavailable); return }
      cancelPairing()
  }
  ```
- 建议：在破坏性按钮真正执行 `model.startOver()` 前再核对一次 `unsentMessages`；若与展示值不同，先中止并重新展示确认框，或至少把这一取舍写进 PR 说明。若判定窗口可忽略，也应明确记录。
- 性质：推测（SwiftUI 呈现时机与 outbox 并发写入未能实机验证）。

### 3 低 `isTestFile` 的匹配范围比作者描述更宽，且只认大写 `Tests`
- 文件:行：`scripts/model-review/opencode-review.mjs:1240`
- 问题：实现是 `/(?:^|\/)Tests\/.*\.swift$/`，会匹配任意路径里的 `/Tests/`，不只是 `clients/apple/Tests/`；任何叫 `Tests` 的目录下的 Swift 文件都会被当成测试文件，从而满足 `no-test-change` 条件。这可能是想要覆盖所有 Swift 包，但与作者“`clients/apple/Tests/` 下”的窄描述不完全一致，也没有用例锁定“其他 `/Tests/` 目录”的预期。
- 证据：
  ```js
  /(?:^|\/)Tests\/.*\.swift$/.test(path) ||
  ```
- 建议：若有意覆盖所有 Swift 包的 `Tests/`，在测试里补一个 `packages/foo/Tests/...swift` 的正向用例并把 PR 描述改宽；若只想限 `clients/apple/Tests/`，把正则锚定到该前缀。顺带确认是否需要大小写不敏感（当前只认 `Tests`，不认 `tests`）。
- 性质：读代码证实匹配行为；影响属于设计取舍。

## 侧重检查

- **错误路径**：`model.unsentMessages` 在文件读失败时返回 `nil`，仍走 `pairing.startOver.confirmUnknown`，是保守文案；`startOver` 的 `emptyStore()` 失败仍落到 `.storageUnavailable`。本次未改这些分支。
- **不可信输入**：`ServerValueDiagnostics.noteFallback` 的 `raw` 来自服务器，先截到 64 字符再存储和写日志；`type` 来自代码内 `String(describing:)`，不是服务器可控。新增的字典键数量受 `LenientServerValue` 类型数限制（当前 8 个），每个 `Set` 最多 64 项，内存有界。`isTestFile` 处理的是 git 路径，含换行的文件在 `opencode-review.mjs:1336` 已被拒绝；正则无灾难回溯风险。
- **资源耗尽**：每类型上限使总上报量从 64 变为最多 `类型数 × 64`（当前 8×64=512）条日志，属改动意图，仍有界。
- **不可撤销操作**：`startOver` 会删除本地 outbox/配对；警告快照的时效问题见意见 2。
- **规则/文档与代码一致性**：作者关于 `PairingProblemCoverageTests` 依赖的说法与代码不符（意见 1）；`isTestFile` 实际范围比描述宽（意见 3）；`prompt-prefix` 规则对本 diff 不适用，未发现请求头相关改动。

## 必答问题

1. **会改变模型已经见过的请求开头吗？** 不会。本次改动只涉及 Apple 客户端的值诊断、配对界面文案和复核脚本的门禁判断，没有触碰系统提示、工具定义、历史消息或遮盖逻辑。发给模型的内容仍按原有方式只在末尾追加；本次也没有新增“每轮会变”的值，因此不存在应放到最后一条消息却放错位置的问题。整个请求组装链路本次未全量复核（未核实），但本 diff 不在此路径上。

2. **同一段文字会在不同请求里变成不同字节吗？** 不会影响模型请求。`seen` 的字典/Set 只用于进程内去重，遍历顺序不参与任何序列化；`startOverWarning` 是界面文案，不发给模型；`isTestFile` 是确定性的纯函数。没有引入时间字段、后文依赖的遮盖或无序集合输出。

3. **有对应的自动检查吗？反向用例真的会失败吗？**
   - 第 1 项：有 `eachTypeHasItsOwnLimit`。读旧实现可确认，旧代码在 64 个 `ThreadStatus` 后 `seen.count == distinctLimit`，随后的 `ExecutionPhase` 会被全局上限挡住，断言得到 0，旧代码失败、新代码通过（读代码推断，未实际运行 Swift 测试）。
   - 第 2 项：没有自动检查，作者声称的断言不存在，因此没有反向用例会失败（见意见 1）。
   - 第 3 项：有 `isTestFile` 正反用例。旧代码对 `clients/apple/Tests/...swift` 返回 false，新增正例会失败；PNG 和 `Sources/...swift` 在新旧实现下都为 false（读代码推断，未实际运行 node 测试）。

4. **每个产生或修改的值，所有使用方都能接受吗？**
   - `seen: [String: Set<String>]`：只在 `noteFallback` 和 `reset` 内使用；`AppModel` 的 observer 只把 `UnknownServerValue` 的 `type`/`raw` 写日志，接受 `String`。类型键来自代码内类型名，数量有界；`raw` 先截断，长度有界。
   - `startOverWarning: String`：由 `startOverWarningText` 产生三种本地化文案，使用于 `.confirmationDialog` 的 `StringProtocol` 重载，类型匹配；初值 `""` 只在未弹出时存在，确认框只由该按钮置为 true。唯一风险是快照时效（意见 2）。
   - `isTestFile` 新增正则：产物是 `Bool`，生产端唯一消费者是 `lowFixProblems` 的 `no-test-change` 判断，测试已覆盖正反例；匹配范围比描述宽（意见 3）。
   - 本次没有修改配置键、清单项或序列化格式。
