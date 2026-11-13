说明：本轮在读完关键客户端代码和 PR404（`102f6248`）服务端接口后到达工具步数上限，未再调用工具。以下结论基于已读内容；未核实的地方会标明。

# 复核结论（`5e06602..10d590b`，并对照 PR404 `102f6248`）

## 一、读代码证实的问题（按严重度）

### 1.【高】长对话永远只加载最早 200 条，`nextSequence` 被完全丢弃

- 文件：`clients/apple/Sources/HimawariChat/ChatStore.swift:148-159`、`clients/apple/Sources/HimawariCore/DeviceAPI.swift:71-78`、`clients/apple/Sources/HimawariCore/Models.swift:107-112`
- 问题：PR404 的 `GET /threads/{id}` 固定 `limit: 200`，并在还有更多消息时返回 `nextSequence`；客户端每次都从 `after=0` 取第一页，且从不读取/使用 `nextSequence`。超过 200 条的对话永远只显示 sequence 1..200，新消息和自己刚发出的消息在详情里都不出现。每次收到 `thread.event` 重新 `load` 也只是重复拉第一页。
- 证据：
```swift
// ChatStore.swift:148-159
public func load(_ threadId: String) async {
    do {
        let detail = try await api.thread(threadId)
        details[threadId] = detail
        ...
        if detail.runs.allSatisfy({ ["completed", "failed", "cancelled"].contains($0.status) }) {
            streaming[threadId] = nil
        }
```
```swift
// DeviceAPI.swift:71-78
public func thread(_ threadId: String, afterSequence: Int = 0) async throws -> ThreadDetail {
    let data = try await http.send(DeviceRequest(
        method: "GET",
        path: "threads/\(threadId)",
        query: [URLQueryItem(name: "after", value: String(afterSequence))]
    ))
    return try decode(GatewayEnvelope<ThreadDetail>.self, data).payload
}
```
```swift
// Models.swift:107-112
public struct ThreadDetail: ... {
    public let thread: ThreadSummary
    public let messages: [ThreadMessage]
    public let runs: [ThreadRunSummary]
    public let nextSequence: Int?
}
```
- 建议：循环 `after = nextSequence` 直到 nil，按 `sequence` 合并页面而不是整体覆盖；流式输出结束、消息提交后也走同一套增量加载。

### 2.【高】密钥缺失或记录损坏时不清旧缓存，重新配对会把旧对话显示出来，旧待发消息可能发往新服务器

- 文件：`clients/apple/Sources/HimawariShell/AppModel.swift:51-56`、`72-108`、`136-150`；`clients/apple/Sources/HimawariChat/ChatStore.swift:44-51`、`215-217`
- 问题：`restore()` 只要记录在但某把钥匙不在，就直接进入未配对，不清理 `himawari-device` 目录、配对记录和剩余钥匙。之后重新配对时 `activate()` 仍打开同一个固定目录，`ChatStore.init` 会加载旧的 `threads-cache.json` 和 `outbox.json`；旧对话会显示，旧待发消息在 `.connected` 时用新服务器的凭据 flush 出去。旧消息正文会先被发到新服务器，再因 threadId 不存在而失败。
- 证据：
```swift
// AppModel.swift:51-56
private func restore() {
    guard let record, keys.exists(.device), keys.exists(.confirm) else {
        phase = .unpaired(nil)
        return
    }
```
```swift
// AppModel.swift:139
let store = try FileLocalStore.applicationSupport(named: "himawari-device")
```
```swift
// ChatStore.swift:44-51
outbox = Outbox(store: store)
cache = ThreadCache(store: store)
...
let snapshot = cache.load()
threads = snapshot.threads
texts = snapshot.texts
details = snapshot.details
```
```swift
// ChatStore.swift:215-217
case .connected:
    connection = .online
    await flush()
```
- 建议：`restore` 任何不能继续使用旧记录的分支都调用 `forget`（清目录、钥匙、记录）；缓存目录按 origin 或 deviceId 隔离；新配对保存记录前先清旧数据和旧队列。

### 3.【中高·安全】配对二维码的 `origin` 没有固定、白名单或显示确认

- 文件：`clients/apple/Sources/HimawariCore/Pairing.swift:51-58`、`clients/apple/Sources/HimawariCore/DeviceAPIClient.swift:124-139`
- 问题：服务端生成二维码时只写入自己的 `publicOrigin.origin`，但客户端接受任意 `https` 主机（只检查路径为空或 `/`），也不向用户显示主机、更不固定首次配对后的 origin。伪造/替换二维码可以让 App 配对到攻击者主机，之后所有消息都发给该主机；攻击者服务器还能拿到设备公钥并自行显示相同的 6 位核对数字，因此“电脑上核对数字”防不住这种替换。
- 证据：
```swift
// Pairing.swift:51-58
guard envelope.v == 1 else { throw ParseError.unsupportedVersion }
guard
    let origin = URL(string: envelope.origin),
    origin.scheme == "https",
    origin.host != nil,
    origin.path.isEmpty || origin.path == "/",
    envelope.code.range(of: "^[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil
else { throw ParseError.malformed }
```
```swift
// DeviceAPIClient.swift:128-139
let url = Self.url(origin: credentials.origin, path: request.path, rawQuery: rawQuery)
...
let target = DeviceRequestTarget(
    method: request.method,
    authority: Self.authority(credentials.origin),
    ...
```
- 建议：至少拒绝 userinfo、query、fragment；配对页显示 `origin.host` 并要求用户与电脑端显示的地址一致；首次配对后把 origin 固定下来，换服务器要显式确认。更好的做法是让服务器用可验证的身份（证书/签名）绑定二维码，而不是只靠扫码即信任。

### 4.【中】事件流握手失败时丢弃错误码，吊销后重连可能长期不清本地数据

- 文件：`clients/apple/Sources/HimawariCore/DeviceAPIClient.swift:97-101`、`clients/apple/Sources/HimawariCore/DeviceAPIClient.swift:29`、`clients/apple/Sources/HimawariCore/DeviceEvents.swift:114-119`、`clients/apple/Sources/HimawariShell/AppModel.swift:171-173`
- 问题：PR404 对已吊销设备的普通请求返回 403 `DEVICE_REVOKED`；但 `openStream` 对所有非 2xx 一律抛 `code: nil`，而 `isRevoked` 只认 `code == "DEVICE_REVOKED"`，所以握手阶段的 403 永远不会被识别为吊销，只会退避重试。运行中的流被吊销时服务器会在心跳复查后发 `IDENTITY_SESSION_INVALID`，这条路径是通的；但“离线期间被吊销、回前台只重连流”的路径不会被清的，`becameActive()` 只调 `chat.reconnect()`，不刷新 config/threads。
- 证据：
```swift
// DeviceAPIClient.swift:97-101
public func openStream(_ request: DeviceRequest) async throws -> AsyncThrowingStream<String, Error> {
    let urlRequest = try await signed(request)
    let (status, chunks) = try await exchange.stream(urlRequest)
    guard (200..<300).contains(status) else { throw DeviceAPIError.server(status: status, code: nil) }
    return chunks
}
```
```swift
// DeviceAPIClient.swift:29
public var isRevoked: Bool { code == "DEVICE_REVOKED" }
```
```swift
// DeviceEvents.swift:114-119
} catch let error as DeviceAPIError where error.isRevoked {
    continuation.yield(.sessionInvalid)
    stop = true
} catch {
    failures += 1
}
```
- 建议：`openStream` 读取错误体并保留服务端 code；或在 `run` 里把流建立时的 403 一律按“需要刷新配置/可能是吊销”处理。重连时也应刷新一次 `GET config`。顺带：`openStream` 也没有像普通请求那样处理 401 `DEVICE_SIGNATURE_CLOCK_SKEW` 的时钟校正。

### 5.【中】本地缓存的文件保护等级和设计文档不一致

- 文件：`clients/apple/Sources/HimawariCore/LocalStore.swift:37-41`、`clients/apple/Sources/HimawariCore/LocalStore.swift:14-18`、`:45-50`；设计文档 `docs/execution/specs/2026-11-11-apple-device-body-design.md:186`
- 问题：设计写的是“缓存的对话和记忆副本、待传队列……锁屏后读不到，不进系统备份”，代码用的是 `.completeFileProtectionUntilFirstUserAuthentication`，首次解锁后即使锁屏也仍可读。备份排除和清理失败还被静默忽略。
- 证据：
```swift
// LocalStore.swift:37-41
#if os(iOS) || os(watchOS)
try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
#else
try data.write(to: url, options: [.atomic])
#endif
```
```swift
// LocalStore.swift:14-18
var values = URLResourceValues()
values.isExcludedFromBackup = true
var url = directory
try? url.setResourceValues(values)
```
```swift
// LocalStore.swift:45-50
public func removeAll() throws {
    try lock.withLock {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names { try FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
    }
}
```
- 建议：按设计改为 `.completeFileProtection`（如果后台任务不需要锁屏访问）；备份排除失败要上报/记录；`removeAll` 失败不能让 `forget` 继续装作已清干净，至少记录并重试。

### 6.【中】初始 `GET config` 失败后心跳保持 `infinity`，半死连接永远不会被判死

- 文件：`clients/apple/Sources/HimawariShell/AppModel.swift:29`、`151`、`157-164`、`201-208`；`clients/apple/Sources/HimawariCore/DeviceEvents.swift:128`
- 问题：`HeartbeatSetting` 默认 `.infinity`，只在 `refreshConfiguration()` 成功时写入。`activate()` 只发一次刷新请求；失败后没有重试，`becameActive()` 只重连流不刷新配置。于是 App 离线启动后再联网时，若服务端下发的配置从未拿到，流检测窗口一直是无穷大，连接半死也不会重连。
- 证据：
```swift
// AppModel.swift:201-208
final class HeartbeatSetting: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = .infinity
```
```swift
// DeviceEvents.swift:128
let deadline = LivenessDeadline(window: { [heartbeat] in heartbeat() * 2 + 5 })
```
```swift
// AppModel.swift:151
Task { await refreshConfiguration() }
```
- 建议：配置失败后按退避重试；流重连时也刷新 config；把无穷大默认值换成有限值，至少在拿到配置前也能发现死连接。

### 7.【中】可重试失败后没有自动重发，消息可能永远显示“发送中”且没有手动重试入口

- 文件：`clients/apple/Sources/HimawariCore/Outbox.swift:116-124`、`:136-140`；`clients/apple/Sources/HimawariChat/ChatStore.swift:197-211`；`clients/apple/Sources/HimawariChat/ChatView.swift:170-187`
- 问题：`Outbox` 对网络错误/408/429/未知错误只把状态改回 `.waiting` 然后 `return`；`ChatStore.flush` 没有安排任何定时重试。只有 `.connected`、场景重新激活、用户再次发送/手动调用才会触发下一轮 flush。若 SSE 连接一直在线而只有 `POST /messages` 失败（例如 500、429 nonce store full、解码错误），消息会一直停在 waiting。UI 对 `.waiting`/`.sending` 只显示“发送中”，重试/丢弃按钮只在 `.failed` 时出现，用户无法手动恢复。
- 证据：
```swift
// Outbox.swift:116-124
} catch let error as DeviceAPIError {
    if case let .server(status, code) = error, (400..<500).contains(status), status != 408, status != 429 {
        result = .rejected(messageId: message.messageId, code: code)
    } else {
        result = .retryLater
    }
}
```
```swift
// Outbox.swift:136-140
case .retryLater:
    update(message.messageId) { $0.state = .waiting }
    results.append(result)
    return results
```
```swift
// ChatStore.swift:197-211
func flush() async {
    guard !flushing else { return }
    flushing = true
    defer { flushing = false }
    let results = await outbox.flush(using: api) { ... }
    ...
}
```
```swift
// ChatView.swift:170-187
case .failed:
    ... Retry ... Discard ...
case .waiting, .sending:
    Text(L.text("chat.queued.sending"))
```
- 建议：给 `.waiting` 队列加指数退避自动重试；把可重试失败显示成“等待重试”并允许手动重试；补一条“SSE 仍在线但 POST 失败”的自动重发测试。

### 8.【中】配对请求结果不确定时删除密钥，留下服务端 pending 孤儿并消耗一次性配对码

- 文件：`clients/apple/Sources/HimawariShell/AppModel.swift:76-107`
- 问题：`pair` 对所有错误都在 `catch` 里删除两把密钥。若服务器已经成功 redeem 配对码、但响应在网络上丢失/超时，手机端已经删掉密钥，重新扫码只会得到 `DEVICE_PAIRING_CODE_USED`；网页上会留下一个公钥不对应任何本机密钥的 pending 设备。这是一次不可逆的配对码消耗。
- 证据：
```swift
// AppModel.swift:78-79
try keys.create(.device)
try keys.create(.confirm)
...
// AppModel.swift:103-107
} catch {
    try? keys.delete(.device)
    try? keys.delete(.confirm)
    phase = .unpaired(PairingProblem.from(error))
}
```
- 建议：把网络/超时这类不确定失败和明确的 4xx 失败分开；不确定失败保留本轮生成的密钥和 invitation，允许重试或转入等待网页确认；服务器最好支持带 `requestId` 的幂等 pair。

### 9.【低中】`ChatStore.flush` 的 `flushing` 守卫会丢弃并发 flush 请求

- 文件：`clients/apple/Sources/HimawariChat/ChatStore.swift:180-186`、`:197-211`
- 问题：发送路径先 `enqueue` 再 `flush`；如果另一个 flush 正在 `await`，后进来的 `flush` 直接 `return`。若前一个 flush 以 `.retryLater` 返回，或恰在最后一次查找 waiting 项之后结束，新消息会留在队列里，直到下一个 `.connected`/场景激活/用户操作。
- 证据：
```swift
// ChatStore.swift:180-186
public func send(_ text: String, in threadId: String) async {
    ...
    await outbox.enqueue(...)
    await flush()
}
```
```swift
// ChatStore.swift:197-199
func flush() async {
    guard !flushing else { return }
    flushing = true
```
- 建议：用 actor 串行化 flush，或加 `needsFlush` 标志，在退出前再检查一次 waiting 队列。

### 10.【低】设备名长度未在客户端校验，服务器的“配对请求无效”被显示成“配对码不对”

- 文件：`clients/apple/Sources/HimawariShell/AppModel.swift:85`；`clients/apple/Sources/HimawariCore/PairingRecord.swift:33-39`
- 问题：客户端直接发送 `UIDevice.current.name`。PR404 的 pair 校验要求名字 trim 后不超过 64 个 Unicode 字符，否则返回 `DEVICE_PAIRING_REQUEST_INVALID`；客户端把这个 code 映射成 `.codeInvalid`，用户看到“这个码不对”，实际是设备名太长。
- 证据：
```swift
// AppModel.swift:85
name: Self.deviceName,
```
```swift
// PairingRecord.swift:33-39
if let api = error as? DeviceAPIError, case let .server(status, code) = api {
    switch code {
    ...
    case "DEVICE_PAIRING_CODE_INVALID", "DEVICE_PAIRING_REQUEST_INVALID": return .codeInvalid
```
- 建议：客户端按 64 个字符截断/校验名称；把 `DEVICE_PAIRING_REQUEST_INVALID` 单独提示，不要显示成码错误。

### 11.【低】服务器返回的 `CreatedThread.threadRevision` 被丢弃，首条消息靠猜 revision

- 文件：`clients/apple/Sources/HimawariCore/DeviceAPI.swift:99-110`、`clients/apple/Sources/HimawariChat/ChatStore.swift:174-178`、`:183`
- 问题：`createThread` 已经解析出 `threadRevision`，但 `newThread` 只返回 threadId；随后 `send` 从 `details` 或 `threads` 找 revision，找不到就退回 `1`。我读到的 PR404 `admitOwnerMessage` 存储实现当前没有实际比较 `expectedRevision`，所以现在不会因此失败；但这是契约上的隐患，服务端一旦开始校验就会产生冲突/重试。
- 证据：
```swift
// DeviceAPI.swift:108-110
let payload = try decode(GatewayEnvelope<CommandResultPayload>.self, data).payload
guard let threadId = payload.threadId else { throw DeviceAPIError.invalidResponse }
return CreatedThread(threadId: threadId, threadRevision: payload.threadRevision)
```
```swift
// ChatStore.swift:174-178
public func newThread(requestId: String) async throws -> String {
    let created = try await api.createThread(...)
    await refreshThreads()
    return created.threadId
}
```
```swift
// ChatStore.swift:183
let revision = details[threadId]?.thread.revision ?? threads.first(where: { $0.threadId == threadId })?.revision ?? 1
```
- 建议：`newThread` 返回 `CreatedThread`，首条消息直接使用服务器返回的 revision；同时把 `details` 的 revision 更新。

### 12.【低】服务器返回的 `pairingNumber` 被忽略，客户端改用本地重算

- 文件：`clients/apple/Sources/HimawariCore/DeviceAPI.swift:57-58`、`clients/apple/Sources/HimawariCore/Models.swift:22-29`、`clients/apple/Sources/HimawariShell/AppModel.swift:90-94`
- 问题：PR404 的 pair 响应里 pending 设备自带 `pairingNumber`，客户端 `PairedDeviceInfo` 不建模它，而是用本地公钥重算。当前算法和测试向量一致；如果服务器以后规范 SPKI 或改算法，网页显示和手机显示会悄悄不一致。
- 证据：
```swift
// AppModel.swift:90-94
let number = PairingNumber.display(
    devicePublicKey: try deviceKey.publicKeySPKI(),
    confirmPublicKey: try confirmKey.publicKeySPKI()
)
```
- 建议：pending 时优先使用服务器返回的 `pairingNumber`，本地计算只作为校验/兜底。

### 13.【低】`refreshThreads` 对 `nextCursor` 没有重复游标保护

- 文件：`clients/apple/Sources/HimawariChat/ChatStore.swift:129-146`
- 问题：如果服务端错误或恶意地反复返回同一个 `nextCursor`，客户端会无限请求并不断累积 `collected`。当前服务端实现不会这样，但客户端对不可信/有 bug 的响应没有上限。
- 证据：
```swift
repeat {
    let page = try await api.threads(after: cursor)
    collected += page.threads
    cursor = page.nextCursor
} while cursor != nil
```
- 建议：记录已见 cursor 或限制页数，异常时停止并保留旧列表。

### 14.【低】加载失败被静默吞掉，用户可能看到空白消息而不是错误状态

- 文件：`clients/apple/Sources/HimawariChat/ChatStore.swift:242-255`、`clients/apple/Sources/HimawariChat/ChatView.swift:78-91`
- 问题：`handle(_ error:)` 只处理 `DEVICE_REVOKED`；`loadTexts` 用 `try?` 丢弃错误。`MessageRow` 的 `text` 为 nil 时直接渲染空字符串，所以文本请求失败时用户只看到空消息气泡，没有重试或错误提示。
- 证据：
```swift
// ChatStore.swift:242-246
private func handle(_ error: Error) async {
    if let error = error as? DeviceAPIError, error.isRevoked {
        onSessionInvalid()
    }
}
// ChatStore.swift:253
guard let resolved = try? await api.texts(for: missing) else { return }
```
- 建议：区分“文本还没加载”和“加载失败”；显示可重试状态。

### 15.【低】持久化写失败被静默吞掉，编码失败时甚至会删除旧文件

- 文件：`clients/apple/Sources/HimawariCore/Outbox.swift:155-158`、`clients/apple/Sources/HimawariChat/ThreadCache.swift:21-23`、`clients/apple/Sources/HimawariCore/LocalStore.swift:30-43`
- 问题：`try? store.write(name, try? JSONEncoder().encode(items))` 外层吞掉写盘错误；内层编码失败时传入 `nil`，`LocalStore.write` 会删除文件。消息队列/缓存的持久化失败不会被用户或日志看到。
- 证据：
```swift
// Outbox.swift:155-158
private func persist() {
    try? store.write(name, try? JSONEncoder().encode(items))
    for observer in observers.values { observer.yield(items) }
}
```
- 建议：把“删除”和“编码/写盘失败”分开；写失败保留旧文件并上报。

### 16.【低】线程列表同 pinOrder/updatedAt 时没有稳定 tie-breaker

- 文件：`clients/apple/Sources/HimawariChat/ChatStore.swift:140`、`:261-268`
- 问题：服务端按 `pin_order, updated_at DESC, id` 排序，客户端重新排序时只比较 pinOrder 和 updatedAt，且 Swift 的 sort 不保证稳定；相同键的线程顺序可能抖动。只影响界面，不影响模型。
- 证据：
```swift
switch (left.pinOrder, right.pinOrder) {
case let (l?, r?): return l < r
case (_?, nil): return true
case (nil, _?): return false
default: return left.updatedAt > right.updatedAt
}
```
- 建议：最后加 `left.threadId < right.threadId` 作为 tie-breaker。

### 17.【低】流连接建立成功就重置失败计数，服务器刚连上就断开时会快速重连

- 文件：`clients/apple/Sources/HimawariCore/DeviceEvents.swift:111-122`、`:168-171`
- 问题：`openStream` 成功即 `failures = 0`；如果服务器返回 200 后立刻断开（而不是发 `device.reconnect`），客户端每 0.5 秒重连一次，可能造成请求/nonce 压力。
- 证据：
```swift
let chunks = try await http.openStream(...)
failures = 0
continuation.yield(.connected)
stop = try await consume(...)
...
await pause(seconds: Self.backoff(failures: failures))
```
- 建议：区分“握手成功”和“持续收到数据”，连续短连接也参与退避；或对短命连接设置最小退避。

## 二、推测（本环境不能运行 Swift/Xcode，未核实）

1. **`Hashing.swift:19` 可能是编译错误**：`RandomNumberGenerator.next()` 按 Swift 标准库返回 `UInt64`，这里直接赋给 `[UInt8]` 的元素需要显式转换：
```swift
bytes[index] = generator.next()
```
如果 Swift 6.2 没有额外的泛型 `next<T>() -> T` 重载，这段编译不过，会直接推翻“46 条全过”。请在云端或 Mac 上实际跑 `swift test`/`swift build` 确认。这是推测，不是已证实的运行结果。

2. **`RelativeTime.swift:3-8` 的 `static let parser: ISO8601DateFormatter`**：`ISO8601DateFormatter` 是否是 `Sendable` 取决于 SDK；Swift 6 严格并发下可能报静态属性并发安全错误。建议改为 `@MainActor` 或每次调用创建。未核实。

3. **平台声明与界面 API 不完全一致**：`Package.swift:46` 声明 `.watchOS(.v26)`，但 `PairingView`/`RootView` 使用 `.fullScreenCover`，`Palette.swift` 在 watchOS 没有 UIKit/AppKit 分支。若真的为 watchOS 构建界面目标可能编译失败。当前 App 目标只 iOS，可能没有触发。未核实。

4. **`URLSessionExchange.stream` 的 `AsyncBytes`/`Task`** 在 Swift 6 Sendable 检查下是否通过未核实；这是 Apple-only 路径，Linux 测试覆盖不到。

5. 作者说“Swift 签的请求（含 confirm 双标签）用 PR404 的 verifyDeviceRequest 验过”。我逐字对照了 PR404 的 `signatureBase`、components 顺序、`@query` 空值、authority、content-digest/content-type、params/nonce/created/alg/tag、confirm 同基同 nonce，**代码层面一致**；但实际运行验签结果未核实。

## 三、侧重检查

- **签名/请求**：逐项对照 PR404 `verifyDeviceRequest`，组件顺序、`@query` 的空值写法、authority 大小写、body digest、content-type、keyid/nonce/created 的格式、双标签 confirm、nonce 复用规则都一致。发现两个流相关缺口：`openStream` 非 2xx 丢错误码、流握手不做 401 时钟偏差重试。
- **不可信输入/配对**：配对码 22 位、设备名、SPKI base64、origin 都从二维码来。origin 未固定是主要安全问题；origin 里的 query/fragment/userinfo 也未拒绝，可造成畸形 URL 或把请求引到非预期路径。设备名未做客户端长度校验。
- **不可逆操作**：配对码一次性，客户端在超时/响应丢失时删密钥，会留下服务端 pending 孤儿并让用户只能重新生成码；`forget` 清本地数据本身是预期的不可逆操作。
- **安全存储/清理**：设备/确认密钥与配对记录（含 Cloudflare 服务令牌）在 Keychain，`ThisDeviceOnly`；本地缓存排除了备份但文件保护等级弱于设计；`removeAll` 和备份排除失败被静默忽略；缺 key 时不清理旧缓存。PR404 的 `sendJson` 设置 `cache-control: no-store`，所以没有把 `URLCache` 当作主要残留点。
- **错误/重试/资源**：409 被归为失败不再重试（符合约定）；messageId 在重发时保持不变（符合去重）；4xx/408/429 分类正确；但 `.retryLater` 没有自动重试定时器，waiting 状态也没有手动重试入口。`refreshThreads` 无重复游标上限；`ThreadCache`/`Outbox` 无容量上限；`StreamingReply` 无累计文本上限；流连接失败计数会被一次成功握手重置。
- **规则/文档一致性**：本 diff 没有碰服务器、表、提示词、工具、历史、遮盖，和 `prompt-prefix` 规则不冲突；计划文档“不改服务器/不改模型内容”与 diff 一致；设计文档的文件保护描述与实现不一致；README 的图标线宽/脚本与 `icons.json` 一致；`Licenses` 和 `ThirdPartyLicense` 已生成但当前没有页面使用。
- **界面“摆设”**：本轮出现的扫码、关闭、返回、发送、新建对话、重发、丢弃、页签、设置入口都有实际行为；Today/Memory/Settings 是计划允许的占位页；未发现“能点但完全无功能”的新按钮；提交中的空白按钮是 disabled 状态展示。未发现把服务器心跳间隔等写死在界面里（心跳来自 config，问题是 config 失败后不重试）。未逐张对照原型图，像素/状态是否完全一致未核实。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个 diff 只新增 `clients/apple/` 和计划文档，不改服务器代码、表、系统提示、工具定义、历史、遮盖。客户端对现有对话只会调用 `POST /messages` 追加一条新的 owner 消息；`POST /threads` 只创建新对话并传 `requestId`/`answerLocale`。没有把时间、环境等每轮变化的值塞进系统提示或历史。客户端对输入做 `trim` 只影响新消息内容，不改变已经存在的请求前缀。依据 `prompt-prefix` 的“只追加”要求，结论是不改变。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对发给模型的内容：不会。客户端没有遮盖、压缩、历史改写；同一段正文在消息体里保持原样（只做了 trim）。
   对设备 API：会因 `nonce`、`created`、`messageId`、`expectedRevision` 等协议字段不同而整体请求字节不同，这是签名/去重协议要求，不是模型输入；同一 `messageId` 重发时文本字段不变。`ThreadCache`/`Outbox` 的本地 JSON 字典顺序等只落盘，不发给模型。配对核对数字是确定性的，不依赖前后文。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有，但不完整。已有的：Node 独立生成的签名固定向量、配对数字固定向量、配对 URI 反例（错 scheme/版本/http/路径/短码）、Outbox 网络失败/冲突/4xx/429/重启恢复、SSE 解析和事件名、API body 形状。改坏签名 base 或配对数字算法时，精确断言会失败；这一点成立。
   缺口：没有 ChatStore 的分页、首条消息 revision、flush 并发、自动重试测试；没有 AppModel 的吊销清理/缺 key 重配对测试；没有 DeviceEventStream 的游标续传、握手 403、心跳 infinity 测试；没有 Keychain/FileLocalStore 文件保护测试；confirm 签名没有服务器固定向量，只有自洽测试。作者“46 条全过”和 Mac/SwiftUI 编译未在本环境复跑，未核实。

4. **每个产生/修改的值，每个使用它的地方都能接受吗？**
   - 已逐项核对一致：`DeviceKind`、`ReleaseChannel`（PR404 常量是 `direct/testflight/app_store/mac_direct`）、`AnswerLocale`、`messageId`/`requestId`（16–64 位 base64url）、`pairingCode`（22 位）、`threadId`/payload ref（MACHINE_STRING）、签名组件和参数、`pairingNumber` 算法、SSE 事件名与游标、config 的 `heartbeatSeconds` 等。两端校验大体对齐。
   - 已确认的“产生但没被正确消费”：`ThreadDetail.nextSequence`（未使用，导致长对话分页失效）；`CreatedThread.threadRevision`（丢弃，首条消息猜 revision）；设备名（客户端不校验，服务端拒绝）；`origin`（客户端接受任意 https，服务端只生成自己的 canonical origin）；`DeviceConfiguration.connectionMaxSeconds`、`signatureToleranceSeconds`、`DeviceLimit.defaultValue/onExceed` 没有被 UI/业务消费（不一定是错，但配置面消费不完整）；`OutgoingMessage.createdAt` 没有发送给服务器（服务端用 `now()`，当前无影响）；服务器返回的 `pairingNumber` 被忽略（本地重算，当前一致）。
   - 结论：ID/签名/事件这类关键值的两端格式基本能对上，但“产出了却没人用/用错”的情况确实存在，最严重的是 `nextSequence` 和 `origin`/设备名。

## 五、剩余未完成/未核实

- 未运行 `swift test`、Xcode 构建或 PR404 的 `verifyDeviceRequest` 实际验签；环境只能读代码。特别是 `Hashing.swift:19` 的 `UInt64 -> UInt8` 和 Swift 6 严格并发下的静态 formatter，需要实际编译确认。
- 未逐张比对 `docs/assets/apple-clients/2026-11-12-v1/` 原型图，无法确认界面像素和所有状态完全照图。
- 未逐条统计测试数量（46）或查看 CI 日志。
- 本轮已达到工具步数上限；以上为已读代码能支持的结论，未读到的部分标为未核实。
