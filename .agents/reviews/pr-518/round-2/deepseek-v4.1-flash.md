本轮只核对 `f2068242..2d425801` 的增量（5 个 Swift 文件），并顺着增量引用的值追到服务端合约、设备网关和文档；未重读与增量无关的旧代码。本机没有 Swift，**编译与 `swift test` 未核实**。

### 1 [需确认/中] 需要先看全文的提案只在点“采纳”时自动换令牌，页面从未展示全文，也没有要求先展开依据
- 文件:行：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:121-124`、`:150-165`；`clients/apple/Sources/HimawariManage/Settings/ProposalsPage.swift:83-92`、`:49-66`
- 问题：`requiresFullRead` 的提案在用户点“采纳”时，客户端自动调用 `openFullText` 换令牌，然后直接发送采纳命令。`openFullText` 只返回 `fullReadToken`，页面也没有任何地方展示全文；证据展开只是本地 `open.toggle()`，不触发 `open` 请求。
- 证据（读代码证实）：
  ```swift
  if action == .adopt && proposal.requiresFullRead {
      fullReadToken = .string(try await openFullText(proposal))
  }
  ```
  ```swift
  guard let token = list.opened?.fullReadToken else { throw ManageGatewayError.malformedResponse }
  return token
  ```
  服务端 `openFull` 也只签发令牌，不返回正文（`apps/agent-service/src/production-proposals.ts:461-485`、`apps/agent-service/src/production-proposal-control.ts:100-113`）。
- 推测/需确认：如果 `requiresFullRead` 的产品语义是“主人必须先看到全文才能采纳”，当前实现只是替主人自动取了令牌，没有满足“先看”。如果语义只是“客户端必须先向服务器换一次凭据”，则当前实现可以通过；需要设计线程确认，并最好在用户展开依据或详情页时调用 `open`，而不是在采纳时静默调用。
- 建议：把 `openFullText` 接到证据展开/详情页，`requiresFullRead` 的采纳按钮在展开前不可用；或者明确记录“证据文字即全文，不需要额外查看”，避免语义含糊。

### 2 [低] 演示和测试里的提案时间戳仍不是网关合约要求的格式
- 文件:行：`clients/apple/Sources/HimawariManage/ManageDemo.swift:178`、`:182`；`clients/apple/Tests/HimawariManageTests/ProposalsTests.swift:48`、`:52`、`:143`
- 问题：上一轮第 7 条只把提案编号改成了合法格式，但 `proposedAt`、`expiresAt` 仍写成 `2026-11-10T00:00:00Z` 这类没有毫秒的字符串。真实网关的 `timestamp` 要求 `new Date(input).toISOString() === input`，即必须是 `.000Z`。
- 证据（读代码证实）：`packages/gateway-contracts/src/validation.ts:128-137`：
  ```ts
  const parsed = new Date(input);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== input) {
    fail(path, "expected a canonical UTC timestamp with millisecond precision");
  }
  ```
  而真实合约夹具用的是 `"2026-11-11T00:00:00.000Z"`（`packages/gateway-contracts/test/gateway-v2.fixture.ts:1193-1194`、`:1202`）。
- 影响：Swift 只把这些值当 `String` 解码，所以当前 UI 和假 transport 不会报错；但这正是 I-73 的“一端产生的值，另一端通不过校验”。测试数据无法证明这些响应能通过真实合约。
- 建议：统一改成 `.000Z`，并尽量让测试夹具从共享的合约夹具生成或直接过一遍 `gatewayV2MessageSchema`。

### 3 [低] 依据里的 `sources` 仍然完全不显示
- 文件:行：`clients/apple/Sources/HimawariManage/Settings/ProposalsPage.swift:115-129`；`clients/apple/Sources/HimawariManage/Settings/ProposalModels.swift:14-18`
- 问题：上一轮第 8 条修好了 `figures` 的重复 `name` 标识（改成 `offset`），但 `ProposalEvidence.sources` 仍然只解码、不渲染。全目录检索不到任何读取 `.sources` 的界面代码。
- 证据（读代码证实）：证据视图只显示 `item.text` 和 `item.figures`：
  ```swift
  if let text = item.text, !text.isEmpty { Text(text)... }
  ForEach(Array(item.figures.enumerated()), id: \.offset) { _, figure in ... }
  ```
- 建议：如果“依据”应包含出处，至少显示 `kind` 和 `ref`；如果原型有意不显示，应在说明里写明，避免以后又被当成漏实现。

### 4 [低/需确认] 空列表时设置根页仍显示“没有”整行
- 文件:行：`clients/apple/Sources/HimawariManage/SettingsRootView.swift:60-70`；`clients/apple/Sources/HimawariManage/Settings/ProposalsPage.swift:16-23`
- 问题：上一轮第 9 条只修了“通知在列表清空时消失”：现在通知被移到空列表判断之前显示。但设置根页仍然在 `store.proposals != nil` 时显示整行，列表为空时显示 `M.proposalsNone`（“没有”），没有隐藏整行。
- 证据（读代码证实）：
  ```swift
  if let proposals = store.proposals {
      Button { path.append(.proposals) } label: {
          SettingsRow(
              ...
              value: proposals.proposals.isEmpty ? M.proposalsNone : "\(proposals.proposals.count)",
  ```
- 需确认：如果“没有生产数据时整行不显示”指的是列表为空就隐藏，当前没有做到；如果只是指没有该能力/读取失败时隐藏，当前行为是对的。需要设计线程确认字面要求。
- 建议：若要求空列表隐藏，把条件改成 `if let proposals = store.proposals, !proposals.proposals.isEmpty`；若要求显示“没有”，同步修改需求描述。

### 5 [低] 测试仍是自造 transport，新失败用例也没有核对“原始错误”
- 文件:行：`clients/apple/Tests/HimawariManageTests/ProposalsTests.swift:26-44`、`:172-183`
- 问题：上一轮第 6 条部分修复：假 transport 现在会拒绝缺少 `open`、`recentAuthenticationRef`、`fullReadToken` 的请求，能抓住第 1、2 条；但它仍不经过真实 `gatewayV2MessageSchema`，无法发现类型、枚举、时间戳等合约漂移。新增的 `testAFailedRereadAfterARejectedCommandKeepsTheOriginalError` 名为“保留原始错误”，实际只断言列表条数不变：
  ```swift
  do {
      _ = try await settings.respond(proposal, .adopt, reason: "采纳")
      XCTFail("expected a failure")
  } catch {
      XCTAssertEqual(settings.proposals?.proposals.count, 1)
  }
  ```
  即使抛的是另一个错误，这个用例也会通过。
- 建议：用真实合约夹具或契约解析器校验发送的 payload；失败用例断言错误仍是原来的 `ManageGatewayError.rejected`（至少检查状态码/原因）；拒绝用例再断言确实发出了 `proposal.respond`。

### 6 [低/需确认] 作者说服务端用 `suggestion.*`，页面实际调用的是 `proposals.*`
- 文件:行：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:125-133`、`:151-154`；`docs/architecture-v0.1.md:428`、`:431`
- 问题：作者说法里写的是 `suggestion.list`、`suggestion.detail`、`suggestion.respond`，但本页实际发送 `proposals.read` 和 `proposal.respond`。仓库文档的架构说明也写的是 `proposals.read` / `proposal.respond`，服务端生产组合接线的是 `ProductionProposalControl`（`apps/agent-service/src/production-http-composition.ts:1484-1489`），而 `suggestion.*` 只见到合约、能力表和 application adapter，未在 `apps/agent-service` 找到生产接线。
- 证据（读代码证实）：
  ```swift
  _ = try await gateway.command(.v2, "proposal.respond", ...)
  let data = try await gateway.read(.v2, "proposals.read", ...)
  ```
- 需确认：如果目标功能确实是“建议箱”，这里接错了端点；如果目标功能是“提议箱”，代码和架构文档一致，作者的说法需要更正。按现有文档和实际生产接线看，`proposals.*` 是正确的，`suggestion.*` 更像是笔误。

**上一轮意见核对**
- 第 1 条（`proposals.read` 缺 `open`）：已修。`loadProposals` 发送 `payload: ["open": .null]`（`SettingsStore.swift:167-169`），合约要求 `open` 必填可空（`contracts-v2.ts:2330-2333`）。
- 第 2 条（`proposal.respond` 缺两个字段）：已修。命令现在始终带 `recentAuthenticationRef` 和 `fullReadToken`（`SettingsStore.swift:128-135`），合约要求二者可空但必须存在（`contracts-v2.ts:2386-2391`），设备网关也接受 `"device"` 占位并替换（`device-gateway.ts:109-116`、`:125-137`）。
- 第 3 条（丢弃 `requiresFullRead` / `requiresPresence`）：部分修复。`requiresFullRead` 已解码并用于取令牌（`ProposalModels.swift:30`、`SettingsStore.swift:122`）；`requiresPresence` 只解码、没有消费者。当前所有 `proposal.respond` 都是 `.change` 档，会走确认，所以行为上大概率仍满足在场要求，但代码里没有按 `requiresPresence` 做任何区分，需要设计确认。
- 第 5 条（失败重读吞掉 reload 错误）：已修。失败分支改成 `guard let listed = try? await loadProposals() else { throw error }`，只有成功读到列表才返回 `.gone` 或 `.changed`（`SettingsStore.swift:141-146`）；成功后的 `.done` 仍可返回，因为命令已经成功。
- 第 6 条（测试不校验 payload 契约）：部分修复，见上面第 5 条意见。
- 第 7 条（Demo/测试数据与真实合约不符）：部分修复。提案编号已改成能过 `PROPOSAL_ID_PATTERN` 的 `rule:<32 hex>`，并补了 `requiresFullRead` / `requiresPresence` / `opened`；但时间戳仍不合合约，见第 2 条意见。
- 第 8 条（`figures` 用 `name` 当标识、`sources` 不显示）：`figures` 已改成 `offset`，`sources` 仍未显示，见第 3 条意见。
- 第 9 条（空列表根行“没有”、通知消失）：通知位置已修；根行仍显示“没有”，见第 4 条意见。

**侧重检查**
- 错误路径与授权：`respond` 对 401/403 直接抛出；对其它拒绝先成功重读再判断 `.gone` / `.changed` / 原错误；未发现新的静默成功路径（`SettingsStore.swift:140-147`）。
- 不可信输入：客户端对 `Proposal` 的新布尔字段使用非可选 `Bool`；若服务端缺字段，整个列表解码失败并退化为“没读到”，不会展示半条数据。`openFullText` 没有校验 `opened.proposalId` 是否等于请求的提案，但服务端签发和采纳时都按 `proposalId/version/fingerprint` 绑定令牌（`production-proposals.ts:448-457`），目前没有可利用的越权。
- 安全与不可撤销操作：`fullReadToken` 只存在局部变量，未写日志；采纳仍走 `.change` 档确认；但“自动取全文令牌、用户未看全文即可采纳”的语义风险见第 1 条意见。
- 资源耗尽：服务端全文令牌有 1000 条上限、按提案清理旧令牌、默认 10 分钟过期（`production-proposals.ts:23`、`:470-484`）；客户端每次采纳只取一个令牌，没有新增无界缓存。未发现新的资源耗尽问题。
- 文档一致性：`docs/architecture-v0.1.md:428`、`:431` 与代码的 `proposals.read` / `open` / `fullReadToken` 一致；作者说法里的 `suggestion.*` 与代码不一致，见第 6 条意见。

**必答问题**
1. **会不会改变模型已经见过的请求开头？** 不涉及。增量只改了 `clients/apple` 的 iOS 页面、模型和测试，以及复核记录；没有任何系统提示、工具定义、历史消息、遮盖或模型请求组装代码被改。按 `.agents/instructions/prompt-prefix.md` 第 4 条和第 10 条，这一改动不会进入模型请求，也不存在“只在末尾追加”的问题。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及模型请求。新增的 `fullReadToken` 是服务端每次签发的随机值，但它不是模型可见内容；`open`、`opened`、`requiresFullRead` 都是网关/界面字段，没有改变模型输入里的遮盖、时间字段或集合顺序。若单看 API 请求，`open` 和 `fullReadToken` 由当前提案和一次调用决定，不存在依赖上下文的遮盖。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有，但只到 Swift 假 transport 层。新增用例能覆盖：缺少 `open`、缺少 `recentAuthenticationRef`/`fullReadToken`、`requiresFullRead` 未取令牌、失败重读被吞、拒绝时错误地取全文。假 transport 会对缺少关键字段返回 400，所以把对应修复撤掉，相关用例会失败。但假 transport 不跑真实 `gatewayV2MessageSchema`，发现不了时间戳、类型、枚举等合约漂移；`sources`、空列表根行也没有自动检查。本机无 Swift，实际编译和 `swift test` 未核实。
4. **每个新值的产生处和使用处都能接受吗？** 逐项核对：
   - `open`：客户端产生于 `SettingsStore.swift:154-159`（对象）和 `:168`（`null`）；合约端接受可空对象（`contracts-v2.ts:2330-2333`），服务端消费于 `production-proposal-control.ts:45-46`，接受。
   - `requiresFullRead` / `requiresPresence`：服务端产生于 `production-proposals.ts:942-943`，网关原样带出（`production-proposal-control.ts:63-64`），合约要求布尔（`contracts-v2.ts:2353-2354`），客户端非可选 `Bool` 解码（`ProposalModels.swift:30-31`），接受；但 `requiresPresence` 客户端没有消费者。
   - `opened`：服务端产生于 `production-proposal-control.ts:94`，合约形状为可空 `{proposalId, fullReadToken, expiresAt}`（`contracts-v2.ts:2377-2379`），客户端 `ProposalOpened` 字段一致（`ProposalModels.swift:44-48`），接受。
   - `recentAuthenticationRef`：客户端发 `"device"`（`SettingsStore.swift:133`），设备网关先校验占位符再替换为认证引用（`device-gateway.ts:109-116`、`:125-137`），合约可空（`contracts-v2.ts:2390`），接受。
   - `fullReadToken`：客户端产生于 `SettingsStore.swift:121-134`，合约可空 machine string（`contracts-v2.ts:2391`），服务端按编号/版本/指纹校验（`production-proposals.ts:442-458`），接受。
   - Demo/测试的 `proposalId`：已符合服务端 `PROPOSAL_ID_PATTERN`（`production-proposals.ts:25`）；时间戳仍不合合约（第 2 条意见）。
   - 测试里的 `openedReply`、`open` 对象和假响应：只经过 Swift `JSONDecoder`，不经过真实合约校验，因此即使字段值不合合约测试也会通过。
