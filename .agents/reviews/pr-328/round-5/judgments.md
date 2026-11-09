# PR 328 第 5 轮判断

本轮只有「可以更好」和不成立的意见，没有会出错的意见。

| 编号 | 判断 | 说明 |
| --- | --- | --- |
| r5-1 | 可以更好 | 给文档交叉链接和 ADR 标题号加自动检查是防回归的建议，不改变现有行为；列给 Andy，他说采纳才做 |
| r5-2 | 不成立 | `decision_ledger.inputs` 列有 `CHECK (json_valid(inputs) AND json_type(inputs) = 'object')`（迁移 0069_decision_ledger.sql:21），库里不会有读不出的 inputs；第 4 轮已判过 |
