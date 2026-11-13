# 复核结论（9a58c3d5）

## 发现（按严重度从高到低）

### 1. 中：[证实] 保存前读队列失败会让整轮直接丢失
`apps/agent-service/src/production-memory-capture.ts:885`

问题：`#save` 在进入事务前先 `await backlog.has(...)`，只有为 false 才 `enqueue`。`has` 走只读连接；如果读连接不可用，异常会在任何写库尝试之前抛出，这一轮既不会被保存，也不会进队列（连 `capture_gave_up` 都没有）。而 `enqueue` 本来就是 `ON CONFLICT ... DO UPDATE`，不需要先读。

证据：
```ts
885: if (!(await backlog.has(plan.generationId)))
886:   await backlog.enqueue({ ... lastErrorCode: SAVE_PENDING_CODE ... });
```
`packages/persistence-sqlite/src/sqlite-memory-capture-backlog-operations.ts:77-78` 是 upsert：
```sql
ON CONFLICT (generation_id) DO UPDATE SET last_error_code = excluded.last_error_code, updated_at = ...
```
建议：包一层 `try { present = await backlog.has(...) } catch {}`，读失败也照样 `enqueue`；或直接无条件 `enqueue`（保留 attempts，最多覆盖 lastErrorCode）。这样写通道健康时不会因为读通道故障丢记忆。

### 2. 中：[证实] “回包丢失”的 unknown 分支会把已提交的保存当成失败，并丢掉审计
`apps/agent-service/src/production-memory-capture.ts:903-919`

问题：`backlog.has` 抛错时 `state === "unknown"`，跳出循环后仍调用 `recordAttempt`。如果事务其实已经提交（回包丢失）、队列行已被同一事务删除，`recordAttempt` 会因找不到行抛 `PORT_NOT_FOUND`，于是原始错误被覆盖、`#recordFailure` 不执行、`held` 审计永远不发。数据本身是对的，但审计和决策记录与事实不符。

证据：
```ts
903: const state = await backlog.has(plan.generationId).then(
904:   (queued) => (queued ? "queued" : "gone"),
905:   () => "unknown",
906: );
911: if (state === "unknown") break;
915: const attempts = await backlog.recordAttempt({ ... });
```
`packages/persistence-sqlite/src/sqlite-memory-capture-backlog-operations.ts:129`：
```ts
if (!row) return this.fail("PORT_NOT_FOUND", "Memory capture backlog entry not found");
```
建议：把 `recordAttempt` 的 `PORT_NOT_FOUND` 解释为“行已不在=已提交”，此时补发 `held` 审计并返回；或对 unknown 再做一次受控确认（见第 4 点对“提交标记”的建议）。

### 3. 中：[证实+推测] 仅凭“行不在”判定已提交，遇到级联删除会误判
`apps/agent-service/src/production-memory-capture.ts:907-909`

问题：代码把“队列行不存在”直接等同于“事务已提交”。但该行还会因 thread/owner/agent 被删除而级联删除（`packages/persistence-sqlite/src/migrations/0088_memory_capture_backlog.sql:244-246`）。如果在回滚之后、`has` 读取之前，用户删除了该对话，行会消失，失败的保存会被当成成功：误发 `auto_committed`/`kept` 审计、不再排队、记忆实际丢失。触发窗口很小，但这是把“行存在性”当作提交证明的固有限制（I-73 类问题：只验证了协议一端）。

证据：
```ts
907: if (state === "gone") {
908:   this.#emitAudits(held);
909:   return;
910: }
```
```sql
244: owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
245: agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
246: thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
```
建议：把提交证明换成不会被无关删除带走的标记（例如独立的、只在本事务写入的提交令牌/版本，或校验本应写入的记忆 id 是否都在），或至少在事务成功后由一个可靠通道回写结果，而不是靠可级联删除的业务行推断。

### 4. 低-中：[证实] 2 秒超时只覆盖回调；begin/commit/rollback 本身无上限，worker 挂住时写闸可能永不释放
`packages/persistence-sqlite/src/product-state-repository.ts:823-859`

问题：deadline 在 `transaction.begin` 之后才创建，`transaction.commit` 在 `Promise.race` 之后单独 await；catch 里的 `transaction.rollback` 也没有超时。worker 崩溃/关闭会 reject（测试覆盖），但 worker 只是“卡住”时，`await rollback` 永远不返回，`finally` 不执行，`scopeGate` 永不释放，之后所有写请求无限等待。另外 commit 阶段可超出 2 秒（最多受 busyTimeout 约束），作者“超时（默认 2 秒）回滚”的表述不完整，ADR 0240 第 49 行有更精确的限定。

证据：
```ts
823: await this.context.request("transaction.begin", {});
824: const deadline = new Promise<never>((_resolve, reject) => {
...
839: const result = await Promise.race([running, deadline]);
...
845: await this.context.request("transaction.commit", {});
...
847: } catch (error) {
850:   await this.context.request("transaction.rollback", {});
...
855: } finally {
858:   this.scopeGate = undefined;
859:   release();
```
建议：给 begin/commit/rollback 也加硬超时；rollback 超时或失败立即置 `scopeBroken` 并释放 `scopeGate`；文档里把“2 秒”明确为“回调执行”，或把总时长上限一起写清。

### 5. 低：[证实] 审计回调抛错且 onFailure 也抛错时，同一批审计会发两次
`apps/agent-service/src/production-memory-capture.ts:1243-1249`、`1296`、`907-908`

问题：`#commit` 在提交成功后 `#emitAudits`；`#emitAudits` 的 catch 直接调用 `this.options.onFailure` 而未再包一层。若 `onAudit` 抛错、`onFailure` 也抛错，`#commit` 会在提交已成功后抛错，`#save` 进入 `state === "gone"` 分支又 `#emitAudits(held)`，已发的记录会重复。

证据：
```ts
1243: #emitAudits(records) {
1244:   for (const record of records)
1245:     try { this.options.onAudit(record); }
1247:     catch (error) { this.options.onFailure(error); }
1248: }
...
1296: this.#emitAudits(audits);
```
建议：`onFailure` 再包一层 try/catch，或让 `#emitAudits` 返回“是否已发出”并在 gone 分支避免重复。

### 6. 低：[证实] 反向用例有缺口：读队列失败/提交后读失败没有测试
`test/integration/production-memory-capture.test.ts`

问题：新增的 `[P3-5]` 覆盖了回滚、超时迟到写、SQLite 自行回滚、worker 丢失、回包丢失、删除失败回滚等，但没有一条让 `backlog.has` 抛错（第 2、3 点涉及的 unknown 分支）。如果以后把 `state === "unknown"` 的判断改回去，`check:memory-capture-retry` 仍然全绿。另外“回包丢失”用例只断言 `activeMemories` 长度和审计非空，没有断言历史事件条数（重复历史不会被发现）。

证据：`test/integration/production-memory-capture.test.ts:3161-3178` 只包了 `unitOfWork` 的 `run`；全文件没有对 `backlog.has` 的替代实现（grep 仅见 `remove` 的替代，行 3459-3467）。

建议：补一条 `backlog.has` 抛错、断言“不再执行第二次 #commit、审计仍发出（若已提交）/不漏发”的用例；给回包丢失用例加 `listHistory` 长度断言。

### 7. 低：[证实] 文案/ADR 与代码措辞有轻微不一致
- 作者说法“累计 3 次失败才放弃”：代码里同一轮内部两次事务尝试只记 1 次 `recordAttempt`（`production-memory-capture.ts:915-920`），所以是“3 个失败轮次”，不是“3 次事务失败”。ADR 0240 第 53 行写清了“两次都失败才算一次”，顶层摘要没有。
- ADR 0240 第 53 行“满 3 次写 `capture_gave_up` 并出队”，但 `production-memory-capture.ts:959-965` 的补做入口读到已满 3 次的行时只删行、不写放弃记录；这一点只写在 ADR 0222 的后续说明里，ADR 0240 没写。

建议：把 ADR 0240 的决定 6 和后果部分补上“删除失败后重启、补做只删行不写记录”的例外，或统一到一处。

---

## 读代码证实的 / 推测的

**读代码证实的：**
- 事务范围确实覆盖 `processCommittedRun` 和 `backlog.remove`（`production-memory-capture.ts:1287-1294`）。
- 范围内读走写连接、范围外读走只读连接（`product-state-repository.ts:736-762`）。
- 队列行出队在同一事务内，事务回滚会恢复队列行（`1287-1294` + SQLite 事务）。
- 超时只 race `work`，不覆盖 begin/commit/rollback（`823-859`）。
- `has` 与 `SAVE_PENDING_CODE` 能通过 SQLite 校验：正则 `^[A-Z][A-Z0-9_]{0,127}$`，`last_error_code` 长度 1..128（`sqlite-memory-capture-backlog-operations.ts:6`、`0088_memory_capture_backlog.sql:249`）。
- 生产构造点都已接 `unitOfWork`：`production-run-composition.ts:518`、`production-http-composition.ts:1049`。
- 三种语言文案都已改，`proactive-interactions.unit.test.ts:629` 同步更新。
- 测试条数 18+15+6=39，与 `scripts/check-memory-capture-retry.mjs:14` 和 ADR 0240 第 83 行一致。

**推测（未在代码里看到反例，但未实测）：**
- 第 3 点的“删除对话与保存失败并发”窗口；未找到测试或串行化保证覆盖这种并发。
- 第 4 点的 worker“挂住但不退出”场景；`sqlite-execution-context.ts` 只在 worker 退出/报错时 `failAll`，没有单请求超时，所以理论上 rollback 可永久挂起。
- `onFailure` 真会抛错导致第 5 点重复审计；实际生产 `onFailure` 是写诊断日志，通常不抛。

---

## 侧重检查（错误路径、不可信输入、安全、资源、不可逆操作、文档一致性）

- **超时/迟到写**：`scope.ended` 在定时器触发时同步置位，迟到读写被 `TRANSACTION_SCOPE_ENDED` 拒绝；已有测试 `sqlite-transaction-scope.test.ts:150-171`。通过。
- **嵌套事务**：内层直接 join 外层，不提前提交；测试 `139-148`。通过。
- **worker 崩溃/关闭**：`context.request` 在 `exited` 后 reject，rollback 失败置 `scopeBroken`，后续写立即报 `TRANSACTION_ROLLBACK_UNCONFIRMED`；测试 `205-224`。通过（“挂住”除外，见第 4 点）。
- **SQLite 自行回滚（如 SQLITE_FULL）**：`execute` 前后检查 `inTransaction`，commit 被拒；测试 `226-284`。通过。
- **回滚残留**：测试覆盖单次回滚、失败删除回滚、放弃后无残留（`3498-3527`），历史事件只写一次（`3473-3496`）。通过。
- **重试重复**：提交成功但回包丢失时不再重跑事务（`3161-3178`）；正常失败重试走同一份已解析结果、不重新问模型（`3405-3426`）。通过，但 unknown 分支见第 2 点。
- **范围外读者读到未提交数据**：只读连接 + WAL 快照，测试断言提交前外部 `has` 为 false（`86-102`）。通过。
- **不可信输入/注入**：`has`、`remove`、`recordAttempt` 全部参数化 SQL；`enqueue` 校验 generationId/sourceRunId/错误码/时间，未发现注入面。`has` 本身不校验长度，但只在内部调用且参数化，风险低。
- **资源耗尽**：每轮最多两次事务尝试，每次最长 2 秒；最坏约 4 秒占写通道，符合设计。提交阶段可额外占用到 busyTimeout（见第 4 点）。
- **不可逆操作**：没有新增表或破坏性迁移；提醒/人物/载荷写入都在事务内，回滚会撤销；`generations.request` 登记行按 ADR 有意保留。
- **规则/文档/代码一致性**：`prompt-prefix.md` 相关部分未被触及；ADR 0240、0222、schema-catalog、三语文案与代码基本一致，只有第 7 点的措辞差异。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只发生在模型调用返回之后：`#commit` 用 `unitOfWork.run` 包住 `processCommittedRun` 和 `backlog.remove`（`production-memory-capture.ts:1287-1294`），没有改系统提示、工具定义、历史组装、遮盖或请求序列化；本轮变化值（选中的记忆、时间）仍按原逻辑只在最后一条用户消息里。唯一的行为差异是“以前可能存下半轮，现在要么全存要么全不存”，这会影响下一轮最后一条消息里注入的记忆内容，但仍在末尾，不在请求开头。审计里的 `occurredAt` 不进入模型请求（`service-main.ts:2486-2493` 只写诊断日志）。

**2. 同一段文字会不会在不同请求里变成不同字节？**
就发给模型的内容而言不会。没有新增每轮变化的字段到提示；记忆 id 仍是 `memory:<generation>:<ordinal>` 等确定性值（ADR 0240 前提 3）。新增的时间值只出现在审计记录（`#commit` 的 `note`）和决策记录中，且同一事务只发一份；它们不参与请求序列化。需要注意的是：如果将来有人把审计写进提示，`occurredAt` 随尝试时刻变化，就会违反字节确定性；当前没有这种使用。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有：`npm run check:memory-capture-retry` 要求 39 条 `[P3-5]` 通过，删掉任意一条会因数量不足失败；回滚、超时迟到写、SQLite 自行回滚、worker 丢失、删除失败回滚、回包丢失后不重跑等反向用例都会在对应行为退化时失败。缺口是 round-3 的“读队列失败不再重试”没有用例：没有测试让 `backlog.has` 抛错，回归时脚本不会失败；回包丢失用例也没有断言历史事件不重复（见第 6 点）。

**4. 改变/新增的每个值，产生方与使用方两端都能接受吗？**
- `SAVE_PENDING_CODE = "MEMORY_CAPTURE_SAVE_PENDING"`：生产方 `production-memory-capture.ts:892`，使用方 SQLite `enqueue` 的正则（`sqlite-memory-capture-backlog-operations.ts:6,63`）和表约束 `length 1..128`（迁移 249 行）都接受，长度 27。
- `has(generationId)`：新端口方法（`ports/memory-capture-backlog.ts:29`），唯一实现 `durable-adapters.ts:1007` 走读连接，SQLite 侧 `memoryCaptureBacklog.has`（`sqlite-memory-capture-backlog-operations.ts:46-47,133-139`）参数化查询；没有其他 fake 实现遗漏。
- `UnitOfWorkPort` / `unitOfWork`：两个生产构造点都传入 `repository.unitOfWork()`；测试 `optionsOf` 也带；`unitOfWork()` 只在具体类 `SqliteProductStateRepository` 上，未加到 `ProductStateRepositoryPort`，但所有消费者都用具体类型，类型上自洽。
- `transactionScopeTimeoutMs`：在 `open` 里、启动 worker 之前用 `validScopeTimeout` 校验（1..30000 整数），有测试证明非法值不会启动 `SqliteExecutionContext.start`（`sqlite-transaction-scope.test.ts:187-203`）。
- 四种新错误原因（`TRANSACTION_SCOPE_ENDED/TIMEOUT/ABORTED/ROLLBACK_UNCONFIRMED`）只放在 `ApplicationPortError.details.reason`，生产消费方按错误码处理，测试按 reason 断言，没有发现两端校验不匹配。
- `capture_gave_up`/`capture_queued` 三语文案与单测同步更新；ADR 0240、0222、schema-catalog 的描述与代码行为一致（除第 7 点措辞）。
