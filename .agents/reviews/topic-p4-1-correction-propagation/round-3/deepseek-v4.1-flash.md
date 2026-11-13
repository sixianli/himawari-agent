CLAIM|1|一致|packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:44|整理记忆（“做梦”）时，模型会从几条记忆推出一条新的（`reflect`，即“反思”出来的结论）|      AND change.action = 'reflect' AND change.undone_at IS NULL AND change.memory_id <> basis.memory_id
CLAIM|2|一致|apps/agent-service/src/production-owner-rules.ts:532|Andy 用一句话立的硬规则（例如“日本入管局相关的邮件以后必须通知我”）也指回一条规则类记忆（[ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md)）|        sourceMemoryId: memoryId,
CLAIM|3|一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:305|以前系统只会把“来源记忆直接被改”的规则标成待重审|    WHERE source_memory_id = OLD.id AND owner_id = OLD.owner_id AND agent_id = OLD.agent_id
CLAIM|4|一致|docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md:52|而且规则照常执行|2. **新增状态 `needs_review`（待重审）。**待重审的规则**照常执行**：裁判（`RuleJudge`）和设置读取都把它当作有效规则。
CLAIM|5|找不到|-|没人核对|-
CLAIM|6|找不到|-|方案经过两个模型的独立出方案和审核，记录在 `.agents/reviews/topic-p4-1-correction-propagation/`|-
CLAIM|7|找不到|-|整合后的方案在 `/mnt/project-files/p4-1-correction-propagation/integrated-plan.md`|-
CLAIM|8|一致|docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md:52|待重审的规则照常执行|2. **新增状态 `needs_review`（待重审）。**待重审的规则**照常执行**：裁判（`RuleJudge`）和设置读取都把它当作有效规则。
CLAIM|9|不一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:363|以前只有一个触发器管规则|CREATE TRIGGER memory_rule_needs_review_on_delete BEFORE DELETE ON memory_records
CLAIM|10|一致|docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md:58|而且不管恢复|同样的文字再次确认、只改重要度、改的是别的记忆、记忆从回收站恢复，都不触发；已经是 `needs_review` 的规则不会重复触发，删除也一样。
CLAIM|11|一致|packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:44|只有 `reflect` 是“从别的记忆推出来”：`derivedMemories` 只沿 `action = 'reflect' AND undone_at IS NULL` 的整理记录走|      AND change.action = 'reflect' AND change.undone_at IS NULL AND change.memory_id <> basis.memory_id
CLAIM|12|一致|packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:20|同一文件的 `MEMORY_BASIS_CHAIN_MAX_DEPTH = 8`|export const MEMORY_BASIS_CHAIN_MAX_DEPTH = 8;
CLAIM|13|一致|.claude/rules/prompt-prefix.md:67|后台模型调用要固定内容在前：`.claude/rules/prompt-prefix.md:67`：“后台调用也是固定的在前、会变的在后。”|15. **后台调用也是固定的在前、会变的在后。**整理记忆、判断邮件、起对话标题这类调用，先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。
CLAIM|14|找不到|-|项目记忆里 Andy 2026-11-12 的硬规则“理解用户意思一律交模型判断，不用关键词表/正则/写死词典”|-
CLAIM|15|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:495|迁移 0095 的 `memory_change_flags_downstream`（修改后）|CREATE TRIGGER memory_change_flags_downstream AFTER UPDATE ON memory_records
CLAIM|16|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:584|`memory_delete_flags_downstream`（删除前）|CREATE TRIGGER memory_delete_flags_downstream BEFORE DELETE ON memory_records
CLAIM|17|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:466|上游编号不设外键，所以上游被永久删除后这一行还在|  upstream_memory_id TEXT NOT NULL CHECK (length(upstream_memory_id) BETWEEN 1 AND 128),
CLAIM|18|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:514|这修改了前提 3 的两点：恢复也触发|      WHEN NEW.superseded_by IS NOT OLD.superseded_by THEN 'memory_restored'
CLAIM|19|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:340|规则多一个状态 `suspended`（已暂停）|  status TEXT NOT NULL CHECK (status IN ('active', 'needs_review', 'suspended', 'retired')),
CLAIM|20|一致|packages/application/src/rules/rule-book.ts:15|暂停的规则不执行：裁判的 `ruleIsEnforced`、`enforceableOwnerRule`、MCP 的 `rule_book`、数据导出的“生效规则数”都只认 `active` 和 `needs_review`|  return status === "active" || status === "needs_review";
CLAIM|21|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:360|数据库约束要求暂停必带原因（来源没了、读下来不再是长期要求、参数对不上）|  CHECK ((status = 'suspended') = (suspend_reason IS NOT NULL)),
CLAIM|22|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:361|只有“参数对不上”能带建议值|  CHECK (suggestion IS NULL OR suspend_reason = 'parameters_changed'),
CLAIM|23|一致|apps/agent-service/src/service-main.ts:2009|`RuleReviewService` 用邮件检查的同一个模型连接|              model: modelComposition.composition.proactiveModel(proactiveConfiguration.modelRef, {
CLAIM|24|一致|apps/agent-service/src/service-main.ts:2012|用途记为 `rule-review`|                purpose: "rule-review",
CLAIM|25|一致|packages/application/src/ports/rule-review.ts:4|模型调用失败最多重试 3 次|export const RULE_REVIEW_MAX_ATTEMPTS = 3;
CLAIM|26|一致|packages/application/src/ports/rule-review.ts:5|（间隔 1 小时）|export const RULE_REVIEW_RETRY_MS = 3_600_000;
CLAIM|27|一致|packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:303|3 次都失败写一条 `recheck_failed`|          outcome: "recheck_failed",
CLAIM|28|一致|packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:243|每次写入都核对修订号，核对期间规则被改过就丢弃这次结果|             WHERE owner_id = ? AND agent_id = ? AND rule_id = ? AND revision = ?
CLAIM|29|一致|apps/agent-service/src/production-proactive.ts:346|核对在每次查邮件之前跑完|        await this.reviewRules();
CLAIM|30|一致|packages/application/src/ports/rule-review.ts:6|一次最多 3 条|export const RULE_REVIEW_BATCH = 3;
CLAIM|31|一致|apps/agent-service/src/production-proactive.ts:346|方案里写的“在对话开始时触发”没有做，因为硬规则只作用在查邮件上|        await this.reviewRules();
CLAIM|32|一致|apps/control-center/src/components/correction-review.tsx:88|还在等核对的只有“看过没问题”|              {message(rule.status === "suspended" ? "review.restore" : "review.dismiss")}
CLAIM|33|一致|packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:577|选出的那条按“你指出它也该跟着改”加进清单，并写一条 `owner_reported_missed` 决策记录|          outcome: "owner_reported_missed",
CLAIM|34|不一致|packages/persistence-sqlite/src/migrations/0088_memory_capture_backlog.sql:1|`decision_ledger` 第 3 次重建|CREATE TABLE decision_ledger_keep AS SELECT * FROM decision_ledger;
CLAIM|35|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:26|类型加 `memory_review`|      'retrieval_degrade', 'external_read', 'rule_review', 'memory_review'
CLAIM|36|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:77|`rule_review` 的结果加 `suspended`、`cleared`、`recheck_failed`、`owner_adopted`、`owner_confirmed`、`owner_restored`|      'needs_review', 'suspended', 'cleared', 'recheck_failed', 'owner_adopted',
CLAIM|37|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:81|`memory_review` 的结果是 `flagged`、`owner_edited`、`owner_dismissed`、`owner_reported_missed`|      'flagged', 'owner_edited', 'owner_dismissed', 'owner_reported_missed'
CLAIM|38|一致|packages/calibration/src/index.ts:275|Andy 自己点的结果不进每日回顾和校准统计|  if (row.kind === "rule_review" && row.outcome?.startsWith("owner_")) return null;
CLAIM|39|一致|packages/persistence-sqlite/src/data-export/export.ts:578|规则暂停时系统算出的建议值，数据导出在“未导出”清单里写明|      what: "规则暂停时系统算出的建议值",
CLAIM|40|一致|packages/persistence-sqlite/src/data-export/export.ts:583|待重审标记，数据导出在“未导出”清单里写明|      what: "等你确认的待重审记忆标记",
CLAIM|41|一致|packages/persistence-sqlite/src/data-export/schemas.ts:300|暂停的规则连同暂停原因照常导出|  "规则手册里存下来的一条规则：当前版本加全部修订历史（历史最后一版就是当前版本）。parameters 是规则参数在库里存的 JSON 原文（逐字保留，用 JSON 解析即可读）；表达式由程序按参数生成，所以不导出表达式。withheld 为 true 时参数里有机密，或者库里存的原文不是写规则的程序会写出的形式（例如带重复的键），parameters 是遮盖后的 JSON，原文在密封文件里（key 为 rule/<ruleId>/parameters 和 rule/<ruleId>/history/<revision>/parameters）。产品自带的规则随版本发布，不在这里。status 为 suspended 时规则已暂停、不执行，suspendReason 写明原因（source_removed 出处记忆没了，no_longer_standing 主人改口不要了，parameters_changed 主人改了条件）；挂起时系统算出的建议值不导出。"
CLAIM|42|一致|packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:591|计数直接从决策记录的结果和原因码算（`packages/persistence-sqlite/src/sqlite-correction-review-operations.ts` 的 `agreement`），不另建表|  private agreement(input: MemoryInput<"agreement">): CorrectionAgreementCounts {
CLAIM|43|一致|packages/calibration/src/index.ts:8|处理数少于 5 条（`DEFAULT_MINIMUM_SAMPLES`）时只显示“样本不足（N 条）”，不显示比例|export const DEFAULT_MINIMUM_SAMPLES = 5;
CLAIM|44|一致|packages/calibration/src/index.ts:207|沿用本项目周报其他比例的做法（`packages/calibration` 的 `proportion`）|export function proportion(
CLAIM|45|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:2|迁移 0095 重建 `decision_ledger` 及引用它的全部子表（含 0091 的 `decision_prereviews`）|CREATE TABLE decision_prereviews_keep AS SELECT * FROM decision_prereviews;
CLAIM|46|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:421|迁移 0095 重建 `model_usage_observations`|CREATE TABLE model_usage_observations_keep AS SELECT * FROM model_usage_observations;
CLAIM|47|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:462|新增 `memory_review_items`|CREATE TABLE memory_review_items (
CLAIM|48|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:331|删掉 0087 的两个旧触发器|DROP TRIGGER memory_rule_needs_review;
CLAIM|49|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:434|用量按用途 `rule-review` 记在模型用量里|      'rule-review', 'other'
CLAIM|50|一致|apps/agent-service/src/production-memory-control.ts:73|网关新增 `memory.review.read`、`memory.review.respond`、`memory.review.reportMissed`|  "memory.review.read",
CLAIM|51|一致|apps/agent-service/src/production-observation.ts:353|周报快照多一个 `correction` 字段|          correction: correction
CLAIM|52|一致|apps/agent-service/src/production-mcp-read.ts:344|MCP `rule_book` 里规则的 `status` 可以是 `suspended`，此时 `enforced` 为假|    enforced: rule !== undefined,
CLAIM|53|找不到|-|还没做：已暂停规则对应的规则类记忆仍会作为文字进入模型上下文；要拿掉它会改变发给模型的内容，另行出方案|-

未核对的部分：`/mnt/project-files/p4-1-correction-propagation/integrated-plan.md` 因目录访问限制没读到，`.agents/reviews/topic-p4-1-correction-propagation/` 在工作区不存在，项目记忆里那条 2026-11-12 硬规则也未找到出处。另有“以前没人核对”“已暂停规则对应的规则类记忆仍进入模型上下文”两处，未找到可直接证明的代码或文档。
