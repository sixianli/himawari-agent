# 方案：服务崩溃后停在“进行中”的模型调用（PR 301 追加）

状态：第 2 版，已整合第 1 轮双模型碰撞（记录在 `.agents/reviews/topic-pr-301-orphaned-model-calls/round-1/`），待 Andy 同意，尚未动代码。

## 两个先回答的问题

1. 业界遇到同样情况怎么做、用户看到什么。ChatGPT、Claude 这类产品在生成途中服务出故障时，这一轮以出错结束，用户看到“出错了，请重试”，对话不会一直挂着；费用由服务端另行对账。分布式系统判断“原执行者已经不能再写”的标准做法是令牌（fencing token）：每次写入都带令牌，存储端拒绝旧令牌的写入（Martin Kleppmann，https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html）。Temporal（运行后台任务的框架）也不靠原执行者自己报告崩溃，而是靠时限判定失败（https://docs.temporal.io/encyclopedia/detecting-activity-failures）。
2. 根因还是表面修补。根因是：模型调用记录只有原进程自己能把 `reserved`（已预留）、`started`（进行中）改成别的状态，进程崩溃后没有程序接手。本方案补上接手机制，是根因修复；它不处理“费用最终是多少”，这一点和现在的 `unknown` 一样只作记录。

## 已核对的事实（读代码；未运行）

- 只有原进程里的调用许可会改 `reserved`、`started`（`packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts` 的 `markStarted`、`releaseReserved`、`settle`、`markUnknown` 和预算表对应方法）；启动、巡检、对账都不碰。`modelBudget.finalize`（`sqlite-model-budget-operations.ts` 约 758 行）有“运行终态后释放 `reserved`”的语义，但没有生产代码调用它（只在 `durable-adapters.ts:776` 接了端口，调用方只有测试），已核实。
- 崩溃后的运行由恢复流程放进 `reconciling_external_result`，诊断码可能是 `PERSISTED_EXECUTION_RECONCILIATION_REQUIRED`、`RUNTIME_ATTEMPT_INTERRUPTED`、`SERVICE_STOPPING`、`EXECUTION_LEASE_RENEWAL_FAILED` 等，不会变成终态。
- 到期收尾规则 `RUN_EXPIRED_RECONCILIATION_SQL`：第一、第三种情况挡住 `reserved`、`started`；第二种情况（有已过期沙箱记录）完全不看模型调用，理论上可能在调用还在进行时收尾。
- 所有改调用记录的写入都在立即事务里先核对当前产品授权（`assertCurrentAuthority`，要求授权租约未释放、未过期、令牌和部署一致）。同一时间只有一个有效授权租约（`sqlite-worker.ts` 约 455-521 行，新租约令牌号是历史最大值加 1）。所以在收尾事务里，如果一条调用记录的授权租约 `authority_lease_id` 不是收尾进程自己正持有的那一条，原租约必然已经失效，那一刻原进程写不进来。第 1 版说“原进程永远写不进来”说过头了：卡住的旧进程醒来后可以重新拿到新授权，再去结清自己的调用；这只会把 `unknown` 改成 `settled` 并补记实际费用，无害。第 1 版说“执行租约过期后旧进程仍能写”也不对，授权核对会挡住。

## 方案（建议采用）

1. 判定“已放弃”：调用是 `reserved` 或 `started`，且它的 `authority_lease_id` 不等于收尾进程当前持有的授权租约编号。判定只在收尾事务里做，和写入在同一个事务里。不用“令牌号大小”或“记录所属部署的令牌”比较，避免授权转移后旧部署令牌不再更新而误判。
2. 收尾规则：三种情况统一用这个判定，“未放弃”的 `reserved`、`started` 一律挡住，“已放弃”的不挡；第二种情况因此会新增“调用还活着就不收尾”的限制。第三种情况的诊断码不再限定为截止时间打断，只要截止时间已过（收尾包装器 `production-run-expiry.ts` 已要求）、没有沙箱记录、资源都已释放即可。
3. 同一个收尾事务里改记录，让记录说真话：已放弃的 `reserved` 改成 `released`，预留费用退回；已放弃的 `started` 改成 `unknown`，原因码新增 `owner_lost`（原执行进程已失去授权），预算分配同步改成 `unknown`，预算账户改为 `reconcile_required`，预估费用不释放。写法是在调用表和预算表的操作类里加专用的事务内方法，复用现有的释放和标记方法，不写裸 SQL；事务内再核对一次状态，被并发结清的调用跳过。
4. 新原因码 `owner_lost` 的读写清单：两张表的约束（只有 `model_invocation_identities`、`model_budget_allocations` 两张，第 1 版写成更多张是错的）；两个解析器白名单；`packages/application/src/ports/model-invocation.ts`、`model-budget.ts` 的类型；网页的原因文字标签。调用许可的 `permit.markUnknown` 不收这个原因，它只给原进程用。
5. 表结构改动：SQLite 改约束要重建这两张表，新增一个迁移。要排在 PA-4 的迁移 0082 合并之后，用下一个编号。
6. 文档：更新 I-88，并说明和 ADR 0124（账户 `reconcile_required` 时不重新派发）、ADR 0140（提前收尾要求没有未决调用）的关系：不改它们的决定，只是把“已放弃”的调用从“未决”里分出来。

## 测试（落在 `test/integration/sqlite-sandbox-execution-v2.test.ts`，按仓库要求声明第 0 层测试）

- 旧授权的 `started`：应收尾；调用变 `unknown`/`owner_lost`，预算账户 `reconcile_required`，预估费用不变。
- 旧授权的 `reserved`：应收尾；调用变 `released`，预留费用退回。
- 授权转移后（部署的授权代数变了）的旧调用：应收尾。
- 当前授权的 `started`、当前授权的 `reserved`：不收尾。
- 第二种情况加当前授权的 `started`：不收尾。
- 反证：其他条件全部满足、只有授权判定挡着的场景；去掉授权判定后它必须被收尾（测试失败）。
- 迁移：新原因码能写入、能读回；迁移前后行数和内容一致。
- 截止之前、其他诊断码的现有场景保持通过。

## 不在范围

- 不改 Pi 本身。
- 不在启动时扫描全部旧调用，只在运行到期收尾时处理这条运行自己的调用。
- 不自动对账费用。
- 不做临时过渡（借用 `cancel_unresolved` 原因码或另写一条追踪记录）：两种都会让记录和实际不符。
