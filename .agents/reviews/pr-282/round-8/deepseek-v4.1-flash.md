## 结论

未发现高、中危问题。第 8 轮增量（`43416c71` 账本 + `dd7dea4d` 合并）是一次干净的并集：以 `01873f5c`（main）为基准，合并结果只多出本 PR 的 60 个文件改动；以 `43416c71`（分支）为基准，只多出 main 的 197 个文件改动。两边都改过的 8 个文件逐个核对，未发现丢改动或方向相反的回退。下面只有低危/提示级观察。

## 问题（读代码证实，按严重度）

### 低 — `apps/agent-service/src/production-sandbox-tool-result.ts:163`

**问题：** 给模型报内存上限时按十进制除以 `1_000_000` 并标成 `MB`，main 把生效上限提到 `1 GiB` 后，模型会看到「内存 1073.7 MB」；数值本身没错（1 GiB≈1073.7 MB），但与仓库/文档里统一称的 1 GiB 口径不一致，且没有任何用例把生产常量送进这段文案。

**证据：**
- `apps/agent-service/src/production-sandbox-tool-result.ts:153-163`：`limitBytes(value)` 用 `value >= 1_000_000 ? ... / 1_000_000 ... MB`；`const limits = ... 内存 ${limitAmount(ceiling.maxMemoryBytes / 1_000_000)} MB`。
- `packages/execution-contracts/src/sandbox-memory-limit.ts:1`：`export const SANDBOX_TOOL_MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024;`
- 所有文案用例都用 256 MiB 或 1 MB 的假值，例如 `apps/agent-service/test/production-runtime-tools.unit.test.ts:518` 用 `maxMemoryBytes: 268_435_456`，没有用 `SANDBOX_TOOL_MEMORY_LIMIT_BYTES` 断言文案。

**建议：** 若要继续用十进制单位，保持现状即可；若希望与「1 GiB」一致，改成 `/ (1024 * 1024)` 并标注 `MiB`，并加一条用 `SANDBOX_TOOL_MEMORY_LIMIT_BYTES` 的文案断言，防止单位口径再漂移。

### 提示 — `test/tooling/safe-tool-reason-codes.test.mjs:20-24`

**问题：** 这份「两份白名单必须一致」的检查只显式断言了 `SANDBOX_CPU_TIME_LIMIT` 和 `SANDBOX_OUTPUT_LIMIT`；如果将来有人只从两份文件里同时删掉 `SANDBOX_MEMORY_LIMIT`、`SANDBOX_RESOURCE_LIMIT`，这条测试仍会通过。它防的是「只改一份」，不是「四个码都在」。

**证据：** 文件里只有
`expect(state).toContain("SANDBOX_OUTPUT_LIMIT");`
`expect(state).toContain("SANDBOX_CPU_TIME_LIMIT");`
随后只做 `expect(codes("thread-execution-projection.ts")).toEqual(state);`。

**建议：** 低风险。`packages/application/test/thread-execution-state.unit.test.ts:49-52` 已逐个覆盖四个码，整体门槛不缺口；若想让这条检查自洽，可改成断言四个码全部存在。

### 提示 — `packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:23-24`

**问题：** 写入端用 `sandboxUnrecoverableResultOperationKey(invocationId)` 生成完整键，查询端用 `sandboxUnrecoverableResultOperationKey("") || json_extract(...)` 拼出同一个键。今天两端一致，但这依赖「该函数只是 `前缀 + invocationId`」这一隐含约定；若将来给它加后缀、改分隔符，SQL 会静默对不上。

**证据：**
- 写：`apps/agent-service/src/production-tool-result-recovery.ts` 的 `const operationKey = sandboxUnrecoverableResultOperationKey(record.plan.identity.invocationId);`
- 查：`... operation_key='${sandboxUnrecoverableResultOperationKey("")}' ||json_extract(result.plan_json,'$.identity.invocationId')`
- `packages/execution-contracts/src/sandbox-execution-v2.ts` 当前定义为 `` `sandbox-tool-result-unrecoverable:${invocationId}` ``。

**建议：** 可接受为现状；若想更稳，给 SQL 一个「只取前缀」的显式常量，或在契约里补注释说明该函数必须是「前缀 + 原样 id」。现有 `stream-candidate-unrecoverable` 用例会覆盖两端不一致的情况，风险不高。

## 推测 / 未核实

- 作者列出的「162 个文件 3051 条全过」、`npm run lint/typecheck/check:*` 全过、`validate_docs.py` 仍是 main 原有 11 条错误：我只有 read/grep/glob 和只读 git，无法跑测试和脚本，均**未核实**。
- `usage.jsonl` 的实际内容无法核对：仓库钩子对 `.agents/reviews/pr-282/usage.jsonl` 直接拒绝 `git show`，工作树里也没有该文件，只能确认 `43416c71` 的改动只有这一个文件、提交说明与作者叙述一致；账本里四条 R7 finding 的 `from/head` 是否正确**未核实**。
- `docs/incidents-and-gates.md` 三行表格的列数我没有逐字符数（read 对超长行会截断）；但 `git diff` 显示 I-89、I-86 是 main 原样带进来的行，I-84 未改动，且 `check:incident-gates` 的重复 id、状态、门槛路径规则在代码里可见，合并没有触碰这些行。

## 侧重检查

- **错误路径**：看了 `sandboxResourceLimitReason`（观测为 `null` 时回退 `SANDBOX_RESOURCE_LIMIT`，`packages/execution-contracts/src/sandbox-execution-v2.ts:283-286`）、`sandboxCeilingExceededMessage`（未知原因返回 `null`，`production-sandbox-tool-result.ts:166-173`）、`sandboxFailureKeepsOutput`（上限原因一律不保留输出，`production-sandbox-tool-result.ts:135-145`）、`markUnrecoverable` 的前置条件（前台、已释放、无 result/error、进程已退出、终止原因在不可恢复集合）。未发现会误把可恢复轮次判成不可恢复的路径；`loss-unverified`、`loss-stream-exited` 两条反向用例确实断言「不写记录、不提前结算」。
- **不可信/异常输入**：新的 `reasonCode` 来自 worker 内部枚举，`resourceCeiling` 来自持久化的 plan；`production-worker-parent-binding-registry.ts:188-190` 用 `positiveSafeInteger` 校验三个上限，job host 协议要求 `maxCpuTimeMs/maxMemoryBytes` 是安全正整数（`packages/runtime-sandbox/src/job-host-protocol.ts:105-118`），1 GiB 通过。`SandboxToolCompletion.resourceCeiling` 只是通过受保护的 JSON artifact 回读（`production-runtime-tools.ts:2276-2289`），不是用户输入。
- **安全**：SQL 里只插值了一个编译期常量前缀，调用参数是空串，没有用户可控内容拼进 SQL；不可恢复标记以 `dataClassification: "public"` 写入固定常量；上限文案不含秘密。顺带看了 main 带进来的改动：`thread-execution-projection.ts` 移除了 `redactTracePayload`，但 `session-trace-recorder.ts:73-75` 仍在写入 trace 时遮盖，这是 main 的有意改动，不是本 PR/合并引入的回退。
- **资源耗尽**：1 GiB 现在由 `SANDBOX_TOOL_MEMORY_LIMIT_BYTES` 一处定义，`service-main.ts:1342`、`production-worker-composition.ts:263` 和签名清单 `cloud-seal.mjs:380`（`1073741824`）一致；observer/job host 实际用的是 `plan.resourceCeiling.maxMemoryBytes`，与文案读的是同一个值。上限文案长度固定且很短，不构成新的耗尽面。
- **不可撤销操作**：`markUnrecoverable` 会写永久标记并让轮次提前失败，是本 PR 最「不可撤销」的行为；条件限定为「输出结束且进程已退出、终止原因属于 `cancelled/output_limit/resource_limit/host_failure`、没有已存结果/错误」，并有六种组合的直接用例和两个反向场景，未发现会误标的漏洞。
- **规则/文档/代码一致**：I-84 行描述的 `limitTermination`、`isSandboxUnrecoverableTermination`、两份 `SAFE_TOOL_REASON_CODES`、`sandbox-tool-result-unrecoverable:` 键、三语文案都与代码对得上；`docs/lessons.md` 记录的「只输出」提示词标记问题在当前文案里已改成「请缩小输出范围后重试」。I-89/I-86 的门槛文件都存在。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。以 main `01873f5c` 为基准，合并结果只多出本 PR 的改动；与提示词相关的那部分是「工具结果内容」——`sandboxCeilingExceededMessage` 的返回值，只会作为一条工具结果追加在末尾，没有改系统提示、工具定义或历史消息。每轮会变的值（本次上限）只出现在这条末尾工具结果里，且来自持久化的 `plan.resourceCeiling` / completion 回执，不是系统提示或工具定义中的时间、路径、额度。依据：`.claude/rules/prompt-prefix.md#rules` 第 3、4 条。
需要说明的一点：`production-runtime-tools.ts:2105` 在回执没有 `resourceCeiling` 时会回退到当前 `ceiling`；生产中所有上限失败都会带 `completion.resourceCeiling`（`production-sandbox-tool-result.ts:389-391`），且该值来自持久化 plan，所以同一历史消息重放时字节稳定。这是读代码推断，不是用真实请求回放验证的。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会由本改动引入。上限文案只取决于 `reasonCode` 和本次生效的上限，没有时间戳、随机数、无序集合；数值来自持久化 plan/回执，重放时相同。main 带进来的 `externalTag` 也不是每请求随机：`packages/application/src/services/model-egress.ts:524-526` 由稳定的 `options.key()` 推出，属于既有的「遮盖密钥不变则字节相同」规则。唯一理论上的变化源是遮盖密钥轮换或配置在首次投递与重算之间改变，但那不是本次合并新增，且生产回执已把上限固化。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有，且反向用例是真的断言反例：
- 上限分类：`packages/execution-contracts/test/sandbox-bounded-failure.unit.test.ts` 断言非 `error`/非 `failure` 终止方式不算有界失败。
- 原因码选择：同文件 `sandboxResourceLimitReason` 覆盖 CPU、内存、观测缺失、两者都在限内。
- 前端原因词与三语文案：`apps/control-center/test/execution-view.unit.test.ts` 四个码映射；`apps/control-center/test/i18n-runtime.unit.test.ts` 禁止三语出现「已终止/terminated/停止と後処理」。
- 结果保留：`apps/agent-service/test/production-sandbox-tool-result.unit.test.ts` 四个上限码都断言 `sandboxFailureKeepsOutput` 为 `false`，普通 fixed_read 失败为 `true`。
- 提前结算：`test/integration/sqlite-sandbox-execution-v2.test.ts` 的 `loss-unrecoverable` 断言写标记并 `failed`，`loss-unverified` / `loss-stream-exited` 反向断言不写标记、不提前结算；`stream-candidate-unrecoverable` 断言带标记后不再列为可恢复。
- 两份白名单一致：`test/tooling/safe-tool-reason-codes.test.mjs`（但见上面的「提示」）。
- 合并本身没有专门用例，依赖 `check:incident-gates`（重复 id/格式/门槛路径）与 `check:markdown-tables`；I-84/I-89/I-86 各出现一次、门槛路径存在。测试是否实际全绿我未运行，**未核实**。

**4. 每个新值/字段，所有使用它的地方都能接受吗？**
逐个核对了：
- `SANDBOX_TOOL_MEMORY_LIMIT_BYTES`：生产方 `execution-contracts`；使用方 `service-main.ts:1341-1343`、`production-worker-composition.ts:263`、签名清单 `cloud-seal.mjs:380`；校验方 `positiveSafeInteger` 与 job-host 协议；1 GiB 是安全整数，两端接受。
- 四个原因码：生产方 `apps/execution-worker/src/production-sandbox-execution-v2.ts`；使用方 `isSandboxBoundedToolFailure`、两份 `SAFE_TOOL_REASON_CODES`、`execution-view.ts` 映射、三语 `message-ids.ts`/资源文件；校验方 `machineString` 与 `validateSandboxExecutionFacts`（`error` + `failure` + `unknown`/`not_applicable` 合法），没有枚举白名单会拒绝它们。
- `resourceCeiling` 字段：生产方 `production-sandbox-tool-result.ts:389-391`；使用方 `production-runtime-tools.ts:2103-2106`；持久化走 `#writeJson`/`#saveRecoveryJson` 的通用 JSON，`#readJson` 按 `Partial<SandboxToolCompletion>` 回读，不会被 schema 丢字段。
- `sandbox-tool-result-unrecoverable:<invocationId>`：写入端 `production-tool-result-recovery.ts`，查询端 `sqlite-sandbox-tool-result-recovery.ts:20-24`，两端由同一个 helper/同一 invocationId 产生，今天一致。
- i18n 键：`message-ids.ts` 与 zh-CN/en/ja 三份资源都加了同样四个键，`i18n-runtime` 用例逐语言、逐键检查。
结论：未发现「测试绿了但生产写不进去」的两端不一致；上面「低」的单位口径问题不影响写入，只影响模型看到的数字表述。
