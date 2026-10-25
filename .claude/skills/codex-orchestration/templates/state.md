# Claude 管理 Codex：当前状态

更新：<日期 时间>。只记和 Codex 往来的流程信息，每次状态变化时整份覆盖，不追加。目标、条目、计划、等用户决定的事和已知限制都在长任务目录 `.agents/tasks/<任务名>/`；做没做完只看 `python3 ~/.claude/skills/long-task-planning/scripts/longtask.py status`。历史看 git log 和 stop/reply 文件。

## 当前批次

- 条目：<条目编号>。简报 `<路径>`，后续裁定 <reply 编号>。
- Codex 会话：`<uuid>`，终端标签 <tab>，<模型、强度、速度>。
- 下一个停止文件：`<路径>`
- 后台等待任务：<id>（只在本 Claude 会话有效）

## 下次审核要核对

- <上一份 reply 里提的条件，每条一行，写成能逐条打勾的形式>
