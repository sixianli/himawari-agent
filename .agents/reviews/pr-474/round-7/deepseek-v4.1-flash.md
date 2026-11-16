本轮增量 `19be57cba..32a5da584` 只有 `ci/operations-pending.json` 删除 3 条、评审记录和 `usage.jsonl`；**没有任何 Swift 或服务端代码修改**。材料说上一轮“会出错”的意见已修改，但我在 HEAD 上逐条核对，第 6 轮列出的 7 条全部仍存在。下面先列问题，再给作者说法核对、侧重检查、结论和必答问题。

### 1. 高：钥匙串服务名改成常量后没有迁移，升级会忘记设备并清空本地库
- 文件:行：`clients/apple/Sources/HimawariShell/AppModel.swift:73-76,100-102,288-293`；`clients/apple/Sources/HimawariCore/SharedVault.swift:7`；`clients/apple/Sources/HimawariCore/PairingDecisions.swift:16`
- 问题：旧代码用 `<bundleIdentifier>.device` 作为钥匙串服务名，新代码固定用 `himawari.device`，没有读取旧服务名并迁移。升级后新服务名下没有配对记录和设备密钥，`RestoreDecision` 会返回 `.forget`，随后 `emptyStore()` 调用 `store.retire()` 清空本地库。
- 证据：`SharedVault.swift:7` 是 `public static let service = "himawari.device"`；`AppModel.swift:75-76` 是 `keys = vault.keys`、`keychain = vault.keychain`。`git diff 9dd41fe..32a5da5` 显示旧代码是 `let service = (bundle.bundleIdentifier ?? "himawari") + ".device"`、`SecureEnclaveKeyStore(service: service + ".keys")`。`PairingDecisions.swift:16`：`guard presence.allSatisfy({ $0 == .present }) else { return .forget }`；`AppModel.swift:289`：`try (store ?? FileLocalStore.applicationSupport(named: "himawari-device")).retire()`。用 `grep` 搜 `migrat|legacy|oldService` 没有找到迁移代码。
- 建议：启动时先查旧服务名 `<bundleIdentifier>.device` 的配对记录和 `.device.keys`，迁移或回退读取；在旧数据存在时不要走 `.forget`。补一个“旧服务名有记录、新服务名为空”的升级测试。
- 读代码证实/推测：读代码证实上述读取和清理路径；推测“已有用户安装过旧版本”才会实际触发，是否已有此类安装未核实。

### 2. 中：镜像字段仍不校验 `minimum`/`values`，越界时服务端会整批 400，客户端静默丢掉整次同步
- 文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:107-111`；`clients/apple/Sources/HimawariCore/SenseRecords.swift:66-83`；`clients/apple/Sources/HimawariCore/MirrorSync.swift:31-41,88-93`；`clients/apple/Sources/HimawariSenses/SenseSink.swift:55-65`
- 问题：客户端解码服务器下发的字段规则时只保留 `kind`、`maximum`、`optional`，丢掉了 `minimum` 和枚举的 `values`；`fit` 对 `enum` 直接返回原字符串，对 `integer/number` 只检查有限值并四舍五入，不检查上下界。一个越界值会让服务端整批 `400`，而 `SenseSink.mirror` 用 `try?` 吞掉错误，镜像会静默停止更新。
- 证据：`Handover.swift:107-110`：`public let kind: String`、`public let maximum: Int?`、`public let optional: Bool?`，没有 `minimum`/`values`。`SenseRecords.swift:71-75`：`case ("enum", .string): return value`、`case let ("integer", .number(number)): guard number.isFinite else ...; return .number(number.rounded())`。服务端 `packages/application/src/ports/perception.ts:324-336` 明确检查 `Number.isSafeInteger`、`< rule.minimum`、`> rule.maximum`、`rule.values.includes(value)`；`packages/platform-node/src/perception-service.ts:777-780` 对整批 `data` 做校验，失败返回 `invalid("mirror_data")`。`SenseSink.swift:64`：`_ = try? await mirror.sync(...)`。
- 建议：给 `PerceptionFieldRule` 增加 `minimum`、`values`，在 `SenseRecordBuilder.fit`/`MirrorFields.fit` 中拒绝或修正越界值；补“枚举非法值”“整数低于 minimum/高于 maximum”的反向用例，并确认失败不会被 `try?` 完全吞掉。
- 读代码证实/推测：校验缺口和整批 400、静默吞错是读代码证实的；“具体某个日历/联系人字段在实际数据中越界”是条件性的，未核实。

### 3. 中：顶层感知文本仍按 Unicode 标量截断，emoji 文本会被服务端判 malformed 丢掉
- 文件:行：`clients/apple/Sources/HimawariCore/SenseRecords.swift:51-52`；`clients/apple/Sources/HimawariCore/Handover.swift:6-18`；`packages/platform-node/src/perception-service.ts:418-422`；`packages/application/src/ports/perception.ts:40`
- 问题：客户端用 `unicodeScalars` 计数截断顶层 `text`，服务端用 JavaScript 字符串的 `text.length`（UTF-16 码元）判断上限。星平面 emoji 在 Swift 里是一个标量、在 JS 里是两个码元；客户端可能放过超过 32768 个 UTF-16 码元的文本，服务端返回 400，队列把这条记录当 malformed 删除。
- 证据：`SenseRecords.swift:52`：`TextBudget.scalarPrefix(value, limit: $0)`；`Handover.swift:8`：`guard text.unicodeScalars.count > limit else { return text }`。服务端 `perception-service.ts:419-420`：`(typeof text !== "string" || text.length === 0 || text.length > PERCEPTION_TEXT_MAXIMUM)`，`perception.ts:40`：`PERCEPTION_TEXT_MAXIMUM = 32 * 1024`。注意证据字段用的是 `[...value].length`（`perception.ts:321`），所以这个不一致主要在顶层 `text`。现有 `SensesTests.swift:126-152` 只测日文和 ASCII，没有 emoji 超限用例。
- 建议：统一按 UTF-16 码元截断并保证不拆代理对，或让服务端也按码点计数；补一个“超限 emoji 文本不超过服务端上限”的反向测试。
- 读代码证实/推测：计数口径不一致和最终 400/malformed 路径是读代码证实的。

### 4. 中：今天的列表仍只取第一页，`nextCursor` 被忽略
- 文件:行：`clients/apple/Sources/HimawariCore/SensesGateway.swift:102-119`；`clients/apple/Sources/HimawariSenses/SensesService.swift:108-110`；`clients/apple/Sources/HimawariSenses/SensesModel.swift:107-118`；`clients/apple/Sources/HimawariSenses/SenseDetailView.swift:42-47,80-100`
- 问题：网关支持 `cursor`，服务端也返回 `nextCursor`，但 `SensesService.day` 从不传 cursor，`SensesModel.loadDay` 只保存第一个 snapshot，详情页也只渲染这一页。记录多时，“今天”的列表不完整；`total` 显示的是总数，和可见行数不一致。
- 证据：`SensesGateway.swift:102`：`public func day(types: [String], cursor: String? = nil)`，`SensesGateway.swift:65`：`public let nextCursor: String?`。`SensesService.swift:109`：`try await gateway.day(types: item.recordTypes)`，没有 cursor 参数。`SensesModel.swift:114`：`days[item] = .loaded(try await service.day(item))`，没有循环。服务端 `apps/agent-service/src/production-perception-control.ts:193`：`nextCursor: page.nextCursor`。
- 建议：循环请求直到 `nextCursor == nil`，或在界面上明确“加载更多”；加分页两页数据的自动检查。
- 读代码证实/推测：读代码证实只取第一页。把 `perception.day.read` 移出 `operations-pending` 本身符合 check 规则，但不代表这个调用方功能完整。

### 5. 中低：配置未知时仍显示“开着”，配置晚到后不会重新 reconcile
- 文件:行：`clients/apple/Sources/HimawariCore/Senses.swift:99-117`；`clients/apple/Sources/HimawariSenses/SensesModel.swift:85-94`；`clients/apple/Sources/HimawariShell/AppModel.swift:441-457`
- 问题：`SenseStateRule.state` 在 `server == nil` 时返回 `.on`，界面会显示开着；但 `reconcile` 的 `.on` 分支要求 `service.server != nil` 才启动采集器。`AppModel.retryConfiguration` 后来拿到配置时只设置 `self.configuration`，没有调用 `senses.refresh()`，所以晚到的配置不会触发状态/采集器重新协调，通常要等 App 再进前台。
- 证据：`Senses.swift:113`：`guard let server else { return .on }`；`SensesModel.swift:87-88`：`case .on: if service.server != nil { service.start(item) }`；`AppModel.swift:446-450` 设置 `self.configuration`、心跳和流数量，但没有 `senses?.refresh()`。`SensesReconcileTests.swift:89-96` 只断言“配置未知时不启动”，没有断言界面状态或配置晚到后的重新协调。
- 建议：配置未知时用“未知/加载中”状态，不显示开着；配置重试成功后显式调用 `senses.refresh()`；补配置从 nil 到有值的测试。
- 读代码证实/推测：状态显示与不启动的矛盾、重试路径不刷新是读代码证实的。

### 6. 中低：队列前缀改成 `handover-item-` 后仍没有迁移旧的 `handover-` 文件
- 文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:433-449`
- 问题：`pending()` 只枚举 `handover-item-` 前缀。之前版本写入的 `handover-<id>` 文件和 `handover-index` 不会出现在待发送列表里，既不会补交，也不会被清理，永久占着共享存储。
- 证据：`Handover.swift:435`：`public static let prefix = "handover-item-"`；`Handover.swift:442-444`：`store.names().filter { $0.hasPrefix(Self.prefix) }`。`git log -p -S 'handover-item-' -- clients/apple/Sources/HimawariCore/Handover.swift` 显示本次修改是从 `public static let prefix = "handover-"` 改成新前缀，且只改了 `pending()` 的枚举方式，没有旧前缀迁移。
- 建议：首次读取时同时扫描旧前缀，解码后改写到新前缀并删除旧文件；或让 `pending()` 兼容两个前缀。补“旧前缀文件能被补交”的测试。
- 读代码证实/推测：读代码证实旧前缀不会被枚举；真实设备上是否存在旧文件未核实。

### 7. 中低：作者说镜像项“关掉时会删服务器副本并确认”，但开关关闭路径不删，只有单独的删除按钮会删
- 文件:行：`clients/apple/Sources/HimawariSenses/SensesModel.swift:152-155,192-203`；`clients/apple/Sources/HimawariSenses/SenseDetailView.swift:25-30,52,149-158`
- 问题：日历/通讯录的开关关闭走 `turnOff`，只停止采集并丢弃本地未上传队列，不调用 `clearMirror`。会删除服务器副本的 `turnOffAndClear` 只接在“删掉全部/关掉并删掉服务器上的…”按钮和确认框上。用户把开关关掉后，服务器副本仍在，和作者的说法不一致，也和“删掉服务器副本需要确认”的隐私预期不一致。
- 证据：`SensesModel.swift:152-155`：`public func turnOff(_ item: SenseItem) async { update(item) { $0.on = false }; await service.stop(item) }`，没有 `clearMirror`。`SensesModel.swift:192-203` 的 `turnOffAndClear` 才调用 `service.clearMirror(item)`；`SenseDetailView.swift:28`：`if item.isMirror { await model.turnOffAndClear(item) } else { await model.deleteAll(item) }`，而开关绑定在 `SenseDetailView.swift:52` 走 `setSwitch` → `turnOff`。
- 建议：如果产品意图是“关掉镜像即删服务器副本”，开关关闭时也走确认 + `clearMirror`；如果意图是“关开关只停止同步，另设删除按钮”，请修正文档/界面文字，避免用户以为关掉开关就删了服务器副本。
- 读代码证实/推测：两条路径的差异是读代码证实的；产品意图需确认。

### 8. 低：消息长度检查仍在上传附件之后，超长请求会留下未使用的服务器附件
- 文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:374-379`；`clients/apple/Sources/HimawariCore/MessageAttachments.swift:46-48`
- 问题：先调用 `api.uploadAttachment` 上传附件，再用 `MessageAttachments.fits` 检查“请求文字 + 附件标签”是否超过 `messageCharacters`。超长时直接返回 `.failed(.tooLarge)`，不会创建线程，但已经上传的附件留在服务器上，形成不可见垃圾/资源占用。
- 证据：`Handover.swift:375`：`let ref = try await api.uploadAttachment(...)`；`Handover.swift:377-379`：`if let limits = configuration.attachments, !MessageAttachments.fits(...) { return .failed(.tooLarge) }`。`MessageAttachments.swift:47`：`compose(...).utf16.count <= limits.messageCharacters`。
- 建议：上传前用“请求文字 + 最坏情况标签长度”做保守预检，或失败时调用删除附件接口清理；补一个“超长请求不产生附件”的反向测试。
- 读代码证实/推测：顺序和附件残留是读代码证实的；“服务器是否会自动回收未引用附件”未核实。

### 9. 中低：位置 visit/region 记录实际一直留到删除，但界面只显示路线 90 天，且删除按钮被隐藏
- 文件:行：`clients/apple/Sources/HimawariCore/Senses.swift:23-46`；`clients/apple/Sources/HimawariSenses/SenseDetailView.swift:110-124,149-158`；`clients/apple/Sources/HimawariSenses/SensesModel.swift:59`；`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift`（无 `perception.records.delete`）；`packages/application/src/ports/perception.ts:116-120`；`packages/platform-node/src/perception-service.ts:717-729`；`packages/persistence-sqlite/src/sqlite-perception-operations.ts:1301-1328`
- 问题：位置项同时采集 `location.visit`、`location.region`（感知记录）和轨迹点。服务端只按 `track` 保留天数清理 `location_track_points`，按 `surroundings` 类型清理感知记录；`location.visit`/`location.region` 的 retention 是 `until_deleted`。但界面的“怎么留”只显示 `track` 的 90 天，没有写“这些访问记录一直留到删除”；同时 `perception.records.delete` 不在能力表里，非镜像项的删除按钮被隐藏，用户没有入口删除这些记录。
- 证据：`Senses.swift:25`：`case .location: ["location.visit", "location.region"]`；`Senses.swift:43`：`case .location: "track"`。`SenseDetailView.swift:115-123` 有 retention 时只显示 `detail.\(item.retentionLabel)`（track），否则才显示 `intro.keepUntilDeleted`；`SenseDetailView.swift:149`：`if item.isMirror || model.canDelete`，`SensesModel.swift:59`：`canDelete` 来自 `service.operations.contains(SenseOperation.deleteRecords)`。服务端 `perception.ts:116-120`：`retention: surroundings ? "surroundings" : "until_deleted"`；`perception-service.ts:725-729` 的 `trackBeforeMs` 只用于轨迹点，`surroundingsTypes` 才用于记录；`sqlite-perception-operations.ts:1304-1309` 删除 `location_track_points`，`1316-1328` 只删除 `surroundingsTypes` 的 `perception_records`。
- 建议：在位置详情里明确区分“轨迹点按 track 保留”和“visit/region 记录一直保留到删除”；在删除能力开放前，至少提供明确的删除入口或说明“暂时不能删”。补 retention 文案/服务端行为的对应用例。
- 读代码证实/推测：服务端只按 surroundings 清理记录、界面只显示 track、删除按钮被隐藏，都是读代码证实的；是否已有用户依赖这个界面做隐私判断是推测。

### 10. 低：ADR 0192 的“名单目前登记 23 项”已经过期，本次删除后差距更大
- 文件:行：`docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md:48`；`ci/operations-pending.json:4-34`
- 问题：文档写“名单目前登记 23 项”，当前 `operations` 已有 30 项（本次删除前是 33 项），`notInstalled` 还有 7 项。这个数字原本就不准，本次删除 3 项后更不准。
- 证据：`ci/operations-pending.json` 的 `operations` 从 `delegation.detail` 到 `workspace.stage` 共 30 个键；`docs/adr/0192...:48`：`名单目前登记 23 项`。
- 建议：不要硬编码数量，改为说明分组和查询方式；或随名单变更同步更新。
- 读代码证实/推测：计数不一致是读代码证实的；这是旧问题，不是本轮引入。

## 作者说法核对

- 成立：`perception.status.read`、`perception.day.read`、`perception.settings.change` 在 `ClientCapabilities.swift:118-122`；`perception.records.delete` 不在能力表、也不在契约里，`SensesModel.canDelete` 会为 false，非镜像删除按钮隐藏（`SensesModel.swift:59`、`SenseDetailView.swift:149`）。
- 成立：开启服务器感知时 `SensesGateway.setSense` 的 `confirm: enabled`，关闭服务器感知没有对应调用；`turnOff` 不做服务端设置。Face ID 路径与作者描述一致（`SensesGateway.swift:122-125,214-230`）。
- 不成立/不完整：作者说“上一轮意见已修改”，本轮增量没有代码修改，第 6 轮 7 条仍存在。
- 不成立/不完整：作者说“其余感知记录……界面写一直留”，位置的 visit/region 记录实际一直留，但位置界面只显示 track 天数，见第 9 条。
- 不成立/不完整：作者说“日历和联系人是镜像：关掉时要删服务器副本，需要确认”，开关关闭路径不删，只有单独的删除按钮会删，见第 7 条。
- 未核实：Linux 192 个测试、Mac 界面编译和 5 屏截图验收。

## 侧重检查

- 错误路径/不可信输入：服务端下发的 `recordTypes`/`mirrorKinds` 规则被客户端忽略 `minimum`/`values`（第 2 条）；`recordTextCharacters` 与顶层文本的 UTF-16/标量口径不一致（第 3 条）；`nextCursor` 被忽略（第 4 条）；配置晚到不 reconcile（第 5 条）。
- 安全/隐私：钥匙串换服务名会丢配对并清空本地库（第 1 条）；镜像开关关闭不删服务器副本（第 7 条）；位置 visit/region 一直保留但没有正确披露/删除入口（第 9 条）；删除能力隐藏本身符合作者说法，已核对。
- 资源耗尽/不可撤销：超长消息先上传附件后判失败，留下未引用附件（第 8 条）；旧 `handover-` 队列文件永不补交、永不清理（第 6 条）；镜像整批 400 被 `try?` 吞掉，可能长期静默失败（第 2 条）。
- 规则文件/文档/代码一致：`ci/operations-pending.json` 的删除能被 `check-operations` 和测试接受；但 ADR 0192 的数量说明已过期（第 10 条）；第 6 轮“已修改”的说法与代码不一致。
- 查过范围：`19be57cba..32a5da584` 全量 diff；`scripts/check-operations.mjs` 及 `test/tooling/operations-check.test.mjs`；`SharedVault`/`AppModel`/`PairingDecisions`；`SenseRecords`/`SenseUpload`/`MirrorSync`/`SenseSink`；`SensesGateway`/`SensesService`/`SensesModel`；`Handover`/`MessageAttachments`；服务端 `perception.ts`、`perception-service.ts`、`production-perception-control.ts`、`sqlite-perception-operations.ts`；相关 Swift 测试和 ADR 0192。未核实真实设备上的旧钥匙串/旧队列文件。

## 结论

本轮增量只删除了 3 条 CI 待接入名单，没有任何上一轮代码修复；第 6 轮列出的 7 条问题在 HEAD 上均仍成立。删除名单本身能通过 `check:operations`，但它只证明“有调用方”，不证明调用方正确，尤其 `perception.day.read` 的分页仍未实现。最优先处理第 1 条（升级丢配对/清库）、第 2 条（镜像静默失败）、第 3 条（emoji 文本被丢）和第 9 条（位置记录保留与披露不一致）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 本次增量不涉及。只改了 `ci/operations-pending.json`，没有触碰系统提示、工具定义、历史消息、遮盖结果或任何发给模型的内容；没有新增末尾消息，因此也不涉及“只在末尾追加”的规则。
2. **同一段文字会不会在不同请求里变成不同字节？** 本次增量不涉及。没有新增时间字段、无序集合或依赖前后文的遮盖；被删除的只是 CI 名单项。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 名单删除有：`scripts/check-operations.mjs` 检查缺后端/调用方/测试，`test/tooling/operations-check.test.mjs:151-158` 有“已齐全却仍在待接入名单”的反向用例，`:484` 对真实仓库跑全量检查。但第 6 轮这 7 条代码问题没有对应的反向测试：`SensesTests.swift` 没有 emoji 超限、minimum/values、cursor 第二页用例；`HandoverTests.swift` 没有队列前缀迁移、上传前长度检查用例；`SensesReconcileTests.swift` 没有配置晚到后的重新协调用例。通过 `check:operations` 不能证明这些行为正确。
4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？** 被删除的 3 个键的唯一直接消费者是 `scripts/check-operations.mjs`（`PENDING_LEDGER`，`:347-360,427-433`）和它的测试夹具，二者都接受删除；这些操作名仍存在于契约（`packages/gateway-contracts/src/contracts-v2.ts:159,161,167`）、后端已安装清单（`apps/agent-service/src/production-perception-control.ts:28-34`）、能力表（`ClientCapabilities.swift:118-122`）、Swift 网关（`SensesGateway.swift:99,119,123,129`）和测试中。`perception.day.read` 的 null 字段契约允许（`contracts-v2.ts:816-824`），`perception.settings.change` 的 null 字段也允许（`:886-897`），所以没有发现像 I-73 那样的“清单 id 过不了后端校验”问题。但 `perception.day.read` 的使用端只消费第一页，`nextCursor` 没有被使用（第 4 条）；`perception.records.delete` 不在契约和能力表里，当前只能隐藏按钮，不能真正调用。
