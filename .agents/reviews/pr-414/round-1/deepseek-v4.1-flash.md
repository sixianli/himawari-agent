系统的最大工具步数已到，以下结论只基于已读到的代码与 `git diff`/`git show`，没有运行任何测试或检查（所以“测试通过”“check 只有 onnx 失败”“manifest 哈希正确”均标为未核实）。

# 发现（按严重度）

## 高：声称新增的“长期有效”词表根本不存在，“夜里别提醒我”不会立成生效规则

- 文件：`apps/agent-service/src/production-owner-rules.ts:54-79`、`:334-344`；`packages/prompt-catalog/src/tools.ts:231`；`docs/adr/0242-hard-rules-step4-unified-push-gate.md`
- 问题：作者说“production-owner-rules.ts 里‘长期有效’判断词表加了‘别提醒我’等说法”，但代码里没有。`git log -p` 也证实该文件在本区间只改了 tool 参数、`pushTrial` 和 `#replay`，没有改 `STANDING_MARKERS`。而 `rule_set` 只有 `!inferred && isStandingQuote(quote) && #ownerSaid(...)` 才直接激活（`:677-679`），否则只写成 `proposed`（`:680-706`）。
- 证据：
  - `STANDING_MARKERS` 只有 `以后/以後/今后/今後/一律/必须/必需/每次/总是/永远/都要/都得/不许/不要再/必ず/...`（`:54-79`），没有“别提醒我/不要提醒我/别打扰我”。
  - `isStandingQuote` 要求子句命中 `STANDING_MARKERS` 且不命中 `ONE_OFF_MARKERS`（`:334-344`）。
  - 新工具文案把“夜里别提醒我”当作 `push_quiet_hours` 的例子，同时又要求 `quote` 必须包含“以后/一律/必须”这类字样（`tools.ts:231`）。模型若照抄原话就过不了 `isStandingQuote`；若擅自加“以后”，`quotesWholeClauses`/`#ownerSaid`（`:412-431`）又找不到原文，仍然失败。
- 影响：本次宣称的“一句话立规则”核心路径不成立；“夜里别提醒我”最多生成待确认提议，不会立即成为硬规则。提交 `c6854202` 的标题说“认作长期规则”，但 `git show --stat` 显示该提交只新增了 ADR，功能并未落地。
- 建议：把“别提醒我、不要提醒我、别打扰我”等加入 `STANDING_MARKERS`（同时确认与 `ONE_OFF_MARKERS` 的“今晚/这次”互斥），并在 `production-memory-capture.test.ts` 或独立单测里加“夜里别提醒我 → active”、“今晚别提醒我 → proposed”两条正反用例。

## 中：`deferItem` 的“出站表更新 + 决策记录”并非同一事务

- 文件：`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:400-445`
- 问题：作者/ADR 说“在 deferItem 里和出站表更新同一事务写”。实际是先执行 `UPDATE web_push_outbox`（`:411-424`），成功后另起一条 `insertLedgerRow`（`:429-443`），中间没有 `this.database.transaction(...)`。`execute` 的分发（`:61-98`）和 worker 的 `durableOperations.execute`（`sqlite-worker.ts:1108-1110`）也没有统一包事务；对比同文件 `recordAttempt` 明确用了 `this.database.transaction(() => ...)()`（`:459-503`）。
- 影响：若第二步失败（约束/磁盘/异常），出站行已经进入延后状态并提交，但决策记录永远缺失；异常会让本轮 tick 中止，且下一轮该行因 `defer_until` 未到不再进入 `listDue`，不会补写记录。与“每次延后写一条决策记录”的硬要求不一致。
- 建议：把 UPDATE 和 `insertLedgerRow` 包在同一个 `this.database.transaction(...)()`（最好 `.immediate()`）里，失败整体回滚；并加一条注入 ledger 写失败的测试，断言出站表未被延后。

## 中：ADR/作者引用的若干自动检查并不存在，关键行为没有反向用例

- 文件：`docs/adr/0242-hard-rules-step4-unified-push-gate.md` 的“验证”；`test/integration/production-memory-capture.test.ts:2053-2063`；`test/integration/data-export-rules.test.ts`；`packages/application/test/rule-version.unit.test.ts`
- 问题（读代码证实）：
  - ADR 说 `production-memory-capture.test.ts` 的 `[HR-4]` 覆盖“夜里别提醒我立成生效规则”。该文件只有 `isStandingQuote` 的旧断言，没有“夜里别提醒我”，也没有 `[HR-4]`；全仓库测试里唯一出现“夜里别提醒我”的是 `production-web-push.test.ts:532`，而且它是直接用 SQL 写 `rule_book_rules` 的摘要，绕过了 `isStandingQuote`。
  - ADR 说 `test/integration/data-export-rules.test.ts` 的 `[HR-4]` 覆盖 push 规则导出导入；该文件没有 `push_quiet_hours`，也没有 `[HR-4]`。
  - ADR 说 `rule-version.unit.test.ts` 覆盖 push 规则版本展示；该文件没有 `push_quiet_hours`。
- 影响：第 1 条的高危缺失无法被现有自动检查发现；作者“反向用例真的会失败”的说法只对闸门/迁移/规则类型部分成立。
- 建议：补上上述三条测试；特别是“夜里别提醒我”走真实 `ProductionOwnerRuleWriter.create` 的正向用例，以及“删掉词表后必须 red”的反向用例。

## 低：迁移契约测试只验证了 8 张表中 3 张的数据保全

- 文件：`packages/persistence-sqlite/test/web-push-gate-migration.contract.test.ts:60-95`；`packages/persistence-sqlite/src/migrations/0093_web_push_gate.sql`
- 问题：测试只插入并核对 `decision_ledger`、`decision_signals`、`decision_prereviews` 各一行，`source_insights`、`proactive_processed_messages`、`decision_ledger_payloads`、`proactive_push_backoff`、`muse_reference_entries` 的数据保全完全未测。作者说“迁移契约测试……通过”，但覆盖面小于“八张表一条不丢”的说法。
- 读代码核对（非测试）：0093 对七张表的列、索引与 0089 一致，对 `decision_prereviews` 与 0091 一致；触发器 `decision_signals_no_delete/update`、`decision_prereviews_no_delete/update` 均重建；未发现其他表外键指向这 8 张表；删除顺序是“先子表后 `decision_ledger`”，迁移又在 `applyOne.immediate()` 事务里（`migration-engine.ts:980-993`），未发现确定的数据丢失。新增的 `rule_book_rules` 三个触发器只在集成测试“撤销规则”里间接触发 UPDATE 分支，INSERT/DELETE 分支没有测试。
- 建议：至少给五个未覆盖表各插一行并核对；补 `rule_book_rules` INSERT/DELETE 触发器的反向/正向用例。

## 低：闸门逐分钟扫描最多 1440 次/来源，且“时段之间有一分钟空隙”会提前发送

- 文件：`packages/application/src/services/web-push-gate.ts:84-106`
- 问题：`for (let at = base + MINUTE_MS; at <= limit; at += MINUTE_MS) hitsAt(candidate)` 最多 1440 次，每次都遍历全部规则；`SEND_BATCH = 50`（`production-web-push.ts:34`），一个 owner 最多 32 条生效规则。极端情况（多条整周静默规则 + 50 个不同来源同时到期）单轮可产生百万级表达式求值。另：扫描在“第一分钟无命中”处停止，若两个相邻时段之间留了 1 分钟空隙，推送会在这个空隙发出，而不是等到后一个时段结束。是否为期望语义未在 ADR 说明。
- 证据：上述循环；`pushQuietExamples`/时段语义见 `rule-book.ts:300-315`、`:333-342`。
- 建议：按“当前命中的规则集合下一次不再命中的最早分钟”解析计算而非逐分钟扫；或限制单轮扫描预算；在 ADR 里明确相邻时段空隙的处理。

## 低：48 小时总寿命与“延后时刻 + 1 小时”冲突时，推送会在静默结束前被当过期丢掉

- 文件：`apps/agent-service/src/production-web-push.ts:473-479`
- 问题：`expiresAt = min(max(item.expiresAt, until+1h), createdAt+48h)`。当 `createdAt+48h < until+1h` 时，`expiresAt` 会早于 `until`；行在 `defer_until` 到达前不会进入 `listDue`，等真正到期时只会在下一次 due 时被 `#deliver` 的过期分支记成 `expired` 丢掉。正常入队（createdAt≈now）不会触发；长时间反复延后或入队已超过约 23 小时才延后时会触发。
- 证据：该 `Math.min/Math.max` 计算；过期判断在 `:419-422`。
- 建议：若“总寿命 ≤ 48h”优先，明确这是有意丢弃并记录；否则不要让 `defer_until` 超过 `expiresAt`，在 48h 附近停止继续延后并提前发送或显式记录 capped/expired 原因。

# 侧重检查（错误路径、不可信输入、安全、资源、不可逆操作、文档一致性）

- 规则读取/判断失败：`production-web-push.ts:456-471` 捕获后 `{action:"deliver", failed:true}` 并调 `onGateFailure`，符合“推送照发并告警”。证实。
- 审批/Muse/未知来源：`PUSH_RULE_PROTECTED_CLASSES` 在 `#deferred` 入口就返回（`:452-455`），`PushGate.decide` 内部也先返回（`web-push-gate.ts:76-78`）；`pushClassOf` 对 `approval:`、`muse-channel:`、其他前缀分别归类（`:35-47`）。审批不会被延后，证实。
- 测试推送：`sendTest` 直接 `sender.send`（`production-web-push.ts:254-281`），不经过 `#deliver`/闸门，证实。
- 不可信规则参数：`parsePushQuiet` 限定 periods 1..8、days 0..6、HH:MM、start≠end、classes 只允许三个值、未知键拒绝（`rule-types.ts` 新增段）；规则表达式由类型注册表重新生成，不存任意表达式；`enforceableOwnerRule` 对坏行返回 `undefined`（`rule-types.ts:420-431`），闸门会放行而非拦截。安全上属“失败打开”，可接受。
- 存储值两端校验：`defer_until` 写入前 `valid()` 要求规范 24 字节 ISO（`sqlite-web-push-operations.ts:41-44`），迁移 CHECK `length(defer_until)=24`（0093 第 1-2 行）；`ruleRefs` 闸门侧排序去重并截到 16（`web-push-gate.ts:95-101`），存储侧校验 1..16、去重、长度 ≤256（`sqlite-web-push-operations.ts:404-410`），`insertLedgerRow` 的 `MAX_IDS=200`、单 id ≤256。两端一致。
- 安全/日志：`onGateFailure` 只记录 `sourceKey`（`service-main.ts:2395-2401`），不含推送正文/记忆文本；无新增密钥或外部输入拼接进 SQL（均为绑定参数）。
- 资源：见上“逐分钟扫描”。
- 不可逆操作：0093 先 `CREATE TABLE ..._keep AS SELECT *`，再按“子表→父表”删除，最后在迁移事务内重建并回灌（`migration-engine.ts:980-993`）；核对 0089/0091 后未发现列、索引、触发器遗漏或其他表外键被破坏；但测试覆盖不足（见上）。
- 文档一致性：ADR 0242 与提交标题对“词表已加”“三个测试已覆盖”的描述与代码不符（见高/中两条）；ADR 关于“闸门位置、审批/Muse 放行、测试推送不走闸门、寿命上限”的描述与代码一致。

# 逐条回答必答问题

1. **会不会改变模型已经见过的请求开头？是否仍然只在末尾追加、每轮变的值都在最后一条消息里？**
   - 会改变一次：`rule_set` 的工具参数结构新增 `periods`/`classes`（`production-owner-rules.ts:178-206`），工具描述文本也改了（`tools.ts:231`）。按 `thread-prompt-bundle-service.ts:152-157`、`:201-208`，旧对话在下一轮会以 `tool_schema_changed` 自动重建冻结提示，因此所有老对话的第一轮请求开头会变一次；ADR 0242 已记录 Andy 同意。这不是纯粹的“只追加”，而是 ADR 0165 允许的一次性换新。
   - 除此之外没有把每轮变化的值塞进系统提示/工具定义：推送闸门只在发送点读取规则，不参与模型请求；新增字段都是静态枚举/结构；`now`、`defer_until`、当前静默时刻都不进提示。推送正文、历史、遮盖规则本改动均未触及。
   - 结论：**本次改动确实改变老对话开头一次（已获 ADR 批准）；没有新增“每轮会变但放在请求开头”的值。**

2. **会不会让同一段文字在不同请求里变成不同字节？**
   - 未发现。`parsePushQuiet` 对 `days` 去重排序、对 `periods` 按 `JSON.stringify` 排序、`classes` 按固定 `PUSH_QUIET_CLASSES` 顺序过滤（`rule-types.ts` 新增段）；`quietHoursExamples` 顺序确定；`ruleRefs` 排序；决策记录 id 由 owner/agent/sourceKey/deferUntil 哈希，确定；`pushTrial` 的星期/时间来自已排序的示例事实。数据导出文字也按存储参数确定性生成。
   - `defer_until`、决策记录 `decidedAt` 依赖 `now`，但它们不进入模型请求字节，只进入数据库/日志。结论：**没有新增模型可见文本的非确定性；遮盖逻辑未改。**

3. **有没有对应自动检查，反向用例真的会失败？**
   - 有：`web-push-gate.unit.test.ts` 覆盖“坏规则 → deliver+failed”“审批/Muse/unknown 不交给规则”“时段类别不匹配不延后”；`rule-type-push-quiet-hours.unit.test.ts` 覆盖参数拒绝、跨午夜、默认类别；`production-web-push.test.ts` 覆盖延后、撤销释放、新设备、审批不延后、规则读取失败；`web-push-gate-migration.contract.test.ts` 覆盖迁移后三类行保全、不可改触发器、`web_push` 只接受 `deferred`；`calibration-group-copy.test.ts:27-33` 会强制三语文案包含 `web_push`。这些反向用例从逻辑上会在被移除修复时失败。
   - 缺：**“夜里别提醒我”词表行为的测试不存在**，ADR 引用的 `production-memory-capture.test.ts`/`data-export-rules.test.ts`/`rule-version.unit.test.ts` 对应用例也不存在；`deferItem` 原子性没有测试；迁移只测了 3/8 张表。作者“这些测试都通过”和“npm run check”本人**未核实**。

4. **每个新增/修改的值，生产端和使用端是否都能接受？**
   - `kind = "web_push"` 与 `outcome = "deferred"`：生产端 `DECISION_KINDS`/`DECISION_OUTCOMES`（`ports/decision-ledger.ts`）与迁移 CHECK（0093 decision_ledger 定义）一致；消费端 gateway `contracts-v2.ts:1100-1105`、数据导出 `data-export/schemas.ts:190-207` 已接受；每日打分/校准通过 `daily-review.ts:45,352-354`、`sqlite-decision-ledger-operations.ts:510-525` 排除；`production-decision-chain.ts:98` 为 `web_push` 补了 `rulesRecorded`；`listReviewPool` 之外没有发现会因新 kind 崩溃的穷举。`proactiveReviewKinds`（`contracts-v2.ts:534-544`）和 `calibrationGroupSchema`（`:795-807`）故意不含 `web_push`，与“不进每日打分/校准”一致。
   - `rule type = push_quiet_hours`：`RULE_TYPES`、`RULE_KINDS`、`OWNER_RULE_KINDS`、`STORED_KINDS`、`KIND_LABELS`、gateway 的 rule kind 枚举、三语 `rules.type` 都已加；`ownerRuleRecord`/`enforceableOwnerRule`/`RuleJudge`/闸门都按 gate 正确处理。`data-export/rules.ts` 的 `pushQuietWording` 读取的 `params.classes` 在存储时已由 `parsePushQuiet` 补默认值（`production-owner-rules.ts:564-569`），不会出现空类别导致的语义丢失。
   - `defer_until`/`defer_rule_refs`：写端 `deferItem` 的校验与迁移 CHECK 一致；读端 `listDue` 过滤 `defer_until <= now`；触发器清空两者；没有其他读端。
   - `ruleRefs`：闸门产生 `id@revision`（最多 16、排序），`deferItem` 校验 1..16 唯一且长度 ≤256，`insertLedgerRow` 的 `ruleIds` 校验 1..256 唯一；消费端 `describeRuleVersion(parseRuleRef(...))` 能解析。两端可接受。
   - 唯一发现的不一致是第 1 条的“词表未加”和第 2 条的“未同事务”，其余新增值两端核对通过。

**未核实**：所有测试/`npm run check` 的实际结果、`prompt-manifest.json` 新哈希是否与 `TOOL_RULE_SET` 实际内容匹配、迁移在真实旧库上的执行结果、以及“审批/告警在极端规则数据下”的运行时表现（只读代码推断）。
