# PR 448 第 5 轮逐条判断（只跑 DeepSeek）

模型给的最高严重度是“低”，6 条都成立、都是低，都改了：

1. `delegate.mjs check` 对替补的判断和合并前检查不一致：`finished` 改成和合并前检查一样认字段（没有 `substitute` 字段才算直接结果，`substitute` 为 `true` 才算替补）。触发后是 delegate 放行、合并前检查拒绝，不会放过未复核的改动。
2. 文档点名的测试不全：model-review.md 补上 `test/tooling/plan-claims-gate.test.mjs`。
3. model-review.md 讲固定侧重那条的“第 2 轮起只有它一个”过时：改成默认每一轮都只有它一个。
4. “失败记录必须在同一轮”没有反向用例：`test/tooling/opencode-review-merge-gate.test.mjs` 加一条（第 1 轮 DeepSeek 失败、第 2 轮只有 GLM 替补记录，报 `no-complete-round`）。
5. 改 `substitutes` 会让旧账本重新判断：ADR 0259 的后果一节和 model-review.md 写明，只会更严。
6. 交接说明里“去掉 --models”：改成“去掉 --models 和它后面的值”。
