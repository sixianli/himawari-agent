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
仓库就是当前目录，已检出 72b2f07f4667bef3fc2811d3e9af6c2058360160。
对比基准是 7073268ff3be50367938fa766cc13c0098f2d792，先运行 git diff 7073268ff3be50367938fa766cc13c0098f2d792..72b2f07f4667bef3fc2811d3e9af6c2058360160 看改动。
上一轮复核到 cb389961f2f43a377b663ffb134ffa5eeabe2ea3，先看 git diff cb389961f2f43a377b663ffb134ffa5eeabe2ea3..72b2f07f4667bef3fc2811d3e9af6c2058360160 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR #282 代码复核材料（第 2 轮，按第 1 轮意见修改之后）

## 问题

生产第二十六版里，一个对话轮次停在「结果未确认」，页面上的停止按钮一直转，要到这一轮开始后约 31 分钟的「原始期限」（`plan.originalDeadlineAt`）才收尾。

已核对的事实（都有代码或生产只读记录为依据）：

1. 那条命令是被本项目自己的资源监视器按 CPU 时间或内存上限杀掉的：`packages/runtime-sandbox/src/resource-observer.ts` 的 `stopTask("resource_limit")`。
2. 改动前，两条 v2 前台执行路径（`apps/execution-worker/src/production-sandbox-execution-v2.ts` 里的 SRT 任务环境路径和本机 job host 路径）只把 `deadline`、`output_limit` 当明确失败，`resource_limit` 落进 `kind: "unknown", reasonCode: "SANDBOX_EXIT_UNKNOWN"`。
3. 旧的执行路径 `apps/execution-worker/src/product-job-host.ts` 只是把观察结果标成失败，job 仍落成 `quarantined`、worker 的结果层仍是 `result_unknown`（第 1 轮复核指出，我已核实并更正了上一轮材料里「旧路径一直当失败」的说法）。
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

`--previous` 是 `cb389961`（第 1 轮复核的那个提交）。在它之后有两个提交：一个把 `origin/main` 合进分支（只解决了 `docs/incidents-and-gates.md` 的事故表冲突），一个按第 1 轮的中、高「会出错」意见做修改。

第 1 轮两个模型提的、我判为成立并已修改的中、高意见，以及我这次的做法：

1. **标记写得太早（两个模型各自提出，最重的一条）。** 原来只要「这一次恢复没拿到结果」就写永久排除记录；而恢复链在「还没到生效期限」「退出未核实」「`workspaceBlocked`」「根本没配置恢复端口」这些暂时情况下也会原样返回。现在改成只有决定性证据才写：输出结束记录（`sandbox-stream-end:*`）的终止原因属于永远恢复不了的那几种，并且不是 `workspaceBlocked`。那一组常量提到了 `packages/execution-contracts` 的 `SANDBOX_UNRECOVERABLE_TERMINATION_REASONS`，`stream.recover` 和新判定共用一份；判定本身是 `production-sandbox-stream.ts` 的 `sandboxStreamResultUnrecoverable`，经 `production-sandbox-services.ts`、`service-main.ts`、`production-run-composition.ts` 作为 `resultUnrecoverable` 传进 `production-tool-result-recovery.ts`。
2. **标记范围比能提前结算的范围大。** 恢复入口接受四种诊断码，提前结算只认 `RUNTIME_TOOL_RESULT_UNKNOWN`。现在只在这一种下写记录，另外三种保持原行为（照旧等原始期限），这个差距写进了事故行的「未覆盖」。
3. **三个新原因码没进 `SAFE_TOOL_REASON_CODES`，界面拿不到原因词、新加的三语文案不可达。** 两个集合都加上了，并补了投影和文案两端的用例。
4. **产生端没有测试。** `test/integration/sandbox-v2-worker-lifecycle.test.ts` 新增 `[I-83] resource-limit` 和 `[I-83] resource-limit-unobserved` 两条，驱动真实的本机 job host 路径。SRT 路径的同类用例还没有（那套 harness 要真实运行时和真实越过 CPU 上限），这一条我留给主人决定是否现在补。
5. **`fixed_read` 绕过新说明。** 资源上限失败对 `fixed_read` 仍保留 `outputRef`，模型会拿到截断的原始输出。把那段条件抽成 `sandboxFailureKeepsOutput` 并排除三个资源上限原因码，补了正反用例。
6. **上限文案的用例夹具两个值都算成 1，写死「1 秒、1 MB」也能过。** 改用 12.5 秒 / 268.4 MB 并加了反向断言。
7. **事故行点名的 `stream-candidate-unrecoverable` 用例当时并不存在。** 已补上这条用例；事故编号从 I-81 改为 I-83（`main` 上的 I-81 是另一件事故，I-82 由另一个线程占用）；删掉「实际用了多少」这句代码没有实现的说法。

判为「低」或「可以更好」、这一轮没改的：幂等护栏的并发竞争（最终收敛）；一个 Run 内每个符合条件的执行都会写记录（改成决定性证据后每条记录对它自己的执行都成立）；写记录失败会让这一轮继续等原始期限（下一次调度会重试）；`SANDBOX_OUTPUT_LIMIT` 没有模型文案和界面原因词（既有行为）；要不要把 `output_limit` 也列为有界失败（行为改动，等主人定）。

先红后绿的证据（这一轮新增的四处）：

- `loss-unrecoverable`：去掉写记录 → `expected { count: +0 } to deeply equal { count: 1 }`
- `loss-unverified`（反向）：把判定改成恒真 → `expected { count: 1 } to deeply equal { count: +0 }`
- `stream-candidate-unrecoverable`：去掉 SQL 的 `NOT EXISTS` → `expected [ { …(11) } ] to deeply equal []`
- `[I-83] resource-limit` 两条：去掉 worker 的 `resource_limit` 分支 → 都报 `expected { …(8) } to match object { kind: 'error', …(2) }`

请重点核对：决定性证据这个判定是不是真的只在「永远找不回」时成立、有没有反过来漏掉本该提前收尾的情况；只在 `RUNTIME_TOOL_RESULT_UNKNOWN` 下写记录会不会让别的诊断码出现新的卡死；新加的判定经过那几层传递后在生产组装里是否真的接上了；以及这些改动会不会改变模型已经见过的请求开头。
