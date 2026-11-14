## 侧重检查

我优先查了这些路径：

- **错误路径**：旧服务端、404/413/4xx/5xx、队列失败后是否保留、`.failed` 的界面语义。发现旧服务端图片路径会被判成 `rejected` 并丢弃；`.failed` 仍宣称“这一页的全文”。
- **不合规范或不可信的输入**：分享面板的网页全文、用户请求文本、`URL` 协议、`captureSource`/`type`/`evidence.kind` 等字符串。发现 `.link` 不限制 `http/https`，请求文本未按服务端上限校验，若服务端校验采集来源清单则新值未经验证。
- **安全**：钥匙串 service/access group 改动、扩展与主 App 的共享存储、页面内容进入服务端/模型。发现已有配对凭据会因 service/group 改变而读不到。
- **资源耗尽**：`innerText` 全文、队列文件、离线反复分享、大图补交。发现队列无大小上限、跨进程无文件锁、补交路径没有图片压缩器。
- **不可撤销的操作**：队列对 `.failed` 直接删除、失败后内容不保留。发现失败内容会静默消失。
- **规则、说明文档和代码一致**：设计文档说采集来源“Swift 由清单生成”，代码是硬编码；README 说没连上会排队，但图片旧服务端路径不排队；作者说“不动发给模型的内容”，但给定 diff 范围里有 prompt-catalog 工具说明变更（可能是合入 main 带来）。

## 意见

### 1. 高：换掉钥匙串 service 并新增 access group 会让已配对设备读不到旧凭据
`clients/apple/Sources/HimawariCore/SharedVault.swift:7-8`、`clients/apple/Sources/HimawariShell/AppModel.swift:59-62`

**问题**：改动前 `AppModel` 用 `(bundle.bundleIdentifier ?? "himawari") + ".device"` 作为 Keychain service，工程里的 bundle id 是 `win.siyi.himawari`（`project.pbxproj:501`），旧条目在 `win.siyi.himawari.device` / `win.siyi.himawari.device.keys`。现在统一读 `"himawari.device"`，并且查询显式带上 `HIMAWARI_KEYCHAIN_GROUP`。旧配对记录和设备密钥都不在新 service/新 access group 下，升级后会表现为未配对或密钥不可读；代码里没有迁移分支，测试也没有覆盖。

**证据**：
- diff 中旧代码：`let service = (bundle.bundleIdentifier ?? "himawari") + ".device";`、`keys = SecureEnclaveKeyStore(service: service + ".keys")`
- 新代码：`public static let service = "himawari.device"`（`SharedVault.swift:7`）
- `AppModel.swift:59-62` 直接 `keys = vault.keys`、`keychain = vault.keychain`
- 全仓库搜索不到 `himawari.device` 的迁移或旧 service 回退。

**建议**：先读旧 service（带旧 bundle id）和旧默认 access group，成功后再写入新 service/group；同时加一个“旧 keychain 条目升级后仍能恢复配对”的测试。扩展上线前应明确是否需要“重新配对”的降级方案。

### 2. 高：旧服务端上交图片会被判成 rejected 并直接丢弃，不是作者说的 serverOutdated
`clients/apple/Sources/HimawariCore/Handover.swift:202-212`、`:396-400`、`:411-421`；`packages/platform-node/src/device-api-routes.ts:47-61`

**问题**：`plan` 对“没有 request 的图片”先进入 `.media`，完全不检查 `configuration.attachments` 或 `configuration.perception`。旧服务端 config 没有这两个字段，但 `device.upload.file_bytes` 是有的，因此 `imageBudget` 能算出来，随后请求 `uploads/begin`。当前服务端路由表没有 `uploads/begin`，会返回 404；`outcome` 对 404 返回 `.failed(.rejected)`，而 `HandoverDesk.hand` 只把 `.queued` 放进队列，所以图片既没交给服务端，也没有降级成 `serverOutdated`，更不会重试。

**证据**：
- `if case let .image(_, mimeType, _) = handover.content { return .media(kind: "image", contentType: mimeType) }`（`Handover.swift:207-209`）
- `.media` 分支：`try await api.uploadMedia(...)`（`:399`）
- `DEVICE_API_ROUTES` 只到 `payloads/text`，没有 `uploads/begin`、`attachments`、`perception`（`device-api-routes.ts:47-61`）
- `if status == 413 || code == "DEVICE_UPLOAD_TOO_LARGE" { ... }` 之后只有 429/5xx/408/clock/pending 会 queued，其余返回 `.failed(.rejected)`（`Handover.swift:415-420`）
- `HandoverDesk.hand`：`if outcome == .queued { try queue.add(handover) }`（`:551-552`）

**建议**：把 `.media` 也纳入服务端能力检查（例如 config 有 `attachments`/`perception` 或显式上传能力才走），或在 404/未知路由时返回 `.serverOutdated`/`.queued`；不要因为接口未上线就丢弃用户刚交的图片。补一条“旧服务端图片→serverOutdated/queued”的反向测试。

### 3. 中：用户请求文本没有按 `messageCharacters` 校验，服务端拒绝后整页内容会被丢弃
`clients/apple/Sources/HimawariCore/Handover.swift:373-387`；`clients/apple/Sources/HimawariCore/MessageAttachments.swift:46-48`

**问题**：会话路径只裁剪附件文本，`handover.request` 原样拼进消息：`text: MessageAttachments.compose(text: handover.request ?? "", attachments: [tag])`。`AttachmentLimits` 里的 `messageCharacters`、`perMessage` 完全没有用于这条路径；而现有 Mac 输入条会先调用 `MessageAttachments.fits`。用户从分享面板粘贴一大段请求时，客户端会先成功上传附件，再让 `POST messages` 因超长被拒，最终 `.failed(.rejected)`，队列不收，整页内容和请求都消失。

**证据**：
- `Handover.swift:381` 直接使用未裁剪的 `handover.request`
- `MessageAttachments.fits` 已存在但手里这条路径没有调用（`MessageAttachments.swift:46-48`）
- `HandoverPlanner.conversationPlan` 只处理 `limits.textCharacters` / `imageCharacters`（`Handover.swift:214-234`）

**建议**：在 `conversationPlan` 里用 `MessageAttachments.fits` 校验完整消息；超限时明确裁剪请求或返回 `.tooLarge`，并且在附件上传前完成校验，避免留下孤儿附件。补一条“请求文本超 `messageCharacters`”的测试。

### 4. 中：`.failed` 仍显示“这一页的全文”，但内容既没发出也没排队
`clients/apple/Sources/HimawariCore/Handover.swift:183-189`；`clients/apple/Sources/HimawariShare/HandoverSheet.swift:91-95`

**问题**：`keepsWhatWasRead` 对 `.failed` 返回 `true`，界面因此把 `sheet.fullPage` 拼进副标题。可 `.failed(.serverOutdated/.tooLarge/.rejected)` 不会重试，也不会进入队列，正文其实没有交给 Himawari。这和提交说明里的“只在真读到正文、还会交给它时才写‘这一页的全文’”不一致。

**证据**：
```swift
case .delivered, .queued, .failed: true
case .entryOff, .deviceRemoved: false
```
以及 `case .page: return content?.pageSubtitle(fullText: L.text("sheet.fullPage"), outcome: phase.outcome, ...)`。

**建议**：`.failed` 应为 `false`，或区分“已排队会交”和“已失败不会交”。补一条 `.failed(.serverOutdated)` 的副标题测试。

### 5. 中：新的采集来源和类型字符串没有共享清单，测试只是复读同一字面量
`clients/apple/Sources/HimawariCore/Handover.swift:25-29`、`:252-279`；`clients/apple/Tests/HimawariCoreTests/HandoverTests.swift:64-80`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:728`

**问题**：设计文档明确写采集来源“服务器按清单校验；Swift 由清单生成”，但客户端把 `"share_extension"`、`"safari_extension"`、`"web.page"`、`"share.item"`、`"string"`、`"none"`、`"required"` 全部硬编码。测试只断言这些字面量本身，没有和任何服务端清单/契约对照；PR 451 若使用不同名称，测试仍会全绿，而服务端会把记录全部拒绝。这正是“清单里的 id 能通过后端校验吗”那类问题。

**证据**：
```swift
case .share: "share_extension"
case .safari: "safari_extension"
```
以及 `guard let field = rule.evidence[key], field.kind == "string" else { continue }`、`switch rule.text { case "none": ... }`。

**建议**：把采集来源/类型/字段 kind 放进两端共享的清单或由服务端 config 下发；至少加一个与 PR 451 服务端 schema 对齐的契约测试。若暂时不能共享，应在客户端注释/文档中明确这些字符串是待服务端确认的接口常量，并加“服务端拒绝未知 captureSource”恢复路径。

### 6. 中：待传队列没有大小上限，扩展和主 App 还可能同时 drain
`clients/apple/Sources/HimawariCore/Handover.swift:425-475`、`:549`；`clients/apple/Sources/HimawariShell/AppModel.swift:372-382`；`clients/apple/Sources/HimawariCore/LocalStore.swift:12-13`

**问题**：`HandoverQueue` 每次 `add` 都原样写整个 `Handover`（图片以基类 JSON 编码，文件更大），没有按 `device.queue.bytes` 或任何上限丢弃最旧项。设计文档要求 500 MB 上限并“先丢最旧的低价值类型”，代码没有实现。更严重的是队列锁是 `NSLock` 实例锁，只在一个进程内有效；分享扩展的 `HandoverDesk.hand` 会先 `queue.drain`，主 App 的 `deliverWaitingHandovers` 也会 drain，两个进程可同时读改写 `handover-index`，存在丢失索引项、重复发送或文件损坏的窗口。`add` 先写内容再写索引，崩溃在中间也会产生永远读不到的孤儿文件。

**证据**：
- `private let lock = NSLock()`（`Handover.swift:427`）
- `try store.write(Self.prefix + handover.id, ...); var list = ids(); ... try store.write(Self.index, ...)`（`:444-447`）
- `_ = await queue.drain(using: courier)` 在扩展提交路径（`:549`）
- `AppModel` 另一条 drain（`:377-378`）
- `FileLocalStore` 的锁也是实例级（`LocalStore.swift:12-13`）。

**建议**：用 `NSFileCoordinator`/应用组文件锁或把 drain 只放在主 App；队列设总字节上限并按设计丢弃最旧项；索引和内容写入要能恢复（例如先写内容、索引原子替换并定期清理孤儿文件）。

### 7. 中：真实分享路径把 `sourceApp` 固定传 nil，测试覆盖了一个生产不可达的分支
`clients/apple/Sources/HimawariShare/ExtensionSupport.swift:131-134`；`clients/apple/Sources/HimawariShare/SafariBridge.swift:24-31`；`clients/apple/Tests/HimawariCoreTests/HandoverTests.swift:75-81`

**问题**：唯一的生产构造点 `HandoverHostController.load` 传 `sourceApp: nil`，Safari 路径也传 nil；只有测试直接构造 `Handover(... sourceApp: "Notes App")`。因此 `share.item` 的 `sourceApp` 证据在生产里永远是空的，测试所验证的“按来源 App 命名/填证据”并未真正跑过。如果服务端把 `sourceApp` 设为必填，分享文字/链接会全部被拒。

**证据**：
```swift
let model = HandoverSheetModel(entry: entry, content: content, sourceApp: nil, ...)
```
测试中：
```swift
let item = handover(.text("一段话"), entry: .share, sourceApp: "Notes App")
```

**建议**：要么移除未使用的 `sourceApp` 证据/字段，要么真正从扩展上下文取得来源 App（若平台允许）；测试应使用与生产相同的构造路径，至少加一条“生产入口的 sourceApp 为 nil 时行为正确”的测试。

### 8. 中：主 App 补交排队图片时没有 ImageFitter，大图可能被判 tooLarge 并删除
`clients/apple/Sources/HimawariShell/AppModel.swift:376`；`clients/apple/Sources/HimawariCore/Handover.swift:349-356`、`:396-400`

**问题**：分享扩展提交时用的是 `HandoverCourier(api:..., images: UIKitImageFitter())`，但队列里保存的是原始 `handover`，不是已经压缩过的版本。主 App 补交时构造 `HandoverCourier(api: api)`，`images` 为 nil，`fitted` 原样返回；如果图片超过 `device.upload.file_bytes`，`.media` 分支返回 `.failed(.tooLarge)`，随后被队列删除。离线分享的大图会永久丢失。

**证据**：
- `let courier = HandoverCourier(api: api)`（`AppModel.swift:376`）
- `guard ..., let images, ..., let fitted = images.fit(...) else { return handover }`（`Handover.swift:350-356`）
- `if let budget = ..., data.count > budget { return .failed(.tooLarge) }`（`:398`）

**建议**：补交时复用同一套图片压缩能力，或在入队前保存压缩后的内容；同时加“大图离线排队后主 App 补交”的测试。

### 9. 低/中：`.link` 接受任意非 file URL，而 `.page` 只接受 http/https
`clients/apple/Sources/HimawariShare/ExtensionSupport.swift:37-40`；`clients/apple/Sources/HimawariCore/Handover.swift:60-66`

**问题**：网页预处理路径对 URL 做了 `http/https` 限制，但分享扩展的普通 URL 路径只排除了 `isFileURL`，`javascript:`、`data:`、自定义 scheme 都能变成 `.link` 并作为 `share.item` 的 `url` 证据发给服务端/最终给模型看。输入来源是其他 App 的分享内容，属于不可信输入。

**证据**：
```swift
if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }),
   let url = await load(URL.self, from: provider, type: .url), !url.isFileURL {
    return .link(url: url.absoluteString, title: caption)
}
```
而 `HandoverContent.page(from:)` 有 `["http", "https"].contains(scheme)`。

**建议**：`.link` 也统一做 `http/https` 校验；对拒绝的输入返回 `.unreadable` 或明确错误，不要落入感知记录。

### 10. 低：部分测试只断言“抛了某个错误类型”，错误映射错了也会通过
`clients/apple/Tests/HimawariCoreTests/HandoverTests.swift:84-97`、`:144-160`、`:231-249`

**问题**：
- URL 过长、旧服务端没有 limits 的用例只写 `#expect(throws: HandoverPlanError.self)`，没有断言具体是 `.tooLarge` 还是 `.serverOutdated`。把错误映射改错，测试仍过。
- `outcomesFollowTheServerAnswer` 没有覆盖 `duplicate`、`limit_reached`、`paused`、`.tooLarge`、`.serverOutdated`。
- `pageSubtitle` 用例没有覆盖 `.failed`。
- 没有任何测试覆盖钥匙串 service/group 迁移、跨进程队列、请求文本超长、旧服务端图片路径。
- Safari 面板测试用 mock 了 `browser` 接口，`PagePreprocessor.js` 和真机 Safari 仍未验证（作者也承认）。

**证据**：
```swift
#expect(throws: HandoverPlanError.self) { try HandoverPlanner.plan(...) }
```
没有 `throws: HandoverPlanError.tooLarge` 之类的具体断言。

**建议**：把错误断言改成具体 case；补上述负向用例；对 `PagePreprocessor.js` 至少做一次脚本级或真机验收记录。

### 11. 低：给定对比范围里含与第 6 批无关的工具定义变更，与“不动发给模型的内容”不一致
`packages/prompt-catalog/src/tools.ts:240`；`packages/prompt-catalog/prompt-manifest.json:946-952`

**问题**：作者说本 PR“不动发给模型的内容”，但 `afcaff..2ee54` 的 diff 包含 `TOOL_RULE_SET` 文本删除 `push_quiet_hours` 说明、manifest 哈希更新，以及服务端 `push_quiet_hours` 规则类型删除。如果这些属于本 PR，它们会改变新对话的工具定义（旧对话按冻结规则不变）；如果只是合入 `origin/main` 带来的，PR 范围和作者说法就需要澄清，否则评审会把无关的服务端行为变更一起放进去。

**证据**：
- diff 里旧文本有 `push_quiet_hours 是静默时段里指定类别的推送...`，新文本已删除。
- 同范围还删除了 `packages/application/src/rules/rule-types.ts` 的 `pushQuietType` 等。

**建议**：确认这些服务端/提示词改动是否属于第 6 批；若不属于，改用正确的 PR 基准（三点 diff/merge-base）复核，避免把 main 的变更混入本 PR。

## 读代码证实的

- 旧 Keychain service 由 bundle id 拼成，新代码固定为 `himawari.device`，且新增 access group；仓库无迁移代码（意见 1）。
- 旧服务端路由表没有 `uploads/begin`；图片无 request 时绕过 `attachments`/`perception` 的配置检查（意见 2）。
- 会话路径直接使用未裁剪的 `handover.request`，没有调用 `MessageAttachments.fits`（意见 3）。
- `.failed` 在 `keepsWhatWasRead` 返回 true，界面会显示全文（意见 4）。
- `captureSource`、类型名、`evidence.kind` 均为硬编码，无共享清单（意见 5）。
- 队列无字节上限，锁为进程内 `NSLock`，扩展和主 App 各自可能 drain（意见 6）。
- 生产路径的 `sourceApp` 始终为 nil（意见 7）。
- 主 App 补交时 `HandoverCourier` 没有 `images`（意见 8）。
- `.link` 只排除 file URL，`.page` 限制 http/https（意见 9）。
- 测试存在只断言错误类型、未覆盖失败副标题和迁移路径的情况（意见 10）。
- 给定 diff 范围确实包含 prompt-catalog 工具说明变更（意见 11）。

## 推测/未核实

- PR 451 的服务端 `attachments`、`perception`、`uploads/begin` 请求/响应字段和服务端校验规则不在当前仓库，无法核对；`captureSource`、`type`、`evidence.kind`、`mediaKind` 是否被接受属于未核实。
- `$(AppIdentifierPrefix)` 在 `Info.plist` 的自定义键里是否会被 Xcode 正确展开、展开为空时 `SharedVault.setting` 是否会把非法 group 传给 Keychain，未在真机/签名环境核实。
- Safari 扩展 `PagePreprocessor.js`、`background.js` 与原生消息在真机上的实际行为和大小限制未核实；作者也明确说未真机验证。
- “Linux swift test 176 通过”“Mac iOS/Mac 双目标编译通过”无法在本次只读环境运行，未核实。
- “已统一到 10B 的 PerceptionRecordUpload、MessageAttachment 类型”在当前仓库只能看到本分支的定义，10B 分支是否同名同形未核实。
- 服务端是否实际用 `messageCharacters` 校验 `POST messages` 文本，以及旧服务端 404 的 body 是否带 `error.code`，从当前代码可推断但未跑真实服务端验证。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
苹果客户端这部分不会。它通过 `createThread` 新建对话，再在末尾用一条用户消息发送请求和附件（`Handover.swift:373-387`），没有改系统提示、工具定义或历史消息；每次会变的 `createdAt`、随机 id 只在感知记录/上传请求里，不在系统提示。需要注意两点：一是服务端附件如何插入模型请求不在本仓库，未核实；二是本材料给定的 diff 范围里包含 `packages/prompt-catalog` 的工具说明变更（意见 11），如果它属于本 PR，就会改变新对话的工具定义，旧对话按冻结规则不受影响。

**2. 同一段文字会不会在不同请求里变成不同字节？**
对同一份已入队的 Handover，`id`、`createdAt` 都保存在 `Handover` 里，重试不会重新生成；`perceive` 使用 `JSONEncoder.outputFormatting = [.sortedKeys]`，所以同一记录的感知 JSON 字节稳定。客户端没有依赖前后文的遮盖逻辑。`uploadAttachment`/`send` 的 JSON 没有显式排序，但它们不是模型请求开头，且靠 requestId/messageId 去重；不建议把它们当成“同一请求可逐字节重发”的保证。总体上没有给已有模型请求引入非确定性。

**3. 有没有自动检查，反向用例真的会失败吗？**
有：`HandoverTests.swift` 覆盖规划、裁剪、队列、outcome；`test/tooling/safari-panel.test.ts` 覆盖面板行为；`test/tooling/apple-design-check.test.mjs` 覆盖网页颜色/尺寸字面量和 tokens.css 过期，后者确实有反向用例（改成 `#fff` / 空 tokens.css 会失败）。但 Swift 侧多数是正向用例，部分只断言错误类型而不断言具体错误；钥匙串迁移、旧服务端图片、请求超长、失败副标题、跨进程队列都没有反向用例。Safari 面板测试是 mock 浏览器接口，不证明真机 `PagePreprocessor.js` 可用。因此“反向用例都会真的失败”目前只对设计检查成立，对第 6 批核心行为不成立。

**4. 每个新值的使用方都能接受吗？**
- `recordId = "perception:" + 24 位 base64url`：长度/字符集与服务端现有 `MESSAGE_ID_PATTERN=/^[A-Za-z0-9_-]{16,64}$/` 兼容，和既有 `MessageSensing.recordId` 同形；可接受（服务端 perception 校验未在本仓库，未完全核实）。
- `threadRequestId`、`messageId`、`attachmentRequestId`：base64url 24 字符加 `-thread`/`-message`/`-attachment`，长度 31-35，符合 `[A-Za-z0-9_-]{16,64}`；可接受。
- `occurredAt`：沿用既有 `MessageSensing` 的 ISO8601 小数秒 UTC 格式；可接受。
- `captureSource = "share_extension" / "safari_extension"`：设计说服务端按清单校验，但代码没有共享清单或契约测试，**不能确认**服务端接受；这是意见 5。
- `type = "web.page" / "share.item"`：设计类型表里有这两个名字，但客户端仍靠服务端 config 的 `recordTypes` 存在性来判断；服务端 PR 451 的键名未核实。
- `evidence.kind = "string"`、`rule.text = "none"/"required"`：客户端硬编码，服务端契约未核实。
- `attachment` 的 `as = "image"/"text"` 和图片 data URL：既有 `DeviceAttachments` 已在用 `text`，服务端有图片 data URL 正则；但设备附件接口本身不在当前服务端路由表中，未核实。
- `uploads/begin` 的 `purpose/sha256/bytes/batchId/mediaKind`：路由和字段在当前仓库/旧服务端都不存在，未核实。
- `device.upload.file_bytes`：两边都有，命名一致；可接受。
- `himawari://handover/safari`：和 `CFBundleURLSchemes = himawari` 一致；可接受。
- `HIMAWARI_APP_GROUP` / `HIMAWARI_KEYCHAIN_GROUP`：工程设置、entitlements、Info.plist 键名一致；但 `AppIdentifierPrefix` 的展开和旧条目迁移未核实（意见 1）。
- `messageCharacters` / `perMessage`：客户端产生消息时没有使用，存在校验缺口（意见 3）。
