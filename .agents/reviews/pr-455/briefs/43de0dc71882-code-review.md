# PR 455：iOS 第 7 批（来源改成按登记表认）

## 问题和目标

主动检查（定时读 Gmail、让模型判断哪些邮件值得提醒主人）里，“来源”在代码里一直只是 `gmail` 一个词：数据库 9 张表的 CHECK 约束、导出导入的校验、几处查询都写死了它。后面要接别的来源（设备听到的话、日历、别的程序写进来的条目），每加一个都得改表。这一批把来源改成一张登记表，只登记 Gmail，行为必须和改动前一样。任务说明在仓库外（`/mnt/project-files/ambient-sensing/batch-7-task.md`），要点已写在下面的“作者的说法”里。

## 约束

- 发给模型的内容只追加（`.claude/rules/prompt-prefix.md`）；这一批不许改 Gmail 判断的提示词和模型调用，发给模型的请求必须和改动前逐字节相同。
- 登记表只登记管道上的事（名字、读取器、去重键、可信标记、来源信息、安全上限、最晚送达时间、评测分组），不登记场景名和每来源的提示词。
- 安全上限是防失控用的，主人能看能改；不做“为省钱降级”的逻辑。
- `packages/persistence-sqlite` 只能从 `packages/application` 做类型导入，或经独立子路径 `@himawari-agent/application/proactive-sources` 做值导入。
- 迁移必须保住每一行旧数据；迁移号 0097 是占位，合并时改号。
- 不改网页（Andy 定有 App 就不做网页版）；不登记新的真实来源。

## 作者的说法（请核对，不要直接采信）

1. 登记表在 `packages/application/src/ports/proactive-sources.ts`。`ProactiveSource` 类型由登记表生成；`defineProactiveSources` 拒绝缺可信标记、名字不合格式、上限范围不对、重名的登记。
2. 邮件判断（`packages/application/src/services/proactive-mail-check-service.ts`）内部仍用原来的扁平邮件结构，只在读取器边界用 `mailItem` / `mailOf`、`mailReader` / `flatMailReader` 转换，所以提示词和模型请求不变。`test/integration/proactive-production.test.ts` 的 `[iOS-7] sends the model the same Gmail judging request, byte for byte` 用 `test/fixtures/proactive-gmail-request.golden.json` 对比，这份对照是在改动前的提交上生成的。
3. 迁移 `packages/persistence-sqlite/src/migrations/0097_proactive_source_registry.sql` 重建带 `gmail` 约束的表，把约束换成名字格式检查，行、索引、触发器、外键都保住；`packages/persistence-sqlite/test/proactive-source-registry-migration.contract.test.ts` 逐行比较。
4. 名字有没有登记，在写入时由 `packages/persistence-sqlite/src/sqlite-proactive-operations.ts` 的 `source()` 按传给它的登记表检查；生产用默认登记表，测试可以经 `proactiveSources` 传入假来源。
5. `proactive_source_settings` 存每个来源的开关和两个上限；没有行时用登记表里的默认值；写入时按登记表的范围校验。
6. 上限由 `packages/application/src/services/proactive-source-runtime.ts` 的 `limitedSourceReader` 执行：新条目超过“每次检查上限”和“今天剩余额度”中较小的那个时，只放行前面的，游标返回 null（不前进），其余留到下次；已处理过的条目不占额度。
7. `recordProactiveProgramEntry` 给“没有读取器、由别的程序写入”的来源记一条：总开关或来源开关关着不记，同一编号不重复记，超过每天上限不记，安静时段内推到安静时段结束，带 `deliverAt` 的到点才送。
8. `ProactiveObservationPort`：邮件判断里值得提醒的 act 条目在决策记录写完之后交出去；生产没有接，决策记录 `inputs.observations` 写 `handedOff` 和 `sink`；接收方抛错不影响这次检查。
9. 导入（`packages/persistence-sqlite/src/data-export/import.ts`）在写任何行之前拒绝没登记的来源名。
10. `apps/agent-service/src/production-proactive.ts`：登记了读取型来源却没有对应的运行器时构造函数抛 `PROACTIVE_SOURCE_READER_MISSING`；来源开关关着时这个来源不检查；`proactive.source.manage` 和 `proactive.source.settings.set` 拒绝没登记的来源。
11. `proactive.sources.read` 给每个来源返回两个上限的当前值、默认值、范围、今天已用条数、清零时刻（主人时区的下一个零点）和到上限后的做法；`proactive.source.settings.set` 改了上限时，`writeSourceSettings` 在同一个数据库事务里写 `limit_change` 决策记录（值没变不写）；`proactive.source.switch_off` 的正文恰好是 `{source}`，只关开关、不动上限。
12. `recordProactiveProgramEntry` 用程序校验拒绝 `know`、`low` 优先级和空摘要（返回 `entry_invalid`），表上没有这条约束。
13. 新检查 `scripts/check-proactive-sources.mjs` 要求 18 条 `[iOS-7]` 用例按名字都通过。

## 已知没做

新来源；网页上的来源开关；别的程序写入“只告诉主人一句话”（不需要主人做事）的条目，等补充方案；按最晚送达时间做事的逻辑；碰到上限时通知主人（现在只写服务日志和查询结果里的 `dailyLimitReached`）。

`test/integration/decision-ledger.test.ts` 的 2 条 `writes and reads back every decision kind` 在基线提交（1338704f）上就不过，不在本 PR 范围。
