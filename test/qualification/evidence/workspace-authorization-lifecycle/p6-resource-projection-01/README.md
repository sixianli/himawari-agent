# Run 资源与页面状态投影

本批将同主体 Run 的资源快照接入生产 `thread.execution_state`：核对受保护历史 Scope 与外层工具，合并队列和预约，跨读取检查资源及 Run 是否变化。历史核验不续发 Grant；原执行入口仍检查当前权限。既有 v3 阶段枚举保持不变，详细阶段通过 `reasonCode` 表达。

停止、核验和结果未确认不由浏览器时间推断。工具成功与清理状态分别保留；资源已释放但内部结果未交接时仍显示结果未确认。开始前取消须同时有队列和工具未派发证据，空快照不提供该证明。可见会话每两秒读回状态；隐藏或断线停止该轮询，避免仅依赖不覆盖资源变化的会话事件。

验证分为以下边界：

- [生产准备、SQLite 与投影](production-projection-03.log)：队列、预约、同一身份合并、撤销后历史读取、执行拒绝、永久释放回读。使用真实产品服务和 SQLite，宿主释放证明为测试输入，不等同平台核验。
- [内部结果缺失](missing-result-journal-02.log)：两种 SQLite 运行方式均保留永久释放与未交接结果两个事实。初次断言错用了内部工具 ID，修正为夹具明确的外层 parent ID，见[初次结果](missing-result-journal.log)。
- [停止及未知结果投影](queue-cancel-green.log)、[页面定向测试](polling-unit.log)：动作、成功效果、正向未派发证据和隐藏页面不轮询。
- [无事件通知失败证据](browser-silent-red.log)与[修复后浏览器结果](browser-silent-green/result.json)：实际 Chrome、隔离 HTTP 夹具、四档宽度及明暗状态组合，12 个场景；权限、Worker 与文件链路没有因此被宣称为真实端到端验证。
- [首轮标准验证](standard-baseline/tests.json)：246 文件、3,871 项通过，无失败或跳过。这是新增无事件轮询、结果缺失保护及队列取消细分之前的基线；其[输入冻结](input-freeze.json)在首轮结束回读无变化。

最终源码的[标准构建与测试](standard-final/tests.json)通过：246 文件、3,875 项，零失败、零跳过；[1,078 项冻结输入回读](freeze-check-final.json)均未变化。[最终 Chrome 回归](browser-final/result.json)12 场景通过。任务范围格式/lint、类型、边界、不变量、覆盖映射、秘密扫描、CI policy 和严格文档检查通过；四份受影响 Runbook 静态合同通过。全库 check 仍受原有 r1/r2 原型格式问题限制；本地通过不等于 hosted CI 或生产资格。展示日志若仅清理行尾空白，原文保存于相邻 `.raw.gz`，摘要见 [log-normalization.json](log-normalization.json)。

本批尚未完成全部会话注意状态、完整 Worker 文件路径、全阶段计时或 68 项验收。Plan 保持 active。
