# P6 统一执行状态首批接入证据

对应 [实施记录](../../../../../docs/execution/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p6-unified-state)。本批将已有 Run/Trace 事实接入独立状态查询及生产页面，不代表完整 P6、全部资源阶段或 68 项验收完成。

- [定向验证](targeted-final.log)：6 文件、227 项通过，包含真实 SQLite worker/direct、Gateway adapter、协议兼容、分页/并行/版本变化和页面消费。
- [真实 Chrome 回归](browser/result.json)：12 个场景通过，其中新增 8 个检查四种宽度、实际明暗主题、状态刷新不依赖新 Trace、完成事实在断线重开后保留。使用隔离 HTTP 夹具，不调用真实模型或 Worker。
- [浏览器构建](browser-build.log)、[类型检查](typecheck.log)、[范围 lint](lint.log)及边界/覆盖/不变量/秘密/CI policy 检查分别保留日志。
- [冻结源码输入](source-freeze.json)：本批标准构建前的 1,094 个输入摘要。文档和验证证据不属于该源码集合；`AGENTS.md` 和已有其他任务文件只保留原状。
- [完整标准运行日志](standard-ci-final-03.log)：[最终标准结果](standard-ci-result.json)为 245 文件、3,859 项全部通过，零失败、零跳过；[构建结果](build-result.json)通过。构建产物 SHA-256 为 `fd6caa190b901a714f1c5ef6691ba8408b7797f27d9d36046ae2cc6cb231a7e1`。
- [取消状态失败回归](cancellation-red.log)证明 `Run.cancelled` 曾误报资源已停止；[修复后状态测试](cancellation-green.log)14 项通过。保留已成功操作与清理动作，整体状态在缺少资源证明时为未知。旧候选标准运行已停止且两个进程组独立读回为空，见[停止记录](initial-ci.json)；最终标准运行目录为 `.ci-output/p6-unified-state-03`。
- [初次定向失败](initial-targeted.log)：页面接入遗漏 `operation` 局部变量导致 1 项失败；补上后原测试与新增回归通过。这是本批开发期间的接入错误，不是修改前历史缺陷的复现。
- [浏览器环境错误](browser.log)：未安装 Playwright 自带 Chromium。首次现有 Chrome 启动也受沙箱限制，随后经审批使用隔离 Chrome 运行成功，不为此安装或替换浏览器。
- 初次合同夹具使用无毫秒时间戳，按既有严格合同修正夹具。视觉复核发现系统明暗偏好不会覆盖页面保存的主题，持久测试现显式设置并断言页面主题；同时修复未知状态错误沿用“可停止”提示。

`effectSummary` 是操作 outcome，不是文件无副作用或资源已释放的证明。新查询不授予执行权，不重放工具，超预算或版本变化明确拒绝聚合。原事件查询及未声明新能力的旧服务兼容路径保留。资源 journal、队列、保存、目录改名、全部会话注意状态和其余阶段计时仍待后续接入。

最终类型与任务范围 lint 通过（51 条信息级提示，零错误/警告）；边界、覆盖、不变量、秘密和 CI policy 检查通过。四份 Runbook 封存并通过检查，严格文档检查通过。全库 `npm run check` 仅在两份既有未跟踪原型的格式检查失败，详见[检查汇总](checks-result.json)，没有修改这些文件。最终源码回读 1,094 项未变，见[输入验证](source-verification.json)。

为通过 Git 空白检查，部分文本日志只去除行尾空白和末尾空行；原始字节以 gzip 保存在 `raw/`，对应摘要与转换记录位于 `log-normalization.json`。失败原因、断言、计数和执行结论未改写。

提交前复核发现 Stop 条件误用于发送限制：[失败回归](send-guard-red.log)复现活动 Run 无 Stop 时发送按钮错误启用；恢复独立的非终态 Run 判断后，[41 项交互测试](send-guard-green.log)通过，[12 个 Chrome 场景](browser-chrome-final-03.log)通过。第二次标准运行是此修复前结果，保留于 `standard-ci-result-before-send-guard.json`。
