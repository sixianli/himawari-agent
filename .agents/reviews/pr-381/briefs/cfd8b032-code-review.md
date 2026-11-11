# PR 381 第 4 轮：按第 3 轮意见的修改

上一轮复核的提交是 0829c5e7。本轮看之后的修改提交 cfd8b032（逐条判断见 `.agents/reviews/pr-381/round-3/judgments.md`）：

- `packages/memory-engine/src/episodes.ts`：补算去掉“失败满 3 条就停”，只在成功数到 limit 时停；仍多取 3 条候选，一页一条都没成才抛错。
- `apps/agent-service/src/production-run-memory.ts`：未开始时清理里的 `permit.releaseReserved()` 放进 try/catch，失败只写诊断 `memory.embedding_release_failed`，仍抛原错误。
- `scripts/delivery-mode/make-packet.py`：费用必须是有限数字；能力和数据分类不许重复。
- `scripts/delivery-mode/deploy-preflight.py`：包里的嵌入目标缺模型名、哈希或维度时给出明确的停止原因。
- 测试和 ADR 0224 同步。

## 请重点核对
- 补算新停止条件在 catch-up 的 `for (;;)` 里会不会不结束，或一直重试同一条坏条目而不前进。
- try/catch 里写诊断本身失败时，原错误是否仍被抛出。
- 出包新规则会不会拒绝一份服务启动能接受的合法目标。
