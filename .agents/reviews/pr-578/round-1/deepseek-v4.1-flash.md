### 1【中】步骤说明和 ADR 0086 仍宣称 S8 逐行比对，与代码相反

- **文件:行**：`scripts/delivery-mode/packet-template/steps/README.md:77`；`docs/adr/0086-generate-release-packets-from-parameters.md:51`
- **问题**：本 PR 删除了 S8 的逐行比对，但上线步骤说明仍把它写成现行行为；ADR 0086 关于 0083 重建“替代核对是 S7/S8 的历史表比较”和 `thread_origin` 例外“S3、S7、S8 历史比较”的表述也失效了。上线操作者会以为 S8 仍会拦住老行改动，ADR 0086 记录的安全网也少了一条。
- **证据**：
  - `steps/README.md:77`：`| S8_READBACK | 启动后数据库读回：Schema 56；和 S3 保存的数据库副本逐行比较，已有行不能删改（例外两处：...recovery_json...threads.origin...），允许新行；...`
  - `docs/adr/0086...:51`：`替代核对是 S7/S8 的历史表比较和 deploy.sh 的自动回滚。...这次上线的 S3、S7、S8 历史比较才不比 threads.origin`
  - 代码里 S8 只剩 `run-maintenance.mjs:205` 比较两份停服读回，`203-211` 不再写 `report.history`。
- **建议**：更新 `steps/README.md` 的 S8 行；在 ADR 0086 相应位置注明被 ADR 0279 修改（或把 ADR 0279 的 `amends` 指向 0086），把“S7/S8 历史表比较”改成“S7 及停服时的摘要比较”。

### 2【低】verify-fixtures 的输出 scope 仍声称 S8 逐行比对，证据自述失真

- **文件:行**：`scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:633`
- **问题**：夹具已经不再测试逐行比对，但最后写出的 `scope` 仍声称它证明了 S8 逐行比对和两处例外。产物描述与实际检查不符。
- **证据**：同一行写着 `... real-sqlite S0 gate and history, S8 row-by-row history against the S3 copy (old rows kept, new rows allowed, only sandbox recovery_json may change; threads.origin skipped ...) ...`，而该文件已无 `compareHistoryRows` 调用。
- **建议**：删掉 `S8 row-by-row...` 这一句，只保留“停服时的历史摘要比较”。

### 3【低】“S7 启动前再比一次”只比较两份已保存证据，不重新读生产库

- **文件:行**：`scripts/delivery-mode/packet-template/systemd/S7-switch-start-readback.py:234-240`
- **问题**：脚本从磁盘读 `s7-preswitch-state.json` 和 `s7-catalog-after__PKT_TARGET_SCHEMA__.json`，比较两份历史摘要；它没有在切换前重新读生产库。因此 S7_CATALOG_UPGRADE 读回之后、切换之前若数据库被改动，检查看不到。表述“启动前再比一次”容易被理解为一次新的实时读回。
- **证据**：
  - `234: state = json_file(evidence / 's7-preswitch-state.json', 999, 0o600)`
  - `235: upgraded_state = json_file(evidence / 's7-catalog-after__PKT_TARGET_SCHEMA__.json', 999, 0o600)`
  - `239: if upgraded_state['history'] != state['history']:`
- **建议**：若要覆盖这个窗口，在切换前调用维护程序再读一次实时库；否则在 P-readback-design.md 和 ADR 里明确这是“证据链比对”，不是启动前的新读回。实际风险较低：此时服务已停，只有 root 能写。

### 4【低】新增的“无开关”夹具测试与已有测试重复，不是反向用例

- **文件:行**：`scripts/delivery-mode/test_make_packet.py:622-627`（与 `580-587` 重复）
- **问题**：两个测试渲染同样的两个包、运行同一个 `verify-fixtures.mjs`、只断言 `passed`，内容几乎相同。新测试在修复前也会通过，不能作为“修复前失败”的回归保护；真正防止 S8 复活逐行比对的是 `605-620` 的源码文本断言。
- **证据**：
  - `580-582`：`test_history_fixtures_pass_in_a_packet_whose_ledger_applies_thread_origin` 对 `MIGRATION_LEDGER=ledger, TARGET_SCHEMA=57` 和无 ledger 的包运行夹具。
  - `622-627`：`test_history_fixtures_pass_in_a_packet_without_the_switch` 对同样两个包做同样的事，只断 `passed`。
- **建议**：合并这两个测试；若要真正覆盖“S8 不再因运行中服务的正常写入失败”，加一个行为夹具（渲染后的 S8 代码只读两份停服快照），而不只依赖字符串缺席。

**侧重检查**

- **错误路径**：`S8_READBACK` 缺少 `s3-copy-after*` 或 `s7-catalog-after*` 时，`jsonFile` 直接抛错、整步失败，仍为 fail-closed。实例带 `historyComparison` 时，`base_parameters` 在构造参数前以 `PACKET_HISTORY_COMPARISON_SWITCH_REMOVED` 拒绝出包（`make-packet.py:429-430`）。
- **不合规范/不可信输入**：实例文件是内部输入；新拒绝逻辑用 `in instance`，不依赖值的类型，`{mode: ...}`、`on`、任意值都会拒绝。迁移 SQL 仍由原有正则和摘要白名单检查，本次未放宽。
- **安全**：没有新增秘密、日志或输出内容；历史行内容仍不落盘（删掉的逐行比对本来也只报表名）。
- **资源耗尽**：删除 S8 的逐行比对反而减少了两个只读连接和整表逐行遍历，没有新增资源消耗路径。
- **不可撤销操作**：S8 不再检测“新服务启动后改坏老数据”，这是 ADR 0279 接受的取舍；`run-maintenance.mjs:210` 仍校验 S3 恢复点，回滚材料仍在。
- **规则/文档一致性**：发现上面第 1、2 条的失效描述；`P-readback-design.md` 和 `.agents/instructions/delivery-mode.md` 已同步，未发现其他代码引用被删的函数或占位符。

**读代码证实的 / 推测与未核实**

- 读代码证实：代码中已无 `compareHistoryRows`、`verifyHistoryAgainstRecoveryPoint`、`startupRecoveryColumns`、`historyComparison`、`HISTORY_COMPARISON` 的生产消费者；`__PKT_HISTORY_COMPARISON*` 占位符已无残留；S8 只比较两份停服快照；S9 恢复后仍比较；`verifyHistoryUnchanged`、`verifyMigrationTransition`、`migration_ledger` 的调用点均已改签。
- 读代码证实：迁移文件中，0079 之后触及 12 张历史表 DML/DDL 的只有 `0083_model_invocation_owner_lost.sql`（已登记的行保留重建）和 `20261115045512_thread_origin.sql`（已登记的加列回填），两者都有白名单例外。
- 推测：第 3 条窗口的实际可利用性（服务已停、只有 root 能写）。
- 未核实：作者“S8 逐行比对历史上只拦过两次、两次都是正常写入”的历史说法；ADR 前提里“7 张表会被合法 UPDATE/DELETE”的逐表统计；因稀疏检出只有 56%，全仓“无其它消费者”是在可见文件范围内核实，未见的不代表不存在。
- 未实际运行测试；上面对“修复前会失败”的判断来自旧代码文本，不是执行结果。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 改动只涉及 `scripts/delivery-mode/` 的部署/维护脚本、实例与夹具，以及 `docs/`；没有碰提示词目录、运行时适配器、上下文组装、出口遮盖等路径。因此发给模型的内容仍然只在末尾追加，系统提示/工具定义/历史不变；本次也没有把任何每轮会变的值挪进请求头部。依据 [prompt-prefix.md](.agents/instructions/prompt-prefix.md#rules) 第 1、4 条。
2. **不会让同一段文字在不同请求里变成不同的字节。** 本次没有改动任何模型请求序列化；新增/修改的字段都是部署证据（`startedAt`/`finishedAt` 本来就有），不进模型请求。反而删除了带 `checkedAt: new Date().toISOString()` 的 S8 历史证据函数，减少了一处时间字段。`migrationComparedSections` 是固定冻结数组，没有无序集合引入。
3. **有检查，但覆盖不完整。** `test_history_is_compared_only_while_the_service_is_stopped` 和 `test_the_instance_file_cannot_switch_history_comparison_off` 按旧代码推断在修复前会失败（旧代码含被删名字、旧错误码不是 `..._SWITCH_REMOVED`）；`test_history_fixtures_pass_in_a_packet_without_the_switch` 是重复用例、修复前也会通过。`verify-fixtures.mjs:187、194、239` 仍保留停服比较的反向用例（改旧行、改旧对话会被 `HISTORY_CHANGED`/摘要差异拦下）。缺口是：没有行为测试证明“运行中服务改老行时 S8 通过”，只靠源码文本缺席来防回归。
4. **逐个值核对：两端都能接受，没有发现代码消费者被遗漏。**
   - `HISTORY_COMPARISON` / `HISTORY_COMPARISON_JSON`：产生端已从 `base_parameters` 和 `twelfth-parameters.json` 删除；使用端是模板占位符和旧夹具，均已删除，全仓可见范围内无残留。
   - 实例键 `historyComparison`：实例文件中已删除；使用端 `make-packet.py:429-430` 现在显式拒绝，唯一实例 `andy-production.json` 已干净。
   - `report.history` / `s8-history-preserved.json`：S8 不再产生；可见范围内无代码读取，只有 ADR 文本提及。`S9-clean-transport.py:291` 只检查 `S8_READBACK` 的 `s8-database-readback.json` 和 action，不受影响。
   - `report.scope`：S8 的新字符串没有消费者读取。
   - S7 orchestration 的 `historyComparison`：已删除，未发现读取方。
   - 函数签名 `verifyHistoryUnchanged`、`verifyMigrationTransition`、`migration_ledger`：所有调用点已改为新签名（`run-maintenance.mjs:113-258`、`maintenance-common.mjs:849`、`make-packet.py:473`）。
   - `count(...)` 组：`historyRowsAccepted/Rejections`、`historyComparisonOff` 改为 `historyDigestsAccepted/Rejections`；`run-packet-checks.py` 只看退出码，`test_make_packet.py` 只看 `passed`，没有其它依赖。
   - `PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES`：删掉开关后，已应用的迁移不在检查范围内（只查 `pending`），下一个版本待补的 79+ 迁移里触及历史表的只有 0083 和 `thread_origin`，两者都有白名单，所以不会新增误拦；代价是以后合法的“改历史表”迁移也再没有一次性开关可绕过，这是本次设计的有意取舍。
