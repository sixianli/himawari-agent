# 复核结论

未发现会改变模型已见请求开头、或改变发给模型内容字节的改动。规则迁移与新表的主体逻辑和作者说法基本一致；问题集中在 **写入端允许的设置与规则表达式/编译上限之间不一致**、**“最大设置”测试实际没有测到 200 个不同发件人**，以及几处未来状态语义和文档陈旧。

以下未运行任何测试：当前环境没有 `node_modules`，工具也只允许读文件和 git 查询。测试相关结论均来自读断言和检查配置。

---

## 发现（读代码证实，按严重度）

### 1. 中低：`writeSettings` 可以存下“生成的 CEL 表达式超过编译上限”的发件人，之后每次提醒检查都会抛错

- 文件位置：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:274-278`、`packages/application/src/rules/rule-book.ts:79-84,177-194`、`packages/application/src/rules/rule-expression.ts:10`
- 问题：存储端只校验发件人长度 1–254、数量 ≤200，不校验生成的表达式长度；生成表达式时 `JSON.stringify` 会把控制字符扩成 `\uXXXX`（6 字节/字符）。200 个各 254 个控制字符的发件人可生成约 30 万字节的表达式，超过 `RULE_EXPRESSION_MAX_LENGTH = 262_144`，`floorHitIds`/`quietEnd` 会在 `compileRuleExpression` 直接抛 `RuleExpressionError`。
- 证据：
  - `sqlite-proactive-operations.ts:274-278`：`input.importantSenders.length > 200 || input.importantSenders.some((sender) => typeof sender !== "string" || sender.length < 1 || sender.length > 254)`
  - `rule-book.ts:79-84`：`celString` 只是 `JSON.stringify(value)`；`celStringList` 直接拼接。
  - `rule-book.ts:177-194`：`importantSenderExpression` 把最多 200 条发件人拼成一个列表/一个 `exists`。
  - `rule-expression.ts:10`：`export const RULE_EXPRESSION_MAX_LENGTH = 262_144;`
- 可达性：当前正常入口被网关正则挡住——`packages/gateway-contracts/src/contracts-v2.ts:355-359` 只允许 `@?[^\s@]*@?[a-z0-9.-]+\.[a-z]{2,}`，控制字符/反斜杠/引号进不来，所以**当前 UI 路径不可达**；但 `ProactiveStorePort.writeSettings` 本身、迁移复制来的旧数据和以后直接调用端口的路径可以。属于 I-73 同类：“写入端接受，消费端不接受”。
- 建议：在 `writeSettings` 事务前用 `ruleBookFor(...)` + `compileRuleExpression` 验证将要生成的规则；不合规就直接拒绝保存（不要等下一次检查才失败）。或至少给生成表达式长度加与 `RULE_EXPRESSION_MAX_LENGTH` 一致的上限校验，并补一条 200 个“254 个 `\u0001`”的存储级用例。

### 2. 低：名为“最大设置”的测试实际上只测了 1 个发件人

- 文件位置：`packages/application/test/rule-registry.unit.test.ts:72-76`、`packages/application/src/rules/rule-book.ts:178-184`
- 问题：`tricky.repeat(40)` 长度已经超过 254，`${...}${index}` 的序号在 `slice(0, 254)` 时被截掉，200 个字符串完全相同；`importantSenderExpression` 用 `new Set(...)` 去重后只剩 1 条。因此该用例没有验证“200 个不同发件人”的表达式长度、AST 节点数和编译上限。
- 证据：
  - 测试：`` `${tricky.repeat(40)}${index}`.slice(0, 254) ``
  - 实现：`...new Set(senders.map(...))`
- 建议：把序号放在前缀，或使用短前缀；并断言表达式确实包含 200 个不同条目（例如检查 `celStringList` 长度/条目数，或断言 `decide` 对每个发件人都命中）。同时按发现 1 补控制字符膨胀的最坏情况。

### 3. 低（既有问题，本改动未引入）：重要发件人长度前端允许 320，存储只接受 254

- 文件位置：`packages/gateway-contracts/src/contracts-v2.ts:355-359`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:274-277`
- 问题：网关 `boundedString(320)` + 正则允许 255–320 字符的地址/域名，存储端 `length > 254` 会拒绝，用户会先通过请求校验、再在保存时收到失败。和 I-73 的“清单值过不了后端校验”是同一类，但这是改动前就存在的约束不一致；这次把发件人搬进 `rule_book_rules` 没有修正它。
- 证据：`array(boundedString(320))` 与 `sender.length > 254`。
- 建议：两端统一成同一个上限（若 254 来自 RFC 邮箱上限，就把合约也改成 254；若显示需要 320，就放宽存储）。

### 4. 低：文档里仍有把重要发件人指向 `proactive_settings.important_senders` 的现行描述

- 文件位置：`docs/product-vision.md:195`、`docs/adr/0184-back-off-ignored-proactive-pushes.md:38`
- 问题：代码已把重要发件人搬到 `rule_book_rules`（迁移 `0086_rule_book.sql:40-46`，读取 `sqlite-proactive-operations.ts:240-253`），这两处仍把 `proactive_settings.important_senders` 写成当前存储位置。ADR 0163 正文里的旧描述属于历史记录可以保留，但愿景和 ADR 0184 的“同级”说法会让后续排查找错表。
- 建议：更新为 `rule_book_rules`（规则 `floor_important_sender`），或在句子里标明“迁移 0086 之前”。

---

## 推测 / 未核实

### 5. 低（未来风险）：白名单只限制了 AST/深度/列表长度，没有看到求值迭代预算

- 文件位置：`packages/application/src/rules/rule-expression.ts:26-41,87-95`；字段目录里的 `text_words` 在 `packages/application/src/rules/field-catalog.ts:31-35`
- 说明：`ALLOWED_FUNCTIONS` 允许 `exists`/`all`，限制只有 `maxAstNodes`、`maxDepth`、`maxListElements` 等解析期上限。嵌套 `text_words.all(a, text_words.all(b, ...))` 在求值期可能按 `|text_words|^深度` 增长。当前所有表达式都由内置规则或设置派生，深度很浅，**现在不可利用**；但 ADR 第 4 步计划让模型把自然语言翻译成表达式，到时应补求值迭代预算或禁止嵌套宏。
- 未核实：本机没有 `node_modules`，无法确认 cel-js 是否在求值期另有迭代上限。

### 6. 低（潜在状态不一致）：`writeRule` 更新时不会把 `status` 设回 `active`，历史却固定写 `active`

- 文件位置：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:335-351`
- 说明：`ON CONFLICT ... DO UPDATE SET revision, parameters, source, updated_at` 没有 `status = 'active'`，而历史插入写死 `'active'`。目前没有任何 retire 路径，问题不可达；但将来做“停用/恢复规则”时，会出现当前行仍是 `retired`、历史却记成 `active`。另外 `readSettings` 只查 `status='active'`（`sqlite-proactive-operations.ts:230-234`），若 `quiet_hours` 被 retired/缺失，会静默回退到默认 23:00–07:00，而不是“没有静默时段”。建议未来加状态切换时一并处理，或现在就把 `status = 'active'` 加进 upsert。

### 7. 低（测试组合缺口）：没有“迁移后的数据 → readSettings → ruleBookFor”的端到端断言

- 说明：`rule-book-migration.contract.test.ts` 验证了迁移生成的 `parameters` 形状；`rule-book-store.test.ts` 在空库上验证了读写。两者都通过时组合路径大概率正确，但没有一条测试直接对迁移后的库调用 `readSettings` 并检查静默/发件人行为。另：迁移测试只删了 owner（`:147-159`），没有只删 Agent；同形状的 `decision_signals` 测试有覆盖（`test/integration/decision-signals.test.ts:386-387`），所以不判缺陷，但迁移测试本身没覆盖这一点。

---

## 侧重检查

我按“错误路径、不可信输入、安全、资源、不可撤销操作、文档一致性”逐项核对：

- **不可撤销的迁移**：`0086_rule_book.sql:33-52` 先复制旧设置并写历史，`:62-67` 再删表重建；旧列无其他读者（全仓库 grep `quiet_hours|important_senders` 只剩迁移测试和本迁移）；迁移序号 86 已同步到 `migration-engine.ts`、`migration-engine.contract.test.ts`、`model-budget-migration.contract.test.ts`、`scripts/operations/workspace-lifecycle-audit.mjs`。未发现遗漏的硬编码 85。
- **级联与历史不可删**：`rule_book_history` 的 `no_delete` 触发器和 `decision_signals` 等既有表用同一模式（`0086_rule_book.sql:28-31` 对照 `0080_decision_signals.sql:24-28`）；迁移测试实际删 owner 后断言规则和历史归零。`clearRecords` 不会清规则历史，符合 ADR“随 Agent/主人一起删除”的意图。
- **不合规输入**：`writeSettings` 在事务前校验 enabled、时段数量/格式/days、发件人数量/长度；`rule-book-store.test.ts:130-153` 验证失败后规则和历史保持原样。表达式里的发件人值都进 JSON 字符串字面量，没有直接拼表达式语法，未发现 CEL 注入；`matches`、类型转换、下标、字典、字段访问都在白名单外。
- **资源耗尽**：当前由网关可达的最大设置（200×254 ASCII）约 5.2 万字符，低于 262144；AST 节点/列表元素上限也够。控制字符经端口可把表达式推到 30 万字符（发现 1）。`RuleJudge` 缓存最多 256 条表达式（`rule-judge.ts:16,33-41`），长期大量改设置时最多占用约十几到几十 MB，未发现无界增长。
- **错误路径**：生成规则若因库中数据损坏而编译失败，会抛 `RuleExpressionError` 而不是静默当作“不命中”；目前所有正常写入路径都会先把数据校验成合法格式，只有直接改库/异常旧数据会触发。
- **文档一致性**：`docs/agent-rulebook-inventory.md` 的 H-1/H-2/H-3/H-8/C-5 已同步到新表与新函数；ADR 0209 与代码主体一致。仍陈旧的是发现 4 中的两处旧表名，以及 `docs/adr/0147...:43` 仍把已删除的 `isImportantSender`/`hitsFloor` 写成现行 API（历史 ADR，影响较低）。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加、每轮会变的值都在最后一条消息里？

**不会。** 这次 diff 没有改任何提示词、工具定义、历史组装或模型请求文件；`git diff` 里没有 `prompt-catalog`、Pi 适配器、模型代理相关文件。规则只进入过滤器/裁判和决策记录：
- `proactive-mail-check-service.ts:1288-1301` 只把 `rules` 用于 `quietEnd`；
- `:1342-1356` 写入决策记录的 `inputs` 不含 `rules`；
- 邮件检查的模型输入仍是原来的邮件数据和每轮值，未追加规则手册内容。
因此“只追加、变值在最后一条消息”的约束未被触碰。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会影响发给模型的内容。** 本改动没有把新值送进模型请求，且规则生成本身是确定的：
- 静默时段的 days 在 `rule-book.ts:225-227` 排序后拼接；
- 发件人用 `new Set` 去重并保持输入顺序（`rule-book.ts:178-184`），相同输入产生相同表达式；
- 表达式不含时间/随机量；`updated_at`/`changed_at` 只进数据库，不进提示词。
唯一可注意的是：同一组发件人如果顺序不同，生成的表达式字符串会不同；但它既不落库也不发给模型，目前不构成字节不确定。若将来把表达式持久化/发给模型，应先对条目排序。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，而且在 CI 中会被执行：
- `package.json` 新增 `check:rule-registry`，运行 `rule-registry`、`rule-expression`、`rule-book-legacy-equivalence`；`check:steps` 包含它，CI 的 `static` 步骤执行 `npm run check`（`scripts/ci/run.mjs:243-244`）。
- 迁移契约测试 `packages/**/*.contract.test.ts` 会进入 CI `contracts` 项目；`test/integration/rule-book-store.test.ts` 会进入 `integration` 项目；`ci/policy.json` 的 `coverage` 项目包含这两个 project，所以不是只有本地才跑。
- 反向用例从断言看是真实会失败的：改错例子/换成 `matches` 会抛（`rule-registry.unit.test.ts:59-65`）；白名单用例逐条期望 `not_allowed`（`rule-expression.unit.test.ts:48-70`）；删历史/改历史/非法 revision/非对象 parameters 会触发数据库错误（`rule-book-migration.contract.test.ts:128-146`）；非法设置保存会整体回滚（`rule-book-store.test.ts:130-153`）。
- 但有两个实测缺口：发现 1 的最坏表达式没有用例；发现 2 的“最大设置”用例因去重实际只测 1 条。另有发现 7 的迁移→读取组合缺口。**我没有实际运行这些测试，无法确认“全部通过”。**

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对：
- **规则 id**：`RULE_IDS` 在 `rule-book.ts:28-32`，与 `FLOOR_RULE_IDS`/`DECISION_RULE_CATALOG`（`proactive-rules.ts:18-47`）以及持久化的 `QUIET_HOURS_RULE_ID`/`IMPORTANT_SENDER_RULE_ID`（`sqlite-proactive-operations.ts:56-57`）字符串一致；长度 11–21，满足 `rule_book_rules.rule_id` 的 1–64（`0086_rule_book.sql:4,16`）。
- **修订号**：存储行 revision ≥1 满足 CHECK（`:5,17`）；未保存过时 `readSettings` 返回 0（`:249,253`），这个 0 只存在内存里的 `RuleRecord`/`RuleHit`，不写回数据库，所以不会被 CHECK 拒绝。将来若把 revision 写进决策记录，需要允许 0 或改成“首次保存才生成规则”。
- **parameters**：迁移写 `{"periods":...}`/`{"senders":...}`（`0086_rule_book.sql:36,44`），`writeRule` 写同样形状（`sqlite-proactive-operations.ts:292-308`），`readSettings` 按这两个键读（`:240-253`）；约束只要求 JSON object（`0086_rule_book.sql:6,18`），两端匹配。
- **source**：`"owner setting: ..."`、`"migrated from proactive_settings"` 均满足 1–256（`:8,20`）。
- **status**：只写 `'active'`，满足 `('active','retired')`（`:7,19`）；`readSettings` 只读 active。
- **决策记录里的规则 id**：`inputs.floorHits` 的值经过 `floorHitIds` 产生，随后由 `validateInputs` 按“1–256 字符、去重、≤16 条”校验（`sqlite-proactive-operations.ts:642-660`），当前最多 3 条、长度远小于上限，能通过。
- **迁移序号 86**：`migration-engine.ts` 新增 86，测试常量、`LATEST_MIGRATION_SEQUENCE` 和审计脚本 `SUPPORTED_SCHEMA_MAX` 都已更新；未发现仍要求 85 的消费者。
- 唯一两端不一致的是 **生成表达式长度**（发现 1）和 **发件人 254/320 的既有长度差异**（发现 3）；其余新值均能通过当前使用方的校验。
