该计划的第 1 点声明（#collect/#deliver 结构、窗口、流程）与 `production-web-push.ts` 匹配。接下来我将查看持久层和迁移。
接下来是规则系统文件：`field-catalog`、`rule-book`、`owner-rules`，以及引用的规则文档。
代码端验证已基本完成。现在我快速抽查了计划中的行业主张。
最后再对计划的 §1.6（延后项目的生命周期）进行一次代码检查——即除 `web push` 外，是否还有其他因素会改变 `memory-reminder` 的状态：
# 审核结论：五类推送统一通知闸门方案

## 前提核对结果（方案 §0 的每条源码声明）

我逐条读了方案引用的源码，以下声明**全部与代码相符**：`#collect`/`#deliver` 位置与判定内容（production-web-push.ts:315-389、397-428）、`REMINDER_WINDOW_MS`（:19）、`web_push_outbox` 的 kind 白名单和无延后列（0058_web_push.sql:26）、`listDue` 过滤（sqlite-web-push-operations.ts:331-332）、`proactive_pushes` 与 `quietEnd` 算 `readyAt`（0062_proactive_checks.sql:89-99；proactive-mail-check-service.ts:1588-1601）、`RULE_GATES`（field-catalog.ts:9）、`GATE_OUTCOMES`（rule-book.ts:435-443）、`rule_set` 的 `type.enum` 由 `RULE_TYPES` 生成（production-owner-rules.ts:168-171，RULE_TYPES 只有两种邮件类型，rule-types.ts:202-213）、ADR 0212:65 的“推迟四件事”、决策 kind 白名单与 `rule_review` 先例（0069_decision_ledger.sql:5-10）。业界说法核对：Android 官方文档确认勿扰可设例外且“critical notifications show"（https://support.google.com/pixelphone/answer/6111295 ，"Alarms & other interruptions: Block or allow… Tip: With any settings, critical notifications show"），Apple Focus / Slack 的引用是一手来源，方案的“静默=延后不是丢弃、关键类可穿透”成立。

**仍未核实**（方案已自标，维持）：§0.9 最终方案文档全文；0093 迁移号被 P5-3 占用（项目记忆，仓库里查不到）；calibration 对未知决策 kind 的行为；三语 i18n 的具体键位。

---

## 发现的问题（按严重度排列）

**【高｜证实】静默时段被编辑时，`defer_until` 会不会被清空，取决于“规则存快照还是引用活数据”，方案两处说法不一致且都没写清。**
证据：方案 §1.5 只说“规则写入/撤销/开关变化时清空”；但生成规则的表达式由静默时段 periods 决定，而 periods 存在 `rule_book_rules` 的 `quiet_hours` 行（sqlite-proactive-operations.ts:249-258），`writeSettings` 一次写两行（:315、:327）。若 `push_quiet_hours` 只存 `{enabled:true}`、引用 `quiet_hours` 活数据，改静默结束时间（07:00→06:00）既不 bump 它的 revision 也不清 `defer_until`，已延后项会拖到旧的 07:00 才重裁——“撤销得了”对设置变更不成立；若存 periods 快照，则改静默时段必须同步重写该行并 bump revision，方案没写。建议：在 `writeSettings` 同一事务里，只要 `quiet_hours` 或该开关任一变化就清空该 owner 全部 `defer_until`，并把“快照 vs 引用”定成引用活数据（避免两处 periods 漂移）。

**【中｜证实风险】决策记录的确定性 id 哈希没包含 owner/agent，跨主人撞主键时会被 `ON CONFLICT DO NOTHING` 静默吞掉。**
证据：`decision_ledger` 主键是全局的 `id TEXT PRIMARY KEY`（0069_decision_ledger.sql:2），方案 §1.8 的 id 只含 source_key + 延后目标 + 规则引用。source_key 里各资源的 id（reminder/run/approval/push）我未逐一核实是否全局唯一；撞上时第二个主人的延后记录直接丢失，审计链缺一行。建议：哈希输入加 `ownerId + agentId`，成本为零。

**【中｜证实】`push_quiet_hours` 的 rule kind 消费点清单漏了一处 contracts-v2，且 `rebuild()` 分支没提。**
证据：contracts-v2.ts:1118-1127 决策链的规则 kind 枚举（与方案列的三处决策 kind 枚举 541/805/1102 是不同位置）；rule-version.ts:18-27 `RULE_KINDS`、:33-39 `KIND_BY_ID`、:110-172 `rebuild()`（决策链展示要按 kind 重建规则、算 wording 和例子状态，缺分支则展示为 unavailable）。方案 §5.4 只写了“rule-version KIND_BY_ID、三语 i18n、MCP 读规则”。建议把 contracts-v2 kind 枚举、`RULE_KINDS`、`rebuild()` 分支、`describeRuleVersion` 的例子展示全部列入清单。

**【中｜证实】时区缺省值必须钉死为 `?? "UTC"`，方案没写。**
证据：`ProductionWebPush` 的 `timeZone` 是可选的，只在 `runPolicy.timeZone` 存在时才传入（service-main.ts:2270-2272），`#formatTime` 自己 `?? "UTC"`（production-web-push.ts:550）；而邮件检查用的是 `configuration.runPolicy?.timeZone ?? "UTC"`（service-main.ts:1714）。闸门算 `local_minutes` 若用不同的缺省（或假设 timeZone 总在），与邮件检查的 `quietEnd`/`readyAt` 会对不上。建议：闸门统一 `timeZone ?? "UTC"`，测试断言与邮件检查同源。

**【低｜证实】命中规则但 `quietUntil` 为空的边界没定义。**
推测场景（本步不会发生，将来对话式规则会发生）：规则表达式命中、但 `quietUntil(at, periods, tz)` 由设置 periods 算出（proactive-rules.ts:93-101），两者不一致时返回 null，延后就没有目标时刻。建议现在就定：无 `quietUntil` 不延后并记决策行，写进 ADR，避免将来对话式规则上线时静默失效。

**【低｜证实】两处小的引用/精确性问题。**
- 前提 8：决策 kind 白名单加 `rule_review` 的 CHECK 重建先例是迁移 0087/0088/0089（各文件 :17-74），0091_decision_prereviews.sql 是预审表，不是这个先例。引用改一下。
- §3 “静默期内 `updated_at`/写次数不变”：`web_push_outbox` 没有 updated_at 列（0058:22-32），断言对象应写成“attempts.updated_at 不变、outbox 行零 UPDATE、决策记录零新增”。
- 顺带补一句方案没写的正面事实：`RuleJudge` 对 facts 无 `amount_state` 的闸门自动跳过含金额字段的规则（rule-judge.ts:33），加上 push_delivery 字段目录不含金额字段、表达式会过不了类型检查（rule-expression.ts:132-152 缺字段报错），金额规则碰不到推送，这条程序保证应写进 ADR。

**【低｜推测】`sendTest` 不经 outbox、天然绕过闸门**（production-web-push.ts:243-270 直发）——行为正确（主人手动触发不该延后），但建议在 ADR 里写明“测试推送不属五类、不过闸门”，防止将来有人把它算进闸门范围。

---

## 侧重检查

**我走的普通流程**（一条 22:30 生成、23:30 起进入静默的邮件主动提醒，开关打开）：

1. 设置页开关 → `proactive.settings.set` 契约（contracts-v2.ts:498-502 现只有 enabled/quietHours/importantSenders，要加字段）→ `sqlite-proactive-operations.writeSettings`（:271-341）写 `rule_book_rules` 的 `push_quiet_hours` 行。
2. 邮件检查创建推送，`readyAt` 按 `quietEnd`（proactive-mail-check-service.ts:1588-1601）→ `listReady` → `#collect` 入队并 `markEnqueued`（production-web-push.ts:358-388）。
3. 每 10 秒 tick（service-main.ts:2205-2288 构造、`webPush.start()`）→ `#deliver` → `listDue`（新增 defer 过滤）→ kinds → `#content` → **新闸门 `RuleJudge.decide("push_delivery", …)`** → 写 `defer_until/defer_rule_refs` + 决策记录 kind `web_push` → 到点重验 → `#send` → `recordAttempt`/`web_push_feedback`。
4. 展示/消费：决策链抽屉（decision.chain.read 契约、i18n）、MCP `rule_book`（production-mcp-read.ts:973 自动带上新规则）、数据导出 schemas、calibration。

**结论**：第 2、3 步全部是本次新代码，现有测试（production-web-push.test.ts、production-web-push-control.test.ts 的 [WP-5]/[WP-11]、sqlite-web-push.test.ts、web-push-sender.test.ts）都不覆盖；方案的 [HR-4] 集成测试方向对，但还有四条路径没列进测试清单：(a) `expires_at` 提升后 `prune`（production-web-push.ts:307-312、sqlite-web-push-operations.ts:568-579 按 expires_at 删）不误删延后项；(b) 生产接线 service-main.ts:2205 注入闸门依赖（规则/settings 读取）无测试点名，应放进现有 web push 集成测试文件而非只放 application 层；(c) 设置页开关的浏览器走查（check:layout、release-walkthrough-coverage）没点名；(d) 跨午夜/DST 应复用 rule-book-legacy-equivalence 已有的 `quietEnd` 对照思路断言同源。文档一致性：`.claude/rules/prompt-prefix.md`、`docs/incidents-and-gates.md`（I-73）、ADR 0212/0213 与方案说法相符，无需改；新 ADR 需要写（提醒延寿、审批/Muse 照发是行为变化）。

---

## 如果由我来定这份方案

架构判断我全部同意且已证实其前提：闸门放 `#deliver`（只有这里能拦已入队行和规则中途变更，`#collect` 的 `ON CONFLICT DO NOTHING` 使入队点不可重裁）、延后放 outbox 而不是 `web_push_attempts.next_attempt_at`（证实 listDue 按订阅 join、新设备 `a.status IS NULL` 会立即出现在 due，方案 §1.5 的理由成立）、不扩 `RULE_TYPES`、审批/Muse 照发。改动清单上加四条：① `writeSettings` 事务里静默时段或开关变化即清 `defer_until`，规则引用活数据；② 决策 id 哈希含 owner/agent；③ 消费点清单补 contracts-v2 kind 枚举、`RULE_KINDS`/`rebuild()`；④ 时区缺省 `?? "UTC"` 与邮件检查同源，写入 ADR；另补四条测试（prune、生产接线、浏览器走查、DST 对照）。

**必答问题：**

1. **不会改变模型已见过的请求开头。**本方案不触碰系统提示、工具定义、历史、遮盖；`rule_set` 的 `type.enum` 由 `RULE_TYPES` 生成（production-owner-rules.ts:168-171），方案明确不扩它，工具定义逐字节不变；新规则经 `ruleBookFor` 会出现在 MCP `rule_book` 的**未来调用结果**里，属末尾追加，符合规则第 3、4 条（.claude/rules/prompt-prefix.md）。方案“加一条断言 type.enum 不含新值”应放进 `check:rule-registry`（该检查在 check 链里，package.json:60）。
2. **不会。**新增值不进模型请求；`defer_rule_refs` 排序去重、决策 id 确定性（建议哈希含 owner/agent 后仍确定性）、`inputs.ruleIds` 沿用现有排序写法（proactive-mail-check-service.ts:1643-1649）。
3. **有对应检查，方向正确，反向用例里三条可证会失败**（“已入队旧行被拦”对只在 collect 做闸门必失败；“规则撤销后重裁”对不清 defer_until 必失败，前提测试能注入时钟并在 tick 间改设置；“审批兜底”对硬写 push_class 的规则必失败）；“写库不变”的断言对象要按上文精确化；补我列的四条缺口用例；迁移契约测试沿用 `decision-ledger-migration.contract.test.ts` 的模式（对每个 kind 只许配对 outcome 的断言已有先例 :161-162）。
4. **逐个值核对过两端**：`push_delivery`（产生 field-catalog/rule-book/GATE_OUTCOMES；消费 rule-expression 环境、RuleJudge、MCP）；`push_class`（产生闸门穷举 switch；消费生成表达式，同库两端）；`push_quiet_hours`（写 writeSettings；读 readSettings、ruleBookFor、rule-version `rebuild`/`KIND_BY_ID`、contracts-v2:1118 枚举、i18n、MCP——后三处方案已列，第三处方案漏了枚举）；设置开关（写 gateway 契约+writeSettings；读 readSettings；settings-scope 核实过：只拦设备身份表的设置列和浏览器键，账号级开关不触发）；`defer_until/defer_rule_refs`（SQL CHECK、listDue、清空、prune、数据导出）；kind `web_push`（决策 ledger CHECK 重建、ports/decision-ledger.ts:39、contracts-v2 三处、calibration、data-export schemas:197、决策链 UI）——全部可接受，前提是补上方案漏的 contracts-v2 kind 枚举和 `rebuild()` 分支。
