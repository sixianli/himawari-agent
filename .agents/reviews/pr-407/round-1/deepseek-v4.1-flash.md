## 结论

### 读代码证实的问题

#### 1. 高：回滚失败（worker 崩溃/退出、连接关闭）会导致写通道永久卡死，不是“最多等 2 秒”

文件：`packages/persistence-sqlite/src/product-state-repository.ts:835-849`

问题：`runInTransaction` 在回滚请求失败时把 `rollbackConfirmed` 置为 `false`，于是 `finally` 里永远不释放 `scopeGate`；之后所有 `writeRequest` 和新的 `unitOfWork.run` 都会无限等待。

证据：

```ts
} catch (error) {
  scope.ended = true;
  try {
    await this.context.request("transaction.rollback", {});
  } catch {
    rollbackConfirmed = false;
  }
  throw error;
} finally {
  ...
  if (rollbackConfirmed) {
    this.scopeGate = undefined;
    release();
  }
```

而外部写等待没有超时：

```ts
while (this.scopeGate) await this.scopeGate;
```

`writeRequest` 在 `product-state-repository.ts:770`，`runInTransaction` 在 `:801`。

与文档的冲突：`docs/adr/0240-capture-writes-in-one-transaction.md:80` 写“事务范围期间，别的写请求最多等 2 秒（默认）”。代码在回滚失败时是无限等待；ADR 决定 2 虽然写了“工作线程不响应就保持关闭”，但后果一节的“最多 2 秒”不成立。

另一个相关交互：如果 `COMMIT` 实际成功但响应丢失（worker 在提交后退出），`#save` 会通过 `backlog.has` 读到行已删除而按成功处理，数据正确；但写通道仍会因上述门闩泄漏而卡死。

建议：为 `scopeGate` 的等待加明确失败语义（例如回滚失败后把 repository 标记为不可恢复、让所有等待立即以“写通道已损坏”失败，而不是挂住）；或者引入可重建的写上下文。至少修正 ADR 的“最多等 2 秒”表述并补测试。

#### 2. 中：事务超时没有覆盖 `BEGIN IMMEDIATE` 和 `COMMIT`，实际上限不是 2 秒

文件：`packages/persistence-sqlite/src/product-state-repository.ts:810-833`

问题：计时器是在 `await this.context.request("transaction.begin", {})` **之后**才创建的；提交也没有被 `Promise.race` 覆盖。若 `BEGIN IMMEDIATE` 等待 busy 超时，或提交耗时，整个范围可以超过配置的 2 秒，且期间写通道一直被占住。

证据：

```ts
await this.context.request("transaction.begin", {});
const deadline = new Promise<never>((_resolve, reject) => {
  timer = setTimeout(() => { ... }, this.scopeTimeoutMs);
});
...
const result = await Promise.race([running, deadline]);
...
scope.ended = true;
await this.context.request("transaction.commit", {});
```

默认 busy 超时是 5 秒：

```ts
const busyTimeoutMs = validBusyTimeout(options.busyTimeoutMs ?? 5000);
```

（`product-state-repository.ts:246`，worker 在 `sqlite-worker.ts:121` 设置 `busy_timeout`。）

另外，若 `work` 已先完成、进入 `COMMIT` 后计时器才触发，它只拒绝一个已经不再参与竞速的 `deadline`，不会中断提交。

建议：把 begin 也纳入同一个截止时间；提交阶段若需要硬上限，应在 worker 层实现可中断/可取消；文档写清 2 秒只覆盖回调执行阶段还是整个范围。

#### 3. 中：`resolveSensitive` 的审计回调没有缓冲，仍可能在回滚后留下“已批准”日志

文件：`apps/agent-service/src/production-memory-control.ts:1045-1064`、`packages/application/src/services/automatic-memory-service.ts:388-405`

问题：作者说法“审计回调缓冲，提交成功后才发”只对 `ProductionMemoryCapture.#commit` 成立；敏感记忆批准路径直接把 `onAudit` 传进事务，`approval_committed` 在 `unitOfWork.run` 内、提交之前就发出。

证据：

```ts
onAudit: this.options.onAudit,
...
const committed = await this.options.unitOfWork.run(() =>
  resolver.resolveSensitive(...),
);
```

`resolveSensitive` 内部：

```ts
await this.options.approvals.markCommitted({...});
await this.options.audit.record({
  ...
  outcome: "approval_committed",
  ...
});
```

如果此后的 `COMMIT` 失败，数据库回滚，但审计日志已经写了“批准已提交”。这与 ADR 0240 决定 4“范围内先攒起来；回滚就丢掉”不一致。此外，审计回调是外部副作用，在事务内同步失败会直接导致整轮回滚。

建议：`resolveSensitive` 也使用与 capture 相同的缓冲：事务内只收集记录，`unitOfWork.run` 成功返回后再调用 `onAudit`；并补一条“提交失败时不发 approval_committed”的反向测试。

#### 4. 低：回滚后并非“整轮零残留”，`generations.request` 等写入在事务外

文件：`apps/agent-service/src/production-memory-capture.ts:1203-1234`、`:1268-1275`

问题：写记忆事务只包住 `processCommittedRun` 和 `backlog.remove`；登记 checkpoint 的 `generations.request` 在事务之前写出，回滚后保留。失败记录 `ledger.append` 也在事务外。ADR 0240:50 明确把登记行排除在外，所以这是有意的，但作者说法“回滚后整轮可以安全重试，不产生重复”需要限定为“记忆内容不重复”。

证据：

```ts
await this.options.generations.request({...});
return parsed;
...
await this.options.unitOfWork.run(async () => {
  await service.processCommittedRun({...});
  await backlog?.remove(plan.generationId);
});
```

由于 checkpoint 的 id 和身份是确定的，重试时 `request` 走已有身份分支，不会重复插入（`packages/persistence-sqlite/src/sqlite-checkpoint-operations.ts:281-300`，我读到身份冲突检查，但**没有核实** checkpoint worker 之后是否会因残留登记再次产出记忆）。

建议：文档把“回滚无残留”改成“记忆、历史、队列行无残留；checkpoint 登记保留且幂等”；若 checkpoint 残留可能触发后续独立抽取，需要补解释或清理策略。

#### 5. 低：放弃计数与界面“3 次”的表述不一致，实际最多尝试保存 6 次

文件：`apps/agent-service/src/production-memory-capture.ts:896-917`

问题：每次 `#save` 最多执行两次 `#commit`，两次都失败后才 `recordAttempt` 一次；`MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS = 3` 是按“每轮记录一次”计数。因此放弃前可能有最多 6 次实际提交失败，而三语文案说“3 次/3 tries”。

证据：

```ts
for (let attempt = 1; attempt <= SAVE_ATTEMPTS_PER_TURN; attempt += 1) {
  try {
    await this.#commit(plan, parsed);
    return;
  } catch (error) {
    failure = error;
    ...
  }
}
const attempts = await backlog.recordAttempt({...});
const gaveUp = attempts >= MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS;
```

建议：明确“3 次”指补做轮次还是实际保存次数；如果是轮次，在文案和 ADR 里写清每轮最多保存两次，避免用户以为只试了 3 次。

#### 6. 低：ADR 0240 的测试条数拆分写错

文件：`docs/adr/0240-capture-writes-in-one-transaction.md:83`

问题：ADR 写“production-memory-capture.test.ts 21 条，sqlite-transaction-scope.test.ts 13 条”。我核对到：`production-memory-capture.test.ts` 实际 15 条 `[P3-5]`，新事务测试 13 条，`memory-capture-backlog-migration.contract.test.ts` 还有 6 条；合计 34。ADR 把迁移契约的 6 条算进了 production 的 21 条，拆分不准确（总数 34 正确）。

建议：改为“production 15 条 + 事务范围 13 条 + 迁移契约 6 条 = 34 条”。

#### 7. 低：作者约束“范围外的读写在锁外等待”与代码不符，读并不等待

文件：`packages/persistence-sqlite/src/product-state-repository.ts:734-760`

问题：范围外的读`readRequest` 直接选一个只读上下文执行，不等待 `scopeGate`。这是合理的隔离设计（读到已提交快照），但说法应为“范围外的写等待；范围外的读走只读连接，看到已提交数据”。

证据：

```ts
private readRequest<TResult>(operation: string, payload: unknown): Promise<TResult> {
  const scope = this.scopes.getStore();
  if (scope) { ... return this.context.request(...); }
  let chosen = this.readContexts[0];
  ...
  return chosen.request<TResult>(operation, payload);
}
```

建议：修正文字；如果要证明不会读到未提交，保留并扩展现有隔离测试。

---

### 推测（未运行验证）

- 崩溃后写通道卡死会在生产表现为“读还能用、写永久挂起”；这是从代码路径推断的，**未用真实 worker 崩溃复现**。
- `BEGIN IMMEDIATE` 最坏会等到 5 秒 busy 超时；实际生产是否经常发生**未核实**。
- checkpoint 残留是否会导致“做梦记忆”路径再次产出记忆，**未核实**。

---

### 侧重检查：错误路径、不可信输入、安全、资源耗尽、不可撤销操作

- **超时**：代码会把范围内迟到调用拒绝为 `TRANSACTION_SCOPE_ENDED`（`assertScopeOpen`，`product-state-repository.ts:780-787`），新测试覆盖；但超时不覆盖 begin/commit，见问题 2。
- **回滚失败 / worker 崩溃**：`rollbackConfirmed=false` 时门闩永不释放，见问题 1；无测试覆盖。`stop()` 也只等待 pending，不会取消卡住的范围（**未核实**关闭流程如何处理）。
- **嵌套**：同一异步上下文中的 `runInTransaction` 直接加入外层而不重新提交，测试覆盖 `sqlite-transaction-scope.test.ts` 的 “joins a scope opened inside another scope”；逻辑正确。
- **SQLite 自行回滚**：`execute` 在每次操作前后检查 `transactionScopeOpen && !database.inTransaction`，提交前也检查；测试覆盖 `ROLLBACK` 后拒绝提交和后续写。逻辑正确。
- **迟到写入**：scope 结束后读/写都走 `assertScopeOpen`，超时测试覆盖迟到 enqueue 被拒绝；逻辑正确。
- **范围外读到未提交数据**：范围内读走写连接，范围外读走只读连接；测试断言事务内写入对范围外 `has` 不可见、提交后可见。WAL 下成立。**未核实**非 WAL/特殊 journal 模式的边界。
- **重试重复**：队列行在事务内移除，`has` 作为提交标记；`sqlite-transaction-scope` 和 production 测试覆盖“删行失败回滚后再保存只写一次”“两次删行失败不留下记忆/历史事件”。我未发现会重复写记忆或历史的路径。
- **资源耗尽**：失败重试会写队列行/失败决策记录，最多 3 次后移除；payload 写入走 `payloadStore`，也是同一个 SQLite 写通道，回滚会一并回滚（`durable-adapters.ts:302-305`）。残留只有 checkpoint 登记和失败记录，见问题 4。
- **不可信输入**：`lastErrorCode` 由 `SAVE_PENDING_CODE` 等常量产生，符合 `^[A-Z][A-Z0-9_]{0,127}$`；`enqueue`/`recordAttempt` 校验，`has`/`remove` 不校验 generationId，但该值由 `createMemoryGenerationId` 内部产生，未发现用户可控入口。`transaction.*` 操作名只在 repository 内部产生，worker 默认分发到 `SqliteDurableOperations.execute`。
- **不可撤销的 COMMIT**：提交成功后靠队列行移除判断已提交；响应丢失时 `#save` 会按成功处理，避免重复。但提交响应丢失若伴随 worker 退出，会触发问题 1 的门闩泄漏。
- **规则/文档一致性**：`docs/adr/0240` 与实现总体一致，但“最多等 2 秒”、审计缓冲范围、测试条数拆分、放弃次数表述存在偏差；`docs/adr/0222` 已正确追加 ADR 0240 的取代说明。

---

### 必答问题

#### 1. 会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果？

**读代码判断：不会改变主对话请求的任何字节。**

依据：

- 本 diff 没有改 `packages/prompt-catalog`、系统提示、工具定义、历史存储或遮盖逻辑；改动集中在记忆抽取完成后的写入、敏感批准、持久化事务和三语文案。
- 记忆抽取 prompt 在事务之前由 `#plan` 构造（`production-memory-capture.ts:1137-1144`），事务只发生在 `#commit`（`:1268`）里，模型调用已经结束。
- 事务内新增的值（`SAVE_PENDING_CODE`、审计 `occurredAt`、`TRANSACTION_*` reason）都不会进入任何发给模型的内容。
- 主请求仍然只在末尾追加：这个改动没有新增/修改/重排任何消息，符合 `.claude/rules/prompt-prefix.md` 第 4 条“只能追加”。

**未核实**：没有运行 `npm run check:prompt-prefix`，结论来自静态读代码。

#### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**主对话请求：没有发现新的非确定性来源。**

- 新增的事务不会改变存储的记忆文本、payload ref、历史消息序列化格式；这些值的产生逻辑没改。
- 新增加的 `occurredAt`、错误码、事务 reason 只进入审计/队列/错误对象，不进入 prompt。
- 没有新增无序集合参与拼装。

需要说明的间接影响：保存失败现在会留在队列，下一轮补做时会**重新问模型**，模型输出可能不同；这是记忆状态的变化，不是同一段请求文字被序列化成不同字节。这个重问在旧设计里对“排队”的轮次本来也存在，但本改动扩大了它适用的失败场景（原本保存失败直接放弃的轮次现在会补做）。如果严格要求“同一轮补做后记忆内容一致”，这一点需要额外设计；它不是 KV 前缀问题。

#### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有，覆盖基本成立，但有两个缺口。**

- `scripts/check-memory-capture-retry.mjs` 已纳入新测试文件，`REQUIRED=34`；我核对到实际 `[P3-5]` 数量为 production 15 + transaction scope 13 + migration 6 = 34，计数正确。
- `package.json:27,55` 显示 `check:memory-capture-retry` 属于 `npm run check`。
- 反向用例包括：抛错回滚、真实 SQLite 中途失败回滚、超时回滚并拒绝迟到写、嵌套回滚、SQLite 自行回滚后拒绝后续操作/提交、删行失败两次后不留下记忆与历史、敏感批准最后一步失败后回滚并可重新批准。
- 缺口 1：没有测试证明“事务回滚时审计回调不发出”。capture 的缓冲逻辑没有对应的失败用例；`resolveSensitive` 甚至根本没有缓冲。
- 缺口 2：没有测试覆盖“回滚请求本身失败 / worker 崩溃”时写通道的行为；这正是问题 1 的路径。
- 另有一个较弱的用例：`[P3-5] saves the memories and removes the queued row in one transaction...` 只断言最终一条记忆/一条历史；如果去掉事务，靠 `create` 的同 id 同内容复用分支也可能得到同样结果。真正能抓住回滚的是下一条“两次删行失败后什么都不留下”的用例。

**未核实**：没有实际运行这些测试，只核对了文件、计数和断言内容。

#### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐项核对如下：

- **`UnitOfWorkPort` / `unitOfWork` 选项**：生产构造点已传 `repository.unitOfWork()`（`production-run-composition.ts:518`、`production-http-composition.ts:1049`），测试构造点已补（`production-memory-capture.test.ts:247,292`、`decision-chain.test.ts:186`）。`production-memory-basis.unit.test.ts:54` 用 `as never` 构造，不受类型约束，但它不走批准路径，使用上可接受。实现只有 `SqliteProductStateRepository.unitOfWork`（`:789-791`）。
- **`MemoryCaptureBacklogPort.has`**：产生于 `durable-adapters.ts:1007`，消费于 `production-memory-capture.ts:885,903`；worker 路由 `sqlite-durable-operations.ts:626`，实现 `sqlite-memory-capture-backlog-operations.ts:46,133`。校验两端：`has`/`remove` 不校验 generationId，但调用方传的是内部 `createMemoryGenerationId` 结果；没有发现外部不可信输入能到达。可接受。
- **`SAVE_PENDING_CODE`**：`MEMORY_CAPTURE_SAVE_PENDING` 符合 `ERROR_CODE` 正则和 `enqueue` 校验（`sqlite-memory-capture-backlog-operations.ts:63`）；不会进入 `captureErrorCode` 的失败码路径（它只在抛出的错误上取码）。
- **`transaction.begin/commit/rollback` 操作名**：产生于 `product-state-repository.ts:811,833,838`，消费于 `sqlite-durable-operations.ts:536-557`；worker 走默认分支 `sqlite-worker.ts:1109`，没有白名单需要同步。可接受。
- **`TRANSACTION_SCOPE_TIMEOUT/ENDED/ABORTED` reason**：作为 `ApplicationPortError.details.reason` 产生，测试消费；`PortErrorCode` 只校验 `code`（`PORT_CONFLICT`），details 是自由 map。可接受。
- **`transactionScopeTimeoutMs`**：在 `SqliteProductStateRepository.open` 用 `validScopeTimeout` 校验 1~30000（`product-state-repository.ts:306-308`）；只出现在 repository option 和测试里，**没有接入 `service-main`/配置清单**。ADR 说“可配”，实际只能在程序化构造 repository 时配，未核实是否有上层配置入口。
- **三语 `captureGaveUp` 文案**：key 名未变，只改值；`proactive-interactions.unit.test.ts:629` 已同步，未发现其他断言旧文案的活动测试。旧文字仍出现在 ADR 0222 的历史正文里，属于历史记录，不是使用点。
- **`capture_queued`/`capture_gave_up` 决策结果**：schema 已有允许值，迁移契约测试的 `it.each` 覆盖三个 capture 结果（`memory-capture-backlog-migration.contract.test.ts:167-180`）。可接受。

**未核实**：`transactionScopeTimeoutMs` 在上层配置/部署里的实际可配性；checkpoint 残留对后续记忆抽取的影响。
