# P1 资源恢复错误原因

本批基线为 `e2ac369`，复用原有限恢复服务、真实 SQLite journal 与生产宿主核查适配，不增加迁移或执行权限。

## 已验证行为

- [原因丢失复现](classification-red.log)：两种 SQLite 执行方式中，身份、目录、证据和宿主失败均被原代码改成一般未知，10 项失败；原始诊断和未知机器码的脱敏用例原本通过。
- [控制超时复现](control-timeout-red.log)：真实本机 UDS 接受连接但不返回观察，原代码在尝试读取不存在的最终证明文件后，错误地返回 ENOENT。
- [相关回归](consumers.log)：4 个文件、262 项通过。安全原因保持、未知文字不进入资源记录、单次核查有明确终点、恢复后资源仍保护、并发结果与充分释放事实保持；控制连接超时与整体恢复期限分开。
- 生产宿主核查将原始异常交给原受保护 artifact writer，关联 Job、环境、动作和阶段；受控 writer 的读回证明诊断与公共资源观察分离。生产 writer 对该入口使用 `restricted` 加密 Payload，这一绑定来自源码核查，本批没有运行真实生产数据恢复。

## 命令与边界

```sh
node node_modules/vitest/vitest.mjs run --config vitest.workspace.ts --project integration test/integration/sqlite-sandbox-execution-v2.test.ts test/integration/sandbox-control-evidence.test.ts test/integration/workspace-lifecycle-audit.test.ts test/integration/sandbox-execution-v2.test.ts
npm run typecheck
node scripts/ci/local.mjs --check test --tools .ci-output/tools --output .ci-output/p1-recovery-errors-01
```

数据库、事务、socket 请求和超时是真实执行；监管状态与安装资格仍为夹具。不据此宣称任意进程树已停止、真实平台资格或完整调度已实现。错误不会触发自动工具重发；`unresolved` 表示本次核查结束。

## 最终验证

- [标准构建](standard-ci-build-result.json)通过全部 8 项，包括产物内容、SQLite 和 provider 导入；产物摘要为 `3dc50049a3d4433c5ff3be4452ee71b7a2e009b9611f2226c8d8a1eb886e817a`。
- [标准测试](standard-ci-result.json)：243 个文件、3,769 项全部通过，0 失败、0 跳过；[分组记录](standard-test-projects.json)保留各组统计与进程退出结果。[本地汇总](standard-ci-local-summary.json)为 `local_passed`，不表示 hosted 或生产验收。
- [输入复核](freeze-check-final.json)：1,088 个代码、测试和配置输入未改变；之后只补交付说明。文档与证据不包含在该输入集合。
- [类型检查](typecheck.log)、[任务范围格式/lint](scoped-lint.log)、[边界/覆盖映射/不变量/秘密扫描/CI policy](static.log)、[严格文档检查](docs-final.log)通过。
- [全库 check](full-check.log)在原有未跟踪 r1/r2 原型脚本格式处失败，未改这些文件，也不将任务范围检查等同于全库通过。首次文档检查发现 Hermes 升级 Runbook 选择了整个 Agent 源码目录；补充相同恢复说明并重新封存后通过，初始失败保留于 [docs.log](docs.log)。

日志只清除行尾空白和末尾额外空行，保留失败原因与结果。无数据库迁移、生产部署或模型调用。原 Spec、ADR 与 Worker 合同未更改；Architecture、Plan 和四份受影响 Runbook 与实际实现同步。
