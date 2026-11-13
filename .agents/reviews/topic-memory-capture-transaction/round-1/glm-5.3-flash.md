我先读关键文件弄清现状。
代码已经读得差不多了，最后核对两条业界一手来源，然后写方案。
# 方案：把一轮记忆抽取的全部写库收进一个批次事务

## 一、前提（先分「读代码证实的」与「推测」）

### 读代码或来源证实的

- **提交阶段没有任何模型调用和网络**：生产路径里 `AutomaticMemoryService` 的 `extract` 是闭包 `async () => parsed.candidates`（候选已在主线程解析完），`readSourceText` 返回内存里的 `plan.message`（apps/agent-service/src/production-memory-capture.ts:1194-1199）。也就是说，「写库阶段」的输入是完全确定的数据，不需要在事务中途等待任何外部东西。这是本方案能成立的最关键前提。
- **写连接上的操作严格串行**：每个 SQLite lane 是一个独立的 worker 线程，worker 的事件循环逐条同步处理消息（packages/persistence-sqlite/src/sqlite-worker.ts:1006-1122），主线程经 `request()` 逐个投递（packages/persistence-sqlite/src/sqlite-execution-context.ts:125-147）。所以「一个批次操作执行期间不可能插入别家写请求」是结构保证，不靠锁。
- **读走另一个只读 worker**：`memory.read` 走只读连接、`memory.saveWithProjection` 走写连接（packages/persistence-sqlite/src/durable-adapters.ts:904,909）。事务内的读必须改走写连接，否则读到的是事务外状态。
- **`saveWithProjection` 已经是事务**，含记忆行＋历史＋投影任务＋决策记录＋整理记录，并用 `expectedRevision` 乐观并发检查；用 `database.transaction(...).immediate()`（packages/persistence-sqlite/src/sqlite-memory-operations.ts:694-731）。
- **better-sqlite3 官方文档**（https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md，`.transaction()` 一节）：事务函数可嵌套，内层变 savepoint；「Transaction functions do not work with async functions… it's generally a very bad idea to keep a transaction open across event loop ticks」；异常抛出即回滚；手动 BEGIN/COMMIT 不应与 `.transaction()` 混用。这四条分别支持：内层复用既有事务函数、不能做跨消息往返的交互式事务、失败自动回滚、不能用裸 BEGIN。
- **逐候选写库的每个调用各是独立事务**：`content.store` → `payload.put`（packages/persistence-sqlite/src/sqlite-durable-operations.ts:1709-1740，独立写）、`applyProposal`（durable-memory-service.ts:101，create 后另一次 `supersede`，各自 read+save）、`ledger.append`、`approvals.create`、`reminders.schedule`、`book.recordPeople`（durable-adapters.ts:956,1012,1194）。中途失败确实留半轮。
- **一个此前材料没点破的事实**：生产路径的 `content.store` 是先 `payloads.get(ref)` 存在即返回、再 `put`（production-memory-capture.ts:587-601），而 `payload.put` 遇已存在 ref 直接 `PORT_DUPLICATE`（sqlite-durable-operations.ts:1711-1715）。这个 get→put 是两次独立请求，竞隙与 PR 395 指出的「检查版本和写库之间的空隙」同构；且 golden 测试里重放不炸只因为测试夹具在内存 Map 里去重（test/integration/automatic-memory-golden.test.ts:128-129），生产 SQLite 没有这层保护。
- **所有 ID 都是确定性派生的**：`memory:<generationId>:<序号>`（production-memory-capture.ts:609）、载荷 ref `memory-content:<contentKey>`（:588）、ledger id 是 `generationId:ordinal:outcome:reasonCode` 的哈希（packages/application/src/services/automatic-memory-service.ts:574、119-121）、`reminder:<memoryId>`（production-memory-capture.ts:618）、`memory-approval:<generationId>:<ordinal>`（:610）。Stripe 的幂等请求（https://docs.stripe.com/api/idempotent_requests）正是同一思路：用确定性键让重放安全。
- **onAudit 不写库**：`onAudit` 最终只是写一条服务诊断日志（apps/agent-service/src/service-main.ts:2377-2385）——材料里的「待核实」可以销掉。审计留在事务外不损失一致性。
- **循环里的分支不依赖数据库**：restricted/transient/敏感审批/置信度阈值的判断只看候选字段和输入（automatic-memory-service.ts:164-233）；依赖 DB 状态的分支全部位于 `applyProposal` 内部（sameProposal 检查 durable-memory-service.ts:123-146、`current.status` 检查 ：167-177）。所以「计划」可以在主线程无 DB 地构建完，DB 依赖的分支自然落进事务内部。
- **回滚的持久性保证**：SQLite WAL 模式（sqlite-worker.ts:123）下，未提交事务在崩溃后由恢复机制回滚（https://www.sqlite.org/wal.html）。
- **已有真实的崩溃注入设施**：worker 配置里有 `crashAt`/`holdBeforeCommitMs` qualification 钩子（sqlite-execution-context.ts:13-18，sqlite-worker.ts:714-730），可扩展用于事务中途崩溃的反向测试。
- **重放幂等已有真实测试覆盖一次**：`automatic-memory-golden.test.ts:353-360` 对同一输入跑两次 `processCommittedRun`，断言返回同一记忆 id。
- **业界参照**：Prisma 交互式事务文档明确警告「回调里做副作用（发邮件）不会回滚」「回调里误用 `db` 而不是 `tx` 就跑到事务外」（https://www.prisma.io/docs/orm/prisma-client/queries/transactions，"Common mistakes" 两节）；Unit of Work 定义是「维护受业务事务影响的对象集合，协调写入」（https://martinfowler.com/eaaCatalog/unitOfWork.html）；outbox 解决的是「DB 事务与对外发布的原子性」（https://microservices.io/patterns/data/transactional-outbox.html）——本项目投影任务表 `memory_projection_jobs` 本来就是库内 outbox，由 `saveWithProjection` 事务内写入，无需另建。

### 推测（未逐一核实，实现时要核对）

- `SqliteDurableOperations.execute` 对未知操作名的兜底行为（我会给新操作加显式 case，但需确认没有操作名白名单校验会拦住新名字）。
- `parseMemoryCandidates` 的产物是纯 JSON 数据（无函数/类实例），可安全经 postMessage 结构化克隆。
- UI 或其他读方没有依赖「半轮结果可见」的行为。
- `generations.request`（checkpoint 写入，production-memory-capture.ts:1155-1184）的重发是否幂等。

## 二、方案本身

**核心决定：不做交互式事务，做一个「数据化的写计划 + 单个批次 worker 操作」。** 事务边界放在持久化层的写 worker 上，应用层只负责把整轮写库动作序列化成一个确定性的计划对象，一次 `request()` 发过去，worker 在一个 `database.transaction(...).immediate()` 里执行完。

### 1. 计划的构建（应用层，packages/application）

给 `AutomaticMemoryService` 增加一个可选端口 `MemoryCaptureUnitOfWork`（定义在 packages/application/src/ports，实现放在 packages/persistence-sqlite）。`processCommittedRun` 的候选循环改为「两遍」：

- **第一遍（主线程，无 DB）**：按现有分支规则（automatic-memory-service.ts:164-262）把每个候选翻译成计划意图，候选顺序即数组顺序：
  - `putPayload`（主线程先用 protector 加密好密文再放进计划——加密绝不能进事务）；
  - `saveMemory`（create/update 的 `saveWithProjection` 输入，含 `expectedRevision`）；
  - `supersede`（目标 id + 新记录，由 worker 端在事务内读旧记忆后落盘）；
  - `appendLedger`、`createApproval`＋`storeCandidate`、`scheduleReminder`、`recordPeople`；
  - `removeBacklog`（generationId），把 `#settle` 的 backlog 清除并入同一事务，关掉「已提交但 backlog 还挂着 → 无谓重放」的窗口；
  - 每个 intent 的时间戳统一取**一次** `now()` 随计划传入，同事务内各行时间一致。
- **第二遍**：一次 `unitOfWork.commit(plan)`，返回与现在 `AutomaticMemoryResult` 等价的结果（由 worker 端从落盘记录回读拼装）。

「同一候选的载荷先于记忆行存在」这类顺序约束由执行器内部固定顺序保证，不再靠调用顺序。

### 2. 计划的执行（持久化层，packages/persistence-sqlite）

新增写连接操作 `memory.captureCommit`，落在 `SqliteMemoryOperations.execute` 的 switch（sqlite-memory-operations.ts:322）：

```
memory.captureCommit(plan):
  database.transaction(() => {
    对每个 intent：
      putPayload 复用既有 putPayload，但先在事务内 SELECT 该 ref：
        已存在且 content_digest 相同 → 跳过（幂等命中）
        已存在但 digest 不同 → PORT_DUPLICATE（哨兵，fail loud）
      saveMemory 复用既有 saveWithProjection（内层事务自动变 savepoint，
        expectedRevision 校验、assertMemoryShape、载荷存在性与分级一致性
        检查原样生效，sqlite-memory-operations.ts:702-756）
      supersede 在事务内 read 旧记忆 → saveWithProjection（同上）
      其余 intent 复用 insertLedgerRow / createApproval / reminder / book
        的既有私有方法，不复制 SQL
    removeBacklog
  }).immediate()
```

要点：

- **两个连接的处理**：事务内的所有读（sameProposal、supersede 的旧记忆、载荷 get）全部走写连接上的既有私有读方法；只读连接在本阶段完全不参与。写 lane 串行 ⇒ 「读版本」和「写」之间不存在空隙，PR 395 的担忧在本路径上被结构性消除。
- **事务里允许**：且仅允许计划列出的 SQLite 读写。**不允许**：模型调用、网络、加密（已在主线程完成）、日志/审计回调（Prisma 文档把「回调内副作用」列为头号错误；本项目的 onAudit 只是日志，天然在外）、调用 `this.options.now()` 之类会随时刻漂移的东西。
- **计划校验在 worker 端照常全量执行**（这正是 I-73 的教训：不能因为「数据是我们自己主线程生成的」就跳过另一端校验）。
- 崩溃点扩展：给批次执行器加 `crashAt: "after_capture_first_write"` 之类的 qualification 检查点，复用 sqlite-worker.ts:726-730 的机制。

### 3. 失败与重试

- 事务内任何异常 → better-sqlite3 整体回滚；进程崩溃 → WAL 恢复回滚。**半轮残留从「靠重试去补」变成「不可能存在」**。
- `#save` 失败路径（production-memory-capture.ts:867-880）保持「入 backlog + 记 capture_gave_up」的骨架不变；区别在于此时数据库是干净的，重试（同轮重试或 backlog 重放）重发同一计划：所有 id 确定性派生 ⇒ create 同 id 同内容返回既有提案（durable-memory-service.ts:126-140）；载荷 ref 幂等命中（上面第 2 点）。重放一个**已完全提交**的 generation 也安全——golden 测试的重放用例（automatic-memory-golden.test.ts:353-360）改造后继续守这一条。
- 因为回滚干净，`PORT_DUPLICATE`、`PORT_CONFLICT` 在重试时只可能来自真正的并发冲突，`SAME_TURN_RETRYABLE_CAPTURE_ERRORS` 的现有语义不用动。

### 4. 测试（全部真实 better-sqlite3 + 真实 worker，无假替身；沿用 automatic-memory-golden.test.ts 的 `openQualifiedDatabase`＋迁移惯例，:173-174）

放 `test/integration/`，纳入 `npm run check`：

1. **回滚反向用例（关键）**：构造 3 个候选，让第 2 个在 worker 端校验失败（例如载荷分级与记忆分级不一致，sqlite-memory-operations.ts:754）。断言：第 1 个候选的记忆行、载荷、ledger、投影任务、决策记录**一行都不存在**。若有人把事务拆开，此用例必失败。
2. **崩溃反向用例**：`crashAt` 指到「第一个候选写完后」`process.exit(86)`，重开数据库断言零残留——验证的不是 JS 异常回滚，是崩溃回滚。
3. **版本空隙反向用例**：用 `holdBeforeCommitMs` 制造窗口，构造 `expectedRevision` 失配，断言整批回滚且报 `PORT_CONFLICT`。
4. **幂等正向用例**：同 plan 提交两次，断言无重复行、返回相同 id（改造现有 golden 重放用例）。
5. **计划校验反向用例**：在测试里直接向 `memory.captureCommit` 发畸形 intent（坏 ledger id、坏 memory 属性），断言被 worker 端既有校验拒绝——对应 I-73 要求的「清单里的值能过另一端校验」。

## 三、考虑过但不选的做法

1. **Prisma 式交互式事务（begin/commit 跨消息往返，回调在主线程执行）**：better-sqlite3 文档明言事务不要跨事件循环 tick；技术上虽然可以在 worker 里跨消息保持 BEGIN，但那样事务打开期间写 lane 上**所有**其他写（与记忆无关的线程写、审批写）都会被卷进同一个事务或被迫停摆，慢操作告警（sqlite-execution-context.ts:74）会把别家延迟全算进来；且主线程回调里误用非 tx 端口就跑到事务外（Prisma 文档 "Querying through db instead of tx" 一节就是讲这个坑）。本项目提交阶段无异步依赖，交互式能力纯属负担。
2. **Outbox 模式**：outbox 解决「DB 事务 vs 对外发布」的跨资源一致性；这里只有一个 SQLite 文件、一个写连接，且投影已是库内任务表（`saveWithProjection` 事务内 `proposeJob`）。等于 outbox 已以其本来形态存在，再套一层只有开销。
3. **只合并 create+supersede 为一个事务、循环仍逐候选**：治不了「第 N 个候选失败留前 N-1 个」的半轮问题，载荷/ledger/reminder 仍在事务外。这是 PR 395 顺路能达到的上限，不是目标要求的整轮原子。
4. **手动 BEGIN/COMMIT 跨多条 `context.write`**：better-sqlite3 文档明说不应与 `.transaction()` 混用；且无法把别家写请求挡在事务外，回滚会连带回滚无辜写入。

## 四、风险与反例

- **计划执行器与单操作行为分叉**：解释器式代码容易悄悄偏离既有 SQL/校验。缓解：只复用既有私有方法，测试 5 守住两端一致。
- **计划体积**：密文载荷进一条 postMessage；单轮候选是个位数（推测），风险低，但实现时要确认载荷大小上限与结构化克隆约束（未核实）。
- **与 PR 395 冲突**：两者都改 durable-memory-service / sqlite-memory-operations / automatic-memory-service / production-memory-capture。PR 395 的「重试时补做取代」应改写为计划意图，由批次执行器实现；合并顺序必须先谈。
- **`resolveSensitive` 路径**（审批通过后提交，automatic-memory-service.ts:272-407）也是跨多次写库的同类链路，本期不纳入就仍可能半轮——列为下面的拍板项。
- **「部分可见」语义变化**：以前中途失败后前几个候选对用户可见，现在要么全有要么全无。符合「记忆可靠性优先」的愿景，但要确认没有展示代码依赖半轮结果（推测无，未核实）。

## 五、需要人拍板的取舍

1. **`generations.request` 的 checkpoint 写入（production-memory-capture.ts:1155-1184）是否并入同一事务**：并入则「整轮」字面成立；不并入则它仍是独立写（其 job id 确定性，但重发幂等性未核实）。我倾向并入。
2. **`resolveSensitive` 是否本期一起纳入**同一机制。我倾向本期纳入，改动量小且同类。
3. **`putPayload` 的幂等语义**：从「ref 已存在即 fail」（sqlite-durable-operations.ts:1711）放宽为「同 ref 同 digest 幂等命中」。这是放宽一个既有校验，需要 Andy 同意。
4. **`#save` 失败是否从 capture_gave_up 改回 backlog 重试**：事务化后重试成本大降（无残留、无 PORT_DUPLICATE），gave_up 的主要理由消失。我倾向改为照常入 backlog、按 `MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS` 重试。

## 六、必答问题逐条

**1. 会不会改变模型已经见过的请求开头？** 不会。改动全部位于模型调用完成之后的持久化路径，不触碰系统提示、工具定义、历史消息、遮盖：请求组装代码（prompt-catalog、runtime-pi、遮盖）一行不改；每轮会变的值（时间、选中记忆）仍只进最后一条用户消息；`#prepare` 里的同轮重试是既有行为，不新增请求形态（production-memory-capture.ts:854-858）。规则要求的「只在末尾追加、变的值在最后一条消息」（.claude/rules/prompt-prefix.md:28,35）不被触碰；KV 缓存机制见 Anthropic 文档（https://platform.claude.com/docs/en/build-with-claude/prompt-caching）。现有门槛 `npm run check:prompt-prefix` 及其反向用例继续生效，应全绿。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。改动不向模型请求序列化任何新内容。数据库侧：时间戳每轮取一次随计划传入（同事务各行一致）；ledger/决策 id 由固定输入哈希（automatic-memory-service.ts:574）；计划是数组、顺序即候选顺序，`sourceRefs` 沿用既有的 `[...new Set(...)].sort()`（automatic-memory-service.ts:508），无集合遍历顺序泄漏。载荷密文由加密层产生，可能每次不同，但它只入库、不进模型请求，且整轮回滚后不存在「同一轮写出两份密文」的情形。

**3. 有没有对应的自动检查，反向用例会不会真的失败？** 有。`test/integration/` 新增 5 个用例（上文），全部用真实 SQLite worker、纳入 `npm run check`。回滚用例（第 1、2 条）在当前逐候选实现下**必然失败**（前序候选已落库），事务实现下通过；幂等与校验用例同理。按 I-73 的教训，校验用例特意从「另一端」（worker 端）发畸形输入，而不是只测主线程的 plan builder。

**4. 改动产生/修改的每个值，两端都能接受吗？** 逐个核对：
- `memory.captureCommit`（新操作名）：产生于 durable-adapters 新适配器，消费于 sqlite-memory-operations.ts:322 的 switch；两端同包同仓库。需核对 `SqliteDurableOperations.execute` 兜底行为（推测无白名单拦截，未核实）。
- `MemoryCaptureUnitOfWork` 端口：定义于 packages/application/src/ports，实现于 persistence-sqlite，装配于 production-http-composition.ts:1065-1093 一带（memoryControl 处）及 golden 测试。
- 计划里的每个 id（memory id、contentKey/ref、ledgerId、approvalId、reminderId）：派生规则与消费端校验全部沿用现状——worker 端 `assertMemoryShape`（sqlite-memory-operations.ts:660-677）、`validateLedgerWrite`（:708-711）、载荷存在性与分级一致性（:743-756）、`validTransition`（:680-692）；golden 测试的 `memoryIdFor` 无冒号变体（automatic-memory-golden.test.ts:327）也要过同一校验，测试本身就验证了这点。**未核实**：worker 端是否校验 memory id 的格式前缀（若校验，golden 变体已在通过，说明校验允许它）。
- 计划序列化格式：结构化克隆，纯数据（推测，实现时以测试 5 验证畸形输入被拒）。
