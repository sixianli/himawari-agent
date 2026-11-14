### 1. 高：`home/act` 用首页的展示字段 `ownerPresence` 覆盖设备网关的 `change` 档，破坏性命令可以只凭设备签名执行
文件：packages/platform-node/src/device-api-routes.ts:784-808、apps/agent-service/src/production-home.ts:119-137、packages/gateway-contracts/src/client-capabilities.ts:123-169

问题：路由先用 `classifyDeviceGatewayRequest` 算出命令应有的档位，随后又用 `resolved.ownerPresence` 强行改成 `change` 或 `tighten`。而 `ownerPresence` 是首页动作的展示属性，默认 `false`，只有审批的 `approved` 从 `recentAuthenticationRequired` 取。结果 `client-capabilities.ts` 中标为 `change` 的 `approval.respond`、`proactive.insight.respond`、`memory.approval.respond`、`memory.reminder.respond`、`memory.rule.respond`、`memory.external.respond`（`keep`）在这里都会降到 `tighten`，只验证设备请求签名，不要求确认密钥挑战。尤其 `memory.rule.respond` 的 `undo`、`memory.reminder.respond` 的 `cancel`、审批的 `denied` 都属于不可撤销或拒绝类操作。

证据（读代码证实）：
```ts
// production-home.ts:129
const ownerPresence = options.ownerPresence ?? false;
// device-api-routes.ts:808
request: { ...classified, tier: resolved.ownerPresence ? "change" : "tighten" },
```
```ts
// client-capabilities.ts
change("v2", "approval.respond"),          // :123
change("v2", "proactive.insight.respond"), // :135
change("v2", "memory.approval.respond"),   // :158
change("v2", "memory.reminder.respond"),   // :160
change("v2", "memory.rule.respond"),       // :163
```
建议：不要用首页展示字段决定安全档位；至少取 `classified.tier` 和动作策略的较高者，绝不能单方面降低。若产品确实决定某些动作只需设备签名，应建立服务端显式的“动作→是否要本人确认”策略表，写 ADR，并逐项测试破坏性动作的档位。另需确认：最近认证审批的 `denied` 目前不要求确认签名，这与现有 `ApprovalService` 只对 `approved` 要求近期认证一致，但是否符合“要本人在场”的需求措辞，应由产品明确。

### 2. 中：成功后的幂等重发返回 `stale`/`item_gone`，拿不到第一次结果
文件：apps/agent-service/src/production-home.ts:674-694、packages/platform-node/src/device-api-routes.ts:784-793、test/integration/device-home.test.ts:251-268

问题（读代码证实）：`resolveAction` 先重读当前首页并找到条目，找不到就立即返回 `item_gone`，绑定不一致返回 `binding_stale`，然后才进入带 idempotency key 的 `dispatchDeviceGatewayRequest`。多数动作成功后会从首页消失，因此客户端因响应丢失而用同一 `requestId` 重试时，拿到的是 409，而不是第一次的结果。这与设计文档“重复的只认一次并返回第一次的结果”不一致。

证据（读代码证实）：
```ts
// production-home.ts:681-683
const feed = await this.#service.read({ locale: "en" });
const item = feed.items.find(({ key }) => key === input.key);
if (!item) return { ok: false, reason: "item_gone" };
```
```ts
// device-home.test.ts:267-268
const second = await act(h, client, body);
expect([200, 409]).toContain(second.statusCode);
```
建议：先按 `deviceId + requestId` 查已有受理结果并原样返回，或在服务端签名绑定串里带上条目版本/过期时间，使重试可以在不重读首页的情况下安全地再次派发并命中幂等；测试应要求第二次返回与第一次相同的结果，而不是允许 409。

### 3. 中：六种命令只有 `approval.respond` 走了端到端测试，`memory.external.respond` 和 `memory.rule.respond` 连绑定生成测试都没有
文件：test/integration/device-home.test.ts:216-389、test/integration/home-feed.test.ts:839-928、apps/agent-service/src/production-home-binding.ts:49-91

问题（读代码证实）：`device-home.test.ts` 通过真实 HTTP 路由只测了审批动作。`home-feed.test.ts` 新建的绑定测试只覆盖 insight、reminder、memory_request、approval，并且只调用 `resolveAction`，没有经过 `classifyDeviceGatewayRequest`、v2 合约校验和真正的命令处理器。`memory.external.respond` 和 `memory.rule.respond` 的绑定串完全没有测试。这正是 I-73 那类风险：产生端生成了值，但没有验证使用端（网关合约、命令处理）是否接受。

证据（读代码证实）：
```ts
// home-feed.test.ts:851-862，期望列表中没有 external_proposal 和 rule
"approval:approval-bound/approved",
"approval:approval-bound/denied",
"insight:insight-bound/done",
...
"reminder:reminder-bound/cancel",
```
我逐个核对了 `contracts-v2.ts` 中六种命令的 payload schema，目前生成的字段都能通过；但这不是自动检查，改一个字段就可能掉队。建议：用参数化集成测试把六种首页条目各走一遍 `POST /home/act`，断言 200、下游状态改变、审计记录和错误码；并补 `external_proposal`、`rule` 的绑定生成/解析用例。

### 4. 中：仓库里的 Mac 客户端调用 `home/act` 时没有挑战值和确认签名，`ownerPresence` 动作会一直失败
文件：clients/apple/Sources/HimawariCore/MenuBarFeed.swift:84-93、clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:120-139

问题（读代码证实）：服务端对 `ownerPresence` 动作要求 `confirmed`，但 Mac 客户端的 `act` 只发送 `key/action/binding/requestId`，没有 `confirmSigner`、没有 nonce、也没有先调用 `approvals/challenge`。因此需要本人在场的审批按钮在 Mac 菜单栏会返回 403 `DEVICE_GATEWAY_CONFIRM_REQUIRED`，客户端只显示失败。Apple Watch 的实现不在当前仓库，未核实。

证据（读代码证实）：
```swift
// MenuBarFeed.swift:85-92
struct Body: Encodable { let key: String; let action: String; let binding: String?; let requestId: String }
let body = try JSONEncoder().encode(Body(key: item.key, action: action.action, binding: action.binding, requestId: requestId))
_ = try await http.send(DeviceRequest(method: "POST", path: "home/act", body: body))
```
建议：在客户端补上取挑战值、用确认密钥签 `非随机挑战` 的流程，或由服务端/客户端共同约定不支持本人确认的设备不展示这类动作；至少加一条客户端测试覆盖 `ownerPresence: true` 的按钮。

### 5. 低：`device.home.act` 审计不知道操作的是哪个条目、哪个动作，非法和过期尝试也不留审计
文件：packages/platform-node/src/device-gateway.ts:157-167、packages/platform-node/src/device-api-routes.ts:784-815

问题（读代码证实）：审计的 `targetRef` 只由设备 id、网关和命令类型组成，例如 `device-1:v2:approval.respond`；同一类型下不同提醒、规则、审批的操作无法区分。`binding_invalid`、`binding_stale`、`item_gone` 在进入 `dispatchDeviceGatewayRequest` 前就返回，也不会写审计。

证据（读代码证实）：
```ts
// device-gateway.ts:157-158
const action = input.auditAction ?? `device.gateway.${input.request.tier}`;
const targetRef = `${input.pairedDeviceId}:${input.request.entry.gateway}:${input.request.entry.type}`;
```
建议：把脱敏后的 `key`/`action`（或它们的摘要）和 `requestId` 放进审计的 `targetRef` 或扩展字段；对拒绝的 stale/invalid 尝试记录 `rejected`，便于追踪不可撤销操作的来源。

### 6. 低：每次有效动作都重新读取整个首页，存在读取放大和 TOCTOU 风险
文件：apps/agent-service/src/production-home.ts:681、packages/platform-node/src/device-api-routes.ts:784

问题（读代码证实）：`resolveAction` 会重新执行所有首页来源；在 README 目标场景中其中包括邮件/主动洞察等外部读取。每个带有效绑定串的点击都会触发一次完整首页读取。推测：已配对的设备可以反复提交仍然存在的条目绑定串，放大外部源读取；同时从校验到命令执行之间条目状态可能变化。非法绑定会在解码阶段被拒绝，成本较低。

建议：为 `home/act` 增加按设备的基础限流；或把绑定串做成带版本/过期时间的服务端签名凭据，按条目定向查询，而不是每次重读全部来源。

## 侧重检查

- **错误路径（读代码证实）**：无签名 401；locale 缺失/重复/未知 400；额外 query 参数 400；body 非 JSON 415；`requestId` 非机器串 400；`binding` 非字符串 400；绑定跨条目/反向/伪造格式/条目消失/动作不存在分别返回 409/400；本人在场动作无确认返回 403。这些路径有实现，但如上所述非法尝试不写审计，幂等重发行为与设计不符。
- **不可信输入（读代码证实）**：`binding` 在 `decodeHomeBinding` 里先查长度和前缀再解析，长度上限 2048，不会为超长串做无界 base64/JSON 解析；`requestId` 用 `MACHINE_STRING` 校验；`GET /home` 只接受 `locale` 且只接受三种语言；body 有设备请求体上限。未发现注入点。
- **安全（读代码证实 + 判断）**：确认签名依赖挑战值，`PairedDeviceService` 会校验确认 nonce 和挑战值；`withServerFilledReferences` 只在 `confirmed && recentAuthenticationEvidence` 时填 `recentAuthenticationRef`。主要问题是上面的档位覆盖；绑定串本身是明文 base64url JSON，不是签名凭据，目前只靠“必须等于当前首页生成的字符串”来约束，因此重放/跨设备使用只能靠当前条目仍存在来限制。
- **资源耗尽（读代码证实 + 推测）**：非法绑定便宜；有效绑定每次触发完整首页读取，且路由没有单独限流，存在放大读取的推测性风险。
- **不可撤销操作（读代码证实）**：`rule undo`、`reminder cancel`、`external reject`、审批 `denied` 都可通过 `home/act` 触达；服务端审计只记到命令类型，未记具体条目，见第 5 条。
- **规则/文档一致性（读代码证实 + 未核实）**：仓库里的 `packages/gateway-contracts/src/client-capabilities.ts` 把这些命令标为 `change`，代码却降到 `tighten`；作者引用的“方案第 8 节”在仓库中没有对应内容——当前 2026-11-11 Apple 设备设计文档第 8 节是“从感知记录到记忆和提醒”，不是 home/act 的确认策略，因此该说法未核实。
- **模型请求（读代码证实）**：没有改动 prompt、rompt-catalog、runtime-pi 或模型调用；`home` 只出现在设备 API、网关和测试中，未发现首页快照进入模型上下文。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动没有碰系统提示、工具定义、历史消息、遮盖或模型调用；`HomeFeed`/`home.snapshot` 没有出现在 runtime/prompt 组装路径里。发给模型的内容仍应只在末尾追加；新增的会变值（`messageId` 里的时间、`generatedAt`、绑定串）都只在设备 HTTP 响应中，不在模型请求里。

2. **同一段文字会不会在不同请求里变成不同字节？** 新绑定串本身是确定的：`JSON.stringify([type,payload])` 使用固定字面量键序，payload 中没有时间字段，六种命令的 payload 都是固定结构；同一命令每次编码相同。首页条目排序也有 `key` 作为最后比较键。没有发现新的“同文不同字节”问题；`GET /home` 原本就有每请求变化的 `generatedAt` 和 `messageId`，但它们不是模型可见内容。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有 `test/integration/device-home.test.ts` 和 `test/integration/home-feed.test.ts` 的新用例；我读了断言，如果删掉绑定生成、stale 比较或 ownerPresence 确认逻辑，相应用例应会失败。但受工具限制没有实际运行。覆盖不全：只有 `approval.respond` 走了真实 HTTP+网关+下游命令；其余五种只调用 `resolveAction`；`external` 和 `rule` 没有绑定测试。另这些测试不在 `npm run check` 的步骤里，只在 `npm test` 的 integration 项目运行时才跑，不构成 `npm run check` 的阻断门槛。

4. **每个新值、每个使用它的地方都能接受吗？逐个核对两端。**
   - `binding`：产生于 `production-home.ts:137` 的 `encodeHomeBinding`，长度上限与 `contracts-v2.ts:668/764` 的 `HOME_BINDING_MAXIMUM` 一致；设备路由按字符串接收，`resolveAction` 要求与当前首页生成的字符串完全相等。六种命令在 `contracts-v2.ts` 的 payload schema 中都能接受我读到的生成值；但我没有找到 external/rule 的端到端测试来证明下游处理器也接受。
   - `HOME_BINDING_MAXIMUM`：`gateway-contracts` 导出，`production-home-binding.ts` 和 `contracts-v2.ts` 使用同一个常量；两端一致。
   - 新错误码 `DEVICE_HOME_ACTION_STALE`、`DEVICE_HOME_ACTION_INVALID`：路由抛出，`http-gateway-server.ts:916-918` 统一按 `DeviceGatewayError` 返回 `{error:{code}}`；测试按这两个码断言，使用端一致。
   - `auditAction: "device.home.act"`：`AuditRecord.action` 是普通字符串，`AuditLedgerPort` 不限制取值，使用端接受；但审计的 `targetRef` 不包含条目/动作，见第 5 条。
   - `HomeAction.binding`：`HomeAction` 接口、合约 schema、合约 fixture、Swift 客户端的可选 `binding` 都接受；其他测试多用 `toMatchObject`，不会因新增字段失败。
   - `home` 端口：生产组合和测试 harness 都提供；`buildHttpGatewayServer` 可选转发；没有提供时 `/home/act` 返回 400 而不是启动失败，属于可接受但需注意的降级。
