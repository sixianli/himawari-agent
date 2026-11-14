## 侧重检查

- **不可信输入 / 缺字段**：我逐个推演了 `push.kind.set` 的 `kind` 缺失、`kind` 非枚举、`enabled` 缺失/非布尔/为 `null`、多出非 open 键、带服务端填充键等情况。除“缺 `kind`”外，都落到 `change`；缺 `kind` 会落到 `tighten`，但后续 schema 会拒绝，见发现 2。
- **错误路径与状态码**：`PORT_OPERATION_NOT_INSTALLED` 在 `http-gateway-server.ts:931-940` 映射为 501；`change` 无确认在 `device-gateway.ts:150-151` 先于审计抛出 403；`tighten` 先写 `accepted`、失败后写 `failed`，与测试一致。
- **安全 / 不可逆操作**：关闭推送类别是账号级、可逆的操作；但拿到设备密钥的人无需面容即可关掉 `approval` 通知（账号内所有设备一致）。这是该设计线程明确选择的“收紧”，不是实现偏差，但属于需要设计确认的安全取舍（推测其影响，代码本身按设计实现）。
- **资源耗尽**：无面容的 invalid `tighten` 请求会走完 `accepted` + `failed` 两次审计写入；此前同类请求会在 403 阶段被挡住。是否可被放大取决于设备接口的限流，本次未查。
- **规则 / 文档一致性**：发现 4 的设计文档与代码不一致（且看起来是旧文案）。
- **模型请求**：本次改动不碰提示词、工具、历史或遮盖路径，见必答问题 1、2。

## 发现（按严重度从高到低）

### 1. 严重度：低 — 生成的 Swift `requiredTier` 没有使用 `tightenOpenKeys`，两端语义不一致

文件：`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:28`、`:30-33`；生成模板 `test/tooling/client-parity.test.ts:96-101`

读代码证实：Swift 结构体加了字段，但判断逻辑仍只做全量字典相等：

```swift
public let tightenOpenKeys: [String]

public func requiredTier(payloadFlags: [String: Bool]?) -> ClientCapabilityTier {
    guard let tightenPayload, let payloadFlags, payloadFlags == tightenPayload else { return tier }
    return .tighten
}
```

而 TypeScript 端已经忽略 open key：

```ts
const keys = Object.keys(actual).filter((key) => !openKeys.includes(key));
```

生成文件里 `push.kind.set` 已经带 `tightenPayload: ["enabled": false], tightenOpenKeys: ["kind"]`，但 Swift 侧的 `tightenOpenKeys` 在整个仓库里没有任何使用点（我 grep 过所有 `.swift`，除这个生成文件外没有调用 `requiredTier` 的地方）。

推测：当前参数类型是 `[String: Bool]`，`kind` 的字符串值本来就进不了这个字典，所以现在不会把“改”误判成“收紧”；最坏方向是调用方把非布尔键映射成 `false`，导致手机端比服务器更严、多要一次面容。若将来 open key 本身是布尔键，两端就会真正分叉。

建议：要么让生成的 `requiredTier` 也按 `tightenOpenKeys` 过滤，并补一条 Swift 语义测试（现在只有文本生成对比，模板直接写死，测不出语义漂移）；要么承认 Swift 的入参只是布尔标志、删掉这个没有消费者的字段，并在生成器里写清楚。

### 2. 严重度：低 — 缺 `kind` 的 `{enabled:false}` 也会被判为“收紧”

文件：`packages/gateway-contracts/src/client-capabilities.ts:269-272`；`packages/gateway-contracts/src/contracts-v2.ts:266-269`；`packages/gateway-contracts/src/validation.ts:179-180`

读代码证实：`sameFlags` 只是把 open key 从实际键里过滤掉，并不要求 open key 出现：

```ts
const keys = Object.keys(actual).filter((key) => !openKeys.includes(key));
return (
  keys.length === Object.keys(expected).length &&
  keys.every((key) => Object.hasOwn(expected, key) && actual[key] === expected[key])
);
```

所以 `{ enabled: false }`（没有 `kind`）会命中 `tightenPayload: {enabled:false}`，被判为 `tighten`。随后 schema 要求两个字段都必填：

```ts
payload: object({ kind: pushKindSchema, enabled: booleanValue }),
```

```ts
for (const key of expectedKeys) {
  if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");
```

因此它最终会在 schema 校验时报 400，不会真的关闭任何类别。实际影响是：这类无效请求不再在分档阶段被 403 挡住，会写 `accepted` + `failed` 两条审计；手机端按“收紧”处理，不会要求面容，然后收到 400。契约测试目前只覆盖了“有 `kind`”的正反例，没有覆盖“缺 `kind`”。

建议：如果“关闭一种推送”在语义上必须指定类别，就让 open key 至少出现一次（或在契约层先做必填校验再分档）；至少补一条 `{enabled:false}` 的反向用例并写明预期。

### 3. 严重度：低 — 集成测试只走了 501 未安装路径，未覆盖真正关闭成功，也未断言 501

文件：`test/integration/device-gateway.test.ts:256-285`；`apps/agent-service/src/production-http-composition.ts:1151`

读代码证实：测试装配里的 `gatewayV2` 没有传 `webPushControl`，所以关闭请求实际是：

```ts
expect(off.json()).toEqual({ error: { code: "PORT_OPERATION_NOT_INSTALLED" } });
```

它证明了“无面容可以通过分档并到达转发层”，但没有证明真正安装推送端口时状态会被关掉；也没有断言 `off.statusCode === 501`，如果错误映射变了，这条用例仍会通过（501 映射本身另有 `http-gateway-server.contract.test.ts:453` 覆盖）。生产组合确实装了 `webPushControl`：

```ts
webPushControl: new ProductionWebPushControl({
```

建议：在设备网关测试的装配里加上 `webPushControl`，断言实际账号类别被关闭；并在当前用例补 `expect(off.statusCode).toBe(501)`。

### 4. 严重度：低 — 设计文档与代码的 `push.kind.set` 载荷不一致（旧文案）

文件：`docs/execution/specs/2026-10-26-web-push-design.md:180`

读到的原文：

```md
- `push.kind.set`（命令）：`kinds`，账号要收的类别，整组替换。
```

但代码和合约是单类别 `{ kind, enabled }`：

```ts
const pushKindCommandSchema = object({
  ...commandEnvelope("push.kind.set"),
  payload: object({ kind: pushKindSchema, enabled: booleanValue }),
});
```

这不是本轮改动引入的（看起来是 I-68 改成账号级单类别后遗留的旧文案），但属于规则/文档与代码不一致。建议更新为 `{ kind, enabled }` 的单类别语义，避免后续实现者按“整组替换”理解。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 我没找到 `CLIENT_CAPABILITY_TABLE` / `requiredClientTier` / `tightenOpenKeys` 进入模型请求组装的路径；使用点只有设备网关（`packages/platform-node/src/device-gateway.ts:115`）和客户端清单/工具测试。这个改动不碰系统提示、工具定义、历史消息和遮盖结果，因此“只在末尾追加、每轮变化值都在最后一条消息里”的既有性质不受影响。`prompt-prefix.md` 的阻断检查未运行（工具限制），但改动范围与提示词路径无交集。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 新逻辑是纯函数：只看静态能力表和本次请求的 payload，不依赖时间、随机数、前后文或数据库返回顺序；`sameFlags` 的计数/`every` 比较也与键遍历顺序无关。生成的 Swift 清单顺序来自固定能力表，不在模型请求里。新增的审计 `attempt` UUID 和 `occurredAt` 是原本就有的审计字段，不进入模型请求。

### 3. 有没有自动检查，反向用例真的会失败？

**有，读代码判断反向用例有效；未实际运行测试。**

- `npm run check:client-parity` 同时跑 `test/tooling/client-parity.test.ts` 和 `packages/gateway-contracts/test/client-capabilities.contract.test.ts`（`package.json:30`）。
- 契约测试覆盖了正例和反例：`{kind, enabled:false}` 为 tighten；`enabled:true`、缺 `enabled`、`enabled:"false"`、`enabled:null`、多出 `extra` 都为 change（`client-capabilities.contract.test.ts:77-86`）。如果把过滤 open key 的逻辑删掉，`{kind:"run", enabled:false}` 会变成 change，正例失败；如果把任意额外键都忽略，`extra:false` 反例会失败。
- 集成测试覆盖“关闭不要求面容、打开 403”以及 tighten 审计的两条记录（`device-gateway.test.ts:256-285`）。
- 缺口：Swift 侧只有文本生成对比，没有语义测试；集成测试没有真正执行关闭成功路径。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？

- `push.kind.set` 能力表项：由 `tightenOrChange("v2","push.kind.set",{enabled:false},["kind"])` 产生（`client-capabilities.ts:110`），`findClientCapability` 能查到；`requiredClientTier` 能返回 `tighten`；`dispatchDeviceGatewayRequest` 接受 `tighten` 并做“不要求确认 + 审计”，两端对得上。
- `kind` 的取值：open key 在分档时被忽略，但下游 schema 用 `enumeration(["reminder","approval","run"])` 校验（`contracts-v2.ts:253,268`），非法值会在转发前被拒，不会出现 I-73 那种“清单能产生但后端校验不接受”的放行问题。
- `tightenOpenKeys` 字段：TypeScript 接口、`requiredClientTier`、`client-parity` 生成器都按 `readonly string[]` 接受；生成的 Swift 也接受 `[String]`。**但 Swift 侧没有消费它**，这是发现 1 的不一致。
- `tier: "tighten"`：设备网关审计动作 `device.gateway.tighten`、测试断言、审计 targetRef 格式都一致。
- 未核实：仓库外的 Apple 客户端实际如何构造 `payloadFlags`、是否使用 `requiredTier` 做面容判断；第 4 轮判断文件在当前工作区没有检出（glob 无结果），因此设计线程原文未直接核对。
