# PR 625 复核材料

## 问题和目标

工具登记表（apps/agent-service/src/production-tool-actions.ts）把 reminder_cancel 标成 reversible: true，规则手册据此对主人自己要求的取消直接放行；但取消后没有任何入口能恢复同一条提醒。本 PR 让取消真的能撤销：memory.reminder.respond 加 restore，网页提醒页取消后的提示条带“撤销”。

## 约束

- 不写代码注释；不用词表猜意思。
- 不改规则手册和工具登记表。
- 提醒存储的 update 要求 status 为 scheduled 时 dismissedAt 为 null（packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts）。

## 作者的说法（请核对）

1. restore 只对已取消的提醒生效，其余状态拒绝 MEMORY_REMINDER_NOT_CANCELLED；取消、稍后、不再提醒原有行为不变（已取消的提醒对 dismiss、snooze 仍拒绝）。
2. 恢复后提醒回到 scheduled、时间不变，到期列表和即将到来列表照常显示它。
3. 契约枚举新增 restore 后，所有发送和校验 memory.reminder.respond 的地方（网页、服务端、iPhone 生成的能力清单）都能接受。
4. 网页撤销按钮发送的是被取消的那一条的 reminderId。
5. 第 2 轮新增：她在对话里用 reminder_cancel 取消的提醒，和网页取消的一样出现在提醒页“最近取消”（到期时间没过、记忆还在的，最多 20 条），点“恢复”发 restore；恢复失败有提示。memory.overview.snapshot 新增的 cancelled 字段，所有产生和读取它的地方（服务端、契约、网页、测试夹具）都一致。
