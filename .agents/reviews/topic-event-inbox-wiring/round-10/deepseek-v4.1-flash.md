CLAIM|1|一致|packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:1|收件箱表 `think_inbox` 已建|CREATE TABLE think_inbox (
CLAIM|2|一致|apps/agent-service/src/production-think-composition.ts:148|但除了测试没有来源往里写|const inbox = new ProductionThinkInbox({
CLAIM|3|一致|packages/application/src/services/thread-command-service.ts:212|Andy 的每条消息各自建一次运行|const runId = input.runId ?? createRunId(`run:${identity}`);
CLAIM|4|一致|packages/application/src/services/proactive-mail-check-service.ts:1275|邮件有一个只看一小块信息的小判断或固定公式|mustNotify || dueSoon || (final.result === "check" && (floor || threadUnread));
CLAIM|5|一致|packages/application/src/services/perception-source-prompts.ts:42|手机感知有一个只看一小块信息的小判断或固定公式|export function buildPerceptionSourceCheckPrompt(input: {
CLAIM|6|一致|packages/prompt-catalog/src/perception.ts:597|推送延后有一个只看一小块信息的小判断或固定公式|purpose: "推送到期、发出之前，问判断模型主人此刻的状态是不是不适合被打扰；回答是“不适合”的概率",
CLAIM|7|一致|packages/prompt-catalog/src/review.ts:74|首页排序有一个只看一小块信息的小判断或固定公式|"首页上等主人拿主意的事新出现时，让模型给每件事打一个 0 到 1000 的要紧度；审批另写一句话和同意按钮上的字，按 JSON 返回",
CLAIM|8|一致|packages/prompt-catalog/src/perception.ts:587|语音“是不是在叫她”有一个只看一小块信息的小判断或固定公式|"手机认出名字的口头指令提交对话前，问判断模型这句话是不是在对 Himawari 说、要它现在做事；回答是“是”的概率",
CLAIM|9|一致|packages/application/src/services/voice-command.ts:72|认声音那道保留|return passes(gates.ambientCommand, evidence.speakerScore)
CLAIM|10|一致|apps/agent-service/src/production-task-proposals.ts:111|Andy 同意过的“去办一件事”会新开一个对话|threadId: `thread:proposal:${key}` as ThreadId,
CLAIM|11|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:1437|新开出来的对话散在对话列表里|const conditions = ["owner_id = ?", "agent_id = ?", "origin = 'owner'", lifecycle];
CLAIM|12|一致|packages/application/src/rules/action-rules.ts:51|权限按运行来源判断|run_source: runSource,
CLAIM|13|一致|packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:204|think_inbox 有供每天计数的列|"SELECT COUNT(*) AS count FROM think_inbox WHERE owner_id = ? AND agent_id = ? AND day = ?",
CLAIM|14|一致|packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:22|think_inbox_declined 表已建|CREATE TABLE think_inbox_declined (
CLAIM|15|一致|packages/application/src/services/perception-source-prompts.ts:14|感知分五个来源检查|export const PERCEPTION_SOURCE_KINDS = [
CLAIM|16|一致|packages/application/src/services/proactive-source-runtime.ts:19|感知有每次、每天条数上限|export type ProactiveSourceLimitKind = "per_check" | "per_day";
CLAIM|17|一致|docs/adr/0255-model-scores-urgency-of-home-items.md:11|首页要紧度打分（ADR 0255）|# ADR 0255：首页上等主人定的事由模型打要紧度并存住，审批另由模型写一句话和同意按钮上的字
CLAIM|18|一致|docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:11|推送延后判断（ADR 0273）|# ADR 0273：主人在忙时，由判断模型 Jev 决定先不推送
CLAIM|19|一致|docs/adr/0184-back-off-ignored-proactive-pushes.md:10|自动降频（ADR 0184）|# ADR 0184：同一类主动推送连续被忽略时自动降频
CLAIM|20|一致|docs/adr/0274-new-things-go-through-one-think-entrance.md:11|“值不值得想”（ADR 0274）|# ADR 0274：新知道的事都走同一个“想一想”入口，先问值不值得，再带工具想
CLAIM|21|一致|docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md:11|语音“是不是在叫她”（ADR 0264）|# ADR 0264：手机认出名字后，由判断模型 Jev 决定这句话是不是在叫 Himawari
CLAIM|22|一致|apps/agent-service/src/production-web-push.ts:917|Andy 的消息叫起的运行跑完不再推“已完成”|: WEB_PUSH_TEXT[locale].completed,
CLAIM|23|一致|docs/adr/0244-hard-rules-step4-unified-push-gate.md:53|安静时段规则（ADR 0244）|4. **新增主人规则类型 `push_quiet_hours`**：参数是时段（`periods`，每段有星期、开始、结束，可跨零点）和适用类别（`classes`）。
CLAIM|24|不一致|packages/application/src/rules/action-rules.ts:249|读过外来内容后的写操作对所有运行都从“拒绝”改成“问”|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts && !("run_source_owner_approved_task" in facts)',
CLAIM|25|找不到|-|替换 Andy 11-24 早先定的“她自己想到的只能查”|未找到对应文档（当前与基线提交）
CLAIM|26|一致|.agents/instructions/prompt-prefix.md:36|清理是“发给模型的内容只追加”规则事先留出的例外|以及将来按 ADR 实施的第 14 条清理
CLAIM|27|一致|docs/product-vision.md:64|合愿景原则 8|推进受成本、资源与时间预算约束，超限即停下等待。
CLAIM|28|一致|docs/adr/0184-back-off-ignored-proactive-pushes.md:6|被取代：ADR 0184|superseded_by: "docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md"
CLAIM|29|一致|docs/adr/0255-model-scores-urgency-of-home-items.md:7|被取代：ADR 0255|superseded_by: "docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md"
CLAIM|30|一致|docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md:6|被取代：ADR 0264|superseded_by: "docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md"
CLAIM|31|一致|docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:6|被取代：ADR 0273|superseded_by: "docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md"
CLAIM|32|一致|docs/adr/0274-new-things-go-through-one-think-entrance.md:6|被取代：ADR 0274|superseded_by: "docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md"
CLAIM|33|一致|docs/adr/0277-the-system-deletes-expired-think-threads.md:6|被取代：ADR 0277|superseded_by: "docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md"
CLAIM|34|一致|docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:6|被取代：ADR 0278|superseded_by: "docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md"
CLAIM|35|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:109|ADR 0230 的感知分来源检查|7. **系统主动提醒改成来源登记。** 每个来源登记自己的提示词、解析器、去重键、预算、开关和评测集；写死 Gmail 的地方（前提 8）全部改掉，并立一道检查：每个登记的来源都要能通过表约束、导出导入校验和类型。
CLAIM|36|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:113|ADR 0230 的条数上限|- 每个上限显示四样：上限是多少、现在用了多少、什么时候清零、到了会怎样。涵盖每种感官每天的时长和条数、感知触发的模型费、手机上的待传队列、耗电。快到时先提醒，到了就把停掉的那一部分标明“今天已停”。
CLAIM|37|一致|docs/adr/0244-hard-rules-step4-unified-push-gate.md:51|ADR 0244 的推送种类清单|`push_class`（`scheduled_reminder`、`approval`、`run_result`、`mail_reminder`、`muse_outage`、`unknown`）
CLAIM|38|一致|docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:149|ADR 0257 决定 3 里“后台发起的一轮读过外来内容后不做”那一行|不做，也不建等着的审批；记一条决策记录，并把“想做什么”作为提议候选交出去

“她自己想到的只能查”在当前提交和基线提交里都没有对应文档，只在非基线历史提交里出现过，已判找不到；收件箱“除了测试没有来源往里写”是按生产装配和全仓调用点核对的，没有运行时验证。其余未核对的部分：方案引用的外部网站和第三方产品说法不在核对范围。
