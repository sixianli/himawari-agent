# 复核结论（PR 301，基线 2995d535 → 40907d24）

## 读代码证实的部分

改动本体（git diff）：
- `packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:60-66`：`RUN_EXPIRED_RECONCILIATION_SQL` 新增第三分支（诊断码 `RUN_EXECUTION_DEADLINE_EXCEEDED` + 无任何沙箱记录 + 无 reserved/started/unknown 模型调用）。
- `test/integration/sqlite-sandbox-execution-v2.test.ts:1058-1059`：新增两个场景。
- `docs/incidents-and-gates.md:122`：新增 I-88。

作者的说法逐条核对：
- 「原来只认两种情况」——**属实**（旧分支见现文件第 48、53 行）。
- 「新增第三种情况的条件」——**与代码一致**。
- 「`deadline-code-no-records` 改前失败、改后通过」——按代码推理**成立**：旧 SQL 下该状态两分支都不满足（第 48 行要求 `RUNTIME_TOOL_RESULT_UNKNOWN`，第 53 行要求存在已过期沙箱记录），运行不会被 `listReconciliationRequired` 列出，`settleExpired` 也会在 ready 检查处失败。未实际运行测试（本次复核不能执行命令）。
- 「`deadline-code-before-deadline` 截止之前不收尾」——行为属实，但**这个行为不是新分支保证的**（见问题 2）。
- 「生产运行只有沙箱预热、无沙箱命令记录」「跑了约 5 分钟以 failed 结束」——生产日志不在仓库，**未核实**。
- I-88 里说「要在停服窗口用离线收尾命令处理」——仓库 `scripts/operations/` 里**没有**任何离线收尾命令，这条说法在代码里没有对应物（未核实，可能是仓库外工具）。

## 按严重度排列的问题

**1.（中）测试夹具绕过了生产收尾包装器，生产侧前置条件零覆盖**
- 文件:行：`test/integration/sqlite-sandbox-execution-v2.test.ts:1140-1142`、`apps/agent-service/src/production-run-expiry.ts:39-73`
- 问题：夹具的冻结输入是 `{version:"run-execution-input.v2", deadlineAt:T2}`，**没有 `startedAt`**；而生产包装器 `createProductionRunExpiry` 要求 `frozen.startedAt` 合法且 `deadlineAt-startedAt≤86400000`（production-run-expiry.ts:63-68），并在截止前直接返回 false（第 72 行）。测试直接调 `recovery.settleExpired`，整个包装器（含截止前预检、冻结输入校验）没有任何测试引用（grep 无 `*.test.ts` 引用 `createProductionRunExpiry`）。
- 证据：测试第 1141 行 `JSON.stringify({ version: "run-execution-input.v2", deadlineAt: T2 })`；production-run-expiry.ts:65 `typeof frozen.startedAt !== "string"` 即抛 `RUN_EXPIRY_INPUT_INVALID`。
- 建议：夹具补 `startedAt`，并至少加一条走 `createProductionRunExpiry` 的集成用例；I-88 的只读查询应确认生产冻结输入含合法 `startedAt`。

**2.（低，但需明确回答材料的问题）「截止前不收尾」不由新分支保证**
- 文件:行：`packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts:425`、`apps/agent-service/src/production-run-expiry.ts:72`、`sqlite-sandbox-tool-result-recovery.ts:60-66`
- 问题：第三分支本身**没有任何时间条件**。截止前不收尾由两处别的地方保证：`settleExpiredSync` 的 ready 查询第 425 行 `(c.diagnostic_code='RUNTIME_TOOL_RESULT_UNKNOWN' OR @deadlineAt<=@resourceNow)`，以及生产包装器第 72 行的预检。因此新分支导致截止前的 deadline-code 运行**会被 `listReconciliationRequired`（第 358 行 OR）持续列出**——每个扫描周期做一次 payload 查找、解密、哈希、JSON.parse、source 读取，然后 `settleExpired` 返回 false、`quarantine` 因已在 reconciling 态早退（dispatch-operations.ts:579-591）不改动。行为正确但新增周期性开销，且「截止前会被列出」这一新行为没有测试断言（`deadline-code-before-deadline` 不在第 1299-1307 行的列表断言里；且该场景在 SQL 改前也会通过，因为它测的是第 425 行的既有限制，不测新分支）。
- 建议：接受现状的话，在测试里显式断言「截止前被列出但不收尾、quarantine 不改状态」，把这个隐含约定固化。

**3.（低）`settleExpired` 不检查后台占用，新分支扩大了暴露面**
- 文件:行：`sqlite-run-dispatch-operations.ts:420-438`（ready 查询无 `run_background_holds` 检查）对比 `sqlite-run-dispatch-operations.ts:360-364`（`listReconciliationRequired` 有）。
- 问题：直接调 `settleExpired` 可收尾一个有未释放 background hold 的 deadline-code 运行。此缺陷对分支 1、2 预先存在，但第三分支新增了一类可收尾状态。生产唯一调用方（sweep）已先经 holds 过滤，风险低。
- 建议：把 background-hold 检查加进 ready 查询，保持两端一致。

**4.（低）I-88 的「未确认」清单不完整，收尾可能依然落空**
- 文件:行：`sqlite-sandbox-tool-result-recovery.ts:60-67` + `sqlite-run-resource-guard.ts:5-51`
- 问题：第三分支除了诊断码和模型调用状态，还要求「无任何沙箱记录」且整个 `RUN_RESOURCES_RELEASED_SQL` 成立（occupancy、barrier、admission queue、execution environment 释放凭证、租约）。生产运行「只有沙箱预热」——若预热留下了未删的沙箱记录/排队项/环境且缺释放凭证，或冻结输入工件缺失，这条运行依然收不了尾，`TWENTYNINTH_MAINTENANCE_NON_TERMINAL_RUNS` 会再次拦下上线。I-88 只说要确认「诊断码和模型调用状态」，漏了这些前提。
- 建议：收尾前把整个谓词当作只读 SQL 跑一遍，而不是只查两个点。

**5.（信息）「有未决模型调用的场景没有单独测试」确实是缺口**——夹具里没有任何 `model_invocation_identities` 插入，负例（reserved/started/unknown 不收尾）没有反向测试。作者在 I-88 已如实声明。

## 侧重检查

走通的普通流程：运行执行 → 截止定时器触发 `interruptExecution(RUN_EXECUTION_DEADLINE_EXCEEDED)`（run-coordinator.ts:393-398）→ `RunExecutionInterruptedError`（run-coordinator.ts:115-126、405-408）→ dispatcher `reconcileLeaseFailure(error.reasonCode)`（production-run-dispatcher.ts:595-597）→ `quarantine` 写入 `phase='reconciling_external_result'` + `diagnostic_code='RUN_EXECUTION_DEADLINE_EXCEEDED'`（dispatch-operations.ts:613 ELSE 分支）→ 之后的扫描经 `listReconciliationRequired`（新分支）→ `settleExpired` → run/checkpoint 置 failed、写回执、run.failed 事件、线程版本、网关事件（dispatch-operations.ts:486-537）→ 展示层按 `expiredWithoutSandboxResources` 显示 failed（thread-execution-state.ts:282-289、311）。

结论：
- 这个状态机的产生端和消费端在代码里闭合，卡住状态的产生路径（quarantine 写该诊断码）与本次新增的识别分支匹配。
- **无测试覆盖的路径**：`production-run-expiry.ts` 全部（问题 1）；quarantine 写码 → 第三分支收尾的组合只能靠两半各自的测试拼起来（quarantine 侧在 `sqlite-run-dispatch-lease.test.ts:1293` 附近，收尾侧在本文件），没有一条端到端用例从打断走到收尾；截止前被列出的行为（问题 2）。
- 文档一致性：I-88 条目描述的条件与 SQL 逐字一致；规则文件 `.claude/rules/prompt-prefix.md` 与本改动无交集。

## 必答问题

1. **不会改变模型已见过的请求开头。**改动只在 SQLite 收尾谓词里，不组装、不改写任何发给模型的内容（系统提示、工具、历史、遮盖均无关）；收尾不派发新工作（测试断言 `listClaimable` 为空，test:1319，且 journal 不变，test:1338）。run.failed 事件是末尾追加的新事件，不触碰已发内容。符合规则。
2. **不会。**新增条件是纯谓词；收尾写入值都是确定的：诊断码由 `CASE WHEN at<deadline` 决定（at≥deadline 时恒为 `RUN_EXECUTION_DEADLINE_EXCEEDED`，dispatch-operations.ts:492），幂等键由固定顺序数组 JSON 序列化的 SHA-256（dispatch-operations.ts:515-517）。无遮盖、无依赖后文的遮盖、无无序集合。
3. **有自动检查**：两个新场景挂在既有参数化用例上（test:1058-1059）。`deadline-code-no-records` 在旧 SQL 下必失败（旧分支都不满足→不被列出→ready 失败，逻辑推理证实，未实际运行）；`deadline-code-before-deadline` 在新旧 SQL 下都通过，它守住的是 `settleExpired` 的期限门（dispatch-operations.ts:425），不是新分支的反向用例。仓库级检查命令未核实（本次不能执行）。
4. **逐值核对：**新增使用的标识只有字符串 `'RUN_EXECUTION_DEADLINE_EXCEEDED'`。产生方：quarantine（dispatch-operations.ts:613）、settleExpiredSync（:492）、coordinator（:259）；使用方：`listReconciliationRequired`（:358）、`settleExpired` ready（:426）、展示层（thread-execution-state.ts:279、288，execution-view.ts:373）。两端一致：quarantine 可写入该码的路径正是第三分支要识别的状态；收尾后写入的 failed+该码组合，展示层已有对应处理且不会落入 `unresolved`；`sqlite-web-push-operations.ts:517` 只特判 `RUNTIME_TOOL_RESULT_UNKNOWN`，不冲突。新测试场景名仅测试内部使用。I-88 文档条目与代码一致，唯独「离线收尾命令」在仓库中无对应物（未核实）。
