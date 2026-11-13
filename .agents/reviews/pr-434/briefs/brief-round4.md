# PR 434 第 4 轮作者说明

第 3 轮 DeepSeek 4 条意见全部成立（中高 1 条），判断在 `.agents/reviews/pr-434/round-3/judgments.md`。Andy 2026-11-12 在卡片上选了“再复核一轮，并核对 ADR”。这一轮请先看增量 `839c3ab8b..bfa53c9d3`。

改动：
- `correction-review.tsx`：待重审（没有暂停原因）的规则按 `rechecking` 选文案，`rechecking` 为假时显示 `review.notChecking`（系统没法自动核对，规则照常执行，请你看一下），不再显示“等系统自动核对”。
- 三种语言文案：`review.checking`、`review.rechecking` 写明核对发生在下次查邮件前；新增 `review.notChecking`。
- 测试：网页单元测试覆盖 `rechecking: false` 的待重审规则；契约测试断言核对出结论后、失败到上限后 `listOpen` 的 `rechecking` 为 false。
- ADR 0232：决定 4 分开写待重审和已暂停两种规则在核对失败后的状态，后果一节写明没配置邮件检查的部署上文案不兑现。

请核对：这轮修改是否修掉了第 3 轮的问题，有没有引入新问题，文档改后的说法和代码是否一致。
