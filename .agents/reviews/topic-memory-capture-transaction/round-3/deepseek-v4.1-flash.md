CLAIM|1|一致|docs/product-vision.md:55|依据产品愿景的“记忆可靠性”|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*
CLAIM|2|一致|apps/agent-service/src/production-memory-capture.ts:589|载荷（记忆内容、引用原话）|        const ref = `memory-content:${stored.contentKey}`;
CLAIM|3|一致|packages/application/src/services/durable-memory-service.ts:628|记忆行和历史|    return this.options.state.saveWithProjection({
CLAIM|4|一致|packages/application/src/services/durable-memory-service.ts:167|取代旧记忆|      if (proposal.supersedes) await this.supersede(proposal.supersedes, saved, generationId);
CLAIM|5|一致|packages/application/src/services/automatic-memory-service.ts:621|决策记录|    await this.options.ledger.append(write);
CLAIM|6|一致|apps/agent-service/src/production-memory-capture.ts:617|提醒|              await this.options.reminders.schedule({
CLAIM|7|一致|apps/agent-service/src/production-memory-capture.ts:629|人物|        await this.options.book.recordPeople({
CLAIM|8|一致|packages/application/src/services/automatic-memory-service.ts:416|待批准请求|    const request = await this.options.approvals.create({
CLAIM|9|一致|apps/agent-service/src/production-memory-capture.ts:1305|出队|        await backlog?.remove(plan.generationId);
CLAIM|10|一致|docs/adr/0222-retry-and-queue-failed-memory-capture.md:56|ADR 0222 决定 4 因此规定“写记忆失败直接放弃，不重试”|4. **写记忆失败时不重试、不排队，直接写“放弃”。**
CLAIM|11|不一致|apps/control-center/src/i18n/resources/zh-CN.ts:1004|并在界面上写“可能已存下一部分”|    "这轮对话的记忆补做了 3 次仍没成功（抽取或保存都算），这一轮没有记下任何内容，系统不再重试",
CLAIM|12|一致|packages/application/src/services/durable-memory-service.ts:140|做梦记忆线程（PR 395）为补做取代加的“重试时补做”|              await this.supersede(proposal.supersedes, existing, generationId);
CLAIM|13|一致|packages/persistence-sqlite/src/sqlite-worker.ts:1109|写库在一个 worker 线程里同步执行|        value = durableOperations.execute(request.operation, request.payload);
CLAIM|14|一致|packages/persistence-sqlite/src/sqlite-execution-context.ts:145|每个端口调用是一条消息：`packages/persistence-sqlite/src/sqlite-execution-context.ts` 的 `request`|      this.worker.postMessage({ id, operation, payload });
CLAIM|15|一致|packages/persistence-sqlite/src/product-state-repository.ts:303|记忆读走只读连接|            readOnly: true,
CLAIM|16|一致|packages/persistence-sqlite/src/product-state-repository.ts:241|写走写连接|      write: (operation, payload) => this.writeRequest(operation, payload),
CLAIM|17|一致|packages/persistence-sqlite/src/durable-adapters.ts:907|`packages/persistence-sqlite/src/durable-adapters.ts` 的 `memory.read`|      read: (memoryId) => this.context.read("memory.read", { memoryId }),
CLAIM|18|一致|packages/persistence-sqlite/src/durable-adapters.ts:912|`packages/persistence-sqlite/src/durable-adapters.ts` 的 `memory.saveWithProjection`|      saveWithProjection: (input) => this.context.write("memory.saveWithProjection", input),
CLAIM|19|一致|apps/agent-service/src/production-memory-capture.ts:610|所有 id 已是确定的（`memory:<生成编号>:<序号>`）|    memoryIdFor: (generation, ordinal) => createMemoryId(`memory:${generation}:${ordinal}`),
CLAIM|20|一致|packages/application/src/services/automatic-memory-service.ts:489|所有 id 已是确定的（载荷 ref）|      contentKey: `${input.generationId}:${candidateOrdinal}`,
CLAIM|21|一致|packages/application/src/services/automatic-memory-service.ts:574|所有 id 已是确定的（决策记录 id）|      id: ledgerId(`${input.generationId}:${candidateOrdinal}:${outcome}:${reasonCode}`),
CLAIM|22|一致|apps/agent-service/src/production-memory-capture.ts:619|所有 id 已是确定的（`reminder:<记忆>`）|                id: `reminder:${memoryId}`,
CLAIM|23|一致|packages/application/src/services/durable-memory-service.ts:136|`create` 遇到同 id 同内容直接复用|        if (sameProposal) {
CLAIM|24|一致|packages/application/src/services/durable-memory-service.ts:101|`packages/application/src/services/durable-memory-service.ts` 的 `applyProposal`|  async applyProposal(
CLAIM|25|一致|apps/agent-service/src/production-memory-capture.ts:1292|提交阶段没有模型调用|        extract: async () => parsed.candidates,
CLAIM|26|一致|apps/agent-service/src/production-memory-capture.ts:1292|`apps/agent-service/src/production-memory-capture.ts` 里 `extract` 是返回已解析候选的闭包|        extract: async () => parsed.candidates,
CLAIM|27|一致|package.json:55|`npm run check:memory-capture-retry`|    "check:memory-capture-retry": "node scripts/check-memory-capture-retry.mjs",
CLAIM|28|一致|scripts/check-memory-capture-retry.mjs:8|现在运行带 `[P3-5]` 的测试|const TAG = "[P3-5]";
CLAIM|29|一致|scripts/check-memory-capture-retry.mjs:14|42 条测试|const REQUIRED = 42;
CLAIM|30|一致|test/integration/production-memory-capture.test.ts:1090|`test/integration/production-memory-capture.test.ts` 19 条|  it("[P3-5] rolls a sensitive approval back completely when its last write fails, and lets the Owner approve it again", async () => {
CLAIM|31|一致|test/integration/sqlite-transaction-scope.test.ts:68|`test/integration/sqlite-transaction-scope.test.ts` 17 条|describe.each(["worker", "direct"] as const)(
CLAIM|32|一致|test/integration/sqlite-transaction-scope.test.ts:34|真实 SQLite|  const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
CLAIM|33|一致|test/integration/sqlite-transaction-scope.test.ts:68|工作线程和进程内两种方式|describe.each(["worker", "direct"] as const)(
CLAIM|34|一致|test/integration/sqlite-transaction-scope.test.ts:118|含回滚|    it("rolls every write of the scope back when it throws, and the next write is not affected", async () => {
CLAIM|35|一致|test/integration/sqlite-transaction-scope.test.ts:163|超时|    it("rolls back on timeout, refuses the late writes of the still-running work, and frees the write lane", async () => {
CLAIM|36|一致|test/integration/sqlite-transaction-scope.test.ts:73|隔离|    it("commits every write of the scope together, lets the scope read its own writes, and hides them from outside readers until commit", async () => {
CLAIM|37|一致|test/integration/sqlite-transaction-scope.test.ts:239|被 SQLite 自行回滚|describe("[P3-5] transaction scope when SQLite rolls the transaction back by itself", () => {
CLAIM|38|一致|test/integration/sqlite-transaction-scope.test.ts:218|工作线程丢失|describe("[P3-5] transaction scope when the database worker is lost", () => {
CLAIM|39|一致|packages/persistence-sqlite/test/memory-capture-backlog-migration.contract.test.ts:157|`packages/persistence-sqlite/test/memory-capture-backlog-migration.contract.test.ts` 6 条|  it("[P3-5] keeps every decision record and the six tables that point at it when the ledger is rebuilt", async () => {
CLAIM|40|一致|packages/application/src/services/durable-memory-service.ts:140|做梦记忆（PR 395）里“重试时补做取代”的补丁|              await this.supersede(proposal.supersedes, existing, generationId);

未核对的部分：方案中拟新增或修改的事务行为（如 BEGIN IMMEDIATE、超时、慢操作日志、回滚确认等）、外部文档与方案讨论记录，以及“以前十几次独立写库”“这些逻辑刚被做梦记忆线程改过”等历史性表述；这些不属于当前代码或仓库文档现状，或无法仅凭当前仓库材料确认。
