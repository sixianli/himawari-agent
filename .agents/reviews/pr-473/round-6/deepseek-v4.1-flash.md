## 查过的范围

- 增量 `e0cda12..3a124da`：PR 473 自己的改动只有 `6079dc3c1`（`JSONValue`→`DeviceActionValue` 重命名）；其余是 `1baa489`（main）合入，合并没有改动 PR 的 Swift 源文件（只带来 `Generated/ClientCapabilities.swift`、文档和测试夹具）。
- 两条上一轮意见逐条对照：上一轮原文没能读取（工具拒绝对 `.agents/reviews` 的 `git show`），按你列出的两条核对。
- 读了：`DeviceActionAPI`、`DeviceActionsModel`、`DeviceActionExecutor`、`DeviceActionHandler`、`DeviceActionJournal`、`DeviceActionValue`、`Approvals`、五个动作处理器、权限、设计文档、9B 集成测试、`check-operations.mjs`、设备 nonce/期限的服务器端代码、Xcode 工程与 plist。
- 未核实：Mac/Linux 上的真实 Swift 编译与测试（本环境不能执行 Swift），生产运行时不涉及。

## 侧重检查

- **期限/时钟**：`DeviceActionGate.refusal` 用注入的 `now`，`AppModel` 注入 `api.http.correctedNow`；服务器 `device-action-service.ts:342-344` 对 `ownerPresence` 使用 `presenceExpirySeconds`，默认 120s 小于普通 600s；设备端对读不出的期限按过期处理，有测试。作者“T1 不成立”的辩护基本成立，但配置范围允许 `presenceExpirySeconds`(30..3600) 大于 `expirySeconds`(30..86400)，所以“更短”只是默认值，不是强约束。
- **不可信输入**：`DeviceActionArguments` 对类型严格拒绝；`DeviceActionValue` 先 Bool/Number 再 String；`AlarmActions.alarmId` 只接受 `dact_`+32 hex；`CalendarOccurrenceId` 用最后一个 `#` 切分；均未发现可注入路径。
- **权限/审批**：执行前检查 implemented、policy、系统权限、期限；`verify` 只对 read-only 动作重做，不重复副作用；确认密钥带 `.userPresence`，Face ID 由 Secure Enclave 触发。
- **资源耗尽**：发现审批列表的逐条详情放大（见第 1 条）；报告 evidence 过大时服务器 400 会退化为不带 evidence 重发；坏 journal 按重装处理且不执行。
- **不可撤销**：门锁/车库门由服务端 `ownerPresence`/审批控制；设备端不绕过。
- **规则/文档一致性**：发现 `reminder.*` 文档名、`home.read` 清单项和工程配置问题（见下）。

## 发现的问题（按严重度）

### 1（中）：审批列表逐条拉详情，打开一次最多约 1500 次签名请求，可能打满设备 nonce 存储；上一轮意见未修好

文件：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionAPI.swift:72-73,138-148`；`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionsModel.swift:86-93`；`packages/application/src/ports/device-limits.ts:105-111`；`packages/platform-node/src/paired-device-service.ts:366-388`

问题：`loadHandled()` 对 approved/denied/expired 各拉一次列表；`approvals()` 每页 100、最多 5 页，然后对每个 ref 单独发一次 `approval.detail`，最坏 3×5×100=1500 次详情请求。每次详情都会走 `DeviceHTTPClient.signed`，用一个新的设备 nonce；服务器把每个 nonce 记入保留库（默认 10000 个、保留 `2 × signatureToleranceSeconds`，默认 120 秒）。打开几次审批页就可能在 2 分钟内打满，之后所有设备请求都被 429 `DEVICE_NONCE_STORE_FULL`。此外详情是串行 `try await`，任意一条 404/网络错会让整份列表（`pending = try await ...`）失败。

证据：

```swift
static let approvalPageSize = 100
static let approvalPageLimit = 5
...
for ref in refs {
    let data = try await gatewayCall("approval.detail", DetailPayload(approvalRequestId: ref))
    found.append(try decode(Detail.self, data).payload)
}
```

```swift
for status in [ApprovalStatus.approved, .denied, .expired] {
    all += (try? await api.approvals(status: status)) ?? []
}
```

```swift
nonce: request.nonce ?? DeviceSignature.newNonce()
```

```ts
maximumRetained: configuration.limits["device.nonce.retained"],
```

建议：已处理列表不要逐条拉详情，改成批量接口或点开时再拉；给 handled 分页/上限；单条失败只跳过该条；补一个“很多 ref + 单条 404 + 429”的测试。`git log e0cda12..3a124da -- .../DeviceActionAPI.swift` 显示该文件在上一轮基线后没有改动，所以上一轮这条并未修好。

### 2（中低）：端到端 Swift 测试在没有 Swift 的机器上静默通过，声称的端到端校验可能根本没跑

文件：`test/integration/device-actions-swift-client.test.ts:22-23,104-105`

问题：`swiftAvailable` 为假时直接 `return`，Vitest 把这条测试记为通过；上一版用的是 `it.skipIf(!swiftAvailable)`，至少会显示 skip。作者提交说明写明“本机无 Swift 编译器”，因此这条“真服务端端到端测试”很可能从未实际执行。名字比对那条不依赖 Swift，仍然有效。

证据：

```ts
const swift = spawnSync("swift", ["--version"], { encoding: "utf8" });
const swiftAvailable = swift.status === 0;
...
it("performs, reads back, replays and verifies through the Swift client", async () => {
    if (!swiftAvailable) return;
```

建议：改回 `it.skipIf(!swiftAvailable)` 或 `test.skip`，让“未跑”可见；在声称会跑端到端的任务里没有 Swift 就失败。

### 3（低）：`ci/operations-pending.json` 移除了网关操作 `home.read`，但没有真正的调用方；只是与设备动作同名，operations 检查被字面量骗过

文件：`ci/operations-pending.json`（`1c2aadf64` 删掉的 `home.read` 行，当前文件已无）；`clients/apple/Sources/HimawariActions/HomeActions.swift:97-98,133`；`scripts/check-operations.mjs:315-329,80-91`；`packages/platform-node/src/device-api-routes.ts:1372-1385`

问题：被删的清单项指的是网关查询 `home.read`（`GET /api/device/v1/home`，`production-home.ts:61` 已安装）。这个 PR 没有加任何 `GET /api/device/v1/home` 的 Swift 调用；Swift 里唯一的 `"home.read"` 是设备动作名。`check-operations` 会把 `clients/apple/Sources` 的 Swift 字面量当作“调用方”，于是把 `home.read` 判为齐全、要求移出名单。结果是：真正的网关 `home.read` 仍没有 iPhone 调用方，但门槛不再报红。这正是 I-73 那类“清单里的 id 只在某一端认”的问题。

证据：

```swift
public let names = ["home.control", "home.read"]
public let readOnly: Set<String> = ["home.read"]
if delivery.action == "home.read" { return try await read(delivery) }
```

```js
...walk(root, SWIFT_ROOT, ...), // frontendTexts 包含 Swift
...
const literal = `"${name}"`;
...
if (!/(?<![.\w])message\(\s*$/.test(before) && !/\bmessageId\s*[:=]\s*$/.test(before))
    return true;
```

```ts
device.get("/home", async (request, reply) => {
...
type: "home.read",
```

建议：恢复该 pending 项，或把设备动作改名（例如 `home.status`），或让 `check-operations` 排除设备动作名；等真的接上 `GET /api/device/v1/home` 再移出。

### 4（低）：设计文档的动作名仍是 `reminder.*`，代码和服务端是 `device_reminder.*`；上一轮第 4 条未改好

文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:539`；`clients/apple/Sources/HimawariActions/ReminderActions.swift:7`；`packages/application/src/services/device-action-registry.ts:541,572`

问题：同一份功能说明里的动作表和实现/登记表不一致；按文档写会调用不存在的 `reminder.create` / `reminder.complete`。

证据：

```md
| `reminder.create`、`reminder.complete` | 新建或修改，中 | 不要 | 读回；可撤销 |
```

```swift
public let names = ["device_reminder.complete", "device_reminder.create"]
```

建议：把文档改成 `device_reminder.create` / `device_reminder.complete`。说明：该行在 PR 对比基准 `1baa489` 里就与 main 相同，PR 没碰它，但它是这个功能的说明文档，上一轮意见仍然成立。

### 5（低）：iOS 目标里出现重复的 `CODE_SIGN_ENTITLEMENTS` 赋值

文件：`clients/apple/App/Himawari.xcodeproj/project.pbxproj:579,586,605,612`

问题：同一个 buildSettings 字典里，先加了一行固定值，后面又保留了原来的按渠道后缀取值的一行。固定值这一行是多余的；重复键的解析顺序不确定，最坏会绕过 `HIMAWARI_ENTITLEMENTS_SUFFIX` 的渠道差异。若本意是给 macOS 目标加权限文件，则加错了目标（macOS 的 `D716…`/`DBC9…` 仍没有 `CODE_SIGN_ENTITLEMENTS`）。

证据：

```text
CODE_SIGN_ENTITLEMENTS = iOS/Himawari.entitlements;
...
CODE_SIGN_ENTITLEMENTS = "iOS/Himawari$(HIMAWARI_ENTITLEMENTS_SUFFIX).entitlements";
```

建议：删掉新增的固定值行，保留原来的后缀模板；确认要改的是哪个目标。

### 6（低）：面容取消/失败也被说成“看一下网络”

文件：`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionsModel.swift:126-133,153-156`；`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionsText.swift:16`；`Resources/zh-Hans.lproj/Localizable.strings:4`

问题：`respond`/`setAllowed` 的 `catch` 不区分错误类型，Face ID 被取消、确认密钥读不出、服务器 500 都显示“没送出去，看一下网络再试”，把用户引到错误方向。

证据：

```swift
} catch {
    if approved && approval.recentAuthenticationRequired { Haptics.shared.report(.faceIDFailed) }
    problem = DeviceActionsText.notSent
}
```

```swift
static var notSent: String { L.text("actions.notSent") }
```

```text
"actions.notSent" = "没送出去，看一下网络再试";
```

建议：区分 `DeviceKeyError`/用户取消和网络错误；确认失败提示“没过面容，什么也没做”。

### 7（低）：共享 `ToggleRow` 的 tint 从 `hmSunBright` 改成 `hmSuccess`，影响本功能以外的开关

文件：`clients/apple/Sources/HimawariDesign/Components.swift:248`；`clients/apple/Sources/HimawariShare/EntryViews.swift:170,202`

问题：新增的“它能替你做的”开关复用了 `ToggleRow`，但改的是组件默认色，Safari 扩展/分享开关也会一起变绿。是否设计意图未核实；若是只为新页面，应该局部覆盖而不是改共享组件。

证据：

```swift
-        .tint(Color.hmSunBright)
+        .tint(Color.hmSuccess)
```

建议：确认设计；只改本功能页面的 tint，或同步更新相关截图/设计说明。

## 推测与未核实

- **Mac 上的权限说明**（推测）：`HimawariMacUI` 使用同一个 `AppModel`，会创建包含 Calendar/Reminder/Contact 处理器的执行器，但 `App/MacOS/Info.plist` 没有 `NSCalendarsFullAccessUsageDescription`、`NSRemindersFullAccessUsageDescription`、`NSContactsUsageDescription`。目前这些处理器在未授权时不会出现在 `supported()` 里，也不会主动请求权限，所以暂时不会走到“缺 purpose string 被系统终止”；但若以后 Mac 露出“能力”页或用户主动授权，就会有问题。9B 范围是 iPhone，未核实 Mac 是否计划支持。
- **时区**（推测）：服务器按 `runPolicy.timeZone` 生成/显示本地时间，Swift 用 `TimeZone.current` 解析执行；设备时区与主人配置时区不同时会偏移。这是 9A/9B 旧行为，本次增量没改，未找到相关测试或说明。

## 必答问题

1. **有没有改变模型已见过的请求开头？** 不涉及。这个 PR 是设备端 Swift/客户端；`1baa489..3a124da` 没有改 `packages/prompt-catalog`、系统提示、工具定义或历史组装。发给模型的内容仍由服务器端按“只追加”处理，本改动没有参与。增量的类型重命名也不影响模型字节。
2. **同一段文字会不会在不同请求里变成不同字节？** 对模型内容不涉及。设备动作侧：能力名单、被屏蔽动作集合、journal 都做了排序或 `sortedKeys`；每次请求变化的是 nonce/messageId，这是预期的。未发现会影响模型或服务端去重的非确定性；`DeviceActionReport.evidence` 的 JSON 键序未排序，但只发给设备路由，服务端按 action id 去重，未发现正确性问题。
3. **有没有对应自动检查，反向用例会不会真失败？** 动作名比对有真实反向断言（服务器多出未实现动作、Swift 多出服务器不认识的动作都会失败），`DeviceActionGateTests` 覆盖过期、权限、参数类型和整数字节。两点不足：端到端那一半在没有 Swift 时静默通过（见第 2 条）；`DeviceActionValue` 重命名只在本环境外（Mac 编译 HimawariActions）验证，本环境无法确认。
4. **每个值的产生处和使用处两端是否都能接受？** 已核对：9 个动作名与服务器登记表一致（集成测试守）；`dact_`+32 hex 与 `AlarmActions` 的 UUID 解析一致；`approvals/challenge` 路径和 `challenge` 字段两端一致；`device.actions` SSE 事件名两端一致；`DeviceActionValue` 重命名后仓库内所有引用都已更新（`grep` 无残留 `JSONValue` 在 `HimawariCore`/`HimawariActions`）。发现的不一致是：`home.read` 清单项被错误移除（第 3 条）、文档 `reminder.*`（第 4 条）、工程里重复的 `CODE_SIGN_ENTITLEMENTS`（第 5 条）。
