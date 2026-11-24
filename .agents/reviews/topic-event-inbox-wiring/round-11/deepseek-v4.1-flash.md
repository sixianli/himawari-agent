CLAIM|1|一致|packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:1|收件箱表 `think_inbox` 已建|CREATE TABLE think_inbox (
CLAIM|2|一致|test/integration/think-worker.test.ts:166|除了测试没有来源往里写|await inbox.submit(mail("a"));
CLAIM|3|一致|packages/application/src/services/thread-command-service.ts:212|Andy 的每条消息各自建一次运行|const runId = input.runId ?? createRunId(`run:${identity}`);
CLAIM|4|一致|packages/application/src/services/proactive-mail-check-service.ts:1274|邮件、手机感知、推送延后、首页排序、语音“是不是在叫她”各有一个只看一小块信息的小判断或固定公式|const wantsPush =
CLAIM|5|一致|packages/application/src/services/perception-source-prompts.ts:14|邮件、手机感知、推送延后、首页排序、语音“是不是在叫她”各有一个只看一小块信息的小判断或固定公式|export const PERCEPTION_SOURCE_KINDS = [
CLAIM|6|一致|packages/prompt-catalog/src/perception.ts:595|邮件、手机感知、推送延后、首页排序、语音“是不是在叫她”各有一个只看一小块信息的小判断或固定公式|export const DELIVERY_TIMING_QUESTION = fixedPrompt({
CLAIM|7|一致|packages/prompt-catalog/src/review.ts:72|邮件、手机感知、推送延后、首页排序、语音“是不是在叫她”各有一个只看一小块信息的小判断或固定公式|id: "home.urgency",
CLAIM|8|一致|packages/prompt-catalog/src/perception.ts:585|邮件、手机感知、推送延后、首页排序、语音“是不是在叫她”各有一个只看一小块信息的小判断或固定公式|id: "voice.addressee-question",
CLAIM|9|一致|apps/agent-service/src/production-task-proposals.ts:111|Andy 同意过的“去办一件事”会新开一个对话，散在对话列表里|threadId: `thread:proposal:${key}` as ThreadId,
CLAIM|10|一致|packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:13|表 `think_inbox` 改名 `inbox_events`，删掉每天计数的列和 `think_inbox_declined` 表|day TEXT NOT NULL CHECK (day GLOB '????-??-??'),
CLAIM|11|一致|packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:22|表 `think_inbox` 改名 `inbox_events`，删掉每天计数的列和 `think_inbox_declined` 表|CREATE TABLE think_inbox_declined (
CLAIM|12|一致|packages/application/src/services/perception-source-prompts.ts:14；packages/prompt-catalog/src/review.ts:72；packages/prompt-catalog/src/perception.ts:595；packages/application/src/services/proactive-mail-check-service.ts:1382；packages/application/src/services/proactive-mail-check-service.ts:1274；packages/prompt-catalog/src/think.ts:4；packages/prompt-catalog/src/perception.ts:585|删掉 7 处替她做决定的小判断和公式|PERCEPTION_SOURCE_KINDS；id: "home.urgency",；export const DELIVERY_TIMING_QUESTION = fixedPrompt({；if (counts.pushed === 0 && backoff?.steppedUp) return "PUSH_BACKED_OFF";；const wantsPush =；id: "think.worth-question",；id: "voice.addressee-question",
CLAIM|13|一致|packages/application/src/services/perception-source-prompts.ts:14；packages/application/src/services/proactive-source-runtime.ts:19|感知五个分来源检查和条数上限|export const PERCEPTION_SOURCE_KINDS = [；export type ProactiveSourceLimitKind = "per_check" | "per_day";
CLAIM|14|一致|docs/adr/0255-model-scores-urgency-of-home-items.md:11|首页要紧度打分（ADR 0255）|# ADR 0255：首页上等主人定的事由模型打要紧度并存住，审批另由模型写一句话和同意按钮上的字
CLAIM|15|一致|docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:11|推送延后判断（ADR 0273）|# ADR 0273：主人在忙时，由判断模型 Jev 决定先不推送
CLAIM|16|一致|packages/application/src/services/proactive-mail-check-service.ts:1382|自动降频（ADR 0184）|if (counts.pushed === 0 && backoff?.steppedUp) return "PUSH_BACKED_OFF";
CLAIM|17|一致|packages/application/src/services/proactive-mail-check-service.ts:1275|邮件推送公式|mustNotify || dueSoon || (final.result === "check" && (floor || threadUnread));
CLAIM|18|一致|packages/prompt-catalog/src/think.ts:4|“值不值得想”（ADR 0274）|id: "think.worth-question",
CLAIM|19|一致|packages/prompt-catalog/src/perception.ts:585|语音“是不是在叫她”（ADR 0264；认声音那道保留）|id: "voice.addressee-question",
CLAIM|20|一致|packages/application/src/services/voice-command.ts:72|语音“是不是在叫她”（ADR 0264；认声音那道保留）|return passes(gates.ambientCommand, evidence.speakerScore)
CLAIM|21|一致|docs/adr/0184-back-off-ignored-proactive-pushes.md:10|被取代：ADR 0184、0255、0264、0273、0274、0277、0278|# ADR 0184：同一类主动推送连续被忽略时自动降频
CLAIM|22|一致|docs/adr/0255-model-scores-urgency-of-home-items.md:11|被取代：ADR 0184、0255、0264、0273、0274、0277、0278|# ADR 0255：首页上等主人定的事由模型打要紧度并存住，审批另由模型写一句话和同意按钮上的字
CLAIM|23|一致|docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md:11|被取代：ADR 0184、0255、0264、0273、0274、0277、0278|# ADR 0264：手机认出名字后，由判断模型 Jev 决定这句话是不是在叫 Himawari
CLAIM|24|一致|docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:11|被取代：ADR 0184、0255、0264、0273、0274、0277、0278|# ADR 0273：主人在忙时，由判断模型 Jev 决定先不推送
CLAIM|25|一致|docs/adr/0274-new-things-go-through-one-think-entrance.md:11|被取代：ADR 0184、0255、0264、0273、0274、0277、0278|# ADR 0274：新知道的事都走同一个“想一想”入口，先问值不值得，再带工具想
CLAIM|26|一致|docs/adr/0277-the-system-deletes-expired-think-threads.md:11|被取代：ADR 0184、0255、0264、0273、0274、0277、0278|# ADR 0277：想一想对话到期由系统自动删除，不等主人确认
CLAIM|27|一致|docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:11|被取代：ADR 0184、0255、0264、0273、0274、0277、0278|# ADR 0278：主人同意过的任务读到外部内容后，写操作改成问主人
CLAIM|28|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:109；docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:113|ADR 0230 的感知分来源检查和条数上限|7. **系统主动提醒改成来源登记。** 每个来源登记自己的提示词、解析器、去重键、预算、开关和评测集；写死 Gmail 的地方（前提 8）全部改掉，并立一道检查：每个登记的来源都要能通过表约束、导出导入校验和类型。；- 每个上限显示四样：上限是多少、现在用了多少、什么时候清零、到了会怎样。涵盖每种感官每天的时长和条数、感知触发的模型费、手机上的待传队列、耗电。快到时先提醒，到了就把停掉的那一部分标明“今天已停”。
CLAIM|29|一致|docs/adr/0244-hard-rules-step4-unified-push-gate.md:51|ADR 0244 的推送种类清单|事实有四个：`push_class`（`scheduled_reminder`、`approval`、`run_result`、`mail_reminder`、`muse_outage`、`unknown`）、`local_minutes`、`local_weekday`、`local_previous_weekday`
CLAIM|30|一致|docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:149|ADR 0257 决定 3 里“后台发起的一轮读过外来内容后不做”那一行（改成问）|| 后台发起的一轮，上下文里有外来内容，想做有后果的事 | 不做，也不建等着的审批；记一条决策记录，并把“想做什么”作为提议候选交出去 |
CLAIM|31|一致|docs/product-vision.md:64|合愿景原则 8|8. **可持续存在** — 它能在我不在时按既定规则推进有明确目标与停止条件的事情，并在完成后汇报；推进受成本、资源与时间预算约束，超限即停下等待。
CLAIM|32|一致|docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:10|[SOURCE: docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md]|# 主对话、子线程和统一收件箱的详细设计
CLAIM|33|一致|.agents/instructions/prompt-prefix.md:36|清理是“发给模型的内容只追加”规则事先留出的例外。|以及将来按 ADR 实施的第 14 条清理

没有未能核对的部分。第 2 条是否定性的说法，我在全仓库搜索了 `inbox.submit` 和 `store.enqueue` 的调用点，确认生产 `apps/agent-service/src` 里没有来源提交，证据行取的是测试里的写入调用。
