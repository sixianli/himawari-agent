# 复核结论

我先看了 `eb12828..1ded7ec` 的全量改动，再看了 `beac358..1ded7ec` 的第 3 轮增量，重点读了 `rule-book.ts`、`rule-expression.ts`、`rule-judge.ts`、`proactive-rules.ts`、`proactive-mail-check-service.ts`、`sqlite-proactive-operations.ts`、迁移 `0086`、网关合同和新增测试。下面按严重度排列。

---

## 问题（读代码核实的）

### 中：迁移后“从旧数据读回”的路径没有测试，规则 id 在三处各写一份，漂移时会静默回退默认值

**文件:行**
- `packages/persistence-sqlite/src/migrations/0086_rule_book.sql:36`、`:43`
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:56-57`、`:240-241`、`:247`
- `packages/application/src/rules/rule-book.ts:25-30`

**问题**
迁移 SQL 直接写死 `'quiet_hours'` / `'floor_important_sender'`；持久层又各自定义一份常量；`rule-book.ts` 里还有一份 `RULE_IDS`。三处当前值一致，但没有任何测试把“迁移写入”与“`readSettings` 读出”接起来验证。已有的 `rule-book-migration.contract.test.ts` 只检查 SQL 写进表里的行，`rule-book-store.test.ts` 是在**空库**上直接 `writeSettings`，都不是“迁移旧数据 → 应用读回”。一旦其中一份改名，`readSettings` 的 `.find` 找不到规则，就会走默认分支而不是报错：

```ts
const quiet = rules.find(({ ruleId }) => ruleId === QUIET_HOURS_RULE_ID);
...
quietHours: Object.freeze(
  quiet ? (JSON.parse(quiet.parameters) as {...}).periods : DEFAULT_QUIET_HOURS,
),
...
importantSenders: Object.freeze(senders ? ... : []),
```

后果是：旧安装的静默时段会悄悄变成 23:00–07:00、重要发件人悄悄变空，且没有任何测试失败。这正是 I-73 那类“产生方和消费方没有互相核对”的问题。

**建议**
1. 增加一条集成测试：在旧 schema 写入 `proactive_settings`（含空数组、重复项、非 ASCII），跑迁移，再调用 `SqliteProactiveOperations.readSettings`，断言读回的是原值而不是默认值。
2. 让持久层/迁移共用同一个 id 常量（例如从 `RULE_IDS` 派生 SQL 或用统一常量生成迁移测试里的期望），至少加一个测试断言 `QUIET_HOURS_RULE_ID === RULE_IDS.quietHours`、`IMPORTANT_SENDER_RULE_ID === RULE_IDS.importantSender`。
3. 建议把“规则行缺失”从“用默认值”改成显式失败或记录一次可观测事件，避免静默重置。

---

### 中：旧数据里的孤立代理项重要发件人会被静默丢弃，和“第 1 步不改变任何现有行为”的说明不一致

**文件:行**
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:250-255`
- `packages/application/src/rules/rule-book.ts:181`
- `docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:31`、`:56`

**问题**
读设置时过滤掉了含孤立代理项的条目：

```ts
importantSenders: Object.freeze(
  senders
    ? (JSON.parse(senders.parameters) as { senders: string[] }).senders.filter(
        (sender) => !/\p{Surrogate}/u.test(sender),
      )
    : [],
),
```

规则表达式生成时也再过滤一次（`rule-book.ts:181`）。旧实现 `isImportantSender`（基线 `eb12828` 的 `proactive-rules.ts`）没有任何这种过滤；旧网关正则里的本地部分 `[^\s@]*` 也允许孤立代理项，旧存储也只校验长度。因此对**已经存进去的旧数据**，这确实是一个行为变化：该发件人不再命中地面规则，并且从 overview 的 `importantSenders` 里消失。ADR 0209 第 31 行仍写“第 1 步不改变任何现有行为”，第 56 行写“迁入现有设置，不改行为”。提交信息里说了“读出时过滤旧值”，但 ADR 没同步。

新增的 2 万封对照测试的 `SENDERS` 列表（`rule-book-legacy-equivalence.unit.test.ts:62-74`）不含代理项，所以对照测试也覆盖不到这个差异。

**建议**
二选一，并写清楚：
- 如果这是有意的安全修复：在 ADR 0209 的“后果”里明确列出“旧数据中含孤立代理项的重要发件人会被丢弃”，并补一条迁移/读取测试（旧库写入含孤立代理项，迁移后 `readSettings` 不含它，且记录一次清理事件）。
- 如果坚持“不改行为”：不要在两处过滤，改为在写入层拒绝新值（现有网关和 `writeSettings` 已经拒绝），读取时保留旧值；`JSON.stringify` 会把孤立代理项转义成 `\ud800`，CEL 字面量可以承载，需补编译测试。

---

### 低：`writeRule` 更新时不管 `status`，未来“撤销/退休规则”会失效

**文件:行** `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:328-359`

**问题**
```ts
if (current && current.parameters === parameters) return;
...
ON CONFLICT (...) DO UPDATE SET revision = excluded.revision,
  parameters = excluded.parameters, source = excluded.source,
  updated_at = excluded.updated_at
```
`SELECT` 只取 `revision, parameters`，`ON CONFLICT` 也不写 `status`。如果将来第 4 步实现了“退休（retired）规则”，主人再改同一规则时：
- 参数不变：直接 `return`，规则仍是 `retired`，不会重新生效；
- 参数变了：参数更新了，但 `status` 仍是 `retired`，规则依然不生效。

本步没有退休入口，所以现在不会触发；但这是已经写进表结构的状态，属于后续步骤的隐患。

**建议** 在写路径明确语义：主人再次设置时把 `status` 设回 `active`（并在历史里记录状态变化），或者禁止对 `retired` 规则做隐式复用。

---

### 低：`readSettings` 把“规则缺失/被退休”当成默认静默时段，而不是“没有静默”

**文件:行** `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:240-247`

**问题**
静默规则被过滤掉（`status='active'` 才读）或行丢失时，直接回退到硬编码的 `DEFAULT_QUIET_HOURS`（23:00–07:00）。这和“主人取消了静默时段”不是一回事，会让系统重新开始静默。本步没有退休入口，这是潜在问题，和第 2 条、上一条一起构成“静默/名单悄悄变默认”的风险。

**建议** 区分“从未设置”（默认）与“规则缺失/退休”（应显式失败或视为无静默），并在错误路径记录可观测事件。

---

### 低：只验证了删 Owner 的级联，没验证删 Agent；读取过滤分支也没有直接测试

**文件:行**
- `packages/persistence-sqlite/test/rule-book-migration.contract.test.ts:147`（只测 `DELETE FROM owners`）
- `packages/persistence-sqlite/src/migrations/0086_rule_book.sql:28-31`
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:250-255`

**问题**
历史表的删除触发器条件是：

```sql
WHEN EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id)
  AND EXISTS (SELECT 1 FROM owners WHERE id = OLD.owner_id)
```

测试只覆盖“删 Owner”的成功级联，没有覆盖“只删 Agent”。按 SQLite 的级联顺序大概率也能成功，但这是**未核实**项，且触发器条件依赖“父行先被删”的实现细节。另外第 3 轮新增的读取过滤（`sqlite-proactive-operations.ts:250-255`）没有任何测试直接命中；现有 `rule-book-store.test.ts` 测的是写入拒绝，不是读取过滤。

**建议** 补两条测试：只删 Agent 时规则与历史一起级联；直接往 `rule_book_rules` 写一条含孤立代理项的参数后，`readSettings` 返回时已过滤。

---

### 低：历史只追加且无上限，删除重要发件人不会删除历史里的地址

**文件:行**
- `packages/persistence-sqlite/src/migrations/0086_rule_book.sql:25-31`（只禁止改/删）
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:353-359`（每次变更追加一行）

**问题**
这是设计目标（审计历史），但有两个需要明确的后果：
1. 主人从设置里删掉一个重要发件人后，旧地址仍永久保存在 `rule_book_history`，只有删掉整个 Agent/Owner 才会随级联删除；没有按规则清理历史的入口。这对“删除某人的重要标记”是一种未说明的数据保留。
2. 每次保存最多可追加约 50KB（200×254）的历史行，没有行数/字节上限；唯一约束是写入前的 `assertDiskHeadroom()`。属于低风险的自增长。

本步没有导出历史，也没有界面入口，因此影响面小；但建议在 ADR 里写明保留策略和删除语义。

**建议** 在 ADR/隐私说明里写清楚历史保留到 Agent 删除为止；或为第 4 步预留按规则清除历史的受控入口。

---

### 低：文档仍有指向旧列/旧实现的过时说法

**文件:行**
- `docs/product-vision.md:195` 仍写“`proactive_settings.important_senders`”
- `docs/adr/0184-back-off-ignored-proactive-pushes.md:38` 仍写“和 `proactive_settings.important_senders` 同级”

**问题**
本次改动把重要发件人移到了 `rule_book_rules`。改动更新了 inventory、ADR 0147/0163，但上面两处仍指旧表。ADR 是历史记录可以不改，但 `product-vision.md` 是对现状的描述，建议至少加一句“迁移 0086 后位于 `rule_book_rules`”。

另外 `docs/adr/0209` 第 31 行“第 1 步不改变任何现有行为”与孤立代理项过滤不一致（见上一条）。

---

### 低：最大设置测试写 14 个静默时段，但真实网关只允许 8 个

**文件:行**
- `packages/application/test/rule-registry.unit.test.ts:90-94`（14 个）
- `packages/gateway-contracts/src/contracts-v2.ts:347`（`> 8` 拒绝）
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:267`（存储层允许 14）

**问题**
测试标题是“largest settings the store accepts”，对存储层成立；但 ADR 0209 把它写成“最大设置（200 个发件人、每个 254 字符、14 个静默时段）”，通过真实 `proactive.settings.set` 命令最多只能到 8 个时段。这是既有的网关/存储上限不一致，不是本次引入，但会让人误判表达式长度和节点数的实际余量。

**建议** 统一为一处上限，或在 ADR 里注明“存储层 14、网关 8”，测试分别标明。

---

## 推测（未运行验证）

- `@marcbachmann/cel-js` 的 `Environment` 配置项 `unlistedVariablesAreDyn`、`homogeneousAggregateLiterals`、`limits` 名称与 8.0.0 的实际 API 是否完全一致，我只能从代码推断，仓库没有 `node_modules` 可读，未核实。
- `assertAllowed` 对宏 `rcall` 采用 `args.slice(1)` 跳过迭代变量，依赖 cel-js 的 AST 形状是 `[迭代变量, 表达式]`。新增的 `["x"].exists(v, text.matches("a"))` / `["x"].all(v, int(...))` 反向用例正是为此设计；如果测试真的运行并通过，说明形状正确。我没有运行测试，未核实。
- Agent-only 删除能否触发级联，未核实（见上面“低”条）。
- 生产打包脚本是否自动包含新增依赖，未核实。
- 作者说“现有 102 条邮件检查集成用例通过”，我没有运行，未核实。

---

## 侧重检查

我按“错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档一致性”逐项查了：

- **表达式白名单绕过**：读了 `rule-expression.ts:50-99`。`assertAllowed` 先于类型检查递归检查 `call`/`rcall`/列表/三元/逻辑/二元运算；`matches`、`int`、字段访问、下标、字典、乘除模不在白名单。宏的参数用 `args.slice(1)` 跳过迭代变量、仍检查表达式体，且有反向测试。**未发现绕过**。
- **资源耗尽**：`maxAstNodes=2000`、`maxDepth=24`、`maxListElements=300`、`maxCallArguments=4`，表达式长度 524288。本步表达式都由代码生成，实际最大约 200×254 ≈ 52KB，远低于上限。ADR 也明确记下“嵌套 exists/all 的求值次数”留到第 4 步。**本步未发现可达的资源耗尽路径**（历史增长见上面“低”条）。
- **注入**：发件人字符串经 `JSON.stringify` 进入 CEL 字面量；网关 `boundedString` 拒绝 `<0x20` 和 `0x7f`，正则拒绝空白和多余的 `@`；孤立代理项在三处被拒绝/过滤。最大设置测试覆盖了引号、反斜杠、控制字符、U+2028、emoji。**未发现字符串字面量逃逸**。
- **不可撤销/迁移**：迁移 `0086` 是“复制 → 建历史 → 删列重建”，数据本身不丢；但它是破坏性 schema 变更，迁移引擎会把 `minimum_writer_sequence` 提到 86，旧二进制会被栅栏拒绝，代码回滚需要数据库快照。这是仓库既有模式（0069 也是 expand 阶段删表重建），**不是本次独有缺陷**，但应在运维说明里写明回滚需快照。
- **历史不可变**：`rule_book_history` 只禁止 UPDATE/DELETE；删 Owner 的级联测试通过。删 Agent 未测。**结论见上面“低”条**。
- **非法/不可信输入**：存储层校验了长度、时钟格式、星期去重和代理项；但存储层不校验网关正则（比网关宽松，方向安全）。`parameters` JSON 没有长度上限，属直接改库才可达的低风险。
- **文档与代码一致性**：ADR 0209 的“不改行为”与孤立代理项过滤不一致；`product-vision.md` / ADR 0184 仍指旧列；14 vs 8 时段上限不一致。其余 ADR/inventory/package 脚本基本一致（`check:audit-schema-range` 的 `SUPPORTED_SCHEMA_MAX` 已同步为 86）。
- **模型前缀**：见必答问题 1，未发现改动。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 依据 `.claude/rules/prompt-prefix.md` 第 27–29、35 条（固定在前、会变的在后、已发内容只追加）。

读代码核实：`proactivePrompt`（`proactive-mail-check-service.ts:370-407`）的组装顺序仍是：

```ts
MAIL_JUDGMENT.text,
...记忆,
MAIL_JUDGMENT_ITEMS_HEADER.text,
JSON.stringify(items...),
renderPrompt(MAIL_JUDGMENT_NOW, { now, timeZone, today }),
```

本改动没有改这个函数，也没有把 `rules` 放进提示词。`#finish` 新增的 `rules` 只用于第 1292 行的 `quietEnd`，没有进入 `store.record` 的 `inputs`，也没有进入 `trace.payloads`。系统提示、工具定义、历史、遮盖（`#reportMasked`）都未改。每轮会变的 `now`、`timeZone`、`today` 仍然只在最后一段；本轮数据和记忆在它前面追加。**发给模型的内容仍然只在末尾追加。**

### 2. 同一段文字会不会在不同请求里变成不同字节？

**对发给模型的内容：不会。** 本改动没有生成任何新的模型字节，规则、修订号、历史都不进提示词。

对规则手册/数据库：
- 规则表达式由 `importantSenderExpression` / `quietHoursExpression` 从设置确定性生成；星期用 `celIntList` 显式排序，`Set` 保留插入顺序，同一个存储数组每次生成相同字符串。
- 但表达式对**输入顺序敏感**：同一组发件人以不同顺序提交，`JSON.stringify({senders})` 不同，会被 `writeRule` 当成值变化而增加修订号并写历史（`sqlite-proactive-operations.ts:341`）。这不影响模型字节，也不影响匹配结果，只是历史会多一条“仅顺序不同”的版本。若希望“集合语义不变就不加修订”，需要先规范化排序再去重。
- 静默时段在写入时把 `days` 排序（`sqlite-proactive-operations.ts:305`），表达式也再排序，确定。
- 迁移历史里的 `changed_at`/`updated_at` 是时间值，属于合理的审计字段，不参与模型请求。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，而且大多数反向用例是有效的：
- `check:rule-registry` 已加进 `check:steps`（`package.json:27`、`:58`）。
- 白名单反向清单包含 `matches`、`int()`、`double()`、`bytes()`、`dyn()`、`has`、`* / %`、下标、字典，以及宏体内的 `matches`/`int`（`rule-expression.unit.test.ts:55-76`）。
- 长度/节点/列表上限有反向用例（`:108-116`）。
- 例子被改错、表达式换 `false`、换 `matches` 都会抛错（`rule-registry.unit.test.ts:59-76`）。
- 新旧对照覆盖 2 万封随机邮件、三个时区三周、每 29 分钟一个时刻；改掉词表里出现在语料中的词会失败。
- 迁移测试反向验证了 revision=0、`parameters` 非对象、历史 UPDATE/DELETE 被拒、删 Owner 级联。

**缺口**（属于上面的“中/低”问题）：
- 没有“迁移旧数据 → `readSettings` 读回”的测试，规则 id 漂移不会被发现。
- 没有“旧数据含孤立代理项 → 读取过滤”的测试；对照语料也不含代理项。
- 没有“只删 Agent”的级联测试。
- `assertRuleExamples` 只在测试里调用，不在运行时启动校验；“坏规则不能生效”靠 CI，不靠生产启动。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对如下（读代码确认）：
- **规则 id**：`rule-book.ts:25-30` 产生；`DECISION_RULE_CATALOG`/`FLOOR_RULE_IDS` 使用；决策写入只要求 ≤256 的唯一字符串（`sqlite-proactive-operations.ts:643-649`），未知 id 在 `production-decision-chain.ts:106-112` 会以 `origin/document=null` 安全显示。**接受。** 但迁移 SQL、持久层常量、`RULE_IDS` 三处重复，见“中”条。
- **revision**：`writeRule` 产生，`ruleBookFor` 用到 `RuleHit.revision`；但 `floorHitIds` 把它丢掉，决策记录只存 id。ADR 0209 明确说修订号留到第 2 步。**当前没有写入决策，符合 ADR，但不属于“现有行为保持不变”之外的新值消费。**
- **`parameters` JSON**：迁移和 `writeRule` 产生 `{periods:[...]}` / `{senders:[...]}`；`readSettings` 按同名键读取。**两端匹配。**
- **`proactive_settings` 列**：迁移后只剩 `owner_id, agent_id, enabled, updated_at`；`sqlite-observation-operations.ts:240` 只读 `enabled`，仍存在；迁移测试检查了列集合。**接受。**
- **`ProactiveSettings` 新增修订号**：`ruleBookFor` 和测试是唯一消费者；TypeScript 会拦缺少字段的构造。`production-proactive.ts:284-285` 用 `{...settings}` 转写也不需要额外字段。**接受。**
- **`floorHitIds` 签名**：所有调用点（`proactive-mail-check-service.ts:811`、`proactive-overview.ts:150`、对照测试）都已改为传 `rules`；`hitsFloor`/`isImportantSender`/`PROACTIVE_PUBLIC_DOMAIN_SUFFIXES` 无代码消费者残留（grep 只剩文档）。**接受。**
- **网关发件人校验**：新增 `length > 254` 和 `Surrogate`，与存储层 `writeSettings` 的两项校验一致；正则比存储层更严，方向安全。**接受。**
- **迁移范围/审计脚本**：`SUPPORTED_SCHEMA_MAX = 86` 与迁移目录最大编号一致，`check:audit-schema-range` 会继续守住。**接受。**
- **数据导出**：新表未加入导出，但 `proactive_settings` 本来也不在导出里，ADR 0209 已把“第 5 步导出规则手册”列为后续。**不算回归，但需要记住。**

---

**总体判断**：核心等价实现和表达式白名单本身没有发现高危问题；主要风险在“迁移写入 → 应用读取”的未测衔接、孤立代理项导致的行为变化与 ADR 说法不一致，以及未来退休/撤销语义。建议先补迁移读取测试和文档说明，再合并。
