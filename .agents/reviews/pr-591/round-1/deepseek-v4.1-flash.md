说明：按要求已停止读代码和调用工具。本次复核在 Linux 环境进行，**Mac/iOS 界面没有编译过**，涉及 SwiftUI 编译与真机行为的部分标为「未核实」。

**侧重检查**

- **错误路径**：命令失败会经 `perform` 置 `actionFailed`（`MemoryRootView.swift:184-192`）；但新增 `MemoryAddSheet` 的错误提示挂在根视图 `.alert`（`MemoryRootView.swift:107-114,140`），sheet 仍开着时是否能显示**未核实**。`basisSources` 的任何读取失败都返回空数组（`MemoryAwaitingActions.swift:104-112`），详情里会静默不显示“整理自”（`MemoryDetailSheet.swift:59-62,91`）。
- **不可信输入/长度**：服务端文本只当 `Text` 展示，无注入面；但手动新建没有长度上限（见意见 3）。
- **安全**：新建记忆先以 `private` 上传再分类，会把卡号、密码等先送给分类模型（见意见 2）。
- **资源耗尽**：外部提议列表有 100 条上限（`production-memory-control.ts:131`），每次操作后 `load()` 做 3 个读取；未发现无界循环/重试。手动新建无长度限制，可把大段文本送进上传接口。
- **不可撤销操作**：批准/拒绝、外部保存/拒绝、人物合并、整理撤销都走既有 `change`/`tighten` 档；外部拒绝是 tighten，无二次确认，但可以通过批次撤销恢复。未发现新增的越权路径。
- **规则/文档一致性**：能力表和生成的 Swift 有一致性检查（`test/tooling/client-parity.test.ts:214-231`），但没有覆盖本次手写的记忆 DTO 与 `contracts-v2.ts` 的字段/取值一致性；这正是意见 1、5 的来源。

**作者说法核对**

- “外部拒绝按能力表是 tighten，不弹确认”：**属实**。`ClientCapabilities.swift:51` 先判 `tightenEveryItem`，`memory.external.respond` 的条目要求 `decision=reject`、`editedText=null`（`client-capabilities.ts:183-188`），`ManageGateway.swift:64-66` 对 tighten 不取 challenge。
- “解码和判断在 HimawariCore（Linux swift test 通过）”：**部分属实**。计数、创建计划、快照解码在 Core；但真正的命令 payload、能力判定和敏感重传在 HimawariManage，只在 Mac 测试。Linux 测试本次未运行，标「未核实」。
- “新建记忆先 classify 再 create，敏感的用 sensitive 重新上传”：**代码确实这样做**（`MemoryAwaitingActions.swift:90-98`），但缺少 web 端的标识符/凭据预分级，且现有测试没有验证“重传 sensitive”（见意见 2、4）。
- “字段名以 contracts-v2.ts 为准”：解码字段名**基本一致**；但“人物建议”的值本身会超 `machineString` 128 上限（意见 1）。

### 1. 高 - 人物建议 ID 可能超过后端 machineString 128 上限，导致“人物”确认命令必失败（I-73 类问题）

- 文件:行：`packages/persistence-sqlite/src/sqlite-memory-book-operations.ts:335,362`；`packages/gateway-contracts/src/validation.ts:49-56`；`packages/gateway-contracts/src/contracts-v2.ts:2411,2745`；`clients/apple/Sources/HimawariManage/Memory/MemoryAwaitingActions.swift:52`；`packages/platform-node/src/device-gateway.ts:235-243`。
- 问题：服务端生成 `suggestionId = "person-suggestion:<personId>:<candidateId>"`，iOS 原样放进 `memory.person.respond`。命令入口会用 `gatewayV2MessageSchema.parse` 校验，`suggestionId` 走 `machineString`，最长 128；按当前 ID 生成规则它很可能超长，命令直接 400，人物确认功能不可用。
- 证据：`personId = \`person:${input.memoryId}:${ordinal}\``、`` `person-suggestion:${personId}:${candidate}` ``；`MACHINE_STRING_MAX_LENGTH = 128`；`memory.person.respond` 的 `suggestionId: machineString`；iOS `["suggestionId": .string(question.suggestion.suggestionId), "merge": .bool(same)]`。会话回顾的记忆 ID 是 `memory:${generation}:${ordinal}`，而 `generationId = \`memory-review:${digest(...)}\``，摘要固定 32 个十六进制字符（`production-memory-conversation-review.ts:65,101-106`），据此推算：memoryId 约 56、personId 约 66、suggestionId 约 151，超过 128。真实库里没有抽样，但生成规则和常量是读代码证实的。
- 建议：不要把手写拼接的 `suggestionId` 直接作为命令 ID；给人物建议单独定义短 ID（或哈希后截断到 128 内），并让 overview 快照和 `memory.person.respond` 共用同一校验。补一个用真实生成规则且长度超限的反向测试；现在的合约夹具用的是 `"person-suggestion-01"`（`gateway-v2.fixture.ts:1201`），掩盖了这个问题。

### 2. 高 - 手动新建先把原文以 private 上传再分类，卡号/密码等会先发给分类模型

- 文件:行：`clients/apple/Sources/HimawariManage/Memory/MemoryAwaitingActions.swift:90-98`；`apps/agent-service/src/production-memory-control.ts:1335-1350,1500-1512`；`apps/control-center/src/memory.ts:245-252`；`packages/sensitive-capture/src/identifiers.ts:20-27`。
- 问题：iOS 固定用 `dataClassification: "private"` 上传用于分类的副本。服务端只有在“载荷本身分级高于 private”时才跳过分类模型；private 载荷会解密并把全文交给 `classifier.classify`。含银行卡号、身份证、密码、验证码的文本会先经过模型，之后才由 `#createMemory` 升为 sensitive，同时 private 副本仍留在 payload 库里。
- 证据：iOS `let ref = try await gateway.uploadText(text, dataClassification: "private")`；服务端 `if (payload && classificationRank(payload.dataClassification) > classificationRank("private")) results[index] = DETERMINISTIC_SENSITIVE; else pending.push({ index, text: await this.readText(ref) })`，随后 `classifier.classify(pending...)`；web 端用 `classificationWithIdentifiers(text, "private")`，命中卡号/证件号/凭据时直接升级为 sensitive。Swift 端没有对应实现。
- 建议：在 iOS 上传前实现与 `classificationWithIdentifiers` 同样的标识符/凭据判定（或由服务端在调用分类模型前先跑 `deterministicallySensitive`），命中时直接按 sensitive 上传并复用该 ref，避免把敏感原文送进分类模型和留下 private 副本。

### 3. 中 - 手动新建没有长度上限，超过 2000 字的记忆会被读取截断，编辑保存会丢尾部

- 文件:行：`clients/apple/Sources/HimawariManage/Memory/MemoryAddSheet.swift:8,44-48`；`apps/control-center/src/components/memory-page.tsx:2364-2370`；`apps/agent-service/src/production-memory-control.ts:155-163,310-313`；`clients/apple/Sources/HimawariManage/MemoryRootView.swift:99-102`；`clients/apple/Sources/HimawariManage/Memory/MemoryModels.swift:20`。
- 问题：新建输入框只禁用空串，没有字符上限；服务端 `#createMemory` 也只校验非空，不拒绝超长文本。overview 返回时 `singleLine` 截到 2000 字，编辑页用 `item.text` 回填；用户编辑并保存时，超过 2000 字的后半段会被丢弃。web 手动新建限制 500 字，iOS 没有。
- 证据：`MemoryAddSheet` 的 `trimmed.isEmpty || saving` 是唯一的禁用条件；服务端 `assertStorable` 只判断 `text.trim().length === 0`；`singleLine` 末尾 `.slice(0, 2000)`；编辑入口 `MemoryEditSheet(original: item.text)`。文本上传上限是 64K 字符（`text-admission.ts:9`），iOS 可创建远长于 2000 字的记忆。
- 建议：新建和编辑都加与服务端展示/contract 一致的上限（至少 2000，最好与 web 的 500 对齐），超过时禁用保存并显示字数；服务端 `memory.create` 也应拒绝超过上限的 `contentRef`。

### 4. 中 - “敏感用 sensitive 重新上传”没有自动检查，去掉重传测试仍会通过

- 文件:行：`clients/apple/Tests/HimawariManageTests/MemoryDecisionTests.swift:8-19,65-77`；`clients/apple/Sources/HimawariManage/Memory/MemoryAwaitingActions.swift:90-98`。
- 问题：测试用的 `Recorder` 在 `textPath` 直接返回 `payloadRef`，不记录上传请求；`testCreatingAHealthMemoryUploadsItAsSensitiveWithTheHealthTopic` 只断言 `memory.create` 的 `category/topic/pinned`。即使把敏感重传删掉、始终复用第一次 private 上传，这个测试也照样通过。
- 证据：`if path == ManageGateway.textPath { return DeviceResponse(...) }` 没有 `record`；测试里只有 `create` 的 payload 断言，没有 `dataClassification` 断言。
- 建议：像 `MemoryStoreTests.swift` 的 `UploadRecorder` 那样记录所有文本上传，断言健康/敏感文本产生一次 private 分类上传和一次 sensitive 上传，并断言 `memory.create.contentRef` 指向 sensitive 的 ref；再加一个普通文本只上传一次的用例。

### 5. 中 - 新手写的记忆 DTO 没有与 contracts-v2 的自动一致性检查，解码失败还会被静默吞掉

- 文件:行：`clients/apple/Sources/HimawariManage/Memory/MemoryStore.swift:29-34`；`test/tooling/client-parity.test.ts:214-231`；`clients/apple/Tests/HimawariCoreTests/MemoryAwaitingTests.swift:5-17`。
- 问题：`client-parity` 只校验能力表和生成的 Swift，不校验 `MemoryAwaiting.swift`/`MemoryCreatePlan.swift` 的字段名、枚举值和长度。`awaiting`/`review` 解码失败都用 `try?` 变成 nil，页面只是少掉整个待确认内容而不报错；测试又用自己手写的 JSON，字段改名或值超限不会让测试失败。意见 1 就是这种缺口的实例。
- 证据：`awaiting = try? decoder.decode(...)`、`review = (await reviewData).flatMap { try? ... }`；`MemoryAwaitingTests` 的 `snapshot(...)` 自造 JSON，没有读取 `contracts-v2.ts` 的夹具。
- 建议：对 overview/review/basis/classify 这些新增 DTO 增加与合约夹具共享的测试（或从合约生成 Swift 类型）；至少把 `awaiting`/`review` 解码失败记录到 `phase` 或日志，避免“功能消失但一切正常”。

### 6. 低 - 记忆依据读取失败会被当成“没有依据”，用户无法区分

- 文件:行：`clients/apple/Sources/HimawariManage/Memory/MemoryAwaitingActions.swift:104-112`；`clients/apple/Sources/HimawariManage/Memory/MemoryDetailSheet.swift:59-62,91`。
- 问题：`basisSources` 对网络错误、权限拒绝、链不存在都返回 `[]`；详情页只有在数组非空时才显示“整理自”。读取失败时用户看到的是“没有依据”，而不是“没能读取依据”。
- 证据：`guard let data = try? await gateway.read(...), let chain = (try? JSONDecoder()...).payload else { return [] }`；UI `if !sources.isEmpty { field(M.basedOn, ...) }`。
- 建议：返回一个带状态的结果（无依据/读取失败/部分），失败时显示可重试提示。

### 7. 低 - `memory.review.read` 里的规则待审项被完全忽略，页签数字可能少算

- 文件:行：`clients/apple/Sources/HimawariCore/MemoryAwaiting.swift:142-148,161-169`；`packages/gateway-contracts/src/contracts-v2.ts:2673-2698`。
- 问题：review 快照还有 `rules`（`needs_review`/`suspended`）和 `agreement`，新代码只解码 `memories`，页签也不显示规则待审。若产品意图是“手机上也显示全部待处理”，这里不完整；若只做“待确认记忆”，应明确说明。
- 证据：`MemoryReviewSnapshot` 只有 `memories`；`MemoryAwaiting.count` 只加 `reviewGroups(review).count`；合约快照包含 `rules` 和 `agreement`。
- 建议：按产品范围决定是否补规则待审；至少把“只支持记忆待审”写进说明或界面。

### 8. 低 - `reflect` 整理动作没有对应文案，会落到泛化的“整理了”

- 文件:行：`clients/apple/Sources/HimawariManage/Memory/MemoryAwaitingStrings.swift:83-93`；`packages/gateway-contracts/src/contracts-v2.ts:2357`。
- 问题：`tidyUps[].action` 合约枚举包含 `merge/supersede/archive/reflect/hold`，`M.tidyAction` 只覆盖前三个和 `hold`，`reflect` 走 default。
- 建议：补 `reflect` 的三种语言文案，或明确 default 就是“整理了”。

### 9. 低 - 页签数字只算“新确认”，不含同页签里的“可以撤销的”行

- 文件:行：`clients/apple/Sources/HimawariCore/MemoryAwaiting.swift:161-169`；`clients/apple/Sources/HimawariManage/Memory/MemoryAwaitingView.swift:54-75`。
- 问题：`count` 只加 pending、外部 total、人物、提醒、review groups；`MemoryAwaitingView` 还展示 `undoableTidyUps`、`undoableReviews`、外部批次撤销。数字与页签内可见的可操作行数不一致；这可能是有意的“待确认”定义，但界面上没有说明。
- 建议：在文档/测试里明确数字定义；若希望数字等于页签内可操作项，需把撤销行也计入，或把“可以撤销的”移到不带数字的位置。

**推测/未核实**

- Mac 端是否能编译通过未核实。`MemoryAwaitingView.swift:17` 把 `@escaping` 写在存储属性的函数类型参数里（`(String, @escaping () async throws -> Void) -> Void`），这种写法是否被当前 Swift 6.2 接受需要 Mac 编译确认；Linux 检查覆盖不到。
- `MemoryAddSheet` 失败时根视图的 `.alert` 是否能盖在 sheet 上显示，未核实；如果不行，保存失败时用户会看不到错误。
- 演示数据里 review 行的 `memoryId` 是 `m2`，而演示记忆列表没有 `m2`，点“看这条”不会有反应；这只影响 demo/截图，不影响生产。

**逐条回答必答问题**

1. **不会改变模型已经见过的请求开头。** 这次 diff 全部是 Apple 客户端和测试（`git diff --name-only` 已核对），没有改系统提示、工具定义、历史消息、遮盖或任何服务端 prompt 组装。新代码不组装模型请求；手动新建只是走既有 `memory.create`，后续记忆进入上下文仍由既有机制处理。依据 `.agents/instructions/prompt-prefix.md:36` 第 4 条“只能在末尾追加”：本次没有对已发内容做改写、重排或删除，也没有把每轮变化的值塞进系统提示/工具定义。因此“发给模型的内容仍然只在末尾追加、每轮会变的值仍在最后一条消息”这一点没有被本改动破坏。

2. **没有引入新的“同一段文字在不同请求里变成不同字节”问题。** 新增的命令 payload 都是固定字段、固定集合；`ManageGateway.swift:158-159` 用 `.sortedKeys` 和 `.withoutEscapingSlashes` 序列化，键顺序确定。新增 UI 里的时间（如 `reminderStatus` 用 `Date()`）只用于显示，不进请求。唯一相关的是：同一段手写记忆会被**有意**上传两次（private 分类副本 + sensitive 正式副本），这是分类流程，不是遮盖或上下文相关的变化；请求里每请求变化的 `messageId`/`idempotencyKey` 是既有设计。故对模型请求的字节确定性没有新增风险。

3. **有自动检查，但反向用例不足。** Core 测试覆盖了计数、未知人物过滤、review 去重、可撤销过滤、依据链、创建计划的敏感/非敏感/失败回退（`MemoryAwaitingTests.swift`）；Manage 测试覆盖了外部拒绝无 challenge、保存有 challenge、payload 形状和健康记忆的 create payload（`MemoryDecisionTests.swift`）。但：①“敏感用 sensitive 重新上传”没有测试，删掉重传仍会通过；②没有测试能从 `contracts-v2.ts` 夹具发现字段名/长度不一致，人物建议 ID 超 128 的问题就不会被现有测试拦住；③Mac 界面没有在 Linux 验证。故反向用例**没有**覆盖最关键的敏感重传和跨端取值校验。

4. **逐个核对新增值：大部分两端能接受，人物建议 ID 是明确例外。** 已核对：`requestId`、`proposalId`、`batchId`、`reminderId`、`changeId`、`reviewId`、`memoryId`、`contentRef` 都是 `machineString`，来源和命令两端一致；`resolution` 的 `approved/rejected`、外部 `keep/reject`、提醒 `snooze/dismiss`、review `dismiss`、`category`/`topic` 都落在合约枚举内；`externalProposals.total` 在 sqlite 里确实是 pending 总数（`sqlite-external-memory-proposal-operations.ts:312-334`），所以页签计数和“还有 N 条”的算法成立。**不一致的是** `suggestionId`：产生端 `person-suggestion:<personId>:<candidateId>` 可能超过 `machineString` 的 128 上限，而消费端 `memory.person.respond` 用的正是 `machineString`；这正是 I-73 说的“清单/快照里的 id 能不能过后端校验”。另外 `tidyUps[].action=reflect` 有值但没有对应文案，属于取值已接受、显示不完整。
