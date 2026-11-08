# PR 282 第 5 轮复核

先说明：以下结论都是只读代码和测试得出的，我没有运行测试（环境只允许读文件和指定 git 命令）。当前检出为 `668e62bf`；相对第 4 轮的增量只有 `085e85b4` 一个提交，合并的 main 没有改动执行契约、持久化或 worker 的这几处判断。

## 读代码证实的问题

### 1. 高：after-exit 路径产生 `not_asserted` + `error/failure`，会被现有契约校验拒绝，生产上很可能根本记不下这次「明确失败」

- 文件：`apps/execution-worker/src/production-sandbox-execution-v2.ts:899-925`、`:953-960`
- 问题：本机前台路径在 `knownExit` 为真、且原因是 `output_limit`/`resource_limit` 时，`result` 会进入新的 `boundedTermination` 分支记成 `kind:"error"`, `termination:{type:"failure"}`；但 `effect` 的分支顺序是先判 `knownExit && ["command","network_only"]`，于是记成 `{ kind: "not_asserted" }`。这个组合不是合法状态。

证据（我亲自读到的代码）：

```ts
// production-sandbox-execution-v2.ts:910-911
: knownExit && ["command", "network_only"].includes(plan.operationContract.kind)
  ? { kind: "not_asserted" }

// production-sandbox-execution-v2.ts:953-959
: boundedTermination
  ? {
      ...resultFields,
      kind: "error",
      output,
      reasonCode: boundedTermination,
      termination: { type: "failure" },
    }
```

而校验器明确禁止这种组合：

```ts
// packages/execution-contracts/src/sandbox-execution-v2.ts:634-643
if (effect.kind === "not_asserted") {
  const normalExit =
    (result?.kind === "result" && result.completion.type === "exit") ||
    (result?.kind === "error" && result.termination.type === "exit");
  ...
  if (!(["command", "network_only"].includes(contract.kind) && normalExit) && !registered)
    fail("missing normal result cannot weaken effects");
}
```

仓库里已经有一条测试专门断言这个组合必须抛错：

```ts
// test/integration/sandbox-execution-v2.test.ts:1033-1057
it("rejects a not_asserted effect for a contradicted completion", () => {
  ...
  expect(() =>
    validateSandboxExecutionFacts(
      f.plan,
      { ...original, effect: { kind: "not_asserted" },
        result: { ... kind: "error", reasonCode: "SANDBOX_HOST_COMPLETION_CONTRADICTED",
                  termination: { type: "failure" } } },
      context(f.plan, original),
    ),
  ).toThrow("missing normal result cannot weaken effects");
});
```

生产持久化层每次 append/recordOperation 都会调用它：

```ts
// packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts:1523-1528
validateSandboxExecutionFacts(
  current.plan,
  facts,
  { environment: current.facts.environment, operationContract: current.plan.operationContract },
  operationOnly ? undefined : current.facts,
);
```

`fail()` 是直接抛 `ContractValidationError`（`packages/execution-contracts/src/sandbox-execution-v2.ts:32-34`），不是返回一个可忽略的标记。因此 after-exit 的明确失败在真实 journal 上会抛错，`recordCompletion` 重试后仍失败，最后走外层 catch 记成 unknown/诊断，而不是把有界失败交付给模型。PR 想修的「截断输出当成功」在测试里被修掉了，但生产上换成了「结果记不下去、继续等原始期限」的问题。

这也违反规范：

```text
docs/execution/specs/2026-09-07-srt-unified-execution-design.md:235
中断、输出丢失、必需后置条件缺失不能降为 not_asserted。
```

输出上限恰恰是「输出丢失」。

建议：让 `effect` 在 `boundedTermination` 时优先于 `knownExit` 分支（和 `result` 的顺序一致），记 `{ kind: "unknown", reasonCode: boundedTermination }`；`verified_effect` 只在写入证据真的校验通过时记 `verified`。容器路径已经就是这么做的（`production-sandbox-execution-v2.ts:1267-1268`），本机路径应保持一致。不要用 `not_asserted` 表达「进程跑完了但输出被截断」。

### 2. 中：新增的 after-exit 门槛用假 journal，绕过了后端的契约校验，等于把非法状态写成了预期

- 文件：`test/integration/sandbox-v2-worker-lifecycle.test.ts:514-518`、`:792-796`、`:804-806`
- 问题：这个测试的 `payloads.sandboxExecution` 只是一个 mock，append/operation 时直接 `facts = command.facts` 并返回，完全没有调用 `validateSandboxExecutionFacts`。它随后断言 after-exit 的 `effect` 是 `not_asserted`，于是测试绿了，但生产 journal 会拒绝同一份 facts。

证据：

```ts
// test/integration/sandbox-v2-worker-lifecycle.test.ts:514-518
if (command.kind === "append" || command.kind === "operation") {
  if (!command.facts) throw new Error("facts missing");
  facts = command.facts;
  ...
}
```

```ts
// test/integration/sandbox-v2-worker-lifecycle.test.ts:792-796
expect(facts.effect).toEqual(
  limitAfterExit
    ? { kind: "not_asserted" }
    : { kind: "unknown", reasonCode: "SANDBOX_OUTPUT_LIMIT" },
);
```

同仓库的容器路径测试反而做了正确的事，可作为改法参考：

```ts
// test/integration/sandbox-v2-container-route.test.ts:165-172
if (command.kind === "bind" || command.kind === "append") {
  ...
  const next = validateSandboxExecutionFacts(
    plan,
    command.facts,
    { environment: command.facts.environment, operationContract: plan.operationContract },
    command.kind === "append" ? facts : undefined,
  );
  ...
}
```

建议：worker-lifecycle 的 mock 也调用 `validateSandboxExecutionFacts`；把 after-exit 的期望改成合法状态（`unknown`）。再加一条直接以 worker 产出的 facts 驱动 `projectSandboxExecution` 的用例，确认交付路径真的接受。

### 3. 低：作者说「SRT 路径的 knownExit 分支排在上限之前，同样把截断输出当成功」不成立，这次 SRT 改动实际是空操作

- 文件：`apps/execution-worker/src/production-sandbox-execution-v2.ts:1767-1771`、`:1810-1821`；`packages/runtime-sandbox/src/job-host-session.ts:240`；`packages/runtime-sandbox/src/job-host-main.ts:1020-1038`
- 问题：SRT 路径的 `knownExit` 要求 `outcome.exitCode !== null`。但会话命令结果的 IPC 校验强制「`exitCode` 非空时 `reason` 必须是 `exited`」：

```ts
// job-host-session.ts:240
(exitCode !== null && message["reason"] !== "exited") ||
```

```ts
// job-host-main.ts:1027
exitCode: commandReason === "exited" ? command.exitCode : null,
```

所以 `reason` 为 `output_limit`/`resource_limit` 时 `exitCode` 必为 null，`knownExit` 必为 false。SRT 路径根本进不了 `knownExit` 分支，原来那两支尾部分支已经会记成失败；第 5 轮把 `limitTermination` 移到 `knownExit` 前面不会改变任何可达行为。另外新分支在 `limitTermination` 时固定写 `effect: { kind: "unknown" }`（`:1820`），与提交说明里「knownExit 为真时副作用维持 not_asserted」也不一致（只是这条分支本身不可达）。

建议：更正提交说明/事故表里「SRT 路径同样的问题」的说法；要么删掉这段无用的重排，要么补一条真正能驱动 SRT `JobHostCommandOutcome` 的用例（但先要证明 IPC 允许 `output_limit` 带非空退出码，而当前校验不允许）。

### 4. 低：事故表把非法状态写成了预期行为

- 文件：`docs/incidents-and-gates.md:122`
- 问题：这一行在描述两条 `-after-exit` 门槛时写「这两种情况下副作用保持 `not_asserted`，因为命令确实自己跑完了」。这正好与 `docs/execution/specs/2026-09-07-srt-unified-execution-design.md:235`「中断、输出丢失……不能降为 not_asserted」和契约校验 `sandbox-execution-v2.ts:634-643` 冲突。文档和代码一起把错误状态固化了。
- 建议：代码改成 `unknown`（或合法的 `verified`）后，同步改事故表；不要把 `not_asserted` 写成这类场景的设计意图。

## 推测 / 未核实

- **推测（低）**：输出上限对 stdout 和 stderr 合计计数（`job-host-main.ts:648-685`），而本机 worker 写进结果产物的只有 `result.stdout`（`production-sandbox-execution-v2.ts:767-772`）。如果某命令 stdout 完整、仅 stderr 在退出后越限，现在会记成「输出上限、输出被截断」的失败，但模型实际拿到的 stdout 并没有被截断。这是否算误报取决于产品对 stderr 的定位，我没有找到明确的规范说明；未核实。
- **未核实**：`resource-limit-after-exit` 这个场景在真实 job host 上是否可达——资源观察器在 `exit` 事件里就被 `observer?.stop()` 停掉（`job-host-main.ts:758-761`），退出后是否还会报 `resource_limit` 取决于采样竞态。测试里直接构造 `exitCode:0 + reason:"resource_limit"` 能覆盖代码分支，但可能不是在测一个真实时序。
- **未核实**：作者说「去掉被测改动后 after-exit 用例报错」。从断言看，回退后 `facts.result` 会变成 `kind:"result"`，确实会触发 `not.toMatchObject({kind:"result"})` 失败；但这条反向验证只证明 result 分支，证不了 effect 的合法性，因为 mock 不校验。未实际运行。

## 作者说法逐条核对

- 「本机前台 `boundedTermination` 去掉 `!knownExit`」：属实，`production-sandbox-execution-v2.ts:886-897` 已不要求 `!knownExit`。
- 「SRT 路径此前同样的成功误记问题」：不属实，见问题 3；SRT 的 `output_limit`/`resource_limit` 不可能同时 `knownExit`。
- 「after-exit 副作用维持 `not_asserted`，当场结算」：代码确实产生 `not_asserted`，但这个状态违反契约，见问题 1；不存在「当场结算」。
- 「R4-1 投影层 `SANDBOX_OUTPUT_LIMIT` 门槛」：测试存在（`test/integration/sandbox-execution-v2.test.ts:938`），能证明投影层接受 `effect: unknown` 的输出上限失败；但它用的不是 worker 新路径实际产生的 `not_asserted`，见问题 2。
- 「R4-2 白名单门槛路径已改到 `test/tooling/safe-tool-reason-codes.test.mjs`」：属实，文件存在且文档路径一致。
- 「合并 main 后只多出 I-83 行」：从 `git diff` 看，执行契约、SQLite、worker、这两个测试在 `4b4347..HEAD` 之间只有 `085e85b4` 改动；main 的合并未改这些语义，未发现冲突。

## 侧重检查

- **错误路径**：重点查了 after-exit 的 `output_limit`/`resource_limit`。结论是 result 方向正确（不再当成功），但 effect 方向产生非法状态，真实持久化会拒绝；详见问题 1。
- **边界输入/误报**：`job-host-main.ts:681-685` 和会话路径 `:852-864` 都是严格 `>` 才越限，输出「刚好等于上限」不会触发；`finish()` 的 `reason` 只有 `outputLimit` 回调或 `endCommand(..., "output_limit")` 会置成 `output_limit`，未发现其他来源。这点没有误报。
- **不受信输入**：`outcome.reason`/`exitCode` 在 IPC 层有枚举和范围校验（`job-host-session.ts:227-251`），新代码只是按固定字符串分支；`sandboxResourceLimitReason` 只用计划里的上限和已校验的观测值，未引入新的注入面。
- **安全/资源耗尽**：输出上限仍在两个通道的 data 回调里强制执行，且只接受未越限的前缀；截断后记失败是安全的。未发现可绕过上限的新路径。
- **不可撤销操作**：`verified_effect` 的写入只有在 `verifyPiWriteEvidence` 通过时才记 `verified`，上限路径没有放宽这个检查；不过 after-exit 且写入证据本身被截断时会抛 `PI_WRITE_EVIDENCE_INVALID`，这是既有行为，不是本次新增。
- **规则/文档一致性**：`prompt-prefix.md` 不受影响；但事故表和提交说明把 `not_asserted` 写成了输出丢失场景的预期，违反 `sandbox-execution-v2` 的规范，见问题 4。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动只影响 sandbox 执行结果的 `result`/`effect` 和原因码，最终作为新的工具结果追加在消息末尾；系统提示、工具定义、历史消息和遮盖逻辑都没有改。按 `.claude/rules/prompt-prefix.md` 第一节第 2、3 条和第二节第 4 条，发给模型的内容仍然只在末尾追加。每轮可能变化的值（原因码、输出、既有 `occurredAt`）都在这条追加的工具结果里，没有挪进请求头。

2. **同一段文字会不会在不同请求里变成不同字节？**
   本次改动没有引入新的每请求可变值。`limitTermination` 只在执行时由 `outcome.reason` 和 `outcome.resources` 算一次，随后随 facts 持久化；`SANDBOX_OUTPUT_LIMIT` 等是固定枚举，输出摘要来自持久化的字节。既有的 `occurredAt: clock.now()` 仍在 `resultFields` 里，是结果的一部分、随事实存下，不是每次请求重新生成。未发现新的遮盖子串、时间字段或无序集合问题。注意：前提是后续投影使用持久化的 facts；如果别的调用方每轮重新用实时观测算原因码，需要另外核对，这一点我没有查到这样的调用方。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有，但不完整。`sandbox-v2-worker-lifecycle` 的 after-exit 用例在回退 result 改动后会因 `kind:"result"` 而失败；`sandbox-execution-v2` 的 `bounded failure disclosure SANDBOX_OUTPUT_LIMIT` 在从 `isSandboxBoundedToolFailure` 去掉该码后会因 `deliverToolResult:false` 而失败。但 worker 用例的 journal 是 mock，不调用 `validateSandboxExecutionFacts`，所以它测不出 effect 非法；它甚至把非法的 `not_asserted` 写成了期望。SRT 那半边没有任何用例。结论：反向用例能证明 result 和投影层，但不能证明这次改动实际产出的 facts 能通过后端校验（这正是 I-73 说的「只看改动本身不够」）。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   - `SANDBOX_OUTPUT_LIMIT`：已被 `isSandboxBoundedToolFailure`（`packages/execution-contracts/src/sandbox-execution-v2.ts:317-321`）、投影层、`apps/control-center/src/execution-view.ts:378` 及 en/ja/zh-CN 的 `chat.reason.toolOutputLimit`、`apps/agent-service/src/production-sandbox-tool-result.ts:124` 接受；测试清单新增项也一致。
   - `SANDBOX_CPU_TIME_LIMIT`/`SANDBOX_MEMORY_LIMIT`/`SANDBOX_RESOURCE_LIMIT`：同样已在使用方接受。
   - **`effect.kind = "not_asserted"`：不被接受。** 产生方 `production-sandbox-execution-v2.ts:910-911` 在 failure 终止时写它，使用方 `sandbox-execution-v2.ts:634-643` 的校验会抛错，SQLite append/recordOperation 在 `sqlite-sandbox-execution-operations.ts:1523` 调用这个校验，`projectSandboxExecution` 在 `sandbox-execution-projection.ts:126` 也会调用。这是本次改动两端不一致的核心。
   - `effect.kind = "unknown"` 是合法替代，容器路径和投影测试都用它。
