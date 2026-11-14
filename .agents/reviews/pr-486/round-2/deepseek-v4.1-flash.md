本轮查过的范围：`git diff 2ee54f7..c6d1163`（只改了 5 个 Swift 文件 + 测试：`Handover.swift`、`LocalStore.swift`、`AppModel.swift`、`HandoverTests.swift`、`PairingProblemTests.swift`），并按上一轮意见追到 `SharedVault.swift`、旧版 `AppModel.swift`（afcaff9）、Safari 的 `popup.js`/`SafariBridge.swift`、三语 `Localizable.strings`、`docs/execution/specs/2026-11-11-apple-device-body-design.md` 以及服务端路由表 `device-api-routes.ts`。没有运行 `swift test`/Mac 构建（工具受限），作者关于“176 个测试通过、Mac 编译通过、设计验收通过”的说法未核实。以下先列问题，再写侧重检查和必答问题。

### 1. 中高：钥匙串 service 改成固定的 `himawari.device` 且没有迁移，已配对设备会读不到旧凭据（上一轮意见 1 实际未改）

文件：`clients/apple/Sources/HimawariCore/SharedVault.swift:7,33,37`；对照旧版 `clients/apple/Sources/HimawariShell/AppModel.swift`（afcaff91 版本）

问题：旧代码按 bundle id 生成 service，新代码用写死的 service，并且 `c6d1163` 的 5 个文件里没有 `SharedVault.swift`/钥匙串文件，因此上一轮意见 1 的代码路径完全没动。

证据（读代码证实）：旧版是
```swift
let service = (bundle.bundleIdentifier ?? "himawari") + ".device"
keys = SecureEnclaveKeyStore(service: service + ".keys")
keychain = KeychainValueStore(service: service)
```
新版是
```swift
public static let service = "himawari.device"
public var keys: SecureEnclaveKeyStore { SecureEnclaveKeyStore(service: Self.service + ".keys", accessGroup: keychainGroup) }
public var keychain: KeychainValueStore { KeychainValueStore(service: Self.service, accessGroup: keychainGroup) }
```
iOS 的 bundle id 是 `win.siyi.himawari`，旧 service 是 `win.siyi.himawari.device`，新旧不相等；同时新的 entitlements 只列共享 keychain group，旧条目在旧的默认 group 里。结果是升级后 `restore()` 看到“没有配对记录/没有设备密钥”，用户被当成未配对。

建议：先读旧 service（以及旧默认 access group）并迁移到新分组，迁移成功后再删除旧项；或者明确接受“本次升级要重新配对”，在发布说明/README 写清。加一条“旧 service 里已有配对记录时仍能 restore”的测试。

推测：真实影响取决于此前是否有已发布/已配对版本装过；若只是未发布的 PR 构建，影响是内部测试设备。

### 2. 中：Safari 扩展在 `.failed` 时仍显示“这一页的全文”，上一轮意见 4 只修了分享面板

文件：`clients/apple/App/SafariExtension/Resources/popup.js:40-47,60-66`；`clients/apple/Sources/HimawariShare/SafariBridge.swift:35-47`；对照 `clients/apple/Sources/HimawariCore/Handover.swift:53-57,184-189`

问题：SwiftUI 分享面板用 `keepsWhatWasRead` 修好了，但 Safari 小面板是纯 JS，副标题只看 `textRead`，不看 outcome；`SafariBridge.describe` 也没有把“内容是否仍会被交出去”传给 JS。结果是失败时卡片仍写“这一页的全文”，下方却写发送失败。

证据（读代码证实）：
```js
card.querySelector(".card-subtitle").textContent = textRead
  ? [hostOf(page.url), words["sheet.fullPage"]].filter(Boolean).join(" · ")
  : words["sheet.textUnreadable"];
```
`showOutcome()` 只调用 `showCard()`，没有把 `reply.phase`/`reply.done` 纳入副标题判断。`SafariBridge.describe` 只返回 `phase/done/line/button/link/closeAfterMs`，没有 `keepsWhatWasRead`。`test/tooling/safari-panel.test.ts` 的 `scenes()` 也没有 `.failed` 场景。

建议：在 `SafariBridge.describe` 里加一个显式字段（例如 `kept = phase.outcome?.keepsWhatWasRead ?? true`），`popup.js` 用 `textRead && kept` 决定是否显示全文；在 `safari-panel.test.ts` 增加 `.failed` 场景并断言副标题只显示 host。

### 3. 中：排队项遇到 `serverOutdated`/`limitReached` 会被 drain 静默删除，UI 却让用户“更新服务器后再试”

文件：`clients/apple/Sources/HimawariCore/Handover.swift:455-467`（关键 460-464）；`clients/apple/Sources/HimawariShare/Resources/{en,ja,zh-Hans}.lproj/Localizable.strings:25`

问题：上一轮意见 2 只把 404/405 分类成 `serverOutdated`，但 `drain` 只对 `.queued` 保留，其他结果一律删除。主 App 补交时用户看不到结果，排队中的图片/网页会被直接永久删除；这与文案“更新服务器后再试”矛盾，也和 README“回到 App 时自动补交”的承诺不一致。

证据（读代码证实）：
```swift
switch outcome {
case .queued: continue
case .deviceRemoved: return results
default: try? remove(handover.id)
}
```
`serverOutdated` 和 `limitReached` 都落在 `default`；`HandoverDesk.hand` 也只在 `.queued` 时入队（`Handover.swift:544-546`）。本地化文案是 “The server doesn't accept this yet. Update the server and try again”。

建议：把暂时性失败（至少 `serverOutdated`、`limitReached`）留在队列或放进单独的“等待条件变化”状态；只在 `.delivered`、`.entryOff`、`.deviceRemoved` 和确认永久的 `.failed(.rejected)` 时删除。若坚持删除，需要通知用户并说明内容没有保存。

### 4. 中高：待传队列仍无上限、没有淘汰，和设计文档的 500 MB 上限不一致（意见 6 只修了索引竞争）

文件：`clients/apple/Sources/HimawariCore/Handover.swift:440-449,455-467,535-547`；`clients/apple/Sources/HimawariShell/AppModel.swift:373-388`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:248,567,758`

问题：`add` 直接把整个 `Handover`（含原图 `Data`、未截断的网页全文）写盘；`pending()` 每次解码目录里的所有项；没有条数或字节数上限，也没有淘汰。设计文档明确要求“设备上的待传队列有上限”，`device.queue.bytes` 默认 500 MB，“先丢最旧的低价值类型，并通知”。

证据（读代码证实）：
```swift
public func add(_ handover: Handover) throws {
    try store.write(Self.prefix + handover.id, try JSONEncoder().encode(handover))
}
public func pending() -> [Handover] {
    store.names().filter { $0.hasPrefix(Self.prefix) }
      .compactMap { name in store.read(name).flatMap { try? JSONDecoder().decode(Handover.self, from: $0) } }
```
`HandoverDesk.hand` 在离线时把 `handover` 原样入队。离线时网页文本/图片大小不受 `textCharacters`/`imageCharacters` 约束，因为裁剪只发生在 `deliver` 里的 `HandoverPlanner`，而离线时在 `configuration()` 就返回 `.queued`。`AppModel` 还先 `pending().isEmpty`、再在 `drain` 里 `pending()`，大图队列会被解码两次。

建议：入队前按字节和条数检查并淘汰最旧/低价值项（按设计文档 500 MB 和“通知/用量页”）；存盘前先按已知配置做文本裁剪和图片压缩；避免重复解码整个队列（先取计数或一次性快照）。

推测：`HandoverDesk.hand`（扩展）和 `AppModel.deliverWaitingHandovers`（主 App）仍可能同时 drain。逐文件存储只消除了共享 index 的丢失更新，没有跨进程租约，可能重复上传/重复投递；服务端是否用 requestId/messageId 幂等吸收，本仓库看不到（见问题 7）。

### 5. 中低：超长 request 仍在上传附件之后才被拒绝，整页照样被丢弃（意见 3 只部分修复）

文件：`clients/apple/Sources/HimawariCore/Handover.swift:373-378`

问题：新加的 `MessageAttachments.fits` 检查在 `uploadAttachment` 之后；失败后返回 `.failed(.tooLarge)`，`drain` 默认删除，页面正文既没发出去也没排队。分享面板进入 `.finished` 后输入框隐藏，用户不能把过长的请求改短重试。

证据（读代码证实）：
```swift
let ref = try await api.uploadAttachment(...)
let tag = MessageAttachment(...)
if let limits = configuration.attachments, !MessageAttachments.fits(text: handover.request ?? "", attachments: [tag], limits: limits) {
    return .failed(.tooLarge)
}
let created = try await api.createThread(...)
```
新测试 `aRequestLongerThanAMessageIsRefusedBeforeAThreadIsOpened` 断言请求列表是 `[config, attachments]`，证明附件已经上传，只是没有建 thread。

建议：在 `uploadAttachment` 之前用请求长度加一个保守的 tag 长度估算先拒绝；失败时保留可编辑状态让用户改 request，或按服务端 `messageCharacters` 裁剪请求并明确告知；加一条“超长请求不会发出附件上传”的测试。

### 6. 低：新加的队列回归测试在旧实现上也会通过，不能证明竞争已修

文件：`clients/apple/Tests/HimawariCoreTests/HandoverTests.swift:178-190`

问题：测试名字说“两个从没看见对方 index 的 writer”，但实际序列没有在旧实现的 `ids()` 读取和 `write(index)` 之间插入第二个 writer，因此旧实现也会得到同样的 `[second]`。

证据（读代码证实）：旧版 `add` 是
```swift
try store.write(Self.prefix + handover.id, ...)
var list = ids()
if !list.contains(handover.id) { list.append(handover.id) }
try store.write(Self.index, ...)
```
测试执行 `add(first)` → `remove(first)` → `add(second)`；第三次 `add` 在 `remove` 之后才读 index，此时 index 已经是 `[]`，写入 `[second]`，断言通过。没有交错时旧实现不会失败。

建议：给 `HandoverQueue` 的读 index/写入之间留可注入的 hook，或用两个线程/受控调度真正交错 `ids()` 与 `write(index)`；并分别对旧实现跑一次，确认新测试会红。

### 7. 低（未核实）：新记录类型的 `captureSource` / `type` 在仓库里没有消费端，服务端是否接受无法确认

文件：`clients/apple/Sources/HimawariCore/Handover.swift:25-30,253-265`；`packages/platform-node/src/device-api-routes.ts:47-61`

问题：客户端产生 `web.page`、`share.item`、`share_extension`、`safari_extension` 这些值；本 checkout 的 `DEVICE_API_ROUTES` 里没有 `/perception`、`/attachments`、`/uploads/begin`，所以无法核对服务端枚举/校验。作者说这些接口在 PR 451 或后续 PR，客户端可以用 `configuration.perception`/`attachments` 缺失降级为 `serverOutdated`，这是缓解，但不能证明“配置声明了却仍拒绝”的情况不存在。

证据（读代码证实）：客户端在 `HandoverPlanner.plan` 里对无 `perception.recordTypes`、无 `attachments` 的情况抛 `serverOutdated`；`record()` 只发 `rule.evidence` 里声明过的字段。服务端接收端（`/perception`、`/attachments`、`/uploads/begin`）不在本仓库改动/路由表中，未核实。

建议：在服务端 PR/合入后，按 I-73 的方式逐个把 `web.page`/`share.item`/`capture_source` 的值交给真实校验器，并确认 `AttachmentLimits.messageCharacters` 在旧配置里缺省时的行为；客户端可以加一个“配置声明了记录类型但 ingest 返回 4xx”的反向用例。

**侧重检查**

- 错误路径：核对了 `uploadMedia` 的 404/405 分支、`Self.outcome` 的 401/413/429/5xx 映射、`invalidResponse`、drain 对 `.deviceRemoved` 的提前返回。结论：404/405 只包住了 `uploadMedia`；若配置里有 `attachments` 但 `/attachments` 实际不存在，`uploadAttachment` 的 404 仍会走 `Self.outcome` 变成 `.failed(.rejected)`，不是 `serverOutdated`（边缘情况，未改动）。
- 不可信输入：`HandoverContent.page` 只接受 `http`/`https`；文件 tag 的 name 经过 `MessageAttachments.cleanName` 去掉引号、尖括号和换行；正文在发送前按服务端 `textCharacters` 裁剪。问题在于离线入队时保存的是**未裁剪**的原文/原图（见问题 4）。
- 安全/凭据：`DEVELOPMENT_TEAM` 全部为空；没有发现把 token/secret 写日志的代码；keychain service 迁移是问题 1；Safari 的 `page.js`/`PagePreprocessor.js` 读 `document.body.innerText`，作者已声明未真机验证，本环境也无法验证。
- 资源耗尽：队列无上限、无淘汰，且先解码再处理（问题 4）；超长请求在上传后才拒绝（问题 5）。
- 不可撤销操作：`HandoverQueue.remove` 删除文件；`.failed` 默认删除；keychain service/access group 变化会使用户重新配对（问题 1、3）。
- 规则/文档一致性：`prompt-prefix` 未被本增量触碰；设计文档的 500 MB 队列上限/淘汰（248、567、758 行）与代码不一致（问题 4）；README 的“回到 App 时自动补交”与 `serverOutdated` 时静默删除不一致（问题 3）；I-73 要求的“产生处与使用处两端核对”在服务端接口缺失时只能标未核实（问题 7）。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 增量只改客户端捕获、附件上传、队列和 UI；没有改 `packages/prompt-catalog`、系统提示、工具定义、历史或遮盖。新增的 handover 内容只是作为一条新的用户消息追加（`compose` 出 `request + file tag`），不会重写历史。每轮会变的值（`Handover.createdAt`、`messageId`、上传得到的 `ref`、`answerLocale`）都只出现在这次新建的消息/新对话里。依据 `prompt-prefix.md` 第 4 条（只在末尾追加）、第 1/2 条（会变的值放最后一条用户消息）。未核实 Mac 真机上的实际线程行为。
2. **对模型前缀的字节没有影响；但“同一段文字两次提交”的请求字节会不同。** `PerceptionRecordUpload.evidence` 在 `DeviceAPI.perceive` 里用 `.sortedKeys` 编码（`MessageSensing.swift:122-127`），`occurredAt` 用固定的 `handover.createdAt`，队列现在按 `(createdAt,id)` 排序，都是确定的；但每次新建 `Handover` 会用随机 `id`，每次上传会得到新的 `ref`，因此同一页面重新提交的字节不同——这些差异只落在新的最后一条消息，不影响已发出的前缀。JPEG 重编码在相同系统/版本下应确定，未做跨版本验证。
3. **有部分自动检查，但覆盖不完整。** `aBigImageWithoutARequestOnAServerWithoutUploadsIsReportedAsOutdated` 在旧实现会得到 `.failed(.rejected)`，会失败；`aRequestLongerThanAMessageIsRefusedBeforeAThreadIsOpened` 在旧实现会继续建 thread（测试用的 `RecordingExchange` 会因取不到第三个响应而失败/崩溃）；`pageSubtitle` 的新断言在旧实现仍会包含“这一页的全文”，会失败。但 `theQueueSurvivesTwoWritersThatNeverSawEachOthersIndex` 在旧实现也通过（问题 6）；主 App 的 `UIKitImageFitter` 路径、drain 对 `serverOutdated` 的保留、Safari 面板 `.failed` 副标题、队列上限、钥匙串迁移都没有反向用例。未能运行测试，以上是读代码推断。
4. **逐个值核对：** `HandoverOutcome.keepsWhatWasRead` 的唯一消费者是 `pageSubtitle`，SwiftUI 分享面板已适配，Safari 面板未接（问题 2）；`serverOutdated`/`tooLarge` 在三种语言的 `Localizable.strings` 里都有 `outcome.*` 键，`HandoverSheetPhase.line` 能取到，但 `drain` 这个使用端会删除 `serverOutdated`（问题 3）；`HandoverQueue.prefix` 改成 `handover-item-` 后，仓库里没有其他引用（`grep` 只命中定义处），旧前缀数据只会被留给本 PR 早期构建（推测）；`LocalStore.names()` 的三个实现（`FileLocalStore`、`MemoryLocalStore`、测试的 `UnreadableMarkStore`）都已补齐，无其他 conformer；`UIKitImageFitter` 只在 `canImport(UIKit)` 下存在，`AppModel` 的引用也在同一条件内，Mac 走无 fitter 分支。服务端侧：`PerceptionRecordUpload`/`MessageAttachment` 在客户端只有一份定义、10B 代码共用，这点已证实；但 `web.page`/`share.item`/`captureSource` 的值是否被服务端校验接受，本仓库没有 `/perception`、`/attachments`、`/uploads/begin` 路由，未核实（问题 7）。
