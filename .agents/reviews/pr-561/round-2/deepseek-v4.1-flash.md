本轮查过：`574ffb7..e47d9a9` 的增量（`TuningFormat.swift`、`TuningPages.swift`、`SettingsStoreTests.swift` 及新增复核记录），并顺着调用读了 `TuningModels.swift`、`SettingsStore.swift`、`SecureEnclaveKeys.swift`、`DeviceTransport.swift`、`HTTPExchange.swift`，以及服务器端 think/delivery 的变更校验与合约。增量没有触碰的旧代码没有整份重读；复核记录文件按工具限制未读。本机不能编译 Swift，作者说 Mac 已跑过 `swift test`，未核实。

### 1. 中：`declined()` 仍是“未列入的错误一律当取消”，上一轮意见 3 只修好了网络错误
文件：`clients/apple/Sources/HimawariManage/Settings/TuningPages.swift:126`、`clients/apple/Sources/HimawariCore/HTTPExchange.swift:21`、`clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:26`

问题：这个判断的默认方向仍是“不认识的错误就当用户取消并静默忽略”。这次把 `URLError` 加进失败集合，修好了超时/断网被吞掉的问题；但 `HTTPExchangeError.notHTTP` 等未列入的错误仍会被吞掉，真正的取消和失败也仍没有分开。上一轮意见 3 的后半句“真正的取消反而可能显示没能保存”没有被明确处理。

读代码证实的：
- `TuningPages.swift:126-128`：`declined` 返回 `!(error is ... || error is URLError)`；`catch where Self.declined(error)` 直接忽略，第二个 `catch` 才设 `failed = true`。
- `HTTPExchange.swift:21-24` 定义了 `HTTPExchangeError.notHTTP`，`HTTPExchange.swift:35` 会抛出它；它不在白名单里，所以会被当作取消静默吞掉。
- `URLError(.cancelled)` 现在会进入 `catch { failed = true }`，因为整个 `URLError` 都被判成失败。
- `SecureEnclaveKeys.swift:26-32` 把 `store.load` 的非 `DeviceKeyError` 包装成 `DeviceKeyError.keyUnreadable`；而 `DeviceKeyError` 在白名单里，会显示“没能保存”。

推测：Face ID 取消究竟从 `store.load` 还是从第 33 行的 `key.signature(for:)` 抛出，未在真机核实。若从前一处抛出，会显示失败；若从后一处抛出，是未列入的错误，会被静默当作取消。

建议：把判断改成“只有明确取消才算取消”，默认失败；明确识别 `CancellationError`、`URLError(.cancelled)`、`LAError.userCancel/.userFallback`，其余（包括 `HTTPExchangeError`、`DeviceKeyError`、`URLError` 的网络错误）一律报失败。`SecureEnclaveKeySigner` 也应把用户取消和真正的密钥错误区分开，而不是统一包成 `keyUnreadable`。补对应测试。

### 2. 中：毫秒档在 1 秒以上仍未“按显示单位步进”，上一轮意见 2 只解决了 1 秒以下
文件：`clients/apple/Sources/HimawariManage/Settings/TuningFormat.swift:36`、`:64`、`:71`

问题：新增的 `seconds < 1 ? 0.1` 只覆盖 1 秒以下。对于 `storageUnit = .ms` 且秒数不是整数的值（例如 1100–59999 ms 中大量非整秒值），`text()` 会退回服务器给的原样文字“1100 毫秒”，但 `stepSize` 已经进入 `seconds < 60` 的 1 秒档，步长变成 1000 ms。显示单位是毫秒，步进却是 1 秒，和作者说的“步进器按显示单位走”不一致，这些合法值仍无法通过步进到达。

读代码证实的：
- `TuningFormat.swift:64`：`seconds < 1 ? 0.1 : seconds < 60 ? 1 : ...`，1100 ms 的 `seconds` 是 1.1，取 `tier = 1`，再除以 `perUnit = 0.001` 得 1000 ms。
- `TuningFormat.swift:71-72`：`guard seconds >= 1, seconds.rounded() == seconds else { return nil }`，1.1 秒不满足整数秒，`text()` 在 `:37` 退回 `plain(raw)`，显示“1100 毫秒”。
- 因此 `stepUp(1100) = 2000`、`stepDown(1100) = 1000`；1101–1999 ms 这类值只能作为服务器默认值出现，不能靠步进选中。

建议：显示退回“毫秒”时，步长也按毫秒粒度走（例如沿用 `step` 的跨度步长或固定 100 ms），或者让 `durationText` 把非整秒显示成小数秒（如“1.5 秒”）并与 1 秒档一致。补 1100、1500、1999、2001 ms 和最大值边界的测试。

### 3. 低：错误分类改动没有自动检查，反向用例缺失
文件：`clients/apple/Tests/HimawariManageTests/SettingsStoreTests.swift:190`、`clients/apple/Sources/HimawariManage/Settings/TuningPages.swift:126`

问题：步进改动有自动检查，但 `declined` 的改动完全没有测试，也没有反向用例；原来的“网络错误被静默吞掉”可以再次悄悄回归。

读代码证实的：
- 新增的断言是 `stepUp(250) == 300`、`stepDown(300) == 200`、`stepDown(1000) == 900`、`stepUp(900) == 1000`。按旧逻辑（没有 `seconds < 1` 分支）推演，前两者分别会得到 1000 和 200，所以这两条确实能抓住旧 bug。
- 在 `HimawariManageTests` 中没有找到任何 `declined`、`URLError` 或保存失败路径的测试。

建议：把 `declined` 抽成 internal 的纯函数，直接测 `ManageGatewayError`、`DeviceAPIError`、`DeviceKeyError`、`DecodingError`、`URLError(.notConnectedToInternet)`、`URLError(.cancelled)`、`CancellationError`、`HTTPExchangeError.notHTTP` 和未知错误；或者加一个页面模型的保存失败/取消测试。

## 侧重检查

- 错误路径：查了 `TuningEditPage.save` 的 catch 顺序、`declined` 的类型判断、`SignedDeviceTransport` 对 `DeviceAPIError.server` 的转换、`URLSessionExchange` 抛出的 `URLError` 和 `HTTPExchangeError.notHTTP`，以及 Face ID 签名错误的产生处。结论见意见 1、3。
- 不可信/边界输入：`TuningItem` 对服务器 JSON 的 `kind`、`storageUnit` 用 `try?` 加 `flatMap`，未知值回退到普通显示；新分支用 `Double(max(raw, 0))` 和 `max(1, ...)`，没有新增除零或 Int 溢出；对合法范围内的值，`stepUp` 只夹最大值、`stepDown` 只夹最小值，不会越界或卡住。旧代码里 `raw - 1` 遇到 `Int.min` 的溢出风险不是本轮增量，未展开。
- 资源耗尽：没有新增无界循环或大分配；`spacedChinese` 只处理格式化结果。
- 不可撤销操作：调整设置是 owner 命令，需要 Face ID；增量没有改 payload、幂等键或写入顺序，失败后 `changeTuning` 仍会重载 tuning，不会产生重复提交。
- 规则/文档一致性：增量没有改规则或文档。作者“步进器按显示单位走”与意见 2 的 1 秒以上行为不一致；“没有 kind/storageUnit 时回退”与代码一致；“中文空格只对中文”与 `TuningFormat.swift:82` 一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。增量只改 iOS 客户端的显示格式化、步进和保存错误分类，没有改系统提示、工具定义、历史、遮盖或任何请求序列化，也没有新增每轮会变的值。依据是 `prompt-prefix.md` 的 §一（固定在前、会变的只在最后一条消息）和 §二（已发出的内容只追加）。
2. **同一段文字会不会在不同请求里变成不同的字节？** 不涉及。增量没有改遮盖、时间字段或集合顺序；`step` 产生的是确定的 `Int`，只影响本地显示和保存值。保存时的 `reason` 依赖当前语言是既有行为，不是本次增量引入。
3. **有没有对应的自动检查，反向用例会失败吗？** 步进有，新增的 `250→300`、`1000→900` 两条按旧代码推演会失败，能抓住旧 bug；`declined` 没有任何自动检查，也没有反向用例，见意见 3。
4. **每个值的产生端和使用端都能接受吗？** 本次增量没有新增标识、配置键、清单项或序列化格式。`stepSize` 产生的步长只被 `stepUp`/`stepDown` 使用（`TuningPages.swift:81-82`），两者都在 `minimum`/`maximum` 内夹取；结果经 `SettingsStore.changeTuning` 作为 `value` 发送（`SettingsStore.swift:134-138`）。服务器端 think 要求 `Number.isSafeInteger` 且在定义范围内（`production-think-settings.ts:241-245`），delivery 要求落在 `DELIVERY_TIMING_RANGES` 内（`production-delivery-timing-control.ts:92-99`），合约要求 `integer`（`contracts-v2.ts:585`）；新的毫秒步进值如 300 ms 落在 `timeoutMs` 的 `[200, 10000]` 内（`delivery-timing.ts:45`），能通过两端校验。另需注意：当前 HEAD 的服务器快照和合约并不发送 `kind`/`storageUnit`（对比基准 83c0 有，但该提交不在本分支祖先链上，不是本分支删的），所以当前实际只走作者声明的降级路径；新格式化/步进路径目前只有单测覆盖，没有与真实服务器联调的证据（未核实）。
