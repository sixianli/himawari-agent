## 读代码证实的问题

### 1. 高：位置旁的删除入口依赖的 `perception.records.delete` 不在能力表，也不在服务端命令表，真机上不会出现

文件:行：`clients/apple/Sources/HimawariSenses/SensesService.swift:4-6`、`clients/apple/Sources/HimawariShell/AppModel.swift:407,555-559`、`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:118-122`、`packages/gateway-contracts/src/client-capabilities.ts:157-161`、`apps/agent-service/src/production-perception-control.ts:28-34,224-226`、`clients/apple/Sources/HimawariSenses/SenseDetailView.swift:168-176`、`clients/apple/Sources/HimawariSenses/DemoSenses.swift:19`

问题：新增的“到过的地方”删除按钮只在 `model.canDelete` 为真时显示，而 `canDelete` 来自 `service.operations`；`operations` 又被 `phoneOperations` 用 `ClientCapabilities.find` 过滤。当前能力表没有 `perception.records.delete`，`find` 返回 `nil`，这个 id 会被过滤掉，所以生产环境 `canDelete` 恒为假，位置行旁的删除入口和另外三项非镜像的删除入口都不会出现。服务端 `PRODUCTION_PERCEPTION_OPERATIONS` 也没有这个命令，`execute` 的 `default` 直接抛 `PERCEPTION_OPERATION_NOT_INSTALLED`。镜像的“删服务器副本”走 `/mirror`，不受这个 id 影响，仍然可用。

证据：

```swift
// clients/apple/Sources/HimawariSenses/SensesService.swift:4-6
public enum SenseOperation {
    public static let deleteRecords = "perception.records.delete"
}

// clients/apple/Sources/HimawariShell/AppModel.swift:407
operations: Self.phoneOperations([SenseOperation.deleteRecords]),

// clients/apple/Sources/HimawariShell/AppModel.swift:555-559
static func phoneOperations(_ types: [String]) -> Set<String> {
    Set(types.filter { type in
        guard let capability = ClientCapabilities.find(.v2, type) else { return false }
        return capability.tier != .notOnPhone
    })
}

// clients/apple/Sources/HimawariSenses/SensesModel.swift:64
public var canDelete: Bool { service.operations.contains(SenseOperation.deleteRecords) }

// clients/apple/Sources/HimawariSenses/SenseDetailView.swift:168-176
if model.canDelete {
    Button { confirming = true } label: {
        Text(L.text("detail.delete"))
...
```

```ts
// packages/gateway-contracts/src/client-capabilities.ts:157-161
query("v2", "perception.status.read"),
query("v2", "perception.day.read"),
query("v2", "perception.episode.read"),
query("v2", "perception.usage.read"),
change("v2", "perception.settings.change"),
```

```ts
// apps/agent-service/src/production-perception-control.ts:28-34
export const PRODUCTION_PERCEPTION_OPERATIONS = Object.freeze([
  "perception.status.read",
  "perception.day.read",
  "perception.episode.read",
  "perception.usage.read",
  "perception.settings.change",
] as const);
```

另外，演示服务把能力写死为包含该 id，所以 `DemoSensesService` 的 `.location` 详情页会显示删除按钮，截图/演示会看到，但生产不会：

```swift
// clients/apple/Sources/HimawariSenses/DemoSenses.swift:19
public let operations: Set<String> = [SenseOperation.deleteRecords]
// DemoSenses.swift:43-45 详情场景打开 .location
```

建议：先确认这是不是“等服务器支持后再显示”的有意安排。如果是，PR 说明和演示场景要写明，最好在演示里也按真实能力表隐藏，避免截图给出错误结论。如果本意是现在就让用户能删，需要把 `perception.records.delete` 同时补进 `client-capabilities.ts`、服务端 `PRODUCTION_PERCEPTION_OPERATIONS`/命令处理，再重新生成 `ClientCapabilities.swift`，并加一条测试：`SenseOperation` 里的每个 id 都必须在能力表里存在。这个 id 在 PR 474 就已经是客户端单方面使用，本 PR 的位置删除入口继承了这个断点。

### 2. 中：新增测试不在 Linux 测试目标里，且“开关已关但服务器计数为 0”没有会失败的反向用例

文件:行：`clients/apple/Package.swift:21-25,54`、`clients/apple/Tests/HimawariSensesTests/SensesReconcileTests.swift:45-50,99-109`、提交 `a92727d1d` 的 `Fast-mode-checks`

问题：`Package.swift` 在 Linux 上把 `interfaceTargets` 设为空，`HimawariSenses` 和 `HimawariSensesTests` 都不编译；提交说明里只写了 `swift test (HimawariCore, Linux, 359 passed)` 和 `Layer-0-tests: none`，所以这条新测试按提交记录没有在 Linux 上跑过，也没有证据表明在 Mac 上跑过。即使运行，它也测不住 `mirrorCounts > 0` 这一半条件：测试把 `.contacts` 设成已开启，`contacts` 的 `false` 结果可能只是因为开关开着，不是因为计数为 0。

证据：

```swift
// clients/apple/Package.swift:21-25
#if os(Linux)
let interfaceTargets: [Target] = []
let interfaceProducts: [Product] = []
let interfaceDependencies: [Package.Dependency] = []
```

```swift
// clients/apple/Tests/HimawariSensesTests/SensesReconcileTests.swift:45-50
private func makeModel(on item: SenseItem, service: RecordingSensesService) throws -> SensesModel {
    service.server = Self.allowingServer
    let store = MemoryLocalStore()
    try SenseSwitches(store: store).update(item) { $0.on = true }
    return SensesModel(service: service, store: store)
}
```

```swift
// clients/apple/Tests/HimawariSensesTests/SensesReconcileTests.swift:99-109
@Test func theServerCopyCanBeRemovedOnlyWhileTheMirrorIsOffAndHoldsData() async throws {
    let service = RecordingSensesService()
    service.mirrorCounts = [.calendar: 4, .contacts: 0]
    let model = try makeModel(on: .contacts, service: service)
    await model.refresh()
    #expect(model.serverCopyRemovable(.calendar))
    #expect(!model.serverCopyRemovable(.contacts))
    #expect(!model.serverCopyRemovable(.location))
    await model.turnOn(.calendar)
    #expect(!model.serverCopyRemovable(.calendar))
}
```

按这四条断言推演：如果去掉 `mirrorCounts > 0`，只保留 `!on`，四条断言仍然全部通过；如果去掉 `!on`，最后一条会失败。所以“开关条件”有反向覆盖，“计数条件”没有。`item.isMirror` 的守卫也没有真正被覆盖：`.location` 没有镜像计数，去掉守卫后它仍然返回 `false`。

建议：补一个“镜像项已关、计数为 0”的用例（例如不把 `.contacts` 打开，或直接测 `.calendar` 计数 0），再补一个“非镜像项计数大于 0 也必须返回 false”的用例来测 `isMirror` 守卫；另外给 `turnOffAndClear` 在“已关”状态下调用补模型测试，断言会 `stop`、会 `clearMirror`、成功后计数归零、失败时保留原计数并给出 notice。最后在 Mac 上运行 `swift test` 或至少记录一次 UI 编译/快照检查结果。

## 推测的问题

### 3. 低：`serverCopyRemovable` 用持久化的 `on` 判断，而不是界面开关实际显示的 `collecting`，两者在授权被拒等状态下可能分叉

文件:行：`clients/apple/Sources/HimawariSenses/SensesModel.swift:59-62`、`clients/apple/Sources/HimawariSenses/SenseDetailView.swift:45-48`、`clients/apple/Sources/HimawariCore/Senses.swift:107-111`

问题：开关界面显示的是 `collecting`，它来自 `model.state(item)`；而 `serverCopyRemovable` 直接读 `switchStates[item]?.on`。当 `switchStates.on == true` 但 `state(item)` 因授权被拒变成 `.systemDenied` 时，界面开关显示为关，`serverCopyRemovable` 却因为持久化的 `on` 为真返回 `false`，删除入口被隐藏。这个影响是推测：目前 `SenseItemScreen` 在 `.denied` 时显示 `SenseDeniedView`，正常路径进不到详情页；只有授权在详情页打开期间变化、或将来出现别的“显示关但存储为开”的状态时才可能看到。

证据：

```swift
// clients/apple/Sources/HimawariSenses/SensesModel.swift:59-62
public func serverCopyRemovable(_ item: SenseItem) -> Bool {
    guard item.isMirror, !(switchStates[item]?.on ?? false) else { return false }
    return (mirrorCounts[item] ?? 0) > 0
}
```

```swift
// clients/apple/Sources/HimawariSenses/SenseDetailView.swift:45-48
private var collecting: Bool {
    let state = model.state(item)
    return state == .on || state == .serverPaused
}
```

```swift
// clients/apple/Sources/HimawariCore/Senses.swift:107-111
guard switchedOn else { return .off }
switch authorization {
case .denied, .restricted, .unavailable: return .systemDenied
case .notAsked: return .off
case .allowed, .limited: break
}
```

建议：让“开关已关”的判断和界面使用同一个来源，例如用 `state(item) == .off` 或直接复用 `collecting == false`，并补一条“镜像已开 + 授权被拒 + 服务器有数据”的测试，明确期望值。若坚持用持久化 `on`，建议在测试里锁住这个边界。

## 侧重检查

- **开关绑定**：`SenseDetailView.swift:59-66`。镜像项关闭时只设置 `stopping = true`，不写模型；取消后 `collecting` 仍为真，开关保持开着。符合“取消时开关保持开着”。未在 Linux 上编译 SwiftUI，视觉行为未核实。
- **两个 confirmationDialog**：`SenseDetailView.swift:26-42`。`stopping` 只在“镜像项且要关闭”时设置；`confirming` 由镜像 dangerLink 或位置 placesRow 设置。当前页面条件下两者互斥：位置项 `showsDangerLink` 为 false，镜像项 `retentionKey == nil` 不走 placesRow。未发现同一页面同时触发两条删除路径。
- **`serverCopyRemovable` 条件**：`SensesModel.swift:59-62`。镜像 + 持久化开关为关 + `mirrorCounts > 0`。计数来自 `MirrorSync.active`/`MirrorSyncResult.active`，`refresh` 和 `loadDay` 会刷新，`turnOffAndClear` 成功后清零；服务端 `syncMirror` 返回 `active`。测试覆盖了“关 + 有数据”和“开 + 有数据”，没有覆盖“关 + 0”。另外，`MirrorSyncResult.active` 是可选值，服务端没返回时会保留旧计数或保持 `nil`，这是未核实的边界。
- **`turnOffAndClear` 在“已关”状态被单独入口调用**：`SensesModel.swift:197-209`。它会再次写 `on = false`、`stop`、`clearMirror`，成功后把 `mirrorCounts` 设为 0；`clearMirror` 抛错时开关保持关闭、计数保持原值，并显示 `notice`。这条路径没有测试。镜像清理走 `/mirror`，不经过 `perception.records.delete`，所以不受能力表缺失影响。
- **三种语言**：`en.lproj`、`ja.lproj`、`zh-Hans.lproj` 都是 144 行，键集合一致；新增的 `detail.route`、`detail.routeDays`、`detail.places`、`detail.placesKept`、`detail.stopTitle`、`detail.stopBody`、`detail.stopKeep`、`detail.stopDelete` 三种语言都有，`%@`/`%d` 占位符一致。仓库里没有找到自动校验本地化键一致性的脚本或测试。
- **错误路径、不可信输入、安全、资源**：`clearMirror` 的错误被捕获并转成 `notice`；`deleteRecords`/`setRetention` 的 `confirmationCancelled` 和普通错误也有处理。没有新增外部输入、循环或大分配；`detail.stopTitle` 的 `%@` 参数是静态的 `item.name`，`detail.routeDays` 的 `%d` 参数是服务端配置的整数，没有格式串注入。删除服务器副本和删除记录都在确认对话框之后执行，没有发现无确认的不可逆操作。
- **规则、文档和代码一致性**：`prompt-prefix.md` 没有被改，改动也不碰模型请求组装。`.agents/instructions/test-and-production-hosts.md:9` 要求苹果客户端测试在 Mac 上做，而本次提交只记录了 Linux `HimawariCore` 测试和格式/设计检查；新测试所在的 `HimawariSensesTests` 在 Linux 上根本不编译。能力表与代码不一致是上面第 1 条。没有找到描述这页旧文案的文档，因此没有发现文案文档过期。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这个 diff 只改 Apple 客户端的界面文案、`SenseDetailView`、`SensesModel` 的镜像计数辅助方法和测试，没有改系统提示、工具定义、历史消息、遮盖或任何模型请求组装代码。发给模型的内容仍然只在末尾追加；删除服务器感知数据只会改变以后 `perception_read` 追加在末尾的工具结果，不会重写已经发出的开头；每轮会变的感知内容仍按 `prompt-prefix.md` 第 3 条放在最后追加的工具结果里，不在系统提示或更早的位置。

2. **会不会让同一段文字在不同请求里变成不同的字节？** 就这个 diff 而言不会。新增文案是静态本地化键；`detail.routeDays` 的 `%d` 和 `detail.stopTitle` 的 `%@` 只用于界面显示，不进模型请求。`mirrorCounts` 会随服务器数据变化，但只驱动 UI；没有新增时间字段、无序集合或遮盖逻辑进入请求。删除服务器数据后，未来 `perception_read` 的内容会不同，但那是新的数据内容，不是同一段提示文字被重新序列化成不同字节。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 只有一个新增的 `SensesModel` 单元测试，而且它不在 Linux 目标里，提交记录也没有显示在 Mac 上运行过；没有针对 UI 开关、两个确认对话框、取消行为或三语文案的自动检查。反向用例方面：删掉 `!on` 条件，最后一条断言会失败，所以开关条件有覆盖；删掉 `mirrorCounts > 0` 条件，当前四条断言仍然全部通过，所以“服务器上还有数据”这一半没有会失败的反向用例。`isMirror` 守卫也没有被有效覆盖。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - 三语本地化键：产生于三个 `Localizable.strings`，使用于 `L.text`/`L.format`；键集合和占位符一致，能接受。
   - `SenseOperation.deleteRecords`：产生于 `SensesService.swift:5`，使用于 `AppModel.phoneOperations`，再经 `ClientCapabilities.find(.v2, ...)` 校验；当前能力表没有这个 id，生产端不接受，`canDelete` 恒为假。这是本次最明确的两端不一致。
   - `serverCopyRemovable`：产生于 `SensesModel.swift:59-62`，使用于 `SenseDetailView.swift:181-183` 和测试；输入是持久化开关和 `mirrorCounts`。主要逻辑能接受，但持久化 `on` 与界面 `collecting` 的来源不同，存在上面的边界风险。
   - `mirrorCounts`：产生于 `MirrorSync.active`/`MirrorSyncResult.active`，使用于详情页标题和 `serverCopyRemovable`；`refresh`/`loadDay` 会刷新，清理成功后清零。服务端 `syncMirror` 返回 `active`；`active` 是可选值，服务端不返回时可能保留旧值，属于未核实的边界。
   - 修改的 `item.calendar.deleteAll`、`item.contacts.deleteAll`、`item.*.confirm`：只作为界面按钮和确认标题/正文使用，没有格式占位符；`SensesModel.deleteAll` 传给服务端的 reason 用的是未改动的 `detail.deleteAll`，所以这些改文案不会改变任何发往服务器的字段。
   - `detail.routeDays`：使用 `retention.days`，来自 `PerceptionStatusSnapshot.retention`，即服务器配置，不是写死；`retention` 为空时仍走原来的 `detail.kept` 行，是既有行为。
   - 没有修改配置键、清单项或序列化格式。
