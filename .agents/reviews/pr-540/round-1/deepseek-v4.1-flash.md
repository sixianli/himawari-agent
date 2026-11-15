### 1、高、fileMover 移走唯一的临时压缩包后，分享和再次保存仍指向旧 URL

**文件：** `clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:88-104`

**问题：** “存到文件”用 `fileMover` 处理同一个临时文件，完成后既不清空 `archive`，也不重新取回或保留副本；随后 `ShareLink` 和再次保存都使用已失效的 URL，且完成回调为空，移动失败也没有提示。

**读代码证实：**

```swift
ShareLink(item: archive) { ... }                       // 第 89 行
.fileMover(isPresented: $saving, file: archive) { _ in } // 第 104 行
do { archive = try await session.archiveFile(named: result.fileName) } catch { failed = true } // 第 102 行
```

`archive` 只在第 102 行赋值，成功后没有任何地方清空或更新；`onCompletion` 直接丢弃 `Result`。因此“先存到文件，再发到别处”时，`ShareLink` 仍拿旧文件 URL；“再存一次”也拿旧 URL。

**推测：** `fileMover` 的语义是移动而非复制（系统文档/常规行为），所以原 URL 在移动后失效。本机不能运行 Swift，未实测。

**建议：** 改用 `fileExporter` 复制，或 `fileMover` 完成时把 `archive` 清空并重新下载/重新生成；在 completion 里处理失败并提示，不要静默忽略。

### 2、中、下载失败后没有重试入口，两个按钮会一直不可用

**文件：** `clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:100-103`、`:39`、`:87`、`:94-97`

**问题：** 自动取回失败只把 `failed` 设为 `true`；`.task(id:)` 的 id 没变不会重跑，`archive` 仍为 `nil`，保存按钮一直禁用，分享按钮一直是禁用的占位按钮。提示文案是“没办成，再试一次”，但 alert 没有任何重试动作。

**读代码证实：**

```swift
.alert(M.actionFailed, isPresented: $failed) {}   // 第 39 行，空 action
...
.disabled(archive == nil)                          // 第 87 行
...
.task(id: result.downloadPath) {
    guard archive == nil else { return }
    do { archive = try await session.archiveFile(named: result.fileName) } catch { failed = true }
}
```

短暂断网或 404 后，用户只能退出页面再进来；页面内无法重试。

**推测：** 退出再进入页面会重新创建视图并重跑 `.task`，所以不是永久锁死，但错误路径没有闭环。

**建议：** alert 加“重试”按钮，或点击按钮时主动重试；也可以把尝试次数加入 `.task(id:)`。失败时最好显示具体原因，而不是只有通用“没办成”。

### 3、中、下载后不校验 `sha256`/`sizeBytes`，坏包会被当成成功保存/分享

**文件：** `clients/apple/Sources/HimawariManage/Settings/DataExport.swift:119-126`、`:8-9`；`apps/agent-service/src/production-data-export.ts:405-408`；`packages/gateway-contracts/src/contracts-v2.ts:1117-1118`

**问题：** 导出结果已经带了大小和 SHA-256，但 `archiveFile` 只拿到 `Data` 就直接写盘，不核对长度和摘要。服务端返回完整但损坏的内容、代理篡改、或极端情况下截断但未抛错的响应，都会被保存并分享给用户。

**读代码证实：**

```swift
public let sizeBytes: Int
public let sha256: String
...
let data = try await gateway.downloadArchive(exportId: exportId)
...
try data.write(to: url, options: .atomic)
```

服务端 `production-data-export.ts:407-408` 产生这两个字段，合约 `contracts-v2.ts:1117-1118` 也校验它们；客户端完全没用。

**推测：** `URLSession` 通常会对连接中断抛错，但“完整但内容错误”的情况不会被发现；`.atomic` 只保证不是半截文件，不保证内容正确。

**建议：** 写盘前比较 `data.count == result.sizeBytes`，并用 CryptoKit 计算 SHA-256 与 `result.sha256` 比较；不一致就报错且不留下文件。

### 4、中、临时导出包从不清理，敏感内容长期留在 temporaryDirectory

**文件：** `clients/apple/Sources/HimawariManage/Settings/DataExport.swift:122-126`；`clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:100-104`

**问题：** 每次进入 ready 页都会新建一个 UUID 目录并写一份完整导出包；视图消失、分享完成、保存完成之后都没有删除。导出包含记忆、规则、决策等私人内容，多个大文件会同时留在临时目录。

**读代码证实：**

```swift
let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
let url = directory.appendingPathComponent(URL(fileURLWithPath: fileName).lastPathComponent)
try data.write(to: url, options: .atomic)
return url
```

`archiveFile` 里没有 `removeItem`；页面也没有在 `onDisappear` 或 fileMover/ShareLink 完成后清理。由于 `SettingsStore.export` 会复用同一个 session，反复进入该页会反复下载、反复建目录。

**推测：** 系统可能最终清理 tmp，但时间和条件不确定；如果文件被移动到“文件”App，这一份会被移走，但只分享或只看不存的情况仍会留下。

**建议：** 在页面消失、保存/分享完成或取消失败时删除 UUID 目录；或者只保留一个固定临时文件并在下次覆盖。敏感导出建议显式设置文件保护等级（如 complete protection）。

### 5、中、整包下载到内存并在 MainActor 写盘，最大 512 MB 时会卡界面/吃内存

**文件：** `clients/apple/Sources/HimawariManage/Settings/DataExport.swift:45-47`、`:119-126`；`clients/apple/Sources/HimawariCore/HTTPExchange.swift:33-36`；`apps/agent-service/src/production-data-export.ts:39`

**问题：** `DataExportSession` 整个类标了 `@MainActor`，所以 `archiveFile` 的 `createDirectory` 和 `data.write` 都在主线程执行；同时下载结果以 `Data` 全量放进内存。服务端允许的导出包上限是 512 MB，最坏情况下会造成明显界面卡顿、内存峰值甚至被系统终止。

**读代码证实：**

```swift
@MainActor
@Observable
public final class DataExportSession {
...
let data = try await gateway.downloadArchive(exportId: exportId)
...
try data.write(to: url, options: .atomic)
```

`URLSessionExchange.send` 使用 `session.data(for:)` 返回完整 `Data`；服务端 `MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024`。

**推测：** 大多数导出远小于 512 MB，但客户端没有任何大小上限或流式处理，达到上限时问题会明显。

**建议：** 把文件写入放到非主 actor/后台任务；对大文件用下载流直接写盘；在客户端也检查 `result.sizeBytes` 的上限，或至少避免在主线程做磁盘写入。

### 6、低、自动检查只覆盖参数编码和 404 映射，未覆盖真实 URL、写文件、清理和 UI 反向

**文件：** `clients/apple/Tests/HimawariManageTests/ManageGatewayTests.swift:61-81`；`clients/apple/Tests/HimawariManageTests/DataExportSessionTests.swift`；`clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:100-104`

**问题：** 新测试只验证了 `ManageGateway` 传给 `DeviceTransport` 的 path/query，以及 404 被包成 `ManageGatewayError.rejected`。`RecordingTransport` 在 `DeviceHTTPClient` 之前截获参数，绕过了真正的 `DeviceHTTPClient.encode` 和 URL 构造；测试还断言 query 里的冒号是原始字符，而真实实现会编码成 `%3A`。没有 `archiveFile` 的临时目录/文件名/写入失败测试，也没有 UI 按钮状态、重试、fileMover 后过期 URL、校验和测试。

**读代码证实：**

```swift
let line = path + (query.isEmpty ? "" : "?" + query.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&"))
...
XCTAssertEqual(downloads, ["data-export/archive?exportId=data-export:AAAAAAAAAAAAAAAAAAAAAA"])
```

真实 `DeviceHTTPClient.encode` 使用 `alphanumerics + "-._~"`，冒号会变成 `%3A`，所以该断言没有覆盖实际发出去的请求。404 反向用例本身是有效的：如果 `fetch` 吞掉非 2xx，`XCTFail` 会触发。

**推测：** 由于这套测试在 `ManageGateway` 层截获，路径/查询的最终编码、签名目标和真实 URL 都没有被验证。

**建议：** 增加 `DeviceHTTPClient` 层测试，断言最终 `URLRequest` 的 `percentEncodedPath`/`percentEncodedQuery`；增加 `SignedDeviceTransport.download` 的 GET + 错误映射测试；增加 `archiveFile` 的成功、写入失败、文件名清洗、校验和不匹配、清理测试；UI 层至少覆盖下载失败后的重试和 fileMover 完成后的状态。

### 7、低、`downloadFile` 把斜杠编码成 `%2F`，但服务端白名单明确拒绝 `%2F`，带斜杠的文件编号必然 404

**文件：** `clients/apple/Sources/HimawariManage/Gateway/ManageGateway.swift:87-94`；`packages/platform-node/src/device-api-routes.ts:74`；`test/integration/device-download.test.ts:166-167`；`clients/apple/Tests/HimawariManageTests/ManageGatewayTests.swift:61-67`

**问题：** 客户端把 `/` 编码成 `%2F`，服务端 `FILE_ID_SEGMENT` 只允许 `%3A`/`%3a`，测试也确认 `/api/device/v1/files/content/a%2Fb` 返回 404。也就是说测试里 `"thread-artifact:ab/cd"` 这种输入在真实服务端一定失败；`downloadFile` 目前又没有生产调用方，测试只证明了一个不可达用例。

**读代码证实：**

```swift
var allowed = CharacterSet.urlPathAllowed
allowed.remove(charactersIn: ":/")
...
XCTAssertEqual(downloads, ["files/content/thread-artifact%3Aab%2Fcd"])
```

```ts
const FILE_ID_SEGMENT = "[A-Za-z0-9](?:[A-Za-z0-9._:-]|%3[Aa]){0,127}";
...
const slash = await get(h, client, "/api/device/v1/files/content/a%2Fb");
expect(slash.statusCode, slash.body).toBe(404);
```

生产文件编号实际是 `thread-artifact:<uuid>`，不含斜杠，所以当前用户路径不受影响；但这段 API 和测试没有形成“两端都接受”的闭环。

**建议：** 如果文件编号不允许斜杠，客户端应在发请求前直接拒绝并给出明确错误，而不是编码成服务端必然拒绝的 `%2F`；测试改用真实格式 `thread-artifact:<uuid>`，并加断言验证最终 URL 和 `%3A`。如果将来允许斜杠，则需要先改服务端白名单和路由解析。

### 8、低、演示用 ready 状态注入 `exportId="demo"` 后，页面 `.task` 会走 `follow()` 并转成 failed

**文件：** `clients/apple/Sources/HimawariManage/Settings/DataExport.swift:60-65`；`clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:36-37`；`clients/apple/Sources/HimawariManage/ManageDemo.swift:75`、`:148`

**问题：** 新增的 `if case .ready = stage { exportId = "demo" }` 让演示用 ready session 也有 exportId；但 `DataExportPage` 的 `.task` 发现 stage 不是 idle，就调用 `follow()`，向 `DemoTransport` 请求 `data.export.status.read`。`DemoTransport` 的默认回答是 `"{}"`，解码 `Snapshot<DataExportStatus>` 失败，随后把 stage 改成 `.failed`。因此真实运行中的演示/预览 ready 页会从 ready 闪成失败，除非截图工具根本不执行 `.task`。

**读代码证实：**

```swift
if case .ready = stage { exportId = "demo" }   // DataExport.swift:64
...
if session.stage == .idle { await session.start(...) } else { await session.follow() } // DataExportPage.swift:37
...
default: "{}"                                   // ManageDemo.swift:148
```

`follow()` 中解码失败会落到 `catch { stage = .failed; return }`。

**建议：** 给 `DemoTransport` 补一个合法的 `data.export.status.read` 快照；或者给 fixed 演示初始化加一个不启用 `follow()` 的标记。若截图工具不跑 task，也建议修掉，避免调试和视觉回归时行为不一致。

### 9、低、设计文档说设备不能发起导出，但代码允许 `data.export.start`，本 PR 还把入口放出来了

**文件：** `docs/execution/specs/2026-11-11-apple-device-body-design.md:235`；`packages/gateway-contracts/src/client-capabilities.ts:207`；`clients/apple/Sources/HimawariManage/SettingsRootView.swift:52`、`:69`；`clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:36-37`

**问题：** 规范写“设备接口里没有……发起导出……设备只能下载已经做好的导出包，不能发起导出”；但 capability 表把 `data.export.start` 登记为 `change`（设备可用、需面容），本 PR 打开入口后，页面一打开就会走已有代码 `data.export.start`。这不是新下载逻辑的安全问题，但“文档说的行为”和“用户可见行为”不一致，发布前应澄清是规范过时还是入口不该放。

**读代码证实：**

```ts
change("v2", "data.export.start"),   // client-capabilities.ts:207
```

```swift
static let exportDownloadAvailable = true   // SettingsRootView.swift:52
...
if Self.exportDownloadAvailable { ... path.append(.export) } // 第 69 行
```

`DataExportPage` 第 36-37 行在 idle 时调用 `session.start`，而 `start` 会发 `data.export.start`（`DataExport.swift:67-77`）。

**建议：** 更新规范，明确设备可以用面容确认后发起导出；或者如果规范仍是产品意图，就不要放出该入口，改为只允许下载网页已生成的导出包。

**作者说法核对**

- “打包好后自动取回（task id 是 `downloadPath`）”：属实，`DataExportPage.swift:100` 用 `result.downloadPath` 作为 task id。
- “取回前两个按钮不可点”：属实，保存按钮第 87 行按 `archive == nil` 禁用，分享按钮拿不到 `archive` 时渲染禁用占位。
- “失败弹出‘没办成’提示”：属实，第 39 行用 `M.actionFailed`；文案在 `ManageStrings.swift:110` 是“没办成，再试一次”。但没有重试动作，见意见 2。
- “临时文件在 temporaryDirectory 下 UUID 目录，文件名为 fileName 最后一段”：属实，`DataExport.swift:122-124`。
- “本 PR 不改服务端”：属实，diff 只改 `clients/apple`、截图和复核材料。
- “文件列表里‘点开文件’入口不在本 PR”：属实；`downloadFile` 只有测试调用，没有生产调用方。
- “DeviceTransport 新增 download，默认 501，真实实现走 GET”：属实，`DeviceTransport.swift:24-31`、`:63-66`。
- “冒号和斜杠百分号编码；服务端只放行 `%3A`，`%2F` 返回 404”：客户端和服务端代码都属实，但这导致带斜杠的编号必然失败，见意见 7。
- “只做读，不过面容”：新增的下载路径确实没有 `confirmSigner`（`DeviceTransport.swift:63-73`）；但把入口放出后，页面打开会走已有的 `data.export.start`，这是 `change` 级、需要面容的命令。因此“新增下载只读”成立，“整个入口只做读”不准确。
- “swift test 全过、iOS 和 Mac 编译通过”：未核实；本环境不能编译或运行 Swift 测试。

**侧重检查**

- **错误路径：** 404 会被 `fetch` 转成 `ManageGatewayError.rejected`，默认 `501` 也会进入失败分支；下载失败有 alert，但无重试（意见 2）。`fileMover` 的失败回调被丢弃（意见 1）。截断/损坏内容没有校验（意见 3）。
- **不合规范或不可信输入：** 服务端 `fileName` 固定为 `himawari-export-YYYY-MM-DD.zip`（`production-data-export.ts:333`），客户端用 `lastPathComponent` 去掉目录，未发现路径穿越；`fileId` 走百分号编码；`exportId` 由 `DeviceHTTPClient.encode` 编码，服务端用 `URLSearchParams` 解码后又按 `DATA_EXPORT_ID_PATTERN` 校验。`downloadPath` 只当 SwiftUI task id，没有直接当 URL 使用，未发现 SSRF。`downloadFile` 的 `%2F` 与服务端白名单不一致（意见 7）。
- **安全：** 新增操作是设备签名 GET，不要求确认签名，符合“下载不过面容”的约束；没有新增服务端写操作。主要风险是导出的私人数据长期留在 tmp 且没有显式文件保护/清理（意见 4），以及不校验完整性（意见 3）。
- **资源耗尽：** 整包 `Data` 进内存，`DataExportSession` 是 `@MainActor`，写入也在主线程；服务端允许最大 512 MB（意见 5）。反复进入 ready 页会重复下载和重复建临时目录（意见 4）。
- **不可撤销操作：** 服务端没有不可撤销的写操作；本地 `fileMover` 会把临时包移出 app，之后无法再分享或再次保存（意见 1）。
- **规则/文档一致：** 追加式提示规则未被触碰；但设备导出设计文档和 `data.export.start` capability/入口存在文字与行为的冲突（意见 9）。本 PR 没有更新任何用户说明文档，作者已注明 Docs deferred。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。diff 只涉及 Apple 客户端的导出页面、设备传输和测试，没有改 `packages/prompt-catalog`、运行时提示组装、工具定义、历史或遮盖逻辑（`git diff --stat` 可证）。因此系统提示、工具定义、历史消息和遮盖结果都不变；发给模型的内容仍然只在末尾追加。每轮会变的值也没有被加进请求头：`exportId`、`fileName`、`expiresAt`、`downloadPath` 都是设备接口响应，不进入模型请求。依据 `.agents/instructions/prompt-prefix.md:34`（规则 4）。
2. **会不会让同一段文字在不同请求里变成不同的字节？** 对模型请求没有影响。对新增的设备 HTTP 请求，路径和查询是确定性的：`archivePath`/`fileContentPath` 是常量，`exportId` 和 `fileId` 用固定字符集编码，查询只有一个 `exportId`，临时 UUID 只用于本地路径，不会发到服务器。需要注意的两点：设备签名本来就会给每个请求带新的 `created`/`nonce`（现有 `DeviceHTTPClient` 设计，不是本 PR 引入的内容漂移）；新测试断言的是原始冒号，而真实实现会编码成 `%3A`，所以“测试里的字节”和“实际发出去的字节”不一致（意见 6）。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 部分有。新增测试覆盖了 `downloadFile` 的冒号/斜杠编码、`downloadArchive` 的 exportId 查询，以及 404 被转成 `ManageGatewayError.rejected`；其中 404 用例如果 `fetch` 吞掉非 2xx 会由 `XCTFail` 失败，属于有效反向用例。编码用例如果去掉编码也会失败。但缺少：真实 `DeviceHTTPClient`/`SignedDeviceTransport.download` 的最终 URL 和 GET 测试、`archiveFile` 写盘/文件名/失败/清理测试、校验和测试、UI 重试和 fileMover 后状态测试、`%2F` 反向用例（服务端 PR 538 已有，但不在本 diff）。所以“反向用例真的会失败”只对现有 404 用例成立，覆盖面不足。
4. **改动产生或修改的每个值，两端都能接受吗？** 逐项核对：
   - `archivePath = "data-export/archive"`：客户端拼成 `/api/device/v1/data-export/archive`，服务端有 `GET` 路由（`device-api-routes.ts:103`、`:779`），通过。
   - `fileContentPath = "files/content/"`：客户端拼成 `/api/device/v1/files/content/{fileId}`，服务端有对应路由（`:104`、`:797`），通过。
   - `fileId` 百分号编码：生产格式 `thread-artifact:<uuid>` 编码为 `%3A`，服务端 `FILE_ID_SEGMENT` 允许 `%3A`（`:74`），通过；带 `/` 的编号会编码为 `%2F`，服务端明确拒绝并返回 404，不是两端都接受（意见 7）。`downloadFile` 目前没有生产调用方。
   - `exportId` 查询参数：客户端 `DeviceHTTPClient.encode` 会把 `:` 编成 `%3A`，服务端 `URLSearchParams` 解码后匹配 `DATA_EXPORT_ID_PATTERN`（`contracts-v2.ts:1085`、`device-api-routes.ts:782-790`），代码推理通过；但没有真实网络层测试，标为“代码推理通过，实际 wire 未核实”。
   - `downloadPath`：服务端合约保证是 `/api/data-export/v1/archive?...`（`contracts-v2.ts:1148-1158`），客户端只把它当 `.task(id:)`，不直接请求，未发现 SSRF；但没有验证它和当前 `exportId` 一致。
   - `fileName`：服务端固定生成 `himawari-export-YYYY-MM-DD.zip`（`production-data-export.ts:333`），客户端取 `lastPathComponent` 后写本地文件；服务端合约限制 128 字符，客户端没有长度检查，但生产输入安全。路径穿越已被 `lastPathComponent` 挡住。
   - `sha256`/`sizeBytes`：服务端产生并校验（`contracts-v2.ts:1117-1118`），客户端完全没有使用，完整性检查缺失（意见 3）。
   - `exportId = "demo"`：只在 `#if DEBUG` 的 `ManageDemo` 使用，配合 `DemoTransport.download` 返回 200；但会让演示 ready 页的 `follow()` 失败（意见 8），不影响生产。
   - 本地 `archive` URL：由 `archiveFile` 产生，被 `ShareLink` 和 `fileMover` 使用；`fileMover` 移动后 URL 失效，使用端不匹配（意见 1）。
   依据 I-73 的教训（`docs/incidents-and-gates.md:112`），这里确实发现了一个“产生端能产生、使用端不接受/不匹配”的值：`downloadFile` 产生的 `%2F` 路径，以及 fileMover 移动后的旧 URL。
