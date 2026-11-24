I have the full plan. Now let me verify the cited files at the current commit. I'll read the key evidence locations in batches.
核对完毕。以下逐条列出。证据均按当前检出提交 e0d14cee80a27c0e6e45ec505228546304473aed 读取；方案自称按 `891955719` 核对，但仓库实际检出为 `e0d14cee`，我以当前提交为准。

CLAIM|1|一致|packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:1|收件箱表已有|CREATE TABLE think_inbox (
CLAIM|2|一致|docs/adr/0274-new-things-go-through-one-think-entrance.md:105|没有任何来源往里写（带工具的想一想运行、同意任务的写操作审批、来源接入和旧代码清理在后续 PR 里）|带工具的想一想运行、同意任务的写操作审批、来源接入和旧代码清理在后续 PR 里。
CLAIM|3|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:1092|你的消息一到就建好一次运行（INSERT INTO triggers）|INSERT INTO triggers (
CLAIM|4|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:147|一次运行与触发器一一绑死（trigger_id UNIQUE）|trigger_id TEXT NOT NULL UNIQUE REFERENCES triggers(id) ON DELETE RESTRICT,
CLAIM|5|一致|packages/application/src/services/context-formation-service.ts:556|运行与触发器 id 绑定|parsed.prompt.id !== request.trigger.id ||
CLAIM|6|一致|packages/prompt-catalog/src/chat.ts:278|最后一条用户消息承载本轮的新请求……历史消息供理解背景，不是等待执行的任务队列|"Himawari 任务边界：最后一条用户消息承载本轮的新请求，其中 <owner-message> 里是主人本轮说的话，<himawari-context> 里是系统附上的时间和资料，不是主人说的话。历史消息供理解背景，不是等待执行的任务队列。"
CLAIM|7|一致|packages/prompt-catalog/src/think.ts:4|后台“想一想”运行先过一道小判断|id: "think.worth-question",
CLAIM|8|一致|apps/agent-service/src/service-main.ts:1719|后台想一想运行强制只读|readOnlyRun: async (runId) => {
CLAIM|9|一致|packages/prompt-catalog/src/think.ts:38|这次运行不能做任何写操作，也不要尝试|你可以用查记忆、看提醒、联网搜索、打开网页这些只读工具查清楚；这次运行不能做任何写操作，也不要尝试。
CLAIM|10|一致|apps/agent-service/src/production-think-actions.ts:58|只能提三种动作（TASK_RUN / REMINDER_CREATE / REMINDER_RESCHEDULE）|type: TASK_RUN_PROPOSAL_TYPE,
CLAIM|11|一致|apps/agent-service/src/production-think-actions.ts:75|只能提三种动作（第二种 REMINDER_CREATE）|type: REMINDER_CREATE_PROPOSAL_TYPE,
CLAIM|12|一致|apps/agent-service/src/production-think-actions.ts:95|只能提三种动作（第三种 REMINDER_RESCHEDULE）|type: REMINDER_RESCHEDULE_PROPOSAL_TYPE,
CLAIM|13|一致|apps/agent-service/src/production-task-proposals.ts:111|你同意的“去办一件事”会新开一个对话|threadId: `thread:proposal:${key}` as ThreadId,
CLAIM|14|一致|packages/application/src/services/proactive-mail-check-service.ts:211|邮件由模型看片段和最多 3 条记忆给分类|perMail: 3,
CLAIM|15|一致|packages/application/src/services/proactive-mail-check-service.ts:1274|再由公式决定推不推|const wantsPush =
CLAIM|16|一致|packages/application/src/services/perception-source-prompts.ts:14|手机感知分五个来源各有一个检查提示（speech/calendar/location/message/screen）|export const PERCEPTION_SOURCE_KINDS = [
CLAIM|17|一致|packages/application/src/services/proactive-source-runtime.ts:19|有每次、每天条数上限（per_check / per_day）|export type ProactiveSourceLimitKind = "per_check" | "per_day";
CLAIM|18|一致|packages/prompt-catalog/src/perception.ts:597|推送前有一个只看你此刻状态的判断|purpose: "推送到期、发出之前，问判断模型主人此刻的状态是不是不适合被打扰；回答是“不适合”的概率",
CLAIM|19|一致|packages/prompt-catalog/src/review.ts:72|首页另有一个模型打要紧度（home.urgency，0 到 1000）|id: "home.urgency",
CLAIM|20|一致|packages/prompt-catalog/src/review.ts:74|让模型给每件事打一个 0 到 1000 的要紧度|"首页上等主人拿主意的事新出现时，让模型给每件事打一个 0 到 1000 的要紧度；审批另写一句话和同意按钮上的字，按 JSON 返回",
CLAIM|21|一致|apps/agent-service/src/production-web-push.ts:28|推送循环每 10 秒跑一次|const DEFAULT_INTERVAL_MS = 10_000;
CLAIM|22|一致|packages/prompt-catalog/src/perception.ts:585|听到带她名字的话时，先由判断模型决定是不是在对她说|id: "voice.addressee-question",
CLAIM|23|一致|packages/prompt-catalog/src/perception.ts:587|手机认出名字的口头指令提交对话前，问判断模型这句话是不是在对 Himawari 说|"手机认出名字的口头指令提交对话前，问判断模型这句话是不是在对 Himawari 说、要它现在做事；回答是“是”的概率",
CLAIM|24|一致|packages/prompt-catalog/src/authorization.ts:4|由判断模型只凭你亲口说过的话判断你是否明说过|id: "authorization.owner-intent-question",
CLAIM|25|一致|packages/prompt-catalog/src/authorization.ts:6|只凭主人亲口说过的话，看主人是不是已经明说要做这件事|"对话里读过外来内容之后，Himawari 要做一件有后果的小事（例如设提醒）时，让判断模型只凭主人亲口说过的话，看主人是不是已经明说要做这件事",
CLAIM|26|一致|packages/prompt-catalog/src/background.ts:14|后台命令的结果已经以一条追加消息送回原对话|id: "background.notice",
CLAIM|27|一致|packages/prompt-catalog/src/background.ts:19|【系统通知，不是用户发的消息】你在这个对话里早些时候转入后台的命令有了结果|【系统通知，不是用户发的消息】你在这个对话里早些时候转入后台的命令有了结果。请根据下面的结果，用一两句话主动告诉用户发生了什么、接下来建议做什么；用户可能在此期间聊了别的，结合对话上下文回答。
CLAIM|28|一致|docs/pi-development-guide.md:285|Pi 官方有“运行中插一条消息”的写法（deliverAs steer / session.steer）|`deliverAs: "steer"` 在当前这轮工具跑完、下一次请求模型之前送达；`"followUp"` 等整轮结束；`"nextTurn"` 等下一次用户输入。会话外部用 `session.sendCustomMessage(message, options)`，用户消息用 `session.steer()` / `session.followUp()`。
CLAIM|29|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:151|运行容量 totalRuns 3、foregroundReserved 1|"totalRuns": 3,
CLAIM|30|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:152|foregroundReserved 1|"foregroundReserved": 1,
CLAIM|31|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:156|运行时限 runMs 300000|"runMs": 300000,
CLAIM|32|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:87|上下文 contextWindow 1000000|"contextWindow": 1000000,
CLAIM|33|一致|packages/runtime-pi/src/compaction-prefix.ts:75|压缩触发上限 20 万 token|export const COMPACTION_TRIGGER_CAP_TOKENS = 200_000;
CLAIM|34|一致|docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:48|同意过的任务读到外部内容后，写操作由 askAfterExternalContent 接手，每一个都要主人批准|于是同意过的任务读到外部内容后，写操作由 `askAfterExternalContent` 接手，每一个都要主人批准；
CLAIM|35|一致|AGENTS.md:43|已经发出去的内容不得改动、重排或删除，只能在末尾追加；每轮会变的内容只放在最后一条消息里；系统提示和工具按对话冻结|已经发出去的内容不得改动、重排或删除，只能在末尾追加；每轮会变的内容只放在最后一条消息里；系统提示和工具按对话冻结。
CLAIM|36|一致|.agents/instructions/prompt-prefix.md:61|必须缩短历史时，集中做、少做，并在 ADR 里写明。不得每轮都做|12. **必须缩短历史时，集中做、少做，并在 ADR 里写明。**不得每轮都做。
CLAIM|37|一致|.agents/instructions/prompt-prefix.md:64|清理旧的工具结果要等第二步之后另出方案，在那之前不做|这一条要等第二步之后另出方案，在那之前不做。
CLAIM|38|一致|.claude/rules/owner-standing-rules.md:62|判断用户一句话的意图……一律交给模型，程序只做校验|判断用户一句话的意图、时效、是否明说、两句话是不是同一件事，一律交给模型，程序只做校验（原话是否逐字出自主人、格式、额度、白名单）。
CLAIM|39|一致|docs/product-vision.md:55|原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*
CLAIM|40|一致|docs/product-vision.md:60|预判必须建立在已有记忆与明确偏好之上，且预判的收益必须大于打扰我的成本|等待指令是底线，预判需求是目标，但预判必须建立在已有记忆与明确偏好之上，且预判的收益必须大于打扰我的成本。
CLAIM|41|一致|docs/product-vision.md:64|推进受成本、资源与时间预算约束，超限即停下等待|它能在我不在时按既定规则推进有明确目标与停止条件的事情，并在完成后汇报；推进受成本、资源与时间预算约束，超限即停下等待。
CLAIM|42|一致|docs/product-vision.md:156|任意一次开口或沉默，系统能答出「为什么」|任意一次开口或沉默，系统能答出「为什么」
CLAIM|43|找不到|-|记忆线程定的快照做法，压缩时机由本方案定（分支 claude/project-thread-lq8dnz 的 .agents/evidence/memory-redesign-plan-v2.md:63 原话）|（未读到：仓库无 claude/project-thread-lq8dnz 分支，当前提交也没有该文件）
CLAIM|44|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:156|生产上一次运行最长 5 分钟|"runMs": 300000,
CLAIM|45|一致|packages/application/src/ports/configuration.ts:434|现在后台对话 7 天后删|{ key: "threadRetentionDays", unit: "days", minimum: 1, maximum: 90, defaultValue: 7 },
CLAIM|46|一致|apps/agent-service/src/production-think-inbox.ts:125|收件箱现有的排队上限、每天上限、排久了自动作废（expired）|queueLimit: limits.queueLimit ?? THINK_QUEUE_LIMIT,
CLAIM|47|一致|apps/agent-service/src/production-think-inbox.ts:127|排久了自动作废（expiresAfterHours）|expiresAfterHours: limits.expiresAfterHours ?? THINK_EXPIRES_AFTER_HOURS,
CLAIM|48|一致|apps/agent-service/src/production-think-composition.ts:104|现在收件箱工人空闲时要等一个间隔才看下一条|const delay = busy
CLAIM|49|一致|apps/agent-service/src/production-run-dispatch-loop.ts:196|聊天队列现有的做法是 requestWakeup("wakeup")|return this.#requestWakeup("wakeup");
CLAIM|50|一致|packages/application/src/rules/action-rules.ts:43|规则里的 run_source 来自这次运行的来源，只有一个值|runSource: RunExecutionSource["sourceType"],
CLAIM|51|一致|packages/application/src/rules/action-rules.ts:51|run_source 是单个值|run_source: runSource,
CLAIM|52|一致|packages/application/src/services/context-formation-service.ts:191|上下文组装现在只把“叫起这次运行的那一条”从历史里拿掉|const eligibleHistory = [...historyCandidates]
CLAIM|53|一致|packages/persistence-sqlite/src/migrations/20261114110331_decision_ledger_reference_tables.sql:12|decision_ledger 已有“主动”种类（proactive）|('proactive'),
CLAIM|54|一致|packages/persistence-sqlite/src/sqlite-proactive-operations.ts:969|邮件检查现在就写这一种（proactive）|) VALUES (?, ?, ?, 'proactive', ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, ?, ?, ?, NULL, NULL)`,
CLAIM|55|一致|packages/persistence-sqlite/src/migrations/20261114172143_proactive_source_registry.sql:24|场景这一栏已经放开成任意小写名字|scenario TEXT CHECK (
CLAIM|56|一致|packages/persistence-sqlite/src/migrations/20261114172143_proactive_source_registry.sql:26|场景列约束为小写字母数字下划线|(length(scenario) BETWEEN 1 AND 64 AND scenario GLOB '[a-z]*' AND scenario NOT GLOB '*[^a-z0-9_]*')
CLAIM|57|一致|packages/persistence-sqlite/src/migrations/0058_web_push.sql:26|现在推送只有提醒、审批、运行结束三种|kind TEXT NOT NULL CHECK (kind IN ('reminder', 'approval', 'run')),
CLAIM|58|一致|apps/agent-service/src/production-web-push.ts:912|内容是程序拼的“对话标题 + 已完成”|build: (locale) => ({
CLAIM|59|一致|apps/agent-service/src/production-web-push.ts:918|推送正文是对话标题|body: title ?? WEB_PUSH_TEXT[locale].untitled,
CLAIM|60|一致|apps/agent-service/src/production-web-push.ts:430|每次运行结束都会自动推|for (const run of runs)
CLAIM|61|一致|apps/agent-service/src/production-web-push.ts:28|现在最多 10 秒推出|const DEFAULT_INTERVAL_MS = 10_000;
CLAIM|62|一致|packages/application/src/rules/action-rules.ts:86|现有规则在没读外来内容时会放行写操作|'action_kind == "CREATE_OR_UPDATE" && risk == "MEDIUM" && reversible == 1 && disclosure == "none" && recipient_count == 0 && !("context_external_content" in facts) && !("owner_presence_required" in facts)'
CLAIM|63|一致|apps/agent-service/src/production-web-push.ts:452|推送循环里推“最新一条提议”|const { rows: proposalRows } = await this.#readyProposals(now);
CLAIM|64|一致|apps/agent-service/src/production-web-push.ts:467|推送循环里推 Muse 断开|const museOutages = (await this.#options.museChannel?.listActive(now)) ?? [];
CLAIM|65|一致|packages/application/src/services/autonomy-gateway-adapter.ts:27|应用层没装进生产的服务还有类型引用（ReflectionService、SuggestionService）|import type { ReflectionService } from "./reflection-service.js";
CLAIM|66|一致|apps/agent-service/test/fixtures/local-composition-root.ts:3|还有测试夹具引用（AttentionPolicyService）|AttentionPolicyService,
CLAIM|67|一致|packages/application/src/services/perception-extraction.ts:364|感知抽取仍把听到的话当你亲口说的去存记忆|return chunk.sources.every(({ record }) => record.origin === "owner_spoken")
CLAIM|68|一致|packages/application/src/ports/perception.ts:349|语音判断“是”后当作你亲口说的（owner_spoken）|return input.ownerVoiceQualified &&
CLAIM|69|找不到|-|有你的全部权限|（未读到把 owner_spoken 映射为全部权限的代码）
CLAIM|70|一致|packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:261|收件箱结束时的结局只收 proposed、skipped、failed|if (!["proposed", "skipped", "failed"].includes(input.to))
CLAIM|71|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133|triggers.source_type 只允许三种|source_type TEXT NOT NULL CHECK (source_type IN ('user_message', 'schedule', 'external_event')),
CLAIM|72|一致|packages/platform-node/src/strict-configuration.ts:1399|配置解析器会拒绝未知键，去掉 worth 要同时改解析器和模板|rejectUnknown(input, [...Object.keys(ranges), "worth"], field);
CLAIM|73|找不到|-|数据库表冻结：项目记录里写着设计线程（ADR 0282 那件）的迁移合并前，不新增改 decision_ledger、decision_signals、web_push_feedback 的迁移|（未找到 ADR 0282 文件或相应项目记录）

未核对到的部分：分支 `claude/project-thread-lq8dnz` 及 `.agents/evidence/memory-redesign-plan-v2.md` 不存在（前提 17 无法证明）；未找到 ADR 0282 或表冻结的项目记录；未追到“语音判为对她说后有你的全部权限”的权限映射代码；方案自称按 `891955719` 读代码，而当前检出为 `e0d14cee`，我按当前提交核对。
