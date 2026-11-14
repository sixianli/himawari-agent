# PR 408 第 7 轮逐条判断

- **ds7-1**（deepseek-v4.1-flash）「待确认 1000 条上限只统计 `pending`，同一个 key 反复换正文可绕开上限，长期堆积 `superseded` 正文」：成立，中。已改：另加一条上限，待确认加上还留着正文的拒绝、被替换条目合计最多 5000 条；回复文字改成「待确认或刚处理过的内容太多」。补用例，旧代码下失败（已实际运行）。
- **ds7-2**（deepseek-v4.1-flash）「`undoBatch` 先逐条 `trash`，再单独开事务重开提议；中途失败会留下「记忆已进回收站、提议仍是 committed」」：成立，中低。已改：中途失败时先把已移进回收站的那几条对应的提议重新打开，其余留在批次里可以再撤销。补用例，旧代码下失败。
- **ds7-3**（deepseek-v4.1-flash）「写入器先存 payload 再调用存储层；除了 `PENDING_FULL`，其它 submit 失败会留下没人引用的 payload」：不成立（同第 4 轮 ds4-4）：引用由作用域、分级和正文摘要决定，重试写同一个引用，不会越积越多；只在写库失败且永不重试时留一份，2000 字为上限。
- **ds7-4**（deepseek-v4.1-flash）「彻底删除记忆时把提议改成 `rejected`，但没有清 `batch_id`，批次统计和撤销语义会偏差」：成立，低。已改：同时清 batch_id。补断言，旧代码下失败。
- **ds7-5**（deepseek-v4.1-flash）「网页 `respond` 对 `editedText` 的整批预校验和 ADR 的「逐条处理、失败不回滚已成功」不完全一致」：不成立：空的改后正文是命令本身写错，网关对写错的命令整条拒绝是现有惯例（记忆页其他命令同样先 assertStorable）；正文内容的问题（超长、密钥）才逐条处理。
- **ds7-6**（deepseek-v4.1-flash）「`ProductionMcpMemoryWriter.reopenBatch` 在 round 7 之后只剩测试在用，且语义与 `undoBatch` 不同」：成立，低。已删掉这个方法，用例改用 undoBatch。
