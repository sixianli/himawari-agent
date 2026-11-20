## 复核范围

本轮只核对 `145d964bba7493d4512904e56a71d6e0649eda55..126c5fb36e1f259d8547da747b0cf78a0e76ae10` 的增量：12 个文件，集中在手表 UI、设计 token、小组件依赖、本地化和截图脚本。另外按线索跟到未改动的 `WatchGlance.swift`、`WatchModel.swift`、`WatchViews.swift`、`WatchGlanceTests.swift`，以及服务端 `home-feed.ts`、`production-home.ts`、`device-api-routes.ts` 和 `clients/apple/README.md`。旧 PR 的其余部分没有整份重读。Mac 编译、真实 WidgetKit 渲染和模拟器截图未核实。

## 意见

### 1. 中：第 6 轮“红点有件数但卡片消失”在 126c 仍未修好，件数和卡片仍来自两套数据

- 文件：`clients/apple/Sources/HimawariCore/WatchGlance.swift:110-120,183-192`；`clients/apple/Sources/HimawariWatchUI/WatchGlanceViews.swift:54-60`；`clients/apple/Sources/HimawariWatchUI/WatchModel.swift:294-298`；`clients/apple/Sources/HimawariWatchUI/WatchViews.swift:123-127,153`；`packages/application/src/services/home-feed.ts:324-343`；`clients/apple/README.md:173`
- 问题：表盘的件数来自 `awaitingCount`，长条里的“最近一件”和手表 App 的卡片来自 `items` 里第一个“有句子且等你定”的条目。只要 `awaitingCount > 0` 但 `pressing == nil`，圆形会显示件数，长条只剩件数、句子消失，手表 App 也没有卡片。126c 只把小组件视图搬到 `HimawariWatchUI` 并加了四个 demo 场景，没有改这条数据分叉。
- 证据：`WatchGlance.swift:110-120` 仍然要求 `$0.sentence != nil`，而 `countedAwaiting` 直接取 `awaitingCount`：

```swift
public var pressing: WatchItem? {
    items.first { $0.awaitsOwner && $0.sentence != nil }
}
...
public var countedAwaiting: Int? {
    incompleteSources.isEmpty ? max(0, awaitingCount) : nil
}
```

`WatchGlanceTests.swift:70-77` 甚至把这个输入固定成“件数 2、卡片为空”：

```swift
{"items":[... "awaitingCount":2 ..."}
#expect(home.pressing == nil)
#expect(home.countedAwaiting == 2)
```

`WatchGlanceViews.swift:54-60` 在长条里只有 `latest` 非空才画句子，没有兜底：

```swift
case let .waiting(count, latest):
    Text(waitingText(count))
    if let latest {
        Text(latest).font(.caption2).lineLimit(2)
    }
```

服务端还会把不在 `items` 里的未读算进件数，`home-feed.ts:342`：

```ts
const awaitingCount = awaiting.length + unread;
```

这会产生“表盘有件数、手表 App 甚至写没有要你定的事”的组合。README 的承诺也和代码不一致：第 173 行写“长条（向日葵加‘N 件事等你定’加最近一件）”，代码里的“最近一件”是可选的。
- 建议：把“件数有值但无卡片”定义成一种明确的展示状态，而不是两套数据各自决定。例如长条和手表 App 在这种状态下显示“N 件等你定，在 iPhone 上看”或统一的兜底卡片；如果产品要求件数与 iPhone 红点严格一致，就不要在没有卡片时单独隐藏件数。补一条纯逻辑用例：`awaitingCount > 0`、`pressing == nil`（含 `items` 为空和 `sentence == nil` 两种）时，小组件不能出现“只有件数、没有内容”，手表 App 不能落到 `quiet`。同时把 `awaitingTruncated` 纳入客户端判断。

### 2. 低：中文离线文案已改成“现在连不上”，README 仍写“暂时连不上”

- 文件：`clients/apple/Sources/HimawariWatchUI/Resources/zh-Hans.lproj/Localizable.strings:13`；`clients/apple/README.md:170`
- 问题：增量只改了中文资源，没有同步说明文档；按 README 验收会看到旧文案。英文、日文资源已经是“right now / 今は”，中文这次才对齐，所以更可能是 README 漏改。
- 证据：资源文件是 `"offline" = "现在连不上";`，README 同一屏的行为说明仍写“没有旧卡片可显示才写‘暂时连不上’。”
- 建议：把 README 第 170 行改成“现在连不上”，或如果语义确实是“暂时”，就改回资源并同时检查 en/ja 的对应措辞。

### 3. 低：新增 glance 视图没有自动检查，现有测试反而把“有件数、没卡片”当成合法状态

- 文件：`clients/apple/Tests/HimawariCoreTests/WatchGlanceTests.swift:70-77,91-100`；`clients/apple/Sources/HimawariWatchUI/WatchGlanceViews.swift:1-72`；`clients/apple/scripts/watch-ui-review.sh:63-67`
- 问题：126c 提交说明里写 `Layer-0-tests: none`，新增的 `WatchGlanceView`、四个 demo 场景、`HaloMark`、失败屏原话都没有自动化用例。唯一能跑的是 HimawariCore 的 18 个测试，但其中第 70-77 行恰好断言“件数 2、`pressing == nil`”，这不是反向用例，而是把问题状态固定下来。四个新 demo 场景也没有在本次增量里提交对应截图（`ui-review/watch-latest` 仍只有旧的 14 张），且 demo 是自己拼固定宽高和背景，不是真实 WidgetKit 布局，不能替代真实小组件验证。
- 证据：测试只断言 `home.pressing == nil` 和 `home.countedAwaiting == 2`；`WatchComplicationState(home:at:)` 没有针对该输入的期望；`watch-ui-review.sh` 只是启动 demo 并截图，Mac 原生编译和真实 widget family 尺寸未覆盖。
- 建议：把“件数/卡片展示决策”抽成 HimawariCore 里的纯函数并加用例，而不是只测 SwiftUI；至少加入 `awaitingCount > 0 && pressing == nil` 的反向断言。四个 glance 场景在 Mac 跑完后应提交截图，或明确说明截图不在 PR 里、以脚本输出为验收物。

## 作者说法核对

- “上一轮第 6 轮意见作者已修改”：与代码不符。126c 的增量没有改 `WatchGlance.swift`、`WatchModel.card` 或 `WatchHome.pressing/awaitsOwnerWithoutCard`，只在 `WatchGlanceViews.swift` 里重画了同样的分支；见意见 1。
- “17 条 Linux 测试”：读到 `WatchGlanceTests.swift` 里是 18 个 `@Test`（第 24、35、46、56、63、70、79、91、103、109、132、140、147、154、163、174、196、205 行）。
- “main 上服务器还没有 `GET home` / `POST home/act` 设备入口”：与当前提交不符。`packages/platform-node/src/device-api-routes.ts:88-89` 已把两条路由登记为 signed，`1372` 和 `1402` 行已有处理器；`production-http-composition.ts` 也传入了 `home`。这条说法只可能是旧状态，126c 上不能作为“客户端只能照着 Mac 菜单栏接口猜”的理由。
- “手表界面在 `Sources/HimawariWatchUI`（仅 watchOS 编译）”：与代码一致，相关 Swift 文件基本都在 `#if os(watchOS)` 下（`WatchDemo.swift` 另加 DEBUG）。
- 文件路径、两个 Xcode 目标、`App/Watch` 入口、`App/WatchWidgets` 小组件：与工程结构一致。Mac 编译、`Bundle.module` 在小组件扩展里的本地化资源查找、真实 WidgetKit 渲染未核实。

## 侧重检查

- 错误路径：`WatchModel.run` 的失败会落到 `.failed`，重试按钮现在读 `model.said`。正常路径下 `said` 在 `say()` 里先赋非空值，重试可用；但如果 `finishTalk()` 取消任务后失败回调才落地，存在 `.failed` 且 `said == ""`、重试按钮点了没反应的窄竞态（推测，未复现）。建议重试按钮对空 `said` 禁用或改为回到输入态。
- 不合规范/不可信输入：`WatchComplicationState` 的 `awaiting` 为负数时 `display` 会落到 `.nothingWaiting`；`latest` 来自服务器或共享存储，长条用 `lineLimit(2)` 限制，但没有长度上限，和旧代码一致。客户端仍忽略服务端的 `awaitingTruncated`，这是意见 1 的一部分。
- 安全：`said` 只保存在内存并显示在失败屏/发送中，不写日志、不持久化；没有新增密钥、配对或权限路径。小组件把 `latest` 写进 App Group 的旧逻辑未变。
- 资源耗尽：新增 `HaloMark` 是固定 96pt 渐变，没有循环或按文本长度扩张的布局；没有新增网络循环或不可撤销操作。
- 规则/文档一致性：除意见 2 的 README 文案外，`glance.waiting`/`glance.quiet` 仍在 `App/WatchWidgets/*.lproj` 和 `Sources/HimawariWatchUI/Resources/*.lproj` 各存一份，视图实际只读后者；当前无运行错误，但以后改文案容易漂移，建议删掉旧副本或统一由一处生成。

## 必答问题

1. **不涉及。** 这个增量只改 `clients/apple` 的手表 UI、设计 token、本地化、pbxproj 和截图脚本，没有改系统提示、工具定义、历史消息或遮盖逻辑；没有模型请求组装文件被触碰。因此发给模型的内容是否“只在末尾追加”、每轮变化值是否在最后一条消息，这个改动没有改变它。未核实的部分是 Mac 上的实际 UI 编译。
2. **不涉及模型请求。** 新增的 `WatchComplicationState` 带 `updatedAt`，但它只写入 App Group 供小组件使用；demo 用的是固定 `Self.at`。没有把时间字段、无序集合或遮盖结果放进模型输入，所以不会让同一段文字在不同模型请求里变成不同字节。
3. **部分有，反向用例不足。** token 有 `check-design` 的 `tokens-stale` 检查，我读到生成文件与 `tokens.json` 的新增项一致；但新增视图和四个 demo 场景没有自动检查，提交声明 `Layer-0-tests: none`。现有 `WatchGlanceTests` 把“件数 2、`pressing == nil`”断言为正常，真写一条“此时小组件/手表不能显示无事或只剩件数”的反向用例会失败。
4. **逐项核对结果：**
   - `WatchGlanceView`：产生于 `WatchGlanceViews.swift`，使用于 `App/WatchWidgets/HimawariWatchWidgets.swift:34` 和 `WatchDemo.swift:106`；两处都是 watchOS，参数 `(WatchComplicationState, WidgetFamily)` 匹配，没有发现其他使用端。
   - 设计 token：`glance*`、`markHalo`、`saidLines`、`screenPadding`、`watchHalo` 都由 `tokens.json` 生成到 `DesignTokens.swift`；直接使用端只有 `WatchViews.swift`、`WatchGlanceViews.swift`、`WatchDemo.swift`，类型匹配（`saidLines` 用 `Int(...)` 转换，当前值为 3）。`screenPadding` 从 6 改到 12，使用端是 Unpaired/Waiting/Card 三处，行为上接受。
   - 本地化：`glance.waiting`、`glance.quiet` 在 zh-Hans/en/ja 三份 `HimawariWatchUI` 资源里都有；`L.format` 的 `%d` 对应 `Int`，`reminder.title` 也存在。旧 `App/WatchWidgets/*.lproj` 里的同名键已不再被视图读取，属于重复来源，不是运行期不匹配。
   - `said`：产生于 `WatchModel.swift:325`，清空于 `:393`，使用于 `WatchViews.swift:261,266,277`；`say` 的重试入口接受 `.failed` 且要求非空，正常发送路径下 `said` 非空。上面提到的取消/失败竞态是推测。
   - demo 场景标识：`WatchDemoScene` 的 rawValue 被 `ProcessInfo` 和 `watch-ui-review.sh:34` 的 sed 规则读取，新 `11-watch-8*` 名称能匹配该规则。
   - `--lang`：脚本只接受 `zh-Hans|en|ja` 并映射到 `zh_CN|en_US|ja_JP`，传给 `simctl`；实际模拟器行为未核实。
   - pbxproj：新 `A7C3E1D9…` build file 加在 `F667E88C…`（`HimawariWatchWidgets` 的 Frameworks phase），新 `B8D4F2EA…` 同时加在该 target 的 `packageProductDependencies`，与 `CFAE68B3…` 这个 appex 对得上，没有发现挂错 target。
   - 服务端 home 入口：`AnswerLocale` 的 `zh-CN/en/ja` 与 `HOME_LOCALES` 一致；watch 的 `requestId` 正则与 `MACHINE_STRING` 一致；`home/act` 服务端要求 `binding` 是字符串，而 `WatchCard` 只保留 `binding != nil` 的动作，watch 这条路径两端能接受。作者“服务器还没有 home 入口”的说法已过时。
