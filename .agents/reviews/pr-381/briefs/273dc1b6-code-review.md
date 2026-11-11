# PR 381 第 5 轮：按第 4 轮意见的修改

上一轮复核的提交是 cfd8b032。本轮看之后的修改提交 273dc1b6（逐条判断见 `.agents/reviews/pr-381/round-4/judgments.md`）：

- `packages/memory-engine/src/episodes.ts`：补算记住上次停在哪一条（按 owner、agent、模型、维度分开），下次从那之后翻页；翻到底时从头再翻一遍（每次最多绕回一次）；每次最多试 3 条算不出来的；一次一条都没算成才抛错。
- `packages/application/src/ports/memory-episodes.ts`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts`：`listUnembedded` 加可选的 `after` 位置，SQL 用 `(created_at, id) > (?, ?)`。
- `apps/agent-service/src/local-vector-catch-up.ts`（新）和 `service-main.ts`：本机模型就绪后的全量补算失败时按 1 分钟起、加倍、最长 1 小时重试，成功后不再跑。
- `apps/agent-service/src/production-run-memory.ts`：诊断统一走不抛错的 `diagnose`。
- `scripts/delivery-mode/make-packet.py`：超大整数费用、分类里夹着非字符串都干净拒绝。

## 请重点核对
- 补算翻页会不会不结束、漏掉好条目，或在同一次里把同一条坏条目试两次以上。
- 重试定时器在服务关闭、模型变为不可用时的行为。
- 新增的 `after` 条件在 SQLite 里的排序和比较是否和 `ORDER BY created_at, id` 一致。
