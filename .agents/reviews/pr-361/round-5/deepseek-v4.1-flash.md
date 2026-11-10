# 复核结论

## 发现：读代码证实的

### 1. 中｜`packages/application/src/rules/rule-book.ts:91-93,106,131`
**问题：** 英文金钱词匹配与旧实现并非“逐字相同”。旧实现用 `\b...\b` 正则，新实现先把 `text` 切成 `[a-z0-9_]+`（`/giu`）再把 ſ/K 折叠成 s/k。`/iu` 会让 ſ/K 进入同一个词元，而旧正则的 `\b` 只把 ASCII 字母数字下划线当词字符。因此形如 `billſ`、`ſbill`、`statementK` 的文字旧实现会命中 `bill`/`statement`，新实现得到的词元是 `bills`/`sbill`/`statementk`，不会命中。ADR 0209 第 57 行写“结果逐字相同”，第 106 行写“唯一和旧实现不同的地方”是孤立代理项，这与代码不符。

**证据：**
- `rule-book.ts:106`：`(text.match(/[a-z0-9_]+/giu) ?? []).map(foldCase)`
- `rule-book.ts:91-92`：`word.replaceAll("\u017f", "s").replaceAll("\u212a", "k").toLowerCase()`
- 对照测试 oracle 仍是旧语义：`rule-book-legacy-equivalence.unit.test.ts:6-7` 的 `/\b(?:invoice|...|statement)\b/iu`
- `docs/adr/0209-...md:57` 写“结果逐字相同”，`:106` 写“唯一和旧实现不同的地方”
- 对照测试的语料只有 `ſtatement`、`ſtatements`、`Kill`（`:122-124`），没有“长 s / Kelvin 紧邻其他金钱词”的用例，所以测不出这个差异。

**建议：** 在应用代码里用旧正则直接算一个“命中英文金钱词”的事实，再由 CEL 读该事实；或按旧 `\b` 语义重写词元边界。至少把 `billſ`、`ſbill`、`statementK` 加入内置规则例子和 2 万封对照语料，并修正 ADR 的“唯一不同”说法。

### 2. 中｜`packages/gateway-contracts/src/contracts-v2.ts:347,353-366`；`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:267,278-285`
**问题：** 存储层和网关契约对“合法设置”的范围不一致，且这次迁移会把旧值原样搬进新表，新测试还明确期望保留网关不接受的发件人。
- 静默时段：存储允许最多 14 段，网关只允许 8 段。
- 发件人：存储只校验长度和孤立代理项，网关还要求 ASCII 地址/域名正则。
- 例如 `test/integration/rule-book-store.test.ts:109` 期望读回 `"会社.jp"`，但该值过不了 `contracts-v2.ts:362` 的 `^@?[^\s@]*@?[a-z0-9.-]+\.[a-z]{2,}$`。

结果：如果旧库里存在这种值（旧存储层本来也接受），`production-proactive.ts:369` 会把它放进 overview 快照，而控制中心在 `apps/control-center/src/gateway-client.ts:269` 用 `gatewayV2MessageSchema.parse` 解析，会失败，整页 overview 打不开。这个问题在改动前已存在，不是本 diff 引入，但迁移明确保留了它，且作者把 14 段称作“最大设置”，那只适用于存储，不适用于公开接口。

**证据：**
- `contracts-v2.ts:347`：`if (periods.length > 8) ...`
- `sqlite-proactive-operations.ts:267`：`input.quietHours.length > 14`
- `contracts-v2.ts:360-362`：长度、`\p{Surrogate}` 和 ASCII 正则
- `sqlite-proactive-operations.ts:279-285`：仅长度、代理项
- `test/integration/rule-book-store.test.ts:108-109` 期望 `importantSenders: ["bank.example", "会社.jp"]`
- `apps/control-center/src/gateway-client.ts:269`：`gatewayV2MessageSchema.parse(value)`

**建议：** 统一两端的发件人语法和时段上限；要么在存储写入/迁移读入时规范化或拒绝，要么放宽网关响应契约。补一条“旧值迁移后能通过 overview 快照契约”的端到端测试，并在 ADR 里把“最大设置”改成公开接口实际能接受的 8 段（或明确说明存储上限更宽）。

### 3. 低｜`packages/persistence-sqlite/src/migration-engine.ts:676-680`；`packages/persistence-sqlite/src/migrations/0086_rule_book.sql:54-67`
**问题：** 迁移 0086 实际是破坏性的收缩操作（重建 `proactive_settings`、删掉两列），却标成 `phase: "expand"`。项目文档要求破坏性 schema evolution 走 `expand → backfill → verify → contract`（`docs/architecture-v0.1.md:298`）。迁移后若只回退程序、不恢复数据库，旧代码会因为缺列而失败；可恢复性完全依赖迁移前快照和回退时的数据库恢复边界。

**证据：**
- `migration-engine.ts:679`：`phase: "expand" as const`
- `0086_rule_book.sql:65`：`DROP TABLE proactive_settings;`
- `0086_rule_book.sql:67`：`ALTER TABLE proactive_settings_next RENAME TO proactive_settings;`
- ADR 0209 也写明“`proactive_settings` 删掉 `quiet_hours` 和 `important_senders` 两列”

**建议：** 把该 change set 明确标成 `contract` 或拆成 expand/backfill/contract；如果确实只靠“迁移前快照 + 回退时恢复数据库”来承受不可逆性，请在 ADR/操作包里把这条回退边界写清楚，并确认回退脚本总是恢复数据库而不是只换程序。

### 4. 低｜`docs/product-vision.md:195`；`docs/adr/0184-back-off-ignored-proactive-pushes.md:38`
**问题：** 文档仍把重要发件人位置写成 `proactive_settings.important_senders`，而迁移 0086 已删除该列。属于说明文档和代码不一致。
**证据：** `product-vision.md:195`：“只有 Gmail 一刀的地板规则（`proactive_settings.important_senders`、...）是确定性的”；`0184:38`：“和 `proactive_settings.important_senders` 同级”。
**建议：** 更新为 `rule_book_rules`（规则 `floor_important_sender`），或在历史文档中加“迁移 0086 后位置已变”的注记。

### 5. 低（已文档化但仍会静默丢数据）｜`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:250-255`；`apps/agent-service/src/production-proactive.ts:284-285`
**问题：** 旧数据里含孤立代理项的重要发件人会在 `readSettings` 时被静默过滤；如果这次读取随后被用于“启用主动提醒”（production 的 read-modify-write），写回时会永久丢掉这些旧条目并增加修订号。ADR 已把这写成唯一差异，但“旧实现里它只能匹配同样带孤立代理项的发件人，实际等于不生效”并不严格成立：旧实现能匹配同样含该代理项的地址，只是现实中几乎不会出现。过滤本身没有告警或历史说明。
**证据：**
- `sqlite-proactive-operations.ts:252-254`：`.senders.filter((sender) => !/\p{Surrogate}/u.test(sender))`
- `production-proactive.ts:284-285`：`const settings = await store.readSettings(scope); await store.writeSettings({ ...scope, ...settings, enabled: true, now });`

**建议：** 迁移时统计并记录被丢弃的条目，或在所有者启用时给出可见提示；修正 ADR 里“实际等于不生效”的绝对说法。

---

## 推测 / 未核实

- **旧数据的静默时段格式异常可能从“永久不静默”变成抛错。** `quietPeriodExpression`（`rule-book.ts:217-225`）对 `clockMinutes()` 返回 `NaN` 的旧值会生成含 `NaN` 的表达式，而旧 `quietUntil` 会把这种值当作不静默。写入路径的 `CLOCK` 校验已存在，故只有更老版本或直接写库留下的数据可能触发；没有实际数据证据。
- **只删除 Agent 的历史清理路径没有测试。** 测试只覆盖删除 owner；按 SQLite 先删父行再执行级联的常规行为，删除 Agent 应同样可行，但未实际运行验证。
- **无法运行测试，也无法读 `node_modules` 里的 cel-js 源码。** 因此“102 条集成用例通过”、cel-js 的 whitelist AST 细节、官方一致性结论，均为未独立核实。

---

## 侧重检查

- **错误路径：** 检查了网关拒绝孤立代理项、存储写入校验、`readSettings` 过滤旧值、`writeRule` 事务、迁移触发器。主要问题是跨层校验不一致（发现 2）和旧值静默丢弃（发现 5）。
- **不合规范/不可信输入：** CEL 白名单拒绝 `matches`、类型转换、字段访问、下标、字典、乘除模；表达式有长度、节点数、深度、列表元素上限。当前规则表达式都由代码生成，没有外部表达式注入路径。迁移旧数据中的异常静默时段格式是唯一未证实风险。
- **安全：** 未发现新的 SQL 注入或越权路径；新依赖 `@marcbachmann/cel-js` 是单维护者、无依赖包，ADR 已记录供应链取舍，但不是代码缺陷。
- **资源耗尽：** 最大 200 发件人 × 254 字符、14 段静默时段都能编译；表达式长度上限 524288 足够（最坏转义约 30 万字符），AST 节点上限 2000 也够。`RuleJudge` 缓存上限 256 会整体清空，当前表达式规模下不会耗尽内存。ADR 已注明第 4 步引入自由表达式前要补求值次数上限。
- **不可撤销操作：** 迁移 0086 删除列/重建表，依赖快照和数据库恢复；标成 `expand` 与文档的阶段约定不符（发现 3）。
- **文档一致性：** 发现 1、3、4 都是文档与实际不一致。ADR 0209 的“唯一不同”说法需要修正。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本 diff 没有改系统提示、工具定义、历史消息、遮盖或提示词组装；`rules` 只在模型调用结束后的地板判断和推送时机里使用（`proactive-mail-check-service.ts:807-813,906-911`，以及 `#finish` 的 `:1292-1300`），命中的规则 id 只进决策账本，不进模型请求。因此发给模型的内容仍然只在末尾追加，每轮会变的值仍只在最后一条用户消息里；本改动没有引入新的每轮变化值到请求头。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会涉及模型请求。规则表达式本身会随发件人/时段的存储顺序生成不同字符串（`new Set`/数组顺序），但这是内部规则，不发给模型；表达式里没有当前时间之类字段，静默判断用的 `local_minutes` 等是每次检查的事实，不是请求内容。
3. **有没有对应的自动检查，反向用例会失败吗？** 有：`check:rule-registry` 跑了规则登记、表达式白名单/上限、旧新等价三组测试；迁移有触发表不可改/不可删、owner 级联删除、空数组和外键检查；存储有拒绝非法设置和修订号/历史用例。反向用例大体成立，但有盲点：等价语料没有覆盖发现 1 的 ſ/K 邻接情况；网关契约没有针对“旧值迁移后能过 overview 快照”的测试；只删 Agent 的级联没有测试。
4. **改动产生或修改的每个值，使用它的地方都能接受吗？** 逐项核对结果：
   - 规则 id：`RULE_IDS`、持久化里的字符串常量、迁移 SQL 字面量目前一致；DB 只校验 1–64 字符，账本 `ruleIds` 只校验 ≤256，`DECISION_RULE_CATALOG` 只登记三条地板规则。现在能接受，但持久化和应用各写一份常量，没有自动化互校，未来改名可能静默失配。
   - 修订号：DB `revision >= 1`，`readSettings` 未保存时给 0，`RuleRecord` 接受 number；两端一致。
   - `parameters`：写入是 `{periods}`/`{senders}`，迁移用 `json_object` 生成对象，读取按同样形状解析；合法旧数据能接受。
   - `source`/`status`：写入值满足 DB 的长度/枚举 CHECK。
   - 新增 `quietHoursRevision`/`importantSendersRevision`：只进入 `ProactiveSettings` 和 `ruleBookFor`；所有构造点已更新，网关不暴露也不需要暴露。
   - 网关契约与存储校验：**不完全一致**，见发现 2（8 段 vs 14 段、ASCII 发件人语法 vs 任意非代理项字符串）。
   - 迁移序列号 86、审计脚本 `SUPPORTED_SCHEMA_MAX = 86`、schema catalog、`check:rule-registry` 脚本项：目前一致。
