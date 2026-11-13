我先看改动本身和相关规则文件，确定要核对的问题。
# 复核报告：iOS 第 2 批客户端（clients/apple）

## 发现的问题（按严重度从高到低）

---

**1. 高 ｜ `clients/apple/Sources/HimawariCore/DeviceEvents.swift:100`、`:114` ｜ 吊销发生在“打开事件流”阶段时，客户端不会清数据、也不会回到配对页，只会无限退避重连**

读代码证实的证据链：
- `DeviceHTTPClient.openStream` 对非 2xx 一律抛 `DeviceAPIError.server(status: status, code: nil)`（DeviceAPIClient.swift:100），**不解析错误体里的 code**：
  ```swift
  guard (200..<300).contains(status) else { throw DeviceAPIError.server(status: status, code: nil) }
  ```
- `DeviceEventStream.run` 的重连循环只把 `isRevoked`（即 code == "DEVICE_REVOKED"）当作终局（DeviceEvents.swift:114）：
  ```swift
  } catch let error as DeviceAPIError where error.isRevoked {
      continuation.yield(.sessionInvalid); stop = true
  }
  ```
  code 为 nil 时 `isRevoked` 恒为 false（DeviceAPIClient.swift:29），于是走 `failures += 1` → 退避 → 永远重试。
- 对比非流路径 `perform`：401 之外的所有非 2xx 都经过 `Self.check` 解析 code（DeviceAPIClient.swift:199-203），所以 REST 调用能识别吊销，流不能。

后果：设备被吊销后，如果主连接正处于打开/重连阶段（例如吊销恰好在断网之后），客户端收不到 `sessionInvalid`，`AppModel.forget` 永远不会被调用——与计划文档第 2 批任务 5 的反向验收“网页吊销后手机回到配对页并清掉本地数据”相悖。附带同类问题：流打开阶段的 401 `DEVICE_SIGNATURE_CLOCK_SKEW` 也不会像 REST 那样纠正时钟，只会反复退避。

建议：在 `openStream` 里对失败响应体跑一次 `Self.check`/`serverTime` 一样的解析，把 code 带进 `DeviceAPIError`；或让 `run` 在拿到 `DeviceAPIError.server(status: 401/403, ...)` 时读一次响应体判 code。并补一条测试：openStream 返回 403 `DEVICE_REVOKED` 时必须发 `sessionInvalid` 且不再重连（现在这条会失败）。

---

**2. 高（中高）｜ `clients/apple/Sources/HimawariShell/PairingView.swift`、`clients/apple/Sources/HimawariShell/AppModel.swift:72-109` ｜ 扫码后不显示、不让用户确认目标服务器，构造的二维码可把手机配到任意 https 主机**

读代码证实：
- `PairingInvitation.parse` 只要求 `https` + host 非空 + 路径为空（Pairing.swift:52-58），不限制 host 是哪个已知服务器——这本身合理，但接着：
- `AppModel.pair(scanned:)` 解析成功后**立即**建密钥、`api.pair(...)`（AppModel.swift:77-89），中途没有任何“将配对到 `<host>`，确认？”步骤；`PairingView` 的等待页只显示核对数字（PairingView.swift:82-91），不显示 origin。
- 若恶意服务器直接返回 `"status":"active"` 的设备对象，`waitForConfirmation` 那道“数字核对”防线完全被跳过：`device.status == .active` 分支直接 `activate()`（AppModel.swift:97-98），随后聊天数据全部发往攻击者主机。

用户的保护只剩“把手机上显示的 6 位数字和真网站上显示的数字对一下”，而一旦对方返回 active，App 根本不给这个机会。这正是作者自己点名要查的问题，结论是：**存在该风险**。建议：在提交前展示 origin 主机并要求用户点一次确认；等待确认页显示主机名；对 `status == .active` 的直接配对也强制走同一确认界面。

---

**3. 中 ｜ `clients/apple/Sources/HimawariChat/ChatStore.swift:148-163`、`clients/apple/Sources/HimawariCore/DeviceAPI.swift:71-78` ｜ 对话详情永远只取第一页（≤200 条），`nextSequence` 字段解析了但从未使用，超过 200 条的老消息永远看不到**

读代码证实：
- `load(_ threadId:)` 调 `api.thread(threadId)`，默认 `afterSequence: 0`，且没有任何翻页代码：
  ```swift
  let detail = try await api.thread(threadId)   // ChatStore.swift:150
  ```
- 全仓库 grep `nextSequence`：只在 Models.swift:111 定义，零使用。每次收到 `thread.execution_changed` 都会用**同一第一页**整包替换 `details[threadId]`（ChatStore.swift:151）。

后果：长对话的第 201 条起的消息在手机上不可见；越刷新越确认“只有这么多”。作者声称的服务器约定“GET threads/{id}?after=N 每次最多 200 条”意味着必须翻页，客户端没做。

建议：`load` 从 `nextSequence` 起按 `after=` 续拉到头（或在 UI 明确截断提示），并给 `nextSequence` 写一条单测（现在这条测试缺失）。

---

**4. 中 ｜ `clients/apple/Sources/HimawariCore/DeviceEvents.swift:128`、`clients/apple/Sources/HimawariShell/AppModel.swift:203`、`:157-165` ｜ 心跳配置拿到之前（或一直拿不到时）活性看门狗窗口是 ∞，SSE 卡死永远检测不出来**

读代码证实：
- `HeartbeatSetting` 初始值是 `.infinity`（AppModel.swift:203），只有 `refreshConfiguration` 成功才赋值（AppModel.swift:161）；失败分支是空 `catch {}`（AppModel.swift:164）。
- 看门狗窗口 = `heartbeat() * 2 + 5`（DeviceEvents.swift:128）：
  ```swift
  let deadline = LivenessDeadline(window: { [heartbeat] in heartbeat() * 2 + 5 })
  ```
  ∞ 时 `Date().timeIntervalSince(last) > ∞` 永假，消费协程里的 `group.addTask` 看门狗分支（DeviceEvents.swift:145-151）永远不触发。

后果：`activate()` 时若 `GET config` 失败（弱网、服务器临时 5xx——非吊销错误被静默吞掉），`heartbeat.seconds` 保持 ∞；此后即使连接被静默断掉（服务器不关 TCP、不发心跳），客户端也不会重连，用户看到的是“在线但永远没有新消息”，直到下次手动 `becameActive()`。作者声称“心跳间隔来自 GET config、不许写死”这一点核实为真，但由此引出的 ∞ 退化没人处理。

建议：给 `HeartbeatSetting` 一个有限的兜底初值（如 30s），或在 ∞ 时不启用看门狗而是明确标记“配置未知”。

---

**5. 低 ｜ `clients/apple/Sources/HimawariCore/DeviceAPIClient.swift:166` ｜ URL 构造失败时静默回退到 origin 根路径**

读代码证实：
```swift
return URL(string: text) ?? origin
```
`threadId` 被直接插进 path（`"threads/\(threadId)"`，DeviceAPI.swift:74），含需转义字符的 threadId 会让请求打向 origin 根（签名 base 与实际 URL 一致，验签不报错，但打的接口全错）。服务器 threadId 正常不含这些字符，所以是健壮性问题。建议：解析失败直接 throw。

---

**6. 低 ｜ `clients/apple/Sources/HimawariCore/Outbox.swift:156`、`Sources/HimawariChat/ThreadCache.swift:22`、`Sources/HimawariCore/LocalStore.swift:18` ｜ 三处持久化失败被静默吞掉**

读代码证实：
```swift
try? store.write(name, try? JSONEncoder().encode(items))   // Outbox.swift:156
try? store.write(name, try? JSONEncoder().encode(snapshot)) // ThreadCache.swift:22
try? url.setResourceValues(values)                          // LocalStore.swift:18 备份排除标记
```
待发队列（作者重点关注的“不丢消息”）在写盘失败时内存照常推进，崩溃/杀进程即丢；`isExcludedFromBackup` 设置失败也不报。建议：至少记日志/在 UI 标出队列持久化失败。

---

**7. 低 ｜ `clients/apple/README.md:80` ｜ 文档说“致谢页用 `ThirdPartyLicense.all` 读出来显示”，但代码里没有任何界面使用它**

读代码证实：grep `ThirdPartyLicense` 全仓库只有定义（Icon.swift:47-66）和 README 一行；第 2 批没有任何致谢页。文档描述了尚不存在的功能，应注明“随设置页（第 11 批）接入”，否则后来者会以为已生效。

---

**8. 低 ｜ `clients/apple/Sources/HimawariShell/AppModel.swift:51-56` ｜ 恢复时密钥缺失会留下孤儿配对记录**

读代码证实：`restore()` 里 `guard let record, keys.exists(.device), keys.exists(.confirm) else { phase = .unpaired(nil); return }`——record 仍在钥匙串里，之后 `record` 属性会继续返回它；再次配对会覆盖（`keys.create` 先 delete），影响很小，但状态不一致。

---

**9. 低 ｜ `clients/apple/Sources/HimawariCore/Outbox.swift:107` ｜ 冲突重试计数与网络重试共用 `attempts`**

读代码证实：`attempts` 在每次发送前 +1（:96），网络失败不清零；一条消息先网络失败 3 次（`retryLater` 反复）再遇冲突时，`attempts(messageId) <= maximumConflictRetries`（3）已接近上限，可能在用户看到“发送失败”前少了一次应有的冲突重试。语义上应把“冲突改版重试”单独计数。

---

## 推测（未能验证）

- **SwiftUI / Swift 6 严格并发在真机 Xcode 上能否编译**：云端无法编译界面目标（Package.swift:21-34 按系统区分，属实）。我把所有非隔离类型过了一遍：`DeviceHTTPClient`、`DeviceEventStream`、`LivenessDeadline`、`FileLocalStore`、`HeartbeatSetting` 都是 `@unchecked Sendable` 且全部可变状态包在 `NSLock` 里，模式正确；`@MainActor` 的 `ChatStore`/`AppModel` 里跨界引用都用了 `@ObservationIgnored` 或锁保护；未发现明显的并发违规写法。**但这是人工审读结论，未经编译器证实。**
- **与 PR 404 服务器验签逐字一致**：本仓库没有任何服务器代码（grep `verifyDeviceRequest` 无结果）。fixture 由 `scripts/make-signature-fixture.mjs` **自行重实现**签名基础（make-signature-fixture.mjs:28-43），不是从服务器代码生成——它只能证明“客户端 ≡ 脚本”，证明不了“客户端 ≡ 服务器”。作者说手工用 verifyDeviceRequest 验过，本仓库内无法核实。
- en/ja 两个 Localizable.strings 的 key 与 zh-Hans 一一对应：只核对了 zh-Hans（键与代码里的 `L.text` 用键全部对上，含 `pairing.problem.*` 7 个、`chat.*`、`tab.*` 等），另两种语言未逐键核对。

---

## 侧重检查：从入口走到结束的普通使用流程及测试覆盖

走的流程（全部亲自读到）：`HimawariApp` → `HimawariRootView`（RootView.swift:13-26）→ `AppModel.init` `restore()` → `PairingView` 扫码 → `AppModel.pair(scanned:)`（建密钥→`api.pair`→存 PairingRecord→等确认/激活）→ `waitForConfirmation` 轮询 `GET config` → `activate()` 建 `FileLocalStore` + `ChatStore` → `ChatStore.start()`（outbox 监听任务、`events.start()` 主 SSE、`refreshThreads`）→ `ChatListView` → `ChatView`（`.task` 里 `watch` + `load`）→ 输入 → `submit` → `store.send` → `outbox.enqueue` + `flush` → `DeviceAPI.send`（签名 POST messages）→ 200 `thread.command_result` → `refreshThreads`；服务器侧经 SSE `thread.event` → `ChatStore.load` 刷新。

**有测试覆盖**（`Tests/HimawariCoreTests`，共 46 个 `@Test`，我逐个数过，与作者“46 条全过”的说法一致）：签名基础与向量、tampered base 反向用例、双标签 confirm、时钟偏差纠正一次/不无限重试、错误码透出、配对码解析拒绝用例（http 路径、路径带尾巴、code 长度、版本号）、核对数字向量与补零、`POST threads` 正文键集合、refs 去重与 100 分批、Outbox 八条（含同 messageId 重发、冲突改版、重启恢复）、SSE 解析跨 chunk/CRLF/注释、流式乱序/重叠/UTF-16 偏移拼装。

**没有测试覆盖的路径**（Linux 只编译 HimawariCore，以下在仓库内零测试）：
- `ChatStore` 全部：连接状态机、缓存加载/保存、`handle(event)` 各分支、`onSessionInvalid` 回调、`flushing` 互斥、消息排序（`listOrder`）。
- `DeviceEventStream`：重连退避、`device.reconnect`/`gateway.stream_error` 引发的行为、看门狗、cursor 持久化与 `after=` 续传（问题 1、4 都藏在这里）。
- `AppModel`：配对生命周期、吊销后 `forget` 清理是否彻底（计划任务 5 的两条验收完全依赖 Andy 的 Mac 手工走查）。
- 全部 SwiftUI 界面（连编译检查都没有）。

结论：单元测试把**纯函数层**护得很扎实（含反向用例），但作者点名的“断网、重连、吊销”恰恰集中在**零测试的编排层**，问题 1 和 4 就是这么漏出来的。

---

## 必答问题逐条回答

**1. 会不会改变模型已见过的请求开头？** 不会。读代码证实：`git diff --stat` 显示全部 109 个文件都在 `clients/apple/` 和 `docs/execution/plans/` 下，未触碰任何服务器、提示词、遮盖或历史代码；作者“不改服务器代码、不改发给模型的任何内容”的说法与 diff 一致。该规则（prompt-prefix.md）在此改动上无触发面。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会（就本次改动而言）。客户端不产出发给模型的字节。客户端自身的确定性我核对过：签名基础按固定组件顺序拼接（DeviceSignature.swift:43-69），`created`/`nonce` 是唯一的每次变化量且都在签名参数里；流式拼装按 offset 排序（StreamingReply.swift:22）；Outbox 严格 FIFO。

**3. 有没有对应的自动检查、反向用例会失败吗？** 读代码证实：有，且含反向用例（`tamperedBaseDoesNotVerify`、`repeatedSkewIsNotRetriedForever`、配对码六种拒绝、`createThreadRejectsAResultWithoutThreadId`）。作者称“改坏会失败（已试）”，我未运行，**未核实**。但覆盖范围止于 HimawariCore；“Swift 签名 → 服务器验签”方向没有自动化（fixture 只做 Node 签 → Swift 验 + 基础一致），编排层（ChatStore/DeviceEventStream/AppModel）零测试——本次发现的问题 1、4 均无检查会拦截。

**4. 产生的每个值，使用处都接受吗？** 逐值核对结果：
- `messageId`：产生于 `OutgoingMessage.newId()`（enqueue 一次），重发复用（OutboxTests 证实）；使用处只有 POST messages 正文。两端自洽；服务器去重属 PR 404，**未核实**。
- `requestId`（POST threads）：`ChatView.createRequestId` 固定于视图生命周期，失败重试复用同一 id（利于幂等）；正文键集合有测试钉死。✓
- `expectedRevision`：产生自线程 summary 的 `revision`，冲突时用 `latest.revision` 或 `latestRevision` 闭包回填；语义是否与服务器一致**未核实**（PR 404）。
- `cursor`：从事件 id 产生（含被跳过的 `device.scanned`），用于 `GET stream?after=`。✓（解码前保存 id，DeviceEvents.swift:135）
- `answerLocale`：枚举恰为 zh-CN|en|ja，匹配系统语言，默认 zh。✓
- `heartbeatSeconds`：来自 `GET config`，未写死。✓ 但其 ∞ 初值引出问题 4。
- `refs`（payloads/text）：去重 + 100 分批 + 空不发，有测试。✓（服务器要求的下限 1 由“空不发”等价满足）
- 配对核对数字：Swift 与 Node 脚本两个独立实现对同一公式（SHA-256("himawari-pairing-v1"‖SPKI‖SPKI) 前 4 字节大端 % 1000000，补零 6 位），有固定向量钉住。✓ 与服务器的第三实现对齐**未核实**。
- `nextSequence`：产生处（Models.swift:111）无使用处——这是本次唯一“产生后没人消费”的值，即问题 3。
