## 一、读代码证实的发现

### 1.【中】SRT 任务环境 / 容器路径的「输出过多」仍是不可交付的 `error`，不会走新的提前收尾
- 文件:行：`apps/execution-worker/src/production-sandbox-execution-v2.ts:1841-1845`、`apps/execution-worker/src/production-sandbox-execution-v2.ts:1230-1236`
- 问题：本机 job host 路径已按第 1 条回退成「结果未知」，但 SRT 任务环境和容器路径仍把 `output_limit` 写成 `kind: "error"` + `reasonCode: "SANDBOX_OUTPUT_LIMIT"`，`effect` 仍是 `unknown`。
- 证据：
  ```ts
  1841: : outcome.reason === "output_limit"
  1842:   ? {
  1843:       result: failure("SANDBOX_OUTPUT_LIMIT"),
  1844:       effect: { kind: "unknown", reasonCode: "SANDBOX_OUTPUT_LIMIT" },
  1845:     }
  ```
  而 `SANDBOX_OUTPUT_LIMIT` 不在有界失败清单里：
  ```ts
  305: (result?.kind === "error" &&
  306:   result.termination.type === "failure" &&
  307:   (result.reasonCode === SANDBOX_TOOL_DEADLINE_EXCEEDED ||
  ...
  313:    result.reasonCode === SANDBOX_WRITE_EFFECT_UNVERIFIED))
  ```
  于是投影层不会交付它：
  ```ts
  194: const settled = conclusion !== "pending" && conclusion !== "unknown" && effectKnown;
  196: const needsReconciliation = (effect.kind === "unknown" && result !== null) || ...
  204: const boundedFailure = plan.mode === "foreground" && acceptedRelease &&
  207:   outputProtected && isSandboxBoundedToolFailure(result);
  216:   ((settled && !needsReconciliation) || boundedFailure)
  230: deliverToolResult: ((active && disclosureAllowed) || canRecoverResult) && ...
  ```
  同时恢复层因为 `kind` 是 `error` 而把它当成「已知结果」，不会写不可恢复记录：
  ```ts
  167: !["result", "error"].includes(admission.record.facts.result?.kind ?? "") &&
  ...
  172: const known = admission.phase === "bound"
  176:   ? ... && ["result", "error"].includes(admission.record.facts.result?.kind ?? "")
  ```
  所以这个「error 但交付不出去」的结果既不会被模型看到，也不会触发 `RUN_EXPIRED_RECONCILIATION_SQL` 的第一条提前结算分支（恢复 SQL 仍为真），只能等原始期限。
- 建议：二选一，不能停在中间态：
  1. 把 SRT/容器路径的 `output_limit` 也回退成「结果未知」（与本机路径一致），让不可恢复记录机制收尾；
  2. 或把 `SANDBOX_OUTPUT_LIMIT` 正式纳入有界失败，并补齐模型文案、界面原因词和三语翻译。
  另补一条端到端用例，证明该路径真的在数秒内变成 `failed`。

### 2.【低】第 4 条的 `resourceCeiling` 覆盖没有自动检查
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:2103-2106`、`apps/agent-service/src/production-sandbox-tool-result.ts:375-377`、`apps/agent-service/test/production-runtime-tools.unit.test.ts:482-499`
- 问题：新增了「失败说明优先使用 `completion.resourceCeiling`」和「资源上限失败时写入 `plan.resourceCeiling`」两处行为，但没有测试真正覆盖覆盖值。现有测试的 completion 没有 `resourceCeiling`，只测到了回退到 `ceiling`。
- 证据：
  ```ts
  2103: const resourceLimitNotice = sandboxResourceLimitMessage(
  2104:   completion.errorCode ?? "",
  2105:   completion.resourceCeiling ?? ceiling,
  2106: );
  ```
  测试里：
  ```ts
  482: const completion = {
  483:   outcome: "failed" as const,
  484:   outputRef: null,
  485:   errorCode,
  486:   externalActionId: null,
  487: };
  ...
  491: const ceiling = { ...f.options.ceiling, maxCpuTimeMs: 12_500, maxMemoryBytes: 268_435_456 };
  498: expect(result.modelContent).toContain("CPU 时间 12.5 秒");
  ```
  这里 `completion.resourceCeiling` 根本不存在，所以把 `completion.resourceCeiling ?? ceiling` 改回 `ceiling`，测试仍然会通过。
- 建议：增加一条 completion 的 `resourceCeiling` 与工具当前 `ceiling` 不同的用例，断言模型文案使用前者；再加一条 `production-sandbox-tool-result` 的单测，断言资源上限失败时 receipt 带 `resourceCeiling`，其它失败不带。

### 3.【低】第 5 条（授权判断不写记录）没有测试
- 文件:行：`apps/agent-service/src/production-run-composition.ts:338`、`apps/agent-service/src/production-tool-result-recovery.ts:159`
- 问题：`authorizeAuthorityChange` 改成传 `{ recordUnrecoverable: false }`，但没有用例验证「授权路径不写记录、调度器路径仍写记录」。
- 证据：
  ```ts
  338: const prepared = await prepareToolResultRecovery(request, { recordUnrecoverable: false });
  ```
  ```ts
  159: purpose?.recordUnrecoverable !== false &&
  ```
- 建议：补一条恢复授权用例，构造一个带不可恢复终止原因的 admission，走 `authorizeAuthorityChange` 后断言 `run_payload_artifacts` 里没有 `sandbox-tool-result-unrecoverable:*`；同场景走调度器 `prepareToolResultRecovery` 再断言有一条。

### 4.【低】I-83 文档会让人以为 `output_limit` 只有本机路径有问题
- 文件:行：`docs/incidents-and-gates.md:117`
- 问题：文档写了「SRT 任务环境路径只把『超时』和『输出过多』记成失败结果」，未覆盖又只补了「所以**本机路径**的『输出过多』照旧记成『结果未知』」。结合上面的代码，SRT/容器路径的 `output_limit` 其实是「记成 error 但交付不出去」，同样会等原始期限。
- 证据（文档原句）：
  > 「SRT 任务环境路径只把「超时」和「输出过多」记成失败结果，本机 job host 路径连「输出过多」也落进「结果未知」」
  >
  > 「`SANDBOX_OUTPUT_LIMIT` 仍不在有界失败和界面白名单里，所以本机路径的「输出过多」照旧记成「结果未知」」
- 建议：在「未覆盖」里明确写出 SRT/容器路径的 `output_limit` 当前是 `error` 且不可交付、仍等原始期限；或者按第 1 条建议先修掉它。

---

## 二、推测与未核实

- 【推测】`markUnrecoverable` 是不可撤销的：如果 `recoverMissingResult` 未配置，或文件恢复因瞬时原因失败，而流终止原因恰好在不可恢复集合里，会提前写死「无法找回」，后续文件恢复成功也无法再走恢复候选。生产配置了 `recoverMissingResult`，且它在写记录前执行，所以正常路径风险低；这条没有测试覆盖。
- 【推测】不可恢复记录的并发写入冲突最终会收敛，因为 `quarantine` 在 `RUNTIME_TOOL_RESULT_UNKNOWN` 下会保留该诊断码（`sqlite-run-dispatch-operations.ts:602-606`），下一轮可以重试；这是读代码推断，未跑并发测试。
- 【未核实】未运行 `npm run check`、`npm run build`、`npm run check:prompt-prefix`，也未在真实沙箱里验证 `output_limit` 的 `taskProcessExited` 一定为真。

---

## 三、侧重检查

- **错误路径**：检查了「结果未知 → 恢复候选 → 不可恢复记录 → 提前结算」全链路。正常路径成立；SRT/容器 `output_limit` 的 error 分支是残留半成品（见发现 1）。
- **不可信输入 / 安全**：`sandboxResourceLimitMessage` 只使用计划里的上限和固定原因码，观测值只用于选常量原因码，不拼进可变文本；SQL 里拼接的是编译期常量前缀，没有外部输入，未见注入风险。
- **不可撤销操作**：`sandbox-tool-result-unrecoverable:*` 是永久排除记录，写入前有 `lookup` 幂等保护和恢复尝试；主要风险是上述「恢复暂时失败但被永久判死」，属于低概率推测。
- **资源耗尽**：新增的循环是逐 admission 检查，单次读取受 64KB 限制；未见新的无界循环或大对象复制。
- **规则/文档一致**：`prompt-prefix` 规则、I-83 文档与代码大体一致；文档对 `output_limit` 的覆盖范围不准确（见发现 4）。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。**
- 本 diff 没有改系统提示、工具定义或 `packages/prompt-catalog`。
- 新增的资源上限说明只作为失败工具调用的 `modelContent` 返回（`apps/agent-service/src/production-runtime-tools.ts:2103-2154`），是追加在末尾的工具结果消息。
- 重放时先读已存的 `runtime-tool-result` / `runtime-tool-recovered-result`（`production-runtime-tools.ts:1440-1454`、`1513`），不会改写已经发过的历史。
- 新原因码进入的是 UI/线程展示集合（`thread-execution-projection.ts`、`thread-execution-state.ts`、`execution-view.ts`），没有进入 prompt 组装；我查到的 `ThreadExecutionProjection` 使用点是 `production-http-composition.ts:879`（HTTP/UI）。
- 每轮会变的值没有进入系统提示或工具定义；`resourceCeiling` 是每条命令的固定值。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
**按代码检查，没有发现新的不确定性。**
- 模型看到的文本由固定原因码和 `plan.resourceCeiling` 生成（`production-sandbox-tool-result.ts:145-160`），不含时间、随机数或无序集合。
- 观测到的 CPU/内存只用于选择常量原因码（`packages/execution-contracts/src/sandbox-execution-v2.ts:271-280`），不拼进文本。
- 计划里的 CPU/内存上限不会因期限被缩小；`sandbox-execution-plan.ts:129-132` 只缩小 `maxWallTimeMs`，所以回退用当前 `ceiling` 时 CPU/内存也与计划一致。
- 边界情况：极旧的 receipt 没有 `resourceCeiling` 时会回退到当前 `ceiling`；如果 `maximumResourceCeiling` 在重放前变小，文本理论上可能不同。但新写出的资源上限失败 receipt 一定带 `resourceCeiling`，正常路径不受影响。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？
大部分有，且我按代码核对后认为反向用例是有效的：
- 本机 `output-limit`：`[I-83] output-limit` 断言 `kind: "unknown"`、`SANDBOX_EXIT_UNKNOWN`、非有界失败；若把本机路径改回 `SANDBOX_OUTPUT_LIMIT` 会失败（`test/integration/sandbox-v2-worker-lifecycle.test.ts:776-781`）。
- 终止原因判定：参数化用例覆盖 `resource_limit/exited`、`taskProcessExited`、前台/后台、`workspaceBlocked`、有无结束记录；去掉 `taskProcessExited` 守卫第 3 行会失败（`test/integration/sqlite-sandbox-execution-v2.test.ts:4490-4547`）。
- 不可恢复记录与 SQL 排除：`loss-unrecoverable`、`stream-candidate-unrecoverable`；删掉记录或 SQL 的 `NOT EXISTS` 会失败。
- 资源上限原因码：契约层、runtime-tools 文案、control-center 原因词都有用例。
- **缺口**：第 4 条的 `completion.resourceCeiling` 覆盖没有用例；第 5 条的授权路径不写记录没有用例；没有一条端到端用例证明「本机 output_limit 在数秒内变成 failed」，现有 `loss-unrecoverable` 用的是 `resource_limit`。
- `loss-stream-exited` 我读到它把 `verifyExited` 设为 false，所以它验证的是「`exited` 不在不可恢复集合、不写记录」，不是「真正可恢复的 exited 结果最终被恢复」；后者是否由 `late` 变体覆盖，未核实。

### 4. 每个新值、每个使用点都能接受吗？
逐个核对如下：
- **`SANDBOX_CPU_TIME_LIMIT` / `SANDBOX_MEMORY_LIMIT` / `SANDBOX_RESOURCE_LIMIT`**：产生于 `sandboxResourceLimitReason` 和 SRT/本机执行路径；使用点包括 `isSandboxBoundedToolFailure`（已加）、两处 `SAFE_TOOL_REASON_CODES`（已加）、`execution-view.ts` 原因词（已加）、三语 `MESSAGES_IDS`（已加）、`sandboxResourceLimitMessage`（已处理）。我以同类码 `SANDBOX_TOOL_DEADLINE_EXCEEDED` 全仓搜索过，没有遗漏的白名单；唯一枚举 deadline 码的 persistence 逻辑只用于期限恢复，不适用于这些新码。
- **`SandboxToolCompletion.resourceCeiling`**：产生于 `production-sandbox-tool-result.ts:375-377`，消费于 `production-runtime-tools.ts:2103-2106`；receipt 是自由 JSON，读取端按 `Partial` 处理，没有严格 schema 会拒绝。两端类型一致，可用。
- **`sandbox-tool-result-unrecoverable:<invocationId>`**：产生于 `production-tool-result-recovery.ts:53-66`，SQL 端用常量前缀 + `json_extract(...invocationId)` 拼接（`sqlite-sandbox-tool-result-recovery.ts:20-24`），值一致；`operation_key` 只要求非空文本，没有长度上限，测试里也用同一 helper 验证过。
- **`taskProcessExited`**：流终止 schema 里已有该字段（`packages/execution-contracts/src/sandbox-execution-v2.ts:650-654`），真实 stream 的 `termination()` 返回完整终止对象，`recover` 与新的不可恢复判定条件一致。
- **`SANDBOX_TOOL_RESULT_UNRECOVERABLE`**：只作为标记 payload 内容存在，SQL 只看 artifact 是否存在，没有其它消费端。
- **文档**：I-83 行已更新，但 `output_limit` 的覆盖范围描述仍不完整（发现 4）。

---

## 五、对作者六条修改的核对

1. **第 1 条回退**：成立。本机 `output_limit` 已回到 `kind: "unknown"`、`SANDBOX_EXIT_UNKNOWN`；本机路径的流结束记录会带 `reasonCode: "output_limit"` 和 `taskProcessExited`（`production-sandbox-execution-v2.ts:756-761`），因此按代码推演能写下不可恢复记录，下一轮由 `RUN_EXPIRED` 提前结算。**但 SRT/容器路径仍是半成品**（发现 1）。
2. **第 2 条文档**：I-83 行确实分开写了两条路径，并写了 `SANDBOX_OUTPUT_LIMIT` 不在有界失败和界面白名单；但未说明 SRT/容器路径同样会卡到原始期限（发现 4）。
3. **第 3 条反向用例**：补充的 `loss-stream-exited` 和参数化用例确实能抓住「把 `exited` 加进不可恢复集合」这个回归；但 `loss-stream-exited` 同时把 `verifyExited` 设为 false，所以它证明的是「不写记录」，不是「以后还能恢复」。
4. **第 4 条 `resourceCeiling`**：代码实现正确，只在资源上限失败时填，消费者也只有资源上限文案会读它；没有发现别的路径因此回落到错误上限。**但没有自动检查**（发现 2）。
5. **第 5 条授权路径**：调度器仍以默认 `recordUnrecoverable` 调用；授权路径只用于已知结果或排队批次，而已知结果本来就不满足写记录条件，所以没有丢失覆盖。**但没有测试**（发现 3）。
6. **第 6 条 `taskProcessExited`**：实现与 `recover` 的合法性条件一致，参数化用例覆盖了该守卫。
