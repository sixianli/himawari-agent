## 本轮范围

- 逐行看了增量 `aa35fdb..2c7bd78`：`DeviceKeys.swift`、`SecureEnclaveKeys.swift`、`HomeActPresenceTests.swift`，以及同批的复核记录提交。
- 顺着新值 `keyUnreadable` 查了使用端：`OwnerPresenceSigner`、`MenuBarModel`、`PairingProblem.from`、`PairingAttempt.mayHavePaired`、`SecureEnclaveKeyStore.presence/exists`，并确认没有遗漏的 `switch`。
- 顺着上一轮新增的 confirm 链路核了服务端两端：`issueConfirmChallenge` → 客户端 `confirmChallenge` → `DeviceRequest.nonce` → `verifyDeviceRequest`/`#challengeValid`。
- 查了低意见修改门槛 `lowFixProblems`/`isTestFile` 与 Swift 测试目录的关系。
- 没有重读与本增量无关的旧代码；提到旧代码的地方都在下面注明。

### 1. 中 — 关键修复所在的代码路径没有任何自动检查，反向用例不会失败

文件：`clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:23-31`、`clients/apple/Tests/HimawariCoreTests/HomeActPresenceTests.swift:118-134`、`clients/apple/Package.swift:21-24`

问题：这一轮实际改的生产代码是 `SecureEnclaveKeySigner.sign` 里把 `store.load` 的失败转成 `keyUnreadable`，但新增测试用的 `FaultyKey` 从 `sign` 直接抛出 `DeviceKeyError`，完全没有走到 `SecureEnclaveKeySigner`；而 `SecureEnclaveKeys.swift` 整个文件被 `#if canImport(CryptoKit) && canImport(Security) && canImport(LocalAuthentication)` 包住，Linux 的 `swift test` 根本不编译它，`Package.swift` 在 Linux 也只建 `HimawariCore`/`HimawariCoreTests`，不建 `HimawariMacUI`/`HimawariShell`。因此把 `SecureEnclaveKeys.swift` 的改动整段撤回，现有测试仍然会通过。

读代码证实的：

```swift
// SecureEnclaveKeys.swift:23-31
let key: SecureEnclave.P256.Signing.PrivateKey
do {
    key = try store.load(role, context: role == .confirm ? context : nil)
} catch let error as DeviceKeyError {
    throw error
} catch {
    throw DeviceKeyError.keyUnreadable(role)
}
return try key.signature(for: message).rawRepresentation
```

```swift
// HomeActPresenceTests.swift:120-123
struct FaultyKey: DeviceKeySigner {
    let fault: DeviceKeyError
    func publicKeySPKI() throws -> Data { throw fault }
    func sign(_ message: Data, reason: String?) async throws -> Data { throw fault }
}
```

这个 `FaultyKey` 测的是 `OwnerPresenceSigner` 原本就有的 `catch let error as DeviceKeyError { throw error }`，不是这一轮的转换逻辑。

建议：把“从 `store.load`/`signature` 到 `DeviceKeyError` 的归类”抽成一个 Linux 可编译的纯函数并直接测；或者在 macOS 目标里加一条真正驱动 `SecureEnclaveKeySigner` 的测试。无论如何要有一条反向用例：删掉上面的 catch 后必须失败。

### 2. 低 — 低意见修复被复核门槛当成“没改测试”拒绝，Swift 测试路径与工具规则不一致

文件：`scripts/model-review/opencode-review.mjs:1234-1243`、`scripts/model-review/opencode-review.mjs:1338-1343`；增量提交 `c73ca8f69`、`2c7bd789f`

问题：低意见修复确实改了 `clients/apple/Tests/HimawariCoreTests/HomeActPresenceTests.swift`，但门槛的 `isTestFile` 只认小写 `test`/`tests` 目录和 `.test.`/`.spec.` 等扩展名，不认 `clients/apple/Tests/`，也不认 `*Tests.swift`。于是这次修复会被判 `no-test-change`，提交 `2c7bd789f` 说的“修改被拒”就是这条路径。

读代码证实的：

```js
export function isTestFile(path) {
  if (/\.md$/i.test(path)) return false;
  return (
    /(?:^|\/)(?:test|tests|__tests__)\//.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(?:^|\/)test_[^/]*\.py$/.test(path) ||
    /_test\.(?:py|go|rs)$/.test(path) ||
    /(?:^|\/)[A-Z][A-Za-z0-9]*Test\.java$/.test(path)
  );
}
```

`clients/apple/Tests/...` 里的 `Tests` 是大写，正则区分大小写，匹配不到；文件名也不是 `.test.*`。

建议：把 Swift 的 `Tests/` 目录和 `*Tests.swift` 加进 `isTestFile`，并在 `test/tooling/opencode-review-merge-gate.test.mjs` 补反向用例。否则这类“改测试但不改现有识别扩展名”的低意见修复会一直走不过门槛。

### 3. 低 — 原意见只修了“钥匙解不开”，签名阶段的真实故障仍会被吞成用户取消；按位置而不是错误类型分类还可能误判取消

文件：`clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:23-31`、`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:133-141`

问题：`do/catch` 只包住 `store.load`；`key.signature(for:)` 仍在外面。`OwnerPresenceSigner` 对所有非 `DeviceKeyError` 一律转 `declined`，所以签名阶段除了用户取消/认证失败之外的真实故障仍会静默消失，和上一轮意见“真实故障会静默消失”属于同一类，只是来源从解码换成了签名。

读代码证实的：

```swift
// SecureEnclaveKeys.swift:31
return try key.signature(for: message).rawRepresentation
```

```swift
// MenuBarFeed.swift:133-140
do {
    return try await key.sign(message, reason: reason ?? self.reason)
} catch let error as DeviceKeyError {
    throw error
} catch {
    throw OwnerPresenceError.declined
}
```

推测：`store.load` 是否会在构造 `SecureEnclave.P256.Signing.PrivateKey` 时就求值 `LAContext`，我没有核实。如果会，那么用户取消会在新的 catch 里被当成 `keyUnreadable`，`MenuBarModel` 会把它当真实故障标红，违反“取消不显示错误红字”。这一点需要按 Apple 的实际行为确认。

建议：不要靠“哪个调用点抛的”分类，改成按错误类型分类——`LAError.userCancel`/认证失败 → `declined`，其它 → `keyUnreadable`，并同时覆盖 `load` 和 `signature` 两处。这样既补上签名阶段的真实故障，也避免误报取消。

## 侧重检查

- 错误路径：查了 `load` 失败、`signature` 失败、`OwnerPresenceSigner.declined`、`unavailable`、`keyMissing`/`keyUnreadable`/`keychain` 的分流。发现第 3 条问题。
- 不合规范/不可信输入：confirm 挑战值由服务端 `issueConfirmChallenge` 生成，客户端 `confirmChallenge()` 不校验格式就直接当 nonce 写进 `Signature-Input`。核对了两端：服务端值是 34 字节 base64url（46 字符），落在 `NONCE_PATTERN /^[A-Za-z0-9_-]{16,64}$/` 内，`#challengeValid` 只接受按 deviceId 计算 MAC 且未过期的值；device 和 confirm 共用同一组签名参数，`confirmMember.nonce === deviceMember.nonce` 能过。客户端未做本地格式校验属于旧的、未改的代码，本轮增量没有让它更差；若要加防御，可以在把挑战值当 nonce 前先按同一字符集/长度检查。
- 安全：确认密钥仍用 `.userPresence` 的 Secure Enclave 钥匙；`DeviceKeyError` 仍原样上抛，不打印私钥或挑战值；新增 `keyUnreadable` 不暴露底层错误内容。没有发现本次增量引入的权限放宽。
- 资源耗尽：每次点击最多一次 `approvals/challenge` 加一次 `home/act`，取消后不刷新；没有新增循环或无上限集合。服务端 replay 缓存的上限是旧代码。
- 不可撤销操作：`act` 是审批动作，取消/签名失败时不发 `home/act`；`requestId` 在成功/4xx/declined 时清掉，重试逻辑未变。
- 规则/文档与代码一致性：`prompt-prefix` 规则与本次改动无关；发现的是第 2 条的“低意见测试门槛不认 Swift Tests 目录”不一致。
- 未核实：`LAContext` 在 `PrivateKey(dataRepresentation:authenticationContext:)` 阶段是否求值；macOS 上实际编译和运行结果（本轮没有 macOS 环境）；`.agents/reviews` 记录的实际内容（被仓库规则屏蔽，未读）。

## 必答问题

1. **不会，也不涉及。** 这次增量只动 macOS 客户端的设备签名/错误类型，没有碰系统提示、工具定义、历史消息或出口遮盖的组装代码。发给模型的内容仍然只在末尾追加；每轮变化的值没有新增到请求开头。设备请求里的 `created`、challenge/nonce 每次不同，但那是 HTTP 签名头，不是发给模型的内容。

2. **不涉及模型文本。** 增量没有产生依赖前后文的遮盖、带时间的模型字段或无序列集合。设备签名本来就会因时间戳和服务端挑战值逐请求不同，这是认证协议的要求，与模型请求的字节确定性无关；修改后的代码没有影响模型侧的确定性。

3. **有测试，但不足以证明这次修复。** happy path、取消、无 signer、钥匙错误上抛都有用例；问题在于真正被修改的 `SecureEnclaveKeySigner` 转换路径没有任何用例覆盖，Linux 不编译该文件，把修复撤掉测试也不会红；同时低意见门槛不认 Swift 测试路径（见第 1、2 条）。

4. **增量产生的值只有一个：`DeviceKeyError.keyUnreadable(DeviceKeyRole)`。** 产生端是 `SecureEnclaveKeySigner.sign`；使用端逐项核对：
   - `OwnerPresenceSigner.sign` 用 `catch let error as DeviceKeyError` 原样上抛，能接受；
   - `MenuBarModel.respond` 落到通用 `catch` 标 `failedItem`，能接受，符合“真实故障要显示”的意图；
   - `PairingProblem.from` 返回 `.keysUnavailable`，`PairingAttempt.mayHavePaired` 返回 `false`，语义保守但能接受；
   - 全仓库没有对 `DeviceKeyError` 的穷尽 `switch`，新增 case 不会造成编译遗漏。
   - 另核对上一轮新增的 challenge→nonce 链：服务端产生 46 字符 base64url，客户端直接作为 `nonce`，服务端 `NONCE_PATTERN` 和 `#challengeValid` 都接受；device/confirm 使用同一组参数，nonce 相等校验能过。
   - 未核实项：`SecureEnclaveKeyStore.presence/exists` 仍只检查 `readRepresentation`，不会反映新增的 `keyUnreadable`；即“数据读得出但解不开”的钥匙在恢复判断里仍算 `present`，要到签名时才报错。这是旧行为，增量没有改变它，但新错误名和 `presence` 的语义确实不完全一致。
