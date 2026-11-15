以下除明确标注「推测/未核实」外，均为对照代码后的结论。

### 1. [中] MCP 改名按 Swift `Character` 截 64，后端按 Unicode 码位计数并拒绝隐藏字符
文件：`clients/apple/Sources/HimawariCore/SettingsMore/McpConnections.swift:65,71-73`；`packages/gateway-contracts/src/contracts-v2.ts:1293-1308,637-648`；`clients/apple/Tests/HimawariCoreTests/SettingsMoreTests.swift:149-151`

问题：客户端把名称截到 64 个 Swift `Character`，后端把名称拆成 Unicode 码位后要求 1..64，并拒绝 `isHiddenNameCharacter` 覆盖的控制符、零宽字符、双向控制符等。一个由多个码位组成的字符（如家庭 emoji）在 Swift 里算 1 个，在后端算多个；用户粘贴零宽字符时客户端也原样放行。这样客户端会构造出后端必然拒绝的 `mcp.connection.change` 请求。

证据：
- `McpConnections.swift:65,71-73`：`public static let nameCharacters = 64`，`String(text.prefix(nameCharacters))`。
- `contracts-v2.ts:1298-1303`：`const characters = [...trimmed]; if (characters.length < 1 || characters.length > MCP_CONNECTION_NAME_CHARACTERS || characters.some((character) => isHiddenNameCharacter(...))) throw ...`。
- `contracts-v2.ts:637-647`：隐藏字符包含 `code < 0x20`、`0x200b..0x200f`、`0x202a..0x202e`、`0xfeff` 等。
- 测试只用了 `String(repeating: "名", count: 100)`，BMP 字符的 `Character` 数等于码位数，未覆盖多码位字符和隐藏字符。

建议：按 `unicodeScalars` 或与后端一致的码位计数截断，并过滤或拒绝 `isHiddenNameCharacter` 覆盖的字符；补一条多码位 emoji、零宽空格的反向测试。`OwnerPreferences.clampedName` 用 UTF-16 计数与 `boundedString` 一致，但也未过滤 C0 控制符（`validation.ts:102-118` 会拒绝），同类问题较轻。

### 2. [低] 推送种类把服务端未知 kind 当可选项，切换时会回写合同不允许的值
文件：`clients/apple/Sources/HimawariCore/SettingsMore/PushKinds.swift:17-29`；`packages/gateway-contracts/src/contracts-v2.ts:315,328-331`；`clients/apple/Tests/HimawariCoreTests/SettingsMoreTests.swift:96-102`

问题：`listedKinds` 把服务端返回的未知 kind 附在三个已知 kind 后面，`setting` 允许对任意 kind 生成 `PushKindChange`。合同只接受 `reminder`、`approval`、`run`。若服务端版本不一致或返回异常数据，用户点开关就会发出 400。

证据：
- `PushKinds.swift:17-20`：`knownKinds + kinds.filter { !knownKinds.contains($0) }`。
- `PushKinds.swift:27-29`：`isOn(kind) == enabled ? nil : PushKindChange(kind: kind, enabled: enabled)`。
- `contracts-v2.ts:315`：`const pushKindSchema = enumeration(["reminder", "approval", "run"]);`。
- `SettingsMoreTests.swift:96-102` 反而断言 `listedKinds == ["reminder", "approval", "run", "digest"]`，把这种行为固化成预期。

建议：未知 kind 仍可展示，但禁用或拒绝切换；`setting` 对 `Self.knownKinds` 之外的 kind 返回 `nil`，并把测试改为断言未知项不可操作。

### 3. [低] 搜索授权把服务端 `recipients` 原样回写，测试还用了合同不允许的重复列表
文件：`clients/apple/Sources/HimawariCore/SettingsMore/SearchAuthorization.swift:20-23`；`packages/gateway-contracts/src/contracts-v2.ts:256-265,268-274`；`clients/apple/Tests/HimawariCoreTests/SettingsMoreTests.swift:54-60`

问题：客户端不校验也不去重 `recipients`，直接放进 `search.authorization.set`。合同要求每个元素是不同的小写 https origin，重复项会被拒绝。测试 fixture 含有重复的 `https://api.example.com`，并断言重复项被原样发送，因此没有验证真实请求体一定能过后端校验。

证据：
- `SearchAuthorization.swift:20-23`：`SearchAuthorizationChange(expectedRevision: revision, enabled: next, recipients: recipients)`。
- `contracts-v2.ts:259-264`：`recipients.length > 8 || new Set(recipients).size !== recipients.length || recipients.some(...)` 即拒绝。
- 测试第 54 行：`"recipients":["https://api.example.com","https://api.example.com",...]`；第 59 行断言原样发送。

生产环境里快照本身受同一 `searchRecipientsSchema` 校验，所以正常路径不会出现重复；但这是 I-73 同类问题：测试只证明了手机端，不证明“服务端给的值也一定能通过命令校验”。建议测试拆成两组：合法 recipients 用于命令体，重复值只用于 `recipientHosts` 展示去重；客户端构造命令时可再次校验或去重。

### 4. [低] 敏感记录翻页失败完全静默，`sensitiveFailed` 是死状态
文件：`clients/apple/Sources/HimawariManage/Settings/More/MoreStore.swift:16,108-121`；`clients/apple/Sources/HimawariManage/Settings/More/SensitiveRecordsPage.swift:38-40`

问题：`loadSensitive(more:)` 失败只把 `sensitiveFailed` 设为 `true`，页面从不读取这个值；“显示更早的记录”按钮只起一个 `Task`，失败后没有任何提示，用户会以为没有更多记录或按钮失效。

证据：
- `MoreStore.swift:16`：`public private(set) var sensitiveFailed = false`。
- `MoreStore.swift:118-120`：成功置 `false`，失败置 `true`。
- `SensitiveRecordsPage.swift:38-40`：`Button { Task { await store.loadSensitive(more: true) } } ...`，没有判断 `sensitiveFailed`，也没有本地失败状态。

建议：页面观察 `sensitiveFailed`，失败时显示 `MoreNote`/alert 并允许重试；加载期间禁用“显示更早的记录”。补一条失败路径测试。

### 5. [低] Muse 评分失败后本地按钮仍显示已选，没有回滚
文件：`clients/apple/Sources/HimawariManage/Settings/More/MusePage.swift:92-98,158-164,187-191`

问题：`choose` 先改本地 `timing`/`content` 再发请求；请求失败时只弹出通用失败提示，不回滚本地状态。若随后 `loadMuse` 也失败，按钮会继续显示用户刚选的评价，而 `item.isRated` 仍来自服务端，撤销按钮可能不出现，界面与服务器状态不一致。

证据：
- `MusePage.swift:187-191`：`timing = nextTiming; content = nextContent; ... rate(nextTiming, nextContent)`。
- `MusePage.swift:92-98`：`runMoreAction` 失败只走 `failed`，没有恢复 `timing/content`。
- `MusePage.swift:158`：撤销按钮是否显示取决于 `item.isRated`（服务端字段）。

建议：只在请求成功后更新本地选择，或在失败回调里把 `timing/content` 重置为 `item.timingOk/contentOk`；失败后强制重载并提示。

### 6. [低] 自动检查没有覆盖真实合同校验，且请求链路测试只在非 Linux 目标里
文件：`clients/apple/Package.swift:21-24,40`；`clients/apple/Tests/HimawariManageTests/MoreSettingsStoreTests.swift:46-129`；`clients/apple/Tests/HimawariCoreTests/SettingsMoreTests.swift:5-233`

问题：Core 测试验证了纯类型编码和部分反向判断，但仍然只是手写期望值，没有把生成的请求体交给 `contracts-v2.ts` 的实际校验器；`MoreSettingsStoreTests`（真正验证确认档位、`risk`、`authorizationRef`/payload 的链路）位于 `HimawariManageTests`，而 `Package.swift` 在 Linux 下把 interface targets 全部设为空，因此这些用例不会在 Linux 跑。SwiftUI 页面也没有编译或交互测试。

证据：
- `Package.swift:21-24`：`#if os(Linux) let interfaceTargets: [Target] = [] ...`。
- `Package.swift:40`：`HimawariManageTests` 只在非 Linux 分支定义。
- `SettingsMoreStoreTests.swift` 的确认、risk、payload 断言都依赖 `HimawariManage`。

建议：至少把合同可表达的请求体做成共享 fixture，在 TS 侧用 `parseGatewayV2Message`/对应 schema 校验一遍；在 Mac CI 或本地明确跑 `HimawariManageTests`；补 MCP 名称边界、未知推送 kind、翻页失败和 Muse 失败回滚用例。

### 7. [低] 作者“不改发给模型的任何内容”的说法不准确：个性化名称会进入模型上下文
文件：`packages/application/src/services/owner-profile-service.ts:385-408`；`packages/runtime-pi/src/pi-runtime-adapter.ts:644-662`；`.agents/instructions/prompt-prefix.md:27-28,34`

问题：本次新增的个性化页允许修改 owner `name`。这个值会被 `OwnerProfileService.compose` 写进 `owner-rules` 块，随后 `turnPrompt` 把它放进当前轮的 `<himawari-context>`，紧挨着 `<owner-message>`。因此它确实会改变模型看到的内容；只是它位于最后一条用户消息的尾部，不会改系统提示、工具定义或历史。若作者的意思是“diff 中没有改提示词组装代码”，那是对的；若理解为“模型看到的内容完全不变”，则不准确。

证据：
- `owner-profile-service.ts:389-408`：名称被拼成 `主人在设置里填写的称呼是「${name}」...` 并放入 `owner-rules` 块。
- `pi-runtime-adapter.ts:644-662`：`...blocks.map((block) => contextBlockContent(block, timeZone))` 放在 `<himawari-context>` 内，后面才是 `<owner-message>`。
- 规则要求固定内容在前、每轮变化内容只放在最后一条用户消息（`prompt-prefix.md:27-28`），已发出的内容只能追加（`:34`）。

建议：把作者说明改成“不改请求头部；个性化名称只影响本轮末尾追加的上下文块”；不要把该值迁移到系统提示。

**推测/未核实**

- Muse 快照的 `items` 合同没有数量上限，页面用非懒加载的 `VStack` + `ForEach` 一次布局全部条目；若服务端一次返回很多条，可能有主线程布局开销。是否实际有上限，未核实。
- 本机没有 Mac 编译环境，SwiftUI 视图的编译和交互行为未核实；作者也说明了这一点。
- `MoreSettingsStoreTests` 是否在某个非 Linux CI 上运行，未核实。

**侧重检查**

- 错误路径：搜索/个性化/MCP 的 409 会重载并提示；推送种类的 409 只走通用失败提示；敏感翻页失败完全静默；Muse 失败不回滚本地选择。以上均对照了 `runMoreAction`、各页面和 `MoreSettingsStore`。
- 不合规范/不可信输入：MCP 名称后端规则与客户端截断规则不一致；推送未知 kind 可被回写；搜索 recipients 客户端不校验，测试还固化了合同禁止的重复值；owner 名称未过滤控制符。
- 安全/隐私：敏感记录页只展示类别、出处类别和时间，不展示原文；Muse `withheld` 条目不展示 title/text；没有发现把秘密写日志的代码。服务端确认流程由 `ManageGateway.command` 按 `ClientCapabilities.requiredTier` 触发，`search.authorization.set` 还显式发送 `risk: high`。
- 不可撤销操作：MCP 撤销、Muse 清除、敏感记录清除都有 `confirmationDialog`，并且都走 `.change` 档位的确认挑战；后端 `sqlite-mcp-connection-operations.ts:228` 对已撤销连接直接拒绝后续修改，与文案“不能恢复”一致。
- 资源：`loadAll()` 同时发六个读请求；敏感记录服务端分页有页大小上限；Muse 列表没有分页，见上。
- 规则/文档一致性：`prompt-prefix.md` 的“只追加、变化值放末尾”没有被本次 diff 破坏；作者关于“模型内容完全不变”的表述需要修正。

**必答问题 1（请求开头是否改变）**

未改变。diff 没有触碰系统提示、工具定义、历史组装或遮盖代码。规则要求固定内容在前、变化内容只在最后一条消息（`prompt-prefix.md:27-28`），已发内容只能追加（`:34`）。唯一模型可见的新入口是 owner 名称：`owner-profile-service.ts:385-408` 把它写进 `owner-rules` 块，`pi-runtime-adapter.ts:644-662` 把该块放在当前轮 `<himawari-context>` 内、`<owner-message>` 之前，因此属于最后一条用户消息的尾部。系统提示/工具/历史/遮盖结果不变，仍然只在末尾追加；每轮会变的值仍在最后一条消息里。

**必答问题 2（同一段文字是否可能变成不同字节）**

没有发现新增的非确定性模型字节。所有新命令体最终都经 `ManageGateway` 的 `JSONEncoder`，使用 `.sortedKeys`（`ManageGateway.swift:158-159`）；数组如 `recipients`、`kinds` 按服务端快照顺序传递，不依赖 Set 遍历。没有把时间、日期或随机值写进模型可见内容；页面里的 `relative`、`dayAndTime`、`MuseDelay` 等只是 UI 展示。`expectedRevision` 会随数据变化，但只出现在设置命令里，不进入模型请求。

**必答问题 3（是否有自动检查，反向用例是否真的会失败）**

有，但覆盖不完整。`SettingsMoreTests` 覆盖了偏好无改动不发送、搜索未配置不能开启、MCP 同值/已撤销不能编辑、推送同状态不发送、Muse 必须两边同时有值或同时为空等反向判断；`MoreSettingsStoreTests` 覆盖了搜索高风险确认、推送关闭不需要确认、偏好保留未编辑字段、MCP 显式 null、敏感游标等。缺的是：没有用 `contracts-v2.ts` 的真实校验器验证客户端请求体；MCP 名称的 64 个“码位”和多码位字符/隐藏字符没有反向用例；推送未知 kind 的测试反而断言它会被列出；搜索测试用了合同禁止的重复 recipients；`MoreSettingsStoreTests` 在 Linux 目标中被排除；SwiftUI 页面未编译、无 UI 测试。因此关键反向用例不足以证明“手机端产生的值一定过后端校验”。

**必答问题 4（每个值产生处和使用处两端是否都能接受）**

- `MorePage`/`ManageDemoScreen`/`DemoScene` 的枚举值和路径：所有 switch 都覆盖，rawValue 未重复，`MorePageView` 覆盖全部 case，`SettingsRootView` 的 `.navigationDestination` 也覆盖 `.more`。可用。
- `OwnerPreferencesChange`：产生 `name/locale/accent/theme/modelRef/thinkingLevel/expectedRevision` 七个字段（`OwnerPreferences.swift:44-60`），合同 `contracts-v2.ts:557-560` 正好要求这七个；服务端 `production-owner-preferences-control.ts:63-74` 全量写入。空值按 null 发送、未编辑字段保留，均可接受。边界问题见第 1 条的控制字符。
- `McpConnectionChange`：客户端产生 `connectionId/name/capabilities/readCeiling/pushPolicy/status` 六个字段（`McpConnections.swift:97-108`），合同 `contracts-v2.ts:1381-1390` 接受；服务端把 null 解释为“不修改”（`production-mcp-connections-control.ts:243-263`），所以显式 null 是安全的。名称的字符规则不一致，见第 1 条。
- `SearchAuthorizationChange`：`expectedRevision/enabled/recipients`（`SearchAuthorization.swift:26-30`）与合同 `contracts-v2.ts:268-274` 一致；服务端 `public-search-authorization.ts:119-126` 在开启时要求 recipients 与当前值完全一致，客户端用快照里的当前 recipients，正常可过；但客户端不校验重复/格式，测试也不严，见第 3 条。
- `PushKindChange`：`kind/enabled` 与合同 `contracts-v2.ts:328-331` 一致；`kind` 来自 `listedKinds`，可能包含合同外的未知值，见第 2 条。
- `MuseRating`：`kind/naturalKey/timingOk/contentOk` 与合同 `contracts-v2.ts:1623-1630` 一致；服务端 `production-muse-intake-control.ts:146-165` 接受两边都为 null（撤销）或都非 null，客户端的 guard 与之一致。
- `MuseIntakeChange`：`paused` 与合同 `contracts-v2.ts:1632-1635` 一致。
- `SensitiveCursor`/`before`：客户端把服务端 `next` 原样编码成 `before`（`MoreStore.swift:110-114`），合同 `contracts-v2.ts:1641-1648` 接受 `{firstSeenAt,id}`；服务端 `sqlite-sensitive-interception-operations.ts:171-176` 校验精确时间和 64 位十六进制 id。快照与服务端一致。
- `SensitiveFilter` 的 rawValue（`masked/withheld/not_saved`）与合同 `contracts-v2.ts:1687` 一致。
- `McpConnections` 的 `ceilings/status` 常量、`OwnerLocale`、`PushStatus.knownKinds` 都与合同 `contracts-v2.ts:1281-1284,314-315,539` 一致；`McpLimit` 被解码但未使用，不构成错误。
- 仅供 UI 的 `recipientHosts`、`delayParts`、`relative` 时间等不进入请求体，不涉及后端校验。

总体结论：请求体字段名和主要可空语义与 `contracts-v2.ts` 对得上，确认档位也与 `Generated/ClientCapabilities.swift` 一致；本次没有提示词前缀风险。需要优先修的是 MCP 名称的两端字符规则不一致，其次是未知推送 kind 的回写、敏感翻页静默失败和 Muse 失败不回滚；自动检查应补上真实合同校验和 Mac 侧构建。
