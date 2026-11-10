你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 6557219861106b52321416b4d62a19c8b92601a9。
待审核的方案：
# 线程的方案：Pi 偏离 D5（插消息部分）和 D7（缓存预热）改成官方写法

问题、约束和已核对的事实同 `.agents/reviews/topic-pi-d5-d7/briefs/plan-1.md`；两个模型各自的方案在 `.agents/reviews/topic-pi-d5-d7/round-1/`。下面是线程整合后的方案，以及 Andy 和协调者已经定下的部分。请找漏掉的场景、判断错的地方、和 Pi 官方写法或业界做法不一致的地方。

## 已定的部分

- 审批续跑处的 `if (restored) await session.agent.continue();` 保留：官方会话接口没有“不加新消息、接着跑”的写法，改成 `sendCustomMessage(..., { triggerTurn: true })` 要往对话里多塞一条合成消息，模型会看到它。理由写进 ADR 0206 和偏离表。
- 工具内部的 `agent.abort()` 保留：工具在运行中，`session.abort()` 会等会话空闲，等不到（ADR 0204）。
- D7 只做最小一步：生产没有 5 分钟缓存的模型（ADR 0117、0111：主力 DeepSeek，缓存存几小时到几天），整套预热（预算闸、遮盖重放、用量迁移 0086）等加了这类模型再做。

## D5：`packages/runtime-pi/src/pi-runtime-adapter.ts` 每一处

1. 工具循环停止提示 `appendLoopStopped` 不在运行中那一支：`active.agent.steer({role:"custom", ...})` 改成 `active.sendCustomMessage(toolLoopStoppedMessage(), { deliverAs: "steer" })`。1.5.0 `dist/core/agent-session.js` 第 1862–1900 行：不在运行中且没有 `triggerTurn` 时直接加进历史、不开新一轮。不用 `nextTurn`（会排到用户下一条消息后面），不用 `triggerTurn`（多花一次钱，循环卡住时不该接着跑）。运行中那一支已经是 `sendCustomMessage(steer)`，失败时 `.catch(() => active.agent.abort())` 保持（它在工具结果回调里，属于运行中）。
2. 后台命令完成通知：已是 `sendCustomMessage(steer)`；失败时 `session.agent.abort()` 改 `session.abort()`。
3. 压缩结束且 `willRetry` 时补发运行环境说明：`session.agent.steer({ role: "custom", ...environment, timestamp })` 改成 `session.sendCustomMessage(environment, { deliverAs: "steer" })`。用真实 Pi 测试锁住“补发后紧接的那次请求的最后一条消息是这条说明”。
4. 一轮结束后的 `#continueForSteeredNotices`（`while (canContinue() && session.agent.hasQueuedMessages()) { await session.agent.continue(); await session.waitForIdle(); }`）：如果真实 Pi 测试证明 Pi 在 `_startRun` 里会把排队消息跑完（`_handlePostAgentRun` 返回 `agent.hasQueuedMessages()` 就 `agent.continue()`），整个删掉；测试不过就保留并写进偏离表。注意它有 `canContinue` 条件（挂起、未知工具、失败、中止、工具循环卡住、取消时不续跑），删掉后这些情况下 Pi 是否仍会续跑要逐一核对。
5. 存历史失败时 `void pending.catch(() => session.agent.abort())` 改 `session.abort()`。

## D7：最小一步

1. `SettingsManager.inMemory` 里显式写 `cacheWarming: "streaming"`：1.5.0 默认就是它，行为不变；升 1.5.1 时不被新默认 `"idle"` 带走。空闲预热在“每次运行新建会话、跑完 dispose”下跑不起来。
2. 加测试：Himawari 交给 Pi 的模型注册表里没有任何模型带 `promptCache`（配置也写不进去），所以不会出现没过预算的预热请求。新增模型时这条测试会提醒先做整套。

## 文档

- ADR 0206：D5 插消息改官方写法、审批续跑保留、D7 最小一步及以后整套的条件；更新 `docs/pi-development-guide.md` 偏离表 D5、D7 行。

## 会不会改变模型已经见过的请求开头

线程判断不会：每处都只是“往对话末尾追加一条消息”，插入时机按 Pi 的同一个队列；`npm run check:prompt-prefix` 必过。请核对这一判断，尤其第 1 条（不在运行中时直接加进历史）和第 4 条（删补跑循环）是否改变下一次请求里消息的位置或有无。
