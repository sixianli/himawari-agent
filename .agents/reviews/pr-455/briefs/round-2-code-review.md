# PR 455 第 2 轮：对第 1 轮意见的修改

问题、目标和约束同第 1 轮（`.agents/reviews/pr-455/briefs/43de0dc71882-code-review.md`）。第 1 轮的逐条判断在 `.agents/reviews/pr-455/round-1/judgments.md`。

## 作者的说法（请核对，不要直接采信）

1. `proactive.source.manage` 现在先查登记表再分支，没登记的来源名加 `clear_records` 也被拒绝（`apps/agent-service/src/production-proactive.ts`）。`clear_records` 清全部来源的记录是改动前就有的含义，没有改。
2. `writeSourceSettings`（`packages/persistence-sqlite/src/sqlite-proactive-operations.ts`）整个在一个事务里：先写设置，再写 `limit_change` 决策记录，任何一步失败两者都不留。`changeId` 最长 100 个字符。
3. `record` 新增可选的 `onlyIfNew`：在同一个事务里，条目编号已经记过，或今天已记条数加这次会超过每天上限，就什么都不写并返回 `refused`。只有 `recordProactiveProgramEntry` 传它，邮件检查不传，行为不变。
4. `limitedSourceReader` 用条目编号判断是否已处理（和存储一致），不再用登记表的 `dedupKey`。
5. 交给提议入口的 `sourceId` 由登记表的 `groupKey` 算，Gmail 上的值和原来一样；等待提议入口最多等 `limits.perCheckMs`，超时或抛错都不影响这次检查。
6. 程序写入的条目，summary、reason、link 各不超过 2000 个字符。
7. `proactive.sources.read` 里只有每天上限带 `used` 和 `resetsAt`；每次检查上限没有累计量，只带当前值、默认值、范围和到上限后的做法。
