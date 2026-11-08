## 侧重检查

我按额外侧重先看了这些路径：

- **错误路径/不可信输入**：`recordDecisionSignal` 用 `INSERT OR IGNORE`；`record` 对 `repliedThreads.receivedAt` / `threadId` 没有像其它输入那样校验；DB 对 `occurred_at` 有严格格式 CHECK。
- **安全/敏感信息**：新表只存决策关联、信号种类、时间、毫秒差、小 JSON（`{}`、`{"from":"done"}`、`{"backfilled":true}`）和来源标识，没有邮件正文、摘要、地址。未发现新增敏感内容落库或进入模型请求。
- **资源耗尽**：`decision_signals` 追加式且无独立保留策略，随决策长期增长；回填按 `web_push_feedback × 匹配决策` 插入；`listSignals` 最多 200 个决策；打开信号循环上限取决于共享同一推送的决策数。
- **不可撤销操作**：`UPDATE`/`DELETE` 触发器存在；`clearRecords` 的级联有集成测试；**没有**测试在存在 `decision_signals` 时删除 Agent 或整个账户。
- **规则/文档与代码一致性**：ADR 说“点开挂到发出这条推送的决策”，代码会对共享同一推送的每个决策各写一条；ADR 说迁移回填，但没有回填测试；“周末不完整不给比例”只在网页路径成立，命令行报告不 withhold；历史格式从 v2 升到 v3 后，旧的 v2 记录不再参与“与上一周对比”，ADR 未写这一点。

---

## 已读代码证实的问题

### 1. 中：一次点开会给共享同一推送的每个决策各写一条 `opened`，去重键绕过去了

- **文件:行**：`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:475-514`，`packages/persistence-sqlite/src/migrations/0080_decision_signals.sql:12`
- **问题**：`openedFeedback` 按 `decision.push_source_key = feedback.source_key` 关联**所有**决策，然后逐行写 `opened`。去重键是 `(decision_id, signal, source_ref)`，不同决策天然不同，因此一条物理“点开”可以产生多条记录。
- **证据**：
  ```sql
  JOIN decision_ledger decision
    ON decision.owner_id = feedback.owner_id AND decision.agent_id = feedback.agent_id
   AND decision.push_source_key = feedback.source_key AND decision.kind = 'proactive'
  ```
  ```ts
  for (const row of opened)
    recordDecisionSignal(this.database, { ... decisionId: row.decisionId, signal: "opened",
      sourceRef: row.sourceKey ... });
  ```
  而多个决策确实会共享同一个 `push_source_key`：安静时段复用 pending push：
  ```ts
  const pending = quiet ? await store.pendingPush({ ...scope, readyAt }) : undefined;
  push = { id: pending?.id ?? ids.next("proactive-push"), readyAt };
  ```
  （`packages/application/src/services/proactive-mail-check-service.ts:1173`）
  每个决策都写入同一个键：
  ```ts
  for (const id of pushed) setKey.run(`proactive:${input.push.id}`, id);
  ```
  （`sqlite-proactive-operations.ts:824`），出队时 source key 也是 `proactive:${push.id}`（`production-web-push.ts:362`）。
- **影响**：周报的 `events` 会把一次点开计成多次，`decisions` 也会把同一批推送覆盖的多个决策都算成“点开过”。与作者“点开信号各落成一条记录/挂到发出这条推送的决策”的说法不一致。
- **建议**：明确口径。若按推送计，应以 push id 去重并把信号挂到一个主决策，或新增 push 维度唯一键；若确实按决策计，应在 ADR 写明“一次批量推送会为每个决策各记一次”，并在周报事件数里说明。

### 2. 中：周报“观察信号”的分子包含未推送提醒上的撤销/回复，和“推送过提醒的决策”口径混在一起

- **文件:行**：`packages/calibration/src/index.ts:365-391`、`packages/calibration/src/index.ts:433-441`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:939-955`、`:753-761`
- **问题**：分母 `pushedDecisions` 是“决策 verdict 为 pushed/deferred”；分子只按 `decision.verdict` 打 `pushed` 标记。但撤销和回复信号是挂在 `source_insights` 上的，而 `source_insights` 对每个 act/know/check 都存在，**只有真正推送的 insight 才在 `sqlite-proactive-operations.ts:821-824` 写入 `push_source_key`**。因此某个决策只要推了任意一条，同一决策下“没推送的提醒”被撤销/回复也会进入该信号的比例。
- **证据**：
  ```ts
  const pushedDecisions = decisions.filter(
    (row) => row.kind === "proactive" && (row.outcome === "pushed" || row.outcome === "deferred"),
  ).length;
  ```
  ```ts
  const ofKind = signals.filter((row) => row.pushed && row.signal === signal);
  ```
  ```sql
  CASE WHEN decision.kind = 'proactive' AND decision.verdict IN ('pushed', 'deferred')
    THEN 1 ELSE 0 END AS pushed
  ```
  撤销/回复只检查状态，不看该 insight 是否推送过：
  ```ts
  input.status === "open" && (before.status === "done" || before.status === "muted")
  ```
  ```sql
  WHERE owner_id = ? AND agent_id = ? AND source = ? AND thread_id = ? AND status = 'open'
  ```
- **影响**：观察信号比例可能把“没有推送过的提醒”的撤销/回复算成推送提醒的命中，夸大或扭曲周报；这正是“两类数混算”的风险。
- **建议**：在信号行里保留“是否对应已推送提醒”的维度（例如记录时校验 `source_insights.push_source_key IS NOT NULL`，或在查询里 join `source_insights`），分子按“已推送提醒”过滤；否则在 ADR 和页面文案里明确改称“决策级”而非“提醒级”。

### 3. 中低：`INSERT OR IGNORE` 会静默吞掉 CHECK/NOT NULL 错误，不合规输入直接丢信号

- **文件:行**：`packages/persistence-sqlite/src/decision-signals.ts:27-45`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:598-614`、`:762-793`
- **问题**：`INSERT OR IGNORE` 不只忽略唯一冲突，也会忽略 `CHECK`、`NOT NULL` 失败。`record()` 只校验了 `decision.checkedAt`、`insight.dueAt`，没有校验 `repliedThreads` 的 `receivedAt`/`threadId`；如果上游给了格式不对的回复时间，`occurred_at` 的 GLOB CHECK 失败后整条信号会被静默丢掉，而不是报错或至少返回失败。
- **证据**：
  ```ts
  `INSERT OR IGNORE INTO decision_signals (...)`
  ```
  ```sql
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.???Z'),
  ```
  `record()` 的循环只校验 insight：
  ```ts
  for (const insight of input.insights) {
    this.time(insight.dueAt);
    ...
  }
  ```
  `repliedThreads` 原样进入 SQL 和时间计算：
  ```ts
  for (const { threadId, receivedAt } of input.repliedThreads) {
    ...
    occurredAt: receivedAt,
    delayMs: Date.parse(receivedAt) - Date.parse(row.updatedAt),
  ```
- **影响**：错误数据被当作“没发生信号”，观察数据静默缺失；排查困难，也掩盖调用方 bug。
- **建议**：改成 `ON CONFLICT (decision_id, signal, source_ref) DO NOTHING`，让其它约束错误暴露；同时在 `record()` 里校验 `repliedThreads` 的 `threadId` 长度和 `receivedAt` 是合法 UTC 毫秒时间。

### 4. 低：周报在没有推送决策时会完全隐藏“另有 N 条信号”，网页和命令行都一样

- **文件:行**：`packages/calibration/src/index.ts:603-620`、`apps/control-center/src/components/weekly-report.tsx:1064-1065`
- **问题**：`pushedDecisions === 0` 时直接输出“这一周没有推送过提醒的决策”，`otherDecisionEvents` 的内容永远不显示；如果这一周只有落在未推送决策上的信号，这些信号会被完全藏掉。
- **证据**：
  ```ts
  if (implicit.pushedDecisions === 0) lines.push("这一周没有推送过提醒的决策。", "");
  else {
    ...
    if (implicit.otherDecisionEvents > 0) ...
  }
  ```
  ```tsx
  {report.implicit.pushedDecisions === 0 ? (
    <p className="weekly-empty">{message("weekly.implicit.empty")}</p>
  ) : ( ... otherDecisionEvents ... )}
  ```
- **建议**：`pushedDecisions === 0` 时也显示 `otherDecisionEvents`，否则“只观察不使用”的原始数据在周报里丢失。

### 5. 低：历史格式升级到 v3 后，v2 记录被 CLI 直接忽略，旧周对比断档，ADR 未说明

- **文件:行**：`packages/calibration/src/index.ts:1`、`scripts/calibration-report/report.mjs:103-108`
- **问题**：`HISTORY_SCHEMA` 改为 v3 后，`report.mjs` 过滤 `entry.schema === HISTORY_SCHEMA`，之前写下的 v2 历史不再作为 `previous`，同窗口的 v2 记录也不会阻止重复追加。作者只说“历史记录格式升到 v3（新增 implicit 字段）”，没有说会丢弃旧对比。
- **证据**：
  ```ts
  const history = readHistory(historyFile, output).filter(
    (entry) =>
      entry.schema === HISTORY_SCHEMA && ...
  );
  ```
- **建议**：要么在升级时读取 v2 并只使用 `groups`/`muse`（忽略缺失的 `implicit`），要么在 ADR/发布说明里明确“v2 历史不再参与对比”。

### 6. 低：迁移回填没有任何自动检查，且回填 id 有超长边界

- **文件:行**：`packages/persistence-sqlite/src/migrations/0080_decision_signals.sql:2,27-35`、`test/integration/decision-signals.test.ts:51-60,128-143`
- **问题**：集成测试先应用全部迁移，再插入 `web_push_feedback`，因此**完全没有覆盖 0080 的回填 SQL**。回填 id 是 `'signal:opened:' || decision.id`，表要求 `length(id) <= 128`；生产 id 通常远短于 114 字符，但如果历史/外部数据中有 115–128 字符的 decision id，迁移会因 CHECK 失败而阻断启动。
- **证据**：
  ```sql
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  ...
  SELECT 'signal:opened:' || decision.id, ...
  ```
  测试中迁移在插入 feedback 之前：
  ```ts
  applyMigrations(database, await loadBundledMigrations());
  ...
  const addFeedback = (sourceKey: string, tag: string) => { ... INSERT INTO web_push_feedback ... }
  ```
- **建议**：加一个“先迁移到 79、插入已点开的 feedback、再升级到 80、断言信号与 delay”的迁移测试；回填 id 使用固定长度形式（如 `signal:opened:${randomUUID()}` 或 `substr(decision.id,...)`），并显式处理超长 id。

### 7. 低：`pushedDecisions` 把 `deferred` 也算作“推送过提醒”，但延迟推送可能最终没有发出

- **文件:行**：`packages/calibration/src/index.ts:365-367`、`packages/application/src/services/proactive-mail-check-service.ts:854-859`
- **问题**：安静时段只创建 pending push，verdict 记为 `deferred`；如果用户随后关闭提醒或推送过期，提醒可能从未真正发出，但周报分母仍加一。作者/ADR 认为“延后推送”算推送，这与页面文案“推送过提醒的决策”不完全一致。
- **证据**：
  ```ts
  verdict: counts.pushed > 0
    ? quietUntil(...) ? "deferred" : "pushed"
    : (stop ?? "silent")
  ```
  ```ts
  const pushedDecisions = decisions.filter(
    (row) => row.kind === "proactive" && (row.outcome === "pushed" || row.outcome === "deferred"),
  ).length;
  ```
- **建议**：确认产品口径；若按“实际发出”计，应基于 `web_push_feedback`/`push_source_key` 存在而不是 verdict，或在文案中明确“含已排期但未发出的提醒”。

---

## 推测 / 未核实

- **中（未核实）：删除 Agent 或整个账户时，`decision_signals_no_delete` 触发器可能与级联顺序冲突。**
  - `0080_decision_signals.sql:20-22` 的触发器在 `decision_ledger` 父行仍存在时拒绝删除子行。`clearRecords` 直接删 `decision_ledger` 的路径有测试，但 `DELETE FROM owners/agents` 时 `decision_signals` 同时有“直接按 owner/agent 级联”和“经由 decision_ledger 二级级联”两条路径；如果 SQLite 先处理前者，父决策还在，触发器会 ABORT。
  - 同类 `observation_events` 触发器（`0074_ledger_observation.sql:78-81`）在删除 Agent/账户的测试里能正常工作，说明 SQLite 的级联顺序通常有利于这种写法，但那条测试没有覆盖“两级父表”场景。建议补一个“插入 signal 后删 Agent 和删 Owner”的集成测试。

- **低（未核实）：共享推送下，回填和实时 `opened` 都会 fan-out。** 上面第 1 条已确认机制；回填同样按 `decision.push_source_key` join，因此历史回填也会把一次打开分散到多个决策。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（本改动范围内）。** 新增的 `listSignals`、`readCalibrationRows.signals`、`summarizeImplicit` 只被周报（`production-observation.ts`、`report.mjs`）和测试读取；每日打分页的 `readDailyReview` 只被 `production-proactive.ts:306-318` 的 `review()` 和 `proactive.review.read` 查询使用，不进入模型请求组装。diff 没有改 `packages/prompt-catalog`、`runtime-pi`、上下文组装、遮盖或历史存储。因此仍然满足“只在末尾追加、每轮会变的值在最后一条消息里”的既有规则（`.claude/rules/prompt-prefix.md:27-35`）。我没有在此基础上重新验证全局 prompt-prefix 门槛，只核对了本次改动没有新增触碰点。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**对模型请求不会。** 新增的随机值只有 `decision_signals.id`（`signal:${randomUUID()}`），它只在本地数据库和报告排序的 tie-breaker 中使用，不进入模型请求，也不显示在周报里。报告输出按 `occurred_at, id` / `checked_at, id` 排序；随机 id 只会在同一毫秒完全并列时影响顺序，属于报告层面的极小不确定性，不影响模型字节。每日抽样对固定 `dayStart/seed/config` 是确定性的；配置值改变会改变抽样结果，但不会改变模型请求开头。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有，但不完整。**

已有：
- `test/integration/decision-signals.test.ts`：点开、撤销、回复正向；划掉推送、未知标签、没发推送、完成未撤销、未处理再设未处理、已完成提醒上的回复、重复回复等反向；触发器拒绝改删；`clearRecords` 级联。
- `packages/application/test/daily-review.unit.test.ts`：沉默占比 500/250/1000/0、让步、未抽到计数。
- `packages/platform-node/test/startup-configuration.unit.test.ts`：缺省 500，1001/-1 被拒。
- `apps/control-center/test/weekly-report.unit.test.ts`：观察信号单独卡片、正向和两个反向；断言评分表不包含观察信号。
- 迁移序列、模型预算、checkpoint 测试更新到 80。

不足以证明的点：
- **0080 回填没有测试**，回填 SQL 的错误不会被发现。
- **删除 Agent/账户且有 signal 的级联没有测试**。
- 反向用例里“没有信号”的断言如果功能完全失效也会通过；真正的保护来自正向用例，这些用例存在。
- “周末不完整时比例为 null”只在网页路径有代码；命令行 `buildReport` 没有 complete 判断，也没有对应测试。

### 4. 每个新值的两端是否都能接受？

逐个核对：

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| `reviewSilentSharePermille` | `strict-configuration.ts:1041`，`0..1000`，缺省 500 | `ProactiveConfiguration`、`production-proactive.ts:317`、`readDailyReview`/`selectDailyReview` | 一致；`silentShare=0` 用 `=== undefined` 判断，不会被误当缺省 |
| `opened/undone/replied` | `decision-signals.ts`、`0080` CHECK、`calibration.IMPLICIT_SIGNALS`、gateway enumeration | DB CHECK、报告、gateway `enumeration` | 一致 |
| `source_ref` | opened=`source_key`；undone=`insightId@now`；replied=`insightId@receivedAt`；回填=`source_key` | DB `length 1..256`；unique `(decision_id, signal, source_ref)` | 正常生产长度可接受；但共享推送时不同 `decision_id` 绕过去重（见问题 1） |
| `decision_signals.id` | `signal:${randomUUID()}`；回填 `'signal:opened:' \|\| decision.id` | DB `length 1..128`；报告 tie-breaker | 实时 43 字符可接受；回填在 decision id >114 时会失败（见问题 6） |
| `occurred_at/recorded_at` | 调用方时间；回填=`opened_at` | DB GLOB `????-??-??T??:??:??.???Z` | 生产 `validTime` 路径可接受；回复的 `receivedAt` 未在 port 校验，存在静默丢弃风险 |
| `delay_ms` | 实时 `Date.parse` 差值；回填 julianday 差值 | DB `0..9007199254740991` INTEGER | 实时经 `recordDecisionSignal` clamp；回填 `max(0,...)`；可接受 |
| `detail` | `{}`、`{from}`、`{backfilled:true}` | DB `json_valid` + `json_type='object'`；`listSignals` JSON.parse | 一致 |
| `CalibrationRows.signals` | `readCalibrationRows` | `ProductionObservation`、`report.mjs`、测试 | 已更新，worker/direct 测试都跑 |
| `report.implicit` / gateway `implicit` | `production-observation.ts:248-258` | gateway `proactiveWeeklySnapshotSchema`、control-center `WeeklyReport` | 一致；`rate` 可为 null，schema 是 `nullable(calibrationRateSchema)` |
| `HISTORY_SCHEMA v3` | `calibration/index.ts:1` | `report.mjs` 只接受 v3；测试已改 | 内部一致，但旧 v2 历史被忽略（见问题 5） |

**作者说法核对：**
- “点开在 `recordReactions` 事务里、撤销在 `updateInsight` 事务里、回复在 `markReplied` 前后”：代码属实。
- “迁移含历史回填”：SQL 属实，但**无测试**，且有共享推送 fan-out 与 id 长度边界。
- “周报周末不完整不给比例（null）”：**只对网页路径成立**（`production-observation.ts:256`）；命令行 `buildReport` 不判断 complete。
- “同一信号按 `(decision_id, signal, source_ref)` 去重”：表结构属实，但共享推送下一次事件会因 `decision_id` 不同而变成多条，去重并不覆盖“一次事件”。
