你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 17556568926206a0ee052f04b6b2e8754939afb5。
对比基准是 2995d5359933f8a57e974c61a2de9c9eb5e5d469，先运行 git diff 2995d5359933f8a57e974c61a2de9c9eb5e5d469..17556568926206a0ee052f04b6b2e8754939afb5 看改动。
上一轮复核到 668e62bf6fa47e957b64b9f8f62b5bbb9b9dda20，先看 git diff 668e62bf6fa47e957b64b9f8f62b5bbb9b9dda20..17556568926206a0ee052f04b6b2e8754939afb5 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 282 第 6 轮代码复核材料

## 这个 PR 在修什么

生产上一轮对话停在「结果未确认」，要等这一轮的原始期限（约 31 分钟）才收尾，停止按钮一直转。根因是三道互相等待的锁，这个 PR 修其中两道，加上同一类的「输出过多」，第三道（预算账户被记成 `reconcile_required`）另出方案。

## 这一轮（第 6 轮）要复核的改动

第 5 轮给了五条意见，线程逐条核对后全部成立并处理完；Andy 看过第 5 轮结果后定「再跑一轮复核」。这一轮复核的就是第 5 轮之后的两个提交，`origin/main` 没有变化。

### 一、第 5 轮 R5-1（高）：任一上限越过时，副作用一律记成未知

第 4 轮之后线程把「上限在进程自己退出之后才越过」的副作用写成了 `not_asserted`，理由是「命令确实自己跑完了」。第 5 轮指出这是非法状态，线程核对后确认成立：

- `packages/execution-contracts/src/sandbox-execution-v2.ts` 的 `validateSandboxExecutionFacts`：`effect.kind === "not_asserted"` 要求 `normalExit`（`result.kind === "result" && completion.type === "exit"`，或 `result.kind === "error" && termination.type === "exit"`），否则 `fail("missing normal result cannot weaken effects")`。有界失败写的是 `termination: { type: "failure" }`，所以这个组合非法。
- `packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts`：每次 `append`／`recordOperation` 都调用这个校验（`operationOnly` 时不传上一份事实），`fail()` 直接抛 `ContractValidationError`。所以那条「明确失败」在生产上根本写不进去，重试后仍失败，这一轮还是挂到原始期限。
- `docs/execution/specs/2026-09-07-srt-unified-execution-design.md` 第 235 行：「中断、输出丢失、必需后置条件缺失不能降为 not_asserted」。

改法：`apps/execution-worker/src/production-sandbox-execution-v2.ts` 本机前台路径的 `effect` 分支里，把 `boundedTermination` 提到 `knownExit` 之前，任一上限越过时一律记 `{ kind: "unknown", reasonCode: boundedTermination }`，和容器路径、SRT 路径一致。`fixed_read` 的 `not_applicable` 仍排在最前面（那条合法：固定读取本来就没有用户可见的副作用）。

### 二、第 5 轮 R5-2（中）：假日志接上契约校验

`test/integration/sandbox-v2-worker-lifecycle.test.ts` 的假 `payloads.sandboxExecution` 原来在 `append`／`operation` 时直接 `facts = command.facts`，从不调用契约校验，于是 R5-1 那个非法状态被写成了测试的预期值。现在改成和 `test/integration/sandbox-v2-container-route.test.ts` 一样调用 `validateSandboxExecutionFacts`（`append` 传上一份事实、`operation` 不传，与 SQLite 层一致），返回值作为新的事实；两条 after-exit 用例的期望改成 `{ kind: "unknown", reasonCode }`。

反向验证（实测）：把 `effect` 的分支顺序改回去，`[I-84] output-limit-after-exit` 和 `[I-84] resource-limit-after-exit` 以 `missing normal result cannot weaken effects` 失败，2 条失败、34 条通过；改好后 36 条全过。

### 三、第 5 轮 R5-5（低）：给模型的说明和界面文案改准

`packages/runtime-sandbox/src/job-host-main.ts` 里标准输出和标准错误共用一个 `total` 计数器，合计越过上限就 `stop("output_limit")`；而交给模型的产物只有标准输出（本机路径 `result.stdout`、SRT 路径 `outcome.stdout`，两处都只累计 `channel === "stdout"` 的字节）。所以「标准输出已经收完、标准错误把合计顶过上限」时模型拿到的标准输出其实是完整的；上限在进程自己退出之后才越过时，命令也不是被终止的。原来的说明两处都说得太绝对。

改法：`apps/agent-service/src/production-sandbox-tool-result.ts` 的输出上限分支改成「命令的输出（标准输出和标准错误合计）超过上限，已停止接收并完成清理……它可能已经修改了工作区，交给你的输出可能已被截断」；中、日、英三语的 `chat.reason.toolOutputLimit` 从「已终止并完成清理」改成「已停止接收并完成清理」。门槛：`apps/agent-service/test/production-runtime-tools.unit.test.ts` 的 `[I-84] tells the model the output a command may produce and that what came back is cut short` 加了 `toContain("可能已被截断")`、`toContain("标准输出和标准错误合计")` 和反向 `not.toContain("已被终止")`。

### 四、第 5 轮 R5-3、R5-4（低）：更正不实的说法

- R5-3：原来的提交说明写「SRT 路径同样会把截断输出当成成功结果」，不实。`packages/runtime-sandbox/src/job-host-session.ts` 的 IPC 校验有 `(exitCode !== null && message["reason"] !== "exited")` 一条，产出端 `job-host-main.ts` 也写 `exitCode: commandReason === "exited" ? command.exitCode : null`，所以 SRT 路径的 `knownExit`（要求 `outcome.exitCode !== null`）和上限不可能同时成立。那条缺陷只在本机前台路径上成立（本机的 `finish()` 无条件带 `exitCode: task?.exitCode ?? null`）。SRT 路径的 `limitTermination` 重排保留，因为它和改动前的尾部分支在可达输入上等价，只是让三条路径的优先级写法一致。
- R5-4：`docs/incidents-and-gates.md` 的 I-84 行原来写「这两种情况下副作用保持 `not_asserted`，因为命令确实自己跑完了」，已改成「必须记成未知」，并写明校验器会拒绝、生产每次写入都会调用它、这两条用例的假日志现在也调用它。未覆盖一栏补了标准错误合计那条差距。

### 五、没有采纳的意见

R4-4（把 `thread-execution-projection.ts` 和 `thread-execution-state.ts` 各存一份的 `SAFE_TOOL_REASON_CODES` 抽成共享导出）线程建议采纳，但要动另外两个服务文件的结构，超出已批准的范围，列给 Andy 等他定，不在这个 PR 做。

## 这一轮请重点看

1. `effect` 分支的新顺序有没有把本来合法的状态改错：特别是 `verified_effect` 契约在上限越过时从 `verified` 变成 `unknown` 是否正确，以及 `fixed_read` 仍走 `not_applicable` 是否合法。
2. 三条路径（本机、容器、SRT）现在产出的 `result`／`effect` 组合是否都能通过 `validateSandboxExecutionFacts`，有没有别的组合仍然非法。特别是 `authenticatedNotStarted`、`completionContradicted`、`fileFailure` 这些分支和上限越过叠加时。
3. 假日志接上契约校验之后，有没有哪条原有用例的期望其实也是非法状态、只是恰好没被触发到。
4. 给模型的新说明是否准确、可操作；是否还有别的地方（界面、回执、投影）仍在声称输出一定被截断或命令一定被终止。
5. 整个 PR 作为一个改动，还有没有「测试绿了但生产写不进去」这一类两端不一致的地方。
