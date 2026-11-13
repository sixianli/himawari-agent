CLAIM|1|一致|docs/adr/0222-retry-and-queue-failed-memory-capture.md:56|ADR 0222 决定 4 规定“写记忆失败直接放弃，不重试”|4. **写记忆失败时不重试、不排队，直接写“放弃”。**
CLAIM|2|一致|apps/control-center/src/i18n/resources/zh-CN.ts:1004|“可能已存下一部分”这句界面文字本 ADR 已经改掉|"这轮对话的记忆补做了 3 次仍没成功（抽取或保存都算），这一轮没有记下任何内容，系统不再重试",
CLAIM|3|一致|packages/persistence-sqlite/src/sqlite-execution-context.ts:109|写库在一个 worker 线程里执行|const worker = new Worker(new URL(`./sqlite-worker${workerExtension}`, import.meta.url), {
CLAIM|4|一致|packages/persistence-sqlite/src/sqlite-worker.ts:1109|写库同步执行|value = durableOperations.execute(request.operation, request.payload);
CLAIM|5|一致|packages/persistence-sqlite/src/sqlite-execution-context.ts:145|每个端口调用是一条消息：`request`|this.worker.postMessage({ id, operation, payload });
CLAIM|6|一致|packages/persistence-sqlite/src/durable-adapters.ts:907|记忆读走 `memory.read`|read: (memoryId) => this.context.read("memory.read", { memoryId }),
CLAIM|7|一致|packages/persistence-sqlite/src/product-state-repository.ts:303|记忆读走只读连接|readOnly: true,
CLAIM|8|一致|packages/persistence-sqlite/src/durable-adapters.ts:912|写走 `memory.saveWithProjection`|saveWithProjection: (input) => this.context.write("memory.saveWithProjection", input),
CLAIM|9|一致|packages/persistence-sqlite/src/product-state-repository.ts:241|写走写连接|write: (operation, payload) => this.writeRequest(operation, payload),
CLAIM|10|一致|apps/agent-service/src/production-memory-capture.ts:610|所有 id 已是确定的：`memory:<生成编号>:<序号>`|memoryIdFor: (generation, ordinal) => createMemoryId(`memory:${generation}:${ordinal}`),
CLAIM|11|一致|apps/agent-service/src/production-memory-capture.ts:589|载荷 ref 已是确定的|const ref = `memory-content:${stored.contentKey}`;
CLAIM|12|一致|packages/application/src/services/automatic-memory-service.ts:489|载荷 ref 的 contentKey 由生成编号和序号组成|contentKey: `${input.generationId}:${candidateOrdinal}`,
CLAIM|13|一致|apps/agent-service/src/production-memory-capture.ts:713|决策记录 id 已是确定的|return `ledger:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
CLAIM|14|一致|apps/agent-service/src/production-memory-capture.ts:619|提醒 id 是 `reminder:<记忆>`|id: `reminder:${memoryId}`,
CLAIM|15|一致|packages/application/src/services/durable-memory-service.ts:136|`create` 遇到同 id 同内容直接复用|if (sameProposal) {
CLAIM|16|一致|apps/agent-service/src/production-memory-capture.ts:1292|提交阶段没有模型调用|extract: async () => parsed.candidates,
CLAIM|17|一致|apps/agent-service/src/production-memory-capture.ts:1292|`extract` 是返回已解析候选的闭包|extract: async () => parsed.candidates,
CLAIM|18|一致|packages/application/src/ports/unit-of-work.ts:2|写通道上提供 `UnitOfWorkPort.run`|run<TResult>(work: () => Promise<TResult>): Promise<TResult>;
CLAIM|19|一致|packages/persistence-sqlite/src/product-state-repository.ts:845|实现是 `SqliteProductStateRepository.runInTransaction`|return Object.freeze<UnitOfWorkPort>({ run: (work) => this.runInTransaction(work) });
CLAIM|20|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:556|开始时在写连接上 `BEGIN IMMEDIATE`|this.database.exec("BEGIN IMMEDIATE");
CLAIM|21|一致|packages/persistence-sqlite/src/product-state-repository.ts:815|范围外的写请求排队等它结束|while (this.scopeGate) await this.scopeGate;
CLAIM|22|一致|packages/persistence-sqlite/src/product-state-repository.ts:774|范围内的读改走写连接|return this.context.request<TResult>(operation, payload);
CLAIM|23|一致|packages/persistence-sqlite/src/product-state-repository.ts:835|范围结束后范围内的读写一律报错|private assertScopeOpen(scope: TransactionScope): void {
CLAIM|24|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:580|工作线程每次操作前后核对事务还在|if (this.transactionScopeOpen && !this.database.inTransaction) this.transactionScopeAborted();
CLAIM|25|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:561|SQLite 自行回滚时拒绝后续操作和提交|if (this.transactionScopeLost || !this.transactionScopeOpen || !this.database.inTransaction)
CLAIM|26|一致|packages/persistence-sqlite/src/product-state-repository.ts:893|超时后先发 `ROLLBACK`、确认完成才放开写通道|await this.context.request("transaction.rollback", {});
CLAIM|27|一致|packages/persistence-sqlite/src/product-state-repository.ts:831|回滚没有得到确认时写通道保持关闭，原因 `TRANSACTION_ROLLBACK_UNCONFIRMED`|{ reason: "TRANSACTION_ROLLBACK_UNCONFIRMED" },
CLAIM|28|一致|packages/persistence-sqlite/src/product-state-repository.ts:142|上限默认 2 秒|export const DEFAULT_TRANSACTION_SCOPE_TIMEOUT_MS = 2000;
CLAIM|29|一致|packages/persistence-sqlite/src/product-state-repository.ts:259|开始和提交两步各自受 SQLite 忙等待上限（默认 5 秒）约束|const busyTimeoutMs = validBusyTimeout(options.busyTimeoutMs ?? 5000);
CLAIM|30|一致|packages/persistence-sqlite/src/product-state-repository.ts:138|选项 `transactionScopeTimeoutMs` 可配|readonly transactionScopeTimeoutMs?: number;
CLAIM|31|一致|packages/persistence-sqlite/src/product-state-repository.ts:904|范围总时长超过 500 毫秒进慢操作日志|if (this.onSlowScope && totalMs >= SLOW_SCOPE_MILLISECONDS) {
CLAIM|32|一致|apps/agent-service/src/production-memory-capture.ts:1299|`processCommittedRun` 和出队（`backlog.remove`）在同一个范围里|await this.options.unitOfWork.run(async () => {
CLAIM|33|一致|apps/agent-service/src/production-memory-capture.ts:1305|出队失败让整轮失败|await backlog?.remove(plan.generationId);
CLAIM|34|一致|apps/agent-service/src/production-memory-control.ts:1188|“批准敏感记忆后提交”（`resolveSensitive`）放进范围|const committed = await this.options.unitOfWork.run(() =>
CLAIM|35|一致|apps/agent-service/src/production-memory-control.ts:1195|`resolveSensitive` 的审计日志提交成功后才发|for (const record of buffered)
CLAIM|36|一致|apps/agent-service/src/production-memory-capture.ts:1221|登记这次生成的行（`generations.request`）在抽取之后、写记忆之前单独写|await this.options.generations.request({
CLAIM|37|一致|apps/agent-service/src/production-memory-control.ts:1172|审计日志在范围内先攒起来|const buffered: MemoryExtractionAuditRecord[] = [];
CLAIM|38|一致|apps/agent-service/src/production-memory-control.ts:1188|回滚就丢掉审计日志|const committed = await this.options.unitOfWork.run(() =>
CLAIM|39|一致|apps/agent-service/src/production-memory-control.ts:1165|敏感批准那条路没有队列行可以判断“提交成功但回包丢失”|if (command.type === "memory.approval.respond") {
CLAIM|40|一致|apps/agent-service/src/production-memory-capture.ts:912|同轮保存读不到队列时只保存一次，不再重试|if (state === "unknown") break;
CLAIM|41|一致|packages/persistence-sqlite/src/product-state-repository.ts:745|关闭仓库时先等进行中的范围结束|while (this.scopeGate) await this.scopeGate;
CLAIM|42|一致|apps/agent-service/src/production-memory-capture.ts:886|开始写之前先确保待补队列里有这一轮（没有就入队）|if (!(await backlog.has(plan.generationId).catch(() => false)))
CLAIM|43|一致|apps/agent-service/src/production-memory-capture.ts:908|队列里没有这一轮，就等于已提交|if (state === "gone") {
CLAIM|44|一致|apps/agent-service/src/production-memory-capture.ts:908|写失败后先查队列，不在就当作成功|if (state === "gone") {
CLAIM|45|一致|apps/agent-service/src/production-memory-capture.ts:900|写失败先用同一份已解析的结果再存一次（不再问模型）|await this.#commit(plan, parsed, held);
CLAIM|46|一致|apps/agent-service/src/production-memory-capture.ts:918|仍失败就留在队列并记一次补做|.recordAttempt({
CLAIM|47|一致|packages/application/src/ports/memory-capture-backlog.ts:3|补做和存失败共用最多 3 次|export const MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS = 3;
CLAIM|48|一致|apps/agent-service/src/production-memory-capture.ts:930|满 3 次写 `capture_gave_up` 并出队|const gaveUp = attempts >= MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS;
CLAIM|49|一致|apps/agent-service/src/production-memory-capture.ts:700|每一轮内部最多保存两次，两次都失败才算一次|const SAVE_ATTEMPTS_PER_TURN = 2;
CLAIM|50|一致|apps/agent-service/src/production-memory-capture.ts:973|放弃后删行失败又遇到重启时，补做只删行、不再写放弃记录|await backlog.remove(entry.generationId);
CLAIM|51|一致|apps/agent-service/src/production-memory-capture.ts:1019|每次失败写一条决策记录|await this.options.ledger.append({
CLAIM|52|一致|apps/agent-service/src/production-memory-capture.ts:1026|决策记录的原因码是错误码|reasonCode: errorCode.slice(0, 64),
CLAIM|53|一致|apps/agent-service/src/production-memory-capture.ts:1020|决策记录 id 带第几次|id: captureLedgerId(`${plan.generationId}:${outcome}:${attempt}`),
CLAIM|54|一致|apps/control-center/src/i18n/resources/zh-CN.ts:1004|三语界面里 `capture_gave_up` 的说明改为“这一轮没有记下任何内容”|"这轮对话的记忆补做了 3 次仍没成功（抽取或保存都算），这一轮没有记下任何内容，系统不再重试",
CLAIM|55|一致|package.json:55|`npm run check:memory-capture-retry` 存在|"check:memory-capture-retry": "node scripts/check-memory-capture-retry.mjs",
CLAIM|56|一致|scripts/check-memory-capture-retry.mjs:14|`npm run check:memory-capture-retry` 运行带 `[P3-5]` 的 42 条测试|const REQUIRED = 42;
CLAIM|57|一致|test/integration/production-memory-capture.test.ts:1090|`test/integration/production-memory-capture.test.ts` 19 条|it("[P3-5] rolls a sensitive approval back completely when its last write fails, and lets the Owner approve it again", async () => {
CLAIM|58|一致|test/integration/sqlite-transaction-scope.test.ts:68|`test/integration/sqlite-transaction-scope.test.ts` 17 条|describe.each(["worker", "direct"] as const)(
CLAIM|59|一致|test/integration/sqlite-transaction-scope.test.ts:34|真实性：真实 SQLite|const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
CLAIM|60|一致|test/integration/sqlite-transaction-scope.test.ts:68|工作线程和进程内两种方式|describe.each(["worker", "direct"] as const)(
CLAIM|61|一致|test/integration/sqlite-transaction-scope.test.ts:118|含回滚|it("rolls every write of the scope back when it throws, and the next write is not affected", async () => {
CLAIM|62|一致|test/integration/sqlite-transaction-scope.test.ts:163|含超时|it("rolls back on timeout, refuses the late writes of the still-running work, and frees the write lane", async () => {
CLAIM|63|一致|test/integration/sqlite-transaction-scope.test.ts:73|含隔离|it("commits every write of the scope together, lets the scope read its own writes, and hides them from outside readers until commit", async () => {
CLAIM|64|一致|test/integration/sqlite-transaction-scope.test.ts:239|含被 SQLite 自行回滚|describe("[P3-5] transaction scope when SQLite rolls the transaction back by itself", () => {
CLAIM|65|一致|test/integration/sqlite-transaction-scope.test.ts:218|含工作线程丢失|describe("[P3-5] transaction scope when the database worker is lost", () => {
CLAIM|66|一致|packages/persistence-sqlite/test/memory-capture-backlog-migration.contract.test.ts:167|`packages/persistence-sqlite/test/memory-capture-backlog-migration.contract.test.ts` 6 条|it.each(["capture_retrying", "capture_queued", "capture_gave_up"])(
CLAIM|67|找不到|-|做梦记忆（PR 395）里“重试时补做取代”的补丁|-
CLAIM|68|找不到|-|一轮正常的写库是毫秒级|-
CLAIM|69|一致|apps/agent-service/src/production-memory-capture.ts:984|写失败的重试会多花几次后台模型调用（补做要重新抽取）|parsed = await this.#prepare(plan, onAdmitted, {

未核对的部分：背景里“以前这些是十几次各自独立的写库调用”这一历史说法；PR 395“重试时补做取代”的补丁在当前检出中未找到对应实现；“一轮正常的写库是毫秒级”没有实测证据。
