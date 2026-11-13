# PR 468 第 3 轮复核（f4cf1fb7..7794b580）

## 一、按严重度排列的发现

### 中

**1. 【已证实】状态不明页的“重试”和回前台自动重试会先闪一下等待页，再立刻回到状态不明页**
- 位置：`clients/apple/Sources/HimawariShell/AppModel.swift:76-78`、`:210-212`、`:228-248`、`:318-321`
- 问题：`restore()` 对 `.unrecognized` 直接进入等待并开始轮询；`retryReadingKeys()` 和 `becameActive()` 都调用 `restore()`。服务器再次明确拒绝时，`waitForConfirmation` 在第一次请求失败后立即改回 `.stateUnknown`，中间没有等待或退避，因此界面会从“状态不明”跳到“等确认”再跳回来。
- 证据：
  ```swift
  // AppModel.swift:76-78
  case .pending, .unrecognized:
      phase = .waitingForConfirmation(number: record.pairingNumber)
      waitForConfirmation()
  ```
  ```swift
  // AppModel.swift:210-212
  public func retryReadingKeys() {
      restore()
  }
  ```
  ```swift
  // AppModel.swift:318-321
  public func becameActive() {
      if phase == .unpaired(.keysUnreadable) || phase == .unpaired(.storageUnavailable) || phase == .unpaired(.stateUnknown) {
          restore()
          return
      }
  ```
  ```swift
  // AppModel.swift:243-247
  } catch {
      if let status = record?.status, ConfirmationWait.givesUp(waitingAs: status, after: error) {
          phase = .unpaired(.stateUnknown)
          return
      }
  }
  ```
  失败分支在休眠之前直接返回，所以服务器仍拒绝时这是“立刻”发生的，不是“重试一段时间后放弃”。
- 建议：给状态不明页和回前台做一条不切页的复查路径：保持 `.stateUnknown` 发起一次 `configuration()`；成功转 `.active`，明确收到 `DEVICE_PENDING` 再转等待页，其余错误继续留在状态不明页。这样仍会自动重试，但不会来回闪。

**2. 【已证实逻辑；影响取决于服务器实际错误形状】`givesUp` 把任意 4xx 都当成“设备状态被明确拒绝”，可能把 401/404/代理错误误报成“状态不明”，并把用户引向“清掉重新配对”**
- 位置：`clients/apple/Sources/HimawariCore/PairingDecisions.swift:39-42`
- 问题：只要本地记录是 `.unrecognized`，任何 400–499（除 408、429、`DEVICE_PENDING`）都会停止等待。401 签名/时钟问题、404 路由错误、Cloudflare/代理返回的无 JSON 403 也会进入 `stateUnknown` 页；该页同时提供会删除本机对话和密钥的“清掉，重新配对”。
- 证据：
  ```swift
  public static func givesUp(waitingAs status: PairedDeviceStatus, after error: Error) -> Bool {
      guard status == .unrecognized, case let .server(code, reason, _)? = error as? DeviceAPIError else { return false }
      return (400..<500).contains(code) && code != 408 && code != 429 && reason != "DEVICE_PENDING"
  }
  ```
  本机记录只在成功时更新：
  ```swift
  // AppModel.swift:236
  try? save(record.map { var updated = $0; updated.status = .active; return updated })
  ```
- 建议：不要用“4xx + 本地状态不认识”推断服务器在报告状态。优先只认设备状态相关的明确错误码（例如服务器专门返回的状态码），至少把 401、404 和没有 `code` 的错误排除在“停止等待”之外；删除数据仍是用户确认后的动作，但提示不应把普通鉴权失败说成“服务器给了不认识的状态”。

### 中低

**3. 【已证实】“不认识的阶段不再一直想”只覆盖“未知阶段 status 是最后一条记录”的情况**
- 位置：`clients/apple/Sources/HimawariCore/Execution.swift:159-162`
- 问题：新分支只检查 `sorted.last`。如果未知阶段的 `status` 后面还有任意记录（例如一条消息或另一条已知阶段的记录），且此前没有可显示的 tool 步骤，仍会落到 `.thinking`，继续闪“在想”。如果此前有步骤，则显示的是旧的当前步骤，而不是这条未知状态。
- 证据：
  ```swift
  if let latest = sorted.last, latest.phase == .unrecognized, latest.kind == .status {
      return .working(current: ProcessStep(id: latest.itemId, title: Self.present(latest.activity) ?? latest.name, icon: .puzzle, phase: .unrecognized, startedAt: latest.occurredAt, endedAt: latest.occurredAt), setback: nil)
  }
  guard let current = steps.last else { return .thinking }
  ```
  另外这里的 `setback: nil` 会顺带隐藏之前失败/不可用步骤的提示。
- 建议：既然目标是“未知阶段不转圈”，应在 `steps` 之外单独找最近的未知状态记录，或者至少对“最新未知阶段记录之后只有消息/已知状态”的情况也返回非闪动的通用步骤；补一条“未知 status 后面再跟一条记录”的反向用例。当前作者的说法在字面上与代码一致（明确说“最新一条”），但没有完全覆盖“新阶段不再一直在想”的目标。

### 低

**4. 【已证实】本地 `record.status == .pending` 时，服务器后来把设备改成不认识的状态，客户端仍会无限等待**
- 位置：`clients/apple/Sources/HimawariCore/PairingDecisions.swift:39-42`、`clients/apple/Sources/HimawariShell/AppModel.swift:244`
- 问题：`givesUp` 只看本地保存的状态。配对时是 `.pending`、之后服务器状态变成未知的设备，本地仍是 `.pending`，因此任何 4xx 都不会让它停止等待。只有配对响应/本地记录一开始就是 `.unrecognized` 的设备才被覆盖。
- 证据：
  ```swift
  guard status == .unrecognized, ...
  ```
  ```swift
  if let status = record?.status, ConfirmationWait.givesUp(waitingAs: status, after: error) {
  ```
- 建议：明确这是本轮的已知边界；如果要覆盖“pending 后来变成未知”，需要服务器在错误里给出设备状态，客户端据此更新本地记录，或让 `givesUp` 能识别“这不是 `DEVICE_PENDING` 的拒绝”。

**5. 【已证实】自动检查没有覆盖新加的状态页和若干反向分支**
- 位置：`clients/apple/Tests/HimawariCoreTests/ServerValueTests.swift:99-117`
- 问题与证据：
  - `aStatusRecordWithANewPhaseStopsTheThinkingSpinner` 只断言 `phase` 和 `title`，没有断言 `icon == .puzzle`；把图标改错不会失败。
  - `ConfirmationWait` 用例覆盖了 403 正向、`DEVICE_PENDING`、503、429、`URLError`、本地 `.pending`，但没有覆盖代码明确排除的 408，也没有覆盖 401/404/无 `code` 的 4xx。
  - 没有测试 `AppModel` 从 `.stateUnknown` 重试/回前台时的状态流转，因此发现 1 的闪屏不会被测出来。
  - 没有测试 Info.plist 渠道为 `unrecognized` 时退回 `.direct`；现有测试只验证 `ReleaseChannel` 解码为 `.unrecognized`。
- 结论：两条核心纯函数（`ProcessLine.make` 的新分支、`ConfirmationWait`）的反向用例基本是真的：删掉新分支会退回 `.thinking`，把 `givesUp` 改成永远 false 或用例条件改错会失败。但 UI 接线、渠道回退和 408 等边界没有自动检查。
- 建议：补 408、401/404/无 code 的用例，补 `ProcessLine` 图标断言和“未知状态后还有记录”的用例；把 `.stateUnknown` 的重试决策提成可测的纯函数，或在 `HimawariCore` 里加状态机测试。

**6. 【已证实】设计文档的“新值清单”没有随这批新增值更新**
- 位置：`docs/execution/specs/2026-11-11-apple-device-body-design.md:696`、`:734`
- 问题：设计明确要求“每个新出现的值，都写明谁产生、谁使用、两端怎样校验、哪道检查守着”，但设备状态行仍只列 `pending`、`active`、`revoked`；本次新增的 `stateUnknown` 以及 8 个枚举的 `unrecognized` 哨兵值没有登记。虽然这些多数是客户端本地值、不跨服务器边界，但按这条规则仍应有说明。
- 建议：在文档里补一行客户端本地值/未知值回退，说明它们不发给服务器、只用于前向兼容和界面状态；如果认为这类内部哨兵不适用该表，也应明确写出例外。

## 二、推测／未核实

- 【推测】服务器实际会把“未知设备状态”表达成什么错误码、会不会带 `code`，未核实；如果服务器返回无 `code` 的 403，发现 2 的误报会更容易发生。
- 【推测】未知阶段的 `status` 后面是否还会继续发执行记录，取决于服务器事件顺序，未核实；发现 3 的实际触发频率因此不确定。
- 【未核实】作者声称的 `swift test` 107 条全过、`check:apple-design`、`check:glossary` 通过，本次只能使用 git/读文件，未运行验证。
- 【推测】旧的 App 版本读到本地持久化的 `"unrecognized"` 会解码失败，可能把恢复判断成 `.keysUnreadable`；正常 App Store 不降级，但 TestFlight 回退到旧构建时值得注意，本次未要求处理。

## 三、侧重检查

- **错误路径**：检查了 `waitForConfirmation` 的 `isRevoked` 优先分支、通用 catch、`givesUp` 的 4xx/408/429/`DEVICE_PENDING`、5xx、`URLError`、记录为空、配置解码失败。结论：撤销仍优先清本地；断网/5xx/限流继续等；但普通 4xx 的归类过宽，见发现 2；配置 JSON 解码失败仍会无限等待（`invalidResponse`，既有行为，未改）。
- **不合规范/不可信输入**：检查了 8 个服务器枚举的宽松解码、未知执行记录种类/阶段、未知消息角色、发布渠道构建值、服务器错误字符串。结论：未知值不会让整份列表解不出来；但 `unknown ThreadStatus → active`、`unknown MessageStatus → committed`、`unknown MessageRole → agent` 是语义上的“当成正常”，可能把部分/未知内容显示成普通回答，属于设计取舍，未见越权或秘密泄露。
- **安全/不可撤销操作**：`stateUnknown` 页与“存储打不开”共用模板，提供删除本机对话和密钥的“清掉，重新配对”，有确认对话框；主要风险是误把普通 4xx 当成设备状态未知，从而把用户引向该入口，见发现 2。
- **资源耗尽**：每次回前台或点重试只发一次 `config` 请求；`waiting?.cancel()` 会取消旧轮询，没有任务堆积。退出等待前不 sleep，因此不会形成快速循环，但会产生发现 1 的闪屏和每次前台一次请求。
- **规则/文档一致性**：计划 `docs/execution/plans/2026-11-11-apple-device-body-plan.md:101` 明确写“不动：网页、发给模型的任何内容”，与本次 diff 只在 `clients/apple` 一致；三种语言的 `pairing.problem.stateUnknown` / `.title` 键都存在且拼写一致；没有找到校验 iOS 三语言键齐全的自动检查；设计文档新值清单未更新，见发现 6。

## 四、必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加？**
不会。已核实本次提交只改了 `clients/apple` 下的客户端代码、测试和文案，没有改系统提示、工具定义、历史消息、遮盖或任何模型请求组装路径；计划也明确写“不动发给模型的任何内容”。因此“只在末尾追加、每轮会变的值只在最后一条消息”这一性质不受影响，本次改动不涉及该路径。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会。本次没有新增模型请求序列化。新增的宽松解码是逐值确定的：同一原始字符串总得到同一 `.unrecognized` 或固定 fallback，不依赖前后文、时间或无序集合；持久化的 `PairingRecord`/本地缓存写入也只是把固定的 `"unrecognized"` 写回，不进入模型请求。

**3. 改动有没有对应的自动检查？反向用例是否真的会失败？**
部分有。`ProcessLine.make` 新分支和 `ConfirmationWait` 有单元测试；删掉新分支会退回 `.thinking`，把 `givesUp` 改成永远 false 或用例条件改错会失败，这两条反向用例是真的。缺口是：状态不明页的重试/回前台流转、`ReleaseChannel` 回退 `.direct`、408/401/404/无 code、`ProcessLine` 的 `.puzzle` 图标都没有自动检查；`swift test` 也没有编译 `HimawariShell`，所以 `AppModel` 的接线未被测试覆盖。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**
逐个核对如下：
- `ReleaseChannel.unrecognized`：由解码和 Info.plist 产生；`AppModel.swift:47` 立刻把 `.unrecognized` 过滤成 `.direct`，唯一发给服务器的地方是 `AppModel.swift:153` 的配对请求，因此不会把 `"unrecognized"` 发给服务器。服务器只接受已知渠道（设计文档 `:702`），这里安全。
- `DeviceKind.unrecognized`：只由服务器响应解码产生；客户端发起配对时在 `AppModel.swift:151` 固定传 `.iphone`，不会回传服务器未知的种类。
- `PairedDeviceStatus.unrecognized`：由配对响应/本地持久化产生；在 `AppModel.restore` 和 `ConfirmationWait` 中消费，写回 `PairingRecord` 的字符串是 `"unrecognized"`，同一版本能读回。本版本内两端一致；旧版本降级兼容性未核实。
- `ExecutionRecordKind.unrecognized` / `ExecutionPhase.unrecognized`：由执行记录解码产生，只在 `ProcessLine`、`ProcessRowView` 和测试中消费，不发给服务器；两端都在客户端内，能接受。
- `ThreadStatus → .active`、`MessageRole → .agent`、`MessageStatus → .committed`：fallback 只进入本地展示和 `ThreadCache`，不发给服务器；从“不破坏解码”角度能接受。语义上把未知线程状态当活动、未知消息状态当已提交，属于宽松处理，不是校验两端不一致。
- `PairingProblem.stateUnknown`：只在 `AppModel.swift:245` 产生；`PairingView.swift:46` 和 `PairingView.swift:265` 的 `key` 都处理了，`switch` 是穷尽的；`pairing.problem.stateUnknown` 和 `.title` 在 en/ja/zh-Hans 三份 `Localizable.strings` 中都存在且键名一致。这一项两端完整。
