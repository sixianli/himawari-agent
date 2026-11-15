## 结论与范围

这一轮只核对增量 `37a86b6..f9acc58`，并向它指向的旧代码跟读：`make-packet.py`、`maintenance-common.mjs`、`run-maintenance.mjs`、`S7-switch-start-readback.py`、`verify-fixtures.mjs`、`test_make_packet.py`、`run-packet-checks.py`、`S9-clean-transport.py`、相关 ADR、步骤说明、实例文件和 `docs/incidents-and-gates.md`。没有运行测试；测试结论只依据断言内容和代码路径，标记为“未运行”。

上一轮四条意见的核对结果：

- 意见 1 已改好：`steps/README.md:77`、`ADR 0086:51` 已不再声称 S8 逐行比对；仓库里相关文档只剩 ADR 0279 和 I-108 中描述“旧行为”的历史说明。
- 意见 2 已改好：`verify-fixtures.mjs:633` 的 scope 已改成 `real-sqlite S0 gate and stopped-service history digests`，与实际保留的 `historyDigests` / `verifyHistoryUnchanged` 夹具一致。
- 意见 3 已改好：`ADR 0279:44`、`P-readback-design.md:42`、`.agents/instructions/delivery-mode.md:29` 现在都明确说 S7 切换脚本比较的是两份已保存的停服读回；`S7-switch-start-readback.py:234-240` 也确实读 `s7-preswitch-state.json` 和 `s7-catalog-after__TARGET__.json`，没有重新读生产库。
- 意见 4 已改好，但留下了失效引用：重复测试 `test_history_fixtures_pass_in_a_packet_without_the_switch` 已删除，然而 ADR 0279 和 I-108 仍把它列为门槛，见下面第 1 条。

## 意见

### 1【低】删除夹具测试后，ADR 0279 和 I-108 仍把它列为门槛

文件：`docs/adr/0279-history-is-compared-only-while-the-service-is-stopped.md:75`、`docs/incidents-and-gates.md:143`

问题：增量删除了 `test_history_fixtures_pass_in_a_packet_without_the_switch`，但 ADR 0279 的“门槛”和 I-108 的“验证”列仍引用这个测试名。I-108 已被标成 `已落门槛`，读者会以为这个门槛仍然存在；实际可运行的对应测试只剩 `test_history_fixtures_pass_in_a_packet_whose_ledger_applies_thread_origin`（`scripts/delivery-mode/test_make_packet.py:580`），它没有“无开关”这个专门断言。

证据（读代码证实）：

- ADR 0279:75：`…、test_the_instance_file_cannot_switch_history_comparison_off、test_history_fixtures_pass_in_a_packet_without_the_switch。`
- I-108 行原文同样列了 `test_history_fixtures_pass_in_a_packet_without_the_switch`。
- 全仓库搜索该测试名只命中上述两处文档；`test_make_packet.py` 中不存在这个函数。
- 仍存在的是 `def test_history_fixtures_pass_in_a_packet_whose_ledger_applies_thread_origin(self):`。

建议：把两处文档改为引用实际存在的测试；如果要保留“无开关夹具”这个门槛，就补一个真正运行 `verify-fixtures.mjs` 的测试，而不是只引用已删除的函数名。

### 2【低】ADR 0086 的 0083 例外仍把“deploy.sh 的自动回滚”当作替代核对，和 andy-production 的 keep 不符

文件：`docs/adr/0086-generate-release-packets-from-parameters.md:51`、`scripts/delivery-mode/instances/andy-production.json:25`

问题：增量改写了 ADR 0086 这一句的 S8 部分，但保留了“替代核对是……和 `deploy.sh` 的自动回滚”。`andy-production` 是 `onDeployFailure: "keep"`，`deploy.sh` 在 `S2_STOP` 之后失败时不会自动回滚，而是打印 `DEPLOY_ROLLBACK_SKIPPED owner-choice` 并保留现场。对实际的一次上线，这个“自动回滚”并不存在。

证据（读代码证实）：

- ADR 0086:51：`…（S3、S7 和切换脚本启动前；S8 启动后的逐行比较已由 ADR 0279 取消）和 deploy.sh 的自动回滚。`
- `instances/andy-production.json:25`：`"onDeployFailure": "keep",`
- `scripts/delivery-mode/deploy.sh:108`：`echo "DEPLOY_ROLLBACK_SKIPPED owner-choice: the failed release is kept as it stopped at $action and the old release was not restored; …"`
- `.agents/instructions/delivery-mode.md:29` 也写明 `keep` 时不回滚。

建议：把这句改成“`onDeployFailure=rollback` 时由 `deploy.sh` 回滚；`keep` 时依赖 S3 恢复点和人工 `rollback.sh`”，或直接删除“自动回滚”这个不再成立的兜底说法。

## 侧重检查

- 错误路径 / 不可信输入：实例文件再带 `historyComparison` 会在 `make-packet.py:429-430` 的 `base_parameters` 入口直接 `PACKET_HISTORY_COMPARISON_SWITCH_REMOVED`，发生在构建和读取生产之前；实例文件当前没有该键；仓库里已无 `__PKT_HISTORY_COMPARISON__` / `__PKT_HISTORY_COMPARISON_JSON__` 占位符。符合预期。
- 不可撤销操作 / 安全：S8 不再检测新服务启动后对老行的修改，这是 ADR 0279 明确接受的取舍；S3 恢复点仍保留，`keep` 模式下恢复依赖人工执行 `rollback.sh`。没有发现新的未登记数据删除路径。
- 资源耗尽：本增量只改文档、删除测试和改 scope 字符串，没有增加循环、扫描或临时文件，不涉及新的资源耗尽路径。
- 规则 / 文档一致性：上一轮指出的 S8 逐行比对说法已改掉；但测试名引用和 ADR 0086 的“自动回滚”两处仍不一致，见上。
- 反向用例：没有运行测试。静态看，`test_the_instance_file_cannot_switch_history_comparison_off` 在旧实现下会失败（旧实例带 `historyComparison` 时 `assertNotIn` 失败；非法结构会抛 `PACKET_HISTORY_COMPARISON_INVALID` 而不是 `SWITCH_REMOVED`）；`test_history_is_compared_only_while_the_service_is_stopped` 在旧代码下也会因仍存在 `compareHistoryRows` / `historyComparison` 等字符串而失败。

## 必答问题

1. **是否改变模型已见过的请求开头？** 不涉及。增量只改部署文档、`verify-fixtures.mjs` 的输出 scope 字符串和测试；没有改系统提示、工具定义、历史消息或遮盖逻辑。代码库中也没有新增会让每轮变化值提前进入前缀的字段。发给模型的内容仍然只追加，变化的运行值仍在最后一条消息里。

2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及。增量改的是静态文档和静态 scope 字符串；没有依赖前后文的遮盖、时间字段或无序遍历参与模型请求序列化。

3. **有没有自动检查，反向用例会失败吗？** 有，但我没有运行。实例开关删除有 `test_the_instance_file_cannot_switch_history_comparison_off`；S8/S7/S9 行为有 `test_history_is_compared_only_while_the_service_is_stopped`；`PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES` 仍有 `test_a_migration_that_rewrites_preserved_history_is_refused_before_any_build` 等反向用例。按断言内容看，恢复旧实现会让前两项失败。问题在于第 1 条：文档引用的那个测试已经被删除，门槛文本与实际可运行的检查不再对应。

4. **增量产生或修改的每个值，使用端都能接受吗？** 逐项核对：
   - `PACKET_HISTORY_COMPARISON_SWITCH_REMOVED`：产生于 `make-packet.py:430`；使用于 `test_make_packet.py:591` 和文档，均接受。
   - `verify-fixtures` 的 `scope` 与 `counts`：产生于 `verify-fixtures.mjs:633`；`run-packet-checks.py` 只看退出码，不校验这些字段，去掉 `historyComparisonOff` 等计数键没有消费端依赖。
   - 删除的测试名：被 `docs/adr/0279:75` 和 `docs/incidents-and-gates.md:143` 引用，使用端不接受——这就是第 1 条意见。
   - 删除的 `HISTORY_COMPARISON*` 参数和模板占位符：`twelfth-parameters.json` 已去掉，仓库搜索无残留占位符，`render` 不会因缺参数失败。
   - `S8` 的 `report.scope`：`S9-clean-transport.py:291` 只检查 `s8['state']` 路径和摘要，不检查 scope 或 history，接受。

**推测 / 未核实：** 下一个版本如果确有迁移需要合法改写历史表，删掉一次性开关后只能新增代码里的明确例外（如 `ROW_PRESERVING_REBUILDS` / `ADDED_COLUMN_BACKFILLS`），而不能再通过实例文件放行；这是设计结果，不是本次增量引入的新误拦，但下个版本的具体迁移未核实。生产当前 schema 和下一版迁移内容也未核实。
