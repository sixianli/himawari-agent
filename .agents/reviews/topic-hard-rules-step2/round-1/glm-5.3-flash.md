# 硬规则第 2 步（通知闸门和金额字段）方案

## 一、方案依赖的前提

「证实」= 本次读代码/文档逐字看到；「推测」= 从证实事实推出的判断，未逐行核实。

**P1（证实）规则手册只存参数，表达式由程序生成，参数是唯一来源。**
`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:54`：“这两条的表达式不存库，由程序按存下来的参数生成，所以参数是唯一来源。以后加自由表达式的规则时，再给表加表达式列。”
→ 因此“延后到某时刻”也必须由参数算出（表达式只产真假，算不出时刻），时刻计算挂在参数上就仍然是“一份实现”。

**P2（证实）裁判对字段缺失的处理是抛错，不是当没命中。**
`packages/application/src/rules/rule-expression.ts:139-152`：`throw new RuleExpressionError("type", "字段 ${name} 缺失或不是整数")`（string、list 同理）。ADR 0209 决定 4（:56）：“每条规则写明缺失时怎么算，要等第 2 步引入金额字段时才需要，到那时再加。”
→ 金额“读不出来”不能靠“字段缺失”表达，必须在算事实那一步就定好哨兵值。

**P3（证实）读设置时按 ruleId 找规则、不按闸门过滤。**
`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:230-241`：`SELECT rule_id ... WHERE ... status='active'` 后 `rules.find(({ruleId}) => ruleId === QUIET_HOURS_RULE_ID)`。
→ 已有 id `quiet_hours`（`rule-book.ts:29`）的闸门不能改，否则读设置端就断了；新闸门的规则必须用新 id。这正是 I-73 那类“两端都要看”的约束（`docs/incidents-and-gates.md:112`：“双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』”）。

**P4（证实）五类推送全部经 `#collect` 组装后一次 `store.enqueue` 入队，`#deliver` 只看过期、类别开关、主人可见。**
`apps/agent-service/src/production-web-push.ts:315-389`（collect）、`:397-428`（deliver，三个判断）；`:287-313`（#run 先取 approvals、reminders、proactive、muse）。
→ 闸门放在 `#collect` 里、`enqueue` 之前，是唯一一个五类共用、且在每个数据源各自队列之上的点。

**P5（证实）`web_push_outbox` 没有延后列；重试的 `next_attempt_at` 在 `web_push_attempts`，按订阅分开。**
`packages/persistence-sqlite/src/migrations/0058_web_push.sql:22-48`。邮件侧另有 `proactive_pushes`（`0062_proactive_checks.sql:89-101`，`ready_at`、`pending`/`enqueued`），由 `proactive-mail-check-service.ts:1290-1300` 写、`production-web-push.ts:358-368,388` 消费。
→ 延后语义有两个现成落点，需选型（见方案 B）。

**P6（证实）静默时段现有两份实现：规则手册版（裁判 + `quietUntil`）在 `proactive-rules.ts:64-82,197-227`；`AttentionPolicyService.isQuietHours`（`attention-policy-service.ts:71-80`，固定 UTC 偏移、命中降 NOTIFY 为 DIGEST）在生产代码零实例化，只有测试在用（`apps/agent-service/test/fixtures/local-composition-root.ts:202`、`packages/testing/test/attention-policy.unit.test.ts:59`、`test/e2e/beef-restaurant.test.ts:403`、`test/integration/attention-delivery.test.ts:104`）。**

**P7（证实）邮件判断是每次独立的一次性后台请求：固定提示（`MAIL_JUDGMENT`，`packages/prompt-catalog/src/mail.ts:3-33`）在前，记忆段、邮件段居中，当前时间（`MAIL_JUDGMENT_NOW`，`mail.ts:62-77`）最后；解析在 `parseJudgements`（`proactive-mail-check-service.ts:461-499`），模型多给的未知字段被自然丢弃（`continue` 分支）。**
→ 给固定提示加金额说明不会改写任何“已经发过的对话开头”（该调用没有历史）。

**P8（证实）业界对“打断等级”的做法是按通知类别分等级并允许穿透免打扰**：Apple `UNNotificationInterruptionLevel` 的 `timeSensitive` 定义为 “breaks through system notification controls”（https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel.md）；Android 按通知渠道设 importance、用户保留最终否决权（https://developer.android.com/develop/ui/views/notifications/channels）。本项目已有 per-kind 开关（`0058_web_push.sql:10-12` 的 `notify_reminder/approval/run`）+ 实例级规则，与“渠道 + 用户控制”一致。

**P9（推测）主人派生规则目前不带例子**（`rule-book.ts:208,246` 两处 `examples: Object.freeze([])`），与“每条规则自带例子、加载时自动跑”（约束、ADR 0209 决定 2）有差距，本步加新规则时应补上；是否回头补旧两条另议。

## 二、方案本身

### A. 闸门位置与共用：`#collect` 里、`store.enqueue` 之前，一道闸门 `notification`

1. `RULE_GATES` 增加 `"notification"`（`field-catalog.ts:9`）。事实目录：
   - `push_kind`: `"reminder" | "approval" | "run" | "mail" | "muse_channel"`（string）；
   - `local_minutes`、`local_weekday`、`local_previous_weekday`：与 `mail_delivery` 相同，由 `zonedParts`（`proactive-rules.ts:136-159`）算，时区来自现有配置（`production-web-push.ts:169`）；
   - `amount_state`: `"known" | "uncertain" | "missing"`（string，仅 mail 类有值，其余类填 `"missing"`）；
   - `amount_minor`: 整数，未知时填 0；`amount_currency`: 文字，未知时填 `""`。
   - 类型不超出 `int | string | list<string>`，裁判的白名单、类型检查、`evaluate` 的非空校验（`rule-expression.ts:139-152`）全部照旧成立，不会因金额缺失抛错——缺失被表达成 `"missing"`，这是对 ADR 0209 “缺失时怎么算”的落实：**缺失是事实的值，不是事实的缺席**。
2. `RuleOutcome` 扩为 `"raise_floor" | "defer_to_quiet_hours" | "defer_notification" | "hold_notification"`。闸门对每个 item 调 `RuleJudge.decide("notification", facts, rules)`，按命中结果合成三类动作：命中 `hold_notification` → 不入队；命中 `defer_notification`（或沿用 `defer_to_quiet_hours`）→ 照常入队但带 `deliver_after`；否则照常。**发件人没有命中任何规则时照常推送**（fail-open，缺金额也是这条路）。
3. 规则来源：`quiet_hours` 的参数（`rule_book_rules.parameters.periods`）在 `ruleBookFor` 时派生两条规则行——一条维持现状（gate `mail_delivery`、id `quiet_hours`，保住 P3 的读设置端），一条新 id `notify_quiet_hours`（gate `notification`）。金额门槛是新的主人设置规则，id 如 `notify_money_threshold`，参数 `{ currency, minor }`，**生成的表达式恒为 `amount_state == "known" && amount_currency == "<币种>" && amount_minor >= <阈值>`**——“字段缺失怎么算”由生成器写死（unknown/missing 一律不命中 → 照常推送），不交给用户写。两条派生规则在生成时同时生成命中/不命中例子（补 P9）。
4. 判错兜底：闸门里裁判抛错（规则 bug、库 bug）时记日志并按“照常推送”处理，不让推送链路死掉；测试覆盖这个反向用例。

### B. 延后的通知存哪里：复用 `web_push_outbox`，加一列；不为延后建新表

- 迁移 0087：`ALTER TABLE web_push_outbox ADD COLUMN deliver_after TEXT`（NULL = 立即可发）；`store.listDue` 的 SQL 加 `AND (deliver_after IS NULL OR deliver_after <= ?)`。发送重试仍走 `web_push_attempts.next_attempt_at`，两个语义不混。
- 不复用 `proactive_pushes`：它绑 `insight_ids`、按同 `readyAt` 合并（P5），只对邮件有意义；其他四类没有 insight。邮件主动提醒**保留现有链路**（入 `proactive_pushes` 延后），但它的“是否静默”改从 `notification` 闸门取（同一裁判、同一参数），`quietEnd` 里那份 `JUDGE.decide("mail_delivery", ...)`（`proactive-rules.ts:71-79`）与闸门共用同一份派生参数，事实上合一。

### C. 延后到点后重新裁决；决策记录带规则 id 和版本

- 新表 `web_push_gate_decisions`（0087）：`(owner_id, agent_id, source_key, decided_at, hits, action, defer_until, superseded_at)`，`hits` 是 JSON 数组 `[{ruleId, revision, outcome}]`，`action IN ('push','defer','hold')`，每条 item 每次裁决一行，只追加（新裁决把旧行 `superseded_at` 补上，或干脆不更新、按最新行读，见取舍 3）。
- 延后到点时（`#deliver` 里 `deliver_after <= now` 的 item），**用当前规则重跑一次闸门**：仍 defer → 顺延 `deliver_after` 并追加一行裁决；改判 hold → `#record(..., "suppressed", "WEB_PUSH_RULE_HELD")`，item 不推送但页面照旧（提醒页数据在 `reminders`/`source_insights`，本来就不受 outbox 影响）；改判 push → 发。到点重判不用 token。
- 邮件路径的决策记录（`ProactiveCheckInputs`，`proactive-mail-check-service.ts:1342-1356`）增加可选字段 `ruleHits: Record<messageId, {id, revision, outcome}[]>`，**新增不改旧**：`floorHits`（`ports/decision-ledger.ts:77`）和校准包照旧读，老代码不感知新字段（I-73 的两端核对：产生端只加可选键，消费端 `Required<DecisionInputs>` 对新增可选字段兼容）。

### D. 金额字段的读出与存储

1. 提示词：`MAIL_JUDGMENT` 的 JSON 格式行（`mail.ts:31`）扩为每项可带 `"amountMinor"`（整数，最小货币单位）、`"amountCurrency"`（三位币种码）、`"amountConfidence"`（`"exact" | "uncertain"`），并写明：金额写不出来就别写这三个字段；规则只认 `exact`。位置在固定提示段内（P7），数据段与 `MAIL_JUDGMENT_NOW` 顺序不动。
2. 解析：`parseJudgements`（`proactive-mail-check-service.ts:461-499`）增加三个可选字段的宽容解析（缺失/类型不对 → 视为 unknown，不拒整条）；`Judgement` 增加对应字段。
3. 存储：`source_insights` 加三列 `amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0)`、`amount_currency TEXT CHECK (amount_currency IS NULL OR length(amount_currency) = 3)`、`amount_confidence TEXT CHECK (amount_confidence IS NULL OR amount_confidence IN ('exact','uncertain'))`（迁移 0087）。
4. 闸门事实：`mailItemFacts` 之外，邮件推送 item 的 facts 由 insight 的三列算出：三列有值且 `exact` → `known`；有值但 `uncertain` → `uncertain`；否则 `missing`、`amount_minor=0`、`amount_currency=""`。

### E. 类别 × 规则的适用矩阵（边界例子直接写进测试）

| 类别 | 静默时段 | 金额门槛 | hold | 依据/边界例子 |
|---|---|---|---|---|
| 到点提醒 reminder | 延后 | – | 可以（页面上还有） | 例子：主人自设 22:30 提醒 + 静默 23:00–07:00 → 延到 07:00；已过期（`REMINDER_WINDOW_MS`，`production-web-push.ts:19,304`）的延后项到点前 expired |
| 待审批 approval | **不延不 hold，必推** | – | 否 | Apple 的 timeSensitive 穿透免打扰（P8）；审批有 `expiresAt`，延后到过期等于弄丢审批（`#run:293-296`）。例子：静默时段内产生审批 → 仍入队、仍发 |
| 任务完成 run | 延后 | – | 不适用（无页面停留语义，hold 即过期） | 例子：凌晨完成的 run → 07:00 推 |
| 邮件主动提醒 mail | 延后（现有链路，换统一裁判） | 可以 | 可以（留在提醒页） | 例子：金额 15,000 JPY ≥ 阈值 → 00:30 检查出的账单 hold，页面可见、可“立即推送”；同 `readyAt` 合并逻辑不变 |
| Muse 通道中断 | 延后 | – | 否（中断类只该推不该瞒） | 例子：03:00 中断 → 07:00 推；若届时通道已恢复，`#content` 的 active 复查（`production-web-push.ts:439-441`）判 expired，不推 |

### F. 两份静默时段合成一份

- 生产实现收敛为：**参数存在 `rule_book_rules.quiet_hours`（唯一来源），布尔判断走裁判（`notification` 与 `mail_delivery` 两个闸门共用派生参数），结束时刻走 `quietUntil`（同一参数）**。ADR 0209 放弃清单里“第 2 步把两份静默时段的实现合成一份”就是指这个。
- 删除 `AttentionPolicyService.isQuietHours` 与 `AttentionPolicyConfig.quietHours`（`attention-policy-service.ts:20-24,71-80`）：生产代码没有它（P6），它的语义（UTC 固定偏移）与规则手册（真实 IANA 时区）不一致，还和规则手册在 `start == stop` 语义上相反（service 第 76 行 `startMinute === endMinute` 返回 true＝全静默；规则手册 `rule-book.ts:221` 生成 `"false"`＝永不静默）——留两份必然在边界上分叉。该服务其余能力（去重、限流）属第 3 步议题，本步只删静默时段；四个测试文件随之更新（`assertPolicy` 已校验 `quiet_hours`，删掉后配置直接非法，无需对照测试）。

### G. 迁移与契约（0087，一次迁移做完）

1. `web_push_outbox` 加 `deliver_after`。
2. 新表 `web_push_gate_decisions`（见 C）。
3. `source_insights` 加金额三列。
4. `schema-catalog.ts` 为新表加条目、为新列改描述（0086 的先例在 `schema-catalog.ts:799-809`）。
5. `data-export/import.ts` 的 `source_insights` 显式列清单（`import.ts:550`）加三列，且**旧快照（无该三列）仍可导入**——迁移契约测试里加这条反向用例（I-73 教训：清单 id/列要过“另一端”的校验）。
6. `rule_id` 的新值（`notify_quiet_hours`、`notify_money_threshold`）过 `rule_book_rules.rule_id` 的 `CHECK (length BETWEEN 1 AND 64)`（`0086_rule_book.sql:4`）和写路径校验（`writeRule`，`sqlite-proactive-operations.ts:328-359`），契约测试里用真库断言能写入能读回。

### H. 自动检查（对应约束“每条规则带例子、反向用例必须失败”）

并入现有 `npm run check:rule-registry`（ADR 0209 决定 7）：
- 两条新派生规则的例子（含 `amount_state` 三态、跨 `start > stop` 时段、跨星期边界）加载即跑；例子改错一个值必须报错。
- 新旧静默判断的对照测试扩展到闸门：同一组参数下，“`notify_quiet_hours` 命中” ⟺ “`quietEnd` 非 null”，三个时区、跨夏令时、每 29 分钟一个时刻；把派生表达式改掉一个词，对照测试失败。
- 集成测试（真实服务、无假替身）：五类 × 矩阵每格一条；反向用例——把闸门从 `#collect` 挪走/旁路、把 fail-open 改成 fail-closed（金额 missing 也拦）、把 approval 也延后，三者都必须让断言失败。
- 迁移契约测试：新列 CHECK 拒绝负金额、非法 action、超长币种码；`rule_book_history` 只追加触发器仍生效。
- 提示词顺序回归：断言 `MAIL_JUDGMENT` 仍在数据段之前、`MAIL_JUDGMENT_NOW` 仍在最后（现有测试覆盖方式未核实，若已有类似断言则扩一条金额字段用例）。

## 三、考虑过但不选的做法

1. **延后通知复用 `proactive_pushes`**：要给没有 insight 的四类伪造 insight 或放宽表结构，且 `pendingPush` 的按 `readyAt` 合并是邮件特有语义；不如给已经是唯一入队点的 outbox 加一列。
2. **在 `#deliver` 里才问裁判（不入队前）**：`#collect` 已经把五类聚到一处（P4），在 collect 判一次能在“入队”语义上就拦住 hold（不产生 outbox 行），避免“入队了再压住”这种两头状态；到点重判只在延后路径需要。
3. **把 defer 时刻也写进规则表达式/裁判返回值**：表达式只能产 bool（`rule-expression.ts:130-131` 强制），CEL 白名单里也没有时刻运算；由参数算时刻（A.3）既不越权又保住“参数唯一来源”（P1）。
4. **金额未知时用 -1 或让字段缺席**：前者会被 `amount_minor >= 0` 之外的规则误用，后者触发裁判抛错（P2）并把“缺失怎么算”推给每条规则自己写；哨兵 + 生成器写死缺失语义最省心。
5. **整删 `AttentionPolicyService`**：它的去重/限流可能服务第 3 步动作闸门；本步只摘静默时段，删整个子系统超出“不改行为之外的任何东西”。
6. **给 approval 也做静默延后**：审批有时限，延后到过期是净损失；与 Apple timeSensitive 的穿透语义一致（P8），不做。

## 四、风险和反例

- **延后撞过期**：reminder 延到 07:00 但窗口只到 04:30 → 到点前就 expired。期望行为（过期即不推）要有专门测试，不算 bug 但要写进 ADR。
- **规则改了但延后项已经过期**：hold 改判发生在过期检查之后（`#deliver:407-409` 先查 `expiresAt`），不会复活过期通知——顺序不能颠倒，反例测试：延后的审批式 reminder 在静默期内过期，绝不能在 07:00 被推出去。
- **裁判抛错把推送链路打死**：A.4 的 fail-open + 日志；反例：注入一条类型不合法的规则（经校验不应可能，但作为纵深防御测试）。
- **`start == stop` 语义分叉**（P6 已证实）：删掉旧实现后只剩规则手册语义（永不静默），行为表里要写明。
- **快照回导**：老导出文件没有金额列（见 G.5），漏改 `import.ts` 会在用户导入旧备份时炸——必须进迁移契约测试。
- **校准/决策记录消费端**：`ruleHits` 只加不改（C），否则 `@himawari-agent/calibration` 的 `Required<DecisionInputs>` 读取端会要求新字段。

## 五、需要人拍板的取舍

1. **到点提醒是否受静默时段管**：主人自设的提醒时刻 vs 主人自设的静默时段，两个都是主人意愿。本方案选“延后”（静默时段是更强的新近意愿），iOS 把闹钟类当 timeSensitive 穿透（P8）是另一条路。需要 Andy 定。
2. **金额 `uncertain` 是否也允许拦**：本方案只有 `exact` 能命中金额规则（fail-open，宁漏勿扰）；要不要让“不确定但超过阈值”也拦下，是产品口径。
3. **`web_push_gate_decisions` 的 supersede 用 UPDATE 补 `superseded_at` 还是纯追加、读最新行**：影响“能看懂、能撤销”的查询复杂度，纯追加更符合本仓库历史表习惯（0086 的触发器先例），建议纯追加。
4. **`AttentionPolicyService` 只删静默时段还是连测试（e2e、integration）一起重排**：涉及四个测试文件的去留。
5. **Muse 中断延后 vs 立即推**：运维告警被静默一晚是否可接受（本方案：可接受，理由见 E 表）。

## 六、证实与推测分开

- 证实：P1-P8 的全部引用；`#collect/#deliver` 无静默判断（production-web-push.ts 全文读过，无 "quiet"）；`parseJudgements` 无金额字段且丢弃未知字段；`rule_book_rules`/`0086` 结构与写路径；`schema-catalog`、`import.ts:550` 的显式列清单；`AttentionPolicyService` 的生产零实例化（grep 全仓 4 处全在测试）。
- 推测（未核实）：提醒页/网页端现在如何呈现“推送被延后/拦下”（有没有现成的原因展示与撤销入口，需要 UI 侧设计，属第 4 步界面）；邮件判断请求是否已有跨请求缓存统计可观察（prompt-prefix 检查只跑对话，`npm run check:prompt-prefix` 是否覆盖邮件判断调用未核实）；`mailItemFacts` 的调用点全集（本次只看到 `proactive-rules.ts:59` 一处，若还有其他调用点，加金额事实时需同查）。

## 七、必答问题逐条

1. **会不会改变模型已经见过的请求开头？** 对话请求完全不变：闸门、金额字段、静默合一是进程内逻辑，不加系统提示、不加工具、不动历史和遮盖。唯一变的是后台邮件判断的固定提示 `MAIL_JUDGMENT`（加金额字段说明和 JSON 格式）。该调用每次都是独立的一次性请求（固定提示 → 数据段 → 时间段最后，P7），没有“已经发过的对话开头”可被改写，属于规则的第五节“后台调用”允许的固定段内容更新；排序仍满足“固定的在前、会变的在后”，`MAIL_JUDGMENT_NOW` 仍是最后一条。代价是该后台调用的共享前缀字节变一次，之后第一批判断请求多算一次头——这是新请求的正常成本，不是改写已发内容。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会新增。闸门的所有事实（时刻、金额状态）都在服务端算，不进模型请求；进请求的只有固定提示（版本内固定）和按邮件数据构造的数据段，构造对象的键序固定（现有代码模式，`proactive-mail-check-service.ts` 的 JSON 组装）；时间仍只在 `MAIL_JUDGMENT_NOW`。决策记录里的 `hits` JSON 数组按规则书固定顺序产出、`ruleIds` 沿用现有 `[...].sort()`（`proactive-mail-check-service.ts:1343`），序列化确定。唯一要盯住的是新增数据段字段时沿用固定键序，写进测试。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 并入 `check:rule-registry`：例子加载即跑、对照测试（闸门命中 ⟺ `quietEnd` 非 null，扫时刻扫时区）、表达式改一词必须失败；迁移契约测试含 CHECK 反向和旧快照回导；集成测试含三类反向（闸门被旁路、fail-open 改 fail-closed、approval 被延后）——都是“改错就红”的写法。对话链路的 `npm run check:prompt-prefix` 本步不应受影响且应继续通过（它的用例清单见 `.claude/rules/prompt-prefix.md:74`）。
4. **每个新值的两端都核对了吗？** 逐个：`notify_quiet_hours`/`notify_money_threshold`（产生：`ruleBookFor`/`writeRule`；使用：闸门调用、读设置**按 id 找、不过滤闸门故旧 id 不许动**——P3、决策记录、`rule_id` CHECK、第 5 步导出）；新 outcome 值（产生：`RuleOutcome`；使用：`floorHitIds`、`quietEnd`、闸门分支；**库里不存 outcome，只有 parameters**，`0086_rule_book.sql:6`）；`deliver_after`（产生：闸门；使用：`listDue` SQL、prune 按 `expires_at` 的交互、过期测试）；金额三列（产生：`parseJudgements` → insight 写；使用：闸门 facts、`import.ts:550` 显式列清单、`schema-catalog` 描述、CHECK）；`ruleHits`（产生：决策组装；使用：校准包——只加可选字段保兼容）；新 suppressed 原因码（产生：闸门；使用：`last_code` CHECK 限 64 字符，放得下）。每处都已在正文给出行号；UI 呈现端未核实，列为待设计。
