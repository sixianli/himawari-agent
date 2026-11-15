### 1. 高：新增 Swift 调用方没有同步 `ci/operations-pending.json`，`npm run check:operations` 会报 `OPERATION_PENDING_BUT_COMPLETE`

文件:行：`ci/operations-pending.json:20-23`；`scripts/check-operations.mjs:315-329,419-433`；`clients/apple/Sources/HimawariManage/Settings/ProactiveSession.swift:43-44,56-68,113-126`。

问题：这四个操作在待补清单里都写着“缺：调用方”，本 PR 正好在 `clients/apple/Sources` 里加上了调用方；脚本会把 Swift 源文件当调用方扫，后端、调用方、测试三项齐全后，仍在 `operations` 名单里就会报红。

证据（读代码证实）：
- 清单原文：`"proactive.pause": "...（缺：调用方）..."`、`"proactive.source.settings.set": "...（缺：调用方）..."`、`"proactive.source.switch_off": "...（缺：调用方）..."`、`"proactive.sources.read": "...（缺：调用方）..."`。
- 脚本扫描范围包含 Swift：`...walk(root, SWIFT_ROOT, ..., [".swift"])`；失败分支明确写着：`if (missing.length === 0 && reason !== undefined) errors.push('OPERATION_PENDING_BUT_COMPLETE ...')`。
- 新调用方：`gateway.read(.v2, "proactive.sources.read")`、`gateway.command(.v2, "proactive.pause", ...)`、`"proactive.source.switch_off"`、`"proactive.source.settings.set"`。
- `package.json:27` 的 `check:steps` 包含 `npm run check:operations`。我没有运行命令（工具限制），但这是脚本里的固定分支，不是推测。

建议：把这四个操作从 `ci/operations-pending.json` 的 `operations` 中移出，更新说明，然后跑 `npm run check:operations`。这是本 PR 目前最确定的阻断项。

### 2. 中：完成/不再提醒没有撤销入口，iPhone 上不可撤销；网页有 `reopen`

文件:行：`clients/apple/Sources/HimawariManage/Settings/ProactivePages.swift:181-186`；`clients/apple/Sources/HimawariManage/Settings/ProactiveSession.swift:72-84`；`clients/apple/Sources/HimawariCore/Proactive.swift:141`；网页 `apps/control-center/src/components/proactive-reminders.tsx:121-131`。

问题：卡片只给 `done` 和 `mute`，没有 `reopen`；成功后会 `reloadOverview`，`openInsights` 只保留 `status == "open"`，这条提醒就从列表消失。网页在完成/不再提醒后会给一个撤销入口，调用 `respondInsight(insight, "reopen")`；iPhone 没有对应 UI。

证据（读代码证实）：
```swift
Button { respond(.mute, nil) } label: { Text(M.proactiveMute) }
Button { respond(.done, nil) } label: { Text(M.proactiveDone) }
```
```swift
let open = insights.filter(\.isOpen)
```
网页：
```tsx
() => void proactive.respondInsight(insight, "reopen"),
```

建议：加一个撤销提示/“已处理”区，至少让 `reopen` 可达；这是明确的不可撤销操作，且用户已经在 Face ID 确认后仍可能想反悔。

### 3. 低/中：来源数据加载失败没有可用的重试路径，页面还显示“下拉再试一次”

文件:行：`clients/apple/Sources/HimawariManage/Settings/ProactivePages.swift:31-35,110,329-374`；`clients/apple/Sources/HimawariManage/ManageStrings.swift:31-33`；`clients/apple/Sources/HimawariManage/ManageDemo.swift:33,89`。

问题：`ProactivePage` 的下拉刷新只调用 `reloadOverview()`，不重试 `reloadSources()`；初次来源读取失败后 `hasSources` 为 false，来源入口被隐藏，下拉也无法恢复。`ProactiveSourcePage` 则完全没有 `.task` 或 `.refreshable`，当 `sources == nil`（例如 demo 直接进入 `proactiveSource` 场景）时只显示 `M.loadFailed`，而这段文案是“没读到，下拉再试一次”，页面却无法下拉重试。

证据（读代码证实）：
```swift
.task { await session.reloadOverview(); await session.reloadSources() }
.refreshable { await session.reloadOverview() }
private var hasSources: Bool { !(session.sources ?? []).isEmpty }
```
```swift
} else {
    SheetHeader(title: M.proactiveSources, leading: .back, action: back)
    EmptyStateView(Text(M.loadFailed))
}
```
`ProactiveSourcePage` 的 `body` 到这里结束，没有 `.task`/`.refreshable`。

建议：给 `ProactiveSourcePage` 加 `.task`/`.refreshable`；`ProactivePage` 的下拉刷新同时重试 `reloadSources()`，或把“加载失败”改成带重试按钮的状态。

### 4. 低：Insight 打分入口与网页不一致；网页只在 `pushed` 时给打分

文件:行：`clients/apple/Sources/HimawariManage/Settings/ProactivePages.swift:187-189`；网页 `apps/control-center/src/components/proactive-reminders.tsx:174-187`；服务端 `apps/agent-service/src/production-proactive.ts:787-791`。

问题：iPhone 对每个 open insight 都显示 `useful/unneeded`；网页只有 `insight.pushed` 为 true 时才显示打分。作者说法 3 里“insight 打分只有 useful、unneeded，且不能清空”本身成立（服务端确实拒绝 `rate + null`），但“和网页一致”只对检查记录成立；网页的 `RatingChoices` 还会在再点当前项时发 `null`，只是服务端会拒绝。

证据（读代码证实）：
```swift
RatingChoices(choices: [.useful, .unneeded], current: insight.ownerRating, ...)
```
网页：
```tsx
{insight.pushed ? (
  ...
  <RatingChoices choices={["useful", "unneeded"]} ... />
) : null}
```
服务端：
```ts
if (action === "rate" && rating === null)
  throw new ApplicationPortError(... "PROACTIVE_RATING_REQUIRED");
```

建议：如果产品语义是“只评价推送过的提醒”，在 iPhone 上也按 `insight.pushed` 或 `result` 收紧；否则在说明里明确这是与网页不同的取舍。

### 5. 低：`ProactiveErrors.declined` 把所有未知错误当成用户取消，真正失败会被静默吞掉

文件:行：`clients/apple/Sources/HimawariManage/Settings/ProactivePages.swift:6-9,118-121,236-239,407-410`；`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:117-120`。

问题：`declined` 的实现是“不是已知错误类型就算用户取消”，因此任何新的、包装过的或意外的错误都不会进入 `failed = true`，用户看不到 `M.actionFailed`。同一模块已有 `SettingsStore.isDeclined`，这里又复制了一份，后续容易分叉。

证据（读代码证实）：
```swift
static func declined(_ error: Error) -> Bool {
    !(error is ManageGatewayError || error is DeviceAPIError || error is DeviceKeyError
      || error is DecodingError || error is URLError || error is HTTPExchangeError)
}
```
```swift
} catch where ProactiveErrors.declined(error) {
} catch {
    failed = true
}
```

建议：复用 `SettingsStore.isDeclined`，或只把明确的取消错误（例如 `CancellationError`）当作用户取消；其他未知错误应上报。

### 6. 低：20 条 insight、30 条 decision 是硬编码截断，静默丢弃服务器数据

文件:行：`clients/apple/Sources/HimawariManage/Settings/ProactivePages.swift:20,81,203,209`。

问题：`openInsights(limit: 20)` 和 `recentDecisions(limit: 30)` 只显示前缀，没有“还有更多”的提示；网页会显示全部决策记录。作者说法 4 的“界面上每个数字都来自服务器字段”大致成立，但这两个数字是客户端硬编码的显示上限，不是服务器字段，也会让用户误以为记录只有这些。

证据（读代码证实）：
```swift
private static let insightLimit = 20
...
let pending = overview.openInsights(limit: Self.insightLimit)
```
```swift
private static let limit = 30
...
let decisions = overview.recentDecisions(limit: Self.limit)
```

建议：由服务器返回的分页/上限决定，或至少显示“仅显示最近 30 条/还有更多”；如果只是临时限制，在页面上说明。

### 7. 低：作者说法“来源字段以 `apps/control-center/src/proactive.ts` 为准”与代码不符

文件:行：`apps/control-center/src/proactive.ts:64-92,231-260`；`packages/gateway-contracts/src/contracts-v2.ts:1548-1589`；`apps/agent-service/src/production-proactive.ts:921-963`。

问题：`proactive.ts` 的 `ProactiveModel` 只有 overview、settings、insight、decision、review、source.manage、backoff 等；没有 `proactive.sources.read`、`proactive.source.settings.set`、`proactive.source.switch_off`，也没有来源类型。仓库里的 control-center 目前也没有“来源”页。因此来源操作的字段只能以 `contracts-v2.ts` 和服务端处理代码为准，“网页有来源页”这个前提在 control-center 代码里找不到。

证据（读代码证实）：
- `proactive.ts` 的模型方法到 `restoreBackoff` 为止，没有 source settings。
- 来源契约在 `contracts-v2.ts:1548-1589`，服务端处理在 `production-proactive.ts:921-963`；这两处与 Apple 的 payload 字段是对得上的。

建议：修正 PR 说明/验收依据，明确来源页是 iPhone 先行，网页端尚未实现；不要把 `proactive.ts` 说成来源字段的依据。

### 8. 低（推测）：`ProactiveDayLimit` 的步进计算在极端快照值下可能整数溢出

文件:行：`clients/apple/Sources/HimawariCore/Proactive.swift:178-187`；契约 `packages/gateway-contracts/src/contracts-v2.ts:1542-1547`。

问题：契约对 `minimum`/`maximum` 只有 `integer(1)`，没有上限；`step` 里 `step *= 10`、`stepUp` 里 `value + step` 都是普通 `Int` 运算。如果服务器返回异常大的边界/当前值，可能触发 Swift 运行时溢出崩溃。

证据（读代码证实，但触发条件为推测）：
```swift
let span = max(1, maximum - minimum)
var step = 1
while span / (step * 10) >= 20 { step *= 10 }
...
public func stepUp(from value: Int) -> Int { clamped(value + step) }
```
生产服务器当前是代码常量、范围很小，所以正常路径不会触发；这是防御性/异常输入问题。

建议：用 `Int.max` 保护或 `dividedReportingOverflow`/`addingReportingOverflow`，或先限制边界再计算。

**作者说法核对（对照代码）**

- 说法 1：成立。关闭走 `proactive.pause`（能力表 `tighten`），`ManageGateway.command` 对 `tighten` 不取 challenge，测试也断言 nonce 为 nil；打开走 `proactive.settings.set`，`settingsPayload` 保留 overview 的 `quietHours` 和 `importantSenders`。
- 说法 2：成立。`change` 只在“来源原本是开、现在关、两个上限都没改”时发 `proactive.source.switch_off`，其余发 `proactive.source.settings.set`，四个字段齐全；服务端契约只接受这四个字段，服务端测试还明确拒绝 `switch_off` 带额外字段。
- 说法 3：检查记录的规则与网页一致：`pushed/deferred` → `useful/unneeded`，`silent` → `missed`，其余为空。Insight 的 `rate` 不允许 null 这一点与服务端一致；但“和网页一致”不准确，见意见 4。
- 说法 4：大部分成立；统计/周报确实没做。但 20/30 是硬编码显示上限，`ProactiveSource.dailyLimitReached` 解码后没有在界面使用，不能算“每个字段都展示了”。
- 说法 5：成立。diff 只有 `clients/apple` 和复核材料，没有模型请求组装、系统提示、工具定义、历史或遮盖代码。

**侧重检查**

- 错误路径：重点看了 `declined` 吞错（意见 5）、来源加载失败无重试（意见 3）、操作清单缺更新（意见 1）。`ProactiveSession` 的读失败会保留旧快照，界面没有“旧数据”标记，但不会崩溃。
- 不可信/异常输入：未知 `rating` 字符串被忽略为 nil（有测试）；未知 verdict 走默认分支；未知 priority 返回 nil；非法 `days`/时间由服务端契约先挡。`ProactiveDayLimit` 的极端值算术是唯一想得到的崩溃面（意见 8，推测）。
- 安全/权限档位：`proactive.pause` 和 `proactive.source.switch_off` 是 `tighten`，无 Face ID；`proactive.settings.set`、`proactive.source.settings.set`、`proactive.insight.respond`、`proactive.decision.rate`、`proactive.backoff.restore` 是 `change`，走 challenge/confirm。与 `client-capabilities.ts` 一致。新增代码没有打印密钥、令牌或邮箱正文。
- 不可撤销：`done`/`mute` 在 iPhone 上没有 undo（意见 2）；`pause`、`source.switch_off` 可通过再打开恢复；decision rating 可改/清空；insight rating 可改成另一个值但不能清空。`backoff.restore` 只是恢复推送，不算破坏性。
- 资源耗尽：界面最多渲染 20+30 张卡片，但解码的是服务器返回的全部数组；没有新增文件、网络或持久化循环。`step` 的 while 循环在正常范围很快，极端值见意见 8。
- 规则/文档/代码一致：`prompt-prefix` 规则不受影响；操作待补清单没更新（意见 1）；来源字段的依据说明与 `proactive.ts` 不符（意见 7）；`2026-10-29` 设计规格把“系统主动提醒”放在网页“设置 · 通知”，iPhone 放在“Himawari 自己”分组，这是产品组织选择，未发现与之直接冲突的 iPhone 规则。
- 未核实：没有运行 Swift 测试或 `npm run check`（工具限制）；SwiftUI 只能在 Mac 上编译；demo 场景 `proactiveSource` 直接进入时中间页 `.task` 是否先执行，我没法在模拟器里观察，所以只按“`sources == nil` 且没有重试入口”这一确定性事实报告。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 本次 diff 只新增 iOS 客户端的数据模型、请求、界面和文案，没有触碰系统提示、工具定义、历史消息、资料块、压缩或遮盖代码；因此发给模型的内容仍然只在末尾追加，每轮会变的值仍然由原有机制放在最后一条消息里。依据 [prompt-prefix.md#rules](../../.agents/instructions/prompt-prefix.md#rules) 第 4、5 条；新增的 `settingsPayload`/`sourcePayload` 是设备网关命令，不是模型请求。

2. **不会让模型输入里的同一段文字变成不同字节。** 没有新的遮盖、时间字段或模型侧集合顺序处理；`ProactiveTime` 只用于界面显示。新命令 payload 对同一份服务器快照是确定的：`ManageGateway` 用 `.sortedKeys` 序列化，`quietHours`/`importantSenders` 按服务器快照顺序复制，`days` 也没有在发送前重排。唯一理论差异是若服务器两次返回的数组顺序不同，管理命令的字节会不同；这不影响模型请求，也不涉及 KV 缓存。

3. **有自动检查，但本次漏了一个仓库级检查，且覆盖不完整。** 逻辑测试存在：`ProactiveTests` 覆盖打分选择、失败原因映射、排序、步进边界、未知 rating；`ProactiveSessionTests` 覆盖 pause 无 nonce、打开时保留 quietHours/senders、来源只关用 switch_off、改上限用 settings.set、决策评分清空发 null、insight rate 带 rating。反向用例也确实会失败，例如把 `change` 改成“只要关就 switch_off”会让 `testSwitchingOffAndChangingALimitTogetherIsNotATightenOnlyChange` 失败，把打分规则改错会让 rateChoices 测试失败。不足：没有断言 pause 的 payload 必须是 `{}`；没有覆盖“关来源同时改上限时 `enabled=false`”的 payload；没有 SwiftUI 视图测试；`ProactiveSessionTests` 所在的 `HimawariManageTests` 在 Linux 的 `Package.swift` 分支里不构建，只有 Mac 上才会跑。最关键的是意见 1：`npm run check:operations` 这类仓库级检查没更新清单，会直接失败。我没有运行测试（工具限制），以上是按断言和脚本逻辑核对。

4. **逐个核对两端：数值和标识都能通过，问题在“清单项”而不是字段校验。**
   - `source`：来源快照是 `proactiveSourceName`，两条来源命令也是 `proactiveSourceName`；服务端按注册表校验，OK。
   - `perDay`/`perCheck`：来自服务器 `limit`，命令契约是 `integer(1)`，服务端再用 `proactiveSourceLimitsValid` 校验 `minimum...maximum`；UI 的 `stepUp/stepDown` 也按服务器边界 clamp，OK。
   - `enabled`：Bool → `booleanValue`，OK。
   - `insightId`/`decisionId`：快照里是 `machineString`，命令也是 `machineString`；`ManageGateway.withPlaceholders` 只替换 `authorizationRef`/`recentAuthenticationRef`（`Generated/ClientCapabilities.swift:234-235`），不会把这两个 id 换成 `"device"`，OK。
   - `classKey`：快照 `boundedString(128)` → `proactive.backoff.restore` 的 `nullable(boundedString(128))`，OK。
   - `action`/`rating`：`done/mute/reopen/rate` 和 `useful/unneeded/missed` 都在契约枚举内；insight 的 `rate` 不传 null（服务端会拒绝），decision 的 rating 允许 null 清空，OK。
   - `quietHours`/`importantSenders`：从 overview 复制，服务端契约接受；服务端 `writeSettings` 会排序/去重，OK。
   - **清单项**：`ci/operations-pending.json` 仍把 `proactive.pause`、`proactive.sources.read`、`proactive.source.settings.set`、`proactive.source.switch_off` 列为缺调用方；现在调用方已存在，`check:operations` 会要求移出，见意见 1。
   - `proactive.sources.read` 和来源命令在 `apps/control-center/src/proactive.ts` 里没有使用，无法用该文件交叉核对；我改用 `contracts-v2.ts` 和服务端处理代码核对，字段一致。`ProactiveSource.dailyLimitReached` 虽然解码了，但界面没有使用，属于展示缺口，不是校验失败。
