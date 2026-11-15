**复核范围**

实际增量只有两个提交（`f72d34203`、`e0cda1226`），`git diff --stat 1c2aadf..e0cda12` 只改了 5 个 Swift 文件和本轮复核记录：`DeviceActionAPI.swift`、`DeviceActionViews.swift`、`DeviceActionsModel.swift`、`DeviceActionServerTests.swift`、`DeviceHTTPClientTests.swift`。作者说法里的“确认挑战码、审批卡/详情页、今日页卡片、设备能力开关、端到端测试”都不在这段增量里，是 `1c2aadf` 之前就有的内容；这一点与代码不一致。本轮没有运行测试，结论来自读代码和对比契约。

**上一轮意见核对**

- 意见 1（审批响应走未注册路径、挑战码无效）已改好：`DeviceActionAPI.swift:162` 现在走 `gatewayCall("approval.respond", ...)`，`device-api-routes.ts:85,1290` 注册了 `POST /gateway`；服务器在 `paired-device-service.ts:321-328,360-361` 校验挑战值，`device-request-signature.ts:290-297` 要求 confirm 签名与设备签名 nonce 相同。挑战码现在对回应审批有效。
- 意见 4（设计文档提醒动作名不一致）没有改好，见下面第 2 条；`git diff 9415310..e0cda12 -- docs/execution/specs/2026-11-11-apple-device-body-design.md` 为空。

**读代码证实的**

### 1（中低，条件触发）：审批详情逐条单独发签名请求，已处理列表一次最多约 1500 次请求，可能耗尽设备 nonce 存储

文件：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionAPI.swift:138-148`；`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionsModel.swift:86-92`

问题：`approvals` 先分页取 `itemRefs`，再为每个 ref 发一次 `approval.detail`。`loadHandled` 对 approved/denied/expired 各跑一遍，最多 `3 × (5 次 list + 500 次 detail) = 1515` 次签名请求；原来同等信息只要 3 次 GET。服务器对每个已认证设备请求都记录一个 nonce（`paired-device-service.ts:366-388`），默认最多保留 10,000 个（`device-limits.ts:105-112`），满了返回 `DEVICE_NONCE_STORE_FULL` 429，之后所有设备请求（包括动作结果回报）都会被拒，直到旧 nonce 过期。如果已处理审批很多、又在短时间内反复打开或下拉审批页，就可能触发。另外超过 500 条的已处理记录会被静默截断（`DeviceActionAPI.swift:138-143`）。

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

```typescript
const nonce = await this.#options.store.recordNonce({ ... maximumRetained: configuration.limits["device.nonce.retained"] });
...
throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.NONCE_STORE_FULL, 429);
```

建议：只在切到“已处理”分段时加载；把已处理条数收紧并在截断时显示“还有更多”；用批量详情查询或让服务端一次返回完整审批；把 429 当作可恢复错误，停止继续发请求并提示稍后再试。请求数量、上限和 429 行为是代码事实，真实数据量/网络下是否触发需要实测（推测）。

### 2（低）：设计文档里的提醒动作名仍是 `reminder.*`，代码和服务端是 `device_reminder.*`，上一轮第 4 条未改好

文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:537`；`clients/apple/Sources/HimawariActions/ReminderActions.swift:7`；`packages/application/src/services/device-action-registry.ts:541,572`

问题：设计文档的动作登记表写 `reminder.create`、`reminder.complete`，实际注册名和 Swift 处理器名都是 `device_reminder.create`、`device_reminder.complete`。这是上一轮已指出的文档与代码不一致，本轮没有修改。

证据：

```markdown
| `reminder.create`、`reminder.complete` | 新建或修改，中 | 不要 | 读回；可撤销 |
```

```swift
public let names = ["device_reminder.complete", "device_reminder.create"]
```

```typescript
name: "device_reminder.complete",
...
name: "device_reminder.create",
```

建议：把文档表格改成 `device_reminder.create`、`device_reminder.complete`；如果文档用的是概念名，补一句到注册名的映射，并让端到端动作名检查覆盖文档示例（当前只比代码和服务端）。

### 3（低）：新的审批网关信封只有手写假响应测试，没有真实服务端/契约的反向检查

文件：`clients/apple/Tests/HimawariCoreTests/DeviceHTTPClientTests.swift:266-287,317-334`；`test/integration/device-actions-swift-client.test.ts:179`

问题：新测试用 `RecordingExchange` 返回手工写的 `{"payload":{}}`、`{"itemRefs":...}`，只断言部分字段；没有任何测试把 Swift 实际编码的 body 交给 `classifyDeviceGatewayRequest`、`CLIENT_GATEWAY_SCHEMAS` 或真实 `/api/device/v1/gateway`。端到端测试只跑 `--filter DeviceActionServerTests`，覆盖动作执行器，不覆盖审批列表/详情/回应。这样如果以后 Swift 信封多一个键、少一个键或类型名写错，单元测试仍会通过，真实服务端会 400/404。

证据：

```swift
let exchange = RecordingExchange([
    HTTPExchangeResponse(status: 201, body: Data(#"{"challenge":"..."}"#.utf8)),
    HTTPExchangeResponse(status: 200, body: Data(#"{"payload":{}}"#.utf8)),
])
```

```typescript
v2: ["gateway", "type", "messageId", "idempotencyKey", "dataClassification", "risk", "payload"],
...
if (Object.keys(body).some((key) => !allowed.includes(key))) invalid();
```

```typescript
["test", "--package-path", packagePath, "--filter", "DeviceActionServerTests"]
```

建议：在 Node 集成测试里用真实网关跑一次 `approval.list → approval.detail → approval.respond`，或至少用契约 schema 解析 Swift 生成的 body；断言 `expectedRevision`、`semanticSnapshotHash`、query 不带 `idempotencyKey`、没有多余顶层键，并加“缺 challenge/confirm 被服务端拒绝”的反向用例。当前 Swift 信封和服务端契约我手工核对是一致的（见必答 4），所以这是防未来回归的缺口，不是当前已发生的错误。

**推测**

### 4（低，推测）：`supported()` 只按名字上报，不按 `schemaVersions` 过滤；新加的 v2 用例会让客户端上报自己不能处理的 `test.note.v2`

文件：`clients/apple/Tests/HimawariCoreTests/DeviceActionServerTests.swift:31,268-280`；`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionExecutor.swift:41-47,100-105`；`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionHandler.swift:45-49`

问题：新测试的 `NoteFileActions` 在 `names` 里包含 `test.note.v2`，但没有覆盖 `schemaVersions`，默认仍是 `[1]`。`executor.run()` 一开始就调用 `announceSupported()`，而 `supported()` 只遍历 `handler.names`，不检查 `schemaVersions`，所以会把 `test.note.v2` 报给服务器；但 `handles()` 又会因为 schemaVersion 2 拒绝它。当前真实注册全是 `schemaVersion: 1`，所以没有现实触发；如果以后服务端给同名动作升版本，老客户端会一直上报支持、却只能回“不支持/结果未知”。

证据：

```swift
let names = ["test.note.append", "test.note.touch", "test.note.v2"]
...
var schemaVersions: Set<Int> { [1] }
func handles(_ delivery: DeviceActionDelivery) -> Bool {
    names.contains(delivery.action) && schemaVersions.contains(delivery.schemaVersion)
}
```

```swift
public func supported() async -> [String] {
    var names: [String] = []
    for handler in allHandlers where await handler.permission.status() == .authorized {
        names += handler.names
    }
    ...
}
```

建议：`supported()` 按 `schemaVersions` 过滤（或把版本纳入上报协议）；同时让新测试断言上报列表不含无法处理的版本，而不只是断言“没有去核对”。

### 5（低，推测）：`DeviceActionsModel` 只把 404/503 当审批不可用，网关“操作未安装”实际返回 501

文件：`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionsModel.swift:77-79`；`packages/platform-node/src/http-gateway-server.ts:954-962`；`apps/agent-service/src/production-approval-gateway.ts:85-88,340-341`

问题：如果某个 v2 网关存在但没有安装 `approval.list/detail/respond`，`AgentGatewayV2Service` 会抛 `OPERATION_NOT_INSTALLED`，HTTP 映射是 501；当前 Swift 的 catch 只有 404 和 503，501 会被 `catch {}` 吞掉，`approvalsAvailable` 保持 true，页面显示空列表而不是“当前部署未启用”。生产 `createProductionApprovalGateway` 无条件安装审批操作，所以当前生产组合不会触发；这是裁剪版网关的隐患。

证据：

```typescript
: error.code === PORT_ERROR_CODES.OPERATION_NOT_INSTALLED
  ? 501
```

```swift
} catch DeviceAPIError.server(let status, _, _, _) where status == 404 || status == 503 {
    approvalsAvailable = false
} catch {}
```

建议：把 501 也纳入“不可用”，或由客户端配置里的 `installedGatewayV2Operations` 判断，而不是靠 HTTP 状态猜。

**侧重检查**

- 确认与挑战：挑战码由 `issueConfirmChallenge` 生成，设备用确认密钥签同一个 nonce；服务器在 `authenticate` 里对 `confirmed` 请求执行 `#challengeValid`，且网关对 `change` 级命令要求 `confirmed`（`device-gateway.ts:154-155`）。未发现绕过路径；上一轮意见 1 确实修好。
- 近期身份验证：客户端发 `recentAuthenticationRef: "device"`，设备网关把它替换成会话的 `authenticationRef`（`device-gateway.ts:125-138`），`RecentAuthenticationGuard` 再核对 evidence、owner、device、session 和过期时间（`recent-authentication-service.ts:58-127`）。生产 `ownerSubject` 已配置（`production-http-composition.ts:1320-1324`）。如果部署用 built-in 身份且没有 active binding，这条路径可能拿不到 evidence；生产实际身份类型未核实，这不是本增量引入的。
- 不可信输入：网关的顶层键白名单和类型字符串都在服务端校验（`device-gateway.ts:79-116`）；Swift 侧翻页最多 5 页，不会因单个响应里的 `nextCursor` 形成无界循环。客户端没有限制单个 `itemRefs` 的长度，但服务器是可信方。
- 不可逆操作：审批决定在服务端按 `approvalRequestId + expectedRevision + semanticSnapshotHash` 校验，已决定的重放返回原结果（`governance-gateway-adapter.ts:790-796`），未发现重复执行或重复生成 grant 的路径。资源耗尽风险见第 1 条。
- 规则/文档：提醒动作名的文档不一致见第 2 条；模型提示词和工具定义在本轮增量里没有改动。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 本轮增量只改 Swift 设备客户端和测试，没有改系统提示、工具定义、历史消息或出口遮盖；没有新增任何会进入模型开头的值。整个 PR 里提示词目录的改动不在 `1c2aadf..e0cda12` 内，未在本轮重读。
2. **不会让同一段模型文字在不同请求里变成不同字节。** 新代码的随机值只有设备网关请求的 `messageId`、`idempotencyKey` 和签名 nonce，它们是有意的请求标识，不来自用户文字，也不进入模型内容；网关信封的字段和顺序固定，审批列表服务端按 `distinctSorted` 排序。没有发现依赖前后文的遮盖或无序集合。
3. **有自动检查，但反向覆盖不完整。** `DeviceHTTPClientTests.swift:266-334` 覆盖了成功回应、拒绝、无确认密钥不发请求、409 变“已变化”、列表加详情；`respondingWithoutAConfirmKeySendsNothing` 去掉 guard 会失败。但这些都是假响应，没有把 Swift 信封交给真实服务端/契约的反向用例；`aRefusedRecordWithNoDeadlineIsClearedOnTheNextPass` 只断言 `refused != true`，没有断言记录确实被删除，区分不出“删除”和“把 refused 改成 false”。建议补真实 `/gateway` 契约测试和更严格的删除断言。
4. **逐个核对新增/修改值的使用端，当前都能接受；例外是文档值和未来版本值。**
   - `approval.list/detail/respond`：服务端已注册（`production-approval-gateway.ts:85-88`），设备能力清单有 v2 条目（`client-capabilities.ts:123,228-229`），契约在 `contracts-v2.ts:232-242,2889-2900`。
   - 信封键：Swift 只发 `gateway/type/messageId/idempotencyKey/dataClassification/risk/payload`，正好等于 `device-gateway.ts:79-83` 的 v2 白名单；`messageId` 和幂等键 `device-` 加 32 位十六进制满足 `MACHINE_STRING`（`device-gateway.ts:73,101-105`）。
   - `risk`：服务端详情返回的是 `lowerRisk()` 的 `low/medium/high/critical`，符合 `riskSchema`（`contracts-v2.ts:186`）。
   - `editedPayloadRef`、`recentAuthenticationRef`：契约允许 null/字符串；`"device"` 正是 `DEVICE_REFERENCE_PLACEHOLDER`（`device-gateway.ts:77,109-116`），服务器会替换。
   - 列表/详情响应：`payload.itemRefs/nextCursor` 来自 `#collection`（`governance-gateway-adapter.ts:319-336`）；详情 payload 是 `approval.snapshot`，Swift 只解码自己需要的子集，多出的 `targetRefs` 等字段会被忽略。
   - 分页参数 `limit=100` 在契约的 `1..500` 内（`contracts-v2.ts:2879-2882`）；500 条后的静默截断见第 1 条。
   - `SegmentPicker` 改为泛型后 `options: [(Int, String)]` 与 `AccountPages.swift:147-149` 的签名一致。
   - 文档里的 `reminder.*` 与 `device_reminder.*` 不一致（第 2 条）；新测试的 `schemaVersion 2` 被 `handles()` 拒绝但被 `supported()` 上报（第 4 条）；501 未被 `DeviceActionsModel` 接受为“不可用”（第 5 条）。
