# PR 282 第 5 轮逐条判断

模型：`opencode-go/deepseek-v4.1-flash`（经 Magpie 路由，实际服务方 OpenDesign；CodeBuddy 预检失败被丢弃，见账本 `dropped=workbuddy-ai`）。本轮费用 0.0867 美元，本 PR 累计 0.7556 美元。

本轮复核的提交是 `668e62bf`，增量基准是第 4 轮复核过的 `4b4347aa`，其间只有 `085e85b4` 一个提交加上合并进来的 `origin/main`（`2995d535`）。

这一轮是 Andy 2026-11-08 看过第 4 轮结果后说「同意」再跑的一轮。

## R5-1【高】上限在进程自己退出之后越过时，副作用写成了契约不允许的组合 —— 成立，已修

模型原话见 `deepseek-v4.1-flash.md` 的「1. 高」一节。

线程逐条核对（都是自己打开文件读的）：

- `packages/execution-contracts/src/sandbox-execution-v2.ts` 的 `validateSandboxExecutionFacts`：`effect.kind === "not_asserted"` 时要求 `normalExit`，也就是 `result.kind === "result" && completion.type === "exit"` 或者 `result.kind === "error" && termination.type === "exit"`，否则 `fail("missing normal result cannot weaken effects")`。有界失败写的是 `termination: { type: "failure" }`，所以这个组合确实非法。
- `apps/execution-worker/src/production-sandbox-execution-v2.ts`：`result` 的分支把 `boundedTermination` 排在 `knownExit` 之前（第 4 轮的改动），但 `effect` 的分支仍是 `knownExit && ["command", "network_only"] → not_asserted` 在前、`boundedTermination → unknown` 在后。于是 after-exit 的上限越过会同时产出 `error/failure` 和 `not_asserted`。
- `packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts`：每次 append／recordOperation 都调用这个校验（`operationOnly` 时不传上一份事实）。`fail()` 直接抛 `ContractValidationError`，不是可忽略的标记。所以这条「明确失败」在生产上根本写不进去。
- `docs/execution/specs/2026-09-07-srt-unified-execution-design.md` 第 235 行：「中断、输出丢失、必需后置条件缺失不能降为 `not_asserted`」。输出被截断就是输出丢失。第 4 轮之后我自己写的「命令确实自己跑完了，副作用维持 `not_asserted`」违反这条规范，是错的。

改法：`effect` 的分支里把 `boundedTermination` 提到 `knownExit` 之前，任一上限越过时一律记 `{ kind: "unknown", reasonCode }`，和容器路径、SRT 路径一致。`fixed_read` 的 `not_applicable` 仍排在最前面（那条合法，而且固定读取本来就没有用户可见的副作用）。

反向验证（实测）：把 `effect` 的分支顺序改回去，`[I-84] output-limit-after-exit` 和 `[I-84] resource-limit-after-exit` 两条以 `missing normal result cannot weaken effects` 失败，`2 failed | 34 passed`；改好后 36 条全过。

## R5-2【中】假日志不跑契约校验，把非法状态写成了预期值 —— 成立，已修

模型原话见「2. 中」一节。

核对：`test/integration/sandbox-v2-worker-lifecycle.test.ts` 的假 `payloads.sandboxExecution` 在 `append`／`operation` 时直接 `facts = command.facts`，从不调用 `validateSandboxExecutionFacts`；同仓库的 `test/integration/sandbox-v2-container-route.test.ts` 则调用了。这正是 R5-1 能一路漏到第 5 轮的原因：门槛不但没拦住，还把非法状态当成期望断言下来。

改法：假日志改成和容器路径测试一样调用 `validateSandboxExecutionFacts`，`append` 传上一份事实、`operation` 不传（和 SQLite 层的调用一致），返回值作为新的事实；两条 after-exit 用例的期望改成 `{ kind: "unknown", reasonCode }`。这道门槛就是 R5-1 的硬门槛。

## R5-3【低】「SRT 路径同样会把截断输出当成功」这个说法不实 —— 成立，改说明，代码保留

模型原话见「3. 低」一节。

核对：`packages/runtime-sandbox/src/job-host-session.ts` 的 IPC 校验里有 `(exitCode !== null && message["reason"] !== "exited")` 一条，产出端 `packages/runtime-sandbox/src/job-host-main.ts` 也写 `exitCode: commandReason === "exited" ? command.exitCode : null`。SRT 路径的 `knownExit` 要求 `outcome.exitCode !== null`，所以 `reason` 是 `output_limit`／`resource_limit` 时 `knownExit` 必为假。模型说得对：那条路径本来就会记成失败，第 4 轮把 `limitTermination` 挪到前面不改变任何可达行为。

本机前台路径不同：`finish()` 发出的 `result` 消息无条件带 `exitCode: task?.exitCode ?? null`，所以 `reason: "output_limit"` 和 `exitCode: 0` 同时出现是可达的——第 4 轮 R4-3 那条缺陷只在本机路径上成立。

处置：代码保留。改动前那两支 `output_limit`／`resource_limit` 尾部分支和现在的 `limitTermination` 在可达输入上完全等价，不是新增的不可达分支，只是让三条路径的优先级写法一致。改的是说明：提交说明和 PR 说明里「SRT 路径同样的问题」的说法已更正。

## R5-4【低】事故表把非法状态写成了设计意图 —— 成立，已修

模型原话见「4. 低」一节。和 R5-1 是同一个错误的文档面。事故表那一行原来写「这两种情况下副作用保持 `not_asserted`，因为命令确实自己跑完了」，已改成「必须记成未知」，并写明 `validateSandboxExecutionFacts` 会以 `missing normal result cannot weaken effects` 拒绝这种组合、生产的 SQLite 日志每次写入都会调用它、这两条用例的假日志现在也调用它。

## R5-5【低，模型标「推测」】说明声称输出已被截断，但标准输出可能是完整的 —— 成立，已改说明并加反向断言

模型原话见「推测 / 未核实」一节第一条。

核对：`packages/runtime-sandbox/src/job-host-main.ts` 里标准输出和标准错误共用一个 `total` 计数器，越过上限就 `stop("output_limit")`；而交给模型的产物只有标准输出（本机路径用 `result.stdout`，SRT 路径用 `outcome.stdout`，两处的 `stdout` 都只累计 `channel === "stdout"` 的字节）。所以「标准输出已经收完、标准错误把合计顶过上限」时，模型拿到的标准输出其实是完整的；after-exit 的情况下命令也不是被终止的。原来的说明两处都说得太绝对。

改法（小改）：给模型的说明改成「命令的输出（标准输出和标准错误合计）超过上限，已停止接收并完成清理……交给你的输出可能已被截断」，不再声称命令被终止；三语界面文案同样改成「已停止接收并完成清理」。门槛：`apps/agent-service/test/production-runtime-tools.unit.test.ts` 的 `[I-84] tells the model the output a command may produce and that what came back is cut short` 加了 `toContain("可能已被截断")`、`toContain("标准输出和标准错误合计")` 和反向 `not.toContain("已被终止")`。

要真正区分「标准输出是否真的被截断」，需要在 job host 协议里多报一个合计字节数，那是协议改动，另出方案；差距记进事故表的未覆盖。

## 其余「未核实」项的处置

- **`resource-limit-after-exit` 在真实 job host 上是否可达**：资源观察器在 `exited` 回调里就 `observer?.stop()`，所以这个时序比输出上限少见；但 `finish()` 仍然无条件带上 `reason` 和 `exitCode`，而且这条分支和输出上限共用同一段代码，留着用例是为了锁住两种上限的处理一致。保留，不改。
- **「去掉被测改动后 after-exit 用例报错」只证明 result 方向**：模型说得对，而这正是 R5-2 修掉的——假日志现在跑契约校验，所以同一条用例也能证明 effect 方向（实测报的就是 `missing normal result cannot weaken effects`）。
- **必答问题一、二（会不会改变模型已经见过的请求开头）**：模型的结论和线程一致。本轮改动只影响工具结果的 `result`／`effect` 和给模型的说明文字，都是每轮追加在最后的工具结果；系统提示、工具定义、历史和遮盖逻辑都没有动，`npm run check:prompt-prefix` 通过。
