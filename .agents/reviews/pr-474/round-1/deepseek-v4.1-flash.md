本次复核只针对当前 checkout 的代码；对比基准与 head 的 diff 混入了其他分支/主线的脚本和文档差异（例如删掉 `--spend-day`），我从 `git log` 看它们不是这条感知分支的提交，因此没有算作 PR 474 的意见。以下「读代码证实」的意见都附了我读到的原行。

**侧重检查**

- 错误路径：查了 `PerceptionQueue` 的 400/422 折半丢弃、单条 malformed 丢弃、503 保留、限额暂停、`MirrorSync` 失败不推进账本、`turnOn` 的取消/失败分支。
- 不可信输入：查了设备 `/config`、网关 v2 快照、`/mirror`、`/track`、`/perception` 两端字段和校验；`PerceptionFieldRule`、`MirrorFields.fit`、`externalId` 长度。
- 安全：查了 Face ID 确认路径（`setSense(enabled:true)`、保留期、删除）、镜像“删除服务器副本”的确认、剪贴板/健康数据落盘保护、钥匙串分组变化。
- 资源：查了上传队列上限、离线积压、轨迹限额重试、日历时区/主线程枚举。
- 规则和文档：查了 `prompt-prefix` 规则、设计文档第 711/729 行与代码是否一致、三种语言的本地化键是否一致。

### 1. 严重：服务器根本不返回感知记录类型和镜像规则，六项采集在正式环境会静默不记录

文件:行：`clients/apple/Sources/HimawariSenses/SenseSink.swift:32`、`clients/apple/Sources/HimawariSenses/SenseSink.swift:58`、`clients/apple/Sources/HimawariCore/Models.swift:63-70`、`packages/platform-node/src/device-api-routes.ts:281-296`、`clients/apple/Sources/HimawariCore/Handover.swift:210`

问题：客户端把 `perception.recordTypes`、`perception.mirrorKinds`、`perception.recordTextCharacters` 当作 `/config` 下发的内容；但服务器的 `presentDevicePerception` 只返回 `state`、`pausedUntil`、`senses`、`retentionDays`、`usageLimits`。这三个字段全仓库没有生产端（`grep` 只命中客户端和测试）。结果：`SenseSink.record` 第一行直接 `return`，日历/通讯录的 `SenseSink.mirror` 直接 `return`，分享/ Safari 的 `HandoverPlanner` 也因缺 `recordTypes` 抛 `serverOutdated`。只有 `SenseSink.point` 的轨迹点不依赖这些字段，所以位置轨迹可能还能上传，但位置访问记录、健康、照片、剪贴板、日历、通讯录都不会记录。

证据：
```swift
guard let configuration = configuration(), let types = configuration.perception?.recordTypes else { return }
...
let rules = configuration.perception?.mirrorKinds?[kind],
```
```ts
return {
  state: status.state,
  pausedUntil: status.pausedUntil,
  senses: PERCEPTION_SENSES.map((sense) => ({ sense, enabled: status.senses.includes(sense) })),
  retentionDays: service.retentionDays(settings),
  usageLimits: usage.limits.map(...),
};
```
文档也不一致：`docs/execution/specs/2026-11-11-apple-device-body-design.md:711` 说“服务器按清单校验；Swift 由清单生成”，`:729` 说镜像种类设备上报、服务器校验；代码既没有生成清单，也没有让 `/config` 下发清单。

建议：让 `/config` 从 `PERCEPTION_RECORD_TYPES`、`DEVICE_MIRROR_KINDS`、`PERCEPTION_TEXT_MAXIMUM` 生成并下发这些字段，或按设计文档在 Swift 侧由清单生成；并补一条“真实 `/config` 响应 → 客户端解码 → 六种记录/两种镜像都能构造”的契约测试。现有 `SensesTests` 手工塞了这些字段，所以测试全绿也发现不了。

### 2. 高：刷新只启动采集器，不停止已经不该采集的项，权限被撤销后仍可能继续采集

文件:行：`clients/apple/Sources/HimawariSenses/SensesModel.swift:69-85`、`clients/apple/Sources/HimawariSenses/SensesService.swift:88-98`

问题：`refresh()` 只调用 `resume()`；`resume()` 只对 `collects(state)` 的项调用 `start`，没有任何 `stop`。如果用户在系统设置里撤销位置/相册/健康/通讯录权限，或服务器把某项感知关掉，`becameActive()` 后 `refresh()` 把状态算成 `systemDenied`/`off`，但原来的 `CLLocationManager`、照片观察者、健康查询、剪贴板观察者仍然在跑。`LiveSensesService.stop` 只由 `turnOff`/`suspend` 调用。

证据：
```swift
public func resume() {
    for item in items where SenseStateRule.collects(state(item)) {
        service.start(item)
    }
}
```
```swift
public func stop(_ item: SenseItem) async {
    collectors[item]?.stop()
    running.remove(item)
    await sink.discard(item)
}
```
建议：`refresh()` 或 `resume()` 对“当前不采集但仍在 `running`”的项执行 `stop`（可拆成不丢队列的 `stopCollector` 和显式清队列两种），并加“撤销权限后不再采集”的测试。

### 3. 高：开启时无条件启动采集器，服务器暂停/配置未知/不支持时记录会被当成 `sense_off`/`paused` 永久丢弃

文件:行：`clients/apple/Sources/HimawariSenses/SensesModel.swift:121-138`、`clients/apple/Sources/HimawariCore/SenseUpload.swift:173-181`

问题：`turnOn` 只有在 `server != nil && !server.allows(item)` 时才开服务器感知；如果服务器处于 `paused`、配置还没加载、或 `supports` 为假，它会直接 `on = true` 并 `service.start`。队列随后把服务器返回的 `.senseOff`、`.paused` 当作已结算，从本地删除；这些记录既没进服务器，也不会再重试。用户看到的是“开着”，实际没有记录。

证据：
```swift
if let sense = item.serverSense, let server = service.server, !server.allows(item) {
    ...
}
update(item) { $0.on = true }
service.start(item)
```
```swift
case .senseOff, .paused: report.turnedAway += 1; settled.insert(record.id)
...
records.removeAll { settled.contains($0.id) }
```
建议：开启并 `reloadStatus()` 后，只有 `SenseStateRule.collects(state(item))` 才 `start`；`server == nil` 时提示并不要启动；服务器 `paused`/不支持时不要显示“开着”或先解除暂停。

### 4. 中：关掉日历/通讯录开关并不会删除服务器副本，和“关掉时要删服务器上的副本”说法不一致

文件:行：`clients/apple/Sources/HimawariSenses/SensesModel.swift:142-145`、`clients/apple/Sources/HimawariSenses/SensesModel.swift:182-194`、`clients/apple/Sources/HimawariSenses/SenseDetailView.swift:25-34`

问题：`turnOff` 只把本地开关置关并 `stop`，不会调用 `clearMirror`。真正删除服务器副本的 `turnOffAndClear` 只由单独的“Turn off and delete ... on the server”危险按钮的确认框触发。因此“关掉镜像”本身不删除服务器副本；如果验收语义是“关掉就要删副本并确认”，当前代码没有实现。按钮和确认框本身存在，文案也写了会删。

证据：
```swift
public func turnOff(_ item: SenseItem) async {
    update(item) { $0.on = false }
    await service.stop(item)
}
```
```swift
public func turnOffAndClear(_ item: SenseItem) async {
    ...
    try await service.clearMirror(item)
}
```
```swift
Button(confirmButton, role: .destructive) {
    Task {
        if item.isMirror { await model.turnOffAndClear(item) } else { await model.deleteAll(item) }
    }
}
```
建议：明确产品语义。若关开关就要删副本，则镜像项关闭时弹出确认并调用 `turnOffAndClear`；若保留“关闭只停止同步、另设删除按钮”，就改作者的说明和界面文案。加一条“关闭镜像后服务器计数为 0”的测试。

### 5. 中：上传队列无上限，文本上限实际为 nil，离线和超大剪贴板会导致无限积压或被 400 后静默删除

文件:行：`clients/apple/Sources/HimawariCore/SenseUpload.swift:127-137`、`clients/apple/Sources/HimawariCore/SenseUpload.swift:166-199`、`clients/apple/Sources/HimawariCore/SenseRecords.swift:52`、`packages/platform-node/src/perception-service.ts:396`

问题：`PerceptionQueue.add` 对记录和轨迹点都没有条数/字节/年龄上限，离线时文件会一直增长。`recordTextCharacters` 在当前 `/config` 中不存在，`textLimit` 永远为 nil，剪贴板或健康文本不会在本地截断；服务器只接受 32768 个 UTF-16 单元，超过就 400，队列折半隔离后把单条当 `malformed` 丢弃。用户看不到丢弃提示。

证据：
```swift
public func add(_ upload: PerceptionRecordUpload) throws {
    guard !records.contains(where: { $0.id == upload.id }) else { return }
    records.append(upload)
    try save()
}
public func add(_ point: TrackPointUpload) throws {
    guard !points.contains(where: { $0.key == point.key }) else { return }
    points.append(point)
    try save()
}
```
```swift
text = trimmed.map { value in textLimit.map { TextBudget.scalarPrefix(value, limit: $0) } ?? value }
```
```ts
if (text !== undefined && (typeof text !== "string" || text.length === 0 || text.length > PERCEPTION_TEXT_MAXIMUM))
```
另：`flushTrack` 遇到 `limitReached > 0` 只设置报告标志并返回，不写暂停标记，新的轨迹点每次触发 flush 都会重试同一批（`SenseUpload.swift:220-223`）。

建议：客户端固定按服务器上限（32 KiB，并注意服务端按 UTF-16 计）截断文本；给队列加最大条数/最大字节/最老记录保留策略；轨迹限额也写暂停标记；把 `malformed`/丢弃数暴露到界面或日志。

### 6. 中：客户端丢掉字段规则的 `minimum`/枚举候选，镜像里一项越界会让整批永远失败

文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:107-111`、`clients/apple/Sources/HimawariCore/SenseRecords.swift:66-83`、`clients/apple/Sources/HimawariCore/MirrorSync.swift:61-64`、`packages/platform-node/src/perception-service.ts:290-303`

问题：`PerceptionFieldRule` 只有 `kind`、`maximum`、`optional`，没有服务器规则里的 `minimum` 和枚举 `values`；`SenseRecordBuilder.fit` 对 `integer`/`number` 只查有限性，对 `enum` 直接放行。当前多数生产值来自固定枚举，但边界值会出问题：例如日历 `attendeeCount` 服务器上限 10000、位置精度上限 100000；一旦越界，服务器 `/mirror` 整批 400，`SenseSink.mirror` 用 `try?` 吞掉，`MirrorSync` 不推进账本，之后每次都重试同一批。`externalId` 用 Swift 的 `String.prefix(256)`（字符簇），服务器按 UTF-16 长度 256；非 ASCII 编号也可能超过服务器限制。

证据：
```swift
public struct PerceptionFieldRule: Codable, Sendable, Equatable {
    public let kind: String
    public let maximum: Int?
    public let optional: Bool?
}
```
```swift
case ("enum", .string):
    return value
case let ("integer", .number(number)):
    guard number.isFinite else { throw SenseRecordError.fieldInvalid(key) }
    return .number(number.rounded())
```
```ts
case "integer":
  if (!Number.isSafeInteger(value)) return null;
  if ((value as number) < rule.minimum || (value as number) > rule.maximum) return null;
case "enum":
  if (typeof value !== "string" || !rule.values.includes(value)) return null;
```
建议：把 `minimum` 和 `values` 解码进来并在 `fit` 中校验；镜像项逐条隔离，别让一项坏数据拖死整批；`externalId` 按 UTF-16 截断。补边界测试（attendeeCount、精度、非 ASCII 外部编号）。

### 7. 中：钥匙串服务名从 bundle 改成常量且没有迁移，已有安装升级后会读不到旧配对

文件:行：`clients/apple/Sources/HimawariShell/AppModel.swift:62-65`、`clients/apple/Sources/HimawariCore/SharedVault.swift:7`

问题：旧代码用 `(bundle.bundleIdentifier ?? "himawari") + ".device"` 作为 keychain service，新代码用固定 `"himawari.device"`，并加了 access group。当前没有任何读取旧 service 或迁移旧配对记录/密钥的代码。影响取决于此前是否已有真实安装：如果有，升级后 `record` 读不到，会显示未配对，需要重新配对。

证据：
```swift
public static let service = "himawari.device"
```
```swift
let vault = SharedVault(bundle: bundle)
self.vault = vault
keys = vault.keys
keychain = vault.keychain
```
建议：迁移时先读旧 service（以及默认 access group），查到后复制到新的 group 和 service，再删除旧项；加一条升级路径测试。若产品尚未发布，至少在 PR 说明中写明这是有意的破坏性变更。

### 8. 低：今天的列表只取第一页，忽略 `nextCursor`，超过服务器页大小时无提示地少显示

文件:行：`clients/apple/Sources/HimawariSenses/SensesGateway.swift:104-105`、`clients/apple/Sources/HimawariSenses/SensesModel.swift:98-109`、`clients/apple/Sources/HimawariCore/SensesGateway.swift:56`

问题：`day(types:)` 只发 `types`，不传 `cursor`；`PerceptionDaySnapshot.nextCursor` 从未使用。服务器按 `listPageRows`（默认 100）分页，超过后界面只显示第一页，`total` 仍显示更大的数字，用户会认为记录丢了。

证据：
```swift
public func day(_ item: SenseItem) async throws -> PerceptionDaySnapshot {
    try await gateway.day(types: item.recordTypes)
}
```
```swift
public let nextCursor: String?
```
建议：要么循环取完，要么显示“还有更多”并加载下一页；至少按 `total` 和已显示条数给提示。

**推测与未核实**

- 推测：第 7 条的“升级后丢配对”取决于此前是否已有用户安装；代码事实是服务名变了且没有迁移，影响未在设备上验证。
- 推测：`recordTextCharacters` 也许本意是“预览字符数”而不是上传上限；如果服务器将来下发的值很小，客户端会把要存的内容截得过短。当前字段不存在，无法确认设计意图。
- 未核实：作者说 Linux 上 `HimawariCore` 192 个测试通过、Mac 上界面编译并截图验收。仓库里确实有 `19-senses-1` 到 `19-senses-5` 的浅色/深色 PNG，但我没有运行测试，也没有查看截图内容。
- 未核实：服务器是否会在未来的抽取/上下文里把这些感知记录送进模型请求；本 diff 没有改提示词组装代码，但配套的抽取功能不在这次 diff 中。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 本 diff 没有修改 `packages/prompt-catalog`、服务端系统提示、工具定义、历史组装或出口遮盖代码（`git diff` 只涉及 Apple 客户端、脚本和文档）。新增的是设备采集/上传和界面；分享入口产生的是新的 thread/message，属于末尾追加。因此按本 diff 看，发给模型的内容仍然只追加，每轮会变的值仍应只放在最后一条消息里。服务器将来是否把这些感知记录拼进上下文不在本次 diff 中，未核实。

2. **同一段文字在不同请求里会不会变成不同字节？** 对模型请求：本 diff 没有生成提示词文本，遮盖规则也未变，所以不会。对上传数据：`MirrorSync` 用 `JSONEncoder` 的 `.sortedKeys` 计算摘要并按 `externalId` 排序，镜像是确定的；但 `PerceptionRecordBuilder.newId()` 是随机的，`MirrorSync.nextVersion` 用当前毫秒，同一段剪贴板/记录重复采集会得到不同 ID/版本字节。这些不是提示词字节；如果以后把它们拼进模型请求，必须按设计文档第 654 行的固定排序规则来。

3. **有没有对应的自动检查，反向用例真会失败吗？** 有 `clients/apple/Tests/HimawariCoreTests/SensesTests.swift` 和 `HimawariSensesTests/SenseLinesTests.swift`。反向用例确实覆盖了：服务器 400 时折半隔离并丢弃、503 保留待重试、缺字段抛错、镜像缺必填项返回 nil、开启/删除要求确认签名、开关/权限/服务器三方状态。**但**这些测试手工注入了 `recordTypes`/`mirrorKinds`，没有用真实 `/config` 形状覆盖，所以第 1 条的生产端缺口不会被测出来；也没有覆盖“权限撤销后停止采集”“服务器暂停时不要启动”“关闭镜像会清空服务器副本”。192 个测试通过和 Mac 编译未核实。

4. **每个产生/修改的值，使用它的一端都能接受吗？** 逐项核对如下：
   - `/config` 的 `recordTypes`、`mirrorKinds`、`recordTextCharacters`：客户端必需，服务器 `presentDevicePerception` 不产生——两端不匹配（第 1 条）。
   - 能力表：`perception.status.read`、`perception.day.read`、`perception.settings.change` 在 `ClientCapabilities.swift:113-117` 和 `client-capabilities.ts:152-156` 都有，生产处理也在；`perception.records.delete` 确实不在能力表，所以按钮隐藏，和作者说法一致。但同一个类型也不在 `contracts-v2.ts` 和 `production-perception-control.ts` 的已实现操作里；如果以后只在能力表加上它，网关仍会 404/未安装。现有测试只断言 404 → `notInstalled`，没有成功路径。
   - 记录类型和证据字段：`location.visit/location.region/health.sample/motion.activity/photo.asset/photo.screenshot/clipboard.item` 与服务端 `PERCEPTION_RECORD_TYPES` 的名称和字段一致；`system_api`、`device_sensor` 在 `PERCEPTION_CAPTURE_SOURCES` 中；`perception:` 加 24/32 位 base64 URL 满足服务器正则。
   - 轨迹：`occurredAt`、`latitude`、`longitude`、`accuracyMeters`、`speedMetersPerSecond` 与服务器 `POINT_KEYS` 一致；负数精度/速度被省略，服务器接受 `null`。
   - 镜像：`calendar_event`、`contact` 两种 kind 和字段名与 `DEVICE_MIRROR_KINDS` 一致；`syncId` 18 字节 base64 URL 满足 16-64 位正则；`version` 是安全整数范围内的毫秒值；`MirrorItemUpload` 的 `deleted`/`data` 编码满足服务器“有 data 就没有 deleted”的规则。
   - 保留期：客户端 `location` 映射 `track`，服务器 `PERCEPTION_RETENTION_KEYS` 有 `track`/`surroundings`；服务器默认 90/30 天，作者说法成立。
   - 本地化：三份 `Localizable.strings` 都是 136 行，键名逐行一致；作者说法成立。
   - 字段规则：服务器规则的 `minimum`、`values` 客户端不接收也不校验（第 6 条）；`recordTextCharacters` 缺失导致文本上限没执行（第 5 条）。
   - `PerceptionDeleteResult`：客户端有 `deleted.records/trackPoints/media`，但服务端当前没有该网关类型的契约或处理器，属于“未来值”，现在无法核对成功路径。
