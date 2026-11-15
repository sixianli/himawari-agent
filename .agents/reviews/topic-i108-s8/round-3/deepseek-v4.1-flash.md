CLAIM|1|一致|scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:42@5b1d5c49a6464f3197b9265a2ba1df90824a62a6|上线的第 8 步 S8（新版本启动之后的读回）原来会把生产库和第 3 步保存的数据库副本逐行比较|5. `S8_READBACK` 先核对保存的 `s3-copy-after56.json` 和 `s7-catalog-after56.json` 两份读回相同，再和 S3 保存的数据库副本逐行比较：
CLAIM|2|一致|scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:42@5b1d5c49a6464f3197b9265a2ba1df90824a62a6|规定“上线前已有的行不能删、列不能变”|上线前已有的行不能删、列不能变、内容不能改
CLAIM|3|一致|packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts:519|运行中的服务本来就会改老行|`UPDATE runs SET status = ?, revision = ?, updated_at = ?
CLAIM|4|一致|docs/incidents-and-gates.md:143|所以它拦过两次上线，两次都是正常写入|S8 的历史逐行比对在仓库记录里拦过两次上线，两次都是正常写入
CLAIM|5|一致|scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:50@5b1d5c49a6464f3197b9265a2ba1df90824a62a6|第十一次是启动恢复改写 `sandbox_execution_records.recovery_json`|启动恢复逻辑也会改写 `sandbox_execution_records` 里已结束记录的 `recovery_json` 列
CLAIM|6|一致|docs/incidents-and-gates.md:143|第二十九次（[I-108](../incidents-and-gates.md#incidents)）是服务结算预算改了 `model_budget_accounts`|改它的是启动后的新服务：`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts` 第 1207 行 `updateAccount` 的 `UPDATE model_budget_accounts SET reserved_cost_micros…revision`
CLAIM|7|一致|scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:42@5b1d5c49a6464f3197b9265a2ba1df90824a62a6|第二十九次当时给 Andy 的临时办法是为这一次上线关掉整类历史比较|实例文件的 `historyComparison` 为这个版本关掉比对时，S3、S7 按表摘要做的历史比较、迁移前后的历史比较和这里的逐行比较都跳过
CLAIM|8|一致|scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:801@5b1d5c49a6464f3197b9265a2ba1df90824a62a6|下一个版本会重新被拦|`assert.equal(value.release, label, "__PKT_LABEL_UPPER___MAINTENANCE_HISTORY_COMPARISON_OFF_FOR_OTHER_RELEASE");`
CLAIM|9|一致|scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:27|服务停着时，12 张历史表已经连续按“整表摘要完全相等”比较|这 12 张表各自的行数，以及按 rowid 排序后每行规范 JSON 的 SHA-256。不输出行内容。只在服务停着时比较，S8 不比。
CLAIM|10|一致|scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:38|`scripts/delivery-mode/packet-template/maintenance/P-readback-design.md` 的“历史不变的比较链”第 1 到 4 条|1. `S3_COPY51` 复制前后相同：`s3-copy-before56.json`、`s3-copy-after56.json`。
CLAIM|11|一致|scripts/delivery-mode/packet-template/systemd/S7-switch-start-readback.py:239|最后一次是 `scripts/delivery-mode/packet-template/systemd/S7-switch-start-readback.py` 里换服务定义和启动新版本之前的 `if upgraded_state['history'] != state['history']: raise …SWITCH_HISTORY_CHANGED`|if upgraded_state['history'] != state['history']:
CLAIM|12|一致|scripts/delivery-mode/make-packet.py:270|出包时迁移改历史表会被 `make-packet.py` 的 `PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES` 拒绝|refuse('PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES', entry['file'] + ' ' + ','.join(touched))
CLAIM|13|一致|docs/incidents-and-gates.md:143|I-108 里这些检查都通过了|过了 S1–S7（包括 S7_SWITCH_START 启动新版本）
CLAIM|14|一致|packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts:519|`packages/persistence-sqlite/src` 里对 `runs` … 有 UPDATE|`UPDATE runs SET status = ?, revision = ?, updated_at = ?
CLAIM|15|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:607|`packages/persistence-sqlite/src` 里对 … `threads` … 有 UPDATE|`UPDATE threads SET revision = ?, status = ?, title_ref = ?, title_source = ?,
CLAIM|16|一致|packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:1207|`packages/persistence-sqlite/src` 里对 … 预算两张表 … 有 UPDATE|`UPDATE model_budget_accounts
CLAIM|17|一致|packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:582|`packages/persistence-sqlite/src` 里对 … 预算两张表 … 有 UPDATE|`UPDATE model_budget_allocations SET status = 'started', started_at = ?
CLAIM|18|一致|packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:595|`packages/persistence-sqlite/src` 里对 … 模型调用记录 … 有 UPDATE|`UPDATE model_invocation_identities
CLAIM|19|一致|packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts:513|`packages/persistence-sqlite/src` 里对 … 对话检查点 … 有 UPDATE|.prepare(`UPDATE run_coordination_checkpoints SET phase='failed',terminal_status='failed',
CLAIM|20|一致|packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts:613|`packages/persistence-sqlite/src` 里对 … 沙箱执行记录都有 UPDATE|"UPDATE sandbox_execution_records SET recovery_json=?,reservation_stopped_at=? WHERE job_id=? AND preparation_state='reserved' AND reservation_stopped_at IS NULL"
CLAIM|21|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:965|`runs`、`threads`、`sandbox_execution_records` 另有 DELETE|database.prepare("DELETE FROM runs WHERE thread_id = ?").run(objectId);
CLAIM|22|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:971|`runs`、`threads`、`sandbox_execution_records` 另有 DELETE|database.prepare("DELETE FROM threads WHERE id = ?").run(objectId);
CLAIM|23|一致|packages/persistence-sqlite/src/sqlite-sandbox-unconfirmed-purge.ts:116|`runs`、`threads`、`sandbox_execution_records` 另有 DELETE|.prepare(`DELETE FROM sandbox_execution_records WHERE job_id IN (${marks})`)
CLAIM|24|一致|docs/adr/0277-the-system-deletes-expired-think-threads.md:46|ADR 0277 的决定 2 还让服务启动后每小时删一次到期的“想一想”对话|`ThinkThreadRetention` 在服务启动后先清一次，之后每小时清一次，不管想一想有没有开。
CLAIM|25|一致|packages/persistence-sqlite/src/migrations/0018_run_coordination_checkpoints.sql:7|12 张表里只有 4 张有 `revision` 列（runs、threads、run_coordination_checkpoints、model_budget_accounts|revision INTEGER NOT NULL CHECK (revision > 0 AND revision <= 9007199254740991),
CLAIM|26|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:148|12 张表里只有 4 张有 `revision` 列（… runs …）|revision INTEGER NOT NULL CHECK (revision >= 0),
CLAIM|27|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:80|12 张表里只有 4 张有 `revision` 列（… threads …）|revision INTEGER NOT NULL CHECK (revision >= 0),
CLAIM|28|一致|packages/persistence-sqlite/src/migrations/0049_thread_title_budget.sql:23|12 张表里只有 4 张有 `revision` 列（… model_budget_accounts …）|revision INTEGER NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991),
CLAIM|29|一致|packages/persistence-sqlite/src/migration-engine.ts:766|我把 112 个迁移在内存 SQLite 里跑完后核的|export const LATEST_MIGRATION_SEQUENCE: number =
CLAIM|30|一致|scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:42@5b1d5c49a6464f3197b9265a2ba1df90824a62a6|旧的 S8 逐行比对只允许两处例外|例外只有两处
CLAIM|31|一致|scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:985@5b1d5c49a6464f3197b9265a2ba1df90824a62a6|`sandbox_execution_records.recovery_json`|export const startupRecoveryColumns = Object.freeze({ sandbox_execution_records: Object.freeze(["recovery_json"]) });
CLAIM|32|一致|scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:786@5b1d5c49a6464f3197b9265a2ba1df90824a62a6|以及迁移 `thread_origin` 加的 `threads.origin` 列|export const addedColumnBackfills = Object.freeze({ thread_origin: Object.freeze({ threads: Object.freeze(["origin"]) }) });
CLAIM|33|一致|scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:1007@5b1d5c49a6464f3197b9265a2ba1df90824a62a6|其余列一变就以 `HISTORY_ROW_CHANGED` 失败|assert(changed.every((key) => allowed.has(key)), "__PKT_LABEL_UPPER___MAINTENANCE_HISTORY_ROW_CHANGED:" + table);
CLAIM|34|一致|scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:42@3cbd77356f7f65db72d28ae15ee687fa4dd3e912|`3cbd7735` 的 `P-readback-design.md` 第 42 行，本 PR 删掉了它|例外只有两处：`sandbox_execution_records.recovery_json`
CLAIM|35|一致|scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:39|S3、S7 按表摘要比|`S7_DB_STATUS` 读到的状态 `s7-preswitch-state.json` 等于 `s3-copy-after56.json`。
CLAIM|36|一致|scripts/delivery-mode/packet-template/maintenance/run-maintenance.mjs:141|迁移前后比|verifyHistoryUnchanged(preswitch, migration.after);
CLAIM|37|一致|scripts/delivery-mode/packet-template/systemd/S7-switch-start-readback.py:239|S7 切换脚本在启动新版本之前比较 S7 升级前后两份已保存的停服读回（比的是已保存的证据，不重新读库；此时服务已停，只有 root 能写）|if upgraded_state['history'] != state['history']:
CLAIM|38|一致|scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:42|S9 恢复后和 S3 读回比|S9 恢复后和 S3 读回的历史比较照常进行。
CLAIM|39|一致|scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:978@5b1d5c49a6464f3197b9265a2ba1df90824a62a6|开关把停服时的比较也一起关掉|if (comparison.mode === "off") return historyComparisonEvidence(comparison);
CLAIM|40|一致|docs/incidents-and-gates.md:143|而那些比较在 I-108 里是通过的|过了 S1–S7（包括 S7_SWITCH_START 启动新版本）
CLAIM|41|一致|docs/incidents-and-gates.md:143|它在仓库记录里从没拦到过真问题|两次都是正常写入
CLAIM|42|一致|scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:60|S3 的恢复点（上线前的整库副本）仍保留|再按 S3 的 Schema 56 恢复点恢复

未核对：业界做法和外部链接、Andy 的原话和线程消息，以及方案打算新增或修改的部分（S8 改造、删除开关、门槛测试要求）。112 个迁移和 `revision` 列是读迁移文件核的（95 个内置迁移加 17 个时间戳迁移，共 112 个），没有实际在内存 SQLite 里跑迁移。
