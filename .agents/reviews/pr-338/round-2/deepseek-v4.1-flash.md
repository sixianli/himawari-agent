## 结论摘要

整体方向正确：本轮（c4df673b..0dbe73d8）主要是补测试和改文档，新增的捕获一致性检查是 fail-closed 的。但有两处自动检查覆盖不足，另有一处真实的行为语义被作者说轻了；最关键的风险是新的捕获一致性检查在压缩/steered 自定义消息之后可能误拒，而现有测试完全没有覆盖这些正常挂起路径。

## 读代码证实的问题

### 1. 中：捕获一致性检查在压缩、截断恢复或 steered 自定义消息后可能误拒，且无测试覆盖
`packages/runtime-pi/src/pi-tool-batch-continuation.ts:46-53`
```ts
const entries = branch.slice(0, entryIndex);
if (
  !isDeepStrictEqual(
    withoutSystem(batchSessionManager(entries, "/").buildSessionContext().messages),
    withoutSystem(messages.slice(0, index)),
  )
)
  throw new Error("PI_CONTINUATION_PREFIX_INVALID");
```
检查本身是 fail-closed，方向正确。但它比较的是“会话条目重建出的消息”和“`agent.state.messages` 内存消息”。ADR 前提 5 明确说 Pi 1.5.0 会在自动重试和“上下文溢出或截断恢复”时追加 `context_edit`，注释原文是 “Keep the failed attempt in raw history while durably omitting it from model projection”。也就是说，`SessionManager` 原始条目与模型投影可能正好在失败回答处不同；如果 `agent.state.messages` 保留的是 raw history，重新构建出的 prefix 会少掉那条失败回答，于是这里会误拒。
另外，适配器在运行中压缩后会通过 `session.agent.steer({ role: "custom", ... })` 追加运行环境消息（`packages/runtime-pi/src/pi-runtime-adapter.ts:1665-1670`）。如果该消息已进入 `agent.state.messages` 但尚未进入 SessionManager 条目，也会触发同样的不一致。
现有测试没有覆盖这些路径：`packages/runtime-pi/test/pi-tool-batch-continuation.compat.test.ts:34` 明确 `compaction: { enabled: false }`；新增的 unit 用例只覆盖“内存消息多一条”的拒绝（`tool-batch-state.unit.test.ts:65-73`）。所以无法证明“压缩之后、自定义 steer 之后不会误拒”。

还要指出作者说法的偏差：检查失败并不只是“拒绝保存”。`checkpoint` 的 catch 会把它变成一条失败的普通工具结果（`RUNTIME_TOOL_CHECKPOINT_FAILED`，工具不执行），`suspend` 的 catch 会把它变成 `result_unknown`（`pi-runtime-adapter.ts:2034-2044`、`2062-2067`）。这会改变产品运行时行为。

建议：用“实际发给模型的 TranscriptContext / 重建投影”作为唯一比较基准，或在比较时排除 `context_edit` 已明确排除的消息；补一个真实 Pi 的端到端用例：运行中压缩/截断恢复后仍能挂起并保存批次，以及压缩后 `willRetry` 追加运行环境消息后再挂起。给这条新检查用独立错误码，便于区分是“快照结构性失效”还是“内存与条目不一致”。

### 2. 中：安全例外过滤的正确性只测了 `loadReviewedExceptions`，没测真正的 gitleaks 门禁路径
`scripts/ci/check-security.mjs:569-584` 的 `gitleaksGateExceptions` 也调用了 `withoutRemovedDependencies`，而这个函数没有导出。新测试只覆盖了 helper 本身和 `loadReviewedExceptions`：
- `test/tooling/security.test.mjs:568-575` 直接测 helper；
- `test/tooling/security.test.mjs:604-617` 测 `loadReviewedExceptions`。

如果把 `gitleaksGateExceptions` 里的过滤删掉，现有测试仍然全绿。而这条路径才是 PR 升级依赖后 CI 实际读取 base 例外清单的地方。建议把 `gitleaksGateExceptions` 导出或通过 `check-security` 入口加一条反向用例：base 里带已删除依赖版本的例外，候选清单已删除时，门禁不得报 `SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN`。

### 3. 低：`jsonToolArguments` 只测了函数本身，没有测试两个实际调用点
`packages/runtime-pi/src/json-tool-arguments.ts:41-45` 的单元测试很扎实，但两处调用点没有对应的“去掉调用就会失败”的测试：
- `packages/runtime-pi/src/sandboxed-coding-executor.ts:48-53`
- `packages/runtime-pi/src/prepare-file-mutation.ts:57-62`

如果从这两处删掉 `jsonToolArguments(...)`，`json-tool-arguments.unit.test.ts` 仍然通过。建议补一条通过真实 `executeSandboxedPiCodingTool`/`computePiFileMutation` 的用例，传入 `undefined`、`Map`、循环引用等值，断言在执行 Pi 工具参数校验前就被拒绝。

### 4. 低：`PI_REQUEST_TOOLS_DIVERGED` 这个新值在事件和日志里看不到
产生处：`packages/runtime-pi/src/pi-runtime-adapter.ts:1603` 返回 `failedPiStream(model, "PI_REQUEST_TOOLS_DIVERGED")`。
消费处：`modelFailureCode` 没有专门映射，落到 `PI_MODEL_ERROR`（`:420-429`）；`loggableModelFailure` 也会把它压成 `provider_message_withheld`（`:431-440`）。测试只检查 `runtime.failed` 的 `errorCode === "PI_MODEL_ERROR"` 和历史里包含该字符串（`prompt-prefix.compat.test.ts:783-786`）。这意味着线上事件和日志里看不到这个诊断码，排查“工具名分歧”时只能看历史快照。建议给 `PI_REQUEST_TOOLS_DIVERGED` 单独的错误分类或在日志映射里放行。

### 5. 低：ADR 决定 7 仍写成 `context_edit`“只会和压缩一起出现”，与前提 5 冲突
`docs/adr/0198-upgrade-pi-to-1-5-0.md:55` 写“它只会和压缩一起出现（前提 5）”，但同一文件 `:40` 的前提 5 明确列出自动重试也会追加 `context_edit`。规则文件已补上“Himawari 关着自动重试”的前提（`.claude/rules/prompt-prefix.md:35`），ADR 决定 7 没有同步加这个限定。建议在决定 7 写明“在 Himawari 关闭自动重试的前提下”。

### 6. 低：测试声称“逐字节比较续跑请求开头”，实际比较的是 `JSON.stringify` 后的 transcript
`packages/runtime-pi/test/pi-tool-batch-continuation.compat.test.ts:168-171`
```ts
const before = (model.observed[0] as { transcript: unknown[] }).transcript;
const after = (model.observed[1] as { transcript: unknown[] }).transcript;
expect(before.length).toBeGreaterThan(1);
expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
```
这验证的是反序列化对象的序列化结果，不是原始 HTTP 请求体字节；也没有覆盖同一请求里的其他字段。作为回归测试可以，但作者说法里的“逐字节”不准确。

## 推测 / 未核实

- **跨 0.84.2→1.5.0 请求体逐字节相同：未核实。** ADR 后果一节说用同一份内容在两个版本下实测请求体逐字节相同，但仓库里没有可复现这条结论的自动测试；当前提交的 `prompt-prefix.compat.test.ts` 只验证 1.5.0 内部多轮只追加。仓库没有安装 0.84.2，无法在本环境复现。
- **Pi 1.5.0 的 `agent.state.messages` 到底是 raw history 还是模型投影：未核实。** 这决定第 1 条是真实误拒还是只是理论风险；仓库内没有 Pi 源码，只有 ADR 引用的上游注释。
- **把 Pi 自动重试打开后 503 用例会失败：未核实，且没有自动反向用例。** ADR 和规则都如实写成手动验证；正确，但无法用当前仓库自动证明。
- **`context_edit` 在不需要压缩的截断恢复路径上的实际发生条件：未核实。** ADR 前提 5 声称只在这两处发生，但没有仓库内可执行的证据。

## 侧重检查

- **错误路径：** 捕获检查抛出后，`checkpoint` 会返回失败的工具结果且工具不执行（`pi-runtime-adapter.ts:2034-2044`）；`suspend` 的保存失败会转成 `result_unknown`（`:2062-2067`）。总体 fail-closed，但第 1 条的误拒会直接让审批挂起变成工具失败。
- **不可信输入：** `jsonToolArguments` 拒绝非普通对象、数组、`undefined`、BigInt、函数、Map、Date、非有限数、稀疏数组、符号键、循环引用，节点数 10 万、深度 64 有上限（`json-tool-arguments.ts:3-45`）。未发现明显绕过；但见上文调用点未被测试钉住。
- **安全：** `withoutRemovedDependencies` 只从 base 清单里删例外，不新增豁免；候选清单仍在 `validateSecurityExceptions` 里严格校验（`security-exceptions.mjs:230`）。我把当前 `ci/security-exceptions.json` 里保留的 published-fixture 逐条对回了 `package-lock.json`：`google-auth-library@10.9.1`、`pino@10.3.1`、`universal-github-app-jwt@2.2.2`、`zod@3.25.76`、两处 `zod@4.4.3`、各 `@octokit/*` 版本、`@pinojs/redact@0.4.0` 都能在锁文件同一路径找到，未发现 I-73 那类“清单 id 过不了后端校验”的问题。当前文件没有 advisory 条目。
- **资源耗尽：** JSON 检查有深度和节点上限；但新的捕获检查会在每个工具 checkpoint 上额外 `structuredClone(entries)` + `buildSessionContext()`，而 `checkedBatch` 又会再克隆/重建一次（`pi-tool-batch-continuation.ts:46-53`、`:130`），长对话多工具时是双份全历史开销。不是正确性问题，但值得留意。
- **不可撤销操作：** 工具名分歧检查在发出请求前返回失败（`:1603`），捕获一致性检查在工具执行前触发，均避免“未保存恢复记录就执行不可撤销动作”。方向正确。
- **规则/文档与代码一致：** 规则第 4 条已如实写入“Himawari 关着自动重试”的限定；`docs/engineering-casebook.md:5439` 写成“手动打开 Pi 自动重试后这条用例会失败”与 ADR 的“适配器没有可以从外面打开重试的入口”表述不一致（前者可理解为改代码，但容易被读成有设置入口）。ADR 决定 7 见上文第 5 条。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   在本 PR 的 1.5.0 自洽范围内，没有新增“改开头”的逻辑：`himawariRequestContext` 用冻结的系统提示和工具重建开头，历史消息只在末尾追加；`prompt-prefix.compat.test.ts` 的多轮、工具、遮盖、附件用例检查 `findConversationBreak` 为空，运行环境说明和时间只在最后一条消息。文档列出的例外（压缩、句柄工具、ADR 0193）仍然存在。跨 0.84.2→1.5.0 的“老对话字节不变”没有仓库内自动证据，**未核实**。本轮新增的捕获一致性检查不参与发送内容。

2. **同一段文字会不会在不同请求里变成不同字节？**
   本轮没有新增依赖前后文的遮盖、时间字段或无序集合进入请求。`himawariRequestContext` 用 `Set` 只做成员判断，工具顺序来自冻结清单/描述符顺序；JSON 检查不改变值；安全过滤只影响 CI 清单。判断为**不会**（跨版本字节一致性仍见上一问的未核实）。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   - 工具名分歧用例：逻辑上删掉 `himawariRequestContext` 的分歧返回后，会真的发出 1 条请求，用例会失败；作者手工验证过，代码支持这个结论。
   - 捕获一致性 unit 用例：删掉新检查后捕获会成功，用例会失败；成立。
   - `jsonToolArguments` helper：删掉具体校验分支，表格用例会失败；但删除两个调用点不会失败，**调用点没有反向用例**。
   - `withoutRemovedDependencies` helper：删掉过滤，直接单测和 `loadReviewedExceptions` 用例会失败；但 `gitleaksGateExceptions` 这条真实门禁路径没有反向用例，**该路径漏测**。
   - 自动重试用例：明确是手动验证，没有自动反向用例；规则/ADR 已如实说明。
   - 压缩/自定义 steer 后的捕获正常路径：没有自动用例，**无法证明不会误拒**。

4. **每个新值的使用方都能接受吗？**
   逐个核对：
   - `pi-tool-batch.v3`：产生于 `capturePiToolBatch`，被 `checkedBatch`/`inspectPiToolBatch` 消费；v1/v2 在 restore 报 `PI_CONTINUATION_VERSION_INVALID`，`inspect` 返回 `undefined`，生产恢复扫描新增 `if (!batch) continue`（`production-tool-result-recovery.ts:226-227`）；兼容测试已改为 v3。两端一致。
   - `PI_CONTINUATION_PREFIX_INVALID`：新增在 capture 抛出；适配器 `checkpoint`/`suspend` 的 catch 能接受并转成工具失败/结果未知；测试断言字符串。一致，但见第 1 条的行为影响。
   - `PI_REQUEST_TOOLS_DIVERGED`：产生于适配器并进入 `errorMessage`/历史；`modelFailureCode` 把它归为 `PI_MODEL_ERROR`，`loggableModelFailure` 会隐藏具体文字（见第 4 条低问题）。
   - `jsonToolArguments` 返回值：`validateToolArguments` 按 `JsonObject` 接受；调用方都在 Pi 校验前使用。一致。
   - `withoutRemovedDependencies` 返回的文档：仍满足 schema，且过滤后由 `validateSecurityExceptions` 再校验；当前清单条目也能对上锁文件。一致。
   - 删除的 `ci/security-exceptions.json` 清单项：候选清单已同步删除，未发现残留的 0.84.2 条目。一致。
