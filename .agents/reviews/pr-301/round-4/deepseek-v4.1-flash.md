# PR 301 第 4 轮复核（ad9efa55 → 6d13d446）

结论先行：本次增量没有改到任何发给模型的内容，代码与作者的主要说法一致；增量本身没发现高严重度的错误。主要问题集中在「放行后无人对账，账目长期挂起」「放行条件与同文件另外两条分支策略不一致」以及测试没有真正覆盖非零预留和 NULL 原因码。

## 读代码证实的问题（按严重度）

### 1. 中：被放行的 cancel_unresolved 调用收尾后没有任何对账路径，账目永久挂起

- 文件:行：`packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts:486-537`、`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:682-687`、`packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:691-705`
- 问题：收尾只把 run/checkpoint/lease 改为失败并写回执，不碰模型账；被放行的 `unknown` 调用既不会释放预估费用，也没有任何后台或离线代码会把它结清。运行终止后原运行时随租约过期消失，这个调用和 `reconcile_required` 账户就会永久留着。I-88 写「留待对账」，容易被读成「以后会被对账」，但同一条记录也写明「没有后台程序处理」。
- 证据（亲自读到）：
  - `settleExpiredSync` 只做这些写入：`UPDATE runs SET status='failed'...`、`UPDATE run_coordination_checkpoints SET phase='failed'...`、`UPDATE run_execution_leases SET released_at=?...`、`writeRunReceiptInTransaction(...)`，全程没有 `model_invocation_identities` / `model_budget_accounts` / `model_budget_allocations`。
  - `markUnknownWithinTransaction` 写 `SET status = 'unknown', observed_at = ?, reason_code = ? ... AND status = 'started'`，并且未知原因不可变：`if (row.reasonCode !== input.reasonCode) return this.fail("PORT_CONFLICT", "Unknown model invocation reason is immutable")`（`sqlite-model-invocation-operations.ts:691-694`）。
  - 预算侧把账户置为 `reconcile_required` 且保留预留：`this.updateAccount(account, account.reservedCostMicros, account.spentCostMicros, "reconcile_required")`（`sqlite-model-budget-operations.ts:682-687`）。
  - 我检索了 `.settle(` 的调用点：生产侧只有运行中的 permit（`production-run-composition.ts:464/556`）和内存/标题的后台预算，没有针对 run 级 `unknown` 的后台结算器。
- 建议：要么在文档里明确写「这条 `unknown` 永久保留、没有自动对账，只能人工/离线处理」，并提供对应的离线命令；要么把它登记成可查询、可审计的对账待办。若要求账目最终一致，需要补一个真正的结算/对账通道，而不是只放行收尾。

### 2. 中：只放行 cancel，provider/transport 的 unknown 仍会像事故一样永久卡住；且与同文件第二条分支策略不一致

- 文件:行：`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:49-52`、`:53-59`、`:60-67`
- 问题：同一类「无沙箱记录 + RUN_EXECUTION_DEADLINE_EXCEEDED」的运行，cancel 的 `unknown` 放行，provider/transport 的 `unknown` 继续挡住。但代码里同样没有后台程序能结清 provider/transport 的 `unknown`，所以这类运行仍会像 I-88 一样永久卡住。更不一致的是，第二条分支（有已过期沙箱记录）对模型调用完全不设限，provider/transport 的 `unknown` 在那里反而可以收尾。
- 证据（亲自读到）：
  - 第一分支仍是：`AND NOT EXISTS (SELECT 1 FROM model_invocation_identities model ... AND model.status IN ('reserved','started','unknown'))`（第 49-52 行）。
  - 第二分支：`OR (EXISTS (SELECT 1 FROM sandbox_execution_records expired ... ) AND NOT EXISTS (... pending ...))`（第 53-59 行），没有任何模型调用状态条件。
  - 第三分支新增：`(model.status='unknown' AND COALESCE(model.reason_code,'')<>'cancel_unresolved')`（第 67 行）。
- 建议：先明确三种 `unknown` 在收尾后是否还有任何代码能结清（按我读到的代码，都不能），然后统一策略：要么都放行并保留调用行/账户，要么给 provider/transport 建立真正的对账路径。至少要在注释或 I-88 里写清为什么只有 cancel 被区别对待，否则下一个 provider_unresolved 卡住时还会是一条新的 I-88。

### 3. 低：I-88 把 cancel_unresolved 限定为「到期取消后没确认结果」，与代码不符

- 文件:行：`docs/incidents-and-gates.md:122`；`packages/runtime-pi/src/pi-runtime-adapter.ts:808-811`、`:855-857`、`:1030-1032`；`packages/platform-node/src/trusted-model-provider.ts:274`、`:280-282`、`:290-292`
- 问题：`cancel_unresolved` 不是到期专用，任何 `signal.aborted`（用户停止、服务停止、权限变化等）都会写这个原因码。I-88 的括注「到期取消后没确认结果」把语义写窄了；在本分支因还要求 `diagnostic_code='RUN_EXECUTION_DEADLINE_EXCEEDED'`，影响有限，但文档与代码不一致。
- 证据（亲自读到）：
  - `signal?.aborted ? "cancel_unresolved" : "provider_unresolved"`（`pi-runtime-adapter.ts:810`、`:856`）
  - `request.signal?.aborted ? "cancel_unresolved" : "provider_unresolved"`（`trusted-model-provider.ts:274`）
- 建议：改成「调用被取消（含到期取消）后结果未确认」这类准确表述。

### 4. 低：新用例无法证明「预估费用不释放」，因为预留被写成 0

- 文件:行：`test/integration/sqlite-sandbox-execution-v2.test.ts:1218`、`:1232`
- 问题：新增断言 `expect(after.models).toEqual(before.models)` / `expect(after.budgetAccounts).toEqual(before.budgetAccounts)` 想证明收尾不改模型调用和预算账户，但夹具把账户 `reserved_cost_micros`、分配 `estimated_cost_micros` 都写成 0。即使实现把非零预留错误清掉，这个用例也看不出来。
- 证据（亲自读到）：`VALUES(?,?,?,'run',?,'private',0,0,?,1)`，以及 `...estimated_cost_micros,actual_cost_micros...` 传入的估算费用是 `0`。
- 建议：给 cancel 场景写非零预留（例如 7 微美元）和非零 spent，断言收尾后 `reserved_cost_micros`、`estimated_cost_micros` 原样保留、`status` 仍为 `reconcile_required`。

### 5. 低：NULL 原因码的 COALESCE 分支是 schema 禁止的死防御，且没有测试

- 文件:行：`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:67`；`packages/persistence-sqlite/src/migrations/0049_thread_title_budget.sql:141-157`；`packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:37-41`；`packages/application/src/services/model-invocation-admission-service.ts:564-571`
- 问题：数据库 CHECK 已经保证 `status='unknown'` 时 `reason_code IS NOT NULL`，所以 NULL 原因码的 `unknown` 在当前 schema 下根本插不进去，`COALESCE(...,'')` 的 NULL 分支无法被正常测试覆盖。同时 `'cancel_unresolved'` 这个字面量在 SQL、准入校验、持久化校验、迁移 CHECK 里重复出现，存在 I-73 式的漂移风险。
- 证据（亲自读到）：
  - `CHECK ((status IN ('reserved','started','settled','released') AND reason_code IS NULL) OR (status='unknown' AND reason_code IS NOT NULL))`（`0049_thread_title_budget.sql:141-157`）
  - `UNKNOWN_REASONS = ["provider_unresolved","transport_unresolved","cancel_unresolved"]`（`sqlite-model-invocation-operations.ts:37-41`）
  - 准入服务同样硬编码三个值（`model-invocation-admission-service.ts:566-568`）。
- 建议：把原因码抽成共享常量/枚举，让 SQL 与校验、schema 通过测试绑定；若保留 COALESCE，用 `PRAGMA ignore_check_constraints` 或纯 SQL 单测覆盖 NULL，否则删掉并注明由 schema 保证。

## 推测（未完全证实）

- 推测：当 provider/transport 异常与 `signal.aborted` 同一时刻发生时，代码优先写 `cancel_unresolved`（`pi-runtime-adapter.ts:808`、`:856` 的分支选择），可能把本应挡住收尾的服务商/网络未知掩盖成 cancel。后果只是「要不要挡住收尾」，调用仍是 `unknown`，不会造成账目删除，但会让本分支的判断依据不够纯粹。
- 推测/未核实：文档说新分支在截止前也会被列为候选「行为无害」。我确认了收尾包装器会在截止前返回 false（`production-run-expiry.ts:72`），也确认 quarantine 对这种 phase 是空操作（`sqlite-run-dispatch-operations.ts:579-592`）；但「RUN_EXECUTION_DEADLINE_EXCEEDED 在截止前不会大量出现」这一点没有生产数据核实，无法确认不会造成重复扫描开销。

## 侧重检查

- 错误路径 / 不合规输入：原因码在准入服务、`UNKNOWN_REASONS`、`parseUnknown`、DB CHECK 四处校验；未知值或 NULL 在 SQL 里都会被当成「挡住」（`COALESCE` 后不等于 `cancel_unresolved`），属于安全失败方向。没有外部用户输入进入这条 SQL。
- 安全：SQL 里只新增常量字面量，没有拼接外部字符串，无注入面。
- 资源耗尽：收尾不释放非零预算预留，账户永久 `reconcile_required`（见问题 1）；这是会计层面的挂账，不是内存/句柄耗尽。预算账户按 run 作用域，不会阻塞同线程后续新 run（`sqlite-run-dispatch-operations.ts:264-270` 只查同一个 `run_id`）。
- 不可撤销操作：`settleExpired` 把 run 永久写成 failed。确认没有在截止前执行：包装器 `if (at < frozen.deadlineAt && diagnostic !== 'RUNTIME_TOOL_RESULT_UNKNOWN') return false;`（`production-run-expiry.ts:72`），且 `settleExpired` 的 ready 条件要求 `c.diagnostic_code='RUNTIME_TOOL_RESULT_UNKNOWN' OR @deadlineAt<=@resourceNow`（`sqlite-run-dispatch-operations.ts:425`）。
- 规则/文档一致：I-88 与代码基本一致，但 cancel 原因码的描述偏窄（问题 3），「留待对账」与实际无对账路径有落差（问题 1）。
- 运行已收尾 ⇒ 模型调用已结清：我检索了 `model_invocation_identities`、`model_budget_accounts`、`model_budget_allocations` 在持久化层和应用层的使用，没有发现「终态 run 必须没有 unknown 调用」这类反向断言；唯一的门禁是 `reconcile_required` 阻止同一 run 的派发/占用恢复，而该 run 已终态，不再参与。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本增量只改了收尾 SQL、I-88 文档和测试；收尾写入的是 runs / run_coordination_checkpoints / run_execution_leases / command_results / reliable_events / thread_gateway_events / 回执，没有碰系统提示、工具定义、历史消息、遮盖器或任何组装请求的代码（`sqlite-run-dispatch-operations.ts:486-537`）。发给模型的内容仍然只在末尾追加，没有新增每轮变化的值。依据 [prompt-prefix 规则第 4 条](../../.claude/rules/prompt-prefix.md#rules) 与本次 diff。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。没有改动序列化、键顺序、集合顺序或遮盖；SQL 里的 `@resourceNow` 只用于资源是否过期的判断，不进入任何模型可见内容。这个改动不涉及「请求字节确定性」的问题。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有。`deadline-code-model-unknown-cancel` 在旧 SQL 下会被 `status='unknown'` 挡住（第一/第二分支都不成立，第三分支旧条件要求 `NOT EXISTS ... status IN ('...','unknown')`），所以改前必然失败；`deadline-code-model-unknown-transport` / `-unknown` / `-reserved` / `-started` 在负向组里断言 `listReconciliationRequired` 为空且 `settleExpired` 抛错，若把条件放宽成「所有 unknown 都放行」这些用例会失败。两点缺口：NULL 原因码没有用例（schema 也插不进去），生产包装器 `production-run-expiry.ts` 没有针对这条路径的单测（I-88 自己也写了「未覆盖」）。Hermes 上 86 条通过的结论本次无法运行测试，**未核实**。

4. **每个产生/修改的值，各使用点都接受吗？**
   - `cancel_unresolved` 的生产者：`pi-runtime-adapter.ts:790/810/856/868/880/1031`、`trusted-model-provider.ts:225/274/281/291`，都写小写字面量。
   - 校验方：`model-invocation-admission-service.ts:566-568`、`sqlite-model-invocation-operations.ts:37-41` 的 `UNKNOWN_REASONS`、`sqlite-model-budget-operations.ts:939-945`，都接受这个值；DB CHECK（`0023`/`0024`/`0049`）也允许它。
   - 新消费者：`sqlite-sandbox-tool-result-recovery.ts:67` 只比较 `cancel_unresolved`，与生产者一致；测试用 `["cancel"].map(x => x + "_unresolved")` 生成的值也正好匹配（`sqlite-sandbox-execution-v2.test.ts:1207-1210`）。
   - 结论：当前没有两端不匹配。风险在于同一个字符串散落在 SQL、两处校验、四处迁移 CHECK 中，属于 I-73 那类「多处使用、只改一处」的隐患，建议抽共享常量并用测试绑定。
