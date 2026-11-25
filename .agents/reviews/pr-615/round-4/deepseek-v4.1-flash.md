本轮范围：只查了 PR 615 的 iPhone 侧增量。`git diff 59c29967..e88a48d1 -- clients/apple` 只显示 `HerPage.swift` 一行改动（e88a48d1c），上一轮三条意见涉及的 `c73a70f7d` 已在基准 `59c29967` 中，因此按当前代码逐条复核。读过：`AttachSources/ChatAttachments/ImageDownsampling/AttachSheet/ChatView/ChatInputBar/ChatTalkBar/ChatTalkSession/TalkAudio/HerReply/TalkTurn/HerPage/QuietHours/NotificationsPage/ThreadRunStopper` 及服务端 `production-uploaded-files.ts`、网页 `content-preview.tsx/registered-files.ts`。`59c..e88` 里来自 main/CI 的其他改动未重读；当前是 sparse checkout（53%），缺的文件用 `git show` 读。未在 Mac 上编译，也未运行测试。

上一轮三条意见的核对结论：**三条都没有真正改好**。意见 2 只把解码尺寸降下来了，整份原文件仍然读进内存；意见 3 的相机路径完全没动；意见 1 的代码与上一轮描述一致。

### 1. [中] 上一轮意见 1 未改：PDF 仍把原文件大小写进 artifact 的 sizeBytes，超过 2 MB 的 PDF 在网页仍被判“太大”

- 文件:行：`clients/apple/Sources/HimawariChat/Attach/AttachSources.swift:42`、`clients/apple/Sources/HimawariCore/ChatAttachments.swift:135`、`apps/agent-service/src/production-uploaded-files.ts:46-47,115`、`apps/control-center/src/components/content-preview.tsx:82-84`
- 问题：PDF 只上传提取出的文本，`<file bytes>` 却记原 PDF 文件大小；服务端把这个数原样存成 artifact 的 `sizeBytes`；网页把 PDF 上传归成 `document/text/plain`，文本预览按 2 MB 判断，于是原文件 >2 MB 的 PDF 即使正文只有几 KB 也显示“太大不给看”。
- 证据（读代码证实）：
  - `AttachSources.swift:42`：`return ChatAttachment(name: name, content: .text(text, kind: .pdf), originalBytes: size)`
  - `ChatAttachments.swift:135`：`bytes = attachment.originalBytes ?? Data(body.utf8).count`
  - `production-uploaded-files.ts:46-47`：`if (EXTRACTED_TEXT_KINDS.has(file.kind)) return { path: \`${file.name}.txt\`, kind: "document", mediaType: "text/plain" };`，第 115 行 `sizeBytes: file.bytes,`
  - `content-preview.tsx:82-84`：`if (!TEXT_MEDIA.test(file.mediaType) && file.kind !== "code") return { kind: "notice", id: "preview.unsupported" };` / `if (file.sizeBytes > FILE_TEXT_PREVIEW_BYTES) return { kind: "notice", id: "preview.tooLarge" };`（`FILE_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024`，见第 17 行；`file.kind === "pdf"` 才会走 25 MB 文档门槛，见第 75-79 行，但上传路径把它改成了 `document`）
- 说明：网页自己上传 PDF 时也把 `file.size` 当作 `bytes`（`chat-composer.tsx:114,131`），所以这是“tag 的 bytes / artifact 的 sizeBytes / 预览门槛”三处语义不一致的既有问题；本次让 iOS 也走进了这条路径，且仍没修。更糟的是新测试 `ChatAttachmentTests.swift:90` 把 PDF 的原始文件大小写死成期望值，修成真实 payload 大小时测试反而会失败。
- 建议：把“给模型看的原始大小”和“给预览/存储用的实际字节数”分开。例如服务端 `ProductionUploadedFiles` 用实际解密 payload 的 `byteLength` 作为 artifact `sizeBytes`，或新增独立字段；网页文本预览改用实际 payload 长度/独立字段。补一条反向用例：原 PDF 5 MB、提取文本 1 KB，`bodyOf` 必须走文本预览而不是 `preview.tooLarge`；同时调整锁死旧行为的测试。

### 2. [低] 上一轮意见 3 未改：相机照片仍不记录原始字节，`<file bytes>` 仍是重编码后的大小

- 文件:行：`clients/apple/Sources/HimawariChat/Attach/AttachSheet.swift:71-74`、`clients/apple/Sources/HimawariChat/Attach/AttachSources.swift:19-21`、`clients/apple/Sources/HimawariCore/ChatAttachments.swift:128`
- 问题：拍照走 `UIImagePickerController` 返回 `UIImage`，随后用 `image.jpegData(compressionQuality:)` 重编码，构造 `ChatAttachment` 时没有 `originalBytes`，所以 tag 只能退回 `data.count`。
- 证据（读代码证实）：
  - `AttachSheet.swift:73`：`if let image, let attachment = AttachReader.image(image, name: L.text("attach.camera"))`
  - `AttachSources.swift:20-21`：`guard let data = image.jpegData(compressionQuality: jpegQuality)` / `return ChatAttachment(name: name, content: .image(data: data, mimeType: "image/jpeg"))`
  - `ChatAttachments.swift:128`：`bytes = attachment.originalBytes ?? data.count`
- 建议：相机改用 `AVCapturePhotoOutput.fileDataRepresentation()` 之类的路径拿原始 HEIC/JPEG 字节；如果坚持用 `UIImagePickerController`，就明确“相机照片的 bytes 是重编码后大小”，并把作者说法改成只对相册/文件选图成立；补一条相机路径的单一测试（至少断言 `originalBytes` 的语义）。

### 3. [低] 上一轮意见 2 只改了一半：相册和文件选图仍把整份原文件读进内存

- 文件:行：`clients/apple/Sources/HimawariChat/Attach/AttachSheet.swift:99`、`clients/apple/Sources/HimawariChat/Attach/AttachSources.swift:37`、`clients/apple/Sources/HimawariCore/ImageDownsampling.swift:7-17`
- 问题：`ImageDownsampling` 只限制了 ImageIO 解码出的缩略图尺寸，但调用方仍先用 `loadTransferable(type: Data.self)` / `Data(contentsOf:)` 把整份原文件加载进内存，再交给 `CGImageSourceCreateWithData`。降采样减少的是解码内存，不是原始文件读入内存。
- 证据（读代码证实）：
  - `AttachSheet.swift:99`：`if let data = try? await item.loadTransferable(type: Data.self), let attachment = AttachReader.image(data: data, name: ...)`
  - `AttachSources.swift:37`：`guard let data = try? Data(contentsOf: url), let attachment = image(data: data, name: name)`
  - `ImageDownsampling.swift:7-9`：`public static func jpeg(_ data: Data, ...)` / `CGImageSourceCreateWithData(data as CFData, ...)`
- 推测：峰值内存还受原图大小影响；单张 48 MP HEIC 或 panorama 可能带来明显内存尖峰，具体数值未测。
- 建议：文件导入路径用 `CGImageSourceCreateWithURL(url, ...)` 或懒加载源；PhotosPicker 用 `FileRepresentation`/文件 URL 的 `Transferable`，不要把整个 asset 的 `Data` 全读进来。至少补一条“大图从 URL 读、不整份进内存”的测试或明确记录限制。

### 4. [低] 语音对话启动失败时，已启动的识别流水线没有停止，麦克风可能一直占着

- 文件:行：`clients/apple/Sources/HimawariListen/ChatTalkSession.swift:44-53`、`clients/apple/Sources/HimawariChat/ChatView.swift:341-344`、`clients/apple/Sources/HimawariListen/ChatDictation.swift:42-46`
- 问题：`pipeline.start` 成功后，`TalkAudio.start()` 抛错会直接跳出 `begin`；此时 `self.pipeline` / `self.audio` 还没赋值，局部 `pipeline` 没有被 `cancel`。`ChatView` 的 catch 只把 `talking` 设为 `false`，也没调用 `talk.end()`。本地的 pipeline 被自己的闭包/任务持有，后续 `begin()` 的 `await end()` 也找不到它，可能泄漏麦克风/识别会话。`ChatDictation` 的 `capture.start()` 在 `pipeline.start()` 之后抛错也是同一模式。
- 证据（读代码证实）：
  - `ChatTalkSession.swift:44-54`：`try await pipeline.start { ... }` / `let audio = TalkAudio()` / `try audio.start()` / `self.audio = audio`（赋值在抛错之后）
  - `ChatView.swift:341-344`：`try await talk.begin { ... }` / `catch { ... talking = false; attachProblem = ... }`，没有 `talk?.end()`
  - `ChatDictation.swift:42-46`：`try await pipeline.start { ... }` / `try capture.start()` / `self.capture = capture`
- 推测：是否真的持续占用麦克风取决于 `SpeechPipeline` 的内部实现；未在真机验证，但“没有执行 cancel”是代码事实。
- 建议：把 `audio.start()` / `capture.start()` 包进 `do/catch`，失败时 `await pipeline.cancel()` 后重新抛出；`ChatView.startTalk` 的 catch 里加 `await talk?.end()`。补一个注入“启动音频引擎会抛错”的失败路径测试，断言 `cancel` 被调用。

### 5. [低] 安静时段版本冲突路径没有自动检查，现有测试只覆盖成功路径

- 文件:行：`clients/apple/Sources/HimawariManage/Settings/QuietHours.swift:104-122`、`clients/apple/Tests/HimawariManageTests/QuietHoursStoreTests.swift:46`
- 问题：`set` 在 catch 里重新 `load()` 再抛出，符合作者说法；但测试 `testSavingSendsTheVersionItReadAndReloads` 和 `testTwoQuickEditsBothReachTheServer` 的假服务器永远成功，没有覆盖冲突/失败后的重新读取和错误传播。反向用例不存在。
- 证据（读代码证实）：`QuietHours.swift:119-122`：`} catch { await load(); throw error }`；`QuietServer` 中没有失败分支，`quiet_hours.set` 永远返回成功。另：`saveDraft` 的 `defer { if draft == wanted { draft = nil } }` 在冲突失败时也会清掉草稿（第 100 行），用户这次编辑会丢失，只看到通用失败提示。
- 建议：加一个在 `quiet_hours.set` 返回冲突的假服务器，断言：重新读取发生、错误被抛出、UI 明确提示；同时决定冲突时是否保留草稿，避免静默丢失编辑。

### 6. [低] “停下”只在输入框空着时出现的说法与代码不完全一致：上传附件期间有字也会出现停下

- 文件:行：`clients/apple/Sources/HimawariChat/ChatInputBar.swift:23-24,44`、`clients/apple/Sources/HimawariChat/ChatView.swift:368`
- 问题：`stop` 的显示条件是 `!canSend`，而 `canSend = !sending && (hasAttachments || 有字)`。上传附件时 `creating = true`（`sending = true`），即使输入框有字、有附件，`canSend` 也为 false，于是正在回答时会显示“停下”而不是发送。作者说“输入框空着时才出现”并不严格成立；正常有字未上传时确实隐藏停下。
- 证据（读代码证实）：`ChatInputBar.swift:23-24`：`!sending && (hasAttachments || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)`；第 44 行 `if let stop, !canSend`；`ChatView.swift:368`：`creating = true` 包住整段上传/发送。
- 建议：如果目标是“输入框空着且无附件才显示停下”，把条件写成独立于 `sending` 的 `text.isEmpty && !hasAttachments`；或者明确 `sending` 期间停下的优先级并补 UI 测试。

## 侧重检查

- **错误路径**：附件不可读/超 20 MB/PDF 无文字/图片解码失败均映射到 `AttachFailure`（`AttachSources.swift:29-47`）；上传配置失败映射为 `uploadFailed`；安静时段冲突会重新读取并抛错（第 5 条）；语音启动失败存在清理缺口（第 4 条）；听写启动同样缺清理。
- **不合规范或不可信输入**：文件名在 `MessageAttachments.cleanName` 去掉引号、`<>`、CRLF（`MessageAttachments.swift`），服务端正则也排除了这些字符；`<file bytes>` 只接受数字（`production-uploaded-files.ts:12-13`）；图片经 ImageIO 缩略图路径，恶意/超大图不会按原尺寸解码（`ImageDownsampling.swift`）。相册/文件图片仍整份读入内存（第 3 条），相机路径还可能经 `UIKitImageFitter` 再解码一次。
- **安全**：未发现新增的日志泄漏、越权读取或明文密钥；位置附件会把精确坐标和时间戳放进消息，这是“我现在的位置”功能的明确意图。上传 artifact 的 `path` 来自文件名，服务端只做长度/非空检查、没有路径穿越检查，但该上传路径只把它当元数据/展示名，没有看到用它做文件系统读写，未发现可利用点。
- **资源耗尽**：第 3 条的整份读入、相机全尺寸 `UIImage` + `UIKitImageFitter` 反复解码是主要风险；本轮未实测峰值。
- **不可撤销操作**：停止回答是显式且带 `expectedRunRevision` 的（`ThreadRunStopper.swift:23`）；暂停记忆可撤销；恢复记忆走 `change` 会签名确认（`ManageGatewayTests.swift:95` 也有用例）；删除声纹有确认框。安静时段冲突只丢当前草稿，不删除服务器数据。
- **规则/说明与代码一致性**：`prompt-prefix` 的“只追加”未被本次改动破坏（见下）；安静时段、暂停/恢复记忆的说法与代码一致；“停下”的条件比说法宽（第 6 条）；“图片记原始大小 / 文件记文件大小”对相机不成立（第 2 条），相册/文件也仍整份读入（第 3 条）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 本次 `e88` 只改 `HerPage.swift:247` 的 `Binding` 闭包，不碰系统提示、工具定义、历史或遮盖。PR 新增的 `<file>` 标签是作为新的用户消息追加在末尾；每轮会变的定位时间、`bytes`、`ref` 都在最后这条消息里，符合 [prompt-prefix 第 4 条](.agents/instructions/prompt-prefix.md#rules) 的“只在末尾追加”。PDF 的 `bytes` 从提取文本大小改成原文件大小只会影响**新**消息，不会改写已发出的历史，所以请求开头仍不变。**未核实**：没有实际跑多轮 `check:prompt-prefix`，依据是代码阅读。`<file bytes>` 表示的大小不真实是数据质量问题（第 1 条），不是前缀问题。

2. **同一段文字会不会在不同请求里变成不同字节？** `e88` 没有产生任何新值。`c73` 的 `originalBytes` 在一次选择内固定（`data.count`/文件大小），`maxImagePixels = 4096` 和 JPEG quality 都是常量，没有引入依赖后文的遮盖、时间字段或无序集合。定位时间戳只在捕获时写入一次，之后随消息固定。**推测**：PhotosPicker 对同一张照片两次选择返回的 `Data` 表示可能不同（未验证），但只要消息已提交，历史里的字节就不变；不会影响已有请求开头。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 分项说：
   - `e88`：没有单元测试，只靠 `apple/iphone` 的 `xcodebuild build`（`.github/workflows/apple.yml`，`macos-26`）覆盖；提交说明里的 `swiftc -parse` 无法复现代码生成崩溃，单靠它不够。**未核实** CI 实际结果，也未见 Xcode 版本被固定。
   - 意见 1：没有反向测试；反而 `ChatAttachmentTests.swift:90` 把“PDF tag 使用原文件大小”写成期望值，改成正确行为会失败，等于把问题锁死。网页侧也没有 `bodyOf` 对 `text/plain` 且 `sizeBytes > 2 MB` 的反向用例。
   - 意见 2/3：有 `ImageDownsamplingTests`（仅 Mac 跑）验证缩略图尺寸，但没有“整份文件不进内存”或“相机记录原始字节”的测试。
   - 第 4 条：没有启动失败的测试。
   - 第 5 条：安静时段冲突路径没有测试（第 5 条已述）。
   - 停止/版本：`ThreadRunStopperTests.swift:24` 覆盖了 `expectedRunRevision`，但没有覆盖“有字时是否显示停下”的 UI 条件。

4. **每个产生/修改的值，使用端都能接受吗？**
   - `ChatAttachment.originalBytes` → `ChatAttachments.swift:128,135` 的 `bytes` → `<file bytes>` → 服务端 `uploadedFiles` 正则 `\d+` → `ProductionUploadedFiles` 的 `sizeBytes: file.bytes` → SQLite 只校验安全整数且 `>= 0`（`sqlite-thread-artifact-operations.ts:106-107`）→ 网页 `parseRegisteredFile` 校验 `>= 0` → `bodyOf` 文本预览 2 MB 门槛。结构校验都能过，但网页这一端在 PDF 上不能接受（第 1 条）；`files-library` 还会把原文件大小显示成“已存储大小”，同样误导。
   - `ChatAttachmentPlanner.maxImagePixels` → `ImageDownsampling.jpeg` 默认参数，使用端一致。
   - 安静时段 `version: String` → 契约 `expectedVersion: boundedString(64)`，`ClockTime.text` 生成的 `HH:MM` 满足 `proactiveClockSchema`（`contracts-v2.ts:397-403,621-628`），使用端可接受。
   - `memory.settings.set` 只发 `capturePaused`，契约 payload 就是 `{ capturePaused: boolean }`（`contracts-v2.ts:2816-2819`）；能力表把 `capturePaused: true` 标成 `tighten`，`false` 走 `change`（`ClientCapabilities.swift:143`），与作者说法一致，`ManageGatewayTests.swift:95` 有对应用例。
   - `e88` 本身不产生值；`Binding<Bool>` 的 set 签名匹配。
   - 相机/定位不传 `originalBytes` 时回退到 `data.count`，服务端可接受；`ChatAttachment` 初始化没有校验 `originalBytes >= 0`，当前所有生产调用点都是非负，未来若新增调用点需注意。
