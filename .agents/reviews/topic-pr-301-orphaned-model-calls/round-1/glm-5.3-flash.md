现在我来读取 worker fencing token 的逻辑和预算操作。
# 审核结论（PR 301 追加方案：崩溃后停在“进行中”的模型调用）

## 证实的 问题（按严重度从高到低）

### 1.【高】方案的关键事实陈述有一处是错的，且“令牌号小 ⇒ 原进程永远写不进来”说过头了
**问题**：方案“已核对的事实”第 5 条说“同一个仍活着的进程在租约过期后仍能写 `settle` 和 `markUnknown`（`assertExecutionLease` 只比对冻结的租约，不检查租约是否还有效）”——**不成立**。同时第 4 条“记录里的令牌号小于部署当前令牌号时，原进程已经永远写不进来”也**过头了**。

**证据**：
- `settle`、`markUnknown`、`releaseReserved` 在改状态**之前**都调用了 `assertCurrentAuthority`（`packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:606、643、688`）；`markStarted` 自己没调，但它调的预算侧 `markStartedWithinTransaction` 第一行就调（`sqlite-model-budget-operations.ts:561`；`reserveWithinTransaction` 同样在 `:449`）。`assertCurrentAuthority`（`sqlite-model-invocation-operations.ts:789-826`）核对：租约 `status='active'`、`released_at` 为空、`expires_at > at`、租约令牌 == 部署令牌 == scope 令牌。所以**授权租约过期后，任何进程都写不进来**，方案里“子任务读代码得出”的那条风险不存在。
- 但“永远写不进来”仍不对：卡住（未死）的旧进程苏醒后，若当前租约已死，可以 `claimLease` 拿到**全新令牌**（`sqlite-worker.ts:455-521`，令牌 = `MAX(fencing_token)+1`），然后凭新令牌通过 `assertCurrentAuthority`，而冻结执行租约比对（`assertExecutionLease`，`:828-835`）对它照样通过——它能 `settle`/`markUnknown` 自己留下的调用记录。缓解：这只可能发生在收尾**之后**（收尾前旧令牌相等则判“未放弃”、不收尾），且后果无害甚至有利（`unknown→settled` 补记实际费用；对已改 `released` 的记录是幂等返回，`:609`）。结论应写成“收尾判定时刻，旧令牌持有者不可能再写入”，而不是“永远”。

**建议**：改写方案里的这两条事实；安全论证改为“收尾判定与写入在同一 immediate 事务内，判定时刻旧令牌持有者必然无法通过 `assertCurrentAuthority`”。这一改动让方案**更**安全，不影响方案 1 成立。

### 2.【高】新增原因码 `owner_lost` 漏了全部读取端校验——正是 I-73 的模式（“只看改动本身”）
**问题**：方案第 4 步只说“两张表的原因码约束要加 `owner_lost`”。但读了带 `owner_lost` 的行会直接被 TypeScript 解析器拒绝，`PORT_INVALID_OPERATION`，读端口、对账、报表全挂。

**证据**（每个都要同步改，缺一个就复现 I-73 类故障）：
- `sqlite-model-invocation-operations.ts:37-41` 的 `UNKNOWN_REASONS` 常量与 `:183-192` 的 `unknownReason()`，被 `parseRow:891-895` 用于**每一次读行**；
- `sqlite-model-budget-operations.ts:1303-1311`（`parseAllocation` 白名单）和 `:940` 附近的同类白名单、`:79` 的类型；
- `packages/application/src/ports/model-invocation.ts:48`、`model-budget.ts:75、121` 的类型联合；
- `model-invocation-admission-service.ts:564-571` 的 `permit.markUnknown` 校验——这里**不应**加 `owner_lost`（permit 只给原执行进程用），方案要写明这个决定，防止实施时“顺手”加进去；
- UI 侧 `apps/control-center/src/execution-view.ts:390` 用 `Object.hasOwn(reasonLabels, reasonCode)` 有兜底，不致命，但要决定是否加三语标签（未核实 i18n 全部引用点）。

**建议**：在方案里列一张“产生方/使用方”清单，逐项写明改或不改及理由。

### 3.【中】第三种情况的诊断码扩得不全，还有两类运行会以同样方式永久卡住（I-88 同类）
**问题**：方案只把 `PERSISTED_EXECUTION_RECONCILIATION_REQUIRED`、`RUNTIME_ATTEMPT_INTERRUPTED` 加进第三种情况。但 `reconcileUnknown` 也会写 `EXECUTION_LEASE_RENEWAL_FAILED`、`SERVICE_STOPPING` 等诊断码（`apps/agent-service/src/production-run-dispatcher.ts:541-556`），这些运行同样会留下 `reserved`/`started` 调用，同样不满足第三种情况，同样永远卡住。

**建议**：既然方案 1 的令牌判定本身就是安全闸（原进程还活着 ⇒ 令牌相等 ⇒ 不收尾），诊断码在这里不是安全条件，只是范围限制。要么把这两个码一并纳入，要么明确写“本 PR 只管崩溃类，其余另开 PR”，否则 I-88 会以第三种变体再犯。

### 4.【中】“两张表（以及标题、记忆预算表）”表述有误
**证据**：原因码 CHECK 只存在于 `model_invocation_identities` 和 `model_budget_allocations` 两张表（`migrations/0049_thread_title_budget.sql:68-70、141-143`）；thread-title、memory-projection 只是同一张 `model_budget_allocations` 的 `parent_kind`（同文件 `:11`），没有另外的表。结论方向不变（要重建这两张表），但数字要写对。

### 5.【中】测试计划缺两个用例，也没写测试落在哪、按 I-05 声明第 0 层
**证据**：I-88 的同类测试都在 `test/integration/sqlite-sandbox-execution-v2.test.ts`（`deadline-code-*` 系列场景）；方案没说新场景放哪、是否进 `npm run check`，也没按 I-05 的 `check-layer0-tests.py` 声明相关测试（`sqlite-run-dispatch-lease.test.ts` 也直接相关）。缺的用例：(a) **epoch 分支**——授权转移后 `deployments.authority_epoch` 会变、令牌被重写（`sqlite-authority-transfer.ts:934`），必须验证“epoch 不同即判定放弃”这条路真的会走（否则实现者只写令牌比较也能过现有用例，转移场景下再次卡死）；(b) **当前令牌的 `reserved` 调用不收尾**（方案只列了 `started` 的）。

### 6.【低】“reserved→released、预留退回”与已有的 `modelBudget.finalize` 语义重复
**证据**：`sqlite-model-budget-operations.ts:758-821` 的 `finalize`（运行终态后统一释放 `reserved` 分配、按 unknown 决定 `reconcile_required`）正是这个语义，但目前**没有任何生产调用方**（只有测试 `test/integration/sqlite-model-budget-operations.test.ts:739、1089、1116` 调它）。建议收尾事务复用/对齐 finalize 的语义，并在方案里记一笔“finalize 尚无生产接线”。

## 推测（未核实）
- 生产库现存卡住运行的诊断码具体是哪个值、其调用的令牌号与当前部署令牌号的实际差值——需要只读查生产库才能确认方案上线后能救回 I-88 那条运行（推测可以，因为崩溃重启必然换新租约、令牌必然增大，`sqlite-worker.ts:484-490`、`production-authority-lifecycle.ts:163-171` 每个进程 `holderId` 都是新的 `randomUUID`）。
- UI/报表侧还有没有别处对 `reason_code` 做白名单或翻译（`execution-view` 的兜底之外的引用点）。

## 业界核对（一手来源）
- 方案引用的 Temporal 文档属实且概括准确：https://docs.temporal.io/encyclopedia/detecting-activity-failures 原话 "The Temporal Server doesn't detect failures when a Worker loses communication with the Server or crashes. Therefore, the Temporal Server relies on the Start-To-Close Timeout to force Activity retries."——即“靠时限判定失败，不靠原执行者收尾”，与方案共同点一致。
- Stripe 幂等重试（https://docs.stripe.com/api/idempotent_requests）概括无误。
- 补一条更贴切的一手来源：本方案“令牌号小 ⇒ 旧持有者写不进”正是 fencing token 的标准用法，Martin Kleppmann《How to do distributed locking》（https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html）："you need to include a fencing token with every write request to the storage service... the storage server remembers that it has already processed a write with a higher token number, and so it rejects the request"。本仓库 `assertCurrentAuthority` 在同一事务内核对令牌并写入，满足该文的要求（核对与写入之间无间隙——都在 immediate 事务里）。

## 侧重检查
我走的最普通流程：用户发消息 → `runs` accepted → `claimAndLaunchInternal`（先 `recover()` 再认领，`production-run-dispatcher.ts:448-524`）→ 执行中模型调用 `begin`（reserved）→ `markStarted` → 回复后 `settle` → 运行终态。逐段核对：
- 崩溃分支（无测试覆盖的正是它）：进程死 → 重启拿新租约（令牌 +1）→ `recover()` → `quarantine` 进 `reconciling_external_result`、诊断 `PERSISTED_EXECUTION_RECONCILIATION_REQUIRED`（`:306-309`）→ 到期包装器 `production-run-expiry.ts:29-91`（要求冻结输入、阶段匹配、截止已过）→ `settleExpiredSync`（`sqlite-run-dispatch-operations.ts:391-541`，单事务、`assertCurrentAuthority` 在 `:408`）→ 运行 `failed`。**现有代码在这条链上对“遗留 started 调用”的运行没有任何收尾出口**（`RUN_EXPIRED_RECONCILIATION_SQL` 第三种情况，`sqlite-sandbox-tool-result-recovery.ts:66-72`），方案诊断正确。
- 测试覆盖：`sqlite-sandbox-execution-v2.test.ts` 的 `deadline-code-*` 场景（I-88）覆盖了“unknown 调用放行”，**没有**覆盖“旧令牌 started/reserved 调用”；方案的测试计划补上了主体，缺第 5 条列的两个用例。
- 文档一致性：`docs/incidents-and-gates.md` I-88 条目、`docs/architecture-v0.1.md:512` 与本方案不冲突；`.claude/rules/prompt-prefix.md` 不涉及（见必答问题 1、2）。

## 如果由我来定
以**方案 1**为基线，做以下修正：判定写法上，收尾者直接用自己 scope 里的 authority fence 与记录的 `authority_fencing_token`/`authority_epoch` 比较（事务内 `assertCurrentAuthority` 已保证它等于部署当前值，不必另读 deployments）；诊断码扩到崩溃类之外至少再加 `EXECUTION_LEASE_RENEWAL_FAILED`、`SERVICE_STOPPING`，或干脆不按诊断码区分、只靠令牌判定+截止+资源条件；补齐 `owner_lost` 的全部读取端（第 2 条清单），并写明 `permit.markUnknown` 不收它；测试补 epoch 分支和“当前令牌 reserved 不收尾”，落在 `sqlite-sandbox-execution-v2.test.ts`、按 I-05 声明第 0 层；排 PA-4（0082）合并后再做迁移。方案 2 违反“记录说真话”，方案 3 篡改原因码语义，都不取；若 PA-4 排期太久，可临时用沙箱先例（`sandboxUnrecoverableResultOperationKey` 式 trace artifact，`production-tool-result-recovery.ts:53-59`）做不改表的过渡，但那只是过渡。

## 必答问题
1. **不会改变请求开头**。本方案只动持久层状态机、收尾 SQL 和表约束，不触碰系统提示、工具定义、历史消息、遮盖；发给模型的内容一个字节都不变（规则 `.claude/rules/prompt-prefix.md` 第 4 条未触及）。
2. **不会产生字节不确定**。新增的值（`owner_lost`、状态、时间戳）只写数据库，不进任何模型请求；没有依赖前后文的遮盖、无带时间字段进请求、无集合顺序问题。
3. **有对应检查计划**：集成测试（建议落在 `test/integration/sqlite-sandbox-execution-v2.test.ts`，沿用 I-88 的“改前失败、改后通过”格式）+ 反向用例“去掉令牌比较，‘原进程还活着’场景必须失败”——这个反证设计是对的（令牌比较正是安全属性主体）。需补 epoch 分支的反证和 I-05 第 0 层声明。
4. **逐对核对结果**：`owner_lost` 的产生方（收尾事务）→ 使用方：两张表 CHECK（迁移覆盖）、SQLite 解析器两处、application port 类型两处（方案**漏了**，见问题 2）、admission permit 校验（明确不加）、UI 兜底存在但标签未定；`released` 转换的产生方 → `requireRow`/幂等分支（`:609`）和 `modelBudget.finalize` 语义（问题 6）均兼容。诊断码扩大 → `settleExpiredSync` 的 ready 检查与候选查询共用同一条 SQL（`sqlite-run-dispatch-operations.ts:358、426`），两端一致。
