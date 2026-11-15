我对照了 diff、thread-v3 合约、设备网关、网页实现和现有测试。按本次工具限制没有运行测试，也没有在 Mac 上编译界面。

### 1、高：回答语言只写进 thread 元数据，没有模型侧消费者，菜单实际不改变回答语言
- 文件：`clients/apple/Sources/HimawariCore/ThreadManagement.swift:227`、`packages/application/src/services/thread-command-service.ts:147`、`packages/application/src/services/context-projection-service.ts:96`、`packages/application/src/services/run-execution-input-service.ts:183`、`apps/agent-service/test/production-model-composition.unit.test.ts:718`
- 问题：新菜单发送 `thread.set_answer_locale`，服务端只把 `thread.answerLocale` 存进 Thread；但当前生产 run policy 没有把 `thread.answerLocale` 变成 `answerLocalePolicy`。上下文投影只有在 `systemPolicyRefs` 里已经有 `kind === "answer-locale"` 时才把语言策略拼进系统提示。因此在当前代码里，用户改完回答语言，下一次回答不会改变。
- 证据：
  - `ThreadManagement.swift:235-238`：`return try await threadCommand(ThreadGatewayCommand.setAnswerLocale, payload: Payload(... answerLocale: locale ...))`
  - `thread-command-service.ts:159-160`：`{ answerLocale: input.answerLocale }, (thread) => setThreadAnswerLocale(...)`
  - `production-model-composition.unit.test.ts:718`：`expect(threadPolicy.answerLocalePolicy).toBeUndefined();`
  - `context-projection-service.ts:96,108`：`const answerLocale = envelope.systemPolicyRefs.find(({ kind }) => kind === "answer-locale");`，之后才 `...(answerLocale ? { answerLocaleRef: answerLocale.ref } : {})`
  - `run-execution-input-service.ts:183`：只有 `policy.answerLocalePolicy` 存在才传下去。
- 建议：要么先把 `thread.answerLocale` 接入 run policy，再放出菜单；要么让 UI 改成一个真正影响模型请求的设置。应补一条端到端测试：设置回答语言后，下一次 run 的系统策略或回答语言确实改变。

### 2、高：幂等键、messageId、fork 的 targetThreadId 每次重新生成，未知结果后的重试会重复执行
- 文件：`clients/apple/Sources/HimawariCore/ThreadManagement.swift:78`、`:94`、`:241`、`clients/apple/Sources/HimawariChat/ChatStore+Manage.swift:52`、`apps/control-center/src/thread-control-center.tsx:1005`、`:1117`
- 问题：iOS 每次调用都新生成 `messageId`、`idempotencyKey`、文本 payload 键和 fork 的 `targetThreadId`，也没有持久化“这次操作的身份”。如果服务器已经提交、响应却丢了，用户再点一次就是新命令：fork 会创建第二条新对话；改名/置顶/归档会再发一次；标题和 resultRef 还会多生成保护文本。网页是生成一次、持久化、重试复用；fork 目标也从稳定后缀推导。
- 证据：
  - `ThreadManagement.swift:78-80`：`prefix + UUID().uuidString...`
  - `ThreadManagement.swift:98-99`：`messageId: Self.gatewayIdentifier("device-")`，`idempotencyKey: Self.gatewayIdentifier("device-")`
  - `ThreadManagement.swift:251-252`：`let resultRef = try await protectedText("thread-action:fork")`，`let targetThreadId = Self.gatewayIdentifier("thread-fork:")`
  - 网页 `thread-control-center.tsx:1017,1030-1034`：`const stableSuffix = identity.idempotencyKey.split(":").at(-1) ...`，`payload-result:${stableSuffix}`
  - 网页 `thread-control-center.tsx:1123`：`targetThreadId: \`thread-fork:${stableSuffix}\``
  - `packages/application/src/services/thread-fork-service.ts:40-91`：先按 `idempotencyKey` 找 replay；同键才复用原 target，新键就创建新 Thread。
  - `docs/execution/specs/2026-08-26-control-center-experience-design.md:125`：“客户端 mutation 使用生成一次并持久到结果确定的 idempotency key。刷新页面或网络重试复用原 key；用户明确发起新动作才生成新 key。”
- 建议：每个用户动作生成一次身份并持久化（可参照 `Outbox` 或网页 pending mutation），重试复用同一个 `idempotencyKey`；fork 的 `targetThreadId` 从该 key 推导；重放时使用服务端返回的 `threadId`（目前 `CommandOutcome.accepted` 丢掉了这个字段）。补“响应丢失后重试不产生第二条对话”的测试。

### 3、中：删除流程在“暂停任务”和“trash”之间不是原子的，失败会留下已暂停任务且客户端没有恢复入口
- 文件：`clients/apple/Sources/HimawariChat/ChatStore+Manage.swift:74`、`clients/apple/Sources/HimawariChat/ChatListManage.swift:243`
- 问题：先逐个暂停 active task，再重新查 impact，再 trash。任一步在暂停之后失败，函数返回 `.failed`；已暂停的任务不会恢复，而 iOS 界面没有恢复任务的入口。用户看到的是“没成功”，但副作用已经发生。
- 证据：
  - `ChatStore+Manage.swift:75-80`：
    ```swift
    if pausingActiveTasks, !impact.activeTasks.isEmpty {
        for task in impact.activeTasks { _ = try await api.pauseTask(task, in: thread.threadId) }
        impact = try await api.deletionImpact(threadId: thread.threadId)
    }
    guard impact.deletionAllowed else { return .blocked }
    let outcome = try await api.lifecycleThread(ThreadGatewayCommand.trash, ...)
    ```
  - `ChatListManage.swift:246-250`：失败时也直接 `dismiss()`，只弹通用失败提示。
- 建议：最好由服务端提供原子“暂停并删除”命令；做不到时，客户端应记录已暂停的 taskId，失败时提供恢复/重试入口，并在删除确认前明确列出将暂停哪些任务。补“暂停成功后 trash 失败”的测试。

### 4、中：新增的 ChatStore/UI 编排没有自动检查，Linux 的 314 项测试完全没有编译 HimawariChat
- 文件：`clients/apple/Package.swift:21`、`clients/apple/README.md:182`、`clients/apple/Tests/HimawariCoreTests/ThreadManagementTests.swift`
- 问题：新增测试只覆盖 `DeviceAPI` 的请求字节；`ChatStore+Manage.swift` 的删除顺序、冲突、blocked、归档列表、搜索，以及 `ChatListManage.swift` 的 UI 都没有测试。更关键的是 Linux 上 `interfaceTargets` 为空，`HimawariChat` 根本不参与构建，所以“Linux swift test 314 项通过”不能证明这些新 SwiftUI 文件能编译，也不能证明删除/置顶/归档/分出流程正确。
- 证据：
  - `Package.swift:21-23`：`#if os(Linux) let interfaceTargets: [Target] = []`
  - `Package.swift:11-16`：`HimawariCoreTests` 只依赖 `HimawariCore`
  - `README.md:182`：“界面、小组件和嵌入只能在 Mac 上的 Xcode 里编译。”
  - 测试文件只断言请求体和响应解析，没有 ChatStore 编排用例。
- 建议：增加基于 `RecordingExchange` 的 ChatStore 级测试（删除、暂停后失败、冲突、归档、fork 重试）；增加 Mac 编译检查；把抓到的请求体送进服务端 thread-v3 schema 解析，避免只测客户端自己的编码。

### 5、低：fork 选源把所有角色都算进去，可能在回答进行中从 owner 消息分出无回答的新对话；网页只在已回答轮次、从 agent 消息分出
- 文件：`clients/apple/Sources/HimawariCore/ThreadManagement.swift:50`、`apps/control-center/src/components/chat-history.tsx:307`、`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1855`
- 问题：iOS 取“最新的、committed、带 turnId 的消息”，不区分角色。owner 消息在一轮开始时就已经 committed，而 assistant 消息此时可能还是 partial。菜单在回答进行中也能点，因此可能从一条尚未有回答的 owner 消息分出，新对话里只有问题没有回答。网页只在 `isAnsweredRun` 的回答区域显示 fork，并从 `agentMessages.findLast(...turnId)` 取源。
- 证据：
  - `ThreadManagement.swift:52`：`messages.filter({ $0.status == .committed && $0.turnId != nil }).max(by: { $0.sequence < $1.sequence })`
  - `chat-history.tsx:307-311`：`const last = agentMessages.findLast((item) => item.turnId);`
  - `sqlite-thread-operations.ts:1863-1870`：`hasCommittedTurn` 只要求该 turn 有任意 committed 消息。
- 建议：fork 源至少限制为 `role == .agent`，并在当前 run 未终结时不提供 fork；或者像网页一样让用户选择具体某一轮。

### 6、低：作者关于“服务端搜索设备路由没有”的说法与代码不符；彻底删除也只是本 PR 没做，服务端已有 change 档
- 文件：`packages/gateway-contracts/src/client-capabilities.ts:274`、`:266`、`packages/platform-node/src/device-gateway.ts:82`、`:245`
- 问题：`thread.search` 已登记为 `thread-v3` 的只读 query，设备网关会转发 thread-v3 查询；`thread.delete_permanently` 也已登记（change 档，需要确认挑战）。因此“服务端搜索设备路由没有”是错误说法；不做服务端搜索可以是产品取舍，但理由不能写成“没有路由”。
- 证据：
  - `client-capabilities.ts:274`：`query("thread-v3", "thread.search")`
  - `client-capabilities.ts:266`：`change("thread-v3", "thread.delete_permanently")`
  - `device-gateway.ts:82`：thread-v3 请求体允许 `gateway/type/messageId/idempotencyKey/payload`，查询走同一入口。
- 建议：修正 PR 说明；若坚持本机搜索，请写明是产品选择，而不是服务端不可用。若要实现服务端搜索，需要准备 `queryRef`、`tokenRefs`、`projectionVersion`。

**侧重检查**

- 错误路径：删除做到“先查 impact、暂停 active、重查 impact、再 trash”，blocked 时不删除；但暂停后失败会留下副作用（见意见 3）。`manage` 在 conflict 后会刷新线程摘要，再返回 conflict，重试可用。
- 不合规范/不可信输入：标题在客户端只拒绝空/纯空白，长度和分类由 `payloads/text/new` 的 `parseTextAdmission` 校验（服务端 64 KiB）；服务端响应的未知状态不会导致误删，`isActive` 只认 `"active"`。未发现注入风险。
- 安全：没有新增彻底删除；改名和 resultRef 以 `private` 上传；搜索在本机完成，不把查询发给服务器；未发现密钥或敏感日志。
- 资源耗尽：`allThreads` 只靠重复 cursor 终止，没有页数上限；这与既有 `refreshThreads` 相同，属于已有模式。文本接口每批最多 100 个 ref、响应有 4 MiB 上限。
- 规则/文档一致性：回答语言未接入模型策略；设备搜索路由实际存在；幂等语义与网页和规格不一致。
- 未核实：没有运行测试，没有在 Mac 上编译 UI；因此 UI 能否编译、314 项测试是否包含本次新增界面，未核实。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 当前代码不会。改动只在新客户端界面和线程管理命令，`ChatStore` 的 `send`/`flush`、上下文组装、遮盖逻辑都没动；新增的 titleRef、resultRef、pinOrder、revision 等都不进入 prompt。唯一需要盯的是回答语言：目前服务端没有把它接入 run policy（`production-model-composition.unit.test.ts:718` 明确断言 `answerLocalePolicy` 为 `undefined`），所以现在不改变请求开头；一旦接线，answer-locale 文本会进入 `systemInstruction`（`context-projection-service.ts:81-92,96-108`），会改变请求开头。这是规则第 6 条允许的“回答语言变了”换新，但那时作者“不改变请求开头”的说法就不成立。系统的 prompt-prefix 规则我已从 git 读到，要求是只追加；本次改动的模型请求组装本身没有违反。

2. **同一段文字会不会在不同请求里变成不同字节？** 对模型请求：没有新增会变的字段进入系统提示、工具定义、历史或遮盖结果，也没有新增无序集合或时间字段进入 prompt。对新线程管理请求：UUID 每次不同、`JSONEncoder` 键序也不保证固定，服务端能解析，但同一用户动作重复发送时字节不同，这会破坏重试幂等（见意见 2），不属于 KV 缓存问题。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 部分有。`ThreadManagementTests.swift` 覆盖了请求形状，并且有重复 cursor、conflict、pinOrder 为 null、只有 active task 算 active 等反向断言；从测试代码与实现对应关系看，这些在实现回退时会失败。但以下没有覆盖：删除/归档/fork 的 ChatStore 编排、暂停后失败、幂等键复用、fork 重试不重复建线程、UI 编译和交互、抓到的请求体是否真的能通过服务端 thread-v3 schema。因此 314 项通过不足以证明本次改动的正确性。

4. **每个新值的产生处和使用处是否都核对过？** 大部分通过：
   - `messageId`/`idempotencyKey`：客户端 UUID，通过设备网关的 `MACHINE_STRING` 和服务端 machineString；文本键 `device-text-...` 长度 43，符合服务端 `MESSAGE_ID_PATTERN`。
   - `titleRef`/`resultRef`：由 `payloads/text/new` 产生，服务端按 machineString 接收。
   - `pinOrder`：0 或 null，符合 `nullable(integer(0))`；null 的编码也有测试。
   - `answerLocale`：`zh-CN`/`en`/`ja`，符合合约枚举；但模型侧没有消费者（意见 1）。
   - `sourceTurnId`/`sourceWatermark`：来自 committed 消息的 sequence，类型符合 machineString 和 `integer(1)`；选源角色的偏差见意见 5。
   - `targetThreadId`：`thread-fork:` + 32 位十六进制，能通过 machineString 和 `createThreadId`，但每次重试都变（意见 2），客户端还不用服务端返回的 threadId。
   - `expectedRevision`、`reasonCode`、`thread.list` 的 `statuses`、`deletionAllows` 相关字段、`task.resolve` 的 `action: "pause"` + `targetThreadId: null`：都与合约一致。
   - 明确的跨端缺口是：回答语言值有生产处、没有模型侧使用处；作者关于设备搜索路由的判断也与代码不符（意见 6）。
