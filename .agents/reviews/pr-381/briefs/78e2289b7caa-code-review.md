# PR 381 第 3 轮：按第 2 轮意见的修改

上一轮复核的提交是 432fe4b8。本轮只看之后这一个提交（逐条判断见 `.agents/reviews/pr-381/round-2/judgments.md`）：

- `packages/memory-engine/src/episodes.ts`：补算多取 3 条候选，成功数到 limit 或失败满 3 条就停。
- `apps/agent-service/src/production-run-memory.ts`：`whileHeld` 只把执行权检查（准入 begin、assertActive、markStarted）抛出的 `NOT_AUTHORITATIVE` 放进 `leaseLost`；取消判断另认 MCP 读取的 `mailScope` 信号。
- `scripts/delivery-mode/make-packet.py`、`embedding-artifact-check.py`、`deploy-preflight.py`：出包和上线前检查对齐服务启动、加载的规则。
- `packages/prompt-catalog/src/memory.ts`：EmbeddingGemma 查询前缀拆成两段，出口遮盖的固定文字清单与 main 相同。
- 测试和 ADR 0224 同步。

## 请重点核对
- `whileHeld` 是否漏包了某个执行权检查，或包进了不该算“执行权已失去”的步骤。
- 补算新停止条件在 catch-up 的 `for (;;)` 里会不会不结束。
- 出包新规则会不会拒绝一份服务启动能接受的合法目标。
