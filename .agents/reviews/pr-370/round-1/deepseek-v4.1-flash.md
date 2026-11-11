## 结论

改动的主路径方向正确：检索层已有的 `onVectorFailure` + 关键词/实体回退被复用到聊天路径，删掉的失败码在生产代码里已无产生者，`[P3-2]` 用例也能覆盖“断网 / 网关不报费用 / 402”三种主路径。但这次把“嵌入失败后结清”的触发面从“3 秒超时”扩大到“所有非取消的聊天嵌入失败”，错误路径和文档/测试的边界没有同步处理，存在几处需要修正的地方。

---

## 发现（按严重度）

### 1. 中 — `settle` 自身抛错时，原始错误被吞掉，分配停在 `started`，最终可能把预算账户变成 `reconcile_required`

- 文件: `apps/agent-service/src/production-run-memory.ts:278-296`
- 问题：新的 catch 在 `runEmbedding && !context?.signal?.aborted` 时直接 `await permit.settle({...estimate...})`，没有 try/catch。`settle` 抛错（磁盘余量不足、权限/租约变化、并发下的 `PORT_CONFLICT` 等）时：
  1. 原始嵌入错误被替换成 settle 的错误，`memory.embedding_failed` 也可能没有写（见第 7 条）；
  2. 不会再走 `markUnknown`；
  3. 该分配保持 `started`。随后 `HybridMemoryProvider.search` 会吞掉这个错误继续关键词检索（`packages/memory-engine/src/hybrid-memory-provider.ts:150-152`），于是聊天可能照常完成。
- 证据：

```ts
// production-run-memory.ts:280-295
if (
  started &&
  !settled &&
  ((error instanceof Error && error.message === EMBEDDING_ATTEMPT_TIMED_OUT) ||
    (runEmbedding && !context?.signal?.aborted))
)
  await permit.settle({
    inputTokens: EMBEDDING_INPUT_LIMIT,
    ...
    reportedCostMicros: descriptor.estimatedCostMicros,
  });
else if (started && !settled) await permit.markUnknown("transport_unresolved");
else if (!started) await permit.releaseReserved();
throw error;
```

```ts
// sqlite-model-budget-operations.ts:813-819（finalize）
const childState = this.childAllocationState(...);
const status = childState.open || childState.unknown ? "reconcile_required" : "active";
const updated = this.updateAccount(account, outstanding, account.spentCostMicros, status);
```

```ts
// sqlite-model-budget-operations.ts:1351-1355（started 属于 open）
open: rows.some(({ status }) => status === "reserved" || status === "started"),
```

- 影响：与 ADR 0216 决定 2“预算账户保持 `active`”的说法不一致；在 settle 失败的路径上，账户可能变成 `reconcile_required`，而且没有明确日志说明是结清失败还是网关失败。
- 建议：把 catch 里的 `permit.settle` 包在 try/catch 中；失败时至少写一条诊断，并回退到 `markUnknown`（或重新抛出原始错误并保留分配状态）。同时补一条“settle 抛错”的反向测试。

---

### 2. 中 — “主人取消时保持 markUnknown”只在上下文检索路径成立；`embedWithin` 没有传 `signal`

- 文件: `apps/agent-service/src/production-run-memory.ts:284,293`；`apps/agent-service/src/service-main.ts:1263-1278`、`1420-1433`
- 问题：新条件用 `context?.signal?.aborted` 区分取消。但只有上下文形成路径会传入信号（`packages/application/src/services/context-formation-service.ts:236-247`）。聊天中的回忆工具、记忆 episode、整理路径通过 `embedWithin` 进入，`RunEmbeddingContext.signal` 是可选，而生产调用方都没传：
- 证据：

```ts
// service-main.ts:1420-1433
memory.embedWithin(
  {
    ownerId: request.ownerId,
    agentId: request.agentId,
    runId: request.runId,
    executionLease: request.executionLease,
    deadlineAt: ...,
    dataClassification,
    slot,
  },
  operation,
);
```

```ts
// service-main.ts:1263-1278（回忆工具同样没有 signal）
return memory.embedWithin(
  {
    ownerId: configuration.ownerId,
    agentId: configuration.agentId,
    runId: invocation.runId,
    executionLease,
    deadlineAt: ...,
    dataClassification: invocation.dataClassification,
    slot: `${slot}:${invocation.toolCallId}`,
  },
  operation,
);
```

- 影响：这些路径上 `context.signal` 永远是 `undefined`，`!context?.signal?.aborted` 恒为真。运行被取消时，仍会按预估结清而不是 `markUnknown`；同时嵌入请求本身也不会随取消中止，可能一直等到超时。作者的“非主人取消才 settle”对这些路径不成立。
- 建议：把运行的取消信号传进 `embedWithin`（`RuntimeRequest` 若没有信号，应显式从执行尝试传下来），并加测试覆盖回忆工具的取消。

---

### 3. 中 — 取消或非“向量不可用”的错误也会写 `retrieval_degrade`，导致“不该写的时候写”

- 文件: `packages/memory-engine/src/hybrid-memory-provider.ts:150-152`；`apps/agent-service/src/production-decision-ledger.ts:15-32`
- 问题：检索层对 `embedder.embed` 的任何异常都调用 `onVectorFailure`，不区分 `AbortError`/取消。`retrievalDegradeRecorder` 又无条件写一行 `kind = retrieval_degrade`。聊天取消时，检索结果本来就会被丢弃，但仍会留下“记忆搜索降级”的记录。
- 证据：

```ts
// hybrid-memory-provider.ts:150-152
} catch (error) {
  this.#options.onVectorFailure?.(error, { ownerId: input.ownerId, agentId: input.agentId });
}
```

```ts
// production-decision-ledger.ts:15-32
return (_error, scope) => {
  void options.ledger
    .append({
      id: `ledger:${randomUUID()}`,
      ...
      kind: "retrieval_degrade",
      ...
      reasonCode: "vector_search_unavailable",
      ...
    })
    .catch(options.onFailure);
};
```

- 影响：这是既有行为，但本次改动把聊天路径的这类记录变成“正常可观察的决策记录”，且 ADR 的“取消保持原来的做法”容易让人以为取消不会写降级记录。实际会写。
- 建议：在检索层判断取消（`signal.aborted` 或 `AbortError`）并跳过 `onVectorFailure`；或在 recorder 里区分取消原因。补一条“取消不写 retrieval_degrade”的测试。

---

### 4. 中低 — ADR 说 `reconcile_required` 会“让后面的对话模型调用被预算拒绝”，当前代码不支持这个前提

- 文件: `docs/adr/0216-chat-memory-lookup-falls-back-to-keywords.md:36-38`；`packages/application/src/services/model-invocation-admission-service.ts:393-451`；`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:444-547`；`packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts:707,1106-1117`
- 问题：ADR 前提 3 的第二条说 `markUnknown` 使账户变成 `reconcile_required`，从而“后面的对话模型调用会被预算拒绝”。但阅读代码：
  - `ModelInvocationAdmissionService.begin` 只做 `#assertActive()` 和 `#invocations.begin`；
  - `reserveWithinTransaction` 遇到 `reconcile_required` 账户不会拒绝，只保留状态；
  - 真正过滤 `reconcile_required` 的是 `assertRunBudgetDispatchable`，它只在**领取执行租约**时调用（`sqlite-run-dispatch-operations.ts:707`）。
- 证据：

```ts
// model-invocation-admission-service.ts:393-398
async begin(input: ModelInvocationAdmissionInput): Promise<ModelInvocationAdmissionResult> {
  const descriptor = this.#descriptor(input.modelRef);
  this.#validateInput(input, descriptor);
  await this.#assertActive();
  const reservedAt = canonicalTimestamp(this.#clock.now(), "reservedAt");
  const result = await this.#invocations.begin({ ... });
```

```ts
// sqlite-model-budget-operations.ts:532-537
const updated = this.updateAccount(
  account,
  nextReserved,
  account.spentCostMicros,
  account.status === "reconcile_required" ? "reconcile_required" : "active",
);
```

- 影响：旧路径真正让整轮失败的是被本次删掉的 `CONTEXT_MEMORY_*` 显式抛出；“只删抛错、不 settle”会得到 `RUNTIME_EXECUTION_FAILED` 的“放弃做法”说法也缺少代码依据。按预估结清仍然可能是合理选择（避免留下 open 分配、便于后续 dispatch），但理由应改成“避免账户进入 reconcile 并保持账目可结算”，而不是“否则下一次模型调用会被预算拒绝”。
- 建议：修正 ADR 前提 3 和“放弃的做法”的措辞，或补上真正的预算拒绝检查（如果设计上确实需要）。

---

### 5. 低 — `[P3-2]` 测试没有真正约束“一轮只有一条”降级记录

- 文件: `test/integration/production-http-composition-process.test.ts:1821-1829`
- 问题：先 `expect(degradeRows().length).toBeGreaterThan(0)`，再用 `new Set(...)` 比较集合。若同一轮写了两条完全相同的行，`Set` 会折叠，测试仍通过；查询也没有按 run/thread/时间范围过滤。
- 证据：

```ts
await expect.poll(() => degradeRows().length).toBeGreaterThan(0);
expect(new Set(degradeRows().map((row) => JSON.stringify(row)))).toEqual(
  new Set([
    JSON.stringify({ outcome: "degraded", reasonCode: "vector_search_unavailable" }),
  ]),
);
```

- 建议：改成 `expect(degradeRows()).toHaveLength(1)`，并按 `decided_at` 或测试开始前的行数增量取差集；再补“取消或被取消的回合不新增行”的反向用例。

---

### 6. 低 — 进程测试用的是替身自己的 `onVectorFailure`，没有覆盖 `service-main` 的默认生产接线

- 文件: `test/fixtures/production-service-main-child.mjs:162-174`；`apps/agent-service/src/service-main.ts:803,359-363`
- 问题：`openInstalledMain` 启动的是 `production-service-main-child.mjs`（`test/integration/production-http-composition-process.test.ts:1312`），而该替身通过 `memoryCompositionFactory` 自己提供了 `retrievalDegradeRecorder`。`runAgentService` 用 `dependencies.memoryCompositionFactory ?? createDefaultMemoryComposition`，因此不会走 `createDefaultMemoryComposition` 里的生产接线。
- 证据：

```ts
// service-main.ts:803
const memoryFactory = dependencies.memoryCompositionFactory ?? createDefaultMemoryComposition;
```

```js
// production-service-main-child.mjs:170-174
onVectorFailure: agent.retrievalDegradeRecorder({
  ledger: repository.decisionLedger(),
  now: () => new Date().toISOString(),
  onFailure: () => {},
}),
```

- 影响：如果以后有人删掉 `createDefaultMemoryComposition` 里的 `onVectorFailure`，当前 `[P3-2]` 用例仍会通过。本次生产接线未被改动，所以不是回归，但测试没有守住它。
- 建议：增加一个不覆写 `memoryCompositionFactory` 的用例，或直接对 `createDefaultMemoryComposition` 做单元检查。

---

### 7. 低 — 文档/代码一致性问题：16384 是字节不是 token；“每次嵌入失败都写日志”也不完全成立

- 文件: `apps/agent-service/src/production-run-memory.ts:29,129,287`；`apps/agent-service/src/production-run-memory.ts:265-274`
- 问题：
  - ADR 022 说“预估上限是一次嵌入最长输入（16384 token）”，代码限制的是 UTF-8 字节数：`Buffer.byteLength(request.input, "utf8") > EMBEDDING_INPUT_LIMIT`，而结清时又把 `16384` 当作 `inputTokens`。作为上限仍安全（token 通常不超过字节数），但文档单位写错了。
  - ADR 0216 决定 4 说“每次嵌入失败仍写一行 `memory.embedding_failed`”。实际上只有 `send`/`gatewayEmbeddingUsage` 的内部 catch 才写诊断（`production-run-memory.ts:265-269`）；`permit.assertActive` 在发送后失败、发送后 `remaining() <= 0`（`273`）、`permit.settle` 失败都不会写。
- 证据：

```ts
// production-run-memory.ts:129
Buffer.byteLength(request.input, "utf8") > EMBEDDING_INPUT_LIMIT ||
```

```ts
// production-run-memory.ts:248-269
const timeoutMs = Math.max(1, Math.floor(Math.min(remaining(), attemptMs ?? ...)));
...
try {
  response = await send({ timeoutMs, signal });
  ...
} catch (error) {
  if (attemptMs !== undefined && timeout.aborted && !context?.signal?.aborted)
    throw new Error(EMBEDDING_ATTEMPT_TIMED_OUT);
  options.diagnostic?.(embeddingFailureDiagnostic(error));
  throw error;
}
```

- 建议：统一把常量命名为字节上限（或在结清时按 token 上限单独计算），并把 ADR 的“每次失败都写日志”改为“网关/响应解析失败写日志”，或把相关分支也补上诊断。

---

### 8. 低 — 历史文档仍然把 402 记成 `CONTEXT_MEMORY_QUOTA_EXCEEDED`

- 文件: `docs/engineering-casebook.md:3199`；`docs/incidents-and-gates.md:50`
- 问题：案例集仍写“402 单独记成 `CONTEXT_MEMORY_QUOTA_EXCEEDED`”，与当前代码不一致；I-11 行同时保留旧说法和“已删”的后续说明，读起来自相矛盾。
- 建议：在 casebook 该条加一句“后续见 ADR 0216”，或在 I-11 中把旧说法明确标成历史。

---

## 读代码证实的

- 聊天检索层已改为直接返回 `options.memory.search(...)` 的结果，不再把检索层记录的错误转成 `CONTEXT_MEMORY_*`：`production-run-memory.ts:344-353`。
- 检索层确实在嵌入异常时继续关键词/实体检索并调用 `onVectorFailure`：`hybrid-memory-provider.ts:139-168`。
- 生产默认接线确实存在：`service-main.ts:359-363`；`createDefaultMemoryComposition` 在无替身时使用它：`service-main.ts:803`。
- 投影路径和 Gmail 路径仍走原来的 `markUnknown` 分支：`production-run-memory.ts:191-209,279-294`。
- `RunCoordinator` 删除的分支只匹配 `PROVIDER_FAILURE` + 两个已删除的常量；现在全仓库生产代码已无这两个常量，其他 `context.form` 异常由 dispatcher 的 `reconcileUnknown` 兜底（`production-run-dispatcher.ts:644-670`），不会因为删分支直接让进程崩溃。
- 删除的 i18n key 在英文/日文/简中三份资源和 `MESSAGE_IDS` 中都已移除；控制中心对旧 `CONTEXT_MEMORY_UNAVAILABLE` 记录回退到 `chat.error.failed`（`execution-view.ts:13-25`，测试 `execution-view.unit.test.ts:296-298`）。
- `retrieval_degrade` / `vector_search_unavailable` 是已有决策记录类型和原因码，`packages/application/src/ports/decision-ledger.ts:34,46` 已接受。
- 测试确实覆盖了三种失败模式的主路径和“正常第一轮没有降级记录”：`production-http-composition-process.test.ts:1728-1857`。

## 推测 / 未核实

- 未实际运行测试；关于“反向用例会不会失败”的判断来自阅读测试断言和旧代码逻辑。
- `permit.settle` 在生产中抛错的频率和具体来源（磁盘、权限、租约）是推断；代码层面只能确认“这里没有兜底”。
- 402 场景下真实 Vercel 用户预算是否只拒绝嵌入而放行对话模型，仓库内没有资料；测试里的 `budget exceeded` 只让 `/v1/embeddings` 返回 402，因此该用例并不代表 I-11 的“整账号预算超限”真实情况。
- 一轮是否真的会出现两条 `retrieval_degrade`：普通上下文检索只调用一次搜索，所以通常一条；但回忆工具、重试/恢复、并发搜索都没有去重，是否发生取决于运行路径，未实测。

---

## 侧重检查

- **错误路径**：检查了 `settle` 抛错、发送后 `assertActive` 失败、截止时间已过、取消、`markUnknown` 路径、`releaseReserved` 路径、`finalize` 对 open 分配的处理。结论见发现 1、2。
- **不合规范/不可信输入**：`HybridMemoryProvider.search` 仍通过 `DurableMemoryService` 的 `allowedClassifications` 过滤结果（`durable-memory-service.ts:397-421`），嵌入请求仍校验模型、维度、分类和输入长度（`production-run-memory.ts:125-135`）。未发现本次改动新增越权读取或未过滤写入。
- **安全/隐私**：`retrievalDegradeRecorder` 忽略原始错误，只写固定的 `memoryIds: []`、`ruleIds: []`，不把查询文本或网关原文写进决策记录；`memory.embedding_failed` 仍可能带 `gatewayErrorMessage`（`production-run-memory.ts:379-386`），这是既有行为。
- **资源耗尽**：每个失败搜索最多写一条 ledger 行，但无去重/幂等；嵌入重试仍最多两次（`production-run-memory.ts:298-311`）；未发现无限循环。取消未传信号会让回忆路径等到超时（发现 2）。
- **不可撤销操作**：预估结清会在 402 被网关拒绝时仍然记入运行预算（ADR 已承认“可能多记一点钱”）；代码中没有运行预算上限导致 `over_budget` 的拒绝路径，所以不会因多记而直接拒绝对话，但账目仍不精确。
- **文档与代码一致性**：ADR 0216 的“16384 token”“每次失败都写日志”“reconcile 会拒绝下一次模型调用”与代码有出入；案例集和 I-11 的旧说法未清理。见发现 4、7、8。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

不会改变已经发出的内容。改动没有触碰系统提示、工具定义、历史消息、遮盖逻辑或请求组装；`turnPrompt` 仍把时间、选中的记忆、运行环境等每轮变化的内容放在最后一条用户消息里（`packages/runtime-pi/src/pi-runtime-adapter.ts:623-641`），并追加 `<owner-message>`。系统提示和工具按对话冻结（ADR 0165），本次没有修改冻结/换新逻辑。

需要说明的是：嵌入失败以前这一轮根本不会发模型请求；现在会发，且最后一条消息里带的是**关键词/实体找到的记忆**，与“假设嵌入成功时会选的记忆”可能不同。但这是新请求的内容差异，不是对已发历史的改写，仍符合“只在末尾追加、每轮变化的值放在最后一条消息里”。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

没有引入新的请求字节不稳定因素。

- 发送给模型的内容里，唯一受本改动影响的是“这一轮选中的记忆”。其排序仍然是确定性的：融合结果按分数降序、同分按 memoryId 排序（`packages/memory-engine/src/fusion.ts:99-114`），上层再按分数和 id 排序（`durable-memory-service.ts:418-421`、`context-formation-service.ts:250-252`）。没有新增无序集合或时间字段进入提示词。
- 决策记录里的 `decidedAt = new Date().toISOString()` 和 `randomUUID()` 确实每次不同，但它们不进入模型请求，属于记录而非请求字节。
- 需要接受的语义差异：同一段文字在“嵌入可用”和“嵌入失败”时可能召回到不同记忆。这是降级本身的结果，不是序列化不确定；如果要求两种情况字节完全相同，只能不做降级。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有检查，但反向覆盖不完整。

- 有：
  - `apps/agent-service/test/production-model-composition.unit.test.ts:1717-1740`：query 模式对缺失网关信息/费用、非法向量等改为断言 `markUnknown` 不调用、`settle` 按 16384 输入结清；projection 模式仍断言 `markUnknown`。旧代码会在 query 模式走 `markUnknown`，因此这类反向断言会失败。
  - 同文件 `1754-1779`：取消仍 `markUnknown`，截止时间仍按预估结清。
  - `test/integration/production-http-composition-process.test.ts:1728-1857`：三种失败下 run 完成、模型请求包含关键词找到的记忆、有降级记录、嵌入分配 settled、预算账户 active；第一轮正常嵌入时降级记录为空。旧代码在失败轮会整轮失败，因此这个用例会失败。
  - `test/integration/decision-ledger.test.ts:924-962`：直接提供者搜一次写一行、正常搜索不写。
- 不足：
  - 没有 `permit.settle` 抛错的反向用例（发现 1）。
  - 没有“一轮只能一条降级记录”的严格断言；`Set` 会吞掉重复行（发现 5）。
  - 没有“取消不写降级记录”的测试（发现 3）。
  - 没有 `embedWithin` 取消信号的测试（发现 2）。
  - `budget exceeded` 只拒绝嵌入，不拒绝对话模型，不能代表真实用户预算超限。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

逐项核对结果：

- **删除的 `CONTEXT_MEMORY_UNAVAILABLE` / `CONTEXT_MEMORY_QUOTA_EXCEEDED`**
  - 产生处：已删除（`packages/application/src/ports/intelligence.ts:54-56` 删除；`production-run-memory.ts` 不再抛）。
  - 使用处：`run-coordinator.ts`、`thread-execution-projection.ts`、`execution-view.ts`、三语 i18n 都已同步删除或改为通用失败。全仓库生产代码已无引用；剩余引用只在历史文档和旧数据测试里。
  - 结论：代码两端一致。旧记录按通用失败显示（`execution-view.ts:24-25`），符合 ADR。

- **`retrievalDegradeRecorder` 从 `index.ts` 导出**
  - 产生处：`apps/agent-service/src/index.ts:7`。
  - 使用处：`test/fixtures/production-service-main-child.mjs:170` 使用 `agent.retrievalDegradeRecorder`。
  - 结论：可接受；`production-decision-ledger.ts` 的签名与调用匹配。

- **`kind = retrieval_degrade` / `reasonCode = vector_search_unavailable` / `outcome = degraded`**
  - 产生处：`production-decision-ledger.ts:21-25`。
  - 使用处：决策记录 schema/端口允许 `retrieval_degrade`，校准和导出也已有映射（`packages/application/src/ports/decision-ledger.ts:34,46` 等）。
  - 结论：后端和现有消费者都能接受；已有 `decision-ledger.test.ts` 覆盖。

- **`failure = "quota_exceeded" | "unavailable"`**
  - 产生处：`production-run-memory.ts:371-386`。
  - 使用处：只写入 `memory.embedding_failed` 诊断日志，没有类型校验或解析消费者。
  - 结论：可接受；但文档说“每次失败都写”不准确（发现 7）。

- **删除 `chat.error.contextMemoryUnavailable`**
  - 产生/使用处：`MESSAGE_IDS`、en/ja/zh-CN 资源和 `execution-view.ts` 均已同步删除；全仓库无残留引用。
  - 结论：一致。

- **测试新增的 `MEMORY_CAPTURE` 导入和 SQL 查询**
  - `MEMORY_CAPTURE` 在 `@himawari-agent/prompt-catalog` 存在；`decision_ledger` 表有 `kind/outcome/reason_code` 列，已有 recorder 写入路径证明格式可接受。
  - 结论：可接受。

- **新增 ADR 0216 / ADR 0109 后续 / I-11**
  - 大体与代码一致；但 ADR 0216 的“16384 token”“reconcile 会拒绝下一次模型调用”“每次失败写日志”与代码有出入（发现 4、7），案例集 `docs/engineering-casebook.md:3199` 仍保留旧结论（发现 8）。
