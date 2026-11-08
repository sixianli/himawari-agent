# 复核报告：PR #282（cb389961，基线 f0478c4d）

## 结论（按严重度排列）

### 1.【高】痕迹记录可能写入过早，会挡掉事后本可恢复的「限期失败+输出」恢复路径
- 位置:`apps/agent-service/src/production-tool-result-recovery.ts:156-163`(写痕迹)
- 问题:`markUnrecoverable` 的触发条件只看「bound + foreground + 有释放回执 + supervision=released + 结果不是 result/error」,不区分恢复为什么失败。但恢复链里有一条**刻意的延迟**:`apps/agent-service/src/production-sandbox-stream-result-recovery.ts:53-55` 对终止原因为 `deadline` 的输出结束记录，在 `now() < plan.effectiveDeadlineAt` 时故意先不动、等过了生效期限再导入结果。在这段等待期里，调度泵会跑 `prepareToolResultRecovery` 循环(候选由 `sqlite-sandbox-tool-result-recovery.ts:5-46` 列出，`originalDeadlineAt > now` 成立)，第一次尝试因「还没到期」返回原样，结果仍是 unknown → **当场写痕迹**。到期后本可导入 `SANDBOX_TOOL_DEADLINE_EXCEEDED` 失败并交付被完整保存的输出，现在被 `NOT EXISTS`(sqlite-sandbox-tool-result-recovery.ts:19-23)排除，轮次只能以「结果未确认」收尾。
- 证据:
  - production-tool-result-recovery.ts:156-163:`if (admission.phase === "bound" && … releaseReceipt && … supervision === "released" && !["result","error"].includes(…)) await markUnrecoverable(…)`
  - production-sandbox-stream-result-recovery.ts:53-55:`const deadline = recovered.termination.reasonCode === "deadline"; if (deadline && options.now() < plan.effectiveDeadlineAt) return record;`(过了期限才有 line 107-126 的导入)
  - sqlite-sandbox-tool-result-recovery.ts:19-23:痕迹记录排除 resume 候选。
- 建议写痕迹前先读输出结束记录(`sandbox-stream-end:*`),若终止原因是 `deadline`(或 `exited`,即 `stream.recover` 判为可重建的类别)，不要标记，等恢复链自己出结果；只在 `now() >= plan.effectiveDeadlineAt` 之后仍 unknown 时才标记。提交信息里「只有在真的找不回结果之后才写这条记录」对 deadline 场景不成立。

### 2.【中】事故门槛文档与代码不一致：声称「告诉模型实际用了多少」，但没有；声称的测试名不存在
- 位置:`docs/incidents-and-gates.md:119`
- 证据:
  - 文档写「把超了哪一项、上限是多少、**实际用了多少**告诉模型」。但实际生成的说明没有用掉量:`apps/agent-service/src/production-sandbox-tool-result.ts:131-141` 的 `sandboxResourceLimitMessage` 只有「命令使用的 CPU 时间超过上限…本次允许的上限是 CPU 时间 X 秒、内存 Y MB」,没有任何 observed 数值(候选观察值 `sandboxResourceLimitReason` 只在选择原因码时内部比较,`packages/execution-contracts/src/sandbox-execution-v2.ts:262-273`)。作者材料照抄了这句话，同样与代码不符。
  - 文档写有集成测试 `stream-candidate-unrecoverable`;全仓库只有 incident 表里这一行提到这个名字(`grep` 仅命中 docs/incidents-and-gates.md:119),`test/integration/sqlite-sandbox-execution-v2.test.ts` 实际新增的是 `loss-unverified` 用例(its each 列表 5261 行、断言 6061-6090 行)。
- 建议：更正 I-81 行；如确实要求「实际用了多少」，在 `sandboxResourceLimitReason` 里把观察值也带给 `sandboxResourceLimitMessage`。

### 3.【中】产生端改动没有测试：worker 两条 v2 路径的 `resource_limit` 落地无任何用例驱动
- 位置:`apps/execution-worker/src/production-sandbox-execution-v2.ts:885-897`(job host 路径 `boundedTermination`)、:1848-1858(SRT 路径)
- 证据：本次 diff 的测试改动只有 agent-service 单测(mock `completeSandboxToolResult`,绕过了真实产生端)、execution-contracts 单测(纯函数)、集成 `loss-unverified`(恢复链)。全仓库 grep `resource_limit`,自动覆盖只有 `apps/execution-worker/test/product-job-host.unit.test.ts:115`(旧路径，且不是本次新增)。也就是说「resource_limit 进来 → 写出 `SANDBOX_CPU_TIME_LIMIT` 系列 reasonCode」的第一手代码分支，没有任何测试走到；若作者把 `boundedTermination` 前置四元条件写错，现有测试不会红。(生产第 26 版那轮本身没有在测试复现，新增断言都是构造数据，此条属读代码交叉得出的覆盖缺口。)
- 建议：在 worker 集成/单测里加一条 job host 观察 `reason:"resource_limit"` 且 `resources` 越界的用例，断言记录的 result 是新原因码、effect 仍 unknown;SRT 路径同理。

### 4.【低】消息链路里 `SANDBOX_OUTPUT_LIMIT` 没有专用文案，会落到「操作未确认成功。」
- 位置:`apps/agent-service/src/production-runtime-tools.ts:2140-2155`
- 证据：三元链对该错误码既不匹配 `SANDBOX_TOOL_DEADLINE_EXCEEDED`,`sandboxResourceLimitMessage` 也不认它(`production-sandbox-tool-result.ts:133-139` 只列三个新码)。这属既有行为(PR 没改 output_limit 的模型文案，作者也只说「和 output_limit、deadline 一样记成明确失败」)，不算回归；但既然本次把 output_limit 拿出来当参照物，顺手补上更一致。另外 `apps/control-center/src/execution-view.ts:355-387` 的 `reasonLabels` 同样一直没有 `SANDBOX_OUTPUT_LIMIT`(界面落到阶段标签)，问卷第 4 条里值得对照记录。

### 5.【低】`sandboxResourceLimitMessage` 在同一个三元表达式中被连续求值两次
- 位置:`production-runtime-tools.ts:2145-2146`
- 证据:`: sandboxResourceLimitMessage(completion.errorCode ?? "", ceiling) ? (sandboxResourceLimitMessage(…) as string) : …`。纯函数、无副作用，正确性没问题，但既是本次新增，建议 `const resourceLimitNotice = sandboxResourceLimitMessage(…)` 再进三元，少一次取巧的断言。

### 6.【低】SQL 里硬编码前缀字符串与常量函数是两份事实
- 位置:`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:22-23` vs `packages/execution-contracts/src/sandbox-execution-v2.ts:277-278`
- 核对结果(读代码证实):**两端当前一致**，均为 `sandbox-tool-result-unrecoverable:`;走 `run_payload_artifacts` 主键(owner/agent/run/purpose/operation_key,migrations/0019_run_payload_artifacts.sql:12),命中查询没问题。`json_extract(...'$.identity.invocationId')` 空值安全：缺少该字段时拼接结果为 NULL,`=` 比较恒假，不会误挡;`plan.identity.invocationId` 在 plan schema 里是必填 machineString(sandbox-execution-v1.ts:30,经 sandbox-execution-v2.ts:123 解析)。风险只在将来有人改函数忘了改 SQL——建议 SQL 直接拼接同一常量或加一条输出来自两端的对账断言。作者疑虑里「是否可靠」这一条：可靠，已证实。

### 7.【低，作者疑虑二的正面回答】`boundedTermination` 的优先级核对无问题
- 位置:`production-sandbox-execution-v2.ts:885-981`
- 核对(读代码证实):`boundedTermination` 要求 `!knownExit && !completionContradicted && !authenticatedDeadline && !authenticatedNotStarted && result?.kind !== "started"`;在这四个布尔下，`effect`/`result` 两棵三元里所有更早的分支(`not_applicable` 需四者之一、矛盾、deadline、verified 需要 knownExit、started)都不可达，bounded 分支恰在第 923/953 行落到下一个位置，且优先于 `SANDBOX_EXIT_UNKNOWN`(961/962),正确;`effect` 仍 `{kind:"unknown"}` 与 result 的 error 配对，没有自相矛盾。owner 疑虑三款「effect 分支是否自相矛盾」：否。

### 8.【低】`markUnrecoverable` 幂等护栏依赖先 lookup,并发二次 commit 会撞唯一键
- 位置：production-tool-result-recovery.ts:54(lookup)、:64(commit);`sqlite-run-payload-artifact-operations.ts:383-410` 是裸 INSERT
- 若两次候选准备并发写，第二个 commit 抛 UNIQUE 异常，本次准备作废，下一轮 lookup 命中后跳过，最终收敛；与既有 `sandbox-tool-result-lost` 的写入模式相同，属可接受的暂态。推测性很低，仅记录。

## 侧重检查(测试覆盖 · 文档与代码一致 · 普通流程走查)

走的流程：模型发起一条普通命令 → `ProductionRuntimeTools.execute`(agent-service 单测覆盖，含 [I-81] 用例，但入口 `completeSandboxToolResult` 是 mock)→ work.execute 派到 worker → worker v2 本机 job host 路径执行/核对(`production-sandbox-execution-v2.ts:885-981`,**无 resource_limit 用例覆盖**，见问题 3)→ 资源监视器按上限杀进程(`packages/runtime-sandbox/src/resource-observer.ts:221-226`,runtme-sandbox 单测覆盖)→ 记录 bounded 失败 → 释放 → agent 侧经 `projectSandboxExecution` 的 `boundedFailure`(`packages/application/src/services/sandbox-execution-projection.ts:204-208,216`,由 contracts 单测 + 既有集成覆盖)→ 说明文案交给模型(覆盖)→ 若错过交付：恢复候选 SQL 与 `RUN_EXPIRED_RECONCILIATION_SQL`(`loss-unverified` 覆盖标记、被排除 claim 0、随后 reconciled 1、run failed、checkpoint RUNTIME_TOOL_RESULT_UNKNOWN)→ 界面标签(`execution-view.ts:375-377` + 三语 resources,**无定向用例**，只受 MESSAGE_IDS 清单一致性检查间接约束，属「未核实」)。
未覆盖的代码路径：worker 两条产生端分支(问题 3)、`createProductionSandboxToolResult:200→332-358` 对新错误码的真实Mixin贯穿、control-center 三条新标签。
文档与代码一致性：除问题 2 外，I-81 修复段声称「四条测试先红后绿」，本环境只读、未运行，「先红后绿」标『未核实』;`.claude/rules/prompt-prefix.md` 与本次改动的模型面内容(见下)无冲突。

## 必答问题逐条

1. **只会末尾追加?** 是。新文案是本轮工具结果消息本身(最末一条)，由 `#completionOutcome` 生成;系统提示、工具定义、历史无一改动;存储后回放走 `runtime-tool-recovered-result` 静态 JSON(production-runtime-tools.ts:1513-1539),不发新字节。每轮会变的值(上限数值)只出现在这条末尾消息里，属引用规则的合法位置。
2. **同段文字会变字节吗?** 不会。消息只依赖 (errorCode, ceiling),纯函数、无时间戳、无集合序;`limitAmount` 确定格数。痕迹记录内容是常量 `SANDBOX_TOOL_RESULT_UNRECOVERABLE`,且不进模型请求。
3. **有自动检查吗?** 有：contracts 单测(3 用例，含 1 个反向断言)、agent-service 单测(3 用例)、集成 `loss-unverified`(含反向：第一泵 `claimed:0` 即标记排除了 claim)。 Worker 产生端、恢复候选 SQL 的排除分支以及 UI 文案没有(或仅间接)覆盖——见问题 2、3。文档声称的红色用例名 `stream-candidate-unrecoverable` 无处存在。
4. **每个新值两端核对?**
   - 三个原因码:产生端 = worker 两路径 + 旧 product-job-host(:83-88,`SANDBOX_${reason.toUpperCase()}`);消费端 = `isSandboxBoundedToolFailure`(已加，executor projection 因此把这些当有界失败可交付)、`sandboxResourceLimitMessage`(接受)、`execution-view.ts` 标签(已加)、SQLite/模型消息网线两侧 `reasonCode`/`errorCode` 均为 `machineString` free-form,无 enum 校验，不会拒收(读代码证实)。
   - 痕迹 operationKey 前缀：两端一致、主键命中、空值安全(问题 6)。
   - 缺对照的旧洞:`SANDBOX_OUTPUT_LIMIT` 在模型文案与 UI 无对应分支(问题 4,既有)。

## 作者说法逐条核对

- 第 1 条 stopTask("resource_limit"):贴代码证实(resource-observer.ts:226)。
- 第 2 条两条 v2 路径:「只把 deadline/output_limit 当明确失败」证实(改动前 1838-1843 限 deadline/output_limit;885 行以下旧三元只有 knownExit/started 等分支);「resource_limit 落 SANDBOX_EXIT_UNKNOWN」证实(961-962,pod 布置下往返)。
- 第 3 条 product-job-host 一直当失败：证实(:47-58)。
- 第 4 条 `SANDBOX_TOOL_RESULT_RECOVERY_SQL` 预判可恢复：证实(sqlite-sandbox-tool-result-recovery.ts:4-46)。
- 第 5 条 stream `recover` 对四种终止原因返回 null:证实(production-sandbox-stream.ts:86-90,134);`isSandboxExecutionFenceSuperseded` 只有重启后成立：证实(production-sandbox-lost-result-recovery.ts:41,`SERVICE_STOPPING`-checkpoint / 新 epoch 进来的候选才会走到)；known 为假静默 continue:证实(production-tool-result-recovery.ts:165-179)。
- 第 6 条 `RUN_EXPIRED_RECONCILIATION_SQL` 第一分支 `NOT (...)`:证实(sqlite-sandbox-tool-result-recovery.ts:52-57)。
- 第 7 条第三道锁 `reconcile_required` 未修：未核(代码里没有找到预算账户那段，此 PR 文档/提交均自认未修，按作者自述处理)。
- 「两条执行路径都改了」部分不准确：改动的是「job host 本机路径 + SRT 任务环境路径」两条**前台路径**；容量容器路径(production-sandbox-execution-v2.ts:1181-1280)也处理前台执行，它没有 `resource_limit` 三元分支——是否真的可能收到 resource_limit 属『推测：容器任务可能不挂 ps 观察器，通常不会拿这个原因』，未核实,提请作者确认。
- 「沙箱已释放后立即收尾」第二条提交的行为改动方向正确(集成 `loss-unverified` 断言 run failed + checkpoint RUNTIME_TOOL_RESULT_UNKNOWN,读代码证实可用)；但「能恢复的轮次照旧恢复：只有真的找不回才写记录」**不成立**，见问题 1 的 deadline 延迟场景。
