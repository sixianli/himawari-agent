CLAIM|1|一致|apps/agent-service/src/production-file-read-services.ts:305|读文件、联网搜索先组一份“动作意图”，交给权限引擎（`ActionPolicyService`）|      await searchAuthorization.authorize(intent);
CLAIM|2|一致|apps/agent-service/src/production-coding-workflow.ts:408|写代码先组一份“动作意图”，交给权限引擎（`ActionPolicyService`）|  const permission = await services.authorize(intent, ctx.signal);
CLAIM|3|一致|apps/agent-service/src/production-runtime-tools.ts:1116-1118（cc510cc0）|提醒、规则、记忆检索、任务管理这几类后来加的内置工具各写了一个分支|    if (this.#isReminder(invocation)) return this.#reminder(invocation);
CLAIM|4|一致|apps/agent-service/src/production-runtime-tools.ts:1117（cc510cc0）|这些分支只查“这个工具这一轮给没给模型”，不经过权限引擎|    if (this.#isReminder(invocation)) return this.#reminder(invocation);
CLAIM|5|找不到|-|落地之前没有任何地方记“模型看得到的内容里有没有外来内容”|-
CLAIM|6|一致|packages/application/src/services/policy-fact-registry.ts:16|第 1 步只把这条事实的代码登记进事实代码表|  contextExternalContent: "context_external_content",
CLAIM|7|一致|apps/agent-service/src/owner-scope-authorization.ts:121|统一出口组事实时只放“谁发起的”|    const factCodes: PolicyFactCode[] = [RUN_SOURCE_FACT[source.sourceType]];
CLAIM|8|一致|apps/agent-service/src/owner-scope-authorization.ts:122-123|再加上登记表那一行带来的“要本人在场”和“改长期规则”|    if (row.ownerPresenceRequired) factCodes.push(POLICY_FACT_CODES.ownerPresenceRequired);
CLAIM|9|一致|.agents/plans/owner-scope-approval.md:1|本 ADR 把方案线程 2026-11-12 定稿的整合方案（仓库副本 .agents/plans/owner-scope-approval.md）记成决定|# 整合方案：有后果的工具调用走同一个出口（权限引擎加审批）
CLAIM|10|一致|apps/agent-service/src/production-runtime-tools.ts:774（cc510cc0）|这次改动之前，提醒、规则、记忆检索、任务管理这几类工具的事前检查只查“给没给这一轮”|        allowed: this.#exposed.has(invocation.runId) && this.#options.reminders !== undefined,
CLAIM|11|一致|apps/agent-service/src/production-runtime-tools.ts:768-792（cc510cc0）|各有一个原因码|        reasonCode: "REMINDER_OWNER_SCOPE",
CLAIM|12|一致|apps/agent-service/src/production-runtime-tools.ts:870-874|任务管理现在仍是这样|        reasonCode: "TASK_RESOURCE_AUTHORITY_REQUIRED",
CLAIM|13|一致|apps/agent-service/src/production-runtime-tools.ts:126-131|另外三类的原因码保留下来|  "owner-reminder": { prefix: "reminder", reasonCode: "REMINDER_OWNER_SCOPE" },
CLAIM|14|一致|apps/agent-service/src/production-runtime-tools.ts:1117（cc510cc0）|这次改动之前，它们执行时不组动作意图、不调权限引擎，直接交给各自的执行函数|    if (this.#isReminder(invocation)) return this.#reminder(invocation);
CLAIM|15|一致|apps/agent-service/src/production-runtime-tools.ts:1214-1218|这次改成先按登记表找到这一行，再把统一出口的检查一起交给执行函数|    const row = this.#builtinRow(invocation);
CLAIM|16|一致|apps/agent-service/src/production-coding-workflow.ts:408-411|受治理工具的统一写法已经有了|    const result = runtimeToolAuthorizationResult(permission);
CLAIM|17|一致|packages/application/src/services/runtime-tool-authorization.ts:3|等审批时运行挂起，所有受治理工具同一种做法|/** Every governed tool uses the same suspension contract; no model result on ASK. */
CLAIM|18|一致|apps/agent-service/src/production-file-read-services.ts:305-306|已有“主人事先同意的长期授权”这种做法|      await searchAuthorization.authorize(intent);
CLAIM|19|一致|apps/agent-service/src/owner-policy-authorization.ts:93-121|条件满足就替主人记一条已同意的审批和一次性授权|    kind: "one_time",
CLAIM|20|一致|packages/application/src/services/action-policy-service.ts:399-400|权限引擎只对“只读、低风险”直接放行|        (rule) => rule.effect === "ALLOW" && this.safePolicyRead(rule, intent),
CLAIM|21|一致|packages/application/src/services/action-policy-service.ts:488-507|其余没有授权就建待审批|        status: "pending",
CLAIM|22|一致|packages/application/src/services/action-policy-service.ts:41-42|新建或修改是中风险，删除是高风险|    CREATE_OR_UPDATE: "MEDIUM",
CLAIM|23|一致|packages/application/src/services/action-policy-service.ts:498|只有最高一档才要求近期身份验证|        recentAuthenticationRequired: intent.finalRisk === "CRITICAL",
CLAIM|24|一致|packages/application/src/services/action-policy-service.ts:529|权限引擎要求工具在能力登记里有清单|    if (!facts) return "capability_not_registered";
CLAIM|25|一致|packages/application/src/ports/authorization.ts:29-33|动作意图里已经有“确定的事实”这个位置，来源可以是运行时|  readonly source: "product" | "manifest" | "runtime";
CLAIM|26|一致|packages/application/src/ports/run-execution-source.ts:26|一轮运行是谁发起的有记录|  readonly sourceType: "user_message" | "schedule" | "external_event";
CLAIM|27|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2235-2236|工具结果已经能带一个标记并抬高这一轮的状态（数据分级）|      if (result.contentClassification)
CLAIM|28|一致|apps/agent-service/src/production-automatic-review.ts:71-73|已有自动复核端口，但它只看动作摘要，不看对话|  // Only the host's frozen summary reaches the reviewer: identity, versions,
CLAIM|29|一致|packages/application/src/rules/field-catalog.ts:9（cc510cc0）|这次改动之前规则手册只有邮件的两道闸门（`mail_item`、`mail_delivery`）|export const RULE_GATES = ["mail_item", "mail_delivery"] as const;
CLAIM|30|一致|packages/application/src/rules/field-catalog.ts:9|这次加了第三道 `action`|export const RULE_GATES = ["mail_item", "mail_delivery", "action"] as const;
CLAIM|31|一致|docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:104|动作闸门是规则手册计划中的第 3 步|第 3 步动作闸门
CLAIM|32|一致|docs/product-vision.md:58|愿景要求常规判断预先授权，不逐次确认|常规判断应由规则手册预先授权，不逐次确认
CLAIM|33|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:368|苹果端设计要求读过不可信内容后中风险动作等确认|本来按规则手册预先授权、不用问的中风险动作，这一轮改成要主人点一下确认
CLAIM|34|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:369|后台一律不做|一律不做，改存“建议”
CLAIM|35|一致|docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:58|主人明说“以后一律”的规则直接生效|主人明确说“以后 / 一律……”的，规则直接生效，同时给一张回执卡
CLAIM|36|一致|docs/adr/0204-handle-pi-deviations-d2-d3-d5.md:40-47|审批写在工具执行里、主人点头后回放，是已批准的做法|审批写在工具 execute 里、存快照后结束运行（D2），以及审批后在新会话里回放那次回答（D3） … D2、D3 批准保留。
CLAIM|37|一致|apps/agent-service/src/production-reminder-writer.ts:219-227|提醒工具建提醒时会写一条正式记忆|        decision: "create",
CLAIM|38|一致|apps/agent-service/src/production-owner-rules.ts:170|`rule_set` 的工具定义里，规则类型的可选值是从规则类型表生成的|            enum: [...types.filter(({ tests }) => tests).map(({ id }) => id), SOFT_TYPE],
CLAIM|39|一致|packages/application/src/services/automatic-action-review-contract.ts:26|现有自动复核只审主人事先列好的确切请求|    delegation.intentFingerprints.includes(request.intentFingerprint) &&
CLAIM|40|一致|packages/application/src/services/automatic-action-review.ts:98|最高一档和改权限的不审|    if (!current() || intent.finalRisk === "CRITICAL" || intent.credentialOrAccessChange)
CLAIM|41|一致|packages/application/src/services/action-intent-snapshot.ts:12|动作意图里数组的顺序会影响审批的内容指纹|/** JSON object key order is not semantic; array order remains part of the snapshot. */
CLAIM|42|一致|packages/application/src/services/action-policy-service.ts:59-68|风险取所有事实里最高的一档|  const facts = intent.deterministicFacts.map(({ minimumRisk }) => minimumRisk);
CLAIM|43|一致|packages/gateway-contracts/src/contracts-v2.ts:2257|审批快照的接口里已经带事实代码|      deterministicFactCodes: array(machineString),
CLAIM|44|一致|apps/control-center/src/run-approval.ts:92-108|网页上“一起同意”按动作种类把几张审批并成一组|export function approvalsDecidedTogether(
CLAIM|45|一致|packages/application/src/rules/field-catalog.ts:1|规则表达式的字段类型只有整数、文字、文字列表三种，没有真假|export type RuleFieldType = "int" | "string" | "list<string>";
CLAIM|46|一致|packages/application/src/rules/rule-book.ts:5-10（cc510cc0）|这次改动之前规则的结果值是五种，都和邮件、通知有关|  | "defer_to_quiet_hours";
CLAIM|47|一致|packages/application/src/rules/rule-book.ts:11-13|这次加了动作闸门用的三种|  | "allow_preauthorized"
CLAIM|48|一致|packages/application/src/services/scheduler-service.ts:193-196|定时任务可以绑定一个对话，触发时把这个对话编号带进这一轮|        sourceType: "schedule",
CLAIM|49|一致|packages/application/src/services/context-formation-service.ts:176-177|组上下文时按对话编号取历史摘要，不看这一轮是谁发起的|        ? await this.dependencies.threadSummaries.latestSummary(request.threadId)
CLAIM|50|一致|apps/agent-service/src/production-file-read-workflow.ts:303-304|现有的事实代码有 `external_model_disclosure`，最低风险档填“低”|        ? [{ code: "external_model_disclosure", minimumRisk: "LOW", source: "product" }]
CLAIM|51|一致|apps/agent-service/src/production-runtime-tools.ts:573-575|给一轮运行出工具的地方是一个函数，内置工具在末尾逐个追加|    if (this.#options.memoryRecall) descriptors.push(memoryRecallDescriptor());
CLAIM|52|一致|apps/agent-service/src/production-reminder-writer.ts:226|记忆记录有一个“出处”列表字段|          sourceRefs: [contentRef],
CLAIM|53|一致|packages/application/src/services/scheduler-service.ts:153|定时任务的调度入口是 async dispatchDue(input: DispatchDueInput): Promise<DispatchDueResult> {|  async dispatchDue(input: DispatchDueInput): Promise<DispatchDueResult> {
CLAIM|54|一致|apps/（grep 无匹配）|2026-11-12 在 apps/ 下搜这个名字没有搜到调用的地方|-
CLAIM|55|一致|packages/application/src/ports/authorization.ts:6-18|沿用现有 11 类|export const ACTION_KINDS = Object.freeze([
CLAIM|56|一致|packages/platform-node/src/typesafe-jev-transport.ts:35|现有通道在 packages/platform-node/src/typesafe-jev-transport.ts|export interface TypeSafeJevTransportOptions {
CLAIM|57|一致|apps/agent-service/src/production-runtime-tools.ts:668|统一出口出错时的诊断记录（键 `runtime-tool-diagnostic:` 开头）|          `runtime-tool-diagnostic:${digest([invocation.runId, invocation.toolCallId, "owner-scope", cause])}`,
CLAIM|58|一致|packages/persistence-sqlite/src/sqlite-run-diagnostics.ts:4|运维用的 `diagnose run` 命令能读到|const DIAGNOSTIC_OPERATION_KEYS = `(a.operation_key LIKE 'runtime-tool-diagnostic:%'
CLAIM|59|一致|packages/application/src/ports/decision-ledger.ts:32|类别和结果登记在 `DECISION_KINDS`、`DECISION_OUTCOMES`|export const DECISION_KINDS = [
CLAIM|60|一致|packages/persistence-sqlite/src/state-root-lock.ts:139-144|同一次工具调用同时进来两次时合并成一次，这只在同一个服务进程里有效，靠的是一个数据目录同时只让一个服务进程打开|        "The state root is already owned by a live process",
CLAIM|61|找不到|-|开任务本身一直走写代码那条路的权限引擎|-

未核实的部分：第 5 条“落地之前没有任何地方记外来内容”是对缺失的断言，无法从当前代码直接证明；第 61 条“开任务一直走写代码那条路的权限引擎”没找到足够证据。前提 20–22 讲的是外部网站，按要求未核对；标 cc510cc0 的行号来自该提交的 git show 版本。
