你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 b66ed74887540ffb90d744df70065d22e335e063。
问题、目标和约束：
# 问题：每一轮对话结束后的记忆抽取，写库要做成一个数据库事务

## 目标（Andy 已定）
一轮对话的记忆抽取，把整轮所有写库（新增、取代、更新、出处、决策记录、提醒、人物、待批准请求、内容载荷等）放进一个数据库事务：要么全成功，要么全回滚；失败后整轮可安全重试，重试不产生重复。

## 已核对的事实（文件:行）
- 抽取在模型调用完成后，由 `apps/agent-service/src/production-memory-capture.ts` 的 `#commit`（约 1180-1205 行）调 `AutomaticMemoryService.processCommittedRun`（`packages/application/src/services/automatic-memory-service.ts:138`）。该方法按候选逐个写库：每个候选分别调 `content.store`（写载荷）、`product.applyProposal`（`durable-memory-service.ts:101`）、`ledger.append`、`approvals.create`、`candidates.store`、`onCommitted`（提醒 `reminders.schedule`、人物 `book.recordPeople`）、审计回调。每次调用各是一个独立的写库请求，当前没有跨调用的事务，所以中途失败会留下半轮结果。
- `applyProposal` 对 create 先 `state.read` 再 `saveWithProjection`，随后另一次调用 `supersede`（读旧记忆、再 `saveWithProjection`）；各是独立事务。`saveWithProjection`（`sqlite-memory-operations.ts` 的 `memory.saveWithProjection`）已经把「记忆行 + 历史 + 投影任务 + 决策记录 + 整理记录」放在一个事务里，里面用 `expectedRevision` 做乐观并发检查。
- 数据库访问：better-sqlite3 在一个 worker 线程里同步执行；主线程经消息调用，每个调用一个请求（`packages/persistence-sqlite/src/sqlite-execution-context.ts`，`request`）。有一个写连接和单独的只读连接：`memory.read` 走只读连接（`durable-adapters.ts:904`），`memory.saveWithProjection` 走写连接（`durable-adapters.ts:909`）。写连接上的操作串行排队。better-sqlite3 的事务函数可以嵌套（内层变保存点）。
- ID 都是确定的：记忆 id `memory:<generationId>:<序号>`（`production-memory-capture.ts` 里 `memoryIdFor`），载荷 ref `memory-content:<generationId>:<序号>`，决策记录 id 由 generationId、序号、结果、原因的哈希而来，提醒 id `reminder:<memoryId>`。`create` 遇到同 id 同内容时视为同一提案、直接返回（`durable-memory-service.ts` 约 123-146 行），所以重试大体幂等，但半轮残留仍会留在库里。
- 失败重试已有一套：`MemoryCaptureBacklogPort`（待补队列，按 generationId 一个条目）。模型调用失败可同轮重试一次再入队；但 `#save`（`production-memory-capture.ts` 约 868-880 行）里写库失败只记 `capture_gave_up` 并从队列移除，不再重试。`PORT_CONFLICT`（版本检查冲突）在可同轮重试的错误码清单里。
- 另一个线程（做梦记忆，草稿 PR 395）也改了 `durable-memory-service.ts`（重试时补做取代）、`sqlite-memory-operations.ts`、`automatic-memory-service.ts`、`production-memory-capture.ts`，并指出过「检查版本和写库之间的空隙」。
- 审计回调 `onAudit` 目前是同步的内存回调，不写库（待核实：`apps/agent-service/src/production-http-composition.ts:1092`）。

## 约束
- 产品愿景（docs/product-vision.md）：用户主权、边界与可逆性、记忆可靠性优先；数据由 Andy 自持，只有一台生产机，不能假设另加机器。
- 发给模型的内容只追加（`npm run check:prompt-prefix`）；本改动不应改变模型已见过的请求开头。
- 不顾旧数据兼容，做彻底；测试不许用假替身。
- 同一时间只有一个改表的任务，改表要排队。
- 不要写死能动态获取的值。

## 请你做的事
从问题本身出发，给出你认为最好的实现方案：事务边界放在哪一层、怎样处理读写两个连接、怎样处理跨调用的异步、事务里允许做什么不允许做什么、失败后的重试怎么保证不重复、怎样测试（含回滚的反向用例）。参考业界做法（例如 Prisma 交互式事务、Postgres/SQLite 的 unit-of-work、outbox 模式、better-sqlite3 在 worker 里的做法），附一手来源。
