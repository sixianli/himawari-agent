## 读代码证实的问题

### 1. 中：新增的“孤立代理项”校验没有同步到网关契约，I-73 同类
- **文件:行**：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:274-281`；`packages/gateway-contracts/src/contracts-v2.ts:353-362`
- **问题**：存储层新增了 `/\p{Surrogate}/u.test(sender)` 拒绝，但网关契约仍用原来的正则，本地部分 `[^\s@]*` 会接受孤立代理项；所以 `\ud800@example.com` 能通过 `proactive.settings.set` 的契约校验，到存储层才报 `Proactive settings are invalid`。新加的反向测试 `test/integration/rule-book-store.test.ts:82-94` 直接调存储，没有走网关，测不出两端不一致。
- **证据**：
  - 存储：`typeof sender !== "string" || sender.length < 1 || sender.length > 254 || /\p{Surrogate}/u.test(sender)`
  - 契约：`const senders = array(boundedString(320)).parse(input, path);`，以及 `senders.some((sender) => !/^@?[^\s@]*@?[a-z0-9.-]+\.[a-z]{2,}$/i.test(sender))`
  - 另外契约允许 320 字符、存储只允许 254；这条是既有不一致，不是本次引入，但同一条保存路径会先过契约、后失败。
- **建议**：把代理项检查和 254 长度上限移到 `proactiveSendersSchema`，或在网关层显式复用存储的校验；补一条从 `proactive.settings.set` 走到底的契约/集成用例，确保“契约接受的值存储一定接受”。

### 2. 低-中：迁移原样复制旧发件人，新增写校验会拒绝迁移后的旧值
- **文件:行**：`packages/persistence-sqlite/src/migrations/0086_rule_book.sql:40-48`；`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:224-255`；`apps/agent-service/src/production-proactive.ts:283-286`；`packages/application/src/rules/rule-book.ts:181`
- **问题**：旧存储只校验字符串和长度，历史上可能存有含孤立代理项的发件人。迁移把它们原样写入 `rule_book_rules`，`readSettings` 原样返回；但新增的 `writeSettings` 会拒绝这些值。于是这类旧实例在连接 Gmail（`connectGmail` 会把读到的设置原样写回）或保存设置时会失败；而规则表达式侧又会静默过滤掉该条目，表现为“设置里有、实际不生效”。
- **证据**：
  - 迁移：`SELECT owner_id, agent_id, 'floor_important_sender', 1, json_object('senders', json(important_senders)), ... FROM proactive_settings;`
  - 读回：`importantSenders: Object.freeze(senders ? (JSON.parse(senders.parameters) as { senders: string[] }).senders : [])`
  - 回写：`const settings = await store.readSettings(scope); await store.writeSettings({ ...scope, ...settings, enabled: true, now });`
  - 表达式过滤：`.filter((entry) => !/\p{Surrogate}/u.test(entry))`
- **建议**：迁移时清洗/剔除并记录被剔除项，或让读路径过滤这些值并为过滤留下审计；或者允许“未变化”的旧值写回。补一条“旧库含孤立代理项 → 迁移 → `connectGmail`/`writeSettings`”的测试。

### 3. 低：规则历史没有单条删除或清空路径，误填的地址会长期保留
- **文件:行**：`packages/persistence-sqlite/src/migrations/0086_rule_book.sql:28-32`；`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:536-548`
- **问题**：`rule_book_history` 只允许随 Agent/主人级联删除，`clearRecords` 的删除表清单不含它。重要发件人一旦保存过再删掉，旧地址仍永久留在历史表，直到删除整个 Agent。这是有意设计，但用户没有单条擦除路径，也没有保留期限，属于新的隐私/不可撤销面。
- **证据**：
  - 触发器：`CREATE TRIGGER rule_book_history_no_delete BEFORE DELETE ON rule_book_history ... RAISE(ABORT, 'RULE_BOOK_HISTORY_IMMUTABLE')`
  - 清空记录：`for (const table of ["source_insights", "proactive_processed_messages", "proactive_pushes", "proactive_push_backoff"]) ...`
- **建议**：在 ADR/界面写明历史的保留与擦除边界；若产品承诺可删除个人数据，补按规则/按时间清理或“删除这条历史”的受控路径。

### 4. 低：文档仍指向已被迁移 0086 删除的列
- **文件:行**：`docs/product-vision.md:195`；`docs/adr/0184-back-off-ignored-proactive-pushes.md:38`
- **问题**：两份文档仍说重要发件人存在 `proactive_settings.important_senders`，而 0086 已删除该列。ADR 0147 已经被作者加注，这两处没有。
- **证据**：
  - `只有 Gmail 一刀的地板规则（\`proactive_settings.important_senders\`、\`source_insights.floor_raised\`）是确定性的`
  - `域名明文存放，和 \`proactive_settings.important_senders\` 同级`
- **建议**：像 ADR 0147 那样加一句“0086 起改为 `rule_book_rules`”，不要改写历史结论本身。

### 5. 低：新增代码的缩进和同文件既有格式不一致，可能让 `format:check` 失败
- **文件:行**：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:276-281`
- **问题**：同一个文件的箭头函数体，`sqlite-proactive-operations.ts:671-674` 用的是 10 空格缩进，新加的代理项代码用了 12 空格。`biome.json:14-18` 是 space、默认 2 空格缩进，`npm run check` 的第一步就是 `format:check`。我没有运行格式化工具，但按同文件既有格式和 Biome 默认规则，这里很可能会被改写。
- **证据**：
  - 新代码：`(sender) =>` 后接 `            typeof sender !== "string" ||`（12 空格）
  - 同文件：`(payload) =>` 后接 `          !["model_input", "model_output"].includes(payload.role) ||`（10 空格）
- **建议**：跑 `npm run format` 后重新提交；顺手检查重复的 `rule-book.js` import 是否被 lint 规则拦。

## 推测 / 未核实

### 6. 中（未核实）：CEL 白名单对 `exists`/`all` 谓词的递归只取了 `args.slice(1)`，缺少反向用例
- **文件:行**：`packages/application/src/rules/rule-expression.ts:87-94`；`packages/application/test/rule-expression.unit.test.ts:55-74`
- **问题**：白名单依赖 cel-js 宏 AST 的 `args` 第 0 项是迭代变量、后面是谓词。如果 `@marcbachmann/cel-js` 8.0.0 的宏 AST 实际只把谓词放在 `args` 里，`args.slice(1)` 会跳过谓词检查，`["a"].exists(x, text.matches("(a+)+$"))` 这类表达式可能绕过白名单。现有拒绝清单只测了顶层的 `matches`、`int()`、`double()` 等，没有测“包在 `exists`/`all` 里”的情况。仓库没有安装 `node_modules`，我无法读 cel-js 源码确认 AST 形状。
- **证据**：
  - `const macro = name === "exists" || name === "all"; for (const argument of macro ? args.slice(1) : args) assertAllowed(argument);`
  - 测试只列了 `["mail_item", 'text.matches("(a+)+$")']`，没有嵌套宏用例。
- **建议**：先加两组必须被拒的测试：`["x"].exists(v, text.matches("a"))` 和 `["x"].all(v, int(local_minutes) > 0)`；如果测试通过不了，改成遍历宏的全部参数或显式区分迭代变量，并重新核对 cel-js 的 AST。

### 7. 低（未核实）：求值步数没有上限，FAQ 只靠“当前表达式都由代码生成”
- **文件:行**：`packages/application/src/rules/rule-expression.ts:28-37`；`packages/application/src/rules/rule-judge.ts:15-41`
- **问题**：环境只限制了 AST 节点数、深度和列表长度，没有限制运行时求值次数。`text_words.all(a, text_words.all(b, ...))` 这类嵌套宏的求值次数会随嵌套增长。当前 `RuleBook` 的表达式都由代码生成、嵌套很浅，所以没有现实入口；ADR 0209 也把这点留到第 4 步。另一个资源边界是全局编译缓存最多 256 条，每条表达式最大可接近 512 KiB，最坏情况下内存占用可观，但当前最大生成表达式约 30 万字符，且只有实例主人能改设置。
- **建议**：第 4 步开放用户表达式之前，加求值步数/宏嵌套上限；如果不想等，至少把缓存改成按 owner/agent 或按轮次持有，避免跨实例长期累积。

### 8. 低（未核实）：历史表的 Agent 删除路径没有直接用例
- **文件:行**：`packages/persistence-sqlite/test/rule-book-migration.contract.test.ts:147-165`
- **问题**：迁移契约测试只删了 owner，验证历史随 owner 清掉；没有直接 `DELETE FROM agents` 的用例。`observation_events` 等同形状触发器在 `test/integration/ledger-observation-store.test.ts:378-382` 有 Agent/账号两种用例，说明模式大概率可用，但新表本身没有被直接覆盖。
- **建议**：给 `rule_book_history` 补一个 Agent 删除的用例，和 owner 删除并列。

## 侧重检查

- **错误路径 / 不可信输入**：
  - 已看空数组、重复条目、`updated_at`、外键、owner 删除、Agent 删除（Agent 删除仅有同模式旁证，未直接测）。
  - 已看旧数据里的孤立代理项：迁移不清洗，新增写校验会拒绝，见问题 2。
  - 已看最长设置：200 个发件人 × 254 字符、14 个静默时段；按代码估算生成表达式约 30 万字符，低于 524,288，测试也覆盖了这个上限。
  - 已看邮件正文：`gmail-source.ts:208-209` 把 subject/snippet 各截到 500，`mailItemFacts` 的正则和 token 数组不会因不可信邮件长度失控。
- **安全**：
  - 发件人字符串通过 `JSON.stringify` 进入 CEL 字符串字面量，未见引号/反斜杠注入；CEL 表达式本身当前不由用户直接输入。
  - 顶层 `matches`、类型转换、字段访问、下标、字典、乘除模均在白名单外；但宏谓词的递归检查存在未核实点，见问题 6。
  - CEL 表达式长度、AST 节点数、深度、列表元素数都有上限；运行时求值次数没有上限，见问题 7。
- **资源耗尽**：
  - 主要风险是编译缓存中的大表达式和未来嵌套宏求值；当前表达式由代码生成，规模和嵌套可控。
  - `RuleJudge` 缓存有 256 条上限，但会在达到上限时整体清空，不会无限增长。
- **不可撤销操作**：
  - 规则历史只追加，删除触发器会在 owner/agent 仍存在时拒绝删除；owner 删除已有测试，Agent 删除只有同模式旁证。
  - `clearRecords` 不清理规则历史；误填的地址没有单条擦除路径，见问题 3。
  - 迁移 0086 在 `expand` 阶段完成复制后直接 `DROP TABLE proactive_settings`，是破坏性变更。迁移引擎会强制 pre-migration snapshot，但 `phase` 本身只用于同一 changeSet 内的顺序校验；设计文档要求“破坏性演进用 expand/backfill/verify/contract、不可逆迁移在执行前单独显示”，这份迁移没有在 ADR 里单独标注不可逆。这是流程/文档一致性问题，未发现代码阻止它上线。
- **规则文件、说明文档和代码一致性**：
  - `docs/agent-rulebook-inventory.md`、ADR 0147、ADR 0209、`schema-catalog.ts`、审计脚本 `SUPPORTED_SCHEMA_MAX=86` 与代码基本一致。
  - `docs/product-vision.md` 和 ADR 0184 仍引用已删除的 `proactive_settings.important_senders`，见问题 4。
  - ADR 0209 说“本步不改变任何现有行为”，对普通输入成立；对历史数据里的孤立代理项不成立（写回会失败、规则会忽略），见问题 2。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

不会改变模型请求开头。改动没有改系统提示、工具定义、历史消息或遮盖；新增的 `ruleBookFor` 和 `floorHitIds` 都在模型调用之后使用（`proactive-mail-check-service.ts:807-811`），规则、命中结果只进入 `#finish` 的决策记录输入和 `quietEnd` 的推送时间判断（`:1342-1356`、`:1291-1297`），没有进入 `proactivePrompt`。因此仍满足“只追加”，本轮会变的值没有新增到请求开头；当前会变的值仍只在最后一条消息/本轮数据位置。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**

不会影响模型请求的字节。规则表达式不进入模型请求；表达式本身由设置确定生成，没有时间字段，静默时段的天数会排序。唯一可提的是：`importantSenderExpression` 保持发件人列表的输入顺序（用 `Set` 只去重），同一集合换顺序会生成不同的表达式字符串；但目前这个字符串既不发给模型，也不存进数据库，所以不构成当前问题。以后如果把它持久化/展示，需要先排序。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

有：`package.json` 的 `check:rule-registry` 运行 `rule-registry.unit.test.ts`、`rule-expression.unit.test.ts`、`rule-book-legacy-equivalence.unit.test.ts`；另有 `rule-book-migration.contract.test.ts`、`test/integration/rule-book-store.test.ts`。反向用例包括：改错示例必须失败、`sender_domain.matches("x")` 必须被拒、白名单外函数/运算必须被拒、事实缺失或类型不对必须抛错、超长/超 AST 限制必须被拒、非法设置必须整体回滚、历史 UPDATE/DELETE 必须被拒、非法 revision/parameters 必须被拒。这些用例从逻辑上看是有效的；我**没有运行测试**，所以不能确认实际全绿。

仍有覆盖缺口：
- 没有“`exists`/`all` 谓词里包 `matches`/`int`”的反向用例，见问题 6。
- 没有“网关契约接受的值能否通过存储校验”的反向用例，见问题 1。
- 没有“旧库含孤立代理项 → 迁移 → 连接/保存设置”的用例，见问题 2。
- 没有直接删 Agent 清空 `rule_book_history` 的用例，见问题 8。
- `rule-book-legacy-equivalence` 用固定 FRAGMENTS 语料；删掉或改掉现有词会失败，但如果只在代码里“新增”一个语料里没有的词，随机对照不会覆盖到它。

**4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？**

已逐个核对：
- **规则 id**：`RULE_IDS.importantSender = "floor_important_sender"`、`RULE_IDS.quietHours = "quiet_hours"`，与持久层 `QUIET_HOURS_RULE_ID`、`IMPORTANT_SENDER_RULE_ID` 和迁移 0086 插入的字面量一致；`rule_id` 的 SQL 长度限制 1-64 也满足。不过这两个字面量在 application 和 persistence 各写了一份，没有测试把它们绑在一起，后续改名容易漂移。
- **规则 gate / outcome / 字段名**：`mail_item`/`mail_delivery`、`raise_floor`/`defer_to_quiet_hours`，以及 `sender_address`、`sender_domain`、`text`、`text_words`、`local_minutes`、`local_weekday`、`local_previous_weekday`，生产方（`mailItemFacts`、`quietEnd`、`rule-book.ts`）和消费方（`rule-expression.ts`、`proactive-rules.ts`）一致。
- **参数 JSON**：迁移和 `writeRule` 都写 `{periods}` / `{senders}`，`readSettings` 按同样形状读取；`parameters` 的 `json_type='object'` 也能通过。
- **修订号和历史**：`revision` 从 1 起、变更才加 1，`rule_book_history` 主键 `(owner, agent, rule, revision)` 能接受；`updated_at`/`changed_at` 没有格式 CHECK，迁移沿用旧值、写入用 `input.now`。
- **新增的 `rules` 字段**：`#finish` 的三个调用点（`:689`、`:912`、`:1254`）都补上了 `rules: []` 或真实规则，类型和运行时都能接受。
- **迁移序号 86**：`migration-engine.ts:675-681`、`workspace-lifecycle-audit.mjs:5`、迁移契约测试都更新到 86。
- **不一致处**：网关发件人契约仍接受孤立代理项和 320 字符，存储只接受 254 且拒绝代理项（问题 1）；迁移后的旧代理项值会在回写时被拒（问题 2）。

## 总体结论

这次改动的核心行为等价性做得很扎实：地板规则的顺序、钱词的中英文分词、公共后缀、静默时段的判定和结束时间都有对照测试，模型请求开头没有被改动，迁移和历史的值的生产/消费两端大体核对通过。主要剩余风险集中在**跨边界校验不一致**（网关 vs 存储、迁移 vs 新写校验）和**白名单宏谓词缺少反向用例**；此外有历史不可擦除和文档过期两处低风险问题。
