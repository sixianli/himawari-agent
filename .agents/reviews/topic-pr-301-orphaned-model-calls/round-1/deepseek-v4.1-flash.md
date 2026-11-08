## 结论摘要

方案的**核心方向（用 fencing token 证明旧进程不可能再写）在正确的比较对象下成立**，但草稿里有几处会直接导致修不到目标场景、或写进去后读不出来的问题。最严重的是：

1. 令牌比较对象写成了“部署当前的 fencing_token”，代码里同一 Agent 可能已经切到新 deployment，记录里的旧 deployment 行仍是 retired；按记录自己的 deployment 比较会误判为“还活着”。
2. 只改 `RUN_EXPIRED_RECONCILIATION_SQL` 的第三种情况，第二种“有已过期沙箱记录”的分支根本不检查 `reserved/started`，仍可能在活着的模型调用还在写时提前收尾，且不会清理旧调用。
3. 漏掉 `SERVICE_STOPPING` 等崩溃/中断诊断码。
4. 新原因码 `owner_lost` 只改表约束不够，读取端、端口类型、许可校验、测试都会在写进去之后读不出来或类型不通过（正是 I-73 的教训）。
5. 在 `settleExpired` 里直接写预算表会绕过现有的 revision CAS、金额约束和 `observed_at/released_at` 约束，建议做成专用事务内操作而不是裸 SQL。

不建议按草稿直接实施；建议改成“专用事务内清理 + 覆盖所有收尾分支/诊断码 + 完整更新消费端 + 真正的反向测试”。

---

## 一、已证实的问题（按严重度）

### 1.（高）令牌比较对象有歧义；按“记录自己的 deployment”比较会在授权转移后误判

**问题**：草稿说“记录里的 `authority_fencing_token` 小于部署当前的 `fencing_token`”。如果“部署当前”指记录里的 `authority_deployment_id` 那一行，则授权转移后不成立：旧 deployment 被置为 `retired`，它的 `fencing_token` 不再更新，记录里的 token 会和它相等，于是被判成“原进程还持有授权”，永远不收尾。

**证据**：
- `packages/persistence-sqlite/src/sqlite-worker.ts:484-497`：`previousToken = MAX(fencing_token) WHERE agent_id = ?`，新 lease 的 token = `previousToken + 1`，并 `UPDATE deployments SET fencing_token = ? WHERE id = ?`。
- `packages/persistence-sqlite/src/sqlite-authority-transfer.ts:925-942`：源 deployment 改为 `retired`；目标 deployment 写 `authority_epoch = ?`、`fencing_token = sourceFencingToken + 1`。旧 deployment 的 token 不变。
- `packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:789-825`：真正判断“当前授权”的是 `l.deployment_id = ?`、`d.status='active'`、`authority_epoch = deploymentEpoch`、`fencingToken = scope.authority.fencingToken` 且 `deploymentToken = scope.authority.fencingToken`、`expiresAt > at`、`releasedAt IS NULL`。记录里的旧 deployment 行即使 token 相等，`status` 已是 `retired`，旧进程也写不进来。

**建议**：不要按记录自己的 deployment 查 token。改成以下任一更直接的判断：
- 与收尾进程的当前授权 fence 比较：`(record.authority_deployment_id, record.authority_epoch, record.authority_fencing_token) != (scope.authority.deploymentId, scope.authority.authorityEpoch, scope.authority.fencingToken)`；或
- 更语义化：检查记录里的 `authority_lease_id` 是否还存在一条**仍 live** 的授权租约（`released_at IS NULL AND expires_at > at`，且 `deployments.status='active'`、deployment/epoch/token 与记录一致）。不存在即“原执行者不可能再写”。

第二种写法还能覆盖“授权已释放但新进程尚未 claim、token 没变”的情况，比 `<` 更精确。

### 2.（高）只改第三种情况，第二种“已过期沙箱记录”分支仍可提前收尾

**问题**：`RUN_EXPIRED_RECONCILIATION_SQL` 的第二种情况（存在已过期沙箱记录、没有未过期/空期限记录）**完全没有检查 `model_invocation_identities` 的 `reserved/started`**。因此一个崩溃的运行只要有已过期沙箱记录，即使仍有活着的 `started` 模型调用，也可能被提前收尾；之后旧进程再想 `settle`，Run 已是 `failed`，记录会永远停在 `started`。草稿只改第三种情况，修不到这一类。

**证据**：
- `packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:59-65`：第二分支只有沙箱记录条件，没有模型调用条件。
- `packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:66-72`：第三分支才有 `NOT EXISTS (... status IN ('reserved','started'))`。
- `packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts:415-417`：`settleExpired` 只阻止“仍有 live 的 run execution lease”，不检查授权租约是否 live；所以“run execution lease 过期、但进程仍持有并续期授权”的情况确实能落进收尾。
- `packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:639-674`：`settle` 只校验当前授权和冻结的执行租约，不校验 run 状态；所以收尾后旧进程理论上仍可 `settle`，但若 Run 已 failed，页面/状态已经结束，记录仍可能长期不一致。

**建议**：不要只改第三分支。要么把“没有 live/current-fence 的 `reserved/started` 调用”作为**所有收尾分支共同的条件**；要么在 `settleExpired` 的同一个事务里，对所有分支都执行“清理已放弃调用”的逻辑，并在第二分支也阻止 current-fence 的 `started`。

### 3.（高）漏掉 `SERVICE_STOPPING`，崩溃/中断诊断码集合不完整

**问题**：草稿把第三种情况的诊断码扩大到 `PERSISTED_EXECUTION_RECONCILIATION_REQUIRED` 和 `RUNTIME_ATTEMPT_INTERRUPTED`，但现有代码里“中断/未知”这一类本来还有 `SERVICE_STOPPING`（以及 `RUNTIME_TOOL_RESULT_UNKNOWN` 在另一分支）。优雅停服/调度器中断留下的 `started` 调用，配合 `SERVICE_STOPPING` 诊断码时，仍会卡住。

**证据**：
- `packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:8`：现有中断集合是 `RUNTIME_TOOL_RESULT_UNKNOWN, RUNTIME_ATTEMPT_INTERRUPTED, PERSISTED_EXECUTION_RECONCILIATION_REQUIRED, SERVICE_STOPPING`。
- `apps/agent-service/src/production-run-dispatcher.ts:556` 把 `SERVICE_STOPPING` 交给 `reconcileLeaseFailure`，随后经 `reconcileUnknown` → `reconcile` → `quarantine` 写入 checkpoint 诊断码（`sqlite-run-dispatch-operations.ts:597-615`）。
- `apps/agent-service/src/production-tool-result-recovery.ts:87-92` 也把 `SERVICE_STOPPING` 当作可恢复的中断状态。

**建议**：从现有的 `SANDBOX_TOOL_RESULT_RECOVERY_SQL` 的同一集合派生，不要手写两个码；至少加上 `SERVICE_STOPPING`。同时明确 `RUNTIME_COMPLETION_OUTPUT_MISSING`、`RUN_RESOURCE_CLEANUP_UNCONFIRMED` 是否在范围内，不要漏在中间。

### 4.（高）`owner_lost` 的消费端没有列全，写进去后会在读取端失败（I-73）

**问题**：草稿只说了两张表的 CHECK 约束，但 `owner_lost` 还会被这些地方校验/读取：
- `packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:37-41` 的 `UNKNOWN_REASONS`，以及 `:183-192` 的 `unknownReason`（`parseRow` 用它解析任何 `reason_code`）。
- `packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:79`、`:938-945` 的 `parseUnknown`、`:1303-1311` 的 `parseAllocation`。
- `packages/application/src/ports/model-invocation.ts:47-49`、`packages/application/src/ports/model-budget.ts:75,121` 的联合类型。
- `packages/application/src/services/model-invocation-admission-service.ts:564-580` 的 `permit.markUnknown` 白名单。
- 迁移 `packages/persistence-sqlite/src/migrations/0049_thread_title_budget.sql:68-70`（allocation）和 `:141-143`（identity）的 CHECK。

如果收尾代码用裸 SQL 直接写 `owner_lost`，写的时候能过（迁移已改），但之后 `modelInvocation.read` / `modelBudget.read` 会在 `parseRow`/`parseAllocation` 抛 `PORT_INVALID_OPERATION`；任何后台对账读这两个表也会失败。这正是 I-73 说的“清单里的 id 能通过后端校验吗”。

**建议**：把 `owner_lost` 加到上述**每一个**产生/校验/读取点，并加一条“写入后用 `modelInvocation.read`/`modelBudget.read` 读回”的集成测试。另：草稿说“两张表（以及按同样约束建的标题、记忆预算表）”，实际上不存在单独的标题/记忆预算表；`model_budget_accounts` 用 `parent_kind` 区分 `run/occurrence/memory-projection/thread-title`，`model_budget_allocations` 和 `model_invocation_identities` 是共用的（`0049_thread_title_budget.sql:11,30-41,50-83,91-176`）。只有两张表要改约束，但 `model_invocation_identities` 只覆盖 run/thread-title 调用；occurrence 和 memory-projection 的预算分配没有 invocation identity，草稿的“旧调用”范围要写清楚。

### 5.（中高）在 `settleExpired` 里直接写预算表会绕过现有账本不变量

**问题**：`SqliteRunDispatchOperations` 的构造器/`execute` 没有 `SqliteModelBudgetOperations` 依赖（`sqlite-run-dispatch-operations.ts:161-217`），`settleExpired` 目前只写 Run、checkpoint、execution lease 和回执（`:391-541`）。如果为了“同一个事务”在 `settleExpired` 里直接写 `model_invocation_identities`/`model_budget_allocations`/`model_budget_accounts`，会重复实现：
- `updateAccount` 的 `revision` CAS 和 `reserved + spent` 上限（`sqlite-model-budget-operations.ts:1191-1219`）；
- `releaseReservedWithinTransaction` 的预留扣减（`:716-756`）；
- `markUnknownWithinTransaction` 的 account 状态和 allocation 约束（`:660-707`）；
- `model_invocation_identities` 的 `released_at`、`observed_at`、`started_at` CHECK（`0049:159-171`）。

任何一条漏写，SQLite 会直接拒绝，或者账本金额/状态不一致。

**建议**：不要裸 SQL。增加一个事务内专用方法（例如 `abandonRunInvocationsWithinTransaction(scope, runId, at)`），由它调用现有的 `releaseReservedWithinTransaction` / `markUnknownWithinTransaction` / `updateAccount`，并由 `settleExpired` 在同一个 `BEGIN IMMEDIATE` 事务里调用；或者把 Run 收尾和模型调用清理放到一个同时持有两个领域对象的组合层。

### 6.（中高）并发/幂等：旧进程可能在候选查询和收尾事务之间完成 settle

**问题**：`listReconciliationRequired` 在事务外列出候选；虽然 `settleExpired` 在事务内重新检查 `RUN_EXPIRED_RECONCILIATION_SQL`，但如果旧进程在两次读取之间把 `started` 结清，收尾代码若“无条件把调用改成 unknown / 无条件把账户改成 reconcile_required”，就会把已经结算的账重新标成待对账，或者让 account 状态和子分配不一致。

**证据**：`settle` 只校验当前授权和冻结的执行租约，不校验 Run 状态（`sqlite-model-invocation-operations.ts:639-674`），所以收尾后旧进程仍可能 settle；`updateAccount` 用 revision CAS，重复/错误更新会抛冲突（`sqlite-model-budget-operations.ts:1199-1214`）。

**建议**：
- 所有更新都带 `WHERE status IN ('reserved','started')` 并检查 `changes`；
- 在同一事务内先读当前状态，再决定改不改；
- 账户状态只在确实有新 unknown 时置 `reconcile_required`；
- 依赖现有的 revision CAS，不要自己算 revision；
- 测试“候选列出后、收尾前调用被 settle”的并发场景。

### 7.（中）用“token 小于”而不是“fence 不等于”不够稳，且 `authority_epoch` 不能替代 token

**问题**：
- `assertCurrentAuthority` 要求的是**完全相等**（`sqlite-model-invocation-operations.ts:813-825`）。用 `<` 只覆盖“旧 token 更小”的情况；恢复/回滚导致当前 token 比记录更小时，不会判为已放弃。`docs/backlog/BL-20261027-008-config-change-preflight-and-verified-rollback.md:34` 记录过一次数据库被退回旧 token、镜像文件仍是新 token 的真实回滚问题。
- 同一 deployment 重启时 `authority_epoch` 不变（`sqlite-worker.ts:476-517` 只改 `fencing_token`），所以 epoch 只能补充“换 deployment”，不能替代 token。
- 建议直接判断“记录里的授权是否仍是 live lease”，或至少用 `deployment/epoch/token` 三元组不等，而不是 `<`。

**证据**：
- `packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:22-28`：`UNIQUE(agent_id, authority_epoch)`、`deployments_one_active_agent`；epoch 唯一但重启不变。
- `sqlite-worker.ts:484-497`、`sqlite-authority-transfer.ts:931-942`：token 单调递增；同一 deployment 重启只加 token。
- `docs/backlog/BL-20261027-008-config-change-preflight-and-verified-rollback.md:34`：回滚后 DB 38 / 镜像 39，启动检查拒绝。

**建议**：采用“记录里的 `authority_lease_id` 是否仍 live”作为判定；如果坚持用 fence，改成 `NOT (deployment_id = current AND epoch = current AND token = current)`，并在文档里写明“恢复/回滚必须让数据库和 authority.json 一致”。

### 8.（中）测试的反向用例不构成真正的反证

**问题**：草稿说“去掉令牌比较时，‘原进程还活着’场景必须失败”。但现有测试的模型调用都是拿当前唯一的 `authority_leases` 行插入的（`test/integration/sqlite-sandbox-execution-v2.test.ts:1216-1291`），`deadline-code-model-started`（`:1063`）用的就是当前 token。即使没有新的令牌判断，这个场景也会因为“有 `started` 调用”而拒绝收尾，所以它不能证明新判断有效。要真正反证，必须构造“旧 token 且只有这个条件阻止收尾”的场景。

**建议**：新增两套独立场景：
- **旧 fence**：插入/构造旧 lease（或把 deployment 和 authority lease 推进到新 token，并用新 scope 收尾），调用 `started`/`reserved`；去掉 fence 判断后，这个场景必须失败（即改前不能收尾，改后能收尾）。
- **当前 fence**：所有其他条件满足（截止已过、无沙箱记录、资源已释放），只有 `started` 调用是 current fence；去掉 fence 判断后，它必须被错误收尾，用这个来证明反向用例真的会失败。
- 另外补：`SERVICE_STOPPING`、第二分支（有已过期沙箱记录 + `started`）、authority 转移后的 retired deployment、`owner_lost` 读回解析、迁移后 CHECK 接受新原因码、并发 settle。

### 9.（中）和 I-88 / ADR 的既有决定不一致，文档没有说要改

**问题**：I-88 明确写着：“`reserved`、`started` 的模型调用不挡收尾（只对第三种情况生效，另两种情况仍把 `unknown` 当未决），这次调用和预算账户保持原样，没有自动对账，仅作记录，预估费用不释放”。草稿现在要把 `started` 主动改成 `unknown`，这是政策变化，必须写入事故/ADR/门槛，否则规则文件和代码会不一致。

**证据**：
- `docs/incidents-and-gates.md:123`（I-88 的处置和结论）。
- `docs/adr/0124-unknown-model-call-blocks-only-its-own-resend.md:55-57`：账户 `reconcile_required` 时仍接受同一轮其他调用，但整轮重新派发和后台 occurrence 恢复会被挡；草稿需要确认“Run 已在同一事务失败”所以不会留下不可派发状态。
- `docs/adr/0140-settle-early-only-without-recoverable-result.md:39`：提前收尾要求没有未决的模型调用；草稿只改截止分支，需说明该 ADR 是否仍成立。
- runbook 多处写“到期收尾原因 `RUN_EXECUTION_DEADLINE_EXCEEDED`”（例如 `docs/runbooks/install-start-stop-runbook.md:324`）。`settleExpired` 的 `settleExpired` 在 `at >= deadlineAt` 时仍会把 checkpoint 诊断码覆盖成 `RUN_EXECUTION_DEADLINE_EXCEEDED`（`sqlite-run-dispatch-operations.ts:490-503`），所以最终状态描述大体仍成立，但 `owner_lost` 只留在调用记录里，文档要写清楚。

**建议**：新增或修订 ADR/事故条目，更新 I-88、ADR 0124/0140 的相关段落和 runbook；把“owner_lost 只改调用记录，不改 Run 最终诊断码”写成明确合同。

### 10.（中）业界引用不准确：Temporal/Stripe 不支持“共同点是用信号证明原执行者不能再写”

**问题**：草稿说 Temporal 和 Stripe 的共同点是“用一个能证明原执行者不可能再写入的信号来判定任务已放弃”。一手资料并不支持这个总结：
- Temporal 的原话是 **“The Temporal Server doesn't detect failures when a Worker loses communication with the Server or crashes. Therefore, the Temporal Server relies on the Start-To-Close Timeout to force Activity retries.”**（https://docs.temporal.io/encyclopedia/detecting-activity-failures）。它说的是**超时判定失败**，不是 fencing token 证明旧 worker 不能写。
- Stripe 说的是幂等键让重试安全：**“safely repeat the request without risk of creating a second object or performing the update twice”**（https://docs.stripe.com/api/idempotent_requests）。它不涉及“原执行者不能写”。
- 真正支持“fencing token”的是一手分布式系统资料：Martin Kleppmann 的 **“include a fencing token with every write request … the storage server remembers that it has already processed a write with a higher token number … and rejects the request with token 33”**，以及 **“timeouts ... are just a guess that something is wrong”**（https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html）。
- 草稿说“ChatGPT/Claude 生成途中故障时用户看到出错、费用服务端对账”，没有给一手来源，应标为未核实或删掉。

**建议**：把“业界做法”改成分三层：Temporal 用超时判定失败；Stripe 用幂等键保证重试安全；Himawari 用 fencing token 保证旧执行者写不进来。不要把三者混成一个“共同点”。同时引用 Kleppmann 作为 fencing 的直接依据，并保留其“超时只是猜测、不能证明对方死了”的警告。

### 11.（低）把“标题、记忆预算表”当成独立表，迁移成本估计不对

**问题**：草稿说“两张表（以及按同样约束建的标题、记忆预算表）的原因码约束要加 `owner_lost`”。实际上没有独立的标题/记忆预算表；只有 `model_budget_accounts`（用 `parent_kind` 区分）、`model_budget_allocations`、`model_invocation_identities` 三张表，其中后两张有 `reason_code` CHECK。需要重建的是**两张**表，不是四张。另外 `model_invocation_identities` 只覆盖 run/thread-title 调用；occurrence/memory-projection 的预算分配没有 invocation identity，草稿没有覆盖这一类。

**证据**：
- `packages/persistence-sqlite/src/migrations/0049_thread_title_budget.sql:7-48`（accounts 的 parent_kind）、`:50-83`（allocations）、`:91-176`（identities）。
- `packages/application/src/services/model-invocation-admission-service.ts:490-495`：`budgetAccount` 只允许 `run`/`thread-title`。
- `packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:218-344`：occurrence 等路径直接建预算账户/分配，不经过 `model_invocation_identities`。

**建议**：把迁移范围写准确；如果目标只是 Run 自己的调用，就明确 occurrence/memory-projection 不在范围；如果要全面修，需要为它们设计单独的恢复路径。

### 12.（低）新增迁移还要改迁移引擎、序列号和文档

**问题**：草稿只说“上线包重新生成并多一次数据库迁移”。实际还要更新：
- `packages/persistence-sqlite/src/migration-engine.ts:633-647` 的硬编码 `bundledMigrationFiles` 和 `LATEST_MIGRATION_SEQUENCE`（`:649-650`）；
- 迁移合约测试（`packages/persistence-sqlite/test/migration-engine.contract.test.ts` 等）中的 sequence/摘要断言；
- `docs/architecture-v0.1.md:296` 的“三十一个连续 SQL migration”等说明。

**建议**：把这些纳入实施清单，不要只算“写一个 SQL 文件”。

### 13.（低）“根因修复”说法过大

**问题**：草稿说这是根因修复。实际上它只覆盖“运行到期收尾 + 第三种诊断码 + 没有沙箱记录”这一小类。带沙箱记录的运行、`RUNTIME_TOOL_RESULT_UNKNOWN` 分支、occurrence/memory-projection 的调用、以及还没到截止时间的运行，根因仍在。

**建议**：把“根因修复”改成“针对 PR 301/I-88 这一类场景的收尾修复”，或者把范围扩展到所有分支和所有调用类型。

---

## 二、推测 / 需要验证的问题

以下不是从代码直接证实的，而是方案文字不明确或需要运行/生产数据才能确认的：

1. **草稿里的“部署当前”到底指哪一行 deployment**：如果实现者理解成记录里的 `authority_deployment_id`，就会触发上面第 1 条；如果理解成当前 active deployment，则核心判断成立。方案必须写清楚。
2. **“旧进程卡住但没死、授权过期但 token 没变”时，新的收尾进程是否一定已经 claim 了新 lease**：按 `settleExpired` 的 `assertCurrentAuthority`（`sqlite-run-dispatch-operations.ts:406-408`）它必须持有 live 授权，因此正常路径下 token 已经变了；但方案没有把这作为前提写出来。
3. **`recover` 在所有崩溃时序下是否一定把诊断码写成 `PERSISTED_EXECUTION_RECONCILIATION_REQUIRED`/`RUNTIME_ATTEMPT_INTERRUPTED`**：`production-run-dispatcher.ts:283-322` 和 `production-run-reconciler.ts:22-37` 显示会走 `quarantine`，但具体时序（例如先被 deadline 打断、再被 recover 覆盖）需要测试确认。
4. **`SERVICE_STOPPING` 是否在所有优雅停服路径都真的落成 checkpoint 诊断码**：代码路径看起来是，但没有逐个停服时序验证。
5. **授权转移后旧进程是否还会尝试写模型调用**：`production-authority-lifecycle.ts:499-506` 的 `onLost` 会触发 `service-main.ts:722-728` 的 `stopReverseServices`，看起来会停服；但旧进程在收到停止信号前的短暂窗口需要测试确认。
6. **恢复/回滚导致 token 回退时，当前数据库和 `authority.json` 是否一定一致**：`BL-20261027-008` 记录过一次不一致；如果一致，`<` 判断在正常恢复下问题不大，但方案依赖这个前提。

---

## 三、侧重检查

### 错误路径

- **迁移失败/回滚**：重建 `model_invocation_identities` 和 `model_budget_allocations` 需要 copy → drop → create → insert（`0025`, `0049` 的模式）。要检查外键顺序、`PRAGMA foreign_keys`、磁盘余量、失败回滚；PA-4 占着迁移槽时不能并发做。
- **收尾事务失败**：`settleExpired` 已有整体 transaction（`sqlite-run-dispatch-operations.ts:406-540`）；新增的调用/预算更新必须留在同一个事务里，否则会出现“调用已 released，Run 还没 failed”或反过来。
- **并发 settle**：见第 6 条；需要条件更新和 `changes` 检查。
- **授权丢失/过期**：`assertCurrentAuthority` 已经覆盖；但新判断必须与它一致，不能只用 token 大小。
- **缺 allocation / 缺 account**：`model_invocation_identities` 对 allocation 有外键，正常不会缺；但要处理“记录存在但预算行已被级联删除”的异常路径，不能静默成功。
- **重复收尾**：`settleExpired` 对已 failed 的 Run 返回 `{settled:false}`（`:412`），但调用/预算更新必须同样幂等。

### 不合规范或不可信输入

- 收尾路径不接收用户输入，主要是数据库值；但新 SQL 必须参数化，且必须按 `owner_id/agent_id/run_id` 限定，不能只按 `invocation_id`。
- `reason_code='owner_lost'` 必须同时通过 DB CHECK 和两层应用解析；不要只在写入端加。
- 新的诊断码集合必须来自同一个常量/同一处定义，避免 `SERVICE_STOPPING` 这种漏项。

### 安全

- **核心不变量**：同一 Agent 同一时间只有一个 live 授权（`sqlite-worker.ts:462-475` 的 `currentLease` + `BEGIN IMMEDIATE`；`0001:26-28` 的 `deployments_one_active_agent`）。旧进程的写路径都在 `BEGIN IMMEDIATE` 内检查 `assertCurrentAuthority`（`sqlite-model-invocation-operations.ts:553-559,594-599,631-637,676-682`；`sqlite-model-budget-operations.ts:449,561,599,665,721`），所以“记录里的授权不再 live ⇒ 旧进程写不进来”成立。这是方案最可靠的部分。
- **但**：必须比较“记录里的授权租约是否仍 live”，而不是记录 deployment 的 token；授权转移后旧 deployment 的 token 不变（`sqlite-authority-transfer.ts:925-942`）。
- **恢复/回滚**：要遵守 `docs/backlog/BL-20261027-008...md:34` 的教训，确保数据库和 `authority.json` 一致；否则 token 比较会误判。
- **越权范围**：`settleExpired` 已经限定 scope；新增更新不要引入跨 owner/agent 的批量 UPDATE。

### 资源耗尽

- 迁移会复制两张可能有大量历史记录的表，需检查临时空间和迁移时长；`SqliteModelBudgetOperations.runImmediateTransaction` 的 `assertDiskHeadroom`（`:186-189`）只覆盖运行期，不覆盖迁移。
- 新的收尾 SQL 会为每个 Run 增加 `NOT EXISTS`/子查询；`model_invocation_identities_scope(owner_id, agent_id, run_id, ...)`（`0049:179`）能支撑按 Run 查询，但要避免在候选查询里做全表扫描。
- 候选查询有 `LIMIT`，收尾逐条处理，没有无界循环。

### 不可撤销的操作

- `reserved → released`：释放预留、退回金额，前提是 `reserved` 从未发出（`trusted-model-provider.ts:201-204` 和 `pi-runtime-adapter.ts:1028-1041` 都是先 `markStarted` 再调用 transport），这个前提成立。
- `started → unknown`：保守保留预估费用，账户 `reconcile_required`，不猜测实际花费；之后旧进程若还活着并仍有授权，理论上可以 `settle`（`unknown` 允许 settle），所以不是完全不可逆。
- 但“把 live 调用误标成 unknown 并把 Run failed”对用户是不可逆的体验；所以 fence 判断必须精确，不能用模糊的 `<` 或错误的 deployment 行。

### 规则文件、说明文档和代码一致性

- **prompt-prefix 规则**：不受影响，见必答 1/2。
- **I-88**：与草稿的政策变化冲突，必须更新。
- **ADR 0124 / 0076 / 0140**：需要说明账户 `reconcile_required` 的影响和提前收尾条件的变化。
- **runbook**：到期收尾原因、`owner_lost` 的新语义要同步。
- **migration engine / architecture 文档**：新增迁移要同步。

---

## 四、如果由我来定，我会怎样改这份方案

1. **先做一个明确的判定原语**：在同一个 `BEGIN IMMEDIATE` 事务里，对 Run 的每条 `reserved/started` 调用判断“记录里的 `authority_lease_id` 是否仍对应一条 live 授权租约（未释放、未过期、deployment active、epoch/token 匹配）”。不是 `token < 当前 token`，而是“原授权已不 live”。这直接对应 Kleppmann 的 fencing 语义，也避开授权转移和回滚的大小比较问题。

2. **把清理放进专用事务内操作**：在 `SqliteModelInvocationOperations` / `SqliteModelBudgetOperations` 增加 `abandonRunInvocationsWithinTransaction`，由 `settleExpired` 在同一个事务里调用。它只处理本 Run 的记录，复用现有 `releaseReservedWithinTransaction` / `markUnknownWithinTransaction` / `updateAccount`，不写裸 SQL。

3. **覆盖所有收尾分支**：不只第三分支。第二分支也要么要求“没有 live 的 `reserved/started`”，要么同样执行清理；第一分支如果保留“没有未决调用”的条件，则要明确“已放弃调用是否也算未决”。从“记录说真话”原则出发，建议所有分支都使用同一个“已放弃则清理、未放弃则挡住”的谓词。

4. **诊断码集合从现有常量派生**：至少包含 `RUNTIME_TOOL_RESULT_UNKNOWN`、`RUNTIME_ATTEMPT_INTERRUPTED`、`PERSISTED_EXECUTION_RECONCILIATION_REQUIRED`、`SERVICE_STOPPING`；明确 `RUNTIME_COMPLETION_OUTPUT_MISSING`、`RUN_RESOURCE_CLEANUP_UNCONFIRMED` 是否在范围。

5. **原因码分两步走**：
   - **短期（PA-4 未合并）**：如果必须马上修，采用“不新增原因码”的临时方案，但不要用 `transport_unresolved`。对 `started` 用 `unknown` + `cancel_unresolved`（语义是“这次运行到期/被服务取消，结果未确认”），并在 Run 的 checkpoint/诊断码或审计回执里记录 `owner_lost`，同时在页面/日志明确标注这是 owner lost，不是网络中断。这只是临时近似，要写进 ADR。
   - **PA-4 合并后**：加 `owner_lost` 到两张表的 CHECK，并更新所有解析/类型/测试；这是最终方案。
   - 如果 Andy 认为“临时近似”也不可接受，那就等 PA-4，在这之前只做**不改变调用记录**的 Run 收尾（方案 2），并在文档里明确“记录仍是 started，是已知的临时缺口”。

6. **补全测试**：
   - 旧 fence 的 `reserved`/`started` → 收尾并转 `released`/`unknown`；
   - 当前 fence 的 `started` → 不收尾；
   - 截止前不收尾；
   - 有沙箱记录的第二分支 + `started`；
   - `SERVICE_STOPPING`；
   - authority transfer（retired deployment）；
   - 读回 `modelInvocation.read` / `modelBudget.read`；
   - 迁移后 CHECK 接受 `owner_lost`；
   - 并发 settle；
   - 反向：去掉 fence 判断后，当前 fence 场景必须被错误收尾。

7. **文档**：更新 I-88 / ADR 0124 / 0140 / runbook；在 `docs/incidents-and-gates.md` 加新的门槛条目，并把测试命令挂进现有的 `npm run check` 或集成测试流程。

---

## 五、必答问题逐条回答

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 这个方案只改数据库里的 Run、模型调用、预算记录和收尾事件，不会改系统提示、工具定义、历史消息或遮盖结果。`settleExpired` 的整个事务（`sqlite-run-dispatch-operations.ts:391-541`）没有调用模型，也不生成发给模型的内容；新原因码/状态不是模型请求的一部分。因此发给模型的内容仍然只在末尾追加，每轮会变的值仍应在最后一条用户消息里。**但要注意**：如果后续 UI 把“本轮失败/owner lost”做成一条新的用户或系统消息插入历史，必须仍然只在末尾追加，不能改写此前的消息；这不在本方案范围内，实施时要单独检查。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 方案不产生模型可见文本，`owner_lost` 只是数据库枚举，不参与提示词序列化；收尾时间 `at` 也不进入模型请求。没有依赖前后文的遮盖、带时间的字段或无序集合。前提是实施时不要把新状态/原因码拼进系统提示或工具定义。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**目前不够。** 草稿列了正向场景，但缺少：
- `owner_lost` 的**读回**测试（`modelInvocation.read` / `modelBudget.read`）；
- 第二分支（有已过期沙箱记录 + `started`）的测试；
- `SERVICE_STOPPING`、authority transfer（retired deployment）的测试；
- 迁移后 CHECK 接受新原因码的合约测试；
- 并发 settle 测试；
- 真正的反向用例构造。

现有测试的模型调用都是拿当前唯一的 authority lease 插入的（`test/integration/sqlite-sandbox-execution-v2.test.ts:1216-1291`），`deadline-code-model-started`（`:1063`）即使删掉新的 fence 判断也会因为“有 started 调用”而拒绝收尾，所以它不能作为新逻辑的反证。要证明反向用例真的会失败，必须构造“旧 fence + 其他条件全部满足，只有 fence 判断阻止收尾”的场景，以及“当前 fence + 其他条件全部满足，去掉 fence 判断就会错误收尾”的场景。

### 4. 每个值的使用两端都能接受吗？

逐个核对如下：

- **`owner_lost`**：
  - 产生端：收尾事务写 `model_invocation_identities.reason_code` 和 `model_budget_allocations.reason_code`。
  - 使用端：两表 CHECK（`migrations/0049_thread_title_budget.sql:68-70,141-143`）、`sqlite-model-invocation-operations.ts:37-41,183-192`、`sqlite-model-budget-operations.ts:79,938-945,1303-1311`、`packages/application/src/ports/model-invocation.ts:47-49`、`model-budget.ts:75,121`、`model-invocation-admission-service.ts:564-580`。
  - 结论：**必须全部更新，否则读回会失败**。草稿没有列全，是 I-73 类问题。

- **`released` / `unknown` 状态**：
  - 两表 CHECK 已允许（`0049:63,132`）。
  - `released` 要求 `released_at IS NOT NULL` 且 `started_at IS NULL`（`0049:164-171`）；`unknown` 要求 `observed_at IS NOT NULL` 且 `started_at IS NOT NULL`（`0049:163,169-171`）。
  - 预算 `unknown` 要求 `observed_at IS NOT NULL`（`0049:82`）。
  - 结论：实施时必须写全这些字段；草稿只说“改成 released/unknown”，没有提这些约束。

- **预算账户 `reconcile_required`**：
  - 表 CHECK 已允许（`0049:22`）。
  - 使用端：`sqlite-run-dispatch-operations.ts:264-270` 和 `:1084-1095` 会阻止该 Run 重新派发；`sqlite-durable-operations.ts:1112-1163` 会阻止对应 occurrence 恢复。
  - 结论：账户是按 Run/occurrence/memory-projection/thread-title 分开的（`sqlite-model-budget-operations.ts:1546-1554`），**不会**让整个部署之后的调用都被拦住。对 Run 来说，ADR 0124 明确说 `reconcile_required` 只挡整轮重新派发，不挡同一轮其他调用；而且本方案会在同一事务把 Run 置 failed，所以不会留下“Run 还在跑但账户待对账”的长期状态。前提是调用清理和 Run 收尾在**同一个事务**里，否则中途失败会留下账户待对账但 Run 未失败，重新派发被挡。

- **`authority_fencing_token` / `authority_epoch`**：
  - 产生端：`sqlite-model-invocation-operations.ts:533-543` 从 begin 输入复制，并有 CHECK 要求与 execution 字段一致（`0049:172-175`）。
  - 使用端：`assertCurrentAuthority`（`sqlite-model-invocation-operations.ts:789-825`）要求与当前 deployment/lease 完全相等；新收尾判断也必须用同一个 fence。
  - 结论：记录里的值本身没问题；问题在于比较对象必须是**当前 active deployment / 当前 live lease**，不是记录自己的 deployment 行。

- **迁移文件/序列号**：产生端是 `migration-engine.ts` 的硬编码列表和 `LATEST_MIGRATION_SEQUENCE`；使用端是迁移测试和 `docs/architecture-v0.1.md`。草稿只提“多一次迁移”，没有提这些使用端，需要补齐。

---

**总的建议**：方案方向可取，但请把“fence 判定”写精确（用记录授权是否仍 live，而不是 token 大小）、覆盖所有收尾分支和所有中断诊断码、把清理放进专用事务内操作、完整更新 `owner_lost` 的读取端和测试，并把 I-88/ADR/runbook 一起改。否则即使按草稿实现了，仍会在授权转移、带沙箱记录、`SERVICE_STOPPING` 和读回路径上留下新的“进行中”或读写失败。
