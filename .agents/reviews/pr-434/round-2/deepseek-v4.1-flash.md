# PR 434 第 2 轮增量复核

复核范围：`git diff 4778b1ca7..8ae3a349f`（含 `f9cc84c15`），并按需读了 `0d989adb..8ae3a34` 的完整改动。没有运行测试，只读了代码和测试源码。`.agents/reviews/**` 在当前 sparse checkout 里读不到（`git show` 也被拒绝），作者说明中涉及这些文件的内容标「未核实」。

## 读代码证实的问题（按严重度）

### 中：暂停规则被重新排队后，清单仍显示上一次的暂停结论，没有“等系统自动核对”
- 文件:行：`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:577-580`；`apps/control-center/src/components/correction-review.tsx:55-58`、`74-99`
- 问题：触发器重新排队时只清 `suggestion`，保留 `suspend_reason`。而网页用“`suspendReason` 是否为空”决定显示旧的暂停原因还是“等系统自动核对”。由于数据库约束保证 `suspended` 必有 `suspend_reason`，被重新排队的暂停规则永远显示旧结论（例如“来源记忆和原规则对不上”“来源记忆删了”），而不是“等系统自动核对”。若来源记忆已从回收站恢复，显示的原因甚至已经不成立。此时按钮是“确认停用/恢复原规则”，也不是 ADR 第 5 条说的“还在等核对的只有‘看过没问题’”。
- 证据：
  - SQL：`UPDATE rule_book_rules SET status = CASE WHEN status = 'suspended' THEN 'suspended' ... suggestion = NULL ...`，没有清 `suspend_reason`。
  - UI：`{rule.suspendReason ? message("review.suspendReason", { r: rule.suspendReason }) : message("review.checking")}`
  - ADR 0232:54 写“暂停且有建议的……；还在等核对的只有‘看过没问题’”。
- 建议：在 `memory.review.snapshot` 里暴露 `reviewAfter`/`reviewing`（或等价字段），清单据此显示“等系统自动核对”；或者重新排队时把 `suspend_reason` 也清掉并放宽约束。补一条“suspended + suggestion=null + review_after 非空”的组件测试。

### 低：`source_unreadable` 只测到内存假端口，没有覆盖 SQLite 约束这一端
- 文件:行：`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:346-349`；`packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:36-41`；`packages/application/test/rule-review-service.unit.test.ts:216-231`
- 问题：三处清单（迁移 CHECK、`FAILURE_REASONS`、port 联合类型）都加了 `source_unreadable`，但新测试用的是 `rule-review-service.unit.test.ts` 里的假 `store`，没有一条测试真正走到 `ruleReview.recordFailure` → SQLite CHECK。任何一处漏改都不会被现有测试发现，只会在生产写入时炸。
- 证据：单测断言 `run.failures` 为 `source_unreadable`，但 harness 的 `recordFailure` 是内存函数；迁移合同测试只用了 `model_failed`（`correction-propagation-migration.contract.test.ts:378-384`）。
- 建议：在 `correction-propagation-migration.contract.test.ts` 加一条 `recordFailure` 用 `source_unreadable`、然后读回 `review_failure` 的合同测试。

### 低：ADR 的“每次最多展开 200 行”与代码的资源上限不一致
- 文件:行：`docs/adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md:50`；`apps/agent-service/src/production-memory-control.ts:173-190`；`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:20-21,58-63`
- 问题：代码里 200 指的是“每次 `expandMemoryReviews` 最多处理 200 条未展开的根行”（10 轮 × 每轮 20 条），每条根行经 `derivedMemories` 还可再展开最多 200 个下游节点、8 层。实际写入/更新的 `memory_review_items` 行数可以远大于 200。ADR 写成“每次最多展开 200 行（每批 20 行、最多 10 批）”会让人以为是总行数上限。
- 证据：`MEMORY_REVIEW_EXPAND_ROUNDS = 10`、`limit: MEMORY_REVIEW_EXPAND_BATCH`（20）、`MEMORY_BASIS_CHAIN_MAX_NODES = 200`、`found.length >= MEMORY_BASIS_CHAIN_MAX_NODES`。
- 建议：改成“最多处理 200 条未展开的根行；每条根行最多再展开 200 个下游节点、8 层”，或给总写入行数加显式上限。

### 低：expand 的“新事件重开/同一记忆再次标出”没有回归测试
- 文件:行：`packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:434-439`；`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:527-529,601-603`；`packages/persistence-sqlite/test/correction-propagation-migration.contract.test.ts:179-193,339-370`
- 问题：第 2 轮只新增了“多条路径保留最短层数”和“重排队清建议”两条测试。作者点名的“同一条记忆被新事件再次标出”“已结清的行被新事件重开”没有测试。读代码看逻辑是对的（触发器无条件把直接下游 upsert 成 `open`；间接行由 `flagged_at < excluded.flagged_at` 重开），但以后改条件很容易悄悄破坏这两条。
- 证据：触发器 `ON CONFLICT ... DO UPDATE SET ... status = 'open', resolution = NULL, flagged_at = excluded.flagged_at, resolved_at = NULL`；expand 的 `WHERE flagged_at < excluded.flagged_at OR (status='open' AND excluded.depth < depth)`。
- 建议：补“resolve 后再改上游，条目重新打开”和“同一记忆经不同上游再次标出，清单按记忆合并显示”两条合同测试。

### 低：决策记录写法规范没有列出 `memory_review`
- 文件:行：`docs/execution/specs/2026-11-09-decision-record-write-convention.md:26,35`；`packages/application/src/ports/decision-ledger.ts:32-41`
- 问题：规范把 `decision_ledger` 的种类逐个列出，但只列到 `rule_review`；“其他种类”的写入路径清单也没有 `memory_review`。代码和 ADR 0232 已经加了 `memory_review`（经 `insertLedgerRow`，写四个键）。这是说明文档与代码不一致。
- 证据：规范原文“种类有 proactive、...、rule_review”；代码 `DECISION_KINDS` 第 40 行已有 `"memory_review"`。
- 建议：把 `memory_review` 补进该规范的种类列表和“其他种类”清单，注明它走 `insertLedgerRow`、只落 `memoryIds/ruleIds/batchId/resultMemoryIds`。

## 推测 / 需确认（不作为已证实问题）

- **数据导出格式版本未升。** 这份改动给 `DECISION_SCHEMA` 加了 `memory_review`、给 `RULE_SCHEMA` 加了 `suspended`/`suspendReason`，但 `FORMAT_VERSION` 仍是 `himawari.data-export.v3`（`packages/persistence-sqlite/src/data-export/schemas.ts:3`）。ADR 0233、0246 的先例是“新数据进导出就升版本”。反方向导入（新导出给旧版本）会因旧版内置 schema 不认识新枚举而报“文件损坏”，而不是清楚的“格式不支持”。旧导出导入新代码是兼容的，所以这可能是有意的；建议按先例确认一次。
- **`suggestionConditions` 的脏数据容错。** `production-memory-control.ts:623-627` 直接对 `rule.suggestion.params[field]` 调 `.map`。正常路径的 suggestion 都由 `parseOwnerRuleParameters` 校验过，所以现在安全；但如果库里的 suggestion 被外部写成 `params: null` 之类，`memory.review.read` 会整页失败。这是推测边界，不是本轮改动可复现的 bug。

## 侧重检查（错误路径、不可信输入、安全、资源、不可逆、文档一致性）

- **错误路径**：`readMemoryText` 抛错统一记 `source_unreadable`，生产接线确实会在 `undefined` 时抛 `RULE_REVIEW_MEMORY_UNREADABLE`（`service-main.ts:2004-2007`），重试次数与模型失败共用 `RULE_REVIEW_MAX_ATTEMPTS=3`；`recordFailure` 仍校验 `review_after IS NOT NULL` 和修订号，未发现新绕过。发现的问题是测试只覆盖到假端口（见上）。
- **不可信输入**：`expand` 的 `now`/`limit` 仍校验并参数化；`recordFailure` 的 reason 走白名单；数据导入端 `assertRuleHistory` 会拒绝“suspended 却没有 suspendReason / 非 suspended 却带 suspendReason”（`data-export/verify.ts:501-502` 调用）。没有发现新的注入或越权。
- **安全/隐私**：`suggestionConditions` 来自规则参数，和已有 `suggestion` 摘要同源；导出端仍把 suggestion 整个丢掉（新测试用 `not.toContain("isa.go.jp")` 锁住），没有新增泄漏面。没有新增日志输出正文。
- **资源**：expand 有根数/节点数/深度上限，并在事务里跑；但如 ADR 那条，实际行数上限的描述不准确，单次请求最坏可产生远多于 200 行的 upsert。
- **不可逆操作**：重新排队清 suggestion 是不可逆的，但 suggestion 可按来源记忆重算，且清掉是为了防止采用旧建议，属于有意取舍；迁移 0095 仍不可逆，ADR 已有说明。
- **规则/文档一致性**：ADR 0232 与代码主体一致；发现“200 行”措辞、`memory_review` 未进写法规范、格式版本三处需修正或确认。`.agents/...` 的 judgments/owner-decisions 未核实。

## 作者 6 条核对项的回答

1. **是否修掉第 1 轮问题**：`writeRule` 清字段、触发器清 `suggestion`、`source_unreadable` 三处同步、`expand` 最短层数、`text` 可空、`suggestionConditions`、导出 `memory_review`、文案改动都已落到代码，方向正确。新引入的问题主要是我上面列的清单状态文案/文档/测试缺口，不是数据错误。
2. **expand 的三种情况**：多条路径同事件 → 保留最短（有测试）；同一记忆被新事件再次标出、已结清重开 → 直接下游由触发器无条件 `upsert` 重开，间接行靠 `flagged_at < excluded.flagged_at` 重开，读代码没发现会永远停在 `expanded=0` 或漏展开的路径；但后两种没有测试。极端的“旧事件比新事件更早但路径更短”的 `flagged_at` 回退场景，在当前触发器总会把同一上游的直接根行刷成最新时间的前提下实际不可达（推测，未构造测试）。
3. **数据库约束**：触发器和 `writeRule` 清字段后约束仍成立。`suspended` 保持 `suspend_reason` 非空、`suggestion` 清空满足 `suggestion IS NULL OR suspend_reason='parameters_changed'`；`writeRule` 把状态改 `active` 的同时清 `review_after`，也满足 `review_after IS NULL OR status IN (...)`。暂停但无建议的规则：不显示“采用建议”，显示“确认停用/恢复原规则”，功能上合理；问题是仍显示旧的暂停原因、没有“等待核对”提示（见中severity）。
4. **`writeRule` 是否误清 `owner:` 规则**：不会。它只被 `QUIET_HOURS_RULE_ID`/`IMPORTANT_SENDER_RULE_ID` 调用（`sqlite-proactive-operations.ts:57-58,313-330`），规则 id 不是 `owner:` 前缀。`test/integration/rule-memory-review.test.ts:274-307` 还锁住了“主人改设置后清掉等待、保留来源记忆链接”。
5. **`text` 可空、`suggestionConditions` 的消费方**：唯一的网页消费方是 `correction-review.tsx`（文本用 `?? message("review.textGone")`，条件用 `suggestionConditions.map`）；`memory.ts` 的类型从 `GatewayV2Snapshot` 自动派生，不用手改；网关夹具、控制中心单测、生产集成测试都已补字段；浏览器 e2e 桩不提供 `memory.review.snapshot`，不受影响。未发现漏跟的地方。
6. **ADR 0232 与代码**：主体一致（最短层数、清建议、导出暂停原因和 `memory_review`、确认停用文案、`source_unreadable` 都在代码里）。不一致处是“每次最多展开 200 行”的措辞，以及“还在等核对的只有‘看过没问题’”没有覆盖“已暂停又被重新排队”这一新状态；`owner-decisions.md` 未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这个增量没有改系统提示、工具定义、历史消息或遮盖结果；唯一模型相关改动是 `RuleReviewService` 先读正文再构造 `ruleReviewPrompt`，提示仍是“固定说明在前，变化的 `memory`/`currentRule` JSON 在最后一行”（`packages/application/src/services/rule-review-service.ts:52-62,103-111`）。`packages/application/test/rule-review-service.unit.test.ts:233-246` 用逐字节相等锁住了这一点。`suggestionConditions`/可空 `text` 只出现在网关给网页的快照里，不进模型请求。
2. **会不会让同一段文字在不同请求里变成不同字节？** 没发现新的非确定性进入模型输入：`RULE_CONDITION_FIELDS` 是固定顺序，规则参数解析会排序去重；规则重检的 prompt 使用排序后的参数和库里的正文。随机 id、时间戳、`null` 只出现在决策记录/快照，不出现在这轮模型 prompt。
3. **有没有自动检查、反向用例是否会失败？** 有：
   - `expand` 最短路径测试：把 `WHERE` 改回旧的 `OR status='open'`，`m:c` 会变 depth 2，测试必失败。
   - 触发器清建议测试：不清 `suggestion` 时 `adopt` 会成功、`suggestion` 非空，测试必失败。
   - `writeRule` 清等待：不改 `review_after` 会撞 `CHECK (review_after IS NULL OR status IN (...))`，`rule-memory-review` 测试会失败。
   - 导出/导入测试：不加 `memory_review` 到 `DECISION_SCHEMA` 或不改 import，往返测试会失败。
   - 网页测试：`text: null` 不显示占位、或 `suggestionConditions` 不渲染，单测会失败。
   缺口：`source_unreadable` 没走到 SQLite CHECK；记忆条目“重开/再次标出”没测试；suspended 重排队后的界面状态没测试。
4. **每个新值的两端是否互相接受？**
   - `memory_review`：迁移 0095 的 `decision_ledger.kind` CHECK、`DECISION_KINDS`/`DECISION_OUTCOMES`、网关 `decision.chain` 与 `proactiveReviewKinds`、`DECISION_SCHEMA`、三语文案、每日回顾排除、校准分组排除，都能接受；`calibration-group-copy` 测试还会检查三语 kind 列表。
   - `suggestionConditions`：五个字段与 `MailMatchParameters` 完全一致，产出按固定字段顺序、值来自已校验并排序的规则参数；网关 schema 的枚举/长度、网页消费方、网关夹具、单测都接受。
   - `text: null`：网关 schema 可空，生产端缺记录/解密失败返回 `null`，唯一网页消费方有占位文案，测试已补。
   - `source_unreadable`：port 联合类型、SQLite `FAILURE_REASONS`、迁移 CHECK 三处一致，重试上限共用；没有展示端消费。
   - `suspended`/`suspendReason`：导出 schema、导入的 `suspendReason`、`assertRuleHistory` 的配对校验、`enforcedRuleCount`、RULES.md 文案都接受；导入端会拒绝不配对的值。
   - `writeRule` 清字段：只有 `quiet_hours`/`floor_important_sender` 会走到，不会误伤 `owner:` 规则；来源记忆链接保留有测试。
   - 剩下需要确认的只有数据导出格式版本（见“推测/需确认”）。
