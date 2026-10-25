# P2：出队与派发前的现时权限检查

本批修复 Worker 接收 Handle 的异步等待后，发送执行请求前遗漏 Grant、冻结目标和最新资源预算的检查。保留批准历史、原期限、调用回执及已经承诺的额度；零执行消息不是宿主释放证明。

- 原始缺陷复现：`himawari-dispatch-revalidation-before.log` 中 8 项原回归通过，新增撤销和目录替换两项均错误发送 1 条 `work.execute`。
- 预算复现：`himawari-dispatch-matrix-valid-before.log` 中预算收紧后仍发送执行消息；同次的取消失败源自错误的测试 Payload，不作为产品缺陷。修正为真实 Run 的 `restart-prompt`，并要求状态改变确实完成。
- 测试修正：旧 fixture 的 Run revision 为 0，不能调用真实生命周期读取；改为真实消息与 Run 创建流程。`himawari-dispatch-matrix-before.log` 保留该夹具失败，不计入缺陷复现。
- 最终定向矩阵：22 项通过。七种变化分别放在排队后与 Worker 接收 Handle 后；另外八项保留合法派发、并发、重入和 fence/boot 恢复的正向控制。使用真实 SQLite、加密 Payload、Action Grant、额度预约和目录身份；Run 取消走正式生命周期入口；Worker 传输和策略状态编辑是受控边界。
- 每个拒绝场景读回零执行消息、审批历史不变、消费回执/usage 数量；准入已提交时预约仍为 committed，不制造释放回执。任务截止与 Run 终止仍由原生命周期清理无消费预约，不能把这组服务层测试当作完整浏览器取消流程。
- 235 项相关消费者回归、类型、任务范围 Biome、边界、v0.2 覆盖/不变量、secret 扫描与 CI policy 均通过。四份运行手册按实际差异更新并重新核对静态合同。
- 完整标准构建通过（194,246 ms），251 文件、4,053 项标准测试通过（783,572 ms），零失败、零跳过。本地平台为 macos-arm64；GitHub hosted gate 未执行。正式报告为[构建结果](standard-build-result.json)、[完整测试结果](standard-test-result.json)和[本地总报告](standard-local-summary.json)。
- 冻结的 1,089 个源码、测试及构建输入见 [frozen-inputs.json](frozen-inputs.json)，交付前逐一读回；同时使用既有 artifact 验证器的源树摘要核对构建产物，覆盖实际构建的未跟踪输入。testedSha 为 `e29cfa7` 加本批未提交改动，不能解释为仅测试该提交。

这不是生产部署、GitHub 托管 CI、真实双设备浏览器、付费模型或现场平台资格证明。原有未跟踪原型导致全仓库格式/lint 阻塞，未修改用户原型；任务范围检查单独报告。

主要复现入口：

```sh
npx vitest run --config vitest.workspace.ts --project integration test/integration/production-sandbox-queue-reentry.test.ts
node scripts/ci/local.mjs --check test --output .ci-output/p2-dispatch-revalidation-01
```

完整检查目录不允许覆盖，重跑时必须选择新的输出目录。原日志归档使用仓库现有 `scripts/ci/artifact-archive.py`；交付时校验解压字节、摘要与拒绝重复覆盖。

原日志在[证据归档](raw-logs.tar.gz)，包括缺陷复现、夹具修正、定向验证、全仓库静态阻塞和标准测试 JSON/JUnit。[验证元数据](verification.json)记录逐文件字节数和 SHA-256、归档读回、重复覆盖拒绝及源码一致性。标准构建归档仍保留在 `.ci-output/p2-dispatch-revalidation-01/`；本证据包保存报告及摘要，不重复复制整个运行时产物。
