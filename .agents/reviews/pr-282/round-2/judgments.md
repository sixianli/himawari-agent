# PR #282 复核第 2 轮：线程逐条判断

第 2 轮只跑 DeepSeek（第 2 轮起的默认）。复核对象 `72b2f07f`，增量基线 `cb389961`。模型只读代码、没有运行测试。
机器可读的同一份结论在 `verdicts.jsonl`。六条全部成立，一条中、一条中低、四条低，所以这一轮没过，按意见修改后再跑第 3 轮。

## R2-1【中】本机路径把「输出过多」记成失败，反而堵住新加的提前收尾

**成立，而且是我自己在第一个提交里按「同类一起修」加出来的半成品。** 我按模型给的链条逐个读过：

- `apps/execution-worker/src/production-sandbox-execution-v2.ts` 的 `boundedTermination` 是我这个 PR 新加的，里面连 `output_limit` 一起映射成 `SANDBOX_OUTPUT_LIMIT` 的 `error`；改动前本机 job host 路径的「输出过多」落进 `kind: "unknown", reasonCode: "SANDBOX_EXIT_UNKNOWN"`。
- `packages/execution-contracts/src/sandbox-execution-v2.ts` 的 `isSandboxBoundedToolFailure` 不含 `SANDBOX_OUTPUT_LIMIT`。
- `packages/application/src/services/sandbox-execution-projection.ts:204-216`：`boundedFailure` 为假时，`disclosureAllowed` 只能靠 `settled && !needsReconciliation`，而这条路径的 `resource.cleanup` 是 `unknown`，`needsReconciliation` 为真，所以不交付。
- `apps/agent-service/src/production-sandbox-tool-result.ts:286`：`if (!projection.deliverToolResult) return undefined;`，调用方把 `undefined` 当 `result_unknown`。
- `apps/agent-service/src/production-tool-result-recovery.ts` 的 `known` 只看 `kind` 是不是 `result`/`error`，于是这条 `error` 被当成「有结果」列为认领候选，同时因为结果已经是 `error`，新加的排除记录不会写，SQL 也不会排除它。

也就是说这一改让「输出过多」从「能被新机制几秒收尾」变成「有结果却交付不出去」的来回。

**已改**：把 `output_limit` 从本机路径的 `boundedTermination` 里去掉，恢复成改动前的「结果未知」。
`output_limit` 本来就在 `SANDBOX_UNRECOVERABLE_TERMINATION_REASONS` 里，所以它现在由第二处改动的排除记录在几秒内收尾——比改动前（等原始期限）好，也不留半成品。
把 `SANDBOX_OUTPUT_LIMIT` 正式做成有界失败（配模型文案、界面原因词、三语文案）是行为改动，不在这个 PR 的范围里，列给 Andy 定。

**门槛**：`test/integration/sandbox-v2-worker-lifecycle.test.ts` 新增 `[I-83] output-limit`，断言本机路径的「输出过多」仍是 `kind: "unknown"`、`reasonCode: "SANDBOX_EXIT_UNKNOWN"`、且不是有界失败。

## R2-2【中低】事故行把两条路径说成一样

**成立。** I-83 行原来写「v2 执行路径只把『超时』和『输出过多』记成失败结果」，但那只对 SRT 任务环境路径成立，本机 job host 路径连「输出过多」也落进「结果未知」。

**已改**：I-83 行分开写两条路径，并在「未覆盖」里写明 `SANDBOX_OUTPUT_LIMIT` 仍不在有界失败和界面白名单里、本机路径的「输出过多」照旧记成「结果未知」并由排除记录收尾、把它做成明确失败等 Andy 定。

## R2-3【低】反向用例没真正覆盖「可恢复的终止原因」

**成立。** `loss-unverified` 根本没有写输出结束记录，判定返回 false 是因为 `termination === null`，不是因为终止原因可恢复。

**已改**，补了两处：

- 集成变体 `loss-stream-exited`：写一条终止原因为 `exited`、退出码 0 的结束记录，断言不写排除记录、不提前结算。把 `exited` 加进不可恢复集合它就失败（`expected { count: 1 } to deeply equal { count: +0 }`）。
- 参数化用例 `[I-83] only treats a stream termination that can never yield a result as unrecoverable`，直接驱动 `sandboxStreamResultUnrecoverable`，覆盖六种组合：`resource_limit` 为真；`exited` 为假；进程没结束为假；非前台为假；`workspaceBlocked` 为假；没有结束记录为假。同样的改动它也报 `expected true to be false`。

`workspaceBlocked` 没有做成集成变体，因为 `RUN_RESOURCES_RELEASED_SQL` 要求这一轮没有未释放的工作区占用或栅栏，带占用的执行根本进不了恢复候选，所以用上面的参数化用例直接盖住这个守卫。

## R2-4【低】重放路径用的是当前上限，不是这条命令生效的上限

**成立。** `production-runtime-tools.ts` 的重放路径把当前算出来的 `ceiling`（配置与 capability 上限的较小值）传给 `#completionOutcome`，而配置或 capability 上限变大后，这个值就不是杀掉这条命令的那个上限。违反「数值从本次生效的资源上限读」。

**已改**：`SandboxToolCompletion` 增加可选的 `resourceCeiling`，在 `production-sandbox-tool-result.ts` 构造失败 completion 时填 `plan.resourceCeiling`；`#completionOutcome` 用 `completion.resourceCeiling ?? ceiling` 生成说明。三个调用点都因此拿到这条命令自己的上限。
第一版把这个字段无条件填进每个失败回执，`test/integration/sqlite-sandbox-execution-v2.test.ts` 里 60 个用 `toEqual` 断言回执整体形状的既有用例因此全红。改成只在失败原因属于资源上限原因码（`isSandboxResourceLimitReason`）时才填：说明只在这时候用得到它，别的失败回执字段集合不变。

## R2-5【低】授权判断里也会写排除记录

**成立。** `production-run-composition.ts` 的 `authorizeAuthorityChange` 会调用 `prepareToolResultRecovery` 来判断延续授权是否一致，而这个函数现在带持久化副作用。记录内容本身仍只在决定性证据下写成，所以不会写错；但把不可逆写操作放进判断里语义不对。

**已改**：恢复准备接受一个 `{ recordUnrecoverable: false }`，`authorizeAuthorityChange` 传它，只判断、不写记录；调度器照旧写。

## R2-6【低】判定没有校验进程是否真的结束

**成立。** `sandboxStreamResultUnrecoverable` 原来只看终止原因；而 `recover` 对「进程没结束」这类不完整记录是抛 `SANDBOX_STREAM_TERMINATION_INVALID`，不是返回 null。没有配置 `recoverMissingResult` 的组装可能仅凭一份不完整的结束记录写永久记录。

**已改**：判定加上 `termination.taskProcessExited`（和 `recover` 的合法性条件一致；终止记录只在 `chunk.end` 为真时写入，所以 `end` 不需要另判）。上面那条参数化用例里「进程没结束 → 为假」就是它的门槛。

## 模型确认过没有问题的部分

- 不会改变模型已经见过的请求开头：新增的模型可见文字只有工具结果的 `modelContent`，提示词目录没有新增这些原因码。
- 新增文字的字节确定：只依赖原因码和上限，`toFixed(1)` 与 locale 无关（R2-4 修掉了重放时上限来源可能不同的那一点）。
- 排除记录的 operationKey 两端一致，SQLite 里 `||` 优先级高于 `=`。
- `sandboxResultUnrecoverable` 经组装确实接到了生产代码（它逐个文件行号核对过）。
- 写记录失败时 `production-run-dispatcher.ts` 会捕获并 `continue`，下一次调度重试，不会打挂 pump。
- `packages/persistence-sqlite` 本来就依赖 `@himawari-agent/execution-contracts`，新的 import 不破坏分层。
