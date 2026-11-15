## 复核范围

- 仓库 HEAD `3e16581`；PR 基准 `d8df8cd`；上一轮 `c7ac8c6`。
- 本轮真正属于 PR 518 的增量是 `5b5a1fb39`、`26a514390`、`0b8fdc77d`、`66b37c60a`：只改了 `ManageLayout.ProposalCard`、`ProposalsPage.swift`、两张 `ui-review/latest` 截图。`c7ac8c6..HEAD` 里 700 多个文件是“合并 main”带进来的其它 PR，我没有整份重读；只跟了合并碰到的 PR 518 文件（`DemoScenes.swift` 出现重复 import）。
- 另读了服务端侧的直接使用端：`contracts-v2.ts` 的 `proposals/suggestion/improvement` 结构与 `timestamp` 校验、`client-capabilities.ts`、`production-proposals.ts`、`production-proposal-control.ts`、`device-gateway.ts`、`autonomy-gateway-adapter.ts`、`ui-review.sh`。
- 未核实：`.agents/reviews/pr-518/brief.md` 和上一轮记录在稀疏检出里没有、`git show` 又拒绝 records-path，所以“原型到底要求哪一组接口/哪种点击区”无法核对。

## 意见

### 1 [中] 作者说接的是 `suggestion.*`，代码实际接的是 `proposals.*`，这是三个不同功能

- 文件:行：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:125-137,151-169`；`packages/gateway-contracts/src/contracts-v2.ts:2330-2395`；`packages/gateway-contracts/src/client-capabilities.ts:171-172`
- 问题：作者的说法是 `suggestion.list` / `suggestion.detail` / `suggestion.respond`，但页面实际只调用 `proposals.read` 和 `proposal.respond`。`suggestion.*`、`improvement.*`、`proposal.*` 是三组不同能力，数据结构也完全不同。
- 证据（我亲自读到的）：
  - `SettingsStore.swift:127`：`"proposal.respond"`；`:153`、`:168`：`"proposals.read"`。
  - `contracts-v2.ts:2330-2395` 的 `proposals.snapshot` 才有 `summary`、`effect`、`evidence[].text/figures`、`adoptable`、`requiresFullRead`、`requiresPresence`、`version`、`fingerprint`、`refusedBefore`，正好对应 `ProposalList`。
  - `contracts-v2.ts:3328-3360` 的 `suggestion.snapshot` 只有 `suggestionId`、`revision`、`status`、`kind`、`titleRef`、`bodyRef`、`evidenceRefs` 等，没有 `summary/effect/adoptable`；`suggestion.list` 返回的是 `collection.snapshot` 的 `itemRefs`，不是带全文的列表。
  - 控制中心同名页面 `improvements.title = "待采纳的改进"` 用的是 `improvement.list/detail/review`（`control-center-inventory.ts:347-353`），`improvement.snapshot` 又是 `patchRef/validationRefs/comparisonRef` 那一套（`contracts-v2.ts:3409-3443`）。
- 读代码证实的：代码内部是自洽的——只可能来自 `proposals.*`，不可能消费 `suggestion.*` 的形状。
- 推测：更可能是作者把接口名写错了（UI 字段只对得上 `proposals.*`）；但如果产品要的是“自我改进建议”，那这个页面就是接错了功能，`suggestion.*` 的 `titleRef/bodyRef/evidenceRefs` 也根本没有解析代码。必须让作者明确页面该接哪一组。
- 建议：先确认“待采纳的改进”对应 `proposal.*` 还是 `improvement.*`/`suggestion.*`；把 PR 说明、能力名、页面实际调用、演示数据统一。按 I-73 的做法，加一条检查：页面使用的能力名必须在生成的 `ClientCapabilities` 和网关能力表里都存在，且 snapshot 字段能解码。

### 2 [中] 本轮把依据行的 44pt 最小点击区删掉了

- 文件:行：`clients/apple/Sources/HimawariManage/Settings/ProposalsPage.swift:87-101`
- 问题：`66b37c60a` 删除了 `.frame(minHeight: DesignTokens.Size.minTapTarget, alignment: .top)`，现在展开/收起按钮的可点高度只由文字或 14pt 箭头决定。`DesignTokens.TypeScale.caption` 的 `lineHeight = 13 * 1.4 ≈ 18.2`，短依据只有约 18pt 高，长依据最多两行约 36pt，都低于项目自己的 `DesignTokens.Size.minTapTarget = 44`。
- 证据：
  - `ProposalsPage.swift:88-97`：`HStack(alignment: .top, spacing: PL.buttonGap)` 里只有 `Text(...)`、`.lineLimit(open ? nil : 2)` 和 `Icon(.chevronRight, size: PL.chevron)`，随后 `.contentShape(Rectangle())`；没有 `minHeight`。
  - `DesignTokens.swift:69`：`public static let minTapTarget: CGFloat = 44`；同文件 `:233` caption 行高 18.2。
  - `git show 66b37c60a` 的 diff 明确只删了那一行 `minHeight`。
- 读代码证实的：点击区没有别的父级放大机制；`contentShape` 不会扩大 frame。
- 建议：保留 44pt 命中区，用透明 padding/负间距或 overlay 把视觉间距收紧到 ~16pt；不要靠删 `minTapTarget` 来收紧。

### 3 [低] 展开后第一段依据会重复显示一遍

- 文件:行：`clients/apple/Sources/HimawariManage/Settings/ProposalsPage.swift:89-102,119-124`
- 问题：按钮标题始终是 `Text(firstReason ?? M.proposalWhy)`；展开后 `if open { evidence }` 又把同一段 `item.text` 渲染一次，所以第一条依据在展开状态下连续出现两次。
- 证据：
  - `:89`：`Text(firstReason ?? M.proposalWhy)`；`:91`：`.lineLimit(open ? nil : 2)`（展开时不再截断）。
  - `:102`：`if open { evidence }`；`:122-124`：`if let text = item.text, !text.isEmpty { Text(text) ... }`。
  - `firstReason`（`:76-78`）取的就是第一个非空 `evidence.text`，因此必然重复。
- 读代码证实的：只影响有文字依据的提案；只有图形依据时不会重复。
- 建议：展开时标题改成固定的“收起”，或展开列表跳过已被预览的那一条。

### 4 [低] 上一轮第 3 条（演示快照 `generatedAt` 毫秒）实际没有改

- 文件:行：`clients/apple/Sources/HimawariManage/ManageDemo.swift:181`；`packages/gateway-contracts/src/validation.ts:128-137`
- 问题：作者说第 3 轮意见已修改，但演示的 proposals 快照仍是 `"generatedAt":"2026-11-12T00:00:00Z"`，没有毫秒；`c7ac8c6` 里也是同一串，本轮增量没有碰 `ManageDemo` 的这一行。
- 证据：
  - `ManageDemo.swift:181`：`..."opened":null,"generatedAt":"2026-11-12T00:00:00Z"}`。
  - `validation.ts:132-135`：`const parsed = new Date(input); if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== input) fail(path, "expected a canonical UTC timestamp with millisecond precision")`。
  - 对比 `ProposalsTests.swift` 的 `list()` 已经是 `"generatedAt":"2026-11-12T00:00:00.000Z"`，说明只补了测试、没补演示。
- 读代码证实的：客户端 `Snapshot<ProposalList>` 不声明 `generatedAt`，所以运行时不会因此报错；这是“演示数据与网关合同不一致”，不是线上功能故障。
- 建议：改为 `2026-11-12T00:00:00.000Z`；最好加一个测试，用网关的 `timestamp` 规则校验演示快照，避免只改一处。

### 5 [低] 演示的 `type:"rule"` + `adoptable:true` 在服务端不会出现

- 文件:行：`clients/apple/Sources/HimawariManage/ManageDemo.swift:184-185`；`apps/agent-service/src/production-proposals.ts:961`；`apps/agent-service/src/production-owner-rules.ts:63`
- 问题：演示数据把 `type` 写成 `"rule"`、`adoptable` 写成 `true`；但服务端 `adoptable` 是 `this.#handlers.has(row.type)`，已登记的处理方只有 `owner_rule`、`reminder.reschedule`、`reminder.create`、`task.run`，没有 `"rule"`。真实服务端会把这种提议标成不可采纳，页面不会显示“采纳”按钮。
- 证据：
  - `ManageDemo.swift:185`：`"type":"rule",...,"adoptable":true`。
  - `production-proposals.ts:961`：`adoptable: this.#handlers.has(row.type)`。
  - `production-owner-rules.ts:63`：`export const RULE_PROPOSAL_TYPE = "owner_rule";`；`production-reminder-proposals.ts:17-18`、`production-task-proposals.ts:28` 是另外三种。
- 读代码证实的：这是旧演示数据，不是本轮增量改的；但本轮重新录制并提交了截图，截图里的“采纳”按钮与生产行为不一致。
- 建议：演示改用 `owner_rule`（或其它真实可采纳类型），让截图能代表生产。

### 6 [低] 合并把 `DemoScenes.swift` 的 `import HimawariManage` 写了两遍

- 文件:行：`clients/apple/Sources/HimawariShell/DemoScenes.swift:6,8`
- 问题：本轮“合并 main”把同一模块 import 重复了一次；Swift 通常能编过，但属于合并残留，若项目以后加格式/lint 检查会直接报。
- 证据：第 6 行 `import HimawariManage`、第 7 行 `import HimawariListenUI`、第 8 行又 `import HimawariManage`。
- 建议：删掉一行。

## 侧重检查

- **错误路径**：`SettingsStore.respond` 只把非 401/403 的 `.rejected` 当作“可能变了”，重新读列表后按 `not found → .gone`、`version/fingerprint 变了 → .changed`、否则重抛原错误（`SettingsStore.swift:140-146`）。我核对了服务端到 HTTP 的映射：`NOT_FOUND → 404`、其余 `INVALID_OPERATION → 409`（`http-gateway-server.ts:955-969`），`PROPOSAL_CHANGED`/`PROPOSAL_FULL_READ_REQUIRED`/`PROPOSAL_PRESENCE_REQUIRED` 都是 409，因此会被正确归入“重新读取”分支；401/403 直接抛出，不会误当提案变化。读列表失败时保留原错误（`:142`），有测试覆盖。`reloadProposals` 用 `try?` 吞掉刷新失败、保留旧列表（`:115-117`），属于可接受的降级，但旧行可能短暂留着。
- **不可信输入**：`summary/effect/evidence.text/definition` 都用 SwiftUI `Text` 渲染，不拼 HTML；`ProposalList` 是固定字段解码，缺字段会整体解码失败（`proposals` 变 nil，行隐藏），未知字段被忽略。服务端已把 evidence 截到 20 条、figures 每条 10 个、文本 500 字（`production-proposal-control.ts:21-23,65-86`），客户端没有再乘一次上限，但输入来自主人自己的服务端，风险低。
- **安全 / 不可撤销动作**：`proposal.respond` 在能力表是 `change`（`client-capabilities.ts:172`），`ManageGateway.command` 会先要 challenge 再带 confirm 签名（`ManageGateway.swift:67-74`），即走面容。`recentAuthenticationRef` 发的是占位符 `"device"`，与服务端 `DEVICE_REFERENCE_PLACEHOLDER = "device"` 一致，服务端只在 `confirmed` 时填入真实认证引用（`device-gateway.ts:125-138`）。`fullReadToken` 只在 adopt 且 `requiresFullRead` 时获取，reject 从不打开全文（`SettingsStore.swift:121-124`），有 `testARejectionNeverOpensTheFullText` 覆盖。撤销/重复执行由服务端提议状态兜底，客户端不会自动重试。
- **资源耗尽**：新增 UI 渲染量受服务端 evidence/figure 上限约束；没有无序集合参与请求；`JSONEncoder` 用 `.sortedKeys`（`ManageGateway.swift:142-143`）。没有发现新的无界循环或大对象。
- **文档 / 规则一致性**：本 PR 不碰提示词目录、不碰模型请求组装，`prompt-prefix` 的只追加规则不涉及。与代码不一致的是作者对 `suggestion.*` 的描述（意见 1）；演示数据还有 `generatedAt` 和 `type:"rule"` 两处与网关合同/服务端处理方不一致（意见 4、5）。`ui-review.sh --check` 依赖 `Tests/Snapshots/iPhone-390` 的已认可基线，但该基线历史里只有早期 16 个场景，proposals 场景从未进入基线；这是既有流程问题（早于本 PR 的许多场景也缺），本轮只补了 `ui-review/latest`，不能算新的回归，但也不能宣称 UI 自动检查已通过。

## 必答问题

1. **不会。** 本 PR 只加 iOS 原生页面和 `proposals.read`/`proposal.respond` 网关命令，没有改系统提示、工具定义、历史消息或遮盖逻辑，也没有碰提示词目录。发给模型的内容没有变化；这里不涉及“只在末尾追加”的规则。
2. **不涉及模型请求。** 对服务端请求，新 payload 的键和值都是显式字段，编码用 `.sortedKeys`；没有依赖前后文的遮盖、没有带时间的字段、没有无序集合。唯一的变值是既有的随机 `idempotencyKey`，那是幂等键本身的设计。演示里的 `generatedAt` 是写死的，不随请求变化。
3. **有部分自动检查，但本轮增量没有。** `ProposalsTests` 覆盖了加载、空列表、不可读列表、采纳带的 version/fingerprint、409 后变/消失、500 不变仍失败、全文 token、拒绝不打开全文、重读失败保留原错误。本轮改的卡片布局、点击区、截图没有任何 Swift 测试；`swift test` 由 Mac 线程跑，这里无法验证。演示 `generatedAt` 也没有测试会失败（客户端根本不解码它）。`ui-review.sh --check` 虽然文档里有，但不在 CI 里，且基线是旧的，所以“反向用例真的会失败”在这两处都不成立。
4. **增量的值两端都能接受；PR 整体有一处说明与代码不一致。**
   - `ManageLayout.ProposalCard.title/gap/buttonHeight/buttonGap/chevron`：只被 `ProposalsPage` 使用，类型分别是 `TypeToken`、`CGFloat`，`VStack`、`CapsuleButtonStyle`、`Icon` 都能接受；`ProposalRow` 去掉 `last` 后只有 `ProposalsPage` 这一个调用点，已同步。
   - 截图文件名与 `DemoScenes` 的场景名、`ui-review.sh` 的 `${scene}-${scheme}.png` 规则一致。
   - `proposals.read`/`proposal.respond` 两边能力表都有（`client-capabilities.ts:171-172` 与 `ClientCapabilities.swift:132-133`），payload 字段与 `proposalRespondCommandSchema`（`contracts-v2.ts:2385-2395`）逐项一致，`action` 的 `adopt/reject` 在 `PROPOSAL_ACTIONS` 内，`recentAuthenticationRef="device"` 通过服务端占位符校验，snapshot 字段与 `proposalsSnapshotSchema` 一致。
   - 不一致处：作者说的 `suggestion.*` 与代码的 `proposals.*` 不是同一组（意见 1）；演示 `generatedAt` 过不了 `timestamp` 合同（意见 4）；演示 `type:"rule"` 不是服务端登记的可采纳类型（意见 5）。
