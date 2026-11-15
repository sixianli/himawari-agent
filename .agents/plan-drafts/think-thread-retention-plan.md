# 想一想对话：不进列表、保留 7 天后自动删（方案第 2 版）

## 前提

1. Andy 定的产品行为。原话（cmsg_01EE1hey9cboYNfwFnBv5dgrDs6moWVTLBrHyMTxWzj99b）：“30 天太长了，7 天怎么样？因为其实我不会，我很少会去看他们自己琢磨的内容。”他回的是这一条提议：“这些记录不放进你的列表，单独存 30 天，过期自动清掉。它们想出的结论照样会进提议箱。”协调者转达时补了一句：保留天数要做成可以改的配置。
2. 想一想对话现在的处理方式：运行结束后会被归档。归档就是在 `threads` 表的 `archived_at` 字段写上时间（`packages/persistence-sqlite/src/sqlite-thread-operations.ts:334`，原文是 `row.status === "open" ? (row.archivedAt === null ? "active" : "archived")`）。所以这些对话会出现在“已归档”和“全部”两个列表里。
3. 客户端可以自己指定对话编号：`thread.create` 的参数里带 `threadId`（`packages/application/src/services/product-thread-gateway-adapter.ts:196`，原文是 `createThreadId(command.payload.threadId)`）。所以不能凭编号前缀 `thread:think:` 判断一个对话是不是想一想对话。
4. 主人发起的“永久删除”在服务运行时并不真的删数据，只是把状态改成 `deletion_pending`（`sqlite-thread-operations.ts:846`，原文是 `const target = input.mode === "trash" ? "trashed" : "deletion_pending";`）。真正删数据的是 `sqlite-governed-deletion.ts` 的 `deleteImmediately`，它要求服务已停（`:669`，原文是 “Governed deletion requires stopped services and an exclusive state-root lock”）。
5. 给对话起标题的程序会处理所有状态为 active 的新对话（`apps/agent-service/src/production-thread-titles.ts:59-61`），想一想对话也在其中。
6. 记忆的“每日摘要”（memory episodes）会挑出所有状态为 open、有新消息的对话（`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1704`，原文是 `WHERE t.owner_id = @ownerId AND t.agent_id = @agentId AND t.status = 'open'`），已归档的想一想对话也在其中。也就是说，想一想的任务说明（其中有外部内容的摘要）会被写成摘要，进入记忆检索。
7. 首页的“没人看着的运行”会列出所有来源不是 `user_message` 的运行（DeepSeek 方案审核指出的位置：`sqlite-run-lifecycle-operations.ts:940-975`，待动手时核对）。聊天导出会包含所有状态为 open 的对话（`packages/persistence-sqlite/src/data-export/chats.ts:112-137`，待核对）。

## 拆成两个 PR

### PR 甲：标出想一想对话，并在所有地方隐藏

1. `threads` 表加一列 `origin`，取值为 `owner` 或 `think`，默认 `owner`。`ThreadCommandService.create` 的内部输入可以传 `origin: "think"`，在建对话的同一个事务里写进去。客户端走网关 `thread.create` 时，origin 固定为 `owner`。这样标记和建对话同时成功或同时失败，重试同一条也没问题。
2. 下面这些地方都排除 `origin = 'think'` 的对话：对话列表、搜索（不为它建搜索索引）、对话事件、首页没人看着的运行、网页推送、Apple 推送和灵动岛、聊天导出、记忆每日摘要。
3. 想一想对话不生成标题。
4. 同时做上一个 PR 留下的事：补设置读取失败的回退测试和并发版本冲突测试；Jev 门槛的默认值只写在一处。
5. 测试分两部分：
   - 正向：想一想对话不出现在上面每个地方。
   - 反向：普通对话照常出现、照常有标题；客户端自己建一个编号以 `thread:think:` 开头的对话，仍然是普通对话。

### PR 乙：保留天数可改，到期自动删

1. 新配置项 `runPolicy.thinkInbox.threadRetentionDays`，取值 1 到 90，默认 7，单位是“天”，作为第 11 个设置项。每次清理都现读设置。改完要告诉做 App 的第 11 批线程。
2. 删除时间不另外存，用 `archived_at` 加上当前设置的天数现算。改了天数，已有的对话也按新天数算。
3. 一个单独的清理定时任务，不依赖想一想有没有开启。它只删同时满足以下条件的对话：`origin = 'think'`、已归档、到期、没有还没结束的运行。对于归档失败、一直停在 active 的想一想对话，在超过保留期加一天之后也删。
4. 删除复用 `sqlite-governed-deletion.ts` 里那套完整的删除逻辑，包括相关的表、载荷行、加密文件和删除记录。把它整理成服务运行时也能调用的形式，只给想一想清理用。这条路径不经过主人删除用的网关命令，也不认客户端传来的任何授权字段。同时补上现有逻辑漏删的标题载荷 `threads.title_ref`。
5. 测试：
   - 正向：到期的想一想对话被删干净，数据库里的行、载荷和文件都不剩。
   - 反向：主人自己的对话哪怕已经归档很久也不删；运行中的想一想对话不删；主人发起的删除命令带上任何字符串都不能跳过身份验证。
6. 文档：更新 `docs/architecture-v0.1.md` 里讲想一想对话的两段。另写一份 ADR，记录“系统自动删除想一想对话”是“永久删除要主人确认”的一个例外。

## 采纳的审核意见

DeepSeek 方案审核（`.agents/reviews/topic-think-thread-retention/round-1/deepseek-v4.1-flash.md`）提了 11 条意见：

- 采纳第 1 至 9 条和第 11 条。
- 第 10 条不采纳：直接按编号读取一个对话不另加拦截，因为这次的目标是不在界面上显示，不是把它当成安全边界。
