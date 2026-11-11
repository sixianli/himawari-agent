# PR 381 第 2 轮：按第 1 轮意见的修改，加合入最新 main

上一轮复核的提交是 606862d3。本轮看它之后的两部分：

1. 提交 2a4a3e4b：按第 1 轮意见修改（逐条判断见 `.agents/reviews/pr-381/round-1/judgments.md`）。
   - 模型调用记忆工具时本轮已失去执行权（嵌入准入报 `NOT_AUTHORITATIVE`），不写检索降级记录（`production-run-memory.ts`、`production-memory-composition.ts`）。聊天检索本来就把取消信号传进来（`run-coordinator.ts:474-476` → `context-formation-service.ts:244` → `production-run-memory.ts` 的 `search`）。
   - `make-packet.py` 的嵌入目标按服务启动的条件核对，出包档案清单与 TypeScript 档案一致由测试保证。
   - 本机模型：推理中放弃的调用方不拿向量；关闭先等在算的那条；畸形请求 400/404。
   - 每日摘要补算跳过算不出的那条，一页全失败才报错（`packages/memory-engine/src/episodes.ts`）。
   - 导出测试加正向对照；ADR 0224、威胁模型、规则清单同步。
2. 合并提交（合入 origin/main，带进 P3-3 检索融合后截断去重等）。冲突在 `production-memory-composition.ts`、`production-run-memory.ts`、`hybrid-memory-provider.ts`、`strict-configuration.ts`、`startup-configuration.unit.test.ts`、`prompt-rendering-golden.unit.test.ts`、`memory-retrieval-eval/live.test.ts`；main 新加的 `hybrid-memory-provider.unit.test.ts`、`mcp-read.test.ts` 改用 `embedQuery`/`embedDocument`。只合入 main、没有冲突的文件不用看。

## 请重点核对
- 冲突解决有没有丢掉任何一边的行为（尤其 P3-3 的 `relevance`、`dedupeSameSource`、`onRelevanceUnknown`，和本 PR 的取消判断、本机运行时关闭）。
- 把 `NOT_AUTHORITATIVE` 当作“本轮已不归我”是否会吞掉真实的检索失败。
- 补算逐条跳过后，循环会不会不结束、或在执行权已失时继续花钱。
