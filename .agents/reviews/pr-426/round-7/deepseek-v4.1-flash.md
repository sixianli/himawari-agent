## 复核范围

这一轮主要对照 `100a73590..1ad4f1c1` 的完整改动，并逐行复核了 `5b7a2893..1ad4f1c1` 的增量。重点读了：

- 设备网关与分档：`packages/platform-node/src/device-gateway.ts`、`device-api-routes.ts`、`paired-device-service.ts`
- 能力表与生成物：`packages/gateway-contracts/src/client-capabilities.ts`、`test/client-capabilities.contract.test.ts`、`test/tooling/client-parity.test.ts`、`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift`、`Gateway/JSONValue.swift`
- 近期验证：`packages/application/src/services/recent-authentication-service.ts`、`ports/recent-authentication.ts`、`production-http-composition.ts`、`test/fixtures/device-api-harness.ts`
- 主动检查：`production-proactive.ts`、`ports/proactive-checks.ts`、`sqlite-proactive-operations.ts`、`durable-adapters.ts`
- 契约与测试：`contracts-v2.ts`、`gateway-v2.fixture.ts`、`test/integration/device-gateway.test.ts`、`test/integration/proactive-production.test.ts`、`ci/operations-pending.json`

未运行测试、未编译 Swift；所有结论都来自读代码和现有测试文件。

## 上一轮修复核对

- `ownerSubject`：`apps/agent-service/src/production-http-composition.ts:1216-1220` 已补上；`apps/agent-service/test/production-http-composition.unit.test.ts:2247-2290` 用真实生产组合走完“未确认 403 → 挑战 → 确认后 200 → 网页会话失效 401”，这是有效反向用例。
- `JSONValue.swift`：文件已加入 `clients/apple/Sources/HimawariManage/Gateway/`，`Package.swift` 的 `HimawariManage` target 默认包含该目录，`ClientCapabilities.swift` 的引用可解析。但 `npm run check` 里仍没有 Swift 编译步骤。
- `tightenEveryItem` 契约断言：`packages/gateway-contracts/test/client-capabilities.contract.test.ts:52-56` 已补，当前表里也没有同时设置 `tightenPayload` 和 `tightenEveryItem` 的条目。

## 意见

### 1. [中] Swift 规则只是与 TypeScript 文本快照一致，没有行为测试，二者仍是两份手写实现

文件：`packages/gateway-contracts/src/client-capabilities.ts:331-348`、`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:28-38`、`test/tooling/client-parity.test.ts:99-116`、`:214-230`

问题：`check:client-parity` 只比较生成的 Swift 文本是否等于测试文件里的模板文本；Swift 的 `ClientItemTighten.accepts` 和 TS 的 `everyItemTightens` 是两套各自手写的逻辑，没有任何用例把同一组输入分别喂给两边比对结果。当前两份逻辑在 `memory.external.respond` 上看起来等价，但只要有人只改 TS 或只改生成模板，现有检查仍然可以通过。

证据（读代码证实）：

```ts
// client-capabilities.ts
return (
  Object.keys(entry).sort().join("\n") === expectedKeys.join("\n") &&
  Object.entries(rule.equals).every(([key, value]) => entry[key] === value) &&
  rule.nulls.every((key) => entry[key] === null)
);
```

```swift
// ClientCapabilities.swift
guard case .object(let entry) = item, Set(entry.keys) == expectedKeys else { return false }
return equals.allSatisfy { entry[$0.key] == JSONValue.string($0.value) }
    && nulls.allSatisfy { entry[$0] == JSONValue.null }
```

```ts
// client-parity.test.ts
const expected = renderSwift(CLIENT_CAPABILITY_TABLE, CLIENT_PAGE_TABLE);
expect(readFileSync(file, "utf8")).toBe(expected);
```

此外，`clients/apple/Tests` 下没有 `ClientItemTighten` / `requiredTier` 的 Swift 测试。

建议：把 `memory.external.respond` 的判定用例做成共享向量（reject 全部、keep、改写、缺键、多键、空 items、非数组、正文多键），TS 和 Swift 各跑一遍；或者让生成器从同一份规则定义同时生成两边的判定代码，避免两套手写实现。

### 2. [中] `memory.external.respond` 的新分档没有经过设备网关的端到端用例

文件：`packages/gateway-contracts/test/client-capabilities.contract.test.ts:94-118`、`packages/platform-node/src/device-gateway.ts:115`、`test/integration/device-gateway.test.ts`（全文 538 行）

问题：新规则只有纯函数级反向用例，验证的是 `requiredClientTier` 本身；没有用例把 `{items:[全 reject]}` 和 `{items:[含 keep/改写]}` 真正发到 `POST /api/device/v1/gateway`，经过 `classify → dispatch → v2 处理程序` 后检查“免面容/要面容、审计是否写入、handler 是否执行”。如果以后有人在 `classifyDeviceGatewayRequest` 里把 `requiredClientTier` 的返回值接错，或 `withServerFilledReferences` 改变了 payload，纯函数测试不会发现。

证据（读代码证实）：

```ts
// device-gateway.ts
const tier = requiredClientTier(entry, payload);
return { entry, tier: tier as DeviceGatewayRequest["tier"], body };
```

```ts
// client-capabilities.contract.test.ts
const tier = (payload: unknown) => external && requiredClientTier(external, payload);
expect(tier({ items: [reject("a")] })).toBe("tighten");
...
expect(tier({ items: [{ proposalId: "a", decision: "keep", editedText: null }] })).toBe("change");
```

`test/integration/device-gateway.test.ts` 已覆盖 `muse.*`、`memory.mutate`、`proactive.settings.set`、`push.kind.set` 等，但没有 `memory.external.respond`。

建议：在设备网关集成测试里加两组请求，直接走真实 `gatewayV2` 或可观测的测试替身：全 reject 不递确认签名也应执行并写 `device.gateway.tighten` 审计；含 keep/改写时不递确认签名应 403、不转发、不写审计。最好再用真实 handler 验证 reject 只把 proposal 标成 rejected，不产生 keep 的效果。

### 3. [中] `ownerSubject` 只对外部身份绑定生效；内置身份模式下需要近期验证的“改”会没有证据

文件：`apps/agent-service/src/production-http-composition.ts:833-862`、`:1216-1220`、`packages/application/src/services/recent-authentication-service.ts:101-113`

问题：`ownerSubject` 通过 `identityState.readByOwner(ownerId)` 取 `externalSubjectRef`，而 `RecentAuthenticationGuard` 随后必须能按这个 subject 和 owner 各查到一条 active 绑定。`built-in` 身份分支只创建 `BuiltInAuthenticationService`，整个分支没有 `bindFirstOwner`；内置身份也没有对应的 owner identity binding。结果是在内置身份部署里 `ownerSubject` 永远返回 `undefined`，`PairedDeviceService` 不会附加 `recentAuthenticationEvidence`，所有需要 `assertRecentAuthentication` 的“改”命令（`login.device.revoke`、`login.devices.revoke_others`、`proactive.observation.start`、`thread.delete_permanently` 等）都会失败。

证据（读代码证实）：

```ts
ownerSubject: async (scope) => {
  if (scope.ownerId !== ownerId || scope.agentId !== agentId) return undefined;
  const binding = await identityState.readByOwner(ownerId);
  return binding?.status === "active" ? binding.externalSubjectRef : undefined;
},
```

```ts
if (identityConfiguration.kind === "built-in") {
  const native = new BuiltInAuthenticationService({ ... });
  ...
  return; // 该分支没有 bindFirstOwner
}
```

```ts
const externalSubjectRef = verified.confirmed
  ? await this.#options.ownerSubject?.({ ownerId: current.ownerId, agentId: current.agentId })
  : undefined;
```

影响：读代码已证实内置身份下 `ownerSubject` 不会得到 subject；至于是否有内置身份部署实际使用设备接口，未核实。若有，这是静默的功能缺口，不是安全绕过（失败方向是拒绝）。

建议：在内置身份模式启动/首次使用时为 owner 建立一条内部绑定，或让 `ownerSubject` 对内置身份返回一个与 `RecentAuthenticationGuard` 一致的 owner 绑定；同时补一条 `built-in` 模式下的设备“改”用例。若决定不支持，应在命令分档或错误码里明确拒绝，而不是让请求在 handler 深处失败。

### 4. [低] 首次连接 Gmail 的启用路径不再写入默认规则行，规则版本从 1 变成 0

文件：`apps/agent-service/src/production-proactive.ts:325`、`:474`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:235-271`

问题：这个 PR 为了 `proactive.pause` 抽出 `setEnabled`，同时把两条“首次启用”的路径从 `writeSettings({...settings, enabled:true})` 改成了 `setEnabled({enabled:true})`。旧代码会把 `readSettings` 读到的默认 `quietHours` / `importantSenders` 通过 `writeSettings` 写成正式的规则行（revision=1）；新代码只写 `proactive_settings.enabled`，`rule_book_rules` 里没有这两条规则。`readSettings` 会回退到默认值，所以界面看到的设置值不变，但 `quietHoursRevision` / `importantSendersRevision` 会保持 0，规则历史也没有初始记录。

证据（读代码证实）：

```ts
// production-proactive.ts
await store.setEnabled({ ...scope, enabled: true, now });
...
if (!existing) await store.setEnabled({ ...scope, enabled: true, now });
```

```ts
// sqlite-proactive-operations.ts
const quiet = rules.find(({ ruleId }) => ruleId === QUIET_HOURS_RULE_ID);
...
quietHoursRevision: quiet?.revision ?? 0,
...
importantSendersRevision: senders?.revision ?? 0,
```

影响：读代码已证实状态行/规则行的差异；至于是否有下游逻辑依赖“规则行存在”或依赖 revision 是否为 0，未核实，因此影响是推测性的。

建议：如果只是想给 `proactive.pause` 提供只改 enabled 的入口，应保留两条首次启用路径原来的 `writeSettings` 行为，或补测试明确默认规则是否必须落库、revision 是否允许为 0。

### 5. [低] `check:client-parity` 不编译 Swift，缺少 `JSONValue.swift` 这类问题不会被自动检查发现

文件：`package.json:28`、`test/tooling/client-parity.test.ts:214-219`、`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:28`、`:50`

问题：当前 `check:client-parity` 只做“生成文本 == 文件文本”的比较，不解析也不编译 Swift。上一轮 `ClientCapabilities.swift` 引用了不存在的 `JSONValue` 类型，`npm run check` 不会失败，正是这个缺口的表现。这一轮补上了 `JSONValue.swift`，但没有增加防止复发的检查。

证据（读代码证实）：

```ts
// client-parity.test.ts
const expected = renderSwift(CLIENT_CAPABILITY_TABLE, CLIENT_PAGE_TABLE);
...
expect(readFileSync(file, "utf8")).toBe(expected);
```

`ClientCapabilities.swift` 中 `accepts(_ payload: JSONValue)` 和 `requiredTier(payload: JSONValue)` 依赖 `JSONValue`；`package.json` 的 `check:steps` 中没有 `swift build` / `swift test`。

建议：在 macOS CI 或至少一个可用的 Swift 环境里跑 `swift build --package-path clients/apple` 或 `swift test`；如果暂时没有 Swift 环境，至少加一个静态清单检查，验证生成文件引用的本地类型/文件都存在。

## 侧重检查

- **挑战值错误路径**：读了 `paired-device-service.ts:281-313` 和 `:345-361`。挑战绑定 `deviceId` 的 HMAC、过期时间、base64url 规范编码都会校验；`recordNonce` 在 `sqlite-paired-device-operations.ts:314-337` 用 `INSERT ... ON CONFLICT DO NOTHING` + 事务保证并发只成功一次。`test/integration/device-gateway.test.ts:180-205`、`:358-373` 覆盖了过期、别的设备、重复使用、并发。未发现绕过。
- **未确认的“改”是否先于审计/转发被拒**：`device-gateway.ts:150-152` 在 `record("accepted")` 和 `forward()` 之前检查 `tier === "change" && !confirmed`。`test/integration/device-gateway.test.ts:144-166`、`:316-356` 有反向用例。
- **不可信输入**：`classifyDeviceGatewayRequest` 限制 body 键、payload 为对象、占位引用只能是 `"device"`；`contracts-v2.ts` 的 `object()` 会拒绝多余字段（`validation.ts:161-191`）。`memory.external.respond` 的 items 键集合、`decision`、`editedText` 都有契约校验；分类器对空数组、非数组、多余键都会退回 `change`。未发现可以让“带 keep/改写”的请求落到 `tighten` 的输入。
- **资源耗尽**：设备请求有 body 上限（`device-api-routes.ts:299-336`），`memory.external.respond` 的契约限制 1–500 项（`contracts-v2.ts:2168-2183`），`device_request_nonces` 有保留上限和过期清理。新增 `/gateway` 没有引入无界循环或新表。
- **不可撤销/高风险操作分档**：逐个看了 `CLIENT_CAPABILITY_TABLE` 中的 `change` / `routine` / `tighten`。`thread.delete_permanently`、`memory.external.undo`、`memory.import.*`、`device.*`、`login.device.*`、`capability.*`、`grant.revoke`、`memory.mutate` 都要求确认；`thread.trash`/`archive`/`restore`/`pin` 属可撤回或轻量操作；`data.export.cancel`、`thread.task.resolve` 的下游副作用没有继续深读，标“未完全核实”。
- **规则和文档一致性**：`.claude/rules/prompt-prefix.md` 未被本次增量触碰；`ci/operations-pending.json` 加了 `proactive.pause` 且 `check:operations` 会校验契约、安装列表、处理方和测试；I-73 类比下的“清单值能否过后端校验”在 `check:client-parity` 和 `check:operations` 上都有对应检查。未发现文档和代码的明显冲突。
- **Swift 侧**：`JSONValue.swift` 已在正确 target；规则逻辑与 TS 当前等价，但没有 Swift 行为测试，且 npm 检查不编译 Swift。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。增量没有改系统提示、工具定义、历史消息组装或出口遮盖；`git diff` 涉及的是设备网关、能力表、主动检查状态和测试。设备网关只是把请求转发给现有 v2 处理程序；`proactive.pause` 只改 `proactive_settings.enabled`。没有把每轮变化的值加进系统提示或历史，也没有新的模型请求内容。依据 `prompt-prefix.md` 第 4、6、10 条，这一轮不触发请求头变化。

2. **同一段文字会不会在不同请求里变成不同字节？**
   没有发现。设备分档使用固定表、固定键集合比较；`ClientItemTighten` 的键比较在 TS 里排序后比较，Swift 里用 Set，均不依赖数据库顺序。新增的审计时间、证据时间只出现在审计/近期验证对象里，不进入模型请求。`JSONValue` 的编码规则是确定的，且只用于本地分档，不参与模型序列化。

3. **有没有对应的自动检查，反向用例真的会失败？**
   部分有，且多数反向用例是有效的：`client-capabilities.contract.test.ts:94-118` 对 `memory.external.respond` 的 keep、改写、缺键、多键、空数组、非数组、正文多键都会断言 `change`；挑战过期/跨设备/重放/并发都有集成用例；未确认的“改”不写审计有检查；`ownerSubject` 有生产组合端到端反向用例。
   缺口：Swift 的 `ClientItemTighten.accepts` 没有行为测试，只有生成文本快照；`memory.external.respond` 没有经过 `/api/device/v1/gateway` 的端到端用例；`check:client-parity` 不编译 Swift，因此上一轮缺少 `JSONValue.swift` 时不会失败。第 1、2、5 条意见就是这些缺口。

4. **改动产生或修改的每个值，使用端都能接受吗？**
   逐项核对后，当前代码没有发现值不匹配：
   - `proactive.pause`：契约类型、`PRODUCTION_PROACTIVE_OPERATIONS`、`ProductionProactive.execute`、能力表、`ci/operations-pending.json`、测试均已登记，`check:operations` 的契约/安装/处理方/测试检查能串起来。
   - `ownerSubject`：返回的 `externalSubjectRef` 与 `RecentAuthenticationGuard` 要求的 `externalSubjectRef`、`ownerId`、`deviceId`、`authenticationRef` 字段对得上；生产装配和测试装配都已传入。
   - `setEnabled`：`ProactiveStorePort`、`SqliteDurableAdapters`、`SqliteProactiveOperations`、`ProductionProactive` 的读写实现都已同步；没有发现漏实现。
   - `tightenEveryItem`：TS 与生成的 Swift 当前规则等价；但如第 1 条所述，没有行为级跨语言验证。
   - `JSONValue`：Swift 文件已存在且 target 包含；但如第 5 条所述，没有自动编译检查。
   - 唯一发现的边界是第 3 条：`built-in` 身份模式下 `ownerSubject` 没有绑定可用，需要近期验证的“改”无法完成；这是使用端行为问题，不是字段类型不匹配。

## 结论

这一轮没有发现可以绕过确认签名、绕过挑战值、或让 `memory.external.respond` 的“keep/改写”落到 `tighten` 的具体漏洞。作者的几条安全说法与代码一致：未确认的“改”在审计和转发前被拒；挑战值跨设备、过期、重放都被拒，并发只成功一次；收紧条目不能夹带额外设置；设备内部会话的 `recent_authenticated_at` 被写成 1970 年，确实不带近期验证凭据。

主要问题集中在验证和边界配置：Swift 规则没有行为测试、`memory.external.respond` 缺少设备网关端到端用例、Swift 不在自动编译检查里，以及 `built-in` 身份模式下 `ownerSubject` 无绑定导致部分“改”失败。后两项中，Swift 编译与 `built-in` 影响属于需要确认的风险；第 1、2 条属于明确的检查缺口。
