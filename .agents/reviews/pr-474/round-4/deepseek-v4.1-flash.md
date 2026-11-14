## 本轮查核范围

- 读了 `git diff cc1e0c3..10057ba` 的文件清单，并逐行看了增量里的 apple 改动：`Handover.swift`、`LocalStore.swift`、`popup.js`、`SafariBridge.swift`、`AppModel.swift`、`HandoverTests.swift`、`PairingProblemTests.swift`、`safari-panel-review.mjs`、`safari-panel.test.ts`。
- 回溯了 `cc1e0c3` 的 senses 修复，并核对了当前 `SharedVault`、`KeychainValueStore`、`SensesGateway`、`SensesService`、`SensesModel`、`Senses.swift`、`SenseRecords`、`MirrorSync`、`SenseSink`、`SenseUpload`。
- 对照了服务端 `packages/application/src/ports/perception.ts`、`packages/platform-node/src/perception-service.ts`、`device-api-routes.ts`、`contracts-v2.ts`、`client-capabilities.ts`。
- 没有运行 Swift/TS 测试，也没有在 Mac 上编译或看截图；涉及运行结果的部分标「未核实」。

### 1. 高：#2 钥匙串服务名改为常量且没有迁移，升级后会走“忘记”并清空本地库

文件:行：`clients/apple/Sources/HimawariCore/SharedVault.swift:7`、`:33-37`；`clients/apple/Sources/HimawariShell/AppModel.swift:81-90`、`:431-442`；`clients/apple/Sources/HimawariCore/PairingDecisions.swift:14-18`。

问题：新增的 `SharedVault` 把钥匙串服务名固定成 `himawari.device`，密钥服务固定成 `himawari.device.keys`；旧版本是从 bundle identifier 派生的 `<bundleId>.device`。代码里没有任何旧服务名读取或迁移。

证据（读代码证实）：

- `SharedVault.swift:7`：`public static let service = "himawari.device"`
- `SharedVault.swift:33`：`SecureEnclaveKeyStore(service: Self.service + ".keys", accessGroup: keychainGroup)`
- `SharedVault.swift:37`：`KeychainValueStore(service: Self.service, accessGroup: keychainGroup)`
- 对比基准 `9dd41fe` 的 `AppModel.swift`：`let service = (bundle.bundleIdentifier ?? "himawari") + ".device"`
- `PairingDecisions.swift:16`：`guard presence.allSatisfy({ $0 == .present }) else { return .forget }`
- `AppModel.swift:88-90`：`case .forget: forget(problem: nil)`
- `AppModel.swift:435`：`let emptied = emptyStore()`；`AppModel.swift:231` 调用 `retire()` 清空本地存储。

推测：已配对用户升级后，新代码读不到旧钥匙串，`restore()` 会判为 `.forget`，随后 `forget()` 清空本地聊天/发件箱/感知队列，并删除新旧密钥。用户会看到“未配对”，且本地未发送内容丢失。是否需要兼容取决于旧版本是否已经发布，但代码本身没有迁移路径。

建议：在新服务名读取失败时尝试旧服务名（`bundle.bundleIdentifier + ".device"` 和 `.keys`），迁移成功后再写新服务名；迁移完成前不要调用 `emptyStore()`/`retire()`。补一条“旧服务名有记录、新服务名为空”的恢复测试。

### 2. 中：#3 mirror 字段的最小值和枚举候选仍被客户端丢掉，非法值会让整次 mirror 同步反复被 400 拒绝

文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:107-111`；`clients/apple/Sources/HimawariCore/SenseRecords.swift:66-84`；`clients/apple/Sources/HimawariCore/MirrorSync.swift:31-40`；`clients/apple/Sources/HimawariSenses/SenseSink.swift:61-64`；服务端 `packages/application/src/ports/perception.ts:43-52`、`:285-303`。

问题：服务端字段规则包含 `minimum`、`maximum` 和枚举的 `values`，客户端 `PerceptionFieldRule` 只解码 `kind`、`maximum`、`optional`，`fit()` 对 enum 直接放行，对 integer/number 只检查有限性，不检查最小值和最大值。越界值或不在候选里的值会先被接受，再由服务端整批拒绝。

证据（读代码证实）：

- 服务端规则：`PerceptionFieldRule` 有 `minimum`、`maximum`，enum 有 `values`（`perception.ts:43-52`）。
- 客户端规则只有：`public let kind: String`、`public let maximum: Int?`、`public let optional: Bool?`（`Handover.swift:107-111`）。
- 客户端 fit：
  - `case ("enum", .string): return value`（`SenseRecords.swift:71-72`）
  - integer/number 只检查 `number.isFinite` 并四舍五入，没有 min/max（`SenseRecords.swift:73-78`）。
- 服务端会拒绝：
  - integer：`(value as number) < rule.minimum || ... > rule.maximum`（`perception-service.ts` 调用的 `validatePerceptionFields`，`perception.ts:290-297`）
  - enum：`!rule.values.includes(value)`（`perception.ts:301-303`）
- `MirrorFields.fit` 只要 fit 不抛错就保留字段（`MirrorSync.swift:34`）；`SenseSink.mirror` 用 `try?` 吞掉同步错误（`SenseSink.swift:64`），ledger 不保存，下一次仍会重试同一批。

推测：只要日历/联系人里出现一个服务端不接受的值，这一整类 mirror 会一直同步失败，用户看到“已同步”或计数不变，但服务器副本没有更新。

建议：客户端 `PerceptionFieldRule` 增加 `minimum`、`values`，`fit()` 对 integer/number 校验区间，对 enum 校验候选；`MirrorFields.fit` 对非法字段返回 `nil` 或按服务端规则丢弃整条，避免整批 400。补一个“越界 integer / 非法 enum 被客户端先拦下”的反向测试。

### 3. 中：#5 顶层 text 按 Unicode 标量截断，服务端按 UTF-16 长度校验，emoji 记录会被判 malformed 并丢弃

文件:行：`clients/apple/Sources/HimawariCore/SenseRecords.swift:46-53`；`clients/apple/Sources/HimawariCore/Handover.swift:7-18`；服务端 `packages/platform-node/src/perception-service.ts:394-398`；`clients/apple/Sources/HimawariCore/SenseUpload.swift:189-199`。

问题：感知记录的顶层 `text` 用 `TextBudget.scalarPrefix` 按 Unicode 标量截断；服务端用 JavaScript 的 `text.length`（UTF-16 code units）校验 `PERCEPTION_TEXT_MAXIMUM`。非 BMP 字符（emoji、部分符号）每个标量占 2 个 UTF-16 单元，所以客户端认为没超限的文本会被服务端拒绝。

证据（读代码证实）：

- `SenseRecords.swift:52`：`text = trimmed.map { value in textLimit.map { TextBudget.scalarPrefix(value, limit: $0) } ?? value }`
- `Handover.swift:8`：`guard text.unicodeScalars.count > limit else { return text }`
- `perception-service.ts:396`：`(typeof text !== "string" || text.length === 0 || text.length > PERCEPTION_TEXT_MAXIMUM)`
- `SenseUpload.swift:190-198`：收到 400/422 时先把批次对半，最后把单条记录从本地队列删除并记为 malformed。

推测： clip（剪贴板）等采集器产生大量 emoji 时，记录不会报错给用户，而是被当作 malformed 静默丢弃。服务端字段证据里的字符串用的是 `[...value].length`（码点），所以只有顶层 text 这一处不一致。

建议：顶层 text 改用现有的 UTF-16 截断实现（`MessageAttachments.clip` 或 `MessageSensing.utf16Prefix` 的同类逻辑），并加一条“全 emoji 文本刚好达到上限”的测试。

### 4. 中：#4 今天的列表仍只取第一页，`nextCursor` 被忽略

文件:行：`clients/apple/Sources/HimawariCore/SensesGateway.swift:61-66`、`:102-119`；`clients/apple/Sources/HimawariSenses/SensesService.swift:108-110`；`clients/apple/Sources/HimawariSenses/SensesModel.swift:107-118`。

问题：服务端快照带 `nextCursor`，`SensesGateway.day` 也接受 `cursor` 参数，但 `LiveSensesService.day` 不传 cursor，`SensesModel.loadDay` 只保存一次 `PerceptionDaySnapshot`。超过一页的“今天”记录不会显示。

证据（读代码证实）：

- `PerceptionDaySnapshot` 有 `nextCursor`（`SensesGateway.swift:65`）。
- `day(types:cursor:)` 支持 cursor（`SensesGateway.swift:102`）。
- `LiveSensesService.day` 调用 `try await gateway.day(types: item.recordTypes)`，没有 cursor（`SensesService.swift:109`）。
- `loadDay` 只执行一次 `days[item] = .loaded(try await service.day(item))`（`SensesModel.swift:114`）。
- 现有测试只有 `nextCursor: NSNull()` 的单页用例（`SensesTests.swift:274`、`SenseLinesTests.swift:25`），没有多页反向用例。

推测：列表页数超过服务端 `listPageRows` 时，用户看到的“今天”条数和实际不符，且没有“加载更多”。

建议：在 service 层循环 cursor 直到 `nextCursor == nil`，或在 model/UI 增加分页加载；补一条两页数据的测试，断言第二页记录也出现。

### 5. 中低：#6 只修了“配置未知不启动”，UI 仍显示开着，配置稍后到达也不会自动 reconcile

文件:行：`clients/apple/Sources/HimawariSenses/SensesModel.swift:85-94`、`:130-149`；`clients/apple/Sources/HimawariCore/Senses.swift:104-116`；`clients/apple/Sources/HimawariShell/AppModel.swift:357-388`、`:425-428`。

问题：`cc1e0c3` 加了 `if service.server != nil { service.start(item) }`，避免配置未知时静默采集/丢弃；但 `state()` 在 `server == nil` 时仍然返回 `.on`。如果用户在配置未知时打开一项，`turnOn` 会直接跳过服务器刷新（因为 `service.server` 为 nil），UI 显示已开启，采集器却没启动。之后重试配置成功时，`AppModel.retryConfiguration` 只更新 `configuration`，没有调用 `senses.resume()`。

证据（读代码证实）：

- `Senses.swift:113`：`guard let server else { return .on }`
- `SensesModel.swift:88`：`if service.server != nil { service.start(item) }`
- `SensesModel.swift:130`：`if let sense = item.serverSense, let server = service.server, !server.allows(item) { ... }`——server 为 nil 时不会刷新服务器配置。
- `AppModel.swift:368-381`：`retryConfiguration` 成功后只设置 `self.configuration`、heartbeat、streams，没有 `senses?.resume()`。
- `AppModel.swift:425-428`：只有 `becameActive()` 会 `await senses?.refresh()`。

推测：配置一开始拉取失败时，用户点开一项会看到“已开启”，实际没有任何采集；即使后台重试配置成功，也不会自动开始，直到用户切后台再回来或手动刷新。新增测试 `refreshDoesNotStartACollectorBeforeTheServerConfigurationIsKnown` 只验证“不启动”，没有验证 UI 状态和后续恢复。

建议：为“配置未知”引入明确的 UI 状态（例如“等待服务器配置”），不要显示 `.on`；`refreshConfiguration`/`retryConfiguration` 成功后调用 `senses.resume()`；`turnOn` 在 `server == nil` 时先 `refreshServer()` 再判断。补一条“配置先失败、后成功自动开始采集”的测试。

### 6. 中低：增量把队列前缀从 `handover-` 改成 `handover-item-`，旧队列文件不再被读取或删除

文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:434`、`:441-452`。

问题：本次增量把 `HandoverQueue.prefix` 从 `handover-` 改成了 `handover-item-`。`pending()` 只扫描新前缀，`remove()` 也只删除新前缀；升级前写入的 `handover-<id>` 文件和 `handover-index` 不再被读取，也不会被清理。

证据（读代码证实）：

- 当前：`public static let prefix = "handover-item-"`（`Handover.swift:434`）
- `pending()`：`.filter { $0.hasPrefix(Self.prefix) }`（`Handover.swift:442`）
- `add`/`remove`：`Self.prefix + handover.id` / `Self.prefix + id`（`Handover.swift:448`、`:452`）
- `git diff cc1e0c3..10057ba` 显示旧值为 `public static let prefix = "handover-"`，并且旧实现还使用 `handover-index`。

推测：如果旧前缀曾经出现在已发布版本里，升级后用户排队未发出的分享/Safari 内容会永远不再发送；这些文件可能包含页面全文，也会一直留在磁盘上。如果这个前缀只存在于未发布的 PR 分支，影响只限开发/测试数据。旧版本是否已发布这一点未核实。

建议：`pending()` 同时接受旧前缀并在读取后迁移到新前缀；或启动时把旧前缀文件重命名为新前缀并删除 `handover-index`。补一条“旧前缀文件在升级后仍能 pending/发送”的测试。

### 7. 低：新的消息长度检查在附件上传之后才做，超长请求会留下未使用的服务器附件

文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:373-378`。

问题：`.conversation` 分支先 `uploadAttachment`，再检查 `MessageAttachments.fits`；如果 request 超过 `messageCharacters`，返回 `.failed(.tooLarge)`，但附件已经上传，之后既不会建 thread，也不会删除这个附件。

证据（读代码证实）：

- `Handover.swift:374`：`let ref = try await api.uploadAttachment(...)`
- `Handover.swift:376-377`：`if ... !MessageAttachments.fits(...) { return .failed(.tooLarge) }`
- 该失败路径不会再调用任何删除/回收接口。

推测：服务端是否自动清理未使用的 attachment、保留多久，未核实；如果用户反复重试超长 request，可能占服务器存储/配额。新增测试 `aRequestLongerThanAMessageIsRefusedBeforeAThreadIsOpened` 只断言没有建 thread，没有断言附件被清理。

建议：能在上传前估算的（request 长度 + 预估 tag）先拒绝；不能估算时在 `tooLarge` 分支调用删除附件接口，或让服务端对未引用附件立即回收。补一条“超长请求不会留下附件”的测试。

## 侧重检查

- 错误路径：重点看了 `HandoverCourier.deliver` 的 404/405、413、429、5xx、超时、`tooLarge`、`maximum` 拒绝、`SenseUpload` 的 400/422 对半拆包、`SensesGateway` 的 404/未知类型、`AppModel.restore` 的 `.forget`。发现高风险的升级清库路径（意见 1）。
- 不合规范/不可信输入：核对了服务端字段规则与客户端 `PerceptionFieldRule`，发现 minimum/enum 没有传到客户端（意见 2）；核对了顶层 text 的长度单位（意见 3）。
- 安全与不可撤销操作：确认 `perception.records.delete` 不在能力表，`AppModel.phoneOperations` 过滤后 `canDelete` 为 false，删除按钮隐藏；镜像关闭有本地 `confirmationDialog`；但钥匙串迁移会触发不可撤销的本地清空（意见 1）。
- 资源耗尽：看了队列重试、附件上传顺序、mirror 整批失败重试；发现超长请求上传后才拒绝可能留下附件（意见 7），以及 mirror 非法值导致重复整批同步（意见 2）。
- 规则/文档一致性：核对了 `.agents/instructions/prompt-prefix.md` 的约束，增量没有改提示词、系统提示、工具定义或历史组装；核对了作者关于能力表和删除按钮的说法，代码一致。作者说“只有 Linux 能编译 HimawariCore（192 个测试通过）”“界面层已在 Mac 编译并截图验收”，本轮无法运行/查看，标为未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及本次增量。`cc1e0c3..10057ba` 里没有改系统提示、工具定义、历史消息或遮盖逻辑；新增的 `search.ask.read`、`proposals.read`、`proposal.respond` 是设备网关操作，不进模型请求；Handover/Senses 的值也不进模型。因此按代码看仍是“只在末尾追加、每轮变化的值在最后一条消息”。`npm run check:prompt-prefix` 未运行（本轮不能运行测试）。

2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及模型请求。增量自己的序列化里，`MirrorSync.digest` 用 `.sortedKeys`，`HandoverQueue.pending()` 用 `(createdAt, id)` 排序，顺序是确定的；没有发现新的依赖前后文的遮盖或带时间的模型字段。`MirrorSync.nextVersion` 使用当前时间，但只写入 mirror 版本号，不进模型请求。

3. **有没有对应的自动检查？反向用例会失败吗？**
   - 增量的 Handover 改动有测试：`aBigImageWithoutARequestOnAServerWithoutUploadsIsReportedAsOutdated`、`aRequestLongerThanAMessageIsRefusedBeforeAThreadIsOpened`、`theQueueSurvivesTwoWritersThatNeverSawEachOthersIndex`、`theQueueKeepsWhatAnOutdatedServerCouldNotTakeYet`、`manyWritersThatNeverSawEachOthersWorkAllKeepTheirItems`；Safari 面板有 `does not claim the full page was handed over when delivery failed`。按旧代码推理，这些反向用例会失败（旧代码 404 会落到 `.rejected`、旧代码没有 `fits` 检查、旧队列索引并发会丢项、旧 popup 对 failed 仍写全文）。
   - 但意见 6 的新测试只覆盖“配置未知不启动”，没有覆盖 `state()` 显示错误和配置到达后自动恢复；意见 1、2、3、4 没有对应反向测试；意见 6 的队列前缀迁移也没有测试。
   - 这些测试本轮没有实际运行，标「未核实」。

4. **改动产生的每个值，使用端都能接受吗？**
   - `handover-item-`：生产端 `add` 和消费端 `pending` 使用同一前缀，但旧前缀 `handover-` 的文件两端都不接受，见意见 6。
   - `kept`：`SafariBridge.describe` 写布尔值，`popup.js` 用 `reply.kept !== false` 读取，能接受；但 `.unpaired`/`.unreadable` 不发 `kept`，会被当成 `true`，这是既有行为的延续，未列为本次错误。
   - `LocalStore.names()`：`FileLocalStore`、`MemoryLocalStore` 和测试里的 `UnreadableMarkStore` 都实现了，能对接。
   - 新增能力字符串 `proposals.read`、`proposal.respond`、`search.ask.read`：生成的 `ClientCapabilities.swift` 与 `client-capabilities.ts` 一致；服务端有 `production-proposal-control.ts`、`production-search.ts` 的处理和集成测试，未发现两端校验不一致。
   - `PerceptionFieldRule` 的 minimum/enum：服务端产生、客户端消费，客户端接受不了，见意见 2。
   - `recordTextCharacters`：服务端产生，客户端按标量消费，服务端按 UTF-16 校验，见意见 3。
   - `nextCursor`：服务端产生，客户端没有消费，见意见 4。
   - 钥匙串服务名：新代码产生 `himawari.device`，旧钥匙串使用 bundle 派生名，新代码不消费旧值，见意见 1。
