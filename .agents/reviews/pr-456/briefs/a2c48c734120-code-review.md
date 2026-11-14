# PR 456 第 3 轮复核材料

背景、目标、约束同第 1 轮（`.agents/reviews/pr-456/briefs/ff4258883702-code-review.md`）。前两轮的逐条判断在 `.agents/reviews/pr-456/round-1/judgments.md` 和 `round-2/judgments.md`。

## 这一轮改了什么（请逐条核对，不要直接采信）

1. 统一出口抛错时存一条诊断记录（`apps/agent-service/src/production-runtime-tools.ts` 的 `#ownerScopeGate`，键 `owner-scope-diagnostic:` 开头），内容是错误代码；存不进去时忽略。仍按拒绝处理，没有把配置类错误往上抛，理由在 round-2/judgments.md 的 ds-2。
2. 补用例：出口抛错时这一轮已停或调用已取消，执行抛出（`apps/agent-service/test/production-runtime-tools.unit.test.ts`）。
3. ADR 0257：“后果”一节写清提醒、规则的动作意图存下后原样读回，不重新组；写明出口出错的处理和并发合并只在同一进程有效；前提表表头写明行号已按分支更新。

第 2 轮判为不成立的两条（同键合并共享取消、跨进程并发）理由在 round-2/judgments.md，除非有新的证据，不用重复提。
