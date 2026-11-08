I'll start by examining the diff and the referenced files.
# PR #282 复核结论

我已按 `f0478c4..cb38996` 读完改动及相关生产/消费两端代码，未运行测试或构建。下面每条都标注了“读代码证实”或“推测”。

## 高

### 1. 提前结算只覆盖 `RUNTIME_TOOL_RESULT_UNKNOWN`，另外三种被同一恢复入口接受的诊断码仍会挂到原始期限
- 文件：`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:53`、`apps/agent-service/src/production-run-expiry.ts:71-73`、`apps/agent-service/src/production-tool-result-recovery.ts:83-90`
- 问题（读代码证实）：恢复入口接受四种诊断码，标记也针对这四种码写；但标记把轮次从“可恢复”里摘掉后，能提前结算的只有 `RUNTIME_TOOL_RESULT_UNKNOWN`。其余三种既不再被 `resume_tool_result` 认领，也不满足提前结算条件，只能等 `originalDeadlineAt`，也就是同一个 31 分钟问题。
- 证据：
  - `production-tool-result-recovery.ts:83-90` 接受：
    ```ts
    "RUNTIME_TOOL_RESULT_UNKNOWN",
    "RUNTIME_ATTEMPT_INTERRUPTED",
    "PERSISTED_EXECUTION_RECONCILIATION_REQUIRED",
    "SERVICE_STOPPING",
    ```
  - `sqlite-sandbox-tool-result-recovery.ts:53` 的提前结算分支限定：
    ```sql
    (c.diagnostic_code='RUNTIME_TOOL_RESULT_UNKNOWN' AND NOT (${SANDBOX_TOOL_RESULT_RECOVERY_SQL})
    ```
    另一条分支只在 `originalDeadlineAt<=@resourceNow` 时成立（同文件 `58-60`）。
  - `production-run-expiry.ts:72`：
    ```ts
    if (at < frozen.deadlineAt && saved.checkpoint.diagnosticCode !== "RUNTIME_TOOL_RESULT_UNKNOWN")
      return false;
    ```
- 建议：让“写不可恢复标记”的范围与“可提前结算”的范围一致：要么只在 `RUNTIME_TOOL_RESULT_UNKNOWN` 时写标记，要么把 `production-run-expiry.ts:72` 和 `RUN_EXPIRED_RECONCILIATION_SQL` 的第一条分支扩展到标记覆盖的全部诊断码；并为每种诊断码补一个“标记后几秒内 `failed`”的集成用例。

### 2. “不可恢复”标记是永久且不可撤销的一次性判断，可能挡掉稍后仍能恢复的轮次
- 文件：`apps/agent-service/src/production-tool-result-recovery.ts:156-163`、`apps/agent-service/src/production-sandbox-stream-result-recovery.ts:54-55`、`apps/agent-service/src/production-sandbox-lost-result-recovery.ts:41-44`、`apps/agent-service/src/production-sandbox-file-recovery.ts:36-41`
- 问题（读代码证实）：只要“这一次恢复尝试返回的记录仍不是 result/error”，就写永久排除标记；但恢复函数在多种“暂时不能恢复”的情况下也会原样返回，而不是明确证明永远找不回。作者自己的疑虑成立。
- 证据：
  - `production-tool-result-recovery.ts:156-163` 只看终态：
    ```ts
    if (
      admission.phase === "bound" &&
      admission.record.plan.mode === "foreground" &&
      admission.record.releaseReceipt &&
      admission.record.facts.resource.supervision === "released" &&
      !["result", "error"].includes(admission.record.facts.result?.kind ?? "")
    )
      await markUnrecoverable(candidate.runId, admission.record);
    ```
  - 流恢复在“还没到有效期限 / 退出尚未核实”时原样返回：
    ```ts
    if (deadline && options.now() < plan.effectiveDeadlineAt) return record;
    if (deadline && !(await options.verifyExited(record))) return record;
    ```
  - 丢失结果恢复在 fence 未超越、未退出、超出期限时原样返回（`lost-result-recovery.ts:41-44`）；文件恢复在 `workspaceBlocked` 时原样返回（`file-recovery.ts:36-41`）。
  - 一旦写入，SQL 的 `NOT EXISTS`（`sqlite-sandbox-tool-result-recovery.ts:19-23`）永久排除该执行。
- 补充（读代码证实）：即使调用方没有提供 `recoverMissingResult`（`production-tool-result-recovery.ts:149-155` 才尝试恢复），`156-163` 仍会无条件写标记。只要某个组合没接恢复端口，就会把本来可恢复的轮次直接判死。
- 建议：只在拿到“决定性事实”后写标记，例如输出结束记录的终止原因是 `cancelled/output_limit/resource_limit/host_failure` 且退出已核实，或原始期限已到；否则允许重试。至少不要在一侧仍报“未核实退出”、`workspaceBlocked`、或根本没尝试恢复时写永久标记。补一个反向用例：第一次 pump 恢复返回原记录、第二次 pump 可恢复，标记不得阻止第二次恢复。

## 中

### 3. 新原因码到不了界面，新增三语文案实际不可达
- 文件：`packages/application/src/services/thread-execution-state.ts:28-47`、`packages/application/src/services/thread-execution-projection.ts:32-51,442`、`apps/control-center/src/execution-view.ts:190,375-377`
- 问题（读代码证实）：控制中心显示原因词的前提是 trace 里存在 `runtime.tool_reason.<code>`；该记录只在 `SAFE_TOOL_REASON_CODES.has(code)` 时生成，而两个 SAFE 集合都没有加入新码。因此 `SANDBOX_CPU_TIME_LIMIT` 等只会显示成 `TOOL_FAILED`，新增的中/日/英文案永远不会被用到。作者“界面按新原因码加了三语文案”的说法只完成了映射和文案，没有打通入口。
- 证据：
  - `thread-execution-projection.ts:442`：
    ```ts
    if (ended && productOutcome === "failed" && SAFE_TOOL_REASON_CODES.has(productError))
      records.push({ ... name: `runtime.tool_reason.${productError}` });
    ```
  - `thread-execution-state.ts:28-47` 和 `thread-execution-projection.ts:32-51` 的集合里只有 `SANDBOX_TOOL_DEADLINE_EXCEEDED` 等，没有 CPU/MEMORY/RESOURCE。
  - `execution-view.ts:190` 从 `runtime.tool_reason.` 记录取原因，`375-377` 才有新映射。
- 建议：把三个新原因码（以及如果确实要展示的 `SANDBOX_OUTPUT_LIMIT`）加入两个 SAFE 集合；加一个端到端用例：资源上限失败产生 `runtime.tool_reason.SANDBOX_CPU_TIME_LIMIT`，再断言 `executionStateLabel` 返回新文案。两份 SAFE 列表目前完全重复，建议抽成一处。

### 4. 核心改动（两条执行路径把 resource_limit 记为 error）没有自动测试
- 文件：`apps/execution-worker/src/production-sandbox-execution-v2.ts:885-897,1848-1858`；测试侧 `test/integration/sandbox-execution-v2.test.ts:930-935`、`test/integration/sqlite-sandbox-execution-v2.test.ts:535`
- 问题（读代码证实）：新增测试只覆盖了 `sandboxResourceLimitReason`、`isSandboxBoundedToolFailure` 和 agent-service 的文案，没有测试 `ProductionSandboxExecutionV2` 的两条路径真的把 `resource_limit` 从 `unknown` 改成 `error`，也没有测试 `resources` 能选出 CPU/内存码。
- 证据：
  - `sandbox-execution-v2.test.ts:930-935` 的 bounded disclosure 参数化列表仍只有四个旧原因码，没有新码。
  - `sqlite-sandbox-execution-v2.test.ts:535` 只测试流恢复对 `resource_limit` 终止原因的处理，不经过执行 worker。
- 建议：分别为本机 job host 路径和 SRT 路径构造 `reason:"resource_limit"` + `resources` 越界样本，断言写入记录的 `result.kind==="error"`、`reasonCode` 为 CPU/内存/兜底码、`effect.kind==="unknown"`；再补一个“缺少 resources 时落到 `SANDBOX_RESOURCE_LIMIT`”的反向用例。没有这些用例，删掉改动测试仍会全绿。

### 5. `fixed_read` 的资源上限失败会绕过新文案，模型拿不到“超了哪一项、上限多少”
- 文件：`apps/agent-service/src/production-sandbox-tool-result.ts:342-352`、`apps/agent-service/src/production-runtime-tools.ts:2123-2133,2145`
- 问题（读代码证实）：资源上限错误对 `fixed_read` 会保留 `outputRef`，随后 `#completionOutcome` 走 `if (completion.outputRef && !commandEffectUnverified)` 直接返回 `output.text`，根本不会调用 `sandboxResourceLimitMessage`。
- 证据：
  - `production-sandbox-tool-result.ts:342-352`：
    ```ts
    outputRef:
      processExitCode !== undefined ||
      (result.kind === "error" &&
        !hostResultRejected &&
        result.reasonCode !== SANDBOX_TOOL_DEADLINE_EXCEEDED &&
        result.reasonCode !== SANDBOX_TOOL_NOT_STARTED &&
        (result.reasonCode === "FILE_VERSION_CONFLICT" ||
          result.reasonCode === FILE_WRITE_NOT_STARTED ||
          plan.operationContract.kind === "fixed_read"))
        ? result.output.ref
        : null,
    ```
  - `production-runtime-tools.ts:2123-2133` 先返回原始输出，`2145` 的新文案只在没有 `outputRef` 时生效。
- 影响说明（推测）：`fixed_read` 也会经过同一 job host 资源监视器，因此真的可能被 CPU/内存上限杀掉；此时模型看到的是空/截断输出，而不是明确失败原因。
- 建议：在 `production-sandbox-tool-result.ts` 的 `outputRef` 条件里排除三个资源上限原因码，或在 `#completionOutcome` 里优先判断资源上限原因码再读取输出；补一个 `fixed_read` + CPU 上限用例。

### 6. 上限文案测试的取值都是 1，抓不到“写死数值”；文档还声称会告诉模型“实际用了多少”
- 文件：`apps/agent-service/test/production-runtime-tools.unit.test.ts:497-498`、`apps/agent-service/test/runtime-tools.fixture.ts:309-311`、`apps/agent-service/src/production-sandbox-tool-result.ts:131`、`docs/incidents-and-gates.md:119`
- 问题（读代码证实）：测试夹具 `maxCpuTimeMs: 1000`、`maxMemoryBytes: 1000000`，断言分别是 `"1 秒"`、`"1 MB"`；如果有人把文案写死成 `1 秒、1 MB`，测试照样通过。另外 I-81 文档说“把……实际用了多少告诉模型”，代码只输出上限，没有观察值。
- 证据：
  - `runtime-tools.fixture.ts:309-311`：`maxCpuTimeMs: 1000, maxMemoryBytes: 1000000`。
  - `production-runtime-tools.unit.test.ts:497-498` 用 `f.options.ceiling...` 计算，结果都是 `1`。
  - `production-sandbox-tool-result.ts:131` 只有 `limits = "本次允许的上限是 …"`，没有 observed 用量。
  - `docs/incidents-and-gates.md:119` 写的是“超了哪一项、上限是多少、实际用了多少”。
- 建议：把夹具改成非整数值（例如 `12_000ms`、`1_073_741_824`），断言精确格式化结果；若确实要告诉模型实际用量，需要把 `observed` 传进文案（注意不要把不可信字段直接拼进提示词）；否则修正文档措辞。

### 7. `SANDBOX_OUTPUT_LIMIT` 不在 bounded 列表，`output_limit` 并不“像 deadline 一样”交付明确失败
- 文件：`packages/execution-contracts/src/sandbox-execution-v2.ts:286-299`、`apps/execution-worker/src/production-sandbox-execution-v2.ts:892-893,1843-1847`
- 问题（读代码证实）：作者称 `resource_limit 和 output_limit、deadline 一样记成明确失败`。记录层确实都是 `error`，但 `isSandboxBoundedToolFailure` 不包含 `SANDBOX_OUTPUT_LIMIT`，投影里 `boundedFailure` 为假，`deliverToolResult` 不能在 live run 中立即交付。resource_limit 能被交付，output_limit 仍要绕一圈恢复或被当成通用失败。
- 证据：
  - `sandbox-execution-v2.ts:291-297` 的列表包含 deadline/not_started/contradicted/CPU/MEMORY/RESOURCE/WRITE_EFFECT，没有 `SANDBOX_OUTPUT_LIMIT`。
  - `production-sandbox-execution-v2.ts:892-893` 把 `output_limit` 映射成 `SANDBOX_OUTPUT_LIMIT`，但该码不触发 bounded。
- 建议：如果 output_limit 也应当“明确、立即失败”，把它加入 `isSandboxBoundedToolFailure` 并在投影层补用例；否则修正作者说明和文档，避免宣称它和 deadline 等价。

## 低

### 8. 文档引用了一个不存在的测试
- 文件：`docs/incidents-and-gates.md:119`
- 问题（读代码证实）：I-81 引用了 `test/integration/sqlite-sandbox-execution-v2.test.ts` 的 `stream-candidate-unrecoverable`，全仓库搜索只有文档本身出现这个名字；“四条都先在当前 main 上跑红”也无从核实。
- 建议：删掉不存在的用例名，或补上同名用例；把“跑红”换成实际命令与结果记录。

### 9. 作者说“为这次执行写一条”，代码实际给该 Run 内每个符合条件的执行都写
- 文件：`apps/agent-service/src/production-tool-result-recovery.ts:142-163`
- 问题（读代码证实）：标记在遍历 `inventory.admissions` 的循环里，没有按当前 candidate 的 invocationId、也没有按 `runtime-tool:` 前缀过滤；只要同一 Run 里还有别的 bound+released+未知结果执行，也会被永久标记。
- 建议：把标记限制在与当前恢复的 `waiting` 工具/候选对应的执行，或明确论证“同 Run 内所有未知执行都该一起判死”。

### 10. 标记写入失败会把轮次重新拖回原始期限
- 文件：`apps/agent-service/src/production-tool-result-recovery.ts:52-65`、`apps/agent-service/src/production-run-dispatcher.ts:334-344`、`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:53`
- 问题（读代码证实）：标记写入在恢复路径上同步执行；若 `protector.protect`/`artifacts.commit` 抛错（如磁盘满、权限），`prepareRecovery` 会记录失败后重新抛出，标记不存在，`SANDBOX_TOOL_RESULT_RECOVERY_SQL` 仍为真，提前结算的第一条分支继续被 `NOT (...)` 挡住，只能等原始期限。
- 建议：标记写失败时不要阻断结算判断，或把“已尝试恢复”的状态放到更可靠、更轻量的位置；补一个标记写失败的测试。

### 11. 作者事实 #3（旧路径“一直把 output_limit/resource_limit 当失败”）在持久层不成立
- 文件：`apps/execution-worker/src/product-job-host.ts:75-89`、`packages/application/src/services/sandbox-job-lifecycle-service.ts:155-169`、`apps/execution-worker/src/production-sandbox-execution.ts:79-87`
- 问题（读代码证实）：旧路径确实把观察结果标成 `outcome:"failed"`，但同时 `cleanup:"unknown"`、`effect:"unknown"`；`SandboxJobLifecycleService.settle` 因此把 job 状态判成 `quarantined`，worker 的 `result()` 只把 `completed/failed` 映射成对应结果，`quarantined` 落成 `result_unknown`。所以“当失败”只到观察层，没有到 worker 结果层。
- 建议：如果这只是措辞不严，修正作者说明；如果旧路径仍在生产使用，需要单独确认 `quarantined` 是否符合预期。

## 侧重检查

- **不可撤销操作**：重点查了 `sandbox-tool-result-unrecoverable` 标记。它是永久排除，且依据是“本次恢复没有立刻成功”，不是“已证明永远无法恢复”，风险见第 2 条。这是本次改动里唯一一个写下去就很难撤回的状态。
- **错误路径**：查了 `verifyExited=false`、`workspaceBlocked`、未到 `effectiveDeadlineAt`、控制证据缺失、标记写入失败、`recoverMissingResult` 未配置等分支。最重的两个问题是标记过早永久化，以及标记写失败重新挂到期限。
- **不合规范/不可信输入**：新文案只在 `reasonCode` 等于三个常量之一时才拼接，非资源错误码返回 `null`，不会把 worker 返回的任意字符串直接塞进模型提示；`invocationId` 受 `machineString` 约束（`^[A-Za-z0-9][A-Za-z0-9._:-]*$`），SQL 里是参数化后的 JSON 值参与字符串拼接，不构成 SQL 注入。未发现新增的外部输入面。
- **资源耗尽**：标记会为每个被判死的执行多写一条很小的 trace payload，量级可以接受；SQL 的 `NOT EXISTS` 走 `run_payload_artifacts` 主键 `(owner_id, agent_id, run_id, purpose, operation_key)`，不会全表扫描（读 `0019_run_payload_artifacts.sql` 证实）。
- **规则/文档一致性**：`docs/incidents-and-gates.md` 的 I-81 至少有三处与代码不一致：不存在的 `stream-candidate-unrecoverable`、“实际用了多少”、以及“四条先跑红”不可核实（见第 6、8 条）。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会（读代码证实）。** 本改动影响的是 `RuntimeToolExecutionResult.modelContent`（`production-runtime-tools.ts:2140-2155`），它是新一次工具结果，随工具调用追加在历史末尾，不改系统提示、工具定义或已存历史；资源上限数值只出现在这条新的工具结果里。UI 文案、原因码和 trace 标记都不进入模型请求。因此仍满足“只在末尾追加，每轮会变的值在最后一条消息/最后的工具结果里”。注意第 5 条：`fixed_read` 场景下这条新工具结果会被原始输出替代，但仍是追加，不影响开头字节。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
**不会（读代码证实）。** 资源上限文案由 `reasonCode` 和该次执行冻结的 `ceiling` 决定（`production-sandbox-tool-result.ts:127-142`），没有时间、前后文遮盖或无序集合；`limitAmount` 对同一数字输出确定。标记内容 `SANDBOX_TOOL_RESULT_UNRECOVERABLE` 是常量，且不进模型请求。唯一需要留意的是第 5 条的分支差异：同一执行若第一次走了原始输出、后来恢复走文案，会得到不同工具结果，但这是“不同交付路径”，不是同一段文字被上下文改字节。

### 3. 有没有自动检查，反向用例真的会失败？
**部分有，部分没有。**
- 有且有效：`sandbox-bounded-failure.unit.test.ts` 的 `[I-81]` 用例能抓住 `sandboxResourceLimitReason` 边界错误和 `isSandboxBoundedToolFailure` 漏码；`sqlite-sandbox-execution-v2.test.ts` 的 `loss-unverified` 在没有 `markUnrecoverable` 时会因 trace 记录数 0、第二次 pump 不 `reconciled` 而失败，是真正的反向用例。
- 缺：两条执行路径（本机 job host / SRT）把 `resource_limit` 变成 `error` 的接线没有任何测试，删掉改动仍全绿（第 4 条）。
- 缺：新原因码到 UI 的路径没有测试；`execution-view.unit.test.ts:522` 的参数化仍只覆盖 deadline 两个码，SAFE 集合漏码不会被发现（第 3 条）。
- 弱：上限文案测试的夹具值都是 1，写死 `1 秒/1 MB` 也能过；也没有“实际用量”断言（第 6 条）。
- 不实：文档声称的 `stream-candidate-unrecoverable` 不存在（第 8 条）。

### 4. 每个新值（原因码、标记、SQL 键、序列化格式）两端都能接受吗？
逐个核对结果：
- `SANDBOX_CPU_TIME_LIMIT` / `SANDBOX_MEMORY_LIMIT` / `SANDBOX_RESOURCE_LIMIT`
  - 产生：`production-sandbox-execution-v2.ts:885-897,1848-1858`。
  - 校验：`SandboxOperationResult.reasonCode` 是 `machineString`，接受；`SandboxJobReceipt.reasonCode` 也是 `machineString`，接受。
  - 消费：`isSandboxBoundedToolFailure` 已加入（`sandbox-execution-v2.ts:294-296`），投影/资源列表可接受；`production-runtime-tools.ts:2145` 文案可接受。
  - **不接受的一端**：两个 `SAFE_TOOL_REASON_CODES` 集合未加入，界面拿不到（第 3 条）；`fixed_read` 的 `outputRef` 分支会盖掉文案（第 5 条）。
- `SANDBOX_TOOL_RESULT_UNRECOVERABLE` + `sandboxUnrecoverableResultOperationKey`
  - 产生：`production-tool-result-recovery.ts:52-65`。
  - 消费：SQL 字面量 `'sandbox-tool-result-unrecoverable:'||json_extract(...)`（`sqlite-sandbox-tool-result-recovery.ts:19-23`）。
  - 两端字符串一致；`loss-unverified` 集成用例会同时验证“写入了哪个前缀”和“下一次不再被列为可恢复”，能抓住两边漂移。
  - 可靠性：`json_extract` 为 `NULL` 时 `||` 结果为 `NULL`，`NOT EXISTS` 不排除任何行，不会误排除；主键索引可覆盖该查询。**一致、可接受。**
- 新 i18n 键 `chat.reason.toolCpuTimeLimit` / `toolMemoryLimit` / `toolResourceLimit`
  - `MESSAGE_IDS` 与中/日/英资源文件一致，`i18n-runtime.unit.test.ts` 会检查键集合；这一端可接受，但整条展示链因 SAFE 集合断裂不可达。
- `SANDBOX_OUTPUT_LIMIT`
  - 生产：`execution-v2.ts`；消费：`isSandboxBoundedToolFailure` **不接受**，与作者“和 deadline 一样”的说明不一致（第 7 条）。

## 未核实
- 未运行 `npm run check` / `npm run build` / 任何测试，因此“四条先红后绿”无法验证。
- 生产里 `verifyExited`（`control.hasExitedTask`）在控制证据缺失或非 local 环境时会不会瞬时返回 false，属于推测；但代码确实把“瞬时 false”当成可写永久标记的时机。
- `fixed_read` 是否真的会被资源上限杀掉属于推测（依据是资源监视器不区分 operation contract）；但一旦发生，代码路径会绕过新文案是确定的。
