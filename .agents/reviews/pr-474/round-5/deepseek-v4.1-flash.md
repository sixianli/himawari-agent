范围：本轮只看 `10057baf4..758544ffd` 的增量，并顺着增量验证上一轮 7 条。已核对 Senses 客户端、HimawariCore 上传与镜像、Handover 队列、iOS Info.plist/entitlements、共享扩展 URL、相关测试。未运行编译、测试或真机。

## 侧重检查

- 读过的关键路径：`SensesModel.swift`、`SensesService.swift`、`SensesGateway.swift`、`SenseRecords.swift`、`SenseUpload.swift`、`MirrorSync.swift`、`Senses.swift`、`Handover.swift`、`AppModel.swift`、`SharedVault.swift`、`PairingDecisions.swift`、`LocalStore.swift`、`DeviceAPIClient.swift`、`Info.plist`、`RootView.swift`、`HimawariShare` 的打开链接。
- 错误路径/不可信输入：重点看了 400/422 的处理、mirror 整批校验、超长文本、旧队列文件、配置未知、钥匙串找不到时的恢复路径。
- 资源耗尽/不可撤销操作：看了上传后才发现超长的附件、旧队列文件无人清理、删除镜像副本的确认路径。
- 安全/隐私：看了关闭日历/联系人时服务器副本是否删除、钥匙串服务名变更后的本地库清理。
- 规则与文档一致性：对照了作者关于能力表、镜像、保留期、关闭行为的说法。
- 结论：上一轮 7 条没有任何一条在增量里做了行为修改；增量还引入了一个新的 Info.plist 重复键问题。详见下文。

### 1. 高：增量没有落地上一轮任何一条；钥匙串服务名改成常量后没有迁移，升级会走“忘记”并清空本地库

- 文件:行：`clients/apple/Sources/HimawariCore/SharedVault.swift:7`、`clients/apple/Sources/HimawariShell/AppModel.swift:70-73`、`clients/apple/Sources/HimawariCore/PairingDecisions.swift:16`、`clients/apple/Sources/HimawariShell/AppModel.swift:271,486-497`、`clients/apple/Sources/HimawariCore/LocalStore.swift:65-70`
- 问题：上一轮 7 条涉及的行为代码在 `10057baf..758544f` 里没有被改。增量对 Senses 文件只有 `.server(status, _, _)` 改成四关联值 `.server(status, _, _, _)`；没有迁移旧钥匙串服务名。
- 证据：当前 `public static let service = "himawari.device"`；而 `9dd41fe` 的 AppModel 是 `let service = (bundle.bundleIdentifier ?? "himawari") + ".device"`。恢复时 `guard presence.allSatisfy({ $0 == .present }) else { return .forget }`，随后 `let emptied = emptyStore()`，`emptyStore()` 里 `try ...retire()`；`retire()` 会删除目录下所有文件。没有找到旧 service 的读取或迁移代码。
- 建议：先按旧 `<bundleIdentifier>.device` 读取并迁移 pairing record 和两把钥匙，再写新 service；迁移成功前不要进入 `.forget`。同时加一条“旧 service 有记录、新 service 为空”的反向用例。

### 2. 高：iOS Info.plist 出现两个 `CFBundleURLTypes`，后一个覆盖前一个，`himawari://` 链接不再注册

- 文件:行：`clients/apple/App/iOS/Info.plist:31`、`clients/apple/App/iOS/Info.plist:48`；使用端 `clients/apple/Sources/HimawariShare/Strings.swift:11`、`clients/apple/Sources/HimawariShare/HandoverSheet.swift:162-163`、`clients/apple/Sources/HimawariShell/RootView.swift:39-41`
- 问题：同一个字典里有两个同名 `CFBundleURLTypes`。第一个注册 `himawari`，第二个只注册 `himawari-pair`。plist 字典遇到重复键只能保留一个，后一个会覆盖前一个，因此 `himawari://handover/...` 和 `himawari://` 的“打开 Himawari”链接失效。
- 证据：`Info.plist` 第 31 行 `CFBundleURLTypes` 下是 `<string>himawari</string>`，第 48 行又出现 `<key>CFBundleURLTypes</key>`，下为 `<string>himawari-pair</string>`。分享扩展使用 `public static let scheme = "himawari"`，并在完成时调用 `HandoverLink.url(entry)` / `HandoverLink.home`。
- 建议：合并成一个 `CFBundleURLTypes` 数组，两个 dict 分别放 `himawari` 和 `himawari-pair`；加一个读取 Info.plist 的检查，确保没有重复键且两个 scheme 都在。

### 3. 中：mirror 字段规则仍然丢掉 `minimum`/`values`，客户端不校验，服务端会整批 400

- 文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:107-111`、`clients/apple/Sources/HimawariCore/MirrorSync.swift:31-41,88`、`clients/apple/Sources/HimawariCore/SenseRecords.swift:66-84`、`packages/application/src/ports/perception.ts:44-58,305-334`、`packages/platform-node/src/perception-service.ts:777-780`
- 问题：Swift 的 `PerceptionFieldRule` 只有 `kind`、`maximum`、`optional`，服务端规则还有 `minimum` 和 enum 的 `values`。`MirrorFields.fit` 对整数/数字只检查有限值并四舍五入，对 enum 原样接受；服务端 `validatePerceptionFields` 会检查 `minimum`/`maximum`/`values`，任何一项不合法就返回 `mirror_data` 400。客户端 `MirrorSync.send` 不拆批、不丢坏项，抛错后不清账本，下一次还会重发同样内容。
- 证据：`PerceptionFieldRule` 定义见 `Handover.swift:107-111`；`MirrorSync.swift:34` 只用 `SenseRecordBuilder.fit`，`SenseRecords.swift:73-80` 对 integer 只 `guard number.isFinite`、对 enum 直接 return；服务端 `DEVICE_MIRROR_KINDS` 里有 `minimum: 0`，`validatePerceptionFields` 返回 null 后 `perception-service.ts:780` 判 `invalid("mirror_data")`。`MirrorSync.swift:88` 的 `try await send` 在写账本之前抛出。
- 建议：把 `minimum`、`maximum`、`values` 加进 Swift 模型并在 `fit` 里裁剪/拒绝；mirror 收到 400 时至少丢弃坏项或二分重试，确认成功后再写账本。补一条“规则带 minimum/enum、输入越界”的反向测试。当前 mirrorKinds 没有 enum 字段，所以 enum 这一半暂时是潜在问题；`minimum` 和数字上界是现在就会出现的协议缺口。

### 4. 中：顶层感知文本仍按 Unicode 标量截断，服务端按 UTF-16 长度校验，emoji 记录会被判 malformed 丢掉

- 文件:行：`clients/apple/Sources/HimawariCore/SenseRecords.swift:52`、`clients/apple/Sources/HimawariCore/Handover.swift:7-18`、`clients/apple/Sources/HimawariSenses/SenseSink.swift:38`、`packages/platform-node/src/perception-service.ts:418-421`、`packages/application/src/ports/perception.ts:40`
- 问题：客户端对顶层 `text` 用 `TextBudget.scalarPrefix`，按 `unicodeScalars.count` 限长；服务端 `text.length > PERCEPTION_TEXT_MAXIMUM` 是 UTF-16 code unit。`PERCEPTION_TEXT_MAXIMUM` 为 `32 * 1024`，32K 个 emoji 在客户端是 32K 标量，到服务端就是 64K UTF-16，直接 400，随后 `PerceptionQueue` 把单条记成 malformed 删掉。
- 证据：`SenseRecords.swift:52` 为 `text = trimmed.map { value in textLimit.map { TextBudget.scalarPrefix(value, limit: $0) } ?? value }`；`Handover.swift:8` 为 `guard text.unicodeScalars.count > limit`；`perception-service.ts:420` 为 `text.length > PERCEPTION_TEXT_MAXIMUM`；`ports/perception.ts:40` 为 `export const PERCEPTION_TEXT_MAXIMUM = 32 * 1024;`。已有 `MessageSensing.utf16Prefix`，但感知记录没用。
- 建议：顶层 text 改用 UTF-16 截断（可复用 `MessageSensing.swift:82-87` 的做法），或服务端改成按 code point 计数；补一条 emoji 达到上限的反向用例。

### 5. 中：今天的列表仍只取第一页，`nextCursor` 被忽略

- 文件:行：`clients/apple/Sources/HimawariCore/SensesGateway.swift:61-66,102-120`、`clients/apple/Sources/HimawariSenses/SensesService.swift:108-110`、`clients/apple/Sources/HimawariSenses/SensesModel.swift:107-118`
- 问题：`PerceptionDaySnapshot` 有 `nextCursor`，网关 `day(types:cursor:)` 也支持 cursor，但 `LiveSensesService.day` 永远不传 cursor，`SensesModel.loadDay` 只保存一次结果。记录多于一页时，界面只显示第一页，`total` 却可能是全量，用户会看到“今天记了 N 件”但列表少一截。
- 证据：`SensesGateway.swift:65` 声明 `public let nextCursor: String?`；`SensesService.swift:109` 为 `try await gateway.day(types: item.recordTypes)`；`SensesModel.swift:114` 为 `days[item] = .loaded(try await service.day(item))`，之后没有循环。
- 建议：`loadDay` 循环取页直到 `nextCursor == nil`，合并 rows 并设上限；补一条服务端返回非空 cursor 的用例。

### 6. 中低：配置未知时 UI 仍显示“开着”，配置稍后到达也不会重新 reconcile

- 文件:行：`clients/apple/Sources/HimawariCore/Senses.swift:106-116`、`clients/apple/Sources/HimawariSenses/SensesModel.swift:85-94`、`clients/apple/Sources/HimawariShell/AppModel.swift:397-400,407-438`
- 问题：上一轮只修了“配置未知不启动采集器”。`SenseStateRule` 在 `server == nil` 时仍返回 `.on`，所以界面显示开着；`reconcile` 只在 `service.server != nil` 时 `start`；`retryConfiguration` 成功后只更新 `configuration`，没有调用 `senses.refresh()`，所以配置晚到后不会自动重新 reconcile。
- 证据：`Senses.swift:113` 为 `guard let server else { return .on }`；`SensesModel.swift:88` 为 `if service.server != nil { service.start(item) }`；`AppModel.swift:426-431` 成功分支只设置 `self.configuration`、`heartbeat`、`chat?.limitStreams`，没有 `senses?.refresh()`。`activate` 里是 `await refreshConfiguration(); await senses.refresh()`，但 `refreshConfiguration` 失败时只是安排重试。
- 建议：server 未知时 UI 显示“等待服务器”或保持关闭；`retryConfiguration` 成功后调用 `senses?.refresh()`（MainActor）。补一条“先未知、后配置到达”的用例。

### 7. 中低：队列前缀从 `handover-` 改成 `handover-item-`，旧队列文件和索引不再被读取或删除

- 文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:435,439-447`；旧做法见 `c6d1163f0` 的 `Handover.swift` diff
- 问题：当前 `pending()` 只筛 `handover-item-`；旧版本用 `handover-<id>` 加 `handover-index`。升级后旧文件既不会上传也不会被清掉，会永久占着共享容器，用户升级前排队的分享静默丢失。
- 证据：`public static let prefix = "handover-item-"`；`store.names().filter { $0.hasPrefix(Self.prefix) }`。`c6d1163f0` 之前是 `public static let prefix = "handover-"`，并维护 `private static let index = "handover-index"`；当前没有迁移代码。
- 建议：首次启动做一次迁移：读旧 `handover-index` 和 `handover-*`，按新前缀重写后删旧文件/索引；补一条“旧文件存在时仍能 pending 并清理”的用例。

### 8. 中低：作者说“日历和联系人关掉时要删服务器副本、需要确认”，但开关关掉只停采集，不删副本

- 文件:行：`clients/apple/Sources/HimawariSenses/SensesModel.swift:152-155,192-204`、`clients/apple/Sources/HimawariSenses/SenseDetailView.swift:52,25-34,149-160`
- 问题：详情页的开关走 `setSwitch -> turnOff`，只做 `update(on: false)` 和 `service.stop(item)`，没有 `clearMirror`；只有另一个“关掉并删掉服务器上的…”危险按钮才走 `turnOffAndClear` 并弹确认。作者的说法和代码不完全一致，用户只拨开关时服务器仍保留日历/联系人副本。
- 证据：`turnOff` 只有 `update(item) { $0.on = false }; await service.stop(item)`；`turnOffAndClear` 才调用 `try await service.clearMirror(item)`；`SenseDetailView.swift:52` 的 Toggle 绑定 `model.setSwitch(item, on:)`，危险按钮在 `dangerLink` 里单独确认。
- 建议：要么让镜像项的开关关闭也走确认并 `clearMirror`，要么把作者说法和界面文字改成“关掉只停止同步，服务器副本要用下面的按钮删”。这是不可撤销/隐私相关操作，建议明确。

### 9. 低：新的消息长度检查在上传附件之后才做，超长请求会留下未使用的服务器附件

- 文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:374-379`
- 问题：会话分支先 `api.uploadAttachment(...)` 拿到 ref，再 `MessageAttachments.fits(...)` 判断是否超长；超长直接 `.failed(.tooLarge)`，刚上传的附件没有被引用，也没有删除。
- 证据：`let ref = try await api.uploadAttachment(...)` 在前，`if let limits = configuration.attachments, !MessageAttachments.fits(...) { return .failed(.tooLarge) }` 在后。
- 建议：上传前先按文本和附件标签的最大预算预检；或超长时调用删除/取消附件接口。补一条“文本+标签超限时不上传”的测试。

## 读代码证实的

- `10057baf..758544f` 对 Senses 文件的改动只有 `SenseUpload.swift` 和 `SensesGateway.swift` 两处把 `.server(status, _, _)` 改为 `.server(status, _, _, _)`；没有改 `SensesModel`、`MirrorSync`、`SenseRecords`、`SharedVault`、`Handover` 的相关行为。
- `SharedVault.service` 是常量，恢复路径没有旧 service 的读取/迁移；`retire()` 会删除本地库文件。
- iOS `Info.plist` 里确实有两个 `CFBundleURLTypes` 键。
- `PerceptionFieldRule` 没有 `minimum`/`values`；服务端有，并且 mirror 校验失败会让整批 400。
- 顶层 text 用 `scalarPrefix`，服务端用 `text.length`。
- `nextCursor` 在模型里存在，但没有任何客户端分页使用。
- 配置未知时 `SenseStateRule` 返回 `.on`；`retryConfiguration` 成功后没有 `senses.refresh()`。
- 当前队列只读/删 `handover-item-`，旧 `handover-` 和 `handover-index` 没有迁移代码。
- 镜像开关关闭只停采集，不调用 `clearMirror`。
- 会话附件是先上传、后检查长度。

## 推测

- `CFBundleURLTypes` 重复键“后者覆盖前者”是 CFPropertyList/Info.plist 字典的通常行为；没有在真机或 `plutil` 上运行验证，但两个同名键在同一个 dict 里至少不是合法、稳定的配置。
- 32K 个 emoji 会触发服务端 400 是基于 `String` 的 UTF-16 语义推断；没有实际构造请求。
- 旧 `handover-` 文件是否真的存在取决于用户升级前是否排过队；代码层面只能确认它们永远不会被新代码读取或删除。
- 旧钥匙串服务名下是否有真实用户数据取决于发布历史；代码层面确认了服务名变化且没有迁移。
- mirror 的 `minimum` 触发频率取决于设备时钟和日历数据；当前 collector 的正常 90 天窗口内未必经常越界，但协议不一致是确定的。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 本 PR 的增量不涉及模型请求构造：它只改 Senses 客户端的上传/错误解构、Info.plist/entitlements 和截图删除，没有改系统提示、工具定义、历史消息或遮盖。增量里从主分支合并进来的 `packages/prompt-catalog/src/perception.ts` 等是静态提示/工具文本，不在本 PR 的 Senses 改动范围内，本轮未核实其在线上的拼装顺序。就该 PR 自身而言，不改变请求开头，也不存在“每轮会变的值放到最后一条消息”之外的新内容。
2. **会不会让同一段文字在不同请求里变成不同字节？** 本 PR 的增量没有引入依赖前后文的遮盖、带时间的字段或无序集合到模型请求里。新增的感知记录 id/时间戳是上传到设备接口的数据，不是模型请求字节；`MirrorSync.digest` 用了 `.sortedKeys`，镜像摘要本身是稳定的。若这些记录后续被服务端拼进提示，本轮未核实。
3. **有没有对应的自动检查，反向用例会不会真的失败？** 没有。增量没有为上一轮 7 条新增测试；现有 `SensesTests` 的文本测试用 ASCII/日文，不覆盖 emoji；mirror 测试的规则只有 `maximum`，没有 `minimum`/`values`；`nextCursor` 测试只给 `null`；`SensesReconcileTests` 只验证“配置未知不启动”，没有验证 UI 状态或配置晚到后的 reconcile；没有 Info.plist 重复键检查。因此上述反向用例在当前代码上不会失败。唯一会被自动发现的是 `.server` 关联值数量变化，由编译期检查。
4. **每个新值/改动的直接使用端都能接受吗？** `DeviceAPIError.server` 新增的 `reason` 已被 `SpokenCommand.swift:124-127`、`DeviceTransport.swift:55-58,67-70` 按四关联值消费，Swift 侧的使用点也都改成了四参数，编译期可接受。`himawari-pair` 的生产端（`Info.plist:48-57`）和消费端（`PairingInvitation.scheme`、`RootView.onOpenURL`）能对上；但同一个重复键把 `himawari` 的生产端挤掉，而 `Strings.swift:11`、`HandoverSheet.swift:162-163`、`RootView.swift:39-41` 仍在使用 `himawari`，这一端不能接受。`PerceptionFieldRule`、`recordTextCharacters`、`nextCursor` 三组值也已逐端核对：服务端产出/校验与客户端消费不一致，见第 3、4、5 条。
