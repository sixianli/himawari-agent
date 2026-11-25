### 1. [高] 安静时段的读写命令没有登记到客户端能力表，服务端合约也没有，功能和新增测试都不可达
文件:行
- `clients/apple/Sources/HimawariManage/Settings/QuietHours.swift:62`、`:75`
- `clients/apple/Sources/HimawariManage/Gateway/ManageGateway.swift:40-42`、`:149-154`
- `clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:240-242`
- `packages/gateway-contracts/src/contracts-v2.ts`（`quiet_hours` 只作为规则类型出现，没有命令/查询合约）

问题
`QuietHoursStore.load()` 调用 `gateway.read(.v2, "quiet_hours.read")`，但 `ManageGateway.read()` 先查能力表，查不到就直接 `unknownType`；`set()` 同理。当前生成的能力表里没有 `quiet_hours.read` / `quiet_hours.set`，服务端 `contracts-v2.ts` 也没有这两个接口。结果是：页面加载永远是 `unavailable`，通知行不显示；新增的 `QuietHoursStoreTests` 的 `testLoadingReadsTheSingleWindow` 会卡在 `XCTAssertEqual(quiet.phase, .loaded)` 失败，`testSavingSendsTheVersionItReadAndReloads` 也永远发不出命令。

证据
```swift
// QuietHours.swift:62
let data = try await gateway.read(.v2, "quiet_hours.read")
// ManageGateway.swift:41-42
let capability = try capability(gateway, type)
guard capability.tier == .read else { throw ManageGatewayError.unknownType(gateway, type) }
// ManageGateway.swift:150-152
guard let capability = ClientCapabilities.find(gateway, type) else {
    throw ManageGatewayError.unknownType(gateway, type)
}
```
在 `Generated/ClientCapabilities.swift` 中按 `quiet_hours` 检索无结果；`ManageDemo.swift:197` 虽然写了 `quiet_hours.read` 的假响应，但能力表这一关过不去，demo 也走不到 transport。

建议
把 `quiet_hours.read`（read/query）和 `quiet_hours.set`（command，正确风险档）加进 `gateway-contracts` 的客户端能力表并在同一改动里重新生成 `ClientCapabilities.swift`；同时核对 `expectedVersion`、`enabled`、`start`、`end` 的真实服务端 schema（现有 v2 命令的 `expectedVersion` 多为 `integer`，见 `contracts-v2.ts:2610`，而这里是字符串，未核实）。如果确实要等 PR 617，则本 PR 不应新增依赖 `.loaded` 状态的测试和 demo，或者应显式标成待接口就绪后再启用。

### 2. [高] 附件功能对当前仓库的服务端不可用：`/config` 不返回附件限额，也没有 `POST attachments` 设备路由
文件:行
- `clients/apple/Sources/HimawariCore/ChatAttachments.swift:90`
- `clients/apple/Sources/HimawariCore/DeviceAttachments.swift:17`
- `packages/platform-node/src/device-api-routes.ts:88-128`、`:651-667`
- `packages/platform-node/src/strict-configuration.ts:1530-1539`

问题
客户端只有在 `configuration.attachments` 非空时才继续；而当前服务端 `/config` 只返回 `heartbeatSeconds`、`connectionMaxSeconds`、`streamConnections`、`signatureToleranceSeconds`、`limits`、`perception`，没有任何附件限额，所以 `compose` 对任何附件都会直接抛 `.serverOutdated`。即使补上限额，`uploadAttachment` 请求的是 `/api/device/v1/attachments`，当前 `DEVICE_API_ROUTES` 没有这条路由，服务端也没有对应处理函数。

证据
```swift
// ChatAttachments.swift:90
guard let limits = configuration.attachments else { throw ChatAttachmentProblem.serverOutdated }
// DeviceAttachments.swift:17
let data = try await http.send(DeviceRequest(method: "POST", path: "attachments", body: body))
```
```ts
// device-api-routes.ts:654-659
return options.sendJson(reply, 200, {
  heartbeatSeconds: configuration.heartbeatSeconds,
  connectionMaxSeconds: configuration.connectionMaxSeconds,
  streamConnections: configuration.streamConnections,
  signatureToleranceSeconds: configuration.signatureToleranceSeconds,
  limits: presentDeviceLimits(configuration),
  ...
```
`DEVICE_API_ROUTES`（88-128 行）里没有 `attachments`。`ChatAttachmentTests` 用的是自造的、带 `attachments` 的 config，所以测试发现不了真实服务端缺口。

建议
把设备端附件上传路由和 `/config` 中的 `attachments` 字段随本功能一起落地，并用真实 device API 路由/配置做集成测试；如果服务端还没有，应该在 UI 上像“通知”行一样先隐藏或禁用“+”，而不是让用户每次都看到“服务器还不支持”。

### 3. [中] “一开口就停”只在 `phase == .herTurn` 时触发，句间空隙开口会继续朗读
文件:行
- `clients/apple/Sources/HimawariListen/ChatTalkSession.swift:129-135`
- `clients/apple/Sources/HimawariListen/ChatTalkSession.swift:147-152`
- `clients/apple/Sources/HimawariListen/ChatTalkSession.swift:179-185`

问题
作者说法是“你一开口她就停下，这条回答剩下的不再读”。实现里只有当前 `phase == .herTurn` 时，收到非空转写才调用 `interrupt()`。但一句读完后、下一段流式文字还没到时，`settlePhase()` 会把 `phase` 置成 `.listening`；这时用户开口只会把话记进 `turn`，不会把 `interrupted` 置真。等下一句到达，`say()` 把 `phase` 改回 `.herTurn` 并继续朗读，压过用户正在说的话。这是交互时序上的真实缺口，不是“下一句不会读”的实现。

证据
```swift
// ChatTalkSession.swift:132
if spoken, phase == .herTurn { interrupt() }
```
```swift
// ChatTalkSession.swift:152
phase = .herTurn
```
```swift
// ChatTalkSession.swift:181-185
if sentencesRendering > 0 || buffersPlaying > 0 {
    phase = .herTurn
} else {
    phase = muted ? .muted : .listening
}
```

建议
把“主人正在说话”的判定从当前播放阶段里拆出来：只要这条回答还没结束（例如 `replySource` 非空且未 `finished`，或存在未消费的回答），收到主人非空转写就置 `interrupted` 并停播；不要以 `phase == .herTurn` 作为唯一条件。需要为“句间间隙开口”的时序补自动检查。

### 4. [中] 照片相册隐私说明与代码不一致：说明写“不传照片”，新功能实际会把照片上传
文件:行
- `clients/apple/App/iOS/en.lproj/InfoPlist.strings:14`
- `clients/apple/App/iOS/zh-Hans.lproj/InfoPlist.strings:14`
- `clients/apple/Sources/HimawariChat/Attach/AttachSheet.swift:90-101`
- `clients/apple/Sources/HimawariCore/ChatAttachments.swift:107`、`:120`

问题
相机、麦克风、定位的说明都随本功能改了，唯独相册说明仍写“照片本身不上传”。但现在从 PhotosPicker 选中的图片会被读取为 `Data`，转成 JPEG/data URL 后经附件接口上传。这个说明既与实际行为不符，也会影响 App Store 的隐私声明准确性。

证据
```text
// en InfoPlist.strings:14
"NSPhotoLibraryUsageDescription" = "Records when and where new photos and screenshots were taken. The photos themselves are not uploaded.";
```
```swift
// AttachSheet.swift:97-98
if let data = try? await item.loadTransferable(type: Data.self), let attachment = AttachReader.image(data: data, name: L.text("attach.photos")) { ... }
```

建议
三种语言同步更新 `NSPhotoLibraryUsageDescription`，明确“你从相册选中并发送的照片会发给 Himawari（上传到你自己的服务器）”，并与相机说明保持一致。

### 5. [中] 文件附件读取没有大小上限，整份文件先读进内存，存在资源耗尽风险
文件:行
- `clients/apple/Sources/HimawariChat/Attach/AttachSources.swift:33-44`
- `clients/apple/Sources/HimawariChat/Attach/AttachSheet.swift:79-86`、`:90-101`

问题
`AttachReader.file` 对用户选择的任意 `.item` 文件直接 `Data(contentsOf: url)`，PDF 直接 `PDFDocument(url:)` 后取 `document.string`；照片也先 `loadTransferable(type: Data.self)`。真正的 `textCharacters` / `imageCharacters` / `messageCharacters` 限制是在后面的 `ChatAttachments.compose` 里才剪裁，此时整份文件已经在内存里。用户选一个几 GB 的视频或超大文本，可能导致 OOM 或长时间卡住。

证据
```swift
// AttachSources.swift:34
guard let data = try? Data(contentsOf: url), let attachment = image(data: data, name: name) else { throw AttachFailure.unreadable }
// AttachSources.swift:38
guard let document = PDFDocument(url: url), let text = document.string, !text.isEmpty else { throw AttachFailure.unreadable }
// AttachSources.swift:41
guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8), !text.isEmpty else { ... }
```
```swift
// AttachSheet.swift:79
.fileImporter(isPresented: $filesOpen, allowedContentTypes: [.item], ...)
```

建议
读之前先用 `URLResourceValues.fileSize` 检查大小，并按服务端 `attachments.textCharacters` / 图片上限拒绝超大文件；限制可接受的 UTType；文本/PDF 按上限分块读取或流式提取，避免整份进内存。

### 6. [中] 安静时段保存的 600ms 防抖会用旧值覆盖刚改的另一个字段
文件:行
- `clients/apple/Sources/HimawariManage/Settings/NotificationsPage.swift:23-29`
- `clients/apple/Sources/HimawariManage/Settings/NotificationsPage.swift:62-72`

问题
`start` / `end` 都是从 `store.hours` 现算的。用户先改“从”，`save` 捕获旧的 `end`；600ms 内再改“到”，`save` 会取消上一个任务，并用当前视图里的 `start`（还是旧值）发出去，先改的“从”就丢了。先关开关再改时间也会被 `save(enabled: true, ...)` 覆盖回开启。版本冲突时虽然有重读，但正常编辑的先后顺序本身就会丢改动。

证据
```swift
// NotificationsPage.swift:28-29
ClockRow(title: M.quietFrom, time: start) { save(enabled: true, start: $0, end: end) }
ClockRow(title: M.quietTo, time: end, last: true) { save(enabled: true, start: start, end: $0) }
```
```swift
// NotificationsPage.swift:63-68
saving?.cancel()
saving = Task {
    try? await Task.sleep(for: .milliseconds(600))
    guard !Task.isCancelled else { return }
    try await store.set(enabled: enabled, start: start, end: end, ...)
}
```

建议
在页面里维护一份本地草稿（enabled/start/end），每次控件变化只改草稿，防抖任务读取草稿的当前值再提交；或者每次保存前先等上一次写完并重新读取版本，避免取消任务导致状态丢失。

### 7. [低] `<file>` 标签的 `bytes` 传的是 base64/裁剪后长度，不是文档约定的“原始大小”
文件:行
- `clients/apple/Sources/HimawariCore/ChatAttachments.swift:107`、`:124`
- `packages/platform-node/src/production-uploaded-files.ts:115`
- `packages/persistence-sqlite/src/data-export/chats.ts:288`
- `docs/adr/0090-chat-ui-v6-answer-and-composer.md:76`

问题
文档约定 `bytes="原始大小"`，但图片这里写的是整个 data URL 字符串的 UTF-8 字节数（含 `data:image/...;base64,` 和 base64 膨胀），文本这里写的是裁剪后内容的字节数。服务端把 `bytes` 当作 artifact 的 `sizeBytes`，导出时也直接输出“X 字节”，所以图片大小会偏大约三分之一，截断文本也不再是原始大小。

证据
```swift
// ChatAttachments.swift:107、124
content = "data:\(payload.mimeType);base64,\(payload.data.base64EncodedString())"
...
tags.append(MessageAttachment(name: attachment.name, ref: ref, bytes: Data(content.utf8).count, kind: kind, truncated: truncated))
```
```ts
// production-uploaded-files.ts:115
sizeBytes: file.bytes,
```
```md
// ADR 0090:76
... bytes="原始大小" ...
```

建议
图片传原图（或实际传送的二进制）字节数，文本传原始文件字节数（如果保留“截断”标记，可另存原始大小）；或者在文档和两端统一把 `bytes` 定义为“传入内容长度”，并让导出文案不再说原始大小。无论选哪种，生产者和消费者要同时改。

### 8. [低] 会话列表缩略仍显示原始 `<file .../>` 标签
文件:行
- `clients/apple/Sources/HimawariChat/ChatStore.swift:162-166`
- `clients/apple/Sources/HimawariChat/ChatListView.swift:36`、`:82-83`
- `clients/apple/Sources/HimawariChat/ChatView.swift:418`（聊天气泡已经用 `MessageAttachments.shown` 去掉标签）

问题
聊天气泡里的附件标签会被 `MessageAttachments.shown` 拆成文字和附件名，但会话列表的 snippet 直接使用 `lastMessageText`，返回的是存储的原始文本。只带附件的消息会在列表里显示 `<file name="照片" ref="..." .../>` 这样一整行内部格式。

证据
```swift
// ChatStore.swift:163-165
if let queued = queued.last(where: { $0.message.threadId == threadId }) { return queued.message.text }
guard let last = details[threadId]?.messages.last(where: { $0.role != .system }) else { return nil }
return texts[last.contentRef]
```
```swift
// ChatListView.swift:36
snippet: store.lastMessageText(in: thread.threadId),
```

建议
在 `lastMessageText` 或 `ChatListRow` 里先经过 `MessageAttachments.shown`，优先显示正文；正文为空时显示第一个附件名（或“附件”），不要把内部标签暴露给用户。

## 侧重检查

- **错误路径**：`ChatAttachmentProblem` 的四种错误映射齐全（`ChatView.swift:318-324`）；`compose` 在上传失败时不会把半成品写进历史；`QuietHoursStore.set` 版本冲突会重新读取并抛出（`QuietHours.swift:85-88`）。发现：`CurrentPlace.attachment` 的定位请求没有超时，`requestLocation` 若不回调，`locationWaiter` 会一直挂起、`locating` 永久为真（`AttachSources.swift:60-80`），建议加超时和取消。
- **不合规范/不可信输入**：附件名在 `MessageAttachments.cleanName` 去掉引号、尖括号、换行（`MessageAttachments.swift:35-40`），引用在上传后检查空白和 `"<>`（`DeviceAttachments.swift:19`），与 `production-uploaded-files.ts:12-13`、`context-projection-service.ts:30` 的解析正则相容；这是两端能对上的地方。小问题：`ClockTime("7::5")` 会被解析成 7:05（`QuietHours.swift:21-27`），对畸形输入不够严格，但值来自服务端，影响小。
- **安全/隐私**：定位和附件都是用户主动操作，方向正确；声纹删除有确认对话框（`HerPage.swift` PrivacyPage 的 `confirmationDialog`）。发现相册说明与上传行为不一致（见问题 4）。
- **资源耗尽**：`AnswerMarkdown`/`Instruction` 解析是线性的，未发现正则灾难性回溯；音频流用 `bufferingNewest(64)` 有界。发现文件附件整份读入内存（见问题 5）。
- **不可撤销操作**：暂停记忆是 tighten 无确认、恢复记忆是 change 需签名，与能力表 `memory.settings.set` 的 `tightenPayload: ["capturePaused": true]` 一致（`ClientCapabilities.swift:141`、`client-capabilities.ts:180`）；停下运行是 tighten，不弹确认，但可重新发起，风险可接受。声纹删除有确认。
- **规则/文档一致**：本 PR 没有改系统提示、工具定义、历史或遮盖代码，`prompt-prefix.md` 的“只追加”不直接受影响；但安静时段能力表/合约与文档“接口在 PR 617”不一致、相册隐私说明与代码不一致、`bytes` 语义与 ADR 0090 不一致。

## 推测与未核实

- **推测（未核实）**：`ChatView.sendRequestId` 只在成功发送后换新（`ChatView.swift:28`、`:308`）。如果 `compose` 上传到一半失败，用户在重试前换掉附件，下一次仍用同一个 `requestId`（`ChatAttachments.swift:120`）。若服务端把 `requestId` 当上传幂等键，可能拿回旧内容对应的 `ref`。服务端端点不在本仓库，无法确认；建议在附件集合变化时轮换 `requestId`。
- **未核实**：PR 617、真实服务端是否另有 `attachments` 路由和 `attachments` 配置、`quiet_hours` 的真实字段类型（尤其 `expectedVersion` 是字符串还是整数）、`requestId` 的幂等语义。
- **未核实（UI 编译）**：`Palette.swift:110` 使用 `UIContentSizeCategory(size)`（`size` 是 `DynamicTypeSize`）。本环境是 Linux，未编译 UI 目标；如果当前 SDK 没有这个初始化方法，Mac 上会编译失败。需要在 Xcode 里核实。
- **未运行测试**：本次只读复核没有执行测试。按代码推断，`QuietHoursStoreTests` 在当前提交会失败；作者所说的“HimawariCore 400 个通过”可能只覆盖 `HimawariCoreTests`，不包含 `HimawariManageTests`。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会（就本 PR 的代码路径而言）。本 PR 没有改系统提示、工具定义、历史消息或出口遮盖；`AnswerMarkdown`、`SpokenText`、`HimawariAvatar` 都只影响展示和朗读。新附件只作为新的用户消息内容，经 `ChatStore.send` 原样存入 outbox（`ChatStore.swift:288-294`），由 `Outbox` 重发同一条 `message.text`（`Outbox.swift:110-113`），所以即使重试，字节也不变。位置的时间戳、附件引用等每轮变化的值都在新追加的最后一条用户消息里；前提是附件服务端支持（问题 2）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
在当前客户端代码里没有发现新的请求头不确定性：`<file>` 标签由固定顺序的 `attachments` 数组生成，JSON 键排序由 `ManageGateway` 的 `.sortedKeys` 保证；`bytes`、`ref` 对同一份内容确定。完全确定的唯一前提是服务端对 `requestId` 不做“同键覆盖/复用”这种不透明处理（未核实，见上方推测）。遮盖结果不由本 PR 改变。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有一部分，但不完整。`AnswerMarkdownTests`、`TalkTurnTests`、`ChatAttachmentTests`、`ThreadRunStateTests`、`ThreadRunStopperTests` 覆盖了 Markdown 边界、时间阈值、附件超限/旧服务器、运行状态和停止参数；其中附件“太多/旧服务器”用例确实在发请求前停止，算有效反向用例。缺口是：
- 安静时段的 `QuietHoursStoreTests` 在当前能力表下必然失败，没有被 Linux 的 `HimawariCore` 测试覆盖到；
- 没有测试“输入框空着才显示停下”的 UI 条件；
- 没有测试语音对话打断，尤其问题 3 的句间间隙；
- `ChatAttachmentTests` 使用自造 config，不校验真实 `/config` 和 `POST attachments` 路由；
- 没有测试 `notifications` 的防抖覆盖（问题 6）和会话列表标签显示（问题 8）。

**4. 每个值的使用端都能接受吗？**
逐项核对结果：
- `<file>` 标签格式：生产端 `MessageAttachments.tag` / `ChatAttachments.compose`，消费端 `production-uploaded-files.ts:12-13`、`context-projection-service.ts:30`、`data-export/chats.ts:77` 的正则都能接受；名称清洗和 ref 校验也匹配。**能**。
- 附件上传请求体和配置限额：生产端 `DeviceAttachments.uploadAttachment` 的 path `attachments` 和 `compose` 对 `configuration.attachments` 的依赖，在当前服务端没有对应路由/字段。**不能**（问题 2）。
- `bytes`：生产端是 data URL/裁剪后长度，消费端 artifact 和导出的语义是原始大小。**不一致**（问题 7）。
- `thread.run.cancel`：payload 与 `thread-contracts-v3.ts:175-183` 完全一致（`threadId`、`runId`、`expectedRunRevision`、`resultRef`）；`workingStates` 与 `:98-107` 的状态枚举一致。**能**。
- `memory.settings.set`：payload `capturePaused` 与 `contracts-v2.ts:2780-2781`、能力表 `ClientCapabilities.swift:141`、服务端处理 `production-memory-control.ts:1807-1810` 一致；暂停 true 命中 tighten、恢复 false 落到 change，与 `client-capabilities.ts:180` 一致。**能**。
- `quiet_hours.read/set`：生产端存在，消费端能力表和合约都不存在；即使假设 PR 617 加上，`expectedVersion` 这里用字符串，而现有 v2 的 `expectedVersion` 多为整数（`contracts-v2.ts:2610`），两端类型还需按真实 schema 核对。**当前不能，未来未核实**。
- `MemorySummary`：记忆数来自 `MemoryOrganizer.groups` 只数 `status == "active"`，与记忆页使用的分组一致；规则数直接用 `store.rules.count`，规则页 `RuleList` 也显示全部 `store.rules`。**能**。
