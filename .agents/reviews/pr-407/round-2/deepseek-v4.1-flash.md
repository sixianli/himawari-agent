# 复核结论

## 一、读代码证实的问题

### 1. 严重度：中 — 放弃（`capture_gave_up`）后若删队列行失败，下一轮会重新问模型并可能把这一轮存进记忆

**文件:行**：`apps/agent-service/src/production-memory-capture.ts:917-925`、`apps/agent-service/src/production-memory-capture.ts:945-990`、`apps/agent-service/src/production-memory-capture.ts:931-943`
**相关文档**：`docs/adr/0222-retry-and-queue-failed-memory-capture.md:56`

**问题**：满 3 次后写 `capture_gave_up`，但 `backlog.remove` 失败被 `.catch(onFailure)` 吞掉，没有像旧的 `#settle` 那样把这条记进 `#settled`。`#replayOne` 也不检查 `entry.attempts >= 3`，只检查 `#busy` 和 `#settled`。于是删行失败（或进程在 `recordAttempt` 后、`remove` 前崩溃——后者 ADR 0222 明确接受）之后，下一轮补做会重新抽取、重新保存。若此时保存成功，就会在已经显示“这一轮没有记下任何内容”之后再出现一条记忆；如果删行持续失败，每一轮都会多一次模型调用。

**证据**：
```ts
// production-memory-capture.ts:917-925
const gaveUp = attempts >= MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS;
if (gaveUp) await backlog.remove(plan.generationId).catch(this.options.onFailure);
await this.#recordFailure(
  plan,
  gaveUp ? "capture_gave_up" : "capture_queued",
  code,
  `save:${attempts}`,
).catch(this.options.onFailure);
throw failure;
```
`#replayOne` 只做这些检查，不看 `entry.attempts`：
```ts
// production-memory-capture.ts:948-960
const entry = await backlog.oldest({...});
if (!entry || this.#busy.has(entry.generationId)) return;
this.#busy.add(entry.generationId);
try {
  if (this.#settled.has(entry.generationId)) {
    await backlog.remove(entry.generationId);
    this.#settled.delete(entry.generationId);
    return;
  }
```
`#settled` 现在只在“没有候选”的分支里由 `#settle` 写入：
```ts
// production-memory-capture.ts:931-943
private async #settle(generationId: string): Promise<void> {
  try {
    await this.options.backlog?.remove(generationId);
    this.#settled.delete(generationId);
  } catch (error) {
    this.#settled.add(generationId);
    ...
  }
}
```
ADR 0222 决定 4 仍写着（且 0240 的“后续”没有取代这一段）：
> “删行失败时（存成功之后或写了放弃之后都一样），进程记下这一条只差删行，之后补做读到它只删行、不再问模型”

旧测试 `[P3-5] gives up a replayed turn whose memories cannot be written, and does not replay it again when the row could not be removed` 在本改动中被删除/改写，正好不再覆盖这条。

**建议**：放弃路径改用 `#settle`（或等价地，删除失败时记入 `#settled`）；并在 `#replayOne` 取出条目后先判断 `entry.attempts >= MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS`，只尝试删行、不再抽取。补一条反向用例：`capture_gave_up` 后 `remove` 连续失败，下一轮断言没有 `:backlog` 模型调用、也不会产生记忆。

---

### 2. 严重度：中 — SQLite 自行回滚后，“后续操作一律拒绝”没有落到代码里

**文件:行**：`packages/persistence-sqlite/src/sqlite-durable-operations.ts:527-565`
**相关文档**：`docs/adr/0240-capture-writes-in-one-transaction.md:49`

**问题**：`transactionScopeAborted()` 先把 `transactionScopeOpen` 置为 `false`，然后才抛错。于是第一个发现“事务已被 SQLite 自行回滚”的操作会被拒绝，但同一事务范围内**之后**的操作看到 `transactionScopeOpen === false`，会走 `executeUnscoped`，在自动提交状态下真正写库。这与 ADR 0240 决定 2 的“SQLite 自行回滚（例如磁盘满）时拒绝后续操作和提交”不一致，也破坏了“范围结束后范围内代码再发任何读写一律报错”。

**证据**：
```ts
// sqlite-durable-operations.ts:527-533
private transactionScopeAborted(): never {
  this.transactionScopeOpen = false;
  return this.fail("PORT_CONFLICT", "The transaction scope was rolled back", {
    reason: "TRANSACTION_ABORTED",
  });
}
```
```ts
// sqlite-durable-operations.ts:559-565
execute(operation: string, payload: unknown): unknown {
  const scoped = this.executeTransactionScope(operation);
  if (scoped !== undefined) return scoped;
  if (this.transactionScopeOpen && !this.database.inTransaction) this.transactionScopeAborted();
  const value = this.executeUnscoped(operation, payload);
  if (this.transactionScopeOpen && !this.database.inTransaction) this.transactionScopeAborted();
  return value;
}
```
对应测试只验证了“回滚后的第一个操作被拒”，随后直接重新 `BEGIN`，没有验证同一范围内第二个操作：
```ts
// test/integration/sqlite-transaction-scope.test.ts:242-254
expect(() =>
  operations.execute("memoryCaptureBacklog.enqueue", {
    entry: { ...entry, generationId: "b" },
  }),
).toThrowError(expect.objectContaining({ details: { reason: "TRANSACTION_ABORTED" } }));
...
operations.execute("transaction.begin", {});
```

**建议**：增加一个独立的、粘滞的 `transactionScopeAborted` 标记，只在 `transaction.rollback` 或新的 `transaction.begin` 时清除；在该标记存在期间所有操作都拒绝。或者让 repository 在收到 `TRANSACTION_ABORTED` 时把对应的 `TransactionScope.ended` 置为 `true`。并补一条用例：外部 `ROLLBACK` 后，同一范围内第二个写操作也必须失败。

---

### 3. 严重度：低 — `onSlowScope` 回调在 `finally` 中无保护，提交成功后抛错会伪装成事务失败

**文件:行**：`packages/persistence-sqlite/src/product-state-repository.ts:854-870`、`apps/agent-service/src/production-memory-control.ts:1061-1068`

**问题**：`COMMIT` 成功后执行 `finally`，这里直接调用 `this.onSlowScope(...)`。如果这个外部回调抛错，`runInTransaction` 会以 rejection 结束，尽管事务已经提交。对敏感批准路径来说，`unitOfWork.run` 之后的审计缓冲不会发送（`for (const record of buffered)` 不会执行），调用方还会以为批准失败。

**证据**：
```ts
// product-state-repository.ts:854-870
} finally {
  scope.ended = true;
  if (timer) clearTimeout(timer);
  this.scopeGate = undefined;
  release();
  const totalMs = Math.round(performance.now() - requestedAt);
  if (this.onSlowScope && totalMs >= SLOW_SCOPE_MILLISECONDS) {
    ...
    this.onSlowScope({ ... });
  }
}
```
```ts
// production-memory-control.ts:1061-1068
const committed = await this.options.unitOfWork.run(() =>
  resolver.resolveSensitive(...),
);
for (const record of buffered) this.options.onAudit(record);
```

**建议**：把 `onSlowScope` 调用包进 `try/catch`，至少不能覆盖原错误或把已提交变成失败；也可以像捕获路径那样对 `onAudit` 抛错做隔离。

---

### 4. 严重度：低 — 删行失败或 `recordAttempt` 后崩溃，`attempts >= 3` 的队列行仍会被当作正常补做重新抽取

这是问题 1 的另一半，单独列出是为了强调“崩溃窗口”也不该重新保存。ADR 0222:56 只接受“再补做一次”的窗口，但没有要求重新保存。当前 `#replayOne` 不读取 `entry.attempts` 做终止判断。

**建议**：同问题 1，在 `#replayOne` 入口对 `attempts >= MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS` 只删不补。

---

### 5. 严重度：低 — ADR 0240 的测试条数自相矛盾

**文件:行**：`docs/adr/0240-capture-writes-in-one-transaction.md:83`

**问题**：文字写“34 条测试”，紧接着列出的却是 16 + 14 + 6 = 36 条；脚本 `scripts/check-memory-capture-retry.mjs:14` 已改成 `REQUIRED = 36`。

**证据**：
```text
`npm run check:memory-capture-retry` 现在运行带 `[P3-5]` 的 34 条测试：
...production-memory-capture.test.ts 16 条，
...sqlite-transaction-scope.test.ts 14 条，
...memory-capture-backlog-migration.contract.test.ts 6 条。
```

**建议**：把“34 条”改为“36 条”。

---

### 6. 严重度：低 — ADR 0222 决定 7 的界面文案已过期

**文件:行**：`docs/adr/0222-retry-and-queue-failed-memory-capture.md:59`

**问题**：ADR 0222 仍写 `capture_gave_up` 显示为“这轮没记全”，但代码和三语资源已经改成“这一轮没有记下任何内容”/“Not saved from this turn”。ADR 0240 的“后续”只声明取代决定 4 和 6，没有说明决定 7 的文案也变了。

**证据**：`docs/adr/0222-retry-and-queue-failed-memory-capture.md:59` 仍写“这轮没记全”；`apps/control-center/src/i18n/resources/zh-CN.ts:995` 已是“这轮没记下”。

**建议**：在 0222 的“后续”里一并说明决定 7 的文案由 ADR 0240 更新，或直接更新 0222 的引用文字。

---

### 7. 严重度：低 — 队列写入成为保存的前提，入队失败会让这一轮永远没有机会保存

**文件:行**：`apps/agent-service/src/production-memory-capture.ts:885-894`

**问题**：`#save` 在进入保存事务前先 `has`/`enqueue`；如果 `enqueue` 抛错，后面根本不会尝试写记忆，而且也没有队列行可供下一轮补做，这一轮记忆就永久丢失。旧行为至少会直接尝试保存。两处使用同一写连接，所以很多故障是相关的；但“入队因校验/磁盘余量失败而记忆写本可成功”的情况仍是可能的行为退化。

**证据**：
```ts
if (!(await backlog.has(plan.generationId)))
  await backlog.enqueue({
    ...
    lastErrorCode: SAVE_PENDING_CODE,
    createdAt: this.options.clock.now(),
  });
let failure: unknown;
for (let attempt = 1; attempt <= SAVE_ATTEMPTS_PER_TURN; attempt += 1) {
```

**建议**：至少对入队失败记录一条 `capture_gave_up`/诊断并明确这是设计取舍；若希望保留“记忆可靠性”，可以考虑入队失败时仍尝试一次无标记保存（但要接受提交成功回包丢失时的重放风险），或在入队失败时进行有限次重试。

---

## 二、推测 / 未核实

- **推测**：问题 2 真正留下“事务外写入”需要事务回调内部捕获自动回滚错误后继续写。当前 `AutomaticMemoryService.processCommittedRun` 对数据库错误基本不捕获（`packages/application/src/services/automatic-memory-service.ts:141-158` 只捕获抽取错误），所以现有 capture 路径大概率会在第一个错误处展开，不容易触发。但 `UnitOfWorkPort` 是通用接口，未来任何捕获错误的调用方都会踩到。
- **推测**：`scopeBroken` 一旦置位就没有复位路径，若 worker 仍活着而只是一次 `ROLLBACK` 请求失败（I/O 或忙），整个服务写通道会一直关闭到重启，且 `operationalStatus` 不暴露该状态。ADR 明确选择“保持关闭”，所以这是设计取舍，不是实现错误；但建议增加健康信号或允许重新打开。
- **未核实**：测试实际执行结果。本轮只读了代码和 diff，没有运行测试。
- **未核实**：主对话请求中“本轮选中的记忆”注入到哪一段。本次 diff 没有改主对话请求组装；未发现本改动把任何会变的值移入系统提示或工具定义。

---

## 三、侧重检查（错误路径、输入、安全、资源耗尽、不可逆操作、文档一致性）

- **事务锁泄漏/死锁**：`scopeGate` 在 `finally` 中总是释放；worker 退出会拒绝所有 pending 请求；`BEGIN`/`COMMIT` 受 worker 与 SQLite 忙等待约束。未发现确定的泄漏。**未核实**：worker 存活但磁盘/系统调用永久挂起时，`scopeGate` 会一直等待（这是框架层问题，不是本改动特有）。
- **超时/取消**：超时先置 `scope.ended`，再 `ROLLBACK`，之后迟到写入被 `assertScopeOpen` 拒绝；测试覆盖。未发现超时后残留队列行之外的写入（队列行是设计上的标记）。
- **嵌套**：`runInTransaction` 发现当前 ALS 作用域就直接加入，不会提前提交；测试覆盖。
- **worker 崩溃**：rollback 请求失败会置 `scopeBroken` 并释放 gate，后续写立刻报 `TRANSACTION_ROLLBACK_UNCONFIRMED`；新测试覆盖，且反向用例（不修复会一直等待）成立。
- **回滚后残留**：记忆、历史、队列行在同一个事务；审计在提交后才发；payload/ledger/提醒/人物都经由同一个 repository 写连接，理论上一起回滚。`generations.request` 行按 ADR 明确保留。发现的问题 1（放弃后删行失败）和问题 2（自动回滚后非粘滞）是例外路径。
- **重试重复**：提交标记 `has` + 同事务删行，`[P3-5]` 测试检查了“第一次删行失败后第二次保存只写一条记忆和一条历史”。未发现正常路径重复。
- **范围外读者**：读取走独立只读连接；测试验证范围内写入对外不可见，且范围外读不等待。
- **不可信输入**：`lastErrorCode` 有正则和列长校验；`createdAt` 有严格 ISO 校验；`attempts` 有 CHECK 上限。新增的 `backlog.has` 没有对 `generationId` 做长度/类型校验，但它是只读、参数化的内部端口，风险低；建议与 `enqueue` 保持一致。
- **资源耗尽**：全局写事务最长约 2 秒回调 + 两次忙等待，会阻塞其他写；问题 1 在删行持续失败时会导致每轮额外模型调用；问题 2 的 `scopeBroken` 会让写通道永久关闭。
- **规则文件/文档一致性**：本改动没有触碰 `prompt-catalog`、系统提示、工具定义、历史或遮盖；ADR 0240 与 ADR 0222 存在上述测试条数、界面文案和“删行失败后只删不补”的偏差。

---

## 四、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会由本改动直接改变。** diff 没有修改系统提示、工具定义、历史消息、遮盖或请求组装代码；改动只在模型抽取完成后的持久化、队列和审计路径。发给模型的内容仍然只在末尾追加，每轮会变的值仍然由原有逻辑放在最后一条用户消息/后台调用的数据段里，本改动没有搬动它们。

需要说明的间接影响：保存更可靠后，后续轮次“已有记忆/相关记忆”列表的内容可能与本改动前不同（以前失败放弃的记忆现在可能被保存）。只要这些记忆仍位于每轮可变的最后一段，就没有违反“只追加”；若主对话把记忆注入到系统提示里，则会是另一个问题，但本次 diff 未触及该注入点，我也未核实其位置。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**没有新增这种风险。** 本改动没有改遮盖、JSON 序列化、键顺序或集合排序。新增的 `SAVE_PENDING_CODE`、`attempts`、`occurredAt`、`lastErrorCode` 都只写入数据库/审计，不进入模型请求。事务和 `has` 只是读已提交数据，不会改变同一段文字序列化后的字节。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有：
- `scripts/check-memory-capture-retry.mjs` 用 `[P3-5]` 过滤，要求至少 36 条通过；覆盖 `production-memory-capture`、`sqlite-transaction-scope`、`memory-capture-backlog-migration`。
- 新增回滚审计用例：如果把 `onAudit` 直接传给 resolver，`sent` 就不会为空，用例会失败。
- 新增 worker 丢失用例：如果不在 rollback 失败时关闭写通道并释放 gate，后续 `enqueue` 会一直等，`Promise.race` 会返回 `"waiting"`，用例会失败。
- 事务回滚/超时/隔离/嵌套/自动回滚都有用例。

缺口：
- 没有用例验证“自动回滚后同一范围内的第二个操作仍被拒绝”，因此 ADR 0240 决定 2 的这句话目前是未被测试、且按代码会失败的。
- 放弃后删行失败的正向/反向用例被删掉了，导致本次发现的回归没有自动检查。
- ADR 写 34 条、脚本要求 36 条，文档与检查不一致。

**未核实**：实际运行结果（本轮未执行测试）。

### 4. 改动产生或修改的每个值，使用它的一端都能接受吗？

- **`UnitOfWorkPort.run`**：产生于 `repository.unitOfWork()`；使用于 `ProductionMemoryCapture.#commit`、`ProductionMemoryControl` 敏感批准、`production-http-composition`、`production-run-composition`。这些写入都经由同一个 repository 的写连接；构造点已补 `unitOfWork`（`production-http-composition.ts:1046`、`production-run-composition.ts:518`、`decision-chain.test.ts:186`、`production-memory-capture.test.ts:247/292`）。`production-memory-basis.unit.test.ts:54` 用 `as never` 构造且不执行批准路径，暂不影响。**两端可接受。**
- **`MemoryCaptureBacklogPort.has`**：产生于 `durable-adapters.ts:1004` → `sqlite-memory-capture-backlog-operations.ts:46/133`，使用于 `production-memory-capture.ts:885/903`。返回 boolean，worker 操作名已注册；SQL 参数化。唯一不一致是它没有像 `enqueue` 那样校验 `generationId` 长度/类型，但只读，风险低。**两端可接受。**
- **`SAVE_PENDING_CODE = "MEMORY_CAPTURE_SAVE_PENDING"`**：满足 backlog 的 `ERROR_CODE` 正则（`^[A-Z][A-Z0-9_]{0,127}$`）和列 CHECK（长度 1–128）；只作为 `last_error_code` 存储，未发现被界面文案或其他校验拒绝。**两端可接受。**
- **`transactionScopeTimeoutMs`**：由 `validScopeTimeout` 限制为 1–30000 的整数，`SqliteProductStateRepository.open` 传入；超时错误码 `TRANSACTION_SCOPE_TIMEOUT` 只用于 details，测试和调用方按 details 读取。**两端可接受。**
- **新错误原因 `TRANSACTION_SCOPE_ENDED` / `TRANSACTION_SCOPE_TIMEOUT` / `TRANSACTION_ROLLBACK_UNCONFIRMED` / `TRANSACTION_ABORTED`**：只在 `ApplicationPortError.details.reason` 里，测试按该字段断言；未发现需要枚举校验的消费端。**两端可接受。**
- **三语文案**：`dailyReview.tag.captureGaveUp` / `dailyReview.captureGaveUp` 已同步修改，`proactive-interactions.unit.test.ts` 已更新；未发现其他地方硬编码旧文案。**两端可接受**，但 ADR 0222 的文档文字没同步。
- **测试清单/计数**：脚本 `REQUIRED = 36` 与实际标签数量 36 一致；ADR 0240 的“34 条”不一致（低）。
