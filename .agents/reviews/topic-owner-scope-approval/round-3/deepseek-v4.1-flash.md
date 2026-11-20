CLAIM|1|一致|apps/agent-service/src/production-runtime-tools.ts:774|提醒、规则、记忆检索、任务管理这几类工具只查“给没给这一轮”|allowed: this.#exposed.has(invocation.runId) && this.#options.reminders !== undefined,
CLAIM|2|一致|apps/agent-service/src/production-runtime-tools.ts:1117|它们执行时不组动作意图、不调权限引擎|if (this.#isReminder(invocation)) return this.#reminder(invocation);
CLAIM|3|一致|apps/agent-service/src/production-coding-workflow.ts:408|受治理工具的统一写法已经有了|const permission = await services.authorize(intent, ctx.signal);
CLAIM|4|一致|packages/application/src/services/runtime-tool-authorization.ts:3|等审批时运行挂起，所有受治理工具同一种做法|/** Every governed tool uses the same suspension contract; no model result on ASK. */
CLAIM|5|一致|apps/agent-service/src/owner-policy-authorization.ts:120|已有“主人事先同意的长期授权”这种做法：条件满足就替主人记一条已同意的审批和一次性授权|response: { decision: "approved", grant, recentAuthenticationRef: null },
CLAIM|6|一致|apps/agent-service/src/production-file-read-services.ts:305-307|production-file-read-services.ts:303-306：await searchAuthorization.authorize(intent); await options.workspaceAuto?.authorize(intent); return policy.evaluate(intent, …)|await searchAuthorization.authorize(intent); await options.workspaceAuto?.authorize(intent); return policy.evaluate(intent, {
CLAIM|7|一致|packages/application/src/services/action-policy-service.ts:559-561|权限引擎只对“只读、低风险”直接放行，其余没有授权就建待审批|intent.actionKind === "READ" && intent.finalRisk === "LOW" && intent.sideEffect === "none" &&
CLAIM|8|一致|packages/application/src/services/action-policy-service.ts:40|新建或修改是中风险|CREATE_OR_UPDATE: "MEDIUM",
CLAIM|9|一致|packages/application/src/services/action-policy-service.ts:41|删除是高风险|DELETE: "HIGH",
CLAIM|10|一致|packages/application/src/services/action-policy-service.ts:503|只有最高一档才要求近期身份验证|recentAuthenticationRequired: intent.finalRisk === "CRITICAL",
CLAIM|11|一致|packages/application/src/services/action-policy-service.ts:535|权限引擎要求工具在能力登记里有清单|if (!facts) return "capability_not_registered";
CLAIM|12|一致|apps/agent-service/src/production-runtime-tools.ts:562-563|内置的提醒、规则工具没有清单|if (this.#options.reminders) descriptors.push(...reminderToolDescriptors()); if (this.#options.ownerRules) descriptors.push(...ownerRuleToolDescriptors());
CLAIM|13|一致|packages/application/src/ports/authorization.ts:32|动作意图里已经有“确定的事实”这个位置，来源可以是运行时|readonly source: "product" | "manifest" | "runtime";
CLAIM|14|一致|packages/application/src/ports/run-execution-source.ts:26|一轮运行是谁发起的有记录|readonly sourceType: "user_message" | "schedule" | "external_event";
CLAIM|15|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2236|工具结果已经能带一个标记并抬高这一轮的状态（数据分级）|this.#raiseVisible(request.runId, result.contentClassification, request.dataClassification);
CLAIM|16|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2235|没有“来源可不可信”的同类标记|if (result.contentClassification)
CLAIM|17|一致|apps/agent-service/src/production-automatic-review.ts:71-73|已有自动复核端口，但它只看动作摘要，不看主人说了什么，也不看参数|// Only the host's frozen summary reaches the reviewer: identity, versions, // operation, target kinds and the request digest. No file contents, local // paths, credentials or conversation text are disclosed.
CLAIM|18|一致|packages/application/src/rules/field-catalog.ts:9|规则手册现在只有邮件的两道闸门|export const RULE_GATES = ["mail_item", "mail_delivery"] as const;
CLAIM|19|一致|docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:104|动作闸门是计划中的第 3 步|第 3 步动作闸门
CLAIM|20|一致|docs/product-vision.md:58|愿景要求常规判断预先授权，不逐次确认|常规判断应由规则手册预先授权，不逐次确认；每日需要我介入的次数与时间有上限
CLAIM|21|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:364|程序给每一轮运行记一个标记“这一轮读过“其他”来源的感知内容”，在所有会产生后果的工具入口……检查它|所以程序给每一轮运行记一个标记“这一轮读过‘其他’来源的感知内容”，在所有会产生后果的工具入口（`device_action` 里除读取以外的动作、建提醒、改规则、记忆转正）检查它：
CLAIM|22|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:368|本来按规则手册预先授权、不用问的中风险动作，这一轮改成要主人点一下确认|本来按规则手册预先授权、不用问的中风险动作，这一轮改成要主人点一下确认；高风险的本来就要确认
CLAIM|23|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:369|后台……一律不做，改存‘建议’|一律不做，改存“建议”
CLAIM|24|不一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:516|同文档 516 行“动作登记表（代码里的常量）”|`perception_read` 的结果和别的工具结果一样过统一出口，带着每条记录的数据分级，沿用现有的分级和路由规则（见[发给模型的路径](#egress)），不另设一套。
CLAIM|25|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:495|同文档 495 行“每个动作单独写一项‘要不要主人本人在场’”|[动作登记表](#actions)里每个动作单独写一项“要不要主人本人在场”。
CLAIM|26|一致|docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:58|主人明说“以后一律”的规则直接生效|主人明确说“以后 / 一律……”的，规则直接生效，同时给一张回执卡
CLAIM|27|一致|docs/adr/0204-handle-pi-deviations-d2-d3-d5.md:47|审批写在工具执行里、主人点头后回放，是已批准的做法|D2、D3 批准保留。
CLAIM|28|一致|apps/agent-service/src/production-reminder-writer.ts:219-227|提醒工具建提醒时会写一条正式记忆|decision: "create",
CLAIM|29|一致|apps/agent-service/src/production-owner-rules.ts:170|rule_set 的工具定义里，规则类型的可选值是从规则类型表生成的|enum: [...types.filter(({ tests }) => tests).map(({ id }) => id), SOFT_TYPE],
CLAIM|30|一致|packages/application/src/services/automatic-action-review-contract.ts:26|现有自动复核只审主人事先列好的确切请求|delegation.intentFingerprints.includes(request.intentFingerprint) &&
CLAIM|31|一致|packages/application/src/services/automatic-action-review.ts:98|最高一档和改权限的不审|if (!current() || intent.finalRisk === "CRITICAL" || intent.credentialOrAccessChange)
CLAIM|32|一致|packages/application/src/services/action-intent-snapshot.ts:12|动作意图里数组的顺序会影响审批的内容指纹|/** JSON object key order is not semantic; array order remains part of the snapshot. */
CLAIM|33|一致|packages/application/src/services/action-policy-service.ts:59|风险取所有事实里最高的一档|const facts = intent.deterministicFacts.map(({ minimumRisk }) => minimumRisk);
CLAIM|34|一致|packages/gateway-contracts/src/contracts-v2.ts:2257|审批快照的接口里已经带事实代码|deterministicFactCodes: array(machineString),
CLAIM|35|一致|apps/control-center/src/run-approval.ts:92|网页上“一起同意”按动作种类把几张审批并成一组|export function approvalsDecidedTogether(
CLAIM|36|一致|apps/agent-service/src/production-file-read-services.ts:307|读文件走权限引擎|return policy.evaluate(intent, {
CLAIM|37|一致|apps/agent-service/src/production-coding-workflow.ts:408|写代码、联网搜索走权限引擎|const permission = await services.authorize(intent, ctx.signal);
CLAIM|38|一致|apps/agent-service/src/production-runtime-tools.ts:761-794|提醒、规则、记忆检索、任务管理这些后来加的内置工具各写了一个分支，只查“这个工具这一轮给没给模型”|if (this.#isReminder(invocation)) {
CLAIM|39|一致|apps/agent-service/src/production-runtime-tools.ts:761-794|preflight 里按工具写的四个分支|if (this.#isTaskManagement(invocation)) {
CLAIM|40|一致|apps/agent-service/src/production-file-read-services.ts:306|在主人已授权的工作目录里读写文件、跑命令 不变，仍按现有的工作目录授权|await options.workspaceAuto?.authorize(intent);
CLAIM|41|找不到|-|现在没有现成的端口能接|-
CLAIM|42|一致|packages/application/src/ports/proactivity.ts:14|现有的建议服务是“建议变任务”那一种|readonly trigger: "owner_approved_suggestion";
CLAIM|43|找不到|-|卡片上的可读标题、正文预览、“为什么问你”、来源这四项，main 上还没有|-
CLAIM|44|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:171|现有的 check:prompt-prefix 用的是测试自己写的假工具表|class SearchTools implements RuntimeToolPort {
CLAIM|45|找不到|-|第 5 批现在的临时做法（“不做、说明原因、主人再说一次”）|-
CLAIM|46|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:657|device_action、perception_read 这两个新工具会让老对话的请求开头重算一次，这是苹果端设计里已经写明的|加两个新工具，会让每个老对话重建一次请求开头；新加的固定提示词文字会进“自己写的固定文字”清单，可能让老对话的遮盖结果变一次。

外部网站和第三方产品相关的说法（P20–P23、P29 等）按要求没有核对；第 41、43、45 条（是否有现成提议端口、审批卡四项字段是否缺失、第 5 批临时做法）没有在仓库里读到足以判定的原文或代码。
