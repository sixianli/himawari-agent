复核范围：读完 PR 全部 Swift 改动、服务端 `proposals.*` 合约与处理器、设备网关、现有 Web 端实现、相关文档和测试。下面按严重度排列。

### 1 [阻断] `proposals.read` 少了必填的 `open`，真机上提案列表永远读不出来

文件:行：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:143-145`；`packages/gateway-contracts/src/contracts-v2.ts:2328-2339`；`packages/gateway-contracts/src/validation.ts:192-197`；`apps/control-center/src/memory.ts:186-190`

问题：客户端查询 `proposals.read` 时没有带 `payload.open`。服务端合约要求 `payload` 中必须有 `open` 键（可为 `null`），而对象校验对缺失键直接报 `missing required field`，所以请求在进入 `ProductionProposalControl` 之前就返回 400。

证据：

```swift
// SettingsStore.swift
private func loadProposals() async throws -> ProposalList {
    let data = try await gateway.read(.v2, "proposals.read")
```

```ts
// contracts-v2.ts
const proposalsQuerySchema = object({
  ...envelope("query", "proposals.read"),
  payload: object({
    open: nullable(object({ proposalId: machineString, ... })),
  }),
});
```

```ts
// validation.ts
for (const key of expectedKeys) {
  if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");
```

Web 端已经给出了正确用法：

```ts
// apps/control-center/src/memory.ts
.query(queryMessage(configuration, "proposals.read", { open: null }))
```

建议：改成 `gateway.read(.v2, "proposals.read", payload: ["open": .null])`，并补一条真正走 `gatewayV2MessageSchema.parse` 的用例；否则设置页的提案行永远不出现。

### 2 [阻断] `proposal.respond` 少了 `recentAuthenticationRef` 和 `fullReadToken`，两个按钮都会在契约校验前失败

文件:行：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:121-131`；`packages/gateway-contracts/src/contracts-v2.ts:2383-2393`；`packages/platform-node/src/device-gateway.ts:109-116,125-138,234-244`

问题：客户端只发了四个字段，服务端命令 schema 要求六个字段都出现（两个可空但不可缺失）。设备网关的“服务器填写引用”只在键已存在时替换，不会补键；因此 `recentAuthenticationRef`、`fullReadToken` 缺失会让 `schema.parse` 直接失败。也就是说“采纳”和“不要”都不会到达提案处理器。

证据：

```swift
payload: [
    "proposalId": .string(proposal.proposalId),
    "expectedVersion": .number(Double(proposal.version)),
    "fingerprint": .string(proposal.fingerprint),
    "action": .string(action.rawValue),
]
```

```ts
// contracts-v2.ts
payload: object({
  proposalId: machineString,
  expectedVersion: integer(1),
  fingerprint: machineString,
  action: enumeration(PROPOSAL_ACTIONS),
  recentAuthenticationRef: nullable(machineString),
  fullReadToken: nullable(machineString),
}),
```

```ts
// device-gateway.ts：只替换已经存在的键
if (Object.hasOwn(payload, RECENT_AUTHENTICATION_KEY))
  filled[RECENT_AUTHENTICATION_KEY] = ...
...
schema.parse({ ...common, ... })
```

另外，设备网关只接受“已存在且值为 `"device"`”的 `recentAuthenticationRef`，所以不能简单传 `null`：

```ts
SERVER_FILLED_PAYLOAD_KEYS.some((key) =>
  Object.hasOwn(payload, key) &&
  payload[key] !== DEVICE_REFERENCE_PLACEHOLDER
) // invalid()
```

建议：命令 payload 补上：

```swift
"recentAuthenticationRef": .string(ClientCapabilities.referencePlaceholder),
"fullReadToken": .null,
```

并用真实合约或设备网关测试覆盖，避免假 transport 再次漏掉这类缺失。

### 3 [严重] 客户端丢弃了 `requiresFullRead` / `requiresPresence`，需要先看全文的提案永远采纳不了

文件:行：`clients/apple/Sources/HimawariManage/Settings/ProposalModels.swift:21-47`；`packages/gateway-contracts/src/contracts-v2.ts:2340-2381`；`apps/agent-service/src/production-proposals.ts:442-458,792`；`docs/architecture-v0.1.md:431`

问题：服务端快照明确返回 `requiresFullRead`、`requiresPresence` 和打开全文后的 `opened.fullReadToken`，但客户端的 `Proposal`/`ProposalList` 完全没有这些字段。客户端也从不以 `open` 调用 `proposals.read` 换取短期凭据，因此只要某条提案 `requiresFullRead`，即使补上第 2 条的键，采纳仍会报 `PROPOSAL_FULL_READ_REQUIRED`，而页面既不提示“先看全文”，也不会先打开全文。

证据：

```swift
public struct Proposal: Decodable, Sendable, Identifiable, Hashable {
    public let proposalId: String
    ...
    public let adoptable: Bool
    public let evidence: [ProposalEvidence]
    // 没有 requiresFullRead / requiresPresence
}
public struct ProposalList: Decodable, Sendable, Equatable {
    public let proposals: [Proposal]
    public let pendingCount: Int
    public let limit: Int
    public let expiresAfterDays: Int
    // 没有 opened
}
```

```ts
// contracts-v2.ts
adoptable: booleanValue,
requiresFullRead: booleanValue,
requiresPresence: booleanValue,
...
opened: nullable(object({ proposalId, fullReadToken, expiresAt })),
```

```ts
// production-proposals.ts
if (row.status === "pending") this.#requireFullRead(row, responder);
```

文档也明确要求客户端打开全文：

```md
// docs/architecture-v0.1.md:431
需要先看全文的提议（`requiresFullRead`），客户端打开全文时用 `proposals.read` 的 `open` 换一个服务器签发的短期凭据……采纳时带 `fullReadToken`
```

建议：解码这三个字段；当 `requiresFullRead` 时先带 `open: {proposalId, expectedVersion, fingerprint}` 读取并保存 `opened.fullReadToken`，再把它放进 `proposal.respond`；`requiresPresence` 通过设备网关的确认流程（`recentAuthenticationRef` 用占位符）处理。`PROPOSAL_FULL_READ_REQUIRED` / `PROPOSAL_PRESENCE_REQUIRED` 也应给出明确提示，而不是通用失败。

### 4 [应改] 说法与代码不一致：页面实际接的是 `proposals.*`，不是作者说的 `suggestion.*`；标题术语也与 glossary 冲突

文件:行：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:123,144`；`packages/gateway-contracts/src/client-capabilities.ts:171-172,224,237-238`；`packages/gateway-contracts/src/contracts-v2.ts:3316-3346`；`docs/glossary.md:45`；`docs/architecture-v0.1.md:428`

问题：作者说服务端用 `suggestion.list` / `suggestion.detail` / `suggestion.respond`，但代码实际调用 `proposals.read` / `proposal.respond`。`suggestion.snapshot` 是 `suggestionId/titleRef/bodyRef/evidenceRefs` 这一套，和页面的 `proposalId/summary/effect/evidence/adoptable` 完全不是一套；从字段看实现接的是“提案箱”，不是 suggestion。另 `docs/glossary.md` 把“待采纳的改进”定义为“自我改进候选”，而这里读的是 `owner_proposals`。

证据：

```swift
"proposal.respond"
...
let data = try await gateway.read(.v2, "proposals.read")
```

```ts
// client-capabilities.ts：两套都在表里，但本页只用了第二套
query("v2", "proposals.read"),
change("v2", "proposal.respond"),
...
change("v2", "suggestion.respond"),
query("v2", "suggestion.list"),
query("v2", "suggestion.detail"),
```

```ts
// contracts-v2.ts：suggestion 快照没有 summary/effect/adoptable
suggestionId, revision, status, kind, titleRef, bodyRef, evidenceRefs ...
```

建议：先确认产品目标到底是提案箱（`proposals.*`）、自主建议（`suggestion.*`）还是自我改进候选（`improvement.*`）。如果按“摘要/效果/依据/不可采纳的不显示采纳”这组要求，代码选的 `proposals.*` 是对的，作者的说法和 glossary 需要更正；如果确实要 `suggestion.*`，本页的数据模型和接口都接错了，需要重做。

### 5 [应改] 失败后的重读把 `reload` 错误吞掉，`.done` 和 `.gone` 都可能在未确认的情况下返回

文件:行：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:115-117,132-139`；`clients/apple/Tests/HimawariManageTests/ProposalsTests.swift:117-127`

问题：`reloadProposals()` 用 `try?` 静默失败；采纳/拒绝成功后即使重读失败也返回 `.done`，页面会显示“已采纳”但列表仍是旧的。失败分支则把所有非 401/403 的拒绝都拿去重读，重读失败或本地列表为空时直接返回 `.gone`，无法区分“真不在了”和“重读失败/契约错误”。现有反向测试只覆盖“500 + 重读得到同一列表”，没有覆盖重读失败、400 契约错误和 404。

证据：

```swift
public func reloadProposals() async {
    if let listed = try? await loadProposals() { proposals = listed }
}
...
await reloadProposals()
return .done(action)
...
guard let latest = proposals?.proposals.first(where: { ... }) else { return .gone }
```

建议：重读失败时保留原错误，不要落到 `.gone`；成功命令后只有在重读成功时才返回 `.done`，否则让页面知道列表可能过期。测试补上重读失败、400/404/409 的区分。

### 6 [应改] 新测试用假 transport，完全不校验 payload 契约，发现不了第 1、2 条

文件:行：`clients/apple/Tests/HimawariManageTests/ProposalsTests.swift:7-37,72-93`；`test/tooling/client-parity.test.ts:180-219`

问题：`ProposalTransport` 只按 `type` 分支返回字符串，既不检查读请求有没有 `open`，也不检查命令是否带 `recentAuthenticationRef` / `fullReadToken`；测试只断言了“发送了哪些键”，没有断言“服务端要求的键都在”。`check:client-parity` 只核对能力类型和生成文件，不核对 payload 形状。因此这些测试会在生产请求必然失败的情况下继续通过。

证据：

```swift
private func reply(_ body: [String: JSONValue]) -> DeviceResponse {
    sent.append(body)
    if body["type"] == "proposals.read" { ... return ... }
    if body["type"] == "proposal.respond" { ... return ... }
}
```

建议：至少加一条用一个严格按 `gatewayV2MessageSchema` 校验请求的假服务端；或在 Node 侧的 client-parity 测试里把客户端实际 payload 交给合约解析。反向用例应包括“删掉 `open` 必须失败”和“删掉 `recentAuthenticationRef`/`fullReadToken` 必须失败”，否则这两条自动检查没有守住真正的缺陷。

### 7 [应改] Demo/测试数据和真实合约对不上，正是 I-73 说的“清单里的 id 能过后端校验吗”

文件:行：`clients/apple/Sources/HimawariManage/ManageDemo.swift:173-183,233-247`；`clients/apple/Tests/HimawariManageTests/ProposalsTests.swift:39-41`；`apps/agent-service/src/production-proposals.ts:25`；`packages/gateway-contracts/src/contracts-v2.ts:2340-2381`

问题：服务端提案编号必须是 `^[a-z][a-z0-9-]{0,31}:[0-9a-f]{32}$`，而 Demo 用 `"p1"` / `"p2"`、测试用 `"a:1"`，都不能通过后端校验。Demo 快照还缺 `requiresFullRead`、`requiresPresence`、`opened` 等快照必填字段。`DemoTransport` 直接返回字符串、不解析合约，所以这些问题不会暴露。作为原型/演示没问题，但它不能拿来证明真实路径可用，也正好复制了 I-73 的教训。

证据：

```ts
const PROPOSAL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}:[0-9a-f]{32}$/u;
```

```swift
proposal("p1", ...)
proposal("p2", ...)
...
return #"{"payload":{"proposals":[...],"pendingCount":2,...}}"#
```

```swift
private func proposalJSON(_ id: String, ...) -> String {
    #"{"proposalId":"\#(id)",...}"#
}
XCTAssertEqual(payload["proposalId"], "a:1")
```

建议：Demo/测试编号改成符合服务端格式（例如 `rule:` + 32 位十六进制），并补齐快照必填字段；再加一条把 Demo 快照也喂给 `gatewayV2MessageSchema` 的检查。这样演示数据才能真正代表生产数据。

### 8 [低] 依据里的 `figures` 用 `name` 当 `ForEach` 标识，重复名字会产生重复 id；`sources` 完全不显示

文件:行：`clients/apple/Sources/HimawariManage/Settings/ProposalsPage.swift:115-126`；`clients/apple/Sources/HimawariManage/Settings/ProposalModels.swift:37-39`

问题：服务端合约没有保证同一 evidence 内 `figure.name` 唯一，`ForEach(item.figures, id: \.name)` 遇到重复名字会出现重复 ID，SwiftUI 行为不确定。另 `hasEvidence` 只看 `text` 和 `figures`，`sources` 既不显示也不参与判断；只有 `sources` 的依据会连“为什么这么想”都不出现。

证据：

```swift
public var hasEvidence: Bool {
    evidence.contains { ($0.text?.isEmpty == false) || !$0.figures.isEmpty }
}
```

```swift
ForEach(item.figures, id: \.name) { figure in
```

建议：用 `enumerated()` 的 offset 或 `name + index` 作 id；明确 `sources` 是否需要展示，若需要则一起渲染，并把只有 sources 的依据也算作可展开。

### 9 [低/需确认] 空列表时根行仍显示“没有”，与“没有生产数据时整行不显示”的字面可能不一致；通知在列表清空时也会消失

文件:行：`clients/apple/Sources/HimawariManage/SettingsRootView.swift:60-70`；`clients/apple/Sources/HimawariManage/Settings/ProposalsPage.swift:16-25,40-42`

问题：根行只在 `store.proposals == nil` 时隐藏；服务端正常返回空数组时仍显示“待采纳的改进 / 没有”。如果原型的意思是“没有提案就整行不显示”，这里不符合。另 `notice` 只在非空列表分支里渲染，采纳最后一条后列表变空，用户看不到“已采纳”。

证据：

```swift
if let proposals = store.proposals {
    Button { path.append(.proposals) } label: {
        SettingsRow(
            title: M.proposalsTitle,
            value: proposals.proposals.isEmpty ? M.proposalsNone : "\(proposals.proposals.count)",
```

```swift
if list.proposals.isEmpty {
    EmptyStateView(Text(M.noProposals)) ...
} else {
    ...
    if let notice { Text(notice) ... }
```

建议：按已批准原型确认空列表是否要隐藏整行；若需要，改成 `if let proposals = store.proposals, !proposals.proposals.isEmpty`。把 `notice` 提到空/非空分支之外，保证最后一条处理后仍有反馈。

**读代码证实 / 推测分开**

- 读代码证实：第 1、2、3、5、6、7、8、9 条中的接口形状、缺失字段、编号正则、`ForEach` 标识、根行条件都来自当前代码；第 4 条中 `suggestion.*` 与 `proposals.*` 是两套不同合约，也由代码直接证实。
- 推测/未核实：生产当前是否实际存在 `requiresFullRead` 的提案（代码路径存在，但没有生产数据样本）；已批准原型是否要求空列表隐藏整行；Swift 编译和 `swift test` 结果（本机没有 Swift，作者说由 Mac 线程负责）；`.agents/reviews/pr-518/brief.md` 里的原型细节未能读取。

**侧重检查**

- 错误路径：查了 `respond` 的 400/401/403/404/409/500 分支、`reloadProposals` 的 `try?`、`.done/.changed/.gone` 的判定。结论是第 1、2 条会让请求在校验层失败，第 3 条让全文提案无法采纳，第 5 条让失败分类和完成状态不可靠。
- 不合规范/不可信输入：服务端对 summary/effect/证据长度有上限，客户端用 `Text` 原样显示，没有 HTML/Markdown 注入面；但 `figure.name` 作为 id 没有唯一性保证，Demo/测试编号不符合服务端正则，快照字段也不完整（第 7、8 条）。
- 安全：`proposal.respond` 在能力表是 `.change`，`ManageGateway.command` 会先申请 challenge 并弹出确认，这一点符合“要过面容”。服务端还会强制检查 `requiresFullRead` 和 `requiresPresence`，所以客户端缺失不会造成绕过，只会失败关闭。但当前客户端没有实现这两道凭据（第 3 条）。
- 资源耗尽：服务端列表最多 200 条，证据每类最多 20/10/10 条，文本有长度上限；客户端没有分页循环或无限追加，未发现新的资源耗尽路径。
- 不可撤销操作：采纳可能产生真实副作用；当前 UI 成功后没有撤销入口，服务端对 action 类型支持 `undo`，但任务只要求固定“不要/采纳”，所以不作为缺陷，只提示产品确认是否需要后续加撤销。
- 规则/文档/代码一致：`prompt-prefix.md` 的只追加规则没有被本 PR 触碰；但 `architecture-v0.1.md:431` 要求的全文读取流程没有实现（第 3 条），glossary 的“待采纳的改进”定义和本页读的提案箱不一致，作者关于 `suggestion.*` 的说法也与代码不一致（第 4 条）。

**必答问题**

1. 不会改变模型已经见过的请求开头。本 PR 只改了 Apple 设置页、Demo、Swift 测试和复核材料，没有改 `packages/runtime-pi`、系统提示、工具定义、历史消息或出口遮盖；没有新增任何进入模型请求的内容。模型请求仍然只在末尾追加，每轮变化的值仍只应放在最后一条消息里，本次改动没有改变这个结构。依据 `prompt-prefix.md` 第 4 条（已读）和本次 diff 文件清单（已读）。

2. 不会新增“同一段文字在不同请求里变成不同字节”的问题。新增的 `proposals.read` / `proposal.respond` payload 是固定键对象，`ManageGateway` 使用 `.sortedKeys` 编码；新代码没有引入时间字段、随机字段或无序集合序列化。Demo 的提案文本和日期是固定值；`ManageDemo` 里原有的 `Date()` 在 `loginDevices`，不是本 PR 新增，也不进入模型请求。服务端快照的 `generatedAt` 客户端没有使用。模型请求本身完全未被本 PR 影响。

3. 有新增自动检查，但不足以覆盖真正的缺陷。`ProposalsTests` 覆盖了读取、空列表、不可读列表、采纳、版本变化、已消失、500 未变化等场景；这些反向用例在假 transport 的前提下会失败/通过。但它们不校验服务端合约，所以第 1、2 条的缺失键不会被发现；也没有 `requiresFullRead` / `requiresPresence` 的用例。`check:client-parity` 只核对能力类型和生成文件，不核对 payload。`swift test` 未在本机运行（未核实）。

4. 逐个核对如下：
   - `proposalId`：服务端产生，客户端用作 `id` 并原样回传；服务端 `machineString` 接受。Demo/测试里的 `"p1"`、`"a:1"` 不符合服务端 `PROPOSAL_ID_PATTERN`，但它们只经过假 transport，未发往后端（第 7 条）。
   - `version` / `fingerprint`：服务端产生，客户端原样回传；服务端 `integer(1)` 和 `machineString` 接受。
   - `action`：客户端产生 `adopt` / `reject`；服务端 `PROPOSAL_ACTIONS` 接受。
   - `recentAuthenticationRef`：客户端没有产生，服务端命令 schema 要求该键必须存在，设备网关还要求存在时值必须是 `"device"`；当前两端对不上（第 2 条）。
   - `fullReadToken`：客户端没有产生，服务端要求该键必须存在；当前对不上（第 2 条）。
   - `open`：客户端没有产生，服务端查询 schema 要求该键必须存在；当前对不上（第 1 条）。
   - `requiresFullRead` / `requiresPresence` / `opened`：服务端产生，客户端丢弃；需要全文的提案无法完成采纳（第 3 条）。
   - `limit` / `expiresAfterDays` / `pendingCount`：服务端产生，客户端显示前两个；类型和范围都能接受，`pendingCount` 未被使用。
   - 证据 `text` / `figures` / `sources`：服务端产生，客户端能解码 `text` 和 `figures`；`sources` 被解码但不显示，`figure.name` 被当作 UI id 但没有唯一性保证（第 8 条）。
   - Demo 快照：缺 `requiresFullRead`、`requiresPresence`、`opened` 等字段，且不经过合约校验；作为演示可以，作为真实路径证据不够（第 7 条）。
