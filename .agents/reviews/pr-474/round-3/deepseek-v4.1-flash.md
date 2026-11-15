## 本轮范围

- 增量：`git diff 58e0bdf4c1813d25481d9b5780fce306836f4254..cc1e0c3e037314d6c5ac6068c9023b470c5705ae`，实际涉代码只 5 个 Swift 文件（`DemoSenses`、`SensesModel`、`SensesService`、`AppModel`、`SensesReconcileTests`），其余是复核记录。
- 为核对上一轮意见，跟读到的旧代码：`HimawariCore/Senses.swift`、`SenseRecords.swift`、`SenseUpload.swift`、`MirrorSync.swift`、`SensesGateway.swift`、`SharedVault.swift`、`KeychainValueStore.swift`、`SecureEnclaveKeys.swift`、`PairingDecisions.swift`、`LocalStore.swift`，以及服务端 `perception-service.ts`、`perception.ts`、`device-api-routes.ts`、`client-capabilities.ts`、`Package.swift` 和 CI。
- 工作树里没有 `.agents/reviews`，`git` 也拒绝读取该路径，因此上一轮意见以题面列表为准；每条都重新对照代码核对。

## 上一轮意见核对

- 第 1 条“开启后仍用旧 configuration，采集器马上又被停掉”：成功路径已修好。`turnOn` 在 `setSense` 后先 `refreshServer()` 再 `reconcile`（`SensesModel.swift:144-148`），并有反向用例。但刷新失败时仍会静默不采集，见本轮意见 6。
- 第 2 条“暂停时不停采集器；配置未知也启动”：只修了“配置未知也启动”（`SensesModel.swift:88`）。暂停分支仍是 `break`，见意见 1。
- 第 3 条“字段最小值和枚举候选被丢掉，越界项让整批 mirror 400”：未修，见意见 3。
- 第 4 条“钥匙串服务名改常量且无迁移”：未修，且后果比上一轮描述更重，见意见 2。
- 第 5 条“今天列表只取第一页”：未修，见意见 4。
- 第 6 条“`recordTextCharacters` 标量截断 vs 服务端 UTF-16”：未修，见意见 5。

## 意见

### 1. 高：服务器暂停时采集器继续运行，暂停期间的记录被服务端以 paused 丢弃；上一轮第 2 条只修了一半

- 文件:行：`clients/apple/Sources/HimawariSenses/SensesModel.swift:91-92`、`clients/apple/Sources/HimawariCore/SenseUpload.swift:176`、`packages/platform-node/src/perception-service.ts:485-491`
- 问题：状态为 `.serverPaused` 时 `reconcile` 只是 `break`，不会 `stop` 已在运行的采集器；服务端对暂停区间内的记录返回 `paused`，客户端把它当作已结算并删除。
- 证据（读代码证实）：
  - `SensesModel.swift:91-92`：`case .serverPaused:` / `break`
  - `SenseUpload.swift:176`：`case .senseOff, .paused: report.turnedAway += 1; settled.insert(record.id)`，随后 `records.removeAll { settled.contains($0.id) }`
  - `perception-service.ts:485-491`：暂停区间内 `blocked.set(record.input.id, "paused")`
  - `SenseDetailView.swift:37-40` 还把 `.serverPaused` 当作 `collecting == true`，界面仍显示开着
- 建议：`.serverPaused` 时也 `await service.stop(item)`，或至少不要在客户端静默丢弃 `paused` 结果（保留队列等待恢复）；补一条“暂停后采集器被停止、记录不丢”的反向用例。

### 2. 高：钥匙串服务名从 bundle 派生改成常量且无迁移，已配对用户升级后读不到旧配对，restore 还会清空本地库

- 文件:行：`clients/apple/Sources/HimawariCore/SharedVault.swift:7,33,37`、`clients/apple/Sources/HimawariShell/AppModel.swift:62-65,80-90`、`clients/apple/Sources/HimawariCore/PairingDecisions.swift:14-17`、`clients/apple/Sources/HimawariCore/LocalStore.swift:60-66`
- 问题：基准提交里服务名是 `<bundleIdentifier>.device`，现在是常量 `himawari.device`，没有读取旧名的兼容或迁移。升级后 `presence` 全为 absent，`RestoreDecision` 返回 `.forget`，`forget` 里的 `emptyStore()` 会把 `himawari-device` 目录整体 `retire()`（聊天、发件箱、感知队列等）。
- 证据（读代码证实）：
  - 旧代码（`git show 9dd41fe...:clients/apple/Sources/HimawariShell/AppModel.swift`）：`let service = (bundle.bundleIdentifier ?? "himawari") + ".device"`，随后 `SecureEnclaveKeyStore(service: service + ".keys")`、`KeychainValueStore(service: service)`
  - 新代码 `SharedVault.swift:7`：`public static let service = "himawari.device"`；`:33`、`:37` 用它构造 keys/keychain
  - `AppModel.swift:63-65`：`keys = vault.keys; keychain = vault.keychain`
  - `PairingDecisions.swift:16`：`guard presence.allSatisfy({ $0 == .present }) else { return .forget }`
  - `LocalStore.swift:60-64`：`retire()` 删除目录内全部文件
  - `AppModel.swift:62` 仍只传 `SharedVault(bundle: bundle)`，没有任何旧 service 名回退
- 建议：保留旧名读取回退（记录和两把 Secure Enclave key），成功读取后迁移到新名再删除旧项；或在发布前确认没有旧版本，明确记录该决定。至少不要让 `.forget` 顺带清空本地库。

### 3. 中：mirror 字段的最小值和枚举候选仍被客户端丢掉，一个越界值会让整批 mirror 反复 400

- 文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:107-111`、`clients/apple/Sources/HimawariCore/SenseRecords.swift:66-83`、`clients/apple/Sources/HimawariCore/MirrorSync.swift:31-40`、`clients/apple/Sources/HimawariSenses/SenseSink.swift:61-64`、`packages/platform-node/src/perception-service.ts:659-660`
- 问题：服务端的字段规则带 `minimum` 和 `values`，客户端 `PerceptionFieldRule` 只解 `kind/maximum/optional`，`fit` 对 enum 原样返回、对 number/integer 不校验上下界。任一越界值会让服务端把整个 mirror 请求判为 `mirror_data` 无效；`MirrorSync` 抛错、ledger 不前进，下一次仍重发同一批。
- 证据（读代码证实）：
  - `Handover.swift:107-111`：`PerceptionFieldRule` 仅有 `kind`、`maximum`、`optional`
  - `SenseRecords.swift:71-78`：`case ("enum", .string): return value`，number/integer 只检查 `isFinite`
  - `MirrorSync.swift:34`：`guard let rule = rules[key], let kept = try? SenseRecordBuilder.fit(...) else { continue }`（不合法值被静默保留或丢弃）
  - `SenseSink.swift:64`：`_ = try? await mirror.sync(...)`，整批失败被吞掉
  - `perception-service.ts:659-660`：任一 item 字段返回 null 即 `return invalid("mirror_data")`
  - 服务端规则确实含 `minimum`/`values`：`packages/application/src/ports/perception.ts:43-52, 231-262`
- 建议：让 `PerceptionFieldRule` 真正解码并校验 `minimum`/`values`（或按服务端规则生成 Swift 类型）；在发送前把校验失败的条目剔除并记录，而不是让整批失败；mirror 发送也应按 item 做可重试的错误隔离。

### 4. 中：今天的列表只取第一页，`nextCursor` 被忽略

- 文件:行：`clients/apple/Sources/HimawariSenses/SensesModel.swift:107-118`、`clients/apple/Sources/HimawariSenses/SensesService.swift:108-109`、`clients/apple/Sources/HimawariCore/SensesGateway.swift:102-120`
- 问题：`SensesGateway.day` 支持 `cursor`，服务端也返回 `nextCursor`，但客户端只调用一次，永远拿不到第二页。
- 证据（读代码证实）：
  - `SensesModel.swift:113-114`：`days[item] = .loaded(try await service.day(item))`
  - `SensesService.swift:108-109`：`try await gateway.day(types: item.recordTypes)`（`cursor` 用默认 nil）
  - `SensesGateway.swift:102-120`：`day(types:cursor:)` 和 `Payload` 都有 cursor，但调用端从不传
  - 服务端确实分页：`apps/agent-service/src/production-perception-control.ts:173-196` 返回 `nextCursor: page.nextCursor`
- 建议：`LiveSensesService.day` 或 `SensesModel.loadDay` 循环 `cursor` 直到 `nil`，设置页数上限防止异常服务端；补一条两页拼接的用例。

### 5. 中：`recordTextCharacters` 按 Unicode 标量截断，顶层 `text` 服务端按 UTF-16 长度校验，emoji 文本会被拒

- 文件:行：`clients/apple/Sources/HimawariCore/SenseRecords.swift:46-53`、`clients/apple/Sources/HimawariCore/Handover.swift:5-17`、`packages/platform-node/src/perception-service.ts:394-398`
- 问题：客户端用 `TextBudget.scalarPrefix`（`unicodeScalars.count`）截 `recordTextCharacters`，服务端对顶层 `text` 用 JS `text.length`（UTF-16 码元）。含 emoji 的 32K 文本会超过服务端上限而 400。
- 证据（读代码证实）：
  - `SenseRecords.swift:52`：`TextBudget.scalarPrefix(value, limit: $0)`，`:70` 字段最大长度也走同一函数
  - `Handover.swift:7-17`：`guard text.unicodeScalars.count > limit`
  - `perception-service.ts:396`：`text.length > PERCEPTION_TEXT_MAXIMUM`
  - 注意字段级字符串服务端反而用码点：`perception.ts:287` `[...value].length > rule.maximum`，所以单位不一致只出现在顶层 `text`
- 建议：顶层文本改用 UTF-16 前缀（已有 `MessageSensing.utf16Prefix`），或服务端统一按码点计数；补一条 emoji/代理对边界用例。

### 6. 中低：本次“配置未知不启动”的修复引入不一致——`state()` 仍显示开着，配置稍后到达也不会自动重新 reconcile

- 文件:行：`clients/apple/Sources/HimawariSenses/SensesModel.swift:85-93`、`clients/apple/Sources/HimawariCore/Senses.swift:113`、`clients/apple/Sources/HimawariShell/AppModel.swift:371-387,408-423`
- 问题：`reconcile` 在 `server == nil` 时不启动采集器，但 `SenseStateRule.state` 在 server 为 nil 时仍返回 `.on`；界面因此显示“开着”，实际不采集。更关键的是配置晚到（`retryConfiguration` 成功或 `refreshConfiguration` 重试成功）后，没有任何地方调用 `senses.resume()`/`refresh()`，采集器不会自动启动，直到用户再次进入感知页或 App 前后台切换。
- 证据（读代码证实）：
  - `SensesModel.swift:87-88`：`case .on:` / `if service.server != nil { service.start(item) }`
  - `Senses.swift:113`：`guard let server else { return .on }`
  - `AppModel.swift:371-387`：`retryConfiguration` 成功后只更新 `configuration`、heartbeat、streams，不调 `senses`
  - `AppModel.swift:420-423`：只有 `becameActive()` 才在 `refreshConfiguration()` 后调 `senses?.refresh()`
- 建议：在 `configuration` 成功刷新后触发 `senses?.refresh()`/`resume()`；同时让 `state()` 在配置未知时不要返回 `.on`（或让界面区分“等待配置”），避免开关显示与实际采集不一致。补一条“配置晚到后自动启动”的用例。

### 7. 低：镜像“关掉并删掉”走 `/mirror` 直接删除，不经确认密钥/Face ID，和记录删除路径不一致

- 文件:行：`clients/apple/Sources/HimawariSenses/SensesModel.swift:192-204`、`clients/apple/Sources/HimawariSenses/SensesService.swift:133-136`、`clients/apple/Sources/HimawariCore/MirrorSync.swift:96-101`、`packages/platform-node/src/device-api-routes.ts:80`
- 问题：`turnOffAndClear` 调 `clearMirror` → `MirrorSync.clear` → `transport.mirror`，只带设备签名，没有记录删除使用的 `approvals/challenge` + 确认密钥；不可逆的服务器副本删除只靠一个 UI 对话框。
- 证据（读代码证实）：
  - `SensesModel.swift:199`：`try await service.clearMirror(item)`
  - `MirrorSync.swift:98`：`send(kind: kind, mode: "full", items: [], batchSize: 1)`
  - `device-api-routes.ts:80`：`{ method: "POST", path: "mirror", signed: true }`（不是 confirm-signature 路由）
  - 对比 `SensesGateway.swift:214-230` 的记录删除走 `approvals/challenge` + `confirmSigner`
  - `SenseDetailView.swift:25-34` 只有本地 `confirmationDialog`
- 推测：如果产品要求删除服务器副本必须 Face ID，这里不满足；如果 UI 确认即为设计意图，则需要在文档里写明。建议按设计决定补确认签名或补说明。

## 侧重检查

- 错误路径：`refreshConfiguration` 失败被 `retryConfiguration` 吞掉且不通知调用方；`turnOn` 刷新失败后开关会落在本地 on/实际不采集的不一致（意见 6）。mirror 整批 400 被 `try?` 吞掉，ledger 不前进（意见 3）。
- 不合规范/不可信输入：服务端字段规则里的 `minimum`/`values` 客户端未建模（意见 3）；顶层文本长度单位不一致（意见 5）；`MirrorFields.fit` 对非法可选值既可能静默丢弃也可能原样上送。
- 安全与隐私：钥匙串改名无迁移导致升级丢失配对并清空本地库（意见 2）；暂停期间采集器继续采集、记录被丢弃（意见 1）。
- 资源耗尽：大文本/emoji 触发重复 400；mirror 失败批次每次重发（意见 3、5）。`PerceptionQueue` 对 400 有条目二分删除，但 mirror 没有等价处理。
- 不可撤销操作：记录删除隐藏于能力表（已核对 `ClientCapabilities.swift:113-117` 没有 `perception.records.delete`，`phoneOperations` 返回空，按钮隐藏，作者说法正确）；镜像删除路径见意见 7。
- 文档/说法一致性：作者“状态/今天/设置已在能力表”已核对为真；“所有记录除 track/surroundings 外一直留到删”与服务端 `recordType` 的 `retention` 规则一致；“关掉时删副本”实际只在明确的“关掉并删掉”按钮里发生，普通开关关闭不会删副本；“关掉不需要 Face ID”实际是 `turnOff` 完全不调用 `setSense(false)`，服务端 sense 保持开启。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。本增量只改 iOS 感知状态机和配置刷新，没有触碰系统提示、工具定义、历史消息、遮盖结果，也没有新增发给模型的请求；因此“只在末尾追加、每轮变化值都在最后一条消息”的前提没有被这次改动改变。
2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及。增量没有新增或修改序列化格式；旧的 `MirrorSync.digest` 使用 `sortedKeys`，摘要稳定。未发现增量引入依赖时间或无序集合的字节差异。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 本次新增了 `turnOnStartsTheCollectorOnceTheServerNowAllowsTheSense` 和 `refreshDoesNotStartACollectorBeforeTheServerConfigurationIsKnown`，按逻辑撤掉 `refreshServer()` 或 `server != nil` 守卫后分别会失败。但这些用例在 `HimawariSensesTests`，而 `Package.swift:21-43` 在 Linux 上不编译 UI target，仓库 CI 也只有 Linux（`.github/workflows/ci.yml`），所以 CI 不会运行它们；暂停、分页、UTF-16 三条路径没有任何反向用例。
4. **每个产生/修改的值，使用端都能接受吗？** 新增值核对通过：`SensesService.refreshServer()` 的三个实现（Live/Demo/Recording）都已补齐，`LiveSensesService` 的新 `refreshConfiguration` 参数只有 `AppModel.swift:333-341` 一个构造点且已更新。旧值存在不匹配：服务端 `PerceptionFieldRule` 的 `minimum`/`values` 被客户端解码丢弃（意见 3）；`recordTextCharacters` 的单位是 UTF-16 码元却被客户端当 Unicode 标量（意见 5）；`recordTypes` 的类型名与客户端 `SenseItem.recordTypes` 一致，`mirrorKinds` 的 `calendar_event`/`contact` 也一致，这部分可接受。
