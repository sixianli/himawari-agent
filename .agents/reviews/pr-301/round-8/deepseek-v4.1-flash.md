## 侧重检查

- **错误路径 / 不可信输入**：查了 `owner_lost` 的写入与解析两端（`sqlite-model-invocation-operations.ts`、`sqlite-model-budget-operations.ts`）、迁移 CHECK、以及公共 `markUnknown` 输入白名单。公共入口仍拒绝 `owner_lost`，这是有意的；只有收尾内部方法能写。
- **安全 / 授权**：查了事务内 `assertCurrentAuthority`、`abandonOrphanedWithinTransaction` 的租约过滤、`claimLease` 的单活租约逻辑、`authority_leases` 表的约束。主要路径成立；发现一处依赖应用层不变量的风险（见发现 1）。
- **资源耗尽**：接手查询按 run 取全部 `reserved/started` 行后循环更新，没有上限；行数由本 run 的模型调用数决定，不是外部输入，风险低，未单列。
- **不可撤销操作**：`started → unknown(owner_lost)` 后原因码不可改、预算账户进 `reconcile_required`。判定正确时这是如实的；判定错误时会静默留下需人工核对的账户。发现 1 和 3 与此有关。
- **文档 / 规则一致性**：I-88 的正文与代码一致（顶层按当前授权租约过滤、第一种情况仍把 `unknown` 当未决、第三种情况五个诊断码、接手方法在 `settleExpiredSync` 调用）。`.claude/rules/prompt-prefix.md` 未改动。`.agents/reviews/pr-301/plan-orphaned-model-calls.md` 在本次可读范围内取不到（记录路径被 git 包装拒绝），未核实。

## 发现

### 低（推测，依赖应用层不变量）— 失权判定只看租约 id，不检查旧租约是否真的失效
**文件:行**：`packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:757-762`
**问题**：接手查询只按 `authority_lease_id <> ?` 判定“原进程已失去授权”，没有要求旧租约已 `released` / 已过期 / 属于更旧部署。数据库层也没有“每个 agent 只有一条 live authority lease”的唯一约束。
**证据（读代码证实）**：
```sql
SELECT * FROM model_invocation_identities
 WHERE owner_id = ? AND agent_id = ? AND run_id = ?
   AND status IN ('reserved', 'started') AND authority_lease_id <> ?
 ORDER BY logical_slot, sequence
```
`authority_leases`（`migrations/0001_initial_product_schema.sql:30-42`）没有按 agent 的单活租约唯一索引；单活只由 `claimLease`（`sqlite-worker.ts:463-475`）在应用层保证。正常生产路径（崩溃重启生成新随机 leaseId，`production-authority-lifecycle.ts:163-170`）不会误伤。但如果出现两条 live 租约（手工/损坏数据/未来调用方绕过 `claimLease`），正在运行的调用会被不可逆地标成 `owner_lost`。
**建议**：在接手条件中同时要求旧租约 `released_at IS NOT NULL OR expires_at <= @at`（或旧部署/epoch 更旧）；或给 `authority_leases` 加“单 agent 单 live 租约”的数据库约束，并补一条“旧租约仍然 live 时不接手”的反向用例。

### 低 — `owner_lost` 的读回路径没有自动检查
**文件:行**：`packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:959-962`、`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:1305-1313`
**问题**：新增测试都用原始 SQL 断言 `owner_lost`（例如 `model-invocation-owner-lost-migration.contract.test.ts:214-227`、`sqlite-sandbox-execution-v2.test.ts:1547-1553`），没有一条通过 identity/budget 端口的读回路径真正解析 `owner_lost`。如果以后有人把 `recordedUnknownReason` 或 `parseAllocation` 的白名单改回去，测试不会变红。
**证据（读代码证实）**：接手方法更新 identity 后不读回；`state()` 和迁移测试直接 `SELECT` 原始表。解析白名单本身是对的：
```ts
const RECORDED_UNKNOWN_REASONS = [...UNKNOWN_REASONS, "owner_lost"];
...
: recordedUnknownReason(reasonValue, "reason_code");
```
**建议**：加一条读回用例（例如接手后通过 `runReconciliation` 之外的 identity/budget 读端口读取该行，断言 `reasonCode === "owner_lost"`），或让接手方法在更新后读回并校验。

### 低 — 接手方法是 public，但没有“只处理到期运行”的前提检查
**文件:行**：`packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:744-762`
**问题**：方法只检查“在 SQLite 事务里”和“当前授权有效”，不检查 run 是否处于 `reconciling_external_result`、是否已过截止时间。当前唯一生产调用方 `settleExpiredSync` 已做这些检查，但任何包内新调用方都可能对任意 run 把仍在跑的调用不可逆地标成 `owner_lost`。
**证据（读代码证实）**：方法开头只有
```ts
if (!this.database.inTransaction)
  this.fail("PORT_INVALID_OPERATION", "Orphaned model invocation takeover requires an active SQLite transaction");
this.assertCurrentAuthority(scope, at);
```
随后直接按 runId 选择并改写。没有 run 状态或 deadline 条件。
**建议**：把方法收窄为包内/私有，或在方法内加与收尾规则一致的 run/checkpoint/deadline 前提；至少在注释里写清“调用方必须先证明运行已到期”。

### 信息（残留风险，不是本次引入）— 第一种收尾情况仍不放过任何 `unknown`
**文件:行**：`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:60-64`
**问题**：本次只接手 `reserved/started`。如果崩溃进程留下的是 `unknown`，且诊断码是 `RUNTIME_TOOL_RESULT_UNKNOWN`，第一种情况仍因 `model.status='unknown'` 永不收尾；同时 `SANDBOX_TOOL_RESULT_RECOVERY_SQL:42-46` 也不区分授权、同样被这条 unknown 挡住。这不是回归，文档也明确“第一种情况仍把 unknown 当未决”，但它与“崩溃遗留调用不再挡住收尾”的目标只差一个状态。
**证据（读代码证实）**：
```sql
(c.diagnostic_code='RUNTIME_TOOL_RESULT_UNKNOWN' AND NOT (${SANDBOX_TOOL_RESULT_RECOVERY_SQL})
  AND NOT EXISTS (... model.status='unknown'))
```
**建议**：明确这是范围外并记录；若要收口，可对“非当前授权租约”的 `unknown` 也放行或接手，并补相应反向用例。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动只涉及 SQLite 里的模型调用/预算状态和收尾规则，没有改系统提示、工具定义、历史消息或遮盖实现；`owner_lost` 只出现在持久化、端口类型和测试里，读到的发送侧代码没有把它写进任何模型消息。失败运行的终态属于本轮末尾追加的内容，不是对已有请求开头的改写。未逐条追踪 UI 投影到下一轮提示的路径，但本次没有新增每轮变化的提示值。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。没有新增服务商名、时间、路径、哈希或无序集合到模型请求；写入的 `observed_at` 只是数据库字段。接手查询用 `ORDER BY logical_slot, sequence`，即使考虑序列化也是确定顺序。不涉及遮盖规则。

3. **有没有对应的自动检查，反向用例真的会失败？**
   主要判定有。`model-invocation-owner-lost-migration.contract.test.ts:288-325` 直接验证“当前授权不动、换授权后才接手”，去掉 `authority_lease_id <> ?` 过滤会失败；集成测试里 `deadline-code-model-started`、`persisted-code-model-started`、`released-model-started` 在去掉顶层 `LIVE_MODEL_INVOCATION_SQL` 后会转为可收尾而失败；跳过接手会让四个 orphan 场景失败；诊断码集合退回旧值会让 `persisted-code-model-orphan-started` 失败。缺口是：`owner_lost` 的端口读回没有用例（见发现 2）；`assertCurrentAuthority` 的反向用例仍缺失，但这是已记账的第 7 轮低项，按指示不重复。

4. **每个值的使用端都能接受吗？**
   - `owner_lost`：迁移 0083 两张表的 CHECK 接受（`0083...sql:23-25`、`:93-95`）；identity 解析器 `recordedUnknownReason` 接受；budget 解析器 `parseAllocation` 白名单接受；`ModelInvocationRecordedUnknownReason` / `ModelBudgetAllocation.reasonCode` 类型接受。公共 `ModelBudgetUnknownInput` / `parseUnknown` 仍只接受三个旧原因，这是有意的：生产写入 `owner_lost` 的路径是内部 `markUnknownWithinTransaction`，没有公共调用方需要传它。没有找到网页或审计脚本读取该原因码；Python 观察脚本只读 `status`。
   - 迁移编号/名称：`migration-engine.ts:654-660` 登记 83，`LATEST_MIGRATION_SEQUENCE` 由数组推导；`workspace-lifecycle-audit.mjs` 的 `SUPPORTED_SCHEMA_MAX` 已改 83，与 `check-audit-schema-range` 从目录推导的最大值一致；相关迁移测试都改成了 83。
   - `@authorityLeaseId`：`RUN_EXPIRED_RECONCILIATION_SQL` 的两个使用点（`sqlite-run-dispatch-operations.ts:370-378`、`:442-452`）都传了该参数。
   - **迁移结构核对**：0083 与最后一次重建这两张表的 `0049_thread_title_budget.sql` 逐列一致，只多了 `owner_lost`；索引、两个 UNIQUE、外键、CHECK 都保留。0082 本身只建 `gap_case_marks`，不涉及这两张表。未发现其他表引用这两张表，也没有触发器或视图依赖它们；迁移前后数据由 TEMP 表保存并回插，测试还比对了 `sqlite_master`、`foreign_key_list` 和 `foreign_key_check`。

## 未核实

- `.agents/reviews/pr-301/plan-orphaned-model-calls.md` 及前几轮复核记录在本次环境中读不到（记录路径被拒），作者关于“第 6/7 轮低意见已改/已记账”的说法未逐条核对。
- 生产 `production-run-expiry.ts` 的到期封装对 orphan 场景没有单独测试（作者已在文档中列为未覆盖），我未在测试里找到对应夹具。
