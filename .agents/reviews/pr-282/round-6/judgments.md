# PR 282 第 6 轮逐条判断

模型：`opencode-go/deepseek-v4.1-flash`（经 Magpie 路由，实际服务方 OpenDesign；CodeBuddy 预检失败被丢弃，见账本 `dropped=workbuddy-ai`）。本轮费用 0.0962 美元，本 PR 累计 0.8518 美元。

本轮复核的提交是 `17556568`，增量基准是第 5 轮复核过的 `668e62bf`，其间是 `7191db6d` 和 `17556568` 两个提交，`origin/main` 没有变化。

这一轮是 Andy 2026-11-08 10:45 说「再跑一轮复核」的那一轮。**没有高危问题**：模型确认 R5-1 的修法方向正确（本机路径现在和容器、SRT 路径一致，越界一律记 `unknown`），并逐条核实了线程在第 5 轮给出的 R5-3、R5-5 两处事实更正属实。

## R6-1【中】资源上限的文案仍声称「已被终止」 —— 成立，已修

模型原话见 `deepseek-v4.1-flash.md` 的「中：资源上限文案仍声称「已被终止」」一节。

核对：第 5 轮只改了输出上限那一支，`apps/agent-service/src/production-sandbox-tool-result.ts` 的资源上限分支仍无条件写「已被终止并完成清理」「它在终止前可能已经修改了工作区」，三语界面的 `toolCpuTimeLimit`、`toolMemoryLimit`、`toolResourceLimit` 也都是「已终止并完成清理」。而 `boundedTermination` 同时包含 `resource_limit`，本 PR 新增的 `[I-84] resource-limit-after-exit` 用例构造的正是 `exitCode: 0` 加 `reason: "resource_limit"`。

可达性线程自己读代码确认（模型标为推断）：`packages/runtime-sandbox/src/resource-observer.ts` 的 `sample()` 在 `await` 之后先判 `if (stopped) return;`，再同步地累加、比较上限、调 `stopTask("resource_limit")`，这几步之间 `observer.stop()` 插不进来（单线程）。所以「进程已 exit 之后观察器才报超限」不可能；但反过来是可能的：子进程已经自己结束、`'exit'` 事件还排在事件循环里没送达时，观察器这一次采样发现超限，`stop("resource_limit")` 先把 `reason` 置成 `resource_limit`，随后 `'exit'` 才到，`exited` 置真、`task.exitCode` 为 0，`'close'` 触发 `finish()`，而 `finish()` 无条件带 `exitCode: task?.exitCode ?? null`（`packages/runtime-sandbox/src/job-host-main.ts`）。于是 `reason: "resource_limit"` 加 `exitCode: 0` 是可达的，这时命令确实是自己跑完的，`killTask()` 打在一个已经没有的进程上。

改法：资源上限那一支改成「执行已结束并完成清理，没有重新执行。……它可能已经修改了工作区」，不再声称是我们终止的；三语的三个上限原因词改成「执行已结束并完成清理」／`execution has ended and cleanup is complete`／「実行は終了し、後処理は完了しています」。期限超时（`toolDeadlineExceeded`）不在本 PR 范围内，没有动。

门槛（实测）：`apps/agent-service/test/production-runtime-tools.unit.test.ts` 的 `[I-84] tells the model which resource limit stopped the command and what that limit is` 加了 `toContain("执行已结束并完成清理")`、`not.toContain("已被终止")`、`not.toContain("在终止前")`；把文案改回旧值，三条（CPU／内存／资源）全部失败，报 `expected 'SANDBOX_CPU_TIME_LIMIT：命令使用的 CPU 时间超过…' to contain '执行已结束并完成清理'`。

## R6-2【低】事故表里残留一句改前的说法 —— 成立，已修

模型原话见「低：docs 残留旧的「输出已被截断」说法」一节。

核对：I-84 行门槛一栏前半句还写着「输出上限还要说明拿到的输出已被截断」，后半句已经是「只说『可能已被截断』、不声称命令被终止」，同一格自相矛盾。已把前半句改成「交给模型的输出可能已被截断」。

## R6-3【低】「与 SQLite 层一致」这句话过头了 —— 成立，已修（并补齐了其中两项）

模型原话见「低：假日志校验并未真正「与 SQLite 层一致」」一节。

核对：`packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts` 的 `bind` 也调用契约校验，而假日志的 `bind` 分支原来直接 `facts = command.facts`；`operation` 在生产用的绑定环境是 `current.facts.environment`（已存记录里的那一份），假日志用的是 `command.facts.environment`，所以一个带了不同 `environment` 的 operation 在假日志里会放行、在生产会以 `frozen binding substituted` 被拒。`operationOnly` 在生产还另有「已知结果不可变」「verified 副作用不可变」「资源观察完全不变」三项检查。

改法：假日志的 `bind` 也调用 `validateSandboxExecutionFacts`，`append`／`operation` 的绑定环境改成取已存事实里的那一份（和生产一致），36 条用例仍全过；`operationOnly` 那三项额外检查没有复刻，事故表里把「与 SQLite 层一致」改成写明「在 `bind`、`append`、`operation` 三处都调用这个校验，绑定环境和生产一样取已存事实里的那一份」并明确列出没有复刻的那三项。

## R6-4【低】三语文案没有门槛护着 —— 成立，已修

模型原话见「低：三语界面文案改动没有自动检查」一节。

核对：`apps/control-center/test/i18n-runtime.unit.test.ts` 原来只查三语的键集合完整和 ICU 格式合法，`execution-view.unit.test.ts` 只查原因码到消息 id 的映射，没有任何断言管文案内容。把三处文案改回旧值，测试全绿。

改法：新增 `[I-84] never says a ceiling terminated the command, in any locale`——四个上限原因词（CPU、内存、资源、输出）在中、日、英三语里都不得出现「已终止」、`terminated`、「停止と後処理」，并且必须出现改后的说法。实测把 `zh-CN` 的 `toolResourceLimit` 改回旧值，报 `expected '命令超过资源上限，已终止并完成清理' not to contain '已终止'`。

## 模型列为「推测 / 需要确认」的三条处置

- **after-exit 资源上限在生产是否可达**：线程读代码确认可达，理由见 R6-1，所以那条用例不是在测产品不可能产生的状态。
- **`verified_effect` 在上限越过时从 `verified` 变成 `unknown`**：模型认为方向正确，线程同意并且这就是第 5 轮的改法——用于验证的标准输出本身可能被输出上限截断，「结果失败却声称副作用已核实」自相矛盾。代价是这类轮次保持 `needsReconciliation`、环境不复用，这是保守取舍。
- **`effect.kind === "unknown" && result !== null` 会进入 `listPending`**：对非 after-exit 的上限失败这本来就是现状，本轮只是把 after-exit 也纳入，没有新增形态。已按模型的建议把这个取舍写进事故表的未覆盖一栏。

## 本轮核对后仍不改的

R4-4（把 `thread-execution-projection.ts` 和 `thread-execution-state.ts` 各存一份的 `SAFE_TOOL_REASON_CODES` 抽成共享导出）线程建议采纳，但要动另外两个服务文件的结构，超出已批准的范围，继续列给 Andy 等他定。
