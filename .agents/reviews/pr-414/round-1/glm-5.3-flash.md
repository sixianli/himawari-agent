# 复核报告：硬规则第 4 步统一推送闸门（c685420）

## 发现（按严重度从高到低）

### 1. 高｜apps/agent-service/src/production-owner-rules.ts:54-79、docs/adr/0242-hard-rules-step4-unified-push-gate.md:53,96｜「一句话立规则」的词表根本没改，核心承诺不成立

作者说法：「production-owner-rules.ts 里“长期有效”判断词表加了“别提醒我”等说法」。**代码证实这是假的**：`STANDING_MARKERS`（54-79 行）只有“以后/一律/必须/每次/不要不再/always/never…”等，没有任何与“别提醒我”相关的词条；本次 diff 也没碰这个词表。

后果（读代码证实）：`#set` 里 `const explicit = !input.inferred && isStandingQuote(quote) && …`（678 行）——主人说“夜里别提醒我”，`isStandingQuote` 找不到任何 marker，走 695 行的 `status: "proposed"` 分支，只能变成待确认提议，不是“立成生效规则”。工具提示（packages/prompt-catalog/src/tools.ts:231）还把“夜里别提醒我”当作 `push_quiet_hours` 的示例，模型会照做，然后得到一个与承诺相反的“proposed”结果。

连带：ADR 0242 验证一节声称的 `test/integration/production-memory-capture.test.ts` 的 `[HR-4]`（“夜里别提醒我立成生效规则；今晚别提醒我不算长期有效”）**不存在**——全仓 grep “别提醒” 只命中 ADR、tools.ts、web-push 测试和 fixtures，production-memory-capture.test.ts 里没有任何 push_quiet 内容。

建议：把「别提醒我、不要提醒我、别打扰我」（含日文说法）加进 `STANDING_MARKERS`，并补上 ADR 声称的 rule_set 集成测试（含“今晚别提醒我”反向用例）。若有意不做，必须改 ADR 决定 5 和本说法，并接受“一句话”变成“一句话提议 + 一次确认”。

### 2. 中｜packages/persistence-sqlite/src/sqlite-web-push-operations.ts:405-442｜「出站表更新和决策记录同一事务写」不成立

作者说法与 ADR 决定 8（0242:56「和延后在同一个事务里写」）：`deferItem` 先 `UPDATE web_push_outbox`（405-417 行）再 `insertLedgerRow`（429-441 行），**两条独立语句，没有 `this.database.transaction()` 包裹**。调用链是 worker → `SqliteDurableOperations.execute`（sqlite-durable-operations.ts:527-536，只切 synchronous pragma，不开事务）→ `webPush.execute` → `deferItem`（sqlite-worker.ts:1109）。better-sqlite3 每条语句各自隐式提交。

后果（读代码证实）：两语句之间崩溃 → 出站表已延后但决策记录缺失；反过来 ledger 插入抛错（如 CHECK 失败）时 UPDATE 已提交，`deferItem` 整体抛错。此外这个抛错会沿 `#deferred` 的 `await store.deferItem(...)`（production-web-push.ts:480）直接传出——见第 3 条。

建议：把两条语句包进 `database.transaction(() => …).immediate()`，并把写库失败降级为「照发 + onGateFailure」，与 ADR 决定 7 的失败哲学一致。

### 3. 中｜apps/agent-service/src/production-web-push.ts:480-488｜延后写库没有兜底，会中断整批发送

闸门“规则读取或判断出错：推送照发”（说法与 ADR 决定 7）在 `#deferred` 里只覆盖了 `readPushRules`/`gate.decide`（try 块 457-467 行）。`store.deferItem` 的 await 在 try 之外：一旦写库抛错，异常传出 `#deliver` 的 for 循环，**本批剩余的推送条目这轮全部不处理**（下一 tick 重试，10 秒后，不丢但延迟）。与第 2 条叠加时，还可能留下“已延后但无决策记录”的状态。

证据：417-440 行循环内除 `#deferred` 外无 try；`tick()` 只有最外层 `onFailure`（246-251 行）。

建议：`#deferred` 里对 `store.deferItem` 单独 try/catch，失败时当作未延后继续走 visible/send 路径并告警；或与第 2 条一起用事务解决。

### 4. 中低｜docs/adr/0242…:97、packages/application/src/rules/rule-version.ts:137-155｜ADR 声称的另一条测试不存在，rule-version 新分支无测试

ADR 验证声称 `test/integration/data-export-rules.test.ts` 的 `[HR-4]`（导出导入往返）——不存在（该文件无任何 HR-4/push_quiet 内容）。`rule-version.ts` 新增的 `wording.quietHours` 重建分支（rebuild，137-155 行）在 `rule-version.unit.test.ts` 里没有任何 `push_quiet_hours` 用例（grep 证实），这条新代码路径完全无测试。

建议：补 rule-version 单测（push 规则重建出 quietHours 展示），补数据导出往返测试，或改 ADR。

### 5. 低｜apps/agent-service/src/production-web-push.ts:434-438｜闸门判定排在“主人在场抑制”之前，在场时也会写延后

顺序是：过期 → 类别关 → 内容过期 → `#deferred` → visible 抑制 → 发送。主人盯着屏幕且静默规则生效时，推送本会被“在场抑制”，却先被延后：多写一条决策记录（结果 deferred），且到静默结束若主人仍在场，最终是 suppressed 而非 delivered——“延后”承诺的交付没有兑现，记录却说是规则延后的。行为可辩护（规则优先于在场），但记录语义有偏差。建议确认这是有意行为；若否，把 `#deferred` 挪到 visible 检查之后。

### 6. 低｜packages/application/src/services/web-push-gate.ts:94-101、production-web-push.ts:458｜性能：逐分钟扫描 + 每 sourceKey 各读一次规则表

`decide` 对最多 1440 个分钟逐个调用 `RuleJudge.decide`（每分钟 × 每条规则一次表达式求值）；`#deferred` 对每个未缓存的 sourceKey 各自 `await readPushRules()`（一次 ownerRules().list 全量查询）。同一 tick 内有 gated 缓存，但跨 tick、跨 sourceKey 不缓存。当前量级（SEND_BATCH 条、10 秒一轮）可接受，标注为已知代价即可。

### 7. 核对无误的部分（读代码证实）

- 审批/Muse/unknown 由代码放行：`PUSH_RULE_PROTECTED_CLASSES` 在 `PushGate.decide`（web-push-gate.ts:81）和 `#deferred`（production-web-push.ts:452）双重拦截，反向测试存在且用伪造 expression 验证规则拦不住它们（rule-type-push-quiet-hours.unit.test.ts:79-87）。
- 延后目标 ≤24h（`PUSH_DEFER_CAP_MS`）、有效期延长 max(旧, until+1h)、总寿命 ≤48h（`PUSH_TOTAL_LIFE_MS`，min 截断）：与说法一致；总寿命截断导致“延后未到先过期”时走 expired 记录，不会静默吞掉。
- `listDue` 跳过未到点的延后行、`rule_book_rules` 三个触发器清空延后（迁移 0093）、撤销规则立即放出：集成测试覆盖（production-web-push.test.ts:617-633）。
- sendTest 不走闸门（production-web-push.ts:254-281，直接 sender.send）✓。
- 迁移 0093 重建八张表：数据原样回填、`decision_signals`/`decision_prereviews` 不许改触发器重建、外键检查，契约测试覆盖并有 web_push 只许 deferred 的反向 CHECK 用例。
- 决策记录不进每日打分/校准：`daily-review.ts` 跳过 web_push（352-353 行）+ 类型排除，`sqlite-decision-ledger-operations.ts:520` 统计查询排除 ✓。
- 闸门到期后不重复发送（attempt 去重、集成测试断言两台设备各一次）✓；跨午夜时段、夏令时、classes 默认（不含 scheduled_reminder）都有用例 ✓。
- prompt-manifest.json 的 `tools.rule-set` 哈希与 changedIn 已更新 ✓。

## 侧重检查

走通的流程：主人在对话里说「夜里别提醒我」→ 模型调用 `rule_set`（tools.ts 文案 + `ownerRuleToolDescriptors` 的 periods/classes schema，production-owner-rules.ts:181-206）→ `#set` → `#draft`（`writableRuleType` 注册校验）→ `isStandingQuote` 判定 → 激活或提议 → 写入 `rule_book_rules`（触发器清空既有延后）→ 下一轮 `tick` → `#collect` 入队 → `#deliver`/`listDue` → `readPushRules`（service-main.ts:2384-2396，只取 `gate === "push_delivery"` 且可执行的规则）→ `PushGate.decide` → `deferItem`（出站表 + 决策记录）→ 静默结束再判 → 发送到所有设备 → 决策链抽屉展示（production-decision-chain.ts:98,106-108）→ i18n 三语标签（en/ja/zh-CN 均已加）→ 数据导出文案（data-export/rules.ts:159-175）。

结论：闸门主干（入队→判定→延后→放出→去重→展示→导出）测试覆盖良好；**断点在最前端**——「一句话」识别（`isStandingQuote`）既缺代码又缺测试，整条“一句话立规则”流程没有任何自动化覆盖；尾端的 rule-version 展示、数据导出往返也无测试（ADR 却声称有）。deferItem 的部分失败路径（第 2、3 条）无测试。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 会改一处，且是合法的那一种：`rule_set` 工具的说明文字（prompt-catalog/src/tools.ts:231）和参数结构（production-owner-rules.ts:181-206 新增 periods/classes）都变了。按 prompt-prefix.md 第 6 条，参数结构变化属于“工具集合变了”，允许整对话换新一次并留记录——prompt-manifest.json 已记 `changedIn: "ADR 0242"`，主人已同意。除这一处外：没有改历史消息、没有改遮盖、没有把每轮会变的值塞进系统提示或工具定义。结论：合规的换新，不是静默改写。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会（读代码证实）。本次改动没有新增任何进模型请求的内容；落库的新值全部确定：`ruleRefs` 排序去重（sqlite-web-push-operations.ts:414）、`periods`/`classes` 解析时规范化排序（rule-types.ts parsePushQuiet）、决策记录 id 由固定输入哈希且 `ON CONFLICT DO NOTHING`（sqlite-decision-ledger-operations.ts:133）、延后时刻按分钟量化。无依赖前后文的遮盖改动。
3. **有没有对应的自动检查、反向用例会不会真失败？** 有且多为真反向：规则类型 6 组参数反向、闸门的破坏规则/不在 classes/审批保护反向、集成的无规则照发/审批不延/规则库故障告警反向、迁移契约的 CHECK 反向与触发器反向。这些用例依赖本次新代码，回退即失败。**缺口**：ADR 声称的 rule_set 一句话立规则测试和数据导出往返测试不存在（发现 1、4）；`npm run check` 结果未独立复跑（未核实，采信作者）。
4. **每个新值的两端校验都能接受吗？** 逐值核对：`defer_until`/`defer_rule_refs`（产生：deferItem + 0093 CHECK length=24/json array；消费：listDue 过滤、三个释放触发器、schema-catalog 描述）✓；`web_push`+`deferred`（产生：insertLedgerRow；消费：DECISION_OUTCOMES 端口校验、0093 CHECK、daily-review 排除、统计查询排除、decision-chain 读取、contracts-v2、data-export schema、三语 i18n）✓；`push_quiet_hours`（产生：rule-types 注册；消费：rule-version KINDS、OWNER_RULE_KINDS、data-export、contracts-v2、i18n、工具 schema 与解析器枚举一致——classes 上限 3、periods 上限 8、clock/星期格式两侧相同）✓；`push_delivery` gate（field-catalog、GATE_OUTCOMES、judge 过滤、service-main 过滤、owner-rules 的 trialsOf/#replay）✓。唯一两端不一致的是**声明层面**：“同一事务写”与实际两条隐式事务不符（发现 2）。
