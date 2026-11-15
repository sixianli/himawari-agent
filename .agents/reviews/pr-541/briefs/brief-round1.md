# PR 541 第 1 轮作者说明

问题：想一想方案 v2（`.agents/plan-drafts/think-step-plan.md`，Andy 已同意）的第 2 个 PR 前半。PR 535 已合并入口表和关口；这个 PR 加“第一次判断”和工人，新增后台模型调用（Jev 是非题）。没有任何调用方接入工人，所以合并后生产行为不变。

改动：
- `packages/application/src/ports/think-worth.ts`、`services/think-worth-answer.ts`：判断端口、对 Jev `/decisions` 响应的严格解析（`parseThinkWorthDecision`）、按两个门槛判断（`judgeThinkWorth`：思考 / 跳过 / 不确定）。
- `packages/prompt-catalog/src/think.ts`：提示词 `think.worth-question`，登记进 `prompt-manifest.json`；`apps/agent-service/test/prompt-output-contracts.unit.test.ts` 加了解析器和提示词编号。
- `packages/platform-node/src/think-worth-decision.ts`：Jev 适配器（模仿 `owner-intent-decision.ts`）：`zeroDataRetention`、出口遮盖、请求和响应大小上限；`scripts/check-egress-redaction.mjs` 登记了这个文件。
- 配置 `runPolicy.thinkInbox.worth`（模型、密钥引用、两个门槛、超时），`configuration.ts` + `strict-configuration.ts`。
- `apps/agent-service/src/production-think-worker.ts`：`ProductionThinkWorker.runOnce`。
- ADR 0274（已跑 `plan-claims`，第 2 轮 49 条全部一致）。
- 测试：application 解析单测、platform-node 适配器对本机回环桩的测试、`test/integration/think-worker.test.ts`（真 SQLite + 回环 Jev 桩）、配置测试。

约束：不改系统提示和工具；不改授权规则；不写代码注释；不接线（没有 service-main 调用方）；带工具的运行器在后续 PR。

作者的说法（请核对，不要照信）：
1. 判断失败、解析失败、超时、模型名不符一律不想，条目记 `failed`/`worth_unavailable`，不开运行。
2. 中间带（高于 300‰ 低于 700‰）当“不确定”，也不想，记 `skipped`/`worth_unsure`。
3. 发给 Jev 的只有来源说明、一句概括、是否外部内容，且先过 `redactForExternalText`。
4. 运行器抛错时条目记 `failed`/`think_failed`，工人不抛出。
5. 工人一次只处理一条，每次先做维护。

请重点核对：
1. `ProductionThinkWorker.runOnce` 里，领了条目之后的每条路径是否都会把条目从 `thinking` 结束（比如读摘要抛错、`finish` 自己抛错、信号被取消），会不会留下永远 `thinking` 的条目（恢复靠 `recoverStalled` 的时限）。
2. `parseThinkWorthDecision` 对 Jev 响应的校验是否会放过不合法的概率（和不为 1、超出 0 到 1、重复选项、选项名不对、所选与最大概率不一致）。
3. `judgeThinkWorth` 与配置范围（`yesAtLeastPermille` 501 到 1000、`noAtMostPermille` 0 到 499）的边界是否一致，有没有输入让“不确定”区间消失或颠倒。
4. 超时和调用方的取消信号合并（`AbortSignal.any`）是否正确，超时后是否一定走“不想”。
5. 配置解析 `parseThinkWorth` 对缺省值和非法值的处理；`worth` 缺省时 `thinkInbox` 其他字段不受影响。
