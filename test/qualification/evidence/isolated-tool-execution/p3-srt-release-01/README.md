# SRT 模式的新释放规则：进程组消失即释放

日期：2026-09-26 UTC。对应[隔离执行实施计划的 P3 补充](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p3-modes)第一项，规则见 [Spec 的 SRT 模式的停止与释放](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#srt-release)和 [ADR 0033](../../../../../docs/adr/0033-process-sandbox-default-and-optional-containers.md#decision)。

## 用词

| 用词 | 意思 |
| --- | --- |
| SRT | 在宿主上限制单个进程能访问哪些文件和网络的进程级沙箱（依赖包 `@anthropic-ai/sandbox-runtime`） |
| Job Host | 产品自己的监督进程，每次工具调用启动一个，在 SRT 限制下运行工具程序 |
| 进程组 | 操作系统把一个程序和它启动的子程序归成的一组，可以一起发停止信号；子程序可以用 `setsid` 离开这一组 |
| `process_group_gone` | 释放记录里新增的清理依据，含义是“停止未经严格确认”：任务进程组已全部消失，离开进程组的后代不被跟踪 |
| `confirmed` | 原有的严格清理依据，例如 Linux 上原进程隔离空间（PID namespace）的 1 号进程已消失 |

## 改了什么

- Job Host（[`job-host-main.ts`](../../../../../packages/runtime-sandbox/src/job-host-main.ts)）在任务结束后，用新的 [`stopProcessGroup`](../../../../../packages/runtime-sandbox/src/process-group.ts) 检查任务进程组：还有进程就发 SIGKILL，并在有限时间内反复检查，直到系统回答“没有这个进程组”。结果写进终态证据的 `taskProcessGroupGone`。组号 0 和 1 一律不发信号。
- Agent（[`production-sandbox-control.ts`](../../../../../apps/agent-service/src/production-sandbox-control.ts)）在任务已启动、Job Host 已结束且进程已不在、SRT 已复位、任务主进程已退出、`taskProcessGroupGone` 为真时，把资源记为 `released`，清理依据写 `process_group_gone`。Linux 原有的严格证明仍优先，写 `confirmed`。
- 合同（[`sandbox-execution-v2.ts`](../../../../../packages/execution-contracts/src/sandbox-execution-v2.ts)）：释放记录的 `cleanup` 可以是 `confirmed` 或 `process_group_gone`，释放之后这个字段不能再改。
- 终态证据没有这个字段（旧文件）、进程组仍在、发不出信号时，照旧记为未确认并挡住目录。

## 自动测试

| 测试 | 结果 | 运行方式 |
| --- | --- | --- |
| [`process-group.unit.test.ts`](../../../../../packages/runtime-sandbox/test/process-group.unit.test.ts)（真实进程：同组子进程被结束，`setsid` 脱离的子进程不受影响；无权限、到时仍在、非法组号） | 8 项通过 | 沙箱内 |
| [`job-host-main.unit.test.ts`](../../../../../packages/runtime-sandbox/test/job-host-main.unit.test.ts)、[`job-host.unit.test.ts`](../../../../../packages/runtime-sandbox/test/job-host.unit.test.ts) | 43 项、20 项通过 | 沙箱内 |
| [`sandbox-execution-v2.test.ts`](../../../../integration/sandbox-execution-v2.test.ts)（新字段可写、释放后不可改） | 36 项通过 | 沙箱内 |
| [`sandbox-control-evidence.test.ts`](../../../../integration/sandbox-control-evidence.test.ts)（新增 9 个场景） | 57 项通过 | 用户在本机终端运行，因为测试要在 `/tmp` 建临时目录，Claude 的命令沙箱不允许 |

## 真实 SRT 探针（macOS 27.2，Node 22.22.3）

运行前先执行 `npm run build:node`，产物含新代码。两个探针由用户在本机终端运行，因为 SRT 沙箱不能嵌套在 Claude 的命令沙箱里。代码版本：提交 `b8a9014` 加本次未提交的改动（即本证据所在提交）。

```sh
node packages/runtime-sandbox/scripts/probe-job-host-control.mjs 2>&1 | tee test/qualification/evidence/isolated-tool-execution/p3-srt-release-01/mac-job-host-control.log
HIMAWARI_LIVE_SANDBOX_PROBE=1 HIMAWARI_QUALIFY_INSTALLED_RUNTIME="$PWD/dist/node-runtime" node packages/runtime-sandbox/scripts/qualify-production.mjs --v2 2>test/qualification/evidence/isolated-tool-execution/p3-srt-release-01/qualify-production-v2.stderr.log | tee test/qualification/evidence/isolated-tool-execution/p3-srt-release-01/qualify-production-v2.json
```

- [`mac-job-host-control.log`](mac-job-host-control.log)：7 个场景全部通过。停止、Worker 崩溃、从标准输入读取、观察到脱离、两个写入程序场景的清理依据都是 `process_group_gone`，从未启动的场景是 `confirmed`。两个写入程序场景里，用 `setsid` 脱离的程序在释放之后又写入了 28 字节。这就是 ADR 0033 中所有者已接受的风险，与 [P0 基线](../p0-baseline-01/README.md#baselines)记录的数字相同；探针只在 `confirmed` 时要求释放后没有新写入。
- [`qualify-production-v2.json`](qualify-production-v2.json)：经真实 Agent、Worker、SQLite 和 SRT 的产品路径通过。调用结束后记录为 `released`，清理依据是 `process_group_gone`，目录不再被占用（`occupiedAfterExecution: false`），竞争任务可以取得这个目录（`admittedAfterExecution: true`）。执行前竞争任务被挡住（`blockedBeforeExecution: true`）。`productionSuitable: false` 表示这是测试夹具，不是安装资格。
- [`qualify-production-v2.stderr.log`](qualify-production-v2.stderr.log)：准入阶段计时和构建工具输出，没有凭据。

## 完整 npm test（提交 `1eae76a`）

提交后由用户在本机终端运行 `npm test -- --output .ci-output/npm-test-1eae76a-2`，全部通过：contracts 379 项、unit 2044 项、integration 1818 项、e2e 3 项、pi-compat 130 项，报告在 [`npm-test-1eae76a.tar.gz`](npm-test-1eae76a.tar.gz)。控制台输出去掉了本机沙箱打印的、与测试无关的 `failed to copy trust settings of system certificate` 行。

第一次运行（输出目录 `.ci-output/npm-test-1eae76a`，未存档）在打包阶段失败，没有执行任何测试：构建期间访达在构建目录各层写入了 `.DS_Store`（记录文件夹显示设置的文件），产物校验报 `ARTIFACT_CONTENT_MISMATCH`，清理时删除 `node_modules` 报 `ENOTEMPTY`。这是环境问题，与代码无关；换新目录重跑后通过。

## 发现和未验证的部分

- 资源投影（[`qualify-production-v2.json`](qualify-production-v2.json) 的 `resourceProjection`）目前对这种释放显示 `RESOURCE_RELEASE_CONFIRMED`，没有区分“停止未经严格确认”。界面状态属于 P3 补充的第三项（ITE-27），在那一步处理。
- 这次没有在 Linux 上运行探针；Linux 上预期仍走 namespace 严格证明（`confirmed`），未实测。
- 机器重启后按开机编号释放（Spec 第 6 条）还没有实现，留给下一个提交。
