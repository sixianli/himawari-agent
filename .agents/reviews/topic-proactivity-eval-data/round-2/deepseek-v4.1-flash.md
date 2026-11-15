## 结论

方向是对的：一次判断一行、后续事件挂在判断上、用版本区分“哪一版模型/提示词/门槛”，和 OPA 决策日志（每条决策带 `decision_id`、`bundles[_].revision`）是同一种思路（https://www.openpolicyagent.org/docs/management-decision-logs）。但这份方案现在不能直接实施：有 3 处会丢数据或改坏现有生产行为，另有多处“值只在产生端成立、使用端不接受”的 I-73 类问题，而且完全没有自动门槛和抽样设计。

下面先列证实的发现，再列推测/未核实，然后是按你要求的侧重检查、我的改法、逐条回答必答问题。

---

## 证实的（按严重度）

### 1. 严重：重建 `decision_ledger` 没有保留子表，照字面 `DROP` 会级联删掉大量数据

**问题**：方案只写“重建 `decision_ledger` 一次，做这些改动”，没有写保留现有子表、触发器和索引。当前 `decision_ledger` 被 7 张表引用，其中 `source_insights`、`proactive_processed_messages`、`decision_prereviews`、`decision_ledger_payloads`、`decision_signals` 都是 `ON DELETE CASCADE`。SQLite 官方说明：外键开启时 `DROP TABLE` 会先做隐式 `DELETE`，可能触发外键动作或约束错误（https://www.sqlite.org/foreignkeys.html#fk_schemacommands）。如果直接 `DROP TABLE decision_ledger`，可能把信号、已处理邮件、source insight、预评记录和模型输入输出关联一起删掉；`proactive_push_backoff.step_decision_id`、`muse_reference_entries.paired_decision_id` 会被置空。

**证据**：
- `packages/persistence-sqlite/src/migrations/20261114110331_decision_ledger_reference_tables.sql:48-64` 的既有做法是先建 `*_keep` 表、先删子表再删父表；方案没有沿用这个模式。
- 子表外键：同文件 `120-166`（`source_insights`）、`151-166`（`proactive_processed_messages`）、`187-228`（`decision_signals`）、`174-180`（`decision_ledger_payloads`）；`20261114172143_proactive_source_registry.sql:278-294`（`proactive_push_backoff`）。
- SQLite 原文：“If foreign keys are enabled when it is prepared, the DROP TABLE command performs an implicit DELETE … may invoke foreign key actions or constraint violations.”

**建议**：不要做裸 `DROP`。按现有 `*_keep` 模式一次性重建，保留全部子表数据、触发器和索引；迁移契约测试必须比较迁移前后 `dump`、`foreign_key_check`、每张子表行数，并加一条反向用例：故意先 `DROP decision_ledger`，检查必须报出子表行丢失。

---

### 2. 严重：`content_ref` 指向 think 摘要载荷，和现有摘要清理、`RESTRICT` 外键直接冲突

**问题**：方案说 `content_ref` 指向 `think_inbox` 的摘要载荷。但 `think_inbox.maintain()` 会在条目结算后主动删除摘要 payload；`decision_ledger.content_ref` 是 `ON DELETE RESTRICT`。结果是删除失败（异常被吞掉）、`clearSummary` 永远不执行，摘要 payload 和决策记录一起永久保留，形成资源与隐私泄漏。`#discardUnreferenced` 也只查 `think_inbox`，不知道决策记录已经引用它。

**证据**：
- `packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:9`：`summary_ref … ON DELETE SET NULL`。
- `packages/persistence-sqlite/src/migrations/20261114172143_proactive_source_registry.sql:38-39`：`content_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT`。
- `apps/agent-service/src/production-think-inbox.ts:268-281`：`settledSummaries()` 后直接 `payloads.delete(summaryRef)`，只有删除成功才 `clearSummary`。
- 同文件 `243-248`：只检查 `summaryReferenced()`，而它只查 `think_inbox`（`sqlite-think-inbox-operations.ts:386-395`）。

**建议**：不要把 `think_inbox.summary_ref` 直接当 `content_ref`。要么给决策记录单独存一份带分类和保留期的快照 payload，要么只存 `think_inbox` 条目 id 加输入摘要的 SHA-256，正文继续由 `think_inbox` 管理；如果确实要长期保留材料，必须把 `decision_ledger` 纳入保留策略和引用检查，并加测试：结算后执行 `maintain()`，既有决策记录仍可读、摘要按策略删除且不报错。

---

### 3. 严重：删掉 `web_push_feedback.opened_at/dismissed_at` 会改坏退避和提醒页，不只是评估

**问题**：方案把这两个列当成“评估事实”搬去事件表，但现有业务逻辑直接依赖它们：

- 推送退避 `countIgnoredPushes` 用 `feedback.opened_at` 判断“这条推送被点开过”，从而决定是否升级抑制。
- 提醒页 `proactive-overview` 用 `openedAt/dismissedAt` 算“点开/划掉”状态和命中/误扰。
- `listFeedback`、`WebPushFeedback` 类型、控制中心合约也读这两列。

**证据**：
- `packages/persistence-sqlite/src/proactive-push-backoff.ts:47,65`：`feedback.opened_at AS openedAt`，`push.opened ||= row.openedAt !== null`。
- `packages/application/src/services/proactive-overview.ts:145-148`、`255-286`：用 `openedAt` / `dismissedAt` 算 `reaction`、`hits`、`misfires`。
- `packages/persistence-sqlite/src/sqlite-web-push-operations.ts:642-648`、`695-707`：更新和读取这两列。
- `packages/application/src/ports/web-push.ts:72-73`、`packages/application/src/ports/durability.ts:27`：类型仍要求这两个字段。

**建议**：先把打开/划掉迁到正式事件表，并同步改 `countIgnoredPushes`、`proactive-overview`、`listFeedback`、类型和合约；或者保留两列作为“推送流程状态”，另外从事件表读评估事实。无论选哪种，都必须加退避回归测试（点开后不再抑制）和提醒页回归测试。

---

### 4. 高：从参照表删除 `proposal` 的旧结果值会被触发器拦住，旧数据和导出也会失败

**问题**：方案要把 `accepted`、`dismissed`、`expired`、`executed`、`failed`、`undone`、`superseded` 从 `decision_ledger_outcomes` 删除，但表上有触发器：只要还有 `decision_ledger` 行使用该 `(kind, outcome)`，删除就 `RAISE(ABORT)`。现有契约测试还要求参照表与代码里的 `DECISION_OUTCOMES` 完全一致。

**证据**：
- `packages/persistence-sqlite/src/migrations/20261114110331_decision_ledger_reference_tables.sql:380-382`：`decision_ledger_outcomes_in_use_no_delete`。
- `packages/persistence-sqlite/test/decision-ledger-reference-tables.contract.test.ts:191-205`：参照表必须等于代码里的 kinds/outcomes。
- 同文件 `277-290`：反向用例明确要求删除仍在使用的 outcome 失败。

**建议**：先迁移/改写旧行（或把旧 outcome 标记为 `legacy_*`），再删除参照行；同时更新 `DECISION_OUTCOMES`、契约测试和导出/导入。更稳妥的做法是“保留但标记弃用”，不要物理删除，避免旧备份导入失败。

---

### 5. 高：`origin`、`version_id`、`decision_versions` 没有覆盖数据导出/导入和旧行

**问题**：新增字段和新表只写了写入端，没有写便携导出/导入。当前导出/导入的列和信号枚举是硬编码的；不更新会丢字段，旧备份导入新库还会因 `version_id` 外键或新列约束失败。ADR 0200 的“可搬走”也要求导出包含这些评估事实。

**证据**：
- `packages/persistence-sqlite/src/data-export/snapshot.ts:246-257`：`decision_ledger` 和 `decision_signals` 的 SELECT 列是写死的。
- `packages/persistence-sqlite/src/data-export/schemas.ts:470-504`：字段列表和 `signal` 枚举写死。
- `packages/persistence-sqlite/src/data-export/export.ts:553-573`：导出对象逐个字段构造。
- `packages/persistence-sqlite/src/data-export/import.ts:730`：INSERT 列写死。

**建议**：把 `origin`、`version_id`、`decision_versions`、新信号枚举一起纳入 export schema、snapshot、export、verify、import；schema 升版；加旧备份导入测试（旧文件没有新字段时能导入，新字段为 NULL/sentinel）和往返测试（导出再导入逐字段一致）。

---

### 6. 高：“所有写决策记录的地方都带 `version_id`”对数据库触发器写入的行不成立

**问题**：`rule_review`、`memory_review` 等记录由数据库触发器直接写表，触发器不知道模型、提示词、门槛；`context_truncation`、`retrieval_degrade`、`external_read`、`web_push`、`limit_change` 等也不是模型判断，没有“实际作答模型”。方案一句“所有写决策记录的地方都带上”无法落地，且没有定义旧行如何回填。

**证据**：
- `docs/execution/specs/2026-11-09-decision-record-write-convention.md:26`：`rule_review`、`memory_review` 由触发器/专用写入器写。
- `packages/application/src/ports/decision-ledger.ts:32-46`：`DECISION_KINDS` 有 13 种，远多于模型门槛判断。
- `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:135-185`：通用 `insertLedgerRow` 也不知道版本。

**建议**：明确 `version_id` 只对“模型门槛判断”必填；其余种类允许 NULL 或指向 `version:none`；旧行统一回填 sentinel。触发器和非模型写入器不得被强制提供无法取得的值。加约束测试：模型门槛种类缺版本必须失败，非模型种类允许 NULL。

---

### 7. 高：邮件模型没有“把握分数”，方案却要记分数并用它回放门槛

**问题**：方案说“邮件判断的分数都记进来”，并说“改门槛时可以直接用历史记录算”。但邮件判断的 `confidence` 只有 `sure | unsure` 两个值，不是 0–1000 的分数。要得到分数必须改模型输出/提示词，这违反方案自己写的“不改任何发给模型的内容，不新增模型调用”，也会改变请求内容。

**证据**：
- `packages/application/src/ports/proactive-checks.ts:11`：`export type ProactiveConfidence = "sure" | "unsure";`
- `packages/application/src/services/proactive-mail-check-service.ts:589-595`：只接受 `sure`/`unsure`。
- `packages/application/src/services/proactive-mail-check-service.ts:255-261`：`Judgement.confidence` 是该枚举。

**建议**：二选一：
1. 不改模型，就把 `sure/unsure` 映射成明确的离散档位（例如 1000/0），但不要假装它是连续分数，也不要拿它做单阈值回放；或
2. 另立方案改邮件模型输出为概率分数，并明确这会改变请求（需要 Q1 的审批和新检查）。
无论哪种，`confidence_permille` 对邮件不能直接复用现成值。

---

### 8. 高：信号极性/定义与现行 ADR 0102/0154/0155 冲突，会改变“命中/误扰/漏报”的含义

**问题**：方案把 `dismissed` 定为 neutral、`withdrawn` neutral、`execution_failed` negative、`replied` positive，并重新定义准确率/漏报率。现有 ADR 0102 的“误扰”定义包含“划掉且没点开、没回复；或 24 小时内没有任何反应”；ADR 0154 的三项指标共用同一分母；ADR 0155 明确不用“误扰/漏报”做界面词。方案没有说明是取代旧定义还是并行，直接改会让历史数据和新数据不可比。

**证据**：
- `docs/adr/0102-record-push-notification-feedback.md:75`：“误扰：划掉且没点开、没回复；或 24 小时内没有任何反应。”
- `docs/adr/0154-weekly-calibration-report-and-muse-mail-pairing.md:35`：命中率/误扰率/已审漏报率共用分母 `n`。
- `docs/adr/0155-decision-record-observation-and-weekly-report-page.md:32`：明说不用“命中率、误扰率、已审漏报率”，词表禁用“误扰”“漏报”。

**建议**：先把指标定义版本化（`metric_definition_version`），新定义与旧定义并存；`dismissed` 至少应作为“负面行为”或明确说明为什么 neutral；`execution_failed` 是系统可靠性，不应算模型判断错误；`replied` 不能无条件当 positive。历史报告保留原定义，不静默重算。

---

### 9. 高：“delivered = 推送送达设备”不成立

**问题**：`web_push_feedback` 是在推送服务返回 `sent` 时写入的，不等于设备收到，更不等于到主人眼前。APNs 官方明确说是 best-effort，可能节流、存储、甚至不送达，也不提供设备送达回执。把它叫 `delivered` 会让“覆盖率/露出量”系统性偏高。

**证据**：
- `packages/persistence-sqlite/src/sqlite-web-push-operations.ts:609-621`：`if (recorded && input.status === "sent")` 才写 `web_push_feedback`。
- `packages/calibration/src/index.ts:655-661`：现有统计直接用 `EXISTS (SELECT 1 FROM web_push_feedback …)` 当作 `delivered`。
- Apple 原文：“As a best-effort service … may … get throttled, saved in storage, and in some cases, not delivered.”（https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns）

**建议**：改名为 `sent_to_push_service`；`shown`/`opened` 由客户端回报，并标注“客户端自报、不可作为真值”；真正的“到眼前”只能由 App 卡片 `shown` 或通知前台展示事件近似。不要把 `web_push_feedback` 的存在当作送达。

---

### 10. 高：定向抽样 + 用区间重叠判断趋势，结论会错

**问题**：
- 抽样优先级是“先抽露出了但没有明说事件的开口，和把握分数靠近门槛的沉默；已有明说事件的不抽”。这是有意偏置的分层抽样。直接拿抽样里的“漏了的沉默 / 抽查过的沉默”当总体漏报率，会高估靠近门槛的沉默、低估已明说事件的沉默。需要记录抽样层和权重，做加权估计，或同时保留随机抽查。
- “区间不重叠才说变好/变坏”不是两样本差异检验；两个 Wilson 区间重叠与否和“差异是否显著”不是一回事。现有校准代码已经用配对差区间（Newcombe 方法）解决同类问题。

**证据**：
- `packages/calibration/src/index.ts:302-331`：`summarizeDecisions` 直接 `rated` 计数除以样本数，没有抽样权重。
- `packages/calibration/src/index.ts:438-481`：已有的 `pairedDifferenceInterval` 是差区间，不是拿两个区间是否重叠判断。
- 方案原文：“先抽……靠近门槛的沉默；已经有明说事件的不抽”“区间不重叠才说变好或变坏”。

**建议**：记录 `sampling_stratum`、`sampling_weight`、`selected_at`；漏报率用加权估计或按层报告；趋势用两比例差区间/配对差区间，不用区间重叠。定向抽查和随机抽查分成两个指标，不要把定向样本当总体。

---

### 11. 高：think 写入不在同一事务，且拿不到 `proposalId`、有效门槛和置信度

**问题**：
- 方案在 `settle` 处写决策，但 `settle` 先 `store.finish` 再返回；如果崩溃在 finish 之后、账本写入之前，条目已结算且不会重试，判断永久丢失。
- `ThinkRunResult` 只有 `outcome: "proposed" | "skipped"` 和 `reasonCode`，没有 `proposalId`；方案要求“写出提议时另记提议编号”，当前接口拿不到。
- `#decide` 把 `worthPermille` 交给 `judgeThinkWorth` 后只返回三态，置信度和实际生效的 `yesAtLeastPermille/noAtMostPermille` 没有返回；版本指纹和“回放门槛”需要它们。
- `content_ref` 如果指向摘要，还和上面的清理冲突；而且模型实际看到的是经过 `redactForExternalText` 的文本，摘要原文不是“她当时看到的材料”。

**证据**：
- `apps/agent-service/src/production-think-worker.ts:76-79`：`settle` 先 `store.finish`。
- `apps/agent-service/src/production-think-worker.ts:12-15`：`ThinkRunResult` 没有 proposal id。
- `apps/agent-service/src/production-think-worker.ts:129-159`：`#decide` 只返回 `judgeThinkWorth` 的三态。
- `apps/agent-service/src/production-think-runner.ts:262-272`：`#propose` 返回 `{ outcome: "proposed", reasonCode: "proposal_written" }`，没有 proposal id。
- `packages/platform-node/src/think-worth-decision.ts:25-53`：实际请求里的 `source`/`summary` 经过遮盖；`production-think-inbox.ts:268-281` 会删摘要。

**建议**：扩展 `ThinkRunResult` 返回 `proposalId`、`worthPermille`、`effectiveThresholds`；把 `think_inbox.finish` 和决策写入放进同一个事务或用一个 idempotent outbox（先写决策再 finish，失败可重试）；`content_ref` 存“实际发给模型的那一份输入快照”或只存摘要 SHA-256 + 分类，不要事后重新遮盖。

---

### 12. 高：提议箱去重漏了 perception-extraction，已有写入会重复

**问题**：方案只规定“同一个提议由想一想产生时只写一行”，但感知抽取已经会写 `proposal/proposed`，而且是在提议箱事务之外写的。如果按方案在 `sqlite-owner-proposal-operations.ts` 的创建事务里“任何来源创建提议都写一行”，同一个感知提议会出现两行。

**证据**：
- `packages/application/src/services/perception-extraction.ts:682-715`：`#ledger` 对 `proposed/not_proposed` 写 `kind: "proposal"`。
- `packages/application/src/services/perception-extraction.ts:656`：`this.#options.proposals?.receive(verified)`。
- `packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:138-255`：提议创建/刷新/重开/限额都在这里。

**建议**：让“提议创建”成为 `proposal/proposed` 的唯一写入点，删掉 perception-extraction 对 proposal 的账本写入（或改成只写 `not_proposed` 的感知侧记录）；对 `created/reopened/refreshed/limit_reached/closed` 定义清楚哪些算一次新判断，避免刷新/重开重复计数。加测试：感知提议只产生一行。

---

### 13. 高：“关掉一个主动来源已经会写 limit_change”不成立，启用/停用目前没有记录

**问题**：现有代码只为 `perDay`/`perCheck` 的变化写 `limit_change`，`enabled` 的变化不写。`limit_change` 的输入也只接受数字 `from/to`，装不下布尔型启用/停用。方案把“关掉来源”当成已有能力，是事实错误。

**证据**：
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:300-355`：只遍历 `["perDay", "perCheck"]` 写 `limit_change`，`enabled` 只更新设置。
- `packages/application/src/ports/decision-ledger.ts:178-182`：`LimitChangeInput` 只有 `key/from/to` 数字。
- `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:94-106`：要求 `from/to` 是整数且 `from !== to`。

**建议**：新增独立的 `source_toggled` 结果/种类，或在 `LimitChangeInput` 增加 `enabledFrom/enabledTo` 并同步改校验、UI、导出和参照表；不要复用数字型 `limit_change`。

---

### 14. 中：`web_push/delivered` 是“伪判断行”，且 `push_source_key` 不唯一会让事件挂错判断

**问题**：
- 送达不是判断。为了挂事件而写一行 `web_push/delivered` 决策记录，会污染 `decision_ledger` 的 kind/outcome、参照表、校准和每日复盘；还要在每个统计入口排除它。
- `push_source_key` 只有普通索引，不是唯一索引；同一个来源键可能对应多条 proactive 判断。现有 `recordReactions` 会 join 出所有匹配行并逐条写 `opened` 信号，`pushingDecisionId` 只取最早一条。方案“按 `push_source_key` 找对应判断”会继承这个问题。

**证据**：
- `packages/persistence-sqlite/src/migrations/20261114110331_decision_ledger_reference_tables.sql:111-113`：`CREATE INDEX ...`，不是 `UNIQUE`。
- `packages/persistence-sqlite/src/sqlite-web-push-operations.ts:650-657`：join 所有 `kind='proactive'` 匹配行。
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:1296-1308`：`pushingDecisionId` 取最早一条。
- 当前 `web_push` 参照表只有 `deferred`，没有 `delivered`（`packages/application/src/ports/decision-ledger.ts:74`）。

**建议**：不要用决策行表示送达。加 `notification_deliveries`/`decision_delivery_events`，或在 `decision_signals` 允许 `decision_id` 可空并明确“无判断的推送不挂决策”。每条推送生成一个不可变的 `push_id`，事件按 `push_id` 幂等；同一条推送只对应一条判断，`push_source_key` 若要继续用，至少加唯一约束或“最新判断”规则。

---

### 15. 中：append-only 没有保留/清理策略，且会撞观察期“行数不能少”检查

**问题**：方案为每次推送送达、每次 think 失败、每个信号都追加一行，没有保留期。`decision_ledger`/`decision_signals` 会持续增长。ADR 0155 的观察检查还有“已检查过的日子没有少记录”，如果以后加清理，会直接判失败，除非像清除 Gmail 记录一样登记事件。

**证据**：
- `docs/adr/0155-decision-record-observation-and-weekly-report-page.md:60`：检查“已检查过的日子没有少记录”。
- `docs/adr/0155...:50`：观察事件包含“清除 Gmail 记录（含删掉的行数）”。
- 方案的 `web_push/delivered`、`judgment_failed`、`shown/dismissed/opened` 都是高频写入。

**建议**：先定保留策略（按分类、按天数、按表），把清理写进观察事件；高频的失败/送达可以合并（每个条目/每条推送最多一行）；`content_ref` 的保留要和 payload 保留一起设计。

---

### 16. 中：客户端回报是不可信输入，方案没有认证、幂等和防重放细节

**问题**：新的统一客户端回报要接受 `shown/opened/dismissed` 和“发生的表面（App、通知、手表）”。这些是客户端自报，可能被伪造、重复、乱序、未来时间。现有 `recordReactions` 把时间钳在 `[first_sent_at, now]`，但新命令如果扩展 `surface` 和 `shown`，必须保持设备认证、字段白名单、枚举校验、事件幂等和限流。信号表是只追加、不可更新/删除的；一个伪造事件会永久污染统计。

**证据**：
- `packages/platform-node/src/device-push.ts:212-251`：现有反馈校验（tag 格式、时间、字段白名单、最多 50 条）。
- `packages/persistence-sqlite/src/sqlite-web-push-operations.ts:642-648`：时间被 `max(first_sent_at, min(?, ?))` 钳制。
- `packages/persistence-sqlite/src/migrations/20261114172143_proactive_source_registry.sql:233-240`：信号不可更新/删除。
- `packages/gateway-contracts/src/contracts-v2.ts:340-356`：现有合约只允许 `opened`/`dismissed`。

**建议**：新命令继续走设备认证和 owner/agent scope；`surface` 用枚举；客户端提供 `event_id` 做幂等（或 `tag+surface+occurred_at` 唯一）；时间钳制并拒绝过旧/过未来；限流；把客户端事件标为 `source=client`，不直接当作真值；如需纠错，写 `disputed`/`correction` 事件，不要删原事件。加反向用例：伪造 surface、重复 event、未来时间、超量请求都必须失败或被安全钳制。

---

### 17. 中：`origin` 与 `scenario` 重复，且没有可校验的来源登记

**问题**：`decision_ledger.scenario` 已经记录 proactive 的来源；方案再加 `origin`，同一事实有两个家。方案说“取值来自已有的来源登记，不写死”，但现有 `PROACTIVE_SOURCES` 只有 gmail；think 的 `sourceKind` 是任意 1–64 字符，没有持久登记表。这样 `origin` 既无外键也无枚举，拼写错误会静默进入统计。

**证据**：
- `packages/persistence-sqlite/src/migrations/20261114172143_proactive_source_registry.sql:24-27`：`scenario` 已是动态来源名。
- `packages/application/src/ports/proactive-sources.ts:176`：`PROACTIVE_SOURCES = defineProactiveSources([GMAIL_SOURCE])`，只有 gmail。
- `apps/agent-service/src/production-think-inbox.ts:86-101`：think source kind 只在内存注册，生产组合未注册任何来源。

**建议**：定义 `decision_origins(origin)` 参照表（或 `origin_kind` + `origin_ref` 两列），用 FK/触发器校验；proactive 的 origin 直接由 `scenario` 派生，不重复存。think 的 origin 用已登记的 source kind 名，未登记的值拒绝写入。加两端校验测试：未知 origin 写不进，读取端只认登记值。

---

### 18. 中：信号枚举、校准和导出都写死了，新增信号会被忽略或导出失败

**问题**：方案把信号种类改成参照表，但代码里至少还有三处硬编码：`DECISION_SIGNALS`/`DECISION_SIGNAL_KINDS`、校准的 `IMPLICIT_SIGNALS` 和 `summarizeImplicit`、导出 schema 的 signal 枚举。只改数据库参照表，新信号要么被校准静默忽略，要么导出校验失败。

**证据**：
- `packages/application/src/ports/decision-ledger.ts:20-22`。
- `packages/calibration/src/index.ts:126-134`、`584-620`：只处理 `opened/undone/replied`。
- `packages/persistence-sqlite/src/data-export/schemas.ts:493-504`：signal 枚举写死。
- `packages/persistence-sqlite/src/migrations/20261114172143_proactive_source_registry.sql:216-228`：`decision_signals.signal` CHECK 写死。

**建议**：以 `decision_signal_kinds` 为唯一来源生成 TypeScript 常量/校准映射/导出枚举，或至少让三处都从同一常量派生；加测试：新增一个信号能写入、能导出、能在校准里被明确处理（而不是静默丢弃）。

---

### 19. 中：放宽 `confidence_permille` 要同时改数据库 CHECK 和应用层校验

**问题**：方案只提“放宽 CHECK”。实际 `validateLedgerWrite` 在写库前就拒绝非 `memory_candidate` 带 `confidencePermille`；`inferred`/`category` 仍只属于记忆候选。只改表不改应用层，非记忆种类仍然写不进去。

**证据**：
- `packages/persistence-sqlite/src/migrations/20261114172143_proactive_source_registry.sql:57-60`：`kind = 'memory_candidate' OR (category IS NULL AND confidence_permille IS NULL AND inferred IS NULL)`。
- `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:115-131`：应用层同样拒绝。

**建议**：明确“所有种类可记 confidence，但 category/inferred 仍只属于 memory_candidate”；同时改表 CHECK、`validateLedgerWrite`、导出 schema 和测试（非记忆种类可写 confidence，写 category/inferred 仍失败）。

---

### 20. 中：版本指纹不确定，且把 `origin` 放进指纹会切碎版本

**问题**：`decision_versions.id` 是 JSON 指纹的 SHA-256。若 JSON 键顺序、设置映射顺序、数字格式不固定，同一配置会得到不同 id；若把 `origin` 放进指纹，同一模型/提示词/门槛换来源就会变成新版本，和“按 origin 和 version 分组”重复，版本数量膨胀。指纹还应包含 provider、工具集、数据分级、提示词实际字节摘要，否则同一模型别名路由到不同服务方会被当成同版。

**证据**：
- 方案原文：“`id` 是指纹内容的 SHA-256；指纹包含实际作答的模型、提示词编号和内容摘要、当时生效的门槛和设置值、来源名。”
- `packages/calibration/src/index.ts` 现有实现没有版本表；`packages/persistence-sqlite/src/migrations/20261114110331_decision_ledger_reference_tables.sql:287-289` 的 `decision_prereviews` 已有 `model_ref/prompt_id/text_digest` 先例。
- RFC 8785 要求确定性属性排序才能得到可重复的哈希（https://www.rfc-editor.org/rfc/rfc8785）。

**建议**：用 JCS/RFC 8785 或显式排序键；指纹排除 `origin` 和任何时间/随机值；包含 `model_ref`、`provider`、`prompt_id`、`prompt_sha256`、`settings_json`、`tools_sha256`、`data_classification`；`first_used_at` 只写一次；加测试：设置键顺序变、重启、不同进程得到同一 id；换 origin 不产生新 version。

---

### 21. 中：文档/词表/ADR 与方案不一致

**问题**：方案通篇使用“命中率、误扰率、漏报率”，而词表第 8 条把“误扰”“漏报”列为旧叫法，ADR 0155 明确不用这三个词；如果这份方案落成 ADR/规格，`npm run check:glossary` 会失败。另外 ADR 0102/0154 的指标定义会被方案改变，必须写明取代关系。

**证据**：
- `docs/glossary.md:42`（第 8 条）：旧叫法包含 `误扰`、`漏报`。
- `docs/adr/0155-decision-record-observation-and-weekly-report-page.md:32`：“不用‘命中率、误扰率、已审漏报率’”。
- `docs/adr/0102-record-push-notification-feedback.md:75`、`docs/adr/0154-weekly-calibration-report-and-muse-mail-pairing.md:35` 的旧定义。

**建议**：界面和报告按词表用“恰当的提醒/多余的提醒/漏提醒（你查过的邮件里）”；ADR/规格里如果要引用旧指标，写成“旧指标（词表旧叫法）”并说明新定义；同步更新 ADR 0102/0154/0155 的取代关系，运行 `npm run check:glossary`。

---

### 22. 中：本提交里 think 源没有在生产注册，方案会只记到 `source_unregistered`

**问题**：`productionThinkLoop` 创建 `ProductionThinkInbox` 时没有注册任何 `ThinkSource`；全仓库只有测试调用 `inbox.sources.register(...)`。如果按本提交直接上线，worker 在 `sources.get(entry.sourceKind)` 处会拿到 `undefined`，每条都 `settle("failed", "source_unregistered")`，方案记不到真正的“想一想判断”。

**证据**：
- `apps/agent-service/src/production-think-composition.ts:148-157`：创建 `inbox` 没有注册来源。
- `apps/agent-service/src/production-think-worker.ts:86-87`：`if (!source) return await settle("failed", "source_unregistered")`。
- 全仓库 `inbox.sources.register` 仅出现在 `test/integration/think-worker.test.ts:124`、`think-settings.test.ts:147`、`think-inbox.test.ts:89`。

**建议**：在依赖 think 数据之前，先把生产来源注册补齐（或确认这是另一个未合并线程的工作）。否则本方案的“想一想写一行”只能覆盖失败路径。

---

## 推测 / 未核实

1. **think 摘要在并发下被删的时序**：`maintain()` 删除摘要和 `settle` 写账本不在同一事务；如果两者并发，可能先删 payload 再写 `content_ref`，导致外键失败。代码顺序看起来是单 worker，但未读全部调度/并发配置，标为推断。
2. **生产 think 来源未注册是否只是本提交的中间状态**：grep 结果显示只有测试注册，但可能有未合并分支或运行时动态注册；需要方案作者确认。
3. **客户端 `shown` 的伪造风险**：设备认证能限制到“某个配对设备”，但无法证明“真的显示了”；如果用它算“到眼前”，仍可能被篡改。属于设计风险，不是已证实漏洞。
4. **`web_push/delivered` 每设备一行会导致行数爆炸**：取决于实现是否按 `devices` 计数还是按设备写；方案没写清，标为推断。
5. **版本指纹包含设置值会导致版本表膨胀**：取决于设置值的粒度和是否包含每次变化的动态值；方案没写清，标为推断。

---

## 侧重检查

我按你给的侧重逐项查了：

- **错误路径**：think 的 `settle` 先 finish 后写账本，崩溃会丢判断（`production-think-worker.ts:76-109`）；提议创建事务里写账本会把评估失败变成用户操作失败；推送 `recordAttempt` 里写 `web_push/delivered` 会让推送发送依赖评估写入。结论：需要 outbox/同事务/幂等三者选一并写清。
- **不合规范或不可信输入**：`origin` 来自 `sourceKind` 字符串，think 只有内存注册、生产未注册；客户端 `shown/opened/dismissed/surface` 是自报；导出/导入会读旧 outcome。结论：都要枚举/FK/白名单/幂等/时间钳制。
- **安全**：think 摘要可能含外部敏感内容，`content_ref` 长期保留且 `RESTRICT`；决策链读取需要按分类隐藏；客户端事件不可篡改但可伪造。结论：分类、保留期、设备认证、不可信标记都要补。
- **资源耗尽**：每次推送送达、每次 think 失败、每个信号都追加，且没有保留策略；`content_ref` 还会阻止 payload 清理。结论：先定保留/合并策略，再上线。
- **不可撤销操作**：裸重建 `decision_ledger`、删 `proposal` outcomes、删 `web_push_feedback` 两列、写不可更新的客户端信号，都是一次性不可逆。结论：全部要先迁移/备份/回滚方案和反向测试。
- **规则文件、说明文档和代码一致**：词表禁用“误扰/漏报”但方案在用；ADR 0102/0154/0155 的定义会被改；`decision-record-write-convention` 没列 proposal；参照表契约测试要求与代码完全一致。结论：不一致，需同步改文档和测试。

---

## 如果由我定，我会这样改

1. **不裸重建。** 优先按现有 `*_keep` 模式做一次安全重建，保留 7 张子表、全部触发器和索引；如果不想承担重建风险，就新增 1:1 的 `decision_judgment_metadata` 侧表（`decision_id` 主键、`origin`、`version_id`、`is_judgment`、`sampling_stratum`、`sampling_weight`），旧 `decision_ledger` 只加行不动结构。无论哪种，迁移契约测试必须比较 `dump`、`foreign_key_check`、子表行数。

2. **版本表独立。** `decision_versions(id PK, fingerprint_json, model_ref, provider, prompt_id, prompt_sha256, settings_json, tools_sha256, data_classification, first_used_at)`；id 用 RFC 8785 规范化后 SHA-256；排除 origin 和时间；`version_id` 对模型门槛判断必填，其余允许 `version:none`；旧行回填 sentinel；版本行不删。

3. **信号表按事件建模。** 保留 `web_push_feedback` 作为推送流程状态，新增 `decision_events`/`notification_events`（`event_id`、`push_id`、`decision_id`、`signal`、`surface`、`occurred_at`、`received_at`、`source`、`source_ref`、`detail`），客户端事件用 `event_id` 幂等；先迁 `opened_at/dismissed_at`，再改 `countIgnoredPushes`、`proactive-overview`、`listFeedback`、类型和合约。`delivered` 改名 `sent_to_push_service`，不声称“送达设备”。

4. **不要伪判断行。** 送达/展示用独立事件表；没有判断的推送不写 `decision_ledger`。如果必须统一查询，用视图 join，而不是写一行 `web_push/delivered`。

5. **think 写入原子化。** `ThinkRunResult` 返回 `proposalId`、`worthPermille`、`effectiveThresholds`；`finish` 和决策写入同事务，或先写幂等 outbox；`content_ref` 存实际发送的遮盖后输入快照（带分类/保留期）或只存 SHA-256 + `think_inbox` id；不要引用会被 `maintain()` 删除的摘要 payload。

6. **提议只写一次。** 由 `ownerProposals.propose` 成为 `proposal/proposed` 的唯一写入点；删除 perception-extraction 的 proposal 账本写入；明确 `created/reopened/refreshed/limit_reached/closed` 哪些算判断；加“同一提议只有一行”的测试。

7. **统计按抽样设计。** 记录抽样层和权重；漏报率用加权估计或分层报告；趋势用差区间（复用 `pairedDifferenceInterval`），不用区间重叠；`owner_rating` 与显式事件冲突时按“事件时间 + 来源等级”决定，或在显式事件到达时清掉旧评分；准确率/覆盖率按 `decision_id` 去重；定义版本化，历史报告不静默重算。

8. **门槛先写。** 迁移契约、参照表契约、导出/导入往返、think 一行/失败不计数、提议去重、推送事件挂载、退避回归、抽样加权、客户端输入、prompt-prefix 不受影响。每条都写“改前失败、改后通过”的反向用例。

9. **文档同步。** 更新 ADR 0143/0155、决策记录写入约定、词表；把“误扰/漏报”改成词表新名；明确新指标取代旧指标的关系。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会，按方案字面不会。** 新增的 `origin`、`version_id`、`confidence`、`decision_signals` 都只写数据库，不进入系统提示、工具定义、历史或资料块；发给模型的内容仍然只在末尾追加，每轮会变的值（时间、资料等）仍只在最后一条用户消息里。依据是 [prompt-prefix.md 第 2、4 条](../../.agents/instructions/prompt-prefix.md#rules)。

但有两个前提必须写成硬约束：

- 不能为了拿 `confidence` 改邮件模型的输出 schema（见发现 7），否则就是改请求。
- 不能把 `version_id`/`origin` 写进系统提示或工具定义；如果以后要告诉模型“你是哪一版”，只能在最后一条用户消息里追加。
- `npm run check:prompt-prefix` 只覆盖对话主请求；think 的 `/decisions` 和邮件判断是侧调用，方案应另加“同一输入两次构造请求字节相同”的测试，至少确认 `thinkWorthRequestBody` 没有因为记录版本而变。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**对模型请求：不会。** 方案不改编排、不重遮历史；`sequentialPlaceholderTag()` 也是按本次请求里敏感值出现的顺序编号，同一输入会得到同一结果（`packages/sensitive-capture/src/external.ts:60-74`）。但要注意：如果为了记录 `content_ref` 而重新遮盖或重新序列化摘要，就可能得到不同字节；只能存“实际发出去的那一份”或原文，不能事后重算。

**对数据库/评估事实：有确定性风险。** `decision_versions.id` 是 JSON 指纹的 SHA-256；如果不做规范化，键顺序不同就会得到不同 id。RFC 8785 明确要求“deterministic property sorting”才能让哈希可重复（https://www.rfc-editor.org/rfc/rfc8785）。另外信号 `source_ref` 不能用 `${id}@${now}` 这种带时间的值，否则同一次事件每次都是不同字符串，幂等唯一约束会失效。依据是 [prompt-prefix.md 第 10、11 条](../../.agents/instructions/prompt-prefix.md#deterministic) 的同类原则。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**方案没有写任何自动检查；这是不能接受的最大缺口之一。** 至少要补下面这些，并且每条都要有“改前失败、改后通过”的反向用例：

- **迁移契约**：重建 `decision_ledger` 前后 `dump`、`foreign_key_check`、7 张子表行数、触发器存在；反向：裸 `DROP decision_ledger` 必须报子表行丢失。
- **参照表契约**：`DECISION_KINDS`/`DECISION_OUTCOMES` 与数据库完全一致；反向：删除仍在使用的 outcome 必须 `DECISION_LEDGER_OUTCOME_IN_USE`。
- **导出/导入**：新字段、`decision_versions`、新信号来回一致；反向：旧导出文件缺新字段时仍能导入，不能因外键失败。
- **think**：每个结算条目恰好一行；沉默也写；失败不进入准确率分母；反向：事务回滚时没有行；摘要删除后 `content_ref` 仍可读或不引用。
- **提议去重**：感知提议和想一想提议各只一行；反向：两个写入点都开着时必须报重复。
- **推送事件**：同一 `push_id` 的 `shown/opened/dismissed` 只挂一条判断；反向：两个判断共享 `push_source_key` 时不能把事件同时挂到两行。
- **退避/提醒页**：删列迁移后，点开过的推送仍不被抑制，提醒页仍显示 opened/dismissed；反向：只删列不改读者时测试必须失败。
- **统计**：固定样本 + 已知抽样权重，加权漏报率正确；反向：两个重叠区间不能判“变好”；反向：两个阈值（think 的 yes/no）单阈值回放必须报错。
- **安全**：伪造 `surface`、重复 `event_id`、未来时间、超量请求；反向：都必须被拒绝或钳制。
- **prompt-prefix**：`npm run check:prompt-prefix` 仍通过；侧调用加字节比对。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

**不能，逐个核对如下：**

| 值 | 产生处 | 使用处 | 两端校验 | 结论 |
| --- | --- | --- | --- | --- |
| `origin` | 各写入器 | 校准、导出、UI、来源分组 | 没有参照表/FK，只有长度；think `sourceKind` 任意 | 不接受：拼写错误会静默进入统计；且与 `scenario` 重复 |
| `version_id` | 各写入器/触发器 | 校准、导出、FK | 旧行/触发器无值，nullable/backfill 未定义 | 不接受：触发器写不了，旧数据没有 |
| `decision_versions.id` | JSON 指纹 SHA-256 | 账本 FK、导出 | 未规定规范化，含 origin | 不接受：键顺序/来源变化会产生不同 id |
| `proposal/judgment_failed` | think worker | 参照表、校准、每日复盘 | `DECISION_OUTCOMES`/参照表未加；没有 `is_judgment` 统一过滤 | 不接受：会被当成判断进入分母，或写入被拒 |
| 删除的 proposal 旧 outcomes | 迁移 | 旧行、导出/导入 | 触发器要求“在用不能删”；契约测试要求完全一致 | 不接受：旧数据/旧备份会让迁移失败 |
| 新信号 `delivered/shown/accepted/...` | 推送、提议、think | `DECISION_SIGNALS`、校准、导出、UI | 三处硬编码枚举；`summarizeImplicit` 只认 3 个 | 不接受：新信号会被静默忽略或导出失败 |
| 删除 `opened_at/dismissed_at` | `recordAttempt/recordReactions` | `countIgnoredPushes`、`proactive-overview`、`listFeedback`、类型/合约 | 未改这些读者 | 不接受：退避和提醒页行为改变 |
| `web_push/delivered` | `recordAttempt` | 参照表、校准、复盘 | 参照表没有 `delivered`；`push_source_key` 非唯一 | 不接受：伪判断行 + 事件挂错 |
| `limit_change` 的启用/停用 | 来源设置写入器 | 校验、UI、导出 | `LimitChangeInput` 只接受数字 `from/to` | 不接受：布尔型变化写不进去 |
| `content_ref` 指向 think 摘要 | think `settle` | 保留策略、决策链读取 | `RESTRICT` vs `maintain()` 删除/`clearSummary` | 不接受：删除失败、永久保留 |
| 客户端 `surface`/`shown` | 设备 | 信号表 | 合约只允许 opened/dismissed；无 surface/event_id | 不接受：新字段过不了合约，且可伪造 |
| `owner_rating` | 每日打分 | 准确率真值 | 与显式事件无时间优先级 | 不接受：迟到的显式事件可能被旧评分覆盖 |

另外，`origin`/`version_id` 也没有进入 `decision.chain.snapshot` 合约（`packages/gateway-contracts/src/contracts-v2.ts:2127-2152` 目前只有 kind/decidedAt/outcome/reasonCode/rating），如果以后要在“依据”抽屉显示版本，必须同步改合约和 UI；如果不在抽屉显示，就要在导出和统计接口里提供。
