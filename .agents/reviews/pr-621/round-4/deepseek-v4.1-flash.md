范围：本轮 `git diff 90dc397ce..52a49dbe3` 实际只有两部分：`d3aa5ab9d`（PR 621 第 3 轮修复，改 `production-inbox-worker.ts` 和 `inbox.test.ts`）以及把 `origin/main`（`c912aa8ce`，即 PR 617，已在 PR 617 第 1–4 轮复核）合进来。两者没有交叉改动：合并没有改 PR 621 的收件箱文件，只把 PR 617 的安静时段/推送接线叠到 `production-http-composition.ts`、`service-main.ts` 等文件上。下面只重读与第 3 轮意见和这些增量行有关的代码；证据指向旧代码时跟到旧代码。

### 1. 中：yield 后同一轮检查里仍会把同一批再交一次，测试反而把“最多两次”当成通过标准
文件：`apps/agent-service/src/production-inbox-worker.ts:291-307`、`test/integration/inbox.test.ts:509-536`
问题：修复做到了“yield 后不再自己叫醒”（`:302` 只在非 yield 时 `wake()`），但同一轮 `#tick` 的 claim 循环里，是在**已经启动第二次 `handle` 之后**才检查同一个对话是否取过（`:305-307`）。而 `handle` 的 yield 分支会先把条目放回队列（`:194-196` `store.release(... countAttempt: false)`），所以紧接着的下一次 `claim()` 完全可能再取回同一批。作者说“yielded events wait for the next idle check or a new write”并不完全成立：同一轮里还会多投递一次。
证据（读代码证实）：
```
291 const handling: Promise<void> = this.#worker
292   .handle(claim, signal)
...
302   if (!yielded) this.wake();
305 const conversation = `${claim.fromOwner}:${claim.threadId ?? ""}`;
306 if (started.has(conversation)) break;
307 started.add(conversation);
```
测试自己锁定了两次：
```
534 expect(handles).toBeLessThanOrEqual(2);
535 expect(claims).toBeLessThanOrEqual(2);
```
用桩时必然发生；真实 SQLite 里是否发生取决于第一次 `handle` 的 release 和下一次 `claim()` 谁先完成（`claimBatch` 只有在该对话没有 `running` 行时才返回，见 `packages/persistence-sqlite/src/sqlite-inbox-operations.ts:229-236`），所以生产里是**可能发生**，属于推测；桩和测试里的两次是证实的。
建议：把重复检查放到启动 `handle` 之前；发现已经取过就释放这次 claim（需要暴露一个 release，或给 `claimBatch` 加“排除这些对话”的参数）再退出本轮，而不是先投递再 break。测试应断言一轮最多投递一次（`handles === 1`），并加一条“同一轮第二次 claim 不得再投递”的反向用例。

### 2. 低：上一轮“可无上限并发处理”没有被增量改到，跨对话仍可一次起任意多个 handle
文件：`apps/agent-service/src/production-inbox-worker.ts:291-307`、`:319-326`
问题：`#tick` 仍然是启动一个 `handle` 后不等待就继续 `claim`，`#inflight` 只用来删除和 `stop()` 时等待（`:301`、`:304`、`:325`），没有任何并发上限。新加的 `started` 只把同一个对话限制到“最多两次”，不同对话的数量不受限。
证据（读代码证实）：`handling` 创建后立即 `this.#inflight.add(handling)`，循环继续取下一批，没有 `await handling` 或计数上限。设计文档 `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:437` 明确“让不同对话的批次同时处理”，`:265` 又说服务器最多同时跑 3 趟，所以这一条风险低，不一定是缺陷；但第 3 轮意见的前半句确实没有改。
建议：若保持设计上的跨对话并发，可在文档或测试里写明“批次并发由运行调度器最多 3 趟兜底”；否则给 `#inflight` 加一个对话数量上限，超过时先不 claim。

### 3. 低（推测）：重复对话时直接 break 整个 claim 循环，持续 yield 的高优先对话可能挡住其他对话
文件：`apps/agent-service/src/production-inbox-worker.ts:306`、`packages/persistence-sqlite/src/sqlite-inbox-operations.ts:236`、`:248`
问题：`started` 命中后不是“跳过这个对话”，而是 `break` 整个取件循环。`claimBatch` 每次按 `priority, created_at, rowid` 取优先级最高的对话；如果这个优先级最高的对话每次都在下一次 claim 之前 yield 并 release，那么每一轮都会重新取到它、第二次取到后 break，后面优先级更低的对话永远轮不到，直到这个对话不再 yield。
证据（读代码证实）：`break` 在 `:306`；`ORDER BY queued.priority, queued.created_at, queued.rowid` 在 `sqlite-inbox-operations.ts:236`，同对话条目也是 `ORDER BY created_at, rowid`（`:248`）。
推测（未核实）：是否真的长期挡住取决于 release 与下一次 claim 的时序、以及 delivery 的 yield 是否会一直持续；设计里“等主人同意”的子线程可能长期 yield，所以有现实可能。
建议：只跳过已取过的对话，继续取其他对话；或者让 `claimBatch` 接受排除集合。不要用一个 `break` 把整个队列停掉。

**侧重检查**

- 错误路径：`handle` 的 `catch`（`production-inbox-worker.ts:200-214`）在 `signal.aborted` 时 `release(countAttempt:false)`，其他错误按 `putBack(true, "delivery_failed")` 重试，和作者说法 2 一致；增量里的拒绝分支 `:295-298` 记 `#fail` 后返回 `false`，非 aborted 时会 `wake()`，不会丢尝试。未发现新错误路径泄漏。
- 不合规范/不可信输入：增量没有新增外部输入。`started` 的 key 只由 `claim.fromOwner` 和已经过长度校验的 `threadId` 拼成，只存在内存里，没有注入或落库问题。
- 安全/不可撤销操作：增量没有新增文件、网络、删除或不可逆操作。
- 资源耗尽：见意见 2；跨对话 handle 数量不受限，`runTimeoutMs` 是每个运行自己的超时，不会限制等待中的 handle 数量。
- 规则/说明与代码一致性：增量自身没有改提示词、工具、历史或遮盖；不一致在于提交说明“yield 后等下一次空闲检查或新写入”和代码里同一轮仍会再投递一次（意见 1）。`docs/architecture-v0.1.md:437` 的“不同对话同时处理、空闲兜底”与代码一致。
- 附带核对作者整份说法（只快速验证，未重读全部旧代码）：说法 1 与 `sqlite-inbox-operations.ts:229-253` 一致；说法 2 与 `production-inbox-worker.ts:143-151`、`:200-214` 一致；说法 3 与 `production-inbox.ts:240-245`、`:282` 一致；说法 4 与迁移 SQL 的 `CASE status`/`CASE status ... outcome` 一致（`proposed→done/proposed`，`skipped/expired→done/silent`，`thinking→queued`）。说法 5 在现有工作树里 grep 不到被删服务的引用，但仓库是 54% 稀疏检出，且不能运行 typecheck/lint，只能标“未完全核实”。

**必答问题**

1. **不改变模型已经见过的请求开头。** 本轮增量只改处理循环的调度，没有碰系统提示、工具定义、历史消息、遮盖或压缩；发给模型的内容仍然只在末尾追加。即使将来重复投递导致同样的事件被写两次，也是追加到末尾，不会改请求开头。
2. **不会让同一段文字在不同请求里变成不同字节。** 增量没有改任何序列化、遮盖或带时间的字段；`started` 只是进程内集合，不参与模型请求。
3. **有自动检查，但反向覆盖不完整。** 新测试 `inbox.test.ts:509-536` 能在撤掉“yield 不自唤醒”或 `started` 检查时失败/挂住，这一点成立；但它把“同一批处理两次”作为通过条件（`<= 2`），没有断言“只投递一次”，也没有覆盖跨对话并发上限。我没有运行测试，以上是按代码推演。
4. **增量没有产生或修改对外的标识、字段、配置键、清单项或序列化格式。** 新加的 `started`、`conversation`、`handling` 都只在 `InboxLoop` 内部；`handle` 的返回值契约仍是同一文件的 `InboxWorkStep`（生产端 `:194-196` 返回 `status:"done", result:"yield"`，消费端 `:294` 读取 `status/result`，测试桩也按这个形状返回），两端一致。直接使用 `InboxLoop` 的只有 `production-inbox-composition.ts:63-75`，本次增量未改它。合并进来的 PR 617 值不在本 PR 范围内，也没有和收件箱文件交叉，未重审。
