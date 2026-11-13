## 结论

核心修复方向正确：`isError` 现在沿用 Pi 返回值，生产前台结果的退出码和 `failedCommandModelContent` 的触发条件都能对上。未发现会改变模型已见请求开头的高危问题。

按严重度排列，我读出 1 个错误路径上的潜在不一致（触发条件未核实）和 2 个测试/证据缺口。

---

### 1. [中｜推测] `write` 失败结果会被无条件替换成“Successfully wrote”成功文案

**文件**：`packages/runtime-pi/src/sandboxed-coding-executor.ts:68-80`

**问题**：本次把 `isError` 改成透传 Pi 的 `true` 后，正常返回结果也可能表示失败。但同一段代码对 `write` 的 `content` 覆盖只看工具名和参数，不看 `result.isError`。因此如果 Pi 1.5 用“返回 `isError: true` 的结果”而不是抛错来表示写失败，模型会收到：

- `isError: true`
- `content` 却是 `Successfully wrote N bytes to ...`

下游 `formatForegroundPiResult` 会把信封写成 `isError: true`、进程退出码 1，但正文仍是成功文案；这与本次修复要表达的“失败就是失败”相矛盾。

**证据（读代码证实）**：

```ts
const content =
  input.name === "write" &&
  typeof written.content === "string" &&
  typeof written.path === "string"
    ? [
        {
          type: "text" as const,
          text: `Successfully wrote ${new TextEncoder().encode(written.content).byteLength} bytes to ${written.path}`,
        },
      ]
    : result.content;
return { ...result, content, isError: result.isError === true };
```

`result.isError` 为 `true` 时，上面的条件仍然成立，成功文案仍然会被写入。

**未核实部分**：Pi 1.5.0 的 `write` 失败是否真的以返回 `isError: true` 的结果表示。当前是稀疏检出，`node_modules` 不在工作区，无法直接读 `bash.js` / `write.js`。同一仓库里 `edit` 的失败结果已经有 `isError: true` 的构造用例，因此这是真实存在的错误路径风险，不是纯理论。

**建议**：

```ts
const content =
  input.name === "write" &&
  result.isError !== true &&
  typeof written.content === "string" &&
  typeof written.path === "string"
    ? [ ...成功文案... ]
    : result.content;
```

并补一条用例：让 `write` 返回 `isError: true`，断言 `content` 保留 Pi 的错误正文，而不是成功文案。

---

### 2. [低] 新测试只覆盖 `bash`，而改动影响所有工具；且失败执行是桩

**文件**：`packages/runtime-pi/test/sandboxed-coding-executor.compat.test.ts:75-96`

**问题**：修改的是一行对所有工具生效的逻辑，但新增用例只有 `name: "bash"`。`write`/`edit`/`read` 的返回失败路径没有对应的回归用例。尤其是上面的 `write` 文案覆盖问题，正好落在这个覆盖空白里。

另外，新用例的失败执行来自 `commandOperations` 的桩：

```ts
operations: commandOperations(async ({ onData }) => {
  onData(new TextEncoder().encode("not ok 4 - rounds totals\n"));
  return { exitCode };
}),
```

它走的是真实 Pi tool definition 加假 `executeCommand`。这能验证“Pi 外壳 + wrapper”的行为，但不能证明真实 shell 进程路径；作者材料里“测试不用假替身”的约束在字面上没有完全满足。已有 `live-harness` 的真实命令用例可以补足产品路径，因此我不把它列为高严重度。

**建议**：至少增加一条非 `bash` 工具（优先 `write`/`edit`）返回 `isError: true` 的用例；如要严格遵守“不用假替身”，可把 `executeCommand` 桩换成真实 `exit 3` 命令。

---

### 3. [低] 生产边界没有直接的回归断言

**文件**：`packages/runtime-pi/test/sandboxed-coding-executor.compat.test.ts:75-96`；`apps/agent-service/src/production-sandbox-tool-result.ts:106-113`

**问题**：新用例只断言 executor 的 `isError`。真正生产路径上的两个关键点：

- `packages/platform-node/src/files/pi-host-publication.ts:110-114` 用 `isError` 算进程退出码；
- `apps/agent-service/src/production-sandbox-tool-result.ts:106-113` 要求 `fields["isError"] === true` 才附“命令执行失败”提示。

这两处已有各自的单元/浏览器用例，但本次没有新增一个从“executor 返回失败结果”到“前台信封 exitCode 非 0、`effectNotice` 出现”的端到端断言。作者所说的 `product-path-browser.test.ts` 的 `[R2-T14]` 覆盖了这条路径，但我不确认它是否属于 coverage 作业的必跑套件。

**建议**：在 `production-foreground-result.unit.test.ts` 或 `production-runtime-tools.unit.test.ts` 补一条直接使用真实 `executeSandboxedPiCodingTool` 结果的用例，断言退出码和 `effectNotice` 同时成立。

---

### 4. [信息] I-96 文档中部分事实无法在当前稀疏检出核实

**文件**：`docs/incidents-and-gates.md:132`

**已核实一致的部分**：

- `packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:72-74` 确实包含：
  ```sql
  OR (c.diagnostic_code IN ('RUN_EXECUTION_DEADLINE_EXCEEDED','PERSISTED_EXECUTION_RECONCILIATION_REQUIRED','RUNTIME_ATTEMPT_INTERRUPTED','SERVICE_STOPPING','EXECUTION_LEASE_RENEWAL_FAILED')
  ```
- 旧测试确实断言 `listReconciliationRequired(...).resolves.toEqual([])`，新测试改为期望候选，和 I-88 的规则一致。
- 旧工作区测试确实用 `toEqual` 比较 `serialize()` / `readFile` 的 Buffer；新测试改成了 SHA-256 摘要。

**未核实**：

- `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js` 的具体内容和 `if (exitCode !== 0)` 分支；当前工作区没有 `node_modules`。
- “本机 12 秒、CI coverage 下超过 30 秒、整个文件 63 秒降到 13 秒”这些计时数据。
- “撤掉诊断码时旧测试 50 条全过”没有实际运行验证。
- “Pi 1.4 是抛错”没有仓库内源码可对照。

---

## 侧重检查

- **错误路径**：重点看了 `executeSandboxedPiCodingTool` 的抛出/返回两条路径、`formatForegroundPiResult` 的 `isError` 到 exitCode 映射、`failedCommandModelContent` 的 `isError === true` 校验。主要风险就是上面第 1 条 `write` 成功文案覆盖。
- **不合规范或不可信输入**：本次没有改参数校验、路径校验、cookie/JSON 解析；`PI_TOOL_ARGUMENTS_INVALID`、`PI_PATH_OUTSIDE_SCOPE` 等路径未受影响。未发现新增信任边界。
- **安全**：`isError` 只影响工具结果标记和退出码，不新增输出通道；命令失败后仍走原有出口遮盖和 `effectNotice` 路径。未发现新增泄密路径。
- **资源耗尽**：工作区测试从逐字节深比较改成 SHA-256 摘要，CPU 开销更低；生产端只改布尔标记，没有新增循环、重试或资源分配。
- **不可撤销操作**：命令失败现在会被正确标成失败，模型可能因此重试；现有 `effectNotice` 已提示“没有核验是否改动工作区、继续前先检查目标文件”，没有新增自动重试或自动重放。
- **规则/文档一致性**：`prompt-prefix` 要求的“只追加、字节确定”没有被破坏；I-96 与 I-88、SQL 测试断言基本一致，但文档引用的 Pi 源码和计时数字未能在当前环境核实。

---

## 读代码证实的 / 推测的

**读代码证实**：

- `isError: result.isError === true` 已生效，且结果会被 `formatForegroundPiResult` 写进 `pi-result.v1` 信封。
- `formatForegroundPiResult` 在 `isError: true` 时会把退出码算成 1 或真实命令退出码。
- `failedCommandModelContent` 只在 `fields["isError"] === true` 且退出码匹配时附“命令执行失败”提示。
- `write` 的 content 覆盖没有检查 `isError`。
- SQLite 的 `RUNTIME_ATTEMPT_INTERRUPTED` 已在 `RUN_EXPIRED_RECONCILIATION_SQL` 第三种情况中。
- 工作区测试的所有“数据库未变化”断言都已改为摘要比较，没有残留旧的 `toEqual(Buffer)`。
- `pi-write-evidence.ts:200` 对成功写入证据要求 `isError` 不是 `true`，因此消费者不会把 `isError: true` 的写入当成成功发布。

**推测或未核实**：

- Pi 1.5.0 的 `write` 失败是否返回 `isError: true`，从而触发第 1 条。
- Pi 1.5.0 bash 返回结构的源码依据。
- 文档中的性能数字和测试统计。
- 新测试在真实 CI coverage 作业中的执行情况。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会改变系统提示、工具定义、已有历史或已有遮盖结果。改动只发生在**新产生的工具结果**上：`executeSandboxedPiCodingTool` 把 `isError` 放进返回结果，前台路径再把它序列化进 `pi-result.v1` 工具结果；该结果作为本轮工具结果追加在历史末尾。已持久化的 `panyscale`/`toolResult` 历史仍保留原来的 `isError` 字节，`pi-native-history.ts:50-54` 只是校验并恢复既有布尔值，不会重写。

每轮会变的值仍是命令输出和退出状态，本来就在最后一条工具结果里，不在系统提示或工具定义里。`himawariRequestHead` 也只是把系统消息放前面、过滤 system 后拼接，没有按 `isError` 重写历史。

### 2. 同一段文字会不会在不同请求里变成不同字节？

没有新增依赖前后文的序列化、时间字段或无序集合。`isError` 是命令结果的确定布尔值；`formatForegroundPiResult` 的 JSON 键顺序固定；`effectNotice` 的文本由固定模板和退出码组成。工作区测试的 SHA-256 摘要只存在于测试进程，不进入模型请求。因此同一结果重复序列化应得到相同字节。

### 3. 有没有对应的自动检查，反向用例真的会失败？

有，但覆盖不完整：

- 新增 `reports a nonzero command exit as a failed tool result`：如果撤掉 `isError: result.isError === true`，在 Pi 1.5 返回 `isError: true` 的前提下，`failed.isError` 会变成 `false`，用例失败。
- SQLite 用例：如果从 `RUN_EXPIRED_RECONCILIATION_SQL` 去掉 `RUNTIME_ATTEMPT_INTERRUPTED`，第三种情况不再匹配、没有任何沙箱记录，候选查询会返回 `[]`，新断言失败。
- 工作区审计用例：如果审计真的改写数据库，SHA-256 摘要变化，`toBe` 失败；但它不是新增的反向用例，只是保留了原来的防写检查。
- 缺口：生产边界的 `exitCode`/`effectNotice` 没有由新测试直接断言；`write`/`edit` 的失败返回路径没有新测试；新测试的失败执行来自桩而不是真实命令。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对如下：

- `isError: true` → `formatForegroundPiResult`：接受布尔值，并据此算退出码 1 或真实退出码。
- `isError: true` → `failedCommandModelContent`：明确要求为 `true`，正好匹配。
- `isError: true` → `pi-write-evidence.ts`：成功证据要求 `isError !== true`；失败证据路径接受 `true`，不会把失败写入当成发布成功。
- `isError: true` → `toolProgressOutput` / `pi-native-history.ts`：只要求是布尔值，接受。
- `isError: true` → `pi-tool-progress-guard`：参与摘要计算，布尔值可接受。
- SQLite 新测试产生的 `runId`、`action: "reconcile"`、`runStatus`、`checkpointPhase`、`runRevision`：分别符合 `RunReconciliationCandidate` 和 `candidate()` 的输出；`quarantine` 后数据库断言已确认 `runs.revision = 2`、状态为 `reconciling_external_result`。
- SHA-256 摘要：只在测试内部使用，没有生产消费者。

唯一两端不完全一致的是第 1 条的 `write`：`isError` 已经表示失败，但模型可见的 `content` 仍可能说“Successfully wrote…”。
