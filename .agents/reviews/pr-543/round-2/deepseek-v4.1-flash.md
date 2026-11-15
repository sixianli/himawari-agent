## 本轮核查范围

增量 `b8a0d0d25..9ae3b5069`，以及为核对上一轮意见而跟读的旧代码：`production-device-action-authorization.ts`、`owner-scope-authorization.ts`、`device-action-service.ts`、`sqlite-authorization-reservations.ts`、`sqlite-device-action-operations.ts`、`sqlite-durable-operations.ts`、`action-policy-service.ts`、`action-rules.ts`、`governance-gateway-adapter.ts`、`production-approval-gateway.ts`、`production-http-composition.ts`、`service-main.ts`、相关集成测试与 fixture、`.agents/instructions/prompt-prefix.md`。测试没有运行，所有关于“会不会失败”的判断都是静态阅读；生产环境是否有额外清理/巡检未核实。

## 对作者说法的核对

1. 基本准确。`production-device-action-authorization.ts:56-96` 确实先走只读授权，`59-60` 拒绝“读过外来内容又不允许”的动作，其余交给 `OwnerScopeAuthorization.authorize`；`97-111` 的映射也一致。
2. 基本准确，但“这会消耗一次性授权”不准确：`ActionPolicyService.evaluate` 只是调用 `reserveAuthorization`（`action-policy-service.ts:369-399`），真正消费在 `commit`，设备动作后面没有 commit。另 `approvalOutcome` 对 `expired` 返回 `{kind:"expired"}`，由 `production-device-action-authorization.ts:100-102` 映射成 pending，这部分说法成立。
3. 不准确：正常路径调用 `onApprovalResolved`，但审批已是目标状态时的幂等重放会提前返回，不再调用；错误也被吞掉。见下面意见 1。
4. 准确，`action-policy-service.ts:513-517` 已把 `owner_presence_required` 计入 `recentAuthenticationRequired`。
5. 准确，`production-perception-tools.ts:518-521` 已没有 `hooks.authorize()`，`perception-tools.test.ts` 也断言 `hookCalls.authorize` 为 0。
6. 准确，快照时间戳变化会在 `action-policy-service.ts:340-343` 得到 `approval_hash_mismatch` 并拒绝。

### 1【中】审批回应的幂等重放会跳过 `onApprovalResolved`，定向 reconcile 仍可能丢失

文件：`packages/application/src/services/governance-gateway-adapter.ts:791-797`、`:837-862`；`packages/application/src/services/device-action-service.ts:293-299`

问题：上一轮意见 3 的目标是“刚回应的审批一定被处理”。但 `#respondApproval` 发现审批已经是目标状态时直接返回，**不调用**后面的 `onApprovalResolved`：

```ts
if (
  current.revision === command.payload.expectedRevision + 1 &&
  current.status === command.payload.decision &&
  current.semanticSnapshotHash === command.payload.semanticSnapshotHash
) {
  return `approval:${current.id}:revision-${current.revision}`;
}
...
await this.#dependencies.onApprovalResolved?.(resolved).catch(() => undefined);
```

崩溃恢复或客户端重试（receipt 仍为 `executing`）正好走这条早退；同时 `settle()` 调用的 `reconcile()` 仍固定只取最老 100 条 `waiting_owner`：

```ts
const waiting = await store.list({
  ...scope,
  deviceId: null,
  states: ["waiting_owner"],
  limit: RECONCILE_BATCH,
  ...(approvalId === undefined ? {} : { approvalId }),
});
```

如果刚批准的动作排在第 101 条之后，回调丢失后它只能等前面的动作过期；而它自己也可能先过期，最终出现“主人已批准但动作从未执行/拒绝动作一直不拒绝”。另外 `onApprovalResolved` 的异常被 `.catch(() => undefined)` 静默吞掉，也会走回同一条路。这是上一轮意见 3 的残余，不是已经彻底修好。

建议：在早退分支也调用回调（或在 `execute` 的 `#mutate` 成功后统一调用取决于 `command.type` 的回调）；让 `settle()` 分页处理全部等待项（keyset cursor）而不是固定 100 条；回调失败至少记录日志或落一个可重试标记，不要静默吞掉。

### 2【中低】`DeviceActionResolution.reasonCode` 仍被丢弃，所有非批准结局都记成 `owner_denied`

文件：`apps/agent-service/src/production-device-action-authorization.ts:99-109`；`packages/application/src/services/device-action-service.ts:300-308`；`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:421-428`

问题：上一轮意见 5 没有修改。`resolve` 已经产生了不同原因：

```ts
case "unknown":
case "refused":
  return { decision: "deny", reasonCode: "authorization_denied" };
case "denied":
  return { decision: "deny", reasonCode: "owner_denied" };
```

但 `reconcile` 只取 `outcome.decision`：

```ts
await this.#apply({
  actionId: record.id,
  approved: outcome.decision === "allow",
  ownerPresent: outcome.decision === "allow" && outcome.ownerPresent,
});
```

`#apply` 也不把原因传给 `store.decide`；持久层对所有 `!approved` 一律写 `owner_denied`：

```ts
const reason = !input.approved
  ? "owner_denied"
  : ...
```

结果是 `authorization_denied`（例如 `run_source_unavailable`、`approval_hash_mismatch`）都会被记成“主人拒绝”，决策账本和审批卡显示错误原因。

建议：把 `reasonCode` 一路传到 `#apply` 和 `DeviceActionStorePort.decide`，持久层按允许的 `DeviceActionReasonCode` 校验后写入；至少区分 `owner_denied`、`authorization_denied` 和过期。

### 3【低】上一轮意见 4 只是改善了用例意图，未覆盖 `DeviceActionService` 到生产授权的真实接线；新回调本身也没有自动检查

文件：`test/integration/device-action-approval.test.ts:159-178`、`:264`；`test/integration/device-actions.test.ts:1017-1033`；`apps/agent-service/src/production-http-composition.ts:1519-1525`

问题：`device-action-approval.test.ts` 直接构造 `intent(ASKED)` 调 `authorization.authorize`，没有走 `DeviceActionService.request`；`device-actions.test.ts` 的新用例走 `DeviceActionService`，但把授权换成了 fake：

```ts
h.actions.authorization.current = {
  authorize: async (intent) => ({
    decision: "approval",
    approvalId: `approval:${intent.runId}`,
  }),
  resolve: async (approvalId) => answers.get(approvalId) ?? { decision: "pending" },
};
...
await h.actions.service.reconcile(`approval:run-${total - 1}`);
```

所以“注册表的 `untrustedOriginAllowed` 是否真的传进生产授权”“`production-http-composition` 是否真的把 `approval.id` 传给 `reconcile`”都没有自动检查。把回调参数写错、或把回调放到重放路径之外，现有测试都不会失败。对上一轮意见 4 是部分改善，不是新增反向用例。

建议：新增一个组合真实 `DeviceActionService` + `productionDeviceActionAuthorization` 的集成用例；再用 spy 对 `GovernanceGatewayV2ControlPlane` 的 `onApprovalResolved` 分别覆盖新回应和幂等重放两条路径。

### 4【低｜推测】`sideEffect` 对需要审批的 READ 动作会写成 `reversible`/`irreversible` 而不是 `none`

文件：`apps/agent-service/src/production-device-action-authorization.ts:81`；`packages/application/src/services/device-action-service.ts:528-529`

问题：新行只按可逆性写：

```ts
sideEffect: intent.reversible ? "reversible" : "irreversible",
```

而设备动作自己的风险计算是：

```ts
sideEffect:
  input.actionKind === "READ" ? "none" : input.reversible ? "reversible" : "irreversible",
```

目前 `ReadOnlyDeviceActionAuthorization` 会直接放行所有正常的 READ 动作，注册表里的 READ 动作也没有 `ownerPresence`，所以**当前没有实际触发**。但如果以后出现需要审批的 READ 动作（例如要求本人在场的读取），审批快照和首页/审批卡会把它标成“有外部副作用”，语义与设备动作自己的计算不一致。

建议：这里同样按 `intent.actionKind === "READ" ? "none" : ...` 生成，或加一条注册表/测试约束保证 READ 的 `sideEffect` 只能是 `none`。这是推测性风险，不是当前已发生的行为错误。

## 侧重检查

- **错误路径**：重点看了审批回应失败、重放、回调异常。结论：`onApprovalResolved` 不在持久化 receipt 里，重放早退和 `.catch(() => undefined)` 都会让定向 reconcile 丢失；`settle()` 的 100 条上限使“已批准但排在第 101 条之后”仍可能永远不执行（意见 1）。
- **不合规范/不可信输入**：新 `approvalId` 只来自内部 `ApprovalRequest.id`，走参数化 SQL；`list` 仍校验 states、limit、finishedSince，但没有校验 `approvalId` 的类型/长度。由于调用端是内部服务、不是外部请求，暂时可接受，I-73 式的“产生端/使用端”核对见必答问题 4。
- **安全与不可撤销操作**：`terminalRunStatuses` 只对 `device.action` 放宽 `completed`，`failed`/`cancelled` 仍拒绝，方向是失败关闭；`sideEffect` 修正后 `home.control` 这类不可逆动作在审批快照里标成 `irreversible`；`ownerPresence` 仍由 `resolve` 的 `recentlyAuthenticated` 和 `store.decide` 双重检查。没有发现新增的越权路径。
- **资源耗尽**：定向 `approvalId` 过滤减少了每次回调的扫描量；但 `settle()` 仍对最老 100 条逐一 `resolve`，且晚到批准创建的授权预留没有对应 commit，是否会被定期清理未核实。
- **规则/文档/代码一致性**：`prompt-prefix.md` 的固定前缀没有被本改动触碰；`tool-action-registry.ts:81` 的“可逆性和后果必须一致”不变量现在被 `production-device-action-authorization.ts:80-81` 满足。作者说法 3（“每次审批回应后调用”）与重放路径不一致，见意见 1。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。这个增量只改授权/持久化/审批回调，不组装模型请求；系统提示、工具定义、历史、遮盖都没有变化。设备动作的结果仍走原有工具结果路径，按 `prompt-prefix.md` 第 4 条只能追加到末尾，按第 30 行设备感知/动作结果也只作为工具结果追加。审批号、运行状态、`sideEffect` 都在服务端，不进入请求开头。现有 `perception-tools.test.ts` 仍断言工具描述字节不变。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。新增的 `sideEffect` 只取决于注册表的静态 `reversible`；`approvalId` 过滤只影响数据库查询；`terminalRunStatuses` 只影响授权校验。审批快照里本来就有 `requestedAt`/`expiresAt` 这类时间字段，但它不发给模型。没有新增无序集合、依赖后文的遮盖或每轮变化值进入模型可见内容。

**3. 有没有对应的自动检查，反向用例真的会失败？**
部分有。意见 1 的 `completed`/`failed` 用例、意见 2 的 `sideEffect` 用例、意见 3 的 >100 条过滤用例，按静态阅读都能在旧代码上失败：旧 `resolveApproval` 会拒绝 `completed`；旧 `sideEffect` 来自 `OWNER_WRITE_DEFAULTS` 的 `"reversible"`；旧 `list` 没有 `approvalId` 过滤。意见 4 没有新增反向用例，只是把 fixture 改成 `ASKED`；意见 5 没有测试；最关键的“重放时跳过回调”和“回调异常被吞”没有测试。测试未运行，以上是静态判断。

**4. 每个产生/修改的值，使用端都能接受吗？**
逐个核对如下：
- `reconcile(approvalId?)`：产生于 `production-http-composition.ts:1521` 的 `approval.id`（`string`），使用于 `device-action-service.ts:293-299` 的 `store.list`；其他调用（`settle()`）不传参。两端都是 `string`，可接受。
- `DeviceActionStorePort.list.approvalId`：使用于 `sqlite-device-action-operations.ts:204-239`，SQL 参数化，占位符顺序核对无误；`durable-adapters.ts:1251` 直接透传。没有长度/类型校验，但调用端可信。
- `terminalRunStatuses(capabilityRef)`：产生于 `sqlite-authorization-reservations.ts:21-25`，使用于同文件 `:108` 和 `sqlite-durable-operations.ts:2136-2139`；两端都传 `intent.capabilityRef`/`intentSnapshot.capabilityRef`，非 `device.action` 行为不变，可接受。
- `sideEffect`：产生于 `production-device-action-authorization.ts:81`，经 `OwnerScopeAuthorization:203` 进入审批快照，再被 `governance-gateway-adapter.ts:822` 用于 Grant scope、被 `approval-service.ts:129` 校验、被首页/控制中心展示；值是合法的 `ActionSideEffect`，且与 `reversible` 一致。唯一缺口是上面意见 4 的 READ 场景。
- `onApprovalResolved(approval: ApprovalRequest)`：产生于 `governance-gateway-adapter.ts:862`，使用于 `production-http-composition.ts:1521` 的 `approval.id`；签名和字段匹配。问题只在于重放/异常路径不会产生这次回调（意见 1）。
