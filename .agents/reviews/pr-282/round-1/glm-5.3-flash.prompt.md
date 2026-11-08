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
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 cb389961f2f43a377b663ffb134ffa5eeabe2ea3。
对比基准是 f0478c4de46347f87e23ff4d131e26f4c7f41d13，先运行 git diff f0478c4de46347f87e23ff4d131e26f4c7f41d13..cb389961f2f43a377b663ffb134ffa5eeabe2ea3 看改动。
作者的说法（可能有错，请核对）：
# PR #282 代码复核材料

## 问题

生产第二十六版里，一个对话轮次停在「结果未确认」，页面上的停止按钮一直转，要到这一轮开始后约 31 分钟的「原始期限」（`plan.originalDeadlineAt`）才收尾。

已核对的事实（都有代码或生产只读记录为依据）：

1. 那条命令是被本项目自己的资源监视器按 CPU 时间或内存上限杀掉的：`packages/runtime-sandbox/src/resource-observer.ts` 的 `stopTask("resource_limit")`。
2. 改动前，两条 v2 执行路径（`apps/execution-worker/src/production-sandbox-execution-v2.ts` 里的 SRT 任务环境路径和本机 job host 路径）只把 `deadline`、`output_limit` 当明确失败，`resource_limit` 落进 `kind: "unknown", reasonCode: "SANDBOX_EXIT_UNKNOWN"`。
3. 旧的执行路径 `apps/execution-worker/src/product-job-host.ts` 一直把 `output_limit`、`resource_limit` 当失败。
4. 「结果未知、沙箱已释放、有释放回执、有输出结束记录」的轮次会被 `packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts` 的 `SANDBOX_TOOL_RESULT_RECOVERY_SQL` 预判成「可以恢复」，于是 `listClaimable` 把它列为 `resume_tool_result` 候选。
5. 真去恢复时，`apps/agent-service/src/production-sandbox-stream.ts` 的 `recover` 对终止原因属于 `cancelled`、`output_limit`、`resource_limit`、`host_failure` 的输出结束记录返回 `null`（代码里叫 `unrecoverable`）；`apps/agent-service/src/production-sandbox-lost-result-recovery.ts` 要求 `isSandboxExecutionFenceSuperseded`（只有服务重启后才成立）；所以同一次启动内结果找不回，`apps/agent-service/src/production-tool-result-recovery.ts` 的 `known` 为假，静默 `continue`。
6. 同一个文件里的 `RUN_EXPIRED_RECONCILIATION_SQL` 第一条分支要求 `NOT (${SANDBOX_TOOL_RESULT_RECOVERY_SQL})`，所以「结果未知提前结算」这条路因为它「可以恢复」而不做。两边互相等。
7. 还有第三道锁没在本 PR 修：这一轮如果同时有一次失败的模型调用，预算账户被记成 `reconcile_required`，`listClaimable` 和 `RUN_EXPIRED_RECONCILIATION_SQL` 都会排除这一轮。那是另一件事的方案。

## 目标

- 终止原因明确时不要记成「结果未知」，要给模型一个明确的失败结果，并写明超了哪一项、本次允许的上限是多少。
- 结果确实找不回的轮次要在几秒内收尾（以「结果未确认」结束、运行状态 `failed`、停止按钮停转），而不是等原始期限。
- 不能抢掉「迟到结果恢复」：还能恢复的轮次必须照旧恢复。

## 约束

- 发给模型的内容只能往后追加（`.claude/rules/prompt-prefix.md`）：系统提示和工具定义里不得出现每轮会变的值。
- 界面上给用户看的每个判断词都要有可验证的定义和门槛。
- 数值不得写死，要从这条命令实际生效的资源上限读。
- 不写代码注释。
- 快速模式：第 0 层定向测试 + `npm run check` + `npm run build`。

## 作者的说法

本 PR 两个提交：

- `0ece1a64`：`resource_limit` 和 `output_limit`、`deadline` 一样记成明确失败，三个原因码 `SANDBOX_CPU_TIME_LIMIT`、`SANDBOX_MEMORY_LIMIT`、`SANDBOX_RESOURCE_LIMIT` 由 `sandboxResourceLimitReason(ceiling, observed)` 按实际越界的那一项选取；副作用仍标 `unknown`，因为命令可能已经改过工作区。给模型的说明由 `sandboxResourceLimitMessage(reasonCode, ceiling)` 生成，上限数值从 `plan.resourceCeiling` 读。两条执行路径都改了（SRT 路径按 `outcome.reason`，job host 路径按新增的 `boundedTermination`）。界面按新原因码加了中、日、英三语文案。
- `cb389961`：`production-tool-result-recovery.ts` 在尝试过恢复、结果仍不是 `result`/`error` 时，为这次执行写一条 `sandbox-tool-result-unrecoverable:<invocationId>` 的 `purpose='trace'` 痕迹记录（先 `lookup`，已存在就不重写）；`SANDBOX_TOOL_RESULT_RECOVERY_SQL` 的「结果未知」分支新增 `NOT EXISTS` 排除带这条记录的执行。于是下一次调度把这一轮列为需要核对，`settleExpired` 以 `RUNTIME_TOOL_RESULT_UNKNOWN` 收尾。

作者认为需要重点核对的地方（不是结论，只是作者自己的疑虑）：

- 那条痕迹记录的写入时机是否可能过早，把本来还能恢复的轮次挡掉。
- `boundedTermination` 插进 job host 路径那条很长的三元表达式后，与 `completionContradicted`、`authenticatedDeadline`、`authenticatedNotStarted`、`latest.facts.result?.kind === "started"` 的优先级是否正确，`effect` 分支是否自相矛盾。
- SQL 里用字符串拼接 `'sandbox-tool-result-unrecoverable:'||json_extract(result.plan_json,'$.identity.invocationId')` 是否可靠（空值、索引、与 `sandboxUnrecoverableResultOperationKey` 是否一致）。
- 新增原因码在产生它的地方和使用它的地方两端是否都能接受（契约校验、界面文案、`isSandboxBoundedToolFailure`）。
