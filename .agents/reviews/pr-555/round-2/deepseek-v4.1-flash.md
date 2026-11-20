## 本轮查过的范围

- 对照了 `a006b35..5f2e687` 的增量；其中真正属于 PR 555 的是 `5834935..HEAD` 的 21 个文件（提交 `8dd12e008`、`fa7edf798` 及合并）。`a006b35..5f2e687` 里还夹带了 origin/main 的 PR 576 改动，而 `5834935` 已包含 PR 576，所以那部分未重新复核。
- 读了：`CalendarActions.swift`、`DeviceActionExecutor.swift`、`DeviceActionAPI/Models/Views/Model/Demo.swift`、三份本地化、图标资源、Swift 测试、服务端 `device-action-registry.ts` / `device-action-service.ts` / `device-api-routes.ts`、相关集成测试，以及 `.agents/instructions/prompt-prefix.md`。

## 上一轮意见核对

- 1（给 before 补空串）：**只改好了一半**。删除日程的撤销现在不会因空串被后端拒绝，这条路径修好了；但“给原本没有地点/备注的事件加地点/备注”仍不能撤销，作者“让改这两个字段也能撤回原样”的说法与代码不符，见下面意见 2。
- 2（没有端到端用例证明 iPhone 生成的 before 能过后端校验）：**未真正解决**。新增的只是 JS 侧手写 `before` 的校验断言，没有经过 Swift 的 `CalendarActions.snapshot/describe`，见意见 4。
- 3（contact.update 原值为空撤不回）：**未改，仍存在**，已并入意见 2。
- 5（演示数据让提醒事项显示“已撤销”）：**已改好**。`DeviceActionsDemo.swift:73-75` 的 `dact_demo5` 已从提醒事项换成日历事件，`revert` 与“提醒事项不给撤销”不再矛盾。

## 意见

### 1. 中高：`.failed` 被做成可点的“撤销”按钮，但服务端明确不重试已失败的撤销

文件：`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionViews.swift:117-123`、`DeviceActionsModel.swift:138`、`DeviceActionAPI.swift:60`、`test/integration/device-actions.test.ts:1307-1347`

问题：UI 把 `.available` 和 `.failed` 放在同一个 `case` 里出按钮，`DeviceActionsModel.undo` 也放行 `.failed`。但服务端对“反向动作本身失败”的撤销是幂等重放，不会新建一次尝试：

```swift
case .available, .failed:
    Button(action: undo) { ... }
    .disabled(busy)
```
```swift
guard let api, view.undo == .available || view.undo == .failed, !busy.contains(view.id) else { return }
```
```swift
return .recorded(state: try decode(Reply.self, data).state)
```

服务端测试已经写死：

```ts
const again = await devicePost(h, client, "actions/undo", { id });
expect(again.body).toEqual({ id: reverse[0]?.id, state: "failed" });
expect((await rows(h)).length).toBe(before);
expect((await devicePost(h, client, "actions/claim", {})).body["actions"]).toEqual([]);
```

也就是说：用户点 `.failed` 行的“撤销”会先走面容挑战、再发两个请求，服务端 200 返回 `state: "failed"`，客户端把任何 `.recorded` 都当成功（`DeviceActionsModel.swift:144` 不设 `problem`），最后界面什么都不变。用户只白白过了一次面容。这也与本轮材料里“pending、done、failed 显示文字”的目标不一致。

建议：`.failed` 不要出可点按钮，恢复为文字（通用“没撤成”即可）；如果确实要允许重试，服务端必须为失败的反向动作开一次新的 invocation，并在响应里给出可区分的新状态，同时补一条“失败后重试会新建动作”的用例。当前实现下应删除 `.failed` 的按钮和 `DeviceActionsModel` 里的放行。

### 2. 中：删掉空串补丁后，改地点/备注原值为空仍撤不回；作者说法与代码相反

文件：`clients/apple/Sources/HimawariActions/CalendarActions.swift:18-21,118-119`、`packages/application/src/services/device-action-registry.ts:239-244`、`clients/apple/Sources/HimawariActions/ContactActions.swift:81-89`、`test/integration/device-actions.test.ts:1385-1391`

问题：现在的 `snapshot` 只返回 `describe(event)`，`describe` 只在字段非 nil 时写入地点和备注：

```swift
public func snapshot(_ delivery: DeviceActionDelivery) async throws -> JSONObject? {
    guard delivery.action != "calendar.create" else { return [:] }
    return try event(delivery).map(Self.describe)
}
...
if let location = event.location { value["location"] = .string(location) }
if let notes = event.notes { value["notes"] = .string(notes) }
```

这对 `calendar.delete` 的撤销是必要的，因为 `undoDeletedEvent` 会跳过缺失字段；但对 `calendar.update`，`undoRestoring` 要求被修改的字段在 `before` 里必须存在：

```ts
const changed = fields.filter((field) => args[field] !== undefined);
if (changed.length === 0 || changed.some((field) => before[field] === undefined)) return null;
```

所以“原本没有地点/备注，后来加了一个”这种 `calendar.update` 仍然算不出撤销计划，结果行会显示 `none`，没有撤销按钮。测试也把这个行为固定成了 `null`：

```ts
plan("calendar.update", { eventId: "evt-1", title: "新", location: "东京" }, { before: { title: "旧" } })
// 期望 null
```

同一问题还留在 `contact.update`：`ContactActions.describe` 总是把 `givenName/familyName/organization` 写成字符串，哪怕原值是空串；而 `fieldProblem` 对所有字符串都拒绝 `value.length === 0`，所以原来为空的名字/公司改过以后同样无法撤销。这正是上一轮意见 3，本 PR 没有覆盖。

另外，本轮材料说“空的地点和备注补成空字符串”，但当前代码已经不补了，作者说法与代码不一致。

建议：先明确产品语义。如果要支持“恢复成没有值”，需要给“清空”一个合法表示（例如可被校验和 handler 接受的显式清空值），而不是空串；否则应在 PR 描述和文档里明确“原值缺失的地点/备注不提供撤销”，并删掉“补空串是为了撤回原样”的说法。`contact.update` 的空串快照要么改为缺失字段，要么允许清空值。

### 3. 中：撤销失败的红字原因取错了字段，生产环境只会显示兜底文案；演示数据伪造了原因

文件：`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionViews.swift:101-105,139-142`、`packages/application/src/services/device-action-service.ts:335-348,842-860`、`DeviceActionsDemo.swift:70-72`

问题：界面在 `view.undo == .failed` 时显示 `view.reason`：

```swift
if view.undo == .failed {
    Text(Self.undoFailure(view))
}
...
guard let reason = view.reason, !reason.isEmpty else { return L.text("result.undo.failed") }
return reason
```

但 `view.reason` 来自**原动作**的结果，不是反向动作的失败原因：

```ts
async #outcome(record: DeviceActionRecord): Promise<DeviceActionRequestOutcome> {
  ...
  reason: record.reasonCode === null ? reported : (MODEL_REASONS[record.reasonCode] ?? reported),
```

而 `undo` 状态是从另一条反向 invocation 读出来的：

```ts
const reverse = ownerReverse ?? (plainReverse?.state === "rejected" ? null : plainReverse);
if (reverse) {
  if (reverse.state === "succeeded") return "done";
  return reverse.state === "failed" || ... ? "failed" : "pending";
}
```

原动作是 `succeeded` 时，服务端报告成功会强制清空原因（`reasonCode` 为 `null`，且成功报告不接受 reason），所以正常情况下 `view.reason` 是 `null`，界面只会显示兜底的“没撤成”。反向动作真正的失败原因没有进入这个 view。演示数据却给一个 `state: "succeeded"` 且 `undo: "failed"` 的行直接写了 `reason`，这是服务端正常不会产生的形状，容易让后续开发误以为原因已经打通。

建议：在服务端把反向动作的失败原因带进 view 之前，界面只显示固定的“没撤成”/“撤不了”，不要读 `view.reason`；或者新增一个明确的 `undoReason` 字段并由服务端从反向 invocation 填充。演示数据不要伪造生产不会有的 `reason`。

### 4. 中：空串补丁的修复没有对应的自动检查，新增断言在修复前也会通过

文件：`test/integration/device-actions.test.ts:1372-1376`、`clients/apple/Sources/HimawariActions/CalendarActions.swift:18-21`、`clients/apple/Tests/HimawariCoreTests/DeviceActionUndoTests.swift`

问题：新增的测试只是把一个手写的 `before` 交给服务端校验，并没有调用 Swift 的 `CalendarActions.snapshot/describe`：

```ts
const before = { title: "牙医复诊", start: "...", end: "...", allDay: false };
...
const create = DEVICE_ACTION_REGISTRY.get("calendar.create");
expect(create && validateDeviceActionArguments(create.parameters, before)).toBeDefined();
expect(
  create && validateDeviceActionArguments(create.parameters, { ...before, location: "" }),
).toBeUndefined();
```

即使有人把 `CalendarActions.swift` 里的 `location`/`notes` 空串补丁加回去，这两条断言仍然会通过，因为 `before` 根本不由 Swift 产生。Swift 测试文件只覆盖 undo 状态解码、结果种类、API 请求和 evidence，没有覆盖 `snapshot/describe` 的字段缺失行为。因此“修复前会失败、修复后通过”的反向用例并不存在。

建议：在 Swift 侧给 `CalendarActions.describe` 补用例（无地点/备注时输出不含这两个键，事件有值时原样输出），或者建立一个把 Swift 实际 `before` JSON 喂给 `validateDeviceActionArguments` 的端到端夹具。再加一条对 `.failed` 重试行为的反向用例：如果服务端返回 `state: "failed"`，客户端不应显示可点的撤销按钮。这样本轮两个关键修复才真正有门槛。

## 推测与未核实

- 没有运行 Swift 测试和 iOS/Mac 构建，作者说的“swift test 306 个、iOS/Mac 构建已验”未核实。
- EventKit 是否会把“空地点/空备注”保存成 `""` 而不是 `nil` 未核实；如果会返回 `""`，那么删除这类事件时 `before` 仍会带空串，`undoDeletedEvent` 生成的 `calendar.create` 参数会被后端拒绝，撤销仍不可用。这属于边缘情况，需要真实设备验证。
- `a006b35..5f2e687` 中来自 origin/main 的 PR 576 改动不在本轮复核范围，未重新审查。

## 侧重检查

- **错误路径**：404/409 被映射为 `notFound`/`notUndoable`，客户端给“已经撤不了了”，这条正确。网络错误给“没发出去”，正确。200 但 `state: "failed"` 的重放被当成成功，是意见 1 的核心错误路径。撤销失败无原因时兜底文案不会崩，安全。
- **不合规范/不可信输入**：`undo` 状态未知字符串会落到 `.none`，不会误显示按钮；`view.reason` 由设备上报、服务端限长，SwiftUI `Text` 会转义，没有注入问题，但来源字段错（意见 3）。服务端仍按 `validateDeviceActionArguments` 校验反向参数，缺失字段会返回 `null` 而不是发出非法动作。
- **安全**：App 路径 `DeviceActionsModel` 总是传非空 `confirm`，会取挑战并带确认签名；服务端以 `authenticated.confirmed` 作为 `ownerPresent`。`undoAction` API 本身允许 `confirm: nil`，但那只走非主人路径，没有新增绕过。撤销计划只从设备上报的 evidence 推导，没有新增越权删除/修改入口。
- **资源耗尽**：`.failed` 行可无限点，每次都会面容挑战加两个 HTTP 请求；服务端虽然幂等重放、不新增行，但这是可避免的无效请求和面容消耗，见意见 1。
- **不可撤销操作**：撤销只针对 `succeeded` 且有 evidence 的动作；`calendar.delete` 的撤销是新建事件而非恢复原 id，行为没有因本轮增量改变。没有发现新增的不可撤销写路径。
- **规则/文档与代码一致性**：本轮没有改任何发给模型的提示词、工具定义或遮盖逻辑。作者材料中“before 补空串”与代码不一致（意见 2）；“failed 给红字原因”在生产拿不到原因（意见 3）；“failed 显示文字”与现在的按钮实现不一致（意见 1）。

## 必答问题

1. **不会改变模型已经见过的请求开头。** PR 555 的 21 个文件里没有系统提示、工具定义、历史拼装、遮盖或压缩代码；新增的 `eventId`/`before` 是设备上报的证据，随当前 `device_action` 的工具结果在末尾出现，不会插到历史中间。每轮会变的撤销状态、挑战码只用于设备请求和界面，不进入模型请求。`a006b35..5f2e687` 夹带的 PR 576 改动不属于本 PR，`5834935..HEAD` 也没有提示词文件变化。

2. **不会让模型请求里同一段文字变成不同字节。** 本轮没有碰遮盖、JSON 序列化顺序或模型请求参数。设备撤销的请求体只有一个固定的 `id` 键；挑战码是签名用途的一次性随机值，不是发给模型的内容。EventKit 生成的 `before` 可能随设备日历状态变化，但它是设备证据，不是模型提示的一部分。

3. **自动检查不充分，关键反向用例不会失败。** 新 Swift 测试覆盖了撤销状态解码、结果种类、API 请求形状和 evidence 的 `eventId`；新增 JS 断言覆盖了服务端对 `calendar.create` 参数的校验。但 `before` 的 Swift 生成路径没有测试，新增断言在补空串的旧代码上也会通过；`.failed` 重试也没有测试，而按服务端现有行为补上用例会直接暴露意见 1。

4. **逐个核对结果如下。** 能对上：`DeviceActionUndoState` 五个值在服务端与 Swift 两端一致；`eventId` 的产生处 `DeviceActionExecutor.swift:234` 与使用处 `device-action-registry.ts:228-229` 名字一致；`before` 的字段名与 `undoRestoring`/`undoDeletedEvent` 读取的字段一致；`result.undone` 本地化键只被 `DeviceActionViews.swift:154` 使用，删除的 `result.undo.pending/done` 已无引用；`arrowBackUp` 的图标资源、`icons.json` 和代码名字一致；演示数据 id 唯一。不能接受/不一致的有：`.failed` 的客户端使用端假设可以重试，服务端实际拒绝重试（意见 1）；`view.reason` 的使用端以为它是撤销失败原因，生产产生端给的是原动作原因且成功时为空（意见 3）；`before` 缺失字段在 `calendar.update`/`contact.update` 上会让撤销计划直接变成 `null`，而作者描述仍说空值可以恢复（意见 2）；`contact.update` 的空串仍会被后端校验拒绝（上一轮意见 3 未覆盖）。
