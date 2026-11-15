本轮查过：`git diff 4be208e6e…003e7f50f` 的全部增量（即 `c0be1454c` 与 `003e7f50f`），以及被改 Swift 文件的直接使用端、相关服务端路由/测试、设计文档。增量未触及的旧代码只沿证据读了必要部分。

## 意见

### 1、中、ready 后停止轮询，导出过期或服务端 404 时页面永远停在“没能下载”，没有重新打包入口
文件: `clients/apple/Sources/HimawariManage/Settings/DataExport.swift:84`、`clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:28-31,37-38,118`

问题：增量为了不让演示页被轮询冲成失败页，在 `follow()` 里对所有 `.ready` 直接返回；但真实页面也走这条路径。导出包在服务器上过期/被删后，下载会失败，页面只把 `downloadFailed` 设真，stage 仍然是 `.ready`，而“重新打包”按钮只在 `.expired` / `.failed` 分支存在。用户回到设置再进导出页仍使用同一个 `store.export`，`follow()` 继续直接返回，仍然没有重新打包入口。

证据（亲读）：
```
// DataExport.swift:84
if case .ready = stage { return }
```
```
// DataExportPage.swift:37-38
.task {
    if session.stage == .idle { await session.start(reason: M.confirmExport) } else { await session.follow() }
}
```
```
// DataExportPage.swift:118
do { archive = try await session.archiveFile(named: result.fileName) } catch { downloadFailed = true }
```
```
// DataExportPage.swift:29-31
case .expired:
    retry(M.exportExpired)
case .failed:
    retry(M.exportPackFailed)
```
```
// SettingsStore.swift:25
@ObservationIgnored public private(set) lazy var export = DataExportSession(gateway: gateway)
```
服务端对不存在/过期导出返回 404，已有测试：`test/integration/device-download.test.ts:189-194`（未知导出 404）。

建议：不要对所有 `.ready` 一律停止轮询；至少对固定的演示 session 停止轮询，或继续轮询但在 `.ready` 时不要把瞬态失败覆盖成 `.failed`。下载遇到 404/410 时，应把 session 转成 `.expired` 或给 ready 页提供“重新打包”，而不是只给“再下载一次”。

### 2、中低、保存成功后重新取回失败会把已成功的保存报成“没能下载”，并留下未清理的临时文件/重复下载
文件: `clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:108-112`、`clients/apple/Sources/HimawariManage/Settings/DataExport.swift:120-127`

问题：`fileMover` 成功后把 `archive` 置空并立刻重新下载整包。若此时导出刚好过期或网络失败，`fetchArchive` 会把 `downloadFailed` 设真，页面显示“没能下载”——但文件其实已经保存成功。另外每次成功保存、每次重新进入 ready 页都会完整再下载一次，并在 `temporaryDirectory` 新建 UUID 目录；代码里没有删除旧目录或页面消失时的清理，旧文件/空目录会积累。大导出包还会整包读进内存。

证据（亲读）：
```
// DataExportPage.swift:108-112
.fileMover(isPresented: $saving, file: archive) { outcome in
    guard case .success = outcome else { return }
    archive = nil
    Task { await fetchArchive(result) }
}
```
```
// DataExport.swift:123-126
let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
let url = directory.appendingPathComponent(URL(fileURLWithPath: fileName).lastPathComponent)
try data.write(to: url, options: .atomic)
```
建议：保存成功后若要保留分享能力，应区分“保存成功但刷新副本失败”的文案；或在移动前保留一份副本、用完删除；同时在页面消失/成功保存后删除旧临时目录。避免每次进入页面都无条件整包重下。

### 3、低、上一轮意见 1/2 的修复没有自动检查；删掉重试或保存后重取，测试仍会全过
文件: `clients/apple/Tests/HimawariManageTests/DataExportSessionTests.swift:117-125`

问题：增量新增的测试只覆盖“固定 ready 页不再轮询”，没有覆盖 `DataExportPage` 的 `downloadFailed` 重试分支、`fileMover` 成功后的重新取回、重新取回失败后的提示。因此这两个上一轮修复没有反向用例保护。

证据（亲读）：新增测试只有
```
func testFollowingAFixedReadyPageDoesNotPollOrFail() async throws {
    ...
    await fixed.follow()
    XCTAssertEqual(fixed.stage, .ready(result))
    XCTAssertTrue(sent.isEmpty)
}
```
`grep` 没有找到 `DataExportPage` 的测试；`downloadFailed`、`fileMover` 成功分支只在源码中出现。

建议：把取回/重试/保存后刷新抽成可测的模型状态，或增加页面级测试，至少覆盖：首次取回失败显示重试、重试成功、保存成功后重新取回、重新取回失败不误报为首次下载失败。

### 4、低、作者说“失败弹出‘没办成’提示”，当前代码不是弹窗
文件: `clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:40,61,84-87`

问题：下载失败现在进入 `downloadFailed` 分支，显示页内文字“没能下载”和“再下载一次”；`M.actionFailed` 的 alert 只剩“取消导出失败”使用。

证据（亲读）：
```
// DataExportPage.swift:40
.alert(M.actionFailed, isPresented: $failed) {}
// DataExportPage.swift:61
failed = true   // cancel() 失败时
// DataExportPage.swift:85-86
Text(M.exportDownloadFailed)...
Button { Task { await fetchArchive(result) } } label: { Text(M.downloadAgain) }
```
建议：更新作者说明/PR 描述，避免复核者按旧文案理解失败路径。

## 上一轮意见核对

- 意见 1（fileMover 移走唯一临时包后分享和再次保存仍指向旧 URL）：已改。`003e7f50f` 在 `.fileMover` 成功回调中把 `archive` 置空并重新取回（`DataExportPage.swift:108-112`），旧 URL 不会再被 `ShareLink` 或再次保存使用。但引入了意见 2 的重下/临时文件问题。
- 意见 2（下载失败后没有重试入口，两个按钮会一直不可用）：已改。`downloadFailed` 分支提供“再下载一次”（`DataExportPage.swift:84-87`）。
- 意见 9（设计文档说设备不能发起导出，但代码允许 `data.export.start`）：已改。文档 `docs/execution/specs/2026-11-11-apple-device-body-design.md:235` 已改为“设备可以在主人当场面容确认后发起导出”；与 `clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:163`（`data.export.start` 为 `.change`）、`ManageGateway.swift:67-74`（`.change` 先取 challenge 再带 confirm）、`DataExport.swift:70`（用 `confirmReason` 调用 start）一致。全仓 `*.md` 未再找到“不能发起导出”的相反说法。

## 作者说法核对

- “设备签名 GET 取回压缩包，路由为 archive 和 files/content”：一致。客户端路径 `ManageGateway.swift:80-93`；服务端路由 `packages/platform-node/src/device-api-routes.ts:779,797`。
- “两个按钮 / 设置入口放出”：一致。`SettingsRootView.swift:52` 为 `true`，页面有“存到文件”“发到别处”。
- “打包好后自动取回，task id 是 downloadPath”：一致。`DataExportPage.swift:107`。
- “取回前两个按钮不可点”：一致。`archive == nil` 时保存按钮 disabled，分享按钮 disabled。
- “失败弹出‘没办成’”：不一致，见意见 4。
- “临时文件写在 temporaryDirectory 的 UUID 目录，文件名取最后一段”：一致，`DataExport.swift:123-125`；`lastPathComponent` 也避免了路径穿越。
- “本 PR 不改服务端”：一致。`git diff --name-only ce8d…003e` 只有 `clients/apple`、`docs` 和复核记录，没有 `apps`/`packages`/`test` 的服务端改动。
- “文件列表里点开文件的入口不在本 PR”：一致。`downloadFile` 在源码中除测试外没有调用者，`SettingsRootView` 的 files 页面未改动。
- “只做读，不过面容”：对新增的 GET 下载成立；但首次打开导出页仍会自动调用 `data.export.start`（`.change`，需要确认密钥），整体流程并非“全程不过面容”。
- “downloadFile 冒号/斜杠百分号编码，服务端 %2F 必须 404”：客户端一致；服务端测试 `test/integration/device-download.test.ts:159-167` 确认 `%3A` 可下载、`%2F` 返回 404。
- “swift test 全过、iOS 和 Mac 编译通过”：未核实，本环境不能编译或运行 Swift。

## 侧重检查

- 错误路径：下载失败有重试；但保存后刷新失败误报、导出过期后的死路是本次新问题（意见 1、2）。
- 不合规范/不可信输入：`fileName` 来自服务端但被 `URL(fileURLWithPath:).lastPathComponent` 收敛到临时目录；`exportId` 通过 `DeviceHTTPClient.encode` 百分号编码后进 query；`downloadPath` 只作为 `.task` 的 id，没有拿它拼 URL。未发现新增的路径注入或开放重定向。
- 安全：服务端路由未改；`SignedDeviceTransport.download` 不带 confirm 签名，只带设备签名，符合“下载只读”；没有新增绕过面容的写操作；文件下载仍按 owner 校验（服务端测试覆盖）。
- 资源耗尽：整包 `Data` 在内存中，保存成功后再次整包下载，临时目录不清理；大导出包时磁盘/内存压力比修改前更大。
- 不可撤销操作：`fileMover` 会移动临时文件，但用户目标位置的副本是用户主动保存的；服务端没有新增删除/覆盖类操作。
- 规则/文档一致：设计文档已与 `data.export.start` 的代码能力一致；未找到其他相反文档；作者关于失败弹窗的说明与代码不一致。

## 读代码证实的 / 推测

**读代码证实的**：上述 diff 范围、三处上一轮意见的修复、所有代码引用、服务端路由与测试、设计文档与客户端能力表的一致性、没有服务端改动、没有 `DataExportPage` 测试。

**推测 / 未核实**：Swift/Mac 真实编译与 `swift test` 未运行；`.task(id:)` 与 `.fileMover` 的 SwiftUI 运行期细节（例如取消时 completion 的具体结果）未在本机验证；`fullScreenCover` 关闭后是否重建 `SettingsStore` 属 SwiftUI 运行期行为，但即使会重建，同一次设置会话内导出页仍会卡在 ready；服务端导出包的最终过期删除策略只从页面文案和 404 测试推断，未逐段读清理任务。

## 必答问题

1. **不改变模型已见过的请求开头。** 本增量只改 Swift 客户端下载/展示和设计文档，没有改系统提示、工具定义、历史消息或遮盖结果；没有改动任何发给模型的请求构造，因此“只在末尾追加、每轮变化的值在最后一条消息”的规则不受影响。与本问题不涉及。
2. **不会让同一段文字在模型请求里变成不同字节。** 增量没有把任何文字放进模型请求。客户端唯一的编码是 `downloadFile` 的确定性百分号编码；HTTP 签名里的时间/nonce 属于设备认证层，不是模型内容，也不改变压缩包内容本身。与本问题不涉及。
3. **自动检查不完整。** `follow()` 的 ready 早返回有测试，且反向用例会失败（去掉早返回后测试里的 500 会让 stage 变 `.failed`）。但上一轮意见 1、2 的两个用户可见修复没有测试；删掉“保存后重取”或“失败重试”分支，现有测试仍全过。文档改动也没有自动检查。
4. **逐项核对使用端：** `M.exportPackFailed` 只被 `DataExportPage.swift:31` 的 `Text` 消费；`M.exportDownloadFailed`、`M.downloadAgain` 只被 `:85-86` 的 `Text` 消费，类型都可接受。`follow()` 的消费者是页面 `.task` 和 `start()`：`start()` 先设 `.packing` 不受影响，页面 `.ready` 的消费者不接受“永不重新打包”的死路（意见 1）。`downloadPath` 只作 `.task(id:)` 的身份值，格式由服务端合约保证；实际下载用 session 的 `exportId`，与服务端 archive query 校验一致。`archive` 的消费者是 `ShareLink` 与 `fileMover`，成功后置空再重取可接受，但失败提示和临时文件需要处理（意见 2）。`archivePath`/`fileContentPath` 与 `device-api-routes.ts` 的路径一致；`downloadFile` 本 PR 没有生产调用者，`%2F` 被服务端按设计拒绝。设计文档改动与 `ClientCapabilities` 和 `ManageGateway.command` 的确认路径一致。
