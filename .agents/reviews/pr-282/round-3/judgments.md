# PR #282 复核第 3 轮：线程逐条判断

第 3 轮只跑 DeepSeek。复核对象 `38f567ec`，增量基线 `72b2f07f`。模型只读代码、没有运行测试。
机器可读的同一份结论在 `verdicts.jsonl`。四条全部成立：一条中、三条低。按 Andy 定的「最多三轮」，这一轮结果交他定。

## R3-1【中】SRT 任务环境和容器路径的「输出过多」仍然挂到原始期限

**成立，而且我按代码逐步核实过。** 这是改动前就有的行为，不是本 PR 引入，但它和第 2 轮我自己回退的那条是同一类。

- `apps/execution-worker/src/production-sandbox-execution-v2.ts:1841-1845`（`runInSrtEnvironment`）：`outcome.reason === "output_limit"` → `result: failure("SANDBOX_OUTPUT_LIMIT")`、`effect: { kind: "unknown", reasonCode: "SANDBOX_OUTPUT_LIMIT" }`。
- 同文件 `1230-1237`（容器路径）：`completed.truncated` → 同样的 `error` 加 `SANDBOX_OUTPUT_LIMIT`。
- `packages/execution-contracts/src/sandbox-execution-v2.ts` 的 `isSandboxBoundedToolFailure` 不含 `SANDBOX_OUTPUT_LIMIT`。
- `packages/application/src/services/sandbox-execution-projection.ts:194`：`settled` 需要 `effectKnown`，而 `effect.kind === "unknown"`，所以 `settled` 为假；`boundedFailure` 也为假，于是 `disclosureAllowed` 为假、`canRecoverResult` 为假、`deliverToolResult` 为假。结果交付不出去。
- `apps/agent-service/src/production-tool-result-recovery.ts:167,176`：写排除记录要求结果不是 `result`/`error`，而这里是 `error`，所以不写；`known` 反而为真，这一轮被当成「有结果」继续认领。
- `packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts`：`SANDBOX_TOOL_RESULT_RECOVERY_SQL` 的第一条分支就是 `json_extract(result.facts_json,'$.result.kind') IN ('result','error')`，为真；于是 `RUN_EXPIRED_RECONCILIATION_SQL` 第一条分支的 `NOT (...)` 为假，提前结算不触发。只能等 `originalDeadlineAt`。

**没修，交 Andy 定。** 两条路可走，但两条都超出他批准的范围（他批的是「资源上限记成明确失败」，没有提「输出过多」）：

1. 把这两条路径的 `output_limit` 也退回「结果未知」，和本机路径一致，由新的排除记录在几秒内收尾。改动很小，但这个容器里没法给 SRT 产生端加用例：`test/integration/production-srt-task-environment.test.ts` 用的是真实进程，要真正跑出超量输出才会走到那个分支，和 SRT 资源上限用例缺口是同一个原因。
2. 把 `SANDBOX_OUTPUT_LIMIT` 正式做成有界失败，配模型文案、界面原因词和三语文案。这是行为改动，按 Andy 的长期规则要先出方案。

I-83 行的「未覆盖」已经把这两条路径的现状和这两种改法写进去了（R3-4）。

## R3-2【低】`resourceCeiling` 的覆盖没有自动检查

**成立。** 现有用例的 completion 根本没有 `resourceCeiling`，所以把 `completion.resourceCeiling ?? ceiling` 改回 `ceiling` 也能过。

**已改**，补了两条，正反都验过：

- `apps/agent-service/test/production-runtime-tools.unit.test.ts` 的 `[I-83] states the limit that stopped this command, not the limit in force now`：completion 带 7.5 秒 / 134.2 MB，工具当前上限是 12.5 秒 / 268.4 MB，断言文案用前者、且不含后者。改回 `ceiling` 就报 `expected 'SANDBOX_CPU_TIME_LIMIT：命令使用的 CPU 时间超过…' to contain 'CPU 时间 7.5 秒'`。
- `test/integration/sqlite-sandbox-execution-v2.test.ts` 的 `[I-83] records the ceiling in force for this command only on a resource-limit failure`：三个资源上限原因码的回执带 `resourceCeiling` 且等于计划里的上限，`SANDBOX_OPERATION_FAILED` 的回执不带。改成无条件写入就报 `expected { outcome: 'failed', …(4) } to not have property "resourceCeiling"`。

## R3-3【低】授权判断不写记录这一条没有测试

**成立，但没修。** `createProductionToolResultRecovery` 目前在仓库里没有任何单测夹具（只被 `production-run-composition.ts` 用），补这条用例要从零搭 checkpoint 存储、trace 存储、冻结的执行输入 artifact 和 artifact 端口四套东西，不是小改动，放在三轮复核的末尾不合适。

模型自己在第五节也核对过行为上没有缺口：授权判断只在 `request.knownToolResult` 存在时走这条，而「已知结果」本来就不满足写记录的条件（写记录要求结果不是 `result`/`error`）。所以现在缺的是回归保护，不是正确性。列给 Andy 定要不要单独补。

## R3-4【低】事故行让人以为只有本机路径有问题

**成立。已改**：I-83 行的「未覆盖」现在分别写了本机 job host 路径（记成「结果未知」、由排除记录提前收尾、`[I-83] output-limit` 守住）和 SRT／容器路径（记成 `error` 但交付不出去、恢复层当成已知结果、仍挂到原始期限），并写明两种改法等 Andy 定。

## 模型确认过没有问题的部分

- 不会改变模型已经见过的请求开头：没有改系统提示、工具定义或提示词目录；新增文字只是追加的工具结果 `modelContent`；重放先读已存的结果，不改写历史；新原因码只进界面展示集合。
- 新增文字的字节确定：只依赖固定原因码和 `plan.resourceCeiling`，观测值只用来选常量原因码；`sandbox-execution-plan.ts:129-132` 只缩小 `maxWallTimeMs`，不动 CPU 和内存上限。
- 第 2 轮六条修改逐条核对：第 1 条回退成立，第 3 条反向用例确实能抓住「把 `exited` 加进不可恢复集合」，第 4 条只在资源上限失败时填 `resourceCeiling`、没有别的路径因此回落到错误上限，第 5 条调度器那条路的覆盖没有丢，第 6 条和 `recover` 的合法性条件一致。
- 新值的产生端和使用端逐个点过，三个资源上限原因码没有遗漏的白名单；排除记录的 operationKey 两端一致；`taskProcessExited` 在流终止 schema 里本来就有。
