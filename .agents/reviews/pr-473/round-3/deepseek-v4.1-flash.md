## 读代码证实的问题（按严重度排列）

### 1. 高：`ownerPresence` 被解码后没有任何执行路径使用

- 文件：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionModels.swift:33`、`:64`；`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionExecutor.swift:130-163`
- 问题：服务端下发的 `ownerPresence` 只被保存，执行器、门禁、读回都没有读取它。设计文档明确要求“设备离线时不执行排队的动作里‘要主人本人在场’的那些”（`docs/execution/specs/2026-11-11-apple-device-body-design.md:546`）。当前实现会在设备重新上线后直接执行这类排队动作；门锁、删日程等不可逆/人身安全相关动作缺少设备侧的最后一道检查。服务端审批可能已经要求 Face ID，但设备字段本身成了“只在一端认”的值，正是 I-73 的形状。
- 证据：
  ```swift
  public let ownerPresence: Bool
  ...
  self.ownerPresence = ownerPresence
  ```
  ```swift
  if let refusal = DeviceActionGate.refusal(
      delivery,
      implemented: handler?.handles(delivery) ?? false,
      blocked: blocked(delivery.action),
      permission: permission,
      permissionName: handler?.permission.name,
      settingsPath: handler?.permission.settingsPath,
      now: now()
  ) {
  ```
  `DeviceActionGate.refusal` 的参数里没有 `ownerPresence`，`process`/`perform` 也没有读取它。
- 建议：在设备侧使用这个字段。至少做到 `ownerPresence == true` 时要求执行当下有主人在场（例如 App 前台且刚刚完成确认密钥验证），否则保持待核对/报告 `resultUnknown`，不要直接执行；如果确认由服务端完全保证，则删除该设备字段或明确注释其只是展示用途，并补测试。

### 2. 中：`stage == .finished` 但 `report == nil` 时会被重新执行

- 文件：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionExecutor.swift:138-147`；`DeviceActionJournal.swift:41`
- 问题：日志解码允许 `report` 缺失。`process` 只有在 `stage == .finished` 且 `report != nil` 时才重发结果；如果日志里是 `finished` 但 `report` 为 `nil`，会继续走到 `perform`，把不可逆动作再做一次。这与“结果不确定时绝不重做”的目标相反。
- 证据：
  ```swift
  report = try container.decodeIfPresent(DeviceActionReport.self, forKey: .report)
  ```
  ```swift
  if let entry, entry.stage == .finished, let report = entry.report {
      await send(report)
      steps.append(.replayed(id: delivery.id))
      return
  }
  if delivery.mode == .verify || entry?.stage == .started {
      await verify(delivery, made: entry?.made, before: entry?.before)
      return
  }
  await perform(delivery)
  ```
- 建议：只要 `stage == .finished` 就按“已结束、不能再执行”处理；`report == nil` 时走核对或报告 `resultUnknown`，绝不能落到 `perform`。

### 3. 中：`schemaVersion` 只在 perform 路径检查，verify 路径不检查

- 文件：`DeviceActionHandler.swift:47-49`；`DeviceActionExecutor.swift:143-145`、`:195-210`
- 问题：作者说“不认的版本不做”，但实现只在 `perform` 里通过 `handler?.handles(delivery)` 检查。`process` 对 `mode == .verify` 或 `stage == .started` 的 delivery 直接调用 `verify`，`verify` 只按动作名取 handler，不检查 schema version。这样，未知版本的核对请求仍会被执行读回；当 `readBack == .none` 且动作属于 `readOnly` 时，甚至会再次调用 `perform`。
- 证据：
  ```swift
  func handles(_ delivery: DeviceActionDelivery) -> Bool {
      names.contains(delivery.action) && schemaVersions.contains(delivery.schemaVersion)
  }
  ```
  ```swift
  if delivery.mode == .verify || entry?.stage == .started {
      await verify(delivery, made: entry?.made, before: entry?.before)
      return
  }
  ```
  ```swift
  private func verify(...) async {
      guard let handler = handlers[delivery.action], await handler.permission.status() == .authorized else {
  ```
- 建议：在 `process` 或 `verify` 开头统一检查 `handler.handles(delivery)`；不匹配时直接报告 `resultUnknown`/`notSupported`，不要读回或执行。

### 4. 中：提醒动作名在代码和设计文档里不一致，且承诺的双向检查不在本 PR

- 文件：`clients/apple/Sources/HimawariActions/ReminderActions.swift:7`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:524`
- 问题：设计文档写的是 `reminder.create`、`reminder.complete`，Swift 实现是 `device_reminder.create`、`device_reminder.complete`。仓库里没有作者提到的 `test/integration/device-actions-swift-client.test.ts`，也搜不到 `DEVICE_ACTION_REGISTRATIONS`，所以无法在本仓库核实两端一致。这正是 I-73 的场景：动作名只在 Swift 端认，服务端登记表不在本 PR 里，可能全部提醒动作都被判为不支持。
- 证据：
  ```swift
  public let names = ["device_reminder.complete", "device_reminder.create"]
  ```
  文档：
  ```text
  | `reminder.create`、`reminder.complete` | 新建或修改，中 |
  ```
- 建议：把动作名双向比对检查随本 PR 一起提交，或至少在本仓库里放一份可校验的服务端清单/生成代码；同时统一文档与代码。服务端 9A 的实际名称目前只能标“未核实”。

### 5. 低：被拒绝的结果在 `keepUntil == nil` 时永久留在日志里

- 文件：`DeviceActionExecutor.swift:115-120`、`:262`；`DeviceActionJournal.swift:17`
- 问题：`finish` 用 `delivery.expiry` 设置 `keepUntil`。如果 verify 路径拿到的 `expiresAt` 无法解析，`keepUntil` 为 `nil`；之后服务端拒绝该报告时，`resendFinished` 对 `refused` 且 `keepUntil` 为 `nil` 的条目既不再发送，也永远不删除，日志会持续增长。
- 证据：
  ```swift
  if entry.refused {
      if let keepUntil = entry.keepUntil, keepUntil < current {
          try? journal.update { $0.entries[entry.id] = nil }
      }
      continue
  }
  ```
  ```swift
  entry.keepUntil = delivery.expiry
  ```
- 建议：把 `keepUntil == nil` 当成“立即过期”，或为 refused 条目设置一个有界保留期并清理。

### 6. 低：最近结果窗口仍用原始 `Date()`，没有使用刚引入的 `correctedNow`

- 文件：`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionsModel.swift:74`
- 问题：设备时钟偏差较大时，`finishedSince` 会偏离服务端时间，可能少显示或多显示最近结果。这个问题不影响执行安全，但与本次“按服务器校正时间”的修正不一致。
- 证据：
  ```swift
  if let views = try? await api.actionViews(finishedSince: Date().addingTimeInterval(-Self.recentWindow)) {
  ```
- 建议：如果 API 能拿到 `DeviceHTTPClient`，这里也使用 `correctedNow`；否则在模型层注入统一的 `now`。

## 推测 / 未核实

- 服务端 9A 的 `packages/platform-node/src/device-api-routes.ts`、`packages/application/src/services/device-action-registry.ts` 不在本仓库，`git log --all` 也没有这些文件。因此以下契约只能标未核实：`schemaVersion` 字段名/取值、`readBack` 的 `read_item`/`confirm_absent`/`read_state`、动作名、`device.actions` 事件名、日期参数是否严格为 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:MM`、动作编号是否一定是 `dact_` 加 32 位十六进制。
- `AlarmActions.alarmId` 要求动作编号为 `dact_` 加 32 位十六进制（`AlarmActions.swift:41-47`）。如果服务端编号格式不同，所有 `alarm.set` 都会以 `badArguments` 失败；本仓库没有针对真实服务端的闹钟用例。
- `DeviceActionDelivery.schemaVersion` 是必填字段（`DeviceActionModels.swift:31`），`DeviceAPI.decode` 解码失败会抛 `invalidResponse`，而 `DeviceActionExecutor.pass` 把异常吞掉（`:93`）。如果服务端漏发或改名，表现为“所有动作静默不执行”，没有用户可见错误。需服务端联调确认。
- `HomeLoader.status` 在 `asked == true` 且 `manager == nil` 时会创建 `HMHomeManager`（`HomeActions.swift:44-47`）。如果创建实例本身会触发系统权限弹窗，那么在权限被重置后仅刷新设置页也可能直接弹系统框，绕过说明页。这一点没有在 Xcode/真机上核实。
- 服务端可能已经保证 `ownerPresence` 动作只在主人在场时下发；但设计文档要求设备侧也判断，代码没有做到，所以仍按上文的缺口处理。

## 侧重检查

- **错误路径**：查了日志丢失/损坏、回报被拒绝、读回失败、执行抛错、`keepUntil` 为空、`report` 缺失。好的地方：日志在 `perform` 前写 `started`；`send` 对带 evidence 的 400 会退化为不带 evidence 再报；`readBack` 失败不会报成功；`journal.lost` 会走 `actions/open` 并只核对。问题：`finished + report == nil` 会重做；`keepUntil == nil` 的 refused 条目会永久保留。
- **不合规范 / 不可信输入**：参数类型有 `badArguments` 拒绝；`localDate` 新增了整串正则，能挡住带秒、带 `Z` 和两位数日期；动作名、schema 版本、日期格式、动作编号格式都依赖服务端契约，仓库内无法核实。没有发现服务端可控的任意文件路径写入。
- **安全**：审批的 `recentAuthenticationRequired` 只在同意时使用确认密钥签名（`DeviceActionAPI.swift:82`），方向正确；本地日志使用 `.completeFileProtection` 且排除备份（`LocalStore.swift:19`、`:46`）。主要缺口是 `ownerPresence` 未被设备执行器使用，以及策略拉取失败时继续使用旧 `blocked` 集合（`DeviceActionExecutor.swift:107-110`，失败时静默继续）。
- **资源耗尽**：claim 循环用每轮 `seen` 集合避免同一编号死循环（`DeviceActionExecutor.swift:72-92`），这一点成立；日志条目保留受 `keepUntil` 限制，但空 `keepUntil` 的 refused 条目会泄漏。证据对象可能较大，已有 400 后退化重发，但没有本地大小上限。
- **不可撤销操作**：日历删除、联系人修改、家庭控制、提醒完成都在执行前写日志，执行后读回；问题仍是 `ownerPresence` 未参与设备侧判断，以及 `finished + report == nil` 的重做路径。
- **规则 / 文档一致性**：`.claude/rules/prompt-prefix.md` 约束的是模型请求组装，本 PR 没有改动系统提示、工具定义、历史或遮盖，因此不受影响。设计文档的 `reminder.create/complete` 与代码 `device_reminder.*` 不一致；作者提到的动作名双向检查文件不在本 PR；9A 服务端代码不在仓库，无法核实作者“已对真服务端跑过”的说法。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍然只在末尾追加？

在本 PR 的代码范围内，不会。改动全部在 Apple 客户端和本地执行器：新增的是设备事件 `device.actions`、本地日志、读回、审批和 UI，没有修改系统提示、工具定义、历史消息、资料块或遮盖逻辑。`ChatStore` 只是增加 `onDeviceActions` 回调，不修改历史内容（`ChatStore.swift:343-346`）。

模型请求由服务端组装；如果 9A 把设备动作结果作为工具结果追加，设计文档要求它只作为这一轮末尾的工具结果出现（`docs/execution/specs/2026-11-11-apple-device-body-design.md:648-653`）。这部分服务端代码不在本仓库，未核实；但它不属于本次 Apple 改动。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

对模型请求：不适用，本 PR 不组装模型请求，也没有遮盖逻辑。客户端内部的确定性大体没问题：支持的动作名排序后上报（`DeviceActionExecutor.swift:41-46`）、`blocked` 排序后提交（`DeviceActionAPI.swift:48`）、日志用 `.sortedKeys`（`DeviceActionJournal.swift:93-96`）。

一个小的非模型问题：`reportAction` 直接 `JSONEncoder().encode(report)`（`DeviceActionAPI.swift:26`），`evidence` 是字典，默认编码不保证键顺序，所以同一报告重发时字节可能不同。由于每次请求单独签名、服务端按动作编号去重，这不影响模型缓存；只有在服务端用正文哈希做幂等时才有影响。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

- `localDate` 的新测试是有效的反向用例。去掉新正则后，`"2026-11-20T15:00:00Z"` 会被 `compactMap(Int.init)` 丢掉 `"00Z"` 后当成 `15:00` 接受；`"2026-11-2"` 也会被 Calendar 规范化后接受。所以这些 `#expect(... == nil)` 确实能抓住旧行为。
- `correctedNow` 的测试有效：若 `correctedNow` 返回原始 `now()`，`DeviceHTTPClientTests.swift:138` 会失败。
- `schemaVersion` 只有 `handles` 的单元测试（`DeviceActionGateTests.swift:66-80`），没有执行器级用例。把 `DeviceActionExecutor.swift:155` 改回 `handler != nil`，现有测试仍然通过；也就是说“不认的版本不执行”的真实守卫没有被测试保护。
- `DeviceActionServerTests` 需要 `HIMAWARI_ACTION_CONTROL` 才运行（`DeviceActionServerTests.swift:76`），默认跳过；本地没有真服务端，无法验证新增的“无读回不重做”用例。
- 作者提到的动作名双向比对和真实服务端端到端测试不在本 PR；本仓库没有 `DEVICE_ACTION_REGISTRATIONS`，也没有 `test/integration/device-actions-swift-client.test.ts`。因此 I-73 类型的跨端检查在本 PR 内没有自动保障。
- HomeKit 的 `readValue` 失败处理、`asked` 行为、`ownerPresence` 都没有自动检查。

### 4. 每个产生或修改的值，使用它的一端都能接受吗？

- `schemaVersion`：服务端产生，Swift 解码后由 `handles` 使用。`perform` 两端都检查；`verify`/`process` 不检查，见上文问题 3。服务端是否发送这个字段、取值是否在 `[1]` 内，未核实。
- `correctedNow`：`DeviceHTTPClient` 产生，`AppModel` 注入执行器使用，都是 `Date`，可接受。但 `DeviceActionsModel` 的最近窗口仍用原始 `Date()`，见问题 6。
- 动作名：Swift handler 产生，服务端登记表使用；服务端不在仓库。设计文档与代码的提醒动作名不一致，见问题 4。
- `ownerPresence`：服务端产生并被 Swift 解码，但没有任何使用方，见问题 1。
- `expiresAt` / `keepUntil`：服务端产生日期字符串，Swift 解析为 `Date`；执行器用校正后的 `now` 比较，方向正确。`keepUntil == nil` 的清理缺口见问题 5。
- `mode`、`readBack`、`state`、`outcome` 的原始字符串：服务端产生，Swift 用 `rawValue` 解码；demo/测试里用的是预期值，但服务端代码不在仓库，未核实。
- `alarm.set` 的动作编号到 UUID：服务端产生编号，Swift 硬编码 `dact_` + 32 位十六进制。两端校验未核实，若格式不同会全部失败。
- 日期参数文本：服务端产生，`localDate` 使用并收紧格式；服务端是否也接受同样的精确格式，未核实。
- `device.actions` 事件名：服务端产生，`DeviceEventDecoder` 使用；服务端代码不在仓库，未核实。
- `asked` UserDefaults 键：`HomeLoader` 自己产生、自己使用，单端一致。
- `reportSupported` 清单：客户端排序后上报，服务端返回的清单被忽略，客户端保存自己上报的值；目前没有发现错误，但服务端丢弃某些名字时客户端不会重报。
