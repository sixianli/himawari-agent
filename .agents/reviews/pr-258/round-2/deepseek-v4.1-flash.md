## 按严重度排列

### 1. 高：对话在写入前被删时，`runId` 已查不到对话，后台记录仍会留下

- **文件:行**：`packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:121-152`、`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:145`
- **问题**：`runs.thread_id` 是 `ON DELETE SET NULL`。对话删除后，run 行的 `thread_id` 会被置空，之后才落库的拦截记录执行 `runThread` 只能得到 `null`，于是仍以 `threadId = null` 保存，不会跟随对话删除。这正好击穿作者第 2 条修复想解决的核心场景。
- **证据（读代码证实）**：
  - 迁移里：`thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,`
  - 查对话：`SELECT thread_id FROM runs WHERE owner_id = ? AND agent_id = ? AND id = ?`
  - 解析逻辑：`observed.threadId === null && observed.runId ? ... ?? null : observed.threadId`
  - 只有解析出非空 `threadId` 才检查 `threadExists` 并跳过：`if (item.threadId !== null && !threadExists.get(...)) { skipped += 1; continue; }`
- **影响**：清除/删除对话时已经有记录的行会被级联删掉；但在 200ms 写队列延迟、进程关闭前 flush、或并发清空等窗口里，对话先删、记录后写时，这条记录会永久保留为“无对话”行。run 不存在时同样静默退化为 `null`，现有测试也认可这种结果。
- **建议**：在观察发生时就把 threadId 捕获进观察记录（而不是只存 runId 到写库时再查）；或给 `sensitive_interceptions` 持久化 `run_id` 并建立可清理路径；至少在 run 存在但 `thread_id` 为空时区分“本来无对话”和“对话已删”，不要一律保留。

### 2. 中：邮件“只记录模型实际看到的内容”仍有系统性偏差，不只是边界一个值

- **文件:行**：`packages/application/src/services/proactive-mail-check-service.ts:198`、`:354`，`packages/application/src/services/proactive-mail-body.ts:12-18`
- **问题**：模型发送的是“先遮盖、再截断”：`windowMailBody(masked(item.body), bodyLimit)`；上报扫描的是“先截断原文、再检测”：`windowMailBody(item.body, bodyLimit).text`。遮盖会把秘密替换成长度不同的占位符，导致两次截断的切点发生偏移，偏移量等于切点之前所有被遮盖值的长度变化总和。因此多记/少记并不只发生在边界附近的一个值；前面有长密钥等长度变化大的值时，离“名义边界”很远的秘密也可能被多记或少记。
- **证据（读代码证实）**：
  - 模型侧：`const windowed = item.body === null ? undefined : windowMailBody(masked(item.body), bodyLimit);`
  - 上报侧：`item.body === null ? item.snippet : windowMailBody(item.body, bodyLimit).text,`
  - `windowMailBody` 按输入长度的 70%/30% 切：`const head = Math.ceil(room * HEAD_SHARE); const tail = room - head;`
  - 遮盖占位符长度与原值无关：`const placeholder = tag === undefined ? `[${label}]` : `[${label}#${tag(kind, identity)}]`;`
- **建议**：让出口遮盖返回命中区间偏移，在“遮盖后坐标系”里应用同一个窗口，再只上报落在窗口内的命中；或至少让扫描复用模型实际发送的文本/区间。现测试只覆盖了头部命中、被丢弃的中间命中、前 10 个附件，未覆盖尾部命中和长度变化导致的切点漂移。
- **备注**：作者已承认这是已知限制，但把它描述为“边界附近的一个值”偏轻。

### 3. 中（条件性）：去重键算法变更没有数据迁移，旧数据不会与新数据合并

- **文件:行**：`packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:61-74`、`packages/persistence-sqlite/src/migrations/0078_sensitive_interceptions.sql:1-30`
- **问题**：本轮把 `ruleId` 从 `dedupe_key` 中移除（旧键是含 `ruleId` 的哈希）。这是纯代码变更，没有回填/重算迁移。任何由本 PR 早期提交（`dd4431dc` 及之前）写入过的数据库，旧行仍带旧键；之后同一值再出现会生成新键，表现为同一处同一值两行，`seenCount` 也分裂。
- **证据（读代码证实）**：
  - 新键不含 `ruleId`：`JSON.stringify([item.threadId, item.source, item.purpose, item.part, item.category, item.fingerprint, item.outcome])`
  - `0078_sensitive_interceptions.sql` 只有 `CREATE TABLE` 和建索引，没有 `UPDATE`/回填逻辑。
  - 旧键含 `ruleId` 可从 `git diff dd4431dc..1ccb5152` 看到。
- **补充**：早期提交把后台调用的 `threadId` 写成 `null`，而记录里没有存 `runId`，这些旧行也无法事后按 run 回填对话。
- **建议**：若该表可能已有数据，增加一次性迁移：按现有列重新计算新键并合并重复行；对早期 `threadId = null` 的后台行，至少在发布说明中声明无法回溯，或改为可重新归属的结构。若确认 PR 从未在任何持久化环境运行过，可明确写上“无存量数据”，否则应视为会出错。

### 4. 低：清除前 flush 不是原子的，“之后出现的是新拦截”并不严格成立

- **文件:行**：`apps/agent-service/src/production-sensitive-interceptions-control.ts:94-95`、`apps/agent-service/src/production-http-composition.ts:1099`、`packages/application/src/services/sensitive-interception-recorder.ts:137-154`
- **问题**：代码确实在 clear 前调用了 `flushSensitiveInterceptions`，已排队写入基本能清掉；但 `flush` 只等待当前队列/当前 drain，清除和生产者之间没有互斥。清除开始前已经发生、但在 flush 完成后才执行 `report` 的拦截（在途模型调用、异步密钥解析后的 mail 上报等）仍会在 clear 之后写入。作者说“之后出现的是新拦截”只对“拦截事件本身发生在 flush 之后”成立，不能覆盖“事件早已发生、上报迟到”的情况。
- **证据（读代码证实）**：
  - 清除顺序：`await this.#options.beforeRead?.(); const { cleared } = await this.#options.store.clear(...)`
  - 接线：`beforeRead: () => flushSensitiveInterceptions(repository),`
  - `observe` 只是入队并 schedule，`flush()` 只 drain 当前队列；之后新的 `observe` 仍可再入队。
- **建议**：若要保证用户点“清除”后旧事件不回来，需要引入清除代际/屏障（clear epoch），或在清除期间阻塞上报；若接受这个竞态，应在代码/文档里明确，并补一个“flush 后有迟到上报”的行为测试。

---

## 对作者说法的核对

**读代码证实的部分：**

- **第 1 条（邮件按上限截断）**：代码确实改成 `windowMailBody(item.body, bodyLimit)`，附件只扫前 `MAX_ATTACHMENTS_SHOWN` 个；但如上第 2 点，截断对象与模型发送对象不同，限制被低估。
- **第 2 条（runId 查对话）**：`ModelEgressContext.runId`、`PiModelTransport` 注入 `runId`、`generateText` 传 `request.threadId` 均已实现；跨 owner/agent 安全，因为查询同时过滤 `owner_id`、`agent_id`、`id`。但“对话已删”场景见第 1 点；run 不存在时静默保留 `threadId = null`，这是代码和测试都接受的行为。
- **第 3 条（去重不含 ruleId）**：请求内 `Exchange` 的 identity 已改为 `${part}\0${kind}\0${fingerprint}`；数据库键也移除了 `ruleId`；冲突时保留首次 `ruleId`。测试 `model-egress.unit.test.ts:519-539` 通过 `named-earlier` 真正覆盖了不同规则合并，旧代码会得到两条。
- **第 4 条（先 schedule 再 onDropped）**：`sensitive-interception-recorder.ts:125-134` 顺序已调整；`sensitive-interception-recorder.unit.test.ts:84-97` 是有效反向用例，旧代码在 `onDropped` 抛错时不会调度写入。
- **第 5 条（扫描放入 try）**：代码已把 `findSensitiveValues` 和 `onMasked` 整个放进 try；但 `test/integration/proactive-mail-check.test.ts:464-471` 只让 `onMasked` 抛错，旧代码本来就会吞掉这个异常，因此该测试不能证明第 5 条修复有效。
- **记忆规则映射不成立的理由**：站得住。`candidateSecretFindings` 的 `ruleId` 来自 `scanMachineSecrets`（具体机器密钥规则 ID）和 `credentialFindings`（只返回 `password` / `verification-code` / `machine-secret`）；`memoryCategory` 两类都覆盖了（`automatic-memory-service.ts:73-80`、`sensitive-interception-recorder.ts:32-37`）。

**未核实 / 推测：**

- **role `"function"`**：未核实 pi-ai 是否绝不发送该 role。代码里 `partOf` 对未知 role 走 `default: return inherited`，如果真有 `role: "function"`，工具结果会被记成 `owner_message`；这点需要确认，不能仅凭“pi-ai 不发”下结论。
- **UTC 分组**：本次 diff 未改 `localDay`；`packages/memory-engine/src/episodes.ts:74-81` 用的是带 `timeZone` 的 `Intl.DateTimeFormat`。但“localDay 用本地 getter”这一说法与本次改动关系未核实，不在本次 diff 内。
- **chat egress 未带 runId**：`pi-runtime-adapter.ts:999-1005` 的 chat 上下文只有 `threadId`，没有 `runId`；而 `RuntimeRequest.threadId` 允许为 `null`。若存在无 thread 的 chat run，记录仍会以 `threadId = null` 落库。是否真实存在这种 run 未核实。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（就本增量而言）。** 本轮的改动集中在上报、数据库去重和邮件扫描：`observe` 回调只读取命中，不改变 `redactForEgress` 返回的 `text`；邮件窗口改动只影响 `#reportMasked`，模型提示仍走 `proactiveMailView` 的 `windowMailBody(masked(item.body), bodyLimit)`。系统提示、工具定义和历史消息组装路径没有改动。`packages/runtime-pi/test/prompt-prefix.compat.test.ts:447-493` 的 `[SI-2]` 用例也把“有上报”和“无上报”的请求体逐字节比较，并检查每轮只追加。

因此：发给模型的内容仍然只在末尾追加；每轮变化的时间、记忆、资料等仍在最后一条消息里，本增量没有把这些值挪到系统提示或工具定义。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**模型请求字节不会。** 本轮没有改遮盖算法或占位符生成；`observe` 不参与文本改写，`findSensitiveValues` 只是另跑一遍检测。指纹也保持稳定：`model-egress.unit.test.ts:512-516` 检查同一值在不同请求中得到相同 fingerprint。

会因上下文变化的仍是规则本身允许的例外（前面消息里点名的密码/验证码会影响后面消息的遮盖），这不是本轮引入的。会变的是“拦截记录归到哪一行、保留哪个 ruleId、邮件窗口扫到哪些值”，这些不是发给模型的字节。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

按代码推断（没有运行测试）：

- **有有效反向用例的**：
  - 邮件窗口：`proactive-mail-check.test.ts:479-502`；旧代码会扫全文/全部附件，因此会命中 `middlepass99`、`lastfile99.txt`，测试会失败。
  - runId 查对话：`sensitive-interceptions.test.ts:218-239`；旧代码不会把 `run-si` 解析成 `THREAD_ID`，测试会失败。
  - 去重键/请求内合并：`sensitive-interceptions.test.ts:241-256` 和 `model-egress.unit.test.ts:519-539`；旧代码会得到两行/两条 sighting。
  - `onDropped` 抛错：`sensitive-interception-recorder.unit.test.ts:84-97`；旧代码不会调度写入。
  - 上报不改变请求字节：`prompt-prefix.compat.test.ts:447-493`。

- **检查不足的**：
  - **对话已删后再写入**没有用例；现有删除测试 `:279-316` 是先写记录再删对话，只覆盖了 `threadId` 已解析的情况。
  - **跨 owner/agent 的 runId** 没有反向用例；代码目前安全，但缺少回归保护。
  - **清除前 flush** 没有有效用例；`production-http-composition.unit.test.ts:1018-1035` 是直接调用 `store.record`，绕过了 `SensitiveInterceptionRecorder`，因此根本没有验证 `beforeRead` 的 flush。
  - **第 5 条“扫描放入 try”** 没有有效反向用例；现有的 `onMasked` 抛错测试在修改前也能通过。
  - **邮件窗口**只测了头部、被省略的中间、前 10 个附件，没有测尾部命中，也没有测“遮盖改变长度导致切点漂移”。
