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
仓库就是当前目录，已检出 38f567ec04427be68145f67b8345b16f19b8e716。
对比基准是 7073268ff3be50367938fa766cc13c0098f2d792，先运行 git diff 7073268ff3be50367938fa766cc13c0098f2d792..38f567ec04427be68145f67b8345b16f19b8e716 看改动。
上一轮复核到 72b2f07f4667bef3fc2811d3e9af6c2058360160，先看 git diff 72b2f07f4667bef3fc2811d3e9af6c2058360160..38f567ec04427be68145f67b8345b16f19b8e716 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR #282 代码复核材料（第 3 轮，按第 2 轮意见修改之后）

## 问题

生产第二十六版里，一个对话轮次停在「结果未确认」，页面上的停止按钮一直转，要到这一轮开始后约 31 分钟的「原始期限」（`plan.originalDeadlineAt`）才收尾。

已核对的事实（都有代码或生产只读记录为依据）：

1. 那条命令是被本项目自己的资源监视器按 CPU 时间或内存上限杀掉的：`packages/runtime-sandbox/src/resource-observer.ts` 的 `stopTask("resource_limit")`。
2. 改动前，`apps/execution-worker/src/production-sandbox-execution-v2.ts` 的两条 v2 前台执行路径不一样：SRT 任务环境路径把 `deadline` 和 `output_limit` 当明确失败；本机 job host 路径只把 `deadline` 当明确失败，`output_limit` 和 `resource_limit` 都落进 `kind: "unknown", reasonCode: "SANDBOX_EXIT_UNKNOWN"`。
3. 旧的执行路径 `apps/execution-worker/src/product-job-host.ts` 只是把观察结果标成失败，job 仍落成 `quarantined`、worker 的结果层仍是 `result_unknown`。
4. 「结果未知、沙箱已释放、有释放回执、有输出结束记录」的轮次会被 `packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts` 的 `SANDBOX_TOOL_RESULT_RECOVERY_SQL` 预判成「可以恢复」，于是 `listClaimable` 把它列为 `resume_tool_result` 候选。
5. 真去恢复时，`apps/agent-service/src/production-sandbox-stream.ts` 的 `recover` 对终止原因属于 `cancelled`、`output_limit`、`resource_limit`、`host_failure` 的输出结束记录返回 `null`；`production-sandbox-lost-result-recovery.ts` 要求 `isSandboxExecutionFenceSuperseded`（只有服务重启后才成立）；所以同一次启动内结果找不回，`production-tool-result-recovery.ts` 的 `known` 为假，静默 `continue`。
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

## 这一轮要看的增量

`--previous` 是 `72b2f07f`（第 2 轮复核的那个提交）。这一轮只有一个提交，内容是第 2 轮六条意见的修改。六条我都判为成立。

1. **【中】本机路径把「输出过多」记成失败，反而堵住新加的提前收尾。** 我在上一个提交里按「同类一起修」把 `output_limit` 一起映射成 `SANDBOX_OUTPUT_LIMIT` 的 `error`，但 `isSandboxBoundedToolFailure` 不含这个原因码，所以投影的 `disclosureAllowed` 为假、交付不出去；同时 `production-tool-result-recovery.ts` 的 `known` 只看 `kind` 是 `result`/`error`，于是它被当成「有结果」列为认领候选、新加的排除记录也不会写。改法：把 `output_limit` 从本机路径的 `boundedTermination` 里去掉，恢复成改动前的「结果未知」。它本来就在 `SANDBOX_UNRECOVERABLE_TERMINATION_REASONS` 里，所以现在由第二处改动的排除记录在几秒内收尾——比改动前（等原始期限）好。把 `SANDBOX_OUTPUT_LIMIT` 正式做成有界失败（配模型文案、界面原因词、三语文案）是行为改动，留给主人定。
2. **【中低】事故行把两条路径说成一样。** I-83 行分开写了两条路径，并在「未覆盖」里写明 `SANDBOX_OUTPUT_LIMIT` 仍不在有界失败和界面白名单里。
3. **【低】反向用例没真正覆盖「可恢复的终止原因」。** `loss-unverified` 返回 false 是因为 `termination === null`，不是因为终止原因可恢复。补了集成变体 `loss-stream-exited`（终止原因 `exited`、退出码 0），以及一条参数化用例直接驱动 `sandboxStreamResultUnrecoverable`，覆盖六种组合。
4. **【低】重放路径用的是当前上限，不是这条命令生效的上限。** `SandboxToolCompletion` 增加可选的 `resourceCeiling`，只在失败原因属于资源上限原因码时填 `plan.resourceCeiling`；`#completionOutcome` 用 `completion.resourceCeiling ?? ceiling` 生成说明。只在资源上限失败时填，是为了不改动其它失败回执的字段集合。
5. **【低】授权判断里也会写排除记录。** 恢复准备接受 `{ recordUnrecoverable: false }`，`authorizeAuthorityChange` 传它，只判断、不写记录；调度器照旧写。
6. **【低】判定没有校验进程是否真的结束。** `sandboxStreamResultUnrecoverable` 加上 `termination.taskProcessExited`，和 `recover` 的合法性条件一致。

先红后绿的证据（这一轮新增的两处）：

- 集成变体 `loss-stream-exited`：把 `exited` 加进不可恢复集合 → `expected { count: 1 } to deeply equal { count: +0 }`
- 参数化用例 `[I-83] only treats a stream termination that can never yield a result as unrecoverable`：同样的改动 → `expected true to be false`
- `[I-83] output-limit`：断言本机路径的「输出过多」仍是 `kind: "unknown"`、`reasonCode: "SANDBOX_EXIT_UNKNOWN"`、且不是有界失败

`workspaceBlocked` 没有做成集成变体，因为 `RUN_RESOURCES_RELEASED_SQL` 要求这一轮没有未释放的工作区占用或栅栏，带占用的执行根本进不了恢复候选，所以用参数化用例直接盖住这个守卫。

判为「低」或「可以更好」、仍然没改的：幂等护栏的并发竞争（最终收敛）；写记录失败会让这一轮继续等原始期限（下一次调度会重试）；`SANDBOX_OUTPUT_LIMIT` 没有模型文案和界面原因词（既有行为）；SRT 路径的资源上限产生端用例还没有；说明里只写上限不写实际用量。

请重点核对：第 1 条的回退是否真的让「输出过多」走通新的提前收尾、有没有留下别的半成品；第 4 条只在资源上限原因码下填 `resourceCeiling`，会不会让别的路径读不到它而回落到当前上限；第 5 条把写记录从授权判断里拿掉之后，调度器那条路是否仍然覆盖到全部该写的情况；以及这些改动会不会改变模型已经见过的请求开头。
