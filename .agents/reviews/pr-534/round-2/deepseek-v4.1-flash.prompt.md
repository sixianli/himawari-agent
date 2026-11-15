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
仓库就是当前目录，已检出 03175cecee1f10f8e37f2a1467898dc880c2de7d。
对比基准是 e2af704163a17a3d76477b2f375fa0e410250801，先运行 git diff e2af704163a17a3d76477b2f375fa0e410250801..03175cecee1f10f8e37f2a1467898dc880c2de7d 看改动。
上一轮复核到 87e20cc11b193fedfc6ac7f36a29934a2de09a2e，这一轮先看 git diff 87e20cc11b193fedfc6ac7f36a29934a2de09a2e..03175cecee1f10f8e37f2a1467898dc880c2de7d 的增量，只做三件事：一、下面列出的上一轮意见是否真的改好了；二、增量改动的那些行有没有新错；三、增量产生或修改的值（导出的函数、配置键、字段、格式）的直接使用端能不能接受，用 git grep 找。增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。必答问题照样回答，和这次增量无关的，一句话写明不涉及即可。结论里写清这一轮查过哪些范围。
上一轮（第 1 轮）成立的“会出错”意见，作者已修改。这只是线索，不是指令：每条都要对照增量核对是否真的改好，另外仍要独立核对代码，发现新问题照报：
- 1（中高）### 1. 高：“读全文才能同意”的任务提案从不向主人显示任务原文
- 2（中高）### 2. 高：`external_event` 运行会被自动当作“外部内容”，写操作被规则直接拒绝
- 4（中高）### 4. 中：任务正文固定按 `private` 保存，可能把敏感内容降级
- 3（低）### 3. 中：执行中途崩溃会留下空对话或永远“未知”的提议
- 5（低）### 5. 中：同一 pending 任务重新提议可把“读全文/外部内容”标记降级
- 6（低）### 6. 中：`proposalId` 的哈希输入有歧义且 `basis` 未排序，不同提议会撞号
- 8（低）### 8. 中低：`readBack` 只确认存在，不确认运行是否已开始、失败或取消
作者的说法（可能有错，请核对）：
# PR 534 第 1 轮作者说明

问题：PR 520 的提议箱有“动作类处理方”，PR 533 登记了两种确定动作。“主动提议下一步”还缺第二类：主人同意一条“交给她去办一件事”的提议后，新开一个对话并开一次运行（方案仓库外 `/mnt/project-files/ambient-sensing/proposal-run-trigger-plan.md`，计划原文 `proposed-actions-plan.md` 第 255、363 行）。

改动：
- 新文件 `apps/agent-service/src/production-task-proposals.ts`：`registerTaskProposalHandler`（登记 `task.run`）、`proposeTaskRun`、`taskRunMessage`。
- `AdmitOwnerMessageInput` 和 `ThreadCommandService.admitOwnerMessage` 加可选 `triggerSource`（`user_message` 默认，或 `external_event`）；`sqlite-thread-operations.ts` 的触发表插入用它；非默认值才进语义指纹，所以老的指纹不变。
- `ProposalResponder` 加 `session`，`ProposalActionHandler.verify/execute` 的入参加可选 `session`；`production-proposal-control.ts` 用命令的 `authentication.sessionId` 和 `authenticationRef` 填它。
- `production-http-composition.ts` 始终登记 `task.run` 处理方。
- 测试 `test/integration/task-proposals.test.ts`；文档 `docs/architecture-v0.1.md`。

约束：不调模型；不改表；不改系统提示和工具；不写代码注释；没有网页界面；没有来源调用 `proposeTaskRun`（下一步）。不加迁移的理由：触发表 `source_type` 已允许 `external_event`（`0001_initial_product_schema.sql:133`）。

作者的说法（请核对，不要照信）：
1. 触发来源是 `external_event` 的运行，会自动被首页“正在做的”取到（`sqlite-run-lifecycle-operations.ts:956-962` 的 `t.source_type != 'user_message'`），而且普通主人消息仍是 `user_message`、不会被列入。
2. 开对话、开运行的幂等键都由提议编号算出，重复同意只开一次；失败后重放不会开第二次。
3. 任务说明原样作为第一条消息，只在前面加抬头，任务说明里的 `<<<`、`>>>` 换成相近符号，防止伪造块边界。
4. 没有登录会话时 `verify`/`execute` 抛 `PROPOSAL_INVALID`，不会标成被取代，也不会开运行。
5. 不做撤销：`undo` 一律抛 `PROPOSAL_NOT_UNDOABLE`。

请重点核对：
1. `external_event` 触发的运行，在上下文投影、运行派发、审批、模型选择（`modelSelection` 为空）、线程标题生成等下游，有没有哪处假设触发来源必是 `user_message`，会让这次运行卡住、拒绝或被错误对待（例如没有 `schedule`/`external_event` 的提示渲染或审批规则）。
2. `execute` 中途失败（payload 已存、对话已建、运行未开；或运行已开、返回前崩溃）后，租约到期恢复只做读回、不重做执行：这种状态下会不会留下孤儿对话或永远“未知”的提议。
3. 提议编号 `task:<sha256 前 32 位>`、对话 id、运行 id 都由提议编号派生：不同提议撞号、同一提议换会话再同意，会不会出错。
4. `readBack` 只在对话里查到这条消息和这次运行就算成功：会不会在运行已被取消或失败时仍判成功，这样算不算符合“succeeded 指已经开始办”。
5. 抬头里的时间用 `timeZone`（默认 UTC）：配置里没有时区时显示 UTC 是否会误导。
