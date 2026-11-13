## 结论

本批是 Mac 客户端代码，不碰服务端组装模型请求的路径；但新增了多个要与服务端对齐的值（感知记录、面板接口、附件），其中至少有两处“只在客户端认、服务端可能不认”的高风险点。第 3 轮的三项修改本身没看到明显的新崩溃路径，但都没有自动检查，且拖入顺序化把“拖入后立刻发送会丢文件”的时间窗拉长了。

---

## 读代码证实的问题

### 1. 严重度：高（未核实服务器端）
**文件:行**：`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:74-92`；对照 `docs/execution/specs/2026-11-11-apple-device-body-design.md:210-231`

**问题**：Mac 面板和动作使用的 `GET actions`、`GET home`、`POST home/act` 不在设备接口表里，仓库里也没有对应的服务端处理器。若服务器真按设计文档的设备接口表实现，面板永远为空、点按钮永远失败。

**证据**：
- 客户端：
  ```swift
  // MenuBarFeed.swift:74-76
  public func deviceActions() ... path: "actions"
  // :79-80
  public func home(locale:) ... path: "home"
  // :84-92
  public func act(...) ... path: "home/act"
  ```
- 设计文档的设备接口表只列了 `pair / stream / messages / perception / mirror / track / actions/result / ... / config / usage / threads`，并明确写“设备能做的就是这张表”（`...design.md:231`）。其中没有 `home`、`actions`、`home/act`。
- 全仓库 grep 不到 `home/act` 的服务端实现，也找不到 `GET actions` 的设备 API 处理器。

**建议**：在设备接口表和服务端补上这三条，或改成使用已有的 `GET stream` / `POST actions/result`。同时加一条客户端与真实服务端共享的合同测试，至少验证 `GET actions`、`GET home`、`POST home/act` 的路径、字段和鉴权。

---

### 2. 严重度：高（若服务端不认，短信功能会整体失效）
**文件:行**：`clients/apple/Sources/HimawariCore/MessageSensing.swift:45`；对照 `docs/execution/specs/2026-11-11-apple-device-body-design.md:728`

**问题**：`captureSource` 被硬编码成 `"system_api"`，而设计文档要求“服务器按清单校验；Swift 由清单生成”。仓库里没有生成清单，也没有服务端来源清单或 `test/integration/perception-records.test.ts`。如果服务端不认识 `system_api`，每条短信记录都会 400 → `allRejected` → 游标不前移 → 永久重复上传，设置页一直显示“短信没传上去”。

**证据**：
```swift
// MessageSensing.swift:45
public static let captureSource = "system_api"
```
```md
// design.md:728
| 采集来源 ... | 设备 | ... | 服务器按清单校验；Swift 由清单生成 | test/integration/perception-records.test.ts |
```
仓库中 grep `system_api` 只有客户端和客户端测试；`**/*perception*` 只有 ADR，没有上述集成测试。

**建议**：把服务端的采集来源清单生成成 Swift 常量（或至少提交共享 fixture）；在服务端加一条反向用例，证明 `system_api` 被接受、未知来源被拒绝。若 `system_api` 不是已登记来源，换成登记过的来源名。

---

### 3. 严重度：中
**文件:行**：`clients/apple/Sources/HimawariMacUI/InputBarModel.swift:84-93`、`:120-129`

**问题**：没有附件时完全不检查 `messageCharacters` 上限。用户只发超长正文时，客户端不会按服务器配置截断或拒绝，直接把超长文本交给 `chat.send`，可能被服务器拒绝或造成大内存/大请求。

**证据**：
```swift
// InputBarModel.swift:84
if !pieces.isEmpty {
    guard let limits else { ... }
    guard pieces.count <= limits.perMessage else { ... }
}
...
// :122-128
if let limits, !carried.isEmpty {
    attachments = try await api.attach(carried, ...)
    guard MessageAttachments.fits(text: text, attachments: attachments, limits: limits) else { return .failed(.tooMany) }
}
```
`fits` 只在 `!carried.isEmpty` 时调用；正文很长但没有附件时一次都不会检查。

**建议**：只要 `limits != nil` 就调用 `MessageAttachments.fits`（即使 `attachments` 为空）；在进入 `sending = true` 前检查，避免超长文本进入 outbox。

---

### 4. 严重度：中
**文件:行**：`clients/apple/Sources/HimawariMacUI/InputBarModel.swift:50-61`、`:80-113`

**问题**：拖入文件还在后台读取时，用户按发送，文件可能既没被发出去，又从界面上消失。`send()` 不递增 `session`，所以文件读取任务完成后仍会 `add(pieces:)`；随后发送成功分支又把 `pieces` 清空。

**证据**：
```swift
// add(files:)
let started = session
Task {
    let added = await Task.detached { files.map { ... } }.value
    guard started == session else { return }
    add(pieces: added)
}

// send()
let carried = pieces
let started = session
Task {
    let outcome = await deliver(...)
    guard started == session else { return }
    switch outcome {
    case .sent:
        draft = ""
        pieces = []
```
`send()` 没有 `session += 1`，所以 `add` 的 `started == session` 仍然成立，文件会被追加到正在发送的 `pieces` 后面，随后被 `.sent` 分支清空。第 3 轮把 `loadFiles` 改成“全部读完再交付”，把出现这个竞态的时间窗拉长了。

**建议**：给“附件加载中”单独计数并在加载完成前禁用发送；或让 `send()` 递增一个附件代次，`add(files:)` 只在同一代次且未发送时提交；或发送时等待正在进行的文件加载。

---

### 5. 严重度：中
**文件:行**：`clients/apple/Package.swift:11-18`；`clients/apple/Tests/HimawariCoreTests/MessageSensingTests.swift:61-73`

**问题**：第 3 轮的三项核心逻辑（`messagesEpoch`、面板动作刷新后解锁、拖入顺序）没有任何自动检查。`HimawariMacUI` 根本没有测试目标；现有 `anUploadThatFinishesAfterTheSwitchWasFlippedOffAndOnCannotWriteItsOldPlace` 只测 `MacAccessSettings.moveMessagesCursor`，不测 `MacSettingsStore.messagesEpoch` 或 `MessagesSensor`。

**证据**：
```swift
// Package.swift:11-18
.testTarget(name: "HimawariCoreTests", dependencies: ["HimawariCore", ...])
```
没有任何 `HimawariMacUITests`。
```swift
// MessageSensingTests.swift:61-73
var settings = MacAccessSettings(seesMessages: true)
settings.moveMessagesCursor(from: nil, to: 4800)
...
let stale = settings.moveMessagesCursor(from: startedFrom, to: 4850)
#expect(!stale)
```
这段即使把 `messagesEpoch` 全部删掉也会通过：`MacAccessSettings` 自己的“当前游标等于 expected”已经足以让 stale 写入失败。真正需要 epoch 的场景是“旧 loop 在关了又开后、新 tick 还没把游标推到 newest 之前继续跑”，没有任何测试覆盖。

**建议**：把 `MessagesSensor`/`MacSettingsStore` 抽到可在 macOS 测试目标中运行，加一条“旧批次读取完成后关→开→旧批次仍不推进游标/不上传”的测试；给面板动作和拖入顺序各加一条可失败的反向测试。

---

### 6. 严重度：中（未核实服务器端）
**文件:行**：`clients/apple/Sources/HimawariCore/MessageSensing.swift:132-138`；`clients/apple/Sources/HimawariCore/DeviceAPI.swift:205-210`；`clients/apple/Sources/HimawariMacUI/MessagesDatabase.swift:187-194`

**问题**：`POST perception` 成功时也强依赖一个客户端自定义的返回体 `{outcomes, reached}`。如果服务端返回 200/204 空正文或别的结构，客户端会当作 `invalidResponse`，游标不前移，已入库的记录会被无限重发，设置页一直显示发送失败。

**证据**：
```swift
// MessageSensing.swift:136-137
let data = try await http.send(DeviceRequest(... path: "perception" ...))
return try decode(PerceptionIngestReply.self, data)
```
```swift
// DeviceAPI.swift:205-210
do { return try JSONDecoder().decode(type, from: data) }
catch { throw DeviceAPIError.invalidResponse }
```
```swift
// MessagesDatabase.swift:187-192
do { _ = try await app.api.perceiveSkippingInvalid(records) }
catch { settings.reportMessages(.cannotSend); return }
```
调用方根本不用返回体，因此这个解码是多余的失败点。

**建议**：`perceive` 只要 2xx 就成功；需要 `outcomes/reached` 时再单独解码，解码失败不要影响游标推进。并在服务端合同测试里固定 200 的返回体。

---

### 7. 严重度：中低
**文件:行**：`clients/apple/Sources/HimawariMacUI/InputBarModel.swift:40-48`；`clients/apple/Sources/HimawariMacUI/ContextReader.swift:44-60`

**问题**：前台 App 的“正在看的文件”是在主线程同步读取并解析的。`begin` 是 `@MainActor`，`ContextReader.read` 最多读 8 MB，还会用 PDFKit / NSAttributedString 解析；打开输入条时可能明显卡界面。作者只声称“chat.db 和拖入文件在后台读”，这里的前台文档不在其列，但用户体验上仍是问题。

**证据**：
```swift
// InputBarModel.swift:47
pieces = ContextGathering.pieces(..., readFile: ContextReader.read)
```
```swift
// ContextReader.swift:44-60
let plain = PlainTextFile.read(url)
...
if type == "pdf", let document = PDFDocument(url: url) ...
let text = try? NSAttributedString(url: url, options: [.documentType: documentType], ...)
```
`InputBarModel` 是 `@MainActor`，`begin` 直接在主线程执行这些解析。

**建议**：前台文档也放到 `Task.detached` 读取，用 session/代次 guard 回填；或先显示“正在读取”占位，再追加 chip。

---

### 8. 严重度：低
**文件:行**：`clients/apple/Sources/HimawariMacUI/InputBarModel.swift:50-64`、`clients/apple/Sources/HimawariCore/ContextPieces.swift:101-111`

**问题**：拖入大量文件时，先把所有文件都读进内存，之后才按 `perMessage` 截断。用户拖入几百个文件会做大量无用的磁盘读取和解码，且可能把主内存撑高。

**证据**：
```swift
// InputBarModel.swift:55-59
let added = await Task.detached {
    files.map { ContextGathering.filePiece($0, ..., reading: ContextReader.read($0)) }
}.value
add(pieces: added)
```
```swift
// InputBarModel.swift:63-64
let merged = ContextGathering.merge(pieces, adding: added, limit: limits()?.perMessage)
```
`merge` 的 limit 只在读取完成之后才生效。

**建议**：先按剩余槽位截断 `files`，再读取；同时对总字节数设上限。

---

### 9. 严重度：低
**文件:行**：`clients/apple/Sources/HimawariMacUI/MenuBarController.swift:156-160`；`clients/apple/README.md:115`

**问题**：App 已经配对/激活时，收到 `himawari-pair:` 链接会被直接忽略，不会打开配对窗口；README 却说“会直接打开配对窗口并填好”。这既是文档与代码不一致，也让“换服务器/重新配对”没有入口。

**证据**：
```swift
// MenuBarController.swift:156-160
func receivePairingLink(_ url: URL) {
    pairingInbox.receive(url.absoluteString)
    guard model.app.phase != .active else { return }
    showPairing()
}
```
README 第 115 行写的是“Mac App 认领 `himawari-pair` 这个链接开头，会直接打开配对窗口并填好”。

**建议**：明确产品行为：若允许重新配对，激活时也打开配对窗口；若不允许，改 README 并说明已配对时链接被忽略。

---

### 10. 严重度：低
**文件:行**：`clients/apple/Sources/HimawariMacUI/MenuBarController.swift:15,33,286,302`；`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:38,114`

**问题**：本批声明的“结果通知”和面板“停止”在正式路径里没有接上：`ResultNotices.announce` 没有任何调用方，`undoHandler` 从未赋值；`MenuBarModel.work` 从未赋值，所以生产环境 `canStop` 永远为 false，面板不会出现“停下”按钮（只有 demo 里出现）。

**证据**：
```swift
// MenuBarController.swift
private let notices = ResultNotices()        // 15
notices.prepare()                            // 33
var undoHandler: ((String) -> Void)?         // 286
func announce(...) { ... }                   // 302，仅定义
```
```swift
// MenuBarModel.swift
@ObservationIgnored weak var work: MacWorkControl?   // 38
var canStop: Bool { work != nil || demoShowsStop }   // 114
```
全仓库没有 `notices.announce(` 调用，也没有 `model.work =`/`work =` 赋值。

**建议**：如果这些要等后续文件动作批次，就在本批说明里写成“仅脚手架/截图”；否则把通知和停止接到实际结果路径，并加一条“动作成功后通知出现、停止按钮可用”的测试。

---

### 11. 严重度：低
**文件:行**：`clients/apple/App/Himawari.xcodeproj/project.pbxproj:314,339`；`clients/apple/Sources/HimawariCore/Models.swift:13`

**问题**：`ReleaseChannel` 定义了 `mac_direct`，Mac 目标却把 `HIMAWARI_RELEASE_CHANNEL` 设成 `direct`，所以 Mac 直装版永远不会上报 `mac_direct`。虽然服务器接受 `direct`、且文档说这个值只用于显示和排查，但这是“定义了一个值却没有产生方”的典型不一致。

**证据**：
```text
// project.pbxproj:314,339
HIMAWARI_RELEASE_CHANNEL = direct;
```
```swift
// Models.swift:13
case macDirect = "mac_direct"
```
设计文档第 702 行仍把 `mac_direct` 列为发布渠道之一。

**建议**：Mac 直装目标改成 `HIMAWARI_RELEASE_CHANNEL = mac_direct`，或删除 `mac_direct` 的定义/文档条目并说明 Mac 使用 `direct`。

---

## 推测 / 未核实

1. **`HomeAction.binding` 服务端并不产生**：客户端 `MenuBarFeed.swift:7` 要求 `binding`，但服务端 `packages/application/src/services/home-feed.ts:25-32` 的 `HomeAction` 只有 `action/label/labelBasis/polarity/ownerPresence/reviewLabel`，没有 `binding`。因此客户端解码后 `binding` 永远是 nil，请求 key 也永远忽略它。如果 `home/act` 需要 binding 来区分同一 item 的不同动作，请求会不对。未核实点：`home/act` 的服务端实现不在本仓库。
2. **`associated_message_type = 0` 可能排除 NULL 行**：`MessageSensing.swift:175` 在有该列时加 `m.associated_message_type = 0`。SQLite 中 `NULL = 0` 不为真；如果某些正常消息该列为 NULL，会被永久跳过，而游标仍前移。Apple 的 `chat.db` 通常默认 0，所以这是推测。
3. **面板动作失败后永久复用 requestId**：`MenuBarModel.swift:120-136` 只在成功时清 `actionRequestIds[key]`。如果第一次失败是永久性冲突/校验错误，之后点击永远带同一个 requestId；若服务端按 requestId 重放首次失败结果，就永远无法成功。未核实服务端幂等语义。
4. **`MessagesDatabase.string` 用 `String(cString:)`**（`MessagesDatabase.swift:114-116`）遇到 SQLite TEXT 中的 NUL 会截断，可能丢正文/发件人。Apple 正常数据一般没有 NUL，属于边界推测。
5. **`ISO8601DateFormatter` 未固定 locale**（`MessageSensing.swift:63-68`）：已固定时区，但未显式设 `en_US_POSIX`。当前 Foundation 实现下通常稳定；若要严格保证字节确定，建议补上。
6. **关掉短信开关不能取消已经在网络中的那次上传**：`setSeesMessages(false)` 只递增 epoch，网络请求已发出时无法撤回；epoch 只能阻止请求返回后继续推进/下一批。若“关掉即停”要求连在途请求也取消，需要保存并取消 Task。
7. **历史消息回填**：游标基于 `ROWID`，若开启后 iCloud/信息同步补入旧日期的消息（新 ROWID），会被当作新消息上传，可能违反“不补读历史”。未核实实际同步行为。

---

## 侧重检查

- **错误路径**：短信批次 400 逐条重发、全部 400 抛 `allRejected`、5xx/网络失败不前移游标，这几条与作者说法一致；但 200 返回体解析失败也会导致不前移（见问题 6）。`MessagesDatabase.batch` 的 `newest` 在 `saved != nil` 时被改成旧的 `row`，当前唯一使用点是 `saved == nil` 分支，所以目前不构成错误，但字段语义已变，后续复用容易踩坑。
- **不合规范/不可信输入**：`TypedStreamText` 全程做边界检查，读长度前检查剩余字节，读文本前检查 `length <= bytes.count - cursor`；对应测试覆盖截断、非法 tag、非法 UTF-8，未发现越界。SQL 只用固定的表名和固定的列候选，不拼接数据库里的字符串，没有注入面。配对链接要求 `https`、有 host、无 user/password/query/fragment、path 为空或 `/`，校验合理。
- **安全/隐私**：短信是只读打开 `chat.db`，不上传历史（首次启用跳到最新 ROWID），但已发到服务器的记录会参与后台抽取；关开关只影响后续。没有发现把 `chat.db` 写坏或标已读的路径。路径策略的 realpath/符号链接/`..` 测试覆盖较好，但文件动作不在本 PR，设计要求的“打开文件后再用文件句柄核对真实路径”尚未实现（符合本批范围）。`URLPolicy` 的 https/主机/子域检查正确，但目前没有任何调用方。
- **资源耗尽**：大量拖入文件会先全读后截断（问题 8）；前台文档在主线程解析（问题 7）；短信积压时一个 tick 会连续上传到队列清空，服务端永久拒绝非 400 时会每个心跳重试同一批（推测）。
- **不可撤销操作**：本 PR 没有真正接上文件动作；`ChecklistView` 只在 demo 中出现，正式路径没有触发点，因此没有可实际执行的不可撤销操作。触控 ID 失败会回退到设备密码（`OwnerPresence`），这符合“主人本人在场”，但与“触控 ID 同意”的文案不完全一致。
- **规则/文档与代码**：发现 `system_api` 未按文档由清单生成、面板接口不在设备接口表、配对链接激活时被忽略、`mac_direct` 无产生方、结果通知/停止按钮未接线。其余声称（附件格式、`messagesAfterRow` 清理、epoch 预期值、路径 realpath、URL 策略、attributedBody 不调用 NSUnarchiver）与代码基本一致。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本 PR 没有改系统提示、工具定义、历史消息或出口遮盖代码。Mac 客户端只通过 `ChatStore.send` 追加一条新的用户消息，附件标签由 `MessageAttachments.compose` 接在正文后面；短信走独立的 `POST perception`，不进入已有对话的请求开头。每轮会变的值（前台快照、附件 ref、短信发生时间）只会进入新的最后一条消息或独立的感知请求，不会回写旧历史。

2. **同一段文字会不会在不同请求里变成不同字节？**
   感知记录本身是确定的：id 是 `message.text\n+guid` 的 SHA-256 前 24 字节 base64url；`occurredAt` 来自 `chat.db` 的消息时间，不是当前时间；`JSONEncoder` 用了 `.sortedKeys`；记录顺序由 ROWID/查询固定。附件标签的 `name/bytes/kind/truncated` 也确定。**但** `ref` 由服务端生成：同一个文件用新的 requestId 重新上传时，标签里的 `ref` 可能不同。这不是“改写已发历史”，而是新消息的新内容；同一会话内重试复用 `pendingRequestId`，通常会得到同一个 ref，但这一点依赖服务端幂等语义，未核实。另有一个低风险点：`ISO8601DateFormatter` 未固定 `en_US_POSIX` locale。

3. **有没有对应的自动检查，反向用例真的会失败？**
   `HimawariCore` 有较多测试：路径（符号链接、`..`、最近授权、只读）、URL（非 https、userinfo）、短信记录（id 正则、时间、UTF-16 截断、allRejected、逐条 400、5xx）、TypedStreamText（截断/非法数据）、附件向量（与网页 `joinDraft` 逐字一致）。这些反向用例看起来是有意义的。但：
   - `swift test` 不在一键 `npm run check` 里，只靠 Mac 上手动跑；
   - `HimawariMacUI` 没有测试目标，第 3 轮的 `messagesEpoch`、拖入顺序、面板动作刷新解锁都没有测试；
   - 现有 epoch 测试只测 `MacAccessSettings`，把 `messagesEpoch` 删掉仍会通过；
   - 设计文档引用的 `test/integration/perception-records.test.ts` 等服务器侧测试在仓库中不存在。
   因此：Core 的反向用例基本成立；第 3 轮改动没有自动检查，不能证明反向用例会失败。

4. **每个新值两端都能接受吗？**
   - `perception:` id：客户端生成 43 字符（`perception:` + 32 位 base64url），符合 `^perception:[A-Za-z0-9_-]{16,64}$`；服务端测试不在仓库，未核实。
   - `captureSource = system_api`：高风险，文档要求由服务端清单生成，仓库没有清单/测试，未核实。
   - `message.text`、`occurredAt`、`text ≤ 32K UTF-16`、`sender ≤ 128`、`service sms|imessage`、`direction incoming|outgoing`：客户端实现与文档一致；服务端未核实。
   - `device.perception.batch_records`：与 `packages/gateway-contracts/src/contracts-v2.ts:520` 的 `DEVICE_LIMIT_KEYS` 一致。
   - 附件 `requestId = baseId-index`：22+1~2 字符，符合 16–64；有测试。
   - 附件标签 `<file name ref bytes kind truncated/>`：与网页 `joinDraft` 一致，有生成 fixture 和 tooling 测试。
   - `AttachmentLimits` 的 `textCharacters/imageCharacters/perMessage/messageCharacters`：客户端测试只验证解码 fixture，服务端不在仓库，未核实。
   - `GET home` / `GET actions` / `POST home/act`：不在设备接口表，仓库无处理器，未核实且很可能不可用；`HomeAction.binding` 服务端类型没有，见“推测”。
   - `messagesAfterRow`、`FolderGrant.id`、快捷键：只在本机使用，没有服务端校验点。
   - `mac_direct`：定义存在但 Mac 目标上报 `direct`，见问题 11。
   - `himawari-pair` scheme：Info.plist 与 `PairingInvitation.scheme` 一致。
   - Mac 设计 token / 图标 / 附件 fixture：生成脚本和 `check:apple-design` 已接入，属于本 PR 中比较完整的两端一致项。
