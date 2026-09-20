# P6 一致资源快照证据

对应[实施记录](../../../../../docs/execution/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p6-resource-inventory)。本批新增内部只读端口，尚未接到页面状态，不代表完整 P6 或整个 Plan 完成。

- [失败前](inventory-red.log)：新需求回归因接口尚不存在而失败，不是历史产品缺陷的复现。
- [首个通过结果](inventory-first-green.log)：同一 Run 的队列/预约/绑定、重复读、跨 Agent 和重开仓库读取通过。
- [完整定向结果](targeted.log)：3 文件、54 项通过，补充取消历史、旧格式占用、非法 locator、身份异常和 10,001 条队列拒绝。超量数据只写入隔离测试数据库。
- [冻结输入](source-freeze.json)：标准构建前 1,094 项源码/配置输入摘要；不包含文档和证据。

新接口在同一个 SQLite 只读事务中读取当前 journal、队列和旧格式占用；不是新的权限入口，不派发、不清理、不消费使用次数。生产仓库端口重开读回已验证；没有将独立持久层验证称作 Gateway→Worker→页面的完整联合验收。没有运行真实 provider 或部署。

最终[标准构建](standard-ci-build-result.json)与[标准测试](standard-ci-result.json)均通过：245 文件、3,862 项，零失败、零跳过。[本地汇总](standard-ci-summary.json)为 `local_passed`；这不是托管 CI 或双平台资格。[冻结输入回读](freeze-check-final.json)确认 1,094 项均未变化，可复用该次运行。原有 r1/r2 未跟踪原型的格式问题仍单独记录于检查汇总，不宣称全库 check 通过。

日志提交检查发现末尾空白；仅规范化可读日志的行尾空白与文件尾空行，原始字节保存在同名 `.raw.gz`，摘要与变换清单见 [log-normalization.json](log-normalization.json)。未改写失败原因、测试计数或结果。
