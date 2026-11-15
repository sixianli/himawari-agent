## 本轮范围

- 增量：`git diff b4db24aca67eb4fdf0faf6a7542c1f1df10281ae..ea1cd6f2b32127baff3f592d92a1534adcc9c69b`。其中 PR 503 的修复是 `bd252606e`；另一个变化是 `ea1cd6f2b` 合并 `origin/main`（PR 527）。合并到 `clients/apple` 的只有 `Generated/ClientCapabilities.swift` 增加 3 个来源操作。
- 追读的文件：`DeviceAPIClient.swift`、`DeviceTransport.swift`、`ManageGateway.swift`、`SettingsStore.swift`、`MemoryStore.swift`、`MemoryModels.swift`、`SettingsStoreTests.swift`、`MemoryStoreTests.swift`、`DeviceHTTPClientTests.swift`、`device-gateway.ts`、`identity-gateway.ts`、`paired-device-service.ts`、`contracts-v2.ts`、`text-admission.ts`、`production-memory-control.ts`、`check-operations.mjs`、ADR 0192。
- 未核实：PR 527 其余约 4 千行、截图验收、Swift 编译与测试（当前环境无 Swift 工具链）。

## 上一轮意见核对

1. **已改好**：`SettingsStore.disable` 现在带 `recentAuthenticationRef`，值 `"device"` 与服务端 `DEVICE_REFERENCE_PLACEHOLDER` 一致；服务端确认签名后把它替换成真实 `authenticationRef`。
2. **代码已改好，测试没锁住真实路径**：`SignedDeviceTransport` 现在把 `reasonCode` 重新编码给 `ManageGateway`，但新增测试只测了 `DeviceHTTPClient`，没有测 `SignedDeviceTransport`。
4. **已改好**：`MemoryStore.correct` 使用原记忆的 `dataClassification`，新增测试断言上传 `sensitive`。
7. **未完全改好**：`ci/operations-pending.json` 的两条文案改了，但 ADR 0192 仍写着旧扫描范围，名单数量也与当前不符。
10. **核心场景已改好，仍有并发缺口**：`loadingMoreFiles` 能挡住重复的“加载更多”，但挡住不了刷新与“加载更多”并发；也没有对应测试。

作者其它说法核对：本事页开关、`containerRelativeFrame`、中文相对时间加空格、导出入口关闭这几项与代码一致；“Swift 169 个测试通过/能编译”与修复提交自述不一致（见下）；“18 张截图已验收”未核实。

## 读代码证实的

### 1. 低 作者说“收紧也要挑战值和面容”，但代码和现有测试都明确收紧操作不取挑战值

- 文件：`clients/apple/Sources/HimawariManage/Gateway/ManageGateway.swift:64`、`clients/apple/Tests/HimawariManageTests/ManageGatewayTests.swift:58`、`packages/platform-node/src/device-gateway.ts:154`
- 问题：本次材料把约束写成“改和收紧要带一次性挑战值并过面容”，但 `ManageGateway` 把 `.tighten` 与 `.read`、`.routine` 放在同一分支，直接发送，不取 challenge、不传 confirm；服务端也只对 `change` 档要求 `confirmed`。现有测试还专门断言“暂停不收面容、恢复要面容”。因此这是**说法与代码/测试不一致**，且代码看起来是有意设计，不是本次增量改坏的。
- 证据：
  - `ManageGateway.swift:64-67`
    ```swift
    case .read, .routine, .tighten:
        return try await send(path: Self.gatewayPath, body: .object(body), nonce: nil, confirm: nil)
    ```
  - `ManageGatewayTests.swift:58-65` `testPausingSkipsFaceIDButResumingAsksForIt` 断言 pause 的 `confirm` 为 `nil`。
  - `device-gateway.ts:154-155`
    ```ts
    if (input.request.tier === "change" && !input.confirmed && !input.notificationAction)
      throw new DeviceGatewayError(DEVICE_GATEWAY_ERROR_CODES.CONFIRM_REQUIRED, 403);
    ```
- 建议：确认设计意图。如果收紧方向确实不需要面容，修正材料里的表述为“change 档需要挑战值和面容，tighten 档只要求设备签名”；如果确实要求收紧也过面容，则改 `ManageGateway.command` 走 challenge/confirm，并同步改服务端档位语义和测试。

### 2. 低 文件分页只保护了“加载更多”，刷新与“加载更多”并发时仍会互相覆盖

- 文件：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:115`、`clients/apple/Sources/HimawariManage/Settings/AccountPages.swift:121`
- 问题：`loadingMoreFiles` 只在 `more == true` 时插入和删除。用户可以在“加载更多”还没回来时下拉刷新：刷新用空 `FileShelf` 重新取第一页，而旧的“加载更多”完成时会把旧快照加第二页写回 `shelves[origin]`，覆盖刚刷新的结果，可能重新出现旧数据或丢掉刷新页。这是上一轮“分页在途保护”没有覆盖到的路径。
- 证据：
  - `SettingsStore.swift:116-123`
    ```swift
    var shelf = more ? shelf(origin) : FileShelf()
    if more && shelf.nextCursor == nil { return }
    if more {
        guard loadingMoreFiles.insert(origin).inserted else { return }
    }
    defer {
        if more { loadingMoreFiles.remove(origin) }
    }
    ```
  - `SettingsStore.swift:144` 最后无条件写回 `shelves[origin] = shelf`。
  - `AccountPages.swift:131` 有 `.refreshable { await store.loadFiles(origin) }`。
- 建议：按 `origin` 维护版本/代号，所有加载（包括刷新）都登记；完成时只写回最新代号的结果，过期结果丢弃。补一个“刷新与加载更多并发”的测试。

### 3. 低 服务端 `reasonCode` 的修复没有经过真实传输层 `SignedDeviceTransport` 的反向用例

- 文件：`clients/apple/Sources/HimawariManage/Gateway/DeviceTransport.swift:48`、`clients/apple/Tests/HimawariManageTests/SettingsStoreTests.swift:29`、`clients/apple/Tests/HimawariCoreTests/DeviceHTTPClientTests.swift:161`
- 问题：上一轮的问题是“真实传输层丢弃 reasonCode”，修复点在 `SignedDeviceTransport`。但新增测试只测到 `DeviceHTTPClient` 解码；`SettingsStoreTests` 里的 `ConflictTransport` 直接返回已经拼好的 `DeviceResponse`，绕过了 `SignedDeviceTransport`。如果把这行修复回退，现有测试仍然全部通过。
- 证据：
  - `DeviceTransport.swift:48-52`
    ```swift
    } catch let DeviceAPIError.server(status, code, _, reasonCode) {
        var detail = ["code": code ?? ""]
        if let reasonCode { detail["reasonCode"] = reasonCode }
        let failure = ["error": detail]
        return DeviceResponse(status: status, body: (try? JSONEncoder().encode(failure)) ?? Data())
    }
    ```
  - `SettingsStoreTests.swift:36-39` 的假传输直接返回 `DeviceResponse(status: 409, body: ...reasonCode...)`。
  - `DeviceHTTPClientTests.swift:161-167` 只调用 `http.send`，没有经过 `SignedDeviceTransport`。
- 建议：加一个用真实 `SignedDeviceTransport` + 注入 `HTTPExchange` 返回 `409`/`reasonCode` 的测试，断言 `ManageGatewayError.rejected(409, _, "LOGIN_DEVICES_STILL_CHANGING")`，让回退 `DeviceTransport` 时用例真的失败。

### 4. 低 第 7 条只改了操作账本文案，ADR 0192 的检查范围说明仍与脚本不一致

- 文件：`docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md:47`、`scripts/check-operations.mjs:323`、`ci/operations-pending.json:21`
- 问题：脚本已经扫描 `clients/apple/Sources`（排除 `Generated`/`Demo`），`ci/operations-pending.json` 的说明也改成了“检查现在也扫 Swift 调用方”，但 ADR 0192 第 47 条仍写调用方只有 `apps/control-center/src`、`scripts`、`apps/admin-cli/src`；第 48 条还写“名单目前登记 23 项”，当前 `operations` 实际是 34 项。设计文档、账本说明和代码仍不一致。
- 证据：
  - `scripts/check-operations.mjs:323-328`
    ```js
    ...walk(
      root,
      SWIFT_ROOT,
      (file) => !SWIFT_EXCLUDED_SEGMENTS.some((segment) => file.includes(segment)),
      [".swift"],
    ),
    ```
  - ADR 0192:47 只列了三个 TypeScript 目录。
  - `ci/operations-pending.json` 的 `operations` 段当前 34 个键。
- 建议：更新 ADR（或加一条变更注记）把 `clients/apple/Sources`（排除 `Generated`/`Demo`）写进调用方范围，并把 23 项改成当前数量；否则后来的人会按旧文档理解检查范围。

### 5. 低 修复提交自述“Swift 未编译、测试未运行”，与“Mac 上 169 个测试通过、iOS 和 Mac 都能编译”的说法冲突

- 文件：提交 `bd252606e` 的提交说明（无源码行号）
- 问题：这次修复新增了 `MemoryStoreTests`、`DeviceHTTPClientTests` 用例，并改了 `DeviceAPIError.server` 的枚举签名；但同一个提交的说明写着“Swift 未编译（本机无工具链），Swift 测试未运行”。因此“169 个通过”不可能覆盖这些新增测试，最终提交状态也没有编译证据。
- 证据：`git show bd252606e` 的提交说明：
  ```
  Swift 未编译（本机无工具链），Swift 测试未运行；check-operations 已跑。
  ```
- 建议：在 Mac/iOS 工具链上实际跑 `swift build`/`swift test` 并报告真实数量；不要在新增测试未运行时引用旧测试数量作为最终验证。

## 推测

### 6. 低 记忆分级被做成可选并回退 `private`，服务端缺字段时会把敏感记忆降级上传

- 文件：`clients/apple/Sources/HimawariManage/Memory/MemoryModels.swift:21`、`clients/apple/Sources/HimawariManage/Memory/MemoryStore.swift:47`
- 问题：`MemoryItem.dataClassification` 是 `String?`，改写时用 `item.dataClassification ?? "private"`。当前服务端 `memory.overview.snapshot` 契约要求这个字段，所以正常路径不会触发；但如果服务端版本不匹配、字段被省略或响应异常，客户端会静默把一条可能敏感的记忆按 `private` 上传，重新制造上一轮第 4 条的问题。这是“推测”的失败路径，不是当前服务端的正常行为。
- 证据：
  ```swift
  public let dataClassification: String?   // MemoryModels.swift:21
  let contentRef = try await gateway.uploadText(text, dataClassification: item.dataClassification ?? "private") // MemoryStore.swift:47
  ```
- 建议：既然契约要求该字段，解码时改成必填、缺字段就让记忆页失败（fail closed）；或者缺字段时取最严格的分级/拒绝改写，并补一个缺字段的测试。

## 侧重检查

- **错误路径**：`DeviceHTTPClient` 解出 `reasonCode` → `SignedDeviceTransport` 重新编码 → `ManageGateway` 解出 `rejected.reason` → `SettingsStore` 匹配 `LOGIN_DEVICES_STILL_CHANGING`，四层形状一致；服务端 `http-gateway-server.ts:953` 只放行白名单 reason code，`LOGIN_DEVICES_STILL_CHANGING` 在 `GATEWAY_ERROR_REASON_CODES` 里。结论：真实服务器返回时能识别，但缺少真实传输层反向测试（意见 3）。
- **不合规范/不可信输入**：`recentAuthenticationRef` 客户端占位符 `"device"` 必须等于服务端 `DEVICE_REFERENCE_PLACEHOLDER`，否则 `classifyDeviceGatewayRequest` 直接 400；核对通过。`dataClassification` 四个取值在 `classificationSchema` 与 `TEXT_ADMISSION_CLASSIFICATIONS` 两端一致。服务端错误字符串由 `JSONEncoder` 重新编码，无注入问题。
- **安全与权限**：`capability.disable` 是 change 档，`ManageGateway` 先取 `approvals/challenge` 再带确认签名；服务端 `confirmed` 且能取到 owner binding 时才生成 `device_confirmation_key` 证据，`RecentAuthenticationGuard` 再核对。结论：第 1 条修复在真实路径成立。`tighten` 档不过面容与作者说法不一致，见意见 1。
- **资源耗尽**：文件分页的重复请求被 `loadingMoreFiles` 挡住；刷新与加载更多并发仍可能重复请求/覆盖，见意见 2。
- **不可撤销操作**：`capability.disable` 会取消依赖任务且不自动恢复，但这是页面既有语义，本次增量未改变；没有新增不可撤销操作。
- **规则/文档一致性**：操作账本文案已改对，但 ADR 0192 未跟上，见意见 4。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次 PR 503 增量只改客户端 `HimawariManage`、`HimawariCore` 的错误类型和测试，以及 `ci/operations-pending.json`；没有改系统提示、工具定义、历史消息或遮盖结果。所有每轮变化的值（`idempotencyKey`/`messageId`、一次性 challenge、服务端错误 `reasonCode`、`recentAuthenticationRef` 占位符）都只出现在设备签名网关的请求体里，不会进入模型消息。合并进来的 PR 527 属于另一个 PR，本轮只确认它在 `clients/apple` 增加了 3 个 Generated 能力项；它的模型 prompt 构造没有逐行复核，标「未核实」。

2. **不会让同一段文字在不同请求里变成不同字节。** 新增的值是静态占位符 `"device"`、服务端返回的错误码、原记忆自带的分级；没有时间字段、无序集合或依赖前后文的遮盖进入模型可见文本。`uploadText` 的 `content` 原样上传；文件 `before` 游标来自服务端并原样回传。相对时间的格式化只影响 UI 显示，不发给模型。

3. **有自动检查，但覆盖不完整。** 第 1 条的反向用例有效：`SettingsStoreTests` 断言 `capability.disable` 的 payload 键集合必须包含 `recentAuthenticationRef`，去掉会失败。第 4 条的反向用例有效：`MemoryStoreTests` 断言上传分级是 `sensitive`，改成 `private` 会失败。第 2 条的反向用例**不会失败**：测试绕过了 `SignedDeviceTransport`；第 10 条的并发保护也**没有反向用例**。另外，修复提交自述 Swift 未编译、测试未运行，所以新增 Swift 测试是否通过尚无证据。

4. **每个新值两端都能接受（除一个条件性降级风险）。**
   - `recentAuthenticationRef: "device"`：契约 `capability.disable` 接受 `nullable(machineString)`；服务端要求占位符必须等于 `DEVICE_REFERENCE_PLACEHOLDER`，确认通过后替换成真实 `authenticationRef`；`capability.disable` 是 change 档，会带 challenge/confirm。可用。
   - `reasonCode`：服务端错误体形状是 `{error:{code,reasonCode}}`，`reasonCode` 只放行白名单；`DeviceTransport` 重新编码后 `ManageGateway` 按 `error.reasonCode` 解码，`SettingsStore` 匹配的 `LOGIN_DEVICES_STILL_CHANGING` 在白名单里。可用。
   - `MemoryItem.dataClassification`：服务端 `memory.overview.snapshot` 输出 `memory.dataClassification`，契约取值 `public/private/sensitive/restricted`；文本上传接口 `parseTextAdmission` 接受同一组四个值。可用；但客户端回退 `private` 是条件性降级风险，见意见 6。
   - 合并新增的 `proactive.sources.read`、`proactive.source.settings.set`、`proactive.source.switch_off`：`ClientCapabilities.swift` 与 `packages/gateway-contracts/src/client-capabilities.ts`、`contracts-v2.ts` 三处一致，且没有 PR 503 的 Swift 调用方，仍在待接入名单。可用。
   - `loadingMoreFiles`：内部 `Set<FileOrigin>`，`FileOrigin` 是 `Hashable`；不参与序列化。可用。
