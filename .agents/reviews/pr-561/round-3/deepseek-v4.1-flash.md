本轮查过的范围：`e47d9a920..c704859` 增量（运行代码只改了 `TuningPages.swift` 的一行）；`HTTPExchangeError` 的定义与产生点；保存路径可能抛出的错误类型；`declined` 的唯一使用点；现有 Swift 测试是否覆盖；以及材料点名的 `TuningFormat.swift` 边界值、步进、降级与中文空格。未运行 `swift test`；`.agents/instructions/prompt-prefix.md`、`docs/incidents-and-gates.md` 在当前稀疏检出中不存在，未读到原文。

### 1. 中：`declined()` 仍是“未列入的错误一律当取消”，本轮只补了 `HTTPExchangeError`，上一轮意见未真正改好

**文件:行**：`clients/apple/Sources/HimawariManage/Settings/TuningPages.swift:117-128`

**问题**：本轮新增 `HTTPExchangeError` 确实修好了“非 HTTP 响应被静默当作取消”这一具体路径，但判定方式仍然是“只要不在失败类型白名单里，就当用户取消”。保存路径上仍可能有未列入的错误被吞掉，既不显示“没能保存”，也不清空草稿；对于修改服务器状态的操作，安全默认应是“失败并提示”，而不是“取消”。另外这个判断是 `private static`，测试无法直接调用。

**证据（读代码证实的）**：

```swift
} catch where Self.declined(error) {
} catch {
    draft = nil
    failed = true
}
```

```swift
private static func declined(_ error: Error) -> Bool {
    !(error is ManageGatewayError || error is DeviceAPIError || error is DeviceKeyError || error is DecodingError || error is URLError || error is HTTPExchangeError)
}
```

未列入清单、但保存链路上可出现的错误至少有：

```swift
// SecureEnclaveKeys.swift:33，外层 do/catch 只包住 store.load，这里的错误不会转成 DeviceKeyError
return try key.signature(for: message).rawRepresentation
```

```swift
// ManageGateway.swift:162，JSONEncoder 失败会抛 EncodingError，也不在白名单
json: try encoder.encode(body),
```

**建议**：改成正向判断用户取消，例如 `error is CancellationError`；如确需把 `URLError(.cancelled)` 视为取消，再显式列出。把它改成可测试的 internal/工具函数，并加表驱动测试：`HTTPExchangeError.notHTTP`、`URLError`、`DeviceKeyError` 都应进入失败分支，只有 `CancellationError` 进入取消分支。基线里原有的 `testOnlyANonServerNonKeyFailureCountsAsDeclined`（曾断言 `HTTPExchangeError.notHTTP` 不是取消）在本差异中被删除，当前测试文件没有再补回等价用例。

### 2. 低：服务器下发的 `minimum/maximum/value` 未校验，极端整数会让步进计算溢出崩溃（旧代码，非本次增量）

**文件:行**：`clients/apple/Sources/HimawariManage/Settings/TuningModels.swift:69-73,83-86`；`clients/apple/Sources/HimawariManage/Settings/TuningFormat.swift:47-55`

**问题**：调参值、最小值、最大值直接从服务器 JSON 解码成 `Int`，没有范围或关系校验。`maximum - minimum`、`raw - 1`、`raw / size + 1` 在 Swift 中遇到 `Int.min`/`Int.max` 会整数溢出 trap，导致 App 崩溃。当前值在正常服务器下不会越界，但这是不可信输入路径。

**证据（读代码证实的）**：

```swift
public var step: Int {
    let span = max(1, maximum - minimum)
    ...
}
```

```swift
func stepUp(from raw: Int) -> Int {
    let size = stepSize(at: raw)
    return min(maximum, (raw / size + 1) * size)
}

func stepDown(from raw: Int) -> Int {
    let size = stepSize(at: raw - 1)
    return max(minimum, ((raw + size - 1) / size - 1) * size)
}
```

**推测**：实际触发需要服务器返回异常极值（例如 `value=Int.min` 后按减号，或无 `kind` 时 `minimum=Int.min, maximum=Int.max`）；正常响应不会触发，因此未升级为更高严重度。

**建议**：解码时校验 `minimum <= value <= maximum`、`maximum >= minimum`，并对极端跨度设上限；步进计算改用带溢出检查的加减，或先 clamp 到 `[minimum, maximum]`。补 `Int.min`/`Int.max` 的反向测试。

**侧重检查**

- 错误路径：`HTTPExchangeError.notHTTP` 由 `HTTPExchange.swift:35` 的 `send` 产生，保存路径可达；`:41` 的 `streamingUnsupported` 只在流式接口产生，保存不走流式。把它归为失败是正确方向。
- 不可信输入：`TuningItem` 的 `value/minimum/maximum` 无校验（见意见 2）；`kind`/`storageUnit` 未知值会降级为 `nil`，不会崩溃。
- 安全与不可撤销操作：增量只改本地错误分类，没有新增网络调用、密钥处理、日志或破坏性操作；调参保存本身可逆。
- 资源耗尽：增量没有新增循环、递归、大分配或并发等待。
- 文档/说明一致性：材料称“Mac 已跑过 `swift test`”，但本轮增量提交 `bc0d589` 的说明写的是“Swift 测试待 Mac 编译；本机无法编译 Swift”，且没有新增对应测试。这一说法与提交记录不一致。
- `TuningFormat` 边界核对：`0`、负数、非整数秒会走 `plain(raw)` 降级；毫秒不足 1 秒也降级为“250 毫秒”，步进按 100 毫秒；最小/最大边界有 `max(minimum, …)`/`min(maximum, …)`，未发现按一下会越界或卡死；中文空格只在 `ManageLanguage.current == .zh` 时调用，不会影响其他语言。未发现新的格式化错误。

**必答问题**

1. **不涉及**：增量只改 iOS 端保存失败的错误分类，不构造或修改 system prompt、工具定义、历史消息、遮盖结果，也没有向模型请求末尾追加任何内容。
2. **不涉及**：增量不产生任何发给模型的字节；`declined` 只是内存中的 `Bool`。`TuningFormat` 的本地化展示只用于界面，且本轮未改。
3. **没有自动检查**：增量只改一行且没有新增/更新测试；`SettingsStoreTests.swift:144-213` 的调参测试不包含 `declined`/`HTTPExchangeError`。把 `|| error is HTTPExchangeError` 删掉，现有测试不会失败。作者称 Mac 跑过 `swift test`，但提交说明写的是“待 Mac 编译”，本机也无法核实。
4. **直接使用端可以接受**：增量产生/修改的值只有 `private static declined(Error) -> Bool`；唯一使用端是 `TuningPages.swift:118` 的 `catch where`，接受 `Bool`。`HTTPExchangeError` 的生产端是 `HTTPExchange.swift:35`（保存可能经过）和 `:41`（保存不经过），类型是 public `Error`，消费端 `error is HTTPExchangeError` 可接受。没有新增标识、配置键、清单项或序列化格式，因此不存在 I-73 那类“清单 id 与后端校验不一致”的问题。
