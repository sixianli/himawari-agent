我先读关键文件核对方案的前提和必答问题。
# 审核结论

## 证实的（按严重度从高到低）

**1. 高 —— 新结果 `require_whole_thread` 会被现有封闭校验直接拒绝，方案没提这两处**
- `RuleOutcome` 是封闭联合类型：`packages/application/src/rules/rule-book.ts:5` `"raise_floor" | "suppress_push" | "defer_to_quiet_hours"`；闸门-结果对照表 `rule-book.ts:332-335` 里 `mail_item` 只允许前两个；`assertRuleShape`（`rule-book.ts:347-350`）遇不匹配即抛错。
- 服务构造时就校验每条 ownerRules：`proactive-mail-check-service.ts:520` `for (const rule of options.ownerRules ?? []) assertRuleExamples(rule);`。
- 按方案第 1 节“新文件 rule-types.ts、不需要改表”的字面实施，`mail_read_whole_thread` 的规则在服务构造时就会抛错。方案必须把“扩 `RuleOutcome` 和 `GATE_OUTCOMES`、`RuleJudge` 对新结果的分发”写进改动清单。

**2. 高 —— 回放近似说明“只会多报、不会少报”是错的，实际会少报**
- 被判 `ignore` 的邮件只存 masked 后的发件人/标题/链接：`proactive-mail-check-service.ts:877-887`（`headerRef: await this.#seal(trace, { from: masked(item.from), subject: masked(item.subject), link: item.link })`），没有正文也没有摘要。
- 规则匹配的文字只有主题+摘要：`rule-book.ts:124` `const text = \`${item.subject}\n${snippet}\`;`。
- 所以 `phrases[]` 命中正文的 ignore 邮件在回放里根本无从判断、被遮掉的值也不会命中——方案第 5 节的“只会多报、不会少报”方向反了。应改为“可能漏报，回放结果只作参考、卡上写明”。

**3. 高 —— `mail_must_notify` 复用 `raise_floor` 达不到“必须通知我”，方案的括号说明与代码不符**
- `applyFloor` 把 `ignore` 升为 `know`（`proactive-rules.ts:104`），不是升为 `check`。
- `know`+floor 只进提醒页，不推送：`isReminderWorthy`（`proactive-rules.ts:113-116`）对 know 返回 floor，但推送条件是 `dueSoon || (result === "check" && floor)`（`proactive-mail-check-service.ts:904`）。
- 验收例 ②“日本入管局相关的邮件以后必须通知我”：若模型判“不用管”，主人只会看到提醒页里多一条，不会收到推送。方案第 1 节括号里“也至少提醒主人看一眼并推送”与代码不符。要么给该类型单独的推送语义（`ignore` 也升 `check` 并推送），要么和 Andy 确认“通知”指的是提醒页。

**4. 中（I-73 式）—— “读不全就升级”要往决策记录里写“原因 thread_incomplete”，但 `ruleHits` 的两端语义都不是干这个的**
- 持久层校验只要求字符串数组（`sqlite-proactive-operations.ts:675-682`），塞 `"thread_incomplete"` 能过校验；但全项目 `ruleHits` 的值是规则引用 `"id@revision"`（`proactive-rules.ts:72`），决策链按规则 id 聚合每条规则的命中邮件数展示（`production-decision-chain.ts:100-114`）。原因串会混进规则列表、被计数。
- 加原因要同时扩 `ProactiveCheckInputs` 类型（应用层）和 `validateInputs`（持久层 `sqlite-proactive-operations.ts:646`）两端，方案应写明。

**5. 中（I-73 式）—— “生产接上 ownerRules”这一步没有对应检查，忘了接也不会有任何东西变红**
- 生产构造确实没传：`apps/agent-service/src/production-proactive.ts:161-189` 的 `new ProactiveMailCheckService({...})` 没有 `ownerRules`。
- 现有集成测试是手动注入的：`test/integration/proactive-mail-check.test.ts:338` `...(options.ownerRules ? { ownerRules: options.ownerRules } : {})`，绕过了“数据库行 → readOwnerRules → 生产构造”整条真实路径；`[PR-A]/[PR-B]` 比对请求体，测不出规则没接上。这正是 I-73 的失败模式（`docs/incidents-and-gates.md:112`：“双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』”）。方案应加一条从 SQLite 写入 owner 规则行、走到 `#check` 命中的端到端集成用例，进 `npm run check`。

**6. 中 —— 规则只匹配主题+摘要，不含正文，方案没写明**
- `floorHitIds` → `mailItemFacts(item)` → `text = subject\nsnippet`（`rule-book.ts:124-131`）。主人说“订阅相关的必须提醒我”，若关键词只出现在正文，规则不命中。参数表和回执卡应写明匹配范围，否则主人会以为整封邮件都在匹配范围内。

**7. 低 —— “不认识的类型写一条决策记录”没指定 kind/outcome，会撞 CHECK 约束**
- `decision_ledger.kind` 是封闭枚举且每个 kind 绑定固定 outcome（`0087_rule_book_memory_link.sql:21-72`，如 `rule_review` 只有 `needs_review`）。需指定用哪种组合，不能随手写。

**8. 低 —— 读规则顺序未固定**
- 方案第 2 节 `readOwnerRules` 只写 `rule_id LIKE 'owner:%'`，没有 ORDER BY；行顺序进入 rules 数组并影响 `floorHits` 数组顺序。`.claude/rules/prompt-prefix.md` 规则 10 要求列表顺序固定。补 `ORDER BY rule_id`。
- 另：`source = "chat:" + threadId`，threadId 本身允许 256 字符（0087 SQL:120），加前缀可超 `source ≤256`（SQL:246），写入会被拒。实施时截断。

## 推测

- **quote 逐字匹配的降级场景**：主人明说的那几条消息若已被压缩出上下文，“最近几条主人消息”取不到 → 判成推断、出提议卡。属可接受降级，建议在提议卡上写明原因；未在代码里核实压缩后取消息的具体方式。
- **wholeThread 上限的误报率**：线程读取失败（预算 300 次/检查、超时）在高负载日会集中出现，命中规则 + 读不全 → 升级推送集中爆发。建议每次检查加升级条数上限（类似 `capped_daily` 的既有模式）；backoff 机制能部分兜底。未实测，标推测。
- 网关三个新接口的鉴权与参数校验：未核实。

## 侧重检查

走的流程：主人对话里说“订阅相关的邮件以后必须提醒我” → 模型调用 `rule_set`（描述登记 prompt-catalog，生产执行经 `production-runtime-tools`，幂等 key 照 reminder 模式 `production-reminder-writer.ts:385`，前提 10、11 均核实）→ 写规则类记忆（`applyProposal`，category=rule）→ 写 `rule_book_rules`（`source_memory_id` 填上，触发器 `memory_rule_needs_review` 生效，0087 SQL:301-402 已核实）→ 回执卡（工具结果，追加进历史）→ 下一次邮件检查 `run()` → `readSettings`（`sqlite-proactive-operations.ts:224`，SQL 只认两个固定 id，前提 6 核实）→ **需新增 readOwnerRules** → `#check` → `related()`（`gmail-related.ts:162`，前提 7 核实）→ judge → floor → push → `record`。

无测试覆盖的路径：① 生产组装点 `production-proactive.ts:161`（方案没有列出要改的文件，见问题 5）；② readOwnerRules 的 SQL→注册表还原；③ 网关撤销/确认接口；④ 回放。文档一致性：ADR 0209 决定 6、ADR 0211 后果（needs_review 照常执行、待重审标记留给第 4 步）与方案一致；`product-vision.md:133` 已核实。前提 8 的其余部分、前提 13 的项目聊天原话：未核实。

## 如果由我来定

1. 第 1 节补上：扩 `RuleOutcome`/`GATE_OUTCOMES`/judge 分发；`mail_must_notify` 的推送语义先和 Andy 对齐（问题 3）；参数表写明“只匹配主题+摘要”。
2. 第 3 节：原因不塞 `ruleHits`，扩输入字段并同改持久层校验；升级加每次检查条数上限。
3. 第 5 节：回放说明改成“可能漏报”。
4. 新增门槛：owner 规则从 SQLite 行走到检查命中的集成用例（防 I-73 复发）；`readOwnerRules` 加 ORDER BY；`source` 截断。
5. 工具换新一次的记录与用例：确认 `thread-prompt-bundles.test.ts` 对“新增工具”这类换新有对应用例。

必答问题：
1. **前缀**：发给模型的内容仍只追加——回执卡是工具结果，规则类记忆文字随本轮记忆进最后一条消息；唯一开头变化是新工具集导致老对话换新一次，规则 6 允许且需留记录（方案第 8 节已承认）。符合。
2. **字节确定**：随机 rule_id 只存一次；表达式/试算例子由存好的参数重生成，确定；回放是服务端计算不进请求。风险仅在读取顺序（问题 8）。
3. **自动检查**：`check:rule-registry` 存在（package.json:58），方案的反向用例（删测试文件→失败）真实可失败；但生产接线无检查（问题 5）。
4. **逐值核对**：`rule_id="owner:*"` —— 触发器按 `source_memory_id` 匹配不依赖它，决策链对未知 id 容忍（`production-decision-chain.ts:107-113` 返回 null），通过；`require_whole_thread` —— 撞 `assertRuleShape`，不通过（问题 1）；ruleHits+原因 —— 校验能过但语义冲突（问题 4）；`parameters` 新形状 —— 只有 readOwnerRules 读，与 writeSettings 的固定 id 不冲突，但规则手册不在导出范围（ADR 0209/0211 已记，属已知欠账）；`source_memory_id` 长度与触发器两端核对通过；新配置键需进配置 schema 过 `check:product-path-configuration`，方案未提。
