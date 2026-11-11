# PR 371 第 5 轮复核（只跑 DeepSeek，Andy 在决策卡上同意）：逐条判断

DeepSeek `ok`，0.1253 美元；累计 0.5934 美元。

## 会出错 · 中、高（已修改，未再复核）

- R5-1：每天打分按“任一记忆 id 相交”隐藏 `hold`，清单里有 (新, 旧) 时，另一对 (另一新条, 旧) 的 `hold` 也被藏掉，而它的新条又被排除在其他队列外，这一对当天哪里都看不到。改为两条记忆正好是清单里同一对时才隐藏。回归测试：`daily-review.unit.test.ts` 的 hold 用例补“共享旧条的另一对照常出现”（旧代码失败，已运行）。

## 会出错 · 低（已修改）

- R5-2：`CHECK (kept_memory_id IS NULL OR action = 'merge')` 在 `action` 为 NULL 时结果是 NULL，SQLite 当作通过。改成 `action IS 'merge'`，迁移测试补 `action NULL + kept_memory_id` 的反向插入（旧写法下不报错，已运行）。
- R5-3：`openOnly` 的顺序只在一对上验证过。`memory-consolidation.test.ts` 补两对未撤销时按 `created_at DESC, id DESC` 返回的断言（已运行）。`service-main` 传 `openOnly: true` 的接线没有单独加测试：它和其他 `pairs` 接线一样只在组合层，第 4 轮已在 ADR 写明。

## 不成立

- R5-4：0090 只在本分支上，没进 main、没上线过，只有测试临时库用过，不存在已经按旧内容建好的库，原地改文件不会造成 `DIGEST_MISMATCH`。

## 推测项（没有标题，不记分）

- STALE 判断与写入之间的并发窗口：先读后写，旧实现同样存在；彻底解决要在记忆写入端按修订号条件更新，超出本 PR 范围，不改。

第 5 轮仍有一条中意见（已修改）。按规则停下，是否再复核一轮由 Andy 定。
