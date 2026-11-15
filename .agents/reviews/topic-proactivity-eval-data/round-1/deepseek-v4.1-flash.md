## 0. 结论先说

**不要另建一套“主动性统计账本”。** 把 `decision_ledger` 补成真正的“所有模型门槛决策”表：每一次“开口/沉默、保留/丢弃、合并/作废、提议/不提议、值不值得想”都落一行；再补一张不可变的“决策上下文”表记录当时的模型、提示词、阈值和设置快照；把 `decision_signals` 扩成通用的“曝光/反应/结果事件表”；把提议箱、推送反馈、思考队列的当前状态保留在原表，但历史变化写成事件。这样既能算命中率/误扰率/已审漏报率，也能回答“这次变化是模型、提示词、设置还是数据本身造成的”。

---

## 1. 方案依赖的前提

| # | 前提 | 来源 | 原话/依据 |
|---|---|---|---|
| 1 | 已有唯一决策账本，不建第二套 | `docs/adr/0143-decision-ledger-for-model-gate-decisions.md:36` | “**扩展现有记录，不建第二套。** 迁移 0069 把 `proactive_decisions` 重建成 `decision_ledger`。” |
| 2 | 会增长的取值不能用 CHECK 枚举，要用参照表加触发器 | `.agents/instructions/migrations.md#rules` | “**不要用 `CHECK (列 IN (...))` 枚举会增长的取值。用参照表加触发器**，加一个取值就是往参照表插一行，不用重建表。” |
| 3 | 发给模型的内容只能末尾追加，会变的值只能在最后一条消息，字节必须确定 | `.agents/instructions/prompt-prefix.md#rules` 第 1–4、10–11、15 条 | “固定的在前，会变的在后。”“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”“同样的内容，每次都要序列化成同样的字节。”“后台调用也是固定的在前、会变的在后。” |
| 4 | Jarvis Test 第 10 条要 30 天连续统计所有模型门槛决策，附样本量；第 11 条要任意开口/沉默可追溯 | `docs/product-vision.md:155`、`:107`、`:159` | “连续 30 天统计所有由模型做出的门槛决策——主动提醒的开口与沉默、记忆的保留与丢弃、整理的合并与作废——的命中率、误扰率与已审漏报率，附样本量；命中率上升、误扰率下降，趋势可量化。”“任意一次开口或沉默都能追溯到规则的出处与记忆的原话。” |
| 5 | 现有统计口径是“你评过的样本里算比例”，小样本用 Wilson 区间，样本不足不写百分比 | `docs/adr/0154-weekly-calibration-report-and-muse-mail-pairing.md:34-36`；`docs/adr/0187...:41-42`；`packages/calibration/src/index.ts:207-222`、`:876-877`、`:938-954` | “样本 n = 窗口内做出的、你评过价的某一类决策的条数。”“n 小于最小样本数（默认 5，参数 `--min-samples` 可改）时写「样本不足（n 条）」，不出百分比，绝不写 0%。”“只有两周的 95% 区间不重叠，才能说比例真的变了；区间重叠只是波动。” |
| 6 | 现有决策写入没有模型、提示词、设置版本 | `packages/application/src/ports/decision-ledger.ts:199-216` | `DecisionLedgerWrite` 的字段只有 `id/ownerId/agentId/kind/decidedAt/outcome/reasonCode/subjectRef/inputs/reasonRef/contentRef/costMicros/durationMs/category/confidencePermille/inferred`，没有 `modelRef`、`promptId`、`settingsVersion`。 |
| 7 | “想一想”和提议箱目前没有完整进决策账本 | `apps/agent-service/src/production-think-worker.ts:76-109`；`packages/persistence-sqlite/src/migrations/20261114151010_owner_proposals.sql:1-28`；`packages/application/src/services/perception-extraction.ts:682-716`、`:860-864` | 思考结束只 `finish({ to: "proposed"|"skipped"|"failed", reasonCode })`；`owner_proposals` 只有当前 `status`/`exec_status`；感知抽取只写 `proposed`/`not_proposed`，`subjectRef` 是 `episode.id`，不是 `owner_proposals.id`。 |
| 8 | 推送反馈只覆盖网页推送，苹果不回报，且“没点开”不等于“不需要” | `docs/adr/0102-record-push-notification-feedback.md:41-76`；`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:609-693`；`packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:473-485` | ADR 0102：“iPhone 上「划掉」大概率拿不到，误扰主要靠「24 小时没反应」判断，会把「看到了但不需要点」的通知也算作误扰；这是已知偏差。”代码里 `web_push_feedback` 的 `channel` 只有 `web_push`，苹果写入 `apns` 但主键仍按 `source_key` 合并。 |
| 9 | 提议卡片第一次显示时间没有记录 | `packages/persistence-sqlite/src/migrations/20261114151010_owner_proposals.sql:1-28` | 表里只有 `proposed_at`、`expires_at`、`decided_at`，没有 `first_shown_at`。 |
| 10 | 业界把“生产监控 + 人工评价 + 平衡正反例 + 人类接受/拒绝标签”作为主动型 agent 的评估基础 | OpenAI Evaluation best practices：https://developers.openai.com/api/docs/guides/evaluation-best-practices ；OpenAI Evals：https://openai.com/index/evals-drive-next-chapter-of-ai/ ；Anthropic Demystifying evals：https://www.anthropic.com/research/demystifying-evals-for-ai-agents ；ProactiveAgent：https://arxiv.org/abs/2410.12361 ；Microsoft Guidelines for Human-AI Interaction：https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/ ；scikit-learn calibration：https://scikit-learn.org/stable/modules/calibration.html | OpenAI：“Log everything: Log as you develop so you can mine your logs for good eval cases.”“Log inputs, outputs, and outcomes; sample those logs on a schedule and automatically route ambiguous or costly cases to expert review.” Anthropic：“A complete picture includes production monitoring, user feedback, A/B testing, manual transcript review, and systematic human evaluation.”“Test both the cases where a behavior should occur and where it shouldn't. One-sided evals create one-sided optimization.” ProactiveAgent：“predictions are then labeled by human annotators as either accepted or rejected. The labeled data is used to train a reward model that simulates human judgment…” Microsoft：“We propose 18 generally applicable design guidelines for human-AI interaction.” 这些来源共同支持：记录真实开口/沉默与主人接受/拒绝，正反例都要有，人工评价是金标准，模型评分只能做辅助。 |
| 11 | 这一步不新增模型调用 | 用户约束 | “这一步不新增模型调用（新增模型调用要主人另外批准，可以作为后续步骤提出，说明用途和大致费用）。” |

---

## 2. 已核实的现状（只列和本问题直接相关的）

1. **账本本身是好的，但只记“做了什么”，不记“为什么是这个版本做的”。** `decision_ledger` 有 `kind/outcome/verdict/reason_code/inputs/owner_rating`，但没有模型、提示词、设置快照。见 `packages/persistence-sqlite/src/migrations/20261114110331_decision_ledger_reference_tables.sql:66-109`。
2. **同类决策的“单位”不统一。** 邮件检查是“一次检查一行”（`kind='proactive'`），但每封邮件的结果在 `proactive_processed_messages`；后者 `ON CONFLICT ... DO NOTHING`，同一封邮件以后再次被判断时**不会追加新行**，见 `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:1029-1034`。`source_insights` 又会把 `decision_id` 更新成最新一次检查，见 `:1063-1080`。所以现在无法可靠回答“每一次邮件判断分别是什么”。
3. **评分有两套，可能不一致。** `decision_ledger.owner_rating` 和 `proactive_processed_messages.owner_rating` 分开更新：`rateDecision` 只更新账本（`sqlite-proactive-operations.ts:1368-1384`），`rateProcessed` 只更新邮件表（`:1387-1398`）。同一个判断在两处看见的评分可能不同。
4. **推送反馈表把网页和苹果合并了。** `web_push_feedback` 主键是 `(owner_id, agent_id, source_key)`（`0061_web_push_feedback.sql:15`），苹果写入 `channel='apns'`（`sqlite-apple-push-operations.ts:473-485`）时会和网页推送冲突，只增加 `devices`，不会保留每个渠道一行。`channel` 不能作为可靠的分析维度。
5. **观察信号写死三种值。** 表上 `CHECK (signal IN ('opened','undone','replied'))`（`20261114110331...:192`），TypeScript 也写死（`packages/application/src/ports/decision-ledger.ts:20`），网关契约写死（`packages/gateway-contracts/src/contracts-v2.ts:1895`），数据导出 schema 也写死（`packages/persistence-sqlite/src/data-export/schemas.ts:497`）。加一种信号必须同时改这四处，否则会重演 I-73 的“只改一端”。
6. **“值不值得想”的分数没有存。** `ThinkWorthPort` 返回 `choice`、`confidence`、`probabilities`，但 `production-think-worker.ts:100-101` 只用 `verdict`，没有把置信度写进账本；因此无法像记忆门槛那样画门槛曲线。
7. **感知抽取的提议没有和提议箱连上。** `perception-extraction.ts:860-864` 写 `kind='proposal'`、`subjectRef=episode.id`；`production-perception-extraction.ts:85` 的 `proposals` 是可选，`service-main.ts:2502-2549` 构造时没有传。也就是说，账本里可能出现 `proposed`，但 `owner_proposals` 里没有对应行，反过来也无法从提议追溯到那次判断。这是典型的 I-73 风险（`docs/incidents-and-gates.md:112`：“双模型复核只看了改动，没问「清单里的 id 能通过后端校验吗」”）。
8. **日报抽样过程没有落库。** `daily-review.ts:103-158` 算出了 `sampled/notSampled/hiddenByModel/foldedTotal`，但这些只是返回值，没有持久化。以后无法知道“这一周你被展示了哪些、没被展示哪些”，也就无法判断漏报率是否被抽样偏差污染。
9. **统计包只认“评过的样本”。** `summarizeDecisions` 的分母是 `rated`，不是全部机会；`proactive_silent` 的 `missed` 只有在主人评过沉默项时才存在。见 `packages/calibration/src/index.ts:302-331`。这不是错，但必须同时报告“评过的比例/覆盖”，否则容易把“没评”当成“没问题”。

---

## 3. 方案本身

### 3.1 先定义“评估单位”和状态

“变好还是变坏”必须先固定分母。建议按决策类型定义最小评估单位：

| 决策类型 | 评估单位 | 开口/行动 | 沉默/不行动 | 被排除（不进分母） |
|---|---|---|---|---|
| 邮件主动检查 | **一封邮件的一次判断** | `act/know/check` | `ignore` | `skipped`（category/sensitive/own_mail/未读全等） |
| 主动推送 | 一个推送源 `source_key` | `delivered` 后 `opened/replied` | `suppressed/expired` | 未送达、页面正开着被压下 |
| 记忆候选 | 一条候选 | `kept` | `discarded` | `capture_failed` 等失败，单独列 |
| 整理 | 一次整理动作 | `merge/supersede/archive/reflect` | `hold` | 未运行、无候选 |
| 提议箱 | 一条提议 | `proposed → shown → accepted → executed` | `not_proposed` | `expired_before_shown` 单独列 |
| “想一想” | 一条 `think_inbox` 来源 | `worth=yes → proposed` | `worth=no/unsure → skipped` | `failed` 单独列 |
| 规则重审/设备动作等 | 一次决策 | 现有 outcome | 现有 outcome | 失败/不可用单独列 |

**关键状态机：**

- 决策：`eligible → decided(act|silent|defer) → delivered/shown → owner_action → resolved`，另外有 `failed`、`expired`、`superseded`、`withdrawn`、`censored`。
- 评价：`unrated → rated_useful | rated_unneeded | rated_missed → rating_cleared`。每次改评都留历史，不能只留最新值。
- 提议：`pending → accepted | rejected | expired | superseded | withdrawn`；执行：`not_started → running → succeeded | failed | unknown | undone`。**“未显示就过期”不能算拒绝；“执行失败”不能算主人不喜欢。**
- 推送：`queued → delivered | suppressed | expired | failed`；反馈：`shown → opened | dismissed | replied`；没有回报时是 `unknown/censored`，不是“没点开”。

### 3.2 表设计：合并、保留、搬列

#### 要新增/改造的核心表

**A. `decision_contexts`（新，不可变维度表）**

一行代表“做出这个判断时，系统是什么版本”。建议列：

`id, owner_id, agent_id, created_at, digest, model_ref, prompt_catalog_id, prompt_digest, prompt_bundle_generation, settings_digest, settings_json, thresholds_json, rulebook_revision, policy_version, feature_flags_json, service_revision`

- `digest = sha256(canonical JSON of model_ref + prompt id/digest + settings/thresholds/rulebook/policy/feature flags)`，**不把时间、service_revision 算进 digest**；service_revision 只作元数据，否则每次重启都会产生新版本。
- `prompt_bundle_generation` 可空：对话内做出的决策引用 `thread_prompt_bundles` 的冻结代次（`0077_thread_prompt_bundles.sql` 已有 `system_prompt_sha256`/`tools_sha256`）；后台调用用 `prompt_catalog_id + prompt_digest`。
- `settings_json` 只放影响决策的设置，不放 API key；密钥只存引用名或“已配置”标志。
- `decision_ledger.context_id` 外键指向它。没有这张表，就无法区分“模型变好了”和“阈值变松了”。

**B. `decision_ledger`（保留，扩展）**

保留为**唯一决策账本**，新增：

- `context_id`（必填，历史行回填 `legacy` 上下文）。
- `subject_kind`（`check/message/memory/proposal/think/action`），与现有 `subject_ref` 配对，避免“这个 ref 到底是邮件号还是提议号”说不清。
- `decision_unit`（`email_message/check/memory_candidate/consolidation/proposal/think/...`），用于报表固定分母。
- 新 kind：
  - `proactive_email`：每封被模型实际判断的邮件一行；outcome `act/know/check/ignore`；`subject_ref=message_id`；`inputs` 带 `checkDecisionId/threadId/receivedAt`。
  - `think`：每条 `think_inbox` 结束时一行；outcome `proposed/skipped/failed`；`subject_ref=think_inbox.id`；`confidence_permille` 存“值不值得想”的置信度；`inputs` 带 `proposalId`（如果有）。
- `proposal` kind 保留，但修正 `subject_ref`：必须指向 `owner_proposals.id`，不能是 `episode.id`。
- `reason_code` 增加参照表 `decision_reason_codes(kind, reason_code, class, active)`。现在 `thresholds.ts:36-66` 的 `gatedReasons` 依赖固定字符串，字符串一漂移，门槛统计就悄悄少样本。

**C. `decision_signals` → 通用 `decision_events`（保留表名，扩展语义）**

现有表已经具备 `decision_id/signal/occurred_at/delay_ms/detail/source_ref/recorded_at` 和不可变触发器，改造成本最低。新增：

- `signal` 参照表 `decision_signal_kinds(signal, class, actor, description)`；删除表上的 `CHECK IN (...)`，改用触发器/FK。`class` 建议：`exposure`、`owner_reaction`、`system_outcome`、`rating`。
- 新增 `channel`（`web_push/apns/in_app/web/email/...`）和 `surface`（`proposal_card/push/notification_center/...`）。
- 信号值至少覆盖：
  - 曝光：`delivered`、`shown`
  - 主人反应：`opened`、`dismissed`、`replied`、`accepted`、`rejected`、`snoozed`、`undone`
  - 系统结果：`expired`、`superseded`、`withdrawn`、`executed`、`failed`、`result_unknown`
  - 评价：`rated_useful`、`rated_unneeded`、`rated_missed`、`rating_cleared`
- `detail` 里放 `{from,to,rating,previous,reason,batchId,proposalVersion}` 等；`source_ref` 保持幂等键作用。
- 这张表成为曝光/反应/结果/评价历史的**唯一事件源**。`web_push_feedback` 和 `owner_proposals` 只保留当前状态，不再各自维护一份历史。

**D. `owner_proposals`（保留当前状态，扩展）**

新增：

- `generation_decision_id TEXT REFERENCES decision_ledger(id)`，唯一索引；一条提议必须对应一条生成决策账本行。
- `first_shown_at`、`first_shown_surface`、`first_shown_channel`；触发器保证只能写一次，且不早于 `proposed_at`、不晚于 `decided_at`（如果已经决定）。
- `decided_by`（`owner/system`）和 `decision_source`（`web/ios/push_action/api`），用来区分“主人拒绝”和“系统过期”。

`status`/`exec_status` 的每次变化写一条 `decision_events`，不要新建状态历史表。

**E. `think_inbox`（保留队列，落永久账本）**

- 增加 `decision_id` 唯一外键，指向结算时写的 `think` 账本行。
- `worth` 的 `choice/confidence`、当时阈值、模型/提示词上下文写进 `decision_ledger`（`confidence_permille` + `context_id`），不要只留在会过期的 `think_inbox`。
- 思考对话 7 天后删除（ADR 0277），所以**在删除前**必须把结论摘要/理由引用和提议链接写进账本；否则第 11 条的追溯会断。

**F. `web_push_feedback`（保留投递摘要，搬走反应列）**

- 主键改为 `(owner_id, agent_id, source_key, channel)`，至少能分别记录 `web_push` 和 `apns`。
- 保留 `first_sent_at/devices/kind/source_ref/thread_id/tag/channel`。
- 把 `opened_at`/`dismissed_at` 搬到 `decision_events`；如果推送回退逻辑还要用，建一个只读视图或查询事件，不要继续把这两列当分析源。
- 送达结果（`delivered/suppressed/expired/failed`）写成事件。否则“模型选择沉默”和“推送失败”会混在一起。

**G. `review_batches`（新，小表）**

记录日报抽样框架，防止“只评了开口项”导致漏报率失真：

`id, owner_id, agent_id, day, capacity, pool_size, sampled_count, hidden_count, not_sampled_count, folded_total, silent_share, selection_seed, created_at`

每一条被展示/隐藏/评分的项通过 `decision_events` 的 `shown`/`rated_*` 事件关联，`detail.batchId` 指回批次。这样能报告“评过的比例/覆盖”，并在样本少时知道偏差来自哪里。

**H. `decision_metric_snapshots`（可选，建议有）**

如果网页要直接显示趋势，建议加一张只追加的派生快照表：

`id, owner_id, agent_id, as_of, window_start, window_end, metric_version, kind, stratum, n, useful, unneeded, missed, coverage, context_digest, created_at`

它不是事实源，事实仍在账本/事件表；它用于冻结“当时是怎么算的”，避免以后改口径把历史结论重写。现有的 `evals/calibration/history.jsonl` 可以继续保留，但应增加 `metric_version`、`coverage`、`context_digest`。

#### 明确回答“哪些合并、哪些保留、哪些搬走”

| 表 | 处理 | 理由 |
|---|---|---|
| `decision_ledger` | **保留并扩展** | 唯一决策账本；新增 `context_id/subject_kind/decision_unit` 和新 kind。 |
| `proactive_processed_messages` | **保留为去重/审计明细，评分搬走** | 现在“同一封邮件只记第一次”（`DO NOTHING`），不能当完整决策历史；每封邮件的新判断进 `proactive_email` 账本行，评分也放在账本行。 |
| `source_insights` | **保留为当前状态，评分搬走** | 它是“这条线索现在是什么状态”（open/replied/done/muted），不是决策历史；`owner_rating` 移到关联的决策行。 |
| `decision_signals` | **保留表名，扩成事件表** | 已有不可变、幂等、按决策关联的骨架；加参照表、`channel/surface` 和信号值即可。 |
| `owner_proposals` | **保留当前状态，加链接和首次显示** | 当前状态查询方便；历史变化写事件。加 `generation_decision_id`，杜绝“账本有提议、箱里没有”。 |
| `think_inbox` | **保留队列，结算写账本** | 队列会过期/清理，不能作为长期统计源；永久信息进 `decision_ledger`。 |
| `web_push_feedback` | **保留投递摘要，反应列搬走** | 它是“发到几台设备”的摘要；点开/划掉属于事件。 |
| `decision_prereviews` | **保留** | 模型预审是辅助信号，不是主人评价；加 `context_id`，`calibration_group` 改参照表。 |
| `muse_reference_entries` | **保留** | 外部对照组；有样本偏差，不能当唯一真值。 |
| `observation_events`/`service_heartbeats`/`ledger_observation_start` | **保留并强化** | 用来区分“没有决策”和“系统没在看/源断了”。 |
| `decision_ledger_payloads` | **保留** | 第 11 条追溯需要模型输入/输出原文；只存加密引用，不搬进统计表。 |

#### 写入点

1. **邮件检查**：保留现有 `proactive` 检查行；对每封 `act/know/check/ignore` 邮件追加 `proactive_email` 账本行；`skipped` 只进 `proactive_processed_messages` 并标 `eligible=0`，不进分母。推送发送写 `delivered/suppressed/expired/failed` 事件。
2. **记忆/整理**：现有写入点加 `context_id`；评分变化写 `rated_*` 事件，同时更新账本最新值（同一事务）。
3. **感知抽取**：`proposed/not_proposed` 的 `subject_ref` 改为真实 `owner_proposals.id`；如果提议箱没有对应行，记 `blocked`/`failed`，不能写 `proposed`。`proposals` 端口必须真正接上。
4. **想一想**：`ProductionThinkWorker` 结算时写 `think` 账本行，存 `worth` 置信度、阈值上下文、`proposalId`。不要只写 `think_inbox.status`。
5. **提议箱**：每次状态/执行状态变化写事件；卡片第一次渲染写 `shown` 事件并更新 `first_shown_at`；接受/拒绝/过期/撤回/执行/撤销都留事件。
6. **日报**：每次抽样写 `review_batches`；展示/评分写 `shown`/`rated_*` 事件。
7. **配置/模型/提示词变化**：写新的 `decision_contexts`，并在 `observation_events` 记 `settings_changed/model_changed/prompt_changed`，趋势图上标竖线。

### 3.3 怎样从这些数据算出结论

#### 指标定义（沿用并补齐现有口径）

对每个 `kind` × 分层（category/source/arm/channel/context）：

- `n = 窗口内 eligible 且已评价的决策条数`
- 命中率 `hit = useful / n`
- 误扰率 `disturbance = unneeded / n`
- 已审漏报率 `reviewed_miss = missed / n`
- 只对该类型适用的评分计算（沿用 `APPLICABLE_RATINGS`：开口项用 useful/unneeded，沉默项用 useful/missed）。

同时必须报告：

- `coverage = rated / eligible`（评价覆盖率）
- `excluded`（被规则排除、不进分母的条数及原因）
- `censored`（观察期未满、推送无回报、提议未显示就过期）
- `context_mix`（各 context_id 的条数）
- `observation_health`（源断线、服务停机、主动提醒关闭的时段）

#### 趋势判断

1. **按决策时间归周，不按评价时间归周。** 主人晚几天评分，仍算回那次决策；报告写 `as_of`。旧快照不重写，当前视图可重算。
2. **小样本先用 Wilson 区间，不比较点估计。** 沿用现有规则：区间重叠写“分不出差别”，n < 最小样本数写“样本不足”。新增可配置的“最小有意义差异” `minimumEffect`（例如 5 个百分点），避免 1–2 个点的统计显著被当成产品改进。
3. **能配对就配对。** 改门槛时，用同一批已评价决策做反事实回放（现有 `replay`/`suggestThreshold`，`packages/calibration/src/thresholds.ts:350-412`）。这比“这周 vs 上周”强得多，因为同一封邮件、同一条记忆在两种门槛下的结果可以直接比较。
4. **不能配对时做分层和标准化。** 邮件类别、来源、置信度分布、沉默/开口比例可能每周不同。用固定参照分布做直接标准化（direct standardization），或至少按类别分别报告，不能把不同 mix 的总比例直接比较。
5. **“变好”的判定建议是面板，不是单一分数：**
   - 命中率区间整体高于上一窗口，或配对差区间 > 0；
   - 误扰率区间整体低于上一窗口，或配对差区间 < 0；
   - 已审漏报率没有变差（区间不高于上一窗口）；
   - 覆盖率没有下降，且没有源断线/设置变更等混杂；
   - 成本/延迟没有超出配置预算。
   四条都满足才写“变好”；否则写“不确定/样本不足/有混杂”。这比一个加权总分更难被单一指标刷高。
6. **30 天窗口和 7 天窗口都出。** 7 天用于早发现，30 天用于 Jarvis Test 第 10 条；两者都带 n 和区间。不要用 7 天的点估计去改 30 天的结论。
7. **提议/思考单独算：**
   - 提议：`accepted / shown`、`rejected / shown`、`expired_before_shown / proposed`、`executed_succeeded / accepted`、`undone / executed`。
   - 想一想：`proposed / worth_yes`、`accepted / proposal_shown`；`worth_no` 的假阴性需要抽样复核，不能直接从“没提议”推出来。
8. **行为信号只作辅助。** 点开/划掉/回复/接受是弱信号；苹果端没有回报时是 `unknown`，不能算负例。行为信号和主人评分分开展示，不混进命中率。

#### 小样本的具体防错

- **预注册口径**：把指标定义、窗口、最小样本、最小效应、排除规则、观察期写进 `metric_version`，并显示在报告页。改口径必须升版本，跨版本不拼趋势。
- **覆盖不足就不下结论**：如果沉默项的评价覆盖率低于配置目标（例如 20%），即使命中率很高，也只能写“只看已审样本”。
- **主动抽样沉默项**：日报已有 `silentShare` 机制（`daily-review.ts:84-101`），把它变成可配置的“每天至少看 N 条沉默/丢弃/不提议”，这是唯一能估“已审漏报率”的办法。
- **用固定回归集补足时间序列**：从历史决策中挑 30–50 条主人已明确评过、覆盖正反例的案例，做成固定回归集。每次模型/提示词/阈值变化前后跑同一批。这个后续步骤会新增模型调用，需 Andy 批准；按每条约 3k 输入 token、低价模型估算，一轮大约不到 0.1 美元（需实测确认）。
- **读案例，不只读数字**：Anthropic 明确说“read the transcripts”；每周抽 3–5 条“误扰/漏报/提议被拒”案例，人工看原因。数字告诉你有没有变，案例告诉你为什么变。
- **延迟/删失按生存分析处理**：推送发出后 24 小时没点开，不要直接记 0；记 `unknown/censored`，并报告观察窗口。提议未显示就过期，单独记 `expired_before_shown`，不计入拒绝率。

---

## 4. 考虑过但不选的做法

| 做法 | 为什么不选 |
|---|---|
| **新建一张 `proactive_analytics` 平行账本** | 违反“不建平行账本”；会复制 ID、状态和事务，天然漂移。I-73 就是只改一端造成的。 |
| **只扩 `web_push_feedback` 和 `owner_rating`** | 覆盖不了记忆、整理、思考、提议、沉默项；也无法记录模型/提示词/设置版本。 |
| **现在就用 LLM 当裁判补沉默项** | 新增模型调用需要批准；未和主人评分校准前不能当真值。可以作为后续步骤，但不能作为本方案的第一步。 |
| **把所有决策压成一个“Jarvis 分数”** | 会把命中率、误扰率、漏报率、成本混在一起，无法看出 trade-off，也容易被单一指标刷高。产品愿景要求三个数分开。 |
| **直接比较每周点估计** | 单用户、小样本、类别 mix 会变；点估计的“上升/下降”多半是噪声。必须区间 + 配对 + 分层。 |
| **把“没点开/没回复”当成负例** | 苹果端不回报，网页端也可能只是没看到；这是 ADR 0102 已承认的偏差。只能作弱信号或删失数据。 |
| **用关键词/正则从主人的话里推断满意** | 违反 `.claude/rules/owner-standing-rules.md` 的“理解用户意思交给模型，不写词表”。本方案只用主人显式评分和行为事件。 |
| **把提议状态历史放进一张新表** | 现有 `decision_signals` 已经是事件表骨架；再加一张会重复。直接扩信号参照表即可。 |
| **把 `think_inbox` 当统计源** | 它是队列，会过期/清理，7 天后思考对话还会删；必须落永久账本。 |
| **保留 `proactive_processed_messages` 的“只记第一次”** | 同一封邮件后来再判断时历史会丢；无法回答“每一次判断”。必须追加 `proactive_email` 账本行。 |

---

## 5. 风险与反例

1. **源断线被误读成“变好”。** 反例：Gmail 断了 20 天，主动检查为 0，误扰率当然是 0，但这不是变好。防法：报告 `observation_health`，源断线时段不计入分母；趋势图标注停摆区间。
2. **只评开口项，漏报率永远看不见。** 反例：模型越来越保守，开口少，主人只评开口项，命中率高、误扰低，但沉默里的漏报完全没测。防法：`review_batches` 记录覆盖；强制抽沉默项；覆盖不足写“不能下结论”。
3. **评价标准漂移。** 反例：主人这周比上周更宽容，命中率上升其实来自评分标准。防法：`rating_definition_version`；固定回归集定期重评；跨版本不拼趋势。
4. **提议“接受率”被未显示项污染。** 反例：大量提议在主人看到前就过期，接受率反而看起来高，因为分母只剩看到的。防法：分母用 `shown`，`expired_before_shown` 单列。
5. **推送渠道偏差。** 反例：网页推送点开率 30%，苹果端没有回报，合并后整体点开率被拉低。防法：按 `channel` 分开；苹果没回报记 `unknown`。
6. **门槛变松，命中率上升但主人更烦。** 反例：降低开口门槛，命中率上升、误扰也上升。防法：面板判定，不允许只看命中率；误扰率必须不升。
7. **上下文版本每次重启都变。** 反例：`service_revision` 进了 digest，每次部署都新建 context，趋势被切碎。防法：digest 只含影响决策的配置；service revision 只作元数据。
8. **同一封邮件被重复计数。** 反例：检查层一行 + 邮件层一行 + 推送一行，命中率分母变成三倍。防法：明确 `decision_unit`；报表只从一个视图取数；测试检查层和邮件层不混算。
9. **I-73 重演：新值只在产生端合法。** 反例：新 `signal='accepted'` 写进库，但网关契约、数据导出 schema、导入校验还只认 `opened/undone/replied`，客户端或导出直接失败。防法：所有枚举走参照表 + 跨层契约测试（见第 7 节）。
10. **提案 ID 对不上。** 反例：感知抽取把 `episode.id` 当 `subjectRef`，提议箱用 `owner_proposals.id`，两边永远 join 不上。防法：`owner_proposals.generation_decision_id` 外键 + 集成测试；没有对应提议箱行就不写 `proposed`。
11. **晚到的评分改写历史。** 反例：主人两周后补评，旧的周报数字变了，无法解释当时为什么说“变好”。防法：按决策时间归周；快照冻结；报告写 `as_of`。
12. **隐私/导出遗漏。** 反例：新表 `decision_contexts` 里的 `settings_json` 含密钥或敏感配置，被导出。防法：只存配置值/引用，不存密钥；数据导出 schema 显式列出新表；导出测试覆盖新增列。

---

## 6. 需要人拍板的取舍

1. **邮件评估单位：** 我建议“每封邮件的一次判断”作为主单位，检查层只做运营汇总。代价是要新增 `proactive_email` 账本行，历史数据要迁一次。是否同意？
2. **是否把邮件判断合并进 `decision_ledger`：** 我建议合并；如果更想少改表，也可以保留 `proactive_processed_messages` 作主表，但它必须改成追加式，不能再 `DO NOTHING`。选哪个？
3. **“变好”的判定规则：** 我建议“命中率升 + 误扰率降 + 漏报率不升 + 覆盖不降 + 无混杂”四条同时满足；如果主人更想要“漏一条按多扰 N 次算”的成本加权，也可以，但必须固定 N 并显示。
4. **最小样本/最小效应/窗口：** 默认沿用 n≥5、Wilson 95%；新增 `minimumEffect`（建议 5 个百分点）、7/30 天窗口、沉默项覆盖率目标（建议 20%）、推送观察期（建议 24–72 小时）。这些都要可配置并显示。是否同意这些默认值？
5. **评价历史：** 我建议每次改评都写事件，保留历史；代价是写入多一点。是否接受？
6. **后续模型调用：** 固定回归集（30–50 条，每轮约不到 0.1 美元）和沉默项抽样预审（每天 1–2 条，成本更低）都要 Andy 批准。是否现在批准做后续方案？
7. **数据导出/保留：** 新表是否进数据导出？`decision_contexts` 和 `decision_events` 建议进；`review_batches` 可只进产品库、不进导出。思考对话 7 天删除后，账本要保留摘要/理由引用；是否同意？

---

## 7. 必答问题

### 问题 1：这个改动会不会改变模型已经见过的请求开头？

**不会。** 本方案只改产品库的表、写入点和统计查询，不改系统提示、工具定义、历史消息、资料块、遮盖规则，也不新增对话内的模型调用。发给模型的内容仍然只在末尾追加；每轮会变的时间、记忆、资料仍然只在最后一条消息里。依据是 `.agents/instructions/prompt-prefix.md#rules` 第 1–4 条：“固定的在前，会变的在后”“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”。

需要特别说明两点：

- `decision_contexts` 里会存 `prompt_digest`，但它**只用于分析，不会被拼进模型请求**。如果以后有人想把“评估上下文”塞进系统提示，那就违反了规则，必须拒绝。
- 后续如果加“固定回归集”或“沉默项预审”的模型调用，那是**独立的后台调用**，不是主对话：固定指令在前、本次案例数据在后、当前时间最后；不会插入或改写主对话历史。依据第 15 条：“后台调用也是固定的在前、会变的在后。”

### 问题 2：这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会改变发给模型的字节。** 本方案不碰出口遮盖、不重排历史、不把数据库里的 JSON 直接拼进提示词。数据库里新增的 `settings_digest`、`context_id`、事件时间等都不是模型请求的一部分。

为了以后不埋雷，建议：

- 计算 `contexts.digest` 时用**规范 JSON（键排序、数组按固定规则排序）**，并且不把时间、随机 ID、service revision 放进 digest；否则同样的设置会得到不同 digest，趋势会被切碎。
- 将来如果做评估用的后台提示词，所有列表（案例、记忆、信号）排序固定，时间只放最后；不要在开头放“当前时间/本次案例数”这类每轮变化的值。依据第 10 条：“同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序都要固定。”
- 遮盖逻辑完全不变；已存的历史消息仍然是遮盖前的原文，发送时按原规则重新遮盖。依据第 5、11 条。

### 问题 3：改动有没有对应的自动检查，反向用例是否真的会失败？

有。建议分四层，每层都带反向用例：

**A. 数据库契约/迁移测试**

- 插入未知 `kind`/`outcome`/`reason_code`/`signal` 必须失败（参照表 + 触发器）。
- 删除/修改仍被使用的参照行必须失败（现有 `decision_ledger_kinds_in_use_no_delete` 等，`20261114110331...:375-391`）。
- 同一 `(decision_id, signal, source_ref)` 重复写只保留一条；修改/删除事件必须失败（现有不可变触发器）。
- `owner_proposals.generation_decision_id` 不存在的行必须失败；`first_shown_at` 早于 `proposed_at` 或晚于 `decided_at` 必须失败；重复设置 `first_shown_at` 必须失败。
- `proactive_email` 的 `subject_ref` 必须是真实的邮件编号；`skipped` 不得写成沉默决策；同一检查同一邮件不得重复计数。

**B. 统计口径测试**

- n < 最小样本数 → 输出“样本不足”，不输出 0%。
- 两个窗口区间重叠 → 输出“区间跨 0，分不出差别”，不输出“变好/变坏”。
- 未评价的决策不计入分母；被排除的 `skipped` 不计入分母；`expired_before_shown` 不计入提议拒绝率。
- 苹果推送没有 `opened` 事件 → 记 `unknown/censored`，不算“没点开”的负例。
- 去掉“只看已审样本”的过滤，测试必须失败；把未评当好评，测试必须失败；把 `skipped` 当沉默，测试必须失败。
- 门槛回放：同一批已评价样本，新旧门槛的命中/误扰与手算一致；配对差区间跨 0 时不写方向。

**C. 跨层契约测试（I-73 重点）**

- 新 `signal` 值必须同时被：SQLite 触发器、应用层 `DecisionSignalKind`、网关契约 `contracts-v2.ts:1895`、数据导出 schema `data-export/schemas.ts:497`、导入校验、文件导出/导入 round-trip 接受。
- 新 `kind/outcome` 必须同时被：`DECISION_KINDS`/`DECISION_OUTCOMES`、`validateLedgerWrite`、`calibrationGroup`、`daily-review` 的 `ledgerGroup`、UI 标签、数据导出 schema 接受。
- `model_ref` 必须用 `modelRefString`（允许斜杠），不能用只允许 `._:-` 的 `machineString`；测试要拿“带斜杠和冒号的模型引用”过两个契约包。I-73 的原话是“双模型复核只看了改动，没问「清单里的 id 能通过后端校验吗」”，所以这个反向用例必须有：把一个带斜杠的 `model_ref` 写进 `decision_contexts`，如果导出/导入或 UI 契约拒绝，测试失败。
- 感知抽取生成的 `proposal id` 必须能被 `owner_proposals` 接受；测试直接断言“账本 `proposed` 行的 `subject_ref` 在 `owner_proposals` 中存在”，不存在的反向用例必须失败。

**D. 不回归请求前缀**

- `npm run check:prompt-prefix` 必须仍然通过；本方案不应新增任何对话请求用例。
- 如果以后加后台评估调用，单独加 `[I-66]` 结构测试：固定指令在前、案例数据在后、当前时间最后；把时间放进开头、把案例插到中间的反向用例必须失败。

**哪些反向用例必须真的失败：**

- 删掉参照表触发器，未知 kind 能插入 → 测试失败。
- 删掉事件唯一索引，重复 shown 产生两行 → 测试失败。
- 把 `unrated` 当 `useful` 计入命中 → 测试失败。
- 把 `proactive_processed_messages` 的 `skipped` 当沉默 → 测试失败。
- 把苹果端无回报当“没点开”负例 → 测试失败。
- 把 `episode.id` 当提议 `subject_ref` → 集成测试失败。
- 新 signal 只在 SQLite 接受、网关/导出不接受 → 跨层测试失败。

### 问题 4：每个新值/改动的两端核对

下表按 I-73 的要求，逐个列“谁产生、谁使用、两端怎么校验”。**未核实**的地方单独标出。

| 值 | 产生它的地方 | 使用它的地方 | 两端校验 |
|---|---|---|---|
| `decision_ledger.kind` 新值 `proactive_email`/`think` | 邮件检查服务、`ProductionThinkWorker`；参照表迁移 | 参照表触发器、`validateLedgerWrite`、`calibrationGroup`、`daily-review`、UI、数据导出 | 产生端走 `DECISION_KINDS` + 参照表；消费端必须同时更新 `calibrationGroup`（`packages/calibration/src/index.ts:274-292`）、`daily-review.ts:257-266`、`data-export/schemas.ts:488` 等；加一条“所有 kind 都能被所有消费端接受”的测试。 |
| `decision_ledger.outcome` 新值 `act/know/check/ignore`、`proposed/skipped/failed` | 同上；参照表 `decision_ledger_outcomes` | 同上；`DECISION_OUTCOMES` 类型、`thresholds.ts` 的 `positiveOutcomes/gatedReasons`、UI 标签 | 产生端 `validateLedgerWrite` 只接受该 kind 的 outcome（`sqlite-decision-ledger-operations.ts:55-133`）；消费端 `calibrationGroup` 和 `ungatedKinds` 必须能处理；加“错误 kind+outcome 组合被拒”的反向测试。 |
| `reason_code` 新值（如 `worth_no`、`worth_unsure`、`proposal_written`、`expired_before_shown`） | 邮件/记忆/整理/思考/提议写入点 | `thresholds.ts:36-66` 的 `gatedReasons/ambiguousReasons`；日报/周报分组；案例归因 | 新增 `decision_reason_codes` 参照表；产生端写库前查表，消费端读取时若未知就报“未知原因”而不是静默少样本；加“未知 reason 被拒”的反向测试。 |
| `decision_signals.signal` 新值 `delivered/shown/accepted/rejected/expired/executed/failed/undone/rated_*` | 推送服务（`sqlite-web-push-operations.ts:679-689`）、提议服务、评分命令、日报 | `calibration` 的 `signals` 查询（`packages/calibration/src/index.ts:673-685`）、网关契约（`contracts-v2.ts:1895`）、数据导出 schema（`data-export/schemas.ts:497`）、导入、UI | 参照表 + 触发器；应用层 `DECISION_SIGNALS` 扩为参照表驱动；网关/导出/导入全部同步；加跨层 round-trip 测试。现在这四处是硬编码，**只改一处必坏**。 |
| `decision_signals.channel/surface` | 网页推送、苹果推送、App 提议卡、日报 | 报表按渠道/界面分组；推送回退 | 参照表校验；未知 channel 拒收；苹果 `apns` 必须能写，不能再被 `(source_key)` 主键合并。 |
| `decision_contexts.model_ref` | 每个决策写入点 | 账本外键、报表、导出 | 产生端和消费端都用 `modelRefString`（允许 `/`、`:`）；I-73 的斜杠模型引用用例必须过两个契约包。**未核实**：是否所有模型引用都走同一个校验入口，需逐个查。 |
| `decision_contexts.prompt_id/prompt_digest` | 后台调用用 prompt-catalog；对话内用 `thread_prompt_bundles` | 账本、报表、导出 | prompt id 长度 1–128；digest 64 位十六进制；对话内引用 `system_prompt_sha256/tools_sha256`；加“改一个 prompt 字节 digest 必变、同 prompt 必同 digest”的测试。 |
| `decision_contexts.settings_digest/settings_json` | 启动/配置变化时生成 | 账本、报表 | 规范 JSON + 排序；不含时间/随机值/密钥；加“同一配置两次生成同 digest、改一个阈值 digest 变”的测试。 |
| `decision_ledger.context_id` | 所有决策写入 | 账本读取、报表、导出 | 外键 + 非空（历史行 legacy）；写入前必须存在；加“未知 context_id 被拒”的反向测试。 |
| `owner_proposals.generation_decision_id` | 所有提议来源 | 账本 join、报表 | 外键 + 唯一索引；`owner_proposals` 插入时若没有对应生成账本行必须失败；感知抽取的 `proposed` 行必须指向真实提议 id。**未核实**：所有提议来源（MCP/规则/提醒/任务）是否都已经写生成账本行，需要逐个查。 |
| `owner_proposals.first_shown_at/first_shown_surface` | Web/App 客户端渲染提议卡时 | 提议报表、首次显示时间 | 服务端时间/校验；不得早于 `proposed_at`；不得晚于 `decided_at`；只能写一次；未知 surface 拒收；客户端时钟偏差由服务端 clamp。**未核实**：iOS 端是否已有上报入口。 |
| `owner_proposals.status/exec_status` 新事件 | `sqlite-owner-proposal-operations.ts:295-410` | `decision_events`、报表 | 现有状态转移校验继续用；每次转移写事件；`expired` 必须标 `decided_by='system'`，不能混入拒绝率。 |
| `web_push_feedback.channel` | 网页/苹果推送 | 推送报表、回退 | 参照表；主键含 channel；苹果 `apns` 和网页 `web_push` 各一行；未知 channel 拒收。 |
| `web_push_feedback.opened_at/dismissed_at` 搬走 | 事件表 | 旧 UI/回退查询 | 如果保留列，只能由事件派生；报表不得再直接读这两列；加“事件与旧列不一致时以事件为准”的测试。 |
| `review_batches` 计数 | `daily-review.ts:103-158` | 覆盖率/偏差报表 | `sampled + hidden + notSampled` 与 pool 一致；`shown ⊆ pool`；同一 day/kind/seed 唯一；加“计数对不上被拒”的反向测试。 |
| `confidence_permille`（想一想） | `ThinkWorthPort` 返回的 confidence | `thresholds.ts` 门槛曲线、报表 | 0–1000 整数；产生端写前校验；消费端 `gateSamples` 已有 missingScore 分支（`thresholds.ts:223-232`）；加“超范围被拒”的反向测试。 |
| 配置键（窗口、最小样本、最小效应、观察期、沉默抽样比例） | 配置/设置界面 | 报表/日报/推送 | 启动时范围校验；界面显示当前值；未知键拒绝启动；不能写死在代码里。 |
| 数据导出 schema 新表/新列 | 迁移 | 导出/导入/校验 | 导出 schema、导入、verify 三处同步；round-trip 逐列一致；加“少一列/多一列/未知枚举整份拒绝”的反向测试。 |

**I-73 的教训直接适用：** 不要只核对“写入端能写”，还要核对“清单/导出/网关/后端校验能不能接受”。例如 `model_ref` 带斜杠、`signal='accepted'`、`proposal id` 跨表、`first_shown_at` 的时间格式，都属于“产生端合法、消费端不认”的高风险点。

---

## 8. 未核实 / 需要现场确认

1. **感知抽取的提议是否真的没有进提议箱。** 我读到 `production-perception-extraction.ts:85` 的 `proposals` 是可选的，`service-main.ts:2502-2549` 构造时没传；但可能还有别的装配点或后续 PR。**未核实**所有装配点。
2. **iOS 端是否能上报“提议卡第一次显示”。** 现状说没有记录；客户端是否有可用的上报通道，**未核实**。
3. **苹果推送的送达/点开回报能力。** 用户材料说苹果 App 不回报；`ClientCapabilities.swift` 未读。按“不回报”设计，但**未核实**具体能力边界。
4. **`decision_prereviews` 在生产里覆盖哪些组。** 代码存在，实际是否每周都跑、覆盖哪些 kind，**未核实**。
5. **网关/数据导出对新增枚举的完整清单。** 我确认了 `contracts-v2.ts:1895`、`data-export/schemas.ts:497`、`data-export/snapshot.ts`、`import.ts` 等位置，但没有逐行穷举所有消费端；实施时要按 I-73 做全量搜索。
6. **后续固定回归集/预审模型的实际费用。** 按现有低价模型和约 3k 输入 token/条估算，30–50 条约不到 0.1 美元/轮；这是估算，**未实测**，需 Andy 批准后跑小批量确认。
