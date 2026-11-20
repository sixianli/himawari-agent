## 结论

### 1. 高 · 并发/重放时 `OwnerIntentGate.confirm` 可能返回与持久记录相反的结果

- 文件:行: `apps/agent-service/src/owner-intent-gate.ts:107-112`、`apps/agent-service/src/owner-intent-gate.ts:188-214`、`apps/agent-service/src/owner-policy-authorization.ts:20-33`
- 问题: 同一个 `intentId` 的两个调用都先读到“无记录”，各自调用核对模型；后写者的 `commitStateAndEvents` 冲突后，`catch` 只要发现记录存在就吞掉错误，然后 `confirm` 仍返回**自己的** `result.confirmed`，没有回读持久记录。两次模型结果不同时，会出现“本次动作按 `true` 直接执行，持久记录却是 `false`”；重放时又会按 `false` 去问主人。审计记录也用本地的 `result.confirmed` 和本地 `checkedAt`，可能留下两条结论相反、或同 id 但字段不同的审计记录。
- 证据:

  ```ts
  // owner-intent-gate.ts:108-112
  const recorded = await state.readScopedState(...);
  if (recorded) return recorded.value["confirmed"] === true;
  const result = await this.#run(input);
  await this.#record(input, key, result);
  return result.confirmed;
  ```

  ```ts
  // owner-intent-gate.ts:203-214
  .catch(async (error: unknown) => {
    if (!(await state.readScopedState(configuration.ownerId, configuration.agentId, key)))
      throw error;
  });
  await appendAuditRecord(this.#options.audit, {
    id: `owner-intent:${digest([input.intent.id, result.confirmed])}`,
    ...
    occurredAt: checkedAt,
  });
  ```

  `appendAuditRecord` 在重复 id 时会逐字段比较（`owner-policy-authorization.ts:28-32`），两个并发调用若都返回 `true`，`occurredAt` 不同就会再次抛错，导致后一次调用在状态已写入后失败。
- 读代码证实: 上述逻辑确实存在；运行层是否会对同一个 `toolCallId` 做去重，我没有核实到，所以“并发”部分是逻辑上可发生、未核实上游保证不发生。重放路径本身没有测试。
- 推测/未核实: 日常单进程顺序执行时通常不会触发；崩溃恢复、重复派发、重试同时到达时才有风险。
- 建议: 把持久记录当成唯一权威：`#record` 返回最终持久记录（写入冲突时回读），`confirm` 用 `recorded.value["confirmed"]` 作为返回值；审计 id 固定为 `owner-intent:<intentId>`，`outcome`/`occurredAt` 取持久记录，这样重复审计也能被 `appendAuditRecord` 当成同一条。补“先写记录、再重放不调模型”“两个并发结果冲突”“写失败后回读”的自动用例。

### 2. 中 · 反向规则例子没有覆盖 `owner_presence_required`、`disclosure`、`recipient_count`、非 `CREATE_OR_UPDATE`，删掉一个安全条件不会被测试发现

- 文件:行: `packages/application/src/rules/action-rules.ts:15-16`、`packages/application/src/rules/action-rules.ts:177-230`、`packages/application/src/rules/action-rules.ts:122-163`、`packages/application/src/rules/rule-book.ts:465`
- 问题: 共享表达式把多项条件串在一起，但新规则和“先问”规则都没有下列字段的反向例子：`owner_presence_required`、`disclosure != "none"`、`recipient_count > 0`、`action_kind != "CREATE_OR_UPDATE"`。`assertRuleExamples` 只验证给出的例子，不验证每个条件是否真的在表达式里。如果以后误删 `!("owner_presence_required" in facts)` 或 `disclosure == "none"`，现有例子仍会全部通过。
- 证据:

  ```ts
  // action-rules.ts:15-16
  const OWNER_INTENT_CONFIRMED_EXPRESSION =
    'action_kind == "CREATE_OR_UPDATE" && risk == "MEDIUM" && reversible == 1 && disclosure == "none" && recipient_count == 0 && run_source == "user_message" && "context_external_content" in facts && "owner_intent_confirmed" in facts && !("owner_presence_required" in facts) && !("standing_rule_change" in facts)';
  ```

  新规则例子只覆盖：缺少 `owner_intent_confirmed`、`finalRisk: "HIGH"`、`reversible: false`、`standing_rule_change`、`schedule`、缺少 `context_external_content`（`action-rules.ts:177-230`）。
- 读代码证实: 这些例子确实没有覆盖上述四个字段；`ownerIntentEligible` 虽然也检查这些字段，但表达式自身的安全底线仍没有反向用例守着。
- 建议: 给新规则和共享表达式补反向例子（`owner_presence_required`、`disclosure: named_recipients`、`recipients: [...]`、`actionKind: DELETE/READ`），并考虑增加“表达式里每个 `in facts` / 比较条件都必须有正反例”的结构化检查。

### 3. 中 · 核对端口把原始工具参数交给第二个模型，未做遮盖和大小上限；“没有工具结果”只对 `ownerWords` 成立

- 文件:行: `apps/agent-service/src/owner-intent-gate.ts:134-145`、`packages/application/src/ports/owner-intent-check.ts:4-11`
- 问题: `parameters: input.invocation.arguments` 是模型生成的工具参数，可能抄入网页、任务输出、邮件正文或私人数据；`ownerWords` 也没有数量/长度上限。ADR 说“输入只有主人原话和动作的类别、参数，没有工具结果”，这只对 `ownerWords` 成立，对 `parameters` 不成立。第二批接上适配器后，这些内容会进入另一次模型调用，存在注入、隐私泄露和费用放大风险。
- 证据:

  ```ts
  // owner-intent-gate.ts:136-143
  {
    ownerWords: words,
    action: {
      tool: input.row.tool,
      capabilityRef: input.invocation.capabilityRef,
      operation: input.row.operation,
      parameters: input.invocation.arguments,
    },
  },
  ```

  端口定义（`owner-intent-check.ts:4-11`）没有遮盖、大小或字段白名单约束。
- 读代码证实: 本批没有把 `OwnerIntentGate` 接进 `service-main.ts`（`service-main.ts:1565-1586` 未传 `ownerIntent`），所以生产当前不会实际发这次调用；风险在第二批接线后生效。
- 推测/未核实: 生产 `ownerWords` 的实现不存在于本批，无法核对它是否真的只取主人消息、是否排除工具结果。
- 建议: 核对请求只传白名单字段或动作摘要/指纹，复用出口遮盖，并对 `ownerWords` 的数量、总字节数和单条长度设上限；把“外来内容不是指令”写进适配器契约和反向测试。

### 4. 中/低 · 原话校验只是子串匹配，引用被否定的片段也能通过

- 文件:行: `packages/application/src/services/owner-intent-answer.ts:56-60`
- 问题: `words.includes(quote)` 只证明 quote 是某条主人消息的子串。主人说“不要提醒我”，模型引用“提醒我”也会通过；它不校验引文是否在肯定语境、是否对应同一个动作。这满足“逐字出自主人消息”的字面要求，但不足以证明“主人明确要求做这件事”。
- 证据:

  ```ts
  const quote = answer.quote?.trim() ?? "";
  if (quote.length === 0 || quote.length > MAXIMUM_QUOTE_LENGTH)
    return { confirmed: false, reason: "quote_missing" };
  if (!ownerWords.some((words) => words.includes(quote)))
    return { confirmed: false, reason: "quote_not_from_owner" };
  ```

- 读代码证实: 是纯子串判断，没有词边界、否定语境或动作一致性检查。
- 建议: 至少要求引文匹配到词边界、设置最小长度，或让核对模型同时给出“引文对应的动作”并与当前动作比较；把“不要提醒我 + 引用提醒我”加入反向用例。

### 5. 低 · 已过期的意图仍会调用核对模型并写记录

- 文件:行: `apps/agent-service/src/owner-scope-authorization.ts:216-228`
- 问题: `ownerIntent.confirm` 在 `if (expiresAt <= now) return denied("intent_expired")` 之前调用。已经过期的意图会白白花一次模型调用，并留下 `owner-intent-check` 状态记录和审计记录。
- 证据:

  ```ts
  let proposed = build(factCodes);
  if (this.#options.ownerIntent && (await this.#options.ownerIntent.confirm({...})))
    proposed = build([...factCodes, POLICY_FACT_CODES.ownerIntentConfirmed]);
  if (expiresAt <= now) return denied("intent_expired");
  ```

- 读代码证实: 顺序确实如此。
- 建议: 把过期检查移到 `ownerIntent.confirm` 之前；或在 `confirm` 入口用 intent 的 `expiresAt` 再判一次。

### 6. 低 · 失败答案里的 `verdict`/`confidence` 未经过严格解析就写进状态

- 文件:行: `apps/agent-service/src/owner-intent-gate.ts:153-163`、`apps/agent-service/src/owner-intent-gate.ts:178-186`
- 问题: `judgeOwnerIntent` 返回非 confirmed 时，`answer` 直接取原始 raw 对象；`verdict` 是任意字符串、`confidence` 是任意数字都会写进状态记录，`verdict` 没有长度上限。虽然 `confirmed` 仍为 false、不影响放行，但把不可信的模型输出持久化了。
- 证据:

  ```ts
  const answer = outcome.confirmed
    ? outcome.answer
    : ((raw as { verdict?: string; confidence?: number; quote?: string } | null) ?? null);
  return {
    ...
    verdict: typeof answer?.verdict === "string" ? answer.verdict : null,
    confidence: typeof answer?.confidence === "number" ? answer.confidence : null,
    quote: outcome.confirmed ? outcome.answer.quote : null,
  };
  ```

- 读代码证实: 是选择性写入，`quote` 在失败时为 null，但 `verdict`/`confidence` 未做范围/长度校验。
- 建议: 非 confirmed 时只存 `reason`，或复用 `parseOwnerIntentAnswer` 的范围和长度规则。

---

**作者说法与代码对照**

- “ADR 0257 第 3 步第一批：默认关，没接进 service-main”：**属实**。`service-main.ts:1565-1586` 构造 `OwnerScopeAuthorization` 时没有传 `ownerIntent`；`OwnerIntentGate` 只在测试里构造。新内置规则确实进了生产规则表，但 `owner_intent_confirmed` 只由 gate 产生，而 gate 不接线，所以规则不会命中，授权结果不变；规则页会多一条可见的内置规则。
- “事实 `owner_intent_confirmed` 单独出现、其他条件不满足时不会落空”：**基本属实**。高风险、不可撤销、改长期规则、后台都会让 `!(OWNER_INTENT_CONFIRMED_EXPRESSION)` 为真，从而命中“先问”规则；没有外来内容时 `owner_intent_confirmed` 不可能出现（gate 只在 `externalSources.length > 0` 时加事实，`owner-scope-authorization.ts:170` 同时加 `context_external_content`）。理论上唯一会落空的组合是“有 `owner_intent_confirmed` 但没有 `context_external_content`”，生产不可达。即便落空，`decide` 的 `outcome` 是 `null`，会走 `#policy.evaluate`，默认变成 `ASK`（除非同一意图已有授权），不是静默放行。
- “只在合格条件下调用核对端口；超时、出错、拿不到原话、答案不合格都不放行”：**属实**。`ownerIntentEligible` 与表达式条件基本一一对应；`#run` 对 `ownerWords` 异常/为空、检查抛错、超时、`judgeOwnerIntent` 各拒绝原因都返回 `confirmed: false`。
- “结果存 `owner-intent-check:<意图编号>`，重放读记录不再调用”：**属实**，但并发写冲突时不回读，见意见 1。
- “输入里没有工具结果”：只对 `ownerWords` 字段成立；`parameters` 是原始工具参数，可能混入外来内容，见意见 3。生产 `ownerWords` 实现未接入，未核实。
- “引用的原话必须逐字出自主人消息”：**属实**，但只是子串判断，见意见 4。
- “核对放在冻结意图之前，通过则把事实加进意图再冻结”：**属实**（`owner-scope-authorization.ts:216-228`）。
- “不改发给模型的内容，没有迁移”：**属实**。这个 diff 没有改系统提示、工具定义、历史消息或遮盖；新状态键按需创建，不需要迁移。

---

**侧重检查**

- **错误路径**：`#run` 的 `ownerWords` 异常/空、检查抛错、超时、答案格式不对/不是 explicit/把握不足/无引文/引文不在主人消息，全部返回 `confirmed: false`，动作继续走“先问”，符合失败关闭。`#record` 的写失败在没有记录时会重新抛出，`authorize` 不吞错，整体失败关闭；但并发冲突时会把错误吞掉并返回本地结果，见意见 1。
- **不可信输入**：`parseOwnerIntentAnswer` 严格拒绝额外键、非整数/越界 confidence、非字符串 quote；这是好的。弱点是非 confirmed 的 `verdict`/`confidence` 仍会被持久化（意见 6），以及 quote 子串不校验语境（意见 4）。`parameters` 可能含注入/敏感文本（意见 3）。
- **安全、不可撤销操作**：`ownerIntentEligible` 和 `TOOL_ACTION_REGISTRY` 的 `reversible === (sideEffect !== "irreversible")` 校验（`tool-action-registry.ts:81`）一起保证：不可逆、高风险、改长期规则、后台、`managed-task`、需要本人在场、外发/有接收者的动作不会拿到 `owner_intent_confirmed`。本批没有发现绕过；但规则表达式本身的这些条件缺少反向例子（意见 2）。
- **资源耗尽**：`timeoutMs` 由配置限制在 500–30000；但 gate 不限制 `ownerWords` 数量/长度，适配器若忽略 `AbortSignal`，超时后底层模型调用仍可能继续；过期意图仍会触发调用（意见 5）；每个合格动作都会留下一条 `owner-intent-check` 状态记录，没有清理。
- **规则/说明文档/代码一致性**：ADR 的“默认关、未接线、事实只在合格条件下产生、先冻结前核对、重放不调模型、不改模型内容”均与代码一致；“写不进去也不影响结果”与代码一致，但这正是意见 1 的隐患；ADR 说记录里含“引用的原话”，实际只有 confirmed 时才存 quote。
- **I-73（新值的两端校验）**：`owner_intent_confirmed` 和 `action_preauthorize_owner_intent_confirmed` 都能通过 `machineString` 的 `^[A-Za-z0-9][A-Za-z0-9._:-]*$`（`packages/gateway-contracts/src/validation.ts:51-58`），所以 `approval.snapshot` 的 `deterministicFactCodes`、`memory.rules.snapshot` 的 `ruleId`、`memory.rule.respond` 的 `target` 都能接受。`modelRef` 走 `safeReference`，允许 `/`（`strict-configuration.ts:123-128`），不会重演 I-73 的斜杠拒绝。`rule-ids.frozen.json` 已加新 id，三语 i18n 已加分支。**未核实**：第二批的模型适配器、提示词目录、评测集不在本仓库/本批，无法核对 `modelRef` 和答案 confidence 单位在适配器端一致。

---

**必答问题**

1. **会不会改变模型已经见过的请求开头？**
   **不会。** 这个 diff 没有改系统提示、工具定义、历史消息、遮盖结果或消息组装代码。新产生的 `checkedAt`、答案、`externalSources` 只写进 `owner-intent-check` 状态和审计，不发给对话模型；新规则只影响授权判断。`OwnerIntentGate` 没有接进 `service-main`，`owner_intent_confirmed` 也没有其他产生处（grep 只在 gate、规则表、事实注册表和测试里出现），所以本批连动作结果都不会变。即便第二批接线，核对通过只会让动作直接执行，工具结果仍是追加在末尾；ADR 也明确没有把“内容取自哪份外来内容”加进工具结果。**每轮会变的值**（`checkedAt`、模型答案、外来来源）不在系统提示/工具定义里，属于状态记录，不违反“会变的值只在最后一条消息里”。
   依据：`.agents/instructions/prompt-prefix.md:27-36`（规则 1–5）。这个文件在稀疏检出里实际存在，我已读到。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   **对对话模型请求不会。** 本批没有新增任何发给对话模型的文字。对第二批判定模型的调用：gate 直接传 `ownerWords`（顺序由回调决定）和 `parameters`（对象原样），没有做键排序/规范化；如果适配器直接序列化，确实可能因对象键顺序或 `ownerWords` 顺序不同而产生不同字节。这属于第二批评测要解决的问题，本批代码没有保证。状态记录里的 `checkedAt` 是时间字段，`externalSources` 在 `owner-scope-authorization.ts:190` 已排序，`verdict/confidence/quote` 依赖模型结果；这些都不是对话请求内容，但如果以后有人把它们拼进模型请求，就违反“字节必须确定”和“会变的值放最后”。另外，并发写冲突会让同一意图得到不同结果，见意见 1。
   依据：`.agents/instructions/prompt-prefix.md:51`（规则 10）。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   **有，但不完整。** 已有的：`owner-intent-answer.unit.test.ts` 覆盖格式错误、extra key、confidence 越界、非 explicit、无引文、伪造引文；`startup-configuration.unit.test.ts` 覆盖配置范围和多余键；`policy-fact-registry.unit.test.ts` 覆盖规则例子，并用翻转例子/替换表达式验证 `assertRuleExamples` 会失败；`tool-action-registry.test.ts` 覆盖确认成功、not_explicit、unsure、低把握、伪造引文、无引文、格式错误、抛错、超时、无外来内容、改长期规则、定时任务、无主人原话、把新规则切到“先问”。
   **缺口**：没有“重放读记录不再调模型”的用例；没有并发/写失败用例；新规则和先问规则都没有 `owner_presence_required`、`disclosure != none`、`recipient_count > 0`、非 `CREATE_OR_UPDATE` 的反向例子，所以删掉这些安全条件时现有测试不会失败；`expect(JSON.stringify(request)).not.toContain("任务输出")`（`tool-action-registry.test.ts:1148`）只是检查测试自己注入的固定原话和参数，不能证明生产 `ownerWords` 不含工具结果。意见 1、2、3 的修复都需要补用例。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `owner_intent_confirmed`：生产处只有 `OwnerIntentGate`→`owner-scope-authorization` 的 `build`；使用处是 `action-rules.ts` 的共享表达式、`assertPolicyFactCodes`、审批快照的 `deterministicFactCodes: array(machineString)`。事实注册表已加、排序校验通过、`machineString` 接受下划线。控制中心对事实代码是原样显示（`governance-control-center.tsx:243-245`），没有用到 `POLICY_FACT_REGISTRY` 的三语 label；现有事实也一样，不算本批引入的新问题。
   - `action_preauthorize_owner_intent_confirmed`：已加进 `ACTION_RULE_IDS`、`BUILT_IN_ACTION_RULES`、`test/tooling/rule-ids.frozen.json`、三语 `rules.builtIn.name/when`；`action-rule-switches` 会把 `allow_preauthorized` 规则列出来并提供开关；网关 `memory.rules.snapshot.ruleId` 和 `memory.rule.respond.target` 都是 `machineString`，接受下划线；`BUILT_IN_ACTION_RULE_OUTCOMES` 已有 `allow_preauthorized`。两端能接受。
   - 配置键 `runPolicy.ownerIntentCheck.{enabled,minConfidence,timeoutMs,modelRef}`：`parseOwnerIntentCheck` 和 `rejectUnknown` 接受这组键，范围 500–1000 / 500–30000，`safeReference` 允许 `typesafe/jev`；测试覆盖。**但本批 `service-main` 不消费它**，运营上把它设成 `enabled: true` 不会产生任何行为，只能等第二批接线；ADR 已说明，属于可接受的阶段性状态，但建议在文档/启动日志里明确“本版本忽略”。
   - 状态键 `owner-intent-check:<intentId>`：长度约 95 字符，符合 `product_state_records.key TEXT`，`readScopedState`/`commitStateAndEvents` 按 owner/agent/key 读写；没有别的产生处或消费处。`commandType: "authorization.owner_intent.checked"` 和审计 action 都是自由字符串，持久层没有枚举限制。
   - 审计 id `owner-intent:<digest([intentId, confirmed])>`：审计账本按 id 去重；并发同结果时 `occurredAt` 不同会触发重复比较失败，见意见 1。
   结论：除意见 1 的并发问题外，新值在它现有的使用端都能被接受；未核实的是第二批判定适配器对 `modelRef`、`parameters` 和 confidence 单位的处理。
