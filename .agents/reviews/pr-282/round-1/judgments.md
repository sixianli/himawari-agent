# PR #282 复核第 1 轮：线程逐条判断

两个模型都只读代码、没有运行测试。下面每条都写了我自己核对的结果和依据（文件加行号按 `cb389961`，修改后的行号以当前分支为准）。
机器可读的同一份结论在 `verdicts.jsonl`。事故编号从 I-81 改为 I-83：`origin/main`（7073268f）上的 I-81 是另一件事故（上线被 `S6_ACCEPTANCE` 拦下），I-82 由另一个线程占用。

## 会出错（中、高）

### G1 / D2 标记写得太早，会抢掉以后真能成功的恢复

**成立。** 两个模型各自提出，我读代码核实：

- `apps/agent-service/src/production-tool-result-recovery.ts` 原来的条件只看「bound + foreground + 有释放回执 + supervision=released + 结果不是 result/error」，不看这一次恢复为什么没成功。
- `production-sandbox-stream-result-recovery.ts:53-55`：`if (deadline && options.now() < plan.effectiveDeadlineAt) return record;`、`if (deadline && !(await options.verifyExited(record))) return record;` —— 这两种都是「这一次先不动」，不是「永远找不回」。
- `production-sandbox-lost-result-recovery.ts:35-46`：fence 没被超越、`workspaceBlocked`、`verifyExited` 为假时同样原样返回。
- `production-sandbox-file-recovery.ts:36-41`：`workspaceBlocked` 时原样返回。
- 原来的代码还在没有配置 `recoverMissingResult` 时也写记录（`production-tool-result-recovery.ts:149-155` 才尝试恢复）。

这正是 Andy 长期规则里点名过的那类错误（「让『结果未知』的轮次提前收尾，会抢掉『迟到结果恢复』」）。

**已改**：只有拿到决定性证据才写记录。决定性证据是输出结束记录（`sandbox-stream-end:*`）的终止原因属于永远恢复不了的那几种
（`cancelled`、`output_limit`、`resource_limit`、`host_failure`，即 `production-sandbox-stream.ts` 的 `recover` 判为不可重建、永远返回 null 的那一组），
并且不是 `workspaceBlocked`。这一组常量提到了 `packages/execution-contracts`（`SANDBOX_UNRECOVERABLE_TERMINATION_REASONS`），`recover` 和新判定共用一份。

**反向用例**：集成测试 `loss-unverified`（退出没核实、没有输出结束记录）必须不写记录、不提前结算，运行状态停在 `reconciling_external_result`；
`loss-unrecoverable`（同样没核实退出，但有一条终止原因为 `resource_limit` 的输出结束记录）必须写记录并在下一次调度以 `failed` 收尾。
两条都验证过先红后绿：把判定改成恒真，`loss-unverified` 失败（`expected { count: 1 } to deeply equal { count: +0 }`）；把写记录去掉，`loss-unrecoverable` 失败（`expected { count: +0 } to deeply equal { count: 1 }`）。

### D1 标记范围比能提前结算的范围大

**成立。** 恢复入口接受四种诊断码（`production-tool-result-recovery.ts:83-90`），但提前结算只认 `RUNTIME_TOOL_RESULT_UNKNOWN`
（`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:53`、`apps/agent-service/src/production-run-expiry.ts:72`）。
给另外三种写记录，只会把它们从认领里摘掉而不能提前结算，反而更糟。

**已改**：只在 checkpoint 的诊断码是 `RUNTIME_TOOL_RESULT_UNKNOWN` 时写记录。另外三种保持原来的行为（照旧等原始期限），没有退步；
这一点写进了 I-83 行的「未覆盖」。把提前结算扩大到另外三种属于新的行为改动，不在这个 PR 的范围里。

### D3 新原因码到不了界面

**成立。** 界面显示原因词的前提是 trace 里有 `runtime.tool_reason.<code>`，而这条记录只在 `SAFE_TOOL_REASON_CODES.has(code)` 时生成
（`packages/application/src/services/thread-execution-projection.ts:442`），两个 SAFE 集合里都没有三个新码。
我原来的说法「界面按新原因码加了三语文案」只做了映射和文案，没打通入口。

**已改**：三个新码加入 `thread-execution-state.ts` 和 `thread-execution-projection.ts` 两个集合；
`packages/application/test/thread-execution-state.unit.test.ts` 的白名单用例和 `apps/control-center/test/execution-view.unit.test.ts` 新增的 `[I-83]` 用例分别守住投影和文案两端。

### G3 / D4 产生端没有测试

**成立。** 本次 diff 的测试原来只覆盖纯函数和消费端，worker 两条前台路径把 `resource_limit` 写成 `error` 的接线没有任何用例。

**已改一半，另一半仍缺**：`test/integration/sandbox-v2-worker-lifecycle.test.ts` 新增 `[I-83] resource-limit`（有观察值 → `SANDBOX_CPU_TIME_LIMIT`）
和 `[I-83] resource-limit-unobserved`（没有观察值 → `SANDBOX_RESOURCE_LIMIT`），断言记录的结果是 `error`、`effect` 仍为未知、并且是有界失败；
把那个分支去掉两条都失败（`expected { …(8) } to match object { kind: 'error', …(2) }`）。事故发生的就是这条本机 job host 路径。
SRT 路径的同类用例还没有：那套 harness 跑真实的 SRT 运行时和真实进程，要让它真的越过 CPU 上限才能走到那个分支，构造成本高。
这一条列给 Andy 决定是否现在补。

### D5 `fixed_read` 绕过新说明

**成立。** 资源上限失败对 `fixed_read` 仍会保留 `outputRef`（`production-sandbox-tool-result.ts:342-352`），
`#completionOutcome` 于是先返回原始输出（`production-runtime-tools.ts:2123-2133`），新说明根本不会被调用。

**已改**：把那段条件抽成 `sandboxFailureKeepsOutput`，并在其中排除三个资源上限原因码（和 deadline、not_started 一样）；
`apps/agent-service/test/production-sandbox-tool-result.unit.test.ts` 新增 `[I-83]` 正反两条用例。

### D6 / G2 / D8 上限用例抓不到写死；事故行有不实之处

**成立。** 夹具的 `maxCpuTimeMs: 1000`、`maxMemoryBytes: 1000000` 算出来都是 1，所以把文案写死成「1 秒、1 MB」也能过。
事故行里点名的 `stream-candidate-unrecoverable` 用例确实不存在：`git grep stream-candidate-unrecoverable cb389961 -- test/` 没有任何命中，
当时实际加的只有 `loss-unverified`。「实际用了多少」也只写在文档里，代码只输出上限。

**已改**：用例改用 12.5 秒 / 268.4 MB 这样的非整数上限并断言精确文案，还加了一条「不得出现夹具那两个 1 的组合」的反向断言；
补上 `stream-candidate-unrecoverable` 用例（带着记录的轮次不再被列为可以恢复，去掉 SQL 的 `NOT EXISTS` 它就失败）；
I-83 行删掉「实际用了多少」。把实际用量也告诉模型属于「可以更好」，列给 Andy。

## 会出错（低）

### G8 幂等护栏的并发竞争

**成立，低。** 先 `lookup` 再 `commit`，两个准备并发时第二个 `commit` 会撞唯一键抛错，这一次准备作废；下一轮 `lookup` 命中后跳过，最终收敛。
和既有 `sandbox-tool-result-lost` 的写法相同，是暂态，不改。

### D9 一个 Run 内每个符合条件的执行都写记录

**成立，低。** 标记在遍历 `inventory.admissions` 的循环里，没有按当前候选的 invocationId 过滤。
改成「只有输出结束记录证明永远找不回才写」之后，每条记录对它自己的那个执行都是真的，所以不会误判；
范围仍比「这一次在等结果的执行」宽，属于多写一条很小的 trace，先不改。

### D10 写记录失败会把轮次拖回原始期限

**成立，低。** 写记录在恢复路径上同步执行，抛错时这一次准备失败、记录没写成，提前结算这一轮仍被挡住。
但下一次调度会重新尝试，不是永久状态，和任何一次写失败一样；不改。

## 可以更好（只列，等 Andy 定）

见给 Andy 的汇报。G4（`SANDBOX_OUTPUT_LIMIT` 没有模型文案和界面原因词）、G5（同一个三元里连续求值两次，本轮顺手改了）、
G6（SQL 里的前缀字符串和常量函数是两份事实，本轮顺手改成从常量生成）、G7（对 `boundedTermination` 优先级的正面确认，无需改动）、
D7（`output_limit` 不在有界失败列表里，所以我原来说它「和 deadline 一样」不准确，已更正措辞；要不要把它也列为有界失败等 Andy 定）、
D11（旧执行路径只在观察层算失败，job 落成 `quarantined`、worker 结果层仍是 `result_unknown`，已按此更正 I-83 行和 PR 描述）。

## 两个模型确认过没有问题的部分

- 只在末尾追加：新说明是这一轮的工具结果本身，不动系统提示、工具定义和已存历史；上限数值只出现在这条新消息里。两个模型都读代码确认。
- 同一段文字的字节确定：说明只取决于原因码和这次执行冻结的资源上限，没有时间戳、没有无序集合。
- SQL 的 `NOT EXISTS` 走 `run_payload_artifacts` 主键，`json_extract` 为 NULL 时拼接结果为 NULL、`=` 恒假，不会误排除。
- `boundedTermination` 的分支优先级和 `effect`/`result` 的配对没有自相矛盾。
