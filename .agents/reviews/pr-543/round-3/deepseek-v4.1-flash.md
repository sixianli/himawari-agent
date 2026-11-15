### 1【中低】`DeviceActionResolution.reasonCode` 仍被丢弃，审批阶段的所有拒绝都写成 `owner_denied`（上一轮意见 2 未修复）

- 文件:行：`packages/application/src/services/device-action-service.ts:302-307`、`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:422-423`、`apps/agent-service/src/production-device-action-authorization.ts:103-107`
- 问题：`resolve` 已经区分 `authorization_denied` 和 `owner_denied`，`reconcile` 却只把结果压成一个布尔值，`store.decide` 再把所有 `approved: false` 一律写成 `owner_denied`。结果是：审批被拒、审批失效后重新判定失败、运行来源不可用等不同结局，模型和决策记录都看到“主人拒绝”。仍然不会放行，属于原因和审计错误，不是越权。
- 证据：
  - `device-action-service.ts:302-307`：`const outcome = await resolve(record.approvalId);` … `approved: outcome.decision === "allow",`
  - `production-device-action-authorization.ts:103-107`：`case "unknown": case "refused": return { decision: "deny", reasonCode: "authorization_denied" };`、`case "denied": return { decision: "deny", reasonCode: "owner_denied" };`
  - `sqlite-device-action-operations.ts:422-423`：`const reason = !input.approved ? "owner_denied" : …`
- 建议：给 `#apply`、`DeviceActionStorePort.decide` 和 SQL `decide` 增加可选 `reasonCode`，`reconcile` 传入 `outcome.reasonCode`；只有真正的 `denied` 才写 `owner_denied`。同时补一个反向用例：让 `resolve` 返回 `{decision:"deny", reasonCode:"authorization_denied"}`，断言数据库原因、账本原因和工具结果都不是 `owner_denied`。另外建议明确 `expired` 是否应写成 `not_delivered_in_time`，目前 `resolve` 把它当 `pending` 跳过。
- 读代码证实：上述生产和消费两端我都逐行读过，结论确定。
- 推测：无。

### 2【低】同幂等键的已完成回执重放仍不走 `onApprovalResolved`，新用例测的是不同 key

- 文件:行：`packages/application/src/services/governance-gateway-adapter.ts:619`、`:805`、`:872`；`test/integration/production-approval-arbitration.test.ts:234-240`
- 问题：本轮的修复只覆盖“审批已经被决定、但回执还没完成”的早退分支。真正同一幂等键、回执已经是 `completed` 的重放，在 `execute` 第 619 行直接返回，不会进入 `#mutate`，因此不会调用第 805 行的回调。新用例第二次请求用的是新 key `"device-one-retry"`，走的是新建回执后命中“已决定”分支，并不是同一请求的幂等重放。若正常路径第 872 行的回调失败（错误被 `.catch(() => undefined)` 吞掉）之后回执完成，同一 key 重放不会重试定向 reconcile，只能等后续某次 `settle()` 做全量 reconcile。
- 证据：
  - `governance-gateway-adapter.ts:619`：`if (attempt.completedResult) return attempt.completedResult;`
  - `governance-gateway-adapter.ts:805`：`await this.#dependencies.onApprovalResolved?.(current).catch(() => undefined);`
  - 测试第 238 行：`await f.request(0, "device-one", "approved", "device-one-retry");`（新 key）
- 建议：在 `completedResult` 早退分支里，如果命令是 `approval.respond`，读出审批并调用 `onApprovalResolved`；或者不要静默吞掉回调失败，至少让同一 key 重放能重试。补一个同 key 重放、且第一次回调失败的用例。
- 读代码证实：早退分支和测试使用不同 key 是确定的；第 805 行覆盖的是已决定分支，不是 completed 回执分支。
- 推测：实际影响取决于回调失败概率；由于 `settle()` 每次设备动作请求都会做全量 reconcile，通常不会永久卡住，只是“定向 reconcile”仍可能丢失。

### 3【低】回调到真实 `DeviceActionService` 的接线仍无自动检查（上一轮意见 3 仅部分修复）

- 文件:行：`apps/agent-service/src/production-http-composition.ts:1527-1532`、`test/integration/production-approval-arbitration.test.ts:234-240`、`test/integration/device-actions.test.ts:981-988`
- 问题：新增用例现在确实检查了“已决定审批重试会再次调用回调”，去掉第 805 行后第二个 `expect(f.resolved)` 会失败。但它只验证回调被调用，没有验证生产接线 `approval.id -> productionDeviceActionAuthorization.resolve -> DeviceActionService.reconcile -> store.list({approvalId}) -> SQL` 的完整链路。`device-actions.test.ts` 新用例把 `authorization.resolve` 换成了假的 `answers.get(...)`；`device-action-approval.test.ts` 测的是生产授权，但没有经过 `DeviceActionService`。因此如果生产组合漏接、传错 id 或以错误方式过滤审批，现有测试仍会通过。
- 证据：
  - `production-http-composition.ts:1529-1530`：`onApprovalResolved: async (approval) => { await options.deviceActions?.service.reconcile(approval.id); },`
  - `device-actions.test.ts:982-988`：`h.actions.authorization.current = { authorize: …, resolve: async (approvalId) => answers.get(approvalId) ?? { decision: "pending" } };`
  - `production-approval-arbitration.test.ts:236-239` 只断言 `f.resolved` 数组，不涉及设备动作。
- 建议：加一条集成用例，使用真实 `createProductionApprovalGateway` + `productionDeviceActionAuthorization` + 真实 `DeviceActionService`（或直接走 `createProductionHttpComposition` 的 `deviceActions` 选项）：先产生一个 `waiting_owner` 动作，再通过网关 `approval.respond` 批准/拒绝，断言动作变成 `queued`/`rejected` 且原因正确。
- 读代码证实：现有测试覆盖范围正如上述，真实接线没有端到端用例。
- 推测：无法确定当前接线一定有错；第 1529-1530 行和 SQL 的 `approval_id` 过滤看起来是对的，风险主要是回归缺口。

**侧重检查**

- 错误路径：查了 `approvalOutcome` 的 `unknown`、`pending`、`denied`、`expired`、`refused`、`allowed` 到 `resolve`、`reconcile`、`store.decide` 的全链，发现 `reasonCode` 丢失（意见 1）。
- 不可信输入：设备动作参数仍由 `DeviceActionService` 校验并冻结；审批 id 来自存储，`approvalId` 进入 SQL 是参数化的；本轮新增回调没有新增路由或用户输入入口。
- 资源耗尽：`reconcile` 有 `RECONCILE_BATCH = 100`，本轮新增的 `approvalId` 定向过滤避免了“早先 100 个等待动作挡住当前审批”的问题，已有超过 100 条的用例覆盖。
- 不可撤销操作：`productionDeviceActionAuthorization` 仍覆盖 `reversible` 和 `sideEffect`，本轮增量没有改这部分；审批快照中“不可逆”的用例仍在。
- 安全/重复询问：工具层移除了 `hooks.authorize()`，动作仍会经过 `OwnerScopeAuthorization`；本轮新增回调是执行审批结果，不是新增授权入口。
- 规则和文档：读了 `.agents/instructions/prompt-prefix.md` 和 ADR 0257。`device_action` 的定义按规则是固定文字，本次没有改工具定义或系统提示。作者说法 2 的“重新 decide 会消耗一次性授权”表述不精确：`reserve` 对同一 intent 是幂等的，真正消耗在 commit 阶段；不影响本轮结论。
- 未核实：`.agents/plans/owner-scope-approval.md` 在当前稀疏检出中不存在；merge 带入的 `capability.reactivate` 完整实现和其测试没有逐条重读，只核对了与设备动作回调的接线没有冲突。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会，也不涉及。增量里唯一的功能改动是审批回调，merge 部分也没有改系统提示、工具定义、历史消息或遮盖规则。整个 PR 对 `production-perception-tools.ts` 只删除了执行前的 `hooks.authorize()` 调用，没有改 `device_action` 的工具描述或参数结构；批准/等待结果只作为工具结果追加在末尾。`approvalId`、时间等变化值在程序状态或数据库里，不在请求开头。发给模型的内容仍然只在末尾追加。
2. **会不会让同一段文字在不同请求里变成不同字节？** 本增量没有引入新的字节不稳定。新增的 `approvalId` 过滤只存在于存储查询；审批回调不进入模型可见文本。设备动作意图仍由 `freeze` 和规范化参数生成，`targets` 顺序固定；`requestedAt`、`expiresAt` 是动作创建时固定并持久化的值。作者已说明的“崩溃在动作插入前、重放时间戳不同会得到 `approval_hash_mismatch`”仍然存在，但结果是安全拒绝，不会改写已经发出的请求内容。未发现新的无序集合或依赖后文的遮盖。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有部分：新增的 `production-approval-arbitration` 用例覆盖“已决定审批再次回调”，去掉第 805 行会失败；`device-actions.test.ts` 的超过 100 条等待动作用例覆盖 `approvalId` 定向过滤，去掉 SQL 过滤会失败。但没有测试覆盖 `DeviceActionResolution.reasonCode` 的传播，也没有测试覆盖从网关回调到真实 `productionDeviceActionAuthorization`/`DeviceActionService` 的生产接线；这两处目前即使改错也不会失败。
4. **新值的产生端和使用端是否都能接受？** 回调 `onApprovalResolved` 由 `GovernanceGatewayV2ControlPlane` 产生，`production-approval-gateway` 透传，`production-http-composition` 取 `approval.id`，`DeviceActionService.reconcile` 接受字符串，SQL 的 `approval_id` 过滤参数顺序正确，类型和语义一致。merge 带来的 `capability.reactivate` 命令在 contracts schema、`GOVERNANCE_COMMAND_TYPES`、`#mutate` 和生命周期服务之间也对得上。唯一明确的两端不一致是 `DeviceActionResolution.reasonCode`：`resolve` 产生两种拒绝原因，`reconcile` 和存储只接受 `approved` 布尔值，后者把原因覆盖成 `owner_denied`（见意见 1）。

**结论和本轮范围**

本轮核对范围：`9ae3b5069..3ef452ceb` 的增量（b2b 回调修复、merge 带入的 capability reactivation 与设备动作的交互）、`production-device-action-authorization.ts`、`device-action-service.ts`、`sqlite-device-action-operations.ts`、`governance-gateway-adapter.ts` 的 `execute`/`#respondApproval`、`production-http-composition.ts` 的回调接线及相关测试。上一轮意见 1 的早退分支已修复，但同 key completed 回执重放仍可能跳过回调；意见 2 未修复；意见 3 仅部分修复。增量本身没有发现新的高严重度安全或资源耗尽问题。
