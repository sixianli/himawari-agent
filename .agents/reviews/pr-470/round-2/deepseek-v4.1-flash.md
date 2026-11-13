说明：上一轮的 `judgments.md` 因访问限制未能读到，以下结论全部按当前提交的代码独立核对；只用了允许的读文件和 git 命令。

## 一、读代码证实的问题（按严重度）

### 1. 中：开关关了又开时，第一次基线的游标仍可能被在途任务写回，导致补读“关着的那段”消息
- 文件:行：`clients/apple/Sources/HimawariMacUI/MessagesDatabase.swift:163-179`，`clients/apple/Sources/HimawariCore/MacAccess.swift:89-94`
- 问题：作者说“开关关了又开后在途的上传写不回旧位置”，但基线写入的 expected 是 `nil`；关掉再打开后当前值也是 `nil`，等式成立，旧任务仍能成功写入。
- 证据：
  ```swift
  // MessagesDatabase.swift:163
  let saved = settings.settings.messagesAfterRow
  // :175-179
  guard let saved else {
      settings.moveMessagesCursor(from: nil, to: batch.newest)
      settings.reportMessages(nil)
      return
  }
  ```
  ```swift
  // MacAccess.swift:90-94
  public mutating func moveMessagesCursor(from expected: Int64?, to row: Int64) -> Bool {
      guard seesMessages, messagesAfterRow == expected else { return false }
      messagesAfterRow = row
      return true
  }
  ```
  测试 `MessageSensingTests.swift:61-73` 只覆盖了 expected 非 nil 的情况，没有覆盖 nil→nil 的旧基线。
- 建议：给开关加一个不持久化的 generation/epoch，`setSeesMessages` 每次变化时递增；传感器在异步读之前记下 epoch，`moveMessagesCursor` 必须同时匹配 epoch。或者把基线写入改成带令牌的 CAS。

### 2. 中：面板动作在 `refresh()` 之前就释放 `acting`，且成功后清掉 requestId，刷新窗口内的第二次点击会生成新 requestId，可能重复执行有后果的动作
- 文件:行：`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:127-136`，`clients/apple/Sources/HimawariMacUI/PanelView.swift:88`
- 问题：第 1 轮是 `defer { acting = nil }`，`acting` 会一直保持到 `await refresh()` 完成；本次改成先 `acting = nil` 再 `await refresh()`。按钮的 `.disabled(model.acting == item.key)` 因此在刷新期间重新可用，而成功的 `actionRequestIds[key]` 已被清空，同一条目同一动作会拿到新的 requestId。
- 证据：
  ```swift
  // MenuBarModel.swift:128-135
  do {
      try await app.api.act(on: item, action: action, requestId: requestId)
      actionRequestIds[key] = nil
  } catch {
      failedItem = item.key
  }
  acting = nil
  await refresh()
  ```
  ```swift
  // PanelView.swift:88
  .disabled(model.acting == item.key)
  ```
- 建议：把 `acting = nil` 放回 `defer` 或放在 `await refresh()` 之后；成功时不要立刻释放 requestId，至少等刷新确认该条目已消失，或为每个 key 维护“已成功/进行中”状态，保证同一条目+动作只执行一次。

### 3. 中：`canStop` 依赖的 `work` 在整个仓库里从未被赋值，生产环境里“停下”按钮会永久消失
- 文件:行：`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:38,114-118`
- 问题：`canStop = work != nil || demoShowsStop`，但全仓库搜索 `MacWorkControl` 只有协议声明和 `weak var work`，没有任何赋值；`demoShowsStop` 只在 demo 初始化里为 true。因此真实 App 中 `canStop` 恒为 false，`PanelView` 中正在运行工作的“停下”按钮不再显示。改动前按钮至少一直显示（虽然 `work` 为 nil 时点击无效）。
- 证据：
  ```swift
  // MenuBarModel.swift:38
  @ObservationIgnored weak var work: MacWorkControl?
  // :114
  var canStop: Bool { work != nil || demoShowsStop }
  ```
  `MenuBarController` 初始化 `MenuBarModel` 后没有设置 `model.work`。
- 建议：把 `MacWorkControl` 真正接上（由能停止本机工作的对象设置 `model.work`），或在未接线前不要用 `canStop` 直接隐藏按钮；至少保留一个明确的“不可用”状态并加测试。

### 4. 中低：关掉短信开关时，已经开始读的整批记录仍会被 POST；“关掉就停”只阻止了游标前移，没有阻止上传
- 文件:行：`clients/apple/Sources/HimawariMacUI/MessagesDatabase.swift:162-193`
- 问题：`while settings.settings.seesMessages` 只在每轮循环开头检查。数据库读完成后、上传之前没有再检查开关；用户在这段时间关掉开关，`perceiveSkippingInvalid` 仍会执行，只是最后的 `moveMessagesCursor` 因 `seesMessages == false` 失败。作者/README 说的“关掉就停”在这一段不成立。
- 证据：
  ```swift
  // :184-190
  let records = batch.rows.compactMap(MessageSensing.record)
  if !records.isEmpty {
      do {
          _ = try await app.api.perceiveSkippingInvalid(records)
      } catch {
  ```
  上传前没有 `guard settings.settings.seesMessages`，游标检查在 `:193` 才发生。
- 建议：在 `Task.detached` 返回后、上传前重新核对开关和 generation；关掉后直接丢弃本批，不发网络请求。

### 5. 低：拖入多个文件时附件顺序取决于异步完成顺序，同一组文件可能生成不同字节的用户消息
- 文件:行：`clients/apple/Sources/HimawariMacUI/InputBarView.swift:117-124`，`clients/apple/Sources/HimawariMacUI/InputBarModel.swift:50-60`
- 问题：`loadFiles` 对每个 `NSItemProvider` 单独回调，每次回调再单独调用 `model.add(files:)`；`add(files:)` 又为每一批启动 `Task.detached`。最终 `pieces`/附件标签的顺序由完成先后决定，不是用户拖入顺序。两次相同的拖入可能产生不同顺序的 `<file .../>` 标签，属于“无序集合导致同一段文字字节不同”的风险。它不影响已发出的请求开头，但影响新消息本身的确定性。
- 证据：
  ```swift
  // InputBarView.swift:118-122
  for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      _ = provider.loadObject(ofClass: URL.self) { url, _ in
          guard let url else { return }
          Task { @MainActor in deliver([url]) }
      }
  }
  ```
  ```swift
  // InputBarModel.swift:55-59
  let added = await Task.detached(priority: .userInitiated) {
      files.map { ContextGathering.filePiece($0, source: .droppedFile, reading: ContextReader.read($0)) }
  }.value
  guard started == session else { return }
  add(pieces: added)
  ```
- 建议：保留 `NSItemProvider` 的原始顺序（带索引收集，全部完成后按索引排序合并），或在一次 `add` 里按输入顺序串行读取并一次性合并。

### 6. 低：每个批次都重新打开数据库、重新查 schema 和 newest；`saved != nil` 时 `newest` 实际未被使用
- 文件:行：`clients/apple/Sources/HimawariMacUI/MessagesDatabase.swift:30-37`
- 问题：`batch` 每次都 `MessagesDatabase()`、`schema()`、`newestRow()`，而 `MessagesSensor` 只在 `saved == nil` 的基线路径使用 `batch.newest`。消息多时会做很多多余的打开/PRAGMA/MAX 查询。
- 证据：
  ```swift
  static func batch(after row: Int64?, limit: Int) throws -> Batch {
      let database = try MessagesDatabase()
      let schema = try database.schema()
      ...
      let newest = try database.newestRow(schema)
  ```
- 建议：一次 tick 复用同一个连接和 schema；只在 `row == nil` 时计算 `newest`。

## 二、未核实 / 推测

### 1. 高（未核实）：`captureSource = "system_api"` 不在设计文档列出的采集来源里，若服务端按清单校验，所有短信记录会被 400 拒绝并永久卡住
- 文件:行：`clients/apple/Sources/HimawariCore/MessageSensing.swift:44-45`
- 证据：客户端固定写 `public static let captureSource = "system_api"`。设计文档只说明来源包括设备麦克风、AirPods、随身麦克风（`docs/execution/specs/2026-11-11-apple-device-body-design.md:163,310`），当前仓库里找不到 `system_api` 的登记或校验代码。
- 影响：如果服务端不认这个来源，整批 400 → `perceiveSkippingInvalid` 抛 `allRejected` → `MessagesSensor` 报 `.cannotSend` 且不前移游标，等于短信功能完全不可用，而且每轮心跳重试同一批。
- 建议：确认服务端采集来源清单并登记 `system_api`，或改用清单里已有的值；加一条真实路由的集成测试，覆盖“来源被拒”和“来源通过”。

### 2. 未核实：`POST perception`、`POST attachments`、`/home/act` 等设备接口的服务端实现不在本次提交的代码树里
- 证据：本提交的 `apps/agent-service/src` 目录列表没有 perception 相关文件，`test/integration` 也没有 `perception-records.test.ts`；只在 `packages/gateway-contracts/src/contracts-v2.ts:520` 看到 `device.perception.batch_records` 这个上限键。基础提交里已经有客户端 `DeviceAPI`，因此这可能是服务端在别处/别的仓库，不能据此断定是本 PR 的缺陷。
- 影响：无法核对 record id、`captureSource`、`evidence`、`occurredAt`、附件 requestId 是否真的能通过后端校验；也无法确认 400/5xx 语义与客户端一致。
- 建议：在服务端接口落地后补一条真正走 HTTP 的集成测试，至少覆盖 id 正则、ISO 时间、evidence 允许的键、文本/发件人长度、附件 requestId 正则和重复上传去重。

### 3. 推测：`TypedStreamText` 对任意 blob 的启发式识别可能把二进制中的偶然字节当成文字
- 文件:行：`clients/apple/Sources/HimawariCore/TypedStreamText.swift:9-18`
- 说明：它先找 `streamtyped`、再找类名、再在 16 字节窗口内找 `[0x84,0x01,0x2B]`，最后按长度取 UTF-8。边界检查是完整的（测试也覆盖了截断/非法数据），不会越界崩溃；但对“不是 NSArchiver 格式、恰好包含这些标记”的 blob，可能解析出一段看似文字的内容。数据源是本地 chat.db，风险低于外部输入，仍建议把“成功解析”限制在头部结构更严格的范围内，或对可疑 blob 直接跳过。

## 三、侧重检查

- **错误路径**：核对 `perceiveSkippingInvalid` 的整批 400、逐条 400、部分成功、单条 400、5xx/网络错误；`MessagesSensor` 只会对非 400 错误不前移，`allRejected` 也不前移。测试覆盖 400/503，但没有覆盖“逐条重发过程中某个非 400 错误”和开关关闭时的在途上传。
- **不合规范/不可信输入**：`MessagesSchema` 用 `PRAGMA table_info`，查询列名来自固定白名单，不存在 SQL 注入；`TypedStreamText` 的长度和切片边界已检查；`utf16Prefix` 不会把 emoji 切成半个；路径策略覆盖了 `..`、符号链接、`Docs`/`Docs-old` 前缀混淆和“最近授权优先”。未发现新的越界或崩溃路径。
- **安全**：chat.db 以 `SQLITE_OPEN_READONLY` 打开；`attributedBody` 不再用 `NSUnarchiver`；路径测试证明符号链接和 `..` 不能逃出授权目录。隐私上的两个缺口是上面的“关掉后仍在途上传”和“nil 基线回写导致补读关着那段”。
- **资源耗尽**：单文件 `PlainTextFile.readLimitBytes = 8MB`，每批条数来自服务端上限；但每个批次重新打开 SQLite、拖入多个文件时并发读取，存在可优化的资源开销。
- **不可撤销操作**：面板动作的重复 requestId 问题（第 2 条）和 `work` 未接线导致无法停止（第 3 条）是主要风险。
- **规则/文档一致性**：README 说“关掉就停”与代码在途上传行为不完全一致；“发送出去的消息不带对方号码当发件人”与代码一致；“路径先解符号链接和 `..`”与 `PathPolicy` 一致；“captureSource = system_api”没有文档依据。

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？**
本 PR 是 Mac 客户端改动，不修改服务端的系统提示、工具定义、历史或遮盖。客户端发出的新内容只是在末尾追加一条新的用户消息：`MessageAttachments.compose` 把附件标签接在正文后面（`MessageAttachments.swift:42-44`）；前台 App、选中文字、拖入文件都只进入这条新消息。感知记录走独立的 `POST perception`，按 ADR 0230 不拼进对话。因此就本 diff 而言，**仍然是只在末尾追加，每轮会变的值都在新的最后一条用户消息里**。服务端如何组装 prompt 不在本提交范围内，未核实。

**2. 同一段文字会不会在不同请求里变成不同字节？**
感知记录这边基本固定：`perceive` 加了 `.sortedKeys`（`MessageSensing.swift:134-136`），记录按 ROWID 顺序，`occurredAt` 来自数据库日期、不是当前时间，`id` 来自 guid 哈希。聊天消息这边，正文和标签的顺序取决于 `pieces` 顺序；但拖入多个文件时 `loadFiles` + `add(files:)` 的完成顺序不确定（第 5 条），所以同一组文件可能生成不同顺序的标签字节。附件 `ref` 由服务端按 requestId 生成，客户端在同一批附件未变时复用 requestId；服务端是否保证同一 requestId 返回同一 ref 不在本仓库，未核实。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有，但只覆盖核心层：
- `MacInputTests.swift:100-108` 覆盖附件数量上限；`:131-166` 覆盖 `..`、符号链接和最近授权；`:206-221` 覆盖 URL 规则；`:261-292` 覆盖附件 requestId 正则和标签格式。
- `MessageSensingTests.swift:49-98` 覆盖开关清游标、旧的 expected 写入失败、序列化/重启；`:84-92` 覆盖整批都被拒；`:100-123` 覆盖部分跳过和 5xx 不前移。
- `TypedStreamTextTests.swift:35-48` 覆盖截断、错长度、非法 UTF-8 不崩溃。
- `dangerously` 的 fixture 检查在 `test/tooling/apple-attachment-fixture.test.ts`，并已加入 `check:apple-design`。

缺口：`HimawariMacUI` 没有测试目标，`InputBarModel`、`MenuBarModel`、`MessagesSensor` 的会话计数、requestId 复用、`canStop`、拖入顺序都没有自动反向用例；第 1 条的 nil 基线竞态没有任何测试能发现（现有测试只覆盖 expected 非 nil）。所以“UI 改动有对应自动检查”这一条不成立。

**4. 改动产生/修改的每个值，使用它的地方都能接受吗？**
客户端侧能核对的部分是匹配的：
- 感知 id：`perception:` + 24 字节 SHA-256 前缀的 base64url，共 32 个字符，匹配 `^perception:[A-Za-z0-9_-]{16,64}$`；有测试。
- `occurredAt`：ISO 8601、含毫秒、UTC；有测试。
- `evidence`：只写 `service`/`direction`，仅 incoming 写 `sender`；sender ≤128、text ≤32×1024 UTF-16；有测试。
- 附件 requestId：`OutgoingMessage.newId()` 为 22 字符，再拼 `-index`，在 `[A-Za-z0-9_-]{16,64}` 内；有测试。
- 配置键 `device.perception.batch_records` 在 `packages/gateway-contracts/src/contracts-v2.ts:520` 登记。
- `panel.actionFailed` 在 en/ja/zh-Hans 三个 `Localizable.strings` 都已添加，`PanelView.swift:92-95` 使用。
- `messagesAfterRow` 是可选的 Int64，旧设置文件可解码，单元测试覆盖了重启和旧文件。

不能确认的部分：
- `captureSource = "system_api"` 找不到服务端清单/校验代码，存在“记录全部 400、游标永不前移”的高风险。
- 本提交里没有 `POST perception` / `attachments` 的服务端实现，上述 id、evidence、时间和 requestId 是否真的能过服务端校验，未核实。
- `URLPolicy` 只有测试，没有生产调用方；它是否在后续批次被正确使用未核实。

总体结论：第 1 条的游标竞态和第 2 条的动作重复是本次增量最值得修的两个问题；第 3、4 条是明显的体验/隐私缺口；`captureSource` 和服务端契约需要端到端确认，不能只靠客户端测试。
