# 复核报告：ADR 0240（每轮记忆抽取写入放进一个事务）

## 侧重检查

我走的最普通使用流程：主人发消息 → 运行提交（`writeRequest("commit")`，product-state-repository.ts:356）→ 对话结束 → `capture.start` → `#captureTurn` → `#plan`（读历史/记忆，全在事务外）→ `#prepare`（模型调用，prompt 组装未改动）→ `#save`（先在事务外入队标记行 → `unitOfWork.run` 里 `processCommittedRun` + `backlog.remove` → COMMIT）→ 缓冲审计在提交后发出（production-memory-capture.ts:1235-1284）。payload、记忆、批准、决策记录、提醒、人物全部经同一 durable 适配器走写 worker（durable-adapters.ts:302-308），都在事务内；投影任务只写行，向量计算在后台，不占事务。

**无测试覆盖的路径**：① 范围期间 worker 崩溃导致回滚请求失败（见问题 1）；② `#save` 里标记行 `enqueue` 失败后 commit 也失败（见问题 2）；③ `repository.close()` 与进行中的事务并发；④ capture 全流程下的 2 秒超时（超时只在 scope 层测试里覆盖）。作者声明的 `[PG-12]` 是 main 老失败、gitleaks/security-review 因浅克隆失败——我无法运行测试，**未核实**。

## 发现的问题（按严重度）

**1.【高】packages/persistence-sqlite/src/product-state-repository.ts:838-849 — 回滚未确认时写通道永久挂起，而不是关闭报错**
证据：catch 里回滚失败只置 `rollbackConfirmed = false`，finally 不再释放门（846-849 行：`if (rollbackConfirmed) { this.scopeGate = undefined; release(); }`）；而后续写者在 770/801 行 `while (this.scopeGate) await this.scopeGate;` 无超时、无拒绝路径。worker 崩溃（`sqlite-execution-context.ts` 的 `exit` 事件后 `exited=true`）时 `transaction.rollback` 请求立即被拒 → 门永远不清。后果：此后所有非范围写请求（包括对话运行提交、租约续期）**永久挂起且不报错**，`close()` 也不解除已挂起的等待者。ADR 0240 决定 2 说“工作线程不响应就保持关闭”——ADR 写的是“关闭”，实现是“无限等待”，两者不一致；且没有恢复、没有日志、没有报错。
建议：回滚未确认时让 scopeGate 变成“永久拒绝”（resolve 后让等待者检查一个 broken 标志并抛 `WORKER_EXITED`/`PORT_CONFLICT`），或至少给等待加超时并在慢日志里暴露。

**2.【中】apps/agent-service/src/production-memory-capture.ts:885-909 — 标记行入队失败后，提交失败会被误判为“已提交”，静默丢一轮**
证据：885 行 `if (!(await backlog.has(...))) await backlog.enqueue(...)` 未捕获错误（无 try/包裹）；若 enqueue 失败（如 PORT_CONFLICT 磁盘预留、SQLITE_BUSY 被转成 PORT_CONFLICT，见 sqlite-worker.ts:990-997），后面两次 `#commit` 也因同一底层原因失败，catch 里 902-908 行 `backlog.has` 返回 false → `return`——决策 5 的“不在队列 = 已提交”前提（行确实入过队）不成立，于是什么都没存却当作成功返回：无队列行、无 `capture_gave_up` 决策记录、无审计。旧代码（基线）在这种场景至少记 `capture_gave_up`。
建议：记录 `enqueued` 布尔值；只有“本轮开始时队列里已有行或本次入队成功”时，“行不在”才可判为已提交；否则继续重试并入队。

**3.【低】packages/persistence-sqlite/src/schema-catalog.ts:669 — 目录描述与 0240 的新语义矛盾**
证据：描述仍是 "…given up after three replays, **or removed when the result cannot be saved**"，即 ADR 0222 决定 4 的旧语义（存失败即出队）；0240 之后存失败留在队列、累计 3 次才出队。本次 diff 未更新该描述。
建议：改为与 0240 一致的表述；并核对 schema-contract 测试是否断言这段文字。

**4.【低】docs/adr/0240-capture-writes-in-one-transaction.md:82 — 测试条目拆分与实际不符**
证据：ADR 写“production-memory-capture.test.ts 21 条、sqlite-transaction-scope.test.ts 13 条”；实测该文件带 `[P3-5]` 的 `it` 是 15 条（1090、3105、3130、3143、3181、3212、3223、3238、3258、3289、3332、3355、3400、3425、3456 行），scope 文件 6×2+1=13 条，contract 文件（memory-capture-backlog-migration.contract.test.ts，157/168/182/188 行）6 条；34 = 15+13+6，ADR 漏列 contract 文件且把 15 写成 21。总数对、拆分错。
建议：修正 ADR 中的分文件计数。

**5.【低/行为观察】超过 2 秒的合法慢提交会被系统性判为超时**
证据：`DEFAULT_TRANSACTION_SCOPE_TIMEOUT_MS = 2000`（product-state-repository.ts:142），每轮 2 次保存、累计 3 次后 `capture_gave_up` 并出队（production-memory-capture.ts:699、917-918）。一轮写库确实要跨事件循环（better-sqlite3 不建议），若某轮因体量大稳定超过 2 秒，三次全滚、最终“什么都没存”——界面文案改成了与新行为一致的“没记下”，自洽；但这是对“以前可能存下一部分”的行为变化，慢范围有 500ms 日志可观察。属设计取舍，不算缺陷，提示留意 `transaction.scope` 慢日志。

## 必答问题

**1. 是否改变模型已见过的请求开头？** 不会。读代码证实：diff 只动了写库/重试/UI 文案/ADR；`memoryCapturePrompt`、工具定义、历史存储、遮盖、`generations.request` 登记均未触碰，`#commit`/`#save` 都在对话运行提交之后执行。发给模型的内容不存在本改动引入的追加或改写问题，“每轮会变的值在最后一条消息”的既有结构不受影响。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。事务内写入用确定 id（`memory:<generation>:<ordinal>`、`memory-content:<contentKey>`、`reminder:<memoryId>`、ledger id `save:<次数>` 哈希）和 `clock.now()` 时间戳（原本就有）；缓冲审计只改变发出时机，不改变记录内容；遮盖不在此路径。模型请求字节不受影响。

**3. 有没有对应自动检查、反向用例会不会失败？** 有：`scripts/check-memory-capture-retry.mjs`（REQUIRED=34，与三个文件的实际 [P3-5] 计数 15+13+6 相符）。反向推断：新测试依赖新增的 `repository.unitOfWork()`/`transactionScopeTimeoutMs` 和端口 `has`，在基线上编译/运行必败，例如 “saves the memories and removes the queued row in one transaction”（production-memory-capture.test.ts:3400）没有事务机制不可能通过。但我未被允许运行命令，**门禁实际通过与否未核实**。测试盲区见“侧重检查”。

**4. 每个新值的两端核对：**
- `UnitOfWorkPort`：产生于 `SqliteProductStateRepository.unitOfWork()`（product-state-repository.ts:789-791）；使用于 production-run-composition.ts:518、production-http-composition.ts:1049、production-memory-capture.ts:1268、production-memory-control.ts:1058。字段为必填，TS 保证全部构造点已更新；唯一未更新的构造点（apps/agent-service/test/production-memory-basis.unit.test.ts:54）用 `as never` 且只调 `query`，不受影响。
- `has(generationId)`：port 必填（memory-capture-backlog.ts:29）；唯一生产实现在 durable-adapters.ts:1005（payload `{generationId}`）与 sqlite-memory-capture-backlog-operations.ts:133-137（解构同形状）匹配；worker 与 direct 两种执行路径都能路由（sqlite-worker.ts:1109 → `execute`；sqlite-contract-execution.fixture.ts:60）。读走读 worker，事务内走写连接，两端一致。
- `transaction.begin/commit/rollback`：主线程 gate 保证串行；worker default 分支 → `SqliteDurableOperations.execute` → `executeTransactionScope`（sqlite-durable-operations.ts:536-566），与现有 `database.transaction()` 内层操作以 SAVEPOINT 嵌套共存；不与现有操作名冲突。唯一问题即发现 1（回滚未确认的泄漏）。
- `SAVE_PENDING_CODE`、界面文案、ADR 0222 补注：只进队列行的 lastErrorCode（成功即删、失败会被 `recordAttempt` 用真实错误码覆盖）和文档，无下游校验风险；但 schema-catalog 描述未同步（发现 3）。
