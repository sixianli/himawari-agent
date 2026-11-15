## 查过范围

- PR 540 自身改动：`git diff 3800398f..9d13c64c` 共 10 个文件，集中在 `clients/apple/Sources/HimawariManage`、`HimawariManageTests` 和 `docs/execution/specs/2026-11-11-apple-device-body-design.md`。
- 增量 `git diff d48ae4ae..9d13c64c`：对上面这些 PR 540 文件**输出为空**。`d48ae4ae` 之后只有 `0fc5d47bf`（复核记录）、`fa8457aca`（合并 main）和 `9d13c64c`（合并 main），没有任何再改 PR 540 代码的提交。也就是说，上一轮意见 1 所说的“已修改”在 9d13c64c 上没有对应代码变化。
- 读了服务端直接使用端：`device-api-routes.ts` 的 `data-export/archive`、`files/content/{fileId}` 路由与 `FILE_ID_SEGMENT`，`http-gateway-server.ts` 的 `rejectNotAllowed`（404），`production-data-export.ts` 的 `deviceExportArchive`/`downloadPath`，以及 `test/integration/device-download.test.ts`。
- 读了规则与规格：`.agents/instructions/prompt-prefix.md`、`docs/incidents-and-gates.md` 的 I-73、`docs/execution/specs/2026-11-11-apple-device-body-design.md:232,718`。
- `.agents/reviews/pr-540/round-3/*` 被仓库钩子以 `REVIEW_GIT_REFUSED records-path` 拒绝读取，因此上一轮原文只能采用任务里给出的摘要；本轮结论以代码为准。
- 本环境没有 Swift 工具链，`swift test`、iOS/Mac 编译均未核实；以下结论不依赖编译结果。

## 意见

### 1、中低、保存成功后仍会自动重下，重新取回失败会把已成功的保存报成“没能下载”

文件: `clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:108-120`

问题: 上一轮意见 1 在 `9d13c64c` 上仍然成立。`fileMover` 成功后先删旧临时目录、把 `archive` 置空，然后立刻 `Task { await fetchArchive(result) }` 再取一次；这次取回只要不是 404，就会把 `downloadFailed` 置为 `true`，页面从已保存状态变成“没能下载”。404 还会把 `stage` 改成 `.expired`。用户明明已经存到“文件”，却被告知下载失败。

证据:
```swift
.fileMover(isPresented: $saving, file: archive) { outcome in
    guard case .success = outcome else { return }
    if let moved = archive { try? FileManager.default.removeItem(at: moved.deletingLastPathComponent()) }
    archive = nil
    Task { await fetchArchive(result) }
}
...
private func fetchArchive(_ result: DataExportResult) async {
    guard archive == nil else { return }
    downloadFailed = false
    do { archive = try await session.archiveFile(named: result.fileName) } catch { downloadFailed = true }
}
```
`d48ae4ae` 只加了 `removeItem` 这一行，没有改随后的重新取回；`d48ae4ae..9d13c64c` 对 `DataExportPage.swift` 也没有后续改动。

建议: 保存成功后不要自动重下，直接显示“已保存”状态；若还要支持保存后再分享，改成用户点“发到别处”时再懒加载，并把“已保存”和“下载失败”分成两个独立状态，后一次失败不能覆盖已保存结果。补一个“保存成功随后重下失败”的用例。

### 2、中低、保存后反而在临时目录留下新的导出副本，分享或返回时也不清理

文件: `clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:110-112`、`clients/apple/Sources/HimawariManage/Settings/DataExport.swift:129-133`

问题: 只有 `fileMover` 成功时才删除旧目录；随后又立刻重新下载，在 `temporaryDirectory` 下新建一个 UUID 目录并写入整份导出包。用户保存成功后离开页面，这份新副本不会被删除；用 `ShareLink` 分享后离开、或下载成功后直接返回，也同样不清理。重复进入页面、重复保存会不断累积敏感导出包，既占空间也是隐私问题。

证据:
```swift
if let moved = archive { try? FileManager.default.removeItem(at: moved.deletingLastPathComponent()) }
archive = nil
Task { await fetchArchive(result) }
```
```swift
let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
let url = directory.appendingPathComponent(URL(fileURLWithPath: fileName).lastPathComponent)
try data.write(to: url, options: .atomic)
```
在 `HimawariManage` 里搜索 `removeItem`/`temporaryDirectory`，只有这两处；没有 `onDisappear` 或会话结束时清理。

建议: 保存成功后不再重下；在页面消失、`stage` 变化或会话结束时删除临时目录；同一时间只保留一个临时文件，并防止并发取回产生多个孤儿目录。

### 3、低、下载结果没有用服务端已给的 `sha256`/`sizeBytes` 校验，整包先读进内存

文件: `clients/apple/Sources/HimawariManage/Settings/DataExport.swift:120-133`

问题: `DataExportResult` 带了 `sha256` 和 `sizeBytes`，但 `archiveFile` 把 `gateway.downloadArchive` 返回的 `Data` 直接写盘，没有核对长度或摘要；`sha256` 在客户端从未被读取，`sizeBytes` 只用于界面显示。传输被截断、代理解包成别的内容、或服务端返回异常大包时，客户端仍会保存/分享；整包还会同时占用网络响应和写盘前的内存，导出包很大时有内存压力。

证据:
```swift
public let sizeBytes: Int
public let sha256: String
...
data = try await gateway.downloadArchive(exportId: exportId)
...
let url = directory.appendingPathComponent(URL(fileURLWithPath: fileName).lastPathComponent)
try data.write(to: url, options: .atomic)
```
（`sha256` 在 `HimawariManage` 里没有其它读取处；`sizeBytes` 只在 `ManageStrings.swift:285` 显示。）

建议: 写盘前检查 `data.count == result.sizeBytes`，并计算 SHA-256 与 `result.sha256` 比较；不一致按“没能下载”处理，不落盘。若导出包可能很大，考虑流式下载或设置大小上限。

### 4、低、作者说取回失败弹“没办成”，代码实际是内联“没能下载”，那个 alert 只用于取消失败

文件: `clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:40,84-87,116-120`

问题: 作者说法与代码不一致。下载失败走的是 `downloadFailed` 内联文案 `M.exportDownloadFailed`（“没能下载”），不会弹 `M.actionFailed`（“没办成，再试一次”）；`failed` 只在 `cancel()` 抛错时置位（第 60-62 行）。

证据:
```swift
.alert(M.actionFailed, isPresented: $failed) {}
...
if downloadFailed {
    Text(M.exportDownloadFailed)...
...
} catch { downloadFailed = true }
```
`M.actionFailed` 的文案在 `ManageStrings.swift:110`，`M.exportDownloadFailed` 在 `ManageStrings.swift` 的导出文案段。

建议: 统一文案与交互：要么按作者说法改成“没办成”提示，要么把作者说法改成“显示没能下载”。两者选一个，别让说明和界面不一致。

### 5、低、客户端没有成功下载/写盘和“保存后重下失败”的自动用例，现有反向用例只覆盖 404

文件: `clients/apple/Tests/HimawariManageTests/DataExportSessionTests.swift:31-33,109-120`、`clients/apple/Tests/HimawariManageTests/ManageGatewayTests.swift:61-81`

问题: `ExportTransport.download` 永远返回 404，因此 `archiveFile` 的成功分支（建 UUID 目录、取 `lastPathComponent`、写文件、返回 URL）一次也没被测过；上一轮意见 1 的“保存后重下失败”更是没有用例。`ManageGatewayTests` 只测了 URL 编码和 404 映射，没测页面流程。这样一来，意见 1 继续存在也不会有测试失败。

证据:
```swift
nonisolated func download(path: String, query: [URLQueryItem]) async throws -> DeviceResponse {
    DeviceResponse(status: 404, body: Data(#"{"error":{"code":"not_found"}}"#.utf8))
}
```
```swift
func testDownloadingAnExpiredArchiveTurnsTheReadyPageIntoExpired() ...
```
现有 404→expired 用例是真的反向用例：去掉 `archiveFile` 的 404 catch 它会失败。但成功路径和“保存后重下”没有对应检查。

建议: 加一个返回 200、给定字节的 transport，断言 `archiveFile` 写出的文件存在、文件名正确、内容一致；再为页面抽出一个可测的下载/保存模型，覆盖“保存成功→重下失败不得显示没能下载”。同时补一个 `sizeBytes`/`sha256` 不一致的反向用例。

### 6、低、`downloadFile` 的单元测试断言了服务端必然 404 的 `%2F` 路径，给以后“点开文件”留下错误预期

文件: `clients/apple/Tests/HimawariManageTests/ManageGatewayTests.swift:61-67`；服务端 `packages/platform-node/src/device-api-routes.ts:83`

问题: 客户端测试用 `fileId: "thread-artifact:ab/cd"`，断言路径是 `files/content/thread-artifact%3Aab%2Fcd`。但服务端 `FILE_ID_SEGMENT` 只允许字母数字、`._:-` 和 `%3A`，`%2F` 会被 `onRequest` 以 404 拒绝（`test/integration/device-download.test.ts:166-167` 明确断言 404）。测试替身返回 200，会让人以为带斜杠的文件编号可下载。当前生产代码没有调用 `downloadFile`，所以不是现行故障，但以后接“点开文件”入口时会踩到。

证据:
```swift
XCTAssertEqual(downloads, ["files/content/thread-artifact%3Aab%2Fcd"])
```
```ts
const FILE_ID_SEGMENT = "[A-Za-z0-9](?:[A-Za-z0-9._:-]|%3[Aa]){0,127}";
```
```ts
const slash = await get(h, client, "/api/device/v1/files/content/a%2Fb");
expect(slash.statusCode, slash.body).toBe(404);
```

建议: 把客户端测试改成规范里的真实形状 `thread-artifact:<uuid>`（断言 `%3A`，服务端 200），另加一条“含斜杠的编号被 404”的反向断言；如果确实要支持斜杠编号，得先改服务端白名单和规格，而不是只在客户端编码。

## 推测与未核实

- 本环境没有 Swift 工具链，作者说的 `swift test` 全过、iOS 和 Mac 编译通过均**未核实**。`.fileMover` 在 iOS 上是否可用也没有在仓库里找到证据；代码没有 `#if os(macOS)` 保护。若 iOS SDK 不提供该修饰符，iOS 构建会失败。请让 Mac 线程给出 iOS 构建日志再确认，暂不列为确定意见。
- 上一轮复核记录原文未能读取（`REVIEW_GIT_REFUSED records-path`），只能按任务摘要核对；但“意见 1 未改好”这个结论是从 `d48ae4ae..9d13c64c` 对 PR 540 文件零改动和当前代码直接读出的。
- 未重新审查合并进来的 main 改动（手表、通知、送达时机、仓库卫生等），它们不属于 PR 540，且已有各自复核轮次；本轮只核对了它们对 PR 540 直接依赖的服务端路由没有行为变化。

## 侧重检查

- **错误路径**：404→过期有服务端集成测试和客户端 `testDownloadingAnExpiredArchiveTurnsTheReadyPageIntoExpired` 守着；非 404 会落到“没能下载”；`data.write(options: .atomic)` 不会留半截文件。但保存成功后的重下失败会误报，见意见 1；并发重试没有互斥，可能产生多个临时目录。
- **不合规范或不可信输入**：`fileName` 用 `URL(fileURLWithPath:).lastPathComponent`，路径穿越写不出去（`..` 最终指向目录，写文件失败）；`exportId` 和 `fileId` 由服务端按 `DATA_EXPORT_ID_PATTERN`/`FILE_ID_SEGMENT` 校验，多余查询参数会被拒绝。客户端对 `fileId` 的 `%2F` 编码会被服务端拒绝，属于失败关闭，不是绕过；但测试替身给了 200，见意见 6。
- **安全**：下载只要求设备签名，不过面容，和 `docs/execution/specs/2026-11-11-apple-device-body-design.md:232` 及作者说法一致；`data.export.start` 仍是 `.change` 档、需要面容确认。导出包是敏感数据，下载后落在临时目录，未做摘要校验且可能长期残留，见意见 2、3。
- **资源耗尽**：整包 `Data` 一次读入内存再写盘，没有 `sizeBytes` 上限检查；保存成功后自动重下会额外消耗一次完整下载并留下副本。
- **不可撤销的操作**：`fileMover` 是用户主动选择目标后移动文件，没有新增服务端破坏性动作；`data.export.start/cancel` 沿用既有流程。
- **规则、说明文档和代码一致性**：本 PR 不触碰模型请求，`prompt-prefix` 不适用；`docs/execution/specs/2026-11-11-apple-device-body-design.md` 的 `GET data-export/archive`、`GET files/content/{fileId}` 和新值表与代码一致；作者“失败弹没办成”的说法与代码不一致，见意见 4；改动本身没有代码注释，界面数值用了 `DesignTokens`/`ManageLayout`。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本 PR 只改 iPhone 设置页的导出下载 UI 和设备签名 GET 下载，不组装、不修改任何发给模型的内容（系统提示、工具定义、历史消息、遮盖结果都不经过这些代码）。依据 `prompt-prefix.md` 第 4、10 条，本改动没有涉及“只在末尾追加”的路径；唯一的网络请求是 `GET data-export/archive` 和 `GET files/content/{fileId}`，不是模型请求。问题里“发给模型的内容是不是仍然只在末尾追加、每轮变化的值是不是都在最后一条消息”在本改动范围内**不涉及**。

2. **不会让同一段文字在不同模型请求里变成不同字节。** 本改动不序列化任何模型文本。每次请求会变的值只有设备签名头里的随机 nonce，以及本地临时目录的 UUID；两者都不进入模型提示。导出包字节由服务端生成，也不是模型输入。所以对模型请求的 KV 缓存没有影响。

3. **有部分自动检查，但不够。** 服务端 `test/integration/device-download.test.ts` 覆盖未签名、重放、未知编号、格式错误、多余参数、吊销设备等反向用例；客户端 `testDownloadingAnExpiredArchiveTurnsTheReadyPageIntoExpired` 在去掉 404 catch 后会失败；`testFileDownloadEncodesTheColonAndSlashInTheFileId` 在去掉 `:/` 编码后会失败。但 `ExportTransport.download` 永远 404，成功下载/写盘路径完全没测；上一轮意见 1 的“保存后重下失败”没有测试，所以它继续存在也不会有用例失败。Swift 测试和 iOS/Mac 编译结果本环境未核实。

4. **逐个核对的两端：**
   - `archivePath = "data-export/archive"`：客户端拼成 `/api/device/v1/data-export/archive`，服务端 `DEVICE_API_ROUTES` 有这个路径（`device-api-routes.ts:112`），`signed: true` 接受设备签名，检查通过。
   - `exportId` 查询参数：客户端用 `URLQueryItem` 传给 `DeviceHTTPClient`，后者按 `-._~` 白名单百分号编码，冒号变成 `%3A`；服务端 `URLSearchParams` 解码后按 `DATA_EXPORT_ID_PATTERN` 校验，且要求恰好一个 `exportId`，两端兼容，服务端集成测试也覆盖了 200/400/404。
   - `fileContentPath + encoded fileId`：冒号编码成 `%3A`，服务端 `FILE_ID_SEGMENT` 接受；斜杠编码成 `%2F`，服务端按规格拒绝 404。规范里的 fileId 形状是 `thread-artifact:<uuid>`（不含斜杠），所以真实编号可用；但客户端测试用带斜杠的假编号并让替身返回 200，见意见 6。当前生产没有调用 `downloadFile`。
   - `DeviceTransport.download` 默认 501：只影响不实现该方法的测试替身；生产 `SignedDeviceTransport` 覆盖了它。`ManageGateway.fetch` 会把 501 变成 `ManageGatewayError.rejected`，最终显示“没能下载”，可以接受。
   - `result.downloadPath`：服务端 `production-data-export.ts:405` 产生的是浏览器路由 `/api/data-export/v1/archive?...`，不是设备路由；客户端只把它当 `.task(id:)` 的字符串 id 用，不解析成 URL，所以能接受。但名字有误导性，以后不要拿它当实际下载地址。
   - `fileName`：客户端取 `lastPathComponent` 后拼到临时 UUID 目录下，`fileMover`/`ShareLink` 接受文件 URL；空文件名或异常文件名会让写盘失败并显示“没能下载”，不会穿越目录。
   - `sha256`/`sizeBytes`：`sizeBytes` 只用于界面展示，`sha256` 客户端没有使用；`archiveFile` 两端没有校验，见意见 3。
   - `M.saveToFiles`、`M.sendElsewhere`、`M.exportDownloadFailed`、`M.downloadAgain`、`M.exportPackFailed`：都在 `DataExportPage` 里直接使用，采用中英日内联文案，没有漏掉的资源文件。
   - `SettingsRootView.exportDownloadAvailable = true`：唯一使用处就是 `SettingsRootView.swift:69`，导出入口只在 `store.phase == .loaded` 时出现，使用端能接受。
   - `DataExportSession.init(gateway:fixed:)` 里的 `exportId = "demo"`：只用于演示和固定 `ready` 测试；演示 transport 对任意下载返回 200，固定 `ready` 的测试在 `follow()` 处提前返回，不会真的去下载，当前使用端能接受。
