## 结论

改动本身不触碰模型请求开头，附件/感知记录都只会追加一条新的用户消息或走 `POST perception`。主要问题集中在：短信游标在 400 时静默前移、附件 requestId 在内容变更后复用、客户端依赖的服务器契约在本检出里完全无法核对，以及 Mac UI 的关键编排没有任何自动测试。

## 一、读代码证实的问题

### 1. 严重度：高

**位置：** `clients/apple/Sources/HimawariCore/MessageSensing.swift:117-128`、`clients/apple/Sources/HimawariMacUI/MessagesDatabase.swift:189-198`

**问题：** 整批 400 时逐条重发，被拒记录只放进返回值；调用方完全忽略返回值并前移游标。若 400 的原因是系统性契约不匹配（例如 `captureSource` 不在服务器允许清单、字段格式变了），整类短信会被永久跳过，界面还会把错误清成正常。

**证据：**

```swift
} catch DeviceAPIError.server(status: 400, _, _) where records.count > 1 {
    var skipped: [String] = []
    for record in records {
        do { _ = try await perceive([record]) }
        catch DeviceAPIError.server(status: 400, _, _) { skipped.append(record.id) }
    }
    return skipped
```

```swift
guard (try? await app.api.perceiveSkippingInvalid(records)) != nil else {
    settings.reportMessages(.cannotSend)
    return
}
guard settings.settings.seesMessages else { return }
after = last.rowId
settings.setMessagesAfterRow(after)
```

`skipped` 没有任何生产调用方；README 承诺“服务器还不收……设置页那一行都写明，不静默失败”，这条路径会静默成功。

**建议：** 区分“个别坏记录”和“整批被系统性拒绝”。若 `skipped.count == records.count`，不前移游标，报 `.cannotSend`/新的契约错误并留存被拒 id；只有确认是单条坏记录时才跳过。用 `outcomes`/`reached` 对账，并加“所有记录 400 时游标不动”的反向用例。

### 2. 严重度：高（若服务器端不在另一个已合入 PR，则为阻断）

**位置：** `clients/apple/Sources/HimawariCore/MessageSensing.swift:132-135`、`clients/apple/Sources/HimawariCore/DeviceAttachments.swift:9-17`、`clients/apple/Sources/HimawariCore/Models.swift:61`

**问题：** 作者列出的后端契约在本仓库里找不到另一端：`POST perception`、`POST attachments`、`GET config` 的 `attachments` 对象，以及 id/occurredAt/evidence/requestId 的服务器校验，都没有实现可对照。`git log --all --oneline --name-only -- "*perception*"` 只返回文档；全仓 grep 只找到客户端和 `device.perception.batch_records` 这个上限键。按 I-73 的教训，“清单里的 id 能通过后端校验吗”现在无法回答。

**证据：**

```swift
let data = try await http.send(DeviceRequest(method: "POST", path: "perception", body: try JSONEncoder().encode(Body(records: records))))
```

```swift
let data = try await http.send(DeviceRequest(method: "POST", path: "attachments", body: body))
```

```swift
public let attachments: AttachmentLimits?
```

`packages/gateway-contracts/src/contracts-v2.ts:520` 只登记了 `device.perception.batch_records` 这个上限键，没有感知记录请求体、附件请求体或 `attachments` 配置结构。

**建议：** 先合服务器第 3 批，或把服务器与客户端的契约做成共享 schema/生成代码，并加端到端测试：用真实服务器验签后的 `POST perception`、`POST attachments`、`GET config` 各跑一次正例和反例。合并前不要在 PR 里把未核对的契约写成“必须匹配”。

### 3. 严重度：中高

**位置：** `clients/apple/Sources/HimawariCore/MessageSensing.swift:45,84`

**问题：** `captureSource` 硬编码为 `"system_api"`。详细设计里“采集来源”要求由固定清单生成，清单例子只有设备麦克风、AirPods、随身麦克风等；仓库里没有 `system_api` 的登记处。若服务器按清单校验，每条 `message.text` 都会 400，然后被第 1 条静默丢掉。

**证据：**

```swift
public static let captureSource = "system_api"
...
captureSource: captureSource,
```

**建议：** 确认服务器允许的 `capture_source` 值；最好由共享清单生成 Swift 常量。加一条真实服务器契约测试：该值能被接受，未知值会被拒。

### 4. 严重度：中

**位置：** `clients/apple/Sources/HimawariMacUI/InputBarModel.swift:39-44,81-116`

**问题：** 输入条发送中再次叫出时，`begin` 只清 `draft/threadId/pendingRequestId/pieces`，既不取消旧 `Task`，也不重置 `sending`。旧任务完成后会写共享的 `draft = ""`、`pieces = []`、`pendingRequestId = nil`、`threadId = ...`，可能清掉新会话里刚输入的内容或把旧线程号带回新会话。

**证据：**

```swift
func begin(with snapshot: ContextSnapshot, seesFrontmost: Bool) {
    draft = ""
    problem = nil
    threadId = nil
    pendingRequestId = nil
    pieces = ...
}
```

```swift
Task {
    defer { sending = false }
    ...
    threadId = thread
    ...
    draft = ""
    pieces = []
    pendingRequestId = nil
}
```

**建议：** 给每次输入会话一个 generation 令牌，`begin`/`close` 时递增并取消旧任务；旧任务完成时若令牌不匹配就丢弃结果。至少在 `begin` 里把 `sending = false` 并取消旧任务。

### 5. 严重度：中

**位置：** `clients/apple/Sources/HimawariCore/DeviceAttachments.swift:25-33`、`clients/apple/Sources/HimawariMacUI/InputBarModel.swift:78-94`

**问题：** `pendingRequestId` 只在发送成功后清空。上传失败后用户可以删/加附件再按发送，但第 i 个附件仍用同一个 `requestId-i` 上传，内容已经变了。若服务器按 requestId 幂等去重，会返回旧 ref（把旧文件内容当新文件发出去），或因为“同键不同内容”永久拒绝，用户一直看到上传失败。

**证据：**

```swift
public static func attachmentRequestId(_ requestId: String, index: Int) -> String {
    "\(requestId)-\(index)"
}
```

```swift
let requestId = pendingRequestId ?? OutgoingMessage.newId()
pendingRequestId = requestId
let carried = pieces
```

```swift
attachments = try await api.attach(carried, requestId: requestId, limits: limits)
```

**建议：** 每个附件 id 加入内容摘要（例如 `requestId-index-sha256(content)`），保证同键同内容；或在附件集合/草稿变化时清掉 `pendingRequestId`，并在上传成功后把该次 id 固定到附件上。

### 6. 严重度：中

**位置：** `clients/apple/Sources/HimawariMacUI/MacSettingsStore.swift:105-112`、`clients/apple/Sources/HimawariMacUI/MessagesDatabase.swift:191-198`

**问题：** “关掉就忘掉读到哪里，再打开不补关着那段”在“发送 await 期间关掉再打开”时不成立。`setSeesMessages(false)` 把游标清成 nil，但在飞的 `tick` 在 await 返回后只检查 `seesMessages`（这时已经又被打开为 true），然后把旧批次末尾写回游标，下次从旧位置继续读，补上了关掉期间的消息。

**证据：**

```swift
func setSeesMessages(_ on: Bool) {
    settings.seesMessages = on
    if !on {
        settings.messagesAfterRow = nil
        messagesProblem = nil
    }
    save()
}
```

```swift
guard (try? await app.api.perceiveSkippingInvalid(records)) != nil else { ... }
guard settings.settings.seesMessages else { return }
after = last.rowId
settings.setMessagesAfterRow(after)
```

**建议：** 用一个“开关代数”（epoch）随每次开关递增；`tick` 在开始时记下 epoch，await 返回后 epoch 变了就不写游标。或者关掉时取消传感器任务，重新打开时强制走“从最新开始”的初始化。

### 7. 严重度：中

**位置：** `clients/apple/Sources/HimawariMacUI/MessagesDatabase.swift:90-93,116-117`

**问题：** 对 `chat.db` 的 `attributedBody` 直接使用 `NSUnarchiver.unarchiveObject(with:)`。这是不安全的旧式反序列化入口，且遇到 malformed 数据可能抛 Objective-C 异常，Swift 的 `try` 接不住，会让菜单栏 App 崩溃；这段还在 `@MainActor` 的 `MessagesSensor` 里同步执行。

**证据：**

```swift
static func attributedText(_ data: Data?) -> String? {
    guard let data, !data.isEmpty else { return nil }
    return (NSUnarchiver.unarchiveObject(with: data) as? NSAttributedString)?.string
}
```

```swift
@MainActor
final class MessagesSensor {
```

**建议：** 在后台任务里用受限的编码器（限定允许的类）解析，任何异常/格式不符都跳过该条并保留 text 为空；不要让反序列化异常穿过主线程。若做不到安全解析，宁可不读 `attributedBody`。

### 8. 严重度：中

**位置：** `clients/apple/Sources/HimawariCore/MacAccess.swift:115-135`

**问题：** 路径策略先 `standardizedFileURL`（按字面删掉 `..`），再 `resolvingSymlinksInPath()`。对 `/granted/link/../secret`（`link` 指向 `/outside/dir`），代码会把路径规范成 `/granted/secret` 并判定在授权内；而操作系统按原路径解析会得到 `/outside/secret`。如果将来的文件动作使用原始路径而不是返回值 `realPath`，就绕过授权。作者“先解开符号链接和 `..`”的说法与实际顺序不符。

**证据：**

```swift
let url = URL(fileURLWithPath: path).standardizedFileURL
var resolved = url.resolvingSymlinksInPath()
```

```swift
let base = URL(fileURLWithPath: folder).standardizedFileURL.pathComponents
let target = URL(fileURLWithPath: path).standardizedFileURL.pathComponents
```

**建议：** 按路径分段逐段解析符号链接并在解析后再处理 `..`（等价于对存在的祖先调用 `realpath`），并强制所有消费者只使用返回的 canonical 路径。加一条 `symlink + ..` 的反向用例。当前 `PathPolicy` 没有生产调用点，所以现在还不是可利用漏洞，但这是后续文件动作的安全前提。

### 9. 严重度：中

**位置：** `clients/apple/Sources/HimawariMacUI/InputBarModel.swift:58-60`、`clients/apple/Sources/HimawariCore/MessageAttachments.swift:42-44`

**问题：** `canSend` 要求草稿非空，导致只拖文件、不输入文字时无法发送；但 `compose` 和网页固定测试数据都明确支持 `text: ""` + 文件。

**证据：**

```swift
var canSend: Bool {
    !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}
```

```swift
public static func compose(text: String, attachments: [MessageAttachment]) -> String {
    ((text.isEmpty ? [] : [text]) + attachments.map(\.tag)).joined(separator: "\n\n")
}
```

**建议：** 改为 `!sending && (!draft.trimmed.isEmpty || !pieces.isEmpty)`，并补一条“只有附件”的 UI/unit 用例。

### 10. 严重度：中

**位置：** `clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:114-121`

**问题：** 每次点击都生成新的 `requestId`，且用 `try?` 吞掉网络错误。用户看到没反应自然会再点一次，服务器看到的是两个不同幂等键，同一个动作可能被执行两次。面板按钮对应的是审批/动作，属于不可撤销路径。

**证据：**

```swift
func respond(_ item: HomeItem, with action: HomeAction) {
    guard acting == nil else { return }
    acting = item.key
    Task {
        defer { acting = nil }
        try? await app.api.act(on: item, action: action, requestId: OutgoingMessage.newId())
        await refresh()
    }
}
```

**建议：** 为“条目 + 动作”保存稳定 requestId，成功或有确定结果前一直复用；失败要在面板上显示并允许用同一 id 重试，不能静默吞错。

### 11. 严重度：中

**位置：** `clients/apple/Sources/HimawariMacUI/InputBarModel.swift:47-49`、`clients/apple/Sources/HimawariMacUI/ContextReader.swift:16-40`、`clients/apple/Sources/HimawariMacUI/MessagesDatabase.swift:34,116`

**问题：** 拖入文件时在 `@MainActor` 上同步读每个文件（文本最多 8 MB，PDF/富文本还要解析）；`add(files:)` 没有数量或总量上限，也不拿 `perMessage`/`messageCharacters` 提前限制。短信数据库读取同样在主线程，`sqlite3_busy_timeout` 2 秒，批次上限来自服务器配置且没有本地夹紧。用户可以拖入大量大文件导致内存/界面卡顿，服务器配置异常时也可能一次读很大批次。

**证据：**

```swift
func add(files urls: [URL]) {
    let added = urls.filter(\.isFileURL).map { ContextGathering.filePiece($0, source: .droppedFile, reading: ContextReader.read($0)) }
    pieces = ContextGathering.merge(pieces, adding: added)
    problem = nil
}
```

```swift
sqlite3_busy_timeout(connection, 2000)
```

**建议：** 在 UI 层限制附件个数/总字节数；文件读取和 PDF 解析移到后台，读完后回主线程更新；短信数据库读取也移到后台 actor，主线程只处理结果。对 `batch` 做合理上限。

### 12. 严重度：低

**位置：** `clients/apple/Sources/HimawariCore/MessageSensing.swift:113-116,132-135`

**问题：** `PerceptionIngestReply` 的 `outcomes`/`reached` 被解码后完全没用。若服务器用 200 返回“部分接收/部分未达”，客户端会直接前移游标，未达记录永久丢失。

**证据：**

```swift
do {
    _ = try await perceive(records)
    return []
}
```

```swift
public let outcomes: [Outcome]
public let reached: [String]
```

**建议：** 明确契约：200 是否代表整批全部入库。若不是，按 `reached`/`outcomes` 计算安全游标，只前移到连续已确认的位置。

### 13. 严重度：低

**位置：** `clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:37,110-112`、`clients/apple/Sources/HimawariMacUI/PanelView.swift:52`

**问题：** 面板“停下”按钮调用的 `work` 从未被赋值，点击没有任何效果。`ResultNotices.announce`、`undoHandler`、`ChecklistView` 也没有生产接线。作者说文件动作不在本 PR 可以理解，但“停下手上的工作”是当前可见按钮，不能静默无效。

**证据：**

```swift
@ObservationIgnored weak var work: MacWorkControl?
...
func stop(_ workId: String) {
    Task { await work?.stop(workId) }
}
```

**建议：** 在本 PR 接线停止动作，或先隐藏该按钮并在 README/PR 里明确“本批只做展示”。

### 14. 严重度：低（文档与代码不一致）

**位置：** `clients/apple/Sources/HimawariCore/MessageSensing.swift:70-71,77-79`、`docs/execution/specs/2026-11-11-apple-device-body-design.md:307`

**问题：** 设计说感知记录编号“由设备生成（时间加随机数）”，代码是 `guid` 的 SHA-256 哈希。哈希更适合重试去重，但与文档不一致，且同一 guid 的不同内容会撞成同一个 id。另：`sender` 对 `fromMe = true` 的消息取的是 handle（实际是收件人），语义上是“收件人”却放在 `sender` 里；RCS 被映射成 `sms`。这些都需要和服务器语义确认。

**证据：**

```swift
public static func recordId(guid: String) -> String {
    "perception:" + Hashing.sha256(Data("message.text\n\(guid)".utf8)).prefix(24).base64URLEncodedString()
}
```

```swift
var evidence = ["service": service, "direction": row.fromMe ? "outgoing" : "incoming"]
if let sender = ... { evidence["sender"] = ... }
```

**建议：** 更新设计文档或改实现使其一致；明确 outgoing 是否允许带 `sender`，以及 RCS 是否应归为 `sms`。给 guid 复用/消息编辑加去重语义说明。

### 15. 严重度：低（测试覆盖不足）

**位置：** `clients/apple/Package.swift:21-23,34-38`、`clients/apple/Tests/HimawariCoreTests/MessageSensingTests.swift:55-62`、`clients/apple/Tests/HimawariCoreTests/MacInputTests.swift:18`

**问题：** `HimawariMacUI` 在 Linux 上完全不编译，而关键编排都在 MacUI：`MessagesSensor.tick`、`InputBarModel.send`、`MacSettingsStore.setSeesMessages` 没有任何测试。`turningItOffForgetsWhereItWas...` 名字说测开关，实际只测 JSON 编解码，即使 `setSeesMessages` 不清理游标也会通过。附件 fixture 用 `forResource: "Fixtures/attachment-vectors"`，而同仓库已有测试使用 `subdirectory: "Fixtures"`；这个写法有返回 nil 的风险（未能运行 Swift 测试，属推测）。`make-attachment-fixture.mjs` 也没有接进任何检查，网页 `joinDraft` 改了以后 fixture 不会自动失效。

**证据：**

```swift
@Test func turningItOffForgetsWhereItWasSoTurningItBackOnSkipsTheGap() {
    var settings = MacAccessSettings(seesMessages: true)
    settings.messagesAfterRow = 4800
    ...
    let old = try? JSONDecoder().decode(MacAccessSettings.self, from: Data(...))
    #expect(old?.messagesAfterRow == nil)
}
```

```swift
let url = try #require(Bundle.module.url(forResource: "Fixtures/attachment-vectors", withExtension: "json"))
```

**建议：** 把 `MessagesSensor`/`InputBarModel` 的纯编排抽到可在 Linux 编译的 Core 层，或至少在 Mac 上跑单元测试；加“关掉开关会清游标”的真实 store 用例；fixture 改用 `subdirectory: "Fixtures"`；把 `make-attachment-fixture.mjs` 接进 `npm run check` 做漂移检查。

## 二、推测或未核实

1. **服务器端契约是否存在、是否接受这些值：未核实。** 本检出内没有 `POST perception`、`POST attachments`、`config.attachments` 的服务端实现；如果它们由另一个未合入的 PR 提供，本 PR 合入前必须补端到端契约测试。
2. **`NSUnarchiver` 是否一定崩溃/可被利用：** API 的使用是证实的；chat.db 的 blob 是否可被远端消息影响到能构造 gadget、以及 malformed blob 是否真的抛异常，未在 Mac 上验证。
3. **`PathPolicy` 的 symlink+`..` 绕过：** 代码顺序是证实的；是否可利用取决于未来文件动作使用原始路径还是返回的 `realPath`，当前没有生产调用点。
4. **`evidence` 字典的 JSON 字节顺序：** `[String: String]` 由 `JSONEncoder` 编码且未设置 `.sortedKeys`，同一记录重试时键顺序可能不同；只有服务器按原始字节做幂等/摘要时才会造成问题，当前契约未核实。
5. **`abs(Int64.min)`：** `MessageSensing.date` 第 59 行对 `Int64.min` 会溢出崩溃；chat.db 出现这种值需要数据库损坏或恶意写入，概率低但属于不可信输入边界。
6. **MacUI 在 Swift 6 下的 actor 隔离编译：** `@MainActor` 类实现 `NSWindowDelegate`/`NSDraggingDestination` 等协议是否会有并发检查错误，未实际编译验证。

## 三、侧重检查

- **错误路径：** 检查了 400/5xx/网络错误、单条重试、批次中部分成功、响应解码失败。5xx/网络错误不会前移游标，这点与作者说法一致；但“全批 400”会静默前移，见问题 1。响应解码失败会抛错，不前移。
- **不合规范/不可信输入：** 检查了 `chat.db` 的 PRAGMA 列名、空/坏 guid、空/坏 date、`attributedBody` 反序列化、拖入的任意文件、路径 `..`/符号链接、URL userinfo/子域、附件名和 ref 注入。路径分隔比较能挡住 `Docs-old`，URL 拒绝 userinfo，ref 拒绝引号/空白；未覆盖 `attributedBody` 异常和 symlink+`..`。
- **安全：** `NSUnarchiver` 是不安全的旧反序列化入口；PathPolicy 当前未被生产代码使用；URLPolicy 同样未被调用，授权目前只是设置页里的数据。
- **资源耗尽：** 拖入文件数量/总量无上限，文件/PDF/富文本和 SQLite 读取都在主线程；服务器下发的批次上限未本地夹紧。
- **不可撤销操作：** 清单的触控 ID 用 `OwnerPresence.confirm`，会回退到设备密码；当前没有实际文件动作。`home/act` 每次用新 requestId 且吞错，重试可能重复执行。
- **规则/文档一致：** README 说服务器不收时会写明，但全批 400 会被静默跳过；设计说记录 id 是时间+随机数，代码用 guid 哈希；设计说采集来源由清单生成，代码硬编码 `system_api`。

## 四、作者说法逐条核对

| 作者说法 | 核对结果 |
|---|---|
| 记录 id 由 guid 哈希得出，重试只会是重复 | 代码确实如此（`MessageSensing.swift:70-71`）。但设计文档写的是“时间加随机数”，文档需更新。 |
| 整批 400 时逐条重发、只跳过被拒的 | 重发逻辑在（`MessageSensing.swift:117-126`），但调用方忽略 `skipped` 并前移游标（`MessagesDatabase.swift:191-198`），会静默丢记录。 |
| 网络或 5xx 不前移读到的位置 | 正确；非 400 会抛出，`tick` 直接 return。 |
| 路径先解开符号链接和 `..` | 实际是先标准化（删 `..`）再解符号链接，顺序与说法相反，见问题 8。 |
| 按路径分段比较、最近的授权优先、只读不许写 | 代码实现符合；`contains` 按 pathComponents，按 folder 长度排序，写操作检查 `.readWrite`。 |
| 网址只许 https 且主机在名单里（含子域） | 代码符合（`MacAccess.swift:160-168`），但 `URLPolicy` 目前没有生产调用点。 |
| 附件 requestId 必须匹配 `[A-Za-z0-9_-]{16,64}` | 客户端生成 `22 字符 base64url + "-" + index`，在 64 以内；服务器是否接受未核实。 |
| 上限从 GET config 的 attachments 读，按 UTF-16 | 客户端按 UTF-16 裁剪和计数；服务器端 `attachments` 结构在本检出里不存在，无法核对。 |
| 附件先 POST attachments 换 ref，格式与网页一致 | 客户端格式与网页 `joinDraft` 对齐；`POST attachments` 服务端不在本检出。 |
| 短信只读开启后新消息，关掉清位置 | 正常路径符合；`await` 期间关掉再打开会回填，见问题 6。 |
| 表结构不假定，PRAGMA 读列再拼查询 | 符合（`MessagesDatabase.schema()`、`MessagesSchema.rowsQuery`）。 |
| 文件动作不在本 PR | 符合，`PathPolicy`/`URLPolicy`/`ChecklistView` 都没有生产接线。 |

## 五、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 依据 [`prompt-prefix.md#rules`](../.claude/rules/prompt-prefix.md#rules) 的只追加要求：

- 附件和上下文小条只被 `MessageAttachments.compose` 拼成一条新的用户消息，经 `ChatStore.send` 作为新消息入队（`ChatStore.swift:273-279`），没有修改系统提示、工具定义、历史消息或遮盖结果。
- 每轮会变的值（附件 ref、bytes、truncated、前台 App/选中文字、拖入文件）都在新追加的最后一条用户消息里。
- 感知记录走 `POST perception`，不进入对话请求；`recordId`、`occurredAt`、短信正文都不改任何已发出的请求头。
- 没有任何代码在存历史前改写旧消息；`ChatStore.send` 只对本次新文本做 trim，然后原样入队。

唯一需要守住的前提是服务器端把这条新用户消息原样追加、不回头重写历史；这属于服务器现有逻辑，本 PR 未改，但服务器端不在本次检出内，未做端到端核实。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

- **模型请求：不会。** 附件 ref 由服务器在本次发送时生成，但 `InputBarModel` 会在失败重试时复用 `pendingRequestId`，`Outbox` 也会保存含 ref 的原始文本；同一轮重试的字节应保持一致。若用户在上传失败后改了附件再重试，则会因为问题 5 把旧 ref 配到新内容上，这是错误内容而不是“同文字不同字节”。
- **感知请求：存在一处非确定性。** `PerceptionRecordBody.evidence` 是 `[String: String]`，`JSONEncoder` 未设置 `.sortedKeys`（`MessageSensing.swift:22-29,77-89,134`），相同记录在不同进程/请求里可能键顺序不同。若服务器只按 id 去重，这不是问题；若按原始字节做幂等或摘要，就会出问题。建议加 `.sortedKeys`。
- `recordId`、`occurredAt`、`text` 裁剪结果本身是确定的；`FolderGrant` 的 `localizedStandardCompare` 排序只影响本地设置文件，不影响模型或感知请求。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有，但不够。**

- 已覆盖：附件格式与网页固定 fixture、附件裁剪、附件数量/总长、ref 注入拒绝、路径穿越/symlink/相对路径/最近授权/只读拒绝、URL scheme/userinfo/子域、感知记录 id/occurredAt/UTF-16 裁剪、批量 400 逐条重发、503 不前移、schema 列缺失回退。
- 已证实会失败的反向用例：`dotDotCannotClimbOutOfAGrantedFolder`、`aSymlinkInsideAGrantedFolderPointingOutsideIsRefused`、`aRefThatWouldBreakTheTagIsRefused`、`aServerOrNetworkFailureIsNotSkippedSoTheCursorStaysPut`、`aMissingRequiredColumnIsNamedAndNothingIsRead`。
- 缺口：
  - `HimawariMacUI` 在 Linux 上不编译，`MessagesSensor.tick`、`InputBarModel.send`、`MacSettingsStore.setSeesMessages` 的真实行为没有测试；关掉开关清游标、全批 400 不前移、上传失败后改附件重试，这些关键反向用例都不存在。
  - `turningItOffForgetsWhereItWas...` 只测 `MacAccessSettings` 的 JSON 编解码，不测 store，改坏 `setSeesMessages` 也能通过。
  - 附件 fixture 是静态文件，`make-attachment-fixture.mjs` 没有接进任何自动检查，网页格式变了测试不会报警。
  - 没有与真实服务器 `POST perception`/`POST attachments`/`GET config` 的端到端契约测试。

### 4. 每个值产生处和使用处都能接受吗？

逐个核对如下：

| 值 | 产生处 | 使用处/校验 | 结论 |
|---|---|---|---|
| `attachment requestId` | `OutgoingMessage.newId()`（22 字符 base64url）+ `-index`（`DeviceAttachments.swift:25-27`） | 客户端测试用 `[A-Za-z0-9_-]{16,64}` 校验；服务器未核实 | 格式在客户端成立；内容变更后复用有语义问题（问题 5）。 |
| `ref` | 服务器 `POST attachments` | 客户端拒绝空、空白、`"`、`<`、`>`（`DeviceAttachments.swift:19`）；标签格式与网页一致 | 客户端校验合理；服务器 ref 生产逻辑未核实。 |
| `bytes`/`truncated`/`kind`/`name` | 客户端 `MessageAttachment` | 标签拼接（`MessageAttachments.swift`），名称清洗，kind 枚举 | 与网页 `joinDraft` 对齐；`bytes` 用原文件大小符合网页语义。 |
| `AttachmentLimits.{textCharacters,imageCharacters,perMessage,messageCharacters}` | 服务器 `GET config.attachments` | `DeviceConfiguration.attachments?` 解码，`attach`/`fits` 使用 | 客户端能接受缺失（旧服务器得到 nil）；服务器生产者在本检出里不存在，数值范围也没校验（负数/0/超大）。 |
| 感知记录 `id` | `recordId(guid)` | 客户端测试匹配 `^perception:[A-Za-z0-9_-]{16,64}$` | 32 字符 base64url，客户端成立；服务器是否按同正则校验未核实。 |
| `occurredAt` | `timestamp(date(appleDate))` | 客户端测试匹配 ISO 8601，含毫秒 | 客户端成立；服务器格式校验未核实。 |
| `service` | `service()` 映射 imessage/sms/rcs | 契约只允许 sms/imessage | RCS 被映射成 sms，能通过允许值但语义可能不对。 |
| `direction` | `fromMe ? outgoing : incoming` | 契约允许 incoming/outgoing | 成立。 |
| `sender` | `handle.id` | `utf16Prefix` 限 128 | 长度成立；outgoing 时这是收件人而非发送人，语义需确认。 |
| `text` | 消息正文，trim 后 | `utf16Prefix` 限 32×1024 | 长度成立；截断没有标记，服务器只能看到“短文本”。 |
| `captureSource` | 硬编码 `"system_api"` | 服务器清单校验（未核实） | 仓库里没有这个值的登记；若服务器按清单校验会整批 400。 |
| `device.perception.batch_records` | 服务器配置上限 | `DeviceConfiguration.limit`，客户端按它分批 | 键在 `packages/gateway-contracts/src/contracts-v2.ts:520` 有登记，两端键名一致；值的大小/负数未本地校验。 |
| `outcomes`/`reached` | 服务器 200 响应 | 客户端解码后丢弃 | 两端字段能对上，但客户端没用；部分接收会丢游标。 |
| `home/act` 的 `requestId` | 每次点击 `OutgoingMessage.newId()` | 服务器按 requestId 去重 | 每次新 id，重试不会去重，可能重复执行动作。 |
| `DeviceKind.mac` | `AppModel(kind: .mac)` | `POST pair` 的 kind；服务器 `DEVICE_KINDS` 含 `mac`（`contracts-v2.ts:514`） | 两端一致。 |
| `messagesAfterRow` | 本地设置，`Int64` | `startingRow`/`setMessagesAfterRow` | 本地保存/读取成立；未校验负值或大于最新行的情况。 |
