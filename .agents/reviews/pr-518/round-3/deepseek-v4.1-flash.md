### 1 [中高/需确认] 作者说手机端接 `suggestion.*`，代码实际接的是 `proposals.*`，两套合约族不同
文件: `clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:127,153,168`；`clients/apple/Sources/HimawariManage/Settings/ProposalModels.swift:21-35`；`packages/gateway-contracts/src/contracts-v2.ts:2844-2851,2952-2965`
问题: 作者说服务端是 `suggestion.list`、`suggestion.detail`、`suggestion.respond`，但手机端实际调用 `proposals.read` 和 `proposal.respond`。两者不是同一套：`suggestion.respond` 的载荷是 `suggestionId`、`expectedRevision`、`decision: approve|reject`；页面用的是 `proposalId`、`version`、`fingerprint`、`action: adopt|reject`、`fullReadToken`。如果按作者说法实现，这个页面接错了后端；如果按代码，则作者说法和页面命名都错了。
证据:
- `SettingsStore.swift:127`：`"proposal.respond"`；`:153`：`"proposals.read"`；`:168`：`gateway.read(.v2, "proposals.read", ...)`。
- `contracts-v2.ts:2844-2851`：`commandEnvelope("suggestion.respond")`，载荷为 `suggestionId`、`expectedRevision`、`decision`。
- `Generated/ClientCapabilities.swift:132-133` 有 `proposals.read`/`proposal.respond`；`:180,193-194` 另有 `suggestion.respond`/`suggestion.list`/`suggestion.detail`。
- `docs/glossary.md:45` 把“待采纳的改进”对应到“自我改进候选”，而控制中心的自我改进用的是 `improvement.list/detail/review`（`apps/control-center/src/app/control-center-inventory.ts:347-352`），又是第三套。
建议: 先确认页面到底属于 `suggestion.*`、`improvement.*` 还是 `proposal.*`。若按作者说法，需把模型、Store、页面全部换成 `suggestion.*`，并去掉只属于 proposal 的 `fingerprint`、`requiresFullRead`、`adoptable`、`fullReadToken`；若代码才是对的，则必须更正作者说法和“待采纳的改进”的术语映射。这条不是本轮增量引入，是核对作者说法时发现的；增量新增的 `requiresFullRead` 门槛也建立在 `proposal.*` 字段上。

### 2 [中] `requiresFullRead` 的“先展开依据”门槛会被只有 `sources` 的依据绕过，且 sources 从未显示
文件: `clients/apple/Sources/HimawariManage/Settings/ProposalModels.swift:39-41`；`clients/apple/Sources/HimawariManage/Settings/ProposalsPage.swift:83,106,116-129`
问题: `hasEvidence` 只检查 `text` 和 `figures`，不检查 `sources`；证据展开视图也只渲染 `text` 和 `figures`。合约允许一条 evidence 只有 `sources`、`text: null`、`figures: []`，这种提案的 `hasEvidence` 为 false，于是没有“为什么这么想”按钮，`requiresFullRead` 的采纳禁用也不会生效；即使展开，`sources` 也永远看不到。
证据:
- `ProposalModels.swift:39-41`：`evidence.contains { ($0.text?.isEmpty == false) || !$0.figures.isEmpty }`。
- `ProposalsPage.swift:83`：`if proposal.hasEvidence {`；`:106`：`.disabled(proposal.requiresFullRead && proposal.hasEvidence && !open)`。
- `ProposalsPage.swift:116-128` 的 `evidence` 只遍历 `item.text` 和 `item.figures`，没有 `item.sources`。
- `ProposalModels.swift:17` 明确有 `public let sources: [ProposalSource]`。
建议: 把 `!$0.sources.isEmpty` 纳入 `hasEvidence`，并在展开视图里显示 sources；或者不要用客户端自算的 `hasEvidence` 做安全门槛，改用服务端明确给出的“是否必须先读”标志。加一条 `sources`-only 提案的测试。

### 3 [低] 演示的 proposals 快照 `generatedAt` 仍不是网关要求的毫秒格式
文件: `clients/apple/Sources/HimawariManage/ManageDemo.swift:178`
问题: 上一轮第 2 条要求演示和测试的提案时间戳补齐毫秒。测试里的 proposal、list、opened 以及演示里的 proposal 对象已改成 `.000Z`，但演示的 proposals 列表快照 `generatedAt` 仍是 `2026-11-12T00:00:00Z`，未完全改好。
证据:
- `ManageDemo.swift:178`：`..."generatedAt":"2026-11-12T00:00:00Z"}}`。
- `packages/gateway-contracts/src/validation.ts:128-137`：`parsed.toISOString() !== input` 即失败，要求 `2026-11-12T00:00:00.000Z`。
- `ProposalsTests.swift:52` 对应的测试 list 已改为 `.000Z`，说明这里是漏改。
建议: 改为 `2026-11-12T00:00:00.000Z`；最好加一条把演示 JSON 套进网关 `timestamp` 校验的检查。当前客户端 `Snapshot<ProposalList>` 不解析 `generatedAt`，所以不会立刻解码失败，只是不符合合约。

### 4 [低] 新增的采纳门槛没有自动检查，反向用例不会失败
文件: `clients/apple/Sources/HimawariManage/Settings/ProposalsPage.swift:106`；`clients/apple/Tests/HimawariManageTests/ProposalsTests.swift`
问题: 新增的 `requiresFullRead && hasEvidence && !open` 只存在于 SwiftUI 视图里，`ProposalsTests` 全部测的是 `SettingsStore`，仓库里没有任何 `ProposalRow`/视图测试。把条件删掉、改反或漏掉 `busy`，现有测试都不会失败。
证据:
- `ProposalsPage.swift:106` 是新条件。
- `ProposalsTests.swift:64-187` 全部是 `SettingsStore` 的加载/响应测试；在测试目录里搜索不到 `ProposalRow`。
- 作者说明 Swift 编译和 `swift test` 在 Mac 上做，本机没有 Swift，我未运行。
建议: 把禁用条件抽成可测试的纯函数/属性（例如 `adoptDisabled(requiresFullRead:hasEvidence:open:busy:)`），补反向用例：需要读全文且有依据未展开时禁用、展开后启用、没有依据时启用、`busy` 时禁用、只有 sources 时禁用（配合意见 2）。

### 5 [低] 上一轮第 5 条只改了一半：原始错误已核对，但测试仍是自造 transport，且只断言 409
文件: `clients/apple/Tests/HimawariManageTests/ProposalsTests.swift:6-45,172-187`
问题: 新失败用例现在会断言 `ManageGatewayError.rejected(status: 409)`，这一点改好了；但 `ProposalTransport` 仍是手写假实现，`proposal.respond` 分支只检查 `recentAuthenticationRef` 和 `fullReadToken` 是否存在，不校验 `proposalId`、`expectedVersion`、`fingerprint`、`action` 是否符合网关合约；新用例也只断言状态 409，没有断言原始 `code`/`reason`，也没有断言确实重新读取了列表。
证据:
- `ProposalsTests.swift:36-41`：`if body["type"] == "proposal.respond" { guard case .object(let payload)? = body["payload"], payload["recentAuthenticationRef"] != nil, payload["fullReadToken"] != nil else { ... } return DeviceResponse(status: respondStatus, ...) }`。
- `ProposalsTests.swift:180-183`：只 `XCTAssertEqual(status, 409)` 和列表条数，没有核对 `code`，也没有统计 `proposals.read` 次数。
建议: 在失败用例里断言原始错误码（例如 `INVALID_OPERATION`）和重新读取次数；测试 transport 至少按合约字段校验或直接从 `packages/gateway-contracts` 的 fixture 生成响应，避免载荷写错也能通过。

### 6 [低/需确认] 新加的 `.disabled` 与外层 `.disabled(busy)` 叠加语义未验证，忙时可能仍可重复点采纳
文件: `clients/apple/Sources/HimawariManage/Settings/ProposalsPage.swift:100-109`
问题: 采纳按钮自己加了 `.disabled(proposal.requiresFullRead && proposal.hasEvidence && !open)`，而忙碌状态由外层 HStack 的 `.disabled(busy)` 控制。SwiftUI 对父子 `.disabled` 的叠加语义没有被本机验证；如果子级的 `.disabled(false)` 会覆盖父级的 `.disabled(true)`，那么 `busy == true` 且门槛条件为 false 时，采纳按钮可能重新可点，导致重复采纳请求。
证据:
- `ProposalsPage.swift:100-106`：`if proposal.adoptable { Button { respond(.adopt) } ... .disabled(proposal.requiresFullRead && proposal.hasEvidence && !open) }`。
- `ProposalsPage.swift:109`：外层 `.disabled(busy)`。
建议: 把忙碌和门槛合成一个条件，例如在按钮上写 `.disabled(busy || (proposal.requiresFullRead && proposal.hasEvidence && !open))`，或在 HStack 上用同一个表达式；同时在 Mac 上补一个 busy 时点击的测试。另建议给禁用态加可见提示或说明，否则按钮仍用 `Color.hmSun`，用户会以为点了没反应。此条属于推测/需确认，未在本机用 Swift 验证。

**上一轮意见核对**
- 第 1 条（需先看全文）：部分改好。`ProposalsPage.swift:106` 确实要求先展开依据才能采纳；但 `hasEvidence` 不含 sources（意见 2），且没有自动检查（意见 4）。另外 `openFullText` 仍只在 `SettingsStore.swift:121-124` 的采纳路径里调用，页面没有独立的“全文”数据源；如果把可展开的依据视为全文，则基本满足，如果原型要求字面展示全文，则仍未实现。原型内容本轮未读到，标未核实。
- 第 2 条（时间戳）：部分改好。测试里的 proposal/list/opened 和演示里的 proposal 对象已补毫秒；但 `ManageDemo.swift:178` 的 proposals 快照 `generatedAt` 漏补，见意见 3。
- 第 5 条（自造 transport、原始错误）：部分改好。原始错误现在检查 409；自造 transport 未改，且没有核对 `code`/重复读取，见意见 5。

**侧重检查**
- 错误路径: 读了 `SettingsStore.respond` 的 rejected 分支（`:140-147`）和 `openFullText`（`:150-165`）；本轮增量没有改这些路径，新增测试只加强了 409 断言。未发现增量引入的新错误处理问题。
- 不合规范或不可信的输入: `Proposal` 的 `summary`、`effect`、`evidence.text`、`figure.name`、`figure.definition` 都直接进 SwiftUI `Text`，没有 Markdown/HTML 注入面；`figure.value` 是 `Int`。但 `sources` 被解码后从不显示，且 `hasEvidence` 忽略它（意见 2）。
- 安全: 客户端门槛不是服务端授权边界；服务端 `production-proposals.ts:442-458` 仍会校验 `fullReadToken`，所以绕过 UI 不会让服务端直接采纳。但“用户是否看过全文”无法由服务端证明；只有 sources 的依据会同时绕过 UI 门槛和显示。
- 资源耗尽: 服务端把 evidence 限制为 20 条、sources 10 条、figures 10 条（`production-proposal-control.ts:21-23,65-85`）；客户端没有再加限制，增量未改变。未发现新的资源耗尽路径。
- 不可撤销的操作: `proposal.respond` 在 `Generated/ClientCapabilities.swift:133` 是 `.change` 档，`ManageGateway.command` 对 `.change` 会发 challenge 并弹确认（`ManageGateway.swift:64-74`）；新 `.disabled` 只作用于采纳按钮，拒绝按钮未受影响。未发现新的绕过确认路径。
- 规则/说明文档和代码一致: 发现作者说法里的 `suggestion.*` 与代码的 `proposals.*` 不一致（意见 1）；演示时间戳与网关 `timestamp` 规则仍有一处不一致（意见 3）。`SettingsRootView.swift:60-70` 在 `store.proposals != nil` 时显示整行，空列表显示“没有”；如果作者说的“没有生产数据时整行不显示”指空列表，则说法与代码不一致，若指 `nil`（读取失败）则成立，需确认。

**必答问题**
1. 不会改变模型已经见过的请求开头。本增量只改 `clients/apple` 的设置页、演示和测试；`git diff --stat` 显示代码改动全部在 `clients/apple/...`，没有触及系统提示、工具定义、历史消息或遮盖的组装。发给模型的内容是否仍然只在末尾追加、每轮变化的值是否都在最后一条消息，本增量没有改变这条路径；采纳规则后服务端如何影响后续请求，属于既有服务端逻辑，本轮未核实。
2. 不会引入“同一段文字在不同请求里变成不同字节”。新增的只有本地禁用布尔值和固定字面量时间戳；时间戳在演示和测试里是固定常量，并已改为确定性的 `.000Z`。没有新增依赖前后文的遮盖、带当前时间的字段或无序集合。
3. 不完整。新增的 `disabled` 门槛没有自动检查；时间戳没有合约级检查；失败用例有检查，但只断言 409，且仍用不校验合约的自造 transport，反向用例不会失败。详见意见 4、5、6。
4. 逐个核对两端：`requiresFullRead` 在网关合约是布尔值（`contracts-v2.ts:2353`），Swift 端是 `Bool`，直接使用可以；`hasEvidence` 是客户端自算值，新增门槛直接消费它，但两边对“依据”的定义不一致（意见 2）；时间戳在 Swift 端只解码成 `String`，测试/演示的直接使用端都能接受，但网关的 `timestamp` 要求毫秒格式，演示的 `generatedAt` 过不了（意见 3）；`ManageGatewayError.rejected(status: Int, code: String?, reason: String?)` 与测试的 `.rejected(let status, _, _)` 匹配，测试能通过。总体是“直接使用端能接受，但与网关契约/作者说法仍有一处错配”。

**本轮查过的范围**
本轮对比了 `2d42580100df02e78be073d6d6f79a4337d5d012..c7ac8c6b9bd4c97b0b5f6866c141151412a6df5a` 的全部增量，并回看了 `ed08ac52b88c90298c34a39167e7049b2d67b9b7..c7ac8c6` 的文件清单。重点读了 `ProposalsPage.swift`、`ProposalModels.swift`、`SettingsStore.swift`、`ManageStrings.swift`、`ManageDemo.swift`、`ProposalsTests.swift`、`SettingsRootView.swift`、`ManageGateway.swift`、`Generated/ClientCapabilities.swift`，以及 `packages/gateway-contracts/src/validation.ts`、`contracts-v2.ts`、`production-proposal-control.ts`、`production-proposals.ts`、`autonomy-gateway-adapter.ts` 和控制中心 inventory；读了 `prompt-prefix.md` 和 `incidents-and-gates.md` 的 I-73 行。未运行 Swift 编译/测试，未读原型文件，也未核实服务端 `PROPOSAL_*` 原因码是否真的没有对外暴露。
