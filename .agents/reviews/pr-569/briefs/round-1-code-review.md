# PR 569 第 1 轮复核材料

问题：想一想对话（`threads.origin = 'think'`）不进列表，Andy 定保留 7 天后自动删，天数可改。
做法：新设置项 `threadRetentionDays`（1–90，默认 7）。`ThinkThreadRetention` 每小时跑一次，每次现读设置。`SqliteGovernedDeletionAdapter.deleteExpiredThinkThreads` 不拿状态目录锁，在服务运行时开独立连接（WAL，busy_timeout 5000），挑出到期的想一想对话，再走和 `deleteImmediately` 同一套 `#deleteOpen` 删干净；顺带补删 `threads.title_ref` 载荷。
作者的说法，请核对：
1. 只删 `origin='think'`、`status='open'` 的对话；有未结束运行或仍有效的 scheduled_jobs 的不删；主人的对话（包括编号以 `thread:think:` 开头的）绝不会被删。
2. 服务运行时并发删除不会和正在写的事务冲突出错、不会删一半（每个对话一个事务）；删除记录、加密文件、载荷行和 `deleteImmediately` 一样完整。
3. 已归档的按 `archived_at` 加天数算，卡在 active 的按 `updated_at` 加天数再加一天算；设置读取失败或越界时用默认 7 天。
4. `deleteImmediately` 重构后行为不变（仍要求停服和锁）。
5. 定时任务在关闭服务时会等正在跑的一次结束；失败只记诊断，不让服务崩。
6. 不涉及发给模型的内容。
