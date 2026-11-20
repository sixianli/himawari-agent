## 作者说法核对

- 「只对 twentyninth 这个标签生效，换了标签就拒绝」：**证实**。`make-packet.py:428-429` 比较 `setting['release'] != label`，渲染后的 `maintenance-common.mjs:801` 也再次比较 `value.release` 与 `__PKT_LABEL__`。
- 「关闭时 S3、S7、S8 的历史逐行比对都跳过」：**部分不正确**。S3/S7 调用的 `verifyHistoryUnchanged` 比的是每张表的 `history` 摘要，不是逐行；只有 S8 的 `compareHistoryRows` 是逐行。并且实际还多关了 S9 恢复时的历史比较（见意见 2），作者说法未提。
- 「S2_STOP 之后失败时不跑 rollback.sh、不跑 release-cleanup，结果记为 failed-kept」：**证实**，见 `deploy.sh:107-110` 和 `deploy.sh:24-26`。
- 「每份维护证据都记下 historyComparison」：**基本证实**。`run-maintenance.mjs:102` 和 `S7-switch-start-readback.py:268` 都写了；但 S8 关闭时证据形状与 `P-readback-design.md` 描述不一致（见意见 6）。
- 「上线前（S2 之前）失败路径行为不变」：**对有效 keep 取值成立**；未知/非法取值现在会在任何步骤前以 `invalid-on-failure` 退出 9，这是新增的更早失败点。
- 「新参数占位符都会被替换」：**证实**。`render()` 对每个模板文件做替换，并在 `make-packet.py:513-514` 拒绝任何残留 `__PKT_`；`ON_DEPLOY_FAILURE` 不是模板占位符，只从 `packet-parameters.json` 读取。
- 「以上新测试在修复前都失败」：**逻辑上成立**（相关函数、参数和占位符在修复前不存在），但本轮没有执行测试，见必答问题 3。

## 意见

### 1. 高 - keep 覆盖所有 S2_STOP 之后的失败，S3/S6/S7 阶段失败会让生产停在停机状态且不再自动回滚

- 文件:行：`scripts/delivery-mode/deploy.sh:92`、`:97`、`:107-110`；`.agents/instructions/delivery-mode.md:29`
- 问题：S2_STOP 会停止旧服务，S7_SWITCH_START 才启动新服务。从 S2_STOP 到 S7_CATALOG_UPGRADE 之间的任何失败，keep 都直接 `result failed-kept` 退出，不再运行 `rollback.sh`。此时旧服务已停、新服务尚未启动，生产实际处于停机状态；如果 S7_SWITCH_START 自身失败，它还会在错误处理中停掉新 unit。`andy-production` 现在默认 keep，所以后续每次上线都可能落在这条路径。文档只说“保留现场”，没有说“服务可能已停”。
- 证据（读代码证实）：
  - `deploy.sh:92`：`actions=(S1_TRANSPORT S1_INSTALL S6_ACCEPTANCE S2_STOP S3_COPY51 ... S7_SWITCH_START S8_READBACK)`
  - `deploy.sh:97`：`[[ "$action" == S2_STOP ]] && stopped=1`
  - `deploy.sh:107-110`：`if [[ "$on_failure" == keep ]]; then ... result failed-kept "$action" "$code"`
  - `S7-switch-start-readback.py:344-360` 在启动失败时会 `systemctl stop` 新 unit，然后退出。
- 推测/风险：`HIMAWARI_DEPLOY_ACCEPTANCE_AFTER_STOP=1` 时 S6_ACCEPTANCE 也在停服后，同样会被 keep 留在停机状态；这条路径没有自动测试。
- 建议：只对 S7_SWITCH_START 及之后（新服务已启动）的失败自动采用 keep；S2_STOP 到 S7_CATALOG_UPGRADE 之间的失败仍回滚，除非操作者显式设置 `HIMAWARI_DEPLOY_ON_FAILURE=keep`。至少应在 `DEPLOY_RESULT`/日志里明确打印“服务当前停机”，并补 S3、S7_CATALOG_UPGRADE、acceptance-after-stop 的 keep 失败用例。

### 2. 中 - historyComparison=off 同时关掉了 S9 回滚恢复时的历史核对，超出授权范围且文档未说明

- 文件:行：`scripts/delivery-mode/packet-template/maintenance/run-maintenance.mjs:259`；`maintenance-common.mjs:978-979`
- 问题：S9_RAW_RESTORE51 调用 `verifyHistoryUnchanged(reference, state)` 时没有显式传 comparison，因此默认使用包级的 `historyComparison`，twentyninth 包会直接跳过恢复后的历史比较。S8 的失败原因是“新服务启动后正常写预算表”，S9 回滚时服务已停止、数据来自原始恢复点，这个原因不成立，本来不需要关闭。关闭后，恢复出的旧库即使历史表行被改也不会被这条检查发现，只能靠 schema、ledger、integrity、foreign key 和 gate 检查兜底。
- 证据（读代码证实）：
  - `run-maintenance.mjs:259`：`verifyHistoryUnchanged(reference, state);`
  - `maintenance-common.mjs:978-979`：`export function verifyHistoryUnchanged(before, after, comparison = historyComparison) { if (comparison.mode === "off") return historyComparisonEvidence(comparison);`
  - `delivery-mode.md:29` 只写了 S3、S7、迁移和 S8，没有写 S9。
- 建议：S9 恢复显式传 `historyOn`，或给开关加 action 范围（只影响 S3/S7/S8），并补一条“off 包仍执行 S9 历史比较”的测试。

### 3. 中 - 关闭范围过宽：S3/S7 和出包的 PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES 也被关闭，而它们不是本次失败的原因

- 文件:行：`scripts/delivery-mode/make-packet.py:488`；`maintenance-common.mjs:808-810`；`S7-switch-start-readback.py:242`
- 问题：S3/S7 的检查都在服务停止时运行，迁移校验也在服务启动前；I-108 也确认 S7 迁移后的历史检查和 S7_CATALOG_UPGRADE 在生产上是通过的。把 `PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES` 一起关掉，会让“DROP/UPDATE/DELETE 历史表”的迁移通过唯一的出包静态拒绝，风险明显大于修复 S8 所需。
- 证据（读代码证实）：
  - `make-packet.py:488`：`migration_ledger(..., parameters.get('HISTORY_COMPARISON', 'on') != 'off')`
  - `make-packet.py:266-268`：`if touched and compare_history: refuse('PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES', ...)`
  - `maintenance-common.mjs:808-810`：`comparedSectionsFor` 在 off 时过滤掉 `"history"`，`migrationComparedSections` 随之缩小。
  - `S7-switch-start-readback.py:242`：`if history_comparison == 'on' and upgraded_state['history'] != state['history']:`
- 建议：只关闭 S8 对运行中数据库的逐行比较；S3/S7/迁移静态拒绝保持开启。若确需放过某个迁移，按迁移名或摘要白名单，而不是整个版本关闭。

### 4. 中 - 根因未修：下一版本恢复比对后 S8 仍会因运行中服务正常写预算表而失败

- 文件:行：`docs/incidents-and-gates.md:143`；`maintenance-common.mjs:985-1007`；`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:1205-1220`、`:1476-1481`
- 问题：本次只是给第二十九次上线一个一次性开关。I-108 自己也写“没解决的：……下一个版本恢复比对后，S8 仍会因新服务启动后正常改写预算账户而失败”。`compareHistoryRows` 目前只允许 `sandbox_execution_records.recovery_json` 这一类启动恢复列变化，没有预算账户的正常结算列。
- 证据（读代码证实）：
  - `sqlite-model-budget-operations.ts:1207-1209`：`UPDATE model_budget_accounts SET reserved_cost_micros = ?, spent_cost_micros = ?, status = ?, revision = ? ...`
  - `sqlite-model-budget-operations.ts:1478-1479`：`UPDATE model_budget_accounts SET data_classification = ? ...`
  - `maintenance-common.mjs:1006-1007`：`const changed = ...; assert(changed.every((key) => allowed.has(key)), "...HISTORY_ROW_CHANGED...")`
- 推测/风险：`model_budget_allocations` 也可能被运行中的服务插入/删除，下一版本恢复 S8 比较后可能先在这张表上失败；I-108 只对 `model_budget_accounts` 做了行级确认。
- 建议：把 S8 的例外机制从“整包关闭”改成“按表/列允许运行中服务写入”，例如把预算账户的 `reserved_cost_micros`、`spent_cost_micros`、`status`、`revision`、`data_classification` 加入类似 `startupRecoveryColumns` 的允许列表，并补真实数据的夹具。这样既解决本次问题，也不会让下一版本再次卡住。

### 5. 中 - onDeployFailure=keep 会永久继承到后续所有 andy-production 上线，且没有 release 或授权字段

- 文件:行：`scripts/delivery-mode/instances/andy-production.json:31`；`make-packet.py:433-437`
- 问题：`historyComparison` 有 `release`、`reason`、`authorizedBy`，换版本会失败关闭；`onDeployFailure` 只有 `"keep"`，不区分版本，也没有授权依据。此后所有从该实例生成的上线包都会默认不自动回滚，而不只是第二十九次。
- 证据（读代码证实）：
  - `andy-production.json:31`：`"onDeployFailure": "keep"`
  - `make-packet.py:434-437`：`choice = instance.get('onDeployFailure', 'rollback'); if choice not in DEPLOY_FAILURE_CHOICES: refuse(...); return choice`
  - `deploy.sh:52-56` 的环境变量覆盖优先，且同样没有授权记录，只记录来源。
- 建议：给 `onDeployFailure` 加 `release`/`reason`/`authorizedBy` 并像历史开关一样对别的标签拒绝；或者不要在实例里默认 keep，改由每次失败时显式设置 `HIMAWARI_DEPLOY_ON_FAILURE=keep`。补一条“future label 默认 rollback”的测试。

### 6. 低 - 文档/证据契约与代码不一致：包内 P-readback-design 仍称 S8 总会逐行比较并列出 tables/ignoredHistoryColumns，delivery-mode 未提 S9

- 文件:行：`scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:42`；`maintenance-common.mjs:1028`、`:1038`；`.agents/instructions/delivery-mode.md:29`
- 问题：关闭时 S8 证据返回 `tables: null`，且没有 `allowedStartupRecoveryColumns`、`ignoredHistoryColumns`，但包内的 `P-readback-design.md` 仍写“再和 S3 保存的数据库副本逐行比较……结果写进 s8-history-preserved.json，列出每张表……以及这次不比较的列（ignoredHistoryColumns）”。该文档会随包分发，失败时操作者会按错误的契约理解证据。仓库内没有其他消费者强制要求这些字段（已逐个查过 `S9-clean-transport.py`、`finalize`、`cloud-seal`、S7/S9 读回），所以不是运行时故障，但属于严重的文档不一致。`delivery-mode.md` 也没有写 S9 会被关闭。
- 证据（读代码证实）：
  - `maintenance-common.mjs:1028`：`if (comparison.mode === "off") return { ..., ...historyComparisonEvidence(comparison), tables: null };`
  - `maintenance-common.mjs:1038`：正常路径才返回 `allowedStartupRecoveryColumns`、`ignoredHistoryColumns`、`tables`。
- 建议：更新 `P-readback-design.md` 描述 off 模式和证据形状；在 `delivery-mode.md` 写明 S9（如果保留当前行为）；作者说法中的“S3/S7 逐行”改为“S3/S7 按表摘要比较”。如果修意见 2，则文档只需说明 S9 不关闭。

### 7. 低 - failed-kept 后同一上线包不能直接重跑，现有 preflight 会因目标路径仍在而拒绝

- 文件:行：`scripts/delivery-mode/deploy-preflight.py:155`、`:199`；`release-cleanup-remote.py:199-230`；`deploy.sh:24-26`
- 问题：S8 失败 keep 后，新版本正在服务，`newPrefix`/`newOperations`/`transportRoot` 等目标路径都存在；下一次对同一包运行 deploy.sh 时，`cleanup before` 会把 serving 版本当作当前版本保留，随后 preflight 的 `TARGET_PATH_ABSENT` 失败。也就是说 keep 后必须先手动 rollback 或人工清理，才能重试同一包。文档只说“要恢复旧版本时再手动运行 rollback.sh”，没有说明重试会被拦。
- 证据（读代码证实）：
  - `deploy-preflight.py:155`：`if [ -e <path> ] ... echo 'targetPath.<path>=present' ...`
  - `deploy-preflight.py:199`：`('TARGET_PATH_ABSENT ' + path, facts.get('targetPath.' + path) == 'absent')`
  - `release-cleanup-remote.py:199-201`：`if path in (current['prefix'], current['rollbackPrefix']): keep(path, 'serving' ...)`
- 推测/风险：具体是否一定被拦还取决于 `cleanup before` 能否把某些路径移到失败证据目录；`newPrefix` 是 serving 时基本不会被删，因此我判断会拦。此条未在生产上验证。
- 建议：在 keep 的 `DEPLOY_ROLLBACK_SKIPPED` 文案里写清“同一包重试前需先 rollback 或人工清理目标路径”；或提供一个显式的 retry 流程，在操作者确认后清理失败现场。

## 侧重检查

- **错误路径**：查了 `deploy.sh` 的 lock、参数读取、preflight、S1/S2/S3/S6/S7/S8 失败分支、`result()` 的 cleanup 分支。非法 `ON_DEPLOY_FAILURE` 在连接服务器前以退出码 9 停止，服务器不动；有效的 keep 在 S2 之前失败仍走 `stopped-before-service-stop` 并照常 cleanup，行为未变。主要问题是最上面意见 1 的“S2 之后、开关启动之前”窗口。
- **不可信/不合规输入**：`historyComparison` 生成端校验了完整键集合、非空字符串、`cmsg_[A-Za-z0-9]+` 和 release 标签；JS 消费端再次校验键集合、模式、非空 reason/authorizedBy 和 release==label。差异是 JS 端没有重复校验 `cmsg_` 正则，属于“生成端更严、消费端更松”的两端不一致，但包被冻结且生成端是唯一正常来源，暂不构成实际绕过。
- **安全/不可撤销操作**：keep 会保留失败的新版本和所有副本，且不再自动恢复服务；环境变量可覆盖包内选择且没有授权记录。`failed-kept` 的退出码是失败步骤的非零码，仓库内没有自动消费者；Mac 外部监视流程是否把它当成“需要自动回滚”的错误，仓库里查不到，**未核实**。
- **资源耗尽**：keep 跳过失败后的 `release-cleanup`，保留整个失败版本、传输副本和证据；下一次 deploy 的 `cleanup before` 会再清理，但可能把上一次保留的现场当成可清理对象。连续失败时磁盘会暂时增长，长期是否可控取决于下一次是否还会运行 deploy，**部分推测**。
- **检查点逐一核对**：S3_COPY51、S7_DB_STATUS、S7_CONFIG_APPLY、S7_CATALOG_UPGRADE、S7_SWITCH_START、S8_READBACK 的 `verifyHistoryUnchanged`/`verifyHistoryAgainstRecoveryPoint` 都会因默认 off 跳过；S9_RAW_RESTORE51 也会跳过（意见 2）；`tidyDatabaseSidecars` 仍无条件比较 `history`，但服务已停止、只是 checkpoint 前后比较，本次预算表写入不会让它失败；`finalize-bindings.py`、`cloud-seal.mjs`、`S9-clean-transport.py` 不读历史行内容；`s8-history-preserved.json` 的唯一仓库内读取者 `S9-clean-transport.py` 只核对 `state` 路径/摘要，不要求 `tables` 或 ignored 列。
- **清单/占位符**：`make-packet.py` 在 `assemble()` 中先 `render()`，再 `regenerate_hashes()` 重算 `OWNED-SHA256SUMS`，最后冻结；因此修改 S7/maintenance 文件不会留下旧摘要。`twelfth-frozen-sha256.json` 是测试参照，改动文件已在 `INTENDED_CHANGES` 中，测试允许这些差异。模板中新增的 `__PKT_HISTORY_COMPARISON__`/`__PKT_HISTORY_COMPARISON_JSON__` 都会被替换，残留会被拒绝；`ON_DEPLOY_FAILURE` 只存在于 `packet-parameters.json`，不是模板占位符。
- **规则文件/文档一致**：`delivery-mode.md` 与 `incidents-and-gates.md` 记录了 keep 和关闭开关，但包内 `P-readback-design.md` 仍描述旧 S8 契约，且 `delivery-mode.md` 未写 S9 被关闭（意见 6）。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次改动全部在 `scripts/delivery-mode`、实例文件、测试和 `.agents` 说明文档里，没有改系统提示、工具定义、历史消息、遮盖逻辑或请求组装。模型请求仍然是只在末尾追加，每轮会变的值仍然只能放在最后一条消息里；切换开关和 `failed-kept` 都不进入模型请求路径。

2. **不会让模型请求里的同一段文字变成不同字节。** 没有模型侧文本被修改。部署证据里的 `startedAt`/`checkedAt` 是时间字段，但它们只写证据文件，不进入模型请求；`HISTORY_COMPARISON_JSON` 用 `sort_keys=True` 和固定分隔符生成，`historyComparisonEvidence` 的键顺序也固定，因此部署侧的序列化是确定的。KV 缓存规则不适用于本次改动。

3. **有自动检查，但覆盖不完整；本轮未执行测试**（权限只允许读文件和 git 查询）。新增门槛包括：`test_twentyninth_history_comparison_is_off_only_for_that_release`、`test_history_comparison_off_lets_a_migration_touch_preserved_tables`、`test_history_fixtures_pass_with_comparison_off_and_changed_history_rows`、`test_a_packet_whose_history_switch_names_another_release_refuses_to_load`，以及 `KeepFailedDeployTest` 的 keep/env 覆盖/缺省 rollback/上线前失败不变/非法取值不改动服务器。反向用例在修复前确实会失败，因为相关函数、参数和占位符此前不存在；`on` 模式仍拒绝触碰历史表和另一 release。缺口：没有 keep 在 S3/S7_CATALOG_UPGRADE 或 `HIMAWARI_DEPLOY_ACCEPTANCE_AFTER_STOP=1` 下的测试；没有“off 仍执行 S9 恢复历史比较”的测试（因为当前代码不执行）；没有“off 仍执行 S8 schema/authority 等非历史检查”的直接测试；测试 harness 继承真实环境，若 CI 环境设置了 `HIMAWARI_DEPLOY_ON_FAILURE` 会影响所有 deploy 测试。

4. **逐个值的两端核对结果：**
   - `historyComparison`（实例）→ `make-packet.history_comparison`：生成端校验键集合、非空、`cmsg_` 正则、release==label；消费端 `checkedHistoryComparison` 再校验键集合、模式、非空 reason/authorizedBy、release==label。能接受；JS 少一个 `cmsg_` 正则，但生成端更严。
   - `HISTORY_COMPARISON` → `schema_parameters` 的迁移拒绝开关和模板 `S7-switch-start-readback.py`、`verify-fixtures.mjs`：只允许 `on`/`off`，模板断言与参数一致。
   - `HISTORY_COMPARISON_JSON` → `maintenance-common.mjs` 的全局 `historyComparison`：Python 用排序 JSON 生成，JS 按同一形状校验；能接受。
   - `historyComparison` 证据字段（`historyComparisonReason/AuthorizedBy/Release`）→ `run-maintenance` 报告、S7 orchestration：仓库内没有强制读取这些字段的消费者；`S9-clean-transport.py` 只读 S8 的 `state`，不读 `tables`。off 模式的 `tables: null` 和缺失的 ignored 列不会让现有消费者失败，但与 `P-readback-design.md` 不一致（意见 6）。
   - `ON_DEPLOY_FAILURE`（参数）→ `deploy.sh`：`deploy.sh:57-60` 只接受 `rollback`/`keep`，缺失时默认 rollback，非法值在触碰服务器前退出 9；生成端 `deploy_failure_choice` 同样只接受这两个值。两端一致。
   - `onDeployFailure`（实例）→ 所有后续 andy-production 包：只有 `keep`，没有 release/授权字段，会被后续版本继承（意见 5）。
   - `failed-kept`（结果行）→ 测试和文档：仓库内没有自动消费者；Mac 外部监视流程是否识别这个新值**未核实**，需要确认它不会把非零退出码当成“应自动回滚”。
   - `DEPLOY_ON_FAILURE`、`DEPLOY_ROLLBACK_SKIPPED` 日志行 → 测试和文档：格式一致。
   - 清单项：`OWNED-SHA256SUMS` 由 `assemble()`/`freeze()` 的 `regenerate_hashes()` 在渲染后重算，修改的 S7/maintenance 文件摘要会自动更新；`twelfth-frozen-sha256.json` 中改动的文件都已在 `INTENDED_CHANGES`，测试按“允许变化”处理，不会因旧摘要失败。
