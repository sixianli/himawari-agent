本轮范围：`git diff 776a9c5f..2a862762` 的 10 个文件（含复核记录），并顺着 `reset()`、`search.ask.read`、`SearchBasis.id`、`todayTop` 的使用端追到 `AppModel`、`RootView`、`Gatewa ySearchSource`、测试、`check-operations`、网关合同和生产 `production-search.ts`。增量没有碰、行为也没被增量改变的代码没有整份重读。界面未在 Mac 编译，测试未实际运行，只能静态核对。

### 1. 中高 `reset()` 只清了同步状态，在途请求仍会把旧账号的答案写回来，且不清 `asking`
`clients/apple/Sources/HimawariShell/Search/SearchModel.swift:47-66`、`clients/apple/Sources/HimawariShell/AppModel.swift:281-293`

问题：上一轮第 2 条的修复只做到“退配对时把建议清空”。`ask` 由页面里未保存的 `Task {}` 发起，`reset()` 不会取消它，也不会阻止它完成后再赋值；`asking` 也没被清。若搜索请求在退配对/换账号时还在路上，旧账号的 `answer`（或失败状态）会在新会话里重新出现；若请求一直不返回，`asking` 永远非空，新账号再也发不出提问。

证据（代码证实）：
```swift
47: public func ask(_ question: String) async {
48:     guard let source, asking == nil else { return }
...
53:         answer = try await source.ask(question)
...
61: public func reset() {
62:     suggestions = []
63:     answer = nil
64:     failed = false
65:     text = ""
66: }
```
```swift
285:         home.reset()
286:         search.reset()
```
`ask` 没有 generation/token 校验，`reset` 没有 `asking = nil`，也没有保存并 `cancel()` 在途任务。

建议：记录一个 generation（或保存当前 `Task`）；`ask`/`load` 完成时只有 generation 未变才允许写回；`reset()` 里 `asking = nil` 并取消在途任务。这样才真正满足“换账号后不显示旧主人的内容”。

### 2. 低 提问失败后仍清空输入和问题气泡，用户看不到自己问了什么，也无法一键重试
`clients/apple/Sources/HimawariShell/Search/SearchModel.swift:49-50`、`clients/apple/Sources/HimawariShell/Search/SearchPage.swift:39-60`

问题：上一轮第 3 条只修了“旧答案继续显示”和“失败提示到不了”。失败时 `answer` 已被置空， `asking` 也已复位，页面只剩一句失败文案；发起请求前 `text = ""`，用户原来输入的问题既不在输入框也不在气泡里，只能重新打字。

证据（代码证实）：
```swift
49:         text = ""
50:         asking = question
```
```swift
39:         if let asking = model.asking {
40:             question(asking)
41:         } else if let answer = model.answer, answer.state != .suggestions {
...
56:         } else if model.failed {
57:             Text(L.text("search.failed"))
```
建议：失败时把问题恢复到 `text`（或保留问题气泡）并给一个重试入口，至少不要让用户丢失刚问的内容。

### 3. 低 `failed` 一旦置位就会长期盖住建议卡，成功加载建议也不清除；初次加载失败仍是空白
`clients/apple/Sources/HimawariShell/Search/SearchModel.swift:33-39`、`clients/apple/Sources/HimawariShell/Search/SearchPage.swift:56-62`

问题：上一轮第 5 条只改了中文文案（去掉“下拉”）。`content` 里失败分支排在建议卡之前，而 `failed` 只在 `ask` 成功或 `reset()` 时清除；`load()` 成功也不清。于是任何一次提问失败后，即使重新打开页面时建议已加载成功，页面仍显示“暂时搜不了”，建议卡被永久挡住。另一个方向仍存在：初次 `load()` 失败只把建议置空，不设置 `failed`，页面空白。

证据（代码证实）：
```swift
33:     public func load() async {
34:         guard let source, suggestions.isEmpty else { return }
35:         do {
36:             suggestions = try await source.ask(nil).asks
37:         } catch {
38:             suggestions = []
39:         }
40:     }
```
```swift
56:         } else if model.failed {
57:             Text(L.text("search.failed"))
...
61:         } else if !model.suggestions.isEmpty {
62:             suggestionsCard
```
说明：服务端对非空查询只返回 `answered`/`not_found`（`production-search.ts:354-376`），所以“忽略 `state=suggestions` 的 `asks`”目前不可触发，未单列；但 `load()` 的失败无提示仍是实际路径。

建议：`load()` 成功时清 `failed`，失败时也进入可提示的状态；或者把失败提示做成不影响建议卡的顶部提示。是否显示建议卡按“有无建议”而不是按 `failed` 独占整个内容区。

### 4. 低 `shortHeight` 是页面级、初值为 0 的共享状态，换答案时首帧可能按“短答”排版（推测，待 Mac 验证）
`clients/apple/Sources/HimawariShell/Search/SearchPage.swift:9-10`、`68-84`

问题：上一轮第 4 条“长答分支走不到”在逻辑上已换成“先量高度再选样式”，方向正确。但 `shortHeight` 初值为 0，且不随答案文本重置。收到一个新长答案时，首帧会以 24pt、不限行的短答样式排版，`onGeometryChange` 之后才切成 17pt/6 行；可能出现闪动或明显布局跳动。短答案之间切换则反过来先按长答样式渲染一帧。

证据（代码证实存在状态共享/初值 0）：
```swift
10:     @State private var shortHeight: CGFloat = 0
```
```swift
69:         let short = shortHeight <= (top.lineHeight ?? top.size * 1.5) * 3 + 1
72:                 .hmType(short ? top : DesignTokens.TypeScale.body)
73:                 .lineLimit(short ? nil : 6)
84:                         .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { shortHeight = $0 }
```
`todayTop` 的 `lineHeight` 存在，为 `24 * 1.5`（`DesignTokens.swift:349`），阈值计算本身没问题。

推测：SwiftUI 可能在同一布局事务里合并这次状态更新而不显示错误帧；是否可见需 Mac 上验证。建议把测量值按文本缓存，或在答案变化时先置为不确定并等测量完成，避免用上一条答案的 `shortHeight`。

### 5. 低 增量的 reset/失败/id 行为没有自动检查，反向用例覆盖不到
`clients/apple/Tests/HimawariShellTests/HomeFeedModelTests.swift:38-54`、`clients/apple/Tests/HimawariCoreTests/SearchAnswerTests.swift:10-50`

问题：清单项有 `check:operations` 兜底，但这次修改的 `SearchModel.reset()`、失败时 `answer = nil`、`SearchBasis.id` 都没有测试。`HimawariShellTests` 已有 `FakeSource` 模式，完全可以加同样的 `FakeSearchSource`；`SearchAnswerTests` 也没有断言 `id` 在 `at` 不同/相同时的行为。

证据（代码证实）：增量没有改任何 `Tests` 文件（`git diff 776a9c5f..2a862762 -- clients/apple/Tests` 为空）；现有测试只覆盖解码和 `SearchQuestion.trimmed`。

建议：至少加三条：①`reset()` 后 `suggestions/answer/asking` 都为空；②在途 `ask` 跨越 `reset()` 后不得回写（可用来抓住意见 1）；③同一 kind/threadId 但 `at` 不同的 basis 产生不同 `id`，`at` 相同则相同。

**上一轮意见逐条核对**
- 1（清单项）：已改好。`ci/operations-pending.json` 中已无 `search.ask.read`；后端实现、Swift 调用方（`GatewaySearchSource.swift:15`）和测试都在，`check-operations` 的 `OPERATION_PENDING_BUT_COMPLETE` 不会再报。
- 2（reset 不清 suggestions）：只修了一半，见意见 1。
- 3（失败时旧答案/提示）：只修了一半，见意见 2。
- 4（长答分支）：逻辑上已改，未在 Mac 验证；首帧问题见意见 4。
- 5（suggestions/初次加载/文案）：只改了中文文案，其余见意见 3。
- 6（id 不含 at）：已改好，`SearchAnswer.swift:17` 已把 `at` 加进 id。

**侧重检查**
- 错误路径：`load()`/`ask()` 的 catch、`reset()` 竞态、`failed` 状态机（意见 1–3）。`load()` 失败无提示，`ask()` 失败丢输入，均已在上面列出。
- 不可信/不合规范输入：`SearchQuestion.trimmed` 只做 trim（`SearchAnswer.swift`），不截到合同上限 500；超过 500 的查询会被服务端 schema 拒绝（`contracts-v2.ts:1067`），客户端显示通用失败。服务端会拦住，不是安全漏洞，但客户端没有预校验。答案、依据 label、`notFoundText` 全部用 `Text` 渲染，没有把服务端文字拼进 URL/HTML；点击依据只取 `threadId` 开对话或切记忆页（`RootView.swift:124-133`），没有任意 URL 打开。
- 安全/隐私：跨账号残留旧答案/建议（意见 1），是本轮最值得处理的点。
- 资源耗尽：`answer` 合同上限 2000 字符（`contracts-v2.ts:1074`），`asks` 由服务端 `askLimit` 截断；测量视图会排整段答案，但有上述上限，未发现无界增长。
- 不可撤销操作：增量没有删除、写入、计费或外部副作用操作。
- 规则/文档一致：未发现 md 仍在引用 `search.ask.read` 的待接入状态；`ci/operations-pending.json` 的删除与 `check-operations` 逻辑一致；中文 `search.failed` 已与 en/ja 对齐，去掉“下拉”。作者说的“感知/记忆依据只切到记忆页、不定位单条”与 `RootView` 一致。

**必答问题**
1. **不改变模型已见过的请求开头**，也不涉及“只在末尾追加”。本 PR 只由 iOS 通过网关调 `search.ask.read`，服务端是 `lexicalOnly` 的字面检索、不调模型（`production-search.ts:178-192`、`249-255`）；发送的 `query`/`locale` 不进入任何对话的系统提示、工具定义或历史。
2. **不会让同一段文字在不同请求里变成不同字节**。客户端每次只发 `query` 和固定 `locale`（`HOME_LOCALES` 内）；响应里的 `generatedAt` 带时间但客户端忽略；服务端 `asks`/`basis` 有确定排序（`production-search.ts:227-235`、`350-352`）；`SearchBasis.id` 里新增的 `at` 来自响应且同一条依据稳定。唯一的现实变化是服务端建议本身会随数据更新，但那是服务端状态，不用于模型前缀。
3. **清单项有自动检查，反向用例有**：`check-operations` 对“已齐全却仍在待接入名单”报 `OPERATION_PENDING_BUT_COMPLETE`（`scripts/check-operations.mjs:430-433`），`test/tooling/operations-check.test.mjs:471-476` 断言了该错误，另有“真实仓库零报红”用例（`:484-486`）。按代码判断，名单项若残留，该用例会失败；未实际运行。**reset/失败/id 没有自动检查**，反向用例覆盖不到（意见 5）。
4. **逐个值核对**：
   - 清单键删除：唯一使用端是 `check-operations`，后端实现（`production-search.ts`）、Swift 调用方（`GatewaySearchSource.swift:15`）、测试（`test/integration/*search*.test.ts`）都齐，删除正确。
   - `SearchBasis.id`：唯一使用端是 `SearchPage.swift:136` 的 `ForEach(id: \.element.id)`，接受任意字符串；加 `at` 减少碰撞，不会破坏使用端。测试夹具里 memory/perception 没写 `at`，但 Swift 允许可选，真实合同要求 `at: timestamp`（`contracts-v2.ts:1083`）。
   - `search.failed` 文案：使用端 `SearchPage.swift:57` 的 `L.text`，en/ja 已是同义文案，不冲突。
   - `suggestions` 在 `reset()` 清空：使用端 `AppModel.emptyStore()` 和 `SearchPage.suggestionsCard` 都能接受；但异步回写漏洞见意见 1。
   - 失败时 `answer = nil`：使用端 `SearchPage.content` 的 `failed` 分支能正确显示失败提示；副作用见意见 2、3。
   - `shortHeight`：仅 `SearchPage.answerText` 内部使用，阈值依赖的 `todayTop.lineHeight` 存在（`DesignTokens.swift:349`）。
   - 另外核对：`search.ask.read` 已在 `ClientCapabilities.swift:152` 登记为 `read`；请求 payload 的 `query`/`locale` 与合同 `contracts-v2.ts:1065-1088` 一致，服务端 `HOME_LOCALES` 与 `HomeLocale` 的 `zh-CN/en/ja` 一致，未发现 I-73 那类两端校验不匹配。
