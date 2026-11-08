以下结论基于当前工作区 `ad9efa5`，对比 `2995d53` 的全量 diff 与 `07db790` 的增量。改动只涉及三个文件：`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts`、`test/integration/sqlite-sandbox-execution-v2.test.ts`、`docs/incidents-and-gates.md`。

## 结论

改动方向正确：新增的 SQL 分支只放宽了“诊断码为截止时间被打断、无沙箱记录、无未决模型调用”这一类，外层状态/终态/资源释放条件和 `settleExpired` 的截止时间守卫都在。没有发现会破坏生产逻辑的高严重度问题。主要问题集中在新增测试造出的数据是否真实、外键是否真的被校验。

## 发现（按严重度）

### 1. 中等 — “预热执行环境已释放”的正向用例造出了生产不可能出现的释放回执
文件：`test/integration/sqlite-sandbox-execution-v2.test.ts:1273`（回执插入）、`test/integration/sqlite-sandbox-execution-v2.test.ts:1198`（关闭外键）

问题：该场景直接插入 `execution_environment_release_receipts(stop_fence=1)`，但 `reserve()` 创建的环境 `stop_fence=0`、`state='reserved'`、`create_dispatched_at=NULL`，也没有任何 `execution_environment_stop_intents` 行。真实释放走的是“先写出 stop intent、把环境置为 stop_requested，再插回执、置 released”。

证据：
- `packages/persistence-sqlite/src/migrations/0051_srt_task_environment_release.sql:11`：
  `FOREIGN KEY(environment_id, stop_fence) REFERENCES execution_environment_stop_intents(environment_id, stop_fence)`
- `packages/persistence-sqlite/src/sqlite-execution-environment-operations.ts:397-418`：只有 `stop_fence` 从 0 变成 1 并插入 stop intent 之后才可能有回执；`:444-446` 要求 `row.state === 'stop_requested'` 且有当前 intent；`:471-492` 才插回执并把环境置 `released`。
- 测试在 `:1198-1201` 先把 `foreign_keys` 关掉，而环境类场景之后没有再打开，所以这条非法回执被静默接受。

影响：第一，这个“正向用例”没有复现生产可达的状态（生产里 FK 是开着的，且环境 state 应为 released）；第二，测试整个后半段都在 `foreign_keys=OFF` 下跑，后续 `settleExpired` 的外键完整性也不被校验。这个用例的结论仍然由 `RUN_RESOURCES_RELEASED_SQL` 的“回执存在”决定，所以当前没有造成假通过，但数据本身不真实。

建议：用 `executionEnvironmentStore` 的 stop/acknowledge/acceptRelease 走一遍真实释放流程，或至少插一条 `execution_environment_stop_intents(environment_id, stop_fence=1)` 并把环境 `state` 更新为 `released`；插入完成后恢复 `foreign_keys=ON`。

### 2. 低 — 模型用例的外键父行实际没有被校验，unknown 场景的预算账号状态也不真实
文件：`test/integration/sqlite-sandbox-execution-v2.test.ts:1202-1272`

问题：三个模型用例的 `model_budget_accounts`、`model_budget_allocations`、`model_invocation_identities` 都是在 `:1198` 关闭 `foreign_keys` 后插入，直到 `:1271` 才打开。SQLite 在 `PRAGMA foreign_keys=ON` 时不会回溯校验已有行，所以作者说的“补建了外键父行”实际上没有被数据库检查（即使父行写错也不会被发现）。另外 `deadline-code-model-unknown` 把 `model_budget_accounts.status` 写成 `active`，而真实的 `markUnknown` 会把账号置为 `reconcile_required`（`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:682-687`）。

证据：插入顺序见 `:1198`（OFF）→ `:1209-1270`（插入）→ `:1271`（ON）；账号状态固定为 `'active'`（`:1211`）。

影响：这些用例最终靠 `model_invocation_identities.status` 决定是否被排除，所以当前不会假通过；但一旦以后把“预算账号 reconcile_required 也要拦住”加进新分支，这些不真实的夹具就测不出来。建议把删除沙箱记录和插入模型行分开事务/连接，或在插入前恢复外键，并把 unknown 场景的账号状态改成 `reconcile_required`。

### 3. 低 — 生产收尾包装器仍无测试；截止前候选会重复做昂贵工作
文件：`apps/agent-service/src/production-run-expiry.ts:71-73`、`test/integration/sqlite-sandbox-execution-v2.test.ts:1495-1518`

问题（已部分被文档承认）：
- 新分支在 `listReconciliationRequired` 里没有时间条件，`deadline-code-before-deadline` 只直接调用 `settleExpired`，不经过 `production-run-expiry.ts`，也没有任何测试覆盖包装器。包装器在判断“截止前返回 false”之前已经做了 checkpoint 读取、artifact/payload 读取、解密、SHA-256、JSON 解析、`runExecutionSource.read`（`production-run-expiry.ts:32-70`）。
- 如果这些步骤在截止前抛错（缺 artifact/payload/source），`production-run-dispatcher.ts:303-313` 会再调一次 `reconcile`，可能反复失败并占住每轮 `recover` 的候选名额（推测；正常情况下诊断码只会在截止后出现，所以影响有限）。

证据：`production-run-expiry.ts:71-73` 在完成上述工作后才判断 `at < frozen.deadlineAt`；`production-run-dispatcher.ts:303-313` 捕获后重新 `reconcile`。

建议：给包装器补一个“截止前列出候选但返回 false”的测试（可用完整 `run-execution-input.v2` 夹具），或把截止时间判断前移到候选查询能看到的字段上。

### 4. 信息 — I-88 文字与代码基本一致，但“已落门槛”只到测试层面
文件：`docs/incidents-and-gates.md:122`

已核对的点：
- “外层要求 run 是 reconciling_external_result、checkpoint 没有终态和输出、资源都已释放” — 与 `sqlite-sandbox-tool-result-recovery.ts:44-46,68` 一致。
- “只认两种情况” — 与改动前的 `:47-59` 一致；但摘要省略了第一分支还要求 `NOT (${SANDBOX_TOOL_RESULT_RECOVERY_SQL})` 和模型调用条件，属于不精确的概括。
- “新增第三种情况…外层的状态、终态和资源释放条件照旧” — 与 `:60-66` 一致。
- “新分支没有时间条件，截止前由包装器和隔离兜底” — 与代码一致（`production-run-expiry.ts:71-73`、`sqlite-run-dispatch-operations.ts:425-426`）。

未核实的点（无法访问生产）：生产日志、`run:17a4102d…`、`S3_COPY51` 的具体表现、Hermes 上的 64/945 条测试数字。

补充：文档把门槛标成“已落门槛”，但真正拦住上线的是 `read-s0-db.mjs:92` 的 `SELECT count(*) FROM runs WHERE status NOT IN ('completed','failed','cancelled')`，本 PR 不改变这个门禁；已卡住的生产运行仍需文档里写的离线收尾，这是准确的。

## 侧重检查

- 错误路径：`settleExpired` 对不满足条件的运行返回 `PORT_CONFLICT`（`sqlite-run-dispatch-operations.ts:449-453`），新增的反向用例用 `rejects.toThrow()` 覆盖；`deadline-code-before-deadline` 由 `:425-426` 的截止时间条件挡住，已核实。
- 不可信/不合规输入：新分支的比较值是内部字面量 `'RUN_EXECUTION_DEADLINE_EXCEEDED'`，SQL 全部用绑定参数（`@resourceNow` 等），没有字符串拼接用户输入，已核实。测试里的 `diagnostic_code` 是直接 `UPDATE` 写入，schema 对 `diagnostic_code` 没有枚举约束（`migrations/0018_run_coordination_checkpoints.sql:15`），所以能写进去。
- 安全：无新增秘密、无外部网络、无新命令执行。
- 资源耗尽/不可撤销：`settleExpired` 是单个事务，失败整体回滚；新增分支依赖“资源已释放 + 无未决模型调用”。`run_background_holds` 只在候选查询里过滤（`sqlite-run-dispatch-operations.ts:360-364`），`settleExpired` 本身不检查后台占用，这是既有行为；生产路径只处理候选列表里的运行，所以未发现新增风险。
- 外键/两端校验：见发现 1、2，新增测试值在 FK 关闭时被接受，属于最值得修的地方。
- 文档一致性：见发现 4。

## 必答问题

1. **不会改变模型已见过的请求开头。** 本次 diff 只有 SQL、测试和事故文档，没有任何提示词、工具定义、历史消息、遮盖器代码被改。因此发给模型的内容仍然只由原有逻辑在末尾追加；每轮会变的值仍在最后一条消息里这一性质不受影响。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。

2. **不会让同一段文字在不同请求里变成不同字节。** 改动没有触碰任何提示词序列化、遮盖、列表排序；新 SQL 分支只是固定的字面量比较，候选查询的 `ORDER BY r.created_at, r.id` 未变。测试里使用固定时间 T1/T2，也没有引入时间字段到提示内容。

3. **有自动检查，且反向用例在逻辑上确实能抓住对应条件被删。** 同一 `it.each` 列表同时包含正向和反向场景：
   - 删掉新分支的模型条件：`deadline-code-model-reserved/started/unknown`（worker/direct 各一份，共 6 条）会变成候选，`:1512` 的 `toEqual([])` 失败。
   - 删掉 `NOT EXISTS sandbox_execution_records`：`deadline-code-future-record`、`deadline-code-null-record`（共 4 条）会变成候选，同样在 `:1512` 失败。
   - 删掉 `RUN_RESOURCES_RELEASED_SQL` 里的环境释放块：`deadline-code-environment-unreleased`（2 条）和原有的 `environment`（2 条）会变成候选/可收尾，共 4 条失败。
   - 删掉整个第三分支：4 个正向场景（共 8 条）失败。
   这些是读代码推断；本复核不能运行测试，作者在 Hermes 上报告的 64/945 条通过数字**未核实**。另外，`production-run-expiry.ts` 和“截止前候选”的包装器行为没有自动检查（见发现 3）。

4. **产出的值逐个核对：**
   - `RUN_EXECUTION_DEADLINE_EXCEEDED`：生产方是 `run-coordinator.ts:259`、`sqlite-run-dispatch-operations.ts:492` 等；消费方有 `thread-execution-state.ts:279,288,340`、`apps/control-center/src/execution-view.ts:373`、`production-run-expiry.ts`（隐含在 `!== "RUNTIME_TOOL_RESULT_UNKNOWN"` 分支），SQL 新分支也接受这个字面量。CHECK 层不限制该字段，双方一致。
   - 测试新增的模型行：列数、CHECK 约束（状态/时间/金额）我逐项对过，满足 `0049_thread_title_budget.sql` 的约束；外键父行在数据上也是存在的，但插入时 FK 关闭，未受数据库校验（发现 2）。
   - 测试新增的环境回执：`stop_fence=1` 不能通过 `execution_environment_stop_intents` 的外键，也不能通过真实释放流程的状态机（发现 1）。这是本次“两端校验”上唯一实际不一致的值。
   - 其余如 `environment_id='expiry-environment'`、`account_id='run:<runId>'`、`operation_key` 等，均与父行/查询一致。
