## 一、读代码证实的问题（按严重度）

### 1. 中：摘要块和记忆在同一条 user message 里，后出现的记忆可能改变摘要块的字节

- 文件：`packages/application/src/services/proactive-mail-check-service.ts:429-449`
- 问题：摘要和记忆都是原文，摘要排在记忆前面，而整段提示作为一条 user message 发出。出口遮盖的 `named-earlier` 会在整条字符串上把“前面出现过的同一个值”再遮一次；如果这一批选中的记忆里含有密码/验证码值，而摘要里以裸文本出现同一个值，摘要块的字节就会随这一批的记忆变化。记忆是每批不同选的，因此“同一次检查各批摘要块字节相同”在存在敏感值时并不成立，也违反“遮盖不能取决于它后面的内容”。
- 证据：
  - `proactive-mail-check-service.ts:431-449`：摘要块先放，随后才是 `MAIL_JUDGMENT_MEMORIES_HEADER.text` 和 `JSON.stringify(memories.map(...))`。
  - `proactive-mail-check-service.ts:1400-1425`：`#batchMemories` 返回的是 `hit.text.replace(...).slice(...)`，没有经过 `masked()`。
  - `packages/runtime-pi/src/egress-context.ts:26`：`messages: [{ role: "user", content: prompt, timestamp }]`，整段提示是一条消息。
  - `packages/sensitive-capture/src/redaction.ts:399-409` 会把验证码值记入 `known`，`:411-425` 最后对整条字符串执行：
    ```ts
    for (const [value, placeholder] of known) {
      if (!text.includes(value)) continue;
      ...
      text = text.replace(pattern, () => { ... return placeholder; });
    }
    ```
  - 新增用例 `test/integration/proactive-mail-check.test.ts:3248-3264` 没有带任何记忆，所以查不出这个反向情况。
- 建议：在组装提示前对摘要文本做与邮件字段相同的 `maskSensitiveText()`（或用一个稳定的、不共享当前批次记忆的 `known` 集合单独遮盖），再做 `JSON.stringify`；同时加反向用例：摘要里放一个裸密码/验证码，第一批判邮件选中含该值的记忆，第二批不选，断言两批“邮件：”之前的摘要块仍逐字节相同。

### 2. 中：补生成可能用尽当天剩余预算，使本轮邮件判断被跳过

- 文件：`packages/application/src/services/proactive-mail-check-service.ts:1307-1314`、`:829-833`
- 问题：补生成只按“摘要 prompt 的估算”检查每天上限，没有给主判断预留预算；它可以把 `spentToday + costMicros` 花到刚好低于上限，随后主判断的估算就超限，直接 `stop = "capped_daily"`，本轮有邮件也不判断。另有嵌入费用在补生成内部只记在局部，等 `catchUp` 返回后才加到 `budget.costMicros`（`:1329`），因此后续摘要调用的检查会低估已花的钱，最多可超上限约两段嵌入费用。
- 证据：
  ```ts
  // :1308-1314
  if (budget.spentToday + budget.costMicros +
      this.#options.limits.estimateCostMicros(prompt) >
      this.#options.limits.dailyCostMicros)
    throw new Error("PROACTIVE_SUMMARY_DAILY_CAP");
  ```
  ```ts
  // :829-833
  if (spentToday + costMicros + estimate > this.#options.limits.dailyCostMicros) {
    stop = "capped_daily";
    break;
  }
  ```
- 建议：在补生成前为主判断预留至少一个保守估算（或固定比例/固定额度），补生成只用剩余预算的一部分；把每段的嵌入费用在发生时回传给 `#summaries` 的预算检查。加“接近上限”反向用例：剩余额度只够判断、不够补生成时，应优先判断。

### 3. 中低：测试没有真正锁住“每次检查只读一次”和“摘要块在记忆之前”

- 文件：`test/integration/proactive-mail-check.test.ts:3248-3264`、`:2869-2873`
- 问题：
  1. 多批“字节相同”用例只断言两批 prompt 的 `邮件：` 前缀相同，不检查 `world.current.calls.recent`/`catchUp` 的次数。把 `#summaries` 移进批次循环会多读库/多尝试补生成，但该用例仍会通过。
  2. 用例只断言摘要标题在 `邮件：` 之前，没有断言在 `MAIL_JUDGMENT_MEMORIES_HEADER` 之前；代码目前顺序正确（`:431-449`），但回归把摘要放到记忆之后不会被发现。提示前缀缓存正是要求摘要块在每批不同的记忆之前。
  3. 没有“剩余额度接近上限”的反向用例，第 2 条预算饥饿不会被发现。
- 证据：
  ```ts
  // test:3260-3263
  expect(h.prompts).toHaveLength(2);
  const head = (prompt: string) => prompt.slice(0, prompt.indexOf("邮件："));
  expect(head(h.prompts[0] ?? "")).toContain("下周去大阪出差");
  expect(head(h.prompts[0] ?? "")).toBe(head(h.prompts[1] ?? ""));
  ```
  ```ts
  // test:2871
  expect(prompt.indexOf(HEADER)).toBeLessThan(prompt.indexOf("邮件："));
  ```
- 建议：在该用例中断言 `world.current?.calls` 为 `{ catchUp: 1, recent: 1 }`；给其中一封邮件加一条记忆，并断言摘要块在记忆标题之前；另加接近每日上限的反向用例。

### 4. 低：`summaryRead: null` 会绕过写入校验，并被读回成 `"off"`

- 文件：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:656`、`:669`、`:782`
- 问题：`summaryRead === undefined` 才走“六项都不写”的分支；`null` 会继续往下，而枚举检查用了 `inputs.summaryRead ?? "off"`，`null` 被当成 `"off"` 放过。写入分支又用 `summaryRead === undefined` 判断，于是把 `null` 原样写进 `inputs`；通用读出再用 `?? "off"` 变成 `"off"`。这与作者“未知状态都拒绝”的说法不一致，也让 `inputFields` 显示该字段已记录而实际是空值归一化后的“off”。
- 证据：
  ```ts
  // :656
  if (inputs.summaryRead === undefined) return others.every((value) => value === undefined);
  // :669
  ["off", "ok", "partial", "failed"].includes(inputs.summaryRead ?? "off")
  // :782
  ...(input.inputs.summaryRead === undefined ? {} : { summaryRead: input.inputs.summaryRead, ... })
  ```
- 建议：枚举检查不要用 `?? "off"`，改成显式 `typeof inputs.summaryRead === "string" && [...] .includes(inputs.summaryRead)`；把 `{ summaryRead: null }` 加进反向用例。

### 5. 低：补生成的日摘要不可逆，且用的是判断模型，后续聊天 run 不会重写

- 文件：`apps/agent-service/src/production-proactive-summaries.ts:47-64`、`packages/memory-engine/src/episodes.ts:117-139`、`apps/agent-service/src/service-main.ts:1391-1392`
- 问题：补生成成功后，`dueSegments()` 的 watermark 会跳过该段，聊天 run 不会再生成；即使强行再 `summarize`，`storeText` 发现同一 `contentRef` 已存在就直接返回，旧文本不会被覆盖。也就是说，判断模型第一次写下的摘要成为该对话那一天的永久摘要，质量差时没有正常的纠错/重生成路径。ADR 提到了“用判断模型”，但没有写“聊天 run 之后不会重写、无法自动纠正”这一后果。
- 证据：
  ```ts
  // service-main.ts:1391-1392
  storeText: async (input) => {
    if (await episodePayloads.get(input.ref)) return;
  ```
  ```ts
  // episodes.ts:127-139
  const watermarks = await this.#options.store.listUnsummarized({ ... });
  ```
  ```ts
  // production-proactive-summaries.ts:47-56
  for (const segment of segments) { ... options.episodes.summarize(segment, generate) ... }
  ```
- 建议：至少在 ADR 后果里写明这一点；最好提供显式重生成/覆盖路径，或让补生成只在可接受的模型/分级范围内使用，避免低质量摘要永久化。

### 6. 低（边界）：补生成和读取各自用 `now()` 算日期窗口，跨本地午夜时可能不一致

- 文件：`packages/memory-engine/src/episodes.ts:196-203`、`apps/agent-service/src/production-proactive-summaries.ts:36`、`:68-73`
- 问题：`catchUp` 里先调一次 `recentDays(days)`（内部 `now()`），`recent` 里又调一次 `recentDays(input.days)`。若一次检查跨过本地午夜，补生成和读取可能使用不同的“今天/昨天”窗口，刚补生成的摘要可能被下一次窗口漏掉。不是“同一段文字不同字节”，但属于时间边界的不一致。未见对应测试。
- 建议：由调用方在 `#summaries` 开始时算一次 `{fromDay,toDay}`，同时传给 `catchUp` 和 `recent`，避免两次取时钟。

### 7. 低：材料/文档与代码的小出入

- `test/integration/proactive-mail-check.test.ts` 的 `[P3-6]` 组实际是 15 个 `it`（我按新增 diff 逐条数），材料写“13 条”。
- 材料说“补生成失败只把 summaryRead 记为 partial”；若补生成失败后 `recent` 也失败，代码会把它改成 `"failed"`（`proactive-mail-check-service.ts:1354-1356`）。这更严重但合理，说法不够精确。
- “摘要块、读取器和接线只出现在 Gmail 检查的文件里”依赖 `apps/agent-service/test/proactive-summaries-scope.unit.test.ts` 的字符串搜索；`production-run-memory.ts` 这个聊天和邮件共用的文件也有 `MailEmbeddingContext.dataClassification` 改动（`:69-73`、`:124-127`）。它不读/不生成摘要，所以不是功能问题，但“只出现在 Gmail 检查文件里”的说法偏宽。

---

## 二、推测 / 未核实

- **未核实**：`packages/prompt-catalog/prompt-manifest.json:312-316` 的 `sha256` 我无法在只能用 git 的限制下重新计算；只能确认条目、`changedIn`、`reason` 和定稿文件存在，不能确认哈希是否与 `mail.ts` 的新文字一致。`prompt-catalog.unit.test.ts:300-319` 会校验，若哈希过期会失败。
- **未核实**：我没有运行测试或 `npm run check`，只读了测试代码；材料中的“13 条/全部通过”无法执行验证。
- **推测**：`mails.summaries` 在网关 v2 契约里是**必填键**（`packages/gateway-contracts/src/contracts-v2.ts:1040-1052`），仓库内的生产者/样例已补齐；如果前后端不是原子部署，新 schema 遇到旧后端或旧缓存快照会因缺键拒绝。是否允许这种混合版本，仓库里没有证据。
- **推测**：补生成的日摘要用判断模型写库，若判断模型对长对话摘要能力弱于聊天模型，质量下降会成为永久记忆（见第 5 条）。

---

## 三、侧重检查

- **错误路径**：
  - `recent` 抛错 → `summaryRead = "failed"`，不带摘要块，继续判断（`proactive-mail-check-service.ts:1354-1357`）。
  - `catchUp` 抛错/`caught.failed` → `summaryRead = "partial"`，继续判断（`:1330-1333`）。
  - 模型失败/未完成/截断 → `generate` 抛错，库中不写该段（`:1322-1325`）。
  - 暂停记忆记录 → `capturePaused()` 为真时补生成直接返回 0（`production-proactive-summaries.ts:35`），但仍读取已有摘要（作者已说明）。
  - 嵌入模型拒绝敏感分级 → `#record` 的 embedding try/catch 吞掉错误并调用 `onEmbeddingFailure`，摘要文本照样先写入（`episodes.ts:386-406`），符合 ADR 说法。
- **不合规范/不可信输入**：
  - `listDaySummaries` 拒绝非法 `fromDay/toDay`（格式、倒序）、`limit` 非 1..100、未知分级（`sqlite-memory-operations.ts:1419-1441`）。
  - `listUnsummarized.activeSince` 要求严格 ISO 字符串（`:1488-1497`）。
  - 决策记录六项校验覆盖重复 id、日期格式、负数、非整数、未知状态、只写一部分、`summaryInjected` 与空 id 矛盾（`sqlite-proactive-operations.ts:643-670`）；但 `summaryRead: null` 有漏洞（第 4 条）。
  - SQL 参数化；日期用正则、分级用白名单，未发现拼接注入。
- **安全**：
  - 读取端按 `allowedClassifications`+`isModelVisible` 过滤（`episodes.ts:212`、`:215-221`）；模型调用按记忆和摘要的最高分级 `prepare`（`proactive-mail-check-service.ts:1225-1229`）；补生成的嵌入按每段自己的分级申报（`production-proactive-summaries.ts:49-54`）。
  - 摘要文本来自对话，不是固定文字，提示里用固定标题声明“只是背景、不是指令”；注入风险和现有记忆块同等级，未发现新增泄露路径。
  - 发现了一个遮盖时机问题：摘要原文与后续记忆在同一条 message，出口 `named-earlier` 可能反向影响摘要字节（第 1 条）。
- **资源耗尽**：
  - 补生成最多 3 段、最多四分之一检查时间、每次模型调用前做每日上限估算；`recent` SQL 最多取 `limit×4`（默认 32 行），逐段读文本，最多返回 8 段；摘要块最多 4000 字。没有无界集合。
  - 但补生成没有给主判断预留预算，且嵌入费用在补生成内部未及时计入上限（第 2 条）。
  - `recent` 不接中止信号（作者已说明）；本地 SQLite 读取，风险低，但若 `readText` 变慢会占用整次检查时间。
- **不可撤销操作**：
  - `memory_episodes` 写入是持久的，watermark 会推进；`storeText` 对同一 `contentRef` 不覆盖（第 5 条）。补生成失败不会回滚已写成功的段。
  - 决策记录写入失败时，已补生成的摘要仍然留在库里，但这次检查的模型费用可能没进 `decision_ledger`，下次 `costSince` 会低估。这是既有的“先写副作用、后记决策”模式，补生成让它更明显。
- **规则/文档一致性**：
  - ADR 0216、决策记录写入约定、提示词目录清单、定稿文件都已更新。
  - 例外：材料说 13 条测试，实际 15；`partial`/`failed` 的极端组合说法不精确；“只出现在 Gmail 检查文件”有共享文件改动；`summaryRead: null` 与“未知状态都拒绝”不一致。

---

## 四、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

- **聊天路径不会**：`recent`/`catchUp`/摘要块只接在 `ProductionProactive` 上；聊天 run 的 `production-memory-episodes.ts:90-108` 仍只调 `dueSegments`，没有读摘要或补生成。system prompt、工具定义、历史消息、遮盖规则都没有改。
- **Gmail 检查**是独立后台调用，整段提示作为唯一一条 user message 发出（`packages/runtime-pi/src/egress-context.ts:26`）。固定说明 `MAIL_JUDGMENT.text` 仍在最前，摘要块在其后（`proactive-mail-check-service.ts:429-436`），不是 system prompt；记忆、邮件、`now` 也都在同一条消息里，`now` 仍在最后一行（`:455`）。没有跨轮历史可改写。
- **但“同一次检查各批字节相同”不完全成立**：摘要块和记忆在同一条消息里，且摘要未预遮盖；出口 `named-earlier` 可能因后出现的记忆改变前面摘要的字节（第 1 条）。所以结构上是“只在一条消息里、固定在前”，但“同一摘要文本每次字节相同”在含敏感值+不同记忆的批次里会被打破。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

- **普通情况下不会**：摘要文本从数据库读出后 `trim`，`JSON.stringify([{day,text}])` 键顺序固定，SQL 用 `day DESC, ended_at DESC, id ASC`，再 `reverse()`，没有时间字段或无序 Set 进入模型输入；同一次检查的摘要只算一次，各批共享同一数组。
- **存在一条会变的路径**：摘要原文和后面的记忆在同一条 user message 里，出口 `maskSensitiveText`/`redactForEgress` 的 `named-earlier` 最后会扫描整条字符串（`packages/sensitive-capture/src/redaction.ts:411-425`）。如果后面的记忆里出现一个可被认出的密码/验证码值，而同一值在摘要里以裸文本出现，摘要会被改成占位符；而记忆是每批不同选的（`proactive-mail-check-service.ts:819`、`:1400-1425`）。这既是“前后文遮盖”，也可能让批与批之间的摘要块不同。作者声称的“同一次检查各批字节相同”只对没有这种值的情况成立。
- 其他：`summaryDays` 在决策记录里排序，`summaryIds` 是插入顺序，但都不进模型输入；`recent`/`catchUp` 各自取一次 `now`，跨本地午夜可能有日期窗口差异（第 6 条），但不会让同一段文字本身变成不同字节。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，而且大部分反向用例是真的会让错误实现失败：

- 过旧日期、`compaction`、`restricted`、占位文字被排除：用例逐项断言 prompt 不含这些文本（`test/integration/proactive-mail-check.test.ts:2886-2927`）。
- 敏感摘要抬高调用分级 / 只收 private 的模型拒绝敏感摘要：`:2929-2970`。
- 没有新邮件不读不补：`:2972-2984`。
- 读失败仍判断并记 `failed`：`:2986-2999`。
- 补生成、老积压对话不挤掉昨天、四分之一截止时间、补生成失败仍判断：`:3001-3137`。
- 当天上限用完后不读不补：`:3139-3165`。
- 字符预算丢最旧整段：`:3215-3246`。
- 存储层拒绝重复 id、坏日期、未知状态、负数、非整数、只写一部分、矛盾组合：`:3266-3318`。
- 东京时区算昨天：`:3300-3318` 附近。
- 提示词目录有对应的 manifest/golden 检查（`prompt-catalog.unit.test.ts:300-319`、`prompt-rendering-golden.unit.test.ts`），但 manifest 哈希我未核实。

**缺口**（第 3 条详述）：
- 没有断言一次检查只调用 `recent`/`catchUp` 一次；
- 没有断言摘要块在记忆标题之前（用例没带记忆）；
- 没有“剩余额度接近上限”的预算饥饿反向用例；
- 没有“记忆里的敏感值与摘要里的裸值相同，两批记忆不同”的遮盖反向用例；
- `summaryRead: null` 不在存储层反向用例里；
- `check:prompt-prefix` 这条阻断检查只覆盖聊天对话，不覆盖后台 Gmail 调用，所以这个改动的后台提示排序不能靠总闸门兜底。

### 4. 每个新值/修改值，产生和使用两端都能接受吗？

- **`summaryInjected`/`summaryIds`/`summaryDays`/`summaryCharacters`/`summaryRead`/`summaryGenerated`**
  - 产生：`proactive-mail-check-service.ts:1545-1554`，只在 `recentSummaries !== undefined` 时六项一起写。
  - 使用：SQLite `summaryInputsValid`（`sqlite-proactive-operations.ts:643-670`）校验后写入（`:782-791`）；通用读出补默认值（`sqlite-decision-ledger-operations.ts:219-224`）；依据链按原始 `inputFields` 判断是否显示（`production-decision-chain.ts:124-129`）；网关契约 `mails.summaries` 和前端/三语 i18n 都接上了。
  - 结论：服务产生的组合能通过校验；唯一漏洞是 `summaryRead: null` 会被放过并读回 `"off"`（第 4 条）。
  - ID 长度：`ThreadId` 最长 128（`packages/domain/src/identifiers.ts:39`），episode id 最长约 165，未超存储层 `summaryIds` 的 256 字符限制。
- **`mails.summaries`（网关契约必填键）**
  - 产生：`production-decision-chain.ts:124-129` 总是给出 `null` 或 `{count,read}`。
  - 使用：contract schema（`contracts-v2.ts:1040-1052`）、`gateway-v2.fixture`、浏览器 fixture、周报单测、Control Center 抽屉（`decision-chain-drawer.tsx:203-210`）都已更新；旧记录因 `inputFields` 没有 `summaryRead` 而返回 `null`，UI 判断可以接受。
  - 风险：协议 v2 加了必填键，混合版本部署是推测性兼容风险（见“推测”）。
- **`activeSince`**
  - 产生：`episodes.ts:130-137` 用 `toISOString()`。
  - 使用：`sqlite-memory-operations.ts:1488-1497` 严格校验，SQL 参数化。两端一致。
- **`listDaySummaries`**
  - 产生：`MemoryEpisodeService.recent`（`episodes.ts:215-221`）。
  - 使用：port、durable adapter、SQLite worker/direct 都接上；SQLite 校验日期、limit、分级，SQL 只取 `source='day_summary'`。两端一致。
- **`MailEmbeddingContext.dataClassification`**
  - 产生：补生成按 `segment.dataClassification` 逐段设置（`production-proactive-summaries.ts:49-54`）；`createProactiveMemoryRecall` 不设置，走 `private` 缺省。
  - 使用：`embedOnce` 先看显式 `dataClassification`，再看 projection，再退到 `mail.dataClassification ?? "private"`（`production-run-memory.ts:124-127`）；descriptor 的分级白名单会拒绝不允许的分级；拒绝时 `#record` 仍写摘要、只是不带向量。两端一致。
- **`ProactiveRecentSummaries` 接线**
  - 只在 `production-proactive.ts:167-171`、`service-main.ts:1630-1646` 接到 `ProductionProactive`；`service` 在 `recentSummaries === undefined` 时完全不写六项。聊天路径未接。
- **`memory_episodes` 的写入**
  - 不改表；唯一键 `(thread_id, source, first_sequence)` + `upsert` 能防重复行；但同一 `contentRef` 的 `storeText` 先写者胜，后写者文本被丢（第 5 条）。这是需要明确接受的行为。

---

**总体结论**：主设计（摘要只在 Gmail 检查、只追加在固定说明后、分级过滤、六项决策输入、时间/费用上限）方向正确，反向用例覆盖也比材料说的更扎实。最需要处理的是第 1 条遮盖字节不稳定和第 2 条预算饥饿；第 3 条测试缺口会让这两类回归不被发现。除此之外未发现会泄露数据或破坏聊天路径的高危问题。
