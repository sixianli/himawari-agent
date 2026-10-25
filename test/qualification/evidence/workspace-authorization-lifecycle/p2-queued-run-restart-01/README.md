# P2 原队列、原 Pi 批次与中断 Run 续接

本批补齐上批尚未实现的两个入口：安全的 `runtime_running` Run 重新取得租约，以及经过原队列绑定证明的跨 authority Pi continuation 恢复。对应 [Plan 当前批次](../../../../../docs/archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p2-queued-run-restart)。P2 复合待办与完整产品验收仍未完成。

## 实现与验证边界

- Pi 0.84.2 继续负责顺序工具调用、`capturePiToolBatch` / `restorePiToolBatch` 和已完成结果复用。Himawari 保存原受保护批次关联，复用原队列、Handle、授权预约和准入事务；没有第二套工具协议。
- 只有一个未准入、无调用回执、无执行记录且原恢复 Payload 可用的队列使中断 Run 可重新 claim。调度与 checkpoint 读取使用同一判断；这只是重新核验的入口，不是执行授权。旧记录没有关联时仍须核对，不能补造安全证据。
- 当前租约取得后，生产装配先验证原 Scope、目标、Grant 与期限，再绑定当前执行权。加载 continuation 时只允许经该原队列证明的 authority 变化，其余输入必须一致。私有 coding/file Handle 还须核对原外层调用、原恢复引用和受保护父子 Scope。
- Schema 45 增加原批次关联写入校验与 writer 屏障。Schema 44 历史保持原样；旧 writer 不能接管新恢复语义。

[生产恢复回归](../../../../integration/production-queued-run-restart.test.ts)实际使用 ThreadCommandService、RunExecutionInputService、RunCoordinator、Pi、ProductionRuntimeTools、ActionPolicy、ApprovalService、Handle 服务和 SQLite。原调用真实入队后，测试暂停旧执行，调用原 Authority/Run Lease 接口改变执行权，关闭并重开数据库，重建生产服务，让两个 production dispatcher 竞争。

10 项用例覆盖显式 Handle、外层 coding/bash、已取消、已准入、已有回执、恢复内容不可用、模型变化、工具列表变化、只改变 boot、Grant 撤销。测试独立读回原队列 JSON、顺序、期限以及 Handle/Grant 次数；coding 仍只有一次批准和一个私有 Handle，同一预约从 reserved 变成 committed；批次中已完成的受控工具不会再调用。竞争输家和旧租约不能派发，未知结果不能再次 claim。

**被替代的边界：**模型使用本地 Faux provider；Worker transport 记录实际 `work.execute` 后返回受控取消/未知结果，因此证据是“至多派发一次”，不是“真实命令执行一次”。批准使用真实批准服务，但 owner 决定由测试直接提交。未杀死操作系统 Agent 进程，未启动真实 Worker JobHost，未验证真实文件效果或登录页面。两阶段文件读取的已知 inspection 复用有工作流单元回归，尚无该完整联合路径。

## 失败与修正

失败前日志 `himawari-queued-run-red.log` 确认原模型批次已生成、checkpoint 为 `runtime_running`、队列真实存在且未派发；数据库重开后 `listClaimable` 返回空。之前无效 Run revision、租约和消息引用造成的 fixture 错误不算产品缺陷证据；fixture 已改用真实 Thread 消息与 Run 生命周期接口。

开发中曾为 file inspection 添加独立结果缓存，既有损坏 Worker 元数据回归暴露它会绕过原始结果检查。该缓存已移除；恢复现在核对原受保护 intent 的调用摘要，并读取既有 canonical result artifact。原有四项损坏元数据拒绝断言保留并通过。该次失败未保存独立完整日志，不把它算入原始日志归档。

原生 SQLite worker loader 要求内部源码导入使用 `.ts`；修正了新增模块的导入后重跑实际集成。CI policy 初次拒绝新测试多余的第三个 timeout 参数；移除冗余参数，沿用项目已有 30 秒上限，没有改变 policy 或弱化断言。

## 检查结果

定向结果：主路径最终 10 项；相关集成 7 文件/297 项（其中包含主路径当时的 8 项，不能与最终 10 项相加作为总数）；迁移 28 项；工作流 59 项；只读审计与恢复调度 62 项。最终类型检查与任务范围 Biome 通过。

全库 `npm run check` 在原有两份未跟踪原型 `verify.cjs` 的格式检查失败；独立 lint 也只报告这两份文件的 `noInnerDeclarations` 错误。未修改这些既有用户文件，不能报告全库 check 通过。

[标准构建](standard-build-result.json)与[完整标准测试](standard-test-result.json)均通过：250 文件、4,024 项，零失败、零跳过；[本地总报告](standard-local-summary.json)为 local_passed。构建用时 200,337 ms，测试用时 835,661 ms。[1,024 个冻结输入](frozen-inputs.json)回读全部未变。报告中的 testedSha 是带本批未提交改动的基线 `5bc5ba7`，不能解释为只测试了该提交。

五份 Runbook 已语义核对并静态封存，严格文档检查零警告；604 个本地链接目标与 44 个 Plan 显式锚点已静态检查，未声称实际点击验证。[验证摘要](verification.json)记录检查结果与边界；原始日志归档在下方记录。没有执行付费模型调用、生产数据迁移或远端变更。

[原始日志归档](raw-logs.tar.gz)保存本批 19 份实际日志，逐文件回读字节一致。定向筛选造成的 skipped 只表示未选中的用例；完整标准测试没有跳过。没有保存独立文件的临时工具输出不计为归档证据。
