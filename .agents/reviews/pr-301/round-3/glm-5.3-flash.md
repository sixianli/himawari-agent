# PR 301 第 3 轮独立复核（2995d535 → ad9efa55，增量 07db7903 → ad9efa55）

本 PR 全部改动只有三处：`RUN_EXPIRED_RECONCILIATION_SQL` 新增第三分支（packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:60-66）、集成测试新增 4 个场景、I-88 文档行更新。不触及任何发给模型的内容。

## 发现的问题（按严重度从高到低）

**1. 低 · docs/incidents-and-gates.md:122（I-88 行）· 复现数字与代码状态对不上**
- 读代码证实：本 describe 块现有 41 个场景（test/integration/sqlite-sandbox-execution-v2.test.ts:1027-1068，30 个旧场景 + 11 个 deadline-code），`describe.each(["worker","direct"])` → 共 82 条，与作者「整组 82 条通过」一致。
- 但 07db7903（上一轮）时是 30+7=37 场景 ×2 = 74 条。I-88 写「只加测试时 2 条失败……再加 SQL 后 64 条通过」：若当时已有 74 条，74−2=72≠64；64 只对应一个还没有 5 个模型/记录反向场景的中间状态。本轮更新了这一行的场景清单却没更新这个数字，文档自相矛盾。
- 建议：把「64 条通过」改为与当时实际场景集一致的数字，或注明运行时点。
- 推测（无法核实）：Hermes 实际运行结果、「945 条通过」、三次变异的失败条数本身（见下文第 3 题的推断）。

**2. 低 · test/integration/sqlite-sandbox-execution-v2.test.ts:1273-1278 · environment-released 收据在 FK 关闭期间插入，缺生产必需的父行**
- 读代码证实：该 INSERT 发生在 `pragma foreign_keys = OFF`（1198 行）之后、且只在 `deadline-code-model-` 分支里恢复 ON（1271 行），所以收据表的外键 `FOREIGN KEY(environment_id, stop_fence) REFERENCES execution_environment_stop_intents`（packages/persistence-sqlite/src/migrations/0051_srt_task_environment_release.sql:11）未被检查；测试里没有对应 stop_intent 父行，生产上这种收据行不可能存在。
- 被测 SQL（RUN_RESOURCES_RELEASED_SQL 的 43-50 行）只看收据存在与 accepted_at，不查 stop_intent，所以断言仍有效；但「造出的数据状态与真实状态一致」这一点不完全成立。
- 建议：插入前补一行 execution_environment_stop_intents，或注明该行是简化造数。

**3. 低 · apps/agent-service/src/production-run-expiry.ts · 生产收尾包装器无测试（作者已承认），且新分支「截止前不收尾」没有组件级直接用例**
- 读代码证实：夹具 payload 只有 `{version, deadlineAt}`（test 文件 1149-1151 行），而包装器要求 `frozen.startedAt`（production-run-expiry.ts:65），用该夹具走包装器必抛 `RUN_EXPIRY_INPUT_INVALID`——与作者「夹具缺开始时间」的说法一致。
- 组件级「deadline-code 且无沙箱记录且截止前」的组合没有用例：`deadline-code-before-deadline` 有沙箱记录，走的是旧分支；`settleExpiredSync` 的截止守卫对新分支的拦截只由 `c.diagnostic_code='RUNTIME_TOOL_RESULT_UNKNOWN' OR @deadlineAt<=@resourceNow`（sqlite-run-dispatch-operations.ts:425）和包装器 72 行间接保证。
- 建议：补一条带 startedAt 的夹具走 createProductionRunExpiry 的用例，覆盖「截止前列候选→包装器返回 false」整段。

**4. 信息 · 新分支候选查询无时间条件（作者已声明，核实无害）**
- 读代码证实：截止前该类运行也会被 `listReconciliationRequired` 列出（SQL 60-66 行无 @resourceNow）；此时包装器返回 false（production-run-expiry.ts:72），reconciler 转 quarantine（production-run-reconciler.ts:29-37），而 quarantine 对已处于 `reconciling_external_result` 阶段的运行是无操作直接 return（sqlite-run-dispatch-operations.ts:579-592）；包装器抛错也会被 dispatcher 捕获转 quarantine（production-run-dispatcher.ts:310-313）。行为无害属实，只是每轮扫描重复白跑。

**核实无误的部分（读代码证实）**
- SQL 第三分支与外层条件、`RUN_RESOURCES_RELEASED_SQL`（含预热环境释放回执子句，sqlite-run-resource-guard.ts:43-50）的衔接与 I-88 描述一致。
- 四个新场景的造数满足全部 schema 约束：`model_invocation_identities` 的 CHECK（0049:132-175，含 status/reason_code/settled_at/released_at/started_at 组合、authority 字段相等）逐条核对通过；`model_budget_allocations`（0049:50-83）与 `model_budget_accounts`（0049:7-48，`parent_kind='run'` 要求 `account_id='run:'||run_id`）核对通过；authority_leases 父行由夹具真实创建（test/fixtures/sqlite-capability-invocation-fixture.ts:157-165），`LIMIT 1` 不会取空。
- 变异推断与断言结构一致：删模型条件 → 3 个反向模型场景失败 ×2 模式 = 6；删沙箱记录条件 → future-record + null-record 失败 ×2 = 4；删环境释放块 → environment + environment-unreleased 失败 ×2 = 4。与作者报的 6/4/4 吻合。
- null-record 场景不再提前 return、补了 settleExpired 拒绝断言（1513-1516 行）属实；模型反向用例补建 budget 父行属实。

## 侧重检查

走的流程：运行被执行截止时间打断 → `reconciling_external_result` + 诊断码 `RUN_EXECUTION_DEADLINE_EXCEEDED` → 调度扫描 `listReconciliationRequired`（production-run-dispatcher.ts:289，SQL 358 行）→ reconciler（production-run-reconciler.ts:29）→ 生产包装器（production-run-expiry.ts:29-91：读检查点、input 工件、校验 frozen input、72 行截止守卫）→ `settleExpired`（sqlite-run-dispatch-operations.ts:391，ready 查询 420-448 重跑整条 SQL）→ 收尾效果（run failed、租约、command/event/gateway event，测试 1430-1490 行逐项断言）。

结论：组件层路径测试覆盖充分；**无测试覆盖的代码路径**是 production-run-expiry.ts 全文件（问题 3）和 reconciler 的 quarantine 无操作回路（问题 4，已核实无害）。文档与代码一致性方面只有 I-88 的复现数字一处对不上（问题 1）。

## 必答问题逐条回答

1. **请求开头**：不适用。改动只有 SQLite SQL、测试和事故文档，不触及系统提示、工具定义、历史消息或遮盖结果；发给模型的内容不受影响，只追加性不变。
2. **同一段文字不同字节**：不会。SQL 是对数据库状态的确定性查询，没有新增带时间或依赖前后文的模型可见字段；测试时间戳均为固定常量。
3. **自动检查**：有——新场景本身就是检查，正反向成对（settled/released/environment-released 应收尾，reserved/started/unknown/future/null/unreleased 不收尾），按断言结构推断三个条件被删都会被对应反向场景抓住，条数与作者报的 6/4/4 一致；本复核不能运行测试，「变异实际被抓住」标未核实。
4. **每个值的产生与使用**：新 SQL 分支只被 `listReconciliationRequired`（sqlite-run-dispatch-operations.ts:358）和 `settleExpired` ready 查询（同文件:426）使用，后者自带截止守卫（:425）和资源释放复查（recovery SQL:68），两端一致；新测试造的行满足两端 schema 约束（唯环境收据缺 stop_intent 父行，见问题 2）；I-88 文字除复现数字外与代码一致。未发现会出错的遗漏点。
