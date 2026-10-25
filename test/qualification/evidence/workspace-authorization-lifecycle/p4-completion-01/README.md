# P4 完成验收

[返回 Plan](../../../../../docs/archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p4-completed) · [Spec](../../../../../docs/execution/specs/2026-09-16-workspace-authorization-lifecycle-design.md#optional-workcopies)

## 实现与可观察结果

- Owner 创建/选择/准备仍沿用既有生产入口；新增 `save_copy` 将已准备的单个差异送入原 Pi 工具循环、ActionPolicy、Run/Handle、持久队列及固定 Worker。四类操作仅要求本次 read + create/update/move/trash；trash 按 `DELETE` 处理。未启用旧 `host.file.execute`。
- 文件内容、操作快照和依赖在排队前准备，提交时不重新暂存内容。目标及必要依赖一次取得占用；取消、撤权或版本变化阻止旧请求继续。副本运行或等待确认不占原目录提交权。
- 复用 `FileOperationService` 和 P3 固定程序持久记录。文件已改变、最终 checkpoint 丢失时，恢复仅核验原 inode/摘要；结果重复读取及后续用户编辑不会触发再次写入。各文件独立记录，已保存项不因后续失败而回滚。
- 普通目录、Git dirty/untracked 输入及不整目录覆盖，复用 `workspace-copy.test.ts`、前批 SRT 副本隔离验收和本批真正 `WorkspaceCopyService` 生产消费者。当前范围不新增任意 Git index、共享数据库或远端对象写入；这些对象不能借文件 claim 获得权限。

## 验证范围

| 入口 | 结果与证明范围 |
| --- | --- |
| 定向集成 | 6 文件/172 项通过，覆盖保存、准入、文件副本、Worker 生命周期及控制证据 |
| 相关消费者 | 6 文件/198 项通过，覆盖 Pi 工具、固定发布记录、效果核验和原文件工作流 |
| 资源与原副本入口 | 3 文件/51 项通过；后台资源、队列、终态恢复和页面资源投影不因保存扩展而变化 |
| 真正副本准备消费者 | 13 项通过；使用真实文件、受保护 Payload、SQLite、`WorkspaceCopyService` 和原生产准入服务 |
| Mac / Hermes 实际执行 | 两个平台分别实际执行 create/update/move/trash，Agent 交付 succeeded，supervision=released、cleanup=confirmed；参见 [Mac 结果](macos-results.json) / [Linux 结果](linux-results.json) |
| 最终副本生产消费者 | [Mac 最终安装包](macos-copy-flow.json)与[Hermes 最终源码安装](linux-copy-flow.json)均完成真实副本准备、保存及 Agent 交付；原配置 Mac 最终用例 68.68 秒通过 |
| 冻结与最终构建 | [25 项源码/测试冻结](source-freeze.json)，[最终 CI 安装产物摘要](artifact-input.json)；标准构建及 256 文件/4,128 项全部通过，0 失败/0 跳过；见[标准摘要](local-summary.json)与[数量读回](test-counts.json) |

实际平台测试每次用 `-t` 选择一种操作，日志中的其他 12 项属于未选择；标准测试执行全部用例。平台环境使用受控资格声明，未签发生产资格，也未改变生产安装、账号、模型或数据库。Worker 的初始通知可能为 `result_unknown`；成功结论来自 Agent 重新核验及 `completeToolResult` 的持久交付，而非该初始通知。旧 Mac 任意 Bash 副本任务的 cleanup=unknown 保持原记录，不能用本批固定保存程序的释放证明替代。

端口/外部对象按实际支持范围核对：SRT 不开放宿主 TCP 监听和任意 Unix socket，服务就绪 socket 位于任务私有目录；`.git` 与产品数据库不由文件副本授权。远端请求的网络授权、调用回执和未知效果不重发规则保持独立；本批没有声称为任意外部数据库提供事务或互斥。后台服务仍沿用原可发现 owner 和资源恢复记录。

## 失败记录与修正

1. 初始测试夹具把产品权威对象当作 `commitStateAndEvents` 所需的 lease fence，并错用 `prepareMove` 参数名；核对准确签名后修正夹具，未修改产品权威检查。
2. 直接调用底层 `reserve` 不执行外部文件重验；回归改为实际派发前使用的 `runtime.prepare` 队列重验路径，原测试对错误边界的断言不计作产品缺陷。
3. 首次实际 Mac 检查误用普通 fixture 的 3 秒 UDS 连接重复解析；让正式 Worker 通过已有 60 秒客户端解析，未扩大产品期限。
4. 最终产物复验首次引用了 CI 构建后会清理的内部工作目录，收到 ENOENT；改为核对已发布归档摘要并使用原 CI 安全解包器取得稳定安装目录。
5. 安装包额外复验有一次停留在 reserved，未取得具体异常；临时配置只在原 Worker catch 增加日志，随后同路径实际保存、核验与释放成功，但一轮整体验收超过既有 120 秒期限。诊断复验继而通过；保留这些失败，首次 reserved 的原因仍未确认，不能把后续通过写成根因已经修复。标准测试结束后再以原配置验收，未增加超时或放宽断言。

失败和通过日志统一保存在 `raw-logs.tar.gz`，使用原 CI 归档工具、脱敏及安全解包逐字节读回。没有重跑此前已通过且输入未变化的整套测试；本批完整标准验证在关键路径、消费者和平台验收通过后启动。

类型、范围内格式/检查、边界、需求覆盖、不变量、CI policy、四份 Runbook 静态合同和严格文档检查通过。实际 `npm run check` 被两份原有未跟踪原型脚本 `docs/assets/control-center/2026-09-16-state-review{,-r2}/verify.cjs` 的格式问题阻挡；未将总入口报告为通过。冻结摘要绑定基准提交加本批未提交输入，CI 的 testedSha 仍为基准提交；本次提交包含相同的冻结源码，不能将基准 SHA 误读为仅测试旧代码。
