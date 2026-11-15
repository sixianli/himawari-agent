### 1. 高：生产网关没有安装 `grant.list` / `grant.detail` / `grant.revoke`，授权页在生产会静默消失
- 文件:行：`ci/operations-pending.json:43-45`、`apps/agent-service/src/production-approval-gateway.ts:99-115`、`:381-407`、`packages/application/src/services/agent-gateway-v2-service.ts:34-42`、`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:43-61`、`:193-194`、`clients/apple/Sources/HimawariManage/SettingsRootView.swift:104`
- 问题：作者说“服务器端（PR 572）已合并”，但 PR 572 只加了 `grant.snapshot` 的 `label/detail` 合同和 adapter，没有把这三个操作装进生产网关的 `installedOperations`。代码里 `grant.list`、`grant.detail`、`grant.revoke` 仍被登记为 `notInstalled`，`AgentGatewayV2Service` 会直接抛 `PORT_OPERATION_NOT_INSTALLED`。iOS 端 `loadGrants()` 的失败又被 `try?` 吞掉，`grants` 保持 `nil`，`SettingsRootView` 的 `if let grants` 因此不显示入口。
- 证据：
  - `ci/operations-pending.json:43-45`：三项都写着“生产网关还没装配（没进已安装清单、没有路由到处理方）”。
  - `production-approval-gateway.ts:99-115` 的 `PRODUCTION_APPROVAL_OPERATIONS` / `PRODUCTION_CAPABILITY_OPERATIONS` 没有 `grant.*`；`:381-407` 的 `installedOperations` 也没有。
  - `agent-gateway-v2-service.ts:34-42`：不在清单就抛 `PORT_OPERATION_NOT_INSTALLED`；`http-gateway-server.ts:958-966` 把它映射成 501。
  - `SettingsStore.swift:47`、`:193-194` 用 `try?` 包住 `loadGrants()`，`:61` 把 `nil` 赋给 `grants`；`SettingsRootView.swift:104` 只有 `grants != nil` 才显示入口。
- 读代码证实的：PR 572（`1ca0ccd5a`）的改动文件只有 contracts、governance adapter、fixture 和测试，没有 `production-approval-gateway.ts` 或 `ci/operations-pending.json`。生产路径确实不可用，页面会直接不出现。
- 建议：在这个交付里把 `grant.list`、`grant.detail`、`grant.revoke` 加入生产 `installedOperations` 并确认 read/control-plane 路由（`GovernanceGatewayV2ReadModel` 已有对应逻辑，controlPlane 也有 `#revokeGrant`）；做不到就把授权页显式 feature-gate 掉，不要合并成“已完成”。同时扩展 `scripts/check-operations.mjs`：现在 `notInstalled` 只要已登记就不会因为“后端+调用方+测试都齐全”而报错（`:409-417` 只查已安装/未声明，`:430-433` 只查 `pending`），应补一道门禁，避免再次出现 I-73 那种“契约和页面都有、生产没接线”。

### 2. 高：网络和传输错误被当成用户取消 Face ID 静默吞掉
- 文件:行：`clients/apple/Sources/HimawariManage/Settings/GrantsPage.swift:121`、`:130-132`；对照 `clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:118-121`、`clients/apple/Sources/HimawariManage/Settings/TuningPages.swift:126-128`
- 问题：`GrantsPage.declined` 只把 `ManageGatewayError`、`DeviceAPIError`、`DeviceKeyError`、`DecodingError` 当成“不是取消”，其余一律当成用户取消。`URLError` 和 `HTTPExchangeError` 不在这四个类型里，因此网络断开、超时、TLS 失败都会被 `catch where Self.declined(error) {}` 静默忽略：用户点了撤回、过了 Face ID，界面既没有失败提示，也没有成功提示，像是按钮没反应。
- 证据：
  - `GrantsPage.swift:121-124`：`catch where Self.declined(error) {}` 分支为空；`catch` 才设置 `failedId`。
  - `GrantsPage.swift:130-132`：判断列表里没有 `URLError`、`HTTPExchangeError`。
  - `SettingsStore.swift:118-121` 和 `TuningPages.swift:126-128` 的同类判断都显式包含 `URLError` 和 `HTTPExchangeError`，本页是唯一漏掉这两个的。
  - `clients/apple/Sources/HimawariCore/HTTPExchange.swift:33-35`：`URLSession.data(for:)` 直接抛 `URLError`；`Gateway/DeviceTransport.swift:42-60` 只捕获 `DeviceAPIError.server`，所以网络错误会一路冒到 `GrantsPage`。
- 建议：直接复用 `SettingsStore.isDeclined`，或至少把 `URLError`、`HTTPExchangeError` 加进去；更好的做法是给“用户取消 Face ID”定义明确的错误类型，只吞这一种，其余都显示失败并允许重试。补一条用抛 `URLError` 的 transport 测“会走失败提示”的反向用例。
- 推测：用户取消 Face ID 具体抛哪种错误，本机无法运行验证。`SecureEnclaveKeySigner.sign` 的 `key.signature` 在 `do/catch` 之外（`SecureEnclaveKeys.swift:20-33`），取消很可能不是 `DeviceKeyError`，会被 `declined` 当成取消；如果某些系统版本把取消包成 `DeviceKeyError`，当前代码又会误显示“没能撤回”。两种都说明这种“按错误类型猜取消”的写法不可靠。

### 3. 中：撤回把“任何非 401/403 拒绝且列表里没有”都判成“已不在了”，会误报
- 文件:行：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:211-217`、`:222-228`、`:210`；相关服务端顺序 `packages/application/src/services/governance-gateway-adapter.ts:648-663`
- 问题：服务端拒绝后，客户端只确认状态不是 401/403，然后重新拉一次“只含 active 的列表”；列表里找不到就返回 `.gone`。这把多种情况都归成“已不在了”：
  - 授权没被删除，只是过期或已用完，`loadGrants()` 的 `filter(\.isActive)` 会把它从列表里过滤掉；
  - 服务端返回 500（例如撤回已经写入，但后续 `#appendAudit` 或 `receipts.complete` 失败）时，列表里没有该授权，也会显示“已不在了”，而实际是撤回已生效或结果未知；
  - 400 等请求错误如果恰好碰上授权失效，也会伪装成 `.gone`。
- 证据：
  - `SettingsStore.swift:211-217`：`guard case .rejected(let status, _, _)`, 只排除 401/403；`guard !listed.contains(...) else { throw error }`，找不到就 `.gone`。
  - `SettingsStore.swift:228`：`return result.filter(\.isActive)`，过期和用完的授权都不在 `listed` 里。
  - `governance-gateway-adapter.ts:648-663`：先 `#mutate`，再 `#appendAudit`，再 `receipts.complete`；后两步失败时命令已经执行，但 HTTP 会报错。
- 读代码证实的：当前实现无法区分 404“确实不存在”、409“版本冲突”、5xx“结果未知”，也没有读服务端的错误 code/reason。
- 建议：按状态码和错误码分支：404（或明确的 grant-not-found）才 `.gone`；409 重新拉取后若授权仍 active 则抛版本冲突；5xx 显示失败/未知，不能报“已不在了”；同时区分“已失效（过期/用完）”和“不存在”。补 404、409-仍存在、500、过期/用完四种测试。
- 推测：服务端在审计失败后留下已撤回状态的 500，这一具体生产时序未实测，但代码顺序支持这种可能。

### 4. 中：单条 `grant.detail` 失败会让整个授权列表加载失败
- 文件:行：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:222-228`、`:47`、`:193-194`
- 问题：`loadGrants()` 先拉列表，再逐条串行请求 `grant.detail`；循环里任何一条 404、解码失败或网络错误都会让整个函数抛出。`load()` 和 `reloadGrants()` 都用 `try?` 包住，结果是 `grants` 变成 `nil` 或保留旧值，页面显示“没读到”或入口消失，而不是显示其余仍然有效的授权。授权列表和详情不是原子读取，列表返回后某条被撤回/过期/删除，正是这种失败的来源。
- 证据：
  - `SettingsStore.swift:224-227`：`for ref in try await refs(...)` 内 `try await gateway.read(...)` 和 `decode` 都是整函数级抛出。
  - `SettingsStore.swift:47`、`:193-194`：调用方用 `try?`，没有逐条降级。
- 建议：对单条 `grant.detail` 的 404 直接跳过；其他单条失败记录并继续显示其余结果，或用服务端一次性返回完整快照/状态过滤，避免 N+1 和全有全无。增加“一个 detail 404/失败，其余仍显示”的测试。
- 推测：真实生产中是否频繁遇到 list/detail 之间的 404，未测量；但机制是确定的。

### 5. 中：新增错误路径没有对应的自动检查，反向用例只覆盖了“成功”和“已消失”
- 文件:行：`clients/apple/Tests/HimawariManageTests/SettingsStoreTests.swift:303-334`
- 问题：新增测试只有三条：只列 active、撤回载荷与任务数、409 后列表变空返回 `.gone`。没有测试版本冲突但授权仍存在时必须抛错、401/403 必须抛错、`URLError`/`HTTPExchangeError` 必须显示失败、单条 detail 失败不能拖垮整页、以及视图层 `declined` 不会吞掉网络错误。也没有测试生产网关是否真的接受 `grant.*`；`check:operations` 不会因为 `notInstalled` 条目“后端+调用方+测试齐全”而失败，所以第 1 条那种问题不会被现有检查拦住。
- 证据：`SettingsStoreTests.swift:303-334` 只有上述三条；没有 `URLError`、401/403、409-with-active、detail 404 的 transport 或断言。
- 建议：至少补四种反向用例：409 且授权仍存在、404、`URLError`、单条 detail 失败；再加一条通过真实 device gateway/`installedOperations` 的端到端用例，断言 `grant.list/detail/revoke` 不会得到 501。
- 未核实：本机不能编译 Swift，因此“这些反向用例会失败”是按代码逻辑判断，未在 Mac 上实际运行。

### 6. 低：不可逆的撤回在确认前不显示会影响多少任务
- 文件:行：`clients/apple/Sources/HimawariManage/Settings/GrantsPage.swift:117`、`clients/apple/Sources/HimawariManage/ManageStrings.swift:133-135`、`:100-104`
- 问题：撤回是不可撤销操作，但传给 Face ID 的确认文案只有“撤回「标题」”；“会影响 N 个任务”只在成功后的提示条里出现。用户如果不展开详情、不记得数量，就无法在确认前看到这次撤回会影响什么。`grant.affectedTaskRefs.count` 其实在点击时已经能拿到。
- 证据：`GrantsPage.swift:117` 只传 `M.confirmRevokeGrant(name)`；`ManageStrings.swift:133-135` 只拼标题；`grantRevoked` 的任务数在 `:100-104`，是成功后的文案。
- 建议：把受影响任务数放进确认原因（例如“撤回「标题」，会影响 N 个任务”），或在点撤回前在行内显示影响；确认文案中的 `label` 来自服务器，合同允许换行/制表符，建议清理换行后再放入 Face ID 提示，避免提示被排版干扰。
- 推测：用户是否会因此误撤回，无法从代码证明，但这是不可逆操作的信息缺口。

### 7. 低：撤回成功后重载失败时，旧行仍在，`busy` 清零后可能对同一授权重复发送
- 文件:行：`clients/apple/Sources/HimawariManage/Settings/GrantsPage.swift:83-85`、`:110-125`；`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:209-210`
- 问题：按钮只按 `busy == grant.id` 禁用，仓库层没有 in-flight 集合。撤回成功后 `reloadGrants()` 若失败会保留旧列表，`busy` 在 `defer` 里清零，已被服务端撤回的行仍显示且可再次点击；第二次会带旧 revision 发出，得到一个 409/404，最终提示可能被覆盖成“已不在了”。快速连点同一行也没有第二道保护。
- 证据：`GrantsPage.swift:83-85` 只禁用当前 `busy` 的行；`:115` `defer { busy = nil }`；`SettingsStore.swift:209-210` 成功后调用 `reloadGrants()` 后直接返回，而 `:193-194` 的重载失败是静默保留旧值。
- 建议：撤回成功后无论重载是否成功，先本地移除或标记该行；仓库层加按 grant id 的 in-flight 去重（类似 capability 的 `beginReactivation`）；或用一个全局 `busy` 禁止并发的撤回点击。
- 推测：同一帧内快速双击是否真的能绕过 SwiftUI 状态更新未在 Mac 上验证；但“重载失败后旧行仍可点”是代码可直接推出的。

### 8. 低：作者说“展开三种语言的详情行”，代码实际上只显示当前语言
- 文件:行：`clients/apple/Sources/HimawariManage/Settings/GrantModels.swift:3-9`、`clients/apple/Sources/HimawariManage/Settings/GrantsPage.swift:96-100`
- 问题：服务器确实返回 `zh-CN` / `en` / `ja` 三种语言的 `detail`，但 `LocalizedLines` 在解码时只挑 `ManageLanguage.current.serverTag`（找不到回退 `en`），页面也只渲染这一组 `detailLines`。如果作者的意思是“展开后同时显示三种语言”，代码没有做到；如果只是说“服务器给三种语言、客户端按当前语言显示”，则应把说法写清楚。
- 证据：`GrantModels.swift:7-8` 只取一个 key；`GrantsPage.swift:96-100` 只遍历 `grant.detailLines`。
- 建议：把作者说法改成“服务器提供三语，客户端按当前语言显示”，或者如果真的需要三语并排，改成遍历三个表。
- 未核实：这句“三种语言的详情行”可能只是指服务器数据来源，按字面存在歧义。

**侧重检查**

- 错误路径：检查了 401/403（`SettingsStore.swift:212` 重新抛出）、404/409（`:211-217`）、网络/传输（`URLError`/`HTTPExchangeError` 被 `GrantsPage.declined` 漏掉，见第 2 条）、Face ID 取消（只能按错误类型猜测，见第 2 条推测）、解码失败（会被当成失败而不是取消）、重载失败（成功撤回后保留旧行，见第 7 条）。
- 不合规范或不可信输入：`grantId` 由服务器发给客户端后原样回传，服务端 `revokeGrantCommandSchema` 用 `machineString` 校验；`reasonCode` 的 `owner_revoked` 符合 `^[A-Za-z0-9][A-Za-z0-9._:-]*$`（下划线允许）；`includeRevoked` 是布尔、`limit` 在 1..500；这些两端能对上。`label` 会被放进 Face ID 的 `localizedReason`，合同允许换行/制表符，存在轻微提示注入风险，见第 6 条。
- 安全：`grant.revoke` 在 iOS 端是 `.change` 级：`Generated/ClientCapabilities.swift:175` + `ManageGateway.swift:64-74` 会申请 challenge 并加 confirm 签名；`SignedDeviceTransport.swift:42-60` 把它交给 confirm key。服务端 `#revokeGrant` 本身不检查 `recentAuthenticationRef`（`governance-gateway-adapter.ts:903-930`），其他入口是否也有等价确认未核实；本页没有新增日志或密钥输出。
- 不可撤销操作：撤回没有撤销入口，Face ID 是唯一确认，但确认前不显示影响任务数（第 6 条）。
- 资源耗尽：列表读取是 N+1 串行 `grant.detail`，且任意一条失败全页失败（第 4 条）；`refs` 沿用既有分页，没有新增游标进展保护，未判定为本 PR 新问题。
- 文档/代码一致：PR 572 的 `git show --stat` 只改合同/adapter/fixture/测试，没有生产安装清单（第 1 条）；“三种语言”说法与只显示当前语言不一致（第 8 条）；“服务器名称和详情由服务器给”对 snapshot 字段成立，但对生产可用性不成立。
- 未核实：本机无法编译 Swift，无法运行 `swift test` 或真实 Face ID；生产部署是否另有不在本仓库的安装覆盖，未发现证据。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。这个 diff 的 8 个文件都在 `clients/apple/Sources/HimawariManage`、`HimawariShell` 和 Apple 测试里，没有改系统提示、工具定义、历史消息、出口遮盖或任何模型请求组装代码。`ManageGateway` 只把 `grant.*` 发到设备网关，不进入模型请求。按照 `.agents/instructions/prompt-prefix.md` 的第 1-4 条，发给模型的内容没有新增、改写或重排；“每轮会变的值放进最后一条消息”在本 PR 没有新增需要判断的值，因此 append-only 规则不受影响。本机没有运行 `check:prompt-prefix`，但也没有相关代码路径。

2. **会不会让同一段文字在不同请求里变成不同的字节？** 没有发现。UI 里的 `pairingClock ?? Date()`、`grantSubtitle` 的“今天”、到期日期只影响屏幕显示，不进入模型请求；`grant.detail` 的 `uses`、`spentCostMicros`、`affectedTaskCount` 是服务器快照，也不进入模型。服务端 `grant.list` 用 `distinctSorted` 排序，客户端按 `itemRefs` 顺序展示；`LocalizedLines` 按固定 `serverTag` 取值，顺序确定。没有新增无序集合或时间字段到模型序列化。

3. **有没有对应的自动检查，反向用例是否会失败？** 有一部分，但不够。新增的 `SettingsStoreTests` 三条（`:303-334`）覆盖了 active 过滤、撤回载荷/任务数、409 后列表为空返回 `.gone`；其中 active 过滤那条把 `g2` 设为 `exhausted`，去掉过滤会失败，属于有效的反向用例。但版本冲突但授权仍存在、401/403、`URLError`/`HTTPExchangeError`、单条 detail 失败、视图层取消判断、并发撤回都没有测试；也没有自动检查确保生产网关真的安装了 `grant.*`。本机不能编译 Swift，因此“反向用例会失败”只能按代码逻辑判断，未在 Mac 上实际运行。

4. **每个产生或修改的值，两端都能接受吗？**
   - `GrantSummary` 的 `grantId`、`revision`、`status`、`capabilityRef`、`validFrom`、`expiresAt`、`uses`、`affectedTaskRefs`、`label`、`detail`：产生端是 `governance-gateway-adapter.ts:566-607` 的 `grant.snapshot`，合同是 `contracts-v2.ts:3486-3519`；消费端是 `GrantModels.swift:12-29`。字段类型和可空性能对上；时间由 `Timestamp.parse` 兼容带/不带小数秒。
   - `detail` 的 `zh-CN`/`en`/`ja`：合同和客户端 `LocalizedLines` 的键一致；客户端按当前语言取一个，回退 `en`。
   - `grant.list` 的 `includeRevoked=false`、`afterCursor`、`limit=100`：合同 `grantListQuerySchema` 接受布尔和分页字段，服务端 `governance-gateway-adapter.ts:265-282` 按 `includeRevoked` 过滤；通过。
   - `grant.revoke` 的 `grantId`、`expectedRevision`、`reasonCode`：合同 `revokeGrantCommandSchema`（`contracts-v2.ts:2923-2930`）和服务端 `grant-service.ts:129-140` / `sqlite-durable-operations.ts:2427-2448` 都能接受；`grantId` 的服务端格式 `grant:<uuid>` 符合 `machineString`，`owner_revoked` 也符合（下划线允许），`revision` 从 1 开始符合 `integer(1)`；通过。
   - `GrantRevokeOutcome` 的 `.revoked(affectedTasks:)` / `.gone`：只有 `GrantsPage.swift:117-120` 消费；类型和展示对得上；但 `affectedTasks` 来自页面旧快照，任务数可能在撤回落库前已经变化，提示值不保证是撤回时的真实数量。
   - `ownerRevokedReason`：只在 `SettingsStore.revoke` 使用，值被服务端按 `machineString` 接受；通过。
   - `SettingsRootView.Path.grants` 和 `ManageDemoScreen` / `DemoScene` 的 `20-himawari-self-5*`：两个 enum 都加了对应 case，`DemoScenes.swift:113` 通过 `ManageDemoScreen(rawValue:)` 转到 `ManageDemoView`，编译期的 switch 覆盖也补了；本机未编译。
   - `grants` 发布属性：`SettingsRootView` 和 `GrantsPage` 消费；它的 `nil` 被当成“加载失败/不显示”，而后端操作未安装时正好会变 `nil`，这是第 1 条的生产不可用来源。
   - **唯一明确不通过的两端**：客户端新增的 `grant.list` / `grant.detail` / `grant.revoke` 调用方，对端生产网关的 `installedOperations` 不接受；见第 1 条。除此之外没有发现字段、标识或序列化格式两端口径不一致。
