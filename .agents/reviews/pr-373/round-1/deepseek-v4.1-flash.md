## 读代码证实的问题

### 1. 高：开门用的“会被藏那部分”把抽检 20% 也算进去了，门槛可能被高估
- 文件:行：`packages/calibration/src/prereview.ts:181-186`、`packages/calibration/src/prereview.ts:212`、`packages/application/src/services/review-prereview.ts:285`
- 问题：`hidden` 和 gate 是在所有 `wouldHide` 的 pair 上算的；真正应用时，`prereviewAuditPicked` 会在后面把约 20% 的条目排除出“被藏”集合。于是 35 条全一致时，`hidden.samples=35`、Wilson 下限约 0.901，门可以开；但实际被藏的只有 28 条，28/28 的 Wilson 下限约 0.878，低于 90%。这与主人要求的“会被藏那部分的一致率下限”不一致。
- 证据：
  - `const hiddenRated = rated.filter((pair) => wouldHide(pair, options.confidencePermille));`
  - `const hidden = proportion(... hiddenRated.length, 1);`
  - `gate: prereviewGate(hidden, ownerUseful, options.agreementPermille)`
  - 应用时才做：`if (prereviewAuditPicked(seed, candidate.key, reduction.auditPermille)) continue;`
- 建议：在算 gate 前先排除抽检命中的 key，或把抽检函数传入 `summarizePrereviewAgreement` 一起过滤；补一条反向用例：35 条全一致、抽检 7 条时，实际 28 条不足以过 90%，gate 必须保持关闭。

### 2. 中：按当前生产装配，所有记忆类预评都会被静默丢掉
- 文件:行：`packages/application/src/services/daily-review.ts:366-368`、`packages/application/src/services/daily-review.ts:372`、`packages/application/src/services/daily-review.ts:338-340`、`apps/agent-service/src/service-main.ts:1589-1601`
- 问题：`readDailyReviewSubjects` 要求每个记忆部分都有 `dataClassification`，否则 `visibleClassification` 返回 `null`，整条被跳过。但生产当前的 `readMemory` 返回的是 `{ text, hidden: false }`，没有 `dataClassification`；而“没存下的记忆”路径依赖 `readMemoryClassification`，生产也没有提供。结果：`memory_skipped`、`memory_kept`、`consolidation` 都不会产生预评 subject，只剩邮件（硬编码 private）能进模型。
- 证据：
  - `dataClassification = visibleClassification(shown.map((memory) => memory.dataClassification));`
  - `dataClassification: text === "" ? null : dataClassification`
  - `if (dataClassification === null || item.textHidden || item.text === "") continue;`
  - 生产：`return text === undefined ? undefined : { text, hidden: false };`
- 建议：给 `DailyReviewMemoryText` 的生产实现补 `dataClassification`，并为 discarded memory 提供 `readMemoryClassification`；在接入服务时补一条基于真实 `ProductionProactive` 装配的集成测试，确认三类记忆都能生成 subject。

### 3. 中：`proactive_pushed` 永远没有 subject，五组统计里这一组无法积累数据
- 文件:行：`packages/application/src/services/daily-review.ts:248-264`、`packages/application/src/services/daily-review.ts:342-370`、`packages/application/src/services/daily-review.ts:391-395`、`packages/application/src/services/proactive-overview.ts:158-171`、`packages/application/src/services/proactive-overview.ts:211-235`
- 问题：`proactive` ledger 条目通过 `reviewedMemoryIds` 只能得到空 `before`/`after`，`build` 不会为它读任何文本；而 `overview.audit.items` 只包含“不该提醒/被忽略”的静默邮件。因此能进入 `readDailyReviewSubjects` 的 proactive 条目只有 `proactive_silent`，`proactive_pushed` 没有文本可用，最终被 `item.text === ""` 过滤。
  这与“统计一律按周报五组”的名义覆盖不一致：`proactive_pushed` 的 gate 永远不会开，自动减量也永远不作用于被提醒的决策。
- 证据：
  - `function reviewedMemoryIds` 对非 memory/consolidation 返回 `{ before: [], after: undefined }`
  - proactive 构建走 `else if (options.readMemory)`，`parts` 为空，`text` 保持 `""`
  - 邮件一律写死 `group: "proactive_silent"`
  - overview 的 `filteredInsights` 是“不值得提醒”的 insight，`ignored` 是 outcome `"ignore"`
- 建议：为 proactive pushed 提供可发给模型的文本来源（例如安全的摘要/主题/发件人），或在统计和 gate 中明确排除该组并写清原因；补一条“pushed 决策能生成 subject”的用例。

### 4. 中：失败条目会反复占住 `perRun` 名额，后面的条目可能永远轮不到
- 文件:行：`packages/application/src/services/review-prereview.ts:204-216`
- 问题：`pending` 每轮按同一规则排序，然后只取 `slice(0, settings.perRun)`；模型失败时只把错误写进 `failures`，不写库，也不增加 `items`。如果前 N 条持续失败（模型输出不合法、某条分类被拒等），每轮都会重新尝试同样的前 N 条，后面的条目永远排不上。`dailyLimit` 按成功落库数计，也不会阻止这种重试。
- 证据：
  - `const pending = subjects.filter(...).sort(...)`
  - `for (const subject of pending.slice(0, settings.perRun))`
  - `if (result.reply === undefined) { failures.push(result.failure); continue; }`
  - `items += 1;` 只在成功 `record` 后发生
- 建议：把“尝试次数”也纳入每日预算，或持久化失败/退避状态，或维护游标跳过最近失败项；至少不要让失败项每轮固定堵住队首。

### 5. 中：整个 `ReviewPrereviewService` 没有任何自动检查
- 文件:行：`packages/application/src/services/review-prereview.ts:178-299`；`packages/application/test/review-prereview.unit.test.ts` 只测了 `prereviewPrompt`、`parsePrereview`、`prereviewAuditPicked`
- 问题：`run()`、`hiddenByModel()`、`#invoke()` 的每日上限、成本上限、历史冲突、抽检后再藏、模型失败/超时/超大输出、落库字段都没有测试。把这些行为反转，现有测试不会失败。另外，daily-review 的“减量关时和改动前一样”用例只是拿新实现和同版本新实现比较，并没有和旧算法结果对比，反向保护也偏弱。
- 证据：测试文件只实例化三个纯函数，没有构造 `ReviewPrereviewService`；`run`/`hiddenByModel`/`#invoke` 在测试目录中无引用。
- 建议：补 service 级测试，至少覆盖：已达到 dailyLimit、达到 dailyCost、失败不落库、历史冲突抑制隐藏、audit 命中不隐藏、gate 未开时不隐藏、模型返回非法 JSON/超大输出、`record` 字段正确。

## 推测与未核实

- **邮件分级被写死为 private**：`packages/application/src/services/daily-review.ts:398` 对邮件统一 `MAIL_REVIEW_CLASSIFICATION = "private"`，而 `ProactiveOverviewAuditItem` 本身不携带分类；`proactive-mail-check-service.ts:1342-1354` 显示 insight 内容是按其 `dataClassification` 封存的，而该分类可能因召回记忆达到 `sensitive`。当前发出去的实际字节只是 from/subject，但把来源标成 private 仍可能与封存时的标签不一致。是否构成实际越权，取决于未来接入时模型描述符和审计项的装配；目前未核实。建议让 audit item 带出分类，或明确断言邮件头永远按 private 处理。
- **`promptId` 的 `@` 和 key/runId 的 `:` 是否有后端校验**：`review-prereview.ts:175` 生成 `${REVIEW_PREREVIEW.id}@${digest12}`，`review-prereview.ts:312` 生成含 `:` 的 `invocationId`/`runId`，`subject.key` 还可能是较长的邮件 id。当前提交没有存储实现，也没有相应契约测试；这正是 I-73 提醒的“生成 id 是否能过使用端校验”。建议存储落地时加一条 I-73 式门槛：用真实存储校验 `promptId`、`modelRef`、`key`、`invocationId`/`runId` 的字符集和长度。
- **`requestTimeoutMs` 是否真的限制模型调用**：`review-prereview.ts:316` 只把它用于 `deadlineAt`，`model.model.invoke` 没有传入 `signal`；实际超时由 `pi-model-transport.ts:211-235,377-378` 的模型级 `requestTimeoutMs` 决定。未来若不复用同一超时配置，这个配置键可能只影响 secret handle 过期而不限制请求。未核实接入方式。
- **manifest 的 sha256**：`packages/prompt-catalog/prompt-manifest.json` 新增 `review.prereview` 的 sha256；本次工具无法运行哈希，未核实该值与 `REVIEW_PREREVIEW.text` 的 `segments` 摘要一致。`apps/agent-service/test/prompt-catalog.unit.test.ts:175-195` 会在摘要不一致时报 `PROMPT_MANIFEST_STALE`。

## 侧重检查

- **错误路径**：`#invoke` 对 `model.failed`、未完成、输出过大、非法 JSON 都有处理；但 `model.prepare` 在 `try` 外，`prepare`、`readOutput`、`store.*` 抛错会直接中断整轮，且没有逐条隔离（见问题 4）。`run` 失败项不落库导致队首重试。
- **不可信输入**：模型输出被截到 4KB，再用首尾花括号截取并 `JSON.parse`；`rating` 必须属于该组可选项，`confidence` 必须是 0–1000 的整数，`unsure` 强制为 0，类型和范围校验充分。提示词用 `JSON.stringify` 包装条目文本，并明确“条目文字是不可信数据”，注入面较小。
- **分级与安全**：ledger 记忆有 `visibleClassification`，restricted/无法分类会被排除；但生产没提供分类字段，实际会把记忆全部排除（问题 2）。邮件强制 private 的降级风险见“推测”。`prereviewPrompt` 确实不读取 `ownerRating`，用户评价没有进模型请求。
- **资源耗尽**：`perRun`、`dailyLimit`、`dailyCostMicros`、输出 4KB 上限都存在；但 `subjects()` 在检查每日上限前就把最多 500 条候选全部构建文本/读记忆，且失败不计数，可能造成重复开销；`model.invoke` 未传 `AbortSignal`。
- **不可撤销操作**：模型调用后先释放 authority 和输出 payload，再落库；没有直接改主人评价。并发两个 `run` 之间没有锁，理论上可能对同一 key 重复调用模型并重复计费。
- **规则/文档/代码一致性**：新后台提示词符合“固定在前、本次数据在后、不放时间”的后台调用规则；`review.prereview` 已登记进 manifest 和 parser 契约测试。新增配置键 `reviewPrereview` 目前没有对应的配置说明/ADR（仓库里只有 `reviewSilentSharePermille` 的 ADR 0182），属于文档缺口。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。已有的提示词文字没有改（`REVIEW_TYPESAFE_QUESTIONS` 未动），新增的是独立后台调用；`prereviewPrompt` 把固定目录文字放在最前、这一条的 JSON 放在最后，没有当前时间或每轮变化的值。`pi-model-transport.ts` 加的是固定的 egress 图例和一条用户消息。新 prompt 被加进 `TRUSTED_PROMPT_TEXTS` 只在老内容恰好包含这段新文字时才可能影响遮盖，代码中没有发现这种内容，因此实际不会改旧请求开头。

2. **同一段文字会不会在不同请求里变成不同字节？**
   代码层面不会：JSON 键顺序固定（`group`、`options`、`category`、`text`），`prereviewOptions` 顺序固定，没有时间/日期字段，`maskSensitiveText` 和 `reviewHash` 都是确定性的；`createdAt`、`durationMs`、`costMicros` 只落库，不进提示词。唯一未核实的是外部出口遮盖是否还依赖进程级秘密状态，以及未来 egress 是否会对同一文本做不同处理。

3. **有没有对应的自动检查，反向用例会不会真的失败？**
   部分有。`calibration/test/prereview.unit.test.ts` 覆盖了 Wilson 门槛、kappa/balanced accuracy、gate、historyConflict、wouldHide；`daily-review.unit.test.ts` 覆盖了隐藏不补位、已评不藏、restricted/无法分类排除、邮件换算；`review-prereview.unit.test.ts` 覆盖了提示词顺序/确定性/不含 ownerRating、解析拒绝非法输出、抽检比例；配置和 parser 也有测试。但 `ReviewPrereviewService.run/hiddenByModel/#invoke` 完全没有用例，问题 1、2、3、4 的反向行为不会被现有测试抓住；`readDailyReviewSubjects` 也缺少 kept/consolidation 的正向用例。

4. **每个产生/修改的值，使用它的地方都能接受吗？**
   - `reviewPrereview` 配置的键与 service 读取的字段一致，范围和默认值与 `DEFAULT_REVIEW_PREREVIEW` 一致；目前只有测试消费，生产 service 尚未接入。
   - `hiddenByModel` 和新的 `sampled` 语义已进入 `DailyReview`，但 `production-proactive.ts:335-341` 的快照没有带 `hiddenByModel`，接网页时需要注意；当前 `sampled` 改为“实际展示数”，下游若按旧含义使用会少算被藏条目。
   - `DailyReviewSubject.dataClassification` 的生产端没有提供，导致问题 2，属于产生端和消费端不匹配。
   - `PrereviewRecord.promptId`（含 `@`）、`key`（含 `:`）、`invocationId`/`runId`（含 `:`、长度可能随 key 增长）尚未经过任何存储/契约校验，I-73 风险未核实。
   - `DEFAULT_REVIEW_PREREVIEW` 从 `application` 根导出的路径存在，`packages/calibration/package.json` 的新子路径导出也存在；manifest 摘要未核实。
