# PR 448 第 4 轮：完整复核（不带 --previous）

这一轮请看整个 PR。背景同第 1 轮：Andy 2026-11-12 定，方案审核和代码复核默认只用 DeepSeek。

为什么重新完整复核：新 ADR 因撞号从 0255 改名为 0259 之后，之前为旧文件名做的核对记录（`.agents/reviews/topic-review-default-models/round-1` 到 `round-3`）不再属于任何新增的 ADR，合并前检查把它们算成第 2 轮低严重度放行范围里的改动，那条放行记录因此失效。重新完整复核一轮，从这一轮重新起头。

前三轮之后的改动：

- 第 1 轮 4 条意见（`reserveModels` 第 1 轮也预留替补；`coveragePoints` 只认清单里、没有 `substitute` 字段的记录；文档写明往 `allowed` 加模型还要什么；`delegate.mjs` 总是写出 `--models`）都已改。
- 第 2 轮 2 条低严重度意见（`covering` 对 `substitute` 字段用同一条件；ADR 和规则措辞）都已改。
- ADR 改号为 0259，引用一起改。
- 这一轮之前最后一个提交：`test/tooling/opencode-review.test.mjs` 里配置校验的用例改用 `Object.assign` 生成变体（不改断言）；ADR 0259 关联文档删掉一句只指向配置文件的话。

作者的说法（请核对，不要直接采信）：

- 默认模型和能用的模型来自 `scripts/model-review/review-models.json`，由 `readReviewModels` 读入、`reviewModelsProblems` 校验。
- 合并前检查里一轮算数的条件：这一轮出现过的、在清单里、没有 `substitute` 字段的模型每个都通过或被替补；或默认模型每个都通过或被替补。链的起点是不带 `--previous` 的算数轮次。

请重点看：有没有哪种账本内容会让没被完整复核的改动通过合并前检查；规则文字和代码是否一致；有没有别处还依赖“第 1 轮两个模型”。
