# 计划：memory-page-redesign

<!-- 只写打算，不写进度；做没做完用 longtask.py status 算。
     当前批次最多 3 项，每项一行、以条目编号开头，写清做法和需要的证据；
     同一次测试顺带验证的条目写在不以编号开头的一行里，不占名额；之后的条目每项一行；
     最后三段只追加，不改旧内容。 -->

## 当前批次

- MP-1 新迁移加 sub_category、记忆设置表；快照加字段和 upcoming 提醒、paused；证据：production-memory-control 集成测试标 [MP-1]。
- MP-2 DurableMemoryService 加 trash/recover，SQLite 允许 trashed→active，每日任务清过期；证据：测试标 [MP-2]。
- MP-3 新命令 memory.create；证据：测试标 [MP-3]。

## 之后

- MP-4 暂停开关，记忆捕获读设置。
- MP-5 捕获提示词加小类，服务端限 8 个。
- MP-6 人物、别名、关系表；捕获输出人物和关系；合并建议进待确认。
- MP-7 导入预览（模型拆分改写）与整批写入、撤销。
- MP-8 前端按原型重做。
- MP-9 npm run check。
- MP-10 案例库。

## 计划改动记录

- 2026-10-26 07:15 建立任务。
- 2026-10-26 07:20 加 MP-1 到 MP-10；分两批：先后端（MP-1 到 MP-7），再前端（MP-8）和检查文档。

## 意外和发现

## 决定
