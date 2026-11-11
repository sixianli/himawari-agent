# 复核结论

## 一、读代码证实的问题（按严重度）

### 1. 中：结清失败后调用 `markUnknown`，如果它也抛错，原来的嵌入错误会被吞掉

`apps/agent-service/src/production-run-memory.ts:294-304`

```ts
} catch (accounting) {
  options.diagnostic?.({
    component: "agent-service",
    event: "memory.embedding_settle_failed",
    error: accounting instanceof Error ? accounting.message : "EMBEDDING_SETTLE_FAILED",
  });
  await permit.markUnknown("transport_unresolved");
}
...
throw error;
```

`permit.markUnknown(...)` 没有 try/catch。它一旦抛错，后面的 `throw error` 不会执行，调用方看到的是 `markUnknown` 的错误，而不是原来的嵌入错误。这与 ADR 0223 决定 2 写的「向上抛出的仍是原来的嵌入错误」以及新单元测试的名字不一致。

更关键的是，这种双失败不是极端的假设：`settle` 和 `markUnknown` 在持久层检查同一组条件。

`packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:651-657`（settle）

```ts
this.assertCurrentAuthority(scope, input.at);
const row = this.requireRow(scope, input.runId, input.invocationId, input.budgetOperationKey);
this.assertExecutionLease(row, input.executionLease);
```

`packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:696-702`（markUnknown）

```ts
this.assertCurrentAuthority(scope, input.at);
const row = this.requireRow(scope, input.runId, input.invocationId, input.budgetOperationKey);
this.assertExecutionLease(row, input.executionLease);
```

`settleSync` 和 `markUnknownSync` 还都会先做 `assertDiskHeadroom()`（`:643-648`、`:688-693`）。因此权威失效、磁盘不足这类会让 `settle` 失败的常见原因，也会让兜底的 `markUnknown` 同样失败；此时兜底既不写「未知」，也把原错误换掉了。

`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:667` 的预算层 `markUnknownWithinTransaction` 还会再检查一次 `assertCurrentAuthority`，结论相同。

建议：把兜底 `markUnknown` 也包进 try/catch，失败时再写一条诊断（例如 `memory.embedding_unknown_failed`），并始终 `throw error`；可把记账错误放进 `error.cause` 附加信息。另一条路是先捕获原错误，记账失败只记日志，绝不改变向上抛出的错误。

### 2. 中：ADR 0223 决定 2 与代码不符：举例错误，且兜底会重新造成「领不到执行权」

`docs/adr/0223-chat-memory-lookup-falls-back-to-keywords.md:49`

> 结清本身失败时（例如执行租约已经丢了），改记“结果未知”……

核对结果：

- 运行内聊天路径的 `permit.settle` 是模型调用准入服务的 permit，`settle` 只比对冻结的 execution lease claim，不做实时执行租约检查（`sqlite-model-invocation-operations.ts:895-902`）。所以「执行租约已丢」本身并不是 `settle` 失败的代码路径。
- 真正会让 `settle` 失败的权威检查，`markUnknown` 也会做（见上一条），因此「改记结果未知」在权威失效时无法成功。
- 即使 `markUnknown` 成功，预算账户会变成 `reconcile_required`（`sqlite-model-budget-operations.ts:684-689`），而领取运行和 `assertRunBudgetDispatchable` 都会跳过这类账户：

`packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts:266-272`

```sql
AND NOT EXISTS (
  SELECT 1 FROM model_budget_accounts budget
  WHERE ... AND budget.status = 'reconcile_required'
)
```

`packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts:1106-1116`

```ts
private assertRunBudgetDispatchable(runId: string): void {
  ...
  if (row !== undefined) {
    this.fail("PORT_CONFLICT", "Run model budget requires reconciliation", { runId });
  }
}
```

也就是说，兜底成功时恰好回到了 ADR「放弃的做法」第一条描述的状态：之后等批准、排队工具批次或重启恢复时领不到执行权。ADR 决定 2 和后果没有写这个代价。建议改正「执行租约已丢」的举例，并明确兜底 `markUnknown` 会让运行之后无法重新领取执行权。

### 3. 低：新单元测试没有真正证明「保留原来的嵌入错误」，也没覆盖 `markUnknown` 抛错

`apps/agent-service/test/production-model-composition.unit.test.ts:1785-1800`

```ts
expect(failure).toBeInstanceOf(Error);
expect((failure as Error).message).not.toBe("SETTLE_REFUSED");
...
expect(fixture.permit.markUnknown).toHaveBeenCalledWith("transport_unresolved");
```

测试只断言「不是结清错误」，没有断言等于原始嵌入错误。该场景的原始错误其实是 `EMBEDDING_VECTOR_INVALID`（`packages/memory-engine/src/embedding.ts:83-89`）。如果 `markUnknown` 抛了另一个错误，这个测试仍然会通过，正好漏掉上面第 1 条的问题。也没有断言 `memory.embedding_settle_failed` 诊断是否写出，以及 `markUnknown` 失败时的行为。

建议：断言 `failure.message === "EMBEDDING_VECTOR_INVALID"`；增加 `fixture.permit.markUnknown.mockRejectedValueOnce(...)` 的用例，要求仍抛出原嵌入错误且写出兜底诊断。

## 二、读代码证实的正面结论（与作者说法一致的部分）

- ADR 0223 前提 4 对 `reconcile_required` 真实后果的描述与代码一致：待领取查询 `sqlite-run-dispatch-operations.ts:266-272` 和 `assertRunBudgetDispatchable` `:1106-1116` 都跳过 `reconcile_required`。
- 前提 1 与 `packages/memory-engine/src/hybrid-memory-provider.ts` 一致：`embedder.embed` 抛错时调用 `onVectorFailure`，随后以 `embedding = null` 继续按 `terms` 和实体检索。
- 前提 2 与 `apps/agent-service/src/service-main.ts:359-363`、`production-decision-ledger.ts:15-33` 一致，写 `kind = retrieval_degrade`、`outcome = degraded`、`reason_code = vector_search_unavailable`。
- 「回忆工具没有传取消信号」与代码一致：`service-main.ts:1259-1278` 和 `:1414-1435` 的 `embedWithin` 都没有传 `signal`；聊天路径的 `MemorySearchRequest` 会带 `signal`。
- 作者说 A3（取消时检索层也写降级记录）是改动前行为：`service-main.ts` 在本 PR 中未改，`onVectorFailure` 的接线在基线已存在，所以这一点成立；ADR 后果也已写明。
- `onVectorFailure` 改为必填后，我已逐个核对 `createProductionMemoryCompositionFromConfiguration` 的调用方：`service-main.ts`、`test/fixtures/production-service-main-child.mjs`、`file-summary-configuration.unit.test.ts`、`production-model-composition.unit.test.ts`、`openrouter-embedding-live.test.ts`、`file-summary-live-probe.ts` 都补了，类型检查可以兜住漏接。

## 三、推测（未核实）

- `markUnknown` 双失败后，预算分配会停在 `started`/`reserved`，账户仍可能是 `active`。我没有继续追后续的孤儿调用清理是否会回收这条记录，因此「是否最终留下永久未结清账」未核实。
- 进程用例中 `retrievalDegradeRecorder` 是 fire-and-forget 写入（`production-decision-ledger.ts:15-32`），测试先 `poll(length > 0)` 再立即 `toEqual([...])`。如果有第二次写入晚于断言落库，可能被放过。我没有实际复现，属于测试强度的推测。

## 四、侧重检查

查过并给出结论的路径：

- **错误路径**：结清失败、`markUnknown` 失败、权威失效、磁盘不足。结论：`markUnknown` 失败会替换原错误；权威/磁盘失败时兜底与结清共享检查，兜底很可能同样失败。
- **不规范/不可信输入**：`embeddingFailureDiagnostic` 会把 `ApplicationPortError.details` 原样并入诊断（既有行为）；新诊断只加 `accounting.message`，且 `writeServiceDiagnostic` 会做 `redactMachineSecrets`，未发现新增泄露面。
- **资源耗尽**：结清失败后再做一次写事务，磁盘不足时第二次写也会失败；不会形成重试循环。
- **不可撤销操作**：新增的 `memory.embedding_settle_failed` 只是日志；兜底成功会写 `reconcile_required`，影响运行之后重新领取执行权（见问题 2）。取消时仍会写一条不准确的检索降级记录，ADR 已列为已知缺口，属于旧行为。
- **规则/文档与代码一致性**：ADR 0223 前提 4、决定 2 存在上述不一致；I-11 和案例库的旧文字都加了「已删/后续」说明，未发现继续引用已删除常量导致编译或行为问题。
- **`onVectorFailure` 必填**：所有调用方和测试替身已核对，没有遗漏。

## 五、必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。这次改动没有动系统提示、工具定义、历史消息或遮盖逻辑的组装。聊天路径从「整轮失败」变成「继续回答」，只会让原本不会发生的下一段请求出现；已经发出的前缀没有被改写。每轮会变的记忆、时间等仍按规则放在最后一条用户消息/末尾资料里（规则 `.claude/rules/prompt-prefix.md:27-29`）；检索降级记录写入 `decision_ledger`，不进模型请求。结论：仍然是只在末尾追加，会变的值在最后。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
没有新增这种风险。检索降级记录确实用了 `randomUUID()` 和 `now()`（`production-decision-ledger.ts:18,22`），但它不是模型可见内容。关键词退回后的记忆排序仍由 `context-formation-service` 按 `score`、`id` 固定排序（`:250-252`），不是这次改动引入的。未发现新的带时间字段或无序集合进入请求。

**3. 有没有对应的自动检查，反向用例真的会失败？**
有，但不完整。进程用例现在断言三条失败路径下只有一条 `retrieval_degrade`，并验证第一轮正常时为零条（`test/integration/production-http-composition-process.test.ts:1821-1824`）；单元用例覆盖结清失败后改记未知。问题在于：单元测试没有断言原错误就是 `EMBEDDING_VECTOR_INVALID`，所以 `markUnknown` 抛错替换原错误时测试仍会通过；也没有 `markUnknown` 失败的用例。ADR 说的「用改动前的代码跑」「只删抛错保留未知」是手工反向验证，不是自动用例。结论：主要正向和一条反向方向有覆盖，但第 1 条问题所在的兜底双失败路径没有被自动检查挡住。

**4. 改动产生或修改的每个值，使用它的一方都能接受吗？**
- `onVectorFailure` 从可选改为必填：所有生产调用方、测试替身已核对并补齐，类型检查能拦住漏接。
- 删除的 `CONTEXT_MEMORY_UNAVAILABLE` / `CONTEXT_MEMORY_QUOTA_EXCEEDED`：代码中已无引用；`execution-view.ts` 对旧数据会落到通用 `chat.error.failed`，与 ADR 决定 3 一致；测试已改为期望通用文案。
- 新增日志事件 `memory.embedding_settle_failed`：`writeServiceDiagnostic` 接受任意字符串键值并用 JSON 序列化，没有事件白名单或 schema 校验，能接受。
- `markUnknown("transport_unresolved")`：原因码在 `ModelInvocationPermit` 允许列表内（`model-invocation-admission-service.ts:564-579`），能通过校验。
- 唯一两端对不上的地方是 ADR 决定 2 的承诺与持久层 `markUnknown` 的校验：ADR 说结清失败后一定能改记未知，但 `markUnknown` 与 `settle` 共享权威/磁盘检查，并不总能成功；且成功后会让预算账户进入 `reconcile_required`，影响后续领取执行权。
