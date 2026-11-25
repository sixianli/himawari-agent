本轮以 `5875948` 相对 `f8eb4` 的增量为主，同时对照上一轮意见。`f8eb4..5875948` 实际夹带了 `28caa1f9b` 的主干合并（control-center、runtime-pi、prompt-catalog 等约 400 个与本 PR 无关的文件），因此我把范围限定在 PR 615 相关路径：`clients/apple/{HimawariChat,HimawariCore,HimawariListen,HimawariManage,HimawariShell,HimawariDesign}`、`packages/gateway-contracts` 的 `quiet_hours`、`apps/agent-service` 的安静时段控制、`packages/platform-node/src/device-api-routes.ts` 的 `/config`，以及相关测试；只在证据指向旧代码时继续追。主干合并里其它 PR 的 prompt/runtime 文件未逐行复核。

### 1. [高] 附件/拍照/文件/位置在当前仓库服务端仍不可用，这次只是把“+”藏了起来，上一轮意见 2 没有真正修好
- 文件:行：`packages/platform-node/src/device-api-routes.ts:651`、`clients/apple/Sources/HimawariCore/DeviceAttachments.swift:17`、`clients/apple/Sources/HimawariChat/ChatView.swift:134`、`clients/apple/Sources/HimawariShell/RootView.swift:129`、`clients/apple/Tests/HimawariCoreTests/ChatAttachmentTests.swift:90`
- 问题：设备端 `/config` 仍不返回 `attachments` 限额，设备 API 路由表里也没有 `POST /api/device/v1/attachments`。客户端因此把 `acceptsChatAttachments` 判为 false，直接让 `attachAction` 返回 nil。结果“拍照、照片、文件、我现在的位置”整个入口在真实服务端上永远不会出现；位置入口也在附件面板里，一并不可达。上一轮意见 2 的核心问题仍在，只是从“点了报错”变成“根本看不到”。
- 证据（读代码证实）：
  - `/config` 只返回 `heartbeatSeconds/connectionMaxSeconds/streamConnections/signatureToleranceSeconds/limits/perception`，没有 attachments：
    `device.get("/config", ... { ... limits: presentDeviceLimits(configuration), ... })`
  - 路由清单只有 `/uploads/begin`、`/payloads/text` 等，没有 `/attachments`；而客户端上传写的是 `DeviceRequest(method: "POST", path: "attachments", ...)`，即 `/api/device/v1/attachments`（`DeviceAPIClient.swift:68` 的 prefix 为 `/api/device/v1/`）。
  - `ChatView.attachAction`：`guard Self.attachAvailable, canAttach else { return nil }`；`RootView` 传入 `.environment(\.chatCanAttach, model.configuration?.acceptsChatAttachments == true)`。
  - 新增测试只验证合成配置字符串上 `acceptsChatAttachments` 的布尔值，不验证真实 `/config` 或真实上传路由。
- 建议：要么在本仓库补上 device API 的 `/config` attachments 字段与 `POST attachments`（含幂等 requestId、大小/类型校验和服务端测试），要么明确把此功能从本 PR 目标里拿掉并删除对应 UI/文案；无论哪种，都补一条“服务端不支持时真实 UI 不提供入口”的反向测试。

### 2. [中] 图片附件只限制了压缩文件字节数，解码像素没有上限，仍存在内存耗尽风险
- 文件:行：`clients/apple/Sources/HimawariChat/Attach/AttachSources.swift:33`、`clients/apple/Sources/HimawariChat/Attach/AttachSources.swift:37`、`clients/apple/Sources/HimawariChat/Attach/AttachSheet.swift:99`、`clients/apple/Sources/HimawariCore/ChatAttachments.swift:117`
- 问题：上一轮意见 5 的 20 MB 上限只挡“文件压缩后的字节数”，随后仍对整张图调用 `UIImage(data:)` 并 `jpegData` 重新编码；一张 20 MB 的 PNG/HEIC 可以解出远大于 20 MB 的像素缓冲。PhotosPicker 路径（`item.loadTransferable(type: Data.self)`）甚至没有先做 20 MB 压缩大小检查。
- 证据（读代码证实）：`guard ChatAttachmentPlanner.fileFits(bytes: size)` 后紧接着 `guard let data = try? Data(contentsOf: url), let attachment = image(data: data, name: name)`，而 `image(data:)` 会 `UIImage(data:)` 再 `jpegData`。图库路径直接 `loadTransferable(type: Data.self)` 后进 `AttachReader.image(data:name:)`。
- 推测：是否真的 OOM 取决于图片像素数和设备可用内存，未在真机验证；但代码层面没有像素尺寸/解码后字节上限。
- 建议：用 ImageIO 的 `CGImageSourceCreateThumbnailAtIndex` 按最大像素尺寸降采样后再生成 JPEG，或先读图片元数据拒绝超大像素；对 PhotosPicker/相机路径同样套用上限；加一个“极小压缩体积、极大像素”的构造用例。

### 3. [低] 图片 `<file bytes>` 仍是重编码/缩放后的大小，不是文档约定的“原始大小”
- 文件:行：`clients/apple/Sources/HimawariCore/ChatAttachments.swift:125`、`clients/apple/Sources/HimawariCore/ChatAttachments.swift:132`、`docs/adr/0090-chat-ui-v6-answer-and-composer.md:76`、`apps/agent-service/src/production-uploaded-files.ts:115`
- 问题：上一轮意见 7 只修好了文本：文本用 `Data(body.utf8).count` 记录裁剪前大小；图片仍用 `payload.data.count`，而 `payload` 可能已经被 `images.fit` 缩放，且来源已被 `AttachReader.image` 重编码为 JPEG 0.85。服务端把这个值直接写成 `sizeBytes`。因此图片的“原始大小”仍可能和文件实际原始大小不一致。
- 证据（读代码证实）：`bytes = payload.data.count`（图片分支）；文本分支才是 `bytes = Data(body.utf8).count`。ADR 0090 写的是 `bytes="原始大小"`；`production-uploaded-files.ts` 用 `sizeBytes: file.bytes` 落库。
- 建议：在 `ChatAttachment` 里保留“原始文件字节数”并一路带到 tag，或在文档/测试里明确图片 `bytes` 是“上传后的存储大小”；补一条图片重编码/缩放后的字节断言。

### 4. [低] 本轮新增的关键行为缺少反向用例：AttachReader 大小拦截、requestId 重置、入口隐藏、防抖合并都没有直接测试
- 文件:行：`clients/apple/Tests/HimawariCoreTests/ChatAttachmentTests.swift:96`、`clients/apple/Tests/HimawariManageTests/QuietHoursStoreTests.swift:61`、`clients/apple/Sources/HimawariChat/ChatView.swift:216`
- 问题：新增测试覆盖的是纯函数/Store，不是真正会出错的接线：
  - `filesOverTheSizeCapOrOfUnknownSizeAreNotRead` 只测 `fileFits`，没有测 `AttachReader.file` 在超大/未知大小时会抛 `.tooLarge/.unreadable`；
  - 没有测“换附件后 `sendRequestId` 会换新”的 UI/存储逻辑（`ChatView.swift:216` 的 `onChange(of: attachmentIds)` 无测试）；
  - 没有测 `canAttach == false` 时 `+` 不出现（测试只测布尔属性）；
  - 安静时段测试直接调 `saveDraft`，没有覆盖 NotificationsPage 的 600 ms 防抖与“旧任务等待新任务”的合并逻辑。
- 证据（读代码证实）：上述测试文件内容与对应实现位置。若把 `fileFits` 的 guard 或 `onChange(of: attachmentIds)` 删掉，现有测试不会失败。
- 建议：把可测试的决策抽到 Core（如“给定 attachment ids 是否重置换 requestId”“给定配置是否允许附件”），对 `AttachReader` 的拒绝路径和防抖合并注入可控时钟/时钟任务做反向测试；UI 层至少在 Linux 可编译的目标里测状态机。

## 上一轮意见核对
- 1（安静时段能力表/服务端合约）：已改好。`ClientCapabilities.swift:118-119`、`packages/gateway-contracts/src/client-capabilities.ts:157-158`、`contracts-v2.ts:604-625`、`production-quiet-hours-control.ts:14-16` 都在；`client-parity.test.ts` 还校验 Swift 生成表必须与合约表一致，反向用例有效。
- 2（附件服务端不可用）：未真正改好，见上面意见 1；只是隐藏入口。
- 3（句间空隙打断）：已改好。`HerReply.expectsMore` 在 `!finished && !interrupted` 时仍为真，`ChatTalkSession.swift:122` 用 `reply.ownerSpoke(whileSpeaking: phase == .herTurn)`，不再只看 phase；`TalkTurnTests.swift:47-53` 是有效反向用例。
- 5（文件大小上限）：已加上 20 MB 上限，但仍只限压缩字节，见意见 2。
- 6（防抖覆盖另一字段）：已改好。`QuietHoursStore.Choice`/`draft`/`saveDraft` 让一次保存带完整字段；`QuietHoursStoreTests.swift:61-77` 覆盖了“两次快速编辑一起提交”。
- 8（会话列表原始 `<file>` 标签）：已改好。`ChatStore.lastMessageText` 走 `MessageAttachments.preview`，`ChatAttachmentTests.swift:104-108` 覆盖。
- 10（换附件仍复用 requestId）：已改好。`ChatView.swift:216-218` 在附件 id 列表变化时重置换 `sendRequestId`；但缺直接测试（见意见 4）。
- 4（照片隐私说明）：已改好。三语 `InfoPlist.strings` 的 `NSPhotoLibraryUsageDescription` 都补上了“+ 里选的照片会发给她”，与实际上传路径一致。
- 7（bytes 原始大小）：文本已修好；图片仍不是原始大小，见意见 3。

## 作者说法核对
- “停下只在有正在进行的回答（workingRun 非空）且输入框空着时出现”：前半句对（`ChatView.swift:306-307`），后半句不完全对。`ChatInputBar` 用 `!canSend` 决定显示停下，而 `canSend` 包含 `hasAttachments`（`ChatInputBar.swift:23-24`）；所以“输入框空着但带着附件”时显示的是发送，不是停下。若产品语义是“没有任何可发送内容才显示停下”，代码与说法不一致。
- “被打断的后续不再读，新回答重新读”：对，`HerReply.swift:22-29` 与测试一致。
- “安静时段带读到的 version，冲突重读并报错”：对，`QuietHours.swift:107-121` 发送 `hours.version`，catch 中 `await load()` 后重新抛出，页面 `failed` 弹窗。
- “暂停记忆 tighten、恢复记忆 change”：对，`ClientCapabilities.swift:143` 对 `memory.settings.set` 配了 `tightenPayload: ["capturePaused": true]`，即 `capturePaused=true` 走 tighten，`false` 走 change。
- “附件经设备接口上传后作为 `<file>` 标签随消息发出”：代码路径存在（`ChatStore.send` → `api.compose` → `uploadAttachment` → `MessageAttachments.compose` → 新消息），但当前服务端没有对应接口，见意见 1。
- “隐私（……收听开关……）”：增量里 `PrivacyPage` 已经没有独立收听开关，`HerListening` 也删了 `isListening/stop`，只剩“让她感知”和声纹。若这是原型 Version 62 的有意调整则不是 bug；按 PR 目标文字则不一致，未核实最终设计意图。

## 侧重检查
- 错误路径/不可信输入：`AttachReader.file` 对不可读、未知大小、超 20 MB 有拒绝；文件名经 `MessageAttachments.cleanName` 去掉引号/尖括号/换行；`parseTag` 拒绝没有 `ref`/`kind` 的伪标签。但拒绝路径没有直接测试（意见 4）。
- 安全/隐私：三语照片、相机、麦克风、位置说明已与实际“会发给 Himawari”一致；上传引用仍按“不含空白和引号”校验（`DeviceAttachments.swift:19`）。附件入口被配置门控，不会对旧服务端发起上传。
- 资源耗尽：文本文件有 20 MB 压缩体积上限；图片解码像素无上限，仍是主要残余风险（意见 2）。
- 不可撤销操作：断开这台 iPhone 有确认对话框；遗忘声纹有确认；安静时段写入是 `.change` 需确认，冲突会重读并报错。行为合理。
- 规则/文档/代码一致性：安静时段能力表与合约一致，且有 `client-parity` 校验；`bytes="原始大小"` 对图片仍不一致；附件目标与当前服务端不一致。
- 主干合并提示：`f8eb4..5875948` 里的 prompt-catalog/runtime-pi/control-center 等大量文件来自 `origin/main` 合并，不属于 PR 615 作者说法范围，未按本 PR 逐行复核；若要求覆盖整个 diff，需要另开范围。

## 必答问题
1. **不会改变模型已经见过的请求开头。** PR 615 只改 iPhone 客户端；附件通过 `MessageAttachments.compose` 把 `<file .../>` 接在当前用户消息正文的末尾，再作为一条新消息发送（`ChatAttachments.swift:143`、`MessageAttachments.swift:42-43`、`ChatStore.swift:302-308`）。没有改动系统提示、工具定义、历史消息或遮盖逻辑。`preview` 只用于会话列表。位置文本里的时间戳和附件 `ref` 都在新消息末尾，不在请求开头。主干合并里 prompt/runtime 的变更不属于本 PR，未计入。
2. **不会让同一段文字在不同请求里变成不同字节。** 文本 `bytes` 现在是原始 UTF-8 字节数，文件名清洗和附件顺序确定，`requestId` 只用于上传幂等、不进入模型文本，没有依赖前后文的遮盖或无序集合。唯一可注意的是图片 `bytes` 取的是缩放/重编码后的字节数，若服务端图片限额变化，同一张图可能产生不同 `bytes`；这不是上下文相关变形，但属于意见 3 的一致性问题。
3. **有部分自动检查，关键接线仍缺反向用例。** 有效的反向用例：句间打断（`TalkTurnTests.swift:47-53`）、两次快速编辑合并（`QuietHoursStoreTests.swift:61-77`）、文本原始字节（`ChatAttachmentTests.swift:79-88`）、`fileFits` 边界（`:96-102`）、列表预览去标签（`:104-108`）、客户端能力表与合约双向一致（`client-parity.test.ts:180-191`）。不足：`AttachReader` 的实际拒绝、`sendRequestId` 重置、`+` 的真实隐藏、防抖任务合并都没有测试，删掉对应实现现有测试不会红。
4. **逐个值核对两端：** `quiet_hours.set` 的 `expectedVersion/enabled/start/end` 与合约 `contracts-v2.ts:604-625`（HH:MM、非空 version）及服务端 `setQuietHours` 一致；`quiet_hours.snapshot` 字段与客户端 `QuietHours` 解码一致；`acceptsChatAttachments` 被 `RootView.swift:129` 接受但真实服务端永远给 false（意见 1）；`sensesOn` 的 `[String].count` 是服务端已启用 sense 数，`M.sensesOn` 可用；`AttachFailure.tooLarge` 在 `ChatView.describe` 与三语字符串都有；`deviceMobilePlain` 在 `IconName`、`icons.json` 的 `device-mobile@plain` 与 `.imageset` 名称一致；`HerReply` 只被 `ChatTalkSession` 和测试使用，类型/接口匹配。除附件服务端缺口和图片 `bytes` 外，没发现新的两端校验不一致。
