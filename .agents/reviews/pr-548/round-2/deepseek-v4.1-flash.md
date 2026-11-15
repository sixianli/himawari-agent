## 复核范围

本轮只看 `021431d713d3522a2a8a6bfe303667e9941a5eca..67baca78062bc4a00ae15d80759492af4a14ede0` 的增量，并顺证据跟到旧代码：`device-action-service.ts` 的 `undo/request/#undoState`、`device-api-routes.ts` 的 undo 路由与 `authenticated.confirmed`、`paired-device-service.ts` 的确认密钥校验、`production-device-action-authorization.ts` 的外来内容硬拒绝、SQLite `device_actions` 的幂等键、registry 的 `reversible/undo`、文档接口表和 Apple 客户端 `DeviceActionSummary`。工具限制下未运行测试，以下结论均为静态读代码。

## 侧重检查

- **错误路径**：查了 404（不是本设备）、409（原动作未成功/算不出反向参数）、确认/未确认两条路径、反向动作被拒后的重放。发现未确认尝试会把 `undo:<id>` 幂等键占成 `rejected`，见下面意见 1。
- **不合规范/不可信输入**：`evidence.before` 经反向动作注册表的参数校验；`actions/undo` 的 `id` 经 `DEVICE_ACTION_ID_PATTERN` 校验；未发现新的越权参数入口。设备回报的 `eventId` 等仍按设计被信任，但反向动作仍走统一授权。
- **安全**：`authenticated.confirmed` 确实要求确认密钥签名，并且 nonce 必须是 `/approvals/challenge` 发出的有效挑战（`paired-device-service.ts:360`、`device-request-signature.ts:290-297`）；不再只凭设备签名就算主人亲自点。残余风险是未确认尝试可阻塞确认后的撤销（意见 1）。
- **资源耗尽**：增量没有新增无界循环或批量查询；每个原动作仍只有一个 `undo:<id>` 反向记录。未发现新的资源耗尽路径。
- **不可撤销操作**：`calendar.delete` 的撤销是新建事件（新 ID），这是既定设计；本轮增量未改变。
- **文档与代码一致**：撤销路由已加入接口表（`2026-11-11-apple-device-body-design.md:222`）；`reminder/alarm` 已注明“本批未做”（`:542`、`:544`）。代码里 registry 的 `reversible: true` 未改，但仓库内没有消费者把 `reversible` 当“当前可撤销”使用，外部客户端未核实。

## 上一轮意见核对

- **上一轮意见 1**：核心修好了。路由改为 `ownerPresent: authenticated.confirmed`，服务不再硬编码 `ownerInitiated: true`；未确认请求会按 `readUntrustedContent` 走外来内容判断。但这次修法引入了新的幂等键占用问题，见下面意见 1，因此不能算完全改好。
- **上一轮意见 5**：文档部分已改好（接口表补了 `actions/undo`，`alarm.set`、`device_reminder.*` 标了“本批未做”）。registry 的 `reversible: true` 仍然存在，但它是风险/设计层面的可逆性；`views()` 另给了 `undo` 状态，仓库内 Apple 客户端只解码 `reversible` 而不使用它，未发现会出错的消费者；外部客户端未核实。

### 1. 中高：未确认的撤销会占住 `undo:<id>`，之后带确认密钥也无法再撤销同一动作

- 文件:行：`packages/application/src/services/device-action-service.ts:868-876`、`:361-366`、`:841-855`；`packages/platform-node/src/device-api-routes.ts:879-883`；`packages/persistence-sqlite/src/migrations/20261114172043_device_actions.sql:60`；`apps/agent-service/src/production-device-action-authorization.ts:59-60`；`test/integration/device-actions.test.ts:1264-1266`。
- 问题：`undo` 无论是否带确认密钥，都用同一个 `toolCallId = undo:<原动作号>`。未确认的撤销在新的 `ownerInitiated: false` 下可能被生产授权直接拒绝（`readUntrustedContent=true` 且反向动作 `untrustedOriginAllowed=false`），并被插入一条 `rejected` 的反向动作记录。之后主人带确认密钥再对同一动作点撤销，`request()` 会先按 `runId + toolCallId` 读到这条 `rejected` 记录并直接重放，不再发起新的反向动作；`#undoState` 又把 `rejected` 映射成 `failed`，界面也不会再给撤销。结果是同一动作永远撤不了。
- 证据（读代码证实）：
  - `device-action-service.ts:868-876`：
    ```ts
    return this.request({
      runId: record.runId,
      toolCallId: undoToolCallId(record.id),
      ...
      ownerInitiated: input.ownerPresent,
    });
    ```
  - `device-action-service.ts:361-366`：
    ```ts
    const replayed = await store.readInvocation({ ...scope, runId: input.runId, toolCallId: input.toolCallId });
    if (replayed) return this.#repeated(replayed, input.device.id, input.action);
    ```
  - `device-action-service.ts:847-853`：`rejected`、`expired`、`failed` 都返回 `"failed"`。
  - 生产授权在 `apps/agent-service/src/production-device-action-authorization.ts:59-60`：
    ```ts
    if (!intent.untrustedOriginAllowed && intent.readUntrustedContent)
      return { decision: "deny", reasonCode: "authorization_denied" };
    ```
  - 幂等键的唯一约束是 `(owner_id, agent_id, run_id, tool_call_id)`（迁移 `:60`），插入前也按这四个字段查重（`sqlite-device-action-operations.ts:128-134`）。
  - 新增测试在 `test/integration/device-actions.test.ts:1264-1266` 先对 `targets[0]` 发未确认撤销，再对**另一个**动作 `targets[1]` 发确认撤销；测试用的 `ownerIsAsked` 固定返回 `approval`，没有复现生产的“外来内容硬拒绝”，因此正好绕过了这条 bug。
- 建议：不要让未确认尝试占住确认撤销的幂等键。可让确认与未确认使用不同的 `toolCallId`（例如 `undo:<id>:owner`），或在确认请求遇到先前因缺少确认而被 `rejected/expired` 的 `undo:<id>` 时允许重新发起；同时把这种“因确认不足被拒”在 `#undoState` 中显示为可重试而不是 `failed`。补一条真实反向用例：同一动作先不带确认密钥撤销（按生产授权应被拒），再用确认密钥撤同一动作，必须能进入排队/审批。

## 必答问题

1. **不改变模型已经见过的请求开头。** 本增量只改设备 API 的授权布尔值（`authenticated.confirmed` → `ownerPresent` → `ownerInitiated`）和文档，没有改系统提示、工具定义、历史消息、遮盖或任何发给模型的序列化代码；也没有新增每轮变化的值进入模型内容。给模型的内容仍然只在末尾追加，本次不涉及 prompt 前缀。依据：`.agents/instructions/prompt-prefix.md` 的只追加规则。

2. **不会让同一段文字在不同请求里变成不同字节。** 增量没有新增文本字段、时间字段或无序集合；唯一新增的是请求内的布尔值 `ownerPresent`，它不进入模型内容，也不参与遮盖或 JSON 序列化。反向动作参数来自原记录和 `evidence.before`，本轮没有改变其确定性。不涉及 prompt 序列化。

3. **有对应自动检查，但反向覆盖不完整。** 新增的 `[undo] only an undo confirmed with the confirmation key counts as the owner clicking it` 用例中，`seen.map(readUntrustedContent)` 期望 `[true, false]`；如果把服务改回 `ownerInitiated: true`，或路由硬编码 `ownerPresent: true`，这个期望会失败，说明核心确认路径有反向用例。但缺少“未确认被硬拒绝后，再用确认密钥撤同一动作”的用例；现有测试还用假的 `ownerIsAsked` 授权，掩盖了生产 `production-device-action-authorization.ts` 的硬拒绝路径，所以意见 1 没有被自动检查覆盖。

4. **大部分使用端能接受，但幂等键这一端不能。** `undo({ownerPresent})` 的新必填字段只有 `device-api-routes.ts:879-883` 一个生产调用方，传的是 `paired-device-service.ts:408` 产生的 `authenticated.confirmed`（确认密钥 + 有效挑战）；服务内部只把它当 `ownerInitiated` 传给 `request`，两端类型和校验一致。`actions/undo` 路由和文档接口表一致，`id` 校验也一致。Apple 客户端 `DeviceActionSummary` 只解码旧字段，Swift 会忽略新增未知字段，不会因 `undo` 字段报错。但同一动作的 `undo:<id>` 幂等键同时服务确认和未确认两条路径，前一次未确认被拒的 `rejected` 记录会让后一次确认请求重放旧结果，见意见 1。另：registry 里 `alarm.set`、`device_reminder.complete/create` 仍为 `reversible: true` 而 `undo: "none"`（`device-action-registry.ts:466/630/666`，`device-action-service.ts:904-905`），文档已注明“本批未做”；仓库内没有消费者把 `reversible` 当撤销可用性使用，外部客户端未核实。
