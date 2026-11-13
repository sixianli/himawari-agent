CLAIM|1|一致|packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:44|整理记忆（“做梦”）时，模型会从几条记忆推出一条新的（`reflect`，即“反思”出来的结论）|      AND change.action = 'reflect' AND change.undone_at IS NULL AND change.memory_id <> basis.memory_id
CLAIM|2|一致|packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:149|Andy 用一句话立的硬规则（例如“日本入管局相关的邮件以后必须通知我”）也指回一条规则类记忆（[ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md)）|            owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id,
CLAIM|3|一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:334|但以前系统只会把“来源记忆直接被改”的规则标成待重审|  WHERE source_memory_id = OLD.id AND owner_id = OLD.owner_id AND agent_id = OLD.agent_id
CLAIM|4|一致|packages/application/src/rules/rule-book.ts:15|而且规则照常执行|  return status === "active" || status === "needs_review";
CLAIM|5|一致|apps/agent-service/src/production-memory-control.ts:1402|只能等 Andy 自己点“重新确认”|            : action === "reconfirm"
CLAIM|6|找不到|-|方案经过两个模型的独立出方案和审核，记录在 `.agents/reviews/topic-p4-1-correction-propagation/` 的 `round-1`、`round-2`。|-
CLAIM|7|找不到|-|Andy 的几次选择记在同一目录的 `owner-decisions.md`|-
CLAIM|8|找不到|-|选了“① 模型重读再对比”，2026-11-11 回“同意”批准变更清单，P4-3 的两项在 2026-11-12 回“同意”。|-
CLAIM|9|一致|docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md:52|待重审的规则**照常执行**……规则停掉等于主人的要求悄悄失效|待重审的规则**照常执行**：裁判（`RuleJudge`）和设置读取都把它当作有效规则。理由：规则靠主人的话立起来，记忆被改动时还不知道主人是改了主意还是只是改了措辞，规则停掉等于主人的要求悄悄失效，违背“硬偏好必定执行”；
CLAIM|10|一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:301|以前管规则的是迁移 0087 的两个触发器（修改用 `memory_rule_needs_review`|CREATE TRIGGER memory_rule_needs_review AFTER UPDATE ON memory_records
CLAIM|11|一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:363|永久删除用 `memory_rule_needs_review_on_delete`|CREATE TRIGGER memory_rule_needs_review_on_delete BEFORE DELETE ON memory_records
CLAIM|12|一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:312|而且不管恢复|      AND NEW.status IN ('archived', 'trashed', 'deletion_pending', 'deleted_verified'))
CLAIM|13|一致|docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md:58|同样的文字再次确认、只改重要度、改的是别的记忆、记忆从回收站恢复，都不触发；已经是 `needs_review` 的规则不会重复触发|同样的文字再次确认、只改重要度、改的是别的记忆、记忆从回收站恢复，都不触发；已经是 `needs_review` 的规则不会重复触发
CLAIM|14|一致|packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:44|`derivedMemories` 只沿 `action = 'reflect' AND undone_at IS NULL` 的整理记录走|      AND change.action = 'reflect' AND change.undone_at IS NULL AND change.memory_id <> basis.memory_id
CLAIM|15|一致|packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:20|同一文件的 `MEMORY_BASIS_CHAIN_MAX_DEPTH = 8`|export const MEMORY_BASIS_CHAIN_MAX_DEPTH = 8;
CLAIM|16|一致|.claude/rules/prompt-prefix.md:67|后台调用也是固定的在前、会变的在后。|15. **后台调用也是固定的在前、会变的在后。**整理记忆、判断邮件、起对话标题这类调用，先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。
CLAIM|17|一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:15、packages/persistence-sqlite/src/migrations/0088_memory_capture_backlog.sql:15、packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:15|`decision_ledger` 再重建一次（之前 0087、0088、0089 都重建过）|DROP TABLE decision_ledger;
CLAIM|18|一致|packages/calibration/src/index.ts:8|处理数少于 5 条（`DEFAULT_MINIMUM_SAMPLES`）|export const DEFAULT_MINIMUM_SAMPLES = 5;
CLAIM|19|一致|packages/calibration/src/index.ts:207|一致率用 `packages/calibration` 的 `proportion` 计算|export function proportion(
CLAIM|20|一致|packages/persistence-sqlite/src/migrations/0091_decision_prereviews.sql:1|迁移 0095 重建 `decision_ledger` 及引用它的全部子表（含 0091 的 `decision_prereviews`）|CREATE TABLE decision_prereviews (
CLAIM|21|一致|docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md:60|本 ADR 不改规则类记忆那条给模型看的文字（ADR 0211 决定 5 说的软偏好路径）|受预算影响的是规则类记忆那条给模型看的文字（清单 M-3）。这是软偏好的路径，本 ADR 不改它

评审记录 `.agents/reviews/topic-p4-1-correction-propagation/` 及其中的 `owner-decisions.md` 在当前检出中读不到，所以序号 6、7、8 只能标为找不到；SQLite 触发器限制和 dbt 等外部说法按要求未核对。
