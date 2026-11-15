## 读代码对照结论

以下 1、2、3、5、7、8 是读代码可以确认的（受工具限制没有实际运行 `npm run check:operations`）；第 4、6 条含推测，已在标题或正文标注。

## 侧重检查

- **错误路径**：`SearchModel.ask` 失败时只置 `failed`，不清旧 `answer`，且先把 `text` 清空；`SearchPage.content` 先看 `answer` 再看 `failed`，所以旧答案会盖住失败提示，用户还要重新输入。见意见 3。
- **不可信/服务器输入**：`label`、`query`、`notFoundText` 都直接进 SwiftUI `Text`，不会当 Markdown/HTML 执行，无注入面；但 `SearchBasis.id` 由服务器字段拼接后当 `ForEach` 的 id，存在重复风险。见意见 6。
- **安全/不可撤销**：`startOver`、`removedThisDevice` 会走 `emptyStore()` → `search.reset()`，但 `reset()` 不清 `suggestions`；退配对或换账号后，旧主人记忆里抽出的建议问句仍留在内存并继续显示，`load()` 又不会重新取。见意见 2。
- **资源耗尽**：查询长度没有客户端上限，服务器契约上限 500 字符，超长只会变成通用失败；`basis`/`asks` 没有客户端数量上限，页面用非懒加载 `VStack` 渲染，但服务器默认有 `basisLimit`/`askLimit`，风险较低。见意见 7。
- **规则文件/文档与代码一致**：`ci/operations-pending.json:26` 明确写着“iOS 搜索页接上后自动要求移出名单”，但本 PR 没移出，`check:operations` 会报红；中文 `search.failed` 说“下拉或稍后再试”，页面没有 `.refreshable`。见意见 1、5。
- **不可撤销操作**：本改动没有写入、删除、支付或外部副作用；`search.ask.read` 是只读查询。未发现新增不可撤销操作。

## 高

### 1. 高 新增 Swift 调用方后没有移出 `ci/operations-pending.json`，`check:operations` 会报 `OPERATION_PENDING_BUT_COMPLETE`
- 文件:行：`ci/operations-pending.json:26`、`clients/apple/Sources/HimawariShell/Search/GatewaySearchSource.swift:15`、`scripts/check-operations.mjs:17-18,323-328,427-433`
- 问题：这个操作现在已经有后端实现、测试和调用方，属于“已齐全”，但名单里还留着它。检查脚本会扫 `clients/apple/Sources` 下的 Swift 调用方，`GatewaySearchSource` 不在排除范围。
- 证据：
  ```json
  // ci/operations-pending.json:26
  "search.ask.read": "...（缺：调用方）...iOS 搜索页接上后自动要求移出名单"
  ```
  ```swift
  // GatewaySearchSource.swift:15
  let data = try await gateway.read(.v2, "search.ask.read", payload: ["query": query, "locale": .string(locale)])
  ```
  ```js
  // scripts/check-operations.mjs:17-18,323-328
  const SWIFT_ROOT = "clients/apple/Sources";
  const SWIFT_EXCLUDED_SEGMENTS = ["/Generated/", "/Demo", "Demo.swift"];
  ...walk(root, SWIFT_ROOT, (file) => !SWIFT_EXCLUDED_SEGMENTS.some((segment) => file.includes(segment)), [".swift"])
  ```
  ```js
  // scripts/check-operations.mjs:430-433
  if (missing.length === 0 && reason !== undefined)
    errors.push(`OPERATION_PENDING_BUT_COMPLETE ${name} 已齐全，...从 operations 移除...`)
  ```
- 建议：删除 `ci/operations-pending.json` 里的 `search.ask.read` 条目，并跑 `npm run check:operations`。这正是 I-73 的教训：不是只看调用方代码，而是每个使用这个值的地方（这里是待接入清单检查）都要能接受。

### 2. 高 `SearchModel.reset()` 不清 `suggestions`，退配对/换账号后旧主人的建议仍会显示且不再刷新
- 文件:行：`clients/apple/Sources/HimawariShell/Search/SearchModel.swift:33-40,60-64`、`clients/apple/Sources/HimawariShell/AppModel.swift:281-293`
- 问题：`reset()` 只清 `answer`、`failed`、`text`，不清 `suggestions`。而 `load()` 只在 `suggestions.isEmpty` 时才请求。于是 `startOver`、`cancelPairing`、`removedThisDevice`、被服务器移除等会走到 `emptyStore()` 的场景之后，重新配对时搜索页仍显示上一次配对账号的建议问句，不会加载新账号的建议。
- 证据：
  ```swift
  // SearchModel.swift:33-39
  public func load() async {
      guard let source, suggestions.isEmpty else { return }
      do {
          suggestions = try await source.ask(nil).asks
      } catch {
          suggestions = []
      }
  }
  ```
  ```swift
  // SearchModel.swift:60-64
  public func reset() {
      answer = nil
      failed = false
      text = ""
  }
  ```
  ```swift
  // AppModel.swift:285-286
  home.reset()
  search.reset()
  ```
  这些建议不是固定文案，而是服务器从记忆实体生成的（`production-search.ts:206-236` 遍历 `attributes.entities` 并返回 `asks`），可能包含旧主人的姓名、偏好、关系等。
- 建议：`reset()` 同时清空 `suggestions`（必要时清 `asking`）；或在配对/激活时按新身份重建 `SearchModel`。补一条“退配对后 suggestions 为空、重新加载会重新请求”的测试。

## 中

### 3. 中 提问失败时旧答案继续显示，失败提示永远到不了，输入也已被清空
- 文件:行：`clients/apple/Sources/HimawariShell/Search/SearchModel.swift:47-58`、`clients/apple/Sources/HimawariShell/Search/SearchPage.swift:38-62`
- 问题：`ask` 一开始就把 `text` 清空，失败时只置 `failed = true`，不清理或替换旧 `answer`。`content` 的判断顺序是先 `model.answer`，再 `model.failed`，所以用户问第二个问题失败后，页面仍显示上一个问题及答案，错误文案被挡住；同时刚输入的问题已经丢了。
- 证据：
  ```swift
  // SearchModel.swift:47-58
  public func ask(_ question: String) async {
      guard let source, asking == nil else { return }
      text = ""
      asking = question
      defer { asking = nil }
      do {
          answer = try await source.ask(question)
          failed = false
      } catch {
          failed = true
      }
  }
  ```
  ```swift
  // SearchPage.swift:40,55-56
  } else if let answer = model.answer, answer.state != .suggestions {
  ...
  } else if model.failed {
      Text(L.text("search.failed"))
  ```
- 建议：请求开始时清掉旧 `answer`（或记录这次请求的 question 并在失败时显示它），`catch` 里保留输入用于重试；`content` 在 `failed` 时优先显示错误和重试入口。补失败路径的单元测试。

### 4. 中 长答案分支很可能永远走不到，长答会以 24pt 截成 3 行而不是 17pt 最多 6 行（推测，需 Mac 验证）
- 文件:行：`clients/apple/Sources/HimawariShell/Search/SearchPage.swift:66-73`；字号依据 `docs/assets/apple-clients/2026-11-12-v2/tokens.json:121,134`
- 问题：`short` 自带 `.lineLimit(3)`，长文本会被截成 3 行；`ViewThatFits(in: .vertical)` 选第一个“放得下”的子视图，而 3 行在正常手机视口里几乎总放得下，所以 `long`（17pt、6 行）基本不会被选中。长答案会显示为 24pt 的 3 行截断，和“长答 17pt 最多 6 行”不符。
- 证据：
  ```swift
  // SearchPage.swift:67-73
  let short = Text(text).hmType(DesignTokens.TypeScale.todayTop)
  let long = Text(text).hmType(DesignTokens.TypeScale.body).lineLimit(6)
  ViewThatFits(in: .vertical) {
      short.lineLimit(3).fixedSize(horizontal: false, vertical: true)
      long
  }
  ```
  `todayTop` 是 `[24, 600, 1.5, "himawari"]`，`body` 是 `[17, 400, 1.35]`。
- 建议：不要用 `lineLimit(3)` 的视图做“是否短”的测量；按全文实际行数或高度分流，短答才用 24pt，长答再切 17pt/6 行。修完后在 Mac/真机上补短答、4 行、长答三种快照或 UI 验证。

## 低

### 5. 低 提问后服务器若返回 `state=suggestions`，客户端忽略它的 `asks`；初次加载失败也无提示，中文文案却说“下拉”
- 文件:行：`clients/apple/Sources/HimawariShell/Search/SearchPage.swift:40,60`、`clients/apple/Sources/HimawariShell/Search/SearchModel.swift:33-39,52-53`、`clients/apple/Sources/HimawariShell/Resources/zh-Hans.lproj/Localizable.strings:70`
- 问题：`ask` 成功后会设置 `answer`，但如果 `state == .suggestions`，`content` 跳过 `answer` 分支，随后显示的是 `model.suggestions` 里的旧值；本次响应的 `asks` 从未被采用。另外 `load()` 失败只把 `suggestions` 置空，不置 `failed`，页面标题下会空白；中文文案提示“下拉或稍后再试”，但 `SearchPage` 的 `ScrollView` 没有 `.refreshable`。
- 证据：
  ```swift
  // SearchPage.swift:40,60
  } else if let answer = model.answer, answer.state != .suggestions {
  ...
  } else if !model.suggestions.isEmpty {
  ```
  ```swift
  // SearchModel.swift:35-38
  do {
      suggestions = try await source.ask(nil).asks
  } catch {
      suggestions = []
  }
  ```
  ```swift
  // zh-Hans Localizable.strings:70
  "search.failed" = "暂时搜不了，下拉或稍后再试";
  ```
- 建议：当 `answer.state == .suggestions` 时用 `answer.asks` 更新建议卡；`load()` 失败置 `failed`，并给页面加 `.refreshable { await model.load() }` 或让文案不再承诺下拉。服务器当前对非空 query 只返回 `answered`/`not_found`，所以这是低概率路径，但客户端状态机应自洽。

### 6. 低 `SearchBasis.id` 不含 `at`，同线程同日多条依据可能撞 `ForEach` id（推测）
- 文件:行：`clients/apple/Sources/HimawariCore/SearchAnswer.swift:17`、`clients/apple/Sources/HimawariShell/Search/SearchPage.swift:127`、`apps/agent-service/src/production-search.ts:315-321,368-374`
- 问题：`id` 由 `kind/memoryId/threadId/recordId/label` 拼接，没有 `at`。服务器给 conversation 依据时 `memoryId`、`recordId` 都是 `null`，`label` 只精确到日期；同一对话线程同一天的两条 episode 依据会得到相同 id。`ForEach` 用 `\.element.id`，重复 id 会导致 SwiftUI 未定义行为（通常表现为行错乱或运行时告警）。
- 证据：
  ```swift
  // SearchAnswer.swift:17
  public var id: String { [kind.rawValue, memoryId, threadId, recordId, label].compactMap { $0 }.joined(separator: ":") }
  ```
  ```swift
  // SearchPage.swift:127
  ForEach(Array(basis.enumerated()), id: \.element.id) { index, item in
  ```
  服务器 `basis` 来自 `ranked.slice(0, settings.basisLimit)`，同一 thread 的 episode 可以同时入选（`production-search.ts:305-322`）。
- 建议：把 `at` 纳入 `id`（最好再加 `recordId`/`memoryId` 的优先级规则），或在解码时按服务器顺序生成稳定且唯一的 id。补一条重复 `threadId+label` 的解码/渲染测试。

### 7. 低 查询长度没有客户端上限，超过契约 500 字符只能得到通用失败
- 文件:行：`clients/apple/Sources/HimawariShell/Search/GatewaySearchSource.swift:12-15`、`packages/gateway-contracts/src/contracts-v2.ts:1065-1068`
- 问题：`TextField` 不限制长度，`SearchQuestion.trimmed` 只去空白，客户端把整段文本发出去；契约要求 `query` 是 `nullable(boundedString(500))`，超长会被服务器拒绝，页面只显示 `search.failed`，用户不知道是长度问题。
- 证据：
  ```swift
  // GatewaySearchSource.swift:14-15
  let query: JSONValue = question.map { .string($0) } ?? .null
  let data = try await gateway.read(.v2, "search.ask.read", payload: ["query": query, "locale": .string(locale)])
  ```
  ```ts
  // contracts-v2.ts:1067
  payload: object({ query: nullable(boundedString(500)), locale: enumeration(HOME_LOCALES) }),
  ```
- 建议：提交前按契约截断或校验长度并显示明确错误，避免无谓的网络往返。补超长输入的边界测试。

### 8. 低 作者“逻辑在 HimawariCore 里有测试”与代码不符：状态机在 HimawariShell 且没有测试
- 文件:行：`clients/apple/Sources/HimawariCore/SearchAnswer.swift`、`clients/apple/Sources/HimawariShell/Search/SearchModel.swift`、`clients/apple/Tests/HimawariCoreTests/SearchAnswerTests.swift`
- 问题：HimawariCore 里只有 `SearchAnswer` 解码和 `SearchQuestion.trimmed`，测试也只覆盖这些；`SearchModel` 的加载、失败、重置、建议状态逻辑在 HimawariShell，没有任何测试文件引用它。作者说法只对解码部分成立。
- 证据：`SearchAnswerTests.swift` 只调用 `SearchAnswer.decode` 和 `SearchQuestion.trimmed`；仓库内 `clients/apple/Tests` 没有 `SearchModel` 引用。
- 建议：把可脱离 SwiftUI 的状态逻辑（尤其是 `reset`、失败处理、`asks` 采用）移到 HimawariCore 并补测试，或在 Mac 测试目标里补 `SearchModel` 用例。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

不会。这个 diff 只新增/修改 iOS 的 SwiftUI 页面、`SearchAnswer` 解码和 `GatewaySearchSource`，没有改系统提示、工具定义、历史消息或遮盖相关代码，也没有向任何对话追加消息。`search.ask.read` 是设备网关的只读查询，`ProductionSearchControl.query` 用本地词项匹配和记忆/对话/感知读取直接返回快照，没有调用模型（`apps/agent-service/src/production-search.ts:178-192`）。因此“只追加”和“变化值放最后一条消息”这两条在本改动上没有可违反的模型请求；`check:prompt-prefix` 不适用于本次新增内容。

**2. 同一段文字会不会在不同请求里变成不同字节（依赖前后文的遮盖、带时间的字段、无序集合）？**

对模型请求：不涉及，本功能不构造模型请求。对设备网关请求：同一 `query` + `locale` 经 `ManageGateway` 以 `.sortedKeys` 编码（`ManageGateway.swift:158-159`），同一文字每次序列化字节固定；`search.ask.read` 是 query，不会生成幂等键。`messageId` 每次都随机，但它不进模型上下文，也不是这段文字的内容。服务器响应里有 `generatedAt`，依据 `label` 按“当前日期”计算年份（`production-search.ts:28-41,190,370-373`），建议顺序还依赖 `useCount`/`updatedAt`（`production-search.ts:227-235`），所以同一个问题隔天问可以显示不同 label 字节；这些目前只用于界面，不进入任何模型请求，未发现缓存风险。查询文字本身只被 `SearchQuestion.trimmed` 去掉首尾空白，映射是确定的。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有解码单元测试：`SearchAnswerTests` 覆盖完整 answered、not_found、缺省 basis/asks、空白 answer、未知 state 和空白问题，其中“未知 state 解码失败”“空白问题不发送”是反向用例。`check:operations` 也覆盖这个操作，但本 PR 没有更新待接入名单，按脚本逻辑它会报 `OPERATION_PENDING_BUT_COMPLETE`（`scripts/check-operations.mjs:430-433`），对应的工具测试里也有这条反向断言（`test/tooling/operations-check.test.mjs:156`）。UI 和 `SearchModel` 的失败/重置/建议状态没有自动测试；作者说“逻辑在 HimawariCore 里有测试”只对解码部分成立。受工具限制，我没有实际运行 Swift 或 npm 检查，上述是按代码推得，未在 Mac 上核实。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

逐项核对：
- `"search.ask.read"`：Swift 调用处（`GatewaySearchSource.swift:15`）与客户端能力表（`ClientCapabilities.swift:152`）、契约（`contracts-v2.ts:3769`）、服务器实现（`production-search.ts:20,179`）一致；但 `ci/operations-pending.json:26` 这个使用方不接受“已齐全”，会报红（意见 1）。
- payload 键 `query`、`locale`：与 `searchAskQuerySchema`（`contracts-v2.ts:1065-1068`）一致；`locale` 的 `zh-CN/en/ja` 与 `HOME_LOCALES`（`contracts-v2.ts:982`）及 `HomeLocale` raw value（`HomeFeed.swift:3-6`）一致；`query` 可为 null/string，客户端按 null 发建议请求。
- 响应字段 `state/query/answer/notFoundText/basis/asks`、三个 state、三种 basis kind：与 `searchAskSnapshotSchema`（`contracts-v2.ts:1069-1088`）和 fixture（`gateway-v2.fixture.ts:783-800`）一致；`generatedAt` 被客户端忽略，JSONDecoder 允许未知字段。`at` 契约要求必填，客户端声明为可选，属于更宽松接受，不拒绝合法响应。
- 设计 token：`tokens.json` 的 `search` 键经 `make-design-tokens.mjs` 生成 `DesignTokens.Search`，键已排序，和生成文件一致；图标 `sun` 同时出现在 `Icon.swift:77`、`icons.json:80` 和 `sun.imageset`，三处一致。
- `SearchBasis.id` 是客户端新产生的值，唯一用于 `ForEach`（`SearchPage.swift:127`），唯一性没有保证（意见 6）。
- `MainTab.memory` 存在（`RootView.swift:72`），依据跳转能编译；`HomeLocale.matching(Locale.preferredLanguages)` 的参数类型匹配（`HomeFeed.swift:8`）。
- 查询长度：客户端不校验，服务器契约 500 字符会拒绝（意见 7）。

没有发现其他两端字段名或枚举值不一致；`search.ask.read` 的契约和客户端能力在基线里已存在，本 PR 不需要重新生成。
