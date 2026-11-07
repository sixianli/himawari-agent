## 读代码证实的发现

### 高｜回放在隔离 store 之外仍会写真实的敏感拦截账本

- **文件:行**：`apps/agent-service/src/production-proactive.ts:210`、`packages/application/src/services/proactive-replay-service.ts:281`、`packages/application/src/services/proactive-mail-check-service.ts:542`、`packages/application/src/services/sensitive-interception-recorder.ts:63-81,169-174`
- **问题**：回放把生产环境的 `onMasked` 原样传给了每次判断；判断时 `#reportMasked` 会把过去邮件的遮盖命中通过 `mailEgress.reportMasked` 送入真实的 `SensitiveInterceptionRecorder`，最终 `store.record(...)` 写入真实敏感拦截表。这不是“结果只写进独立的回放表”，而且回放量大时可能挤占 2000 条的实时队列，导致真实观测被丢弃。
- **证据**：
  - `production-proactive.ts:210`：`...(options.onMasked ? { onMasked: options.onMasked } : {}),`
  - `proactive-replay-service.ts:281`：`...(options.onMasked ? { onMasked: options.onMasked } : {}),`
  - `proactive-mail-check-service.ts:542`：`this.#reportMasked(batch, bodyLimits.perMail);`
  - `sensitive-interception-recorder.ts:169`：`await this.#options.store.record({`
- **建议**：回放不要传 `onMasked`，或传入只写回放侧的 recorder；如果确实要统计遮盖，增加独立的回放 purpose/表，并确保不进入实时队列和实时页面。

---

### 中｜历史邮件不按 `receivedAt` 排序，预算/失败截断会偏向 Gmail 返回顺序

- **文件:行**：`packages/platform-node/src/gmail-source.ts:295-300`（回放读取不排序）、`packages/platform-node/src/gmail-source.ts:395`（现有实时读取会排序）、`packages/application/src/services/proactive-replay-service.ts:203-213`
- **问题**：现有 Gmail reader 在返回前按 `receivedAt` 升序排序；新的 history reader 只是按 Gmail `messages.list` 的顺序读取并返回。回放按这个顺序逐封判断，预算或连续失败一停，先被判掉的会是 Gmail 返回靠前的邮件（通常是最新的），较早的邮件可能永远没有样本。这不符合“按收到那一刻的时间逐封回放”的预期，也让回放结果依赖 Gmail 的返回顺序。
- **证据**：
  - `gmail-source.ts:395`：`items.sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));`
  - `gmail-source.ts:295-300`：`for (const message of messages) { ... items.push(item); } return { kind: "items", items };`
  - `proactive-replay-service.ts:203-213`：直接 `for (const item of read.items)`。
- **建议**：在 `read` 返回前或 `#execute` 判断前，对 items 按 `receivedAt`（相同时间再按 `messageId`）排序；增加一个“预算截断时仍先判断最早邮件”的反向测试。

---

### 中｜`recordResult` 抛错时，已封存的展示文字没有释放路径

- **文件:行**：`packages/application/src/services/proactive-replay-service.ts:237-241`、`packages/persistence-sqlite/src/sqlite-proactive-replay-operations.ts:252`
- **问题**：`#execute` 只处理了 `recordResult` 返回 `false` 的分支；如果 `recordResult` 抛错（重复结果、磁盘/数据库错误），异常会直接抛出 `#execute`。`start()` 的 catch 只调用 `finishRun("failed")`，不会拿到当前 `record`，因此当前邮件已经 `seal.seal` 出来的 `contentRef` 没有释放，成为真实 payload store 里的孤儿密文。
- **证据**：
  - `proactive-replay-service.ts:238-241`：`if (!(await replays.recordResult(...))) { await this.#releaseSealed(record); return; }`
  - `sqlite-proactive-replay-operations.ts:252`：`if (inserted === 0) throw new Error("PROACTIVE_REPLAY_DUPLICATE_RESULT");`
  - `proactive-replay-service.ts:173-178` 的 catch 只做 `finishRun`。
- **建议**：把每封邮件的判断/记录/释放包在 `try/finally` 中，异常时也执行 `#releaseSealed(record)`；必要时记录异常码并确保 `finishRun` 一定执行。

---

### 中｜`ProductionProactive.stop()` 不等待也不取消正在运行的回放

- **文件:行**：`apps/agent-service/src/production-proactive.ts:223-227`、`apps/agent-service/src/production-proactive.ts:546-556`
- **问题**：回放的 `done` 只被 `void` 掉，没有保存到实例；`stop()` 只等待实时判断的 `#running`。服务关闭时，回放仍可能在读 Gmail、调用模型、写数据库，随后仓库可能已被关闭；运行记录会停在 `running`，要等下次启动的 `interruptStale` 才能变成 `interrupted`，期间可能产生上面的 payload 泄漏。
- **证据**：
  - `production-proactive.ts:223-227`：
    ```ts
    async stop(): Promise<void> {
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = undefined;
      await this.#running;
    }
    ```
  - `production-proactive.ts:549-555`：`const { runId, done } = await replay.start(...); void done.then(...).catch(...)`
- **建议**：保存回放 `done`/AbortController，在 `stop()` 中取消并等待；取消时把运行记录置为 `interrupted`，并释放当前邮件的临时 payload。

---

### 中｜回放没有接入 `memory`，和真实主动判断流程不一致

- **文件:行**：`apps/agent-service/src/production-proactive.ts:175`、`apps/agent-service/src/production-proactive.ts:191-212`、`packages/application/src/services/proactive-replay-service.ts:259-282`
- **问题**：实时判断把 `options.memory` 传给 `ProactiveMailCheckService`，回放服务构造的 service 没有 `memory`，因此回放永远不进行记忆召回。对于“扩大该不该提醒的评价样本”这个目标，回放结果和线上真实判断不可比，尤其是线上依赖记忆召回的邮件。
- **证据**：
  - 实时：`production-proactive.ts:175`：`...(options.memory ? { memory: options.memory } : {}),`
  - 回放：`production-proactive.ts:191-212` 构造 `ProactiveReplayService` 时没有 `memory`；`proactive-replay-service.ts:259-282` 构造 `ProactiveMailCheckService` 时也没有。
- **建议**：给 `ProactiveReplayOptions` 增加 `memory` 并透传；如果决定不回放记忆，应在说明和结果字段中明确“无记忆召回”，避免把两类样本混在一起评价。

---

### 低｜单条“删除回放”只返回 refs，没有生产调用负责真正释放；测试也只验证返回 refs

- **文件:行**：`packages/persistence-sqlite/src/sqlite-proactive-replay-operations.ts:327-342`、`test/integration/proactive-replay.test.ts:343-357`
- **问题**：`deleteRun` 删除运行和结果后只返回 `contentRef` 列表，本身不调用 `seal.release`；`ProactiveReplayService` 也没有包装 `deleteRun` 的生产方法。测试名为“releases its sealed text”，但实际只断言 `refs` 等于 `contentRef`，没有验证 payload 已被删除。若后续界面直接调用 store 的 `deleteRun`，会永久留下封存文字。
- **证据**：
  - `sqlite-proactive-replay-operations.ts:338-341`：删除 run 后 `return refs.map(({ ref }) => ref);`
  - `proactive-replay.test.ts:354-356`：
    ```ts
    const refs = await h.replays.deleteRun({ ...scope, runId });
    expect(refs).toEqual([only?.contentRef]);
    expect(await h.replays.readRun({ ...scope, runId })).toBeUndefined();
    ```
- **建议**：在应用层提供 `deleteRun` 包装，先删行再调用 `seal.release`；测试应实际断言 `payloadStore.get(contentRef)` 为空，并覆盖 `removeSource`（断开邮箱）路径，目前只测了 `clearRecords`。

---

### 低｜`asOf` 的说法不准确：它也进入了抓取起点和日预算起点

- **文件:行**：`packages/application/src/services/proactive-mail-check-service.ts:401,472,512`
- **问题**：作者说 `asOf` 只用于“提示里的现在、按时间算的规则和推送窗口”。代码里 `startedAt = asOf ?? clockAt` 之后，`startedAt` 还作为 `reader.fetch.since` 和 `store.costSince.since` 的基准。回放中这两处分别被假 reader 和隔离 store 抵消，所以当前没有实际影响；但说法与代码不一致，若以后把 `asOf` 接回真实 store/reader，会改变抓取范围并把日预算基准移到过去。
- **证据**：
  - `proactive-mail-check-service.ts:401`：`const startedAt = this.#options.asOf ?? clockAt;`
  - `:472`：`since: new Date(Date.parse(startedAt) - LOOKBACK_MS).toISOString(),`
  - `:512`：`since: startOfZonedDay(startedAt, this.#options.timeZone),`
- **建议**：把“历史时间”和“真实时钟”拆成两个参数，只让 `asOf` 进入提示、规则和推送窗口；或者明确记录 `asOf` 也会影响抓取/预算，并在所有调用点保证 store/reader 已被隔离。

---

### 低｜历史读取没有按 `[from, to]` 做后置过滤（需核实 Gmail 日期语义）

- **文件:行**：`packages/platform-node/src/gmail-source.ts:263`、`packages/application/src/services/proactive-replay-service.ts:198`
- **问题**：查询用 `Math.floor(from/1000)` 和 `Math.ceil(to/1000)` 生成 `after:`/`before:`，但读取回来的 item 没有再用 `receivedAt` 过滤 `[from, to]`。如果 Gmail 的 `after`/`before` 是日期粒度或边界按天解释，就可能把范围外的邮件也写进回放结果。该点依赖 Gmail 的检索语义，未能离线核实。
- **证据**：
  - `gmail-source.ts:263`：``q: `after:${Math.floor(Date.parse(from) / 1_000)} before:${Math.ceil(Date.parse(to) / 1_000)}`,``
  - `proactive-replay-service.ts:198`：只有 `[...new Set(listed.ids)].slice(0, request.mailLimit)`，没有按 `receivedAt` 过滤。
- **建议**：在 `read` 或 `#execute` 中按 `item.receivedAt` 对 `[from, to]` 做一次后置过滤，并补一个“返回范围外邮件时被丢弃”的测试。

---

## 推测 / 未核实

- **Gmail `after:`/`before:` 的精确语义**：无法上网核实是秒级还是日期级；若为日期级，上面的范围问题会真实发生。
- **多进程/多实例**：`start()` 每次都无条件调用 `interruptStale()`（`production-proactive.ts:217`）。如果同一数据库有多个 agent-service 实例，新实例启动会把另一个实例正在运行的回放标成 `interrupted`。当前部署是否单写者未核实。
- **Owner/Agent 物理删除**：`proactive_replay_results.content_ref` 是 `ON DELETE RESTRICT`。表的 cascade 会先删回放结果，但 owner 删除时 payload 清理与回放行的先后顺序未完整追踪；可能出现 payload 被“引用保护”跳过、进而阻塞 owner 删除的情况，需结合账户删除流程核实。
- **测试通过数量**：没有运行测试；“21 个文件 643 例通过”和两个 check 在 main 同样失败，未核实。
- **模型调用是否产生其他真实写入**：`model.prepare` 会向真实 payload store 写 prompt，正常路径随后释放；进程崩溃时是否会被回放表追踪到，未核实。

---

## 侧重检查

- **错误路径**：`history.list` 失败 → `failed`；`history.read` 失败 → `failed`；token 缺失/未授权 → `failed`；`recordResult` 返回 `false` → 释放封存后直接返回（不 `finish`，但此时 run 已不是 running 或被删除）；`recordResult` 抛错 → 有封存 payload 泄漏；服务停止 → 回放未取消。
- **不合规范/不可信输入**：网关 `timestamp` 要求 canonical UTC，`mailLimit`/`budgetMicros` 与 SQL、服务校验一致；Gmail 返回的 message id、receivedAt 没有在回放侧做范围/时间合法性后置校验，异常数据会让单次判断失败或写入范围外记录。
- **安全/隐私**：历史邮件按现有 `proactivePrompt` 遮盖后发送，遮盖逻辑未改；但 `onMasked` 会把回放的遮盖命中写入真实敏感拦截账本；封存文字保存在 payloads，正常路径有释放，错误路径/单条删除路径存在泄漏风险。
- **资源耗尽**：`mailLimit` 上限 2000，但整体没有 wall-clock 上限；每个邮件最坏可占用约一个 `perCheckMs`，列表分页没有页数上限（受 `perCheckMs` abort 约束）；单次预算只有 5,000,000 micros，但可以连续发起多次回放。
- **不可撤销操作**：`start` 异步执行，没有取消 API；`clearRecords`/断开邮箱会删除回放并返回 refs，生产调用会释放；单条 `deleteRun` 没有生产调用方；`stop` 不等待回放。
- **规则/说明/代码一致性**：`prompt-prefix` 方面，`asOf` 仅改变提示最后一段的 `now`，实时路径不传时保持原状；`asOf` 还进入 `fetch.since`/`costSince.since` 与作者说明不一致；隔离 store 的 `markConnection` 是静默 no-op 而不是拒绝，和“除 record 外所有写入都拒绝”的字面说法不一致；`deleteRun` 的释放说明也没有被生产代码完整兑现。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会（就实时路径而言）。未传 `asOf` 时 `clockAt = clock.now()`、`startedAt = clockAt`，`deadlineAt` 和 `durationMs` 都基于真实时钟；实时路径没有传入 `asOf`，提示文本、工具定义、历史和系统提示都没有改动。回放请求是新的单条判断请求，`asOf` 只出现在 `proactivePrompt` 最后渲染的 `MAIL_JUDGMENT_NOW`（`proactive-mail-check-service.ts:252-273`），即“每轮会变的值在最后”。唯一需要纠正的是说明：`asOf` 理论上还流向 `fetch.since`/`costSince.since`，只是回放路径用假 reader 和隔离 store 抵消了。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   提示正文不会：遮盖是 `maskSensitiveText` 的确定性结果，`now` 用 `item.receivedAt`，同一封邮件重放会得到相同提示。会变的是元数据/存储密文：`judgedAt = clock.now()`、seal 的 `at` 和生成的 payload ref/密文每次不同；`listResults` 明确按 `message_id` 排序，因此结果集合本身不是无序返回。若关心“同一提示的字节完全一致”，当前回放路径满足；但 `judgedAt`/payload ref 不适合做跨运行字节比较。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有基本覆盖：`test/integration/proactive-replay.test.ts` 7 例覆盖真实账本为空、预算停止、连续失败停止、单回放限制、删除返回 refs、重启中断、清空记录；Gmail reader 2 例覆盖范围查询和读取。若删掉隔离 store 的真实写入阻断、预算检查、失败计数、唯一运行索引或 `clearRecords` 中的回放删除，对应用例会失败。缺口是：没有反向测试证明 `onMasked` 不写真实拦截表；没有测试实际验证 payload 被删除（只验证返回 refs）；没有覆盖断开邮箱（`removeSource`）路径；没有覆盖 `#execute` 抛错时的释放；没有显式测试“不传 `asOf` 时行为与改动前逐字节相同”；没有覆盖历史邮件排序和范围后置过滤。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   主要值是一致的：`proactive.replay.start` 已同时加入消息类型、schema、fixture、生产操作清单和 `ProductionProactive` 分支；`mailLimit`/`budgetMicros`/状态/outcome/优先级/`reasonCode` 长度在网关、应用服务和 SQL CHECK 之间基本对齐；`run.id` 由 `ids.next("proactive-replay")` 生成，长度小于 128；`messageId`/`threadId`/`contentRef` 的长度和可空关系在 `validResult` 与 SQL CHECK 中一致。仍需注意的端点是：`deleteRun` 的 `contentRef` 只被返回、没有生产调用释放；`onMasked` 绕过了“只写回放表”的边界；`asOf` 还影响 `fetch.since`/`costSince.since`；历史读取的顺序和范围没有在消费端再校验。
