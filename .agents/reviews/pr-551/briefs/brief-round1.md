# PR 551 第 1 轮作者说明

问题：想一想方案 v2（`.agents/plan-drafts/think-step-plan.md`，Andy 已同意）第 2 个 PR 的后半。PR 535（入口表和关口）、PR 541（Jev 判断和工人）已合并。这个 PR 把工人接进服务，并加带只读工具的后台运行和把结论写进提议箱。只有配置了 `runPolicy.thinkInbox.worth` 才会启动；这个 PR 里还没有任何来源往入口里交条目（来源接入在 PR 4），所以合并后生产行为不变。

改动：
- `packages/application/src/services/tool-action-registry.ts`：`readOnlyRow`，`offer(descriptors, {readOnly})`。
- `apps/agent-service/src/production-runtime-tools.ts`：新选项 `readOnlyRun(runId)`，为真时只给只读工具。`service-main.ts` 里按运行来源判断：是想一想的运行，或查不到来源时，都按只读处理。
- `packages/prompt-catalog/src/think.ts`：`think.run-task`（发给模型的最后一条用户消息）和三种动作的说明，已登记进 manifest。
- `packages/application/src/services/think-run-answer.ts`：`parseThinkRunAnswer`。
- `apps/agent-service/src/production-think-runner.ts`：`ThreadThinkRunner`，负责建对话、以 external_event 放进消息、轮询运行、读回复、按登记的动作写提议、归档；还有 `isThinkRunSource`。
- `apps/agent-service/src/production-think-actions.ts`：三种动作（task.run、reminder.create、reminder.reschedule），每种都有字段白名单。
- `apps/agent-service/src/production-think-composition.ts`：`productionThinkWorth`、`ThinkLoop`、`productionThinkLoop`；`production-http-composition.ts` 在 listen 时启动、close 时停止。
- 配置新增 `runPolicy.thinkInbox.idleSeconds`（5 到 86400，默认 60）和 `runTimeoutMinutes`（1 到 120，默认 10）。
- 文档 `docs/architecture-v0.1.md` 新增一条。
- 测试：`test/integration/think-runner.test.ts`（真 SQLite，只模拟运行结果）、`apps/agent-service/test/think-run-pieces.unit.test.ts`、`production-runtime-tools.unit.test.ts` 新增一条、配置测试。

约束：不改系统提示和工具定义的已有内容；任务说明只作为新对话里的一条新消息；不改授权规则（refuseBackgroundAfterExternalContent 仍然拒绝非 READ 动作，作为第二道防线）；不写代码注释。

作者的说法（请核对，不要照信）：
1. 想一想的运行拿到的工具只有 READ、sideEffect none、family 为 builtin 或 web 的那些；查不到运行来源时也只读。
2. 模型回复不是约定 JSON、动作没登记、字段多了，都不写提议。
3. 运行超时或被取消时，对话照样归档（`finally`），工人把条目记为失败。
4. 想一想的运行来源是 external_event，消息编号以 `message:think:` 开头，`isThinkRunSource` 只认这一种。
5. `ThinkLoop.stop` 会等正在做的那一步结束，不留定时器。

请重点核对：
1. 有没有一种路径能让想一想的运行拿到写工具，或者让普通运行被误当成想一想的运行而丢了工具。
2. `ThreadThinkRunner.think` 里的幂等性：同一条目重试时（建对话、放消息用了固定的 idempotencyKey 和编号）会不会报错或重复开运行；归档之后重试会怎样。
3. 超时之后，后台运行本身会不会还在继续跑、继续花钱；对话已归档时运行来源读不到，`readOnlyRun` 返回只读，这个兜底是否成立。
4. `#await` 轮询找最后一条 agent 消息的条件（runId、role、committed）是否会读到错误的消息。
5. `ThinkLoop` 的调度：stop 和正在跑的 tick 竞争时会不会又排上一次。
