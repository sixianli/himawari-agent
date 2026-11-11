# 方案：用户硬规则第 2 步（通知闸门与金额字段）

## 0. 结论先行

我建议不要把 `proactive_pushes` 直接扩成“五类推送通用延后表”，也不要复用 `web_push_attempts.next_attempt_at`。更干净的边界是：

1. **新增一个纯函数式的 `NotificationGate`**，放在 `packages/application/src/notifications/`，由 `production-web-push.ts#collect` 在 `store.enqueue` 前调用，`#deliver` 在真正发送前再调用一次。
2. **延后状态放在两层**：
   - `web_push_outbox` 新增 `not_before`，表示“最早什么时候可以发”；
   - 新增只追加的 `notification_decisions`，记录每次裁决的结果、命中的规则 id、修订号和结果。
   - `proactive_pushes` 继续只做邮件批处理，不承担五类通用延后。
3. **金额规则放在通知闸门**，按“邮件 insight”逐条计算；金额存进已有的加密 `contentRef`，不新增明文金额列。
4. **静默时段只保留一份实现**：从 `proactive-rules.ts` 抽出 `QuietHoursPolicy`，由裁判和 `quietUntil` 共用；`AttentionPolicyService` 里的 UTC 偏移版 `isQuietHours` 删除或改为注入同一个策略。
5. **默认只让提醒、任务完成、邮件主动提醒受静默时段管**；待审批和 Muse 中断建议默认不静默，或者只在“不会在静默结束前过期”时延后。这一条需要 Andy 拍板。

---

## 一、方案依赖的前提

以下“原话”来自仓库文件或一手网页；行号按当前提交 `979a3121`。

| 编号 | 前提 | 来源与原话 |
|---|---|---|
| P1 | 会话请求只能追加，固定的在前、会变的在最后 | `.claude/rules/prompt-prefix.md:27`：“固定的在前，会变的在后。顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。”；`:28`：“每轮都会变的内容只放在最后一条用户消息里。”；`:35`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。” |
| P2 | 后台调用也遵守“固定在前、数据在中、当前时间在最后” | `.claude/rules/prompt-prefix.md:67`：“后台调用也是固定的在前、会变的在后。整理记忆、判断邮件、起对话标题这类调用，先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。” |
| P3 | 五类推送都走 `#collect`，最后统一 `store.enqueue` | `apps/agent-service/src/production-web-push.ts:315` 开始 `#collect`；`:382` `await store.enqueue({...})`；`:397` 开始 `#deliver`；`:407-424` 只判断过期、`kinds`、`presence.anyVisible`，没有静默或规则判断。 |
| P4 | 出站表只有三种 kind，邮件主动提醒和 Muse 中断借 `reminder` + `source_key` 前缀区分 | `packages/persistence-sqlite/src/migrations/0058_web_push.sql:26`：“kind TEXT NOT NULL CHECK (kind IN ('reminder', 'approval', 'run'))”；`production-web-push.ts:358-379`：`proactive:` 和 `muse-channel:` 都写 `kind: "reminder"`。 |
| P5 | 邮件主动提醒已有自己的延后队列，按 `ready_at` 合并 | `packages/persistence-sqlite/src/migrations/0062_proactive_checks.sql:89-99` 建 `proactive_pushes(id, ready_at, insight_ids, status…)`；`proactive-mail-check-service.ts:1298`：“`const readyAt = quiet ?? input.startedAt;`”；`:1299`：“`const pending = quiet ? await store.pendingPush({ ...scope, readyAt }) : undefined;`”。 |
| P6 | 裁判已经返回 id、修订号、结果，但邮件决策记录只落了 id | `packages/application/src/rules/rule-judge.ts:29`：“`hits.push(Object.freeze({ id: rule.id, revision: rule.revision, outcome: rule.outcome }));`”；`proactive-rules.ts:55-62` 的 `floorHitIds` 只返回 id；`sqlite-proactive-operations.ts:723-742` 只写 `ruleIds` 和 `floorHits`。 |
| P7 | 结果类型只有两种；字段缺失会直接报错 | `packages/application/src/rules/rule-book.ts:4`：“`export type RuleOutcome = "raise_floor" \| "defer_to_quiet_hours";`”；`field-catalog.ts:9`：“`export const RULE_GATES = ["mail_item", "mail_delivery"] as const;`”；`rule-expression.ts:141-142`：整数字段缺失或非整数时抛错。 |
| P8 | 规则表对 rule_id、parameters、source 有长度/JSON 校验；读设置只读静默和重要发件人 | `0086_rule_book.sql:4`：“`rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 64)`”；`:6`：“`parameters TEXT NOT NULL CHECK (json_valid(parameters) AND json_type(parameters) = 'object')`”；`:8`：“`source ... BETWEEN 1 AND 256`”；`sqlite-proactive-operations.ts:240-241` 只 `find` `QUIET_HOURS_RULE_ID` 和 `IMPORTANT_SENDER_RULE_ID`。 |
| P9 | 邮件判断提示词目前没有金额字段 | `packages/prompt-catalog/src/mail.ts:31`：“`只输出 JSON，格式：{"items":[{"id":"…","result":"…","confidence":"…","todo":"…","priority":null,"dueAt":null,"reason":"…"}]}`”；`proactive-mail-check-service.ts:469-496` 只解析 id/result/confidence/priority/usedMemoryIds/todo/reason/dueAt。 |
| P10 | 邮件判断的固定提示在前，邮件数据和当前时间在后 | `proactive-mail-check-service.ts:385-406`：`MAIL_JUDGMENT.text` → 记忆段 → `MAIL_JUDGMENT_ITEMS_HEADER.text` → 邮件 JSON → `MAIL_JUDGMENT_NOW`；`mail.ts:62-76` 的 `MAIL_JUDGMENT_NOW` 含 `now/timeZone/today`。 |
| P11 | 现有“地板规则”的事实只取主题和摘要，不取正文 | `rule-book.ts:95-107` 的 `mailItemFacts`：“`const text = `${item.subject}\n${item.snippet}`;`”。金额如果只在正文里出现，现有钱相关词规则看不到。 |
| P12 | 当前只有内置规则被测试要求“该命中/不该命中”；用户设置派生的规则例子为空 | `rule-book.ts:198-209` 的 `importantSenderRule` 写 `examples: Object.freeze([])`；`:236-247` 的 `quietHoursRule` 同样为空；`packages/application/test/rule-registry.unit.test.ts:31-40` 只对 `BUILT_IN_RULES` 检查 hit/miss。 |
| P13 | `AttentionPolicyService` 里另有一份 UTC 偏移版静默判断，生产组装未见到实例化 | `packages/application/src/services/attention-policy-service.ts:71-80` 的 `isQuietHours` 用 `utcOffsetMinutes`；`:209-215` 命中静默时把 `NOTIFY` 降为 `DIGEST`。当前 grep 只看到测试夹具 `apps/agent-service/test/fixtures/local-composition-root.ts:202` 和测试文件使用；未做全仓逐文件核实。 |
| P14 | 决策账本 `inputs` 是 JSON，可扩展；但写入校验只接受字符串数组 | `0069_decision_ledger.sql:21`：“`inputs TEXT NOT NULL CHECK (json_valid(inputs) AND json_type(inputs) = 'object')`”；`sqlite-proactive-operations.ts:643-681` 的 `validateInputs` 对 `ruleIds`、`floorHits` 做了数组/长度校验。 |
| P15 | I-73 的教训：产生的值必须逐个过所有使用方的校验 | `docs/incidents-and-gates.md:112`：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」”。 |

### 业界一手来源

- **Web Push 的 TTL 与 urgency**：RFC 8030 §5.2 要求 TTL，且“Once the TTL period elapses, the push service MUST NOT attempt to deliver the push message”；§5.3 的 urgency 表把 `high` 对应到“incoming phone call or time-sensitive alert”。<https://www.rfc-editor.org/rfc/rfc8030.html>。这支持“延后必须带过期时间”和“待审批这类时间敏感通知不能和普通提醒一样处理”。
- **通知分类与用户可控的打扰级别**：Android 8.0 起每个通知必须属于 channel，“Users can change these settings and decide which notification channels from your app can be intrusive or visible”，并且“All notifications, regardless of importance, appear in non-interruptive system UI locations, such as in the notification drawer and as a badge”。<https://developer.android.com/develop/ui/views/notifications/channels>。这支持按类别决定是否静默，以及“不推送但仍留在页面”。
- **金额用最小单位整数**：Stripe 官方文档：“All API requests expect `amount` values in the currency's minor unit”，“`10` to charge 10 JPY (or any other zero-decimal currency)”。<https://docs.stripe.com/currencies#zero-decimal>。这支持“整数最小单位 + ISO 币种”，不能用浮点数。
- **延后任务要带 ETA 和过期**：Celery 官方文档：“The ETA … lets you set a specific date and time that is the earliest time at which your task will be executed”，并支持 `expires`：“When a worker receives an expired task it will mark the task as REVOKED”。<https://docs.celeryq.dev/en/stable/userguide/calling.html#eta-and-countdown>。这支持“not_before + 原有过期时间”，而不是只存一个 `ready_at`。
- **提示词缓存按字节匹配前缀**：Anthropic 官方文档 <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>、OpenAI 官方文档 <https://developers.openai.com/api/docs/guides/prompt-caching>。本仓库规则 `.claude/rules/prompt-prefix.md:6` 也写明“匹配是逐字节的：开头任何一处变了，从那里往后全部按全价重算”。

---

## 二、方案本身

### 2.1 闸门、结果类型和共用方式

**新增闸门 `notification`，逐步替换 `mail_delivery`。**

`mail_delivery` 这个名字只适合邮件；要跨五类推送，建议把 `RULE_GATES` 改成：

```ts
["mail_item", "notification"]
```

静默规则的 gate 从 `mail_delivery` 改为 `notification`。**这里不需要数据迁移**，因为 `rule_book_rules` 只存 `rule_id` 和 `parameters`，gate 是代码按规则 id 派生的，不存库。旧测试里的 `mail_delivery` 全部改到 `notification`，ADR 0210 写明改名。

`notification` 闸门的字段目录：

| 字段 | 类型 | 说明 |
|---|---|---|
| `kind` | string | `reminder` / `approval` / `run` / `proactive_mail` / `muse_outage` |
| `local_minutes` | int | 主人时区当地分钟数，0–1439 |
| `local_weekday` | int | 0–6 |
| `local_previous_weekday` | int | 0–6 |
| `amount_minor` | int | 金额绝对值的最小单位整数；未知时固定为 `0` |
| `amount_currency` | string | 大写 ISO 4217；未知时固定为 `""` |
| `amount_confidence` | string | `sure` / `unsure` / `unknown` |

**关键点：字段永远不省略，未知用显式哨兵值。** 这样既保留 ADR 0209 “字段缺失或类型不对时直接报错”的约定，又不会让“金额读不出来”变成无法求值。金额规则必须自己写：

```cel
kind == "proactive_mail" &&
amount_confidence == "sure" &&
amount_currency == "JPY" &&
amount_minor >= 0 &&
amount_minor < 50000
```

也就是“只有确定读出的金额才允许被这条规则处理”。`unsure` 和 `unknown` 都不命中，默认照常推送。

**结果类型扩展：**

```ts
export type RuleOutcome =
  | "raise_floor"
  | "defer_to_quiet_hours"
  | "keep_in_page";
```

- `raise_floor`：只用于 `mail_item`，保持现有语义。
- `defer_to_quiet_hours`：通知闸门延后到静默结束。
- `keep_in_page`：不推送，但源记录继续留在产品页面（邮件 insight、提醒、审批、线程等）。

**裁决优先级必须写死并测试：**

```text
keep_in_page > defer_to_quiet_hours > 默认照常推送
```

同一闸门内如果同时命中多个规则，记录全部命中；延后时间取所有 `defer` 结果中最晚的；`keep` 一旦出现就不推送。`raise_floor` 在 `notification` 闸门不参与优先级。这样用户可以同时看到“金额低于门槛”和“静默时段”两条规则，而不是只看到其中一个。

### 2.2 闸门放在哪里

**应用层服务：`NotificationGate`。**

输入：`now`、`NotificationKind`、主人时区、当前规则本、可选的金额事实、原始过期时间。输出：`{ action: "deliver"|"defer"|"keep", deferUntil?: string, hits: RuleHit[] }`。

调用点：

1. **`production-web-push.ts#collect`**：为每个候选通知调用一次，决定是否入队、入队时 `not_before` 是多少。
2. **`production-web-push.ts#deliver`**：真正发送前再调用一次，处理“入队后规则改了”的情况。
3. **邮件检查阶段**：只做金额抽取和存储，不在这里决定“是否推送”；金额规则统一在 `#collect`/`#deliver` 的通知闸门里按 insight 计算。这样不会在邮件检查、通知入队、发送三处出现三套金额判断。

`#deliver` 里要注意：同一个 `source_key` 可能对应多个订阅，**闸门结果按 `source_key` 缓存一次**，不能对每个订阅重复写决策记录或得出不同结论。

### 2.3 五类推送怎么映射

不要给 `web_push_outbox.kind` 增加第四种值。`WebPushKind`、`web_push_subscriptions.notify_*`、`readKinds`、网关契约都依赖现有的 `reminder|approval|run`。在闸门内部用一个独立的 `NotificationKind` 映射：

| outbox kind / source_key | 闸门 kind |
|---|---|
| `reminder` 且 `source_key` 以 `proactive:` 开头 | `proactive_mail` |
| `reminder` 且 `source_key` 以 `muse-channel:` 开头 | `muse_outage` |
| 其余 `reminder` | `reminder` |
| `approval` | `approval` |
| `run` | `run` |

这个映射只存在于通知闸门和 `notification_decisions`，不改变出站表的 `kind` 约束。I-73 的要求是：如果一定要新增 outbox kind，必须同步改 `0058` 的 CHECK、`WebPushKind`、`readKinds`、订阅开关、网关契约和界面；本方案选择不碰这条链。

### 2.4 延后存在哪里：新表 + outbox 新列，不直接复用 `proactive_pushes`

**不直接复用 `proactive_pushes` 的原因：**

- 它的主键是 `id`，但自然键是 `(owner, agent, ready_at)` 附近的批处理；`insight_ids` 只对邮件有意义。
- 它的 `status` 只有 `pending|enqueued`，没有“被规则拦下”“已过期”“已抑制”。
- 它的 `ready_at` 语义是“邮件批处理的就绪时间”，不是“单条推送最早可发时间”。
- 五类推送里只有邮件有 insight 批处理；审批、提醒、任务完成、Muse 中断没有 `insight_ids`。

**建议的存储：**

1. `web_push_outbox` 增加：

```sql
ALTER TABLE web_push_outbox ADD COLUMN not_before TEXT;
CREATE INDEX web_push_outbox_not_before_index
  ON web_push_outbox(owner_id, agent_id, not_before);
```

`listDue` 增加条件：

```sql
AND (o.not_before IS NULL OR o.not_before <= ?)
```

旧行 `not_before` 为 `NULL`，行为不变，立即到期。写入时由应用层校验 ISO 时间；不要让字符串比较遇到非规范格式。

2. 新增只追加表 `notification_decisions`：

```sql
CREATE TABLE notification_decisions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256),
  kind TEXT NOT NULL CHECK (
    kind IN ('reminder','approval','run','proactive_mail','muse_outage')
  ),
  decided_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('deliver','defer','keep_in_page','expired','suppressed')
  ),
  defer_until TEXT,
  rule_hits TEXT NOT NULL CHECK (
    json_valid(rule_hits) AND json_type(rule_hits) = 'array'
  ),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
  CHECK ((outcome = 'defer') = (defer_until IS NOT NULL))
) STRICT;
```

`rule_hits` 的元素形如 `[{"id":"quiet_hours","revision":2,"outcome":"defer_to_quiet_hours"}]`，按 `id`、`revision`、`outcome` 排序后序列化。**不要把邮件的金额或正文放进这张表**；金额留在加密的 `contentRef` 里，这里只记录规则命中。

3. **`proactive_pushes` 只补一个状态**：如果一次邮件批处理里的所有 insight 都被 `keep_in_page` 拦下，不能把它标成 `enqueued`（那表示已经进了出站队列），建议把 `status` 扩为 `pending|enqueued|suppressed`，并加 `suppressed_at`。这需要重建 `proactive_pushes` 表或新增表；如果不想动这个表，也可以保持 `pending` 但用 `notification_decisions` 判断“已处理”，但这样每次 `listReady` 都会重复处理，不建议。

### 2.5 到点重新裁决，规则改过怎么办

**结论：到点时用当前规则本重新裁决，不复用入队时的旧结论。**

- 入队时：记录一条 `notification_decisions`，`outcome=defer`，`defer_until=...`，并把 outbox 的 `not_before` 设为该时刻。
- 到点后：`#deliver` 重新读当前规则本，重新算事实，再调用一次闸门。
  - 现在允许：发送，记录 `outcome=deliver`。
  - 现在仍然静默：把 `not_before` 推到新的 `defer_until`，记录新的 `defer`，不增加发送重试次数。
  - 现在命中 `keep_in_page`：不发送，记录 `keep_in_page`，源记录继续留在页面。
  - 已过期：记录 `expired`，不发送。
  - 规则被删除/退休：不再命中，按默认“照常推送”处理；如果此时仍在静默，则继续静默规则。
- 每次重新裁决都追加新记录，不修改旧记录。这样用户可以看到“原来因为第 2 版规则延后到 7:00，后来规则改成第 3 版，改成留在提醒页”。

**防止死循环和丢失：**

- `defer_until` 必须 `> now` 且 `< expires_at`。如果静默结束晚于原始过期时间：
  - 待审批：建议立即发送（时间敏感，见 2.7）；
  - 提醒/任务完成/邮件：可以记录 `expired` 或 `keep_in_page`，但不要无限延后；
  - Muse 中断：建议不静默。
- `quietUntil` 现有最多 8 跳；如果 8 跳后仍未找到结束点，记录一个 `NOTIFICATION_DEFER_UNRESOLVED`，按“照常推送”或“留在页面”中的安全策略处理，不能原地每 10 秒重试。
- 规则被改得更早/更晚时，`not_before` 可以前移或后移；界面要显示最新 `defer_until`，并提供“现在发送”撤销入口。

### 2.6 金额字段

#### 从邮件读出

在 `MAIL_JUDGMENT` 的输出 JSON 里增加一个字段，建议形态：

```json
"amount": null
```

或

```json
"amount": {"value":"1234.56","currency":"JPY","confidence":"sure"}
```

不要让模型直接输出最小单位整数，因为模型很容易在 JPY（0 位小数）、KWD（3 位小数）、带千分位/逗号的数字上算错。让模型输出**它看到的十进制金额字符串 + ISO 币种 + 置信度**，程序做确定性换算。

提示词规则：

- 只允许从当前邮件的主题、正文、摘要里取金额；不要从 `related`、附件文件名、引用历史里取。
- 只取“主人需要支付/被扣款/退款/账单到期金额”这一类主金额；如果邮件里有多个不同金额且无法确定哪个是主金额，`amount: null`。
- `bodyTruncated:true` 或 `bodyUnavailable:true` 时，置信度不得为 `sure`；程序也会再降级一次。
- 促销价、积分、优惠券、运费、税额、分期每期金额都不算主金额，除非邮件明确说这是应付款。
- 金额字段只对 `act`、`know`、`check` 有意义；`ignore` 可以写 `null`，减少输出 token。

#### 程序解析和存储

`parseJudgements` 新增对 `amount` 的严格解析：

1. `value` 必须是字符串，只允许数字、千分位逗号/空格、一个小数点；不允许负号（如果要支持退款，取绝对值并另存方向；第一版建议只存绝对值）。
2. `currency` 必须匹配 `^[A-Z]{3}$`，并在一份固定的 ISO 4217 允许清单内。
3. 用 ISO 4217 的 minor unit 指数把十进制字符串精确换算成整数，不使用浮点数乘法。例如 JPY 指数 0，USD 指数 2，KWD 指数 3。可以参考 Stripe 的“minor unit”说明，但不要依赖 Stripe 的币种支持列表作为业务真相；运行时用固定的 ISO 4217 表或 `Intl.NumberFormat(..., {style:"currency", currency})` 的 `maximumFractionDigits`，并对特殊币种写测试。
4. 结果必须是安全整数；超过 `Number.MAX_SAFE_INTEGER` 或小数位超过该币种指数时，整条金额降级为 `unknown`，不要截断。
5. 最终存成：

```ts
{
  minor: number,        // 0 表示未知，不代表“0 元”
  currency: string,     // "" 表示未知
  confidence: "sure" | "unsure" | "unknown"
}
```

6. **存储位置**：放进 `source_insights.contentRef` 指向的加密 JSON，和 `summary`、`reason`、`floorHit` 并列，不新增明文金额列。理由：金额属于财务信息，现有正文本来就在加密内容里；新增明文列会扩大敏感数据面，还要改迁移、读模型和 UI 契约。
7. 旧 insight 没有 `amount` 字段时，读取端一律当作 `{minor:0, currency:"", confidence:"unknown"}`，不要报错。

#### 规则里怎么引用

金额规则是 `notification` 闸门上的生成规则，例如：

```ts
amountThresholdRule(thresholds, revision)
```

参数只存：

```json
{"thresholds":[{"currency":"JPY","minor":50000},{"currency":"USD","minor":500}]}
```

表达式由代码生成，例如：

```cel
kind == "proactive_mail" &&
amount_confidence == "sure" &&
(
  (amount_currency == "JPY" && amount_minor >= 0 && amount_minor < 50000) ||
  (amount_currency == "USD" && amount_minor >= 0 && amount_minor < 500)
)
```

结果 `keep_in_page`。这样：

- 金额确定且低于该币种门槛：不推送，留在提醒页。
- 金额确定且达到/超过门槛：规则不命中，默认照常推送。
- 金额 `unsure`/`unknown`：规则不命中，默认照常推送。
- 币种不在主人配置里：规则不命中，默认照常推送。
- 金额等于门槛：按“达到门槛就推送”的语义，不命中 `<`，照常推送；边界要写测试。

如果 Andy 的语义是“超过门槛才提醒、低于门槛完全不显示”，那结果应该是 `keep_in_page` 还是连提醒页也不留，需要先定义；我建议第一版只做“不推送但留在提醒页”，因为这样不会漏掉付款。

#### 字段缺失怎么算

写入 ADR 0210 和字段目录：

> `amount_minor`、`amount_currency`、`amount_confidence` 永远存在。未知时分别是 `0`、`""`、`"unknown"`。任何使用金额的规则必须先判断 `amount_confidence == "sure"`；不判断的规则在规则注册检查中直接拒绝。

这条比“字段缺失就报错”更适合金额，因为“读不出来”是业务上的正常状态，不是程序错误。它同时满足“金额不确定时照常推送”。

### 2.7 哪些推送类别受静默时段管

我的建议（需要 Andy 确认）：

| 类别 | 默认是否受静默时段管 | 理由 |
|---|---|---|
| 到点提醒 `reminder` | 是 | 用户自己设的提醒，通常可以等到早上；但不能超过原有过期时间。 |
| 任务完成 `run` | 是 | 完成通知不紧急，静默结束再发。 |
| 邮件主动提醒 `proactive_mail` | 是 | 现有行为已经是静默延后，保持。 |
| 待审批 `approval` | **默认否，或“只在不会过期时延后”** | 审批会阻塞 Agent，且 `expiresAt` 可能就在静默期间；延后到静默结束可能导致审批已过期、任务白等。RFC 8030 把 time-sensitive alert 归为 high urgency，支持这类通知不走普通打扰级别。 |
| Muse 通道中断 `muse_outage` | **默认否** | 这是系统健康告警，不是主人可等的人际提醒；静默 8 小时会掩盖连接中断。若坚持延后，至少要在产品内立即显示持久横幅。 |

如果 Andy 要求“五类都受静默管”，也可以做，但建议在静默规则里加 `kind in [...]` 的例外，而不是在 `#collect` 里硬编码判断；这样用户以后可以在规则页看到并修改。

**边界例子（必须进测试）：**

- 本地时间 `22:59:59`、`23:00:00`、`06:59:59`、`07:00:00`：开始含、结束不含。
- 跨夜时段 `23:00–07:00`，星期一只在前一天有定义时 `local_previous_weekday` 命中。
- 跨夏令时：春季跳 1 小时、秋季回 1 小时；结束时间仍按本地墙上时间算。
- 半小时/45 分钟时区：`Asia/Kolkata`、`Asia/Kathmandu`。
- 多段静默、重叠静默：取最晚结束时间。
- `start == end`：现有实现视为“不静默”；存储层也拒绝保存，两者要一致。
- 静默结束晚于 `expires_at`：审批立即发/提醒过期/邮件留在页面，三种类别分别测试。
- 规则在延后期间被改：从 `defer` 改为 `keep`、从 `defer` 改为无规则、从 `defer` 改为更晚；都要追加决策记录。
- 主人时区在延后期间改变：重新按新时区计算 `defer_until`，不能沿用旧时间。
- `defer_until == now`：应发送，不应再次延后。

### 2.8 两份静默时段实现怎么合成一份

现有：

- `proactive-rules.ts:64-82` 的 `quietEnd`：先 `RuleJudge.decide("mail_delivery", local facts)`，命中 `defer_to_quiet_hours` 后用 `quietUntil` 算结束时间。
- `attention-policy-service.ts:71-80` 的 `isQuietHours`：单个窗口 + UTC 偏移，不读规则手册，且生产未实例化。

建议：

1. 新建 `packages/application/src/rules/quiet-hours.ts`（或放在 `rules/`）：
   ```ts
   export interface QuietHoursDecision {
     readonly quiet: boolean;
     readonly until: string | null;
     readonly hits: readonly RuleHit[];
   }
   export function decideQuietHours(
     at: string,
     rules: readonly RuleRecord[],
     periods: readonly ProactiveQuietPeriod[],
     timeZone: string,
   ): QuietHoursDecision;
   ```
   内部只做一次 `RuleJudge.decide("notification", localFacts, rules)`；如果命中 `defer_to_quiet_hours`，用 `quietUntil` 算结束。`proactive-rules.ts` 的 `quietEnd` 改为调用它；通知闸门也调用它。
2. 删除 `AttentionPolicyService` 的 `quietHours` 配置和 `isQuietHours`，改为可选注入 `isQuiet(now): boolean` 的端口；如果确认生产没有使用，也可以直接删除这段逻辑，把测试改为覆盖新的 `decideQuietHours`。`local-composition-root.ts:202` 的 `quietHours: null` 同步删掉。
3. 现有 `quietUntil`、`zonedParts`、`zonedTime` 保留为唯一的时间计算实现；`quietEnd` 只作为兼容包装。
4. 保留 `rule-book-legacy-equivalence.unit.test.ts` 的对照：三个时区、跨夏令时、每 29 分钟一个时刻，新实现与迁移前实现一致。这样“只有一份实现”不是靠删测试，而是靠同一组对照数据证明。

### 2.9 迁移 0087 怎么设计

建议一个迁移文件 `0087_notification_gate.sql`：

1. `web_push_outbox` 加 `not_before` 和索引。
2. 新建 `notification_decisions`（只追加；更新/删除触发器参照 `rule_book_history_no_update/no_delete`）。
3. 重建 `proactive_pushes`，把 `status` 扩为 `pending|enqueued|suppressed`，加 `suppressed_at`，保留旧数据。如果不想重建，可以新增 `proactive_push_settlements` 表，但那样又多一张表；我倾向于重建，因为 `proactive_pushes` 没有外键指向它，风险较小（这一点需要跑迁移契约测试确认）。
4. 不新增金额列；金额继续在 `source_insights.contentRef` 的加密 JSON 里。
5. 不新增 `rule_book_rules` 列；金额门槛作为新 `rule_id='amount_threshold'` 的 `parameters` 对象存在现有表里，`parameters` 形状例如 `{"thresholds":[...]}`。
6. 更新 `migration-engine.ts` 的迁移列表和 `schema-catalog.ts` 的表清单。
7. 迁移契约测试要读旧库：旧 `web_push_outbox` 行 `not_before` 为空、旧 `proactive_pushes` 行状态为 `pending`，迁移后都能正常 `listDue`/`listReady`。

**结果类型扩展的迁移面：**

- `RuleOutcome` 加 `keep_in_page`。
- `notification_decisions.outcome` 的 CHECK 包含 `keep_in_page`。
- 网关契约/界面枚举如果展示通知决策，要包含 `deliver|defer|keep_in_page|expired|suppressed`。
- `RuleHit` 已经带 `revision`，不需要改结构；需要把 `floorHitIds` 改成保留 revision，或在旁边新增 `floorHitRecords`。
- `DECISION_RULE_CATALOG` 目前只认识三个地板 id（`proactive-rules.ts:33-47`）；如果决策记录开始出现 `quiet_hours`、`amount_threshold`，这个函数会返回 `undefined`。要么扩展 catalog，要么让读取端能处理未知规则 id。这是 I-73 类问题，必须一起改。

### 2.10 用户能看到、能撤销

每个 `notification_decisions` 记录至少要让界面能显示：

- 这条推送是什么类别、指向哪个页面；
- 现在是“已发送”“延后到什么时候”“留在页面但没推送”；
- 命中了哪条规则、第几版；
- 一键“现在发送”（把 `not_before` 设为 now 或立即触发一次投递）；
- 一键“不要推送，留在页面”（写一条 `keep_in_page` 决策）；
- 一键“修改规则”（跳到静默时段/金额门槛设置；这一步可以留到第 4 步，但第 2 步至少要能撤销单次延后）。

对“留在提醒页”要逐类确认产品页面是否存在：

- 邮件：`proactive` insight 页，已有。
- 到点提醒：记忆提醒页，已有。
- 待审批：审批列表，已有。
- 任务完成：对应线程，已有。
- Muse 中断：**未核实**是否有持久页面；如果没有，第一版不应允许 `keep_in_page`，只能 `deliver` 或 `defer`，否则用户会完全看不到中断。

---

## 三、考虑过但不选的做法

| 做法 | 不选的原因 |
|---|---|
| 直接把 `proactive_pushes` 扩成五类通用延后表 | 它的 `insight_ids`、`ready_at`、`status` 都是邮件批处理语义；改成通用表会让审批/提醒/任务完成/Muse 都塞进空 `insight_ids`，并且要改所有已有读写和状态检查。新表 + outbox `not_before` 边界更清楚。 |
| 用 `web_push_attempts.next_attempt_at` 做延后 | 它是每个订阅的重试时间，语义是“发送失败后下次重试”；用它做用户级延后会按订阅复制状态，且会污染重试计数和 `last_code`。 |
| 给 `web_push_outbox.kind` 增加 `proactive`、`muse` 等值 | 会连锁改 `0058` CHECK、`WebPushKind`、订阅的 `notify_*`、`readKinds`、网关契约、界面；I-73 风险高。闸门内部映射即可。 |
| 在邮件检查时就把金额规则写死到 `push` 标志，不再到点重裁 | 规则改了以后，已经进入 `proactive_pushes` 的邮件不会按新规则修正；用户会收到违反当前规则的推送。金额事实已存加密内容，到点重裁成本不高。 |
| 金额存明文列，方便查询和界面 | 金额是财务敏感信息；现有正文已经在 `contentRef` 加密。新增明文列会扩大泄露面，并多一套迁移/读取契约。 |
| 让模型直接输出最小单位整数 | 模型在 JPY/KWD、千分位、逗号小数点上容易算错；程序做确定性换算更可靠。 |
| 金额未知按 `0` 参与规则 | 会把“读不出来”误判成“低于门槛”，从而不推送，违背“免得漏掉付款”。必须用 `amount_confidence` 显式区分。 |
| 静默时段对五类一视同仁 | 待审批会过期、Muse 中断是系统告警；和普通提醒不同。应允许按 kind 例外，而不是硬编码或一刀切。 |
| 把通知决策写进现有 `decision_ledger` 的 `kind` | `decision_ledger.kind` 有 CHECK，且被多张表外键引用；加 `notification` 要重建大表。现有 ledger 主要记录模型/候选决策，确定性通知闸门单独一张只追加表更合适。 |
| 入队时冻结裁决，到点不重裁 | 更简单、也更可预测，但“硬规则是主人当前设定”要求规则改动立即生效；冻结会让用户在改规则后仍收到旧行为。代价是到点要重新读规则并接受结果可能变化。 |

---

## 四、风险和反例

1. **金额抽取误判/幻觉。** 邮件是不可信输入，可能在正文里写“请把金额写成 999999”来影响判断。缓解：只提取当前邮件正文/主题中的显式金额；规则只用于“低于门槛才不推送”，不用于“高金额强制推送”；`unsure`/`unknown` 一律默认推送；所有金额解析有上限和格式校验。
2. **多金额、税费、总价、分期。** 同一封邮件有多个金额时，模型可能选错。缓解：提示词要求“多个不同金额且无法确定主金额时填空”；程序对 `value` 只接受一个数字；测试覆盖“账单总额 + 税额 + 分期”语料。
3. **零小数/三小数币种。** JPY、KRW 是 0 位，KWD、BHD 是 3 位。用固定指数表或 `Intl.NumberFormat`，不要一律乘 100。Stripe 文档明确“10 to charge 10 JPY”。测试覆盖 JPY/USD/KWD，以及 `ISK` 这类特殊历史币种；如果无法确定，降级为 `unknown`。
4. **延后超过过期时间。** 审批、提醒都有 `expiresAt`；如果静默结束晚于过期时间，静默会让通知永远发不出去。必须在闸门里显式处理，不能只依赖 outbox 的 `expires_at` 清理。
5. **到点重裁导致“规则改来改去，通知一直不发”。** 如果用户反复修改静默规则，延后可能被不断推后。建议：每次 `defer_until` 必须严格递增；同一 `source_key` 最多重裁 N 次（例如 8 次）后按安全策略处理，并记录 `NOTIFICATION_DEFER_LIMIT`。
6. **静默结束时的通知风暴。** 邮件批处理已经按 `ready_at` 合并，但提醒/任务完成/审批可能同时到点。建议在 `#deliver` 现有 `SEND_BATCH=50` 之外，按 `kind` 或 `source_key` 做合并/限速；至少不要因为延后把几十条通知在同一秒全发出去。
7. **`keep_in_page` 对没有页面的类别等于静默丢失。** 尤其 Muse 中断；必须先确认产品页面，否则只能 `deliver` 或 `defer`。
8. **规则例子为空。** 现有 `importantSenderRule` 和 `quietHoursRule` 的 `examples` 是空数组，`assertRuleExamples` 对空数组直接通过。要求“每条规则自带该命中/不该命中”目前并未真正落实。新增金额规则必须带例子；同时建议补上现有两条生成规则的例子，并在测试里要求 `examples` 至少各有一个 hit 和 miss（`rule-registry.unit.test.ts:31-40` 目前只对 `BUILT_IN_RULES` 做这个检查）。
9. **`DECISION_RULE_CATALOG` 不认识新规则 id。** 它目前只有三个 `floor_*`；如果决策记录写入 `quiet_hours` 或 `amount_threshold`，`decisionRuleDefinition` 返回 `undefined`，界面可能显示空规则名或报错。要么扩展 catalog，要么读取端显式处理未知 id。
10. **模型输出变长导致截断。** `amount` 会给每封邮件多几个 token；当前 `PROACTIVE_MAX_OUTPUT_TOKENS=4096`，批量邮件时可能更容易触发 `MODEL_OUTPUT_TRUNCATED`。建议只对 `act`/`know`/`check` 输出 amount，`ignore` 不输出；并补一个“输出截断后缩小批次”的测试。
11. **`mailItemFacts` 不读正文。** 现有钱相关词地板规则只看主题和摘要（`rule-book.ts:95-107`），正文里的金额不会触发它。新金额字段应覆盖正文；如果金额规则只依赖地板规则，会漏掉正文金额。
12. **`readSettings` 的规则顺序不确定。** 它用 `SELECT ... WHERE status='active'` 没有 `ORDER BY`；`RuleJudge` 返回顺序可能随数据库返回顺序变化。决策记录要排序；规则本生成也要固定顺序。
13. **时区变更。** 延后中途主人时区改变，`defer_until` 要按新时区重算；否则用户会在错误时间收到通知。测试要覆盖 `Asia/Tokyo` → `America/Los_Angeles`。
14. **静默规则和 `quietUntil` 参数漂移。** 表达式由 `periods` 生成，`quietUntil` 也用 `periods`；如果以后允许自由表达式表达静默，`quietUntil` 无法知道自由表达式的结束时间。第一版要把 `defer_to_quiet_hours` 限定为“由代码生成的静默规则”，自由规则以后用显式的 `defer_until` 结果字段。

### 和业界成熟做法不一致的地方

- **把待审批和普通提醒一起静默**：Android 的 channel 机制允许用户按类别控制打扰级别，RFC 8030 把 time-sensitive alert 归为 high urgency；成熟系统不会把所有通知当成同一等级。本方案建议按 `kind` 区分。
- **只存 `ready_at` 不存过期语义**：Celery 的 ETA 明确“earliest time”，并配合 `expires` 把过期任务标为 REVOKED；RFC 8030 的 TTL 也要求过期后不得再投递。本方案保留原 `expires_at`，延后不得越过它。
- **金额用浮点或字符串直接比较**：Stripe 明确 API 金额是 currency minor unit 整数；本方案用整数最小单位 + ISO 币种。
- **以为“不推送”就等于“用户看不到”**：Android 文档说明即使低重要性通知也会出现在通知抽屉/角标；本方案要求 `keep_in_page` 必须有真实产品页面，否则不能使用。
- **把规则变更后的旧裁决冻结**：这不是业界统一做法，更多是产品取舍；本方案选择“到点按当前规则重裁”，并把每次裁决留痕，避免用户改规则后仍收到旧行为。

---

## 五、需要 Andy 拍板的取舍

1. **待审批是否受静默时段管？** 我建议默认不受，或“静默结束前会过期就立即发”；否则审批可能过期，Agent 白等。
2. **Muse 通道中断是否受静默时段管？** 我建议默认不受；如果要延后，必须先在产品内有持久显示，否则会掩盖故障。
3. **金额门槛的语义**：是“低于门槛不推送、留在提醒页”（本方案默认），还是“达到门槛才推送、低于门槛完全不显示”？两者对应的 `keep_in_page` 和页面行为不同。
4. **金额门槛的币种和默认值**：是否只支持主人常用币种？未知币种是否一律默认推送？我建议未知币种默认推送。
5. **到点重裁用当前规则还是入队时的规则？** 我建议当前规则；如果 Andy 更看重“用户看到的就是当时决定的”，可以改成冻结裁决，但要在 ADR 里写明。
6. **延后超过过期时间怎么处理？** 审批/提醒/Muse 是否改成立即发送，还是记录过期/留在页面？我建议审批立即发送，提醒和邮件留在页面，Muse 立即发送。
7. **`keep_in_page` 是否允许用于审批和 Muse？** 如果产品没有对应页面，就不允许。
8. **第 2 步是否包含金额门槛的设置界面？** 如果只加规则和存储、不加设置入口，金额规则在第一版不会生效；我建议至少加一个最小的设置项和只读展示。
9. **`notification_decisions` 的保留期。** 建议至少与 `decision_ledger` 一致；如果长期保留，需要加清理策略和导出。

---

## 六、读代码或来源证实的，与推测

### 读代码/来源证实

- 五类推送都在 `#collect` 汇总，最后统一 `store.enqueue`；`#deliver` 目前只做过期、类别开关、页面可见性判断（P3）。
- 出站表 `kind` 只有三种，邮件主动提醒和 Muse 中断都用 `reminder` + `source_key` 前缀（P4）。
- `proactive_pushes` 是邮件专用延后队列，按 `ready_at` 合并（P5）。
- `RuleJudge` 已经返回 `revision`，但 `floorHitIds` 和决策写入只保留 id（P6）。
- 结果类型只有 `raise_floor` 和 `defer_to_quiet_hours`；字段缺失会抛错（P7）。
- 规则表对 id/parameters/source 有长度和 JSON 校验；`readSettings` 目前只读静默和重要发件人（P8）。
- 邮件判断输出没有金额字段（P9）；固定提示在前，当前时间在最后（P10）。
- 现有 `mailItemFacts` 只看主题和摘要，不看正文（P11）。
- 现有用户设置派生规则例子为空，测试只强制内置规则有 hit/miss（P12）。
- `AttentionPolicyService` 里另有一份 UTC 偏移版静默判断，生产组装未见到实例化（P13，grep 范围）。
- I-73 的原话和教训（P15）。

### 推测/未核实

- **各推送类别是否有“提醒页”**：邮件 insight、提醒、审批、线程基本有，但 Muse 中断是否有持久页面，未核实。
- **`proactive_pushes` 能否安全重建**：我没有读所有外键/触发器；需要迁移契约测试确认。
- **`Intl` 的 ISO 4217 币种清单在当前 Node 运行时是否完整**：未核实；建议固定表 + `Intl` 交叉校验。
- **现有 UI 是否能展示新的 `notification_decisions` / 撤销按钮**：未读前端代码，未核实。
- **`not_before` 加列后，现有 `enqueue`/`listDue` 的所有调用方**：我只读了主要路径；需要全仓测试确认。
- **金额模型抽取的实际准确率**：没有真实语料评测，属于推测；需要补充中/日/英、JPY/USD、多个金额的语料和人工标注。
- **规则修改后到点重裁的用户体验**：是否会让用户困惑，需要产品确认；本方案用决策记录和撤销入口降低风险。

---

## 七、逐条回答必答问题

### 必答问题 1：这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**会话请求：不会。** 本方案不修改系统提示、工具定义、历史消息、遮盖规则或压缩逻辑；通知闸门和金额存储都发生在推送入队/发送侧，不碰会话请求。依据：`.claude/rules/prompt-prefix.md:27-29`、`:35-36`。

**唯一会变的模型请求是后台邮件判断调用。** 它会在 `MAIL_JUDGMENT` 的固定说明里增加输出字段 `amount`，并可能微调输出格式说明。这会让该后台调用的固定前缀变一次，但：

- 它不是任何会话的请求开头；
- 它的固定指令仍然在最前，邮件数据在中间，`MAIL_JUDGMENT_NOW`（`now/timeZone/today`）仍然在最后（`proactive-mail-check-service.ts:385-406`）；
- 金额是模型输出，不是输入；每次调用之间没有新的每轮变化值进入固定前缀。

所以：**会话仍然只在末尾追加，每轮会变的值仍然在最后一条用户消息里；后台调用仍然固定在前、会变的在后。** 依据：`.claude/rules/prompt-prefix.md:67`；`packages/prompt-catalog/src/mail.ts:62-76`。

如果以后把金额放进会话的系统提示、工具定义或历史消息，就会违反规则；本方案明确不做。

### 必答问题 2：这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？

**模型输入侧不会新增这种变化。** 金额不进入会话提示；后台邮件判断的输入仍然只由固定提示 + 本次邮件数据 + 最后的当前时间组成。当前时间每次不同，但它已经在最后，符合规则。遮盖规则不变；金额不参与遮盖，也不依赖后面的邮件。

**决策记录/界面侧需要主动保证确定性：**

- `rule_hits` 按 `id`、`revision`、`outcome` 排序后序列化，不依赖数据库返回顺序或 `Map/Set` 遍历顺序。
- 金额币种统一大写；金额阈值表达式里的币种/规则按固定顺序生成；`quietHoursExpression` 已经对 days 排序（`rule-book.ts:227-233`）。
- `notification_decisions` 里的 `decided_at`、`defer_until` 是 ISO 时间，属于“每次不同”的事实，不应参与任何模型提示；只用于记录和界面。
- `readSettings` 的规则查询没有 `ORDER BY`，这是一个现有隐患；方案要求读取后按 `rule_id` 排序，或在查询里加 `ORDER BY rule_id`，避免“同一组规则命中顺序不同”。

因此：**同一段邮件文字、同一组规则、同一时刻，模型输入字节不变；不同请求的字节差异只来自本来就该变化的当前时间（仍在最后）和推送决策记录（不进模型）。**

### 必答问题 3：改动有没有对应的自动检查，反向用例是否真的会失败？

建议新增/修改这些检查：

1. **规则注册检查**（扩展现有 `npm run check:rule-registry`）：
   - 金额规则必须有 hit/miss 例子；
   - `quiet_hours`、`amount_threshold` 生成规则也要有至少一个 hit 和一个 miss（补上当前 P12 的缺口）；
   - 反向用例：删掉 `amount_confidence == "sure"`，未知金额用例必须从“不命中”变成“命中”，测试失败；把 `<` 改成 `<=`，等于门槛的边界用例失败。
2. **通知闸门单元测试**：
   - 五类 kind、静默边界、DST、时区、多段静默；
   - `keep_in_page` 优先于 `defer`；未知金额默认推送；
   - 同一组 hits 不同输入顺序序列化结果相同。
   - 反向用例：让 `defer` 覆盖 `keep`，测试失败；让未知金额按 0 处理，未知金额用例失败。
3. **出站队列集成测试（真实 SQLite，不用假替身）**：
   - `#collect` 对 `defer` 写入 `not_before`；`listDue` 在 `not_before` 前不返回；到点后返回；
   - `#deliver` 重裁：规则从 `defer` 改为 `keep`、改为无规则、改为更晚，决策记录追加；
   - `keep_in_page` 不产生发送，但原记录仍在；
   - 延后超过 `expiresAt` 的类别策略。
   - 反向用例：去掉 `listDue` 的 `not_before` 条件，延后测试立即发送，失败；`#deliver` 复用入队时 hits 而不是重新计算，规则改动用例失败。
4. **迁移契约测试**：
   - 旧库升级后 `not_before` 为空、旧 `proactive_pushes` 仍可读；
   - `notification_decisions` 的 `outcome`/`kind`/`defer_until` CHECK 拒绝非法值；
   - `proactive_pushes.status='suppressed'` 可写入、可读回。
   - 反向用例：写入 `outcome='defer'` 但 `defer_until=NULL`，数据库必须拒绝；写入 `kind='proactive'`（少了 `_mail`）必须拒绝。
5. **I-73 跨模块契约测试**：
   - 用生成的 `amount_threshold`、`keep_in_page`、`NotificationKind`、`amount_minor/currency/confidence` 依次过：规则裁判 → `rule_book_rules`/`notification_decisions` 写入 → 读取 → 网关契约 → 界面读模型；
   - 反向用例：把 rule id 改成 65 个字符、把 outcome 改成未登记的字符串、把 currency 改成小写/4 位、把 revision 改成 0，必须分别在对应校验处失败。
6. **提示词测试**：
   - `proactivePrompt` 顺序不变，`MAIL_JUDGMENT_NOW` 仍在最后；
   - 解析器对缺失/格式错误/多金额的 `amount` 返回 `unknown`，不返回 0 或猜测值；
   - 会话 `npm run check:prompt-prefix` 仍然通过。
   - 反向用例：把 amount 说明移到邮件数据之后，测试失败（固定内容跑到变量后面）；把 `MAIL_JUDGMENT_NOW` 移到邮件数据前，测试失败；改会话系统提示，`check:prompt-prefix` 失败。
7. **静默对照测试**：保留 `rule-book-legacy-equivalence.unit.test.ts` 的三时区、跨 DST、29 分钟粒度对照；反向用例：把 `quietUntil` 的结束含/不含改错，对照失败。

### 必答问题 4：改动产生或修改的每个值，每一个使用它的地方都能接受吗？

下面逐个列出产生方、使用方和校验；这是按 I-73 的要求做的“两端核对”。

| 值 | 产生方 | 使用方 | 两端校验/必须做的修改 |
|---|---|---|---|
| `RuleOutcome = "keep_in_page"` | `rule-book.ts` 生成规则、`RuleJudge` 返回 | 通知闸门 resolver、`notification_decisions.outcome` CHECK、网关/UI 枚举、测试 | 类型 union、DB CHECK、界面枚举都要加；否则写入或被界面解析拒绝。 |
| `RuleOutcome = "defer_to_quiet_hours"`（现有） | `quietHoursRule` | 通知闸门、`quietEnd`、决策记录 | 现有已存在；gate 从 `mail_delivery` 改到 `notification` 后，所有 `RuleJudge.decide` 调用和测试都要同步。 |
| rule id `amount_threshold` | `RULE_IDS`、`amountThresholdRule` | `rule_book_rules.rule_id` CHECK（1–64）、`RuleId` 类型、`DECISION_RULE_CATALOG`、界面标签 | 长度必须 ≤64；`readSettings` 必须能找到并解析；`DECISION_RULE_CATALOG` 或读取端必须能处理，不能返回 `undefined` 导致界面空白。 |
| rule id `quiet_hours`（现有） | `RULE_IDS` | 同上，gate 改名后仍保留 id | id 不变；只改 gate 不迁移。 |
| 规则 `revision` | `writeRule` 递增（`sqlite-proactive-operations.ts:342`），内置规则代码固定 | `RuleHit.revision`、`floorHits`、`notification_decisions.rule_hits`、决策账本、界面 | revision 必须是 ≥1 的安全整数；`ruleHits` JSON 写入时要校验，旧记录没有 revision 时读取端要兼容。 |
| 规则 `source` | `writeRule`/内置规则 | `rule_book_rules.source` CHECK（1–256）、决策链 `document`（≤64） | 新规则的 `source` 必须 ≤256；如果展示到 `document` 字段，必须 ≤64，且规则 id 与 origin 要在 catalog 里。 |
| `parameters` | `writeSettings` 生成 | `rule_book_rules.parameters` CHECK（JSON object）、`readSettings` 解析 | 金额参数必须是对象 `{thresholds:[...]}`；`thresholds` 的 currency/minor 要逐项校验；旧读取端忽略未知字段。 |
| `NotificationKind` 五值 | 闸门映射 `#collect` 的 kind/sourceKey | `notification_decisions.kind` CHECK、界面、测试 | 这些值只用于通知决策表，不写入 `web_push_outbox.kind`；如果界面有枚举，要包含五值。 |
| `notification_decisions.outcome` 五值 | 闸门/到点重裁 | DB CHECK、界面、测试 | `defer` 时 `defer_until` 必须非空；其他情况必须为空。 |
| `not_before` | `#collect`/`#deliver` | `web_push_outbox` 新列、`listDue` 查询、迁移契约、测试 | 必须是规范 ISO 时间；旧行 `NULL` 视为立即；不能延后到 `expires_at` 之后还不处理。 |
| `source_key` | 现有 `#collect`（`reminder:`/`approval:`/`run:`/`proactive:`/`muse-channel:`） | `web_push_outbox`（1–256）、`notification_decisions`（1–256）、`push_source_key`（1–256） | 新表沿用 1–256；`proactive:<pushId>`、`muse-channel:<outageStartedAt>` 都要测试边界长度。 |
| `amount_minor` | 模型输出 → 解析器 → `contentRef` 加密 JSON | `ProactiveInsightContent`、通知闸门 facts、决策/UI | 必须是非负安全整数；未知为 0 且必须同时 `confidence="unknown"`；超过安全整数降级 unknown；旧内容缺字段按 unknown。 |
| `amount_currency` | 模型输出 → 解析器 | 同上 | 必须是大写三字母 ISO 4217 或 `""`；小写/四字母/未知币种降级 unknown；规则生成时按币种精确匹配。 |
| `amount_confidence` | 解析器（含 `bodyTruncated/bodyUnavailable` 降级） | 闸门 facts、规则表达式、决策/UI | 只能是 `sure`/`unsure`/`unknown`；未知不能当作 0 元；规则必须先判 `sure`。 |
| `amount` 模型输出 | `MAIL_JUDGMENT` 输出 | `parseJudgements` | 只接受 `{value:string,currency:string,confidence:"sure"|"unsure"}` 或 null；多金额/格式错误 → unknown；不能因为字段缺失让整批 judgement 失败。 |
| `defer_until` | 静默策略/闸门 | `not_before`、`notification_decisions`、界面 | 必须 > now、≤ expiresAt（或按类别策略处理）；必须规范 ISO；不能与 `not_before` 不一致。 |
| `reason_code` | 闸门 | `notification_decisions.reason_code` CHECK（1–64）、界面 | 新原因码必须 ≤64，例如 `NOTIFICATION_DEFERRED_QUIET_HOURS`、`NOTIFICATION_KEPT_AMOUNT_BELOW_THRESHOLD` 都够短；仍要测试长度。 |
| `proactive_pushes.status = "suppressed"` | 邮件批处理全被 keep 时 | `proactive_pushes` CHECK、`listReadyPushes`、`pushFromRow`、界面 | 现有 CHECK 只有 pending/enqueued；必须迁移扩为三值，并确认所有读取者能处理新值。 |
| `ProactiveSettings.amountThresholds` | `readSettings`/`writeSettings` | `proactive-overview`、网关快照、规则生成 | 新增字段后，`proactive.settings.set` 网关 schema、overview snapshot schema、SQLite 校验都要同步；否则前端保存会被契约拒绝，或后端读不到。 |
| `ProactiveInsightContent.amount` | 邮件检查写入加密内容 | `readProactiveOverview`、通知闸门、界面 | 旧内容没有该字段必须兼容；网关快照如果要暴露金额，要加 nullable 字段；不要把金额放进日志。 |
| `RuleHit` 的 `id/revision/outcome` 写进 `decision_ledger.inputs` | `sqlite-proactive-operations.ts` | `validateInputs`、决策链读取、界面 | `validateInputs` 目前只校验 `ruleIds`/`floorHits`；新增 `ruleHits`/`ruleHitsByMail` 要加校验；旧行没有新键要能读。`MAX_INPUT_IDS`/单条长度限制要遵守。 |
| `floorHits` 与新的 `ruleHits` 并存 | `floorHitIds`/新函数 | 现有决策链、界面、测试 | 为兼容旧读取端，继续写 `ruleIds`/`floorHits`；新字段追加，不替换。读取端优先新字段，缺失回退旧字段。 |
| 误/旧 `document` 长度 | `DECISION_RULE_CATALOG` | 决策链 `document: boundedString(64)` | `quiet_hours`/`amount_threshold` 的 document 字符串必须 ≤64；否则决策链快照解析失败。 |
| `amount_threshold` 的 `origin` | 规则生成 | 决策链 `origin` 枚举 `owner_setting|built_in` | 金额门槛是主人设置，必须是 `owner_setting`；如果写成别的值，契约拒绝。 |
| `mailCount` | 决策链读取 | `integer(0)` | 新规则也要有非负数；不要写 `undefined`。 |

结论：**只改规则生成器和闸门是不够的；`notification_decisions`、`web_push_outbox.not_before`、`proactive_pushes.status`、`ProactiveSettings`、网关契约、`DECISION_RULE_CATALOG`、决策账本 `inputs` 校验、界面枚举必须同时改，并为每个新值加跨模块契约测试。** 否则就会出现 I-73 那类“清单里产生了 id，但后端校验不接受”的问题。
