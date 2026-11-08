# 复核报告（PR 293 / P0-11，b422b30 对比 2995d53）

## 读代码证实的结论（按严重度排列）

### 1.【中】迁移 0080 的历史回填没有任何测试覆盖
- 文件：`packages/persistence-sqlite/src/migrations/0080_decision_signals.sql:24-35`
- 证据：回填是 `INSERT INTO decision_signals ... SELECT ... FROM decision_ledger decision JOIN web_push_feedback feedback ...`。而 `test/integration/decision-signals.test.ts:130` 的 `addFeedback` 是在 `applyMigrations` **之后**才插 `web_push_feedback` 行（走运行时路径）；`packages/persistence-sqlite/test/migration-engine.contract.test.ts` 只把序号从 79 改到 80，从空库跑全量迁移，join 不命中任何行。也就是说回填 SQL 在「有真实历史数据」的场景下从未被执行过。回填在 expand 阶段、迁移事务里，一旦在生产数据上出错（如历史时间格式、约束冲突），整个数据库迁移失败、服务起不来。
- 建议：补一个合同测试——先建 79 库并插入若干 `web_push_feedback`（含 opened_at 为 NULL、kind 非 reminder、已删除决策引用等边角行），再跑 0080，断言回填条数、delay、去重。

### 2.【低】回填生成的 id 可能超出 128 长度上限（理论边角）
- 文件：`0080_decision_signals.sql:2,25`、`0069_decision_ledger.sql:2`
- 证据：`decision_ledger.id` 允许最长 128 字符，回填 id 是 `'signal:opened:' || decision.id`（前缀 14 字符），`decision_signals.id` CHECK 是 `length(id) BETWEEN 1 AND 128`。decision id 超过 114 字符时迁移失败。运行时 id `signal:${randomUUID()}`（43 字符）无此问题。现网 decision id 是短的（推测：由 `createDecisionId` 一类生成器产生，未核实其上限），风险很低。
- 建议：回填改用 `substr` 截断或直接用 randomUUID。

### 3.【低】周报「观察信号」的窗口按决策时间归属，数字会事后漂移
- 文件：`packages/calibration/src/index.ts`（`CALIBRATION_SQL.signals`，diff 中 433-444 行）
- 证据：`WHERE decision.checked_at >= ? AND decision.checked_at < ?`——只按**决策**所在周过滤，不看 `signal.occurred_at`。后果：① 周报生成之后才发生的点开/撤销会算进该周的分子（网页是活查询，回头看旧一周的数字会变大）；② 撤销/回复可能发生在决策数周之后，delay 依旧计入。这与打分的归属方式一致，但和「周报生成时点快照」的直觉不同，ADR 0182 未写明。
- 建议：在 ADR「后果」里补一句，或改为按 `occurred_at` 过滤（需另行权衡分母语义）。

### 4.【低】网页把「周未完整」显示成「样本不足（N 条）」
- 文件：`apps/control-center/src/components/weekly-report.tsx:1066-1070`（diff 计数）、`apps/agent-service/src/production-observation.ts:256`
- 证据：服务端在 `complete` 为假时把 `rate` 置 null；UI 用 `item.rate?.enough && item.rate.value !== null` 判断，null 时落到 `message("weekly.few", …)`（「样本不足（N 条）」）。周未完整和样本不足两种原因被合并成一种文案（snapshot 里有 `ratesWithheld` 字段可区分）。纯文案问题。

### 5.【信息】历史 schema 升到 v3 后，升级后首份周报没有「与上一周对比」
- 文件：`packages/calibration/src/index.ts:1`（`HISTORY_SCHEMA = "...v3"`）、`scripts/calibration-report/report.mjs:105`（`entry.schema === HISTORY_SCHEMA` 才当 previous）。旧的 v2 历史行被忽略。行为安全（不会混算），但 ADR 0182 未提这个副作用。

### 6.【信息】silentShare 的「配置→打分页」接线无端到端断言
- 证据：`apps/agent-service/src/production-proactive.ts:317` 把 `reviewSilentSharePermille` 传给 `readDailyReview`，但 `test/integration/proactive-production.test.ts:271` 只加了配置字段，没有断言沉默决策真的按占比出现在 `proactive.review.snapshot` 里；`undefined` 分支（daily-review.ts:102）在生产不可达（配置必经 `parseProactive`，默认 500），只有测试会走到。单元测试（`daily-review.unit.test.ts`）和配置测试各自覆盖两端，中间一根线没测试。

## 并发/事务、去重、回填、算术（重点核对，均读代码证实）

- 三处写入都在事务里：`recordReactions`（sqlite-web-push-operations.ts:484-517，UPDATE 与信号同一 `transaction`）、`updateInsight`（整个「读 before → UPDATE → 写信号」包进 `transaction`）、回复（`record` 整体在 `transaction`，sqlite-proactive-operations.ts:615，`openForReply`→`markReplied`→写信号同事务）。better-sqlite3 同步单写，无竞态窗口。
- 去重：`UNIQUE (decision_id, signal, source_ref)` + `INSERT OR IGNORE`（0080:12、decision-signals.ts:31）。opened 的 sourceRef=source_key，且 UPDATE 带 `opened_at IS NULL` 条件（重开 changes=0 短路）双保险；undone 的 sourceRef=`insightId@now`，同一 `now` 重试去重、不同 `now` 记两条（ADR 已声明「撤销可记多次」）；replied 的 sourceRef=`insightId@receivedAt`，测试覆盖了重复回复只记一条。
- 抽样算术：`mixBySilentShare`（daily-review.ts:61-78）在 0（有 acted 就不取沉默）、1000（全沉默）两端正确；500/容量 10 = 5、250/容量 8 = 2 我手算与测试断言一致；一边取尽让位的逻辑正确；`notSampled` 计入未抽到的沉默决策（测试断言 30）。
- 周报不混算：`summarizeImplicit` 分子只数 `pushed` 决策的信号（deferred 计入分母，ADR 写明）；`otherDecisionEvents` 单列不进比例；`historyRecord.implicit` 不含 rate；`sameMeasurement` 加了 implicit 比较；网页在 `complete=false` 时 rate 为 null（production-observation.ts:256）——作者这条说法属实。
- 回填 SQL 本身逐行读过：delay 用 `max(0, ...)` 钳位（`opened_at` 写入时已 `max(first_sent_at, ...)`，非负）、时间格式与 GLOB 一致（写入前都过了 `toISOString()===value` 校验，sqlite-proactive-operations.ts:68-71）、`kind='proactive'` 限定使 approval/run 反馈不会误挂、`web_push_feedback` 主键 (owner, agent, source_key)（0061:15）保证 join 不产生重复行。**除「无测试」外未发现回填逻辑错误。**

## 侧重检查（走的一条普通流程）

「每天打分页」从入口到结束：网页发 `proactive.review.read` → `ProductionProactive.query`（production-proactive.ts:321）→ `review()`（:306-319，silentShare 接线）→ `readDailyReview`（listReviewPool → ledgerGroup 拆 `proactive`/`proactive_silent` → selectDailyReview 混排）→ snapshot 到 UI → 用户点撤销 → `updateInsight`（写 undone 信号）→ 用户打分 → `rateDecision`；另一支：周报 `proactive.weekly.read` → `readCalibrationRows`（含 signals）→ `summarizeImplicit` → snapshot/UI。

- 已覆盖：`selectDailyReview` 混排（单元，含反向）、`updateInsight`/`recordReactions`/回复信号（集成，worker+direct 两种执行，含反向与触发器不可变用例）、配置解析（含 1001/-1 反向）、周报 UI（含两条反向）、迁移序号（另有 `check:audit-schema-range` 门把审计脚本钉在 80，I-46 门槛生效）。
- 无测试覆盖的路径：**0080 回填（发现 1）**；production-proactive.ts:317 的接线（发现 6）；`scripts/calibration-report/report.mjs` 的 CLI 路径只有 fixture 级更新（`buildReport` 收 implicit），CLI 对未完整周不隐藏比例——与组比例的既有行为一致，未见回归测试，标「未核实其是否需要」。

## 作者说法逐条核对

| 说法 | 结论 |
|---|---|
| 点开在 recordReactions 事务里写 | 证实（sqlite-web-push-operations.ts:484-517） |
| 撤销在 updateInsight 事务里写 | 证实 |
| 回复在 markReplied 前后配对写入 | 证实（sqlite-proactive-operations.ts:762-792） |
| 迁移含历史回填 | 证实，但只回填 opened，且**无测试**（发现 1） |
| 周未完整时不给比例（null） | 证实（production-observation.ts:256） |
| 去重键 (decision_id, signal, source_ref) | 证实 |
| 不碰模型请求和提示词 | 证实：改动不触 prompt-catalog、runtime-pi、遮盖；daily review 只产出到 UI 快照（production-proactive.ts:321-339），`selectDailyReview` 无其他消费方 |

## 必答问题

1. **请求开头**：不会变。改动全部落在持久化、配置、打分抽样和周报/快照序列化；没有触及系统提示、工具定义、历史消息或遮盖代码。抽样结果只进 `proactive.review.snapshot`（给 UI），不进任何模型请求。符合 prompt-prefix 规则的前提（本改动根本不改「发给模型的内容」）。
2. **字节确定性**：不会。新增的序列化输出（周报 markdown、history JSONL、snapshot）顺序都固定：`IMPLICIT_SIGNALS` 常量序、`ORDER BY occurred_at, id`、median 排序后取值、JSON.stringify 只用于定序数组。唯一随机值是 `signal:${randomUUID()}` 的主键，只存库，不进任何输出。`mixBySilentShare` 与 `order`（FNV 哈希）确定。
3. **自动检查**：大部分有——信号写入/不可变/级联（worker+direct、含反向）、抽样两端与让位（含反向 0）、配置范围（含反向）、周报 UI（含反向）。**反向用例我读了断言逻辑，方向正确**（如重开 changes=0 短路、未知 tag join 不中、rating-only 不记信号由「恰好 2 条」隐式覆盖）。缺口是 0080 回填零覆盖（发现 1）。新测试在 vitest unit/integration/browser 标准项目里，`npm run test` 会跑；是否全部纳入 `npm run check`（run-all-checks.mjs）未核实。
4. **每个值的产生/使用两端**：
   - `reviewSilentSharePermille`：产生于 strict-configuration.ts:1041（0–1000，默认 500，allowed 列表已加）；消费仅 production-proactive.ts:317 → `readCalibrationRows`/`readDailyReview` 可选参。接口 `ProactiveConfiguration` 加了必填字段，TS 强制所有构造方补齐（测试 fixture 已补）。两端闭合。
   - `proactive_silent`（DailyReviewGroup）：只在 daily-review.ts 内部用于分队，快照 item 不含 group，`DEFAULT_GROUPS` 不含它（由 proactive 队列吸收）——无泄漏，闭合。
   - `himawari-calibration-week.v3`：产生于 historyRecord；唯一读取方 report.mjs:105 按 schema 过滤——不会把 v2/v3 混比，闭合（副作用见发现 5）。
   - snapshot `implicit` + `listSignals` 端口 + `decision_signals` 表：合约 schema、gateway fixture、UI、schema-catalog、审计脚本（80）同步更新；`listSignals` 目前只有测试消费（ADR 声明）。与 I-73 的教训对照：这次配置键和合约字段都核了后端校验（0–1000 双向测试、nullable rate——contracts-v2.ts:774 `nullable(...)` 确认），未发现同类断链；唯一未走通的链仍是回填（发现 1）。

**推测/未核实的部分**：decision id 生成器的长度上限（发现 2 按 schema 推算）；`npm run check` 是否运行全部 vitest 项目；CLI 未完整周报告的历史行为（未发现回归测试，但组比例路径是既有的）。
