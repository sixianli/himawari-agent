# 复核报告：PR 376（P2-7 决策记录指向真正执行了的那一版规则）

## 发现的问题（按严重度从高到低）

**1. 低 · packages/application/src/services/proactive-rules.ts:87 · `floorHitRefs` 的回退分支没有直接测试**
- 证据（读代码证实）：`refs.add(rule ? ruleRef(rule.id, rule.revision) : id);` —— 规则在 `rules` 里找不到（或 outcome 不是 `raise_floor`）时写裸 id。集成测试里 `floor_unregistered_rule` 是直接往 fixture 里塞的裸 id（test/integration/decision-chain.test.ts:390 附近），没有走这个回退分支本身。
- 建议：在 rule-version.unit.test.ts 补一条「rules 数组里没有该 id」的用例。

**2. 低 · apps/agent-service/src/production-observation.ts:322,390 · 「这封邮件用到」标签不覆盖 suppress/quiet 命中**
- 证据：`const forMail = (field: "floorHits" | "memoryByMail" | "relatedByMail")` 只读 `floorHits`，而 `ruleIds` 现在还包含 `ruleHits` 和 `quietRefs`（proactive-mail-check-service.ts:1376-1383）。一封因小额被压制或因静默被压后的邮件，抽屉里 `suppress_small_amount`、`quiet_hours` 项不会带「这封邮件用到」标签。改动前 ruleIds 只有地板规则，不算回归，但既然 items 列表变全了，标签语义没跟上。
- 建议：`forMail` 增加 `ruleHits`（并把 quiet 命中加进该邮件的判定），或确认这是有意保留。

**3. 低 · packages/application/src/rules/rule-ref.ts:8 · `slice(0, 256)` 可能截断修订号**
- 证据：`return `${ruleId}@${revision}`.slice(0, 256);` —— 若 ruleId 超过约 253 字符，修订号被截断，`parseRuleRef` 会把整串当裸 id（revision 变 null），静默降级为「当前版本」。当前规则 id 都很短（rule-book.ts:30-36），写入端校验也限 256（sqlite-proactive-operations.ts:659），实际触发不了，属理论缺陷。
- 建议：截断后校验能否 round-trip，或对 ruleId 长度单独截。

**4. 低 · packages/application/src/services/proactive-mail-check-service.ts:1330-1335 · 静默判定每次推送压后时跑两遍 CEL**
- 证据：`quietEnd` 内部先调 `quietHitRefs`（proactive-rules.ts:74），命中后调用方又调一次 `quietHitRefs` 填 `quietRefs`。结果一致（同输入同输出），只是裁判多跑一次，无正确性问题。
- 建议：可让 `quietEnd` 返回 `{ end, refs }`，一次算完。不改也行。

以上均为低severity，未发现会破坏行为或校验的缺陷。

## 作者六条说法核对

1. **属实**。`ruleRef` 生成 `id@revision`（rule-ref.ts:8）；`floorHits` 仍写裸 id（proactive-mail-check-service.ts:827-833）；修订号 0 = 设置从未存过（sqlite-proactive-operations.ts:257,265 `?? 0`），读取端 0 走 `defaultRuleParameters`（sqlite-decision-ledger-operations.ts 的 `readRuleVersions`）。
2. **属实**，一点小补充：带修订号先查 `rule_book_history`，查不到且修订号非 0 就没有兜底（显示「查不到」）；查历史之所以能命中当前版本，是因为 `writeRule` 每次写规则时把新版本也插进 history（sqlite-proactive-operations.ts:361-370，改动前已如此）。
3. **属实**。rule-version.ts:145-149 内置规则 `rule.revision !== revision` 时 `rebuild` 返回 undefined → wording null → 抽屉显示「这一版的规则内容查不到」（zh-CN.ts 新增文案）。
4. **属实**。`senderListed`（rule-book.ts:244-249）与 `importantSenderExpression`（219-223）的语义逐条对上（含子域名 `endsWith("." + entry)`）；`inQuietPeriod`（319-328）与 `quietPeriodExpression`（284-292）对上（跨午夜用 `local_previous_weekday`、start==stop 双方都判 false、半开区间终点不含）。`mailItemFacts` 会把地址转小写（rule-book.ts:123），生成例子和 CEL 看到的字节一致。单元测试覆盖了跨午夜、终点 00:00（22:00–00:00）、空时段、子域名例子；「名单重复项去重」逻辑是 Set，未见专门用例（推测无碍）。
5. **属实**（依据 ADR 0215 前提 6 引的迁移 0087 触发器 SQL 与约定文档；触发器 SQL 本身我未直接读，标未核实）。读取端 bare id → `current: true`，抽屉显示「只记了规则名，显示的是现在的版本」（zh-CN.ts:973 附近），控制中心测试断言了这句。
6. **属实**。`DECISION_RULE_CATALOG` 与 `decisionRuleDefinition` 已删，代码里只剩 ADR 文档的历史提法。

## 侧重检查

走的流程（普通流程：主人设重要发件人 → 邮件检查 → 打开依据抽屉）：
1. `writeSettings` → `writeRule`（revision 自增 + history 插入，sqlite-proactive-operations.ts:336-371）——decision-chain.test.ts 覆盖两次写入产生 rev 1/2。
2. 检查时 `readSettings`（rev 0 兜底默认值）→ `ruleBookFor` 生成规则和例子（每次检查都生成；≤7 个发件人例子 + ≤32 个静默时刻，纯内存小计算，无性能问题）→ `floorHitRefs`/`suppressPushHits`/`quietHitRefs` 写 `ruleIds`——单元测试 rule-version.unit.test.ts 覆盖，集成 proactive-mail-check.test.ts 断言 `quiet_hours@\d+`、`suppress_small_amount@3`、`floor_money_words@1`，且有 REVERSE 用例（规则不命中时 ruleIds 为空）会真失败。
3. 落库校验 `validateInputs`（sqlite-proactive-operations.ts:656-663）只要求字符串 1–256 且去重——`id@rev` 可接受；导出把 inputs 当不透明 JSON（data-export/schemas.ts:208 `{ type: "object" }`），可接受。
4. 读路径 `read` → `readRuleVersions` → `describeRuleVersion` → 网关契约（contracts-v2.ts 新字段齐全，`tests.failedAt` 用 `integer(1)`、快照经 `gatewayV2MessageSchema.parse`）→ 抽屉渲染（proactive-interactions 测试断言「测试：第 2 条例子不符」「查不到」等反向展示）。
- 无测试覆盖的路径：上述第 1 条（floorHitRefs 回退）；构造器 `assertRuleExamples`（proactive-mail-check-service.ts:522）只查 ownerRules，`ruleBookFor` 生成的例子若与 CEL 不符不会阻断检查，只在抽屉显示 failed——这是 Andy 选定的「当场实算」设计，不算缺陷。
- 文档一致性：写入约定文档和 ADR 0215 与代码逐条对上（包括「小额不推送内容显示查不到」「记忆候选 ruleIds 空数组」）；automatic-memory-service.ts:534 已把 ruleIds 固定为 `[]`，golden 测试反向断言所有 memory_candidate 的 ruleIds 为空。
- 未核实：en/ja 译文内容、迁移 0087 触发器 SQL 原文、未实际运行测试。

## 必答问题

1. **不会。** 本 PR 未改任何组装模型请求的代码（系统提示、工具定义、历史、遮盖均未动；diff 只涉及决策账本写入、读取和 UI）。`ruleIds`、`ruleHits`、`quietRefs` 都是写入 `decision_ledger.inputs` 的账本数据，不进模型请求；`npm run check:prompt-prefix` 的对象（runtime-pi）完全没碰。发给模型的内容仍然只追加、每轮变化值仍在最后一条消息。
2. **不会。** 新值全是账本/UI 侧：`ruleIds` 经 `.sort()` 固定顺序；例子生成只依赖存储的设置参数（Set/Map 遍历顺序由确定性输入决定）；静默命中按 `startedAt` 当场算出后存档，不复算。没有任何依赖前后文的遮盖、带时间字段或无序集合进入模型可见内容。
3. **有，且反向用例成立（从断言内容判断，未实际运行）。** `check:rule-registry`（package.json）已加入 rule-version.unit.test.ts 和 decision-chain.test.ts；反向包括：故意写错表达式断言 `failedAt: 1`、`assertRuleExamples` 抛「例子不符」、REVERSE 集成用例断言不命中时 `ruleIds` 为空、golden 断言 memory_candidate 全部空 ruleIds。解析边界（`x@01`、`a@b@x`、`@3`）也有断言。
4. **能接受。** 新值「id@revision」：产生端（`ruleRef`）与三个消费端全部核对——SQLite 校验（长度/去重 OK）、网关契约（`ruleId` ≤256、`revision` 可空非负整数）、读取端 `parseRuleRef`（含裸 id 兼容旧记录）；`mailCount` 按 parse 后的裸 id 统计，与条目 id 对上；`thisMail` 两侧都过 `displayRuleId`，对上。修订号 0 的两端语义一致（readSettings 兜底 ↔ defaultRuleParameters）。`sourceMemoryId` 走既有 `texts` 依赖，hidden/missing 有处理。唯一语义瑕疵是问题 2 里「这封邮件用到」标签不覆盖 suppress/quiet 命中（低，非校验失败）。
