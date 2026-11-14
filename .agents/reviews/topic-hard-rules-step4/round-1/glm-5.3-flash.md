# 方案：通知闸门收口到“发送前”，延后挂在既有重试机制上

## 一、前提（读到证实的内容）

**P1 五类推送统一在 `#collect` 入队、`#deliver` 发送，闸门目前完全不存在于发送路径**
`apps/agent-service/src/production-web-push.ts:397-428`（`#deliver` 只判过期、`kinds` 开关、`presence.anyVisible`，原话级代码：`if (!kinds.includes(item.kind)) → suppressed "WEB_PUSH_KIND_OFF"`；`if (visible) → suppressed`）。收集端：`:315-389`（提醒、审批、已结束任务、`proactive.listReady`、`museChannel.listActive`），与材料描述一致。

**P2 延后所需的“到点再试”机制已经存在：`web_push_attempts.status='pending'` + `next_attempt_at`**
`packages/persistence-sqlite/src/migrations/0058_web_push.sql:36-48`（`status IN ('pending','sent','suppressed','expired','gone','failed')`，`next_attempt_at TEXT`）；`sqlite-web-push-operations.ts:330-332` `listDue` 的过滤条件是 `a.status IS NULL OR (a.status = 'pending' AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= ?))`——即“pending 且 next_attempt_at ≤ now”天然就是一个“延后到某时刻”的队列，今天只被发送重试用（`production-web-push.ts:598-607` 的 `rate_limited`/重试写它）。

**P3 列表里的 `source_key` 已能区分五类**
前缀 `reminder:`、`approval:`（kind='approval'）、`run:`、`proactive:`、`muse-channel:`（`production-web-push.ts:326/336/351/362/373`）。

**P4 规则手册已有“设置→程序生成规则→裁判执行”的完整通路，且只挂了 `mail_item`/`mail_delivery` 两个闸门**
`rule-book.ts:489-498` `ruleBookFor(settings)` 由主人的设置（importantSenders、quietHours）加内置规则合成 `RuleRecord[]`；`rule-judge.ts:29-38` `decide(gate, facts, rules)`；`field-catalog.ts:9-12` `RULE_GATES = ["mail_item","mail_delivery"]`；`rule-book.ts:435-443` `GATE_OUTCOMES`（`mail_delivery` 只有 `defer_to_quiet_hours`）。裁判是纯 CEL 求值，不花 token（`rule-judge.ts` 全文，无任何模型调用）。

**P5 邮件的静默延后发生在“创建推送时”而非“发送时”**
`proactive-mail-check-service.ts:1591-1600`：`quietEnd(startedAt, rules, settings.quietHours, timeZone)` 算出 `readyAt`，同一时段合并成一条 `proactive_pushes`；`proactive-rules.ts:230-259` `quietUntil` 处理跨时段/跨天/DST。

**P6 “规则改过”目前以“每次检查重读”处理，裁判每次用最新规则**
ADR 0213 决定 4（`docs/adr/0213-owner-sentence-becomes-a-standing-rule.md:60`）：“邮件检查每次检查前读一遍，写入或撤销后下一次检查即生效”；`proactive-mail-check-service.ts:836-840` 每次合成 `[...ruleBookFor(settings), ...ownerRules, ...storedOwnerRules]`。

**P7 决策记录的 kind 有数据库 CHECK，加 kind 必须迁移；且已有“加一种 kind”的先例**
`migrations/0069_decision_ledger.sql:5-10`（kind CHECK 白名单）；`0091_decision_prereviews.sql` / `ports/decision-ledger.ts:32-40` 里 `rule_review` 就是后来加进去的（需要动 contracts-v2 三处、calibration、data-export schemas——grep `rule_review` 证实，`contracts-v2.ts:541/805/1102`、`data-export/schemas.ts:197`、`calibration/src/index.ts:31`）。

**P8 发给模型的内容只追加，且检查已有反向用例**
`.claude/rules/prompt-prefix.md:35`（第 4 条）、`:74`（"`npm run check:prompt-prefix`……它还带反向用例：改写历史里的用户消息、让系统提示带上每轮变化的值……检查都必须报告失败"）。

**P9 迁移现状**：最新迁移是 `0092_real_eval.sql`（glob 全目录证实），下一个改表迁移号用 0093。

---

## 二、方案

核心判断：**闸门不要放在“收集/入队时”，要放在“发送前”——`#deliver` 从 `listDue` 取到条目之后、`#send` 之前**。这一个位置选择把 ADR 0212 列出的三个死结全部消解，而且不需要给 `web_push_outbox` 加“延后到”列。

### 1. 闸门位置与共用方式

`#deliver` 的现有判断链是：过期 → kinds 开关 → 内容失效 → 主人正在看 → 发送。在“主人正在看”之前插入一步：用 `RuleJudge.decide("push_delivery", facts, rules)` 裁决。

- **新闸门 `push_delivery`**，字段目录给三个推送事实加三个时间事实：`push_kind`（`reminder|approval|run`）、`push_source`（`reminder|proactive|muse-channel|approval|run`，取自 `source_key` 前缀）、`local_minutes`/`local_weekday`/`local_previous_weekday`（与 `mail_delivery` 完全同一套定义，`field-catalog.ts:64-80`）。五类推送天然共用：所有条目都经过 `#deliver`，这就是“一道闸门”。
- **结果不新增**，`push_delivery` 允许的结果就一个：`defer_to_quiet_hours`（复用现有 `RuleOutcome`，少一串消费端要改）。第二种结果 `suppress_push`（“不推送但留在提醒页”）对推送而言就是现有 `suppressed` 状态（P1 里 kinds 关闭已经这么做了），先不开，等真有第二条规则需要它再加。
- **闸门代码兜底，不靠规则自觉**：在 `#deliver` 里硬编码“`push_source` 是 `approval` 或 `muse-channel` 的条目，无论裁判结果如何一律照常发送”。这与 `RuleJudge` 对金额字段的程序性保证同一风格（ADR 0212 决定 2：“这是程序保证，不靠规则作者写对”）。静默时段、出口遮盖、审批时限都是系统规则，用户规则碰不到。

### 2. 延后存在哪里

**复用 `web_push_attempts` 的 pending + `next_attempt_at`，不加列、不入第二张队列表。** 命中 `defer_to_quiet_hours` 时：对每条 subscription 记 `recordAttempt(status:'pending', attempts 不变, next_attempt_at = quietUntil(now, periods, timeZone), last_code:'WEB_PUSH_RULE_DEFERRED')`。此后 `listDue`（P2）自动在到点那一轮把它取回来；取回来时**重新裁决**（闸门每次发送前都跑），静默已过就发送，还在静默就把 `next_attempt_at` 推到新的 quietEnd（值没变就不写，避免每 10 秒一次空写）。规则被撤销/修订后，下一次裁决自然用新规则（P6 的同一语义搬到发送端），记录里写的是当时命中的 `规则id@修订号`。

“23:30 的提醒延到 07:00”这条路径之所以现在走得通而第 2 步走不通，是因为条目**已经在 outbox 里**，不受收集窗口约束；唯一剩下的是 `expires_at`（提醒 = remindAt+6h，`:331`）。延后时若 `quietEnd > expires_at`，对可延后的类别（reminder、run）把 outbox 的 `expires_at` 提升到 quietEnd（新增一个 store 操作 `extendExpiry`，只 UPDATE 现有列，不改表结构）。这是明确的行为变化，写 ADR、配测试。审批不延后，所以“待审批在静默里过期”不存在；“什么都别推送”吞掉审批卡被 P2 段的硬编码兜底挡死。

### 3. 三个已知问题的答案

- **已入队绕过闸门**：闸门在发送前，入队只是“素材进站”，任何已入队条目发送前必过闸门。结构性消除，不靠补丁。
- **6 小时窗口**：窗口只约束收集（`:304`），条目一旦入队，延后完全在 outbox/attempts 里流转；配合第 2 段的 expires_at 提升，23:30→07:00 能发出去。
- **审批过期**：审批条目不可延后（代码兜底），夜里照发；主人不想要夜间审批震动，只能靠设备端专注模式，这是产品取舍（见“需要拍板”）。
- **游标一次性消费的“任务完成”**：游标在 `#collect` 里推进（`:343-345`、`:380-386`），延后发生在入队之后，游标不需要回退，也不会重复消费。

### 4. 第一条真正作用于另外四类推送的规则（本步就做，避免没人用的代码）

**主人设置里给静默时段加一个开关：“静默时段也管提醒和任务结果的推送”**（默认关，行为与今天逐字节相同）。打开后 `ruleBookFor` 额外生成一条闸门为 `push_delivery` 的规则：表达式由程序按既有 `quietHoursExpression` 同款逻辑生成，`push_source in ["reminder","run","proactive"] && (静默时段)`（proactive 即邮件主动提醒的推送侧，与它创建时的 readyAt 延后互为两道闸：到点时若仍静默会再次延后，语义一致）；命中记录 `规则id@修订号`。规则内容是数据（时段存偏好、表达式程序生成、修订号随设置变更递增），执行是程序（CEL）。**不扩展规则类型注册表、不动 `rule_set` 工具**——那会改工具定义（`production-owner-rules.ts:170` 的 enum 由 `RULE_TYPES` 生成），违反本步“不改工具定义”约束；对话里一句话立“夜里别提醒我”留到下一步作为新规则类型做（见“拍板”）。

### 5. 决策记录

新增决策 kind `web_push`，outcome 先只给 `deferred`。按 P7 的 `rule_review` 先例走全套：ports `DECISION_KINDS`/`DECISION_OUTCOMES`、gateway contracts 三处、calibration、data-export schemas、sqlite 校验/写入/0093 迁移（重建 kind CHECK）。写入采用确定性 id（如 `web-push:{sourceKey}:{ruleRef}` 的哈希），配合 `insertLedgerRow` 已有的 `ON CONFLICT DO NOTHING`（`sqlite-decision-ledger-operations.ts:133`），每 10 秒一轮的重复裁决不会重复写行。`inputs.ruleIds` 沿用现有 idList 校验。

### 6. 网页可见与撤销

- **看懂**：设置页静默时段卡片下新增一行“也管推送提醒（夜里被延后的会等到静默结束）”；决策记录页（决策链抽屉）天然显示 kind=`web_push` 的条目和规则 id/修订号（同一展示通路，ADR 0213 决定 7 已打通“依据抽屉用规则手册说明”）。
- **撤销**：关掉开关 = 下一次裁决即恢复原行为（延后中的条目到点照发）；规则页/设置页可撤销该设置。每条推送条目上的“立即发送”按钮（清 `next_attempt_at`）列为可选增强，不进本步。
- **数字定义**：角标数字维持“即将推送的提醒 + 待审批”口径不变（`:306`），被延后的条目不计入、不闪烁——数字口径在 ADR 里写死并配验收。

### 7. 自动检查（问题 3 的回答载体）

- `check:rule-registry` 扩展：新闸门字段永远存在、`GATE_OUTCOMES` 对口、设置规则的程序生成正反向例子（静默内命中/边界分钟/跨天/关闭开关不命中）；**裁判兜底的反向用例**：表达式硬写 `push_source == "approval"` 或 `== "muse-channel"` 时，裁判结果仍被丢弃、照常发送（反向用例去掉兜底代码必失败）。
- 集成测试 `[HR-4]`：正向——静默开关开、23:30 收集到提醒 → 不发送、attempts 出现 `pending`+`next_attempt_at=07:00`、`last_code='WEB_PUSH_RULE_DEFERRED'`、决策记录有 `web_push` 条目含 `规则id@修订号`、到点发送；反向——默认关（所有五类行为与改动前一致）、审批和 Muse 中断静默期照发、规则撤销后延后中的条目到点照发、延后不越过审批/proactive 的自然过期（这两类不延后）、延后不会让重试计数增长。
- `check:prompt-prefix`、`check:model-ref-contract` 等既有门槛照跑：本步不触碰模型请求路径，其反向用例继续成立。

---

## 三、考虑过但不选的做法

1. **给 `web_push_outbox` 加 `deferred_until` 列（材料列的选项一）**。与 P2 的 pending 机制完全重复，多一次迁移、多一个两个来源都可能写的时间字段（谁写？重试还是规则？），还会出现“outbox 延后列与 attempts 重试列同时存在、取较早者”的双重语义。不选。
2. **不入队、等下次收集再取**。23:30 的提醒 07:00 再收集时已出 6 小时窗口（`:304`），条目直接丢失——这正是 ADR 0212 推迟的原因之一。要修就得把窗口改成“闸门感知”，比复用队列更绕。不选。
3. **复用 `proactive_pushes` 做全类延后队列**。它的语义是“邮件主动提醒的合成与退避”（`ready_at`、`status pending|enqueued`、同一时段合成一条），把审批、任务结果塞进去要给它加来源字段和去重逻辑，两端校验都要重写。不选。
4. **第一步骤把“夜里别提醒我”做成 `rule_set` 的新规则类型**。必须改 `rule_set` 的参数 enum（`production-owner-rules.ts:169-171`），违反本步约束；且工具定义变更会让老对话换新一次（允许但要有 ADR）。留给下一步，与规则页撤销一起做。
5. **延后在“创建时”算好一次存死**（邮件 readyAt 的做法推广到五类）。到点必须重新裁决的问题（规则中途改过）就答不上来，还是要存储裁决结果并处理失效；发送时裁决天然覆盖。不选。

---

## 四、风险与反例

- **反例 A（兜底失效）**：有人把“approval/muse 照发”写成由规则表达“只要表达式排除它们就行”。反向用例必须断言：表达式命中 approval 时仍然发送（P 段兜底在裁判之后）。
- **反例 B（延后吞掉时效）**：run 通知被延后 24 小时后仍发送一个过时的“任务完成”。约束：run/proactive 的 expires_at 提升上限 = 原 expires_at + 本次静默结束，且 run 通知延后超过 24h 的场景由 quietUntil 的自然上限（次日凌晨）兜住；测试断言延后不改变“过期即不发”的总闸。
- **反例 C（每 10 秒写一次库）**：裁决每轮都跑，若不加“值未变不写”会在静默期每 10 秒重写每条 attempts 行。测试断言静默期内 `updated_at` 不变（或写次数为常数）。
- **反例 D（邮件双重闸门）**：邮件创建时 readyAt 已延后、发送时又被判静默再延后一次。这是正确行为（主人中途加长了静默时段），但要测试这个“二次延后”路径并确认决策记录写的是新修订号。
- **presence 与闸门的顺序**：主人正在看页面时（`:422-425`）维持现有 `suppressed`，不进入延后——闸门排在它后面，行为不变。

---

## 五、需要人拍板的取舍

1. **审批推送是否接受“夜里照发”**。我建议不可延后（时效+低频+兜底简单），但如果 Andy 认为夜间审批震动不可接受，就得回答“延后期间审批过期了怎么办”——要么延后上限钳制到审批 expiresAt（到期前一刻发），要么接受过期并在提醒页标“审批已过期（被静默延后）”。
2. **`expires_at` 提升是行为变化**（延后中的提醒寿命从 remindAt+6h 变为静默结束），需要 Andy 同意写进 ADR。
3. **新决策 kind `web_push` 意味着一次改表迁移（0093）**，且要按 `rule_review` 先例同步 contracts/calibration/export 六处；若有人认为“推送闸门先只记 attempts、决策记录下一步再说”，则本步零迁移——但目标 2 明确要求决策记录，我按目标做。
4. **对话路径（rule_set 立“夜里别提醒我”）延后到下一步**，意味着本步主人只能从设置页开静默开关。若坚持对话闭环一步到位，就要接受工具定义变更 + 老对话缓存整段重建一次。

---

## 六、证实 vs 推测

**证实（文件:行）**：P1-P9 全部；`#deliver` 无规则判断（production-web-push.ts:397-428）；`listDue` 条件（sqlite-web-push-operations.ts:330-332）；`GATE_OUTCOMES`（rule-book.ts:435-443）；裁判无模型调用（rule-judge.ts）；`quietEnd`/`readyAt`（proactive-mail-check-service.ts:1591-1600）；决策 kind CHECK 与 rule_review 先例（0069:5-10、contracts-v2.ts:541）；检查清单（package.json:27,58,60）；rule_set enum 生成处（production-owner-rules.ts:150,170）。

**推测（需要实施时再核实）**：静默时段设置的具体存储表（proactive 设置读取在 sqlite-proactive-operations.ts:253-258 见到，写入端和 `check:settings-scope` 对新增键的限制未核实）；决策链网页对未知 kind 的容错（rule_review 加入时已趟过一遍，推测同样可行，未逐一读前端代码）；data-export 对 `web_push_attempts.last_code` 新取值字长校验通过（CHECK 为 1-64，代码字符串 23 字符，推测通过，未读 export verify 细节）。

---

## 七、逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会。本步只动 `production-web-push.ts`（推送服务，不构造任何模型请求）、规则包和 SQLite 层；不新增/修改系统提示、工具定义、历史消息或遮盖（前提 P8 的目录本步不触碰；方案刻意不扩 `rule_set` 工具）。发给模型的内容仍是只在末尾追加；每轮会变的值（时间、记忆）本来就都在最后一条消息，本步没有引入任何新的模型可见内容。推送侧新增的一切值（闸门事实、`next_attempt_at`、决策条目）都不进入请求字节。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。闸门事实里唯一的“会变的值”是 `local_minutes/local_weekday`，它只作为 CEL 求值输入存在，从不序列化进任何发给模型的内容；决策记录里的 `规则id@修订号` 是稳定字符串；新决策条目写入用确定性 id + `ON CONFLICT DO NOTHING`，重复裁决不产生重复或漂移的字节（P7、方案第 5 段）。集合（规则列表）沿用 `ruleBookFor` 的固定构造顺序（rule-book.ts:492-497）。

**3. 有没有对应的自动检查，反向用例会不会真失败？** 三层：`check:rule-registry` 扩展新闸门的字段/结果/例子正反向；`[HR-4]` 集成用例断言 pending+`next_attempt_at`、决策条目和“到点发送”，去掉闸门或去掉兜底时这些断言必然失败（行根本不会被写出）；既有的 `check:prompt-prefix` 反向用例与本步无交集、继续守护模型请求路径。反向用例都是“断言不存在的行/未写出的状态”，删除对应实现必然红。

**4. 每个新值，产生端和使用端都接受吗？（I-73 逐个核对）**
- 闸门 `push_delivery`：产生于 `field-catalog.ts` 的 `RULE_GATES`；消费端 `rule-expression.ts:39`（按目录注册变量）、`rule-book.ts:435`（`GATE_OUTCOMES` 同步加条目，`assertRuleShape:455-458` 拒绝对不上）、`check:rule-registry` 的全闸门遍历测试（rule-expression.unit.test.ts:97）。同包内同步改，typecheck 兜住。
- 结果 `defer_to_quiet_hours` 复用：不新增枚举值，`proactive-rules.ts` 的按结果过滤只在邮件闸门上跑，不受影响。
- 规则 id `push_quiet_hours`：产生于 rule-book；消费端 `rule-version.ts:33-39`（KIND_BY_ID 加条目）与决策链展示（`describeRuleVersion`）；MCP 读规则（production-mcp-read.ts:973 用 `ruleBookFor`）会多出这条——需要确认 MCP 契约对它的展示（**未核实**，标注为实施核对项）。
- `last_code='WEB_PUSH_RULE_DEFERRED'`：产生于 `#deliver`；消费端 `recordAttempt` 的 CHECK（长度 1-64，通过）、`listDue`（不解读 last_code）、数据导出（推测通过，未核实 verify 细节）。
- 决策 kind `web_push`：产生于 ports；消费端按 `rule_review` 先例逐处同步（contracts-v2 三处、calibration、data-export schemas、sqlite 校验/迁移、决策链 UI）——这正是 I-73 的教训清单，实施时以“每个消费点的测试都改到”为完成标准。
- 设置开关键：产生于设置页契约/偏好存储；消费端 `ruleBookFor` 与 `check:settings-scope`（**未核实** scope 检查对新增键的要求）。
