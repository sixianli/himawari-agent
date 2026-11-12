# PR 378 第 2 轮复核判断

复核 76533f80（`--previous bc041d22`，只用 deepseek-v4.1-flash）。逐条判断写在 `verdicts.jsonl`。本轮有中、高意见，没过，已改，送第 3 轮。

## 会出错：中、高（已改）

- r2-1 退役时删题干 payload 会撞外键 `ON DELETE RESTRICT`：成立，这是第 1 轮修 g4 时引入的。
  - 复现：集成测试新增 “retires questions of a revised memory on real storage …”，测试里的 `discardQuestion` 改成真删 payloads 表。把退役时删 payload 加回去，worker 和 direct 两条都失败。
  - 改法：退役的题不再删 payload（payload 被题库行引用着），记忆删除时随题一起删。ADR 同步。g4 改判为不修。
- r2-2 失败的调用不计费：调用抛错时按这次的预估记账（`RealEvalBudget.absorb`），再抛出。测试是 “charges the estimate of a call that failed”。
- r2-3 检索不预留：新增依赖 `recallEstimateMicros`，检索前 `reserve`；检索失败时按预估记账。
  - 生产里的预估取向量模型描述的 `estimatedCostMicros`（输入按 16384 个 token 算）；没有向量模型时为 0。
  - 测试是 “does not search when the remaining budget cannot cover the search estimate”。
- r2-4 `addQuestion` 返回 false 后反复出题：返回 false 时把这个记忆版本记进 `declined`（`rejected.already_banked`）。测试是 “does not ask again about a memory version the bank already holds”。
- r2-5 暂时的错误被当成永久拒绝：`response_invalid` 不记进 `declined`。`source_missing` 本来就不记。测试是 “asks again after a reply that was not valid output”。
- r2-6 评测关着时样本不过期：评测没开时，服务每次启动都检查一次样本，满 7 天就删。ADR 写明“关着评测且服务一直不重启时会留得更久”。

## 会出错：低（已改）

- r2-7：复核材料的约束改为“运行结果表只存分数、计数和标识”。
- r2-8：新增 `7:00` 这类冒号时刻的比对，并补了测试。`百`、`千` 只出现在一百以上的数里，日期时刻用不到，所以不改。
- r2-10：ADR 写明“评测只在一个服务进程里跑”。生产只跑一个 systemd 服务，不加数据库锁。

## 不成立

- r2-9 once 模式遇到 `budget_exceeded` 不重跑：once 的目的是给主人一份抽查样本。`#tick` 在 trigger 为 manual 时，不管运行结果如何都会写样本，所以 `budget_exceeded` 的运行也有样本。ADR 决定 7 写的是“跑一轮手动评测”，不再重跑符合设计。
