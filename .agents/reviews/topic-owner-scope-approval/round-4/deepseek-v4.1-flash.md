CLAIM|1|一致|apps/agent-service/src/production-runtime-tools.ts:130|这次改动之前，提醒、规则、记忆检索、任务管理这几类工具的事前检查只查“给没给这一轮”，各有一个原因码；任务管理现在仍是这样，另外三类的原因码保留下来|"owner-reminder": { prefix: "reminder", reasonCode: "REMINDER_OWNER_SCOPE" },
CLAIM|2|一致|apps/agent-service/src/production-runtime-tools.ts:1218|这次改动之前，它们执行时不组动作意图、不调权限引擎，直接交给各自的执行函数；这次改成先按登记表找到这一行，再把统一出口的检查一起交给执行函数|return run(invocation, this.#ownerScopeGate(invocation, row, signal));
CLAIM|3|一致|apps/agent-service/src/production-coding-workflow.ts:408|受治理工具的统一写法已经有了|const permission = await services.authorize(intent, ctx.signal);
CLAIM|4|一致|packages/application/src/services/runtime-tool-authorization.ts:3|等审批时运行挂起，所有受治理工具同一种做法|/** Every governed tool uses the same suspension contract; no model result on ASK. */
CLAIM|5|一致|apps/agent-service/src/owner-policy-authorization.ts:93|已有“主人事先同意的长期授权”这种做法：条件满足就替主人记一条已同意的审批和一次性授权|const grant = new GrantService({ store, clock, ids }).create({
CLAIM|6|一致|packages/application/src/services/action-policy-service.ts:400|权限引擎只对“只读、低风险”直接放行，其余没有授权就建待审批|(rule) => rule.effect === "ALLOW" && this.safePolicyRead(rule, intent),
CLAIM|7|一致|packages/application/src/services/action-policy-service.ts:41|新建或修改是中风险，删除是高风险|CREATE_OR_UPDATE: "MEDIUM",
CLAIM|8|一致|packages/application/src/services/action-policy-service.ts:498|只有最高一档才要求近期身份验证|recentAuthenticationRequired: intent.finalRisk === "CRITICAL",
CLAIM|9|一致|packages/application/src/services/action-policy-service.ts:529|权限引擎要求工具在能力登记里有清单|if (!facts) return "capability_not_registered";
CLAIM|10|一致|packages/application/src/ports/authorization.ts:32|动作意图里已经有“确定的事实”这个位置，来源可以是运行时|readonly source: "product" | "manifest" | "runtime";
CLAIM|11|一致|packages/application/src/ports/run-execution-source.ts:26|一轮运行是谁发起的有记录|readonly sourceType: "user_message" | "schedule" | "external_event";
CLAIM|12|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2235|工具结果已经能带一个标记并抬高这一轮的状态（数据分级）|if (result.contentClassification)
CLAIM|13|一致|apps/agent-service/src/production-automatic-review.ts:71|已有自动复核端口，但它只看动作摘要，不看对话|// Only the host's frozen summary reaches the reviewer: identity, versions,
CLAIM|14|一致|packages/application/src/rules/field-catalog.ts:9|这次改动之前规则手册只有邮件的两道闸门（mail_item、mail_delivery）；这次加了第三道 action|export const RULE_GATES = ["mail_item", "mail_delivery", "action"] as const;
CLAIM|15|一致|docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:104|动作闸门是规则手册计划中的第 3 步|第 3 步动作闸门
CLAIM|16|一致|docs/product-vision.md:58|愿景要求常规判断预先授权，不逐次确认|常规判断应由规则手册预先授权，不逐次确认
CLAIM|17|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:368|苹果端设计要求读过不可信内容后中风险动作等确认，后台一律不做|本来按规则手册预先授权、不用问的中风险动作，这一轮改成要主人点一下确认；一律不做，改存“建议”
CLAIM|18|一致|docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:58|主人明说“以后一律”的规则直接生效|主人明确说“以后 / 一律……”的，规则直接生效，同时给一张回执卡
CLAIM|19|一致|docs/adr/0204-handle-pi-deviations-d2-d3-d5.md:47|审批写在工具执行里、主人点头后回放，是已批准的做法|D2、D3 批准保留。
CLAIM|20|一致|apps/agent-service/src/production-reminder-writer.ts:219|提醒工具建提醒时会写一条正式记忆|decision: "create",
CLAIM|21|一致|apps/agent-service/src/production-owner-rules.ts:170|`rule_set` 的工具定义里，规则类型的可选值是从规则类型表生成的|enum: [...types.filter(({ tests }) => tests).map(({ id }) => id), SOFT_TYPE],
CLAIM|22|一致|packages/application/src/services/automatic-action-review-contract.ts:26；packages/application/src/services/automatic-action-review.ts:98|现有自动复核只审主人事先列好的确切请求，最高一档和改权限的不审|delegation.intentFingerprints.includes(request.intentFingerprint) &&；if (!current() || intent.finalRisk === "CRITICAL" || intent.credentialOrAccessChange)
CLAIM|23|一致|packages/application/src/services/action-intent-snapshot.ts:12|动作意图里数组的顺序会影响审批的内容指纹|/** JSON object key order is not semantic; array order remains part of the snapshot. */
CLAIM|24|一致|packages/application/src/services/action-policy-service.ts:64|风险取所有事实里最高的一档|return highestRisk([
CLAIM|25|一致|packages/gateway-contracts/src/contracts-v2.ts:2257|审批快照的接口里已经带事实代码|deterministicFactCodes: array(machineString),
CLAIM|26|一致|apps/control-center/src/run-approval.ts:92|网页上“一起同意”按动作种类把几张审批并成一组|export function approvalsDecidedTogether(
CLAIM|27|一致|packages/application/src/rules/field-catalog.ts:1|规则表达式的字段类型只有整数、文字、文字列表三种，没有真假|export type RuleFieldType = "int" | "string" | "list<string>";
CLAIM|28|一致|packages/application/src/rules/rule-book.ts:6|这次改动之前规则的结果值是五种，都和邮件、通知有关；这次加了动作闸门用的三种|| "raise_floor"；| "allow_preauthorized"
CLAIM|29|一致|packages/application/src/services/scheduler-service.ts:196|定时任务可以绑定一个对话，触发时把这个对话编号带进这一轮|threadId: job.threadId,
CLAIM|30|一致|packages/application/src/services/context-formation-service.ts:176|组上下文时按对话编号取历史摘要，不看这一轮是谁发起的|request.threadId && this.dependencies.threadSummaries
CLAIM|31|一致|apps/agent-service/src/production-file-read-workflow.ts:304|现有的事实代码有 `external_model_disclosure`，最低风险档填“低”? [{ code: "external_model_disclosure", minimumRisk: "LOW", source: "product" }]
CLAIM|32|一致|apps/agent-service/src/production-runtime-tools.ts:573-575|给一轮运行出工具的地方是一个函数，内置工具在末尾逐个追加|if (this.#options.memoryRecall) descriptors.push(memoryRecallDescriptor());
CLAIM|33|一致|apps/agent-service/src/production-reminder-writer.ts:226|记忆记录有一个“出处”列表字段|sourceRefs: [contentRef],
CLAIM|34|找不到|-|现在没有任何地方记“模型看得到的内容里有没有外来内容”。|-
CLAIM|35|找不到|-|在 `apps/` 下没有搜到调用 `dispatchDue` 的地方，也就是说生产里现在还没有接上定时任务的调度。|-
CLAIM|36|一致|packages/application/src/services/action-policy-service.ts:38|这次调用算哪类动作（沿用现有 11 类）|export const ACTION_KIND_RISK_BASELINE: Readonly<Record<ActionKind, ActionRiskLevel>> =
CLAIM|37|一致|packages/application/src/services/action-policy-service.ts:45|不把改规则登记成“改权限”那一类：那一类是最高档|CREDENTIAL_OR_ACCESS: "CRITICAL",
CLAIM|38|一致|packages/platform-node/src/typesafe-jev-transport.ts:35|现有通道在 `packages/platform-node/src/typesafe-jev-transport.ts`|export interface TypeSafeJevTransportOptions {
CLAIM|39|一致|apps/agent-service/src/production-runtime-tools.ts:668|沿用现有工具诊断记录的键前缀|`runtime-tool-diagnostic:${digest([invocation.runId, invocation.toolCallId, "owner-scope", cause])}`,
CLAIM|40|一致|packages/application/src/ports/decision-ledger.ts:32；packages/application/src/ports/decision-ledger.ts:46|类别和结果登记在 `DECISION_KINDS`、`DECISION_OUTCOMES`|export const DECISION_KINDS = [；export const DECISION_OUTCOMES = {
CLAIM|41|一致|apps/agent-service/src/production-sandbox-services.ts:2339；apps/agent-service/src/production-runtime-tools.ts:874|取消仍由现有的检查把关，即只能管这一轮自己开出来的任务（原因码 `TASK_RESOURCE_AUTHORITY_REQUIRED`）|runId: call.runId,；reasonCode: "TASK_RESOURCE_AUTHORITY_REQUIRED",
CLAIM|42|找不到|-|另一个还没合并的分支给闸门清单加了通知闸门，两边合并时这一行要手工合。|-
CLAIM|43|一致|packages/application/src/rules/rule-book.ts:33；apps/agent-service/src/production-reminder-writer.ts:226|记录上的来源标记打算放进记忆记录已有的出处列表（前提 36）和规则已有的出处字段|readonly source: string;；sourceRefs: [contentRef],

未能核对的：前提 20–22 属于外部网站/第三方产品，按要求未核对；`apps/` 下无 `dispatchDue` 调用与“没有任何地方记录外来内容”属否定性说法，未读到可直接引用的正向代码；另一未合并分支的通知闸门无法在本检出中核实。
