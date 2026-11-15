本轮范围：`git diff f510c5c..4ccfa20` 的 10 个文件（`ci/operations-pending.json`、`Proactive.swift`、`ProactiveStrings.swift`、`ProactivePages.swift`、`ProactiveTests.swift` 及上轮评审资料），并顺着增量追到 `ProactiveSession.swift`、`contracts-v2.ts`、`production-proactive.ts`、`check-operations.mjs`、`operations-removed.json`、网页 `proactive-reminders.tsx` / `memory-page.tsx`、`ProactiveSessionTests.swift`、ADR 0192。上一轮意见 1/2/3/4/8 逐条核对，增量未触碰的旧逻辑只在与证据相关时跟读。

### 1. 低/中（推测）：`step` 的防溢出修复只包住了加/减，`maximum - minimum` 仍可能溢出崩溃

- 文件:行：`clients/apple/Sources/HimawariCore/Proactive.swift:178-187`；测试 `clients/apple/Tests/HimawariCoreTests/ProactiveTests.swift:104-110`
- 问题：新增的 `min(..., 1_000_000_000)` 在**减法之后**才封顶，`maximum - minimum` 本身仍可能超出 `Int` 范围；Swift 的 `-` 溢出是 trap（崩溃），不是回绕。
- 证据（读代码证实）：
  ```swift
  178: public var step: Int {
  179:     let span = min(max(1, maximum - minimum), 1_000_000_000)
  ```
  `stepUp/stepDown` 已用 `addingReportingOverflow` / `subtractingReportingOverflow`（186-187），但 179 行没做同样处理。新增测试用的是 `maximum = Int.max, minimum = 1`，差值不溢出，所以测不到这条路径。
- 推测：`ProactiveSafetyLimitShape` 在合同里要求 `minimum >= 1`（`packages/gateway-contracts/src/contracts-v2.ts:1542-1547`），因此**合同合法数据**不会触发；只有损坏/恶意/超出合同的快照（例如 `minimum` 为负）才会。但客户端 `JSONDecoder` 直接解 `Int`，不校验合同，所以这条崩溃路径在客户端是存在的。
- 建议：改成 `let diff = maximum.subtractingReportingOverflow(minimum)`，溢出时按 `Int.max`/合理上限处理；测试补一个 `minimum` 为负或 `maximum - minimum` 必然溢出的用例。
- 针对上一轮 #8：**部分修好**。报告中的 `Int.max` 场景已能通过，剩余是同一类但更极端的输入。

### 2. 低（推测）：撤销后的状态可能被“完成”动作触发的旧重载覆盖

- 文件:行：`clients/apple/Sources/HimawariManage/Settings/ProactivePages.swift:148-160`、`clients/apple/Sources/HimawariManage/Settings/ProactiveSession.swift:32-40,72-84`
- 问题：`done`/`mute` 成功后在 `defer` 里异步 `reloadOverview()`；撤销再发 `reopen`，也会再排一次 `reloadOverview()`。`reloadOverview` 没有请求序号或取消保护，谁后返回谁覆盖。
- 证据（读代码证实）：
  ```swift
  73: defer { Task { await reloadOverview() } }
  ```
  ```swift
  157: try await session.respond(insight, .reopen, reason: M.confirmProactiveRespond)
  158: handled = nil
  ```
  `reloadOverview()`（32-40）没有版本判断，直接 `overview = ...`。
- 推测：如果 `done` 那次重载请求先发出、但其响应在 `reopen` 的重载之后才到，它带的是完成态快照，会把已恢复的 insight 又从列表里覆盖掉；`handled` 已被清空，用户会以为撤销没成功，直到下一次刷新。局域网下窗口很窄，属于时序问题。
- 建议：给重载加递增序号（只接受最新一次结果），或在撤销成功后等待/串行化两次重载；至少补一个“完成→撤销”的会话测试。

### 3. 低：撤销/reopen 是新增用户路径，但没有自动检查

- 文件:行：`clients/apple/Sources/HimawariManage/Settings/ProactivePages.swift:83-93,155-160`；`clients/apple/Tests/HimawariManageTests/ProactiveSessionTests.swift:150-165`
- 问题：新增的撤销按钮、`reopen` 动作、清空 `handled` 的行为没有任何测试覆盖。现有 `ProactiveSessionTests` 只测了 done/mute 之外的 `rate`、pause、source 命令，没有 `reopen`。
- 证据（读代码证实）：会话测试到第 165 行结束，唯一的 insight 命令用例是 `.rate`；`respond` 的 payload 生成在 `ProactiveSession.swift:72-84`，`reopen` 与 `done`/`mute` 一样发 `rating: .null`，这条格式没有被测试锁住。
- 建议：在 `ProactiveSessionTests` 加一条 `respond(insight, .reopen)`，断言 `type == "proactive.insight.respond"`、`action == "reopen"`、`rating == null`；UI 的“完成后出现撤销、撤销后消失”至少做一次可编译的预览或状态测试。
- 上一轮 #2 的功能本身已实现：网页的 `reopen`（`apps/control-center/src/proactive.ts:74,239-240`）与 App 走同一命令，服务端 `reopen` 会置回 `open`（`apps/agent-service/src/production-proactive.ts:785-801`），合同也允许 `reopen` + nullable rating（`packages/gateway-contracts/src/contracts-v2.ts:1408-1415`）。

**侧重检查**

- 错误路径/不可信输入：逐条读了 `ProactiveDayLimit` 的解码与运算（见意见 1）；`ProactiveSession.reloadOverview/reloadSources` 失败时保留旧数据、不会崩，但会静默显示旧值；`ProactiveErrors.declined` 改成复用 `SettingsStore.isDeclined`（`:117-120`），逻辑与原实现完全相同，未改变“把取消当拒绝”的既有行为。
- 不可撤销操作：`done`/`mute` 现在有撤销入口，走同一 `reopen` 命令，服务端接受；`pause` 可重新开启，`source.switch_off` 可通过 settings.set 再开，未发现新增的不可撤销写操作。
- 安全：增量没有新增密钥、URL、日志或拼接命令；撤销文案与 summary 只进入 SwiftUI `Text`，无注入面。
- 资源耗尽：`step` 循环在 179 行封顶 1e9 后最多约 8 次迭代（实际最大步长约 1e7），没有新增无界循环；新增的 `.task`/`.refreshable` 只是多一次普通列表读取。
- 规则/文档与代码一致：`check-operations.mjs:315-329` 确实扫描 `clients/apple/Sources`，`:420-433` 会对“名单内但已齐全”报 `OPERATION_PENDING_BUT_COMPLETE`；删掉的 4 项在后端、测试、Swift 调用方三处都有字面量，`operations-removed.json` 也没登记它们，删除正确。发现一处**既有**文档漂移：`docs/adr/0192-...md:48` 写“名单目前登记 23 项”，而本次增量前实际是 33 项、现在 29 项（另有 6 项 `notInstalled`）；这不是本次引入的，但既然动了清单，建议顺手改成实际数量或不写死数字。
- prompt/系统提示：增量未触碰任何 prompt、工具定义、历史消息、遮盖逻辑或生产装配代码。

**结论**

上一轮意见核对结果：
- #1 已修好：4 个条目从 `ci/operations-pending.json` 删除（现为 29 项），`ProactiveSession.swift` 已有 `proactive.pause`、`proactive.sources.read`、`proactive.source.settings.set`、`proactive.source.switch_off` 的直接调用，后端与测试仍在，`check:operations` 不会再报“已齐全但仍挂在名单里”。
- #2 已修好：`done`/`mute` 后有撤销卡片，发 `reopen`；服务端和合同都接受，但缺自动检查（见意见 3）。
- #3 已修好：`ProactiveSourcePage` 加了 `.task` 和 `.refreshable`；加上原有的 `ProactivePage`、`ProactiveLogPage`、`ProactiveSourcesPage`，所有显示 `M.loadFailed`（“下拉再试一次”）的页面现在都有下拉重试。
- #4 已修好：insight 的评分现在只在 `insight.pushed` 时显示（`ProactivePages.swift:208-212`），与网页 `proactive-reminders.tsx:174-185` 一致；insight 评分不会发 `null`，与网页和“服务端拒绝 rate+null”一致。
- #8 部分修好：加减溢出已处理，减法本身仍可溢出（见意见 1）。

必答问题：
1. 发给模型的内容没有变化。增量全在 iOS 客户端 UI/操作清单和评审资料；没有系统提示、工具定义、历史消息或遮盖逻辑改动，因此仍不受这次改动影响，问题不涉及。
2. 不会。没有新增模型请求字段，也没有新增时间字段、随机值或无序集合进入请求；这不是本次增量涉及的范围。
3. 有/没有：`check:operations`（含 `test/tooling/operations-check.test.mjs:151-158` 的反向用例）能覆盖 #1；新增的溢出测试在旧代码上会失败，能覆盖 #8 的已修部分；但撤销/reopen、`pushed` 评分门控、来源页重试没有自动检查（意见 3）。
4. 逐个核对：
   - `reopen` + `rating: null`：合同枚举含 `reopen`、rating 可空（`contracts-v2.ts:1408-1415`），服务端只拒绝 `rate && rating === null`（`production-proactive.ts:786-791`），可接受。
   - `M.proactiveUndo`：只在 `ProactivePages.swift:88` 使用，定义在 `ProactiveStrings.swift:60`，无冲突。
   - 封顶后的 `step`/`stepUp`/`stepDown`：使用端只有 `ProactivePages.swift:412-413` 的 Stepper 和测试；对合同合法值 `clamped` 保证不越界，剩余风险见意见 1。
   - 被删的 4 个清单键：使用端是 `check-operations.mjs`，这些操作仍留在 `PRODUCTION_PROACTIVE_OPERATIONS`（`production-proactive.ts:71-86`）和集成测试中；删除是删除端唯一能接受的状态。
   - `ProactiveErrors.declined`：调用端仍是 `ProactivePages.swift` 的 `run`/`rate`/`save`，签名与语义未变，可接受。
   - 新测试的 `Int.max` JSON：`JSONDecoder` 能解码为 `Int`，测试断言成立。

作者说法的核对：1、2 与 `ProactiveSession.swift:52-152` 及测试一致；3 与网页 `proactive-reminders.tsx:741-751`、`memory-page.tsx:921-929` 和服务端拒绝逻辑一致；4 在增量范围内成立（新出现的 `1_000_000_000` 是内部步进上限，不显示）；5 成立，改动不涉及模型请求或生产装配。
