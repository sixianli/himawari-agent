### 1. 中：新增的 kind/storageUnit 在当前仓库没有生产端，契约还禁止未知字段，生产路径只会走降级

文件：`clients/apple/Sources/HimawariManage/Settings/TuningFormat.swift:31-40`、`clients/apple/Sources/HimawariManage/Settings/TuningModels.swift:63,93`、`apps/agent-service/src/production-think-settings.ts:206-222`、`apps/agent-service/src/production-delivery-timing-control.ts:56-70`、`packages/gateway-contracts/src/contracts-v2.ts:560-579,886-907`、`packages/gateway-contracts/src/validation.ts:186-189`

问题：作者说“数值按服务器给的 kind 和 storageUnit 显示”，但当前仓库的服务端两个 read 实现都不产生这两个字段，网关契约也没有它们。因此本提交上线后，所有真实响应都会走 `plain(raw)`，不会出现“70%”“10 分钟”。

读代码证实的：
- `production-think-settings.ts` 的 `#views` 只返回 `key/value/defaultValue/minimum/maximum/unit/overridden/label/description/unitLabel`，没有 `kind`、`storageUnit`。
- `production-delivery-timing-control.ts:56-70` 只返回 `key/label/description/unit/value/defaultValue/minimum/maximum/overridden`，同样没有这两个字段。
- `contracts-v2.ts` 的两份 snapshot schema 都没有 `kind`、`storageUnit`；而 `validation.ts:186-189` 对 object 的未知字段直接 `fail(... "unknown field")`。
- `test/integration/production-delivery-timing-control.test.ts:122-132` 用 `toEqual` 精确比较 item，也没有这两个字段；`test/integration/think-settings.test.ts:226` 还会把 snapshot 过一遍契约校验。
- 仓库里产生这两个字段的地方只有 `ManageDemo.swift:212` 和 Swift 测试里的手写 JSON。

推测：如果服务器 PR 574 要给这两个字段，它必须同时改 `contracts-v2.ts` 的两份 schema、fixture 和这些精确断言；只改服务端实现的话，snapshot 会在契约层被当作未知字段拒绝，或者现有集成测试直接失败。PR 574 不在本仓库，无法核实。

建议：本 PR 若要与 PR 574 配合上线，至少在说明和测试里明确“当前生产端不产生这两个字段，格式化功能要等契约和服务端一起改”；最好补一条契约级用例，把带 `kind/storageUnit` 的 snapshot 过一遍 `gatewayV2MessageSchema`，否则 I-73 的“两端校验没对上”会再次出现。

### 2. 中：毫秒档的步进粒度和显示单位不一致，201–999 ms 等合法值无法通过步进到达

文件：`clients/apple/Sources/HimawariManage/Settings/TuningFormat.swift:57-69,47-55`、`clients/apple/Tests/HimawariManageTests/SettingsStoreTests.swift:186-189`

问题：`storageUnit == .ms` 时，`stepSize` 先把毫秒换成秒，再按“小于 60 秒就取 1 秒”的档位四舍五入，结果最小步长始终是 1000 ms。显示却会在不足 1 秒时退回“250 毫秒”这种文字，步进和显示单位不一致；中间的大段合法值不可达。

读代码证实的：
- `stepSize` 对 `.ms`：`perUnit = 0.001`，当 `raw = 250` 时 `seconds = 0.25 < 60`，`tier = 1`，`Int((1 / 0.001).rounded()) = 1000`，所以步长是 1000 ms。
- `stepUp(from: 250) = (250 / 1000 + 1) * 1000 = 1000`。
- `stepDown(from: 1000) = max(minimum, ((1000 + 999) / 1000 - 1) * 1000) = max(200, 0) = 200`。
- 测试自己承认 250 ms 是合法显示值（`tuningItem(... minimum: 200 ...)`，并断言 `millis.text(250) == "250 毫秒"`），但没有测 250 ms 的步进。这意味着 201–999 ms 以及 1001–1999 ms 等范围只能由服务端带进来，用户一按步进就跳到 1000/200，回不到原值。
- 这和服务端范围也冲突：`DELIVERY_TIMING_RANGES.timeoutMs` 是 200 到 10000，250 是合法值。

推测：无；上面的取值可直接由代码和测试数据算出。

建议：按 storageUnit 决定步长，而不是一律换算到秒。例如 `.ms` 在 1 秒以下用 100 ms 或 1 ms 一档；或者如果产品确实只想按 1 秒走，就把显示也强制改成秒，并把最小/默认值对齐到 1 秒，避免“能显示但不能步进返回”的值。

### 3. 中：`declined()` 把网络错误当成用户取消，保存失败会被静默吞掉；真正的取消反而可能显示“没能保存”

文件：`clients/apple/Sources/HimawariManage/Settings/TuningPages.swift:110-128`、`clients/apple/Sources/HimawariCore/DeviceAPIClient.swift:151-159`、`clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:20-33`

问题：`declined` 的定义是“只要不是 `ManageGatewayError`、`DeviceAPIError`、`DeviceKeyError`、`DecodingError`，就当用户取消”。这会吞掉网络层抛出的 `URLError` 等真实失败，用户看不到“没能保存”；同时真实的生物识别取消可能以别的错误类型抛出，反而进入“失败”分支。

读代码证实的：
- `TuningPages.swift:118` 的 `catch where Self.declined(error)` 分支什么都不做。
- `declined` 返回 `!(error is ... )`，所以 `URLError`、`CancellationError`、普通网络错误都算“用户取消”。
- `DeviceAPIClient.swift:151-159` 的 `exchange.send` 没有把传输层错误统一包装成 `DeviceAPIError`；`URLError` 会原样上抛。
- `SecureEnclaveKeys.swift:26-33` 只把 `store.load` 的错误包装成 `DeviceKeyError`，`key.signature(for:)` 的取消/认证错误不在 `do/catch` 内，会原样上抛。

推测：实际取消 Face ID 时具体抛哪个错误取决于 CryptoKit/LocalAuthentication；但“网络错误一定被当作取消”是代码能直接确认的。

建议：定义明确的“用户取消/拒绝”错误类型，只吞这一种；其余错误统一走失败提示。至少不应把任意未知错误都当成取消，可以把“用户取消”限定为 `CancellationError` 或明确的 `LAError.userCancel` 包装。

### 4. 低：stepUp/stepDown 只夹一侧边界，未对不可信的快照值做上下界校正

文件：`clients/apple/Sources/HimawariManage/Settings/TuningFormat.swift:47-55`

问题：`stepUp` 只 `min(maximum, ...)`，`stepDown` 只 `max(minimum, ...)`。如果服务端快照里的 `value` 已经越界（旧数据、服务端 bug、或不可信服务器），步进器不会把值拉回合法范围，甚至可能把越界值继续往同侧推进；保存时只能靠服务端拒绝。

读代码证实的：
- `stepUp(from:)` 没有 `max(minimum, ...)`；`stepDown(from:)` 没有 `min(maximum, ...)`。
- 服务端确实会拒绝越界值：`production-think-settings.ts:241-245` 和 `production-delivery-timing-control.ts:92-99` 都校验范围。
- 因此不会造成服务端数据错误，但客户端会出现“按了没反应 / 保存一定失败”的交互。

推测：正常服务端读出的值都在范围内，所以这条只在异常输入下触发；不是当前生产主路径。

建议：两个方向都夹上下界，例如 `stepUp` 用 `min(maximum, max(minimum, ...))`，`stepDown` 用 `max(minimum, min(maximum, ...))`；或者在解码时就把越界值夹到 `minimum...maximum`。

**侧重检查**

- 错误路径：检查了 `reloadTuning` 的 `try?` 吞错、`changeTuning` 的 `defer` 重载、`TuningEditPage.save` 的 `declined` 分支。读失败会退化为“加载失败/空列表”；保存失败里的网络错误会被静默吞掉（见意见 3）。
- 不合规范或不可信输入：检查了 `TuningItem` 对 `label/description/unitLabel/kind/storageUnit` 的解码、服务端 `minimum/maximum` 范围校验、以及 `stepUp/stepDown` 的越界行为。`kind/storageUnit` 当前不在契约里（见意见 1）；越界快照值不会被客户端夹住（见意见 4）。
- 安全：服务端 `think.settings.change` 和 `delivery_timing.settings.change` 都要求 `actorType == owner` 且 scope 匹配；客户端通过签名设备确认，改动是主人可做的配置，不是提权路径。未发现把值写日志或写入文件的问题。
- 资源耗尽：`loadTuning` 每次设置页加载固定两个 read；item 数量固定为服务端定义（think 11 项、delivery 12 项）；`stepSize` 的循环步长按 10 倍增长，服务端范围很小，未发现实际可触发的长循环；`DateComponentsFormatter` 每次渲染创建，属于开销但不是耗尽型问题。
- 不可撤销的操作：参数修改和“恢复默认”都是可逆的，没有删除/导出覆盖类操作；每次修改走 `.change` 确认。
- 规则文件、说明文档和代码是否一致：`ci/operations-pending.json` 移除的 4 项在 `check-operations.mjs` 的判定下确实有 Swift 调用方和 TS 测试，移除条件成立。`docs/architecture-v0.1.md:438` 描述的 think 响应仍然只有 `unit/unitLabel`，没有 `kind/storageUnit`，与作者的说法不一致。`prompt-prefix` 相关代码未被改动。
- 未核实：本机不能编译 Swift，无法复跑 `swift test`；分支提交 `c3b58cd5a` 的说明写的是“Swift 测试待 Mac 编译；本机无法编译 Swift”，与材料里“Mac 已跑过 swift test”不一致，现场结果未核实。PR 574 的服务端和契约改动也不在本仓库。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 本次改动只在 `clients/apple`（设置页、演示、测试、布局常量）和 `ci/operations-pending.json`，没有碰系统提示、工具定义、历史消息、遮盖、压缩或任何模型请求组装代码。发给模型的内容仍然只在末尾追加；新增的 `kind/storageUnit`、格式化文字和演示数据都没有进入模型请求，也不存在把每轮变化值放进请求开头的情况。

2. **不会让模型请求里的同一段文字变成不同字节。** 这些格式化结果只用于本地界面，不参与序列化后发给模型；`TuningKind.allCases` 是固定顺序，`tuning` 字典只做本地状态，不进入请求。`DateComponentsFormatter` 的输出可能随设备语言/系统版本变化，但那是界面显示，不是模型请求字节。未发现依赖前后文的遮盖、时间字段或无序集合进入模型请求。

3. **有自动检查，但不完整，且不一定在 CI 里跑。** 新增了 5 条 Swift XCTest：加载/修改命令、比例、时长、中文空格、无 kind 退化。若把 `kind` 解码或中文空格函数删掉，比例和空格用例会失败，反向性基本成立。但时长用例只断言“包含 10、不包含 600”，不会发现单位选错；没有覆盖 250 ms 的步进、最大/最小边界的时长步进、0/负数/非整数秒、ja/en 不调用中文空格、以及真实服务端响应（没有 kind）的端到端路径。Swift 测试也不在仓库的 `npm run check` 里，只能在 Mac 上跑；材料说已跑过，但分支提交说明写的是“待 Mac 编译”，我无法核实。

4. **逐项核对两端：**
   - `operations-pending.json` 移除的 `think.settings.read/change`、`delivery_timing.settings.read/change`：Swift 调用方在 `TuningModels.swift:9-24`，TS 集成测试有这些字面量，`check-operations` 的“后端实现/调用方/测试”三项都能找到，可以移除。
   - 操作名和 payload：`think.settings.change` 发送 `expectedRevision/key/value`，服务端 `production-think-settings.ts:241-258` 接受；`delivery_timing.settings.change` 同样接受；`delivery_timing.settings.read` 发送 `locale`，契约只允许 `zh-CN/en/ja`，`ManageLanguage.serverTag` 正好只产生这三个值，能通过。
   - `kind/storageUnit`：客户端能解码，但当前服务端不产生、契约还不允许；这是唯一明显对不上的新值，必须等 PR 574 同时更新服务端、契约、fixture 和集成断言。
   - `key`、`revision`、`value`：key 来自服务端 read，服务端 change 会按定义校验；revision 直接回传；value 是整数，服务端做范围校验。正常路径两端一致；异常越界值只能靠服务端拒绝（见意见 4）。
   - `label/description/unit/unitLabel`：客户端优先 `unitLabel`，没有时退回 `unit`；当前 think 和 delivery 的两种返回形状都能解码。
   - 新布局常量、演示场景 ID、字符串：只在本模块和演示数据里使用，未发现与生成文件或后端校验的冲突。
