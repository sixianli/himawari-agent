你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条意见单独一个以「### 」开头的三级标题（标题里写序号、严重度和一句话问题），下面写：文件:行、问题、证据（引用你亲自读到的那几行代码）、建议；意见以外的内容不要用三级标题。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 91ff65c3d144535847653e8d9ff1078056b244d4。
对比基准是 de1c3a39cf466f2870882687bd3d3f0c57535b13，先运行 git diff de1c3a39cf466f2870882687bd3d3f0c57535b13..91ff65c3d144535847653e8d9ff1078056b244d4 看改动。
作者的说法（可能有错，请核对）：
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
