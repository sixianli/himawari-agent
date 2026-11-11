# 复核报告：PR 373 第 1 部分（P4-8 模型预评，不改表）

## 侧重检查

我走的最普通流程（减量默认关闭）：

1. **打分页读取**：网页 → gateway `proactive.review.read` → `ProactiveService.review()`（apps/agent-service/src/production-proactive.ts:308-321，**不传 `hideByModel`、不传 `readMemoryClassification`**）→ `readDailyReview`（daily-review.ts:450）→ `collectReviewCandidates` → `selectDailyReview`（daily-review.ts:88-144）→ snapshot 组装（production-proactive.ts:330-344）。
   - 结论：这条路径上本次改动**不改变行为**（`hidden` 为 `undefined` → 空集 → `shown === taken`），已有负例测试锁住（daily-review.unit.test.ts:470-474）。
   - **无测试覆盖的路径**：`production-proactive.review()` 的参数装配、gateway snapshot 的字段挑选（`hiddenByModel` 被丢掉，见问题 2）都没有测试触及；`proactive-production.test.ts` 只加了一行配置默认值。
2. **预评流程**：`ReviewPrereviewService.run()` / `hiddenByModel()`（review-prereview.ts:186, 269）——**没有任何生产调用方**（grep 全仓库只命中定义和导出），即本提交里整条预评链路是死代码，与作者「接进服务在后续提交」的说法一致。
3. **配置流程**：`parseReviewPrereview`（strict-configuration.ts:1065）→ 负例数组断言 throw（startup-configuration.unit.test.ts:1431-1458）✓。
4. **提示词登记流程**：`fixedPrompt` → manifest 行 → `apps/agent-service/test/prompt-catalog.unit.test.ts:300`（digest 校验）和 `prompt-output-contracts.unit.test.ts`（parser 登记）✓，且 manifest 测试带 REVERSE 用例（同文件 :370）。

---

## 发现的问题（按严重度从高到低）

### 1. 中 | packages/application/test/review-prereview.unit.test.ts（全文件）
**问题**：`ReviewPrereviewService.run()` 和 `hiddenByModel()` 完全没有测试。本 PR 最关键的行为——每轮 `perRun` 限额、`dailyLimit`/`dailyCostMicros` 停机、gate 消费（`open` 才减量）、`record.group !== candidate.group` 跳过、audit 抽检跳过、`listPrereviewed` 复用——都在这两个方法里，一个用例都没有。
**证据**：该测试文件只 import 并测试了 `prereviewPrompt`、`parsePrereview`、`prereviewAuditPicked` 三个纯函数（第 2-8 行）。
**建议**：在第 2 部分接线之前补 service 级单测（用桩 store/model 驱动 `run()` 的四种 `stoppedBy` 和 `hiddenByModel` 的 gate→audit→wouldHide 链），否则第 2 部分接上真实存储时这些逻辑第一次被执行是在生产。

### 2. 中 | apps/agent-service/src/production-proactive.ts:336-344
**问题**：gateway snapshot 只透出 `sampled/notSampled/items/folded`，不含 `hiddenByModel`。一旦第 2 部分接通减量，主人会看到打分页凭空少条目、`sampled` 数字变小，页面上没有任何「被模型藏了 N 条」的解释。
**证据**：payload 显式列字段：`day, capacity, sampled, notSampled, items, folded, generatedAt`（production-proactive.ts:336-343），没有 `hiddenByModel`。
**建议**：第 2 部分接减量时必须同步补这个字段；本条作为接线验收项记下。

### 3. 低 | packages/application/src/services/daily-review.ts:135
**问题**：`sampled` 语义变了：改动前是 `taken.length`（选中数），现在是 `shown.length`（去掉被藏后的展示数）。减量关闭时两者相等（作者说法成立），但减量开启后所有把 `sampled` 当「选中条数」消费的地方含义都变了。
**证据**：daily-review.ts:133-135 `sampled: shown.length`；消费方 production-proactive.ts:338 原样透传给网页。
**建议**：在网页部分核对 `sampled` 的展示语义，或改名为 `shownCount` 类似的名字。

### 4. 低 | packages/calibration/src/prereview.ts:170-180
**问题**：`agreementPermille`（「一致率阈值 90%」）实际作用在**会被藏部分**的 Wilson 下限（`hidden.low < agreementPermille / 1000` → `below_threshold`），整体一致率字段 `agreement` 不参与 gate。这与验收描述「会被藏那部分的一致率下限…」一致，但配置键名会让后来的读者以为是整体一致率达标才开门。
**证据**：prereview.ts:177 `if (hidden.low < agreementPermille / 1000)`；`summarizePrereviewAgreement` 里 `agreement`（第 196-199 行）没有任何 gate 消费。
**建议**：改名为 `hiddenAgreementPermille`，或在文档里写明口径。

### 5. 低 | packages/application/src/services/review-prereview.ts:225-228
**问题**：日成本预算用 `estimateCostMicros(prompt)` 预判，实际花费（`result.costMicros`）可能大于估计值，最后一条会把 `dailyCostMicros` 略微顶穿；失败条目的花费也计入 `costMicros` 但不计入 `items`，两个口径可能不一致。
**证据**：`if (costMicros + this.#options.estimateCostMicros(prompt) > settings.dailyCostMicros) return …`，随后 `costMicros += result.costMicros`。
**建议**：可接受，但在存储端口实现时把两口径写清楚。

### 6. 低 | packages/application/src/services/review-prereview.ts:188-190
**问题**：`promptId = REVIEW_PREREVIEW.id + "@" + digest(...).slice(0,12)`，`digest` 由调用方注入。将来 SQLite 接线时若传入的 digest 实现和 `textDigest` 的不一致或日后更换，`listPrereviewed`/`listPairs` 按 `promptId` 过滤会把全部历史预评判为不存在，gate 永远 `insufficient`（I-73 式「两端没对上」的风险点）。
**证据**：`get promptId()` 与 `textDigest: this.#options.digest(subject.text)` 用同一个注入函数，但存储端过滤（端口定义第 116-135 行）要求精确匹配。
**建议**：第 2 部分接线时把 digest 的实现固定并写进文档/测试。

### 7. 信息 | packages/calibration/src/prereview.ts:80-97
**推测→已核实无问题**：`reviewHash` 用于 `prereviewAuditPicked` 的 `% 1000`，我专门核对了非负性——循环最后一步是 `Math.imul(value, 0x01000193) >>> 0`（daily-review.ts:62），返回值恒为非负 uint32，不存在负数取模导致抽检率虚高的问题。

---

## 作者说法逐条核对（读代码证实）

| 说法 | 结论 |
|---|---|
| 减量关时选择结果与改动前完全一样 | ✅ 证实。`hidden ?? new Set()`（daily-review.ts:130），空集时 `shown = taken`、`sampled = taken.length`，与旧代码逐值相同；有负例测试锁住 |
| 模型请求里没有主人的评价 | ✅ 证实。`prereviewPrompt` 只放 `group/options/category/text`（review-prereview.ts:64-74），测试断言不含 `ownerRating` |
| restricted / 分不清级别不发给模型 | ✅ 证实。`visibleClassification` 遇 `undefined` 或 `restricted`（`isModelVisible` 只放行 public/private/sensitive，model-visibility.ts:10-14）返回 null，`readDailyReviewSubjects` 跳过（daily-review.ts:437）。注意：**sensitive 级别会发给模型**（只做遮盖），说法没覆盖这一点但符合现有模型可见规则 |
| 统计一律按周报五组 | ✅ 证实。`PREREVIEW_GROUPS = MAIN_CALIBRATION_GROUPS`（5 组），候选组的 `calibrationGroupOf` 把 pushed/silent 分开（daily-review.ts:153-160） |
| 邮件「有用」= reviewedAt 非空且 rating 为空，两处同换算 | ✅ 证实。同一行 `rating: mail.rating ?? (mail.reviewedAt !== null ? "useful" : null)`（daily-review.ts:406）同时服务打分页和 subjects |
| 预评请求固定目录文字在前、JSON 在最后 | ✅ 证实（`prereviewPrompt` join 顺序），但「是否真是一条用户消息」取决于第 2 部分的模型适配器接线，**未核实** |

## 必答问题

1. **不改已有请求开头。** 证实：manifest 只新增 `review.prereview`，没有任何既有提示词被改；`TRUSTED_PROMPT_TEXTS` 新增一条固定文字只豁免包含该文字的内容，现有请求不含它，遮盖字节不变；`selectDailyReview` 只影响主人打分页，不进任何模型请求。新预评请求是独立的一次性后台调用：固定目录文字在前、本条 JSON 在最后，符合规则第 15 条。`check:prompt-prefix` 门槛存在（规则文件第 74 行，含反向用例），本次未运行。
2. **字节确定。** 证实：`prereviewPrompt` 的 JSON 用字面量 `JSON.stringify`（键序固定）；`maskSensitiveText` 是单字符串纯函数（redaction.ts:542-544）；`reviewHash` 非负、audit 抽检只依赖 seed+key；gate 遍历固定组序；`Set` 只做成员判断。提示词里没有时间字段（`invocationId` 含时间戳但不是发给模型的内容）。跨天同一 key 文字可能变（记忆正文被整理），那是内容本身变了，不是序列化不确定。
3. **有自动检查，反向用例存在。** manifest digest 有正向+REVERSE 测试（prompt-catalog.unit.test.ts:300,370）；`prompt-output-contracts` 强制 background prompt 配 parser；配置负例 6 条断言 throw（startup-configuration.unit.test.ts:1444-1449）；calibration/daily-review 测试带 `[negative]` 用例。我核对的是断言方向正确，**未能实际运行**。缺口见问题 1：service 两个方法零覆盖。
4. **逐值核对两端：** `reviewPrereview` 配置键（产：strict-configuration，消费：端口必填字段+测试，默认值单一来源 `DEFAULT_REVIEW_PREREVIEW`，全仓库仅 3 个构造点均已含）✅；`review.prereview` id+sha256（有 CI 校验测试）✅；`APPLICABLE_RATINGS` 重命名（原名模块私有，仅两处内部使用）✅；`reviewHash` 导出（函数体不变，新旧消费方都安全）✅；`hiddenByModel` 字段（生产方有，消费方暂无，网页属第 2 部分）⚠️ 待接；**`ReviewPrereviewStorePort`/`PrereviewRecord` 只有要求方没有实现方，端口两端校验无法核对——这正是 I-73 的教训所在，必须在第 2 部分落表时补两端核对**（未核实）。
