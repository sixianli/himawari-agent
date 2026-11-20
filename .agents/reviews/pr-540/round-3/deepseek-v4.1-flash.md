## 这一轮查过的范围

- 增量：`git diff 003e7f50f..d48ae4ae1`，实际代码改动只有 3 个文件：`DataExport.swift`、`DataExportPage.swift`、`DataExportSessionTests.swift`；其余是复核记录和截图。
- 为核对契约，另读了本 PR 的 `DeviceTransport.swift`、`ManageGateway.swift`、`ManageDemo.swift`、`ManageStrings.swift`、`SettingsRootView.swift`，以及服务端 `device-api-routes.ts`、`production-data-export.ts`、客户端 `DeviceAPIClient.swift` 和相应测试。
- 本环境不能运行 `swift test` 或编译 iOS；作者说的“全过/编译通过”标为未核实。

## 上一轮意见与作者说法核对

- 上一轮意见 1（ready 后 404 停在“没能下载”、没有重新打包入口）：**已改好**。`DataExport.swift:125-128` 把 404 改成 `.expired`，`DataExportPage.swift:28-29` 的过期页提供“重新打包”，新测试 `DataExportSessionTests.swift:109-120` 会在改前失败（改前 stage 仍是 `.ready`）。
- 上一轮意见 2（保存成功后重新取回失败误报“没能下载”、临时文件/重复下载）：**只改好一半**。`DataExportPage.swift:110` 清理旧临时目录已加上，而且用的是源 `archive` 而不是 `fileMover` 回调里的目标 URL，删除的是 `temporaryDirectory/<UUID>`；但保存成功后仍会自动重新下载整包，重新取回失败时仍会把已成功的保存报成“没能下载”或跳到“过期了”（见下面意见 1）。
- 作者说法：路由、临时目录、文件名取最后一段、入口放出、两个按钮在取回前不可点，均与代码一致。“失败弹出‘没办成’提示”与代码不一致（见意见 2）。“swift test 全过、iOS/Mac 编译通过”未核实。

### 1、中低、保存成功后仍会自动重下，重新取回失败会把已成功的保存报成“没能下载”

文件:行：`clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:108-119`；`clients/apple/Sources/HimawariManage/Settings/DataExport.swift:125-128`

问题：保存成功后仍然执行 `archive = nil; Task { await fetchArchive(result) }`，自动把整个压缩包再下载一遍。若这次重新取回遇到非 404（网络失败、500、501），`fetchArchive` 会把 `downloadFailed` 设为 `true`，页面显示“没能下载”并隐藏“存到文件/发到别处”，用户会以为刚才的保存失败了。若遇到 404，新加的 catch 会把 `stage` 改成 `.expired`，页面直接跳到“过期了/重新打包”，同样没有“已保存”的确认。第 2 轮意见里的“旧临时目录未清理”确实修好了，但“保存成功被误报”和“重复下载”仍未解决。

证据（读代码证实的）：

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

```swift
} catch ManageGatewayError.rejected(404, _, _) {
    if self.exportId == exportId { stage = .expired }
    throw ManageGatewayError.rejected(status: 404, code: nil)
}
```

建议：把“保存成功”和“压缩包可再次取回”拆成两个状态。成功移动后不要用后台重新下载的失败覆盖“已保存”；分享/再下载应由用户点按触发，或在后台下载失败时只禁用分享而保留“已保存”提示。这样也能避免每次保存后无谓地再下载一遍。

推测：无；上述行为由当前代码路径直接决定。

### 2、低、作者说“失败弹出没办成”，代码实际是页内“没能下载”加重试

文件:行：`clients/apple/Sources/HimawariManage/Settings/DataExportPage.swift:40`、`:61`、`:84-87`；`ManageStrings.swift:110`、`:299-300`

问题：下载失败走的是 `downloadFailed`，渲染为页内 `Text(M.exportDownloadFailed)` 和“再下载一次”按钮，不会弹出 `M.actionFailed`（“没办成，再试一次”）。`.alert(M.actionFailed, isPresented: $failed)` 只在“取消打包”失败时通过 `failed = true` 触发。作者描述与代码不一致。

证据（读代码证实的）：

```swift
.alert(M.actionFailed, isPresented: $failed) {}
...
Text(M.exportDownloadFailed).hmType(XL.title)...
Button { Task { await fetchArchive(result) } } label: { Text(M.downloadAgain) }
```

建议：修正 PR 说明即可；页内提示配合重试按钮本身是合理的，不必为了符合说明改成弹窗。

推测：无。

## 侧重检查

- **错误路径**：404 会转 `.expired`；非 404（401/403/500/501/网络错误）仍留在 `.ready`，显示“没能下载”+手动重试，不会自动重试。保存成功后的重新取回也会走这两条路径；404 会跳到过期页，非 404 会误报“没能下载”。（读代码证实）
- **不可信输入与安全**：服务端 `FILE_ID_SEGMENT` 只放行字母数字 `._:-` 和 `%3A`，`%2F` 被 `rejectNotAllowed()` 转成 404；客户端 `downloadFile` 对冒号和斜杠做百分号编码，服务端 `URLSearchParams` 再解码 `exportId`。导出是设备签名 GET，不需要再次面容；导出包只能由已过面容的 `data.export.start` 产生，服务端还核对 owner。未发现新增的鉴权绕过。（读代码证实）
- **路径穿越**：客户端用 `URL(fileURLWithPath: fileName).lastPathComponent` 取文件名；文件名若为 `..`/`.`，写入目标会是目录而失败，未发现写到 UUID 临时目录之外的可利用路径。建议仍显式拒绝空、`.`、`..`。（读代码证实）
- **资源耗尽**：服务端压缩包上限是 512 MiB（`production-data-export.ts:39`）；客户端 `archiveFile` 把整包读进 `Data` 再写盘，且自动在 ready 页和保存成功后重复下载。大包在 iPhone 上是否 OOM 未核实（推测/未核实）。`DataExportResult` 里的 `sizeBytes`、`sha256` 目前完全没用于校验，下载截断只能靠 TLS 兜底（读代码证实缺少校验）。
- **不可撤销操作**：本轮新增的删除只作用于源临时目录：`if let moved = archive { removeItem(at: moved.deletingLastPathComponent()) }`，这里绑定的是 `archive` 而不是 `fileMover` 回调的 `outcome`，所以不会删用户选中的目标目录。服务端没有新增删除/撤销操作。（读代码证实）
- **规则与文档一致性**：设计文档已把“设备不能发起导出”改成“可在面容确认后发起”，与服务端 `data.export.start` 属于 `.change` 且客户端会签发 challenge/confirm 一致；文档里的文件编号白名单与 `FILE_ID_SEGMENT` 一致。本轮不涉及模型提示词目录，未发现规则文件需要同步的地方。（读代码证实）

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。这个改动只新增设备数据下载和本地保存，没有改系统提示、工具定义、历史消息、遮盖或压缩；发给模型的请求没有新增内容，更不存在“只能末尾追加”的问题。

2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及模型文本。导出包由服务端 `view.built.archive` 缓存后重复返回，同一个导出多次下载字节相同；客户端临时文件名用 UUID，但不会进入模型请求。设备 GET 的签名 nonce/时间每次不同，这是 HTTP 签名协议所需，不属于发给模型的内容。

3. **有没有对应的自动检查，反向用例会不会失败？**
   - 有：新增 `testDownloadingAnExpiredArchiveTurnsTheReadyPageIntoExpired`（`DataExportSessionTests.swift:109-120`）。按改前代码，`archiveFile` 直接抛错、`stage` 仍是 `.ready`，断言 `.expired` 会失败，所以这条反向用例是有效的。
   - 缺：没有反向用例证明“非 404 不会转 expired”。如果以后有人把 catch 改成捕获所有错误，这条测试仍会通过，需要补一条 500/网络错误后 `stage` 仍为 `.ready`、仍可重试的用例。
   - 缺：第 2 轮意见 2 的“保存成功后重新取回失败不应误报”、以及“保存成功后旧临时目录被清理”都没有测试。当前新增的清理行没有任何自动检查。
   - 未核实：本环境不能运行 `swift test`，以上“会失败/会通过”均据代码推断。

4. **增量产生或修改的每个值，使用端能不能接受？**
   - `archive`/临时目录：产生于 `DataExport.swift:129-133`（`temporaryDirectory/<UUID>`），使用于 `DataExportPage.swift:110` 删除其父目录；两端一致，且不会误删 `fileMover` 的目标目录。
   - `stage = .expired`：产生于 `DataExport.swift:126`，使用于 `DataExportPage.swift:28-29` 的过期页和重试；能接受。
   - `ManageGatewayError.rejected(status: 404, code: nil)`：产生于 `DataExport.swift:127`，唯一使用端是 `DataExportPage.swift:119` 的 catch-all 和测试，不依赖 `code`/`reason`，能接受；但原始错误码和原因被丢掉，只影响诊断。
   - `downloadPath`：服务端产生于 `production-data-export.ts:405`，客户端解码为 `DataExportResult.downloadPath`；只用作 `.task` 的 id（`DataExportPage.swift:107`），实际请求用的是会话里保存的 `exportId` 和硬编码的 `data-export/archive`。当前与 `device-api-routes.ts:103` 的路由一致；以后服务端改路由时，客户端不会跟着 `downloadPath` 变，这是耦合点，不是当前错误。
   - `exportId`：服务端按 `data-export:[A-Za-z0-9_-]{22}` 产生；客户端放进查询参数，`DeviceAPIClient.swift:214-222` 把冒号编码成 `%3A`，服务端 `device-api-routes.ts:782-790` 解码并按同一正则校验；两端能接受。
   - `fileName`：服务端产生 `himawari-export-YYYY-MM-DD.zip`（`production-data-export.ts:333`），客户端取 `lastPathComponent`（`DataExport.swift:131`）；能接受。
   - `fileId`：服务端白名单 `device-api-routes.ts:73-74` 只放行字母数字 `._:-` 和 `%3A`，客户端 `ManageGateway.swift:87-93` 把冒号和斜杠编码；`%2F` 确实被服务端测试断言为 404（`device-download.test.ts:166-167`）。当前 `downloadFile` 没有生产调用端；将来接入时，带 `/` 的文件编号永远下载不了，但服务端自己的 fileId 校验也禁止 `/`，所以不算当前契约冲突。
   - `DeviceTransport.download` 默认返回 501：现有测试替身都能继续编译，生产 `SignedDeviceTransport` 覆盖了真实实现；使用端能接受。
   - 新增 UI 文案 `saveToFiles`、`sendElsewhere`、`exportDownloadFailed`、`downloadAgain`：三个语言都有值，使用端在 `DataExportPage`；能接受。
