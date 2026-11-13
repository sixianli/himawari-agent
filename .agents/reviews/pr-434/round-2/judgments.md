# PR 434 第 2 轮复核判断

DeepSeek 5 条意见，全部成立：中高 1 条、低 3 条、可以更好 1 条。另有两条模型自己标为“推测”的，不计入意见，判断写在最后。

| 编号 | 意见 | 判断 | 依据和处理 |
| --- | --- | --- | --- |
| r2-1 | 暂停规则重新排队后，清单只显示旧的暂停原因 | 成立，中高 | `correction-review.tsx` 只按 `suspendReason` 是否为空选文案。快照规则加 `rechecking`（`review_after` 非空、有来源、失败次数没到上限），清单在暂停原因后写“来源记忆又变了，系统会再核对一次”；契约测试和网页测试覆盖；ADR 决定 2 写明。 |
| r2-2 | `source_unreadable` 没测到 SQLite 约束 | 成立，低（模型：低） | 现在三处一致；补契约测试，`recordFailure` 写 `source_unreadable` 后读回。 |
| r2-3 | ADR“每次最多展开 200 行”说法不准 | 成立，低（模型：低） | ADR 决定 1 改写成“最多处理 200 条还没展开的行，每条各自再往下追，一次写入的行数可以超过 200”。 |
| r2-4 | 重开、再次标出没有回归测试 | 成立，可以更好 | 逻辑没错；新写的契约测试用现在的代码通过。Andy 说过“可以更好”直接改，测试已提交。 |
| r2-5 | 决策记录写法规范没列 `memory_review` | 成立，低（模型：低） | 规范补上 `memory_review` 和 `rule_review` 的新写入路径，改正“迁移 0087 的触发器”这句。 |

推测两条：
- 导出格式版本没升：导出 v3 是 PR 420 刚合进 main 的，还没上线过（下一次上线才第一次带出 v3），所以 `suspended`、`memory_review` 加进 v3 不会出现“旧 v3 读不了新 v3”的实际场景。不升版本，汇报里告诉 Andy。
- `suggestionConditions` 对脏数据的容错：`suggestion` 只由 `ruleReview.resolve` 写入，写入前经过 `parseOwnerRuleParameters`；模型自己也说不可复现。不改。
