# PR 301 第 2 轮复核（增量 40907d2 → 07db7903）

## 侧重检查（流程走查）

我走的最普通流程：运行因执行截止时间被打断 → 运行停在 `reconciling_external_result`、checkpoint 带诊断码 `RUN_EXECUTION_DEADLINE_EXCEEDED`（写入方：`packages/application/src/services/run-coordinator.ts:259` 的审批等待到期路径；运行中断时写同一诊断码的具体路径未逐一核实，测试 `run-coordinator.test.ts:271` 有覆盖迹象）→ 调度循环 `recover()`（`apps/agent-service/src/production-run-dispatcher.ts:283-322`）→ `listReconciliationRequired` 第三分支命中（`packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts:358`）→ `createProductionRunReconciler`（`apps/agent-service/src/production-run-reconciler.ts:29`，先试 `settleExpired`）→ 生产包装器 `apps/agent-service/src/production-run-expiry.ts`：查 checkpoint（33-38 行）、读冻结输入并验摘要（39-54 行）、校验 `version/startedAt/deadlineAt≤24h`（59-70 行）、截止前挡下（72 行）→ `settleExpired` 事务（`sqlite-run-dispatch-operations.ts:391-541`，ready 检查内含新分支 426 行）。结论：**端到端可以走通**；其中 `production-run-expiry.ts`、`production-run-reconciler.ts` 的 fallthrough（settleExpired 返回 false → quarantine，而 quarantine 对已处 reconciling 状态的 run 是 no-op，`sqlite-run-dispatch-operations.ts:579-591`）、以及 dispatcher 对这类新候选的处理，全部没有测试覆盖（包装器无覆盖作者已记录在 I-88；reconciler/dispatcher 这两层是本轮走查新发现的同一段流程上未覆盖的路径）。仓库层 + SQL 层测试覆盖充分。

## 发现的问题（按严重度从高到低）

**1. 低｜test/integration/sqlite-sandbox-execution-v2.test.ts:1190-1192｜夹具在 `foreign_keys = OFF` 后一直不恢复，插入的模型调用行未经外键校验**
证据：测试在删除沙箱记录前执行 `f.database.pragma("foreign_keys = OFF")`，之后再无恢复；随后 1196-1221 行向 `model_invocation_identities` 插入行，其 `budget_account_id/budget_operation_key/authority_lease_id`（`'expiry-budget-account'`、`'lease'`）的父行（`model_budget_allocations`、`authority_leases`）是否真实存在从未被校验（better-sqlite3 默认也关外键）。真实状态里这些父行必然存在。对被测 SQL 无影响（三个 NOT EXISTS 只读 `status`），但「造出的数据状态与真实状态是否一致」这一点上，夹具比真实状态松。
建议：可接受，不必改；若追求保真，可在夹具里补建父行并保持外键开启。

**2. 低｜test/integration/sqlite-sandbox-execution-v2.test.ts:1454｜`deadline-code-null-record` 断言完不进候选后提前 return，少了一半断言**
证据：1453 行断言 `listReconciliationRequired` 为空后，1454 行 `return`，没有像 model-\* 和 future-record 那样继续 `expect(recovery.settleExpired(input)).rejects.toThrow()`。其余四个反向场景都有「不进候选 + 收尾拒绝」双重断言。若将来有人动 `settleExpired` 的 ready 检查（426 行内嵌同一 SQL），null-record 场景抓不住。
建议：把 return 去掉，让它也走 rejects 断言（我推演过：NULL 期限的记录在 427-431 行的计划比较里同样会导致 ready 失败，补上不会误报）。

**3. 信息｜packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:60-66｜第三分支在 `listReconciliationRequired` 里没有期限比较，截止前就会把运行列为候选**
证据：第三分支只看诊断码、无沙箱记录、无未决模型调用；对比 `settleExpired` 的 ready 检查（`sqlite-run-dispatch-operations.ts:425`）有 `@deadlineAt<=@resourceNow`。截止前该运行会出现在候选里，由包装器 `production-run-expiry.ts:72` 挡下、quarantine no-op 兜底，每轮重复一次直到到期。这与第一分支（`RUNTIME_TOOL_RESULT_UNKNOWN`）的既有形态一致，行为无害，但「截止前候选已出现」没有任何测试断言，作者文档里也只说「截止时间之前不收尾」。属观察项，不要求改。

**4. 信息｜文档与事实核对结果**：I-88 更正后的文字逐项与代码一致——场景名与测试逐一对应（test:1060-1064）；「`deadline-code-before-deadline` 只证明截止时间之前不收尾，不是新分支的反向用例」属实（它走 else 分支，靠 425 行的期限检查拒绝）；「未覆盖：production-run-expiry.ts 无单独测试（夹具缺 startedAt）」属实（test:1146 的冻结输入确实没有 `startedAt`，而包装器 65-66 行要求它；生产写入方 `run-execution-input-service.ts:41` 的 `FrozenRunInput` 把 `startedAt` 定为必填，故真实冻结输入不会缺）。「复现：只加测试时 2 条失败、加 SQL 后 64 条通过、共 945 条」——**未核实**（本环境不能运行测试；从代码推演，改前会失败的恰好是 `deadline-code-no-records` 的 worker/direct 两臂，与「2 条」自洽）。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会。整个变更区间（2995d53 → 07db7903，3 个提交）只改了 3 个文件：SQL 文件、集成测试、事故文档（git diff --stat 证实），没有触碰提示组装、工具定义、历史存储、出口遮盖的任何代码。发给模型的内容完全不受影响，「只追加」规则天然满足。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。SQL 谓词（`= 'RUN_EXECUTION_DEADLINE_EXCEEDED'`、`IN ('reserved','started','unknown')`）是固定字面量，对同一数据库状态确定；没有把时间、遮盖结果或无序集合引入任何面向模型的内容。收尾写入的 `run.failed` 事件属于结果通知，不进入请求开头。

**3. 有没有对应的自动检查、反向用例是否真会失败？** 有 7 个新场景 × worker/direct 两臂。逐条件推演（读代码证实）：`deadline-code-no-records` 钉住整个第三分支（改前必失败，1371 行 settled:true + 全套状态断言）；`deadline-code-model-{reserved,started,unknown}` 各钉住「无未决模型调用」条件（删掉该条件则 1453 行 list 断言失败且 1456 行 settle 不再拒绝）；`deadline-code-future-record`、`deadline-code-null-record` 钉住「无任何沙箱记录」条件（删掉则 list 断言失败）。造的数据与 schema 逐列核对过（0023 迁移的 NOT NULL、CHECK 66-81 行对三种状态均满足），状态值和 `provider_unresolved` 都是真实写入方（`sqlite-model-invocation-operations.ts:509/584/715`、`trusted-model-provider.ts:239`）在用的值。但测试能否在 CI 通过、作者的复现数字，均**未核实**；包装器层无测试（作者已记录）。

**4. 每个产生/修改的值，两端都能接受吗？** 核对过：诊断码字面量（写入方 `run-coordinator.ts:259`、`sqlite-run-dispatch-operations.ts:492` ↔ SQL 消费方）；模型状态枚举（schema CHECK `0023:42` 是超集，SQL 的 IN 列表是子集）；`reason_code` 枚举一致（`0023:51-53`）；无新增标识、配置键、清单项；夹具 INSERT 与 schema 兼容。**未核实**：生产库里那条 `run:17a4102d…` 是否真的满足第三分支全部条件（尤其「只有沙箱预热」是否意味着 `sandbox_admission_queue`/`execution_environments` 里没有未释放行——若有，`RUN_RESOURCES_RELEASED_SQL` 仍会挡住收尾；文档已写「收尾前把整条规则在生产库只读跑一遍」，覆盖了这一风险）。

## 读代码证实的 vs 推测

- **证实**：SQL 第三分支的三条件及其与 `SANDBOX_TOOL_RESULT_RECOVERY_SQL`、`RUN_RESOURCES_RELEASED_SQL` 的组合关系；测试每个反向场景钉住的条件、能抓到对应条件被删；I-88 文字与代码一致；生产冻结输入必有 `startedAt`；上面 4 条问题的全部代码证据。
- **推测/未核实**：作者的复现数字（2/64/945）；生产事故运行的确切数据库状态（诊断码、模型调用状态、资源守卫是否放行）；运行中断时写该诊断码的具体运行时路径；dispatcher 收到包装器抛错（如 `RUN_EXPIRY_INPUT_UNAVAILABLE`）时经 `production-run-dispatcher.ts:310-313` 二次抛出导致 `recover()` 整体拒绝的后果（这是分支 1/2 已有的既有暴露，非本次引入）。
