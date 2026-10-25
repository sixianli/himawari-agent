# P1 平台停止与预约释放证据

2026-09-20 在 Mac 与 Hermes Linux 实测。产品基线为 `5ed9f89`；本批只增强现有探针，没有修改生产实现。输入摘要、探针增量摘要与最终 JSON 见 [result.json](result.json)。

| 检查 | Mac | Linux |
| --- | --- | --- |
| 七项真实 JobHost 场景 | 通过；已启动任务 cleanup unknown | 通过；namespace 退出后 cleanup confirmed |
| 脱离进程组的后代持续写入后 Stop | 观察后 300ms 仍增加 30 字节 | 确认释放后 300ms 增加 0 字节 |
| 相同后代写入后 Worker 崩溃 | 观察后 300ms 仍增加 30 字节 | 确认释放后 300ms 增加 0 字节 |
| 构建产品执行前竞争预约 | 拒绝 | 拒绝 |
| 构建产品执行后竞争预约 | 未释放，仍拒绝 | 永久释放凭据存在，预约成功并独立读回 |
| 重复 Worker 执行 | 未再次执行 | 未再次执行 |

这里的“通过”是符合保守安全合同。Mac 实际存在未停止的后代，不能宣称完成完整停止能力。子进程仅操作合成文件，最长存活 4 秒。探针等待其寿命上限后清理专属目录。Linux 的文件稳定观察是 namespace 生存期证据的补充，不是独立的完整进程树证明。

## 复现入口

两端使用 Node 22.22.3；Linux 依赖由 npm 11.8.0 在独立目录安装，避免复制 Mac 原生模块。先执行仓库既有 `npm run build:node`，再运行：

```sh
node packages/runtime-sandbox/scripts/probe-job-host-control.mjs
HIMAWARI_LIVE_SANDBOX_PROBE=1 HIMAWARI_QUALIFY_INSTALLED_RUNTIME="$PWD/dist/node-runtime" node packages/runtime-sandbox/scripts/qualify-production.mjs --v2
```

Linux 首条命令额外设 `HIMAWARI_R4_HELPERS=/usr/bin`，用于探针读取系统已有 bwrap/socat 的工具目录。Mac 沙箱探针经许可在原生宿主运行，未通过弱化产品策略绕过限制。

Hermes 工作目录为 `/data/hermes/himawari/builds/2026-09-20-workspace-lifecycle-5ed9f89/source`，TMPDIR 位于同一任务根目录的 `tmp`。先确认 `/data` 为独立 ext4 数据盘且有容量，再上传带 SHA-256 校验的源码归档，执行原依赖安装脚本和 build:node。源清单为 [linux-source-manifest.json](linux-source-manifest.json)；之后只同步两个增强探针，增量 SHA-256 经 [Linux 独立读回](linux-readback.log)确认。

## 证据边界与验证

- [Mac 后代探针](mac-descendant-writer.log)、[Linux 后代探针](linux-descendant-writer.log)使用真实进程、SRT、控制协议及产品证据核验器；安装资格和 artifact 存储为夹具。
- [Mac 构建产品路径](mac-workspace-protection.log)、[Linux 构建产品路径](linux-workspace-protection.log)使用真实编译产物、Worker、认证 UDS、SQLite 和释放核验。安装资格与 runner 为受控夹具，`productionSuitable=false`。
- 后代写入与竞争预约是不同探针，没有执行第二个并发 writer；不能将两者拼成已覆盖全部跨 Worker 并发验收。
- 两端 build:node、类型检查、探针 stdout 回归、任务范围格式/lint、边界、覆盖映射、不变量、秘密扫描和 CI policy 已执行。产品源码未改，复用 [前批完整标准验证](../p1-recovery-01/standard-ci-result.json)的 3,709 项测试结果，不宣称本批重新跑过全部测试。
- 前批全库格式/lint 被预先存在的未跟踪原型脚本阻断，本批保持这些无关文件不变。
- Linux 预检最后一次试读旧目录因路径不存在返回非零；数据盘、容量和已用工具链随后直接验证，未使用缺失路径。依赖安装日志中的上游 audit 建议没有自动执行。
- 测试临时目录已清理；Linux `tmp` 仅保留 Node 编译缓存，构建目录与证据保留。没有模型调用、生产部署、生产数据修改或生产权限变更。

日志归档仅移除了 tooling/typecheck 输出末尾的空白行，测试内容未改。Hermes 升级 Runbook 的探针合同摘要随本次增强失效，完成语义核对后由治理工具重新封存；未执行生产步骤。
