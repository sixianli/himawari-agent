---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amended_by: "docs/adr/0033-process-sandbox-default-and-optional-containers.md"
date: "2026-09-16"
---

# ADR 0030：工作区释放事实独立于授权有效期和结果交接

## 背景

用户已确认工作区、授权与执行状态 Spec，并于 2026-09-16 要求实施其 Plan。本决定记录该 Spec 已确认的持久化原则，补充 ADR 0025 的生命周期分离，不替代其 Pi、沙箱和平台资格决定。`accepted` 表示设计决定已经确认，不表示对应代码、迁移或生产恢复已经完成。

基线 `753fb63` 的 SQLite 实验复现了资源已结束、ACK 已确认而工作区仍被占用的问题：在释放凭证到期时及到期后 11ms、151ms 接收 ACK，`released_at` 保持为空，后续写入被拦截。该实验使用隔离 SQLite 和受控平台证据，不是生产环境复测。原始命令、测试源和日志见 [Plan 的实施记录](../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#implementation-record)。

## 决定

> 2026-09-26 起，第 3 条和第 5 条在 SRT 模式下已由 [ADR 0033](0033-process-sandbox-default-and-optional-containers.md#amendments) 部分修正：脱离进程组的后代程序不再作为挡住目录的条件；以前留下的未确认记录经所有者授权后整批删除。本文以下内容保留原决定。

将资源释放作为接纳时经过宿主验证、持久保存且不会因时间推进而撤销的历史事实。Himawari 继续使用 SQLite 的事务、现有身份和权威栅栏；Pi 继续负责工具与 Agent Loop。

1. 接纳新的释放观察时，核对原操作、attempt、环境、资源序号、进程身份、凭证时效及当前记录权威。在同一短事务中保存释放凭据并结束对应占用。未来读取验证已接纳历史事实的完整性，不用读取时的当前时间重新判定历史凭证是否仍有效。
2. 结果交接和可以启动或改变资源的控制消息分别判断。ACK 迟到、丢失或重复只影响交接状态，不能清空旧释放事实或导致工具重新执行。后续实际操作仍经过当前权限、目标、预算、取消与 fencing 检查。
3. 后续确有新风险时，创建关联原操作及具体受影响资源的 incident/barrier，即新的风险记录与必要保护。记录风险原因、证据和后续责任，不恢复旧占用来伪装成原资源从未释放；真正仍可写的旧资源未得到隔离证明前仍阻止冲突操作。
4. 授权范围回答允许访问什么，本次资源协调回答当前操作必须保护什么。不能因获得整个目录的授权就把一次文件提交当成整个目录排他操作。
5. 不根据历史记录中的 `released` 字样或已过期凭证批量生成新的释放证明。旧记录的迁移与恢复需要新的现场核验、只读预览和逐条条件更新；生产写入须有具体授权。

## 比较过的方案

### 延长凭证有效期

只能降低 ACK 落在边界外的概率，不能解决重启、断线或通知丢失后的错误占用，因此不采用。

### 到期自动解锁，或关闭冲突检查

无法证明旧进程及其后代不可再写，可能导致危险并发，因此不采用。

### 持久释放事实与新风险保护分开

采用。既保留已验证的历史事实，又能在出现矛盾证据时保护实际有风险的资源。代价是需要新增持久记录、兼容检查和有明确终点的恢复路径。

## 影响

- 必须同时验证“通知迟到不反锁”和“真实旧 writer 仍可写时不能放行”；只验证前者不足以交付。
- 新旧数据库程序的 writer 资格需显式检查；旧程序不能把不理解的新保护状态解释成已释放。
- UI 分别表达准备、执行、核验、停止及结果待确认。新增交互仍按 Plan 的原型审核点处理。
- 本决定没有选择自动审查模型、批准范围、费用配置，也没有授权部署或修改历史生产数据。

## 关联资料

- [SOURCE: docs/adr/0025-pi-tools-and-managed-execution-lifecycles.md]
- [SOURCE: docs/adr/0018-sqlite-product-state-authority.md]
- [SOURCE: docs/execution/specs/2026-09-16-workspace-authorization-lifecycle-design.md]
- [SOURCE: docs/archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md]
