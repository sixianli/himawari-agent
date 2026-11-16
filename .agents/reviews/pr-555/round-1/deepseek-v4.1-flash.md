## 侧重检查

- **错误路径**：已核实 `DeviceActionAPI.undoAction` 把 404 映射为 `notFound`、409 映射为 `notUndoable`，UI 显示“已经撤不了了”；其他错误显示 `notSent`。把任意 409 都当成不可撤销会掩盖服务端其他冲突，但这里服务端路由只返回这一类 409，未发现实际误判。未核实 Face ID 取消时用户看到的文案是否足够准确。
- **不合规范/不可信输入**：已核实撤销请求只带 `id`，服务端要求 `id` 符合 `dact_[0-9a-f]{32}`；未知 `undo` 值在客户端降级为 `.none`。发现 `CalendarActions` 新生成的空字符串证据无法通过服务端字符串校验（见意见 1）。
- **安全**：已核实正常 UI 路径始终传确认签名；`SecureEnclaveKeySigner` 的 `.confirm` 密钥带 `.userPresence`，挑战码同时作为设备签名和确认签名的 nonce。未确认路径仍可调用（见意见 4）。
- **资源耗尽**：已核实服务端证据上限 64 KiB，本次新增字段都受日历字段长度约束，没有循环或放大路径。未发现新增风险。
- **不可撤销操作**：意见 1 会让常见日历删除无法恢复，直接违背“删之前存原样，可恢复”的设计目标。
- **规则/文档与代码一致**：已核实设计文档 `docs/execution/specs/2026-11-11-apple-device-body-design.md:541` 要求 `calendar.delete` 可恢复；演示数据里提醒事项显示“已撤销”，与动作登记表冲突（见意见 5）。作者关于空字符串能“撤回原样”的说法与代码不符。

## 意见

### 1. 高：给 before 补空字符串，反而让日历删除和改地点/备注的撤销失效

文件：`clients/apple/Sources/HimawariActions/CalendarActions.swift:20-24`；`packages/application/src/services/device-action-registry.ts:107-118`、`233-268`；`packages/application/src/services/device-action-service.ts:827-839`、`860`

问题：`snapshot` 在 EventKit 返回 `nil` 时把 `location`/`notes` 写成空字符串。`undoDeletedEvent` 会把 `before` 里所有存在的字段复制进 `calendar.create` 参数；`undoRestoring` 也会把被修改字段的 `before` 值复制进反向参数。随后 `#undoPlan` 调用 `validateDeviceActionArguments`，而字符串校验明确拒绝空字符串。结果是撤销计划变成 `null`，`undo` 状态为 `none`，直接 POST 也会得到 409。

证据（已证实）：

```swift
if before["location"] == nil { before["location"] = .string("") }
if before["notes"] == nil { before["notes"] = .string("") }
```

```ts
case "string":
  return (
    typeof value !== "string" ||
    value.length === 0 ||
```

```ts
const restored = Object.fromEntries(
  CALENDAR_FIELDS.filter((field) => before[field] !== undefined)...
```

```ts
const plan = registration.undo(args, evidence);
...
if (!plan || !target || !validateDeviceActionArguments(target.parameters, plan.arguments))
  return null;
```

删除一个没有备注或地点的日程（很常见）时，改前 `before` 不再省略这两个字段，而是带 `""`，于是整条删除都无法恢复；改地点/备注且原值为空时，正是作者声称要支持的场景，也仍然无法撤销。改动前，服务端测试 `test/integration/device-actions.test.ts:1361-1370` 的 `before` 不含 `location`/`notes`，计划是有效的。另一方面，即使校验放宽，`CalendarActions.compare`（`CalendarActions.swift:128-136`）和 `describe`（`:123-124`）会把空字符串与缺失值读成不同，读回也会判为不一致，因此“撤回原样”并不成立。

建议：撤销这次 `snapshot` 的空字符串补值，至少先恢复“删除无地点/备注的日程仍可撤销”。若要支持把字段恢复成“没有值”，需要在服务端明确设计清除语义（不要用普通参数里的空字符串绕过校验），并让读回比较接受该语义。

### 2. 中：没有端到端用例能证明 iPhone 实际生成的 before 能通过后端校验

文件：`clients/apple/Tests/HimawariCoreTests/DeviceActionUndoTests.swift:63-76`；`test/integration/device-actions.test.ts:1350-1411`

问题：新增测试只调用了静态 `DeviceActionExecutor.evidence`，手工构造的 `before` 不含空字符串；服务端撤销测试只直接调用 `registry.undo`，没有走 `#undoPlan` 的 `validateDeviceActionArguments`，其删除用例的 `before` 也恰好不含 `location`/`notes`。因此现有测试在意见 1 的错误代码上仍会全部通过。

证据（已证实）：测试只断言 `evidence["eventId"]`、`evidence["done"]`、`evidence["before"]`；服务端计划测试直接用：

```ts
const before = {
  title: "牙医复诊",
  start: "2026-11-13T15:00",
  end: "2026-11-13T16:00",
  allDay: false,
};
expect(plan("calendar.delete", { eventId: "evt-1" }, { before })).toEqual(...)
```

建议：增加一条经过真实 `CalendarActions.snapshot`/`evidence` 形状的 `before`（包含 `location:""`、`notes:""`）再走 `views()` 和 `POST actions/undo` 的用例，期望 `undo` 为 `available`、撤销返回 200；这条用例现在应当失败。另加一条“没有备注/地点的事件删除后仍能撤销”的回归用例。

### 3. 中：contact.update 原值为空时同样撤不回来（既有问题，本 PR 未覆盖）

文件：`clients/apple/Sources/HimawariActions/ContactActions.swift:81-89`；`packages/application/src/services/device-action-registry.ts:233-255`、`107-118`

问题：`describe` 总是输出 `givenName`、`familyName`、`organization`，`CNContact` 未设置时是空字符串。若这次修改的字段原值为空，`undoRestoring` 会把 `""` 放进反向参数，随后被同一个字符串校验拒绝，`undo` 为 `none`。作者说 `contact.update` 的 `before` 证据可用，但对“原值为空的字段”并不成立。

证据（已证实）：

```swift
"givenName": .string(contact.givenName),
"familyName": .string(contact.familyName),
"organization": .string(contact.organizationName),
```

这不是本次 diff 引入的回归，但与本次“让 iPhone 上报撤销证据”的目标属于同一类缺口，且没有测试覆盖。建议一并确认：要么实现清除字段的语义，要么明确这些情况不可撤销并给出测试；不要依赖空字符串。

### 4. 低：undoAction 允许不传确认签名，服务端测试表明未确认的撤销也会排队执行

文件：`clients/apple/Sources/HimawariCore/DeviceActions/DeviceActionAPI.swift:52-59`；`clients/apple/Tests/HimawariCoreTests/DeviceActionUndoTests.swift:50-54`；`test/integration/device-actions.test.ts:1331`

问题：客户端 API 的 `confirm` 是可选的，传 `nil` 时不申请挑战也不加确认签名；服务端把 `authenticated.confirmed` 直接作为 `ownerPresent`，并不强制所有撤销都带确认。现有 UI 路径始终传入确认签名，但未来复用这个公开 API 时可能漏掉，导致撤销在没有人脸确认的情况下执行。

证据（已证实）：

```swift
var challenge: String?
if confirm != nil { challenge = try await issueConfirmChallenge() }
```

服务端集成测试用无确认的 `devicePost` 调撤销，并期望它排队：

```ts
expect((await devicePost(h, client, "actions/undo", { id })).body).toMatchObject({
  state: "queued",
})
```

建议：把客户端 `undoAction` 的确认签名改成必填，或至少在服务端明确要求撤销必须有确认签名。若产品接受“设备密钥本身就可以撤销”，请在文档中写清，别让调用方以为不传确认也安全。

### 5. 低：演示数据让提醒事项显示“已撤销”，与“提醒事项不给撤销”矛盾

文件：`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionsDemo.swift:70-72`

问题：`dact_demo5` 的详情是“提醒事项里加了买转换插头”，却带 `"undo":"done"`。服务端动作登记表没有给提醒事项注册撤销，约束也说提醒事项不给撤销；演示页会显示一条现实中不会出现的“已撤销”提醒。

证据（已证实）：该条 JSON 同时包含

```json
"undo":"done",
"detail":{"zh-CN":"提醒事项里加了“买转换插头”"...}
```

建议：把这条改成日历动作，或把 `undo` 设为 `"none"`。

## 说法核对

- **“before 里缺的地点和备注补成空字符串是为了让改这两个字段也能撤回原样”**：与代码不符。空字符串会被服务端校验拒绝，撤销计划直接为空；即使校验接受，读回也会把空字符串与缺失值判为不同，不能“原样”。见意见 1。
- **“calendar.create 带顶层 eventId；calendar.update、calendar.delete、contact.update 带 before”**：不完全准确。`DeviceActionExecutor.evidence` 对任何 `made` 里有 `eventId` 的动作都会加顶层 `eventId`，所以 `calendar.update`/`calendar.delete` 也会带；服务端只用 `calendar.create` 的这个字段，当前无害，但说法比代码窄。
- **“服务端撤销计划只在证据齐全时才成立”**：方向正确，但“字段存在”不等于“能通过校验”；本次空字符串就是反例。
- **“撤销带确认签名才算主人亲自点”**：客户端正常路径正确；服务端未确认的撤销仍可能以非主人身份排队执行，见意见 4。
- **“不得改变发给模型的内容”**：按本次 diff 已核实成立，见必答问题 1。
- **“闹钟、提醒事项、家居不给撤销”**：服务端登记表符合；演示数据不符合，见意见 5。
- **“Mac 已验过 swift test 306 个和 iOS、Mac 构建”**：未核实，不能运行测试或构建。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 已核实：本次 12 个改动文件全在 Apple 客户端的设备动作、API、UI 和文案层，没有改系统提示、工具定义、历史消息拼装或遮盖逻辑；`DeviceActionExecutor` 把 `evidence` 发到 `POST actions/result`，服务端把它存进结果引用，我没有在现有代码里找到它进入模型请求的路径。新增会随时间变化的 `undo` 状态只存在于 `GET actions` 的视图和 Today 页 UI，不在模型请求里；发给模型的内容仍然只由原有代码在末尾追加。未核实：稀疏检出下是否有未检出的模型投影代码消费 `evidence`。

2. **不会让模型请求里的同一段文字变成不同字节。** 新增的 `eventId`、`before`、`undo` 都不是模型输入；它们的变化只影响设备结果和界面。需要提醒的是，`evidence` 是 Swift 字典，`JSONEncoder` 不保证键顺序；如果将来要求证据重发逐字节相同，需要固定序列化。当前两个消费端（服务端 `#undoPlan` 和客户端 UI）都按字段读取，不按字节比较，所以现在不构成问题。

3. **有部分自动检查，但关键反向用例缺失。** 已核实：`DeviceActionUndoTests` 覆盖了 `undo` 状态解码、带挑战码的签名请求、不传确认时不取挑战、404/409 映射、顶层 `eventId` 和空 `eventId` 的省略；这些断言在实现反向时确实会失败。缺失的是：没有任何用例让 `CalendarActions.snapshot` 生成的 `before` 走一遍服务端 `validateDeviceActionArguments`，也没有覆盖 `#undoPlan` 的完整删除/修改路径。因此意见 1 的回归不会被现有 Swift 测试或服务端撤销测试抓到。“swift test 306 个和 iOS/Mac 构建已通过”未核实。

4. **逐个值核对结果：**
   - `undo` 字符串：服务端 `device-action-service.ts:842-860` 产生 `none/available/pending/done/failed`，客户端 `DeviceActionModels.swift:216` 解码，未知值降级为 `none`；两端取值一致，可接受。
   - `actions/undo` 请求的 `id`：来自服务端视图的 `dact_...`，服务端 `device-api-routes.ts:940-946` 按 `DEVICE_ACTION_ID_PATTERN` 校验；两端一致，可接受。
   - 顶层 `eventId`：`DeviceActionExecutor.swift:230-235` 产生，服务端 `device-action-registry.ts:226-230` 的 `undoCreatedItem` 消费，`calendar.create` 可接受；`update/delete` 也会多产生一份但没有消费方，无害。EventKit 标识符长度是否总能通过 `eventId` 的 256 字符限制未核实。
   - `before.location`/`before.notes`：`CalendarActions.swift:22-23` 产生空字符串，服务端 `undoRestoring`/`undoDeletedEvent` 接受进计划，但随后被 `validateDeviceActionArguments` 的 `value.length === 0` 拒绝；**两端不兼容，这是意见 1 的核心**。
   - `before` 其他字段：`title`/`calendar` 为空或超长时同样会被服务端拒绝；这是既有行为，本次未变，但会让部分删除无法恢复，未逐一验证现实频率。
   - 本地化键：`actions.cannotUndo`、`result.undo`、`result.undo.pending/done/failed` 在 en/ja/zh-Hans 三份文件里都补齐，`DeviceActionViews.swift:109-126` 和 `DeviceActionsText.swift:17` 使用，可接受。
   - `DeviceActionUndoReply`：`DeviceActionAPI.swift:52-66` 产生，`DeviceActionsModel.swift:143-144` 消费，可接受。
   - 演示数据里的 `undo`：能被客户端解码，但与提醒事项不可撤销的规则冲突，见意见 5。
