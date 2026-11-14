# ADR 0243 代码说法核对（第 3 轮）

78 条说法，75 条一致，3 条“找不到”，都是模型没去找：

- 72“记录在 `.agents/reviews/topic-ci-no-artifacts/`”：目录在，`usage.jsonl` 里有 plan 和 plan-review 记录。
- 73“共 0.36 美元”：同一份 `usage.jsonl` 里方案讨论的三条记录（GLM plan 0.1039、DeepSeek plan 0.1753、DeepSeek plan-review 0.0844）合计 0.3637 美元，不含这次核对。
- 78“旧的 PR 运行日志里没有汇总结论，main 会退回完整 CI”：`decodeGate` 找不到开始和结束标记时抛 `MAIN_GATE_LOG_MISSING`，`main-evidence.mjs` 的 `main()` 默认结果是 `mode: "full"`，出错时保持它。
