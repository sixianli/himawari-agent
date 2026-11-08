# 复核结论（PR 282 第 4 轮）

## 问题列表（按严重度）

### 1.【中】缺少「输出过多最终真的交付出去了」的投影门槛
- 文件：`test/integration/sandbox-execution-v2.test.ts:930-938`
- 问题：这是唯一直接驱动 `projectSandboxExecution(...).deliverToolResult` 的用例。它列出了资源上限，却没有列出本轮新增的 `SANDBOX_OUTPUT_LIMIT`。本轮改动的核心主张是「容器/SRT 的 `output_limit` 由悬挂改为可交付」，但目前只在 `isSandboxBoundedToolFailure` 这一层被单测覆盖，没有用例证明带 `output_limit` 的事实能通过 `outputProtected` 和 `boundedFailure`。
- 证据（我读到的该文件内容）：
  ```ts
  describe.each([
    "SANDBOX_TOOL_RESULT_LOST",
    "SANDBOX_TOOL_DEADLINE_EXCEEDED",
    "SANDBOX_TOOL_NOT_STARTED",
    "SANDBOX_HOST_COMPLETION_CONTRADICTED",
    "SANDBOX_CPU_TIME_LIMIT",
    "SANDBOX_MEMORY_LIMIT",
    "SANDBOX_RESOURCE_LIMIT",
  ])("bounded failure disclosure %s", (reasonCode) => {
  ```
  该文件第 25 行的 fixture 是 `const output = { ref: "payload", digest: hash, byteLength: 0 };`，所以把 `SANDBOX_OUTPUT_LIMIT` 加进去即可直接验证 `deliverToolResult: true`，不需要改夹具。
- 建议：在该列表加入 `"SANDBOX_OUTPUT_LIMIT"`；再补一条来自容器/SRT 的事实（`kind:"error"`、`reasonCode:"SANDBOX_OUTPUT_LIMIT"`、`effect.kind:"unknown"`、`result.output.byteLength <= plan.resourceCeiling.maxOutputBytes`）驱动投影，确保「不再挂到原始期限」有端到端门槛。

### 2.【低】事故表引用的门槛测试已搬走，文档与代码不一致
- 文件：`docs/incidents-and-gates.md:121`
- 问题：I-84 行仍写「`packages/application/test/thread-execution-state.unit.test.ts` 的 `[I-84] keeps the two copies of the allowlisted tool failure reasons identical`」。但 `4b4347aa` 已把这条测试从该文件删除，移到 `test/tooling/safe-tool-reason-codes.test.mjs`。
- 证据：
  - `4b4347aa` 的 diff 从 `packages/application/test/thread-execution-state.unit.test.ts` 删除该用例；
  - 新文件 `test/tooling/safe-tool-reason-codes.test.mjs:19` 写着 `it("[I-84] keeps the two copies of the allowlisted tool failure reasons identical", ...)`；
  - `scripts/check-incident-gates.mjs:65-70` 只检查反引号里的路径是否存在，不检查测试名是否还在那个文件里，因此这道门槛发现不了这处不一致。
- 建议：把事故表里的路径改成 `test/tooling/safe-tool-reason-codes.test.mjs`（必要时同时保留 `packages/application/test/thread-execution-state.unit.test.ts` 的 `projects only allowlisted tool failure reasons` 用例）。

### 3.【低，推测】`knownExit` 为真时 `output_limit` 仍可能被当作正常退出
- 文件：`apps/execution-worker/src/production-sandbox-execution-v2.ts:886-898`、`962-975`；SRT 路径 `:1768-1772`、`1811-1863`
- 问题：`boundedTermination` 要求 `!knownExit`；一旦 `taskStarted && taskProcessExited && stdioClosed && exitCode !== null` 同时成立，即使 `result.reason === "output_limit"`，代码也会走 `knownExit` 分支。对 `command` 且退出码为 0 的情况，结果会被记成 `kind:"result"`（成功），输出却被截断。新测试只覆盖了 `exitCode: null`。
- 证据：
  ```ts
  const boundedTermination =
    plan.mode === "foreground" &&
    !knownExit &&
    ...
      : result.reason === "output_limit"
        ? SANDBOX_OUTPUT_LIMIT
        : null;
  ```
  ```ts
  : plan.mode !== "foreground" || !knownExit
    ? { ...resultFields, kind: "unknown", reasonCode: "SANDBOX_EXIT_UNKNOWN" }
    : ["command", "network_only"].includes(...) || result.exitCode === 0
      ? { ...resultFields, kind: "result", ... }
  ```
  测试 `test/integration/sandbox-v2-worker-lifecycle.test.ts:203-210` 固定使用 `exitCode: null`，没有覆盖「已退出但输出超限」。
- 说明：这是代码事实；生产上是否会发生该时序（stdout 数据在 exit 事件之后才被处理）属于推测，我没有复现。它在本次改动前也存在，不是本轮引入的回归，但本轮「输出过多一律明确失败」的说法对它不成立。
- 建议：当流结束原因明确是 `output_limit` 时，优先按输出上限失败处理，不要被正常退出码覆盖；或补一条 `output_limit` + `exitCode:0` 的用例明确预期。

### 4.【低，设计建议】两份白名单一致性的门槛靠解析源码，比较脆弱
- 文件：`test/tooling/safe-tool-reason-codes.test.mjs:5-17`
- 问题：测试用字符串定位 `const SAFE_TOOL_REASON_CODES = new Set([` 和 `]);`，再按逗号切分，能防住「只改一份」；但它依赖两份文件都保持同一种字面量写法，也无法防止「新增原因码时两份都没加」。
- 证据：
  ```js
  const start = source.indexOf("const SAFE_TOOL_REASON_CODES = new Set([");
  const end = source.indexOf("]);", start);
  return source.slice(...).split(",").map((entry) => entry.trim().replaceAll('"', ""))...
  ```
- 建议：更稳的做法是把 `SAFE_TOOL_REASON_CODES` 抽成一个共享导出（例如放在 `packages/application` 的独立模块），`thread-execution-state.ts` 和 `thread-execution-projection.ts` 都 import 它，从结构上消除两份清单；再保留一条行为用例验证某个具体原因码能否显示。

---

## 侧重检查

- **错误路径**：我核对了本机 job host、容器、SRT 三条路径的 `output_limit` 分支、`knownExit` 覆盖关系、`recordCompletion`/`reduceRisk` 的资源释放，以及恢复层 `production-tool-result-recovery.ts:159-170`（`!["result","error"].includes(...)`）不会再给新的 `error` 结果写「永远找不回」记录。未发现本轮改动造成的悬挂回归；残留风险见问题 3。
- **不合规范/不可信输入**：输出上限数值来自服务端存储的 `plan.resourceCeiling`（`production-sandbox-tool-result.ts:389-391`），不来自模型参数；`limitBytes` 只做数值格式化，不插入用户文本。合同要求 `maxOutputBytes` 为正整数（`contracts-v2.ts:177-183`）；即使运行期传入异常值，最坏也只是显示 `undefined 字节`，不会执行危险操作。
- **安全**：`SANDBOX_OUTPUT_LIMIT` 已加入两份 UI 白名单，消息只包含固定文案和数值上限，不含秘密；`boundedFailure` 下 `canAct` 为假（`sandbox-execution-projection.ts:218`），不会因这次交付而允许新的工具操作。
- **资源耗尽**：三条路径的输出都在 `maxOutputBytes` 以内——本机由 `product-job-host.ts:37` 传计划上限、`job-host-main.ts:681-685` 截断；容器由 `container-pi-main.ts:99` 和 `pi-host-publication.ts:104-107` 的 `fitBody` 截断；SRT 的 run 级上限是计划值（`production-sandbox-execution-v2.ts:1640`），且 `job-host-protocol.ts:218-225` 要求 run 上限不超过 session 上限。`outputProtected` 的 `<=` 条件在本地/SRT 可行。
- **不可撤销操作**：`output_limit` 消息明确写了「可能已经修改了工作区」「输出已被截断、拿不到完整内容」「没有重新执行」，并丢弃截断输出（`production-sandbox-tool-result.ts:132-146`），没有把部分输出当成完整结果交给模型。
- **规则/文档一致性**：发现事故表测试路径已过期（问题 2）；未能核对作者声称的实际测试运行结果。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会（按代码阅读）。** 本次改动只影响：
- 工具结果的文本/回执（`production-sandbox-tool-result.ts:147-174`、`:389-391`）；
- UI 投影与三语文案（`execution-view.ts:378`、`message-ids.ts:210`、三个 locale 文件）。

系统提示、工具定义、历史消息、出口遮盖都没有改动。`SANDBOX_OUTPUT_LIMIT` 的说明是作为刚刚结束的那次工具调用的结果内容，经 `pi-runtime-adapter.ts:2010-2021` 以 `content` 追加；`details.errorCode` 也随之进入最后一条工具结果消息。上限数值来自本次调用的 `plan.resourceCeiling`/回执，不是每轮变化的运行时值。唯一的残余是回执缺 `resourceCeiling` 时的 `?? ceiling` 兜底，但新的 `output_limit` 回执现在都会带上它（虽然该兜底值也只会出现在末尾的工具结果里，不在请求头）。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？
**不会（新路径）。** `sandboxCeilingExceededMessage` 是固定模板加 `limitBytes(ceiling.maxOutputBytes)`，没有时间、随机数或无序集合；`SAFE_TOOL_REASON_CODES` 只是 `Set.has` 判断，不参与序列化。回执里存了本次生效的 `resourceCeiling`，重放时 `completion.resourceCeiling ?? ceiling` 会优先用回执值（`production-runtime-tools.ts:2103-2106`）。旧回执缺该字段时理论上会退到当前 ceiling，可能改变文本，但新产生的 `output_limit` 回执都携带该字段。

### 3. 有没有自动检查，反向用例是否真的会失败？
**有，且我逐条读到的断言在撤掉被测改动后应会失败**：
- `sandbox-bounded-failure`：从 `isSandboxBoundedToolFailure` 去掉 `SANDBOX_OUTPUT_LIMIT` 会失败；
- `sandbox-v2-worker-lifecycle`：去掉本机 `output_limit` 分支会得到 `SANDBOX_EXIT_UNKNOWN`，断言失败；
- `production-runtime-tools`：去掉输出上限说明分支会退到「操作未确认成功。」，断言失败；
- `sqlite-sandbox-execution-v2`：回执携带条件退回只资源上限会缺少 `resourceCeiling`，断言失败；
- `production-sandbox-tool-result`：不丢弃截断输出会返回 true，断言失败；
- `execution-view`、`thread-execution-state`、`test/tooling/safe-tool-reason-codes.test.mjs`：映射/白名单缺失会失败。

**但有缺口**：没有用例证明 `SANDBOX_OUTPUT_LIMIT` 能通过 `projectSandboxExecution` 的 `outputProtected`/`boundedFailure` 并交付（问题 1）；容器/SRT 产生端只有事实形状断言，没有「事实 → 投影交付」的用例。作者声称的「实际运行通过」我无法执行，标记为未核实。

### 4. 每个新值的使用方都能接受吗？
逐个核对结果：

| 产生的值 | 产生位置 | 使用位置 | 结论 |
|---|---|---|---|
| `SANDBOX_OUTPUT_LIMIT` | `production-sandbox-execution-v2.ts:896,959,1238,1846` | `isSandboxBoundedToolFailure`（`:320`）；两份 SAFE 白名单（`thread-execution-projection.ts:39`、`thread-execution-state.ts:35`）；`execution-view.ts:378`；i18n | 均接受 |
| `resourceCeiling`（`maxOutputBytes`） | `production-sandbox-tool-result.ts:389-391` | `production-runtime-tools.ts:2105`；回执 JSON；`CapabilityResourceCeiling`（`application/src/ports/capabilities.ts:31`、`contracts-v2.ts:177-183`） | 均接受；SQLite 用例验证 |
| `chat.reason.toolOutputLimit` | `message-ids.ts:210` | `execution-view.ts:378`；`en.ts`、`ja.ts`、`zh-CN.ts`；`i18n-runtime.unit.test.ts` 会强制三语键集一致 | 均接受 |
| 两份 `SAFE_TOOL_REASON_CODES` | 两个 services 文件 | UI 投影/状态；新 tooling 一致性测试 | 均接受 |
| `isSandboxOutputLimitReason` / `isSandboxCeilingExceededReason` | `execution-contracts/src/sandbox-execution-v2.ts:270-275` | `production-sandbox-tool-result.ts:141,161,389` | 均接受 |
| 事故号 I-84 | 文档与测试标签 | `check-incident-gates.mjs` | 编号本身通过；但文档里的测试路径已过期（问题 2） |

另外我确认了 `apps/application/src/services/thread-execution-resources.ts:231-243` 也使用 `isSandboxBoundedToolFailure`，本轮加入输出上限后，带 `output_limit` 且已释放的操作不再被标成「结果未确认」。这与资源上限一致；当工作区冲突或不允许向模型披露时仍可能挂到期限，文档已写明，属于既有行为，不是本轮新增。
