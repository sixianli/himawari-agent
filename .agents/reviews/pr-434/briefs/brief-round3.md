# PR 434 第 3 轮作者说明

第 2 轮 DeepSeek 5 条意见全部成立（中高 1 条），判断在 `.agents/reviews/pr-434/round-2/judgments.md`。这一轮请先看增量 `8ae3a349f..35f17e3c0`。

改动：
- 暂停后重新排队的规则：`sqlite-correction-review-operations.ts` 的 `listOpenRules` 多返回 `rechecking`（`review_after` 非空、有来源记忆、失败次数没到上限）；`memory.review.snapshot` 的规则加 `rechecking`；`correction-review.tsx` 在暂停原因后显示“来源记忆又变了，系统会再核对一次”。
- 契约测试：`recordFailure` 写 `source_unreadable` 后读回；结清后上游再变，直接下游和间接下游重新打开；重新排队后 `listOpen` 返回 `rechecking: true`。
- 文档：ADR 0232 决定 1 改写展开上限的说法，决定 2 写明重新排队时清单怎么显示；`docs/execution/specs/2026-11-09-decision-record-write-convention.md` 补 `memory_review`。

请核对：
1. `rechecking` 的判定和 `ruleReview.listDue` 实际会不会再核对这条规则是否一致（有没有显示“会再核对”却永远不核对，或反过来）。
2. 这轮修改有没有引入新问题；文档改后的说法和代码是否一致。
