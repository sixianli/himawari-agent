## 本轮范围与上一轮意见核对

本轮只看 `3ed8c4bd..58e0bdf4` 的增量（4 个业务文件：`SensesModel.swift`、`SensesReconcileTests.swift`、`device-api-routes.ts`、`usage-limits.test.ts`），并沿证据追到它们的直接调用链和消费端。

- 上一轮 1（服务器不下发记录类型/镜像规则）：**已改好**，`/config` 现在返回 `recordTypes`、`mirrorKinds`、`recordTextCharacters`，且有集成测试。
- 上一轮 2（刷新不停止不该采集的项）：**部分改好**。`off`、`systemDenied`、`serverUnsupported` 会停；`serverPaused` 仍不停（见意见 2）。同时新增了 `turnOn` 的回归（见意见 1）。
- 上一轮 3（暂停/配置未知时仍采集，记录被丢弃）：**部分改好**，`turnOn` 不再无条件启动，但“已运行后转为暂停”和“配置未知”两条路仍会采集/丢记录（见意见 2）。
- 上一轮 6（`minimum`/枚举候选丢失）、7（钥匙串服务名无迁移）、8（忽略 `nextCursor`）：**本增量完全没碰，仍然存在**，作者“已修改”的说法与代码不符（见意见 3、4、5）。

未重读：PR 其余部分（Info.plist/entitlements、各采集器的系统 API 细节、分享/浏览器扩展等）增量未触及，本轮未复核。

## 发现

### 1. 高：开启服务器端感知后仍用旧 configuration 计算状态，刚打开的采集器马上又被停掉

文件: `clients/apple/Sources/HimawariSenses/SensesModel.swift:130`（另见 40-47、85-93、146-147）、`clients/apple/Sources/HimawariSenses/SensesService.swift:66`、`clients/apple/Sources/HimawariShell/AppModel.swift:355-360`

问题：`turnOn` 先通过 `setSense` 打开了服务器那项感知，再调用 `reconcile`；但 `reconcile` 里的 `state(item)` 用的是 `service.server`，它读的是 `AppModel.configuration`，而 `turnOn` 只更新了 `status`，没有刷新 `configuration`。于是 `SenseStateRule.state` 在 114 行仍认为服务器不允许，返回 `.off`，`reconcile` 随即 `service.stop(item)`。结果是用户通过 Face ID 打开了一项，开关状态写成了 on，但采集器没启动（甚至把原队列丢掉），界面也可能马上显示回 off。这是把 `service.start(item)` 改为 `await reconcile(item)` 带来的回归。

读代码证实的：

```swift
// SensesModel.swift:130-147
if let sense = item.serverSense, let server = service.server, !server.allows(item) {
    ...
    try await service.setSense(sense, enabled: true, ...)
    ...
    await reloadStatus()
}
update(item) { $0.on = true }
await reconcile(item)
```

```swift
// SensesModel.swift:85-93
switch state(item) {
case .on:
    service.start(item)
case .off, .systemDenied, .serverUnsupported:
    await service.stop(item)
```

```swift
// SensesService.swift:66
public var server: SenseServerView? { SenseServerView.from(configuration()) }
```

`reloadStatus()` 只写 `self.status`（103-105 行），`AppModel.refreshConfiguration()` 才是 `configuration` 的唯一常规更新点（359-360、375-376 行），`turnOn` 不会调用它。

推测：只要用户开启的项原本在服务器端是关的（位置、健康/运动、照片、剪贴板都会走这条），就会命中；下一次 App 重新激活触发 `becameActive` 后才会恢复采集。

建议：`setSense` 成功后先让 `configuration` 刷新（或让 `SenseStateRule` 能使用刚拿到的 `status` 快照），再 `reconcile`；并补一条“服务器初始不允许，`setSense` 成功后必须 start”的用例。

### 2. 高：服务器暂停时不停止已运行的采集器，暂停期间的记录被服务端以 paused 拒收；配置未知时也会启动采集器

文件: `clients/apple/Sources/HimawariSenses/SensesModel.swift:91-92`、`clients/apple/Sources/HimawariCore/Senses.swift:113-116`、`clients/apple/Sources/HimawariSenses/SenseSink.swift:31-45、80-92`、`clients/apple/Sources/HimawariCore/SenseUpload.swift:176-177`、`packages/platform-node/src/perception-service.ts:483-491`

问题：`reconcile` 对 `.serverPaused` 只 `break`，不 `stop`。如果采集器此前已在运行，服务器转入暂停后它继续采集；每次记录都会在 2 秒后触发 flush，服务端把发生在暂停窗口内的记录标成 `paused`，客户端 `SenseUpload` 又把这些结果当作已结算而从队列删掉——暂停期间仍在采集且记录永久丢失。这也不符合“暂停感知”的隐私语义。另有同类残留：`server` 为 nil（配置未知）时 `SenseStateRule` 返回 `.on`，会启动采集器，而 `SenseSink.record` 因拿不到 `recordTypes` 直接静默返回（32 行），期间记录全部丢失。

读代码证实的：

```swift
// SensesModel.swift:91-92
case .serverPaused:
    break
```

```swift
// Senses.swift:113-116
guard let server else { return .on }
if !server.allows(item) { return .off }
if server.state == "paused" { return .serverPaused }
```

```swift
// SenseUpload.swift:176-177
case .senseOff, .paused: report.turnedAway += 1; settled.insert(record.id)
```

```ts
// perception-service.ts:483-491
if (settings.disabledSenses.includes(record.sense)) blocked.set(record.input.id, "sense_off");
else if (pausedFrom !== null && pausedUntil !== null &&
  record.input.occurredAtMs >= pausedFrom && record.input.occurredAtMs < pausedUntil)
  blocked.set(record.input.id, "paused");
```

建议：`.serverPaused` 应停止采集但不要像 `stop` 那样丢弃暂停前已排队的记录（需要独立的“暂停采集、保留队列”路径）；配置未知时不要返回 `.on`。补“已运行→服务器暂停”和“配置未知”两条反向用例。

### 3. 中：上一轮的字段最小值和枚举候选仍然被客户端丢掉，一个越界项会让整批 mirror 永远 400

文件: `clients/apple/Sources/HimawariCore/Handover.swift:107-111`、`clients/apple/Sources/HimawariCore/SenseRecords.swift:66-84`、`clients/apple/Sources/HimawariCore/MirrorSync.swift:103-110`

问题：服务端新增下发的规则里包含 `minimum` 和 `values`，但客户端 `PerceptionFieldRule` 只解出 `kind`、`maximum`、`optional`；`SenseRecordBuilder.fit` 对 `enum` 只要求是字符串，对整数/数字不检查最小值和最大值。于是客户端会构造出服务端必然拒绝的 evidence。记录上传还会二分拆分、最终丢掉坏记录，但 `MirrorSync.send` 对 400/422 不拆分也不隔离，整个 mirror 同步会永久失败。上一轮已报，本增量没有修。

读代码证实的：

```swift
// Handover.swift:107-111
public struct PerceptionFieldRule: Codable, Sendable, Equatable {
    public let kind: String
    public let maximum: Int?
    public let optional: Bool?
}
```

```swift
// SenseRecords.swift:71-75
case ("enum", .string):
    return value
case let ("integer", .number(number)):
    guard number.isFinite else { throw SenseRecordError.fieldInvalid(key) }
    return .number(number.rounded())
```

```ts
// perception-service.ts:301-303
case "enum":
  if (typeof value !== "string" || !rule.values.includes(value)) return null;
```

建议：在 `PerceptionFieldRule` 中保留 `minimum`/`values` 并在客户端校验；镜像批次遇到 400/422 时也做拆分或单项隔离，避免一条坏项拖死整批。

### 4. 中：钥匙串服务名从 bundle 派生改成常量且没有迁移，升级后会读不到旧配对

文件: `clients/apple/Sources/HimawariCore/SharedVault.swift:7、33、37`

问题：旧代码用 `bundle.bundleIdentifier + ".device"` 作为 keychain service；新代码固定为 `"himawari.device"`（密钥再拼 `.keys`）。工程里的 bundle id 是 `win.siyi.himawari` / `win.siyi.himawari.mac`，所以旧安装的配对记录和设备密钥都存在 `win.siyi.himawari.device` 下，升级后读的是 `himawari.device`，现有配对会丢失，需要重新配对。代码里没有旧 service 回退或迁移。上一轮已报，本增量未改。

读代码证实的：

```swift
// SharedVault.swift:7
public static let service = "himawari.device"
// 33、37
SecureEnclaveKeyStore(service: Self.service + ".keys", ...)
KeychainValueStore(service: Self.service, ...)
```

旧代码（`git show 9dd41fe...:clients/apple/Sources/HimawariShell/AppModel.swift`）：

```swift
let service = (bundle.bundleIdentifier ?? "himawari") + ".device"
keys = SecureEnclaveKeyStore(service: service + ".keys")
keychain = KeychainValueStore(service: service)
```

建议：先用旧 service 名（从 bundle id 派生，必要时兼容 Mac bundle）读取并迁移到新 service，再删除旧项；补一条从旧 service 迁移的测试。

### 5. 中：今天的列表仍只取第一页，`nextCursor` 被忽略

文件: `clients/apple/Sources/HimawariSenses/SensesModel.swift:107-118`、`clients/apple/Sources/HimawariSenses/SensesService.swift:104-106`、`clients/apple/Sources/HimawariCore/SensesGateway.swift:102-119`、`clients/apple/Sources/HimawariSenses/SenseDetailView.swift:75、87`

问题：`LiveSensesService.day` 只调用一次 `gateway.day(types:)`，没有传 `cursor`，`SensesModel.loadDay` 也不循环；`PerceptionDaySnapshot.nextCursor` 除定义和测试外没有任何使用。服务器默认 `listPageRows = 100`，超过一页时界面只显示第一页，但标题仍显示 `total`，用户会看到“今天 300 条”却只列出 100 条且没有任何提示。上一轮已报，本增量未改。

读代码证实的：

```swift
// SensesService.swift:104-106
public func day(_ item: SenseItem) async throws -> PerceptionDaySnapshot {
    try await gateway.day(types: item.recordTypes)
}
```

```swift
// SensesModel.swift:112-117
if days[item] == nil { days[item] = .loading }
do { days[item] = .loaded(try await service.day(item)) } catch { days[item] = .failed }
```

建议：按 `nextCursor` 循环拉全，或明确显示“仅显示前 N 条/加载更多”。

### 6. 中：新下发的 `recordTextCharacters` 按 Unicode 标量截断，服务端按 UTF-16 长度校验，emoji 文本会被拒

文件: `clients/apple/Sources/HimawariCore/SenseRecords.swift:52`、`clients/apple/Sources/HimawariCore/Handover.swift:6-18`、`packages/platform-node/src/perception-service.ts:394-397`

问题：本增量新增的 `recordTextCharacters` 被客户端当作 `TextBudget.scalarPrefix` 的上限；`scalarPrefix` 按 Unicode scalar 数量截断。但服务端对记录 `text` 用的是 JavaScript 的 `text.length`，按 UTF-16 code unit 计数。比如 20000 个 emoji 只有 20000 个 scalar（不超过 32768），却是 40000 个 UTF-16 单元，服务端返回 400；客户端会把它当 malformed 最终丢掉。这是新值两端计数口径不一致。

读代码证实的：

```swift
// Handover.swift:7-8
public static func scalarPrefix(_ text: String, limit: Int) -> String {
    guard text.unicodeScalars.count > limit else { return text }
```

```swift
// SenseRecords.swift:52
text = trimmed.map { value in textLimit.map { TextBudget.scalarPrefix(value, limit: $0) } ?? value }
```

```ts
// perception-service.ts:394-397
if (text !== undefined &&
  (typeof text !== "string" || text.length === 0 || text.length > PERCEPTION_TEXT_MAXIMUM))
  return invalid("text");
```

建议：两端统一按 Unicode 字符计数（服务端改成 `[...text].length`），或客户端按 `text.utf16.count` 截断；补 emoji 长文本反向用例。

### 7. 低：刷新时对每个非 on 项都 `stop`→`discard`，开关状态读失败可能清空待上传队列（部分为推测）

文件: `clients/apple/Sources/HimawariSenses/SensesModel.swift:85-93`、`clients/apple/Sources/HimawariCore/Senses.swift:184-188`、`clients/apple/Sources/HimawariSenses/SensesService.swift:94-98`

问题：`reconcile` 对所有 `.off` 项调用 `service.stop`，而 `stop` 会 `sink.discard(item)`，把该类型待上传记录（位置还包括全部待上传轨迹点）删掉，且不可恢复。`SenseSwitches` 在存储读失败或解码失败时返回空字典，`state()` 就把所有项当作 off；此时一次 `refresh()` 会清掉仍可能合法的待上传记录。

读代码证实的：

```swift
// Senses.swift:184-188
guard let data = store.read(Self.name),
      let raw = try? JSONDecoder().decode([String: SenseSwitchState].self, from: data)
else { return [:] }
```

```swift
// SensesService.swift:94-98
public func stop(_ item: SenseItem) async {
    collectors[item]?.stop()
    running.remove(item)
    await sink.discard(item)
}
```

推测：只有开关存储损坏/读失败时才触发；正常路径下用户关掉一项本来就该丢弃队列。

建议：把“停止采集”和“丢弃队列”分开；刷新时的 reconcile 不要在状态来源不可信（存储读取失败）时执行破坏性的 discard。

## 侧重检查

- **错误路径/不可信输入**：核对了 `turnOn` 的 Face ID 取消、`status` 为空、服务器不允许、服务器暂停、配置未知等分支；发现 `reconcile` 错误依赖旧 `configuration`（意见 1）、`serverPaused` 不停（意见 2）。服务端下发的 `recordTypes`/`mirrorKinds` 属于外部输入，客户端只保留部分规则字段（意见 3），且 `recordTextCharacters` 两端计数口径不同（意见 6）。
- **安全/隐私**：`serverPaused` 期间仍采集是隐私问题（意见 2）；钥匙串 service 名变化会让旧配对失效（意见 4，属认证状态问题）。新增下发的只是字段规则，不是秘密，未发现新的越权读取。
- **资源耗尽/不可撤销操作**：`MirrorSync.send` 对单个坏项会让整批永久失败（意见 3）；`refresh` 的 `stop→discard` 会不可撤销地删队列（意见 7）。
- **规则/文档与代码一致性**：作者说上一轮会出错的意见都已修改，但 6、7、8 对应代码未变；“`perception.records.delete` 不在能力表所以隐藏删除”与代码一致（`ClientCapabilities.swift` 只有 status/day/settings，`AppModel.phoneOperations` 按能力表过滤）。`prompt-prefix.md` 只约束发给模型的内容，本增量没有触及那部分。
- **Info.plist/entitlements**：本增量未修改，未重新验收；只确认新增的 `SharedVault` 读取 `HimawariKeychainGroup`，其迁移缺失已列为意见 4。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不涉及。本增量改的是设备 `/config` 响应、iOS 本地状态机和测试，没有改系统提示、工具定义、历史消息、遮盖或任何模型请求组装；因此“只在末尾追加、每轮变化的值放最后一条消息”的规则没有被这次增量触碰。PR 其余部分是否把感知内容放进模型请求、是否放在末尾，未在本次增量中核实。

**2. 同一段文字会不会在不同请求里变成不同字节？**
对本增量新增的配置值不会：`PERCEPTION_RECORD_TYPES`、`DEVICE_MIRROR_KINDS` 都是固定字面量，`Object.entries`/`Object.fromEntries` 保持插入顺序，没有时间字段或无序集合。记录上传里的 `SenseRecordBuilder.newId()` 是随机的、`occurredAt` 带时间，但那是上传记录而不是模型请求，且队列会保留同一个 id 重试。未发现依赖前后文的遮盖变化。

**3. 有没有自动检查，反向用例真的会失败吗？**
有两类新检查：服务器集成测试断言 `/config` 下发 `recordTypes`/`mirrorKinds`/`recordTextCharacters`（旧代码下 `recordTypes` 为 undefined，会失败）；`SensesReconcileTests` 断言刷新会停止被撤销权限的项、不会启动已关闭的项（旧 `resume` 只 start 不 stop，两条断言都会失败）。但覆盖不足：
- `.serverPaused` 已运行→暂停、配置未知、`turnOn` 时服务器不允许后 `setSense` 成功、emoji 长文本、钥匙串迁移、分页都无反向用例；
- 新增的 `SensesReconcileTests` 在 `HimawariSensesTests` 目标里，而 `Package.swift` 在 Linux 上把 `interfaceTargets = []`，所以作者说的“Linux 上 192 个测试通过”不包含这两条用例；这些测试是否实际在 Mac 上跑过，材料未说明。

**4. 新增/修改的每个值，直接使用端都能接受吗？**
按 I-73 逐个核对两端：
- `recordTextCharacters`：产生于 `device-api-routes.ts:285`；使用于 `Models.swift:64`、`SenseSink.swift:38`、`Handover.swift:211`。类型接受，但计数口径与服务端不一致（意见 6），**不能完全接受**。
- `recordTypes`：产生于 `device-api-routes.ts:286-291`；使用于 `Models.swift:65`、`SenseSink.swift:32`、`Handover.swift:210`、`Senses.swift:84`。形状与 `PerceptionTypeRule` 匹配；但 `minimum`/`values` 在客户端被丢弃（意见 3），**部分不可接受**。
- `mirrorKinds`：产生于 `device-api-routes.ts:292`；使用于 `Models.swift:70`、`SenseSink.swift:58`、`MirrorSync.swift:31`。当前四种 mirror 规则没有 enum，形状可接受；同样丢失 `minimum`（意见 3），未来加 enum 会静默失效。
- `resume()` 改成 `async`：`git grep` 只找到 `SensesModel.refresh()` 一个调用点，接口改动可接受。
- 测试导入的 `PERCEPTION_RECORD_TYPES`/`DEVICE_MIRROR_KINDS`/`PERCEPTION_TEXT_MAXIMUM`：通过 `@himawari-agent/application` 的 ports 导出，导入路径可接受。
