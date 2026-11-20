**本轮查过范围**：`git diff c704859..00a9660` 的代码增量（排除 `.agents/reviews` 下的二进制复核记录）、`git diff 3cbd773..00a9660 -- clients/apple` 的 PR 561 完整 Swift 改动，以及 `deploy.sh`、`make-packet.py`、`maintenance-common.mjs`、`run-maintenance.mjs`、`S7-switch-start-readback.py`、`prepare-arm.sh`、网关契约和对应测试。`TuningFormat.swift`、`TuningModels.swift` 与 `packages/gateway-contracts/src/validation.ts` 在 `c704..00a9660` 之间没有改动（`git diff --stat` 输出为空）。

### 1. 低：上一轮“极端整数会让步进溢出”的意见没有改好，客户端仍不做范围校验

文件:行：`clients/apple/Sources/HimawariManage/Settings/TuningFormat.swift:47-55`、`clients/apple/Sources/HimawariManage/Settings/TuningModels.swift:69-73`、`:80-93`

问题：`stepUp`/`stepDown`/`step` 直接对服务器下发的 `value`、`minimum`、`maximum` 做加减乘除，没有在 `TuningItem.init` 里校验 `minimum <= maximum`、`value` 是否在区间内，也没有防止 Int 溢出。上一轮意见指出的路径在增量里完全没有改。

证据（读代码证实）：

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

```swift
public var step: Int {
    let span = max(1, maximum - minimum)
    ...
}
```

`git diff --stat c704859..00a9660 -- .../TuningFormat.swift .../TuningModels.swift` 输出为空，说明这两个文件在这一轮增量里没有修改。也就是说，如果按上一轮意见要求“客户端校验服务器下发的 min/max/value”，这条没有落实。

补充已核实的约束：网关契约的 `integer(0)` 上限是 `Number.MAX_SAFE_INTEGER`（`packages/gateway-contracts/src/validation.ts:140-146`），正常后端不可能发出超过 2^53-1 的值；`minimum`/`maximum` 也被限制为非负整数。因此通过合规后端时，`Int64` 溢出无法触发。风险只存在于服务器违反契约、响应被篡改或客户端复用了非网关来源的数据。

推测：如果响应中出现 `Int64.max`/`Int64.min`，`stepUp` 的 `raw + 1`、`stepDown` 的 `raw - 1`、`maximum - minimum` 都可能触发 Swift 的整数溢出 trap，应用直接崩溃；这类输入没有测试覆盖。

建议：在 `TuningItem.init` 校验 `minimum <= maximum`、`minimum <= value <= maximum`，并限制在安全整数范围内；步进计算改用不会溢出的写法或先做边界钳制；补 `Int64.max`/`Int64.min`、`minimum > maximum`、`value` 越界四个反向用例。

### 2. 低：关闭历史比对后 `s8-history-preserved.json` 的文档描述与代码不完全一致

文件:行：`scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:42`、`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:1028`

问题：文档说关闭比对时 `s8-history-preserved.json` “只写”`historyComparison`、原因、授权消息和版本标签，`tables` 为 `null`；代码实际还写了 `schemaVersion`、`passed`、`checkedAt`、`reference`、`recoveryId`。如果“只写”按字面理解，文档是错的。

证据（读代码证实）：

```python
if comparison.mode === "off" return {
  schemaVersion: "himawari.__PKT_LABEL__-change-history-preserved.v1",
  passed: true,
  checkedAt: new Date().toISOString(),
  reference: copyPath,
  recoveryId,
  ...historyComparisonEvidence(comparison),
  tables: null,
};
```

```md
`s8-history-preserved.json` 只写 `historyComparison: "off"`、原因（`historyComparisonReason`）、授权消息（`historyComparisonAuthorizedBy`）和版本标签（`historyComparisonRelease`），`tables` 为 `null`，没有 `allowedStartupRecoveryColumns` 和 `ignoredHistoryColumns`
```

建议：把文档改成“除常规元数据外，只额外写这些字段”，或明确列出仍会保留的 `schemaVersion`/`passed`/`checkedAt`/`reference`/`recoveryId`。这不是生产逻辑错误，但会让操作者按文档核对证据时误以为字段缺失。

### 3. 低：新增的 `isDeclined` 把“未知错误”当成用户取消，可能静默吞掉真正的故障（推测）

文件:行：`clients/apple/Sources/HimawariManage/Settings/SettingsStore.swift:115-118`、`clients/apple/Sources/HimawariManage/Settings/CapabilitiesPage.swift:63-72`

问题：`isDeclined` 的实现是“只要不是这五类已知错误，就算用户取消”。于是未来新增的错误类型、第三方框架错误或未预料到的实现错误都会被当作“用户取消”，既不显示失败提示，也不记录日志。

证据（读代码证实）：

```swift
public static func isDeclined(_ error: Error) -> Bool {
    !(error is ManageGatewayError || error is DeviceAPIError || error is DeviceKeyError || error is DecodingError
        || error is URLError || error is HTTPExchangeError)
}
```

```swift
} catch where SettingsStore.isDeclined(error) {
} catch {
    store.noteReactivationFailure(M.reactivateFailed, for: item.capabilityRef)
}
```

推测：如果 Face ID/确认流程确实只会抛出 `CancellationError`，或者某一种明确的“用户取消”错误，那么当前写法会把其他未知错误一并吞掉；如果未来网关新增错误类型，用户会看到开关弹回但没有任何说明。

建议：改成只识别明确的取消错误（例如 `CancellationError`，以及确认流程自己的取消错误），其余错误走失败提示；至少对未知错误记录一次日志。若维持现状，应在测试里明确“未知错误也视为取消”的设计。

**读代码证实的和推测的区分**：第 1 条的代码现状、契约上限、增量未修改都是读代码证实的；“恶意/不合规服务器能触发崩溃”是按代码路径推测的。第 2 条是文本/代码对照证实的。第 3 条逻辑本身是证实的，但“实际有哪些未知错误会被吞掉”是推测。

**侧重检查**：

- **不可信输入**：检查了 `TuningItem` 对服务器下发的 `value`/`minimum`/`maximum`/`kind`/`storageUnit`/`unitLabel` 的解码；枚举和类型错误会回退而不是崩溃，但整数范围没有校验（第 1 条）。检查了 `lastInvalidation.occurredAt` 的解析，解析失败会显示空而不是崩溃；`cancelledScheduledJobs` 只做字符串插值，没有注入风险。
- **错误路径**：检查了改设置的保存失败、取消、并发重入；取消被静默处理（第 3 条），保存失败会显示“没能保存”。检查了历史比对关闭后的 S3/S7/S8 路径和 S9 强制重新开启比对的路径；未发现开关漏接到 S9。
- **不可撤销/安全**：检查了 `historyComparison` 关闭会跳过的历史比较、迁移保护拒绝和 S8 逐行比较；开关必须带原因、授权消息和版本标签，且版本不符会拒绝生成上线包。检查了 `onDeployFailure=keep` 的失败保留现场路径：失败发生在停服前仍走 `stopped-before-service-stop`，停服后才会保留现场；未知取值在改动服务器前退出。`prepare-arm.sh` 的 AppArmor 规则文件内容不同会失败，加载失败会失败。
- **资源耗尽**：`TuningItem.step` 的循环次数受 `span / (step * 10) >= 20` 限制，不会无界增长；`DateComponentsFormatter` 只在格式化单个值时创建，未发现明显资源放大。
- **文档与代码一致性**：`.agents/instructions/delivery-mode.md` 对 `historyComparison`/`onDeployFailure`/S9 的描述与代码基本一致；`P-readback-design.md` 的字段描述有第 2 条的措辞问题。`prepare-arm.sh` 与 runbook、测试中的包名和规则文件变量一致。
- **未核实**：我没有运行 Swift、Node、Python 测试；本机无法编译 Swift；AppArmor 规则的实际加载行为也没有执行验证。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不涉及。增量没有改 `packages/prompt-catalog`、`runtime-pi`、会话历史组装或出口遮盖相关文件；改动集中在 iPhone 设置 UI、网关设置快照字段、上线维护脚本和 CI。按 `.agents/instructions/prompt-prefix.md:27-28`，发给模型的内容仍应是“工具定义 → 系统提示 → 历史 → 最后一条消息”，本次没有新增每轮变化值，也没有改历史或系统提示。未核实项：我没有运行 `npm run check:prompt-prefix`。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及模型请求。`kind`/`storageUnit` 是按配置键固定的枚举值；`historyComparison`/`ON_DEPLOY_FAILURE` 是按上线包固定的值；没有改遮盖、JSON 键顺序或模型消息序列化。`TuningFormat` 的显示会随设备语言、当前日期变化（例如 `disabledAt`），但那是屏幕文字，不是发给模型的请求字节；`startedAt`/`checkedAt` 使用当前时间，是既有证据字段，也不进入模型请求。

3. **有没有自动检查，反向用例是否真的会失败？** 有，但不完整：
   - `TuningFormat`：Swift 测试覆盖了比例、时长、毫秒不足一秒、无 `kind`/未知 `kind` 的降级；`test/integration/think-settings.test.ts` 用非法 `kind`/`storageUnit` 断言网关契约失败；`production-delivery-timing-control.test.ts` 断言每个设置项的 `kind`/`storageUnit`。**没有**极端整数、负值、`minimum > maximum` 的用例，所以上一轮第 1 条没有能失败的回归测试。
   - 历史比对关闭：`verify-fixtures.mjs`、`test_make_packet.py` 有“别的版本标签拒绝”“关闭时迁移历史不同仍通过”“其他迁移段仍比较”“S9 强制重新比较”等反向断言；从代码看这些断言会失败（若实现回退）。
   - `onDeployFailure`：`KeepFailedDeployTest` 覆盖 `keep`/`rollback`、环境变量覆盖、未知取值、停服前失败和成功路径；从代码看反向断言完整。
   - `prepare-arm.sh`：测试只比对包名、规则文件内容和关键字，没有执行退出码 75/76 的分支。
   - 我没有实际运行上述测试，以上是阅读断言后的判断。

4. **每个新增/修改值的直接使用端能否接受？** 逐个核对结果：
   - `kind`/`storageUnit`：产生于 `production-delivery-timing-control.ts:65-66`、`production-think-settings.ts:238-239`；网关契约 `contracts-v2.ts:560-572`、`:900-904` 的枚举接受这些值；Swift `TuningModels.swift:92-93` 按可选字符串解码，缺字段或未知值会回退到文本显示，能接受。测试也覆盖了字段存在和非法值。
   - `HISTORY_COMPARISON`：产生于 `make-packet.py:446`，用于 `S7-switch-start-readback.py:25` 和 `verify-fixtures.mjs:35`；只接受 `on`/`off`。
   - `HISTORY_COMPARISON_JSON`：产生于 `make-packet.py:447`，经 `render` 替换进 `maintenance-common.mjs:804` 的 JS 对象字面量；`checkedHistoryComparison` 校验 `mode`、键集合、原因和版本标签，能接受。
   - `ON_DEPLOY_FAILURE`：产生于 `make-packet.py:448`，由 `deploy.sh:51-61` 读取，只接受 `rollback`/`keep`；缺省时回退 `rollback`，测试覆盖。
   - `historyComparison`/`onDeployFailure` 实例键：`make-packet.py:420-436` 校验后才进入参数；`andy-production.json` 的 `release: "twentyninth"` 与当前标签绑定，别的标签会被 `PACKET_HISTORY_COMPARISON_OFF_FOR_OTHER_RELEASE` 拒绝。目前没有发现使用端接受不了的值。
   - 新增证据字段 `historyComparison`、`historyComparisonReason`、`historyComparisonAuthorizedBy`、`historyComparisonRelease`，以及 `s8-history-preserved.json` 在关闭时缺少 `allowedStartupRecoveryColumns`/`ignoredHistoryColumns`：我用 `grep` 查了 `scripts/`，没有发现对这些字段做严格结构校验的消费者；已有的 `S9-clean-transport.py` 只读 `newUnitSha256` 等字段，不受影响。唯一问题是第 2 条的文档措辞。
   - `ci/operations-pending.json` 移除 `capability.reactivate`：`scripts/check-operations.mjs` 会把 Swift 前端文本和 TS 测试一起算作调用方/测试，`SettingsStore.swift` 和 `test/integration/production-capability-reactivation.test.ts` 都存在对应字面量，使用端能接受。
   - `prepare-arm.sh` 新增的 `bwrap`/`socat`/`rg`/AppArmor 规则：`test/tooling/ci-runner-scripts.test.mjs` 与 `prepare-vps.sh` 的名称和内容一致，runbook 也更新了；没有发现直接使用端不匹配。
