### 1【高】运行已经结束后才被批准的设备动作会在重新 `decide` 时预留失败，从而被当成拒绝
- 文件:行：`apps/agent-service/src/owner-scope-authorization.ts:284-308`、`packages/application/src/services/action-policy-service.ts:365-399`、`packages/persistence-sqlite/src/sqlite-authorization-reservations.ts:90-103`、`packages/application/src/services/device-action-service.ts:299-307`
- 问题：`approvalOutcome` 对已批准的审批会重新 `decide`，`decide` 走到 `reserveAuthorization`。SQLite 的预留会在 `live()` 里要求运行状态不是 `completed/failed/cancelled`；而本 PR 把设备动作的 ASK 改成返回普通工具结果 `waiting_owner`，运行不再挂起，模型回合结束后会正常完成。于是“首页过一会儿再点同意”时，预留失败，`evaluateCurrent` 捕获后返回 `DENY authorization_component_error`，`resolve` 再把它变成拒绝，`#apply` 以 `approved:false` 把动作记为 `owner_denied`。这正是本 PR 要修的场景之一。
- 证据：
  - `apps/agent-service/src/owner-scope-authorization.ts:290-299`：`const decision = await this.decide(approval.intentSnapshot as GovernedActionIntent, source.sourceType, signal); if (decision.decision !== "ALLOW") return { kind: "refused", ... }`
  - `packages/application/src/services/action-policy-service.ts:373-377`：`reservation = await reserve.call(this.dependencies.store, { grantId: grant.id, intent, now: ... })`
  - `packages/persistence-sqlite/src/sqlite-authorization-reservations.ts:90-102`：查到 run 后 `if (!run || run.threadId !== record.intent.threadId || ["completed", "failed", "cancelled"].includes(run.status)) this.fail(... "Run cannot acquire execution authority")`
  - `packages/application/src/services/action-policy-service.ts:535-540`：外层 `catch { return { decision: "DENY", reasonCode: "authorization_component_error" } }`
  - `packages/application/src/services/device-action-service.ts:303-307`：`approved: outcome.decision === "allow"`，非 allow 一律按拒绝处理
- 证据（测试未覆盖）：新测试的夹具 run 被写成 `running`（`test/fixtures/sqlite-capability-invocation-fixture.ts:195-201`），所以不会触发这条路径；“运行完成后批准”未核实是否另有产品流程保证。
- 建议：设备动作的晚到审批不能依赖“运行仍可取得执行权”的预留检查；可选方案是审批时一次性预留/记录授权、或给设备动作单独的“审批后消费”路径、或让等待设备审批的 run 保持非终态。补一条夹具 run 为 `completed` 的测试，从 `approvalOutcome` 到 `#apply` 全链路断言仍能放行。

### 2【中】不可撤销的设备动作在审批快照里被写成“可撤销”，首页和审批卡会向主人显示错误的后果
- 文件:行：`apps/agent-service/src/production-device-action-authorization.ts:77-82`、`apps/agent-service/src/production-tool-actions.ts:61-73`、`apps/agent-service/src/production-tool-actions.ts:339-350`、`packages/application/src/services/device-action-service.ts:527-528`、`packages/application/src/services/device-action-registry.ts:616-624`
- 问题：设备动作登记行来自 `OWNER_WRITE_DEFAULTS`，其中 `sideEffect: "reversible"`。新授权只覆盖了 `actionKind`、`reversible`、`ownerPresenceRequired`，**没有覆盖 `sideEffect`（也没有覆盖 `disclosure`/`recipients`）**。`home.control` 是非日常类别时 `reversible:false`、`escalation:"PHYSICAL_SAFETY"`，`DeviceActionService` 自己算出的 `intent.sideEffect` 是 `irreversible`；但审批快照和授权 grant 记的是 `reversible`。审批卡直接显示 `intentSnapshot.sideEffect`，首页也把 `sideEffect`/`reversible` 放进详情。
- 证据：
  - `apps/agent-service/src/production-device-action-authorization.ts:77-82`：`{ ...row, actionKind: intent.actionKind, reversible: intent.reversible, ownerPresenceRequired: intent.ownerPresence }`
  - `apps/agent-service/src/production-tool-actions.ts:61-73`：`sideEffect: "reversible"`
  - `packages/application/src/services/device-action-service.ts:527-528`：`sideEffect: input.actionKind === "READ" ? "none" : input.reversible ? "reversible" : "irreversible"`
  - `packages/application/src/services/device-action-registry.ts:619-624`：`escalation: ... "PHYSICAL_SAFETY"`、`reversible: false`
  - `apps/agent-service/src/production-home.ts:220-221`：`sideEffect: intent.sideEffect, reversible: intent.reversible`
  - `apps/control-center/src/components/run-approval-card.tsx:180`：`message(\`review.impact.${snapshot.payload.intent.sideEffect}\`)`
- 建议：在调用 `ownerScope.authorize` 时同时用设备动作的 `sideEffect`、`disclosure`、`recipients` 覆盖登记行（或直接从 `intent` 派生），并加一条 `home.control` 的审批快照断言 `sideEffect === "irreversible"`。`recipients` 目前所有登记都是 `null`，属于潜伏问题；但 `sideEffect` 在当前登记表上已经是错的。

### 3【中】`reconcile` 只扫描最老的 100 条 `waiting_owner`，审批回调又不使用刚批准的 approval id，排在后面的已批准动作可能永远不被处理
- 文件:行：`packages/application/src/services/device-action-service.ts:177`、`packages/application/src/services/device-action-service.ts:289-298`、`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:215-224`、`apps/agent-service/src/production-http-composition.ts:1519-1525`、`packages/application/src/services/governance-gateway-adapter.ts:862`
- 问题：`reconcile` 固定 `limit=100`，列表按 `created_at, id` 最老优先。若前 100 条一直是未回答的 `waiting_owner`，第 101 条即使已经获批，`onApprovalResolved` 触发的 `reconcile` 也只会看到前 100 条，不会处理它；只有等前面某条被拒绝/过期后才有机会。审批回调虽然拿到了 `resolved`，生产装配却调用无参的 `reconcile()`，没有用 approval id 直接定位动作。
- 证据：
  - `packages/application/src/services/device-action-service.ts:177`：`const RECONCILE_BATCH = 100;`
  - `packages/application/src/services/device-action-service.ts:293-298`：`store.list({ ...scope, deviceId: null, states: ["waiting_owner"], limit: RECONCILE_BATCH })`
  - `packages/persistence-sqlite/src/sqlite-device-action-operations.ts:223-224`：`ORDER BY created_at, id LIMIT ?`
  - `apps/agent-service/src/production-http-composition.ts:1521-1523`：`onApprovalResolved: async () => { await options.deviceActions?.service.reconcile(); }`
- 建议：让回调把 `approval.id` 传给 `reconcile`，按 `approvalId` 查记录并只处理对应动作；同时把扫描改成可分页/循环到没有更多，或至少优先处理刚批准的 approval。补一条“101 条等待动作、批准最后一条”的用例。

### 4【中】新测试没有走真实的 `DeviceActionService` 路径，“读过外来内容后问主人”这个场景在真实链路上会直接拒绝，测试给的是假信心
- 文件:行：`test/integration/device-action-approval.test.ts:142-143`、`test/integration/device-action-approval.test.ts:166-187`、`packages/application/src/services/device-action-service.ts:411-412`、`apps/agent-service/src/production-device-action-authorization.ts:59`
- 问题：测试为了制造 ASK，直接调用 `productionDeviceActionAuthorization.authorize`，并让 `intent.readUntrustedContent` 保持默认 `false`。真实生产里 `DeviceActionService` 会用 `readUntrustedContent(input.runId)` 把它设成 `true`（只要这个对话/运行读过任何外来内容）。而 `calendar.create`/`calendar.delete` 等登记的 `untrustedOriginAllowed` 是 `false`，新授权会走 `if (!intent.untrustedOriginAllowed && intent.readUntrustedContent) return deny`，**不会创建审批卡片**。也就是说，测试标题描述的“读过外来内容后问主人”在真实 `calendar.create` 上并不成立；如果要问，需要 `untrustedOriginAllowed:true` 的动作（如 `alarm.set`、`device_reminder.create`）。另外 `onApprovalResolved`/`settle→reconcile` 的装配、以及完成 run 的批准，都没有测试。
- 证据：
  - 测试：`readUntrustedContent: false`（142-143），随后 `await s.externalContent.mark(RUN_ID, "perception_read"); const asked = await s.authorization.authorize(intent());`（169-170）
  - 生产：`readUntrustedContent: await this.#options.readUntrustedContent(input.runId)`（`device-action-service.ts:412`）
  - 授权：`if (!intent.untrustedOriginAllowed && intent.readUntrustedContent) return { decision: "deny", ... }`（`production-device-action-authorization.ts:59`）
- 建议：用真实 `DeviceActionService`（或至少把 `readUntrustedContent` 按生产规则注入）做集成测试；分别覆盖 `untrustedOriginAllowed:false` 的拒绝分支和 `true` 的 ASK 分支；再加一条经由 Gateway 的 `approval.respond` 触发 `onApprovalResolved` 的端到端用例。`npm run check` 的脚本清单里没有运行 `test:integration`，这些新用例目前不在阻断检查内。

### 5【中低】`DeviceActionResolution.reasonCode` 被产生但被消费端丢弃，所有拒绝都会被记成“主人拒绝”
- 文件:行：`packages/application/src/ports/device-actions.ts:224-227`、`apps/agent-service/src/production-device-action-authorization.ts:98-108`、`packages/application/src/services/device-action-service.ts:303-307`、`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:419-425`
- 问题：`resolve` 区分了 `owner_denied`、`authorization_denied` 等，但 `reconcile` 只把结果折成 `approved:boolean`，没有把 `reasonCode` 传下去；`store.decide` 在 `approved=false` 时硬编码 `reason = "owner_denied"`。因此审批记录不存在、来源不可用、授权组件错误、运行已结束等都不是主人拒绝，却都会以 `owner_denied` 告诉模型和记录。这是 I-73 那类“值在一端产生、另一端不认”的问题。
- 证据：
  - `production-device-action-authorization.ts:105-106`：`case "denied": return { decision: "deny", reasonCode: "owner_denied" };`
  - `device-action-service.ts:303-307`：`await this.#apply({ actionId: record.id, approved: outcome.decision === "allow", ownerPresent: ... });`（没有传 `outcome.reasonCode`）
  - `sqlite-device-action-operations.ts:419-422`：`const reason = !input.approved ? "owner_denied" : ...`
- 建议：给 `#apply`/`store.decide` 增加拒绝原因参数，至少区分 `owner_denied`、`authorization_denied`、`not_delivered_in_time`；补一条“审批不存在/来源不可用”的用例断言模型看到的原因不是 `owner_denied`。

### 6【低】`approvalOutcome` 读运行来源时没有像 `authorize` 那样核对 runId/ownerId/agentId，且只检查近期认证引用非空
- 文件:行：`apps/agent-service/src/owner-scope-authorization.ts:155-162`、`apps/agent-service/src/owner-scope-authorization.ts:288-308`、`packages/application/src/services/approval-service.ts:71-76`、`packages/application/src/services/recent-authentication-service.ts:76-90`
- 问题：`authorize` 会检查 `source.runId === invocation.runId` 以及 owner/agent；`approvalOutcome` 只检查 `if (!source)`。另外 `recentlyAuthenticated` 只看 `approval.recentAuthenticationRef` 是否非空，没有在解析时重新验证时效和证据；真正的时效校验只在 Gateway 的 `#assertRecentAuthentication` 里（`governance-gateway-adapter.ts:798-803`），测试里直接调 `ApprovalService.respond` 会绕过它。生产装配下来源是按 owner/agent 取的、近期认证在 respond 时已验证，所以当前风险有限；这是纵深防御缺口。
- 证据：`owner-scope-authorization.ts:288-294`：`const source = await this.#options.source.read(approval.runId); if (!source) return { kind: "refused", ... }`；`owner-scope-authorization.ts:305-307`：`typeof governed.recentAuthenticationRef === "string" && governed.recentAuthenticationRef !== ""`
- 建议：在 `approvalOutcome` 复用 `authorize` 的来源校验；至少在设备动作需要本人在场时，解析 `recentAuthenticationRef` 时再验证或记录该引用是由哪条通过校验的网关请求写入的。Apple 端是否能提供 `recentAuthenticationRef` 与证据，未核实。

### 7【低】设备动作绕开了工具层统一出口的错误诊断路径，且处理中会吞掉审批回调错误
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:689-731`、`apps/agent-service/src/production-device-actions.ts:116-135`、`packages/application/src/services/governance-gateway-adapter.ts:862`
- 问题：普通 owner-scope 工具在 `#ownerScopeGate` 里有 try/catch，会写 `runtime-tool-diagnostic:...authorization_component_error` 并把错误变成 DENY；设备动作现在在 `DeviceActionService` 内部直接调 `OwnerScopeAuthorization.authorize`，没有这层处理，异常会走通用的 `DEVICE_ACTION_UNAVAILABLE`。审批回调 `.catch(() => undefined)` 也会吞掉 `reconcile` 的失败，只能等下一次 `settle`。这不是安全绕过，但会让排障信息丢失。
- 证据：`production-runtime-tools.ts:708-727` 的 catch 写诊断；`production-device-actions.ts:117-124` 直接 `service.request`；`governance-gateway-adapter.ts:862`：`await this.#dependencies.onApprovalResolved?.(resolved).catch(() => undefined);`
- 建议：给设备动作授权加同样的诊断记录和错误归类；回调至少记录日志/指标，避免失败不可见。

**作者说法核对（读代码证实的）**
- 说法 1：大体成立，但“用设备动作的行覆盖动作类别、可逆、是否要主人在场”不完整：没有覆盖 `sideEffect`/`disclosure`/`recipients`，也没有使用 `intent.risk`。见意见 2。
- 说法 2：“已过期为 pending”在 `approvalOutcome` 层面不准确：`approval.status === "expired"` 返回的是 `{kind:"expired"}`，由 `productionDeviceActionAuthorization.resolve` 再映射成 pending。已批准时重新 `decide`、返回 ALLOW 才 allowed、会消耗一次性授权，这几点成立。
- 说法 3：`settle()` 开头调用和 `onApprovalResolved` 回调成立；但幂等重放时 `#respondApproval` 会提前返回（`governance-gateway-adapter.ts:791-797`），不走回调；回调参数 `resolved` 在生产装配里被完全忽略。
- 说法 4 成立：`recentAuthenticationRequired` 增加了 `owner_presence_required` 事实判断（`action-policy-service.ts:513-517`）。
- 说法 5 成立：`ProductionPerceptionTools.#action` 已不再调用 `hooks.authorize()`（`production-perception-tools.ts:422-532`），`#ownerScoped` 这一层对 perception 传入的 gate 是 `undefined`（`production-runtime-tools.ts:739-754`），因此设备动作只由 `DeviceActionService` 里的新授权端口授权一次。
- 说法 6 成立：重放时 `requestedAt`/`expiresAt` 不同会让 `approvalMatchesIntent` 返回 false，最终 `approval_hash_mismatch`；代价是旧审批卡片会留在首页但永远不会驱动动作（这一点说明里没写）。

**侧重检查**
- 不可撤销操作：`home.control`（例如门锁类别不在 `HOME_ROUTINE_CATEGORIES`）是 `reversible:false`、`PHYSICAL_SAFETY`，但审批快照被写成 `sideEffect:"reversible"`，审批卡和首页会显示“可撤销”，见意见 2。是否执行由 `store.decide` 的 `ownerPresence && !ownerPresent` 兜底，实际不可撤销性没有被绕过，但给人看的后果标错了。
- 错误路径：运行结束后批准会在预留处失败并被记成拒绝（意见 1）；审批不存在/来源不可用会被记成 `owner_denied`（意见 5）；回调错误被吞（意见 7）；`expired` 审批先映射为 pending，依赖随后的 `settleDue` 收尾。
- 不可信输入：设备参数由 `validateDeviceActionArguments` 校验，report/claim 也有校验；`approvalId` 只来自本授权端口返回的审批，未发现外部可直接注入 approval id 的入口。缺口是 `approvalOutcome` 的来源校验不完整（意见 6），以及近期认证只在 Gateway 路径校验。
- 资源耗尽/并发：`reconcile` 在每次 `settle`（request/claim/reopen/views/decide）都扫描最多 100 条，存在 100 条窗口饥饿（意见 3）；没有显式互斥，两次并发 `reconcile` 可能重复 ledger/重复 `delivery.announce`，但 SQLite 预留对同一 intent 是幂等的，`decision_ledger` 也是 `ON CONFLICT DO NOTHING`，没有核实到会重复执行设备动作。
- 规则/文档一致性：改动没有触碰 `packages/prompt-catalog`、系统提示或工具定义，符合 prompt-prefix 规则 2、3、4、7；ADR 0257 的“登记为不能由外来内容引出的动作，上下文有外来内容时直接拒绝”与 `production-device-action-authorization.ts:59` 一致。不一致的是测试标题与真实 `DeviceActionService` 链路（意见 4），以及作者说法 2、3 的小偏差。

**必答问题**
1. **不会改变模型已经见过的请求开头。** 本次 diff 没有修改系统提示、工具定义、历史消息或遮盖逻辑；`device_action` 的固定定义没有变。设备动作现在返回的是一个正常的 `waiting_owner` 工具结果，仍然追加在末尾；审批的标题/正文、`requestedAt`/`expiresAt`、targets 等都只在审批记录里，不发给模型。依据是 `.agents/instructions/prompt-prefix.md` 的 `#rules` 第 4 条“已经发给过模型的内容……只能在末尾追加”和第 2、3 条关于“每轮会变的值只放在最后一条消息/工具结果”的要求。唯一行为变化是以前 ASK 会挂起运行、没有模型结果，现在会追加 `waiting_owner` 结果；这仍是末尾追加，不是改写开头。
2. **对模型可见的字节不会因同一段文字在不同请求里改变。** 新值里 `targets` 顺序固定，外部来源经过 `sort()`，事实经过 `runtimePolicyFacts` 去重排序，设备参数经 `validateDeviceActionArguments` 按参数名排序；审批 id 用固定顺序的 `{action, device, arguments}` 计算。`requestedAt`/`expiresAt` 是时间字段，但只存在于审批快照，不进入模型请求；审批展示还会经过 `maskSensitiveText`，但只影响审批卡。没有发现新的“同文不同字节”进入模型请求的路径。
3. **有自动检查，但覆盖不足。** 新增 `test/integration/device-action-approval.test.ts` 和 `device-actions.test.ts` 的 `[approval]` 用例，确实有“拒绝/未知审批/未授权外来内容”的反向断言；去掉对应映射时这些断言会失败。但它们在 `test/integration`，`npm run check` 的脚本清单没有运行 `test:integration`；关键装配（`onApprovalResolved`、`settle→reconcile`）没有测试；完成 run 后的批准、`reasonCode` 映射、`sideEffect` 一致性也都没有反向用例。意见 4 的测试还会在真实 `DeviceActionService` 路径上得出与标题相反的结果。
4. **逐个值的两端核对结果**：
   - `approvalId`：由 `PermissionDecision.approvalRequest.id` 产生，记到 `device_actions.approval_id`，由 `reconcile` 读回并交给 `resolve`。两端都能接受字符串；`approvalOutcome` 还校验 owner/agent。没有发现类型或校验冲突。
   - `title`/`detail`：由 `registration.title` 和 `registration.detail(...)` 产生，`approvalDisplay` 按 `zh-CN/en/ja` 读取；登记表的 `DeviceActionDetail` 与 `DeviceActionApprovalLocale` 一致，缺失时回退 `null`/空串。两端一致。
   - `DeviceActionResolution.reasonCode`：生产端区分了多种原因，消费端 `#apply` 丢弃，最终都记成 `owner_denied`，见意见 5。
   - `sideEffect`/`reversible`/`disclosure`/`recipients`：`reversible` 被覆盖了，`sideEffect`、`disclosure`、`recipients` 没有；当前 `sideEffect` 已经和 `home.control` 不一致，见意见 2。`intent.risk` 由 `DeviceActionService` 产生但授权端重新计算、完全不读它；当前登记表下两者一致，属于潜伏风险。
   - `recentAuthenticationRequired`：`ActionPolicyService` 产生布尔值，`ApprovalService.respond`、Gateway、首页和推送都按布尔值使用；`owner_presence_required` 已在事实代码表登记。两端一致。
   - `onApprovalResolved`：类型声明接收 `ApprovalRequest`，生产装配接收但忽略，控制面在普通回应后调用；幂等重放路径不调用。消费端没有使用参数，见意见 3。
