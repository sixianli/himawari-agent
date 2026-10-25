# P2 生产审批决定的并发持久顺序

本批完成 [Plan 的不可变请求与审批竞争项](../../../../../docs/archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p2-approval-order)。现有生产实现通过验收；仅新增独立测试、更新 Plan 和证据，未修改产品源码或协议。

## 覆盖与边界

[生产审批集成测试](../../../../integration/production-approval-arbitration.test.ts)使用两个独立 ProductionApprovalGateway 实例、ApprovalService/GrantService、真实 SQLite writer 和 Run 生命周期取消接口。登录/访问策略与近期认证为受控边界；在近期认证处使用明确的 Promise 屏障，确保双方确实读过 pending 或批准仍在等待，然后提交竞争决定。不使用随机延时，不绕过持久写入权。

15 项覆盖：合法批准正向控制；两设备同时批准；相同命令同时重传；拒绝/取消/过期先写入后迟到批准；批准先写入后的拒绝/取消/到期与历史结果重放；认证等待期间到期；到期前 1 毫秒、到期和后 1 毫秒；错误主体、Agent、会话快照及幂等键变更；原 intent 身份不能换会话快照。

独立只读数据库连接读取审批 revision/status、Grant 数量和原记录、Run 状态以及完成回执数。并发批准只产生一个 Grant，相同命令只保留一份完成回执；关闭并重开 repository 后结果不变。取消先提交后没有新 Grant，取消后的 Run 仍为 cancelled；已批准的历史事实不因取消/到期而被抹去，也不因重放产生新 Grant。

没有真实浏览器两设备、Gateway 网络传输、登录认证服务或 Worker 执行。A03/A04/A06/A12 的服务层分支有证据，不代表对应完整浏览器/执行验收均完成。已有 Worker 一次效果证据见[上一批](../p2-queued-worker-proof-01/README.md)。

## 命令与结果

```sh
npx vitest run --config vitest.workspace.ts --project integration test/integration/production-approval-arbitration.test.ts
npx vitest run --config vitest.workspace.ts --project integration test/integration/production-approval-subscription.test.ts test/integration/authorization-capability-governance.test.ts test/integration/governance-control-center.test.ts test/integration/authorization-reservations.test.ts
```

- 新增 15 项、零失败/跳过；相关 4 文件/63 项通过。类型、任务 Biome、边界、覆盖映射、不变量、秘密扫描和 CI policy 通过。新文件由现有 runner 收集。
- [组合记录](verification.json)回读原 1,024 个冻结输入以及上一批改变的 3 个测试/fixture 摘要。本批没有既有测试、共享 fixture 或生产输入变化，复用原构建和 4,024 项完整测试，新增 15 项后组合为 4,039 项；相关 63 项是重验，不再相加。
- 全库 format/lint 未重新运行；前批两份既有未跟踪原型文件的错误仍为已知阻断，不能报告全库 check 通过。没有产品行为或操作步骤变化，因此不调整 Architecture、ADR、Runbook，也不新增验证 skill。
- 严格文档检查与链接检查单列在组合记录。原始日志见 [raw-logs.tar.gz](raw-logs.tar.gz)，沿用现有归档工具，逐文件回读验证字节和 SHA-256。

## 初始失败与修正

正向控制首次误开第二个持有写入权的 repository，得到 `STATE_ROOT_LOCKED`，没有到达审批机制；因此不计为产品缺陷的失败前证据。生产架构是多设备请求汇入一个正式 writer，改成两个 Gateway 实例共享原 repository，并在持有者关闭后重开。治理类型必填字段、设备品牌类型和 Gateway 返回联合类型的初始类型错误也已修正；没有绕过类型或放宽运行时断言。

后续测试的“过期先持久化”使用推进后的服务时钟，避免凭夹具写入一个未来决定。所有修改均在最终定向检查前完成；测试未使用单独超时或重试。
