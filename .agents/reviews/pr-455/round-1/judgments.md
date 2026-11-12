# PR 455 第 1 轮代码复核：逐条判断

模型：opencode-go/deepseek-v4.1-flash（只跑这一个，Andy 2026-11-12 定）。复核的提交：9d499a3b0。

## 会出错，中、高（已修改，进第 2 轮）

1. **clear_records 不查登记表**（模型：高）。成立。`apps/agent-service/src/production-proactive.ts` 里 `proactive.source.manage` 的 clear_records 分支在查登记表之前就返回了，而合约的 source 从只认 gmail 放宽成了任意合法名字。修改：先查登记表再分支。测试：`test/integration/proactive-production.test.ts` 的 `[iOS-7][reverse] refuses caps outside the registered range and any source that is not registered` 加了没登记的名字加 clear_records 被拒、决策记录条数不变。clear_records 清的是全部来源的记录，这是改动前就有的含义（网页“清空记录”按钮），没有改。
2. **改上限和决策记录不在一个事务里**（模型：中）。成立。`SqliteDurableOperations.execute` 不会自动开事务（`packages/persistence-sqlite/src/sqlite-durable-operations.ts` 的 execute），`writeSourceSettings` 自己也没开。修改：整个方法包进 `this.database.transaction`，先写设置再写决策记录。测试：`test/integration/proactive-sources.test.ts` 的 `a cap change whose decision record cannot be written changes nothing` 用触发器让决策记录写不进去，断言设置表没有行；把事务去掉后这条用例失败（实际运行过）。
3. **程序写入的去重和每天上限不是原子的**（模型：中）。成立。修改：`ProactiveCheckRecord` 加 `onlyIfNew`，`record` 在同一个事务里先查编号有没有记过、今天有没有超，不满足就什么都不写并返回 `refused`。测试：`two writers racing on one entry, or on the last slot of the day, record it once`，三个调用同时写同一个编号只记一条，三个不同编号同时抢最后一个名额只记一条；去掉 `onlyIfNew` 后这条用例失败（实际运行过）。

## 会出错，低（已修改）

4. **changeId 长度**（模型：低）。成立。触发：传 122 到 128 个字符的 changeId；后果：以表的 CHECK 错误拒绝，不写入错误数据。修改：上限改成 100，超过返回 settings are invalid，上面第 2 条的用例里有断言。
5. **限流用 dedupKey，存储用条目编号**（模型：低）。成立。触发：以后登记 dedupKey 不等于编号的读取型来源；后果：额度多占、游标多停一次。修改：`limitedSourceReader` 改用条目编号（和存储一致），不再收 definition。Gmail 的 dedupKey 就是编号，行为不变。
7. **材料里作者说法 11 写得不准**（模型：低）。成立。每次检查上限没有累计量，所以没有已用量和清零时刻；合约和 PR 描述写的是对的，第 2 轮材料改了这句话。
8. **groupKey 没有使用方**（模型：低）。成立。修改：交给提议入口的 sourceId 改由登记表的 groupKey 算（Gmail 上等于原来的 threadId，值不变）。latestDeliveryMs 仍没有使用方，这是任务说明要求先登记、送达时机那一批再用，设计线程已确认。
11. **提议入口不返回会卡住检查**（模型没有给严重度，放在“推测”）。成立，判低：生产没有接收方，触发后是卡住，不是错误结果。修改：等待时间以 perCheckMs 为上限。测试：`a proposal entry that fails or never answers does not hold up the check`。
12. **程序条目的文字长度没有上限**（模型：潜在低风险）。成立。修改：summary、reason、link 各不超过 2000 个字符，超过返回 entry_invalid，用例里有断言。

## 不成立

6. **导入的白名单由调用方传入**。不成立。`packages/persistence-sqlite/src/data-export/import.ts` 的 `proactiveSources` 默认是 `PROACTIVE_SOURCE_NAMES`，`apps/admin-cli` 的导入没有传它。这个选项和打开数据库时的 `proactiveSources`（`packages/persistence-sqlite/src/product-state-repository.ts`）是同一种做法：登记表是代码常量，测试要用假来源就得从外面传。反例：用默认选项导入带 test_notes 的导出包，被 `DATA_IMPORT_LINE_INVALID` 拒绝（`survive export and import` 用例实际运行）。
9. **迁移号 0097**。不成立。占位号是任务说明定的，按改表排队在合并时改号，不是这个 PR 现在要解决的事。
10. **登记表不持有读取器**。不成立。作者说法没有说登记表持有读取器；`packages/application` 不能依赖 `packages/platform-node` 里的读取器，登记表登记的是“有没有读取器”（intake），`apps/agent-service/src/production-proactive.ts` 在构造时检查每个读取型来源都绑了运行器，没绑就抛 `PROACTIVE_SOURCE_READER_MISSING`（用例 `will not start with a registered reader source that nobody reads` 实际运行）。
13. **总览、校准等处仍只认 Gmail**。不成立。模型自己写明“不是当前 bug”；这个 PR 不登记新来源，登记表里只有 Gmail 时这些地方的行为和改动前一样。接真的第二个来源时要一并处理，已写进给设计线程的汇报。
14. **对照文件无法证实取自改动前**。不成立。对照文件是在 1338704f 的检出上，用同一段测试代码（只把比较换成写文件）跑出来的；在改动后的代码上同一段测试逐字节比较通过（实际运行）。
15. **检查脚本没有传 --project**。不成立。`npm run check:proactive-sources` 实际运行，21 条 [iOS-7] 用例通过，三个测试文件都被执行。
