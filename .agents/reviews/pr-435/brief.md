# PR 435 复核材料：能力（capability）的列表、详情、停用装进生产（退回不装）

## 问题和目标
生产网关（apps/agent-service/src/production-approval-gateway.ts）原来没有安装 capability.list/detail/disable/rollback。目标：装进生产；停用和退回要在服务器端验“最近认证”；停用时数出被取消的定时任务个数，存下并在详情里显示；详情里“关联任务”原来是一律抛错的存根，要能读。

## 已核对的事实
- 生产库实查有 3 条能力记录，都是 active。
- 停用的原有事务（packages/persistence-sqlite/src/sqlite-durable-operations.ts 的 invalidateCapabilityAuthority）同时撤销句柄、把该能力名下 status != 'revoked' 的定时任务改成已取消。
- 退回（CapabilityLifecycleService.rollback）要重新核验上一版的安装包并做运行环境资格检查；生产的部署快照每个能力只有当前版本、资格结果 5 分钟后过期，核验不了上一版，所以第 2 轮之后生产不安装 capability.rollback（契约字段和服务层的最近认证检查保留），生产的版本核验固定拒绝。
- 契约 capability.disable / capability.rollback 的 payload 新增可为空的 recentAuthenticationRef；capability.snapshot 新增必填可为空的 lastInvalidation。
- 重新启用（reactivate）不在本 PR 范围。没有改数据库表结构，没有改发给模型的内容。

## 需要你们看的重点
停用/退回的最近认证检查是否在状态变化前、是否能被绕过（包括幂等重放路径）；停用事务里计数和保存是否一致；退回失败时状态是否不变；新增的存储读操作是否有范围（owner/agent）限制；测试是否覆盖这些反向情况。
