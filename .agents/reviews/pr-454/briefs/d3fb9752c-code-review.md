# PR 454 第 5 轮：对第 4 轮修改的复核

问题、目标、约束同第 1 轮材料（`.agents/reviews/pr-454/briefs/b2a560461af4-code-review.md`）。这一轮请先看 `982da2990` 之后的增量（对比基准用最新 main 的三点 diff，不要用两点 diff：复核期间 main 还在动，上一轮就因此把 main 新进的内容误算成本 PR 的删除）。

## 作者的说法（请核对，不要直接采信）

1. `deleteGitHubMonitorHistory`（`packages/persistence-sqlite/src/sqlite-durable-operations.ts`）删 runs 时，现在同一事务里先收集这些 run 的 `device_actions` 的参数和结果载荷引用，再删 `device_actions` 行；`test/integration/github-durable-state.test.ts` 补了断言，去掉修复时该断言失败（expected 2 to be 0）。
2. 之后又合了两次最新 main（含苹果推送 443、语音收件人判断、查询预取、OwnerIntent 闸门）：冲突两边都保留；设备事件流在撤销检查后同时通知推送“连接还活着”；`service-main.ts` 里 `externalContent` 在设备动作之前构造，只有一份。
3. 完整 `npm run check` 56 步全过；设备动作相关 5 个测试文件 76 条全过。

## 之前判为不成立、这一轮不必重提的

终态动作的保留期（列给 Andy 定）；策略变更不能收回已送达的动作（第 9B 批）；`reopen` 开头的 `settle()` 没有上限；重装后排队中的动作不转结果未知；工具描述说“会先请主人确认”而审批尚未接上（下一个 PR 接上，工具定义按对话冻结，不改两次）；最近结束列表的 100 条上限；决策记录在状态提交后写失败和撤销触发器不写账（低，已判）。理由见各轮 `judgments.md`。
