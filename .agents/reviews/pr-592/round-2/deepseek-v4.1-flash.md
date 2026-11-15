## 本轮查过的范围

对比 `272db25c..bb439df` 的增量只有 3 个代码/测试文件加复核记录：`DeviceAPI.swift`（1 行）、`ThreadManagement.swift`（130 行）、`ThreadManagementTests.swift`（31 行）。我实际读了这些文件，并顺着证据读了以下使用端/规则：`Models.swift`、`DeviceAPIClient.swift`、`ChatStore+Manage.swift`、`ChatListManage.swift`、网页 `thread-control-center.tsx`/`chat-history.tsx`、`docs/execution/specs/2026-08-26-control-center-experience-design.md`、`docs/execution/specs/2026-09-15-control-center-v4-design.md`、`.agents/instructions/prompt-prefix.md`，以及服务端 `device-gateway.ts`、`device-api-routes.ts`、`client-capabilities.ts`、`identifiers.ts`、`thread-contracts-v3.ts`、`product-thread-gateway-adapter.ts`、`thread-fork-service.ts`、`production-http-composition.ts`。增量没碰的旧代码没有整份重读。

## 上一轮意见核对

- **意见 2（幂等键/messageId/targetThreadId 每次重生成）**：进程内已改好，跨进程仍是残留，详见下面意见 1。
- **意见 5（fork 从 owner 消息分出）**：已改好。`ThreadManagement.swift:52` 现在要求 `role == .agent && status == .committed && turnId != nil`；新测试 `forkSourceIsTheNewestCommittedAgentMessageWithATurn` 里加了 owner 消息 `m5`，旧实现会选到 turn-3/watermark 5，测试会失败。与网页 `chat-history.tsx:181,301-312` 的“只看 agent 消息、只在已回答轮次给按钮”基本一致；差别是网页还额外看 run 是否 `isAnsweredRun`，iOS 只看到消息 `committed`，属于轻微差异，我没有找到会造成实际错误的代码路径（推测：若存在“消息已提交但 run 仍失败”的状态才会不同）。

## 意见

### 1、中：幂等身份只存在内存里，App 重启或冷启动后的“未知结果重试”仍会重复执行

文件：`clients/apple/Sources/HimawariCore/ThreadManagement.swift:332-349`、`clients/apple/Sources/HimawariCore/DeviceAPI.swift:35`、`clients/apple/Sources/HimawariCore/ThreadManagement.swift:270-289`

问题：上一轮意见 2 只在同一个 `DeviceAPI` 实例存活期间成立。`PendingActionIdentities` 是一个普通内存字典，随 `DeviceAPI` 一起创建，没有任何写入 `LocalStore`/磁盘的路径。App 被杀掉后重开，用户对同一个失败动作再点一次，描述符相同但字典已空，会重新生成 identity，于是 `messageId`、`idempotencyKey`、`protectedText` 的幂等键和 fork 的 `targetThreadId` 全部换新，服务端无法按原回执重放。fork 在这种情况下会真的多出一个新对话。

证据（我亲自读到）：
- `ThreadManagement.swift:334`：`private var identities: [String: String] = [:]`
- `DeviceAPI.swift:35`：`let pendingActions = PendingActionIdentities()`
- `ThreadManagement.swift:83-86`：`let identity = pendingActions.identity(for: descriptor)` … `let outcome = try await send(identity)` … `pendingActions.settle(descriptor)`；只有成功返回才 `settle`，没有任何持久化。
- `ThreadManagement.swift:272`：`let targetThreadId = "thread-fork:\(identity)"`
- 项目规则也要求持久复用：`docs/execution/specs/2026-08-26-control-center-experience-design.md:125` 写“客户端 mutation 使用生成一次并持久到结果确定的 idempotency key。刷新页面或网络重试复用原 key”；`2026-09-15-control-center-v4-design.md:24` 写“未知结果使用原幂等身份核对，不重复执行”。网页确实把待定 mutation 存进了浏览器存储（`thread-control-center.tsx:217-224,947`），iOS 这次没有对应做法。

建议：把“结果未确定”的 identity 持久化，键用不含正文的操作键（例如 `kind + threadId + revision`，rename 另加标题摘要），成功或确定性拒绝后清除；可复用现有 `LocalStore`/`Outbox` 的持久化模式。至少要在 fork/rename/trash 这类会产生可见副作用的命令上做到。

判定：机制读代码证实；“App 重启后会重复执行”是沿代码的推断，没有权限实际杀掉进程复现。

### 2、低：失败动作的 identity 永不清理，字典无界增长并保留标题原文

文件：`clients/apple/Sources/HimawariCore/ThreadManagement.swift:82-87,190,332-349`

问题：`runAction` 只在 `send` 正常返回后 `settle`；任何抛错（离线、5xx、400、409 作为 HTTP 错误返回等）都会把描述符和 identity 永久留在字典里。`DeviceAPI` 是长生命周期对象，反复失败会持续增长。更值得注意的是 rename 的描述符包含完整标题原文：`"rename|\(threadId)|\(expectedRevision)|\(title)"`，失败的标题会一直留在内存里。

证据：
- `runAction`：`let outcome = try await send(identity); pendingActions.settle(descriptor); return outcome`（抛错时后面两句不执行）。
- `PendingActionIdentities` 只有 `identity(for:)` 和 `settle(_:)`，没有淘汰、TTL 或容量上限。
- `renameThread` 的描述符直接拼接 `title`。

建议：给待定 identity 加容量上限或按时间淘汰；区分“结果未知”（保留）和“确定性拒绝”（可清理，如 4xx/校验失败）；描述符里不要存标题原文，可存标题摘要或操作键。参考 `MACHINE_IDENTIFIER_PATTERN`/payload 摘要思路。

判定：读代码证实。

### 3、低：新组合出来的标识符没有对服务端校验的自动检查，fork 成功后的新动作也没有反向用例

文件：`clients/apple/Tests/HimawariCoreTests/ThreadManagementTests.swift:146-153,174-196`、`clients/apple/Sources/HimawariCore/ThreadManagement.swift:96,105-106,272`

问题：现有自动检查只验证 `gatewayIdentifier("device-")` 和 `gatewayIdentifier("device-text-")` 这个原材料，不验证真正发出去的值。增量新产生的实际值是 `device-text-<32hex>-<slot>`、`device-m-<32hex>`、`device-k-<32hex>`、`thread-fork:<32hex>`；没有任何测试把它们套到服务端规则上。另外，`forkThread` 手工复制了一份 identity 生命周期（不经过 `runAction`），但新加的“成功后新动作换新身份”用例只覆盖 `pinThread`，没有覆盖 fork 成功后再次 fork 应产生新 target。这正是 I-73 的“值只在一端认”教训。

证据：
- `gatewayIdentifiersStartWithALetterOrDigitAndFitTheServerPattern` 只调用 `DeviceAPI.gatewayIdentifier("device-")` 和 `("device-text-")`。
- `retryingAfterAnUnknownResultReusesTheSameIdentity`、`aNewActionAfterAnAcceptedOneGetsANewIdentity` 只覆盖 fork 重试和 pin 成功清理。
- 我核对了服务端两端校验，实际值目前都能通过：`device-api-routes.ts:163` 的 `MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u`（实际键 46 字符）；`device-gateway.ts:73,101,104` 的 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`（实际 41 字符）；`identifiers.ts:39` 和 `thread-contracts-v3.ts:285` 的 machine string/`createThreadId`（实际 44 字符）。

建议：新增断言，用真正组合出的字符串复跑上述正则/长度规则；补一条 fork 成功后再 fork 的用例，验证 targetThreadId 与幂等键都换新；rename 的两个 `slot` 也建议各有一条重试复用断言。

判定：测试缺口读代码证实；“如果撤掉过滤/复用/settle 会失败”是按测试代码推断，未实际运行。作者说的 Linux 314 项通过未核实。

### 4、低：作者“服务端搜索设备路由没有”的说法与代码不完全一致

文件：`packages/gateway-contracts/src/client-capabilities.ts:274`、`packages/platform-node/src/device-api-routes.ts:1438-1456`、`packages/platform-node/src/http-gateway-server.ts:1670-1681`

问题：`thread.search` 是 `thread-v3` 的 `read` 级 query，设备 `/api/device/v1/gateway` 会按能力表接受它；缺的是设备可调用的“搜索词预处理/分词”入口，而不是 gateway 里没有搜索类型。`/api/thread-search/v1/prepare` 走浏览器 session + CSRF，不在设备签名路由里，所以“手机上没做搜索”这个结论成立，但作者给的理由不准确。

证据：
- `client-capabilities.ts:274`：`query("thread-v3", "thread.search"),`
- `device-gateway.ts:82`：`"thread-v3": ["gateway", "type", "messageId", "idempotencyKey", "payload"]`，分类后走通用 `forward`。
- `http-gateway-server.ts:1670-1681`：prepare 路由 `assertMutationBoundary` + `csrf.verify`，是浏览器入口；`device-api-routes.ts` 没有 search 路由。

建议：修正 PR 说明/设计文档措辞为“设备侧没有可用的搜索引擎预处理路由”；如果确实不需要手机搜索，说明 `thread.search` 为何对设备不可用。

判定：读代码证实。

## 侧重检查

- **错误路径**：复核了 payload 上传失败、gateway 503、`thread.conflict`、未知结果、App 重启五类。503/冲突时 identity 保留或清理的时机基本正确；App 重启丢失 identity 是残留（意见 1）。
- **不合规范/不可信输入**：标题、threadId、turnId、taskId 会进入描述符或请求体。threadId/turnId/taskId 由服务端返回且受 machine string 限制；标题作为字典键不参与网络协议，描述符用 `|` 分隔，而 thread id 的字符集不含 `|`，未发现描述符碰撞。服务端 payloads/text/new 会校验正文长度和键格式，未发现新增注入面。
- **安全**：没有新增日志输出；目标线程 id 仍由服务端按 owner/agent scope 建线程；失败动作在内存里保留标题原文，是隐私/内存双重问题（意见 2）。未发现新密钥或凭据泄露。
- **资源耗尽**：`pendingActions` 无上限（意见 2）。
- **不可撤销操作**：增量本身没有新增彻底删除；`thread.trash` 可在进程内靠同一 key 防止重复，跨进程仍有意见 1 的风险。
- **规则/文档一致性**：幂等身份“持久到结果确定”的规则与当前内存实现不一致（意见 1）；搜索设备路由说法不准确（意见 4）；fork 选源与网页意图一致（意见 5 已改好）。
- **未核实**：作者自测的 314 项 Swift 测试结果、Mac 界面编译情况；本次没有运行任何测试或复现命令（工具限制）。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不涉及本次增量。增量只改客户端为 thread-v3 命令生成的标识符和命令 payload，没有改系统提示、工具定义、历史消息或遮盖；发给模型的内容仍然只在末尾追加，每轮会变的值仍在最后一条消息。唯一与模型上下文有关的是 fork 选源改为最新 committed agent 消息，它决定**新对话首轮**带哪些历史，不会改任何已有对话已经发过的开头。`thread.set_answer_locale` 本身按规则 6 属于允许的一次换新，但它是既有命令，增量只是复用其幂等身份。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会影响模型可见文本。增量没有引入依赖前后文的遮盖、时间字段或无序集合；`summaryRefs`/`policyRefs` 仍是固定空数组。新标识符只进入命令元数据和线程 id，同一待定动作在进程内重试时字节稳定；新动作随机生成新 id，但这不是模型输入。跨进程重启会换 id（见意见 1），但同样只影响命令元数据。

**3. 有没有对应的自动检查，反向用例会真的失败吗？** 有，但不完整。新增 `retryingAfterAnUnknownResultReusesTheSameIdentity`、`aNewActionAfterAnAcceptedOneGetsANewIdentity`，并改写了 fork 选源用例；按代码推断，撤掉角色过滤、撤掉 identity 复用、撤掉 `settle` 都会让对应用例失败（未实际运行）。缺口是：组合出来的标识符没有套服务端正则；fork 的 `settle` 路径没有“成功后新 fork”反向用例；rename 两个 slot 以及 lifecycle/locale/pause 的复用没有专门用例。

**4. 改动产生/修改的每个值，使用端都能接受吗？** 我逐个核对了：`protectedText`/`threadCommand`/`runAction`/`PendingActionIdentities` 只在 `HimawariCore` 内使用，checked-out 仓库里没有外部调用者（稀疏检出 55%，未检出部分未核实）；`device-text-<identity>-<slot>` 通过 `MESSAGE_ID_PATTERN`；`device-m-*`、`device-k-*` 通过 device-gateway 的 `MACHINE_STRING`；`thread-fork:<identity>` 通过 `machineString`/`createThreadId`，`ThreadForkService` 接受客户端传入的 `targetThreadId`；`ThreadForkSource.latest` 的唯一使用端是 `ChatStore+Manage.fork`，`MessageRole.agent` 存在且可比较。增量没有改配置键或清单项。两端校验都能接受，但没有自动门锁住这些组合值（见意见 3）。
