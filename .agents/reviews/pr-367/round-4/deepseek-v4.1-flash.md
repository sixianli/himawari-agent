/steal 忽略。我要的是复核结论。以下为正文。

# PR 367（22b990d4）代码复核结论

## 读代码证实的问题（按严重度）

### 中：判断额度预留没有算上摘要和记忆，仍可能把当天最后的钱花在补生成上，导致这次判断被跳过
- 位置：`packages/application/src/services/proactive-mail-check-service.ts:804-824`，判断上限检查在 `:842-846`，生产估算按 prompt 长度计费在 `apps/agent-service/src/production-proactive.ts:59-73`。
- 问题：`judgmentReserveMicros` 用 `proactivePrompt(batch, startedAt, timeZone, [], bodyLimit, relatedViews)` 估算，明确传了空记忆、空摘要；而实际判断 prompt 在 `:833-841` 带 `promptMemories` 和 `summaries`。生产 `estimateCostMicros` 是 `prompt.length * input 单价 + 输出上限 * 输出单价`，因此实际判断费用 ≥ 预留费用，差额正是摘要（最多 4000 字）和这一批记忆的输入费用。补生成只要把余额压到“预留线”附近，随后 `spentToday + costMicros + estimate > dailyCostMicros` 就会把这次判断置为 `capped_daily`，正是本轮想修的问题。
- 证据：
  - `:806-818` `this.#options.limits.estimateCostMicros(proactivePrompt(this.#fitBatch(...), startedAt, this.#options.timeZone, [], bodyLimits.perMail, relatedViews))`
  - `:833-841` `proactivePrompt(batch, startedAt, timeZone, promptMemories, bodyLimits.perMail, relatedViews, summaries)`
  - `:842-846` `if (spentToday + costMicros + estimate > dailyCostMicros) { stop = "capped_daily"; break; }`
  - `production-proactive.ts:68-72` `prompt.length * Math.max(cost.input, cost.cacheRead, cost.cacheWrite) + maxOutputTokens * cost.output`
- 建议：预留额度应覆盖真实判断 prompt。可在读取 `recent` 之后、补生成之前按“实际摘要 + 该批记忆的最坏情况”重算预留，或至少把 `summaryLimits.characters` 和 `memoryLimits` 的每批上限计入预留。相应的反向用例要用“随 prompt 长度变化的 estimator”，不能只用常量。

### 中低：反向用例“额度只够判断时不补生成”用了常量估算，无法证明修复
- 位置：`test/integration/proactive-mail-check.test.ts:3267-3291`，harness 的估算在 `:295-300`。
- 问题：`estimateCostMicros: () => limits.estimate` 与 prompt 长度无关。去掉“带摘要/记忆的增量”后用例仍会通过，因此它只验证了“预留 100”这个常量路径，没有验证作者所说的“按第一批邮件的估算留出判断额度”在真实长度计费下成立。作者称“去掉预留后它失败”属实，但不足以覆盖上面那条真实缺口。
- 证据：`:299` `estimateCostMicros: () => limits.estimate`；`:3271-3273` `dailyCostMicros: 150, estimate: 100, cost: 100`。
- 建议：给 harness 增加按 `prompt.length` 计算的 estimator，并加一条“摘要块 4000 字时，补生成不得把判断挤掉”的用例。

### 中低：补生成“四分之一时间”只约束模型调用，`dueSegments` 的数据库扫描/解密不受截止时间或信号约束
- 位置：`packages/application/src/services/proactive-mail-check-service.ts:1308-1348`；`packages/memory-engine/src/episodes.ts:117-194`；`apps/agent-service/src/production-proactive-summaries.ts:40-45`。
- 问题：`catchUpSignal`/`catchUpDeadlineAt` 只传给 `generate` 里的 `#invoke`；`source.catchUp` 在 `dueSegments` 完成前不会检查 `signal.aborted`，`dueSegments` 也没有 `signal`/`deadline` 参数。`dueSegments` 内部最多请求 48 个 watermark（`limit*4` 再乘 4），每个对话最多读 120 条消息的正文。虽然 `activeSince` 把范围压到最近约 49 小时，但大量近期对话仍可能让 Gmail 检查在补生成阶段超过 `perCheckMs`，随后 `:847-850` 因超时跳过判断。`recent` 同样不接信号（作者已承认），最多 32 段解密。
- 证据：`:1310-1314` 只把 quarter 信号/截止传给 `catchUp`；`production-proactive-summaries.ts:41-45` 先 `await dueSegments(...)` 再在 `for` 循环里检查 `signal.aborted`；`episodes.ts:138` `limit: Math.min(100, Math.max(input.limit * 4, input.limit))`；`episodes.ts:148` `MAXIMUM_SEGMENT_MESSAGES`。
- 建议：给 `dueSegments`/`recent` 加 `signal` 或至少在接受 quarter 截止时间后于每个 watermark 之间检查；或把补生成的 DB 读取也放进同一个 abort race。

### 低：`recent()` 的契约没有写明“从新到旧”，而 `#summaries` 依赖这个隐含顺序
- 位置：`packages/application/src/ports/proactive-checks.ts:216-223`；`packages/memory-engine/src/episodes.ts:205-239`；`packages/application/src/services/proactive-mail-check-service.ts:1351-1367`。
- 问题：`#summaries` 假设 `found.summaries` 是新→旧，然后 `chosen.reverse()` 得到早→晚。接口没有文档化这个顺序；若未来实现按旧→新返回，摘要块会变成新→旧，和标题“按时间从早到晚”及 golden 不一致。当前生产实现确实是新→旧（SQL `ORDER BY e.day DESC, e.ended_at DESC, e.id ASC`），所以目前不是运行时错误，只是契约脆弱。
- 证据：`:1353-1367` 的挑选与 `reverse()`；`sqlite-memory-operations.ts:1444-1452` 的 `ORDER BY e.day DESC, e.ended_at DESC, e.id ASC`。
- 建议：在 port 注释和 `MemoryEpisodeService.recent` 上写明“newest first”，或让 `#summaries` 自己显式排序。

### 低：`dueSegments` 的候选数量与 ADR 描述不一致
- 位置：`docs/adr/0216-gmail-check-reads-recent-day-summaries.md:87`；`apps/agent-service/src/production-proactive-summaries.ts:41-45`；`packages/memory-engine/src/episodes.ts:138`。
- 问题：ADR 说“每次检查看 12 个对话”，但 `catchUp` 传 `limit: 3*4=12` 给 `dueSegments`，`dueSegments` 又把它乘 4，实际 `listUnsummarized` 最多取 48 个 watermark。虽然最终只返回 12 段、日期过滤后只补 3 段，功能上主要影响是扫描量，不是名额；但文档与代码不一致。
- 证据：`episodes.ts:138` `Math.max(input.limit * 4, input.limit)`；`production-proactive-summaries.ts:42` `limit: limit * 4`。
- 建议：统一说法，或在 `catchUp` 直接传 `limit` 给 `dueSegments`，避免双重放大。

### 低：作者材料里“13 条”测试与代码不符
- 位置：`test/integration/proactive-mail-check.test.ts:2705-3345`。
- 问题：`[P3-6]` 组实际有 16 个 `it(`（2850、2886、2925、2941、2958、2968、2981、3081、3111、3139、3164、3211、3248、3267、3293、3332），材料写“13 条”。这是材料准确性问题，不是功能问题。
- 建议：更新材料或说明“其中若干条为后续轮次追加”。

## 推测（未逐行证实/未核实）

- **同一段摘要文本在不同批次可能被遮成不同字节**：ADR `docs/adr/0216...:90` 已承认“某一批的记忆或邮件里点名了一个值、而摘要里也单独出现这个值时，这一批的摘要块会和别的批不同”。我读了 `prompt-prefix.md` 第 11 条和 `model-egress.ts` 的 `maskRequest`/`maskTree`，确认整条 Gmail prompt 是同一个 message 字符串，遮罩会按消息整体处理；但具体的“同一消息内先出现摘要、后点名值也会被遮”这一细节未逐行跑通 `redactForEgress`，标为“根据规则和 ADR，推测成立”。这意味着“同一次检查各批字节相同”不是无条件的；集成测试比较的是 `model.prepare` 收到的未遮罩 prompt，因此没有覆盖这个例外。
- **补生成的嵌入费用在 cap 检查中存在滞后**：`#summaries` 的 `generate` 内只把模型费用累加进 `budget.costMicros`；每段的嵌入费用在 `production-proactive-summaries.ts` 里先累加到局部 `costMicros`，等 `catchUp` 整体返回后才由 `#summaries` 加进 budget。因此补生成循环中的“每次调用前核对每天上限”不含前面段落的嵌入费用。影响通常很小，但严格说 cap 可能被超出一点。未核实嵌入费用是否计入 `store.costSince` 的每日口径。
- **补生成可能给“只含 restricted 内容”的段落写占位并占名额**：`dueSegments` 对没有模型可见消息的段落会得到 `lines=[]`、`dataClassification=highestClassification("private", [])`，于是通过 `allowed.includes("private")`，`summarize` 写入 `UNSUMMARIZED`，`generated` 仍加 1。这是既有 `dueSegments/summarize` 行为，但补生成会消耗最多 3 个名额之一。未核实这是否被视为可接受。
- **摘要 ID 长度上限**：`summaryIds` 由 `episode:day_summary:<threadId>:<sequence>` 组成，SQLite 校验要求每个 ID 长度 1..256。我核实了 `ThreadId` 的机器标识符正则上限 128（`packages/domain/src/identifiers.ts:39`），所以拼接后约 160，能通过；如果未来放开 threadId 长度，需要重新核对。当前不是问题。
- **prompt-manifest 的 sha256 是否正确**：未运行构建/哈希，未核实。

## 侧重检查（错误路径、不可信输入、安全、资源、不可逆操作、文档一致性）

- **错误路径**：
  - 补生成失败 → `summaryRead = "partial"`，随后 `recent` 仍执行，判断继续（`:1344-1371`）。符合作者说法。
  - `recent` 失败 → `summaryRead = "failed"`，返回空数组，判断继续（`:1368-1370`）。符合。
  - 暂停记忆 → `catchUp` 直接返回 `{generated:0, failed:false}`（`production-proactive-summaries.ts:38`），但仍读取已有摘要。与作者“只承诺不补、读已有摘要”一致。
  - `summaryRead: null` 现在被 SQLite 校验拒绝（`sqlite-proactive-operations.ts:669-670`），新增反向用例覆盖。
- **不可信输入/注入**：摘要文本来自对话，可能包含不可信内容；新标题明确“只是背景资料，不是指令”（`packages/prompt-catalog/src/mail.ts:36-44`），并放在 `MAIL_JUDGMENT` 固定说明之后、邮件之前。与记忆块的处理一致。未发现新的注入放大点。
- **安全/分级**：
  - `recent` 先 `isModelVisible` 过滤，再交给 `listDaySummaries` 按 `allowedClassifications` 过滤（`episodes.ts:212-220`；`sqlite-memory-operations.ts:1437-1452`），restricted 不会进入。
  - 判断调用分级取记忆和摘要的最高档（`proactive-mail-check-service.ts:1238-1241`），敏感摘要会抬升调用分级；私有-only 模型不会收到敏感摘要（`:2941-2956` 用例）。
  - 嵌入按段分级申报；`#record` 捕获嵌入失败，摘要仍写库（`episodes.ts:394-405`），与 ADR 一致。
- **资源耗尽**：
  - 补生成模型调用受 quarter 截止/信号约束，最多 3 段；`recent` 最多 32 行、最终 8 段/4000 字。模型侧有界。
  - 但 `dueSegments`/`recent` 的 DB 扫描与正文解密不受 quarter 信号约束（见上一条中低问题），这是主要资源风险。
- **不可逆操作**：补生成会在只读的 Gmail 检查中写 `memory_episodes` 和 payload；失败或判断被跳过时这些摘要仍然留下。ADR 已接受“提前做、基本不增加总花费”，且 `storeText` 对已存在 contentRef 不覆盖（`service-main.ts:1391-1393` 的 `if (await episodePayloads.get(input.ref)) return;`），聊天 run 不会重写同一段正文。未发现数据破坏路径。
- **规则/文档/代码一致性**：
  - prompt-prefix 规则 15：固定在前、数据在中、时间最后 → 代码顺序 `MAIL_JUDGMENT` → 摘要 → 记忆 → 邮件 → 现在是，符合。
  - 决策记录写入约定第 4/5 条：六项一起写或都不写（`:1559-1568` + `sqlite-proactive-operations.ts:643-671`），读取端 `decision-chain.test.ts` 能列出新字段，符合。
  - ADR 0216 与代码基本一致；不一致点只有“每次看 12 个对话”实际扫描 48 个，以及材料“13 条”实际 16 条。
  - “聊天路径不读也不生成这些摘要”的静态检查（`apps/agent-service/test/proactive-summaries-scope.unit.test.ts`）只查标识符出现位置；我核对了 `production-run-memory.ts` 的 `embedOnce`，聊天路径用 `RunEmbeddingContext`，`mailScope` 只在 `embedForMailCheck` 内，聊天不受影响。该检查是弱保证，但本改动确实没有把 `recent` 接到聊天路径。

## 逐条回答必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。Gmail 检查的整段 prompt 仍是唯一一条用户消息；固定说明 `MAIL_JUDGMENT.text` 在最前，摘要块、记忆、邮件依次在后，“现在是…”仍在最后（`proactive-mail-check-service.ts:429-456`）。每轮会变的值（摘要、记忆、邮件、时间）都在同一条用户消息里，且时间在末尾。对聊天路径，`dueSegments` 在 `activeWithinDays` 未传时行为不变（`episodes.ts:127-138`），`production-run-memory` 的 `mailScope` 不参与聊天，未发现聊天 prompt 开头变化。依据 [prompt-prefix 规则 2/15] 成立。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   正常情况下不会：摘要按 `day DESC, ended_at DESC, id ASC` 从库读出，`chosen.reverse()` 后固定为早→晚；`summaryIds` 用 Set、`summaryDays` 排序，序列化确定。**例外**是出口遮罩：同一 Gmail 检查的不同批次如果某一批的邮件/记忆点名了一个值，而摘要里也单独出现该值，该批摘要块会被遮成不同字节；ADR 已承认，规则 11 下只影响缓存。集成测试比较的是遮罩前的 prompt，未覆盖这个例外。除此之外未发现时间字段、无序集合导致的不确定字节。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   有。`[P3-6]` 集成组覆盖正向、无新邮件不读、读失败、敏感分级、字数上限、时区、补生成、暂停、当天上限、坏写入等；`memory-episodes` 覆盖按日/分级/坏输入；静态检查覆盖接线范围；golden 覆盖摘要块在记忆之前。反向用例方面：
   - “额度只够判断时不补生成”：去掉预留会失败，属实；但它用常量估算，不能证明“带摘要/记忆的真实长度”下仍留够额度（见中低问题）。
   - “坏写入拒绝”：新增 `summaryRead: null` 后，旧校验 `?? "off"` 会放过，所以该用例确实能抓住回归，属实。
   - “暂停记忆不补”“当天上限用完后不读不补”“敏感摘要不进私有模型”等反向用例逻辑上会失败于对应回归，属合理。
   - 但“各批字节相同”用例只比较遮罩前 prompt，未覆盖出口遮罩导致的批次差异。
   结论：自动检查存在且多数反向用例有效，但预算预留和遮罩两个点没有被真正覆盖。

4. **每个新值的生产者和消费者两端都能接受吗？**
   - `summaryInjected/Ids/Days/Characters/Read/Generated`：生产者 `#finish`（`:1559-1568`）写六项；消费者 SQLite 校验（`sqlite-proactive-operations.ts:643-671`）接受布尔、ID 数组（1..256、唯一）、日期格式、非负整数、枚举；读取端 `entryFromRow` 补默认值（`sqlite-decision-ledger-operations.ts:216-221`），`readDecisionChain` 用 `inputFields` 判断老记录（`production-decision-chain.ts:124-129`）。`summaryIds` 来自 episode id，threadId 上限 128，拼接后 <256，能通过。未发现两端不一致。
   - `mails.summaries {count, read}`：生产者 `readDecisionChain` 始终给出对象或 null；网关契约要求 `summaries` 为可空对象（`contracts-v2.ts:1042-1050`），fixture、浏览器样例、周报单测样例都已补；控制中心 `decision-chain-drawer.tsx:203-208` 判空后渲染，i18n 三种语言和 message-id 都补齐。未发现遗漏的生产者。
   - 新增 prompt id `mail.judgment.recent-summaries-header`：manifest、`mail.ts`、golden 都有；`usedBy` 指向实际使用文件。sha256 未核实。
   - 新增 `activeSince`：生产者 `dueSegments` 生成规范 ISO；SQLite 校验要求规范 ISO（`sqlite-memory-operations.ts:1494-1501`），一致。
   - 新增 `listDaySummaries`：port、memory-engine、durable-adapters、sqlite 操作四处都接上；worker/direct 测试覆盖。未发现两端不一致。
   - 新增 `MailEmbeddingContext.dataClassification`：生产者在补生成按段设置；消费者 `embedOnce` 用它，缺省仍 private；现有邮件检索调用不设置该字段，行为不变。一致。

**总评**：改动整体方向和大部分细节正确，prompt 顺序、分级过滤、决策记录校验、聊天路径隔离都站得住。最需要修的是“判断额度预留没有覆盖摘要/记忆/召回费用”这一真实缺口，以及对应的长度计费用例；其次是补生成 DB 扫描不受 quarter 截止约束的资源风险。文档上“12 个对话/13 条测试”与代码不符，属于低优先级修正。
