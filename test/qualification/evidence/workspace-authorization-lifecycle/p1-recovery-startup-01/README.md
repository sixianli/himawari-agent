# P1 资源恢复的启动与关闭生命周期

本批基线 `e8e3242`，沿用 Schema 43。补齐已配置沙箱的无 Web 服务资源扫描，并修复服务关闭顺序和明确 stop 被正在等待的 inspect 阻塞的问题。

## 行为与失败前证据

- [无 Web 启动复现](startup-red.log)：6 个新增测试失败，44 个通过，恢复入口未被调用。现在资源扫描在启动登记、Payload 和 Worker 就绪后启动，每次复核权威；启动失败不进入扫描，Web/内置身份模式不重复安装扫描器。
- [Web 关闭顺序复现](web-stop-red.log)：1 个目标用例失败，其余 54 个被名称过滤；等待 Run 中断时尚未调用循环 stop。现在先停止扫描，再等待执行中断和同一次有限 drain。
- [标题消费者清理复现](drain-failure-red.log)：1 个目标用例失败，其余 56 个被过滤；循环 drain 拒绝后未关闭标题消费者。现在 finally 保证清理。
- [明确停止优先级复现](stop-priority-red.log)：worker/direct 两种 SQLite 执行方式各有 1 项失败，另 2 项通过，其余 28 项被过滤。正在 inspect 时新的 stop 被 `Recovery already running` 拒绝。现在明确 stop 可以接替 inspect，恢复 revision 隔离旧检查的迟到写入；已经执行的 stop 仍保持单次派发，旧调度请求不能取得此优先权。
- [最终生命周期回归](lifecycle-complete.log)：3 文件、72 项通过。涵盖单次扫描、按配置限制并发、取消、失去权威、错误退出、有限等待、忽略取消仍报告关闭失败、依赖关闭顺序及标题消费者清理。
- [资源恢复消费者回归](recovery-consumers.log)：3 文件、229 项通过，包含真实 SQLite journal、资源保持及新 revision 独立读回。旧检查完成后，最新记录逐字段不变。

## 验证入口

```sh
node node_modules/vitest/vitest.mjs run --config vitest.workspace.ts --project unit apps/agent-service/test/service-orchestration.unit.test.ts apps/agent-service/test/production-run-dispatch-loop.unit.test.ts apps/agent-service/test/production-service-lifecycle.unit.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.workspace.ts --project integration test/integration/sandbox-resource-recovery-scheduling.test.ts test/integration/sqlite-sandbox-execution-v2.test.ts test/integration/production-sandbox-scope.test.ts
npm run typecheck
node scripts/ci/local.mjs --check test --tools .ci-output/tools --output .ci-output/p1-recovery-startup-01
```

生命周期测试使用真实 service 编排与受控依赖，不代表真实安装环境的进程树资格。资源优先级测试使用真实 SQLite worker/direct 执行，宿主检查/停止受控。未配置沙箱后端、缺少可信宿主身份及 Mac 逃逸后代进程的风险未因此消失；完整业务分类、结果交付恢复与页面动作仍按 Plan 验收。本批没有生产迁移、部署或模型调用。

## 验证结果

类型检查、任务范围格式/lint、边界、覆盖映射、不变量、秘密扫描与 CI policy 已通过。[完整标准构建](standard-ci-build-result.json) 8 项通过，产物摘要 `1e943ffbd2599e0598cc3b041c3a48ecc92bf10f3b0c78e82e1984c25bda9951`。[完整标准测试](standard-ci-result.json)为 244 文件、3,820 项全部通过，零失败、零跳过；[分组执行结果](standard-test-projects.json)均正常退出。[本地汇总](standard-ci-local-summary.json)为 `local_passed`，不包含 hosted gate 或目标平台部署验收。全库 `npm run check` 仍仅有原有两份未跟踪原型 `verify.cjs` 格式错误，见[完整日志](full-check.log)；没有修改这两份原型。

[输入冻结](input-freeze.json)在类型检查通过后记录 1,092 个代码、测试与配置输入。CI 元数据的 testedSha 是冻结时 HEAD；测试实际读取包含本批未提交改动的工作树，不能将结果只归于旧提交。

[最终输入复核](freeze-check-final.json)确认 1,092 个代码、测试与配置输入保持不变。四份受影响 Runbook 已语义核对、封存和检查，见[运行手册记录](runbooks.log)；[严格文档检查](docs-final.log)通过。[链接检查](doc-links.json)检查本地目标存在及显式锚点唯一性，未进行阅读器点击验证。Architecture、Plan 和受影响 Runbook 已更新；Spec、ADR、Worker 合同没有变化。日志仅清除行尾空白和末尾多余空行，失败证据保留。
