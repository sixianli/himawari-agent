# 审核结论：线程的方案「通知闸门和金额字段」

## 证实的（按严重度从高到低）

### 1.【高】`defer_to_quiet_hours` 在 `#collect` 处没有落点，会丢通知或把决策表刷爆

**证据：**
- `web_push_outbox` 没有“不早于/ready_at”列，`#deliver` 用 `store.listDue({now})` 立即取所有未过期项（`packages/persistence-sqlite/src/migrations/0058_web_push.sql:22-32`、`apps/agent-service/src/production-web-push.ts:399`）。
- `#collect` 每 10 秒跑一次（`production-web-push.ts:17` `DEFAULT_INTERVAL_MS = 10_000`、`:220-223`）。reminder/approval/muse 类每轮都重新入选（`:297-304`、`:369-379`），run 类靠 cursor 每轮必然前进（`:380` `const next = cursor ? runs.at(-1)?.cursor : now`），**cursor 前进不取决于闸门结果**。
- 方案第 4 步只写了 “suppress 的不入队”，没写 defer 怎么办。如果 defer 也等于“现在不入队、下轮再问”：reminder/approval/muse 每 10 秒重判一次，`rule_decisions`（只追加表）一条夜里搁置 6 小时的提醒会写约 2160 行；**run 类被 defer 一次就永久丢失**（cursor 已走完）。如果 defer 等于“入队但延后发送”：outbox 根本没有这个字段。
- 另外 reminder 的 `expiresAt = remindAt + 6小时`（`:331`），静默 23:30–07:00 会把 23:30 的提醒 defer 到 07:00——早已过期，通知悄悄消失。

**建议：** 要么给 `web_push_outbox` 加 `not_before` 列并让 `listDue` 过滤、决策按 `(source_key, 规则 id, 版本, 结果)` 幂等（状态不变不重复记）；要么按我在最后的改法，把 suppress/defer 的判定放在推送**创建时**（每个对象只判一次），`#collect` 保持只做入队。

### 2.【高，I-73 同型】迁移第 9 步要改的列不存在

**证据：** 方案第 1、9 步说“迁移里改 `quiet_hours` 那行的 `gate` 值”。但 `rule_book_rules` 表**没有 gate 列**——只有 `rule_id/revision/parameters/status/source`（`packages/persistence-sqlite/src/migrations/0086_rule_book.sql:1-11`），gate 完全由代码按规则 id 决定（`packages/application/src/rules/rule-book.ts:240`、`field-catalog.ts:9`）。全 migrations 目录 grep `gate` 无一命中规则表。

**建议：** 改名只动代码（`field-catalog.ts`、`rule-book.ts`、`proactive-rules.ts:72`、`rule-expression.unit.test.ts`、`rule-registry.unit.test.ts`）和文档（`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:55` 也写着 `mail_delivery`，方案漏了这份 ADR 要同步改）。从迁移 0087 里删掉这一项。

### 3.【高，I-73 同型】金额的“产生端”到“使用端”管道没接上

**证据：** 方案把金额存进 `source_insights` 三列，但闸门在 `#collect` 里问，mail 类推送经 `ProactivePushSource.content()` 取内容，该端口只返回 `insightId/result/text/dueAt/more`（`production-web-push.ts:180-193`），实现在 `production-proactive.ts:93-114` 也没读金额列。`NotificationGate` 在 agent-service 里也拿不到规则手册（`ruleBookFor(settings)` 依赖主人设置，读库在 application 层）。方案没有写这两段怎么接。这正是 I-73 的教训：“双模型复核只看了改动，没问清单里的 id 能通过后端校验吗”——这里是没问“闸门评估时从哪里读到金额和规则”。

**建议：** 明确：`content()` 增加金额三个字段并在 `production-proactive.ts` 读出；`NotificationGate` 经 composition root 注入 `ProductionWebPush`，与 `listApprovals` 同一模式（`:162`）。

### 4.【中】`amount_confident`（布尔）没有对应的字段类型

**证据：** 字段类型只有 `"int" | "string" | "list<string>"`（`field-catalog.ts:1`）；`compileRuleExpression` 按这三类注册变量（`rule-expression.ts:39`）并在 evaluate 时按三类校验（`:140-152`）。布尔字段目前无法进规则表达式。

**建议：** `RuleFieldType` 增加 `"bool"`，evaluate 补 `typeof value === "boolean"` 校验；`rule-expression.unit.test.ts` 加对应正反用例。方案漏了这一步。

### 5.【中】缺失字段语义与取反、宏的交互没写清

**证据：** `evaluate` 现在对缺字段直接抛 `RuleExpressionError("type", ...)`（`rule-expression.ts:141-152`）。方案第 2 步的“引用了可缺失字段→不命中”需要静态遍历 AST 找出引用集合，必须覆盖 `!_`、`?:` 两支、`exists/all` 宏体（`assertAllowed` 的结构在 `rule-expression.ts:50-99`）。另外返回里的 `skipped: [规则 id]` 要排序，否则违反字节确定规则（`.claude/rules/prompt-prefix.md:51` 第 10 条的精神同样适用于决策记录的序列化）。

**建议：** 写明静态引用检测遍历全部节点；`skipped` 排序；并加一条反向用例——未实现缺失语义时，缺金额事实应当抛错（这条反向用例今天确实会失败）。

### 6.【低】验证手段的几个小问题

- “旧入队路径做参照”意味着在生产代码里保留一条旧路径只为对照——坏味道。仓库已有金样快照模式（`apps/agent-service/test/prompt-rendering-golden.unit.test.ts:220` 对 `mail.judgment` 存快照），照它做入队内容快照即可。
- 方案只提 AttentionPolicyService 的“夹具和测试同步改”，但改名 `mail_delivery` 影响 `rule-expression.unit.test.ts`、`rule-registry.unit.test.ts` 共 30+ 处和 ADR 0209 文字，没列。
- 方案没有为 `#collect` 闸门分支、`suppressed` 状态写入、`rule_decisions` 幂等安排生产集成测试（现有邮件链路集成测试在 `test/integration/proactive-mail-check.test.ts:418` 有 `listReadyPushes` 用例可扩展）。

### 核对方案作者的前提（全部属实）

- 前提 1–6、8 逐条核对无误：五类经 `#collect`（`:315-389`）且无静默判断；`#deliver` 只判过期/类别开关/主人在线（`:407-425`）；`AttentionPolicyService` 生产不用（仅 4 个测试文件）；`REMINDER_WINDOW_MS = 6h`（`:19`）；闸门与结果（`field-catalog.ts:9`、`rule-book.ts:4`）；`parseJudgements` 无金额字段（`proactive-mail-check-service.ts:461-499`）；rule 15（`prompt-prefix.md:67`）。
- **未核实：** Claude Doc 最终版 artifact（claude.ai 需登录，无法读取），第 6 步与该文档例子的差异只能由 Andy 定，方案自己也标了，合理。
- 金额按最小单位整存是业界成熟做法，与 Stripe 一致："All API requests expect `amount` values in the currency's minor unit……`10` to charge 10 JPY"（https://docs.stripe.com/currencies 、https://docs.stripe.com/api/charges/create "A positive integer representing how much to charge in the smallest currency unit"）。注意 Stripe 提醒 JPY 是 zero-decimal、ISK/UGX 等有特例——方案的 ISO 4217 小数位表要覆盖这些特例，别只记 JPY/CNY/USD/KWD 四个例子。

## 推测

- `rule_decisions` 若按方案逐条写，除刷行外还可能把“主人在线被 suppress（`#deliver:422-424`）”与“规则 suppress”混淆——方案没说 gate 决策与 deliver 层既有 suppressed 状态如何区分，推测会产生歧义记录。
- 邮件推送被 suppress 后，其 insights 仍 open、push=true；下次检查若 `pendingPush` 合并到同一 `readyAt` 的 pending 行（`proactive-mail-check-service.ts:1299`）逻辑不受影响（suppressed 行不会被复用），推测正确但方案没写这个推断，值得补一条测试。

## 侧重检查

我走的最普通流程：新邮件 → `ProactiveMailCheckService` 判断（`proactive-mail-check-service.ts:807` 起）→ `#finish` 算 `readyAt` 创建 push（`:1290-1300`）→ `listReadyPushes`（`sqlite-proactive-operations.ts:1156`）→ `ProductionWebPush.#collect` 入队（`:315-389`）→ `#deliver` 发送（`:397-428`）。

**没有测试覆盖、方案也没安排覆盖的路径：** ① `content()` 若加金额字段后的读出（`production-proactive.ts:93-114`）；② `#collect` 里的闸门分支（`:358-388`）；③ `markPushEnqueued` 对 `suppressed` 行的交互（`:1169-1179`）；④ `rule_decisions` 的写入频率与幂等。②③④是本方案的核心新路径，恰恰没有自动化检查。文档一致性：ADR 0209 写死了 `mail_delivery`，方案未列；`.claude/rules/prompt-prefix.md` 不受影响（推送管线不碰模型请求）。

## 如果由我来定，我会这样改

1. **判定点后移到“推送创建时”而不是 `#collect`。** 邮件推送本来就在 `#finish` 里创建（那里已有 `rules`、`settings`、`floorHits`）：金额三项在判断后直接可得，suppress 判定在这里做，`proactive_pushes` 直接记 `suppressed`，`#collect`、`content()` 端口、agent-service 侧全都不用动——第 3 条的管道问题整体消失。其余四类默认行为不变（与方案第 6 步一致）。
2. **defer 只保留邮件现有的 `readyAt` 机制**；主人“夜里别提醒我”这类规则，靠 `quiet_hours` 规则作用于邮件创建时刻实现。不要在 outbox 上新做 defer（问题 1）。
3. **gate 改名降级为代码内重命名**，不做迁移；同步 ADR 0209 文字。
4. 保留：金额字段设计与 Stripe 式最小单位（补 ISO 4217 特例币种）、缺失即照常推送的程序化语义、`rule_decisions` 只追加表（加幂等键）、迁移 0087 其余三项、删除 `AttentionPolicyService` 静默窗口。

## 必答问题

1. **不会改变模型已见过的请求开头。** 改动只涉及推送管线（不碰任何模型请求）和邮件判断这个后台调用的固定指令段。后台调用是无状态单轮、不留历史，追加到固定段末尾不违反只追加（规则 4 管的是已存历史）；组装顺序 `MAIL_JUDGMENT` → 记忆头 → 邮件数据 → `MAIL_JUDGMENT_NOW` 保持不变（`proactive-mail-check-service.ts:400-406`），每轮变的 `now/timeZone/today` 仍在最后。有金样测试守着（`prompt-rendering-golden.unit.test.ts:220`）。
2. **不会。** 提示词新增句是固定文字；金额换算按固定币种表、结果存整数列，不进提示词；闸门评估是本地计算。唯一注意点：`skipped` 和决策记录要排序后序列化（方案未写）。
3. **部分有。** 提示词改动有金样快照；迁移有现成契约测试模式（`rule-book-migration.contract.test.ts:116` 用 `foreign_key_check`）；方案列的反向用例里“缺失金额不抛错”今天确实会失败（`rule-expression.ts:141` 会 throw）。缺口：`#collect`/创建时闸门分支、`suppressed` 状态、决策幂等没有安排任何自动化检查。
4. **逐值核对：** gate 名——产生端 `field-catalog.ts:9`/`rule-book.ts:240`，使用端 `proactive-rules.ts:72`、两个规则测试文件、ADR 0209:55，无 UI/HTTP 合同引用（全仓 grep 证实），可接受但 ADR 要同步；`suppress_push`——目前没有任何按闸门校验 outcome 的机制，“目录写明允许结果”需落进 `assertRuleExamples`/编译期，否则只是文档；`source` 枚举——五类中 mail/muse_channel 与 reminder 共用 `kind: "reminder"`，映射要靠 sourceKey 前缀，方案未写；金额三列——产生端在判断服务，使用端缺管道（证实问题 3）；`suppressed` 状态——CHECK 约束重建方案已写，读端 `listReadyPushes`/`pendingPush` 只取 `'pending'`（`sqlite-proactive-operations.ts:1149,1162`），自然退出，两端一致。
