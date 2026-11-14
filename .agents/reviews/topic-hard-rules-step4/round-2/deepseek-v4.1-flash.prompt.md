你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 075dd4a679e4c2f66b18c3814185988ac6bf1bda。
待审核的方案：
# 线程方案：五类推送的统一通知闸门和延后（硬规则第 4 步后半）

## 0. 前提和来源（我读源码核对过；带“未核实”的实施前先读）

1. 五类推送都经同一个出站表和同一个发送函数。`apps/agent-service/src/production-web-push.ts` 的 `#collect`（约 315–389 行）收集提醒、审批、已结束任务、邮件主动提醒（`proactive.listReady`）、Muse 中断；`#deliver`（约 397–428 行）对 `listDue` 取出的每条只判：过期、`kinds` 开关、内容是否仍有效、`presence.anyVisible`，然后发送。没有任何规则判断。
2. 提醒只收 6 小时内的：`production-web-push.ts:19` `const REMINDER_WINDOW_MS = 6 * 3_600_000;`
3. `web_push_outbox` 只有 reminder/approval/run 三种 kind，没有“延后到”列（`0058_web_push.sql:26`）；`web_push_attempts` 是每设备一行，有 `next_attempt_at`（同文件 :43），`listDue` 过滤 `a.next_attempt_at IS NULL OR a.next_attempt_at <= ?`（`sqlite-web-push-operations.ts:331-332`）。`listDue` 有 `SEND_BATCH` 上限。
4. 邮件已有自己的延后队列 `proactive_pushes`（`0062_proactive_checks.sql:93-95`），创建时按 `quietEnd` 算 `readyAt`（`proactive-mail-check-service.ts:~1598`）。
5. 规则闸门现在只有 `mail_item`、`mail_delivery`（`field-catalog.ts:9`），每个闸门允许的结果是固定表 `GATE_OUTCOMES`（`rule-book.ts:~435-443`），`RuleJudge.decide(gate, facts, rules)` 不花 token。
6. `rule_set` 工具的 `type` 枚举由 `RULE_TYPES` 生成（`production-owner-rules.ts:~170`），所以新增可对话创建的规则类型会改工具定义，违反 `.claude/rules/prompt-prefix.md` 第 6 条（工具按对话冻结）。
7. ADR 0212:65 明说第 2 步推迟了四件事：“已入队项绕过闸门、提醒 6 小时窗口让‘23:30 延到 07:00’根本发不出去、审批在静默里过期、决策记录每轮重复写”，要等“第一条真会作用于另外四类的规则”一起做。
8. 决策记录 `kind` 是数据库 CHECK 白名单，已有加一种的先例 `rule_review`（`0069_decision_ledger.sql:5`、`0091_decision_prereviews.sql`；消费点 contracts-v2、calibration、data-export schemas）。
9. 最终方案文档第 4 步（我读过全文）要求：五类推送共用一道闸门；审批、Muse 告警规则碰不到；每次命中记规则 id 和修订号；网页看得懂、撤销得了。
10. 业界：Apple Focus 与 Android 勿扰都允许“时间敏感/关键通知穿透”（https://support.apple.com/guide/iphone/allow-or-silence-notifications-for-a-focus-iph21d43af5b/ios 、https://support.google.com/android/answer/9069335）；Slack 勿扰期间消息仍保留，恢复后可看（https://slack.com/help/articles/214908388-Pause-your-Slack-notifications）。即：静默=延后，不是丢弃；关键类可穿透。
11. 最新迁移是 0092（main 075dd4a6）；0093 目前被 P5-3 PR A 占用放行（项目记忆），我的改表要排队，迁移号合并时取下一个空号。未核实：设置项（静默时段）的写入端和 `check:settings-scope` 对新增键的要求。

## 1. 方案

### 1.1 闸门位置：`#deliver`，发送前
`#collect` 只入队，不裁决。`#deliver` 在“内容仍有效”之后、“页面可见”之前，对每条调用 `WebPushGate`（application 层纯函数，内部调用真实 `RuleJudge.decide("push_delivery", facts, rules)`）。已入队的旧行、规则中途修改、重试后进入静默，都在发送点重新裁决。结构上消除“已入队项绕过闸门”。

### 1.2 不可触碰：写在代码里
`approval`、`muse-channel` 两类，无论规则命中什么，闸门在裁判之后丢弃结果、照常发送（与金额规则的“程序保证”同一风格）。未知前缀的 source_key 视为 `unknown`：用户规则不命中，照常发送。到点提醒（主人自己设的时刻）第一条规则不作用，将来要作用须规则显式写 `push_class`。

### 1.3 新闸门与字段
`RULE_GATES` 加 `push_delivery`；字段 `push_class`（`scheduled_reminder|approval|run_result|mail_reminder|muse_outage`，由 source_key 前缀映射，穷举 switch），加上与 `mail_delivery` 同一套的 `local_minutes/local_weekday/local_previous_weekday`。`GATE_OUTCOMES.push_delivery` 只允许 `defer_to_quiet_hours`（不新增结果名；“不推送”`suppress_push` 本步不开，等真有规则要用）。

### 1.4 第一条规则：设置页开关，不走 `rule_set`
设置页静默时段下加开关“静默时段也延后：邮件主动提醒、任务完成”（默认关，关时五类行为逐字节同今天）。打开后程序生成规则 `push_quiet_hours`：`push_class in ["mail_reminder","run_result"] && (静默时段表达式，复用 quietHours 同一生成器和 quietUntil)`。不扩 `RULE_TYPES`，所以 `rule_set` 工具定义不变，模型请求开头不变（对话里说“夜里别提醒我”留到专门一次、Andy 接受一次换新的改动）。

### 1.5 延后存在哪里：出站表加列（需要迁移）
`web_push_outbox` 加 `defer_until TEXT`、`defer_rule_refs TEXT`（JSON 数组，`id@修订号`，排序去重最多 16 条）。`listDue` 排除 `defer_until > now`，所以：
- 延后项不占 `SEND_BATCH` 名额，静默期不会每 10 秒重新裁决一遍；
- 延后是“每条通知”而不是“每设备”，期间新订阅的设备不会漏网（否则复用 `web_push_attempts.next_attempt_at` 会让新设备立即收到）；
- 规则写入/撤销/开关变化时，把该主人所有 `defer_until` 清空，下一轮重新裁决；到点则自然被取回再裁决（仍在静默就再延后，值不变不写）。

### 1.6 提醒窗口和寿命
延后时把 `expires_at` 提升到 `max(原值, defer_until + 1 小时)`，且 `defer_until` 距当前最多 24 小时（超过按原过期）。到点仍走 `#content`：源已取消/已完成就记 `expired`，不发旧内容。这是对“提醒只活 6 小时”的有意变更，写进 ADR 并配测试。本步的第一条规则只管邮件提醒和任务完成，所以实际只有这两类延寿。

### 1.7 页面可见
延后项到点后若主人正在看页面，沿用现有行为（记 `suppressed`，不发推送，来源页仍可见）；延后期间不进入可见判断。

### 1.8 决策记录：用现有决策记录，加一种 kind `web_push`
延后命中时写一行，`inputs.ruleIds` 写 `规则id@修订号`，outcome `deferred`。确定性 id（source_key + 延后目标时刻 + 规则引用的哈希）配 `ON CONFLICT DO NOTHING`，同一状态不重复写；规则变化后的新裁决才写新行。按 `rule_review` 先例改齐：ports、contracts-v2 三处、calibration、data-export schemas、sqlite 校验与迁移（重建 CHECK）、三语 i18n、决策链展示。迁移合并后与 P5-3、做梦记忆、P4-1 一起排队。

### 1.9 网页：看得懂、撤销得了
设置页开关和说明（“会延后…不会延后：你定时的提醒、审批、Muse 告警”）；决策链抽屉里显示 `web_push` 条目与规则说明（走 ADR 0213 已打通的路径）；撤销=关开关，规则置 `retired`，延后项立刻重新裁决。“延后到 T”的定义：T=命中的静默规则的 `quietUntil`，开始含、结束不含，跨午夜按前一天星期几。

## 2. 考虑过但不选
- 只在 `#collect` 做闸门：已入队项绕过，规则改了无法重裁。
- 复用 `web_push_attempts.next_attempt_at`：每设备而非每通知，新订阅设备会立即收到；延后项占批量名额；没地方放规则引用。
- 复用 `proactive_pushes`：邮件专用，无法表达审批、任务。
- 单独新表 `web_push_gate_decisions` 记决策：会造出第二个“决策记录”入口，违背“决策记录是四项护城河资产之一”，且网页展示要另做；代价是改 `decision_ledger` 的全链路（我认为值得，Andy 不考虑开发量）。
- 第一条规则做成 `rule_set` 新类型：改工具定义，全部老对话缓存重建。
- 默认静默时段直接管五类：会把主人自设 06:30 提醒推到 07:00、吞审批。

## 3. 风险和反例
- 夏令时/跨午夜：必须复用 `quietUntil`，不另写。
- 兜底失效：表达式硬写 `push_class == "approval"` 时仍须照发（反向用例）。
- 每 10 秒写库：静默期内 `updated_at`/写次数不变（测试断言）。
- 任务失败被延后到过时：24 小时上限 + `#content` 重验。
- 重试中进入静默：发送失败后重试到点若在静默，闸门再延后。

## 4. 需要 Andy 拍板
1. 第一条规则入口：设置页开关（我的建议，不改工具定义）vs 对话里一句话（要改工具定义、全部老对话换新一次）。
2. 提醒延寿是行为变化（延后项寿命从 6 小时变为静默结束，最多 24 小时）。
3. 决策记录放进现有表（要改表迁移）vs 新表。
4. 审批、Muse 夜里照发（我的建议）。

## 5. 必答问题
1. 改变模型已见过的请求开头？不会：不动系统提示、工具定义、历史、遮盖；不扩 `RULE_TYPES`；加一条断言 `rule_set` 的 `type.enum` 不含新值。
2. 同一段文字不同字节？不进模型请求；规则引用排序去重，决策 id 确定性。
3. 自动检查：`[HR-4]` 集成测试（真实 SQLite+迁移+RuleJudge+quietUntil，只替换传输）：关开关行为不变；开后 23:30 邮件提醒/任务完成延后到 07:00 且延寿；审批/Muse/到点提醒照发；已入队旧行被拦；新设备不漏网；规则撤销后重裁；静默期内不重复写；反向：去掉兜底/去掉延寿/只在 collect 做闸门/规则变化不清 `defer_until`，对应用例都必须失败。`check:rule-registry` 扩展正反例；迁移契约测试；`check:prompt-prefix` 照跑。
4. 新值逐个核对生产端和使用端（I-73）：`push_delivery`、`push_class`、`push_quiet_hours`（rule-version KIND_BY_ID、三语 i18n、MCP 读规则）、设置开关（网关契约、控制中心、settings-scope）、`defer_until/defer_rule_refs`（SQL CHECK、listDue、prune、数据导出）、kind `web_push`（六处消费点）、原因码长度 1–64。
