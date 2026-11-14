# PR 456 代码复核

结论先说：发现一个会让“等主人点头→同意后执行”在实际时钟下直接失败的高严重度问题；现有集成测试用固定时钟把它掩盖了。另有规则修订号语义与 ADR 不一致、授权异常逃逸、并发未去重等问题。

## 一、读代码证实的问题

### 1. 严重（高）：`freeze` 不是“读回旧意图”，时钟一变就 `PORT_CONFLICT`，审批回放会失败

- 文件:行：`apps/agent-service/src/owner-scope-authorization.ts:165`；`apps/agent-service/src/production-runtime-tools.ts:642`
- 问题：`freeze` 每次都先写同一个 `owner-scope-intent:<id>`，然后才读回。动作意图里的 `requestedAt: now` 来自实时时钟，同一次工具调用重放时时间已经前进，写入内容不同；而底层 `RunPayloadArtifactPort.commit` 对已存在的 operationKey 只接受内容摘要相同的 payload，否则抛 `PORT_CONFLICT`。因此“先 ASK、主人同意后重放执行”以及“同一调用重放拿回同一个结果/拒绝”在真实时钟下会在 `freeze` 处抛异常，而不是读回冻结意图。
- 证据：

  `owner-scope-authorization.ts:165`
  ```ts
  const intent = (await freeze(`owner-scope-intent:${id}`, proposed)) as GovernedActionIntent;
  ```

  `production-runtime-tools.ts:642`
  ```ts
  async (key, value) => this.#readJson((await this.#writeJson(invocation, key, value)).ref),
  ```

  底层 `packages/persistence-sqlite/src/sqlite-run-payload-artifact-operations.ts:292-306`：已存在时 `if (!this.sameIdentity(existing, protectedPayload)) return this.fail("PORT_CONFLICT", ...)`；`:504-509` 的 `sameIdentity` 比较 `contentDigest`，而 `contentDigest` 是明文摘要（`packages/platform-node/src/payload-protector.ts:226`）。`requestedAt` 变了，摘要就变。

  集成测试之所以通过，是因为时钟被固定：`test/integration/tool-action-registry.test.ts:58` `const clock = { now: () => T1 };`，同一用例第二次执行在 `:185`，时间仍是 `T1`，生成的意图逐字节相同，才走到 `replayed` 分支。生产时钟是 `new Date().toISOString()`（`service-node.ts` 的 `productionClock`，实际在 `service-main.ts:244`）。
- 建议：`freeze` 必须先 `artifacts.lookup`，存在就直接读回，不存在才写；或者首轮把意图的 `requestedAt/expiresAt` 固定下来，后续不再重新计算。增加一个“时钟前进后重放同一调用”的用例：先 ASK，推进时钟，再执行，断言仍是同一个 `approvalRequestId`，同意后只执行一次。

### 2. 中：规则修订号变化时会自动重新打开长期授权，和 ADR 写法不一致

- 文件:行：`apps/agent-service/src/owner-scope-authorization.ts:226-247`
- 问题：记录被关掉（`enabled !== true`）时返回 `undefined`，会走“问主人”，这部分符合作者说法 4。但记录仍开着、`ruleRevision` 变化时，代码不是“改成问主人”，而是直接写入 `{ enabled: true, ruleRevision: 新值, actorId: "default" }` 并继续预授权。ADR 的新值清单明确写的是“记录被关掉或改过，旧的预先授权不再能用，新的动作改成问主人”。
- 证据：

  ```ts
  if (record && record.value["enabled"] !== true) return undefined;
  if (!record || record.value["ruleRevision"] !== hit.revision) {
    const value = { enabled: true, ruleRevision: hit.revision, actorId: "default" };
    ...
  }
  ```

  `docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:211`：
  “记录被关掉或改过，旧的预先授权不再能用，新的动作改成问主人”。

  当前没有任何测试覆盖“修订号变化”：集成测试只覆盖了 `enabled: false`（`test/integration/tool-action-registry.test.ts:232-263`）。
- 建议：修订号不一致时返回 `undefined`，让 `ActionPolicyService` 建待审批；如果确实希望自动续期，需要改 ADR 并说明“记录里的同意不区分规则修订号”，同时记录规则内容摘要，避免修订号漏改时扩大授权。

### 3. 中：`gate()` 在 `#ownerScoped` 的 try 之外，授权/存储异常会直接变成工具执行拒绝，而不是受控的失败结果

- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:752-756`
- 问题：`previous` 检查、`gate()` 都在 `try` 外；只有 `run(invocation)` 在 `try` 内。`OwnerScopeAuthorization` 在 `#standingAuthorization`、`applyOwnerPolicyAuthorization`、`freeze` 里都可能抛异常（状态修订冲突、审批修订冲突、审计失败、上面第 1 条的 `PORT_CONFLICT`）。这些异常会穿过 `gate?.()`，让整个 `execute` reject，模型收不到“操作未执行”的结构化工具结果，运行也可能因此失败。
- 证据：

  ```ts
  if (previous) return (await this.#readJson(previous.payloadRef)) as RuntimeToolExecutionResult;
  const stopped = await gate?.();
  if (stopped) return stopped;
  let result: RuntimeToolExecutionResult;
  let recorded = invocation.dataClassification;
  try {
    const { value, contentClassification } = await run(invocation);
  ```

  对比 `OwnerScopeAuthorization.decide` 里 `this.#policy.evaluate` 自己会 catch 并返回 `authorization_component_error`（`packages/application/src/services/action-policy-service.ts:544-551`），而 `applyOwnerPolicyAuthorization` 和 `#standingAuthorization` 没有同样的兜底。
- 建议：把 `previous` 之外的整个授权步骤纳入受控错误处理；授权异常返回带 `dispatchState: "not_sent"` 的失败结果，或让 `authorize` 统一把内部异常转成 DENY。为“状态存储抛错/审批写入冲突”补测试，断言不执行副作用、模型能收到失败说明。

### 4. 中低：`#ownerScoped` 没有 `#executeCanonical` 那样的单飞去重，并发相同调用可能一边成功一边抛错/被配额拒绝

- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:734-753`
- 问题：`previous` 查询和 `gate`/`run` 不是原子的，也没有 `#inFlight` 之类的同 key 合并。两个并发相同调用会同时看到“没有上次结果”，同时进 `gate`。当前提醒/规则的写入端确实按 `runId + toolCallId` 幂等（`production-reminder-writer.ts` 的 `key`、`production-owner-rules.ts` 的 `key = hash(runId\ntoolCallId)`），所以不会重复建提醒/规则；但授权侧会出现两个 `freeze` 写同一 key、两个 `applyOwnerPolicyAuthorization` 争同一个审批修订号、同一个一次性 grant 被并发 `reserveAuthorization`，其中一个可能得到 `PORT_CONFLICT`/`authorization_quota_unavailable` 或直接抛异常。登记表里声明的 `deduplication: "run_and_tool_call"` 目前没有任何代码读取（全仓库只有定义处）。
- 证据：`#executeCanonical` 有 `#inFlight` 合并（`production-runtime-tools.ts` 的 `#inFlight`、`const active = this.#inFlight.get(key)`），而 `#ownerScoped` 没有；`ToolActionRow.deduplication` 只有定义和 `assertRow` 的非空检查，没有执行端消费者。
- 建议：复用同 key 单飞，或让 `OwnerScopeAuthorization`/审批创建对同一 intent 的并发结果做幂等返回；补并发相同调用用例，断言只产生一个审批、一次执行、两个调用拿到相同结果。

### 5. 中低：登记表的交叉校验不足，误标成读取的行可能绕过统一出口

- 文件:行：`packages/application/src/services/tool-action-registry.ts:75-82`；`apps/agent-service/src/production-runtime-tools.ts:621-628, 635`
- 问题：`assertRow` 只根据行自己声明的 `actionKind`/`sideEffect` 判断“是否有后果”，不会交叉核对 `authorization`、`executor`、`targetType`、`capabilityRef` 是否自洽。执行时 `#builtinExecutor` 只看 `targetType` 和配置选择执行器，`#ownerScopeGate` 只看 `authorization`。所以一行只要写成 `authorization: "read"`、`actionKind: "READ"`、`sideEffect: "none"`，同时 `targetType: "owner-reminder"`、`executor: "owner_scoped"`、`capabilityRef: "reminder.set"`，就会被当成读取：不建 gate，但 `#builtinExecutor` 仍会把 `reminder_set` 交给记录器执行。当前 23 行没有这种错误，但登记表是新的信任锚，未来设备动作或手写行很容易踩到。
- 证据：

  ```ts
  const consequential = row.actionKind !== "READ" || row.sideEffect !== "none";
  if (row.authorization === "read" && consequential) fail("有后果却登记成读取");
  ```

  这一段没有校验 `executor`/`targetType` 与 `authorization` 的组合。执行侧：

  ```ts
  if (row.executor !== "owner_scoped") return undefined;
  if (row.targetType === "owner-reminder" && this.#options.reminders)
    return (invocation, gate) => this.#reminder(invocation, gate);
  ...
  if (row.authorization !== "owner_scope") return undefined;
  ```

- 建议：在 `assertRow` 里固定合法组合（例如 `authorization === "read"` 只允许 `executor === "owner_scoped"` 且 `targetType` 属于只读集合），并增加“把 `reminder_set` 标成读取必须被拒绝”的反向用例。还可校验 `actionKind`、`sideEffect`、`disclosure` 的值域，而不只依赖 TypeScript。

### 6. 低：登记表里多个值是“只生产、无消费者”，文档要标明属于后续步骤

- 文件:行：`apps/agent-service/src/production-tool-actions.ts` 各行的 `detail`、`resultOrigin`、`mayFollowExternalContent`、`deduplication`、`device`
- 问题：全仓库检索 `deduplication` 只有定义和 `assertRow` 使用；`detail` 函数没有被任何生产代码调用；`mayFollowExternalContent`、`resultOrigin` 在执行和授权路径也没有读者。ADR 新值清单把其中一些说成已经由登记表驱动（例如“给主人看的那行明细由哪个函数按实际参数生成”“不能由外来内容引出时直接拒绝”），但本 PR 尚未接上。对第 1 步可以接受，但文档/说法应明确“字段已定义，第 2/4 步才消费”，否则复核者会以为已经生效。
- 建议：在 ADR 或 PR 说明中把“已定义未消费”与“已生效”分开；如果第 1 步就要用 `mayFollowExternalContent`，应在统一出口读取它。

## 二、推测与未核实

- **未核实**：作者说法 1 里的 `EVERY_TOOL_DEFINITIONS_SHA256 = d1de2678...` 是否确实等于干净 `origin/main` 的哈希。我没有运行测试，也不能独立计算。能确认的是代码路径：`listAuthorized` 仍然按原顺序构造描述符，`offer` 只是 `filter`，不改对象和顺序；23 个名字都能在登记表里命中。只要 `everyToolOptions` 与 main 环境一致，哈希应不变。
- **推测**：运行时是否会在 `execute` reject 后把异常转成模型可见的工具错误，取决于上层调用方；本次没有读到那层。若无兜底，第 3 条的异常会冒泡得更高。
- **未核实**：设备动作的真实行、未来是否会有 `family: "device_action"` 的行进入 `#builtinRow` 之外的新执行器；本 PR 没有设备行。

## 三、侧重检查

- **错误路径**：查了 `#ownerScoped` 的 `previous → gate → run → result`、`OwnerScopeAuthorization` 的 `freeze/decide/#standingAuthorization/applyOwnerPolicyAuthorization`。结论：规则拒绝和权限引擎 DENY 是受控的；但 `freeze`、状态写入、审批写入的异常不受控（第 1、3 条）。
- **不合规范/不可信输入**：`ToolActionRegistry.assertRow` 只校验登记表自身的声明，不校验执行器与授权路径的组合（第 5 条）；`arguments` 只取摘要进意图，未直接入 prompt，未见新的注入面。`productionToolActionRegistry(extra)` 允许外部追加行，但没有运行时值域校验，未来接入设备动作时要补。
- **安全/授权绕过**：未发现现存 23 行可以绕过统一出口；读取类确实不建 gate；`execution.task.*` 仍走旧任务管理路径；`authorization_handle`/coding 仍走原路。潜在绕过是登记表误标（第 5 条）。
- **资源耗尽**：每次工具调用新增少量 artifact（意图、owner-scope intent、结果），按调用数有界；未见循环或无限增长。长期授权记录每个内置规则一条，数量有界。
- **不可撤销操作**：本 PR 的内置动作都登记为可撤销（`reminder_set`/`reminder_cancel`/`rule_set`/`rule_undo`），`rule_set`/`rule_undo` 带 `standing_rule_change` 事实但规则不据此拒绝；第 1 步按 ADR 是“无外来内容时直接做”，所以可接受，但第 2 步必须补上外来内容事实，否则改规则会在读过网页后仍直接生效。
- **规则文件、文档与代码一致性**：发现 ADR 第 211 行与 `#standingAuthorization` 修订号行为不一致（第 2 条）；`deduplication`/`detail` 等字段“有定义无消费”（第 6 条）；其余新值（动作闸门字段、结果值、事实代码、`action-rule:<ruleId>` 键）两端一致。

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（在登记表完整的当前 23 个工具下）。** 系统提示、工具定义、历史消息、遮盖结果都没有被修改；`listAuthorized` 仍按原顺序生成，`this.#registry.offer(descriptors)` 只是过滤，不重排、不改对象；测试还固定了名字列表和定义哈希。新增的模型可见内容只有两类工具结果：拒绝说明和 `awaiting_approval`/执行结果，它们作为工具结果追加在末尾（`runtimeToolAuthorizationResult` 生成的 `modelContent`）。没有把时间、哈希、审批编号写进系统提示或工具定义。

但有两个限定：
- 如果登记表漏登记了原本会提供的工具，`offer` 会删掉它，工具集合变化会改变冻结前缀；本 PR 的 23 个都登记了，所以当前不变。精确哈希值我未独立核实。
- 第 1 条 `freeze` 问题会让重放在实际时钟下抛错，这不是前缀变化，但会破坏“只追加、每轮稳定”的预期行为。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**对模型可见文字：不会。** 新代码没有改提示词文字、遮盖规则或历史序列化；动作意图、审批、审计都只存在程序侧。事实代码经 `runtimePolicyFacts` 去重排序，`actionGateFacts` 再排序，同一组事实指纹稳定。

**但内部意图的“冻结”没有做到。** 意图里的 `requestedAt: now`、`expiresAt` 是时间相关的；代码本意是首轮冻结、后续读回，但 `freeze` 实际是“写后再读”，时间一变就冲突（第 1 条）。所以“同一调用重放得到同一意图”（作者说法 3）在当前实现下不成立，只是测试用了固定时钟。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有，且多数反向用例有效：**
- 工具定义快照：名字数组 + SHA256（`apps/agent-service/test/production-runtime-tools.unit.test.ts` 的 `[ADR-0257]` 用例）。定义或顺序变化会失败。
- 登记表过滤：缺 `reminder_set` 时名字列表必须少一个；未登记工具不提供。
- 事实代码：表外、重复、未排序都会被 `validateGovernedActionIntent` 拒绝；源码扫描的 `[ADR-0257]` 用例还有一个手工 `made_up_fact` 反向样本。
- 动作规则：例子里翻 `hit`、替换表达式、把结果值移到别的闸门，都会抛错。
- 拒绝不执行、ASK 不执行、关掉长期记录后改问主人：集成用例都有断言。
- 缺能力时以 `capability_not_registered` 拒绝：有直接调用 `authorize` 的用例。

**缺口：**
- 没有“时钟前进后重放同一调用”的用例；这正是第 1 条会失败的地方，固定时钟 `clock = { now: () => T1 }` 掩盖了它。
- 没有“规则修订号变化”的用例；当前代码行为还会与 ADR 冲突。
- 没有并发相同调用用例。
- 没有授权/状态存储抛错的用例，无法证明异常会变成受控失败。
- 哈希常量本身没有可复现的“从 main 计算”的检查，只能靠改动后测试失败来守。

### 4. 每个新值两端都能接受吗？

逐个核对结果：

- **工具名、能力名、操作名**：生产行与现有描述符常量一致（`reminder.set`、`rule.set`、`memory.recall`、`execution.task.*` 已核对）；`ToolActionRegistry` 启动时拒绝重复能力名；`offer` 按工具名、`#builtinRow` 按能力名，两端一致。
- **`action-rule:<规则编号>` 键**：产生于 `actionRuleAuthorizationKey`，写入 `policyAuthorization.key`；使用端 `assertApprovalPolicyCurrent` 和 `isPolicyAuthorizationCurrent` 都按 `key + ownerId + agentId` 读 `product_state_records`，比较 `revision` 和 `enabled === true`，两端一致。
- **`revision` / `ruleRevision`**：`ruleRevision` 只在 `#standingAuthorization` 内比较；审批里存的是状态记录修订号，数据库按同一修订号校验，能对上。**但修订号变化时的语义与 ADR 不一致（第 2 条）。**
- **事实代码**：`POLICY_FACT_CODES`、`POLICY_FACT_REGISTRY`、`RUN_SOURCE_FACT` 三者一致；现有 file-read/coding 生产路径写出的 `external_model_disclosure`、`external_provider_disclosure` 都已登记且排序，新增校验不会误拒（作者说法 6 成立）。
- **动作闸门字段与结果值**：`field-catalog` 的七个字段、`rule-book` 的三种结果、`action-rules` 的表达式/例子一致；`assertRuleExamples` 会检查。
- **内置能力清单**：`BUILT_IN_CAPABILITY_VERSION` 同时用于意图的 `capabilityVersion` 和内置清单的 `manifest.version`；`CapabilityAuthorizationFacts` 收窄为 `version/operations/health/scopes.dataClassifications`，唯一消费者 `ActionPolicyService` 正好只用这些字段，类型收窄安全。
- **登记表数值域**：`actionKind`、`sideEffect`、`disclosure`、`targetType` 没有运行时值域校验；`executor`/`authorization` 组合也没有交叉校验（第 5 条）。
- **`detail`、`resultOrigin`、`mayFollowExternalContent`、`deduplication`、`device`**：目前没有使用端（第 6 条）；如果 ADR 说它们已经生效，需要改成“后续步骤消费”或在本 PR 接上。

**总体判断**：在第 1 步“行为不变”的目标下，工具定义和现有读取/编码路径基本守住了；但审批回放的核心机制在当前实现下有实际失效风险，且测试没有覆盖真实时钟。建议至少先修第 1 条，再合并。
