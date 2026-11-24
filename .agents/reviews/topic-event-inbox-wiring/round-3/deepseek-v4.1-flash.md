CLAIM|1|一致|packages/application/src/services/attention-policy-service.ts:120|`AttentionPolicyService` 用的是写死的阈值，和你“不许写死”的要求冲突。|if (candidate.urgency < 20 || candidate.confidence < 20) {
CLAIM|2|一致|docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:11|推送时机已经有 ADR 0273（你忙的时候延后）在管。|# ADR 0273：主人在忙时，由判断模型 Jev 决定先不推送
CLAIM|3|一致|docs/adr/0184-back-off-ignored-proactive-pushes.md:10|推送时机已经有 ADR 0184（被忽略就降频）在管。|# ADR 0184：同一类主动推送连续被忽略时自动降频
CLAIM|4|一致|apps/agent-service/src/production-think-composition.ts:211|入口、工人、运行已在 main。|return { inbox, worker, loop };
CLAIM|5|一致|docs/adr/0274-new-things-go-through-one-think-entrance.md:55|`docs/adr/0274-new-things-go-through-one-think-entrance.md:55`：“表 `think_inbox`……一行记一件来源请 Himawari 想一想的事”。|表 `think_inbox`（迁移 `20261115004401_think_inbox.sql`）一行记一件来源请 Himawari 想一想的事
CLAIM|6|一致|apps/agent-service/src/production-think-runner.ts:200|`apps/agent-service/src/production-think-runner.ts:200`：`triggerSource: "external_event",`。|triggerSource: "external_event",
CLAIM|7|一致|apps/agent-service/src/production-http-composition.ts:1881|`apps/agent-service/src/production-http-composition.ts:1881`：`think?.loop.start();`。|think?.loop.start();
CLAIM|8|一致|apps/agent-service/src/production-think-inbox.ts:103|入口表、判断、带只读工具的运行都已经在 main 上（前提 1）中的“入口表”。|export class ProductionThinkInbox {
CLAIM|9|一致|apps/agent-service/src/production-think-worker.ts:57|入口表、判断、带只读工具的运行都已经在 main 上（前提 1）中的“判断”。|export class ProductionThinkWorker {
CLAIM|10|一致|apps/agent-service/src/service-main.ts:1719-1722|入口表、判断、带只读工具的运行都已经在 main 上（前提 1）中的“带只读工具的运行”。|return source === undefined || isThinkRunSource(source);
CLAIM|11|一致|apps/agent-service/src/production-think-composition.ts:148|但没有任何来源往里写（前提 2）。|const inbox = new ProductionThinkInbox({
CLAIM|12|一致|docs/adr/0274-new-things-go-through-one-think-entrance.md:105|`docs/adr/0274-new-things-go-through-one-think-entrance.md:105`：“带工具的想一想运行、同意任务的写操作审批、来源接入和旧代码清理在后续 PR 里。”|带工具的想一想运行、同意任务的写操作审批、来源接入和旧代码清理在后续 PR 里。
CLAIM|13|一致|apps/agent-service/src/production-think-inbox.ts:134|入口的写入方法是 `apps/agent-service/src/production-think-inbox.ts:134` 的 `async submit(input: {`。|async submit(input: {
CLAIM|14|一致|apps/agent-service/src/production-think-composition.ts:148|在 `apps/agent-service/src` 的非测试文件里搜 `inbox.submit` 和 `sources.register` 没有结果（2026-11-16 执行）。|const inbox = new ProductionThinkInbox({
CLAIM|15|一致|apps/agent-service/src/production-think-inbox.ts:151|来源编号最长 256 个字符。|if (input.sourceRef.length < 1 || input.sourceRef.length > 256)
CLAIM|16|一致|apps/agent-service/src/production-think-inbox.ts:153|来源版本在入口最长 256。|if (input.sourceVersion.length > 256)
CLAIM|17|一致|apps/agent-service/src/production-think-actions.ts:23|来源版本到了提议那一层只留 128。|const SOURCE_VERSION_LENGTH = 128;
CLAIM|18|一致|apps/agent-service/src/production-think-inbox.ts:150|来源要先登记，没登记的拒收。|if (!source) return { accepted: false, reason: "THINK_SOURCE_UNREGISTERED" };
CLAIM|19|一致|apps/agent-service/src/production-think-actions.ts:58|想一想运行能提的动作只有三种，都进提议箱。|type: TASK_RUN_PROPOSAL_TYPE,
CLAIM|20|一致|apps/agent-service/src/production-think-actions.ts:75|`apps/agent-service/src/production-think-actions.ts:75`：`type: REMINDER_CREATE_PROPOSAL_TYPE,`。|type: REMINDER_CREATE_PROPOSAL_TYPE,
CLAIM|21|一致|apps/agent-service/src/production-think-actions.ts:95|`apps/agent-service/src/production-think-actions.ts:95`：`type: REMINDER_RESCHEDULE_PROPOSAL_TYPE,`。|type: REMINDER_RESCHEDULE_PROPOSAL_TYPE,
CLAIM|22|一致|apps/agent-service/src/production-think-runner.ts:263|没有“只告诉主人一句话”这种结局。|if (parsed.action === "none") return { outcome: "skipped", reasonCode: "nothing_to_propose" };
CLAIM|23|一致|apps/agent-service/src/production-reminder-writer.ts:86|`apps/agent-service/src/production-reminder-writer.ts:86`：`name: "reminder_set",`。|name: "reminder_set",
CLAIM|24|一致|apps/agent-service/src/production-web-push.ts:572|`apps/agent-service/src/production-web-push.ts:572`：`const due = await store.listDue({ ownerId, agentId, now, limit: batch });`。|const due = await store.listDue({ ownerId, agentId, now, limit: batch });
CLAIM|25|一致|packages/application/src/services/durable-background-work-service.ts:172|`packages/application/src/services/durable-background-work-service.ts:172`：`export function evaluateDurableSchedule(`。|export function evaluateDurableSchedule(
CLAIM|26|一致|packages/application/src/services/index.ts:27|在 `apps/` 下搜 `DurableBackgroundWorkService`、`UnifiedTriggerIngestionService` 没有结果（2026-11-16 执行）。|export * from "./durable-background-work-service.js";
CLAIM|27|一致|apps/agent-service/src/production-proactive.ts:317|`apps/agent-service/src/production-proactive.ts:317`：`this.#timer = setInterval(() => void this.tick(), this.#options.configuration.intervalMs);`。|this.#timer = setInterval(() => void this.tick(), this.#options.configuration.intervalMs);
CLAIM|28|一致|apps/agent-service/src/production-perception-extraction.ts:128|`apps/agent-service/src/production-perception-extraction.ts:128`：`this.#timer = setInterval(`。|this.#timer = setInterval(
CLAIM|29|一致|apps/agent-service/src/production-think-runner.ts:142|每件想一想的事开一个自己的对话。|threadId: `thread:think:${key}`,
CLAIM|30|一致|docs/adr/0277-the-system-deletes-expired-think-threads.md:11|想一想的事到期由系统删。|# ADR 0277：想一想对话到期由系统自动删除，不等主人确认
CLAIM|31|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:595|删之前会看有没有定时任务挂着。|AND NOT EXISTS (SELECT 1 FROM scheduled_jobs j WHERE j.thread_id = t.id
CLAIM|32|一致|apps/agent-service/src/production-think-runner.ts:196|`apps/agent-service/src/production-think-runner.ts:196`：`origin: "think",`。|origin: "think",
CLAIM|33|一致|packages/application/src/ports/configuration.ts:417|想一想的设置已经是一张定义表。|export const THINK_SETTING_DEFINITIONS = Object.freeze([
CLAIM|34|一致|apps/agent-service/src/production-think-settings.ts:228|手机设置页从它生成。|return THINK_SETTING_DEFINITIONS.map((definition) => {
CLAIM|35|一致|packages/application/src/ports/web-push.ts:5|推送种类只有三种。|export type WebPushKind = "reminder" | "approval" | "run";
CLAIM|36|一致|apps/agent-service/src/production-web-push.ts:461|提议的推送借用“提醒”这个种类。|kind: "reminder",
CLAIM|37|一致|apps/agent-service/src/production-web-push.ts:457|每轮只推最新一条。|for (const proposal of newest ? [newest] : [])
CLAIM|38|一致|apps/agent-service/src/production-home.ts:729-732|首页条目的来源是邮件、审批、记忆、运行四类。|...(options.proactive ? [mailSource(options.proactive)] : []),
CLAIM|39|一致|packages/application/src/ports/decision-ledger.ts:89|决策记录已经有“告诉了”这个结果值。|"told",
CLAIM|40|一致|docs/product-vision.md:64|愿景原则 8。|8. **可持续存在** — 它能在我不在时按既定规则推进有明确目标与停止条件的事情，并在完成后汇报；推进受成本、资源与时间预算约束，超限即停下等待。
CLAIM|41|一致|docs/product-vision.md:60|愿景原则 4。|4. **在边界内主动** — 等待指令是底线，预判需求是目标，但预判必须建立在已有记忆与明确偏好之上，且预判的收益必须大于打扰我的成本。
CLAIM|42|一致|AGENTS.md:43|发给模型的内容只追加，工具定义按对话冻结。|已经发出去的内容不得改动、重排或删除，只能在末尾追加；每轮会变的内容只放在最后一条消息里；系统提示和工具按对话冻结。
CLAIM|43|一致|apps/agent-service/src/production-think-actions.ts:37|想一想提的提议现在一律被标成“外部内容引出的”（`apps/agent-service/src/production-think-actions.ts:37`：`origin: "external_content" as const,`）。|origin: "external_content" as const,
CLAIM|44|一致|packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:188|入口对重复写入只回“以前见过”，不管那一条后来是不是失败或过期（`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:188`：`if (existing) return { outcome: "duplicate", entry: stored(existing) };`）。|if (existing) return { outcome: "duplicate", entry: stored(existing) };
CLAIM|45|一致|packages/application/src/services/durable-background-work-service.ts:204|它对过了宽限时间的一次性任务直接判错过（`packages/application/src/services/durable-background-work-service.ts:204`：`outcome: now - at <= schedule.misfireGraceMs ? "due" : "missed",`）。|outcome: now - at <= schedule.misfireGraceMs ? "due" : "missed",
CLAIM|46|一致|packages/application/src/services/web-push-gate.ts:40|现有的分类函数不认识的一律算“未知”（`packages/application/src/services/web-push-gate.ts:40`：`return "unknown";`）。|return "unknown";
CLAIM|47|一致|packages/application/src/services/web-push-gate.ts:78|未知类直接送，不过“你忙的时候延后”和降频（`:78`：`if (PUSH_RULE_PROTECTED_CLASSES.includes(input.pushClass)) return DELIVER;`）。|if (PUSH_RULE_PROTECTED_CLASSES.includes(input.pushClass)) return DELIVER;
CLAIM|48|一致|packages/persistence-sqlite/src/migrations/20261114151212_perception_records.sql:22|决策记录不借用提议的 `told`：那个值现在没有任何生产代码在写。|('proposal', 'told');
CLAIM|49|一致|packages/application/src/services/thread-prompt-bundle-service.ts:89|工具清单变了，老对话在下一轮开始时会按规则换新一次请求开头，那一轮缓存不命中，之后稳定（`packages/application/src/services/thread-prompt-bundle-service.ts:89`：`if (!sameNames(record.identity.toolNames, identity.toolNames)) return "tool_set_changed";`）。|if (!sameNames(record.identity.toolNames, identity.toolNames)) return "tool_set_changed";
CLAIM|50|一致|.agents/instructions/prompt-prefix.md:42|规则允许这种换新并要求留记录，见 `.agents/instructions/prompt-prefix.md` 第 6 条。|只有下面这些情况才换新一次，并且每次都留记录：工具集合变了
CLAIM|51|一致|apps/agent-service/src/production-background-runs.ts:140|`apps/agent-service/src` 里有 12 个文件各带一个 `setInterval`（2026-11-16 用 `grep -l setInterval` 数的）。|const interval = setInterval(() => {
CLAIM|52|一致|apps/agent-service/src/service-main.ts:3746|拆小 3746 行的启动文件 `apps/agent-service/src/service-main.ts`。|}
CLAIM|53|一致|docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:58|`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:58`：“主人明确说“以后 / 一律……”的，规则直接生效，同时给一张回执卡，上面有试算例子和一键撤销”。|主人明确说“以后 / 一律……”的，规则直接生效，同时给一张回执卡，上面有试算例子和一键撤销
CLAIM|54|一致|docs/adr/0272-owner-proposals-join-the-data-export-format-v4.md:33|进导出要按先例把导出格式升一版，旧文件整份拒绝（`docs/adr/0272-owner-proposals-join-the-data-export-format-v4.md`）。|v3 及更早的导出文件导入时整份拒绝
CLAIM|55|一致|docs/adr/0274-new-things-go-through-one-think-entrance.md:55|入口条目结束后摘要会删（ADR 0274 决定 1）。|给后面读的短摘要放在加密载荷里，条目一结束就删载荷
CLAIM|56|不一致|docs/architecture-v0.1.md:438|新设置每个键都要有三种语言的文案和单位，不然设置页保存会失败。|每一项都必须有，少一项编译不过
CLAIM|57|一致|apps/agent-service/src/production-think-inbox.ts:227|入口已有的去重、排队上限、每日上限照常生效。|queueLimit: limits.queueLimit,
CLAIM|58|一致|apps/agent-service/src/production-think-runner.ts:142|想一想每次都是新对话，不影响任何已有对话的开头。|threadId: `thread:think:${key}`,
CLAIM|59|一致|apps/agent-service/src/production-think-runner.ts:77|清单按动作名排序生成，同一版本内字节不变。|return [...this.#actions.values()].sort((a, b) => (a.type < b.type ? -1 : 1));
CLAIM|60|找不到|-|想一想的运行现在读不到邮件全文，不能替代前者。|-
CLAIM|61|找不到|-|她也没有任何办法在主人不在时自己回头看一件事（前提 5、6）。|-
CLAIM|62|找不到|-|现在真实来源只有邮件一个，接线最便宜。|-
CLAIM|63|找不到|-|记录在 `.agents/reviews/topic-event-inbox-wiring/round-1/`。|-
CLAIM|64|找不到|-|记录在 `.agents/reviews/topic-event-inbox-wiring/round-2/`。|-
CLAIM|65|找不到|-|“告诉”这种结果你 11-12 已同意（`/mnt/project-files/ambient-sensing/proposed-actions-plan.md:449`：“状态：Andy 2026-11-12 22:04（JST）已同意。”）。|-
CLAIM|66|一致|apps/agent-service/src/production-home.ts:729-732|前提 11 的首页来源里没有提议。|...(options.proactive ? [mailSource(options.proactive)] : []),

未能核对的部分：`.agents/reviews/topic-event-inbox-wiring/` 两个目录在当前仓库不存在，`/mnt/project-files/ambient-sensing/proposed-actions-plan.md` 因外部目录权限读不到；“只有邮件一个真实来源”“没有任何办法自己回头看”“想一想读不到邮件全文”这三条属否定性判断，没有找到能直接证明的单一代码位置。关于“12 个文件各带一个 setInterval”，实际有 12 个文件含 setInterval，但 `service-main.ts` 和 `production-real-eval.ts` 各有两处，因此按字面“各带一个”并非完全准确。
