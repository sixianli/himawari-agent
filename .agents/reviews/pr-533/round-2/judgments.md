# PR 533 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 中：`reminder.create` 把来源对话编号写进提议数据，来源对话被永久删除或经导出导入后，采纳会失败。sqlite-memory-operations.ts:778-783 要求对话存在；import.ts 不搬运 threads；已在 execute 捕获 PORT_NOT_FOUND 后以空来源重试，test 对话已删用例；触发：提议带来源对话编号，采纳前该对话被永久删除（或导出导入后原对话不存在）；后果：执行时存储层报来源对话不存在，提醒创建失败；已改为这种情况下来源置空重试
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 低：新建提醒的 `execute` 会重新按当前时间算日期，verify 与 execute 之间跨过展示日期时年度提醒会写成下一年，读回仍报成功。production-reminder-writer.ts create 新增 expectedDueAt 校验；test 日期不一致用例；触发：verify 之后到建提醒之间时钟跨过年度提醒的展示日期；后果：年度提醒写成下一年；窗口极短；已让 writer.create 带 expectedDueAt 在重放检查之后核对
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3. 低：`undo` 的数据解析错误仍是 `ReminderInputError`，第 8 条只修了一半；`verify` 也仍接受非规范时间。production-reminder-proposals.ts undo 两处解析移入 unlessInputError；verify 加 toISOString 相等检查；触发：撤销时提议数据不可解析，或导入的提议带非规范时间；后果：客户端收到 ReminderInputError 而非稳定错误码；verify 放过非规范时间到存储层才失败；已把解析放进 unlessInputError、verify 要求规范 ISO
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4. 低：新增的“缺 `memory.delete` 就报错”没有自动检查，新建提醒撤销的重试路径也没测。reminder-proposals.test.ts 新增缺 delete 用例与 withdraw 后 undo 用例；触发：没有测试覆盖缺 memory.delete 的撤销与新建提醒撤销重试；后果：回归时可能静默退化；已补两个用例
- 5（deepseek-v4.1-flash）成立，可以更好：### 5. 低：提议编号不含 `threadId`/`externalOrigins`，但指纹含它们，同一提醒换来源重提会在原编号上刷新版本和来源。同一提醒换来源重提时刷新原提议是 box.propose 的既有行为，不产生错误结果；是否把来源纳入编号是产品取舍
- 6（deepseek-v4.1-flash）成立，会出错，低：### 6. 低：架构文档对撤销幂等和新建时间绑定的描述与增量代码不完全一致。docs/architecture-v0.1.md:434 已补；触发：读架构文档的人；后果：文档没写撤销已是目标时间视为完成、新建绑定到期时间；不误导；已补 docs/architecture-v0.1.md:434
