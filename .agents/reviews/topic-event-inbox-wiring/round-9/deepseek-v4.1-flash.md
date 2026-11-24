CLAIM|1|一致|packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:1|收件箱表 `think_inbox` 已建|CREATE TABLE think_inbox (
CLAIM|2|一致|apps/agent-service/src/production-think-worker.ts:73|但除了测试没有来源往里写|await this.#options.inbox.maintain().catch((error: unknown) => report("", error));
CLAIM|3|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:1054, packages/persistence-sqlite/src/sqlite-thread-operations.ts:1111|Andy 的每条消息各自建一次运行|private admitOwnerMessage(input: AdmitOwnerMessageInput) { / INSERT INTO runs (
CLAIM|4|一致|packages/application/src/services/proactive-mail-check-service.ts:1274|邮件、手机感知、推送延后、首页排序、语音“是不是在叫她”各有一个只看一小块信息的小判断或固定公式|const wantsPush = mustNotify || dueSoon || (final.result === "check" && (floor || threadUnread));
CLAIM|5|一致|packages/application/src/services/perception-source-prompts.ts:14-20|邮件、手机感知、推送延后、首页排序、语音“是不是在叫她”各有一个只看一小块信息的小判断或固定公式|export const PERCEPTION_SOURCE_KINDS = [ "speech", "calendar", "location", "message", "screen", ] as const;
CLAIM|6|一致|packages/prompt-catalog/src/perception.ts:597|邮件、手机感知、推送延后、首页排序、语音“是不是在叫她”各有一个只看一小块信息的小判断或固定公式|推送到期、发出之前，问判断模型主人此刻的状态是不是不适合被打扰；回答是“不适合”的概率
CLAIM|7|一致|packages/prompt-catalog/src/review.ts:74|邮件、手机感知、推送延后、首页排序、语音“是不是在叫她”各有一个只看一小块信息的小判断或固定公式|首页上等主人拿主意的事新出现时，让模型给每件事打一个 0 到 1000 的要紧度；审批另写一句话和同意按钮上的字，按 JSON 返回
CLAIM|8|一致|packages/prompt-catalog/src/perception.ts:587|邮件、手机感知、推送延后、首页排序、语音“是不是在叫她”各有一个只看一小块信息的小判断或固定公式|手机认出名字的口头指令提交对话前，问判断模型这句话是不是在对 Himawari 说、要它现在做事；回答是“是”的概率
CLAIM|9|一致|apps/agent-service/src/production-task-proposals.ts:111, packages/persistence-sqlite/src/sqlite-thread-operations.ts:1437|Andy 同意过的“去办一件事”会新开一个对话，散在对话列表里|threadId: `thread:proposal:${key}` as ThreadId, / const conditions = ["owner_id = ?", "agent_id = ?", "origin = 'owner'", lifecycle];
CLAIM|10|一致|packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:13|表 `think_inbox` 改名 `inbox_events`，删掉每天计数的列和 `think_inbox_declined` 表|day TEXT NOT NULL CHECK (day GLOB '????-??-??'),
CLAIM|11|一致|packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:22|表 `think_inbox` 改名 `inbox_events`，删掉每天计数的列和 `think_inbox_declined` 表|CREATE TABLE think_inbox_declined (
CLAIM|12|一致|packages/application/src/services/perception-source-prompts.ts:14-20|感知五个分来源检查|export const PERCEPTION_SOURCE_KINDS = [ "speech", "calendar", "location", "message", "screen", ] as const;
CLAIM|13|一致|packages/application/src/services/proactive-source-runtime.ts:63-64|感知五个分来源检查和条数上限|const leftToday = Math.max(0, settings.perDay - usedToday); / const allowance = Math.min(settings.perCheck, leftToday);
CLAIM|14|一致|packages/prompt-catalog/src/review.ts:71-74|首页要紧度打分（ADR 0255）|export const HOME_URGENCY = fixedPrompt({ id: "home.urgency", purpose: "首页上等主人拿主意的事新出现时，让模型给每件事打一个 0 到 1000 的要紧度；审批另写一句话和同意按钮上的字，按 JSON 返回",
CLAIM|15|一致|packages/prompt-catalog/src/perception.ts:595-597|推送延后判断（ADR 0273）|export const DELIVERY_TIMING_QUESTION = fixedPrompt({ id: "push.delivery-timing-question", purpose: "推送到期、发出之前，问判断模型主人此刻的状态是不是不适合被打扰；回答是“不适合”的概率",
CLAIM|16|一致|packages/application/src/services/proactive-mail-check-service.ts:1382|自动降频（ADR 0184）|if (counts.pushed === 0 && backoff?.steppedUp) return "PUSH_BACKED_OFF";
CLAIM|17|一致|packages/application/src/services/proactive-mail-check-service.ts:1274|邮件推送公式|const wantsPush = mustNotify || dueSoon || (final.result === "check" && (floor || threadUnread));
CLAIM|18|一致|packages/prompt-catalog/src/think.ts:3-4|“值不值得想”（ADR 0274）|export const THINK_WORTH_QUESTION = fixedPrompt({ id: "think.worth-question",
CLAIM|19|一致|packages/prompt-catalog/src/perception.ts:584-587|语音“是不是在叫她”（ADR 0264）|export const VOICE_ADDRESSEE_QUESTION = fixedPrompt({ id: "voice.addressee-question", purpose: "手机认出名字的口头指令提交对话前，问判断模型这句话是不是在对 Himawari 说、要它现在做事；回答是“是”的概率",
CLAIM|20|一致|packages/platform-node/src/device-api-routes.ts:1250|认声音那道保留|const verdict = decideVoiceCommand(evidence, options.voiceGates?.());
CLAIM|21|一致|.agents/instructions/prompt-prefix.md:36|清理是“发给模型的内容只追加”规则事先留出的例外|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。** / 以及将来按 ADR 实施的第 14 条清理
CLAIM|22|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:109|ADR 0230 的感知分来源检查|7. **系统主动提醒改成来源登记。** 每个来源登记自己的提示词、解析器、去重键、预算、开关和评测集；
CLAIM|23|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:113|ADR 0230 的感知分来源检查和条数上限|涵盖每种感官每天的时长和条数、感知触发的模型费、手机上的待传队列、耗电。
CLAIM|24|一致|docs/adr/0244-hard-rules-step4-unified-push-gate.md:51|ADR 0244 的推送种类清单|`push_class`（`scheduled_reminder`、`approval`、`run_result`、`mail_reminder`、`muse_outage`、`unknown`）
CLAIM|25|一致|docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:149|ADR 0257 决定 3 里“后台发起的一轮读过外来内容后不做”那一行|不做，也不建等着的审批；记一条决策记录，并把“想做什么”作为提议候选交出去
CLAIM|26|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:401|记忆出处会变空|source_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
CLAIM|27|一致|packages/persistence-sqlite/src/migrations/0053_memory_episodes.sql:9|记忆片段跟着删|thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
CLAIM|28|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:401|删旧对话后，上线前的记忆没有出处|source_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
CLAIM|29|找不到|-|记忆线程“翻原话”查不到上线前的内容|-

未核实：记忆线程“翻原话”查不到上线前内容这一句没有读到对应实现或测试。外部网站和第三方产品的说法按任务范围未核对。
