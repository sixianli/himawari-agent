# PR 293（P0-11）第 2 轮复核

复核范围：`2995d53..e6e47de`，重点看增量 `b422b30..e6e47de`。只读了代码/文档/git 元数据，**没有运行任何测试**（本环境只能读）。

## 侧重检查

- **错误路径/事务**：新增写信号都在调用方已有的 `database.transaction(...)` 内（`recordReactions`、`updateInsight`、`record`），失败会整体回滚；`record` 里新加的 `this.time(receivedAt)` 在事务中抛错也会回滚。真实 Gmail 源在 `packages/platform-node/src/gmail-source.ts:211` 用 `toISOString()` 生成 `receivedAt`，所以这个新校验不会误杀正常数据。
- **不可信输入**：`recordReactions` 的 `tag` 受 owner/agent 作用域与 64 字符上限约束；`listSignals` 的 `decisionIds` 最多 200 个且逐条参数化查询；`silentShare` 只在配置层校验（0–1000），`selectDailyReview` 本身不校验但不会死循环。`repliedThreads` 没有长度上限（见下）。
- **安全/越权**：`decision_signals` 的查询都带 owner/agent；`openForFeedback` 的 join 也带 owner/agent 与 `kind='proactive'`；`detail` 只放状态码，没有正文。未发现跨 owner 读写。
- **资源耗尽**：信号表只追加、随决策/Agent/账户级联删除；`repliedThreads` 每条线程做两次查询（`openForReply` + `markReplied` + 可能一条 insert），没有长度上限（内部调用方目前有批次上限，风险低）。
- **不可撤销操作**：触发器拒绝 UPDATE 和直接 DELETE，级联删除依赖“父行已删”时 `WHEN` 为假；直接删信号和级联删的正反两向都有测试（我未运行）。
- **规则/文档一致**：本改动不碰 `prompt-prefix` 相关路径；ADR 与代码大体一致，但有“确实推送过 = push_source_key 不为空”这一处概念等同（见发现 2）；另有周报文案“只记你没动手评价时发生的事”与实现不符（见发现 5）。

## 发现（按严重度）

### 1. 高：e2e/布局检查的周报假数据缺少必填的 `implicit`，会让 `npm run check:layout` 的周报场景失败

- 文件：`test/e2e/fixtures/control-center-browser-server.mjs:1067-1096`（`weeklySnapshot()` 的 `report` 对象），服务入口 `:1207-1214`
- 问题：网关契约把 `report.implicit` 设为**必填**，但 e2e 假服务器返回的周报 payload 完全没有这个字段；`unsetWeeklySnapshot()` 又继承同一对象，所以 4 个周报场景都会受影响。
- 证据：
  - 假数据 `report` 只到 `muse` 就结束：
    ```js
    report: {
      ...
      muse: { entries: 42, ... buckets: { ... } },
    },                    // 1067-1096，没有 implicit
    ```
  - 契约要求必填：`packages/gateway-contracts/src/contracts-v2.ts:858`
    ```ts
    implicit: object({ pushedDecisions: integer(0), ... }),
    ```
  - 校验器对缺失字段直接失败：`packages/gateway-contracts/src/validation.ts:168-172`
    ```ts
    for (const key of expectedKeys) {
      if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");
    ```
  - 控制中心查询会校验整条 snapshot：`apps/control-center/src/gateway-client.ts:268-271`
    ```ts
    function parsedResponseBody(value: unknown): GatewayV2Snapshot {
      const parsed = gatewayV2MessageSchema.parse(value);
    ```
  - 布局检查会等周报渲染：`scripts/check-layout-audit.mjs:264-268`（`waitForSelector(".weekly-days")`），而 `weeklyReport`/`weeklyReportDay` 场景正是用这个假服务器（`SCENES` 在 `:371-384`，假服务器启动在 `:586-596`）；`check:layout` 是 `npm run check` 的一步（`package.json:27`）。
- 补充：即使补上 `implicit`，也要让 `decisions/events` 非零，否则 `findWeeklyProblems` 的 `WEEKLY_ZERO_PERCENT`（`scripts/check-layout-audit.mjs:281`）会把“0.0%（0/N）”判为失败。控制中心单测的 fixture 已更新，唯独这个 `.mjs` 假服务器没有（TS 类型检查覆盖不到）。
- 建议：给 `weeklySnapshot()` 补 `implicit`（三条信号，且至少 opened 的 `decisions` 非零、`rate` 不为 0%），`unsetWeeklySnapshot()` 继承即可；另加一条直接 `gatewayV2MessageSchema.parse(weeklySnapshot())` 的断言，避免假数据再次落后于契约。这也是 [I-73] 那类“产出的值没核对消费端校验”的问题。

### 2. 中：`push_source_key` 非空只代表“已排进待发推送”，不是“已推送/已送达”

- 文件：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:828-831`、`:789`、`:947-953`；`packages/application/src/services/proactive-mail-check-service.ts:1168-1174,1205`；`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:434`；`packages/calibration/src/index.ts:365-367`
- 问题：作者第 2 轮说“撤销和回复只在提醒推送过时记”，但代码只检查 `source_insights.push_source_key IS NOT NULL`。这个键在 `record()` 创建待发推送时就写入了：
  ```ts
  // proactive-mail-check-service.ts:1168-1174,1205
  const pushing = input.insights.some(({ push }) => push);
  ...
  push = { id: pending?.id ?? ids.next("proactive-push"), readyAt };
  ...
  pushSourceKey: push ? `proactive:${push.id}` : null,
  ```
  ```ts
  // sqlite-proactive-operations.ts:828-831
  const setKey = this.database.prepare(
    "UPDATE source_insights SET push_source_key = ? WHERE id = ?",
  );
  for (const id of pushed) setKey.run(`proactive:${push.id}`, id);
  ```
  而 `web_push_feedback` 只有在 attempt 状态为 `sent` 时才创建：
  ```ts
  // sqlite-web-push-operations.ts:434
  if (recorded && input.status === "sent")
    this.database.prepare(`INSERT INTO web_push_feedback ...`)
  ```
  因此：没有订阅、发送失败/被抑制、进程在 record 与 enqueue 之间崩溃、安静时段待发推送尚未发出时，`push_source_key` 仍非空；用户仍可能在提醒列表里完成/静音再撤销或回复，于是会记下一条“没真正推送过”的信号。
- 同一问题也影响周报分母：`pushedDecisions` 按决策结论 `pushed/deferred` 计数，而不是按是否存在实际发送记录（`web_push_feedback`）计数：
  ```ts
  // calibration/src/index.ts:365-367
  const pushedDecisions = decisions.filter(
    (row) => row.kind === "proactive" && (row.outcome === "pushed" || row.outcome === "deferred"),
  ).length;
  ```
  没有活跃订阅时这些决策全进分母，点开/撤销/回复比例会被系统性拉低，与文案“分母是这一周推送过提醒的决策”不符。注意：ADR 已写“延后推送算分母”的口径；这里说的是**未被真正发出**的 `pushed` 决策，ADR 没有写，和第 1 轮的 deferred/共用推送口径不是同一件事。
- 建议：把“确实推送过”落成可核验条件——撤销/回复检查该提醒的 `push_source_key` 是否存在对应 `web_push_feedback`（或至少 attempt `sent`）；周报分母改为“有 feedback 的 push_source_key 对应的决策”（共用推送仍按决策去重）。若坚持按 verdict 口径，至少把 ADR 与周报文案从“推送过”改成“结论为已推送/延后推送”，不要等同于真正送达。

### 3. 中低：`ON CONFLICT ... DO NOTHING` 的去重路径没有被任何测试真正触发

- 文件：`packages/persistence-sqlite/src/decision-signals.ts:27-38`；测试 `test/integration/decision-signals.test.ts:225-245`、`:346-357`
- 问题：作者说去重改用 `ON CONFLICT (decision_id, signal, source_ref) DO NOTHING`，但现有“重复”用例其实是被更早的守卫拦住的，不是靠唯一冲突：
  - 第二次 opened：`opened_at IS NULL` 已不成立，`changes === 0` 直接跳过（`sqlite-web-push-operations.ts:480-492`）。
  - 重复回复：前一次已把 insight 标成 `replied`，`openForReply` 查不到行，根本没执行 insert。
  - 撤销：`sourceRef = insightId@now`，不同时间必然不同键。
  所以把 `ON CONFLICT` 删掉，现有测试仍会通过；这条防御性去重没有反向用例。
- 建议：加一条直接制造唯一冲突的用例（例如先插入一条信号，再在同 `(decision_id, signal, source_ref)` 上重放写入，或用仓储把同一撤销事件重复提交），断言不抛错且仍只有一行。它才真正守“按 (decision_id, signal, source_ref) 去重”。

### 4. 低：`otherDecisionEvents` 没进历史记录，也不参与 `sameMeasurement`

- 文件：`packages/calibration/src/index.ts:391`（产生）、`:689-695`（`historyRecord` 未写入）、`:710`（`sameMeasurement` 比较 `implicit`）
- 问题：`summary` 里有 `otherDecisionEvents`，网页/命令行会显示“另有 N 条信号…”，但 `historyRecord` 的 `implicit` 只存 `pushedDecisions` 和 `signals`。于是同一周后来新增了“落在未推送决策上的信号”时，`sameMeasurement` 仍可能判为相同而不追加历史；下周的“上一周”也看不到这条数。
- 建议：把 `otherDecisionEvents` 写入 `HistoryRecord.implicit` 并纳入 `sameMeasurement`（或在文档里明确它是实时值、不进历史）。

### 5. 低：周报文案说“只记你没动手评价时发生的事”，实现并没有排除已评分决策

- 文件：`packages/calibration/src/index.ts:598-600`；`packages/calibration/src/index.ts:365-367`；i18n `apps/control-center/src/i18n/resources/zh-CN.ts:1182`
- 问题：分子/分母都没有按 `ownerRating === null` 过滤。一个已被 Andy 打分、同时又被点开的决策，仍会进入观察信号的分子和分母，与“只记你没动手评价时发生的事”矛盾。
- 建议：要么把文案改成“不需要你动手评价也能观察到的行为”（不承诺排除已评分决策），要么在 `summarizeImplicit` 里同时过滤 `ownerRating`。二者选一，保持文档与代码一致。

### 6. 低：窗口未完整时，UI 把“比例被收起”显示成“样本不足”

- 文件：`apps/agent-service/src/production-observation.ts:256`；`apps/control-center/src/components/weekly-report.tsx:1081-1088`
- 问题：未完整周把 `rate` 置为 `null`（`rate: complete ? item.rate : null`），UI 的 `item.rate?.enough` 为假后走 `message("weekly.few", { n: pushedDecisions })`，文案是“样本不足（N 条）”。即使 N 很大，也只是因为窗口没结束，不是样本不足，容易误导。
- 建议：UI 区分 `report.complete/ratesWithheld`，未完整时显示“周未结束，暂不计算比例”而不是“样本不足”。

### 7. 低（推测）：信号排序用随机 UUID 做 tie-break，重放/重建时中位数可能变

- 文件：`packages/calibration/src/index.ts:433-441`（`ORDER BY signal.occurred_at, signal.id`）；`:380-382`（取每决策第一条算中位数）
- 问题：同一 `occurred_at` 的多条同类信号按随机 `id` 排序；“首次发生”取第一条，若这些行的 `delay_ms` 不同，中位数会受随机 id 影响。对同一份数据库是稳定的，但数据库重建/重放后可能不同。它不影响模型请求，只影响周报数字的可复现性。
- 建议：排序加一个稳定业务键（如 `source_ref`），或在 `summarizeImplicit` 对同一决策取 `min(delayMs)` 而不是“第一条”。

## 读代码证实的 / 推测的

**读代码证实**
- e2e 假服务器缺 `implicit`，契约必填、`object()` 拒绝缺失、客户端会 parse、`check:layout` 依赖该假服务器。
- `push_source_key` 在创建待发推送时写入，`web_push_feedback` 仅在 `sent` 时创建；撤销/回复只看 `push_source_key !== null`；周报分母只看 verdict。
- `ON CONFLICT` 路径没有被现有重复用例触发（重复由 `opened_at IS NULL`/`status='replied'` 挡住）。
- `historyRecord` 不含 `otherDecisionEvents`；`sameMeasurement` 比较的 `implicit` 也不含它。
- ADR 与代码在共享推送按决策计、v2 历史不参与、deferred 进分母、触发器放行级联等点上一致。

**推测/未核实**
- “未真正发出却进分母/记撤销回复”在生产中的影响大小，取决于有多少用户没有活跃订阅、发送失败率和待发窗口长度。
- 冻结的 `gateway.v2` 给快照加必填字段，在灰度/滚动部署时旧控制中心会因 `unknown field` 拒绝新快照、新控制中心会因缺字段拒绝旧快照；仓库看起来是两端同发，但部署策略未核实。
- `decision-record-observation-runbook.md` 新的 `contract_sha256` 是否与契约源文件重算一致，未运行封存校验，未核实。
- 迁移触发器在真实 SQLite FK 级联下的行为由新增测试断言，但我没有运行；按“父行先删、级联时父行已不存在”的语义，条件会放行。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只在持久化层（`decision_signals` 写入、`updateInsight`/`record`/`recordReactions` 的副作用）、校准统计、同周报 JSON 与网页、以及每日打分抽样；没有任何一行进入系统提示、工具定义、历史消息或遮盖。`grep` 显示 `decision_signals`/`summarizeImplicit` 只被 `sqlite-*`、`calibration`、`production-observation`、控制中心读取，不在 `packages/runtime-pi`/prompt 组装路径。发往模型的内容仍是只在末尾追加；会变的值（时间、本轮资料等）仍在最后一条用户消息，本改动没有触碰该规则。唯一间接影响是：新加的 `receivedAt` 校验可能让一次主动检查失败重试，但这改变的是“是否发请求”，不是请求前缀。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会（模型侧）。新增的随机值只有 `decision_signals.id`（`signal:${randomUUID()}`）和迁移里的 `randomblob(16)`，它们不出现在任何提示词/上下文里；信号时间、`detail` 也不进模型。周报文本是确定性的（`IMPLICIT_SIGNALS` 固定顺序，SQL 固定排序），每日打分抽样用 `hash(seed|dayStart|key)`，也确定。唯一非确定性是发现 7 的 UUID tie-break，只影响周报数字/排序，不影响模型请求字节。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有：`test/integration/decision-signals.test.ts`（worker/direct）、`packages/application/test/daily-review.unit.test.ts`、`apps/control-center/test/weekly-report.unit.test.ts`、`startup-configuration.unit.test.ts`、迁移序号测试。反向用例中，触发器的“直接删被拒 / 级联删放行”两向、未推送提醒不记撤销/回复、dismissed/未知 tag/无推送决策不记 opened、回填只回填已点开、0 与 1000 两端和队列取尽，都是真会随实现回退而失败的。但有三处不足：
- `ON CONFLICT` 去重没有任何用例真正制造唯一冲突（发现 3），删掉这行测试也不会红。
- `otherDecisionEvents` 的计算和 `buildReport` 的“无推送决策仍显示条数”分支没有用真实 `summarizeImplicit` 覆盖，只有前端手工构造 snapshot 的单测（`weekly-report.unit.test.ts:748-768`）。
- 没有“verdict=pushed 但没有 `web_push_feedback`”的用例，因此发现 2 的口径缺口不会被测试发现。
另外，发现 1 会让 `npm run check:layout`（属于 `npm run check`）的周报场景在真浏览器环境下失败；作者环境缺 Playwright，所以没暴露。

**4. 每个新值的使用方都能接受吗？**
逐个核对：
- **`signal`（opened/undone/replied）**：写入端常量 → 表 `CHECK` → `CALIBRATION_SQL.signals` → `IMPLICIT_SIGNALS` → 网关 `enumeration` → UI i18n select��三处清单一致。
- **`occurred_at` / `recorded_at` / `delay_ms` / `detail` / `source_ref` / `id`**：写入端都做 ISO/数值/长度校验，表有 `GLOB`/`CHECK`/`json_valid`/长度/唯一约束；`id` 两种产生方式（`signal:uuid` 43 字符、`signal:backfill:`+32 hex 48 字符）都在 1–128 内；`source_ref` 最长 256（source_key）或 153（insightId@time）也都满足；`listSignals` 解析 `detail`，没有其他消费方，两端一致。
- **`reviewSilentSharePermille`**：`strict-configuration.ts:1041` 产生并校验 0–1000（默认 500），唯一消费方 `production-proactive.ts:317` → `readDailyReview` → `selectDailyReview`；`mixBySilentShare` 对 0/1000/一边取尽都安全。启动测试覆盖默认值与越界。两端一致。
- **`pushedDecisions` / `signals` / `medianDelayMs` / `rate` / `otherDecisionEvents`**：`summarizeImplicit` 产生，`buildReport`、`production-observation`、网关 `nullable(calibrationRateSchema)`、前端 `report.implicit` 都接受（nullable 已支持未完整周）；**但 `otherDecisionEvents` 没有进入 `HistoryRecord`/`sameMeasurement`**（发现 4），属于使用端少了一处。
- **`HISTORY_SCHEMA` v3**：`report.mjs` 用 `entry.schema === HISTORY_SCHEMA` 过滤，v2 不再当“上一周”；`calibration-report.test.ts` 已改 v3。两端一致（ADR 0155 仍写 v2 是历史文档，不算本次不一致）。
- **迁移序号 80 / `SUPPORTED_SCHEMA_MAX` 80**：`migration-engine` 加到 80，`check-audit-schema-range.mjs` 与 `LATEST_MIGRATION_SEQUENCE` 比对，`workspace-lifecycle-audit.mjs` 已改 80，相关迁移测试都改到 80；两端一致。
- **`report.implicit`**：生产端 `production-observation` 有并通过 `gatewayV2MessageSchema.parse` 自校验；网关 fixture 与控制中心单测 fixture 已更新；**唯独 e2e 假服务器没更新**（发现 1），这正是“产生方有值、消费端校验不接受”的 I-73 式遗漏。

结论：核心信号写入与去重、配置键、迁移序号、历史 schema 的两端基本对齐；需要先修的是发现 1（自动检查会红）和发现 2（把“已排入推送”当成“已推送”的口径/功能缺口），再补发现 3 的去重反向用例。
