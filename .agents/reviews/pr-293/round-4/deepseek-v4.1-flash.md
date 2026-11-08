## 结论

按照要求的四个方面核对了提交 `0cd645b`（以及相对 `cbf7538` 的增量）。三处第 4 轮改动本身没有发现高危缺陷：`delivered` 的 SQL、未完整周文案、部分索引都能和 ADR/测试对上。读代码发现 1 个中的口径问题、3 个低风险问题，以及若干测试覆盖盲点。真实测试没有运行（本会话只能读文件和用只读 git 命令），所以“反向用例会失败”是从断言推断的。

---

## 发现（按严重度从高到低）

### 1. 中：撤销/回复写入时看的是提醒的 `push_source_key`，周报读取时看的是决策的 `push_source_key`，两者可能不是同一个推送

**文件:行**
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:753-762`（回复查询取 `source_insights.push_source_key`）
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:789-800`（按提醒的 key 决定写信号）
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:922-928,947-964`（撤销同样按提醒的 key 决定写）
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:697-715`（更新已存在的提醒时只改 `decision_id`，不清 `push_source_key`）
- `packages/calibration/src/index.ts:446-451`（周报按决策的 `push_source_key` 查 `web_push_feedback`）

**问题（读代码证实）**
一条提醒 I 原本挂在决策 D1、`push_source_key=K1`，K1 的推送已经发出。后来的静默检查 D2 更新 I 时把 `decision_id` 改成 D2，但保留 `push_source_key=K1`。之后用户回复/撤销，信号按写入条件（`I.push_source_key !== null`）落在 D2 上；周报读取却用 `D2.push_source_key` 去查发送记录。若 D2 是 `silent`（`push_source_key=NULL`），或 D2 的新推送尚未发出，这条信号会被归入“没有推送的决策”，实际上 K1 的提醒确实送达过。

这和作者第 4 轮“读取时按推送确实发出归类”的口径不一致；ADR 第 67 行只承认信号会挂到后来更新它的决策，没有说明这种信号会从比例里掉到“未推送”一栏。`opened` 不受影响，因为它的 `source_ref` 就是推送 key，读取端用的也是同一个 key。

**建议**
在 `decision_signals` 上保存写入时实际依据的推送 key（新列或写入 `detail`），周报按这个 key 查 `web_push_feedback`；或者不要在更新提醒时让 `decision_id` 与 `push_source_key` 脱节。补一个“旧推送已发、后续静默检查更新提醒、再回复”的反向用例，当前测试没有覆盖。

### 2. 低：新表的 4 位年份 CHECK 比现有时间校验更严，极端时间会让整个反应事务回滚

**文件:行**
- `packages/persistence-sqlite/src/migrations/0080_decision_signals.sql:7,11`（`occurred_at`/`recorded_at` 只接受 `????-??-??T??:??:??.???Z`）
- `packages/gateway-contracts/src/validation.ts:104-113`（`timestamp` 只要求 canonical ISO，接受 `+010000-...`）
- `packages/persistence-sqlite/src/sqlite-web-push-operations.ts:39-42`（`time()` 同样只要求 canonical ISO）
- `packages/persistence-sqlite/src/sqlite-web-push-operations.ts:467-468,504-514`（先写 `opened_at`，再写信号，在同一个事务里）
- `packages/persistence-sqlite/src/decision-signals.ts:26-31`（只把 `delayMs` 夹到非负，不校验时间格式）

**问题（读代码证实，触发概率低）**
客户端上报的 `pushFeedbackEvent.occurredAt`（`packages/gateway-contracts/src/contracts-v2.ts:298-302`）如果写成 `+010000-01-01T00:00:00.000Z` 这类 canonical 但 5 位年份的值，会通过契约和 `time()`，`opened_at` 也会写成这个值；随后 `recordDecisionSignal` 的 `occurred_at` 不满足 4 位年份 GLOB，INSERT 抛错，`recordReactions` 的事务整体回滚，连用户点开这件事本身也不记录。回复的 `receivedAt` 如果来源能给出同类时间，也会让整个主动检查事务失败。实际生产里正常客户端和 Gmail 时间不会这样，属于自伤型输入。

**建议**
在 `recordDecisionSignal` 或 `time()` 统一限制到 4 位年份，或把 CHECK 改成用 `strftime`/长度校验；并补一个“canonical 但 5 位年份的 occurredAt 被拒绝且不吞掉反馈”的用例。

### 3. 低：作者说“周报在周未完整时不给比例（null）”，命令行报告并没有这个行为

**文件:行**
- `packages/calibration/src/index.ts:619-645`（`buildReport` 无条件用 `formatProportion(row.rate)`）
- `apps/agent-service/src/production-observation.ts:231`（`ratesWithheld: !complete`）
- `apps/agent-service/src/production-observation.ts:256`（只有网页快照把 `implicit.rate` 置 null）
- `scripts/calibration-report/report.mjs:113-121`（CLI 调用 `buildReport` 时没有完整度参数）

**问题（读代码证实）**
网页路径会因 `complete=false` 把比例置 null；`buildReport` 没有完整度概念，只要样本数够就打印百分比。CLI 默认窗口是截止到今天 0 点的上一周（通常完整），但用户可以用 `--end` 指向尚未结束的窗口，此时会打印比例。ADR/作者说法如果指“所有周报”，就和代码不一致。

**建议**
在 CLI 也传完整度并输出“本周尚未结束”，或在 ADR/说明里明确“只有网页周报在未完整时隐藏比例”。

### 4. 低：未开始观察时，“观察信号”卡片仍会显示数字/比例，和类型表的“尚未开始”不一致

**文件:行**
- `apps/control-center/src/components/weekly-report.tsx:912-913`（类型表用 `showTable` 门控）
- `apps/control-center/src/components/weekly-report.tsx:1062-1111`（观察信号卡片没有 `showTable` 门控）
- `test/e2e/fixtures/control-center-browser-server.mjs:1122-1139`（`unsetWeeklySnapshot` 直接展开 `weeklySnapshot()`，把已完成的 `implicit` 数据也带进未开始状态）

**问题（读代码证实）**
页面处于 unset/waiting 时，类型表显示“尚未开始”，但观察信号卡片仍按默认最近 7 天窗口渲染数据；e2e 假服务器的未开始快照还沿用了完整周的数据。这个卡片是本 PR 新增的，虽然没有安全影响，但和页面的“未开始”语义冲突。`muse` 卡片也有类似行为，属于既有模式，需要产品确认是否有意。

**建议**
像类型表一样用 `showTable` 门控，或在未开始状态显示“还没有开始观察”；e2e 的 unset 快照不要复用 reported 的 `implicit`。

### 5. 低：新测试存在覆盖盲点，不能完全证明第 4 轮的真实路径

**文件:行**
- `test/integration/decision-signals.test.ts:440-485`：delivered 用例用手工 `INSERT web_push_feedback` 模拟发送，没有走 `recordAttempt` 的真实 `sent` 路径。
- `test/integration/decision-signals.test.ts:487-504`：索引用例只对简化 SELECT 做 `EXPLAIN QUERY PLAN`，没有断言实际 `openedFeedback` join 的计划。
- `apps/control-center/test/weekly-report.unit.test.ts:649-674`：notFull 用例把 `signalRow(..., 0)` 的 rate 直接造成 null，没有验证 `production-observation` 在 `complete=false` 时确实把 rate 置 null。
- `test/integration/ledger-observation-service.test.ts:201-221`：只断言 `complete/ratesWithheld`，没有断言 `implicit.rate` 为 null。

**问题（读代码证实）**
这些测试在删掉对应改动后大概率会失败，方向是对的；但 delivered 的 key 对齐、未完整周 rate 的置空、实际打开查询是否用索引，这三处仍然依赖代码阅读，缺少端到端断言。

**建议**
补一条真实 `recordAttempt(status:"sent")` → feedback → 周报的用例；补 `production-observation` 未完整周 `implicit.rate === null` 的断言；索引用例改成对真实打开查询做计划断言。

---

## 侧重检查

- **错误路径/事务**：`recordReactions`、`updateInsight`、`processCheck` 三个写入都在事务里；`recordDecisionSignal` 抛错会回滚原动作。读代码确认了这一点，并发现第 2 条的时间格式不一致会让极端输入回滚点开反馈。
- **不可信输入**：`reviewSilentSharePermille` 在 `strict-configuration.ts:1041` 限制为整数 0–1000；`listSignals` 的 `decisionIds` 经 `idList` 限制最多 200 个；`detail` 由内部常量对象生成；反应 `occurredAt` 走网关 `timestamp`，但见第 2 条。
- **安全/隐私**：`decision_signals` 只存枚举、时间、间隔和 `{from}`/`{backfilled}` 小对象，归为 `metadata_only`；两个读取路径都按 owner/agent 过滤；没有新增敏感信息检测规则，也没有把信号放进模型上下文。
- **资源耗尽**：`listSignals` 每个 decision 一次查询，上限 200；一次推送覆盖多个决策时一次点开会写多条 `opened`，受推送内容限制；迁移 0080 会在已有 `decision_ledger` 上建索引，大库升级会有一次建索引开销，但没有数据重写。
- **不可撤销操作**：`decision_signals` 有拒绝 UPDATE/DELETE 的触发器；删除 Agent/账户/清除主动记录时靠 `EXISTS` 判断放行级联，读代码和现有反向测试一致。回填只写入历史 `opened_at`，且回填行之后不可改；回填的 join 条件只匹配 `kind='proactive'` 且 `source_key` 相同，读代码没有发现会回填到静默决策的路径。
- **规则/文档一致性**：ADR 0182、runbook、schema-catalog 与代码大体一致；`runbook.contract_sha256` 已随 `production-observation.ts`/`report.mjs` 改动更新，但**没有实际运行文档校验，hash 是否正确未核实**。ADR 说的“按决策查询”目前只到 `DecisionLedgerPort.listSignals`，没有暴露到网关/网页，是否需要产品级入口未核实。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动只新增/修改数据库表、索引、周报查询和 UI、配置解析；`decision_signals`、`implicit`、`reviewSilentSharePermille` 没有被上下文或提示词组装读取（grep 到的引用只在 calibration、persistence、control-center）。系统提示、工具定义、历史消息、遮盖结果都没有变。依据 `.claude/rules/prompt-prefix.md:27-29,35`，发给模型的内容仍只在末尾追加，本轮没有新增任何每轮变化的值。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会（对模型请求）。新增的 `randomUUID` id、`occurred_at`、`medianDelayMs` 只写入 `decision_signals`、周报快照/历史文件，不进入模型请求；出口遮盖算法未改。假设以后把这些值放进提示，UUID 和同一时间戳下的排序会带来非确定性；当前没有这样的读取路径。周报内部的信号顺序按 `IMPLICIT_SIGNALS` 固定，SQL 按 `occurred_at,id` 排序，单次报告是确定的。

3. **有没有对应的自动检查？反向用例会真的失败吗？**
   有：`test/integration/decision-signals.test.ts`（opened/undone/replied、未知 tag、未推送、删除、ON CONFLICT 重放、回填、delivered、索引）、`packages/application/test/daily-review.unit.test.ts`（0/250/500/1000、让位、未抽到）、`packages/platform-node/test/startup-configuration.unit.test.ts`（默认值、越界）、`apps/control-center/test/weekly-report.unit.test.ts`（notFull、无推送时的 other 计数）、网关 fixture 的 `implicit`。从断言看，去掉 delivered、notFull、索引或 silent share 后这些用例会失败；但本会话未实际运行，且存在第 5 条的覆盖盲点。

4. **每个新值/字段/配置键/序列化格式，所有使用它的地方都能接受吗？**
   逐项核对如下（读代码证实）：
   - `reviewSilentSharePermille`：生产者 `strict-configuration.ts:1041` 校验 0–1000 整数；消费者 `configured → ProactiveConfiguration → production-proactive.ts:317 → readDailyReview → selectDailyReview`，两端都接受；测试覆盖默认/越界。
   - `delivered`（`CalibrationDecisionRow`）：生产者 `CALIBRATION_SQL.decisions` / `readCalibrationRows`；消费者 `summarizeImplicit`，其他 calibration 函数忽略它；类型已同步。
   - `implicit`（周报快照）：生产者 `production-observation.ts:248-258`；消费者网关 `contracts-v2.ts:858-870`（`rate` 可空）、control-center 类型（从网关快照派生）和 `buildReport`；e2e/网关 fixture 已补。
   - `implicit`（历史 v3）：生产者 `historyRecord`；消费者 `report.mjs` 的 `HISTORY_SCHEMA` 过滤和 `sameMeasurement`；v2 被忽略是 ADR 已写明的行为。
   - `signals`（`CalibrationRows`/`CalibrationRowsSnapshot`）：生产者 `readCalibrationRows`/SQLite durable adapter；消费者 `production-observation`、CLI、worker 序列化；形状是纯 JSON 值。
   - `decision_signals` 的 id/owner/agent/decision/signal/occurred_at/delay_ms/detail/source_ref/recorded_at：DB CHECK 与所有写入方一致；`source_ref` 最长情况（opened 的推送 key 256、undo/reply 的 `insightId@time` 约 153）都在 256 以内；`id` 约 43/48 字符，在 128 以内。**但**第 1 条发现读取端和写入端对“这条信号属于哪个推送”用的不是同一个 key；第 2 条发现 `time()`/网关 `timestamp` 接受的年份范围比新表 CHECK 宽。除这两处外，没有找到生产者产出、消费者拒绝的值。
   - `listSignals` 本身只到 port，没有网关/网页消费者；如果任务要求“从决策查询”必须有用户入口，这一块是未接线的（未核实是否在本 PR 范围）。

**未核实项**：没有运行测试、文档校验或 `runbook.py seal`，因此 `contract_sha256` 是否正确、极端时间输入在真实网关上是否可触发、以及第 1 条在真实生产数据里的发生频率，均未验证。
