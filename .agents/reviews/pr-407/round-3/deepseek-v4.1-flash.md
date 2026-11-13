# 复核结论（a40e2d35，对比 27c58894 的增量）

## 发现（按严重度从高到低）

### 1. 中：用“队列行不存在”判定已提交，会把被别的路径删掉的行也当成提交成功，静默吞掉一次真实保存失败
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:902-908`、`apps/agent-service/src/production-memory-capture.ts:1271-1278`；`packages/persistence-sqlite/src/migrations/0088_memory_capture_backlog.sql:244-246`
- 问题：提交失败后只看队列行在不在。行不存在就被当成“已提交”，直接 `return`，既不再试，也不记 `capture_queued`/`capture_gave_up`。但行消失不一定等于本事务提交：线程/Owner/Agent 删除会级联删行，另一个实例或另一条路径“放弃”时也会先删行。
- 证据（读代码证实）：
  ```ts
  // production-memory-capture.ts:902-908
  if (
    await backlog.has(plan.generationId).then(
      (queued) => !queued,
      () => false,
    )
  )
    return;
  ```
  ```sql
  -- 0088_memory_capture_backlog.sql:244-246
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  ```
  `#commit` 里 `backlog.remove` 与记忆写入同事务（`production-memory-capture.ts:1271-1278`），所以“行不在=已提交”在单实例正常路径成立；但它不是唯一能让行消失的原因。
- 推测部分：生产里 `ProductionMemoryCapture` 是服务启动时创建的一个实例（`service-main.ts:2344`），同进程内 `#busy` 能挡住同一 generation 的并发保存，因此“另一实例先放弃并删行”主要出现在测试/多实例场景；线程删除场景则会把“本来也无需保存”的失败当成成功，后果较轻。故定为中而非高。
- 建议：不要只用“行不在”作为提交证明。至少在同事务内写一个不会被级联删除的提交标记，或让 `has` 返回“行不存在的原因”；也可以改为检查该 generation 的记忆/历史是否确实存在，只有在“行不在且本轮产物存在”时才判定成功。线程被删的情况应显式短路为“整轮作废”，并留下可区分的记录。

### 2. 中：提交成功但回包丢失时，缓冲的审计会被丢掉
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:1271-1285`、`apps/agent-service/src/production-memory-capture.ts:896-909`
- 问题：`#commit` 先 `await unitOfWork.run(...)`，只有成功返回后才发 `audits`。如果 SQLite 已 COMMIT、但 `transaction.commit` 的响应没回来（工作线程退出等），或提交后 `onFailure` 抛出，`#commit` 会在发审计前抛错；`#save` 随后的 `has` 检查发现行已被本事务删掉，按成功 `return`。结果是：记忆已提交，审计却一条没发，直接违反“提交成功后才发审计”的意图。
- 证据（读代码证实）：
  ```ts
  // 1271-1278
  await this.options.unitOfWork.run(async () => {
    await service.processCommittedRun({...});
    await backlog?.remove(plan.generationId);
  });
  // 1280-1285
  for (const record of audits)
    try { this.options.onAudit(record); } catch (error) { this.options.onFailure(error); }
  ```
  ```ts
  // 896-908：抛错后 has 为 false 就当作成功返回
  try { await this.#commit(plan, parsed); return; }
  catch (error) { failure = error; if (await backlog.has(...).then(q => !q, () => false)) return; }
  ```
- 建议：在 `has === false` 的“按已提交处理”分支里，先把本轮缓冲的审计发出去（这些审计对应的写入很可能已落库）；或者让 `#commit` 区分“回调失败”和“提交结果未知/提交成功但回包失败”，只在真正回滚时丢弃审计。

### 3. 低：敏感审批的审计在提交后直接发，没有像捕获那样逐条兜底
- 文件:行：`apps/agent-service/src/production-memory-control.ts:1061-1069`（对照 `production-memory-capture.ts:1280-1285`）
- 问题：事务提交成功后 `for (const record of buffered) this.options.onAudit(record);` 没有 try/catch。审计接收方抛错会让命令报失败，但审批其实已经提交；还可能出现一部分审计已发、后面没发。
- 证据（读代码证实）：
  ```ts
  const committed = await this.options.unitOfWork.run(() => resolver.resolveSensitive(...));
  for (const record of buffered) this.options.onAudit(record);
  return { resultRef: committed ?? requestId, replayed: false };
  ```
- 建议：与捕获路径一致，逐条 try/catch 并走 `onFailure`；或审计失败只上报、不影响已提交命令的返回。重试本身因 `resolveSensitive` 对已 committed 的请求直接返回（`automatic-memory-service.ts:280`）是幂等的，所以不会重复，但用户会看到“失败”。

### 4. 低：非法的 `transactionScopeTimeoutMs` 会泄漏工作线程和数据库句柄
- 文件:行：`packages/persistence-sqlite/src/product-state-repository.ts:266-315`、`packages/persistence-sqlite/src/product-state-repository.ts:180-184`
- 问题：`open` 先启动了写、读两个 `SqliteExecutionContext`，然后在构造参数里才调用 `validScopeTimeout(...)`。值非法时构造函数抛出，`open` 的 catch 只 `lock.release()`，没有关闭两个上下文，worker 线程和数据库连接会残留、进程可能无法退出；再次打开还可能撞状态根锁。
- 证据（读代码证实）：
  ```ts
  scopeTimeoutMs: validScopeTimeout(
    options.transactionScopeTimeoutMs ?? DEFAULT_TRANSACTION_SCOPE_TIMEOUT_MS,
  ),
  ```
  ```ts
  } catch (error) {
    await lock.release();
    throw error;
  }
  ```
- 建议：在启动任何上下文之前先校验 `transactionScopeTimeoutMs`；或在 catch 里同时关闭已启动的 context/readContext。

### 5. 低：ADR 0222 仍然写着“放弃后、删行前重启会再补做一次（再问模型）”，代码已经改成直接删行不问模型
- 文件:行：`docs/adr/0222-retry-and-queue-failed-memory-capture.md:56,62`、`apps/agent-service/src/production-memory-capture.ts:956-963`
- 问题：ADR 0222 决定 4 原文写“进程恰好在写放弃之后、删行之前重启，这一条会再补做一次”。本次修复后，`#replayOne` 看到 `entry.attempts >= MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS` 会直接删行返回，不再问模型（新测试 `production-memory-capture.test.ts:3243-3264` 正是验证这一点）。ADR 0222 的后续说明只说改写了“写记忆失败直接放弃”，并称“其余决定不变”，没有说明这条重启行为也变了。
- 证据（读代码证实）：
  ```ts
  if (
    this.#settled.has(entry.generationId) ||
    entry.attempts >= MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS
  ) {
    await backlog.remove(entry.generationId);
    this.#settled.delete(entry.generationId);
    return;
  }
  ```
- 建议：在 ADR 0222 的后续块或 ADR 0240 的决定 6 里补一句：满 3 次后即使进程在删行前重启，也只删行不再问模型。这样文档才和“放弃后删行失败不再重新问模型”的提交说明一致。

### 6. 低：满次数后的“直接删行”分支可能没有对应的 `capture_gave_up` 记录（崩溃窗口）
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:956-963`、`apps/agent-service/src/production-memory-capture.ts:978-990`
- 问题：如果进程在 `recordAttempt` 把 attempts 写到 3 之后、`#recordFailure("capture_gave_up")` 之前崩溃，重启后这个分支只删行，不再补写放弃记录。轮到这一轮的记忆其实早已全回滚，但页面上不会出现“这轮没记下”的解释。
- 证据（读代码证实逻辑，触发窗口为推测）：
  ```ts
  entry.attempts >= MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS
    ? await backlog.remove(...) ...
  ```
  与 `#replayOne` 的 `recordAttempt`/`#recordFailure` 是分开的两次非事务写入。
- 建议：进入该分支时用确定性 id 补写一条 `capture_gave_up`（若已存在则幂等复用），或在同一事务里把 attempts=3 的行变成“已放弃”状态再删。严重度低，因为只影响解释记录，不影响数据。

### 7. 低（作者说法与代码不一致）：不是“范围外的读写在锁外等待”，范围外的读根本不等待
- 文件:行：`packages/persistence-sqlite/src/product-state-repository.ts:735-761`、`packages/persistence-sqlite/src/product-state-repository.ts:764-780`
- 问题：作者的说法写“范围外的读写在锁外等待”。代码里只有写请求在 `scopeGate` 上等待；范围外的读走只读连接，不等待写事务（ADR 0240 的“后果”一节自己也写“范围外的读走只读连接，不等”）。
- 证据（读代码证实）：
  ```ts
  private readRequest(...) { const scope = this.scopes.getStore(); if (scope) {...}
    // 选 readContexts，直接 chosen.request(...)，没有 scopeGate
  }
  private async writeRequest(...) { ... while (this.scopeGate) await this.scopeGate; ... }
  ```
- 建议：把作者说法改为“范围外的写等待，范围外的读走只读连接、读到已提交数据”。

### 8. 低（推测）：提交回包丢失且 `has` 读取失败时，重试可能让 `unchanged` 候选多一条历史
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:902-908`、`packages/application/src/services/durable-memory-service.ts:107-120`
- 问题：`has` 读取失败被映射成 `false`（“仍在队列”）而进入第二次保存。如果第一次其实已经 COMMIT，第二次 `applyProposal` 对 `create` 是幂等的（同 id 同内容直接复用），但 `unchanged` 分支每次都会 `appendHistory`：
  ```ts
  if (proposal.decision === "unchanged") {
    ...
    await this.options.state.appendHistory({ ... note: historyNote("reaffirmed", ...) ... });
  }
  ```
  因此可能出现重复历史事件。
- 证据：上面两段代码是读到的；“COMMIT 成功但回包丢失 + has 读失败”的组合是推测（正常 `has` 成功时会在第二次保存前返回）。
- 建议：把 `has` 的读取失败当成“结果未知、不可重试”的失败（保留队列、不等同于仍在队列），或让历史追加使用确定性 id / 去重，使整轮重试真正幂等。

## 侧重检查

- **错误路径**
  - 超时：计时器只包住 `work`，不包 `BEGIN`/`COMMIT`；超时设 `scope.ended=true` 后 `Promise.race` 拒绝，随后 catch 发 `ROLLBACK`，`finally` 释放 `scopeGate`（`product-state-repository.ts:821-873`）。读代码证实没有 `scopeGate` 泄漏。
  - 嵌套：同一 ALS 上下文内 `run()` 直接复用外层，不再开事务（`product-state-repository.ts:806-810`）；读代码证实不会提前提交。
  - 工作线程丢失：`transaction.rollback` 请求失败时置 `scopeBroken`，之后所有写抛 `TRANSACTION_ROLLBACK_UNCONFIRMED`（`product-state-repository.ts:846-853,782-789`）；测试 `sqlite-transaction-scope.test.ts:186-205` 覆盖。代价是写通道永久关闭，直到重启；这是 ADR 明说的取舍，但没有任何运行时恢复手段。
  - SQLite 自行回滚：写前/写后都检查 `inTransaction`，并用 `transactionScopeLost` 让后续操作粘滞失败，只有显式 `transaction.rollback`/新的 `begin` 清除（`sqlite-durable-operations.ts:527-570`）；测试 `sqlite-transaction-scope.test.ts:207-266` 覆盖，且“再写一次”的反向断言在旧代码上会失败。
- **不合规范或不可信输入**
  - `memory.approval.respond` 的 `editedText` 在进事务前校验（`production-memory-control.ts:1038-1044`），未进入事务的校验失败不会留下任何写入。
  - backlog 入队校验 `generationId`/`sourceRunId` 长度、错误码正则和时间格式（`sqlite-memory-capture-backlog-operations.ts:58-90`）；新错误码 `MEMORY_CAPTURE_SAVE_PENDING` 符合 `/^[A-Z][A-Z0-9_]{0,127}$/`，列约束是 1..128（`0088...sql:249`），两端都接受。
  - `has` 只接受内部类型化字符串，没有绕过校验的新入口。
- **安全**
  - 范围外读者走 `readOnly` 连接（`sqlite-worker.ts:117-126`），没有 `read_uncommitted`，WAL 下只读已提交数据；测试 `sqlite-transaction-scope.test.ts:68-103` 断言事务内写入在提交前对范围外不可见。
  - 载荷 `protect` 返回 `storage: { kind: "inline" }`（`payload-protector.ts:225`），`payload.put` 写入 SQLite；事务回滚不会留下外部文件残留。加密每次用随机 DEK/nonce，同一明文两次加密的密文可能不同，但解密后才发给模型，不影响模型请求字节。
  - 审计/队列只放 id、错误码、时间，不新增敏感原文。
- **资源耗尽**
  - 超时参数限制 1..30000ms（`product-state-repository.ts:180-184`）；`#settled` 上限 1000（`production-memory-capture.ts:937-940`）。
  - 发现第 4 条：非法超时值会在启动 worker 之后才被拒，泄漏上下文。
  - 事务持锁期间所有写排队；回滚请求本身没有超时，最坏要等写 worker 处理完在途请求（受 SQLite busy timeout 约束）。读代码未见无界等待以外的死锁路径；未运行验证。
- **不可撤销操作**
  - 记忆/历史/队列删除在同一个事务里，失败可整轮回滚；`generations.request` 登记行刻意留在事务外（`production-memory-capture.ts:1202-1236`），ADR 说明保留无害，代码一致。
  - 放弃时的删行在事务外（`#settle`，`production-memory-capture.ts:931-943`）。删行失败只上报并留在 `#settled`，不再重新问模型；这是本次修复的目标。
- **规则/文档一致性**
  - 没有改动 `.claude/rules/prompt-prefix.md`、提示词目录、工具定义或遮盖代码；本次 diff 未触及这些文件，故“不碰发给模型的请求”成立。
  - ADR 0240 的“不改表”“37 条测试”“范围内读走写连接”“范围外读不等”都与代码一致。
  - ADR 0222 关于“重启后再补做一次”的原文未更新（发现第 5 条）。
  - 作者说法“范围外的读写等待”不准确（发现第 7 条）。

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？
**不会（读代码证实）。**
- 本次改动没有修改 `packages/prompt-catalog`、系统提示、工具定义、历史组装或出口遮盖；`#commit` 仍然把同一份 `plan.input` 和已解析候选交给 `processCommittedRun`（`production-memory-capture.ts:1271-1278`），新增的 `unitOfWork` 只是 options 上的额外属性，`AutomaticMemoryService` 不使用它。
- 记忆抽取本身是后台辅助调用；其请求组装仍在 `#plan`/`memoryCapturePrompt` 中，顺序仍是固定指令在前、本轮数据在后。模型看到的请求仍是“末尾追加”语义，没有被本改动改写历史或系统提示。依据规则第 4 条（已发出内容只追加）、第 3 条（新情况追加消息）。
- 每轮会变的值没有从末尾挪到前面；本次新增的 `createdAt`/`updatedAt`/审计 `occurredAt` 只进队列和审计记录，不进模型请求。
- 未核实项：没有运行 `check:prompt-prefix`；结论基于 diff 未触及相关文件与代码路径。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？
**对发给模型的内容：不会（读代码证实）。对存储元数据：会有时间/密文差异，但不是模型可见字节。**
- 本次没有新增进入提示词的无序集合；`audits` 数组按 push 顺序生成和发送，顺序确定。
- 同一段记忆文本在事务重试时可能被再次加密，得到不同密文（`payload-protector.ts:202-225` 每次生成随机 DEK/nonce），但发给模型前会解密成同样的明文；历史里存的是明文内容引用，不存本次密文。
- `createdAt`/`updatedAt`/`occurredAt` 在重试时会变，但它们不在模型请求里。符合规则第 10、11 条关于“发给模型的内容序列化确定、遮盖确定”的要求。
- 未核实：并发“当前轮保存”和“补做保存”下，后续轮次读到的记忆集合顺序是否有变化；这是既有并发行为，本次未改变其代码，未作深入验证。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？
**有自动检查，反向用例在逻辑上确实针对了修复点；但我没有运行测试，通过与否为未核实。**
- `scripts/check-memory-capture-retry.mjs` 用 `-t "[P3-5]"` 跑三个文件，`REQUIRED=37`；我按代码数到 `production-memory-capture.test.ts` 17 条、`sqlite-transaction-scope.test.ts` 14 条（`describe.each` 6×2 + 1 + 1）、backlog 合约 6 条，合计 37，与 ADR 0240 一致。
- 反向用例：
  - `sqlite-transaction-scope.test.ts` 的自回滚用例要求自回滚后的第三次入队仍抛 `TRANSACTION_ABORTED` 且行数为 0。旧实现把 `transactionScopeOpen` 置 false 后，第三次写会直接在事务外执行并成功，因此该用例在旧代码上会失败——是有效反向用例。
  - 新测试 `production-memory-capture.test.ts:3243-3264` 用新的 `ProductionMemoryCapture` 实例验证 attempts=3 的残留行不再问模型。旧实现只检查实例内 `#settled`，新实例会重新调用模型，因此该用例在旧代码上会失败。
  - 超时、范围外写等待、范围外读不可见等用例，在没有 `scopeGate`/超时/写连接读的实现上也会失败。
- 不足（读代码证实）：
  - 检查脚本只要求 `passed.length >= 37`，不锁定具体用例；删掉一条回归用例再加一条新的仍能通过。
  - `test/integration/production-memory-capture.test.ts` 只用 `useSqliteContractExecution("direct")`（第 92 行）。`processCommittedRun` 在真实 worker 下的嵌套 better-sqlite3 事务路径没有由该文件覆盖；`sqlite-transaction-scope.test.ts` 虽覆盖 worker，但只操作 backlog 表。这是覆盖缺口，不是已证实的故障。
  - 没有覆盖“COMMIT 成功但回包丢失时审计是否发出”和“队列行被其他路径删除时是否误判成功”。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？
逐项核对结果（读代码证实，除注明外）：
- `unitOfWork`：由 `SqliteProductStateRepository.unitOfWork()` 产生（`product-state-repository.ts:800-802`）；生产用在 `production-run-composition.ts:518`、`production-http-composition.ts:1049`，测试用在 `decision-chain.test.ts:186`、`production-memory-capture.test.ts:247,292`。`ProductionMemoryControl` 的另一个单测用 `as never` 构造、没有传，但它不执行 `memory.approval.respond`，因此当前不触发。使用端都按 `UnitOfWorkPort.run` 调用，两端签名一致。
- `has`：接口 `memory-capture-backlog.ts:29`、`durable-adapters.ts:1007`、`sqlite-memory-capture-backlog-operations.ts:46-47,133-139` 三处齐全；`#save` 的读取结果只作布尔判断，表存在性查询与列定义匹配。
- `MEMORY_CAPTURE_SAVE_PENDING`：写进 `last_error_code`；错误码正则最大 128、列 CHECK 1..128，均接受。它只留在崩溃/超时前的队列行里，当前没有 UI 直接展示该字段（读到的使用方只有 capture 自身与测试）。
- `save:${attempts}`：进入 `captureLedgerId(...)`，`#recordFailure` 的 `reasonCode` 会 `slice(0,64)`（`production-memory-capture.ts:1007,1013`），长度不会被新前缀破坏；`capture_gave_up` 等 outcome 已在决策账本枚举中。
- `TRANSACTION_SCOPE_TIMEOUT` / `TRANSACTION_SCOPE_ENDED` / `TRANSACTION_ABORTED` / `TRANSACTION_ROLLBACK_UNCONFIRMED`：只放在 `ApplicationPortError.details.reason`；调用方（`captureErrorCode`、诊断写入）读的是 `error.code`，新 reason 不会造成校验拒绝；测试直接用 `details.reason` 断言，两端一致。
- `transactionScopeTimeoutMs`：`open` 校验 1..30000、默认 2000（`product-state-repository.ts:180-184,307-309`）；目前只有测试显式传入，生产未配置，默认值可用。发现第 4 条的泄漏是校验收位置问题，不是值本身不被接受。
- 三语文案：`en.ts:1058/1063`、`ja.ts:1058/1063`、`zh-CN.ts:995/998` 同步改成“这轮没记下”语义；`proactive-interactions.unit.test.ts:629` 同步更新。搜索旧文案只剩 ADR 历史原文，没有残留代码引用。
- 表结构：没有新迁移；仅 `schema-catalog.ts:668` 的描述文字改了，符合“不改表”。
- 测试计数：`REQUIRED=37` 与实际 37 条一致。

## 作者说法核对（与代码不一致处）

- “范围外的读写在锁外等待”：不准确，范围外的读不等待（`product-state-repository.ts:735-761`），只有写等待（同文件 764-780）。
- “队列行是提交标记……‘行不在’即已提交”：在单事务正常路径成立，但不是充分条件；线程级联删除或其他路径删行会产生误判（发现第 1 条）。
- “审计回调缓冲，提交成功后才发”：写入类审计是提交后发；但“提交成功但回包丢失”时审计会被丢弃（发现第 2 条）。`extraction_failed` 审计仍在抽取失败时立即发，这是“尚未开始写库”的路径，不属于已提交写入，未违反本意。
- “失败后整轮可以安全重试，不产生重复”：常规回滚重试成立；极窄的“COMMIT 成功但回包丢失 + `has` 读取失败”下，`unchanged` 候选可能多一条历史（发现第 8 条，推测）。
- 其他说法（同一轮最多保存两次、累计 3 次放弃、`resolveSensitive` 同一事务、登记行单独写、超时默认 2 秒、SQLite 自行回滚靠 `inTransaction` 自检、不改表、不改发给模型的请求）经读代码均与实现一致。
