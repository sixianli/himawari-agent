# PR 381 第 6 轮：按第 5 轮意见的修改

上一轮复核的提交是 273dc1b6。本轮看之后的修改提交 667cb8f8，以及随后合入 main 的合并提交 586a7171（冲突只在配置端口、`strict-configuration.ts` 和它的测试：main 新增了几个必填字段，本分支把 `memoryMinimumSimilarity` 改成可选、缺省取嵌入档案的门槛，两边都保留；另把 main 新加的 `mcp-write.test.ts` 改用 `embedQuery`/`embedDocument`）（逐条判断见 `.agents/reviews/pr-381/round-5/judgments.md`）。第 5 轮的几条意见都来自“记住上次补到哪一条”的做法，这一轮把它换掉了：

- `packages/memory-engine/src/episodes.ts`：不再记共享位置。算不出来的摘要记一个“多久之后再试”（1 小时起、加倍、最长 24 小时，存在服务实例的内存里，成功后删掉）；每次补算从头翻页（用 `after` 只在这一次里往后翻），跳过还在等的条目和另一次补算正在算的条目；每次最多新试 3 条算不出来的；这次新试的都失败、一条也没补上才抛错。
- `apps/agent-service/src/local-vector-catch-up.ts`：先排好重试再写诊断，写诊断放进 try。
- `test/integration/memory-episodes.test.ts`：真实 SQLite 用例，两条不同创建时间的摘要核对 `after`。

## 请重点核对
- 翻页会不会不结束，或漏掉不在等的好条目。
- “在等”的判断用 `now()` 的时间，时钟回拨时会怎样；内存里的记录会不会无限增长。
- 全量补算（limit 100 循环到返回 0）在只剩在等条目时是否一定结束。
