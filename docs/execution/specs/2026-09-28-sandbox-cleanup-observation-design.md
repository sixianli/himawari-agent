---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-28"
---

# 沙箱正常收尾与失控观察的分离提案

**审阅状态：已批准，组件实现已完成，产品验收待执行。** 2026-09-28 按用户指定的任务负责人 Claude 的回复（`.ci-output/handoff/2026-09-28-claude-reply-1.md`）获得实施授权。 本提案只解决正常收尾被当成恢复失败的问题，不声称全部工具执行缺陷已找到。

## 阅读导航

- [用户可见的问题与证据](#用户可见的问题与证据)
- [建议的调整](#建议的调整)
- [责任与接口](#责任与接口)
- [启动阶段的非终态观察](#启动阶段的非终态观察)
- [中断与失败](#中断与失败)
- [取舍与范围](#取舍与范围)
- [验收与第一步](#验收与第一步)

## 用户可见的问题与证据

目标：正常完成或收到停止请求的工具，只要在既有核查期限内完成清理，就取得释放证明并结束资源占用；不能仅因为第一次观察赶上清理窗口而永久保留“结果未确认”。

依据：[隔离工具执行设计](2026-09-24-isolated-tool-execution-design.md#srt-release) [SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md]、[ADR 0033 的停止与释放规则](../../adr/0033-process-sandbox-default-and-optional-containers.md#decision) [SOURCE: docs/adr/0033-process-sandbox-default-and-optional-containers.md]。当前调查见[缺陷清单](../plans/2026-09-28-tool-execution-audit-plan.md#缺陷和待验证项)。

当前链路存在三处相连的事实：

1. `production-sandbox-control.ts` 识别出 `exit_cleanup_pending`，却将其编码为 `supervision: lost` 加特殊原因码；`stop` 路径进一步改成普通 `SANDBOX_CONTROL_UNCONFIRMED`。同一个 `lost` 同时表示正常等待和真正无法确认控制。
2. `SandboxExecutionReconciliationService` 只观察一次，接受 `released` 或 `lost`，收到 lost 后即结束为 unresolved。`sandboxReconciliationFailureReason` 还会把清理 pending 原因归为通用未确认原因。
3. `SqliteSandboxRecoveryScheduling` 对同一种已经 unresolved 的 stop 不再自动排期。前台交付看到 unresolved 就返回未知，35 秒等待不会改变这个已经结束的核查。

**confirmed 的范围**：组件测试 `settles an acknowledged stop whose host finishes cleanup inside the recovery deadline` 在真实 SQLite 和生产恢复服务中，两种执行模式都失败：预期 resolved，实际 unresolved。后端观察夹具第一次返回清理 pending，之后可提供有效释放证明，服务没有继续观察。日志为 `.ci-output/tool-execution-audit/2026-09-28/cleanup-pending-before.log`。

该测试没有启动真实 SRT Job Host，不能据此声称已复现真实用户点击停止的整条链路。现有 `sandbox-control-evidence.test.ts` 的真实认证 socket 测试另行验证了 pending 分类及 stop 的原因转换；72 条已通过。两类证据支持接口问题，真实产品端到端停止仍待验收。

## 建议的调整

把“正在正常清理”作为明确的**非终态观察**传给恢复服务，停止借用 lost 表示它。恢复服务继续持有同一次恢复的 owner、revision 和原期限，等待下一次观察；只有释放证明或明确失败才能结束。整个过程不增加当前 30 秒恢复上限，也不增加前台 35 秒等待上限。

继续沿用数据库的 `reconciling` 表示正在核查，沿用现有 `recovery.running`、`deadlineAt` 和所有权字段，不新增数据库状态或迁移。pending 只是受信宿主控制适配层返回给应用层的观察类型，不是模型可指定的执行请求。

对于正常退出，继续核对原身份、签名、开机标识、观察新鲜度及清理进度。对于显式 stop，任务执行期限已到不构成“不能清理”的理由，但也不能恢复任何执行权限；恢复有自己既有的有限期限。

## 责任与接口

已实施的内部观察合同：

```ts
type SandboxReconciliationObservation =
  | { kind: "verified"; verification: SandboxExecutionVerification }
  | { kind: "observation"; resource: SandboxResourceObservation }
  | {
      kind: "cleanup_pending";
      identity: SandboxJobIdentity;
      environmentId: string;
      resourceSequence: number;
      observedAt: string;
    };
```

正式后端入口为 `observe(record, action, signal)`，原 `inspect`、`stop`、可选 `observeVerified` 组合已移除。生产适配返回已核验证据；`observation` 允许后端提供原始资源观察，但必须经过恢复服务既有的 evidence 端口校验才能释放。它不是旧接口的兼容分支。pending 只携带身份、新鲜度和当前资源序号，不携带释放事实，也不写入终态证据槽，避免连续清理观察占用相同证据序号。

| 组件 | 调整后的责任 |
| --- | --- |
| Job Host 控制适配 | 核验原宿主的原始观察；输出 verified 或 cleanup_pending。只有确有正常收尾或可信 Host 退出/同组回收证据时才返回 pending；普通失联、身份错误和权限失败不能改成 pending |
| 恢复服务 | 一次登记恢复所有权；发送一次 stop；随后仅 inspect。pending 期间保持 reconciling，在原期限内用有界观察间隔等待；每次回调和写入仍验证 owner/revision/期限 |
| SQLite journal/scheduler | 保留现有状态转换与所有权检查，不因为 pending 放弃占用；resolved/unresolved 仍是持久终点，不把失败无限重试 |
| Worker 控制循环 | 消费同一套明确的 pending 语义；正常收尾不触发 cancel。真正 lost、撤权和用户取消仍执行停止 |
| 前台结果交付 | 继续等待资源确认，资源释放后才按权限交付；本提案不改变模型消费或已派发 intent 的规则 |

TE-01 已做的局部修复继续保留：只有操作版本发生变化且资源事实完全未变，才重新核验合并后的事实；资源改变或恢复被接管仍拒绝旧证明。它解决另一个独立竞争，不代替本提案。

## 启动阶段的非终态观察

2026-10-23 补充（R2-D26）。前台工具运行期间，Execution Worker（执行工作进程）大约每 250 毫秒做一轮检查：先请求 `resolve`（重新核对执行授权与宿主），再请求 `observe_control`（让 Agent 服务读取 Job Host 的控制观察并分类）。ADR 0069 之后，宿主核验不再遍历运行时文件，一轮检查只要几毫秒，于是 `observe_control` 经常落在任务刚开始的几十毫秒里。

当时的分类把两种正常的启动瞬间都判成 `lost`（失去控制）：Job Host 已进入 `running` 但任务进程还没启动（`taskStarted=false`）；任务已启动、资源观察器的第一次进程快照还没读完（`resources.samples=0`）。Worker 收到 `lost` 就取消任务，作业宿主随后报告 `reason: "cancelled"`，一个本来会正常结束的命令最终交付为 `SANDBOX_EXIT_UNKNOWN`（结果未知）。Hermes 上 `r2t10-not-started.test.ts` 与另外两个集成测试文件并行运行时 6 次失败 5 次，诊断打印见 `/data/hermes/himawari/tool-audit-round2/r2-d25/evidence/r2t10-diag3/`。

调整：这两种启动瞬间与正常收尾一样，返回已有的非终态观察 `cleanup_pending`（含义是“宿主还在过渡，稍后再查”），不写入新的资源观察，也不写入 `lost`。只有在下面条件全部成立时才这样返回：身份与签名、开机标识和监督者一致；Job Host 处于 `running`；任务进程没有退出；Linux 任务命名空间没有释放；原 Host 进程仍在；观察不超过 1.5 秒；没有到执行期限。任一条件不满足仍判 `lost`。没有资源观察器的已启动任务（`resources` 为空）也仍判 `lost`，因为它永远不会进入受控状态。Job Host 还处于 `ready`（尚未处理启动消息）时也不在此列，仍判 `lost`：Job Host 收到启动消息时同步进入 `running`，而 Worker 发出启动消息后要先完成一次 `resolve` 往返才会请求观察，这个窗口在实际路径上不出现；常驻任务宿主在两条命令之间也处于 `ready`，把 `ready` 算进来会把空闲宿主当成正在启动。

这种等待有上限：任务进程要么在启动步骤中失败并由 Job Host 自己结束，要么在第一次快照完成后进入受控状态，快照失败时观察器以 `host_failure` 停止任务；执行期限由 Job Host 自己的计时器强制。Worker 一侧只在记录不再是 `bound`，或服务端明确写入 `controlled`、`initializing` 以外的状态时才取消；收到“稍后再查”时记录保持 `initializing`，下一轮继续检查。这同时修正了正常收尾窗口：记录仍为 `initializing`（还没有写过 `controlled`）时，如果任务进程已退出、输出管道尚未关闭，Worker 以前也会因为同样的规则取消任务，使 Job Host 不再发送 `completed`。

接口没有新增类型：沿用 `cleanup_pending`，它的含义由“正在清理”扩展为“宿主处于启动或清理的过渡中”。恢复服务对它的处理（同一期限内每 250 毫秒再观察一次）对启动瞬间同样适用。测试：`sandbox-control-evidence.test.ts` 中带 `[R2-D26]` 的用例覆盖两种启动瞬间返回非终态、到期后仍判 `lost`；`sandbox-v2-worker-lifecycle.test.ts` 的 `[R2-D26] start-pending` 场景证明 Worker 收到非终态后不取消，任务正常结束后交付结果。

## 中断与失败

- 收尾持续到恢复期限：结束为 unresolved，保留占用及明确超时原因；期限到达之后返回的释放证明被拒绝。
- 用户停止接管已有 inspect：沿用 recovery revision 优先级；旧等待者中止，不覆盖新 stop。
- 重复停止：不启动原工具；同一有效恢复的 stop 只发送一次，之后只观察。新恢复仍核验同一宿主。
- Agent 重启：原 running 由启动恢复接管，按原身份重新观察，不能重放工具；无需保存 JavaScript 计时器。
- 控制连接错误、身份变化、无资格或权限错误：结束为相应失败，不按“正常收尾”等待。可信原 Host 为僵尸或已消失、同组回收尚在进行时，可使用已有 pending；Host 组零成员前不能报告释放。规则见[Linux Host 组清理](2026-09-24-isolated-tool-execution-design.md#linux-host-group)。
- `process_group_gone`：继续按 ADR 0033 释放并标明未经严格确认；不把脱离进程组的后代纳入本次新增保证。2026-10-24 起，带 `cleanupScope: "pid_namespace"` 的 Linux 常驻释放按 [ADR 0072](../../adr/0072-linux-pid-namespace-sweep-counts-as-release-confirmed.md#decision) 显示为已释放。
- 结果交付超过 35 秒、文件结果恢复竞争、模型消费跨重启：继续在审计计划中验证，本提案不提前保证已解决。

## 取舍与范围

| 方案 | 后果与结论 |
| --- | --- |
| 遇到任意 lost 都多重试几次 | 无法区分正常收尾和真正失控，会延迟报告身份/权限错误，也没有稳定次数可选；不采用 |
| 只识别特殊原因码再轮询 | 改动较小，但 stop 当前已经丢失该原因，而且继续把控制生命周期藏在错误字符串中；不推荐 |
| 明确的 pending 观察类型与有界核查 | 修改内部后端接口和调用者，让类型约束正常等待与终态；推荐 |
| 全部资源状态改成单一新协调器写入 | 可能进一步减少竞争，但本次证据不足以证明必须重构全部执行架构；本提案不包含 |

这是内部观察合同及收尾流程的结构调整，所以按交接第 5.3 节先审阅。无新增第三方依赖、用户配置、数据库迁移、Pi 工具协议或 Hermes 部署；不修改现有 ADR 的释放标准。主要风险是对非终态的误分类和中断失效，必须由负向测试验证。

## 验收与第一步

批准后首先扩展同一组件复现测试：正常收尾后释放、持续 pending 到期、等待中取消、stop 接管 inspect、身份改变、权限失败、迟到证明、期间结果并发写入。先保留失败日志，再改正式类型和生产实现。不得把现有错误断言改成接受 lost 来消除失败。

随后运行真实产品路径：同轮多个工具、工具运行中停止、工具运行中重启隔离测试服务、执行期限届满、重复运行几十次。通过页面操作、SQLite 独立读回、模型请求中的结果消费次数共同验证，保留 trace 与报告。

初始 Mac 验收已批准停止和启动测试自己创建的 `/tmp/hma-pp-*` 隔离安装。当前开发验证按 [ADR 0042](../../adr/0042-hermes-test-scratch-on-root-disk.md#storage) 在 Hermes 上运行：测试安装、SQLite 和 socket 使用 `HIMAWARI_TEST_TEMP_ROOT` 指定的根盘任务目录，权限 0700；源码、依赖、报告与保留现场在 `/data`。共享测试包解析临时根并在创建产品安装前检查 socket 长度；每次运行记录空间峰值、转存现场并清理。授权只包括测试自有服务，不包括用户服务；Mac 专属验证及其他新增审批仍通过交接回复文件处理。[SOURCE: docs/adr/0042-hermes-test-scratch-on-root-disk.md]

完成后按 [ADR 0045 的层级时机](../../adr/0045-short-test-temp-root.md#layers) 运行 `npm run check`、`npm test` 和所需产品 E2E，核对 Runbook，按独立缺陷提交；全部通过前不得报告整体完成。
