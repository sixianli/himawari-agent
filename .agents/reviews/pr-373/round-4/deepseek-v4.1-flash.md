## 一、读代码证实的问题（按严重度）

### 1. 中：配置允许 1000，但周报会生成 `Infinity`，网关校验必然拒绝
- 文件：`packages/calibration/src/prereview.ts:355-358`、`apps/agent-service/src/production-observation.ts:328`、`packages/platform-node/src/strict-configuration.ts:1174-1181`、`packages/gateway-contracts/src/validation.ts:127-136`
- 问题：`hiddenAgreementPermille` 的配置上限是 1000。但 Wilson 下限对任何有限样本都严格小于 1，所以 `minimumAgreementToPass(samples, 1000)` 永远返回 `null`，`minimumPairsToPass` 最终返回 `Number.POSITIVE_INFINITY`。生产代码把它直接放进周报快照的 `minimumPairs`；网关契约要求 `integer(1)`，而 `Number.isSafeInteger(Infinity)` 为 false，`gatewayV2MessageSchema.parse(snapshot)` 会抛错，周报查询整体失败。
- 证据：
  - `parseReviewPrereview`：`hiddenAgreementPermille: number(..., 500, 1_000)`（严格配置第 1174-1181 行）。
  - `minimumPairsToPass`：循环到 10000 后 `return Number.POSITIVE_INFINITY;`（约 355-358 行）。
  - `minimumPairs: minimumPairsToPass(prereviewSettings.agreementPermille)`（production-observation 第 328 行）。
  - `integer`：`!Number.isSafeInteger(input)` 就失败（validation 第 127-136 行）。
- 建议：把配置上限降到 999，或把 `minimumPairsToPass` 的 `null` 情况在快照里改成可空/有限哨兵，并同步放宽契约；补一条 `hiddenAgreementPermille: 1000` 的周报用例。

### 2. 中：周报和“隐藏”用的时间窗口、版本选择不是同一套
- 文件：`packages/calibration/src/prereview.ts:227-240、275-291`、`packages/persistence-sqlite/src/sqlite-review-prereview-operations.ts:236-258`、`packages/application/src/services/review-prereview.ts:264-268`
- 问题：隐藏用的 `listPairs` 按 **预评创建时间** `p.created_at >= since` 过滤，并用**当前运行时**的 `modelRef`/`promptId`；周报 SQL 按**决策时间** `COALESCE(d.checked_at, m.processed_at)` 过滤，再按窗口内预评的 `createdAt` 最大者选“最新版本”。两者在窗口口径和版本口径上都可能不同：
  - 很久以前做出、最近才打分的决策会进周报，但不在隐藏的 28 天预评窗口里；
  - 最近预评、但决策时间在窗口外的条目不进周报，却参与隐藏门槛；
  - 配置回滚到旧提示词时，隐藏会用旧版本的存量预评，周报仍按 `createdAt` 选较新的版本，数字和实际隐藏依据对不上。
- 证据：
  - 周报：`AND COALESCE(d.checked_at, m.processed_at) >= ? AND ... < ?`（prereview.ts 第 238-239 行）。
  - 周报版本：`row.createdAt >= found.createdAt` 取最新（第 279-285 行）。
  - 隐藏：`p.created_at >= ?`（sqlite-review-prereview-operations.ts 第 248 行），版本来自 `this.#options.model.modelRef` 和当前 `promptId`（review-prereview.ts 第 267 行）。
- 建议：明确统一一种窗口键（决策时间或预评时间）和一种版本来源（当前运行时版本，或查询时同时返回运行时版本并在周报只显示该版本）；加一条“窗口内决策时间与预评时间不一致”的交叉用例。

### 3. 低/中：作者说的“只给主人看拿不准或冲突的”与代码不一致
- 文件：`packages/calibration/src/prereview.ts:50-57、169-217`、`packages/application/src/services/review-prereview.ts:302-315`
- 问题：`wouldHide` 只在模型评 `useful`、把握够高且无历史冲突时返回 true。模型自信地评 `unneeded` 或 `missed` 时不会被隐藏，仍然给主人看。也就是说，“只给主人看模型拿不准或和以往打分冲突的那些”并不成立；代码实际是“只隐藏模型自信判对的那些”。ADR 0237 的决定 4 内部定义与这句话也不完全一致。
- 证据：
  - `wouldHide`：`return pair.model === "useful" && pair.confidencePermille >= confidencePermille && !pair.historyConflict;`（prereview.ts 第 50-57 行）。
  - canhide 只对大类的 `gate.open` 生效，但仍要过 `wouldHide`（review-prereview.ts 第 302-315 行）。
- 建议：确认产品语义。如果目标确实是“所有自信的预评都隐藏”，需要把 `unneeded`/`missed` 也纳入并重新定义门槛；如果只隐藏自信“有用”，把 ADR、任务描述和作者说法改成一致。

### 4. 低/中：网页周报的“没有预评”空状态在生产不可达，反向浏览器用例没有测到生产行为
- 文件：`apps/control-center/src/components/weekly-report.tsx:1388-1390`、`apps/agent-service/src/production-observation.ts:330-342`、`packages/calibration/src/prereview.ts:172-176`
- 问题：`summarizePrereviewAgreement` 总是对 `PREREVIEW_GROUPS` 每一项都返回一组，所以生产返回的 `prereview.groups.length` 恒为 5，永远不会走 `weekly.prereview.empty` 分支。浏览器反向用例之所以通过，是因为夹具直接返回了 `groups: []`（`test/e2e/fixtures/control-center-browser-server.mjs` 的 `weeklySnapshot(withMails=false)`），这不是生产路径。
- 证据：
  - `summarizePrereviewAgreement` 是 `PREREVIEW_GROUPS.map(...)`（prereview.ts 第 172-176 行）。
  - 生产：`groups: prereview.groups.map(...)`（production-observation.ts 第 330-342 行）。
  - UI：`report.prereview.groups.length === 0 ? ...empty... : ...`（weekly-report.tsx 第 1388-1390 行）。
- 建议：把 UI 判断改为“所有组 `prereviewed === 0`”或让生产者没有数据时返回空数组；用真实的 `summarizePrereviewWeek` 结果补一条反向用例，而不是只用夹具。

### 5. 低：读取历史或写失败行失败时，模型调用费用/次数会丢失，重启后当日上限会少算
- 文件：`packages/application/src/services/review-prereview.ts:231-256`
- 问题：模型调用成功返回后，`ownerHistory`、`record` 都在同一个 `try` 里。若 `ownerHistory` 抛错（读表失败），虽然模型费用已经发生，但既不会 `record` 也不会 `recordFailure`；catch 只把 key 放进内存里的 `#storeFailedAt`。进程重启后该 key 不再退避，且这次调用的费用没有进入 `countSince`，当日 `dailyCostMicros` / `dailyLimit` 会少算。
- 证据：
  - `const history = await store.ownerHistory(...)` 与 `await store.record(...)` 同在 try 内；catch 只 `this.#storeFailedAt.set(subject.key, nowMs)`（第 237-256 行）。
  - 上限从表里数：`countSince`（第 156 行）只统计已落表的行。
- 建议：把 `ownerHistory` 的错误与写失败分开处理；只要模型调用已返回，就尽量写 `recordFailure`（或一条带 `STORE_FAILED` 的失败行）。若确实写不进去，至少把这一事实作为可观测错误暴露，并明确这是上限的已知缺口。

### 6. 低：`promptId` 只哈希固定文字，不覆盖动态 `options` 和遮盖规则
- 文件：`packages/application/src/services/review-prereview.ts:144-145、63-74`
- 问题：`promptId` 是 `REVIEW_PREREVIEW.id@sha256(REVIEW_PREREVIEW.text)[:12]`，但真正发给模型的提示词还包括 `prereviewOptions(subject.group)` 和 `maskSensitiveText(subject.text)`。如果以后修改了各类可选评价（`APPLICABLE_RATINGS`）或遮盖规则，固定文字不变，`promptId` 不变，新旧预评会被当成同一版本参与一致率和隐藏门槛，尽管模型看到的字节已经不同。
- 证据：`promptId` 仅对 `REVIEW_PREREVIEW.text` 取摘要（第 144-145 行）；提示词里 `options: prereviewOptions(subject.group)`（第 70 行）。
- 建议：将提示词模板版本包含 `options` 的结构/取值和遮盖规则版本一起纳入 `promptId`，或显式维护一个提示词格式版本号。

### 7. 低：命令行周报用硬编码门槛，不读配置
- 文件：`scripts/calibration-report/report.mjs:105-108`
- 问题：作者说“门槛、信心、抽查比例来自配置”。网页周报确实来自配置，但 `scripts/calibration-report/report.mjs` 固定传 `DEFAULT_PREREVIEW_AGREEMENT_PERMILLE` / `DEFAULT_PREREVIEW_CONFIDENCE_PERMILLE`，不读 `runPolicy.proactive.reviewPrereview`。改了配置后，命令行周报和网页周报会给出不同门槛结论。
- 建议：命令行也读产品配置（或明确文档说明 CLI 固定用默认值），并补一条“配置不是默认值时 CLI 与网页一致”的检查。

## 二、推测 / 未核实

- **推测**：`packages/persistence-sqlite/src/data-export/schemas.ts:238-340` 把 `prereviews` 加成了 `EVIDENCE_SCHEMA` 的必填字段，但 `FORMAT_VERSION` 仍是 `himawari.data-export.v1`。旧版本导出的 sealed 文件没有这个字段，`validateAgainst(SEALED_SCHEMA, value)` 可能直接拒绝导入。未找到旧 sealed 文件兼容性用例，未核实实际是否会破坏已有备份。
- **推测**：`review-prereview.ts:211-214、234` 把 `error.message` 拼进 `PREREVIEW_FAILED:...` 并写入 `decision_prereviews.failure_code`。这张表在设计上是 metadata-only；如果模型/网关错误消息里带上了输入片段，可能把敏感文本带进未加密的元数据表。未找到会回显输入的 provider，未核实。
- **未核实**：没有运行任何测试（按约束只读），下面关于“会失败/会通过”的判断来自读断言和代码路径。

## 三、侧重检查

- **失败路径和重启上限**：失败行确实会带 `costMicros` 落表（集成用例断言 700），`countSince` 同时统计 done/failed，重启后次数上限可守住（用例覆盖 `dailyLimit`）。缺口是第 5 条：`ownerHistory`/写表失败时费用和次数可能不落表；`dailyCostMicros` 跨重启没有专门用例。
- **DELETE 触发器与级联**：触发器是“父行仍存在才拦”（`0091...sql:66-77`），与既有 `decision_signals_no_delete` 的模式一致。集成用例覆盖了删除决策、清除邮件记录；删除 owner/agent 的级联没有直接用例，但从 SQLite 父行先删、再触发子级联的行为看应该放行（未运行验证）。
- **数据导出导入**：字段逐个核对完整（18 个表字段 + import 补 owner/agent）；没有口令时 `sealed` 为 null，`prereviews` 不会被导入（`import.ts:72-88、190`），用例也覆盖。旧 sealed 格式兼容性见“推测”。
- **预评写进主人打分**：搜索确认 `reviewPrereview.record/recordFailure` 只写 `decision_prereviews`；预评服务只读 `decision_ledger`/`proactive_processed_messages`。集成用例也断言主人评分前后不变。未发现写入路径。
- **不可信输入/安全**：`parsePrereview` 限制输出必须能 JSON 解析、评价必须在允许集合、把握度 0..1000；存储层校验 group、classification、digest、时间、cost、duration、subject 归属；导出 schema 与 DB CHECK 两端基本对齐。`failureCode` 的敏感内容风险见“推测”。
- **资源耗尽**：`perRun`、`dailyLimit`、`dailyCostMicros`、`MAX_OUTPUT_BYTES = 4096` 都有上限；待评条目是懒构建（`listDailyReviewSubjects` 只返回 `build` 闭包，`run` 里逐个调用）。`hiddenByModel` 会为所有可隐藏候选重算一次文字，条目多时会增加读记忆次数，但受每日打分池限制，风险不大。
- **规则、文档、代码一致性**：发现三处不一致：隐藏语义（第 3 条）、周报/隐藏窗口与版本（第 2 条）、CLI 门槛不读配置（第 7 条）；另有 ADR 中“空状态”与生产行为不一致（第 4 条）。

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？
对本功能本身：不会改变主对话的系统提示、工具定义、历史消息或已有遮盖结果。预评是**另一次独立的后台模型调用**，其内容是固定提示词在前，本条数据 JSON 在最后一行（`review-prereview.ts:63-74`），没有把时间、模型版本、费用等每轮变化值放进固定文字；`review()` 的隐藏计算和周报也不发给模型。因此符合“只在末尾追加、每轮变化值放最后一条消息”的规则。
但要注意：`promptId` 的版本标识不覆盖动态 `options` 和遮盖规则（第 6 条），这是版本一致性缺口，不是请求开头被改写。

### 2. 同一段文字会不会在不同请求里变成不同字节？
在同一个代码/配置版本内：不会。提示词 JSON 的键顺序固定，`prereviewOptions` 顺序固定，`maskSensitiveText` 是确定性函数，提示词里没有时间或随机值；`hiddenByModel` 的摘要用的是原始文字，也确定。
跨版本：会存在“同一 `promptId` 对应不同字节”的风险，因为 `promptId` 只哈希固定文字，不覆盖 `options` 列表和遮盖规则的代码版本（第 6 条）。这是“版本标识不完整”，不是单次请求内的不确定性。

### 3. 有没有自动检查，反向用例真的会失败？
有：预评、失败退避、上限、隐藏正反向、删除/级联、数据导出往返、无口令不导入、网页正反向、门槛/抽查/历史冲突的单元测试都在仓库里。
但反向覆盖有缺口：
- 浏览器“没有预评”的反向用例只喂了 `groups: []` 的夹具，生产实际恒返回 5 个组（第 4 条），该用例不能证明生产空状态正确；
- `dailyCostMicros` 跨重启没有专测；
- 迁移 0091 没有专门验证 `model_usage_observations` 旧数据原样搬回、旧 purpose 仍能读的用例，只更新了迁移序号；
- 配置 `hiddenAgreementPermille: 1000` 的周报失败路径没有覆盖；
- 删除 owner/agent 的级联没有直接用例，只有删除 decision 和清除邮件记录。
我没有运行测试，无法确认真实红绿，只能确认断言和路径存在/缺失。

### 4. 每个产生/修改的值，两端都能接受吗？
逐项核对结果：
- `review-prereview` 用途：应用层 `MODEL_USAGE_PURPOSES`、迁移 CHECK、`ProductionModelComposition` 的 purpose 类型、控制中心 `MESSAGE_PURPOSES` 与三语文案都包含，接受。
- `decision_prereviews` 行：导出字段、导入字段、导出 schema、DB CHECK 基本一致；owner/agent 在导入时由 scope 补上；没有口令时不会写入。接受。
- `hiddenByModel`：生产快照产出整数，网关契约 `integer(0)`，UI 当计数用，接受。
- `prereview.groups` / `gate` / `confusion` / `agreement`：生产者与 `calibrationGroupSchema`、`calibrationRateSchema`、`proactiveRatingSchema` 对齐，接受。
- `minimumPairs`：**不接受**。配置 1000 时生产者产出 `Infinity`，网关要求 `integer(1)`（第 1 条）。
- `promptId`/`modelRef`/`id`/`textDigest`/`failureCode`/`costMicros`/`durationMs`/`createdAt`：长度、格式、范围两端基本对齐；`failureCode` 在服务端截到 128，DB 也限制 128。
- `prereview` 的 `group`/`rating` 组合：存储层用 `acceptsPrereview`，DB 用 CHECK，导出 schema 只做枚举；导入最终由 DB CHECK 兜底，能拒绝非法组合。

总体：未发现高严重度缺陷，也没有发现把预评写进主人打分的路径；最需要先修的是第 1 条的 `Infinity` 周报崩溃和第 2 条周报/隐藏口径不一致。
