先说明：受工具限制，我只读了代码和文档，没有执行测试；下面关于“反向用例会失败”的判断都是读代码推断的。

## 读代码证实的问题

### 高｜`packages/gateway-contracts/src/contracts-v2.ts:510-521`：设备上限键与仓库设计文档不一致

问题：合约列出十个键，其中把抢跑缓存拆成 `device.prefetch.cache.entries` / `device.prefetch.cache.bytes`；仓库设计文档写的是九个键，且只有 `device.prefetch.cache`。作者“设计文档里的十个硬上限键”的说法与当前仓库文档不符。

证据：

- 合约：
  ```ts
  export const DEVICE_LIMIT_KEYS = [
    ...
    "device.prefetch.cache.entries",
    "device.prefetch.cache.bytes",
    ...
    "device.nonce.retained",
  ] as const;
  ```
- 设计文档 `docs/execution/specs/2026-11-11-apple-device-body-design.md:583`：
  ```md
  | `device.prefetch.cache` | 每台设备的抢跑缓存 | 20 条、合计 200 KB | 丢最旧的 |
  ```
- 同文件 `:706`：
  ```md
  | 硬上限的九个配置键 ... | 配置解析只认这九个键名 |
  ```

影响：PR 404 的后端若按设计文档实现，会拒绝或无法产生 `device.prefetch.cache.entries/.bytes`；若按合约实现，则设计文档和配置解析会多出/缺少键。这是 I-73 那类“清单里的值在另一端过不了校验”的问题。现有测试只用了 `device.request.body_bytes`（`test/gateway-v2.fixture.ts:418`）以及未知键/负值（`test/device-gateway.contract.test.ts:107-108`），没有逐个核对十个键和真实配置键。

建议：先确定唯一权威清单。若拆成两个键是设计更新，就同步改设计文档和配置解析；否则删除这两个键、恢复 `device.prefetch.cache`。增加一条 I-73 式检查：真实上限登记表的每个键都必须通过 `DEVICE_LIMIT_KEYS`，且 `DEVICE_LIMIT_KEYS` 的每个键都能在登记表中找到；反向用例要能失败。

### 中｜`packages/gateway-contracts/src/contracts-v2.ts:565-568,597-600`、`test/gateway-v2.fixture.ts:421`：快照里直接放 `clientSecret`，但“禁止秘密字段”的测试没有覆盖

问题：`device.list.snapshot` 的 `pairing.access` 要求同时有非空的 `clientId` 和 `clientSecret`，测试夹具直接写了 `"secret-01"`；而网关合约测试声称“contains references instead of raw content, secrets”，其禁止键清单没有 `clientSecret`，所以这条测试不会失败。

证据：

- 合约：
  ```ts
  const deviceAccessSchema = object({
    clientId: accessText,
    clientSecret: accessText,
  });
  ```
- 夹具 `gateway-v2.fixture.ts:421`：
  ```ts
  access: { clientId: "access-client-01", clientSecret: "secret-01" },
  ```
- 测试 `packages/gateway-contracts/test/gateway-v2.contract.test.ts:17-25` 的 `forbiddenKeys` 只有 `apiKey`、`accessToken`、`password`、`secretValue`、`credential`、`rawContent`、`jwt`；`:51` 只按这些键名过滤。

影响：如果这个字段对应设计第 169-170 行二维码里的 Cloudflare 服务令牌，那么它确实是长期凭据；它会出现在设备列表快照里，可能被日志、测试记录、导出或任意已登录设备拿到。即使这是有意设计，当前测试口径也把它放过了。

建议：优先改成引用/短期凭据，而不是把 `clientSecret` 放进读快照；如果必须返回，明确标注为受保护值，并把它加入禁止键或专门的白名单说明，同时在日志/导出里排除。测试应至少能识别这一类新秘密字段。

### 中｜`packages/gateway-contracts/src/contracts-v2.ts:582`：`releaseChannel` 没有按设计文档的封闭清单校验

问题：设计文档规定发布渠道只有 `direct`、`testflight`、`app_store`、`mac_direct`，且“服务器按清单校验，不认识的值拒绝配对”；合约却用 `machineString`，任何 1-128 字符的机器串都接受。

证据：

- 合约 `:582`：
  ```ts
  releaseChannel: machineString,
  ```
- 设计文档 `:702`：
  ```md
  | 发布渠道 `direct`、`testflight`、`app_store`、`mac_direct` | ... | 服务器按清单校验，不认识的值拒绝配对；Swift 由清单生成 |
  ```

影响：如果 iOS/Swift 侧按设计文档从四个值生成代码，而网关合约是自由字符串，两端对“合法发布渠道”的理解不一致；未知渠道也不会在合约层被拒。现有夹具只用了 `direct` 和 `testflight`，没有反向用例。

建议：改成 `enumeration(["direct", "testflight", "app_store", "mac_direct"])`，并补四个正向和未知值反向用例；如果确实要允许未来渠道，就明确设计文档的更新规则，并把 Swift/后端校验放在同一份清单上。

### 中｜`packages/gateway-contracts/src/contracts-v2.ts:530-535,607`：配对码“调用方生成”的说法与设计文档冲突，且没有校验 16 字节规范编码

问题：作者说“配对码由调用方生成”；仓库设计文档说服务器生成 128 位随机码，App 只是把扫码得到的码发给服务器。合约只要求 22 个 base64url 字符，没有保证它是 16 字节随机数的规范无填充编码。

证据：

- 设计文档 `:169`：
  ```md
  服务器生成配对码：128 位随机数，10 分钟有效，只能用一次，库里只存它的哈希。
  ```
- 合约 `:530-535`：
  ```ts
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(input))
    throw new ContractValidationError(path, "expected a 22 character base64url pairing code");
  ```
- `device.pairing.start` 的 payload 只有调用方传入的配对码（`:607`），命令结果只有 `resultRef`，没有返回配对码的字段。

影响：如果这个命令的意图是“设备把扫到的码提交给服务器”，形状基本可用，但作者的文字描述错了；如果它的意图是“设备管理页开始配对并拿到码”，这个合约无法返回配对码，功能不完整。另外，22 字符的最后一位若带非零填充位，严格解码成 16 字节时可能被某些实现拒绝或产生歧义，而合约会接受（测试里的 `"A".repeat(22)` 是规范编码，覆盖不到这种情况）。

建议：明确角色：服务器生成就增加能返回配对码的读取/命令结果，或保持只在网页侧生成；设备提交则把描述改正确。若服务器会解码成 16 字节，增加规范 base64url 校验（最后一个字符只能取允许的四个值之一）和反向用例。

### 低｜`packages/gateway-contracts/src/contracts-v2.ts:626`：`blocked` 依赖状态不是网页健康接口能产生的值

问题：新增 `SERVER_STATUS_DEPENDENCY` 包含 `"blocked"`，作者说字段对齐 `/api/health/v1/dependencies`；但真实健康模型只有 `healthy | degraded | unavailable`。

证据：

- 合约 `:626`：
  ```ts
  export const SERVER_STATUS_DEPENDENCY = ["healthy", "degraded", "blocked", "unavailable"] as const;
  ```
- `packages/domain/src/durable-state.ts:532`：
  ```ts
  export type DependencyHealthStatus = "healthy" | "degraded" | "unavailable";
  ```
- `packages/gateway-contracts/test/device-gateway.contract.test.ts:133` 却把 `"blocked"` 当作依赖状态正向用例；`test/gateway-v2.fixture.ts:446` 也用了 `worker/blocked`。

影响：目前不会导致运行失败，但合约里有一个网页健康接口永远不会产生的值，测试会给人“已经对齐”的错觉；如果以后有代码按这个枚举生成 Swift，会多出一个不可能的分支。

建议：删掉 `blocked`，或者明确记录它对应的未来生产者并让 domain/网页接口也支持它；测试的正向集合应与真实生产者一致。

### 低｜`apps/agent-service/src/production-server-status-control.ts:36`：硬编码 `authenticatedSnapshot(true)`，绕过了 health 端口自己的认证参数

问题：`RuntimeHealthModel.authenticatedSnapshot` 的存在意义是要求调用方传入真实认证结果，否则抛 `HEALTH_AUTHENTICATION_REQUIRED`；新控制类直接传 `true`。当前调用链前面确实有网关鉴权，但没有利用这个防线。

证据：

- `production-server-status-control.ts:36`：
  ```ts
  const snapshot = this.#options.health.authenticatedSnapshot(true);
  ```
- `packages/platform-node/src/runtime-health.ts:115-118`：
  ```ts
  authenticatedSnapshot(authenticated: boolean): DeploymentHealthSnapshot {
    if (!authenticated) throw new Error("HEALTH_AUTHENTICATION_REQUIRED");
    return this.snapshot();
  }
  ```
- 网关服务确实先鉴权（`packages/application/src/services/agent-gateway-v2-service.ts:33,104`），HTTP 路由只校验入站消息、不校验出站快照（`packages/platform-node/src/http-gateway-server.ts:1103-1107`）。

影响：没有发现可直接利用的越权路径，但这是防御纵深上的退步；如果以后有别的代码直接调用 `query()`，它会无条件拿到健康细节。

建议：让控制类接收/传递真实认证上下文，或把 health 端口改成必须由外层鉴权后调用的普通 `snapshot()`；至少在注释/类型上说明为什么 `true` 是安全的。出站快照也可考虑做一次合约解析，防止契约与实现漂移。

### 低｜`packages/gateway-contracts/test/device-gateway.contract.test.ts:64-68`：测试名称覆盖范围大于实际覆盖

问题：用例叫“rejects extra payload fields on every device command”，实际只测了 `device.pairing.start`、`device.revoke`、`device.list.read`，没有测 `device.pairing.confirm` 和 `device.rename`。

证据：

```ts
it("rejects extra payload fields on every device command", () => {
  rejects(fixture("command", "device.pairing.start", { pairingCode: "A".repeat(22), extra: 1 }));
  rejects(fixture("command", "device.revoke", { deviceId, expectedRevision: 0, extra: 1 }));
  rejects(fixture("query", "device.list.read", { extra: 1 }));
});
```

影响：`object()` 本身是严格拒未知字段的，所以当前实现没问题；但测试的名字会让人误以为五个命令都覆盖了，以后若某个命令改成非严格对象，这个测试仍会通过。

建议：补齐 `device.pairing.confirm` 和 `device.rename` 的额外字段用例，或者把测试名改成实际覆盖的三个。

## 推测 / 未核实

- PR 404 是否真的使用 `paired_devices` 表：本仓库设计文档写的是 `devices`（`docs/execution/specs/2026-11-11-apple-device-body-design.md:196`），PR 404 不在当前 checkout，未核实作者“paired_devices”的说法。
- 后端是否会按设计文档产生 `device.prefetch.cache`：PR 404 代码不在仓库，未核实；但按当前文档推断，合约与后端会冲突。
- `pairingNumber` 六位数字是谁产生、iOS 设计线程是否另有文档：仓库设计文档未写，未核实。
- `clientSecret` 是否就是设计里的 Cloudflare 服务令牌：只是推测，仓库没有字段级说明。
- 作者说“新增集成测试”，实际是 `apps/agent-service/test/production-http-composition.unit.test.ts`；该测试只比较 `live/ready/status/dependencies` 的共同字段，网页响应还含有 `id`，手机响应还含 `generatedAt`，所以“逐项相等”字面上不成立。

## 侧重检查

- **不合规范/不可信输入**：`deviceId`、配对码、配对数字、名字、`expectedRevision`、额外字段都有严格校验（`contracts-v2.ts:523-624`），未知字段由 `object()` 拒绝（`validation.ts:161-191`）。缺口是 `releaseChannel` 未按封闭清单校验、配对码未保证规范 16 字节编码。
- **错误路径**：未安装操作会抛普通 `Error`（`production-server-status-control.ts:35`），但正常路径先被 `installedOperations` 拦截；无会话路径由 `ProductionThreadGatewayAccessPolicy` 返回 `SESSION_INACTIVE`（`production-http-composition.ts:438-439`），测试也覆盖了。
- **安全**：`clientSecret` 进快照是最值得关注的点；`authenticatedSnapshot(true)` 是防御纵深问题；配对码是 bearer 凭据，若由调用方生成会削弱服务器对随机性和一次性语义的控制。
- **资源耗尽**：新增入站命令的 payload 都很小，没有新增数组/文件/网络入口；`device.list.snapshot`、`server.status.snapshot` 的数组没有显式长度上限，但它们由服务器产生，风险低。
- **不可撤销操作**：`device.revoke` 只有合约，没有 handler；合约要求 `expectedRevision`，但没有确认/原因字段，实际行为需等 PR 404 核对，未核实。
- **规则/文档与代码一致**：本 PR 不碰 `.claude/rules/prompt-prefix.md` 相关的提示词/工具/遮盖代码；但设计文档与合约在上限键、发布渠道、配对码生成方、`blocked` 状态上不一致。
- **提示词前缀**：diff 只涉及 `packages/gateway-contracts`、`apps/agent-service` 的网关/HTTP 组装、`ci/operations-pending.json` 和测试；没有改 `packages/prompt-catalog`、`packages/runtime-pi`、出口遮盖或工具定义。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍只追加，每轮变化的值是否都在最后一条消息里？**

不会改变。这个 diff 没有改系统提示、工具定义、历史消息、资料块或遮盖实现；新增的 `server.status` 是网关查询响应，仓库里没有把它写进模型请求的路径（搜索 `server.status` 只命中合约、控制类、测试和 `ci/operations-pending.json`）。因此对模型而言仍是只追加，新增的 `generatedAt` 也没有进入模型请求。依据：`.claude/rules/prompt-prefix.md:27-35`。注意：我无法运行 `check:prompt-prefix`，这一条是读 diff 和调用点得出的。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

对模型请求：不会。对网关响应：`server.status.snapshot` 的 `generatedAt` 来自 `clock.now()`，每次查询都会不同；`dependencies` 的顺序来自 `RuntimeHealthModel` 的 Map 插入顺序，当前是稳定的，但合约没有强制排序；`device.list.snapshot` 在本 PR 没有生产者。`deviceNameSchema` 的去首尾空白是确定性的。只要这些快照不被塞进模型请求，就不违反第 2/10 条；如果以后要放进模型请求，时间字段必须移到末尾。

**3. 有没有对应的自动检查？反向用例是否真的会失败？**

有检查：
- `packages/gateway-contracts/test/device-gateway.contract.test.ts` 覆盖配对码长度/字符、deviceId、revision、名字、额外字段、limit 键、状态、reasonCode。
- `packages/gateway-contracts/test/gateway-v2.fixture.ts` + `gateway-v2.contract.test.ts` 做全部消息类型的正向 round-trip。
- `apps/agent-service/test/production-http-composition.unit.test.ts:1098-1151` 覆盖 `server.status.read` 与网页健康接口对比、无会话被拒。
- `ci/operations-pending.json` + `scripts/check-operations.mjs` 覆盖未完成操作的名单。

从代码看，去掉对应 regex/枚举/整数下限/未知字段拒绝时，反向用例会失败。但缺口明确：没有逐个验证十个 limit 键、没有 `releaseChannel` 未知值反向用例、没有规范 16 字节配对码的用例、“every device command”只测了三个、没有测试 `blocked` 实际能否由健康接口产生，也没有出站快照合约校验。由于不能运行测试，以上是静态推断。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**

- `server.status.read`：合约查询 → `production-http-composition.ts:690` 的已安装列表 → `production-approval-gateway.ts:126-127` 的路由 → `ProductionServerStatusControl` → `server.status.snapshot`；各端都接受，测试也覆盖。
- `server.status.snapshot`：字段 `live/ready/status/dependencies/generatedAt` 能被合约解析；`status` 与 domain 的四值一致；但 `dependencies.status` 的 `blocked` 没有真实生产者。
- 六个 `device.*` 类型：合约、`schemasByType`、fixture、pending 名单都一致；后端还没实现，PR 404 必须使用完全相同的类型名和键名。
- `DEVICE_LIMIT_KEYS`：只在合约和测试中使用，后端/配置解析不在本仓库；与设计文档的九个键及 `device.prefetch.cache` 冲突，是本次最需要先解决的两端不一致。
- `releaseChannel`：合约接受任何 `machineString`，设计文档要求四个固定值；如果 Swift/后端按文档校验，两端不一致。
- `clientSecret`：合约和 fixture 接受，但测试的“禁止秘密键”清单不接受这个判断，安全审查也没覆盖。
- `pairingCode`：22 字符形状被接受，但“16 字节规范编码”和“谁生成”没有在两端统一。
- `paired_devices` 表、`pairingNumber`：本仓库没有对应代码/文档，未核实。

## 结论

这个 PR 在“不改模型请求前缀”这一点上是干净的，设备/服务器消息的严格对象校验也做得不错。但合并前至少应先解决：设备上限键与设计文档/未来配置解析的冲突、快照中的 `clientSecret` 安全审查、`releaseChannel` 的封闭清单问题，以及配对码生成方/规范编码的明确。前两项属于会真正造成两端不兼容或凭据泄露风险的事项，不建议按现状直接合并。
