## 复核结论（按严重度）

### 1.（中）`#save` 把所有 `#commit` 失败都当成“存了一部分”，连“还没写过记忆”的错误也永久放弃并删队列行

**位置**：`apps/agent-service/src/production-memory-capture.ts:853-863`、`1113-1150`

**证据（亲自读到）**：

```ts
// 853
async #save(plan: CapturePlan, parsed: ParsedMemoryCandidates): Promise<void> {
  const { backlog } = this.options;
  try {
    await this.#commit(plan, parsed);
  } catch (error) {
    if (!backlog) throw error;
    await backlog.remove(plan.generationId).catch(this.options.onFailure);
    await this.#recordFailure(plan, "capture_gave_up", captureErrorCode(error), "save").catch(...);
    throw error;
  }
```

而 `#commit` 的前两步在写任何候选之前：

```ts
// 1113
await this.options.assertActive();
if (parsed.candidates.length > 0)
  await this.options.generations.request({ ... });   // 1115
...
await service.processCommittedRun({ ... });           // 1150，真正的逐条写入
```

也就是说，`assertActive` 失败、`generations.request`（检查点登记）失败，发生时**一条候选都还没写**，但 `#save` 仍会删掉待补行、写 `capture_gave_up`、永久放弃。`PORT_CONFLICT` 在 ADR 第 1 条和 `SAME_TURN_RETRYABLE_CAPTURE_ERRORS` 里被当作可重试的偶发错误（`production-memory-capture.ts:665-675`），但在检查点登记处发生同样的 `PORT_CONFLICT` 却直接放弃，前后不一致。测试 `test/integration/production-memory-capture.test.ts:2896-2921` 注入的正是 `generations.request` 的 `PORT_CONFLICT`，所以它验证的是“还没写就放弃”，并没有验证“写了一半再放弃”。

**推测**：`assertActive` 在服务失去 authority 租约或关闭/切换时也可能抛 `PRODUCTION_AUTHORITY_NOT_ACTIVE`/`PRODUCTION_AUTHORITY_LOST`，同样会被当作存失败而删行，另一进程本可补做的数据被永久丢掉。

**建议**：让 `#commit` 区分“写前失败”（`assertActive`、`generations.request` 以及可识别的生命周期/准入错误）和“写中失败”；前者保留队列行并走同轮重试/补做，只有真正开始逐条写之后的失败才按“可能已写一部分”放弃。至少应把 `PRODUCTION_AUTHORITY_*` 和检查点登记错误排除在“不可恢复的存失败”之外。

---

### 2.（中）删队列行失败被吞掉后，待补行仍在，下一轮会重新问模型并再存一遍，正好违背“存失败不重试、不排队”

**位置**：`apps/agent-service/src/production-memory-capture.ts:859-863`；`packages/persistence-sqlite/src/sqlite-memory-capture-backlog-operations.ts:131-135`

**证据（亲自读到）**：

```ts
await backlog.remove(plan.generationId).catch(this.options.onFailure);
await this.#recordFailure(plan, "capture_gave_up", ...).catch(this.options.onFailure);
throw error;
```

`remove` 只是 `DELETE FROM memory_capture_backlog WHERE generation_id = ?`。`catch` 只上报，不阻断后续；删行失败时这一行仍会被 `#replayOne` 的 `backlog.oldest(...)` 选中，下一轮重新调用 `#extract` 和 `#commit`。ADR 第 4 条说“存失败时删掉队列行……不重试、不排队”，第 5 条说“进入队列的轮次是模型调用失败、还没开始存的，所以补做不会和原轮重复”——这两条在删行失败时不成立，而且会重现 ADR 想避免的“换一份结果再存导致近似记忆/重复更新”。

**建议**：把“删除待补行 + 写 `capture_gave_up`”做成同一个数据库操作/事务；或者给行加 `abandoned` 状态，让补做查询跳过它，而不是依赖一次可能失败的 `DELETE`。仅 `.catch(onFailure)` 只留痕，不能阻止后续补做。

---

### 3.（中低）ADR 内部自相矛盾：第 3 条说“只有存入记忆后才删队列行”，第 4 条和代码却在存失败时删行

**位置**：`docs/adr/0222-retry-and-queue-failed-memory-capture.md:55-57`

**证据（亲自读到）**：

- 第 55 行：“只有结果存进记忆之后才删掉队列行，所以进程在重试途中重启，这一轮还在队列里。”
- 第 56 行：“所以存失败时删掉队列行（如果有），写一条 `capture_gave_up`……”
- 第 57 行：“只有在‘存成功、删队列行之前’进程恰好重启时，下一次补做才会再存一遍……本 ADR 接受它。”

第 3 条与第 4 条直接冲突。第 5 条列举的重存窗口也只覆盖“存成功、删行前重启”，没有覆盖“存失败、还没删行时进程崩溃”这一窗口；在该窗口里队列行还在，重启后补做会重新问模型并重存，正是第 4 条要避免的情况。

**建议**：把第 3 条改成“正常保留到存成功或明确放弃时”；第 5 条补充“存失败到删行之间崩溃仍可能重放”，或直接采用第 2 条的原子放弃操作把这个窗口消掉。

---

### 4.（低）案例集仍把“写冲突”写成同轮会重试，和新行为不符

**位置**：`docs/engineering-casebook.md:275`

**证据（亲自读到）**：

> “可能是偶发的错误（超时、限流、上游不可用、JSON 不合法、写冲突等）同轮用同一份提示词字节重试一次；……模型已经给出结果、存的时候失败的，不重试也不补做……”

同一段里“写冲突”先被列为会重试，后面又说存的时候失败不重试。代码里 `#save` 对 `PORT_CONFLICT` 只写放弃、不重试（`production-memory-capture.ts:857-863`）。ADR 第 1 条的 `PORT_CONFLICT` 只适用于模型调用路径，不是存路径。

**建议**：把“写冲突”从同轮重试的错误举例里删掉，或明确写成“模型调用阶段的错误；存阶段的写冲突不重试”。

---

### 5.（低）测试用例的注入点和标题不符，且缺少删行失败/生命周期失败的反向用例

**位置**：`test/integration/production-memory-capture.test.ts:2896-2921`、`2924-2953`

**证据（亲自读到）**：同轮用例 `setup(P3_5_MESSAGE, P3_5_MEMORY)` 后仅让 `generations.request` 抛 `PORT_CONFLICT`：

```ts
generations: {
  request: async (work) => {
    failures -= 1;
    if (failures >= 0) throw new Error("PORT_CONFLICT");
    return options.generations.request(work);
  },
},
```

失败点在 `#commit` 的检查点登记（`production-memory-capture.ts:1115`），而不是 `processCommittedRun` 的逐条写入（`:1150`）。它证明了“不再存第二次”，但没覆盖第 3 轮指出的真实场景：新记忆已建好、取代/更新那一步失败后的状态。补做用例同样使用恒定 `PORT_CONFLICT`，也没有覆盖删行失败时行仍被下一轮补做的情况。

**建议**：在自动记忆服务写第一条候选后注入失败，断言只写一次 `capture_gave_up` 且不重存；另加“`backlog.remove` 抛错时下一轮不得再补做”的用例（或作为第 2 条修复后的回归用例）。

---

## 侧重检查（错误路径、不可信输入、安全、资源、文档一致性）

- **同轮路径的 `#busy`**：`#extract` 失败后先 `#busy.add`，`#retryTurn` 和失败后的 `#save` 都在 `try/finally` 内，`finally` 删除；失败不会遗留 busy 条目（`production-memory-capture.ts:802-811`）。正常路径没有队列行，因此不占 busy 也一致。
- **补做路径的 `#busy`**：`#replayOne` 在 `#save` 外包了 `try/finally`，删除发生在保存失败抛出之后（`:877-911`），状态一致。
- **`capture_gave_up` 的 id 冲突**：ledger id 由 `generationId:outcome:attempt` 哈希（`:694-695`、`:922`）。`save`、`turn:1`、`turn:2`、`backlog:N` 都在不同 outcome/attempt 组合里，不会互相冲突。同一生成编号正常路径最多写一次 `save`；只有在第 2 条“删行失败后再补做再存失败”或进程崩溃重放时才可能再次产生同一 id，而 `insertLedgerRow` 是 `ON CONFLICT (id) DO NOTHING`（`sqlite-decision-ledger-operations.ts:98-107`），会静默丢弃第二条，不会抛错。
- **后端校验**：`capture_gave_up` 在 `DECISION_OUTCOMES`（`decision-ledger.ts:43-57`）、迁移 0088 的 CHECK（`0088_memory_capture_backlog.sql:67-68`）和 `isMemoryCaptureFailure`（`:59-69`）里都被接受；ledger id `ledger:`+40 位十六进制 = 47 字符，低于 128 上限；`reasonCode` 截到 64，符合校验；`subjectRef`（生成编号）远低于 256。逐项核对后没有发现“清单值过不了后端校验”的 I-73 类问题。
- **待补表输入**：`enqueue` 校验 generationId/sourceRunId/错误码/时间，校验 thread 存在；`recordAttempt` 校验错误码和时间；`remove` 幂等 DELETE（`sqlite-memory-capture-backlog-operations.ts:56-135`）。`captureErrorCode` 用 `^[A-Z][A-Z0-9_]{0,127}$` 过滤，不会把任意错误文本写进表或 ledger（`production-memory-capture.ts:684-692`）。
- **安全/资源**：改动只写元数据（generationId、错误码、时间），不写提示词或原文；`#captured` 上限 1000，`#busy`/`#pending` 都在 `finally` 清理，没有新增无界集合；队列每轮最多补做一条，没有新增无限循环。
- **文案与 i18n**：`en.ts`、`ja.ts`、`zh-CN.ts` 三个键都改了，`message-ids.ts` 里键仍存在；`proactive-reminders.tsx:336-341,360-365` 仍按 `capture_gave_up` 取值，校准分组和每日评价仍识别该结果值。唯一语义问题是该结果值同时用于“补做 3 次模型失败（什么都没存）”和“存失败（可能存了一部分）”，`这轮没记全` 对前者略宽泛，但不属于代码错误。
- **文档**：ADR 第 4/6/7 条与代码一致；第 3/5 条和案例集第 275 行存在上述不一致。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

本轮增量（`a27e10e..516c5af`）只改了 `#save` 和历史记录/文案，没有改 `memoryCapturePrompt`、`#extract`、工具定义、系统提示、历史消息或遮盖逻辑（diff 只落在 `production-memory-capture.ts:853-866` 等失败处理处）。发给模型的内容仍然是在既有提示词末尾追加；同轮重试复用 `plan.prompt` 和 `plan.tag`（`plan.tag ??=`，`:1071-1079`），第二次请求与第一次逐字节相同。补做路径会按当前记忆状态重建提示词（ADR 第 5 条），所以补做与原轮不是逐字相同，但那是新的捕获请求，不是修改已发给模型的请求开头；ADR 已明确说明。结论：本轮改动不改变已见请求开头。

**2. 会不会让同一段文字在不同请求里变成不同字节？**

本轮改动不触及遮盖、标签生成、时间字段或集合排序，因此不会。同轮重试复用同一 `plan.tag` 和同一份 `plan.prompt`。补做会让“已有记忆”反映当前状态、并重新分配标签，所以补做请求的字节可能与原轮不同；这是既有设计、ADR 第 5 条已承认，不是本轮引入。另需注意：上面第 3 条指出的“存失败到删行之间崩溃”会让同一生成编号在补做里换一份模型结果再存，属于跨请求的重复写入风险，而不是同一段文字被改写。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有。`scripts/check-memory-capture-retry.mjs` 运行 `[P3-5]` 测试并要求至少 17 条通过；实际计数为 11 条集成测试 + 6 条迁移契约测试（其中 `it.each` 三条），正好 17 条，和案例集说法一致。两个被修改的用例在旧行为下会失败：旧代码会对同一结果再调一次 `generations.request`，而 `2901-2910` 的包装在第一次抛 `PORT_CONFLICT`、第二次成功，旧代码会留下 `memory:...:0` 和 `capture_retrying`，与现在断言的“无记忆、`capture_gave_up`、无队列行”冲突；补做用例旧代码会同时写出 `capture_retrying` 和 `capture_gave_up`，也与现在的断言冲突。不足是：没有覆盖真正的“逐条写入中途失败”、没有覆盖删行失败、没有覆盖 authority/准入失败，且现有“存失败”用例的注入点在写任何候选之前（见第 5 条）。

**4. 每个改动值的产生处和使用处是否都能接受？**

- `capture_gave_up`（本轮新增“存失败”来源）：产生处 `production-memory-capture.ts:860`；使用处 `decision-ledger.ts:43-69`、`0088_memory_capture_backlog.sql:67-68`、`daily-review.ts:5,216,229,331`、`calibration/src/index.ts:273-277`、`proactive-reminders.tsx:340-341,364-365`、三语资源与 `message-ids.ts`。全部接受该结果值，键也齐全。
- ledger id 的 `save` attempt：产生处 `:860`，经 `captureLedgerId` 哈希；使用端 `sqlite-decision-ledger-operations.ts:49-58,98-107` 的长度/字符/冲突规则都能接受，正常路径不会和 `turn:N`、`backlog:N` 冲突，重复 id 由 `ON CONFLICT DO NOTHING` 吞掉。
- `backlog.remove`：产生/使用在 `:859`，SQLite 端 `sqlite-memory-capture-backlog-operations.ts:131-135` 是幂等 DELETE；问题不在校验，而在失败时行为（见第 2 条）。
- 三语文案与 `schema-catalog.ts` 描述：没有校验器，改动后语义与代码一致；但 ADR 第 3/5 条和案例集第 275 行尚未同步（见第 3、4 条）。
