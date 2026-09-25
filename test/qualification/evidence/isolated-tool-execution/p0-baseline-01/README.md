# P0 基线：当前版本、三条现状基线与验收覆盖

日期：2026-09-25 UTC。对应[隔离执行实施计划的 P0](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p0)。本目录记录改造**之前**的现状，供 P1～P4 做前后对比；容器运行时的实测见 [P0 平台探针](../p0-platform-probe-01/README.md)。

<a id="contents"></a>

## 目录

- [当前版本与输入](#inputs)
- [三条现状基线](#baselines)
- [ITE-01～21 的覆盖与缺口](#coverage)
- [旧计划的 55 项任务与 68 项验收](#transfer)
- [真实容器测试的放置方式](#placement)

<a id="inputs"></a>

## 当前版本与输入

| 项目 | 当前值 |
| --- | --- |
| Git | 分支 `claude/isolated-tool-execution`，记录时 HEAD `4e6b073`；已跟踪文件没有未提交的修改；另有 67 个原本就有的未跟踪文件，与本计划无关 |
| Pi | `@earendil-works/pi-coding-agent`、`pi-ai` 及其依赖均为 0.84.2（`pi-telemetry` 顶层为 0.84.3） |
| SRT（现有进程级沙箱） | `@anthropic-ai/sandbox-runtime` 0.0.75 |
| Node.js | 22.22.3 |
| 生产执行路由 | Pi 的七个工具和 web_search 由 Worker 启动独立的 Job Host 进程，Job Host 再用 SRT 运行已登记的 runner 程序。详见[工具入口盘点](../p0-platform-probe-01/README.md#tool-inventory) |

[Spec 的代码差距表](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#baseline)已按当前代码复核，关键事实仍成立：
- 生产准入仍按每次调用生成作业和环境身份，见 `apps/agent-service/src/production-sandbox-services.ts` 第 988 和 1009 行的 `jobId(input.invocationId)` 与 `environment:${hash(input.invocationId)}`。
- Job Host 在任务启动后，进程树清理结果固定为 `unknown`，见 `packages/runtime-sandbox/src/job-host.ts` 第 392 行。

[↑ 返回目录](#contents)

<a id="baselines"></a>

## 三条现状基线

| 基线 | 本次证据 | 结果 |
| --- | --- | --- |
| 1. 每次调用各算一个环境 | 代码证据（见上一节） | **只有代码证据，没有可运行的测试。** 要在生产路径上造出“同一 Run 的第二次调用”，需要另建一套授权句柄和意图记录，现有测试夹具不支持；硬凑出来的测试很可能因为无关原因失败，说明不了问题。改由 P1 第一个验收测试（“同一 Run 的两次调用共用一个环境”）在改造前的首次失败来留存这条基线。 |
| 2. Mac 上已启动的环境停止后结果为 unknown | [`mac-job-host-control.log`](mac-job-host-control.log)，由 `node packages/runtime-sandbox/scripts/probe-job-host-control.mjs` 在本机用真实 Job Host 和 SRT 运行 | 7 个场景全部符合预期，`productionQualified: false`。`writer-stop` 和 `writer-worker-crash` 中，停止或 Worker 崩溃后，用 `setsid` 脱离进程组的后代在观察窗口里又写入了 28 字节，清理结果为 `unknown`，预约没有释放；只有 `never-started`（从未启动）能被确认释放。 |
| 3. 清理结果未知时，占用一直挡住冲突的任务 | [`lease-blocking.log`](lease-blocking.log)：`sqlite-sandbox-execution-v2.test.ts` 中的“活跃写入者挡住嵌套和别名目录”“失去监管后仍挡住相交的读取”“旧版 unknown 记录不能取得新执行权” | 6 项通过（3 个用例 × `worker`、`direct` 两种模式）。这说明现有占用登记是按单次调用建立的：清理结果未知时，占用不释放，冲突的新任务被挡住；同一 Run 里后续的冲突调用也会被挡住。 |

**基线 2 的两次失败**：在得到上面的通过结果之前，同一命令先连续失败了两次，错误都是 `JOB_HOST_NOT_READY`，几秒内就出现，并不是 30 秒的准备超时。之后原样的构建产物连续运行三次都通过。两次失败的原始输出保存在 [`mac-job-host-control-failed-1.log`](mac-job-host-control-failed-1.log) 和 [`mac-job-host-control-failed-2.log`](mac-job-host-control-failed-2.log)。第一次失败时临时目录路径较长，但第二次用默认短路径同样失败，所以“路径过长”这个推测已被否定。
- Job Host 准备失败时，会把具体的错误码写到它自己的错误输出，但 `job-host.ts` 第 176 行按设计丢弃了这些输出，所以这次无法确认原因。
- 诊断时曾临时修改构建产物里的这一行，让错误输出显示出来，然后按原字节恢复，恢复后哈希一致。改动期间的运行都通过了，没有捕获到错误码。
- 结论：这是**原因未确认的偶发失败**。它也说明现有 Job Host 的准备失败难以诊断，P2 的新后端需要保留可诊断的受保护日志。

[↑ 返回目录](#contents)

<a id="coverage"></a>

## ITE-01～21 的覆盖与缺口

新后端还没有实现，所以没有一项 ITE 已经通过。下表列出现有可复用的覆盖和缺口；“旧覆盖”只证明旧的按调用执行路线，不能算作新环境的验收。ITE 的完整定义见 [Spec 的验收标准](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#acceptance)。

| ITE | 现有可复用的覆盖 | 缺口 |
| --- | --- | --- |
| 01 同一 Run 共用环境 | 无；代码仍按调用生成身份 | 全部（P1 身份与 `lease`，P3 真实路径） |
| 02 不同任务不共享 | 旧的授权句柄与 Grant 范围检查（按调用） | 环境级拒绝复用与审计 |
| 03 整体停止后代 | [P0 平台探针](../p0-platform-probe-01/README.md#results)：容器运行时在两个平台都能停止 `setsid`、两次 fork 和后台写入程序；基线 2 证明现有 SRT 做不到 | 产品接入、停止证明、`lease` 只在证明被接收后释放 |
| 04 后端缺失时拒绝 | 无 | 全部 |
| 05 旧环境可能仍在写入 | 基线 3：按调用的占用在结果未知时挡住冲突任务 | 环境级 `lease` 与停止或检查超时、断线、身份变化 |
| 06 崩溃恢复 | 旧的启动恢复与资源恢复调度（按调用） | 环境的创建、绑定和停止各阶段 |
| 07 越界与路径身份 | [P0 平台探针](../p0-platform-probe-01/README.md#host-mount-gate)：遮挡、硬链接、大小写、inode、符号链接的实测；旧准入按设备号和 inode 检查目录身份 | 宿主一侧解析、硬链接拒绝、审批告知（[ADR 0032](../../../../../docs/adr/0032-original-directory-disk-and-sensitive-file-limits.md#decision)） |
| 08 网络限制 | 旧的 SRT 出口限制（ADR 0026） | 容器出口与绕行测试 |
| 09 资源限制 | P0 平台探针：任务私有临时目录额度有效 | CPU、内存、进程数触发；原目录模式的磁盘保护 |
| 10 撤权与过期 | 旧的执行前权限重新检查（例如 `production-sandbox-queue-reentry.test.ts` 的撤权、过期场景） | 环境权限上限缩小和换新环境 |
| 11 迟到的 ACK | 旧的永久释放回执与 ACK 分离 | 环境级停止证明接收后的同类回归 |
| 12 新旧记录并存 | 基线 3 中“旧版 unknown 记录不能取得新执行权” | 新环境 `lease` 与旧写入方、回退 |
| 13 浏览器 | 无 | 全部 |
| 14 可替换后端 | 无 | 全部 |
| 15 保留用户数据 | 旧的文件发布、版本比较与恢复（P3 证据） | 在容器挂载下重新验收 |
| 16 扩权与换新环境 | 无 | 全部 |
| 17 硬期限 | [P0 平台探针](../p0-platform-probe-01/README.md#deadline)：受保护 init 的反向测试和休眠实测 | 产品接入、控制进程崩溃后的真实用户路径 |
| 18 Run 边界 | 无 | 全部 |
| 19 runner 不可信 | 旧的宿主一侧文件读回与写入证据 | 任意代码篡改 runner 的场景 |
| 20 扩权审批分类 | 旧的自动审查与审批（按单次操作） | 扩权分类、委托清单、范围授权代替 |
| 21 凭据 | 无 | 全部 |

[↑ 返回目录](#contents)

<a id="transfer"></a>

## 旧计划的 55 项任务与 68 项验收

[逐项转交表](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#transfer-tasks)共 55 行，[验收责任映射](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#transfer-acceptance)共 68 行，均已核对行数。转交核查基于提交 `2725547`；之后改动产品代码的提交只有 `d570bc9`（失败分类与页面下一步提示）和 `c18b70a`（只调整格式）。因此表中只有旧 P1-T05（错误与效果分类）需要补充说明：本地分类已提交，页面组件测试已在 2026-09-25 通过，真实页面联合路径仍待验。其余行的状态不变。本次没有逐项复跑 68 项旧验收。

[↑ 返回目录](#contents)

<a id="placement"></a>

## 真实容器测试的放置方式

沿用现有 `qualify:scale` 的做法，登记在 P2 进行：

- 需要真实容器的场景放在单独的测试文件和 Vitest 项目中，在 `ci/policy.json` 的 `registeredTests` 里登记为 `kind: qualification`。
- 通过 `scripts/ci/quality.mjs` 新增的检查项和 `package.json` 里对应的 `qualify:*` 命令运行，只有设置了显式的 opt-in 环境变量才执行；一旦打开，运行时缺失就必须失败，不能跳过。命令名和环境变量在登记时确定并写回计划的验证命令表，登记前不存在。
- 不需要真实容器的产品路径（例如后端缺失时拒绝）放在默认 e2e 的 `test/e2e/isolated-tool-execution.test.ts`。
- Linux 以 Hermes 为主要实测平台，这与用户在 P0 选择的 Linux 平台一致，也是实际部署目标。另外在只能手动触发的 `.github/workflows/quality.yml` 里加一个 `ubuntu-24.04` 任务，作为可重复的第二个 Linux 环境。它默认不是必需检查，是否设为必需，按当时的 CI 策略另行提出。

[↑ 返回目录](#contents)
