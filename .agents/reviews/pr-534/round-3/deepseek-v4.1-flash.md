这一轮只看了 `03175cec..8d3f18a` 的增量（`production-task-proposals.ts` 的 `chunks`、`compareText`、`proposalId` 与 `task-proposals.test.ts`），并沿证据追到 `production-proposal-control.ts`、`production-proposals.ts`、`sqlite-owner-proposal-operations.ts`、`sqlite-run-lifecycle-operations.ts`、`owner-scope-authorization.ts`、`action-rules.ts`、`production-run-policy.ts`、`sqlite-thread-operations.ts`、`production-thread-titles.ts`、`gateway-contracts/src/validation.ts`、`contracts-v2.ts`、`docs/architecture-v0.1.md`。`.agents/reviews` 在稀疏检出中被排除，未读；没有运行测试。

### 1. 中：来源标记并入编号后，同一任务可在“外部内容”和“普通来源”下各办一次，与“只能办一次”冲突，也留下绕过读全文的窗口

文件:行
`apps/agent-service/src/production-task-proposals.ts:245-249`；`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:156-186`；`test/integration/task-proposals.test.ts:383-396`；`docs/architecture-v0.1.md:435`

问题
增量把 `external` 布尔值并入 `proposalId`。这确实阻止了旧提议被就地降级，但同一 `text + basis` 在 `external=true` 和 `external=false` 时得到两个不同编号，于是可以同时存在两条待采纳提议，也可以先后各采纳一次，各开一个对话和一次运行。文档却写“同一个任务说明加同一批依据只能办一次”。

证据（读代码证实）
```ts
const external = context.externalContentSeen === true || context.origin === "external_content";
const proposalId = `task:${createHash("sha256")
  .update(JSON.stringify([text, basis.map(({ kind, ref }) => [kind, ref]), external]))
```
新增反向测试自己也证明两条都在箱里：
```ts
const external = await proposeTaskRun({ ...context, origin: "external_content" }, ...);
const ordinary = await proposeTaskRun(context, ...);
expect(ordinary.proposalId).not.toBe(external.proposalId);
const kept = listed.find((item) => item.proposalId === external.proposalId);
expect(kept?.requiresFullRead).toBe(true);
```
存储层对不同编号走插入新行，不触发 `existing?.status === "pending"` 的刷新分支。

推测
目前还没有生产来源调用 `proposeTaskRun`，所以这不是现有可利用路径。但一旦接上来源，外部内容引出的任务可以再用普通来源提议一次；普通那条若未超 120 字则 `requiresFullRead=false`，主人可以不打开全文直接同意，等于绕过“外部内容必须读全文”。这需要调用方传错 `origin`/`externalContentSeen`，因此列为推测而非已证实的安全漏洞。

建议
保持 `proposalId` 只由 `text + basis` 算出；在存储层把 `requires_full_read` 和外部来源做单调合并（只升不降），而不是换编号。若坚持按来源分编号，至少要拒绝同一 `text + basis` 存在另一条待采纳或已执行的提议，并同步改文档。

### 2. 中：读全文展示仍不是执行字节——Bidi/控制字符被清掉、换行变空格、分片边界去空白，`<<<`/`>>>` 也被替换

文件:行
`apps/agent-service/src/production-task-proposals.ts:88-92`、`:266-271`；`apps/agent-service/src/production-proposal-control.ts:65-70`；`apps/agent-service/src/production-proposals.ts:195-205`；`test/integration/task-proposals.test.ts:335-364`；`docs/architecture-v0.1.md:435`

问题
上一轮第 3 条只修好了“非 BMP 被 UTF-16 预算截掉一半”这半：`chunks` 现在按 UTF-16 长度切，每个分片确实不超过网关的 500。但另一半“展示不等于执行字节”没有修，而且新增的分片边界还会制造新的差异。

证据（读代码证实）
执行时用的是原文，只替换块边界：
```ts
return [
  `这是主人在 ${localTimeText(...)}（${input.timeZone}）同意的一条提议，提议编号 ${input.proposalId}。...`,
  TASK_OPEN,
  neutralized(input.text),
  TASK_CLOSE,
].join("\n");
```
展示时网关投影会先清洗：
```ts
text: item.text === null ? null : shownText(item.text, 500) || null,
```
```ts
for (const character of value
  .replace(/\p{Bidi_Control}/gu, "")
  .replace(/\p{Cc}/gu, " ")
  .trim()) {
  if (kept.length + character.length > maximum) break;
  kept += character;
}
```
所以任务里的换行会显示成空格，Bidi 控制符会被删掉，每个分片两端空白会被 `trim` 掉，`<<<`/`>>>` 执行时变成 `‹‹‹`/`›››`，展示仍是原符号。测试只读 `box.list()` 的原始 evidence，没有经过 `ProductionProposalControl` 和网关校验，因此测不到这个差异。

推测
如果任务文本来自外部内容并含 Bidi 控制符，主人看到的和模型实际执行的是两段不同字节，存在“展示欺骗”风险；目前没有生产调用方，所以未证实可利用。分片边界的空白丢失还可能改变列表、缩进等语义。

建议
让“展示的全文”和“执行的正文”来自同一份已确定化的字符串：要么在提议时就做 `neutralized` 并把结果存进 `data.text`，要么让网关证据允许换行且不在分片边界 `trim`。至少应让 `task_text` 证据直接使用最终执行正文，而不是对原文分片后再清洗。

### 3. 中：执行失败或进程崩溃仍会留下空对话并把提议永久钉在 `failed`/`unknown`，同一个提议不能重办（上一轮第 4 条未改）

文件:行
`apps/agent-service/src/production-task-proposals.ts:147-170`；`apps/agent-service/src/production-proposals.ts:674-695`、`:575-602`；`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:157`、`:354-359`

问题
增量没有碰这一块，行为仍是：先建对话，再开运行；两步不在一个事务里，也没有可重试的“已建对话、未建运行”状态。

证据（读代码证实）
```ts
const created = await commands.create({ ... threadId: id.threadId, ... });
await commands.admitOwnerMessage({ ... expectedThreadRevision: created.thread.revision, ... });
```
`execute` 抛错后提议被标 `failed`：
```ts
await store.moveExecution({ ... from: "running", to: "failed", leaseId, ... });
```
崩溃恢复只读回，不重做；没有 execution 载荷就直接标 `unknown`：
```ts
if (!handler || !isAction(handler) || !basis || !execution) {
  await store.moveExecution({ ... to: "unknown", ... });
  continue;
}
```
而之后既不能再 `propose` 也不能再 `claim` 同一个编号：
```ts
if (existing && existing.execStatus !== "not_started") return "closed";
```
```ts
... WHERE ... status = 'pending' AND exec_status = 'not_started' AND version = ? ...
```
所以“已建空对话、运行未开”或“领取后崩溃”都会留下孤儿对话/永久 `failed`/`unknown`，同一个提议不能再办。文档已经在第 435 行承认空对话不回收，但没有解决无法重办。

建议
给 `execute` 加可恢复的执行意图（例如在执行原样里记录 `threadCreated` / `runOpened`），恢复时若只是“对话已建、运行未开”，用同样的幂等键补开运行；或把建对话、写消息、开运行放进同一事务。对“领取后崩溃且没有执行载荷”的提议允许重新领取，而不是永久 `unknown`。

### 4. 低：`readBack` 只查消息和运行是否存在，运行已失败或取消仍判 `succeeded`（上一轮第 5 条未改）

文件:行
`apps/agent-service/src/production-task-proposals.ts:176-188`；`docs/architecture-v0.1.md:435`

问题
增量没有改。恢复时如果运行已经失败、取消或完成，`readBack` 仍只看对话里有没有这条消息、这次运行，判 `matches`。

证据（读代码证实）
```ts
const hasRun = snapshot?.runs.some((run) => run.runId === made.runId) === true;
const hasMessage = snapshot?.messages.some((item) => item.contentRef === made.contentRef);
return hasRun && hasMessage ? "matches" : "differs";
```
文档明确把它定义成预期：“`succeeded` 的含义是‘运行已经建立并被受理’，读回不看运行的当前状态”。所以严格说这不是代码没按文档实现，而是状态名容易被理解成“办成了”。

建议
如果产品接受“已建立”语义，建议把执行状态命名或展示成 `started`/“已开始”，避免和别的处理方“已办成”的 `succeeded` 混淆；如果不接受，则在 `readBack` 里同时检查运行状态不是 `failed`/`cancelled`，或至少在提议上区分“运行结果另行查看”。

### 5. 低：文档仍写“编号由任务说明和依据的 JSON 算出”，与增量代码不符

文件:行
`docs/architecture-v0.1.md:435`；`apps/agent-service/src/production-task-proposals.ts:246-249`

问题
增量把 `external` 加进哈希，但文档那句话没有更新，读者会以为编号只由任务和依据决定。

证据（读代码证实）
```ts
.update(JSON.stringify([text, basis.map(({ kind, ref }) => [kind, ref]), external]))
```
文档同一条写“编号由任务说明和依据的 JSON 算出，换顺序、换切分都不会撞号”。

建议
把文档改成“编号由任务说明、依据和来源标记算出”，并同时修正“同一个任务说明加同一批依据只能办一次”的说法，或按第 1 条建议改代码。

**上一轮五条意见核对**

- 第 3 条（`task_text` 展示）：非 BMP 长度截断已修好（`chunks` 按 UTF-16 切，测试覆盖）；“展示等于执行字节”未修好，见第 2 条。
- 第 2 条（降级）：原 pending 提议不会再被就地降级，但改成了两个编号、可各办一次，见第 1 条。
- 第 4 条（失败/崩溃留空对话、不能重办）：未改，见第 3 条。
- 第 5 条（`readBack` 不看运行状态）：未改；文档已把它写成预期，见第 4 条。
- 第 8 条（`localeCompare`）：已修好，`compareText` 用 UTF-16 码元比较，结果与 locale 无关；没有单独的跨 locale 测试，只有间接的编号稳定性测试。

**侧重检查**

- 错误路径：无会话时 `verify` 抛 `PROPOSAL_INVALID`，不会标 `superseded`、不会开运行，已核实（`production-task-proposals.ts:122`、`:128`，`test/integration/task-proposals.test.ts:277-290`）。
- 执行中途失败/崩溃：见第 3 条，会留空对话和永久 `failed`/`unknown`。
- 不可撤销：`undo` 一律抛 `PROPOSAL_NOT_UNDOABLE`，已核实（`production-task-proposals.ts:190-192`）。
- 不可信输入：`taskData` 限制任务正文长度和依据条数，但没有限制 `basis.kind`/`basis.ref` 的长度和字符集；这些值会进入哈希、加密载荷和 evidence。目前 `proposeTaskRun` 没有生产调用方，是否会被不可信输入触发未核实；若以后由模型或外部适配器调用，建议补长度上限。
- 安全/外部内容：`sourceType=external_event` 会在 `owner-scope-authorization.ts:248-252` 被标记为外部来源，进而产生 `context_external_content`，内置规则 `refuseBackgroundAfterExternalContent` 对非 READ 动作直接拒绝；与文档一致，已核实。
- 规则/文档/代码一致：发现第 1、5 条所述不一致。
- `external_event` 下游：首页 `listUnattended` 取 `t.source_type != 'user_message'` 的运行（`sqlite-run-lifecycle-operations.ts:956-962`），任务运行会出现；普通主人消息仍是 `user_message` 不会出现。上下文投影和网关契约接受 `external_event`；`modelSelection` 为空时运行策略选 primary；`production-owner-intent.ts:66`、`owner-intent-gate.ts:76` 对非 `user_message` 不收集主人意图，这与“后台不授权写操作”一致，未发现会让运行卡住或错误审批的假设。

**作者五条说法核对**

1. 外部事件运行会被首页“正在做的”取到、普通消息不会：属实，见上述查询和测试。
2. 幂等键由提议编号算出、重复同意只开一次、失败后重放不会开第二次：幂等键和“重复同意只开一次”属实；“失败后重放不会开第二次”是因为失败后根本不能再领取/重放，不是恢复后安全重试，见第 3 条。
3. 任务说明原样作为第一条消息、只加抬头、替换 `<<<`/`>>>`：抬头和替换属实；但展示经过 `shownText` 清洗，不等于执行正文，见第 2 条。
4. 没有登录会话时抛 `PROPOSAL_INVALID`、不标被取代、不开运行：属实。
5. 不做撤销、`undo` 抛 `PROPOSAL_NOT_UNDOABLE`：属实。

**必答问题**

1. 请求开头：不改变模型已经见过的任何请求开头。任务运行总是新开对话，系统提示、工具定义、历史消息和遮盖规则都没改；新对话的第一条消息里带同意时间和提议编号，它在该次请求里就是最后一条消息，之后只会追加。符合“只在末尾追加、每轮会变的值在最后一条消息”。
2. 字节确定性：增量的 `compareText` 修掉了 locale 依赖，`chunks` 和编号计算都是确定的，未发现同一段文字因前后文或时间在不同请求变成不同字节。任务消息里的 `decidedAt` 只在首次执行时写入并持久化，同一提议重放不会重新生成；不同提议的时间不同是预期。展示层的 `shownText` 清洗是确定的，但它造成的是“展示≠执行”，不是“同文不同字节”。
3. 自动检查：新增的两个反向测试按旧实现推导会失败——emoji 测试在旧代码下每个分片 1000 个 UTF-16 单元，超过 500；降级测试在旧代码下两个编号相同且 `requiresFullRead` 会被刷新成 false。但测试只读 `box.list()` 的原始 evidence，没有经过 `ProductionProposalControl` 的 `shownText` 和网关的 `boundedString`，所以测不到第 2 条的展示/执行差异；也没有覆盖第 1 条的“同一任务两种来源各办一次”和 `compareText` 的跨 locale 行为。未运行测试，均为按代码推导。
4. 值的使用端：`proposalId` 仍是 `task:` + 32 位十六进制，能通过 `PROPOSAL_ID_PATTERN`、网关 `machineString` 和导出校验；`external_event` 能通过触发器表的 CHECK 和网关枚举；`triggerSource` 只在非默认值进语义指纹，旧指纹不变；`sessionId`/`proofRef` 被 `task.run` 处理方消费；`chunks` 输出每个分片不超过 500 个 UTF-16 单元，能通过网关 `boundedString(500)` 的长度检查。问题在第 1 条的重复办和第 2 条的清洗后语义不一致。
