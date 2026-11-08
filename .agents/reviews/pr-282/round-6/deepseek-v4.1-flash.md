## 结论概要

- 没有发现高危问题。R5-1 的修复方向正确：本机路径现在和容器、SRT 路径一致，越界一律记 `unknown`，之前那条 `not_asserted` 确实会被 `validateSandboxExecutionFacts` 拒绝，生产写不进去。
- 有 1 条中等问题：资源上限的模型文案和界面文案仍然无条件声称「已被终止」，而本 PR 新增的 `resource-limit-after-exit` 用例恰好表示「进程自己退出后上限才越过」。
- 另有 3 条低问题：docs 里残留一句旧的「输出已被截断」；假日志校验没有作者说的「与 SQLite 层一致」那么完整；三语界面文案改动没有测试保护。

---

## 读代码证实的问题

### 中：资源上限文案仍声称「已被终止」，与 after-exit 用例冲突

**文件:行**：`apps/agent-service/src/production-sandbox-tool-result.ts:173`；`apps/execution-worker/src/production-sandbox-execution-v2.ts:910-911`；`test/integration/sandbox-v2-worker-lifecycle.test.ts:208-215, 801-807`

**问题**：这一轮只把输出上限的文案从「已被终止」改成「已停止接收」，但资源上限（CPU/内存/未命名资源）的模型文案仍然无条件写死「已被终止并完成清理」。而本 PR 自己的 `[I-84] resource-limit-after-exit` 用例构造的正是 `exitCode: 0` + `reason: "resource_limit"`：进程已经自己退出，只是资源监视器后来才发现超过上限。此时命令并没有被终止。

**证据**：
- `production-sandbox-execution-v2.ts:910-911`：
  ```ts
  : boundedTermination
    ? { kind: "unknown", reasonCode: boundedTermination }
  ```
  `boundedTermination` 同时包含 `resource_limit` 和 `output_limit`。
- 用例 `test/integration/sandbox-v2-worker-lifecycle.test.ts:208-215`：
  ```ts
  exitCode: limitAfterExit ? 0 : null,
  ...
  reason: outputLimit ? "output_limit" : "resource_limit",
  ```
- `production-sandbox-tool-result.ts:173`：
  ```ts
  return `${reasonCode}：${crossed}，已被终止并完成清理，没有重新执行。...`;
  ```
- 三语资源上限文案同样如此：`apps/control-center/src/i18n/resources/zh-CN.ts:214-217`、`en.ts:225-231`、`ja.ts:229-233`。

**补充推断（读资源监视器代码得出，未在真实进程上复现）**：`packages/runtime-sandbox/src/resource-observer.ts:220-227` 在采样超过上限时调用 `stopTask("resource_limit")`，采样本性和进程退出之间没有同步；`job-host-main.ts:306` 的 `finish()` 又无条件带 `exitCode: task?.exitCode ?? null`。所以「采样时已超限、随后进程以 0 退出」是可产生的状态，而不是纯测试臆造。

**建议**：把资源上限文案也改成不声称终止（例如「已请求停止，若仍在运行则已被终止」），或者对 after-exit 单独给文案；同时补一条针对 `resource-limit-after-exit` 的文案断言。

### 低：docs 残留旧的「输出已被截断」说法

**文件:行**：`docs/incidents-and-gates.md:122`

**问题**：I-84 行「门槛」一栏仍写着「输出上限还要说明拿到的输出已被截断」，与代码和测试现在的「可能已被截断」不一致；同一格里后面又写「只说『可能已被截断』、不声称命令被终止」，自相矛盾。

**证据**：
- 代码 `production-sandbox-tool-result.ts:162`：`交给你的输出可能已被截断`。
- 测试 `apps/agent-service/test/production-runtime-tools.unit.test.ts:566`：`toContain("可能已被截断")`。
- docs 同句仍是「拿到的输出已被截断」。

**建议**：改为「可能已被截断」，或删除这句，只保留后面准确的描述。

### 低：假日志校验并未真正「与 SQLite 层一致」

**文件:行**：`test/integration/sandbox-v2-worker-lifecycle.test.ts:515-522`；`packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts:1163-1175, 1523-1539`

**问题**：作者说假日志「append 传上一份事实、operation 不传，与 SQLite 层一致」。但 SQLite 层还有假日志没有复刻的检查：
- `bind` 在生产会校验，并要求 `result === null`、`effect.kind === "unknown"`、`resource.sequence === 2`、`supervision === "initializing"`（1163-1175）；假日志的 `bind` 分支直接 `facts = command.facts`（426-430），不校验。
- `operationOnly` 在生产除了 `validateSandboxExecutionFacts` 还额外要求「已知结果不可变」「verified effect 不可变」「resource 完全不变」（1529-1539）；假日志只调用 validator，不查这些。
- `operation` 的 binding environment 在生产用 `current.facts.environment`，假日志用 `command.facts.environment`（520）；如果 operation 携带了不同的 environment，假日志会放行而生产会以 `frozen binding substituted` 拒绝。

**证据**：上面已引的测试 515-522 与 SQLite 1523-1539。

**建议**：要么把假日志补齐这些检查（尤其 `operation` 用 `facts.environment` 作为 binding），要么在提交说明/文档里把「与 SQLite 层一致」改成「调用同一个契约校验，但不复刻 operationOnly 的额外检查」。

### 低：三语界面文案改动没有自动检查

**文件:行**：`apps/control-center/test/i18n-runtime.unit.test.ts:63-69`；`apps/control-center/test/execution-view.unit.test.ts:52`

**问题**：`i18n-runtime` 只检查三语 key 集合完整、ICU 格式合法；`execution-view` 只检查 `SANDBOX_OUTPUT_LIMIT` 映射到 `chat.reason.toolOutputLimit`。没有任何断言检查 `chat.reason.toolOutputLimit` 的文本不再包含「已终止」/`terminated`/「停止と後処理」。把这三处文案改回旧值，测试不会失败。

**建议**：加一条针对三个 locale 的文案断言（例如不包含「已终止」「terminated」「停止と後処理」），或在 `execution-view.unit.test.ts` 里对渲染出的原因词做断言。

---

## 推测 / 需要确认

- after-exit 资源上限是否在生产真的可达：我读的是 `resource-observer.ts` 的采样与 `job-host-main.ts` 的退出上报，推断存在竞态，但没有在真实进程上复现。若确认不可达，则应反过来质疑 `[I-84] resource-limit-after-exit` 这个用例是否在测一个产品不可能产生的状态。
- `verified_effect` 在上限越过时从 `verified` 变成 `unknown`：我认为方向正确且与 SRT 路径一致，因为用于验证的 stdout 本身可能被输出上限截断，旧的「结果失败但 effect=verified」组合反而自相矛盾。代价是这类操作不再 `settled`，工作区会进入 `needsReconciliation`，环境不再复用；这是保守取舍，不是错误。
- `effect.kind === "unknown" && result !== null` 会让这类记录出现在 `listPending`（`sqlite-sandbox-execution-operations.ts:423`）并参与启动恢复/工作区占用判断。对非 after-exit 的资源上限失败这本来就是现状，本轮只是把 after-exit 情形也纳入；如果本意是让这类轮次彻底结束，需要另行确认 `listPending` 的消费方是否接受。

---

## 侧重检查

- **错误路径**：逐条检查了 `boundedTermination` 与 `completionContradicted` / `authenticatedDeadline` / `authenticatedNotStarted` / `fileFailure` 的叠加。`boundedTermination` 在前三个标志为真时被显式置空（`production-sandbox-execution-v2.ts:886-897`），所以不存在「多个失败原因互相覆盖」的非法组合；`fixed_read` 仍走 `not_applicable`，校验器只要求 `not_applicable` 必须对应 `fixed_read`（`sandbox-execution-v2.ts:632-633`），合法。
- **不可信输入**：本轮改动不引入新的外部输入解析；输出上限文案只拼接固定的 `reasonCode` 和来自 plan 的数值上限，没有拼接模型/命令输出。新增的不可恢复记录使用固定常量 `SANDBOX_TOOL_RESULT_UNRECOVERABLE`，分类为 `public`。
- **安全 / 注入**：`sqlite-sandbox-tool-result-recovery.ts:23` 的 SQL 是把固定前缀常量与 `json_extract(...)` 用 `||` 拼接，不是把 invocationId 直接插进 SQL，未发现注入面；`||` 优先级高于 `=`，语义正确。
- **资源耗尽**：本轮没有新增循环或大对象；不可恢复判定要求前台、已释放、未阻塞、进程已退出且终止原因属于固定集合（`production-tool-result-recovery.ts:158-170`、`production-sandbox-stream.ts:14-23`），不会无限重试。
- **不可撤销操作**：effect 从 `not_asserted` 改为 `unknown` 是更保守的方向；投影层通过 `boundedFailure` 仍允许交付（`sandbox-execution-projection.ts:204-217`），但会保持 `needsReconciliation`，不会错误地复用或清理工作区。
- **规则/文档一致性**：除上面 docs 的残留句子外，I-84 行中关于 `validateSandboxExecutionFacts`、SQLite 每次写入都调用、两条 after-exit 用例的假日志也调用校验的描述，与代码一致（`sqlite-sandbox-execution-operations.ts:1163, 1523`；测试 `sandbox-v2-worker-lifecycle.test.ts:515-522`）。
- **R5-3 的事实核对**：`job-host-session.ts:240` 的 `(exitCode !== null && message["reason"] !== "exited")` 和 `job-host-main.ts:1027` 的 `exitCode: commandReason === "exited" ? command.exitCode : null` 确实成立；本机路径 `job-host-main.ts:306` 的 `exitCode: task?.exitCode ?? null` 也确实是无条件带出去的，作者的更正属实。
- **R5-5 的事实核对**：`job-host-main.ts:647-685` 确实是 stdout/stderr 共用一个 `total`；`job-host.ts:457-460` 的 `readOutput(..., channel)` 只在 `channel === "stdout"` 时返回 stdout。作者关于「模型只拿到 stdout」的说法有代码依据。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。本轮的改动只影响：
- 新追加的工具结果消息文本（`production-sandbox-tool-result.ts:162`）；
- SQLite 里的 `effect` 记录值；
- 界面 i18n 文案。

没有动系统提示、工具定义、历史消息或遮盖逻辑。模型侧变化的文字只出现在本轮新增的工具结果消息里，且该文本只依赖固定的 `reasonCode` 和本次生效的 `output` 上限，不含时间等每轮变化值。已存历史按「存实际发出去的那一条」保存，不会因为生成器改了而被重写。

### 2. 同一段文字会不会在不同请求里变成不同的字节？

不会。新增文案没有时间字段，`limitBytes(ceiling.maxOutputBytes)` 来自固定的 plan，`reasonCode` 来自固定枚举；i18n 是静态字符串；没有引入无序集合或依赖后文的遮盖。输出上限文案对同一份上限每次都得到相同字节。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

- **effect 顺序**：有。`[I-84] output-limit-after-exit` / `[I-84] resource-limit-after-exit` 加上假日志里新接入的 `validateSandboxExecutionFacts`，会把旧的 `not_asserted` 组合以 `missing normal result cannot weaken effects` 拒绝。按代码推断，只回退 effect 分支顺序时这两条会失败（我没有运行测试，作者实测 2 失败/34 通过，与逻辑一致）。
- **模型文案**：有。`production-runtime-tools.unit.test.ts:566-568` 同时断言 `toContain("可能已被截断")`、`toContain("标准输出和标准错误合计")`、`not.toContain("已被终止")`；回退文案会失败。
- **界面文案**：没有文本断言，只有 key 和映射检查（见上）。
- **资源上限 after-exit 文案**：没有断言，因此这个残留问题不会被测试发现。

### 4. 改动产生/修改的每个值，每个使用它的地方都能接受吗？

逐个核对后，没有发现 I-73 式的两端校验不一致：

- `effect = { kind: "unknown", reasonCode: SANDBOX_*_LIMIT }`：
  - `validateSandboxExecutionFacts`：`unknown` 只要求 `machineString`（`sandbox-execution-v2.ts:351`），接受；`not_asserted` 才要求 normalExit（634-643）。
  - `projectSandboxExecution`：`unknown` 使 `effectKnown=false`、`needsReconciliation=true`，但 `boundedFailure` 分支仍允许 `deliverToolResult`（`sandbox-execution-projection.ts:174-217`）。
  - `sandboxCommandEffectReason`：只认 `not_asserted`，`unknown` 返回 `null`，于是 `failureReason` 保留 `SANDBOX_OUTPUT_LIMIT`/资源上限码，模型拿到的是上限说明而不是「命令效果未核实」，符合意图。
  - SQLite 写入：`append` 和 `operation` 都接受 `unknown`；`operationOnly` 只额外限制已知结果的不可变和 verified effect（1529-1539），不拒绝 `unknown`。
  - 安全原因码白名单：`SANDBOX_CPU_TIME_LIMIT`、`SANDBOX_MEMORY_LIMIT`、`SANDBOX_RESOURCE_LIMIT`、`SANDBOX_OUTPUT_LIMIT` 两份 `SAFE_TOOL_REASON_CODES` 都有（`thread-execution-state.ts:32-35`、`thread-execution-projection.ts:36-39`），`execution-view.ts:375-378` 也都有映射。
- `resourceCeiling` 新字段：只由 `createProductionSandboxToolResult` 写入回执（`plan.resourceCeiling`），由 `sandboxCeilingExceededMessage` 读取；回执按 JSON 保存、用 `Partial<SandboxToolCompletion>` 读回，新增可选字段兼容。
- `chat.reason.toolOutputLimit` 新文案：三个 locale 都有 key，`message-ids.ts` 已登记，映射存在；没有发现其他消费方依赖旧文本。
- 需要留意的既有行为（不是本轮引入的非法状态）：after-exit 有界失败现在会留下 `effect.kind === "unknown"` 且 `result !== null`，这会让它进入 `listPending` 和 `needsReconciliation`，环境不复用；这是用「保守」换「不假称已确认」，但建议在 I-84 的未覆盖或设计说明里写清楚。

---

## 未核实

- 没有运行任何测试；关于「回退 effect 顺序会失败」是基于作者实测记录和代码静态推断。
- 没有在真实生产/真实进程上复现 `resource-limit-after-exit`；可达性是从 `resource-observer.ts` 和 `job-host-main.ts` 的代码竞态推断的。
- 没有逐个审查所有 `SandboxToolCompletion` 消费方（只查了本仓库内 `resourceCeiling`/`effect`/i18n 的直接使用点）。
