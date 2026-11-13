先说明一个边界：服务端 9A 的 `device-api-routes.ts`、`device-action-registry.ts` 不在这个仓库里，所以服务端的 claim/open/result 语义、动作名、审批挑战流程只能标「未核实」。下面凡是依赖服务端行为的结论，我都写明了前提。

## 读代码证实的问题

### 高

**1. 普通重启不会主动核对本地未完成动作；重装路径又先清空日志再处理**
- 文件:行：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionExecutor.swift:73-79`、`:112-123`、`:165`、`:179`
- 问题：只有 `journal.lost` 为真时才调用 `reopenActions()`。普通重启时日志文件还在，`.received`/`.started` 的条目不会被重新拉出来核对；`resendFinished()` 只遍历 `.finished`。如果服务端不会自动把 `delivered` 变成 `result_unknown` 再由 `claim` 返回，这些动作就永远停在本地，既不执行也不核对。重装路径同样有窗口：第 75 行先保存空日志，第 76 行才开始逐条处理；中途崩溃后，未处理的 reopened 动作本地没有记录，下一次 `journal.lost` 为假，不会再 open。
- 证据：
  ```
  73: if journal.lost {
  74:     let reopened = try await transport.reopenActions()
  75:     try journal.save(DeviceActionJournalFile())
  76:     for delivery in reopened {
  77:         seen.insert(delivery.id)
  78:         await process(delivery.checkingOnly)
  79:     }
  ```
  ```
  115: for entry in entries where entry.stage == .finished {
  ```
  ```
  165: guard record(delivery, stage: .received) else { return }
  ```
  ```
  179: guard record(delivery, stage: .started, before: before) else { return }
  ```
- 建议：启动时始终调用 `open` 或至少扫描本地 `.received`/`.started` 条目并逐条核对；重装路径要先为 `reopened` 建立本地记录再清空/保存日志，或者处理完再更新 `lost` 状态。服务端若不保证 `delivered` 超时转 `result_unknown`，这一条就是高严重度的永久漏做。

**2. 结果被服务器确认后日志条目被删；被拒结果只留到过期且不重试，同一编号再次到达可能重做**
- 文件:行：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionExecutor.swift:281-285`、`:115-120`、`:130-147`
- 问题：`send` 在 `.recorded` 后直接删除条目，之后同一 `id` 再被投递时 `process` 找不到任何记录，会按 `.perform` 再执行一次，违背作者说的「同一编号再次到达只重发已记下的结果」。`refused` 条目在 `resendFinished` 里被 `continue` 跳过，不再重试；`keepUntil` 一到又直接删除。若服务器没有重新投递该动作，结果就丢了；若重新投递成 `perform`，就可能重做。
- 证据：
  ```
  281: switch reply {
  282: case .recorded:
  283:     try? journal.update { $0.entries[report.id] = nil }
  284: case .refused:
  285:     try? journal.update { $0.entries[report.id]?.refused = true }
  ```
  ```
  116: if entry.refused {
  117:     if let keepUntil = entry.keepUntil, keepUntil < current {
  118:         try? journal.update { $0.entries[entry.id] = nil }
  119:     }
  120:     continue
  121: }
  ```
  ```
  138: if let entry, entry.stage == .finished, let report = entry.report {
  139:     await send(report)
  140:     steps.append(.replayed(id: delivery.id))
  141:     return
  142: }
  ```
- 建议：`.recorded` 后保留一个有上限的墓碑记录（id、结果、`keepUntil`），而不是删除；`refused` 在过期前按退避重试，不要只依赖服务器重新投递；被测用例 `DeviceActionServerTests.swift:198-203` 只验证了「条目还在时重放」，建议补「确认后再来同一编号」的反向用例。

### 中

**3. Home 读回忽略读取失败，可能拿旧值谎报成功**
- 文件:行：`clients/apple/Sources/HimawariActions/HomeActions.swift:149-150`、`:206`
- 问题：`try? await current.readValue()` 忽略错误，然后直接读 `current.value`。读取失败时可能仍是写之前的值；若旧值恰好等于目标值，`readBack` 会返回 `.matches`，最终上报 `succeeded`，属于谎报结果。
- 证据：
  ```
  149: try? await current.readValue()
  150: let now = current.value
  ```
  ```
  206: try? await characteristic.readValue()
  ```
- 建议：读值失败一律返回 `.unreadable`，不要把 `current.value` 当作新读到的值；`state()` 也应该区分「读失败」和「读到」。

**4. 过期判断使用设备墙上时钟，未用签名校正后的服务器时间**
- 文件:行：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionExecutor.swift:25`、`:303`
- 问题：`DeviceActionExecutor` 默认 `now = Date.init`，`DeviceActionGate` 用这个时间与服务器下发的 `expiresAt` 比较。`DeviceHTTPClient` 里有服务器时钟偏差 `clockOffset`，但执行器拿不到。设备时钟慢会执行已过期动作，快会拒绝仍有效动作；`keepUntil` 的删除时机同样受设备时钟影响。
- 证据：
  ```
  25: now: @escaping @Sendable () -> Date = Date.init
  ```
  ```
  303: guard let expiry = delivery.expiry, expiry > now else { return .expired }
  ```
- 建议：把服务器校正后的时间注入执行器；至少不要让过期安全判断依赖用户可改的系统时间。

**5. 动作名是手抄的，且提醒动作名与仓库内规格不一致；没有 I-73 类型的生成/校验**
- 文件:行：`clients/apple/Sources/HimawariActions/ReminderActions.swift:7`、`clients/apple/Sources/HimawariActions/CalendarActions.swift:7`、`docs/execution/specs/2026-11-11-apple-device-body-design.md:524`、`:675`、`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionsDemo.swift:84-89`
- 问题：代码和演示用 `device_reminder.create` / `device_reminder.complete`，仓库规格写的是 `reminder.create` / `reminder.complete`。规格第 675 行还明确说动作名应由服务器清单生成 Swift、不能手抄，并要有检查；这个 PR 没有生成文件，也没有跨端名称检查。若 9A 服务端的登记表采用规格里的名字，提醒动作会全部被报「不支持」，设备策略里的 blocked 名也对不上。本条服务端名字未核实，但仓库内文档与代码已经不一致。
- 证据：
  ```
  ReminderActions.swift:7: public let names = ["device_reminder.complete", "device_reminder.create"]
  ```
  ```
  spec:524: | `reminder.create`、`reminder.complete` | ...
  ```
  ```
  spec:675: 感知记录的类型、动作名、上限的键这些“两边都要认”的值，由服务器仓库里的一份清单生成 Swift 代码，不手抄。清单变了而生成的代码没更新，检查失败。
  ```
- 建议：以 9A 登记表为准生成或校验动作名；至少加一个检查，把服务端 registry 的动作名和 Swift `names` 对齐；同时修正规格或代码中的 `reminder.*`/`device_reminder.*`。这正是 I-73 的「清单里的 id 能不能通过使用端校验」问题。

**6. 「还没问过权限」的中文指引指向了错误的设置分区**
- 文件:行：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionHandler.swift:141`、`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionViews.swift:383`、`:397`、`clients/apple/Sources/HimawariManage/Resources/zh-Hans.lproj/Localizable.strings:30-31`
- 问题：提示写「在 Himawari 的设置 › 它能替你做的 里点日历就能允许」，但「它能替你做的」是动作策略开关；系统权限行在「系统里允许的」分区。用户按提示去「它能替你做的」找不到「日历」，可能只改了策略，权限仍是 `notDetermined`。新测试还把这句话写死成期望值。
- 证据：
  ```
  DeviceActionHandler.swift:141: "Himawari 还没问过能不能用\(what)。在 Himawari 的设置 › 它能替你做的 里点\(what)就能允许"
  ```
  ```
  DeviceActionViews.swift:383: GroupedSection(Text(L.text("abilities.title"))) {
  DeviceActionViews.swift:397: GroupedSection(Text(L.text("abilities.system"))) {
  ```
  ```
  zh-Hans:30: "abilities.title" = "它能替你做的";
  zh-Hans:31: "abilities.system" = "系统里允许的";
  ```
- 建议：把「它能替你做的」改为「系统里允许的」，并说明点开后还要点「继续」；同步修改 `DeviceActionGateTests.swift:60` 的期望文案。或者把权限行放进提示所说的分区。

**7. 执行器核心逻辑没有常态自动检查；第 2 轮修复缺少对应测试**
- 文件:行：`clients/apple/Tests/HimawariCoreTests/DeviceActionServerTests.swift:76`、`:31`、`clients/apple/Tests/HimawariCoreTests/DeviceActionGateTests.swift:66-73`
- 问题：所有真正跑 `DeviceActionExecutor`、`DeviceActionJournal` 的用例都在 `DeviceActionServerTests`，整套带 `.enabled(if: controlURL != nil)`，默认 `swift test` 会跳过；仓库里也没有设置 `HIMAWARI_ACTION_CONTROL` 的地方。第 2 轮的 `checkingOnly` 测试只检查结构体字段复制，不验证 `readOnly` 守卫；`calendar.create`/`device_reminder.create` 的 `snapshot` 返回 `[:]`、Home 先校验后写入、`refused` 不重试/墓碑丢失都没有测试。因此「反向用例是否真的会失败」对这些改动无法回答。
- 证据：
  ```
  DeviceActionServerTests.swift:76: @Suite(.serialized, .enabled(if: controlURL != nil))
  DeviceActionServerTests.swift:31: let names = ["test.note.append"]
  ```
  ```
  DeviceActionGateTests.swift:66: @Test func checkingOnlyKeepsEverythingButTheMode() {
  ...
  69: #expect(checking.id == original.id)
  70: #expect(checking.arguments == original.arguments)
  71: #expect(checking.readBack == original.readBack)
  ```
- 建议：用 `MemoryLocalStore` + 假 `DeviceActionTransport` 增加常态单测，覆盖：`.started` 只核不重做、`readOnly` 守卫、`.recorded` 后同 id 再来、`refused` 过期前重试/过期后删除、坏日志、`calendar.create` 的 `snapshot`；再补「去掉守卫必须失败」的反向用例。

### 低

**8. 本地时间解析会静默接受带秒/时区的畸形输入**
- 文件:行：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionModels.swift:297-300`
- 问题：`split` 后用 `compactMap { Int($0) }` 会丢掉解析失败的片段。`2026-11-20T15:00:00Z` 会被解析成 15:00 本地时间（`"00Z"` 被丢掉，剩下 `[15, 0]`），`15:00:abc` 也会被接受为 15:00。如果服务器某天发带秒/时区的 ISO 时间，闹钟或日历会差几个小时，而不是报「参数读不懂」。
- 证据：
  ```
  297: let clock = parts[1].split(separator: ":").compactMap { Int($0) }
  298: guard clock.count == 2 else { return nil }
  ```
- 建议：严格按约定格式解析，拒绝多余的秒、时区后缀和任何非数字尾串，并补用例。

**9. 可诊断性和资源的小问题**
- 文件:行：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionExecutor.swift:93`、`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionModels.swift:31`、`clients/apple/Sources/HimawariActions/HomeActions.swift:17-20`
- 问题：`pass()` 的 `catch {}` 吞掉所有网络/日志错误，线上很难判断为什么没执行；`schemaVersion` 被解码但从未校验，未来高版本动作会被旧客户端继续执行；`homes()` 每次调用都创建一个 30 秒的计时 Task，重复调用会积累短期任务；日志除 `refused` 过期外没有清理上限。
- 证据：
  ```
  DeviceActionExecutor.swift:93: } catch {}
  ```
  ```
  DeviceActionModels.swift:31: public let schemaVersion: Int
  ```
  ```
  HomeActions.swift:17: Task { @MainActor [weak self] in
  18:     try? await Task.sleep(for: Self.loadLimit)
  19:     self?.waiting.removeValue(forKey: ticket)?.resume(returning: nil)
  20: }
  ```
- 建议：记录错误类别；对不认识的 `schemaVersion` 直接报「不支持」；只在线程真正等待时建计时器；给日志条目加保留上限。

## 推测 / 未核实

- **服务端 claim/open 语义**：作者说 claim 会返回 queued 和 result_unknown。我无法在仓库内验证 `delivered` 会不会超时变成 `result_unknown`。如果不会，问题 1 会从「依赖服务器兜底」变成「永久漏做」。
- **被拒结果的服务端语义**：`reportAction` 只把 400/404/409 当作 `refused`；2xx 但响应体不匹配、413、422、5xx 会抛错，`send` 吞掉后留下条目反复重试。这是推测，服务器契约不在仓库里。
- **审批确认密钥与挑战值**：规格第 497 行要求先用 `approvals/challenge` 取一次性挑战值再签；客户端 `DeviceAPI.respond` 直接把 `confirmSigner` 放进 RFC 9421 请求头，没有 challenge 步骤。是否满足 9A 服务端未核实。
- **Home 权限说明页可能被绕过**：`DeviceActionExecutor.supported()` 会调用 `HomePermission.status()`，进而 `HomeLoader.current` 创建 `HMHomeManager()`。如果 HomeKit 在创建时弹系统权限，说明页就被绕过；这是对 Apple 行为的推测，未在 Xcode/真机验证。
- **通讯录更新语义**：`ContactActions.perform` 用传入的 `phones`/`emails` 整体替换现有列表；如果服务端语义是追加/部分更新，会删掉其他号码；`readBack` 又要求数组顺序完全一致，可能把成功的更新报成失败。服务端 schema 未核实。
- **`ownerPresence`、`risk`、`reversible`**：客户端解码后在执行器里完全不用，是否足够安全取决于服务端审批；这部分未核实。
- **界面尺寸规则**：作者说尺寸颜色只能用 DesignTokens。颜色确实用了 `Color.hm*`/`DesignTokens`，但代码里仍有 `spacing: 16`、`padding(16)`、`18` 等字面尺寸；仓库里没找到对应规则文件，无法判定是否违规。

## 侧重检查

- **错误路径**：坏日志（`{not json`）会被 `lost` 当作重装；但「文件存在但读取失败」时 `lost` 返回假，随后 `load` 抛错、`pass` 整体被 `catch {}` 吞掉，会一直卡住而不是重装处理。`refused` 不重试、确认后删墓碑、重装先清空日志，这三处是本轮最值得改的错误路径。
- **不合规范/不可信输入**：每个 handler 都通过 `DeviceActionArguments` 做类型校验，未知动作报 `notSupported`，这点是对的；但 `schemaVersion` 不校验、`localDate` 会静默接受畸形时间、服务端 2xx 异常响应未区分。
- **安全**：本地日志通过 `FileLocalStore.write(..., .completeFileProtection)` 写入，目录设置 `isExcludedFromBackup = true`（`LocalStore.swift:18-21`、`:45-49`），这点符合设计；主要缺口是过期判断使用设备时钟、策略拉取失败时 `blocked` 默认为空（fail-open）。
- **资源耗尽**：`claim` 循环用 `seen` 避免同一轮死循环，这点有效；日志没有总量上限；`reportAction` 遇到非 400/404/409 会无限重试；Home 每次等待都建计时任务。
- **不可撤销操作**：日历删除、通讯录整表替换、门锁控制都可能有副作用；`snapshotBefore` 会存「之前的样子」，但客户端没有撤销实现，只能依赖服务端证据。Home 部分写入失败时已写入的部分不会回滚，读回失败还可能被报成成功。
- **规则、说明文档和代码一致**：本 PR 没有改提示词、工具定义、历史或遮盖，`prompt-prefix` 不受影响；动作名与规格不一致（`reminder.*` vs `device_reminder.*`）；权限提示指向错误分区；diff 里没有看到新增代码注释。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会（本仓库能看到的范围内）。`git diff a04ac279..cdd6b3b8` 只改了 `clients/apple`、测试和文档；没有系统提示、工具定义、历史消息或遮盖代码。新增的 `ChatStore.swift:343-349` 只是在收到 `.deviceActions` 时触发执行器，`DeviceEvents.swift` 只是新增事件枚举。设备动作的状态、`expiresAt`、结果文字都只进设备界面和服务端回报，不进本仓库的任何模型提示。服务端 9A 是否把结果作为「末尾追加的工具结果」发送，不在本仓库，未核实；按规格 `docs/execution/specs/2026-11-11-apple-device-body-design.md:651-654` 应只追加在末尾，不改前缀。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
模型请求：不会，本 PR 不参与模型请求组装。设备上报请求：不保证。`DeviceActionAPI.swift:26` 用的是没有 `.sortedKeys` 的 `JSONEncoder()`，而 `evidence` 里可能有无序的字典/数组（Home 状态、通讯录电话/邮箱顺序）；`reason` 还依赖设备当前语言。逻辑上服务端按 `id` 去重，所以不影响幂等，但如果服务端对请求体做摘要/日志，字节会不稳定。日志文件本身用了 `.sortedKeys`（`DeviceActionJournal.swift:95`），这一点是确定的。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
部分有，但不够。`DeviceActionGateTests` 是常态运行的纯函数测试，覆盖了过期、权限文案和 `checkingOnly` 结构复制；真正跑执行器的 `DeviceActionServerTests` 默认因 `HIMAWARI_ACTION_CONTROL` 未设置而跳过（`DeviceActionServerTests.swift:76`），且用的是合成动作 `test.note.append`，不是真实动作名。第 2 轮修的 `snapshot` 返回 `[:]`、`readOnly` 守卫、Home 先校验后写入都没有对应测试；`checkingOnly` 测试只看字段复制，不验证「核对时绝不重做」。因此这些改动没有「去掉守卫就失败」的反向证明。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**
逐个核对结果：
- 动作名 `calendar.create/delete/update`：handler、demo、Gate 测试一致，也和规格一致；`device_reminder.*` 与规格 `reminder.*` 不一致，服务端 9A 登记表未核实。没有生成/校验机制，是 I-73 类型风险。
- `expiresAt`：服务端产生，客户端 `DeviceActionTime.parse` 解析，解析失败按过期拒绝（`DeviceActionGateTests.swift:46-49`），这个方向是安全的。
- 结果字段 `id/outcome/readBack/evidence/reason`：客户端产生，服务端校验不在仓库；客户端只把 400/404/409 当作可处理的拒绝，其他 4xx/5xx 会无限重试。evidence 被 400 拒绝时会降级重发不带 evidence 的版本，代价是服务器失去「之前的样子」。
- 日志字段 `refused`、`keepUntil`：客户端内部值，只有执行器使用；`keepUntil` 来自服务器 `expiresAt`，受设备时钟影响。
- `permissionNotAsked`/`permissionUnavailable`：由 `DeviceActionGate` 产生，由 `DeviceActionReason.text` 使用；中文文案指向错误设置分区，测试还把错误文案固定下来。
- `readOnly`：只有 `HomeActions` 提供 `home.read`，由 `verify` 使用；没有测试覆盖「非 readOnly + readBack none 不重做」。
- `checkingOnly`：客户端产生，`process` 使用；只有结构复制测试，没有执行器行为测试。
- `supported` 上报清单：客户端排序后上报，但忽略服务端返回的过滤结果；服务端 registry 未核实。
- `schemaVersion`：解码后完全不用；未来高版本动作不会被拒绝。
- 状态值 `succeeded/failed/result_unknown`、未知状态/未知动作：结果界面能显示通用词和服务端文字，未知状态落到 `.other`，未知动作名由执行器报 `notSupported`，这两条符合作者说法，测试里也有未知状态解码用例。
