# PR 454 第 4 轮：合进最新 main 之后的整体复核

问题、目标、约束同第 1 轮材料（`.agents/reviews/pr-454/briefs/b2a560461af4-code-review.md`），请先读它。这一轮的对比基准是最新 main，看的是整个 PR 现在相对 main 的全部改动：第 3 轮之后又加了几项功能（动作给主人看的名字、“不做”那一边的按钮字、重复日程只动这一次、最近结束的动作列表、删对话时带走设备动作记录），并合进了最新 main。

## 作者的说法（请核对，不要直接采信）

1. 设备动作的迁移是 `packages/persistence-sqlite/src/migrations/20261114172043_device_actions.sql`：往参照表 `decision_ledger_kinds`、`decision_ledger_outcomes` 插入 `device_action` 和它的 9 种结果，不再重建 `decision_ledger`；建 `device_actions`、`device_policies` 两张表和设备撤销时的触发器。
2. main 删掉了来源闸门和 `perception_run_reads` 表。设备动作判断“这一轮读过外面来的内容”改为读统一审批的外部内容标记 `ContextExternalContent.read(runId)`（`apps/agent-service/src/production-device-actions.ts`），和 `perception_read` 读到别人来源的记录时打的是同一份标记；`service-main.ts` 把 `externalContent` 的构造挪到设备动作之前并传进去。
3. 去掉了 main 上 `device_action` 工具的同步确认钩子 `confirm` 和固定说明 `tools.result.device-action.unconfirmed`：要主人确认的动作由 `DeviceActionService` 送去审批、状态为 `waiting_owner`，不在工具调用里同步问。改动类动作仍先过 `hooks.authorize()`。
4. 现在审批还没接上（`ReadOnlyDeviceActionAuthorization`），要审批的动作一律拒绝并写原因；接统一审批是下一个 PR。

## 之前判为不成立、这一轮不必重提的

终态动作的保留期（列给 Andy 定）；策略变更不能收回已送达的动作（第 9B 批）；`reopen` 开头的 `settle()` 没有上限；重装后排队中的动作不转结果未知。理由见各轮的 `judgments.md`。
