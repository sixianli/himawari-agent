## 结论摘要

方案 A（长事务范围）在当前“主线程 + 单写 worker + 每个端口调用一条消息”的架构下不是“改动量小的稳妥方案”，它把 better-sqlite3/SQLite 最不推荐的用法（事务跨事件循环、手工 BEGIN/COMMIT 与 `.transaction()` 混用）引入核心写路径，而且没有解决“提交结果不确定时如何不重放”的核心问题。下面按严重度列出。

---

## 证实的

### 高：提交结果不确定时，重放会重复历史/版本；方案的“reaffirmed 历史不会重复”不成立

- 问题：方案只处理了“COMMIT 之前失败 → 干净回滚”。但 COMMIT 已经发出、主线程没收到回包（worker 线程退出、超时与 COMMIT 竞争、ROLLBACK 报“no transaction”）时，主线程会认为失败并按方案“留队重试”。此时库里已经有本轮结果；而 `update`/`merge`/`unchanged` 的写入不是幂等的，重放会再追加一次历史、再升一个 revision。
- 证据：
  - `durable-memory-service.ts:107-120`：`unchanged` 无条件 `state.appendHistory(...)`。
  - `durable-memory-service.ts:167-206`：`update`/`merge` 每次 `nextRecord`（revision+1）并写 `historyNote("updated", ...)`。
  - `sqlite-memory-operations.ts:905-919`：`memory_history_events` 是普通 `INSERT`，没有 generation id、没有唯一键。
  - `sqlite-execution-context.ts:125-147`：每个端口调用是一条消息，COMMIT 和 ROLLBACK 也是消息；主线程无法仅凭 Promise 拒绝判断事务是否已提交。
  - 方案自己的测试写“同一轮提交两次，行数不变；`unchanged` 不重复追加历史”，与它的前提 4“reaffirmed 历史没有幂等键”直接矛盾。
- 建议：不要无条件在失败后重新入队。必须有一个持久化的“本轮已提交”判定（DeepSeek 提的标记表/列，或复用现有 generation 行加一个明确的提交状态），重放前先查；或者把 `memory_history_events` 加上 `(memory_id, generation_id, kind)` 之类的确定性键并让 `update`/`unchanged` 可幂等。没有这一步，“单事务 + 留队重试”无法保证不重复，反而会把 ADR 0222 接受的一次写入窗口扩大成一次重新入队。

### 高：`#settle` 会吞掉 `backlog.remove` 的失败；把它包进事务会导致“记忆已提交、队列行还在”

- 问题：`#settle` 捕获 `backlog.remove` 的异常并只记 `#settled`，不向外抛（`production-memory-capture.ts:882-894`）。如果按方案把 `#commit` 和 `#settle` 一起包进 `run(fn)`，remove 失败会被吞掉，事务包装器看到 `fn` 正常返回就会 COMMIT，于是记忆被提交而队列行仍在；下一次补做再写一遍。这正是现有测试 `[P3-5] does not replay a turn again after its memories were saved but its row could not be removed` 描述的场景（`test/integration/production-memory-capture.test.ts:3371-3421`）。
- 证据：`production-memory-capture.ts:882-894`；同一文件 `#save` 只把 `#commit` 放在 try 里（`867-880`），`#settle` 自己在内部兜底。
- 建议：把 remove 失败改成让整个事务失败（先 rollback 再决定重试/放弃）；删掉或重定义 `#settled` 的内存语义；同步更新 ADR 0222 和上述测试。

### 高：写记忆失败改为“留队重试”后，没有 attempts 计数路径，会变成无界模型调用

- 问题：现在 `recordAttempt` 只在 `#replayOne` 的 `#prepare` 失败分支调用（`production-memory-capture.ts:926-932`）。`#save`/commit 失败根本不会走到这里；初始捕获路径也没有现成的 backlog 行。方案说“按现有最大次数重试，超次数才放弃”，但没有说明：初始提交失败时由谁 `enqueue`、每次提交失败由谁 `recordAttempt`、达到 3 次后由谁删除。结果是持久性写失败（磁盘满、`PORT_CONFLICT`、schema 冲突）时，之后每一轮都会重新调用模型，backlog 行永远不清，费用和延迟无界。
- 证据：`production-memory-capture.ts:867-880`、`896-945`；`memory-capture-backlog.ts:3`（`MAX_ATTEMPTS = 3`）；`sqlite-memory-capture-backlog-operations.ts:111-129`（`recordAttempt` 只加一，不自动放弃）。
- 建议：明确状态机：clean rollback → 记录 attempt；达到上限 → 写 `capture_gave_up` 并删除；`enqueue` 本身失败（很可能与底层写失败同因）要有兜底，不能假设队列一定能写。更好的做法是 clean rollback 后先用**同一份 parsed** 同轮重试（不再调模型），只有仍然失败才入队。

### 中：手工 BEGIN/COMMIT 与 `.transaction()` 混用，且 SQLite 可能在 `SQLITE_FULL`/`SQLITE_BUSY` 时自动回滚

- 问题：方案用 worker 的原始 `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` 跨多条消息持有事务，同时现有 `saveWithProjection`、`appendHistory` 等内部用 `database.transaction(...).immediate()`。better-sqlite3 官方明确说不要把手工事务和 `.transaction()` 混用，并且 SQLite 在 `SQLITE_FULL`/`SQLITE_BUSY` 等情况下可能自行回滚；此时后续语句可能已经在事务外自动提交，最后的 ROLLBACK 会报“no transaction”。
- 证据（一手来源）：
  - better-sqlite3 API 文档：“If you'd like to manage transactions manually... However, manually managed transactions should not be mixed with transactions managed by this `.transaction()` method. In other words, using raw `COMMIT` or `ROLLBACK` statements inside a transaction function is not supported.”
  - 同页：“SQLite may sometimes rollback a transaction without us asking it to... certain errors such as `SQLITE_FULL` or `SQLITE_BUSY`... if you catch an SQLite error within a transaction, you must be aware that any further SQL that you execute might not be within the same transaction.”
  - 同页：“Transaction functions do not work with async functions... it's generally a very bad idea to keep a transaction open across event loop ticks anyways.”
  - https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#transactionfunction---function
  - 嵌套事务用 savepoint 的实现依据：https://github.com/WiseLibs/better-sqlite3/blob/master/lib/methods/transaction.js（`db.inTransaction` 为真时用 SAVEPOINT/RELEASE）。
- 建议：如果坚持 A，必须在 worker 每个操作后检查 `database.inTransaction`；一旦发现事务已被 SQLite 丢掉，立即把 scope 标记为不可继续、拒绝后续写，并把“ROLLBACK 报 no transaction”当成“已回滚”而不是“结果未知”。更好的做法是改用单个同步 worker 操作（B），避免跨事件循环持锁和混用手工事务。

### 中：事务/读路由的落点不对：读走的是另外的只读 worker，`SqliteExecutionContext` 看不到

- 问题：方案的步骤 1 写在 `SqliteExecutionContext` 上加 `transaction(fn)` 并用 AsyncLocalStorage 标记“范围内的 read 走写连接”。但读请求是在 `SqliteProductStateRepository.readRequest` 里分发到最多 3 个独立的只读 `SqliteExecutionContext`（`product-state-repository.ts:168-170,196-199,696-718`），每个都是独立 worker/连接。写 context 的 ALS 不会被读 context 看到，因此“范围内的 read 改走写连接”必须在 repository 的 `readRequest`/`writeRequest` 层实现，而不是 execution context 层。
- 影响：如果只加在 execution context，`content.store` 的 `payloads.get` 仍走只读连接，看不到本事务刚 put 的 payload，可能再次 put → `PORT_DUPLICATE`（`sqlite-durable-operations.ts:1709-1715`）；`applyProposal` 的 `state.read` 也看不到自己刚写的版本，“版本空隙自然消失”不成立。
- 证据：`product-state-repository.ts:696-729`；`durable-adapters.ts:904,909`；`production-memory-capture.ts:586-602`。
- 建议：把 unit-of-work 的互斥、读路由、提交/回滚放在 repository 层，用显式传入的 scope/token，而不是只靠 execution context 的 ALS。

### 中：`generations.request` 不在 `#commit` 里，方案的“整轮一个事务”与实际代码不符

- 问题：方案说“`#commit` 把 `generations.request` + `processCommittedRun` + 出队包进同一个范围”，但 `generations.request` 实际在 `#prepare`（`production-memory-capture.ts:1155-1184`），发生在 `#extract` 之后、`#save/#commit` 之前。按字面只包 `#commit` 的话，提交失败回滚后仍会留下 `thread_checkpoint_jobs` / `memory_generations` 行，不是“库里没有本轮任何东西”；如果要包进去，必须重构 `#prepare`/`#save` 的边界，并重新处理 `[P3-5] retries a turn whose checkpoint could not be registered`（`test/integration/production-memory-capture.test.ts:3252-3280`）的语义。
- 证据：同上行号；`#commit` 在 `1188-1205`。
- 建议：明确把 generation 注册移到事务范围内（例如 `#commit` 先建 generation 再写记忆），或者把方案表述改成“记忆写入 + 出队一个事务”，不要声称覆盖 generation 注册。

### 中：测试方案里有不可执行/不会按预期失败的用例

- `crashAt` 不存在于记忆写入路径：`maybeCrash` 只在 `commitStateAndEvents` 里被调用（`sqlite-worker.ts:726-730,810-871`），记忆写入走 `sqlite-memory-operations.ts` / `sqlite-durable-operations.ts`，不会触发。方案说“用现有 crashAt 钩子在第一个候选写完后让进程退出”不成立，需要新增事务/记忆路径专用的故障注入点。
- “第 2 个因分级不一致被现有校验拒绝”大概率不会抛：解析阶段会把候选分类钳制到不低于来源分类（`production-memory-capture.ts:343-355`），`restricted` 是被 `automatic-memory-service.ts:165-170` 排除（audit + discard），不是抛错；`sqlite-memory-operations.ts:743-756` 的“Memory 与 Payload 分类不一致”比较的两边也来自同一个候选。用这个场景做回滚反向用例，可能根本走不到 rollback。
- 既有测试会直接红：`test/integration/production-memory-capture.test.ts:3295-3309` 断言“写记忆失败不重问模型、不入队、记 `capture_gave_up`”；`3312-3368`、`3371-3421` 也围绕旧语义。方案没有说更新这些测试和 `npm run check:memory-capture-retry`（`package.json:54`）。
- 建议：用确定性的故障注入（例如在第二个候选的 `product.applyProposal` 上抛错，或构造真实的 revision conflict），并新增“COMMIT 已成功但回包丢失”“timeout 与 COMMIT 竞争”“`#settle` remove 失败”三个反向用例；旧 `[P3-5]` 测试按新状态机改写。

### 中：ADR 0222、门槛和说明文档会与代码不一致

- 问题：ADR 0222 决定 4 明确写“写记忆失败时不重试、不排队，直接写 `capture_gave_up`”，决定 6 写 `capture_gave_up` 包含“存记忆失败”；后果里写 `check:memory-capture-retry` 跑 19 条 `[P3-5]` 测试。方案要改成“留队重试”，却写“不改表（暂不需要迁移号和 ADR 号）”。这是改变已接受的决定，不是纯实现细节。
- 证据：`docs/adr/0222-retry-and-queue-failed-memory-capture.md:56,58,94-95`；`docs/engineering-casebook.md:280`；`package.json:54`。
- 建议：出 023x ADR 明确取代/修订 ADR 0222 的决定 4/6，更新门槛脚本的用例数和文档；否则合并后规则文件、ADR 和代码互相矛盾。

### 中：单写 worker 被长事务占住，违反本项目 I-29/I-36 的教训；监控也看不到总持锁时间

- 问题：项目已经记录过“数据库只有一个工作线程，所有写请求在同一队列里互相等”（`docs/incidents-and-gates.md:67,74`，I-29/I-36）。方案要在该 worker 上跨多条消息持有写事务，期间所有其他写（对话状态、审批、活跃时间等）都要排队；5 秒超时意味着最多卡 5 秒。现有 `sqlite.slow_operation` 是按单操作计时，`lastTransactionDurationMs` 只在 `commitStateAndEvents` 里更新（`sqlite-worker.ts:131,870`），新的长事务不会体现在总持锁时间上。
- 建议：至少在 worker 里记录 scope 的总持锁时间并接入 `sqlite.slow_operation`/状态；把超时上限压到远低于 5 秒（例如 1 秒级），并把“事务卡住”作为 fail-closed 条件；这也进一步支持改用 B 的单次同步操作。

### 中：超时后“放开写通道”会让迟到写落到事务外自动提交

- 问题：方案写“到期 ROLLBACK 并放开写通道”。如果 `fn` 没有真正停止（只是外层不再等），它之后发出的写请求可能在新事务之外执行并自动提交；如果 worker 正卡在一个长同步操作里，ROLLBACK 本身也排在后面，先放开的写请求会排在 ROLLBACK 之前，落进仍然打开的事务。两种都会造成残留或误提交。
- 建议：超时后先禁止 scope 内任何新写，等待 worker 确认 ROLLBACK 完成后再释放互斥；如果 worker 不响应，保持写通道关闭并上报，而不是“放开”。

### 低：AsyncLocalStorage 作用域会把 `fn` 内派生出的无关异步写也当成“事务内”

- 问题：ALS 会随 Promise、timer、回调传播。`fn` 内如果触发任何异步工作（审计、诊断、事件、后续回调），它们也会绕过互斥直接进入事务。对 `resolveSensitive` 这类从命令入口调用的路径尤其要小心。
- 建议：用显式 scope 句柄/token 传给需要参与事务的端口，不要用“当前异步上下文”作为唯一判据；至少只允许白名单内的端口调用。

### 低：提交成功后的审计发送不能反过来把成功变成失败

- 问题：`onAudit` 在生产只写诊断日志（`service-main.ts:2377-2385`），但日志写入本身可能抛错。如果提交成功后发送缓冲审计抛错，外层可能把它当成提交失败并重新入队，又回到重复问题。
- 建议：提交成功后的审计发送必须 best-effort、不能影响提交结果；回滚时丢弃并另记一条“事务失败”日志。

### 低：对标依据不准确

- 方案把 Prisma 交互式事务列为“超时/工作单元”依据。当前 Prisma 文档写的是“There is no transaction timeout either, so a transaction stays open for as long as your callback runs.”（https://www.prisma.io/docs/orm/prisma-client/queries/transactions）。Prisma 文档还明确提醒回调里的外部副作用不会随事务回滚，这与方案“审计挪到提交后”一致，但不能用来支持“5 秒超时”。Stripe 的幂等键是 API 请求级，不等于数据库事务级幂等，不能直接证明本方案。
- 建议：如果要用业界依据，引用 SQLite 自身的 WAL/事务语义（https://www.sqlite.org/wal.html：“there can only be one writer at a time”）和 better-sqlite3 的事务约束；9 秒/5 秒超时应作为本项目自己的取舍写清楚，而不是“业界通用”。

### 低：前提 4 的“随机密文所以不能重写”论据不成立

- `content.store` 先用确定性 ref 做 `get`，存在就返回，不重新 `put`（`production-memory-capture.ts:586-602`）。所以密文随机本身不会导致“写两遍结果不同”；真正不能重写的是 `update`/`merge`/`unchanged` 的历史和 revision。结论仍然成立，但理由要改，否则会误导后续实现。

---

## 推测 / 未核实

- **未核实**：生产环境 `onAudit` 的 `writeServiceDiagnostic` 是否可能抛错。若不会抛，则“审计把成功变失败”只是防御性建议；若会抛，则是中等问题。
- **推测**：`resolveSensitive` 在生产接线里 `candidates` 端口总是存在（`createProductionAutomaticMemory` 第 604 行无条件设置），所以不会在事务内走模型回退；但如果以后有别的调用方直接 `new AutomaticMemoryService(...)` 且不传 `candidates`，`resolveSensitive` 的 fallback 会在事务内调用模型（`automatic-memory-service.ts:332-349`），把写锁持有到模型返回。建议在事务边界加断言，禁止该 fallback 在 scope 内执行。
- **未核实**：worker 线程在 COMMIT 后、回包前退出的实际概率。机制上存在（`sqlite-execution-context.ts:89-101` 的 `failAll` 会拒绝在途请求），但生产频率未知；超时与 COMMIT 竞争更现实。
- **未核实**：方案实际实现时是否会把读路由放在 repository 层。如果会，则第 5 条可降为“方案文字不准确”而非实现缺陷；但按当前文字，它是设计缺口。

---

## 侧重检查

我按错误路径、不可信输入、安全、资源耗尽、不可撤销操作、规则/文档一致性逐项查了：

- **错误路径**：clean rollback 之外的三种路径（COMMIT 回包丢失、ROLLBACK 报 no transaction、`#settle` 吞 remove 失败）都没有被方案覆盖；其中前两种会导致重放，第三种会导致“提交但未出队”。结论：高。
- **不可信输入**：本次改动不新增模型/主人输入入口。候选分类在 `parseMemoryCandidates` 被钳制（`production-memory-capture.ts:343-355`），`restricted` 被排除（`automatic-memory-service.ts:165-170`）；`resolveSensitive` 的编辑文本由调用方 `assertStorable` 校验（`production-memory-control.ts:1038-1042`）。结论：无新增输入校验缺口；但方案里“分级不一致会抛错”的测试假设不成立。
- **安全/密文**：`content.store` 的 get→put 依赖“读能看到自己刚写的”，而当前读走只读 worker；如果不在 repository 层改路由，会出现 `PORT_DUPLICATE` 或内容不一致。`payloads.put` 对重复 ref 直接 `PORT_DUPLICATE`（`sqlite-durable-operations.ts:1709-1715`），不是幂等 upsert。结论：中。
- **资源耗尽**：长事务占用唯一写线程；存记忆失败重试无计数会无界调用模型；超时后释放写通道可能让迟到写自动提交。结论：高/中。
- **不可撤销操作**：`onCommitted` 的提醒和人物写入都是同一个 SQLite 写连接上的 DB 写（`durable-adapters.ts:956,1012`），事务回滚可撤销；没有发现网络/推送副作用。模型调用费用不可撤销，方案已承认，但重试次数要有限。结论：无新增不可撤销副作用，但重试成本要封顶。
- **规则/文档一致性**：ADR 0222 决定 4/6、`check:memory-capture-retry`、`engineering-casebook` 与方案冲突；`prompt-prefix` 规则本身不受影响。结论：需要新 ADR/修订，不能写“不需要 ADR”。

---

## 如果由我来定，我会怎样改这份方案

我倾向于采纳 B 的**核心**，但不是“在 worker 里再实现一遍 applyProposal”，而是把现有业务判断和持久化拆成“计划”和“应用”两段：

1. **计划（主线程，读走只读连接）**：用现有 `AutomaticMemoryService`/`DurableMemoryService` 的逻辑生成一份 `MemoryCommitPlan`，包含：generation 注册、每个候选的 payload 明文/密文、memory 记录与 expectedRevision、历史事件、ledger、approval、reminder、people、backlog 删除。所有幂等键都显式写进计划（`generationId + ordinal + kind`）。
2. **应用（worker 单条同步消息）**：worker 在一个 `BEGIN IMMEDIATE` 里重读当前状态、校验 expectedRevision，然后按计划写入；全部成功才 COMMIT。这样不跨事件循环持事务、不混用手工事务与 `.transaction()`，也不会占着写通道等主线程多次往返。
3. **提交标记**：新增一个“本轮已提交”的持久记录（可以是一张很小的表，或在 backlog 上加 `committed_at`）。重放/补做前先查它；已提交就只做清理，不再写记忆。这是解决“提交结果不确定”的必要条件，DeepSeek 的这条意见不应被直接否掉。
4. **幂等历史**：给 `memory_history_events` 加确定性键（至少 `memory_id + generation_id + kind`，或单独的 `commit_key` 唯一索引），让 `update`/`merge`/`unchanged` 在重放时不会多出版本或历史。这样即使标记查询之后仍发生竞态，也不会产生用户可见的重复。
5. **失败重试**：clean rollback 后优先用**同一份 plan** 同轮重试（不再调模型），有界（例如 2 次）；仍失败才入队，并明确 `recordAttempt`、达到上限写 `capture_gave_up` 后删行。`#settle` 的 remove 失败必须让事务失败，不能吞。
6. **审计**：提交成功后再发，best-effort；回滚时丢弃并记一条失败日志。
7. **观测**：记录整个 plan 的持锁时间，接入 `sqlite.slow_operation`/状态；超时上限压到远低于 5 秒，超时后保持写通道关闭直到 worker 确认 ROLLBACK。
8. **文档/门槛**：出 ADR 取代/修订 ADR 0222 的决定 4/6；更新 `check:memory-capture-retry` 的用例和说明；补“COMMIT 成功但回包丢失”“remove 失败”“第二个候选确定性失败”“重复提交 `unchanged`”“超时含 in-flight COMMIT”五条反向用例。

如果 Andy 坚持不改表、不拆 applyProposal，那么我建议**至少不要现在合并这个方案**：它无法兑现“reaffirmed 历史不会重复”和“回滚后库里没有本轮任何东西”这两个关键承诺。只在 `#commit` 外做“尽量短的事务”的较小改法，仍然解决不了提交结果不确定和部分写入的问题。

---

## 逐条回答必答问题

1. **会不会改变模型已经见过的请求开头？**
   按方案描述，改动全在模型调用之后，系统提示、工具定义、历史消息、遮盖结果都不变；发给模型的内容仍然只在末尾追加，每轮会变的值仍在最后一条消息里。这一条通过。
   但有两个附带影响要说清：
   - 把提交失败改成重试后，记忆捕获这个**辅助调用**会在后续轮次重新组装提示词（`#plan`/`#prepare` 从当前记忆状态重建），所以同一段主人消息可能在不同时间以不同的“已有记忆”上下文发给模型；这不是主对话前缀变化，但方案不能声称“同一个源文本的模型输入永远不变”。ADR 0222 已承认补做提示词不是原轮逐字复刻。
   - 如果把 `generations.request` 移进事务，它仍然在模型调用之后，不影响前缀。
   依据：`.claude/rules/prompt-prefix.md` 第 1、2、4 条；`production-memory-capture.ts:807-828`（先 plan/extract，后 save/commit）、`1188-1205`。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会新增模型可见文本的不确定性：本次改动没有新增时间字段、无序集合或依赖前后文的遮盖。密文和 `createdAt` 是随机的/随时间变的，但它们不进入模型输入；而且 `content.store` 对同一确定性 ref 会先 `get` 再决定是否 `put`（`production-memory-capture.ts:586-602`），所以“随机密文”本身不是重写不一致的理由。
   真正的问题是重放：`update`/`merge`/`unchanged` 会重复追加历史/升版本（见高严重度第 1 条），这不是“同一段文字变成不同字节”，而是“同一轮被写成多条事实”。如果方案的重试逻辑触发重放，用户会看到重复的历史节点/版本，这一点必须在设计里解决。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   部分有，但按当前写法不够：
   - `crashAt` 不在记忆写入路径，方案里的“现有 crashAt 钩子”用不了（`sqlite-worker.ts:726-730,810-871`）。
   - “第 2 个候选因分级不一致被拒绝”大概率不会抛错（分类在解析时被钳制/排除），反向用例可能不会失败。
   - 现有的 `[P3-5]` 测试和 `check:memory-capture-retry` 明确断言旧的“写记忆失败不重试、不入队、`capture_gave_up`”行为（`production-memory-capture.test.ts:3295-3309` 等），方案没有说要改，合并后这些检查会红。
   - 缺少“COMMIT 成功但回包丢失”“ROLLBACK 失败/no transaction”“`#settle` remove 失败”“`unchanged` 重复提交”这几条真正能证伪的用例。
   建议按上面“如果由我来定”的测试清单补齐，并验证：把事务去掉、把提交标记去掉、把 remove 失败改成吞掉，每种都必须有用例失败。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   逐个核对如下：
   - `capture_gave_up` → `capture_queued`：校准把 `capture_retrying/queued/gave_up` 作为同一组处理（`packages/calibration/src/index.ts:277-282`），UI 的 `decision.chain.kind` 按 kind 而不是 outcome 选择，所以运行期接受；但测试（`production-memory-capture.test.ts:3164-3168,3307,3368`、`daily-review.unit.test.ts:525-527`）、ADR 0222 和 casebook 仍按旧值，必须改。
   - `backlog.lastErrorCode`：`sqlite-memory-capture-backlog-operations.ts:6,58-64` 要求 `^[A-Z][A-Z0-9_]{0,127}$`；`captureErrorCode` 已保证（`production-memory-capture.ts:697-705`），接受。
   - `backlog.createdAt/updatedAt`：`validTime` 要求精确 ISO（`sqlite-memory-capture-backlog-operations.ts:8-11`）；现有 `#retryTurn` 已经用 `clock.now()` 入队并通过校验，说明生产时钟可用，但不是本次新引入的。
   - `attempts`：目前只有 `recordAttempt` 会加一（`111-129`），`enqueue` 的 `ON CONFLICT` 不重置 attempts（`69-77`），语义可用；但 save 失败路径没有调用它，必须补。
   - `#settled`：它是内存 Set，方案把 remove 放进事务后语义改变（见高严重度第 2 条），不能原样保留。
   - 新 `UnitOfWorkPort`/transaction 操作名：这是新类型/新 worker 分支，生产实现和测试替身都要提供；TypeScript 会抓接口，但内存/测试实现需要逐个补，不能只改一端。
   - 若采纳“提交标记”或“幂等历史键”，需要迁移和 schema 版本号（当前方案“不改表”就不成立）；这些值的使用端是 `memory_history_events`、backlog 和可能的 `memory_generations`，要按 I-73 的做法逐端核对校验和迁移。
