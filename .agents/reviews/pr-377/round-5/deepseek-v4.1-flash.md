## 复核结论（050f0a0，增量 516c5af..050f0a0）

### 一、读代码证实的问题（按严重度）

**1. 中：新加的“删行失败不补做”测试实际上没有走到 `#abandoned`，删掉该机制测试仍会通过**
- `test/integration/production-memory-capture.test.ts:2964`：`let removeFailures = 1;`
- 同文件 `:2972-2976`：包装后的 `remove` 在 `removeFailures >= 0` 时抛 `PORT_UNAVAILABLE`。
- `apps/agent-service/src/production-memory-capture.ts:870`：`#save` 在 `#commit` 成功后也会无条件 `await backlog?.remove(plan.generationId);`。
- 该用例第 2 轮自己的捕获用 `'{"memories":[]}'`，`#commit` 在 `production-memory-capture.ts:1164` 提前返回，随后执行到 `:870` 的 `remove`。这是包装后 `remove` 的**第一次**调用，恰好把唯一的注入失败消耗在“成功保存后的清行”上。
- 真正补做写失败时（`:862` 的 `remove`）计数已变成负值，于是**删除成功**，`:863` 把 `#abandoned` 清掉，队列行也被真正删掉。第 3 轮不再补做是因为行已经没了，不是因为 `#abandoned` 生效。
- 因此删掉 `:860` 的 `add` 和 `:884-888` 的 abandoned 分支，这个测试仍会通过；“补做写失败且删行失败一次后下一轮不再补做”没有被验证。
- 建议：把失败注入限定到目标任务（例如只在 `generationId === "memory-capture:run-memory-capture"` 时失败），或改成 `removeFailures = 2`；并在第 2 轮后断言 `backlogRows` 仍为 1、`capture_gave_up` 仍为 1，第 3 轮后断言没有 `:backlog` 模型调用且行为空。

**2. 中低：ADR 决定 3 与决定 4/代码仍然矛盾，“写了放弃才删”与实现不符**
- `docs/adr/0222-retry-and-queue-failed-memory-capture.md:55`：`队列行要等这一轮存进记忆、或者写了“放弃”才删`
- 同文件 `:56`：`存失败时删掉队列行（如果有），写一条 capture_gave_up`
- `production-memory-capture.ts:861-867`：先 `remove`，成功后才 `recordFailure("capture_gave_up")`。
- 所以决定 3 的说法（先写放弃再删）不成立，决定 4 与代码一致。若进程在删行后、写记录前退出，队列行和“这轮没记全”的决策记录都会消失，这与“等写了放弃才删”正好相反。
- 建议：要么代码改成先写 `capture_gave_up` 再删行（记录失败时保留行，更安全），要么把决定 3 改成“删行后写放弃；删行失败时保留 abandoned 标记”，让三处一致。

**3. 低：ADR 决定 5 说入队的只有“模型调用失败”，现在还包括 `assertActive`/登记生成失败**
- `docs/adr/0222-retry-and-queue-failed-memory-capture.md:57`：`进入队列的轮次是模型调用失败、还没开始存的`
- `production-memory-capture.ts:1121-1127`（`#prepare` 在抽取后调用 `assertActive` 和 `generations.request`），`:798-812` 的失败会进入 `#retryTurn`，`:834` 入队。
- 建议：改成“还没开始写记忆的失败（模型调用、运行失效、登记生成等）”。

**4. 低：`#abandoned` 可能永久增长，并卡住队列头**
- `production-memory-capture.ts:884-887`：只有被补做读到且 `remove` 成功时才删除标记。
- `packages/persistence-sqlite/src/sqlite-memory-capture-backlog-operations.ts:90-109`：`oldest` 固定取 `ORDER BY ... LIMIT 1`。若这一条的 `remove` 持续失败，每轮都会读到同一条、抛错，后面的队列行永远轮不到。
- `production-memory-capture.ts:860` 在“本轮从未入队”的正常路径也会先 `add`；若 `:862` 的 `remove` 抛错，标记会永久留下（该 generation 不会再有队列行）。
- 建议：对无对应行的标记做清理/上限；或删行持续失败时改用“记下并跳过”而不是每轮重试同一条。

**5. 信息（既有问题，非本轮引入）：成功保存后的清行失败未捕获，会给下一次补做造成重复写入**
- `production-memory-capture.ts:870`：`await backlog?.remove(...)` 不在 `try/catch` 内。
- 若记忆已保存成功但删行失败，行留在队列里，下一次补做会重新问模型并再次提交，产生 ADR 所说的近似重复；而 ADR 决定 5 只把这个窗口描述成“进程恰好在存成功、删行前重启”（`:57`）。本轮新测试恰好在不知情的情况下触发了这条路径（见问题 1）。
- 建议：至少 `catch` 并上报；或把“保存成功但删行失败”也纳入 abandoned 类处理，并同步 ADR 措辞。

### 二、推测 / 未核实

- **测试存在时序依赖（推测会偶发）**：`start()` 返回的是首个模型准入的 `admitted`（`production-memory-capture.ts:743,764`），不是整轮完成。新测试在 `:2981` 启动第 2 轮后没有 `stop()` 或等待其补做完成，就在 `:2984` 启动第 3 轮；若第 3 轮补做先于第 2 轮补做读到队列头，调用顺序和注入的删行失败落点都会变。建议在轮次之间等待工作结束，或每轮用独立实例并 `stop()`。
- **补做时模型变化**：登记查重包含 `modelDescriptorRef`（`sqlite-checkpoint-operations.ts:292`），若原轮与补做轮之间换了模型，同一身份会报 `PORT_CONFLICT` 并消耗补做次数。这是既有行为，本轮未改，但 `#prepare` 把登记失败纳入补做后影响面变大。
- 未运行测试；上述“测试仍会通过”的判断来自对 `#save` 调用顺序和第 2 轮输出的逐步推演，未实际执行。

### 三、侧重检查

- **错误路径**：`#prepare` 失败走同轮重试/排队（`:798-812`、`:836-851`）；`#commit` 失败写放弃（`:857-868`）；删行失败靠 `#abandoned`（`:860-864`、`:884-888`）；写记录失败被 `catch`（`:865-867`）。发现测试未覆盖 abandoned、文档与删行顺序不一致。
- **不合规范/不可信输入**：本轮没有新增外部输入解析。登记入参来自已读出的线程与消息；`backlog.enqueue` 校验长度、错误码和时间，并要求线程存在（`sqlite-memory-capture-backlog-operations.ts:56-68`）。未发现新校验缺口。
- **安全**：未改提示词与遮盖，未新增日志输出秘密；`#abandoned` 只存生成编号。
- **资源耗尽**：见问题 4（集合增长、队列头阻塞）。
- **不可撤销操作**：见问题 2（先删行后写放弃，崩溃会静默丢失通知）。
- **规则/文档一致性**：ADR 决定 3/4/5 与代码的出入见问题 2、3；测试条数 18 与脚本、ADR、案例集一致（已核对）。

### 四、必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。增量只改后台记忆捕获的 `#prepare/#save/#replayOne`，没有动 `memoryCapturePrompt`（`production-memory-capture.ts:177-200`）、`#plan` 的提示词组装、遮盖表或主对话请求。同轮重试复用同一个 `plan`，`plan.tag ??=`（`:1088`）保证遮盖标签不变，`plan.prompt` 不变，因此重试请求逐字节相同。每轮变化的值（`requestedAt`、`clock.now()`）只写数据库，不进模型输入。发给主模型的内容仍只在末尾追加，系统提示、工具、历史、遮盖均未被本改动触碰。
2. **同一段文字会不会在不同请求里变成不同字节？** 本轮重试不会：同一 `plan`、同一 `tag`、同一 prompt。没有新增依赖前后文的遮盖或时间字段到提示词。`#abandoned` 是 `Set`，只做 `add/has/delete`，不遍历、不序列化，不影响顺序。补做本来就按当前记忆状态重建提示词（ADR 决定 5，非本轮引入），不是原轮逐字复刻。
3. **有没有自动检查，反向用例真的会失败吗？** 有门槛：`scripts/check-memory-capture-retry.mjs:13` 的 `REQUIRED = 18`，实测 12 条集成 + 6 条迁移契约（1 条 + `it.each` 3 条 + 2 条），与 ADR:95、案例集:278 一致。登记失败重试用例有效（若把登记留在 `#commit`，会走放弃分支，测试会失败）。但 `#abandoned` 的反向用例不成立：删掉 `#abandoned` 相关代码该测试仍通过（见问题 1）。脚本只检查通过条数 ≥ 18 和退出码，不校验具体用例名，理论上可用其他 `[P3-5]` 用例凑数而不被发现。
4. **每个新值的使用端都能接受吗？** 逐个核对：
   - `capture_retrying`/`capture_queued`/`capture_gave_up`：`decision_ledger` 对 `kind=memory_candidate` 接受这三个值（迁移契约测试 `:167-180`），未知值被拒（`:182-185`）；本轮无新结果值。
   - 原因码 `PORT_CONFLICT`：`captureErrorCode` 允许大写码，`backlog.enqueue`/`recordAttempt` 用 `^[A-Z][A-Z0-9_]{0,127}$` 校验；列本身是文本。
   - 生成登记：`threadDistillation.request` 以 `(threadId, sourceWatermark, policyVersion)` 查重，字段一致时返回已有行（`sqlite-checkpoint-operations.ts:280-299`），所以重试/补做重复登记是幂等的；本轮“登记成功后再重试”的路径实际不可达（登记是 `#prepare` 最后一步，之后失败只会进 `#commit` 并放弃），但幂等性本身成立。
   - backlog 项：`generationId`/`sourceRunId` ≤256、错误码格式、时间合法，且要求线程存在（`sqlite-memory-capture-backlog-operations.ts:56-68`）；入队时 `plan` 刚读过同一线程。
   - 测试条数 18 的三处使用（脚本、ADR、案例集）一致；`#abandoned` 仅类内部使用。
   - I-73 类问题（生成的 id 能否通过后端校验）没有新增：新产生的仍是既有 outcome 值和合法错误码，均已核对后端校验。
