# PR 372 第 2 轮判断

- r2-1（低，成立，模型标中）：序号只出现在发给外部 agent 的内容里，不进 Himawari 的模型请求，不影响缓存，按低处理。改为返回前去掉序号，只留类别（`[密码]`）；新单元用例断言同一段文字和无关内容一起遮时字节不变，去掉这一步时这条用例失败。
- r2-2（不成立）：提示词目录里每一条不少于 24 字的固定文字本来就进可信文字清单，这是 `.claude/rules/prompt-prefix.md` 第 11 条写明的既有做法，任何新提示词都一样。这四句没有数字、没有会被认成敏感信息的内容，已发历史里不会出现它们原句之外的变化。
- r2-3（低，成立）：确认检索失败后先等待确认检索那一路结束再报失败，费用快照不会早于另一路的嵌入。
- r2-4（低，成立）：没开网页服务却配置了 `mcpRead` 时也启动失败。
- r2-5（低，成立）：`production-http-composition.unit.test.ts` 加正向用例：真实组装里配了入口时只凭令牌就能调通 `today_context`，没令牌回 401 且不写记录。
- r2-6（低，成立）：`redaction.unit.test.ts` 加 `maskSensitiveTexts` 的直接用例。`today_context`、`rule_book` 的失败和 `find_memories` 走同一个 `#call`，不另加。
- r2-7（不成立）：实测带令牌的 GET、DELETE 由 SDK 立即回 405（`{"code":-32000,"message":"Method not allowed."}`），没有长连接，不会被缓冲卡住。
