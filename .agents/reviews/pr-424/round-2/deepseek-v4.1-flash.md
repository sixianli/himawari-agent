复核范围：`10d590b00..4e612519b` 的增量，同时对照了 `5e06602..4e6125` 的全量改动、当前仓库里的服务端契约、规则文件和检查脚本。PR 404 的服务端分支不在本仓库，相关契约只能按本仓库代码标注“未核实”。

---

# 一、读代码证实的问题（按严重度）

## 1. 高：并发 flush 仍会丢消息，消息可无限停在“正在发送”

**文件：** `clients/apple/Sources/HimawariChat/ChatStore.swift:266-292`

**问题：** `flushAgain` 只在 `repeat ... while` 循环条件里被消费。如果第二个 `flush()` 在第一个 flush 已经退出循环、但还在 `await refreshThreads()` 时进来，它只会把 `flushAgain = true` 然后返回；外层 flush 恢复后直接结束，不会再看 `flushAgain`。新消息或自动重试就此丢失。

**证据：**
```swift
266: func flush() async {
267:     guard !flushing else {
268:         flushAgain = true
269:         return
270:     }
...
275:     repeat {
276:         flushAgain = false
...
282:     } while flushAgain && !deferred
...
290:     if delivered {
291:         await refreshThreads()
292:     }
```
`refreshThreads()` 是网络调用，窗口足够大。丢掉的那条消息在 outbox 里仍是 `.waiting`、`attempts == 0`，UI 会显示“正在发送”，之后没有连接事件时不会自动再发。

**建议：** 把 `refreshThreads()` 放进循环内，或在结束前再检查一次 `flushAgain`，例如：
```swift
defer {
    flushing = false
    if flushAgain { flushAgain = false; Task { await self.flush() } }
}
```
并补一条并发用例：一个 flush 卡在 `refreshThreads` 时再 enqueue/flush，第二条必须最终发出。

---

## 2. 高：密钥读取失败会不可逆清空配对记录和全部本地数据

**文件：** `clients/apple/Sources/HimawariShell/AppModel.swift:56-59`、`:271-288`；`clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:39-41`

**问题：** `restore()` 现在把“记录或密钥读不到”一律当成需要清理，调用 `forget()`。而 `keys.exists()` 对任何 Keychain 错误都返回 `false`，包括设备未首次解锁、`errSecInteractionNotAllowed`、临时 Keychain 故障；`record` 的读取同样对任何错误返回 `nil`。这会删除密钥、配对记录，并 `removeAll()` 掉对话缓存、待发消息和事件游标，且无法撤销。

**证据：**
```swift
57: guard let record, keys.exists(.device), keys.exists(.confirm) else {
58:     forget(problem: nil)
59:     return
60: }
```
```swift
39: public func exists(_ role: DeviceKeyRole) -> Bool {
40:     (try? readRepresentation(role)) != nil
41: }
```
```swift
278: try? store?.removeAll()
279: if store == nil, let fresh = try? FileLocalStore.applicationSupport(named: "himawari-device") {
280:     try? fresh.removeAll()
281: }
283: try? keys.delete(.device)
284: try? keys.delete(.confirm)
285: try? save(nil)
```
`readRepresentation` 只有 `errSecItemNotFound` 才是“真的没有”，其他错误是 `DeviceKeyError.keychain(status)`，但 `exists()` 把它们都吞了。

**建议：** 区分“确实不存在”和“暂时读不到”。只有在 `errSecItemNotFound` 且记录存在时才清理；锁定/临时错误应保留数据、显示可重试状态。至少不要在 `restore()` 里做不可逆删除。

---

## 3. 中：`loadExecution` 翻页没有“必须前进”校验，可死循环并无限增长内存

**文件：** `clients/apple/Sources/HimawariChat/ChatStore.swift:220-225`

**问题：** 每轮用 `records.map(\.sequence).max()` 作为 `after`，但没有校验服务器返回的 `nextSequence` 是否大于当前游标。服务器/代理若返回不前进的 `nextSequence`（或返回同 id 的记录），循环会一直发请求；`records` 还会按 id 去重后继续追加，最终是请求风暴 + OOM。对比 `fullThread` 是有这个保护的。

**证据：**
```swift
220: while true {
221:     let page = try await api.execution(threadId: threadId, runId: runId, afterSequence: records.map(\.sequence).max() ?? 0)
222:     let known = Set(records.map(\.id))
223:     records += page.records.filter { !known.contains($0.id) }
224:     guard page.nextSequence != nil, !page.records.isEmpty else { break }
225: }
```
`DeviceAPI.fullThread` 的保护：
```swift
109: while let next = page.nextSequence {
110:     guard next > after else { throw DeviceAPIError.invalidResponse }
```

**建议：** 记录本轮 `after`，要求 `page.nextSequence > after` 才继续；另设页数上限（服务端的同类逻辑是 100 页）。

---

## 4. 中：单个 deferred 会让整次正文加载失败，已取到的正文被丢弃

**文件：** `clients/apple/Sources/HimawariCore/DeviceAPI.swift:139-142`；`clients/apple/Sources/HimawariChat/ChatStore.swift:348-354`

**问题：** `guard deferred.count < batch.count else { throw }` 在 batch 只剩 1 个 ref、而服务器刚好推迟它时会成立，于是整个 `texts()` 抛错。`loadTexts` 用 `try?` 吞掉错误，之前已经解析出的几十条正文也不会合并，界面出现空白消息。这是“全部推迟视为无效响应”的直接副作用，但“只剩一个合法延后项”也被当成无效。

**证据：**
```swift
139: let requested = Set(batch)
140: let deferred = (page.deferred ?? []).filter { requested.contains($0) && page.items[$0] == nil }
141: guard deferred.count < batch.count else { throw DeviceAPIError.invalidResponse }
142: pending = deferred[...] + pending
```
```swift
353: guard let resolved = try? await api.texts(for: missing) else { return }
354: texts.merge(resolved) { _, new in new }
```

**建议：** 仅当“本轮没有任何进展”（既没有新解析项，也没有新的非 deferred 排空）才判定无效；允许单个 ref 继续延后，但要有总尝试次数上限，并把已解析结果返回或先合并再抛错。补一条“100 个里 99 个成功、最后 1 个 deferred”的反向用例。

---

## 5. 中：配对重试遇到 `DEVICE_PAIRING_CODE_USED` 会删掉可能已配对的密钥

**文件：** `clients/apple/Sources/HimawariShell/AppModel.swift:150-156`、`:161-165`；`clients/apple/Sources/HimawariCore/PairingRecord.swift:36`

**问题：** 第一次 `pair` 实际已成功但响应丢失（超时/5xx）时，`mayHavePaired` 会保留密钥。用户点“重试”复用同一个配对码；服务器若以“码已用过”回应，客户端把 409 判为不可重试，删除两把密钥。结果是服务器上留下一个已创建的设备，而本机密钥没了，只能重新生成配对码且留下孤儿设备。

**证据：**
```swift
151: if !Self.mayHavePaired(error) {
152:     keysMadeFor = nil
153:     try? keys.delete(.device)
154:     try? keys.delete(.confirm)
155: }
156: phase = .unpaired(PairingProblem.from(error))
```
```swift
163: if case let .server(status, _, _)? = error as? DeviceAPIError { return status >= 500 || status == 408 || status == 429 }
```
```swift
36: case "DEVICE_PAIRING_CODE_USED": return .codeUsed
```
这条路径完全没有测试；`AppModel` 属于 `HimawariShell`，该目标没有测试 target。

**建议：** 记录“本次配对码已经尝试过且可能成功”。在此前提下的 `CODE_USED` 应保留密钥并转为查询/等待确认，而不是删密钥；只有从未尝试过或明确无效的码才删除。补集成/单元测试。

---

## 6. 中：失败的运行会显示成“完成”，带勾图标

**文件：** `clients/apple/Sources/HimawariCore/Execution.swift:144-145`；`clients/apple/Sources/HimawariChat/ProcessRowView.swift:51-52`

**问题：** `make` 对 `failed` 和 `completed` 都返回 `.finished`，视图对 `.finished` 固定用 `.check`。`failed` 参数只用于触感，不影响显示。用户会看到“做了 N 件事 N 秒”加勾，而不是失败状态。

**证据：**
```swift
144: if terminalRunStatuses.contains(runStatus) {
145:     return runStatus == "cancelled" ? .stopped(steps: steps, seconds: seconds) : .finished(steps: steps, seconds: seconds)
```
```swift
51: case let .finished(steps, seconds):
52:     summary(icon: .check, steps: steps, seconds: seconds)
```

**建议：** 给 `ProcessLine` 增加失败终态（或把 `runStatus == "failed"` 传进视图），失败时用警示图标/颜色，不要复用完成态。

---

## 7. 中：`check-design` 的“散数值”规则漏掉页面里真实存在的大量字面量，测试反向用例也是假形式

**文件：** `clients/apple/scripts/check-design.mjs:41-44`；`test/tooling/apple-design-check.test.mjs:27`、`:51`

**问题：** 数值规则只匹配带冒号的参数标签：`size|cornerRadius|width|height|lineSpacing|fontSize|radius`。真实 SwiftUI 写法里的 `.padding(.horizontal, 18)`、`VStack(spacing: 10)`、`.animation(duration: 0.25)`、`.lineSpacing(8)`、`.cornerRadius(26)`、`.offset(x: 10)` 都检测不到。测试用 `.lineSpacing(lineSpacing: 8)`（实际 API 没有这个标签）冒充反向用例，还明确把 `.padding(.horizontal, 20)` 当作合法写法。当前页面代码里仍有大量这类字面量，`check:apple-design` 照样通过。

**证据：**
```js
41: {
42:     code: "number-literal",
43:     pattern:
44:       /\b(?:size|cornerRadius|width|height|minWidth|minHeight|maxWidth|maxHeight|lineSpacing|fontSize|radius)\s*:\s*-?\d/u,
45: },
```
```js
27:     ".lineSpacing(lineSpacing: 8)",
...
51:     ".padding(.horizontal, 20)",
```
页面中的实际例子（都未被拦）：
- `ChatView.swift:35` `VStack(spacing: 0)`
- `ChatView.swift:50` `.animation(.easeInOut(duration: 0.2), ...)`
- `ChatView.swift:113-115` `.padding(.horizontal, 20)`、`.padding(.top, 84)`、`.padding(.bottom, 110)`
- `PairingView.swift:58` `VStack(spacing: 0)`、`:65-72` `.padding(.vertical, 12)`、`.padding(.horizontal, 18)`、`spacing: 10`

**建议：** 要么把规则扩到位置参数和常见修饰符（`padding`、`spacing`、`duration`、`offset`、`shadow`），要么明确把“padding 等布局值允许写死”写进规则，别让材料宣称它拦住了“散数值”。反向用例要使用真实 API 形式；并补一条“当前页面代码里有字面量时必须失败”的测试。

---

## 8. 中/低：配置没取到前心跳是 `infinity`，静默断流永远不会被判失败

**文件：** `clients/apple/Sources/HimawariShell/AppModel.swift:301`；`clients/apple/Sources/HimawariCore/DeviceEvents.swift:112`、`:196-198`

**问题：** `HeartbeatSetting` 默认 `.infinity`，而 liveness 窗口是 `heartbeat * 2 + 5`。在 `GET config` 成功之前（或一直失败时），`expired()` 永远为 false。材料说“连上没收到数据的算失败”，但这只在配置加载后才成立；如果流是半开且配置一直取不到，就永远不重连。

**证据：**
```swift
301: private var value: TimeInterval = .infinity
```
```swift
112: let deadline = LivenessDeadline(window: { [heartbeat] in heartbeat() * 2 + 5 })
...
196: func expired() -> Bool {
197:     lock.withLock { Date().timeIntervalSince(last) > window() }
```
**建议：** 这是“不写死兜底值”的取舍，但需要承认该窗口内没有 liveness 保护；可以在配置到达前只依赖 TCP/URLSession 超时，或把“未配置”作为显式状态处理，并补测试。

---

## 9. 低：`waiting` 取“任意最后一个 waiting 步骤”，不是最后一步

**文件：** `clients/apple/Sources/HimawariCore/Execution.swift:147-148`

**问题：** 只要历史里有一个 item 的最新 phase 是 `waiting`，即使它后面已经有更新的步骤，也会持续显示“等点头”，把当前活动藏掉。`ProcessLineTests.waitingForApprovalWins` 正是把这个行为固定下来的：记录 `a=waiting` 后又有 `b=started`，测试仍断言 `.waiting(a)`。如果服务器在审批通过后不为同一个 item 补发非 waiting 记录，就会一直卡在等待态。

**证据：**
```swift
147: if let waiting = steps.last(where: { $0.phase == .waiting }) {
148:     return .waiting(waiting)
149: }
```
测试：`ProcessLineTests.swift` 的 `waitingForApprovalWins`。

**建议：** 至少要求 waiting 就是 `steps.last`，或 waiting 之后没有任何更新的非 waiting 步骤；并确认服务器在恢复后会补发该 item 的新 phase。

---

## 10. 低：`fullThread` 对“空页 + 非空 nextSequence”静默截断，且无页数/内存上限

**文件：** `clients/apple/Sources/HimawariCore/DeviceAPI.swift:105-117`

**问题：** `if page.messages.isEmpty { break }` 会在服务器不一致时把不完整历史当完整历史返回；同时循环只防“不前进”，没有最大页数或总条数限制，异常服务器可以让客户端一直下载。`fullThread` 还会把整条线程所有消息留在内存，并在 `load` 里对所有 contentRef 发正文请求。

**证据：**
```swift
109: while let next = page.nextSequence {
110:     guard next > after else { throw DeviceAPIError.invalidResponse }
111:     after = next
112:     page = try await thread(threadId, afterSequence: next)
113:     let known = Set(messages.map(\.messageId))
114:     messages += page.messages.filter { !known.contains($0.messageId) }
115:     if page.messages.isEmpty { break }
116: }
```
**建议：** 空页但 `nextSequence != nil` 应报 `invalidResponse`；增加最大页数/条数上限。`runs` 只取最后一页在当前服务端是安全的（`readDetailSnapshot` 每页都返回全部 runs），但至少补一条“后续页 runs 为空也不能丢 runs”的测试，防止服务端以后分页。

---

## 11. 低：Mac 上设备名为空白时会回退成 “iPhone”

**文件：** `clients/apple/Sources/HimawariCore/Pairing.swift:98`、`clients/apple/Sources/HimawariShell/AppModel.swift:294`

**问题：** `AppModel` 在 macOS 上把 `Host.current().localizedName ?? "Mac"` 传进去，但名字只含空白时 `deviceName` 返回固定 `"iPhone"`，平台写错。

**证据：**
```swift
98: return name.isEmpty ? "iPhone" : name
```
**建议：** 让调用方提供平台兜底名，或按 `DeviceKind` 决定回退值。

---

## 12. 低：文档/原型路径仍是 v1，代码和 tokens 已指向 v2

**文件：** `clients/apple/README.md:4`；`docs/execution/plans/2026-11-11-apple-device-body-plan.md:95`；`clients/apple/scripts/check-design.mjs:16`

**问题：** README 和计划写“界面照 `2026-11-12-v1`”，而设计常量来源、检查脚本和材料都是 `2026-11-12-v2`。规则/文档与代码不一致。

**证据：**
- `README.md:4`：`界面照 ... 2026-11-12-v1/ 做`
- `check-design.mjs:16`：`docs/assets/apple-clients/2026-11-12-v2/tokens.json`

**建议：** 同步更新文档，或明确 v1 是原型、v2 是 tokens 来源。

---

# 二、推测 / 未核实（跨仓库契约，重点）

以下都不是本仓库能最终确认的，PR 404 分支不在本地；但按 I-73 的教训，客户端消费的字段必须在服务端找到产生处。

## A. 高（若 PR 404 未同步扩展则为高）：`activity` / `activityIcon` 及 `waiting` 工具记录在本仓库服务端不存在

**客户端：** `Execution.swift:100` 只把 `kind == .tool` 的记录当步骤；`:123-124` 用 `activity` / `activityIcon` 作为标题和图标。
**本仓库服务端：**
- `packages/gateway-contracts/src/thread-contracts-v3.ts:587-606` 的记录字段只有 `id, sequence, itemId, kind, phase, name, text, input, output, occurredAt`，没有 `activity` / `activityIcon`；而且 `object()` 会把未知字段当 `unknown field` 拒绝。
- `packages/application/src/services/thread-execution-projection.ts:451-460` 的 `kind: "tool"` 记录 phase 只有 `started` / `completed` / `failed`；`runtime.suspended` 产生的 `waiting` 是 `kind: "status"`（`:471-484`）。

**后果：** 用当前仓库的服务端，过程行拿不到“正在……”的句子/图标，标题会退化为工具名（如 `web_search`），`.waiting` 状态和审批触感永远不会触发。客户端的 `ProcessLineTests` 手工构造了带 `activity` 和 `kind: tool, phase: waiting` 的记录，`executionPageDecodesServerRecords` 也手写了这两个字段，但这些字段在当前服务端 schema 中没有产生者。

**建议：** 对照 PR 404 确认：`threadExecutionRecordSchema` 是否新增 `activity`/`activityIcon`，投影是否把审批等待写成 `kind: tool` 的 `waiting` 记录。若没有，客户端要么改成从 `kind: status` 的 `runtime.*` 记录推导，要么先不做进程行。补一条端到端测试：真实服务端记录 → 客户端解码 → `ProcessLine`。

## B. 高（格式不一致时）：`pairingNumber` 的格式假设

**客户端：** `AppModel.swift:135-138` 要求服务器返回的字符串与 `PairingNumber.digits(...)` 完全相等，即 6 位 ASCII 数字、无空格；而 UI 展示用的是带空格的 `display(...)`（`Pairing.swift:85-88`）。
**未核实：** PR 404 的 `PairedDeviceInfo.pairingNumber` 是 6 位纯数字、带空格的展示串，还是别的表示。若带空格或不是字符串，客户端会抛 `invalidResponse`，再被 `PairingProblem.from` 映射成 `.unreachable`，用户会看到“检查网络”，而且每次重试都失败。
**建议：** 两端统一为同一个机器可读格式（纯 6 位数字），用 `display` 只在 UI 加空格；补跨端契约测试。

## C. 中：`pairingCodeTtlSeconds` 的 JSON 字段名与语义

**客户端：** `DeviceAPIClient.swift:215`、`PairingRecord.swift:35`。本仓库没有该服务端实现，无法核对字段名、单位（秒）、以及是否只在 `DEVICE_PAIRING_CODE_EXPIRED` 时返回。
**建议：** 在 PR 404 的错误体契约里显式登记该字段，并用真实响应跑一条解码测试。

## D. 中：设备名“64 码点”与 JS 服务端的长度定义可能不一致

**客户端：** `Pairing.swift:92-98` 按 Unicode scalar 截 64 个。测试只用 BMP 汉字，未覆盖 emoji/扩展字符。
**风险：** 如果服务端用 JS 的 `string.length`（UTF-16 code unit）或字节数校验，64 个 emoji 在服务端会是 128 个 code unit，请求被拒。
**建议：** 确认服务端 `name` 的校验口径；测试加入 emoji、组合字符，并保证截断不会拆散 grapheme cluster。

## E. 中/低：`.completeFileProtection` 让锁屏后的后台写入失败

**文件：** `LocalStore.swift:38`
**事实：** 从 `UntilFirstUserAuthentication` 改为 `completeFileProtection` 后，设备一旦锁屏，缓存、outbox、事件游标的写入/读取都可能失败，而调用方大量使用 `try?` 吞错（`Outbox.persist:154`、`ThreadCache.save:22`、`StoredCursor.save:82`）。这不会直接丢已落盘数据，但锁屏期间的状态更新会静默丢失。
**建议：** 明确这些文件是否需要在锁屏后读写；若不需要，保持现状；若需要，改用 `completeUnlessOpen`/按文件分类保护，并至少记录写入失败。

---

# 三、侧重检查

我按你给的侧重逐项查了这些路径：

- **错误路径：** `DeviceHTTPClient.openStream` 的错误体读取、401 时钟重试、403 吊销识别（`DeviceAPIClient.swift:99-119`）；`DeviceEventStream.run/consume` 的失败计数（`DeviceEvents.swift:103-126`）；`AppModel` 的配对失败、配置重试、回前台（`AppModel.swift:111-269`）；`Outbox.flush` 的 4xx/408/429 分类（`Outbox.swift:89-145`）。结论：时钟重试一次、吊销识别和错误码保留是对的；发现 flush 丢唤醒、loadExecution 死循环、单 deferred 整批失败、配对重试删密钥等问题。
- **不合规范或不可信输入：** 二维码 origin 的 scheme/host/user/password/query/fragment/path 校验（`Pairing.swift:49-63`）；`pairingNumber` 比对；`deferred` 中不属于本批的 ref 被过滤（`DeviceAPI.swift:139-140`）；设备名截断/空白；执行记录字段。结论：origin 校验明显加强；`deferred` 过滤方向正确；其余契约需对照 PR 404。
- **安全：** 账号/查询/片段拒绝已实现；配对码/密钥没有日志输出；`keys` 与记录仍存 Keychain；本地文件保护加强。未发现新的密钥泄漏路径。
- **资源耗尽：** 错误体上限 16 KB（`DeviceAPIClient.swift:97`）；`texts` 的“全部 deferred”保护存在；但 `loadExecution` 无前进校验、`fullThread` 无页数/内存上限、`executions`/`details`/`texts` 无淘汰，长线程会累积内存和请求。
- **不可撤销操作：** `forget()` 会删密钥、配对记录、缓存和 outbox；`restore()` 在密钥读取失败时直接走到这里，是本次最危险的路径。吊销后清数据本身符合需求，但“暂时读不到”不应等同“已吊销/密钥丢失”。
- **规则/文档一致性：** 客户端没有组装模型请求、没有出口遮盖代码，因此 `prompt-prefix` 规则本身不直接约束这次改动；但 README/计划和 tokens 版本号不一致；`check-design` 的宣称与实际拦截范围不一致；过程行字段与当前服务端契约不一致。

---

# 四、必答问题

## 1. 会不会改变模型已经见过的请求开头？

**本次客户端改动不会。** 在 `clients/apple` 里没有系统提示/工具定义/历史消息的组装代码，也没有出口遮盖代码；客户端只调用设备接口：

- 发消息的 body 只有 `messageId`、`threadId`、`expectedRevision`、`text`（`DeviceAPI.swift:160-171`），`OutgoingMessage.createdAt` 没有发送；
- 其余是 GET 线程详情、POST `payloads/text`、执行记录/事件流，都是读接口或新的用户消息；
- 每轮会变的值（`retryFailures`、`Date()`、连接状态、执行记录、TTL、配对编号）只在本机或 UI 使用，不会进入模型请求。

因此客户端仍然是“只在末尾追加新的用户消息”。**但**服务端 PR 404 不在本仓库，无法核对它是否改了提示词或历史组装；这一点标“未核实”。

## 2. 会不会让同一段文字在不同请求里变成不同的字节？

**就模型请求而言，没有发现新的不确定性。** 理由：

- 客户端没有遮盖逻辑，也没有把 `texts` 取回的正文回传给模型；不存在“依赖前后文的遮盖”。
- 服务端返回的文字只用于显示，不进入模型请求；显示排序（线程列表）还新增了 `updatedAt` 相同按 `threadId` 的稳定 tie-break（`ChatStore.swift:361-370`）。
- 请求参数里的 `created`/`nonce` 每次不同，但这是签名元数据，不是模型内容（且改动前就有）。
- `DesignTokens` 生成器对颜色、阴影、标量、字号都排序（`make-design-tokens.mjs`），生成文件是确定的。
- 唯一没定序的是 `fullThread` / `loadExecution` / `ProcessLine.steps` 按 `sequence` 排序；服务端 sequence 唯一，正常不会产生并列。若服务端出现重复 sequence，排序结果不稳定，但这仍是 UI 顺序，不是模型字节。

## 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有覆盖，但不够，而且本次最核心的两个新行为没有测试。**（我只能读代码推断，不能运行 `swift test`/`npm run check`。）

已有且反向有意义：
- `fullThreadStopsWhenNextSequenceDoesNotMoveForward`：去掉 `next > after` 会从“抛错”变成继续请求，测试会失败。
- `textsStopWhenTheServerDefersEveryRef`：去掉全 deferred 保护会无限循环。
- `streamRefusedAsRevokedEndsTheEventStreamWithSessionInvalid`：去掉错误体/错误码保留会得到 `.disconnected`。
- `streamCorrectsTheClockOnceWhenTheServerSaysSkewed`、`repeatedSkewIsNotRetriedForever`：对应 401 只纠正一次。
- `earlierNetworkFailuresDoNotUseUpConflictRetries`：用旧的 `attempts` 计数会失败。
- origin 反例、设备名截断、ProcessLine、HapticPolicy、tokens-stale 都有直接用例。

缺失或虚假：
- **没有** `ChatStore` 的任何测试：自动重发退避、并发 flush 不丢、`transcript` 过程行位置、`loadExecution` 翻页都未覆盖。因此第 1 条的丢唤醒不会被测试发现。
- **没有** `AppModel` 测试：`mayHavePaired`/密钥保留、`CODE_USED` 重试、`pairingNumber` 不一致、配置退避、`restore` 清理都不在测试里。
- **没有** 连上但收不到数据的 liveness 测试。
- **没有** “单个 deferred”的测试。
- `check-design` 的反向用例 `.lineSpacing(lineSpacing: 8)` 不是真实 API；`.padding(.horizontal, 20)` 被明确接受。所以它通过并不能证明页面代码里没有散数值；当前页面代码确实有大量未被拦的值。

## 4. 每个新值/改动的产生端和使用端都能接受吗？

**已核对一致的：**
- `DeviceAPIError.server` 的第三个关联值：产生端 `DeviceHTTPClient.check`（`DeviceAPIClient.swift:220-223`），使用端 `code`/`isRevoked`/`PairingProblem.from`/`Outbox.flush`/测试都已改成三参数模式，未发现漏改。
- `PairingProblem.codeExpired(ttlSeconds:)`：产生端 `PairingRecord.swift:35`，使用端 `PairingView.swift:223-240` 和测试都已适配。
- `ThreadDetail` 自定义 init：只被 `fullThread` 使用，参数齐全。
- `AppPhase.confirmingServer`：`PairingView` 的 switch 覆盖了全部 phase，`RootView` 只判断 `.active`，不会漏 case。
- `DesignTokens` 新键：`Palette.swift`/页面引用的 `hr*`、`Size.*`、`Pairing.*`、`Scanner.*` 都在生成的 `DesignTokens.swift` 中存在；`Palette` 旧枚举删除后未发现悬空引用。
- `TranscriptItem.id` / process `runId`：`ChatView` 的 `ForEach` 直接使用，类型和唯一性成立（同一 run 只插入一次 process）。
- `host` 字符串：产生端 `AppModel.host`，使用端确认页/等待页，格式一致。

**不能确认或两端不一致的：**
- `PairedDeviceInfo.pairingNumber`：服务端产生端不在本仓库；客户端要求 6 位纯数字（见推测 A/B）。
- `ExecutionRecord.activity` / `activityIcon`：客户端消费，但当前服务端 schema/投影没有产生端（见推测 A）。
- `pairingCodeTtlSeconds`：客户端消费，服务端字段名/语义未核实。
- 设备名 64 “码点”：客户端产生端按 scalar 截断，服务端校验口径未核实。
- `.completeFileProtection`：写入端改成更严格的保护，读取/写入端（outbox、缓存、游标）都在后台可能失败，消费端只 `try?` 吞错。

**结论：** 本次改动在客户端内部的值大多两端一致，但有两个关键新值是“客户端已经消费、服务端产生端在本仓库看不到”的：`pairingNumber` 的精确格式和 `activity`/`activityIcon`（以及 waiting 工具记录）。这两处必须拿 PR 404 的实际实现补齐核对，否则正是 I-73 说的“只看 diff、没问清单里的值能不能通过另一端校验”。
