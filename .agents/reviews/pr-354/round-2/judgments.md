# PR 354 第 2 轮复核判断

只跑 DeepSeek，复核 `729b9163..4c8acc95`。没有成立的中、高意见。

| 编号 | 意见 | 判断 | 处理 |
| --- | --- | --- | --- |
| r2-ds-1 | 新用例激活分支靠结果数量报错间接断言 | 成立，可以更好 | 不改，列给 Andy |
| r2-ds-2 | 活动集合和注册表分两次查 | 成立，可以更好；ADR 0204 前提 4 已写明不中途增删工具 | 不改 |
| r2-ds-3 | 锁定版本可能没有 `getActiveToolNames` | 不成立：1.5.0 `dist/core/agent-session.js` 第 1100 行有这个方法，`agent-session.d.ts` 第 423 行有类型；`npm run typecheck` 通过，用真实 Pi 跑的 `pi-tool-batch-continuation.compat.test.ts` 通过（`vitest packages/runtime-pi` 434 条全过） | 不改 |
| 第 1 轮记录读不到 | 模型的副本读不到记录目录 | 不是代码问题 | 不改 |
