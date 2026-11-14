# 方案：把通知闸门放在发送点，用“设置派生的静默规则”做第一条规则

## 0. 结论

值得做，但**只在同时交付一条默认关闭、主人看得懂、能撤销的规则时**才值得；否则统一闸门就是没人用的代码。第一条规则建议是：

> **“把我已经设的静默时段，也用于邮件主动提醒和任务完成；你定时的到点提醒、审批、Muse 故障告警不受影响。”**

这条规则由**通知设置页的一个开关**产生，不从对话工具 `rule_set` 产生。原因是：只要往 `RULE_TYPES` 里加一种可对话创建的规则，`rule_set` 的工具定义枚举就会变，所有对话的请求开头都会变，违反本步“不改系统提示和工具定义”的约束。

---

## 1. 方案依赖的前提（已读代码或一手来源证实）

1. **五类推送已经在同一个出站表里，发送前只检查过期、类别开关、页面可见。**
   - `apps/agent-service/src/production-web-push.ts:399`：`const due = await store.listDue({ ownerId, agentId, now, limit: SEND_BATCH });`
   - 同文件 `:407`：`if (Date.parse(now) >= Date.parse(item.expiresAt)) {`
   - 同文件 `:411`：`if (!kinds.includes(item.kind)) {`
   - 同文件 `:422`：`if (visible) {`
   - 同文件 `:315`：`async #collect(`，`:358`、`:369` 分别收集 `proactive` 和 `muse`。

2. **提醒只有 6 小时窗口。**
   - `production-web-push.ts:19`：`const REMINDER_WINDOW_MS = 6 * 3_600_000;`
   - `:304`：`.filter(({ remindAt }) => Date.parse(now) - Date.parse(remindAt) <= REMINDER_WINDOW_MS);`

3. **出站表 `kind` 只有三种，且没有“延后到”列；重试表有 `next_attempt_at`。**
   - `packages/persistence-sqlite/src/migrations/0058_web_push.sql:26`：`kind TEXT NOT NULL CHECK (kind IN ('reminder', 'approval', 'run')),`
   - 同文件 `:43`：`next_attempt_at TEXT,`
   - `packages/persistence-sqlite/src/sqlite-web-push-operations.ts:331`：`AND (a.status IS NULL OR (a.status = 'pending'`
   - 同文件 `:332`：`AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= ?)))`

4. **邮件主动提醒已有自己的延后队列 `proactive_pushes`。**
   - `packages/persistence-sqlite/src/migrations/0062_proactive_checks.sql:93`：`ready_at TEXT NOT NULL,`
   - 同文件 `:95`：`status TEXT NOT NULL CHECK (status IN ('pending', 'enqueued')),`
   - `packages/application/src/services/proactive-mail-check-service.ts:1598`：`const readyAt = quiet ?? input.startedAt;`

5. **待审批过期由审批自身决定。**
   - `packages/application/src/services/approval-service.ts:61`：`if (now >= current.expiresAt) {`
   - `:66`：`resolution: "expired",`

6. **规则闸门目前只有邮件两个，结果表是固定的。**
   - `packages/application/src/rules/field-catalog.ts:9`：`export const RULE_GATES = ["mail_item", "mail_delivery"] as const;`
   - `packages/application/src/rules/rule-book.ts:442`：`mail_delivery: Object.freeze(["defer_to_quiet_hours"] as const),`

7. **对话工具的 `type` 枚举直接从 `RULE_TYPES` 生成。加规则类型就改工具定义。**
   - `packages/application/src/rules/rule-types.ts:202`：`export const RULE_TYPES: readonly RuleTypeDefinition[] = Object.freeze([`
   - `apps/agent-service/src/production-owner-rules.ts:150`：`types: readonly { ... }[] = RULE_TYPES,`
   - 同文件 `:170`：`enum: [...types.filter(({ tests }) => tests).map(({ id }) => id), SOFT_TYPE],`

8. **发给模型的内容只能追加，工具和系统提示按对话冻结。**
   - `.claude/rules/prompt-prefix.md:27`：“固定的在前，会变的在后。”
   - 同文件 `:28`：“每轮都会变的内容只放在最后一条用户消息里。”
   - 同文件 `:41`：“系统提示和工具按对话冻结”
   - 同文件 `:44`：“工具集合变了……才换新一次，并且每次都留记录。”

9. **设置派生的规则行不会自动进入模型的“主人要求”块；那块只读类别为 `rule` 的记忆。**
   - `packages/application/src/services/owner-profile-service.ts:205`：`eligible.filter((memory) => memory.attributes?.category === "rule"),`
   - 同文件 `:319`：`...rules.map(({ text }) => \`- ${text}\`),`

10. **第 2 步已经写明三个已知问题，并决定留到“第一条真会作用于四类推送的规则”时一起做。**
    - `docs/adr/0212-hard-rules-step2-amount-field-and-push-suppression.md:65`：“已入队项绕过闸门、提醒 6 小时窗口让‘23:30 延到 07:00’根本发不出去、审批在静默里过期、决策记录每轮重复写；而第 2 步没有任何会作用于这四类的规则。”
    - 同文件 `:66`：“静默默认只管邮件，其余四类行为不变。”

11. **没有测试的规则类型不得写入。**
    - `docs/adr/0213-owner-sentence-becomes-a-standing-rule.md:57`：“没有测试文件的类型写入时拒绝（`RULE_TYPE_UNTESTED`）”。

12. **当前迁移最新到 0092，新增改表步骤应接 0093。**
    - 目录核对：`packages/persistence-sqlite/src/migrations/0092_real_eval.sql` 存在，没有 0093。

13. **新表要登记进 schema catalog。**
    - `packages/persistence-sqlite/src/schema-catalog.ts:764` 起是 `web_push_outbox`、`web_push_attempts`、`web_push_feedback`、`web_push_cursors` 的登记。

14. **现有决策记录 `decision_ledger` 的 `kind` 是固定枚举，扩它要重建表并改多处契约。**
    - `packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:5`：`kind TEXT NOT NULL CHECK (kind IN ('proactive', 'memory_candidate', ...))`
    - 后续 `0089_consolidation_hold.sql` 等还整表重建过，说明扩它代价不低。

### 业界一手来源

- **Apple Focus**：可以按人和 App 允许/静默；时间敏感通知和紧急联系人可穿透。原话：“You can also turn on Time Sensitive Notifications, which allows all apps to send time-sensitive notifications immediately.”
  https://support.apple.com/guide/iphone/allow-or-silence-notifications-for-a-focus-iph21d43af5b/ios
- **Android Do Not Disturb**：可设时间规则、自定义模式、允许重复来电；关键通知始终显示。原话：“With any settings, critical notifications show. For example, you can't block system security notifications.”
  https://support.google.com/android/answer/9069335
- **Slack DND**：暂停通知但消息仍在，恢复后可回看；可设通知时间表；可给 VIP 或紧急消息开口子。原话：“You won't receive any notifications. Once you resume notifications, you can review any messages you received while you weren't actively looking at Slack.”
  https://slack.com/help/articles/214908388-Pause-your-Slack-notifications
- **PagerDuty Notification Rules**：按高/低紧急度配置通知频率和渠道，并可设置延迟。原话：“Notification rules determine how you are notified when an incident is assigned to you. This applies to both the frequency of notifications and the methods used...”
  https://support.pagerduty.com/docs/notification-rules
- **Gmail 过滤器**：声明式条件加动作，但只影响新邮件，不按时间延后。原话：“When you create a filter to forward messages, only new messages will be affected.”
  https://support.google.com/mail/answer/6579

---

## 2. 方案

### 2.1 闸门放在哪里、怎么跨五类共用

**放在 `#deliver`，不放在 `#collect`。**

- `#collect` 只负责把五类来源变成出站项并入队，继续 `ON CONFLICT DO NOTHING`。
- `#deliver` 对 `listDue` 取出的每一条**在发送前**调用一个统一的 `WebPushGate`：
  1. 过期检查；
  2. 类别开关 `kinds`；
  3. 规则闸门；
  4. 内容是否仍有效；
  5. 页面可见；
  6. 发送。
- 这样，**已经入队的历史行也会经过闸门**，不再绕过。规则改了、时间到了，也在发送点重新算，不依赖入队时刻。

`WebPushGate` 放在 `packages/application/src/services/web-push-gate.ts`，只做纯判断：

输入：`push_class`、当前时间事实（`local_minutes`、`local_weekday`、`local_previous_weekday`）、当前规则手册。
输出：`{ action: "deliver" | "defer" | "suppress", deferUntil?, ruleRefs }`。

它内部调用真实 `RuleJudge.decide("push_delivery", facts, rules)`，不复制判断逻辑。

### 2.2 第一条规则是什么、怎么产生

第一条规则：**“把我设的静默时段也用于邮件主动提醒和任务完成”**。

- 新闸门：`push_delivery`。
- 新字段：`push_class`（`scheduled_reminder`、`approval`、`run_result`、`mail_reminder`、`muse_outage`），由 `sourceKey` 前缀固定映射。
- 新结果表：`push_delivery` 允许 `defer_to_quiet_hours` 和 `suppress_push`；不新增 `RuleOutcome` 名称。
- 新规则 id：`push_quiet_hours`，由 `writeSettings` 写进现有 `rule_book_rules`，参数 `{periods, classes}`，表达式由程序生成：
  - `push_class in ["mail_reminder", "run_result"] && (静默时段表达式)`
- 默认 `false`，设置页开关关闭。关闭时不生成这条规则。
- 不新增 `RULE_TYPES` 条目，不新增对话工具枚举值。因此 `rule_set` 的工具定义不变。
- 设置页沿用现有静默时段编辑器；开关打开后，编辑时段会同时推进 `quiet_hours` 和 `push_quiet_hours` 的修订号。关闭时把 `push_quiet_hours` 置为 `retired`，并把受它延后的出站项 `defer_until` 置为 `now`，下一轮重新裁决。

这样既满足“规则内容是数据，执行是程序”，又避免改模型请求开头。

### 2.3 延后的通知存在哪里

**存在 `web_push_outbox`，加列；不另开队列，也不复用 `proactive_pushes`。**

迁移 `0093_web_push_gate.sql`：

```sql
ALTER TABLE web_push_outbox ADD COLUMN defer_until TEXT;
ALTER TABLE web_push_outbox ADD COLUMN gate_outcome TEXT NOT NULL DEFAULT 'deliver'
  CHECK (gate_outcome IN ('deliver', 'defer', 'suppress'));
ALTER TABLE web_push_outbox ADD COLUMN gate_rule_refs TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(gate_rule_refs) AND json_type(gate_rule_refs) = 'array');
ALTER TABLE web_push_outbox ADD COLUMN gate_decided_at TEXT;

CREATE INDEX web_push_outbox_defer_index
  ON web_push_outbox(owner_id, agent_id, defer_until);

CREATE TABLE web_push_gate_decisions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256),
  decided_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('defer', 'suppress', 'deliver')),
  defer_until TEXT,
  rule_refs TEXT NOT NULL CHECK (json_valid(rule_refs) AND json_type(rule_refs) = 'array'),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64)
) STRICT;
```

`web_push_gate_decisions` 是追加式决策记录，每次 `deliver → defer`、`defer` 目标变化、`deliver → suppress`、规则解除后重新 `deliver` 写一行；同一状态不重复写。每行 `rule_refs` 存 `规则id@修订号`，排序、去重、最多 16 条。这样满足“闸门命中写规则 id 和版本号”，又不把已经高度受限的 `decision_ledger` 再重建一次。

`listDue` 增加 `(o.defer_until IS NULL OR o.defer_until <= ?)`，并把新列带出来。推荐 `defer_until` 到点前不返回；当规则被修改/关闭/撤销时，把受影响的 `defer_until` 置为 `now`，下一轮立刻重新裁决。这样既不会每 10 秒重扫全部延后项，也不会因为规则改了还等到旧时间。

### 2.4 三个已知问题怎么解决

1. **已入队推送绕过闸门**
   闸门放在 `#deliver`，所有出站行（包括迁移前已入队的行）发送前都经过它。旧行默认 `gate_outcome='deliver'`、`defer_until=NULL`，第一条规则默认关闭，所以上线时行为不变。

2. **提醒 6 小时窗口**
   延后时把该行的 `expires_at` 改为 `max(原 expires_at, defer_until + 1 小时)`，并设上限：最多从当前时间延后 24 小时，超过则按原过期处理。到点后 `#content` 仍会重读提醒状态、记忆状态、任务线程标题、邮件内容、Muse 是否仍中断；源已经失效就记 `expired`，不会硬发旧内容。

3. **审批在静默时段里过期**
   `approval` 和 `muse_outage` 是不可触碰类：即使规则表达式命中，也直接忽略规则命中，按原逻辑走。到点审批仍有效就发；已过期就按现有逻辑记 `expired`，不会因为“静默”而悄悄吞掉。

4. **任务完成游标一次性消费**
   游标问题不因延后而改变：`#collect` 仍然只把每个已结束任务入队一次并推进游标；延后的是出站行本身。任务完成在出站表里有独立 `sourceKey`，延后 24 小时内不会丢；超过上限按过期处理。不需要改游标表。

### 2.5 哪些推送受规则管、哪些不可触碰

| `push_class` | `sourceKey` 前缀 | 第一条规则默认作用 | 用户规则可否延后 | 用户规则可否不推送 |
|---|---|---|---|---|
| `scheduled_reminder` | `reminder:` | 否（主人明确的到点指令） | 将来明确指定才可以 | 将来明确指定才可以 |
| `approval` | `approval:` | 否 | **永不允许** | **永不允许** |
| `run_result` | `run:` | 是 | 允许 | 允许；建议 `failed`/`unconfirmed` 不允许吞掉 |
| `mail_reminder` | `proactive:` | 是（邮件创建时已有自己的静默延后，闸门可再延后） | 允许 | 允许 |
| `muse_outage` | `muse-channel:` | 否 | **永不允许** | **永不允许** |

边界例子：

- 主人自己设的 06:30 提醒：第一条规则不作用，仍然 06:30 推。
- 待审批在 23:30 出现、03:00 过期：立即推，不延后。
- Muse 中断在夜里：立即推。
- 任务失败：建议不允许 `suppress_push`，但可被明确规则延后；这条需要 Andy 拍板。
- 出口遮盖、沙箱、权限审批：不属于推送闸门，规则碰不到。

### 2.6 网页上怎么让主人看懂并能撤销

1. **设置页**：在现有静默时段下面加一个开关：
   - “静默时段也延后其他提醒”
   - 说明：“会延后：邮件主动提醒、任务完成。不会延后：你定时的提醒、审批、Muse 告警。”
   - 关闭时立即解除由它产生的延后，下一轮重新裁决。

2. **通知记录**：在通知设置里加“最近被延后/被拦下的通知”列表，数据来自 `push.status.read` 扩展的 `gateItems`（或新查询 `push.gate.read`）。每条显示：
   - 类别（邮件提醒/任务完成/到点提醒）；
   - 来源标题（敏感内容按现有遮盖规则显示，不新增泄露路径）；
   - 原因：“静默时段规则，将在 07:00 再提醒” 或 “按规则不推送，仍保留在提醒页”；
   - 规则说明和版本；
   - 操作：
     - 延后项：“现在提醒”；
     - “撤销这条规则”：设置派生的规则关闭开关；将来的主人规则走现有 `memory.rule.respond` 撤销；
     - “查看规则”跳到规则/通知设置。
3. **数字和判断词定义**：
   - “延后到 T”：`defer_until = T`，T 是命中的静默规则中 `quietUntil(now, periods, timeZone)` 的最大值；开始含、结束不含，跨午夜按前一天星期几。
   - “被拦下”：`gate_outcome='suppress'`，没有发出推送，但出站项和决策记录仍在，来源页仍可见。
   - “照常推送”：`gate_outcome='deliver'` 且发送结果为 `sent`。
   - “撤销”：规则置为 `retired` 或开关关闭，受影响项的 `defer_until` 置为 `now`，下一轮重新裁决。

### 2.7 迁移、结果类型、规则类型注册表

- **迁移**：要，`0093_web_push_gate.sql`。这是本步唯一的改表步骤，接在 0092 后。
- **结果类型**：不新增 `RuleOutcome` 名称；只把 `push_delivery` 加进 `RULE_GATES`、`RULE_FIELD_CATALOG`、`GATE_OUTCOMES`，允许 `defer_to_quiet_hours`、`suppress_push`。`RuleJudge` 的跳过金额规则逻辑不受影响。
- **规则类型注册表**：本步**不扩** `RULE_TYPES`。`push_quiet_hours` 是设置派生规则，不是对话可创建类型。若以后要支持主人说“夜里别提醒我”直接生成规则，需要新增 `RuleTypeDefinition`、测试文件、`check:rule-registry` 标签，并且必然改 `rule_set` 工具定义；那是一次单独的、需要 Andy 同意的 prompt 换新，不混在本步。

### 2.8 需要新增/修改的值（先给清单，Q4 逐项核对）

- 新 gate：`push_delivery`
- 新字段：`push_class`
- 新规则 id：`push_quiet_hours`
- 新设置字段：`quietHoursForPushes`（存成 `rule_book_rules` 行，不新增列）
- 新出站列：`defer_until`、`gate_outcome`、`gate_rule_refs`、`gate_decided_at`
- 新表：`web_push_gate_decisions`
- 新原因码：`WEB_PUSH_RULE_DEFER`、`WEB_PUSH_RULE_SUPPRESS`
- 新网关数据/命令：`gateItems`、`push.gate.release`（如果做“现在提醒”）
- 新 i18n 文案：开关、记录列表、`push_quiet_hours` 规则说明（zh-CN/en/ja）

---

## 3. 考虑过但不选的做法

1. **只在 `#collect` 做闸门**
   不选。已入队项会绕过；规则改了也无法在发送时重新裁决。ADR 0212 已经点出这个问题。

2. **延后项不入队，等下一次收集再取**
   不选。任务完成游标是一次性消费；提醒有 6 小时窗口；还要处理 `proactive.markEnqueued` 和重复去重。出站项已经在表里，直接加 `defer_until` 更简单。

3. **复用 `proactive_pushes` 存所有延后**
   不选。它是邮件专用（`insight_ids`、`pending|enqueued`），无法表达审批、任务、Muse；跨来源耦合会让邮件检查服务和推送服务互相依赖。

4. **复用 `web_push_attempts.next_attempt_at` 当延后**
   不选。它是**每设备**的，不是每通知的；延后期间新订阅的设备没有 attempt 行，会立刻收到；规则命中信息也没有地方放，UI 无法解释。

5. **新增 `defer_until` 结果类型，让规则直接写时间**
   本步不选。第一条只是静默时段，现有 `defer_to_quiet_hours` 够用；让规则写绝对时间要引入时间运算，风险和测试面更大。将来要“延后 2 小时”再单独设计。

6. **现在就把 `push_quiet_hours` 加进 `RULE_TYPES`，让主人一句话创建**
   本步不选。`rule_set` 的 `enum` 由 `RULE_TYPES` 生成（`production-owner-rules.ts:170`），加类型就改工具定义，所有对话请求开头变一次。需要 Andy 明确接受一次换新，另出 ADR。

7. **把闸门决策写进现有 `decision_ledger`**
   本步不选作为默认。`decision_ledger` 的 `kind` 是固定枚举，扩它要重建表并改多处契约（0069、0087、0088、0089 都动过它），风险比新增一张专用追加表高。若产品上必须只有一个“决策记录”入口，可以改选它，但要接受重建和全链路核对成本。

8. **夜里直接“不推送”，不延后**
   不选第一条。Slack DND 的做法是暂停通知但消息仍在，恢复后可回看；延后更符合“别在夜里吵我，但早上告诉我”。以后可以再加显式 `suppress_push` 类型。

9. **默认静默时段直接管五类**
   不选。会让主人自己设的 06:30 提醒被推到 07:00，审批可能在静默里过期，Muse 故障告警被吞；违反目标 3。

10. **用模型提示词/记忆来记住“夜里别提醒我”**
    不选。硬规则必须程序执行，且模型调用花 token；这条规则完全不需要模型。

---

## 4. 风险和反例

- **时区/夏令时/跨午夜**：`quietUntil` 已有跨午夜和 DST 处理，但新规则必须复用同一套 `zonedParts`/`quietUntil`，不能另写一套。反例：`23:00–07:00` 在 06:59 应延后、07:00 应发出；跨夏令时当天不能少算一小时。
- **提醒延后超过 6 小时**：会改变“提醒只在 6 小时内有效”的既有语义。必须把 `expires_at` 和上限写进 ADR，并在 UI 显示真实计划时间；源已取消/已完成时到点仍要 `expired`。
- **规则命中多条**：`suppress_push` 优先于 `defer_to_quiet_hours`；多个延后取最晚结束时间；`rule_refs` 只记前 16 条但所有规则仍执行。需要测试。
- **新设备订阅**：被 `suppress` 的通知必须按项终止，不能因为新设备没有 attempt 行而重新发送；`gate_outcome='suppress'` 存在出站项上，新设备也直接跳过。
- **页面可见时刻撞上延后结束**：现有逻辑会把“页面可见”记成 `suppressed` 并且不再重试，延后项可能因此丢失。建议对 `gate_outcome='defer'` 的项，在可见时改为短延后（例如 5 分钟）而不是终止；这是对既有行为的局部修正，需要写进 ADR 和测试。
- **任务失败/结果未确认是否可被吞掉**：如果允许 `suppress_push`，可能把“命令结果没确认”这种安全告警藏掉。建议至少对 `run_result` 的 `failed`/`unconfirmed` 禁止 suppress，是否禁止 defer 由 Andy 定。
- **审批类别开关**：`kinds` 是现有用户设置，仍可以关掉审批推送。它和“用户规则不能吞掉审批”不是一回事；是否也要让审批绕过 `kinds` 是产品取舍，本方案不改。
- **失败重试与延后叠加**：发送失败后在 `next_attempt_at` 重试，若此时进入静默，闸门应再次延后；测试要覆盖“重试中进入静默”的顺序。
- **新表/新 id 没进清单**：新表不进 `schema-catalog`、新 rule id 不进 `rule-version`/i18n、新设置字段不进网关契约，都会出现“一端认、一端不认”的 I-73 类问题。见 Q4。

---

## 5. 需要 Andy 拍板的取舍

1. **第一条规则的创建入口**：设置页开关（推荐，本步不改工具定义） vs 对话里说“夜里别提醒我”（需要改 `rule_set` 工具定义并接受一次全量换新）。
2. **不可触碰范围**：只保护审批 + Muse（推荐，最小改动） vs 也保护任务失败/结果未确认（更安全，但会限制主人自定义）。
3. **任务失败是否可延后**：可延后但不可吞掉（推荐） vs 完全不可触碰。
4. **决策记录位置**：新增 `web_push_gate_decisions`（推荐，风险低） vs 扩展现有 `decision_ledger`（统一入口，但要重建表和改多处契约）。
5. **被拦下的旧通知能否“现在提醒”**：只允许撤销规则、旧的不复活（推荐，简单且不重置 attempt） vs 允许逐条复活（需要重置 attempt，测试面更大）。
6. **第一条规则是否包含主人自己设的到点提醒**：不包含（推荐，符合目标 3） vs 包含（“夜里别提醒我”字面上更彻底，但会改变明确指令）。

---

## 6. 必答问题

### Q1. 会不会改变模型已经见过的请求开头？

**不会。** 这个改动不新增/修改系统提示、工具定义、历史消息、资料块或遮盖结果。闸门只读数据库里的规则和推送来源，运行在模型调用之后；发给模型的内容仍然只在末尾追加。每轮会变的 `now`、`local_minutes`、`defer_until` 只存在于推送进程、SQLite 和推送记录里，不进入模型请求。

依据：`.claude/rules/prompt-prefix.md:27`“固定的在前，会变的在后”，`:28`“每轮都会变的内容只放在最后一条用户消息里”，`:41`“系统提示和工具按对话冻结”。

**唯一会破坏这一点的做法**是把 `push_quiet_hours` 加进 `RULE_TYPES`：`production-owner-rules.ts:170` 的 `enum` 直接来自 `RULE_TYPES`，工具定义会变，所有老对话下一次请求开头会变。本方案故意不做，留到需要时的单独 ADR。

### Q2. 会不会让同一段文字在不同请求里变成不同字节？

**模型侧不会**，因为这段文字根本不进模型请求。

推送/记录侧需要保证确定性：

- `rule_refs` 在写入前按 `规则id@修订号` 排序、去重，不依赖 `RuleJudge.hits` 的返回顺序或数据库顺序。
- `push_class` 由 `sourceKey` 前缀经固定映射产生，不用对象遍历顺序。
- `web_push_gate_decisions` 和 `gateItems` 按 `decided_at, source_key` 固定排序。
- `defer_until`/`decided_at` 用 ISO 8601 固定格式。
- 不把 `Set`、数据库 `SELECT` 的自然顺序直接序列化进 JSON。
- 推送正文不加入决策时间；同一 `sourceKey` 的 `tag` 仍由 `sourceKey` 哈希，延后不改字节。

时间字段会因决策时刻不同而不同，但那是“调度值/记录值”，不是同一段模型文本的字节变化。

### Q3. 有没有对应的自动检查，反向用例真的会失败？

有，需要新增：

1. `test/integration/production-web-push-gate.test.ts`，用**真实 SQLite + 真实迁移 + 真实 `RuleJudge`/`quietUntil`**，只沿用现有 `FakeSender` 传输桩：
   - 默认关闭：五类推送行为与改动前一致。
   - 打开第一条规则：邮件提醒、任务完成在 23:30 延后到 07:00；审批、Muse、主人 06:30 提醒照常。
   - 已入队旧行：先入队再打开规则，发送前仍被闸门拦住。
   - 提醒 6 小时：23:30 的提醒能活到 07:00；源取消则到点记 `expired`。
   - 审批在静默里：立即推送或按自身过期，不被延后。
   - 任务完成：游标只消费一次，延后后只发一次。
   - 规则修改/关闭/撤销：延后项重新裁决，不重复发送。
   - 新设备：被 `suppress` 的项不会因新订阅而重新发送。
   - 反向用例：删掉“审批/Muse 保护”后上述审批用例必须失败；删掉 `expires_at` 延长后提醒用例必须失败；只在 `#collect` 做闸门后旧行用例必须失败；不重置 `defer_until` 后规则修改用例必须失败。
2. `check:rule-registry`：给 `push_quiet_hours` 加正反例（静默开始/结束边界、跨午夜、星期几、`approval`/`scheduled_reminder` 不命中）；改错 gate/outcome/表达式必须失败。
3. 迁移契约测试：`0093` 对所有旧行给出 `gate_outcome='deliver'`、`gate_rule_refs='[]'`、`defer_until IS NULL`；三种 `gate_outcome` 都能写入；非法 JSON、非法 outcome 被 SQL 拒绝。
4. 网关契约测试：`push.status.read` 的 `gateItems`、`push.gate.release`、`quietHoursForPushes` 在写端和读端都能通过；未安装该操作的实例隐藏入口。
5. 提示词门槛：`npm run check:prompt-prefix` 仍通过；再加一条断言：`ownerRuleToolDescriptors()` 的 `type.enum` 不含 `push_quiet_hours`，防止本步误改工具定义。`check:prompt-catalog` 不应有 diff。
6. I-73 型端到端：把 `writeSettings` 实际写出的 `rule_book_rules` 行，依次喂给 `readSettings → ruleBookFor → RuleJudge → 决策记录 → UI 契约`，证明两端都认。

说明：受工具限制，我没有运行这些测试；以上是设计，不是已执行结果。

### Q4. 每个新值，生产它的地方和使用它的地方都能接受吗？

逐项核对如下（这是本方案的核心风险清单）：

| 值 | 产生处 | 使用处 | 两端校验/检查 |
|---|---|---|---|
| gate `push_delivery` | `field-catalog.ts` 的 `RULE_GATES` | `compileRuleExpression`、`RuleJudge`、`GATE_OUTCOMES`、`ruleBookFor` | `rule-registry.unit.test.ts` 已断言每条规则 gate 在 `RULE_GATES`；`assertRuleShape` 校验 outcome 表；新增 gate 必须同时加进字段目录和结果表 |
| `push_class` 五个值 | `production-web-push.ts` 的固定前缀映射 | 规则 facts、决策记录、UI 列表、`push_quiet_hours` 表达式 | 类型用联合类型；穷举 switch；未知前缀走 `unknown` 且不命中用户规则；测试每个前缀 |
| 规则 id `push_quiet_hours` | `writeSettings` 写 `rule_book_rules` | `readSettings`、`ruleBookFor`、`RuleJudge`、`rule-version.ts` 的 `RULE_KINDS`/`KIND_BY_ID`/`rebuild`、决策链、三份 i18n | `rule_book_rules` 只校验长度 1–64；但 `rule-version` 不认就会显示“其他/查不到”。必须同时加 `RULE_KINDS` 和 zh-CN/en/ja 的 `decision.chain.rule` 分支 |
| `quietHoursForPushes` | 通知设置写入 `ProactiveSettings` | `writeSettings`、`readSettings`、`proactive-overview`、网关 `proactiveSettingsSchema`、控制中心 `proactiveSettings()` | 写端校验 boolean；网关契约读写都带该字段；UI 读写一致；关闭时规则 retired 并释放延后项 |
| `defer_until` | `WebPushGate` 计算，`setGate` 写入 | `listDue` 查询、`#deliver`、UI 通知记录、`prune` | SQL 侧 `valid()` 校验 ISO；迁移列可空；测试 `defer_until <= now` 与 `> now` 两条路径 |
| `gate_outcome` 三值 | `WebPushGate` | SQL CHECK、`#deliver` 分支、UI | 迁移 CHECK 和代码联合类型同一枚举；三种值都有写入测试 |
| `gate_rule_refs` | `ruleRef(id, revision)`，排序去重后写 | SQL JSON CHECK、决策表、UI 规则说明 | `ruleRef` 限长 240；规则 id 长度 64；JSON 数组校验；不得超过 16 条；UI 解析 `id@revision` |
| `web_push_gate_decisions` | `SqliteWebPushOperations` | `push.status.read`/`push.gate.read`、UI | 新表必须进 `schema-catalog.ts`；`source_key` 长度、`reason_code` 长度、`rule_refs` JSON 都两端校验 |
| `push.gate.release` / `gateItems` | 控制中心命令/查询 | `PRODUCTION_WEB_PUSH_OPERATIONS`、`contracts-v2`、`installedGatewayV2Operations`、控制中心 | 命令名和 payload 必须在网关契约和安装清单都出现；否则 UI 入口会藏起来或后端拒绝 |
| `WEB_PUSH_RULE_DEFER` / `WEB_PUSH_RULE_SUPPRESS` | `#deliver` 写 `recordAttempt.lastCode` | `recordAttempt` 的 1–64 长度校验、UI 原因显示 | 常量长度检查；UI 对未知 code 有回退文案 |
| 迁移号 0093 / 新表 | 迁移文件 | `loadBundledMigrations`、`schema-catalog`、迁移契约测试 | 0092 后连续；同一时间只做这一个改表步骤 |

**I-73 的教训落实方式**：不是只看 diff，而是把“生产出来的值”实际交给“消费它的校验”跑一遍。最小集合是：

- `rule_book_rules` 写入的中文摘要、`push_quiet_hours` id、`periods` 参数，必须能被 `readSettings` 读回、被 `ruleBookFor` 生成规则、被 `RuleJudge` 执行、被 `rule-version` 显示、被三份 i18n 渲染。
- 决策记录里的 `rule_refs` 必须能通过 `web_push_gate_decisions` 的 JSON 校验、UI 的 `id@revision` 解析、规则说明查询。
- 新网关命令和字段必须同时出现在契约、安装清单和控制中心。

**未核实**：`service-main.ts` 里 `ProductionWebPush` 实际传入的 `timeZone` 和规则读取接线、`contracts-v2` 对 `push.status.snapshot` 是否允许新增字段的完整校验、控制中心 `memory.rules` 与通知设置的现成数据流，我没有逐行读完；落地前要补这三处。
