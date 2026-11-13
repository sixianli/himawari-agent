# 第 1 轮判断

- ds1 / gl1（高，成立，中高，已修）：回滚没得到确认时门闩永不释放，后来的写请求无限等待。改为释放门闩并把写通道标为关闭，之后的写请求报 TRANSACTION_ROLLBACK_UNCONFIRMED。新测试“worker lost”真实关掉工作线程，修复前该测试得到“waiting”（失败），修复后通过。
- ds2（成立，判低，已改文档）：begin 等忙等待上限、commit 耗时都有界，不会产生错误结果；2 秒只管回调，ADR 已写明。
- ds3（成立，中高，已修）：resolveSensitive 的审计在事务内就发出。改为缓冲、提交成功后才发。新测试用真实事务在回调后抛错回滚，修复前 sent 非空（失败），修复后为空。
- ds4、ds5、ds6、ds7、gl3、gl4（成立，低，已改）：ADR 或 schema 目录文字与代码不符，已改；gl3 的 schema-catalog 描述已改，相关测试 25 个文件全过。
- gl2（不成立）：src/production-memory-capture.ts 的 #save 里 enqueue 失败会直接抛出，不会进入保存循环，所以不存在“没入队却当作已提交”的路径；入队成功才会走到循环。
- gl5（可以更好）：设计取舍，不改变行为，慢范围有 500 毫秒日志可观察，不改。
