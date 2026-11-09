# PR 311 第 1 轮意见分类（复核线程，逐条核对源码）

基准 01873f5c，head 6b8afcf7，经 Magpie，DeepSeek + GLM，累计 0.1722 美元。

## 会出错 · 中（必须改）
1. 来源对话在回收站或删除中、或来源消息未提交时仍显示“跳到原话”：成立。`sqlite-memory-book-operations.ts:564-570` 的 SQL 只按 role='owner' 匹配，不看 threads.status 与 message_status；而 `sqlite-thread-operations.ts:1515-1516` 对 trashed/deletion_pending/deleted_verified 返回空。结果界面计入“能跳到”，点进去却什么也没有。（DeepSeek 1、GLM 1）
2. 提醒工具创建的记忆被误报“来源已不可查”：成立。`production-reminder-writer.ts:185-187` 把 sourceRefs 写成合成的 `memory-content:reminder:*`，不会等于任何消息的 content_ref，而 `memory-source.ts:13` 只要有 sourceThreadId 就判 jump/unavailable。（DeepSeek 2）
3. ADR 0185 与代码不符：ADR 说页面与脚本“同一定义”，实际页面只算已加载的概览集合（非活跃限 500、读不出文字的跳过），脚本算全库；脚本不按 owner/agent 过滤；服务端过滤 ref 长度 512 而脚本不滤；整理产生的记忆继承 sourceThreadId，不会归 tidy。（DeepSeek 3、GLM 2、3）

## 会出错 · 低
4. 缺反向测试：没有 agent 消息同 content_ref 的用例、没有多条匹配取最早的用例、没有真实回收站路径的用例、没有 >200 引用分批用例。（DeepSeek 7、GLM 5）
5. 每次打开记忆页对 thread_messages 做无索引扫描：成立（只有 thread_id 前缀索引）；可把来源对话 id 下推进 SQL 缩小范围，不加迁移。（DeepSeek 4）建议归低。
6. MESSAGE_FOCUS_EVENT 无监听者；跳转请求在目标不在时静默清掉，导航失败时 pending 滞留。（DeepSeek 6、GLM 4）

## 可以更好（不改，列给 Andy）
7. 导入批次只取最近 20 批，更早的显示通用“导入”。（DeepSeek 5）若按“会出错”看，是说明与代码不符，ADR 至少要写明。

## 必答问题
- 会不会改变模型已见过的请求开头：两个模型一致回答不会；本线程核对 diff 未碰提示词、工具定义、历史、遮盖。
