## 结论摘要

方案的方向有一处是对的：把最近两天的摘要放在固定说明之后、本批记忆和邮件之前，符合「固定在前、会变的在后」，也利于同一次检查多批请求复用前缀。但方案在**记忆暂停开关、ADR 0158 的既有决议、模型分级准入、每日费用上限、检查时限、并发写入、决策账本审计**上有实质性缺口；其中前两项足以让方案在动工前被拦下。

---

## 证实的（按严重度从高到低）

### 1. 严重：Gmail 补生成会绕过「暂停记忆」开关

**问题**：聊天路径生成日摘要前会检查主人的 `capturePaused`，Gmail 检查的「补生成」没有这个门。主人暂停记忆后，邮件检查仍会调用模型、写入新的 `memory_episodes` 和摘要正文，违反主人的设置。

**证据**：
- `apps/agent-service/src/production-titled-runtime.ts:41-49`：只有 `await memoryPaused()` 为 false 才 `memoryEpisodes?.start(request)`。
- `apps/agent-service/src/production-memory-capture.ts:708-712`：记忆抽取也检查 `capturePaused`。
- 方案第 2 条「先用 `dueSegments()` + `summarize()` 补齐」没有提到这个开关。

**建议**：补生成前读取 `memoryBook.readSettings({ownerId, agentId})`，`capturePaused` 为 true 时直接跳过；同时沿用 `assertActive`/authority 检查。加一条「暂停后邮件检查不生成摘要、不新增 episode」的反向测试。

---

### 2. 严重：方案与 ADR 0158「不带常驻档案、只带相关记忆」的决议冲突

**问题**：ADR 0158 明确否决了「常驻档案」，决定按每封邮件搜相关记忆。方案第 3 条把两天的日摘要**无差别注入每一批邮件判断**，这就是一种常驻上下文；方案没有解释它为什么不是被否决的做法，也没有取得主人新的同意。

**证据**：
- `docs/adr/0158-bring-related-memories-into-gmail-checks.md:28`：「不带常驻档案，只带相关记忆」。
- 同文件 `:50`：「常驻档案：Andy 已否决」。
- 同文件 `:34-42` 的逐封搜记忆、每批最多 12 条、每条 200 字等限制，都是围绕「相关」设计的。
- 方案第 3 条却是「最多 8 段、合计 4000 字」无条件注入。

**建议**：二选一：
1. 明确把方案定位为对 ADR 0158 的修订，写新 ADR、取得 Andy 同意，并说明为什么「最近两天的摘要」不是当年被否决的常驻档案；
2. 更稳妥：仍然按邮件批次做相关性筛选（复用现有 `ProactiveMemoryRecall` 的词/向量检索，或至少做主题/实体匹配），只把与当前邮件相关的摘要放进提示；没有相关摘要时退回现有的逐封记忆搜索，而不是把所有近期对话都发给判断模型。

---

### 3. 中高：敏感摘要可能让整个邮件检查失败，而不是「读失败不挡判断」

**问题**：方案第 5 条把本批分级抬到敏感。`ProactiveModelInvoker.prepare` 会检查模型描述里的 `allowedDataClassifications`；如果 Gmail 判断模型只允许到 `private`，会抛 `PROACTIVE_MODEL_DISCLOSURE_DENIED`。这个异常发生在 `#judge` 的 `model.prepare`，会被上层当作 `MODEL_CALL_ERROR`，整批判断失败，不是「摘要读失败不挡判断」。

**证据**：
- `apps/agent-service/src/production-model-composition.ts:521-523`：`if (!descriptor.allowedDataClassifications.includes(dataClassification)) throw new Error("PROACTIVE_MODEL_DISCLOSURE_DENIED")`。
- `packages/application/src/services/model-visibility.ts:10-14`：模型可见档是 public/private/sensitive。
- `packages/application/src/services/proactive-mail-check-service.ts:1112-1116`：分级来自 `promptMemories`，随后 `prepare`；目前只检查 `allowedDataClassifications.includes("private")`（`production-model-composition.ts:500-503`），并不要求 sensitive。
- ADR 0193 的生产模板虽然把敏感加进了允许名单，但代码没有强制「Gmail 模型必须允许 sensitive」，所以这是配置陷阱。

**建议**：读摘要和补生成都用「模型可见档 ∩ 该 Gmail 模型描述允许档」作为上限；超过上限的摘要**跳过**，不要抬升到模型不能看的档。这样即使配置只到 private，也只是没有摘要块，邮件判断照常。补一条「模型只允许 private + 存在 sensitive 摘要 → 不带摘要块、检查成功」的反向测试。

---

### 4. 中高：补生成可能超每日费用上限，「总花费不增加」不成立

**问题**：方案说「先用 `dueSegments()` + `summarize()` 补齐，费用记进本次检查」，但：
- 现有每日上限只对**判断提示词**做估算和累计（`spentToday + costMicros + estimate`），补生成在估算前发生，没有按剩余预算预留，可能直接花超；
- Gmail 判断模型走 `UNMETERED_PERMIT`（`production-model-composition.ts:513-516`），不受全局模型预算约束，只受每日主动检查费用约束；
- 摘要由 Gmail 判断模型生成，输出上限是 `PROACTIVE_MAX_OUTPUT_TOKENS = 4096`（`production-proactive.ts:49`），而聊天 run 的记忆抽取是 1024 输出、`disableThinking: true`（`service-main.ts:1984-1991`）。两者模型、参数都可能不同，「迟早会在聊天里生成」不等于同一笔费用、同一份内容；
- 主人如果不再聊天，这些摘要不会在聊天里生成，属于额外花费；
- 摘要块会进入每一批提示词，多批时重复计费（`proactive-mail-check-service.ts:760-817`）。

**证据**：
- `packages/application/src/services/proactive-mail-check-service.ts:734-737`（`spentToday`）、`:771-775`（只用判断提示词估算）。
- `apps/agent-service/src/production-model-composition.ts:505-516`（`UNMETERED_PERMIT`）。
- `apps/agent-service/src/production-memory-episodes.ts:9`、`packages/memory-engine/src/episodes.ts:21`（聊天路径每次最多 1 段、闲置 2 小时）。

**建议**：补生成前用剩余每日预算做**预留/估算**，生成失败也要记 unknown 成本；把摘要成本计入 `costMicros`；更彻底的做法是交给记忆抽取模型和它的预算，而不是 Gmail 判断模型。不要写「总花费不增加」，改成「把未来可能的花费提前，且需要新的预算边界」。

---

### 5. 中高：同步补生成可能吃光 `perCheckMs`，导致邮件判断被截断

**问题**：方案说「先用」补生成，再判断。`perCheckMs` 默认 180 秒（`strict-configuration.ts:1046`），每次最多 3 段，每段模型调用可能接近整个检查时限；如果串行执行，邮件判断可能还没开始就被 `capped`，或者摘要调用自己超时。

**证据**：
- `packages/application/src/services/proactive-mail-check-service.ts:627-631`：整个检查只有一个 `perCheckMs` 的 `AbortController`。
- 方案第 2 条「每次检查最多 N 段（默认 3）」，没有剩余时限、子预算、`controller.signal` 的说明。

**建议**：补生成必须使用本次检查的剩余时限和 `controller.signal`，并设独立的小预算；或者放到判断之后、甚至放到独立的记忆 worker 异步做。加「补生成超时/被取消时邮件判断仍完整」的测试。

---

### 6. 中：并发 upsert 不能保证摘要正文与 `last_sequence` 一致，可能永久漏摘要

**问题**：方案依赖 `UNIQUE(thread_id, source, first_sequence)` + upsert 保证并发安全。但 `summarize()` 的 `contentRef` 只由 `threadId + source + firstSequence` 决定，`storeText` 发现 payload 已存在就**直接返回**；后续 `upsertEpisode` 会删除再插入，可能把 `last_sequence` 推进到更大的值，而正文仍是更早那次生成的。结果是最后几条消息被水位线跳过，永远不会被摘要。

**证据**：
- `packages/memory-engine/src/episodes.ts:325-326`：`id` 和 `contentRef` 只含 `firstSequence`。
- `apps/agent-service/src/service-main.ts:1390-1392`：`if (await episodePayloads.get(input.ref)) return;`。
- `packages/persistence-sqlite/src/sqlite-memory-operations.ts:1232-1258`：先 `DELETE` 再 `INSERT`，只按 `id` 删。
- `packages/persistence-sqlite/src/migrations/0053_memory_episodes.sql:24`：唯一约束是 `(thread_id, source, first_sequence)`，挡不住更晚的 `last_sequence` 覆盖。

**建议**：在调用模型前用 claim/lease 或 `INSERT ... ON CONFLICT DO NOTHING` 先占位；只有正文成功写入后才推进 `last_sequence`；或给 upsert 加 `WHERE last_sequence < ?` 的条件更新。加「Gmail 检查与聊天 run 同时摘要同一段，期间有新消息」的并发测试。

---

### 7. 中：摘要生成的模型调用没有审计落点，和决策账本「每次模型调用留档」的既有设计不一致

**问题**：方案只把 `summaryGenerated` 计数写进邮件决策记录，没有说摘要生成的 prompt/answer 怎么留档。现有 Gmail 检查的 `modelPayloads` 记录判断调用的输入输出（`proactive-mail-check-service.ts:1394`）；摘要生成会读整段对话（最多 16k 字符），如果只留计数，等于一批敏感的模型输入输出没有任何审计和清理路径。

**证据**：
- `packages/application/src/services/proactive-mail-check-service.ts:1374-1401`：`modelPayloads: trace.payloads`。
- ADR 0147 要求保留每次 Gmail 检查的 prompt 和 answer。
- 方案第 6 条只列 `summaryGenerated`，没有 payload 归属、清理、读取方式。

**建议**：明确三选一：
1. 摘要生成作为独立的决策账本记录（新 kind 或 source），有自己的 payload 和清理；
2. 摘要生成归入记忆引擎的审计，而不是邮件决策；
3. 不生成，改由独立记忆 worker 生成。
不要让它成为「花了钱但没有模型输入输出记录」的路径。

---

### 8. 中：新增决策字段的写入、校验、读出和页面消费不完整

**问题**：方案第 6 条说「SQLite 写入校验、通用读出两端都改」，但现有代码有三处要同时改，方案没有逐项列出；而且新字段如果做成必填，会破坏大量非 proactive 写入方和测试。

**证据**：
- `packages/application/src/ports/proactive-checks.ts:208-223`：`ProactiveCheckInputs` 现有字段。
- `packages/application/src/ports/decision-ledger.ts:71-93`：`DecisionInputs` 现有字段。
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:643-690`：proactive 写入校验。
- `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:139-215`：通用读出默认值。
- `docs/execution/specs/2026-11-09-decision-record-write-convention.md:34-35、50-54`：proactive 路径落完整字段；其他 kind 经 `append` 只落四个键；改写入方要同时补 `decision-chain.test.ts`。
- `apps/agent-service/src/production-decision-chain.ts:77-79`：读取端用 `recordedFields` 区分「无记录」和「这次没有」；如果直接默认 `false/[]/0/"off"`，会破坏这个语义。

**建议**：新字段做成**可选**（`?`），只在 proactive 写入路径校验和落盘；`entryFromRow` 补默认值；`inputFields` 仍按实际键区分；不要改 `append` 的四个键。若要让页面显示，还要改 `production-decision-chain.ts` 和 `packages/gateway-contracts/src/contracts-v2.ts`，方案目前没提。更新写入约定和 `decision-chain.test.ts`。

---

### 9. 中：`application` 不能直接依赖 `memory-engine`，方案里的「把 `MemoryEpisodeService` 接给 Gmail 检查」需要端口适配

**问题**：Gmail 检查在 `packages/application`，`MemoryEpisodeService` 在 `packages/memory-engine`；后者依赖前者，反向依赖会违反 `check:boundaries`。方案第 7 条直接说把 `MemoryEpisodeService` 实例接给 Gmail 检查，没提适配层。

**证据**：
- `packages/application/package.json:21-30`：依赖里没有 `@himawari-agent/memory-engine`。
- `packages/memory-engine/package.json:9-14`：依赖 `@himawari-agent/application`。

**建议**：在 `application` 定义窄端口（例如 `ProactiveDaySummariesPort`，只有 `recent()` 和可选的 `backfill()`），在 `apps/agent-service` 用现有 `MemoryEpisodeService` 实现；`ProactiveMailCheckService` 只依赖这个端口。

---

### 10. 中：提示词目录、golden、manifest、函数签名会一起变，方案只写了「更新清单和 golden」

**问题**：新增固定标题必须进 `packages/prompt-catalog` 和 `prompt-manifest.json`；`proactivePrompt` 的现有调用方都按固定参数顺序传参（`proactive-mail-check-service.ts:374-411`、`test/integration/proactive-mail-check.test.ts:1424、1527-1528、2357-2358`），插入摘要参数会改签名。方案没有指定兼容方式。

**证据**：
- `apps/agent-service/test/prompt-catalog.unit.test.ts:175-195、299-330`：manifest 缺失/过期/未知都会失败。
- `apps/agent-service/test/prompt-rendering-golden.unit.test.ts:211-220`：`mail.judgment` golden。
- `packages/prompt-catalog/src/mail.ts:36-78`：现有固定标题和 `MAIL_JUDGMENT_NOW`。

**建议**：把摘要作为 `proactivePrompt` 的**可选参数**或改成 options 对象，保持现有调用兼容；新增 `mail.judgment.recent-summaries-header` 条目和 manifest 行；更新 golden；运行 `npm run check:prompt-catalog`。

---

### 11. 中：确定性测试在错误的层，最终发送字节（含遮盖）没有覆盖

**问题**：方案第 8 条只测「同一批摘要渲染两次字节相同」。这只覆盖 `proactivePrompt` 的字符串渲染，不覆盖出口遮盖后的最终字节。规则要求同一段文字在不同请求里不能因后续内容变成不同字节；摘要文字可能包含密码/验证码，而遮盖识别可能与**后面的邮件**有关。

**证据**：
- `.claude/rules/prompt-prefix.md:51-54`：遮盖只能取决于自己和前面的内容；点名值会影响同一次请求里后面的消息。
- `.claude/rules/prompt-prefix.md:51`：固定文字清单会影响遮盖。
- 方案第 8 条只写「渲染两次字节相同」。

**建议**：测试实际发给模型的请求体（或经过真实出口遮盖的文本）：同一批摘要 + 不同顺序的邮件，摘要里的秘密遮出的字节应相同；摘要里出现秘密、后面的邮件点名同一秘密时，不能因此改变摘要段的字节。另测数据库插入顺序打乱后摘要选择与渲染顺序不变。

---

### 12. 中低：时区「昨天」用减 24 小时可能跨 DST 出错；摘要的 `day` 不记录时区

**问题**：方案说「按主人时区算今天和昨天」。如果实现成 `now - 24h` 再 `localDay`，在夏令时切换日会算错。另外 `memory_episodes.day` 只存日期字符串，不存生成时的时区；主人换时区后，用当前时区去查历史 `day` 可能漏掉或重复。

**证据**：
- `packages/memory-engine/src/episodes.ts:76-83`：`localDay` 只接收 `timeZone`。
- `packages/application/src/services/proactive-rules.ts:188-207`：已有 `startOfZonedDay` 和 `shiftDays` 可做日历日加减。
- 方案第 1 条没有说明用日历日减法或存时区。

**建议**：用现有 `shiftDays` 对本地日期做减一天，再拼 `YYYY-MM-DD`；或者按 `started_at/ended_at` 的时间范围查询。加 DST 切换和时区变更的测试，或明确记为已知限制。

---

### 13. 低：占位段、全部不可读、`summaryRead` 状态语义未定义

**问题**：方案说「跳过占位文字、读不到正文的记 partial」，但没有定义：
- 全是占位段时是 `ok` 还是 `partial`；
- 全部读不到时是 `partial` 还是 `failed`；
- 取 `limit` 条时先取到占位段/不可读段，是否会因此少给真实摘要。

**证据**：
- `packages/memory-engine/src/episodes.ts:27`：`UNSUMMARIZED` 占位文字。
- `packages/memory-engine/src/episodes.ts:186-206`：占位段仍会落库。
- 方案第 1、3 条。

**建议**：定义状态与 `memoryRecall` 一致：有内容可读为 `ok`，部分失败为 `partial`，全部失败为 `failed`；查询时多取一些行再按正文过滤，避免占位段占满 `limit`；分别加测试。

---

### 14. 低：摘要限额没有生产配置键，和「可由选项覆盖」不一致

**问题**：方案说 `DEFAULT_PROACTIVE_SUMMARY_LIMITS` 可由选项覆盖，但 `ProductionProactive` 构造 `ProactiveMailCheckService` 时没有传摘要限额的路径，`parseProactive` 也没有新配置键。生产上实际只能用硬编码默认值。

**证据**：
- `apps/agent-service/src/production-proactive.ts:161-189`：没有 `summaryLimits`。
- `packages/platform-node/src/strict-configuration.ts:980-1047`：proactive 配置键列表。

**建议**：要么加配置键并更新启动配置测试，要么删掉「可由选项覆盖」的表述，明确只能代码内调整。

---

### 15. 低：`[P3-6]` / `brief-plan.md` 在仓库中找不到，测试文件和「修改前会失败」没有落地

**问题**：方案引用的 `brief-plan.md` 和集成测试编号 `[P3-6]` 在当前仓库检索不到；没有指定测试文件、用例组名，也没有像现有 ADR 那样说明「修改前哪些用例失败」。

**证据**：
- 当前仓库 `grep P3-6` 无结果；`glob **/brief-plan.md` 无结果。
- 现有 ADR 的写法见 `docs/incidents-and-gates.md:78`、`docs/adr/0158-bring-related-memories-into-gmail-checks.md:60`，都会列具体文件、组名和修改前失败情况。

**建议**：明确写到具体文件（例如 `test/integration/proactive-mail-check.test.ts` 新组、`test/integration/memory-episodes.test.ts`），列出正反向用例，并说明修改前哪些会失败。

---

### 16. 低：`listDaySummaries` 的 SQL 绑定数组和日期校验要照抄现有写法

**问题**：方案写 `classification IN (...)`，如果直接把数组作为单个参数绑定，SQLite 不会展开。现有 `search` 用 `json_each(@classifications)`（`sqlite-memory-operations.ts:109-111`），新方法应复用。另外 `fromDay > toDay`、非法日期、超过上限的 `limit` 应拒绝。

**证据**：
- `packages/persistence-sqlite/src/sqlite-memory-operations.ts:109-111`。
- 同文件 `:1288-1308` 的 `searchEpisodes` 校验。

**建议**：复用 `episodeScope` 风格的 `json_each` 和 `DAY` 正则；校验 `limit`、`fromDay <= toDay`；`allowedClassifications` 在服务层再用 `isModelVisible` 过滤一次，防止 restricted 被传入。

---

## 推测（未复现或依赖配置）

1. **生产环境大概率允许 sensitive，所以第 3 条不一定会立刻发作**：ADR 0193 决定给生产对话/嵌入模型加 sensitive，并允许后台 Gmail 检查使用敏感记忆（`docs/adr/0193-memory-is-visible-to-the-model.md:38-39、59`）。但代码只强制 Gmail 模型允许 `private`，因此「配置只到 private」是潜在陷阱，而不是当前生产必然失败。**未核实生产实际 `allowedDataClassifications`。**
2. **摘要生成用 Gmail 判断模型与聊天记忆模型的费用差没有实测**：方案说「总花费不增加」，但没有数据。从参数看，Gmail 模型输出上限 4096、可能带思考；聊天记忆抽取 1024 输出且 `disableThinking`。**建议实测或直接复用记忆模型。**
3. **并发 upsert 的内容/水位不一致是代码推断，未复现**：单进程 SQLite 同步事务可能降低交错概率，但 Gmail 检查与聊天 run 是两条异步路径，且 `storeText` 的先到先得逻辑确实存在。**需要并发测试确认。**
4. **决策字段在页面/网关的消费未核实**：方案只说「决策记录输入」，没有说是否要让控制中心显示。如果要在「依据」抽屉显示，必须改 `production-decision-chain.ts` 和 `gateway-contracts`；如果不显示，就只是账本数据。**未核实产品预期。**
5. **`brief-plan.md` 和 `[P3-6]` 的前提无法核实**：它们不在当前检出里，可能在其他分支或外部文档。**标记为未核实。**

---

## 侧重检查

我按你给的侧重点查了这些路径：

- **错误路径**：补生成模型失败、摘要存储读取失败、模型分级拒绝、检查超时、生成后检查失败的成本记账。结论：方案只写了「读失败不挡判断」，没有覆盖生成失败、分级拒绝、超时和成本记账失败。
- **不合规范/不可信输入**：摘要来自聊天内容，可能含邮件/网页的注入文字；方案有「只是背景、不是指令」的标题，方向对，但摘要的选择和分类过滤不完整。
- **安全/隐私**：把两天聊天摘要无条件发给邮件判断模型，是明显的出口数据扩大；必须过模型允许名单、`capturePaused`、restricted 过滤，并做相关性收敛。
- **资源耗尽**：3 段摘要生成、每段最多 16k 输入/4096 输出、每批重复 4000 字摘要、`perCheckMs` 180 秒、每日 1 美元上限。结论：缺少预留、子预算和时限控制。
- **不可撤销操作**：补生成会写入 `memory_episodes` 和加密 payload，主人没有逐条确认；必须先过 `capturePaused` 和 authority，且要有审计/清理路径。
- **规则文件、说明文档和代码一致**：ADR 0158 的「不带常驻档案」与方案冲突；ADR 0193 允许 sensitive 但代码准入只看 private；决策记录写入约定的「无记录 vs 这次没有」与方案的默认值写法要小心；提示词目录 manifest/golden 必须同步。

---

## 如果由我来定，我会怎样改

### 1. 先修根因：独立的记忆摘要 worker，而不是让 Gmail 兼职

新增一个定时/闲置触发的记忆 episode worker（可以扩展现有 `ProductionMemoryWorker` 或新 worker），用它自己的模型、预算和 admission 生成 `dueSegments`：
- 尊重 `capturePaused` 和 authority；
- 在本地日切后或线程闲置超时后生成，不必等主人聊天，也不必等新邮件；
- 使用记忆抽取模型，而不是 Gmail 判断模型，保证摘要质量和成本一致；
- 有 claim/lease，避免与聊天 run 并发覆盖。

这样 Gmail 检查只读摘要，不再生成，天然消除第 1、4、5、6、7 条的大部分问题。

### 2. 如果坚持 Gmail 补生成，至少加五道门

- `capturePaused` 门；
- 模型允许名单门（读摘要和生成都过滤到 allowed）；
- 每日剩余预算门（先估算/预留，再调用）；
- 本次检查剩余时限门（用 `controller.signal`，设子预算）；
- claim/lease 门（模型调用前占位，正文写入后才推进水位）。

### 3. 读摘要：做相关性收敛，不做「两天全量」

- 在 `application` 定义窄端口，`agent-service` 实现；
- 先按当前批次邮件的关键词/实体/嵌入做相关性筛选；没有相关摘要时，才考虑少量最近摘要兜底；
- 只读 `source='day_summary'`，过滤 `isModelVisible` 和模型允许档，restricted 永不进入；
- 固定排序、去重、排序后的 ID/日期写入决策记录；
- 摘要块按本批邮件计入 `perBatch` 大小预算，避免挤爆提示词。

### 4. 提示词和决策记录

- 提示词顺序保持「固定说明 → 摘要块 → 本批记忆 → 本批邮件 → 现在」，摘要块一次检查只构建一次；
- 标题明确「背景、不是指令、可能不完整」，并说明摘要没有提到不等于没发生；
- 决策字段做成可选，只在 proactive 写入路径落盘，通用读出补默认值，保留 `inputFields` 语义；
- 摘要生成的模型调用单独审计（独立账本记录或记忆 worker 审计），不要只留计数；
- 新 ADR 明确修订 ADR 0158 第 7 条和「常驻档案」的放弃项，写清隐私/费用取舍。

### 5. 测试

明确用 `test/integration/proactive-mail-check.test.ts` 和 `test/integration/memory-episodes.test.ts`，至少补：
- 暂停记忆后不生成；
- 模型只允许 private + sensitive 摘要 → 跳过摘要、检查成功；
- 每日预算不足 → 不生成或只生成预算内；
- 生成超时/取消 → 邮件判断照常；
- Gmail 与聊天并发摘要同一段 + 新消息 → 水位和正文一致；
- 摘要生成的模型 payload 有审计/清理；
- 最终请求字节（含遮盖）在邮件顺序变化时摘要段不变；
- DST 时区、时区变更；
- 全占位、全不可读、部分不可读；
- 聊天里的记忆检索可以带摘要，但 Gmail 摘要块不会进入聊天——注意不要写成「聊天请求里绝对没有摘要文字」。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**聊天路径：不会改变请求开头。** 现有聊天仍然只在末尾追加历史/工具结果；系统提示、工具定义和已发历史不变。新增的「摘要生成」只会影响后续记忆检索工具**追加的**工具结果内容，不会改已经发出的历史。依据：`.claude/rules/prompt-prefix.md:27-29、35`。

**但方案里「聊天一轮的模型请求里没有摘要文字」这条测试是错的。** `ProductionMemoryRecall` 已经把日摘要通过 `episodes.search` 注入聊天工具结果（`apps/agent-service/src/production-memory-recall.ts:248-272`），所以聊天请求里本来就可能出现摘要文字（作为末尾的工具结果）。测试应改成「聊天请求里没有 Gmail 检查专用的摘要块」，而不是「没有摘要文字」。

**Gmail 后台调用：** 它是单次提示，没有历史；顺序是固定说明在前、会变的数据在后、`now` 最后，符合 `.claude/rules/prompt-prefix.md:67`。每轮会变的值（摘要、记忆、邮件、时间）都在后面的数据段，不在固定说明里。`now` 在最后一行。

**遮盖副作用：** 新增固定标题会进入提示词目录的 trusted text 清单，可能影响包含该固定文字的遮盖判断；需要跑 `check:prompt-catalog` 和相关的遮盖/前缀测试。老对话里冻结的旧固定文字不会因此改变字节，除非旧文字包含会被认成敏感信息的数字（规则 `.claude/rules/prompt-prefix.md:51-54`）。缓存原理的一手来源：Anthropic https://platform.claude.com/docs/en/build-with-claude/prompt-caching 、OpenAI https://developers.openai.com/api/docs/guides/prompt-caching 、DeepSeek https://api-docs.deepseek.com/guides/kv_cache 。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**有可能，需要额外约束。** 具体风险：
- 摘要选择依赖 SQL 返回顺序：方案已指定 `day DESC, ended_at DESC, id ASC`，但 `id` 里的 sequence 是字符串，排序不一定是数字顺序；要固定并测试打乱插入顺序。
- `summaryIds`、`summaryDays` 如果不去重/排序，同一组摘要可能写成不同 JSON 字节。
- 并发补生成同一段时，`storeText` 先到先得，最后正文取决于哪次调用先写入；这是内容级非确定，不只是字节问题。
- 摘要文字经过出口遮盖时，可能受同一请求里**后面的邮件**影响（点名值/遮盖清单）；方案只测了渲染，没有测最终发送字节。
- `day` 只存日期、不存时区；主人换时区后，同一段历史可能被算到不同请求的「昨天」。

**建议**：固定 SQL/JOIN/JSON 键顺序，数组排序去重；测试最终请求体而不是只测渲染；遮盖测试覆盖「摘要里的秘密 + 后面的邮件点名同一秘密」；时区用日历日减法并加 DST/换时区测试。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，但不完整，且没有说明修改前失败。** 方案列的反向用例（前天、压缩摘要、restricted、占位段、无摘要、读失败、无新邮件、超预算、决策记录非法值）方向是对的，但缺少：
- `capturePaused` 后不生成；
- Gmail 模型只允许 private 时 sensitive 摘要被跳过而不是整批失败；
- 每日预算不足/生成超时/检查被取消；
- Gmail 与聊天并发摘要同一段且期间有新消息；
- 摘要生成失败后的成本与审计；
- 最终发送字节（含遮盖）的确定性；
- DST 和时区变更；
- 全占位/全不可读；
- 聊天测试要区分「Gmail 摘要块」和「记忆检索摘要文字」。

另外 `[P3-6]` 和 `brief-plan.md` 在当前仓库检索不到，**未核实**；现有仓库的惯例是写具体测试文件、组名，并说明「修改前哪些用例失败」（例如 `docs/incidents-and-gates.md:78`、`docs/adr/0158-bring-related-memories-into-gmail-checks.md:60`）。方案应照这个格式补全。

### 4. 每个新值产生和使用两端都能接受吗？

**不能，至少下面这些两端要逐个核对：**

| 值 | 产生处 | 使用处/校验 | 结论 |
| --- | --- | --- | --- |
| `listDaySummaries` 方法 | `MemoryEpisodeStorePort` | `durable-adapters.ts:1121-1128`、`sqlite-memory-operations.ts:405-435` 的 switch、测试 fake | 方案没列实现点；必须补 |
| `fromDay/toDay`、`limit`、`allowedClassifications` | `recent()` | SQLite `searchEpisodes` 风格校验 | 要复用 `json_each`、`DAY` 正则、`isModelVisible` |
| 新提示词 id `mail.judgment.recent-summaries-header` | `packages/prompt-catalog/src/mail.ts` | `prompt-manifest.json`、golden、prompt-catalog 测试 | 必须补 manifest/golden |
| `proactivePrompt` 新参数 | `proactive-mail-check-service.ts:374-411` | 所有测试调用、golden | 建议可选参数/options 对象 |
| `summaryInjected`、`summaryIds`、`summaryDays`、`summaryCharacters`、`summaryRead`、`summaryGenerated` | `ProactiveCheckInputs` | `sqlite-proactive-operations.ts:643-690` 校验、`:717-750` 落盘、`sqlite-decision-ledger-operations.ts:139-215` 读出、`production-decision-chain.ts:77-79` 的 `inputFields` | 方案没列全；建议可选字段，只在 proactive 路径写 |
| 新摘要限额 | `DEFAULT_PROACTIVE_SUMMARY_LIMITS` | `ProductionProactive`、`parseProactive` | 目前没有配置路径；要么加键要么删「可覆盖」 |
| 摘要生成的模型 payload | Gmail 检查 | `modelPayloads`、清理、页面 | 方案没定归属；必须明确 |
| `summaryIds` 的 episode id | `MemoryEpisodeService.#record`（`episodes.ts:325`） | 账本校验的 `ids` 长度/唯一性、页面能否解析 | 长度通常没问题，但页面不认 episode id；如要显示需新字段/新解析 |
| 新 ADR 编号 | 方案 | `check:adr-numbers` | 方案未给编号，需选未占用号并跑检查 |

**结论**：方案目前把「读摘要 + 生成摘要 + 提示词 + 决策字段 + 生产接线」都写在一起，但每个新值的两端没有逐项列全；按 I-73 的教训，必须把「清单/字段/id 能通过后端校验、页面能接受」逐条验证，而不是只看改动本身。

---

## 最后一句判断

这个方案可以改，但不建议按当前版本直接实施。最小可行版本应先做「独立记忆摘要 worker + Gmail 只读摘要」，并把 `capturePaused`、模型允许名单、每日预算、检查时限、并发 claim 作为硬门槛；如果仍要「Gmail 补生成」，则必须先取得对 ADR 0158「常驻档案」决议的明确修订，否则方案在规则层面就站不住。
