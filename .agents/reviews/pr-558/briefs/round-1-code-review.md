# PR 558 第 1 轮复核材料

## 问题
想一想（后台替主人琢磨新来源的运行）开的对话目前出现在“已归档”“全部”列表、搜索、对话事件、首页、网页推送、Apple 推送、聊天导出和记忆每日摘要里，还会多调一次起标题的模型。Andy 定：这些对话不进主人的列表。

## 做法
- `threads.origin`（`owner` 默认 / `think`），在 `ThreadCommandService.create` 建对话的同一事务里写入；只有 `ThreadThinkRunner` 传 `origin: "think"`。网关 `thread.create` 不能传 origin。
- `ProductThread.origin` 是可选字段，只在 think 时存在。
- 过滤点：`sqlite-thread-operations.ts` 的 list、search、listGatewayEvents、pendingSearchProjection；`sqlite-run-lifecycle-operations.ts` listUnattended；`sqlite-apple-push-operations.ts` listActivityRuns；`sqlite-web-push-operations.ts` listFinishedRuns；`sqlite-memory-operations.ts` listUnsummarized；`data-export/chats.ts`（另记 omitted 条数）。
- `ProductionThreadTitles` 遇 think 对话直接返回。
- 设置冲突在存储层的报错文字改成 `THINK_SETTINGS_CHANGED`，与应用层一致。
- `THINK_WORTH_DEFAULTS` 由 `THINK_SETTING_DEFINITIONS` 派生。

## 不在本 PR
保留天数和到期删除放下一个 PR。按编号直接读 think 对话不拦（目标是界面不显示，不是安全边界）。

## 作者的说法，请核对
1. 客户端无法让一个对话变成 `origin = think`。
2. 事件过滤后，客户端游标仍连续：被跳过的事件游标从不发给客户端。
3. 上面列的过滤点覆盖了主人能看到想一想对话的所有地方；如有漏的请指出文件和行。
4. 迁移只加一列带默认值，不影响旧行。
