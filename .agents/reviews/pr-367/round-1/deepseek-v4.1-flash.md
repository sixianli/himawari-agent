## 结论摘要

- 代码能实现大部分作者说法：摘要只在有新邮件时读取/补生成、分级过滤、同一次检查各批字节一致、六项输入写入与校验、决策链与抽屉读取、聊天路径未接线。
- 发现两个中等风险问题：**补生成的时间预算实际没有生效**，以及**陈旧积压会把目标日期段永久饿死**。
- 另有一个低风险代码质量问题（运算符优先级写法）、两处 ADR/代码不一致，以及若干测试缺口。
- 未发现新的系统提示、工具定义或历史消息被改写；Gmail 检查仍是一条独立的用户消息。

---

## 问题清单（按严重度）

### 中：补生成没有真正限制在“检查时间的四分之一”

- 文件:行：`packages/application/src/services/proactive-mail-check-service.ts:1297-1314`、`apps/agent-service/src/production-proactive-summaries.ts:37-48`、`packages/memory-engine/src/episodes.ts:117-185`
- 问题：`catchUpSignal` 只传给了 `source.catchUp`，但真正调用判断模型时用的是外层 `signal` 和完整 `deadlineAt`；`dueSegments()` 在检查 abort 之前执行，而且根本不接收 signal。因此补生成可以一直跑到整个检查的截止时间，而不是四分之一。
- 证据（读代码证实）：

```ts
// proactive-mail-check-service.ts:1297-1305
const catchUpSignal = AbortSignal.any([
  signal,
  AbortSignal.timeout(Math.floor(this.#options.limits.perCheckMs / 4)),
]);
const caught = await source.catchUp({
  ...
  signal: catchUpSignal,
```

```ts
// proactive-mail-check-service.ts:1314
const call = await this.#invoke(prompt, dataClassification, deadlineAt, signal, trace);
```

```ts
// production-proactive-summaries.ts:37-45
const segments = (await options.episodes.dueSegments({ ...scope, limit: limit * 4 }))
  ...
for (const segment of segments) {
  if (signal.aborted) return { ... failed: true };
```

`dueSegments` 内部还会逐条读取消息正文（`episodes.ts:162-167`），且没有 signal 参数，所以四分之一超时既打断不了它，也打断不了模型调用。
- 后果（推测，基于控制流）：补生成可能耗尽整个 per-check 预算，主循环随后在 `clock.now() >= deadlineAt` 处 `stop = "capped"`，这一轮 Gmail 判断被跳过。这与作者“补生成失败不挡判断”“单独用检查时间的四分之一”的说法不符。
- 建议：把 `catchUpSignal`（或单独的四分之一 deadline）传给 `#invoke`，并给 `dueSegments`/消息读取加 abort 检查；或者在 `#summaries` 外层对整个 `catchUp` 做 abort race，超时后立即继续读取已有摘要。

### 中：陈旧积压会让最近两天的段落永远进不了补生成

- 文件:行：`apps/agent-service/src/production-proactive-summaries.ts:37-41`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1500-1506`
- 问题：`dueSegments` 先按全库“最久未活动”顺序取最多 12 个线程序列，之后才按 `day >= fromDay` 过滤。只要存在足够多“很早以前、尚未摘要”的 open 线程，它们会每轮都占据前 12 个名额并被过滤掉，导致昨天/今天的段落永远轮不到。
- 证据（读代码证实）：

```ts
// production-proactive-summaries.ts:37-41
const segments = (await options.episodes.dueSegments({ ...scope, limit: limit * 4 }))
  .filter(
    ({ day, dataClassification }) => day >= fromDay && allowed.includes(dataClassification),
  )
  .slice(0, limit);
```

```sql
-- sqlite-memory-operations.ts:1505-1506
WHERE ... AND m.last_sequence > summarizedThrough
ORDER BY m.last_committed_at, t.id LIMIT @limit
```

- 后果（推测，基于上述顺序）：在线程积压的账号上，补生成可能长期 0 段，目标是“早上检查时把昨天补出来”的功能实际失效。ADR 第 87 行只承认“单个对话有更早段落时排在后面”，没有覆盖这种全库范围的饿死。
- 建议：在存储层按日期范围直接筛选未摘要段落，或分页遍历直到凑够窗口内段落；至少加一个“存在 >12 个陈旧未摘要线程，仍能补到昨天”的反向测试。

### 低：`summaryInjected` 与 `summaryIds` 的校验依赖运算符优先级

- 文件:行：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:664`
- 问题：`(inputs.summaryInjected ?? false) === summaryIds.length > 0` 实际按 `===` 与 `>` 的优先级解析为 `summaryInjected === (summaryIds.length > 0)`，当前行为是正确的，但写法非常脆弱，后来的人很容易误读或改错。
- 证据（读代码证实）：

```ts
(inputs.summaryInjected ?? false) === summaryIds.length > 0 &&
```

- 建议：改成显式括号 `(inputs.summaryInjected ?? false) === (summaryIds.length > 0)`。

### 低：ADR 的缓存保证和字段路径与代码不一致

- 文件:行：`docs/adr/0216-gmail-check-reads-recent-day-summaries.md:54`、`:56`
- 问题：
  1. ADR 说“同一天内的多次检查，摘要块的字节相同”。但第一次检查的补生成、或之后聊天 run 新生成的日摘要，都会改变摘要集合，后续检查的摘要块字节就会变化。只有“同一次检查的各批”是确定的。
  2. ADR 说网页接口字段是 `mails[].summaries`，实际是对象 `mails.summaries`。
- 证据（读代码证实）：`proactive-mail-check-service.ts:805-808` 每次检查都可能补生成；`production-decision-chain.ts:124-129` 的实际结构是 `mails: { ..., summaries }`。
- 建议：把“同一天内的多次检查字节相同”改为“同一次检查的各批、且摘要集合未变化时相同”；把 `mails[].summaries` 改为 `mails.summaries`。

### 低：测试没有覆盖几个关键失败路径

- 文件:行：`test/integration/proactive-mail-check.test.ts` 的 `[PG-16]`（1544-1552）及新增 `[P3-6]` 组
- 问题：现有反向用例是真实的（坏写入会被拒绝、受限/压缩/旧日期/占位会被排除、无新邮件不读、暂停不补、读失败不挡判断）。但没有测试：
  - 四分之一时间限制是否真的生效；
  - 补生成模型失败时判断是否继续；
  - 当天费用已达上限时是否跳过摘要；
  - 陈旧积压饿死最近两天段落；
  - `[PG-16]` 的“邮件之前全部稳定”在带摘要时是否仍成立（该测试没有传 summaries）。
- 证据（读代码证实）：`[PG-16]` 只调用 `proactivePrompt([mail("a")], ...)`，没有第 7 个参数。
- 建议：补上述用例，尤其是“补生成超时/失败后仍完成判断”和“陈旧线程积压仍能补到昨天”。

---

## 侧重检查

- **无新邮件 / 只有 spam**：`candidates.length === 0` 时完全不调用 `catchUp/recent`（`proactive-mail-check-service.ts:804-808`），与测试一致。
- **当天费用到上限**：会跳过摘要读取/补生成（同上），但新增测试没有覆盖这一分支。
- **主人暂停记忆记录**：`catchUp` 在 `capturePaused()` 为真时直接返回（`production-proactive-summaries.ts:35`），测试覆盖；但**已有摘要仍会被 `recent()` 读取并注入**，代码没有因暂停而停止读取。作者只承诺“不补”，所以我没把它算作 bug，但这是一个需要产品确认的策略点。
- **读取失败**：`recent` 异常被捕获，`summaryRead = "failed"`，判断继续（`proactive-mail-check-service.ts:1347-1350`），有测试。
- **补生成失败**：异常被捕获为 `partial`（`1324-1326`），但“模型失败后判断仍继续”没有独立测试；而且四分之一超时没有真正作用于模型调用，见上。
- **分级/安全**：SQL 先按 `classification` 过滤（`sqlite-memory-operations.ts:1447`），`MemoryEpisodeService.recent` 再过滤 `isModelVisible`（`episodes.ts:203`），调用分级取记忆与摘要的最高档（`proactive-mail-check-service.ts:1225-1228`）。未发现 restricted 泄漏路径。
- **不可信输入**：摘要文本用 `JSON.stringify` 写入数据块（`proactivePrompt:434`），不会破坏结构；摘要来自已有对话摘要，不是邮件内容。邮件正文仍然走 `masked()`，摘要没有在应用层调用 `masked()`，但与现有记忆文本路径一致，是否由统一出口再遮盖我未进一步核实（见“未核实”）。
- **不可撤销操作**：补生成只会 upsert `memory_episodes` 和写 payload，没有删除；生产 `storeText` 在 payload 已存在时直接返回（`service-main.ts:1391-1393`），不会覆盖已有摘要正文。
- **资源耗尽**：`dueSegments` 在过滤日期前会为最多 12 个线程读取每线程最多 120 条消息正文（`episodes.ts:131-167`），且不可中断；这是上面“四分之一时间未生效”和“饿死”问题的一部分。
- **写入校验两端**：生产端写六项，SQLite 端校验重复 id、日期格式、负数/非整数、未知状态、只写一部分、`summaryInjected` 与空 ids 矛盾（`sqlite-proactive-operations.ts:643-668`），反向测试确实构造了这些坏值并断言拒绝。
- **聊天路径**：新增符号只出现在 Gmail 检查与组合根；静态测试 `proactive-summaries-scope.unit.test.ts` 覆盖了这一点。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

- **聊天路径：不会。** 改动没有碰系统提示、工具定义、历史消息、遮盖逻辑；新增读取器和摘要块只接到 `ProductionProactive`，静态测试也检查了这一点。
- **Gmail 检查：没有“已经见过的历史”被改写。** 它每次都是一条独立的用户消息（ADR 0148 前提：`messages: [{ role: "user", content: prompt }]`）。固定说明 `mail.judgment` 仍在最前面；摘要块在其后；最后一行仍是“现在是 …”。没有摘要时 `proactivePrompt` 的输出与改动前逐字节相同（`summaries.length === 0` 时整段不出现）。
- **但“只在末尾追加”要准确理解：** 摘要块不是追加在整条消息的最末尾，而是插在固定说明之后、记忆和邮件之前。它属于“这次的数据”，后面的“现在是…”仍是最后会变的值，符合规则第 15 条“固定的指令 → 这次的数据 → 当前时间”。如果把它理解成“旧 Gmail 提示作为前缀必须原样保留”，那么从摘要块开始旧提示的后缀发生了位移；但这不是多轮对话中已发内容的改写。
- **一个需要留意的点：** 原 `[PG-16]` 测试断言“`邮件：` 之前的内容永远稳定”。带摘要后，摘要块位于 `邮件：` 之前且会变，所以这个断言只在“无摘要”路径成立；现有测试没有覆盖带摘要的路径。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

- **同一次检查内：不会。** 摘要在批次循环之前只计算一次；`listDaySummaries` 的排序是 `day DESC, ended_at DESC, id ASC`（确定的全序），`summaryDays` 写入前 `.sort()`，JSON 键顺序固定为 `{day, text}`，`chosen.reverse()` 也是确定的。各批摘要块字节相同，测试覆盖。
- **跨检查：摘要内容本身会变**（补生成或后续聊天 run 生成新摘要），这是内容变化，不是序列化不稳定。ADR 第 54 行“同一天内的多次检查字节相同”这个更强的说法不成立。
- **无序集合：** `summaryIds` 使用 Set 的插入顺序，但插入顺序来自确定排序后的摘要数组，因此仍是确定的；`summaryDays` 明确排序。未发现依赖数据库默认返回顺序的无序输出。
- **遮盖：** 摘要文本没有在应用层调用 `masked()`，而邮件正文调用了；这与现有记忆文本路径一致。如果统一出口的遮盖依赖前后文，那么摘要集合/顺序变化时同一段摘要可能被遮成不同字节——但这已经是内容变化导致的结果，且我未核实统一出口的具体行为。

### 3. 有没有自动检查，反向用例是否真的会失败？

有对应测试，且反向用例不是空跑：

- `[P3-6]` 集成组覆盖：旧日期/压缩摘要/受限分级/占位文字被排除、敏感分级不进不允许的模型、无新邮件不读、读取失败仍判断、暂停记忆不补、字数上限、各批字节相同、时区、坏写入拒绝。
- `memory-episodes.test.ts` 覆盖 `listDaySummaries` 的日期顺序、分级过滤和坏输入拒绝。
- `decision-chain.test.ts`、`decision-ledger.test.ts`、`daily-review.unit.test.ts` 覆盖新增字段的读取与默认值。
- `proactive-summaries-scope.unit.test.ts` 是静态检查，覆盖“摘要块/读取器/接线只出现在 Gmail 检查文件”。
- 提示词 golden 覆盖新增摘要块的渲染。

反向用例确实会失败：例如坏写入测试会构造重复 id、`2026/11/03`、`"bogus"`、负数、`1.5`、`summaryInjected` 与空 ids 矛盾、只写 `summaryRead` 等，SQLite 校验会拒绝；过滤测试会实际插入旧日期、compaction、restricted、占位行并断言 prompt 中不出现。

**缺口：** 四分之一超时、补生成模型失败后判断继续、到达每日上限、陈旧积压饿死、带摘要时的前缀稳定性，都没有自动检查。我未能运行测试，测试是否全部通过属于“未核实”。

### 4. 每个新值的生产端与消费端是否都能接受？

逐个核对如下：

- `summaryInjected`
  - 生产：`trace.summaryIds.size > 0`（`proactive-mail-check-service.ts:1541`）。
  - 消费：SQLite 要求 boolean（`sqlite-proactive-operations.ts:660`）；决策链只读不显示该值。
- `summaryIds`
  - 生产：`[...trace.summaryIds]`，来源是 `episode.id`。
  - 消费：SQLite `ids(summaryIds, MAX_INPUT_IDS)` 要求非空字符串、≤256、无重复（`sqlite-proactive-operations.ts:673-677`）。`ThreadId` 最长 128（`packages/domain/src/identifiers.ts:39`），`episode:` 前缀加 source 和 sequence 后仍小于 256，能通过。
- `summaryDays`
  - 生产：Set 去重后排序。
  - 消费：SQLite 要求 ≤31 项、`/^\d{4}-\d{2}-\d{2}$/`、无重复；`recentDays` 产出 `YYYY-MM-DD`，能通过。
- `summaryCharacters`
  - 生产：注入摘要的 `text.length` 累加。
  - 消费：SQLite 要求非负安全整数；能通过。
- `summaryRead`
  - 生产：`off | ok | partial | failed`。
  - 消费：SQLite 枚举校验；gateway `decisionChainSnapshotSchema` 也是同一枚举（`packages/gateway-contracts/src/contracts-v2.ts:1046-1050`）；抽屉 i18n 四种状态都有文案。
- `summaryGenerated`
  - 生产：补生成成功计数。
  - 消费：SQLite 要求非负安全整数；决策链不直接显示，但写入通过。
- 写入/读取两端的“键是否存在”
  - 写入端只有 `summaryRead !== undefined` 时才写六项（`sqlite-proactive-operations.ts:780-789`）。
  - 读取端 `readOne` 的 `inputFields` 来自原始 JSON 键（`sqlite-decision-ledger-operations.ts:350`），所以老记录没有这些键时决策链得到 `summaries: null`，不会误显示。
  - `entryFromRow` 会给所有记录补默认值（`sqlite-decision-ledger-operations.ts:219-224`），因此 `entry.inputs` 总是带六项；当前使用 `entry.inputs` 的决策链消费方用的是 `inputFields` 而不是 `entry.inputs` 的键存在性，所以当前消费端能接受。若未来有消费方按 `entry.inputs` 的键判断“是否记录过”，会误判。
- 新增 prompt id `mail.judgment.recent-summaries-header`
  - 生产：`fixedPrompt` 定义在 `packages/prompt-catalog/src/mail.ts`，`index.ts` 已 `export * from "./mail.js"`。
  - 消费：服务从包入口导入；manifest 中登记了同名 key；golden 文件已加入。
  - **未核实：** manifest 里的 sha256 是否与实际 `JSON.stringify(entry.segments)` 一致（受工具限制无法本地重算；`prompt-catalog.unit.test.ts` 会校验）。
- 新端口 `MemoryEpisodeStorePort.listDaySummaries`
  - 生产：`SqliteMemoryOperations` 实现并在 `execute` 中分派；`durable-adapters.ts` 暴露。
  - 消费：`MemoryEpisodeService.recent` 调用；输入校验覆盖日期、limit、分级集合。
  - 操作名前缀 `memoryEpisode.` 已在 `sqlite-durable-operations.ts:553-560` 分派，不需要额外注册。

---

## 未核实

- 我没有运行任何测试；以上“测试会失败/通过”是读代码和用例内容得出的判断。
- `packages/prompt-catalog/prompt-manifest.json` 中新增条目的 sha256 是否与 `mail.ts` 中的文字一致，未重算。
- 摘要文本最终是否会被统一出口的遮盖层处理（应用层未调用 `masked()`，与现有记忆文本一致），未读到统一出口对后台提示的具体遮盖路径。
- 生产环境是否真的会积累超过 12 个“open 且很早未摘要”的线程，属于部署数据推断，不是代码事实。
