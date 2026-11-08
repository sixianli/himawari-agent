# PR #282 第 2 轮复核

复核对象：`72b2f07`（对照 `7073268`，重点看 `cb389961..72b2f07` 增量）。下面先给按严重度排列的问题，再单列「侧重检查」，最后逐条回答必答问题。

---

## 问题（按严重度）

### 1. 中：本机 job host 路径新增的 `output_limit` 分支会产出「known 但不可交付」的结果，反而堵住新加的提前收尾

**文件:行**
- `apps/execution-worker/src/production-sandbox-execution-v2.ts:885-897`（本机 job host 路径新增 `boundedTermination`）
- `apps/execution-worker/src/production-sandbox-execution-v2.ts:953-960`（把 `SANDBOX_OUTPUT_LIMIT` 写成 `kind: "error"`）
- `packages/execution-contracts/src/sandbox-execution-v2.ts:302-315`（`isSandboxBoundedToolFailure` 不含 `SANDBOX_OUTPUT_LIMIT`）
- `packages/application/src/services/sandbox-execution-projection.ts:204-217`（只有 `isSandboxBoundedToolFailure` 才允许 `disclosureAllowed`）
- `apps/agent-service/src/production-sandbox-tool-result.ts:284`（`if (!projection.deliverToolResult) return undefined;`）
- `apps/agent-service/src/production-runtime-tools.ts:1836-1843`（`undefined` 被换成 `result_unknown`）
- `apps/agent-service/src/production-tool-result-recovery.ts:161-170`（`known` 只要求 `kind` 是 `result`/`error`）

**问题**
本机路径这次把 `output_limit` 也纳入了 `boundedTermination`，但 `SANDBOX_OUTPUT_LIMIT` 并不在 `isSandboxBoundedToolFailure` 里，也不在模型/界面文案里。结果是：本地路径的 output-limit 记录从「unknown」变成了「error」；

- 因为不是 bounded failure，投影不会交付工具结果（`deliverToolResult=false`），`createProductionSandboxToolResult` 返回 `undefined`，调用方把它当成 `result_unknown`；
- 但恢复入口的 `known` 只看 `kind`，会把这个 `error` 当成「有结果」，从而把这一轮列为 `resume_tool_result` 候选；
- 而新加的「不可恢复标记」要求结果不是 `result`/`error`，所以这条记录**不会**被标记，`SANDBOX_TOOL_RESULT_RECOVERY_SQL` 也不会排除它。

也就是说，原本（保持 unknown 时）新加的 `SANDBOX_UNRECOVERABLE_TERMINATION_REASONS`（含 `output_limit`）能让它几秒内收尾；现在改成 error 后反而关掉了这条路。恢复端拿到候选后再次走 `completeSandboxToolResult`，仍然拿不到可交付结果。

**证据（我读到的代码）**

```ts
// production-sandbox-execution-v2.ts:885
const boundedTermination =
  ... ? result.reason === "output_limit"
        ? "SANDBOX_OUTPUT_LIMIT"
        : result.reason === "resource_limit" ? sandboxResourceLimitReason(...) : null
    : null;
...
// :953
: boundedTermination
  ? { ...resultFields, kind: "error", output, reasonCode: boundedTermination,
      termination: { type: "failure" } }
```

```ts
// sandbox-execution-v2.ts:302
export function isSandboxBoundedToolFailure(result) {
  return isSandboxToolResultLost(result) || (result?.kind === "error" && ...
    (result.reasonCode === SANDBOX_TOOL_DEADLINE_EXCEEDED ||
     ... SANDBOX_HOST_COMPLETION_CONTRADICTED ||
     result.reasonCode === SANDBOX_CPU_TIME_LIMIT ||
     result.reasonCode === SANDBOX_MEMORY_LIMIT ||
     result.reasonCode === SANDBOX_RESOURCE_LIMIT ||
     result.reasonCode === SANDBOX_WRITE_EFFECT_UNVERIFIED))
}
```

```ts
// production-tool-result-recovery.ts:161
const known = admission.phase === "bound"
  ? admission.record.releaseReceipt &&
    admission.record.facts.resource.supervision === "released" &&
    ["result", "error"].includes(admission.record.facts.result?.kind ?? "")
```

**读代码证实的**：`SANDBOX_OUTPUT_LIMIT` 不在 bounded 列表；投影和 `createProductionSandboxToolResult` 会因此不交付；恢复端会把 error 当成 `known`。
**推测（未能跑测试验证）**：恢复端认领后会进入 `resumeToolResult`，再次拿不到 completion，导致 claim/resume 失败或反复重试；这比保持 unknown 后由标记提前结算更差。

**建议**
二选一，不要停在半改状态：
- 要么把 `SANDBOX_OUTPUT_LIMIT` 正式纳入有界失败（补 `isSandboxBoundedToolFailure`、模型文案、`SAFE_TOOL_REASON_CODES`、`execution-view` 和三语文案），并把资源上限文案逻辑覆盖它；
- 要么在本机路径不要把 `output_limit` 放进 `boundedTermination`，让它保持 unknown，交给 `SANDBOX_UNRECOVERABLE_TERMINATION_REASONS` 和标记去提前收尾。作者材料里写「要不要把 `output_limit` 列为有界失败等主人定」，但代码在本机路径已经改了它的记录方式，和这句话不一致。

---

### 2. 中低：事故行/作者说法与代码不一致：本机路径原本并不把 `output_limit` 当明确失败

**文件:行**
- `docs/incidents-and-gates.md:120`（I-83 行）
- `apps/execution-worker/src/production-sandbox-execution-v2.ts:885-897`

**问题**
I-83 行写「生产在用的 v2 执行路径只把『超时』和『输出过多』记成失败结果」。对照 diff，本机 job host 路径的 `boundedTermination` 是本 PR 新加的，`output_limit` 分支也是新加的；改动前本机路径在该位置只处理 `deadline`/`not_started`/`completion_contradicted`，`output_limit` 会落到 `SANDBOX_EXIT_UNKNOWN`。因此：
- 「两条 v2 前台路径都已把 output_limit 当失败」的说法不准确（SRT 路径原本有，本机路径原本没有）；
- 事故行「未覆盖」也没写「本机路径这次会把 output_limit 记成 error，但该原因码仍不在有界失败/界面白名单里」。

这不直接影响资源上限主线，但会让后来人误判 output-limit 的现状，也会掩盖上面第 1 条的半改状态。

**建议**
更正 I-83 行，并把本机路径对 `output_limit` 的记录变化单独列出来，或者按第 1 条改回一致行为。

---

### 3. 低：反例覆盖不足，`loss-unverified` 没有真正覆盖「可恢复的终止原因」

**文件:行**
- `test/integration/sqlite-sandbox-execution-v2.test.ts:6084-6093`（只有 `unrecoverable` 才写 `sandbox-stream-end`）
- `test/integration/sqlite-sandbox-execution-v2.test.ts:6120-6150`（unverified 只断言没有标记）

**问题**
`loss-unverified` 根本没有写 stream 结束记录，`sandboxStreamResultUnrecoverable` 返回 false 的原因是 `termination === null`，不是「终止原因可恢复」。因此：
- 如果以后有人把 `"exited"` 或 `"deadline"` 加进 `SANDBOX_UNRECOVERABLE_TERMINATION_REASONS`，或把判定改成「只要有结束记录就算不可恢复」，这条反例**抓不到**；
- 作者说的「退出还没核实 / workspaceBlocked / 没配置恢复端口」这些暂时情况，没有一个被单独写成反例；
- 也没有「file/lost 恢复成功时不得写标记」的正向用例。

**建议**
补三类反例：
1. 写入 `sandbox-stream-end`，终止原因为 `exited` 或 `deadline`，断言不写标记；
2. `workspaceBlocked=true` 时，即使终止原因为 `resource_limit`，断言不写标记；
3. `recoverMissingResult` 返回了 `result`/`error` 时，断言不写标记（证明先恢复、后标记的顺序）。

---

### 4. 低：重放/recover 路径的模型文案可能使用「当前 ceiling」而不是「命令实际生效的 ceiling」

**文件:行**
- `apps/agent-service/src/production-runtime-tools.ts:1530-1537`（重放路径把 `ceiling` 传给 `#completionOutcome`）
- `apps/agent-service/src/production-runtime-tools.ts:1426-1434`（`ceiling` 是当前配置与 capability 上限的较小值）
- `apps/agent-service/src/production-runtime-tools.ts:1486-1489`（只校验原请求 ceiling ≤ 当前 ceiling，允许当前更大）
- `apps/agent-service/src/production-sandbox-tool-result.ts:143-158`（文案用传入的 `ceiling`）

**问题**
实时路径里 `ceiling` 与请求的 `plan.resourceCeiling` 通常相同；但恢复/重放时如果配置或 capability 上限变大了，代码会拿「当前更大的 ceiling」拼出「本次允许的上限」，而这条命令实际是被 `plan.resourceCeiling` 杀掉的。违反「数值从这条命令实际生效的资源上限读」。这条是边界情况（配置变更后恢复），影响的是文案数字，不影响原因码。

**建议**
`#completionOutcome` 改为优先使用 `admission.record.plan.resourceCeiling`（`receive` 路径已经这样做了），至少不要用重放时的当前 `ceiling`。

---

### 5. 低：在 `authorizeAuthorityChange` 这个判断函数里也会写不可逆标记

**文件:行**
- `apps/agent-service/src/production-run-composition.ts:336-345`（授权判断里调用 `prepareToolResultRecovery`）
- `apps/agent-service/src/production-tool-result-recovery.ts:154-170`（该函数现在会 `commit` 标记）

**问题**
`prepareToolResultRecovery` 现在有持久化副作用。它不只被调度器当成「准备恢复」调用，也被 `authorizeAuthorityChange` 当成判断延续授权是否一致来调用。若这次判断最终因 continuationRef/authority 不匹配而返回 false，标记仍会留下，并永久影响后续 `SANDBOX_TOOL_RESULT_RECOVERY_SQL`。虽然按谓词它只在决定性证据下写，但把不可逆写操作放进授权判断里，语义上不合适，也让排查更困难。

**建议**
把「计算是否不可恢复」与「写标记」拆开：`prepareToolResultRecovery` 只返回判定结果，由调度器在确认要放弃这一轮恢复后显式写标记；`authorizeAuthorityChange` 调用的只读版本不写。

---

### 6. 低（健壮性）：判定本身没有校验 `end` / `taskProcessExited`，完全依赖前面先跑 `recoverMissingResult`

**文件:行**
- `apps/agent-service/src/production-sandbox-stream.ts:14-22`（只读 termination 并比对原因码）
- `apps/agent-service/src/production-sandbox-stream.ts:87-110`（`recover` 里还会校验 `end`、`taskProcessExited`、chunk 序列）

**问题**
`recover` 对不合法的终止记录是抛 `SANDBOX_STREAM_TERMINATION_INVALID`，不会返回 `null`；但 `sandboxStreamResultUnrecoverable` 只看 `termination.reasonCode`。生产里因为先调用 `recoverMissingResult`，非法记录会先抛错、走不到标记；但如果某个组装没有配置 `recoverMissingResult`，或以后调整了顺序，就可能仅凭一份不完整的结束记录写永久排除标记。

**建议**
在 `sandboxStreamResultUnrecoverable` 里补上与 `recover` 相同的 `end`/`taskProcessExited` 条件，或直接让判定基于「`recover` 确实返回了 null」而不是重新读 termination。

---

## 侧重检查

我按「错误路径、不可信输入、安全、资源耗尽、不可逆操作、文档与代码一致」逐项看过：

- **不可逆操作**：新标记是持久化排除记录，一旦写错就抢掉迟到恢复。已核对谓词与 `stream.recover` 共用 `SANDBOX_UNRECOVERABLE_TERMINATION_REASONS`（`production-sandbox-stream.ts:87-99`、`sandbox-execution-v2.ts:283-291`），两者一致；`workspaceBlocked`、`releaseReceipt`、`supervision === "released"` 都有检查。主要风险是上面第 1 条（`output_limit` 被写成 error 后绕过标记）和第 5 条（授权判断里写标记）。
- **错误路径**：`markUnrecoverable` 写失败会让 `prepareToolResultRecovery` 抛出，`production-run-dispatcher.ts:478-483` 会捕获并 `continue`，下一次调度重试；不会直接打挂 pump。已证实。
- **不可信输入 / 安全**：`sandboxResourceLimitMessage` 只拼接受控的数值和固定原因码，无用户文本注入；SQL 里插入的是编译期常量前缀，不是外部输入；`sandboxStreamResultUnrecoverable` 读结束记录时仍受 `readStored` 的 64 KiB 密文/49 KiB 明文上限约束。未见新的越权或注入风险。
- **资源耗尽**：没有新增无界循环；恢复链原有的 trace 上限（10000）未变；新谓词只多读一次结束记录。
- **文档一致**：I-83 行与代码有一处不一致（第 2 条）；「output_limit 等主人定」与代码中本机路径已改记录方式不一致（第 1 条）。其余改动（I-83 编号、`loss-unrecoverable`、`stream-candidate-unrecoverable`、三语文案）与代码一致。
- **模型请求开头**：见必答问题 1、2。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍只在末尾追加？

**不会改变系统提示/工具定义，也不会改动已发历史。** 依据：
- 本 PR 没有改 `packages/prompt-catalog`（我 grep 过，里面没有新增这些 `SANDBOX_*` 原因码）。
- 新增的模型可见文字只有 `production-sandbox-tool-result.ts:143-158` 的 `sandboxResourceLimitMessage`，它在 `production-runtime-tools.ts:2141-2157` 作为**工具结果**的 `modelContent` 返回；工具结果是在该次工具调用后面追加的一条消息。
- 同一工具结果会存进 `runtime-tool-result:<key>` / `runtime-tool-recovered-result:<key>`，重放读取存储值（`production-runtime-tools.ts:1446-1454`、`1898`），不是每轮重新改写历史。
- 会变的值（原因码、本次上限）只出现在这条工具结果里，不在系统提示或工具定义里。

所以：仍然只在末尾追加，每轮会变的值不在请求开头。唯一的小瑕疵是第 4 条：重放时若重算文案，数字来源可能不是原命令的 ceiling，但这不影响「开头不变」，且正常重放用的是持久化结果。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**新增的这段文字是确定性的**：`sandboxResourceLimitMessage` 只依赖 `reasonCode` 和 `ceiling`（`production-sandbox-tool-result.ts:143-158`），`limitAmount` 用 `toFixed(1)`（locale 无关），没有时间字段、没有无序集合；标记的 `operationKey` 由 `invocationId` 拼出（`sandbox-execution-v2.ts:293-294`），是确定的；SQL 里插的是固定前缀。

**需要留意的点**：文案里的 ceiling 在重放路径来自当前 `ceiling`（第 4 条）。如果配置/capability 上限在两次请求之间变化，且这次重放没有命中持久化结果、重新计算文案，数字可能与上次不同。正常路径会先写 `runtime-tool-result` 再返回，下一次读存储值，所以不会每轮变化。建议按第 4 条改用 `plan.resourceCeiling`，把这个不确定性彻底去掉。

### 3. 有没有对应自动检查？反向用例真的会失败吗？

**有，且大部分反向用例成立：**
- `loss-unrecoverable`（`sqlite-sandbox-execution-v2.test.ts:6084-6093` + `6120-6150`）：去掉 `markUnrecoverable` → 标记数 0，断言 1，会失败。
- `loss-unverified`：把判定改成恒真 → 标记数 1，断言 0，会失败。
- `stream-candidate-unrecoverable`（`:4563-4580`）：去掉 SQL 的 `NOT EXISTS` → 候选重新出现，断言 `[]`，会失败。
- `sandbox-v2-worker-lifecycle.test.ts:777-782`：去掉 worker 的 `resource_limit` 分支 → `result` 不是 `error`，会失败。
- `production-sandbox-tool-result.unit.test.ts`、`production-runtime-tools.unit.test.ts`、`execution-view.unit.test.ts`、`thread-execution-state.unit.test.ts`、`sandbox-bounded-failure.unit.test.ts` 均有新原因码/文案/白名单用例。

**缺口**（见第 3 条问题）：`loss-unverified` 没有写结束记录，因此没有真正覆盖「`exited`/`deadline` 这类可恢复终止原因不得写标记」；`workspaceBlocked` 和「恢复成功则不写标记」也没有反例。SRT 路径的 resource-limit 接线仍无测试（作者已承认）。

### 4. 每个新值在产生端和使用端是否都能接受？

**逐项核对结果：**

| 值 | 产生端 | 使用端 | 结论 |
|---|---|---|---|
| `SANDBOX_CPU_TIME_LIMIT` / `SANDBOX_MEMORY_LIMIT` / `SANDBOX_RESOURCE_LIMIT` | `sandboxResourceLimitReason`（`sandbox-execution-v2.ts:269-280`） | `SandboxOperationResult.reasonCode` 是 `machineString` 无枚举；`isSandboxBoundedToolFailure` 已加；两个 `SAFE_TOOL_REASON_CODES` 已加；`execution-view` 映射和 en/ja/zh 文案已加 | 通过 |
| `SANDBOX_UNRECOVERABLE_TERMINATION_REASONS` | `sandbox-execution-v2.ts:283-291` | `production-sandbox-stream.ts` 的 `recover` 和新判定共用 | 通过（集合与 `recover` 一致） |
| `SANDBOX_TOOL_RESULT_UNRECOVERABLE` / 标记 operationKey | `production-tool-result-recovery.ts:48-62`、`sandbox-execution-v2.ts:293-294` | SQL 用 `'sandbox-tool-result-unrecoverable:' || identity.invocationId` 匹配（`sqlite-sandbox-tool-result-recovery.ts:20-24`），SQLite 中 `||` 优先级高于 `=`；测试用 `LIKE 'sandbox-tool-result-unrecoverable:%'` 也匹配 | 通过 |
| `sandboxResultUnrecoverable` 配置项 | `production-run-composition.ts:100`、`315-320`，`service-main.ts:1957`，`production-sandbox-services.ts:2126、2623` | `createProductionToolResultRecovery.options.resultUnrecoverable` | 通过（生产组装确实接上了） |
| `sandboxFailureKeepsOutput` | `production-sandbox-tool-result.ts:128-142` | 同文件 `358-366` 的 `outputRef` 计算 | 通过（资源上限三个码已排除） |
| `sandboxResourceLimitMessage` 的 ceiling | 实时的 `plan.resourceCeiling`/`ceiling` | `#completionOutcome` 的 `modelContent` | 基本通过；重放路径有第 4 条的来源问题 |
| `SANDBOX_OUTPUT_LIMIT` | 本机路径新产生（`production-sandbox-execution-v2.ts:892-893`） | **不在** `isSandboxBoundedToolFailure`、两个 `SAFE_TOOL_REASON_CODES`、`execution-view`、i18n 中 | **不一致**，见第 1 条 |

另外确认：`packages/persistence-sqlite` 已经依赖 `@himawari-agent/execution-contracts`（`package.json`），新 import 不会破坏分层；`packages/execution-contracts/src/index.ts` 有 `export * from "./sandbox-execution-v2.ts"`，新函数/常量对外可见。

---

## 总结

- 资源上限主线的核心修复（worker 明确失败、模型文案、界面原因码、提前收尾标记、共用不可恢复终止集合、生产组装接线）**基本成立**。
- 最值得改的是第 1 条：本机路径把 `output_limit` 写成 error 但没把它变成可交付的有界失败，可能把原本能被新标记提前收尾的轮次变成「known 却恢复不了」的候选。
- 第 2 条要更正事故行/材料说法；第 3 条补齐真正的反例；第 4、5、6 条是边界和健壮性改进。
