本轮查过的范围：增量 `5f2e6871e..aa55a0682` 只改了 3 个 Swift 文件和复核记录，我逐行看了 `DeviceActionViews.swift`、`DeviceActionsModel.swift`、`DeviceActionsDemo.swift` 的增量；为核对上一轮意见，跟读了 `CalendarActions.swift`、`device-action-registry.ts`、`device-action-service.ts`、`device-api-routes.ts`、`device-request-signature.ts`、`DeviceActionUndoTests.swift`、`test/integration/device-actions.test.ts` 和三份 `Localizable.strings`。没有编译或运行 Swift 测试。

上一轮意见状态：意见 1 确已修好（`.failed` 不再出按钮，模型中也不接受）；意见 3 确已修好（红字固定为 `result.undo.failed`，演示数据去掉了伪造的 `reason`）；意见 2、4 没有修，下面的意见 2、3 是它们；意见 4 的测试缺位到这一轮仍然成立。

### 1. 中：作者说 before 缺地点/备注会补空串，当前代码已不补；恢复这一做法会重新让删除无法撤销

文件:行：`clients/apple/Sources/HimawariActions/CalendarActions.swift:18-21`、`118-119`；`packages/application/src/services/device-action-registry.ts:110-113`、`243-244`；`packages/application/src/services/device-action-service.ts:837`

问题：作者说法里的“before 里缺的地点和备注补成空字符串”与当前代码相反。`snapshot` 已直接返回 `describe(event)`，`describe` 只在 `location`/`notes` 非 nil 时才写入。若按作者说法把缺失值补成 `""`，`undoDeletedEvent` 会把 `location: ""` 放进 `calendar.create` 的恢复参数，而服务端字符串字段明确拒绝空串，`#undoPlan` 又会校验撤销计划的参数，于是“删除日程”的撤销再次变成不可用。这是上一轮已确认的高风险回归点。

证据（亲自读到）：
```swift
// CalendarActions.swift:18-21
public func snapshot(_ delivery: DeviceActionDelivery) async throws -> JSONObject? {
    guard delivery.action != "calendar.create" else { return [:] }
    return try event(delivery).map(Self.describe)
}
// CalendarActions.swift:118-119
if let location = event.location { value["location"] = .string(location) }
if let notes = event.notes { value["notes"] = .string(notes) }
```
```ts
// device-action-registry.ts:110-113
typeof value !== "string" ||
value.length === 0 ||
...
// device-action-registry.ts:243-244
const changed = fields.filter((field) => args[field] !== undefined);
if (changed.length === 0 || changed.some((field) => before[field] === undefined)) return null;
```
```ts
// device-action-service.ts:837
if (!plan || !target || !validateDeviceActionArguments(target.parameters, plan.arguments))
  return null;
```

建议：修正说明，明确“快照不补空串”；不要恢复补空串。若确实要支持把地点/备注恢复成空，应由服务端定义明确的清除语义（例如允许 `null` 或专用清除字段）并为其加校验和测试。

### 2. 低：上一轮第 2 条未修——原本没有地点/备注的日程，改成有值时撤不回来

文件:行：`packages/application/src/services/device-action-registry.ts:243-244`；`clients/apple/Sources/HimawariActions/CalendarActions.swift:118-119`

问题：触发条件是原事件 `location`/`notes` 为 nil，`calendar.update` 只改这两个字段之一。`snapshot` 不写缺失字段，`undoRestoring` 又要求“所有被改字段都必须出现在 `before` 里”，于是返回 `null`，服务端把 undo 状态算成 `none`，今天页不出现撤销入口。作者在提交说明里写的是“产品决定、不修”，这不是已修好；代码也确实维持现状。

证据（亲自读到）：
```ts
const changed = fields.filter((field) => args[field] !== undefined);
if (changed.length === 0 || changed.some((field) => before[field] === undefined)) return null;
```
```swift
if let location = event.location { value["location"] = .string(location) }
if let notes = event.notes { value["notes"] = .string(notes) }
```

建议：如果接受这个限制，就在 PR 说明和用户可见文案里写清“从空改成有值的改动不支持撤销”；要真正支持，需要服务端增加清除/空值语义，不能靠客户端补空串。

### 3. 低：上一轮第 4 条未修——新增断言证明不了客户端快照不再补空串

文件:行：`test/integration/device-actions.test.ts:1372-1376`；`clients/apple/Sources/HimawariActions/CalendarActions.swift:20`

问题：新增断言只验证服务端 `calendar.create` 拒绝空串，这在修复前后都成立，完全不触碰 `CalendarActions.snapshot`。把 `snapshot` 里补空串的代码恢复，这些断言仍然通过，反向用例不会失败。

证据（亲自读到）：
```ts
const create = DEVICE_ACTION_REGISTRY.get("calendar.create");
expect(create && validateDeviceActionArguments(create.parameters, before)).toBeDefined();
expect(
  create && validateDeviceActionArguments(create.parameters, { ...before, location: "" }),
).toBeUndefined();
```
```swift
return try event(delivery).map(Self.describe)
```

建议：为 `CalendarActions.snapshot` 的“不带 location/notes 的事件不产生这两个键”加一个真正能失败的 Swift 测试（可用假事件或把 `describe` 提取成可测函数），不要用服务端校验测试代替。

### 4. 低：本轮 `.failed` 不再可点、红字固定文案，两处都没有自动检查

文件:行：`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionViews.swift:117-129`、`139-141`；`DeviceActionsModel.swift:138`；`clients/apple/Tests/HimawariCoreTests/DeviceActionUndoTests.swift:33-38`

问题：本轮把 `.failed` 从可点按钮改成 `EmptyView`，并把失败原因改成固定本地化文案，但没有任何测试覆盖“`.failed` 不调撤销”“固定文案不是原动作 reason”。现有 `DeviceActionUndoTests` 只断言 `.failed` 的解码分类是 `.done`，与本轮行为无关；把 `case .available, .failed` 和模型 guard 改回去，测试仍全部通过。按项目规则，本轮刚修好的错误缺少能证明它的回归测试属于“会出错”。

证据（亲自读到）：
```swift
switch view.undo {
case .available:
    Button(action: undo) { ... }
...
case .done, .failed, .none:
    EmptyView()
}
...
static func undoFailure(_ view: DeviceActionView) -> String {
    L.text("result.undo.failed")
}
```
```swift
guard let api, view.undo == .available, !busy.contains(view.id) else { return }
```
```swift
#expect(DeviceActionResultKind(try view("failed")) == .done)
```

建议：把“该行是否提供撤销”和“失败文案”提取成可测的纯函数，至少断言 `.failed`/`.done`/`.none` 不提供撤销且文案固定；若能构造模型测试，再断言 `.failed` 时不会发出 `actions/undo` 请求。

**读代码证实的**

- 意见 1 已修好：`DeviceActionViews.swift:118` 只有 `.available` 出按钮，`:128` 把 `.failed` 归入 `EmptyView`；`DeviceActionsModel.swift:138` 的 guard 也只接受 `.available`。
- 意见 3 已修好：`DeviceActionViews.swift:139-141` 固定返回 `result.undo.failed`；`DeviceActionsDemo.swift:70-72` 已删除 `dact_demo6` 的 `reason`。`result.undo.failed` 在 en/ja/zh-Hans 三份 `Localizable.strings:48` 都存在。
- 服务端 `views` 里的 `reason` 确实来自原动作的结果（`device-action-service.ts:925` `reason: outcome.reason`），不是撤销失败原因，因此固定文案避免了继续取错字段。
- 作者说法“撤销带确认签名才算主人亲自点”在客户端成立：`DeviceActionsModel` 的 `confirm` 实际非空，`DeviceActionAPI.undoAction` 在 `confirm != nil` 时先取挑战码并带 `confirmSigner` 发送；服务端 `device-request-signature.ts:290-296` 只有 confirm 签名验证通过才把 `confirmed` 置真，`device-api-routes.ts:946` 用 `authenticated.confirmed` 作为 `ownerPresent`。服务端也接受未签名撤销，但那只记为非主人现场操作，与“签名才算主人亲自点”不矛盾。
- 作者说法“pending、done、failed 显示文字”不准确：`.pending` 是禁用的 spinner（`DeviceActionViews.swift:124-127`），`.done`/`.none` 在撤销控件处什么都不显示，`.failed` 的红字是在 `:101-106` 单独渲染的；`.done` 的“已撤销”来自标题 `result.undone`，不是撤销控件文字。
- `undoFailure(_:)`、`.failed` 分支和演示 JSON 的直接使用端都已找到，没有第二处调用 `model.undo`，没有遗留可点的 `.failed` 入口。

**推测（未核实）**

- `CalendarActions.describe` 对 `title`、`calendar` 用 `?? ""`（`:112`、`:116`）。如果 EventKit 对某些异常事件返回空串，`undoDeletedEvent` 会把空串带进 `calendar.create`，仍会被服务端拒绝；EventKit 是否会产生这种空串未核实。
- 若撤销请求成功入队后客户端 `refresh()` 失败，`recent` 会保留旧的 `.available` 快照，用户仍可能再点一次并重放已失败的撤销。这是刷新失败下的旧状态问题，未构造复现。

**侧重检查**

- 错误路径：404/409 在 `DeviceActionAPI.swift:61-65` 分别映射为 `.notFound`/`.notUndoable`，模型对两者都显示“撤不了”；其他错误显示“没发出”。本轮没有改这些路径。`.failed` 的重放路径已由视图和模型 guard 挡住。
- 不可信输入与安全：撤销 id 来自服务端返回的 `DeviceActionView.id`，服务端 `device-api-routes.ts:940-947` 用 `only(body, ["id"])` 和 `DEVICE_ACTION_ID_PATTERN` 校验；确认签名使用服务器挑战码，`confirmed` 只在 confirm 签名验证通过时成立。固定红字后不再把服务端 `reason` 直接渲染成撤销失败原因，减少了误导/注入面。
- 不可撤销操作：本轮把 `.failed` 的撤销入口去掉，避免了重复面容和幂等重放；但意见 2 的“从无到有改地点/备注不能撤销”仍是不可撤销的限制。
- 资源耗尽：增量只改本地 UI 分支和字符串，没有新增循环、大小分配或可被外部输入放大的路径。
- 规则、说明与代码一致：`.agents/instructions/model-review.md:55` 把“说明与代码/事实不符”和“已确认错误缺测试”都归为“会出错”；本轮作者说明里的空串补齐、pending 显示文字与代码不符，已在上面列出。
- 未核实：作者称 Mac 上 `swift test` 306 个及 iOS/Mac 构建通过；当前环境无法运行 Swift，未验证。

**必答问题**

1. 不涉及。增量只改 iOS 本地结果行、模型 guard 和演示 JSON，没有触碰系统提示、工具定义、历史消息或遮盖逻辑；发给模型的内容仍是只在末尾追加，每轮会变的值仍在最后一条消息里，符合 [prompt-prefix 规则](../../.agents/instructions/prompt-prefix.md#rules) 的第 4 条要求。
2. 不会。增量没有改模型请求的序列化；新增的固定文案只影响本地界面。撤销请求体仍是固定 `{id}`，挑战码和签名按设计每次不同，但那是设备 API 请求，不是模型请求内容，也没有新增依赖前后文的遮盖或无序集合。
3. 没有。意见 3 和意见 4 对应的自动检查都不存在；意见 4 尤其明确：现有测试只覆盖解码和 API 调用，不覆盖视图按钮和模型 guard，反向改动不会让测试失败。意见 3 的集成断言只验证服务端拒绝空串，也不覆盖客户端快照。
4. 增量产生/修改的值逐个核对过：`DeviceActionUndoState.failed` 的显示分支只由 `DeviceActionViews.swift:117-129` 消费，`DeviceActionsModel.swift:138` 的 guard 接受同一枚举，演示数据 `DeviceActionsDemo.swift:70` 的 `"failed"` 能正常解码；`undoFailure` 只在 `DeviceActionViews.swift:102` 使用；`result.undo.failed` 在三种语言的本地化文件里都存在；本轮没有新增或修改配置键、导出函数、清单项或序列化格式。`reason` 从演示数据删除后仍是可选字段，解码和使用端都能接受。
