# PR 456 第 2 轮复核材料

背景、目标、约束同第 1 轮（`.agents/reviews/pr-456/briefs/ff4258883702-code-review.md`）。第 1 轮的逐条判断在 `.agents/reviews/pr-456/round-1/judgments.md`。

## 这一轮改了什么（请逐条核对，不要直接采信）

1. 冻结动作意图改成先查再写（`apps/agent-service/src/production-runtime-tools.ts` 的 `#ownerScopeGate`）：同一次调用重放时读回第一次存下的意图，时钟前进不再冲突。
2. 统一出口抛异常时按拒绝处理，原因码 `authorization_component_error`；这一轮已停或已取消时照旧抛出；这次失败不记成最终结果。
3. `#ownerScoped` 复用 `#inFlight`，同一个 runId 加 toolCallId 的并发调用合并成一次。
4. 规则修订号变化：代码没改（仍开着的记录自动更新到新修订号，关掉的保持关掉），ADR 新值清单那一行改写清楚，并加了用例。
5. ADR 写明登记表里哪几列第 1 步只登记、还没有地方读；前提表的行号按现在的代码更新。
6. 新用例：`test/integration/tool-action-registry.test.ts`（时钟前进后重放、并发、修订号）、`apps/agent-service/test/production-runtime-tools.unit.test.ts`（出口抛错、内置工具走读取和走出口的行固定）。

请特别看：先查再写在两次并发首次调用下会不会仍然冲突（现在有同键合并，但合并只在同一个进程里）；出口抛错按拒绝处理会不会吞掉不该吞的错误；`#inFlight` 里 `owner-scoped:` 前缀的键会不会和写代码工具用的键相撞。
