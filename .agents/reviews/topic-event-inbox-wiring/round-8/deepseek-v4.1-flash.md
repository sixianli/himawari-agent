CLAIM|1|一致|packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:1|收件箱表 `think_inbox` 已建|CREATE TABLE think_inbox (
CLAIM|2|一致|test/integration/think-inbox.test.ts:134|但除了测试没有来源往里写|const result = await inbox.submit(mail("mail-1"));
CLAIM|3|一致|packages/application/src/services/thread-command-service.ts:212|Andy 的每条消息各自建一次运行|const runId = input.runId ?? createRunId(`run:${identity}`);
CLAIM|4|一致|packages/application/src/services/proactive-rules.ts:130|邮件有一个只看一小块信息的小判断或固定公式|export function isReminderWorthy(
CLAIM|5|一致|packages/application/src/services/perception-source-prompts.ts:42|手机感知有一个只看一小块信息的小判断或固定公式|export function buildPerceptionSourceCheckPrompt(input: {
CLAIM|6|一致|packages/application/src/services/delivery-timing.ts:313|推送延后有一个只看一小块信息的小判断或固定公式|return probability * 1000 >= configuration.busyAtLeastPermille
CLAIM|7|一致|packages/application/src/services/home-feed.ts:207|首页排序有一个只看一小块信息的小判断或固定公式|const score = (scores.get(right.key) ?? 0) - (scores.get(left.key) ?? 0);
CLAIM|8|一致|apps/agent-service/src/production-http-composition.ts:1945|语音“是不是在叫她”有一个只看一小块信息的小判断或固定公式|judge = new VoiceAddresseeJudge({
CLAIM|9|一致|apps/agent-service/src/production-task-proposals.ts:147|Andy 同意过的“去办一件事”会新开一个对话|const created = await commands.create({
CLAIM|10|找不到|-|散在对话列表里|-
CLAIM|11|一致|docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:10|详细设计在[规格](../execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md)|# 主对话、子线程和统一收件箱的详细设计
CLAIM|12|一致|packages/application/src/services/perception-source-prompts.ts:14|感知五个分来源检查|export const PERCEPTION_SOURCE_KINDS = [
CLAIM|13|一致|packages/application/src/ports/usage-limits.ts:86|感知五个分来源检查和条数上限中的条数上限|"perception.records.daily": limit(
CLAIM|14|一致|packages/application/src/services/home-urgency.ts:239|首页要紧度打分（ADR 0255）|const score = entry["score"];
CLAIM|15|一致|packages/application/src/services/delivery-timing.ts:313|推送延后判断（ADR 0273）|return probability * 1000 >= configuration.busyAtLeastPermille
CLAIM|16|一致|packages/persistence-sqlite/src/proactive-push-backoff.ts:35|自动降频（ADR 0184）|export function countIgnoredPushes(
CLAIM|17|一致|packages/application/src/services/proactive-rules.ts:130|邮件推送公式|export function isReminderWorthy(
CLAIM|18|一致|apps/agent-service/src/production-think-worker.ts:140|“值不值得想”（ADR 0274）|const answer = await worth.port.decide(
CLAIM|19|一致|apps/agent-service/src/production-http-composition.ts:1945|语音“是不是在叫她”（ADR 0264）|judge = new VoiceAddresseeJudge({
CLAIM|20|一致|packages/application/src/services/voice-command.ts:72|认声音那道保留|return passes(gates.ambientCommand, evidence.speakerScore)
CLAIM|21|一致|apps/agent-service/src/production-web-push.ts:434|子线程跑完不再自动推|sourceKey: `run:${run.runId}:${run.status}${run.resultUnconfirmed ? ":unconfirmed" : ""}`,
CLAIM|22|一致|docs/adr/0244-hard-rules-step4-unified-push-gate.md:52|安静时段规则（ADR 0244）|4. **新增主人规则类型 `push_quiet_hours`**：参数是时段（`periods`，每段有星期、开始、结束，可跨零点）和适用类别（`classes`）。默认管任务完成或失败、邮件提醒；主人明说“包括我自己定的提醒”才含到点提醒。注册时必须带测试文件（`packages/application/test/rule-type-push-quiet-hours.unit.test.ts`），规则自带的命中和不命中例子必须能在判断器里重现。不再另做设置页开关。
CLAIM|23|不一致|packages/application/src/rules/action-rules.ts:122|读过外来内容后的写操作对所有运行都从“拒绝”改成“问”|expression: `action_kind != "READ" && target_type != "managed-task" && "context_external_content" in facts && !(${OWNER_INTENT_CONFIRMED_EXPRESSION})`,
CLAIM|24|一致|.agents/instructions/prompt-prefix.md:36|清理是“发给模型的内容只追加”规则事先留出的例外|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**这包括系统提示、工具定义、历史里的每一条消息（用户的话、回答、工具调用、工具结果）。例外只有五种：第 6 条列出的换新；第 7 条那类只因执行句柄出现的工具，它们出现或消失的那一轮请求开头会变；第 12 条那种有 ADR 依据的、成批的压缩（Pi 在上下文溢出或回答被截断时追加的 `context_edit`，即把失败的那次回答从上下文里拿掉；Pi 的自动重试也会追加它，但 Himawari 关着自动重试，所以它只和压缩一起发生，算在压缩里，见 [ADR 0198](../../docs/adr/0198-upgrade-pi-to-1-5-0.md#decision)），以及将来按 ADR 实施的第 14 条清理；开发用的模型复核经 Magpie 调 CodeBuddy 时，CodeBuddy 以 11128 拒绝某段系统提示后，插件给它加逗号或挪进第一条用户消息再发（[ADR 0178](../../docs/adr/0178-review-model-calls-through-a-local-magpie.md#prompt-prefix-exception)，只影响复核脚本，不影响 Himawari）；[ADR 0193](../../docs/adr/0193-memory-is-visible-to-the-model.md#consequences) 上线后的第一轮，老对话里以前因分级被挡掉的 sensitive 历史消息会出现在历史中间，那个对话的请求开头变一次（Andy 2026-11-09 同意不顾旧聊天记录，只此一次）。
CLAIM|25|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:108|ADR 0230 的感知分来源检查|7. **系统主动提醒改成来源登记。** 每个来源登记自己的提示词、解析器、去重键、预算、开关和评测集；写死 Gmail 的地方（前提 8）全部改掉，并立一道检查：每个登记的来源都要能通过表约束、导出导入校验和类型。
CLAIM|26|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:112|ADR 0230 的条数上限|    - 每个上限显示四样：上限是多少、现在用了多少、什么时候清零、到了会怎样。涵盖每种感官每天的时长和条数、感知触发的模型费、手机上的待传队列、耗电。快到时先提醒，到了就把停掉的那一部分标明“今天已停”。
CLAIM|27|一致|docs/adr/0244-hard-rules-step4-unified-push-gate.md:50|ADR 0244 的推送种类清单|2. **新增闸门名 `push_delivery`**，事实有四个：`push_class`（`scheduled_reminder`、`approval`、`run_result`、`mail_reminder`、`muse_outage`、`unknown`）、`local_minutes`、`local_weekday`、`local_previous_weekday`（主人所在时区，默认 `"UTC"`，生产配置里写实际时区）。规则的结果只有一种：延后到静默时段结束。
CLAIM|28|一致|packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:13|删掉每天计数的列|day TEXT NOT NULL CHECK (day GLOB '????-??-??'),
CLAIM|29|一致|packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:22|删掉 `think_inbox_declined` 表|CREATE TABLE think_inbox_declined (
CLAIM|30|一致|packages/application/src/rules/action-rules.ts:249|因为权限按运行来源判断|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts && !("run_source_owner_approved_task" in facts)',

未核实：“散在对话列表里”没有读到对话列表的过滤或展示代码；Andy 的对话原话、外部产品资料和早先决定出处也未核对。“除了测试没有来源往里写”是按全仓库搜索 sources.register 与 submit 调用点判断的，不是单行代码能直接证明。
