## 结论

两处修改的方向和主逻辑都成立；**未发现会改变模型可见请求前缀/字节的缺陷**。下面按严重度列出我发现的风险，先写读代码证实的，再写推测。

---

## 已读代码证实的问题

### 1. 中：发请求前 await 的 threadOfRun 不受取消/超时约束，可能拖延取消与预算结算

- 文件:行：`packages/runtime-pi/src/pi-model-transport.ts:245-255`、`:300`、`:347`；`packages/platform-node/src/trusted-model-provider.ts:203`
- 问题：`#egressContextFor` 在真正发请求前 await 一次数据库读，且没有和 `request.signal` / 请求超时竞争。模型预算已经被 `markStarted()` 标为已开始，若这次读很慢或卡住，取消信号无法及时打断，预算 permit 也不会及时结算。
- 证据：
  - `pi-model-transport.ts:251`：`return { ...context, threadId: await this.#egressThreadOf(runId) };`
  - `pi-model-transport.ts:300`：`const exchange = this.#egress.exchange(await this.#egressContextFor(request.runId));`
  - 下一次取消检查在 await 之后：`pi-model-transport.ts:347`：`request.signal?.throwIfAborted();`
  - `trusted-model-provider.ts:203`：`await permit.markStarted(); started = true;`，随后 `:232-237` 才进入 transport 的 `for await`。
- 建议：把 `#egressThreadOf` 与 `request.signal`（或一个很短的超时）做 `Promise.race`，取消时立即按“无 threadId”继续或直接失败；并确保审计元数据的读取不能阻塞模型调用和 permit 结算。

### 2. 低：次数核对会把“重复出现但只识别到部分”的正常输入判 null，邮件审计退回不同窗口的近似

- 文件:行：`packages/sensitive-capture/src/redaction.ts:344-380`；`packages/application/src/services/proactive-mail-check-service.ts:191-193`、`:224`
- 问题：同一个值出现多次而只有部分被识别时（例如同一个 token 既在 `Bearer …` 里又在正文单独出现；或 token 也出现在已被 private-key 规则整段替换的块里），新代码必然返回 null。遮罩本身不受影响，但邮件审计会退回 `findSensitiveValues(windowMailBody(body, limit).text)`；而实际发给模型的是 `windowMailBody(masked(item.body), bodyLimit)`。两者窗口基准不同，边界附近可能漏记实际发送过的敏感项。
- 证据：
  - `redaction.ts:356`：`for (const [value, count] of sighted) if (occurrences(input, value) !== count) return null;`
  - `proactive-mail-check-service.ts:193`：`if (located === null) return findSensitiveValues(windowMailBody(body, limit).text);`
  - `proactive-mail-check-service.ts:224`：`const windowed = item.body === null ? undefined : windowMailBody(masked(item.body), bodyLimit);`
- 建议：fallback 也要基于“先遮罩再截断”的同一字节序列计算窗口；或给“重复值但位置不确定”的情况保留 span、只标记不确定，而不是整体退回原文窗口。

### 3. 低：线程修复的“反向用例”不是可自动复现的红绿测试，生产接线也没有端到端覆盖

- 文件:行：`test/integration/sensitive-interceptions.test.ts:218-244`；`packages/runtime-pi/test/pi-model-transport.unit.test.ts:519-535`
- 问题：新集成用例先自己调用 `threadOfRun` 拿到 `threadId`，再显式把它传给 `record`；这只能证明“record 不再按 run 查对话”，不能证明“PiModelTransport 在发请求前解析并上报了 threadId”。它不是旧代码上会自动失败的反向用例（旧代码没有 `threadOfRun`，且只删掉写库时的 run 查询这条用例仍会通过）。`service-main` 的接线确实没有测试。
- 证据：
  - `test/integration/sensitive-interceptions.test.ts:221`：`const threadId = await store.threadOfRun({ ...scope, runId: createRunId("run-si") });`
  - `:237-240`：`const result = await store.record({ ...scope, observations: [observation({ threadId, ... })] ...})`
  - `packages/runtime-pi/test/pi-model-transport.unit.test.ts` 只覆盖 mock 的 `egressThreadOf` 成功/抛错/只查一次。
- 建议：补一条从 `PiModelTransport`（或 `createProductionModelComposition`）经 recorder 到 SQLite 的用例：运行存在时发送、发送后删除 run、flush 后断言记录仍挂在原 thread；再补一条不传 `egressThreadOf` 时 threadId 为 null 的对照。

---

## 推测/未完全证实

- 若 production 里的 SQLite worker 卡住而不是直接报错，上面的 await 可能长期不返回，导致 action-review 一直挂在 `model.started` 之后、预算 permit 不结算。控制流已证实；worker 长时间卡死属于推测。
- 对未知 run（`runs` 无此行）的 action-review，新行为会写入 `threadId=null` 的记录而不是丢弃。这是有意改变，但会让没有对话归属的记录出现在列表里；是否可接受取决于产品语义，属于设计取舍而非确定缺陷。
- `threadOfRun` 对 `runId` 限长 256；若有合法的超长合成 runId，会查询失败并按 null 上报。未在代码中找到超长 runId 的来源。

---

## 侧重检查

- 错误路径：`egressThreadOf` 抛错/同步抛错都被 `catch` 吞掉并退回原 context（`pi-model-transport.ts:250-254`），不会阻断模型请求；问题是不会及时响应取消。
- 不可信输入：`threadOfRun` 用参数化 SQL，并按 `owner_id/agent_id/id` 过滤（`sqlite-sensitive-interception-operations.ts:232-235`）；`runId` 非空且 ≤256 才放行。未发现注入或跨 owner/agent 读取。
- 删除竞态：`record()` 对非 null `threadId` 仍做 `threadExists` 检查（`:136-143`）；迁移 0078 的复合外键 `(owner_id, agent_id, thread_id) → threads` 带 `ON DELETE CASCADE`（`0078_sensitive_interceptions.sql:25-26`），`threads` 有对应 `UNIQUE(owner_id, agent_id, id)`，`runs.thread_id` 是 `ON DELETE SET NULL`，与“删 run 不删记录、删 thread 级联删记录”的设计一致。
- 不可撤销操作：对话删除会通过外键级联永久删除拦截记录（已由集成测试覆盖）；这是明确的设计选择，但意味着审计记录随对话消失。
- 资源：每次 action-review 都多一次 SQLite 读；`occurrences` 对每个不同值全量扫描正文，邮件正文上限 20 万字符，最坏情况下 CPU 成本约为旧实现的数倍（与旧的逐次 `indexOf` 同阶，不是新量级）。
- 红action 边界：`machinePositions` 对空值有保护（`redaction.ts:349`），`occurrences` 按 `value.length` 前进不会死循环；重叠检查只看排序后的相邻项，但同一值不可能在同一位置被两条规则同时识别，未发现漏判。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。两处修改都不碰模型可见内容：

- `machinePositions` 只被 `locateMaskedValues` 使用，后者只出现在 proactive 邮件审计（`proactive-mail-check-service.ts:192`）；`redactForEgress` 的实际遮罩输出没有变，`machine-secrets.ts` 新增的 `observe` 只旁路观察、不改变替换结果。
- `egressThreadOf` / `threadId` 只进入 `ModelEgressContext` 的上报，`ModelEgress` 不会把它写进请求体；`pi-model-transport.ts:300` 只是把 context 交给 `exchange` 用于 report。
- 因此仍然是“只在末尾追加”，每轮会变的值仍只在最后一条消息里；没有改系统提示、工具定义、历史或遮罩字节。`prompt-prefix.compat.test.ts:447-478` 的 `[SI-2]` 也断言有上报和无上报时请求体逐字节相同。

### 2. 同一段文字在不同请求里会不会变成不同字节？

对模型可见文本不会：

- 遮罩 key、placeholder 生成规则、`machinePositions` 都不改变 `redactForEgress(...).text`。
- 新增的 `threadId` 是数据库元数据，只影响审计记录及其去重键，不进入请求。
- 审计批次的 Map 插入顺序不进入模型；SQLite 的 upsert 结果也不依赖批次顺序。

### 3. 有没有对应的自动检查，反向用例真的会失败？

- 红action：有。`redaction.unit.test.ts:263-273` 的 “Bearer 里和单独各有一个同样的密钥” 用例在旧 `indexOf` 逻辑下确实会得到错配结果，会失败；同文件 `:275-279` 验证重复值仍可定位。
- 线程修复：部分有。`pi-model-transport.unit.test.ts` 覆盖 `egressThreadOf` 成功/抛错/只查一次；集成测试覆盖 `threadOfRun` 的 owner/agent 范围、run 删除后写入仍保留、thread 删除级联。但**没有**一条真正跑通 `service-main → PiModelTransport → recorder → SQLite` 的用例，也没有一条能在旧实现上自动失败的端到端反向用例；作者也承认生产接线只有类型检查和组合测试覆盖。

### 4. 新增/修改的每个值，生产者和消费者两端都能接受吗？

- `sensitiveInterception.threadOfRun`：生产端在 `durable-adapters.ts:1080`，消费端在 `sqlite-sensitive-interception-operations.ts:102-103`，名字一致；worker 按 `sensitiveInterception.` 前缀路由（`sqlite-durable-operations.ts:580-581`），没有额外白名单会拒绝它。
- `threadOfRun` 输入：`SensitiveInterceptionRunInput` 沿用 `validScope`（owner/agent 非空且 ≤256）和 `runId` ≤256；SQL 用 owner+agent+id 过滤，调用方 `service-main.ts:299-304` 传的是配置里的 owner/agent，范围正确。
- `SensitiveInterceptionObservation.runId` 删除：当前代码中没有残留的生产者再传该字段；`validObservation` 已去掉校验，`sensitiveInterceptionDedupeKey` 本来就不含 runId；recorder 现在用 `context.threadId`（`sensitive-interception-recorder.ts:70`），两端一致。
- `egressThreadOf`：`PiModelTransportOptions` 接受，`production-model-composition.ts:337` 传入，`service-main.ts:299-304` 生产接线；旧的 `egressRunScoped` 已无引用。
- 迁移 0078 的 `thread_id` 可空、复合外键与 `threads` 的唯一约束匹配；`list/summarize/clear` 都接受 `threadId=null`；删除路径先删 runs 再删 threads，级联删除生效（集成测试 `:288-323` 覆盖）。
- 唯一需要留意的两端差异是：`threadOfRun` 对超长/不存在的 runId 和“run 在但 thread_id 为空”都返回 null，会被写成无对话记录；这符合当前设计，但会改变旧的“查不到 run 就丢弃”语义。
