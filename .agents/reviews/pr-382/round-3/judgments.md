# PR 382 第 3 轮判断

- r3-1（低，成立，模型标中）：`recent()` 的 `partial` 除了正文读不到，还包括候选太多被截断，错误码叫 `MCP_READ_SUMMARY_TEXT_UNREADABLE` 名不副实。只影响一条服务日志的错误码名字，决策记录（`partial`）和返回内容都对，按低处理。改名为 `MCP_READ_SUMMARIES_INCOMPLETE`，ADR 0219 决定 7 写明两种情况；集成用例断言新码。
- r3-2（低，成立，只更正判断表述）：第 2 轮 r2-5 说“遮法只取决于自己和前面的内容”不准确。`maskSensitiveTexts` 先把整次返回的点名值都记下再遮，所以后面的摘要点名的值也会遮掉前面提醒里的同一个值。这是 PR 372 有意的做法（ADR 0219 决定 3：一次返回里任何一段点名的值，整次返回都遮掉，不论顺序；为的是不漏秘密），只影响对外工具结果，不进 Himawari 自己的请求和历史。代码不改。
- r3-3（不成立）：遮盖或序列化抛错时摘要记 `failed`。这时什么都没交给对方，`summaryInjected` 为假，记“读取失败”与“没交出去”一致；`onSummariesFailed` 在生产只写一行日志，不会抛错。
- r3-4（可以更好，不采纳）：截断型 partial、service-main 的日志事件名、restricted 摘要排除没有 MCP 层用例。restricted 排除在 `recent()` 内部，由 P3-6 的用例覆盖；其余列给 Andy。
- r3-5（不成立）：存储里 day、id 不合校验时拖垮整次读取。模型自己确认 `upsertEpisode` 写入时已校验 day，id 由固定格式生成，正常路径到不了。
