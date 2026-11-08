# PR 282 第 4 轮逐条判断

模型：`opencode-go/deepseek-v4.1-flash`（经 Magpie 路由，实际服务方 OpenDesign；CodeBuddy 预检失败被丢弃，见账本 `dropped=workbuddy-ai`）。本轮费用 0.1749 美元，本 PR 累计 0.6689 美元。

本轮复核的提交是 `4b4347aa`，增量基准是第 3 轮复核过的 `38f567ec`。

## R4-1【中】投影层没有「输出过多真的交付出去」的门槛 —— 成立，已修

模型原话见 `deepseek-v4.1-flash.md` 第 5-21 行。

核对：`test/integration/sandbox-execution-v2.test.ts:930-938` 的 `describe.each` 确实是唯一直接驱动 `projectSandboxExecution(...).deliverToolResult` 的用例，列了 `SANDBOX_CPU_TIME_LIMIT`、`SANDBOX_MEMORY_LIMIT`、`SANDBOX_RESOURCE_LIMIT`，没有 `SANDBOX_OUTPUT_LIMIT`。这个 PR 的核心主张就是「容器和 SRT 路径的输出过多由挂住改为可交付」，而这条主张在投影层没有用例。属于「本轮核对中确认的错误缺了能证明它的测试用例」。

改法：把 `"SANDBOX_OUTPUT_LIMIT"` 加进那个列表。反向验证：从 `isSandboxBoundedToolFailure` 去掉这个码，`bounded failure disclosure SANDBOX_OUTPUT_LIMIT` 的三条（read／write／shell）都失败，报 `expected { conclusion: 'failed', …(11) } to match object { conclusion: 'failed', …(3) }`。

## R4-2【低】事故表引用的门槛路径已过期 —— 成立，已修

模型原话见第 23-30 行。

核对：`4b4347aa` 把白名单一致的用例从 `packages/application/test/thread-execution-state.unit.test.ts` 挪到了 `test/tooling/safe-tool-reason-codes.test.mjs`（因为 `check:boundaries` 不许 application 包 import `node:fs`），事故表那一行还写着旧路径。`scripts/check-incident-gates.mjs` 只检查反引号里的文件存在，而旧文件确实还存在，所以这道门槛发现不了。

判低的理由：按事故表去找这道门槛的人会在旧文件里找不到它，可能误以为门槛缺失而重复加一遍；但它不会让人把功能做错，正确位置一次 grep 就能找到。模型也判低。

改法：事故表改成新路径，并把 `projects only allowlisted tool failure reasons` 一并写明，另外把本轮新增的三道门槛（投影层交付、两条 `knownExit` 用例）补进那一行。

## R4-3【低，模型标「推测」→ 线程改判中、高】上限在进程自己退出之后越过时，截断输出会被当成成功结果 —— 成立，已修

模型原话见第 32-53 行。模型自己给的严重度是「低，推测」，说「生产上是否会发生该时序属于推测，我没有复现」。**线程改判为中、高**，理由是这条时序按代码就是可达的，而且后果是给模型一个错误结果：

- `packages/runtime-sandbox/src/job-host-main.ts:685`：输出上限是在 stdout 的 data 回调里判断的（`if (chunk.byteLength > available) launch.outputLimit()`），`outputLimit` 走 `stop("output_limit")`（第 748 行）。
- 同文件第 762-765 行：`exited` 在子进程 'exit' 时就置真。Node 的 'exit' 先于 'close'，两者之间管道里缓冲的 stdout 仍会继续派发，所以「进程已退出、输出还在排空时越过上限」是正常时序，不是罕见竞态。
- 同文件第 301-316 行：`finish()` 发出的 `reason` 是 `"output_limit"`，同时 `exitCode: task?.exitCode ?? null`（这里是 0）、`taskStarted`、`taskProcessExited`、`stdioClosed` 全为真。
- 于是 worker 里 `knownExit`（第 773-777 行）为真，改动前 `boundedTermination` 要求 `!knownExit` 便为 null，结果落到 `["command","network_only"].includes(kind) || exitCode === 0` 这一支，记成 `kind: "result"`、`completion: { type: "exit", exitCode: 0 }`——**截断的输出被当成完整的成功结果交给模型**。SRT 路径第 1830 行起的 `knownExit && outcome.exitCode !== null` 分支在 `output_limit`、`resource_limit` 两个分支之前，同样的问题。

这在改动前就存在，不是本轮引入；但本 PR 写明「输出过多一律明确失败」，这条路径让那句话不成立，而且它本身就是「给出错误结果」。

改法：两条路径都让上限终止优先于 `knownExit`。本机路径去掉 `boundedTermination` 的 `!knownExit` 条件；SRT 路径新增 `limitTermination`，排在 `knownExit` 分支之前。副作用的处理有意保持差别：上限是在进程自己退出之后才越过的（`knownExit` 为真）时，命令确实自己跑完了，副作用维持 `not_asserted`（和普通命令一样，这一轮当场结算、不走对账）；进程是被上限杀掉的，副作用仍是 `unknown`。

反向验证：把 `!knownExit` 和 `limitTermination` 改回去，`[I-84] output-limit-after-exit` 和 `[I-84] resource-limit-after-exit` 都报 `expected { …(9) } to match object { kind: 'error', …(2) }`。

## R4-4【可以更好】两份白名单靠解析源码核对，建议抽成共享导出 —— 成立，不改，列给 Andy

模型原话见第 55-64 行。

核对：`test/tooling/safe-tool-reason-codes.test.mjs:5-17` 确实按字符串定位 `const SAFE_TOOL_REASON_CODES = new Set([` 再按逗号切分，依赖两份文件保持同一种字面量写法；它能挡住「只改一份」，挡不住「两份都没加」。模型建议把这份清单抽成一个共享模块，两处 import，从结构上消掉重复。

判为「可以更好」的依据：这个建议不改变任何可观察行为，也不改变任何陈述的真假——两份清单现在内容相同（新门槛已证明），抽取只是把重复去掉。线程建议采纳，但它要动 `packages/application` 里两个服务文件的结构，不在 Andy 已批准的范围内，所以不在这个 PR 做，列给 Andy 定。

## 必答问题的回答

模型逐条回答在 `deepseek-v4.1-flash.md` 第 79-114 行，线程核对后同意：发给模型的请求开头没有变（新说明是追加的工具结果，不进系统提示和工具定义，`npm run check:prompt-prefix` 通过）；同一段文字的字节是确定的（固定模板加本次生效的上限数值，回执里记下了那个上限）；反向用例逐条验过；新产生的每个值的使用方都核对过。模型指出的两处缺口（投影层门槛、事故表路径）就是 R4-1 和 R4-2，已修。
