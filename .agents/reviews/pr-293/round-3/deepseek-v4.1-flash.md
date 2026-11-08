## 一、读代码证实的问题（按严重度）

### 1）中低：不完整周的“观察信号”卡片把“周没结束”显示成“样本不足”
- 文件：`apps/agent-service/src/production-observation.ts:248-258`、`apps/control-center/src/components/weekly-report.tsx:1081-1087`
- 问题：服务在周未完整时把 `rate` 设为 `null`，前端对 `null` 走了“样本不足”文案。
- 证据：
  - `production-observation.ts:256`：`rate: complete ? item.rate : null,`
  - `weekly-report.tsx:1081-1087`：
    ```tsx
    {item.rate?.enough && item.rate.value !== null
      ? message("weekly.ratio", ...)
      : message("weekly.few", { n: report.implicit.pushedDecisions })}
    ```
  - 同一页其它比例卡片用 `withheld` 隐藏比例并显示“周未结束”（`weekly-report.tsx:916,927,938`），只有隐式信号卡片没有用 `report.ratesWithheld`。
- 影响：不完整周里 `pushedDecisions > 0` 时，用户会看到“样本不足（N 条）”，而不是“本周尚未结束”。作者“周未完整时不给比例（null）”在数据层成立，但展示层把两种 `null` 混为一谈。现有测试没有覆盖“不完整周 + pushedDecisions > 0 + rate=null”：`weekly-report.unit.test.ts` 的不完整 fixture 里 `implicit.pushedDecisions` 是 0。
- 建议：把 `report.ratesWithheld`/`complete` 传进隐式卡片；未完整时显示“本周尚未结束”并隐藏比例，或复用 `weekly.type.notFull`。补一条 `complete:false、pushedDecisions>0、rate:null` 的浏览器用例。

### 2）低：第 3 轮引入了重复测试
- 文件：`test/integration/decision-signals.test.ts:385-411` 与 `:440-466`，`:413-438` 与 `:468-487`
- 问题：同一 `it.each` 删除用例完整重复了两遍；重放用例也重复（一个走 `recordDecisionSignal`，一个走原始 SQL）。提交说明说“补 ON CONFLICT 重放用例”，但第一份重放用例在第 2 轮已存在，第 3 轮又加了一份并重复了一份删除用例。
- 证据：两段 `it.each([["the Agent", ...], ["the whole account", ...]])("removes the signals when %s is deleted", ...)` 的标题和函数体逐字相同。
- 影响：不改变正确性，但增加运行时间、误导覆盖率判断，且说明第 3 轮修改有复制粘贴失误。
- 建议：删掉重复的删除用例；保留一份 `recordDecisionSignal` 重放用例和一份原始 SQL `ON CONFLICT` 用例，并改成可区分的名字。

### 3）低：schema 目录只登记了一个写入端口
- 文件：`packages/persistence-sqlite/src/schema-catalog.ts:813-819`，对比 `:799-805`
- 问题：`decision_signals` 的 `productPort` 写成 `"DecisionLedgerPort"`，但实际写入发生在主动检查和网页推送两个端口里。
- 证据：
  - `schema-catalog.ts:814-816`：`entry("decision_signals", "DecisionLedgerPort", ...)`
  - `sqlite-proactive-operations.ts:790`、`:954` 和 `sqlite-web-push-operations.ts:504` 都调用 `recordDecisionSignal`
  - 相邻的 `decision_ledger` 条目写的是 `"ProactiveStorePort, DecisionLedgerPort"`（`schema-catalog.ts:800-801`）
- 影响：目录是数据表归属和删除策略的说明来源，少写写入端口会让后来的人误判谁可以写这张表，和规则文件/代码不一致。
- 建议：改成 `"ProactiveStorePort, WebPushStorePort, DecisionLedgerPort"`（按端口实际名称），保持与 `decision_ledger` 同样的写法。

### 4）低（性能/资源）：按 `push_source_key` 关联没有索引
- 文件：`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:475-483`，`packages/persistence-sqlite/src/migrations/0080_decision_signals.sql:30-37`
- 问题：点开信号查询和迁移回填都用 `decision.push_source_key = feedback.source_key` 关联，但 `decision_ledger` 没有 `push_source_key` 索引。
- 证据：
  - `sqlite-web-push-operations.ts:480-481`：`AND decision.push_source_key = feedback.source_key AND decision.kind = 'proactive'`
  - `0080_decision_signals.sql:34-36` 回填同样按 `feedback.source_key = decision.push_source_key`
  - `decision_ledger` 的索引是 `(owner_id, agent_id, kind, checked_at)`（`0069_decision_ledger.sql:74`），无法直接定位 `push_source_key`
- 影响：每次首次打开推送都要在该 owner/agent 的全部历史决策里扫一遍；迁移回填是一次性全表关联。以每 15 分钟一次检查的速度长期增长后，这会变成可感知的开销。
- 建议：在 0080 里加部分索引 `(owner_id, agent_id, push_source_key) WHERE push_source_key IS NOT NULL`；若业务上可保证同一 owner/agent 内 `push_source_key` 唯一，可考虑唯一索引。

## 二、推测 / 未核实

### 5）低（推测）：回填对历史时间的格式没有防御
- 文件：`packages/persistence-sqlite/src/migrations/0080_decision_signals.sql:5-9`、`:28-37`
- 问题：回填直接把 `web_push_feedback.opened_at` / `first_sent_at` 写进带 `GLOB '????-??-??T??:??:??.???Z'` CHECK 的列，并用 `julianday()` 算延迟。若历史库里存在格式不符的 `opened_at`，`INSERT` 会违反 CHECK；若 `julianday()` 返回 NULL，`delay_ms` 的 NOT NULL 也会让迁移失败。
- 现状：当前写入路径都经过 `this.time()` 校验，正常数据不会出问题；我没有历史库样本，无法确认是否存在旧版本写入的不规范值，因此只标为推测。
- 建议：回填里加 `feedback.opened_at GLOB '????-??-??T??:??:??.???Z' AND feedback.first_sent_at GLOB ...` 过滤，或用 `COALESCE(..., 0)`；补一条“历史时间格式坏掉时迁移不中断/按策略跳过”的迁移测试。

### 6）低 / 未核实：Runbook 封存哈希
- 文件：`docs/runbooks/decision-record-observation-runbook.md:5`、`:15-22`
- 事实：`runbook-contract` 清单里有 `apps/agent-service/src/production-observation.ts` 和 `scripts/calibration-report/report.mjs`，这两个文件本次都改了，所以 `contract_sha256` 确实需要更新。作者已把值改成 `864e...`。但当前环境只允许 git 读，不能运行 `runbook.py seal` 或 `validate_docs.py --strict`，我无法确认新哈希是否正确。
- 另外：Runbook 正文新增了对 ADR 0182 的引用，但 `runbook-contract` 清单没有加入 ADR 0182（也没有 0080 迁移）。将来改信号口径时，这份 Runbook 不会被判为过期。
- 建议：用文档技能重新封存并跑严格校验；如果认为 ADR 0182 属于这份 Runbook 的依据，把 ADR 0182（必要时加 0080）加入 `runbook-contract` 后重新 seal。

### 已记录、按指示不重复的点
- ADR 0182:70 已写明“一条待发推送覆盖多个决策时，一次点开会给每个共用决策各记一条 opened”。
- ADR 0182:72 已写明分母含 `deferred`、用户可能在发出前关掉提醒。
- ADR 0182:67 已写明撤销/回复挂到“更新它的那次决策”。
- ADR 0182:74 已写明周报按决策所在周归属信号，而不是按信号发生时间。
以上均不再作为新意见提出。

## 三、侧重检查

- 错误路径与不可信输入：
  - `recordReactions` 对 `reactions` 数量（≤50）、`tag` 长度、时间都有校验（`sqlite-web-push-operations.ts:452-463`）。
  - `listSignals` 走 `idList`，限制 200 个 id、去重、长度 1-256（`sqlite-decision-ledger-operations.ts:21-39`）。
  - `detail` 在表上有 `json_valid(detail) AND json_type(detail)='object'`，`occurred_at`/`recorded_at` 有 GLOB，`delay_ms` 有上下界（`0080_decision_signals.sql:5-9`）。
  - 回填是唯一没有对历史时间格式做防御的入口（见推测 5）。
- 安全与敏感信息：
  - 新表只存 `signal`、时间、`delay_ms`、`source_ref`、小型 `detail`，不含正文、密钥或邮箱内容；`source_ref` 是推送键/提醒 id + 时间。
  - 没有新增敏感信息检测规则，也没有改出口遮盖或提示词，符合“敏感信息规则只在专用包”。
- 资源耗尽：
  - 单次反应最多 50 条，`listSignals` 最多 200 个决策；`decision_signals` 去重约束避免无限重放增长。
  - 缺少 `push_source_key` 索引（见问题 4）。
- 不可撤销操作：
  - `decision_signals_no_update` 无条件 `RAISE(ABORT)`；`decision_signals_no_delete` 只在 decision/agent/owner 都还存在时阻止删除，删除决策、Agent、账户时的级联在条件上会放行（`0080_decision_signals.sql:17-24`）。
  - 我无法运行测试，因此“级联删除实际成功”只能依据代码条件和作者说法；测试文件确实覆盖了决策、Agent、账户三条删除路径。
- 规则、说明文档与代码一致性：
  - ADR 0182:42-47 与代码基本一致：点开在 `recordReactions`、撤销在 `updateInsight`、回复在 `record` 的 `markReplied` 前后、回填、`listSignals`、周报单独一节、`reviewSilentSharePermille`、只观察不自动改门槛。
  - 不一致处：schema 目录端口（问题 3）、不完整周 UI 文案（问题 1）、Runbook 封存未核实（问题 6）。
  - 作者说“回复只在提醒推送过时记”：代码用 `source_insights.push_source_key !== null` 判断（`sqlite-proactive-operations.ts:789`），符合“提醒推送过”的口径。
  - 作者说“回填 id 固定长度”：确实是 `'signal:backfill:' || lower(hex(randomblob(16)))`（`0080:29`），长度固定。
  - 作者说“周报在周未完整时不给比例（null）”：`production-observation.ts:256` 确实给 `null`，但展示层有上述问题 1。

## 四、必答问题

1. **这个改动会不会改变模型已经见过的请求开头？**
   不会。改动涉及的是 SQLite 迁移、主动检查写信号、日报抽样、周报/校准报告和网页展示。没有改 `packages/prompt-catalog`、`packages/runtime-pi`、出口遮盖、历史序列化或工具定义。新增的读取入口是控制中心查询（`production-proactive.ts:306-318` 的 `review()`、`production-observation.ts:171-264` 的周报查询）和命令行报告，不是模型请求。因此发给模型的内容仍然只在末尾追加；新增的每轮变化值（打开/撤销/回复时间、随机 id）没有进入系统提示、工具定义或历史。

2. **这个改动会不会让同一段文字在不同请求里变成不同的字节？**
   不会进入模型请求，所以不影响模型请求的字节。代码里确实新增了 `randomUUID()` 作为 `decision_signals.id`（`decision-signals.ts:33`）和时间字段（`occurred_at`、`recorded_at`），但只写数据库、只被周报/`listSignals` 读取；`summarizeImplicit` 的输出也不参与提示词。报表内部若同一时间戳有多个信号，排序用随机 id 作 tie-break（`calibration/src/index.ts:441`），但这只影响报表行顺序，不影响模型缓存。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   有。`test/integration/decision-signals.test.ts`、`packages/application/test/daily-review.unit.test.ts`、`apps/control-center/test/weekly-report.unit.test.ts`、`packages/platform-node/test/startup-configuration.unit.test.ts` 和迁移序号测试都已更新。CI 的 `test` 作业运行 unit/contracts/integration/e2e/pi-compat，`browser` 作业运行 control-center 的 `*.unit.test.ts`，所以这些新测试在 CI 自动检查内（`ci/policy.json` 的 `test.projects` 和 browser project）。
   注意：本地 `npm run check` 的 `check:steps` 不包含 `test`/`test:integration`，只跑各项静态检查；如果作者说的“自动检查”指 `npm run check`，那是不包含这些测试的，需要靠 CI 的 test 作业。
   反向用例分别覆盖：dismissed/未知 tag/没推送决策不记点开；完成但未撤销、未处理再设未处理不记撤销；已完成提醒上的回复、重复回复不记；直接改/删信号被触发器拒绝；删除决策/Agent/账户时级联删除；回填只回填 opened；同一 `(decision_id,signal,source_ref)` 重放只留一行；加入信号后打分比例不变；`reviewSilentSharePermille` 的 0/1000/250/800 等边界和范围外拒绝。逻辑上这些用例在对应行为缺失时会失败，但我没有运行测试（环境只允许 git 读），因此“实际会失败”未核实；另外重复测试（问题 2）降低了新增用例的实际价值。

4. **改动产生或修改的每个值，每一个使用它的地方都能接受吗？**
   逐个核对结果：
   - `reviewSilentSharePermille`：产生于 `strict-configuration.ts:1041`（`optional(..., 500, 0, 1_000)`，`optional` 内部用 `integer`），消费于 `production-proactive.ts:317` → `readDailyReview` → `selectDailyReview`（`daily-review.ts:61-78,98-106`）。两端范围一致（0–1000 整数），有边界测试。
   - `decision_signals` 列：产生于 `recordDecisionSignal` 和三处调用，以及迁移回填；消费于 `listSignals`（`sqlite-decision-ledger-operations.ts:412-429`）和 `CALIBRATION_SQL.signals`（`calibration/src/index.ts:433-441`）。表级 CHECK、`idList` 长度限制、`delay_ms` 钳制、`source_ref` 长度都匹配；唯一未核实的是历史回填时间格式（推测 5）。
   - `ImplicitSummary`（`pushedDecisions`、`signals`、`otherDecisionEvents`）：产生于 `summarizeImplicit`（`calibration/src/index.ts:376-392`）；消费于 `buildReport`（新章节）、`historyRecord`（`implicit`，已含 `otherDecisionEvents`）、`production-observation`（网关快照）和网页。`rate` 有意不写入历史记录，类型上 `HistoryRecord` 也不要求；其余字段两端一致。
   - 网关 `implicit` 合同：`contracts-v2.ts:858-868` 要求该对象和 `rate` 可空；生产者 `production-observation.ts:248-258` 永远给 `rate: complete ? item.rate : null`；fixture、e2e 假服务器、浏览器测试 fixture 都已补上，能通过 `calibrationRateSchema`（`contracts-v2.ts:774-783`）。
   - `HISTORY_SCHEMA` 升到 v3：产生于 `historyRecord`（`calibration/src/index.ts:667`），消费于 `report.mjs:103-108` 的过滤和测试；旧的 v2 记录会被忽略，符合 ADR。
   - 日报新增 `proactive_silent` 组：产生于 `ledgerGroup`（`daily-review.ts:200-202`），消费于 `selectDailyReview` 的 `queueOf`（`daily-review.ts:98-106`）。`DEFAULT_GROUPS` 不包含它，因此不会被重复排队；控制中心用 `kind/outcome` 渲染标签（`proactive-reminders.tsx:306-324`），不依赖该 group 字符串。
   - `listSignals` 端口：产生于 `durable-adapters.ts:1015` 和 `sqlite-decision-ledger-operations.ts:231`；消费于端口调用方（目前只有测试）。参数校验是 `idList`（最多 200、去重），返回结构是 `DecisionSignalEntry`，两端一致；该接口没有暴露到网关，不存在前端校验不匹配的问题。
   - 另按 I-73 的教训检查“清单里的 id 能否通过后端校验”：`implicit.signals[].signal` 的枚举在合同（`["opened","undone","replied"]`）、校准类型、SQL CHECK、迁移 CHECK 四处一致；`rate` 的字段名/类型在 `proportion`、`calibrationRateSchema`、控制中心读取三处一致。没有发现像 I-73 那样一端放宽、另一端仍严格的错配。
