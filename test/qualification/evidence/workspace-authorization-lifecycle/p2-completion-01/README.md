# P2 完成验收

本次按用户要求，以 P2 六项全部完成为交付边界。前五项生产实现沿用 `3ece389`，本批只扩展现有资格探针与测试，不新增运行时接口或权限。

| P2 原待办 | 本次核对的证据 |
| --- | --- |
| 生产 ActionPolicy/Approval/Grant 路径 | [原队列真实 Worker](../p2-queued-worker-proof-01/README.md)、[单次与范围授权](../p2-scope-continuity-01/README.md) |
| 不可变请求、两端决定与持久顺序 | [审批竞争顺序](../p2-approval-order-01/README.md)，当前生产源码未变 |
| 额度预约、派发承诺、恢复不重复消费 | 本次真实文件写入及重放；原队列记录、Handle/Grant uses 和 reservation 独立读回 |
| 出队及派发前重验 | [派发复核](../p2-dispatch-revalidation-01/README.md)、本次生产当前权限/资源回归 |
| 单次批准与有效范围授权 | [最近完整标准验证](../p2-scope-continuity-01/README.md)，代码未变 |
| 执行中撤销、停止核实、历史效果与同会话反馈 | 本次两种真实撤销/Chrome 联测与文件提交后撤销、重放验收 |

目录 Grant 与操作 Grant 都在真实连接建立、SQLite 投影确认执行中后撤销。实际 Agent/Worker/Job Host、认证 Payload UDS 与当前 scope 核验继续运行；撤销后 scope 被拒绝、原审批与 uses 不变、原保护输出可读回。执行记录文件的内容、inode、mtime 与 ctime 不变，重新调用及重建 Worker 不再次执行。最终目录撤销到停止观察为 143 ms，操作 Grant 为 191 ms；这是本次测量，不是保证的延迟上限。

Chrome 沿用原资格入口，导航与网关传输为隔离夹具，执行状态来自实际 SQLite 投影；没有在撤销后补造 Trace 或资源事件。页面保持原会话，“正在执行”转为“结果未确认”，红点与实际 needsAttention 一致，刷新保留原效果摘要，无新独立审批入口。报告与截图见[目录撤销](directory-final/result.json)和[操作 Grant 撤销](action-final/result.json)。

Mac 的观察仍是 cleanup=unknown、workspaceBlocked=true，没有永久释放回执。P2 要求的阻断、停止请求和核验已经执行；不能证明全部后代退出时继续保持占用。P1 平台停止/释放资格、P6 完整生产登录/模型/网关联测和 P7 部署仍按原 Plan 验收，不能由 P2 完成推断它们已完成。

真实文件路径沿用原 Pi→ActionPolicy→SQLite→实际 Worker/Job Host→受限文件写入。显式撤销已提交文件的 Grant 后，实际文件内容与身份保持，原审批不变，当前 scope 拒绝，旧 fence 被拒绝、重放不再次写入，uses 仍为 1。模型和安装资格为受控输入；没有调用付费模型。

复现时先取已通过校验的安装包，将运行时和浏览器目录放入以下变量；此入口新增运行时路径选择，避免误用旧 dist 目录：

```sh
HIMAWARI_LIVE_SANDBOX_PROBE=1 HIMAWARI_QUALIFY_INSTALLED_RUNTIME=/path/to/verified/runtime HIMAWARI_BROWSER_STATIC_ROOT=/path/to/verified/browser node packages/runtime-sandbox/scripts/qualify-production.mjs --v2 --revoke-directory --browser-output /path/to/new/directory-evidence
HIMAWARI_LIVE_SANDBOX_PROBE=1 HIMAWARI_QUALIFY_INSTALLED_RUNTIME=/path/to/verified/runtime HIMAWARI_BROWSER_STATIC_ROOT=/path/to/verified/browser node packages/runtime-sandbox/scripts/qualify-production.mjs --v2 --revoke-network --browser-output /path/to/new/action-evidence
HIMAWARI_LIVE_SANDBOX_PROBE=1 HIMAWARI_QUALIFY_INSTALLED_RUNTIME=/path/to/verified/runtime npx vitest run --config vitest.workspace.ts --project integration test/integration/production-queued-run-restart.test.ts -t 'coding=true.*resume' --testTimeout=240000
```

真实文件资格原来就采用 240 秒测试上限；普通集成模式仍使用原上限。过滤命令选择 1 项，另 9 项 skipped 是选择结果；原 10 项确定性模式另有通过结果。本次曾误用不匹配的过滤词及默认 30 秒上限，分别导致未执行与宿主验证期间超时；已恢复原文档命令并保留日志，不算产品缺陷。Chrome 在受限执行环境启动被 SIGABRT/EPERM 阻止，后续在获准的本地测试执行范围内成功；未修改用户浏览器资料。

最终真实文件资格 1 项通过（9 项为过滤排除），8 文件/307 项相关回归通过；类型、范围 Biome、CI policy、四份 Runbook 静态合同与严格文档检查通过。三个测试文件变化，其余 1,087 个冻结输入不变；复用 [252 文件/4,056 项标准基线与构建](../p2-scope-continuity-01/README.md)，新检查与基线的关系见[组合验证记录](verification.json)。最终探针、初始命令/类型/环境错误和通过日志见[原始归档](raw-logs.tar.gz)，不将这些执行错误算成产品缺陷。全仓库 format/lint 的原有两份未跟踪原型脚本问题仍保留；本批范围检查单列。
