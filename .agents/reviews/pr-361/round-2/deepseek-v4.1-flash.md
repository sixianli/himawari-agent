## 结论

照着改动和现有代码核对下来，核心行为等价的路线成立：模型请求没被动过，地板规则/静默判断的旧实现与新规则在实现层面对得上。主要风险不在“规则语言”本身，而在**运行时错误兜底**、**反向测试覆盖**和**未来修订/退役的遗留陷阱**。下面的“读代码证实”和“推测”分开列。

---

## 问题（按严重度从高到低）

### 1.【中｜推测】主人可控的发件人字符串直接拼进 CEL，编译失败没有兜底，且失败时不记费用

- 文件:行
  - `packages/application/src/rules/rule-book.ts:177-195`（`importantSenderExpression`）
  - `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:274-277`（只校验长度 1..254）
  - `packages/gateway-contracts/src/contracts-v2.ts:353-362`（发件人正则允许 `[^\s@]*`，孤立代理项可通过）
  - `packages/application/src/services/proactive-mail-check-service.ts:807-811`、`646-660`
  - `packages/application/src/services/proactive-overview.ts:124-125`

- 问题
  重要发件人只做 `trim().toLowerCase()` 后用 `JSON.stringify` 塞进 CEL 字符串字面量，没有拒绝“非 well-formed Unicode”。如果 cel-js 对孤立代理项（如 `"\ud800@example.com"`）或某些转义在解析时抛错，`ruleBookFor`/`compileRuleExpression` 会抛 `RuleExpressionError`；`proactive-mail-check-service` 只在 `#check` 外层释放 payload 后原样抛出（`646-660`），不会退化成“不命中”，也不会调用 `#finish`。结果是这一轮已花掉的模型费用不会写进 `decision_ledger`，下一次 tick 继续调用模型、继续失败，既让该主人的主动提醒整体不可用，又形成**不受每日费用上限约束的重复花费**。

- 证据
  ```ts
  // rule-book.ts:180-182
  .map((entry) => entry.trim().toLowerCase().replace(/^@/u, ""))
  .filter((entry) => entry.length > 0),
  ```
  ```ts
  // rule-book.ts:189
  if (addresses.length > 0) parts.push(`sender_address in ${celStringList(addresses)}`);
  ```
  ```ts
  // sqlite-proactive-operations.ts:274-277
  input.importantSenders.length > 200 ||
  input.importantSenders.some(
    (sender) => typeof sender !== "string" || sender.length < 1 || sender.length > 254,
  )
  ```
  Gateway 的发件人正则只排除空白和 `@`，不排除孤立代理项；写入存储后没有任何 Unicode 规范化。

- 建议
  在写设置或生成表达式前做 `String.prototype.isWellFormed` 检查（Node 22 支持），不接受非 well-formed 字符串；或者在 `floorHitIds`/`ruleBookFor` 调用点捕获 `RuleExpressionError`，按“该规则不命中”降级并记录一条 observation，至少不要破坏整轮检查的费用记录。

> 这一条依赖 cel-js 对 `\ud800` 等输入的实际处理；仓库里没有 `node_modules`，我无法读取该库或运行用例，所以标为推测。

### 2.【低｜证实】反向用例覆盖不全，ADR “改掉规则里一个词，对照测试就失败”不成立

- 文件:行
  - `packages/application/src/rules/rule-book.ts:67-77`（`MONEY_WORDS`）
  - `packages/application/src/rules/rule-book.ts:38-65`（`MONEY_SUBSTRINGS`）
  - `packages/application/src/rules/rule-book.ts:110-125`（公共机构后缀例子只有 `lg.jp`、`go.jp`）
  - `packages/application/test/rule-book-legacy-equivalence.unit.test.ts:43-58`（`ADDRESSES`）
  - `packages/application/test/rule-book-legacy-equivalence.unit.test.ts:72-112`（`FRAGMENTS`）

- 问题
  对新旧实现对照测试来说，参考实现是可靠的，但**输入语料没有覆盖全部词条**。`FRAGMENTS` 里没有 `收费、扣款、入账、付款、退款、缴费、汇款、转账、还款、請求、振り込み、入金、返金、料金、決済` 等词；删掉其中任意一个，2 万封随机邮件仍然全部通过。`ADDRESSES` 只有 `a@ed.jp.evil.com`（负例），没有 `a@ed.jp` 或 `*.ed.jp` 正例；内置规则例子也只有 `lg.jp`、`go.jp`。因此删掉 `ed.jp` 或某个中文金钱词，`check:rule-registry` 不会失败，与 ADR 0209 的“改掉规则里一个词，对照测试就失败”不符。

- 证据
  ```ts
  // rule-book-legacy-equivalence.unit.test.ts:43-58
  "a@go.jp",
  "a@ago.jp",
  "a@x.ac.jp",
  "a@ed.jp.evil.com",
  ```
  ```ts
  // rule-book-legacy-equivalence.unit.test.ts:72-101
  "Invoice", "billing", "bill", "charge", "charged", "receipt", "statement",
  "payment", "refund", "本月账单", "发票已开",
  // 没有 收费/扣款/入账/付款/退款/缴费/汇款/转账/还款/請求/料金/決済 等
  ```
  ```ts
  // rule-book.ts:120-125 公共机构例子
  senderFacts("a@city.tokyo.lg.jp", ...), senderFacts("a@go.jp", ...), ...
  ```

- 建议
  把 `MONEY_SUBSTRINGS`、`MONEY_WORDS`、`PUBLIC_DOMAIN_SUFFIXES` 做成表驱动测试：每个词条至少一个命中用例和一个不该命中的相似词；四个后缀每个都加正向地址。这样“删一个词”才真的会让门槛失败。

### 3.【低｜证实】`writeRule` 更新时不清 `status`，`readSettings` 只认 active；参数 JSON 也不校验形状

- 文件:行
  - `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:230-253`（`readSettings`）
  - `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:335-344`（`writeRule` 的 upsert）

- 问题
  `writeRule` 的 `ON CONFLICT` 只更新 `revision/parameters/source/updated_at`，没有把 `status` 写回 `active`；而 `readSettings` 只查 `status = 'active'`，查不到时回退默认静默时段。现在第 1 步没有退役路径，所以暂时不可达；但后续撤销/退役功能一旦使用 `retired`，主人再次保存设置会写出新参数、修订号也加，却仍然是 `retired`，读取端会静默忽略这次保存、退回默认值。另外 `readSettings` 对 `parameters` 只做 `JSON.parse(...) as {periods}`，不校验结构，遇到 `{}` 或旧格式会得到 `undefined` 并在 `quietHoursExpression(periods)` 读 `.length` 时抛错。

- 证据
  ```ts
  // sqlite-proactive-operations.ts:340-342
  ON CONFLICT (owner_id, agent_id, rule_id) DO UPDATE SET revision = excluded.revision,
    parameters = excluded.parameters, source = excluded.source,
    updated_at = excluded.updated_at
  ```
  ```ts
  // sqlite-proactive-operations.ts:233, 240-248
  WHERE owner_id = ? AND agent_id = ? AND status = 'active'
  ...
  quiet
    ? (JSON.parse(quiet.parameters) as { periods: ProactiveQuietPeriod[] }).periods
    : DEFAULT_QUIET_HOURS,
  ```

- 建议
  更新时显式 `status = 'active'`（或在退役状态下拒绝写入并报错）；读取 `parameters` 时用一个小校验函数检查 `periods`/`senders` 是数组、元素形状合法，不合法就当作损坏数据并按明确策略处理，而不是等到生成表达式时抛 TypeError。

### 4.【低｜证实】专用门槛 `check:rule-registry` 不包含迁移和 store 测试

- 文件:行
  - `package.json:27`（`check:steps` 引用 `check:rule-registry`）
  - `package.json:58`（`check:rule-registry` 只列了 3 个 unit 测试）
  - `packages/persistence-sqlite/test/rule-book-migration.contract.test.ts`
  - `test/integration/rule-book-store.test.ts`

- 问题
  ADR 把迁移 0086 列为本次最重要的数据动作之一，但本地 `npm run check` 的 `check:rule-registry` 只跑 `rule-registry`、`rule-expression`、`rule-book-legacy-equivalence` 三个 unit 文件；迁移契约测试和 store 写入/历史测试只通过 CI 的 contracts/integration 项目运行。本地门槛通过并不代表迁移和写入路径正确（这两处恰恰是本次新增风险最高的代码）。

- 证据
  ```json
  "check:rule-registry": "vitest run --config vitest.workspace.ts --project unit packages/application/test/rule-registry.unit.test.ts packages/application/test/rule-expression.unit.test.ts packages/application/test/rule-book-legacy-equivalence.unit.test.ts",
  ```
  迁移测试文件在 `packages/persistence-sqlite/test/*.contract.test.ts`（contracts 项目），store 测试在 `test/integration/rule-book-store.test.ts`（integration 项目），都不在 `check:rule-registry` 的文件列表里。

- 建议
  把 `rule-book-migration.contract.test.ts` 和 `rule-book-store.test.ts` 纳入专用门槛（或新增一个 `check:rule-book-store`）；如果刻意留给 CI coverage，就要在 ADR/注释里写清楚本地 `npm run check` 覆盖不到迁移与写入。

### 5.【低｜证实，文档】ADR 0147 仍把 `hitsFloor` 写成现存的实现

- 文件:行 `docs/adr/0147-keep-model-prompt-and-answer-of-each-gmail-check-with-the-ledger.md:43`
- 问题
  文档说地板规则短代码是 `proactive-rules.ts` 里集中定义的常量，并说 `hitsFloor` 的行为不变；实际改动删除了 `hitsFloor` 和 `PROACTIVE_PUBLIC_DOMAIN_SUFFIXES`，后缀/词表搬到了 `rules/rule-book.ts`，`proactive-rules.ts` 只保留 `FLOOR_RULE_IDS` 和 `floorHitIds`。这不影响运行，但和“说明文档和代码一致”的要求不符。
- 证据（读到的事实）：`proactive-rules.ts` 新代码里没有 `hitsFloor`；`rule-book.ts` 才有 `PUBLIC_DOMAIN_SUFFIXES`、`MONEY_SUBSTRINGS`、`MONEY_WORDS`。
- 建议
  给 ADR 0147 加一条“后续：实现已迁移到 rules/rule-book.ts，hitsFloor 已移除”的注记，或更新描述；ADR 0209 的 `supersedes` 也可以考虑按项目惯例标注“部分取代 ADR 0163 决定 4”。

---

## 侧重检查

**错误路径**
- `ruleBookFor` 在 `#checkTraced` 的模型调用之后执行（`proactive-mail-check-service.ts:807-811`），抛错会走 `#check` 的 `catch` 释放 payload 后重抛（`646-660`），不会写 decision，也就不会记费用；这是我列为问题 1 的主要依据。
- `readProactiveOverview` 没有 try/catch（`proactive-overview.ts:124-150`），同样会把编译错误直接抛到接口层。
- 迁移对已有数据库是“先要求同机验证过的快照，再执行”（`migration-engine.ts:851-857`、`928`），所以 0086 的删列/删表即使不可撤销，也有快照兜底；这一点没有问题。

**不合规范或不可信的输入**
- `quietHours`：Store 校验 `HH:MM`、`start !== end`、days 1..7 且不重复（`sqlite-proactive-operations.ts:261-279`）；Gateway 也校验最多 8 段（`contracts-v2.ts:343-352`）。这些输入不会破坏表达式生成。
- `importantSenders`：Gateway 最多 200 条、每条最多 320 字符（`contracts-v2.ts:353-362`），Store 最多 200 条、每条最多 254（`sqlite-proactive-operations.ts:274-277`）。**320 与 254 不一致是改动前就存在的**，不是本次引入；但从网关进来的 255–320 字符发件人会被 Store 拒绝，用户会看到保存失败。
- 表达式注入：`celString` 用 `JSON.stringify`，引号/反斜杠/控制字符会被转义；目前没有发现能跳出字符串字面量的输入。
- 孤立代理项问题见问题 1，未用真实 cel-js 验证。

**安全**
- 白名单确实拒绝了 `matches`、`int/double/string/bytes/dyn`、`has`、下标、字段访问、`* / %`，测试里的 `rejected(...)` 会真正抛错，反向用例有效。
- 白名单仍允许 `+`/`-` 和嵌套的 `exists`/`all`；`text_words.all(a, text_words.all(b, ...))` 的求值次数会随嵌套层数指数增长。ADR 已明确把求值次数上限留到第 4 步，而第 1 步表达式全部由代码生成、没有外部表达式入口，所以当前不可达；但第 4 步接入模型生成表达式前必须补上。

**资源耗尽**
- 最大设置 200 条 × 254 字符，最坏情况每个字符 JSON 转义成 6 字节（`\u00XX`），约 `200 × 254 × 6 ≈ 305k`，低于新的 `RULE_EXPRESSION_MAX_LENGTH = 524_288`（`rule-expression.ts:8`）；列表元素 200 < `maxListElements: 300`，14 个静默时段的 AST 远低于 `maxAstNodes: 2000`。这一项余量够。
- `RuleJudge` 的编译缓存上限 256 条；单实例一个主人，问题不大。

**不可撤销操作**
- 0086 删除 `proactive_settings.quiet_hours`/`important_senders` 并重建表，属于不可逆迁移；已有数据库必须先有验证快照（见上），测试也走同一条快照路径（`rule-book-migration.contract.test.ts:53-57`）。没有发现绕过快照的生产路径。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 这次改动没有改系统提示、工具定义或历史，也没有往模型请求里追加内容。主动邮件检查的模型判断发生在 `#judge`（`proactive-mail-check-service.ts:764-800`），而规则手册和地板规则是在判断之后才计算（`:807-811`），静默结束时间只影响 `push.readyAt` 和 verdict（`:906-911`、`:1292-1300`），不进入模型请求。因此“只追加、每轮会变的值只在最后一条消息”的既有安排没有被破坏。`check:prompt-prefix` 我没有运行（工具限制），但 diff 里没有任何 prompt/catalog 文件变更。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**没有发现。** 规则表达式生成是确定性的：`importantSenderExpression` 的 `Set` 保留输入顺序（来自数据库 JSON 数组的稳定顺序），`celIntList` 对 days 排序，静默时段保持存储顺序，表达式里没有时间/随机字段。`quietEnd` 虽然依赖当前时间，但结果只进推送时间与 verdict，不进模型请求，也不进历史。唯一需要留意的是数据库里重复/乱序的输入本身会生成不同字节，但那是“设置变了”，不是同一设置在每次请求间变化。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，但不完整。**
- 有：`check:rule-registry` 已加入 `check:steps`，包含表达式白名单拒绝、内置规则例子、2 万封随机邮件的新旧对照、三时区三周静默对照。白名单用例通过 `rejected()` 在“本该拒绝却没拒绝”时抛错；例子被改错或表达式换成 `false` 时 `assertRuleExamples` 会抛 `/例子不符/`。这些反向用例是真会失败的。
- 迁移契约测试和 store 写入/历史测试存在，但不在 `check:rule-registry` 里（见问题 4）。
- 覆盖缺口见问题 2：删掉部分中文金钱词或 `ed.jp` 时，现有反向用例不会失败，与 ADR 的说法不符。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对结果：
- **规则 id**：`floor_important_sender`、`floor_public_domain`、`floor_money_words`、`quiet_hours` 都 ≤ 64，满足 `rule_book_rules.rule_id CHECK (length BETWEEN 1 AND 64)`；前三个与 `DECISION_RULE_CATALOG` 一致；决策记录的 `ruleIds` 要求 1–256 字符，决策链网关 `ruleId: boundedString(256)`，都接受；`quiet_hours` 不进入 `floorHits`，只由 `readSettings` 内部识别，两端一致。
- **修订号**：DB `CHECK (revision >= 1)`，迁移写 1，`writeRule` 从 1 开始递增；只在没有规则时合成的 0 不会被写库；读取端没有拒绝 0 的校验。
- **parameters 形状**：迁移和 `writeRule` 都写 `{periods: [...]}` / `{senders: [...]}`，`readSettings` 按同样形状读，两端匹配；但读取端不校验形状（问题 3）。
- **source 长度**：迁移值 31 字符、`writeRule` 值 27/33 字符，满足 1–256；内置规则的 source 不入库。
- **迁移序号**：`migration-engine.ts:676-681` 的 86 与审计脚本 `workspace-lifecycle-audit.mjs` 的 `SUPPORTED_SCHEMA_MAX = 86`、各迁移测试的 `CURRENT_SCHEMA_SEQUENCE = 86` 一致。
- **配置键**：`check:rule-registry` 已同时出现在脚本定义和 `check:steps` 中。
- **跨层输入**：Gateway 的发件人最大 320、Store 最大 254 的差异是改动前就有的，不是这次新产生的；本次新规则生成以 Store 的 254 为上限，表达式长度按最坏转义计算仍低于 524,288。

**未核实**：由于不能运行测试/读取 `node_modules`，我没有执行 vitest、`npm run check`，也没有验证 cel-js 对孤立代理项和所有 `\uXXXX` 转义的真实行为；问题 1 的触发条件因此标为推测。
