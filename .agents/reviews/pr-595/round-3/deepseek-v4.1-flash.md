查过范围：`git diff ddee68fa..d47f605c` 全量中与搜索相关的代码、`git diff 2a862762..d47f605c` 的增量（代码增量只有 `SearchModel.swift` 的 13+/6-）、`AppModel.emptyStore` 调用点、`SearchPage`/`SearchDemo`/`DemoScenes`、`SearchAnswerTests`、`Package.swift`、`GatewaySearchSource`、gateway v2 的 `search.ask.*` 合约、`validation.ts`、`production-search.ts`、`check-operations.mjs`。第 2 轮复核记录文件无法用 `git show` 读取（被规则拒绝），以下按题面列出的意见 1 逐行核对代码。

上一轮意见 1 已真的改好：`reset()` 现在同时递增 `generation` 并清 `asking`；`ask`/`load` 在写回前比较 `generation`，`defer` 也只在 generation 未变时清 `asking`。旧请求成功或失败都不会覆盖新状态，也不会清掉 reset 后新请求的 `asking`。

### 1. 中 第 2 轮修复正确，但没有任何自动检查，反向用例不会失败
文件:行：`clients/apple/Sources/HimawariShell/Search/SearchModel.swift:19,36-39,51-63,66-68`；`clients/apple/Tests/HimawariCoreTests/SearchAnswerTests.swift:5-50`；`clients/apple/Package.swift:21-24,41`。

问题：本轮新增的 `generation`/`reset` 并发逻辑位于 `HimawariShell`，不在 `HimawariCore`；仓库里没有 `SearchModel` 测试。作者说“逻辑在 HimawariCore 里有测试”只对 `SearchAnswer` 的解码/裁剪成立，对这次修复不成立。Linux 构建又完全排除 `HimawariShell` 及其测试，因此删除 `guard mine == generation` 后现有测试仍会全绿。

证据（读代码证实）：
```swift
// SearchModel.swift
@ObservationIgnored private var generation = 0          // :19
let mine = generation                                   // :51
asking = question                                       // :52
defer { if mine == generation { asking = nil } }         // :53
guard mine == generation else { return }                // :56
...
public func reset() {
    generation += 1                                      // :67
    asking = nil                                         // :68
```
`SearchAnswerTests.swift` 只测试解码、空白答案和 `SearchQuestion.trimmed`，没有任何 `SearchModel` 引用。`Package.swift` 在 Linux 下 `let interfaceTargets: [Target] = []`，`HimawariShellTests` 只在非 Linux 目标里定义：
```swift
#if os(Linux)
let interfaceTargets: [Target] = []
...
.testTarget(name: "HimawariShellTests", dependencies: ["HimawariShell", "HimawariCore"])
```
推测（未核实）：Mac 侧是否有本轮之外的手工验证，仓库里看不到；提交说明只写了 `check:apple-design` 和“待 Mac 编译”。

建议：至少新增 `HimawariShellTests` 用例，用可控 `SearchSource`（挂起 continuation）验证“reset 后旧结果不写回、旧 defer 不清新 asking”，并做一个删除 guard 必须失败的对照。若希望 Linux CI 覆盖，可把纯请求代次协调逻辑抽到 `HimawariCore` 并在那里测试。

### 2. 中低 搜索 query 没有按 gateway 合约的 500 字符/控制字符约束处理，超长输入会被后端拒绝
文件:行：`clients/apple/Sources/HimawariShell/Search/SearchModel.swift:43-45`；`clients/apple/Sources/HimawariShell/Search/GatewaySearchSource.swift:12-15`；`packages/gateway-contracts/src/contracts-v2.ts:1065-1068`；`packages/gateway-contracts/src/validation.ts:102-116`。

问题：客户端只做首尾空白裁剪，就把任意长度的问句作为 `query` 发出去；服务端合约要求 `query` 是 `nullable(boundedString(500))` 且不含控制字符。用户粘贴超过 500 字符的文本（或带入控制字符）时，请求会在合约校验处失败，界面只显示通用的“暂时搜不了”，而不是明确的输入错误。这是本次增量之前就存在的值两端校验不一致，不是本轮新增。

证据（读代码证实）：
```swift
// SearchModel.swift
guard let question = SearchQuestion.trimmed(text) else { return }  // :44
await ask(question)                                                // :45

// GatewaySearchSource.swift
let query: JSONValue = question.map { .string($0) } ?? .null       // :14
let data = try await gateway.read(.v2, "search.ask.read", payload: ["query": query, "locale": .string(locale)])  // :15

// contracts-v2.ts
payload: object({ query: nullable(boundedString(500)), locale: enumeration(HOME_LOCALES) })  // :1067

// validation.ts
input.length > maximum ||                                            // :108
[...input].some((character) => { ... code < 0x20 || code === 0x7f }) // :109-112
```
推测（未核实）：具体 HTTP 状态码由网关返回；按 `ManageGateway.read` 的非 2xx 分支会抛 `ManageGatewayError.rejected`，再进入 `SearchModel` 的 `catch` 置 `failed = true`，因此 UI 显示 `search.failed` 的路径成立。

建议：发送前按合约上限处理 query（注意服务端按 JS UTF-16 长度算，保守可按 `String.count` 截到更短），并拒绝或折叠控制字符；给超长输入单独的可本地化提示，并补一条两侧校验的测试。

**侧重检查**

- 错误路径：`SearchModel` 对 `ask` 失败会清空 `answer` 并置 `failed`；`load` 的失败被静默吞掉，只影响建议卡，不显示错误，属于可接受取舍。`reset` 期间的旧请求成功/失败都被 `generation` 拦住，读代码确认不会再污染 UI。
- 不合规范或不可信输入：query 的长度/控制字符两端不一致，见意见 2。服务端返回的 `state`、`basis.kind` 都是枚举；未知值会让整条答案解码失败，界面显示失败而非崩溃。`label` 和答案都按纯 `Text` 显示，没有 HTML/Markdown 注入面。
- 安全：搜索是只读操作，新增代码没有日志、没有持久化、没有新密钥；请求复用现有的 `SignedDeviceTransport`。退配对路径 `AppModel.emptyStore()` 会调用 `search.reset()`，随后才清 key/凭据，旧账号结果不会写回。
- 资源耗尽：`reset()` 不会取消底层在途请求，只是丢弃结果；正常路径同时只允许一个 `ask`，reset 后短时间内最多新旧两个只读请求重叠，影响有界，未列为阻断问题。建议以后有取消句柄时顺手取消。
- 不可撤销操作：本改动没有写操作或不可撤销操作。
- 规则/文档一致：`ci/operations-pending.json` 删除 `search.ask.read` 与 `check-operations.mjs` 的要求一致（`GatewaySearchSource.swift` 有字面调用、`production-search.ts` 有实现、测试里有该字面量）；`DesignTokens.Search` 与 `tokens.json` 键一致，三个 `.lproj` 都有新增文案。作者“逻辑在 HimawariCore 里有测试”的说法与代码不一致，见意见 1。`.agents/instructions/prompt-prefix.md` 不在本次 sparse checkout 中，未读到原文。
- 推测（未核实）：若服务端以后在非空 query 时返回 `state=suggestions` 且带 `asks`，`SearchPage` 会忽略 `answer.asks`，而显示 `model.suggestions`（初始加载的建议）；当前 `production-search.ts` 的 `#answer` 只返回 `answered`/`not_found`，现在不会触发。另 `SearchBasis.id` 由 kind+各类 id+at+label 拼接，如果服务端返回两条这些字段完全相同的依据，`ForEach` 会出现重复 id；未找到服务端会这样返回的证据。

**必答问题**

1. 不改变模型已经见过的请求开头。本次代码只新增设备侧 `search.ask.read` 调用和搜索 UI，没有改系统提示、工具定义、历史消息或遮盖结果，也没有任何模型请求构造路径；搜索答案只用于显示，不回灌模型。规则要求的“内容只追加、每轮变化值只在最后一条”在本改动中不涉及。
2. 不会让模型看到的同一段文字变成不同字节。搜索请求里同一问句的 `query` 字符串按原样发送，`locale` 固定为设备语言；`ManageGateway` 每次生成随机 `messageId`（`ManageGateway.swift:132`），但这不是模型输入，也不参与前缀缓存。服务端依据文案里带日期（`production-search.ts:28-72`）只是显示文本，不进入模型。
3. 有部分自动检查，但本轮的并发修复没有。`SearchAnswerTests` 覆盖解码、空答案、缺失 basis/asks 和未知 state；`check-operations` 覆盖 `search.ask.read` 的调用方/实现/测试登记。增量 `generation`/`reset` 逻辑没有任何测试，反向用例（删掉 guard）不会让现有测试失败。测试未实际运行，只做了代码核对。
4. 逐项核对：
   - `search.ask.read`：从 `ci/operations-pending.json` 移除后，`check-operations` 要求的三端都存在——`GatewaySearchSource.swift:15` 调用、`production-search.ts:20` 安装、测试里有字面量；`ClientCapabilities.swift:152` 登记为 `.query`/`.read`，`ManageGateway.read` 只接受 `.read`，两端一致。
   - `query`/`locale`：`locale` 的 `HomeLocale.rawValue` 是 `zh-CN`/`en`/`ja`，与 `HOME_LOCALES` 一致；`query` 的可空值形态一致，但长度/控制字符两端不一致，见意见 2。
   - 响应字段：`state`、`basis.kind`、`label`、`memoryId`/`threadId`/`recordId` 与合约一致；Swift 把合约非空的 `at` 解码成可选 `String?`，比合约更宽松，不会拒绝合法响应。
   - 设计值：`DesignTokens.Search` 的键和 `tokens.json` 一致，`make-design-tokens.mjs` 已把 `search` 纳入生成；`search.title`/`basis`/`back`/`placeholder`/`failed` 在 en/ja/zh-Hans 都存在，`sun` 图标也有对应 assets 与 `icons.json` 项。
