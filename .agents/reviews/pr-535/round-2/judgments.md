# PR 535 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 【中】同 key 的“失败清理”和另一条入队之间没有互斥，可能让已接受的条目丢掉摘要，或让入队抛外键错误。production-think-inbox.ts 原 submit 在 enqueue 与 #discardUnreferenced 之间有 await，无互斥；接线后条件可达。已改：按条目 key 在进程内排队（#locks），同一 key 的提交串行；并发测试仍通过；触发：同一来源版本的两次提交交错：A 新写载荷后入队被拒，等待清理期间有 worker 腾出队列空位或跨过午夜，B 入队成功，A 再删载荷；后果：B 已接受的条目摘要被 ON DELETE SET NULL 置空，或 B 的插入因外键失败而抛错
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 【中/低】`put` 成功但 `enqueue` 抛异常或进程崩溃时，会留下永远没人清扫的孤立摘要载荷。production-think-inbox.ts enqueue 未包 try/catch。已改：抛错且本次新写时走 #discardUnreferenced 再重抛；新增测试断言 enqueue 抛错后载荷数为 0；崩溃窗口的孤儿载荷已写入文档，按年龄清扫留到接线 PR；触发：enqueue 因磁盘余量检查或数据库错误抛异常；后果：留下一份没有行引用的加密载荷，不影响任何结果，只是残留；判低理由：只在磁盘或数据库异常时才触发，结果是加密载荷残留，不会读到错误结果、不泄露
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 【低】作者说法“重复提交不新建摘要载荷”不成立：载荷被清扫后再提交会重新加密写一份、再删掉。代码顺序确实是先写再判重，但最终状态正确（测试断言 0 份），文档已改成写明会临时写一份再删；先查条目再写载荷要多一次查询和端口，不采纳
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4. 【低】文档说删载荷后“表里只留指针”，实际 `clearSummary` 把指针置成 NULL。clearSummary 把 summary_ref 置空（sqlite-think-inbox-operations.ts clearSummary）。已改 docs/architecture-v0.1.md 和 schema-catalog.ts 的说明；触发：读文档的人按字面理解为表里还留着指针；后果：文字不准但不误导运行行为
