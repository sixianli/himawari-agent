# SRT 模式：同一次开机里 Job Host 崩溃后核对身份再释放

日期：2026-09-27 UTC。对应[隔离执行实施计划的 P3 补充](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p3-modes)第一项的剩余部分，规则见 [Spec 的 SRT 模式的停止与释放](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#srt-release)第 6 条。前两步的记录见[进程组消失即释放](../p3-srt-release-01/README.md)和[重启后释放](../p3-srt-restart-01/README.md)。

## 用词

| 用词 | 意思 |
| --- | --- |
| Job Host | 产品自己的监督进程，每次工具调用启动一个，在 SRT（进程级沙箱）限制下运行工具程序 |
| 进程组 | 操作系统把一组进程归在一起的编号；工具程序启动时成为新进程组的组长，组编号等于组长的进程编号 |
| 启动标记 | 操作系统为每个进程保存的启动时刻：macOS 用 `ps -o lstart` 读出，Linux 取 `/proc/<pid>/stat` 第 22 项；比较时要求完全相同 |
| 开始记录 | 任务启动后 Job Host 写在控制目录里的 `started.json`，用和结束记录（`final.json`）同一把控制凭据签名 |
| `process_group_gone` | 释放记录里的清理依据，含义是“停止未经严格确认”：任务进程组已不存在，离开进程组的后代不被跟踪 |

## 改了什么

- 新增 [`process-identity.ts`](../../../../../packages/runtime-sandbox/src/process-identity.ts)：`readProcessStartToken` 读启动标记（进程不存在时返回空，其他平台或读取失败时报 `PROCESS_START_TOKEN_UNAVAILABLE`）；`processGroupPresent` 用信号 0 检查进程组是否还有进程。两者经 `@himawari-agent/runtime-sandbox/control` 提供给 Agent。
- Job Host（[`job-host-main.ts`](../../../../../packages/runtime-sandbox/src/job-host-main.ts)）在任务启动后读出自己和任务组长的启动标记，写入开始记录（[`job-host-control.ts`](../../../../../packages/runtime-sandbox/src/job-host-control.ts) 的 `recordStart`，先写临时文件再改名并同步目录）。读不出标记或写入失败时不影响任务运行，只是没有开始记录，崩溃后继续挡住。
- Agent（[`production-sandbox-control.ts`](../../../../../apps/agent-service/src/production-sandbox-control.ts)）在同一次开机里连不上 Job Host、也没有结束记录时，读开始记录并按以下顺序判断：
  1. 记录签名不对，或 Job Host 身份、策略摘要和登记时不同：报错，继续挡住。
  2. Job Host 仍在且启动标记相同：继续挡住。
  3. Linux 上原 PID namespace（进程编号空间）还没释放：继续挡住。
  4. 原进程组已没有进程：释放。
  5. 进程组还在：组长已退出而组员还在、或组长启动标记相同，继续挡住；组长启动标记不同，说明编号已分给新进程，而系统不会把仍被进程组使用的编号分给新进程，所以原进程组已不存在，释放。
  释放时保存一份“崩溃核对”记录（开始记录原文、核对时间、Job Host 和进程组的结论），资源记为 `released`、依据 `process_group_gone`，不向原 Job Host 发停止。复核证据时核对记录的摘要、序号和 Job Host 身份，不重新检查进程，因为释放事实一经保存不撤销。
- 没有开始记录（例如本次改动之前启动的任务）时，行为和以前一样，继续挡住。

## 测试

代码版本：提交 `80cf668` 加本次改动（即本证据所在提交）。以下命令由 Claude 在命令沙箱之外运行，因为测试要在 `/tmp` 下建目录并调用 `/bin/ps`，沙箱不允许；真实探针运行前执行了 `npm run build:node`。

```sh
npx vitest run --config vitest.workspace.ts --project unit --reporter verbose packages/runtime-sandbox/test apps/agent-service/test
npx vitest run --config vitest.workspace.ts --project integration --reporter verbose test/integration/sandbox-control-evidence.test.ts test/integration/workspace/workspace-boundaries.test.ts
node packages/runtime-sandbox/scripts/probe-job-host-control.mjs
```

| 测试 | 断言 | 结果 |
| --- | --- | --- |
| [`sandbox-control-evidence.test.ts`](../../../../integration/sandbox-control-evidence.test.ts) 新增 9 个场景，替换原来的“崩溃但没重启就继续挡住” | 用真实进程充当 Job Host 和任务组长，写真实签名的开始记录后关闭控制通道。Job Host 和进程组都消失、Job Host 启动标记不符、组长启动标记不符时，inspect 和 stop 都释放为 `process_group_gone`，不发停止，复核接受、改成 `confirmed` 被拒绝；Job Host 仍在、组长仍在、组长退出但组员还在时继续挡住，去掉挡住的原因（结束 Job Host、结束进程组）后下一次核查释放；没有开始记录时继续挡住；记录来自别的 Job Host 报 `SANDBOX_CONTROL_IDENTITY_CHANGED`；记录被篡改报 `JOB_HOST_CONTROL_EVIDENCE_INVALID` | [`integration.log`](integration.log)：286 项通过（含 [`workspace-boundaries.test.ts`](../../../../integration/workspace/workspace-boundaries.test.ts) 的导出列表） |
| [`process-identity.unit.test.ts`](../../../../../packages/runtime-sandbox/test/process-identity.unit.test.ts) 5 项 | 本机进程连续两次读到相同标记；已退出并被回收的进程读不到标记；组长退出后组员还在时进程组仍算存在，结束后不存在；非法编号和不支持的平台报错 | [`unit.log`](unit.log)：636 项通过 |
| [`job-host-main.unit.test.ts`](../../../../../packages/runtime-sandbox/test/job-host-main.unit.test.ts) 新增 5 项 | Linux 和 Mac 任务启动后都写开始记录，内容含 Job Host 和组长的标记；组长已不在、读不出标记、写入失败时任务照常运行并正常结束 | 同上 |
| 真实 Mac Job Host 和 SRT：[`probe-job-host-control.mjs`](../../../../../packages/runtime-sandbox/scripts/probe-job-host-control.mjs) 新增 `host-crash` 场景 | 任务运行中强制结束真实 Job Host；开始记录的 Job Host 编号和两个标记与 `ps` 读到的一致；Job Host 死后任务进程组仍在（Worker 不替它清理），产品核查继续挡住；结束进程组后核查释放为 `process_group_gone`，复核接受 | [`mac-job-host-control-run2.log`](mac-job-host-control-run2.log)、[`mac-job-host-control-run3.log`](mac-job-host-control-run3.log)：8 个场景全部通过，原有 7 个场景结果不变 |

- 实现前，新增测试按预期失败：集成测试 8 个场景失败，只有“没有开始记录”通过，因为旧代码本来就一律挡住（[`integration-before.log`](integration-before.log)）；Job Host 单元测试 3 项失败，因为没有写开始记录（[`unit-job-host-before.log`](unit-job-host-before.log)）；`process-identity` 单元测试因模块不存在而失败（输出未存档）。
- 真实探针第一次运行在第一个场景（`stop`，与本次改动无关的准备阶段）失败，Worker 报 `JOB_HOST_NOT_READY`，见 [`mac-job-host-control-run1-failed.log`](mac-job-host-control-run1-failed.log)。Job Host 的错误输出被产品丢弃，当时没有拿到原因。随后检查 SRT 依赖正常；临时让构建产物转发 Job Host 错误输出后重跑通过，然后重新构建去掉这处临时改动，又连续两次通过（第 2 次紧接在重新构建之后）。原因未确认。
- `npm run typecheck`、`npm run lint`、`npm run check:boundaries`、`npm run check:ci-policy`、`npm run check:secrets` 通过。日志去掉了终端颜色控制字符和本机沙箱打印的 `failed to copy trust settings` 行。

## 完整 npm test（提交 `7f9ad63`，通过）

由用户在本机终端运行 `npm test -- --output .ci-output/npm-test-7f9ad63`，全部通过：contracts 379 项、unit 2060 项、integration 1842 项、e2e 3 项、pi-compat 130 项，报告在 [`npm-test-7f9ad63.tar.gz`](npm-test-7f9ad63.tar.gz)。`7f9ad63` 在本次提交 `fa3fef3` 之后只多了一个完整测试打包核对忽略 `.DS_Store` 的改动（见[那次改动的记录](../../ci-finder-ds-store-2026-09-27/README.md)），所以这次结果也覆盖本次提交。控制台输出去掉了本机沙箱打印的、与测试无关的 `failed to copy trust settings` 行。

## 未验证的部分

- 没有在 Linux 上运行。Linux 上 SRT 用 bubblewrap 并要求“父进程退出时随之退出”，Job Host 崩溃后任务一般会被系统一并结束；探针在这种情况下跳过“继续挡住”的检查，直接要求释放。
- “组长编号已分给新进程”只用写入不同标记的方式模拟，没有真正等到系统复用进程编号。
- 开始记录在任务启动后才写，这之间 Job Host 崩溃时没有开始记录，占用继续挡住，需要重启或删除旧记录的命令处理。
