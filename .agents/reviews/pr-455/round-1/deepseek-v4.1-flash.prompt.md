你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 9d499a3b01a5ccfc20ddf57257f3729863e25d05。
对比基准是 1338704f1ae5b3c0160974aae664ae6d4f2bf292，先运行 git diff 1338704f1ae5b3c0160974aae664ae6d4f2bf292..9d499a3b01a5ccfc20ddf57257f3729863e25d05 看改动。
作者的说法（可能有错，请核对）：
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
