# PR 354 第 2 轮：只看第 1 轮之后的修改

第 1 轮意见和处理见 `.agents/reviews/pr-354/round-1/judgments.md`。这一轮的修改：
- `pi-tool-batch-continuation.ts`：`runsInParallel` 先查 `session.getActiveToolNames()`，再用 `session.getToolDefinition` 取执行方式；`BatchSession` 加 `getActiveToolNames`。
- `tool-batch-state.unit.test.ts`：假会话加 `getActiveToolNames`；新用例“注册了但没激活的可并行工具按顺序处理、激活后按并行处理”。
- 两个文件 Biome 格式化；偏离表 D5、ADR 0204 前提 3、4、5 同步。

Pi 1.5.0 源码在 node_modules/@earendil-works/pi-coding-agent（dist/core/agent-session.js 第 1100 行 getActiveToolNames、第 1123 行 getToolDefinition），读不到就标未核实。
