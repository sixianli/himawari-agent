## 一、读代码能证实的问题（按严重度从高到低）

### 1. 高 — `DeviceActionExecutor.swift:185-196`（触发点在 `:133`）
- **问题**：`readBack == .none` 的动作在“只核对”路径里会再次调用 `perform`，违背“已经开始但没有结果时只读回、不重做”。
- **证据**：
  ```swift
  if delivery.mode == .verify || entry?.stage == .started {
      await verify(delivery, made: entry?.made, before: entry?.before)
  ```
  ```swift
  if delivery.readBack == .none {
      do {
          let result = try await handler.perform(delivery)
          return await finish(delivery, .succeeded, readBack: true, ...)
  ```
- **影响**：重装后 `/actions/open` 返回的待核对动作、或崩溃后停在 `started` 的动作，只要服务端给的 `readBack` 是 `none`，就会被再执行一次。日历删除、门锁、闹钟等不可撤销动作会重复生效。
- **建议**：`verify` 路径永远不要调用 `perform`；`readBack == .none` 且无法确认时上报 `result_unknown`，或为这类动作单独实现不产生副作用的核对方式。

### 2. 高 — `DeviceActionExecutor.swift:260-268`
- **问题**：上报结果时，无论服务端是否接受，都会删掉本地 journal 记录。
- **证据**：
  ```swift
  let reply = try await transport.reportAction(report)
  if case .refused(status: 400, _) = reply, report.evidence != nil {
      ...
      _ = try await transport.reportAction(lean)
  }
  try? journal.update { $0.entries[report.id] = nil }
  ```
  而 `DeviceActionAPI.swift:24-29` 把 400/404/409 都变成 `.refused` 返回，不抛错。
- **影响**：400（内容不合法）、404（服务端不认识）以及 lean 重试仍然被拒时，结果并不会被服务端记下，但本地记录已经删除。之后同一编号再到达时客户端“忘了”已有结果，可能重新执行；同时也违背“同一编号再次到达只重发已记下的结果”。
- **建议**：只在 `.recorded` 时删除；409 可视为已记录但应先确认服务端语义；400/404 必须保留记录、记录日志并重试。成功上报后也应保留一段时间的墓碑记录，避免服务端 claim 的旧快照回来时被重做。

### 3. 中高 — `DeviceActionExecutor.swift:70-90`
- **问题**：重装后的 `reopenActions()` 结果没有强制改成“只核对”，也没有加入本轮 `seen` 集合。
- **证据**：
  ```swift
  if !journal.exists {
      let reopened = try await transport.reopenActions()
      try journal.save(DeviceActionJournalFile())
      for delivery in reopened { await process(delivery) }
  }
  ...
  var seen = Set<String>()
  while true {
      let claimed = try await transport.claimActions()
      let fresh = claimed.filter { !seen.contains($0.id) }
  ```
- **影响**：“重装也不重做”完全依赖服务端把 `mode` 改成 `verify`。如果服务端返回 `perform`，或同一编号同时出现在 `reopen` 和 `claim` 中，客户端会再次执行；作者“请服务端改成待核对再只核对”的保证在客户端没有兜底。
- **建议**：对 `reopen` 返回的 delivery 本地强制使用 `verify`；把它们的 id 预先放入 `seen`；并保留已完成的报告记录，直到确认服务端已经进入终态。

### 4. 中高 — 动作名在仓库内部不一致
- **问题**：客户端注册的动作名、设计文档、演示数据三套写法不一致。
- **证据**：
  - `ReminderActions.swift:7`：`["device_reminder.complete", "device_reminder.create"]`
  - `docs/execution/specs/2026-11-11-apple-device-body-design.md:524`：`reminder.create`、`reminder.complete`
  - `DeviceActionsDemo.swift:84-85`：`calendar.create_event`、`calendar.delete_event`
  - `CalendarActions.swift:7`：`calendar.create`、`calendar.delete`
- **影响**：如果服务端登记表按设计文档使用 `reminder.*`，客户端会报 `notSupported`，提醒事项整批不可用；策略里的 blocked 名称和 `delivery.action` 也必须逐字一致，否则“关掉某个能力”不会生效。这正是 I-73 那类“只在一端认”的风险。
- **建议**：把动作名收敛到一处共享常量/枚举，并加契约测试；同时让设计文档、演示数据和 9A 服务端登记表使用同一组字符串。

### 5. 中 — `CalendarActions.swift:19`、`ReminderActions.swift:17` 与 `DeviceActionExecutor.swift:165-167`
- **问题**：创建动作的 `snapshot` 故意返回 `nil`，但执行器把 `nil` 当成“目标不存在”。
- **证据**：
  ```swift
  guard delivery.action != "calendar.create" else { return nil }
  ```
  ```swift
  if before == nil {
      return await finish(delivery, .failed, readBack: false, evidence: nil, reason: .targetMissing)
  }
  ```
- **影响**：只要服务端对新建动作设置 `snapshotBefore: true`，所有日历/提醒事项创建都会直接 `targetMissing`，永远不执行。当前是否触发取决于 9A 登记表，但两端语义已经不匹配。
- **建议**：把“没有初始状态”和“目标不存在”区分开（例如返回枚举而不是 `nil`），或在创建动作上明确禁止 `snapshotBefore`。

### 6. 中 — `HomeActions.swift:13-19`、`:58-67`
- **问题**：`homes()` 的 continuation 没有超时、没有取消恢复。
- **证据**：
  ```swift
  private var waiting: [CheckedContinuation<HMHomeManager, Never>] = []
  func homes() async -> HMHomeManager {
      if let manager, loaded { return manager }
      return await withCheckedContinuation { continuation in
          waiting.append(continuation)
  ```
  `status` 在 manager 为空时还会每次创建新的 `HMHomeManager()`。
- **影响**：HomeKit 代理没有回调时，执行器 actor 会永远卡在 `homes()`，所有设备动作都无法继续；`supported()` 每轮调用 permission.status() 还可能反复创建 HomeManager。
- **建议**：加超时并让 `homes()` 返回失败；在取消/销毁时恢复 continuation；缓存并复用同一个 manager/状态。

### 7. 中 — `HomeActions.swift:110-117`
- **问题**：多字段家居写入不是原子的，后面的字段失败时前面的已经写进去，但执行器只报 `failed`，不读回。
- **证据**：
  ```swift
  for (key, value) in delivery.arguments where key != "accessoryId" {
      guard let control = ... else {
          throw DeviceActionFailure(.cannotChange(...))
      }
      try await characteristic.writeValue(encoded)
      wrote[key] = value
  }
  ```
  `DeviceActionExecutor.swift:174-175` 收到 `DeviceActionFailure` 后直接 `finish(.failed, readBack: false)`。
- **影响**：家里可能已经部分改变（例如灯已开、亮度没调成），界面却显示“没做成”，属于结果不准确。
- **建议**：失败时读回当前状态；只要已经写入过至少一个字段，就上报 `result_unknown` 而不是 `failed`，并把已写入内容放进 evidence。

### 8. 中低 — `DeviceActionExecutor.swift:284`、`DeviceActionModels.swift:75`
- **问题**：`expiresAt` 解析失败时 `expiry == nil`，过期检查被跳过。
- **证据**：
  ```swift
  public var expiry: Date? { DeviceActionTime.parse(expiresAt) }
  ```
  ```swift
  if let expiry = delivery.expiry, expiry <= now { return .expired }
  ```
- **影响**：格式错误、空字符串等不可信输入会让过期动作被执行。服务端签名虽然降低风险，但这是明显的失败开放。
- **建议**：`expiresAt` 缺失或解析失败按过期/拒绝处理。

### 9. 中低 — `DeviceActionExecutor.swift:285` 与 `DeviceActionHandler.swift:121-129`
- **问题**：`notDetermined` 也走 `.permission` 文案，告诉用户“系统里没允许，可以去设置打开”。
- **证据**：
  ```swift
  if permission != .authorized { return .permission(...) }
  ```
  ```swift
  "系统里没允许 Himawari 使用\(what)，可以在\(path)里打开"
  ```
- **影响**：权限还没问过时，这条文案是不准确的，也绕过了作者说的“先显示说明页再弹系统询问”。`.unavailable`（受限）同样被告知去设置打开。
- **建议**：区分 `notDetermined`、`denied`、`unavailable`，分别返回“需要先说明并请求”“去设置打开”“设备不支持/受限”。

### 10. 低 — UI 尺寸与作者说法不一致
- **问题**：作者说“界面尺寸颜色只能用 DesignTokens”，但新增界面里大量出现字面尺寸。
- **证据**：
  - `DeviceActionViews.swift:16`：`spacing: 16`
  - `DeviceActionViews.swift:52`：`EdgeInsets(top: 18, leading: 18, bottom: 18, trailing: 18)`
  - `DeviceActionViews.swift:93`：`.padding(.vertical, 16)`
  - `DeviceActionViews.swift:340`：`.padding(.bottom, 16)`
  - `clients/apple/scripts/check-design.mjs:31-34` 的正则只匹配 `size/cornerRadius/width/height/...` 后跟数字，或 `.opacity(数字)`，抓不到 `EdgeInsets`、`padding`、`spacing`。
- **影响**：规则/文档与实际代码不一致；`check:apple-design` 目前不会报错，无法守住这条约束。
- **建议**：改用 DesignTokens 或 Layout 的间距常量；如果要允许这些写法，就更新规则和检查脚本。

### 11. 低 — `DeviceActionExecutor.swift:70-91`、`:120-127`
- **问题**：整个 `pass()` 用 `catch {}` 吞掉错误；journal 损坏时只把动作标成 `held`，没有修复或日志。
- **证据**：
  ```swift
  } catch {}
  ```
  ```swift
  do { entry = try journal.entry(delivery.id) }
  catch { steps.append(.held(id: delivery.id)); return }
  ```
- **影响**：网络错误、存储错误、journal 损坏都没有可见信号，结果可能长期不上报；损坏的 journal 会让相关动作永远停在 held。
- **建议**：至少记录稳定错误码/日志；区分可重试错误；提供 journal 损坏后的重建路径。

---

## 二、推测或需要服务端/苹果平台核实的问题

1. **服务端接口路径和字段无法核实（中）**
   `DeviceActionAPI.swift:15-86` 使用 `actions/claim`、`actions/open`、`actions/supported`、`GET actions/policy`、`POST actions/policy`、`GET approvals`、`POST approvals/{id}/respond`。仓库内设计文档的接口表（`docs/execution/specs/2026-11-11-apple-device-body-design.md:210-230`）只列了 `actions/result`、`approvals/challenge`、`approvals/respond`，没有 claim/open/supported/policy/GET actions/GET approvals。9A 的 `device-api-routes.ts` 和 `device-action-registry.ts` 不在当前分支历史中，**未核实**。

2. **近期身份验证没有使用一次性挑战值（中，需按 9A 契约确认）**
   设计文档 `:497` 要求先调 `approvals/challenge`，再签“审批编号 + 版本 + 挑战值”。代码里没有任何 challenge 调用，`DeviceActionAPI.swift:1125-1145` 直接用确认密钥签整个 HTTP 请求并发到 `approvals/{id}/respond`。如果 9A 仍要求挑战值，这条审批会失败；如果 9A 改成了请求签名，则设计文档需要同步。**未核实**。

3. **AlarmKit / HomeKit 接口签名未在 Xcode 编译验证（未核实）**
   作者已说明。`AlarmActions.swift:41-46` 还把动作编号硬编码成 `dact_` + 32 个十六进制字符才能转成 UUID；服务端编号格式若不同，`alarm.set` 全部 `badArguments`。

4. **本地时间只接受 `HH:mm`（未核实）**
   `DeviceActionModels.swift:288-292` 要求 `clock.count == 2`，`2026-11-20T15:00:00` 或带时区后缀都会被拒绝。服务端格式若带秒，日历、提醒、闹钟会全部失败。

5. **`CalendarOccurrenceId` 的 `#` 格式是客户端假设（未核实）**
   `DeviceActionHandler.swift:159-173` 规定 `eventIdentifier#YYYY-MM-DDTHH:mm`，但设计文档没有定义服务端下发的 `eventId` 格式；若服务端用别的格式，重复日程的更新/删除会找不到目标。

6. **服务端测试结果无法在当前仓库复现（未核实）**
   `DeviceActionServerTests.swift:76` 是 `@Suite(.serialized, .enabled(if: controlURL != nil))`，默认跳过；需要外部 9A 控制服务。作者说的“4 个用例在 9A 分支上跑过、关掉核对路径 2 个失败”在当前检出里无法验证。

---

## 三、侧重检查（错误路径、不可信输入、安全、资源、不可撤销操作、规则/文档一致性）

- **错误路径**：最严重的是 `verify` 在 `readBack == .none` 时重做（问题 1）、上报被拒后删除记录（问题 2）、重装 reopen 不强制核对（问题 3）、`pass()` 吞错和损坏 journal 永久 held（问题 11）。
- **不合规范/不可信输入**：`expiresAt` 解析失败即放行（问题 8）；创建动作 `snapshot == nil` 被当成目标不存在（问题 5）；动作名、参数格式、编号格式都依赖服务端未在仓库中的契约（问题 4、二.1/二.3/二.4/二.5）；`localDate` 不接受秒；`alarmId` 强依赖 `dact_` 格式。
- **安全**：高风险审批没有 `approvals/challenge`（二.2）；客户端无条件相信 `reopen` 返回的 `mode`（问题 3）；`ownerPresence` 在设备侧完全未检查；服务端下发的标题、标签、审批编号直接用于界面和 URL 路径（签名通道内风险较低，但审批编号未做格式校验）；结果 evidence 会把联系人电话、日程备注、家居状态发给服务器，这是设计预期但需确认数据分级与保留策略。
- **资源耗尽**：`HomeLoader.homes()` 的 continuation 没有超时/取消恢复，可能永久卡住整个执行器（问题 6）；`supported()` 每轮反复创建 HomeManager；`result_unknown` 动作每次事件都会重新核对；`recent` 拉取 24 小时全部动作没有分页。
- **不可撤销操作**：日历删除、门锁、闹钟。重复执行路径集中在问题 1、2、3；家居多字段部分写入（问题 7）会让“失败”结果与真实状态不一致。
- **规则/文档一致性**：动作名与设计文档/演示数据不一致（问题 4）；设计文档的接口表和挑战值流程与代码不一致（二.1、二.2）；“界面尺寸只能用 DesignTokens”与新增界面字面尺寸不一致，且检查脚本抓不到（问题 10）；Swift 测试不在 `npm run check` 中（见必答问题 3）。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。** 本次 diff 只改了 `clients/apple/**`（`git diff --stat` 的 36 个文件全部在 Apple 客户端），没有改系统提示、工具定义、历史消息、记忆/资料块或出口遮盖。`ChatStore.swift:343-349` 只是新增本地回调：

```swift
case .connected:
    connection = .online
    onDeviceActions()
    await flush()
case .deviceActions:
    onDeviceActions()
```

这不会向模型请求中插入任何内容。模型侧新增 `device_action` 工具属于 9A 服务端，不在本 PR。因此仍然符合“只在末尾追加、每轮变化的值只在最后一条消息”的规则。**服务端 9A 未在本仓库，未核实其是否改动了请求开头。**

### 2. 会不会让同一段文字在不同请求里变成不同字节？
**对模型请求：不会。** 本次改动不参与模型请求组装，也不影响遮盖；没有新增依赖时间的提示字段、无序的模型可见集合或按前后文变化的文本。

对客户端发给服务器的数据：`supported()` 返回排序后的数组（`DeviceActionExecutor.swift:46`），policy/blocked 也排序（`:106`、`DeviceActionAPI.swift:38`），journal 用 `.sortedKeys`（`DeviceActionJournal.swift:55`）。报告体使用默认 `JSONEncoder`，键顺序不保证固定（`DeviceActionAPI.swift:26/38/50`），但这只影响 HTTP 的字节，不影响提示缓存；若服务端按请求体哈希做幂等，应改为按动作编号而不是按字节。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？
**部分有，且没有进入常规 CI。**
- `DeviceActionGateTests.swift` 是普通 `swift test` 用例，覆盖过期、策略、权限、错误参数类型、时间解析、未知状态解码等；这些断言是直接的，去掉对应实现会失败。
- `DeviceActionServerTests.swift:76` 整个套件由 `HIMAWARI_ACTION_CONTROL` 环境变量开启，默认跳过；作者说的 4 个真服务端用例在当前仓库不会自动运行，9A 服务端也不在这里。
- `afterAReinstallOpenActionsAreCheckedNotExecuted` 和 `aLostReportIsOnlyReadBackNeverDoneTwice` 确实会在“重做”时失败（它们断言笔记文件没有多出行），但前提是能连上外部服务端。
- `theSameActionArrivingAgainOnlyResendsTheEarlierResult` 名字看似覆盖重复到达，实际是先手工写入 finished 记录、再让 `resendFinished` 上报；它没有覆盖“成功上报后 journal 已删除、服务端又重发同一编号”的路径。
- 没有覆盖：`readBack == .none` 的 verify 重做、上报被拒后删除记录、reopen 返回 `perform`、HomeKit/Contacts/EventKit/AlarmKit 的真实处理器。
- `package.json` 的 `check:steps` 没有 `swift test`；只有 `check:apple-design` 扫描 Swift 源码，因此这些核心测试并不受 `npm run check` 阻断。

### 4. 每个值产生处和使用处两端都能接受吗？
逐项核对结果：

- **动作名**：产生于各 handler 的 `names`（`AlarmActions.swift:36`、`HomeActions.swift:73`、`ReminderActions.swift:7`、`ContactActions.swift:7`、`CalendarActions.swift:7`）；使用于 `DeviceActionExecutor` 的 `handlers` 映射、`supported()`、`reportSupportedActions`、policy blocked 比较。仓库内已发现与设计文档（`reminder.*`）和演示数据（`calendar.*_event`）不一致（问题 4）。**服务端登记表未核实。**
- **`device.actions` 事件名**：产生于服务端，使用于 `DeviceEvents.swift:35-36`；服务端必须发这个事件名，**未核实**。
- **`DeviceActionOutcome`**：`succeeded`/`failed`/`result_unknown` 与设计文档状态一致（`DeviceActionModels.swift:78-82`，设计 `:538`）。
- **`DeviceActionMode` / `readBack` / `snapshotBefore` 的原始字符串**：使用于 `DeviceActionExecutor`，服务端字段名和枚举值在仓库内没有契约定义，**未核实**。
- **审批字段**：`expectedRevision`、`semanticSnapshotHash`、`decision` 与 `packages/application/src/services/approval-service.ts:30-59` 的校验一致；但 `recentAuthenticationRef` 的生成路径在客户端缺失 challenge（二.2）。
- **`approvals` 列表字段**：`PendingApproval` 的 `display.askedBecause` 是非可选，服务端若省略会解码失败；仓库内只有演示数据，**未核实**。
- **`CalendarOccurrenceId`**：产生于 `DeviceActionHandler.swift:162-164`，使用于 `CalendarActions.swift:131/136`；服务端 `eventId` 格式未定义，**未核实**。
- **`alarm.set` 的 UUID**：由 `dact_` 编号推导（`AlarmActions.swift:41-46`），服务端编号格式未在仓库定义，**未核实**。
- **journal 文件名**：`device-actions-journal` 只由 `DeviceActionJournal` 使用，`LocalStore` 接受普通文件名，内部一致。
- **权限 id**：`calendar`/`reminders`/`contacts`/`home`/`alarms` 在 `Permissions.swift` 与 `DeviceActionsModel.sources` 之间一致，内部可用。
- **UI 文案/按钮**：`confirmLabel`/`declineLabel` 缺失时有本地兜底（`DeviceActionViews.swift:56-66`），未知状态由 `DeviceActionView.state == nil` 显示通用文案，符合“不认识的动作名也要能显示”。

---

**总体结论**：这个 PR 不会破坏模型提示前缀，但设备动作执行器在“只核对、不重做”的保证上有实质缺陷，尤其是 `readBack == .none` 的 verify 重做，以及上报失败仍删除本地记录；再加上动作名/接口契约与仓库内文档不一致、服务端代码不在当前分支，当前不能认为“无论崩溃、断网、重装都不会做两次”已经成立。
