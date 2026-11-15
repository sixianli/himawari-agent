### 1（中）审批响应提交到服务器没有注册的路径，新增的挑战码对“回应审批”实际无效

**文件:行**：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionAPI.swift:72-104`；`packages/platform-node/src/device-api-routes.ts:73-108、524-531、1189-1192、1237-1245`

**问题**：Swift 端拉审批用 `GET approvals?status=...`，回应审批用 `POST approvals/{id}/respond`；服务器的设备路由表里只有 `POST approvals/challenge` 和 `POST approvals/respond`，后者还是“通知按钮 token”语义，不是审批编号路径。`onRequest` 会拒绝不在这张表里的路径。因此这一轮新增的审批卡、详情页和 `issueConfirmChallenge()` 在真实服务器上要么 404，要么拿不到审批列表；`respond` 前的挑战码请求也就白做了。

**证据**：

```swift
// DeviceActionAPI.swift:74
let data = try await http.send(DeviceRequest(method: "GET", path: "approvals", ...))
// DeviceActionAPI.swift:91-99
let challenge = signer == nil ? nil : try await issueConfirmChallenge()
...
path: "approvals/\(approval.id)/respond",
```

```ts
// device-api-routes.ts:80-81
{ method: "POST", path: "approvals/challenge", signed: true },
{ method: "POST", path: "approvals/respond", signed: true },

// device-api-routes.ts:527-531
if (!DEVICE_ROUTE_PATTERNS.some(
  (route) => route.method === request.method && route.pattern.test(path),
)) options.rejectNotAllowed();

// device-api-routes.ts:1241-1245：/approvals/respond 读的是通知按钮 token
const token = await pushPort().takeAction({
  device: authenticated.device,
  confirmed: authenticated.confirmed,
  body: json(request),
});
```

单元测试 `clients/apple/Tests/HimawariCoreTests/DeviceHTTPClientTests.swift:269-270` 还用假 `RecordingExchange` 断言了这个服务器不存在的路径，所以测试本身抓不到这个问题。

**建议**：要么把审批回应改走现有的 `POST gateway` + `approval.respond` 分发（`device-api-routes.ts:1255-1281`），要么在服务器补 `GET approvals` 和带签名、挑战码校验的 `POST approvals/{id}/respond`；同时用真实服务器集成测试覆盖审批列表和回应，而不是只断言假交换器里的 URL。

### 2（中低）T3 的“核对也看版本”没有真正被反向用例覆盖，新用例只走 perform 分支

**文件:行**：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionExecutor.swift:147-151、199-202`；`clients/apple/Tests/HimawariCoreTests/DeviceActionServerTests.swift:255-266`

**问题**：代码确实在 `verify()` 里加了 `handler.handles(delivery)`，这是对的；但作者说“去掉版本检查时 `aNewerVersionOfAnActionIsNeitherDoneNorChecked` 会失败”只对 perform 分支成立。该用例第一次 `request` 后只调用一次 `executor.run()`，投递是 `.perform`、日志里没有记录，走的是 `perform()` 里的 `DeviceActionGate`，根本不会进入 `verify()`。把新加的 `verify` 版本检查删掉，这个用例仍会通过。

**证据**：

```swift
// DeviceActionExecutor.swift:147
if delivery.mode == .verify || entry.map({ $0.stage != .received }) == true {
    await verify(delivery, made: entry?.made, before: entry?.before)
    return
}

// DeviceActionExecutor.swift:200
guard let handler = handlers[delivery.action], handler.handles(delivery), await handler.permission.status() == .authorized else {
```

```swift
// DeviceActionServerTests.swift:255-262
@Test func aNewerVersionOfAnActionIsNeitherDoneNorChecked() async throws {
    ...
    let asked = try await setup.control.call("request", body)
    #expect(await executor.run() == [.reported(id: id, outcome: .failed, readBack: false)])
```

测试里没有 `.verify` 投递配合 `schemaVersion: 2` 的用例（我也用 grep 核对了整个 `Tests` 目录）。

**建议**：新增一个日志记录或投递为 `.verify`、`schemaVersion` 为 2 的用例，断言进入 `verify` 后返回 `resultUnknown`/`cannotCheck` 且不调用 `perform`、`readBack`；再覆盖“坏日志重开后核对”的路径。

### 3（中低）端到端用例在 Swift 不可用时静默通过，CI 无法区分“没跑”和“通过”

**文件:行**：`test/integration/device-actions-swift-client.test.ts:103-105、193-195`

**问题**：这一轮把 `it.skipIf(!swiftAvailable)` 改成了普通 `it` 加 `if (!swiftAvailable) return;`。在没有 Swift 的机器上，这个用例会以“通过”结束；后面的 `expect(output).not.toMatch(/skipped/u)` 根本不会执行。提交信息写的是“unblock check steps”，但这会让 CI 看起来绿了，实际没有跑真实服务器加 Swift 执行器。

**证据**：

```ts
// :103-105
describe("[iOS-9B] the iPhone executor runs against the real device-action server", () => {
  it("performs, reads back, replays and verifies through the Swift client", async () => {
    if (!swiftAvailable) return;

// :193-195
expect(code, output.slice(-6000)).toBe(0);
expect(output).toMatch(/DeviceActionServerTests/u);
expect(output).not.toMatch(/skipped/u);
```

**建议**：恢复 `skipIf`，并在 CI 策略里允许有记录的跳过；或者在这个作业明确要求 Swift 时直接失败。至少要在跳过时输出可观察的警告，别把“工具链缺失”显示成测试通过。

### 4（低）T4 只修好了代码对服务器，设计文档里的提醒动作名仍然不一致

**文件:行**：`docs/execution/specs/2026-11-11-apple-device-body-design.md:537、688、714`；`packages/application/src/services/device-action-registry.ts:541、572`；`clients/apple/Sources/HimawariActions/ReminderActions.swift:7`

**问题**：新增的双向检查确实在 PR 里了，但设计文档仍写 `reminder.create`、`reminder.complete`，代码和服务器登记的是 `device_reminder.create`、`device_reminder.complete`。文档还写“动作名由清单生成 Swift 代码，不手抄；清单变了而生成的代码没更新，检查失败”，实际是手写 `public let names = [...]`，再由测试正则扫描，二者仍不一致。

**证据**：

```md
<!-- docs/...:537 -->
| `reminder.create`、`reminder.complete` | 新建或修改，中 | 不要 | 读回；可撤销 |
```

```ts
// device-action-registry.ts:541、572
name: "device_reminder.complete",
name: "device_reminder.create",
```

```swift
// ReminderActions.swift:7
public let names = ["device_reminder.complete", "device_reminder.create"]
```

**建议**：把文档表格改成 `device_reminder.*`；如果文档承诺“从清单生成”，就补生成脚本或修改文档措辞，并加一个文档到代码的检查（至少让改名时文档测试也失败）。

### 5（低）T5 的 `keepUntil == nil` 分支和 T6 的 `correctedNow` 使用都没有专门测试

**文件:行**：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionExecutor.swift:120-125`；`clients/apple/Tests/HimawariCoreTests/DeviceActionServerTests.swift:206-231`；`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionsModel.swift:80`

**问题**：T5 的代码修复是对的，但现有“被拒结果”用例明确把 `keepUntil` 设成 `now + 600`，测的是过期清理，不是 `nil` 分支；把 `?? .distantPast` 去掉后这个用例仍然通过。T6 只在 `DeviceHTTPClientTests` 里测了 `correctedNow` 本身，没有测试 `refresh()` 的 `finishedSince` 确实使用校正后的时间。

**证据**：

```swift
// DeviceActionExecutor.swift:120-125
if entry.refused {
    if (entry.keepUntil ?? .distantPast) < current {
        try? journal.update { $0.entries[entry.id] = nil }
    }
    continue
}
```

```swift
// DeviceActionServerTests.swift:218-221
var entry = DeviceActionJournalEntry(...)
entry.keepUntil = setup.clock.now.addingTimeInterval(600)
```

```swift
// DeviceActionsModel.swift:80
if let views = try? await api.actionViews(finishedSince: api.http.correctedNow.addingTimeInterval(-Self.recentWindow)) {
```

**建议**：加一个 `keepUntil == nil` 的被拒记录，断言下一轮被清掉且不会重做；再加一个模型/API 级测试，让服务器返回时钟偏差后断言 `finishedSince` 用的是校正后的时间。

### 6（低）动作名双向比对只比名字，不比 `schemaVersion` 和实际注册的处理程序

**文件:行**：`test/integration/device-actions-swift-client.test.ts:79-100`；`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionHandler.swift:47-49`；`packages/application/src/services/device-action-registry.ts:379-663`

**问题**：服务器登记项带 `schemaVersion`，Swift 的 `handles()` 也按版本判断，但端到端测试只比较 `Set<string>` 名字。服务器把某个动作升到第 2 版时，名字比对仍通过，而真实设备会回 `notSupported`。另外它扫描的是 `Sources/HimawariActions` 里的源文本，不是 `AppleDeviceActions.handlers()` 在当前平台实际返回的处理器；源文件里有名字但某平台没编译进去时测试也会通过。

**证据**：

```ts
// test:84-86
for (const list of source.matchAll(/public let names = \[([^\]]*)\]/gu))
  for (const name of (list[1] ?? "").matchAll(/"([^"]+)"/gu)) names.add(name[1] ?? "");
```

```swift
// DeviceActionHandler.swift:47-49
func handles(_ delivery: DeviceActionDelivery) -> Bool {
    names.contains(delivery.action) && schemaVersions.contains(delivery.schemaVersion)
}
```

**建议**：比对 `name + schemaVersion + deviceKinds`，或在目标平台上实例化 `AppleDeviceActions.handlers()` 后核对实际名字和版本；长期按设计文档做“清单生成 Swift”而不是手抄加正则。

**读代码证实的**

- T2 已改好：`DeviceActionExecutor.swift:142-151` 对“已 finished 但没有 report”的记录走 `verify`，不会重新执行；新增用例 `DeviceActionServerTests.swift:268-279` 会走这条路径。
- T3 的代码修复在 `verify` 里，但测试没有覆盖该路径（见意见 2）。
- T5 的代码修复在 `DeviceActionExecutor.swift:120-125`；T6 的代码修复在 `DeviceActionsModel.swift:80`。
- 作者说 T1 不成立：`AppModel.swift:331-336` 把执行器的 `now` 接到 `http.correctedNow`，`DeviceActionGate.refusal` 用这个 `now` 判过期（`DeviceActionExecutor.swift:157-165、303-307`），所以过期判断确实用了服务器校正时间。
- 挑战码服务端校验存在：`paired-device-service.ts:305-328` 校验 base64url 长度、MAC 和过期时间，`:360-361` 要求 confirmed 请求的 nonce 是有效挑战，`:375-376` 拒绝 nonce 重放；`device-request-signature.ts:294-295` 要求 device/confirm 两个签名成员 nonce 相同。Swift 侧 `DeviceAPIClient.swift:182-189` 使用同一个 nonce 给两个成员签名，和服务器一致。
- 审批列表/回应路径确实不存在于设备路由表（见意见 1）。
- 设计文档与代码的提醒动作名不一致（见意见 4）。
- 端到端用例在 Swift 不可用时静默返回（见意见 3）。

**推测**

- 因为生产审批还没接通、需要审批的设备动作服务端会回 `approval_not_connected`，意见 1 的 404 目前不会在正常生产流程里暴露；一旦审批接通，它会直接导致审批列表为空、回应失败。
- `check-operations.mjs` 的“调用方”判定依赖源码里的字面量；`home.read` 同时是网关查询名和设备动作名。本次移出 `ci/operations-pending.json` 在最终代码里还有 `MenuBarFeed.home`（`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:79-80`，调用 `GET /home`）作为真实调用方，所以当前状态不算错；但我没有读到能区分两个 `home.read` 的检查，未来可能误判。
- `PairingProblem.from` 仍把任何 `DeviceKeyError` 归为 `.keysUnavailable`；新增的 `.keyUnreadable` 主要从 `presence` 路径产生，没有发现新的崩溃路径，但这条映射语义是否要在以后区分，未核实。

**侧重检查**

- 错误路径：检查了挑战码缺失、过期、设备不匹配、nonce 重放、confirmed 缺失；服务端校验完整，Swift 只在需要面容确认时请求挑战。审批回应的目标路径缺失是这一轮发现的错误路径问题。
- 不合规范/不可信输入：`handles()` 同时校验动作名和版本；`DeviceActionView` 把未知状态保留为 `rawState` 并显示 `.other`；`DeviceActionArguments` 对类型错误抛 `badArguments`。未发现新增的崩溃或越权路径。
- 不可撤销操作：`record(.started)` 在 `perform` 前写入（`DeviceActionExecutor.swift:183`）；已完成/已开始但无结果的记录只核对不重做；过期使用校正时间。T2/T3 的修改方向是更安全。
- 资源耗尽：`pass()` 的 `while true` 领取动作循环是既有逻辑，本次没有新增无界循环；新的审批/最近结果查询有服务端 100 条上限。
- 安全：挑战码是设备绑定、带 MAC 和有效期，且作为外层 nonce 一次性使用；设备/confirm 两个签名 nonce 必须相同。未发现新增的凭据泄漏。
- 规则/文档一致性：T4 的设计文档仍与代码不一致；另外设计文档承诺的“清单生成 Swift”也尚未实现。

**上一轮意见核对**

- T2：已改好，代码和用例都能证明“有 finished 记录但没结果”会只核对不重做。
- T3：代码已改好，但缺 `verify` 路径的反向用例，作者对用例失败原因的说明不准确。
- T4：双向检查已加，但设计文档里的动作名仍不一致，且“清单生成”承诺未实现。
- T5：代码已改好；`keepUntil == nil` 没有专门测试。
- T6：代码已改好；没有针对模型查询的专门测试。
- T1：作者的说法成立，`AppModel` 已把执行器时间接为 `correctedNow`。

**本轮查过的范围**

- 第 3 轮之后的 PR 提交：`61cc2b2b8`（T2-T6 修复）、`f95ca9aa8`、`b279424fe`、`79bccb762`、`d82988e0d`、`382aa0bec`、`7506b3535`、`1a72be42e`、`fd644fe15`、`3467653da`、`1c2aadf64`。
- 重点文件：`DeviceActionExecutor.swift`、`DeviceActionHandler.swift`、`DeviceActionAPI.swift`、`DeviceActionModels.swift`、`Approvals.swift`、`DeviceActionsModel.swift`、`DeviceActionViews.swift`、`AppModel.swift`、`RootView.swift`、`SettingsRootView.swift`、`DevicePages.swift`、`PairingRecord.swift`、`PairingDecisions.swift`、`SecureEnclaveKeys.swift`、相关 Swift 测试、`test/integration/device-actions-swift-client.test.ts`、`ci/operations-pending.json`、`device-api-routes.ts`、`paired-device-service.ts`、`device-request-signature.ts`、`device-action-registry.ts`、设备动作设计文档。
- 合入 main 的 Listening/Share/Mac 菜单栏等无关大块没有重读；只跟到被本增量使用的 `MenuBarFeed.home` 和 `ClientCapabilities`。
- 没有运行测试或 Mac 编译（按材料约束），以上关于“反向用例会失败/不会失败”的判断来自控制流阅读，已标为推断。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 本 PR 的增量只改 Apple 客户端、设备动作端到端测试和 `ci/operations-pending.json`；没有改系统提示、工具定义、历史消息或遮盖结果。设备动作仍然只通过 `device_action` 的工具结果追加到末尾，`prompt-prefix.md:27-30、46` 要求的“动作定义固定、设备新增动作不改工具定义”没有被破坏。合入 main 带来的无关改动不在本 PR 逻辑内；是否改了提示词前缀未逐文件核实。
2. **没有新增“同一段文字在不同请求里变成不同字节”的情况。** 本增量新增的随机值只有 `approvals/challenge`，它只出现在 HTTP 头/签名参数里，不进模型内容；`reportSupportedActions` 仍按排序后的名字发送；`finishedSince`、最近结果时间只影响设备查询，不进模型请求开头。既有 `JSONObject` 字典序列化的顺序问题不是本增量引入，未核实它是否会进入模型可见内容。
3. **自动检查有，但反向覆盖不完整。** T2 有真实控制流对应的用例；T3 的用例只覆盖 perform 分支，删掉 `verify` 的版本检查不会失败；T4 有代码对服务器的名字比对，没有文档校验；T5 没有 `keepUntil == nil` 用例；T6 没有查询侧用例；新增端到端用例在没有 Swift 时会静默“通过”，所以“没跑”会被当成“绿”。
4. **逐项核对新增/修改的值**：
   - `permissionIds()`：生产端 `DeviceActionExecutor.swift:49-51`，使用端 `DeviceActionsModel.swift:109-110` 和 `DeviceActionGateTests.swift:158-168`；动作名到权限 id 的映射两端一致。
   - `PermissionState`、`sourceNames`：生产端 `refreshPermissions`，使用端 `ApprovalDetailView.source`、`DeviceAbilitiesSection`；动作名与服务器 `device-action-service.ts:496-497` 的 `operation: input.action` 一致，三个语言的 `permission.status.*` 等键都存在。
   - `DeviceActionResultKind.other`、可选 `DeviceActionView.state`、`rawState`：解码和视图都接受未知状态，`result.other`、`result.other.update` 三个语言都存在。
   - `DeviceKeyError.keyUnreadable`、`PairingProblem.stateUnknown`：`SecureEnclaveKeys.swift:29` 产生，`PairingView` 路由和翻译键存在，覆盖测试存在；`PairingProblem.from` 仍把 `DeviceKeyError` 归为 `keysUnavailable`，这是既有映射，未发现新崩溃。
   - `approvals/challenge`：Swift 产生端 `DeviceActionAPI.swift:46-50`，服务器端 `device-api-routes.ts:1189-1192` 接住并用 `paired-device-service.ts:305-328` 校验；用于 `actions/policy` 时两端接受，用于 `approvals/{id}/respond` 时目标路径不被服务器接受（意见 1）。
   - `ci/operations-pending.json` 删除 `home.read`：最终代码有 `MenuBarFeed.home` 作为网关查询调用方，检查可通过；但检查依赖字面量，和设备动作同名，存在误判风险。
   - `PairingRecord.pairedAt`：提交 `d82988e0d` 加过，但最终合并后的 `PairingRecord.swift` 没有这个字段；设备页改用服务器返回的 `PairedDevice.pairedAt`（`DevicePages.swift:113`），没有悬空使用端，作者“配对时记在本机”的说法与最终代码不符。
