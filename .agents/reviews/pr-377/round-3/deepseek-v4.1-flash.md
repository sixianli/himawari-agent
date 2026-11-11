## 复核范围

本轮以 `git diff 3dcfab2..a27e10e` 为主，并读取了它调用到的应用层、持久化层代码。没有运行测试，凡涉及“某测试会失败”都只是根据断言和代码推断。

## 侧重检查

- **错误路径**：看到 `#save` 的第一次失败、第二次失败、入队/删队、`onFailure`/决策记录失败；发现错误路径上“记账失败会挡住保存重试”和“部分保存后仍记 `capture_gave_up`”两个问题（见问题 1、3）。
- **不合规范/不可信输入**：本轮没有新增外部输入；保存重试直接复用已解析的 `parsed`，没有重新解析模型输出。错误码仍经 `captureErrorCode` 归一化。
- **安全**：没有新增日志输出记忆正文；正文仍走原加密/占位符路径；未发现新的秘密泄露面。
- **资源耗尽/不可撤销操作**：保存重试最多一次，补做仍受 3 次上限约束；但 `#commit` 不是整体事务，部分记忆可能已经落库，重试不会回滚也不会准确报告“部分成功”。
- **规则/文档/代码一致性**：提示词规则不受影响；ADR 0222 关于“更新类会因版本号对不上被拒”的说法与代码不符；中文/日文部分界面标签仍只写“抽取失败”。

## 读代码证实的问题

### 中高：`#commit` 不是整体事务，第二次保存失败后仍删队列并记“放弃”，可能把“部分已存”说成“没记成”

文件：`apps/agent-service/src/production-memory-capture.ts:853-869`、`packages/application/src/services/automatic-memory-service.ts:132-205`、`packages/application/src/services/durable-memory-service.ts:121-163`

`processCommittedRun` 是逐个候选提交的，外面没有总事务：

```ts
for (const [candidateOrdinal, candidate] of candidates.entries()) {
  ...
  const committed = await this.commitCandidate(...);
```

而 `#save` 把任何 `#commit` 异常都当成“本次保存失败”，第二次失败后：

```ts
} catch (second) {
  await backlog.remove(plan.generationId);
  await this.#recordFailure(plan, "capture_gave_up", captureErrorCode(second), "save:2");
  throw second;
}
```

如果第一个候选已经保存、后续候选或 `onCommitted` 失败，第二次仍失败时队列被删、记录为 `capture_gave_up`，但数据库里可能已经有部分记忆。用户会看到“这轮没记成”，实际上有部分内容已经存下；而且之后不会再补做。

`create + supersedes` 还有一个更具体的缺口：

```ts
if (existing) {
  ...
  if (sameProposal) {
    ...
    return existing;
  }
  ...
}
...
if (proposal.supersedes) await this.supersede(proposal.supersedes, saved, generationId);
```

如果第一次已经成功创建新记忆、但紧接着 `supersede` 失败，第二次 `#commit` 会在 `sameProposal` 分支直接 `return existing`，不会再次执行被跳过的 `supersede`。结果是新记忆和旧记忆同时保持 active，旧记忆没有被标成被取代，而第二次保存反而可能被当作成功。

建议：让保存按候选可恢复/幂等，记录每个候选的完成状态；或在 `sameProposal` 分支也补做尚未完成的 `supersede`。至少应在部分保存时不要记录会让人理解为“什么都没存”的 `capture_gave_up`，并补一个“第一个候选已写入、后续失败”的测试。

### 中：ADR 说“更新类再次应用会因版本号对不上被拒”，代码实际会再次更新成功

文件：`docs/adr/0222-retry-and-queue-failed-memory-capture.md:56`、`packages/application/src/services/durable-memory-service.ts:165-203`、`apps/agent-service/src/production-memory-capture.ts:862`

ADR 原话：

```text
已经改过的那条再改会因为版本号对不上被拒
```

但 `applyProposal` 每次都会重新读取当前记录，并用**当前**版本号作为 expectedRevision：

```ts
const current = requireRecord(
  await this.options.state.read(proposal.memoryId),
  proposal.memoryId,
);
...
const saved = await this.saveWithProjection(
  nextRecord(current, {...}, updatedAt),
  current.revision,
  "upsert",
  ...
);
```

所以第二次 `#commit` 对 `update`/`merge` 候选通常不会失败，而是再次成功：版本号再 +1、再追加一条“updated”历史、重写 `updatedAt`。同时 `commitCandidate` 会再次调用 `onCommitted`，提醒会被重新 `schedule`（`sqlite-memory-reminder-operations.ts:98-100` 会把状态重置为 `scheduled`、清空 `dismissed_at`），书籍人物关联也会再执行一次。内容相同的情况下不会产生第二条记忆，但 ADR 用来证明“重复应用安全”的理由不成立，也会产生重复历史/版本变更和重复提醒写入。

建议：要么在更新分支比较内容/属性后做真正幂等，要么修正 ADR，明确“update/merge 会再应用一次，只多一次版本号和历史”，并为更新候选补测试。

### 中低：失败记账本身抛错会挡住第二次保存，或导致 `capture_gave_up` 丢失

文件：`apps/agent-service/src/production-memory-capture.ts:857-866`

```ts
this.options.onFailure(first);
await this.#recordFailure(plan, "capture_retrying", captureErrorCode(first), "save:1");
try {
  await this.#commit(plan, parsed);
} catch (second) {
  await backlog.remove(plan.generationId);
  await this.#recordFailure(plan, "capture_gave_up", captureErrorCode(second), "save:2");
  throw second;
}
```

如果 `onFailure` 或第一次 `#recordFailure` 抛错，第二次 `#commit` 根本不会执行。补做路径下队列行还在，下一轮会重新问模型并拿一份新结果，正好是这轮想避免的重复写入风险。

第二次失败时先 `backlog.remove` 再写 `capture_gave_up`；如果 `remove` 抛错，放弃记录不会写，队列行状态也不确定；如果 `#recordFailure` 抛错，已经删行但没有“放弃”记录。

建议：把保存重试放在关键路径上，失败记账做 best-effort；或在 `finally` 中分别尝试删行和写记录，并保证两者互不阻塞。

### 低：新测试只覆盖 checkpoint 请求失败，没有覆盖“部分写入后重跑”

文件：`test/integration/production-memory-capture.test.ts:2896-2922`、`:2932-2953`

“保存失败后再存一次”的测试把失败注入在 `generations.request`：

```ts
generations: {
  request: async (work) => {
    failures -= 1;
    if (failures >= 0) throw new Error("PORT_CONFLICT");
    return options.generations.request(work);
  },
},
```

`#commit` 在 checkpoint 请求处就失败，此时还没有写任何候选。因此测试虽然证明了“不会重新问模型”，但没有覆盖 create 去重、update/merge 重跑、`supersedes`、待审批、提醒/人物写入这些真正危险的路径。“放弃”测试同样只让 checkpoint 永远失败，也没有实际写到一半的场景。

建议：增加“第一条候选已保存、第二条失败”“create 已保存但 supersede 失败”“update 已成功后再重跑”的测试，断言不出现重复记忆、重复更新历史、未完成的 supersede 会被补上。

### 低：中文/日文部分标签仍写“抽取失败”，与新增的“保存失败”语义不一致

文件：`apps/control-center/src/i18n/resources/zh-CN.ts:959-965`、`apps/control-center/src/i18n/resources/en.ts:1020-1028`

中文仍是：

```ts
"dailyReview.tag.captureRetrying": "记忆抽取失败，已重试",
"dailyReview.tag.captureQueued": "记忆抽取失败，下一轮补做",
...
"dailyReview.captureRetrying": "这轮对话后抽取或保存记忆失败了一次，系统当场又试了一次",
```

说明文字已经改成“抽取或保存”，但标签/周报分组标题（`packages/calibration/src/index.ts` 里的 `memory_capture_failed` 标签）仍只写“抽取失败”。英文标签是泛化的“Memory capture failed”，中文和日文不是。作者关于“说明已改”的说法成立，但标签层面对保存失败会显示成“抽取失败”，容易被误解。

## 推测与未核实

- **进程在补做保存途中崩溃**：补做时队列行要等 `#save` 成功后才删；如果补做已经部分写入记忆但进程崩溃，下一次补做仍会重新问模型（队列里不存已解析结果），仍可能遇到新结果与旧内容冲突或产生近似记忆。ADR 只明确接受了“存成功、删队列行之前”的窗口，没有覆盖“存到一半”的窗口。未核实这是否被认为可接受。
- **版本号被多推一次是否用户可见**：更新候选重跑会让 `revision` 和 `updatedAt` 多变化一次；如果后续提示词里的记忆日期会回退到 `updatedAt`（ADR 0199 的机制），理论上可能影响展示日期，但本轮未继续追踪到 UI/提示词的完整链路。
- **测试执行结果未核实**：受工具限制没有运行 `npm run check:memory-capture-retry`，上述“会失败/不会失败”的判断来自对测试断言的阅读。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会（就本轮改动而言）。本轮只改了 `#save`、`#retryTurn`、`#replayOne` 的保存流程，没有改 `#plan`、`memoryCapturePrompt`、系统提示、工具定义、历史组装或遮盖；保存失败路径不调用 `#extract`/`generate`，只再次 `#commit`。测试也断言保存失败时模型调用仍只有一次。已有的补做路径会按当前记忆状态重建提示词，那本来就不是与原轮逐字节相同，但这是上一轮已有行为，本轮没有新增每轮变化值到系统提示或工具定义。模型请求仍然遵守“固定内容在前、变化值在最后”的原规则。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   本轮没有新增这种风险。重试使用的是同一个 `parsed` 对象；正文引用按 `${generationId}:${ordinal}` 生成，`sourceRefs` 排序也是确定的，没有新增时间字段或无序集合进入模型请求。`save:1`/`save:2` 只是决策记录 id 的哈希输入，不发给模型。唯一需要留意的是更新候选重跑会改数据库里的 `updatedAt`/`revision`；这不是模型请求字节，但如果未来提示词用 `updatedAt` 显示日期，可能产生边缘影响（未核实）。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有检查：`scripts/check-memory-capture-retry.mjs` 要求 17 条 `[P3-5]` 测试通过；按源码计数正好 17 条（集成测试 11 条 + 迁移合同测试 6 条含参数化）。新测试能覆盖“保存失败只重存一次、不再问模型”和“两次保存失败删队列、记放弃”。从断言看，如果把 `#save` 改回重新问模型，两个新测试的调用序列断言会失败；如果去掉保存重试，第一个新测试的 `activeMemories` 断言会失败；如果去掉放弃/删队列逻辑，第二个新测试会失败。但部分写入、update/merge 重跑、`supersedes`、提醒/人物写入、失败记账抛错都没有反向用例，ADR 的关键安全论证没有被测试守住。未实际运行测试。

4. **改动产生或修改的每个值，两端都能接受吗？**
   - `save:1`、`save:2`：只传给 `captureLedgerId` 做哈希（`production-memory-capture.ts:694-696`、`:860`、`:865`），不会作为字段写库，也没有外部校验，不需要额外枚举。
   - `capture_retrying`、`capture_gave_up`：已被 `packages/application/src/ports/decision-ledger.ts:48-62` 的结果值联合类型、迁移 0088 的 CHECK（`0088_memory_capture_backlog.sql:67-68`）、校准分组（`packages/calibration/src/index.ts:273-275`）和网页映射（`proactive-reminders.tsx:336-364`）接受。
   - i18n 只改文案、键名未变，三种语言都有对应项。
   - 真正存在的“两端不一致”不是枚举值，而是 `update/merge` 的版本号假设：ADR 认为会被版本号拒绝，实际 `applyProposal` 用刚读出的当前版本号作为 expectedRevision，会再次成功（见问题 2）。
