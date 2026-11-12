CLAIM|1|找不到|-|只有方案，没有代码。|-
CLAIM|2|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:208|设备接口只有设计|全部在 `/api/device/v1/` 下。除 `pair` 外都要设备签名。每个会改数据的请求都带设备生成的唯一编号，服务器收到重复的只认一次并返回第一次的结果。
CLAIM|3|找不到|-|main 上没有代码|-
CLAIM|4|一致|docs/execution/plans/2026-11-11-apple-device-body-plan.md:47|“服务器：设备配对、设备密钥验签、设备接口的骨架（配对、配置、对话列表、发消息、事件流）”列在第 1 批。|｜ 1   ｜ 服务器：设备配对、设备密钥验签、设备接口的骨架（配对、配置、对话列表、发消息、事件流）、网页“设置 → 设备”页、吊销。改表    ｜ 云端编码线程写，Hermes 上测 ｜ 无   ｜ 无                                                                 ｜
CLAIM|5|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:223|设计里的接口表没有“首页”一项：`docs/execution/specs/2026-11-11-apple-device-body-design.md:223-229` 只有 `POST approvals/respond`、`POST feedback`、`GET usage`、`GET threads` 等。|｜ `POST approvals/respond`          ｜ 回答审批（来自通知按钮或 App 内）                                                      ｜
CLAIM|6|一致|packages/gateway-contracts/src/contracts-v2.ts:106|已有 `approval.list`|  "approval.list",
CLAIM|7|一致|packages/gateway-contracts/src/contracts-v2.ts:35|已有 `proactive.overview.read`|  "proactive.overview.read",
CLAIM|8|一致|packages/gateway-contracts/src/contracts-v2.ts:62|已有 `memory.overview.read`|  "memory.overview.read",
CLAIM|9|一致|packages/gateway-contracts/src/contracts-v2.ts:66|已有 `decision.chain.read`|  "decision.chain.read",
CLAIM|10|一致|packages/gateway-contracts/src/contracts-v2.ts:22|没有跨类汇总的|export const GATEWAY_V2_MESSAGE_TYPES = [
CLAIM|11|一致|packages/application/src/ports/proactive-checks.ts:7|`export type ProactivePriority = "high" | "medium" | "low";`|export type ProactivePriority = "high" | "medium" | "low";
CLAIM|12|一致|packages/application/src/ports/proactive-checks.ts:110|`readonly priority: ProactivePriority | null;`|  readonly priority: ProactivePriority | null;
CLAIM|13|一致|packages/application/src/services/proactive-mail-check-service.ts:1654|`memoryIds: [...trace.memoryIds],`|      memoryIds: [...trace.memoryIds],
CLAIM|14|一致|packages/application/src/services/proactive-mail-check-service.ts:1655|`usedMemoryIds: [...trace.usedMemoryIds],`|      usedMemoryIds: [...trace.usedMemoryIds],
CLAIM|15|一致|packages/application/src/services/proactive-mail-check-service.ts:1643|同一处还记了 `ruleIds`|      ruleIds: [
CLAIM|16|一致|packages/application/src/services/proactive-mail-check-service.ts:1650|同一处还记了 `sourceIds`|      sourceIds: [...trace.sourceIds],
CLAIM|17|一致|packages/application/src/services/proactive-mail-check-service.ts:1651|同一处还记了 `floorHits`|      floorHits: input.floorHits,
CLAIM|18|一致|packages/application/src/services/proactive-mail-check-service.ts:1652|同一处还记了 `ruleHits`|      ruleHits: input.ruleHits,
CLAIM|19|一致|packages/gateway-contracts/src/contracts-v2.ts:1252|每一段带四种状态：`"recorded", "none", "not_recorded", "not_applicable"`|const decisionChainSectionState = enumeration([ "recorded", "none", "not_recorded", "not_applicable", ]);
CLAIM|20|一致|packages/application/src/ports/authorization.ts:185|`readonly deliveryState: "deliverable" | "queued_no_ui";`|  readonly deliveryState: "deliverable" | "queued_no_ui";
CLAIM|21|一致|packages/application/src/ports/authorization.ts:187|`readonly expiresAt: string;`|  readonly expiresAt: string;
CLAIM|22|一致|packages/application/src/services/action-policy-service.ts:506|投递状态只在创建时写一次|        deliveryState: options.uiAvailable ? "deliverable" : "queued_no_ui",
CLAIM|23|一致|packages/application/src/ports/authorization.ts:207|`ResolveApprovalInput` 有 `expectedRevision`、`semanticSnapshotHash`|  readonly expectedRevision: number;  readonly semanticSnapshotHash: string;
CLAIM|24|一致|packages/gateway-contracts/src/contracts-v2.ts:1572|记忆总览里已有等确认的敏感记忆 `pending`|    pending: array(
CLAIM|25|一致|packages/gateway-contracts/src/contracts-v2.ts:1582|记忆总览里已有别的 agent 提议的记忆 `externalProposals`|    externalProposals: object({
CLAIM|26|一致|packages/gateway-contracts/src/contracts-v2.ts:1504|记忆总览里已有到点的提醒 `reminders`|    reminders: array(
CLAIM|27|一致|packages/gateway-contracts/src/contracts-v2.ts:1513|记忆总览里已有接下来的提醒 `upcoming`|    upcoming: array(
CLAIM|28|一致|packages/gateway-contracts/src/contracts-v2.ts:1478|记忆总览里已有替主人整理的 `tidyUps`|    tidyUps: array(
CLAIM|29|一致|packages/gateway-contracts/src/contracts-v2.ts:1490|记忆总览里已有做梦回看 `conversationReviews`|    conversationReviews: array(
CLAIM|30|一致|packages/gateway-contracts/src/contracts-v2.ts:1487|后两样带 `undoable`|        undoable: booleanValue,
CLAIM|31|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133|运行的触发来源有三种|  source_type TEXT NOT NULL CHECK (source_type IN ('user_message', 'schedule', 'external_event')),
CLAIM|32|一致|packages/application/src/ports/run-lifecycle.ts:105|现成的读取只有后台运行：`listBackgroundRuns?(): Promise<readonly BackgroundRunRecord[]>;`|  listBackgroundRuns?(): Promise<readonly BackgroundRunRecord[]>;
CLAIM|33|一致|packages/application/src/services/attention-policy-service.ts:186|`AttentionPolicyService` 定义了它|export class AttentionPolicyService {
CLAIM|34|一致|packages/application/src/services/attention-policy-service.ts:70|按 0 到 100 打分|    candidate.urgency < 0 ||  candidate.urgency > 100 ||
CLAIM|35|一致|apps/agent-service/test/fixtures/local-composition-root.ts:202|搜索 `new AttentionPolicyService` 只命中测试和测试夹具|    attention: new AttentionPolicyService({
CLAIM|36|一致|packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:43|主人评价只有三个值|  owner_rating TEXT CHECK (owner_rating IS NULL OR owner_rating IN ('useful', 'unneeded', 'missed')),
CLAIM|37|一致|packages/persistence-sqlite/src/migrations/0080_decision_signals.sql:6|决策信号只有三个值|  signal TEXT NOT NULL CHECK (signal IN ('opened', 'undone', 'replied')),
CLAIM|38|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:486|`disturbing` 只出现在设计文档里|表 `notification_action_tokens`：凭据的哈希、动作（`approve`、`deny`、`useful`、`disturbing`）、绑定的审批编号和它当时的版本与内容指纹（前提 S3）、绑定的设备、过期时间、使用时间。
CLAIM|39|一致|apps/agent-service/src/production-web-push.ts:306|`await this.#deliver(now, approvals, reminders.length + approvals.length);`|    await this.#deliver(now, approvals, reminders.length + approvals.length);
CLAIM|40|一致|apps/agent-service/src/production-web-push.ts:19|`const REMINDER_WINDOW_MS = 6 * 3_600_000;`|const REMINDER_WINDOW_MS = 6 * 3_600_000;
CLAIM|41|一致|apps/agent-service/src/production-web-push.ts:304|提醒只取到点 6 小时内的|    ).filter(({ remindAt }) => Date.parse(now) - Date.parse(remindAt) <= REMINDER_WINDOW_MS);
CLAIM|42|一致|packages/application/src/ports/model-usage.ts:3|模型用量表的“用途”是写死在表约束里的清单|export const MODEL_USAGE_PURPOSES = [
CLAIM|43|一致|packages/application/src/ports/model-usage.ts:11|`"review-prereview",`|  "review-prereview",
CLAIM|44|一致|packages/persistence-sqlite/src/migrations/0091_decision_prereviews.sql:79|加新用途要重建表|CREATE TABLE model_usage_observations_keep AS SELECT * FROM model_usage_observations; DROP TABLE model_usage_observations;
CLAIM|45|一致|packages/persistence-sqlite/src/migrations/0091_decision_prereviews.sql:91|上一次加用途是迁移 0091|      'memory-consolidation', 'mail-judgment', 'action-review', 'review-prereview', 'other'
CLAIM|46|一致|packages/application/src/services/review-prereview.ts:43|`dailyLimit: 50,`|  dailyLimit: 50,
CLAIM|47|一致|docs/adr/0237-model-pre-rates-waiting-decisions.md:49|ADR 决定 1：模型判断单独存一张不许改的表|新表 `decision_prereviews`（迁移 0091）存每次预评；这张表不许改（触发器拦下 UPDATE），只在它所属的决策记录或邮件记录被删掉时随之删除。
CLAIM|48|一致|docs/adr/0237-model-pre-rates-waiting-decisions.md:51|ADR 决定 3：每天有次数上限|每天最多 `dailyLimit` 次尝试、`dailyCostMicros` 费用；
CLAIM|49|一致|docs/product-vision.md:55|原则顺序。`docs/product-vision.md:55`：“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*
CLAIM|50|找不到|-|设计要求（仓库外）：`/mnt/project-files/ambient-sensing/pending-doc-edits.md` 2026-11-12 的“首页整页重想”一节：“首屏只放 Himawari 主动找主人的事，顺序由服务器按要紧程度给，客户端不自己排。”|-
CLAIM|51|找不到|-|“‘今天’页签上的红点数字 = 等主人定的件数（提醒、审批、待确认记忆），不数‘替你做好的’和‘正在做的’。”|-
CLAIM|52|找不到|-|最后一节：“首页从上到下现在是三样：找你的事、接下来、一行感知状态。”|-
CLAIM|53|一致|packages/gateway-contracts/src/contracts-v2.ts:22|现在服务器没有任何一处把“Himawari 主动找主人的事”汇在一起|export const GATEWAY_V2_MESSAGE_TYPES = [
CLAIM|54|找不到|-|也没有一个各类事情之间能比较的要紧程度|-
CLAIM|55|一致|apps/agent-service/src/production-approval-gateway.ts:177|每秒算一次变化标记|            await wait(1000, undefined, { ...(signal ? { signal } : {}), ref: false });
CLAIM|56|一致|apps/agent-service/src/production-approval-gateway.ts:171|变了就发 `snapshot_required`|              kind: "snapshot_required",
CLAIM|57|一致|packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:99|主动提醒：邮件，`source_insights`，状态 open|  status TEXT NOT NULL CHECK (status IN ('open', 'replied', 'done', 'muted')),
CLAIM|58|一致|packages/application/src/services/proactive-overview.ts:158|经现有的 `isReminderWorthy` 过滤|    if (!isReminderWorthy(insight.result, insight.priority, floor)) {
CLAIM|59|一致|packages/application/src/ports/proactive-checks.ts:92|读邮件的模型已写好的 `summary`|  readonly summary: string;
CLAIM|60|一致|packages/gateway-contracts/src/contracts-v2.ts:1504|主动提醒：到点的记忆提醒，记忆总览的 `reminders`|    reminders: array(
CLAIM|61|一致|packages/gateway-contracts/src/contracts-v2.ts:1572|待确认的记忆，记忆总览的 `pending` 和 `externalProposals`|    pending: array( externalProposals: object({
CLAIM|62|一致|packages/gateway-contracts/src/contracts-v2.ts:1478|替主人做好的，记忆总览的 `tidyUps`、`conversationReviews`|    tidyUps: array( conversationReviews: array(
CLAIM|63|一致|packages/application/src/ports/run-lifecycle.ts:105|正在做的，后台运行（`listBackgroundRuns`）|  listBackgroundRuns?(): Promise<readonly BackgroundRunRecord[]>;
CLAIM|64|一致|apps/control-center/src/i18n/resources/en.ts:1212|出错：Gmail 连接要重新授权|    "Google access expired, so Gmail can’t be read. Checks are paused until you reconnect",
CLAIM|65|一致|packages/application/src/ports/decision-ledger.ts:59|规则要主人复核（决策记录 `rule_review` 的 `needs_review`）|  rule_review: ["needs_review"],
CLAIM|66|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:149|后台运行失败|  status TEXT NOT NULL CHECK (status IN ('accepted', 'building_context', 'running', 'awaiting_approval', 'reconciling_external_result', 'completed', 'failed', 'cancelled')),
CLAIM|67|一致|docs/execution/plans/2026-11-11-apple-device-body-plan.md:55|设备上替主人做完的事（日历、提醒事项、家居，设备批次才有表）|｜ 9   ｜ 动手：设备动作的下发和回报、日历、提醒事项、通讯录、闹钟、家居；设备策略表                                                 ｜ 云端加 Mac                  ｜ 5    ｜ 设 Mac 上允许的目录和 App                                          ｜
CLAIM|68|找不到|-|感知“听到的”待确认记忆（感知还没合入）|-
CLAIM|69|找不到|-|普通运行跑完的结果（只有状态，说不出做成了什么）|-
CLAIM|70|一致|packages/application/src/ports/authorization.ts:182|审批记录里只有机器字段|  readonly intentSnapshot: ActionIntent;
CLAIM|71|一致|packages/application/src/ports/authorization.ts:200|审批的 `finalRisk` 说的是动作多危险|  readonly finalRisk: ActionRiskLevel;
CLAIM|72|找不到|-|记忆类没有任何档位|-
CLAIM|73|一致|packages/application/src/ports/proactive-checks.ts:107|现有的 `floorRaised`|  readonly floorRaised: boolean;
CLAIM|74|一致|apps/agent-service/src/production-web-push.ts:306|网页角标的数会因此变大，因为以前不数邮件提醒和待确认记忆|    await this.#deliver(now, approvals, reminders.length + approvals.length);
CLAIM|75|一致|packages/calibration/src/index.ts:431|校准代码把“提醒了且评 `unneeded`”算作“不该提醒”（`packages/calibration/src/index.ts:431`）|  if (attention && judgment.ownerRating === "unneeded") return "shouldNot";
CLAIM|76|一致|packages/gateway-contracts/src/contracts-v2.ts:674|邮件提醒的动作：`proactive.insight.respond` 的 `done`、`mute`|    action: enumeration(["done", "mute", "reopen", "rate"]),
CLAIM|77|一致|packages/gateway-contracts/src/contracts-v2.ts:1618|到点的记忆提醒：`memory.reminder.respond` 的 `dismiss`、`snooze`、`cancel`|    action: enumeration(["dismiss", "snooze", "cancel"]),
CLAIM|78|一致|packages/gateway-contracts/src/contracts-v2.ts:1745|敏感记忆待确认：`memory.approval.respond` 的 `approved`、`rejected`、`edited`|    resolution: enumeration(["approved", "edited", "rejected"]),
CLAIM|79|一致|packages/gateway-contracts/src/contracts-v2.ts:1716|别的 agent 提议的记忆：`memory.external.respond` 的 `keep`、`reject`|    decision: enumeration(["keep", "reject"]),
CLAIM|80|一致|packages/gateway-contracts/src/contracts-v2.ts:1629|规则要复核：`memory.rule.respond` 的 `reconfirm`、`undo`|export const OWNER_RULE_ACTIONS = ["undo", "confirm", "reconfirm"] as const;
CLAIM|81|一致|packages/gateway-contracts/src/contracts-v2.ts:1607|做好的：`memory.tidy.undo`、`memory.conversationReview.undo`|  ...commandEnvelope("memory.tidy.undo"), ...commandEnvelope("memory.conversationReview.undo"),
CLAIM|82|找不到|-|没有“改到 9:40”这种跟具体事情有关的动作|-
CLAIM|83|不一致|packages/gateway-contracts/src/contracts-v2.ts:674|现在邮件提醒只有“完成、不再提醒”|    action: enumeration(["done", "mute", "reopen", "rate"]),
CLAIM|84|找不到|-|Himawari 不会从一条提醒接着提出一个能一下执行的动作|-
CLAIM|85|一致|apps/agent-service/src/production-proactive.ts:652|邮件提醒点了完成或不再提醒：能撤，现有命令有 `reopen`，把状态改回 open（`apps/agent-service/src/production-proactive.ts:652`）|            : { status: action === "done" ? "done" : action === "mute" ? "muted" : "open" }),
CLAIM|86|一致|apps/agent-service/src/production-memory-control.ts:1119|别的 agent 提议的记忆点了记下或不记：能撤，现有 `memory.external.undo` 按批撤回|    const reopened = await writer.undoBatch(batchId, async (memoryId) => {
CLAIM|87|一致|packages/gateway-contracts/src/contracts-v2.ts:1618|敏感记忆点了不记、记忆提醒点了知道了或取消：现在没有恢复的命令|    action: enumeration(["dismiss", "snooze", "cancel"]),
CLAIM|88|一致|packages/gateway-contracts/src/contracts-v2.ts:197|审批的同意和拒绝：撤不了|    decision: enumeration(["approved", "denied"]),
CLAIM|89|一致|packages/gateway-contracts/src/contracts-v2.ts:1513|`upcoming`：现在的真实来源是记忆总览的 `upcoming`（到期日在未来的提醒）|    upcoming: array(
CLAIM|90|一致|scripts/model-review/gateway.json:27|按复核脚本里记的 DeepSeek V4.1 Flash 按量单价（每百万输入 0.15 美元、输出 0.6 美元，`scripts/model-review/gateway.json:27`）|      "cost": { "input": 0.15, "output": 0.6, "cache_read": 0.003 }
CLAIM|91|一致|packages/application/src/services/review-prereview.ts:43|每天最多次数是设置，默认 50 次（和预评一样，前提 14）|  dailyLimit: 50,
CLAIM|92|一致|package.json:56|提示词登记进目录（`npm run check:prompt-catalog` 守着），调用出口登记进出口遮盖检查（`npm run check:egress-redaction` 守着）|    "check:egress-redaction": "node scripts/check-egress-redaction.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/egress-redaction-check.test.mjs", "check:prompt-prefix": "node scripts/check-prompt-prefix.mjs", "check:prompt-catalog": "vitest run --config vitest.workspace.ts --project node-services apps/agent-service/test/prompt-catalog.unit.test.ts apps/agent-service/test/prompt-rendering-golden.unit.test.ts apps/agent-service/test/prompt-output-contracts.unit.test.ts apps/agent-service/test/prompt-wording.unit.test.ts apps/agent-service/test/trusted-prompt-egress.unit.test.ts && vitest run --config vitest.workspace.ts --project unit packages/sensitive-capture/test/trusted-text.unit.test.ts && vitest run --config vitest.workspace.ts --project browser apps/control-center/test/sensitive-interceptions.unit.test.ts && vitest run --config vitest.workspace.ts --project pi-compat packages/runtime-pi/test/pi-builtin-tool-text.compat.test.ts",
CLAIM|93|找不到|-|`npm run check:prompt-prefix` 只管对话请求，管不到这次新调用|-
CLAIM|94|找不到|-|原始记录在 `.agents/reviews/topic-home-feed/`。|-
CLAIM|95|找不到|-|`action`、`label`、`ownerPresence` 三个名字和第 4 批推送里动作的字段同名|-

未能核对的部分：仓库外的 `/mnt/project-files/ambient-sensing/pending-doc-edits.md` 无法读取，`.agents/reviews/topic-home-feed/` 在稀疏检出中没有文件且 git 访问被拒绝，第 4 批推送分支的代码也不在当前检出中；此外“没有代码”“没有某功能”等否定说法以及部分难以从单行代码证明的现状说法，我只做了有限搜索，未逐项坐实。
