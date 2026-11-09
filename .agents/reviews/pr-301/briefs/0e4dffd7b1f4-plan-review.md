# 方案草稿：服务崩溃后停在“进行中”的模型调用（PR 301 追加）

状态：草稿，待复核和 Andy 同意，尚未动代码。

## 两个先回答的问题

1. 业界遇到同样情况怎么做、用户看到什么。ChatGPT、Claude 这类产品在生成途中服务出故障时，这一轮直接以出错结束，用户看到“出错了，请重试”，对话不会一直挂着；费用由服务端按实际用量另行对账，不靠这一轮自己收尾。通用的后台任务框架也是这个思路：Temporal（运行后台任务的框架）文档说服务端不会直接发现工作进程崩溃，而是靠“从开始到结束最多多久”的时限判定失败（https://docs.temporal.io/encyclopedia/detecting-activity-failures）；Stripe（支付服务）用请求编号让结果不确定的请求能安全重试，账务以服务端记录为准（https://docs.stripe.com/api/idempotent_requests）。共同点：用一个能证明“原执行者不可能再写入”的信号来判定任务已放弃，然后按失败收尾，账另算。
2. 根因还是表面修补。根因是：模型调用记录只有“原进程自己”能把 `reserved`（已预留）、`started`（进行中）改成别的状态，进程崩溃后没有任何程序接手。本方案补的是这个接手机制，属于根因修复。

## 已核对的事实（读代码，未运行）

- 只有原进程里的调用许可会改 `model_invocation_identities` 和 `model_budget_allocations` 的 `reserved`、`started`：`packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts` 的 `markStarted`、`releaseReserved`、`settle`、`markUnknown`，以及预算表里对应的方法。启动、巡检、对账代码都不碰这两种状态。
- 崩溃后的运行会被恢复流程（`apps/agent-service/src/production-run-dispatcher.ts` 的 `recover`）放进隔离状态 `reconciling_external_result`，诊断码一般是 `PERSISTED_EXECUTION_RECONCILIATION_REQUIRED`（或重新认领后的 `RUNTIME_ATTEMPT_INTERRUPTED`），不会变成终态。
- 到期收尾规则 `RUN_EXPIRED_RECONCILIATION_SQL` 的第一、第三种情况都要求没有 `reserved`、`started` 调用，而且第三种情况只认诊断码 `RUN_EXECUTION_DEADLINE_EXCEEDED`。所以这种运行如果没有已过期的沙箱记录，会一直卡着，和 I-88 一样挡住上线。
- 能证明原进程不可能再写入的信号已经存在：每次服务启动拿到新的产品授权时，令牌号 `fencing_token` 加 1（`packages/persistence-sqlite/src/sqlite-worker.ts` 约 484-496 行），同一时间只有一个有效授权。调用记录里存了写入时的令牌号 `authority_fencing_token`；改调用状态前会核对当前授权（同文件 `assertCurrentAuthority`，要求令牌号相等）。所以记录里的令牌号小于部署当前令牌号时，原进程已经永远写不进来。
- 只看运行执行租约过期不够安全：同一个仍活着的进程在租约过期后仍能写 `settle` 和 `markUnknown`（子任务读代码得出，`assertExecutionLease` 只比对冻结的租约，不检查租约是否还有效）。

## 方案

### 方案 1（建议）：收尾时由新进程接手旧进程留下的调用

1. 判定“已放弃”：调用是 `reserved` 或 `started`，且记录里的 `authority_fencing_token` 小于部署当前的 `fencing_token`（或授权代数 `authority_epoch` 不同）。只要原进程还持有授权，就不算放弃，继续挡住。
2. 收尾规则：第三种情况的诊断码扩大到崩溃留下的 `PERSISTED_EXECUTION_RECONCILIATION_REQUIRED`、`RUNTIME_ATTEMPT_INTERRUPTED`，仍要求截止时间已过（收尾包装器 `production-run-expiry.ts` 已经这样要求）、没有沙箱记录、资源都已释放；“已放弃”的调用不挡。
3. 在同一个收尾事务里改调用记录，让记录说真话：已放弃的 `reserved` 改成 `released`（从没发出，不花钱，预留费用退回）；已放弃的 `started` 改成 `unknown`，原因码新增 `owner_lost`（原执行进程已失去授权），预算分配同步改成 `unknown`，预算账户改为 `reconcile_required`，预估费用不释放。之后运行按失败收尾。
4. 代价：两张表（以及按同样约束建的标题、记忆预算表）的原因码约束要加 `owner_lost`。SQLite 改约束要重建表，这是表结构改动，按规矩需要 Andy 同意；上线包要重新生成并多一次数据库迁移。

### 方案 2：只改收尾条件，不改调用记录

判定和收尾条件同方案 1 的第 1、2 步，但调用记录保持 `started`。不用改表结构。缺点：调用记录会永远显示“进行中”，和实际不符；预算账户也不会进入 `reconcile_required`，对账时看不出这笔钱没确认。

### 方案 3：改成 `unknown` 但借用现有原因码 `transport_unresolved`

不用改表结构，记录不再显示“进行中”。缺点：原因码写的是“网络中断”，实际是进程崩溃，记录不真实。

## 需要测试的情况（方案 1）

- 旧令牌的 `started` 调用、诊断码为崩溃码、截止已过：应收尾；调用变 `unknown`/`owner_lost`，预算账户 `reconcile_required`，预估费用不变。
- 旧令牌的 `reserved` 调用：应收尾；调用变 `released`，预留费用退回。
- 当前令牌的 `started` 调用（原进程还活着）：不收尾。
- 截止之前：不收尾。
- 有沙箱记录、诊断码是其他值：不受影响（现有测试保持通过）。
- 反证：去掉令牌比较时，“原进程还活着”场景必须失败。

## 不在范围

- 不改 Pi 本身（项目原则）。
- 不做“启动时统一扫描全部旧调用”，只在运行到期收尾时处理这条运行自己的调用，避免影响还在跑的其他运行。
- 不自动对账费用，`unknown` 调用仍只作记录。

## 附：给复核方的背景和请特别核对的点

背景约束：
- 同一时间只允许一个“改表结构（加迁移）”的任务在进行。现在 PA-4（迁移 0082）占着，所以任何要改表约束的方案都要排在它合并之后再做；不改表的方案可以马上做。
- 项目原则：不改 Pi 本身；记录必须说真话（显示和实际不一致算缺陷）；不要写死、能动态判断的不写死。

请特别核对（请自己读代码给结论，不要采信上文的说法）：
1. “记录里的 `authority_fencing_token` 小于部署当前的 `fencing_token`，就能证明原进程再也写不进来”是否成立？读 `packages/persistence-sqlite/src/sqlite-worker.ts` 约 484-496 行（令牌号怎么递增、授权怎么获取）和 `packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts`、`sqlite-model-budget-operations.ts` 里的 `assertCurrentAuthority`（改状态前核对什么）。要考虑：同一进程里租约续期、同一部署多个租约、旧进程只是卡住（没死）后又恢复、授权过期但令牌号没变、`authority_epoch` 与令牌号的关系，以及“核对授权”和“写入”是否在同一个事务里（有没有检查后写入的时间差）。
2. 有没有不改表结构、又不让记录失真的做法？请考虑方案 1、2、3 以外的做法，例如：用现有原因码里本来就合适的一个、把“进行中”以外的现有状态用起来、不动调用记录而在别处留下可对账的事实、在启动时而不是到期时处理，等等。请读 `model_invocation_identities`、`model_budget_allocations` 及预算账户的表约束和现有迁移，判断哪些状态和原因码组合已经允许。
3. 方案 1 里“预估费用不释放、预算账户改为 reconcile_required”对后续运行有什么影响（会不会让这个部署之后的调用都被拦住）？
4. 业界成熟做法（可以上网查一手资料）：崩溃后遗留的“进行中”外部调用怎么收尾、怎么对账。
