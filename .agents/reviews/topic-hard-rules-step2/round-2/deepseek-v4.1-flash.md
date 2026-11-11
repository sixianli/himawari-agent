## 结论

不建议按现方案直接实施。方案里有 4 个会直接改变行为或无法落地的问题：默认静默会从邮件扩散到五类推送、非邮件的 `defer_to_quiet_hours` 没有实现路径、闸门放在 `#collect` 无法处理已入队项、可缺失字段与现有裁判“缺字段就报错”的实现冲突。另有金额数据通路、数据导出、决策表无限增长和金额明文存储等缺口。

---

## 证实的（按严重度）

### 1.【严重】改名后默认静默会扩散到全部五类，和第 6 点自相矛盾

问题：把 `mail_delivery` 改名为 `notification` 后，`quiet_hours` 规则没有 `source` 条件。而“默认静默 23:00–07:00、每天”在主人没设置时也存在，`ruleBookFor` 每次都会带上这条规则。一旦 `NotificationGate` 按 `notification` 闸门评估所有来源，提醒、审批、Run、Muse 通道都会在 23:00–07:00 被命中，直接改变其他四类的现有行为。

证据：
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:58-64`：`DEFAULT_QUIET_HOURS` 是每天 23:00–07:00。
- `packages/application/src/rules/rule-book.ts:236-248`：`quietHoursRule` 只有时间段表达式，没有 `source`。
- `packages/application/src/rules/rule-book.ts:265-273`：`ruleBookFor` 无条件加入这条规则。
- `packages/application/src/services/proactive-mail-check-service.ts:807,1292`：邮件检查用这份规则算 `quietEnd`。
- `apps/agent-service/src/production-web-push.ts:315-389`：五类推送都在 `#collect` 产生。

建议：不要改 `mail_delivery` 的名字。保留它只给邮件静默用；另加一个 `notification` 闸门，只允许明确的 `suppress_push` 规则，并且规则里必须写 `source`。如果一定要合并，必须把默认静默规则生成成 `source == "mail" && ...`，并给其他四类补“默认设置下 23:30 仍照常推送”的对照测试。

### 2.【严重】闸门放在 `#collect` 太早，已入队的项绕过了它

问题：`#collect` 负责“收集并入队”，`#deliver` 才真正发送。`enqueue` 对已存在的 `source_key` 是 `ON CONFLICT DO NOTHING`，所以已经入队的项不会因为后来规则变化、进入静默时段或主人改设置而被撤下。方案只在 `#collect` 问闸门，等于只影响“第一次收集到”的项。

证据：
- `apps/agent-service/src/production-web-push.ts:263-297`：`enqueue` 的 `ON CONFLICT DO NOTHING`。
- `apps/agent-service/src/production-web-push.ts:315-389`：闸门如果放在这里，只能决定“入不入队”，不能决定“已入队的发不发”。
- `apps/agent-service/src/production-web-push.ts:397-428`：真正发送在 `#deliver`，这里目前只有过期、类别开关和 presence 判断。

建议：至少要在 `#deliver` 发送前再问一次闸门，或者把闸门只放在 `#deliver`，并把决定持久化。只在 `#collect` 做，无法保证“同一段文字在不同请求里行为一致”，也无法覆盖规则修改、静默边界和审批临期。

### 3.【严重】非邮件的 `defer_to_quiet_hours` 没有实现，且 6 小时窗口让“23:30 延到 07:00”不可能

问题：现有延后机制只存在于邮件创建推送时：算出 `readyAt`，到点再取。`#collect` 没有“把提醒改到静默结束后再收集”的机制。更具体地说，记忆提醒的窗口是 6 小时；23:30 到 07:00 是 7.5 小时，到 07:00 时已经超出窗口，`listDue` 会把它过滤掉，永远不会在 07:00 推送。

证据：
- `apps/agent-service/src/production-web-push.ts:19`：`REMINDER_WINDOW_MS = 6 * 3_600_000`。
- `apps/agent-service/src/production-web-push.ts:297-304`：`now - remindAt <= REMINDER_WINDOW_MS`。
- `packages/application/src/services/proactive-mail-check-service.ts:1290-1300`：只有邮件创建时算 `readyAt`。

建议：明确区分“延后”和“不推送”。非邮件来源如果暂时只支持 `suppress_push`，就不要在目录里声明 `defer_to_quiet_hours` 可用。要实现延后，必须给 outbox 项或提醒本身持久化 `deferUntil`，并同步延长提醒窗口或改用独立的到点调度。方案文档里的 23:30→07:00 例子必须重写，不能声称“闸门已经支持”。

### 4.【严重】“字段缺失算不命中”和现有裁判的实现冲突，且默认成 0 会把 `<` 规则判反

问题：`compileRuleExpression.evaluate` 会遍历该闸门字段目录里的**所有字段**，任何一个缺失都抛错，不管表达式有没有引用它。也就是说，只要 `amount_minor` 是可缺失的，现有 `RuleJudge` 对每条 `notification` 规则都会在缺金额时抛错。方案说“引用可缺失字段且事实没有时算不命中”，这需要新增“规则引用了哪些字段”的能力，不能简单地把字段从 facts 里删掉。

证据：
- `packages/application/src/rules/rule-expression.ts:132-158`：按目录逐字段校验并抛错。
- `packages/application/src/rules/rule-judge.ts:24-31`：只收集命中，没有 skipped 或按规则跳过。
- `docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:56`：现行决定明确是“字段缺失或类型不对时直接报错，不当作没命中悄悄放过”。

建议：在编译结果里记录表达式实际引用的字段；裁判只跳过“引用了缺失可选字段”的规则，其余规则照常求值。绝对不要用 0 填充缺失金额，否则 `amount_minor < 10000` 会在缺金额时错误命中。

### 5.【高】金额没有数据通路，`NotificationGate` 拿不到金额

问题：方案只写了“存到 `source_insights` 三列”，但当前推送链路拿不到这三列。`ProactivePushSource.content()` 只返回文字、结果、`dueAt`、`more`；`listReady()` 只返回 id 和 `readyAt`；`insightColumns` 和 `readInsights` 也不读金额；insert/update 也不写金额。

证据：
- `apps/agent-service/src/production-web-push.ts:180-193`：`ProactivePushSource` 没有金额或来源。
- `apps/agent-service/src/production-proactive.ts:88-123`：`content()` 只打开第一条 insight 的文字。
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:71-74`：`insightColumns` 没有金额列。
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:787-830`：UPDATE 和 INSERT 都没有金额列。
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:1190-1198`：`readInsights` 只按 `insightColumns` 读。

建议：或者把金额放进已密封的 insight 内容，由 `content()` 一并返回；或者完整扩展 `ProactivePushSource`、`ProactivePush`、`readInsights`、insert/update、控制中心和测试。要明确一个推送包含多条 insight 时金额怎么取，不能默认取排序后的第一条。

### 6.【高】数据导出、schema 目录和迁移测试会漏掉新字段/新表

问题：`source_insights` 已经在数据导出里，新增三列必须同步到 snapshot、export、schema、import，否则导出导入会静默丢金额。新表 `rule_decisions` 必须加进 `schema-catalog.ts`，否则 `migration-engine.contract.test.ts` 的“实际表集合等于目录”会失败。

证据：
- `packages/persistence-sqlite/src/data-export/snapshot.ts:141-149`：显式列出 `source_insights` 的所有列。
- `packages/persistence-sqlite/src/data-export/export.ts:513-530`：逐字段映射，没有金额。
- `packages/persistence-sqlite/src/data-export/schemas.ts:248-267`：导出 schema 没有金额字段。
- `packages/persistence-sqlite/src/data-export/import.ts:549-573`：显式 INSERT 列清单，没有金额。
- `packages/persistence-sqlite/test/migration-engine.contract.test.ts:21,67-72`：硬编码 `CURRENT_SCHEMA_SEQUENCE = 86`，并要求表集合和 `schemaCatalog` 完全一致。
- `packages/persistence-sqlite/src/schema-catalog.ts:912-917,933-937`：`source_insights` 和 `proactive_pushes` 的说明也需要更新。

建议：把 0087 的改动列成一张清单：迁移 SQL、schema catalog、导出 snapshot/export/schema/import、迁移契约测试、`CURRENT_SCHEMA_SEQUENCE`、所有硬编码 86 的用例、roundtrip 测试。金额列要不要进导出也要明确；如果进，必须按敏感数据对待。

### 7.【高】`rule_decisions` 会每 10 秒写一遍，没有去重或清理，存在资源耗尽风险

问题：`#collect` 每 10 秒运行一次。记忆提醒在 6 小时内会一直被 `listDue` 返回；审批和 Muse 中断也会每轮重新列出；Run 虽然靠 cursor 前进，但 `#collect` 对 `suppress` 只“不入队”。如果每轮抑制都写一条只追加的 `rule_decisions`，一个提醒最多可写约 2,160 条，一个活跃审批或一次 12 小时的 Muse 中断也会持续增长，而且这张表没有清理路径。

证据：
- `apps/agent-service/src/production-web-push.ts:220-224`：默认 10 秒一轮。
- `apps/agent-service/src/production-web-push.ts:297-304`：提醒 6 小时窗口。
- `apps/agent-service/src/production-web-push.ts:333-379`：审批、Muse 每轮重新列出。
- `apps/agent-service/src/production-web-push.ts:382-388`：只有 proactive push 在入队后标记，其他来源没有持久化“已决定”状态。

建议：给 `rule_decisions` 设计幂等键，例如 `(owner, agent, gate, object_key, rule_id, revision)` 唯一，结果不变就不新增；或者只在状态变化时追加。对 `suppress` 的非邮件项也要持久化“已抑制到什么时候/已抑制”，或者明确每轮重新评估的代价并加保留/清理策略。还要有“同一提醒跑 100 轮只产生一条决策”的测试。

### 8.【高】`proactive_pushes` 加 `suppressed` 状态涉及一串消费者，方案只写了迁移

问题：`ProactivePush.status` 是字面量联合类型；`ProactivePushSource`、`ProactiveStorePort`、`durable-adapters`、SQLite operations、`removeSource`、schema catalog 都要改。新增“标记 suppressed”的 store 方法目前不存在。

证据：
- `packages/application/src/ports/proactive-checks.ts:142-148`：`status: "pending" | "enqueued"`。
- `apps/agent-service/src/production-web-push.ts:180-193`：`markEnqueued` 之外没有 `markSuppressed`。
- `packages/persistence-sqlite/src/durable-adapters.ts:995-996`：只映射了 `listReadyPushes` 和 `markPushEnqueued`。
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:526`：`removeSource` 只删 `status = 'pending'`，`suppressed` 行会留下。
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:1144-1178`：`pendingPush`、`listReadyPushes`、`markPushEnqueued` 都只认 pending/enqueued。

建议：把新状态的所有两端都列出来：类型、端口方法、durable adapter、SQLite 操作、worker 协议、schema catalog、`removeSource`/`clearRecords`、测试。还要定义多条规则同时命中时 `defer` 和 `suppress` 谁优先，以及 `suppressed` 之后规则被撤销时怎么办。

### 9.【高】金额明文写入 `source_insights` 是隐私回退

问题：`source_insights` 的正文本来是通过 `content_ref` 指向密封 payload 的；金额是账单类敏感信息，方案却把它放进明文列。数据导出也会把明文列导出。主人删除 proactive 记录时，金额列会跟着 `source_insights` 删除，但导出文件里已经带出去了。

证据：
- `packages/application/src/services/proactive-mail-check-service.ts:1310-1322`：`summary`、`reason`、`from`、`subject` 等都走 `#seal`。
- `packages/persistence-sqlite/src/schema-catalog.ts:912-917`：`source_insights` 标为 `payload_reference`。
- `packages/persistence-sqlite/src/data-export/export.ts:513-530`：`source_insights` 按明文行导出。

建议：把金额放进已密封的 `content` payload，和 `summary`/`subject` 同一保护级别；如果确实需要可查询的明文列，要明确数据分类、更新 schema catalog 和导出策略，并加 DB 约束。

### 10.【中】迁移 0087 说“改 `rule_book_rules` 里 quiet_hours 的 gate 值”，但表里没有 gate 列

问题：`rule_book_rules` 只存 `rule_id`、`revision`、`parameters`、`status`、`source`、`updated_at`。gate 是代码里 `quietHoursRule` 生成的，不在数据库。这个迁移步骤是不存在的。

证据：
- `packages/persistence-sqlite/src/migrations/0086_rule_book.sql:1-11`：表结构没有 gate。
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:230-241`：只读 `rule_id` 和 `parameters`。
- `packages/application/src/rules/rule-book.ts:236-248`：gate 由代码写死为 `mail_delivery`。

建议：删掉这个迁移步骤。改名只是代码改动；如果仍要改数据，只需说明 `quiet_hours` 的 `parameters` 不变。真正需要迁移的是 `source_insights` 列、`proactive_pushes` 状态和 `rule_decisions` 表。

### 11.【中】前提 3 的 grep 不完整，`AttentionPolicyService` 的调用点比方案说的多

问题：方案说 `new AttentionPolicyService` 只在 `local-composition-root.ts:202` 和 `attention-policy.unit.test.ts:59`。实际还有两个测试调用点。删 `quietHours` 配置时，这两处也要改。

证据：
- `test/e2e/beef-restaurant.test.ts:403`
- `test/integration/attention-delivery.test.ts:104`

建议：把 `AttentionPolicyConfig.quietHours` 的删除当作一次小重构，列出全部调用点，不要只改两个夹具。

### 12.【中】提示词检查写错了：这次不是 `check:prompt-prefix`，而是 `check:prompt-catalog`

问题：邮件判断是后台固定提示，`check:prompt-prefix` 跑的是对话多轮请求，不会覆盖它。`MAIL_JUDGMENT` 有 golden 快照；加一句说明必须更新快照并跑 `check:prompt-catalog`。

证据：
- `package.json:56`：`check:prompt-catalog` 明确包含 `prompt-rendering-golden.unit.test.ts` 和 `prompt-output-contracts.unit.test.ts`。
- `apps/agent-service/test/prompt-rendering-golden.unit.test.ts:39,220`：`mail.judgment` 有 golden。
- `packages/prompt-catalog/src/mail.ts:3-33`：说明文字在固定段 `MAIL_JUDGMENT.text` 里。
- `packages/application/src/services/proactive-mail-check-service.ts:385-406`：固定段在前，记忆/邮件数据/`MAIL_JUDGMENT_NOW` 在后。

建议：把说明加在 `MAIL_JUDGMENT.text` 的末尾，不要加到 `MAIL_JUDGMENT_NOW` 之后；否则当前时间不再是最后一项。验证写 `check:prompt-catalog`，再加一条“邮件数据段和当前时间仍在最后”的断言。

### 13.【中】`source_insights` 同一线程更新时不会刷新金额，可能留下旧金额

问题：同一线程的新邮件会 `UPDATE` 同一行。方案的金额只写“新表的三列”，但现有 UPDATE 的字段清单没有金额。新邮件没有金额时，旧金额会留在行上，规则可能按旧金额决定新邮件。

证据：
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:787-805`：UPDATE 没有金额列。
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:808-830`：INSERT 没有金额列。

建议：UPDATE 时明确“新邮件没有金额就清空”，并测试“同一线程先有金额、后无金额”的场景。

### 14.【中】`source` 枚举和现有 source key 的前缀不一致，而且来源没有持久化

问题：方案用 `muse_channel`，现有 source key 是 `muse-channel:`；邮件推送的 source key 前缀是 `proactive:`，不是 `mail:`。如果 `source` 只在 `#collect` 里临时算，`#deliver` 再问闸门时就无法知道来源；如果存到 outbox，又需要迁移和两端校验。

证据：
- `apps/agent-service/src/production-web-push.ts:326`：`reminder:`
- `apps/agent-service/src/production-web-push.ts:336`：`approval:`
- `apps/agent-service/src/production-web-push.ts:351`：`run:`
- `apps/agent-service/src/production-web-push.ts:362`：`proactive:`
- `apps/agent-service/src/production-web-push.ts:373`：`muse-channel:`

建议：定义一个唯一的 `source` 映射函数，五个值用同一套分隔符；如果闸门可能在 `#deliver` 运行，把 `source` 持久化到 outbox 或明确规定只能从 `source_key` 前缀推导，并写测试。

### 15.【中】ADR 0209 与方案冲突，ADR 0210 没有说明要取代哪几条

问题：ADR 0209 第 4 条明确说“字段缺失或类型不对时直接报错，不当作没命中”。方案第 2 点正好相反。ADR 0209 第 3 条还把闸门写成 `mail_item` 和 `mail_delivery`。ADR 0210 只写第 3、6 点和与最终文档的差异，不够。

证据：
- `docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:54-56`
- `docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:104`：第 2 步才加“字段缺失怎么算”。

建议：ADR 0210 明确写“部分取代 ADR 0209 第 3、4 条”，并说明闸门更名/新增、缺失字段语义、金额存储位置、导出策略和为什么改。不要让两份 ADR 同时有效却互相矛盾。

---

## 推测的（方案没写清或需要产品决定）

1.【高】多条规则同时命中时，`defer_to_quiet_hours` 和 `suppress_push` 谁优先没有定义。`RuleJudge` 会返回所有命中；`rule_decisions` 只写一个“结果”时也会丢信息。建议定义优先级并逐条记录。

2.【高】对审批和 Run 做永久 `suppress` 可能造成不可挽回的后果。审批会过期，Run 的通知窗口有限；如果用户规则命中，主人可能完全看不到。建议默认不把 `suppress` 用在审批/Run 上，或强制保留一个可见的兜底提醒。

3.【中】“金额正好等于门槛照常推送”只在规则用 `>` 时成立；如果规则用 `>=`，等于门槛应该命中。必须按比较符分别写反向用例，不能一句“正好等于门槛”概括。

4.【中】“按比较符自动补边界例子”不现实。`RuleRecord.examples` 只是一个事实和是否命中的列表；现有 `assertRuleExamples` 只校验作者给的例子，不会自动推导。带 `&&`、币种条件、缺失字段的规则更难自动补。建议继续手写例子，至少覆盖 `>`、`>=`、缺失金额、不同币种四种。

5.【中】`amount_confident` 的语义不清。如果模型给 `unsure`，到底存不存金额？如果存了但 `confident=false`，规则引用 `amount_minor` 仍会命中，和“照常推送”矛盾。建议 `confidence !== "sure"` 时直接不存金额，三个字段用 DB CHECK 保证同时为空或同时有值。

6.【中】`rule_decisions` 的删除策略和“删除 proactive 记录”不一致。现有 `clearRecords` 会删 `source_insights`、`proactive_pushes` 和 proactive 的 `decision_ledger`；如果 `rule_decisions` 只随 Agent/主人删除，主人点“删除主动提醒记录”后仍会留下决策痕迹。建议明确保留还是随 `clearRecords` 删除，并写进 schema catalog。

7.【中】`proactive_pushes` 重建表时，方案没有提到重建 `proactive_pushes_ready_index` 和保留原有 CHECK。`0062_proactive_checks.sql:101` 有索引；重建表后不重建会掉索引。

8.【低】最终方案文档和“Andy 已同意”我无法从仓库核实，标为未核实。如果需要，我建议把最终文档的关键决定抄进 ADR 0210 或仓库文档，而不是只引用外部 artifact。

9.【中】金额是模型从不可信邮件正文里抽出来的，不应被当作事实用于安全或不可撤销的决定。恶意邮件可以诱导模型输出很大的金额，从而触发或绕过金额规则。建议把金额当“线索”，必要时用确定性解析校验，且永远不要用它替代审批或安全检查。

10.【中】跨币种直接比较 `amount_minor` 是错的。`10000` 在 JPY 是 1 万日元，在 USD 是 100 美元。规则必须同时绑定币种，或者先换算到主人基准币种（需要汇率来源和时点）。不要只暴露一个裸的 `amount_minor`。

---

## 侧重检查

- **错误路径**：检查了 `#collect` 抑制后是否重复收集、`#deliver` 是否还会发送、金额缺失/币种未知/格式非法、规则编译失败、迁移重建失败。结论是“只抑制不入队”对提醒和审批会反复评估，对 Run 会被 cursor 跳过，三条路径行为不一致。
- **不合规范/不可信输入**：检查了模型输出的 `amount.value`、`amount.currency`、`confidence`，以及邮件正文里的提示注入。建议严格限制金额字符串长度、只接受十进制、拒绝指数/符号/负号/千分位/超过币种小数位、限制到安全整数；币种按 ISO 4217 官方列表校验。
- **安全/隐私**：检查了金额是否进入明文列和导出。结论是当前方案会把账单金额放进 `source_insights` 明文列并随导出带出，和现有“正文走密封 payload”的做法不一致。
- **资源耗尽**：检查了 `rule_decisions` 的写入频率、提醒 6 小时窗口、审批/Muse 每轮重列、表保留策略。结论是方案没有去重或清理，按现写法会持续增长。
- **不可撤销的操作**：检查了提醒、审批、Run 的抑制语义。提醒被抑制后仍在 `scheduled` 状态但不会在窗口外再推；审批会过期；Run 被 cursor 跳过后不会补。方案没有为这些情况提供兜底。
- **规则文件、说明文档和代码一致性**：检查了 ADR 0209、`.claude/rules/prompt-prefix.md`、`schema-catalog.ts`、迁移测试、prompt golden、package.json 的 check 脚本。发现 ADR 0209 第 4 条、提示词检查和 `rule_book_rules` gate 迁移步骤三处不一致。
- **未核实**：最终方案文档原文、Andy 的批准记录、生产库当前实际数据、`claude.ai` artifact 内容。

---

## 如果由我来定，我会怎样改这份方案

1. **不改 `mail_delivery` 的名字。** 邮件静默继续走现有的 `readyAt + quietEnd`；新增一个独立的 `notification` 闸门，只放“明确抑制推送”的规则。默认规则不挂到这个闸门上，避免 23:00–07:00 影响提醒、审批、Run、Muse。
2. **闸门放在发送前。** 在 `#deliver` 发送前评估，或者在 `#collect` 和 `#deliver` 都评估并持久化决定。已入队的项必须能被新规则、静默边界和主人改设置影响。
3. **非邮件先只支持 `suppress_push`。** 不在目录里声明非邮件支持 `defer_to_quiet_hours`，除非同时实现 `deferUntil` 并把提醒窗口的语义改清楚。23:30→07:00 的例子要么删掉，要么按“延后”重新实现。
4. **扩展 CEL 编译结果，记录引用字段。** 裁判只跳过“引用了缺失可选字段”的规则，其他规则照常求值。绝不把缺失金额填成 0。补“不引用金额的规则在缺金额时仍正常”“`amount_minor < X` 在缺金额时不被误判”的测试。
5. **金额放进已密封的 insight 内容，而不是明文列。** 如果确实要可查询，先明确数据分类、schema catalog、导出策略和 DB CHECK。解析用十进制字符串，不用浮点；币种按 ISO 4217 官方 minor unit（含 0/3/4 位和 N.A.）；只在 `confidence === "sure"` 时存；同一线程更新时清掉旧金额。
6. **完整列出金额的数据通路。** `ProactivePushSource`、`ProactivePush`、`readInsights`、`insightColumns`、insert/update、`content()`、数据导出四件套、schema catalog、控制中心、测试。
7. **`rule_decisions` 做幂等。** 用 `(gate, object_key, rule_id, revision, result)` 之类唯一键，结果不变就不新增；明确保留/清理策略，并和 `clearRecords`/`removeSource` 的删除语义对齐。
8. **补 ADR 0210。** 明确取代 ADR 0209 的第 3、4 条；写清闸门、缺失字段、金额存储、导出和默认静默的产品决定。同步更新 prompt golden、`check:prompt-catalog`、schema catalog、迁移测试和硬编码的 `CURRENT_SCHEMA_SEQUENCE`。
9. **测试重点。** 默认设置下五类推送在 23:30 的行为；已入队项在规则变化后的行为；同一提醒跑 100 轮只产生一条决策；数据导出 roundtrip；0086→0087 升级；JPY/KWD/CLF/未知币种；金额缺失和 `>=`/`>` 边界；退役规则不生效；非邮件不受默认静默影响。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**

不会改变对话请求开头。方案没有改系统提示、工具定义、历史消息或出口遮盖。唯一涉及模型的是后台邮件判断的固定提示：在 `MAIL_JUDGMENT.text` 末尾加一句说明属于固定段内部追加，`MAIL_JUDGMENT_NOW`（当前时间、时区、今天）仍在最后，符合“固定的在前、会变的在后”（`.claude/rules/prompt-prefix.md:27,67`；Anthropic/OpenAI 的缓存匹配也是逐字节：https://platform.claude.com/docs/en/build-with-claude/prompt-caching 、https://developers.openai.com/api/docs/guides/prompt-caching ）。老对话不受影响，因为这不是对话历史，而是后台调用。

但两点要注意：不要把说明加在 `MAIL_JUDGMENT_NOW` 之后，否则变化的当前时间不再是最后一项；不要把金额门槛、主人币种等按请求变化的值插进固定提示，否则每次请求字节都变。验证应跑 `check:prompt-catalog`，不是只跑 `check:prompt-prefix`。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**

模型请求本身不会。金额和规则只影响程序判断，不进入模型请求；没有新增依赖前后文的遮盖、带时间的字段或无序列集合。

但决策层有确定性风险：
- 一个推送包含多条 insight 时，金额如果取 `content()` 排序后的第一条，而现有排序比较器对 `know`/`check` 不是全序，结果可能不稳定；应改成稳定聚合或逐条决定。
- `source`、规则列表、金额 facts 必须从固定顺序生成，不能依赖 `Set`/`Map`/数据库返回顺序。
- 金额用浮点换算会产生不同结果，必须用十进制字符串和整数运算。
- `rule_decisions` 的 `时间` 不进入模型，但同一对象重复决策会让审计结果不可比，应做幂等。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

方案列的检查不够。`check:prompt-prefix` 不覆盖后台邮件判断；相关的是 `check:prompt-catalog`（`package.json:56`，包含 `prompt-rendering-golden.unit.test.ts:220` 的 `mail.judgment` golden）。另外需要 `check:rule-registry`、`check:data-export`、迁移契约测试和新的闸门测试。

给出的反向用例有一部分会失败，但不够精确：
- “金额缺失、币种不同、`unsure` 照常推送”能反向验证“不要误抑制”。
- “金额正好等于门槛照常推送”只在规则用 `>` 时正确；如果规则用 `>=`，等于门槛应该命中。要按比较符分别写。
- 缺少“不引用金额的规则在缺金额时仍正常求值”“已入队项在规则变化后被重新评估”“同一对象不每轮写决策”“默认设置下非邮件不受静默影响”“0086→0087 升级后读回”“导出再导入金额不丢”“退役规则不生效”等用例。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

不能，至少下面这些两端没有对齐：

- **闸门名 `notification`**：`field-catalog.ts:9`、`rule-expression.ts` 的环境、`rule-book.ts:240`、`proactive-rules.ts:72` 的 `quietEnd`、`rule-registry.unit.test.ts` 等都要改。`rule_book_rules` 没有 gate 列，迁移步骤不成立（`0086_rule_book.sql:1-11`）。
- **`source` 枚举**：计划用 `muse_channel`，现有 key 是 `muse-channel:`；邮件是 `proactive:`；`ProactivePushSource` 和 `WebPushOutboxItem` 没有 source 字段，`#deliver` 拿不到。必须统一映射并决定是否持久化。
- **`amount_minor` / `amount_currency` / `amount_confident`**：`RuleFieldDefinition` 类型、`RuleFacts`、求值器、`ProactiveInsight`、`insightColumns`、insert/update、`readInsights`、`content()`、导出 snapshot/export/schema/import、DB CHECK 都要同步；现有 UPDATE 会留下旧金额（`sqlite-proactive-operations.ts:787-805`）。
- **`suppress_push`**：`RuleOutcome`、`RuleJudge`、`quietEnd`、`floorHitIds`、目录里的“允许结果”、测试和 ADR 都要处理；否则未知结果可能被静默忽略。
- **`suppressed`**：`ProactivePush.status`、`ProactivePushSource`、`ProactiveStorePort`、`durable-adapters.ts:995-996`、SQLite 操作、`removeSource`、schema catalog、测试都要改；当前没有 `markSuppressed`。
- **`rule_decisions`**：新表要进 `schema-catalog.ts`（否则 `migration-engine.contract.test.ts:67-72` 失败），要有只追加触发器、删除语义、幂等键和清理策略；`source_key` 的长度/格式也要和 outbox 的 `source_key` 两端一致。
- **ISO 4217 金额**：官方 minor unit 不只有 0/2/3 位，还有 4 位（CLF、UYW）和 N.A.（XAU 等），且列表会变。见 SIX（ISO 4217 官方维护机构）：https://www.six-group.com/en/products-services/financial-information/market-reference-data/data-standards.html 和 ISO：https://www.iso.org/iso-4217-currency-codes.html 。只写 JPY/CNY/USD/KWD 会把其他合法币种当成“没有金额”。规则必须绑定币种，不能直接跨币种比较 `amount_minor`。

另外，ADR 0209 第 4 条和方案第 2 点直接冲突，必须在 ADR 0210 里明确取代，否则规则文件和代码不一致。
