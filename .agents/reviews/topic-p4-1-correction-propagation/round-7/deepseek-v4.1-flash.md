CLAIM|1|一致|packages/persistence-sqlite/src/migrations/0084_memory_consolidation_basis.sql:45|整理记忆（“做梦”）时，模型会从几条记忆推出一条新的（`reflect`，即“反思”出来的结论）|WHERE c.action = 'reflect'
CLAIM|2|一致|packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:149|Andy 用一句话立的硬规则（例如“日本入管局相关的邮件以后必须通知我”）也指回一条规则类记忆（[ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md)）。|owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id,
CLAIM|3|一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:305|以前系统只会把“来源记忆直接被改”的规则标成待重审|WHERE source_memory_id = OLD.id AND owner_id = OLD.owner_id AND agent_id = OLD.agent_id
CLAIM|4|一致|packages/application/src/rules/rule-book.ts:15|而且规则照常执行|return status === "active" || status === "needs_review";
CLAIM|5|一致|docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md:52|只能等 Andy 自己点“重新确认”（ADR 0211 决定 2：“明确的“重新确认”按钮由第 4 步做”）|明确的“重新确认”按钮由第 4 步做。
CLAIM|6|找不到|-|方案经过两个模型的独立出方案和审核，记录在 `.agents/reviews/topic-p4-1-correction-propagation/` 的 `round-1`、`round-2`。|
CLAIM|7|找不到|-|Andy 的几次选择记在同一目录的 `owner-decisions.md`|
CLAIM|8|找不到|-|选了“① 模型重读再对比”，2026-11-11 回“同意”批准变更清单，P4-3 的两项在 2026-11-12 回“同意”。|
CLAIM|9|一致|docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md:52|待重审的规则照常执行。来源 [ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md) 决定 2：“待重审的规则**照常执行**……规则停掉等于主人的要求悄悄失效”|待重审的规则**照常执行**：裁判（`RuleJudge`）和设置读取都把它当作有效规则。理由：规则靠主人的话立起来，记忆被改动时还不知道主人是改了主意还是只是改了措辞，规则停掉等于主人的要求悄悄失效
CLAIM|10|一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:301|修改用 `memory_rule_needs_review`|CREATE TRIGGER memory_rule_needs_review AFTER UPDATE ON memory_records
CLAIM|11|一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:363|永久删除用 `memory_rule_needs_review_on_delete`|CREATE TRIGGER memory_rule_needs_review_on_delete BEFORE DELETE ON memory_records
CLAIM|12|一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:312|而且不管恢复|AND NEW.status IN ('archived', 'trashed', 'deletion_pending', 'deleted_verified'))
CLAIM|13|一致|docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md:58|同样的文字再次确认、只改重要度、改的是别的记忆、记忆从回收站恢复，都不触发|同样的文字再次确认、只改重要度、改的是别的记忆、记忆从回收站恢复，都不触发；已经是 `needs_review` 的规则不会重复触发，删除也一样。
CLAIM|14|一致|docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md:58|已经是 `needs_review` 的规则不会重复触发|已经是 `needs_review` 的规则不会重复触发，删除也一样。
CLAIM|15|一致|packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:44|只有 `reflect` 是“从别的记忆推出来”|AND change.action = 'reflect' AND change.undone_at IS NULL AND change.memory_id <> basis.memory_id
CLAIM|16|一致|packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:44|`derivedMemories` 只沿 `action = 'reflect' AND undone_at IS NULL` 的整理记录走|AND change.action = 'reflect' AND change.undone_at IS NULL AND change.memory_id <> basis.memory_id
CLAIM|17|一致|packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:20|同一文件的 `MEMORY_BASIS_CHAIN_MAX_DEPTH = 8`|export const MEMORY_BASIS_CHAIN_MAX_DEPTH = 8;
CLAIM|18|一致|.claude/rules/prompt-prefix.md:67|后台模型调用要固定内容在前：`.claude/rules/prompt-prefix.md:67`：“后台调用也是固定的在前、会变的在后。”|15. **后台调用也是固定的在前、会变的在后。**整理记忆、判断邮件、起对话标题这类调用，先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。
CLAIM|19|一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:17|之前 0087、0088、0089 都重建过|CREATE TABLE decision_ledger (
CLAIM|20|一致|packages/persistence-sqlite/src/migrations/0091_decision_prereviews.sql:1|含 0091 的 `decision_prereviews`|CREATE TABLE decision_prereviews (
CLAIM|21|一致|packages/calibration/src/index.ts:8|处理数少于 5 条（`DEFAULT_MINIMUM_SAMPLES`）|export const DEFAULT_MINIMUM_SAMPLES = 5;
CLAIM|22|一致|packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:612|计数直接从决策记录的结果和原因码算（`packages/persistence-sqlite/src/sqlite-correction-review-operations.ts` 的 `agreement`），不另建表。|FROM decision_ledger
CLAIM|23|一致|packages/calibration/src/index.ts:207|一致率用 `packages/calibration` 的 `proportion` 计算|export function proportion(
CLAIM|24|一致|apps/control-center/src/components/weekly-report.tsx:437|比例旁边写样本数|n: format.count(rate.samples),
CLAIM|25|一致|apps/control-center/src/components/weekly-report.tsx:425|样本不够不出比例|if (group.rated < minimumSamples) return null;

`.agents/reviews` 被 sparse checkout 排除，且读取该路径的 git 命令被拒绝，`round-1`、`round-2` 和 `owner-decisions.md` 的具体内容未能核对。
