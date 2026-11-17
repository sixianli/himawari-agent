## 本轮范围

本轮对照 `758544f..19be57c`：PR 474 自己新增的提交只有 `39f3618`（合并 `CFBundleURLTypes`、加 `test/tooling/ios-info-plist-url-types.test.ts`）；`19be57c` 是把 `origin/main` 合进来的合并提交。合并冲突实际落在 `Info.plist`、`AppModel.swift`、design tokens。我逐行核对了前两个冲突结果，以及本轮所有与第 5 轮意见相关的现有文件（Senses、SenseRecords、SenseUpload、MirrorSync、SensesGateway、SensesModel、SensesService、六个采集器、Handover、Localizable.strings、entitlements、能力表）。合并带入的 HomeFeed、NotificationSettling、prompt-catalog 等属于 main 上其他 PR，我没有把它们当作 PR 474 的新代码逐行复核；design tokens 也未核实。

## 上轮意见核对

- 第 2 条（Info.plist 两个 `CFBundleURLTypes`）：**已修好**。当前 `clients/apple/App/iOS/Info.plist:31-49` 只有一个键，两个 scheme 都在同一个数组里；新测试 `test/tooling/ios-info-plist-url-types.test.ts:10-17` 断言键数为 1 且两个 scheme 存在。按代码推断，恢复成两个键时该测试会失败（未实际执行）。
- 第 1、3、4、5、6、7、9 条：**没有落地**。`git diff 758544f..19be57c` 没有触碰 `SharedVault.swift`、`MirrorSync.swift`、`SenseRecords.swift`、`SenseUpload.swift`、`SensesModel.swift`、`SensesService.swift`、`Handover.swift`；下面逐条给出当前代码证据。

## 侧重检查

- **不可撤销操作**：`deleteAll` 只在 `SensesModel.canDelete` 为真时显示，`deleteRecords` 仍不在 `ClientCapabilities.swift` 的能力表里，实际隐藏；镜像的“关掉并删掉”走 `turnOffAndClear`，界面有确认对话框。与作者说法一致，未发现新增问题。
- **权限和后台**：`Info.plist` 里有位置、健康、照片、联系人、运动、剪贴板需要的用途说明，`UIBackgroundModes` 含 `location`、`remote-notification`；`Himawari.entitlements` 含 HealthKit 后台投递。六个采集器对 denied/restricted/limited 都有映射。未发现新增错误路径。
- **不可信输入**：服务端对感知文本和镜像字段有二次校验；客户端仍有下面第 3、4 条的两处跨端不一致。
- **资源耗尽**：联系人、日历、照片采集器会全量枚举后交给 `MirrorSync` 分批上传，队列也有单条丢弃逻辑；除第 9 条外未发现新的无限重试或资源泄漏。
- **规则/文档/代码一致性**：`HimawariSenses` 三语 `Localizable.strings` 都是 136 行、键一致；作者关于“三个操作在能力表、删除还不在表里”“开服务器感知要 Face ID、关掉不要”的说法与 `ClientCapabilities.swift:118-122`、`SensesGateway.swift:122-150`、`SensesModel.swift:120-159` 一致。

### 1. 高：钥匙串服务名换成常量后仍没有迁移，升级会忘记设备并清空本地库

- 文件：`clients/apple/Sources/HimawariCore/SharedVault.swift:7`；`clients/apple/Sources/HimawariShell/AppModel.swift:93-105, 513-525`；`clients/apple/Sources/HimawariCore/PairingDecisions.swift:14-18`
- 问题：当前服务名固定为 `"himawari.device"`，旧代码用的是 `(bundle.bundleIdentifier ?? "himawari") + ".device"`。工程里的 bundle id 是 `win.siyi.himawari`（`project.pbxproj:790`），所以旧服务名是 `win.siyi.himawari.device`。新代码没有读取旧服务名的迁移路径；升级后新服务名下查不到配对记录和设备密钥，`RestoreDecision` 返回 `.forget`，随后 `emptyStore()` 会 `retire()` 掉本地库。
- 证据（读代码证实）：
  - `SharedVault.swift:7` `public static let service = "himawari.device"`
  - `AppModel.swift:93-96` `let presence = [keychain.presence(Self.recordAccount), keys.presence(.device), keys.presence(.confirm)]`
  - `PairingDecisions.swift:16` `guard presence.allSatisfy({ $0 == .present }) else { return .forget }`
  - `AppModel.swift:517` `let emptied = emptyStore()`，`AppModel.swift:289` `try (store ?? ...).retire()`
  - `git show 0ffecccc0 -- clients/apple/Sources/HimawariShell/AppModel.swift` 显示旧代码 `let service = (bundle.bundleIdentifier ?? "himawari") + ".device"`
- 推测/条件：只有设备上已经存有旧服务名下的配对记录和密钥时才会触发；这是一次升级路径的数据丢失，不是首次安装问题。
- 建议：在新服务名读不到时回退读取旧服务名，迁移 `pairing-record` 和设备/确认密钥后再清理旧项；补一条“旧 service 升级到新 service”的测试。该文件不在本次增量里，属于基线已有问题，但升级前必须处理。

### 3. 中：镜像字段仍不校验 minimum/values，越界时服务端会整批 400

- 文件：`clients/apple/Sources/HimawariCore/MirrorSync.swift:31-41`；`clients/apple/Sources/HimawariCore/Handover.swift:107-117`；`clients/apple/Sources/HimawariCore/SenseRecords.swift:66-83`；`packages/application/src/ports/perception.ts:44-58, 305-341, 265-296`；`packages/platform-node/src/perception-service.ts:777-780`
- 问题：Swift 的 `PerceptionFieldRule` 只解码 `kind`、`maximum`、`optional`，服务端规则里的 `minimum` 和枚举 `values` 被丢掉；`SenseRecordBuilder.fit` 对整数/数字只检查 `isFinite`，不检查范围，对枚举也不检查 `values`。服务端 `validatePerceptionFields` 会按 full rule 校验，失败时 `invalid()` 抛 400，整个 `/mirror` 请求被拒。
- 证据（读代码证实）：
  - `Handover.swift:107-111` `public struct PerceptionFieldRule { public let kind: String; public let maximum: Int?; public let optional: Bool? }`
  - `SenseRecords.swift:73-78` `case let ("integer", .number(number)): guard number.isFinite else ...; return .number(number.rounded())`，没有比较上下界
  - `perception.ts:268-274` 镜像规则带 `minimum`/`maximum`，如 `startsAtMs`、`attendeeCount`
  - `perception-service.ts:779-780` `validatePerceptionFields(DEVICE_MIRROR_KINDS[kind], item["data"])`，失败 `return invalid("mirror_data")`；`invalid` 在 `162-164` 抛 400
- 推测/条件：当前四种镜像采集器产生的值大多落在范围内，所以更像潜在问题；一旦日历时间、参会人数等越界，或以后加枚举字段，就会整批失败，而且 `SenseSink.mirror` 用 `try?` 吞掉错误，用户只看到镜像不再更新。
- 建议：把 `minimum`、`values` 加进 `PerceptionFieldRule` 并在 `fit` 中执行；补一个越界/非法枚举必须被客户端拦下的测试。本次增量没有改这些文件。

### 4. 中：顶层感知文本仍按 Unicode 标量截断，emoji 记录会被服务端判 malformed 丢掉

- 文件：`clients/apple/Sources/HimawariCore/SenseRecords.swift:46-53`；`clients/apple/Sources/HimawariCore/Handover.swift:6-18`；`packages/platform-node/src/perception-service.ts:418-421`
- 问题：客户端用 `TextBudget.scalarPrefix` 按 Unicode 标量数截到 `recordTextCharacters`（32768）；服务端检查的是 `text.length`，即 UTF-16 码元数。一个 emoji 通常占 2 个 UTF-16 码元，客户端截到 32768 个标量时服务端长度可达 65536，超过 32768，整条记录被判 400。
- 证据（读代码证实）：
  - `SenseRecords.swift:52` `text = trimmed.map { value in textLimit.map { TextBudget.scalarPrefix(value, limit: $0) } ?? value }`
  - `Handover.swift:8` `guard text.unicodeScalars.count > limit else { return text }`
  - `perception-service.ts:420` `text.length > PERCEPTION_TEXT_MAXIMUM`
  - 失败后 `SenseUpload.swift:189-199` 在单条记录时直接 `records.removeAll` 并记 `malformed`，这一条不会重试
- 推测/条件：只有包含大量 emoji/补充平面字符的长文本才会触发；普通 ASCII/中文文本不会。
- 建议：顶层文本改用已有的 UTF-16 截断逻辑（`MessageSensing.utf16Prefix` 同样语义），或把服务端改成按码点计数；补一个 emoji 长文本用例。本次增量没有改这些文件。

### 5. 中：今天的列表仍只取第一页，nextCursor 被忽略

- 文件：`clients/apple/Sources/HimawariSenses/SensesService.swift:108-110`；`clients/apple/Sources/HimawariSenses/SensesModel.swift:107-118`；`clients/apple/Sources/HimawariSenses/SenseDetailView.swift:79-100`；`clients/apple/Sources/HimawariCore/SensesGateway.swift:102-119`；`packages/application/src/ports/perception.ts:401`
- 问题：`gateway.day` 支持 `cursor`，但 `SensesService.day` 不传 cursor；`loadDay` 只调用一次并把结果放进 `days[item]`；界面只渲染 `rows`，没有“加载更多”或继续翻页。服务端默认 `listPageRows = 100`，超过一页的记录在界面上看不到。
- 证据（读代码证实）：
  - `SensesService.swift:109` `try await gateway.day(types: item.recordTypes)`，没有 cursor 参数
  - `SensesModel.swift:114` `days[item] = .loaded(try await service.day(item))`
  - `SenseDetailView.swift:87-95` 只遍历 `lines`，没有使用 `day.nextCursor`
  - `perception.ts:401` `listPageRows: 100`
- 建议：在 service/model 里按 `nextCursor` 循环拉完，或在列表底部按需加载下一页；补一条超过一页的用例。本次增量没有改这些文件。

### 6. 中低：配置未知时仍显示“开着”，配置晚到后不会重新 reconcile

- 文件：`clients/apple/Sources/HimawariCore/Senses.swift:113-114`；`clients/apple/Sources/HimawariSenses/SensesModel.swift:85-93`；`clients/apple/Sources/HimawariShell/AppModel.swift:426-457`；`clients/apple/Sources/HimawariSenses/SenseDetailView.swift:37-40`
- 问题：`server == nil` 时 `SenseStateRule.state` 直接返回 `.on`，界面据此把开关显示为开；但 `reconcile` 只在 `service.server != nil` 时启动采集器。首次启动时如果 `refreshConfiguration` 失败，`retryConfiguration` 稍后成功只更新 `configuration`，没有调用 `senses.refresh()`/`reconcile`，采集器要等到下一次 App 回到前台才会启动。
- 证据（读代码证实）：
  - `Senses.swift:113-114` `guard let server else { return .on }`
  - `SensesModel.swift:88` `if service.server != nil { service.start(item) }`
  - `AppModel.swift:446-450` `retryConfiguration` 里只设置 `configuration`、`heartbeat`、`chat?.limitStreams`
  - `SenseDetailView.swift:37-40` `collecting = state == .on || state == .serverPaused`
  - `SensesTests.swift:105` 现有测试还断言 `server: nil` 时状态为 `.on`
- 建议：服务端配置未知时返回 `.off`/明确的“正在读取”状态，不要显示为开；配置到达后调用 `senses.refresh()` 或只做 reconcile；把现有测试改成覆盖延迟配置。本次增量没有改这些文件。

### 7. 中低：队列前缀改为 handover-item- 后仍没有迁移旧 handover- 文件

- 文件：`clients/apple/Sources/HimawariCore/Handover.swift:435, 441-445, 448-453`
- 问题：`HandoverQueue.pending()` 只筛选 `handover-item-` 前缀，旧版本写入的 `handover-<id>` 文件既不会被发送，也不会被删除。升级后这些排队中的内容会永久留在本地。
- 证据（读代码证实）：
  - `Handover.swift:435` `public static let prefix = "handover-item-"`
  - `Handover.swift:443` `.filter { $0.hasPrefix(Self.prefix) }`
  - `Handover.swift:449` `try store.write(Self.prefix + handover.id, ...)`
  - 全仓库搜索只有 `handover-item-`，没有旧前缀的迁移代码
- 建议：首次启动时扫描旧 `handover-` 文件，改名成新前缀或直接补投；补一条旧队列升级测试。本次增量没有改这个文件。

### 9. 低：消息长度检查仍在上传附件之后，超长请求会留下未使用的服务器附件

- 文件：`clients/apple/Sources/HimawariCore/Handover.swift:374-379`；`clients/apple/Sources/HimawariCore/MessageAttachments.swift:46-48`
- 问题：会话路径先 `uploadAttachment`，拿到 `ref` 后才用 `MessageAttachments.fits` 检查请求文本加附件是否超过 `messageCharacters`。超长时返回 `.failed(.tooLarge)`，但附件已经上传，服务器上留下不会出现在任何消息里的附件。
- 证据（读代码证实）：
  - `Handover.swift:375` `let ref = try await api.uploadAttachment(requestId: ..., content: attachment, ...)`
  - `Handover.swift:377-378` `if let limits = ..., !MessageAttachments.fits(text: handover.request ?? "", attachments: [tag], limits: limits) { return .failed(.tooLarge) }`
  - `MessageAttachments.swift:47` `attachments.count <= limits.perMessage && compose(...).utf16.count <= limits.messageCharacters`
- 推测：服务器是否会自动回收这类未被消息引用的附件，未核实；至少会多一次上传和一段占用。
- 建议：在上传前先按已知的文本长度和附件字符预算检查，或上传失败后显式删除/复用附件；补一个超长请求不留附件的用例。本次增量没有改这些文件。

## 必答问题

1. **请求开头是否改变**：不涉及。PR 474 这次自己的增量只有 iOS `Info.plist` 和一个 tooling 测试，没有改系统提示、工具定义、历史消息或遮盖结果；六项感知走设备接口的 `perception`/`track`/`mirror`，不进入模型请求。`prompt-prefix.md:27-30` 要求感知内容只作为 `perception_read` 的工具结果追加在末尾，本轮没有改这条链路。`758544f..19be57c` 里确有 `packages/prompt-catalog` 的变化，但它来自 `origin/main` 的合并（其他 PR），不是本 PR 的感知改动；若要把它算进本 PR，需要单独复核，未核实。

2. **同一段文字是否会在不同请求里变成不同字节**：本次增量不涉及；改变的是 plist XML，不进入模型请求。PR 474 自己的请求里 `syncId`、`messageId` 等是随机值，但它们是设备接口字段，不是提示缓存的开头；镜像摘要用 `.sortedKeys`，是确定的。合并进来的 main 代码未核实。

3. **自动检查和反向用例**：只有第 2 条有对应检查——`test/tooling/ios-info-plist-url-types.test.ts:10-17`，重复键时键数断言会失败（按代码推断，未执行）。第 1、3、4、5、6、7、9 条没有能抓住问题的反向用例；相反，`SensesTests.swift:105` 把“配置未知显示为 on”写成期望，`HandoverTests.swift:50` 把按标量截断写成期望。新测试虽然能抓住重复键，但不解析 plist，第二个断言只是全文包含，不能保证两个 scheme 属于同一个 `CFBundleURLTypes`；建议改成解析 plist 后断言。

4. **改动产生/修改的每个值，两端是否接受**：本次增量修改的 `CFBundleURLTypes` 由 iOS 读取，两个 scheme 分别被 `PairingInvitation.scheme = "himawari-pair"`（`Pairing.swift:23`）和 `HandoverLink.scheme = "himawari"`（`HimawariShare/Strings.swift:11`）使用，能对上。PR 474 整体上，`SenseItem.recordTypes`、`mirrorKind`、`retentionKey` 与服务端 `PERCEPTION_RECORD_TYPES`、`DEVICE_MIRROR_KINDS`、`PERCEPTION_RETENTION_KEYS` 一致；`perception.records.delete` 不在能力表，`phoneOperations` 因此隐藏删除按钮，与作者说法一致。但第 3 条说明镜像 `data` 的两端校验规则不一致，第 4 条说明顶层文本长度规则不一致，这两处产生出来的值服务端不一定接受。
