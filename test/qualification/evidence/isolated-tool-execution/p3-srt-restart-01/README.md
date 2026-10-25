# SRT 模式：机器重启后按开机标识释放

日期：2026-09-26 UTC。对应[隔离执行实施计划的 P3 补充](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p3-modes)第一项的剩余部分，规则见 [Spec 的 SRT 模式的停止与释放](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#srt-release)第 6 条。上一步“进程组消失即释放”的记录见 [p3-srt-release-01](../p3-srt-release-01/README.md)。

## 用词

| 用词 | 意思 |
| --- | --- |
| 开机标识 | 操作系统每次启动时新生成、运行期间不变的编号：macOS 的 `kern.bootsessionuuid`，Linux 的 `/proc/sys/kernel/random/boot_id` |
| Job Host | 产品自己的监督进程，每次工具调用启动一个，在 SRT（进程级沙箱）限制下运行工具程序 |
| `process_group_gone` | 释放记录里的清理依据，含义是“停止未经严格确认”：任务进程组已不存在，离开进程组的后代不被跟踪 |

## 改了什么

- 新增 [`readMachineBootId`](../../../../../packages/runtime-sandbox/src/machine-boot.ts)，读取本机开机标识，只接受标准 UUID 格式，其他平台明确报 `MACHINE_BOOT_ID_UNAVAILABLE`。
- Agent（[`production-sandbox-control.ts`](../../../../../apps/agent-service/src/production-sandbox-control.ts)）登记 Job Host 时同时保存开机标识。之后每次核查先比较开机标识：变了说明机器重启过，原进程组必然已不存在，于是不联系原 Job Host，保存一份“登记时的标识、现在的标识”记录，并把资源记为 `released`、依据 `process_group_gone`。复核证据时重新读取开机标识，确认仍与登记时不同，并核对记录的摘要、序号和进程身份。
- 继续挡住目录的情况：Job Host 崩溃但机器没有重启；本次改动之前登记、没有保存开机标识的旧记录（交给删除旧记录的命令处理）。

## 测试

三条命令都由用户在本机终端运行（Claude 的命令沙箱不允许 `/tmp` 临时目录和 `sysctl`）。代码版本：提交 `27915f4` 加本次未提交的改动（即本证据所在提交），运行前已执行 `npm run build:node`。

```sh
npx vitest run --config vitest.workspace.ts --project integration test/integration/sandbox-control-evidence.test.ts 2>&1 | tee test/qualification/evidence/isolated-tool-execution/p3-srt-restart-01/sandbox-control-evidence.log
npx vitest run --config vitest.workspace.ts --project unit packages/runtime-sandbox/test/machine-boot.unit.test.ts 2>&1 | tee test/qualification/evidence/isolated-tool-execution/p3-srt-restart-01/machine-boot.log
node packages/runtime-sandbox/scripts/probe-job-host-control.mjs 2>&1 | tee test/qualification/evidence/isolated-tool-execution/p3-srt-restart-01/mac-job-host-control.log
```

- [`sandbox-control-evidence.log`](sandbox-control-evidence.log)：61 项通过，其中新增 4 项：重启后 inspect 和 stop 都按 `process_group_gone` 释放且不向原 Job Host 发停止；复核拒绝把依据改成 `confirmed`；Job Host 崩溃而没有重启时继续挡住；没有开机标识的旧登记在重启后继续挡住。测试里的开机标识由测试提供。
- [`machine-boot.log`](machine-boot.log)：2 项通过；本机 macOS 读到合法的开机标识，连续两次读取相同。
- [`mac-job-host-control.log`](mac-job-host-control.log)：真实 Job Host 和 SRT 的 7 个场景全部通过，登记时读取开机标识不影响原有路径；两个写入程序场景在释放后又写入 30 和 28 字节，属于已接受的风险。

## 完整 npm test（提交 `d5b22e9`）

由用户在本机终端运行 `npm test -- --output .ci-output/npm-test-d5b22e9-3`，全部通过：contracts 379 项、unit 2046 项、integration 1822 项、e2e 3 项、pi-compat 130 项，报告在 [`npm-test-d5b22e9.tar.gz`](npm-test-d5b22e9.tar.gz)。

在这之前：`b40b4ef` 的 CI 规则检查不允许条件跳过的测试写法 `it.runIf`，由 `3d9a074` 改正；`3d9a074` 的完整测试有 1 项失败，原因是 [`workspace-boundaries.test.ts`](../../../../integration/workspace/workspace-boundaries.test.ts) 固定了 `@himawari-agent/runtime-sandbox/control` 的导出列表，由 `d5b22e9` 补上 `readMachineBootId`。`d5b22e9` 的前两次运行（输出目录 `npm-test-d5b22e9`、`npm-test-d5b22e9-2`，未存档）在打包阶段失败，没有执行测试：访达在构建目录各层（最深到 `node_modules`）写入了 `.DS_Store`（访达记录文件夹显示设置的文件），产物校验报 `ARTIFACT_CONTENT_MISMATCH`，清理报 `ENOTEMPTY`。关闭访达窗口后重跑通过。

## 未验证的部分

- 没有真正重启机器验证“重启后开机标识不同、记录被释放”；这一点只由注入开机标识的测试覆盖。
- 没有在 Linux 上运行。
- 还没有登记为 Job Host 的预约（从未启动）在重启后仍按原来的规则处理，这次没有改。
