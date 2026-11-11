# PR 382 第 2 轮判断

- r2-1（中，成立）：只有部分摘要正文读不到时（`recent()` 返回 `partial`），不写 `mcp-read.summaries-failed`，和 ADR、作者说法不符。改为 `partial` 时也调 `onSummariesFailed`，错误码 `MCP_READ_SUMMARY_TEXT_UNREADABLE`；partial 集成用例断言这一条，且 `onFailure` 不被调用。ADR 0219 决定 7 同步。
- r2-2（低，成立）：`insertLedgerRow` 只看 `summaryRead`，只带部分六项时静默丢掉。改为先用 `summaryInputsValid` 校验再判断种类；单元用例补 consolidation 只带两项、external_read 只带一项都抛错，表里只剩合法那一行。
- r2-3（低，成立）：没接摘要源的分支没有用例。集成测试加 `withoutSummaries`：返回里没有 `recentDays` 和 `recentDaysComplete`，决策记录的输入字段里没有任何 summary 键。工具说明是给外部模型的固定文字，不按部署形态分支，ADR 0219 决定 7 已写明。
- r2-4（低，成立）：ADR 0216 决定 6 说抽屉显示摘要，没限定种类。在决定 6 末尾补一句：外部读取的六项只在输入字段里，抽屉和 `mails.summaries` 不显示；ADR 0219 决定 7 同步。
- r2-5（不成立，模型自己也说不是缺陷）：摘要排在提醒后面、遮法受前面提醒影响，符合“只取决于自己和前面的内容”，只影响外部工具结果。不改。
