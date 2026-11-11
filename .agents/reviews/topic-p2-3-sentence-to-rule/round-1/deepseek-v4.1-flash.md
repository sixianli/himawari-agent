I'll start by reading the key files referenced in the plan.
## 结论摘要

这份方案的方向（参数化规则 + 程序生成表达式 + 裁判执行）是对的，但有几处会直接让验收目标落空：**“读整个邮件串”只读更早的邮件、规则匹配只看标题和摘要、提议没有地方存、新规则在长驻服务里读不到、撤销后规则类记忆还在注入**。另外，“不改系统提示、只加工具”仍会改变所有老对话的请求开头，必须按规则单独处理。

---

## 已证实的问题（按严重度）

### 1. 【阻断】“读整个邮件串”名不副实，验收①会漏

**问题：** 方案说“同一 Gmail 串里比它早的邮件全部保留”，但产品愿景要求的是“读完线程全文并搜后续确认/收据”。当前读取器对所有关联邮件都套了 `isEarlier`，根本不会把比当前邮件更晚的邮件放进时间线；`threadComplete` 仍可能报“读全了”。同时，规则的 `mail_item` 事实只由 `subject + snippet` 生成，正文里的“退款/返金”完全看不到。于是“退款只写在正文”或“退款在更早邮件”的邮件不会触发读全串。

**证据：**
- `packages/platform-node/src/gmail-related.ts:125`：`if (candidate.messageId !== item.messageId && isEarlier(candidate, item))`
- `packages/platform-node/src/gmail-related.ts:162`：`byMail.set(item.messageId, ordered.slice(-limits.perMail));`
- `packages/application/src/rules/rule-book.ts:124`：`const text = \`${item.subject}\n${item.snippet}\`;`
- `packages/application/src/rules/field-catalog.ts:26-29`：`text` 的描述是“邮件主题、换行、摘要连起来的原文”
- `docs/product-vision.md:133`：“对退款、预订、付款是否办结，必须读完线程全文并搜后续确认/收据才下结论”
- `docs/agent-rulebook-inventory.md:54`：明确写“代码里‘退款’只是金钱词……读整个邮件串是对所有邮件都做的”
- `docs/adr/0180-...md:42`：ADR 0180 决定 2 明确“只收比这封邮件更早的邮件”

**建议：**
- 要么把类型改名为“读全部更早邮件”，并在验收里承认不覆盖“后续确认/收据”；要么把同一 `threadId` 的全部邮件（含当前邮件之后已存在的）纳入 `threadComplete` 的定义，并改 ADR 0180。
- 规则的匹配事实新增一个受上限保护的 `body_text` / `thread_text` 字段，至少用遮盖后的正文算；否则“涉及退款”无法可靠触发。
- 采用两阶段：先用标题/摘要/正文做触发，命中后再取完整串，最后用完整串重算一次，避免“只看标题决定要不要读全串”。

---

### 2. 【阻断】没有“提议”的存储和状态，方案里的“只生成提议、不生效”无法实现

**问题：** 方案说“模型推断的只生成提议，主人点头才生效”“提议卡显示 [生效] [不要]”，但 `rule_book_rules.status` 只有 `active / needs_review / retired`；`needs_review` 按 ADR 0211 是**照常执行**的。没有 `proposed` 状态，也没有新的提议表。工具参数里也没有“推断/明说”的字段（只有 `quote`、`type`、`params`、`summary`），模型无法“标了推断”。结果只能是：要么把推断规则直接写成 active，要么根本没地方放提议。

**证据：**
- `packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:245`：`status TEXT NOT NULL CHECK (status IN ('active', 'needs_review', 'retired'))`
- `docs/adr/0211-...md:51`：“待重审的规则照常执行：裁判（RuleJudge）和设置读取都把它当作有效规则。”
- 方案第 4 节：工具参数只有 `quote / type / params / summary`，却要求“对不上或模型标了‘推断’ → 只生成提议，不生效”。

**建议：**
- 新增 `rule_proposals` 表，至少含：`proposal_id`、`owner_id`、`agent_id`、`type`、`type_version`、`params`、`summary`、`evidence_message_id`、`evidence_span`、`created_at`、`expires_at`、`status`；或者给规则表加 `proposed` 状态（需要迁移重建，不能再说“不改表”）。
- 工具增加显式的 `basis: "explicit" | "inferred"`（服务端仍要自己判定，不能只信模型）。
- “生效”接口必须重新校验类型、版本、参数和证据，不能直接信任提议里存的内容。

---

### 3. 【阻断】生产服务只构造一次，`ownerRules` 是静态快照，后来写入的规则不会生效

**问题：** 方案说“生产接上 `ownerRules`”，但 `ownerRules` 是 `ProactiveMailCheckService` 的构造函数选项，`ProductionProactive` 在启动时只构造一次 service；目前 `new ProductionProactive` 也只发生一次。即使把 `ownerRules` 传进去，`rule_set` 之后写入数据库的规则也不会被这个长驻 service 看到，除非重启。方案还漏了 `readProactiveOverview`：它只用 `ruleBookFor(settings)` 重算 floor，不认识主人规则。

**证据：**
- `packages/application/src/services/proactive-mail-check-service.ts:109`：`readonly ownerRules?: readonly RuleRecord[];`
- `packages/application/src/services/proactive-mail-check-service.ts:520-521`：构造函数里一次性 `assertRuleExamples`
- `packages/application/src/services/proactive-mail-check-service.ts:824`：`const rules = [...ruleBookFor(settings), ...(this.#options.ownerRules ?? [])];`
- `apps/agent-service/src/production-proactive.ts:161-189`：`this.#service = new ProactiveMailCheckService({...})`
- `apps/agent-service/src/service-main.ts:1566`：`proactive = new ProductionProactive({...})`
- `packages/application/src/services/proactive-overview.ts:124-125`、`150-157`：概览只读 `ruleBookFor(settings)`，并用 `floorHitIds` 重算

**建议：**
- 不要用构造函数静态数组。给 `ProactiveStorePort` 增加 `readOwnerRules`，在每次 `#check` 开始时读取并校验；或者给 service 注入一个 `loadOwnerRules()` 回调。
- 概览、裁判、测试替身、持久层适配器都要用同一份读取逻辑；否则提醒页和真正执行会漂移。
- 加集成测试：运行中通过 `rule_set` 写规则，不重启，下一次检查必须命中。

---

### 4. 【高】撤销只退规则，不退规则类记忆，软偏好会继续影响模型

**问题：** 方案说“撤销 = 状态改 `retired`、修订号加 1、写历史”，但 `rule_set` 同时写了一条 `category = rule` 的记忆。撤销后这条记忆仍是 active，仍会进入 owner profile 注入。于是“硬规则已撤销”但模型仍看到“以后退款都要……”的文字，等于软规则继续存在。ADR 0211 的触发器只监听“记忆 → 规则”，不监听“规则 → 记忆”。

**证据：**
- 方案第 2 节：“撤销 = 状态改 `retired`、修订号加 1、写历史。”
- `packages/application/src/services/owner-profile-service.ts:203-205`：`eligible.filter((memory) => memory.attributes?.category === "rule")` 会被注入
- `packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:301`：触发器只从 `memory_records` 更新去标规则
- `docs/adr/0211-...md:51`：规则类记忆和硬规则是同一来源，但未规定撤销时的反向处理

**建议：**
- 撤销必须在同一个事务里同时归档/取代 `source_memory_id` 指向的规则类记忆，或者在撤销后把它改成非注入的 provenance 记忆。
- 加测试：撤销后 owner profile 不再包含这条规则文字，模型请求里也看不到。
- 如果希望保留出处，单独存一条不可注入的审计记录，不要继续作为 rule 类记忆。

---

### 5. 【高】`mail_must_notify` 的“至少提醒并推送”与现有地板行为不符

**问题：** 方案表格说 `raise_floor` 是“模型判‘不用管’也至少提醒主人看一眼并推送”。现有 `applyFloor` 对 `ignore + sure` 只抬到 `know`；而 `wantsPush` 只覆盖“高优先级、48 小时内的 act”和“check + floor”。`know + floor` 只上提醒页，不发网页推送。H-7 也明确只允许两种情况推送。因此“必须通知我”如果理解成推送，方案不成立；如果只要求提醒页，方案应改措辞并加验收。

**证据：**
- `packages/application/src/services/proactive-rules.ts:96-106`：`applyFloor` 把 `ignore` 改成 `know`
- `packages/application/src/services/proactive-mail-check-service.ts:904`：`const wantsPush = dueSoon || (final.result === "check" && floor);`
- `docs/agent-rulebook-inventory.md:74-75`：H-6“值得知道只有命中地板才上提醒页”；H-7“只有两种情况发网页推送……”
- 方案第 1 节表格：`raise_floor（已有：模型判“不用管”也至少提醒主人看一眼并推送）`

**建议：**
- 要么把验收改成“上提醒页”，不要写“推送”；要么新增一个明确的 `notify_owner` / `force_push` 结果，并单独出 ADR 修改 H-7，同时接入降频/去重。
- 不要复用 `raise_floor` 的语义来表达“必须推送”，否则测试会按旧行为通过、真实需求没达到。

---

### 6. 【高】新结果 `require_whole_thread` 没有接入现有裁判/闸门，且 `ruleHits` 被混用

**问题：** `GATE_OUTCOMES.mail_item` 只允许 `raise_floor` / `suppress_push`；`floorHitIds` 只取 `raise_floor`，`suppressPushHits` 只取 `suppress_push`。如果只加一个 `RuleOutcome`，`assertRuleShape` 会直接抛错；即使绕过，新结果也不会被任何闸门消费。反过来，如果把它当 `raise_floor`，又回到第 5 条：`ignore` 只到 `know`，不会变成 `check`，也不会推送。方案还打算把 `thread_incomplete` 塞进 `ruleHits`，但 `ruleHits` 现在是“抑制推送”的字段，语义会混。

**证据：**
- `packages/application/src/rules/rule-book.ts:332-335`：`mail_item: ["raise_floor", "suppress_push"]`
- `packages/application/src/rules/rule-book.ts:347-350`：`assertRuleShape` 校验结果是否属于闸门
- `packages/application/src/services/proactive-rules.ts:56-74`：`floorHitIds`/`suppressPushHits` 只认两种结果
- `packages/application/src/services/proactive-mail-check-service.ts:907`：`if (suppressing.length > 0) ruleHits[item.messageId] = suppressing;`
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:675-682`：`ruleHits` 每封最多 16 条、每条最多 256 字符

**建议：**
- 不要把“要求读全串”做成 `RuleOutcome`。把它做成独立的 `RuleRequirement`（前置条件）集合：命中后进入“完整读取”阶段，读取结果再决定 action。
- 强制 `check` 时用显式分支，并生成固定的、可本地化的 reason；`ignore` 没有 reason，不能直接拿来展示。
- 如果确实要记录原因，新增 `inputs.ruleRequirements` 或 `inputs.ruleReasons`，不要复用 `ruleHits`；同时更新持久层校验、导出和 UI。

---

### 7. 【高】`rule_set` 的“随机 rule_id”和“按 runId + toolCallId 幂等”自相矛盾，且没有总量上限

**问题：** 方案说 `rule_id = "owner:" + 随机`，又说两步都按 `runId + toolCallId` 幂等、重试不重复。随机 id 在第一次写入后如果响应丢失，重试会生成新 id，直接多一条规则。提醒工具的先例是用 `runId:toolCallId` 派生稳定 id；规则也应如此。方案也没有限制每个主人最多多少条规则、同一组参数是否去重，`RuleJudge` 的缓存只有 256 条、满了会整表清空，规则一多会反复编译。

**证据：**
- 方案第 2 节：“`rule_id = "owner:" + 随机`”；第 4 节：“两步都按 `runId + toolCallId` 幂等”
- `apps/agent-service/src/production-reminder-writer.ts:161-162`：`memory:reminder:${input.key}`，`reminder:${memoryId}`
- `apps/agent-service/src/production-reminder-writer.ts:385`：`key: \`${invocation.runId}:${invocation.toolCallId}\``
- `packages/application/src/rules/rule-judge.ts:24`、`45`：`CACHE_LIMIT = 256`，满了 `this.#compiled.clear()`

**建议：**
- `rule_id` 从 `runId + toolCallId` 做稳定哈希（例如 `owner:` + 32 位 base32），或先写幂等映射再读回；不要随机。
- 对规范化后的 `type + params` 做内容哈希，同一主人重复设置同一条规则时返回已有规则，不新增。
- 每主人 active/needs_review 规则设硬上限（建议 32 条），`rule_list` 分页/限量；超限返回明确错误码。
- 写规则 + 写历史放进一个 SQLite 事务；并发触发器和撤销不能丢修订号。

---

### 8. 【高】验收③“订阅规则、不含新闻通讯”用现有参数表达不了

**问题：** 两种类型的参数只有 `senderDomains[]`、`senderAddresses[]`、`phrases[]`、`words[]`，没有排除项。验收③要求“含付费订阅的扣款、续费、试用到期、涨价、取消；不含新闻通讯”。如果模型把“取消”放进 `phrases`，新闻通讯里的“取消订阅”也会命中；如果只放“扣款/续费”等，很多订阅邮件又漏。方案没有 `excludePhrases` / `excludeDomains`，也没有结构化“订阅”类型。

**证据：**
- 方案第 1 节参数列表只有四个正向列表
- 方案第 7 节验收③：“订阅相关的必须提醒我（理解为付费订阅的扣款、续费、试用到期、涨价、取消；不含新闻通讯）”
- `packages/application/src/rules/rule-book.ts:155` 现有金钱词规则就是正向 `contains` / `in text_words`，没有排除语义

**建议：**
- 增加受同样上限约束的 `excludePhrases[]`、`excludeSenderDomains[]`，生成的表达式用 `&& !(...)`；或者做专门的 `mail_subscription_notify` 类型，把“订阅事件”和“新闻通讯”分别建模。
- 验收用例必须包含“新闻通讯包含‘取消订阅’但不提醒”的反例；否则③不能算通过。
- 排除项也要做归一化、去重、长度/数量上限和测试。

---

### 9. 【高】“原话逐字出现 = 明说”不够，且有可能被提示注入利用

**问题：** 这个判定只证明模型给的一段 `quote` 是主人某条消息的子串，不能证明这句话表达了这条规则。模型可以引用一句“好的”，然后附上任意 `params`，程序仍判“明说”。方案也没有规定：
- 是比对原始消息，还是比对遮盖后发给模型的消息；
- 是否必须是当前这一轮/当前这次运行的主人消息；
- 是否排除工具结果、助手消息、转发的邮件内容；
- “模型标了推断”到底放在哪个参数里。

更严重的是，`rule_set` 会立即写入硬规则并可能在下一次邮件检查中推送；而 `rule_undo` 也会被模型调用。邮件/网页内容里的提示注入可以诱导模型调用这些有持久副作用的工具。

**证据：**
- 方案第 4 节：“`quote` 必须逐字出现在本对话最近几条主人消息里才算‘明说’”
- 方案第 4 节工具参数没有 `basis` / `inferred` / `evidenceMessageId`
- `packages/application/src/services/thread-command-service.ts:59-69` 已有“从原话确定性解析显式请求”的先例（回答语言），说明可以用确定性规则先筛“显式”。

**建议：**
- 运行时提供 `evidence_message_id`、`role=owner`、`author=owner`、`turn`，并传入“实际发给模型的遮盖后文本”；程序只认当前 run 中、工具调用之前、主人角色的消息，逐字比对同一个遮盖版本。
- `quote` 必须包含显式祈使标记（以后/一律/每次/从今以后/今后/今後/以後/always/from now on/必ず 等），或者必须覆盖整条消息；否则一律进提议，不直接生效。
- 不要信任模型的 `inferred` 标记；由“是否有显式标记 + 是否完整命中”共同决定。
- `rule_undo` 只允许 UI 按钮或带明确确认的当前轮主人请求；不要让模型仅凭工具调用就能撤销。
- 新增规则在主人看到回执卡之前，建议至少“只上提醒页、不推送”或进入观察期；否则误译会立即产生推送，撤销也追不回来。

---

### 10. 【高】新增 3 个工具会改变所有老对话的请求开头，方案把代价写轻了

**问题：** “不改系统提示、只加工具”不等于只追加。工具定义排在系统提示和历史之前；给 `rule_set`、`rule_list`、`rule_undo` 加定义后，老对话在下一轮开始时会因为“工具集合变了”换新一次，系统提示和全部历史都要重新计费。这不是“只在末尾追加”。项目规则明确要求：会改变模型已经见过的请求开头，就停下来出方案、Andy 同意才动工；新增工具还应尽量保持工具列表稳定，不能用时由执行端拒绝，而不是增删工具。

**证据：**
- `.claude/rules/prompt-prefix.md:27`：“顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。”
- `.claude/rules/prompt-prefix.md:41`：“工具集合变了（工具名，或者去掉说明文字后的参数结构）……换新一次，并且每次都留记录。”
- `.claude/rules/prompt-prefix.md:44`：“业界的首选是让工具一直在列表里，不能用的时候由执行端拒绝，而不是把工具删掉或加进来”
- `.claude/rules/prompt-prefix.md:84`：“这个改动会不会让模型已经见过的请求开头变化？会，就停下来出方案，Andy 同意才动工。”
- 业界一手来源（项目规则里引用的 Claude Code 工程文章）：https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/ ；OpenAI：https://developers.openai.com/api/docs/guides/prompt-caching

**建议：**
- 优先**不加聊天工具**：在每轮结束后做一次固定提示的后台“规则抽取”调用（类似记忆捕获），不改变主对话的 head；代价是异步和一次额外模型调用。
- 如果必须加工具，合并成**一个稳定工具**（例如 `rule` + `action: set/list/undo`），始终曝光，运行时不可用就拒绝；不要三个工具、也不要按配置条件增删。
- 明确写进 ADR：这次会触发一次全对话缓存失效，记录预期成本和监控指标；不要写“`check:prompt-prefix` 不受影响”就带过。
- 更新 `check:prompt-catalog`/提示词 golden；加一个用例模拟老对话在工具集合变化前后的请求，确认只换一次并留记录。

---

### 11. 【高】历史回放的“只会多报、不会少报”不成立，且可能很贵

**问题：** 回放说“用当时遮盖后的内容，正文可能比当时算规则用的摘要更长，所以只会多报”。但当前规则事实只用 `subject + snippet`，根本不看正文；而 `model_input` 里的正文是被遮盖、按 2000 字窗口截断的，`related` 也截断。用这种内容回放，既可能把 live 检查永远不会命中的正文命中算进来（多报），也可能因为遮盖/截断漏掉真实命中（少报）。`model_input` 是一批邮件的整段提示，按邮件解析很脆弱；30 天全量解密也有成本、隐私和时限问题。

**证据：**
- `packages/application/src/services/proactive-mail-check-service.ts:295-299`：每个 related 正文 `windowMailBody(..., limits.charactersPerRelated)`
- `packages/application/src/services/proactive-mail-check-service.ts:348-355`：主邮件正文也按 `bodyLimit` 窗口，`bodyTruncated` 标记
- `packages/application/src/rules/rule-book.ts:124`：事实只取 `subject + snippet`
- 方案第 5 节：“取每封已判断邮件当时发给模型的内容（解密 `model_input`）……只会多报、不会少报”
- `docs/adr/0180-...md:44`：`relatedByMail` 只记真正发给模型的那批，不记没轮到的

**建议：**
- 回放不要从自然语言提示里解析。从现在起在检查时存一份**结构化的、版本化的规则事实快照**（或加密的 compact facts payload），回放直接读它。
- 明确标注“回放是近似，可能多报也可能少报”；不要写单方向保证。
- 回放要限制条数/时间/解密量，异步执行或分页；失败不能阻塞规则创建，卡上显示“无法回放”而不是让整个 `rule_set` 失败。
- 回放结果的数据分类不能低于原 `model_input`，不要复制完整正文到聊天工具结果。

---

### 12. 【高】自动检查的“测试文件存在 + describe 字符串”太弱，反向用例只测了门本身

**问题：** 计划的门只检查“注册表里写的测试文件存在，且包含 `describe("[rule-type:<id>]")`，不得 `.skip`”。一个只有一行空 `it` 的桩文件也能过；而且 `check:rule-registry` 现在是**显式文件列表**，新类型的测试文件如果不加进这个列表，根本不会执行。反向用例“删掉测试文件，检查失败”只证明文件存在检查有效，不证明规则逻辑正确。真实模型验收（DeepSeek/GLM）也不是可重复的回归门。

**证据：**
- `package.json:58`：`check:rule-registry` 明确列出 `rule-registry.unit.test.ts`、`rule-expression.unit.test.ts`、`rule-book-legacy-equivalence.unit.test.ts`
- `packages/application/test/rule-registry.unit.test.ts:66-82`：现有反向用例是“改坏例子/换表达式/换禁用函数”，这才是规则层反向用例
- 方案第 1 节：“每个注册的类型，测试文件必须存在，且含 `describe(...)`……反向用例：删掉一种类型的测试文件，检查失败。”

**建议：**
- 让 `check:rule-registry` 从注册表**动态枚举**所有类型，逐个生成规则、运行正例/反例/非法参数，并断言 `assertRuleExamples`；测试文件只作为附加证据，不作为唯一证据。
- 强制把每个类型的测试文件加入实际执行的 vitest 文件列表，或直接用 `--project unit` + 名称过滤；禁止 `it.skip`、`test.skip`、`describe.skip`、`it.todo`、条件跳过。
- 加真正的反向用例：改坏生成器模板、删掉一个排除条件、把 `require_whole_thread` 改成不生效、删掉一个类型但保留测试，门都必须失败。
- 真实模型验收单独放 `evals/`，记录固定输入和输出；`npm run check` 只跑确定性夹具，不要依赖模型随机性。

---

### 13. 【中】参数校验、归一化和确定性不足

**问题：** 方案只写了“每列表 ≤32、每项 1–64 字符、不含代理项、域名/地址格式校验、至少一个列表非空”。仍缺：
- 重复项去重、固定排序（否则同一组参数生成不同表达式、不同历史）；
- 大小写归一（发件地址/域名要小写；`phrases` 默认大小写敏感，`Refund` 匹配不到 `refund`）；
- Unicode NFC/NFKC 归一（日文浊音、全半角）；
- 拒绝空白/控制字符/双向文本覆盖字符（会污染 UI 和规则卡）；
- 单字符短语（如 `"a"`、`"退"`）会产生大量误报，建议至少 2 个非空白字符或按语言设下限；
- `summary` 的长度、字符集和展示清洗没有上限；
- 域名后缀如 `co.jp`、`com` 会匹配整片域名，需要明确允许/拒绝。

**证据：**
- 方案第 1 节参数限制
- `packages/application/src/rules/rule-book.ts:85-91`：现有生成器用 `JSON.stringify` 转义，但没有排序/归一
- `packages/application/src/rules/rule-book.ts:115-131`：`mailItemFacts` 只对地址小写，`phrases` 不折叠大小写
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:232-234`：SQL 没有 `ORDER BY`

**建议：**
- 写入时把参数规范化成唯一的规范形式（NFC、去重、排序、地址/域名小写），表达式和例子只从规范形式生成；用规范形式的哈希做幂等。
- 对 `summary` 设长度上限（例如 200 字）、拒绝控制字符；UI 显示做转义/双向文本处理。
- 为大小写、全半角、重复项、单字符、超长、控制字符、RTL 覆盖各加正反测试。

---

### 14. 【中】规则手册存的是明文自由文本，绕过记忆的保护、导出和删除

**问题：** `parameters` 是明文 JSON，`source`、`summary`、`quote` 都可能包含主人的原话甚至敏感信息；`rule_book_history` 只追加，不能单独删除，规则手册又不在数据导出范围内。把“原话 + 规则说明”写进规则手册，等于把本应走记忆保护/治理删除的内容放进了一个不可删除的地方。

**证据：**
- `packages/persistence-sqlite/src/migrations/0087_...sql:244`：`parameters TEXT NOT NULL CHECK (json_valid(parameters)...)`，没有加密/分类字段
- `docs/adr/0209-...md:104`：规则手册不在数据导出里，留给第 5 步
- `docs/adr/0211-...md:91`：规则手册不在数据导出范围内；历史只追加
- 方案第 2 节：`parameters = { "type", "params", "summary" }`，`source = "chat:<threadId>"`

**建议：**
- 规则手册只存结构化、非自由的 `type/version/params`；原话和说明放进受保护的规则类记忆，规则手册只存 `source_memory_id`。
- 如果必须展示 `summary`，单独存一条受 payload protector 保护的文本，或限制为程序生成的固定说明，不存模型自由文本。
- 明确规则手册的导出、删除、分类和保留策略，并加数据导出测试。

---

### 15. 【中】类型/生成器版本没有进入修订号，未知类型会静默失效

**问题：** 表达式由代码按参数生成，但数据库只存参数和 `revision`。以后修生成器、删类型或改匹配语义时，同一个 `revision` 会对应不同表达式，决策记录里的 `ruleId@revision` 无法重现当时执行的是什么。更严重的是，`readOwnerRules` 遇到不认识的类型“不执行并写决策记录”——这违反 ADR 0211 “硬规则不能悄悄失效”的原则，只是把静默失效换成了每次检查写一条决策记录。

**证据：**
- `docs/adr/0209-...md:54`：“这两条的表达式不存库，由程序按存下来的参数生成，所以参数是唯一来源。”
- `packages/application/src/services/proactive-rules.ts:72`：`${id}@${revision}` 被写进决策记录
- `docs/adr/0211-...md:51`：规则停掉等于主人要求悄悄失效，所以待重审仍执行
- 方案第 2 节：“遇到不认识的类型或参数不合法的行，不执行并写一条决策记录”

**建议：**
- 给每条规则加 `type_version`（或把版本写进 type id），生成器版本变化时提升版本并写历史；决策记录记 `type_version`。
- 未知类型/非法参数应把规则标 `needs_review`，在设置页和提醒里明确告知主人；不要每次检查写一条决策记录。写决策记录要先定义合法的 `kind/outcome`，并在同一修订只写一次。
- 为“类型被删除/重命名/生成器模板变化”加迁移测试。

---

### 16. 【中】整串读取的上限会制造大量误报

**问题：** 即使按方案，整串模式仍会沿用 `charactersPerRelated=2000` 的每封正文窗口。只要线程里有一封超过 2000 字，`threadComplete` 就是 false，规则命中后每次检查都强制 `check`/推送。而地板规则不参与降频，可能每次检查都推同一条。`wholeThreadCharactersPerMail=60000` 还会和 `perBatch=64000` 冲突；`#fitBatch` 对第一封邮件无论多大都会放进去，单封可能超过每批上限。

**证据：**
- `packages/application/src/services/proactive-mail-check-service.ts:295-299`：每封 related 截到 `charactersPerRelated`
- `packages/application/src/services/proactive-mail-check-service.ts:963`：`if (batch.length > 0 && size + next > bodyLimits.perBatch) break;`，第一封永远放入
- `packages/application/src/services/proactive-rules.ts:108-117`：`isReminderWorthy`，地板 `know` 可上提醒页
- `docs/agent-rulebook-inventory.md:79`：命中地板的提醒不降频
- 方案第 3 节：默认 50 封、60000 字；“读不全就升级”

**建议：**
- 整串模式单独定义一个“每封可读全文”的上限，不要复用 2000 字窗口；或者明确 `threadComplete` 只在“消息数/总字数/单封正文都在上限内”时为 true。
- 对 `thread_incomplete` 的升级加去重：同一 `threadId` 同一规则同一修订只推一次，之后进提醒页；接入 backoff 或至少按天冷却。
- 计算 `#fitBatch` 时把整串内容的实际 JSON 大小算进去，并允许单封超过 perBatch 时截断/拆批，不要无条件放入。
- 用构造的长线程测试误报率；验收里加“长线程不重复刷屏”的反例。

---

### 17. 【中】决策记录/审计字段没有定义，`ruleHits` 复用会破坏契约

**问题：** 方案只写“决策记录 `ruleHits` 记规则 id 和原因 `thread_incomplete`”，但 `ruleHits` 现有消费者把它当“抑制推送的规则”；持久层校验每封最多 16 条、每条最多 256 字符；`ruleIds` 最多 500 条。新规则 id 和原因格式没有定义，可能超限或被 UI 误显示。给非法规则行写决策记录也没有合法的 `kind/outcome`：`decision_ledger` 的 kind 只有固定几种，`rule_review` 只允许 `needs_review`。

**证据：**
- `packages/application/src/services/proactive-mail-check-service.ts:907`：`ruleHits` 只写 `suppressing`
- `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:675-682`：`ruleHits` 每封 ≤16、每条 ≤256
- `packages/persistence-sqlite/src/migrations/0087_...sql:21-24`：`kind` 枚举
- `packages/persistence-sqlite/src/migrations/0087_...sql:71`：`rule_review AND outcome = 'needs_review'`
- 方案第 2 节“写一条决策记录”、第 3 节“ruleHits 记规则 id 和原因”

**建议：**
- 新增明确的 `inputs` 字段（如 `ruleReasons` / `ruleRequirements`），不要复用 `ruleHits`；同步更新持久层校验、导出模式、决策链 UI 和测试。
- 非法规则行的决策记录用 `rule_review` 时必须写清 `subject_ref=rule_id`、`outcome=needs_review`，并限制每个修订只写一次；或者新增 kind（需要迁移）。
- 规则 id/原因在写入前做长度和字符校验，排序去重。

---

### 18. 【中】文档、清单、配置键、重新确认路径都不完整

**问题：** 方案没有说要更新：
- `docs/agent-rulebook-inventory.md` 里 H-3（金钱词只看标题/摘要）和 H-15（读更早邮件、不是按退款触发）的现状描述；
- ADR 0209/0211 的后果（新增工具、提议、读全串、撤销记忆）；
- `runPolicy.proactive.wholeThreadMessagesPerMail` / `wholeThreadCharactersPerMail` 的启动配置 schema、默认值、边界和测试；
- ADR 0211 要求的“待重审规则在设置页的标记和重新确认按钮”的写入命令。方案只列了撤销、确认提议、列出规则，没有“重新确认”接口。

**证据：**
- `docs/agent-rulebook-inventory.md:54`、`83`：H-15 和“退款不是按词触发”的描述
- `docs/adr/0211-...md:92`：“待重审的规则在规则页上的标记和‘重新确认’按钮（现在只有改值才能让规则回到生效）”
- 方案第 6 节：“含待重审标记和‘重新确认’”，但没有对应网关命令
- `package.json:27` 的 `check:agent-rulebook-inventory` 只核对链接/测试名，不会发现内容过时

**建议：**
- 在实施前更新 ADR/inventory/配置文档；新增配置键要有启动校验、默认值、范围测试和三语文案。
- 增加 `rule.reconfirm` 网关命令：校验 owner/agent、规则 id、当前修订，写 `active`、revision+1、历史 `change_reason`，并幂等；补 Playwright/集成测试。

---

## 推测 / 未核实

- **未核实：** Gmail `threads.get?format=full` 是否在大线程上分页或截断。我只读了 `gmail-source.ts:267-275`，没有用真实账号验证；如果会截断，`threadComplete` 还要额外判断。
- **未核实：** `runId`/`toolCallId` 的实际最大长度。若用 `memory:reminder:${runId}:${toolCallId}` 派生规则记忆 id，可能超过 `source_memory_id` 的 128 字符上限（`0087_...sql:247`）；建议改用固定长度哈希，不要拼原始 id。
- **推测：** 自动记忆捕获可能也会把同一句“以后……”写成一条 rule 记忆，和 `rule_set` 写的规则记忆重复；方案没有说明如何抑制/去重。需要读自动捕获路径并加测试。
- **推测：** SQLite 当前通常按 rowid 返回，`readOwnerRules` 不写 `ORDER BY` 在同一数据集上可能“碰巧稳定”，但这不是契约；只要迁移/优化器改变就会变。应按规则 id 排序。
- **未核实：** Andy 是否已经同意“新增 3 个工具导致老对话缓存失效”这一次性代价。提供的材料只引用了 prompt-prefix 的冻结机制，没有看到针对这次工具集合变化的明确批准。
- **推测：** 真实模型验收在 DeepSeek 和 GLM 上各跑一遍，结果会受模型随机性和服务状态影响；不能当作 CI 回归门，只能作为验收记录。

---

## 侧重检查

**错误路径：**
- `ownerRules` 读取失败时，当前设计没有定义是“失败整个检查”还是“无规则继续”。硬规则读不到就继续检查，会悄悄停掉主人的要求；应 fail closed / `needs_owner`。
- `rule_set` 写记忆成功、写规则失败会留下一条孤立的 rule 记忆，仍会被注入；必须一个事务或补偿删除。
- `rule_undo` 重试、并发和记忆触发器竞争可能丢修订号；需要幂等键 + 事务。
- 模型调用失败/输出不完整时，命中 `mail_read_whole_thread` 的邮件目前不会自动变成 `check`；需要把“无判断”也当作不完整处理。
- 到达每日费用上限时 `#related` 被跳过（`proactive-mail-check-service.ts:741-752`），命中读全串规则的邮件不会被读取；方案没有定义此时如何降级。
- 回放失败、解密失败、payload 被清理时，方案没有定义是否阻塞规则创建。

**不合规范/不可信输入：**
- 模型生成的 `type/params/summary`、主人原话、邮件正文/标题/发件人、网关传来的 `ruleId` 都是不可信输入；需要服务端重新校验，不能只依赖工具 schema。
- 规则的 CEL 字面量必须继续走 `celString/celStringList`（`rule-book.ts:85-91`）；新增参数不要手拼字符串。
- 单字符短语、空白、控制字符、双向文本、超长 summary、重复项、大小写/Unicode 归一都要在写入时处理。
- 域名/地址校验要拒绝空 `@`、通配符、尾点、纯后缀（如 `com`）和 IDN 未归一形式，否则会产生过宽规则。

**安全：**
- 最大风险是提示注入 + 有持久副作用的工具：邮件/网页可以诱导模型调用 `rule_set` 或 `rule_undo`。第 9 条的证据门只能降低、不能消除；撤销尤其应该只走 UI。
- 规则手册的明文 `summary/quote` 绕过记忆治理删除和导出限制；规则历史不可单独删除。
- 回放会解密历史 `model_input`，必须保持最高数据分类，不能把正文复制到低分类的工具结果/UI。
- 网关撤销/确认必须按 owner/agent 作用域，不能只凭规则 id；错误码不要泄露其他规则存在性。
- 规则参数如果被用来生成展示文本，要防 XSS 和双向文本欺骗。

**资源耗尽：**
- 每主人规则条数、每规则参数列表、summary 长度、`rule_list` 返回条数都没有上限；`RuleJudge` 缓存 256 条满后清空，会导致频繁重编译。
- 整串读取 50 封/60000 字 × 每批多封，和 `perBatch=64000`、每封正文 16000 的现有上限没有对齐；第一封永远入批。
- 回放 30 天全量解密没有预算/分页/取消；`rule_set` 工具可能超时。
- 非法规则行每次检查都写决策记录，会放大磁盘和账本写入。

**不可撤销的操作：**
- `rule_set` 直接生效后，下一次邮件检查可能在你看到回执卡之前就推送；推送不可撤回。
- 撤销只把规则标 `retired`，历史只追加、规则类记忆仍注入；主人无法真正“当没说过”。
- 规则手册不在导出范围、历史不可删除，违反数据可携带/可删除的预期。

**规则文件、说明文档和代码一致性：**
- `.claude/rules/prompt-prefix.md` 的工具稳定性/审批要求与“新增 3 个工具”冲突。
- ADR 0209 第 109 行说“发给模型的内容、系统提示和工具定义都没有变”，本方案改了工具定义；需要新 ADR 或明确更新。
- ADR 0211 第 92 行要求第 4 步做“重新确认”按钮，方案没有对应命令。
- `docs/agent-rulebook-inventory.md` 的 H-3/H-15 现状描述会过时；`check:agent-rulebook-inventory` 不会自动发现。
- `docs/product-vision.md:133` 的“后续确认/收据”和 ADR 0180 的“只收更早邮件”本身就有张力，方案必须明确站哪边，不能同时声称两者。

---

## 如果由我定，我会这样改

1. **分两期，不一次性上“对话直接写硬规则”。** 第一期只做“程序执行”：类型注册表、参数规范化、每 run 读取主人规则、读全串/正文事实、错误路径和测试；第二期再做“对话作者 + 提议 + 回执卡 + 撤销”。
2. **规则事实单独建模。** 新增一个受上限保护的 `mail_rule_facts`：`subject`、`snippet`、`body_text`（遮盖后）、`thread_text`（遮盖后）、发件人、域名、英文词；不要只靠 `mailItemFacts` 的标题/摘要。现有金钱词规则是否改用正文，单独出 ADR，不要让旧行为悄悄变。
3. **“读全串”做成两阶段要求，不是 `RuleOutcome`。** 先触发，再读取全部 `threadId` 邮件（按 ADR 决定是否含更晚邮件），读取完成后重新计算，再决定 action；把“完整/不完整”作为独立状态，不完整时生成固定 reason 的 `check`，并按线程去重、降频，避免长线程刷屏。
4. **规则表可以继续用 `rule_book_rules`，但要加三样东西：** `type_version`、提议存储（新表或新状态，必须迁移）、以及每主人的 active 规则上限。参数只存结构化值；原话/说明放受保护的规则类记忆，`summary` 不存明文自由文本。
5. **作者流程改成服务端证据门。** 用当前 run 的主人消息、角色、`evidence_message_id` 和遮盖后字节校验；确定性扫描显式祈使词；没有显式标记就进提议。`rule_undo` 只允许 UI/明确确认，不允许模型自由调用。直接生效的新规则在主人看到回执卡前先不推送，或至少只上提醒页。
6. **不加三个工具。** 先试“轮末后台规则抽取”，保持主对话 head 不变。如果必须给模型工具，只加一个稳定的 `rule` 工具（`action: set/list/undo`），始终曝光，执行端拒绝不可用情况；按 `.claude/rules/prompt-prefix.md:84` 先拿 Andy 的批准，并写清一次全对话缓存失效。
7. **回放改用结构化事实快照。** 不再解析 `model_input` 提示文本；限制条数/时间，异步/分页，失败显示“无法回放”，不阻塞规则创建；卡上标明“可能多报也可能少报”。
8. **测试按“生成器 + 消费者”成对做。** 注册表自动枚举类型，生成规则并跑正反例；测试文件必须进入实际 vitest 列表；为每个新字段补 producer/consumer 契约测试（DB、决策账本、网关、UI）；真实模型验收只作为记录，不进 `npm run check`。
9. **文档先行。** 新 ADR 写清工具集合变化、规则提议、整串范围（含不含更晚邮件）、撤销记忆、数据导出/删除；同步更新 `docs/agent-rulebook-inventory.md` 的 H-3/H-15 和 ADR 0209/0211 的后果。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
会。系统提示和邮件检查的固定说明可以不变；历史只追加；规则记忆如果走现有注入，只应出现在最后一条用户消息。但**新增工具定义会改变请求最前面的工具段**，按 `.claude/rules/prompt-prefix.md:27` 工具定义在系统提示和历史之前，所以老对话下一轮会因为“工具集合变了”整段换新、缓存从第一字节失效。这不是“只在末尾追加”，必须按规则第 84 条先取得 Andy 同意并留记录。若不想付这个代价，用后台规则抽取、不加聊天工具；若要加工具，合并成一个稳定工具并确保始终曝光。每轮变化的值（时间、样例、回放、`threadComplete`）只能放在最后一条消息或当轮工具结果里，不能进系统提示/工具定义。

**2. 同一段文字会不会在不同请求里变成不同字节？**
目前方案有多个风险点，需要显式修：
- `readOwnerRules`/`rule_list` 的 SQL 没有 `ORDER BY`，同一规则集可能以不同顺序出现；`floorHits` 数组也没有排序。
- `rule_id` 随机、回执卡/工具结果里的 `updated_at`、回放窗口“最近 30 天”都依赖时间；如果工具结果不是从幂等存储重放，而是每次重新生成，字节会变。
- `summary`/`quote` 是模型自由文本；同一逻辑规则在不同轮重写会不同，必须存第一次的规范结果或用确定性摘要。
- 参数列表没有去重/排序/大小写/Unicode 归一，同一组参数可能生成不同表达式。
- `quote` 比对如果一边用原始消息、一边用遮盖后消息，同一句话可能时而过、时而不中。
- 遮盖算法本身不变时，历史字节仍是确定的；但新规则类记忆如果重新生成 summary 再注入，会改变最后一条消息的内容。
建议：规范 JSON、按规则 id 排序、稳定 id、存下实际发出的工具结果、把遮盖后的证据字节作为唯一比对源。

**3. 有没有自动检查，反向用例真的会失败吗？**
有部分，但不够。现有可能失败的反向用例是“改坏例子/换表达式/换禁用函数”（`rule-registry.unit.test.ts:66-82`），这是好的；方案新增的“删掉测试文件，检查失败”只验证门能发现文件缺失，不验证规则逻辑。`check:rule-registry` 还是显式文件列表（`package.json:58`），新类型的测试文件不加入就不会运行；`describe` 字符串可以被一个空测试满足。真实模型验收不是确定性回归。需要补：注册表动态枚举并实际执行每个类型的正例/反例/非法参数；生成器模板改坏、排除条件删掉、`require_whole_thread` 不生效时门必须失败；未知类型/非法行/回放失败/撤销记忆/动态读取/并发/上限/推送语义各有独立测试；真实模型结果只进 `evals/` 记录。

**4. 每个新值的 producer/consumer 两端都能接受吗？**
不能逐个确认，方案至少漏了下面这些：
- `rule_id`：工具/撤销生产，DB 主键/历史/`ruleHits`/`floorHits`/`ruleIds`/决策 UI/网关消费；约束分别是 64、256、每封 16 条、500 条。随机 id 与幂等矛盾；没有字符模式校验；决策 UI 不认识 `owner:` 前缀的 origin。
- `type` / `type_version`：模型生产，注册表/生成器/裁判消费；没有版本，生成器变化后 `revision` 不能重现；未知类型直接跳过且没有 owner 提示。
- `params`：模型生产，生成器/例子/回放消费；没有规范化和排除项，验收③表达不了；单字符短语/重复/大小写/Unicode 未处理。
- `summary` / `quote`：模型生产，回执卡/设置页/`rule_list` 消费；没有长度/字符/分类限制，且明文进规则手册和历史。
- `status` / `revision`：`rule_set`/撤销/记忆触发器生产，裁判/读设置 SQL/UI 消费；没有 `proposed`，`needs_review` 照常执行；生成器版本没有进 revision；并发写可能丢修订号。
- `source_memory_id`：记忆写入生产，触发器和历史消费；`≤128`，用 `runId+toolCallId` 拼接可能超长；撤销没有反向更新记忆。
- `ruleHits` + `thread_incomplete`：邮件检查生产，决策账本校验/UI 消费；现有 `ruleHits` 语义是“抑制推送”，每封 16 条/每条 256 字符，原因格式未定义。
- `threadComplete` / 整串配置：读取器/启动配置生产，检查覆盖逻辑/账本/测试消费；配置键没有 schema/边界；每封 2000 字窗口会让“读全”经常为 false。
- `tests` 路径 / `RULE_TYPE_UNTESTED`：注册表生产，CI 消费；运行时依赖测试文件路径是反模式，生产包可能没有测试。
- 新工具名/capability ref/错误码：prompt-catalog/运行时/预检/工具结果/i18n 消费；改变 head，且错误码没有映射。
- 新网关命令：contracts/鉴权/网页/i18n 消费；撤销、确认提议、列出规则之外，还缺“重新确认”和提议过期/并发语义。
- 非法规则行的决策记录：读取路径生产，`decision_ledger` 的 `kind/outcome` 消费；没有合法 kind/outcome，且每次检查都写会造成放大。

结论：**“不改表”只对“把主人规则塞进 `rule_book_rules.parameters`”这一小步成立；只要要提议、类型版本、规范参数、撤销记忆，就必须改表或新增表。** 建议不要为了“不占改表排队”牺牲这些约束。
