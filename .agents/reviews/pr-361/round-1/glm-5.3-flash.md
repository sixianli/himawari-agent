# 复核报告：规则手册第 1 步（eb12828 → ca8e497）

## 发现的问题（按严重度从高到低）

### 1.【中】写设置时不做表达式编译预检，极端设置能让之后的每次邮件检查永久失败

- **文件:行**：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:274-277`（校验只查条数和长度）、`packages/application/src/rules/rule-expression.ts:8,51-53`（`RULE_EXPRESSION_MAX_LENGTH = 262_144`，超长抛错）、`packages/application/src/rules/rule-judge.ts:31-36`（判定时才编译）、`packages/application/src/services/proactive-rules.ts:55-62`（`floorHitIds` 直接让异常冒出）。
- **证据（读代码证实）**：持久层只校验 `importantSenders.length > 200 || sender.length < 1 || sender.length > 254`；网关契约 `contracts-v2.ts:353-361` 只查条数 ≤200、长度 ≤320、正则 `/^@?[^\s@]*@?[a-z0-9.-]+\.[a-z]{2,}$/i`（控制字符允许出现在 local part，如 `\u0001` 不是空白）。而表达式由 `celString`（`JSON.stringify`，`rule-book.ts:66-67`）生成：254 个 `\u0001` 会展开成约 1526 字节，200 条 ≈ 305 KB，超过 262_144 上限。编译只发生在 `RuleJudge#compile`，即每次 `floorHitIds`/`quietEnd` 调用时——`check()` 主循环里没有 catch，整次检查会以异常告终，且每次重试都如此。测试里"最大设置"场景（`rule-registry.unit.test.ts:72-104`）用的是混合字符，没有覆盖全控制字符的最坏情况。
- **建议**：在 `writeSettings` 事务内对生成的两条规则各调一次 `compileRuleExpression`（或直接调 `ruleBookFor` + 编译），编译不过就整体拒绝、保持规则手册原样；同时给 `rule-expression.unit.test.ts` 补一个“200 条全 `\u0001` 发件人”的反向用例。

### 2.【低】金钱词新旧实现存在一类真实分歧：金钱词紧邻一个大小写折叠到 s/k 的非 ASCII 字母时，旧实现命中、新实现漏判

- **文件:行**：旧 `LEGACY_MONEY_WORDS`（`test/rule-book-legacy-equivalence.unit.test.ts:6-7`，`\b...\b/iu`）对 `test/rule-book.ts` 的新实现：`mailItemFacts`（`rule-book.ts:96-110`）的 `[a-z0-9_]+/giu` 切词 + `foldCase`（`rule-book.ts:89-91`）。
- **证据（读代码证实 + 语义推理）**：JS 的 `\b`/`\w` 是 ASCII 词边界，不受 `iu` 折叠影响；而 Unicode 模式下 `[a-z]` 会匹配 ſ（U+017F 折叠为 s）和 K（U+212A 折叠为 k）。于是 `ſbill`、`statementſ` 这类输入：旧正则里 ſ/K 不是词字符，`\bbill\b` 成立 → 命中；新实现把它们切进同一个词（`ſbill`→`sbill`、`statementſ`→`statements`）→ 不命中。等价测试的片段表（`rule-book-legacy-equivalence.unit.test.ts:103-106`）覆盖了 `ſtatement`、`Kill`、`İnvoice`，但恰好没有覆盖“折叠字符与 ASCII 字母相邻”的组合。作者在“请重点看”里问“任何邮件文字……结果会不同吗”——答案是有这一类，尽管现实中几乎不可能出现。
- **建议**：要么把这两个折叠字符加入片段表并在文档里明记这个已知分歧，要么切词后先按字符折叠再重组。

### 3.【低】裁判对 `start == end` 的静默时段判为“全天静默”，与 `quietUntil` 语义相反；目前只靠写路径校验挡住

- **文件:行**：`packages/application/src/rules/rule-book.ts:198-206`（`quietPeriodExpression`：`start < stop` 否则一律走跨夜分支，`start == stop` 时该分支恒真）；`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:268` 和 `packages/gateway-contracts/src/contracts-v2.ts:348-349` 都拒绝 `start === end`。
- **证据（读代码证实）**：`quietUntil`（`proactive-rules.ts:208-221`）对 `start == stop` 三个分支都不成立 → 永不静默；裁判则恒判静默。当前两层校验 + `quietEnd` 里 `quietUntil` 兜底（`proactive-rules.ts:80-81`）使最终行为一致（裁判说静默但 `quietUntil` 返回 null → 不延后），且迁移来源表 0062 的 CHECK 也由同一套写路径保证。但 ADR 0209 明说第 2 步要“把两份静默时段的实现合成一份”，这个分叉是届时最容易被踩的坑。
- **建议**：在 `quietPeriodExpression` 对 `start === stop` 显式返回 `false` 并加一条单元测试，把语义钉死。

### 4.【信息】作者说法的两处小出入/未核实项

- “最大设置 14 个静默时段”是持久层上限（`sqlite-proactive-operations.ts:263`）；网关契约限制是 8 个（`contracts-v2.ts:347`），发件人长度网关 320、持久层 254。两个口径都真实存在，但作者只提了 14，没提网关的 8。
- “102 条邮件检查集成用例通过”“cel-js 与 CEL 规范的偏差清单”——**未核实**（我无法运行测试、无网络）。
- 其余说法逐条对上了：迁移 0086 内容、`ProactiveSettings` 两个修订号、历史表只追加触发器、`check:rule-registry` 挂进 `check:steps`（`package.json:27,58`）、审计脚本 85→86（`workspace-lifecycle-audit.mjs:5`）且 `check:audit-schema-range` 会自动比对迁移序号。

## 侧重检查

我走的流程（普通使用流程，从入口走到结束）：

1. **主人在设置页改静默时段/发件人** → 网关契约校验（`contracts-v2.ts:330-363`）→ `production-proactive.ts:437-447` 归一化（trim/小写/去 `@`/去重，与 `importantSenderExpression` 的归一化一致）→ `store.writeSettings`（持久层校验 + 事务内 `writeRule` 修订号 +1、写历史）→ 集成测试 `rule-book-store.test.ts` 覆盖（含“无效设置整体回滚”反向用例）。
2. **首次连接 Gmail** → `production-proactive.ts:283-286` 用 `readSettings` 的结果回写 `writeSettings(enabled:true)`——这一步会把缺省静默时段/空名单固化成 revision 1 并写历史。行为与旧实现等价（旧实现同样回写这两列），但这是“只连接、没改过设置”也会产生历史记录的路径，**未见专项测试覆盖**。
3. **一次邮件检查** → `readSettings`（读 `rule_book_rules`）→ `ruleBookFor` → 逐封 `floorHitIds` → 模型判定 → `applyFloor` → `#persist` 里 `quietEnd` → 推送 `readyAt`。`proactivePrompt`（`proactive-mail-check-service.ts:370-407`）只由提示词目录、邮件 JSON、召回记忆、now/timeZone 组成，**不含设置、规则、floorHits**；本次 diff 没有触碰任何提示词文件。等价性由 `rule-book-legacy-equivalence.unit.test.ts` 守着。
4. **概览页重算 floor**（`proactive-overview.ts:122-155`）→ 与检查路径共用 `floorHitIds`，有既有测试。

结论：核心流程的测试覆盖是完整的；未覆盖的路径是上面问题 1 的超长表达式路径和第 2 步连接固化的路径。文档（`agent-rulebook-inventory.md` H-1~H-3、H-8、C-5、结论 4/5；ADR 0209）与代码一致，没有发现文档说 A、代码做 B 的情况。

## 必答问题逐条回答

1. **会不会改变模型已见过的请求开头？** 不会。改动只涉及模型判定之后的程序规则（`floorHitIds`、`quietEnd`）；`proactivePrompt` 的组成未变，diff 未触碰任何提示词、工具定义文件；`ProactiveSettings` 新增的两个修订号只在程序内部流转，不进模型输入；遮盖路径（`#reportMasked`）未改。每轮变的值（now/timeZone）仍在提示词末尾的 `MAIL_JUDGMENT_NOW`（`proactive-mail-check-service.ts:405`）。作者说法属实。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。规则表达式由设置参数确定性生成（去重用 `Set` 但保持插入序、days 排序、`celIntList` 排序）；裁判缓存按“闸门+表达式”取键，跨主人共享不泄漏；判定记录里的 `ruleIds` 做了排序（`proactive-mail-check-service.ts:1343`）。唯一的时间依赖（`quietEnd`）只影响推送时刻，不进模型请求。
3. **有没有对应的自动检查、反向用例会不会真的失败？** 有：`check:rule-registry` 已加入 `check:steps`，跑三个测试文件；白名单拒绝用例逐一断言 `reason === "not_allowed"`（`rule-expression.unit.test.ts:55-74`），例子被改错/表达式被换掉会抛错（`rule-registry.unit.test.ts:59-70`），迁移触发器的 UPDATE/DELETE 会 abort（`rule-book-migration.contract.test.ts:152-161`），无效设置回滚（`rule-book-store.test.ts:130-154`）。反向用例都是真断言，会失败。缺口：问题 1 的超长表达式没有反向用例；等价测试的输入生成器覆盖不到问题 2 的分歧。
4. **每个新值的两端核对**：`quietHoursRevision`/`importantSendersRevision` 产生于 `readSettings`（`sqlite-proactive-operations.ts:249,253`）、唯一消费方是 `ruleBookFor` → 裁判输出（下游决策记录暂未消费，ADR 已声明留到第 2 步）；规则 id 产生于迁移 0086 和 `writeRule`、消费于 `readSettings` 的查找，表 CHECK（长度 1-64、revision ≥1）与两端一致，且有契约测试；`ProactiveSettings` 加必填字段后，唯一的端口实现和 `durable-adapters.ts:972-1002` 的透传包装都兼容；历史表触发器允许随 owner/agent 删除级联清掉、有测试。**唯一的两端缺口是问题 1**：写端校验（条数/长度）和读端校验（表达式编译上限）各自都合理，但组合起来能通过写端却过不了读端，这正是 I-73 型事故的形状。
