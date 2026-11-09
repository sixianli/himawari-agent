## 结论

第 2 轮增量没有发现会直接导致错误收尾的功能性缺陷：新的 SQL 分支与作者描述的三项条件一致，正向用例在旧 SQL 上会失败，两个“记录”类反向用例能卡住对应条件。问题主要集中在：正向用例没有复现生产“只有预热”的状态、模型反向用例造出的行不满足真实 schema/外键、反向覆盖缺少“已结算模型调用仍应收尾”的对照，以及 I-88 文字/作者说明与事实有细微出入。

---

## 发现（按严重度）

### 1. [中] 正向用例没有复现生产“只有沙箱预热”的状态，不能证明那条 run 真能过资源释放条件

- 文件：`test/integration/sqlite-sandbox-execution-v2.test.ts:1180-1193`；`packages/persistence-sqlite/src/sqlite-run-resource-guard.ts:43-50`；`apps/agent-service/src/production-task-environments.ts:342-369`
- 问题：`deadline-code-no-records` 只删了 `sandbox_execution_records` 和 `sandbox_admission_queue`，测试里从未创建 `execution_environments`。但生产的“沙箱预热”会走 `prewarmSrt → acquireSrt → coordinator.acquire`，创建一个 execution environment。第三分支虽然只要求“没有 sandbox_execution_records”，但整条规则还要求 `RUN_RESOURCES_RELEASED_SQL` 里“每个 execution_environment 都有释放回执”通过。测试没有覆盖“有预热环境”的状态，因此不能证明生产那条 run 会被收尾。
- 证据：
  - `sqlite-run-resource-guard.ts:43-50`：
    ```
    AND NOT EXISTS (
      SELECT 1 FROM execution_environments environment
      JOIN execution_jobs job ON job.execution_job_id=environment.execution_job_id
      WHERE job.owner_id=r.owner_id ... AND job.run_id=r.id
        AND NOT EXISTS (SELECT 1 FROM execution_environment_release_receipts receipt ...))
    ```
  - `production-task-environments.ts:348-351`：`if (!existing) record = await acquireSrt(input);`，随后 `acquireSrt` 调用 `coordinator.acquire(next)`（`:312`）。
  - 测试只在 scenario 为 `environment` 时预留环境（`:1107-1137`），而 `deadline-code-*` 场景没有走这段。
- 建议：新增一个带“已创建并释放的 execution_environment”的 `deadline-code-no-records` 正向场景；再补一个环境未释放的反向场景，证明资源守卫会拦住。生产侧仍应按 I-88 所述在停服窗口只读跑一遍整条规则。
- 备注：这不一定是功能 bug——`stopRun` 在中断时确实会释放环境并写回执（`production-task-environments.ts:543-568`、`production-sandbox-services.ts:2631-2639`），所以生产上大概率能过；但当前测试没有证明这一点。

### 2. [中] 模型反向用例造出的 `model_invocation_identities` 行不满足真实 schema/外键，靠关掉外键才写得进去

- 文件：`test/integration/sqlite-sandbox-execution-v2.test.ts:1190-1193`、`:1198-1221`；`packages/persistence-sqlite/src/migrations/0049_thread_title_budget.sql:132`、`:147-153`
- 问题：模型反向用例先 `pragma("foreign_keys = OFF")`，然后插入一行 `budget_account_id='expiry-budget-account'`、`budget_operation_key='expiry-budget-operation'`、`authority_lease_id='lease'` 的调用，但没有对应的 `model_budget_allocations` 行，`authority_leases` 里也没有 id 为 `lease` 的行（测试夹具的真实 authority lease 是 `lease-capability-invocation`）。如果外键打开，这条 insert 会失败。也就是说，测试验证的是“状态列会拦住收尾”，但造出的行不是生产能出现的状态。
- 证据：
  - 迁移 0049：
    ```
    FOREIGN KEY (owner_id, agent_id, budget_account_id, budget_operation_key)
      REFERENCES model_budget_allocations(...) ON DELETE CASCADE,
    FOREIGN KEY (authority_lease_id) REFERENCES authority_leases(id) ON DELETE RESTRICT,
    ```
  - 测试 `:1190`：`f.database.pragma("foreign_keys = OFF");`，且本测试之后没有恢复 `ON`。
- 建议：用真实的模型准入路径造调用，或至少补上 `model_budget_allocations` 和匹配的 authority lease；在断言后恢复 `foreign_keys=ON`，避免测试掩盖真实的约束问题。

### 3. [中低] 缺少“模型调用已 settled/released 时仍应正常收尾”的正向对照

- 文件：`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:63-66`；`test/integration/sqlite-sandbox-execution-v2.test.ts:1194-1221`
- 问题：反向用例只插入了 `reserved`、`started`、`unknown` 三种“未决”状态，没有验证 `settled`/`released` 的调用不会阻塞收尾。如果以后有人把 `model.status IN ('reserved','started','unknown')` 误改成不带状态过滤（即任何模型调用都阻塞），当前所有用例仍会通过：没有模型行的正向用例照过，三个反向用例照过；但生产里凡是已有结算模型调用的运行就永远收不了尾。
- 证据：SQL `:63-66` 是唯一的状态白名单；测试 `:1218-1220` 只按 `reserved/started/unknown` 决定 `started_at/observed_at/reason_code`。
- 建议：增加 `deadline-code-model-settled`（或 `released`）场景，期望进入候选并 `settled: true`，与三个反向场景成对。

### 4. [低] `deadline-code-null-record` 造出了 schema 不允许的记录，并且提前返回，未验证 `settleExpired`

- 文件：`test/integration/sqlite-sandbox-execution-v2.test.ts:1447-1454`；`packages/execution-contracts/src/sandbox-execution-v1.ts:72`
- 问题：`json_remove(plan_json,'$.originalDeadlineAt')` 会让 `originalDeadlineAt` 缺失，而该字段在 plan schema 里是必填的 `timestamp`。真实应用不会产生这种记录；它只能测到 SQL 对损坏/历史数据的防御分支。并且该场景在断言候选为空后直接 `return`，没有断言 `settleExpired` 会拒绝，也没有做 `state()` 前后比较。
- 证据：
  - schema：`originalDeadlineAt: timestamp,`（必填）
  - 测试：
    ```
    if (scenario === "deadline-code-null-record")
      f.database.prepare("UPDATE sandbox_execution_records SET plan_json=json_remove(...)").run();
    expect(await dispatch.listReconciliationRequired(...)).toEqual([]);
    if (scenario === "deadline-code-null-record") return;
    ```
- 建议：在注释/文档里明确这是“损坏数据防御”场景；如要保留，补一条 `expect(recovery.settleExpired(input)).rejects.toThrow()`，并说明该状态不可能由正常 schema 产生。另建议给 UPDATE 加 `WHERE`，避免误改同库其他记录。

### 5. [低] 新分支在 `listReconciliationRequired` 里没有时间条件，截止时间之前也会被列为候选；`deadline-code-before-deadline` 刻意不检查候选

- 文件：`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:60-66`；`test/integration/sqlite-sandbox-execution-v2.test.ts:1436-1438`
- 问题：第三分支只判断诊断码、无记录、无未决模型，不判断 `@resourceNow` 是否已过截止时间。`listReconciliationRequired` 会在截止时间之前就把它列出来（测试里 `deadline-code-before-deadline` 场景被排除在 `listReconciliationRequired` 断言之外，所以没被发现）。真正阻止提前收尾的是 `settleExpired` 的 `(c.diagnostic_code='RUNTIME_TOOL_RESULT_UNKNOWN' OR @deadlineAt<=@resourceNow)`（`sqlite-run-dispatch-operations.ts:425`）和生产包装器的 `at < frozen.deadlineAt`（`production-run-expiry.ts:72-73`）。功能上不会误收尾，但会造成每轮 recover 反复选中、反复无操作。
- 证据：测试 `:1436-1438` 明确把 `deadline-code-before-deadline` 排除在候选断言外；SQL 第三分支 `:60-66` 无时间谓词。
- 建议：如果这是有意的（检查点没有截止时间，只能在 `settleExpired` 里拦），在文档和测试注释中写明；否则考虑在候选查询里把 `@resourceNow` 与冻结输入/检查点中的截止时间对齐，或补一条“截止时间前不进入候选”的断言。

### 6. [低] I-88 文本省略了外层的 `terminal_status/output_kind` 和 `RUN_RESOURCES_RELEASED_SQL`

- 文件：`docs/incidents-and-gates.md:122`；`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:44-46,67-68`
- 问题：文档说新分支的条件是“诊断码、无沙箱记录、无未决模型调用”，但实际整条规则还要满足 `c.terminal_status IS NULL AND c.output_kind IS NULL`，以及 `RUN_RESOURCES_RELEASED_SQL`（含 admission queue、legacy occupancy、execution environments）。这不是错误，但对“为什么生产那条 run 能被收尾”的说明不完整。
- 建议：在 I-88 的门槛文字里补一句“还要求没有待释放的执行环境/队列资源”，与第 1 条测试缺口一起处理。

---

## 作者说法核对

- “补了 5 个反向用例”：**属实**。测试里确有 `deadline-code-model-reserved/started/unknown`、`deadline-code-future-record`、`deadline-code-null-record`（`test/...:1060-1064`）。
- “更正了 I-88 的归因”：**不准确**。第 2 轮 diff 只改了“门槛（文件或命令）”这一列；根因列（“已确认部分（读代码；生产日志）……”）与第 1 轮逐字相同。实际更正的是“未覆盖/测试说明”，不是根因。
- “生产收尾包装器没有单独测试（夹具冻结输入缺 startedAt）”：**属实**。测试里的冻结输入只有 `{ version, deadlineAt }`（`test/...:1145-1147`），而 `production-run-expiry.ts:59-69` 要求 `startedAt` 是合法时间字符串。需要补充：`createProductionRunExpiry` 目前在本仓库没有任何直接测试，不只是“这类运行”没有测试。
- “只加测试时 2 条失败（worker、direct 各一），再加 SQL 后 64 条通过”：**未核实**（本次只能读代码/跑 git，不能执行测试）。与正向用例只覆盖 `deadline-code-no-records` 的推理一致。
- “反向有效”：**在“删掉对应条件、保留分支”的意义上有效**。删掉第三分支的模型状态子句，三个 model 反向用例会让 `listReconciliationRequired` 返回候选，`:1453` 断言失败；删掉 `NOT EXISTS any_record`，`future-record`/`null-record` 会返回候选，同样失败。注意：如果整条第三分支被删掉，五个反向用例都会通过，这是反向用例的固有性质，由正向的 `deadline-code-no-records` 负责卡住分支存在性。

---

## 侧重检查

- **错误路径**：`settleExpired` 在未授权、revision 不符、租约仍活、找不到冻结输入等情况下都会拒绝；新分支只是扩大了 `listReconciliationRequired` 的候选集合，不改变这些拒绝路径。生产 reconciler 在 `settleExpired` 返回 `false` 时会走 `quarantine`（`production-run-reconciler.ts:29-37`），而 `quarantine` 对 `reconciling_external_result` 且 phase 相同的 run 是空操作（`sqlite-run-dispatch-operations.ts:579-591`），因此“截止时间前被列出”不会产生错误状态，只会重复空转。
- **不合规范/不可信输入**：新增 SQL 只比较常量字符串，所有值都通过绑定参数；没有新的用户输入进入 SQL。测试里的插入值是常量，但如发现 2 所述不满足真实外键。
- **安全**：所有查询仍按 `owner_id/agent_id/run_id` 限定作用域，没有放宽授权；没有新增密钥或日志输出。
- **资源耗尽**：新增的 `NOT EXISTS` 走 `sandbox_execution_records` 的 run 维度索引和 `model_invocation_identities` 的 `(owner_id,agent_id,run_id,...)` 索引（迁移 0049:179）；没有无界循环。唯一相关的是发现 5 的重复候选/空转。
- **不可撤销操作**：收尾会把 run 置为 `failed` 并写 `run.failed`。新分支扩大了这个不可逆集合，但用“无未决模型 + 无任何沙箱记录 + 资源全部释放（含执行环境）”三重约束兜底。测试没有覆盖“有预热执行环境”的那一种生产状态（发现 1），所以生产上是否满足资源守卫仍应按 I-88 的说明做只读核对。
- **规则/文档一致性**：本次三处改动均不涉及提示词、工具定义或出口遮盖，`.claude/rules/prompt-prefix.md` 不受影响。I-88 的三项条件与 SQL 一致，但省略了外层 `terminal_status/output_kind` 和资源守卫（发现 6）。`deadline-code-null-record` 的“截止时间为空”不是合法 schema 状态（发现 4）。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本轮改动只有三类：`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts` 的到期收尾 SQL、对应的集成测试、`docs/incidents-and-gates.md` 的事故记录。没有触碰系统提示、工具定义、历史消息、资料块或出口遮盖。发给模型的内容仍然只在末尾追加；没有新增每轮会变的值进入请求头。收尾产生的是数据库状态和 `run.failed` 事件，不是模型请求。依据：`.claude/rules/prompt-prefix.md` 的“只追加”“每轮会变的值只放在最后一条用户消息”“字节必须确定”。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 新增 SQL 只使用固定诊断码和固定的模型状态集合；测试里新增的都是固定字面量或固定测试时钟（`T1/T2`），没有时间戳、随机数、对象遍历顺序或无序集合进入任何序列化到模型请求的内容。`@resourceNow` 本来就是既有参数，且只用于数据库查询，不会进入模型请求。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有自动检查，但覆盖不完整。** `test/integration/sqlite-sandbox-execution-v2.test.ts` 属于 CI 的 integration 项目（`ci/policy.json` 的 `testProjects.integration` 包含 `test/integration/**/*.test.ts`，且 `test`、`node-floor` 作业都跑 integration），并且用 `describe.each(["worker","direct"])` 跑两遍。

- `deadline-code-no-records`：旧 SQL 下 `listReconciliationRequired` 返回 `[]`，`:1367` 期望有候选，会失败；新 SQL 下通过。所以它能卡住“第三分支不存在/条件写错”。
- 三个 `deadline-code-model-*`：删掉第三分支的模型状态子句时，`:1453` 的 `toEqual([])` 会失败；保留子句时通过。反向有效。
- `deadline-code-future-record`、`deadline-code-null-record`：删掉 `NOT EXISTS any_record` 时，`:1453` 会失败；反向有效。
- 不足：生产包装器路径未测（作者已披露）；没有 settled/released 的正向对照（发现 3）；`deadline-code-before-deadline` 只验证 `settleExpired` 拒绝，不验证候选列表（发现 5）；`deadline-code-null-record` 提前返回，不验证 `settleExpired`（发现 4）。

### 4. 改动产生/修改的每个值，每个使用它的地方都能接受吗？

改动没有新增对外标识、配置键或序列化格式；新增的是 SQL 谓词和测试场景名。逐个核对：

- 新的 SQL 分支被 `listReconciliationRequired`（`sqlite-run-dispatch-operations.ts:358`）和 `settleExpired`（`:426`）消费，两处都用同一段 `RUN_EXPIRED_RECONCILIATION_SQL`，接受；`settleExpired` 外层还额外要求 `@deadlineAt<=@resourceNow` 和冻结输入工件，能兜住提前收尾。
- 诊断码 `RUN_EXECUTION_DEADLINE_EXCEEDED` 是既有值：生产写入方见 `run-coordinator.ts:259`、`sqlite-run-dispatch-operations.ts:492`；UI 已能处理（`thread-execution-state.ts:282-290,339-340`，`execution-view.ts:373`）。新分支只读取它，消费端能接受。
- 模型状态集合 `reserved/started/unknown` 与迁移 0049 的 CHECK（`:132`）以及既有两处相同过滤（`sqlite-sandbox-tool-result-recovery.ts:36-40,49-52`）一致；不存在使用方不认识的取值。缺点是同一集合现在在这个文件里重复了三份，未来新增状态容易漏改。
- 测试里新造的 `model_invocation_identities` 值本身**不能**被真实外键接受（缺少 `model_budget_allocations`，`authority_lease_id='lease'` 也不匹配真实 lease），当前只是因为 `foreign_keys=OFF` 才成立；这是发现 2，不是产品代码的问题，但直接回答了“两端校验是否都能过”：测试这一端没有过真实约束。
- I-88 文档里新增的路径都能存在（`check-incident-gates.mjs` 会检查）；没有新增需要后端校验的 id/modelRef，所以没有 I-73 那类“清单 id 过不了后端校验”的新风险。
