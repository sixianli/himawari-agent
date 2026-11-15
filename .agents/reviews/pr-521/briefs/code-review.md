这个 PR 让复核速度的真实数据可查、可对比（Andy 要用真实数据证明 ADR 0270 的提速效果）。范围：新增只读脚本 scripts/model-review/review-speed-report.mjs，读 .agents/reviews/pr-*/usage.jsonl 和 round-*/verdicts.jsonl，按分界时间出优化前后对比表，或用 --csv 导出逐轮数据；scripts/model-review/opencode-review.mjs 新增 selfCheckCacheLabel，把自检缓存 hit/miss/off 写进账本记录（字段 selfCheckCache），打印的 SELF_CHECK_OK 行用同一个函数；docs/assets/review-cost/2026-11-14-review-rounds-baseline.csv 是优化前逐轮数据快照；docs/assets/review-cost/2026-11-14-review-speed-data.txt 加了取法说明。测试在 test/tooling/review-speed-report.test.mjs 和 test/tooling/opencode-review.test.mjs（selfCheckCacheLabel）。

约束：脚本只读账本，不花钱、不写文件；账本记录只多一个字段，不改发给模型的内容；不写死数值。

请特别查：同一 PR、同一轮、同一模型有多条记录时取最后一条是否正确，失败的尝试费用是否仍算进 PR 花费；sincePreviousMs 在跨分界的 PR 上是否会误导；中高意见的判定（valid 为真、class 为 error、severity 为 medium-high/medium/high）是否和 model-review.md 一致；selfCheckCache 字段改动是否让 SELF_CHECK_OK 输出或账本其他字段变化；测试是否有反向用例（失败的轮、缺目录）。
