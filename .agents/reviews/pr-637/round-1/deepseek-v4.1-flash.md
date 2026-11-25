### 1. 高：NotificationRouter 在 nonisolated 回调里同步调用 @MainActor 静态方法，iOS 目标很可能编译失败
- 文件：`clients/apple/Sources/HimawariShell/NotificationRouter.swift:39`、`:46-51`
- 问题：`NotificationRouter` 是 `@MainActor` 类，`presentation` 未标 `nonisolated`，因此是主 actor 隔离的；它被 `nonisolated` 的 `willPresent` 同步调用，没有 `await`，也没有 `MainActor.run`。Mac 构建会跳过整个 `#if os(iOS)` 文件，所以作者说的 Mac 编译验证发现不了。
- 证据：
  ```swift
  static func presentation(category: String, push: HimawariPush?, mainChatOnScreen: Bool) -> UNNotificationPresentationOptions {
  ...
  public nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
      ...
      return Self.presentation(category: category, push: push, mainChatOnScreen: onScreen)
  ```
- 建议：把 `presentation` 标成 `nonisolated static func`（它只读入参），或改成 `return await MainActor.run { Self.presentation(...) }`；并给 iOS 目标加一次真实构建检查。
- 性质：读代码按 Swift 6 隔离规则推断，未实际编译。

### 2. 高：选项点选在当前代码里必定被手机端自己拒掉，而且失败没有提示
- 文件：`clients/apple/Sources/HimawariManage/ThreadOptionChooser.swift:16-25`、`clients/apple/Sources/HimawariManage/Gateway/ManageGateway.swift:54`、`:133-136`
- 问题：`ThreadOptionChooser` 发 `thread.option.choose`，但该类型不在网关契约、不在 `CLIENT_CAPABILITY_TABLE`，也不在生成的 `ClientCapabilities.swift` 里。`ManageGateway` 先查本机能力表，查不到直接抛 `unknownType`，请求根本不会发出。作者的说法属实，但这意味着第 6 项功能在当前 PR 里完全不可用；`MessageOptionsView` 只在 `catch` 里报告失败触感并把 `sending` 复位，用户看不到“为什么没反应”。
- 证据：
  ```swift
  private func capability(_ gateway: ClientGateway, _ type: String) throws -> ClientCapability {
      guard let capability = ClientCapabilities.find(gateway, type) else {
          throw ManageGatewayError.unknownType(gateway, type)
      }
  ```
  全仓搜索 `thread.option.choose`，除 `ThreadOptionChooser.swift` 外没有第二处；生成的 `ClientCapabilities.swift` 的 thread-v3 表止于 `thread.checkpoint`。
- 建议：服务器契约和 `CLIENT_PAGE_TABLE`/`CLIENT_CAPABILITY_TABLE` 登记 `thread.option.choose` 后，用 `HIMAWARI_WRITE_CLIENT_PARITY=1` 重新生成 Swift；在那之前对本机能力表查不到的类型禁用选项或显示明确“暂不可用”，不要让它看起来能点却静默失败；补一条成功路径和一条“能力未登记时拒绝”的测试。
- 性质：读代码证实；“服务器将来是否登记”属于作者已知范围。

### 3. 高：选项点选没有稳定去重编号，网络失败后重试可能重复执行不可撤销动作
- 文件：`clients/apple/Sources/HimawariManage/Gateway/ManageGateway.swift:63`、`clients/apple/Sources/HimawariManage/ThreadOptionChooser.swift:15-26`、`clients/apple/Sources/HimawariChat/MessageOptionsView.swift:58-67`
- 问题：设计规格明确要求“带具体动作的选项只能点一次，用现有命令的去重编号，连点两下只执行一次”。但 `ManageGateway.command` 每次调用都用新的 `makeIdentifier()`（默认随机 UUID）生成 `idempotencyKey`，`ThreadOptionChooser` 也不传稳定编号。请求在服务器已执行但客户端没拿到响应时，`MessageOptionsView` 会复位 `sending`，用户再点一次会带新的幂等键重发；对于“发邮件 / 花钱 / 删东西”这类选项，可能重复执行。
- 证据：
  ```swift
  body["idempotencyKey"] = .string("device-\(makeIdentifier())")
  ...
  public func choose(threadId: String, messageId: String, setId: String, optionId: String) async throws {
      _ = try await gateway.command(
          .threadV3,
          "thread.option.choose",
          payload: [...]
  ```
  设计规格 `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:375`：“带具体动作的选项只能点一次（用现有命令的去重编号，连点两下只执行一次）……”。
- 建议：让 `ManageGateway.command` 接受调用方提供的稳定 idempotency key，或由 `threadId/messageId/setId/optionId` 派生；失败重试沿用同一个编号，不要重新生成。补一条“同一选项重试两次只执行一次”的反向测试。
- 性质：读代码证实与规格不一致；服务器是否还会按 payload 自己再去重，未核实。

### 4. 中：未知 state 被兜住了，但其他选项字段仍会让整段对话解码失败
- 文件：`clients/apple/Sources/HimawariCore/Models.swift:159-190`、`clients/apple/Sources/HimawariChat/ChatStore.swift:202-217`、`:395-399`
- 问题：作者只给 `MessageOptions.State` 加了未知值回退 `.stale`。但 `MessageOptions.setId`、`items`、`Item.optionId/label/state`、`Action.tool/summary` 仍是必填；服务器漏字段、改名或返回 `null` 时，`ThreadMessage` 整体解码失败，`ChatStore.load` 捕获后对非 `DEVICE_REVOKED` 错误什么都不做，界面只停留在旧内容或空白，没有提示和重试。
- 证据：
  ```swift
  public struct Item: Codable, Sendable, Equatable, Identifiable {
      public let optionId: String
      public let label: String
      public let reason: String?
      public let action: Action?
      public let state: State
  }
  ...
  } catch {
      await handle(error)
  }
  ...
  private func handle(_ error: Error) async {
      if let error = error as? DeviceAPIError, error.isRevoked {
          onSessionInvalid()
      }
  ```
- 建议：对选项做逐项容错解码（坏项丢弃或降级为 stale），或把这些新字段整体改成可选；同时让 `load` 失败可重试并显示错误。补缺 `state`、缺 `action.summary`、坏 `items` 的测试。
- 性质：读代码证实；服务器实际输入格式未核实。

### 5. 中：客户端页面清单和生成的 NativePage 仍指向已经删掉的页面
- 文件：`packages/gateway-contracts/src/client-capabilities.ts:384-396`、`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:61-70`
- 问题：这个 PR 删掉了“今天”页、设置首页、能力页、改进页，但客户端页面清单仍写 `approvals -> today.approvals`、`suggestions -> today.suggestions`、`capabilities-adapters -> settings.capabilities`、`improvements -> settings.improvements`。`client-parity` 只核对清单和生成 Swift 彼此一致，不核对真实导航目的地，所以门禁照样通过，但清单在说谎。计划和 ADR 都要求改外壳的这个 PR 一起改这张表。
- 证据：
  ```ts
  { webPage: "approvals", nativePage: "today.approvals" },
  ...
  { webPage: "capabilities-adapters", nativePage: "settings.capabilities" },
  ...
  { webPage: "suggestions", nativePage: "today.suggestions" },
  ...
  { webPage: "improvements", nativePage: "settings.improvements" },
  ```
  生成文件：
  ```swift
  case settingsCapabilities = "settings.capabilities"
  case settingsImprovements = "settings.improvements"
  case todayApprovals = "today.approvals"
  case todaySuggestions = "today.suggestions"
  ```
- 建议：按 ADR 0258/计划把 `approvals`、`suggestions` 改成新的去处（选项内联、同意卡片在主对话），`capabilities-adapters`、`improvements` 登记为手机上不做，再重新生成 Swift；最好再加一条把清单和实际导航目的地对照的检查。
- 性质：读代码证实；具体新去处应与设计线程确认。

### 6. 中：ownerPresence 缺失时默认 false，安全缺省方向相反
- 文件：`clients/apple/Sources/HimawariCore/Notifications/ApprovalPush.swift:30-35`
- 问题：审批按钮的 `ownerPresence` 是安全相关字段；“服务端要求本人在场”时客户端应保守处理。现在字段缺失就按 `false`，即允许把 token 从锁屏直接发出去。当前服务器 `production-apple-push.ts` 总会带这个字段，所以现实风险有限；但旧版本、异常或未来格式变化会 fail-open。
- 证据：
  ```swift
  return Action(action: action, label: label, token: token, ownerPresence: entry["ownerPresence"] as? Bool ?? false)
  ```
  服务器确实发送该字段：`apps/agent-service/src/production-apple-push.ts` 的 approve/deny 两项都写 `ownerPresence`。
- 建议：要求该字段必须是布尔，缺失时整条 action 丢弃或按 `true` 处理；补一条“缺 ownerPresence 不发送 token”的反向测试。
- 性质：读代码证实代码行为；实际推送是否可能缺字段未核实。

### 7. 低：架构文档仍说 iPhone 没调用 thread.main、还在新建对话，与代码相反
- 文件：`docs/architecture-v0.1.md:439`、`clients/apple/Sources/HimawariManage/MainThreadLocator.swift:23-25`、`clients/apple/Sources/HimawariShell/RootView.swift:159`
- 问题：文档写“iPhone 端还没有调用 `thread.main`（`clients/apple` 里只有生成的能力声明），App 仍按原来的方式新建对话，改成用主对话是后续的 PR”；代码已经通过 `MainThreadLocator` 调用 `thread.main`，主界面也没有新建对话入口。
- 证据：文档原文同上；代码 `let data = try await gateway.read(.threadV3, "thread.main")`。
- 建议：更新文档这一句，并把第 5 项里的客户端页面清单一起补齐。
- 性质：读代码证实。

### 8. 低：关键新逻辑缺少自动检查，现有 Linux 验证覆盖不到 Manage 和通知路由
- 文件：`clients/apple/Package.swift:22`、`:41`；新增测试 `Tests/HimawariCoreTests/ApprovalPushTests.swift`、`MessageOptionsTests.swift`、`Tests/HimawariManageTests/MainThreadLocatorTests.swift`
- 问题：Core 的推送解析、选项解码、设计令牌和触感顺序都有测试，但完全没有测 `NotificationRouter.presentation`（主对话开着时普通推送不弹、审批推送照弹）、分类注册、`ThreadOptionChooser` 的载荷/能力拒绝/幂等。`Package.swift:22` 在 Linux 上把 `interfaceTargets` 置空，所以作者说的 Linux `swift test` 只跑 Core；`MainThreadLocatorTests` 和 `HimawariManageTests` 在 Linux 根本不会构建。
- 证据：
  ```swift
  #if os(Linux)
  let interfaceTargets: [Target] = []
  ```
- 建议：给 `NotificationRouter` 抽出的纯函数加测试；给 `ThreadOptionChooser` 加成功载荷和缺能力两条测试；至少把 Manage 测试放到 Mac/iOS CI，或明确记录未验证。
- 性质：读代码证实测试布局；测试缺口对功能的影响为推断。

**侧重检查**
- 审批推送输入：核对 `HimawariPush` 与服务器 `production-apple-push.ts`、`device-push.ts`、`device-api-routes.ts`。`v/kind/actions/action/label/token/ownerPresence`、`himawari.actions`/`himawari.plain`、`approve`/`deny`、`POST approvals/respond` 的 `{token}` 都一致；服务器对 ownerPresence 的 approve 还要求 `confirmed`，客户端在 ownerPresence 时不发，两端能接住。发现 ownerPresence 缺字段时的 fail-open 默认。
- 错误路径：主对话查找失败有重试界面；通知 transport 为空或点按失败会退回打开 App；选项点选失败只有触感、没有文字提示；选项解码失败整段对话不可见且 `ChatStore` 静默。
- 不可撤销的操作：审批 token 服务器侧一次性消费（`consumeActionToken`）；选项动作没有稳定幂等编号，是主要风险。
- 资源耗尽：推送载荷受 APNs 4 KB 限制，解析只做一次 `compactMap`，没有新增循环或递归风险。
- 文档/规则一致性：`ci/operations-pending.json` 新增的操作名都能在 `contracts-v2.ts` 找到，删除的调用方在 Swift 里确实不存在；设计令牌、CSS、三语文案、删除后的符号引用都做了静态核对，未发现悬空引用。但客户端页面清单和架构文档没跟上。

**读代码证实的**
- 改动没有触碰 `packages/prompt-catalog`、运行时、记忆或对话上下文组装代码；改的是 Apple 客户端、设计令牌、测试和 `ci/operations-pending.json`。
- `thread.option.choose` 不在契约、不在生成的 `ClientCapabilities.swift` 中，本机会拒绝。
- `ManageGateway.command` 每次用新的随机 idempotency key。
- `ownerPresence` 缺省 false。
- 选项模型除 state 外字段仍严格必填；`ChatStore.load` 只对 revoked 做处理。
- 客户端页面清单仍列已删除页面。
- 架构文档关于 `thread.main` 的描述已过时。

**推测/未核实**
- 第 1 条是否真的编译失败：按 Swift 6 隔离规则判断，但本环境不能编译 iOS 目标。
- 服务器实现 `thread.option.choose` 时是否仍按规格只在末尾追加、是否会按 payload 自身去重、服务端字段是否就叫 `threadId/messageId/setId/optionId`：服务器 PR 未在仓库中，全部未核实。
- 服务器是否会在新消息出现后把旧选项标成 stale：客户端完全依赖 `options.isOpen`，本地没有“有更新消息就变灰”的兜底；设计规格要求那样做，但服务端行为未核实。
- Mac shared code 是否真能编：静态搜索没有发现引用已删符号，但没有实际在 Mac 上编译；而且 iOS 专属的 `NotificationRouter` 不会被 Mac 构建覆盖。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 从本仓库的改动看，没有：没有改系统提示、工具定义、历史消息、遮盖或服务端上下文组装代码。`ThreadMessage.options/chosenFrom` 只是客户端解码字段；`thread.main` 是只读查询。新命令 `thread.option.choose` 的服务器行为不在本仓库，设计规格（`2026-11-24-main-thread-subthreads-inbox-design.md:379`）要求“你的点选是之后的一条新消息，只在末尾追加”，但服务器 PR 未出，无法确认它不会回写旧消息的选项状态。若服务器按规格实现，发给模型的内容仍然只在末尾追加，每轮会变的值也不在系统提示或工具定义里；这一点标记“未核实”。

2. **会不会让同一段文字在不同请求里变成不同字节？** 没有发现模型可见的这类问题。设计令牌生成器按键排序，未知 state 的映射是确定的；新增的选项文字来自服务器，客户端只原样显示和发回，不拼接、不插入时间。唯一新增的不确定值是 `ManageGateway` 的随机 idempotency key，但它不是模型请求文本；如果服务器把它写进对话或模型上下文，是否影响缓存需要服务器 PR 才能核对。

3. **有没有对应自动检查，反向用例会失败吗？** 有：`ApprovalPushTests`、`MessageOptionsTests`、`MainThreadLocatorTests`、设计令牌测试、触感顺序测试。已覆盖的反向用例是真会失败：去掉未知 state 回退会让解码抛错；去掉 ownerPresence 判断会把 token 发出去；去掉设计令牌的嵌套展开会让新断言失败；去掉 `TalkAudio` 的 `setAllow...` 会让新检查失败。缺少：`NotificationRouter.presentation`/分类注册、`ThreadOptionChooser` 成功路径与幂等、选项 UI 锁定、缺 `ownerPresence`、坏选项字段、页面清单与实际导航一致性；而且 Manage 测试在 Linux 不构建，作者的 Linux 验证没有覆盖它们。

4. **每个新值两端都能接受吗？** 逐个核对的结果：
   - `thread.main`：契约、`CLIENT_CAPABILITY_TABLE`、生成的 `ClientCapabilities.swift` 和文档都接受，`MainThreadLocator` 的解码形状与文档一致。
   - `thread.option.choose`：客户端生产，但本机能力表和服务器契约都不接受，当前必被 `ManageGateway` 拒绝（意见 2）。
   - 审批推送的 `v`、`kind`、`actions`、`action`、`label`、`token`、`ownerPresence`、`himawari.actions/plain`、`approve/deny`、`approvals/respond {token}`：与服务器代码一致，能被两端接住；但客户端要求 `label`，自己却不用它，未来服务器若省略 label 会让按钮退化成“打开 App”。
   - `MessageOptions`/`chosenFrom` 的字段名、`dismissId = "dismiss"`：服务器生产方不在仓库，未核实。
   - 设计令牌命名、Swift 常量、CSS、三语文案：新名字都有生成值和消费处；删除的旧令牌、旧字符串没有发现残留引用。
   - `ci/operations-pending.json` 新增登记项：操作名都在 `contracts-v2.ts` 中存在，Swift 调用方已删除，项本身能通过 `check:operations` 的 ID 校验；`client-parity` 也能过，但它只证明页面清单和生成文件彼此一致，不证明页面清单与真实 UI 一致（意见 5）。
