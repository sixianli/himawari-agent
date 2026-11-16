本轮改了什么：提交 b835de779（上一轮复核到 a9c6da6bd，之后的 299836409 只是第 6 轮复核记录）。

为什么改：第 6 轮第 1 条（中高）：增量轮没给 --pr-brief 时（委托给云端线程的轮次 delegate.mjs 不传它，或主线程去掉了），SHADOW_FULL_SUGGESTED 打印的整份全量复核命令用 options.prBrief ?? options.brief 静默拿本轮材料顶替整份 PR 材料。第 2 条（低）：第 1 轮材料不在时 --pr-brief 会以 ARG_PR_BRIEF_MISSING 拒绝，流程卡没说可以去掉这个参数。

作者的说法（只针对本轮增量）：

1. increment.mjs 新增 shadowSuggestion：参数里有 prBrief 时返回 "SHADOW_FULL_SUGGESTED " 加 shadowCommand（--brief 用 prBrief），没有时返回 "SHADOW_FULL_SKIPPED pr-brief-missing"，不再用本轮材料顶替。
2. opencode-review.mjs 打印抽样建议的地方改用 shadowSuggestion，打印条件（有内联增量、有 ok 结果、抽样次数未满）不变；不再导入 shadowCommand。
3. 流程卡第 1 步和 model-review.md 写明：第 1 轮材料不在时去掉 --pr-brief，这一轮打印 SHADOW_FULL_SKIPPED pr-brief-missing、不建议抽样；委托给云端线程的轮次同样如此。
4. 新增测试覆盖 shadowSuggestion 的有 prBrief 和没有 prBrief 两种情况。
5. 这次没有改发给模型的提示内容。
6. 另有一个只改文档的提交：ADR 0280“增量轮的任务也只限增量”一节加了数据文件链接、第 5 轮秒数（668 和 151），新增 docs/assets/review-cost/2026-11-16-incremental-round-task-scope.txt 记录该节数字的取法和数据；数字与 .agents/reviews/pr-584/usage.jsonl 一致。
