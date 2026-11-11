# 复核结论（e39b7977，对照 3af9f207；增量 f1fb8d42..e39b797）

说明：本轮增量（f1fb8d..e39b797）里与本改动相关、且改动同一文件的是 `packages/persistence-sqlite/src/product-state-repository.ts` 的 `extraReadThreadBudget`（合并 main 带入），其余是本改动主体（3af9f207..f1fb8d 已成形）。增量里 `production-mcp-read.ts`、`service-main.ts`、`authenticated-uds-transport.ts` 等属于 main 合并内容，未逐行复核，标「未核实」。

## 读代码证实的问题（按严重度）

### 1. 中：worker 里有一批写操作绕过事务范围完整性检查
- 文件:行：`packages/persistence-sqlite/src/sqlite-worker.ts:1006-1110`，`packages/persistence-sqlite/src/sqlite-durable-operations.ts:562-570`
- 问题：`transaction.begin/commit/rollback` 以及所有 `*` 端口操作走 `default: durableOperations.execute(...)`，才会执行 `transactionScopeLost` 和 `inTransaction` 前后自检；但 `commit`、`markPublished`、`authority.claim/renew/release`、`deployment.save`、`checkpoint` 等在 worker 的 switch 里直接处理，不经过 `execute`。若某个 scope 内先发生 SQLite 自行回滚（如 `SQLITE_FULL`），再调用这些 worker 专属写操作，它们不会被 `TRANSACTION_ABORTED` 拒绝，可能在自动提交模式下落库，违反“范围内再发任何读写一律报错”的说法。
- 证据：`sqlite-worker.ts:1108-1110` `default: value = durableOperations.execute(...)`；`sqlite-durable-operations.ts:562-569` 才有 `if (this.transactionScopeLost) this.transactionScopeAborted();` 与前后 `inTransaction` 检查。
- 影响范围：当前记忆抽取/`resolveSensitive` 路径实际使用的都是走 `default` 的操作（`memory.*`、`memoryCaptureBacklog.*`、`decisionLedger.*`、`memoryReminder.*`、`memoryBook.*`、`memoryApproval.*`、`payload.*` 等），所以本功能当前不受影响；这是 `unitOfWork` 作为通用端口暴露后的潜在缺口。
- 建议：把事务自检下沉到 worker 的消息入口（或把这些 worker 专属写操作也纳入同一检查），并在测试里用 scope 内调用 `commit`/`markPublished` 覆盖反向用例。

### 2. 低-中：`capture_gave_up` 语义改成“这一轮什么都没存下”，但“提交成功但回包丢失”的控制侧审计会丢
- 文件:行：`apps/agent-service/src/production-memory-control.ts:1061-1071`
- 问题：`resolveSensitive` 在 `unitOfWork.run` 返回后才发缓冲审计。若事务实际已提交、但 `run` 以错误返回（回包丢失），缓冲审计被丢弃，而审批状态/记忆已提交。记忆抽取侧有“队列行是提交标记”来识别这种情况并补发审计，控制侧没有对应标记。
- 证据：`const committed = await this.options.unitOfWork.run(...)`；随后 `for (const record of buffered) ... this.options.onAudit(record)`。测试 `[P3-5] sends no approval audit record when the approval's transaction is rolled back` 明确断言回包丢失时 `sent=[]`。
- 建议：要么明确这是可接受的审计丢失并在 ADR 里写明，要么在控制侧用审批状态（`approved/committed`）做“已提交”判断后补发审计。

### 3. 低：作者说法“范围外的读写在锁外等待”与代码/ADR 不一致
- 文件:行：`packages/persistence-sqlite/src/product-state-repository.ts:756-768`（读不走 `scopeGate`），`docs/adr/0240-capture-writes-in-one-transaction.md:80`
- 问题：范围外的**写**会 `while (this.scopeGate) await this.scopeGate`，但范围外的**读**直接选只读连接，不等待、不进锁。ADR 后果段也写“范围外的读走只读连接，不等”。作者摘要说“范围外的读写在锁外等待”，对“读”不成立。
- 证据：`readRequest` 的 scope 分支只在 `const scope = this.scopes.getStore()` 为真时走写连接，否则直接选 `readContexts`，没有 `scopeGate`；`writeRequest` 才有 `while (this.scopeGate) await this.scopeGate;`。
- 建议：修正作者摘要/评审材料措辞为“范围外写等待，范围外读不等，读已提交数据”。

### 4. 低：`#save` 在 `has` 不可读时只保存一次而非“最多两次”
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:897-913`
- 问题：`backlog.has` 抛错时 `state === "unknown"` 直接 `break`，跳过本轮的第二次保存。作者说“同一轮最多保存两次”，实际在队列不可读时只尝试一次。
- 证据：`const state = await backlog.has(...).then(..., () => "unknown")`；`if (state === "unknown") break;`。
- 建议：把该行为写进 ADR/注释，或改为在 unknown 时仍再试一次（取决于“读不到队列就无法确认是否已提交”的取舍）。

### 5. 低：初始 `enqueue` 失败会直接放弃整轮，既不写记忆也不入队
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:885-894`
- 问题：队列行是提交标记，`#save` 先 `has` 再 `enqueue`，若 `enqueue` 抛错（磁盘满、写通道关闭）则在任何保存前失败；这一轮既没有记忆也没有队列行可补做。ADDR 说“开始写之前先确保待补队列里有这一轮”，代码按此实现，但“失败后整轮可以安全重试”在该路径上退化为“丢失这一轮”。
- 证据：`if (!(await backlog.has(...))) await backlog.enqueue(...)`，其后才进入保存循环；`enqueue` 失败不会进入 `recordAttempt`。
- 建议：在 ADR 后果里明确该失败模式，或接受丢弃并保证 `onFailure` 可见。

### 6. 低：`close()`/`operationalStatus()` 绕过 `scopeGate`
- 文件:行：`packages/persistence-sqlite/src/product-state-repository.ts:700-730`（close 直接 `this.context.close()`），`operationalStatus` 直接 `this.context.request("status")`
- 问题：这两个调用不等待正在进行的 scope；若在事务期间调用 `close()`，worker 收到 `close` 可能在事务打开时执行 `database.close()`，导致提交失败/`scopeBroken`。正常关停通常在 `memoryCapture.stop()` 之后，风险低。
- 证据：`close()` 里 `await this.context.close()`；`operationalStatus()` 里 `await this.context.request("status", {})`，均未经过 `scopeGate`。
- 建议：`close()` 至少等待 `scopeGate`，或在文档中声明关停顺序。

## 读代码证实为“无问题”的关键点
- 事务范围确实裸用 `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`，位于写 worker；`executeTransactionScope` 处理三种事务操作，其余操作前后做 `inTransaction` 自检（`sqlite-durable-operations.ts:537-570`）。
- 范围内读通过 `readRequest` 的 scope 分支走 `this.context`（写连接），能读自己的写入；范围外读走只读连接，测试 `sqlite-transaction-scope.test.ts` 验证了未提交数据对外不可见。
- 超时：定时器只 race `work()`，超时后置 `scope.ended`，catch 里先 `await rollback` 再抛错，`finally` 释放 `scopeGate`；迟到的调用因 `assertScopeOpen` 抛 `TRANSACTION_SCOPE_ENDED`（`product-state-repository.ts:840-900`）。
- 嵌套：`runInTransaction` 检测到已有 scope 时直接 `return work()`，不提前提交（测试覆盖）。
- 回滚残留：写记忆、历史、提醒、人物、审批、投影任务、审计（缓冲后提交才发）、`backlog.remove` 都在同一 scope；`generations.request` 按 ADR 有意放在事务外，注册行回滚后保留且按身份复用（`sqlite-checkpoint-operations.ts:280-300` 的 identity 复用）。
- 重试去重：队列行在写前于事务外入队，保存成功时在**同一事务**内删除；失败后先查 `has`，行不在即视为已提交（`production-memory-capture.ts:897-927`）。事务回滚后不会留下记忆/历史/队列删除；测试 `[P3-5] saves the memories and removes the queued row in one transaction...` 断言历史只有 1 条。
- `has` 新端口：`durable-adapters.ts:1007` 注册为 read；worker `memoryCaptureBacklog.has` 做参数化 `SELECT 1`（`sqlite-memory-capture-backlog-operations.ts:133-139`）；`enqueue` 用 `ON CONFLICT ... DO UPDATE` 且不重置 attempts，重复入队安全。
- `SAVE_PENDING_CODE = "MEMORY_CAPTURE_SAVE_PENDING"` 满足 `^[A-Z][A-Z0-9_]{0,127}$`，可写入 `last_error_code`；该字段不进入模型请求，也不在 UI 直接展示（UI 按 decision ledger outcome 显示）。
- 生产接线：`production-run-composition.ts:518`、`production-http-composition.ts:1062`、`decision-chain.test.ts:186` 都传了 `repository.unitOfWork()`；`production-memory-basis.unit.test.ts:54` 用 `as never`，不触发必填校验。grep 显示 `MemoryCaptureBacklogPort` 仅有持久化实现，新增 `has` 不会漏实现。
- 自动检查：`scripts/check-memory-capture-retry.mjs` 的 `REQUIRED=40` 与三个文件的 `[P3-5]` 实际运行数一致（19 + 15 + 6 = 40；15 来自 `describe.each` 的 6×2 加 3 个单项）。反向用例包含回滚、真实 SQLite 失败、超时、scope 结束后迟到写入、SQLite 自行回滚、worker 丢失、队列行删除失败导致整轮回滚、一次事务只写一次历史。
- ADR 0222/0240 的“不改表”、`schema-catalog` 只改描述、三语 i18n 只改文案，与代码一致；`MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS=3`、`SAVE_ATTEMPTS_PER_TURN=2` 与代码一致。

## 推测/未核实
- **未核实**：`putPayload` 是否只写 SQLite 表、不落外部文件。已读到 `payload.put` 走 `putPayload` 且 `sqlite-durable-operations.ts:1768` 是 `INSERT INTO payloads`，但没读到完整函数体；若它同时写文件，则事务回滚只回滚 DB 行，可能留下孤儿 payload 文件（不影响记忆去重，但有资源残留）。
- **未核实**：超时期间若有外部定时器在 scope 外触发写请求，会在 `scopeGate` 上等到回滚后执行（不会加入事务），但该写若属于被回滚逻辑的一部分，可能成为“回滚后残留”。当前 `processCommittedRun` 没有这种分离任务。
- **未核实**：增量合并带入的 `production-mcp-read.ts`、`service-main.ts`、`authenticated-uds-transport.ts` 等未逐行审计；`extraReadThreadBudget` 的释放逻辑我读了，未发现明显泄漏，但未跑测试验证。
- **未核实**：`git diff f1fb8d..e39b797` 中 `.agents/reviews/**` 被环境拒绝读取，未参考上一轮结论。

## 侧重检查（错误路径/不可信输入/安全/资源耗尽/不可撤销/文档一致性）
- 错误路径：超时、抛错、worker 丢失、回滚失败（`scopeBroken` 永久关闭写通道）、SQLite 自行回滚（粘滞 `TRANSACTION_ABORTED` 直到 rollback）均已读代码并有测试；见上述第 1 条的 worker 专属操作缺口。
- 不可信输入：`transactionScopeTimeoutMs` 在 `open` 前校验为 1..30000 整数（`validScopeTimeout`），测试确认非法值不会启动 worker；`has`/`enqueue`/`recordAttempt` 的 generationId、errorCode、时间均有格式校验或参数化 SQL。
- 安全：无新增外部输入面；`has` 只读、参数化，不泄露文本（队列行只有 id 和错误码）。
- 资源耗尽：默认 2s 超时只覆盖回调，`BEGIN`/`COMMIT` 受 SQLite `busy_timeout`（默认 5s）约束，理论上最坏阻塞写通道约 2s+5s+5s；未发现无界等待（worker 退出会 reject 所有 pending）。payload/加密 I/O 计入 2s 回调超时，慢盘下可能整轮回滚并重试，属于设计风险。
- 不可撤销：记忆写入/历史/审批/提醒均在事务内，失败回滚；审计改为提交后发（控制侧回包丢失会丢审计，见第 2 条）。
- 规则/文档一致性：`.claude/rules/prompt-prefix.md` 与 ADR 0240 互不冲突；作者摘要“范围外读写等待”与 ADR 后果段不一致（见第 3 条）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及数据库写入事务、队列标记和审计发送；没有改系统提示、工具定义、历史消息或遮盖逻辑。记忆抽取的最终模型请求在 `#plan/#prepare` 里构建，写入阶段 `processCommittedRun` 的 `extract` 是返回已解析候选的闭包，不在事务里再调模型。发给模型的内容仍只在末尾追加，每轮变化的值仍在最后一条消息（记忆抽取请求把固定指令放前、数据在后）。依据 `.claude/rules/prompt-prefix.md` 第 1、2、4 条。唯一间接影响：事务化后不再有“半轮记忆”，下一轮记忆抽取提示里的 `existingMemories` 可能与旧行为不同——但这是辅助调用，且它本来就按轮重新构建，不是主对话已发请求开头的变化。

2. **会不会让同一段文字在不同请求里变成不同字节？** 本改动没有引入新的、发给模型的非确定值。新增的 `lastErrorCode`、`occurredAt`、`updatedAt` 只进数据库/诊断，不进模型请求；`backlog.has` 返回布尔，不参与提示。`clock.now()` 在审计/决策记录里变化，但审计在提交后发到诊断，不参与模型字节。事务超时/顺序不影响提示序列化。未发现新的“依赖后文遮盖、带时间字段、无序集合”问题（记忆列表排序是既有逻辑，不在本改动）。

3. **有没有对应自动检查，反向用例真的会失败？** 有。`npm run check:memory-capture-retry` 运行带 `[P3-5]` 的 40 条测试（19 记忆抽取 + 15 事务范围 + 6 迁移契约），与脚本 `REQUIRED=40` 一致。反向用例确实存在且针对本改动：scope 抛错/真实 SQLite 失败/超时都断言写入回滚；scope 结束后迟到写入断言 `TRANSACTION_SCOPE_ENDED`；SQLite 自行回滚后断言 `TRANSACTION_ABORTED` 且后续操作不执行；worker 丢失后写请求断言 `TRANSACTION_ROLLBACK_UNCONFIRMED` 而不是一直挂住；队列行删除失败时断言记忆/历史为空并保留队列行；“提交成功但回包丢失”断言不重复写入且补发审计。若把事务去掉或只包部分写入，这些用例会失败。控制侧“回滚不发审计”的用例也会在审计提前发送时失败。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？** 逐项核对：
   - `UnitOfWorkPort` / `repository.unitOfWork()`：生产两处、决策链测试一处已接线；其余 `ProductionMemoryControl` 构造使用 `as never`（测试）。可用。
   - `MemoryCaptureBacklogPort.has(generationId)`：唯一实现 `durable-adapters.ts:1007`，worker 分发 `sqlite-memory-capture-backlog-operations.ts:46-47,133-139`，输入来自内部 `generationId`，参数化查询；返回 boolean 被 `#save`/重试循环按“queued/gone/unknown”消费。可用。
   - `SAVE_PENDING_CODE`：满足队列 `ERROR_CODE` 校验；不进入 UI 的 outcome 映射（UI 只认 `capture_retrying/queued/gave_up`）；不进入模型。可用。
   - `transactionScopeTimeoutMs` / `DEFAULT_TRANSACTION_SCOPE_TIMEOUT_MS`：`open` 时校验 1..30000，非法值在启动 worker 前抛错；写入 `runInTransaction` 的定时器。可用（“可配”目前是构造选项，未核实是否有配置文件接线）。
   - reason 码 `TRANSACTION_SCOPE_ENDED`/`TRANSACTION_ABORTED`/`TRANSACTION_ROLLBACK_UNCONFIRMED`/`TRANSACTION_SCOPE_TIMEOUT`：只作为 `ApplicationPortError.details.reason` 和测试断言使用，未发现前端/协议按固定枚举消费。可用。
   - `capture_gave_up` 文案：`decision-ledger.ts` 的允许值、迁移 0088/0089、校准分组、UI 的 `reviewTag/reviewText` 都已存在；只改三语文案，key 不变。可用。注意文案“补做了 3 次”与实际“最多 6 次保存尝试（每轮 2 次 × 3 轮）”在字面上有出入，但 ADR 0240 已解释“每轮最多保存两次，两次都失败才算一次”，属于说明精度问题而非校验不通过。
   - `schema-catalog` 描述、ADR 0222 后续段、ADR 0240：仅文档，与实际行为基本一致；第 3、4、5 条列出的措辞/边界差异建议同步。

总体：实现的核心事务路径、提交标记、审计缓冲和回滚测试是扎实的。最需要处理的是第 1 条（worker 专属写操作绕过事务自检的通用性缺口）和第 2 条（控制侧回包丢失审计丢失的语义一致性）；其余为文档/边界措辞与低风险设计选择。
