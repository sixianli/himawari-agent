# PR 434 第 1 轮复核判断

两个模型共 15 条意见：成立 13 条（中高 10 条、低 3 条），不成立 2 条。全部成立的都改了，每处都补了在修复前会失败的测试。

| 编号 | 模型 | 意见 | 判断 | 依据和处理 |
| --- | --- | --- | --- | --- |
| d1 | DeepSeek | 导出带出 `memory_review` 决策，导入的 schema 不认 | 成立，中高 | `schemas.ts` 的 `DECISION_SCHEMA.kind` 没有 `memory_review`。新测试 `data-export-rules.test.ts` “[P4-1] a paused rule …” 修复前报 `DATA_IMPORT_LINE_INVALID … $.kind`。加进枚举。 |
| d2 | DeepSeek | 新约束和设置页写规则、测试夹具冲突 | 成立，中高 | 实际运行 `rule-memory-review.test.ts`、`mcp-read.test.ts` 共 31 条失败（CHECK constraint failed）。`writeRule` 回到 active 时清掉核对字段；`mcp-read` 夹具给待重审规则写 `review_after`。 |
| d3 / g1 | 两个都提 | 来源记忆读不出时异常冲出、无限重试 | 成立，中高 | `rule-review-service.ts` 只接 `RuleTypeError`。改为记失败原因 `source_unreadable`（迁移约束、端口类型、存储都加上），走同样的 3 次上限。单元测试修复前抛 `RULE_REVIEW_MEMORY_UNREADABLE`。 |
| d4 | DeepSeek | 暂停规则再次变化时保留旧建议；ADR 决定 2 说法不符 | 成立，中高 | 两个触发器重新排队时清掉 `suggestion`；契约测试修复前读到旧建议。“待重审”记录：还在待重审的不重复写，暂停后重新排队算新一轮写一条，ADR 决定 2 按代码写清。 |
| d5 | DeepSeek | “采用建议”只显示一句说明 | 成立，中高 | 快照新增 `suggestionConditions`（发件域名、地址、短语、词、排除短语），清单逐条列出；网页单元测试和集成测试都断言。 |
| d6 | DeepSeek | 每次展开 200 行的上限没写 | 成立，低（模型：低） | 只在一次改动带出超过 200 行直接下游时出现，多出的下次接着展开；ADR 决定 1 补写。 |
| d7 | DeepSeek | “确认暂停”实际是停用 | 成立，中高（模型：低） | 判高一档：文案会让 Andy 以为还能恢复。按钮改成“确认停用”（英文、日文同改），ADR、案例 92、周报说明同改。 |
| d8 | DeepSeek | 导入空库检查不含 `memory_review_items` | 不成立 | `memory_review_items.memory_id` 外键指向 `memory_records`，而 `memory_records` 已在 `EMPTY_TARGET_TABLES`；有残留行必然有记忆行，导入已会被拒绝。 |
| g2 | GLM | 导出导入暂停规则没有测试 | 成立，中高 | 就是这个缺口让 d1 漏掉了。补了往返测试：暂停原因带过去，建议值和待重审标记不导出、计数对，`memory_review` 决策导回。 |
| g3 | GLM | 读不出文字的待重审记忆被跳过却仍计数 | 成立，中高（模型：低） | 判高一档：正常数据（密文缺失）就会触发，这条永远点不掉。改为照样列出、文字为空时显示“这条记忆的文字读不出来”；契约 `text` 改为可空；网页测试覆盖。 |
| g4 | GLM | 同时有系统标记和漏标时按系统标记计 | 不成立 | 系统确实标过这条，按 ADR“系统标出的记忆被 Andy 改了”算一次处理；漏标在报的时候已单独计数，结清时不再计入分母。 |
| g5 | GLM | 删除后从回收站恢复不重新列入 | 成立，低（模型：低） | 行为合理（删除即处理过），ADR 决定 5 补写这个口径。 |
| g6 | GLM | 展开冲突时不取最短层数 | 成立，中高（模型：低） | 判高一档：除了层数显示偏大，较深路径覆盖时这行被标成已展开，剩余层数变少，接近 8 层时会漏标。只在更短时覆盖；契约测试修复前 `m:c` 层数为 2。 |
| g7 | GLM | ADR 说周报有 Wilson 区间 | 成立，低（模型：低） | 改为“比例旁边写样本数，样本不够不出比例”。 |

另外：d2 暴露出之前只跑了 `npm run check` 和相关测试、没跑全套测试。这次改完后跑全套测试。
